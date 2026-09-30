# Silly-Tavern-Prompt-Hierarchy-Expanded (STPHE)

Organize SillyTavern’s Chat Completion prompts into folders and nested subfolders, with an independent toggle at every level. **Author: miputra.** Formerly Prompt Folders; existing settings and exports remain compatible.

## Your prompt hierarchy, at a glance

![Focused prompt hierarchy with nested folders and independent toggles](docs/assets/hierarchy.png)

Read the indentation from **PF Stress Test → Branch 00 → Section**. Each folder has its own toggle; the triangle expands or collapses its children. This close-up comes from the real-app 500-prompt test and shows only the hierarchy, with the surrounding chat cropped out.

**[Read the documentation](https://miputra.github.io/STPHE/)** · [Getting started](docs/getting-started.html) · [Detailed reference and release notes](docs/reference.md)

## Create folders and arrange the panel

![STPHE toolbar, layout controls and search](docs/assets/panel-toolbar.png)

Click **Folder** to create a folder or **Prompt** to add a prompt. Search finds prompts by name or identifier. Drag the header to reposition the panel; the top-right controls grow, shrink, switch sides and minimize it. **Refresh** reads the native Prompt Manager again. [Getting started →](docs/getting-started.html)

## Control each prompt and folder

![Folder toggle, force-all buttons, prompt controls and destination selectors](docs/assets/prompt-controls.png)

The folder’s toggle mutes its contents. The adjacent check and cross buttons **enable all** or **disable all**. Each prompt row has its own toggle, manual-filter exclusion, Auto Filter exclusion, read-only eye, editor pencil, More actions menu and folder selector. Drag rows to reorder; Ctrl/Cmd-click selects several. [Folders and prompts →](docs/folders.html)

![Diagram showing remembered prompt states before, during and after a folder mute](docs/assets/mute-restore.svg)

**Mute remembers your selection.** Restoring a folder brings back the prompts you intended to enable. A child folder’s own mute remains independent. Use Enable all only when you want every prompt switched on.

## Save and group filters

![Filter form showing match source, match type, target and Save controls](docs/assets/filter-match.png)

Open the toolbar’s **funnel** to match prompt content by XML tag, word or regex. Choose whether to affect the matching prompts, their last containing folder or all containing folders. Enter a preset name and **Save** to reuse the action later.

![Saved preset nested inside a preset group and subgroup](docs/assets/preset-hierarchy.png)

**＋ Preset group** creates a group for saved actions; the group’s **＋** creates a subgroup. Move presets with the row selector or drag them. A preset lock blocks its actions, while a group’s On control gates its descendants without changing their locks. This existing test capture predates the STPHE rename. [Filter presets →](docs/presets.html)

![Chat matching source and recent-message depth](docs/assets/chat-filter.png)

Select **Chat** in Match against for a manual recent-chat condition. **Check chat** checks that condition; choose the prompts to affect separately below it. Use Auto Filter for ongoing automatic evaluation.

## Let Auto Filter respond to chat

![Auto Filter example matching tavern in the last four messages](docs/assets/auto-condition.png)

Open the toolbar’s **wand**. Name a rule, choose its condition and set chat depth. This unsaved example checks for `tavern` in the last four messages. Depth **0** means always on.

![Auto Filter effect and manual target selection](docs/assets/auto-effect.png)

Choose the effect and its targets independently. With **Enable when triggered**, selected targets turn on when the condition matches and off when it stops matching. Check the desired prompts or folders before adding the rule; this screenshot shows the target picker before selection.

![Auto Filter evaluation timing checkboxes](docs/assets/auto-timing.png)

The master switch pauses filters. The two timing options independently re-evaluate after generation and before sending. **Before sending (wait for filters)** includes the new user message and waits for effects before request assembly. [Auto Filter →](docs/auto-filter.html)

## Back up and manage prompts

![Focused Import and Export menu](docs/assets/import-export.png)

Use **Export folder structure** for a backup. **Import** replaces the folder organization; **Import append** merges into the existing structure. Full exports include filters, rules and their groups, with native definitions and order when available.

![Prompt menu with rename, insertion, export and deletion actions](docs/assets/prompt-menu.png)

The row’s **More actions** menu offers rename, insertion, a single-prompt export and deletion choices. Rename and Edit use SillyTavern’s native editor; save there to apply changes.

![Removal submenu distinguishing list removal from permanent deletion](docs/assets/removal-choices.png)

**Remove from list** keeps the native definition for later reinsertion. **Delete prompt permanently** removes the definition. Export before making changes you may need to recover. [Import, export and removal →](docs/backups.html)

## Install

![Installation diagram showing repository, required files and first refresh](docs/assets/install-files.svg)

In SillyTavern, open **Extensions → Install extension** and enter `https://github.com/miputra/STPHE`. Reload, select **Chat Completion**, then open **AI Response Configuration** once so the native Prompt Manager renders. Update an existing Prompt Folders installation in place; keep only one copy.

## Compatibility and troubleshooting

![Diagram of native apply, verification and hierarchy paint](docs/assets/loading-flow.svg)

Folder changes apply to the native prompt list, verify their states, then repaint the hierarchy before unlocking. The integration was checked with **SillyTavern 1.18.0**. Large presets can take time. Reordering and native UI integration are best-effort across versions; verify important prompt sequencing in AI Response Configuration after reloading. [Troubleshooting →](docs/troubleshooting.html)

![Documentation source map](docs/assets/docs-files.svg)

The static documentation lives in `docs/`; it needs no build dependencies. See [GitHub Pages publishing](docs/publishing.html) for deployment and local preview, and the [detailed reference](docs/reference.md) for implementation caveats and earlier release notes.

Made with Claude 4.6 Sonnet, ChatGPT 5.6 Sol, and ChatGPT 6 ASTRA.

If you like the project, you can also buy me a coffee.

- **BEP-20:** `0xE122d7d44604d59b27Ca3FAA44Fc1Da94CE0aE03`
- **Solana:** `C8A5J9w7UkXeLVeCWhpP47SPCPvnuS55RJWybzFhB3jF`

