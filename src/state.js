// Prompt Folders — organizes Chat Completion "pinned" prompts (Prompt Manager entries)
// into folders/subfolders (each with its own on/off toggle at every depth), with
// drag-and-drop reordering of both prompts and folders, add/delete/rename, and
// independent view (read-only) / edit (native) actions — all from a resizable panel
// pinned to the edge of the screen.
//
// DESIGN NOTE: this extension does not reimplement SillyTavern's prompt-saving logic.
// It reads the live Prompt Manager list ST already renders (#completion_prompt_manager_list)
// and drives the matching native controls (toggle, edit popup, footer new/delete buttons)
// so saving, validation, token budgeting and preset persistence all stay exactly as
// SillyTavern intends. Because of that, every native lookup goes through the SELECTORS
// table below — if a future ST update renames a class, this is the one place to fix it.

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';

import { migrateAutoFilter } from './auto-filter.js';
import { migrateMatchPreset } from './bulk-match.js';
import { promptsInFolder } from './render.js';

const MODULE = 'prompt_folders';
export const ROOT = ''; // root/"Unfiled" path

// ---------- Centralized selectors for native SillyTavern DOM (see design note above) ----------
export const SELECTORS = {
    responsePanel: '#left-nav-panel',
    responsePanelToggle: '#leftNavDrawerIcon',
    promptList: '#completion_prompt_manager_list',
    promptItem: 'li[data-pm-identifier], li.completion_prompt_manager_prompt',
    promptName: '.prompt_manager_prompt_name_text, .completion_prompt_manager_prompt_name, .prompt-manager-name',
    toggleAction: '.prompt-manager-toggle-action, [class*="toggle-action"], .fa-toggle-on, .fa-toggle-off',
    editAction: '.prompt-manager-edit-action, [class*="edit-action"], .fa-pencil, .fa-pen, .fa-pen-to-square',
    footer: '[class$="prompt_manager_footer"]',
    footerSelect: 'select[id$="prompt_manager_footer_append_prompt"], select',
    footerInsertBtn: '[title="Insert prompt" i], [title*="insert prompt" i]',
    footerNewBtn: '[title="New prompt" i], [title*="new prompt" i], .fa-plus-square, .fa-square-plus',
    footerDeleteBtn: '[title="Delete prompt" i], .fa-x',
    footerImportBtn: '[title*="import" i]',
    footerExportBtn: '[title*="export" i]',
    footerResetBtn: '[title*="reset" i]',
    popupContainers: ['dialog[open]', '.popup_wrapper', '#shadow_popup', '.popup'],
    popupNameInput: 'input[id*="name" i], input[name*="name" i], input[type="text"]',
    popupCloseBtn: '.popup-button-close, [title="Close" i], [title="Cancel" i]',
    popupSaveBtn: '.fa-save, .fa-floppy-disk, [title="Save" i], [title*="save prompt" i], [title*="save changes" i]',
    sendButton: '#send_but, [title="Send a message" i], [title="Send message" i]',
    abortButton: '#mes_stop, [title*="abort request" i], [title*="stop generation" i]',
};

const DEFAULT_SETTINGS = {
    version: 7,
    filterGroups: {},
    folders: [],        // explicit list of folder paths, e.g. ["Jailbreak", "Jailbreak/NSFW"]
    assignments: {},     // { promptIdentifier: "Folder/Sub" }
    order: {},            // { parentPath: [{type:'folder'|'prompt', key}, ...] } manual sibling order
    collapsed: {},          // { "Folder/Sub": true }
    folderDisabled: {},      // { "Folder/Sub": true } — folder-level "master off" flag
    folderSnapshot: {},       // legacy/export mirror of intended states captured when a folder mutes
    promptDesired: {},         // { promptIdentifier: boolean } — the prompt's visible/intended
                               // state, independent of temporary native folder-mute suppression
    excludedPrompts: {},       // { promptIdentifier: true } — excluded from Enable/disable-by-match
    excludedFolders: {},        // { "Folder/Sub": true } — excludes the folder AND everything inside it
    excludedAutoPrompts: {},     // { promptIdentifier: true } — excluded from Auto Filter ONLY, fully
                                  // independent of excludedPrompts (manual filter/presets still see it)
    excludedAutoFolders: {},      // { "Folder/Sub": true } — excludes the folder AND everything inside it
                                    // from Auto Filter ONLY, independent of excludedFolders
    autoFilters: [],           // [{ id, name, enabled, condition:{matchType,value,depth}, effect:{...} }] — see "Auto Filter"
    autoFilterDisabled: false,  // master kill switch for the whole Auto Filter system
    autoFilterOnSendClick: false, // re-evaluate the instant the send icon is clicked, before the
                                    // message is processed — off by default; see the warning next
                                    // to its checkbox in the modal for why
    autoFilterOnGenerationDone: true, // re-evaluate once generation finishes or is aborted (the
                                        // abort icon reverting back to the send icon)
    matchPresets: [],            // [{ id, name, locked, scopePath, params, target }] — see "Filter presets"
    chatMatchPresets: [],         // [{ id, name, locked, scopePath, condition, effect }] — see "Chat filter presets"
                                    // (bulk-match.js's "Match against: Chat" flow, saved condition + select-prompts-to-affect spec)
    ui: {
        side: 'right',        // 'left' | 'right'
        top: 90,               // px from top of viewport
        width: 360,
        height: 600,
        open: true,             // false = minimized (hidden, restore button shown)
    },
};

/** Returns this extension's settings object (from SillyTavern's global `extension_settings`),
 *  creating it from DEFAULT_SETTINGS on first use and backfilling any fields a saved settings
 *  blob from an older version of this extension might be missing. Always call this instead of
 *  reading `extension_settings[MODULE]` directly, so every read sees a fully-shaped object. */
export function settings() {
    if (!extension_settings[MODULE]) {
        extension_settings[MODULE] = structuredClone(DEFAULT_SETTINGS);
    }
    const s = extension_settings[MODULE];
    if (!Number.isFinite(s.version) || s.version < DEFAULT_SETTINGS.version) s.version = DEFAULT_SETTINGS.version;
    if (!Array.isArray(s.folders)) s.folders = [];
    if (typeof s.assignments !== 'object' || !s.assignments) s.assignments = {};
    if (typeof s.order !== 'object' || !s.order) s.order = {};
    if (typeof s.collapsed !== 'object' || !s.collapsed) s.collapsed = {};
    if (typeof s.folderDisabled !== 'object' || !s.folderDisabled) s.folderDisabled = {};
    if (typeof s.folderSnapshot !== 'object' || !s.folderSnapshot) s.folderSnapshot = {};
    if (typeof s.promptDesired !== 'object' || !s.promptDesired) s.promptDesired = {};
    if (typeof s.excludedPrompts !== 'object' || !s.excludedPrompts) s.excludedPrompts = {};
    if (typeof s.excludedFolders !== 'object' || !s.excludedFolders) s.excludedFolders = {};
    if (typeof s.excludedAutoPrompts !== 'object' || !s.excludedAutoPrompts) s.excludedAutoPrompts = {};
    if (typeof s.excludedAutoFolders !== 'object' || !s.excludedAutoFolders) s.excludedAutoFolders = {};
    if (!s.filterGroups || typeof s.filterGroups !== 'object') s.filterGroups = {};
    if (!Array.isArray(s.autoFilters)) s.autoFilters = [];
    if (typeof s.autoFilterDisabled !== 'boolean') s.autoFilterDisabled = false;
    if (typeof s.autoFilterOnSendClick !== 'boolean') s.autoFilterOnSendClick = false;
    if (typeof s.autoFilterOnGenerationDone !== 'boolean') s.autoFilterOnGenerationDone = true;
    s.autoFilters = s.autoFilters.map(migrateAutoFilter);
    if (!Array.isArray(s.matchPresets)) s.matchPresets = [];
    s.matchPresets = s.matchPresets.map(migrateMatchPreset);
    if (!Array.isArray(s.chatMatchPresets)) s.chatMatchPresets = [];
    if (typeof s.ui !== 'object' || !s.ui) s.ui = structuredClone(DEFAULT_SETTINGS.ui);
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS.ui)) {
        if (s.ui[k] === undefined) s.ui[k] = v;
    }
    return s;
}

/** Persists the current settings object via SillyTavern's own debounced save — call this after
 *  any mutation to `settings()`'s return value. */
export function save() {
    saveSettingsDebounced();
}

/** Shows a red/error toast via SillyTavern's global `toastr`, if it's available. */
export function toastError(msg) { window.toastr?.error?.(msg); }
/** Shows a yellow/warning toast via SillyTavern's global `toastr`, if it's available. */
export function toastWarn(msg) { window.toastr?.warning?.(msg); }

/** HTML-escapes a string by round-tripping it through a detached element's textContent. Use
 *  whenever user-supplied text (a prompt or folder name, etc.) is interpolated into an HTML
 *  template string, to avoid injecting markup. */
export function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
}

/** Small `document.createElement` convenience: creates `tag`, optionally sets its class, and
 *  applies `attrs` (an object of attribute name -> value; the special key `text` sets
 *  `textContent` instead of an actual attribute). Returns the new element. */
export function el(tag, cls, attrs) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
        if (k === 'text') e.textContent = v;
        else e.setAttribute(k, v);
    }
    return e;
}

// ---------- Folder path helpers ----------

/** Returns the path of `path`'s parent folder, or ROOT if `path` is a top-level folder, or
 *  `null` if `path` is already ROOT (i.e. has no parent). Folder paths are '/'-joined, e.g.
 *  "Jailbreak/NSFW" has parent "Jailbreak". */
export function parentOf(path) {
    if (!path) return null;
    const idx = path.lastIndexOf('/');
    return idx === -1 ? ROOT : path.slice(0, idx);
}

/** Returns just the last path segment of `path` (its display name), or "Unfiled" for ROOT. */
export function nameOf(path) {
    if (!path) return 'Unfiled';
    const idx = path.lastIndexOf('/');
    return idx === -1 ? path : path.slice(idx + 1);
}

/** Joins a parent folder path and a child folder name into a single path string. */
export function joinPath(parent, name) {
    return parent ? `${parent}/${name}` : name;
}

/** Returns the folder paths that are direct children of `path`, alphabetically sorted by name. */
function directChildFolders(path) {
    const s = settings();
    return s.folders
        .filter(f => parentOf(f) === path)
        .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
}

/** True if `path` is `ancestor` itself, or nested anywhere underneath it. Used to guard against
 *  e.g. moving/dropping a folder into one of its own descendants. */
export function isDescendantOrSelf(path, ancestor) {
    return path === ancestor || path.startsWith(ancestor + '/');
}

// ---------- Manual sibling ordering ----------

/** Returns (creating if needed) the sparse manual-order array stored for `parentPath`'s direct
 *  children. "Sparse" because it only needs to record items that have actually been dragged into
 *  a specific position — see orderedChildren() for how this is merged with default ordering. */
function getOrderArray(parentPath) {
    const s = settings();
    if (!s.order[parentPath]) s.order[parentPath] = [];
    return s.order[parentPath];
}

/** Inserts `entry` ({type, key}) into `parentPath`'s manual order array, positioned immediately
 *  before `beforeEntry` or immediately after `afterEntry` (at most one of the two should be
 *  given); appends to the end if neither anchor is found. Removes any prior occurrence of `entry`
 *  in that array first, so re-inserting an already-ordered item moves it rather than duplicating it. */
function insertIntoOrder(parentPath, entry, beforeEntry, afterEntry) {
    // Anchors (beforeEntry/afterEntry) are almost always items that have never been manually
    // reordered before, so they usually aren't in the sparse order array yet. Materialize the
    // full current visual order first so anchor lookups actually find them, instead of silently
    // falling back to "insert at the end of whatever's in the sparse array" (which is the bug
    // that made drops always land near the same early position).
    materializeOrder(parentPath);
    const arr = getOrderArray(parentPath);
    const existingIdx = arr.findIndex(e => e.type === entry.type && e.key === entry.key);
    if (existingIdx !== -1) arr.splice(existingIdx, 1);
    let insertAt = arr.length;
    if (beforeEntry) {
        const idx = arr.findIndex(e => e.type === beforeEntry.type && e.key === beforeEntry.key);
        insertAt = idx === -1 ? arr.length : idx;
    } else if (afterEntry) {
        const idx = arr.findIndex(e => e.type === afterEntry.type && e.key === afterEntry.key);
        insertAt = idx === -1 ? arr.length : idx + 1;
    }
    arr.splice(insertAt, 0, entry);
}

/** Writes the full current effective child order (sparse manual order + all remaining
 *  default-order items) back into settings, so it's no longer sparse. */
function materializeOrder(parentPath) {
    const s = settings();
    s.order[parentPath] = orderedChildren(parentPath);
}

/** Removes `entry` from every parent's order list, then inserts it into `parentPath`'s list. */
export function moveEntryInOrder(entry, parentPath, beforeEntry = null, afterEntry = null) {
    const s = settings();
    for (const key of Object.keys(s.order)) {
        if (key === parentPath) continue;
        s.order[key] = s.order[key].filter(e => !(e.type === entry.type && e.key === entry.key));
    }
    insertIntoOrder(parentPath, entry, beforeEntry, afterEntry);
}

/** Returns the full, effective, ordered list of `path`'s direct children — folders and prompts
 *  mixed together as `{type, key}` entries — by taking whatever's recorded in the sparse manual
 *  order array first (skipping stale entries that no longer exist), then appending any remaining
 *  folders/prompts that aren't in the manual order yet. This is the single source of truth for
 *  "what order does this folder's contents render in". */
export function orderedChildren(path) {
    const s = settings();
    const folderKeys = directChildFolders(path);
    const promptItems = promptsInFolder(path);
    const orderArr = s.order[path] || [];
    const seen = new Set();
    const result = [];
    for (const entry of orderArr) {
        if (entry.type === 'folder' && folderKeys.includes(entry.key) && !seen.has('f:' + entry.key)) {
            result.push({ type: 'folder', key: entry.key });
            seen.add('f:' + entry.key);
        } else if (entry.type === 'prompt' && promptItems.some(p => p.identifier === entry.key) && !seen.has('p:' + entry.key)) {
            result.push({ type: 'prompt', key: entry.key });
            seen.add('p:' + entry.key);
        }
    }
    for (const f of folderKeys) if (!seen.has('f:' + f)) result.push({ type: 'folder', key: f });
    for (const p of promptItems) if (!seen.has('p:' + p.identifier)) result.push({ type: 'prompt', key: p.identifier });
    return result;
}

/** Flattens the whole folder tree into a single top-to-bottom list of prompt identifiers —
 *  folders are just organizational, so this is what "the order" means for the native list. */
export function flattenPromptOrder(path = ROOT) {
    const result = [];
    for (const item of orderedChildren(path)) {
        if (item.type === 'folder') result.push(...flattenPromptOrder(item.key));
        else result.push(item.key);
    }
    return result;
}

/** Rewrites every reference to `oldPath` (and its descendants) to `newPath` across all settings. */
export function rewritePathEverywhere(oldPath, newPath) {
    const s = settings();
    const remap = p => (p === oldPath ? newPath : p.startsWith(oldPath + '/') ? newPath + p.slice(oldPath.length) : p);

    s.folders = s.folders.map(remap);

    for (const [id, p] of Object.entries(s.assignments)) {
        if (p === oldPath || (p && p.startsWith(oldPath + '/'))) s.assignments[id] = remap(p);
    }

    const newCollapsed = {};
    for (const [p, v] of Object.entries(s.collapsed)) newCollapsed[remap(p)] = v;
    s.collapsed = newCollapsed;

    const newFolderDisabled = {};
    for (const [p, v] of Object.entries(s.folderDisabled)) newFolderDisabled[remap(p)] = v;
    s.folderDisabled = newFolderDisabled;

    const newFolderSnapshot = {};
    for (const [p, v] of Object.entries(s.folderSnapshot)) newFolderSnapshot[remap(p)] = v;
    s.folderSnapshot = newFolderSnapshot;

    const newExcludedFolders = {};
    for (const [p, v] of Object.entries(s.excludedFolders)) newExcludedFolders[remap(p)] = v;
    s.excludedFolders = newExcludedFolders;

    const newExcludedAutoFolders = {};
    for (const [p, v] of Object.entries(s.excludedAutoFolders)) newExcludedAutoFolders[remap(p)] = v;
    s.excludedAutoFolders = newExcludedAutoFolders;

    const newOrder = {};
    for (const [parentKey, arr] of Object.entries(s.order)) {
        const newParentKey = remap(parentKey);
        newOrder[newParentKey] = arr.map(e => (e.type === 'folder' ? { type: 'folder', key: remap(e.key) } : e));
    }
    s.order = newOrder;
}
