// ── helpers/freightProposal.js — a verified Zimex invoice, offered to a sale ──
//
// Apsara, 2026-09-20, on where each verification's figures belong: "For
// transports, second tab of Bills.. For zimex - in freight of invoice.."
//
// So Zimex does not go where the truckers go, and she is right about why:
// Zimex is OCEAN FREIGHT, billed per HBL. It is not haulage and it has no
// business in a bill's trucking split. Its home is the freight on the invoice.
//
// ── DELIBERATELY SHARES NO CODE WITH helpers/truckingProposal.js ─────────
// The two look similar for about one screen and then stop: a different
// document (an ocean carrier's invoice, not a drayage ticket), a different
// store (sales.json, not bills.json), a different key (HBL, not container or
// booking), and a different destination shape (a charge with a direction and
// a reason, not five named part fields). A shared "proposal engine" would
// make every future change to one of them a change to both, which is the
// coupling that has cost this repo a live document twice. Two files.
//
// ── IT PROPOSES, AND IT DOES NOT PICK ────────────────────────────────────
// Same two rules she set for the trucking side, for the same reasons. Nothing
// here writes; the client posts an accepted charge through PUT /api/sales/:id
// so it goes through cleanCharges like anything typed. And an HBL that
// matches several sale rows — one per grade, exactly as a container does —
// hands back every candidate with none chosen.

const sales = require('./sales');

const norm = (v) => String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, '');
const money = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

// Every charge already on this sale that looks like the ocean freight — so a
// second run of the same invoice offers to correct rather than to duplicate.
// Matched on the NAME, because that is all a charge has: there is no carrier
// field and no invoice number on a charge row.
const FREIGHT_NAME = 'Ocean freight';
function existingFreight(sale) {
    return (Array.isArray(sale && sale.charges) ? sale.charges : [])
        .filter((c) => c && c.direction === 'out' && /freight/i.test(String(c.what || '')));
}

// ── THE CHARGE THIS WOULD ADD ────────────────────────────────────────────
// `why` is MANDATORY on a charge — helpers/sales.js refuses one without it,
// "that is the whole point of it being a charge and not a column". So the
// reason names the carrier and the invoice, which is exactly what a person
// reading this row in six months needs to know.
function chargeFor(rec) {
    const amount = money(rec && rec.amount);
    if (amount === null || amount <= 0) return null;
    return {
        what: FREIGHT_NAME,
        amount,
        direction: 'out',
        why: `Zimex invoice ${rec.invoice_no || '(no number)'}`
            + (rec.invoice_date ? `, ${rec.invoice_date}` : '')
            + (rec.hbl_no ? `, HBL ${rec.hbl_no}` : '') + '.',
    };
}

// ── THE PROPOSALS ────────────────────────────────────────────────────────
//
// `records` are what crossCheckZimexRecords returned. Its statuses are not the
// truckers': a Zimex row is 'match' when the PDF amount agrees with the
// sheet's Freight column within tolerance, and 'mismatch' when it does not.
//
// BOTH ARE OFFERED, and that is the one place this differs from the trucking
// side on purpose. A mismatch means the carrier billed something other than
// what the sheet says — which is precisely the figure she may need to put on
// the invoice, because the carrier's document is what she will be paying. It
// is offered WITH the delta stated, never quietly.
//
// A row that could not be read at all, or whose HBL is not on the sheet, is
// not offered: there is nothing to stand behind it.
const OFFERABLE = new Set(['match', 'mismatch']);

function proposals(records, { allSales } = {}) {
    const rows = Array.isArray(allSales) ? allSales : sales.listWithTotals();

    return (records || []).map((rec, i) => {
        const base = {
            index: i,
            carrier: 'Zimex',
            hbl_no: rec.hbl_no || null,
            container_no: rec.container_no || null,
            booking_no: rec.booking_no || null,
            invoice_no: rec.invoice_no || null,
            invoice_date: rec.invoice_date || null,
            verify_status: rec.status || null,
            // The sheet's own Freight figure and how far the PDF is from it.
            // Carried through rather than recomputed — crossCheckZimexRecords
            // already worked it out and two pieces of code deriving one number
            // is how they come to disagree.
            sheet_freight: rec.sheet && rec.sheet.freight_amt != null ? rec.sheet.freight_amt : null,
            delta: rec.delta == null ? null : rec.delta,
        };

        if (!OFFERABLE.has(rec.status)) {
            return { ...base, status: 'not_verified',
                why: 'The cross-check could not stand behind this row, so there is nothing to offer.' };
        }

        const charge = chargeFor(rec);
        if (!charge) {
            return { ...base, status: 'no_amount', why: 'No freight amount could be read off this invoice.' };
        }

        // HBL FIRST, CONTAINER AS A FALLBACK. The HBL is what a Zimex invoice
        // is organised by and what buildSheetFreightIndex keys on. Container
        // is the second-best key and is used only when the record carries no
        // HBL — reported in `matched_on` so she can see which one found it,
        // because a container match is a weaker claim than an HBL match.
        let matchedOn = null;
        let candidates = [];
        if (norm(rec.hbl_no)) {
            candidates = rows.filter((s) => norm(s.hbl_no) === norm(rec.hbl_no));
            if (candidates.length) matchedOn = 'hbl_no';
        }
        if (!candidates.length && norm(rec.container_no)) {
            candidates = rows.filter((s) => norm(s.container_no) === norm(rec.container_no));
            if (candidates.length) matchedOn = 'container_no';
        }

        if (!candidates.length) {
            return { ...base, status: 'no_sale', charge,
                why: `No invoice row carries HBL ${rec.hbl_no || '(none)'}`
                    + (rec.container_no ? ` or container ${rec.container_no}` : '') + '.' };
        }

        const shaped = candidates.map((s) => {
            const already = existingFreight(s);
            return {
                sale_id: s.id,
                date: s.date || null,
                customer: s.customer || null,
                grade: String((s.description || s.item) || '').trim() || null,
                hbl_no: s.hbl_no || null,
                container_no: s.container_no || null,
                booking_no: s.booking_no || null,
                // What is already there, so an accept is visibly a correction
                // or visibly an addition, and never a surprise duplicate.
                existing_freight: already.map((c) => ({ id: c.id, what: c.what, amount: c.amount, why: c.why })),
                // Stated rather than left to be spotted: the same rule the
                // trucking side uses — show both figures, change nothing.
                disagreement: already.length && Math.abs((already[0].amount || 0) - charge.amount) >= 0.005
                    ? { invoice: charge.amount, sale: already[0].amount,
                        delta: Math.round((charge.amount - already[0].amount) * 100) / 100 }
                    : null,
            };
        });

        return {
            ...base,
            status: candidates.length === 1 ? 'one_sale' : 'several_sales',
            matched_on: matchedOn,
            charge,
            candidates: shaped,
            why: candidates.length === 1 ? null
                : `${candidates.length} invoice rows carry this ${matchedOn === 'hbl_no' ? 'HBL' : 'container'} — `
                  + 'one per grade. The carrier billed the freight once, so it goes on one of them.',
        };
    });
}

// What the client POSTs for an accepted row: the sale's EXISTING charges with
// this freight added, or the matching one replaced. Built here rather than in
// the browser because dropping a charge by accident would delete money, and
// because helpers/salesSettlements.js pays these off BY ID — a rebuilt list
// that loses an id moves a settled payment onto an unrelated line.
function chargesToSave(sale, charge, { replaceId } = {}) {
    const existing = Array.isArray(sale && sale.charges) ? sale.charges : [];
    if (replaceId) {
        return existing.map((c) => (c && c.id === replaceId
            // The ID IS KEPT. See above — a replacement that mints a new id
            // orphans whatever has already been paid against this charge.
            ? { ...c, what: charge.what, amount: charge.amount, direction: charge.direction, why: charge.why }
            : c));
    }
    return existing.concat([charge]);
}

module.exports = { proposals, chargeFor, chargesToSave, existingFreight, FREIGHT_NAME };
