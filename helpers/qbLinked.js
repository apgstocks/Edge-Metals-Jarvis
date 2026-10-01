// ── helpers/qbLinked.js — is this Jarvis row already in QuickBooks? ───────
// Apsara, 2026-10-01: "Assign one agent for quickbook next" and "so
// (bills+invoice) agent should talk to this agent".
//
// This is the first half of that conversation, and it exists because the
// ledger agent shipped without it — a real defect, not a missing nicety.
//
// ── WHAT GOES WRONG WITHOUT IT ────────────────────────────────────────────
// The 07:30 ledger agent fills blanks in bills and sales from her sheet,
// unwatched. A bill it fills may ALREADY have been pushed to QuickBooks by
// the nightly QB run — and QuickBooks is not re-pushed for an edit. So:
//
//   23:15  sheet sync fills nothing (blank is not a disagreement)
//   00:00  QB run pushes the bill as it stands
//   07:30  ledger agent fills seal_no / supplier / date from the sheet
//          → Jarvis now says one thing, her books say another, nobody is
//            told, and the next person to reconcile finds a difference with
//            no record of who made it.
//
// Her whole instruction for the agent was "keep things perfect and neat" and
// "ensure that there is no discrepancy". An agent that silently MAKES one is
// worse than no agent.
//
// ── SO A LINKED ROW IS NEVER AUTO-FILLED ──────────────────────────────────
// It is PROPOSED instead, with the reason said out loud. She then decides
// whether to change it in both books or leave it. The agent never un-links,
// never re-pushes, and never edits a QuickBooks record — this file is
// READ-ONLY and talks to no network.
//
// ── READ-ONLY, AND OFFLINE ────────────────────────────────────────────────
// journal.active() reads the local append-only journal: the last
// created/linked entry per linkKey with no later undone/unlinked. No QB API
// call, so this is safe at 07:30 whether or not her token is fresh, and it
// cannot fail the agent's run because of a network hiccup.
//
// journal.discrepancies() DOES call QuickBooks. It is deliberately not used
// here. "Is it linked" is a local fact; "does it still agree" is a question
// for the QB agent, which has a token and an error path for it.

const push = require('./quickbooks/push');

// ── THE KEY, BUILT THE SAME WAY PUSH BUILDS IT ───────────────────────────
// push.js:63  linkKey = `${env}:${kind}:${jarvisId}`  with jarvisId being
// `b.id || b.container_no` — so a row pushed before it had an id is linked
// by its container instead. BOTH are checked, because checking only the id
// would report an older container-linked bill as unlinked and auto-fill it,
// which is the exact failure this file exists to prevent.
//
// push.linkKey is imported rather than re-implemented. If that format
// changes, this moves with it instead of silently matching nothing — the
// mistake the sheet source made this morning with `rep.differing`.

const norm = (v) => String(v == null ? '' : v).trim();

// kind strings are QuickBooks-side, from journal.QB_TYPE: 'bill' | 'sale' |
// 'billpayment' | 'receipt' | 'prepayment'. The ledger agent deals in
// 'bills' and 'sales' (the stores), so both spellings are accepted.
const KIND_FOR = { bills: 'bill', bill: 'bill', sales: 'sale', sale: 'sale' };

// A map of every linkKey currently live, built once per run. Built once
// because the ledger agent asks this per finding, and a day with forty
// findings would otherwise re-read and re-fold the whole journal forty
// times.
function liveKeys({ env, journal } = {}) {
    const j = journal || require('./quickbooks/journal');
    const e = env || require('./quickbooks/auth').qbEnv();
    const set = new Set();
    for (const entry of j.active(e)) if (entry && entry.linkKey) set.add(entry.linkKey);
    return { env: e, set };
}

// ── THE QUESTION, FOR ONE ROW ─────────────────────────────────────────────
// Returns { linked, by } — `by` says WHICH key matched, because "linked by
// container" and "linked by id" mean different things when she goes looking
// in QuickBooks for the record.
//
// NEVER THROWS. A missing journal file, an unset env, an auth module that
// cannot resolve a realm — none of those mean "not in QuickBooks", they mean
// "cannot tell". And "cannot tell" must not read as "safe to overwrite", so
// an error returns linked: true with why: 'could not check'. Failing closed
// is the only safe direction here: the cost of a false positive is that she
// is asked about a fill she would have waved through, and the cost of a
// false negative is two sets of books quietly disagreeing.
function linkedRow(row, { kind, keys } = {}) {
    const k = KIND_FOR[norm(kind).toLowerCase()];
    if (!k) return { linked: false, by: null, why: `not a QuickBooks kind: ${kind}` };
    try {
        const live = keys || liveKeys();
        const ids = [row && row.id, row && row.container_no].map(norm).filter(Boolean);
        for (const id of ids) {
            const key = push.linkKey(live.env, k, id);
            if (live.set.has(key)) {
                return {
                    linked: true,
                    by: id === norm(row && row.id) ? 'id' : 'container',
                    key,
                    why: `already in QuickBooks (linked by ${id === norm(row && row.id) ? 'row id' : 'container'} ${id})`,
                };
            }
        }
        return { linked: false, by: null, why: null };
    } catch (e) {
        return {
            linked: true,
            by: null,
            why: `could not check QuickBooks (${String((e && e.message) || e).slice(0, 120)}) — treated as linked so nothing is changed behind your books`,
        };
    }
}

module.exports = { liveKeys, linkedRow, KIND_FOR };
