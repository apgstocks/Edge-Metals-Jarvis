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
    return nnum(c.shortage);
};

const SENDABLE = ['verified', 'recovery_raised', 'settled'];

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
        rate: (c.assessment === 'grade') ? null : nnum(c.supplier_price),
        rate_unit: (c.assessment === 'grade') ? '' : (c.supplier_price_unit || ''),
        basis: basisOf(c),
        // THE RATE IS OFTEN PER POUND WHILE THE CLAIM IS IN TONNES. Apsara,
        // 2026-10-03: "What if the supplier price is in lbs?" — the conversion
        // was already right in the code and wrong on the DOCUMENT: a supplier
        // reading "1.922 MT short" beside "$0.81/LB" has to find 2204.62 for
        // himself to check the amount, which is the same unexplained number
        // this column was added to remove. So the quantity his rate is applied
        // to is printed next to it, and only when the units actually differ —
        // the claim's own weights are left exactly as recorded.
        charge_qty: (c.supplier_price_unit && c.weight_unit && c.supplier_price_unit !== c.weight_unit)
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
        const qty = l.charge_qty === null ? l.basis : l.charge_qty;
        if (qty === null) return l;
        const implied = qty * l.rate;
        const slack = Math.max(1, Math.abs(l.our_claim) * RECONCILE_TOL);
        if (Math.abs(implied - l.our_claim) <= slack) return l;
        return { ...l, rate: null, rate_unit: '', charge_qty: null, rate_hidden: Math.round(implied * 100) / 100 };
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
        return bits.length ? `<li><span class="mono">${esc(l.container_no || l.invoice_no || '—')}</span> — ${esc(l.kind)}: ${esc(bits.join('; '))}.</li>` : '';
    }
    if (l.assessment === 'grade') {
        const bits = [];
        if (l.grade_sold || l.grade_received) bits.push(`sold as ${l.grade_sold || '—'}, received as ${l.grade_received || '—'}`);
        if (l.grade_weight !== null) bits.push(`${wt(l.grade_weight, l.unit)} affected`);
        return bits.length ? `<li><span class="mono">${esc(l.container_no || l.invoice_no || '—')}</span> — ${esc(l.kind)}: ${esc(bits.join('; '))}.</li>` : '';
    }
    return '';
}

function toHtml(b) {
    const when = new Date(b.generatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const to = b.addressedTo || (b.suppliers.length > 1 ? `${b.suppliers.length} suppliers` : '—');
    const head = ['Date', 'Our invoice', 'Container', 'What is claimed', 'Invoiced', 'Received', 'Short', '%', 'Your rate', 'Recoverable'];

    const row = (l) => `<tr${l.sendable ? '' : ' class="info"'}>
      <td>${esc(l.date)}</td>
      <td class="mono">${esc(l.invoice_no || '—')}</td>
      <td class="mono">${esc(l.container_no || '—')}</td>
      <td>${esc(l.kind)}${l.sendable ? '' : '<span class="tag">not yet verified</span>'}</td>
      <td class="r mono">${esc(wt(l.invoice_weight, l.unit))}</td>
      <td class="r mono">${esc(wt(l.claimed_weight, l.unit))}</td>
      <td class="r mono">${esc(wt(l.shortage, l.unit))}</td>
      <td class="r mono">${l.shortage_pct === null ? '—' : esc(l.shortage_pct.toFixed(2)) + '%'}</td>
      <td class="r mono">${l.rate === null ? '—' : esc(money(l.rate)) + '/' + esc(l.rate_unit || '')}${l.charge_qty === null ? '' : `<div class="conv">on ${esc(wt(l.charge_qty, l.rate_unit))}</div>`}</td>
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
header{display:flex;align-items:flex-start;gap:20px;border-bottom:2px solid #1a1a1a;padding-bottom:10px}
header .co{font-size:15pt;font-weight:800;letter-spacing:.02em}
header .sub{font-size:8pt;color:#555;margin-top:2px}
header .right{margin-left:auto;text-align:right}
header .doc{font-size:12pt;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
header .ref{font-size:8pt;color:#555;margin-top:3px}
.meta{display:flex;gap:30px;flex-wrap:wrap;margin:12px 0 4px}
.meta .k{font-size:7.5pt;letter-spacing:.07em;text-transform:uppercase;color:#777;margin-bottom:2px}
.lead{margin:10px 0 2px;color:#333}
table{width:100%;border-collapse:collapse}
table.sum{margin-top:10px}
th{text-align:left;font-size:7pt;letter-spacing:.05em;text-transform:uppercase;color:#555;border-bottom:1px solid #999;padding:5px 5px;white-space:nowrap;background:#f1f3f4}
th.r{text-align:right}
td{padding:5px 5px;border-bottom:1px solid #e4e4e4;vertical-align:top}
tr.info td{color:#777;font-style:italic}
.tag{display:inline-block;margin-left:6px;font-size:7pt;font-style:normal;border:1px solid #bbb;border-radius:2px;padding:0 4px;color:#777}
tfoot td{border-top:2px solid #1a1a1a;border-bottom:0;padding-top:7px;font-weight:700}
.what{margin:10px 0 0;padding-left:18px;color:#333}
.what li{margin:0 0 3px}
.total{margin-top:14px;display:flex;justify-content:flex-end}
.total .box{border:1.5px solid #1a1a1a;padding:9px 16px;text-align:right;min-width:230px}
.total .k{font-size:7.5pt;letter-spacing:.07em;text-transform:uppercase;color:#555}
.total .v{font-size:15pt;font-weight:800;margin-top:2px}
.notes{margin-top:16px;font-size:7.8pt;color:#555;border-top:1px solid #ddd;padding-top:9px}
.notes p{margin:0 0 5px}
.sign{margin-top:22px;display:flex;justify-content:space-between;align-items:flex-end}
.sign .for{font-size:8.5pt}
.sign .line{border-top:1px solid #1a1a1a;width:190px;margin-top:34px;padding-top:4px;font-size:8pt;color:#555}
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
  <tbody>${b.lines.length ? b.lines.map(row).join('') : '<tr><td colspan="10" style="padding:16px;color:#777">No claims in this report.</td></tr>'}</tbody>
  ${b.totals.claims ? `<tfoot><tr><td colspan="9" class="r">Total recoverable</td><td class="r mono">${esc(money(b.totals.recoverable))}</td></tr></tfoot>` : ''}
</table>

${details}

<div class="total"><div class="box">
  <div class="k">Amount recoverable from you</div>
  <div class="v mono">${esc(money(b.totals.recoverable))}</div>
</div></div>

<div class="notes">
  ${b.includedUnverified && b.lines.some((l) => !l.sendable) ? '<p><strong>Lines marked “not yet verified”</strong> are shown for information only. Their figures have not yet been confirmed against the loading documents and they are excluded from the total above.</p>' : ''}
  ${b.noFigure.length ? `<p><strong>${b.noFigure.length} claim(s)</strong> in this report have no recovery amount set against them yet; they are listed so the position is complete.</p>` : ''}
  <p>Weights are stated in the unit shown against each line, exactly as recorded on the claim documents. No conversion has been applied to them.</p>
  ${b.lines.some((l) => l.charge_qty !== null) ? '<p>Where our purchase rate is per a different unit, the shortage converted into that unit is shown beneath the rate, at 1 MT = 2,204.62262 lb. The recoverable amount is that quantity at that rate.</p>' : ''}
  ${b.lines.some((l) => l.rate !== null) ? '<p><strong>“Your rate”</strong> is the price on our purchase bill for that container — the rate we paid you for the material. Each recoverable amount is the shortage at that rate.</p>' : ''}
  ${b.lines.some((l) => l.sendable && l.rate === null) ? '<p>Where no rate is shown, the amount is as agreed between us rather than calculated.</p>' : ''}
  <p>Please confirm acceptance or raise any query within 14 days of the date of this report.</p>
</div>

<div class="sign">
  <div class="for">For <strong>EDGE METALS INC</strong></div>
  <div class="line">Authorised signatory</div>
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
    ws.addRow([built.reference, new Date(built.generatedAt).toLocaleDateString('en-US')]);
    ws.addRow(['To', built.addressedTo || '']);
    ws.addRow([]);
    // Same rule as the PDF: this file is sent to the supplier, so no customer.
    ws.addRow(['Date', 'Our invoice', 'Container', 'What is claimed', 'Unit',
        'Invoiced weight', 'Received weight', 'Shortage', 'Shortage %', 'Charged quantity', 'Your rate', 'Rate per', 'Recoverable from you', 'Status']);
    for (const l of built.lines) {
        ws.addRow([l.date, l.invoice_no, l.container_no, l.kind + (l.sendable ? '' : ' (not yet verified)'),
            l.unit, l.invoice_weight, l.claimed_weight, l.shortage, l.shortage_pct,
            l.charge_qty === null ? l.shortage : l.charge_qty, l.rate, l.rate_unit,
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
