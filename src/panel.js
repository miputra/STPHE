import { openAutoFilterModal, scheduleAutoFilterEval } from './auto-filter.js';
import { watchPromptManager } from './bootstrap.js';
import { openBulkMatchModal } from './bulk-match.js';
import { showContextMenu } from './context-menu.js';
import { createFolder } from './folders.js';
import { exportFolderStructure, importFolderStructure, importFolderStructureMerge } from './import-export.js';
import { requestNewPromptAfter, showFullPreview } from './native.js';
import { attachTreeBackgroundDeselect, openRemoveAllMenu, promptOrNull, renderTree, searchTerm } from './render.js';
import { ROOT, el, save, settings } from './state.js';

// ---------- Pinned floating panel ----------
//
// The dock's own chrome: header (drag handle, grow/shrink/side-toggle/minimize), toolbar
// (Refresh/Folder/Prompt/Preview/Filter/Auto Filter/Import-Export/Remove All — Remove All sits
// right in line with the Import/Export button rather than up in the header, since it's a
// document-scoped action like the rest of the toolbar), search box, and the #pf-tree container
// that render.js fills in. Position/size/side/open state all persist in settings().ui and are
// restored on load.

/** Returns the dock's inner HTML — header chrome, toolbar buttons, search box, status line,
 *  and the empty #pf-tree container render.js renders into. Built once by buildDock(). */
function panelHtml() {
    return `
    <div class="pf-header" id="pf-drag-handle">
        <span class="pf-header-icon fa-solid fa-folder-tree"></span>

        <b>Prompt Folders</b>
        <span class="pf-header-spacer"></span>
        <span class="pf-icon-btn fa-solid fa-up-right-and-down-left-from-center" id="pf-grow" title="Make panel bigger"></span>
        <span class="pf-icon-btn fa-solid fa-down-left-and-up-right-to-center" id="pf-shrink" title="Make panel smaller"></span>
        <span class="pf-icon-btn fa-solid fa-arrow-right-arrow-left" id="pf-side-toggle" title="Move to other side"></span>
        <span class="pf-icon-btn fa-solid fa-minus" id="pf-minimize" title="Minimize"></span>
    </div>
    <div class="pf-body" id="pf-body">
        <div class="pf-toolbar">
            <div class="menu_button menu_button_icon" id="pf-refresh" title="Rescan Prompt Manager">
                <i class="fa-solid fa-rotate"></i><span>Refresh</span>
            </div>
            <div class="menu_button menu_button_icon" id="pf-new-folder" title="New top-level folder">
                <i class="fa-solid fa-folder-plus"></i><span>Folder</span>
            </div>
            <div class="menu_button menu_button_icon" id="pf-new-prompt" title="Add a new prompt">
                <i class="fa-solid fa-plus"></i><span>Prompt</span>
            </div>
            <div class="menu_button menu_button_icon" id="pf-preview" title="Preview full compiled prompt + word/token count">
                <i class="fa-solid fa-file-lines"></i><span>Preview</span>
            </div>
            <div class="menu_button menu_button_icon pf-icon-only" id="pf-bulk-match" title="Filter: enable/disable prompts by content match (XML tag / word / regex)">
                <i class="fa-solid fa-filter"></i>
            </div>
            <div class="menu_button menu_button_icon pf-icon-only pf-toolbar-warning" id="pf-auto-filter" title="Auto Filter: enable/disable prompts automatically based on recent chat content — UNTESTED!! use with caution">
                <i class="fa-solid fa-wand-magic-sparkles"></i>
            </div>
            <div class="menu_button menu_button_icon pf-icon-only" id="pf-import-export" title="Import / Export a folder structure as JSON">
                <i class="fa-solid fa-file-import"></i>
            </div>
            <div class="menu_button menu_button_icon pf-icon-only pf-toolbar-danger" id="pf-remove-all" title="Remove ALL prompts and/or folders (choose exactly what and whether it's permanent)">
                <i class="fa-solid fa-trash-can"></i>
            </div>
        </div>
        <input type="text" id="pf-search" class="text_pole" placeholder="Search prompts…" />
        <div class="pf-status" id="pf-status"></div>
        <div class="pf-order-hint">Dragging here reorders the real prompt list top-to-bottom (best-effort — verify in AI Response Configuration if unsure).</div>
        <div id="pf-tree"></div>
    </div>
    <div class="pf-resize-edge" id="pf-resize-edge" title="Drag to resize width"></div>
    <div class="pf-resize-handle" id="pf-resize-handle" title="Drag to resize"></div>
    <div class="pf-processing-overlay" id="pf-processing-overlay" aria-hidden="true" aria-live="polite">
        <i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>
        <span id="pf-processing-label">Applying prompt changes…</span>
    </div>`;
}

/** Clamps a candidate dock width to a sane range (260px minimum, up to 760px or the viewport
 *  width minus a margin, whichever is smaller). */
function clampWidth(w) { return Math.min(Math.max(w, 260), Math.min(760, window.innerWidth - 40)); }
/** Clamps a candidate dock height to a sane range (240px minimum, viewport height minus a margin). */
function clampHeight(h) { return Math.min(Math.max(h, 240), window.innerHeight - 40); }
/** Clamps the dock's `top` position so it never drifts off the top or bottom of the viewport,
 *  given its current rendered `dockHeight`. */
function clampTop(top, dockHeight) {
    const max = Math.max(10, window.innerHeight - dockHeight - 10);
    return Math.min(Math.max(top, 10), max);
}

/** Applies the current settings().ui (top/width/height/side/open) to the actual dock element
 *  and its minimized restore button — the single place that turns saved UI state into real
 *  CSS. Called after any UI-state change (drag, resize, side toggle, minimize, window resize). */
function applyDockPosition(dock) {
    if (!dock) return;
    const ui = settings().ui;
    dock.style.top = `${ui.top}px`;
    dock.style.width = `${ui.width}px`;
    dock.style.height = `${ui.height}px`;
    dock.classList.toggle('pf-dock-left', ui.side === 'left');
    dock.classList.toggle('pf-dock-right', ui.side === 'right');
    dock.style.left = ui.side === 'left' ? '0px' : '';
    dock.style.right = ui.side === 'right' ? '0px' : '';
    dock.style.display = ui.open ? 'flex' : 'none';

    const restoreBtn = document.getElementById('pf-restore-btn');
    if (restoreBtn) {
        restoreBtn.style.display = ui.open ? 'none' : 'flex';
        restoreBtn.style.right = ui.side === 'right' ? '20px' : '';
        restoreBtn.style.left = ui.side === 'left' ? '20px' : '';
    }
}

/** Nudges the dock's saved width/height by a fixed delta (used by the grow/shrink header
 *  buttons), clamping and re-applying afterward. */
function adjustSize(deltaW, deltaH) {
    const ui = settings().ui;
    ui.width = clampWidth(ui.width + deltaW);
    ui.height = clampHeight(ui.height + deltaH);
    save();
    applyDockPosition(document.getElementById('pf-dock'));
}

/** Wires up dragging the dock vertically by its header `handle` (mouse and touch), updating
 *  and persisting settings().ui.top as it moves. Ignores drags that start on a header icon
 *  button, so those remain clickable rather than initiating a drag. */
function makeDraggable(dock, handle) {
    let dragging = false;
    let startY = 0;
    let startTop = 0;

    const onDown = ev => {
        if (ev.target.closest('.pf-icon-btn')) return;
        dragging = true;
        const point = ev.touches ? ev.touches[0] : ev;
        startY = point.clientY;
        startTop = settings().ui.top;
        document.body.style.userSelect = 'none';
    };
    const onMove = ev => {
        if (!dragging) return;
        const point = ev.touches ? ev.touches[0] : ev;
        const delta = point.clientY - startY;
        const ui = settings().ui;
        ui.top = clampTop(startTop + delta, dock.offsetHeight);
        dock.style.top = `${ui.top}px`;
    };
    const onUp = () => {
        if (!dragging) return;
        dragging = false;
        document.body.style.userSelect = '';
        save();
    };

    handle.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    handle.addEventListener('touchstart', onDown, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onUp);
}

/** Wires up resizing the dock by dragging `handle` (mouse and touch), updating and persisting
 *  settings().ui.width/height as it moves. `widthOnly` is used for the full-height side edge
 *  strip (width-only resize), as opposed to the corner handle (both dimensions); width resizing
 *  is mirrored for a left-docked panel so dragging always feels like it's moving the visible edge. */
function makeResizable(dock, handle, { widthOnly = false } = {}) {
    let resizing = false;
    let startX = 0, startY = 0, startW = 0, startH = 0;

    const onDown = ev => {
        resizing = true;
        const point = ev.touches ? ev.touches[0] : ev;
        startX = point.clientX;
        startY = point.clientY;
        const ui = settings().ui;
        startW = ui.width;
        startH = ui.height;
        document.body.style.userSelect = 'none';
        ev.stopPropagation();
    };
    const onMove = ev => {
        if (!resizing) return;
        const point = ev.touches ? ev.touches[0] : ev;
        const ui = settings().ui;
        const dx = point.clientX - startX;
        const dy = point.clientY - startY;
        const widthDelta = ui.side === 'left' ? dx : -dx;
        ui.width = clampWidth(startW + widthDelta);
        if (!widthOnly) ui.height = clampHeight(startH + dy);
        dock.style.width = `${ui.width}px`;
        if (!widthOnly) dock.style.height = `${ui.height}px`;
    };
    const onUp = () => {
        if (!resizing) return;
        resizing = false;
        document.body.style.userSelect = '';
        save();
    };

    handle.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    handle.addEventListener('touchstart', onDown, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onUp);
}

/** Creates (once) the small floating circular button shown when the dock is minimized — clicking
 *  it reopens the dock. No-ops if it already exists. */
function buildRestoreButton() {
    if (document.getElementById('pf-restore-btn')) return;
    const btn = el('div', 'pf-restore-btn', { title: 'Show Prompt Folders' });
    btn.id = 'pf-restore-btn';
    btn.innerHTML = '<i class="fa-solid fa-folder-tree"></i>';
    document.body.appendChild(btn);
    btn.addEventListener('click', () => {
        const ui = settings().ui;
        ui.open = true;
        save();
        applyDockPosition(document.getElementById('pf-dock'));
    });
}

/** Extension startup entry point for the UI: builds the restore button and the dock (if not
 *  already built), wires up every toolbar/header control, positions it from saved settings,
 *  does the first renderTree(), and starts watchPromptManager() to keep it live afterward. */
export function buildDock() {
    buildRestoreButton();
    if (document.getElementById('pf-dock')) return;

    const dock = el('div', 'pf-dock');
    dock.id = 'pf-dock';
    dock.innerHTML = panelHtml();
    document.body.appendChild(dock);
    applyDockPosition(dock);

    const handle = document.getElementById('pf-drag-handle');
    makeDraggable(dock, handle);
    makeResizable(dock, document.getElementById('pf-resize-handle'));
    makeResizable(dock, document.getElementById('pf-resize-edge'), { widthOnly: true });

    document.getElementById('pf-side-toggle').addEventListener('click', () => {
        const ui = settings().ui;
        ui.side = ui.side === 'left' ? 'right' : 'left';
        save();
        applyDockPosition(dock);
    });

    document.getElementById('pf-minimize').addEventListener('click', () => {
        const ui = settings().ui;
        ui.open = false;
        save();
        applyDockPosition(dock);
    });

    document.getElementById('pf-grow').addEventListener('click', () => adjustSize(40, 60));
    document.getElementById('pf-shrink').addEventListener('click', () => adjustSize(-40, -60));

    document.getElementById('pf-refresh').addEventListener('click', () => { renderTree(); scheduleAutoFilterEval(200); });
    document.getElementById('pf-new-folder').addEventListener('click', () => {
        const name = promptOrNull('New top-level folder name:');
        if (name) { createFolder('', name); renderTree(); }
    });
    document.getElementById('pf-new-prompt').addEventListener('click', () => requestNewPromptAfter(ROOT, null));
    document.getElementById('pf-preview').addEventListener('click', showFullPreview);
    document.getElementById('pf-bulk-match').addEventListener('click', () => openBulkMatchModal(null));
    document.getElementById('pf-auto-filter').addEventListener('click', openAutoFilterModal);
    document.getElementById('pf-import-export').addEventListener('click', () => {
        showContextMenu(document.getElementById('pf-import-export'), [
            { label: '📤 Export folder structure…', action: exportFolderStructure },
            'separator',
            { label: '📥 Import (replace current folders)…', action: importFolderStructure },
            { label: '📥 Import append (adds to your whole folder structure)…', action: importFolderStructureMerge },
        ]);
    });
    document.getElementById('pf-remove-all').addEventListener('click', () => openRemoveAllMenu(document.getElementById('pf-remove-all')));
    document.getElementById('pf-search').addEventListener('input', ev => {
        searchTerm = ev.target.value || '';
        renderTree();
    });
    attachTreeBackgroundDeselect(document.getElementById('pf-tree'));

    window.addEventListener('resize', () => {
        const ui = settings().ui;
        ui.width = clampWidth(ui.width);
        ui.height = clampHeight(ui.height);
        ui.top = clampTop(ui.top, dock.offsetHeight);
        applyDockPosition(dock);
    });

    renderTree();
    watchPromptManager();
}
