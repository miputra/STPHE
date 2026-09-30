// STPHE — organizes Chat Completion "pinned" prompts (Prompt Manager entries)
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
// table in src/state.js — if a future ST update renames a class, that's the one place to fix it.
//
// This file is just the entry point: it wires up the module graph (see src/) and starts
// the extension once the page is ready. Each src/ file owns one feature area:
//   state.js         shared settings model, path/order helpers, DOM selectors
//   native.js         reading/driving SillyTavern's live Prompt Manager DOM
//   folders.js         folder create/rename/move/delete + assignment
//   import-export.js    exporting/importing this extension's folder structure
//   dnd.js               drag-and-drop reordering of prompts and folders
//   context-menu.js       the right-click row context menu
//   render.js               the folder tree renderer
//   bulk-match.js             "enable/disable by content match" bulk actions
//   auto-filter.js             condition -> effect Auto Filter rules
//   panel.js                    the pinned floating dock UI (drag/resize/minimize)
//   bootstrap.js                 popup-awareness + DOM watchers + startup
import './src/bootstrap.js';
