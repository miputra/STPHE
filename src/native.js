import { getContext } from '../../../../extensions.js';
import { closeAutoFilterModal } from './auto-filter.js';
import { closeBulkMatchModal } from './bulk-match.js';
import { closeContextMenu } from './context-menu.js';
import { assignPrompt } from './folders.js';
import { closeImportConflictsModal, restorePromptsFromImport } from './import-export.js';
import { liveCache, promptByIdentifier, renderTree } from './render.js';
import { SELECTORS, el, escapeHtml, flattenPromptOrder, moveEntryInOrder, save, settings, toastError, toastWarn } from './state.js';

// ---------- Reading / driving the live Prompt Manager DOM ----------

/** Finds SillyTavern's live Prompt Manager `<ul>`/`<ol>` element in the current DOM, or `null`
 *  if it isn't currently rendered (e.g. not on a Chat Completion API, or that panel hasn't been
 *  opened yet this session). Every other DOM read/write in this file goes through this. */
export function findPromptListEl() {
    return document.querySelector(SELECTORS.promptList);
}

/** Reads a prompt row's display name: prefers the dedicated name element (SELECTORS.promptName),
 *  falling back to the row's whole text content with control icons stripped out, and finally to
 *  the raw identifier if even that comes up empty. */
function extractName(li) {
    const found = li.querySelector(SELECTORS.promptName);
    if (found && found.textContent.trim()) return found.textContent.trim();
    const clone = li.cloneNode(true);
    clone.querySelectorAll('.prompt_manager_prompt_controls, i, [class*="action"]').forEach(n => n.remove());
    const text = clone.textContent.replace(/\s+/g, ' ').trim();
    return text || li.getAttribute('data-pm-identifier') || '(unnamed prompt)';
}

/** Finds the clickable edit (pencil) icon within a prompt row `li`, if this prompt is editable. */
function findEditEl(li) {
    return li.querySelector(SELECTORS.editAction);
}

/** Reads a prompt row's current enabled/disabled state directly from its DOM classes. */
function isEnabled(li) {
    // The clickable wrapper and the element that
    // actually carries the fa-toggle-on/fa-toggle-off class may not be the same node (e.g. a
    // wrapper span around an icon). Search the whole row for whichever element has the state
    // class, rather than trusting the click target to have it directly — that mismatch was
    // causing state reads to always come back the same regardless of the prompt's real state.
    const iconEl = li.querySelector('.fa-toggle-on, .fa-toggle-off');
    if (iconEl) return iconEl.classList.contains('fa-toggle-on');
    return !li.classList.contains('disabled_prompt') && !li.classList.contains('prompt-disabled');
}

/**
 * @returns {Array<{identifier:string, name:string, enabled:boolean, editable:boolean}>|null}
 * null means the Prompt Manager isn't currently rendered (e.g. not on a Chat Completion API).
 */
export function readLivePrompts() {
    const list = findPromptListEl();
    if (!list) return null;
    const items = Array.from(list.querySelectorAll(SELECTORS.promptItem));
    return items.map(li => ({
        identifier: li.getAttribute('data-pm-identifier') || li.dataset.pmIdentifier || '',
        name: cachedOaiModule?.promptManager?.getPromptById?.(li.getAttribute('data-pm-identifier'))?.name ?? extractName(li),
        enabled: isEnabled(li),
        editable: !!findEditEl(li),
    })).filter(p => p.identifier);
}

/** Finds a specific prompt's `<li>` row in the live list by its native identifier. */
function findLiElement(identifier) {
    const list = findPromptListEl();
    if (!list) return null;
    return list.querySelector(`li[data-pm-identifier="${CSS.escape(identifier)}"]`);
}

/** Builds one identifier -> row lookup for a read-only verification pass over the current native
 *  prompt list. Applying native clicks deliberately does not reuse this map: some SillyTavern
 *  versions rebuild the list after each click, which immediately makes cached row nodes stale. */
function indexPromptRows() {
    const list = findPromptListEl();
    if (!list) return null;
    const rows = new Map();
    list.querySelectorAll(SELECTORS.promptItem).forEach(li => {
        const id = li.getAttribute('data-pm-identifier') || li.dataset.pmIdentifier || '';
        if (id) rows.set(id, li);
    });
    return rows;
}

let toggleQueue = Promise.resolve();
let queuedToggles = 0;

function setNativeToggleBusy(busy, promptCount = 1) {
    const dock = document.getElementById('pf-dock');
    if (!dock) return;
    dock.classList.toggle('pf-processing', busy);
    dock.setAttribute('aria-busy', String(busy));
    for (const child of dock.children) {
        if (child.id === 'pf-processing-overlay') continue;
        child.toggleAttribute('inert', busy);
    }
    document.getElementById('pf-processing-overlay')?.setAttribute('aria-hidden', String(!busy));
    const label = document.getElementById('pf-processing-label');
    if (label && busy) label.textContent = `Applying ${promptCount} prompt change${promptCount === 1 ? '' : 's'}…`;
}

export function toggleWithRetry(identifier, enabled) {
    return toggleManyWithRetry([{ identifier, enabled }]);
}

/** Serialize batches against the native model, never against stale DOM snapshots. A single
 * context calculation and awaited list render replace N racing click-triggered renders. */
export function toggleManyWithRetry(changes) {
    const desired = new Map((changes || []).filter(x => x?.identifier).map(x => [x.identifier, !!x.enabled]));
    if (!desired.size) return Promise.resolve(true);
    if (!queuedToggles && cachedOaiModule?.promptManager) {
        const manager = cachedOaiModule.promptManager;
        const rows = indexPromptRows();
        if (rows && [...desired].every(([id, enabled]) => {
            const entry = manager.getPromptOrderEntry(manager.activeCharacter, id);
            return entry && !!entry.enabled === enabled && rows.has(id) && isEnabled(rows.get(id)) === enabled;
        })) {
            renderTree();
            return Promise.resolve(true);
        }
    }
    queuedToggles++;
    setNativeToggleBusy(true, desired.size);
    const operation = toggleQueue.then(async () => {
        const mod = await getOaiModule();
        const manager = mod?.promptManager;
        if (!manager?.activeCharacter || typeof manager.renderPromptManagerListItems !== 'function') {
            throw new Error('The native Prompt Manager is unavailable. Open AI Response Configuration and retry.');
        }
        const entries = [...desired].map(([id, enabled]) => {
            const entry = manager.getPromptOrderEntry(manager.activeCharacter, id);
            if (!entry) throw new Error(`Prompt is no longer in the active preset: ${id}`);
            return { id, enabled, entry };
        });
        const changed = entries.filter(x => !!x.entry.enabled !== x.enabled);
        if (changed.length) {
            const counts = manager.tokenHandler.getCounts();
            for (const { id, enabled, entry } of changed) {
                entry.enabled = enabled;
                counts[id] = null;
            }
            // Persist through ST's own service hook, once for the entire batch.
            // Native toggles schedule debounced persistence without waiting for its timer.
            // Completion here means the model and rendered controls agree, not that the
            // unrelated settings-save debounce has expired.
            void manager.saveServiceSettings()?.catch(error => toastError(`Could not save prompt settings: ${error.message}`));
            try { await manager.tryGenerate(); }
            catch (error) { console.warn('[STPHE] Token calculation failed', error); }
        }
        const beforeRender = indexPromptRows();
        if (changed.length || !beforeRender || entries.some(({ id, enabled }) => !beforeRender.has(id) || isEnabled(beforeRender.get(id)) !== enabled)) {
            await manager.renderPromptManager();
            await manager.renderPromptManagerListItems();
            manager.makeDraggable();
        }
        const rows = indexPromptRows();
        if (!rows || entries.some(({ id, enabled, entry }) => !!entry.enabled !== enabled || !rows.has(id) || isEnabled(rows.get(id)) !== enabled)) {
            throw new Error('The native prompt list did not finish applying the requested states. Refresh and retry.');
        }
        return true;
    }).catch(error => {
        toastError(error.message || 'Could not apply prompt changes.');
        return false;
    }).finally(async () => {
        // Render before unlocking, so there is no stale visual frame after loading disappears.
        try {
            renderTree();
            // Let the browser paint the updated controls before dismissing the overlay.
            // Frames, not a fixed delay; hidden tabs do not wait on throttled animation frames.
            if (typeof requestAnimationFrame === 'function' && document.visibilityState === 'visible') {
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            }
        } finally {
            queuedToggles--;
            if (!queuedToggles) setNativeToggleBusy(false);
        }
    });
    toggleQueue = operation;
    return operation;
}

/** Opens SillyTavern's own prompt editor for this identifier (view + edit content, role, etc.).
 *  Closes our own overlays first — see closeOwnOverlays — since this is the one choke point
 *  practically every "open the real editor" path in this file already goes through. */
export function openNativeEditor(identifier) {
    const li = findLiElement(identifier);
    if (!li) return false;
    const editBtn = findEditEl(li);
    if (!editBtn) return false;
    closeOwnOverlays();
    // Native editing opens its own popup, even while the configuration drawer is closed.
    editBtn.click();
    return true;
}

let isReorderingNative = false;

/** Best-effort: physically moves the native <li> elements to match our top-to-bottom order,
 *  and nudges SillyTavern with a few common events in case it needs one to notice/persist the
 *  change. This can't be guaranteed to work on every ST version since the underlying save
 *  mechanism isn't something we have confirmed access to — but this is what "the order here
 *  should be the real order" needs, and it degrades harmlessly (no-op) if it can't find the list.
 *  Skips entirely if the current native order already matches, so it can't loop with the
 *  MutationObserver that watches this same list. */
export function reorderNativeList(desiredIdentifierOrder) {
    if (isReorderingNative) return false;
    const list = findPromptListEl();
    if (!list) return false;

    const liMap = new Map();
    const currentOrder = [];
    list.querySelectorAll(SELECTORS.promptItem).forEach(li => {
        const id = li.getAttribute('data-pm-identifier') || li.dataset.pmIdentifier;
        if (id) { liMap.set(id, li); currentOrder.push(id); }
    });

    const known = new Set(desiredIdentifierOrder);
    const filteredCurrent = currentOrder.filter(id => known.has(id));
    const alreadyMatches = filteredCurrent.length === desiredIdentifierOrder.length
        && filteredCurrent.every((id, i) => id === desiredIdentifierOrder[i]);
    if (alreadyMatches) return true;

    isReorderingNative = true;
    try {
        let anchor = null;
        for (const id of desiredIdentifierOrder) {
            const li = liMap.get(id);
            if (!li) continue;
            if (anchor === null) list.insertBefore(li, list.firstChild);
            else anchor.after(li);
            anchor = li;
        }
        try {
            if (window.jQuery) {
                const $list = window.jQuery(list);
                $list.trigger('sortupdate');
                $list.trigger('sortstop');
            }
            list.dispatchEvent(new Event('change', { bubbles: true }));
        } catch { /* best-effort only, ignore */ }
    } finally {
        isReorderingNative = false;
    }
    return true;
}

/** Makes this extension's flattened visual order the real active Prompt Manager order in both
 *  places SillyTavern can read it from:
 *   1. `oai_settings.prompt_order` (the durable/in-memory source used when ST rebuilds the list
 *      or assembles a generation request), and
 *   2. the currently-rendered native Prompt Manager DOM.
 *
 *  Each existing order object is moved rather than recreated, preserving its `enabled` flag and
 *  any version-specific fields SillyTavern may attach to it. Entries that aren't represented in
 *  the extension tree are retained after the known prompts instead of being deleted. The normal
 *  send-click hook primes the dynamic OpenAI-module import at startup, making the data mutation
 *  synchronous when the user later clicks Send; if the module is still loading, the DOM is fixed
 *  immediately and the data sync is completed as soon as access becomes available. */
export function syncNativePromptOrder(desiredIdentifierOrder = flattenPromptOrder()) {
    const desired = [...new Set((desiredIdentifierOrder || []).filter(Boolean))];
    let dataSynced = false;

    const oai = cachedOaiModule?.oai_settings;
    if (Array.isArray(oai?.prompt_order)) {
        const orderEntry = findPromptOrderEntry(oai);
        if (Array.isArray(orderEntry?.order)) {
            const existing = orderEntry.order;
            const firstByIdentifier = new Map();
            for (const item of existing) {
                const id = item?.identifier;
                if (id && !firstByIdentifier.has(id)) firstByIdentifier.set(id, item);
            }

            const consumed = new Set();
            const reordered = [];
            for (const id of desired) {
                const item = firstByIdentifier.get(id);
                if (!item) continue;
                reordered.push(item);
                consumed.add(item);
            }
            // Never silently discard native-only, malformed, or duplicate entries.
            for (const item of existing) if (!consumed.has(item)) reordered.push(item);

            const changed = reordered.length !== existing.length
                || reordered.some((item, index) => item !== existing[index]);
            if (changed) {
                existing.splice(0, existing.length, ...reordered);
                save();
            }
            dataSynced = true;
        }
    } else if (!oai) {
        // getOaiModule() is deliberately dynamic for cross-version compatibility. Usually this
        // was already primed at startup; this fallback completes the persistence step if Send is
        // clicked unusually early while that import is still resolving.
        void getOaiModule().then(mod => {
            if (mod?.oai_settings) syncNativePromptOrder(desired);
        });
    }

    const domSynced = reorderNativeList(desired);
    return dataSynced || domSynced;
}

/** Finds the Prompt Manager's footer (the row of Insert/Delete/Import/Export/Reset/New Prompt
 *  controls), preferring one that's a DOM ancestor-relative of the prompt list we already found
 *  over a page-wide class guess, so it can't accidentally match an unrelated footer. */
function findFooterEl() {
    // Prefer a footer that lives in the same ancestor as the prompt list we already know
    // works, rather than a document-wide class guess that could match an unrelated element.
    const list = findPromptListEl();
    if (list) {
        let container = list.parentElement;
        for (let i = 0; i < 5 && container; i++) {
            const scoped = container.querySelector(SELECTORS.footer);
            if (scoped) return scoped;
            container = container.parentElement;
        }
    }
    const candidates = document.querySelectorAll(SELECTORS.footer);
    for (const c of candidates) if (c.offsetParent !== null) return c;
    return candidates[0] || null;
}

/** The footer's action buttons, left to right: Insert prompt, Delete prompt, Import prompt
 *  list, Export prompt list, Reset current character, New prompt (the select box comes first
 *  but is handled separately). Confirmed positions, so this is matched by DOM order first
 *  (most reliable — sidesteps guessing exact class/title names entirely), falling back to
 *  title-based selectors only if the button count doesn't match what's expected. */
function getFooterActions(footer) {
    if (!footer) return {};
    const buttons = Array.from(footer.querySelectorAll('a, .menu_button')).filter(elx => {
        // Exclude anything that's just an icon nested inside one of these — count each
        // clickable action once, and skip the <select> itself.
        return elx.tagName !== 'SELECT' && !elx.querySelector('a, .menu_button');
    });
    if (buttons.length === 6) {
        return {
            insert: buttons[0],
            delete: buttons[1],
            importList: buttons[2],
            exportList: buttons[3],
            reset: buttons[4],
            newPrompt: buttons[5],
        };
    }
    return {
        insert: footer.querySelector(SELECTORS.footerInsertBtn),
        delete: footer.querySelector(SELECTORS.footerDeleteBtn),
        importList: footer.querySelector(SELECTORS.footerImportBtn),
        exportList: footer.querySelector(SELECTORS.footerExportBtn),
        reset: footer.querySelector(SELECTORS.footerResetBtn),
        newPrompt: footer.querySelector(SELECTORS.footerNewBtn),
    };
}

/** Best-effort only — used opportunistically to grab a name input near an open editor.
 *  Nothing critical depends on this succeeding. */
/** Finds whichever native popup/dialog is currently open on screen, if any. */
function getOpenPopup() {
    for (const sel of SELECTORS.popupContainers) {
        const list = document.querySelectorAll(sel);
        for (const e of list) {
            if (e.open || e.offsetParent !== null) return e;
        }
    }
    return null;
}

/** Returns every currently-visible `<textarea>` on the page — used to detect which one just
 *  appeared when the native editor opens (see peekContentViaPopup). */
function visibleTextareas() {
    return Array.from(document.querySelectorAll('textarea')).filter(t => t.offsetParent !== null);
}

/** Closes whatever native editor is currently open. Tries increasingly generic approaches so it
 *  doesn't depend on guessing SillyTavern's exact popup class names:
 *  1. An actual <dialog> element's own .close() (fully scoped, no side effects elsewhere).
 *  2. A visible button matching common close/cancel selectors.
 *  3. An Escape keydown dispatched on the editor field itself, bubbling up naturally — this is
 *     the standard way virtually every modal/dialog implementation closes, and dispatching it
 *     on the specific field (rather than blindly on `document`) keeps it scoped to whatever
 *     component that field actually belongs to. */
function closeAnyOpenPopup(hintEl) {
    const dialog = document.querySelector('dialog[open]');
    if (dialog) {
        try { dialog.close(); return; } catch { /* fall through */ }
    }
    const closeBtn = Array.from(document.querySelectorAll(SELECTORS.popupCloseBtn)).find(b => b.offsetParent !== null);
    if (closeBtn) { closeBtn.click(); return; }

    const target = (hintEl && hintEl.isConnected) ? hintEl : (document.activeElement || document.body);
    const escapeEvent = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent('keydown', escapeEvent));
    target.dispatchEvent(new KeyboardEvent('keyup', escapeEvent));
}

/** Closes every one of THIS panel's own transient overlays (right-click menu, the read-only
 *  View modal, the Full Preview modal, the bulk-match modal). Called right before anything that
 *  opens a native SillyTavern popup (New Prompt, Edit Prompt, Rename, native Delete's own
 *  confirmation, etc.) so our own floating UI can never end up visually sitting on top of — or
 *  behind, stealing clicks from — the native window the user actually needs to interact with.
 *  See also watchNativePopups(), which handles the same concern for the persistent dock itself. */
export function closeOwnOverlays() {
    closeContextMenu();
    closeViewModal();
    closeFullPreview();
    closeBulkMatchModal();
    closeAutoFilterModal();
    closeImportConflictsModal();
}

// ---------- Native add / delete / rename / view flows ----------

/** VIEW and Preview read prompt content two ways, in order of preference:
 *   1. Directly from SillyTavern's own settings module, via a *dynamic* import (safe: wrapped
 *      in try/catch, so if the path or export doesn't exist on some version, this just silently
 *      fails and we fall back to (2) — it can never crash the extension, unlike a static import
 *      at the top of the file would).
 *   2. Briefly opening the native editor, reading its content field, and closing it again.
 *  (1) is strongly preferred because it never opens any real editor at all — nothing to
 *  accidentally leave open, nothing the user could edit by mistake. */
let oaiModulePromise = null;
let cachedOaiModule = null;

/** Attempts (once — result cached) to dynamically import SillyTavern's own openai.js module, for
 *  direct read access to oai_settings.prompts / prompt_order. Returns the module, or `null` if
 *  the import failed or didn't shape up as expected (see the strategy note above). */
export async function getOaiModule() {
    oaiModulePromise ??= import('../../../../openai.js').then(mod => {
        if (mod?.oai_settings && Array.isArray(mod.oai_settings.prompts)) cachedOaiModule = mod;
        return cachedOaiModule;
    }).catch(() => null);
    return oaiModulePromise;
}

/** Reads a prompt's content straight from SillyTavern's own settings module, if getOaiModule()
 *  managed to load it — the preferred, non-popup-opening way to read a prompt's content. */
async function getPromptContentDirect(identifier) {
    const mod = await getOaiModule();
    const prompts = mod?.oai_settings?.prompts;
    if (!Array.isArray(prompts)) return null;
    const found = prompts.find(p => p && p.identifier === identifier);
    if (!found) return null;
    return { content: found.content ?? '', name: found.name ?? '' };
}

/** Finds a name not already used by an existing prompt, so repeated "New prompt" clicks don't
 *  collide ("New Prompt", "New Prompt 2", "New Prompt 3", ...). */
function uniquePromptName(baseName, prompts) {
    const existingNames = new Set(prompts.map(p => (p?.name || '').trim()));
    if (!existingNames.has(baseName)) return baseName;
    let i = 2;
    while (existingNames.has(`${baseName} ${i}`)) i++;
    return `${baseName} ${i}`;
}

/** Finds whatever holds "which prompts are actually in the active list, in what order" for the
 *  current character — tried first by character id (from the official getContext() API), then
 *  as a fallback by finding whichever prompt_order entry's identifiers overlap most with what
 *  we can already see live in the DOM (our one source of ground truth), so a wrong guess at the
 *  character-id field name doesn't leave this completely unable to work. */
export function findPromptOrderEntry(oai) {
    const orderList = Array.isArray(oai?.prompt_order) ? oai.prompt_order : null;
    if (!orderList) return null;

    let chId;
    try { chId = getContext?.()?.characterId; } catch { chId = undefined; }
    if (chId !== undefined) {
        const byChar = orderList.find(e => String(e?.character_id) === String(chId));
        if (byChar && Array.isArray(byChar.order)) return byChar;
    }

    const liveIds = new Set(liveCache.map(p => p.identifier));
    let best = null;
    let bestScore = 0;
    for (const entry of orderList) {
        if (!Array.isArray(entry?.order)) continue;
        const score = entry.order.filter(o => liveIds.has(o?.identifier)).length;
        if (score > bestScore) { bestScore = score; best = entry; }
    }
    return best;
}

/** Refresh the native list directly, including when no anchor prompt remains after deletion. */
export async function forceNativeRerender(callback) {
    const manager = (await getOaiModule())?.promptManager;
    if (!manager) { toastError('The native Prompt Manager is unavailable.'); return; }
    try {
        await manager.renderPromptManager();
        await manager.renderPromptManagerListItems();
        manager.makeDraggable();
        callback?.();
    } catch (error) { toastError(`Could not refresh the native prompt list: ${error.message}`); }
}

/** Creates a new prompt directly and inserts it into the active list at the requested position,
 *  ready to fill in via Edit — bypassing SillyTavern's own "New prompt" popup/flow entirely.
 *
 *  This writes straight into SillyTavern's live settings rather than driving native buttons,
 *  which is more direct but also more speculative: it clones an *existing* prompt's shape as a
 *  template (so we're not guessing ST's exact required fields for the prompt itself), and only
 *  proceeds with placing it in the active list if it can confidently identify where that list's
 *  underlying data lives. If anything doesn't match what's expected, it backs out the change
 *  and tells you clearly, rather than risk leaving your settings in an inconsistent state. */
export async function directCreatePrompt(parentPath, afterEntry) {
    const mod = await getOaiModule();
    const oai = mod?.oai_settings;
    const prompts = oai?.prompts;
    if (!Array.isArray(prompts) || prompts.length === 0) {
        toastError('Could not access SillyTavern\'s prompt settings directly on this version, so I can\'t create a prompt automatically. Please use "New prompt" + "Insert prompt" in AI Response Configuration for now.');
        return;
    }

    const template = prompts.find(p => p && p.marker !== true) || prompts[0];
    const identifier = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `pf-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const name = uniquePromptName('New Prompt', prompts);
    const newPrompt = { ...template, identifier, name, content: '', marker: false, system_prompt: false, enabled: true };
    prompts.push(newPrompt);

    const orderEntry = findPromptOrderEntry(oai);
    if (!orderEntry) {
        prompts.pop(); // undo — don't leave an orphaned definition with nowhere to see or use it
        toastError('Created the prompt definition but couldn\'t confidently find where your active prompt list is stored, so I backed it out rather than risk leaving things inconsistent. Please use "New prompt" + "Insert prompt" in AI Response Configuration instead.');
        return;
    }

    let insertAt = orderEntry.order.length;
    if (afterEntry?.type === 'prompt') {
        const idx = orderEntry.order.findIndex(o => o?.identifier === afterEntry.key);
        if (idx !== -1) insertAt = idx + 1;
    }
    orderEntry.order.splice(insertAt, 0, { identifier, enabled: true });
    save();

    forceNativeRerender(() => {
        assignPrompt(identifier, parentPath || null);
        moveEntryInOrder({ type: 'prompt', key: identifier }, parentPath, null, afterEntry);
        save();
        renderTree();
        setTimeout(() => openNativeEditor(identifier), 150); // hand it straight to the user to fill in
    });
}

/** Public entry point for "add a new prompt here" — thin wrapper around directCreatePrompt(). */
export function requestNewPromptAfter(parentPath, afterEntry) {
    directCreatePrompt(parentPath, afterEntry);
}

/** Drives SillyTavern's own native delete flow: selects `identifier` in the footer's prompt
 *  `<select>` and clicks the native Delete button (which shows ST's own confirmation). Returns
 *  false if the footer's select/delete control can't be found. */
function deletePromptNative(identifier) {
    const footer = findFooterEl();
    const actions = getFooterActions(footer);
    const select = footer?.querySelector(SELECTORS.footerSelect);
    if (!select || !actions.delete) return false;
    closeOwnOverlays();
    select.value = identifier;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    actions.delete.click();
    return true;
}

/** Full "delete prompt entirely" flow for prompt `p`: confirms with the user, drives the native
 *  delete (deletePromptNative), then cleans up this extension's own folder assignment and filter
 *  exclusions for it and re-renders. */
export function deletePromptFlow(p) {
    if (!confirm(`Delete prompt "${p.name}" entirely? This removes its definition from the preset — not just this list — and cannot be undone.`)) return;
    const ok = deletePromptNative(p.identifier);
    if (!ok) {
        toastError('Could not find the native delete control. You can still delete it from AI Response Configuration.');
        return;
    }
    assignPrompt(p.identifier, null);
    delete settings().excludedPrompts[p.identifier];
    delete settings().excludedAutoPrompts[p.identifier];
    delete settings().promptDesired[p.identifier];
    save();
    setTimeout(renderTree, 150);
}

/** The "soft" counterpart to deletePromptFlow: removes this identifier's entry from the active
 *  character's order only — found the same way directCreatePrompt finds it to insert into — and
 *  leaves the prompt's actual definition in oai_settings.prompts untouched. The row disappears
 *  from this list exactly like a normal remove, but the prompt itself still exists and can be
 *  brought back later via SillyTavern's own "Insert prompt" dropdown, or by re-importing a
 *  prompt list that references it (see restorePromptsFromImport). Its folder assignment here is
 *  deliberately left in place, so if it does come back it re-appears in the same folder.
 *  Speculative in the same way directCreatePrompt is (direct settings access, not a documented
 *  API) — fails clearly and changes nothing if it can't confidently locate the order list. */
export async function unlistPromptFlow(p) {
    if (!confirm(
        `Remove "${p.name}" from this list?\n\n` +
        `This only unlists it here — the prompt definition itself is kept, and can be brought back ` +
        `later via "Insert prompt" in AI Response Configuration (or by re-importing a prompt list ` +
        `that references it). Use "Delete prompt entirely" instead if you want it gone for good.`
    )) return;

    const mod = await getOaiModule();
    const oai = mod?.oai_settings;
    if (!Array.isArray(oai?.prompts)) {
        toastError('Could not access SillyTavern\'s prompt settings directly on this version, so I can\'t unlist without deleting. You can still use "Delete prompt entirely."');
        return;
    }
    const orderEntry = findPromptOrderEntry(oai);
    if (!orderEntry) {
        toastError('Couldn\'t confidently find where your active prompt list is stored, so I didn\'t change anything. You can still use "Delete prompt entirely."');
        return;
    }
    const idx = orderEntry.order.findIndex(o => o?.identifier === p.identifier);
    if (idx === -1) {
        toastError('Could not find this prompt in the active list.');
        return;
    }
    orderEntry.order.splice(idx, 1);
    save();
    forceNativeRerender(renderTree);
}

/** Removes every id in `idSet` from `arr` in place (via splice, back-to-front so indices stay
 *  valid), using `getId(item)` to read each element's identifier. Shared plumbing for the two
 *  bulk delete helpers below, so a "delete folder + everything inside it" only needs one pass
 *  per array touched instead of one native delete per prompt (which would mean one native
 *  confirmation popup per prompt). */
function removeMatchingIdentifiers(arr, idSet, getId) {
    for (let i = arr.length - 1; i >= 0; i--) {
        if (idSet.has(getId(arr[i]))) arr.splice(i, 1);
    }
}

/** Bulk counterpart to unlistPromptFlow: removes every identifier in `identifiers` from the
 *  active order only (same lookup as directCreatePrompt/unlistPromptFlow), leaving each prompt's
 *  actual definition in oai_settings.prompts untouched — same guarantee as the single-prompt
 *  version, each one can still be brought back later via "Insert prompt" or a re-import. Used by
 *  "Delete folder + prompts inside (not permanently)". Returns the number actually removed, or -1
 *  if it couldn't confidently find where the active list lives (nothing is changed in that case).
 *  No confirmation dialog here — the caller (render.js) already confirmed once for the whole
 *  batch, which is the entire point versus driving the native per-prompt delete flow. */
export async function bulkUnlistPrompts(identifiers) {
    if (!identifiers.length) return 0;
    const mod = await getOaiModule();
    const oai = mod?.oai_settings;
    if (!Array.isArray(oai?.prompts)) return -1;
    const orderEntry = findPromptOrderEntry(oai);
    if (!orderEntry || !Array.isArray(orderEntry.order)) return -1;
    const idSet = new Set(identifiers);
    const before = orderEntry.order.length;
    removeMatchingIdentifiers(orderEntry.order, idSet, o => o?.identifier);
    return before - orderEntry.order.length;
}

/** Bulk counterpart to deletePromptFlow: removes every identifier in `identifiers`'s definition
 *  from oai_settings.prompts entirely, plus every reference to it across every character's active
 *  order (not just the current one) — same reach as native "Delete prompt entirely", just without
 *  a native confirmation popup per prompt. Used by "Delete folder + prompts inside PERMANENTLY".
 *  Returns the number of definitions actually removed, or -1 on the same "couldn't find settings"
 *  footing as bulkUnlistPrompts. Cannot be undone. */
export async function bulkDeletePromptsPermanently(identifiers) {
    if (!identifiers.length) return 0;
    const mod = await getOaiModule();
    const oai = mod?.oai_settings;
    if (!Array.isArray(oai?.prompts)) return -1;
    const idSet = new Set(identifiers);
    const before = oai.prompts.length;
    removeMatchingIdentifiers(oai.prompts, idSet, p => p?.identifier);
    if (Array.isArray(oai.prompt_order)) {
        for (const entry of oai.prompt_order) {
            if (Array.isArray(entry?.order)) removeMatchingIdentifiers(entry.order, idSet, o => o?.identifier);
        }
    }
    return before - oai.prompts.length;
}

/** Opens the native editor and focuses its name field so the user can immediately retype it
 *  and hit the native Save button — renaming always goes through ST's own save, never ours. */
export function renamePromptNative(identifier) {
    const ok = openNativeEditor(identifier);
    if (!ok) { toastError('Could not open the editor for this prompt.'); return; }
    setTimeout(() => {
        const popup = getOpenPopup();
        const input = popup?.querySelector(SELECTORS.popupNameInput);
        if (input) { input.focus(); input.select?.(); }
    }, 150);
}

/** Briefly opens the native editor to read a prompt's current content, then closes it again —
 *  never leaving the real editable form sitting open. Finds the content field by diffing which
 *  textareas are visible before/after opening the editor, rather than guessing the popup's
 *  container class name, so it works even if the editor isn't a conventional "popup" at all.
 *  Resolves with { content, name }, or null if the editor couldn't be opened at all. */
export async function peekContent(identifier) {
    const direct = await getPromptContentDirect(identifier);
    if (direct) return direct;
    return peekContentViaPopup(identifier);
}

/** Fallback for peekContent() when direct settings access isn't available: briefly opens the
 *  native editor, diffs which textareas just appeared to find the content field, reads its
 *  value (and, best-effort, a name input in the same popup), then closes the editor again
 *  without saving. Resolves `{content, name}`, or `null` if the editor couldn't be opened. */
function peekContentViaPopup(identifier) {
    return new Promise(resolve => {
        const before = new Set(visibleTextareas());
        const ok = openNativeEditor(identifier);
        if (!ok) { resolve(null); return; }
        setTimeout(() => {
            const after = visibleTextareas();
            const newlyAppeared = after.filter(t => !before.has(t));
            // Prefer a textarea that just appeared (almost certainly the editor's content field);
            // fall back to the largest visible textarea on the page otherwise.
            const candidates = newlyAppeared.length ? newlyAppeared : after;
            candidates.sort((a, b) => (b.value?.length || 0) - (a.value?.length || 0));
            const textarea = candidates[0] || null;
            const content = textarea ? textarea.value : null;

            // Best-effort: look for a name input in the same popup, if we can identify one.
            const popup = getOpenPopup();
            const nameInput = popup?.querySelector(SELECTORS.popupNameInput);
            const name = nameInput?.value;

            closeAnyOpenPopup(textarea);
            setTimeout(() => {
                // Verify it actually closed; if the same field is still visible, something's
                // still open on screen (this extension has no further way to force it closed
                // safely, so at least tell the user rather than leave them confused).
                if (textarea && textarea.isConnected && textarea.offsetParent !== null) {
                    toastWarn('The native prompt editor may still be open on screen — you can close it manually.');
                }
                resolve({ content, name });
            }, 150);
        }, 200);
    });
}

/** Simple whitespace-split word count, used for the word/token estimates shown in the view and
 *  full-preview modals. */
function wordCount(text) {
    if (!text) return 0;
    const trimmed = text.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Rough estimate only (~4 chars/token, a common approximation) — not ST's real tokenizer.
 *  Labeled as an estimate everywhere it's shown; check AI Response Configuration for the
 *  exact figure ST computes. */
function estimateTokens(text) {
    return Math.round((text || '').length / 4);
}

/** VIEW is intentionally independent of EDIT: it briefly opens the native editor to read the
 *  current content, then closes it again immediately (see closeAnyOpenPopup), and shows a
 *  read-only preview in our own modal. Nothing here can save/modify the prompt. */
export async function viewPrompt(identifier, fallbackName) {
    const peeked = await peekContent(identifier);
    if (!peeked) { toastError('Could not open this prompt to read it.'); return; }
    const content = peeked.content ?? '(no content field found)';
    const name = peeked.name || fallbackName;
    showViewModal(name, identifier, content);
}

/** Belt-and-suspenders read-only lock: sets the property AND the attribute, and blocks
 *  keydown/paste as a backstop, so this textarea cannot become editable regardless of cause. */
export function lockTextareaReadOnly(textarea) {
    textarea.readOnly = true;
    textarea.setAttribute('readonly', 'readonly');
    textarea.addEventListener('keydown', ev => ev.preventDefault());
    textarea.addEventListener('paste', ev => ev.preventDefault());
    textarea.addEventListener('drop', ev => ev.preventDefault());
}

/** Builds and shows the read-only "View prompt" modal: header with name/identifier, a
 *  word/token estimate, a locked read-only textarea with the content, and an "Edit this prompt"
 *  button that hands off to the real native editor. */
function showViewModal(name, identifier, content) {
    closeViewModal();
    const overlay = el('div', 'pf-view-overlay');
    overlay.id = 'pf-view-overlay';
    overlay.innerHTML = `
        <div class="pf-view-modal">
            <div class="pf-view-header">
                <b>${escapeHtml(name)}</b>
                <span class="pf-view-id">${escapeHtml(identifier)}</span>
                <span class="pf-icon-btn fa-solid fa-xmark" id="pf-view-close" title="Close"></span>
            </div>
            <div class="pf-view-stats">${wordCount(content)} words · ~${estimateTokens(content)} tokens (estimate)</div>
            <textarea class="pf-view-content" readonly spellcheck="false"></textarea>
            <div class="pf-view-footer">
                <span class="pf-view-hint">Read-only preview — editing here does nothing.</span>
                <div class="menu_button" id="pf-view-edit-btn"><i class="fa-solid fa-pen-to-square"></i>&nbsp;Edit this prompt</div>
            </div>
        </div>`;
    const contentArea = overlay.querySelector('.pf-view-content');
    contentArea.value = content;
    lockTextareaReadOnly(contentArea);
    document.body.appendChild(overlay);
    document.getElementById('pf-view-close').addEventListener('click', closeViewModal);
    overlay.addEventListener('click', ev => { if (ev.target === overlay) closeViewModal(); });
    document.getElementById('pf-view-edit-btn').addEventListener('click', () => {
        closeViewModal();
        openNativeEditor(identifier);
    });
}

/** Removes the read-only "View prompt" modal from the DOM, if it's open. */
function closeViewModal() {
    document.getElementById('pf-view-overlay')?.remove();
}

/** Reads every currently-enabled prompt's content (in current top-to-bottom order) and shows
 *  them concatenated in one modal, with a running word/token estimate — a way to actually see
 *  what's being assembled without opening each prompt one at a time. This peeks each prompt
 *  sequentially (native editor open → read → close), so it takes a moment for larger presets;
 *  a progress line shows while it works. */
export async function showFullPreview() {
    closeFullPreview();
    closeViewModal();

    const overlay = el('div', 'pf-view-overlay');
    overlay.id = 'pf-full-overlay';
    overlay.innerHTML = `
        <div class="pf-view-modal pf-full-modal">
            <div class="pf-view-header">
                <b>Full Prompt Preview</b>
                <span class="pf-icon-btn fa-solid fa-xmark" id="pf-full-close" title="Close"></span>
            </div>
            <div class="pf-view-stats" id="pf-full-stats">Reading prompts…</div>
            <div class="pf-full-content" id="pf-full-content"></div>
        </div>`;
    document.body.appendChild(overlay);
    document.getElementById('pf-full-close').addEventListener('click', closeFullPreview);
    overlay.addEventListener('click', ev => { if (ev.target === overlay) closeFullPreview(); });

    const statsEl = document.getElementById('pf-full-stats');
    const contentEl = document.getElementById('pf-full-content');

    const order = flattenPromptOrder();
    const enabledOrdered = order.map(id => promptByIdentifier(id)).filter(p => p && p.enabled);

    if (enabledOrdered.length === 0) {
        statsEl.textContent = 'No enabled prompts to show.';
        return;
    }

    let totalWords = 0;
    let totalChars = 0;
    const sections = [];
    for (let i = 0; i < enabledOrdered.length; i++) {
        const p = enabledOrdered[i];
        if (!document.getElementById('pf-full-overlay')) return; // closed mid-scan
        statsEl.textContent = `Reading prompt ${i + 1} of ${enabledOrdered.length}: ${p.name}…`;
        const peeked = await peekContent(p.identifier);
        const text = peeked?.content ?? '(could not read this prompt\'s content)';
        totalWords += wordCount(text);
        totalChars += text.length;
        sections.push({ name: p.name, identifier: p.identifier, text, words: wordCount(text) });
    }

    if (!document.getElementById('pf-full-overlay')) return; // closed mid-scan

    statsEl.textContent = `${enabledOrdered.length} enabled prompt${enabledOrdered.length === 1 ? '' : 's'} · ${totalWords} words · ~${estimateTokens('x'.repeat(totalChars))} tokens (estimate — check AI Response Configuration for ST's exact count)`;
    contentEl.innerHTML = '';
    for (const section of sections) {
        const sectionEl = el('div', 'pf-full-section');
        sectionEl.innerHTML = `<div class="pf-full-section-header">
            <b>${escapeHtml(section.name)}</b>
            <span class="pf-view-id">${escapeHtml(section.identifier)}</span>
            <span class="pf-full-section-words">${section.words} words</span>
        </div>`;
        const textarea = el('textarea', 'pf-full-section-content');
        textarea.spellcheck = false;
        textarea.value = section.text;
        lockTextareaReadOnly(textarea);
        sectionEl.appendChild(textarea);
        contentEl.appendChild(sectionEl);
    }
}

/** Removes the "Full Prompt Preview" modal from the DOM, if it's open. */
function closeFullPreview() {
    document.getElementById('pf-full-overlay')?.remove();
}

// ---------- Folder mutations ----------
