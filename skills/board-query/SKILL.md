---
name: board-query
description: Answer general questions about the state of the My Kanban dashboard (this project) — summaries, filters, and lookups across boards and items. "Card", "item", "task", and "ticket" are used interchangeably by the user for the same concept. Use when the user asks a question about what's on the board(s) rather than asking to create, update, or move something — e.g. "summarize the board", "list priority items", "show me items for tag X", "show me items overdue", "what are the blockers for <customer>", "what items should I focus on this week", "show me high impact items", or any other open-ended question about board contents. Not for creating/editing an item (see kanban-item) or moving one between boards (see move-item).
capability: Answer questions about what's on the board(s) — summaries, filters, overdue items, blockers, and more
example: Summarize the board.
---

# My Kanban — Board Query / Q&A Skill

This skill documents how to answer general natural-language questions about the state of
the **My Kanban** local dashboard (`C:\IrfDocs\Projects\my-kanban`) — as opposed to
creating, updating, or moving a specific item (see the `kanban-item` and `move-item`
skills for those).

The app must be running first: `Start Kanban.vbs` (opens `http://localhost:9000`).
To stop it and free the port: `Stop Kanban.vbs`.

## Terminology

The user may say **"card"**, **"item"**, **"task"**, or **"ticket"** interchangeably —
treat all four as referring to the same thing (an item object inside a board column).

## When this applies

This applies whenever the user is **asking a question** about the board(s) rather than
asking to change anything. There is no fixed list of supported questions — answer
whatever is asked, as long as it can be answered from the item data. Examples include
(but are not limited to):

- "Summarize the board" / "summarize <board name>"
- "List priority items" / "show me high priority items" / "show me high impact items"
- "Show me items for tag `<tag>`"
- "Show me items overdue" / "what's overdue?"
- "What are the blockers for `<customer/board name>`?"
- "What items should I focus on this week?"
- "How many items are in progress on `<board>`?"
- "What's the status of `<item heading>`?"

Not for: creating a new item (`kanban-item`), editing an existing item's own fields
(`kanban-item`), or moving an item from one board to another (`move-item`).

## Scope: one board vs. all boards

- If the user explicitly names one of the existing boards/tabs (General, Westpac, CBA,
  AusSuper, Ampol, NSW DOE, USyd, or any renamed/added board), restrict the answer to
  that board's items only.
- If no board is named, answer across **all** boards, and mention which board(s) each
  item/finding belongs to when it's relevant (e.g. summarizing across boards or listing
  items from several boards at once).

## Golden rule: answer only from real item data, never from outside knowledge

The assistant must **never** use its own general knowledge, guesses, or assumptions to
answer these questions — the only source of truth is the actual item data stored in
`data\kanban-data.json` (heading, column, priority, due date, tags, and the description
sections: Outcome, Current status, Next action, Blockers, Dates, Contacts, Update
History).

- If the data doesn't contain enough information to answer confidently (e.g. asking about
  a customer/tag/topic that doesn't appear on any item), do **not** guess or fabricate an
  answer — give a short, friendly response saying that information wasn't found on the
  board, and suggest checking the board directly or rephrasing.
- "Priority" in the data is stored as `green` (Low), `yellow` (Medium), `orange` (High) —
  translate to the friendly words when answering.
- "Overdue" means the item has a due date earlier than today's date and isn't already in
  the Completed column.
- Treat the free-text description sections (especially "Blockers", "Current status", and
  "Contacts") as the primary source for questions like "what are the blockers for X" or
  "who's involved in Y" — search across those fields, not just the heading.

## Option A — Ask via the Copilot chat assistant (primary entry point)

The chat panel's backend (`/api/copilot-chat` in `src\server.js`) implements this as a
first-class plan action: the CLI planning prompt (`buildPlanPrompt`) is given the full
detail of every item across every board (headings, columns, priority, due dates, tags,
and description sections) and supports `"action": "query"`. When the model recognizes a
general question (rather than a create/update/move request), it sets `action` to
`"query"` and composes the answer directly in `reply`, using only the item data supplied
in the prompt — `executePlan()` simply returns that `reply` as-is (no board data is
changed for a query). If the model can't find an answer in the data, `reply` will say so
plainly instead of guessing.

## Option B — Answer manually via the local HTTP API

`GET http://localhost:9000/api/data` returns the full JSON store — every board, column,
and item (heading, description HTML, priority, dueDate, completionDate, tags,
activityLog). Read through this directly to answer a question without going through the
chat assistant, e.g.:

```powershell
$data = Invoke-RestMethod http://localhost:9000/api/data
$today = (Get-Date).ToString('yyyy-MM-dd')
foreach ($board in $data.boards) {
  foreach ($col in $board.columns.PSObject.Properties.Name) {
    foreach ($item in $board.columns.$col) {
      if ($item.dueDate -and $col -ne 'Completed' -and $item.dueDate -lt $today) {
        "$($board.name) / $col : $($item.heading) (due $($item.dueDate))"
      }
    }
  }
}
```

This is a read-only lookup — never write back to `/api/data` when just answering a
question.
