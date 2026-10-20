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
const wt = (n, unit) => (n === null || n === undefined || n === '') ? '—'
    : Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 }) + (unit ? ' ' + unit : '');
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
        kind: claimKinds.label(c.claim_type),
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
        quality_qty: nnum(c.quality_qty),
        // ── THE SORTED BREAKDOWN, 2026-10-20 ─────────────────────────────
        // Apsara: "we buy al wheel dirty.there would be claim on that like
        // clad wheel,chrome wheel,truck wheel". The whole claim IS the
        // breakdown, so a note without it is the unexplained number this
        // file already warns about.
        sorted_lines: Array.isArray(c.sorted_lines) ? c.sorted_lines : [],
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
    const lines = rows.map(line).map((l) => {
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
        const implied = qty * l.rate;
        const slack = Math.max(1, Math.abs(l.our_claim) * RECONCILE_TOL);
        if (Math.abs(implied - l.our_claim) <= slack) return l;
        return { ...l, rate: null, rate_unit: '', rate_from: '', charge_qty: null, rate_hidden: Math.round(implied * 100) / 100 };
    });
    const sendable = lines.filter((l) => l.sendable);
    const recoverable = sendable.reduce((t, l) => t + (l.our_claim || 0), 0);
    const suppliers = [...new Set(lines.map((l) => l.supplier).filter(Boolean))];

    // A line with no recovery figure on it is the one worth noticing: the claim
    // exists, the supplier is named, and nobody has said what is being recovered.
    const noFigure = sendable.filter((l) => !l.our_claim);

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
        if (l.grade_sold || l.grade_received) bits.push(`sold as ${l.grade_sold || '—'}, received as ${l.grade_received || '—'}`);
        if (l.grade_weight !== null) bits.push(`${wt(l.grade_weight, l.unit)} affected`);
        return bits.length ? `<li><span class="mono">${esc(l.container_no || '—')}</span> — ${esc(l.kind)}: ${esc(bits.join('; '))}.</li>` : '';
    }
    if (l.assessment === 'sorted') {
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
        const per = (v) => `${money(v)}/${esc(pu)}`;
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
             + `<th style="text-align:left">Material</th>`
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
        return `<li><span class="mono">${esc(l.container_no || '—')}</span> — ${esc(l.kind)}: ${esc(wt(l.quality_qty, l.unit))} claimed.</li>`;
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
    const head = ['Date', 'Container', 'What is claimed', 'Invoiced', 'Received', 'Short', '%', 'Your rate', 'Recoverable'];

    const row = (l) => `<tr${l.sendable ? '' : ' class="info"'}>
      <td>${esc(l.date)}</td>
      <td class="mono">${esc(l.container_no || '—')}</td>
      <td>${esc(l.kind)}${l.sendable ? '' : '<span class="tag">not yet verified</span>'}</td>
      ${l.assessment === 'quality' && l.quality_qty !== null
        ? `<td class="r mono" colspan="4">${esc(wt(l.quality_qty, l.unit))} claimed</td>`
        : `<td class="r mono">${esc(wt(l.invoice_weight, l.unit))}</td>
      <td class="r mono">${esc(wt(l.claimed_weight, l.unit))}</td>
      <td class="r mono">${esc(wt(l.shortage, l.unit))}</td>
      <td class="r mono">${l.shortage_pct === null ? '—' : esc(l.shortage_pct.toFixed(2)) + '%'}</td>`}
      <td class="r mono">${l.rate === null ? '—' : esc(money(l.rate)) + '/' + esc(l.rate_unit || '')}${l.rate_from ? `<div class="conv">from ${esc(l.rate_from)}</div>` : ''}${l.charge_qty === null ? '' : `<div class="conv">on ${esc(wt(l.charge_qty, l.rate_unit || ''))}</div>`}</td>
      <td class="r mono strong">${l.sendable && l.our_claim !== null ? esc(money(l.our_claim)) : '—'}</td>
    </tr>`;

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
/* ── A FILLED MASTHEAD ────────────────────────────────────────────────
   Apsara, 2026-10-21: "Fill the top".

   The band bleeds to the page edges with a negative margin against the
   body's padding, so it reads as a letterhead rather than a tinted box
   floating inside a margin.

   printBackground is already true in toPdf, so the fill survives into the
   PDF; print-color-adjust is belt and braces for the browser-print path,
   where Chromium strips backgrounds by default and would hand her a white
   band with white text on it.

   NO BACKTICKS IN THIS COMMENT. The whole stylesheet lives inside a JS
   template literal, so a backtick here terminates it and the file stops
   parsing — the same bug that broke 02-dashboard-bookings.js earlier.

   THE NEGATIVE MARGIN MUST MATCH @page, which is 14mm 12mm — 14 top and
   bottom, 12 left and right. The first draft used -14mm on all four and
   would have hung 2mm off each page edge: a horizontal overflow Chromium
   answers with a clipped band or a stray second page. */
header{display:flex;align-items:flex-start;gap:20px;background:#2E6DA4;color:#fff;
       margin:-14mm -12mm 0;padding:11mm 12mm 9mm;
       -webkit-print-color-adjust:exact;print-color-adjust:exact}
header .co{font-size:15pt;font-weight:800;letter-spacing:.02em;color:#fff}
header .sub{font-size:8pt;color:#D9E8F5;margin-top:2px}
header .right{margin-left:auto;text-align:right}
header .doc{font-size:12pt;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#fff}
header .ref{font-size:8pt;color:#D9E8F5;margin-top:3px}
.meta{display:flex;gap:30px;flex-wrap:wrap;margin:12px 0 4px}
.meta .k{font-size:7.5pt;letter-spacing:.07em;text-transform:uppercase;color:#777;margin-bottom:2px}
.lead{margin:10px 0 2px;color:#333}
table{width:100%;border-collapse:collapse}
table.sum{margin-top:10px}
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
   rule does not jump up the page when the signature is missing. */
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
  ${b.lines.some((l) => l.shortage !== null) ? `<div><div class="k">Total shortage</div><span class="mono">${esc(wt(b.totals.shortage, b.lines[0] ? b.lines[0].unit : ''))}</span></div>` : ''}
</div>

<p class="lead">The claims below were raised against material supplied by you, each one supported by the claim documents behind it, which we can forward on request. The amount shown in the final column is what we are recovering from you.</p>

<table class="sum">
  <thead><tr>${head.map((h, i) => `<th${i >= 4 ? ' class="r"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>
  <tbody>${b.lines.length ? b.lines.map(row).join('') : '<tr><td colspan="9" style="padding:16px;color:#777">No claims in this report.</td></tr>'}</tbody>
  ${b.totals.claims ? `<tfoot><tr><td colspan="8" class="r">Total recoverable</td><td class="r mono">${esc(money(b.totals.recoverable))}</td></tr></tfoot>` : ''}
</table>

${details}

<div class="total"><div class="box">
  <div class="k">Amount recoverable from you</div>
  <div class="v mono">${esc(money(b.totals.recoverable))}</div>
</div></div>

<div class="notes">
  ${b.includedUnverified && b.lines.some((l) => !l.sendable) ? '<p><strong>Lines marked “not yet verified”</strong> are shown for information only. Their figures have not yet been confirmed against the loading documents and they are excluded from the total above.</p>' : ''}
  ${b.noFigure.length ? `<p><strong>${b.noFigure.length} claim(s)</strong> in this report have no recovery amount set against them yet; they are listed so the position is complete.</p>` : ''}
  ${b.lines.some((l) => l.charge_qty !== null) ? '<p>The quantity the rate is applied to, converted into metric tonnes, is shown beneath the rate. The recoverable amount is that quantity at that rate.</p>' : ''}
  ${b.lines.some((l) => l.sendable && l.rate === null) ? '<p>Where no rate is shown, the amount is as agreed between us rather than calculated.</p>' : ''}
</div>

<div class="sign">
  <div class="for">For <strong>EDGE METALS INC</strong></div>
  <div class="sigimg">${signature.signatureBlockHtml({ height: '40px', maxHeight: '36px', justify: 'flex-start', marginBottom: '0' })}</div>
  <div class="line">${esc(SIGNATORY)}<span class="sub2">Authorised signatory</span></div>
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

module.exports = { build, toHtml, toPdf, toWorkbook, filenameFor, SENDABLE };
