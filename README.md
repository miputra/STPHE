## 3.2.2 — large-tree rendering and immediate saved names

Toggle and name changes now update existing rows instead of rebuilding every move selector. Unchanged refreshes preserve the tree. Loading remains active through native verification and the next tree paint, without a fixed completion timer. Native list replacements and text edits are observed immediately; saved names are read from the native model after its Save handler runs.

Saved **Filter presets** and **Chat filter presets** have a clearly labeled **＋ Preset group** button. Groups support nesting, moving, collapsing, renaming and muting while retaining individual preset locks.

Live tested on the running SillyTavern 1.18.0 app with 500 added prompts in 61 nested folders: mute/restore, independent subfolder mute, native rename, and saved-preset grouping across reload. Completion checks found the final toggle state already displayed; click calls took about 2.7 seconds including native processing and browser tooling. A saved rename appeared in the first check (309 ms). These are observations for this fixture, not a guarantee for every machine or larger preset. 41 local regression tests passed. Local test fixtures, screenshots and the detailed report remain outside Git according to this repository's ignore rules.

## 3.2.1 — awaited Auto Filter before sending

The optional **Re-evaluate before sending (wait for filters)** setting now uses SillyTavern's awaited message event. It includes the new user message, waits for any active filter pass, then applies the current rules before request assembly. Both Send and Enter were verified through a local OpenAI-compatible HTTP fixture. Streaming, non-streaming, group gating, abort, and error recovery were also checked. See [TEST_REPORT.md](TEST_REPORT.md) for results and limits.

## 3.2.0 — responsive toggles and filter groups

Folder changes now update the native prompt model in one serialized batch, calculate context once, await the native list render, and verify every requested state. Loading ends after the updated plugin tree is rendered. There is no fixed completion delay or wait for the settings-save debounce; already-correct states do not show loading. Muted prompts retain their remembered on/off state; gray means suppressed by a folder, while yellow means a genuinely mixed folder.

Saved content filters, chat filters, and Auto Filter each have their own folder-style groups. Use **＋ Group** to create a group, **＋** on a group to create a subgroup, and the move selector or drag-and-drop to move filters/groups. Groups can be collapsed, renamed, muted, and deleted while keeping their filters. Muting preserves individual rule checkboxes and preset locks. Auto Filter priority is shown by rule numbers; grouping does not change execution priority. Full exports now include rules, presets, and groups.

Also fixed search, nested-folder deletion cleanup, nested import paths, the native-list fallback watcher, folder-name dialogs, empty-list refresh, and opening the native editor from a closed configuration drawer.

Run `node tests/regression.test.mjs` from this plugin directory. See [TEST_REPORT.md](TEST_REPORT.md) for coverage and limits. This directory has its own Git repository; the parent SillyTavern repository is not part of these commits.

---

# Prompt Folders (SillyTavern extension)

Organizes your Chat Completion "pinned" prompts (the entries in the Prompt Manager list —
Main Prompt, Jailbreak, custom prompts, etc.) into folders and subfolders — every folder
and subfolder at any depth has its own on/off toggle — plus add/delete/rename, independent
view/edit, and drag-and-drop reordering, all from a resizable panel pinned to the edge of
the screen so you never have to open the Extensions tab.

## What it does

- **Pinned floating panel**, not a tab you have to open. Drag its header to move it up/down,
  resize it (see below), flip it to the other side, minimize it to nothing, and bring it
  back with a small always-visible restore button.
- **Resizing, two ways**: drag the thin strip along the panel's inner edge to change just the
  width (so you can dial in exactly how much of the chat it covers), or drag the bottom
  corner to resize both width and height — that corner handle sits at the bottom-left of the
  panel (bottom-right if you've flipped the panel to the left side), i.e. always on the inner
  edge facing into the chat rather than tucked against the screen edge. There are also ➱/➲
  buttons in the header for a quick bigger/smaller step if you don't want to drag.
- **Minimize / restore**: the − button in the header hides the panel completely. A small
  round button stays pinned at the edge of the screen the whole time — click it to bring
  the panel straight back.
- **Folders and subfolders at any depth**, each with its own toggle that acts like a mute
  layer: turning a folder off disables every prompt inside it (and its subfolders) in
  SillyTavern's original Prompt Manager, but does **not** visually switch off the individual
  content toggles in this extension. Those content toggles remain editable as each prompt's
  intended state. Turning the folder back on applies exactly those currently visible intended
  states. An intended-on content toggle is shown in yellow while a muted folder is suppressing
  it; an intentionally-off toggle remains gray. Nested folder mutes are independent, so enabling
  a parent does not bypass a child that is itself muted. Every folder row also has adjacent
  **Enable ALL** and **Disable ALL** square
  buttons for immediate one-click uniform control; unlike the folder mute, these deliberately
  change every visible content toggle too. Folder-wide changes are applied and verified as one
  batch, so large folders trigger one panel refresh instead of a full refresh for every prompt.
  Every native click still resolves the current live prompt row,
  remaining compatible with SillyTavern versions that rebuild the list between clicks. While a
  prompt or folder toggle is being processed, the entire extension panel is visibly locked and
  cannot accept pointer or keyboard changes. Synchronous single-prompt and small-folder changes
  unlock immediately after verification; asynchronous native updates are checked once per
  animation frame and unlock on the first matching frame. A bounded timeout exists only to retry
  a native handler that never settles. The delayed order safety check continues unobtrusively in
  the background instead of extending the loading state.
- **Add, delete, and rename prompts**:
  - **Add**: toolbar "Prompt" button, or a row's ⋮ menu → "New prompt after this" — creates a
    prompt named "New Prompt" (auto-numbered if you already have one) directly, inserts it at
    the exact position you asked for, and immediately opens it in ST's real editor so you can
    fill in the content. Unlike the rest of this extension, this one **writes directly into
    SillyTavern's live settings** rather than driving native buttons — see the note below.
  - **Delete, two ways** — a row's ⋮ menu has both, so you pick per-prompt:
    - **🔓 Remove from list (keep prompt)**: unlists it from here, exactly like a normal
      remove, but the prompt's actual definition is left alone — it still exists and can be
      brought back later via ST's own "Insert prompt" dropdown in AI Response Configuration,
      or automatically if you re-import a prompt list that references it (see Import/Export
      below). Its folder assignment here is kept, so if it does come back it lands in the same
      folder. This writes directly into SillyTavern's live settings the same way "New prompt"
      does (see the note below) rather than driving a native button, since ST doesn't expose a
      native "remove without deleting" control of its own to drive.
    - **🗑 Delete prompt entirely**: drives ST's native footer delete control (with your
      confirmation first) — this removes the definition from the preset for good, the same as
      using native Delete yourself.
    - **📤 Export this prompt**: downloads just this one prompt (definition, active-list entry
      if it has one, and its folder here if it's in one) as its own small JSON file — see
      Import/Export below.
  - **Folder delete, three ways** — a folder's ⋮ menu (except "Unfiled") has all three, so you
    pick how far it should reach:
    - **🗑 Delete folder**: the original behavior — prompts directly inside move up one level
      into the parent folder, subfolders are deleted too. Nothing about the prompts themselves
      changes.
    - **🗑 Delete folder + prompts inside (remove from list)**: also removes every prompt
      anywhere inside the folder (including subfolders) from the active list — same as "Remove
      from list (keep prompt)" above, just for the whole folder in one confirmation instead of
      one native popup per prompt. Each prompt's own definition is kept and can still be
      brought back later.
    - **🗑 Delete folder + prompts inside PERMANENTLY**: same reach, but each prompt's
      definition is deleted entirely (same as "Delete prompt entirely" above, for every prompt
      in the folder at once). Cannot be undone.
    - **📤 Export this folder**: downloads just this folder — itself, every subfolder, and every
      prompt assigned anywhere inside it — as its own JSON file, re-importable on its own; see
      Import/Export below.
  - **Rename**: a row's ⋮ menu → "Rename…" — opens ST's real editor with the name field
    already focused and selected, so you can type the new name and hit ST's own Save button.
    Renaming never touches anything outside that one popup.
- **View and Edit are two separate, independent actions**:
  - 👁 **View** shows a read-only preview of the prompt's current content. It tries to read
    the content directly from SillyTavern's own settings first (fastest and most reliable —
    doesn't open anything at all), and only falls back to briefly opening-and-closing the
    native editor if that's not available. Either way, nothing you do in the View popup can
    change the prompt — its textarea is locked read-only as a backstop even if content came
    from the fallback path.
  - ✏️ **Edit** opens SillyTavern's real editor (name, content, role, injection position/depth)
    exactly like the pencil icon in AI Response Configuration, and you save through ST as usual.
- **Exclude from filter**: every prompt row and every folder row (except "Unfiled" itself) has
  a 🚫 filter icon — click it to exclude that prompt, or that whole folder (and everything
  inside it, including subfolders), from Enable/disable-by-match filtering. Excluded items
  never show up as a match for the bulk match-and-toggle modal or a saved filter preset — they're
  simply skipped, no matter what the match spec is. This is a regular part of your settings, so
  it's saved and persists exactly like everything else (folders, assignments, presets) —
  including through Import/Export.
- **Exclude from Auto Filter**: every prompt row and every folder row (except "Unfiled" itself)
  also has a separate 🪄 icon — click it to exclude that prompt, or that whole folder (and
  everything inside it, including subfolders), from Auto Filter specifically. This is a fully
  independent flag from the 🚫 filter-exclude above: excluding a prompt from Auto Filter has no
  effect on the manual Enable/disable-by-match filter or saved presets, which still see and can
  match it — and excluding a prompt from the manual filter has no effect on Auto Filter, which
  still sees and can control it. The two can be combined in any way (excluded from one, both,
  or neither). An item excluded here is skipped by every part of Auto Filter — its condition
  checks (e.g. "All Character" scanning) and its effect targeting alike, whether the effect
  matched it by content or hand-picked it manually. Saved and persists like everything else,
  including through Import/Export.
- **Drag-and-drop everywhere**: drag a prompt or a folder onto another row's top/bottom edge
  to reorder it as a sibling there, or onto the middle of a folder row to file it inside that
  folder — folders can be dropped in the middle of a list of prompts and vice versa, at any
  depth. A row's ⋮ menu also has "New prompt/folder after this" if you'd rather not drag.
  Reordering here also reorders the real native prompt list to match, top-to-bottom (best
  effort — see the note below). Clicking **Send a message** performs one final synchronous
  order sync before SillyTavern handles the click, updating both its active `prompt_order` data
  and the visible native list from the exact order shown in this extension. Folder and prompt
  toggles also perform a short background reconciliation after SillyTavern finishes rebuilding
  its list, preventing the final toggled prompt from being left at the bottom without keeping the
  extension panel locked during that safety window.
- **Preview button**: reads every currently-*enabled* prompt's content (in current
  top-to-bottom order) and shows them concatenated in one place, with a total word count and
  a rough token estimate — plus the same word/token estimate on every individual 👁 View.
- **Import / Export**: back up or transfer this extension's folder structure (folders, which
  prompt goes where, display order) as a JSON file — one toolbar button (📥/📤 icon), which opens
  a small menu with **Export**, **Import (replace current folders)**, and **Import (add to
  current folders)**. On export, it also bundles a best-effort
  snapshot of your actual prompt definitions and active list order, under the same `prompts` /
  `prompt_order` field names SillyTavern's own export uses — so the file isn't exclusively tied
  to this extension, and re-importing it here (even into a different install) can recreate any
  prompt that's since been deleted, not just reference an identifier that's gone. Importing a
  genuine native SillyTavern "Export this prompt list" file here works too, for the same
  reason — you'll be offered to restore whichever prompts/list entries in it are missing from
  your current preset. See the note below on how that restore step works and its limits.
- Everything (folder structure, prompt assignments, display order, panel size/position) is
  saved in your ST settings and persists across reloads.
- **Filter (by content)**: filter to prompts whose content matches an XML tag
  value, a plain word, or a regex, then bulk-enable or bulk-disable exactly those — either the
  prompts themselves or the folders containing them. Reachable from the toolbar's filter icon
  (scope: everywhere) or a folder's ⋮ menu (scope: that folder and its subfolders). See its own
  section below for how it works.
- **Auto Filter**: a toolbar-only, persisted *list* of rules that automatically enable/disable
  prompts (or folders) based on what's actually been said recently in the chat — no manual
  clicking needed once set up. See its own section below.
- **Remove All** (🗑, top-right of the panel header, in red): the "start over" button — removes
  every prompt and every folder this extension knows about in one action. Click it and choose
  **Remove all from list (not permanent)** — same guarantee as the per-prompt "Remove from list":
  every prompt's own definition is kept and can be brought back later — or **Delete all
  PERMANENTLY**, which deletes every prompt's definition entirely and cannot be undone. Either
  way you get one confirmation dialog stating exactly how many prompts and folders are about to
  be affected before anything happens. Saved Auto Filter rules and Filter presets are untouched
  by this — it only clears prompts and the folder structure.
- **New Prompt / Edit Prompt never end up hidden behind this panel's own UI** (or vice versa) —
  this panel's persistent dock and any of its own popups (context menu, View, Preview, the
  match modal) get out of the way the instant a native SillyTavern popup opens, and this
  panel's list refreshes itself the instant that native popup closes again.
## Install

**Option A — via the in-app extension installer (needs it hosted in a git repo):**
Extensions → "Install extension" → paste the repo URL.

**Option B — manual install:**
1. Locate your SillyTavern `data/<user-handle>/extensions/` folder (per-user, no server
   restart needed) — or `public/scripts/extensions/third-party/` for a global install
   (needs a reload/cache clear).
2. Copy this whole `prompt-folders` folder in, so you end up with
   `.../extensions/prompt-folders/manifest.json`, `index.js`, `style.css`.
3. Reload SillyTavern. A small panel should appear pinned to the right edge of the screen.

## Use

1. Switch to a Chat Completion API and open "AI Response Configuration" at least once so
   the native Prompt Manager renders. If the panel says "Prompt Manager not found," do this
   and click **Refresh**.
2. Build folders with the toolbar **Folder** button, or a row's ⋮ menu.
3. File prompts into folders with their dropdown, or by dragging them.
4. Click a prompt's toggle to flip it on/off, or a folder's toggle to bulk-flip everything
   inside it (at any depth).
5. 👁 to read a prompt (with word/token estimate) without risk of changing it, ✏️ to actually edit it.
6. ⋮ on any row for rename / delete / "add new prompt or folder right after this one".
7. **Preview** in the toolbar for the full compiled view + totals across all enabled prompts.

## A note on creating new prompts — please read

Every other action in this panel works by clicking SillyTavern's own native buttons (toggle,
edit, delete, etc.) — this extension never reimplements ST's logic itself for those. Creating
a new prompt is the one exception. I tried driving the native "New prompt" + "Insert prompt"
flow through several iterations and couldn't get the timing reliable, so at your request this
now writes a new prompt directly into SillyTavern's live settings instead:

- It clones the *shape* of a prompt that's already in your preset as a template (so the new
  object has whatever fields ST expects, without me having to guess them from scratch) —
  only `identifier`, `name`, `content`, and `enabled` are actually changed.
- It looks for wherever ST stores "which prompts are active for this character, in what
  order" — first by character ID via the official `getContext()` API, and if that doesn't
  match anything, by finding whichever internal list's prompt identifiers overlap most with
  what's actually visible on screen right now (cross-checked against real, verified data
  rather than trusted blindly).
- If either step can't find what it's confident is the right place, it **backs out the change
  completely** (removes the definition it just added) and tells you clearly, rather than leave
  a half-created prompt or guess wrong about where your active list lives.
- It then forces SillyTavern's Prompt Manager to redraw using a harmless toggle-off/toggle-on
  on an existing prompt (not a guess at some internal render function), and opens the new
  prompt straight in ST's real editor for you to fill in.

This is inherently more speculative than the rest of the extension, since I don't have
confirmed documentation of SillyTavern's internal settings schema to verify against — I'm
going on general familiarity with how this part of ST is commonly structured. It's built to
fail safely (clear error, automatic rollback) rather than silently corrupt anything, but I'd
suggest keeping an eye on it for the first few uses, especially the first time on a given ST
install, and telling me if anything looks off so I can tighten it up.

## A note on "Remove from list" and restoring prompts on import — please read

Both of these work the same way, and lean on the same direct-settings access as prompt creation
above (see that note for the caveats that apply here too — no confirmed schema documentation,
built to fail clearly rather than guess wrong):

- **Remove from list** finds your active prompt list the same way prompt creation finds it to
  insert into, and deletes just that one entry from it — the prompt's definition elsewhere in
  your settings is never touched. If it can't confidently find that list, it changes nothing and
  tells you, rather than guess.
- **Restoring prompts on import** compares the file's `prompts` / `prompt_order` data against
  what's currently in your settings, and only ever *adds* whatever's missing — it never removes,
  overwrites, or duplicates anything already present. You'll always see a confirmation naming how
  many prompts/list entries it found before anything is written.

One limitation worth knowing: a restored prompt's *content* comes from whatever was in the file
at export time. If you'd edited the prompt after exporting and before deleting it, the restored
version reflects the older, exported content — not whatever the edited version would have been.

## Filter (by content)

Opens a small dialog with a **Match against** choice at the top — **Prompt content (this form)**
or **Chat (live, right now)** — since these two are different questions ("which prompts contain
X" vs. "does the chat currently contain X, and if so, which prompts should that affect"), with
their own flow each:

### Match against: Prompt content

1. Pick what to match by: an **XML tag**, a **word**, a **regex**, or **regex (list matched
   values)**.
   - XML tag: type the tag's name into the **XML tag** box — no `<`/`>`, just the name, e.g.
     `char` for `<char ...>` — and click the 🔍 next to it (or just tab/click away — it scans
     automatically on blur, and Enter works too). This scans every prompt in scope for that tag
     and fills a **Parameters** checklist below with every distinct attribute name found on it
     (e.g. `<char name="Alice" type="hero">` surfaces `name` and `type`), each with a **checkbox**
     and its own **Value** dropdown (defaulting to **All**, plus every value actually seen for
     that attribute).
     - Leave every parameter unchecked to match the tag itself, regardless of its attributes —
       "has a `<char>` anywhere in this prompt".
     - Check one parameter and leave its Value on **All** to require that attribute to be present
       with any value — "has a `<char>` with a `name` attribute, whatever it's set to".
     - Check a parameter and pick a specific value to require that exact (case-insensitive) value
       — "has a `<char>` whose `name` is Alice".
     - Check **multiple** parameters (each with All or a specific value) to AND them together —
       they all have to be true on the *same* tag occurrence, since attributes on one `<char ...>`
       describe one thing, not independent facts. E.g. `name: Alice` + `type: All` matches a
       `<char>` that has both a `name` and a `type` attribute, with `name` specifically Alice.
   - Word: a plain substring, case-insensitive by default — check **Case sensitive** next to the
     field to require an exact-case match instead.
   - Regex: a JavaScript-flavor pattern, case-insensitive — just a yes/no test per prompt, same
     as Word.
   - Regex (list matched values): same pattern syntax, but instead of a plain yes/no test, it
     scans every prompt in scope, pulls out everything the pattern actually matched (capture
     group 1 if the pattern has one, otherwise the whole match), and fills a **Value** dropdown
     with every distinct match found, top entry **All matched values**. Since matched text can be
     long, each dropdown entry is shortened to ~4 words / ~25 characters; click the 👁 next to the
     dropdown to see the current selection's full, untruncated text. Picking a specific value
     re-filters the Matched prompts list to just the prompts containing that exact text, instantly
     (no rescan needed).
2. Click **Apply**. This scans every prompt in scope (using your XML tag + checked parameters, or
   your word/regex) and fills a **Matched prompts** dropdown — again, the top entry is **All
   matched (N)**, meaning all prompts that matched, not literally every prompt in scope.
3. Pick what the buttons below act on: **the prompt** itself, the **last containing folder**
   (each matched prompt's immediate/direct folder only), or **all containing folders** (every
   folder in that prompt's chain, from the top-level folder down — so if a prompt sits in
   `Folder 1 > Folder 2`, "last containing folder" only reaches Folder 2, while "all containing
   folders" reaches both Folder 1 and Folder 2). Either way it's the same folder mute-switch
   behavior as the folder toggle in the tree — see "Folders and subfolders" above.
4. **Disable** / **Enable** applies to whichever the Matched dropdown currently has selected —
   either the one specific prompt, or every match.

Two places open this, with different scope:
- The toolbar's filter icon — scope is every prompt, everywhere.
- A folder's ⋮ menu → "Filter this folder by content…" — scope is just that folder and its subfolders,
  same as the folder's own on/off toggle.

Scanning content works the same way View/Preview already do — direct access first, briefly
opening the native editor as a fallback — so on a version without direct access, scanning many
prompts (especially with the toolbar's "everywhere" scope) takes a visible moment; a progress
line shows while it works.

### Match against: Chat

This is a two-step flow, since checking the chat and picking what it should affect are
independent questions:

1. **Check the chat condition.** Pick a **Match by** — **XML tag** (same tag-name-and-parameters
   picker as prompt content — type a tag, scan it, check whichever attributes you care about), a
   Regex, or a Word (with its own **Case sensitive** checkbox) — and a **Chat depth** (last N chat
   messages, both sides). Click **Check chat** to see whether that condition is currently met in
   the chat — this alone doesn't toggle anything yet. For an XML tag condition, "met" means: for
   every checked parameter, at least one of its known values (or the one specific value you
   picked) shows up somewhere in those messages — with no parameters checked, any value ever seen
   on that tag, on any prompt, counts.
2. **Select prompts to affect.** Once checked, a second section appears: the same match
   vocabulary used for Prompt content above (**XML tag** / **Word** / **Regex** / **Regex (list
   matched values)**), plus a new **Manually choose prompts/folders** option — a scrollable,
   multi-select checklist of every folder and prompt in scope, for hand-picking exactly which
   ones the Enable/Disable buttons below should touch, with no content-matching involved at all.
   Click **Find prompts** (or, for a manual pick, check whatever you want and click it anyway) to
   populate the result.
3. Same as Prompt content above: for a match-based selection, pick a target — **the prompt**,
   **last containing folder**, or **all containing folders** — then **Disable** / **Enable**
   applies to the Matched dropdown's current selection. For a manual pick, there's no target
   choice (folders you checked are folders, prompts you checked are prompts) — Disable/Enable
   just flips exactly what's checked.

The chat condition and the prompt selection are completely independent, same as Auto Filter's
condition/effect split — "Tony in the last 3 messages" can just as easily drive a hand-picked
prompt and folder as it can drive every prompt tagged `<char name="Tony">`. Unlike Auto
Filter, this is a one-off action, not an ongoing rule — nothing here is saved or persists, and
saved Filter presets (below) aren't available for the Chat source. For a live rule that keeps
re-checking the chat on its own, use Auto Filter instead.

### Filter presets

A **Save** button (next to a name field, at the bottom of the modal) saves the current match
spec — match type, value/pattern, and the prompt/last-folder/all-folders target you have
selected — as a named **preset**. You don't need to click Apply or get any matches first; the
target radios are always available to pick from, and a preset re-runs its match spec fresh
every time it's triggered anyway, so nothing about the moment you save it matters except the
spec itself. Presets are listed right below, and persist across reloads.

Each saved preset's row has:
- A **🔒 lock checkbox** — while checked, that preset's Enable/Disable buttons are greyed out and
  do nothing, protecting it from an accidental click. Uncheck to unlock it again.
- **Enable** / **Disable** buttons — unlike the folder tree's toggles, these are one-shot actions,
  not a state you flip: each click re-runs the preset's saved match spec fresh against your
  prompts' *current* content (not whatever matched back when you saved it) and applies
  enable/disable to whatever matches right now.
- A **🗑 remove** button to delete the preset. Removing a preset never undoes whatever it last set.

## Auto Filter

The toolbar's wand icon (🪄) opens **Auto Filter** — this one only lives at the top level, not
per-folder, since it always operates over every live prompt. It's a persisted, *ordered* list of
rules, each one a **condition ⇒ effect** pair — the two halves are completely independent of each
other:

**Condition** — what has to be true for the rule to be "triggered":
- A **Match by** type: **XML tag** (same tag-name-and-parameters picker described above), Specific
  Regex, or Specific Word. Specific Word shows a
  **Case sensitive** checkbox — off by default (plain substring, case-insensitive), check it to
  require an exact-case match against the chat text instead.
- A **Chat depth**:
  - **0** means always on, unconditionally — the chat is never even read for this rule.
  - **N** (1 or more) means: look at the last N messages in the current chat (both sides, in
    whatever order they actually happened), and check whether the condition's trigger text (or,
    for an XML tag condition, its checked parameters' known/chosen values — see "Select prompts to
    affect" above) shows up anywhere in them.

**Effect** — what gets turned on when the condition is triggered (and off again when it isn't):
- **Prompts/folders matching…** — the same match vocabulary as the condition (**XML tag** — its
  own independent tag/parameters picker, not tied to the condition's — Specific Regex, Specific
  Word with its own independent **Case sensitive** checkbox), evaluated
  completely independently of the condition's own match spec. Then, same as the manual filter:
  apply to **the prompt** itself, its **last containing folder**, or **all containing folders**.
- **Manually chosen prompts/folders** — skip content-matching for the effect entirely and just
  check off exactly which prompts and/or folders it should control, from a scrollable checklist of
  everything currently in your preset.

Every prompt or folder marked excluded from Auto Filter (the 🪄 icon on its row — see "Exclude
from Auto Filter" above) is skipped entirely by both halves above: it never counts toward an
XML tag condition's known parameter values, and it's never affected by an effect,
whether the effect matched it by content or you hand-picked it in the manual checklist. This is
completely independent of the regular 🚫 filter-exclude, which Auto Filter ignores.


This split means a rule's trigger and its target don't have to share anything — "Tony shows up in
the last 2 messages" can just as easily turn on one specific hand-picked prompt and folder as it
can turn on every prompt tagged `<char name="Tony">`.

Every enabled rule in the list is re-evaluated, **in list order**, on every trigger: if its
condition is currently met, its effect turns **on**; if not, it turns **off** — so a rule doesn't
just enable things, it also actively disables them when its condition stops being true. Already-
correct prompts/folders are left alone on each pass — nothing gets needlessly re-toggled just
because a rule re-ran and reached the same conclusion.

Other pieces of the modal:
- A **Disable all filters** checkbox at the top — a master kill switch for the whole system
  without touching any individual rule's own enabled state, so turning it back on resumes exactly
  what was running before.
- A **Send/abort triggers** section with two independent, freely-combinable checkboxes:
  - **Re-evaluate when generation finishes or is aborted** — on by default. Fires once the abort
    icon reverts back to the send icon, whether generation finished normally or you stopped it
    manually.
  - **Re-evaluate before sending (wait for filters)** — off by default. Includes the new
    user message and waits for enabled filters before assembling the request, for Send and Enter.
- Each rule in the list has its own **enable/disable checkbox**, an ✏️ to load it back into the
  form above for editing, and a 🗑 to remove it.
- **Drag a rule to reorder it** — the list runs top to bottom, so order can matter when rules'
  effects overlap.
- **Remove all filters** clears the whole list in one go (with a confirmation).
- **Re-evaluate now** re-runs every rule immediately, on demand.

Rules re-evaluate automatically whenever the chat changes (new message, edited, deleted, swiped,
or you switch to a different/new chat), best-effort — see the note below. They also re-evaluate
the moment you add, edit, remove, reorder, or enable/disable one, or flip the master switch.

### Before sending

When enabled, pre-send evaluation uses SillyTavern's awaited `MESSAGE_SENT` event. It waits
for an active filter pass to finish, then evaluates the current chat including the new user
message. Request assembly proceeds after the rule effects finish. There is no fixed wait;
large rule sets can add actual processing time. This behavior was verified on SillyTavern
1.18.0 through a local OpenAI-compatible endpoint using both Send and Enter.

One note on live reactivity: this listens for SillyTavern's own chat events (including the
documented `GENERATION_STOPPED`/`GENERATION_ENDED` events) to know
when to re-check conditions, plus a MutationObserver watching for the abort icon's visibility
flipping back off as a generation-completion fallback. All of this is very standard, stable
parts of SillyTavern's UI/extension API (not the kind of unconfirmed internal-settings guesswork
some of this extension's other notes warn about), but it's still wrapped defensively — if a future
ST version changes its event names or restructures the send/abort icons, Auto Filter simply stops
reacting live to whichever signal broke rather than breaking anything else; the manual
**Re-evaluate now** button and the automatic re-evaluation on adding/editing/removing a rule keep
working regardless.

## A note on reordering — please read

Dragging in this panel physically reorders the real native prompt list to match, top-to-bottom.
I implemented this by directly moving the native list's DOM elements and nudging SillyTavern
with a few common "list changed" events, since I don't have confirmed access to whatever
internal mechanism ST actually uses to persist prompt order across versions. In testing this
is what makes the order in this panel *be* the real order — but because I can't fully verify
the underlying persistence path, treat it as best-effort: if you reload and the order looks
off, or you're relying on exact prompt sequencing for something critical, double-check it in
AI Response Configuration directly. Folder *grouping* itself has no native equivalent and is
always this extension's own bookkeeping — only the flattened top-to-bottom prompt sequence is
pushed to the real list.

## Other notes

- **Multi-select:** Ctrl/Cmd+click a prompt or folder row to add it to a selection (highlighted);
  click empty row space to clear it. Dragging any selected row drags the whole selection together,
  landing as a block wherever you drop it — into a folder, or before/after another row.
- **⋮ menus:** long lists of destructive options (delete, remove-all) are grouped behind a
  submenu instead of listed flat. Any popup menu can be dragged to a new spot by its grip bar
  along the top, and is always kept fully on-screen even when the panel is docked against a
  screen edge.
- **Remove All** (toolbar, next to Import/Export) lets you choose exactly what to remove —
  folders only, folders and their contents, prompts only, or everything — each with its own
  not-permanent/permanent choice where that applies.
- **Import append:** the toolbar's "Import append" always merges into your whole structure.
  Right-click (⋮) a specific folder or prompt for "Import append after this folder/prompt" to
  merge a file's contents in alongside just that one item instead.
- Word/token counts shown via 👁 View and **Preview** are estimates (~4 characters per token,
  a common rough approximation) — not SillyTavern's real tokenizer count. They're meant for
  a quick sense of scale, not a precise budget figure.
- 👁 View and **Preview** try to read content directly from SillyTavern's settings first
  (via a *dynamic* import that's wrapped in a try/catch, so it can never crash the extension
  even if that path doesn't exist on some version — it just silently falls back). If that
  fails, they fall back to briefly opening/closing the native editor instead, in which case
  you may see a prompt's editor flash open for a moment — that's the fallback path working
  as intended, not a glitch. If you ever see a toast saying the native editor "may still be
  open," it means even that fallback couldn't confirm it closed — check your screen and close
  it manually if needed.
- This reads the *rendered* Prompt Manager DOM rather than SillyTavern's internal prompt
  array, so it only works once the Prompt Manager has rendered at least once this session —
  it self-heals as soon as you open it.
- Folder assignments are matched by prompt identifier, which is stable across presets for
  both built-in prompts (Main Prompt, Post-History Instructions, etc.) and prompts you create.
  This is also why a prompt you've unlisted (rather than deleted) reappears in its old folder
  automatically if you bring it back later.
- Deleting a folder moves its prompts up one level rather than un-filing them completely, so
  you don't lose organization by accident.
- Add/Delete/Rename/View all rely on locating specific elements in SillyTavern's native popup
  and footer UI. I've built in fallback selectors and centralized them all at the top of
  `index.js` in one `SELECTORS` object, so if a future ST update changes something and one of
  these stops working, that's the one place to fix — and the panel will tell you clearly
  (via a toast message) rather than fail silently.
