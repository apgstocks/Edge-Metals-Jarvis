// ── helpers/quickbooks/decisions.js — what she has already answered ────────
// The difference between an agent and a cron job that nags is that the agent
// asks once. Over one week she answered the same classes of question again
// and again — Garduno's two trucking bills at one price are two hauls; one of
// her reference numbers covers two loads; the shipping line reuses the box;
// TAEWON's two records are one company. Each answer was turned into code by
// hand, by me, which does not scale past the ones I happened to be present
// for.
//
// So: her answers are stored as DECISIONS, and a finding that matches one is
// never raised again. Two kinds, and the second is the one that matters:
//
//   specific — "these two documents are not duplicates" (this pair, once)
//   standing — "Garduno's bills with the same total on one day are separate
//              hauls" (this party, this pattern, from now on)
//
// They live in qb-settings, in git, beside the name map and the hold list —
// not in a runtime folder only one machine has. That lesson cost two wrong
// answers on 2026-10-02.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = () => process.env.QB_DECISIONS_FILE
    || path.join(__dirname, '..', '..', 'qb-settings', 'qb-decisions.json');
const KEY = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// What a decision can be about. Adding one is a line here — the agent asks
// about what it can store an answer to, and nothing else.
const ABOUT = {
    duplicate: 'whether two documents are the same money twice',
    'same-party': 'whether two records are the same company',
    hold: 'a row that is not to be entered yet',
    allocation: 'which bill a payment settled',
    finding: 'a check result she has seen and dismissed',
};

function load() {
    try {
        const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
        return Array.isArray(j.decisions) ? j : { decisions: [] };
    } catch { return { decisions: [] }; }
}
function save(store) {
    const f = FILE();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
        _why: 'Answers Apsara has given. A finding that matches one of these is not raised again. Standing rules apply to a party and a pattern; specific ones to one pair of documents.',
        decisions: store.decisions,
    }, null, 2));
    fs.renameSync(tmp, f);
}

// A standing rule is keyed on the party and the pattern; a specific one on
// the things themselves, in a stable order so the same pair always matches.
function keyOf({ about, party, pattern, subjects }) {
    if (pattern) return `${about}|party:${KEY(party)}|rule:${KEY(pattern)}`;
    return `${about}|${(subjects || []).map(String).sort().join('+')}`;
}

function remember({ about, party = null, pattern = null, subjects = null, verdict, reason, by = 'apsara' }) {
    if (!ABOUT[about]) throw new Error(`a decision must be about one of: ${Object.keys(ABOUT).join(', ')}`);
    if (!verdict) throw new Error('a decision needs a verdict');
    if (!pattern && !(subjects && subjects.length)) throw new Error('a decision needs either a pattern (standing) or the subjects it is about (specific)');
    if (!reason || String(reason).trim().length < 4) throw new Error('a decision needs a reason — it is what makes it readable in a year');
    const store = load();
    const key = keyOf({ about, party, pattern, subjects });
    const existing = store.decisions.find((d) => d.key === key);
    const row = { id: existing ? existing.id : `D_${crypto.randomBytes(4).toString('hex')}`, key, about,
        party: party || null, pattern: pattern || null, subjects: subjects || null,
        verdict, reason: String(reason).trim(), by, at: new Date().toISOString(),
        standing: !!pattern };
    if (existing) Object.assign(existing, row); else store.decisions.push(row);
    save(store);
    return row;
}

function recall({ about, party = null, pattern = null, subjects = null }, store = load()) {
    const key = keyOf({ about, party, pattern, subjects });
    return store.decisions.find((d) => d.key === key) || null;
}

function forget(id) {
    const store = load();
    const before = store.decisions.length;
    store.decisions = store.decisions.filter((d) => d.id !== id);
    if (store.decisions.length === before) return null;
    save(store);
    return { forgotten: id, left: store.decisions.length };
}

function list({ about = null } = {}) {
    return load().decisions.filter((d) => !about || d.about === about)
        .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// ── IS THIS ALREADY ANSWERED ──────────────────────────────────────────────
// A finding carries the party and the documents it is about. It is silenced
// by a specific decision on those documents, or by a standing rule for that
// party and pattern. Silenced, never deleted: the agent still counts them and
// says how many she has already answered, because a rule that is quietly
// hiding a growing pile is its own problem.
function answered(finding, { about = 'duplicate', pattern = null, store = load() } = {}) {
    const subjects = finding.rows ? finding.rows.map((r) => r.id) : (finding.id ? [finding.id] : []);
    const specific = subjects.length ? recall({ about, subjects }, store) : null;
    if (specific) return specific;
    if (pattern && finding.party) {
        const standing = recall({ about, party: finding.party, pattern }, store);
        if (standing) return standing;
    }
    return null;
}

module.exports = { ABOUT, remember, recall, forget, list, answered, keyOf, FILE };
