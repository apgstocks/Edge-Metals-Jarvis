// ── helpers/scoutAttachments.js — a file (or a pasted table) given to Scout ──
//
// Apsara, 2026-11-20, after pasting 18 Metalco containers into Scout and getting "the text is cut off" three times:
// "Add an option for attachments in scout". Asked what for: record sales from it, record purchases from it, and
// just read and answer. File types: Excel / CSV, PDF, photo. Where: the website's yard assistant.
//
// WHY THE NUMBERS COME FROM HERE AND NOT FROM THE MODEL
// A spreadsheet is read by CODE, cell by cell. The model is only told which column is which; the weights a sale is
// written with are read back out of the stored table by the tool, never retyped by the model. A model copying 18
// rows of five-digit weights is exactly where a 6 becomes an 8 and nobody notices. PDFs and photos have no cells,
// so the model has to read them — those tables are marked `read_by: 'model'` and the confirm card says so.
//
// WHERE IT LIVES: in memory, per process, for two hours (PROPOSAL-style). Nothing is written to disk; an attachment
// is working material for one conversation, not a record. Restarting the server forgets them, which is fine — the
// card says "attach it again".
const crypto = require('crypto');

const TTL_MS = 2 * 60 * 60 * 1000;
const MAX_KEEP = 30;
const MAX_ROWS = 500;
const MAX_COLS = 40;
const MAX_BYTES = 12 * 1024 * 1024;
const store = new Map();

function sweep() {
    const now = Date.now();
    for (const [id, a] of store) if (now - a.created > TTL_MS) store.delete(id);
    while (store.size > MAX_KEEP) store.delete(store.keys().next().value);
}

const cellText = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

// ── text tables (CSV, TSV, a paste) ────────────────────────────────────────
function splitCsvLine(line, delim) {
    if (delim !== ',') return line.split(delim);
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
        else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur);
    return out;
}

// A paste often loses its line breaks: her 18 containers arrived as ONE line, each record starting with a date and
// a tab, glued to the previous record's last cell by a space ("14,640 10/13/2026\tEdge Yard..."). Put the breaks
// back before every "date<TAB>" that follows whitespace. A normal paste with real newlines is left alone.
function restoreRowBreaks(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length > 1) return text;
    return text.replace(/\s+(?=\d{1,2}\/\d{1,2}\/\d{2,4}\t)/g, '\n');
}

function parseDelimited(text) {
    const fixed = restoreRowBreaks(String(text || ''));
    const lines = fixed.split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return null;
    const tabs = lines.reduce((n, l) => n + (l.split('\t').length - 1), 0);
    const commas = lines.reduce((n, l) => n + (l.split(',').length - 1), 0);
    const delim = tabs >= Math.max(1, lines.length) ? '\t' : (commas >= lines.length ? ',' : null);
    if (!delim) return null;
    return lines.map((l) => splitCsvLine(l, delim).map(cellText));
}

// ── one rectangular table, header detected ────────────────────────────────
function tidy(grid, readBy) {
    let rows = (grid || []).map((r) => (Array.isArray(r) ? r : []).slice(0, MAX_COLS).map(cellText))
        .filter((r) => r.some((c) => c));
    if (!rows.length) return null;
    const width = Math.max(...rows.map((r) => r.length));
    rows = rows.map((r) => r.concat(Array(width - r.length).fill('')));
    // drop columns that are empty in every row
    const keep = [];
    for (let c = 0; c < width; c++) if (rows.some((r) => r[c])) keep.push(c);
    rows = rows.map((r) => keep.map((c) => r[c]));
    // a header row has no number-like cells at all; a data row nearly always has some
    const numberish = (s) => /^-?[\d,]+(\.\d+)?$/.test(s) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s);
    const first = rows[0];
    const isHeader = rows.length > 1 && first.every((c) => !numberish(c)) && rows.slice(1, 4).some((r) => r.some(numberish));
    let columns = isHeader ? first.map((c, i) => c || `Column ${i + 1}`) : first.map((_, i) => `Column ${i + 1}`);
    const seen = {};
    columns = columns.map((c) => { const k = c.toLowerCase(); seen[k] = (seen[k] || 0) + 1; return seen[k] > 1 ? `${c} (${seen[k]})` : c; });
    const data = (isHeader ? rows.slice(1) : rows).slice(0, MAX_ROWS);
    return { columns, rows: data, truncated: (isHeader ? rows.length - 1 : rows.length) > MAX_ROWS, read_by: readBy };
}

// ── what came with a pasted message ────────────────────────────────────────
// Splits "Hey create sale ticket for <table> customer is metalco and price is 330 /mt" into the words (the
// instruction) and the table. Returns null when there is no table in it.
function fromPastedText(text) {
    const s = String(text || '');
    if ((s.match(/\t/g) || []).length < 6) return null;
    const fixed = restoreRowBreaks(s);
    const lines = fixed.split(/\r?\n/);
    const isRow = (l) => (l.match(/\t/g) || []).length >= 3;
    const firstRow = lines.findIndex(isRow);
    if (firstRow < 0) return null;
    let lastRow = lines.length - 1; while (lastRow > firstRow && !isRow(lines[lastRow])) lastRow--;
    const before = lines.slice(0, firstRow);
    const after = lines.slice(lastRow + 1);
    const rowLines = lines.slice(firstRow, lastRow + 1).filter(isRow);
    // words glued to the front of the first row ("Hey create sale ticket for 10/13/2026...")
    const lead = rowLines[0].match(/^(.*?)(?=\d{1,2}\/\d{1,2}\/\d{2,4}\t)/);
    if (lead && lead[1].trim() && !/\t/.test(lead[1])) { before.push(lead[1]); rowLines[0] = rowLines[0].slice(lead[1].length); }
    // words glued to the end of the last cell ("31,120 customer is metalco and price is 330 /mt")
    const cells = rowLines[rowLines.length - 1].split('\t');
    const tail = cells[cells.length - 1].match(/^\s*([\d,.]+)\s+(\D.*)$/);
    if (tail) { cells[cells.length - 1] = tail[1]; after.unshift(tail[2]); rowLines[rowLines.length - 1] = cells.join('\t'); }
    const table = tidy(rowLines.map((l) => l.split('\t')), 'code');
    if (!table || table.rows.length < 1) return null;
    return { table, words: before.concat(after).join(' ').replace(/\s+/g, ' ').trim() };
}

// ── files ──────────────────────────────────────────────────────────────────
async function readXlsx(buf) {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const sheets = [];
    wb.eachSheet((ws) => {
        const grid = [];
        ws.eachRow({ includeEmpty: false }, (row) => {
            const r = [];
            row.eachCell({ includeEmpty: true }, (cell, col) => {
                let v = cell.value;
                if (v && typeof v === 'object') {
                    if (v instanceof Date) v = `${v.getUTCMonth() + 1}/${v.getUTCDate()}/${v.getUTCFullYear()}`;
                    else if (v.result !== undefined) v = v.result;                       // formula: its value
                    else if (v.richText) v = v.richText.map((t) => t.text).join('');
                    else if (v.text) v = v.text;
                }
                r[col - 1] = v;
            });
            grid.push(r);
        });
        if (grid.length) sheets.push({ name: ws.name, grid });
    });
    if (!sheets.length) throw new Error('that spreadsheet has no rows in it');
    // the biggest sheet is the one with the data; the others are named so Scout can say so
    sheets.sort((a, b) => b.grid.length - a.grid.length);
    return { grid: sheets[0].grid, sheet: sheets[0].name, otherSheets: sheets.slice(1).map((s) => s.name) };
}

async function readWithModel(buf, mime) {
    const gem = require('./gemini');
    const prompt = 'Read this document. If it contains a table (a list of loads, containers, tickets, weights), copy EVERY row '
        + 'exactly as printed, one array per row, cells in column order. Copy numbers exactly as printed — never add, '
        + 'correct, round or reorder anything, and never invent a row. If a cell is blank, use "". Also give a short plain-text '
        + 'transcript of anything else on the page. Return ONLY JSON: '
        + '{"columns": ["header 1", ...] , "rows": [["cell", ...], ...], "text": "..."}. '
        + 'If there is no table, return "columns": [] and "rows": [].';
    const model = gem.getClient().getGenerativeModel({
        model: require('../config').GEMINI_MODEL_SMART || gem.getModelName(),   // reading weights: the careful model
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
    });
    const r = await model.generateContent([{ text: prompt }, { inlineData: { mimeType: mime, data: buf.toString('base64') } }]);
    const parsed = gem.extractJson(r.response.text()) || {};
    const cols = Array.isArray(parsed.columns) ? parsed.columns : [];
    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    const table = rows.length ? tidy(cols.length ? [cols].concat(rows) : rows, 'model') : null;
    return { table, text: String(parsed.text || '').slice(0, 20000) };
}

const KIND = (name, mime) => {
    const n = String(name || '').toLowerCase(), m = String(mime || '').toLowerCase();
    if (/\.xlsx$/.test(n) || /spreadsheetml/.test(m)) return 'xlsx';
    if (/\.(csv|tsv|txt)$/.test(n) || /^text\//.test(m)) return 'text';
    if (/\.pdf$/.test(n) || m === 'application/pdf') return 'pdf';
    if (/\.(png|jpe?g|webp|heic|heif)$/.test(n) || /^image\//.test(m)) return 'image';
    if (/\.xls$/.test(n)) return 'xls';
    return null;
};

// Reads a file into { columns, rows } (and/or text). Throws a sentence a person can act on.
async function parseFile({ name, mime, buffer }) {
    if (!buffer || !buffer.length) throw new Error('the file is empty');
    if (buffer.length > MAX_BYTES) throw new Error('that file is over 12 MB — send a smaller one');
    const kind = KIND(name, mime);
    if (kind === 'xls') throw new Error('that is an old .xls file — open it and save it as .xlsx or .csv, then attach it again');
    if (!kind) throw new Error('I can read Excel (.xlsx), CSV, PDF and photos — not that kind of file');
    if (kind === 'xlsx') {
        const x = await readXlsx(buffer);
        const table = tidy(x.grid, 'code');
        return { kind, table, sheet: x.sheet, otherSheets: x.otherSheets, text: '' };
    }
    if (kind === 'text') {
        const text = buffer.toString('utf8');
        const grid = parseDelimited(text);
        return { kind, table: grid ? tidy(grid, 'code') : null, text: grid ? '' : text.slice(0, 20000) };
    }
    const mimeFor = kind === 'pdf' ? 'application/pdf' : (mime && /^image\//.test(mime) ? mime : 'image/jpeg');
    const out = await readWithModel(buffer, mimeFor);
    return { kind, table: out.table, text: out.text };
}

function save({ name, kind, table, text, sheet, otherSheets, role }) {
    sweep();
    const id = 'att_' + crypto.randomBytes(8).toString('hex');
    const a = { id, name: String(name || 'attachment').slice(0, 120), kind, table: table || null, text: text || '', sheet: sheet || null, otherSheets: otherSheets || [], role: role || null, created: Date.now() };
    store.set(id, a);
    return a;
}
function get(id) { sweep(); return store.get(String(id || '')) || null; }

function summary(a) {
    return {
        id: a.id, name: a.name, kind: a.kind,
        rows: a.table ? a.table.rows.length : 0,
        columns: a.table ? a.table.columns : [],
        truncated: !!(a.table && a.table.truncated),
        read_by: a.table ? a.table.read_by : null,
        has_text: !!a.text,
        sheet: a.sheet, other_sheets: a.otherSheets,
        preview: a.table ? a.table.rows.slice(0, 3) : [],
    };
}

// What the model is shown. Rows are numbered from 1, the way a person counts them.
function forPrompt(a, maxRows = 120) {
    const lines = [`ATTACHED FILE "${a.name}" (attachment_id ${a.id})${a.sheet ? `, sheet "${a.sheet}"` : ''}.`];
    if (a.table) {
        lines.push(`It has ${a.table.rows.length} row(s). Columns: ${a.table.columns.map((c, i) => `${i + 1}="${c}"`).join(', ')}.`);
        if (a.table.read_by === 'model') lines.push('This table was READ FROM A PDF OR PHOTO, so its numbers may contain reading errors; say so when you use them.');
        lines.push('row\t' + a.table.columns.join('\t'));
        a.table.rows.slice(0, maxRows).forEach((r, i) => lines.push(`${i + 1}\t${r.join('\t')}`));
        if (a.table.rows.length > maxRows) lines.push(`… ${a.table.rows.length - maxRows} more rows not shown here; the record tools still read every row.`);
    }
    if (a.text) lines.push('TEXT IN THE FILE:\n' + a.text.slice(0, 6000));
    return lines.join('\n');
}

// ── reading a column the model named ───────────────────────────────────────
// Accepts the header text (any case), "Column 3", or the number 3. Returns the 0-based index or -1.
function columnIndex(a, ref) {
    if (!a || !a.table || ref == null || ref === '') return -1;
    const cols = a.table.columns;
    if (typeof ref === 'number' || /^\d+$/.test(String(ref).trim())) { const n = Number(ref) - 1; return n >= 0 && n < cols.length ? n : -1; }
    const want = String(ref).trim().toLowerCase();
    const exact = cols.findIndex((c) => c.toLowerCase() === want);
    if (exact >= 0) return exact;
    const m = want.match(/^column\s*(\d+)$/);
    if (m) { const n = Number(m[1]) - 1; return n >= 0 && n < cols.length ? n : -1; }
    return -1;
}
const toNumber = (s) => { const t = String(s == null ? '' : s).replace(/[,\s$]/g, ''); if (!t) return null; const n = Number(t); return Number.isFinite(n) ? n : null; };
function toYmd(s) {
    const t = String(s || '').trim();
    let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (m) return t;
    m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`; }
    return null;
}

module.exports = { parseFile, fromPastedText, save, get, summary, forPrompt, columnIndex, toNumber, toYmd, tidy, parseDelimited, MAX_ROWS, TTL_MS, _store: store };
