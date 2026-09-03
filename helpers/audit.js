// ── helpers/audit.js — what the top-level profile did ─────────────────────
//
// Apsara, 2026-09-03, asked whether a profile that can erase a paid load
// should leave a record: "yes — log every privileged action."
//
// WHY THIS EXISTS AT ALL
// ----------------------
// Every other record in this system describes something that happened in the
// yard. This one describes something that happened to the RECORDS. A Jarvis
// session can delete a load that has money against it, and when it does, the
// load, its items, its payments and its Drive folder all go. Ask afterwards
// "was there ever a load EDGE_47, and did we pay Acme 12,000 for it" and
// without this file there is nothing left to ask.
//
// APPEND-ONLY, AND NOTHING HERE DELETES
// -------------------------------------
// There is no removeEntry, no trim, no retention window. That is not an
// oversight to be tidied up later: a log the privileged profile can prune is
// not evidence, it is a draft. The file grows by a handful of rows a year in
// normal use — the whole point is that walking past a lock should be rare.
//
// It also records ATTEMPTS THAT WERE REFUSED, not just successes. A run of
// refusals against the delete guard is the shape of someone probing, and it is
// exactly what a success-only log would throw away.
//
// WRITTEN BEFORE THE ACT, NOT AFTER
// ---------------------------------
// Callers log the intent, do the thing, then stamp the outcome. Logging after
// the fact means a crash mid-delete leaves the load half-gone and no trace of
// who asked for it — the one case where the log matters most is the one it
// would miss. An entry that says "started, never finished" is information; a
// missing entry is not.
//
// STRICT WRITES
// -------------
// mutateJson defaults to strict:false and SWALLOWS errors, returning the
// unmodified data, which from the outside is indistinguishable from success.
// For a file whose only job is to be there afterwards, a silent write failure
// is the worst possible bug, so every write here is strict and the caller is
// told when it fails.

const { loadJson, mutateJson: mutateJsonRaw } = require('./json');
const cfg = require('../config');

const mutateJson = (file, dflt, fn) => mutateJsonRaw(file, dflt, fn, { strict: true });

// The locks a privileged session can walk past. Kept as a closed list so a
// typo becomes a visible 'unknown-action' row rather than a category nobody
// ever greps for.
const ACTIONS = [
    'delete-paid-load',           // a load with payments against it
    'delete-paid-trucker-bill',   // a trucker bill with payments against it
    'delete-payment',             // one payment removed from a load or bill
    'resign-paid-load',           // signature replaced after money moved
    'edit-locked-load',           // the edit-unlock prompt satisfied by this profile
];

function listEntries() {
    const rows = loadJson(cfg.AUDIT_LOG_FILE, []);
    return Array.isArray(rows) ? rows : [];
}

function nextId(rows) {
    let max = 0;
    for (const r of rows) {
        const m = /^AUD_(\d+)$/.exec((r && r.id) || '');
        if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `AUD_${String(max + 1).padStart(4, '0')}`;
}

// Records that a privileged action is ABOUT to happen. Returns the entry so
// the caller can stamp the outcome on it.
//
// `subject` is the thing acted on (a load id, a payment id). `detail` is
// whatever will be impossible to reconstruct afterwards — for a load delete
// that means the seller, the date, the amount and the payments, because in a
// few milliseconds none of them will exist anywhere else.
async function record({ action, subject, actor, role, ip, detail }) {
    const entry = {
        id: null,                       // assigned under the lock
        at: new Date().toISOString(),
        action: ACTIONS.includes(action) ? action : 'unknown-action',
        requested_action: action,       // kept verbatim even when unrecognised
        subject: subject == null ? null : String(subject),
        actor: actor || 'unknown',
        role: role || 'unknown',
        ip: ip || null,
        detail: detail == null ? null : detail,
        outcome: 'started',
    };
    await mutateJson(cfg.AUDIT_LOG_FILE, [], (rows) => {
        const list = Array.isArray(rows) ? rows : [];
        entry.id = nextId(list);
        list.push(entry);               // push, not unshift — oldest first, so
        return list;                    // the file reads as a timeline
    });
    return entry;
}

// Stamps how it ended. Never rewrites anything else on the row, and never
// removes it: a refused or failed attempt stays in the file exactly as
// visibly as a successful one.
async function complete(entry, outcome, extra) {
    if (!entry || !entry.id) return null;
    let out = null;
    await mutateJson(cfg.AUDIT_LOG_FILE, [], (rows) => {
        const list = Array.isArray(rows) ? rows : [];
        const row = list.find((r) => r && r.id === entry.id);
        if (row) {
            row.outcome = outcome;
            row.completed_at = new Date().toISOString();
            if (extra) row.result = extra;
            out = row;
        }
        return list;
    });
    return out;
}

// Convenience for the refusal path, where there is no act to follow: one row,
// finished on arrival.
async function refused({ action, subject, actor, role, ip, detail, reason }) {
    const entry = await record({ action, subject, actor, role, ip, detail });
    return complete(entry, 'refused', { reason });
}

module.exports = { ACTIONS, listEntries, record, complete, refused };
