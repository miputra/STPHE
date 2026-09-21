import { promptOrNull, renderTree } from './render.js';
import { ROOT, isDescendantOrSelf, joinPath, moveEntryInOrder, nameOf, parentOf, rewritePathEverywhere, save, settings, toastWarn } from './state.js';

// ---------- Folder mutations ----------
//
// Create/rename/move/delete folders, (re)assign a prompt to a folder, and toggle a folder's
// collapsed state. Every mutation here reads/writes settings() directly and calls save() itself
// — callers are still responsible for calling renderTree() afterwards to reflect the change,
// except where noted below.

/** Creates folder `rawName` under `parentPath` (a no-op, returning the existing path, if it
 *  already exists) and persists it. Returns the new folder's full path, or `null` if `rawName`
 *  was blank. Does not call renderTree() — callers do that themselves. */
export function createFolder(parentPath, rawName) {
    const name = (rawName || '').trim();
    if (!name) return null;
    const path = joinPath(parentPath, name);
    const s = settings();
    if (!s.folders.includes(path)) s.folders.push(path);
    save();
    return path;
}

/** Renames `oldPath` to `rawNewName` (same parent), rewriting every settings reference to it and
 *  its descendants via rewritePathEverywhere(). No-ops on ROOT, a blank name, or a name that's
 *  unchanged; warns (via toastWarn) and does nothing if a sibling folder already has that name. */
export function renameFolder(oldPath, rawNewName) {
    const newName = (rawNewName || '').trim();
    if (!newName || oldPath === ROOT) return;
    const parent = parentOf(oldPath);
    const newPath = joinPath(parent, newName);
    if (newPath === oldPath) return;
    const s = settings();
    if (s.folders.includes(newPath)) { toastWarn('A folder with that name already exists here.'); return; }
    rewritePathEverywhere(oldPath, newPath);
    save();
}

/** Moves folder `path` to become a child of `newParentPath`, keeping its own name, and rewrites
 *  every settings reference the same way renameFolder() does. Refuses (with a toastWarn) to move
 *  a folder into itself/its own descendant, or somewhere a same-named folder already exists.
 *  Returns the folder's new path (or its unchanged path if it was already there), or `null` if
 *  the move was refused or `path` was ROOT. */
export function moveFolder(path, newParentPath) {
    if (path === ROOT) return null;
    if (newParentPath === parentOf(path)) return path;
    if (isDescendantOrSelf(newParentPath, path)) { toastWarn('Cannot move a folder into itself or its own subfolder.'); return null; }
    const newPath = joinPath(newParentPath, nameOf(path));
    const s = settings();
    if (newPath !== path && s.folders.includes(newPath)) { toastWarn('A folder with that name already exists there.'); return null; }
    rewritePathEverywhere(path, newPath);
    save();
    return newPath;
}

/** Deletes folder `path` and every subfolder beneath it. Prompts that were assigned anywhere
 *  under `path` are reassigned to its parent (so they're never silently lost), and every other
 *  trace of the deleted path(s) — collapsed state, master-off flag/snapshot, filter exclusions,
 *  manual sibling order entries — is cleaned up too. No-op on ROOT. */
export function deleteFolder(path) {
    if (path === ROOT) return;
    const s = settings();
    const parent = parentOf(path);
    for (const [id, p] of Object.entries(s.assignments)) {
        if (p && isDescendantOrSelf(p, path)) s.assignments[id] = parent || ROOT;
    }
    s.folders = s.folders.filter(f => !isDescendantOrSelf(f, path));
    for (const field of ['collapsed', 'folderDisabled', 'folderSnapshot']) {
        for (const key of Object.keys(s[field])) {
            if (isDescendantOrSelf(key, path)) delete s[field][key];
        }
    }
    for (const key of Object.keys(s.excludedFolders)) {
        if (isDescendantOrSelf(key, path)) delete s.excludedFolders[key];
    }
    for (const key of Object.keys(s.excludedAutoFolders)) {
        if (isDescendantOrSelf(key, path)) delete s.excludedAutoFolders[key];
    }
    for (const key of Object.keys(s.order)) {
        if (key === path || key.startsWith(path + '/')) { delete s.order[key]; continue; }
        s.order[key] = s.order[key].filter(e => !(e.type === 'folder' && isDescendantOrSelf(e.key, path)));
    }
    save();
}

/** Assigns prompt `identifier` to folder `path` (or unassigns it back to ROOT if `path` is
 *  falsy), updates its position in the destination folder's manual sibling order, and saves. */
export function assignPrompt(identifier, path) {
    const s = settings();
    const target = path || ROOT;
    if (path) s.assignments[identifier] = path; else delete s.assignments[identifier];
    moveEntryInOrder({ type: 'prompt', key: identifier }, target);
    save();
}

/** Flips folder `path`'s collapsed/expanded state in settings and saves. */
export function toggleCollapsed(path) {
    const s = settings();
    s.collapsed[path] = !s.collapsed[path];
    save();
}

/** Prompts the user for a name, creates a new folder under `parentPath` positioned right after
 *  `afterEntry` in the manual sibling order (via createFolder() + moveEntryInOrder()), saves, and
 *  re-renders the tree. Used by the "New folder after this" context-menu actions. */
export async function insertNewFolderRelative(parentPath, afterEntry) {
    const name = await promptOrNull('New folder name:');
    if (!name || !name.trim()) return;
    const path = createFolder(parentPath, name.trim());
    if (path) moveEntryInOrder({ type: 'folder', key: path }, parentPath, null, afterEntry);
    save();
    renderTree();
}
