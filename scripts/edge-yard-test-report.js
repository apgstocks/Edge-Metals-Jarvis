#!/usr/bin/env node
// ── scripts/edge-yard-test-report.js ──────────────────────────────────────
// Renders the Edge Yard test document from an actual run, so the figures in
// it are the figures the suite produced rather than ones somebody typed.
//
//   EY_RESULTS_JSON=/tmp/ey.json node tests/edge-yard-scenarios.js
//   node scripts/edge-yard-test-report.js /tmp/ey.json out.html
//
// The defect register below is the only hand-written part, because a verdict
// needs a human judgement about severity and blast radius that a pass/fail
// line cannot carry. Every defect names the evidence that produced it.

const fs = require('fs');

const src = process.argv[2] || '/tmp/ey.json';
const out = process.argv[3] || 'edge-yard-test-report.html';
const R = JSON.parse(fs.readFileSync(src, 'utf8'));

const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── THE DEFECT REGISTER ──────────────────────────────────────────────────
// Severity is about HER MONEY and HER PAPERWORK, not about how hard it is to
// fix. "High" means a wrong number can leave the yard without anyone seeing
// it happen.
const DEFECTS = [
    {
        id: 'EY-D1', sev: 'HIGH', title: 'A double-tapped payment pays the seller twice',
        where: 'helpers/payments.js — addPayment (line ~816)',
        what: 'Two identical POSTs to /api/payments carrying the SAME client_request_id '
            + 'both succeed. Outstanding moved $200 for two $100 payments.',
        why: 'The once-per-save guard (oncePerSave.normTicket / findSpent) exists in this '
            + 'file at lines 478 and 487 — both inside addPrepayment. addPayment has no '
            + 'guard at all. Both clients already SEND client_request_id '
            + '(dashboard/app/13-loads-render.js:1307, mobile-app/www/app/09-loads-deck.js:1343), '
            + 'so they believe they are protected and are not.',
        risk: 'She pays suppliers from a phone, in a yard, on a bad signal. A retry or a '
            + 'fat-fingered second tap hands over the money twice and the ledger agrees '
            + 'with the wrong figure. Nothing downstream can tell the two apart.',
        evidence: 'EY-10',
        fixNote: 'NOT FIXED — addPayment is shared by both screens, the voice path and the '
            + 'settle path. Per CLAUDE.md rule 1 the caller list has to be walked before a '
            + 'required-field or dedupe rule lands in it. Needs her go-ahead.',
    },
    {
        id: 'EY-D2', sev: 'MEDIUM',
        title: 'The spend report contradicts itself: no rows, but money went out',
        where: 'helpers/spendReport.js — the cash block (line ~489)',
        what: 'Paid by = Cash together with Paid via = Edge Yard returns ZERO rows and '
            + '"Nothing was paid out in this period", while the petty cash band above it '
            + 'still reports Cash out $51,572.16 for the same window.',
        why: 'Two separate causes that meet on one screen. (1) paid_via is only ever '
            + 'captured on Wire/Bank transfer, so NO cash row carries a company — across '
            + 'all of 2026 that is 0 rows out of $787,739.92. The pair is an empty set by '
            + 'construction and the screen offers it as a real question. (2) The cash band '
            + 'is filtered only by date and by "is this cash"; company, paid_via, bank, '
            + 'bought-from and sold-to never reach it.',
        risk: '"Nothing was paid out in this period" reads as *you spent nothing*. It is '
            + 'false — it means her filter excluded everything.',
        evidence: 'EY-17, plus read-only probes against live data on 2026-11-08',
        fixNote: 'NOT FIXED. Recommended: say which it is ("No rows match these filters. '
            + '$51,572.16 was paid out — 13 cash payments, all with Paid via not recorded"), '
            + 'disable the Paid via chips under Cash, and label the band as covering the '
            + 'whole drawer. Scoping the band by company was considered and REJECTED — see '
            + 'the note under Open Questions.',
    },
    {
        id: 'EY-D3', sev: 'MEDIUM',
        title: 'A yard claim cannot be raised against a walk-in purchase',
        where: 'the /api/claims route',
        what: 'Posting a claim against a yard load is refused: "a claim needs at least a '
            + 'container number or an invoice number".',
        why: 'That rule comes from the Edge Metals side, where every claim hangs off a '
            + 'container. A yard purchase from a walk-in seller has neither a container '
            + 'number nor an invoice number.',
        risk: 'Either yard claims are being raised against invented container numbers, or '
            + 'they are not being raised at all. Both are worse than the rule being wrong.',
        evidence: 'EY-14',
        fixNote: 'NOT FIXED — this is a design question, not a bug to patch. Should a yard '
            + 'claim key on the load id instead?',
    },
    {
        id: 'EY-D4', sev: 'HIGH',
        title: 'A mistyped tare saves a load with negative weight and negative money',
        where: 'helpers/loads.js — validateLoadForSave',
        what: 'Gross 1,000 with tare 4,000 saves happily: net_weight -3000, amount -3000, '
            + 'net_payable -3000. HTTP 200, no warning.',
        why: 'Nothing rejects or clamps a tare heavier than the gross.',
        risk: 'Weights are typed on a phone at the scale. One transposed figure creates a '
            + 'load that SUBTRACTS from what a seller is owed, and from stock, and from the '
            + 'yard total — silently. It is the kind of wrong number that is only ever '
            + 'found by someone noticing a total looks odd.',
        evidence: 'EY-04',
        fixNote: 'NOT FIXED. Refusing it outright is the obvious move, but a load already '
            + 'saved this way on live data would then fail to edit — so the migration has '
            + 'to be checked before the rule lands.',
    },
];

const OBSERVATIONS = [
    {
        id: 'EY-O1',
        what: 'A cash payment that names no bucket is refused with "Only 0.00 available in '
            + 'Unassigned" — naming a bucket she never chose.',
        note: 'Not a defect: both screens always send a bucket, and refusing is correct. '
            + 'The wording would confuse anyone who hit it.',
    },
    {
        id: 'EY-O2',
        what: 'Refusing to pay cash the box does not hold, refusing a standalone borrow, '
            + 'and stopping to name the lenders before borrowing are all working exactly as '
            + 'built.',
        note: 'Found by my first scenario run failing. The product was right and my test was '
            + 'wrong — recorded here because a tester who quietly fixes their own harness '
            + 'and reports only the leftovers hides the behaviour that was verified.',
    },
];

const OPEN = [
    'Should a cash payment ask whose money it was? The drawer is funded from Edge Metals, '
    + 'AAA Investment and Chase (Edge Yard), so the question is answerable — it just is not '
    + 'asked. Answering yes makes the Paid via chip meaningful; answering no means the chip '
    + 'should say it is wire-only. Either way, $787,739.92 of past cash stays "Not recorded" '
    + 'unless a backfill is wanted.',
    'Should the petty cash band follow the company switcher? Recommended NO. The drawer is '
    + 'one physical box funded from several accounts; scoping it by the spend report\'s '
    + 'company would produce a confident, wrong number. Labelling what it covers is the '
    + 'honest fix.',
    'Should a yard claim key on the load id rather than a container number? (EY-D3)',
];

const NOT_COVERED = [
    'The Edge Yard Android app itself. The scenarios drive the same routes the app posts to, '
    + 'which is not the same as running the APK on a handset.',
    'PDF and document generation (scale tickets, seller receipts, BOLs) — exercised elsewhere '
    + 'in the suite, not here.',
    'Google Drive upload, email sending, and the nightly watchers.',
    'Concurrency: two people paying the same load at the same moment.',
    'Her live data was READ ONLY. Nothing in this run wrote to jarvis.edgemetals.com.',
    'The voice path for payments (EY-07) could not be driven directly from the harness and '
    + 'is marked SKIPPED, not passed. CLAUDE.md names this as the caller that breaks most '
    + 'often, so the gap is worth closing.',
];

const sevColour = { HIGH: '#EA3323', MEDIUM: '#D98300', LOW: '#6b7280' };
const totalSteps = R.cases.reduce((a, c) => a + c.steps.length, 0);

const caseRow = (c) => `
  <div class="case ${c.verdict.toLowerCase()}">
    <div class="caseHead">
      <span class="cid">${esc(c.id)}</span>
      <span class="doing">${esc(c.doing)}</span>
      <span class="verdict v-${c.verdict.toLowerCase()}">${esc(c.verdict)}</span>
    </div>
    <table>
      <thead><tr><th style="width:62%">Step — what must be true</th><th>Result</th><th>Evidence</th></tr></thead>
      <tbody>
        ${c.steps.map((s) => `<tr class="${s.ok === null ? 'skip' : (s.ok ? 'ok' : 'bad')}">
          <td>${esc(s.label)}</td>
          <td class="r">${s.ok === null ? 'SKIPPED' : (s.ok ? 'pass' : 'FAIL')}</td>
          <td class="d">${esc(s.detail)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>`;

const html = `<!doctype html><meta charset="utf-8">
<title>Edge Yard — test report</title>
<style>
  :root { --ink:#111; --muted:#6b7280; --line:#e5e7eb; --ok:#15803d; --bad:#EA3323; }
  body { font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
         color:var(--ink); max-width:1000px; margin:0 auto; padding:34px 26px 90px; }
  h1 { font-size:23px; margin:0 0 4px; letter-spacing:-.01em; }
  h2 { font-size:16px; margin:34px 0 10px; padding-bottom:6px; border-bottom:2px solid var(--ink); text-transform:uppercase; letter-spacing:.06em; }
  .sub { color:var(--muted); margin:0 0 20px; }
  .scoreboard { display:flex; gap:10px; flex-wrap:wrap; margin:18px 0 6px; }
  .box { border:1px solid var(--line); border-radius:8px; padding:11px 15px; min-width:104px; }
  .box .n { font-size:21px; font-weight:650; }
  .box .l { font-size:10px; text-transform:uppercase; letter-spacing:.09em; color:var(--muted); }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; font-size:10px; text-transform:uppercase; letter-spacing:.07em;
       color:var(--muted); border-bottom:1px solid var(--line); padding:5px 7px; font-weight:600; }
  td { padding:5px 7px; border-bottom:1px solid #f3f4f6; vertical-align:top; }
  td.r { font-weight:650; white-space:nowrap; }
  td.d { color:var(--muted); font-size:11.5px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  tr.ok td.r { color:var(--ok); font-weight:500; }
  tr.bad td.r { color:var(--bad); }
  tr.skip td.r { color:#b45309; }
  .case { margin:0 0 20px; border:1px solid var(--line); border-radius:9px; overflow:hidden; }
  .case.fail { border-color:#fca5a5; }
  .caseHead { display:flex; align-items:center; gap:11px; padding:9px 13px; background:#fafafa; border-bottom:1px solid var(--line); }
  .case.fail .caseHead { background:#fef2f2; }
  .cid { font-family:ui-monospace,Menlo,monospace; font-weight:650; font-size:12px; }
  .doing { flex:1; }
  .verdict { font-size:10px; letter-spacing:.08em; padding:2px 8px; border-radius:20px; border:1px solid var(--line); }
  .v-pass { color:var(--ok); border-color:#bbf7d0; background:#f0fdf4; }
  .v-fail { color:var(--bad); border-color:#fecaca; background:#fef2f2; }
  .v-skipped { color:#b45309; border-color:#fde68a; background:#fffbeb; }
  .def { border:1px solid var(--line); border-left:4px solid var(--line); border-radius:7px; padding:13px 16px; margin:0 0 13px; }
  .def h3 { margin:0 0 3px; font-size:14.5px; }
  .def .meta { font-size:11px; color:var(--muted); font-family:ui-monospace,Menlo,monospace; margin-bottom:8px; }
  .def p { margin:5px 0; }
  .def .lab { font-size:10px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }
  .sev { font-size:10px; letter-spacing:.08em; padding:2px 8px; border-radius:20px; color:#fff; }
  ul { margin:7px 0; padding-left:19px; } li { margin:4px 0; }
  .note { background:#fffbeb; border:1px solid #fde68a; border-radius:7px; padding:12px 15px; margin:14px 0; }
</style>

<h1>Edge Yard — test report</h1>
<p class="sub">Jarvis · run ${esc(new Date(R.ranAt).toLocaleString('en-US'))} ·
${R.cases.length} use cases, ${totalSteps} checks</p>

<div class="scoreboard">
  <div class="box"><div class="n">${R.cases.length}</div><div class="l">use cases</div></div>
  <div class="box"><div class="n" style="color:var(--ok)">${R.pass}</div><div class="l">checks passed</div></div>
  <div class="box"><div class="n" style="color:var(--bad)">${R.fail}</div><div class="l">checks failed</div></div>
  <div class="box"><div class="n" style="color:#b45309">${R.skip}</div><div class="l">skipped</div></div>
  <div class="box"><div class="n" style="color:var(--bad)">${DEFECTS.filter((d) => d.sev === 'HIGH').length}</div><div class="l">high defects</div></div>
</div>

<div class="note">
  <strong>How this was run, and what it is worth.</strong>
  Every scenario below was executed against a <em>real Jarvis server</em> on a throwaway data
  directory — real routes, real login, money read back out of the same route each screen reads.
  <strong>Nothing was written to the live site.</strong> Simulating buy/pay/sell scenarios against
  jarvis.edgemetals.com would have put test loads and test payments into the real books. Live was
  probed separately, read only, and those findings are marked as such.
</div>

<h2>Defects</h2>
${DEFECTS.map((d) => `
<div class="def" style="border-left-color:${sevColour[d.sev]}">
  <h3>${esc(d.id)} — ${esc(d.title)} <span class="sev" style="background:${sevColour[d.sev]}">${d.sev}</span></h3>
  <div class="meta">${esc(d.where)} · evidence: ${esc(d.evidence)}</div>
  <p><span class="lab">What happens</span><br>${esc(d.what)}</p>
  <p><span class="lab">Why</span><br>${esc(d.why)}</p>
  <p><span class="lab">What it costs her</span><br>${esc(d.risk)}</p>
  <p><span class="lab">Status</span><br>${esc(d.fixNote)}</p>
</div>`).join('')}

<h2>Observations — not defects</h2>
${OBSERVATIONS.map((o) => `<div class="def" style="border-left-color:#9ca3af">
  <h3>${esc(o.id)}</h3><p>${esc(o.what)}</p><p style="color:var(--muted)">${esc(o.note)}</p></div>`).join('')}

<h2>Open questions for Apsara</h2>
<ul>${OPEN.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>

<h2>Use cases, step by step</h2>
${R.cases.map(caseRow).join('')}

<h2>What this report does NOT cover</h2>
<p class="sub">A test document that does not say where it stops is read as more assurance than it is.</p>
<ul>${NOT_COVERED.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
`;

fs.writeFileSync(out, html);
console.log(`${R.cases.length} use cases, ${R.pass} passed / ${R.fail} failed / ${R.skip} skipped`);
console.log(`defects: ${DEFECTS.length} (${DEFECTS.filter((d) => d.sev === 'HIGH').length} high)`);
console.log(`-> ${out}`);
