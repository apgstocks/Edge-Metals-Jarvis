// ── helpers/yardClaims.js — a claim against a load the yard BOUGHT ────────
// Apsara, 2026-10-01, asked how the yard handles a claim and then specified
// it:
//
//   "or if he clicks claim,ask him to select the load.if payment is already
//    made for that load-track separately.however put it in load track that
//    paid so n so.claim made on date so n so.remind user abut the claim every
//    day.if load payment not already made,ask user whether it can be adjusted
//    in load invoice?"
//
// ── WHY THIS IS NOT helpers/claims.js ─────────────────────────────────────
// There is already a claims register, and it is a different animal. It keys
// on keyOf(invoice_no, container_no) — an EXPORT document and a container —
// carries Edge Metals' claim kinds, and moves through unverified → verified →
// recovery_raised because a claim there is raised against an overseas buyer
// and chased through paperwork.
//
// A yard claim is against a local supplier who sold us a load and whom she
// sees weekly. It keys on a LOAD. It is usually settled by paying him less,
// not by raising a recovery. Folding the two into one file would mean a
// record whose key is sometimes a container and sometimes a load id, and
// every reader guessing which. Separate store, and rule 5's instinct — Edge
// Yard and Edge Metals are different companies — applies to their paperwork
// too.
//
// ── THE PIVOT IS WHETHER THE MONEY HAS GONE ───────────────────────────────
// Her design, and it is the right one: you cannot deduct from money already
// paid. So the branch is not a setting, it is a fact about the load.
//
//   nothing paid yet   → offer to adjust it into what he is owed
//   fully paid         → track it separately and chase it
//   PARTLY paid        → she decides, per claim (her answer, 2026-10-01:
//                        "Ask me each time")
//
// That third case is why this file computes an OFFER rather than applying a
// rule. adjustable() returns the figures and says what is possible; nothing
// here decides for her.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');
const { round2 } = require('./money');

const toNum = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/[$,\s]/g, ''));
    return isFinite(n) ? n : null;
};

// ── STATUSES, AND WHY THERE ARE ONLY THESE ────────────────────────────────
// Deliberately NOT the export register's four. A yard claim has two real
// resting places and one terminal one:
//
//   open      raised, not settled. This is what the daily reminder counts.
//   adjusted  taken off what he is owed. Settled by arithmetic — the load's
//             claim_amount carries it and the ticket prints it.
//   recovered he paid it back, or credited it. Settled by money arriving.
//   dropped   she decided not to pursue it. Settled by a decision, and kept
//             rather than deleted so "how often do we drop claims against
//             this supplier" stays answerable.
//
// 'adjusted' and 'recovered' are distinct on purpose. Both are settled, but
// one means she kept her money and the other means he returned it, and the
// spend report reads those differently.
const STATUSES = ['open', 'adjusted', 'recovered', 'dropped'];
const OPEN = 'open';
const SETTLED = new Set(['adjusted', 'recovered', 'dropped']);

const list = () => {
    const raw = loadJson(cfg.YARD_CLAIMS_FILE, []);
    return Array.isArray(raw) ? raw : [];
};

const forLoad = (loadId) => {
    const id = String(loadId || '').trim();
    if (!id) return [];
    return list().filter((c) => c && String(c.load_id || '').trim() === id);
};

const openClaims = () => list().filter((c) => c && !SETTLED.has(c.status));

// How much of a load is claimed and NOT settled. This is the figure that
// matters to a balance: a recovered or dropped claim no longer reduces
// anything, and an adjusted one is already inside net_payable, so counting it
// here too would deduct it twice.
function openAmountForLoad(loadId) {
    return round2(forLoad(loadId)
        .filter((c) => !SETTLED.has(c.status))
        .reduce((a, c) => a + (toNum(c.amount) || 0), 0)) || 0;
}

// ── WHAT CAN BE DONE WITH THIS CLAIM, FROM THE LEDGER ─────────────────────
// Returns the figures and the possibilities. Decides nothing — her answer to
// the partly-paid case was "Ask me each time", so the choosing happens in
// front of her with these numbers on screen.
//
// `paid` and `payable` are passed IN rather than read here, because the
// callers already hold them (payments.paymentSummary, loads.payableOf) and
// re-deriving them in a second place is how two figures for one question
// appear. This file does arithmetic on what it is given.
function adjustable({ payable, paid, claimAmount }) {
    const owed = toNum(payable);
    const already = toNum(paid) || 0;
    const claim = toNum(claimAmount) || 0;
    if (owed === null) {
        // A load with no price has no balance to work against. Saying
        // "nothing can be adjusted" would be a guess dressed as a fact.
        return {
            state: 'unpriced', outstanding: null, claim,
            can_adjust: 0, adjustable_now: 0, must_track: claim,
            why: 'this load has no price yet, so there is nothing to deduct a claim from',
        };
    }
    const outstanding = round2(owed - already);
    // Capped at the claim AND at what is still outstanding, and never
    // negative: an overpaid load (outstanding < 0) cannot absorb anything.
    const canAdjust = round2(Math.max(0, Math.min(claim, Math.max(0, outstanding)))) || 0;
    const state = already <= 0.004 ? 'unpaid'
        : (outstanding <= 0.004 ? 'paid' : 'partly_paid');
    return {
        state,
        outstanding,
        claim,
        // What the arithmetic allows.
        can_adjust: canAdjust,
        // Her rule, as a suggestion only:
        //   unpaid      → offer the whole claim as an adjustment
        //   paid        → nothing to adjust, it is tracked
        //   partly paid → she chooses, so this is what WOULD be offered
        adjustable_now: state === 'paid' ? 0 : canAdjust,
        must_track: round2(Math.max(0, claim - canAdjust)) || 0,
        why: state === 'paid'
            ? 'this load is already paid, so a claim against it has to be chased separately'
            : (state === 'unpaid'
                ? 'nothing has been paid yet, so the claim can come off what he is owed'
                : 'part of this load is already paid — you decide how much comes off the rest'),
    };
}

async function raise(input = {}) {
    const loadId = String(input.load_id || '').trim();
    if (!loadId) throw new Error('a claim needs the load it is against');
    const amount = round2(toNum(input.amount));
    if (amount === null) throw new Error('how much is the claim?');
    if (amount <= 0) throw new Error('a claim amount must be greater than zero');
    // The reason is REQUIRED, unlike most optional notes in this codebase.
    // A claim is a thing she will be arguing about with a supplier in a
    // fortnight, and "claim $400" with no reason is unusable then. It is the
    // one field that cannot be reconstructed later.
    const reason = String(input.reason || '').trim();
    if (!reason) throw new Error('what is the claim for? (short reason, e.g. "20% dirt in the Al combo")');

    const record = {
        id: `YCLM_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        load_id: loadId,
        seller: String(input.seller || '').trim() || null,
        amount,
        reason,
        // Her words: "claim made on date so n so". Defaults to the yard's
        // local day, not UTC — an evening claim must not be stamped tomorrow,
        // the same rule every other date in this app follows.
        raised_on: /^\d{4}-\d{2}-\d{2}$/.test(String(input.raised_on || ''))
            ? input.raised_on : require('./time').todayLocal(),
        status: OPEN,
        // Filled when it stops being open, so the register answers "how long
        // was this outstanding" without a second store.
        settled_on: null,
        settled_how: null,
        settled_note: null,
        created_at: new Date().toISOString(),
        created_by: input.created_by || null,
        client_request_id: require('./oncePerSave').normTicket(input.client_request_id),
    };

    let already = null;
    await mutateJson(cfg.YARD_CLAIMS_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        // Same one-save-one-record guard as the load and prepayment paths. A
        // double-tap here does not move money, but two $400 claims on one
        // load is an argument with a supplier that she loses.
        already = require('./oncePerSave').findSpent(rows, record.client_request_id);
        if (already) return rows;
        rows.push(record);
        return rows;
    }, { strict: true });
    return already || record;
}

// Settling is its own call rather than a patch, because each way of settling
// means something different downstream and the reason has to be recorded.
async function settle(id, { how, note, on, by } = {}) {
    const claimId = String(id || '').trim();
    if (!claimId) throw new Error('which claim?');
    if (!SETTLED.has(how)) {
        throw new Error(`a claim is settled as ${[...SETTLED].join(', ')}`);
    }
    let out = null;
    await mutateJson(cfg.YARD_CLAIMS_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        const c = rows.find((x) => x && x.id === claimId);
        if (!c) return rows;
        // Settling an already-settled claim is refused rather than silently
        // restamped: it would move the settled_on date and make "how long was
        // this open" wrong, which is the only thing the register is for.
        if (SETTLED.has(c.status)) { out = { already: true, claim: c }; return rows; }
        c.status = how;
        c.settled_on = /^\d{4}-\d{2}-\d{2}$/.test(String(on || '')) ? on : require('./time').todayLocal();
        c.settled_how = how;
        c.settled_note = String(note || '').trim() || null;
        c.settled_by = by || null;
        out = { already: false, claim: c };
        return rows;
    }, { strict: true });
    if (!out) throw new Error('no such claim');
    if (out.already) throw new Error('that claim is already settled');
    return out.claim;
}

// ── WHAT THE DAILY REMINDER READS ─────────────────────────────────────────
// Her words: "remind user abut the claim every day". It rides on the 6:30am
// sweep she already gets (scheduler.js, helpers/integritySweepJob.js), which
// is SILENT WHEN CLEAN — so no open claims means no new noise, and a claim
// she has settled stops reminding her by itself rather than needing to be
// dismissed.
//
// Age is the point. "A claim is open" is not news on day one; "this has been
// open 34 days" is.
function openForReminder({ now = Date.now() } = {}) {
    const days = (d) => {
        const t = Date.parse(`${d}T12:00:00`);
        return isFinite(t) ? Math.max(0, Math.floor((now - t) / 86400000)) : null;
    };
    return openClaims()
        .map((c) => ({
            id: c.id, load_id: c.load_id, seller: c.seller,
            amount: round2(toNum(c.amount) || 0), reason: c.reason,
            raised_on: c.raised_on, age_days: days(c.raised_on),
        }))
        // Oldest first: the one that has been ignored longest is the one she
        // needs to see at the top.
        .sort((a, b) => (b.age_days || 0) - (a.age_days || 0));
}

module.exports = {
    STATUSES, OPEN, SETTLED,
    list, forLoad, openClaims, openAmountForLoad,
    adjustable, raise, settle, openForReminder,
};
