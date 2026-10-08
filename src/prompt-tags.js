import { el, save, settings } from './state.js';
import { scheduleAutoFilterEval } from './auto-filter.js';

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

/** Edits a draft. Only the native Save button commits it; Cancel discards it. */
export function createTagEditor(initialTags) {
    let tags = normalizeTags(initialTags);
    const root = el('div', 'pf-tag-editor');
    const label = el('label', null, { text: 'Prompt tags', for: 'pf-prompt-tag-input' });
    const chips = el('div', 'pf-tag-chips');
    const input = el('input', 'text_pole', {
        id: 'pf-prompt-tag-input', type: 'text', placeholder: 'Type a tag and press Enter',
        'aria-label': 'Add prompt tag', autocomplete: 'off',
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
    root.append(label, chips, input, el('small', null, { text: 'Press Enter for each tag. Tags are saved with Save; × removes a tag.' }));
    render();
    return { root, getTags: () => tags.slice() };
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
