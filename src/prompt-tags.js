import { ROOT, el, escapeHtml, nameOf, save, settings } from './state.js';
import { scheduleAutoFilterEval } from './auto-filter.js';
import { closeOwnOverlays } from './native.js';
import { renderTree } from './render.js';

export function normalizeTags(tags) {
    const seen = new Set();
    return (Array.isArray(tags) ? tags : []).filter(tag => {
        if (typeof tag !== 'string' || !tag.trim()) return false;
        const key = tag.trim().toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).map(tag => tag.trim());
}

/** Returns all unique tags currently registered on any prompt or folder, sorted case-insensitively. */
export function collectRegisteredTags(s = typeof settings === 'function' ? settings() : null) {
    const raw = [];
    for (const bucket of [s?.promptTags, s?.folderTags]) {
        if (!bucket || typeof bucket !== 'object') continue;
        for (const list of Object.values(bucket)) {
            if (Array.isArray(list)) raw.push(...list);
        }
    }
    return normalizeTags(raw).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function nodeContains(container, target) {
    if (!container || !target) return false;
    if (container === target) return true;
    if (typeof container.contains === 'function') return container.contains(target);
    return Array.isArray(container.children) && container.children.some(child => nodeContains(child, target));
}

let activeTagPicker = null;

/** Closes the floating registered-tags picker popup if open. */
export function closeRegisteredTagsPopup() {
    if (!activeTagPicker) {
        if (typeof document !== 'undefined') document.getElementById?.('pf-tag-picker-popup')?.remove?.();
        return;
    }
    const { popup, anchor, onOutside, onKeydown, onResize } = activeTagPicker;
    activeTagPicker = null;
    if (typeof document !== 'undefined') {
        if (onOutside) {
            document.removeEventListener?.('mousedown', onOutside, true);
            document.removeEventListener?.('click', onOutside, false);
        }
        if (onKeydown) document.removeEventListener?.('keydown', onKeydown, true);
    }
    if (typeof window !== 'undefined' && onResize) {
        window.removeEventListener?.('resize', onResize);
    }
    anchor?.setAttribute?.('aria-expanded', 'false');
    popup?.remove?.();
}

function positionTagPickerPopup(popup, anchor) {
    if (typeof anchor?.getBoundingClientRect !== 'function' || typeof popup?.getBoundingClientRect !== 'function') return;
    if (typeof window === 'undefined' || !popup.style) return;
    const pad = 8;
    const gap = 6;
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    const rect = anchor.getBoundingClientRect();

    // Pick the vertical side with more space and cap maxHeight to that space
    // so long tag lists always scroll inside the popup instead of overflowing off-screen.
    const spaceBelow = Math.max(0, vh - pad - (rect.bottom + gap));
    const spaceAbove = Math.max(0, (rect.top - gap) - pad);
    const desiredMax = Math.min(320, Math.max(120, vh - pad * 2));
    const openBelow = spaceBelow >= desiredMax || spaceBelow >= spaceAbove;
    const availableHeight = openBelow ? spaceBelow : spaceAbove;
    const clampedMaxHeight = Math.max(
        120,
        Math.min(desiredMax, availableHeight >= 120 ? availableHeight : vh - pad * 2),
    );
    popup.style.maxHeight = `${Math.floor(clampedMaxHeight)}px`;

    popup.style.left = '0px';
    popup.style.top = '0px';
    const origin = popup.getBoundingClientRect();
    const popRect = popup.getBoundingClientRect();

    let left = rect.left;
    left = Math.max(pad, Math.min(left, vw - popRect.width - pad));

    let top;
    if (openBelow && rect.bottom + gap + popRect.height <= vh - pad) {
        top = rect.bottom + gap;
    } else if (!openBelow && rect.top - gap - popRect.height >= pad) {
        top = rect.top - gap - popRect.height;
    } else {
        top = openBelow
            ? Math.max(pad, vh - pad - popRect.height)
            : Math.max(pad, Math.min(rect.top - gap - popRect.height, vh - pad - popRect.height));
    }
    popup.style.left = `${Math.round(left - origin.left)}px`;
    popup.style.top = `${Math.round(top - origin.top)}px`;
}

function openRegisteredTagsPopup({ anchor, root, getTags, onSelect }) {
    if (typeof document === 'undefined' || !document.body) return null;
    if (activeTagPicker?.anchor === anchor) {
        closeRegisteredTagsPopup();
        return null;
    }
    closeRegisteredTagsPopup();

    const popup = el('div', 'pf-tag-picker-popup', {
        id: 'pf-tag-picker-popup',
        role: 'dialog',
        'aria-label': 'Registered tags',
    });
    const header = el('div', 'pf-tag-picker-header');
    const title = el('b', null, { text: 'Registered tags' });
    const closeBtn = el('button', 'pf-tag-picker-close', {
        type: 'button',
        text: '×',
        title: 'Close',
        'aria-label': 'Close registered tags',
    });
    closeBtn.addEventListener('click', event => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        closeRegisteredTagsPopup();
    });
    header.append(title, closeBtn);

    const list = el('div', 'pf-tag-picker-list');
    const registered = collectRegisteredTags();
    const optionButtons = [];
    const syncAppliedState = () => {
        const current = new Set(getTags().map(tag => tag.toLowerCase()));
        for (const { tag, btn } of optionButtons) {
            const added = current.has(tag.toLowerCase());
            btn.classList?.toggle?.('pf-tag-option-added', added);
            btn.setAttribute?.('aria-pressed', String(added));
        }
    };
    if (registered.length === 0) {
        list.append(el('div', 'pf-tag-picker-empty', { text: 'No registered tags yet.' }));
    } else {
        for (const tag of registered) {
            const btn = el('button', 'pf-tag-option', { type: 'button', text: tag });
            btn.addEventListener('click', event => {
                event?.preventDefault?.();
                event?.stopPropagation?.();
                onSelect(tag);
                syncAppliedState();
            });
            optionButtons.push({ tag, btn });
            list.append(btn);
        }
        syncAppliedState();
    }
    popup.append(header, list);

    const host = (typeof root?.closest === 'function' && root.closest('dialog[open]')) || document.body;
    host.appendChild(popup);
    positionTagPickerPopup(popup, anchor);

    const onOutside = event => {
        const target = event?.target;
        if (nodeContains(popup, target) || nodeContains(anchor, target)) return;
        closeRegisteredTagsPopup();
    };
    const onKeydown = event => {
        if (event?.key !== 'Escape') return;
        event.preventDefault?.();
        event.stopPropagation?.();
        closeRegisteredTagsPopup();
    };
    const onResize = () => positionTagPickerPopup(popup, anchor);
    document.addEventListener?.('mousedown', onOutside, true);
    document.addEventListener?.('click', onOutside, false);
    document.addEventListener?.('keydown', onKeydown, true);
    if (typeof window !== 'undefined') window.addEventListener?.('resize', onResize);
    anchor?.setAttribute?.('aria-expanded', 'true');
    activeTagPicker = { popup, anchor, onOutside, onKeydown, onResize, syncAppliedState };
    return popup;
}

/** Edits a draft. Only Save commits it; Cancel discards it. */
export function createTagEditor(initialTags, {
    labelText = 'Prompt tags',
    inputId = 'pf-prompt-tag-input',
    ariaLabel = 'Add prompt tag',
    hintText = 'Press Enter for each tag or pick from Registered tags. Tags are saved with Save; × removes a tag.',
} = {}) {
    let tags = normalizeTags(initialTags);
    const root = el('div', 'pf-tag-editor');
    const header = el('div', 'pf-tag-editor-header');
    const label = el('label', null, { text: labelText, for: inputId });
    const pickerBtn = el('button', 'menu_button pf-tag-picker-btn', {
        type: 'button',
        title: 'Choose from registered tags',
        'aria-label': 'Open registered tags',
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false',
    });
    pickerBtn.append(
        el('span', 'fa-solid fa-tags', { 'aria-hidden': 'true' }),
        el('span', null, { text: 'Registered tags' }),
    );
    header.append(label, pickerBtn);
    const chips = el('div', 'pf-tag-chips');
    const input = el('input', 'text_pole', {
        id: inputId, type: 'text', placeholder: 'Type a tag and press Enter',
        'aria-label': ariaLabel, autocomplete: 'off',
    });
    const render = () => {
        chips.replaceChildren();
        for (const tag of tags) {
            const chip = el('span', 'pf-tag-chip');
            const remove = el('button', null, { type: 'button', text: '×', 'aria-label': `Remove tag ${tag}` });
            remove.addEventListener('click', () => { tags = tags.filter(value => value !== tag); render(); });
            chip.append(el('span', null, { text: tag }), remove);
            chips.append(chip);
        }
        if (activeTagPicker?.anchor === pickerBtn) activeTagPicker.syncAppliedState?.();
    };
    const addTag = value => {
        tags = normalizeTags([...tags, value]);
        render();
    };
    pickerBtn.addEventListener('click', event => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        openRegisteredTagsPopup({
            anchor: pickerBtn,
            root,
            getTags: () => tags.slice(),
            onSelect: addTag,
        });
    });
    input.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        addTag(input.value);
        input.value = '';
    });
    root.append(header, chips, input, el('small', null, { text: hintText }));
    render();
    return {
        root,
        input,
        pickerBtn,
        getTags: () => tags.slice(),
        commitInput: () => {
            if (typeof input.value === 'string' && input.value.trim()) {
                addTag(input.value);
                input.value = '';
            }
            return tags.slice();
        },
    };
}

/** Closes the folder tag editor modal if open. */
export function closeFolderTagsModal() {
    closeRegisteredTagsPopup();
    document.getElementById('pf-folder-tags-overlay')?.remove();
}

/** Opens the tag editor modal for folder `path` (non-ROOT). */
export function openFolderTagsModal(path) {
    if (!path || path === ROOT) return;
    closeOwnOverlays();

    const s = settings();
    s.folderTags ??= {};
    const overlay = el('div', 'pf-view-overlay');
    overlay.id = 'pf-folder-tags-overlay';
    overlay.innerHTML = `
        <div class="pf-view-modal pf-bm-modal" role="dialog" aria-modal="true" aria-label="Folder tags">
            <div class="pf-view-header">
                <span class="fa-solid fa-tags"></span>
                <b>Folder tags: ${escapeHtml(nameOf(path))}</b>
                <span class="pf-icon-btn fa-solid fa-xmark" id="pf-ft-close" title="Close"></span>
            </div>
            <div class="pf-bm-scope">${escapeHtml(path)}</div>
            <div class="pf-bm-body" id="pf-ft-body"></div>
            <div class="pf-bm-row pf-bm-actions">
                <div class="menu_button" id="pf-ft-cancel"><i class="fa-solid fa-xmark"></i>&nbsp;Cancel</div>
                <div class="menu_button" id="pf-ft-save"><i class="fa-solid fa-floppy-disk"></i>&nbsp;Save</div>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    const editor = createTagEditor(s.folderTags[path], {
        labelText: 'Folder tags',
        inputId: 'pf-folder-tag-input',
        ariaLabel: 'Add folder tag',
    });
    document.getElementById('pf-ft-body').appendChild(editor.root);

    overlay.addEventListener('click', ev => { if (ev.target === overlay) closeFolderTagsModal(); });
    document.getElementById('pf-ft-close').addEventListener('click', closeFolderTagsModal);
    document.getElementById('pf-ft-cancel').addEventListener('click', closeFolderTagsModal);
    document.getElementById('pf-ft-save').addEventListener('click', () => {
        const nextTags = editor.commitInput();
        const current = settings();
        current.folderTags ??= {};
        if (nextTags.length > 0) current.folderTags[path] = nextTags;
        else delete current.folderTags[path];
        save();
        closeFolderTagsModal();
        renderTree();
        scheduleAutoFilterEval(0);
    });
    editor.input?.focus?.();
}

let installed = false;
export function watchPromptTagEditor() {
    if (installed) return;
    installed = true;
    let active = null;
    const saveSelector = '[id$="prompt_manager_popup_entry_form_save"]';
    const sync = () => {
        const button = document.querySelector(saveSelector);
        const form = document.querySelector('[id$="prompt_manager_popup_edit"]');
        const id = button?.dataset.pmPrompt;
        const visible = form && form.style.display !== 'none' && form.getClientRects().length > 0;
        if (!visible || !id || id === 'undefined') {
            closeRegisteredTagsPopup();
            active?.root.remove();
            active = null;
            return;
        }
        if (active?.id === id && active.root.isConnected) return;
        closeRegisteredTagsPopup();
        active?.root.remove();
        const editor = createTagEditor(settings().promptTags[id]);
        active = { ...editor, id };
        const footer = button.closest('[class$="prompt_manager_popup_entry_form_footer"]');
        if (footer) footer.before(editor.root);
        else form.append(editor.root);
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-pm-prompt', 'style', 'class'] });
    document.addEventListener('click', event => {
        const button = event.target.closest?.(saveSelector);
        if (!button || !active || button.dataset.pmPrompt !== active.id) return;
        settings().promptTags[active.id] = active.getTags();
        save();
        scheduleAutoFilterEval(0);
        closeRegisteredTagsPopup();
        active.root.remove();
        active = null;
    }, true);
    sync();
}
