// ── helpers/bugs.js — Bugzilla: what broke, and what happened about it ─────
//
// Apsara, 2026-09-24: "create a bugzilla tab in website so that we can keep
// track of all the fixes so that we can revisit it."
//
// ── WHY IT TRACKS THE FIX AND NOT JUST THE BUG ──────────────────────────────
// Her words are "keep track of all the FIXES ... so that we can REVISIT".
// A list that deletes an item when it is fixed answers "what is broken now"
// and loses the thing she actually asked for: the ability to come back and
// check the fix held. So an item moves open → fixed → verified, and only SHE
// moves it to verified. Fixed is a claim; verified is her having seen it work.
//
// ── AND WHY DUPLICATES ARE COUNTED, NOT ADDED ───────────────────────────────
// She chose to let two things file themselves: questions Jarvis could not
// answer, and crashes. Both repeat. A tracker that files the same crash forty
// times is a tracker nobody opens again, so anything auto-filed carries a
// SIGNATURE, and a repeat bumps a count and the last-seen date on the item
// that already exists.
const cfg = require('../config');
const crypto = require('crypto');
const { loadJson, mutateJson } = require('./json');

const STATUSES = ['open', 'fixed', 'verified', 'wont_fix'];
const SEVERITIES = ['blocker', 'high', 'normal', 'low'];
const SOURCES = ['her', 'jarvis', 'auto_question', 'auto_crash'];

// Everything the app has a screen for, so an item can be found by where it
// happened rather than only by what it said.
const AREAS = ['bookings', 'bills', 'invoice', 'documents', 'loads', 'inventory', 'petty cash',
    'expenses', 'trucker bills', 'quotes', 'email', 'whatsapp', 'voice', 'bot', 'mobile app',
    'reports', 'quickbooks', 'other'];

const now = () => new Date().toISOString();
const str = (v, n = 400) => String(v === null || v === undefined ? '' : v).trim().slice(0, n);
const list = () => {
    const raw = loadJson(cfg.BUGS_FILE, []);
    return Array.isArray(raw) ? raw : [];
};
const newId = () => `BUG-${String(list().length + 1).padStart(3, '0')}-${crypto.randomBytes(2).toString('hex')}`;

function sigOf(text) {
    return crypto.createHash('sha1').update(String(text || '').toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);
}

function clean(input = {}) {
    const status = STATUSES.includes(input.status) ? input.status : 'open';
    const severity = SEVERITIES.includes(input.severity) ? input.severity : 'normal';
    const source = SOURCES.includes(input.source) ? input.source : 'her';
    return {
        title: str(input.title, 200),
        detail: str(input.detail, 2000),
        area: str(input.area, 40) || null,
        status, severity, source,
        reporter: str(input.reporter, 60) || null,
        signature: input.signature ? str(input.signature, 40) : null,
    };
}

// One item. `history` is the point of the file: who said what, when.
async function fileBug(input = {}) {
    const rec = clean(input);
    if (!rec.title) throw new Error('a bug needs a title — what went wrong, in your words');
    let saved = null;
    await mutateJson(cfg.BUGS_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        // A repeat of something already filed bumps it rather than stacking.
        if (rec.signature) {
            const hit = rows.find((b) => b && b.signature === rec.signature && b.status !== 'verified' && b.status !== 'wont_fix');
            if (hit) {
                hit.times = (hit.times || 1) + 1;
                hit.last_seen_at = now();
                hit.updated_at = now();
                saved = hit;
                return rows;
            }
        }
        const row = {
            id: `BUG-${String(rows.length + 1).padStart(3, '0')}-${crypto.randomBytes(2).toString('hex')}`,
            ...rec,
            times: 1,
            created_at: now(), updated_at: now(), last_seen_at: now(),
            fixed_at: null, verified_at: null, fix_note: null, commit: null,
            history: [{ at: now(), what: 'filed', by: rec.reporter || rec.source, note: rec.detail || null }],
        };
        rows.push(row);
        saved = row;
        return rows;
    }, { strict: true });
    return saved;
}

// Status changes carry a note, because "fixed" with no note is the thing she
// cannot revisit later.
async function update(id, patch = {}, by = null) {
    let found = null, problem = null;
    await mutateJson(cfg.BUGS_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        const b = rows.find((x) => x && x.id === id);
        if (!b) { problem = `no bug ${id}`; return rows; }
        const before = b.status;
        if (patch.status !== undefined) {
            if (!STATUSES.includes(patch.status)) { problem = `status must be one of ${STATUSES.join(', ')}`; return rows; }
            b.status = patch.status;
            if (patch.status === 'fixed') b.fixed_at = now();
            if (patch.status === 'verified') b.verified_at = now();
        }
        for (const k of ['title', 'detail', 'area', 'severity', 'fix_note', 'commit']) {
            if (patch[k] !== undefined) b[k] = str(patch[k], k === 'detail' ? 2000 : 400) || null;
        }
        b.updated_at = now();
        b.history = Array.isArray(b.history) ? b.history : [];
        b.history.push({
            at: now(), by: by || 'her',
            what: patch.status && patch.status !== before ? `${before} → ${patch.status}` : 'edited',
            note: patch.fix_note || patch.note || null,
        });
        found = b;
        return rows;
    }, { strict: true });
    if (problem) throw new Error(problem);
    return found;
}

function filter({ status = null, area = null, source = null, q = null } = {}) {
    const needle = String(q || '').toLowerCase().trim();
    return list().filter((b) => b
        && (!status || status === 'all' || b.status === status)
        && (!area || String(b.area || '').toLowerCase() === String(area).toLowerCase())
        && (!source || b.source === source)
        && (!needle || `${b.title} ${b.detail} ${b.area}`.toLowerCase().includes(needle)))
        .sort((a, z) => {
            // Open first, then by severity, then newest — the order she would
            // read them in, not the order they were typed.
            const rank = (x) => (x.status === 'open' ? 0 : x.status === 'fixed' ? 1 : 2);
            if (rank(a) !== rank(z)) return rank(a) - rank(z);
            const sev = (x) => SEVERITIES.indexOf(x.severity || 'normal');
            if (sev(a) !== sev(z)) return sev(a) - sev(z);
            return String(z.created_at || '').localeCompare(String(a.created_at || ''));
        });
}

function get(id) { return list().find((b) => b && b.id === id) || null; }

function summary() {
    const rows = list();
    const by = { open: 0, fixed: 0, verified: 0, wont_fix: 0 };
    for (const b of rows) by[b.status] = (by[b.status] || 0) + 1;
    return {
        total: rows.length, ...by,
        // What she asked for in one number: fixed but not seen working yet.
        awaiting_check: rows.filter((b) => b.status === 'fixed').length,
        auto: rows.filter((b) => b.source === 'auto_question' || b.source === 'auto_crash').length,
    };
}

// ── THE TWO THINGS THAT FILE THEMSELVES ─────────────────────────────────────
// Her choice, 2026-09-24. Both are gated so the list stays readable:
//   • a question Jarvis could not answer files only on the SECOND time it is
//     asked — one odd phrasing is not a bug, the same question twice is
//   • a crash files once per distinct error, and repeats bump the count
async function autoFileQuestion(question, { kind = 'data', times = 2 } = {}) {
    const q = str(question, 200);
    if (!q) return null;
    const signature = `q:${sigOf(q)}`;
    // Only file once it has been asked enough times to matter. The count comes
    // from the ask log, so this stays honest even across restarts.
    let asked = 0;
    try {
        const askLog = require('./data/askLog');
        asked = askLog.list().filter((r) => r && String(r.question || '').toLowerCase() === q.toLowerCase()
            && r.outcome !== 'answered' && r.outcome !== 'yard').length;
    } catch (e) { asked = times; }
    if (asked < times) return null;
    return fileBug({
        title: `Couldn't answer: "${q}"`,
        detail: `Asked ${asked} times and not answered. Fix by adding this question, with the query it should write, to EXAMPLES in helpers/data/askData.js.`,
        area: kind === 'text' ? 'email' : 'reports',
        severity: 'normal', source: 'auto_question', reporter: 'jarvis', signature,
    });
}

async function autoFileCrash(err, where) {
    const message = str((err && err.message) || err, 200);
    if (!message) return null;
    const signature = `c:${sigOf(`${where}|${message}`)}`;
    return fileBug({
        title: `${where || 'Jarvis'} broke: ${message}`,
        detail: (err && err.stack ? String(err.stack).slice(0, 1200) : ''),
        area: 'other', severity: 'high', source: 'auto_crash', reporter: 'jarvis', signature,
    });
}

module.exports = { list, filter, get, fileBug, update, summary, autoFileQuestion, autoFileCrash,
    STATUSES, SEVERITIES, SOURCES, AREAS, sigOf };
