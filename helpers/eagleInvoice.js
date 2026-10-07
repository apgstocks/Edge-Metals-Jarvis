// ── helpers/eagleInvoice.js — Eagle Trans Shipping & Logistics invoices ──────
// Apsara, 2026-10-07: "yes.build" — a Verify tab for Eagle Trans (EagleBrit),
// the ocean-freight forwarder that bills Edge Metals as XSINV/nnnnnn.
//
// Pure: a transcription in, plain records out. No Gemini, no sheet, no store —
// so the arithmetic runs in the suite. The model's only job (see
// extractEagleInvoiceRecords) is to copy what is printed.
//
// ── ONE RECORD PER INVOICE, NOT PER CONTAINER ──────────────────────────────
// Eagle bills a booking as a whole: XSINV/170815 is $5,970 for FOUR containers
// with no per-container figure. Dividing it would invent four amounts that
// appear nowhere on the document. So a record is the invoice, carrying its
// containers as a list; the cross-check asks of each container whether it is
// on her sheet.
//
// ── A CREDIT NOTE IS NOT AN INVOICE ────────────────────────────────────────
// XSCRN/015704 (−$2,180) cancelled XSINV/171581 (+$2,180) the next day. It is
// kept, signed negative, and flagged `kind: 'credit_note'`; treating it as a
// second invoice would double what she owes by twice the amount.
//
// ── THIS DOES NOT DECIDE WHERE THE MONEY GOES ──────────────────────────────
// Nothing here writes to a bill, a sale or the sheet. Eagle is ocean freight
// like Zimex, but whether it lands as a charge on the sale (Zimex's route) is
// hers to say.

const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};
const norm = (v) => String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, '');
const CONTAINER = /^[A-Z]{4}\d{7}$/;

function normalize(extracted, sourceFile) {
    const ex = extracted || {};
    const warnings = [];
    const invoiceNo = String(ex.invoice_no || '').trim() || null;
    const kind = /^XSCRN/i.test(invoiceNo || '') || /credit/i.test(String(ex.document_type || '')) ? 'credit_note' : 'invoice';
    const containers = [...new Set((Array.isArray(ex.containers) ? ex.containers : []).map(norm).filter(Boolean))];
    const badShape = containers.filter((c) => !CONTAINER.test(c));
    if (badShape.length) warnings.push(`container(s) not in the usual 4-letters + 7-digits form: ${badShape.join(', ')}`);
    const charges = (Array.isArray(ex.charges) ? ex.charges : []).map((c) => ({ description: String(c && c.description || '').trim(), amount: num(c && c.amount) })).filter((c) => c.amount !== null);
    const printedTotal = num(ex.total_due);
    const chargesSum = Math.round(charges.reduce((a, c) => a + c.amount, 0) * 100) / 100;
    // The printed total is the figure she owes; the charge lines are only a cross-check on the read.
    const reconciled = printedTotal !== null && charges.length > 0 ? Math.abs(chargesSum - printedTotal) < 0.01 : null;
    if (reconciled === false) warnings.push(`charge lines add to ${chargesSum} but the invoice says ${printedTotal} — something was not read`);
    if (printedTotal === null) warnings.push('no total due found');
    if (kind === 'invoice' && printedTotal !== null && printedTotal < 0) warnings.push('negative total on a document that is not a credit note');
    if (kind === 'credit_note' && printedTotal !== null && printedTotal > 0) warnings.push('credit note with a positive total');
    return {
        record: {
            invoice_no: invoiceNo, kind,
            invoice_date: ex.invoice_date || null,
            booking_no: norm(ex.booking_no) || null,
            job_ref: norm(ex.job_ref) || null,
            mbl: norm(ex.mbl) || null, hbl: norm(ex.hbl) || null,
            containers, charges, amount: printedTotal,
            currency: String(ex.currency || 'USD').toUpperCase(),
            reconciled, source_file: sourceFile || null,
        },
        warnings,
    };
}

// Ties credit notes to the invoice they cancel: same booking and containers, equal and
// opposite amount. Returns { net, cancelled: [{ invoice, credit_note }] }. Report-only.
function pairCredits(records) {
    const recs = (records || []).filter((r) => r && r.amount !== null && r.amount !== undefined);
    const key = (r) => `${r.booking_no || ''}|${[...(r.containers || [])].sort().join(',')}`;
    const used = new Set(), cancelled = [];
    for (const cn of recs.filter((r) => r.kind === 'credit_note')) {
        const inv = recs.find((r) => r.kind === 'invoice' && !used.has(r) && key(r) === key(cn) && Math.abs(r.amount + cn.amount) < 0.01);
        if (inv) { used.add(inv); cancelled.push({ invoice: inv.invoice_no, credit_note: cn.invoice_no, amount: inv.amount }); }
    }
    const net = Math.round(recs.reduce((a, r) => a + r.amount, 0) * 100) / 100;
    return { net, cancelled };
}

module.exports = { normalize, pairCredits, num, norm };
