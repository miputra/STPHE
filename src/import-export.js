import { closeOwnOverlays, directCreatePrompt, findPromptOrderEntry, forceNativeRerender, getOaiModule, peekContent } from './native.js';
import { liveCache, renderTree } from './render.js';
import { ROOT, el, escapeHtml, isDescendantOrSelf, joinPath, moveEntryInOrder, parentOf, save, settings, toastError, toastWarn } from './state.js';

// ---------- Import / export (this extension's own folder structure only — not the prompts
// themselves, except for a best-effort snapshot bundled in for round-tripping deleted prompts;
// driven by the dock's Export/Import buttons, not SillyTavern's own prompt-manager export
// footer). Lets you back up or transfer your folders/assignments/order between presets or
// installs. ----------

/** Small `document.createElement('a')` + Blob download, shared by every "export ... as JSON"
 *  action in this file (whole structure, one folder, or one prompt). */
function downloadJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Filesystem-safe-ish filename fragment: lowercased, non-alphanumerics collapsed to single
 *  hyphens, leading/trailing hyphens trimmed. Falls back to "untitled" for an empty result. */
function slugify(text) {
    return (text || 'untitled').toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
}

/** Every real folder "containing" `path` (its ancestors) plus `path` itself, ROOT excluded
 *  (ROOT is never stored in s.folders) — e.g. "A/B/C" → ["A", "A/B", "A/B/C"]. Used by
 *  exportFolder()/exportPrompt() so a nested folder's export recreates its full parent chain on
 *  re-import, instead of landing as an orphaned path with no visible parent to render under. */
function folderChain(path) {
    if (!path) return [];
    const parts = path.split('/');
    const chain = [];
    let cur = '';
    for (const part of parts) { cur = cur ? `${cur}/${part}` : part; chain.push(cur); }
    return chain;
}

/** Downloads this extension's folder structure (folders, assignments, manual order, collapsed
 *  state, filter/auto-filter exclusions) as a timestamped JSON file. Also best-effort bundles a
 *  snapshot of the real SillyTavern `prompts` / `prompt_order` data (see restorePromptsFromImport)
 *  so that re-importing this file later can recreate a prompt that's since been deleted, not just
 *  reference an identifier that no longer exists. */
export async function exportFolderStructure() {
    const s = settings();
    const data = {
        exportedBy: 'prompt-folders',
        exportedAt: new Date().toISOString(),
        filterGroups: s.filterGroups,
        matchPresets: s.matchPresets,
        chatMatchPresets: s.chatMatchPresets,
        autoFilters: s.autoFilters,
        autoFilterDisabled: s.autoFilterDisabled,
        autoFilterOnSendClick: s.autoFilterOnSendClick,
        autoFilterOnGenerationDone: s.autoFilterOnGenerationDone,
        folders: s.folders,
        assignments: s.assignments,
        order: s.order,
        collapsed: s.collapsed,
        folderDisabled: s.folderDisabled,
        folderSnapshot: s.folderSnapshot,
        promptDesired: s.promptDesired,
        excludedPrompts: s.excludedPrompts,
        excludedFolders: s.excludedFolders,
        excludedAutoPrompts: s.excludedAutoPrompts,
        excludedAutoFolders: s.excludedAutoFolders,
    };

    // Best-effort: also bundle a snapshot of the real prompt definitions + active order for this
    // character, under SillyTavern's own `prompts` / `prompt_order` field names. This does two
    // things: (1) it lets a future re-import through THIS panel actually recreate a prompt that's
    // since been deleted natively, rather than just pointing at an identifier that's gone (see
    // restorePromptsFromImport below) — the thing "the import doesn't bring it back" was about;
    // (2) keeping those field names matching what SillyTavern's own export uses means this file
    // isn't exclusively tied to this extension. Best-effort because it relies on the same
    // unconfirmed direct-settings access used elsewhere in this file (getOaiModule) — if that's
    // not available, the export still proceeds with just the folder structure.
    try {
        const mod = await getOaiModule();
        const oai = mod?.oai_settings;
        if (Array.isArray(oai?.prompts)) {
            const orderEntry = findPromptOrderEntry(oai);
            const keepIds = new Set([
                ...liveCache.map(p => p.identifier),
                ...((orderEntry?.order || []).map(o => o?.identifier)),
            ]);
            data.prompts = oai.prompts.filter(p => p && keepIds.has(p.identifier));
            if (orderEntry) data.prompt_order = [{ character_id: orderEntry.character_id, order: orderEntry.order }];
        }
    } catch { /* best-effort only — folder structure export still proceeds without it */ }

    downloadJson(data, `prompt-folders-${new Date().toISOString().slice(0, 10)}.json`);
}

/** Downloads just one folder's structure — itself, every subfolder, and the prompts assigned
 *  anywhere inside it — as a timestamped JSON file. Same shape and same best-effort prompt-data
 *  bundling as exportFolderStructure() above, just scoped to this subtree, so it can be shared or
 *  re-imported on its own. Includes the folder's own ancestor chain (folderChain) too, so
 *  importing it elsewhere doesn't leave it pointing at parent folders that don't exist there.
 *  Not offered for ROOT ("📥 Unfiled") — see the folder context menu in render.js. */
export async function exportFolder(path) {
    const s = settings();
    const subtree = s.folders.filter(f => isDescendantOrSelf(f, path));
    const folderSet = new Set([...folderChain(path), ...subtree]);

    const data = {
        exportedBy: 'prompt-folders',
        exportedAt: new Date().toISOString(),
        folders: [...folderSet],
        assignments: {},
        order: {},
        collapsed: {},
        folderDisabled: {},
        folderSnapshot: {},
        promptDesired: {},
        excludedPrompts: {},
        excludedFolders: {},
        excludedAutoPrompts: {},
        excludedAutoFolders: {},
    };

    for (const [id, p] of Object.entries(s.assignments)) if (isDescendantOrSelf(p, path)) data.assignments[id] = p;
    for (const [k, v] of Object.entries(s.collapsed)) if (folderSet.has(k)) data.collapsed[k] = v;
    for (const [k, v] of Object.entries(s.folderDisabled)) if (folderSet.has(k)) data.folderDisabled[k] = v;
    for (const [k, v] of Object.entries(s.folderSnapshot)) if (folderSet.has(k)) data.folderSnapshot[k] = v;
    for (const [k, v] of Object.entries(s.excludedFolders)) if (folderSet.has(k)) data.excludedFolders[k] = v;
    for (const [k, v] of Object.entries(s.excludedAutoFolders)) if (folderSet.has(k)) data.excludedAutoFolders[k] = v;
    for (const [id, v] of Object.entries(s.excludedPrompts)) if (isDescendantOrSelf(s.assignments[id] || ROOT, path)) data.excludedPrompts[id] = v;
    for (const [id, v] of Object.entries(s.excludedAutoPrompts)) if (isDescendantOrSelf(s.assignments[id] || ROOT, path)) data.excludedAutoPrompts[id] = v;
    for (const [id, v] of Object.entries(s.promptDesired)) if (isDescendantOrSelf(s.assignments[id] || ROOT, path)) data.promptDesired[id] = v;
    for (const [parentPath, arr] of Object.entries(s.order)) if (folderSet.has(parentPath)) data.order[parentPath] = arr;

    try {
        const mod = await getOaiModule();
        const oai = mod?.oai_settings;
        if (Array.isArray(oai?.prompts)) {
            const orderEntry = findPromptOrderEntry(oai);
            const keepIds = new Set(liveCache.filter(p => isDescendantOrSelf(s.assignments[p.identifier] || ROOT, path)).map(p => p.identifier));
            data.prompts = oai.prompts.filter(p => p && keepIds.has(p.identifier));
            if (orderEntry) data.prompt_order = [{ character_id: orderEntry.character_id, order: orderEntry.order.filter(o => keepIds.has(o?.identifier)) }];
        }
    } catch { /* best-effort only — folder export still proceeds without it */ }

    downloadJson(data, `prompt-folders-${slugify(path.split('/').pop())}-${new Date().toISOString().slice(0, 10)}.json`);
}

/** Downloads a single prompt's data as a timestamped JSON file — its definition, via direct
 *  settings access first, falling back to peekContent() (briefly opening the native editor, same
 *  as View/Preview) if that's not available on this version, plus its entry in the active order
 *  if found. If it's currently in a non-root folder here, that folder's chain is bundled too, so
 *  importing this file back through this extension's own Import puts it right back where it was
 *  instead of landing unfiled. */
export async function exportPrompt(identifier, fallbackName) {
    const s = settings();
    const data = { exportedBy: 'prompt-folders', exportedAt: new Date().toISOString() };
    let name = fallbackName;

    try {
        const mod = await getOaiModule();
        const oai = mod?.oai_settings;
        const def = Array.isArray(oai?.prompts) ? oai.prompts.find(p => p && p.identifier === identifier) : null;
        if (def) {
            data.prompts = [{ ...def }];
            name = def.name || name;
            const orderEntry = findPromptOrderEntry(oai);
            const orderItem = orderEntry?.order?.find(o => o?.identifier === identifier);
            if (orderEntry && orderItem) data.prompt_order = [{ character_id: orderEntry.character_id, order: [{ ...orderItem }] }];
        }
    } catch { /* fall through to the peekContent fallback below */ }

    if (!data.prompts) {
        const peeked = await peekContent(identifier);
        if (!peeked) { toastError('Could not read this prompt to export it.'); return; }
        name = peeked.name || name;
        data.prompts = [{ identifier, name, content: peeked.content ?? '' }];
    }

    const path = s.assignments[identifier];
    if (Object.prototype.hasOwnProperty.call(s.promptDesired, identifier)) {
        data.promptDesired = { [identifier]: !!s.promptDesired[identifier] };
    }
    if (path) {
        data.folders = folderChain(path);
        data.assignments = { [identifier]: path };
    }

    downloadJson(data, `prompt-${slugify(name || identifier)}-${new Date().toISOString().slice(0, 10)}.json`);
}

/** Finds every "the same prompt, essentially" collision between what's being imported and what's
 *  already here: an imported prompt whose NAME matches an existing prompt's name, but whose
 *  content differs — regardless of whether their identifiers happen to match too, since
 *  re-importing an old backup of a prompt you've since edited is exactly this case. Identical
 *  name+content pairs are not conflicts (already covered by the plain dedup below) — only
 *  genuinely different content needs a person to decide what to do about it. */
function findNameConflicts(existingPrompts, importedPrompts) {
    const conflicts = [];
    for (const ip of importedPrompts) {
        if (!ip || !ip.identifier || typeof ip.name !== 'string') continue;
        const existing = existingPrompts.find(p => p && p.name === ip.name);
        if (!existing) continue;
        if ((existing.content ?? '') === (ip.content ?? '')) continue;
        conflicts.push({ existing, imported: ip });
    }
    return conflicts;
}

/** Picks a name not already in `existingNames` by appending " (2)", " (3)", ... — the "keep both"
 *  conflict resolution's renaming rule. */
function nameWithSuffix(baseName, existingNames) {
    if (!existingNames.has(baseName)) return baseName;
    let n = 2;
    while (existingNames.has(`${baseName} (${n})`)) n++;
    return `${baseName} (${n})`;
}

/** Makes sure every segment of folder path `path` exists in this extension's own folder list,
 *  creating any missing ones — same idea as renderMoveSelect's "New folder…" path creation in
 *  render.js, used here so a conflict resolution that assigns a prompt to the imported file's
 *  folder never points at a path that doesn't actually exist yet. */
function ensureFolderChainExists(path) {
    if (!path) return;
    const s = settings();
    let acc = '';
    for (const part of path.split('/')) {
        acc = acc ? `${acc}/${part}` : part;
        if (!s.folders.includes(acc)) s.folders.push(acc);
    }
}

/** Removes `identifier`'s definition from oai.prompts and every reference to it across every
 *  character's active order (not just the current one) — the same reach as native "Delete prompt
 *  entirely". Used by the "delete previous" conflict resolution. */
function removeIdentifierEverywhere(oai, identifier) {
    const pi = oai.prompts.findIndex(p => p && p.identifier === identifier);
    if (pi !== -1) oai.prompts.splice(pi, 1);
    if (Array.isArray(oai.prompt_order)) {
        for (const entry of oai.prompt_order) {
            if (!Array.isArray(entry?.order)) continue;
            const oi = entry.order.findIndex(o => o?.identifier === identifier);
            if (oi !== -1) entry.order.splice(oi, 1);
        }
    }
}

/** Applies one person-chosen resolution to one name/content conflict (see findNameConflicts):
 *   - 'keep-previous': does nothing — the existing prompt is left exactly as it is, the imported
 *     one is dropped.
 *   - 'delete-previous': deletes the existing prompt entirely (definition + every order
 *     reference), then adds the imported one fresh, under its own identifier.
 *   - 'replace-keep-folder' / 'replace-new-folder': in-place edit — the imported content/name
 *     replace the existing prompt's own, but its identifier (and so its position in the active
 *     list, and anything else here that references that identifier — exclusions, Auto Filter
 *     rules) stays exactly as it is. The two differ only in which folder placement wins:
 *     'replace-keep-folder' touches this extension's assignment for it not at all;
 *     'replace-new-folder' updates it to match the imported file's folder for that prompt (if
 *     the file recorded one).
 *   - 'keep-both': adds the imported one as a new, separate prompt (a freshly generated
 *     identifier if its own would collide), named via nameWithSuffix() to avoid an ambiguous
 *     duplicate name. The existing prompt is untouched. */
function applyConflictResolution(oai, orderEntry, conflict, resolution, importedAssignments) {
    const s = settings();
    const existingId = conflict.existing.identifier;
    const importedId = conflict.imported.identifier;
    const importedFolder = importedAssignments ? importedAssignments[importedId] : undefined;

    if (resolution === 'keep-previous') return;

    if (resolution === 'delete-previous') {
        removeIdentifierEverywhere(oai, existingId);
        delete s.assignments[existingId];
        delete s.excludedPrompts[existingId];
        delete s.excludedAutoPrompts[existingId];
        oai.prompts.push({ ...conflict.imported });
        if (orderEntry && !orderEntry.order.some(o => o?.identifier === importedId)) orderEntry.order.push({ identifier: importedId, enabled: true });
        if (importedFolder) { ensureFolderChainExists(importedFolder); s.assignments[importedId] = importedFolder; }
        return;
    }

    if (resolution === 'replace-keep-folder' || resolution === 'replace-new-folder') {
        const idx = oai.prompts.findIndex(p => p && p.identifier === existingId);
        if (idx !== -1) oai.prompts[idx] = { ...conflict.imported, identifier: existingId };
        if (resolution === 'replace-new-folder' && importedFolder !== undefined) {
            if (importedFolder) { ensureFolderChainExists(importedFolder); s.assignments[existingId] = importedFolder; }
            else delete s.assignments[existingId];
        }
        return;
    }

    if (resolution === 'keep-both') {
        const existingNames = new Set(oai.prompts.map(p => p?.name || ''));
        const newName = nameWithSuffix(conflict.imported.name, existingNames);
        const idCollides = oai.prompts.some(p => p?.identifier === importedId);
        const newId = idCollides
            ? ((typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `pf-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`)
            : importedId;
        oai.prompts.push({ ...conflict.imported, identifier: newId, name: newName });
        if (orderEntry) orderEntry.order.push({ identifier: newId, enabled: true });
        if (importedFolder) { ensureFolderChainExists(importedFolder); s.assignments[newId] = importedFolder; }
    }
}

const CONFLICT_RESOLUTION_OPTIONS = [
    { value: 'keep-previous', label: 'Keep the previous one (skip this import)' },
    { value: 'delete-previous', label: 'Delete the previous one, keep the imported one' },
    { value: 'replace-keep-folder', label: 'Replace previous — keep its current folder' },
    { value: 'replace-new-folder', label: 'Replace previous — use the folder from the imported file' },
    { value: 'keep-both', label: 'Keep both (imported one renamed "Name (2)")' },
];

/** Removes the "same-named prompts differ" resolution modal, if it's open. */
export function closeImportConflictsModal() {
    document.getElementById('pf-ic-overlay')?.remove();
}

/** Simple whitespace-split word count, for the per-conflict "X words vs Y words" hint below. */
function wordCountLocal(text) {
    const t = (text || '').trim();
    return t ? t.split(/\s+/).length : 0;
}

/** Opens the per-conflict resolution modal — one row per findNameConflicts() result, each with
 *  its own CONFLICT_RESOLUTION_OPTIONS `<select>` (defaulting to the least destructive "keep the
 *  previous one, skip this import" — so declining to decide changes nothing), plus a summary of
 *  how many other genuinely-new prompts from the file will be added as usual. A single Apply
 *  button runs every chosen resolution (applyConflictResolution) and the plain missing-defs/
 *  missing-order additions together, then saves and re-renders once. */
function openImportConflictsModal({ conflicts, missingDefs, missingOrder, importedAssignments, oai, orderEntry }) {
    closeOwnOverlays();

    const overlay = el('div', 'pf-view-overlay');
    overlay.id = 'pf-ic-overlay';
    overlay.innerHTML = `
        <div class="pf-view-modal pf-bm-modal" style="width:min(640px, 94vw)">
            <div class="pf-view-header">
                <span class="fa-solid fa-code-compare"></span>
                <b>Import: same-named prompts differ</b>
                <span class="pf-icon-btn fa-solid fa-xmark" id="pf-ic-close" title="Close"></span>
            </div>
            <div class="pf-bm-scope">${conflicts.length} prompt${conflicts.length === 1 ? '' : 's'} in this file share a name with one already here, but the content is different. Pick what to do with each — nothing else in this file is affected by these choices.</div>
            <div class="pf-bm-body" style="max-height:60vh; overflow-y:auto" id="pf-ic-list"></div>
            <div class="pf-view-footer">
                <span class="pf-view-hint">${missingDefs.length} other new prompt${missingDefs.length === 1 ? '' : 's'} from this file will be added as usual.</span>
                <div class="menu_button" id="pf-ic-apply"><i class="fa-solid fa-check"></i>&nbsp;Apply</div>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    document.getElementById('pf-ic-close').addEventListener('click', closeImportConflictsModal);
    overlay.addEventListener('click', ev => { if (ev.target === overlay) closeImportConflictsModal(); });

    const list = document.getElementById('pf-ic-list');
    conflicts.forEach((c, i) => {
        const row = el('div', 'pf-full-section');
        row.innerHTML = `
            <div class="pf-full-section-header"><b>${escapeHtml(c.existing.name || '(unnamed)')}</b></div>
            <div class="pf-bm-row" style="font-size:0.85em; opacity:0.75">Previous: ${wordCountLocal(c.existing.content)} words · Imported: ${wordCountLocal(c.imported.content)} words</div>
            <div class="pf-bm-row">
                <select class="text_pole pf-ic-choice" data-idx="${i}">
                    ${CONFLICT_RESOLUTION_OPTIONS.map(o => `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join('')}
                </select>
            </div>`;
        list.appendChild(row);
    });

    document.getElementById('pf-ic-apply').addEventListener('click', () => {
        const selects = list.querySelectorAll('.pf-ic-choice');
        const counts = { replaced: 0, deleted: 0, keptBoth: 0, kept: 0 };
        selects.forEach(sel => {
            const idx = Number(sel.dataset.idx);
            const resolution = sel.value;
            applyConflictResolution(oai, orderEntry, conflicts[idx], resolution, importedAssignments);
            if (resolution === 'keep-previous') counts.kept++;
            else if (resolution === 'delete-previous') counts.deleted++;
            else if (resolution === 'keep-both') counts.keptBoth++;
            else counts.replaced++;
        });
        for (const def of missingDefs) oai.prompts.push({ ...def });
        if (orderEntry) for (const io of missingOrder) orderEntry.order.push({ ...io });
        save();
        closeImportConflictsModal();
        forceNativeRerender(() => {
            renderTree();
            window.toastr?.success?.(`Import applied: ${counts.replaced} replaced, ${counts.deleted} deleted+replaced, ${counts.keptBoth} kept as new copies, ${counts.kept} left as-is, ${missingDefs.length} added new.`);
        });
    });
}

/** The counterpart to the `prompts` / `prompt_order` snapshot exportFolderStructure bundles in
 *  (and, incidentally, compatible with a genuine native SillyTavern "Export this prompt list"
 *  file too, since both use those same field names): adds back whichever prompt definitions
 *  and/or active-list order entries from the imported file are missing from the current preset,
 *  without touching or duplicating anything already present. This is what makes "a prompt I
 *  deleted comes back when I import a list that references it" actually true, rather than the
 *  import only being able to point at an identifier that no longer exists.
 *
 *  Separately, any imported prompt that shares a NAME with one already here but has different
 *  content (findNameConflicts) is never silently auto-added or auto-skipped — it's handed to
 *  openImportConflictsModal() so a person picks what happens to it, one at a time.
 *
 *  Same speculative-but-fails-clearly footing as directCreatePrompt/unlistPromptFlow: direct
 *  settings access, confirmed before touching anything, silently no-ops if nothing is missing. */
export async function restorePromptsFromImport(data) {
    const importedPrompts = Array.isArray(data.prompts) ? data.prompts : [];
    const importedOrderEntry = Array.isArray(data.prompt_order) ? data.prompt_order[0] : null;
    const importedOrder = Array.isArray(importedOrderEntry?.order) ? importedOrderEntry.order : [];
    if (importedPrompts.length === 0 && importedOrder.length === 0) return;

    const mod = await getOaiModule();
    const oai = mod?.oai_settings;
    if (!Array.isArray(oai?.prompts)) {
        toastWarn('This file also has prompt data, but I couldn\'t access SillyTavern\'s prompt settings directly on this version, so any deleted prompts it references were not restored.');
        return;
    }

    const conflicts = findNameConflicts(oai.prompts, importedPrompts);
    const conflictIds = new Set(conflicts.map(c => c.imported.identifier));

    const missingDefs = importedPrompts.filter(ip => ip?.identifier && !conflictIds.has(ip.identifier) && !oai.prompts.some(p => p?.identifier === ip.identifier));
    const orderEntry = findPromptOrderEntry(oai);
    const missingOrder = (orderEntry
        ? importedOrder.filter(io => io?.identifier && !orderEntry.order.some(o => o?.identifier === io.identifier))
        : importedOrder
    ).filter(io => !conflictIds.has(io?.identifier));

    if (conflicts.length > 0) {
        openImportConflictsModal({ conflicts, missingDefs, missingOrder, importedAssignments: data.assignments, oai, orderEntry });
        return;
    }

    if (missingDefs.length === 0 && missingOrder.length === 0) return;

    const proceed = confirm(
        `This file also has prompt data: ${missingDefs.length} prompt definition(s) and ${missingOrder.length} ` +
        `list entr${missingOrder.length === 1 ? 'y' : 'ies'} from it aren't in your current preset/list. ` +
        `Restore them? (Nothing already present is touched or duplicated.)`
    );
    if (!proceed) return;

    for (const def of missingDefs) oai.prompts.push({ ...def });
    if (orderEntry) {
        for (const io of missingOrder) orderEntry.order.push({ ...io });
    } else if (missingOrder.length > 0) {
        toastWarn('Restored prompt definitions where possible, but couldn\'t confidently find where your active prompt list is stored, so nothing was re-added to the list itself — use "Insert prompt" in AI Response Configuration.');
    }
    save();
    forceNativeRerender(() => {
        renderTree();
        window.toastr?.success?.(`Restored ${missingDefs.length} prompt(s).`);
    });
}

/** Merges `data`'s folder structure into the current settings, purely additively: new folders are
 *  appended (skipping any path that already exists), assignment/collapsed/exclusion maps only
 *  fill in keys that don't already have a value here (an imported value NEVER overwrites one you
 *  already have — see the note on fillMissing below), and manual sibling order arrays are merged
 *  per-folder, appending any imported entry not already present rather than replacing the array
 *  outright. Nothing already in your settings is removed, touched, or reassigned. */
function mergeFolderStructure(s, data) {
    for (const key of ['matchPresets', 'chatMatchPresets', 'autoFilters']) {
        if (!Array.isArray(data[key])) continue;
        const ids = new Set(s[key].map(item => item.id));
        for (const item of data[key]) if (item?.id && !ids.has(item.id)) { s[key].push(item); ids.add(item.id); }
    }
    if (data.filterGroups && typeof data.filterGroups === 'object') {
        s.filterGroups ??= {};
        for (const key of ['matchPresets', 'chatMatchPresets', 'autoFilters']) {
            const imported = data.filterGroups[key];
            if (!Array.isArray(imported?.folders)) continue;
            const local = s.filterGroups[key] ??= { folders: [], collapsed: {}, disabled: {} };
            local.folders = [...new Set([...local.folders, ...imported.folders.filter(p => typeof p === 'string')])];
            for (const field of ['collapsed', 'disabled']) {
                for (const [path, value] of Object.entries(imported[field] || {})) {
                    if (!Object.hasOwn(local[field], path)) local[field][path] = !!value;
                }
            }
        }
    }

    if (Array.isArray(data.folders)) {
        const existing = new Set(s.folders);
        for (const f of data.folders) {
            if (typeof f === 'string' && !existing.has(f)) { s.folders.push(f); existing.add(f); }
        }
    }

    // Genuinely additive: only fills in a key that ISN'T already present in `target` — an
    // imported assignment/exclusion for a prompt or folder you've already organized here never
    // overwrites what you already have. (This is the fix for "Import (append) was destroying my
    // current folder structure" — it used to be an unconditional Object.assign, so importing an
    // old backup, or someone else's shared structure, could silently move prompts you'd since
    // reorganized back to wherever that other file had them — especially bad for SillyTavern's
    // fixed-identifier standard prompts, which every export references by the same IDs.)
    const fillMissing = (target, source) => {
        if (!source || typeof source !== 'object') return;
        for (const [k, v] of Object.entries(source)) if (!(k in target)) target[k] = v;
    };
    fillMissing(s.assignments, data.assignments);
    fillMissing(s.collapsed, data.collapsed);
    fillMissing(s.folderDisabled, data.folderDisabled);
    fillMissing(s.folderSnapshot, data.folderSnapshot);
    fillMissing(s.promptDesired, data.promptDesired);
    fillMissing(s.excludedPrompts, data.excludedPrompts);
    fillMissing(s.excludedFolders, data.excludedFolders);
    fillMissing(s.excludedAutoPrompts, data.excludedAutoPrompts);
    fillMissing(s.excludedAutoFolders, data.excludedAutoFolders);

    if (data.order && typeof data.order === 'object') {
        for (const [parentPath, importedArr] of Object.entries(data.order)) {
            if (!Array.isArray(importedArr)) continue;
            const existingArr = s.order[parentPath] || (s.order[parentPath] = []);
            const seen = new Set(existingArr.map(e => `${e?.type}:${e?.key}`));
            for (const entry of importedArr) {
                const id = `${entry?.type}:${entry?.key}`;
                if (entry && !seen.has(id)) { existingArr.push(entry); seen.add(id); }
            }
        }
    }
}

/** Opens a native file picker for a `.json` export, reads and validates it, and hands the parsed
 *  data + whether it looks like it has folder-structure and/or prompt data to `onFolderData` /
 *  restorePromptsFromImport(). Shared by both importFolderStructure() (replace) and
 *  importFolderStructureMerge() (merge) below — they differ only in how they apply folder data. */
function pickAndReadImportFile(onFolderData) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.hidden = true;
    document.body.appendChild(input);
    input.addEventListener('cancel', () => input.remove(), { once: true });
    input.addEventListener('change', () => {
        const file = input.files?.[0];
        input.remove();
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            let data;
            try {
                data = JSON.parse(String(reader.result));
            } catch {
                toastError('Could not import: that file isn\'t valid JSON.');
                return;
            }
            const hasFolderData = data && typeof data === 'object'
                && (Array.isArray(data.folders) || (data.assignments && typeof data.assignments === 'object'));
            const hasPromptData = data && typeof data === 'object'
                && (Array.isArray(data.prompts) || Array.isArray(data.prompt_order));
            if (!hasFolderData && !hasPromptData) {
                toastError('Could not import: this doesn\'t look like a STPHE export, or a compatible prompt list export.');
                return;
            }

            if (hasFolderData) onFolderData(data);
            if (hasPromptData) restorePromptsFromImport(data);
        };
        reader.readAsText(file);
    });
    input.click();
}

/** Opens a native file picker for a `.json` export, then — after confirming with the user —
 *  replaces this extension's folder structure with whatever's in the file (folders, assignments,
 *  order, collapsed state, exclusions) and/or hands any bundled prompt data off to
 *  restorePromptsFromImport(). Accepts both this extension's own exports and, for the prompt-data
 *  half, a genuine native SillyTavern prompt-list export (same `prompts`/`prompt_order` fields).
 *  See importFolderStructureMerge() for the additive counterpart that keeps your existing folders
 *  instead of discarding them. */
export function importFolderStructure() {
    pickAndReadImportFile(data => {
        const proceed = confirm(
            'Import the folder structure from this file? This REPLACES your current folders, prompt ' +
            'assignments, order, and collapsed state in this extension. It does not touch your actual ' +
            'prompts on its own — only how they\'re organized here.'
        );
        if (!proceed) return;
        const s = settings();
        if (Array.isArray(data.folders)) s.folders = data.folders;
        if (data.assignments && typeof data.assignments === 'object') s.assignments = data.assignments;
        if (data.order && typeof data.order === 'object') s.order = data.order;
        if (data.collapsed && typeof data.collapsed === 'object') s.collapsed = data.collapsed;
        if (data.folderDisabled && typeof data.folderDisabled === 'object') s.folderDisabled = data.folderDisabled;
        if (data.folderSnapshot && typeof data.folderSnapshot === 'object') s.folderSnapshot = data.folderSnapshot;
        if (data.promptDesired && typeof data.promptDesired === 'object') s.promptDesired = data.promptDesired;
        if (data.excludedPrompts && typeof data.excludedPrompts === 'object') s.excludedPrompts = data.excludedPrompts;
        if (data.excludedFolders && typeof data.excludedFolders === 'object') s.excludedFolders = data.excludedFolders;
        if (data.excludedAutoPrompts && typeof data.excludedAutoPrompts === 'object') s.excludedAutoPrompts = data.excludedAutoPrompts;
        if (data.excludedAutoFolders && typeof data.excludedAutoFolders === 'object') s.excludedAutoFolders = data.excludedAutoFolders;
        for (const key of ['matchPresets', 'chatMatchPresets', 'autoFilters']) {
            if (Array.isArray(data[key])) s[key] = data[key];
        }
        if (data.filterGroups && typeof data.filterGroups === 'object') s.filterGroups = data.filterGroups;
        for (const key of ['autoFilterDisabled', 'autoFilterOnSendClick', 'autoFilterOnGenerationDone']) {
            if (typeof data[key] === 'boolean') s[key] = data[key];
        }
        save();
        renderTree();
        window.toastr?.success?.('Folder structure imported (replaced).');
    });
}

/** The additive counterpart to importFolderStructure(): instead of discarding your current
 *  folders/assignments/order, merges the imported file into them via mergeFolderStructure() — new
 *  folders are added, imported assignments/exclusions win on a conflict, and nothing you already
 *  had is removed. Prompt-data restoration (restorePromptsFromImport) works exactly the same as
 *  the replace flow either way, since it's already additive-only by nature. This is the "global"
 *  merge — it always lands at the top of your structure; importFolderStructureAppendAfter() below
 *  is the row-scoped version that lands alongside a chosen folder/prompt instead. */
export function importFolderStructureMerge() {
    pickAndReadImportFile(data => {
        const proceed = confirm(
            'Import append the folder structure from this file? This ADDS to your current folders, prompt ' +
            'assignments, order, and collapsed state in this extension — for the whole tree, not just one ' +
            'folder. Nothing already here is ever touched, removed, or overwritten — an imported folder/prompt ' +
            'only fills in where you don\'t already have one organized. It does not touch your actual prompts ' +
            'on its own — only how they\'re organized here.'
        );
        if (!proceed) return;
        mergeFolderStructure(settings(), data);
        save();
        renderTree();
        window.toastr?.success?.('Folder structure imported (append).');
    });
}

/** Rewrites every folder path in a freshly-parsed import `data` object so that whatever was
 *  top-level ("Unfiled") in the file becomes nested under `parentPath` instead — used by
 *  importFolderStructureAppendAfter() below so an "import append after this folder" lands its
 *  content alongside that folder rather than always at the very top of your structure. Returns a
 *  shallow-remapped copy; `data` itself is never mutated. Pass `null` for `parentPath` to mean
 *  "root — don't remap anything" (used when the anchor itself lives at the top level). */
function remapImportDataToParent(data, parentPath) {
    if (!parentPath) return data;
    const remap = p => p ? joinPath(parentPath, p) : parentPath;
    const out = { ...data };
    if (Array.isArray(data.folders)) out.folders = data.folders.map(remap);
    if (data.assignments && typeof data.assignments === 'object') {
        out.assignments = {};
        for (const [id, p] of Object.entries(data.assignments)) out.assignments[id] = remap(p || ROOT);
    }
    if (data.collapsed && typeof data.collapsed === 'object') {
        out.collapsed = {};
        for (const [k, v] of Object.entries(data.collapsed)) out.collapsed[remap(k)] = v;
    }
    if (data.folderDisabled && typeof data.folderDisabled === 'object') {
        out.folderDisabled = {};
        for (const [k, v] of Object.entries(data.folderDisabled)) out.folderDisabled[remap(k)] = v;
    }
    if (data.folderSnapshot && typeof data.folderSnapshot === 'object') {
        out.folderSnapshot = {};
        for (const [k, v] of Object.entries(data.folderSnapshot)) out.folderSnapshot[remap(k)] = v;
    }
    if (data.excludedFolders && typeof data.excludedFolders === 'object') {
        out.excludedFolders = {};
        for (const [k, v] of Object.entries(data.excludedFolders)) out.excludedFolders[remap(k)] = v;
    }
    if (data.excludedAutoFolders && typeof data.excludedAutoFolders === 'object') {
        out.excludedAutoFolders = {};
        for (const [k, v] of Object.entries(data.excludedAutoFolders)) out.excludedAutoFolders[remap(k)] = v;
    }
    if (data.order && typeof data.order === 'object') {
        out.order = {};
        for (const [parentKey, arr] of Object.entries(data.order)) {
            out.order[remap(parentKey)] = Array.isArray(arr)
                ? arr.map(e => (e && e.type === 'folder' ? { type: 'folder', key: remap(e.key) } : e))
                : arr;
        }
    }
    return out;
}

/** "Import append after this folder/prompt" — a row's ⋮ menu action reachable from both a folder
 *  row and a prompt row (see render.js). Same additive guarantee as importFolderStructureMerge()
 *  above (nothing already here is ever touched, removed, or overwritten), but instead of always
 *  landing at the very top of your structure, the file's top-level folders/prompts are filed
 *  alongside `anchorEntry` — nested under the same parent it lives in — and positioned as siblings
 *  right after it, in the order they appeared in the file. `anchorLabel` is just for the
 *  confirmation dialog's wording (the caller already has the display name to hand). */
export function importFolderStructureAppendAfter(anchorEntry, parentPath, anchorLabel) {
    pickAndReadImportFile(data => {
        const proceed = confirm(
            `Import append this file's folders/prompts, placed right after "${anchorLabel}"? This ADDS to your ` +
            'current folders — nothing already here is ever touched, removed, or overwritten — and the file\'s ' +
            `top-level folders/prompts are filed alongside "${anchorLabel}" and positioned right after it. It ` +
            'does not touch your actual prompts on its own — only how they\'re organized here.'
        );
        if (!proceed) return;

        // Figure out which folders/prompts were top-level ("Unfiled") in the FILE, before any
        // remapping — those are exactly the items that should end up positioned after the anchor;
        // anything already nested in the file keeps its place underneath them, just relocated.
        const topFolders = Array.isArray(data.folders) ? data.folders.filter(f => typeof f === 'string' && parentOf(f) === ROOT) : [];
        const topPromptIds = data.assignments && typeof data.assignments === 'object'
            ? Object.entries(data.assignments).filter(([, p]) => !p).map(([id]) => id)
            : [];

        const remapKey = f => (parentPath ? joinPath(parentPath, f) : f);
        const remapped = remapImportDataToParent(data, parentPath || null);
        mergeFolderStructure(settings(), remapped);

        let afterEntry = anchorEntry;
        for (const f of topFolders) {
            const key = remapKey(f);
            moveEntryInOrder({ type: 'folder', key }, parentPath, null, afterEntry);
            afterEntry = { type: 'folder', key };
        }
        for (const id of topPromptIds) {
            if (!liveCache.some(p => p.identifier === id)) continue; // wasn't actually restored/present
            moveEntryInOrder({ type: 'prompt', key: id }, parentPath, null, afterEntry);
            afterEntry = { type: 'prompt', key: id };
        }

        save();
        renderTree();
        window.toastr?.success?.(`Imported and placed after "${anchorLabel}".`);
    });
}
