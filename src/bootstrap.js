import { isPromptSuppressed, renderTree, scheduleRenderTree } from './render.js';
import { closeOwnOverlays, findPromptListEl, getOaiModule, readLivePrompts, syncNativePromptOrder } from './native.js';
import { buildDock } from './panel.js';
import { scheduleAutoFilterEval, tryHookChatEvents, tryHookSendAbortIcon } from './auto-filter.js';
import { SELECTORS, flattenPromptOrder, save, settings } from './state.js';

// ---------- Native-popup awareness + live DOM watchers + startup ----------
//
// Two independent "keep this panel in sync with the outside world" watchers, plus the actual
// jQuery-ready bootstrap at the bottom that starts the whole extension.

/** True if `node` is part of this panel's own UI and should never itself count as "a popup
 *  we need to get out of the way of" — otherwise the generic fallback below would see our own
 *  dock/modals as foreign overlays and immediately hide behind them. */
function isOwnUiNode(node) {
    if (!(node instanceof HTMLElement)) return false;
    if (node.id && node.id.startsWith('pf-')) return true;
    const cls = typeof node.className === 'string' ? node.className : (node.className?.baseVal || '');
    return /(^|\s)pf-/.test(cls);
}

/** Generic, version-agnostic fallback for "is some other popup/dialog/drawer currently open":
 *  rather than depending on this extension knowing SillyTavern's (or some other extension's)
 *  exact popup class names — which is exactly the kind of thing that breaks silently on a
 *  future update — this walks every direct child of <body> and asks whether it LOOKS like an
 *  overlay: a real open <dialog>, something with role="dialog"/"alertdialog", or something
 *  whose id/class mentions popup/modal/dialog/drawer/overlay, and which is actually visible.
 *  Combined with the specific SELECTORS.popupContainers list (checked first, cheap and precise)
 *  this catches popups this panel doesn't have — and can't have — explicit knowledge of. */
function isForeignOverlayVisible() {
    const isKnownVisible = sel => {
        const els = document.querySelectorAll(sel);
        for (const e of els) {
            if (sel === 'dialog[open]') { if (e.open) return true; continue; }
            if (e.offsetParent !== null) return true;
        }
        return false;
    };
    if (SELECTORS.popupContainers.some(isKnownVisible)) return true;

    for (const node of document.body.children) {
        if (!(node instanceof HTMLElement) || isOwnUiNode(node)) continue;
        const isOpenDialog = node.tagName === 'DIALOG' ? node.open : true;
        if (!isOpenDialog) continue;
        const visible = node.tagName === 'DIALOG' ? node.open : node.offsetParent !== null;
        if (!visible) continue;
        const role = (node.getAttribute('role') || '').toLowerCase();
        const idClass = `${node.id || ''} ${typeof node.className === 'string' ? node.className : ''}`.toLowerCase();
        // Deliberately NOT matching "drawer" here — ST's persistent side drawers/nav panels can
        // legitimately stay visible for long stretches and aren't something this panel needs to
        // duck behind, unlike an actual modal popup/dialog sitting on top of the page.
        if (role === 'dialog' || role === 'alertdialog' || /popup|modal|dialog/.test(idClass)) return true;
    }
    return false;
}

/** Watches for a click on the native prompt editor's own Save control (SELECTORS.popupSaveBtn) —
 *  wherever it is in the DOM, capture-phase so it sees the click before Save's own handler can
 *  possibly stop it — and schedules a refresh shortly after. This is deliberately independent of
 *  watchNativePopups()/isForeignOverlayVisible(): the editor isn't guaranteed to be a floating
 *  popup/dialog on every SillyTavern version or skin (it can be an inline panel that never
 *  registers as an "overlay" at all), and even where it is, hitting Save doesn't necessarily
 *  close it — so "did an overlay disappear" isn't a reliable signal for "content was saved" the
 *  way it is for Delete's confirmation. Listening for the Save click itself is. */
export function watchNativeSaveButton() {
    document.addEventListener('click', ev => {
        if (!ev.target.closest?.(SELECTORS.popupSaveBtn)) return;
        clearTimeout(watchNativeSaveButton._t);
        // A little longer than the popup-close refresh: give ST's own save handler (which runs
        // after this same click) time to actually persist the change before we re-read it.
        watchNativeSaveButton._t = setTimeout(renderTree, 300);
    }, true);
}

/** Whether the native prompt editor is believed open right now, per watchNativeEditorGuard()'s
 *  explicit open/close signals (see below) — combined with isForeignOverlayVisible()'s generic
 *  detection by applyPopupOpenState() so either signal is enough to count as "open". */
let editorBelievedOpen = false;

/** Applies the current "is some native popup/editor open" verdict (isForeignOverlayVisible()'s
 *  generic detection OR editorBelievedOpen's explicit signal — see watchNativeEditorGuard) to the
 *  body-level CSS class, and reacts to the open/closed transition exactly as the doc comment on
 *  watchNativePopups() describes. Shared by both watchNativePopups()'s mutation-driven polling and
 *  watchNativeEditorGuard()'s explicit click-driven signal, so the two can't fight each other by
 *  each keeping their own separate idea of whether the class should be set. */
function applyPopupOpenState() {
    const open = editorBelievedOpen || isForeignOverlayVisible();
    const wasOpen = document.body.classList.contains('pf-native-popup-open');
    document.body.classList.toggle('pf-native-popup-open', open);
    if (open && !wasOpen) closeOwnOverlays();
    if (!open && wasOpen) {
        // A single debounced refresh shortly after the popup disappears — not a burst of
        // several. Cleared/reset on every call so a flurry of close/reopen doesn't stack up
        // a pile of pending renders on top of each other.
        clearTimeout(applyPopupOpenState._closeT);
        applyPopupOpenState._closeT = setTimeout(renderTree, 250);
    }
}

/** Detects whenever ANY native SillyTavern popup is open — not just ones this panel itself
 *  opened, since the New Prompt / Edit Prompt window can also be reached other ways — and
 *  toggles a body-level class while one is. The matching CSS (see style.css) drops this
 *  panel's persistent pieces (the dock and its minimized restore button) low enough that a
 *  native popup can never end up visually underneath them. This matters specifically for
 *  SillyTavern versions where popups are still legacy positioned <div>s rather than real
 *  <dialog> elements — a real <dialog> opened via showModal() already renders in the browser's
 *  top layer, immune to any of this panel's z-index, but that can't be assumed on every
 *  version, so this covers both. Also closes this panel's own transient overlays (context
 *  menu, View/Preview/bulk-match modals) the moment a native popup appears, as a backstop
 *  alongside the proactive closeOwnOverlays() calls at each place this panel opens one itself —
 *  and, going the other way, refreshes this panel's tree the moment a native popup disappears,
 *  so a rename, content edit, toggle, or a prompt inserted via ST's own "Insert prompt" shows up
 *  here right away rather than waiting on the list-mutation observer or the next 4s poll. */
export function watchNativePopups() {
    const nativePopupObserver = new MutationObserver(() => {
        clearTimeout(watchNativePopups._t);
        watchNativePopups._t = setTimeout(applyPopupOpenState, 30);
    });
    nativePopupObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'style', 'class'] });
    applyPopupOpenState();
}

/** Explicit fallback for the same "is a native popup open" question watchNativePopups() answers
 *  generically — needed because the prompt editor isn't guaranteed to look like a detectable
 *  overlay at all (same reasoning as watchNativeSaveButton() above): rather than trying to spot
 *  it opening/closing after the fact, this listens for the actions that open it (clicking a
 *  prompt's edit icon, or the footer's New/Insert prompt buttons) and the actions that close it
 *  (Save, Close/Cancel, or Escape) directly, and sets editorBelievedOpen accordingly so
 *  applyPopupOpenState() ducks this panel behind it immediately — before the editor has even
 *  finished rendering — rather than only after the fact. */
export function watchNativeEditorGuard() {
    document.addEventListener('click', ev => {
        const target = ev.target;
        if (target.closest?.(SELECTORS.editAction) || target.closest?.(SELECTORS.footerNewBtn) || target.closest?.(SELECTORS.footerInsertBtn)) {
            editorBelievedOpen = true;
            applyPopupOpenState();
        } else if (target.closest?.(SELECTORS.popupSaveBtn) || target.closest?.(SELECTORS.popupCloseBtn)) {
            editorBelievedOpen = false;
            applyPopupOpenState();
        }
    }, true);
    document.addEventListener('keydown', ev => {
        if (ev.key === 'Escape' && editorBelievedOpen) {
            editorBelievedOpen = false;
            applyPopupOpenState();
        }
    }, true);
}

let sendOrderSyncInstalled = false;

/** Synchronizes the native Prompt Manager's underlying order and visible list from the exact
 *  top-to-bottom order shown by this extension immediately before SillyTavern handles a click on
 *  "Send a message". Capture phase is intentional: the in-memory `prompt_order` mutation must
 *  happen before ST reads that array to assemble the request. */
export function watchSendOrderSync() {
    if (sendOrderSyncInstalled) return;
    sendOrderSyncInstalled = true;

    // Prime the compatibility-safe dynamic import well before the first send click so the click
    // path itself can update prompt_order synchronously.
    void getOaiModule();
    document.addEventListener('click', ev => {
        if (!ev.target?.closest?.(SELECTORS.sendButton)) return;
        syncNativePromptOrder(flattenPromptOrder());
    }, true);
}

let observer = null;
let observedListEl = null;
let pollTimer = null;

/** Mirrors a deliberate click in SillyTavern's original Prompt Manager into the extension's
 *  intended-state map. Programmatic clicks made by this extension occur while #pf-dock is busy
 *  and are ignored here. If a containing folder is muted, the native click is also ignored as
 *  an intended-state change; renderTree's suppression repair turns that row back off natively. */
let nativeToggleStateSyncInstalled = false;
export function watchNativeToggleStateSync() {
    if (nativeToggleStateSyncInstalled) return;
    nativeToggleStateSyncInstalled = true;
    document.addEventListener('click', ev => {
        if (!ev.target?.closest?.(SELECTORS.toggleAction)) return;
        const row = ev.target.closest(SELECTORS.promptItem);
        const list = findPromptListEl();
        if (!row || !list?.contains(row)) return;
        if (document.getElementById('pf-dock')?.classList.contains('pf-processing')) return;
        const identifier = row.getAttribute('data-pm-identifier') || row.dataset.pmIdentifier;
        if (!identifier) return;

        setTimeout(() => {
            const p = readLivePrompts()?.find(item => item.identifier === identifier);
            if (!p) return;
            const s = settings();
            if (!isPromptSuppressed(p, s)) {
                s.promptDesired[identifier] = !!p.enabled;
                save();
            }
            renderTree();
        }, 0);
    }, true);
}
/** Keeps the tree in sync with the live Prompt Manager DOM even without any action taken through
 *  this panel: watches the list element itself for class-attribute mutations (a targeted, narrow
 *  observer — see the comment on its `attributeFilter` below for why), plus a body-level
 *  observer that re-attaches if SillyTavern ever swaps in a whole new list element (e.g.
 *  switching presets/characters), plus a 4-second poll as a last-resort catch-all. Called once
 *  from buildDock() at startup. */
export function watchPromptManager() {
    const attach = () => {
        const list = findPromptListEl();
        if (!list) return false;
        if (observer) observer.disconnect();
        observedListEl = list;
        observer = new MutationObserver(() => {
            scheduleRenderTree(120);
        });
        // Filtered to 'class' only (not every attribute, not characterData): SillyTavern's own
        // list re-renders trigger class changes we already want to catch, and renderTree() here
        // also mutates the native list itself (reorderNativeList), so watching too broadly makes
        // this observer see its own side effects and re-fire — filtering keeps that feedback
        // loop from turning into a runaway render storm. A renamed prompt's text is caught
        // instead by the popup-close refresh below (watchNativePopups) and the periodic poll.
        observer.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
        return true;
    };

    if (attach()) return;

    const bodyObserver = new MutationObserver(() => {
        if (attach()) bodyObserver.disconnect();
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });

    // Belt-and-suspenders, two ways:
    //  1. If SillyTavern ever replaces the whole prompt-list element with a new node (rather
    //     than mutating the one we're observing in place — e.g. switching presets/characters),
    //     our MutationObserver keeps watching the old, now-detached node and silently stops
    //     seeing anything. Detect that by re-checking findPromptListEl() against what we're
    //     actually observing, and re-attach if it's changed — cheap, since this only runs on
    //     the 4s poll tick below, not on every mutation.
    //  2. A plain periodic refresh as a last-resort catch-all for anything the above still
    //     misses (e.g. a renamed prompt's text, which a class-filtered observer won't see),
    //     same as before.
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
        const current = findPromptListEl();
        if (current && current !== observedListEl) attach();
        renderTree();
    }, 4000);
}

/** Extension entry point: builds the dock UI, starts watching for native popups opening/closing
 *  (so this panel's tree refreshes right after a native Edit/Delete/Rename popup closes, instead
 *  of waiting on the DOM-mutation observer or the 4s poll), best-effort hooks live chat events
 *  and the send/abort icon transitions for Auto Filter (see tryHookChatEvents/
 *  tryHookSendAbortIcon in auto-filter.js), and kicks off an initial Auto Filter pass shortly
 *  after (giving the Prompt Manager and chat both a moment to finish their own first render
 *  first). buildDock() itself starts watchPromptManager() once the dock exists. */
jQuery(async () => {
    buildDock();
    watchNativePopups();
    watchNativeEditorGuard();
    watchNativeSaveButton();
    watchSendOrderSync();
    watchNativeToggleStateSync();
    tryHookChatEvents();
    tryHookSendAbortIcon();
    scheduleAutoFilterEval(1000); // let the prompt manager + chat both finish their own first render
});
