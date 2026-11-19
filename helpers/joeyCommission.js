// ── helpers/joeyCommission.js — verify Joey's (Hynos) commission invoice ─────
// Apsara, 2026-11-20, sending his invoice (EM-261014-01) and his Commission
// List: "similar to pan metals .. build for joey". The Verification tab already
// had a Joey sub-tab, a placeholder (documents.html), and a register for his
// invoices (helpers/partyInvoices.js). This is the check behind it.
//
// HOW IT DIFFERS FROM PAN METAL, read off his real files:
//   - his invoice is keyed by CONTAINER and CONTRACT NO ("26JY41"), not by an
//     order code embedded in our Inv No.;
//   - one container can carry TWO lines (AL combo + regular combo, or a 2.000
//     MT top-up line), each at its own rate ($10 or $5 per MT);
//   - there are claim lines ("Deduct Claim (US$200.00)") that reduce the total.
// So each invoice line is matched to OUR sheet rows for that container by
// weight, and our weight x our rate is compared with what he billed. The rate
// on our sheet wins; if our rate is blank his is used and the line says so —
// same rule as Pan Metal.
//
// The Commission List (xlsx) is HIS record of the same lines. When supplied,
// each invoice line is also checked against it, so a line he invoiced that is
// not on his own list shows up.
//
// READ ONLY: nothing here writes. Everything is injectable so it can be tested
// without Google or Gemini.
const COMMISSION_TOLERANCE = 0.05;   // cents of rounding, not a real miss. His
                                     // invoice rounds 4.199 MT x $5 up to $21.00.
const WEIGHT_TOLERANCE = 0.0051;     // MT is quoted to 3 decimals

const str = (v) => (v == null ? '' : String(v).trim());
const money = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[,$()]/g, '')); return Number.isFinite(n) ? n : null; };
const r2 = (n) => Math.round(n * 100) / 100;
const cont = (v) => str(v).toUpperCase().replace(/[^A-Z0-9]/g, '');

// ── our Invoice sheet, by container ───────────────────────────────────────
function indexSheet(headers, rows, invoiceSheet) {
    const colMap = invoiceSheet.buildColumnMap(headers);
    const byContainer = new Map();
    const all = [];
    for (const row of rows) {
        const d = invoiceSheet.rowToDict(row, colMap);
        const c = cont(d.container_no);
        if (!c) continue;
        const rec = { container_no: c, inv_no: str(d.inv_no), consignee: str(d.consignee),
                      weight: money(d.weight), commission_rate: money(d.commission_rate), commission_amt: money(d.commission_amt) };
        all.push(rec);
        (byContainer.get(c) || byContainer.set(c, []).get(c)).push(rec);
    }
    return { byContainer, all };
}

// ── one invoice line ───────────────────────────────────────────────────────
function checkLine(line, sheetIndex, list) {
    const out = { ...line, sheet: null, rate_used: null, rate_source: null, calculated: null, delta: null, list: null };
    if (line.is_claim) return { ...out, status: 'claim_deduction' };
    const c = cont(line.container_no);
    const stated = money(line.commission);
    const mt = money(line.mt);
    if (!c) return { ...out, status: 'no_container_on_pdf' };
    if (list) out.list = listCheck(line, list);
    const cands = sheetIndex.byContainer.get(c);
    if (!cands || !cands.length) return { ...out, status: 'not_in_sheet' };
    // By weight first. A container with two items has two sheet rows; pick the
    // one this line is about. If none equals it, fall back to the sum (a line
    // that bills the whole container), and failing that say the weights differ.
    let row = mt != null ? cands.find((r) => r.weight != null && Math.abs(r.weight - mt) <= WEIGHT_TOLERANCE) : null;
    let weightBasis = 'row';
    if (!row && mt != null) {
        const sum = cands.reduce((t, r) => t + (r.weight || 0), 0);
        if (cands.length > 1 && Math.abs(sum - mt) <= WEIGHT_TOLERANCE) {
            row = { ...cands[0], weight: sum, commission_rate: cands.find((r) => r.commission_rate != null)?.commission_rate ?? null };
            weightBasis = 'sum';
        }
    }
    if (!row) {
        return { ...out, status: 'weight_differs', sheet: { ...cands[0], weight: cands.map((r) => r.weight).filter((w) => w != null).join(' + ') || null } };
    }
    out.sheet = row; out.weight_basis = weightBasis;
    const pdfRate = money(line.comm_per_mt);
    const rate = row.commission_rate != null ? row.commission_rate : pdfRate;
    const src = row.commission_rate != null ? 'sheet' : (pdfRate != null ? 'pdf_fallback' : null);
    if (rate == null) return { ...out, status: 'no_rate_available' };
    out.rate_used = rate; out.rate_source = src;
    if (stated == null) return { ...out, status: 'pdf_commission_unreadable' };
    out.calculated = r2(row.weight * rate);
    out.delta = r2(stated - out.calculated);
    // A rate that differs from the one he printed is its own finding even when
    // the dollars happen to agree.
    out.rate_differs = pdfRate != null && Math.abs(pdfRate - rate) > 0.0001;
    return { ...out, status: Math.abs(out.delta) <= COMMISSION_TOLERANCE && !out.rate_differs ? 'match' : 'mismatch' };
}

// ── his Commission List ──────────────────────────────────────────────────
async function parseCommissionList(buffer, { ExcelJS = require('exceljs'), tab = null } = {}) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = tab ? wb.getWorksheet(tab) : wb.worksheets[0];   // first tab = the current round
    if (!ws) throw new Error('That tab is not in the workbook.');
    const val = (c) => { const v = c && c.value; if (v && typeof v === 'object' && 'result' in v) return v.result; if (v && typeof v === 'object' && v.richText) return v.richText.map((t) => t.text).join(''); return v; };
    let head = null; const idx = {};
    ws.eachRow((row, n) => {
        if (head) return;
        const cells = row.values.map((v) => (v && typeof v === 'object' && v.richText ? v.richText.map((t) => t.text).join('') : v));
        if (cells.some((c) => /^container no/i.test(str(c)))) {
            head = n;
            cells.forEach((c, i) => { const k = str(c).toLowerCase(); if (k) idx[k] = i; });
        }
    });
    if (!head) throw new Error('Could not find a "Container No" header row in the first tab.');
    const col = (...names) => { for (const n of names) if (idx[n] != null) return idx[n]; return -1; };
    const C = { contract: col('contract no.', 'contract no'), item: col('item'), buyer: col('buyer'), bl: col('b/l no'), container: col('container no', 'container no.'),
                mt: col('net mt', 'pl mt'), rate: col('comm/mt'), comm: col('commission'), claim: col('claim detuct', 'claim deduct'), remark: col('remark') };
    const lines = [], claims = []; let lastContract = '', lastBuyer = '';
    ws.eachRow((row, n) => {
        if (n <= head) return;
        const g = (i) => (i < 0 ? null : val(row.getCell(i)));
        const contract = str(g(C.contract)) || '';
        const container = str(g(C.container));
        const item = str(g(C.item));
        if (contract) lastContract = contract;
        if (str(g(C.buyer))) lastBuyer = str(g(C.buyer));
        if (/claim/i.test(item) && !container) {
            const amt = money(g(C.comm));   // his sheet puts the claim in the Commission column
            claims.push({ contract_no: contract || lastContract, label: item, amount: amt != null ? -Math.abs(amt) : null });
            return;
        }
        if (!container) return;
        const mt = money(g(C.mt)), rate = money(g(C.rate));
        let comm = money(g(C.comm));
        if (comm == null && mt != null && rate != null) comm = mt * rate;
        lines.push({ contract_no: contract || lastContract, container_no: container, bl_no: str(g(C.bl)), item, buyer: str(g(C.buyer)) || lastBuyer,
                     mt, rate, commission: comm != null ? r2(comm) : null });
    });
    return { tab: ws.name, lines, claims };
}

function listCheck(line, list) {
    const c = cont(line.container_no), mt = money(line.mt);
    const hits = list.lines.filter((l) => cont(l.container_no) === c);
    if (!hits.length) return { found: false, why: 'container is not on his Commission List' };
    const hit = hits.find((l) => l.mt != null && mt != null && Math.abs(l.mt - mt) <= WEIGHT_TOLERANCE);
    if (!hit) return { found: true, same_mt: false, why: `his list has ${hits.map((l) => l.mt).join(' + ')} MT for this container` };
    const stated = money(line.commission);
    const ok = stated == null || hit.commission == null || Math.abs(stated - hit.commission) <= COMMISSION_TOLERANCE;
    return { found: true, same_mt: true, list_commission: hit.commission, agrees: ok, why: ok ? null : `his list says $${hit.commission}` };
}

// ── the whole run ──────────────────────────────────────────────────────────
function crossCheck(records, { headers, rows, invoiceSheet, list = null, agentPrefix = 'joey' } = {}) {
    const sheetIndex = indexSheet(headers, rows, invoiceSheet);
    const matched = (records || []).map((r) => checkLine(r, sheetIndex, list));
    const seen = new Set(matched.map((m) => cont(m.container_no)).filter(Boolean));
    // Joey's containers on our sheet with a weight that this invoice does not
    // bill. Not period-scoped, so older invoices' containers appear too — the
    // same caveat Pan Metal's equivalent list carries.
    const sheetOnly = []; const done = new Set();
    for (const r of sheetIndex.all) {
        if (!String(r.consignee || '').toLowerCase().startsWith(agentPrefix)) continue;
        if (r.weight == null || seen.has(r.container_no) || done.has(r.container_no)) continue;
        done.add(r.container_no); sheetOnly.push(r);
    }
    const lineSum = r2(matched.filter((m) => !m.is_claim).reduce((t, m) => t + (money(m.commission) || 0), 0));
    const claimSum = r2(matched.filter((m) => m.is_claim).reduce((t, m) => t + (money(m.commission) || 0), 0));
    return { matched, sheet_only: sheetOnly, totals: { lines: lineSum, claims: claimSum, net: r2(lineSum + claimSum) } };
}

// What the extractor returns -> one flat list, claim lines flagged and negative.
function flatten(extracted, sourceFile) {
    const out = [];
    for (const r of (extracted && extracted.records) || []) out.push({ ...r, source_file: sourceFile, is_claim: false });
    for (const c of (extracted && extracted.claims) || []) {
        const a = money(c.amount);
        out.push({ contract_no: c.contract_no || null, container_no: null, label: c.label || 'Claim deduction',
                   commission: a != null ? -Math.abs(a) : null, is_claim: true, source_file: sourceFile });
    }
    return out;
}

module.exports = { crossCheck, checkLine, indexSheet, parseCommissionList, listCheck, flatten, COMMISSION_TOLERANCE, WEIGHT_TOLERANCE };
