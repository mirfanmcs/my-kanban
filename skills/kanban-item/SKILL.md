---
name: kanban-item
description: Add a new item (card/task/ticket) or update an existing item on the My Kanban dashboard (this project). "Card", "item", "task", and "ticket" are used interchangeably by the user for the same concept. Use when the user asks to create/add a card, item, task, or ticket to a board/column, or edit/update an existing one's heading, description, priority, due date, tags, or checklist — either through the app's UI or directly against its local data file/API.
capability: Add a new card or update an existing one (heading, description, priority, due date)
example: Add a low priority card to the Westpac board to follow up on the loan renewal.
---

# My Kanban — Add / Update Item Skill

This skill documents the "Add / Edit Item" dialog and underlying data model for the
**My Kanban** local dashboard (`C:\IrfDocs\Projects\my-kanban`), so an agent can create or
update items either by driving the UI (Playwright) or by editing the JSON store directly
through the local HTTP API.

The app must be running first: `Start Kanban.vbs` (opens `http://localhost:9000`).
To stop it and free the port: `Stop Kanban.vbs`.

## Terminology

The user may say **"card"**, **"item"**, **"task"**, or **"ticket"** interchangeably —
treat all four as referring to the same thing (an item object inside a board column).
Don't ask for clarification if the user switches terms mid-conversation; "add a card",
"add an item", "add a task", and "add a ticket" all mean the same create/update intent
covered by this skill.

## Data model

Data lives in `data\kanban-data.json` and is served/persisted via a tiny Node server
(`src\server.js`) on port 9000. Top-level shape:

```json
{
  "boards": [
    {
      "id": "board-general",
      "name": "General",
      "columns": {
        "To Do": [ /* item objects */ ],
        "In Progress": [ /* item objects */ ],
        "Completed": [ /* item objects */ ]
      }
    }
  ],
  "archived": [],
  "archivedBoards": [],
  "settings": { "wipLimits": {} },
  "_rev": 1
}
```

Boards (tabs) are separate objects in `boards[]`, each with the same three fixed
columns: `"To Do"`, `"In Progress"`, `"Completed"`. Items only ever live inside one
column array at a time — moving an item means removing it from one column array and
pushing it into another.

### Item object schema

```json
{
  "id": "item-1784965094557-080up9",
  "heading": "Short title (max 120 chars)",
  "description": "<p>...rich HTML from the contenteditable editor...</p>",
  "priority": "green | yellow | orange",
  "dueDate": "YYYY-MM-DD or null",
  "completionDate": "YYYY-MM-DD or null",
  "tasks": [
    { "id": "task-id", "text": "Checklist line", "done": false }
  ],
  "tags": [
    { "text": "TagName", "color": "blue" }
  ],
  "activityLog": [
    { "ts": "ISO-8601 timestamp", "text": "Created in \"To Do\"" }
  ]
}
```

Field rules:
- `id`: generate as `'item-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)` (see `uid()` in `src\app.js`).
- `priority`: one of `green` (Low), `yellow` (Medium), `orange` (High). Default `green`.
- `dueDate`: user-settable date string, or `null`. Card shows an "⚠ Overdue" badge if
  `dueDate < today` and the item isn't in `Completed`. **See "`dueDate` vs. dates
  mentioned in the content" below — do not auto-fill this from every date the user
  mentions.**
- `completionDate`: **do not expose this as an editable field** — it is set
  automatically to today's date (`YYYY-MM-DD`) whenever an item is moved into (or
  created directly in) the `Completed` column, and cleared (`null`) when moved back out.
  This mirrors the app's own logic in `moveItem()`.
- `tags`: array of `{ text, color }`. Valid `color` keys: `blue, purple, teal, pink,
  gray, green, yellow, orange, red` (see `TAG_COLORS` in `src\app.js`).
- `description`: HTML string from a rich-text editor. **Always use the template below
  when creating/updating items** — see "Filling the description template" for how to
  decide what goes where.
- `activityLog`: append-only audit trail; add an entry (e.g. `Created in "To Do"`,
  `Edited (heading, priority)`, `Moved from "To Do" to "Completed"`) for every change,
  matching `logActivity()` behavior.

## Filling the description template

Every item's `description` MUST use this exact template structure (from
`DESCRIPTION_TEMPLATE` in `src\app.js`) — one `<p class="desc-field" data-label="...">`
per section, each followed by an empty `<p><br></p>` spacer:

```html
<p class="desc-field" data-label="Outcome:"><br></p><p><br></p>
<p class="desc-field" data-label="Current status:"><br></p><p><br></p>
<p class="desc-field" data-label="Next action:"><br></p><p><br></p>
<p class="desc-field" data-label="Blockers:"><br></p><p><br></p>
<p class="desc-field" data-label="Dates:"><br></p><p><br></p>
<p class="desc-field" data-label="Contacts:"><br></p><p><br></p>
<p class="desc-field" data-label="Update History:"><br></p><p><br></p>
```

**Understand the user's intent and route their words into the matching section(s)**
instead of dumping everything into one field. Interpret loosely — users won't say
"Outcome" or "Blockers" literally, so map based on meaning:

| Section | Put in this section when the user talks about... |
|---|---|
| `Outcome:` | The goal, deliverable, or what "done" looks like for this item |
| `Current status:` | Where things stand right now, progress made so far |
| `Next action:` | What needs to happen next, an upcoming step or to-do |
| `Blockers:` | Anything stuck, waiting on someone/something, risks, issues |
| `Dates:` | Deadlines, meeting dates, milestones mentioned in the request |
| `Contacts:` | People, teams, or stakeholders named by the user |
| `Update History:` | A log-style note the user explicitly wants recorded as a dated update |

Rules:
- Fill in **only the sections the user actually gave information for**; leave the rest
  as the empty `<p><br></p>` placeholder from the template — don't invent content.
  **This "leave the rest empty" rule applies to brand-new items only.** See
  "Creating vs. updating" below — updating an existing item must never reset
  unmentioned sections to blank.
- If the user's request doesn't clearly map to a section (e.g. a one-line heading-only
  request), it's fine to leave every section empty and just set the `heading`.
- To fill a section, replace its empty `<p class="desc-field" data-label="X:"><br></p>`
  with `<p class="desc-field" data-label="X:">the user's text</p>`, keeping the
  `data-label` and the trailing spacer `<p><br></p>` intact so the app's rich-editor
  styling still recognizes the field.
- **`Outcome:` must be a complete, self-contained statement of what "done" looks like** —
  synthesize it from everything relevant the user said (the action, who's involved, and
  any date/time that's part of the outcome itself), don't just copy a short fragment of
  their sentence and drop the rest. Reword/combine the user's own words into one clear
  sentence rather than truncating; don't introduce facts they didn't mention (e.g. the
  board/tab name isn't automatically part of the outcome unless the user said it).
- Keep the user's own wording elsewhere — summarize only if the input is long; don't
  rephrase short factual statements unnecessarily.

### Creating vs. updating — never reset an existing item's description

The "start from the blank template" approach above is only for a **brand-new** item.
When **updating** an item that already exists:

1. **Always start from the item's current `description` HTML** (parse it, don't
   regenerate it from the empty template) and change only the section(s) the current
   request is actually about — every other section keeps its existing value exactly
   as it was, byte-for-byte.
2. **`Outcome:` is the clearest example of a section that must survive updates
   untouched** — once set when an item is created, treat it as static. Never blank it,
   never regenerate it, never drop it while rebuilding the rest of the description —
   even if the current update request doesn't mention it at all (which is the normal
   case). Only change `Outcome:` if the user's current request is explicitly about
   redefining the goal/outcome itself.
3. This applies no matter which mechanism you use to persist the change — Option A (UI)
   naturally preserves untouched sections since you're editing inside the existing
   rich-text box, but Option B (API) requires you to explicitly carry forward every
   section's current HTML for anything you're not changing, rather than reconstructing
   the description from scratch.
4. The `item-update` skill (WorkIQ-sourced refreshes) follows this same rule and never
   touches `Outcome:` under any circumstance — see that skill for details.

### Worked example

Request: *"create a new card with low priority to setup a meeting with CBA. I want
meeting to be setup on 4th August 2027 with architecture team."* (assume this is being
added to the **CBA** board, matched per the board-matching rule below)

- `heading`: `Set up a meeting with architecture team`
- `Outcome:` → `Set up a meeting with the architecture team on 4th August 2027.`
  (combines the action + who + when into one outcome statement — don't just say
  "Setup a meeting with CBA" and lose the date/team, and don't repeat "CBA" here since
  that's already the board this item lives on, not new information about the outcome)
- `Dates:` → `Meeting date: 4th August 2027`
- `Contacts:` → `Architecture team`
- `dueDate` (top-level field): **leave as `null`** — see the rule below on when to set it.

## `dueDate` vs. dates mentioned in the content

The top-level `dueDate` field is a **deadline for completing the item itself** — it
drives the "⚠ Overdue" badge on the card. It is **not** the same thing as any date
mentioned as part of what the item describes (e.g. a meeting date, an event date, a
milestone the item is about).

- Only set `dueDate` when the user is explicitly asking for a deadline for finishing
  the task/item (e.g. "this needs to be done by 10 August", "due date next Friday").
- If the date the user mentions is really describing *when something in the outcome
  happens* (a meeting, an appointment, an event) rather than a deadline for the card
  itself, put that date in the `Dates:` section of the description only — leave
  `dueDate` as `null`.
- When genuinely ambiguous, prefer leaving `dueDate` unset (`null`) and recording the
  date in `Dates:` — it's better to under-set this field than to wrongly flag an item
  as overdue later.

## Updating "Current status" — archive the old value to Update History

When an update changes the `Current status:` section on an **existing** item, don't
just overwrite it — preserve the trail:

1. Read the item's existing `Current status:` text **before** making any change.
2. If it's non-empty, append it to `Update History:` as a new dated line, in the form:
   `YYYY-MM-DD: <previous current status text>` (use today's date, `todayStr()`
   format — see `src\app.js`). Add this as a new line/paragraph so prior history
   entries are never lost — don't replace older Update History lines, only add to them.
3. Only then replace `Current status:` with the new text the user gave.
4. If `Current status:` was empty (new item, or never set), skip step 2 — there's
   nothing to archive.
5. Also add a matching `activityLog` entry (e.g. `Edited (description)`), consistent
   with existing edit-tracking behavior.

This keeps `Current status:` always showing the latest state while `Update History:`
accumulates a running, dated log of every prior status — mirroring how a user
manually maintains status updates over time.

## Matching the item to a board (tab)

Before creating a **new item**, first check whether the user explicitly named a board
in their request (e.g. "add a task to Westpac", "create a card in CBA"). Match whatever
they said against the existing board names in `boardData.boards[].name` (or the tab
names visible in the UI), **case-insensitively** and tolerant of minor differences
(e.g. "AusSuper" / "aus super") — the app's own `fuzzyMatches()` in `src\app.js` uses
the same tolerant-matching approach.

- If exactly one board name matches (or fuzzy-matches), create the item there directly.
- If the user did **not** mention a board name, or what they said doesn't clearly match
  any existing board, **do not guess and do not default to `General`.** Instead, ask the
  user which board to use (list the current board/tab names) and wait for their answer
  before creating anything.
- Once the user replies with a board name, match it the same tolerant way and create the
  item there. If their reply still doesn't match any board, ask again rather than
  guessing.
- Never silently create a new board/tab to satisfy an unmatched name — only add to an
  existing board that the user has confirmed.
- This "ask first" rule only applies to **creating** new items. Updating an existing
  item doesn't need this, since the item being updated already belongs to a specific
  board.

## Option A — Add/update via the UI dialog (recommended, matches user-visible behavior)

The "New Item" / "Edit Item" modal (`#modalOverlay` in `src\index.html`) has these
controls:

| Field | Selector | Notes |
|---|---|---|
| Heading | `#itemHeading` | required, max 120 chars |
| Priority | `#priorityPicker .priority-swatch[data-priority="green\|yellow\|orange"]` | click to select |
| Due Date | `#itemDueDate` | `<input type="date">` |
| Tag name | `#newTagText` + `#addTagBtn` | type then click "+ Add Tag"; color chosen via `#tagColorPicker` swatch first |
| Description | `#itemDescription` (contenteditable) | toolbar `#descToolbar` has Bold/Italic/Underline/Heading/Bullet-list/Numbered-list/Font-color/Highlight-color buttons using `execCommand` |
| Task checklist | "+ Add Task" button, then per-row text input + checkbox | |
| Save | `#saveItemBtn` | |
| Delete (edit mode only) | `#deleteItemBtn` | |

To add a new item: click a column's `.add-item-btn` (opens an inline quick-add row),
either fill the quick text input + click `.quick-add-confirm` for a heading-only card,
or click `.quick-add-full-link` to open the full modal for all fields.

To edit an existing item: click its `.card` to open the same modal pre-filled via
`openModal(boardId, column, itemId)`; there is **no Completion Date field** in the
dialog — completion date is derived automatically from column placement, never edited
directly.

Drag-and-drop between columns (native HTML5 DnD, `.card[draggable=true]`) is how items
move between To Do / In Progress / Completed; this is what sets `completionDate`
automatically.

## Option B — Add/update directly via the local API (fast, scriptable, no browser needed)

The server exposes a tiny JSON API on `http://localhost:9000`:

- `GET /api/data` → returns the full data object including `_rev`.
- `POST /api/data` with the **entire** data object as the body (including the `_rev`
  you just read) → persists it. The server increments `_rev` and returns
  `{ ok: true, rev: <newRev> }`.
- **Revision conflict protection**: if the `_rev` you send doesn't match the server's
  current `_rev` (e.g. someone edited via the browser in between), you get back
  `HTTP 409` with `{ ok: false, conflict: true, latest: <serverData> }`. Always
  `GET` fresh data immediately before you `POST`, mutate in memory, then `POST` the
  whole object back — don't try to patch blindly.

Example (PowerShell) to add a new item to the "To Do" column of the "General" board:

```powershell
$data = Invoke-RestMethod http://localhost:9000/api/data
$board = $data.boards | Where-Object { $_.name -eq 'General' }
$newItem = @{
  id = 'item-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + '-' + (Get-Random -Maximum 999999)
  heading = 'New task from script'
  description = ''
  priority = 'green'
  dueDate = $null
  completionDate = $null
  tasks = @()
  tags = @()
  activityLog = @(@{ ts = (Get-Date).ToString('o'); text = 'Created in "To Do"' })
}
$board.columns.'To Do' += $newItem
Invoke-RestMethod -Uri http://localhost:9000/api/data -Method Post -ContentType 'application/json' -Body ($data | ConvertTo-Json -Depth 10)
```

When updating an existing item this way: find it by `id` inside whichever column
array currently holds it, mutate its fields in place, push an `activityLog` entry
describing the change, and if you change its column, remember to also set/clear
`completionDate` per the rule above (moving into `Completed` → today's date; moving
out of `Completed` → `null`).

## Which option to use

- **Prefer Option A (UI)** when the user is actively looking at the dashboard and
  wants to see the change happen, or when the change involves rich-text description
  formatting that's easiest to express through the editor toolbar.
- **Prefer Option B (API)** for bulk/scripted changes, or when no browser session is
  open — it's faster and avoids any Playwright/browser dependency. Always re-fetch
  `_rev` right before posting to avoid clobbering concurrent UI edits.

## After changes

If you used Option B while the dashboard is open in a browser tab, the tab won't
auto-refresh — the user must reload to see the update (the app's conflict banner will
warn them if they try to save stale UI state on top of your change).
