// ── helpers/claims/report.js — the claim statement that goes to a supplier ────
//
// Apsara, 2026-10-03: "Next i want to create claim report option where i can
// download the report and share it with supplier."
//
// SCOPED TO A SUPPLIER, because that is who it is sent to. A customer claims
// against Edge; Edge recovers from whoever supplied the material. The number
// this document leads with is therefore **what is recoverable from the supplier
// it is addressed to**, not Edge's own exposure — that figure is Edge's business
// and has no place on a document going outside. A single container or a single
// claim can be scoped instead, for one dispute.
//
// AN UNVERIFIED CLAIM IS NOT A DEMAND. By default this includes only claims
// whose weights a person has confirmed. A claim read off a mail or a scan and not
// yet checked is a reading, not a figure, and sending it to a supplier as money
// owed is how you lose an argument you were going to win. They can be included
// deliberately, and then they are printed as "not yet verified — for information"
// and left out of the total.
//
// Rendered as HTML and printed by the same puppeteer path as the invoice and the
// ledger exports, through helpers/pdfQueue so two Chromiums never race.
const claims = require('../claims');
const claimKinds = require('../claimKinds');
const claimPrice = require('../claimPrice');
// ── HER ACTUAL SIGNATURE, THE ONE ALREADY ON HER INVOICES ────────────────
// Apsara, 2026-10-21: "You adready have my sign in jarvis".
//
// She is right, and the claim note was the ONE document not using it:
// helpers/signature.js has been signing invoices, BOLs and proformas since
// it was written, and this file drew an empty rule and a typed name.
//
// FAIL-SOFT, by that file's own design: a missing or unreadable signature
// returns an empty block of the SAME HEIGHT, so the note keeps its layout
// and the typed name and role still appear. A claim note that cannot be
// produced because an image is missing would be the worse failure.
const signature = require('../signature');

const money = (n) => (n === null || n === undefined || n === '') ? '—'
    : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// ── A RATE IS NOT AN AMOUNT, AND IT IS NOT PRINTED LIKE ONE ─────────────────
// Apsara, 2026-10-21, holding a clubbed note to Inesh Cores Chapin: "what can
// supplier infer from this". The first thing he can infer is that Edge cannot
// multiply. The line read 2,456 LB at $0.89/LB and demanded $2,193.21, and
// 2,456 x 0.89 is $2,185.84 — out by $7.37.
//
// Nothing was wrong with the money. The rate was $0.8930 and money() prints
// everything at exactly two decimals, so the page said $0.89. The supplier
// multiplies what he can SEE.
//
// So a rate keeps the precision it was recorded at, up to four places, with
// trailing zeros trimmed: $0.89 stays $0.89, $0.893 prints as $0.893,
// $0.2966 prints as $0.2966. Four, because a rate is multiplied by tens of
// thousands of pounds — the same reason helpers/claimPrice.js's blend keeps
// four. AMOUNTS still go through money(), at two places, because an amount is
// dollars and cents and always has been.
const rateMoney = (n) => {
    if (n === null || n === undefined || n === '') return '—';
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    const four = v.toFixed(4).replace(/(\.\d\d)(\d*?)0+$/, '$1$2');
    const [whole, dec] = four.split('.');
    return '$' + Number(whole).toLocaleString('en-US') + (dec ? '.' + dec : '');
};
const wt = (n, unit) => (n === null || n === undefined || n === '') ? '—'
    : Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 }) + (unit ? ' ' + unit : '');
// ── A PASTED LINK BECOMES AN <a href> IN A PDF ──────────────────────────────
// So the scheme is checked, not just escaped. esc() makes "javascript:alert(1)"
// safe as TEXT and does nothing at all to it as an href — and this string
// comes from a box a person types into, which is the definition of untrusted.
// http and https only; anything else is dropped and the block does not print.
//
// A bare "drive.google.com/..." with no scheme is a relative link inside a
// PDF, which resolves to nothing. It gets https:// rather than being refused,
// because pasting without the scheme is what people actually do.
function safeUrl(v) {
    const raw = String(v == null ? '' : v).trim();
    if (!raw) return '';
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : 'https://' + raw;
    let u;
    try { u = new URL(withScheme); } catch { return ''; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.href;
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
// Blank stays blank. num(null) is 0 — Number(null) === 0 — and a contamination
// claim, which has no shortage, printed "Short: 0 MT" and had its rate hidden as
// "not reconciling" with 0 × rate. Found by tests/claims-assess.js, 2026-10-10.
const nnum = (v) => (v === null || v === undefined || v === '' ? null : num(v));
// What the supplier's rate is applied to: the shortage on a weight claim, the
// weight that was not metal on a contamination claim. A downgrade is a price
// gap, so there is no quantity his rate applies to and the amount is agreed.
const basisOf = (c) => {
    const a = c.assessment || 'weight';
    if (a === 'contamination') return nnum(c.contaminated_weight);
    if (a === 'grade') return null;
    if (a === 'quality') return nnum(c.quality_qty);
    return nnum(c.shortage);
};

// ── WHAT SHE LABELLED IT, NOT WHAT THE ENGINE COMPUTED (2026-10-30) ──────
// Apsara: "Make the document follow the claim type you picked, so anything
// you label 'quality' gets the 8-column quality layout regardless of the
// arithmetic underneath."
//
// Inesh's DFSU1207911 is why. She classified it quality; the engine stored
// assessment 'grade', because the figure came from a price gap. The layout
// keyed off the assessment, so her quality claim printed on the nine-column
// shortage table with Short, % and his rate all dashes.
//
// This is a test of the LABEL only. It is deliberately an OR with the
// assessment, not a replacement: a claim whose arithmetic is quality keeps
// the layout it has today even if its kind is named something else, so
// nothing that prints correctly now changes.
const isQualityLine = (l) =>
    l.assessment === 'quality' || String(l.kind || '').trim().toLowerCase() === 'quality';

// What each arithmetic is called when the kind has no name of its own.
const ASSESSMENT_NAME = {
    weight: 'Shortage',
    contamination: 'Contamination',
    grade: 'Downgrade',
    quality: 'Quality',
    sorted: 'Sorted contaminants',
    damage: 'Damage',
};

const SENDABLE = ['verified', 'recovery_raised', 'settled'];

// ── WHO SIGNS THE CLAIM NOTE ─────────────────────────────────────────────
// Apsara, 2026-10-21: "Give auth sign as chandr bose".
//
// A CONSTANT, not a string buried in the template, because it is a person's
// name on a document sent to a supplier: it has to be correctable in one
// obvious place, and the next person must not have to grep the HTML to find
// out who is signing Edge's claims.
//
// SPELLING IS HERS TO CONFIRM. She typed "chandr bose"; this reads it as the
// name "Chandra Bose". A misspelt signatory on a commercial document is
// worse than none, so if that is wrong it is this one line.
//
// Env-overridable so a different signatory does not need a code change.
// ── THE ACCENT IS THE INVOICE'S BLUE, NOT A NEW ONE ──────────────────────
// Apsara, 2026-10-21: "Give color to edge metlas claim report".
//
// There is no single Edge Metals colour — her three templates each have
// their own: invoice-classic #2E6DA4 blue with #D9E8F5 tints, proforma-dc2
// #3DA836 green, bol greys. So the choice was which family this document
// belongs to, not which colour is nicest.
//
// The invoice's blue, because a claim note is commercial correspondence
// about money owed, the same family as the invoice — and because the
// proforma's green reads as "all fine", which is the wrong thing to say at
// the top of a demand. Red was considered and rejected: firm is right on a
// claim, hostile is not, and the supplier here is one she keeps buying from.
const CLAIM_ACCENT = '#2E6DA4';     // kept as a name so it is findable
const SIGNATORY = process.env.CLAIM_SIGNATORY || 'Chandra Bose';

// ── FOR THE SUPPLIER, AND ONLY THE SUPPLIER (2026-10-10) ─────────────────
// Apsara: "dont include customer info in this. i want claim report to be sent
// to supplier only. dont make it too much detailed". So there is ONE version,
// the one a supplier receives: no customer, no sell rate, no remarks, no
// document names — and for a contamination or downgrade claim, one short line
// saying what it is, not a table of everything on file.
const FINDING_LABEL = { dirt: 'Dirt / soil', rubber_plastic: 'Rubber / plastic', iron_attached: 'Iron or steel attached',
    oil_moisture: 'Oil / moisture', other_metals: 'Other metals mixed in', wood_paper: 'Wood / paper',
    sealed_hazard: 'Sealed items — radioactive or explosive' };
const MEASURED_LABEL = { surveyor: 'Independent surveyor', split_sample: 'Split sample, tested',
    sorted_weighed: 'Sorted and weighed by the receiver', photos_only: 'Receiver\u2019s photos only' };


// ── BUILD ───────────────────────────────────────────────────────────────────
// opts: { supplier, container, claimId, includeUnverified, includeSettled, from, to }
function build(opts = {}) {
    const all = claims.list();
    const supplier = String(opts.supplier || '').trim();
    const container = String(opts.container || '').trim().toUpperCase();
    const claimId = String(opts.claimId || '').trim();

    let rows = all.filter((c) => c && !['rejected', 'withdrawn'].includes(c.status));
    if (claimId) rows = rows.filter((c) => c.id === claimId);
    if (container) rows = rows.filter((c) => String(c.container_no || '').toUpperCase() === container);
    if (supplier) rows = rows.filter((c) => String(c.supplier || '').trim().toLowerCase() === supplier.toLowerCase());
    if (!opts.includeSettled) rows = rows.filter((c) => c.status !== 'settled');

    const unverified = rows.filter((c) => !SENDABLE.includes(c.status));
    if (!opts.includeUnverified) rows = rows.filter((c) => SENDABLE.includes(c.status));

    if (opts.from) rows = rows.filter((c) => String(c.created_at || '') >= String(opts.from));
    if (opts.to) rows = rows.filter((c) => String(c.created_at || '') <= String(opts.to) + 'T23:59:59Z');

    rows = rows.slice().sort((a, b) => String(a.container_no || '').localeCompare(String(b.container_no || '')));

    const line = (c) => ({
        id: c.id,
        // In order: the date on the document, the date the first mail arrived,
        // and only then the day it was filed. A statement whose every line reads
        // today's date tells the supplier nothing and reads as carelessness.
        date: String(c.claim_date || ((c.mail || [])[0] || {}).date || c.created_at || '').slice(0, 10),
        invoice_no: c.invoice_no || '',
        container_no: c.container_no || '',
        customer: c.customer || '',
        supplier: c.supplier || '',
        // ── "not classified yet" DOES NOT GO ON A DEMAND (2026-10-30) ───
        // claimKinds.label() answers 'not classified yet' for an unnamed
        // claim. That is the right words on HER screen, where it is a
        // prompt to classify it. On a document going to a supplier it
        // reads as Edge not knowing what it is claiming for.
        //
        // The assessment is always known by the time a claim is sendable —
        // it is the arithmetic that produced the figure — so the column
        // falls back to that. Only unclassified claims change; a named
        // kind still prints her own word for it.
        kind: claimKinds.label(c.claim_type) === 'not classified yet'
            ? (ASSESSMENT_NAME[c.assessment] || 'Claim')
            : claimKinds.label(c.claim_type),
        unit: c.weight_unit || '',
        invoice_weight: nnum(c.invoice_weight),
        claimed_weight: nnum(c.claimed_weight),
        shortage: nnum(c.shortage),
        shortage_pct: nnum(c.shortage_pct),
        claim_amount: nnum(c.claim_amount),
        // Their own rate, off their own bill. A recoverable figure with no rate
        // beside it is a number a supplier cannot reproduce, so the first thing
        // they do is query it. Edge's sell_price is deliberately NOT here.
        // ── THE RATE IS PRINTED IN THE UNIT IT WAS RECORDED IN (2026-10-21) ─
        // Apsara: "If i selected it as lb .i want your rate to be in lb only
        // not in mt".
        //
        // THIS REVERSES HER OWN EARLIER INSTRUCTION, and that is written down
        // rather than quietly applied. On 2026-10-14 she asked for the
        // opposite — "If price of supplier is in cents, i want it to be
        // converted to 2204.62 (mt) and then calculated" — and this block
        // converted every non-MT price to a per-MT figure with the original
        // beneath it.
        //
        // What changed in between is the sorted breakdown, which works line by
        // line in the claim's own unit. With the conversion in place the
        // document carried $3,042.38/MT in the table and $1.38/LB three
        // inches below it, both labelled "Your rate" — one price, two numbers,
        // on a page whose whole purpose is that a supplier can check the
        // arithmetic without reaching for a calculator.
        //
        // So: no conversion. The rate prints as it stands on his bill.
        // `rate_from` is now always empty — the figure IS the original — and
        // the footnote that explained the conversion went with the three
        // other notes she removed on 2026-10-20.
        //
        // Nothing here is ever the buyer's price: this is supplier_price only.
        ...(() => {
            const p = (c.assessment === 'grade') ? null : nnum(c.supplier_price);
            const u = c.supplier_price_unit || '';
            if (p === null) return { rate: null, rate_unit: '', rate_from: '' };
            return { rate: p, rate_unit: u, rate_from: '' };
        })(),
        qty_mt: (() => { const b = basisOf(c); if (b === null) return null; if (!c.weight_unit) return null;
            const q = claimPrice.toUnit(b, c.weight_unit, 'MT'); return q === null ? null : Math.round(q * 1e6) / 1e6; })(),
        basis: basisOf(c),
        // THE QUANTITY HIS RATE IS APPLIED TO, in HIS unit — and only when
        // that differs from the claim's own weights. Apsara, 2026-10-03:
        // "What if the supplier price is in lbs?" The point was never MT; it
        // was that a supplier reading a weight in one unit beside a rate in
        // another has to find 2204.62 himself to check the figure.
        //
        // Re-pointed on 2026-10-21 with the rate itself: it used to convert
        // to MT unconditionally, which — now that the rate stays in LB —
        // would print a tonne figure nothing on the page is priced in. Same
        // rule, same purpose, expressed against the rate that is actually
        // shown. Where the two units already agree there is nothing to
        // reconcile and nothing is printed.
        charge_qty: (c.supplier_price_unit && c.weight_unit && c.weight_unit !== c.supplier_price_unit)
            ? (() => { const b = basisOf(c); if (b === null) return null; const q = claimPrice.toUnit(b, c.weight_unit, c.supplier_price_unit); return q === null ? null : Math.round(q * 1000) / 1000; })()
            : null,
        our_claim: nnum(c.our_claim),
        status: c.status,
        sendable: SENDABLE.includes(c.status),
        evidence: (c.quotes && c.quotes.claim_type) ? String(c.quotes.claim_type).slice(0, 90) : '',
        note: c.note || '',
        // ── how it was assessed — safe for a supplier (2026-10-10) ──────────
        assessment: claims.ASSESSMENTS.includes(c.assessment) ? c.assessment : 'weight',
        findings: (c.findings || []).filter((f) => FINDING_LABEL[f]).map((f) => FINDING_LABEL[f]),
        measured_by: MEASURED_LABEL[c.measured_by] || '',
        contam_accepted_pct: num(c.contam_accepted_pct),
        contaminated_weight: num(c.contaminated_weight),
        grade_sold: c.grade_sold || '', grade_received: c.grade_received || '',
        grade_weight: num(c.grade_weight),
        // The two PRICES, carried 2026-10-21. Without them the note stated a
        // weight and two grade names and then demanded a figure that cannot
        // be derived from either — 2,215.64 LB "affected" and $1,041.35, with
        // the $0.42 that makes the sum work printed nowhere. Apsara, asked
        // what a grade claim should show: both prices and the difference.
        // nnum, NOT num. num() runs Number() first and Number(null) is 0, so
        // an unrecorded price came through as a real zero — and the note
        // printed "2,215.64 LB affected at $0.00/LB = $0.00", a confident
        // zero dressed up as a calculation on a document asking for money.
        // Caught by this file's own section I, which is what it is for.
        grade_price_sold: nnum(c.grade_price_sold),
        grade_price_received: nnum(c.grade_price_received),
        quality_qty: nnum(c.quality_qty),
        // ── THE SORTED BREAKDOWN, 2026-10-20 ─────────────────────────────
        // Apsara: "we buy al wheel dirty.there would be claim on that like
        // clad wheel,chrome wheel,truck wheel". The whole claim IS the
        // breakdown, so a note without it is the unexplained number this
        // file already warns about.
        sorted_lines: Array.isArray(c.sorted_lines) ? c.sorted_lines : [],
        // ── THE LINK SHE PASTES ─────────────────────────────────────────
        // Apsara, 2026-10-21: "For supoorting doc,i will just directly
        // provide gdrive link". She shares the folder or file in Drive
        // herself and pastes the link on the claim; Jarvis only prints it.
        //
        // NOT the Drive link helpers/claimEvidence.js already stores. That
        // one is a Shared-Drive webViewLink nobody has made public, and its
        // own header forbids printing it because those pages carry the
        // CUSTOMER's name. This is a separate field she fills deliberately,
        // which is the point: the sharing and the redaction are both hers.
        //
        // safeUrl() is what stops it being an injection hole — see there.
        docs_url: safeUrl(c.docs_url),
        sorted_weight: num(c.sorted_weight),
        paid_price: num(c.paid_price), paid_price_unit: c.paid_price_unit || '',
        tolerance_pct: num(c.tolerance_pct), claimable_shortage: num(c.claimable_shortage),
        // `customer` stays in the JSON the PAGE reads (the report modal shows
        // it to her). The DOCUMENT never prints it — see toHtml.
        customer: c.customer || '',
    });

    // ── THE DOCUMENT MUST NOT CONTRADICT ITSELF ────────────────────────────
    // our_claim is typed by a person, because what is recovered is negotiated.
    // The rate and the quantity are facts off the purchase bill. So the three
    // can disagree — and a statement that prints 1,521.19 LB at $0.74 next to
    // $1,131.56 hands the supplier the one thing on the page he can prove is
    // wrong, and he will use it to reopen the whole claim. Where they do not
    // reconcile, the rate comes OFF that line and it reads as an agreed amount,
    // which is what it actually is. Nothing is adjusted to make it fit.
    const RECONCILE_TOL = 0.01;   // 1%, and never less than a dollar
    let lines = rows.map(line).map((l) => {
        if (l.rate === null || !l.sendable || !l.our_claim) return l;
        // ── THE QUANTITY MUST BE IN THE RATE'S OWN UNIT (2026-10-21) ─────
        // This read l.qty_mt, which was right only while every rate was
        // printed per MT. The rate now stays in the unit it was recorded in
        // (Apsara: "i want your rate to be in lb only not in mt"), so
        // qty_mt x a per-LB rate is out by 2,204 and NOTHING would ever
        // reconcile — the rate would have been stripped off every single
        // line and each claim would have read as "an agreed amount".
        //
        // Silent, too: the figures would all still be correct, the rate
        // column would simply be empty everywhere. Caught by this file's own
        // reconciliation test, which is exactly what it is for.
        const qty = (l.basis === null || l.basis === undefined) ? null
            : (!l.unit || !l.rate_unit || l.unit === l.rate_unit) ? l.basis
            : claimPrice.toUnit(l.basis, l.unit, l.rate_unit);
        if (qty === null || qty === undefined) return l;
        // ── RECONCILE THE RATE HE CAN SEE (2026-10-21) ──────────────────
        // This used l.rate, the stored one. The document prints a FORMATTED
        // rate, and the two were not the same number: $0.8930 stored,
        // "$0.89" on the page. So the guard reconciled 2,456 x 0.893 =
        // $2,193.21, passed the line, and printed a rate that gives
        // $2,185.84 when the supplier multiplies it.
        //
        // The guard's whole purpose is the comment above — "the supplier
        // never sees a contradiction" — and it was checking a number the
        // supplier never sees. It now parses the rate back out of what is
        // actually printed, so the check and the page cannot disagree
        // again, whatever the formatter does later.
        //
        // HONESTLY: this line is NOT what fixed Inesh's note. rateMoney()
        // did. At four decimals the printed and stored rates differ by at
        // most $0.12 on a 2,456 LB line, against a 1% slack of $21.86, so no
        // realistic rate can tell them apart and no test can kill a mutation
        // that reverts this. It is here for the day somebody coarsens the
        // formatter again — which is exactly how this bug arrived.
        const shown = Number(String(rateMoney(l.rate)).replace(/[$,]/g, ''));
        if (!Number.isFinite(shown)) return l;
        const implied = qty * shown;
        const slack = Math.max(1, Math.abs(l.our_claim) * RECONCILE_TOL);
        if (Math.abs(implied - l.our_claim) <= slack) return l;
        return { ...l, rate: null, rate_unit: '', rate_from: '', charge_qty: null, rate_hidden: Math.round(implied * 100) / 100 };
    });
    // ── A CLAIM WITH NO FIGURE DOES NOT GO ON A DEMAND (2026-10-21) ──────
    // Apsara, holding a clubbed note to Inesh Cores Chapin where the first of
    // two rows was entirely dashes: "What if we have multiple claims like
    // this.Here in first row nothing was there". Asked what the note should
    // do with them, she chose: leave them off entirely.
    //
    // The reasoning, because it is not a layout preference. A row of dashes
    // does not strengthen the demand, it dilutes it — five accusations and
    // one number reads as a list of grievances rather than a documented
    // claim, and it is written evidence that Edge raises claims it has not
    // substantiated. Worse, the detail bullet under such a row carried the
    // affected weight ("2,215.64 LB affected"), which let the supplier price
    // the unquantified claim himself at his own rate: he learned his real
    // exposure while being formally asked for less.
    //
    // THEY ARE NOT LOST. They come back as `noFigure` for the SCREEN to warn
    // her with before she sends — her second choice, and the half that makes
    // this safe. Dropping them silently would let her believe a claim went
    // out when it did not.
    //
    // `!l.our_claim` is falsy for 0 as well as null, so a claim assessed at
    // exactly zero is also left off. That is deliberate and matches what the
    // figure means: nothing to recover is not something to send a demand for.
    const sendableAll = lines.filter((l) => l.sendable);
    const noFigure = sendableAll.filter((l) => !l.our_claim)
        // has_docs rides along so the screen can say the SECOND thing that
        // went with the claim. Apsara, 2026-10-21, looking for a Drive link
        // on a claim report and not finding it: a claim with no figure is
        // left off the note, and its supporting-documents link is left off
        // with it. That is the right behaviour — evidence for a claim he is
        // not being asked to pay tells him a claim is coming, which is the
        // thing leaving it off was meant to avoid — but it must not be a
        // surprise. The warning names it; it does not vanish quietly.
        .map((l) => ({ id: l.id, container_no: l.container_no, kind: l.kind, supplier: l.supplier,
            has_docs: !!l.docs_url }));

    const omit = new Set(noFigure.map((n) => n.id));
    lines = lines.filter((l) => !omit.has(l.id));

    const sendable = lines.filter((l) => l.sendable);
    const recoverable = sendable.reduce((t, l) => t + (l.our_claim || 0), 0);
    const suppliers = [...new Set(lines.map((l) => l.supplier).filter(Boolean))];

    return {
        scope: claimId ? 'claim' : container ? 'container' : supplier ? 'supplier' : 'all',
        addressedTo: supplier || (suppliers.length === 1 ? suppliers[0] : ''),
        suppliers,
        container, claimId,
        lines,
        unverifiedCount: unverified.length,
        includedUnverified: !!opts.includeUnverified,
        noFigure,
        // Lines whose rate was taken off because it did not reconcile with the
        // amount. The page warns her BEFORE the document goes out; the supplier
        // never sees a contradiction.
        notReconciled: lines.filter((l) => l.rate_hidden !== undefined)
            .map((l) => ({ invoice_no: l.invoice_no, container_no: l.container_no, our_claim: l.our_claim, atRate: l.rate_hidden })),
        totals: {
            claims: sendable.length,
            recoverable: Math.round(recoverable * 100) / 100,
            shortage: Math.round(sendable.reduce((t, l) => t + (l.shortage || 0), 0) * 1000) / 1000,
        },
        generatedAt: new Date().toISOString(),
        reference: `EMI-CLM-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${(supplier || container || 'ALL').replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase()}`,
    };
}

// ── HTML ────────────────────────────────────────────────────────────────────
// Light, printable, and plain. This leaves the building, so it looks like a trade
// document and not like the dashboard. Laid out 2026-10-10 to the design Apsara
// approved on the canvas: a summary table, then what each claim actually is.
//
// THE CUSTOMER'S NAME DOES NOT GO ON THE SUPPLIER VERSION. Apsara, 2026-10-03:
// "if there is any company name mentioned in claim email of customer, then it
// should be hided." A supplier who learns which buyer the metal ended up with can
// go to them directly. The container and Edge's invoice number identify a claim
// completely. Remarks and document names are free text that can name the
// customer too, so they are never printed at all.
//
// YOUR RATE, not ours. Apsara, 2026-10-03: "You didnt mention supplier price in
// claim?" — it is their own price off their own bill; Edge's sell rate is not on
// the supplier version.
// One line, only where the table cannot say it: what was found in a
// contamination claim, or which grades in a downgrade. A weight claim's line in
// the table already says everything.
function detailLine(l) {
    if (l.assessment === 'contamination') {
        const bits = [];
        if (l.findings.length) bits.push('found: ' + l.findings.join(', ').toLowerCase());
        if (l.contam_accepted_pct !== null) bits.push(`${l.contam_accepted_pct}% of ${wt(l.invoice_weight, l.unit)} accepted as not metal (${wt(l.contaminated_weight, l.unit)})`);
        if (l.measured_by) bits.push('measured by: ' + l.measured_by.toLowerCase());
        return bits.length ? `<li><span class="mono">${esc(l.container_no || '—')}</span> — ${esc(l.kind)}: ${esc(bits.join('; '))}.</li>` : '';
    }
    if (l.assessment === 'grade') {
        const bits = [];
        // ── THE WORKING, NOT JUST THE FINDING (2026-10-21) ──────────────
        // It used to say "sold as X, received as Y; N LB affected" and stop.
        // Two problems, both found by reading one of her real notes:
        //
        //   · The amount could not be reproduced. The sum is weight x (sold
        //     price - received price), and the received price was never on
        //     the page. The reconciliation guard then correctly STRIPPED the
        //     rate column, because weight x the bill rate is a different
        //     number — so the row showed a dash and a bare $1,041.35.
        //   · "sold as" is ambiguous. It reads either as what HE sold Edge
        //     or as what EDGE resold it as, and a supplier being asked for
        //     money will take whichever reading suits him. "Billed to us as"
        //     can only mean one thing, and it is the true one.
        //
        // The rate column is deliberately left stripped rather than being
        // re-pointed at the difference: "YOUR RATE" means the rate off his
        // own bill everywhere else on this document, and quietly making it
        // mean something else on one kind of row is how a shared column
        // starts lying.
        const gs = l.grade_price_sold, gr = l.grade_price_received;
        // ── NO PRICES IN THIS SENTENCE (2026-10-30) ─────────────────────
        // Apsara: "I dont want to disclose price billed to us as Alternator
        // at $2,600.00/LB, received as MS Scrap". Neither figure goes on a
        // supplier's copy — not the grade sold, not the grade received.
        //
        // This REPLACES the 2026-10-21 decision recorded above, which put
        // both prices here so the amount could be reproduced. It is her
        // document and her commercial relationship; the amount stays
        // reproducible from the line below, which prints the DIFFERENCE and
        // the weight. A difference on its own discloses neither price.
        if (l.grade_sold || l.grade_received) {
            bits.push(`billed to us as ${l.grade_sold || '—'}, received as ${l.grade_received || '—'}`);
        }
        // ── NO PRICE GAP, NO WORKING, ON A DOWNGRADE (2026-10-31) ──────
        // Apsara: "Remove  affected at $282.00/LB = $187.25."
        //
        // The priced form printed the DIFFERENCE between what the grade was
        // billed at and what it turned out to be worth. That difference is
        // Edge's own spread on the material: a supplier who knows what he
        // charged can read Edge's figure straight off it. It is the same
        // disclosure she took off this document on 2026-10-30 when the two
        // prices were printed outright, arriving by subtraction instead.
        //
        // This REPLACES the 2026-10-30 note above, which kept the difference
        // on the grounds that "a difference on its own discloses neither
        // price". She has now looked at the result and said to take it off,
        // so that reasoning was MINE and it was wrong.
        //
        // What is left is the affected weight, which is also the Claim column
        // of the table. The amount demanded is the figure in Recoverable; it
        // is no longer reproducible from this document, and that is the
        // deliberate trade. It does NOT touch the sorted or damage types,
        // where she asked for the calculation spelled out —
        // "We should show the calc na 2000*0.30 like that."
        if (l.grade_weight !== null) {
            bits.push(`${wt(l.grade_weight, l.unit)} affected`);
        }
        return bits.length ? `<li><span class="mono">${esc(l.container_no || '—')}</span> — ${esc(l.kind)}: ${esc(bits.join('; '))}.</li>` : '';
    }
    if (l.assessment === 'sorted' || l.assessment === 'damage') {
        // DAMAGE SHARES THIS TABLE (2026-10-21). Apsara: "if there is any
        // damage,quality,grade claim,we need to procide more details na?"
        // The arithmetic is the same — weight x (what Edge paid - what it is
        // actually worth) — so the breakdown she already approved is the
        // right shape for it. Only the column heading changes, because a
        // damaged rim is not a "material" that was sorted out, and a heading
        // that lies is the thing she rejected first time round: "What we
        // found / Weight / Price we paid you ... this is bery bad".
        const isDamage = l.assessment === 'damage';
        // ── WHY THE RATES ARE ON THE SUPPLIER'S COPY ─────────────────────
        // The claim is weight x (what Edge paid - what the material is
        // actually worth). Without both figures the supplier cannot
        // reproduce it, and this file's own rule is that a figure he cannot
        // check is a figure he queries. Same reasoning as using HIS price
        // rather than Edge's sale price: "an arithmetic a supplier can
        // reproduce and argue with on its merits".
        //
        // What stays off: `remarks`, which is free text and may name the
        // customer. That is unchanged — it was never on this document.
        if (!l.sorted_lines.length) return '';
        // ── A TABLE WITH HEADINGS, NOT A FORMULA (2026-10-21) ────────────
        // Apsara, on the inline version "2,000 LB x ($0.85 - $0.30)":
        // "Still its not easy.You dudnt mention like weight,price".
        //
        // She is right. The sum was correct and the numbers were unlabelled,
        // so a supplier had to work out for himself which figure was the
        // weight, which was his price and which was the value — on a
        // document whose whole job is that he does not have to.
        //
        // Headings do that work once, at the top of a column, instead of
        // being inferred on every line. Same reason the main table above
        // has them. The arithmetic is unchanged: Difference is price paid
        // minus worth, and Claim is weight x difference.
        const pu = l.paid_price_unit || l.unit;
        // RATES, so rateMoney, not money — see its comment. A worth of
        // $1.0475 printed as $1.05 is the Inesh defect in the sub-table.
        const per = (v) => `${rateMoney(v)}/${esc(pu)}`;
        let footed = 0;
        const rows = l.sorted_lines.map((x) => {
            // The weight is recorded in the CLAIM's unit; the price is per the
            // PURCHASE unit. Where they differ the converted weight is the one
            // multiplied, so that is the one shown, with the original beside
            // it so nothing she recorded vanishes from the document.
            const wSame = !l.unit || l.unit === pu;
            const wConv = wSame ? null : claimPrice.toUnit(x.weight, l.unit, pu);
            const wForSum = wSame ? x.weight : wConv;
            const wCell = wSame ? wt(x.weight, l.unit)
                : `${wt(wConv, pu)} <span class="conv">(${wt(x.weight, l.unit)} as recorded)</span>`;

            const worthHere = (x.worth === null || x.worth === undefined) ? null
                : (x.worth_unit && x.worth_unit !== pu
                    ? (claimPrice.toUnit(1, pu, x.worth_unit) === null ? null
                        : x.worth * claimPrice.toUnit(1, pu, x.worth_unit))
                    : x.worth);
            const diff = (l.paid_price === null) ? null
                : Math.round((l.paid_price - (worthHere === null ? 0 : worthHere)) * 10000) / 10000;

            if (x.amount != null) footed = Math.round((footed + x.amount) * 100) / 100;
            return `<tr>
              <td>${esc(x.type)}</td>
              <td class="r mono">${wCell}</td>
              <td class="r mono">${l.paid_price === null ? '&mdash;' : per(l.paid_price)}</td>
              <td class="r mono">${worthHere === null
                    ? '<span class="conv">no value</span>' : per(worthHere)}</td>
              <td class="r mono">${diff === null ? '&mdash;' : per(diff)}</td>
              <td class="r mono strong">${x.amount == null ? '&mdash;' : money(x.amount)}</td>
            </tr>`;
        }).join('');

        return `<li><span class="mono">${esc(l.container_no || '—')}</span> — ${esc(l.kind)}: `
             + `${esc(wt(l.sorted_weight, l.unit))} sorted out as not the grade supplied.`
             + `<table class="sorted" style="width:100%; margin:6px 0 2px; border-collapse:collapse">`
             + `<thead><tr>`
             // ── THE SAME WORDS AS THE TABLE ABOVE ───────────────────
             // Apsara on the first attempt — "What we found / Weight /
             // Price we paid you / What it is worth" — "this is bery bad".
             //
             // She was right and it was not a matter of taste: the main
             // table one inch above already calls these YOUR RATE and
             // RECOVERABLE, and this one had invented a second name for
             // each. Two vocabularies for the same two figures on one page
             // is worse than the unlabelled formula it replaced, because
             // now the supplier has to work out that they ARE the same.
             //
             // So the headings are taken from `head` above, not written
             // afresh. If that row is ever reworded, this one follows.
             + `<th style="text-align:left">${isDamage ? 'What was damaged' : 'Material'}</th>`
             + `<th class="r">Weight</th>`
             + `<th class="r">Your rate</th>`
             + `<th class="r">Assessed value</th>`
             + `<th class="r">Difference</th>`
             + `<th class="r">Recoverable</th>`
             + `</tr></thead><tbody>${rows}</tbody>`
             + `<tfoot><tr><td colspan="5" class="r">Total for this container</td>`
             + `<td class="r mono strong">${money(footed)}</td></tr></tfoot>`
             + `</table></li>`;
    }
    if (l.assessment === 'quality' && l.quality_qty !== null) {
        // ── WHAT WAS WRONG, AND THE SUM (2026-10-21) ─────────────────────
        // Apsara: "wh about quality claim?" This said only "2,215.64 LB
        // claimed" beside a demand for $1,971.92 — reproducible, but silent
        // on the defect, so the supplier's first reply was always "what was
        // wrong with it". The findings were on the record all along and the
        // quality branch never read them; now it does.
        //
        // The working is spelled out for the same reason as grade and
        // sorted: "We should show the calc na 2000*0.30 like that."
        const bits = [];
        // ── WHAT WE SENT AGAINST WHAT THEY RECEIVED (2026-10-30) ─────────
        // Apsara asked for these on the quality pane as optional fields.
        // They lead the sentence when both are known, because on a quality
        // claim the substitution IS the complaint — "sent X, received Y"
        // says more than any finding chip. Printed only when she filled
        // them, so a quality claim off a mail reads exactly as it did.
        //
        // These are item NAMES, never prices: no rate of Edge's reaches a
        // supplier document. Same rule as the YOUR RATE column above.
        if (l.grade_sold || l.grade_received) {
            bits.push(`sent ${l.grade_sold || '—'}, received ${l.grade_received || '—'}`);
        }
        if (l.findings.length) bits.push('found: ' + l.findings.join(', ').toLowerCase());
        if (l.rate !== null) {
            bits.push(`${wt(l.quality_qty, l.unit)} at ${rateMoney(l.rate)}/${l.rate_unit || l.unit}`
                + ` = ${money(l.our_claim)}`);
        } else {
            bits.push(`${wt(l.quality_qty, l.unit)} claimed`);
        }
        if (l.measured_by) bits.push('measured by: ' + l.measured_by.toLowerCase());
        return `<li><span class="mono">${esc(l.container_no || '—')}</span> — ${esc(l.kind)}: ${esc(bits.join('; '))}.</li>`;
    }
    return '';
}

// ── FOUR FOOTER NOTES REMOVED 2026-10-20, AT APSARA'S INSTRUCTION ───────
// She quoted them verbatim and said "Remove": the "weights are stated in the
// unit shown" note, the 1 MT = 2,204.62262 lb conversion note, the "Your
// rate" explanation, and "please confirm acceptance ... within 14 days".
//
// Recorded here rather than left to look like an accident, because they were
// added deliberately — the conversion note exists because a supplier reading
// a per-MT rate beside a per-LB purchase has to find 2204.62 himself. The
// figures those notes explained are unchanged and still on the document.
//
// THIS IS A JS COMMENT, NOT AN HTML ONE. The first version of this note was
// an <!-- --> inside the template, which put the full text of all four
// removed lines into the source of every claim note sent to a supplier —
// invisible on the page, and there for anyone who views source. A comment
// about what a document does NOT say does not belong inside that document.
//
// Four CONDITIONAL notes were not named and are untouched: unverified lines,
// claims with no figure, the MT-quantity note, and the no-rate note.
//
// ── THE "NO RECOVERY AMOUNT YET" NOTE, removed 2026-10-21 ───────────────
// It announced "N claim(s) in this report have no recovery amount set
// against them yet". Those rows are no longer printed at all (see build()),
// so the note described rows that are not there — and, worse, it told the
// supplier precisely the thing that leaving them off is meant not to tell
// him: that Edge has further claims against him it has not yet priced.
//
// AND IT IS A JS COMMENT. I first wrote this explanation as an <!-- --> in
// the template, which would have shipped that same sentence inside every
// claim note's source. That is the fourth time in one day a comment about
// what the document does not say ended up inside the document. The rule has
// not changed: nothing explaining an omission goes in the template.
//
// Her warning lives on the claims screen, from build()'s `noFigure`.
//
// ── THE LEAD PARAGRAPH, removed 2026-10-21 ──────────────────────────────
// Apsara quoted it verbatim and said "Remove": the sentence that opened the
// note, beginning "The claims below were raised against material supplied by
// you" and ending "what we are recovering from you". Its .lead CSS rule went
// with it; nothing else used the class.
//
// It was restating the table's own headings — DATE, CONTAINER, WHAT IS
// CLAIMED, RECOVERABLE, and a box already reading AMOUNT RECOVERABLE FROM
// YOU. The one thing it carried that the table does not is the offer to
// forward the backing documents. That is NOT reinstated anywhere on my own
// initiative; if it belongs on the note, it is her call where it goes.
//
// And again: A JS COMMENT. Writing this note as an <!-- --> in the template
// is how I removed the sentence while still shipping it in the source of
// every claim note — tests/claims-scan-report.js caught it, which is the
// only reason it is not on the document right now.
function toHtml(b) {
    const when = new Date(b.generatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const to = b.addressedTo || (b.suppliers.length > 1 ? `${b.suppliers.length} suppliers` : '—');
    // ── OUR INVOICE NUMBER IS NOT ON THE SUPPLIER'S COPY (2026-10-20) ───
    // Apsara: "Dont mention our invoice no in claim".
    //
    // It is Edge's reference to its CUSTOMER, and this document goes to the
    // supplier. Same rule this file already applies to `remarks`, which is
    // kept off "because a remark is free text and can name the customer".
    // The invoice number identifies the sale the way a remark names the
    // buyer, and the supplier has no use for it: he knows his material by
    // the container.
    //
    // The field is still CARRIED on the line (build() reads it, and the
    // not-reconciled warning on the page uses it) — it is only not printed.
    // ── HER COLUMNS, FOR A QUALITY-ONLY DEMAND (2026-10-30) ─────────────
    // Apsara: "Have date,container,Claim type,what we sent,what is calimed,
    // invoiced,claim,Recoverable", then "what is claimed as in item", then
    // "This sis applicable only for quality claim".
    //
    // So this is a SECOND table shape, not a replacement — and since
    // 2026-10-31 both shapes can be on the page at once, see below.
    // ── TWO TABLES, NOT ONE WITH MERGED CELLS (2026-10-31) ────────────
    // Apsara, shown MSMU1152787 (one quality claim + one weight shortage on
    // the same container): "Split the page into two tables".
    //
    // Before this, a mixed page fell back to the nine-column shortage table
    // and the quality row merged five cells into one. That cell was printed
    // in the space the header row calls INVOICED / RECEIVED / SHORT / % /
    // YOUR RATE, so a broker reading down the INVOICED column met an item
    // name. Every row now sits under headers that describe it.
    const qLines = b.lines.filter(isQualityLine);
    const oLines = b.lines.filter((l) => !isQualityLine(l));
    // `allQuality`, `head` and `rightFrom` are GONE. They chose ONE column
    // set for the whole page, which is the thing being replaced; keeping
    // them would have left two ways to decide the same question.

    // The quantity the claim is about, whichever arithmetic produced it.
    // Reading quality_qty alone left the Claim column blank on a downgrade
    // she had labelled quality — the exact claim that prompted this.
    const claimedQty = (l) => (l.quality_qty !== null && l.quality_qty !== undefined
        ? l.quality_qty
        : (l.grade_weight !== null && l.grade_weight !== undefined ? l.grade_weight
        : (l.contaminated_weight !== null && l.contaminated_weight !== undefined ? l.contaminated_weight : null)));

    // Both items are NAMES — "what is claimed as in item" — and the only
    // figures are the invoiced weight, the quantity claimed and the money.
    const qualityRow = (l) => `<tr${l.sendable ? '' : ' class="info"'}>
      <td>${esc(l.date)}</td>
      <td class="mono">${esc(l.container_no || '\u2014')}</td>
      <td>${esc(l.kind)}${l.sendable ? '' : '<span class="tag">not yet verified</span>'}</td>
      <td>${esc(l.grade_sold || '\u2014')}</td>
      <td>${esc(l.grade_received || '\u2014')}</td>
      <td class="r mono">${esc(wt(l.invoice_weight, l.unit))}</td>
      <td class="r mono">${claimedQty(l) === null ? '\u2014' : esc(wt(claimedQty(l), l.unit))}</td>
      <td class="r mono strong">${l.sendable && l.our_claim !== null ? esc(money(l.our_claim)) : '\u2014'}</td>
    </tr>`;

    // The nine-column row. Its quality branch is GONE, not disabled: quality
    // lines never reach here any more, they go to qualityRow in their own
    // table. Leaving a dead branch behind is how the next reader concludes
    // the merged cell is still a thing this document can produce.
    const row = (l) => `<tr${l.sendable ? '' : ' class="info"'}>
      <td>${esc(l.date)}</td>
      <td class="mono">${esc(l.container_no || '\u2014')}</td>
      <td>${esc(l.kind)}${l.sendable ? '' : '<span class="tag">not yet verified</span>'}</td>
      <td class="r mono">${esc(wt(l.invoice_weight, l.unit))}</td>
      <td class="r mono">${esc(wt(l.claimed_weight, l.unit))}</td>
      <td class="r mono">${esc(wt(l.shortage, l.unit))}</td>
      <td class="r mono">${l.shortage_pct === null ? '\u2014' : esc(l.shortage_pct.toFixed(2)) + '%'}</td>
      <td class="r mono">${l.rate === null ? '\u2014' : esc(rateMoney(l.rate)) + '/' + esc(l.rate_unit || '')}${l.rate_from ? `<div class="conv">from ${esc(l.rate_from)}</div>` : ''}${l.charge_qty === null ? '' : `<div class="conv">on ${esc(wt(l.charge_qty, l.rate_unit || ''))}</div>`}</td>
      <td class="r mono strong">${l.sendable && l.our_claim !== null ? esc(money(l.our_claim)) : '\u2014'}</td>
    </tr>`;

    // One table. `caption` is printed only when BOTH are on the page — a
    // single-kind demand gets no heading it does not need.
    const tableOf = (lines, cols, firstRight, mk, caption) => !lines.length ? '' : `
${caption ? `<div class="tcap">${esc(caption)}</div>` : ''}
<table class="sum">
  <thead><tr>${cols.map((h, i) => `<th${i >= firstRight ? ' class="r"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>
  <tbody>${lines.map(mk).join('')}</tbody>
</table>`;

    const QHEAD = ['Date', 'Container', 'Claim type', 'What we sent', 'What is claimed', 'Invoiced', 'Claim', 'Recoverable'];
    const OHEAD = ['Date', 'Container', 'What is claimed', 'Invoiced', 'Received', 'Short', '%', 'Your rate', 'Recoverable'];
    const split = qLines.length > 0 && oLines.length > 0;
    const tables = b.lines.length
        ? tableOf(qLines, QHEAD, 5, qualityRow, split ? 'Quality claims' : '')
          + tableOf(oLines, OHEAD, 3, row, split ? 'Weight, contamination and other claims' : '')
        : `<table class="sum"><tbody><tr><td style="padding:16px;color:#777">No claims in this report.</td></tr></tbody></table>`;

    const notesOn = b.lines.map(detailLine).filter(Boolean);
    const details = notesOn.length ? `<ul class="what">${notesOn.join('')}</ul>` : '';

    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(b.reference)}</title>
<style>
@page { size: Letter; margin: 14mm 12mm; }
.conv{font-size:8px;color:#777;font-weight:400;letter-spacing:0}
*{box-sizing:border-box}
body{margin:0;font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;color:#1a1a1a;font-size:8.6pt;line-height:1.45}
.mono{font-family:"SF Mono",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
.r{text-align:right}.strong{font-weight:700}
/* ── A FILLED MASTHEAD, INSIDE THE PAGE BOX ───────────────────────────
   Apsara, 2026-10-21: "Fill the top" — then, on the PDF: "WHat the hell".

   The first version bled to the paper edges with margin:-14mm -12mm against
   @page's 14mm 12mm. In a browser that is fine, and it looked right in the
   preview. In a PRINT context it is not: Chromium clips everything outside
   the page margin box, and the band's own text went with it — EDGE METALS
   INC and CLAIM REPORT sheared off at the top, the reference cut off at the
   right. Every figure on the page was correct; the letterhead was
   decapitated.

   Full bleed in Chromium needs @page { margin: 0 } with every margin moved
   onto the content, which costs the per-page margins from page two onward
   of a multi-container report. Not worth it for a tint.

   So the band fills the CONTENT width and stops at the margin. Nothing can
   be clipped because nothing sits outside the box.

   AND THE LESSON, left where the next person will need it: this file renders
   to PDF. A browser preview does not exercise @page at all, so a change to
   the masthead, the margins, or anything full-width must be checked on the
   generated PDF — not on the HTML. */
header{display:flex;align-items:flex-start;gap:20px;background:#2E6DA4;color:#fff;
       padding:7mm 7mm 6mm;
       -webkit-print-color-adjust:exact;print-color-adjust:exact}
header .co{font-size:15pt;font-weight:800;letter-spacing:.02em;color:#fff}
header .sub{font-size:8pt;color:#D9E8F5;margin-top:2px}
header .right{margin-left:auto;text-align:right}
header .doc{font-size:12pt;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#fff}
header .ref{font-size:8pt;color:#D9E8F5;margin-top:3px}
.meta{display:flex;gap:30px;flex-wrap:wrap;margin:12px 0 4px}
.meta .k{font-size:7.5pt;letter-spacing:.07em;text-transform:uppercase;color:#777;margin-bottom:2px}
/* .lead is gone with the paragraph it styled (2026-10-21). Nothing else in
   this document uses it — leaving the rule behind would invite someone to
   hang new prose on a class she asked to be emptied. */
table{width:100%;border-collapse:collapse}
table.sum{margin-top:10px}
table.sum.grand{margin-top:0}
/* The heading above each table on a MIXED page. Small and quiet: it labels
   the rows under it, it is not a section title competing with the masthead. */
.tcap{margin-top:14px;font-size:7.5pt;letter-spacing:.07em;text-transform:uppercase;color:#1F4E79;font-weight:700}
/* A date must not break across two lines — it did on the mixed page. */
table.sum td:first-child{white-space:nowrap}
th{text-align:left;font-size:7pt;letter-spacing:.05em;text-transform:uppercase;color:#1F4E79;border-bottom:1px solid #2E6DA4;padding:5px 5px;white-space:nowrap;background:#D9E8F5}
th.r{text-align:right}
td{padding:5px 5px;border-bottom:1px solid #e4e4e4;vertical-align:top}
tr.info td{color:#777;font-style:italic}
.tag{display:inline-block;margin-left:6px;font-size:7pt;font-style:normal;border:1px solid #bbb;border-radius:2px;padding:0 4px;color:#777}
tfoot td{border-top:2px solid #2E6DA4;border-bottom:0;padding-top:7px;font-weight:700}
.what{margin:10px 0 0;padding-left:18px;color:#333}
.what li{margin:0 0 3px}
.total{margin-top:14px;display:flex;justify-content:flex-end}
.total .box{border:1.5px solid #2E6DA4;background:#F4F9FD;padding:9px 16px;text-align:right;min-width:230px}
.total .k{font-size:7.5pt;letter-spacing:.07em;text-transform:uppercase;color:#1F4E79}
.total .v{font-size:15pt;font-weight:800;margin-top:2px}
/* The .docs block: files she ticked for this claim. Links are printed in the
   accent blue and always underlined, never hover-only — this renders to PDF
   and to paper, where colour and a rule are the only signals that a line can
   be clicked. The raw URL under each one is for the printed copy.

   DELIBERATELY DOES NOT SPELL OUT THE BLOCK'S HEADING. A comment in here is
   a comment inside the rendered document: the style tag ships. Writing the
   heading text in this comment made the block's own "is it present" check
   match on the comment and pass with the block absent — the third time in
   one day that a comment about the document ended up inside it. */
.docs{margin-top:16px;border-top:1px solid #ddd;padding-top:9px}
.docs .k{font-size:7.5pt;letter-spacing:.07em;text-transform:uppercase;color:#1F4E79;margin-bottom:5px}
.docs ul{margin:0;padding:0 0 0 15px;font-size:8.6pt}
.docs li{margin:0 0 5px}
.docs a{color:#2E6DA4;text-decoration:underline;font-weight:600}
.docs .exp{color:#777;font-size:7.6pt;margin-left:7px}
.docs .raw{color:#999;font-size:7pt;word-break:break-all;margin-top:1px}
.notes{margin-top:16px;font-size:7.8pt;color:#555;border-top:1px solid #ddd;padding-top:9px}
.notes p{margin:0 0 5px}
.sign{margin-top:22px;display:flex;justify-content:space-between;align-items:flex-end}
.sign .for{font-size:8.5pt}
/* ── THE SIGNATURE SITS ABOVE THE RULE (2026-10-21) ──────────────────
   Apsara: "Also sign should come above under line right".

   It was inside .line, whose border-top IS the rule — so her signature
   printed UNDER the line it is meant to be written on. The image is its
   own block above it now; .line keeps the rule and carries the typed name
   and role beneath, which is the order on every signed document.

   The image block holds its height whether or not the file is readable
   (helpers/signature.js returns an empty block of the same size), so the
   rule does not jump up the page when the signature is missing.

   2026-10-21, second pass: making .sigimg a block ABOVE .line was not
   enough. .sign is a flex ROW with space-between, so the image and the
   rule were SIBLINGS — the image landed in the middle of the page and the
   rule on the right, and the signature was beside the line, not on it.
   .sigcol is the column that makes "above" mean above: the two share one
   190px stack, so they move together and cannot drift apart again. */
.sign .sigcol{width:190px}
.sign .sigimg{width:190px;margin-top:30px}
.sign .line{border-top:1px solid #2E6DA4;width:190px;padding-top:4px;font-size:8pt;color:#555}
  /* The sorted-contaminant breakdown. A SUB-table: lighter than the main
     one so the eye still reads the claim table as the document's spine,
     but with real headings, because Apsara's note on the unlabelled
     version was "You dudnt mention like weight,price". */
  .sign .sub2 { display:block; font-size:10px; letter-spacing:.04em; text-transform:uppercase; color:#666; margin-top:2px; }
  table.sorted { font-size: 11px; }
  table.sorted th { border-bottom: 1px solid #B9D4EC; background:#EDF4FB; padding: 3px 6px; font-size: 10px;
                    letter-spacing: .04em; text-transform: uppercase; color: #1F4E79; font-weight: 600; }
  table.sorted td { border-bottom: 1px solid #f0f0f0; padding: 3px 6px; }
  table.sorted tfoot td { border-top: 1px solid #2E6DA4; border-bottom: none; font-weight: 600; }
  table.sorted .strong { font-weight: 700; }
</style></head><body>
<header>
  <div>
    <div class="co">EDGE METALS INC</div>
    <div class="sub">Los Angeles, California, USA</div>
  </div>
  <div class="right">
    <div class="doc">Claim Report</div>
    <div class="ref mono">${esc(b.reference)}</div>
    <div class="ref">${esc(when)}</div>
  </div>
</header>

<div class="meta">
  <div><div class="k">To</div><strong>${esc(to)}</strong></div>
  ${b.container ? `<div><div class="k">Container</div><span class="mono">${esc(b.container)}</span></div>` : ''}
  <div><div class="k">Claims</div>${b.totals.claims}</div>
  ${/* A quality, quality or downgrade claim has no shortage, and verify()
       records 0 when the weights agree — so this printed "Total shortage
       0 LB" at the top of a demand where nothing was short. A zero is not
       a fact worth leading with. (2026-10-30) */
     (Number(b.totals.shortage) || 0) > 0 ? `<div><div class="k">Total shortage</div><span class="mono">${esc(wt(b.totals.shortage, b.lines[0] ? b.lines[0].unit : ''))}</span></div>` : ''}
</div>


${tables}
${b.totals.claims ? `<table class="sum grand"><tfoot><tr><td class="r">Total recoverable</td><td class="r mono" style="width:120px">${esc(money(b.totals.recoverable))}</td></tr></tfoot></table>` : ''}

${details}

<div class="total"><div class="box">
  <div class="k">Amount recoverable from you</div>
  <div class="v mono">${esc(money(b.totals.recoverable))}</div>
</div></div>

${(() => {
    // ── THE DOCUMENTS BEHIND THE CLAIM ──────────────────────────────────
    // Apsara, 2026-10-21: "For supoorting doc,i will just directly provide
    // gdrive link". One link per claim, pasted by her, printed as a real
    // <a href> — Chromium keeps anchors as PDF link annotations, so it is
    // clickable in the generated file.
    //
    // The URL is also shown in full underneath. This gets printed and read
    // on phones that will not follow a link, and a supplier who cannot see
    // where a link goes does not click it.
    //
    // Deduplicated: a clubbed note carries several claims on one container
    // and she will often paste the same folder on each of them. Printing
    // the same link four times reads as padding.
    const seen = new Set();
    const rows = b.lines
        .filter((l) => l.docs_url && !seen.has(l.docs_url) && seen.add(l.docs_url))
        .map((l) => `
      <li><a href="${esc(l.docs_url)}">${esc(l.container_no || 'Supporting documents')}</a>
          <div class="raw mono">${esc(l.docs_url)}</div></li>`).join('');
    if (!rows) return '';
    return `<div class="docs">
  <div class="k">Supporting documents</div>
  <ul>${rows}</ul>
</div>`;
})()}

<div class="notes">
  ${b.includedUnverified && b.lines.some((l) => !l.sendable) ? '<p><strong>Lines marked “not yet verified”</strong> are shown for information only. Their figures have not yet been confirmed against the loading documents and they are excluded from the total above.</p>' : ''}
  ${b.lines.some((l) => l.charge_qty !== null) ? '<p>The quantity the rate is applied to, converted into metric tonnes, is shown beneath the rate. The recoverable amount is that quantity at that rate.</p>' : ''}
</div>

<div class="sign">
  <div class="for">For <strong>EDGE METALS INC</strong></div>
  <div class="sigcol">
    <div class="sigimg">${signature.signatureBlockHtml({ height: '40px', maxHeight: '36px', justify: 'flex-start', marginBottom: '0' })}</div>
    <div class="line">${esc(SIGNATORY)}<span class="sub2">Authorised signatory</span></div>
  </div>
</div>
</body></html>`;
}

// ── PDF ─────────────────────────────────────────────────────────────────────
async function toPdf(built, opts = {}) {
    const html = toHtml(built);
    if (opts.renderer) return opts.renderer(html);
    return require('../pdfQueue').run(async () => {
        // A tab in WhatsApp's Chromium — see helpers/pdfBrowser.js.
        return require('../pdfBrowser').withPage(async (page) => {
            await page.setContent(html, { waitUntil: 'networkidle0' });
            const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
            return Buffer.from(pdf);
        });
    }, `claim report ${built.reference}`);
}

// ── XLSX ────────────────────────────────────────────────────────────────────
// Suppliers argue line by line, and a spreadsheet is what they argue in.
async function toWorkbook(built) {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Claim report');
    ws.addRow(['EDGE METALS INC — CLAIM REPORT']);
    ws.addRow(['Authorised signatory', SIGNATORY]);
    ws.addRow([built.reference, new Date(built.generatedAt).toLocaleDateString('en-US')]);
    ws.addRow(['To', built.addressedTo || '']);
    ws.addRow([]);
    // Same rule as the PDF: this file is sent to the supplier, so no customer.
    ws.addRow(['Date', 'Container', 'What is claimed', 'Unit',
        'Invoiced weight', 'Received weight', 'Shortage', 'Shortage %', 'Charged quantity', 'Your rate', 'Rate per', 'Recoverable from you', 'Status']);
    for (const l of built.lines) {
        ws.addRow([l.date, l.container_no, l.kind + (l.sendable ? '' : ' (not yet verified)'),
            l.unit, l.invoice_weight, l.claimed_weight, l.shortage, l.shortage_pct,
            l.qty_mt !== null && l.qty_mt !== undefined ? l.qty_mt : (l.charge_qty === null ? l.shortage : l.charge_qty), l.rate, l.rate_unit,
            l.sendable ? l.our_claim : null, l.status]);
    }
    ws.addRow([]);
    ws.addRow(['', '', '', '', '', '', '', '', '', '', '', 'Total recoverable', built.totals.recoverable]);
    ws.getRow(1).font = { bold: true, size: 13 };
    ws.getRow(5).font = { bold: true };
    ws.columns.forEach((c) => { c.width = 17; });
    return Buffer.from(await wb.xlsx.writeBuffer());
}

function filenameFor(built, ext) {
    const when = new Date(built.generatedAt).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const who = (built.addressedTo || built.container || 'all').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'all';
    return `Claim-report_${who}_${when}.${ext}`;
}

module.exports = { build, toHtml, toPdf, toWorkbook, filenameFor, SENDABLE, safeUrl };
