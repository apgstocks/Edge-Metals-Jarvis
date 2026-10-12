// ── helpers/bankRelink.js — the same transaction, a new Plaid id ─────────
//
// Apsara, 2026-10-12: "all the transactions from plaid is from 2026-07-14 to
// 2026-10-09.why not 2026 datas are sent?" then "I have already pulled the
// transaction but".
//
// The window was 90 days because days_requested was never set, and Plaid
// does not let that be changed on an existing Item — the only way to widen
// it is to remove the Item and link the bank again. This file exists because
// doing that NAIVELY would have been worse than the problem.
//
// ── WHAT GOES WRONG WITHOUT THIS ────────────────────────────────────────
// helpers/bankLedger.js keys every row on Plaid's transaction_id, and Plaid
// issues DIFFERENT ids for the same real transaction under a different Item.
// unlink() deliberately does not delete her stored rows — correctly, because
// a row she has already allocated must not vanish. So a re-link means every
// transaction in the overlapping window arrives as a brand new row:
//
//   · the bank ledger shows each deposit twice;
//   · the old copies keep her matches, categories and exclusions;
//   · the new copies arrive untouched, so the worklist fills with work she
//     has already done.
//
// account_id is reissued too, which is the part that is easy to miss:
// `bank` and `company` on a row come from looking plaid_account_id up in
// bank-accounts.json, so after a re-link those lookups are stale as well.
// That is why the natural key below does NOT use account_id.
//
// ── WHY THIS IS NOT A CHANGE TO upsert() ────────────────────────────────
// The tempting fix is to teach upsert() to match on date+amount+description
// whenever an id is unknown. That would be WRONG, and quietly so. Two
// genuine $500 cash deposits on the same day are a real thing, and if one
// arrives in today's sync and the second in tomorrow's, a natural-key merge
// folds the second into the first and SHE IS SHORT $500 with nothing saying
// so. Routine syncs must keep failing closed on the id, exactly as they do.
//
// So this is an explicit, one-shot, previewable migration instead:
//
//   plan(rows)   proposes pairings and changes NOTHING
//   apply(plan)  re-keys the EXISTING rows to their new ids
//
// Re-keying the old row rather than merging the new one into it is
// deliberate: her matches, categories, exclusions and history stay on the
// same object they were written on, and every future sync — which speaks the
// new id — then lands on that row by the ordinary path.
//
// ── PAIRING IS ONE-TO-ONE, AND THAT IS THE WHOLE SAFETY ARGUMENT ────────
// Two identical rows on the same day must pair with two fresh rows, not
// collapse into one. Every candidate is claimed by at most one fresh row and
// removed from the pool, so N existing and N fresh stay N. Anything that
// cannot be paired is REPORTED on both sides rather than guessed at.

const { mutateJson, loadJson } = require('./json');

// ── the key that survives a re-link ─────────────────────────────────────
// date + direction + amount + a normalised description. Deliberately not
// account_id (reissued), not bank or company (derived from account_id), and
// not party (Plaid's merchant enrichment is recomputed and genuinely does
// change between pulls).
//
// The date is the bank's posting date for the same underlying transaction,
// so it is compared EXACTLY. A tolerance would widen the net precisely where
// two same-amount transactions a day apart are most likely to be confused,
// which is the direction that loses money rather than the direction that
// leaves work to do.
const normDesc = (s) => String(s || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')      // banks reword punctuation freely
    .replace(/\s+/g, ' ')
    .trim();

function keyOf(row) {
    if (!row) return null;
    const amt = Number(row.amount);
    if (!Number.isFinite(amt)) return null;
    return [row.date || '', row.direction || '', amt.toFixed(2), normDesc(row.desc)].join('|');
}

// A row she has done something to. Losing one of these to a bad pairing is
// the expensive mistake, so the plan counts them separately.
const actedOn = (r) => !!(r && (r.excluded || r.category || r.matched
    || (r.history || []).length));

// ── plan — propose, and change nothing ──────────────────────────────────
// `existing` is the current store; `fresh` is what the NEW item's first sync
// produced, already normalised through bankLedger.fromPlaid. Neither is
// written.
//
// Returns pairings plus both kinds of leftover, because the leftovers are
// the interesting part:
//   · unmatched_existing — rows the new feed did not re-send. Older than the
//     new window, or a transaction the bank no longer reports. Her work on
//     them is kept either way; they simply stop being refreshed.
//   · unmatched_fresh — genuinely new rows. After a WIDER re-link most of
//     these are the older history she was missing, which is the point of the
//     exercise, so a large number here is success rather than a warning.
function plan(existing, fresh) {
    const rows = Array.isArray(existing) ? existing : [];
    const incoming = Array.isArray(fresh) ? fresh : [];

    // Pool of candidates by key. Order preserved so pairing is deterministic
    // — a plan she reviews must be the plan that applies.
    const pool = new Map();
    rows.forEach((r, i) => {
        const k = keyOf(r);
        if (!k) return;
        if (!pool.has(k)) pool.set(k, []);
        pool.get(k).push(i);
    });

    const haveId = new Set(rows.map((r) => r && r.id).filter(Boolean));
    const pairs = [], unmatchedFresh = [], alreadyKeyed = [];
    const claimed = new Set();

    for (const f of incoming) {
        if (!f || !f.id) continue;
        // Already keyed the same way — an ordinary re-sync of a row that did
        // not change item. Nothing to do and NOT a pairing; counting it as
        // one would overstate what this migration is about to touch.
        if (haveId.has(f.id)) { alreadyKeyed.push(f.id); continue; }

        const k = keyOf(f);
        const bucket = k ? (pool.get(k) || []) : [];
        // ONE-TO-ONE: take the first candidate not already claimed, and
        // claim it. Two identical existing rows therefore pair with two
        // identical fresh rows, and neither is lost.
        const idx = bucket.find((i) => !claimed.has(i));
        if (idx === undefined) { unmatchedFresh.push(f); continue; }
        claimed.add(idx);
        pairs.push({
            old_id: rows[idx].id,
            new_id: f.id,
            at: rows[idx].date,
            amount: Number(rows[idx].amount),
            direction: rows[idx].direction,
            desc: rows[idx].desc,
            // Flagged so the review can start with the rows that cost
            // something if this is wrong.
            acted_on: actedOn(rows[idx]),
            // The new account_id, so applying can refresh the stale join at
            // the same time. Reissued on re-link, which is why `bank` and
            // `company` on the old row are wrong until this runs.
            new_account_id: f.account_id || null,
            old_account_id: rows[idx].account_id || null,
        });
    }

    const unmatchedExisting = rows
        .map((r, i) => ({ r, i }))
        .filter(({ i }) => !claimed.has(i))
        .filter(({ r }) => r && r.id && !incoming.some((f) => f && f.id === r.id))
        .map(({ r }) => ({ id: r.id, at: r.date, amount: Number(r.amount),
            direction: r.direction, desc: r.desc, acted_on: actedOn(r) }));

    return {
        ok: true,
        at: new Date().toISOString(),
        counts: {
            existing: rows.length,
            fresh: incoming.length,
            pairs: pairs.length,
            pairs_acted_on: pairs.filter((p) => p.acted_on).length,
            already_keyed: alreadyKeyed.length,
            unmatched_existing: unmatchedExisting.length,
            unmatched_existing_acted_on: unmatchedExisting.filter((r) => r.acted_on).length,
            unmatched_fresh: unmatchedFresh.length,
        },
        pairs,
        unmatched_existing: unmatchedExisting,
        // Ids only: the whole row would make a plan too large to read and
        // these are about to be inserted by the ordinary ingest anyway.
        unmatched_fresh: unmatchedFresh.map((f) => ({ id: f.id, at: f.date,
            amount: Number(f.amount), direction: f.direction, desc: f.desc })),
        already_keyed: alreadyKeyed,
    };
}

// ── apply — re-key the existing rows, and nothing else ──────────────────
// One mutateJson, so it is one atomic write under the same lock as every
// other writer of this store.
//
// REFUSES A STALE PLAN. Between proposing and applying, a sync may have run
// and inserted the new ids as fresh rows. Re-keying an old row onto an id
// that now exists would produce two rows with the same id — the one thing
// the store's whole design rests on not happening. So every pairing is
// re-checked against the store as it is at write time, and a conflict stops
// the lot rather than applying half.
async function apply(file, thePlan) {
    const pairs = (thePlan && Array.isArray(thePlan.pairs)) ? thePlan.pairs : [];
    if (!pairs.length) return { ok: true, rekeyed: 0, skipped: [], note: 'nothing to re-key' };

    let result = null;
    // ── strict: true, AND IT IS NOT DECORATION ──────────────────────────
    // mutateJson CATCHES whatever the mutator throws, logs one line and
    // returns the file as it was. Every other caller in this repo wants that
    // — a failed write must not take a route down. Here it is exactly wrong:
    // the throw below IS the refusal, and swallowing it means apply()
    // returns normally and a caller cannot tell "refused, nothing written"
    // from "done". Found by the test for the stale-plan case, which saw the
    // refusal printed to the console and a success returned to it.
    await mutateJson(file, [], (all) => {
        const rows = Array.isArray(all) ? all
            : (all && Array.isArray(all.transactions) ? all.transactions : []);
        const byId = new Map(rows.map((r, i) => [r && r.id, i]));

        // Check EVERYTHING before writing ANYTHING.
        const problems = [];
        for (const p of pairs) {
            if (!byId.has(p.old_id)) { problems.push(`${p.old_id} is no longer in the store`); continue; }
            if (byId.has(p.new_id)) {
                problems.push(`${p.new_id} already exists — a sync ran since this plan was made, `
                    + 'so re-keying would create two rows with one id');
            }
        }
        if (problems.length) {
            // Thrown, not reported: this store fails loudly by design, and a
            // half-applied re-key is the state nobody could reason about.
            throw new Error('refusing to re-key: ' + problems.slice(0, 5).join('; ')
                + (problems.length > 5 ? ` (and ${problems.length - 5} more)` : '')
                + ' — make a fresh plan and review it again');
        }

        const now = new Date().toISOString();
        for (const p of pairs) {
            const row = rows[byId.get(p.old_id)];
            // Her fields are untouched: category, excluded, matched and
            // history all stay exactly as they were. That is the entire
            // point of re-keying rather than re-inserting.
            row.id = p.new_id;
            if (p.new_account_id) row.account_id = p.new_account_id;
            row.last_seen = now;
            // The old id is kept, not discarded. Months later "why does this
            // row have a different id than the statement I exported" is a
            // question someone will ask, and the answer has to be in the row.
            row.relinked = { at: now, from: p.old_id, to: p.new_id,
                ...(p.old_account_id && p.new_account_id && p.old_account_id !== p.new_account_id
                    ? { account_from: p.old_account_id, account_to: p.new_account_id } : {}) };
            row.history = (row.history || []).concat([{ at: now,
                what: 'the bank was re-linked, so Plaid issued this row a new id',
                by: 'bank re-link', from: p.old_id, to: p.new_id }]);
        }
        result = { ok: true, rekeyed: pairs.length,
            acted_on: pairs.filter((x) => x.acted_on).length };
        return rows;
    }, { strict: true });
    return result;
}

// Convenience for the script: read the store without going through
// bankLedger, so a re-link can be planned on a COPY of the file before
// anything is done to the live one.
const read = (file) => {
    const all = loadJson(file, []);
    return Array.isArray(all) ? all : (all && Array.isArray(all.transactions) ? all.transactions : []);
};

module.exports = { plan, apply, read, keyOf, normDesc };
