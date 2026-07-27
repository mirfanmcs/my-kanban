---
name: move-item
description: Move an existing item (card/task/ticket) from one board (tab) to another on the My Kanban dashboard (this project). "Card", "item", "task", and "ticket" are used interchangeably by the user for the same concept. Use when the user asks to move, relocate, or transfer an existing card/item/task/ticket to a different board — e.g. "move item A from board XY to AB", "move the renewal card to Westpac", "put the laptop insurance card on CBA instead". Not for creating new items or editing an item's own fields (heading, description, priority, due date) — see the kanban-item skill for those.
capability: Move an existing card from one board to another
example: Move the loan renewal card from Westpac to CBA.
---

# My Kanban — Move Item Between Boards Skill

This skill documents how to move an existing item from one board (tab) to a different
board on the **My Kanban** local dashboard (`C:\IrfDocs\Projects\my-kanban`), either by
driving the UI (Playwright) or by editing the JSON store directly through the local
HTTP API.

The app must be running first: `Start Kanban.vbs` (opens `http://localhost:9000`).
To stop it and free the port: `Stop Kanban.vbs`.

## Terminology

The user may say **"card"**, **"item"**, **"task"**, or **"ticket"** interchangeably —
treat all four as referring to the same thing (an item object inside a board column).
"Move", "relocate", "transfer", and "put ... on ... board instead" all express the same
intent covered by this skill. Don't ask for clarification if the user switches terms
mid-conversation.

## When this applies

This is a **move**, not an edit — the item keeps everything about itself (heading,
description, priority, due date, tags, checklist, column) exactly as it is. Only the
board it belongs to changes. Do not confuse this with:

- Creating a new item (see the `kanban-item` skill).
- Moving an item between **columns** (To Do / In Progress / Completed) on the *same*
  board — that's a column move, not a board move, and doesn't need this skill.
- Editing an item's own fields — that's an update, not a move.

## Data model (relevant parts)

Data lives in `data\kanban-data.json` and is served/persisted via a tiny Node server
(`src\server.js`) on port 9000. Each board has this shape:

```json
{
  "id": "board-general",
  "name": "General",
  "columns": {
    "To Do": [ /* item objects */ ],
    "In Progress": [ /* item objects */ ],
    "Completed": [ /* item objects */ ]
  }
}
```

Moving an item between boards means: find the item object inside its current board's
column array, remove it from there, and push the same object (unchanged) into the
**same-named column** on the destination board. Also append an entry to the item's
`activityLog` array, e.g.:

```json
{ "ts": "2026-07-26T02:10:00.000Z", "text": "Moved from board \"General\" to \"Ampol\"" }
```

## Understanding the user's intent

A move request always needs **three** pieces of information: (1) which item, (2) the
source board it's currently on, and (3) the destination board to move it to. Try to
extract all three independently from the user's own words in a single pass — never
guess or infer one piece from another (e.g. don't assume the source board just because
you found the item there in the data; the user has to actually say it).

1. **Which item** — match by heading against the items listed across all boards,
   tolerant of minor wording/casing differences (the same tolerant-matching approach as
   the app's own `fuzzyMatches()` in `src\app.js`).
2. **Source board** — the board the user says the item is currently on, matched the same
   case-insensitive/tolerant way (e.g. "AusSuper" / "aus super"). This must come from
   something the user actually said, not be assumed from wherever the item happens to
   live in the data.
3. **Destination board** — the board name the user wants the item moved to, matched the
   same tolerant way.

If **any one of these three** can't be confidently determined from the user's message,
**do not guess and do not proceed** — ask the user a direct clarifying question for
exactly the missing piece (e.g. "Which item/card would you like to move?", "Which board
is it currently on?", or "Which board should I move it to?"), listing the current
board/tab names when asking about a board. Wait for their answer before doing anything.
Ask about only one missing piece at a time, in this order: item, then source board, then
destination board.

Once all three are known:

- If the item you found is not actually on the source board the user named, point that
  out and ask them to confirm rather than silently moving the item from wherever it
  really is.
- If the destination board is the same as the source board, say the item is already
  there rather than performing a no-op move.
- Never silently create a new board/tab to satisfy an unmatched name — only move
  to/from an existing board that the user has confirmed.

## Option A — Move via the UI (recommended, matches user-visible behavior)

Two ways to move a card between boards directly in the UI:

- **Quick-move dropdown**: hover any card to reveal a small **⇄** icon (next to the 🗑
  archive icon). Click it to open a "Move to board" dropdown listing the other boards,
  then click the destination board name. The card moves immediately, with a 6-second
  undo toast in case of a mis-click.
- **Drag and drop onto a tab**: drag a card and drop it directly onto a board tab at the
  top of the page. The target tab highlights while dragging over it; dropping moves the
  card to that board's same column.

Both are implemented in `src\app.js` — see `moveItemToBoard()` for the underlying logic
(handles the column-array splice/push, activity log entry, undo support, save, and
re-render) and the `.card-move-*` / tab `dragover`/`drop` handlers for the two entry
points above.

## Option B — Move via the local HTTP API

`GET http://localhost:9000/api/data` returns the full JSON store (including `_rev`).
`POST http://localhost:9000/api/data` with the full updated JSON (including the
incremented `_rev`) saves it back. The server rejects the save with a 409 conflict if
`_rev` doesn't match the latest server copy — always re-fetch first if unsure.

Example (PowerShell) to move an item from "General" to "Ampol", keeping its column:

```powershell
$data = Invoke-RestMethod http://localhost:9000/api/data
$fromBoard = $data.boards | Where-Object { $_.name -eq 'General' }
$toBoard   = $data.boards | Where-Object { $_.name -eq 'Ampol' }
$column = 'To Do'
$item = $fromBoard.columns.$column | Where-Object { $_.heading -eq 'Renew office lease' }
$fromBoard.columns.$column = @($fromBoard.columns.$column | Where-Object { $_.id -ne $item.id })
$item.activityLog += @{ ts = (Get-Date).ToString('o'); text = "Moved from board `"$($fromBoard.name)`" to `"$($toBoard.name)`"" }
$toBoard.columns.$column += $item
$data._rev += 1
Invoke-RestMethod -Method Post -Uri http://localhost:9000/api/data -ContentType 'application/json' -Body ($data | ConvertTo-Json -Depth 20)
```

## Option C — Move via the Copilot chat assistant (natural language)

The chat panel's backend (`/api/copilot-chat` in `src\server.js`) already implements
this as a first-class plan action: the CLI planning prompt (`buildPlanPrompt`) supports
`"action": "move_board"` with `target_item_id`/`item_hint`, `source_board`, and
`destination_board` fields, each left `null` by the model when the user didn't clearly
state it. `executePlan()` validates all three independently and performs the move via
`moveItemToOtherBoard()` only once all three are confirmed. If any piece is missing —
which item, which source board, or which destination board — the server stores a
`pendingAction` of type `move_slots` (tracking whichever pieces are already known) and
asks the user a direct question for exactly the missing one; each follow-up reply is
resolved locally against item headings/board names without needing another CLI call,
one slot at a time, until the move can be carried out.
