import { buildFilterGroups, isFilterGroupDisabled } from './filter-groups.js';
// ---------- Bulk enable/disable by content match (XML tag / word / regex) ----------
//
import { AUTO_MATCH_TYPES, autoMatchDef, evaluateAutoCondition } from './auto-filter.js';
import { closeOwnOverlays, lockTextareaReadOnly, peekContent } from './native.js';
import { liveCache, setFolderMaster, setPromptsLogicalState, toggleFolderMaster } from './render.js';
import { ROOT, el, escapeHtml, isDescendantOrSelf, save, settings } from './state.js';

// Reachable two ways, both opening the same modal with a different scope:
//   - the toolbar's filter button — scope is every live prompt, everywhere.
//   - a folder's ⋮ menu — scope is that folder plus its subfolders (the same "affected" set
//     toggleFolderMaster/setFolderMaster already use), so matches and any "apply to folder"
//     action stay confined to what the user right-clicked.
// Matching itself reads content via peekContent() per prompt — the same direct-settings-first,
// briefly-open-the-native-editor-as fallback already used by View and Full Preview — so a scan
// across many prompts on a version without direct access takes a moment, exactly like Preview.

// Legacy tag names from the old fixed Character/Location/Time system — kept only so
// migrateAutoFilter() (in auto-filter.js) and migrateMatchPreset() (below) can degrade old saved
// rules/presets into something reasonable under the new free-form system; never used by any
// current UI.
export const LEGACY_XML_TAGS = { character: 'char_slc', location: 'loc_slc', time: 'time_slc' };

function escapeRegexLiteral(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Parses every occurrence of an XML-ish opening tag `<tagName ...>` (self-closing or not) found
 *  in `content`, returning one plain `{ attrName: attrValue }` object per occurrence — e.g.
 *  `<char name="Alice" type="hero">` yields `{ name: 'Alice', type: 'hero' }`. A tag with no
 *  attributes at all (`<char>`) still counts as an occurrence, just with an empty attrs object —
 *  it can be matched by "the tag itself" but obviously by no parameter. The `(?=[\s/>])`
 *  lookahead after the tag name keeps `char` from also matching `<character>`. Attribute values
 *  may be double- or single-quoted. */
export function parseXmlTagOccurrences(content, tagName) {
    if (!content || !tagName) return [];
    const tagRe = new RegExp(`<${escapeRegexLiteral(tagName)}(?=[\\s/>])([^>]*)>`, 'gi');
    const attrRe = /([^\s=/"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    const occurrences = [];
    let m;
    while ((m = tagRe.exec(content)) !== null) {
        const attrs = {};
        let am;
        attrRe.lastIndex = 0;
        while ((am = attrRe.exec(m[1] || '')) !== null) {
            attrs[am[1]] = am[2] !== undefined ? am[2] : am[3];
        }
        occurrences.push(attrs);
    }
    return occurrences;
}

/** True if `content` contains at least one occurrence of XML tag `tagName` at all, regardless of
 *  attributes — the "tag itself, no parameters checked" match case. */
export function hasXmlTagName(content, tagName) {
    if (!content || !tagName) return false;
    return new RegExp(`<${escapeRegexLiteral(tagName)}(?=[\\s/>])[^>]*>`, 'i').test(content);
}

/** The core "does this prompt's content match this XML tag spec" test, shared by computeMatches
 *  (Prompt content matching) and Auto Filter's effect evaluation, so both apply identical
 *  semantics. `xmlParams` is an array of `{ name, value }` — `value === '__ALL__'` (or falsy)
 *  means "this attribute must be present, any value"; any other value means an exact
 *  (case-insensitive) match against that attribute's value. With no active params at all, this
 *  is just "does the tag occur here" (hasXmlTagName). With one or more params, a prompt matches
 *  if ANY single occurrence of the tag satisfies EVERY checked param at once — params on the
 *  same `<tag ...>` occurrence are ANDed together, since they describe one real thing (e.g. one
 *  character), not independent conditions. */
export function xmlContentMatches(content, tagName, xmlParams) {
    if (!tagName) return false;
    const activeParams = (xmlParams || []).filter(p => p && p.name);
    if (activeParams.length === 0) return hasXmlTagName(content, tagName);
    const occurrences = parseXmlTagOccurrences(content, tagName);
    return occurrences.some(attrs => activeParams.every(p => {
        const val = attrs[p.name];
        if (val === undefined) return false;
        if (!p.value || p.value === '__ALL__') return true;
        return val.toLowerCase() === p.value.toLowerCase();
    }));
}

/** Upgrades a saved filter preset's `params` from the old fixed Character/Location/Time system
 *  to the new free-form XML tag system, same degrade rules as migrateLegacyCondition/Effect in
 *  auto-filter.js (see that file's comment for why an exact re-interpretation isn't possible):
 *  "All X" (any occurrence of the tag) carries over exactly; "Specific X: value" degrades to a
 *  plain Word search for that value text. Presets of any other type pass through untouched. */
export function migrateMatchPreset(preset) {
    const p = preset?.params;
    if (!p || p.type !== 'xml' || p.xmlTag !== undefined) return preset; // already current-shape, or not xml
    const tagKeyMap = { character: 'character', char: 'character', location: 'location', loc: 'location', time: 'time' };
    const tagKey = tagKeyMap[p.xmlType] || p.xmlType;
    const tag = LEGACY_XML_TAGS[tagKey];
    if (!tag) return preset;
    if (!p.xmlValue || p.xmlValue === '__ALL__') {
        return { ...preset, params: { type: 'xml', xmlTag: tag, xmlParams: [] } };
    }
    return { ...preset, params: { type: 'word', text: p.xmlValue, caseSensitive: false } };
}

/** A prompt is excluded from every Enable/disable-by-match filter (manual Apply, saved presets,
 *  and Auto Filter alike) if it's individually marked excluded, OR if it (or any ancestor
 *  folder it lives in) has been marked excluded — excluding a folder always covers everything
 *  inside it, including subfolders. This is the one choke point every match-scanning function
 *  below goes through, so marking something excluded here is enough to keep it out of all of
 *  them without touching each filter feature individually. */
function isExcludedFromFilter(identifier) {
    const s = settings();
    if (s.excludedPrompts[identifier]) return true;
    const path = s.assignments[identifier] || ROOT;
    for (const anc of ancestorChain(path)) {
        if (s.excludedFolders[anc]) return true;
    }
    return false;
}

/** Folder-only counterpart of isExcludedFromFilter, for checking a folder path itself (e.g. a
 *  manually hand-picked folder target in a Chat filter preset's effect) rather than a prompt's
 *  containing chain. Mirrors isFolderExcludedFromAutoFilter below, but against the manual
 *  filter's own excludedFolders set. */
function isFolderExcludedFromFilterPath(path) {
    const s = settings();
    for (const anc of ancestorChain(path || ROOT)) {
        if (s.excludedFolders[anc]) return true;
    }
    return false;
}

/** Auto Filter's own exclusion, completely independent from isExcludedFromFilter above: marking
 *  a prompt/folder excluded from the manual Enable/disable-by-match filter (and its saved
 *  presets) has NO effect here, and marking one excluded from Auto Filter here has no effect on
 *  the manual filter — each system only ever reads its own exclusion settings (excludedPrompts/
 *  excludedFolders vs excludedAutoPrompts/excludedAutoFolders), so a prompt can be "filter-
 *  excluded but auto-locked", "auto-excluded but filter-visible", both, or neither, in any
 *  combination. */
export function isExcludedFromAutoFilter(identifier) {
    const s = settings();
    if (s.excludedAutoPrompts[identifier]) return true;
    const path = s.assignments[identifier] || ROOT;
    for (const anc of ancestorChain(path)) {
        if (s.excludedAutoFolders[anc]) return true;
    }
    return false;
}

/** Folder-only counterpart of isExcludedFromAutoFilter, for checking a folder path itself (e.g. a
 *  manually hand-picked folder target in an Auto Filter rule's effect) rather than a prompt's
 *  containing chain. */
export function isFolderExcludedFromAutoFilter(path) {
    const s = settings();
    for (const anc of ancestorChain(path || ROOT)) {
        if (s.excludedAutoFolders[anc]) return true;
    }
    return false;
}

/** `scopePath === null` (the toolbar entry point) means every live prompt, full stop. A real
 *  folder path (including ROOT for "Unfiled" specifically) scopes to that folder plus its
 *  subfolders — identical to what toggleFolderMaster/setFolderMaster treat as "affected".
 *  `mode` picks which exclusion set applies: 'filter' (default) is the manual Enable/disable-by-
 *  match filter & its saved presets, using isExcludedFromFilter; 'auto' is Auto Filter, using the
 *  fully independent isExcludedFromAutoFilter — see the note on that function above. Either way,
 *  anything marked excluded from the relevant system never enters the scope in the first place,
 *  so it can never be matched or toggled by it. */
function promptsInScope(scopePath, mode = 'filter') {
    const s = settings();
    const base = scopePath === null
        ? liveCache.slice()
        : liveCache.filter(p => isDescendantOrSelf(s.assignments[p.identifier] || ROOT, scopePath));
    const isExcluded = mode === 'auto' ? isExcludedFromAutoFilter : isExcludedFromFilter;
    return base.filter(p => !isExcluded(p.identifier));
}

/** Scans every prompt in scope for tag `tagName`'s occurrences and returns a `Map` of every
 *  attribute (parameter) name found → the deduplicated `Set` of values seen for it — this is
 *  what feeds a tag's dynamic "Parameters" checklist once a tag name is scanned, and (via
 *  xmlAllKnownValues below) what Auto Filter's condition side checks recent chat text against. */
export async function collectXmlParams(scopePath, tagName, mode = 'filter') {
    const paramMap = new Map();
    if (!tagName) return paramMap;
    for (const p of promptsInScope(scopePath, mode)) {
        const peeked = await peekContent(p.identifier);
        for (const attrs of parseXmlTagOccurrences(peeked?.content, tagName)) {
            for (const [k, v] of Object.entries(attrs)) {
                if (!v) continue;
                if (!paramMap.has(k)) paramMap.set(k, new Set());
                paramMap.get(k).add(v);
            }
        }
    }
    return paramMap;
}

/** Runs the actual filter — Apply — over every prompt in scope, one at a time (see the file
 *  header note on peekContent's cost). `params.type` is 'xml' | 'word' | 'regex'; for 'xml',
 *  for `type === 'xml'`, matching is delegated to xmlContentMatches() — see its header comment
 *  for the tag/parameter semantics. Returns `{ matched }` or `{ error }`. */
export async function computeMatches(scopePath, params, onProgress, mode = 'filter') {
    let re = null;
    if (params.type === 'regex') {
        try { re = new RegExp(params.text, 'i'); } catch { return { error: 'bad-regex' }; }
    }
    const wordCaseSensitive = params.type === 'word' && !!params.caseSensitive;
    const word = params.type === 'word' ? (wordCaseSensitive ? params.text.trim() : params.text.trim().toLowerCase()) : null;

    const scope = promptsInScope(scopePath, mode);
    const matched = [];
    for (let i = 0; i < scope.length; i++) {
        const p = scope[i];
        onProgress?.(i + 1, scope.length);
        const peeked = await peekContent(p.identifier);
        const content = peeked?.content || '';
        let isMatch = false;
        if (params.type === 'xml') {
            isMatch = xmlContentMatches(content, params.xmlTag, params.xmlParams);
        } else if (word !== null) {
            isMatch = (wordCaseSensitive ? content : content.toLowerCase()).includes(word);
        } else if (re) {
            isMatch = re.test(content);
        }
        if (isMatch) matched.push(p);
    }
    return { matched };
}

/** Builds a self-contained "XML tag + dynamic parameters" picker inside `container` (an already-
 *  existing, empty DOM node in a modal's markup) and wires up its scan/checklist behavior. Every
 *  xml-matching UI in the extension — the Prompt content form, the Chat "select prompts to
 *  affect" form, the Chat condition's own "Match by", and Auto Filter's condition/effect forms —
 *  is built from one of these, so the "type a tag, scan it, check the parameters you care about"
 *  behavior (and its DOM wiring) only has to be written once.
 *
 *  How it works: the person types a tag name (e.g. `char` for `<char ...>`) and scans (via the
 *  🔍 button, or automatically on blur/Enter) — this calls collectXmlParams() to find every
 *  distinct attribute name used on that tag across the prompts in scope, and every distinct
 *  value seen for each attribute, and renders one checklist row per attribute: a checkbox (is
 *  this attribute part of the filter at all) plus a Value dropdown defaulting to "All" (any
 *  value) with every observed value also offered. Leaving every attribute unchecked means "match
 *  the tag itself, regardless of its attributes" — checking one or more ANDs them together (see
 *  xmlContentMatches in this same file for the actual matching semantics this feeds).
 *
 *  `getScopePath`/`getMode` are thunks, not plain values, since a couple of callers (Auto
 *  Filter's condition/effect) always scan across every prompt with their own independent
 *  exclusion set, which is simplest to express as constants-in-a-function rather than plumbing
 *  a scopePath argument through call sites that don't otherwise need one.
 *
 *  Returned handle:
 *   - `getTag()` — current tag name, trimmed
 *   - `getParams()` — current active `[{ name, value }]` array (only checked attributes)
 *   - `setTagAndParams(tag, params)` — async; for Edit/preset-load flows — sets the tag, re-scans
 *     it, then re-applies which attributes were checked (and their chosen values) once the
 *     checklist repopulates from the fresh scan
 *   - `reset()` — clears back to an empty tag with no checklist, for "Add new" / cancel-edit flows
 *   - `onChange(fn)` — fn fires whenever the effective spec changes (tag rescanned, a param
 *     checked/unchecked, or a param's value changed) — callers use this the same way they
 *     already clear stale "Matched prompts" results on every other field change in these forms
 *   - `refresh()` — re-runs the scan against the tag currently typed in, for a manual re-scan
 */
export function createXmlPicker(container, { getScopePath = () => null, getMode = () => 'filter' } = {}) {
    container.innerHTML = `
        <div class="pf-bm-row">
            <label>XML tag</label>
            <div class="pf-bm-radio-row" style="gap:6px">
                <input type="text" class="text_pole pf-xp-tag" placeholder="e.g. char" style="flex:1 1 auto; min-width:0" />
                <span class="pf-icon-btn fa-solid fa-magnifying-glass pf-xp-scan" title="Scan prompts in scope for this tag's parameters"></span>
            </div>
        </div>
        <div class="pf-bm-row" style="display:none">
            <label>Parameters <span style="opacity:.7; font-weight:normal">(none checked = match the tag itself, any attributes)</span></label>
            <div class="pf-af-checklist pf-xp-params-list"></div>
        </div>
        <div class="pf-bm-hint pf-xp-hint"></div>`;
    const tagInput = container.querySelector('.pf-xp-tag');
    const scanBtn = container.querySelector('.pf-xp-scan');
    const paramsRow = container.querySelectorAll('.pf-bm-row')[1];
    const paramsList = container.querySelector('.pf-xp-params-list');
    const hintEl = container.querySelector('.pf-xp-hint');

    let changeHandler = null;
    let pendingParamState = null; // { paramName: { value } } — applied once the checklist repopulates, used by setTagAndParams
    function fireChange() { changeHandler?.(); }

    async function scan() {
        const tag = tagInput.value.trim();
        paramsList.innerHTML = '';
        paramsRow.style.display = 'none';
        if (!tag) { hintEl.textContent = ''; fireChange(); return; }
        hintEl.textContent = 'Scanning prompt content…';
        const paramMap = await collectXmlParams(getScopePath(), tag, getMode());
        if (!container.isConnected) return; // modal closed mid-scan
        const names = Array.from(paramMap.keys()).sort((a, b) => a.localeCompare(b));
        if (names.length === 0) {
            hintEl.textContent = `No <${escapeHtml(tag)}> tag with parameters found in scope — matching will just be by the tag itself.`;
            fireChange();
            return;
        }
        paramsRow.style.display = 'flex';
        for (const name of names) {
            const values = Array.from(paramMap.get(name)).sort((a, b) => a.localeCompare(b));
            const row = document.createElement('div');
            row.className = 'pf-xp-param-row';
            row.style.cssText = 'display:flex; align-items:center; gap:6px; padding:2px 0;';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'pf-xp-param-cb';
            cb.dataset.param = name;
            const label = document.createElement('span');
            label.textContent = name;
            label.style.cssText = 'min-width:70px; word-break:break-word;';
            const valSelect = document.createElement('select');
            valSelect.className = 'text_pole pf-xp-param-value';
            valSelect.dataset.param = name;
            valSelect.style.cssText = 'flex:1 1 auto; min-width:0';
            valSelect.disabled = true;
            valSelect.innerHTML = `<option value="__ALL__">All (any value)</option>`;
            for (const v of values) {
                const opt = document.createElement('option');
                opt.value = v;
                opt.textContent = v;
                valSelect.appendChild(opt);
            }
            cb.addEventListener('change', () => { valSelect.disabled = !cb.checked; fireChange(); });
            valSelect.addEventListener('change', fireChange);
            row.appendChild(cb);
            row.appendChild(label);
            row.appendChild(valSelect);
            paramsList.appendChild(row);
        }
        hintEl.textContent = '';
        if (pendingParamState) {
            for (const [name, st] of Object.entries(pendingParamState)) {
                const cb2 = paramsList.querySelector(`.pf-xp-param-cb[data-param="${CSS.escape(name)}"]`);
                const sel2 = paramsList.querySelector(`.pf-xp-param-value[data-param="${CSS.escape(name)}"]`);
                if (cb2) {
                    cb2.checked = true;
                    if (sel2) {
                        sel2.disabled = false;
                        if ([...sel2.options].some(o => o.value === st.value)) sel2.value = st.value;
                    }
                }
            }
            pendingParamState = null;
        }
        fireChange();
    }

    scanBtn.addEventListener('click', scan);
    tagInput.addEventListener('change', scan); // fires on blur once the value actually changed
    tagInput.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); scan(); } });

    return {
        getTag: () => tagInput.value.trim(),
        getParams: () => Array.from(paramsList.querySelectorAll('.pf-xp-param-cb:checked')).map(cb => {
            const name = cb.dataset.param;
            const sel = paramsList.querySelector(`.pf-xp-param-value[data-param="${CSS.escape(name)}"]`);
            return { name, value: sel ? sel.value : '__ALL__' };
        }),
        async setTagAndParams(tag, xmlParams) {
            tagInput.value = tag || '';
            pendingParamState = {};
            for (const p of (xmlParams || [])) { if (p?.name) pendingParamState[p.name] = { value: p.value || '__ALL__' }; }
            await scan();
        },
        reset() {
            tagInput.value = '';
            paramsList.innerHTML = '';
            paramsRow.style.display = 'none';
            hintEl.textContent = '';
        },
        onChange(fn) { changeHandler = fn; },
        refresh: scan,
    };
}

/** Every folder path in `scopePath`'s scope (itself + subfolders), same idea as promptsInScope
 *  but for folders — `scopePath === null` means every folder, including ROOT ("📥 Unfiled").
 *  Used to build the "Manually choose prompts/folders" checklist's folder list, so a manual pick
 *  stays confined to whatever the modal's scope already is. */
function foldersInScope(scopePath) {
    const s = settings();
    const all = [ROOT, ...s.folders.slice().sort((a, b) => a.localeCompare(b))];
    if (scopePath === null) return all;
    return all.filter(path => isDescendantOrSelf(path, scopePath));
}

/** Returns every folder path "containing" `path`, from the top-level folder down to `path`
 *  itself inclusive — e.g. "Folder1/Folder2/Folder3" → ["Folder1", "Folder1/Folder2",
 *  "Folder1/Folder2/Folder3"]. Used by the bulk-match modal's "All containing folders" target
 *  option, as opposed to "Last containing folder" which only ever means the immediate/direct
 *  parent (i.e. `assignments[identifier]` as-is, with no chain walk). ROOT has no ancestors of
 *  its own, so it just returns [ROOT]. */
export function ancestorChain(path) {
    if (!path || path === ROOT) return [ROOT];
    const parts = path.split('/');
    const chain = [];
    let cur = '';
    for (const part of parts) {
        cur = cur ? `${cur}/${part}` : part;
        chain.push(cur);
    }
    return chain;
}

/** Shortens a matched regex value for display in the "Value" dropdown (which can otherwise get
 *  unusably wide/long for real-world captures) — capped at ~4 words AND ~25 characters,
 *  whichever comes first. The dropdown option's actual `value` attribute always keeps the full,
 *  untruncated text (see regexValues Apply handling below), so nothing is ever lost — this only
 *  affects the label shown, and the 👁 preview button next to the dropdown shows the full text
 *  of whatever's currently selected for anyone who needs to read the whole thing. */
function truncateMatchLabel(text, maxWords = 4, maxChars = 25) {
    const words = text.split(/\s+/).filter(Boolean);
    let label = words.slice(0, maxWords).join(' ');
    let truncated = words.length > maxWords;
    if (label.length > maxChars) { label = label.slice(0, maxChars); truncated = true; }
    return truncated ? `${label}…` : label;
}

/** The "Regex (list matched values)" mode's scan: unlike plain Regex (which only ever asks
 *  "does this prompt's content match, yes/no"), this pulls out every distinct piece of text the
 *  pattern actually matched across the whole scope — using capture group 1 if the pattern has
 *  one, otherwise the whole match — so the modal can offer a "Value" dropdown (same idea as the
 *  XML tag Value dropdown) to narrow down to prompts containing one specific matched value,
 *  rather than just "matched somewhere / didn't". Also returns a `{ p, content }` cache so that
 *  switching the Value dropdown afterward can re-filter instantly without re-scanning every
 *  prompt's content again. */
async function extractRegexMatches(scopePath, pattern, onProgress) {
    try { new RegExp(pattern, 'i'); } catch { return { error: 'bad-regex' }; }
    const scope = promptsInScope(scopePath);
    const cache = [];
    const valueSet = new Set();
    for (let i = 0; i < scope.length; i++) {
        const p = scope[i];
        onProgress?.(i + 1, scope.length);
        const peeked = await peekContent(p.identifier);
        const content = peeked?.content || '';
        cache.push({ p, content });
        const globalRe = new RegExp(pattern, 'gi');
        let m;
        while ((m = globalRe.exec(content)) !== null) {
            const raw = (m.length > 1 && m[1] !== undefined) ? m[1] : m[0];
            const val = raw.trim();
            if (val) valueSet.add(val);
            if (m[0].length === 0) globalRe.lastIndex++; // guard against a zero-width match looping forever
        }
    }
    return { cache, values: Array.from(valueSet).sort((a, b) => a.localeCompare(b)) };
}

/** Filters an extractRegexMatches() cache down to the prompts matching one selected value,
 *  without re-scanning content — `__ALL__` falls back to a plain regex test (any match at all),
 *  same as the plain Regex mode; a specific value is a case-insensitive substring check against
 *  that exact matched text (values came from the content itself, so a substring check is exact
 *  enough and far cheaper than re-running the pattern). */
function matchedFromRegexCache(cache, pattern, selectedValue) {
    if (selectedValue === '__ALL__') {
        const re = new RegExp(pattern, 'i');
        return cache.filter(({ content }) => re.test(content)).map(({ p }) => p);
    }
    const needle = selectedValue.toLowerCase();
    return cache.filter(({ content }) => content.toLowerCase().includes(needle)).map(({ p }) => p);
}

/** Re-runs a saved filter preset's match spec fresh (see "Filter presets" below) — unifies the
 *  xml/word/regex path (computeMatches) with the regexValues path (extractRegexMatches + a
 *  specific-or-__ALL__ value), since a preset can have been saved from either. Always a full
 *  fresh scan — presets intentionally never cache, since "taking effect on trigger" means the
 *  Enable/Disable buttons must reflect the prompts' CURRENT content, not whatever matched back
 *  when the preset was saved. */
async function evaluateFilterParams(scopePath, params) {
    if (params.type === 'regexValues') {
        const result = await extractRegexMatches(scopePath, params.text);
        if (result.error) return result;
        return { matched: matchedFromRegexCache(result.cache, params.text, params.regexValue || '__ALL__') };
    }
    return computeMatches(scopePath, params);
}

/** Re-runs a saved Chat filter preset's EFFECT half fresh (see "Chat filter presets" below) —
 *  the "Select prompts to affect" spec, independent of whether its condition currently holds
 *  (same one-off-check philosophy as the live modal: the condition is informational, not a
 *  gate). `mode: 'manual'` returns the hand-picked prompts/folders directly (still respecting
 *  the manual filter's own exclusion set, same as every other manual-filter path); otherwise
 *  delegates to computeMatches/extractRegexMatches, same as the live "Find prompts" flow.
 *  Returns `{ mode, prompts, folders }` for manual, `{ mode, matched, target }` for match, or
 *  `{ error }` for an invalid saved regex. */
async function evaluateChatPresetEffect(preset) {
    const effect = preset.effect || {};
    if (effect.mode === 'manual') {
        const prompts = liveCache.filter(p => (effect.manualPrompts || []).includes(p.identifier) && !isExcludedFromFilter(p.identifier));
        const folders = (effect.manualFolders || []).filter(path => !isFolderExcludedFromFilterPath(path));
        return { mode: 'manual', prompts, folders };
    }
    if (effect.selMode === 'regexValues') {
        const result = await extractRegexMatches(preset.scopePath, effect.text);
        if (result.error) return result;
        return { mode: 'match', matched: matchedFromRegexCache(result.cache, effect.text, effect.regexValue || '__ALL__'), target: effect.target };
    }
    const params = effect.selMode === 'xml'
        ? { type: 'xml', xmlTag: effect.xmlTag, xmlParams: effect.xmlParams }
        : { type: effect.selMode, text: effect.text, caseSensitive: !!effect.caseSensitive };
    const result = await computeMatches(preset.scopePath, params);
    if (result.error) return result;
    return { mode: 'match', matched: result.matched, target: effect.target };
}

/** Shared by the manual Enable/Disable buttons, saved filter presets, and Auto Filter's effect
 *  application: given a list of matched prompt objects and a target mode ('prompt' /
 *  'folder-last' / 'folder-all'), actually flips the right thing(s) to `desiredEnabled` and
 *  reports back how many prompts vs. folders were touched, for the caller's status text. */
async function applyTargetToggle(targets, targetMode, desiredEnabled) {
    if (targets.length === 0) return { prompts: 0, folders: 0 };
    if (targetMode !== 'folder-last' && targetMode !== 'folder-all') {
        await setPromptsLogicalState(targets.map(p => ({ identifier: p.identifier, enabled: desiredEnabled })));
        return { prompts: targets.length, folders: 0 };
    }
    const s = settings();
    const folderPaths = new Set();
    for (const p of targets) {
        const direct = s.assignments[p.identifier] || ROOT;
        if (targetMode === 'folder-all') { for (const anc of ancestorChain(direct)) folderPaths.add(anc); }
        else folderPaths.add(direct);
    }
    for (const path of folderPaths) await setFolderMaster(path, !desiredEnabled);
    return { prompts: 0, folders: folderPaths.size };
}

/** Small read-only popup for the 👁 button next to the regexValues "Value" dropdown, showing the
 *  full untruncated text of whatever value is currently selected there. Deliberately does NOT
 *  go through closeOwnOverlays()/closeBulkMatchModal() — this sits on top of the bulk-match
 *  modal, not in place of it, so the modal underneath must stay open. */
function closeBulkMatchValuePreview() {
    document.getElementById('pf-bm-valuepreview-overlay')?.remove();
}

/** Shows the small read-only "Full matched value" popup described above `closeBulkMatchValuePreview`. */
function showBulkMatchValuePreview(fullText) {
    closeBulkMatchValuePreview();
    const overlay = el('div', 'pf-view-overlay');
    overlay.id = 'pf-bm-valuepreview-overlay';
    overlay.innerHTML = `
        <div class="pf-view-modal">
            <div class="pf-view-header">
                <b>Full matched value</b>
                <span class="pf-icon-btn fa-solid fa-xmark" id="pf-bm-valuepreview-close" title="Close"></span>
            </div>
            <textarea class="pf-view-content" readonly spellcheck="false"></textarea>
        </div>`;
    const contentArea = overlay.querySelector('.pf-view-content');
    contentArea.value = fullText;
    lockTextareaReadOnly(contentArea);
    document.body.appendChild(overlay);
    document.getElementById('pf-bm-valuepreview-close').addEventListener('click', closeBulkMatchValuePreview);
    overlay.addEventListener('click', ev => { if (ev.target === overlay) closeBulkMatchValuePreview(); });
}

let bulkMatchState = null; // { scopePath, matched: [], regexCache: [] } while the modal is open

/** Closes the "Filter (by content)" modal (and its value-preview popup, if open)
 *  and clears bulkMatchState. */
export function closeBulkMatchModal() {
    closeBulkMatchValuePreview();
    document.getElementById('pf-bm-overlay')?.remove();
    bulkMatchState = null;
}

/** Builds and opens the full "Filter (by content)" modal for `scopePath` (`null` for
 *  every live prompt, or a folder path to scope to that folder + its subfolders). This is one
 *  large function that assembles the whole modal in one go: the match-type form (XML tag / word /
 *  regex / "regex, list matched values"), the Apply/scan flow with a progress line (via
 *  computeMatches()/extractRegexMatches()), the matched-prompts results list with a target
 *  picker and Enable/Disable buttons (applyTargetToggle()), and the "Filter presets" section
 *  for saving/replaying a match spec + target later (evaluateFilterParams()). */
export function openBulkMatchModal(scopePath) {
    closeOwnOverlays();

    const scopeLabel = scopePath === null
        ? 'Scope: all prompts'
        : `Scope: ${scopePath === ROOT ? '📥 Unfiled' : scopePath} (and its subfolders)`;

    bulkMatchState = { scopePath, matched: [], regexCache: [], selMode: null, manualPrompts: [], manualFolders: [] };

    const overlay = el('div', 'pf-view-overlay');
    overlay.id = 'pf-bm-overlay';
    overlay.innerHTML = `
        <div class="pf-view-modal pf-bm-modal">
            <div class="pf-view-header">
                <span class="fa-solid fa-filter"></span>
                <b>Filter (by content)</b>
                <span class="pf-icon-btn fa-solid fa-xmark" id="pf-bm-close" title="Close"></span>
            </div>
            <div class="pf-bm-scope">${escapeHtml(scopeLabel)}</div>
            <div class="pf-bm-body">
                <div class="pf-bm-row">
                    <label for="pf-bm-source">Match against</label>
                    <select id="pf-bm-source" class="text_pole">
                        <option value="form">Prompt content (this form)</option>
                        <option value="chat">Chat (live, right now)</option>
                    </select>
                </div>

                <div id="pf-bm-form-block">
                <div class="pf-bm-row">
                    <label for="pf-bm-type">Match by</label>
                    <select id="pf-bm-type" class="text_pole">
                        <option value="xml">XML tag</option>
                        <option value="word">Word</option>
                        <option value="regex">Regex</option>
                        <option value="regexValues">Regex (list matched values)</option>
                    </select>
                </div>
                <div id="pf-bm-xml-block" style="display:none"></div>
                <div class="pf-bm-row" id="pf-bm-text-row" style="display:none">
                    <label id="pf-bm-text-label" for="pf-bm-text">Word</label>
                    <input type="text" id="pf-bm-text" class="text_pole" />
                </div>
                <div class="pf-bm-row pf-bm-radio-row" id="pf-bm-case-row" style="display:none">
                    <label><input type="checkbox" id="pf-bm-case" /> Case sensitive</label>
                </div>
                <div class="pf-bm-row" id="pf-bm-regexvalue-row" style="display:none">
                    <label for="pf-bm-regexvalue">Value</label>
                    <div class="pf-bm-radio-row" style="gap:6px">
                        <select id="pf-bm-regexvalue" class="text_pole" style="flex:1 1 auto; min-width:0"></select>
                        <span class="pf-icon-btn fa-solid fa-eye" id="pf-bm-regexvalue-preview" title="Preview the full (untruncated) value"></span>
                    </div>
                </div>
                </div>

                <div id="pf-bm-chat-block" style="display:none">
                    <div class="pf-bm-row">
                        <label for="pf-bm-chat-type">Match by</label>
                        <select id="pf-bm-chat-type" class="text_pole">
                            ${AUTO_MATCH_TYPES.map(t => `<option value="${t.key}">${escapeHtml(t.label)}</option>`).join('')}
                        </select>
                    </div>
                    <div id="pf-bm-chat-xml-block" style="display:none"></div>
                    <div class="pf-bm-row" id="pf-bm-chat-text-row" style="display:none">
                        <label id="pf-bm-chat-text-label" for="pf-bm-chat-text">Word</label>
                        <input type="text" id="pf-bm-chat-text" class="text_pole" />
                    </div>
                    <div class="pf-bm-row pf-bm-radio-row" id="pf-bm-chat-case-row" style="display:none">
                        <label><input type="checkbox" id="pf-bm-chat-case" /> Case sensitive</label>
                    </div>
                    <div class="pf-bm-row">
                        <label for="pf-bm-chat-depth">Chat depth (last N chat messages, min 1)</label>
                        <input type="number" id="pf-bm-chat-depth" class="text_pole" min="1" step="1" value="5" />
                    </div>
                    <div class="pf-bm-hint">Checks whether the chat currently matches this condition — it's a one-off check, not an ongoing rule. For a live rule that keeps re-checking the chat on its own, use Auto Filter instead.</div>
                </div>

                <div class="pf-bm-row">
                    <div class="menu_button menu_button_icon" id="pf-bm-apply"><i class="fa-solid fa-magnifying-glass"></i><span id="pf-bm-apply-label">Apply</span></div>
                </div>
                <div class="pf-bm-hint" id="pf-bm-chat-result"></div>

                <div id="pf-bm-select-block" style="display:none">
                    <div class="pf-full-section">
                        <div class="pf-full-section-header"><b>Select prompts to affect</b><span class="pf-full-section-words">what the buttons below act on</span></div>
                        <div class="pf-bm-row">
                            <label for="pf-bm-sel-mode">Select by</label>
                            <select id="pf-bm-sel-mode" class="text_pole">
                                <option value="xml">XML tag</option>
                                <option value="word">Word</option>
                                <option value="regex">Regex</option>
                                <option value="regexValues">Regex (list matched values)</option>
                                <option value="manual">Manually choose prompts/folders</option>
                            </select>
                        </div>
                        <div id="pf-bm-sel-xml-block" style="display:none"></div>
                        <div class="pf-bm-row" id="pf-bm-sel-text-row" style="display:none">
                            <label id="pf-bm-sel-text-label" for="pf-bm-sel-text">Word</label>
                            <input type="text" id="pf-bm-sel-text" class="text_pole" />
                        </div>
                        <div class="pf-bm-row pf-bm-radio-row" id="pf-bm-sel-case-row" style="display:none">
                            <label><input type="checkbox" id="pf-bm-sel-case" /> Case sensitive</label>
                        </div>
                        <div class="pf-bm-row" id="pf-bm-sel-regexvalue-row" style="display:none">
                            <label for="pf-bm-sel-regexvalue">Value</label>
                            <div class="pf-bm-radio-row" style="gap:6px">
                                <select id="pf-bm-sel-regexvalue" class="text_pole" style="flex:1 1 auto; min-width:0"></select>
                                <span class="pf-icon-btn fa-solid fa-eye" id="pf-bm-sel-regexvalue-preview" title="Preview the full (untruncated) value"></span>
                            </div>
                        </div>
                        <div id="pf-bm-sel-manual-block" style="display:none">
                            <div class="pf-bm-row">
                                <label>Folders</label>
                                <div id="pf-bm-sel-folders-list" class="pf-af-checklist"></div>
                            </div>
                            <div class="pf-bm-row">
                                <label>Prompts</label>
                                <div id="pf-bm-sel-prompts-list" class="pf-af-checklist"></div>
                            </div>
                        </div>
                        <div class="pf-bm-row">
                            <div class="menu_button menu_button_icon" id="pf-bm-sel-apply"><i class="fa-solid fa-magnifying-glass"></i>&nbsp;Find prompts</div>
                        </div>
                    </div>
                </div>

                <div class="pf-bm-row" id="pf-bm-matched-row" style="display:none">
                    <label for="pf-bm-matched">Matched prompts</label>
                    <select id="pf-bm-matched" class="text_pole"></select>
                </div>
                <div class="pf-bm-row pf-bm-radio-row" id="pf-bm-target-row">
                    <label><input type="radio" name="pf-bm-target" value="prompt" checked /> The prompt</label>
                    <label><input type="radio" name="pf-bm-target" value="folder-last" /> Last containing folder</label>
                    <label><input type="radio" name="pf-bm-target" value="folder-all" /> All containing folders</label>
                </div>
                <div class="pf-bm-row pf-bm-actions" id="pf-bm-actions-row" style="display:none">
                    <div class="menu_button" id="pf-bm-disable"><i class="fa-solid fa-toggle-off"></i>&nbsp;Disable</div>
                    <div class="menu_button" id="pf-bm-enable"><i class="fa-solid fa-toggle-on"></i>&nbsp;Enable</div>
                </div>
                <div class="pf-bm-hint" id="pf-bm-hint"></div>
                <div id="pf-bm-preset-block">
                <div class="pf-bm-row" style="border-top:1px solid var(--SmartThemeBorderColor, #444); padding-top:8px">
                    <label for="pf-bm-preset-name">Save current match as a filter preset</label>
                    <div class="pf-bm-radio-row" style="gap:6px">
                        <input type="text" id="pf-bm-preset-name" class="text_pole" placeholder="Preset name" style="flex:1 1 auto; min-width:0" />
                        <div class="menu_button menu_button_icon" id="pf-bm-save-preset"><i class="fa-solid fa-floppy-disk"></i>&nbsp;Save</div>
                    </div>
                </div>
                <div class="pf-bm-row">
                    <label>Filter presets</label>
                    <div class="pf-bm-hint">Organize saved presets into groups and subgroups. Turning a group off blocks its presets without changing their locks.</div>
                    <div id="pf-bm-preset-list"></div>
                </div>
                </div>
                <div id="pf-bm-chat-preset-block" style="display:none">
                <div class="pf-bm-row" style="border-top:1px solid var(--SmartThemeBorderColor, #444); padding-top:8px">
                    <label for="pf-bm-chat-preset-name">Save current chat condition + selection as a preset</label>
                    <div class="pf-bm-radio-row" style="gap:6px">
                        <input type="text" id="pf-bm-chat-preset-name" class="text_pole" placeholder="Preset name" style="flex:1 1 auto; min-width:0" />
                        <div class="menu_button menu_button_icon" id="pf-bm-chat-save-preset"><i class="fa-solid fa-floppy-disk"></i>&nbsp;Save</div>
                    </div>
                </div>
                <div class="pf-bm-hint">Saved as-is — the word/tag doesn't need to currently show up in chat, and "Select prompts to affect" doesn't need to have found anything yet. Enable/Disable below re-check both fresh each time.</div>
                <div class="pf-bm-row">
                    <label>Chat filter presets</label>
                    <div class="pf-bm-hint">Organize saved chat presets into groups and subgroups with the button below.</div>
                    <div id="pf-bm-chat-preset-list"></div>
                </div>
                </div>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', ev => { if (ev.target === overlay) closeBulkMatchModal(); });
    document.getElementById('pf-bm-close').addEventListener('click', closeBulkMatchModal);

    const sourceSelect = document.getElementById('pf-bm-source');
    const formBlock = document.getElementById('pf-bm-form-block');
    const chatBlock = document.getElementById('pf-bm-chat-block');
    const presetBlock = document.getElementById('pf-bm-preset-block');
    const chatPresetBlock = document.getElementById('pf-bm-chat-preset-block');
    const chatPresetNameInput = document.getElementById('pf-bm-chat-preset-name');
    const chatSavePresetBtn = document.getElementById('pf-bm-chat-save-preset');
    const chatPresetListEl = document.getElementById('pf-bm-chat-preset-list');
    const applyLabel = document.getElementById('pf-bm-apply-label');

    const chatTypeSelect = document.getElementById('pf-bm-chat-type');
    const chatXmlBlock = document.getElementById('pf-bm-chat-xml-block');
    const chatTextRow = document.getElementById('pf-bm-chat-text-row');
    const chatTextLabel = document.getElementById('pf-bm-chat-text-label');
    const chatTextInput = document.getElementById('pf-bm-chat-text');
    const chatCaseRow = document.getElementById('pf-bm-chat-case-row');
    const chatCaseCb = document.getElementById('pf-bm-chat-case');
    const chatDepthInput = document.getElementById('pf-bm-chat-depth');
    const chatResultEl = document.getElementById('pf-bm-chat-result');

    const selectBlock = document.getElementById('pf-bm-select-block');
    const selModeSelect = document.getElementById('pf-bm-sel-mode');
    const selXmlBlock = document.getElementById('pf-bm-sel-xml-block');
    const selTextRow = document.getElementById('pf-bm-sel-text-row');
    const selTextLabel = document.getElementById('pf-bm-sel-text-label');
    const selTextInput = document.getElementById('pf-bm-sel-text');
    const selCaseRow = document.getElementById('pf-bm-sel-case-row');
    const selCaseCb = document.getElementById('pf-bm-sel-case');
    const selRegexValueRow = document.getElementById('pf-bm-sel-regexvalue-row');
    const selRegexValueSelect = document.getElementById('pf-bm-sel-regexvalue');
    const selRegexValuePreviewBtn = document.getElementById('pf-bm-sel-regexvalue-preview');
    const selManualBlock = document.getElementById('pf-bm-sel-manual-block');
    const selFoldersList = document.getElementById('pf-bm-sel-folders-list');
    const selPromptsList = document.getElementById('pf-bm-sel-prompts-list');
    const selApplyBtn = document.getElementById('pf-bm-sel-apply');

    const typeSelect = document.getElementById('pf-bm-type');
    const xmlBlock = document.getElementById('pf-bm-xml-block');
    const textRow = document.getElementById('pf-bm-text-row');
    const textLabel = document.getElementById('pf-bm-text-label');
    const textInput = document.getElementById('pf-bm-text');
    const caseRow = document.getElementById('pf-bm-case-row');
    const caseCb = document.getElementById('pf-bm-case');
    const regexValueRow = document.getElementById('pf-bm-regexvalue-row');
    const regexValueSelect = document.getElementById('pf-bm-regexvalue');
    const regexValuePreviewBtn = document.getElementById('pf-bm-regexvalue-preview');
    const matchedRow = document.getElementById('pf-bm-matched-row');
    const matchedSelect = document.getElementById('pf-bm-matched');
    const targetRow = document.getElementById('pf-bm-target-row');
    const actionsRow = document.getElementById('pf-bm-actions-row');
    const hint = document.getElementById('pf-bm-hint');
    const applyBtn = document.getElementById('pf-bm-apply');

    function resetResults() {
        matchedRow.style.display = 'none';
        actionsRow.style.display = 'none';
        matchedSelect.innerHTML = '';
        bulkMatchState.matched = [];
        bulkMatchState.manualPrompts = [];
        bulkMatchState.manualFolders = [];
        targetRow.style.display = '';
    }

    // Also clears the regexValues-only Value dropdown and its cached scan — called whenever the
    // pattern/type changes so a stale dropdown never lingers pointing at an old pattern's values.
    function resetRegexValues() {
        regexValueRow.style.display = 'none';
        regexValueSelect.innerHTML = '';
        bulkMatchState.regexCache = [];
        closeBulkMatchValuePreview();
    }

    // Three XML pickers share createXmlPicker() (see its header comment in this file): the
    // Prompt content form, the Chat condition's own "Match by", and the Chat flow's "Select
    // prompts to affect" form — all three scan (scopePath, 'filter'), same as everything else in
    // this modal.
    const xmlPicker = createXmlPicker(xmlBlock, { getScopePath: () => scopePath, getMode: () => 'filter' });
    xmlPicker.onChange(() => resetResults());
    const chatXmlPicker = createXmlPicker(chatXmlBlock, { getScopePath: () => scopePath, getMode: () => 'filter' });
    chatXmlPicker.onChange(() => resetResults());
    const selXmlPicker = createXmlPicker(selXmlBlock, { getScopePath: () => scopePath, getMode: () => 'filter' });
    selXmlPicker.onChange(() => resetResults());

    function updateVisibility() {
        resetResults();
        resetRegexValues();
        hint.textContent = '';
        const type = typeSelect.value;
        xmlBlock.style.display = type === 'xml' ? '' : 'none';
        textRow.style.display = (type === 'word' || type === 'regex' || type === 'regexValues') ? 'flex' : 'none';
        caseRow.style.display = type === 'word' ? 'flex' : 'none';
        if (type === 'word') { textLabel.textContent = 'Word'; textInput.placeholder = 'e.g. tavern'; }
        if (type === 'regex') { textLabel.textContent = 'Regex'; textInput.placeholder = 'e.g. \\btavern\\b'; }
        if (type === 'regexValues') { textLabel.textContent = 'Regex'; textInput.placeholder = 'e.g. <char name="(.*?)">'; }
    }

    typeSelect.addEventListener('change', updateVisibility);

    function updateChatVisibility() {
        resetResults();
        hint.textContent = '';
        const def = autoMatchDef(chatTypeSelect.value);
        chatXmlBlock.style.display = def?.kind === 'xml' ? '' : 'none';
        chatTextRow.style.display = (def?.kind === 'regex' || def?.kind === 'word') ? 'flex' : 'none';
        chatCaseRow.style.display = def?.kind === 'word' ? 'flex' : 'none';
        if (def?.kind === 'regex') { chatTextLabel.textContent = 'Regex'; chatTextInput.placeholder = 'e.g. \\btavern\\b'; }
        if (def?.kind === 'word') { chatTextLabel.textContent = 'Word'; chatTextInput.placeholder = 'e.g. tavern'; }
    }

    function collectCheckedValues(container, cls) {
        return Array.from(container.querySelectorAll(`.${cls}:checked`)).map(cb => cb.value);
    }

    function renderSelectManualChecklists() {
        selFoldersList.innerHTML = '';
        const folderPaths = foldersInScope(scopePath);
        for (const path of folderPaths) {
            const label = document.createElement('label');
            label.style.cssText = 'display:flex; align-items:center; gap:6px; padding:2px 0; cursor:pointer;';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = path;
            cb.className = 'pf-bm-sel-folder-cb';
            label.appendChild(cb);
            label.appendChild(document.createTextNode(path === ROOT ? '📥 Unfiled' : path));
            selFoldersList.appendChild(label);
        }
        selPromptsList.innerHTML = '';
        const scopedPrompts = promptsInScope(scopePath, 'filter');
        if (!scopedPrompts.length) {
            selPromptsList.appendChild(el('div', 'pf-empty-hint', { text: 'No prompts in scope.' }));
            return;
        }
        for (const p of scopedPrompts) {
            const label = document.createElement('label');
            label.style.cssText = 'display:flex; align-items:center; gap:6px; padding:2px 0; cursor:pointer;';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = p.identifier;
            cb.className = 'pf-bm-sel-prompt-cb';
            label.appendChild(cb);
            label.appendChild(document.createTextNode(p.name));
            selPromptsList.appendChild(label);
        }
    }

    function updateSelectVisibility() {
        resetResults();
        hint.textContent = '';
        const mode = selModeSelect.value;
        bulkMatchState.selMode = mode;
        selXmlBlock.style.display = mode === 'xml' ? '' : 'none';
        selTextRow.style.display = (mode === 'word' || mode === 'regex' || mode === 'regexValues') ? 'flex' : 'none';
        selCaseRow.style.display = mode === 'word' ? 'flex' : 'none';
        selManualBlock.style.display = mode === 'manual' ? '' : 'none';
        selRegexValueRow.style.display = 'none';
        selRegexValueSelect.innerHTML = '';
        if (mode === 'word') { selTextLabel.textContent = 'Word'; selTextInput.placeholder = 'e.g. tavern'; }
        if (mode === 'regex') { selTextLabel.textContent = 'Regex'; selTextInput.placeholder = 'e.g. \\btavern\\b'; }
        if (mode === 'regexValues') { selTextLabel.textContent = 'Regex'; selTextInput.placeholder = 'e.g. <char name="(.*?)">'; }
        if (mode === 'manual') renderSelectManualChecklists();
    }

    selModeSelect.addEventListener('change', updateSelectVisibility);

    selApplyBtn.addEventListener('click', async () => {
        resetResults();
        const mode = selModeSelect.value;
        bulkMatchState.selMode = mode;

        if (mode === 'manual') {
            const manualPrompts = collectCheckedValues(selPromptsList, 'pf-bm-sel-prompt-cb');
            const manualFolders = collectCheckedValues(selFoldersList, 'pf-bm-sel-folder-cb');
            if (manualPrompts.length === 0 && manualFolders.length === 0) {
                hint.textContent = 'Check at least one prompt or folder.';
                return;
            }
            bulkMatchState.manualPrompts = manualPrompts;
            bulkMatchState.manualFolders = manualFolders;
            targetRow.style.display = 'none';
            actionsRow.style.display = 'flex';
            hint.textContent = `Selected ${manualPrompts.length} prompt${manualPrompts.length === 1 ? '' : 's'} and ${manualFolders.length} folder${manualFolders.length === 1 ? '' : 's'}. Use Enable/Disable below to apply.`;
            return;
        }

        if (mode === 'regexValues') {
            const pattern = selTextInput.value;
            if (!pattern.trim()) { hint.textContent = 'Enter a regex to search for.'; return; }

            hint.textContent = 'Scanning prompt content…';
            const result = await extractRegexMatches(scopePath, pattern, (i, total) => {
                if (document.getElementById('pf-bm-overlay')) hint.textContent = `Scanning prompt ${i} of ${total}…`;
            });
            if (!document.getElementById('pf-bm-overlay')) return; // closed mid-scan
            if (result.error === 'bad-regex') { hint.textContent = 'That regex is not valid.'; return; }

            bulkMatchState.regexCache = result.cache;
            bulkMatchState.regexPattern = pattern;
            if (result.values.length === 0) {
                hint.textContent = 'No matches found for this pattern in scope.';
                return;
            }

            selRegexValueSelect.innerHTML = `<option value="__ALL__">All matched values</option>`;
            for (const v of result.values) {
                const opt = document.createElement('option');
                opt.value = v; // full, untruncated text — the 👁 preview and the substring match both use this
                opt.textContent = truncateMatchLabel(v);
                opt.title = v;
                selRegexValueSelect.appendChild(opt);
            }
            selRegexValueRow.style.display = 'flex';

            presentMatchedResults(matchedFromRegexCache(bulkMatchState.regexCache, pattern, '__ALL__'));
            return;
        }

        const params = { type: mode };
        if (mode === 'xml') {
            params.xmlTag = selXmlPicker.getTag();
            params.xmlParams = selXmlPicker.getParams();
            if (!params.xmlTag) { hint.textContent = 'Enter an XML tag to search for.'; return; }
        } else {
            params.text = selTextInput.value;
            if (!params.text.trim()) { hint.textContent = `Enter a ${mode} to search for.`; return; }
            if (mode === 'word') params.caseSensitive = !!selCaseCb.checked;
        }

        hint.textContent = 'Scanning prompt content…';
        const result = await computeMatches(scopePath, params, (i, total) => {
            if (document.getElementById('pf-bm-overlay')) hint.textContent = `Scanning prompt ${i} of ${total}…`;
        });
        if (!document.getElementById('pf-bm-overlay')) return; // closed mid-scan
        if (result.error === 'bad-regex') { hint.textContent = 'That regex is not valid.'; return; }

        presentMatchedResults(result.matched);
    });

    // Re-filters instantly from the cached scan — no re-scan needed — whenever the selection
    // form's regexValues Value dropdown changes to a different specific value (or back to "All").
    selRegexValueSelect.addEventListener('change', () => {
        if (!bulkMatchState.regexPattern) return;
        presentMatchedResults(matchedFromRegexCache(bulkMatchState.regexCache, bulkMatchState.regexPattern, selRegexValueSelect.value));
    });

    selRegexValuePreviewBtn.addEventListener('click', () => {
        if (!selRegexValueSelect.options.length) return;
        if (selRegexValueSelect.value === '__ALL__') { showBulkMatchValuePreview('(All matched values — pick one specific value from the dropdown to preview its full text.)'); return; }
        showBulkMatchValuePreview(selRegexValueSelect.value);
    });

    function updateSourceVisibility() {
        resetResults();
        hint.textContent = '';
        chatResultEl.textContent = '';
        bulkMatchState.selMode = null;
        const isChat = sourceSelect.value === 'chat';
        formBlock.style.display = isChat ? 'none' : '';
        chatBlock.style.display = isChat ? '' : 'none';
        // "Select prompts to affect" and the Chat filter presets section live and die with Chat
        // mode itself now — neither one is gated behind having clicked "Check chat" first, same
        // as Auto Filter's effect form never requires the condition to have been tested. This is
        // also what lets a preset be saved without the word/tag needing to currently show up in
        // chat, and without "Select prompts to affect" needing to have found anything yet.
        selectBlock.style.display = isChat ? '' : 'none';
        presetBlock.style.display = isChat ? 'none' : '';
        chatPresetBlock.style.display = isChat ? '' : 'none';
        applyLabel.textContent = isChat ? 'Check chat' : 'Apply';
        if (isChat) { updateChatVisibility(); updateSelectVisibility(); renderChatPresetList(); }
        else updateVisibility();
    }

    sourceSelect.addEventListener('change', updateSourceVisibility);
    chatTypeSelect.addEventListener('change', updateChatVisibility);
    updateSourceVisibility();

    // Shared by both the plain xml/word/regex Apply flow and the regexValues flow (both the
    // initial "All" pass and every subsequent Value-dropdown re-filter) so the "Matched prompts"
    // dropdown/target radios/action buttons behave identically no matter which mode produced
    // the list. `hintPrefix`, when given, is prepended to the usual count message — used by the
    // Chat source to report whether the condition is currently met before the usual tally.
    function presentMatchedResults(matchedList, hintPrefix = '') {
        bulkMatchState.matched = matchedList;
        if (matchedList.length === 0) {
            matchedRow.style.display = 'none';
            actionsRow.style.display = 'none';
            matchedSelect.innerHTML = '';
            hint.textContent = `${hintPrefix}No prompts matched. (You can still pick a target below and save this as a preset — it'll re-check for matches fresh whenever it runs.)`;
            return;
        }
        matchedSelect.innerHTML = `<option value="__all__">All matched (${matchedList.length})</option>`;
        for (const p of matchedList) {
            const opt = document.createElement('option');
            opt.value = p.identifier;
            opt.textContent = p.name;
            matchedSelect.appendChild(opt);
        }
        matchedRow.style.display = 'flex';
        actionsRow.style.display = 'flex';
        hint.textContent = `${hintPrefix}${matchedList.length} prompt${matchedList.length === 1 ? '' : 's'} matched.`;
    }

    applyBtn.addEventListener('click', async () => {
        resetResults();

        if (sourceSelect.value === 'chat') {
            const def = autoMatchDef(chatTypeSelect.value);
            const depth = Math.max(1, parseInt(chatDepthInput.value, 10) || 1);
            let value = '', xmlTag = '', xmlParams = [];
            if (def?.kind === 'xml') {
                xmlTag = chatXmlPicker.getTag();
                xmlParams = chatXmlPicker.getParams();
                if (!xmlTag) { chatResultEl.textContent = 'Enter an XML tag to check for.'; return; }
            } else if (def?.kind === 'regex' || def?.kind === 'word') {
                value = chatTextInput.value.trim();
                if (!value) { chatResultEl.textContent = `Enter a ${def.kind} to check for.`; return; }
                if (def.kind === 'regex') { try { new RegExp(value); } catch { chatResultEl.textContent = 'That regex is not valid.'; return; } }
            }
            const caseSensitive = def?.kind === 'word' && !!chatCaseCb.checked;
            chatResultEl.textContent = 'Checking chat…';
            const triggered = await evaluateAutoCondition({ matchType: chatTypeSelect.value, value, xmlTag, xmlParams, depth, caseSensitive }, new Map());
            if (!document.getElementById('pf-bm-overlay')) return; // closed mid-check
            chatResultEl.textContent = triggered ? '✅ Chat condition is currently MET.' : '❌ Chat condition is currently NOT met.';
            // "Select prompts to affect" (and the Chat filter presets section) are already visible
            // in Chat mode regardless of this check's outcome — the condition check here is purely
            // informational, same one-off philosophy as before.
            return;
        }

        const type = typeSelect.value;

        if (type === 'regexValues') {
            resetRegexValues();
            const pattern = textInput.value;
            if (!pattern.trim()) { hint.textContent = 'Enter a regex to search for.'; return; }

            hint.textContent = 'Scanning prompt content…';
            const result = await extractRegexMatches(scopePath, pattern, (i, total) => {
                if (document.getElementById('pf-bm-overlay')) hint.textContent = `Scanning prompt ${i} of ${total}…`;
            });
            if (!document.getElementById('pf-bm-overlay')) return; // closed mid-scan
            if (result.error === 'bad-regex') { hint.textContent = 'That regex is not valid.'; return; }

            bulkMatchState.regexCache = result.cache;
            bulkMatchState.regexPattern = pattern;
            if (result.values.length === 0) {
                hint.textContent = 'No matches found for this pattern in scope.';
                return;
            }

            regexValueSelect.innerHTML = `<option value="__ALL__">All matched values</option>`;
            for (const v of result.values) {
                const opt = document.createElement('option');
                opt.value = v; // full, untruncated text — the 👁 preview and the substring match both use this
                opt.textContent = truncateMatchLabel(v);
                opt.title = v;
                regexValueSelect.appendChild(opt);
            }
            regexValueRow.style.display = 'flex';

            presentMatchedResults(matchedFromRegexCache(bulkMatchState.regexCache, pattern, '__ALL__'));
            return;
        }

        const params = { type };
        if (type === 'xml') {
            params.xmlTag = xmlPicker.getTag();
            params.xmlParams = xmlPicker.getParams();
            if (!params.xmlTag) { hint.textContent = 'Enter an XML tag to search for.'; return; }
        } else {
            params.text = textInput.value;
            if (!params.text.trim()) { hint.textContent = `Enter a ${type} to search for.`; return; }
            if (type === 'word') params.caseSensitive = !!caseCb.checked;
        }

        hint.textContent = 'Scanning prompt content…';
        const result = await computeMatches(scopePath, params, (i, total) => {
            if (document.getElementById('pf-bm-overlay')) hint.textContent = `Scanning prompt ${i} of ${total}…`;
        });
        if (!document.getElementById('pf-bm-overlay')) return; // closed mid-scan
        if (result.error === 'bad-regex') { hint.textContent = 'That regex is not valid.'; return; }

        presentMatchedResults(result.matched);
    });

    // Re-filters instantly from the cached scan — no re-scan needed — whenever the regexValues
    // Value dropdown changes to a different specific value (or back to "All").
    regexValueSelect.addEventListener('change', () => {
        if (!bulkMatchState.regexPattern) return;
        presentMatchedResults(matchedFromRegexCache(bulkMatchState.regexCache, bulkMatchState.regexPattern, regexValueSelect.value));
    });

    regexValuePreviewBtn.addEventListener('click', () => {
        if (!regexValueSelect.options.length) return;
        if (regexValueSelect.value === '__ALL__') { showBulkMatchValuePreview('(All matched values — pick one specific value from the dropdown to preview its full text.)'); return; }
        showBulkMatchValuePreview(regexValueSelect.value);
    });

    async function runBulkAction(desiredEnabled) {
        const targetId = matchedSelect.value;
        const targetMode = document.querySelector('input[name="pf-bm-target"]:checked')?.value || 'prompt';
        const targets = targetId === '__all__' ? bulkMatchState.matched : bulkMatchState.matched.filter(p => p.identifier === targetId);
        if (targets.length === 0) return;

        const out = await applyTargetToggle(targets, targetMode, desiredEnabled);
        hint.textContent = targetMode === 'prompt'
            ? `${desiredEnabled ? 'Enabled' : 'Disabled'} ${out.prompts} prompt${out.prompts === 1 ? '' : 's'}.`
            : `${desiredEnabled ? 'Enabled' : 'Disabled'} ${out.folders} folder${out.folders === 1 ? '' : 's'}.`;
    }

    // Manually chosen prompts/folders (chat source, "Manually choose…" selection mode) bypass the
    // matched-prompts/target-radio machinery entirely — prompts and folders were picked directly,
    // so each is just flipped straight to the desired state.
    async function runManualAction(desiredEnabled) {
        const promptChanges = [...bulkMatchState.manualPrompts].map(identifier => ({ identifier, enabled: desiredEnabled }));
        let promptCount = promptChanges.length, folderCount = 0;
        await setPromptsLogicalState(promptChanges);
        for (const path of bulkMatchState.manualFolders) { await setFolderMaster(path, !desiredEnabled); folderCount++; }
        hint.textContent = `${desiredEnabled ? 'Enabled' : 'Disabled'} ${promptCount} prompt${promptCount === 1 ? '' : 's'} and ${folderCount} folder${folderCount === 1 ? '' : 's'}.`;
    }

    document.getElementById('pf-bm-disable').addEventListener('click', () => {
        if (sourceSelect.value === 'chat' && bulkMatchState.selMode === 'manual') runManualAction(false);
        else runBulkAction(false);
    });
    document.getElementById('pf-bm-enable').addEventListener('click', () => {
        if (sourceSelect.value === 'chat' && bulkMatchState.selMode === 'manual') runManualAction(true);
        else runBulkAction(true);
    });

    // ---------- Filter presets (save the current match spec + target, replay it later) ----------

    const presetNameInput = document.getElementById('pf-bm-preset-name');
    const savePresetBtn = document.getElementById('pf-bm-save-preset');
    const presetListEl = document.getElementById('pf-bm-preset-list');

    function currentFormParams() {
        const type = typeSelect.value;
        if (type === 'xml') return { type, xmlTag: xmlPicker.getTag(), xmlParams: xmlPicker.getParams() };
        if (type === 'regexValues') return { type, text: bulkMatchState.regexPattern || textInput.value, regexValue: regexValueSelect.value || '__ALL__' };
        if (type === 'word') return { type, text: textInput.value, caseSensitive: !!caseCb.checked };
        return { type, text: textInput.value };
    }

    function renderPresetList() {
        const s = settings();
        presetListEl.innerHTML = '';
        const groups = buildFilterGroups(presetListEl, 'matchPresets', s.matchPresets, renderPresetList);
        if (!s.matchPresets.length) {
            presetListEl.appendChild(el('div', 'pf-empty-hint', { text: 'No saved presets yet — set up a match above (Apply is optional), pick a target, then "Save".' }));
            return;
        }
        for (const preset of s.matchPresets) {
            const row = el('div', 'pf-prompt-row');

            const lockLabel = document.createElement('label');
            lockLabel.style.cssText = 'display:flex; align-items:center; gap:3px; flex-shrink:0; cursor:pointer;';
            lockLabel.title = 'Lock — prevents Enable/Disable below from running this preset';
            const lockCb = document.createElement('input');
            lockCb.type = 'checkbox';
            lockCb.checked = !!preset.locked;
            const lockIcon = el('i', 'fa-solid fa-lock');
            lockLabel.appendChild(lockCb);
            lockLabel.appendChild(lockIcon);

            const name = el('span', 'pf-prompt-name', { text: preset.name });
            const enableBtn = el('span', 'pf-icon-btn fa-solid fa-toggle-on', { title: 'Enable matching prompts/folders now' });
            const disableBtn = el('span', 'pf-icon-btn fa-solid fa-toggle-off', { title: 'Disable matching prompts/folders now' });
            const delBtn = el('span', 'pf-icon-btn fa-solid fa-trash', { title: 'Remove this preset' });

            function refreshLockUi() {
                const locked = !!preset.locked || isFilterGroupDisabled('matchPresets', preset);
                for (const btn of [enableBtn, disableBtn]) {
                    btn.style.opacity = locked ? '0.3' : '';
                    btn.style.pointerEvents = locked ? 'none' : '';
                }
                enableBtn.title = locked ? 'Locked or group off — unlock the preset and enable its groups' : 'Enable matching prompts/folders now';
                disableBtn.title = locked ? 'Locked or group off — unlock the preset and enable its groups' : 'Disable matching prompts/folders now';
            }
            refreshLockUi();

            lockCb.addEventListener('change', () => {
                const s2 = settings();
                const p2 = s2.matchPresets.find(x => x.id === preset.id);
                if (p2) { p2.locked = lockCb.checked; preset.locked = lockCb.checked; save(); }
                refreshLockUi();
            });

            // "Not a toggle" — these re-run the preset's saved match spec fresh against current
            // prompt content every click, rather than replaying a stale cached result.
            async function runPreset(desiredEnabled) {
                if (preset.locked || isFilterGroupDisabled('matchPresets', preset)) return;
                hint.textContent = `Running preset "${preset.name}"…`;
                const result = await evaluateFilterParams(preset.scopePath, preset.params);
                if (result.error) { hint.textContent = `Preset "${preset.name}"'s regex is no longer valid.`; return; }
                const out = await applyTargetToggle(result.matched, preset.target, desiredEnabled);
                hint.textContent = preset.target === 'prompt'
                    ? `${desiredEnabled ? 'Enabled' : 'Disabled'} ${out.prompts} prompt${out.prompts === 1 ? '' : 's'} via "${preset.name}".`
                    : `${desiredEnabled ? 'Enabled' : 'Disabled'} ${out.folders} folder${out.folders === 1 ? '' : 's'} via "${preset.name}".`;
            }
            enableBtn.addEventListener('click', () => runPreset(true));
            disableBtn.addEventListener('click', () => runPreset(false));

            delBtn.addEventListener('click', () => {
                const s2 = settings();
                s2.matchPresets = s2.matchPresets.filter(x => x.id !== preset.id);
                save();
                renderPresetList();
            });

            row.appendChild(lockLabel);
            row.appendChild(name);
            row.appendChild(enableBtn);
            row.appendChild(disableBtn);
            row.appendChild(delBtn);
            groups.add(row, preset);
        }
    }

    savePresetBtn.addEventListener('click', () => {
        // Presets always re-run their match spec fresh when triggered (see evaluateFilterParams/
        // runPreset above) — they never replay whatever happened to be matched at save time — so
        // there's no need to have clicked Apply, let alone gotten a result, before saving one.
        // Just the spec itself needs to be complete enough to run later.
        const type = typeSelect.value;
        if ((type === 'word' || type === 'regex' || type === 'regexValues') && !(bulkMatchState.regexPattern || textInput.value).trim()) {
            hint.textContent = `Enter a ${type === 'word' ? 'word' : 'regex'} to search for before saving a preset.`;
            return;
        }
        if (type === 'xml' && !xmlPicker.getTag()) {
            hint.textContent = 'Enter an XML tag before saving a preset.';
            return;
        }
        const targetMode = document.querySelector('input[name="pf-bm-target"]:checked')?.value || 'prompt';
        const s = settings();
        const name = presetNameInput.value.trim() || `Preset ${s.matchPresets.length + 1}`;
        s.matchPresets.push({
            id: `mp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name,
            locked: false,
            scopePath,
            params: currentFormParams(),
            target: targetMode,
        });
        save();
        presetNameInput.value = '';
        renderPresetList();
        hint.textContent = `Saved preset "${name}".`;
    });

    renderPresetList();

    // ---------- Chat filter presets (save the chat condition + "Select prompts to affect" spec,
    // replay either half later) ----------
    //
    // Deliberately independent of the "Filter presets" section above: those save a prompt-content
    // match spec + target; these save a *condition* (checked against recent chat, same vocabulary
    // and evaluateAutoCondition() as Auto Filter) plus an *effect* (the "Select prompts to affect"
    // spec — match-based or manually hand-picked, same as Auto Filter's effect). Saving one never
    // requires the condition to currently be met, or the selection to have found anything yet —
    // same "describe it, don't have to prove it first" philosophy as adding an Auto Filter rule.

    /** Reads the current Chat condition form into a condition spec, or `{ error }` if a required
     *  field (the word/tag to look for) is missing or invalid — never checks whether it's
     *  actually met right now. */
    function currentChatConditionSpec() {
        const def = autoMatchDef(chatTypeSelect.value);
        const depth = Math.max(1, parseInt(chatDepthInput.value, 10) || 1);
        if (def?.kind === 'xml') {
            const xmlTag = chatXmlPicker.getTag();
            if (!xmlTag) return { error: 'Enter a condition XML tag before saving a preset.' };
            return { spec: { matchType: chatTypeSelect.value, xmlTag, xmlParams: chatXmlPicker.getParams(), depth } };
        }
        const value = chatTextInput.value.trim();
        if (!value) return { error: `Enter a condition ${def?.kind || 'word'} before saving a preset.` };
        if (def?.kind === 'regex') { try { new RegExp(value); } catch { return { error: 'That condition regex is not valid.' }; } }
        return { spec: { matchType: chatTypeSelect.value, value, depth, caseSensitive: def?.kind === 'word' && !!chatCaseCb.checked } };
    }

    /** Reads the current "Select prompts to affect" form into an effect spec, or `{ error }` if
     *  a required field is missing/invalid — for `manual` mode this means at least one checked
     *  prompt/folder; for match modes, a non-empty tag/word/regex. Never requires "Find prompts"
     *  to have actually been clicked. */
    function currentChatEffectSpec() {
        const mode = selModeSelect.value;
        if (mode === 'manual') {
            const manualPrompts = collectCheckedValues(selPromptsList, 'pf-bm-sel-prompt-cb');
            const manualFolders = collectCheckedValues(selFoldersList, 'pf-bm-sel-folder-cb');
            if (manualPrompts.length === 0 && manualFolders.length === 0) return { error: 'Check at least one prompt or folder for "Select prompts to affect" before saving.' };
            return { spec: { mode: 'manual', manualPrompts, manualFolders } };
        }
        const target = document.querySelector('input[name="pf-bm-target"]:checked')?.value || 'prompt';
        if (mode === 'xml') {
            const xmlTag = selXmlPicker.getTag();
            if (!xmlTag) return { error: 'Enter an XML tag for "Select prompts to affect" before saving.' };
            return { spec: { mode: 'match', selMode: mode, xmlTag, xmlParams: selXmlPicker.getParams(), target } };
        }
        const text = selTextInput.value.trim();
        if (!text) return { error: `Enter a ${mode === 'word' ? 'word' : 'regex'} for "Select prompts to affect" before saving.` };
        if ((mode === 'regex' || mode === 'regexValues')) { try { new RegExp(text); } catch { return { error: 'That "Select prompts to affect" regex is not valid.' }; } }
        return { spec: { mode: 'match', selMode: mode, text, caseSensitive: mode === 'word' && !!selCaseCb.checked, regexValue: mode === 'regexValues' ? (selRegexValueSelect.value || '__ALL__') : undefined, target } };
    }

    function renderChatPresetList() {
        const s = settings();
        chatPresetListEl.innerHTML = '';
        const groups = buildFilterGroups(chatPresetListEl, 'chatMatchPresets', s.chatMatchPresets, renderChatPresetList);
        if (!s.chatMatchPresets.length) {
            chatPresetListEl.appendChild(el('div', 'pf-empty-hint', { text: 'No saved chat presets yet — fill in a chat condition and a selection above (no need to Check chat or Find prompts first), then "Save".' }));
            return;
        }
        for (const preset of s.chatMatchPresets) {
            const row = el('div', 'pf-prompt-row');

            const lockLabel = document.createElement('label');
            lockLabel.style.cssText = 'display:flex; align-items:center; gap:3px; flex-shrink:0; cursor:pointer;';
            lockLabel.title = 'Lock — prevents Enable/Disable below from running this preset';
            const lockCb = document.createElement('input');
            lockCb.type = 'checkbox';
            lockCb.checked = !!preset.locked;
            const lockIcon = el('i', 'fa-solid fa-lock');
            lockLabel.appendChild(lockCb);
            lockLabel.appendChild(lockIcon);

            const name = el('span', 'pf-prompt-name', { text: preset.name });
            const enableBtn = el('span', 'pf-icon-btn fa-solid fa-toggle-on', { title: 'Enable the selected prompts/folders now' });
            const disableBtn = el('span', 'pf-icon-btn fa-solid fa-toggle-off', { title: 'Disable the selected prompts/folders now' });
            const delBtn = el('span', 'pf-icon-btn fa-solid fa-trash', { title: 'Remove this preset' });

            function refreshLockUi() {
                const locked = !!preset.locked || isFilterGroupDisabled('chatMatchPresets', preset);
                for (const btn of [enableBtn, disableBtn]) {
                    btn.style.opacity = locked ? '0.3' : '';
                    btn.style.pointerEvents = locked ? 'none' : '';
                }
                enableBtn.title = locked ? 'Locked or group off — unlock the preset and enable its groups' : 'Enable the selected prompts/folders now';
                disableBtn.title = locked ? 'Locked or group off — unlock the preset and enable its groups' : 'Disable the selected prompts/folders now';
            }
            refreshLockUi();

            lockCb.addEventListener('change', () => {
                const s2 = settings();
                const p2 = s2.chatMatchPresets.find(x => x.id === preset.id);
                if (p2) { p2.locked = lockCb.checked; preset.locked = lockCb.checked; save(); }
                refreshLockUi();
            });

            // Re-checks the condition (informational only) and re-runs the effect spec fresh
            // against current chat/prompt content every click — same "not a toggle, not a cached
            // replay" philosophy as the Filter presets' runPreset above.
            async function runChatPreset(desiredEnabled) {
                if (preset.locked || isFilterGroupDisabled('chatMatchPresets', preset)) return;
                hint.textContent = `Running chat preset "${preset.name}"…`;
                const conditionMet = await evaluateAutoCondition(preset.condition, new Map());
                const effResult = await evaluateChatPresetEffect(preset);
                if (!document.getElementById('pf-bm-overlay')) return; // closed mid-run
                if (effResult.error) { hint.textContent = `Chat preset "${preset.name}"'s regex is no longer valid.`; return; }
                const condBit = `Chat condition currently ${conditionMet ? 'met' : 'not met'}. `;
                if (effResult.mode === 'manual') {
                    const promptChanges = effResult.prompts.map(p => ({ identifier: p.identifier, enabled: desiredEnabled }));
                    let promptCount = promptChanges.length, folderCount = 0;
                    await setPromptsLogicalState(promptChanges);
                    for (const path of effResult.folders) { await setFolderMaster(path, !desiredEnabled); folderCount++; }
                    hint.textContent = `${condBit}${desiredEnabled ? 'Enabled' : 'Disabled'} ${promptCount} prompt${promptCount === 1 ? '' : 's'} and ${folderCount} folder${folderCount === 1 ? '' : 's'} via "${preset.name}".`;
                    return;
                }
                const out = await applyTargetToggle(effResult.matched, effResult.target, desiredEnabled);
                hint.textContent = effResult.target === 'prompt'
                    ? `${condBit}${desiredEnabled ? 'Enabled' : 'Disabled'} ${out.prompts} prompt${out.prompts === 1 ? '' : 's'} via "${preset.name}".`
                    : `${condBit}${desiredEnabled ? 'Enabled' : 'Disabled'} ${out.folders} folder${out.folders === 1 ? '' : 's'} via "${preset.name}".`;
            }
            enableBtn.addEventListener('click', () => runChatPreset(true));
            disableBtn.addEventListener('click', () => runChatPreset(false));

            delBtn.addEventListener('click', () => {
                const s2 = settings();
                s2.chatMatchPresets = s2.chatMatchPresets.filter(x => x.id !== preset.id);
                save();
                renderChatPresetList();
            });

            row.appendChild(lockLabel);
            row.appendChild(name);
            row.appendChild(enableBtn);
            row.appendChild(disableBtn);
            row.appendChild(delBtn);
            groups.add(row, preset);
        }
    }

    chatSavePresetBtn.addEventListener('click', () => {
        const condResult = currentChatConditionSpec();
        if (condResult.error) { hint.textContent = condResult.error; return; }
        const effResult = currentChatEffectSpec();
        if (effResult.error) { hint.textContent = effResult.error; return; }

        const s = settings();
        const name = chatPresetNameInput.value.trim() || `Chat preset ${s.chatMatchPresets.length + 1}`;
        s.chatMatchPresets.push({
            id: `cp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name,
            locked: false,
            scopePath,
            condition: condResult.spec,
            effect: effResult.spec,
        });
        save();
        chatPresetNameInput.value = '';
        renderChatPresetList();
        hint.textContent = `Saved chat preset "${name}".`;
    });

    renderChatPresetList();
}
