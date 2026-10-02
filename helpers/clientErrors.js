// ── helpers/clientErrors.js — what the phones could not do ────────────────
// Apsara, 2026-10-02, after four hours of guessing at why the app would not
// sign in on some wifi networks: "I cant afford mistakes like this when i
// sell this to many customers."
//
// The outage was not really a Caddy problem. It was a VISIBILITY problem.
// Nothing in the system could say what was failing, so the diagnosis was five
// theories in a row, four of them wrong, against a live business. With one
// customer that is a bad evening. With twenty it is unworkable: a staff
// member in another city cannot sign in, assumes the phone is at fault, and
// she never hears about it at all.
//
// So the devices report. This is the store behind that.
//
// ── IT HAS TO ACCEPT UNAUTHENTICATED WRITES ───────────────────────────────
// Not a shortcut — a requirement. A device reporting "I cannot reach the
// server" has, by definition, not signed in. There is no token to present.
// That makes this the only endpoint in Jarvis a stranger can write to, so
// every limit below is load-bearing rather than tidiness:
//
//   · every field is truncated, so a megabyte of junk becomes a few hundred
//     bytes before it touches the disk
//   · the store is capped and trimmed oldest-first, so it cannot grow until
//     the VM runs out of room — which would turn a diagnostic into an outage
//   · the route rate-limits per IP (see api.js)
//
// ── AND IT MUST NEVER CARRY A SECRET ──────────────────────────────────────
// The app sends probe results: a label, whether it worked, an HTTP status, a
// duration, the base URL it tried. It does NOT send the password, the token,
// or anything the person typed. KEEP is the whitelist that enforces that
// here as well, so a future change to the client cannot start posting fields
// this file would then faithfully write down.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

const FILE = cfg.CLIENT_ERRORS_FILE || 'client_errors.json';

// Oldest are dropped first. 500 is comfortably more than a fleet of phones
// generates in a bad week, and small enough that the file stays readable.
const KEEP = 500;

// The ONLY fields stored off a report. Anything else the client sends is
// discarded without comment.
const KEEP_TOP = ['at', 'base', 'app_version', 'platform', 'verdict'];
const KEEP_PROBE = ['label', 'ok', 'status', 'type', 'ms', 'err'];

const str = (v, max) => {
    const s = String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) : s;
};

// ── CLEANING IS THE SECURITY BOUNDARY ─────────────────────────────────────
// Everything here arrived from the open internet. It is shaped, truncated and
// whitelisted before anything is kept, and the result is what the rest of
// Jarvis sees — no caller downstream has to remember that this data is
// untrusted.
function clean(raw, { ip = null, now = new Date() } = {}) {
    const r = (raw && typeof raw === 'object') ? raw : {};
    const probes = Array.isArray(r.probes) ? r.probes.slice(0, 8) : [];

    return {
        at: now.toISOString(),
        // The device's own clock is recorded separately and never trusted as
        // the time — a phone with a wrong clock would scramble the ordering.
        device_at: str(r.at, 40) || null,
        base: str(r.base, 200) || null,
        app_version: str(r.app_version, 40) || null,
        platform: str(r.platform, 120) || null,
        verdict: str(r.verdict, 400) || null,
        // Network, not identity. Enough to say "all the failures are on one
        // connection" without keeping an address against a person.
        ip: ip ? str(ip, 60) : null,
        probes: probes.map((p) => {
            const o = (p && typeof p === 'object') ? p : {};
            return {
                label: str(o.label, 40),
                ok: o.ok === true,
                status: Number.isFinite(Number(o.status)) ? Number(o.status) : null,
                type: str(o.type, 20) || null,
                ms: Number.isFinite(Number(o.ms)) ? Math.min(Number(o.ms), 600000) : null,
                err: str(o.err, 200) || null,
            };
        }),
    };
}

async function record(raw, opts = {}) {
    const entry = clean(raw, opts);
    // A report with no probes is not a report. Refused rather than stored, so
    // the store stays things-that-happened rather than noise.
    if (!entry.probes.length) return null;
    await mutateJson(FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        rows.push(entry);
        return rows.length > KEEP ? rows.slice(rows.length - KEEP) : rows;
    }, { strict: true });
    return entry;
}

// loadJson NEVER THROWS — a torn file reads as an empty list, which is the
// honest answer for a diagnostic store rather than a crash in the digest.
const list = ({ since = null } = {}) => {
    const rows = loadJson(FILE, []);
    const all = Array.isArray(rows) ? rows : [];
    return since ? all.filter((r) => String(r.at || '') >= since) : all;
};

// ── WHAT SHE READS IN THE MORNING ─────────────────────────────────────────
// Grouped by the stage that broke, because that is the actionable axis: ten
// devices failing at "reach server" is a network story, ten failing at
// "login preflight" is a server story, and the two want different people.
function summary({ hours = 24, now = Date.now() } = {}) {
    const since = new Date(now - hours * 3600000).toISOString();
    const rows = list({ since });
    if (!rows.length) return null;

    const firstFailure = (r) => {
        const p = (r.probes || []).find((x) => !x.ok);
        return p ? p.label : 'none';
    };
    const byStage = {};
    for (const r of rows) {
        const s = firstFailure(r);
        (byStage[s] = byStage[s] || []).push(r);
    }
    // One line per connection, not per report: a phone retrying ten times is
    // one problem, and counting the retries would make it look like ten.
    const connections = new Set(rows.map((r) => r.ip || '?')).size;

    return {
        reports: rows.length,
        connections,
        since,
        stages: Object.entries(byStage)
            .map(([stage, list_]) => ({
                stage,
                reports: list_.length,
                connections: new Set(list_.map((r) => r.ip || '?')).size,
                example: list_[list_.length - 1].verdict || null,
            }))
            .sort((a, b) => b.reports - a.reports),
    };
}

// The paragraph for the morning digest. Null when nothing failed, because a
// daily "no devices failed" is a line she stops reading, and the day it
// matters she stops reading that too.
function digestText(s) {
    if (!s || !s.reports) return null;
    const L = [];
    L.push(`*${s.reports} device report${s.reports === 1 ? '' : 's'} of not reaching Jarvis* `
        + `(${s.connections} connection${s.connections === 1 ? '' : 's'}, last ${24}h)`);
    for (const st of s.stages) {
        L.push(`  ${st.reports}x failed at: ${st.stage}`);
        if (st.example) L.push(`     ${st.example}`);
    }
    L.push('  Someone could not use the app and may not have told you.');
    return L.join('\n');
}

module.exports = { record, list, summary, digestText, clean, FILE, KEEP };
