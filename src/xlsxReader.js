// Minimal, dependency-free .xlsx (Office Open XML spreadsheet) reader —
// the counterpart to xlsxWriter.js. Reads back the workbook produced by
// buildXlsx() *and* files that were opened/edited/re-saved in Excel (which
// re-compresses entries with DEFLATE and uses a shared-strings table
// instead of inline strings), using only Node's built-in zlib/Buffer APIs.
//
// Usage:
//   const { parseXlsx } = require('./xlsxReader');
//   const sheets = parseXlsx(buffer); // [{ name, rows: string[][] }, ...]
const zlib = require('zlib');

// ---- Minimal ZIP reader (supports STORE + DEFLATE methods) ----
function readZipEntries(buf) {
  // Locate the End Of Central Directory record by scanning backward for its
  // signature — it's always the last record in the file, optionally followed
  // by a (rarely used) comment, so we search the trailing chunk only.
  const EOCD_SIG = 0x06054b50;
  const searchStart = Math.max(0, buf.length - 65557);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('Not a valid .xlsx (zip) file.');

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);

  const entries = {};
  let offset = centralDirOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break; // central dir signature
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    // Local header repeats name/extra lengths (sometimes with different
    // extra field content/size), so re-read them there to find the real
    // data start rather than trusting the central directory's extraLen.
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = raw; // stored, no compression
    else if (method === 8) data = zlib.inflateRawSync(raw); // deflate
    else throw new Error(`Unsupported zip compression method (${method}) in .xlsx file.`);

    entries[name] = data;
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function decodeXmlEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

// Column letters (A, B, ..., AA, ...) -> 0-indexed column number.
function colIndex(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    n = n * 26 + (letters.charCodeAt(i) - 64);
  }
  return n - 1;
}

// Parses xl/sharedStrings.xml into an array of plain-text strings, joining
// all <t> runs within each <si> (handles both plain and rich-text entries).
function parseSharedStrings(xml) {
  if (!xml) return [];
  const strings = [];
  const siRe = /<si[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let text = '';
    let tm;
    while ((tm = tRe.exec(m[1]))) text += decodeXmlEntities(tm[1]);
    strings.push(text);
  }
  return strings;
}

// Parses one worksheet XML into a rectangular string[][] using each cell's
// "r" reference (e.g. "C7") so gaps/omitted blank cells are still placed in
// the right column, and resolves shared-string / inline-string cell types.
function parseWorksheetRows(xml, sharedStrings) {
  const cellRe = /<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m;
  const cellsByRow = new Map();
  let maxCol = -1;
  while ((m = cellRe.exec(xml))) {
    const attrs = m[1];
    const inner = m[2] || '';
    const refMatch = attrs.match(/r="([A-Z]+)(\d+)"/);
    if (!refMatch) continue;
    const col = colIndex(refMatch[1]);
    const row = parseInt(refMatch[2], 10);
    const typeMatch = attrs.match(/t="([^"]+)"/);
    const type = typeMatch ? typeMatch[1] : null;

    let value = '';
    if (type === 's') {
      const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
      const idx = vMatch ? parseInt(vMatch[1], 10) : NaN;
      value = Number.isInteger(idx) ? sharedStrings[idx] || '' : '';
    } else if (type === 'inlineStr') {
      const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
      let tm;
      while ((tm = tRe.exec(inner))) value += decodeXmlEntities(tm[1]);
    } else {
      const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
      value = vMatch ? decodeXmlEntities(vMatch[1]) : '';
    }

    if (!cellsByRow.has(row)) cellsByRow.set(row, new Map());
    cellsByRow.get(row).set(col, value);
    if (col > maxCol) maxCol = col;
  }

  if (cellsByRow.size === 0) return [];
  const maxRow = Math.max(...cellsByRow.keys());
  const rows = [];
  for (let r = 1; r <= maxRow; r++) {
    const rowMap = cellsByRow.get(r);
    const row = [];
    for (let c = 0; c <= maxCol; c++) row.push(rowMap && rowMap.has(c) ? rowMap.get(c) : '');
    rows.push(row);
  }
  return rows;
}

// Parses xl/workbook.xml + its .rels to get sheet names in workbook order,
// mapped to their worksheet part paths.
function parseWorkbookSheets(workbookXml, relsXml) {
  const relTargets = {};
  const relRe = /<Relationship\s+[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>/g;
  let rm;
  while ((rm = relRe.exec(relsXml || ''))) relTargets[rm[1]] = rm[2];

  const sheets = [];
  const sheetRe = /<sheet\s+([^>]*)\/>/g;
  let sm;
  while ((sm = sheetRe.exec(workbookXml))) {
    const attrs = sm[1];
    const nameMatch = attrs.match(/name="([^"]*)"/);
    const ridMatch = attrs.match(/r:id="([^"]+)"/);
    const name = nameMatch ? decodeXmlEntities(nameMatch[1]) : 'Sheet';
    const target = ridMatch ? relTargets[ridMatch[1]] : null;
    sheets.push({ name, target });
  }
  return sheets;
}

// buffer -> [{ name, rows: string[][] }, ...] in workbook sheet order.
function parseXlsx(buffer) {
  const entries = readZipEntries(buffer);
  const readText = (name) => (entries[name] ? entries[name].toString('utf8') : null);

  const workbookXml = readText('xl/workbook.xml');
  if (!workbookXml) throw new Error('Not a valid .xlsx file (missing workbook.xml).');
  const relsXml = readText('xl/_rels/workbook.xml.rels');
  const sharedStrings = parseSharedStrings(readText('xl/sharedStrings.xml'));

  const sheetDefs = parseWorkbookSheets(workbookXml, relsXml);

  return sheetDefs.map((def, i) => {
    let target = def.target || `worksheets/sheet${i + 1}.xml`;
    target = target.replace(/^\//, '');
    const partPath = target.startsWith('xl/') ? target : `xl/${target}`;
    const xml = readText(partPath) || readText(`xl/worksheets/sheet${i + 1}.xml`);
    return { name: def.name, rows: xml ? parseWorksheetRows(xml, sharedStrings) : [] };
  });
}

module.exports = { parseXlsx };
