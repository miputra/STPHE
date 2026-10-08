import { IMPORT_MODES, PRESET_KEYS, mergeNamedItems, planPresetImport } from './preset-import-export.js';
import { mergeFolderStructure, normalizePromptImport, readJsonFile } from './import-export.js';
import { findPromptOrderEntry, forceNativeRerender, getOaiModule } from './native.js';
import { renderTree } from './render.js';
import { save, settings } from './state.js';
import { scheduleAutoFilterEval } from './auto-filter.js';

const MAP_FIELDS = ['assignments', 'order', 'collapsed', 'folderDisabled', 'folderSnapshot', 'promptDesired', 'excludedPrompts', 'excludedFolders', 'excludedAutoPrompts', 'excludedAutoFolders'];
const PROMPT_MAPS = ['assignments', 'promptTags', 'promptDesired', 'excludedPrompts', 'excludedAutoPrompts'];
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

function validateData(data) {
    if (!isObject(data) || !['folders', 'assignments', 'prompts', 'prompt_order'].some(key => Object.hasOwn(data, key))) throw new Error('Choose a prompt list or STPHE folder backup.');
    for (const key of [...MAP_FIELDS, 'promptTags']) if (data[key] !== undefined && !isObject(data[key])) throw new Error(`Invalid ${key} in the file.`);
    if (data.folders !== undefined && (!Array.isArray(data.folders) || data.folders.some(p => typeof p !== 'string'))) throw new Error('Invalid folder list.');
    if (data.prompts !== undefined && (!Array.isArray(data.prompts) || data.prompts.some(p => !isObject(p) || typeof p.identifier !== 'string' || !p.identifier.trim() || typeof p.name !== 'string' || (p.content !== undefined && typeof p.content !== 'string')))) throw new Error('Invalid prompt definitions.');
    if (data.prompt_order !== undefined && (!Array.isArray(data.prompt_order) || data.prompt_order.length > 1 || data.prompt_order.some(p => !isObject(p) || !Array.isArray(p.order) || p.order.some(e => !isObject(e) || typeof e.identifier !== 'string' || !e.identifier.trim() || (e.enabled !== undefined && typeof e.enabled !== 'boolean'))))) throw new Error('Choose an export containing one prompt list with valid entries.');
    if (Object.values(data.assignments || {}).some(p => typeof p !== 'string')) throw new Error('Invalid folder assignments.');
    if (Object.values(data.promptTags || {}).some(tags => !Array.isArray(tags) || tags.some(tag => typeof tag !== 'string'))) throw new Error('Invalid prompt tags.');
    for (const key of ['collapsed','folderDisabled','promptDesired','excludedPrompts','excludedFolders','excludedAutoPrompts','excludedAutoFolders']) {
        if (Object.values(data[key] || {}).some(value => typeof value !== 'boolean')) throw new Error(`Invalid ${key} state.`);
    }
    for (const entries of Object.values(data.order || {})) if (!Array.isArray(entries) || entries.some(e => !isObject(e) || !['folder','prompt'].includes(e.type) || typeof e.key !== 'string')) throw new Error('Invalid folder ordering.');
}

/** Build everything against clones before any settings or native prompt data is changed. */
export function planPromptListImport(current, definitions, activeOrder, input, mode) {
    if (!IMPORT_MODES[mode]) throw new Error('Unknown import mode.');
    input = normalizePromptImport(input);
    validateData(input);
    const data = structuredClone(input);
    const s = structuredClone(current);
    const hasPrompts = data.prompts !== undefined || data.prompt_order !== undefined;
    if (hasPrompts && (!Array.isArray(definitions) || !Array.isArray(activeOrder))) throw new Error('Open AI Response Configuration and select a prompt preset before importing. Nothing was changed.');
    // Clearing a list unlists entries; definitions remain available in other lists/presets.
    const merged = mergeNamedItems(definitions || [], data.prompts || [], mode === 'append' ? 'append' : 'replace', 'identifier');
    const remap = id => Object.hasOwn(merged.idMap, id) ? merged.idMap[id] : id;
    for (const key of PROMPT_MAPS) if (data[key]) data[key] = Object.fromEntries(Object.entries(data[key]).map(([id,value]) => [remap(id),value]));
    for (const entries of Object.values(data.order || {})) for (const entry of entries) if (entry.type === 'prompt') entry.key = remap(entry.key);
    for (const [path, snapshot] of Object.entries(data.folderSnapshot || {})) {
        if (!isObject(snapshot)) throw new Error('Invalid folder snapshot.');
        data.folderSnapshot[path] = Object.fromEntries(Object.entries(snapshot).map(([id,value]) => [remap(id),value]));
    }
    for (const key of PRESET_KEYS) if (Array.isArray(data[key])) for (const item of data[key]) {
        if (Array.isArray(item?.effect?.manualPrompts)) item.effect.manualPrompts = item.effect.manualPrompts.map(remap);
    }
    const importedOrder = (data.prompt_order?.[0]?.order ?? (data.prompts || []).map(p => ({identifier:p.identifier,enabled:true}))).map(entry => ({...entry,identifier:remap(entry.identifier)}));
    if (new Set(importedOrder.map(e => e.identifier)).size !== importedOrder.length) throw new Error('The imported list contains duplicate prompt entries.');
    if (importedOrder.some(entry => !merged.items.some(p => p.identifier === entry.identifier))) throw new Error('The file refers to prompts whose definitions are missing. Import a backup that includes those prompts.');
    const order = mode === 'clear' && hasPrompts ? [] : structuredClone(activeOrder || []);
    for (const entry of importedOrder) {
        const index = order.findIndex(e => e.identifier === entry.identifier);
        if (index < 0) order.push(entry);
        else if (mode !== 'append') order[index] = entry;
    }
    if (mode === 'clear') {
        s.folders = [];
        for (const key of MAP_FIELDS) s[key] = {};
        // Tags on reusable definitions outside the new list remain available.
    }
    const folderData = {...data};
    for (const key of PRESET_KEYS) delete folderData[key];
    delete folderData.filterGroups;
    if (mode === 'append') {
        const existingIds = new Set((activeOrder || []).map(entry => entry.identifier));
        for (const key of PROMPT_MAPS) if (folderData[key]) folderData[key] = Object.fromEntries(Object.entries(folderData[key]).filter(([id]) => !existingIds.has(id)));
        for (const key of ['collapsed','folderDisabled','folderSnapshot','excludedFolders','excludedAutoFolders']) if (folderData[key]) {
            folderData[key] = Object.fromEntries(Object.entries(folderData[key]).filter(([path]) => !current.folders.includes(path)));
        }
    }
    mergeFolderStructure(s, folderData);
    if (mode !== 'append') {
        for (const key of [...MAP_FIELDS, 'promptTags']) if (data[key]) s[key] = {...s[key], ...data[key]};
    }
    for (const key of PRESET_KEYS) if (Object.hasOwn(data, key)) {
        const draft = planPresetImport(s, key, data, mode);
        s[key] = draft.items;
        s.filterGroups ??= {};
        s.filterGroups[key] = draft.groups;
    }
    if (mode !== 'append') for (const key of ['autoFilterDisabled','autoFilterOnSendClick','autoFilterOnGenerationDone']) {
        if (typeof data[key] === 'boolean') s[key] = data[key];
    }
    // New/updated entries must agree with the extension's intended-state map.
    for (const entry of importedOrder) if (mode !== 'append' || !Object.hasOwn(current.promptDesired || {}, entry.identifier)) {
        const previous = mode === 'append' && activeOrder?.find(item => item.identifier === entry.identifier);
        s.promptDesired[entry.identifier] = previous ? previous.enabled !== false : data.promptDesired?.[entry.identifier] ?? (entry.enabled !== false);
    }
    // Ensure folders referenced by a native or partial export are visible in the tree.
    for (const path of Object.values(s.assignments)) {
        let parent = '';
        for (const part of path.split('/').filter(Boolean)) { parent = parent ? `${parent}/${part}` : part; if (!s.folders.includes(parent)) s.folders.push(parent); }
    }
    return { settings:s, definitions:merged.items, order, hasPrompts, importedCount:importedOrder.length };
}

export function importPromptList(mode) {
    readJsonFile(async data => {
        const mod = await getOaiModule();
        const oai = mod?.oai_settings;
        const orderEntry = oai ? findPromptOrderEntry(oai) : null;
        const s = settings();
        const draft = planPromptListImport(s, oai?.prompts, orderEntry?.order, data, mode);
        const clearText = mode === 'clear' ? '\nThe current prompt list and folder organization will be cleared. Reusable prompt definitions remain available; other lists are kept.' : '';
        const filters = PRESET_KEYS.filter(key => Object.hasOwn(data, key));
        if (!confirm(`${IMPORT_MODES[mode].label}: prompt list\n\n${IMPORT_MODES[mode].description}${clearText}\nMatches use ID first, then a unique name (ignoring case).\n${draft.hasPrompts ? `Result: ${draft.order.length} prompt(s) in the current list.` : 'This file contains folder organization only.'}\n${filters.length ? 'Filter collections included in this backup use the same import mode.' : 'Saved filter collections are kept.'}`)) return;
        Object.assign(s, draft.settings);
        if (draft.hasPrompts) { oai.prompts = draft.definitions; orderEntry.order = draft.order; }
        save();
        if (draft.hasPrompts) await mod.promptManager?.saveServiceSettings?.();
        await forceNativeRerender(renderTree);
        scheduleAutoFilterEval(0);
        window.toastr?.success?.(`Import complete: ${IMPORT_MODES[mode].label.toLowerCase()}.`);
    });
}
