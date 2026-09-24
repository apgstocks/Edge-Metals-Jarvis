// ── helpers/payments.js — payments recorded against a load ─────────────────
//
// Per Apsara 2026-08-28: a Pay button beside Edit/Delete opening a form with
// payment mode (Zelle / Wire / Cash / Cheque) and an amount; anything short of
// the load total is a PARTIAL payment with a pending balance, and the result
// has to show up on the invoice.
//
// A LEDGER, not a flag. "Partial, with a pending amount" only means anything
// if a load can be settled across several payments — pay half on collection
// and the rest on Friday — so this stores each payment as its own row and
// derives paid/pending by summing them. A single paid_amount field on the load
// would lose the history the moment a second payment arrived, and the history
// is the part anyone actually argues about later.
//
// ITS OWN STORE, and here that is about money rather than tidiness. Loads are
// re-saved WHOLESALE on every edit — editLoad in helpers/loads.js rebuilds the
// record from the fields it knows about — so a payments array hanging off the
// load would be one dropped field away from erasing a receipt. That exact
// class of bug has already happened in this repo once (pdf_link was silently
// discarded by editOutboundLoad, which is why patchOutboundLoad exists).
// Keeping payments outside the load write path means correcting a weight
// cannot touch what was paid.
//
// Nothing here deletes or edits a payment's amount in place: a wrong payment
// is deleted whole and re-entered, so there is no half-edited row.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

// Kept as constants and exported so the API, both clients, the PDF and the
// yard assistant read one list rather than five drifting copies of a dropdown.
//
// ── EVERY MODE THIS FILE WILL STORE ────────────────────────────────────────
// Zelle, Wire and Cheque are still here because payments ALREADY ON FILE carry
// them and helpers/banks.js's matcher keys on Zelle/Wire. Removing them from
// this list would leave those rows naming a mode the server no longer knows.
//
// It is NOT the list the yard's pay modal offers — see modesForKind below.
const PAYMENT_MODES = ['Cash', 'Bank transfer', 'Zelle', 'Wire', 'Cheque'];

// ── WHAT THE YARD MAY RECORD, FROM TODAY ───────────────────────────────────
// Apsara, 2026-09-16, clarifying an earlier message: "whn i talked about
// receive payment-i was talking only about edge yard .. in loads,there are two
// options na..create invoice and sale..in receive payment-i should have only
// cash and bank transfer".
//
// So a YARD load — a purchase she is paying for, or a sale she is being paid
// for — takes two modes and no others. Enforced here rather than only in the
// dropdown, because "the screen offers two" and "the yard records two" are
// different promises and she asked for the second one. The yard assistant
// records payments too (helpers/tools.js) and would otherwise keep happily
// filing a Zelle nobody can choose on screen.
//
// EDGE METALS IS UNTOUCHED. Her message says Edge Yard, twice. Bills,
// settlements and metals trucking keep the full list — narrowing those would
// be me deciding something she did not ask about, on the company whose books
// this app works hardest to keep separate.
//
// SAFE FOR WHAT IS ALREADY STORED. This file has no update path — only
// addPayment and deletePayment — so a yard payment recorded as Zelle last
// month is never re-validated and keeps reading as Zelle everywhere it
// appears. The narrowing applies to new entries only, which is the whole of
// what she asked for.
// ── WIDENED AGAIN, 2026-09-23 ──────────────────────────────────────────────
// Apsara: "in receive payment,zelle,wire,cash etc should be there similar to
// loads" — then, asked which exactly: option one, "Remove just wire".
//
// So receive payment is Cash, Bank transfer, Zelle and Cheque. This REVERSES
// her 2026-09-16 narrowing quoted below. The old note is left standing word
// for word rather than rewritten: it records what she wanted in September and
// why the over-reach that followed it was mine, and editing it to agree with
// today would erase the only account of how that bug happened.
//
// WIRE IS DELIBERATELY ABSENT, and it is the one mode she named. A wire in
// and a Bank transfer in are the same movement by two names, and two names
// for one movement is two ways to answer "how did that money arrive" — the
// same reasoning that removed Bank transfer from a PURCHASE on 2026-09-17,
// pointing the other way.
//
// WHAT THIS DOES NOT TOUCH: 'Bank transfer' stays, so the "Paid to" question
// (PAID_VIA_BY_KIND below) still has a mode to fire on. Dropping it would
// have left that question unreachable and a <select> defaulting to a value
// not in its list — which is exactly how the 2026-09-17 breakage worked.
const YARD_LOAD_MODES = ['Cash', 'Bank transfer', 'Zelle', 'Cheque'];

// ── WHAT A PURCHASE MAY BE PAID BY ─────────────────────────────────────────
// Apsara, 2026-09-17: "in load of invoice pay-remove bank transfer."
//
// So paying a supplier is Cash, Zelle, Wire or Cheque. Bank transfer was a
// second name for the same thing as Wire on this side, and two names for one
// movement is two ways to answer "how did that go out".
//
// PAYMENT_MODES itself is untouched, deliberately: every purchase already
// recorded as "Bank transfer" keeps reading as Bank transfer everywhere — the
// spend report, the bank matcher, the cards. What narrows is the list of
// modes a NEW purchase payment may choose from, not the vocabulary the file
// understands. Same shape as the receive-payment restriction of 2026-09-16.
const PURCHASE_MODES = ['Cash', 'Zelle', 'Wire', 'Cheque'];

// ── RECEIVE PAYMENT, NOT EVERY YARD PAYMENT ────────────────────────────────
// Apsara, 2026-09-16: "whn i talked about receive payment-i was talking only
// about edge yard ..in loads,there are two options na..create invoice and
// sale..in receive payment-i should have only cash and bank transfer".
//
// This set held 'purchase' as well, and that was my over-reach reading "yard"
// where she wrote "receive payment". RECEIVE PAYMENT IS A SALE — money coming
// in. Paying a supplier for a load is money going OUT, a different
// transaction, and she pays those by Zelle and Wire: the bank-account picker
// exists for exactly those two modes.
//
// What it cost, live, until 2026-09-17:
//   a supplier payment by Zelle, Wire or Cheque was REFUSED outright;
//   and the modal opens by selecting 'Zelle', which was no longer among the
//   options — a <select> set to a value it does not have goes to "", so a
//   dropdown she never touched posted an EMPTY mode and the save failed.
//
// Found by running the whole test suite rather than the dozen files I had
// been naming: tests/jarvis-profile.js had been CRASHING on this since the
// day it landed.
const YARD_LOAD_KINDS = new Set(['sale']);

// The modes a given load kind accepts. One function, so the validator, the
// bot tool and anything added later cannot disagree about the answer.
function modesForKind(loadKind) {
    const k = String(loadKind || 'purchase').trim() || 'purchase';
    if (YARD_LOAD_KINDS.has(k)) return YARD_LOAD_MODES.slice();   // a sale: receive payment
    if (k === 'purchase') return PURCHASE_MODES.slice();          // paying a supplier
    return PAYMENT_MODES.slice();                                 // Edge Metals, truckers
}

// ── WHOSE MONEY PAID IT ────────────────────────────────────────────────────
// Apsara, 2026-09-17: "in pay of create invoice-on selecting wire-it should
// ask me Payment via Edge Yard/Edge Metals", and on which modes: "Wire and
// Bank Transfer".
//
// The two companies pay for each other's things. Which one's account a
// transfer actually left is a fact the bank field does not carry — "Chase
// Bank" does not say whose Chase account.
// ── AAA INVESTMENT IS THE THIRD ONE (2026-09-24) ───────────────────────────
// Apsara: "In loads pay,why wire ->Bofa ->Showing Edge Yard or Edge Metals?"
// and then "Bofa has only two accounts.Edge Metals and AAA Investment".
//
// She is right, and it was a real defect rather than a wording one. BofA holds
// Edge Metals and AAA Investment (helpers/pettyCash.js's BANK_OF has said so
// since 2026-09-21). The picker offered EDGE YARD, which is not a BofA account
// at all, and did not offer AAA INVESTMENT, which is — so a wire out of
// BofA / AAA Investment could not be recorded correctly. It had to be filed
// against one of the other two or not at all.
const PAID_VIA = ['Edge Yard', 'Edge Metals', 'AAA Investment'];

// ── AND THE ANSWER DEPENDS ON THE BANK ─────────────────────────────────────
// Which entities can own money leaving a given bank. Derived from petty cash's
// own BANK_OF rather than restated here, so the two cannot drift: adding an
// account there changes this without an edit.
//
// CHASE IS EDGE YARD'S — her answer, 2026-09-24, asked directly. So choosing
// Chase has exactly one possible owner and the screen need not ask at all.
//
// An unknown or blank bank falls back to ALL of them: this narrows a question,
// it never blocks a payment. A bank she typed under "Others" must not leave
// her unable to say whose money it was.
function paidViaOptionsFor(bank) {
    const b = String(bank == null ? '' : bank).trim();
    if (!b) return PAID_VIA.slice();
    if (/^chase/i.test(b)) return ['Edge Yard'];
    let accounts = [];
    try {
        const petty = require('./pettyCash');
        accounts = (petty.SOURCES || []).filter((s) => petty.bankOf(s) === b);
    } catch (e) { accounts = []; }
    // Petty cash names its BofA buckets exactly as the paying entities are
    // named, which is why this maps across at all. Anything it does not
    // recognise is not narrowed.
    const owners = accounts.filter((a) => PAID_VIA.includes(a));
    return owners.length ? owners : PAID_VIA.slice();
}

// ── WHICH COMBINATIONS ASK ─────────────────────────────────────────────────
// Two directions, two questions, and they are NOT the same question:
//
//   A PURCHASE pays a supplier. "Payment via" — whose money went out.
//   Apsara, 2026-09-17: "on selecting wire-it should ask me Payment via Edge
//   Yard/Edge Metals". She then removed Bank transfer from a purchase
//   entirely ("in load of invoice pay-remove bank transfer"), so Wire is the
//   only transfer left there and the only mode that asks.
//
//   A SALE receives money. "Paid to" — which company it landed in. Apsara,
//   2026-09-17: "For receive payment also,add paid to Edge Yard,Edge Metals",
//   and, asked which modes: "Bank transfer only".
//
//   CASH NEVER ASKS, on either side. Cash from a yard sale goes into Edge
//   Yard's petty cash box (her rule of 2026-09-02), so it is always the
//   yard's — asking would let her file a contradiction with her own ledger.
const PAID_VIA_BY_KIND = {
    purchase: new Set(['Wire']),
    sale: new Set(['Bank transfer']),
};

function paidViaRequired(loadKind, mode) {
    const allowed = PAID_VIA_BY_KIND[String(loadKind || '').trim()];
    return !!allowed && allowed.has(String(mode || '').trim());
}

// The two words the screen shows. A purchase sends money OUT and a sale takes
// it IN, and one label for both would be wrong on one of them.
function paidViaLabel(loadKind) {
    return String(loadKind || '').trim() === 'sale' ? 'Paid to' : 'Payment via';
}

// Returns '' when this combination does not ask. Throws when it does and she
// has not answered — her choice, over recording it as "Not recorded": a wire
// with no company against it cannot be filed.
function resolvePaidVia(loadKind, mode, value, bank) {
    const given = PAID_VIA.find((v) => v.toLowerCase() === String(value == null ? '' : value).trim().toLowerCase());
    if (!paidViaRequired(loadKind, mode)) {
        // Not asked for — but if a caller sent one anyway it is kept rather
        // than dropped, because a stated fact about the money should not
        // vanish because the form did not have a box for it.
        return given || '';
    }
    // ── NARROWED BY THE BANK (2026-09-24) ──────────────────────────────────
    // A wire out of BofA can only be Edge Metals or AAA Investment; one out of
    // Chase can only be Edge Yard. `bank` is optional so every existing caller
    // keeps working unchanged — without it the old, wider list applies, which
    // is what the voice path passed for a day before this argument existed.
    // CLAUDE.md: a new required field is a promise every caller can keep, and
    // this one cannot make that promise, so it is not required.
    const allowed = paidViaOptionsFor(bank);

    // ONE POSSIBLE OWNER IS NOT A QUESTION. Chase is Edge Yard's, so a Chase
    // wire resolves itself rather than refusing for an answer that could only
    // ever be one thing.
    if (!given && allowed.length === 1) return allowed[0];

    if (!given) {
        const where = String(loadKind || '').trim() === 'sale' ? 'a yard sale' : 'a yard purchase';
        throw new Error(`a ${mode} on ${where} needs "${paidViaLabel(loadKind)}": ${allowed.join(' or ')}`);
    }
    // A stated answer the bank cannot support is a contradiction, and filing
    // it would put "Edge Yard" against a BofA account Edge Yard does not have.
    if (!allowed.includes(given)) {
        throw new Error(`${given} has no account at ${bank} — "${paidViaLabel(loadKind)}" must be ${allowed.join(' or ')}`);
    }
    return given;
}

// ── WHOSE BOOKS A ROW BELONGS TO ─────────────────────────────────────────
// Apsara, 2026-09-10: "Always remember Edge Yard is different and Edge Metals
// is different", and, asked directly, that Edge Metals cash is separate from
// the yard's petty cash reserve.
//
// Petty cash is an EDGE YARD ledger. A payment carrying one of these kinds is
// Edge Metals and never touches it, whatever its mode. A SET rather than a
// second `!== 'bill'` test, because the third Metals kind arrived within the
// day and the fourth will not announce itself either.
const EDGE_METALS_KINDS = new Set(['bill', 'sale_cost', 'metals_trucking']);

// Money is compared to the cent. Floating point makes 4010 * 2.2 come out as
// 8822.000000000001, so a load paid exactly to the penny would otherwise
// report a pending balance of -0.000000000001 and never read as settled.
const CENT = 0.005;

const round2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);
const num0 = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const toNum = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : null;
};

const listPayments = () => {
    const raw = loadJson(cfg.PAYMENTS_FILE, []);
    return Array.isArray(raw) ? raw : [];
};

// Advances are excluded by the load_id test itself — they carry none until
// they are applied, at which point the application is its own row with a real
// load_id. So an unapplied advance can never make a load look part-paid.
const paymentsForLoad = (loadId) => listPayments()
    .filter((p) => p.load_id === loadId)
    .sort((a, b) => String(a.paid_on || a.created_at || '').localeCompare(String(b.paid_on || b.created_at || '')));

function newPaymentId() {
    return `PAY_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── Advances were REMOVED 2026-08-29, per Apsara: "remove that advance
// concept." ────────────────────────────────────────────────────────────────
//
// What used to be here: a payment scoped to a seller instead of a load, held
// as credit and applied to loads later. Gone — no addAdvance, no applyAdvance,
// no /api/advances, no UI.
//
// LEGACY ROWS ARE STILL SAFE. Any is_advance record already written to
// payments.json carries load_id: null, so paymentsForLoad's load_id filter
// simply never matches it. It cannot corrupt a balance and cannot make a load
// look part-paid — it just sits in the file, inert and invisible. Rows created
// by APPLYING an advance are ordinary payment rows with a real load_id and
// keep working exactly as before; they are indistinguishable from any other
// payment apart from an applied_from field nothing reads any more.
//
// If an unapplied advance ever needs to be recovered, it is in payments.json
// with is_advance: true — the money was never lost, only the feature.

async function addPayment(input = {}) {
    const loadId = String(input.load_id || '').trim();
    if (!loadId) throw new Error('load_id is required');
    const amount = round2(toNum(input.amount));
    // Rejected rather than stored as null: a payment with no amount cannot be
    // summed, so it would sit on the ledger looking like a receipt while
    // contributing nothing to the balance — worse than not being there.
    if (amount == null) throw new Error('a payment amount is required');
    if (amount <= 0) throw new Error('a payment amount must be greater than zero');
    // ── WHOSE BOOKS, DECIDED BEFORE THE MODE IS CHECKED ──────────────────
    // load_kind used to be resolved further down, beside the petty-cash
    // branch. It moved up here because the ALLOWED MODES now depend on it.
    const loadKind = (() => {
        const k = String(input.load_kind || '').trim();
        if (!k || k === 'purchase') return 'purchase';
        if (['sale', 'trucker', 'bill', 'sale_cost', 'metals_trucking'].includes(k)) return k;
        throw new Error(`unknown load_kind "${k}" — add it here and to helpers/spendReport.js, do not let it default`);
    })();

    const allowed = modesForKind(loadKind);
    const mode = allowed.find((m) => m.toLowerCase() === String(input.mode || '').trim().toLowerCase());
    // Names the list THAT APPLIES, not every mode this file knows. Choosing
    // Zelle on a yard load and being told "must be one of: Cash, Bank
    // transfer, Zelle, Wire, Cheque" reads as a bug in the software rather
    // than an answer.
    if (!mode) throw new Error(`payment mode must be one of: ${allowed.join(', ')}`);

    // ── WHICH ACCOUNT IT LEFT ────────────────────────────────────────────
    // Apsara, 2026-09-09: "I want to create an option for zelle,wire -->
    // options like BofA, Chase Bank, Others."
    //
    // BEFORE the petty-cash reservation below, deliberately. A bad bank must
    // fail while nothing has moved: reserving cash and then throwing would
    // leave the box short with no payment beside it, which is the exact
    // failure the reservation ordering further down was written to avoid.
    // Cash never has a bank anyway, so this costs that path nothing.
    //
    // A DISALLOWED value always throws — a bank on a cash payment is a false
    // statement, wherever it came from. A MISSING one depends on the caller:
    // require_bank is set by the API route — i.e. by the two pay FORMS, where
    // she has a dropdown in front of her. Callers that record a payment from a
    // spoken sentence leave it off; see helpers/banks.js for why the two are
    // deliberately not the same.
    const banks = require('./banks');
    const bank = await banks.resolveForMode(mode, input.bank, { required: input.require_bank === true });

    // ── WHOSE MONEY PAID THE SUPPLIER ────────────────────────────────────
    // Apsara, 2026-09-17: "in pay of create invoice-on selecting wire-it
    // should ask me Payment via Edge Yard/Edge Metals. We need to keep track
    // of this also in report", and, asked which modes: "Wire and Bank
    // Transfer".
    //
    // A yard purchase is Edge Yard's material, but the transfer that pays for
    // it does not always leave Edge Yard's account. Which company actually
    // paid is a fact about the money, and until now it was nowhere — the bank
    // says WHICH ACCOUNT, not whose company it belongs to.
    //
    // ── SCOPED EXACTLY TO WHAT SHE ASKED ─────────────────────────────────
    // "in pay of create invoice" — a yard PURCHASE. Not a sale (Bank transfer
    // is one of only two modes a sale accepts; requiring this there would make
    // receiving money harder, which she did not ask for), not the Edge Metals
    // kinds, not trucker bills. Cash and Cheque never ask: they are not
    // transfers between accounts.
    //
    // Asked which modes, she answered "Wire and Bank Transfer" — NOT Zelle,
    // though Zelle shares the bank picker. Her list, not the tidy one.
    //
    // REQUIRED, her choice over "save it as Not recorded": a wire with no
    // company against it cannot be filed. So the report has no gap in it by
    // construction, and old payments written before today simply carry
    // nothing — see helpers/spendReport.js, which buckets those visibly
    // rather than pretending they are Edge Yard.
    const paidVia = resolvePaidVia(loadKind, mode, input.paid_via, bank);

    // ── CASH COMES OUT OF THE PETTY CASH BOX ──────────────────────────────
    // Per Apsara 2026-09-02: "If i click pay in load and select cash, the
    // invoice amount should be adjusted against this."
    //
    // THE CASH IS RESERVED BEFORE THE PAYMENT IS WRITTEN, and the reservation
    // is reversed if that write fails. Two files cannot be updated atomically
    // here, so the question is which way round to fail, and the two are not
    // equally bad:
    //
    //   cash out, payment missing  -> the box shows less than it holds. Visible
    //                                 on the tab as a withdrawal with no
    //                                 payment beside it, and reversible.
    //   payment in, cash not taken -> the balance is overstated, so the NEXT
    //                                 payment is allowed to overdraw a box that
    //                                 is already empty. Nothing on screen says
    //                                 so, and the error compounds.
    //
    // So: reserve first. The reversal below closes the window in the ordinary
    // case; the ordering is what protects the case where the process dies
    // between the two writes.
    //
    // The cap is NOT applied silently. withdrawForPayment refuses when there is
    // not enough and returns `available`; the client shows that and asks; only
    // then does it come back with allow_partial. Her words: "make it as partial
    // payment and notify user" — the notification is the point, so it is a
    // precondition rather than an afterthought.
    // ── WHOSE CASH BOX, AND WHETHER THERE IS ONE ─────────────────────────
    // Apsara, 2026-09-10, asked whether an Edge Metals cash payment should
    // draw down the yard's Petty cash reserve: "No — Edge Metals cash is
    // separate."
    //
    // So petty cash stays an EDGE YARD ledger. A payment carrying
    // load_kind 'bill' is an Edge Metals supplier payment and never touches
    // it, whatever its mode. Keyed on the kind rather than on a
    // skip_petty_cash flag on purpose: a flag is one spread of req.body away
    // from letting a client silently pay a yard load in cash without the box
    // moving, and this rule is about which company's books a row belongs to,
    // which load_kind already answers.
    //
    // It is resolved ABOVE, next to the mode check, because since 2026-09-16
    // the allowed MODES depend on it too — a yard load takes Cash or Bank
    // transfer, Edge Metals still takes the full list. One resolution feeding
    // both, so the mode check and the cash branch cannot disagree about which
    // company this row belongs to.
    // ── WHICH WAY THE CASH IS MOVING ─────────────────────────────────────
    // Apsara, 2026-09-16: "in sales-receive payment,mode should be cash/
    // account transfer.if its cash-it should get added to petty cash."
    //
    // It was already moving the box — in ONE direction. This branch called
    // withdrawForPayment for ANY cash payment on a yard load, and a yard load
    // can be a SALE. So money arriving was recorded as money leaving: take
    // $5,000 cash for a load of aluminium and the box went DOWN five thousand.
    //
    // It rarely even failed quietly. withdrawForPayment refuses when the box
    // holds less than the amount, so a $5,000 cash sale against a $300 box
    // was rejected outright with "Only 300.00 in petty cash" — a sale she
    // could not record at all, for a reason that made no sense from where she
    // was standing. That is almost certainly what prompted the request.
    //
    // A 'sale' is the yard SELLING metal, so its cash comes IN. Everything
    // else on a yard load — a purchase, a trucker bill — is cash going OUT.
    // Decided from load_kind, the same field that already decides whose books
    // the row belongs to, rather than from a flag a client could send.
    const touchesPettyCash = mode === 'Cash' && !EDGE_METALS_KINDS.has(loadKind);
    const cashComesIn = loadKind === 'sale';

    let cashEntry = null;
    let cashTaken = null;
    if (touchesPettyCash && cashComesIn) {
        const petty = require('./pettyCash');
        // No cap and no refusal — see depositForPayment. Cash in hand cannot
        // overdraw a box, and a balance test here would be the original bug
        // wearing a new hat.
        const res = await petty.depositForPayment({
            amount,
            loadId,
            paymentId: null,                 // stamped after the payment id exists
            date: input.paid_on,
            createdBy: input.created_by || null,
            // A customer's cash came from no bank. Passed through so she CAN
            // say otherwise (banking it straight away), but left unset it
            // lands in Unassigned, which is the truth.
            cashSource: input.cash_source,
        });
        cashEntry = res.entry;
        cashTaken = res.added;
    } else if (touchesPettyCash) {
        const petty = require('./pettyCash');
        const res = await petty.withdrawForPayment({
            amount,
            loadId,
            paymentId: null,                 // stamped after the payment id exists
            date: input.paid_on,
            createdBy: input.created_by || null,
            allowPartial: input.allow_partial === true,
            // ── WHICH POT OF CASH, AND WHETHER SHE SAID YES TO BORROWING ──
            // Apsara, 2026-09-21. `cash_source` is NOT `bank`: banks.js
            // refuses a bank on a cash payment because "paid cash from Chase"
            // is not a true sentence about where the money left. This says
            // which trip to the bank the notes in the drawer came from, which
            // is a different fact and is why it has its own field.
            //
            // Blank is allowed all the way down and means Unassigned — the
            // APK and the voice path both predate this, and a payment she
            // cannot record is worse than one filed under unbanked cash.
            cashSource: input.cash_source,
            // Same shape as allow_partial above: refused first with the
            // figures, sent again only after she has seen them and agreed.
            allowBorrow: input.allow_borrow === true,
        });
        cashEntry = res.entry;
        cashTaken = res.taken;
    }

    const record = {
        id: newPaymentId(),
        load_id: loadId,
        // Which store the payable lives in. Ids are unique per store but not
        // across them, so without this a purchase and a sale could collide.
        //
        // 'trucker' added 2026-09-03 for the haulage bills. It has to be an
        // ALLOWLIST rather than the old `=== 'sale' ? 'sale' : 'purchase'`,
        // which silently coerced everything else to 'purchase': a trucker
        // payment would have been stored as a purchase, and then the spend
        // report — which splits on this field — would have labelled it
        // "Load TRK_001" and added it to what the yard paid for metal. The
        // grand total would still have been right, which is what makes that
        // class of bug last: nothing looks wrong until someone asks what a
        // month's haulage cost.
        //
        // Anything unrecognised still falls back to 'purchase', so records
        // written before this field existed keep their meaning.
        // ── 'bill' ADDED 2026-09-10, AND THE SILENT DOWNGRADE NAMED ──────
        // This is an allowlist, which is right — but anything not on it was
        // quietly relabelled 'purchase', and 'purchase' means a yard load.
        // helpers/billPayments.js passed 'bill' and got 'purchase' back, so a
        // supplier's container payment was filed as money spent at the yard.
        // Silent, and the grand total stayed correct the whole time.
        //
        // Still an allowlist — a typo must not invent a category — but an
        // unknown kind now says so instead of pretending to be a load.
        load_kind: loadKind,
        mode,
        // Null on Cash and Cheque, and null on every payment written before
        // 2026-09-09. Nothing migrates them: an old Zelle whose account nobody
        // recorded is UNKNOWN, and stamping a guess on it would be inventing
        // a fact about where money went. The report groups those as
        // "not recorded" rather than hiding them.
        bank,
        // Which company's money it was — '' on everything that does not ask,
        // and on every payment written before 2026-09-17. Nothing migrates
        // those: a wire whose paying company nobody recorded is UNKNOWN, and
        // stamping "Edge Yard" on it would be inventing a fact about money.
        // The Spend report buckets them visibly, the same way it does a bank
        // nobody recorded.
        paid_via: paidVia,
        // What was ACTUALLY paid. On a capped cash payment this is less than
        // was asked for, and the rest stays outstanding — which is exactly
        // what "make it a partial payment" means. Stored as the real figure so
        // paymentSummary, the card, the ticket and the invoice all agree
        // without any of them knowing about petty cash.
        amount: cashTaken != null ? cashTaken : amount,
        // Set only on a cash payment: the ledger row this drew on. Lets the
        // Petty cash tab link a withdrawal back to the load it paid, and lets
        // deletePayment find what to refund without scanning.
        petty_cash_entry_id: cashEntry ? cashEntry.id : null,
        // Local day, not UTC. toISOString() rolls over at UTC midnight, which is
        // early evening at the yard — an evening payment was being stamped with
        // tomorrow's date. See todayLocal() in helpers/time.js.
        paid_on: input.paid_on || require('./time').todayLocal(),
        reference: String(input.reference || '').trim() || null,
        note: String(input.note || '').trim() || null,
        created_at: new Date().toISOString(),
        created_by: input.created_by || null,
    };
    try {
    // ── STRICT: THIS WRITE EITHER HAPPENS OR SAYS SO ─────────────────────
    // mutateJson is forgiving by default — on failure it logs, returns
    // loadJson() and NEVER RUNS THE MUTATOR, handing back plausible-looking
    // data with no way to tell the write never landed. Its own note says the
    // paths where a lost write means lost DATA should opt in; this is one of
    // them, and 131 of 146 writes in this codebase had not.
    //
    // The catch covers mutator errors too, not just lock contention, so the
    // forgiving path also swallows bugs in the function above.
    //
    // No retry loop on top: LOCK_OPTS already backs off eight times (40ms to
    // 400ms), so a failure here is genuinely exceptional and a second layer
    // would be defensive code with nothing to defend against.
        await mutateJson(cfg.PAYMENTS_FILE, [], (all) => {
            const list = Array.isArray(all) ? all : [];
            list.push(record);
            return list;
        }, { strict: true });
    } catch (err) {
        // The payment did not land. Put the cash back, or the box would show
        // money gone for a payment that does not exist — see the ordering note
        // above. The reversal is stamped against the withdrawal's own id.
        if (cashEntry) {
            try {
                await require('./pettyCash').reverseForPayment(cashEntry.id, { createdBy: input.created_by || null });
            } catch (e) {
                // Both writes failed. Say so loudly and in full: this is the
                // one state a person has to reconcile by hand, and a silent
                // catch here is how it would be discovered weeks later.
                console.error(`[PAYMENTS] CASH RESERVED BUT NOT REFUNDED — petty cash entry ${cashEntry.id} took ${cashTaken} for load ${loadId} and the payment write failed. Refund also failed:`, e.message);
            }
        }
        throw err;
    }

    // Stamp the withdrawal with the payment it belongs to, now that the id
    // exists. Best-effort and deliberately not fatal: the money has already
    // moved correctly and the entry still carries load_id, so a failure here
    // costs a cross-reference, not a cent. Refunds fall back to the entry id.
    if (cashEntry) {
        try {
            await require('./pettyCash').stampPaymentId(cashEntry.id, record.id);
        } catch (e) {
            console.warn(`[PAYMENTS] could not link petty cash entry ${cashEntry.id} to payment ${record.id}:`, e.message);
        }
    }
    return record;
}

// Deleting a CASH payment puts the money back in the box. Per Apsara's model
// the two are the same event seen from two sides, so undoing one has to undo
// the other — otherwise deleting a mistaken $400 cash payment would leave the
// box $400 short forever, with nothing on screen explaining why.
//
// Refunded as a REVERSAL row rather than by deleting the withdrawal: a ledger
// you can remove rows from is one nobody can reconcile. The pair stays
// visible — money out on the 2nd, money back on the 3rd.
//
// Order is deliberate and the mirror of addPayment. There the cash moved
// first, because an overstated balance is the dangerous direction. Here the
// payment is removed first for the same reason: if the refund then fails, the
// box reads LOW, which is safe and visible, rather than high.
//
// The refund is idempotent by design (see reverseForPayment), so a retry after
// a partial failure cannot pay the money back twice.
async function deletePayment(id) {
    let removed = false;
    const doomed = listPayments().find((p) => p && p.id === id) || null;
    await mutateJson(cfg.PAYMENTS_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        const next = list.filter((p) => p.id !== id);
        removed = next.length !== list.length;
        return next;
    }, { strict: true });
    // An Edge Metals cash payment never touched this box (see
    // touchesPettyCash above), so reversing one would credit the yard with
    // cash it never handled — inventing money, which is worse than losing it.
    //
    // Works in BOTH directions without a branch: reverseForPayment negates
    // whatever it finds, so deleting a cash PURCHASE payment puts money back
    // in the box and deleting a cash SALE receipt takes it back out.
    if (removed && doomed && doomed.mode === 'Cash' && !EDGE_METALS_KINDS.has(doomed.load_kind)) {
        // By the withdrawal's own id when we have it, else by payment id —
        // reverseForPayment accepts either, and the entry id is the one that
        // survives a payment written before the link was stamped.
        const key = doomed.petty_cash_entry_id || doomed.id;
        try {
            await require('./pettyCash').reverseForPayment(key, { createdBy: null });
        } catch (e) {
            console.error(`[PAYMENTS] deleted cash payment ${id} but could NOT return ${doomed.amount} to petty cash (${key}):`, e.message);
        }
    }
    return removed;
}

// Removes every payment for a load. Called when a load is deleted, so a
// deleted load cannot leave orphan receipts summing against nothing.
// Cascade from deleting a LOAD. Same refund rule — a load being deleted does
// not mean the cash was really spent, and the box has to come back to what it
// was. Note this is reachable today only for a load with no payments (the Pay
// and Delete buttons are mutually exclusive on the card since 2026-09-01), but
// the route still exists and the yard assistant can reach it, so the refund
// belongs here rather than in the button.
async function deletePaymentsForLoad(loadId) {
    let removed = 0;
    const doomed = listPayments().filter((p) => p && p.load_id === loadId);
    await mutateJson(cfg.PAYMENTS_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        const next = list.filter((p) => p.load_id !== loadId);
        removed = list.length - next.length;
        return next;
    }, { strict: true });
    for (const p of doomed) {
        if (p.mode !== 'Cash' || EDGE_METALS_KINDS.has(p.load_kind)) continue;   // see deletePayment
        const key = p.petty_cash_entry_id || p.id;
        try {
            await require('./pettyCash').reverseForPayment(key, { createdBy: null });
        } catch (e) {
            console.error(`[PAYMENTS] load ${loadId} deleted but could NOT return ${p.amount} cash to petty cash (${key}):`, e.message);
        }
    }
    return removed;
}

// The figure every screen and the invoice quote. Derived, never stored, so it
// cannot drift from the payments it is supposed to summarise — and so that
// editing a load's price recalculates the balance instead of leaving a stale
// "paid in full" behind.
function paymentSummary(loadId, loadAmount) {
    const rows = paymentsForLoad(loadId);
    const paid = round2(rows.reduce((a, p) => a + (toNum(p.amount) || 0), 0)) || 0;
    const total = round2(toNum(loadAmount));

    // A load with no priced items has no total to settle against. Report what
    // was paid and say the balance is unknown rather than inventing one —
    // claiming "fully paid" because the total happens to be null would be a
    // lie with money attached.
    if (total == null) {
        return { paid, total: null, pending: null, status: paid > 0 ? 'paid_amount_unknown' : 'unpaid', payments: rows };
    }

    const pending = round2(total - paid);
    let status;
    if (paid <= CENT) status = 'unpaid';
    else if (pending > CENT) status = 'partial';
    else if (pending < -CENT) status = 'overpaid';
    else status = 'paid';
    return {
        paid,
        total,
        // Never negative on an overpayment — the overage is reported through
        // `status` and `over`, so a UI showing "pending" cannot show a
        // negative balance as though something were still owed.
        pending: pending > CENT ? pending : 0,
        over: pending < -CENT ? round2(-pending) : 0,
        status,
        payments: rows,
    };
}

module.exports = {
    PAYMENT_MODES, YARD_LOAD_MODES, PURCHASE_MODES, modesForKind,
    PAID_VIA, PAID_VIA_BY_KIND, paidViaRequired, paidViaLabel, resolvePaidVia,
    listPayments, paymentsForLoad, addPayment,
    deletePayment, deletePaymentsForLoad, paymentSummary,
};
