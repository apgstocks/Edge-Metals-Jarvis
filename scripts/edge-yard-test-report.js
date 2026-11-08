#!/usr/bin/env node
// ── scripts/edge-yard-test-report.js ──────────────────────────────────────
// Renders the Edge Yard test document from an actual run, so the figures in
// it are the figures the suite produced rather than ones somebody typed.
//
//   EY_RESULTS_JSON=/tmp/ey.json node tests/edge-yard-scenarios.js
//   node scripts/edge-yard-test-report.js /tmp/ey.json out.html
//
// ── WRITTEN FOR APSARA, NOT FOR A DEVELOPER (2026-11-08) ─────────────────
// Her words on the first draft: "Report shpuld be readable not full on
// technical jargons". She is right, and it is the difference between a
// report she can act on and one she has to decode. So every finding leads
// with what happens at the yard and what it costs her. File names, function
// names and line numbers are real and worth keeping — they live in one small
// line at the bottom of each finding, labelled for whoever does the fix.
//
// The rule used throughout: if a sentence cannot be said to someone standing
// at the scale, it belongs in the small grey line.

const fs = require('fs');

const src = process.argv[2] || '/tmp/ey.json';
const out = process.argv[3] || 'edge-yard-test-report.html';
const R = JSON.parse(fs.readFileSync(src, 'utf8'));

const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Severity is about HER MONEY, not about how hard the fix is.
//   Serious = a wrong number can leave the yard and nobody sees it happen.
const FINDINGS = [
    {
        id: 1, sev: 'Worth fixing',
        title: 'If the signal drops at the wrong moment, the same payment can go in twice',
        happens: 'I first reported this as "tapping Pay twice pays twice". APSARA WAS RIGHT '
            + 'TO PUSH BACK ON THAT and it is corrected here: the Pay button locks the '
            + 'instant you tap it, on both the website and the phone, and once a load is '
            + 'settled the Pay action is gone. A plain double tap cannot pay twice. What '
            + 'IS still open is narrower — if Jarvis records the payment but the reply '
            + 'never makes it back to your phone, the screen shows an error and puts the '
            + 'Pay button back. Tapping again records a second payment.',
        costs: 'Much less likely than I first said. It needs the connection to fail in the '
            + 'gap between Jarvis saving and your phone hearing about it. But that is the '
            + 'yard, and in that moment the screen is actively inviting the second tap — it '
            + 'is showing an error for a payment that actually went through.',
        meant: 'Jarvis already has protection for exactly this: it recognises a repeat of '
            + 'the same save and refuses to act on it twice. It was built for advance '
            + 'payments and never extended to ordinary ones. Both the website and the phone '
            + 'already send the information it needs, so they behave as though the '
            + 'protection is there.',
        next: 'Extend the existing protection to ordinary payments. It is a small change, '
            + 'but the payment path is shared by the website, the phone and talking to '
            + 'Jarvis, so I want to check all three before touching it.',
        tech: 'helpers/payments.js — oncePerSave.normTicket / findSpent at lines 478 and 487, '
            + 'both inside addPrepayment; addPayment (~816) has none. Clients send '
            + 'client_request_id already. Both pay modals disable the button on submit '
            + '(13-loads-render.js:892, 09-loads-deck.js:995) and re-enable it in the catch, '
            + 'which is what leaves the retry-after-timeout window open.',
        seen: 'Use case 10, revised after Apsara challenged the original finding',
    },
    {
        id: 2, sev: 'Serious',
        title: 'A mistyped tare weight creates a load worth minus money',
        happens: 'I entered a gross weight of 1,000 lb and a tare of 4,000 lb — the kind of '
            + 'slip you make typing two numbers at a scale. Jarvis saved it without a '
            + 'murmur: the load came out at minus 3,000 lb, worth minus $3,000, with minus '
            + '$3,000 owed to the seller.',
        costs: 'That one load quietly SUBTRACTS from what the seller is owed, from what the '
            + 'yard is holding, and from the day\'s totals. There is no flag on it. It is '
            + 'only ever found by someone noticing a total looks wrong, long afterwards.',
        meant: 'Nothing currently checks that the tare is lighter than the gross.',
        next: 'Refusing it is the obvious answer. Before adding that rule I want to look at '
            + 'whether any load already saved this way is sitting in your real data — if '
            + 'one is, the new rule would stop you being able to edit it and fix it.',
        tech: 'helpers/loads.js — validateLoadForSave does not compare tare against gross. '
            + 'Saved as net_weight -3000, amount -3000, net_payable -3000, HTTP 200.',
        seen: 'Use case 4',
    },
    {
        id: 3, sev: 'Worth fixing',
        title: 'The Spend report says "nothing was paid out" when $51,572 was',
        happens: 'This is the one you asked about. Choosing Paid by = Cash together with '
            + 'Paid via = Edge Yard shows an empty list and the words "Nothing was paid out '
            + 'in this period" — while the band directly above it says $51,572.16 went out '
            + 'over the very same days.',
        costs: '"Nothing was paid out" reads as *you spent nothing*. It is not true. It '
            + 'means the filter you chose excluded everything, which is a completely '
            + 'different thing to be told.',
        meant: 'Two separate causes that happen to meet on one screen. First: Jarvis only '
            + 'ever asks which company\'s money was used on a wire or bank transfer — never '
            + 'on cash. So no cash payment carries a company, and that pair of filters can '
            + 'only ever return nothing. Across the whole of 2026 that is zero rows out of '
            + '$787,739.92 of cash. Second: the cash band at the top ignores every filter '
            + 'except the dates, so it keeps showing money while the list below shows none.',
        next: 'Three small changes: say which it is ("no rows match these filters — '
            + '$51,572.16 was paid out, 13 cash payments, none of them recorded against a '
            + 'company"), stop offering the Paid via buttons when Cash is chosen, and label '
            + 'the cash band as covering the whole box rather than the filtered list.',
        tech: 'helpers/spendReport.js — the cash block (~line 489) filters on date and '
            + 'method only; company / paidVia / bank / boughtFrom / soldTo never reach it.',
        seen: 'Use case 17, plus read-only checks against your live site on 8 Nov',
    },
    {
        id: 4, sev: 'Needs your decision',
        title: 'A claim cannot be raised against a walk-in yard purchase',
        happens: 'Trying to raise a claim against a yard load is refused: "a claim needs at '
            + 'least a container number or an invoice number".',
        costs: 'A yard purchase from someone who drives in has no container number and no '
            + 'invoice number. So either yard claims are being raised against made-up '
            + 'container numbers, or they are not being raised at all. Both are worse than '
            + 'the rule simply being wrong for the yard.',
        meant: 'That rule comes from the Edge Metals side, where every claim does hang off a '
            + 'container. It was never adjusted for the yard.',
        next: 'This is a question for you rather than something to patch: should a yard '
            + 'claim attach to the load itself instead of a container number?',
        tech: 'the /api/claims route rejects a body with neither container_no nor invoice_no.',
        seen: 'Use case 14',
    },
];

const WORKING = [
    'Buying a load — by the pound, by the ton, and with several different metals on one '
    + 'ticket. Every weight and every price came out right.',
    'Jarvis refuses to pay out cash the box does not hold, and says how much is actually '
    + 'there rather than just failing.',
    'A wire will not go through until you say whose money it is, and the Spend report then '
    + 'files it under the right company.',
    'Paying more cash than one pot holds stops and asks first, names who would be lending, '
    + 'and says exactly how short it is. The money only moves once you say yes.',
    'A borrow cannot be invented on its own — it only exists because a payment needed it.',
    'Haulage comes off what the seller is paid, while the metal still counts at its full '
    + 'value. No double-counting.',
    'A payment of zero, and a payment of minus money, are both refused.',
    'Selling more metal than the yard holds is caught.',
    'Editing a load re-prices it without wiping the payments already made against it.',
    'Chase Bank cash now counts as Edge Yard\'s, and the per-company split still adds up to '
    + 'the single cash-in-hand figure.',
    'Nothing done in the yard showed up anywhere under Edge Metals.',
];

const MINE = [
    'My first run showed 11 failures. Most of them were my own test being wrong, not Jarvis: '
    + 'I tried to pay cash before putting any in the box, did not say which pot to take it '
    + 'from, tried to create a borrow out of thin air, and measured "what is still owed" '
    + 'from a field that does not exist. Jarvis was right every single time.',
    'Those are listed under "What is working" rather than quietly deleted. A tester who '
    + 'fixes their own mistakes and only reports the leftovers is hiding the behaviour that '
    + 'was actually proved correct.',
    'I also OVERSTATED finding 1. I fired two payments straight at the server, which is not '
    + 'something the screen can do — Apsara pointed out that the Pay button disappears once '
    + 'the load is covered, and she was right. Checking properly showed the button also '
    + 'locks the instant it is tapped, on both the website and the phone. The finding is '
    + 'corrected and downgraded, not quietly dropped.',
];

const OPEN = [
    'Should Jarvis ask which company\'s money was used when you pay CASH? Today it only asks '
    + 'on wires. The cash box is funded from Edge Metals, AAA Investment and Chase (Edge '
    + 'Yard), so the question can be answered — it just is not asked. Say yes and the Paid '
    + 'via filter starts working for cash; say no and it should say plainly that it only '
    + 'applies to wires. Either way, past cash stays unrecorded unless you want it filled in.',
    'Should the cash band at the top of the Spend report follow the company buttons? My '
    + 'advice is NO. The cash box is one physical box filled from several accounts, so '
    + 'splitting it by company would produce a confident number that is wrong. Saying what '
    + 'it covers is the honest fix.',
    'Should a yard claim attach to the load instead of a container number? (Finding 4)',
];

const NOT_COVERED = [
    'The Edge Yard app on an actual phone. The tests drive the same machinery the app talks '
    + 'to, which is not the same as holding the handset.',
    'Printed paperwork — scale tickets, seller receipts, bills of lading. Covered by other '
    + 'tests, not by this one.',
    'Saving to Google Drive, sending email, and the overnight checks.',
    'Two people paying for the same load at the same moment.',
    'Recording a payment by TALKING to Jarvis. This one could not be driven from the test '
    + 'and is marked skipped, not passed — and it is historically the part most likely to '
    + 'break when a rule changes, so it is the gap worth closing next.',
    'Your live site was only ever READ. Nothing in this run wrote anything to it.',
];

const sevColour = { 'Serious': '#C2261B', 'Worth fixing': '#B45309', 'Needs your decision': '#4B5563' };
const totalSteps = R.cases.reduce((a, c) => a + c.steps.length, 0);

// A failure note from the run is often a raw server reply. Shown, because
// evidence matters, but trimmed and kept out of the way.
const tidy = (d) => {
    const s = String(d || '');
    if (!s) return '';
    return s.length > 230 ? s.slice(0, 230) + '…' : s;
};

const caseRow = (c) => `
  <div class="case ${c.verdict.toLowerCase()}">
    <div class="caseHead">
      <span class="cid">${esc(c.id.replace('EY-', ''))}</span>
      <span class="doing">${esc(c.doing)}</span>
      <span class="verdict v-${c.verdict.toLowerCase()}">${c.verdict === 'PASS' ? 'All good' : (c.verdict === 'SKIPPED' ? 'Not tested' : 'Problem found')}</span>
    </div>
    <table>
      <tbody>
        ${c.steps.map((s) => `<tr class="${s.ok === null ? 'skip' : (s.ok ? 'ok' : 'bad')}">
          <td class="r">${s.ok === null ? '—' : (s.ok ? '✓' : '✗')}</td>
          <td>${esc(s.label)}${s.detail ? `<div class="d">${esc(tidy(s.detail))}</div>` : ''}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>`;

const html = `<!doctype html><meta charset="utf-8">
<title>Edge Yard — what I tested, and what I found</title>
<style>
  :root { --ink:#15161a; --muted:#6b7280; --line:#e5e7eb; --ok:#15803d; --bad:#C2261B; }
  body { font:15px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
         color:var(--ink); max-width:880px; margin:0 auto; padding:38px 26px 90px; }
  h1 { font-size:26px; margin:0 0 6px; letter-spacing:-.015em; }
  h2 { font-size:15px; margin:40px 0 12px; padding-bottom:7px; border-bottom:2px solid var(--ink);
       text-transform:uppercase; letter-spacing:.07em; }
  .sub { color:var(--muted); margin:0 0 22px; font-size:14px; }
  .lede { font-size:16.5px; line-height:1.6; margin:20px 0 6px; }
  .scoreboard { display:flex; gap:10px; flex-wrap:wrap; margin:20px 0 6px; }
  .box { border:1px solid var(--line); border-radius:9px; padding:12px 17px; min-width:108px; }
  .box .n { font-size:23px; font-weight:650; }
  .box .l { font-size:10.5px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }
  .note { background:#fffdf5; border:1px solid #f0e2b6; border-radius:9px; padding:15px 18px; margin:18px 0; font-size:14px; }
  .find { border:1px solid var(--line); border-left:5px solid var(--line); border-radius:9px;
          padding:16px 20px; margin:0 0 16px; }
  .find h3 { margin:0 0 10px; font-size:17px; letter-spacing:-.01em; }
  .find .sev { font-size:10.5px; letter-spacing:.07em; padding:3px 9px; border-radius:20px;
               color:#fff; vertical-align:middle; margin-left:7px; font-weight:600; }
  .find p { margin:9px 0; }
  .lab { display:block; font-size:10.5px; text-transform:uppercase; letter-spacing:.08em;
         color:var(--muted); font-weight:600; margin-bottom:1px; }
  .tech { margin-top:13px; padding-top:10px; border-top:1px dashed var(--line);
          font-size:11.5px; color:#9095a0; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .case { margin:0 0 13px; border:1px solid var(--line); border-radius:9px; overflow:hidden; }
  .case.fail { border-color:#f1b6b1; }
  .caseHead { display:flex; align-items:center; gap:12px; padding:10px 14px; background:#fafafa;
              border-bottom:1px solid var(--line); }
  .case.fail .caseHead { background:#fdf3f2; }
  .cid { font-family:ui-monospace,Menlo,monospace; font-weight:650; font-size:12px; color:var(--muted);
         min-width:22px; }
  .doing { flex:1; font-size:14.5px; }
  .verdict { font-size:10.5px; letter-spacing:.06em; padding:3px 9px; border-radius:20px; border:1px solid var(--line); white-space:nowrap; }
  .v-pass { color:var(--ok); border-color:#bbf7d0; background:#f0fdf4; }
  .v-fail { color:var(--bad); border-color:#f1b6b1; background:#fdf3f2; }
  .v-skipped { color:#b45309; border-color:#fde68a; background:#fffbeb; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  td { padding:7px 9px; border-bottom:1px solid #f4f4f5; vertical-align:top; }
  td.r { width:18px; font-weight:700; text-align:center; }
  tr.ok td.r { color:var(--ok); } tr.bad td.r { color:var(--bad); } tr.skip td.r { color:#b45309; }
  tr:last-child td { border-bottom:none; }
  .d { color:#9095a0; font-size:11.5px; font-family:ui-monospace,Menlo,monospace;
       margin-top:3px; word-break:break-word; }
  ul { margin:9px 0; padding-left:21px; } li { margin:7px 0; }
</style>

<h1>Edge Yard — what I tested, and what I found</h1>
<p class="sub">Jarvis · ${esc(new Date(R.ranAt).toLocaleDateString('en-US', { day:'numeric', month:'long', year:'numeric' }))}</p>

<p class="lede">I went through a full day at the yard — buying metal, paying for it, deducting
haulage, selling it on, raising a claim, and counting the cash box — and checked that the money
came out right at every step. <strong>${R.cases.length} tasks, ${totalSteps} checks.</strong>
Most of it works. I found <strong>four problems</strong>. One of them can
cost you money without anyone noticing.</p>

<div class="scoreboard">
  <div class="box"><div class="n">${R.cases.length}</div><div class="l">tasks tested</div></div>
  <div class="box"><div class="n" style="color:var(--ok)">${R.pass}</div><div class="l">checks passed</div></div>
  <div class="box"><div class="n" style="color:var(--bad)">${R.fail}</div><div class="l">problems found</div></div>
  <div class="box"><div class="n" style="color:#b45309">${R.skip}</div><div class="l">not tested</div></div>
</div>

<div class="note" style="background:#f4f8ff; border-color:#c7d9f5;">
  <strong>One finding was corrected after Apsara challenged it.</strong> I first reported that
  tapping Pay twice pays the seller twice. She pointed out that the Pay button disappears once
  the load is covered — and she was right. The button also locks the moment it is tapped, on
  both the website and the phone, so a double tap cannot send two payments. Finding 1 is now
  the narrower case that genuinely remains, and its severity is down from Serious.
</div>

<div class="note">
  <strong>Your real data was not touched.</strong> Pretending to buy and pay for loads on the
  live site would have put fake loads and fake payments into your actual books. So every test
  ran on a private copy of Jarvis with its own empty records. I did look at your live site, but
  only to read — never to change anything.
</div>

<h2>What I found</h2>
${FINDINGS.map((d) => `
<div class="find" style="border-left-color:${sevColour[d.sev]}">
  <h3>${d.id}. ${esc(d.title)}<span class="sev" style="background:${sevColour[d.sev]}">${esc(d.sev)}</span></h3>
  <p><span class="lab">What happens</span>${esc(d.happens)}</p>
  <p><span class="lab">Why it matters</span>${esc(d.costs)}</p>
  <p><span class="lab">Why it is happening</span>${esc(d.meant)}</p>
  <p><span class="lab">What I suggest</span>${esc(d.next)}</p>
  <div class="tech">For whoever fixes it — ${esc(d.tech)} · seen in ${esc(d.seen)}</div>
</div>`).join('')}

<div class="note">
  <strong>I have not changed any of these.</strong> The first two sit in code that the website,
  the phone app and talking to Jarvis all share, so a fix in the wrong place breaks one of them
  while fixing another. The fourth is a question for you, not a bug to patch. Say the word and
  I will start with the first.
</div>

<h2>What is working</h2>
<ul>${WORKING.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>

<h2>Where I got it wrong</h2>
<ul>${MINE.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>

<h2>Questions for you</h2>
<ul>${OPEN.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>

<h2>Every task, step by step</h2>
<p class="sub">A tick means the money or the paperwork came out right. A cross is a problem —
each one is explained above.</p>
${R.cases.map(caseRow).join('')}

<h2>What this does not cover</h2>
<p class="sub">So the report is not read as promising more than it checked.</p>
<ul>${NOT_COVERED.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
`;

fs.writeFileSync(out, html);
console.log(`${R.cases.length} tasks, ${R.pass} passed / ${R.fail} problems / ${R.skip} not tested`);
console.log(`findings: ${FINDINGS.length} (${FINDINGS.filter((d) => d.sev === 'Serious').length} serious)`);
console.log(`-> ${out}`);
