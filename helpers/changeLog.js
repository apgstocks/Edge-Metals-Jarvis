// ── helpers/changeLog.js — every change on the yard side: who, when, what, before → after ──
//
// Apsara, 2026-11-20: "For each and every operation, we need to have audit log right?" — then, asked how wide:
// "Yard first", and who may read it: "Manager only".
//
// WHAT WAS ALREADY HERE, AND WHY THIS IS A THIRD FILE RATHER THAN A CHANGE TO EITHER
// ----------------------------------------------------------------------------------
//   helpers/audit.js     the privileged log — ~30 dangerous actions (deleting a paid load, walking past a lock),
//                        written BEFORE the act and strict. Untouched: it is evidence and works.
//   helpers/auditlog.js  Jarvis's own decisions on WhatsApp and email. Untouched.
// Neither saw an ordinary edit. A load's price changed from 0.32 to 0.23 left no trace anywhere. This file is that
// trace, for EVERY write on the yard side (helpers/changeLogMiddleware.js decides which requests count).
//
// THE ONE RULE: LOGGING NEVER BLOCKS OR FAILS A SAVE
// --------------------------------------------------
// Entries are written after the response has gone (res 'finish'), and every write is inside try/catch. A full disk
// or a bad path costs a log line and a console error, never her save. That is deliberately the OPPOSITE posture to
// helpers/audit.js, which is strict because it guards a handful of destructive acts; this one sees every write, and
// a log that can stop the yard working would be switched off within a week.
//
// APPEND-ONLY, NOTHING HERE DELETES OR TRIMS
// ------------------------------------------
// One JSON line per change, one file per month (data/change-log/YYYY-MM.jsonl). No remove, no retention window: a
// log the manager can prune is a draft, not a record. Growth is a few MB a year at yard volume.
//
// WHAT IS NEVER WRITTEN: passwords, PINs, tokens, session ids, and file contents (signatures, photos, PDFs are
// base64 in request bodies). See scrub() — a key that looks like any of those becomes '[hidden]', a data: URL becomes
// '[file]', and any long string is cut to its first 120 characters.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('../config');

const dir = () => process.env.CHANGE_LOG_DIR || path.join(cfg.DATA_DIR, 'change-log');
let failures = 0;                                     // how many lines could not be written since the server started

// Months are LA calendar months, like every other date the yard sees (helpers/time.js).
function monthOf(d) {
    try {
        const la = require('./time').getLADate(d);
        return `${la.getFullYear()}-${String(la.getMonth() + 1).padStart(2, '0')}`;
    } catch (e) { return new Date(d || Date.now()).toISOString().slice(0, 7); }
}

const SECRET_KEY = /pass(word)?|^pin$|_pin$|token|secret|^sid$|otp|signature|image|photo|base64|data_?url|pdf_?data|file_?data|^file$|^blob$/i;
function scrub(v, depth = 0) {
    if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'string') {
        if (/^data:[a-z]+\//i.test(v)) return '[file]';
        return v.length > 300 ? `${v.slice(0, 120)}… (${v.length} chars)` : v;
    }
    if (depth > 6) return '[…]';
    if (Array.isArray(v)) {
        const out = v.slice(0, 60).map((x) => scrub(x, depth + 1));
        if (v.length > 60) out.push(`… ${v.length - 60} more`);
        return out;
    }
    if (typeof v === 'object') {
        const out = {};
        for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? '[hidden]' : scrub(x, depth + 1);
        return out;
    }
    return String(v);
}

// before → after, field by field. Arrays of records are matched on their id when they have one (a load's payments),
// otherwise by position (a load's item lines, which carry no id). Capped: a renamed item touching hundreds of rows
// records the first 200 changes and says how many more there were.
function flat(v, prefix, out, depth) {
    if (v !== null && typeof v === 'object' && depth < 5) {
        if (Array.isArray(v)) {
            const byId = v.length && v.every((x) => x && typeof x === 'object' && x.id != null);
            v.forEach((x, i) => flat(x, `${prefix}[${byId ? x.id : i + 1}]`, out, depth + 1));
            if (!v.length) out[prefix] = '(none)';
        } else {
            const keys = Object.keys(v);
            if (!keys.length && prefix) out[prefix] = '(empty)';
            for (const k of keys) flat(v[k], prefix ? `${prefix}.${k}` : k, out, depth + 1);
        }
    } else if (prefix) out[prefix] = v;
    return out;
}
function diff(before, after, cap = 200) {
    const a = flat(scrub(before) ?? {}, '', {}, 0), b = flat(scrub(after) ?? {}, '', {}, 0);
    const changes = [];
    let more = 0;
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (/(^|\.)(updated_at|updatedAt|modified_at)$/.test(k)) continue;     // bookkeeping, not a change she made
        const x = k in a ? a[k] : null, y = k in b ? b[k] : null;
        if (JSON.stringify(x) === JSON.stringify(y)) continue;
        if (changes.length < cap) changes.push({ field: k, from: x, to: y }); else more++;
    }
    if (more) changes.push({ field: '…', from: null, to: `${more} more changes not listed` });
    return changes;
}

// Never throws. Returns the entry written, or null.
function record(e) {
    try {
        const at = new Date();
        const entry = { id: crypto.randomBytes(5).toString('hex'), at: at.toISOString(), company: 'Edge Yard', ...e };
        if (entry.request !== undefined) entry.request = scrub(entry.request);
        if (entry.result !== undefined) entry.result = scrub(entry.result);
        if (entry.before !== undefined) entry.before = scrub(entry.before);
        if (entry.after !== undefined) entry.after = scrub(entry.after);
        fs.mkdirSync(dir(), { recursive: true });
        fs.appendFileSync(path.join(dir(), `${monthOf(at)}.jsonl`), JSON.stringify(entry) + '\n', 'utf8');
        return entry;
    } catch (err) {
        failures++;
        console.error('[CHANGE-LOG] could not write an entry — the save itself went through:', err.message);
        return null;
    }
}

// Newest first. Filters: from/to (YYYY-MM-DD, LA days), actor, subject (exact, case-insensitive), action, q (any
// text in the entry). A malformed line is skipped and counted, never fatal — the rest of the month still reads.
function list({ from, to, actor, subject, action, q, limit = 200, offset = 0 } = {}) {
    let files = [];
    try { files = fs.readdirSync(dir()).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort().reverse(); } catch (e) { /* no log yet */ }
    if (from) files = files.filter((f) => f.slice(0, 7) >= String(from).slice(0, 7));
    if (to) files = files.filter((f) => f.slice(0, 7) <= String(to).slice(0, 7));
    const lc = (s) => String(s || '').toLowerCase();
    const dayOf = (iso) => { try { const d = require('./time').getLADate(new Date(iso)); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; } catch (e) { return String(iso).slice(0, 10); } };
    const rows = []; let bad = 0; let total = 0;
    for (const f of files) {
        let lines = [];
        try { lines = fs.readFileSync(path.join(dir(), f), 'utf8').split('\n'); } catch (e) { continue; }
        for (let i = lines.length - 1; i >= 0; i--) {
            if (!lines[i].trim()) continue;
            let r; try { r = JSON.parse(lines[i]); } catch (e) { bad++; continue; }
            const day = dayOf(r.at);
            if (from && day < from) continue;
            if (to && day > to) continue;
            if (actor && lc(r.actor) !== lc(actor)) continue;
            if (subject && lc(r.subject) !== lc(subject)) continue;
            if (action && lc(r.action) !== lc(action)) continue;
            if (q && !lc(JSON.stringify(r)).includes(lc(q))) continue;
            total++;
            if (total > offset && rows.length < limit) rows.push(r);
        }
    }
    return { rows, total, skipped_lines: bad, write_failures: failures };
}

module.exports = { record, list, diff, scrub, dir };
