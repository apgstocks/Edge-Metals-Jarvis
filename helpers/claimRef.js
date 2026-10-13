// ── helpers/claimRef.js — "PO10554" is an order she already has ──────────
//
// Apsara, 2026-10-14, about a claim mail naming PO10554 and no container:
// "If there is a claim,if i ask jarvis to read it,it has everything with it
// right?like bills and invoice,it should auto fill everything right" — and
// then, asked where that PO lives: "It wll be in reference of order details
// in my sheet".
//
// ── WHAT WAS ACTUALLY HAPPENING ─────────────────────────────────────────
// Her mail was dropped before anything read it. helpers/claimParse.js's gate
// requires shortage language AND an ISO 6346 container number, and
// claimParse.js:214 then refuses outright unless a container or invoice
// number came back:
//
//     GATE : { hit: false, why: ["no container number", ...] }
//
// So no model call, no claim, nothing on the page, no mail to her. The
// claims machinery that follows — the supplier price, the assessment, the
// tolerance, the deliberate refusal to compute an amount before a person
// confirms the unit — is good and never got to run.
//
// ── WHY THIS LOOKS THINGS UP RATHER THAN MATCHING A PATTERN ─────────────
// The obvious fix is a regex for /PO\s?\d+/. It is the wrong fix twice over:
//
//   · her references are not all POs. sheetImport.js already notes that her
//     local deliveries to Eccomelt "carry a PO reference and 'Local
//     Transit' instead of a container and an HBL" — a reference is whatever
//     the order says, not a shape;
//   · a pattern invents a vocabulary. Any mail containing "PO" and digits
//     would pass the gate, and the gate exists precisely to keep a model
//     call off mail that is not a claim (its own header says so: five
//     watchers poll these mailboxes every 5–15 minutes).
//
// So the test is membership, not shape: is this token a reference SHE
// ACTUALLY HAS? That cannot false-positive on arbitrary mail, needs no
// network and no model, and it is the same approach helpers/bankLearn.js
// takes with her real party names rather than guessing at bank descriptions.
//
// ── IT READS. IT DECIDES NOTHING ────────────────────────────────────────
// Given some text it says which of her orders are named in it and what
// those orders say. It does not create a claim, score anything, or write.
// What a claim is worth stays with helpers/claims.js, where the arithmetic
// per kind already lives.

const cfg = require('../config');

// ── normalising, so "PO 10554" and "po-10554" are the same order ────────
// Deliberately NOT stripping to digits: "10554" alone is a weight, a price
// and a row number as easily as an order, and matching on it would key a
// claim off a coincidence.
const norm = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');

// A reference too short or too plain to be worth matching. "1", "NA", "TBD"
// appear in spreadsheets constantly and would hit on almost any mail.
const JUNK = new Set(['', 'NA', 'N/A', 'TBD', 'TBA', 'NONE', 'NIL', 'X', 'XX', 'TEST', 'LOCAL', 'LOCALTRANSIT']);
const usable = (ref) => {
    const n = norm(ref);
    if (n.length < 4) return false;          // needs enough body to be distinctive
    if (JUNK.has(n)) return false;
    if (/^0+$/.test(n)) return false;
    return true;
};

// ── THE INDEX, CACHED ON THE STORE'S mtime ──────────────────────────────
// gate() runs on EVERY message in five mailboxes polled every 5–15 minutes,
// and today it does no I/O at all. Reading and indexing sales.json per
// message would be a real cost for no benefit, so the index is built once
// and rebuilt only when the file actually changes. Keyed on mtime rather
// than a timer: a sheet sync that adds an order must be visible to the next
// mail, not in five minutes.
let CACHE = { key: null, byRef: new Map() };

function salesRows() {
    // Required at call time, not at module load: helpers/sales.js pulls in a
    // chain of money helpers, and the mail path should not pay for that
    // unless a mail is actually being checked.
    try { return require('./sales').list() || []; } catch (e) { return []; }
}

function index() {
    let key = null;
    try {
        const fs = require('fs');
        const st = fs.statSync(cfg.SALES_FILE);
        key = `${st.mtimeMs}:${st.size}`;
    } catch (e) { key = 'nofile'; }
    if (CACHE.key === key) return CACHE.byRef;

    const byRef = new Map();
    for (const s of salesRows()) {
        if (!s) continue;
        // Every identifier an order can be named by, not just `reference`.
        // A mail may quote the invoice number or the container instead, and
        // all three should land on the same order.
        for (const field of ['reference', 'invoice_no', 'container_no', 'booking_no', 'hbl_no']) {
            const v = s[field];
            if (!usable(v)) continue;
            const k = norm(v);
            if (!byRef.has(k)) byRef.set(k, []);
            // One reference can cover several rows — a PO shipped as three
            // containers is three sales. Kept as a list for that reason; a
            // Map of single rows would silently pick one.
            byRef.get(k).push({ sale: s, matched_field: field });
        }
    }
    CACHE = { key, byRef };
    return byRef;
}

// ── tokens — what in this text could be an identifier ───────────────────
// Candidates only. Every one is checked against the index, so being generous
// here costs nothing but a Map lookup and being stingy would miss an order.
// Runs of letters-and-digits, plus the same runs with one separator joined
// up, so "PO 10554" and "PO-10554" are both offered as "PO10554".
// ── WORDS FIRST, THEN JOIN NEIGHBOURS ───────────────────────────────────
// The first version matched a greedy run that allowed spaces inside it, with
// a 30-character cap. That cap fell in the MIDDLE of an identifier: "on
// AAAU1111111 and CCCU3333333" yielded "ANDCCCU" and "3333333" as separate
// tokens and the second container was never found. Caught by the test for
// two containers in one mail.
//
// So: split on anything that is not a letter or digit, then offer each word
// and each pair of neighbours joined up. A pair is what catches "PO 10554"
// and "PO-10554"; nothing is ever truncated, and there is no length cap to
// land in the wrong place.
function tokens(text) {
    const words = String(text == null ? '' : text).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
    const out = new Set();
    for (let i = 0; i < words.length; i++) {
        out.add(words[i]);
        if (i + 1 < words.length) out.add(words[i] + words[i + 1]);
    }
    // Four characters is the same floor usable() applies to a reference, so
    // a token too plain to be an identifier is never even looked up.
    return [...out].filter((x) => x.length >= 4);
}

// ── resolve(text) — which of her orders is this mail about? ─────────────
// Returns one entry per ORDER MATCHED, newest-looking first, each carrying
// the fields a claim wants pre-filled and the token it was found by. An
// empty array means "none of her orders is named here", which is a real
// answer and the one the gate needs.
function resolve(text) {
    const byRef = index();
    if (!byRef.size) return [];
    // ── COLLECT EVERY (order, field) MATCH, DEDUPE LAST ─────────────────
    // The first version deduped by order id as it went, which looked right
    // and silently defeated narrow(): the PO token comes up before the
    // container token, so all three orders were claimed at the `reference`
    // tier and the container match was skipped as "already seen". narrow()
    // then had no container tier to find. Caught by the test for "PO20001
    // container BBBU2222222", which kept answering with all three.
    //
    // So nothing is dropped until the tier is decided.
    const hits = [];
    for (const tok of tokens(text)) {
        const rows = byRef.get(tok);
        if (!rows) continue;
        for (const { sale, matched_field } of rows) {
            hits.push({
                // How it was found, because "why did this claim attach to
                // that order" is the first question asked about a wrong one.
                matched: tok,
                matched_field,
                sale_id: sale.id || null,
                // ── WHAT A CLAIM WANTS PRE-FILLED ───────────────────────
                // Her words: "it has everything with it right?like bills and
                // invoice,it should auto fill everything right". These are
                // the facts; the money is still assessed by claims.js, which
                // refuses to compute an amount before a person confirms the
                // unit.
                reference: sale.reference || null,
                invoice_no: sale.invoice_no || null,
                container_no: sale.container_no || null,
                booking_no: sale.booking_no || null,
                hbl_no: sale.hbl_no || null,
                customer: sale.customer || sale.consignee || null,
                item: sale.item || null,
                // ── THE WEIGHT IS IN POUNDS, AND IT SAYS SO ─────────────
                // helpers/sales.js:309 — weight carries unit:'lbs', hint
                // "pounds unless you say otherwise". Her claim mail quotes
                // MT. Handing a bare 2,458 to anything that also holds a
                // figure in MT is the 2204x error claimParse.js refuses to
                // risk, and it is why it leaves weight_unit null rather than
                // guessing. So the unit travels WITH the number, always, and
                // nothing downstream has to know where it came from.
                invoice_weight: sale.weight ?? null,
                invoice_weight_unit: (sale.weight ?? null) === null ? null : 'lb',
                // The rate Edge invoiced at — what a shortage is valued at,
                // and what their claimed rate should be compared against.
                //
                // ITS UNIT IS AMBIGUOUS BY HER OWN CONVENTION: sales.js:311
                // reads "under $10 is read as per lb, $10+ as per MT". That
                // is a rule for a form she is looking at, not a fact to
                // assert here, so the figure is passed through with the
                // convention named and no conclusion drawn.
                invoice_price: sale.invoice_price ?? null,
                invoice_price_basis: 'her convention: under $10 is per lb, $10+ is per MT (sales.js)',
                // NOT the supplier. A sale has none — sales.js:190 says the
                // purchase side "lives on the matching Bill". Inventing one
                // here would put a guess where claimPrice.js already does
                // the real lookup against bills, and a claim naming the
                // wrong supplier is a recovery argued at the wrong party.
                inv_date: sale.inv_date || sale.date || null,
            });
        }
    }
    return narrow(hits);
}

// ── THE MOST SPECIFIC IDENTIFIER WINS ───────────────────────────────────
// A PO shipped as three containers is three sales, and "shortage claim on
// PO20001" is rightly all three. But "PO20001 container BBBU2222222" has
// told us which box, and answering with three is how a claim ends up
// attached to the wrong one — or, more often, how a person is made to
// disambiguate something the mail already said.
//
// So the tiers are ordered by how much they pin down: a container is one
// physical box, an invoice is one document, a booking or HBL can cover
// several containers, and a reference can cover an entire order. If any
// match came from a narrower tier, the wider ones are dropped.
//
// WHEN THE NARROWEST TIER ITSELF HAS SEVERAL, ALL OF THEM ARE KEPT. That is
// genuine ambiguity — two containers named in one mail — and resolving it
// by picking the first would be inventing a decision.
const TIERS = ['container_no', 'invoice_no', 'hbl_no', 'booking_no', 'reference'];
function narrow(hits) {
    for (const tier of TIERS) {
        const at = hits.filter((h) => h.matched_field === tier);
        // Dedupe HERE, once the tier is settled: one order can be named
        // twice at the same tier (its container written two ways) and should
        // still be one answer.
        if (at.length) return dedupe(at);
    }
    return dedupe(hits);
}

const keyOfHit = (h) => h.sale_id
    || `${h.invoice_no || ''}|${h.container_no || ''}|${h.reference || ''}`;
function dedupe(hits) {
    const seen = new Set();
    const out = [];
    for (const h of hits) {
        const k = keyOfHit(h);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(h);
    }
    return out;
}

// ── named(text) — the cheap question the gate asks ──────────────────────
// Just the identifiers, no order bodies. Separate from resolve() so the gate
// can answer "is one of her orders named here" without building the richer
// shape it has no use for.
function named(text) {
    const byRef = index();
    if (!byRef.size) return [];
    return tokens(text).filter((t) => byRef.has(t));
}

// Exported for the tests, and for a script that needs to see the index.
const _reset = () => { CACHE = { key: null, byRef: new Map() }; };

module.exports = { resolve, named, tokens, norm, usable, index, narrow, TIERS, _reset, JUNK };
