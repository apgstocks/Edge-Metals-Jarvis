// ── helpers/entities.js — WHOSE books, and WHOSE money ───────────────────
//
// Apsara, 2026-10-06, asked what AAA Investment is for accounting purposes:
// "A third company with its own return."
//
// That answer is why this file exists. Three companies filing three returns
// means every money row has to land on exactly one of them, and today
// nothing in Jarvis can say which. CLAUDE.md rule 5 — "Edge Yard and Edge
// Metals are different companies" — has been enforced by DISCIPLINE and by
// which file a row lives in. A tax return needs it enforced by a function.
//
// ── THE THREE NAMING SYSTEMS, RECONCILED ─────────────────────────────────
// The same companies appear under different names in different files, and
// that is the first thing that has to stop:
//
//   payments.js:149        'Edge Yard'  'Edge Metals'  'AAA Investment'
//   bank-accounts.json     'EDGE TRADING INC'  'Edge Metals INC'
//   outboundLoads/gemini   'Edge Trading'
//   pettyCash.js:161       'Edge Metals'  'AAA Investment'  'Chase Bank'
//
// EDGE YARD AND EDGE TRADING INC ARE ONE COMPANY. Not an assumption:
// payments.js's paidViaOptionsFor maps Chase to 'Edge Yard' and nothing
// else, and bank-accounts.json's Chase account is 'EDGE TRADING INC'. One
// bank, one owner, two names for it.
//
// ── THE DISTINCTION THAT MAKES THREE RETURNS POSSIBLE ────────────────────
// Every row answers TWO different questions, and flattening them into one
// is how inter-company money disappears:
//
//   ledger  — whose BOOKS the transaction belongs to. A yard purchase is
//             Edge Trading's purchase. It is on Edge Trading's P&L.
//   paidBy  — whose MONEY actually moved. She records this as `paid_via`,
//             and it is her own stated answer, not a derivation.
//
// Usually they are the same and there is nothing to see. When they DIFFER —
// a yard purchase with paid_via 'Edge Metals' — Edge Metals' money paid
// Edge Trading's bill. That is a loan between two companies that each file
// a return, and it belongs on both balance sheets: a receivable on one, a
// payable on the other. Collapse the two fields into one and that item
// vanishes from both, which is the single easiest way to make three returns
// quietly wrong.
//
// So `of()` returns both, plus the BASIS it used, so a figure she disputes
// can be traced to the rule that produced it rather than argued about.
//
// ── WHAT THIS FILE WILL NOT DO ───────────────────────────────────────────
// It reads nothing and writes nothing. Rows are passed in. That keeps it
// testable against fixtures, and keeps the derivation rules in one readable
// place instead of spread across the callers that need them.
//
// It also NEVER GUESSES. A row it cannot place comes back with
// ledger: null and a reason. The alternative — defaulting to the likelier
// company — puts money on the wrong tax return, silently, and nobody finds
// out until an audit. An unplaced row is a question for her; a wrongly
// placed one is a misfiling.

// ── the three companies ──────────────────────────────────────────────────
// `taxId` is deliberately present and deliberately EMPTY where she has not
// given it. A blank is a blocker that `filable()` reports; inventing a
// placeholder would let a return print with a wrong number on it.
const ENTITIES = [
    {
        id: 'edge-metals',
        legalName: 'Edge Metals INC',
        // What her screens call it. Same word, so nothing to reconcile.
        uiName: 'Edge Metals',
        taxId: '26-326-9514',
        address: '14750 Devonshire Ln, Frisco, TX 75035',
        banks: ['BofA'],
        aliases: ['edge metals', 'edge metals inc', 'edge metals inc.', 'edgemetals', 'metals'],
        why: 'The export business. Bills, invoices, containers, packing lists. '
            + 'The only one of the three with a QuickBooks company, so the only one whose '
            + 'statements can be checked against anything external.',
    },
    {
        id: 'edge-trading',
        legalName: 'EDGE TRADING INC',
        // ── THE RENAME THAT IS NOT A RENAME ──────────────────────────────
        // Every screen she uses says "Edge Yard". The legal name is EDGE
        // TRADING INC. Both are kept: uiName is what she must keep seeing,
        // legalName is what goes on a return. Changing the screens to say
        // "Edge Trading" was not asked for and would be a behaviour change.
        uiName: 'Edge Yard',
        taxId: '',
        address: '2453 E 25th Street, Los Angeles, CA 90058',
        banks: ['Chase Bank'],
        aliases: ['edge yard', 'edge trading', 'edge trading inc', 'edge trading inc.',
            'edgeyard', 'edgetrading', 'yard'],
        why: 'The yard. Inbound loads, outbound loads, petty cash, truckers, expenses. '
            + 'Banks at Chase, which payments.js treats as having exactly one possible owner.',
    },
    {
        id: 'aaa-investment',
        // ── UNCONFIRMED, AND SAID SO ─────────────────────────────────────
        // She confirmed on 2026-10-06 that this is a third company with its
        // own return. She has NOT given its registered name, its tax ID or
        // its own bank account. The legal name below is the name her screens
        // use, which is a placeholder for a real registered name and is
        // marked as such rather than presented as fact.
        legalName: 'AAA Investment',
        id: 'aaa-investment',
        uiName: 'AAA Investment',
        taxId: '',
        address: '',
        // ── THE PROBLEM TO RAISE BEFORE ANY AAA RETURN IS FILED ──────────
        // pettyCash.js's BANK_OF has put AAA Investment at BofA since
        // 2026-09-21, which is Edge Metals' bank. Two companies that each
        // file a return drawing on one bank account is commingling, and it
        // is the first thing a CPA raises. Recorded here as what the code
        // says, not endorsed as correct.
        banks: ['BofA'],
        aliases: ['aaa investment', 'aaa investments', 'aaa', 'aaa inv'],
        why: 'Confirmed by Apsara 2026-10-06 as a third company with its own return. '
            + 'Appears today only as a paid_via option and a petty-cash source — it has no '
            + 'bank account record, no address and no tax ID, so its return cannot be '
            + 'completed from what Jarvis holds.',
        needsFromHer: ['registered legal name', 'tax ID', 'its own bank account'],
    },
];

const BY_ID = new Map(ENTITIES.map((e) => [e.id, e]));

// ── which stores belong to whom ──────────────────────────────────────────
// Lifted from helpers/tools.js:305-317, which is the authoritative split and
// already guarded by tests/yard-assistant-knowledge.js. Restated here as
// DATA rather than re-derived, because a statement that silently reads the
// wrong company's store is the failure this whole file exists to prevent.
//
// payments.json is deliberately absent: it is SHARED, and `of()` handles it
// by load_kind. Listing it here under either company would be wrong for
// roughly half its rows.
const STORE_LEDGER = {
    // Edge Metals — the export side
    bills: 'edge-metals',
    sales: 'edge-metals',
    bill_payments: 'edge-metals',
    sales_receipts: 'edge-metals',
    sales_settlements: 'edge-metals',
    metals_trucking: 'edge-metals',
    edge_inventory: 'edge-metals',
    // NTG, TQL and Schneider. helpers/carrierInvoices.js is titled "EDGE
    // METALS local-delivery carriers" and stamps company:'Edge Metals' on
    // every row it writes, so this is read off the data rather than decided
    // here. Added 2026-10-08 when Apsara picked the account for them.
    carrier_invoices: 'edge-metals',

    // Edge Trading — the yard
    loads: 'edge-trading',
    outbound_loads: 'edge-trading',
    load_drafts: 'edge-trading',
    expenses: 'edge-trading',
    petty_cash: 'edge-trading',
    trucker_bills: 'edge-trading',
    scale_tickets: 'edge-trading',
};

// payments.js:264. REQUIRED, not copied — if she adds a fourth Edge Metals
// kind there, the company statements must follow it, and a second
// hand-written list here would not.
//
// Written first as a copy with a silent try/catch fallback, which was wrong
// twice over: payments.js did not export the Set at all, so the "fallback"
// was the only code path that ever ran, and nothing said so. A fallback
// that cannot be observed is a copy with extra steps. It now reports its
// source, and FALLBACK_KINDS exists only so an exports change cannot crash
// a statement mid-render — if it is ever in use, the basis string says so
// on every single row and tests/entities.js goes red.
const FALLBACK_KINDS = new Set(['bill', 'sale_cost', 'metals_trucking']);

function metalsKinds() {
    try {
        const p = require('./payments');
        if (p && p.EDGE_METALS_KINDS && typeof p.EDGE_METALS_KINDS.has === 'function') {
            return { kinds: p.EDGE_METALS_KINDS, source: 'payments.js' };
        }
    } catch (e) { /* fall through to the visible fallback */ }
    return { kinds: FALLBACK_KINDS, source: 'FALLBACK — payments.js no longer exports EDGE_METALS_KINDS' };
}

// ── name → entity ────────────────────────────────────────────────────────
// Case and punctuation insensitive, because the same company is written
// four ways across the stores. Returns null rather than a best guess.
function resolve(name) {
    const n = String(name == null ? '' : name).trim().toLowerCase().replace(/[.,]/g, '');
    if (!n) return null;
    for (const e of ENTITIES) {
        if (e.aliases.includes(n)) return e.id;
        if (e.legalName.toLowerCase().replace(/[.,]/g, '') === n) return e.id;
        if (e.uiName.toLowerCase() === n) return e.id;
    }
    return null;
}

function get(id) { return BY_ID.get(String(id || '')) || null; }

// ── can a return actually be produced for this company? ──────────────────
// Separated from everything else so the pack can REFUSE rather than print a
// statement with a blank tax ID on it and let her discover that at filing.
function filable(id) {
    const e = get(id);
    if (!e) return { ok: false, missing: ['the company itself'], detail: `no such entity: ${id}` };
    const missing = [];
    if (!e.taxId) missing.push('tax ID');
    if (!e.address) missing.push('registered address');
    if (!e.banks || !e.banks.length) missing.push('a bank account');
    if (!missing.length) return { ok: true, missing: [] };
    return {
        ok: false,
        missing,
        detail: `${e.legalName} is missing ${missing.join(', ')} — these are hers to supply, `
            + 'and a return cannot be completed without them',
    };
}

// ── THE ONE THAT MATTERS ─────────────────────────────────────────────────
// Given a store name and a row, say whose books it belongs to and whose
// money moved. Never throws, never guesses.
//
//   { ledger, paidBy, basis, interCompany, undecided }
//
// `basis` is the rule that decided it, in words, so a disputed figure leads
// back to a rule instead of to an argument.
function of(store, rawRow) {
    const s = String(store || '').trim();
    const out = { ledger: null, paidBy: null, basis: null, interCompany: false, undecided: false };

    // ── `row = {}` IS NOT ENOUGH, AND THIS IS NOT THEORETICAL ────────────
    // A default parameter fires on `undefined` only. A NULL row threw here,
    // and helpers/json.js's loadJson deliberately never validates what it
    // reads — it returns the file's contents as they are. So one null left
    // in bills.json by any past write would have taken down an entire
    // company's statement with a TypeError, and the statement is the thing
    // she is trying to file a return from.
    const row = (rawRow && typeof rawRow === 'object' && !Array.isArray(rawRow)) ? rawRow : {};
    if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) {
        // Not silently treated as an empty row: a row that is not a row is
        // a data problem she should see, not a zero to be absorbed.
        out.undecided = true;
        out.basis = `${s || 'unknown store'} contains something that is not a row `
            + `(${rawRow === null ? 'null' : Array.isArray(rawRow) ? 'an array' : typeof rawRow})`
            + ' — it holds no company and no amount, so it cannot be placed';
        return out;
    }

    // A stated paid_via is HER answer about whose money moved. Read first,
    // and never overwritten by a derivation — payments.js:resolvePaidVia
    // already refuses to auto-fill it for exactly this reason.
    const stated = resolve(row.paid_via);
    if (stated) out.paidBy = stated;

    // ── the shared store ────────────────────────────────────────────────
    if (s === 'payments') {
        const kind = String(row.load_kind || '').trim();
        if (!kind) {
            out.undecided = true;
            out.basis = 'payments.json row with no load_kind — cannot tell which company\'s '
                + 'payment this is, and guessing would put it on a return';
            return out;
        }
        const mk = metalsKinds();
        out.ledger = mk.kinds.has(kind) ? 'edge-metals' : 'edge-trading';
        out.basis = `payments.json, load_kind '${kind}' → ${out.ledger} `
            + `(EDGE_METALS_KINDS from ${mk.source})`;
    } else if (s === 'bank_transactions' || s === 'bank-transactions') {
        // The only store with a literal company field on each row
        // (bankLedger.js:146), set from qb-settings/bank-accounts.json.
        const byField = resolve(row.company);
        if (byField) {
            out.ledger = byField;
            out.basis = `bank row's own company field '${row.company}'`;
        } else {
            out.undecided = true;
            out.basis = row.company
                ? `bank row names a company this file does not know: '${row.company}'`
                : 'bank row has no company — its account is not in bank-accounts.json';
            return out;
        }
    } else if (STORE_LEDGER[s]) {
        out.ledger = STORE_LEDGER[s];
        out.basis = `${s}.json is a ${get(out.ledger).uiName} store (helpers/tools.js:305)`;

        // ── PETTY CASH IS THE INTERESTING ONE ───────────────────────────
        // The LEDGER is Edge Trading's — it is the yard's drawer. But
        // cash_source says whose bank funded it, and 'Edge Metals' or
        // 'AAA Investment' there means another company's money went into
        // the yard's till. With three separate returns that is a loan
        // between two filers, not a detail.
        if (s === 'petty_cash') {
            const funder = resolve(row.cash_source);
            if (funder) {
                out.paidBy = funder;
                out.basis += `, funded by ${get(funder).uiName} (cash_source)`;
            }
        }
    } else {
        out.undecided = true;
        out.basis = `unknown store '${s}' — it is not in the Edge Metals or Edge Trading list, `
            + 'so which company it belongs to has never been decided';
        return out;
    }

    // Money that moved from a company other than the one whose books carry
    // the transaction. Both sides need it; neither can infer it alone.
    if (out.paidBy && out.ledger && out.paidBy !== out.ledger) {
        out.interCompany = true;
        out.basis += ` — INTER-COMPANY: ${get(out.paidBy).uiName} money paid `
            + `${get(out.ledger).uiName}'s transaction`;
    }
    return out;
}

// ── a whole store at once, with the undecidables surfaced ────────────────
// The return deliberately separates `placed` from `undecided` rather than
// reporting a count of problems. A statement built from `placed` while
// `undecided` is non-empty is INCOMPLETE, and the caller has to see that
// rather than read a total and believe it.
function place(store, rows = []) {
    const placed = [];
    const undecided = [];
    const interCompany = [];
    for (const row of (Array.isArray(rows) ? rows : [])) {
        const r = of(store, row);
        const item = { row, ...r };
        if (r.undecided || !r.ledger) undecided.push(item);
        else {
            placed.push(item);
            if (r.interCompany) interCompany.push(item);
        }
    }
    return { store, placed, undecided, interCompany, complete: undecided.length === 0 };
}

module.exports = {
    ENTITIES, STORE_LEDGER, FALLBACK_KINDS,
    resolve, get, filable, of, place, metalsKinds,
};
