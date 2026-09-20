import { assignPrompt, moveFolder } from './folders.js';
import { isSelected, renderTree, selectionEntries, selectionSize } from './render.js';
import { ROOT, isDescendantOrSelf, moveEntryInOrder, save, settings, toastWarn } from './state.js';

// ---------- Drag & drop (reorder + refile, prompts and folders both) ----------
//
// A drag always carries a LIST of items, even for a single row: if the row being picked up is
// part of the current multi-selection (see render.js's Ctrl/Cmd+click), the whole selection comes
// along, landing together and keeping their relative order — otherwise it's just that one row.

/** Sorts `items` ({type,key}) into the same top-to-bottom order they currently appear in the
 *  rendered tree — NOT the order they were Ctrl/Cmd-clicked in. selectionEntries() reflects click
 *  order (it's a plain Set, insertion-ordered), which very easily doesn't match what's on screen
 *  (e.g. clicking the lower row before the upper one) — that mismatch is what made a multi-item
 *  drop land with items swapped/inverted relative to their visual order. Looks each item's row up
 *  via its data-identifier/data-folder-path attribute (see render.js) and compares DOM position,
 *  so it's correct across folders and nesting depth, not just among siblings. Items whose row
 *  can't be found (tree not rendered) keep their relative position from the input order. */
function sortByTreeOrder(items) {
    const container = document.getElementById('pf-tree');
    if (!container) return items;
    const rows = [...container.querySelectorAll('[data-identifier], [data-folder-path]')];
    const findEl = item => rows.find(r => item.type === 'folder' ? r.dataset.folderPath === item.key : r.dataset.identifier === item.key);
    return items
        .map((item, index) => ({ item, index, el: findEl(item) }))
        .sort((a, b) => {
            if (!a.el || !b.el) return a.index - b.index;
            const rel = a.el.compareDocumentPosition(b.el);
            if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
            if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;
            return a.index - b.index;
        })
        .map(w => w.item);
}

/** Returns the list of `{type, key}` items a drag starting on `self` should carry: the full
 *  current multi-selection if `self` is part of it and more than one item is selected, otherwise
 *  just `[self]`. */
function dragPayloadFor(self) {
    if (selectionSize() > 1 && isSelected(self)) return sortByTreeOrder(selectionEntries());
    return [self];
}

/** Drops items that are already implied by another item in the same drag: a folder nested inside
 *  another selected folder (moving the ancestor already carries it), or a prompt currently filed
 *  inside a selected folder (same reason). Keeps the rest in their original relative order. */
function pruneImpliedByAncestors(items) {
    const s = settings();
    const folderKeys = new Set(items.filter(d => d.type === 'folder').map(d => d.key));
    if (folderKeys.size === 0) return items;
    return items.filter(d => {
        if (d.type === 'folder') {
            return ![...folderKeys].some(fk => fk !== d.key && isDescendantOrSelf(d.key, fk));
        }
        const path = s.assignments[d.key] || ROOT;
        return ![...folderKeys].some(fk => isDescendantOrSelf(path, fk));
    });
}

/** Applies a completed drag-and-drop for every item in `draggedList` (see dragPayloadFor above),
 *  against `target` = `{type, key, parentPath, zone}` for the row it was dropped on, where `zone`
 *  is 'into' (drop onto a folder to file into it), 'before', or 'after' (drop to reorder as a
 *  sibling). Delegates each item's actual refiling to assignPrompt()/moveFolder(), then updates
 *  the manual sibling order via moveEntryInOrder(). Items land as consecutive siblings in their
 *  original relative order, chained one after another starting right at the drop point. Refuses
 *  moves that would nest a folder inside itself or one of its own descendants. */
function handleDrop(draggedList, target) {
    const items = pruneImpliedByAncestors(draggedList).filter(d => !(d.type === target.type && d.key === target.key));
    if (items.length === 0) return;

    let anchor = target.zone === 'into' ? null : { type: target.type, key: target.key };
    let zone = target.zone;
    const parent = target.zone === 'into' ? target.key : target.parentPath;

    for (const dragged of items) {
        let key = dragged.key;
        if (dragged.type === 'prompt') {
            assignPrompt(key, parent || null);
        } else {
            if (key === ROOT) continue;
            if (isDescendantOrSelf(parent, key)) { toastWarn('Cannot move a folder into itself or its own subfolder.'); continue; }
            const newPath = moveFolder(key, parent);
            if (!newPath) continue;
            key = newPath;
        }
        const entry = { type: dragged.type, key };
        if (zone === 'before') moveEntryInOrder(entry, parent, anchor, null);
        else moveEntryInOrder(entry, parent, null, anchor);
        anchor = entry;
        zone = 'after'; // every item after the first lands right after the one just placed
    }
    // Deliberately NOT clearing the selection here — if the drop landed in the wrong place (easy
    // to fat-finger), the user should be able to just drag the same still-selected items again
    // instead of having to re-select them all from scratch. A plain click (see render.js's
    // attachSelectionToggle) remains the way to intentionally clear it.
    save();
    renderTree();
}

/** Makes `rowEl` (representing tree item `self` = `{type, key}`, living under `parentPath`) both
 *  a drag source and a drop target: sets it draggable, stores the drag payload (self, or the whole
 *  multi-selection if self is part of one — see dragPayloadFor) on dragstart, and on dragover
 *  computes which drop zone the pointer is in (the middle band counts as "into" only for folder
 *  rows, so a prompt can never be dropped "into" another prompt) and reflects it with a CSS class
 *  for visual feedback. On drop, hands off to handleDrop(). */
export function attachDndHandlers(rowEl, self, parentPath) {
    rowEl.setAttribute('draggable', 'true');
    rowEl.addEventListener('dragstart', ev => {
        ev.dataTransfer.setData('application/pf-items', JSON.stringify(dragPayloadFor(self)));
        ev.dataTransfer.effectAllowed = 'move';
        ev.stopPropagation();
    });
    rowEl.addEventListener('dragover', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        const rect = rowEl.getBoundingClientRect();
        const ratio = (ev.clientY - rect.top) / rect.height;
        let zone;
        if (self.type === 'folder' && ratio > 0.25 && ratio < 0.75) zone = 'into';
        else zone = ratio < 0.5 ? 'before' : 'after';
        rowEl.classList.remove('pf-drop-before', 'pf-drop-after', 'pf-drop-into');
        rowEl.classList.add('pf-drop-' + zone);
        rowEl.dataset.dropZone = zone;
    });
    rowEl.addEventListener('dragleave', () => {
        rowEl.classList.remove('pf-drop-before', 'pf-drop-after', 'pf-drop-into');
    });
    rowEl.addEventListener('drop', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        const zone = rowEl.dataset.dropZone || 'after';
        rowEl.classList.remove('pf-drop-before', 'pf-drop-after', 'pf-drop-into');
        let dragged;
        try { dragged = JSON.parse(ev.dataTransfer.getData('application/pf-items')); } catch { return; }
        if (!Array.isArray(dragged) || dragged.length === 0) return;
        handleDrop(dragged, { type: self.type, key: self.key, parentPath, zone });
    });
}

/** Makes the ROOT ("Unfiled") row a drop target only (not a drag source, since ROOT can't be
 *  moved) — any drop on it always means "file this item directly into ROOT", so it skips the
 *  before/after zone math attachDndHandlers() does and always drops with zone 'into'. */
export function attachRootDropTarget(rowEl) {
    rowEl.addEventListener('dragover', ev => { ev.preventDefault(); rowEl.classList.add('pf-drop-into'); });
    rowEl.addEventListener('dragleave', () => rowEl.classList.remove('pf-drop-into'));
    rowEl.addEventListener('drop', ev => {
        ev.preventDefault();
        rowEl.classList.remove('pf-drop-into');
        let dragged;
        try { dragged = JSON.parse(ev.dataTransfer.getData('application/pf-items')); } catch { return; }
        if (!Array.isArray(dragged) || dragged.length === 0) return;
        handleDrop(dragged, { type: 'folder', key: ROOT, zone: 'into' });
    });
}
