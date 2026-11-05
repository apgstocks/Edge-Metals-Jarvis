#!/usr/bin/env node
// ── scripts/container-suppliers.js ───────────────────────────────────────
// Apsara, 2026-11-05: "One container cannot have two suppliers."
//
// Taking her at her word, any container whose claims name more than one is
// BAD DATA — a typo in a supplier name, or a claim filed against the wrong
// one. helpers/claims/report.js now refuses to build a note from such a
// container, so this finds them BEFORE she goes looking for a report and
// hits the refusal.
//
// READ ONLY. It changes nothing: it prints what disagrees and leaves the
// correcting to her, because which of the two names is right is a question
// only she can answer.
//
//   node scripts/container-suppliers.js
//   node scripts/container-suppliers.js --file path/to/claims.json
const fs = require('fs');
const path = require('path');

const argFile = (() => {
    const i = process.argv.indexOf('--file');
    return i > -1 ? process.argv[i + 1] : null;
})();

function load() {
    if (argFile) return JSON.parse(fs.readFileSync(argFile, 'utf8'));
    let cfg = {};
    try { cfg = require('../config'); } catch (e) { /* run from anywhere */ }
    const guesses = [
        cfg.CLAIMS_FILE,
        cfg.DATA_DIR && path.join(cfg.DATA_DIR, 'claims.json'),
        path.join(__dirname, '..', 'data', 'claims.json'),
    ].filter(Boolean);
    for (const g of guesses) {
        if (fs.existsSync(g)) { console.log('reading ' + g + '\n'); return JSON.parse(fs.readFileSync(g, 'utf8')); }
    }
    console.error('No claims store found. This runs where data/claims.json is (the VM), '
        + 'or point it at a copy with --file path/to/claims.json');
    process.exit(2);
}

const raw = load();
const rows = Array.isArray(raw) ? raw : (raw.claims || []);

const byContainer = new Map();
for (const c of rows) {
    const k = String((c && c.container_no) || '').trim().toUpperCase();
    if (!k) continue;
    if (!byContainer.has(k)) byContainer.set(k, new Map());
    const sup = String((c && c.supplier) || '').trim();
    if (!sup) continue;
    const m = byContainer.get(k);
    // Keyed case-insensitively so "Taewon" and "TAEWON" are not reported as
    // a disagreement — that is one supplier typed two ways, and merging
    // spellings is what the cleanup tool is for, not this.
    const key = sup.toLowerCase();
    if (!m.has(key)) m.set(key, { name: sup, claims: [] });
    m.get(key).claims.push(c);
}

const bad = [...byContainer].filter(([, m]) => m.size > 1);

console.log(`${byContainer.size} containers carry claims.`);
if (!bad.length) {
    console.log('Every one names a single supplier. Nothing to fix.');
    process.exit(0);
}

console.log(`\n${bad.length} container(s) name more than one supplier — each is a claim `
    + `filed against the wrong one, or a supplier name typed wrong:\n`);
for (const [container, m] of bad) {
    console.log('  ' + container);
    for (const { name, claims } of m.values()) {
        console.log('    ' + name + '  —  ' + claims.length + ' claim(s): '
            + claims.map((c) => `#${c.id}${c.invoice_no ? ' inv ' + c.invoice_no : ''}`
                + (c.claim_amount ? ' $' + Number(c.claim_amount).toFixed(2) : '')).join(', '));
    }
    console.log('');
}
console.log('No claim report can be built for these until one supplier is left on each.');
// A non-zero exit so a nightly sweep can notice without reading the text.
process.exit(1);
