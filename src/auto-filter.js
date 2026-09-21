import { buildFilterGroups, isFilterGroupDisabled } from './filter-groups.js';
// ---------- Auto Filter (condition ⇒ effect rules, toolbar-only) ----------
//
import { getContext } from '../../../../extensions.js';
import { eventSource, event_types } from '../../../../../script.js';
import { LEGACY_XML_TAGS, ancestorChain, collectXmlParams, computeMatches, createXmlPicker, isExcludedFromAutoFilter, isFolderExcludedFromAutoFilter, xmlContentMatches } from './bulk-match.js';
import { attachDndHandlers } from './dnd.js';
import { closeOwnOverlays, peekContent } from './native.js';
import { isPromptLogicallyEnabled, liveCache, setFolderMaster, setPromptsLogicalState } from './render.js';
import { ROOT, SELECTORS, el, escapeHtml, save, settings } from './state.js';

// A persisted, ORDERED list of rules. Each rule has two independent halves:
//   - CONDITION: what has to be true for the rule to be "triggered" — either always on
//     (chat depth 0), or "does this trigger text show up somewhere in the last N real chat
//     messages" for one of: all/specific Character, Location, or Time tag values, a specific
//     regex, or a specific word.
//   - EFFECT: what gets enabled/disabled when the condition is triggered (and disabled/enabled
//     back when it isn't) — either the same match vocabulary as the condition (but evaluated
//     completely independently, so the trigger and the target don't have to share a tag/value at
//     all), or a manually hand-picked set of specific prompts and/or folders.
// Condition and effect are deliberately unrelated data: "Tony in chat" can trigger "turn on
// Prompt A and Folder B" just as easily as it can trigger "turn on every prompt tagged Tony".
//
// Every enabled rule in the list is re-evaluated, in list order, on every trigger: a manual
// "Re-evaluate now", adding/editing/removing a rule, and (best-effort) live chat events — new
// messages, swipes, edits, deletions, and switching to a different/new chat. A master
// "Disable all filters" switch in the modal short-circuits the whole system without touching any
// individual rule's own enabled state, so turning it back on restores exactly what was running.

export const AUTO_MATCH_TYPES = [
    { key: 'xml', label: 'XML tag', kind: 'xml' },
    { key: 'regex', label: 'Specific Regex', kind: 'regex' },
    { key: 'word', label: 'Specific Word', kind: 'word' },
];

/** Looks up an AUTO_MATCH_TYPES entry by its key. */
export function autoMatchDef(key) { return AUTO_MATCH_TYPES.find(t => t.key === key); }

// The old system had six fixed match types (All/Specific × Character/Location/Time), each keyed
// to a hardcoded tag whose VALUE lived in its inner text (`<char_slc>Alice</char_slc>`). The new
// system is one free-form "XML tag" type whose values live in attributes instead
// (`<char name="Alice">`) — a genuinely different content shape, so a rule written for the old
// tags can't be losslessly reinterpreted as an attribute match. migrateLegacyCondition/Effect
// below degrade old rules as sensibly as possible instead: "All X" (any occurrence of the tag)
// still means exactly the same thing under the new tag-presence match, so that one carries over
// perfectly; "Specific X: value" degrades to a plain Word/Regex search for that value text, which
// still finds it whether it now lives in an attribute or the old inner text.
function legacyTagKey(matchType) {
    return { allChar: 'character', char: 'character', allLoc: 'location', loc: 'location', allTime: 'time', time: 'time' }[matchType];
}
const isLegacyAllTag = mt => mt === 'allChar' || mt === 'allLoc' || mt === 'allTime';
const isLegacyTagValue = mt => mt === 'char' || mt === 'loc' || mt === 'time';
const escapeRegexLiteral = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function migrateLegacyCondition(condition) {
    if (!condition) return condition;
    if (isLegacyAllTag(condition.matchType)) {
        return { ...condition, matchType: 'xml', xmlTag: LEGACY_XML_TAGS[legacyTagKey(condition.matchType)], xmlParams: [] };
    }
    if (isLegacyTagValue(condition.matchType)) {
        return { ...condition, matchType: 'word', value: condition.value || '' };
    }
    return condition;
}

function migrateLegacyEffect(effect) {
    if (!effect || effect.mode === 'manual') return effect;
    if (isLegacyAllTag(effect.matchType)) {
        return { ...effect, matchType: 'xml', xmlTag: LEGACY_XML_TAGS[legacyTagKey(effect.matchType)], xmlParams: [] };
    }
    if (isLegacyTagValue(effect.matchType)) {
        const values = effect.values || [];
        if (values.length <= 1) return { ...effect, matchType: 'word', text: values[0] || effect.text || '' };
        return { ...effect, matchType: 'regex', text: values.map(escapeRegexLiteral).join('|') };
    }
    return effect;
}

/** Upgrades a filter saved by the older single-condition-equals-effect version of Auto Filter
 *  (flat `{ id, matchType, value, target, depth }`, no condition/effect split) into the current
 *  nested shape, so existing saved settings keep working exactly as they did before — condition
 *  and effect just both point at the same match spec, same as they always implicitly did. Also
 *  runs every filter's condition/effect through migrateLegacyCondition/Effect above, so rules
 *  saved before the free-form XML tag system (see the note above) keep working too, just
 *  degraded to a Word/Regex search where an exact re-interpretation isn't possible. Filters
 *  already in the current shape, with no legacy match types, pass through untouched. */
export function migrateAutoFilter(f) {
    if (f && f.condition && f.effect) {
        if (f.action !== 'disable') f.action = 'enable';
        f.condition = migrateLegacyCondition(f.condition);
        f.effect = migrateLegacyEffect(f.effect);
        return f;
    }
    const matchType = f?.matchType || 'word';
    const value = f?.value || '';
    return {
        id: f?.id || `af_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: f?.name || 'Filter',
        enabled: f?.enabled !== false,
        action: 'enable',
        condition: migrateLegacyCondition({ matchType, value, depth: f?.depth || 0 }),
        effect: migrateLegacyEffect({
            mode: 'match',
            matchType,
            values: value ? [value] : [],
            text: value,
            target: f?.target || 'prompt',
            manualPrompts: [],
            manualFolders: [],
        }),
    };
}

/** Depth 0 always means "on, unconditionally" — no chat is read at all. Depth N (N>=1) means
 *  "look at the last N messages in the current chat" (both user and character lines, whichever
 *  actually happened most recently — this deliberately doesn't distinguish who sent them). */
function getRecentChatMessagesText(depth) {
    if (!depth || depth <= 0) return [];
    let chat;
    try { chat = getContext()?.chat; } catch { chat = null; }
    if (!Array.isArray(chat) || chat.length === 0) return [];
    return chat.slice(Math.max(0, chat.length - depth)).map(m => m?.mes || '').filter(Boolean);
}

/** True if any of `recentTexts` (recent chat message strings) matches `text` — a plain
 *  case-insensitive-by-default substring check for `kind: 'word'`, or a regex test for
 *  `kind: 'regex'`. Shared by every condition kind ('xml' checks each candidate value as a word,
 *  via xmlConditionGroups above). */
function chatHasMatch(recentTexts, kind, text, caseSensitive = false) {
    if (recentTexts.length === 0) return false;
    if (kind === 'regex') {
        let re;
        try { re = new RegExp(text, 'i'); } catch { return false; }
        return recentTexts.some(t => re.test(t));
    }
    const needle = caseSensitive ? (text || '') : (text || '').toLowerCase();
    if (!needle) return false;
    return recentTexts.some(t => (caseSensitive ? t : t.toLowerCase()).includes(needle));
}

/** For an `xml`-kind condition, works out the list of "value groups" to test against recent chat
 *  text: each group is a list of candidate strings, and the condition is met only if EVERY group
 *  has at least one candidate present in chat (groups AND together; candidates within a group
 *  OR together). With no parameters checked, there's one group — every attribute value seen
 *  anywhere on that tag across all prompts (mirrors the old "All Character"-style condition: any
 *  known value showing up in chat is enough). With one or more parameters checked, each checked
 *  parameter contributes its own group — a specific chosen value is a one-candidate group, while
 *  a param left on "All" contributes every value known for that attribute — so "name: Alice,
 *  type: All" triggers only when "Alice" AND some known type value both show up in chat. */
async function xmlConditionGroups(condition) {
    const tag = condition.xmlTag;
    if (!tag) return [];
    const params = (condition.xmlParams || []).filter(p => p && p.name);
    const paramMap = await collectXmlParams(null, tag, 'auto');
    if (params.length === 0) {
        const all = new Set();
        for (const set of paramMap.values()) for (const v of set) all.add(v);
        return all.size ? [Array.from(all)] : [];
    }
    const groups = [];
    for (const p of params) {
        if (p.value && p.value !== '__ALL__') { groups.push([p.value]); continue; }
        const values = Array.from(paramMap.get(p.name) || []);
        if (values.length === 0) return null; // this param has no known values at all — can never be satisfied
        groups.push(values);
    }
    return groups;
}

/** Evaluates just the CONDITION half of a rule down to one boolean for the whole rule.
 *  `xmlGroupCache` is a `JSON-key -> value groups` map the caller keeps for one evaluation pass,
 *  since several rules can share the same XML tag condition and there's no reason to rescan
 *  every prompt's content for it more than once per pass. */
export async function evaluateAutoCondition(condition, xmlGroupCache) {
    if (!condition || !condition.depth || condition.depth <= 0) return true;
    const recentTexts = getRecentChatMessagesText(condition.depth);
    const def = autoMatchDef(condition.matchType);
    if (!def) return false;
    if (def.kind === 'xml') {
        const cacheKey = JSON.stringify({ tag: condition.xmlTag, params: condition.xmlParams || [] });
        if (!xmlGroupCache.has(cacheKey)) xmlGroupCache.set(cacheKey, await xmlConditionGroups(condition));
        const groups = xmlGroupCache.get(cacheKey);
        if (!groups || groups.length === 0) return false;
        return groups.every(group => group.some(v => chatHasMatch(recentTexts, 'word', v)));
    }
    if (def.kind === 'regex') return chatHasMatch(recentTexts, 'regex', condition.value || '');
    if (def.kind === 'word') return chatHasMatch(recentTexts, 'word', condition.value || '', !!condition.caseSensitive);
    return false;
}

/** Evaluates just the EFFECT half of a rule down to the actual set of prompts/folders it names —
 *  either the manually hand-picked ones, or whatever currently matches the effect's own
 *  (independent) match spec, using the same content-scanning helpers the manual bulk-match modal
 *  and Filter presets already use. Returns `{ prompts, folders, mode, target }`; for `mode:
 *  'match'`, `target` says whether the *matched prompts* themselves are the real target or
 *  whether it's their containing folder(s) — same as the bulk-match modal's target radios. */
async function computeAutoEffectTargets(effect) {
    if (!effect) return { prompts: [], folders: [], mode: 'match', target: 'prompt' };
    if (effect.mode === 'manual') {
        // Manually hand-picked prompts/folders still respect per-item Auto Filter exclusion (the
        // "auto locked" flag) — an auto-excluded prompt/folder is never touched by Auto Filter,
        // even if a rule explicitly checked it off here. This is independent of the manual
        // Enable/disable-by-match filter's own exclusion, which has no bearing on Auto Filter.
        const prompts = liveCache.filter(p => (effect.manualPrompts || []).includes(p.identifier) && !isExcludedFromAutoFilter(p.identifier));
        const folders = (effect.manualFolders || []).filter(path => !isFolderExcludedFromAutoFilter(path));
        return { prompts, folders, mode: 'manual' };
    }
    const def = autoMatchDef(effect.matchType);
    if (!def) return { prompts: [], folders: [], mode: 'match', target: effect.target || 'prompt' };

    if (def.kind === 'xml') {
        const prompts = [];
        for (const p of liveCache) {
            if (isExcludedFromAutoFilter(p.identifier)) continue;
            const peeked = await peekContent(p.identifier);
            if (xmlContentMatches(peeked?.content, effect.xmlTag, effect.xmlParams)) prompts.push(p);
        }
        return { prompts, folders: [], mode: 'match', target: effect.target || 'prompt' };
    }
    // regex / word — computeMatches(..., 'auto') applies Auto Filter's own (independent)
    // exclusion set, never the manual filter's excludedPrompts/excludedFolders.
    const params = def.kind === 'regex'
        ? { type: 'regex', text: effect.text || '' }
        : { type: 'word', text: effect.text || '', caseSensitive: !!effect.caseSensitive };
    const result = await computeMatches(null, params, undefined, 'auto');
    return { prompts: result.matched || [], folders: [], mode: 'match', target: effect.target || 'prompt' };
}

/** Applies one rule's single triggered/not-triggered verdict to its whole effect set — skipping
 *  anything already in the desired state, so a steady-state re-evaluation (nothing actually
 *  changed in chat) is a genuine no-op rather than re-clicking every native toggle every time. */
async function applyAutoEffect(targetSet, desiredEnabled) {
    const s = settings();
    let promptCount = 0, folderCount = 0;

    if (targetSet.mode === 'manual') {
        const promptChanges = targetSet.prompts
            .filter(p => isPromptLogicallyEnabled(p, s) !== desiredEnabled)
            .map(p => ({ identifier: p.identifier, enabled: desiredEnabled }));
        await setPromptsLogicalState(promptChanges);
        promptCount = promptChanges.length;
        for (const path of targetSet.folders) {
            const desiredOff = !desiredEnabled;
            if (!!s.folderDisabled[path] !== desiredOff) { await setFolderMaster(path, desiredOff); folderCount++; }
        }
        return { promptCount, folderCount };
    }

    if (targetSet.target === 'prompt') {
        const promptChanges = targetSet.prompts
            .filter(p => isPromptLogicallyEnabled(p, s) !== desiredEnabled)
            .map(p => ({ identifier: p.identifier, enabled: desiredEnabled }));
        await setPromptsLogicalState(promptChanges);
        promptCount = promptChanges.length;
        return { promptCount, folderCount };
    }

    const folderPaths = new Set();
    for (const p of targetSet.prompts) {
        const direct = s.assignments[p.identifier] || ROOT;
        if (targetSet.target === 'folder-all') { for (const anc of ancestorChain(direct)) folderPaths.add(anc); }
        else folderPaths.add(direct);
    }
    for (const path of folderPaths) {
        const desiredOff = !desiredEnabled;
        if (!!s.folderDisabled[path] !== desiredOff) { await setFolderMaster(path, desiredOff); folderCount++; }
    }
    return { promptCount, folderCount: folderPaths.size };
}

/** Evaluates one rule end-to-end: its condition (evaluateAutoCondition), its effect's target set
 *  (computeAutoEffectTargets), works out the actual desired on/off state from the rule's
 *  `action` ('enable' or 'disable'), and applies it (applyAutoEffect). Returns
 *  `{promptCount, folderCount}` for how many things this rule actually changed. */
async function applyAutoFilter(filter, xmlGroupCache) {
    const triggered = await evaluateAutoCondition(filter.condition, xmlGroupCache);
    const targetSet = await computeAutoEffectTargets(filter.effect);
    // action defaults to 'enable' for backward compatibility with rules saved before this was
    // configurable: triggered => effect ON, not-triggered => effect OFF. 'disable' flips both:
    // triggered => effect OFF, not-triggered => effect ON — e.g. "word appears in chat => turn
    // this prompt off" needs 'disable', which plain 'enable' rules could never express before.
    const desiredEnabled = filter.action === 'disable' ? !triggered : triggered;
    return applyAutoEffect(targetSet, desiredEnabled);
}

let autoFilterRunning = false;
let autoFilterRerunQueued = false;

/** The single entry point every trigger (chat events, manual Refresh, list edits) goes through.
 *  Re-entrancy-guarded — a chat event firing again while a previous pass is still mid-scan
 *  (peekContent per prompt per rule isn't instant) queues one follow-up pass instead of
 *  overlapping two, since overlapping passes could both read stale liveCache/chat snapshots and
 *  fight each other over the same folder. The master "Disable all filters" switch and an empty
 *  list both short-circuit before touching anything.
 *  Returns a status object so callers that care (the "Re-evaluate now" button) can report what
 *  actually happened instead of a blind "Re-evaluated." — background/automatic callers can just
 *  ignore the return value. */
async function evaluateAutoFilters() {
    const s = settings();
    if (s.autoFilterDisabled) return { ok: false, reason: 'disabled' };
    if (!Array.isArray(s.autoFilters) || s.autoFilters.length === 0) return { ok: false, reason: 'empty' };
    if (!Array.isArray(liveCache) || liveCache.length === 0) return { ok: false, reason: 'no-prompts' };
    if (autoFilterRunning) { autoFilterRerunQueued = true; return { ok: false, reason: 'busy' }; }

    autoFilterRunning = true;
    let rulesRun = 0, prompts = 0, folders = 0;
    try {
        const xmlGroupCache = new Map(); // see xmlConditionGroups() — shared across this pass's condition checks
        for (const filter of s.autoFilters) {
            if (filter.enabled === false || isFilterGroupDisabled('autoFilters', filter)) continue;
            rulesRun++;
            const counts = await applyAutoFilter(filter, xmlGroupCache);
            prompts += counts.promptCount;
            folders += counts.folderCount;
        }
    } finally {
        autoFilterRunning = false;
        if (autoFilterRerunQueued) { autoFilterRerunQueued = false; evaluateAutoFilters(); }
    }
    return { ok: true, rulesRun, prompts, folders };
}

let autoFilterEvalTimer = null;
/** Debounced trigger for evaluateAutoFilters() — every live-chat event, list edit, and manual
 *  Refresh routes through this instead of calling evaluateAutoFilters() directly, so a burst of
 *  triggers in quick succession collapses into a single evaluation pass. */
export function scheduleAutoFilterEval(delay = 300) {
    clearTimeout(autoFilterEvalTimer);
    autoFilterEvalTimer = setTimeout(evaluateAutoFilters, delay);
}

/** Best-effort, same philosophy as the rest of this file's direct-native-access code: eventSource
 *  and event_types are long-standing, widely-relied-on parts of SillyTavern's extension API (not
 *  the kind of unconfirmed internal-schema guesswork the README's other notes warn about), but
 *  this still wraps every step defensively so a version missing one particular event constant
 *  (or the event system shifting shape entirely) can never break the rest of the extension —
 *  Auto Filter just falls back to evaluating on Refresh clicks and filter-list edits only, i.e.
 *  it stops reacting live to new chat messages/new chats but everything else keeps working. */
export function tryHookChatEvents() {
    try {
        const liveKeys = ['MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_EDITED', 'CHAT_CHANGED'];
        for (const k of liveKeys) {
            const evt = event_types?.[k];
            if (evt) eventSource?.on?.(evt, () => scheduleAutoFilterEval());
        }
        // GENERATION_STOPPED (aborted manually) / GENERATION_ENDED (finished or errored out) are
        // the documented ST signal for "the Abort request icon just reverted back to the send
        // icon" — see tryHookSendAbortIcon() below for the DOM-level detector of that same
        // moment, which this duplicates on purpose as an independent, version-proof backup. Both
        // are gated on the same autoFilterOnGenerationDone setting as that DOM detector, checked
        // fresh on every fire so the checkbox takes effect immediately.
        for (const k of ['GENERATION_STOPPED', 'GENERATION_ENDED']) {
            const evt = event_types?.[k];
            if (evt) eventSource?.on?.(evt, () => { if (settings().autoFilterOnGenerationDone) scheduleAutoFilterEval(); });
        }
    } catch { /* see note above — Auto Filter degrades to manual/edit-triggered evaluation only */ }
}

/** The two icon-driven Auto Filter triggers, on top of the live chat-event hooks above — each
 *  independently gated by its own setting (settings().autoFilterOnSendClick /
 *  autoFilterOnGenerationDone), checked fresh on every event so flipping either checkbox in the
 *  modal takes effect immediately without needing to re-hook anything:
 *   1. THE INSTANT the send icon is clicked — before it's "being processed" — a filter pass
 *      starts right away, so it has the best chance of finishing (toggling which prompts/folders
 *      are on) before SillyTavern's own click handler goes on to read the prompt list and build
 *      the actual request. This works because the listener is registered on `document` in the
 *      capture phase: a capture-phase listener on an ancestor always runs before ANY listener —
 *      capture or bubble, no matter when it was registered — bound directly to the clicked
 *      element itself, so this necessarily fires before ST's own send handler does.
 *      IMPORTANT CAVEAT (off by default — see the modal's warning banner next to its checkbox):
 *      because applying a filter (toggling prompts) is asynchronous, this can only ever START a
 *      filter pass on click — there's no way for an extension to actually block SillyTavern's own
 *      send handler until that pass finishes. On a slow filter (many rules, XML tag conditions
 *      that peek every prompt's content) the request can go out mid-toggle: partially filtered,
 *      not filtered at all, or in rare cases with prompts left in an inconsistent on/off state if
 *      a second click/rule-edit lands while the first pass is still running. Enable this only if
 *      you've confirmed your specific rules are fast enough in practice.
 *   2. The abort icon reverting back to the send icon — i.e. generation actually ending, whether
 *      it finished normally or was stopped manually. SillyTavern shows/hides these two as
 *      separate elements via plain inline `style="display:none"` rather than a class, so this is
 *      a MutationObserver on `style`/`class` watching for exactly that visibility flip (abort
 *      showing → send showing). This is intentionally independent of, and in addition to, the
 *      GENERATION_STOPPED/GENERATION_ENDED events hooked in tryHookChatEvents() above — same
 *      moment, two unrelated detection methods, so a future ST version changing one doesn't lose
 *      the other. This one carries none of trigger 1's race risk (the message has already been
 *      sent/finished by the time it fires), so it defaults to on.
 *  Both halves are wrapped defensively, same philosophy as tryHookChatEvents(): if the send/abort
 *  elements don't match SELECTORS.sendButton/abortButton on some version, this trigger quietly
 *  does nothing rather than breaking anything else — the live chat-event hooks above and the
 *  manual "Re-evaluate now" button keep working regardless. */
export function tryHookSendAbortIcon() {
    try {
        document.addEventListener('click', ev => {
            if (!settings().autoFilterOnSendClick) return;
            if (!ev.target?.closest?.(SELECTORS.sendButton)) return;
            scheduleAutoFilterEval(0);
        }, true);
    } catch { /* best-effort, see note above */ }

    try {
        const isShowing = node => !!node && node.style.display !== 'none' && node.offsetParent !== null;
        let abortWasShowing = false;
        const check = () => {
            const abortShowing = isShowing(document.querySelector(SELECTORS.abortButton));
            if (abortWasShowing && !abortShowing && settings().autoFilterOnGenerationDone) scheduleAutoFilterEval(0);
            abortWasShowing = abortShowing;
        };
        const observer = new MutationObserver(check);
        observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
        check(); // establish the starting state without treating page-load as a transition
    } catch { /* best-effort, see note above */ }
}

/** Short "<tag>[param=value, param2=*]" summary of an xml-kind condition/effect's tag spec,
 *  shared by describeAutoFilterCondition/Effect below. */
function describeXmlSpec(tag, xmlParams) {
    if (!tag) return '(no tag set)';
    const params = (xmlParams || []).filter(p => p && p.name);
    if (params.length === 0) return `<${tag}>`;
    const bits = params.map(p => `${p.name}=${(!p.value || p.value === '__ALL__') ? '*' : p.value}`);
    return `<${tag} ${bits.join(', ')}>`;
}

/** One-line human-readable summary of a rule's condition, used both in the list and (implicitly)
 *  when repopulating the form for Edit. */
function describeAutoFilterCondition(condition) {
    if (!condition || !condition.depth) return 'always on';
    const def = autoMatchDef(condition.matchType);
    const label = def ? def.label : condition.matchType;
    let valueBit = '';
    if (def?.kind === 'xml') valueBit = `: ${describeXmlSpec(condition.xmlTag, condition.xmlParams)}`;
    else if (condition.value) valueBit = `: "${condition.value}"`;
    const caseBit = (def?.kind === 'word' && condition.caseSensitive) ? ' (Aa)' : '';
    return `${label}${valueBit}${caseBit} in last ${condition.depth} chat${condition.depth === 1 ? '' : 's'}`;
}

/** One-line human-readable summary of a rule's effect (see describeAutoFilterCondition above). */
function describeAutoFilterEffect(effect) {
    if (!effect) return '(no effect set)';
    if (effect.mode === 'manual') {
        const n = (effect.manualPrompts || []).length + (effect.manualFolders || []).length;
        return `${n} manually chosen item${n === 1 ? '' : 's'}`;
    }
    const def = autoMatchDef(effect.matchType);
    const label = def ? def.label : effect.matchType;
    let valueBit = '';
    if (def?.kind === 'xml') valueBit = `: ${describeXmlSpec(effect.xmlTag, effect.xmlParams)}`;
    else if (def?.kind === 'regex' || def?.kind === 'word') valueBit = effect.text ? `: ${effect.text}` : '';
    const caseBit = (def?.kind === 'word' && effect.caseSensitive) ? ' (Aa)' : '';
    const targetLabel = effect.target === 'folder-all' ? 'all containing folders' : effect.target === 'folder-last' ? 'last containing folder' : 'the prompt';
    return `${label}${valueBit}${caseBit} → ${targetLabel}`;
}

/** One-line human-readable summary of a whole rule (condition ⇒ action: effect), shown in the
 *  Auto Filter list. */
function describeAutoFilter(filter) {
    const action = filter.action === 'disable' ? 'Disable' : 'Enable';
    return `${describeAutoFilterCondition(filter.condition)} ⇒ ${action}: ${describeAutoFilterEffect(filter.effect)}`;
}

/** Simple linear drag-to-reorder for the flat Auto Filter list — deliberately much simpler than
 *  the folder tree's attachDndHandlers (no "into" zone, no refiling — a rule can only ever move
 *  before/after another rule in the one flat list, which is exactly what determines execution
 *  order). */
function attachAutoFilterDnd(rowEl, filterId, onDropped) {
    rowEl.setAttribute('draggable', 'true');
    rowEl.addEventListener('dragstart', ev => {
        ev.dataTransfer.setData('application/pf-autofilter', filterId);
        ev.dataTransfer.effectAllowed = 'move';
    });
    rowEl.addEventListener('dragover', ev => {
        ev.preventDefault();
        const rect = rowEl.getBoundingClientRect();
        const zone = (ev.clientY - rect.top) / rect.height < 0.5 ? 'before' : 'after';
        rowEl.classList.remove('pf-drop-before', 'pf-drop-after');
        rowEl.classList.add('pf-drop-' + zone);
        rowEl.dataset.dropZone = zone;
    });
    rowEl.addEventListener('dragleave', () => rowEl.classList.remove('pf-drop-before', 'pf-drop-after'));
    rowEl.addEventListener('drop', ev => {
        ev.preventDefault();
        const zone = rowEl.dataset.dropZone || 'after';
        rowEl.classList.remove('pf-drop-before', 'pf-drop-after');
        const draggedId = ev.dataTransfer.getData('application/pf-autofilter');
        if (!draggedId || draggedId === filterId) return;
        const s = settings();
        const fromIdx = s.autoFilters.findIndex(f => f.id === draggedId);
        if (fromIdx === -1) return;
        const [dragged] = s.autoFilters.splice(fromIdx, 1);
        let toIdx = s.autoFilters.findIndex(f => f.id === filterId);
        if (toIdx === -1) toIdx = s.autoFilters.length;
        if (zone === 'after') toIdx += 1;
        s.autoFilters.splice(toIdx, 0, dragged);
        save();
        onDropped();
    });
}

let autoFilterEditingId = null; // non-null while the form below is editing an existing rule rather than adding a new one

/** Closes the Auto Filter modal and clears which rule (if any) was being edited. */
export function closeAutoFilterModal() {
    document.getElementById('pf-af-overlay')?.remove();
    autoFilterEditingId = null;
}

/** Builds and opens the full Auto Filter modal: the master "Disable all filters" switch, the
 *  add/edit rule form (condition side + effect side, either match-based or a manually hand-picked
 *  set of prompts/folders), the ordered, drag-to-reorder rule list (attachAutoFilterDnd), and the
 *  "Re-evaluate now" / "Remove all" toolbar actions. One large function, same shape as
 *  bulk-match.js's openBulkMatchModal(). */
export function openAutoFilterModal() {
    closeOwnOverlays();

    const overlay = el('div', 'pf-view-overlay');
    overlay.id = 'pf-af-overlay';
    overlay.innerHTML = `
        <div class="pf-view-modal pf-bm-modal" style="width:min(560px, 94vw)">
            <div class="pf-view-header">
                <span class="fa-solid fa-wand-magic-sparkles"></span>
                <b>Auto Filter</b>
                <span class="pf-icon-btn fa-solid fa-xmark" id="pf-af-close" title="Close"></span>
            </div>
            <div class="pf-bm-scope">Each rule below is a condition ⇒ effect pair: when the condition shows up in recent chat, the effect turns on — when it doesn't, the effect turns off. Reacts live to new messages and new chats (best-effort — use Re-evaluate now if it doesn't on this SillyTavern version).</div>
            <div class="pf-bm-body" style="max-height:70vh; overflow-y:auto">
                <div class="pf-bm-row pf-bm-radio-row">
                    <label><input type="checkbox" id="pf-af-disable-all" /> Disable all filters</label>
                </div>

                <div class="pf-full-section">
                    <div class="pf-full-section-header"><b>Send/abort triggers</b><span class="pf-full-section-words">when to re-evaluate around a message</span></div>
                    <div class="pf-bm-row pf-bm-radio-row">
                        <label><input type="checkbox" id="pf-af-trigger-generation-done" /> Re-evaluate when generation finishes or is aborted</label>
                    </div>
                    <div class="pf-bm-row pf-bm-radio-row">
                        <label><input type="checkbox" id="pf-af-trigger-send-click" /> Re-evaluate the instant the send icon is clicked (before it's sent)</label>
                    </div>
                    <div class="pf-warning-banner"><span class="fa-solid fa-triangle-exclamation"></span> The send-click trigger is a race condition by nature: an extension can start a filter pass on click but can't block SillyTavern from sending the message while that pass is still running. Depending on how many/slow your rules are, your prompt can end up fully filtered, partially filtered, not filtered at all, or — in rare cases where a second trigger lands mid-pass — with prompts left in an inconsistent on/off state, ruining the request that goes out. Only enable this if you've confirmed your specific rules are fast enough in practice.</div>
                </div>

                <div class="pf-bm-row">
                    <label for="pf-af-name">Filter name</label>
                    <input type="text" id="pf-af-name" class="text_pole" placeholder="e.g. Filter A" />
                </div>

                <div class="pf-full-section">
                    <div class="pf-full-section-header"><b>Condition</b><span class="pf-full-section-words">what triggers it</span></div>
                    <div class="pf-bm-row">
                        <label for="pf-af-cond-type">Match by</label>
                        <select id="pf-af-cond-type" class="text_pole">
                            ${AUTO_MATCH_TYPES.map(t => `<option value="${t.key}">${escapeHtml(t.label)}</option>`).join('')}
                        </select>
                    </div>
                    <div id="pf-af-cond-xml-block" style="display:none"></div>
                    <div class="pf-bm-row" id="pf-af-cond-text-row" style="display:none">
                        <label id="pf-af-cond-text-label" for="pf-af-cond-text">Word</label>
                        <input type="text" id="pf-af-cond-text" class="text_pole" />
                    </div>
                    <div class="pf-bm-row pf-bm-radio-row" id="pf-af-cond-case-row" style="display:none">
                        <label><input type="checkbox" id="pf-af-cond-case" /> Case sensitive</label>
                    </div>
                    <div class="pf-bm-row">
                        <label for="pf-af-cond-depth">Chat depth (0 = always on, N = last N chat messages)</label>
                        <input type="number" id="pf-af-cond-depth" class="text_pole" min="0" step="1" value="0" />
                    </div>
                </div>

                <div class="pf-full-section">
                    <div class="pf-full-section-header"><b>Effect</b><span class="pf-full-section-words">what it turns on/off</span></div>
                    <div class="pf-bm-row pf-bm-radio-row">
                        <label><input type="radio" name="pf-af-action" value="enable" checked /> Enable when triggered</label>
                        <label><input type="radio" name="pf-af-action" value="disable" /> Disable when triggered</label>
                    </div>
                    <div class="pf-bm-hint">The opposite happens automatically once the condition stops being met — e.g. "Disable when triggered" turns the effect back on again as soon as the trigger text is no longer in range.</div>
                    <div class="pf-bm-row">
                        <label for="pf-af-eff-mode">Apply to</label>
                        <select id="pf-af-eff-mode" class="text_pole">
                            <option value="match">Prompts/folders matching…</option>
                            <option value="manual">Manually chosen prompts/folders</option>
                        </select>
                    </div>

                    <div id="pf-af-eff-match-block">
                        <div class="pf-bm-row">
                            <label for="pf-af-eff-type">Match by</label>
                            <select id="pf-af-eff-type" class="text_pole">
                                ${AUTO_MATCH_TYPES.map(t => `<option value="${t.key}">${escapeHtml(t.label)}</option>`).join('')}
                            </select>
                        </div>
                        <div id="pf-af-eff-xml-block" style="display:none"></div>
                        <div class="pf-bm-row" id="pf-af-eff-text-row" style="display:none">
                            <label id="pf-af-eff-text-label" for="pf-af-eff-text">Word</label>
                            <input type="text" id="pf-af-eff-text" class="text_pole" />
                        </div>
                        <div class="pf-bm-row pf-bm-radio-row" id="pf-af-eff-case-row" style="display:none">
                            <label><input type="checkbox" id="pf-af-eff-case" /> Case sensitive</label>
                        </div>
                        <div class="pf-bm-row pf-bm-radio-row">
                            <label><input type="radio" name="pf-af-eff-target" value="prompt" checked /> The prompt</label>
                            <label><input type="radio" name="pf-af-eff-target" value="folder-last" /> Last containing folder</label>
                            <label><input type="radio" name="pf-af-eff-target" value="folder-all" /> All containing folders</label>
                        </div>
                    </div>

                    <div id="pf-af-eff-manual-block" style="display:none">
                        <div class="pf-bm-row">
                            <label>Folders</label>
                            <div id="pf-af-eff-folders-list" class="pf-af-checklist"></div>
                        </div>
                        <div class="pf-bm-row">
                            <label>Prompts</label>
                            <div id="pf-af-eff-prompts-list" class="pf-af-checklist"></div>
                        </div>
                    </div>
                </div>

                <div class="pf-bm-row pf-bm-actions">
                    <div class="menu_button" id="pf-af-submit"><i class="fa-solid fa-plus"></i>&nbsp;<span id="pf-af-submit-label">Add filter</span></div>
                    <div class="menu_button" id="pf-af-cancel-edit" style="display:none"><i class="fa-solid fa-xmark"></i>&nbsp;Cancel edit</div>
                </div>
                <div class="pf-bm-hint" id="pf-af-hint"></div>

                <div class="pf-bm-row" style="border-top:1px solid var(--SmartThemeBorderColor, #444); padding-top:8px">
                    <label>Filter list — numbered execution order; drag rules to reorder</label>
                    <div id="pf-af-list"></div>
                </div>
                <div class="pf-bm-row pf-bm-actions">
                    <div class="menu_button" id="pf-af-reeval"><i class="fa-solid fa-rotate"></i>&nbsp;Re-evaluate now</div>
                    <div class="menu_button" id="pf-af-remove-all"><i class="fa-solid fa-trash"></i>&nbsp;Remove all filters</div>
                </div>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', ev => { if (ev.target === overlay) closeAutoFilterModal(); });
    document.getElementById('pf-af-close').addEventListener('click', closeAutoFilterModal);

    const disableAllCb = document.getElementById('pf-af-disable-all');
    const triggerGenDoneCb = document.getElementById('pf-af-trigger-generation-done');
    const triggerSendClickCb = document.getElementById('pf-af-trigger-send-click');
    const nameInput = document.getElementById('pf-af-name');

    const condType = document.getElementById('pf-af-cond-type');
    const condXmlBlock = document.getElementById('pf-af-cond-xml-block');
    const condTextRow = document.getElementById('pf-af-cond-text-row');
    const condTextLabel = document.getElementById('pf-af-cond-text-label');
    const condTextInput = document.getElementById('pf-af-cond-text');
    const condCaseRow = document.getElementById('pf-af-cond-case-row');
    const condCaseCb = document.getElementById('pf-af-cond-case');
    const condDepthInput = document.getElementById('pf-af-cond-depth');

    const effModeSelect = document.getElementById('pf-af-eff-mode');
    const effMatchBlock = document.getElementById('pf-af-eff-match-block');
    const effManualBlock = document.getElementById('pf-af-eff-manual-block');
    const effType = document.getElementById('pf-af-eff-type');
    const effXmlBlock = document.getElementById('pf-af-eff-xml-block');
    const effTextRow = document.getElementById('pf-af-eff-text-row');
    const effTextLabel = document.getElementById('pf-af-eff-text-label');
    const effTextInput = document.getElementById('pf-af-eff-text');
    const effCaseRow = document.getElementById('pf-af-eff-case-row');
    const effCaseCb = document.getElementById('pf-af-eff-case');
    const effFoldersList = document.getElementById('pf-af-eff-folders-list');
    const effPromptsList = document.getElementById('pf-af-eff-prompts-list');

    const hint = document.getElementById('pf-af-hint');
    const submitBtn = document.getElementById('pf-af-submit');
    const submitLabel = document.getElementById('pf-af-submit-label');
    const cancelEditBtn = document.getElementById('pf-af-cancel-edit');
    const listEl = document.getElementById('pf-af-list');

    disableAllCb.checked = !!settings().autoFilterDisabled;
    disableAllCb.addEventListener('change', () => {
        const s = settings();
        s.autoFilterDisabled = disableAllCb.checked;
        save();
        scheduleAutoFilterEval(0);
        hint.textContent = disableAllCb.checked ? 'All auto filters disabled.' : 'Auto filters re-enabled.';
    });

    // Both of these are independent, freely-combinable checkboxes (see tryHookSendAbortIcon's
    // header comment for why they're separate settings rather than one) — read fresh on every
    // click/generation-end, so toggling either here takes effect immediately without needing to
    // close and reopen the modal.
    triggerGenDoneCb.checked = !!settings().autoFilterOnGenerationDone;
    triggerGenDoneCb.addEventListener('change', () => {
        const s = settings();
        s.autoFilterOnGenerationDone = triggerGenDoneCb.checked;
        save();
    });
    triggerSendClickCb.checked = !!settings().autoFilterOnSendClick;
    triggerSendClickCb.addEventListener('change', () => {
        const s = settings();
        s.autoFilterOnSendClick = triggerSendClickCb.checked;
        save();
    });

    // Both the condition and effect sides get their own XML picker (see createXmlPicker's header
    // comment in bulk-match.js) — completely independent of each other, same as every other part
    // of a rule's condition/effect split. Both scan (null, 'filter') for their checklists, same
    // as the old per-tag Value dropdowns did — the actual live evaluation
    // (xmlConditionGroups/computeAutoEffectTargets above) uses Auto Filter's own 'auto' exclusion
    // set regardless of what scanned the checklist.
    const condXmlPicker = createXmlPicker(condXmlBlock, { getScopePath: () => null, getMode: () => 'filter' });
    const effXmlPicker = createXmlPicker(effXmlBlock, { getScopePath: () => null, getMode: () => 'filter' });

    function updateCondVisibility() {
        const def = autoMatchDef(condType.value);
        condXmlBlock.style.display = def?.kind === 'xml' ? '' : 'none';
        condTextRow.style.display = (def?.kind === 'regex' || def?.kind === 'word') ? 'flex' : 'none';
        condCaseRow.style.display = def?.kind === 'word' ? 'flex' : 'none';
        if (def?.kind === 'regex') { condTextLabel.textContent = 'Regex'; condTextInput.placeholder = 'e.g. \\btavern\\b'; }
        if (def?.kind === 'word') { condTextLabel.textContent = 'Word'; condTextInput.placeholder = 'e.g. tavern'; }
    }
    condType.addEventListener('change', updateCondVisibility);
    updateCondVisibility();

    function updateEffMatchTypeVisibility() {
        const def = autoMatchDef(effType.value);
        effXmlBlock.style.display = def?.kind === 'xml' ? '' : 'none';
        effTextRow.style.display = (def?.kind === 'regex' || def?.kind === 'word') ? 'flex' : 'none';
        effCaseRow.style.display = def?.kind === 'word' ? 'flex' : 'none';
        if (def?.kind === 'regex') { effTextLabel.textContent = 'Regex'; effTextInput.placeholder = 'e.g. \\btavern\\b'; }
        if (def?.kind === 'word') { effTextLabel.textContent = 'Word'; effTextInput.placeholder = 'e.g. tavern'; }
    }
    function renderManualChecklists() {
        const s = settings();
        effFoldersList.innerHTML = '';
        const folderPaths = [ROOT, ...s.folders.slice().sort((a, b) => a.localeCompare(b))];
        for (const path of folderPaths) {
            const label = document.createElement('label');
            label.style.cssText = 'display:flex; align-items:center; gap:6px; padding:2px 0; cursor:pointer;';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = path;
            cb.className = 'pf-af-eff-folder-cb';
            label.appendChild(cb);
            label.appendChild(document.createTextNode(path === ROOT ? '📥 Unfiled' : path));
            effFoldersList.appendChild(label);
        }
        effPromptsList.innerHTML = '';
        if (!liveCache.length) { effPromptsList.appendChild(el('div', 'pf-empty-hint', { text: 'No prompts found — open AI Response Configuration once, then Refresh.' })); return; }
        for (const p of liveCache) {
            const label = document.createElement('label');
            label.style.cssText = 'display:flex; align-items:center; gap:6px; padding:2px 0; cursor:pointer;';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = p.identifier;
            cb.className = 'pf-af-eff-prompt-cb';
            label.appendChild(cb);
            label.appendChild(document.createTextNode(p.name));
            effPromptsList.appendChild(label);
        }
    }
    function updateEffVisibility() {
        const mode = effModeSelect.value;
        effMatchBlock.style.display = mode === 'match' ? '' : 'none';
        effManualBlock.style.display = mode === 'manual' ? '' : 'none';
        if (mode === 'manual') renderManualChecklists();
        else updateEffMatchTypeVisibility();
    }
    effModeSelect.addEventListener('change', updateEffVisibility);
    effType.addEventListener('change', updateEffMatchTypeVisibility);
    updateEffVisibility();

    function collectCheckedValues(container, cls) {
        return Array.from(container.querySelectorAll(`.${cls}:checked`)).map(cb => cb.value);
    }
    function setCheckedValues(container, cls, values) {
        const set = new Set(values || []);
        container.querySelectorAll(`.${cls}`).forEach(cb => { cb.checked = set.has(cb.value); });
    }

    function resetForm() {
        autoFilterEditingId = null;
        nameInput.value = '';
        condType.value = AUTO_MATCH_TYPES[0].key;
        condXmlPicker.reset();
        condTextInput.value = '';
        condCaseCb.checked = false;
        condDepthInput.value = '0';
        updateCondVisibility();
        effModeSelect.value = 'match';
        document.querySelector('input[name="pf-af-action"][value="enable"]').checked = true;
        effType.value = AUTO_MATCH_TYPES[0].key;
        effXmlPicker.reset();
        effTextInput.value = '';
        effCaseCb.checked = false;
        document.querySelector('input[name="pf-af-eff-target"][value="prompt"]').checked = true;
        updateEffVisibility();
        submitLabel.textContent = 'Add filter';
        cancelEditBtn.style.display = 'none';
        hint.textContent = '';
    }

    async function loadFilterIntoForm(filter) {
        autoFilterEditingId = filter.id;
        nameInput.value = filter.name || '';

        condType.value = filter.condition?.matchType || AUTO_MATCH_TYPES[0].key;
        updateCondVisibility();
        const condDef = autoMatchDef(condType.value);
        if (condDef?.kind === 'xml') {
            await condXmlPicker.setTagAndParams(filter.condition?.xmlTag, filter.condition?.xmlParams);
        } else if (condDef?.kind === 'regex' || condDef?.kind === 'word') {
            condTextInput.value = filter.condition?.value || '';
        }
        condCaseCb.checked = condDef?.kind === 'word' && !!filter.condition?.caseSensitive;
        condDepthInput.value = String(filter.condition?.depth ?? 0);

        document.querySelector(`input[name="pf-af-action"][value="${filter.action === 'disable' ? 'disable' : 'enable'}"]`).checked = true;

        effModeSelect.value = filter.effect?.mode || 'match';
        updateEffVisibility();
        if (filter.effect?.mode === 'manual') {
            setCheckedValues(effFoldersList, 'pf-af-eff-folder-cb', filter.effect.manualFolders);
            setCheckedValues(effPromptsList, 'pf-af-eff-prompt-cb', filter.effect.manualPrompts);
        } else {
            effType.value = filter.effect?.matchType || AUTO_MATCH_TYPES[0].key;
            updateEffMatchTypeVisibility();
            const effDef = autoMatchDef(effType.value);
            if (effDef?.kind === 'xml') {
                await effXmlPicker.setTagAndParams(filter.effect?.xmlTag, filter.effect?.xmlParams);
            } else if (effDef?.kind === 'regex' || effDef?.kind === 'word') {
                effTextInput.value = filter.effect?.text || '';
            }
            effCaseCb.checked = effDef?.kind === 'word' && !!filter.effect?.caseSensitive;
            const targetVal = filter.effect?.target || 'prompt';
            const targetRadio = document.querySelector(`input[name="pf-af-eff-target"][value="${targetVal}"]`);
            if (targetRadio) targetRadio.checked = true;
        }

        submitLabel.textContent = 'Update filter';
        cancelEditBtn.style.display = '';
        hint.textContent = `Editing "${filter.name}" — change fields above and click "Update filter", or "Cancel edit".`;
    }

    function renderList() {
        const s = settings();
        listEl.innerHTML = '';
        const groups = buildFilterGroups(listEl, 'autoFilters', s.autoFilters, renderList, () => scheduleAutoFilterEval(0));
        if (!s.autoFilters.length) { listEl.appendChild(el('div', 'pf-empty-hint', { text: 'No auto filters yet.' })); return; }
        for (const filter of s.autoFilters) {
            const row = el('div', 'pf-prompt-row');
            row.dataset.filterId = filter.id;

            const dragHandle = el('span', 'pf-icon-btn fa-solid fa-grip-vertical', { title: 'Drag to reorder (execution order)' });

            const enableCb = document.createElement('input');
            enableCb.type = 'checkbox';
            enableCb.title = 'Enable/disable this filter';
            enableCb.checked = filter.enabled !== false;
            enableCb.addEventListener('change', () => {
                const s2 = settings();
                const f2 = s2.autoFilters.find(x => x.id === filter.id);
                if (f2) { f2.enabled = enableCb.checked; save(); scheduleAutoFilterEval(0); }
            });

            const info = el('span', 'pf-prompt-name');
            info.innerHTML = `<b>${s.autoFilters.indexOf(filter) + 1}. ${escapeHtml(filter.name || 'Filter')}</b><br><span style="opacity:.7; font-size:0.85em">${escapeHtml(describeAutoFilter(filter))}</span>`;

            const editBtn = el('span', 'pf-icon-btn fa-solid fa-pen', { title: 'Edit this filter' });
            editBtn.addEventListener('click', () => loadFilterIntoForm(filter));

            const delBtn = el('span', 'pf-icon-btn fa-solid fa-trash', { title: 'Remove this filter' });
            delBtn.addEventListener('click', () => {
                const s2 = settings();
                s2.autoFilters = s2.autoFilters.filter(x => x.id !== filter.id);
                save();
                if (autoFilterEditingId === filter.id) resetForm();
                renderList();
                scheduleAutoFilterEval(0);
            });

            row.appendChild(dragHandle);
            row.appendChild(enableCb);
            row.appendChild(info);
            row.appendChild(editBtn);
            row.appendChild(delBtn);

            attachAutoFilterDnd(row, filter.id, () => { renderList(); scheduleAutoFilterEval(0); });
            groups.add(row, filter);
        }
    }

    submitBtn.addEventListener('click', () => {
        const name = nameInput.value.trim() || `Filter ${settings().autoFilters.length + 1}`;

        const condDef = autoMatchDef(condType.value);
        const depth = Math.max(0, parseInt(condDepthInput.value, 10) || 0);
        let condValue = '', condXmlTag = '', condXmlParams = [];
        if (condDef?.kind === 'xml') {
            condXmlTag = condXmlPicker.getTag();
            condXmlParams = condXmlPicker.getParams();
            if (depth > 0 && !condXmlTag) { hint.textContent = 'Enter a condition XML tag.'; return; }
        } else if (condDef?.kind === 'regex' || condDef?.kind === 'word') {
            condValue = condTextInput.value.trim();
            if (depth > 0 && !condValue) { hint.textContent = `Enter a condition ${condDef.kind} to search for.`; return; }
            if (condDef.kind === 'regex' && condValue) { try { new RegExp(condValue); } catch { hint.textContent = 'That condition regex is not valid.'; return; } }
        }

        const effMode = effModeSelect.value;
        let effect;
        if (effMode === 'manual') {
            const manualPrompts = collectCheckedValues(effPromptsList, 'pf-af-eff-prompt-cb');
            const manualFolders = collectCheckedValues(effFoldersList, 'pf-af-eff-folder-cb');
            if (manualPrompts.length === 0 && manualFolders.length === 0) { hint.textContent = 'Check at least one prompt or folder for the effect.'; return; }
            effect = { mode: 'manual', manualPrompts, manualFolders };
        } else {
            const effDef = autoMatchDef(effType.value);
            const target = document.querySelector('input[name="pf-af-eff-target"]:checked')?.value || 'prompt';
            let text = '', effXmlTag = '', effXmlParams = [];
            if (effDef?.kind === 'xml') {
                effXmlTag = effXmlPicker.getTag();
                effXmlParams = effXmlPicker.getParams();
                if (!effXmlTag) { hint.textContent = 'Enter an effect XML tag.'; return; }
            } else if (effDef?.kind === 'regex' || effDef?.kind === 'word') {
                text = effTextInput.value.trim();
                if (!text) { hint.textContent = `Enter an effect ${effDef.kind} to search for.`; return; }
                if (effDef.kind === 'regex') { try { new RegExp(text); } catch { hint.textContent = 'That effect regex is not valid.'; return; } }
            }
            effect = { mode: 'match', matchType: effType.value, xmlTag: effXmlTag, xmlParams: effXmlParams, text, target, caseSensitive: effDef?.kind === 'word' && !!effCaseCb.checked };
        }

        const condition = { matchType: condType.value, value: condValue, xmlTag: condXmlTag, xmlParams: condXmlParams, depth, caseSensitive: condDef?.kind === 'word' && !!condCaseCb.checked };
        const action = document.querySelector('input[name="pf-af-action"]:checked')?.value === 'disable' ? 'disable' : 'enable';

        const s = settings();
        if (autoFilterEditingId) {
            const existing = s.autoFilters.find(f => f.id === autoFilterEditingId);
            if (existing) { existing.name = name; existing.condition = condition; existing.effect = effect; existing.action = action; }
        } else {
            s.autoFilters.push({ id: `af_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, name, enabled: true, action, condition, effect });
        }
        save();
        resetForm();
        renderList();
        scheduleAutoFilterEval(0);
    });

    cancelEditBtn.addEventListener('click', resetForm);
    document.getElementById('pf-af-reeval').addEventListener('click', async () => {
        hint.textContent = 'Re-evaluating…';
        const result = await evaluateAutoFilters();
        if (!result.ok) {
            const reasonText = {
                disabled: 'Auto filters are turned off — see the checkbox at the top of this window.',
                empty: 'There are no auto filters to run yet.',
                'no-prompts': "Couldn't see any prompts — open AI Response Configuration once, then try Refresh in the main panel.",
                busy: 'Already re-evaluating — try again in a moment.',
            }[result.reason] || "Couldn't run the auto filters.";
            hint.textContent = reasonText;
            return;
        }
        hint.textContent = result.rulesRun === 0
            ? 'Re-evaluated — no enabled auto filters to run.'
            : `Re-evaluated ${result.rulesRun} rule${result.rulesRun === 1 ? '' : 's'} — ${result.prompts} prompt(s) and ${result.folders} folder(s) changed.`;
    });
    document.getElementById('pf-af-remove-all').addEventListener('click', () => {
        if (!confirm('Remove every auto filter? This cannot be undone.')) return;
        const s = settings();
        s.autoFilters = [];
        save();
        resetForm();
        renderList();
        scheduleAutoFilterEval(0);
    });

    resetForm();
    renderList();
}
