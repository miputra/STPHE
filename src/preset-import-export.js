import { el, save, settings } from './state.js';
import { downloadJson, readJsonFile } from './import-export.js';
import { migrateAutoFilter, scheduleAutoFilterEval } from './auto-filter.js';
import { migrateMatchPreset } from './bulk-match.js';

export const IMPORT_MODES = {
    append: { label: 'Import — Append', description: 'Add new items. Keep existing items with the same ID or name.' },
    replace: { label: 'Import — Replace matching', description: 'Update items with the same ID or name and add new items. Keep other items.' },
    clear: { label: 'Import — Clear and import', description: 'Replace this entire list with the items in the file.' },
};
export const PRESET_KEYS = ['matchPresets', 'chatMatchPresets', 'autoFilters'];
const TITLES = { matchPresets: 'Filter presets', chatMatchPresets: 'Chat filter presets', autoFilters: 'Auto Filter rules' };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const nameKey = item => (item.name || '').trim().toLowerCase();

/** ID wins; an unambiguous name is the fallback for exports from another installation. */
export function mergeNamedItems(existing, incoming, mode, idKey = 'id') {
    if (!IMPORT_MODES[mode]) throw new Error('Unknown import mode.');
    const base = mode === 'clear' ? [] : existing;
    const result = structuredClone(base);
    const idMap = {};
    const seen = new Set();
    for (const source of incoming) {
        if (!object(source) || typeof source[idKey] !== 'string' || !source[idKey].trim()
            || typeof source.name !== 'string') throw new Error('Every item needs an ID and a name.');
        if (seen.has(source[idKey])) throw new Error(`Duplicate ID in the file: ${source[idKey]}`);
        seen.add(source[idKey]);
        let index = base.findIndex(item => item[idKey] === source[idKey]);
        if (index < 0 && nameKey(source)) {
            const matches = base.map((item, i) => nameKey(item) === nameKey(source) ? i : -1).filter(i => i >= 0);
            if (matches.length > 1) throw new Error(`More than one item is named "${source.name}". Give them unique names before importing.`);
            index = matches[0] ?? -1;
        }
        const id = index >= 0 ? result[index][idKey] : source[idKey];
        if (Object.values(idMap).includes(id)) throw new Error(`Multiple imported items match "${source.name}".`);
        Object.defineProperty(idMap, source[idKey], { value: id, enumerable: true });
        if (index < 0) result.push(structuredClone(source));
        else if (mode !== 'append') result[index] = { ...structuredClone(source), [idKey]: id };
    }
    return { items: result, idMap };
}

export function validatePresets(key, value) {
    if (!PRESET_KEYS.includes(key) || !Array.isArray(value)) throw new Error(`This file does not contain ${TITLES[key] || 'compatible presets'}.`);
    return value.map(raw => {
        if (!object(raw) || typeof raw.id !== 'string' || !raw.id.trim() || typeof raw.name !== 'string') throw new Error('A preset is missing its ID or name.');
        const item = structuredClone(raw);
        if (item.group !== undefined && typeof item.group !== 'string') throw new Error('A preset group must be text.');
        for (const field of ['enabled', 'locked']) if (item[field] !== undefined && typeof item[field] !== 'boolean') throw new Error(`Invalid ${field} setting.`);
        const match = (spec, type, text, condition = false) => {
            if (!['xml', 'word', 'regex', ...(condition ? [] : key === 'autoFilters' ? ['tag'] : ['tag','regexValues'])].includes(type)) throw new Error(`Unsupported match type in "${item.name}".`);
            if (type === 'xml') {
                if (typeof spec.xmlTag !== 'string' || !spec.xmlTag.trim()) throw new Error(`Missing XML tag in "${item.name}".`);
                if (spec.xmlParams !== undefined && (!Array.isArray(spec.xmlParams) || spec.xmlParams.some(p => !object(p) || typeof p.name !== 'string' || typeof p.value !== 'string'))) throw new Error('Invalid XML parameters.');
            } else {
                if (typeof text !== 'string' || !text.trim()) throw new Error(`Missing match text in "${item.name}".`);
                if (type === 'regex' || type === 'regexValues') { try { new RegExp(text); } catch { throw new Error(`Invalid regular expression in "${item.name}".`); } }
            }
        };
        const checkTarget = target => {
            if (target !== undefined && !['prompt','folder-last','folder-all'].includes(target)) throw new Error(`Invalid target in "${item.name}".`);
        };
        const effect = spec => {
            checkTarget(spec.target);
            if (spec.mode === 'manual') {
                for (const field of ['manualPrompts','manualFolders']) if (spec[field] !== undefined && (!Array.isArray(spec[field]) || spec[field].some(id => typeof id !== 'string'))) throw new Error('Invalid manual selection.');
            } else if (spec.mode === 'match') match(spec, key === 'autoFilters' ? spec.matchType : spec.selMode, spec.text);
            else throw new Error('Invalid effect mode.');
        };
        if (key === 'matchPresets') {
            if (!object(item.params)) throw new Error(`Missing match settings for "${item.name}".`);
            const migrated = migrateMatchPreset(item);
            checkTarget(migrated.target);
            match(migrated.params, migrated.params.type, migrated.params.text);
            if (migrated.scopePath !== undefined && migrated.scopePath !== null && typeof migrated.scopePath !== 'string') throw new Error('Invalid preset scope.');
            return migrated;
        }
        if ((!object(item.condition) || !object(item.effect)) && !(key === 'autoFilters' && typeof item.matchType === 'string')) throw new Error(`Missing condition or effect for "${item.name}".`);
        const migrated = key === 'autoFilters' ? migrateAutoFilter(item) : item;
        if (!Number.isInteger(migrated.condition.depth) || migrated.condition.depth < 0) throw new Error('Invalid chat depth.');
        if (migrated.condition.depth > 0) match(migrated.condition, migrated.condition.matchType, migrated.condition.value, true);
        effect(migrated.effect);
        return migrated;
    });
}

function mergeGroups(current, imported, items, mode) {
    const existingPaths = new Set(current?.folders || []);
    const result = mode === 'clear' ? { folders: [], collapsed: {}, disabled: {} } : structuredClone(current || { folders: [], collapsed: {}, disabled: {} });
    result.folders ??= []; result.collapsed ??= {}; result.disabled ??= {};
    const addPath = path => {
        let parent = '';
        for (const part of path.split('/').filter(Boolean)) {
            parent = parent ? `${parent}/${part}` : part;
            if (!result.folders.includes(parent)) result.folders.push(parent);
        }
    };
    if (imported !== undefined) {
        if (!object(imported) || !Array.isArray(imported.folders) || imported.folders.some(p => typeof p !== 'string')) throw new Error('Invalid preset groups.');
        imported.folders.forEach(addPath);
        for (const field of ['collapsed', 'disabled']) {
            if (imported[field] !== undefined && !object(imported[field])) throw new Error('Invalid preset group state.');
            for (const [path, value] of Object.entries(imported[field] || {})) {
                if (typeof value !== 'boolean') throw new Error('Invalid preset group state.');
                if (mode !== 'append' || (!existingPaths.has(path) && !Object.hasOwn(result[field], path))) Object.defineProperty(result[field], path, {value, enumerable:true, configurable:true, writable:true});
            }
        }
    }
    items.forEach(item => { if (item.group) addPath(item.group); });
    return result;
}

/** Returns a complete draft; validation failures never partially clear a collection. */
export function planPresetImport(s, key, data, mode) {
    const incoming = validatePresets(key, data?.[key]);
    const { items } = mergeNamedItems(s[key] || [], incoming, mode);
    const groups = mergeGroups(s.filterGroups?.[key], data.filterGroups?.[key], items, mode);
    return { items, groups };
}

export function exportPresets(key, item = null) {
    const s = settings();
    const items = item ? [item] : s[key];
    const groups = structuredClone(s.filterGroups?.[key] || { folders: [], collapsed: {}, disabled: {} });
    if (item) {
        const contains = path => item.group === path || item.group?.startsWith(path + '/');
        groups.folders = groups.folders.filter(contains);
        for (const field of ['collapsed', 'disabled']) groups[field] = Object.fromEntries(Object.entries(groups[field] || {}).filter(([path]) => contains(path)));
    }
    const data = { exportedBy: 'prompt-folders', version: 1, [key]: items, filterGroups: { [key]: groups } };
    const name = (item?.name || key).replace(/[^a-z0-9_-]+/gi, '-');
    downloadJson(data, `${name || key}.json`);
}

export function importPresets(key, mode, refresh) {
    readJsonFile(async data => {
        const s = settings();
        const draft = planPresetImport(s, key, data, mode);
        if (!confirm(`${IMPORT_MODES[mode].label}: ${TITLES[key]}\n\n${IMPORT_MODES[mode].description}\nMatches use ID first, then a unique name (ignoring case).\n\nFile: ${data[key].length} item(s). Result: ${draft.items.length} item(s).\nOnly ${TITLES[key].toLowerCase()} and their groups are affected.`)) return;
        s[key] = draft.items;
        s.filterGroups ??= {};
        s.filterGroups[key] = draft.groups;
        save(); refresh();
        if (key === 'autoFilters') scheduleAutoFilterEval(0);
        window.toastr?.success?.(`${TITLES[key]} imported.`);
    });
}

export function addPresetTransferControls(container, key, refresh) {
    const bar = el('div', 'pf-preset-transfer');
    const mode = el('select', 'text_pole', { 'aria-label': `${TITLES[key]} import mode` });
    for (const [value, info] of Object.entries(IMPORT_MODES)) mode.append(el('option', null, { value, text: info.label }));
    const hint = el('small', null, { text: IMPORT_MODES.append.description });
    mode.addEventListener('change', () => { hint.textContent = IMPORT_MODES[mode.value].description; });
    const button = (text, action) => { const b = el('button', 'menu_button', {type:'button',text}); b.addEventListener('click', action); return b; };
    bar.append(mode, button('Import…', () => importPresets(key, mode.value, refresh)), button('Export all…', () => exportPresets(key)), hint);
    container.append(bar);
}

export function presetExportButton(key, item) {
    const button = el('button', 'pf-icon-btn fa-solid fa-file-export', {type:'button',title:`Export ${item.name || 'preset'}`, 'aria-label':`Export ${item.name || 'preset'}`});
    button.addEventListener('click', event => { event.stopPropagation(); exportPresets(key, item); });
    return button;
}
