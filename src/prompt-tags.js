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

/** Edits a draft. Only Save commits it; Cancel discards it. */
export function createTagEditor(initialTags, {
    labelText = 'Prompt tags',
    inputId = 'pf-prompt-tag-input',
    ariaLabel = 'Add prompt tag',
    hintText = 'Press Enter for each tag. Tags are saved with Save; × removes a tag.',
} = {}) {
    let tags = normalizeTags(initialTags);
    const root = el('div', 'pf-tag-editor');
    const label = el('label', null, { text: labelText, for: inputId });
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
    };
    input.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        tags = normalizeTags([...tags, input.value]);
        input.value = '';
        render();
    });
    root.append(label, chips, input, el('small', null, { text: hintText }));
    render();
    return {
        root,
        input,
        getTags: () => tags.slice(),
        commitInput: () => {
            if (typeof input.value === 'string' && input.value.trim()) {
                tags = normalizeTags([...tags, input.value]);
                input.value = '';
                render();
            }
            return tags.slice();
        },
    };
}

/** Closes the folder tag editor modal if open. */
export function closeFolderTagsModal() {
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
            active?.root.remove();
            active = null;
            return;
        }
        if (active?.id === id && active.root.isConnected) return;
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
        active.root.remove();
        active = null;
    }, true);
    sync();
}
