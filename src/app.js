// Kanban dashboard client logic
const COLUMNS = ['To Do', 'In Progress', 'Completed'];
const MAX_TAGS_SHOWN_ON_CARD = 5;
const DESCRIPTION_PREVIEW_LIMIT = 160;

const PRIORITIES = [
  { key: 'green', label: 'Low', hex: '#22c55e' },
  { key: 'yellow', label: 'Medium', hex: '#eab308' },
  { key: 'orange', label: 'High', hex: '#f97316' },
];

let boardData = null;
let activeBoardId = null;
let saveTimer = null;
let dataRev = null; // last-known server revision, used to detect multi-tab save conflicts
let saveBlockedByConflict = false;
let openPriorityFilterBoardId = null; // which board's priority filter dropdown is currently open
let openMoveMenuItemId = null; // which card's "move to board" dropdown is currently open
let draggingCardInfo = null; // { itemId, boardId, column } while a card is being dragged, so dropping it on a tab moves it to that board
let selectMode = false;
let selectedIds = new Set(); // ids selected in bulk-select mode (scoped to active board)
let lastUndo = null; // { message, undo: fn }
let undoHideTimer = null;

// Per-board filter state: { [boardId]: { search: '', tags: [], priorities: Set } }
const boardFilters = {};

// Archive modal bulk-select state
let archiveSelectedIds = new Set();

// Modal state
let modalContext = { boardId: null, column: null, id: null }; // id === null => new item
let selectedPriority = 'green';
let modalTasks = []; // working copy of the task checklist while the modal is open
let modalTags = []; // working copy of the tags while the modal is open
let savedDescriptionRange = null; // last text selection inside the description editor, for the color pickers

const DESCRIPTION_TEMPLATE =
  '<p class="desc-field" data-label="Current status:"><br></p><p><br></p>' +
  '<p class="desc-field" data-label="Next action:"><br></p><p><br></p>' +
  '<p class="desc-field" data-label="Blockers:"><br></p><p><br></p>' +
  '<p class="desc-field" data-label="Dates:"><br></p><p><br></p>' +
  '<p class="desc-field" data-label="Contacts:"><br></p><p><br></p>' +
  '<p class="desc-field" data-label="Update History:"><br></p><p><br></p>';

const TAG_COLORS = [
  { key: 'blue', hex: '#60a5fa' },
  { key: 'green', hex: '#4ade80' },
  { key: 'yellow', hex: '#facc15' },
  { key: 'red', hex: '#f87171' },
];

let selectedTagColor = TAG_COLORS[0].key;

const tabsEl = document.getElementById('tabs');
const boardsEl = document.getElementById('boards');
const saveStatusEl = document.getElementById('saveStatus');
const modalOverlay = document.getElementById('modalOverlay');
const modalTitle = document.getElementById('modalTitle');
const itemHeadingEl = document.getElementById('itemHeading');
const itemOutcomeEl = document.getElementById('itemOutcome');
const itemDescriptionEl = document.getElementById('itemDescription');
const itemDueDateEl = document.getElementById('itemDueDate');
const itemCompletionDateEl = document.getElementById('itemCompletionDate');
const priorityPickerEl = document.getElementById('priorityPicker');
const deleteItemBtn = document.getElementById('deleteItemBtn');
const cancelBtn = document.getElementById('cancelBtn');
const saveItemBtn = document.getElementById('saveItemBtn');
const addTaskBtn = document.getElementById('addTaskBtn');
const taskListContainerEl = document.getElementById('taskListContainer');
const descToolbarEl = document.getElementById('descToolbar');
const fontColorPickerEl = document.getElementById('fontColorPicker');
const bgColorPickerEl = document.getElementById('bgColorPicker');
const newTagTextEl = document.getElementById('newTagText');
const tagColorPickerEl = document.getElementById('tagColorPicker');
const addTagBtn = document.getElementById('addTagBtn');
const tagChipListEl = document.getElementById('tagChipList');
const activityLogContainerEl = document.getElementById('activityLogContainer');
const selectModeBtn = document.getElementById('selectModeBtn');
const bulkToolbarEl = document.getElementById('bulkToolbar');
const bulkSelectedCountEl = document.getElementById('bulkSelectedCount');
const bulkMoveSelectEl = document.getElementById('bulkMoveSelect');
const bulkArchiveBtn = document.getElementById('bulkArchiveBtn');
const bulkDeleteBtn = document.getElementById('bulkDeleteBtn');
const undoToastEl = document.getElementById('undoToast');
const undoMessageEl = document.getElementById('undoMessage');
const undoBtn = document.getElementById('undoBtn');
const archiveBtn = document.getElementById('archiveBtn');
const exportBtn = document.getElementById('exportBtn');
const exportMenu = document.getElementById('exportMenu');
const exportSelectAllEl = document.getElementById('exportSelectAll');
const exportBoardListEl = document.getElementById('exportBoardList');
const exportConfirmBtn = document.getElementById('exportConfirmBtn');
const importBtn = document.getElementById('importBtn');
const importFileInput = document.getElementById('importFileInput');
const archiveCountEl = document.getElementById('archiveCount');
const archiveOverlay = document.getElementById('archiveOverlay');
const archiveListEl = document.getElementById('archiveList');
const closeArchiveBtn = document.getElementById('closeArchiveBtn');
const archiveSelectAllEl = document.getElementById('archiveSelectAll');
const archiveDeleteSelectedBtn = document.getElementById('archiveDeleteSelectedBtn');
const archiveDeleteAllBtn = document.getElementById('archiveDeleteAllBtn');
const archivedBoardsListEl = document.getElementById('archivedBoardsList');
const conflictBannerEl = document.getElementById('conflictBanner');
const conflictReloadBtn = document.getElementById('conflictReloadBtn');
const themeSelectEl = document.getElementById('themeSelect');

// === Theme (light/dark) ===
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  themeSelectEl.value = theme;
  localStorage.setItem('kanban-theme', theme);
}

applyTheme(localStorage.getItem('kanban-theme') === 'light' ? 'light' : 'dark');

themeSelectEl.addEventListener('change', () => applyTheme(themeSelectEl.value));

// === Copilot chat panel (wired to GitHub Copilot CLI via /api/copilot-chat) ===
const copilotBtn = document.getElementById('copilotBtn');
const copilotPanel = document.getElementById('copilotPanel');
const copilotCloseBtn = document.getElementById('copilotCloseBtn');
const copilotSlideTab = document.getElementById('copilotSlideTab');
const copilotMessagesEl = document.getElementById('copilotMessages');
const copilotSuggestionsEl = document.getElementById('copilotSuggestions');
const copilotInputEl = document.getElementById('copilotInput');
const copilotSendBtn = document.getElementById('copilotSendBtn');

function toggleCopilotPanel(forceOpen) {
  const shouldOpen = forceOpen !== undefined ? forceOpen : !copilotPanel.classList.contains('open');
  copilotPanel.classList.toggle('open', shouldOpen);
  if (shouldOpen) {
    copilotInputEl.focus();
  }
}

copilotBtn.addEventListener('click', () => toggleCopilotPanel(true));
copilotCloseBtn.addEventListener('click', () => toggleCopilotPanel(false));
copilotSlideTab.addEventListener('click', () => toggleCopilotPanel());

function addCopilotMessage(role, text) {
  const msg = document.createElement('div');
  msg.className = 'copilot-msg ' + role;

  const avatar = document.createElement('div');
  avatar.className = 'copilot-msg-avatar';
  avatar.textContent = role === 'assistant' ? '✨' : '🙂';

  const bubble = document.createElement('div');
  bubble.className = 'copilot-msg-bubble';
  if (role === 'assistant') {
    bubble.innerHTML = renderCopilotMarkdown(text);
  } else {
    bubble.textContent = text;
  }

  msg.appendChild(avatar);
  msg.appendChild(bubble);
  copilotMessagesEl.appendChild(msg);
  copilotMessagesEl.scrollTop = copilotMessagesEl.scrollHeight;
  return msg;
}

// Renders a small, safe subset of markdown (bold, inline code, bullet/numbered
// lists, paragraphs) so assistant replies look like formatted chat output
// instead of a single flat wall of text. Input is HTML-escaped first so the
// model's own output can never inject markup.
function renderCopilotMarkdown(text) {
  const escape = (s) =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  const inline = (s) =>
    escape(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+?)`/g, '<code>$1</code>');

  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const htmlParts = [];
  let listItems = null;
  let listTag = null;

  const flushList = () => {
    if (listItems) {
      htmlParts.push(`<${listTag}>${listItems.join('')}</${listTag}>`);
      listItems = null;
      listTag = null;
    }
  };

  lines.forEach((line) => {
    const trimmed = line.trim();
    const bulletMatch = trimmed.match(/^[-*•]\s+(.*)$/);
    const numberedMatch = trimmed.match(/^\d+[.)]\s+(.*)$/);

    if (bulletMatch) {
      if (listTag !== 'ul') { flushList(); listTag = 'ul'; listItems = []; }
      listItems.push(`<li>${inline(bulletMatch[1])}</li>`);
    } else if (numberedMatch) {
      if (listTag !== 'ol') { flushList(); listTag = 'ol'; listItems = []; }
      listItems.push(`<li>${inline(numberedMatch[1])}</li>`);
    } else if (!trimmed) {
      // Ignore blank lines rather than flushing, so a list separated by blank
      // lines (common in model output) still renders as one continuous list.
    } else {
      flushList();
      htmlParts.push(`<p>${inline(trimmed)}</p>`);
    }
  });
  flushList();

  return htmlParts.join('');
}

function showCopilotTyping() {
  const msg = document.createElement('div');
  msg.className = 'copilot-msg assistant copilot-typing';

  const avatar = document.createElement('div');
  avatar.className = 'copilot-msg-avatar';
  avatar.textContent = '✨';

  const bubble = document.createElement('div');
  bubble.className = 'copilot-msg-bubble';
  bubble.innerHTML =
    '<span class="copilot-typing-dot"></span><span class="copilot-typing-dot"></span><span class="copilot-typing-dot"></span>';

  msg.appendChild(avatar);
  msg.appendChild(bubble);
  copilotMessagesEl.appendChild(msg);
  copilotMessagesEl.scrollTop = copilotMessagesEl.scrollHeight;

  // Working with a real board can take up to a couple of minutes — let the
  // user know it's not stuck rather than leaving a bare dot animation.
  msg.hintTimer = setTimeout(() => {
    bubble.innerHTML +=
      '<div class="copilot-typing-hint">Still working on it — this can take a minute or two...</div>';
    copilotMessagesEl.scrollTop = copilotMessagesEl.scrollHeight;
  }, 8000);

  return msg;
}

function sendCopilotMessage(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return;
  copilotSuggestionsEl.style.display = 'none';
  addCopilotMessage('user', trimmed);
  copilotInputEl.value = '';
  copilotInputEl.style.height = 'auto';

  const typingEl = showCopilotTyping();
  fetch('/api/copilot-chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: trimmed }),
  })
    .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
    .then(({ ok, data }) => {
      clearTimeout(typingEl.hintTimer);
      typingEl.remove();
      if (ok && data.ok) {
        addCopilotMessage('assistant', data.reply || "I'm not able to help with that here.");
        loadData().then(render);
      } else {
        addCopilotMessage(
          'assistant',
          `Sorry, I couldn't reach the Copilot CLI (${data.error || 'unknown error'}).`
        );
      }
    })
    .catch((err) => {
      clearTimeout(typingEl.hintTimer);
      typingEl.remove();
      addCopilotMessage('assistant', `Sorry, something went wrong: ${err.message}`);
    });
}

copilotSendBtn.addEventListener('click', () => sendCopilotMessage(copilotInputEl.value));

copilotInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendCopilotMessage(copilotInputEl.value);
  }
});

copilotInputEl.addEventListener('input', () => {
  copilotInputEl.style.height = 'auto';
  copilotInputEl.style.height = Math.min(copilotInputEl.scrollHeight, 120) + 'px';
});

copilotSuggestionsEl.querySelectorAll('.copilot-chip').forEach((chip) => {
  chip.addEventListener('click', () => sendCopilotMessage(chip.dataset.prompt));
});

// Populate suggestion chips from the assistant's actual skills, so we never
// suggest something (like "summarize" or "overdue") that isn't really supported.
fetch('/api/skills')
  .then((res) => res.json())
  .then((data) => {
    if (!data.ok || !Array.isArray(data.skills)) return;
    copilotSuggestionsEl.innerHTML = '';
    data.skills
      .filter((skill) => skill.capability)
      .forEach((skill) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'copilot-chip';
        btn.title = skill.example || skill.capability;
        btn.dataset.prompt = skill.example || skill.capability;
        btn.textContent = skill.capability;
        btn.addEventListener('click', () => sendCopilotMessage(btn.dataset.prompt));
        copilotSuggestionsEl.appendChild(btn);
      });
  })
  .catch(() => {
    // If skills can't be loaded, leave the suggestions area empty rather than
    // showing stale/hardcoded prompts that may not be supported.
  });

addCopilotMessage(
  'assistant',
  "👋 Hi! I'm here to help. How can I assist you today?"
);

function tagColorHex(key) {
  const found = TAG_COLORS.find((c) => c.key === key);
  return found ? found.hex : TAG_COLORS[0].hex;
}

function priorityInfo(key) {
  return PRIORITIES.find((p) => p.key === key) || PRIORITIES[0];
}

function uid() {
  return 'item-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

function htmlToPlainText(html) {
  const div = document.createElement('div');
  div.innerHTML = html || '';
  return (div.textContent || '').replace(/\s+/g, ' ').trim();
}

function truncate(text, limit) {
  if (!text || text.length <= limit) return text;
  return text.slice(0, limit).trim() + '…';
}

function nowIso() {
  return new Date().toISOString();
}

function logActivity(item, text) {
  if (!item.activityLog) item.activityLog = [];
  item.activityLog.push({ ts: nowIso(), text });
}

function formatTs(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch (e) {
    return iso;
  }
}

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isOverdue(item, col) {
  return item.dueDate && col !== 'Completed' && item.dueDate < todayStr();
}

// === Fuzzy search ===
// Small, dependency-free fuzzy matcher: exact substrings match instantly; otherwise
// each search word is compared against every haystack word using edit distance so
// typos (e.g. "westpca" -> "westpac") and partial words still find results.
function levenshtein(a, b) {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[lb];
}

function maxEditsForLength(len) {
  if (len <= 3) return 0;
  if (len <= 6) return 1;
  return 2;
}

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9]+/g) || []);
}

function fuzzyMatches(haystackText, query) {
  const haystack = haystackText.toLowerCase();
  const needle = query.toLowerCase().trim();
  if (!needle) return true;
  if (haystack.includes(needle)) return true; // fast path: exact substring

  const needleWords = tokenize(needle);
  if (!needleWords.length) return false;
  const haystackWords = tokenize(haystack);
  if (!haystackWords.length) return false;

  return needleWords.every((needleWord) =>
    haystackWords.some((hw) => {
      if (hw.includes(needleWord) || needleWord.includes(hw)) return true;
      return levenshtein(needleWord, hw) <= maxEditsForLength(needleWord.length);
    })
  );
}

function getBoard(boardId) {
  return boardData.boards.find((b) => b.id === boardId);
}

function findItem(boardId, column, id) {
  const board = getBoard(boardId);
  if (!board) return null;
  return (board.columns[column] || []).find((it) => it.id === id);
}

function getFilterState(boardId) {
  if (!boardFilters[boardId]) {
    boardFilters[boardId] = { search: '', tags: [], priorities: new Set() };
  }
  return boardFilters[boardId];
}

function itemMatchesFilters(boardId, item, col) {
  const state = getFilterState(boardId);
  if (state.search) {
    const haystack = (
      item.heading +
      ' ' +
      htmlToPlainText(item.description) +
      ' ' +
      (item.tags || []).map((t) => t.text).join(' ')
    );
    if (!fuzzyMatches(haystack, state.search)) return false;
  }
  if (state.tags.length) {
    const itemTagTexts = (item.tags || []).map((t) => t.text.toLowerCase());
    const anyMatch = state.tags.some((filterTag) =>
      itemTagTexts.some((tagText) => tagText.includes(filterTag.toLowerCase()))
    );
    if (!anyMatch) return false;
  }
  if (state.priorities.size > 0 && !state.priorities.has(item.priority || 'green')) return false;
  return true;
}

async function loadData() {
  try {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error('Server responded with ' + res.status);
    boardData = await res.json();
  } catch (e) {
    saveStatusEl.textContent = 'Cannot reach server — run "Start Kanban.vbs" (do not open index.html directly)';
    boardsEl.innerHTML =
      '<p style="color:#f87171;padding:20px;">Could not load board data.<br>' +
      'Make sure the local server is running: double-click <b>Start Kanban.vbs</b> in the project folder, ' +
      'then use the page it opens (http://localhost:9000) — opening index.html directly will not work.</p>';
    return;
  }

  dataRev = typeof boardData._rev === 'number' ? boardData._rev : 1;
  saveBlockedByConflict = false;
  conflictBannerEl.classList.add('hidden');

  // Ensure structure completeness in case fields were added later
  if (!Array.isArray(boardData.boards) || boardData.boards.length === 0) {
    boardData.boards = [
      { id: 'board-general', name: 'General', columns: { 'To Do': [], 'In Progress': [], Completed: [] } },
    ];
  }
  boardData.boards.forEach((board) => {
    if (!board.columns) board.columns = {};
    COLUMNS.forEach((col) => {
      if (!board.columns[col]) board.columns[col] = [];
      board.columns[col].forEach((item) => {
        if (!item.activityLog) item.activityLog = [];
        if (!item.tags) item.tags = [];
        if (!item.tasks) item.tasks = [];
      });
    });
  });
  if (!Array.isArray(boardData.archived)) boardData.archived = [];
  if (!Array.isArray(boardData.archivedBoards)) boardData.archivedBoards = [];
  if (!boardData.settings) boardData.settings = {};
  if (!boardData.settings.wipLimits) boardData.settings.wipLimits = {};

  // Only default to the first board on initial load or if the previously active
  // board no longer exists — otherwise keep whatever tab the user was viewing
  // (e.g. after a Copilot chat reply triggers a data refresh).
  if (!activeBoardId || !boardData.boards.some((b) => b.id === activeBoardId)) {
    activeBoardId = boardData.boards[0].id;
  }
  render();
}

function scheduleSave() {
  if (saveBlockedByConflict) return; // don't keep overwriting until the user reloads
  saveStatusEl.textContent = 'Saving...';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      boardData._rev = dataRev;
      const res = await fetch('/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(boardData),
      });
      if (res.status === 409) {
        saveBlockedByConflict = true;
        saveStatusEl.textContent = 'Save blocked — changed elsewhere';
        conflictBannerEl.classList.remove('hidden');
        return;
      }
      if (!res.ok) throw new Error('Server responded with ' + res.status);
      const json = await res.json();
      dataRev = json.rev;
      saveStatusEl.textContent = '';
    } catch (e) {
      saveStatusEl.textContent = 'Save failed - is the server running?';
    }
  }, 300);
}

conflictReloadBtn.addEventListener('click', () => window.location.reload());

document.addEventListener('click', (e) => {
  if (openPriorityFilterBoardId !== null && !e.target.closest('.priority-filter-wrap')) {
    openPriorityFilterBoardId = null;
    render();
  }
  if (openMoveMenuItemId !== null && !e.target.closest('.card-move-wrap')) {
    openMoveMenuItemId = null;
    renderActiveBoard();
  }
  if (!e.target.closest('.export-wrap')) {
    exportMenu.classList.remove('open');
  }
});

exportBtn.addEventListener('click', () => {
  const opening = !exportMenu.classList.contains('open');
  if (opening) renderExportBoardList();
  exportMenu.classList.toggle('open', opening);
});

// Populates the export checkbox list from the current boards, defaulting to
// only the currently active board checked (most common single-board export).
function renderExportBoardList() {
  exportBoardListEl.innerHTML = '';
  (boardData ? boardData.boards : []).forEach((board) => {
    const label = document.createElement('label');
    label.className = 'export-checkbox-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = board.id;
    checkbox.checked = board.id === activeBoardId;
    checkbox.className = 'export-board-checkbox';
    checkbox.addEventListener('change', updateExportSelectAllState);
    const span = document.createElement('span');
    span.textContent = board.name;
    label.appendChild(checkbox);
    label.appendChild(span);
    exportBoardListEl.appendChild(label);
  });
  updateExportSelectAllState();
}

function exportBoardCheckboxes() {
  return Array.from(exportBoardListEl.querySelectorAll('.export-board-checkbox'));
}

function updateExportSelectAllState() {
  const boxes = exportBoardCheckboxes();
  const checkedCount = boxes.filter((b) => b.checked).length;
  exportSelectAllEl.checked = boxes.length > 0 && checkedCount === boxes.length;
  exportSelectAllEl.indeterminate = checkedCount > 0 && checkedCount < boxes.length;
  exportConfirmBtn.disabled = checkedCount === 0;
}

exportSelectAllEl.addEventListener('change', () => {
  exportBoardCheckboxes().forEach((b) => { b.checked = exportSelectAllEl.checked; });
  exportSelectAllEl.indeterminate = false;
  exportConfirmBtn.disabled = !exportSelectAllEl.checked && exportBoardCheckboxes().every((b) => !b.checked);
});

exportConfirmBtn.addEventListener('click', () => {
  const boxes = exportBoardCheckboxes();
  const checkedIds = boxes.filter((b) => b.checked).map((b) => b.value);
  if (!checkedIds.length) return;
  const boardParam = checkedIds.length === boxes.length ? 'all' : checkedIds.join(',');
  exportMenu.classList.remove('open');
  window.location.href = '/api/export?board=' + encodeURIComponent(boardParam);
});

// === Import (Excel -> boards) ===
// Reuses the same .xlsx format /api/export produces: pick a file, ship its
// raw bytes to the server (which is tolerant of column reordering/extra or
// missing columns, so older/newer exports both import cleanly). Sheets whose
// name matches an existing board are merged into it (skipping items that
// already exist there); otherwise a new board is created. Then reload board
// data so the results show up as tabs.
importBtn.addEventListener('click', () => {
  importFileInput.click();
});

importFileInput.addEventListener('change', async () => {
  const file = importFileInput.files && importFileInput.files[0];
  importFileInput.value = ''; // allow re-selecting the same file next time
  if (!file) return;

  importBtn.disabled = true;
  const originalLabel = importBtn.textContent;
  importBtn.textContent = 'Importing...';
  try {
    const buf = await file.arrayBuffer();
    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buf,
    });
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.error || 'Import failed.');

    await loadData();
    const summary = json.imported
      .map((b) => `${b.name}${b.merged ? ` (+${b.itemCount})` : ` (${b.itemCount})`}`)
      .join(', ');
    if (json.imported.length === 1) activeBoardId = json.imported[0].id;
    render();
    showUndo(`Imported into ${summary}`, () => {
      json.imported.forEach((entry) => {
        const board = boardData.boards.find((b) => b.id === entry.id);
        if (!board) return;
        if (entry.merged) {
          // Merge undo: only strip the items this import actually added,
          // leaving the board's pre-existing items untouched.
          const addedIds = new Set(entry.addedItemIds || []);
          COLUMNS.forEach((col) => {
            board.columns[col] = (board.columns[col] || []).filter((it) => !addedIds.has(it.id));
          });
        } else {
          boardData.boards = boardData.boards.filter((b) => b.id !== entry.id);
        }
      });
      if (!boardData.boards.some((b) => b.id === activeBoardId)) activeBoardId = boardData.boards[0].id;
    });
  } catch (e) {
    window.alert('Import failed: ' + e.message);
  } finally {
    importBtn.disabled = false;
    importBtn.textContent = originalLabel;
  }
});

// === Undo toast ===
function showUndo(message, undoFn) {
  lastUndo = { message, undo: undoFn };
  undoMessageEl.textContent = message;
  undoToastEl.classList.remove('hidden');
  clearTimeout(undoHideTimer);
  undoHideTimer = setTimeout(hideUndo, 6000);
}

function hideUndo() {
  undoToastEl.classList.add('hidden');
  lastUndo = null;
  clearTimeout(undoHideTimer);
}

undoBtn.addEventListener('click', () => {
  if (lastUndo) {
    lastUndo.undo();
    hideUndo();
    render();
    scheduleSave();
  }
});

// === Rendering ===
function render() {
  renderTabs();
  renderActiveBoard();
  updateArchiveCount();
  updateBulkToolbar();
}

function renderTabs() {
  tabsEl.innerHTML = '';
  boardData.boards.forEach((board, index) => {
    const tabWrap = document.createElement('div');
    tabWrap.className = 'tab-wrap';
    tabWrap.draggable = true;
    tabWrap.dataset.boardId = board.id;

    tabWrap.addEventListener('dragstart', (e) => {
      tabWrap.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', board.id);
    });
    tabWrap.addEventListener('dragend', () => tabWrap.classList.remove('dragging'));

    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (board.id === activeBoardId ? ' active' : '');
    btn.textContent = board.name;
    btn.addEventListener('click', () => {
      activeBoardId = board.id;
      selectedIds.clear();
      render();
    });
    tabWrap.appendChild(btn);

    if (board.id === activeBoardId) {
      const renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'tab-rename-btn';
      renameBtn.title = 'Rename board';
      renameBtn.textContent = '✎';
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        renameBoard(board.id);
      });
      tabWrap.appendChild(renameBtn);

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'tab-delete-btn';
      deleteBtn.title = 'Delete board';
      deleteBtn.textContent = '🗑';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteBoard(board.id);
      });
      tabWrap.appendChild(deleteBtn);
    }

    tabsEl.appendChild(tabWrap);
  });

  const addBoardBtn = document.createElement('button');
  addBoardBtn.type = 'button';
  addBoardBtn.className = 'add-board-btn';
  addBoardBtn.textContent = '+ New Board';
  addBoardBtn.addEventListener('click', addBoard);
  tabsEl.appendChild(addBoardBtn);
}

// Reorder board tabs by dragging (mirrors the card drag-reorder pattern),
// and also accept a card dropped on a tab to move it to that board.
tabsEl.addEventListener('dragover', (e) => {
  if (draggingCardInfo) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const tabWrap = e.target.closest('.tab-wrap');
    clearTabDropHighlight();
    if (tabWrap && tabWrap.dataset.boardId !== draggingCardInfo.boardId) {
      tabWrap.classList.add('tab-drop-target');
    }
    return;
  }
  const dragging = tabsEl.querySelector('.tab-wrap.dragging');
  if (!dragging) return;
  e.preventDefault();
  const afterEl = getTabDragAfterElement(tabsEl, e.clientX);
  if (afterEl == null) {
    tabsEl.insertBefore(dragging, tabsEl.querySelector('.add-board-btn'));
  } else {
    tabsEl.insertBefore(dragging, afterEl);
  }
});

tabsEl.addEventListener('dragleave', (e) => {
  if (draggingCardInfo && !tabsEl.contains(e.relatedTarget)) {
    clearTabDropHighlight();
  }
});

tabsEl.addEventListener('drop', (e) => {
  if (draggingCardInfo) {
    e.preventDefault();
    const tabWrap = e.target.closest('.tab-wrap');
    const info = draggingCardInfo;
    draggingCardInfo = null;
    clearTabDropHighlight();
    if (tabWrap && tabWrap.dataset.boardId !== info.boardId) {
      moveItemToBoard(info.itemId, info.boardId, info.column, tabWrap.dataset.boardId);
    }
    return;
  }
  const draggedId = e.dataTransfer.getData('text/plain');
  if (!draggedId) return;
  const newOrderIds = [...tabsEl.querySelectorAll('.tab-wrap')].map((el) => el.dataset.boardId);
  boardData.boards.sort((a, b) => newOrderIds.indexOf(a.id) - newOrderIds.indexOf(b.id));
  render();
  scheduleSave();
});

function clearTabDropHighlight() {
  tabsEl.querySelectorAll('.tab-drop-target').forEach((el) => el.classList.remove('tab-drop-target'));
}

function getTabDragAfterElement(container, x) {
  const tabs = [...container.querySelectorAll('.tab-wrap:not(.dragging)')];
  return tabs.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = x - box.left - box.width / 2;
      if (offset < 0 && offset > closest.offset) {
        return { offset, element: child };
      }
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null }
  ).element;
}

function renameBoard(boardId) {
  const board = getBoard(boardId);
  if (!board) return;
  const name = window.prompt('Rename board:', board.name);
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  board.name = trimmed;
  render();
  scheduleSave();
}

function deleteBoard(boardId) {
  const board = getBoard(boardId);
  if (!board) return;
  if (boardData.boards.length <= 1) {
    window.alert('You must keep at least one Kanban board.');
    return;
  }
  const itemCount = COLUMNS.reduce((sum, col) => sum + (board.columns[col] || []).length, 0);
  const warning =
    itemCount > 0
      ? `Delete board "${board.name}" and all ${itemCount} item(s) in it?\n\nIt will be moved to Archive, where you can restore it later.`
      : `Delete board "${board.name}"?\n\nIt will be moved to Archive, where you can restore it later.`;
  if (!window.confirm(warning)) return;

  const idx = boardData.boards.findIndex((b) => b.id === boardId);
  const [removedBoard] = boardData.boards.splice(idx, 1);
  const wipLimits = boardData.settings.wipLimits ? boardData.settings.wipLimits[boardId] : null;
  if (boardData.settings.wipLimits) delete boardData.settings.wipLimits[boardId];
  delete boardFilters[boardId];

  boardData.archivedBoards.push({
    id: uid(),
    board: removedBoard,
    wipLimits: wipLimits || null,
    deletedAt: nowIso(),
  });

  if (activeBoardId === boardId) {
    const nextIdx = Math.max(0, idx - 1);
    activeBoardId = boardData.boards[Math.min(nextIdx, boardData.boards.length - 1)].id;
  }
  render();
  scheduleSave();
  showUndo(`Deleted board "${removedBoard.name}"`, () => {
    const rec = boardData.archivedBoards[boardData.archivedBoards.length - 1];
    if (rec && rec.board.id === removedBoard.id) boardData.archivedBoards.pop();
    boardData.boards.push(removedBoard);
    if (wipLimits) {
      if (!boardData.settings.wipLimits) boardData.settings.wipLimits = {};
      boardData.settings.wipLimits[boardId] = wipLimits;
    }
    activeBoardId = removedBoard.id;
  });
}

function restoreArchivedBoard(archiveId) {
  const idx = boardData.archivedBoards.findIndex((r) => r.id === archiveId);
  if (idx === -1) return;
  const [rec] = boardData.archivedBoards.splice(idx, 1);
  boardData.boards.push(rec.board);
  if (rec.wipLimits) {
    if (!boardData.settings.wipLimits) boardData.settings.wipLimits = {};
    boardData.settings.wipLimits[rec.board.id] = rec.wipLimits;
  }
  activeBoardId = rec.board.id;
  renderArchivedBoardsList();
  render();
  scheduleSave();
}

function permanentlyDeleteArchivedBoard(archiveId) {
  const idx = boardData.archivedBoards.findIndex((r) => r.id === archiveId);
  if (idx === -1) return;
  const rec = boardData.archivedBoards[idx];
  const itemCount = COLUMNS.reduce((sum, col) => sum + (rec.board.columns[col] || []).length, 0);
  if (
    !window.confirm(
      `Permanently delete board "${rec.board.name}"${itemCount ? ` and its ${itemCount} item(s)` : ''}? This cannot be undone.`
    )
  )
    return;
  boardData.archivedBoards.splice(idx, 1);
  renderArchivedBoardsList();
  scheduleSave();
}

function renderArchivedBoardsList() {
  archivedBoardsListEl.innerHTML = '';
  if (!boardData.archivedBoards.length) {
    const empty = document.createElement('div');
    empty.className = 'archive-empty';
    empty.textContent = 'No deleted boards.';
    archivedBoardsListEl.appendChild(empty);
    return;
  }
  [...boardData.archivedBoards]
    .slice()
    .reverse()
    .forEach((rec) => {
      const row = document.createElement('div');
      row.className = 'archive-row';

      const itemCount = COLUMNS.reduce((sum, col) => sum + (rec.board.columns[col] || []).length, 0);

      const info = document.createElement('div');
      info.className = 'archive-row-info';
      const heading = document.createElement('div');
      heading.className = 'archive-heading';
      heading.textContent = rec.board.name;
      const meta = document.createElement('div');
      meta.className = 'archive-meta';
      meta.textContent = `${itemCount} item(s) · deleted ${formatTs(rec.deletedAt)}`;
      info.appendChild(heading);
      info.appendChild(meta);

      const restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.className = 'btn btn-secondary btn-small';
      restoreBtn.textContent = 'Restore';
      restoreBtn.addEventListener('click', () => restoreArchivedBoard(rec.id));

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn btn-danger btn-small';
      deleteBtn.textContent = 'Delete Forever';
      deleteBtn.addEventListener('click', () => permanentlyDeleteArchivedBoard(rec.id));

      row.appendChild(info);
      row.appendChild(restoreBtn);
      row.appendChild(deleteBtn);
      archivedBoardsListEl.appendChild(row);
    });
}

function addBoard() {
  const name = window.prompt('Name for the new Kanban board:', '');
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  const board = {
    id: uid(),
    name: trimmed,
    columns: { 'To Do': [], 'In Progress': [], Completed: [] },
  };
  boardData.boards.push(board);
  activeBoardId = board.id;
  render();
  scheduleSave();
}

function getWipLimit(boardId, col) {
  const boardLimits = boardData.settings.wipLimits[boardId];
  return boardLimits ? boardLimits[col] || null : null;
}

function setWipLimit(boardId, col, limit) {
  if (!boardData.settings.wipLimits[boardId]) boardData.settings.wipLimits[boardId] = {};
  boardData.settings.wipLimits[boardId][col] = limit;
}

function renderActiveBoard() {
  boardsEl.innerHTML = '';
  const board = getBoard(activeBoardId);
  if (!board) return;

  const boardEl = document.createElement('div');
  boardEl.className = 'board active';
  boardEl.dataset.boardId = board.id;

  boardEl.appendChild(renderBoardToolbar(board));

  const columnsWrap = document.createElement('div');
  columnsWrap.className = 'columns-wrap';

  COLUMNS.forEach((col) => {
    const column = document.createElement('div');
    column.className = 'column';

    const header = document.createElement('div');
    header.className = 'column-header';
    const h3 = document.createElement('h3');
    h3.textContent = col;

    const count = (board.columns[col] || []).length;
    const limit = getWipLimit(board.id, col);
    const badge = document.createElement('span');
    badge.className = 'count-badge' + (limit && count > limit ? ' over-limit' : '');
    badge.textContent = limit ? `${count}/${limit}` : String(count);
    badge.title = limit ? 'WIP limit: ' + limit : 'No WIP limit set';

    const limitBtn = document.createElement('button');
    limitBtn.type = 'button';
    limitBtn.className = 'wip-limit-btn';
    limitBtn.title = 'Set WIP limit';
    limitBtn.textContent = '⚙';
    limitBtn.addEventListener('click', () => {
      const current = getWipLimit(board.id, col);
      const input = window.prompt(
        `Set a WIP limit for "${col}" in ${board.name} (leave blank or 0 to remove the limit):`,
        current || ''
      );
      if (input === null) return;
      const n = parseInt(input, 10);
      setWipLimit(board.id, col, Number.isFinite(n) && n > 0 ? n : null);
      render();
      scheduleSave();
    });

    header.appendChild(h3);
    header.appendChild(limitBtn);
    header.appendChild(badge);

    const addBtn = document.createElement('button');
    addBtn.className = 'add-item-btn';
    addBtn.textContent = '+ Add item';
    addBtn.addEventListener('click', () => showQuickAdd(board.id, col, addBtn));

    const list = document.createElement('div');
    list.className = 'card-list';
    list.dataset.boardId = board.id;
    list.dataset.column = col;

    list.addEventListener('dragover', (e) => {
      e.preventDefault();
      list.classList.add('drag-over');
      const afterEl = getDragAfterElement(list, e.clientY);
      const dragging = document.querySelector('.card.dragging');
      if (!dragging) return;
      if (afterEl == null) {
        list.appendChild(dragging);
      } else {
        list.insertBefore(dragging, afterEl);
      }
    });
    list.addEventListener('dragleave', () => list.classList.remove('drag-over'));
    list.addEventListener('drop', (e) => {
      e.preventDefault();
      list.classList.remove('drag-over');
      const itemId = e.dataTransfer.getData('text/plain');
      const ids = [...list.querySelectorAll('.card')].map((c) => c.dataset.id);
      const newIndex = ids.indexOf(itemId);
      moveItem(itemId, board.id, col, newIndex);
    });

    (board.columns[col] || []).forEach((item) => {
      list.appendChild(renderCard(board, col, item));
    });

    column.appendChild(header);
    column.appendChild(addBtn);
    column.appendChild(list);
    columnsWrap.appendChild(column);
  });

  boardEl.appendChild(columnsWrap);
  boardsEl.appendChild(boardEl);
}

function renderBoardToolbar(board) {
  const state = getFilterState(board.id);
  const toolbar = document.createElement('div');
  toolbar.className = 'board-toolbar';

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'board-search-input';
  searchInput.placeholder = '🔍 Search this board...';
  searchInput.value = state.search;
  searchInput.addEventListener('input', () => {
    state.search = searchInput.value;
    render();
    // restore focus/cursor since render() rebuilds the input
    const newInput = boardsEl.querySelector('.board-search-input');
    if (newInput) {
      newInput.focus();
      newInput.setSelectionRange(newInput.value.length, newInput.value.length);
    }
  });

  const tagFilterWrap = document.createElement('div');
  tagFilterWrap.className = 'board-tag-filter-wrap';

  const tagInput = document.createElement('input');
  tagInput.type = 'text';
  tagInput.className = 'board-tag-filter-input';
  tagInput.placeholder = 'Filter by tags (press Enter)...';

  const commitTag = () => {
    const text = tagInput.value.trim();
    if (!text) {
      tagInput.focus();
      return;
    }
    if (!state.tags.some((t) => t.toLowerCase() === text.toLowerCase())) {
      state.tags.push(text);
    }
    tagInput.value = '';
    render();
    const newInput = boardsEl.querySelector('.board-tag-filter-input');
    if (newInput) newInput.focus();
  };

  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitTag();
    }
  });

  const tagChipList = document.createElement('div');
  tagChipList.className = 'tag-chip-list board-tag-filter-chips';
  state.tags.forEach((tagText, index) => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.style.background = tagColorHex(TAG_COLORS[index % TAG_COLORS.length].key);

    const label = document.createElement('span');
    label.textContent = tagText;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'tag-chip-remove';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => {
      state.tags.splice(index, 1);
      render();
    });

    chip.appendChild(label);
    chip.appendChild(removeBtn);
    tagChipList.appendChild(chip);
  });

  tagFilterWrap.appendChild(tagInput);
  tagFilterWrap.appendChild(tagChipList);

  const priorityFilterWrap = document.createElement('div');
  priorityFilterWrap.className = 'priority-filter-wrap';

  const priorityToggleBtn = document.createElement('button');
  priorityToggleBtn.type = 'button';
  priorityToggleBtn.className = 'priority-filter-toggle';
  const selectedCount = state.priorities.size;
  priorityToggleBtn.textContent = selectedCount
    ? `Priority (${selectedCount}) ▾`
    : 'Priority: All ▾';
  priorityToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openPriorityFilterBoardId = openPriorityFilterBoardId === board.id ? null : board.id;
    render();
  });

  const priorityPanel = document.createElement('div');
  priorityPanel.className = 'priority-filter-panel' + (openPriorityFilterBoardId === board.id ? ' open' : '');

  PRIORITIES.forEach((p) => {
    const option = document.createElement('label');
    option.className = 'priority-filter-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.priorities.has(p.key);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.priorities.add(p.key);
      else state.priorities.delete(p.key);
      render();
    });
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = p.hex;
    option.appendChild(checkbox);
    option.appendChild(dot);
    option.appendChild(document.createTextNode(p.label));
    priorityPanel.appendChild(option);
  });

  priorityFilterWrap.appendChild(priorityToggleBtn);
  priorityFilterWrap.appendChild(priorityPanel);

  toolbar.appendChild(priorityFilterWrap);
  toolbar.appendChild(searchInput);
  toolbar.appendChild(tagFilterWrap);

  const clearFiltersBtn = document.createElement('button');
  clearFiltersBtn.type = 'button';
  clearFiltersBtn.className = 'clear-filters-btn';
  clearFiltersBtn.textContent = '✕ Clear filters';
  const hasActiveFilters = !!state.search || state.tags.length > 0 || state.priorities.size > 0;
  clearFiltersBtn.disabled = !hasActiveFilters;
  clearFiltersBtn.addEventListener('click', () => {
    state.search = '';
    state.tags = [];
    state.priorities.clear();
    openPriorityFilterBoardId = null;
    render();
  });
  toolbar.appendChild(clearFiltersBtn);

  return toolbar;
}

function getDragAfterElement(container, y) {
  const cards = [...container.querySelectorAll('.card:not(.dragging)')];
  return cards.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) {
        return { offset, element: child };
      }
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null }
  ).element;
}

function renderCard(board, col, item) {
  const card = document.createElement('div');
  card.className = 'card priority-' + (item.priority || 'green');
  card.draggable = true;
  card.dataset.id = item.id;

  if (!itemMatchesFilters(board.id, item, col)) {
    card.classList.add('hidden');
  }

  if (selectMode) {
    const selectRow = document.createElement('div');
    selectRow.className = 'card-select-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedIds.has(item.id);
    checkbox.addEventListener('click', (e) => e.stopPropagation());
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedIds.add(item.id);
      else selectedIds.delete(item.id);
      updateBulkToolbar();
    });
    selectRow.appendChild(checkbox);
    card.appendChild(selectRow);
  }

  const deleteIcon = document.createElement('button');
  deleteIcon.type = 'button';
  deleteIcon.className = 'card-delete-icon';
  deleteIcon.title = 'Archive this item';
  deleteIcon.textContent = '🗑';
  deleteIcon.addEventListener('click', (e) => {
    e.stopPropagation();
    archiveItem(board.id, col, item.id);
  });
  card.appendChild(deleteIcon);

  const otherBoards = boardData.boards.filter((b) => b.id !== board.id);
  if (otherBoards.length) {
    const moveWrap = document.createElement('div');
    moveWrap.className = 'card-move-wrap';

    const moveToggle = document.createElement('button');
    moveToggle.type = 'button';
    moveToggle.className = 'card-move-icon';
    moveToggle.title = 'Move to another board';
    moveToggle.textContent = '⇄';
    moveToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      openMoveMenuItemId = openMoveMenuItemId === item.id ? null : item.id;
      renderActiveBoard();
    });

    const moveMenu = document.createElement('div');
    moveMenu.className = 'card-move-menu' + (openMoveMenuItemId === item.id ? ' open' : '');
    const menuLabel = document.createElement('div');
    menuLabel.className = 'card-move-menu-label';
    menuLabel.textContent = 'Move to board';
    moveMenu.appendChild(menuLabel);
    otherBoards.forEach((targetBoard) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'card-move-option';
      option.textContent = targetBoard.name;
      option.addEventListener('click', (e) => {
        e.stopPropagation();
        openMoveMenuItemId = null;
        moveItemToBoard(item.id, board.id, col, targetBoard.id);
      });
      moveMenu.appendChild(option);
    });

    moveWrap.appendChild(moveToggle);
    moveWrap.appendChild(moveMenu);
    card.appendChild(moveWrap);
  }

  const pInfo = priorityInfo(item.priority || 'green');
  const priorityBadge = document.createElement('span');
  priorityBadge.className = 'card-priority-badge';
  const priorityDot = document.createElement('span');
  priorityDot.className = 'dot';
  priorityDot.style.background = pInfo.hex;
  priorityBadge.appendChild(priorityDot);
  priorityBadge.appendChild(document.createTextNode(pInfo.label));
  card.appendChild(priorityBadge);

  const tags = item.tags || [];
  if (tags.length) {
    const tagRow = document.createElement('div');
    tagRow.className = 'card-tags';
    tags.slice(0, MAX_TAGS_SHOWN_ON_CARD).forEach((tag) => {
      const chip = document.createElement('span');
      chip.className = 'card-tag';
      chip.style.background = tagColorHex(tag.color);
      chip.textContent = tag.text;
      tagRow.appendChild(chip);
    });
    if (tags.length > MAX_TAGS_SHOWN_ON_CARD) {
      const more = document.createElement('span');
      more.className = 'card-tag card-tag-more';
      more.textContent = '+' + (tags.length - MAX_TAGS_SHOWN_ON_CARD);
      tagRow.appendChild(more);
    }
    card.appendChild(tagRow);
  }

  const h4 = document.createElement('h4');
  h4.textContent = item.heading;
  const p = document.createElement('p');
  p.textContent = truncate(htmlToPlainText(item.description), DESCRIPTION_PREVIEW_LIMIT);

  card.appendChild(h4);
  card.appendChild(p);

  const tasks = item.tasks || [];
  const doneCount = tasks.filter((t) => t.done).length;

  if (item.dueDate || item.completionDate || tasks.length) {
    const meta = document.createElement('div');
    meta.className = 'card-meta';

    if (item.dueDate) {
      const overdue = isOverdue(item, col);
      const badge = document.createElement('span');
      badge.className = 'meta-badge due' + (overdue ? ' overdue' : '');
      badge.textContent = (overdue ? '⚠ Overdue ' : '📅 Due ') + item.dueDate;
      meta.appendChild(badge);
    }
    if (item.completionDate) {
      const badge = document.createElement('span');
      badge.className = 'meta-badge completed';
      badge.textContent = '✅ Done ' + item.completionDate;
      meta.appendChild(badge);
    }
    if (tasks.length) {
      const badge = document.createElement('span');
      badge.className = 'meta-badge tasks';
      badge.textContent = `☑ ${doneCount}/${tasks.length} tasks`;
      meta.appendChild(badge);
    }

    card.appendChild(meta);
  }

  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', item.id);
    draggingCardInfo = { itemId: item.id, boardId: board.id, column: col };
    setTimeout(() => card.classList.add('dragging'), 0);
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    draggingCardInfo = null;
    clearTabDropHighlight();
  });
  card.addEventListener('click', () => {
    if (selectMode) {
      if (selectedIds.has(item.id)) selectedIds.delete(item.id);
      else selectedIds.add(item.id);
      updateBulkToolbar();
      renderActiveBoard();
      return;
    }
    openModal(board.id, col, item.id);
  });

  return card;
}

function moveItemToBoard(itemId, fromBoardId, column, toBoardId) {
  if (fromBoardId === toBoardId) return;
  const fromBoard = getBoard(fromBoardId);
  const toBoard = getBoard(toBoardId);
  if (!fromBoard || !toBoard) return;
  const list = fromBoard.columns[column];
  const idx = list.findIndex((it) => it.id === itemId);
  if (idx === -1) return;
  const [item] = list.splice(idx, 1);
  logActivity(item, `Moved to board "${toBoard.name}" (${column})`);
  toBoard.columns[column].push(item);
  showUndo(`Moved "${item.heading}" to ${toBoard.name}`, () => {
    const backIdx = toBoard.columns[column].findIndex((it) => it.id === itemId);
    if (backIdx === -1) return;
    const [movedBack] = toBoard.columns[column].splice(backIdx, 1);
    logActivity(movedBack, `Moved back to board "${fromBoard.name}" (${column})`);
    fromBoard.columns[column].push(movedBack);
    render();
    scheduleSave();
  });
  render();
  scheduleSave();
}

function moveItem(itemId, targetBoardId, targetColumn, targetIndex) {
  const board = getBoard(targetBoardId);
  if (!board) return;
  for (const col of COLUMNS) {
    const list = board.columns[col];
    const idx = list.findIndex((it) => it.id === itemId);
    if (idx !== -1) {
      const sameColumn = col === targetColumn;
      if (sameColumn && (targetIndex === undefined || targetIndex === idx)) return;
      const [item] = list.splice(idx, 1);
      const fromCol = col;
      if (!sameColumn) {
        if (targetColumn === 'Completed') {
          item.completionDate = todayStr();
        } else if (fromCol === 'Completed') {
          item.completionDate = '';
        }
        logActivity(item, `Moved from "${fromCol}" to "${targetColumn}"`);
      }
      const destList = board.columns[targetColumn];
      const insertAt =
        targetIndex === undefined || targetIndex < 0 || targetIndex > destList.length
          ? destList.length
          : targetIndex;
      destList.splice(insertAt, 0, item);
      render();
      scheduleSave();
      return;
    }
  }
}

function renderTagColorPicker() {
  tagColorPickerEl.innerHTML = '';
  TAG_COLORS.forEach((c) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tag-color-swatch' + (c.key === selectedTagColor ? ' selected' : '');
    btn.style.background = c.hex;
    btn.dataset.color = c.key;
    btn.title = c.key;
    btn.addEventListener('click', () => {
      selectedTagColor = c.key;
      renderTagColorPicker();
    });
    tagColorPickerEl.appendChild(btn);
  });
}

function renderTagChips() {
  tagChipListEl.innerHTML = '';
  modalTags.forEach((tag, index) => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.style.background = tagColorHex(tag.color);

    const label = document.createElement('span');
    label.textContent = tag.text;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'tag-chip-remove';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => {
      modalTags.splice(index, 1);
      renderTagChips();
    });

    chip.appendChild(label);
    chip.appendChild(removeBtn);
    tagChipListEl.appendChild(chip);
  });
}

function renderTaskList() {
  taskListContainerEl.innerHTML = '';
  modalTasks.forEach((task, index) => {
    const row = document.createElement('div');
    row.className = 'task-row' + (task.done ? ' done' : '');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = task.done;
    checkbox.addEventListener('change', () => {
      task.done = checkbox.checked;
      row.classList.toggle('done', task.done);
    });

    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.value = task.text;
    textInput.placeholder = 'Task description';
    textInput.addEventListener('input', () => {
      task.text = textInput.value;
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'task-row-delete';
    deleteBtn.textContent = '✕';
    deleteBtn.addEventListener('click', () => {
      modalTasks.splice(index, 1);
      renderTaskList();
    });

    row.appendChild(checkbox);
    row.appendChild(textInput);
    row.appendChild(deleteBtn);
    taskListContainerEl.appendChild(row);
  });
}

function openModal(boardId, column, id) {
  modalContext = { boardId, column, id };
  selectedPriority = 'green';
  selectedTagColor = TAG_COLORS[0].key;
  newTagTextEl.value = '';

  if (id) {
    const item = findItem(boardId, column, id);
    modalTitle.textContent = 'Edit Item';
    itemHeadingEl.value = item.heading;
    itemOutcomeEl.value = item.outcome || '';
    itemDescriptionEl.innerHTML = item.description || '';
    itemDueDateEl.value = item.dueDate || '';
    itemCompletionDateEl.value = item.completionDate || '';
    selectedPriority = item.priority || 'green';
    modalTasks = (item.tasks || []).map((t) => ({ ...t }));
    modalTags = (item.tags || []).map((t) => ({ ...t }));
    deleteItemBtn.style.display = 'inline-block';
  } else {
    modalTitle.textContent = 'New Item — ' + column;
    itemHeadingEl.value = '';
    itemOutcomeEl.value = '';
    itemDescriptionEl.innerHTML = DESCRIPTION_TEMPLATE;
    itemDueDateEl.value = '';
    itemCompletionDateEl.value = '';
    modalTasks = [];
    modalTags = [];
    deleteItemBtn.style.display = 'none';
  }

  renderTaskList();
  renderTagColorPicker();
  renderTagChips();
  renderActivityLog(id ? findItem(boardId, column, id) : null);
  updatePrioritySelection();
  modalOverlay.classList.add('open');
  itemHeadingEl.focus();
}

function renderActivityLog(item) {
  activityLogContainerEl.innerHTML = '';
  const log = item && item.activityLog ? item.activityLog : [];
  if (!log.length) {
    const empty = document.createElement('div');
    empty.className = 'activity-log-empty';
    empty.textContent = 'No activity yet.';
    activityLogContainerEl.appendChild(empty);
    return;
  }
  [...log]
    .slice()
    .reverse()
    .forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'activity-log-entry';
      const ts = document.createElement('span');
      ts.className = 'ts';
      ts.textContent = formatTs(entry.ts);
      const text = document.createElement('span');
      text.textContent = entry.text;
      row.appendChild(ts);
      row.appendChild(text);
      activityLogContainerEl.appendChild(row);
    });
}

function closeModal() {
  modalOverlay.classList.remove('open');
}

function updatePrioritySelection() {
  [...priorityPickerEl.children].forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.priority === selectedPriority);
  });
}

priorityPickerEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.priority-swatch');
  if (!btn) return;
  selectedPriority = btn.dataset.priority;
  updatePrioritySelection();
});

saveItemBtn.addEventListener('click', () => {
  const heading = itemHeadingEl.value.trim();
  if (!heading) {
    itemHeadingEl.focus();
    return;
  }
  const { boardId, column, id } = modalContext;
  const board = getBoard(boardId);
  if (!board) return;
  const cleanTasks = modalTasks
    .filter((t) => t.text.trim() !== '')
    .map((t) => ({ id: t.id || uid(), text: t.text.trim(), done: !!t.done }));

  if (id) {
    const item = findItem(boardId, column, id);
    const changes = [];
    if (item.heading !== heading) changes.push('heading');
    if ((item.outcome || '') !== itemOutcomeEl.value.trim()) changes.push('outcome');
    if (item.description !== itemDescriptionEl.innerHTML) changes.push('description');
    if (item.priority !== selectedPriority) changes.push('priority');
    if ((item.dueDate || null) !== (itemDueDateEl.value || null)) changes.push('due date');
    if ((item.completionDate || null) !== (itemCompletionDateEl.value || null)) changes.push('completion date');
    item.heading = heading;
    item.outcome = itemOutcomeEl.value.trim();
    item.description = itemDescriptionEl.innerHTML;
    item.priority = selectedPriority;
    item.dueDate = itemDueDateEl.value || null;
    item.completionDate = itemCompletionDateEl.value || null;
    item.tasks = cleanTasks;
    item.tags = modalTags;
    logActivity(item, changes.length ? `Edited (${changes.join(', ')})` : 'Edited');
  } else {
    const item = {
      id: uid(),
      heading,
      outcome: itemOutcomeEl.value.trim(),
      description: itemDescriptionEl.innerHTML,
      priority: selectedPriority,
      dueDate: itemDueDateEl.value || null,
      completionDate: itemCompletionDateEl.value || (column === 'Completed' ? todayStr() : null),
      tasks: cleanTasks,
      tags: modalTags,
      activityLog: [],
    };
    logActivity(item, `Created in "${column}"`);
    board.columns[column].push(item);
  }

  closeModal();
  render();
  scheduleSave();
});

addTaskBtn.addEventListener('click', () => {
  modalTasks.push({ id: uid(), text: '', done: false });
  renderTaskList();
  const inputs = taskListContainerEl.querySelectorAll('input[type="text"]');
  if (inputs.length) inputs[inputs.length - 1].focus();
});

addTagBtn.addEventListener('click', () => {
  const text = newTagTextEl.value.trim();
  if (!text) {
    newTagTextEl.focus();
    return;
  }
  modalTags.push({ id: uid(), text, color: selectedTagColor });
  newTagTextEl.value = '';
  renderTagChips();
  newTagTextEl.focus();
});

newTagTextEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addTagBtn.click();
  }
});

deleteItemBtn.addEventListener('click', () => {
  const { boardId, column, id } = modalContext;
  archiveItem(boardId, column, id);
  closeModal();
});

cancelBtn.addEventListener('click', closeModal);
document.getElementById('modalCloseBtn').addEventListener('click', closeModal);

descToolbarEl.querySelectorAll('button').forEach((btn) => {
  // Prevent the editor from losing text selection when a toolbar button is pressed.
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    itemDescriptionEl.focus();
    document.execCommand(btn.dataset.cmd, false, btn.dataset.value || null);
  });
});

// Native <input type="color"> pickers steal focus/selection from the editor when opened,
// so we continuously remember the last selection made inside it and restore it just
// before applying the chosen color.
function saveDescriptionSelection() {
  const sel = window.getSelection();
  if (sel.rangeCount > 0 && itemDescriptionEl.contains(sel.anchorNode)) {
    savedDescriptionRange = sel.getRangeAt(0).cloneRange();
  }
}

function restoreDescriptionSelection() {
  if (!savedDescriptionRange) return;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(savedDescriptionRange);
}

itemDescriptionEl.addEventListener('mouseup', saveDescriptionSelection);
itemDescriptionEl.addEventListener('keyup', saveDescriptionSelection);
document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  if (sel.rangeCount > 0 && itemDescriptionEl.contains(sel.anchorNode)) {
    savedDescriptionRange = sel.getRangeAt(0).cloneRange();
  }
});

// Use CSS-based styling so foreColor/hiliteColor apply predictably across browsers.
try {
  document.execCommand('styleWithCSS', false, true);
} catch (e) {
  /* ignore if unsupported */
}

const fontColorBarEl = document.getElementById('fontColorBar');
const bgColorBarEl = document.getElementById('bgColorBar');

fontColorPickerEl.addEventListener('input', () => {
  itemDescriptionEl.focus();
  restoreDescriptionSelection();
  document.execCommand('foreColor', false, fontColorPickerEl.value);
  if (fontColorBarEl) fontColorBarEl.setAttribute('fill', fontColorPickerEl.value);
});

bgColorPickerEl.addEventListener('input', () => {
  itemDescriptionEl.focus();
  restoreDescriptionSelection();
  if (!document.execCommand('hiliteColor', false, bgColorPickerEl.value)) {
    document.execCommand('backColor', false, bgColorPickerEl.value);
  }
  if (bgColorBarEl) bgColorBarEl.setAttribute('fill', bgColorPickerEl.value);
});

// Font size: execCommand only supports legacy sizes 1-7, so we apply a placeholder
// size (7) then swap the resulting elements (a <font size="7"> tag, or — when
// styleWithCSS is active — a <span style="font-size: xxx-large">) for the exact
// pixel value the user picked.
const fontSizePickerEl = document.getElementById('fontSizePicker');
if (fontSizePickerEl) {
  fontSizePickerEl.addEventListener('mousedown', (e) => e.stopPropagation());
  fontSizePickerEl.addEventListener('change', () => {
    const size = fontSizePickerEl.value;
    if (!size) return;
    itemDescriptionEl.focus();
    restoreDescriptionSelection();
    document.execCommand('fontSize', false, '7');
    itemDescriptionEl.querySelectorAll('font[size="7"]').forEach((el) => {
      el.removeAttribute('size');
      el.style.fontSize = size;
    });
    itemDescriptionEl.querySelectorAll('span[style*="xxx-large"]').forEach((el) => {
      el.style.fontSize = size;
    });
    fontSizePickerEl.value = '';
  });
}

// === Archive ===
function archiveItem(boardId, column, id) {
  const board = getBoard(boardId);
  if (!board) return;
  const list = board.columns[column];
  const idx = list.findIndex((it) => it.id === id);
  if (idx === -1) return;
  const [item] = list.splice(idx, 1);
  logActivity(item, `Archived from "${column}"`);
  boardData.archived.push({
    id: uid(),
    boardId,
    boardName: board.name,
    column,
    item,
    archivedAt: nowIso(),
  });
  render();
  scheduleSave();
  showUndo(`Archived "${item.heading}"`, () => {
    const rec = boardData.archived[boardData.archived.length - 1];
    if (rec && rec.item.id === item.id) boardData.archived.pop();
    board.columns[column].push(item);
  });
}

function restoreArchivedItem(archiveId) {
  const idx = boardData.archived.findIndex((r) => r.id === archiveId);
  if (idx === -1) return;
  const [rec] = boardData.archived.splice(idx, 1);
  const targetBoard = getBoard(rec.boardId) || boardData.boards[0];
  const targetCol = targetBoard.columns[rec.column] ? rec.column : COLUMNS[0];
  logActivity(rec.item, `Restored to "${targetCol}"`);
  targetBoard.columns[targetCol].push(rec.item);
  archiveSelectedIds.delete(archiveId);
  renderArchiveList();
  render();
  scheduleSave();
}

function permanentlyDeleteArchived(archiveId) {
  const idx = boardData.archived.findIndex((r) => r.id === archiveId);
  if (idx === -1) return;
  const rec = boardData.archived[idx];
  if (!window.confirm(`Permanently delete "${rec.item.heading}"? This cannot be undone.`)) return;
  boardData.archived.splice(idx, 1);
  archiveSelectedIds.delete(archiveId);
  renderArchiveList();
  updateArchiveCount();
  scheduleSave();
}

function updateArchiveCount() {
  archiveCountEl.textContent = `(${boardData.archived.length + boardData.archivedBoards.length})`;
}

function renderArchiveList() {
  archiveListEl.innerHTML = '';
  archiveSelectAllEl.checked =
    boardData.archived.length > 0 && archiveSelectedIds.size === boardData.archived.length;

  if (!boardData.archived.length) {
    const empty = document.createElement('div');
    empty.className = 'archive-empty';
    empty.textContent = 'No archived items.';
    archiveListEl.appendChild(empty);
    return;
  }
  [...boardData.archived]
    .slice()
    .reverse()
    .forEach((rec) => {
      const row = document.createElement('div');
      row.className = 'archive-row';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = archiveSelectedIds.has(rec.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) archiveSelectedIds.add(rec.id);
        else archiveSelectedIds.delete(rec.id);
        archiveSelectAllEl.checked =
          boardData.archived.length > 0 && archiveSelectedIds.size === boardData.archived.length;
      });

      const info = document.createElement('div');
      info.className = 'archive-row-info';
      const heading = document.createElement('div');
      heading.className = 'archive-heading';
      heading.textContent = rec.item.heading;
      const meta = document.createElement('div');
      meta.className = 'archive-meta';
      meta.textContent = `${rec.boardName} · ${rec.column} · archived ${formatTs(rec.archivedAt)}`;
      info.appendChild(heading);
      info.appendChild(meta);

      const restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.className = 'btn btn-secondary btn-small';
      restoreBtn.textContent = 'Restore';
      restoreBtn.addEventListener('click', () => restoreArchivedItem(rec.id));

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn btn-danger btn-small';
      deleteBtn.textContent = 'Delete Forever';
      deleteBtn.addEventListener('click', () => permanentlyDeleteArchived(rec.id));

      row.appendChild(checkbox);
      row.appendChild(info);
      row.appendChild(restoreBtn);
      row.appendChild(deleteBtn);
      archiveListEl.appendChild(row);
    });
}

archiveBtn.addEventListener('click', () => {
  archiveSelectedIds.clear();
  renderArchiveList();
  renderArchivedBoardsList();
  archiveOverlay.classList.add('open');
});
closeArchiveBtn.addEventListener('click', () => archiveOverlay.classList.remove('open'));

archiveSelectAllEl.addEventListener('change', () => {
  if (archiveSelectAllEl.checked) {
    archiveSelectedIds = new Set(boardData.archived.map((r) => r.id));
  } else {
    archiveSelectedIds.clear();
  }
  renderArchiveList();
});

archiveDeleteSelectedBtn.addEventListener('click', () => {
  if (!archiveSelectedIds.size) return;
  if (
    !window.confirm(
      `Permanently delete ${archiveSelectedIds.size} selected archived item(s)? This cannot be undone.`
    )
  )
    return;
  boardData.archived = boardData.archived.filter((r) => !archiveSelectedIds.has(r.id));
  archiveSelectedIds.clear();
  renderArchiveList();
  updateArchiveCount();
  scheduleSave();
});

archiveDeleteAllBtn.addEventListener('click', () => {
  if (!boardData.archived.length) return;
  if (
    !window.confirm(
      `Permanently delete all ${boardData.archived.length} archived item(s)? This cannot be undone.`
    )
  )
    return;
  boardData.archived = [];
  archiveSelectedIds.clear();
  renderArchiveList();
  updateArchiveCount();
  scheduleSave();
});

// === Bulk select mode ===
selectModeBtn.addEventListener('click', () => {
  selectMode = !selectMode;
  selectModeBtn.classList.toggle('active', selectMode);
  selectModeBtn.textContent = selectMode ? '✕ Cancel Select' : '☑ Select';
  if (!selectMode) selectedIds.clear();
  render();
});

function updateBulkToolbar() {
  bulkToolbarEl.classList.toggle('hidden', !selectMode || selectedIds.size === 0);
  bulkSelectedCountEl.textContent = `${selectedIds.size} selected`;
}

function selectedItemsInActiveBoard() {
  const board = getBoard(activeBoardId);
  const results = [];
  if (!board) return results;
  COLUMNS.forEach((col) => {
    (board.columns[col] || []).forEach((item) => {
      if (selectedIds.has(item.id)) results.push({ column: col, item });
    });
  });
  return results;
}

bulkMoveSelectEl.addEventListener('change', () => {
  const target = bulkMoveSelectEl.value;
  bulkMoveSelectEl.value = '';
  if (!target) return;
  selectedItemsInActiveBoard().forEach(({ item }) => {
    moveItem(item.id, activeBoardId, target);
  });
  selectedIds.clear();
  updateBulkToolbar();
});

bulkArchiveBtn.addEventListener('click', () => {
  const items = selectedItemsInActiveBoard();
  items.forEach(({ column, item }) => archiveItem(activeBoardId, column, item.id));
  selectedIds.clear();
  updateBulkToolbar();
});

bulkDeleteBtn.addEventListener('click', () => {
  const items = selectedItemsInActiveBoard();
  if (!items.length) return;
  if (!window.confirm(`Permanently delete ${items.length} selected item(s)? This cannot be undone.`)) return;
  const board = getBoard(activeBoardId);
  items.forEach(({ column, item }) => {
    const list = board.columns[column];
    const idx = list.findIndex((it) => it.id === item.id);
    if (idx !== -1) list.splice(idx, 1);
  });
  selectedIds.clear();
  updateBulkToolbar();
  render();
  scheduleSave();
});

// === Quick add ===
function showQuickAdd(boardId, col, addBtn) {
  if (addBtn.nextSibling && addBtn.nextSibling.classList && addBtn.nextSibling.classList.contains('quick-add-row')) {
    return; // already open
  }
  const row = document.createElement('div');
  row.className = 'quick-add-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Item heading...';

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'quick-add-confirm';
  confirmBtn.textContent = 'Add';

  const cancelBtn2 = document.createElement('button');
  cancelBtn2.type = 'button';
  cancelBtn2.className = 'quick-add-cancel';
  cancelBtn2.textContent = '✕';

  const fullLink = document.createElement('a');
  fullLink.href = '#';
  fullLink.className = 'quick-add-full-link';
  fullLink.textContent = 'Open full editor';

  function commit() {
    const heading = input.value.trim();
    if (!heading) {
      row.remove();
      return;
    }
    const board = getBoard(boardId);
    const item = {
      id: uid(),
      heading,
      description: DESCRIPTION_TEMPLATE,
      priority: 'green',
      dueDate: null,
      completionDate: col === 'Completed' ? todayStr() : null,
      tasks: [],
      tags: [],
      activityLog: [],
    };
    logActivity(item, `Created in "${col}"`);
    board.columns[col].push(item);
    render();
    scheduleSave();
  }

  confirmBtn.addEventListener('click', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      row.remove();
    }
  });
  cancelBtn2.addEventListener('click', () => row.remove());
  fullLink.addEventListener('click', (e) => {
    e.preventDefault();
    row.remove();
    openModal(boardId, col, null);
  });

  const btnRow = document.createElement('div');
  btnRow.appendChild(confirmBtn);
  btnRow.appendChild(cancelBtn2);

  row.appendChild(input);
  row.appendChild(btnRow);
  row.appendChild(fullLink);

  addBtn.insertAdjacentElement('afterend', row);
  input.focus();
}

loadData();
