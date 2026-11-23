import { addPresetTransferControls, groupExportButton } from './preset-import-export.js';
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

export function isFilterGroupPathDisabled(key, path) {
    if (!path) return false;
    const state = groupState(key);
    return Object.entries(state.disabled).some(([p, disabled]) => disabled && within(path, p));
}

export function isFilterGroupDisabled(key, item) {
    return isFilterGroupPathDisabled(key, item?.group || '');
}

/** Returns folder paths parent-first while preserving each sibling level's manual order. */
export function orderedGroupPaths(folders) {
    const valid = Array.isArray(folders) ? folders.filter(p => typeof p === 'string' && p) : [];
    const set = new Set(valid);
    const result = [];
    const visited = new Set();
    const visit = path => {
        if (visited.has(path)) return;
        visited.add(path);
        result.push(path);
        for (const child of valid) {
            if (parentOf(child) === path) visit(child);
        }
    };
    for (const path of valid) {
        const parent = parentOf(path);
        if (!parent || !set.has(parent)) visit(path);
    }
    for (const path of valid) visit(path);
    return result;
}

/** Returns items in exact top-to-bottom visual order (for either the full list when `rootPath`
 *  is empty, or a single group subtree when `rootPath` is a group path). */
export function orderedGroupItems(key, items, rootPath = '') {
    const state = groupState(key);
    const folders = orderedGroupPaths(state.folders);
    const list = Array.isArray(items) ? items : [];
    const result = [];
    const visit = path => {
        for (const sub of folders) {
            if (parentOf(sub) === path) visit(sub);
        }
        for (const item of list) {
            if ((item.group || '') === path) result.push(item);
        }
    };
    if (rootPath) {
        visit(rootPath);
        return result;
    }
    const folderSet = new Set(folders);
    for (const path of folders) {
        const parent = parentOf(path);
        if (!parent || !folderSet.has(parent)) visit(path);
    }
    for (const item of list) {
        const g = item.group || '';
        if (!g || !folderSet.has(g)) result.push(item);
    }
    return result;
}

let activeDrag = null;

/** Independent folder trees for saved filters and auto rules. Group muting preserves each
 * member's own enabled/locked state. Supports drag-and-drop reordering of both filters and
 * groups (updating top-to-bottom execution order) as well as optional group Enable/Disable
 * run actions (`options.onRunGroup`) for preset collections. */
export function buildFilterGroups(container, key, items, refresh, onChange = () => {}, options = {}) {
    addPresetTransferControls(container, key, refresh);
    const state = groupState(key);
    const onRunGroup = typeof options?.onRunGroup === 'function' ? options.onRunGroup : null;
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
    const getLiveItems = () => {
        const live = settings()?.[key];
        return Array.isArray(live) ? live : items;
    };
    const remap = (oldPath, newPath) => {
        const map = path => within(path, oldPath) ? newPath + path.slice(oldPath.length) : path;
        state.folders = state.folders.map(map);
        for (const field of ['collapsed', 'disabled']) state[field] = Object.fromEntries(Object.entries(state[field]).map(([p, v]) => [map(p), v]));
        for (const item of getLiveItems()) if (item.group) item.group = map(item.group);
    };
    const moveGroup = (path, destination) => {
        if (within(destination, path)) { toastWarn('Cannot move a group inside itself.'); return; }
        const next = destination ? `${destination}/${path.split('/').pop()}` : path.split('/').pop();
        if (next !== path && state.folders.includes(next)) { toastWarn('A group with this name already exists.'); refresh(); return; }
        remap(path, next); commit();
    };
    const reorderGroup = (path, targetPath, zone) => {
        if (!path || !targetPath || path === targetPath) return;
        if (within(targetPath, path)) { toastWarn('Cannot move a group inside itself.'); return; }
        const targetParent = parentOf(targetPath);
        let movedPath = path;
        if (parentOf(path) !== targetParent) {
            const leaf = path.split('/').pop();
            const next = targetParent ? `${targetParent}/${leaf}` : leaf;
            if (next !== path && state.folders.includes(next)) { toastWarn('A group with this name already exists.'); refresh(); return; }
            remap(path, next);
            movedPath = next;
        }
        const moving = state.folders.filter(p => within(p, movedPath));
        const remaining = state.folders.filter(p => !within(p, movedPath));
        let insertAt = remaining.indexOf(targetPath);
        if (insertAt === -1) insertAt = remaining.length;
        else if (zone === 'after') {
            while (insertAt + 1 < remaining.length && within(remaining[insertAt + 1], targetPath)) insertAt++;
            insertAt += 1;
        }
        remaining.splice(insertAt, 0, ...moving);
        state.folders = remaining;
        commit();
    };
    const reorderFilter = (draggedId, targetId, zone) => {
        if (!draggedId || !targetId || draggedId === targetId) return;
        const list = getLiveItems();
        const fromIdx = list.findIndex(x => x.id === draggedId);
        const targetItem = list.find(x => x.id === targetId);
        if (fromIdx === -1 || !targetItem) return;
        const [dragged] = list.splice(fromIdx, 1);
        dragged.group = targetItem.group || '';
        let toIdx = list.findIndex(x => x.id === targetId);
        if (toIdx === -1) toIdx = list.length;
        else if (zone === 'after') toIdx += 1;
        list.splice(toIdx, 0, dragged);
        commit();
    };
    const clearDropIndicators = node => {
        node.classList?.toggle?.('pf-drop-before', false);
        node.classList?.toggle?.('pf-drop-after', false);
        node.classList?.toggle?.('pf-drop-into', false);
    };
    const setDropIndicator = (node, zone) => {
        node.classList?.toggle?.('pf-drop-before', zone === 'before');
        node.classList?.toggle?.('pf-drop-after', zone === 'after');
        node.classList?.toggle?.('pf-drop-into', zone === 'into');
    };
    const readDragPayload = event => {
        const raw = event?.dataTransfer?.getData?.('application/pf-filter-group');
        if (raw) {
            try { return JSON.parse(raw); } catch { return null; }
        }
        return activeDrag;
    };
    const hasFilterGroupDrag = event => {
        if (activeDrag && activeDrag.key === key) return true;
        const types = event?.dataTransfer?.types;
        return !!types && Array.from(types).includes('application/pf-filter-group');
    };
    const dropTarget = (node, destination) => {
        let dropZone = 'into';
        node.addEventListener('dragover', event => {
            if (!hasFilterGroupDrag(event)) return;
            event.preventDefault(); event.stopPropagation();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
            const rect = node.getBoundingClientRect?.();
            if (destination && activeDrag?.type === 'group' && rect && rect.height && typeof event.clientY === 'number') {
                const ratio = (event.clientY - rect.top) / rect.height;
                dropZone = ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'into';
            } else {
                dropZone = 'into';
            }
            setDropIndicator(node, dropZone);
        });
        node.addEventListener('dragleave', () => clearDropIndicators(node));
        node.addEventListener('drop', event => {
            clearDropIndicators(node);
            const data = readDragPayload(event);
            activeDrag = null;
            if (!data || data.key !== key) return;
            event.preventDefault(); event.stopPropagation();
            if (data.type === 'group' && state.folders.includes(data.path)) {
                const rect = node.getBoundingClientRect?.();
                if (destination && rect && rect.height && typeof event.clientY === 'number') {
                    const ratio = (event.clientY - rect.top) / rect.height;
                    dropZone = ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'into';
                }
                if (destination && (dropZone === 'before' || dropZone === 'after')) reorderGroup(data.path, destination, dropZone);
                else moveGroup(data.path, destination);
            } else if (data.type === 'filter') {
                const item = getLiveItems().find(x => x.id === data.id);
                if (item) { item.group = destination; commit(); }
            }
        });
    };
    dropTarget(unfiledHeader, '');
    const orderedFolders = orderedGroupPaths(state.folders);
    for (const path of orderedFolders) {
        const wrap = el('div', 'pf-filter-group');
        const header = el('div', 'pf-folder-row');
        header.setAttribute('draggable', 'true');
        header.addEventListener('dragstart', event => {
            event.stopPropagation();
            activeDrag = { key, type: 'group', path };
            event.dataTransfer?.setData?.('application/pf-filter-group', JSON.stringify(activeDrag));
            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        });
        header.addEventListener('dragend', () => { activeDrag = null; clearDropIndicators(header); });
        dropTarget(header, path);
        const children = el('div', 'pf-filter-group-children');
        children.hidden = !!state.collapsed[path];
        header.append(button(children.hidden ? '▸' : '▾', `Expand/collapse ${path}`, () => { state.collapsed[path] = !state.collapsed[path]; commit(); }));
        header.append(el('span', 'pf-prompt-name', { text: `📁 ${path.split('/').pop()}` }));
        const muted = !!state.disabled[path];
        header.append(button(muted ? 'Off' : 'On', `Enable/disable group ${path} (preserves individual settings)`, () => { state.disabled[path] = !muted; commit(); }));
        if (onRunGroup) {
            const pathBlocked = isFilterGroupPathDisabled(key, path);
            const enableGroupBtn = el('span', `pf-icon-btn fa-solid fa-toggle-on${pathBlocked ? ' pf-group-action-disabled' : ''}`, {
                title: pathBlocked ? 'Group or parent group is off — turn it On to run its presets' : `Enable all unlocked presets in group ${path} (top to bottom)`,
            });
            const disableGroupBtn = el('span', `pf-icon-btn fa-solid fa-toggle-off${pathBlocked ? ' pf-group-action-disabled' : ''}`, {
                title: pathBlocked ? 'Group or parent group is off — turn it On to run its presets' : `Disable all unlocked presets in group ${path} (top to bottom)`,
            });
            if (!pathBlocked) {
                enableGroupBtn.addEventListener('click', ev => { ev?.stopPropagation?.(); onRunGroup(path, true); });
                disableGroupBtn.addEventListener('click', ev => { ev?.stopPropagation?.(); onRunGroup(path, false); });
            }
            header.append(enableGroupBtn, disableGroupBtn);
        }
        header.append(button('＋', `New subgroup in ${path}`, () => create(path)));
        header.append(button('✎', `Rename group ${path}`, () => askName(path.split('/').pop(), name => {
            if (!name || name.includes('/')) return;
            const next = parentOf(path) ? `${parentOf(path)}/${name}` : name;
            if (next !== path && state.folders.includes(next)) { toastWarn('A group with this name already exists.'); return; }
            remap(path, next); commit();
        })));
        if (typeof groupExportButton === 'function') header.append(groupExportButton(key, path));
        const move = el('select', 'pf-move-select text_pole', { 'aria-label': `Move group ${path}` });
        for (const destination of ['', ...orderedFolders.filter(p => !within(p, path))]) {
            const option = el('option', null, { value: destination, text: destination || 'Top level' });
            option.selected = destination === parentOf(path); move.append(option);
        }
        move.addEventListener('change', () => moveGroup(path, move.value));
        header.append(move);
        header.append(button('×', `Delete group ${path}, keep filters`, () => {
            const parent = parentOf(path);
            for (const item of getLiveItems()) if (within(item.group || '', path)) item.group = parent;
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
            let rowDropZone = 'after';
            row.addEventListener('dragstart', event => {
                event.stopPropagation();
                activeDrag = { key, type: 'filter', id: item.id };
                event.dataTransfer?.setData?.('application/pf-filter-group', JSON.stringify(activeDrag));
                if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
            });
            row.addEventListener('dragover', event => {
                if (!hasFilterGroupDrag(event)) return;
                if (activeDrag && activeDrag.type !== 'filter') return;
                event.preventDefault(); event.stopPropagation();
                if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
                const rect = row.getBoundingClientRect?.();
                rowDropZone = (rect && rect.height && typeof event.clientY === 'number' && (event.clientY - rect.top) / rect.height < 0.5) ? 'before' : 'after';
                setDropIndicator(row, rowDropZone);
            });
            row.addEventListener('dragleave', () => clearDropIndicators(row));
            row.addEventListener('drop', event => {
                clearDropIndicators(row);
                const data = readDragPayload(event);
                activeDrag = null;
                if (!data || data.key !== key || data.type !== 'filter' || data.id === item.id) return;
                event.preventDefault(); event.stopPropagation();
                const rect = row.getBoundingClientRect?.();
                if (rect && rect.height && typeof event.clientY === 'number') {
                    rowDropZone = (event.clientY - rect.top) / rect.height < 0.5 ? 'before' : 'after';
                }
                reorderFilter(data.id, item.id, rowDropZone);
            });
            row.addEventListener('dragend', () => { activeDrag = null; clearDropIndicators(row); });
            const select = el('select', 'pf-move-select text_pole', { 'aria-label': `Move filter ${item.name || 'Filter'} to group` });
            for (const path of ['', ...orderedFolders]) {
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
