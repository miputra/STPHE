import { el } from './state.js';

// ---------- Context menu ----------
//
// A single generic right-click / "⋮ more actions" popup menu, reused by every row (prompt and
// folder) in the tree, plus the toolbar's Remove All button. Supports one level of grouping via
// nested submenus (an item with `items: [...]` instead of `action` opens a flyout of its own,
// used to keep long lists of destructive options collapsed behind a single row — see
// render.js/panel.js for how the submenu items are grouped). The whole chain (root + any open
// submenu) can be dragged to a new spot by its top grip bar, and is always clamped to the
// viewport using its REAL rendered size rather than a guessed width, so it's never cut off by a
// screen edge even when the panel is docked right next to one.

/** Stack of currently-open menu elements, root first (index 0), each nested submenu after it. */
let openMenus = [];

/** Removes every currently-open menu (root and any open submenu) from the DOM. */
export function closeContextMenu() {
    for (const m of openMenus) m.remove();
    openMenus = [];
}

/** Removes every open menu from level `n` onward (used when opening a new submenu at a level, to
 *  first discard anything deeper that was open from a previous selection). */
function closeMenusFrom(n) {
    while (openMenus.length > n) {
        const m = openMenus.pop();
        m.remove();
    }
}

/** Wires up dragging `menu` by its `grip` handle (mouse and touch) — moves the fixed-positioned
 *  menu freely, keeping it fully on-screen. Only attached to the root menu (level 0): grabbing it
 *  first closes any open submenu, since a submenu's position is anchored to where its parent row
 *  used to be. */
function makeMenuDraggable(menu, grip) {
    let dragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    const onDown = ev => {
        closeMenusFrom(1);
        dragging = true;
        const point = ev.touches ? ev.touches[0] : ev;
        startX = point.clientX;
        startY = point.clientY;
        const rect = menu.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        document.body.style.userSelect = 'none';
        ev.preventDefault();
        ev.stopPropagation();
    };
    const onMove = ev => {
        if (!dragging) return;
        const point = ev.touches ? ev.touches[0] : ev;
        const dx = point.clientX - startX;
        const dy = point.clientY - startY;
        const rect = menu.getBoundingClientRect();
        const left = Math.min(Math.max(4, startLeft + dx), window.innerWidth - rect.width - 4);
        const top = Math.min(Math.max(4, startTop + dy), window.innerHeight - rect.height - 4);
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
    };
    const onUp = () => {
        dragging = false;
        document.body.style.userSelect = '';
    };

    grip.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    grip.addEventListener('touchstart', onDown, { passive: false });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onUp);
    // A drag is still a mousedown+mouseup on the grip, which the browser turns into a trailing
    // "click" — swallow it here so it never reaches the document-level "close on next click"
    // listener below and closes the menu the instant you finish dragging it.
    grip.addEventListener('click', ev => ev.stopPropagation());
}

/** Builds one menu level's DOM from `items` (see file header for item shapes), wiring up leaf
 *  clicks (close everything, run the action) and submenu-toggle clicks (open/close a nested
 *  flyout to the side). `level` is this menu's depth (0 = root); only the root gets a drag grip. */
function buildMenu(items, level) {
    const menu = el('div', 'pf-context-menu');

    if (level === 0) {
        const grip = el('div', 'pf-context-grip', { title: 'Drag to move this menu' });
        grip.innerHTML = '<i class="fa-solid fa-grip-lines"></i>';
        menu.appendChild(grip);
        makeMenuDraggable(menu, grip);
    }

    for (const item of items) {
        if (item === 'separator') { menu.appendChild(el('div', 'pf-context-sep')); continue; }
        const hasSubmenu = Array.isArray(item.items) && item.items.length > 0;
        const row = el('div', 'pf-context-item' + (item.danger ? ' pf-context-danger' : '') + (hasSubmenu ? ' pf-context-has-submenu' : ''), { title: item.label });
        row.appendChild(el('span', 'pf-context-item-label', { text: item.label }));

        if (hasSubmenu) {
            row.appendChild(el('span', 'pf-context-caret fa-solid fa-caret-right'));
            row.addEventListener('click', ev => {
                ev.stopPropagation();
                const wasOpen = row.classList.contains('pf-context-open');
                closeMenusFrom(level + 1);
                for (const sib of menu.querySelectorAll(':scope > .pf-context-item.pf-context-open')) sib.classList.remove('pf-context-open');
                if (wasOpen) return;
                row.classList.add('pf-context-open');
                openSubmenu(row, item.items, level + 1);
            });
        } else {
            row.addEventListener('click', () => { closeContextMenu(); item.action(); });
        }
        menu.appendChild(row);
    }
    return menu;
}

/** Opens a nested submenu next to `anchorRow` (the parent item that was clicked): to its right by
 *  default, flipped to its left if there isn't room, top-aligned with the row and nudged up if it
 *  would run off the bottom. Clamped fully on-screen using its real measured size, same idea as
 *  showContextMenu() below. */
function openSubmenu(anchorRow, items, level) {
    const menu = buildMenu(items, level);
    menu.style.visibility = 'hidden';
    document.body.appendChild(menu);
    const rect = anchorRow.getBoundingClientRect();
    const mw = menu.getBoundingClientRect().width;
    const mh = menu.getBoundingClientRect().height;

    let left = rect.right + 2;
    if (left + mw > window.innerWidth - 8) left = rect.left - mw - 2;
    left = Math.min(Math.max(8, left), window.innerWidth - mw - 8);

    let top = Math.min(Math.max(8, rect.top), window.innerHeight - mh - 8);

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = '';
    openMenus.length = level;
    openMenus.push(menu);
}

/** Opens a context menu positioned just below `anchorEl`, populated from `items` — each item is
 *  either the string `'separator'` (renders a divider), a leaf `{label, action, danger?}`, or a
 *  group `{label, items: [...], danger?}` that opens a nested flyout instead of running an action
 *  directly (see file header). Clicking a leaf item closes the whole menu chain and runs its
 *  action. Auto-closes on the next click anywhere outside it. Flips above the anchor when there
 *  isn't enough room below, and is always clamped fully on-screen (horizontally too) using its
 *  REAL rendered width/height rather than a guessed size, so a menu full of long labels is never
 *  cut off by a screen edge — including when the panel itself is docked right against one. The
 *  whole menu can also be dragged to a new spot by the grip bar at its top. */
export function showContextMenu(anchorEl, items) {
    closeContextMenu();
    const menu = buildMenu(items, 0);
    // Rendered off-screen (visibility hidden) first so getBoundingClientRect() below reflects its
    // real size — both width and height are variable (item count and label length), so neither
    // can be guessed up front.
    menu.style.visibility = 'hidden';
    document.body.appendChild(menu);
    const rect = anchorEl.getBoundingClientRect();
    const mw = menu.getBoundingClientRect().width;
    const mh = menu.getBoundingClientRect().height;
    const fitsBelow = rect.bottom + 4 + mh <= window.innerHeight - 8;
    menu.style.top = fitsBelow
        ? `${rect.bottom + 4}px`
        : `${Math.max(8, rect.top - mh - 4)}px`;
    menu.style.left = `${Math.min(Math.max(8, rect.left), window.innerWidth - mw - 8)}px`;
    menu.style.visibility = '';
    openMenus = [menu];
    setTimeout(() => document.addEventListener('click', closeContextMenu, { once: true }), 0);
}
