import { el, save, settings, toastWarn } from './state.js';

const within = (path, parent) => path === parent || path.startsWith(parent + '/');
const parentOf = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

export function groupState(key) {
    const s = settings();
    s.filterGroups ??= {};
    s.filterGroups[key] ??= { folders: [], collapsed: {}, disabled: {} };
    const state = s.filterGroups[key];
    if (!Array.isArray(state.folders)) state.folders = [];
    state.collapsed ??= {};
    state.disabled ??= {};
    return state;
}

export function isFilterGroupDisabled(key, item) {
    const state = groupState(key);
    return Object.entries(state.disabled).some(([path, disabled]) => disabled && within(item.group || '', path));
}

/** Independent folder trees for saved filters and auto rules. Group muting preserves each
 * member's own enabled/locked state; execution order remains the saved rule order. */
export function buildFilterGroups(container, key, items, refresh, onChange = () => {}) {
    const state = groupState(key);
    const commit = () => { save(); refresh(); onChange(); };
    const button = (label, title, action) => {
        const b = el('button', 'menu_button', { type: 'button', text: label, title });
        b.addEventListener('click', action);
        return b;
    };
    const askName = (initial, action) => {
        container.querySelector?.('.pf-group-name-form')?.remove();
        const form = el('form', 'pf-group-name-form');
        const input = el('input', 'text_pole', { 'aria-label': 'Group name', placeholder: 'Group name' });
        input.value = initial;
        const submit = el('button', 'menu_button', { type: 'submit', text: 'Save group' });
        const cancel = button('Cancel', 'Cancel group name', () => form.remove());
        form.append(input, submit, cancel);
        form.addEventListener('submit', event => { event.preventDefault(); action(input.value.trim()); });
        container.append(form);
        input.focus?.();
    };
    const create = (parent = '') => askName('', name => {
        if (!name) return;
        if (name.includes('/')) { toastWarn('Use New subgroup to create nested groups.'); return; }
        const path = parent ? `${parent}/${name}` : name;
        if (state.folders.includes(path)) { toastWarn('A group with this name already exists.'); return; }
        state.folders.push(path);
        commit();
    });
    const addGroup = button(key === 'autoFilters' ? '＋ Group' : '＋ Preset group', 'New filter group', () => create());
    addGroup.classList.add('pf-group-add');
    container.append(addGroup);
    const unfiled = el('div', 'pf-filter-group-unfiled');
    const unfiledHeader = el('div', 'pf-folder-row', { text: '📥 Unfiled — drop filters here' });
    const unfiledRows = el('div');
    unfiled.append(unfiledHeader, unfiledRows);
    const targets = new Map([['', container]]);
    const remap = (oldPath, newPath) => {
        const map = path => within(path, oldPath) ? newPath + path.slice(oldPath.length) : path;
        state.folders = state.folders.map(map);
        for (const field of ['collapsed', 'disabled']) state[field] = Object.fromEntries(Object.entries(state[field]).map(([p, v]) => [map(p), v]));
        for (const item of items) if (item.group) item.group = map(item.group);
    };
    const moveGroup = (path, destination) => {
        if (within(destination, path)) { toastWarn('Cannot move a group inside itself.'); return; }
        const next = destination ? `${destination}/${path.split('/').pop()}` : path.split('/').pop();
        if (next !== path && state.folders.includes(next)) { toastWarn('A group with this name already exists.'); refresh(); return; }
        remap(path, next); commit();
    };
    const dropTarget = (node, destination) => {
        node.addEventListener('dragover', event => {
            if (!Array.from(event.dataTransfer.types).includes('application/pf-filter-group')) return;
            event.preventDefault(); event.stopPropagation();
        });
        node.addEventListener('drop', event => {
            const raw = event.dataTransfer.getData('application/pf-filter-group');
            if (!raw) return;
            event.preventDefault(); event.stopPropagation();
            let data; try { data = JSON.parse(raw); } catch { return; }
            if (data.key !== key) return;
            if (data.type === 'group' && state.folders.includes(data.path)) moveGroup(data.path, destination);
            else if (data.type === 'filter') {
                const item = items.find(item => item.id === data.id);
                if (item) { item.group = destination; commit(); }
            }
        });
    };
    dropTarget(unfiledHeader, '');
    for (const path of state.folders.slice().sort()) {
        const wrap = el('div', 'pf-filter-group');
        const header = el('div', 'pf-folder-row');
        header.setAttribute('draggable', 'true');
        header.addEventListener('dragstart', event => {
            event.stopPropagation();
            event.dataTransfer.setData('application/pf-filter-group', JSON.stringify({ key, type: 'group', path }));
            event.dataTransfer.effectAllowed = 'move';
        });
        dropTarget(header, path);
        const children = el('div', 'pf-filter-group-children');
        children.hidden = !!state.collapsed[path];
        header.append(button(children.hidden ? '▸' : '▾', `Expand/collapse ${path}`, () => { state.collapsed[path] = !state.collapsed[path]; commit(); }));
        header.append(el('span', 'pf-prompt-name', { text: `📁 ${path.split('/').pop()}` }));
        const muted = !!state.disabled[path];
        header.append(button(muted ? 'Off' : 'On', `Enable/disable group ${path} (preserves individual settings)`, () => { state.disabled[path] = !muted; commit(); }));
        header.append(button('＋', `New subgroup in ${path}`, () => create(path)));
        header.append(button('✎', `Rename group ${path}`, () => askName(path.split('/').pop(), name => {
            if (!name || name.includes('/')) return;
            const next = parentOf(path) ? `${parentOf(path)}/${name}` : name;
            if (next !== path && state.folders.includes(next)) { toastWarn('A group with this name already exists.'); return; }
            remap(path, next); commit();
        })));
        const move = el('select', 'pf-move-select text_pole', { 'aria-label': `Move group ${path}` });
        for (const destination of ['', ...state.folders.filter(p => !within(p, path))]) {
            const option = el('option', null, { value: destination, text: destination || 'Top level' });
            option.selected = destination === parentOf(path); move.append(option);
        }
        move.addEventListener('change', () => moveGroup(path, move.value));
        header.append(move);
        header.append(button('×', `Delete group ${path}, keep filters`, () => {
            const parent = parentOf(path);
            for (const item of items) if (within(item.group || '', path)) item.group = parent;
            state.folders = state.folders.filter(p => !within(p, path));
            for (const field of ['collapsed', 'disabled']) for (const p of Object.keys(state[field])) if (within(p, path)) delete state[field][p];
            commit();
        }));
        wrap.append(header, children);
        (targets.get(parentOf(path)) || container).append(wrap);
        targets.set(path, children);
    }
    container.append(unfiled);
    targets.set('', unfiledRows);
    return {
        add(row, item) {
            row.setAttribute('draggable', 'true');
            row.addEventListener('dragstart', event => {
                event.stopPropagation();
                event.dataTransfer.setData('application/pf-filter-group', JSON.stringify({ key, type: 'filter', id: item.id }));
                event.dataTransfer.effectAllowed = 'move';
            });
            const select = el('select', 'pf-move-select text_pole', { 'aria-label': `Move filter ${item.name || 'Filter'} to group` });
            for (const path of ['', ...state.folders.slice().sort()]) {
                const option = el('option', null, { value: path, text: path || 'Unfiled' });
                option.selected = path === (item.group || ''); select.append(option);
            }
            select.addEventListener('change', () => { item.group = select.value; commit(); });
            row.append(select);
            if (isFilterGroupDisabled(key, item)) {
                row.classList.add('pf-filter-group-muted');
                row.title = 'Group is off; individual settings are preserved';
            }
            (targets.get(item.group || '') || container).append(row);
        },
    };
}
