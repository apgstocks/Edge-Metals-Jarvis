// ── helpers/data/sqlEngine.js — the thing that actually runs the query ──────
//
// Apsara, 2026-09-23: "give all data access and possible advanced rag type
// chat bot ... it should be world class".
//
// ── WHY SQL AND NOT A VECTOR SEARCH ─────────────────────────────────────────
// Her ledgers are ROWS WITH MONEY IN THEM. A vector search retrieves text that
// LOOKS like the question and lets the model add it up, which is how you get a
// total that is wrong and unfalsifiable. Every published production write-up on
// this says the same thing: the model's job is choosing the table, the filter
// and the period; the arithmetic belongs to the database. So a question becomes
// SQL, SQLite computes the number, and the rows come back with it so any answer
// can be checked. (Text — mail, documents — is the other half and gets a real
// retrieval index; that is Phase 2 and it is not this file.)
//
// ── TWO ENGINES, ONE BEHAVIOUR ──────────────────────────────────────────────
// node:sqlite ships with Node 22+ and needs nothing installed. Her VM's Node
// version is not something this code can assume, so when it is missing the same
// SQL runs through python3's sqlite3 (stdlib, no pip). Both paths execute the
// identical statement against the identical file; /healthz says which one is
// live. She said "if you want it in python - build a bridge"; this is the
// bridge, and it is the fallback rather than the default because a spawn per
// question is latency she would feel on voice.
//
// ── READ ONLY, AND NOT AS A PROMISE ─────────────────────────────────────────
// The database is a MIRROR rebuilt from her JSON ledgers, so even a successful
// write would change nothing real. On top of that the connection is opened
// read-only and helpers/data/sqlGuard.js refuses anything but one SELECT. Three
// locks, because "the model would never write a DELETE" is not a control.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

let nodeSqlite = null;
try { nodeSqlite = require('node:sqlite'); } catch (e) { nodeSqlite = null; }

const BRIDGE = path.join(__dirname, 'sqlite_bridge.py');
let pythonOk = null;
// JARVIS_SQL_ENGINE=python forces the bridge. It is how the python path gets
// tested on a machine that has node:sqlite — an untested fallback is not a
// fallback, it is a second bug waiting for the day the first one matters.
function haveNode() {
    if (String(process.env.JARVIS_SQL_ENGINE || '').toLowerCase() === 'python') return false;
    return !!(nodeSqlite && nodeSqlite.DatabaseSync);
}
function havePython() {
    if (pythonOk !== null) return pythonOk;
    try {
        const r = spawnSync('python3', ['-c', 'import sqlite3,json;print("ok")'], { encoding: 'utf8', timeout: 10000 });
        pythonOk = r.status === 0 && /ok/.test(r.stdout || '');
    } catch (e) { pythonOk = false; }
    return pythonOk;
}
function engineName() { return haveNode() ? 'node:sqlite' : (havePython() ? 'python3' : 'none'); }

const COL = (v) => (v === undefined ? null : v);
function columnsOf(rows) {
    const seen = [];
    for (const r of rows) for (const k of Object.keys(r || {})) if (!seen.includes(k)) seen.push(k);
    return seen;
}
// SQLite takes numbers, strings, null. Anything else (an array of items, a
// nested object) is stored as JSON text so it is at least searchable, never
// silently dropped.
function cell(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch (e) { return String(v); }
}

function dbDir() {
    const cfg = require('../../config');
    const d = path.join(cfg.DATA_DIR || os.tmpdir(), 'cache');
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* falls back below */ }
    return d;
}

// Builds the file from {table: rows[]}. Returns the path.
// `declared` gives each table its columns even when it has no rows yet: a
// ledger she has not started using is an EMPTY TABLE, not a missing one, or
// the first question about it dies with "no such table" instead of "none".
function buildFile(tables, signature, declared = {}) {
    const file = path.join(dbDir(), 'ledger-mirror.sqlite');
    const stamp = file + '.stamp';
    try {
        if (fs.existsSync(file) && fs.readFileSync(stamp, 'utf8') === signature) return file;
    } catch (e) { /* rebuild */ }
    for (const f of [file, file + '-journal', file + '-wal', file + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }

    const plan = Object.keys(tables).map((name) => ({
        name,
        columns: (declared[name] && declared[name].length) ? declared[name] : columnsOf(tables[name]),
        rows: tables[name],
    }));
    if (haveNode()) {
        const db = new nodeSqlite.DatabaseSync(file);
        for (const t of plan) {
            if (!t.columns.length) continue;
            db.exec(`CREATE TABLE ${t.name} (${t.columns.map((c) => `"${c}"`).join(', ')})`);
            const ins = db.prepare(`INSERT INTO ${t.name} VALUES (${t.columns.map(() => '?').join(', ')})`);
            db.exec('BEGIN');
            for (const r of t.rows) ins.run(...t.columns.map((c) => cell(COL(r[c]))));
            db.exec('COMMIT');
        }
        db.close();
    } else if (havePython()) {
        const payload = path.join(dbDir(), 'ledger-mirror.json');
        fs.writeFileSync(payload, JSON.stringify(plan.map((t) => ({
            name: t.name, columns: t.columns,
            rows: t.rows.map((r) => t.columns.map((c) => cell(COL(r[c])))),
        }))));
        const r = spawnSync('python3', [BRIDGE, 'build', file, payload], { encoding: 'utf8', timeout: 60000 });
        try { fs.unlinkSync(payload); } catch (e) {}
        if (r.status !== 0) throw new Error(`sqlite bridge build failed: ${(r.stderr || '').slice(0, 300)}`);
    } else {
        throw new Error('no SQLite engine: this Node has no node:sqlite and python3 is not available');
    }
    fs.writeFileSync(stamp, signature);
    return file;
}

// One SELECT, already checked by sqlGuard. Returns { columns, rows, ms }.
function query(file, sql, { limit = 500, timeoutMs = 15000 } = {}) {
    const t0 = Date.now();
    if (haveNode()) {
        const db = new nodeSqlite.DatabaseSync(file, { readOnly: true });
        try {
            const out = db.prepare(sql).all();
            const rows = out.slice(0, limit);
            return { columns: columnsOf(rows), rows, truncated: out.length > rows.length, ms: Date.now() - t0 };
        } finally { db.close(); }
    }
    if (!havePython()) throw new Error('no SQLite engine available');
    const r = spawnSync('python3', [BRIDGE, 'query', file, String(limit)], { input: sql, encoding: 'utf8', timeout: timeoutMs });
    // THE DATABASE'S OWN WORDS, NOT THE EXIT CODE. "no such column: suplier"
    // is what lets the planner fix its own query on the second attempt (the
    // execution-feedback step every text-to-SQL write-up says is worth ~10
    // points); "sqlite bridge failed" tells it nothing and wastes the retry.
    let parsed = null;
    try { parsed = JSON.parse(r.stdout || '{}'); } catch (e) { parsed = null; }
    if (r.status !== 0 && !(parsed && parsed.error)) {
        throw new Error((r.stderr || 'sqlite bridge failed').trim().split('\n').pop().slice(0, 300));
    }
    parsed = parsed || {};
    if (parsed.error) throw new Error(String(parsed.error).slice(0, 300));
    return { columns: parsed.columns || [], rows: parsed.rows || [], truncated: !!parsed.truncated, ms: Date.now() - t0 };
}

// ── THE TEXT SIDE ───────────────────────────────────────────────────────────
// The ledgers answer "how much"; mail and documents answer "what did they
// say". That half is a SEARCH problem, and SQLite ships the search engine:
// FTS5, with BM25 ranking — the same ranking every serious retrieval stack
// starts from, and it needs no embedding service, no vector database and no
// network. Semantic search can be layered on later (her Supabase plan has the
// embeddings); starting with BM25 means the feature works offline, costs
// nothing per question, and gives exact matches on the things that actually
// identify a document: a container number, an invoice number, a name.
function buildFts(rows, signature, { name = 'text_index' } = {}) {
    const file = path.join(dbDir(), 'text-index.sqlite');
    const stamp = file + '.stamp';
    try { if (fs.existsSync(file) && fs.readFileSync(stamp, 'utf8') === signature) return file; }
    catch (e) { /* rebuild */ }
    for (const f of [file, file + '-journal', file + '-wal', file + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
    const COLUMNS = ['kind', 'ref', 'title', 'who', 'when_at', 'body'];
    const values = rows.map((r) => COLUMNS.map((c) => (r[c] === undefined || r[c] === null ? '' : String(r[c]))));
    if (haveNode()) {
        const db = new nodeSqlite.DatabaseSync(file);
        db.exec(`CREATE VIRTUAL TABLE ${name} USING fts5(${COLUMNS.join(', ')}, tokenize = 'porter unicode61')`);
        const ins = db.prepare(`INSERT INTO ${name} VALUES (${COLUMNS.map(() => '?').join(', ')})`);
        db.exec('BEGIN');
        for (const v of values) ins.run(...v);
        db.exec('COMMIT');
        db.close();
    } else if (havePython()) {
        const payload = path.join(dbDir(), 'text-index.json');
        fs.writeFileSync(payload, JSON.stringify({ name, columns: COLUMNS, rows: values }));
        const r = spawnSync('python3', [BRIDGE, 'buildfts', file, payload], { encoding: 'utf8', timeout: 60000 });
        try { fs.unlinkSync(payload); } catch (e) {}
        if (r.status !== 0) throw new Error(`sqlite bridge fts build failed: ${(r.stderr || '').slice(0, 300)}`);
    } else {
        throw new Error('no SQLite engine: this Node has no node:sqlite and python3 is not available');
    }
    fs.writeFileSync(stamp, signature);
    return file;
}

module.exports = { buildFile, buildFts, query, engineName, haveNode, havePython };
