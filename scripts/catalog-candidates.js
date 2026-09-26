#!/usr/bin/env node
// ── scripts/catalog-candidates.js — what else should Jarvis be able to read ─
//
// Apsara: "Make jarvis knowledgeale of all edge metal data" and "Leave Edge
// Yard data. Except Edge Yard data everythig else."
//
// ── WHY THIS IS A REPORT AND NOT A PATCH ──────────────────────────────────
// The metals catalog holds ten tables. config.js names sixty-six JSON stores.
// Deciding which of the other fifty-six belong in front of the model needs
// two facts I do not have on a development machine: whether a store has any
// rows at all, and what its rows actually look like. This checkout's data
// folder is a fixture — suppliers has three rows, claims has none, and most
// of the candidates have no file at all. Writing catalog entries from that
// would be describing tables that may not exist in the shape I imagined, and
// a catalog that lies to the model is worse than one that is merely small.
//
// So: run this where the data is.
//
//   node scripts/catalog-candidates.js
//   node scripts/catalog-candidates.js --json=candidates.json
//
// It reads every store, skips the yard's and the plumbing, and prints what is
// there. Send me the output and the catalog entries get written from real
// columns.
//
// ── AND THE THING TO WATCH ────────────────────────────────────────────────
// helpers/data/schemaPick.js sends the WHOLE schema while a book has fewer
// than 14 tables, and starts pruning to at most 10 above that. Metals is at
// ten. Adding five crosses the line and turns pruning on for the first time
// in production — which is a real behaviour change, not a free addition. The
// report says how close each choice takes you.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));

const OUT = (process.argv.find((a) => a.startsWith('--json=')) || '').split('=')[1] || null;

// Edge Yard is a different company and she has said so more than once — its
// stores belong to Scout's book, not this one.
const YARD = /LOADS|OUTBOUND|PETTY|TRUCKER_BILLS|EXPENSES|ITEM_TYPES|PRICE_LIST|STOCK|YARD/i;
// Machinery: sessions, tokens, caches, queues. Nothing anyone asks about.
const PLUMBING = /SESSION|TOKEN|CRED|_LOG|CACHE|DRAFT|MEMORY|BRAIN|ALERT|TASK|HISTORY|EVAL|ASK_|VOICE|WAKE|BUG|SCHED|QUEUE|SEEN|STATE|PROCESSED|COUNTER|LAYOUT|VERSION|WORKFLOW|SETTINGS|TRUST|TRANSCRIPT/i;

const already = new Set(require(path.join(ROOT, 'helpers/data/dataCatalog')).TABLES.map((t) => t.name));

const stores = Object.entries(cfg)
    .filter(([k, v]) => /_FILE$/.test(k) && typeof v === 'string' && v.endsWith('.json'))
    .filter(([k]) => !YARD.test(k) && !PLUMBING.test(k))
    .map(([k, v]) => ({ key: k, file: v, name: path.basename(v, '.json') }));

const rowsOf = (file) => {
    if (!fs.existsSync(file)) return { missing: true, rows: [] };
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { return { unreadable: e.message, rows: [] }; }
    if (Array.isArray(raw)) return { rows: raw };
    // Some stores are { things: [...] } rather than a bare array.
    for (const k of Object.keys(raw || {})) if (Array.isArray(raw[k])) return { rows: raw[k], under: k };
    return { rows: [], object: true };
};

// Columns that appear on most rows, so a one-off field does not look like
// schema. Sampled rather than exhaustive: 200 rows is plenty to see a shape.
const columnsOf = (rows) => {
    const seen = new Map();
    const sample = rows.slice(0, 200);
    for (const r of sample) for (const k of Object.keys(r || {})) seen.set(k, (seen.get(k) || 0) + 1);
    return [...seen.entries()]
        .filter(([, n]) => n >= Math.max(1, Math.floor(sample.length * 0.5)))
        .sort((a, b) => b[1] - a[1])
        .map(([k]) => k);
};

const report = [];
for (const s of stores) {
    const got = rowsOf(s.file);
    report.push({
        store: s.name,
        in_catalog: already.has(s.name),
        rows: got.rows.length,
        missing: !!got.missing,
        unreadable: got.unreadable || null,
        columns: columnsOf(got.rows),
    });
}

const worth = report.filter((r) => !r.in_catalog && r.rows > 0);
const empty = report.filter((r) => !r.in_catalog && !r.rows);

console.log(`\n  EDGE METALS — what Jarvis can and cannot read`);
console.log(`  ${'─'.repeat(66)}`);
console.log(`\n  In the catalog already: ${[...already].join(', ')}`);

console.log(`\n  HAS DATA, NOT IN THE CATALOG — ${worth.length} store${worth.length === 1 ? '' : 's'}`);
if (!worth.length) console.log('    (none)');
for (const r of worth.sort((a, b) => b.rows - a.rows)) {
    console.log(`\n    ${r.store}  ·  ${r.rows} row${r.rows === 1 ? '' : 's'}`);
    console.log(`      ${r.columns.slice(0, 14).join(', ')}${r.columns.length > 14 ? ' …' : ''}`);
}

if (empty.length) {
    console.log(`\n  EMPTY OR ABSENT — nothing to describe yet`);
    console.log('    ' + empty.map((r) => r.store + (r.missing ? '' : ' (0)')).join(' · '));
}

const unreadable = report.filter((r) => r.unreadable);
if (unreadable.length) {
    console.log(`\n  UNREADABLE — worth knowing on its own`);
    for (const r of unreadable) console.log(`    ${r.store}: ${r.unreadable}`);
}

// ── THE THRESHOLD ─────────────────────────────────────────────────────────
const pick = require(path.join(ROOT, 'helpers/data/schemaPick'));
const now = already.size;
console.log(`\n  PRUNING`);
console.log(`    The metals book has ${now} tables. schemaPick sends the whole schema`);
console.log(`    below ${pick.FULL_BELOW}, and prunes to at most ${pick.MAX_TABLES} above it.`);
if (now + worth.length >= pick.FULL_BELOW) {
    console.log(`    Adding all ${worth.length} would make ${now + worth.length} — pruning turns ON for the`);
    console.log(`    first time. It fails open, but it has never run against real questions.`);
    console.log(`    tests/schema-pick.js checks every worked example keeps the tables its`);
    console.log(`    query needs; run it after adding any.`);
} else {
    console.log(`    Adding all ${worth.length} would make ${now + worth.length} — still under ${pick.FULL_BELOW}, so nothing prunes.`);
}

if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), report }, null, 2));
    console.log(`\n  Written to ${OUT}`);
}
console.log('');
