// Minimal zero-dependency Node server for the Kanban dashboard.
// Serves index.html/app.js/style.css from this folder and persists board
// data to ../data/kanban-data.json.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { buildXlsx } = require('./xlsxWriter');

const PORT = process.env.PORT || 9000;
const PROJECT_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'kanban-data.json');
const SKILLS_DIR = path.join(PROJECT_ROOT, 'skills');

function defaultData() {
  return {
    boards: [
      {
        id: 'board-general',
        name: 'General',
        columns: { 'To Do': [], 'In Progress': [], Completed: [] },
      },
    ],
    archived: [],
    archivedBoards: [],
    settings: { wipLimits: {} },
    _rev: 1,
  };
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const data = defaultData();
    saveData(data);
    return data;
  }
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (typeof data._rev !== 'number') data._rev = 1;
    // One-time migration: "Outcome" used to be a section inside the rich-text
    // description; it's now its own plain top-level field. Pull any existing
    // Outcome text out of old descriptions so nothing is lost, then persist.
    if (migrateLegacyOutcome(data)) saveData(data);
    return data;
  } catch (e) {
    return defaultData();
  }
}

// Atomic write: write to a temp file then rename over the real file, so a
// crash or power loss mid-write can never leave kanban-data.json truncated
// or corrupted (rename is atomic on the same volume). Also keeps a rolling
// set of dated backups so accidental data loss (e.g. a bad reset) can be
// recovered from.
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MAX_BACKUPS = 30;

function backupData() {
  if (!fs.existsSync(DATA_FILE)) return;
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10); // one backup per day is enough
  const backupFile = path.join(BACKUP_DIR, `kanban-data-${stamp}.json`);
  if (!fs.existsSync(backupFile)) {
    fs.copyFileSync(DATA_FILE, backupFile);
  }
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('kanban-data-') && f.endsWith('.json'))
    .sort();
  while (files.length > MAX_BACKUPS) {
    fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  }
}

function saveData(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  // Last-line-of-defence guard: no matter which code path produced this write
  // (browser UI save, in-app chat, WorkIQ refresh, or an external script/skill
  // POSTing to /api/data directly), never let it blank out an item's existing
  // "Outcome" text — that field is meant to be set once and stay static.
  try {
    if (fs.existsSync(DATA_FILE)) {
      const onDisk = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      guardOutcomePreservation(data, onDisk);
    }
  } catch (e) {
    // If the on-disk file can't be read/parsed, fall through and save as-is
    // rather than blocking the write entirely.
  }
  backupData();
  const tmpFile = DATA_FILE + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, DATA_FILE);
}

// === Copilot chat: use the CLI purely as a fast text-understanding step (no
// tool calls at all), then execute the resulting plan deterministically here
// in the server. This avoids the slow multi-turn agentic tool loop (curl
// calls, retries, self-verification) that previously took 1-2.5 minutes for
// a simple create/update request. ===

const SECTION_LABELS = ['Current status', 'Next action', 'Blockers', 'Dates', 'Contacts', 'Update History'];
const COLUMNS = ['To Do', 'In Progress', 'Completed'];

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// Strips HTML tags/entities down to readable plain text, used to feed item
// descriptions into the query-answering prompt without markup noise.
function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// Full item detail (unlike buildBoardsSummary, which is just id/heading/column
// for matching purposes) so the "query" action can answer questions using only
// real board data, never the model's own outside knowledge.
function buildFullBoardsDetail(boardData) {
  return boardData.boards.map((b) => ({
    board: b.name,
    items: Object.entries(b.columns).flatMap(([col, arr]) =>
      arr.map((i) => {
        const sections = parseDescriptionSections(i.description);
        const nonEmpty = {};
        Object.entries(sections).forEach(([k, v]) => {
          const text = stripHtml(v);
          if (text) nonEmpty[k] = text;
        });
        return {
          heading: i.heading,
          column: col,
          Outcome: i.outcome || null,
          priority: i.priority === 'orange' ? 'High' : i.priority === 'yellow' ? 'Medium' : 'Low',
          dueDate: i.dueDate || null,
          completionDate: i.completionDate || null,
          overdue: !!(i.dueDate && col !== 'Completed' && i.dueDate < todayStr()),
          tags: (i.tags || []).map((t) => t.text),
          ...nonEmpty,
        };
      })
    ),
  }));
}

// Builds one worksheet's row data (header + one row per item) for a single
// board, covering every field visible in the UI, so the exported file is a
// complete, readable snapshot rather than a partial dump.
function buildBoardSheetRows(board) {
  const header = [
    'Column',
    'Heading',
    'Outcome',
    'Priority',
    'Due Date',
    'Completion Date',
    'Overdue',
    'Tags',
    ...SECTION_LABELS,
  ];
  const rows = [header];
  COLUMNS.forEach((col) => {
    (board.columns[col] || []).forEach((item) => {
      const sections = parseDescriptionSections(item.description);
      const priorityLabel = item.priority === 'orange' ? 'High' : item.priority === 'yellow' ? 'Medium' : 'Low';
      const overdue = !!(item.dueDate && col !== 'Completed' && item.dueDate < todayStr());
      rows.push([
        col,
        item.heading || '',
        item.outcome || '',
        priorityLabel,
        item.dueDate || '',
        item.completionDate || '',
        overdue ? 'Yes' : 'No',
        (item.tags || []).map((t) => t.text).join(', '),
        ...SECTION_LABELS.map((label) => stripHtml(sections[label])),
      ]);
    });
  });
  return rows;
}

const EXPORT_COL_WIDTHS = [14, 32, 30, 10, 12, 14, 10, 20, 22, 26, 26, 18, 22, 30];


// sections provided (mirrors DESCRIPTION_TEMPLATE in src\app.js).
function buildDescriptionHtml(sections) {
  return SECTION_LABELS.map((label) => {
    const raw = sections && sections[label] ? String(sections[label]).trim() : '';
    const inner = raw ? escapeHtml(raw) : '<br>';
    return `<p class="desc-field" data-label="${label}:">${inner}</p><p><br></p>`;
  }).join('');
}

// Extracts each section's current inner HTML from an existing description.
function parseDescriptionSections(html) {
  const result = {};
  SECTION_LABELS.forEach((label) => {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`<p class="desc-field" data-label="${escapedLabel}:">([\\s\\S]*?)</p>`);
    const m = html && html.match(re);
    let val = m ? m[1] : '';
    if (val === '<br>') val = '';
    result[label] = val;
  });
  return result;
}

// Walks every item across active boards, archived items, and archived boards.
function collectAllItems(data) {
  const items = [];
  (data.boards || []).forEach((b) => {
    Object.keys(b.columns || {}).forEach((col) => (b.columns[col] || []).forEach((it) => items.push(it)));
  });
  (data.archived || []).forEach((it) => items.push(it));
  (data.archivedBoards || []).forEach((b) => {
    Object.keys(b.columns || {}).forEach((col) => (b.columns[col] || []).forEach((it) => items.push(it)));
  });
  return items;
}

// Cross-checks an about-to-be-saved data object against what's currently on
// disk and restores any item's "outcome" text that would otherwise be wiped
// out (set blank) by this write, regardless of which code path produced it.
// Outcome is meant to be set once when an item is created and stay static.
function guardOutcomePreservation(incoming, current) {
  const currentMap = new Map();
  collectAllItems(current).forEach((it) => {
    if (it && it.id) currentMap.set(it.id, it);
  });
  collectAllItems(incoming).forEach((it) => {
    if (!it || !it.id) return;
    const prev = currentMap.get(it.id);
    if (!prev) return;
    const prevOutcome = typeof prev.outcome === 'string' ? prev.outcome.trim() : '';
    if (!prevOutcome) return; // nothing to protect
    const incomingOutcome = typeof it.outcome === 'string' ? it.outcome.trim() : '';
    if (incomingOutcome) return; // already has content, leave as-is
    it.outcome = prev.outcome;
  });
}

// One-time migration: "Outcome" used to live as a <p class="desc-field"
// data-label="Outcome:"> section inside the rich-text description. It's now
// a separate plain-text top-level field. Pulls any existing Outcome text out
// of old descriptions into item.outcome and strips that section out of the
// description HTML. Returns true if anything was changed (caller should
// persist). Safe/idempotent to run on data that's already migrated.
function migrateLegacyOutcome(data) {
  const legacyRe = /<p class="desc-field" data-label="Outcome:">([\s\S]*?)<\/p>\s*<p><br><\/p>/;
  let changed = false;
  collectAllItems(data).forEach((it) => {
    if (!it) return;
    if (typeof it.outcome !== 'string') {
      it.outcome = '';
      changed = true;
    }
    if (it.description) {
      const m = it.description.match(legacyRe);
      if (m) {
        const raw = m[1] === '<br>' ? '' : stripHtml(m[1]);
        if (raw && !it.outcome) {
          it.outcome = raw;
          changed = true;
        }
        it.description = it.description.replace(legacyRe, '');
        changed = true;
      }
    }
  });
  return changed;
}

// Merges description_updates into an existing description, applying the
// "Current status" archival rule: the old status (if any) is preserved as a
// dated line in "Update History" before being overwritten, and any provided
// "Update History" text is appended as a new line rather than replacing it.
function applyDescriptionUpdates(existingHtml, updates) {
  const sections = parseDescriptionSections(existingHtml || buildDescriptionHtml({}));
  if (updates && typeof updates === 'object') {
    if (Object.prototype.hasOwnProperty.call(updates, 'Current status') && updates['Current status']) {
      const oldStatus = sections['Current status'];
      if (oldStatus && oldStatus.trim()) {
        const datedLine = escapeHtml(`${todayStr()}: `) + oldStatus;
        sections['Update History'] = sections['Update History'] ? sections['Update History'] + '<br>' + datedLine : datedLine;
      }
      sections['Current status'] = escapeHtml(String(updates['Current status']));
    }
    SECTION_LABELS.forEach((label) => {
      if (label === 'Current status') return; // handled above
      if (!updates[label]) return;
      if (label === 'Update History') {
        const newLine = escapeHtml(String(updates[label]));
        sections[label] = sections[label] ? sections[label] + '<br>' + newLine : newLine;
      } else {
        sections[label] = escapeHtml(String(updates[label]));
      }
    });
  }
  return SECTION_LABELS.map((label) => {
    const val = sections[label] && sections[label].trim() ? sections[label] : '<br>';
    return `<p class="desc-field" data-label="${label}:">${val}</p><p><br></p>`;
  }).join('');
}

// Case/format-tolerant board name matcher. In strict mode (used for card
// creation) this returns null instead of guessing/defaulting to General
// when no confident match is found, so the caller can ask the user instead.
function matchBoard(boardData, name, strict) {
  const general = boardData.boards.find((b) => b.id === 'board-general') || boardData.boards[0];
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = name ? norm(name) : '';
  if (!target) return strict ? null : general;
  const match =
    boardData.boards.find((b) => norm(b.name) === target) ||
    boardData.boards.find((b) => norm(b.name).includes(target) || target.includes(norm(b.name)));
  if (match) return match;
  return strict ? null : general;
}

// Holds an in-progress action that's waiting on the user to answer "which
// board?" (single-user local app, so a simple in-memory slot is enough).
// Shape: { type: 'create', fields } or { type: 'move', itemId, fromBoardId, column }
let pendingAction = null;

function createItem(boardData, board, fields) {
  const column = fields.column;
  const description = buildDescriptionHtml(fields.description_updates || {});
  const item = {
    id: 'item-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    heading: fields.heading,
    outcome: fields.outcome || '',
    description,
    priority: fields.priority,
    dueDate: fields.due_date,
    completionDate: column === 'Completed' ? todayStr() : null,
    tasks: [],
    tags: [],
    activityLog: [{ ts: new Date().toISOString(), text: `Created in "${column}"` }],
  };
  board.columns[column].push(item);
  persistBoardData(boardData);
  return `Added "${item.heading}" to the ${board.name} board's ${column} column.`;
}

function moveItemToOtherBoard(fromBoard, column, item, destBoard) {
  const idx = fromBoard.columns[column].findIndex((i) => i.id === item.id);
  if (idx !== -1) fromBoard.columns[column].splice(idx, 1);
  destBoard.columns[column].push(item);
  item.activityLog = item.activityLog || [];
  item.activityLog.push({
    ts: new Date().toISOString(),
    text: `Moved from board "${fromBoard.name}" to "${destBoard.name}"`,
  });
  return `Moved "${item.heading}" from ${fromBoard.name} to ${destBoard.name}.`;
}

function findItemById(boardData, itemId) {
  for (const board of boardData.boards) {
    for (const col of Object.keys(board.columns)) {
      const idx = board.columns[col].findIndex((i) => i.id === itemId);
      if (idx !== -1) return { board, column: col, item: board.columns[col][idx] };
    }
  }
  return null;
}

// Case/format-tolerant heading matcher, optionally scoped to one board (used
// once the source board is known, so the search is narrower/more accurate).
function matchItemByHeading(boardData, text, boardId) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(text);
  if (!target) return null;
  const boards = boardId ? boardData.boards.filter((b) => b.id === boardId) : boardData.boards;
  const exact = [];
  const partial = [];
  for (const board of boards) {
    for (const col of Object.keys(board.columns)) {
      for (const item of board.columns[col]) {
        const h = norm(item.heading);
        if (h === target) exact.push({ board, column: col, item });
        else if (h.includes(target) || target.includes(h)) partial.push({ board, column: col, item });
      }
    }
  }
  return exact[0] || partial[0] || null;
}

function validPriority(p) {
  return ['green', 'yellow', 'orange'].includes(p) ? p : null;
}

function validColumn(c) {
  return COLUMNS.includes(c) ? c : null;
}

function persistBoardData(boardData) {
  boardData._rev = (typeof boardData._rev === 'number' ? boardData._rev : 1) + 1;
  saveData(boardData);
}

// Condensed board/item listing given to the model so it can match board
// names and identify which existing item an "update" request refers to,
// without needing any tool calls to go fetch this itself.
function buildBoardsSummary(boardData) {
  return boardData.boards.map((b) => ({
    name: b.name,
    items: Object.entries(b.columns).flatMap(([col, arr]) =>
      arr.map((i) => ({ id: i.id, heading: i.heading, column: col }))
    ),
  }));
}

function buildPlanPrompt(userMessage, boardsSummary, fullBoardsDetail) {
  return `You are the planning brain for a Kanban board chat assistant. Do not call any tools or run any commands — just think, then reply with a single JSON object and nothing else (no markdown fences, no prose before or after it).

Current boards and items (ids, for matching a create/update/move request to an existing item):
${JSON.stringify(boardsSummary)}

Full item detail (for answering general questions about the board(s) — action "query"):
${JSON.stringify(fullBoardsDetail)}

Return exactly one JSON object matching this shape:
{
  "action": "create" | "update" | "move_board" | "query" | "out_of_scope",
  "reply": "short, friendly 1-2 sentence message to show the user in a chat panel",
  "board_name": string or null,
  "target_item_id": string or null,
  "item_hint": string or null,
  "source_board": string or null,
  "destination_board": string or null,
  "column": "To Do" | "In Progress" | "Completed" or null,
  "move_to_column": "To Do" | "In Progress" | "Completed" or null,
  "heading": string or null,
  "outcome": string or null,
  "priority": "green" | "yellow" | "orange" or null,
  "due_date": "YYYY-MM-DD" or null,
  "description_updates": { },
  "workiq_refresh": boolean
}

Rules:
1. Set "action" to "out_of_scope" for absolutely anything that isn't clearly about creating, updating, moving, or asking a general question about a card/item/task/board on this Kanban dashboard — this includes general coding help (e.g. "write a function..."), general knowledge, trivia, or any unrelated request, even if you technically know the answer. In that case set "reply" to exactly: I'm not able to help with that here. and set every other field to null (description_updates: {}, workiq_refresh: false).
2. The words "card", "item", "task", and "ticket" all mean the same thing as the user's request.
3. Set "board_name" only to a board the user explicitly mentioned, matched case-insensitively and tolerant of minor spelling differences against the board names listed above. If the user didn't mention a board, or what they said doesn't clearly match one of the listed boards, set "board_name" to null — do NOT guess or default to any particular board (do not default to "General").
4. If the user's request is clearly about changing/refreshing/adding-to something that already exists on the board (they name or describe an existing card, however loosely — including by heading, topic, or customer/ticket name), ALWAYS set "action" to "update" — never "create" — even if you're not fully sure of the exact id. Set "target_item_id" to one of the ids listed above only if you can confidently match it; otherwise leave it null AND set "item_hint" to the exact words the user used for the item, so the app can try a looser match by heading. Only use "action":"create" when the user is unmistakably asking to add something brand new (e.g. "create a new card...", "add an item for...") — never as a fallback for an update you're unsure how to match.
5. "description_updates" keys may only be: Current status, Next action, Blockers, Dates, Contacts, Update History — include ONLY the ones the user actually gave information for; omit the rest. Never invent content. "outcome" is a separate top-level field, not part of "description_updates" — see rule 6.
6. "outcome" is a top-level field, only ever meaningful for "action":"create" — set it when the user describes the goal/deliverable/what "done" looks like for a brand-new card, as a complete sentence combining the action, who/what's involved, and any relevant date the user mentioned (don't truncate their meaning down to a short fragment). For "action":"update" (or any other action), ALWAYS leave "outcome" null — it's set once at creation and stays static; the app ignores it anyway for updates, so just omit it.
7. Only set "due_date" when the user explicitly wants a deadline for finishing the item itself. If a date they mention is really about something the item describes (a meeting, event, milestone) rather than a deadline for the card, leave "due_date" null and put that date in description_updates.Dates instead.
8. "priority": "green" = Low, "yellow" = Medium, "orange" = High.
9. "reply" must be short and friendly, and must never mention files, skills, JSON, or internal tooling — just a natural confirmation or answer.
10. If the user asks to move an existing item from one board to a different board (e.g. "move item A from board XY to AB", "move the renewal card to Westpac"), set "action" to "move_board". This requires THREE pieces of information: (a) which item, (b) the source board it's currently on, and (c) the destination board to move it to. Extract each independently from the user's own words — never guess or infer one from the others:
   - "target_item_id": set only if you can confidently match the item the user named against the list above; otherwise null. Also set "item_hint" to the exact name/words the user used for the item (even if target_item_id is null), so the app can try a looser match.
   - "source_board": set only if the user explicitly said which board the item is currently on; otherwise null. Do NOT default this to whatever board the item happens to already be on in the data — it must come from the user's own message.
   - "destination_board": set only if the user explicitly said where to move it to; otherwise null.
   If any of the three is missing or unclear from the user's message, still use "action":"move_board" and simply leave that field null — the app will ask the user for exactly the missing piece(s) rather than guessing.
11. If the user is asking a general question about the board(s) rather than asking to create/update/move something (e.g. "summarize the board", "list priority items", "show me items for tag X", "show me items overdue", "what are the blockers for <customer>", "what should I focus on this week", "show me high impact items", or any other question about what's on the board), set "action" to "query" and:
   - Answer using ONLY the data in "Full item detail" above — never use your own outside knowledge, never invent or guess facts not present in that data.
   - If the user explicitly named one of the boards listed above, restrict your answer to that board's items only; otherwise consider items across all boards.
   - Put the actual answer in "reply", formatted with light markdown for readability: use "- " bullet points for lists of items/findings, "**bold**" for item headings/board names/labels, and blank lines between paragraphs. Reference item headings and their board when useful, especially when answering across multiple boards.
   - If you cannot find enough information in the item data to answer confidently, do NOT guess — set "reply" to a short, friendly message saying you couldn't find that information on the board, and suggest rephrasing or checking the board directly.
   - Set every other field to null (description_updates: {}, workiq_refresh: false).
12. If the user asks to "refresh", "sync", or otherwise update a card/board/all boards WITHOUT giving you the actual new content directly in their message (e.g. "refresh the GitHub Adoption item on Westpac", "update GitHub Adoption on Westpac board", "update all items on Ampol board", "sync this card"), this means they want an automatic refresh pulled from their email/calendar/chats/meeting notes/transcripts. Set "action" to "update", set "workiq_refresh" to true, leave "description_updates" empty ({}), and:
   - Set "target_item_id" if you can confidently match one specific item; otherwise leave it null and set "item_hint" to the words the user used (this is expected/fine when the user named a whole board or all boards — see rule 4).
   - Set "board_name" if the user named one of the listed boards; leave null for an "all boards" request.
   - Set "reply" to a short, friendly acknowledgment that you're checking their email/calendar/chats/meetings for updates (e.g. "Sure, let me check your email, calendar, and meetings for the latest on this."), since the app will actually perform the WorkIQ search after this plan — do not claim you can't do this or ask the user to type the update themselves.
   - This rule does NOT apply when the user directly states the new content themselves (e.g. "update the status to X", "set blockers to Y") — that is a normal update, "workiq_refresh" stays false, and "description_updates" should be populated as usual.

User request: ${userMessage}`;
}

function executePlan(plan, boardData) {
  const action = plan && plan.action;
  if (action === 'query') {
    return (plan && plan.reply) || "I couldn't find that information on the board.";
  }
  if (action !== 'create' && action !== 'update' && action !== 'move_board') {
    return (plan && plan.reply) || "I'm not able to help with that here.";
  }

  if (action === 'create') {
    const fields = {
      column: validColumn(plan.column) || 'To Do',
      priority: validPriority(plan.priority) || 'green',
      due_date: plan.due_date && /^\d{4}-\d{2}-\d{2}$/.test(plan.due_date) ? plan.due_date : null,
      heading: (plan.heading && String(plan.heading).trim()) || 'New item',
      outcome: (plan.outcome && String(plan.outcome).trim()) || '',
      description_updates: plan.description_updates || {},
    };
    const board = matchBoard(boardData, plan.board_name, true);
    if (!board) {
      pendingAction = { type: 'create', fields };
      const names = boardData.boards.map((b) => b.name).join(', ');
      return `Which board should I add this to? Available boards: ${names}.`;
    }
    const defaultReply = createItem(boardData, board, fields);
    return plan.reply || defaultReply;
  }

  if (action === 'move_board') {
    const namesList = () => boardData.boards.map((b) => b.name).join(', ');

    // 1. Which item?
    let found = plan.target_item_id ? findItemById(boardData, plan.target_item_id) : null;
    if (!found && plan.item_hint) {
      const sourceBoardGuess = plan.source_board ? matchBoard(boardData, plan.source_board, true) : null;
      found = matchItemByHeading(boardData, plan.item_hint, sourceBoardGuess ? sourceBoardGuess.id : null);
    }
    if (!found) {
      pendingAction = { type: 'move_slots', itemId: null, sourceBoardId: null, destBoardId: null };
      return "Which item/card would you like to move?";
    }
    const { item } = found;

    // 2. Source board — must come from the user's own words, not assumed.
    const sourceBoard = plan.source_board ? matchBoard(boardData, plan.source_board, true) : null;
    if (!sourceBoard) {
      pendingAction = { type: 'move_slots', itemId: item.id, sourceBoardId: null, destBoardId: null };
      return `Which board is "${item.heading}" currently on? Available boards: ${namesList()}.`;
    }
    if (sourceBoard.id !== found.board.id) {
      return `I found "${item.heading}" on the ${found.board.name} board, not ${sourceBoard.name}. Could you confirm which one you meant?`;
    }

    // 3. Destination board
    const destBoard = plan.destination_board ? matchBoard(boardData, plan.destination_board, true) : null;
    if (!destBoard) {
      pendingAction = { type: 'move_slots', itemId: item.id, sourceBoardId: sourceBoard.id, destBoardId: null };
      return `Which board should I move "${item.heading}" to? Available boards: ${namesList()}.`;
    }
    if (destBoard.id === sourceBoard.id) {
      return plan.reply || `"${item.heading}" is already on the ${sourceBoard.name} board.`;
    }
    const defaultReply = moveItemToOtherBoard(sourceBoard, found.column, item, destBoard);
    persistBoardData(boardData);
    return plan.reply || defaultReply;
  }

  // action === 'update'
  let found = plan.target_item_id ? findItemById(boardData, plan.target_item_id) : null;
  if (!found && plan.item_hint) {
    const boardGuess = plan.board_name ? matchBoard(boardData, plan.board_name, true) : null;
    found = matchItemByHeading(boardData, plan.item_hint, boardGuess ? boardGuess.id : null);
  }
  if (!found) {
    // Never silently fall back to creating a new item here — that would duplicate
    // data instead of updating it. Ask for clarification instead.
    return plan.reply || "I couldn't find that item to update — could you confirm the exact card heading and board?";
  }
  const { board, column, item } = found;
  const changes = [];

  if (plan.heading && String(plan.heading).trim() && String(plan.heading).trim() !== item.heading) {
    item.heading = String(plan.heading).trim();
    changes.push('heading');
  }
  const priority = validPriority(plan.priority);
  if (priority && priority !== item.priority) {
    item.priority = priority;
    changes.push('priority');
  }
  if (plan.due_date && /^\d{4}-\d{2}-\d{2}$/.test(plan.due_date)) {
    item.dueDate = plan.due_date;
    changes.push('due date');
  }
  // "outcome" is intentionally never read here — it's set once at creation
  // and must stay static; automated updates (chat-driven or WorkIQ-driven)
  // can never change it, so any "outcome" the plan might contain is ignored.
  if (plan.description_updates && Object.keys(plan.description_updates).length) {
    item.description = applyDescriptionUpdates(item.description, plan.description_updates);
    changes.push('description');
  }

  const moveTo = validColumn(plan.move_to_column);
  let currentColumn = column;
  if (moveTo && moveTo !== column) {
    const idx = board.columns[column].findIndex((i) => i.id === item.id);
    board.columns[column].splice(idx, 1);
    item.completionDate = moveTo === 'Completed' ? todayStr() : null;
    board.columns[moveTo].push(item);
    changes.push(`moved to "${moveTo}"`);
    currentColumn = moveTo;
  }

  item.activityLog = item.activityLog || [];
  if (changes.length) {
    item.activityLog.push({
      ts: new Date().toISOString(),
      text: `Edited (${changes.join(', ')})`,
    });
    persistBoardData(boardData);
  }
  return plan.reply || `Updated "${item.heading}" on the ${board.name} board.`;
}

// === WorkIQ-powered refresh (single item / whole board / all boards) ===
// This is a SECOND, separate CLI call from the read-only planning call above.
// It is the only place the in-app chat is allowed to reach an actual data
// source (the "workiq" MCP plugin) — it still can't run shell commands, write
// files, or hit arbitrary URLs; it can only search WorkIQ and return findings
// as JSON text, which THIS server (not the CLI) then applies and persists via
// the same safe description-merge logic used everywhere else.
const WORKIQ_REFRESH_TIMEOUT = 90000; // WorkIQ searches can take longer than a plain plan call
const WORKIQ_REFRESH_MAX_ITEMS = 25; // cap for a single whole-board/all-boards chat request

function buildWorkiqRefreshPrompt(item, board, column) {
  const sections = parseDescriptionSections(item.description);
  const nonEmpty = {};
  SECTION_LABELS.forEach((label) => {
    const text = stripHtml(sections[label]);
    if (text) nonEmpty[label] = text;
  });
  const priorityLabel = item.priority === 'orange' ? 'High' : item.priority === 'yellow' ? 'Medium' : 'Low';
  const tags = (item.tags || []).map((t) => t.text);
  return `You are refreshing one Kanban card with real, current information found via the WorkIQ tool (the user's email, calendar, Teams chats/channels, meeting notes/minutes, and meeting transcripts). Do not use your own outside knowledge — only use what WorkIQ genuinely returns. Do not call any tool other than WorkIQ.

Card to refresh:
- Board (account/customer): ${board.name}
- Column: ${column}
- Heading: ${item.heading}
- Priority: ${priorityLabel}
- Tags: ${tags.length ? tags.join(', ') : '(none)'}
- Existing description sections: ${JSON.stringify(nonEmpty)}

Steps:
1. Use the WorkIQ tool to search email, calendar, Teams chats/channels, meeting notes/minutes, and meeting transcripts for anything relevant to this card — search using the board/account name (${board.name}) together with the card's heading, its existing Outcome/Contacts text, and any tags, as keywords.
2. Look specifically for: progress/status updates, next steps, blockers/risks, relevant dates (meetings, deadlines, milestones), and people/stakeholders involved.
3. Also look for any action item explicitly assigned to the current user (by name, "you", or their account) that relates to this card.

Reply with EXACTLY one JSON object and nothing else (no markdown fences, no prose before or after it):
{
  "found": true | false,
  "current_status": string or null,
  "next_action": string or null,
  "blockers": string or null,
  "dates": string or null,
  "contacts": string or null,
  "action_items": string[],
  "summary": "one short sentence describing what was found or that nothing new was found"
}

Rules:
- Set "found" to false and leave all content fields null/empty if WorkIQ returns nothing genuinely relevant — never invent or guess content.
- Only include a field if WorkIQ actually returned real information for it; leave others null.
- "action_items" must only contain action items truly assigned to the user themselves, in their own words from the source — leave it an empty array if none.
- Never mention files, JSON, or internal tooling in "summary" — just a short, natural description.`;
}

function refreshItemFromWorkiq(item, board, column, callback) {
  const prompt = buildWorkiqRefreshPrompt(item, board, column);
  const args = [
    '-p',
    prompt,
    '-C',
    PROJECT_ROOT,
    '--effort',
    'low',
    '--deny-tool',
    'shell',
    '--deny-tool',
    'write',
    '--deny-tool',
    'url',
    '--disable-builtin-mcps',
    '--allow-tool',
    'workiq',
    '--no-ask-user',
    '--no-remote',
    '--no-remote-export',
    '--silent',
    '--no-color',
    '--output-format',
    'text',
  ];
  execFile(
    'copilot',
    args,
    { cwd: PROJECT_ROOT, timeout: WORKIQ_REFRESH_TIMEOUT, maxBuffer: 5 * 1024 * 1024 },
    (err, stdout) => {
      if (err) {
        callback({ found: false, summary: 'The WorkIQ search could not be completed (it may have timed out).' });
        return;
      }
      try {
        const jsonMatch = stdout.match(/\{[\s\S]*\}/);
        const result = JSON.parse(jsonMatch ? jsonMatch[0] : stdout);
        callback(result);
      } catch (e) {
        callback({ found: false, summary: 'Could not read the WorkIQ results for this item.' });
      }
    }
  );
}

// Merges WorkIQ findings into an item's description/tasks, following the same
// "archive old Current status" rule as a normal update. Returns true if the
// item actually changed.
function applyWorkiqFindings(item, findings) {
  if (!findings || !findings.found) return false;
  const updates = {};
  if (findings.current_status) updates['Current status'] = findings.current_status;
  if (findings.next_action) updates['Next action'] = findings.next_action;
  if (findings.blockers) updates['Blockers'] = findings.blockers;
  if (findings.dates) updates['Dates'] = findings.dates;
  if (findings.contacts) updates['Contacts'] = findings.contacts;

  const hasDescriptionChanges = Object.keys(updates).length > 0;
  const actionItems = Array.isArray(findings.action_items) ? findings.action_items.filter(Boolean) : [];
  if (!hasDescriptionChanges && !actionItems.length) return false;

  const changes = [];
  if (hasDescriptionChanges) {
    item.description = applyDescriptionUpdates(item.description, updates);
    changes.push('description');
  }
  if (actionItems.length) {
    item.tasks = item.tasks || [];
    actionItems.forEach((text, idx) => {
      item.tasks.push({ id: `task-${Date.now()}-${idx}`, text: String(text), done: false });
    });
    changes.push('tasks');
  }
  item.activityLog = item.activityLog || [];
  item.activityLog.push({ ts: new Date().toISOString(), text: `Refreshed from WorkIQ (${changes.join(', ')})` });
  return true;
}

// Orchestrates a WorkIQ refresh for whatever scope the plan resolved to: one
// item, a whole board, or (when neither is set) every item across all boards.
// Items are processed one at a time (each is its own CLI call), then the
// board data is persisted once at the end.
function runWorkiqRefreshFlow(plan, boardData, callback) {
  let targets = [];
  const singleItem = plan.target_item_id ? findItemById(boardData, plan.target_item_id) : null;

  if (singleItem) {
    targets = [{ board: singleItem.board, column: singleItem.column, item: singleItem.item }];
  } else if (plan.board_name) {
    const board = matchBoard(boardData, plan.board_name, true);
    if (!board) {
      callback(null, `I couldn't find a board called "${plan.board_name}".`);
      return;
    }
    COLUMNS.forEach((col) => {
      (board.columns[col] || []).forEach((item) => targets.push({ board, column: col, item }));
    });
    if (!targets.length) {
      callback(null, `The ${board.name} board doesn't have any items to refresh.`);
      return;
    }
  } else if (!plan.target_item_id) {
    boardData.boards.forEach((board) => {
      COLUMNS.forEach((col) => {
        (board.columns[col] || []).forEach((item) => targets.push({ board, column: col, item }));
      });
    });
  }

  if (!targets.length) {
    callback(null, "I couldn't find that item to refresh.");
    return;
  }

  const capped = targets.slice(0, WORKIQ_REFRESH_MAX_ITEMS);
  const results = [];
  let i = 0;

  function next() {
    if (i >= capped.length) {
      const updated = results.filter((r) => r.changed);
      if (updated.length) persistBoardData(boardData);

      let reply;
      if (capped.length === 1) {
        reply = updated.length
          ? `Updated "${capped[0].item.heading}" with the latest information found via WorkIQ.`
          : `I checked your email, calendar, chats, and meetings but didn't find any new information for "${capped[0].item.heading}".`;
      } else {
        reply = `Checked ${capped.length} item(s) via WorkIQ: updated ${updated.length}, no new information for ${
          capped.length - updated.length
        }.`;
        if (targets.length > capped.length) {
          reply += ` Only the first ${WORKIQ_REFRESH_MAX_ITEMS} items were processed in this chat — ask the top-level Copilot CLI for the rest.`;
        }
      }
      callback(null, reply);
      return;
    }
    const t = capped[i];
    refreshItemFromWorkiq(t.item, t.board, t.column, (findings) => {
      const changed = applyWorkiqFindings(t.item, findings);
      results.push({ item: t.item, changed });
      i += 1;
      next();
    });
  }
  next();
}

// Calls the GitHub Copilot CLI once for planning only (no tools allowed, so
// it can't call curl/shell/write anything itself — this is a plain text
// completion, which is what makes it fast), then executes the plan here.
function runCopilotChat(userMessage, callback) {
  let boardData;
  try {
    boardData = loadData();
  } catch (e) {
    callback(new Error('Could not read board data.'));
    return;
  }
  // If we previously asked a clarifying question (which board / which item),
  // try to resolve this reply directly — no need to call the CLI again.
  if (pendingAction) {
    const trimmed = userMessage.trim();
    if (/^(cancel|never ?mind|forget it|no thanks?)$/i.test(trimmed)) {
      pendingAction = null;
      callback(null, "No problem, I've cancelled that.");
      return;
    }

    if (pendingAction.type === 'create') {
      const board = matchBoard(boardData, trimmed, true);
      if (board) {
        const fields = pendingAction.fields;
        pendingAction = null;
        try {
          callback(null, createItem(boardData, board, fields));
        } catch (e) {
          callback(new Error(e.message));
        }
        return;
      }
      // Didn't recognize a board name — drop it and treat this as a fresh request.
      pendingAction = null;
    } else if (pendingAction.type === 'move_slots') {
      const p = pendingAction;
      const namesList = () => boardData.boards.map((b) => b.name).join(', ');

      if (!p.itemId) {
        const match = matchItemByHeading(boardData, trimmed, p.sourceBoardId);
        if (!match) {
          callback(null, `I couldn't find an item called "${trimmed}". Could you give me the exact card name?`);
          return;
        }
        p.itemId = match.item.id;
      } else if (!p.sourceBoardId) {
        const b = matchBoard(boardData, trimmed, true);
        if (!b) {
          callback(null, `I couldn't match that to a board. Which board is it currently on? Available boards: ${namesList()}.`);
          return;
        }
        p.sourceBoardId = b.id;
      } else if (!p.destBoardId) {
        const b = matchBoard(boardData, trimmed, true);
        if (!b) {
          callback(null, `I couldn't match that to a board. Which board should I move it to? Available boards: ${namesList()}.`);
          return;
        }
        p.destBoardId = b.id;
      }

      if (!p.sourceBoardId) {
        callback(null, `Which board is this item currently on? Available boards: ${namesList()}.`);
        return;
      }
      if (!p.destBoardId) {
        callback(null, `Which board should I move it to? Available boards: ${namesList()}.`);
        return;
      }

      // All three slots known — validate and execute.
      pendingAction = null;
      const found = findItemById(boardData, p.itemId);
      if (!found) {
        callback(null, "I couldn't find that item anymore — please try again.");
        return;
      }
      const fromBoard = boardData.boards.find((b) => b.id === p.sourceBoardId);
      const destBoard = boardData.boards.find((b) => b.id === p.destBoardId);
      if (!fromBoard || !destBoard) {
        callback(null, "Something went wrong identifying those boards — please try again.");
        return;
      }
      if (found.board.id !== fromBoard.id) {
        callback(
          null,
          `That item is actually on the ${found.board.name} board, not ${fromBoard.name} — please try again.`
        );
        return;
      }
      if (destBoard.id === fromBoard.id) {
        callback(null, `"${found.item.heading}" is already on the ${destBoard.name} board.`);
        return;
      }
      try {
        const reply = moveItemToOtherBoard(fromBoard, found.column, found.item, destBoard);
        persistBoardData(boardData);
        callback(null, reply);
      } catch (e) {
        callback(new Error(e.message));
      }
      return;
    }
  }

  const boardsSummary = buildBoardsSummary(boardData);
  const fullBoardsDetail = buildFullBoardsDetail(boardData);
  const prompt = buildPlanPrompt(userMessage, boardsSummary, fullBoardsDetail);
  const args = [
    '-p',
    prompt,
    '-C',
    PROJECT_ROOT,
    '--effort',
    'low',
    '--deny-tool',
    'shell',
    '--deny-tool',
    'write',
    '--deny-tool',
    'url',
    '--disable-builtin-mcps',
    '--no-remote',
    '--no-remote-export',
    '--silent',
    '--no-color',
    '--output-format',
    'text',
  ];
  execFile(
    'copilot',
    args,
    { cwd: PROJECT_ROOT, timeout: 60000, maxBuffer: 5 * 1024 * 1024 },
    (err, stdout, stderr) => {
      if (err) {
        if (err.killed || err.signal) {
          callback(new Error('The request took too long and was stopped. Please try again.'));
          return;
        }
        callback(new Error(stderr && stderr.trim() ? stderr.trim() : err.message));
        return;
      }
      let plan;
      try {
        const jsonMatch = stdout.match(/\{[\s\S]*\}/);
        plan = JSON.parse(jsonMatch ? jsonMatch[0] : stdout);
      } catch (e) {
        callback(null, "I'm not able to help with that here.");
        return;
      }
      try {
        if (plan && plan.action === 'update' && plan.workiq_refresh) {
          runWorkiqRefreshFlow(plan, boardData, (err2, reply) => {
            if (err2) {
              callback(new Error(err2.message || 'WorkIQ refresh failed.'));
              return;
            }
            callback(null, reply);
          });
          return;
        }
        const reply = executePlan(plan, boardData);
        callback(null, reply);
      } catch (e) {
        callback(new Error(e.message));
      }
    }
  );
}

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

// Reads each skills\*\SKILL.md front matter (name/description/example) so the
// chat UI can show suggestion chips that reflect only what's actually supported,
// instead of a hardcoded list that may not match real capabilities.
function listSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const skills = [];
  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(SKILLS_DIR, entry.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    try {
      const text = fs.readFileSync(file, 'utf8');
      const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!match) continue;
      const frontMatter = {};
      match[1].split(/\r?\n/).forEach((line) => {
        const kv = line.match(/^(\w+):\s*(.*)$/);
        if (kv) frontMatter[kv[1]] = kv[2].trim();
      });
      skills.push({
        name: frontMatter.name || entry.name,
        description: frontMatter.description || '',
        capability: frontMatter.capability || '',
        example: frontMatter.example || '',
      });
    } catch (e) {
      // Skip unreadable/malformed skill files rather than failing the whole list.
    }
  }
  return skills;
}

const server = http.createServer((req, res) => {
  if (req.url === '/api/skills' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, skills: listSkills() }));
    return;
  }

  if (req.url && req.url.startsWith('/api/export') && req.method === 'GET') {
    try {
      const boardData = loadData();
      const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
      const boardParam = reqUrl.searchParams.get('board') || 'all';

      let boardsToExport;
      if (boardParam === 'all') {
        boardsToExport = boardData.boards;
      } else {
        const ids = boardParam.split(',').map((s) => s.trim()).filter(Boolean);
        const idSet = new Set(ids);
        // Preserve the boards' natural order rather than the order ids were passed in.
        boardsToExport = boardData.boards.filter((b) => idSet.has(b.id));
      }

      if (!boardsToExport.length) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Board not found.' }));
        return;
      }

      const sheets = boardsToExport.map((board) => ({
        name: board.name,
        rows: buildBoardSheetRows(board),
        colWidths: EXPORT_COL_WIDTHS,
      }));
      const buffer = buildXlsx(sheets);

      const filename =
        boardParam === 'all' || boardsToExport.length === boardData.boards.length
          ? `kanban-export-all-boards-${todayStr()}.xlsx`
          : boardsToExport.length === 1
          ? `kanban-export-${boardsToExport[0].name.replace(/[^a-z0-9]+/gi, '-')}-${todayStr()}.xlsx`
          : `kanban-export-selected-boards-${todayStr()}.xlsx`;

      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': buffer.length,
      });
      res.end(buffer);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (req.url === '/api/data' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadData()));
    return;
  }

  if (req.url === '/api/data' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const incoming = JSON.parse(body);
        const current = loadData();
        const currentRev = current._rev || 1;
        const clientRev = typeof incoming._rev === 'number' ? incoming._rev : null;

        // Conflict protection: if another tab/window saved since this client
        // last loaded/saved, refuse to overwrite it and hand back the latest
        // server copy so the client can prompt the user to reload.
        if (clientRev !== null && clientRev !== currentRev) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: false,
              conflict: true,
              error: 'Data was changed in another window/tab. Reload to get the latest version.',
              latest: current,
            })
          );
          return;
        }

        incoming._rev = currentRev + 1;
        saveData(incoming);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, rev: incoming._rev }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (req.url === '/api/copilot-chat' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let message;
      try {
        message = JSON.parse(body).message;
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid request body.' }));
        return;
      }
      if (!message || !String(message).trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Message is required.' }));
        return;
      }
      runCopilotChat(String(message), (err, reply) => {
        if (err) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, reply }));
      });
    });
    return;
  }

  // Static file serving (index.html, app.js, style.css live alongside this file)
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, decodeURIComponent(filePath.split('?')[0]));

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`Kanban dashboard running at http://localhost:${PORT}`);
  console.log(`Data persisted to ${DATA_FILE}`);
});
