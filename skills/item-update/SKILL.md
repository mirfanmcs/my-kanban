---
name: item-update
description: Refresh existing item(s) (card/task/ticket) — a single item, a whole board, or all boards — on the My Kanban dashboard (this project) with real, current information automatically searched for via the GitHub Copilot WorkIQ plugin (email, calendar, Teams chats/channels, meeting notes/minutes, meeting transcripts). "Card", "item", "task", and "ticket" are used interchangeably by the user for the same concept. Use whenever the user asks to update/refresh a card, a board's items, or all items — the user does NOT need to say where to search (no need to say "from my emails" etc.) — always search all WorkIQ sources automatically. Examples: "update setup meeting with CBA item", "update all items on Westpac board", "refresh all items on Ampol board", "refresh all items across all boards", "update all items". Not for creating a brand-new item from scratch (see kanban-item) or moving an item between boards (see move-item) — this skill is specifically about pulling real updates from WorkIQ sources into existing items.
capability: Update existing cards with real details automatically found across your email, calendar, chats, and meeting notes/transcripts (via WorkIQ)
example: Refresh all items on the CBA board.
---

# My Kanban — Item Update Skill

This skill documents how to refresh existing items on the **My Kanban** local dashboard
(`C:\IrfDocs\Projects\my-kanban`) using **real, current information automatically
retrieved through the GitHub Copilot WorkIQ plugin** (email, calendar, Teams
chats/channels, meeting notes/minutes, and meeting transcripts) — as opposed to the
`kanban-item` skill's generic create/update mechanics, which this skill relies on for the
actual field/template rules once the real content has been gathered.

The app must be running first: `Start Kanban.vbs` (opens `http://localhost:9000`).
To stop it and free the port: `Stop Kanban.vbs`.

## Terminology

The user may say **"card"**, **"item"**, **"task"**, or **"ticket"** interchangeably —
treat all four as referring to the same thing (an item object inside a board column).

## The user never has to say where to search — always search everything

When the user asks to update or refresh a card, a board, or all boards, **always**
search across **all** WorkIQ sources automatically: email, calendar, Teams chats and
channels, meeting notes/minutes, and meeting transcripts. The user does not need to (and
usually won't) say "from my emails" or "using my calendar" — a plain "update the CBA
board" or "refresh this card" is a complete, valid request on its own. Trigger this skill
for phrasing such as:

- "update setup meeting with CBA item"
- "update all items on Westpac board"
- "refresh all items on Ampol board"
- "refresh all items across all boards"
- "update all items"
- "refresh this card" / "update this card" (when a specific item is clear from context)

Do not ask the user which sources to search — only ask a clarifying question if the
*item* or *board* itself can't be confidently identified (see Scope below).

## WorkIQ — what it means, and what to do if it isn't available

**"WorkIQ" in this skill always means the GitHub Copilot WorkIQ plugin** (the plugin that
gives Copilot access to the user's Microsoft 365 mail, calendar, Teams chats/channels,
meeting notes, and meeting transcripts). Before running this skill, confirm the WorkIQ
plugin/skill is actually available to the current agent session (e.g. check `/env` or
the list of currently available skills/plugins).

**If the WorkIQ plugin is not installed or not available in this session**, do not guess
at information or silently skip the WorkIQ step — tell the user clearly that WorkIQ
isn't available and give them these instructions to install it:

1. In the GitHub Copilot CLI, run `/plugin` to open the plugin manager.
2. Browse or search the plugin marketplace for **WorkIQ** and install it.
3. Once installed, restart the session (`/restart` or start a new one) so the WorkIQ
   plugin/tools become available, then re-run the update request.

Only proceed with this skill once WorkIQ is confirmed available.

## Golden rule: only use what WorkIQ actually returns — never guess

This is the most important rule in this skill:

- **Never** use your own outside/general knowledge to fill in or infer any part of an
  item's update. The only acceptable source of new content is what WorkIQ genuinely
  returns from the user's real email, calendar, chats, meeting notes/minutes, or meeting
  transcripts.
- **Never fabricate, assume, or "fill in the gaps"** — if WorkIQ doesn't return anything
  relevant for a given item (or for a specific section of it), leave that item/section
  untouched rather than inventing plausible-sounding content.
- If you cannot confidently match the item or board the user asked about, **do not
  update anything** — report back that you couldn't find a match, rather than guessing
  which item/board they meant.
- If you *can* match the item/board but WorkIQ has no relevant information for it, **do
  not update that item** — leave its existing content exactly as-is and mention in your
  summary that no new information was found for it.

## Scope: what the user can ask to update

The user's request determines how many items to process — figure this out from their
wording before doing anything:

1. **A single item** — the user gives (or you can infer from context) the item's
   **heading** and/or its current **`outcome`** field text (e.g. "update the 'Set up a
   meeting with architecture team' card", "update the card about the loan renewal").
   Match this against the top-level `heading` and `outcome` fields across the relevant
   board(s), the same tolerant/fuzzy way `move-item`'s `matchItemByHeading` works
   (case-insensitive, minor wording differences OK). If the user also named a board,
   restrict the search to that board first.
2. **A whole board** — the user names one of the existing boards/tabs (e.g. "update all
   items on the CBA board", "refresh Westpac"). Match the name the same tolerant way
   against `boardData.boards[].name`. Process every item on that board.
3. **All boards** — the user says something like "update all items" / "refresh all items
   across all boards". Process every item across every board.

If the scope itself (which item, or which board) can't be confidently matched, stop and
tell the user you couldn't find a match — do not proceed on a guess.

## Determining the account/customer to search WorkIQ for

Before querying WorkIQ for a given item, work out which real-world account/customer it
relates to, so your WorkIQ search is scoped correctly rather than searching everything:

1. **Board name first** — boards in this dashboard are literally named after the
   accounts/organizations items are about (e.g. `Westpac`, `CBA`, `AusSuper`, `Ampol`,
   `NSW DOE`, `USyd`). The board an item lives on is your primary signal for which
   account/customer to search for in WorkIQ.
2. **`outcome` field second** — the item's top-level `outcome` field (a static,
   one-time-set statement of what "done" looks like for this item — see `kanban-item`)
   is one of the richest sources of search context: it often names the account, the
   specific deal/initiative, and the goal in one sentence. Always fold the `outcome`
   text into your WorkIQ search keywords. Also check the item's `Contacts:` description
   section (and any other filled section) for named people or teams to narrow the
   search further (e.g. searching for a specific contact's name in addition to the
   account).
3. **Priority and tags third** — also read the item's `priority` (Low/Medium/High) and
   `tags` array. Tags often carry extra topic/category/contact context (e.g. a tag
   naming a product, workstream, or person) that isn't repeated anywhere in the
   description — fold any tag text into your WorkIQ search keywords too. Priority
   doesn't change *what* you search for, but treat higher-priority (`orange`/High)
   items as more important to search thoroughly (check email, calendar, chats, meeting
   notes, and transcripts all, rather than stopping at the first source that returns
   something) and to call out clearly in your end-of-run summary.
4. Combine all of the above: search WorkIQ using the account/customer name (from the
   board) together with the item's own heading/`outcome`-field keywords, any named
   contacts, and any tag text, so you find genuinely relevant messages/meetings rather
   than everything mentioning the account.

## Step-by-step process

For each item in scope:

1. **Read the item's current state first** — `GET /api/data`, find the item, and note
   its existing `heading`, top-level `outcome` field, `priority`, `tags`, and
   description sections (especially the current `Current status:` and `Contacts:`) —
   `outcome` plus `heading`, `Contacts:`, and `tags` together anchor your WorkIQ search
   and your section-mapping decisions.
2. **Search WorkIQ** (always all sources: email, calendar, chats, meeting notes/minutes,
   and meeting transcripts — never ask the user which source to use) using the
   account/customer name plus the item's heading/`outcome`-field/contact/tag keywords
   (see above). Look specifically for anything that speaks to: progress/status updates, next
   steps, blockers/risks, relevant dates (meetings, deadlines, milestones), and
   people/stakeholders involved.
3. **If nothing relevant comes back, stop here for this item** — do not modify it. Note
   it as "no new information found" in your final summary to the user.
4. **If relevant information is found**, map it into the item's description sections
   using the same section-meaning table as the `kanban-item` skill:

   | Section | Update it with... |
   |---|---|
   | `Current status:` | The latest genuinely-sourced status/progress found via WorkIQ |
   | `Next action:` | Next steps/follow-ups mentioned in emails, chats, or meeting notes |
   | `Blockers:` | Risks, open issues, or things stuck/waiting, per the real source |
   | `Dates:` | Meeting/deadline/milestone dates actually found (calendar, emails, notes) |
   | `Contacts:` | People/teams actually named in the source material |
   | `Update History:` | Only if the user explicitly wants a dated log entry recorded |

   **`outcome` is a separate top-level field (not part of `description`) and is NEVER
   touched by this skill, full stop — no exceptions.** It is set once when an item is
   created and stays static for the life of the item; this skill only ever writes to
   the six description sections above and, when applicable, `tasks`. When you persist
   an update, always carry the item's *existing* top-level `outcome` value forward
   completely unchanged — never regenerate it, never blank it even temporarily, and
   never let a "rebuild the item" step drop it. If the user explicitly asks you to
   change the outcome itself, that is a distinct, deliberate edit outside this skill's
   scope (use `kanban-item` directly for that) — do not do it as a side effect of a
   WorkIQ refresh.

   Follow the `kanban-item` skill's exact rules for **how** to apply these changes:
   the description template structure, only filling sections you have real content for,
   and — critically — the "archive the old `Current status:` to `Update History:` before
   overwriting it" rule.
5. **Action items assigned to the user**: while reviewing WorkIQ results (emails, chat
   messages, meeting notes/transcripts), if you find an action item explicitly assigned
   to the user (by their name, "you", or their account), add it as a new checklist entry
   in that item's `tasks` array (`{ id: 'task-' + ..., text: '<the action item, in the
   user's/source's own words>', done: false }`) rather than folding it into the
   description text. Don't invent an action item that isn't clearly assigned to the user.
6. **Persist the change** using the `kanban-item` skill's Option B (local HTTP API) —
   re-fetch `/api/data` immediately before each `POST` to avoid a stale `_rev` conflict,
   especially when updating many items across a whole-board or all-boards request one
   after another. Add an `activityLog` entry (e.g. `Edited (description)` or `Edited
   (description, tasks)`) for each changed item, consistent with existing behavior.

## After processing

Summarize back to the user, per item: what was updated (which sections), which items had
no new information found (left untouched), and which requested item/board couldn't be
matched at all (if any) — so the user has a clear, honest picture of what actually
changed versus what didn't, rather than a blanket "done" message.

## See also

- **`kanban-item` skill** — the authoritative reference for the item data model, the
  description template/section-mapping rules, the "archive `Current status` to `Update
  History`" rule, and both the UI and API mechanics for applying an update. This skill
  only adds *where the update content comes from* (WorkIQ, searched automatically across
  all sources) and *when to skip an item* (no match, or no information found) — it
  defers to `kanban-item` for everything else.
- **`board-query` skill** — for read-only questions about the board that don't involve
  fetching new information from WorkIQ.
- **`move-item` skill** — for relocating an item between boards, unrelated to this skill.
