// ── helpers/truckingProposal.js — a verified hauler invoice, offered to a bill ──
//
// Apsara, 2026-09-20: "When i run verification against say aj transport,that
// verified bill is not coming into trucking of bills?"
//
// It was not, and that was a gap rather than a decision. The verification
// engine reads a hauler's PDFs, cross-checks them against the Edge Metals
// Invoice sheet, and logs the passing rows to a tab on that workbook — and
// stops. So she verified an invoice and then typed the same four figures onto
// the bill by hand, off the same document she had just verified.
//
// What the extraction already produces is very nearly what a bill's
// trucking_split holds:
//
//     AJ Transport      amount -> line_haul, dry_run_charge -> dry_run,
//                       extra_scale_charge -> extra_scale, other_charge -> others
//     Jio               line_haul, port_fees, chassis_rent already by those names
//     Sher              amount, chassis, other_charges
//
// ── THIS FILE ONLY PROPOSES ──────────────────────────────────────────────
// Asked whether a verified invoice should write onto the bill or be offered,
// she chose to confirm each one. So nothing here writes. It returns what it
// WOULD put on each bill, beside what that bill says today, and the client
// posts the accepted ones through PUT /api/bills/:id like any hand edit — so
// the split still goes through cleanFrom cleanTruckingSplit and still lands in
// the same audit trail. A second write path for money is a second thing to get
// wrong.
//
// ── AND IT NEVER PICKS THE BILL ──────────────────────────────────────────
// THE REASON THIS FILE IS SHAPED THE WAY IT IS. A hauler charges once to move
// a container. A bill is one row PER GRADE. Apsara, 2026-09-19: "sometimes
// diff items in same container." So one $850 haul can match three bills, and
// writing it to each would treble her haulage — the same "one key means one
// row" belief that silently dropped $15,955 from a single container on the
// margin report, which is the most expensive mistake in this repo's history.
//
// Asked where the money should go when a container is several rows, she chose
// to pick the row herself. So a match against several bills is reported as
// SEVERAL, with every candidate listed and none marked, and the client cannot
// accept it until she has chosen. There is no default, deliberately: a default
// here is a guess about money that looks like an answer.
//
// ── AND IT NEVER TOUCHES verified_on ─────────────────────────────────────
// Apsara, 2026-09-20, having been told that date is typed by hand: "verified
// on is good". See the note at cleanTruckingSplit in helpers/bills.js. That
// field says a person looked; a cross-check passing is a different claim.

const bills = require('./bills');

const norm = (v) => String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, '');
const money = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};
// Zero is not a charge. A hauler's invoice that does not mention a dry run
// should leave that box EMPTY on the bill, not write 0.00 into it — a typed
// zero and an untouched field look identical afterwards and mean different
// things.
const pos = (v) => { const n = money(v); return n !== null && n > 0 ? n : null; };

// ── WHICH KEY JOINS WHICH HAULER ─────────────────────────────────────────
// Apsara, 2026-09-20: "For Sher,use only booking number else container
// number." Sher's invoices genuinely carry no container — its records are
// { invoice_date, booking_no, quantity, chassis, other_charges, amount } and
// its own cross-check counts sheet rows per booking. AJ and Jio both carry a
// container and are joined on it.
const JOIN_BY = { aj: 'container', jio: 'container', sher: 'booking' };

// ── THE CHARGE MAP, ONE PER HAULER, WRITTEN OUT LONGHAND ─────────────────
// Three small functions rather than one clever table. Their invoices are not
// the same document and will not stay the same shape as each other; a shared
// mapper would make every future change to one of them a change to all three,
// which is the coupling this repo has been bitten by twice.
//
// `others` carries a name AND a note because cleanTruckingOthers REFUSES an
// Other without both — "a column named Others with no detail behind it is a
// number nobody can defend". The note names the hauler and their invoice, so
// months later the row says where it came from.
function splitFromAj(rec) {
    const out = { line_haul: pos(rec.amount), dry_run: pos(rec.dry_run_charge), extra_scale: pos(rec.extra_scale_charge), others: [] };
    const other = pos(rec.other_charge);
    if (other !== null) {
        out.others.push({ what: 'Other charge', amount: other,
            note: `From AJ Transport invoice ${rec.invoice_no || '(no number)'} — the invoice did not name this charge.` });
    }
    return out;
}

function splitFromJio(rec) {
    const out = {
        line_haul: pos(rec.line_haul), port_fees: pos(rec.port_fees), chassis_rent: pos(rec.chassis_rent), others: [],
    };
    // Jio's extractor returns other_charges as a list of its own, each with a
    // description — so unlike AJ's single unnamed bucket these keep their real
    // names and need no invented one.
    for (const o of (Array.isArray(rec.other_charges) ? rec.other_charges : [])) {
        const amt = pos(o && (o.amount != null ? o.amount : o));
        if (amt === null) continue;
        const what = String((o && (o.description || o.what)) || '').trim() || 'Other charge';
        out.others.push({ what, amount: amt, note: `From Jio invoice ${rec.invoice_no || '(no number)'}.` });
    }
    return out;
}

function splitFromSher(rec) {
    // Sher bills a chassis charge and a catch-all. `amount` is the haul.
    const out = { line_haul: pos(rec.amount), chassis_rent: pos(rec.chassis), others: [] };
    const other = pos(rec.other_charges);
    if (other !== null) {
        out.others.push({ what: 'Other charge', amount: other,
            note: `From Sher Trucking invoice for booking ${rec.booking_no || '(no booking)'} — the invoice did not name this charge.` });
    }
    return out;
}

const SPLIT_FROM = { aj: splitFromAj, jio: splitFromJio, sher: splitFromSher };
const HAULER_LABEL = { aj: 'AJ Transport', jio: 'Jio', sher: 'Sher Trucking' };

// What the bill says TODAY, for the side-by-side. Asked what should happen
// when the invoice and the bill disagree, she chose to see both and change
// nothing — which is the rule bills.js already applies to a typed trucking
// total against a split (`trucking_conflict`), so this is that rule extended
// rather than a new one.
function currentOf(bill) {
    const s = (bill && bill.trucking_split) || {};
    return {
        line_haul: s.line_haul ?? null, port_fees: s.port_fees ?? null, chassis_rent: s.chassis_rent ?? null,
        dry_run: s.dry_run ?? null, extra_scale: s.extra_scale ?? null,
        others_total: s.others_total || 0,
        invoice_no: s.invoice_no || null,
        // Carried so the client can show it and so an accept can put it back
        // untouched. NOT proposed, NOT overwritten — see the header.
        verified_on: s.verified_on || null,
        total: s.total ?? null,
        typed_amount: bill && bill.trucking_amount != null ? bill.trucking_amount : null,
        company: (bill && bill.trucking_company) || null,
    };
}

const PARTS = ['line_haul', 'port_fees', 'chassis_rent', 'dry_run', 'extra_scale'];

// Every field where the invoice and the bill both have a figure and they are
// not the same. Reported, never resolved.
function disagreements(proposed, current) {
    const out = [];
    for (const k of PARTS) {
        const a = proposed[k] == null ? null : proposed[k];
        const b = current[k] == null ? null : current[k];
        if (a === null || b === null) continue;
        if (Math.abs(a - b) >= 0.005) out.push({ field: k, invoice: a, bill: b, delta: Math.round((a - b) * 100) / 100 });
    }
    return out;
}

function totalOf(split) {
    const parts = PARTS.reduce((s, k) => s + (split[k] || 0), 0);
    const others = (split.others || []).reduce((s, o) => s + (o.amount || 0), 0);
    const t = Math.round((parts + others) * 100) / 100;
    return t > 0 ? t : null;
}

// ── THE PROPOSALS ────────────────────────────────────────────────────────
//
// `records` are the rows a cross-check returned (invoiceVerify.js). `kind` is
// 'aj' | 'jio' | 'sher'.
//
// Only rows the cross-check actually PASSED are offered. A record whose
// container is not on the sheet, or whose booking disagrees with ours, is the
// exact case a person needs to look at — quietly offering to write it onto a
// bill would turn the verification's own complaint into a suggestion.
//
// allBills is injectable so tests, and any future caller with a filtered set,
// do not have to write to her real ledger to exercise this.
function proposals(records, kind, { allBills } = {}) {
    const joinBy = JOIN_BY[kind];
    const toSplit = SPLIT_FROM[kind];
    if (!joinBy || !toSplit) throw new Error(`unknown hauler ${kind}`);

    const rows = Array.isArray(allBills) ? allBills : bills.listWithTotals();

    return (records || []).map((rec, i) => {
        const base = {
            index: i,
            hauler: HAULER_LABEL[kind],
            join_by: joinBy,
            container_no: rec.container_no || null,
            booking_no: rec.booking_no || null,
            invoice_no: rec.invoice_no || null,
            invoice_date: rec.invoice_date || null,
            verify_status: rec.status || null,
        };

        if (rec.status !== 'verified' && rec.status !== 'match') {
            return { ...base, status: 'not_verified',
                why: 'The cross-check did not pass this row, so there is nothing to offer.' };
        }

        const key = joinBy === 'booking' ? norm(rec.booking_no) : norm(rec.container_no);
        if (!key) {
            return { ...base, status: 'no_key',
                why: `This record has no ${joinBy} number on it, so there is nothing to match a bill on.` };
        }

        const candidates = rows.filter((b) => norm(joinBy === 'booking' ? b.booking_no : b.container_no) === key);

        const split = toSplit(rec);
        split.invoice_no = rec.invoice_no || null;
        const proposedTotal = totalOf(split);

        if (!candidates.length) {
            return { ...base, status: 'no_bill', split, proposed_total: proposedTotal,
                why: `No bill carries ${joinBy} ${joinBy === 'booking' ? rec.booking_no : rec.container_no}.` };
        }

        const shaped = candidates.map((b) => ({
            bill_id: b.id,
            date: b.date || null,
            supplier: b.supplier || null,
            // `description || item`, NOT b.grade — there is no grade field on
            // a bill, and helpers/bills.js's gradeKey reads these two. This is
            // the ONLY thing that tells three rows of one container apart, so
            // getting it wrong would show her three identical-looking bills
            // and make "pick one" a coin toss.
            grade: String((b.description || b.item) || '').trim() || null,
            amount: b.amount != null ? b.amount : null,
            booking_no: b.booking_no || null,
            container_no: b.container_no || null,
            current: currentOf(b),
            disagreements: disagreements(split, currentOf(b)),
        }));

        // ── SEVERAL IS ITS OWN STATUS, NOT A LIST WITH THE FIRST PICKED ───
        // One container, several grades, one haul. She chose to put the whole
        // amount on a row she picks, so this hands back every candidate with
        // nothing selected and the client refuses to accept until she has
        // chosen. Sorting by grade would be a hint; there is no honest hint.
        return {
            ...base,
            status: candidates.length === 1 ? 'one_bill' : 'several_bills',
            split,
            proposed_total: proposedTotal,
            candidates: shaped,
            why: candidates.length === 1 ? null
                : `${candidates.length} bills carry ${joinBy === 'booking' ? 'booking' : 'container'} `
                  + `${joinBy === 'booking' ? rec.booking_no : rec.container_no} — one per grade. `
                  + 'The haul was charged once, so it goes on one of them.',
        };
    });
}

// What the client POSTs back for an accepted row: the split it was shown, plus
// whatever verified_on that bill already had, so accepting a proposal cannot
// blank a date she typed. Exported rather than assembled in the browser
// because it decides what reaches a money field.
function splitToSave(split, current) {
    return {
        line_haul: split.line_haul ?? null,
        port_fees: split.port_fees ?? null,
        chassis_rent: split.chassis_rent ?? null,
        dry_run: split.dry_run ?? null,
        extra_scale: split.extra_scale ?? null,
        others: Array.isArray(split.others) ? split.others : [],
        invoice_no: split.invoice_no || null,
        // HERS, CARRIED THROUGH UNTOUCHED. Not proposed, not cleared.
        verified_on: (current && current.verified_on) || null,
    };
}

module.exports = { proposals, splitToSave, JOIN_BY, splitFromAj, splitFromJio, splitFromSher, totalOf, disagreements, currentOf };
