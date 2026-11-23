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

/** Filters registered tags for autocomplete: excludes already-applied tags (case-insensitively)
 *  and ranks prefix matches ahead of substring matches while keeping alphabetical order within each group. */
export function filterRegisteredTagSuggestions(query, registered = collectRegisteredTags(), excludeTags = []) {
    const excluded = new Set(
        (Array.isArray(excludeTags) ? excludeTags : [])
            .filter(t => typeof t === 'string' && t.trim())
            .map(t => t.trim().toLowerCase()),
    );
    const available = (Array.isArray(registered) ? registered : [])
        .filter(tag => typeof tag === 'string' && tag.trim() && !excluded.has(tag.trim().toLowerCase()));
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return available;
    const prefix = [];
    const contains = [];
    for (const tag of available) {
        const lower = tag.toLowerCase();
        if (lower.startsWith(q)) prefix.push(tag);
        else if (lower.includes(q)) contains.push(tag);
    }
    return [...prefix, ...contains];
}

function nodeContains(container, target) {
    if (!container || !target) return false;
    if (container === target) return true;
    if (typeof container.contains === 'function') return container.contains(target);
    return Array.isArray(container.children) && container.children.some(child => nodeContains(child, target));
}

function positionFloatingBox(box, anchor, { maxHeight = 320, matchWidth = false } = {}) {
    if (typeof anchor?.getBoundingClientRect !== 'function' || typeof box?.getBoundingClientRect !== 'function') return;
    if (typeof window === 'undefined' || !box.style) return;
    const pad = 8;
    const gap = 6;
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    const rect = anchor.getBoundingClientRect();

    if (matchWidth) {
        const minW = Math.min(220, Math.max(120, vw - pad * 2));
        const width = Math.max(minW, Math.min(rect.width || minW, vw - pad * 2));
        box.style.width = `${Math.round(width)}px`;
    }

    // Pick the vertical side with more space and cap maxHeight to that space
    // so long tag lists always scroll inside the popup instead of overflowing off-screen.
    const spaceBelow = Math.max(0, vh - pad - (rect.bottom + gap));
    const spaceAbove = Math.max(0, (rect.top - gap) - pad);
    const desiredMax = Math.min(maxHeight, Math.max(120, vh - pad * 2));
    const openBelow = spaceBelow >= desiredMax || spaceBelow >= spaceAbove;
    const availableHeight = openBelow ? spaceBelow : spaceAbove;
    const clampedMaxHeight = Math.max(
        120,
        Math.min(desiredMax, availableHeight >= 120 ? availableHeight : vh - pad * 2),
    );
    box.style.maxHeight = `${Math.floor(clampedMaxHeight)}px`;

    box.style.left = '0px';
    box.style.top = '0px';
    const origin = box.getBoundingClientRect();
    const popRect = box.getBoundingClientRect();

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
    box.style.left = `${Math.round(left - origin.left)}px`;
    box.style.top = `${Math.round(top - origin.top)}px`;
}

let activeTagPicker = null;
let activeTagAutocomplete = null;

/** Closes the floating registered-tags autocomplete dropdown if open. */
export function closeTagAutocomplete() {
    if (!activeTagAutocomplete) {
        if (typeof document !== 'undefined') document.getElementById?.('pf-tag-autocomplete')?.remove?.();
        return;
    }
    const { dropdown, input, onOutside, onResize } = activeTagAutocomplete;
    activeTagAutocomplete = null;
    if (typeof document !== 'undefined' && onOutside) {
        document.removeEventListener?.('mousedown', onOutside, true);
    }
    if (typeof window !== 'undefined' && onResize) {
        window.removeEventListener?.('resize', onResize);
    }
    input?.setAttribute?.('aria-expanded', 'false');
    dropdown?.remove?.();
}

/** Attaches registered-tags autocomplete to a text input (prompt tags, folder tags, or filter tag inputs). */
export function attachTagAutocomplete(input, {
    isEnabled = () => true,
    getExcludeTags = () => [],
    onSelect,
    bindKeydown = true,
} = {}) {
    if (!input) return { handleKeydown: () => false, close: () => {}, refresh: () => {} };
    let suppressInput = false;

    const close = () => {
        if (activeTagAutocomplete?.input === input) closeTagAutocomplete();
    };

    const setActiveIndex = nextIdx => {
        if (!activeTagAutocomplete || activeTagAutocomplete.input !== input) return;
        const { items } = activeTagAutocomplete;
        if (!items.length) { activeTagAutocomplete.activeIndex = -1; return; }
        const idx = ((nextIdx % items.length) + items.length) % items.length;
        activeTagAutocomplete.activeIndex = idx;
        items.forEach(({ btn }, i) => {
            const active = i === idx;
            btn.classList?.toggle?.('pf-tag-ac-active', active);
            btn.setAttribute?.('aria-selected', String(active));
            if (active) btn.scrollIntoView?.({ block: 'nearest' });
        });
    };

    const selectTag = tag => {
        suppressInput = true;
        try {
            close();
            if (typeof onSelect === 'function') onSelect(tag);
            else input.value = tag;
        } finally {
            suppressInput = false;
        }
    };

    const openWith = ({ allowEmpty = false } = {}) => {
        if (typeof document === 'undefined' || !document.body) return;
        if (!isEnabled()) { close(); return; }
        const query = String(input.value ?? '');
        if (!allowEmpty && !query.trim()) { close(); return; }
        const suggestions = filterRegisteredTagSuggestions(query, collectRegisteredTags(), getExcludeTags());
        if (!suggestions.length) { close(); return; }
        // If the user already typed the exact and only matching tag, don't cover buttons below with a redundant 1-item menu.
        if (!allowEmpty && suggestions.length === 1 && suggestions[0].toLowerCase() === query.trim().toLowerCase()) {
            close();
            return;
        }

        closeRegisteredTagsPopup();
        closeTagAutocomplete();

        const dropdown = el('div', 'pf-tag-autocomplete', {
            id: 'pf-tag-autocomplete',
            role: 'listbox',
            'aria-label': 'Registered tag suggestions',
        });
        const items = [];
        for (let i = 0; i < suggestions.length; i++) {
            const tag = suggestions[i];
            const btn = el('button', 'pf-tag-ac-item', {
                type: 'button',
                role: 'option',
                'aria-selected': 'false',
                text: tag,
            });
            btn.addEventListener('mousedown', event => {
                // Keep focus on the input so blur doesn't tear down the dropdown before click fires.
                event?.preventDefault?.();
            });
            btn.addEventListener('click', event => {
                event?.preventDefault?.();
                event?.stopPropagation?.();
                selectTag(tag);
            });
            btn.addEventListener('mouseenter', () => {
                if (activeTagAutocomplete?.input === input) setActiveIndex(i);
            });
            items.push({ tag, btn });
            dropdown.append(btn);
        }

        const host = (typeof input.closest === 'function' && input.closest('dialog[open]')) || document.body;
        host.appendChild(dropdown);
        positionFloatingBox(dropdown, input, { maxHeight: 220, matchWidth: true });

        const onOutside = event => {
            const target = event?.target;
            if (nodeContains(dropdown, target) || nodeContains(input, target)) return;
            closeTagAutocomplete();
        };
        const onResize = () => positionFloatingBox(dropdown, input, { maxHeight: 220, matchWidth: true });
        document.addEventListener?.('mousedown', onOutside, true);
        if (typeof window !== 'undefined') window.addEventListener?.('resize', onResize);
        input.setAttribute?.('aria-expanded', 'true');
        activeTagAutocomplete = { dropdown, input, items, activeIndex: -1, onOutside, onResize };
    };

    const handleKeydown = event => {
        if (!event || event.isComposing || !isEnabled()) return false;
        const isOpen = activeTagAutocomplete?.input === input;
        if (event.key === 'ArrowDown') {
            event.preventDefault?.();
            event.stopPropagation?.();
            if (!isOpen) openWith({ allowEmpty: true });
            if (activeTagAutocomplete?.input === input) {
                setActiveIndex(activeTagAutocomplete.activeIndex < 0 ? 0 : activeTagAutocomplete.activeIndex + 1);
            }
            return true;
        }
        if (event.key === 'ArrowUp') {
            if (!isOpen) return false;
            event.preventDefault?.();
            event.stopPropagation?.();
            setActiveIndex(activeTagAutocomplete.activeIndex <= 0
                ? activeTagAutocomplete.items.length - 1
                : activeTagAutocomplete.activeIndex - 1);
            return true;
        }
        if (event.key === 'Tab' && isOpen && activeTagAutocomplete.items.length > 0) {
            event.preventDefault?.();
            event.stopPropagation?.();
            const idx = activeTagAutocomplete.activeIndex >= 0 ? activeTagAutocomplete.activeIndex : 0;
            selectTag(activeTagAutocomplete.items[idx].tag);
            return true;
        }
        if (event.key === 'Enter' && isOpen && activeTagAutocomplete.activeIndex >= 0) {
            event.preventDefault?.();
            event.stopPropagation?.();
            selectTag(activeTagAutocomplete.items[activeTagAutocomplete.activeIndex].tag);
            return true;
        }
        if (event.key === 'Escape' && isOpen) {
            event.preventDefault?.();
            event.stopPropagation?.();
            close();
            return true;
        }
        return false;
    };

    input.setAttribute?.('autocomplete', 'off');
    input.setAttribute?.('aria-autocomplete', 'list');
    input.setAttribute?.('aria-expanded', 'false');
    input.addEventListener('input', () => {
        if (suppressInput) return;
        openWith({ allowEmpty: false });
    });
    input.addEventListener('blur', () => close());
    if (bindKeydown) input.addEventListener('keydown', handleKeydown);

    return { handleKeydown, close, refresh: () => openWith({ allowEmpty: false }) };
}

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

export function openRegisteredTagsPopup({ anchor, root, getTags, onSelect, closeOnSelect = false }) {
    if (typeof document === 'undefined' || !document.body) return null;
    if (activeTagPicker?.anchor === anchor) {
        closeRegisteredTagsPopup();
        return null;
    }
    closeTagAutocomplete();
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
        const current = new Set((getTags?.() || []).map(tag => tag.toLowerCase()));
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
                if (closeOnSelect) closeRegisteredTagsPopup();
                else syncAppliedState();
            });
            optionButtons.push({ tag, btn });
            list.append(btn);
        }
        syncAppliedState();
    }
    popup.append(header, list);

    const host = (typeof root?.closest === 'function' && root.closest('dialog[open]')) || document.body;
    host.appendChild(popup);
    positionFloatingBox(popup, anchor, { maxHeight: 320, matchWidth: false });

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
    const onResize = () => positionFloatingBox(popup, anchor, { maxHeight: 320, matchWidth: false });
    document.addEventListener?.('mousedown', onOutside, true);
    document.addEventListener?.('click', onOutside, false);
    document.addEventListener?.('keydown', onKeydown, true);
    if (typeof window !== 'undefined') window.addEventListener?.('resize', onResize);
    anchor?.setAttribute?.('aria-expanded', 'true');
    activeTagPicker = { popup, anchor, onOutside, onKeydown, onResize, syncAppliedState };
    return popup;
}

/** Wires a Registered tags button so clicking it toggles the floating registered-tags popup. */
export function bindRegisteredTagsButton(btn, { root, getTags, onSelect, closeOnSelect = false } = {}) {
    if (!btn) return null;
    btn.addEventListener('click', event => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        openRegisteredTagsPopup({ anchor: btn, root: root || btn, getTags, onSelect, closeOnSelect });
    });
    return btn;
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
    bindRegisteredTagsButton(pickerBtn, {
        root,
        getTags: () => tags.slice(),
        onSelect: addTag,
        closeOnSelect: false,
    });
    const autocomplete = attachTagAutocomplete(input, {
        getExcludeTags: () => tags,
        onSelect: tag => {
            addTag(tag);
            input.value = '';
        },
        bindKeydown: false,
    });
    input.addEventListener('keydown', event => {
        if (autocomplete.handleKeydown(event)) return;
        if (event.key !== 'Enter' || event.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        addTag(input.value);
        input.value = '';
        autocomplete.close();
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
            autocomplete.close();
            return tags.slice();
        },
    };
}

/** Closes the folder tag editor modal if open. */
export function closeFolderTagsModal() {
    closeRegisteredTagsPopup();
    closeTagAutocomplete();
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
            if (active) {
                closeRegisteredTagsPopup();
                closeTagAutocomplete();
                active.root.remove();
                active = null;
            }
            return;
        }
        if (active?.id === id && active.root.isConnected) return;
        if (active) {
            closeRegisteredTagsPopup();
            closeTagAutocomplete();
            active.root.remove();
        }
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
        closeTagAutocomplete();
        active.root.remove();
        active = null;
    }, true);
    sync();
}
