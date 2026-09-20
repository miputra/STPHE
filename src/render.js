import { scheduleAutoFilterEval } from './auto-filter.js';
import { openBulkMatchModal } from './bulk-match.js';
import { showContextMenu } from './context-menu.js';
import { attachDndHandlers, attachRootDropTarget } from './dnd.js';
import { assignPrompt, createFolder, deleteFolder, insertNewFolderRelative, renameFolder, toggleCollapsed } from './folders.js';
import { exportFolder, exportPrompt, importFolderStructureAppendAfter } from './import-export.js';
import { bulkDeletePromptsPermanently, bulkUnlistPrompts, deletePromptFlow, forceNativeRerender, openNativeEditor, readLivePrompts, renamePromptNative, requestNewPromptAfter, syncNativePromptOrder, toggleManyWithRetry, unlistPromptFlow, viewPrompt } from './native.js';
import { ROOT, el, flattenPromptOrder, isDescendantOrSelf, joinPath, nameOf, orderedChildren, save, settings, toastError } from './state.js';

// ---------- Multi-select (Ctrl/Cmd+click) ----------
//
// A transient (not persisted) set of currently-selected tree items, so several prompts/folders
// can be dragged and moved together in one go — see dnd.js's handleDrop() for how a drag payload
// expands to the whole selection. Each entry is stored as a JSON string of {type, key} so it can
// live in a plain Set without collisions between a folder path and a prompt identifier that might
// look similar.

const selectedItems = new Set();

function selectionKey(entry) { return JSON.stringify({ type: entry.type, key: entry.key }); }
/** True if `entry` ({type, key}) is currently selected. */
export function isSelected(entry) { return selectedItems.has(selectionKey(entry)); }
/** Adds/removes `entry` from the current selection (Ctrl/Cmd+click toggle). */
export function toggleSelection(entry) {
    const k = selectionKey(entry);
    if (selectedItems.has(k)) selectedItems.delete(k); else selectedItems.add(k);
}
/** Clears the current selection entirely (plain click on empty row space or empty tree
 *  background — see attachSelectionToggle and attachTreeBackgroundDeselect). Deliberately NOT
 *  called after a drag-drop completes (see dnd.js's handleDrop) — if a multi-item drop landed in
 *  the wrong spot, the same selection should still be draggable again rather than lost. */
export function clearSelection() { selectedItems.clear(); }
/** The current selection as an array of `{type, key}` entries. */
export function selectionEntries() { return [...selectedItems].map(k => JSON.parse(k)); }
/** How many items are currently selected. */
export function selectionSize() { return selectedItems.size; }

/** Wires the tree container itself so clicking genuinely empty space — below the last row, in
 *  the indentation gaps around a folder's children, or any other blank area inside #pf-tree that
 *  isn't part of a row — clears the current multi-selection, same as a plain click on a row does.
 *  Without this, only clicking an actual row could clear the selection; clicking around/between
 *  rows silently did nothing. Guards against double-handling a row's own click (which already
 *  clears/toggles via attachSelectionToggle above) by skipping if the click landed inside a row.
 *  Call once when the container is first built — it's a stable node reused across renderTree()
 *  calls, so re-attaching on every render would stack up duplicate listeners. */
export function attachTreeBackgroundDeselect(container) {
    container.addEventListener('click', ev => {
        if (ev.ctrlKey || ev.metaKey) return;
        if (ev.target.closest('.pf-folder-row, .pf-prompt-row')) return; // row handles its own click
        if (selectionSize() > 0) { clearSelection(); renderTree(); }
    });
}

/** Wires up `row` (representing tree item `entry` = `{type, key}`) for multi-select: Ctrl/Cmd+click
 *  toggles it in/out of the current selection (so it drags together with the rest — see dnd.js),
 *  a plain click on empty row space clears the selection, and neither interferes with the row's
 *  own buttons/toggle/move-select/collapse-arrow (those are excluded via the closest() check
 *  below, so e.g. collapsing a folder doesn't blow away an unrelated multi-selection) or with a
 *  folder name's existing double-click-to-rename. Also applies the `pf-selected` highlight class
 *  if `entry` is currently selected. */
function attachSelectionToggle(row, entry) {
    if (isSelected(entry)) row.classList.add('pf-selected');
    row.addEventListener('click', ev => {
        if (ev.target.closest('.pf-icon-btn, .pf-toggle, .pf-move-select, .pf-collapse-btn, select, input, textarea')) return;
        if (ev.ctrlKey || ev.metaKey) {
            ev.preventDefault();
            toggleSelection(entry);
            renderTree();
        } else if (selectionSize() > 0) {
            clearSelection();
            renderTree();
        }
    });
}

// ---------- Tree renderer ----------
//
// Builds the folder/prompt tree shown in the dock's #pf-tree container, driven by two sources
// of truth: this extension's own folder settings (structure, assignments, order — see
// state.js) and a fresh snapshot of the live Prompt Manager DOM (`liveCache`, refreshed by
// renderTree() on every call via native.js's readLivePrompts()). Every user action in the tree
// (toggle, rename, move, delete, exclude, ...) ends by calling renderTree() again to reflect
// the new state — this module does not do incremental DOM patching.

/** Snapshot of the live Prompt Manager prompts, refreshed at the top of every renderTree() call.
 *  Exported (as a live binding) so other modules can read "what prompts currently exist" without
 *  re-querying the DOM themselves. */
export let liveCache = [];
/** Current text typed into the dock's search box; empty string means "no filter". Exported as a
 *  live binding for panel.js's search input handler to write to. */
export let searchTerm = '';

/** True when prompt `p` is currently suppressed by an independently muted containing folder.
 *  ROOT represents only the Unfiled bucket, not an ancestor of every named folder; the shared
 *  path helper already preserves that distinction. */
export function isPromptSuppressed(p, s = settings()) {
    if (!p) return false;
    const assignedPath = s.assignments[p.identifier] || ROOT;
    return Object.entries(s.folderDisabled).some(([folderPath, disabled]) => (
        !!disabled && isDescendantOrSelf(assignedPath, folderPath)
    ));
}

/** True when a folder is not muted itself, but one of its named ancestor folders is muting its
 *  native prompts. This is a visual-state helper: the child folder's own intended states remain
 *  unchanged and become active again when that ancestor mute is removed. */
export function isFolderSuppressedByAncestor(path, s = settings()) {
    return Object.entries(s.folderDisabled).some(([folderPath, disabled]) => (
        !!disabled && folderPath !== path && isDescendantOrSelf(path, folderPath)
    ));
}

/** Returns a prompt's visible/intended state. New builds persist that state in promptDesired.
 *  For an older saved configuration, recover it from the most-specific active folder snapshot;
 *  if that old snapshot intentionally omitted a branch, use its historical restore default of
 *  ON. An unsuppressed legacy prompt simply inherits its live native state. */
export function isPromptLogicallyEnabled(p, s = settings()) {
    if (!p) return false;
    if (Object.prototype.hasOwnProperty.call(s.promptDesired, p.identifier)) {
        return !!s.promptDesired[p.identifier];
    }

    const assignedPath = s.assignments[p.identifier] || ROOT;
    const mutedFolders = Object.entries(s.folderDisabled)
        .filter(([folderPath, disabled]) => !!disabled && isDescendantOrSelf(assignedPath, folderPath))
        .map(([folderPath]) => folderPath)
        .sort((a, b) => b.length - a.length);
    for (const folderPath of mutedFolders) {
        const snapshot = s.folderSnapshot[folderPath];
        if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, p.identifier)) {
            return !!snapshot[p.identifier];
        }
    }
    return mutedFolders.length > 0 ? true : !!p.enabled;
}

/** Initializes missing intended states without letting the native all-off state of a muted
 *  folder overwrite them. Existing intended values are changed only by an explicit extension
 *  action or the dedicated original-Prompt-Manager click watcher in bootstrap.js. */
function reconcilePromptDesiredStates(prompts, s = settings()) {
    let changed = false;
    for (const p of prompts) {
        const hasDesired = Object.prototype.hasOwnProperty.call(s.promptDesired, p.identifier);
        if (!hasDesired) {
            s.promptDesired[p.identifier] = isPromptLogicallyEnabled(p, s);
            changed = true;
        }
    }
    if (changed) save();
    return changed;
}

/** The state SillyTavern's native list must actually use: intended prompt state AND no muted
 *  containing folder. */
function effectiveNativePromptState(p, s = settings()) {
    return isPromptLogicallyEnabled(p, s) && !isPromptSuppressed(p, s);
}

/** Updates one or many visible/intended prompt toggles. Suppressed prompts change visually and
 *  persist without being enabled natively; unsuppressed prompts are applied through one verified
 *  native batch. This is also the common path used by manual filters and Auto Filter. */
export function setPromptsLogicalState(changes) {
    const desiredById = new Map();
    for (const change of changes || []) {
        if (change?.identifier) desiredById.set(change.identifier, !!change.enabled);
    }
    if (desiredById.size === 0) return;

    const s = settings();
    const byId = new Map(liveCache.map(p => [p.identifier, p]));
    let settingsChanged = false;
    for (const [identifier, enabled] of desiredById) {
        if (!Object.prototype.hasOwnProperty.call(s.promptDesired, identifier) || s.promptDesired[identifier] !== enabled) {
            s.promptDesired[identifier] = enabled;
            settingsChanged = true;
        }
    }
    if (settingsChanged) save();

    const nativeChanges = [];
    for (const [identifier] of desiredById) {
        const p = byId.get(identifier);
        if (!p) continue;
        const enabled = effectiveNativePromptState(p, s);
        if (!!p.enabled !== enabled) nativeChanges.push({ identifier, enabled });
    }
    if (nativeChanges.length > 0) toggleManyWithRetry(nativeChanges);
    else renderTree();
}

export function setPromptLogicalState(identifier, enabled) {
    setPromptsLogicalState([{ identifier, enabled }]);
}

/** One shared debounce slot for refreshes caused by native prompt mutations. A folder batch and
 *  the Prompt Manager MutationObserver see the same underlying changes; sharing this slot keeps
 *  those two signals from rebuilding the tree twice. Direct renderTree() calls cancel anything
 *  queued here, since they already make the queued refresh obsolete. */
let scheduledRenderTimer = null;
export function scheduleRenderTree(delay = 0) {
    clearTimeout(scheduledRenderTimer);
    scheduledRenderTimer = setTimeout(() => {
        scheduledRenderTimer = null;
        renderTree();
    }, delay);
}

/** Looks up a live prompt by its native identifier, or undefined if it's not currently in
 *  `liveCache` (e.g. it was removed from the active list since the last render). */
export function promptByIdentifier(id) {
    return liveCache.find(p => p.identifier === id);
}

/** Returns the live prompts (from `liveCache`) that are directly assigned to folder `path` —
 *  not including prompts in subfolders. */
export function promptsInFolder(path) {
    return liveCache.filter(p => (settings().assignments[p.identifier] || ROOT) === path);
}

/** Every live prompt (recursively) assigned anywhere under `path` — the folder itself or any
 *  subfolder. Used by the "Delete folder + prompts inside" variants below to know exactly which
 *  prompts a folder deletion will also affect, same reach as folderAggregateState/setFolderMaster. */
function promptsUnderFolder(path) {
    const s = settings();
    return liveCache.filter(p => isDescendantOrSelf(s.assignments[p.identifier] || ROOT, path));
}

/** "Delete folder + prompts inside (not permanently)": removes every prompt assigned anywhere
 *  under `path` from the active list only — same guarantee as "Remove from list" per-prompt (each
 *  definition is kept and can be brought back later), just done in one bulk pass via
 *  bulkUnlistPrompts() so there's no native confirmation popup per prompt — then deletes the
 *  folder(s) themselves via deleteFolder(), same as the plain "Delete folder" option. Each
 *  affected prompt's folder assignment/exclusions here are cleared first (rather than left
 *  pointing at a folder that's about to stop existing), so if one comes back later it lands
 *  unfiled instead of silently vanishing from the tree. */
async function deleteFolderUnlistPrompts(path) {
    const affected = promptsUnderFolder(path);
    if (!confirm(
        `Delete folder "${nameOf(path)}"? This also removes ${affected.length} prompt${affected.length === 1 ? '' : 's'} ` +
        `inside it (and any subfolders) from this list — NOT permanently: each one's definition is kept, ` +
        `and can be brought back later via "Insert prompt" in AI Response Configuration (or by re-importing ` +
        `a prompt list that references it).`
    )) return;
    const removed = await bulkUnlistPrompts(affected.map(p => p.identifier));
    if (removed === -1) {
        toastError('Could not access SillyTavern\'s prompt settings directly on this version, so I couldn\'t remove the prompts inside. The folder itself was not deleted either.');
        return;
    }
    const s = settings();
    for (const p of affected) {
        delete s.assignments[p.identifier];
        delete s.excludedPrompts[p.identifier];
        delete s.excludedAutoPrompts[p.identifier];
        delete s.promptDesired[p.identifier];
    }
    deleteFolder(path);
    forceNativeRerender(renderTree);
}

/** "Delete folder + prompts inside PERMANENTLY": same as above, but each prompt's own definition
 *  is removed entirely (bulkDeletePromptsPermanently) — matching "Delete prompt entirely"
 *  per-prompt, just without a native confirmation popup per prompt. Cannot be undone. */
async function deleteFolderPermanently(path) {
    const affected = promptsUnderFolder(path);
    if (!confirm(
        `Delete folder "${nameOf(path)}" AND permanently delete ${affected.length} prompt${affected.length === 1 ? '' : 's'} ` +
        `inside it (and any subfolders)? This removes their definitions entirely — not just this list — ` +
        `and CANNOT BE UNDONE.`
    )) return;
    const removed = await bulkDeletePromptsPermanently(affected.map(p => p.identifier));
    if (removed === -1) {
        toastError('Could not access SillyTavern\'s prompt settings directly on this version, so I couldn\'t delete the prompts inside. The folder itself was not deleted either.');
        return;
    }
    const s = settings();
    for (const p of affected) {
        delete s.assignments[p.identifier];
        delete s.excludedPrompts[p.identifier];
        delete s.excludedAutoPrompts[p.identifier];
        delete s.promptDesired[p.identifier];
    }
    deleteFolder(path);
    forceNativeRerender(renderTree);
}

/** Wipes every folder-related field in settings() back to empty — the shared tail end of every
 *  "remove all folders" flow below (folders-only and folders+contents alike). Does not touch
 *  s.assignments (callers clear that themselves, since folders-only vs folders+contents disagree
 *  on whether affected prompts should end up Unfiled or gone from assignments entirely). */
function clearAllFolders(s) {
    s.folders = [];
    s.collapsed = {};
    s.folderDisabled = {};
    s.folderSnapshot = {};
    s.excludedFolders = {};
    s.excludedAutoFolders = {};
}

/** "Remove all folders only" — folders (at every depth) are forgotten, but every prompt they
 *  contained is simply unfiled (moved to 📥 Unfiled) rather than touched in any way. Nothing about
 *  the prompts themselves changes — same guarantee a single-folder "Delete folder only" gives,
 *  just for every folder at once. No permanent/not-permanent choice here: folders have no native
 *  definition to keep or delete, only this extension's own bookkeeping. */
function removeAllFoldersOnlyFlow() {
    const s = settings();
    const folderCount = s.folders.length;
    if (folderCount === 0) return;
    if (!confirm(
        `Remove all ${folderCount} folder${folderCount === 1 ? '' : 's'}? Every prompt inside them moves up to ` +
        `📥 Unfiled — nothing about the prompts themselves changes.`
    )) return;
    for (const id of Object.keys(s.assignments)) delete s.assignments[id];
    clearAllFolders(s);
    save();
    renderTree();
}

/** "Remove all folders + everything inside them" — same reach as the per-folder "Delete folder +
 *  prompts inside" pair (deleteFolderUnlistPrompts/deleteFolderPermanently), just for every folder
 *  at once: every prompt actually filed into a folder is removed too (not-permanently or
 *  PERMANENTLY per `permanent`), while any prompt that's already 📥 Unfiled is left completely
 *  alone. */
async function removeAllFoldersAndContentsFlow(permanent) {
    const s = settings();
    const folderCount = s.folders.length;
    const affected = liveCache.filter(p => (s.assignments[p.identifier] || ROOT) !== ROOT);
    if (folderCount === 0 && affected.length === 0) return;
    const promptWord = affected.length === 1 ? 'prompt' : 'prompts';
    const folderWord = folderCount === 1 ? 'folder' : 'folders';
    const msg = permanent
        ? `Remove all ${folderCount} ${folderWord} AND permanently delete the ${affected.length} ${promptWord} ` +
          `filed inside them? This deletes those prompts' definitions entirely — not just this list — and ` +
          `CANNOT BE UNDONE. Prompts that are already 📥 Unfiled are not touched.`
        : `Remove all ${folderCount} ${folderWord} and remove the ${affected.length} ${promptWord} filed inside ` +
          `them from this list? NOT permanently: each prompt's definition is kept, and can be brought back ` +
          `later via "Insert prompt" in AI Response Configuration (or by re-importing a prompt list that ` +
          `references it). Prompts that are already 📥 Unfiled are not touched.`;
    if (!confirm(msg)) return;
    const removed = permanent
        ? await bulkDeletePromptsPermanently(affected.map(p => p.identifier))
        : await bulkUnlistPrompts(affected.map(p => p.identifier));
    if (removed === -1) {
        toastError(`Could not access SillyTavern's prompt settings directly on this version, so I couldn't ${permanent ? 'delete' : 'remove'} the prompts inside. No folders were removed either.`);
        return;
    }
    for (const p of affected) {
        delete s.assignments[p.identifier];
        delete s.excludedPrompts[p.identifier];
        delete s.excludedAutoPrompts[p.identifier];
        delete s.promptDesired[p.identifier];
    }
    clearAllFolders(s);
    save();
    forceNativeRerender(renderTree);
}

/** "Remove all prompts only" — every live prompt is removed (not-permanently or PERMANENTLY per
 *  `permanent`), but the folder structure itself is left completely alone — folders just end up
 *  empty instead of being deleted, so it's still there to re-file prompts into later. */
async function removeAllPromptsOnlyFlow(permanent) {
    const affected = liveCache.slice();
    if (affected.length === 0) return;
    const s = settings();
    const promptWord = affected.length === 1 ? 'prompt' : 'prompts';
    const msg = permanent
        ? `Permanently delete ALL ${affected.length} ${promptWord}? This deletes every prompt's definition ` +
          `entirely — not just this list — and CANNOT BE UNDONE. Your folders are kept (just empty afterward).`
        : `Remove ALL ${affected.length} ${promptWord} from this list? NOT permanently: each one's definition ` +
          `is kept, and can be brought back later via "Insert prompt" in AI Response Configuration (or by ` +
          `re-importing a prompt list that references it). Your folders are kept (just empty afterward).`;
    if (!confirm(msg)) return;
    const removed = permanent
        ? await bulkDeletePromptsPermanently(affected.map(p => p.identifier))
        : await bulkUnlistPrompts(affected.map(p => p.identifier));
    if (removed === -1) {
        toastError(`Could not access SillyTavern's prompt settings directly on this version, so I couldn't ${permanent ? 'delete' : 'remove'} the prompts. Nothing was changed.`);
        return;
    }
    for (const p of affected) {
        delete s.assignments[p.identifier];
        delete s.excludedPrompts[p.identifier];
        delete s.excludedAutoPrompts[p.identifier];
        delete s.promptDesired[p.identifier];
    }
    s.folderDisabled = {};
    s.folderSnapshot = {};
    save();
    forceNativeRerender(renderTree);
}

/** "Remove everything" — every prompt AND every folder at once. Same not-permanent-vs-permanent
 *  choice every other delete action offers. Not permanent: every prompt is removed from the
 *  active list only (each definition is kept and can be brought back later), and every folder
 *  this extension knows about is forgotten (folders have no native definition to keep — recreating
 *  one just means making a new folder and re-filing prompts into it). Permanent: every prompt's
 *  own definition is deleted entirely, in addition to forgetting every folder. Cannot be undone. */
async function removeEverythingFlow(permanent) {
    const affected = liveCache.slice();
    const s = settings();
    const folderCount = s.folders.length;
    if (affected.length === 0 && folderCount === 0) { return; }
    const promptWord = affected.length === 1 ? 'prompt' : 'prompts';
    const folderWord = folderCount === 1 ? 'folder' : 'folders';
    const msg = permanent
        ? `Permanently delete ALL ${affected.length} ${promptWord} and remove all ${folderCount} ${folderWord}? ` +
          `This deletes every prompt's definition entirely — not just this list — and CANNOT BE UNDONE.`
        : `Remove ALL ${affected.length} ${promptWord} from this list and remove all ${folderCount} ${folderWord}? ` +
          `NOT permanently for the prompts: each one's definition is kept, and can be brought back later via ` +
          `"Insert prompt" in AI Response Configuration (or by re-importing a prompt list that references it). ` +
          `Folders themselves have nothing to "keep" — you'd need to recreate them.`;
    if (!confirm(msg)) return;
    const removed = permanent
        ? await bulkDeletePromptsPermanently(affected.map(p => p.identifier))
        : await bulkUnlistPrompts(affected.map(p => p.identifier));
    if (removed === -1) {
        toastError(`Could not access SillyTavern's prompt settings directly on this version, so I couldn't ${permanent ? 'delete' : 'remove'} the prompts. Nothing was changed.`);
        return;
    }
    s.assignments = {};
    s.excludedPrompts = {};
    s.excludedAutoPrompts = {};
    s.promptDesired = {};
    clearAllFolders(s);
    s.order = {};
    save();
    forceNativeRerender(renderTree);
}

/** Wires up the toolbar's red 🗑 "Remove All" icon: opens a grouped menu (not a single click —
 *  these are the most destructive actions in the whole extension) covering exactly what should be
 *  removed — folders only, folders and everything inside them, prompts only, or literally
 *  everything — each of the latter three tucked behind its own not-permanent-vs-permanent
 *  submenu (see the four flows above), and every leaf still behind its own confirm(). */
export function openRemoveAllMenu(anchorEl) {
    const permanentChoice = (label, onNotPermanent, onPermanent) => ({
        label,
        items: [
            { label: '🔓 Remove from list (not permanent)', action: onNotPermanent, danger: true },
            { label: '🗑 Delete PERMANENTLY', action: onPermanent, danger: true },
        ],
    });
    showContextMenu(anchorEl, [
        { label: '📁 Remove all folders only (keep prompts, unfile them)', action: removeAllFoldersOnlyFlow, danger: true },
        permanentChoice('📁 Remove all folders + everything inside them ▸',
            () => removeAllFoldersAndContentsFlow(false), () => removeAllFoldersAndContentsFlow(true)),
        permanentChoice('📄 Remove all prompts only (keep folder structure) ▸',
            () => removeAllPromptsOnlyFlow(false), () => removeAllPromptsOnlyFlow(true)),
        permanentChoice('🧨 Remove all prompts AND all folders ▸',
            () => removeEverythingFlow(false), () => removeEverythingFlow(true)),
    ]);
}

/** Computes a folder's aggregate enabled/disabled state across every prompt assigned to it or
 *  any of its subfolders: 'on' if all enabled, 'off' if all disabled, 'mixed' if some of each,
 *  or `null` if the folder (recursively) contains no prompts at all. Used to decide how the
 *  folder's own master toggle should look. */
function folderAggregateState(path) {
    const s = settings();
    const inScope = liveCache.filter(p => isDescendantOrSelf(s.assignments[p.identifier] || ROOT, path));
    if (inScope.length === 0) return null;
    const onCount = inScope.filter(p => isPromptLogicallyEnabled(p, s)).length;
    if (onCount === 0) return 'off';
    if (onCount === inScope.length) return 'on';
    return 'mixed';
}

/** True if prompt `p` matches the current `searchTerm` (by name or identifier, case-insensitive),
 *  or if there's no active search at all. */
function matchesSearch(p) {
    if (!searchTerm) return true;
    const t = searchTerm.toLowerCase();
    return p.name.toLowerCase().includes(t) || p.identifier.toLowerCase().includes(t);
}

/** Returns every folder path (plus ROOT first) for populating a "move to folder" `<select>`. */
function buildFolderOptions() {
    const s = settings();
    return [ROOT, ...s.folders.slice().sort()];
}

/** Builds the small per-prompt-row `<select>` used to move a prompt to a different folder,
 *  including a "New folder…" option that prompts for a (possibly nested, "/"-separated) path,
 *  creates any missing segments, and assigns the prompt there. */
function renderMoveSelect(identifier, currentPath) {
    const select = el('select', 'pf-move-select text_pole');
    for (const path of buildFolderOptions()) {
        const opt = el('option', null, { value: path, text: path === ROOT ? '📥 Unfiled' : path });
        if (path === currentPath) opt.selected = true;
        select.appendChild(opt);
    }
    select.appendChild(el('option', null, { value: '__new__', text: '➕ New folder…' }));
    select.addEventListener('change', () => {
        if (select.value === '__new__') {
            const name = prompt('New folder name (nested example: Jailbreak/NSFW):');
            const finalPath = (name || '').trim();
            if (finalPath) {
                const segments = finalPath.split('/').filter(Boolean);
                const s = settings();
                let acc = '';
                for (const seg of segments) {
                    acc = joinPath(acc, seg);
                    if (!s.folders.includes(acc)) s.folders.push(acc);
                }
                save();
                assignPrompt(identifier, finalPath);
            }
            renderTree();
            return;
        }
        assignPrompt(identifier, select.value || null);
        renderTree();
    });
    return select;
}

/** Builds one prompt's row: its toggle, name, exclude/auto-exclude buttons, view/edit buttons,
 *  the "more actions" context-menu button, and its move-to-folder select — wires up all their
 *  handlers, attaches drag-and-drop, and returns the finished row element. */
function renderPromptRow(p, parentPath) {
    const row = el('div', 'pf-prompt-row');
    row.dataset.identifier = p.identifier;

    const logicalEnabled = isPromptLogicallyEnabled(p);
    const suppressed = isPromptSuppressed(p);
    const toggleClass = logicalEnabled
        ? `fa-toggle-on ${suppressed ? 'pf-mixed' : 'pf-on'}`
        : 'fa-toggle-off pf-off';
    const toggleTitle = logicalEnabled
        ? (suppressed
            ? 'Intended ON, but currently disabled by a muted folder — click to set intended state OFF'
            : 'Click to disable')
        : (suppressed
            ? 'Intended OFF while this folder is muted — click to set intended state ON'
            : 'Click to enable');

    const toggle = el('span', `pf-toggle fa-solid ${toggleClass}`, { title: toggleTitle });
    toggle.addEventListener('click', () => setPromptLogicalState(p.identifier, !logicalEnabled));

    const name = el('span', 'pf-prompt-name', { text: p.name, title: p.name });

    const excluded = !!settings().excludedPrompts[p.identifier];
    const excludeBtn = el('span', `pf-icon-btn fa-solid ${excluded ? 'fa-filter-circle-xmark' : 'fa-filter'}`, {
        title: excluded
            ? 'Excluded from Enable/disable-by-match filters & presets — click to include again'
            : 'Click to exclude this prompt from Enable/disable-by-match filters & presets',
    });
    if (excluded) excludeBtn.classList.add('pf-context-danger');
    excludeBtn.addEventListener('click', () => {
        const s = settings();
        if (s.excludedPrompts[p.identifier]) delete s.excludedPrompts[p.identifier];
        else s.excludedPrompts[p.identifier] = true;
        save();
        renderTree();
    });

    // Independent of the excludeBtn above: this excludes the prompt from Auto Filter ONLY (both
    // its condition scanning and its effect targeting) — the manual Enable/disable-by-match
    // filter and saved presets above are completely unaffected by this flag, and vice versa.
    const autoExcluded = !!settings().excludedAutoPrompts[p.identifier];
    const autoExcludeBtn = el('span', `pf-icon-btn fa-solid ${autoExcluded ? 'fa-ban' : 'fa-wand-magic-sparkles'}`, {
        title: autoExcluded
            ? 'Excluded from Auto Filter rules — click to include again'
            : 'Click to exclude this prompt from Auto Filter rules',
    });
    if (autoExcluded) autoExcludeBtn.classList.add('pf-context-danger');
    autoExcludeBtn.addEventListener('click', () => {
        const s = settings();
        if (s.excludedAutoPrompts[p.identifier]) delete s.excludedAutoPrompts[p.identifier];
        else s.excludedAutoPrompts[p.identifier] = true;
        save();
        renderTree();
        scheduleAutoFilterEval(0);
    });

    const viewBtn = el('span', 'pf-icon-btn fa-solid fa-eye', { title: 'View this prompt (read-only)' });
    viewBtn.addEventListener('click', () => viewPrompt(p.identifier, p.name));

    const editBtn = el('span', 'pf-icon-btn fa-solid fa-pen-to-square', {
        title: p.editable ? 'Edit this prompt' : 'Edit not available for this prompt',
    });
    if (!p.editable) editBtn.style.opacity = '0.25';
    editBtn.addEventListener('click', () => {
        const ok = openNativeEditor(p.identifier);
        if (!ok) toastError('Could not open the editor for this prompt.');
    });

    const menuBtn = el('span', 'pf-icon-btn fa-solid fa-ellipsis-vertical', { title: 'More actions' });
    menuBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        showContextMenu(menuBtn, [
            { label: '✎ Rename…', action: () => renamePromptNative(p.identifier) },
            'separator',
            { label: '➕ New prompt after this', action: () => requestNewPromptAfter(parentPath, { type: 'prompt', key: p.identifier }) },
            { label: '📁 New folder after this', action: () => insertNewFolderRelative(parentPath, { type: 'prompt', key: p.identifier }) },
            { label: '📥 Import append after this prompt', action: () => importFolderStructureAppendAfter({ type: 'prompt', key: p.identifier }, parentPath, p.name) },
            { label: '📤 Export this prompt', action: () => exportPrompt(p.identifier, p.name) },
            'separator',
            { label: '🗑 Delete ▸', danger: true, items: [
                { label: '🔓 Remove from list (not permanent)', action: () => unlistPromptFlow(p), danger: true },
                { label: '🗑 Delete prompt PERMANENTLY', action: () => deletePromptFlow(p), danger: true },
            ] },
        ]);
    });

    const currentPath = settings().assignments[p.identifier] || ROOT;
    const moveSelect = renderMoveSelect(p.identifier, currentPath);

    row.append(toggle, name, excludeBtn, autoExcludeBtn, viewBtn, editBtn, menuBtn, moveSelect);
    attachDndHandlers(row, { type: 'prompt', key: p.identifier }, parentPath);
    attachSelectionToggle(row, { type: 'prompt', key: p.identifier });

    return row;
}

/** Clears saved master state that overlaps `path` in either direction. A force-all action owns
 *  the resulting prompt states, so neither a descendant's old snapshot nor a containing
 *  folder's old snapshot should later undo it. ROOT is the Unfiled bucket rather than an
 *  ancestor of every named folder, hence the explicit non-empty prefix checks. */
function clearIntersectingFolderMasterState(path, s) {
    const keys = new Set([...Object.keys(s.folderDisabled), ...Object.keys(s.folderSnapshot)]);
    for (const key of keys) {
        const same = key === path;
        const descendant = !!path && key.startsWith(path + '/');
        const ancestor = !!key && path.startsWith(key + '/');
        if (!same && !descendant && !ancestor) continue;
        delete s.folderDisabled[key];
        delete s.folderSnapshot[key];
    }
}

/** Applies the effective native state for a set of prompts after logical prompt/folder state has
 *  changed. Already-correct rows are omitted so editing a visible toggle under a muted parent is
 *  an immediate settings-only operation with no unnecessary loading overlay. */
function applyEffectiveNativeStates(affected, s) {
    const nativeChanges = affected
        .map(p => ({ identifier: p.identifier, enabled: effectiveNativePromptState(p, s), current: !!p.enabled }))
        .filter(change => change.enabled !== change.current)
        .map(({ identifier, enabled }) => ({ identifier, enabled }));
    if (nativeChanges.length > 0) toggleManyWithRetry(nativeChanges);
    else renderTree();
}

/** Directional folder mute. Turning it off records every prompt's visible/intended state but
 *  changes only SillyTavern's native effective states; the prompt toggles shown in this extension
 *  do not move. Turning it on removes only this folder's mute layer and re-applies those current
 *  visible states, while any independently-muted parent or child folder remains authoritative. */
export function setFolderMaster(path, desiredOff) {
    const s = settings();
    const affected = liveCache.filter(p => isDescendantOrSelf(s.assignments[p.identifier] || ROOT, path));
    if (!!s.folderDisabled[path] === desiredOff) return; // already in the desired state

    for (const p of affected) {
        if (!Object.prototype.hasOwnProperty.call(s.promptDesired, p.identifier)) {
            s.promptDesired[p.identifier] = isPromptLogicallyEnabled(p, s);
        }
    }
    if (desiredOff) {
        s.folderSnapshot[path] = Object.fromEntries(affected.map(p => [p.identifier, isPromptLogicallyEnabled(p, s)]));
        s.folderDisabled[path] = true;
    } else {
        delete s.folderDisabled[path];
        delete s.folderSnapshot[path];
    }
    save();
    applyEffectiveNativeStates(affected, s);
}

/** Force control used by the two dedicated one-click folder buttons. Unlike the restore-style
 *  master toggle, this intentionally changes every content toggle's visible/intended state to
 *  one uniform value. It clears overlapping mute layers, then applies the same value natively. */
export function setFolderAll(path, enabled) {
    const s = settings();
    const affected = liveCache.filter(p => isDescendantOrSelf(s.assignments[p.identifier] || ROOT, path));
    clearIntersectingFolderMasterState(path, s);
    for (const p of affected) s.promptDesired[p.identifier] = !!enabled;
    save();
    applyEffectiveNativeStates(affected, s);
}

/** Folder toggle flips only this folder's independent native mute layer. */
export function toggleFolderMaster(path) {
    const s = settings();
    setFolderMaster(path, !s.folderDisabled[path]);
}

/** Builds a folder row's master toggle element: picks the on/mixed/off icon and title from
 *  folderAggregateState() and the mute-switch flag, and (unless the folder is genuinely empty)
 *  wires its click to toggleFolderMaster(). */
function renderFolderToggle(path) {
    const s = settings();
    const masterOff = !!s.folderDisabled[path];
    const ancestorMuted = isFolderSuppressedByAncestor(path, s);
    const state = folderAggregateState(path); // null = folder currently has no prompts in it

    let effective, title;
    if (masterOff) {
        effective = 'off';
        title = 'Folder muted natively — click to apply the visible content-toggle states';
    } else if (state === null) {
        effective = 'off';
        title = 'No prompts in this folder yet';
    } else if (ancestorMuted && state !== 'off') {
        effective = 'mixed';
        title = 'This folder has intended enabled content, but an ancestor folder is muting it';
    } else {
        effective = state;
        title = 'Mute this folder natively without changing its visible content toggles';
    }

    const cls = effective === 'on' ? 'fa-toggle-on pf-on' : effective === 'mixed' ? 'fa-toggle-on pf-mixed' : 'fa-toggle-off pf-off';
    const toggle = el('span', `pf-toggle fa-solid ${cls}`, { title });

    if (state === null && !masterOff) {
        toggle.style.opacity = '0.3';
        toggle.style.cursor = 'default';
    } else {
        toggle.addEventListener('click', () => toggleFolderMaster(path));
    }
    return toggle;
}

/** Builds the two compact, always-visible one-click controls beside a folder's restore-style
 *  master toggle. They force every prompt in the folder/subfolders on or off respectively. */
function renderFolderAllButtons(path) {
    const state = folderAggregateState(path);
    const makeButton = (enabled, icon, title) => {
        const button = el('span', `pf-icon-btn pf-folder-all-toggle fa-solid ${icon} ${enabled ? 'pf-folder-all-on' : 'pf-folder-all-off'}`, { title });
        if (state === null) {
            button.classList.add('pf-folder-all-disabled');
        } else {
            button.addEventListener('click', ev => {
                ev.stopPropagation();
                setFolderAll(path, enabled);
            });
        }
        return button;
    };
    return {
        allOnBtn: makeButton(true, 'fa-square-check', 'Enable ALL prompts in this folder and its subfolders'),
        allOffBtn: makeButton(false, 'fa-square-xmark', 'Disable ALL prompts in this folder and its subfolders'),
    };
}

/** Recursively builds one folder's full row (collapse arrow, icon, name, master toggle,
 *  exclude/auto-exclude buttons, context menu) plus — if not collapsed — a child container with
 *  every subfolder and prompt rendered in `orderedChildren()` order. This is the tree's main
 *  recursive entry point, called for ROOT (and then recursively for every subfolder) by
 *  renderTree(). */
function renderFolder(path, depth, parentPath) {
    const s = settings();
    const wrap = el('div', 'pf-folder');
    const collapsed = !!s.collapsed[path];

    const row = el('div', 'pf-folder-row');
    row.dataset.folderPath = path;

    const collapseBtn = el('span', `pf-collapse-btn fa-solid ${collapsed ? 'fa-caret-right' : 'fa-caret-down'}`);
    collapseBtn.addEventListener('click', () => { toggleCollapsed(path); renderTree(); });

    const icon = el('span', `pf-folder-icon fa-solid ${collapsed ? 'fa-folder' : 'fa-folder-open'}`);
    const nameEl = el('span', 'pf-folder-name', { text: path === ROOT ? '📥 Unfiled' : nameOf(path) });

    if (path !== ROOT) {
        nameEl.title = 'Double-click to rename';
        nameEl.addEventListener('dblclick', () => {
            const newName = prompt('Rename folder:', nameOf(path));
            if (newName && newName.trim() && newName.trim() !== nameOf(path)) {
                renameFolder(path, newName.trim());
                renderTree();
            }
        });
    }

    const toggle = renderFolderToggle(path);
    const { allOnBtn, allOffBtn } = renderFolderAllButtons(path);

    let excludeBtn = null;
    let autoExcludeBtn = null;
    if (path !== ROOT) {
        const excluded = !!s.excludedFolders[path];
        excludeBtn = el('span', `pf-icon-btn fa-solid ${excluded ? 'fa-filter-circle-xmark' : 'fa-filter'}`, {
            title: excluded
                ? 'This folder (and everything inside it) is excluded from Enable/disable-by-match filters & presets — click to include again'
                : 'Click to exclude this folder (and everything inside it) from Enable/disable-by-match filters & presets',
        });
        if (excluded) excludeBtn.classList.add('pf-context-danger');
        excludeBtn.addEventListener('click', ev => {
            ev.stopPropagation();
            const s2 = settings();
            if (s2.excludedFolders[path]) delete s2.excludedFolders[path];
            else s2.excludedFolders[path] = true;
            save();
            renderTree();
        });

        // Independent of excludeBtn above: excludes this folder (and everything inside it,
        // including subfolders) from Auto Filter ONLY. The manual Enable/disable-by-match filter
        // & saved presets never look at this flag, and this flag never looks at excludedFolders.
        const autoExcluded = !!s.excludedAutoFolders[path];
        autoExcludeBtn = el('span', `pf-icon-btn fa-solid ${autoExcluded ? 'fa-ban' : 'fa-wand-magic-sparkles'}`, {
            title: autoExcluded
                ? 'This folder (and everything inside it) is excluded from Auto Filter rules — click to include again'
                : 'Click to exclude this folder (and everything inside it) from Auto Filter rules',
        });
        if (autoExcluded) autoExcludeBtn.classList.add('pf-context-danger');
        autoExcludeBtn.addEventListener('click', ev => {
            ev.stopPropagation();
            const s2 = settings();
            if (s2.excludedAutoFolders[path]) delete s2.excludedAutoFolders[path];
            else s2.excludedAutoFolders[path] = true;
            save();
            renderTree();
            scheduleAutoFilterEval(0);
        });
    }

    const menuBtn = el('span', 'pf-icon-btn fa-solid fa-ellipsis-vertical', { title: 'More actions' });
    menuBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        const items = [
            { label: '📁 New subfolder', action: () => { createFolder(path, promptOrNull('New subfolder name:')); s.collapsed[path] = false; save(); renderTree(); } },
            { label: '➕ New prompt inside', action: () => requestNewPromptAfter(path, null) },
            { label: '🎯 Filter this folder by content…', action: () => openBulkMatchModal(path) },
        ];
        if (path !== ROOT) {
            items.push('separator');
            items.push({ label: '✎ Rename folder', action: () => {
                const newName = prompt('Rename folder:', nameOf(path));
                if (newName && newName.trim() && newName.trim() !== nameOf(path)) { renameFolder(path, newName.trim()); renderTree(); }
            } });
            items.push({ label: '📤 Export this folder', action: () => exportFolder(path) });
            items.push({ label: '➕ New prompt after this folder', action: () => requestNewPromptAfter(parentPath, { type: 'folder', key: path }) });
            items.push({ label: '📁 New folder after this folder', action: () => insertNewFolderRelative(parentPath, { type: 'folder', key: path }) });
            items.push({ label: '📥 Import append after this folder', action: () => importFolderStructureAppendAfter({ type: 'folder', key: path }, parentPath, nameOf(path)) });
            items.push('separator');
            items.push({ label: '🗑 Delete folder ▸', danger: true, items: [
                { label: '🗑 Delete folder only (keep prompts, move up)', danger: true, action: () => {
                    if (confirm(`Delete folder "${nameOf(path)}"? Prompts inside move up one level. Subfolders are deleted too.`)) { deleteFolder(path); renderTree(); }
                } },
                { label: '🗑 Delete folder + remove prompts inside (not permanent)', danger: true, action: () => deleteFolderUnlistPrompts(path) },
                { label: '🗑 Delete folder + delete prompts inside PERMANENTLY', danger: true, action: () => deleteFolderPermanently(path) },
            ] });
        }
        showContextMenu(menuBtn, items);
    });

    row.append(collapseBtn, icon, nameEl, toggle, allOnBtn, allOffBtn);
    if (excludeBtn) row.append(excludeBtn);
    if (autoExcludeBtn) row.append(autoExcludeBtn);
    row.append(menuBtn);

    if (path === ROOT) {
        attachRootDropTarget(row);
    } else {
        attachDndHandlers(row, { type: 'folder', key: path }, parentPath);
        attachSelectionToggle(row, { type: 'folder', key: path });
    }

    wrap.appendChild(row);

    if (!collapsed) {
        const children = el('div', 'pf-folder-children');
        let any = false;
        for (const item of orderedChildren(path)) {
            if (item.type === 'folder') {
                children.appendChild(renderFolder(item.key, depth + 1, path));
                any = true;
            } else {
                const p = promptByIdentifier(item.key);
                if (!p || !matchesSearch(p)) continue;
                children.appendChild(renderPromptRow(p, path));
                any = true;
            }
        }
        if (any) wrap.appendChild(children);
    }

    return wrap;
}

/** Thin wrapper around the browser's `prompt()` that returns the trimmed answer, or `null` if
 *  the user cancelled or entered only whitespace — saves every caller from repeating that check. */
export function promptOrNull(msg) {
    const v = prompt(msg);
    return v && v.trim() ? v.trim() : null;
}

/** The tree's single entry point, and the thing almost every action in this extension calls when
 *  it's done mutating something: re-reads the live Prompt Manager DOM into `liveCache`, updates
 *  the status line, rebuilds the whole #pf-tree container from scratch via renderFolder(ROOT),
 *  and finally re-orders the native list to match this extension's folder order
 *  (flattenPromptOrder() + reorderNativeList()). Safe to call even if the dock isn't built yet or
 *  the Prompt Manager isn't currently rendered (shows an explanatory empty-state message instead). */
export function renderTree() {
    if (scheduledRenderTimer !== null) {
        clearTimeout(scheduledRenderTimer);
        scheduledRenderTimer = null;
    }
    const container = document.getElementById('pf-tree');
    const status = document.getElementById('pf-status');
    if (!container) return;

    const live = readLivePrompts();
    if (live === null) {
        container.innerHTML = '';
        container.appendChild(el('div', 'pf-empty-hint', {
            text: 'Prompt Manager not found. Switch to a Chat Completion API and open "AI Response Configuration" at least once, then click Refresh.',
        }));
        if (status) status.textContent = '';
        return;
    }

    liveCache = live;
    const s = settings();
    reconcilePromptDesiredStates(live, s);
    const intendedEnabledCount = live.filter(p => isPromptLogicallyEnabled(p, s)).length;
    const nativeEnabledCount = live.filter(p => p.enabled).length;
    if (status) {
        const activeSuffix = nativeEnabledCount === intendedEnabledCount ? '' : ` · ${nativeEnabledCount} currently active`;
        status.textContent = `${live.length} prompt${live.length === 1 ? '' : 's'} in the current preset · ${intendedEnabledCount} enabled${activeSuffix}.`;
    }

    container.innerHTML = '';
    container.appendChild(renderFolder(ROOT, 0, null));

    // Keep both SillyTavern's underlying active order and its visible native list in sync with
    // what's shown here top-to-bottom. Persisting the data as part of an ordinary render also
    // makes Refresh a durable reconciliation rather than a DOM-only visual repair.
    syncNativePromptOrder(flattenPromptOrder());

    // Re-apply the intended/effective state after structural changes (for example moving a
    // prompt into or out of a muted folder). The explicit native-toggle click watcher updates
    // promptDesired before this path runs for a deliberate click in SillyTavern's original list.
    const mutationInProgress = document.getElementById('pf-dock')?.classList.contains('pf-processing');
    if (!mutationInProgress) {
        const effectiveCorrections = live
            .map(p => ({ identifier: p.identifier, enabled: effectiveNativePromptState(p, s), current: !!p.enabled }))
            .filter(change => change.enabled !== change.current)
            .map(({ identifier, enabled }) => ({ identifier, enabled }));
        if (effectiveCorrections.length > 0) toggleManyWithRetry(effectiveCorrections);
    }
}

// ---------- Bulk enable/disable by content match (XML tag / word / regex) ----------
