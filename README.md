# Silly-Tavern-Prompt-Hierarchy-Expanded (STPHE)

Organize SillyTavern’s Chat Completion prompts into folders and nested subfolders, with an independent toggle at every level. **Author: miputra.** Formerly Prompt Folders; existing settings and exports remain compatible.

## 3.4.0 — Tags and compatible imports

Released 2026-10-09. Prompt tags, individual filter/rule exports, and the three import modes are now available. Full, folder, and single-prompt STPHE backups include prompt tags. Native SillyTavern v1 prompt exports and older flat STPHE backups are accepted.

New STPHE prompt exports also work with SillyTavern's native Prompt Manager importer. **Use STPHE's importer to restore tags, folders, and filter settings**; native SillyTavern reads only the prompt definitions and order. Append preserves existing tags; Replace matching applies imported tags. Older backups without tags keep existing tags. Individual filter exports include their tag-matching criteria, not the tagged prompts themselves.

See the [compatibility table](https://miputra.github.io/STPHE-Documentation/backups.html#compatibility) and [release notes](https://github.com/miputra/STPHE-Documentation/blob/main/docs/reference.md#340--tags-and-compatible-imports).

## Complete feature guides

The documentation now includes 71 illustrated feature topics: panel controls, nested folders, multi-selection and ordering, prompt creation/editing, multiple tags, read-only viewing, full preview, every manual Filter match mode and target, Chat checks, presets/groups, Auto Filter conditions/effects/timing, all import modes, compatibility, and removal choices. Search goes directly to individual sections.

Start with the [feature directory](https://miputra.github.io/STPHE-Documentation/index.html#features). Each section includes a focused worked-example image; the Manual Filter and tag-editing walkthroughs also show the current controls. See the [coverage inventory](https://github.com/miputra/STPHE-Documentation/blob/main/docs/feature-coverage.md) for the source audit.

## Your prompt hierarchy, at a glance

![Focused prompt hierarchy with nested folders and independent toggles](https://raw.githubusercontent.com/miputra/STPHE-Documentation/main/docs/assets/hierarchy.png)

Read the indentation from **PF Stress Test → Branch 00 → Section**. Each folder has its own toggle; the triangle expands or collapses its children. This close-up comes from the real-app 500-prompt test and shows only the hierarchy, with the surrounding chat cropped out.

**[Read the documentation](https://miputra.github.io/STPHE-Documentation/)** · [Feature directory](https://miputra.github.io/STPHE-Documentation/index.html#features) · [Manual Filter](https://miputra.github.io/STPHE-Documentation/filters.html) · [Prompts & tags](https://miputra.github.io/STPHE-Documentation/prompts.html) · [Detailed reference and release notes](https://github.com/miputra/STPHE-Documentation/blob/main/docs/reference.md)

## Create folders and arrange the panel

![STPHE toolbar, layout controls and search](https://raw.githubusercontent.com/miputra/STPHE-Documentation/main/docs/assets/panel-toolbar.png)

Click **Folder** to create a folder or **Prompt** to add a prompt. Search finds prompts by name or identifier. Drag the header to reposition the panel; the top-right controls grow, shrink, switch sides and minimize it. **Refresh** reads the native Prompt Manager again. [Getting started →](https://miputra.github.io/STPHE-Documentation/getting-started.html)

## Control each prompt and folder

![Folder toggle, force-all buttons, prompt controls and destination selectors](https://raw.githubusercontent.com/miputra/STPHE-Documentation/main/docs/assets/prompt-controls.png)

The folder’s toggle mutes its contents. The adjacent check and cross buttons **enable all** or **disable all**. Each prompt row has its own toggle, manual-filter exclusion, Auto Filter exclusion, read-only eye, editor pencil, More actions menu and folder selector. Drag rows to reorder; Ctrl/Cmd-click selects several. [Folders and prompts →](https://miputra.github.io/STPHE-Documentation/folders.html)

![Diagram showing remembered prompt states before, during and after a folder mute](https://raw.githubusercontent.com/miputra/STPHE-Documentation/main/docs/assets/mute-restore.svg)

**Mute remembers your selection.** Restoring a folder brings back the prompts you intended to enable. A child folder’s own mute remains independent. Use Enable all only when you want every prompt switched on.

## Save and group filters

![Filter form showing match source, match type, target and Save controls](https://raw.githubusercontent.com/miputra/STPHE-Documentation/main/docs/assets/filter-match.png)

Open the toolbar’s **funnel** to match prompt content by XML tag, word, regex or listed regex values, or match saved **prompt tags**. **Apply** only finds matches; choose a target and **Enable/Disable** to change states. Containing-folder targets can affect nonmatching siblings. Enter a preset name and **Save** to reuse the action later. [Complete manual Filter guide →](https://miputra.github.io/STPHE-Documentation/filters.html)

![Saved preset nested inside a preset group and subgroup](https://raw.githubusercontent.com/miputra/STPHE-Documentation/main/docs/assets/preset-hierarchy.png)

**＋ Preset group** creates a group for saved actions; the group’s **＋** creates a subgroup. Move presets with the row selector or drag them. A preset lock blocks its actions, while a group’s On control gates its descendants without changing their locks. This existing test capture predates the STPHE rename. [Filter presets →](https://miputra.github.io/STPHE-Documentation/presets.html)

![Chat matching source and recent-message depth](https://raw.githubusercontent.com/miputra/STPHE-Documentation/main/docs/assets/chat-filter.png)

Select **Chat** in Match against for a manual recent-chat condition. **Check chat** checks that condition; choose the prompts to affect separately below it. Use Auto Filter for ongoing automatic evaluation.

## Let Auto Filter respond to chat

![Auto Filter example matching tavern in the last four messages](https://raw.githubusercontent.com/miputra/STPHE-Documentation/main/docs/assets/auto-condition.png)

Open the toolbar’s **wand**. Name a rule, choose its condition and set chat depth. This unsaved example checks for `tavern` in the last four messages. Depth **0** means always on.

![Auto Filter effect and manual target selection](https://raw.githubusercontent.com/miputra/STPHE-Documentation/main/docs/assets/auto-effect.png)

Choose the effect and its targets independently. With **Enable when triggered**, selected targets turn on when the condition matches and off when it stops matching. Check the desired prompts or folders before adding the rule; this screenshot shows the target picker before selection.

![Auto Filter evaluation timing checkboxes](https://raw.githubusercontent.com/miputra/STPHE-Documentation/main/docs/assets/auto-timing.png)

The master switch pauses filters without undoing previous effects. Chat events schedule evaluations; the timing options add an after-generation check and a guaranteed before-send wait. **Before sending (wait for filters)** includes the new user message and waits for effects before request assembly. [Auto Filter →](https://miputra.github.io/STPHE-Documentation/auto-filter.html)

## Back up and manage prompts

![Focused Import and Export menu](https://raw.githubusercontent.com/miputra/STPHE-Documentation/main/docs/assets/import-export.png)

Use **Export prompt list and folders** for a backup. Full exports include tags, filters, rules and their groups, with native prompt definitions and order when available.

Prompt lists, Filter presets, Chat filter presets, and Auto Filter rules share three import modes:

| Mode | Behavior |
| --- | --- |
| **Append** | Add new items and keep existing matches unchanged. |
| **Replace matching** | Update matching items, add new items, and keep everything else. |
| **Clear and import** | Replace the selected list with the file's contents. |

Matching uses the ID first, then a unique name, ignoring case and surrounding spaces. Replacing a match preserves its local ID so existing references continue to work. Ambiguous names or invalid files stop the import before changes are applied. You see a confirmation with the affected scope before importing.

Each preset or Auto Filter row has an **Export** button. Each of the three filter collections has its own **Import…**, mode selector, and **Export all…** controls. Importing one preset uses that collection's Import control. These files include the selected rules and their groups, but do not bundle prompt definitions; manually selected prompt IDs and folder paths must exist at the destination.

**Clear and import** for a prompt list clears the active list and its folder organization, then imports the file. Reusable prompt definitions remain available and other lists are retained. Included filter collections use the selected mode; collections absent from the file stay unchanged. Clearing a filter collection affects only that collection and its groups. The separate **Append after this entry** action retains its existing placement workflow.

![Prompt menu with rename, insertion, export and deletion actions](https://raw.githubusercontent.com/miputra/STPHE-Documentation/main/docs/assets/prompt-menu.png)

The row’s **More actions** menu offers rename, insertion, a single-prompt export and deletion choices. Rename and Edit use SillyTavern’s native editor; save there to apply changes.

![Removal submenu distinguishing list removal from permanent deletion](https://raw.githubusercontent.com/miputra/STPHE-Documentation/main/docs/assets/removal-choices.png)

**Remove from list** keeps the native definition for later reinsertion. **Delete prompt permanently** removes the definition. Export before making changes you may need to recover. [Import, export and removal →](https://miputra.github.io/STPHE-Documentation/backups.html)

## Install

![Installation diagram showing repository, required files and first refresh](https://raw.githubusercontent.com/miputra/STPHE-Documentation/main/docs/assets/install-files.svg)

In SillyTavern, open **Extensions → Install extension** and enter `https://github.com/miputra/STPHE`. Reload, select **Chat Completion**, then open **AI Response Configuration** once so the native Prompt Manager renders. Update an existing Prompt Folders installation in place; keep only one copy.

## Compatibility and troubleshooting

![Diagram of native apply, verification and hierarchy paint](https://raw.githubusercontent.com/miputra/STPHE-Documentation/main/docs/assets/loading-flow.svg)

Folder changes apply to the native prompt list, verify their states, then repaint the hierarchy before unlocking. The integration was checked with **SillyTavern 1.18.0**. Large presets can take time. Reordering and native UI integration are best-effort across versions; verify important prompt sequencing in AI Response Configuration after reloading. [Troubleshooting →](https://miputra.github.io/STPHE-Documentation/troubleshooting.html)

Made with Claude 4.6 Sonnet, ChatGPT 5.6 Sol, and ChatGPT 6 ASTRA.

**AI development disclaimer**

This was originally intended as a personal project, but I decided to make it public. I don't understand this project's code, and JavaScript is not a language I know; I only know C# and Python.

I have added comments throughout the code to make development easier, whether for manual fixes or as notes for AI tools working on the project. I hope this helps.

## Support the project

If you like the project, you can also buy me a coffee.

- **Trakteer:** [Support miputra](https://trakteer.id/miputra?quantity=1)
- **BEP-20:** `0xE122d7d44604d59b27Ca3FAA44Fc1Da94CE0aE03`
- **Solana:** `C8A5J9w7UkXeLVeCWhpP47SPCPvnuS55RJWybzFhB3jF`


### Prompt tags

New and existing prompts have a **Prompt tags** field in the native prompt editor. Type one tag and press **Enter**, then repeat to add more. Use **×** to remove a tag and the native **Save** button to save your changes. Closing without saving discards tag edits. Empty tags and duplicate names (ignoring case) are skipped.

In **Filter**, select **Prompt tag** under **Match by**, enter the full tag name, and click **Apply**. Tag matching ignores case, respects folder scope and filter exclusions, and works with saved presets and the Chat filter's **Select prompts to affect** form.

In **Auto Filter**, select **Prompt tag** in the effect's **Match by** menu. The chat condition controls when matching prompts (or their containing folders) are enabled or disabled. Auto Filter exclusions still apply. For an always-on rule, use chat depth 0.

Tags are extension metadata associated with a prompt's identifier; they do not change the prompt text sent to the model. The same identifier shares tags across presets. Extension full, folder, and single-prompt backups include tags; native SillyTavern exports alone do not include this metadata.
