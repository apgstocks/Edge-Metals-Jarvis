// tests/quickbooks-nightly.js — the midnight QuickBooks run.
// Apsara, 2026-09-25: "Their QuickBooks integration will be cleaner — fix
// this." The fix was that it now runs itself and reports. These pin the two
// things that matter: it writes ONLY when both switches are on, and a stuck
// row is named in the email, not just counted.
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qbnight-'));
process.env.QB_ENV = 'sandbox';
process.env.QB_JOURNAL_FILE = path.join(tmp, 'journal.jsonl');
process.env.QB_PARTY_MAP_FILE = path.join(tmp, 'map.json');
process.env.QB_CUTOVER_FILE = path.join(tmp, 'cutover.json');
process.env.QB_CUTOVER_BILLS = '2026-09-06';
process.env.QB_CUTOVER_INVOICES = '2026-08-28';
let pass = 0, fail = 0; const failures = [];
const ck = (n, ok, extra) => { if (ok) { pass++; console.log('  PASS ', n); } else { fail++; failures.push(n); console.log('  FAIL ', n, extra === undefined ? '' : String(extra).slice(0, 200)); } };

const job = require('../helpers/quickbooksNightly');
const journal = require('../helpers/quickbooks/journal');

(async () => {
    // ── the switches ───────────────────────────────────────────────────────
    process.env.QB_PROD_WRITES = 'off'; process.env.QB_SYNC = 'off';
    ck('both switches off: not enabled', job.enabled() === false);
    process.env.QB_PROD_WRITES = 'on'; process.env.QB_SYNC = 'off';
    ck('writes on but sync off: still not enabled', job.enabled() === false);
    process.env.QB_SYNC = 'on';
    ck('both on: enabled', job.enabled() === true);
    process.env.QB_PROD_WRITES = 'off'; process.env.QB_SYNC = 'off';

    // ── the summary ────────────────────────────────────────────────────────
    const res = { bill: { created: 3, blocked: 2 }, sale: { created: 4, ask: 1 },
        billpayment: { 'error: QuickBooks POST failed': 1 }, receipt: {} };
    const s = job.summarise(res);
    ck('counts what went in', s.made === 7, s);
    ck('counts what is stuck', s.blocked === 2, s);
    ck('counts what needs her', s.asked === 1, s);
    ck('counts errors separately', s.errored === 1, s);

    // ── the email ──────────────────────────────────────────────────────────
    journal.record({ env: 'sandbox', kind: 'bill', action: 'blocked', jarvis: { id: 'B1', supplier: 'Junk Car', container: 'TCNU5101067' }, reason: 'no supplier amount yet' });
    journal.record({ env: 'sandbox', kind: 'billpayment', action: 'asked', jarvis: { id: 'P1', supplier: 'Hugo' }, reason: 'same amount already left the bank around this date' });
    const out = { ok: true, dryRun: false, env: 'sandbox', result: res, blocked: [], asked: [] };
    for (const e of journal.list({ env: 'sandbox' })) {
        const who = (e.jarvis && (e.jarvis.supplier || e.jarvis.customer)) || '';
        const what = (e.jarvis && (e.jarvis.container || e.jarvis.id)) || '';
        if (e.action === 'blocked') out.blocked.push({ kind: e.kind, who, what, why: e.reason });
        if (e.action === 'asked') out.asked.push({ kind: e.kind, who, what, why: e.reason });
    }
    const text = job.reportText(out);
    ck('the email names the stuck record, not just a count', /TCNU5101067/.test(text) && /no supplier amount yet/.test(text), text.slice(0, 200));
    ck('...and what needs her, with the reason', /Hugo/.test(text) && /already left the bank/.test(text));
    ck('...and the cutover dates, so "why was this skipped" is answered', /2026-09-06/.test(text) && /2026-08-28/.test(text));
    ck('...and points at the page for fixing it', /QuickBooks page/.test(text));

    const dry = job.reportText({ ok: true, dryRun: true, env: 'sandbox', result: res, blocked: [], asked: [] });
    ck('a dry run says plainly that nothing was written', /nothing was written/i.test(dry) && /QB_PROD_WRITES=on/.test(dry));
    const bad = job.reportText({ ok: false, error: 'token expired', blocked: [], asked: [] });
    ck('a failure says nothing was written', /could not finish/.test(bad) && /token expired/.test(bad));

    // ── what the cutover walked past (2026-09-26) ──────────────────────────
    // The bug this closes: with the cutover set to today, a night's sheet sync
    // could write 11 bills and the run reported nothing at all. Silence read
    // exactly like a quiet night.
    const withLeft = { bill: { created: 1 }, sale: {}, billpayment: {}, receipt: {},
        leftAlone: { bill: 11, sale: 9, billpayment: 0, receipt: 0, from: '2026-09-21', to: '2026-09-23',
            why: { 'bill dated 2026-09-21 is before the cutover — her books already hold that period': 20 } } };
    ck('it counts what the cutover walked past', job.summarise(withLeft).left === 20, job.summarise(withLeft));
    const leftText = job.reportText({ ok: true, dryRun: false, env: 'sandbox', result: withLeft, blocked: [], asked: [] });
    ck('the email says a skipped night out loud, with the dates',
       /OLDER THAN THE CUTOVER/.test(leftText) && /20 record/.test(leftText) && /2026-09-21/.test(leftText), leftText.slice(0, 300));
    ck('...counted by kind, so she knows what to look at', /11 bills/.test(leftText) && /9 sales/.test(leftText));
    ck('...and leftAlone is never printed as if it were a document kind', !/^leftAlone:/m.test(leftText));
    ck('...and where the cutover comes from is named', /pinned in \.env|Cutover — bills from/.test(leftText));
    const quiet = job.reportText({ ok: true, dryRun: false, env: 'sandbox', result: { bill: {}, sale: {}, billpayment: {}, receipt: {} }, blocked: [], asked: [] });
    ck('a genuinely quiet night says nothing about the cutover skipping rows', !/OLDER THAN THE CUTOVER/.test(quiet));

    // ── it is actually scheduled, after the sheet sync ──────────────────────
    const sched = fs.readFileSync(path.join(__dirname, '..', 'scheduler.js'), 'utf8');
    ck('it runs nightly', /cron\.schedule\('0 0 \* \* \*',\s*\(\) => nightlyQuickBooks/.test(sched));
    // by CLOCK, not by position in the file: the function is declared above
    // start(), so comparing offsets compared the wrong things
    const qbLine = sched.split('\n').find((l) => /cron\.schedule\(.*nightlyQuickBooks/.test(l)) || '';
    const sheetLine = sched.split('\n').find((l) => /cron\.schedule\(.*nightlyMetalsSheetSync/.test(l)) || '';
    const mins = (l) => { const m = /'(\d+) (\d+) \* \* \*'/.exec(l); return m ? Number(m[2]) * 60 + Number(m[1]) : -1; };
    const qbAt = mins(qbLine), sheetAt = mins(sheetLine);
    ck('...after the 11:15pm sheet sync, never before',
       qbAt > -1 && sheetAt > -1 && (qbAt > sheetAt || qbAt + 24 * 60 - sheetAt < 180), `sheet ${sheetAt}, qb ${qbAt}`);
    ck('a failed night is shouted about', /quickbooks FAILED — NOTHING WAS WRITTEN/.test(sched));

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\nquickbooks-nightly: ${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
})();
