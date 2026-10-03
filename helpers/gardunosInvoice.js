// ── helpers/gardunosInvoice.js — a Garduno's invoice, turned into containers ─
//
// Apsara, 2026-10-04, with "Invoice 169 REVISED.pdf": "I want to upload all
// these invoices in Edge metals trucking under gardunos like AJ Transport".
//
// ── WHY THIS IS A FILE AND NOT A LONGER PROMPT ───────────────────────────
// gemini.js's AJ Transport extractor asks the MODEL to do the attribution:
// which charge belongs to which container, and what each one sums to. That
// works, and it has two costs — the arithmetic cannot be tested without
// calling Gemini, and when it is wrong it is wrong invisibly, in money.
//
// Garduno's does not need the model for any of that. Its invoice is regular:
//
//     1. BKNG#PHX6A1731600   SMCU1176865, SMCU1033036          qty 2  $850  $1,700
//     2. BKNG#PHX6A2335700   CAIU9924305, CAIU9899394,
//                            FFAU8016428, FFAU7806670          qty 4  $850  $3,400
//     3. SCALE TICKETS                                         qty 6   $80    $480
//
// One line per BOOKING with its containers listed, at a per-container rate,
// then scale tickets for the invoice. Expanding that to six container records
// is arithmetic, and arithmetic belongs in code that the suite can run. So
// the model is asked only to READ THE LINES VERBATIM, and everything below
// this comment is a pure function over what it read.
//
// Same principle the SQL side of this codebase already states: the model
// chooses, the machine computes.

const CONTAINER_RE = /\b([A-Z]{4}\d{7})\b/g;
const BOOKING_RE = /\b(?:BKNG#?\s*)?([A-Z]{2,5}\d{6,12})\b/;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/[$,\s]/g, ''));
    return isFinite(n) ? n : null;
};

// Scale tickets, wharfage, chassis — a line with no container of its own.
// Matched on the PRODUCT/DESCRIPTION text, and deliberately narrow: an
// unrecognised chargeable line must not be silently treated as scale.
const SCALE_RE = /scale\s*ticket/i;

// ── CONTAINER NUMBERS, FROM THE DESCRIPTION ──────────────────────────────
// ISO 6346: four letters then seven digits. Taken from the description cell,
// where Garduno's lists them one per line under the booking. The booking
// itself (PHX6A1731600) does NOT match that shape, so it cannot be mistaken
// for a container — which is the only reason a single regex is safe here.
function containersIn(text) {
    const out = [];
    const seen = new Set();
    for (const m of String(text || '').matchAll(CONTAINER_RE)) {
        const c = m[1].toUpperCase();
        if (!seen.has(c)) { seen.add(c); out.push(c); }
    }
    return out;
}

function bookingIn(text) {
    const t = String(text || '').toUpperCase();
    // Prefer an explicit BKNG# marker; fall back to the first token that
    // looks like a booking and is not a container.
    const marked = /BKNG#?\s*([A-Z0-9]{6,14})/.exec(t);
    if (marked) return marked[1];
    const m = BOOKING_RE.exec(t.replace(CONTAINER_RE, ' '));
    return m ? m[1] : null;
}

// ── THE EXPANSION ────────────────────────────────────────────────────────
// Takes what the model read and returns one record per CONTAINER, plus the
// warnings a human needs to see before any of it is written.
//
// Nothing here throws on a strange invoice. A trucking invoice that does not
// fit the usual shape is a thing to look at, not a crash — and a crash would
// lose the other five containers that were fine.
function expandInvoice(extracted) {
    const warnings = [];
    const lines = Array.isArray(extracted && extracted.lines) ? extracted.lines : [];
    const invoiceNo = (extracted && extracted.invoice_no) ? String(extracted.invoice_no).trim() : null;
    const invoiceDate = (extracted && extracted.invoice_date) ? String(extracted.invoice_date).trim() : null;
    const invoiceTotal = money(extracted && extracted.total);

    // ── A REVISED INVOICE IS NOT A NEW ONE ───────────────────────────────
    // "169 REVISED" replaces an earlier "169". It is flagged and NOT acted
    // on: silently superseding a figure she has already paid against is a
    // decision, and the import is not entitled to make it.
    const revised = !!(invoiceNo && /\bREV(ISED)?\b/i.test(invoiceNo));
    if (revised) {
        warnings.push(`Invoice ${invoiceNo} is marked REVISED — it probably replaces an earlier `
            + `invoice ${invoiceNo.replace(/\s*REV(ISED)?\b/i, '').trim()}. Nothing has been superseded; `
            + 'check whether that earlier one was already entered.');
    }

    const containerLines = [];
    const scaleLines = [];
    const unknownLines = [];

    for (const raw of lines) {
        const text = [raw && raw.product, raw && raw.description].filter(Boolean).join('\n');
        const containers = containersIn(text);
        const qty = money(raw && raw.qty);
        const rate = money(raw && raw.rate);
        const amount = money(raw && raw.amount);

        if (containers.length) {
            containerLines.push({ containers, qty, rate, amount, booking_no: bookingIn(text), text });
            continue;
        }
        if (SCALE_RE.test(text)) { scaleLines.push({ qty, rate, amount, text }); continue; }
        // A chargeable line that is neither. Kept, surfaced, never guessed at.
        if (amount) unknownLines.push({ qty, rate, amount, text: String(text).split('\n')[0].slice(0, 60) });
    }

    const records = [];
    for (const line of containerLines) {
        // ── THE RATE IS PER CONTAINER, AND IT IS CHECKED ─────────────────
        // qty × rate should equal the line amount. When it does not, the
        // per-container figure is derived from the AMOUNT (the money she is
        // actually billed) rather than the rate, and it says so — a rate that
        // disagrees with its own line is exactly when a silent choice costs
        // real money.
        const { qty, rate, amount, containers } = line;
        let per = rate;
        const expected = (qty !== null && rate !== null) ? round2(qty * rate) : null;
        if (amount !== null && expected !== null && Math.abs(expected - amount) > 0.005) {
            per = round2(amount / (containers.length || 1));
            warnings.push(`Line "${(line.booking_no || line.text.split('\n')[0]).slice(0, 40)}": `
                + `qty ${qty} × $${rate} = $${expected} but the line says $${amount}. `
                + `Using $${per} per container, from the amount.`);
        } else if (per === null && amount !== null) {
            per = round2(amount / (containers.length || 1));
        }
        if (qty !== null && qty !== containers.length) {
            warnings.push(`Line "${(line.booking_no || 'booking').slice(0, 40)}": qty is ${qty} but `
                + `${containers.length} container number${containers.length === 1 ? ' is' : 's are'} listed.`);
        }
        for (const c of line.containers) {
            records.push({
                container_no: c,
                booking_no: line.booking_no || null,
                rate: per,
                amount: per,
                line_haul: per,
                extra_scale_charge: 0,
                other_charge: 0,
            });
        }
    }

    // ── SCALE TICKETS, SPLIT PER CONTAINER ───────────────────────────────
    // Her decision, 2026-10-04: $80 onto each container's extra_scale, and
    // FLAG rather than divide when the quantity and the container count
    // disagree. So this never invents a per-container figure — when the two
    // numbers do not line up the money stays visible as a warning and is not
    // attributed to anybody.
    const scaleTotal = round2(scaleLines.reduce((t, s) => t + (s.amount || 0), 0));
    const scaleQty = scaleLines.reduce((t, s) => t + (s.qty || 0), 0);
    let scaleApplied = 0;
    if (scaleLines.length) {
        if (!records.length) {
            warnings.push(`$${scaleTotal} of scale tickets on this invoice, but no containers to put them on.`);
        } else if (scaleQty && scaleQty !== records.length) {
            warnings.push(`Scale tickets: qty ${scaleQty} but ${records.length} containers on the invoice. `
                + `The $${scaleTotal} has NOT been split — say how it should land and it can be entered by hand.`);
        } else {
            const per = round2(scaleTotal / records.length);
            for (const r of records) {
                r.extra_scale_charge = per;
                r.amount = round2(r.line_haul + per);
            }
            scaleApplied = round2(per * records.length);
            // Rounding can leave a cent against the invoice; say so rather
            // than quietly forcing the last container to absorb it.
            if (Math.abs(scaleApplied - scaleTotal) > 0.005) {
                warnings.push(`Scale tickets split $${scaleTotal} across ${records.length} containers as `
                    + `$${per} each, which comes to $${scaleApplied} — ${round2(scaleTotal - scaleApplied)} off.`);
            }
        }
    }

    for (const u of unknownLines) {
        warnings.push(`Unrecognised charge line "${u.text}" for $${u.amount} — not attributed to any container.`);
    }

    // ── DOES IT ADD UP TO THE INVOICE ────────────────────────────────────
    // The one check that catches a container the model failed to read: six
    // records summing to less than the total means a line went missing, and
    // that is invisible without this.
    const recordsTotal = round2(records.reduce((t, r) => t + (r.amount || 0), 0));
    const accounted = round2(recordsTotal + (scaleApplied ? 0 : scaleTotal)
        + unknownLines.reduce((t, u) => t + (u.amount || 0), 0));
    let reconciled = null;
    if (invoiceTotal !== null) {
        reconciled = Math.abs(accounted - invoiceTotal) <= 0.02;
        if (!reconciled) {
            warnings.push(`These lines come to $${accounted} but the invoice total is $${invoiceTotal} — `
                + `$${round2(invoiceTotal - accounted)} is unaccounted for. Something was not read.`);
        }
    }

    return {
        invoice_no: invoiceNo,
        invoice_date: invoiceDate,
        invoice_total: invoiceTotal,
        revised,
        records,
        scale_total: scaleTotal,
        scale_applied: scaleApplied,
        records_total: recordsTotal,
        accounted,
        reconciled,
        warnings,
    };
}

module.exports = { expandInvoice, containersIn, bookingIn, SCALE_RE };
