// ── tests/unrecorded-payments.js ────────────────────────────────────────────
// Money left the bank and nobody wrote it down.
//
// Apsara, 2026-10-23: "They are forgetting to record the payment in jarvis."
// Told it needed Plaid first, she said "You have pliad na.leverage that" —
// and she was right. helpers/bankOut.js already labels these rows
// 'not_recorded'. This layer chases one person about them and re-matches
// NOTHING, because two answers to "was this paid" is worse than none.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const R = (p) => path.join(ROOT, p);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'unrec-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
delete require.cache[require.resolve(R('config.js'))];
const cfg = require(R('config.js'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('ABORT — DATA_DIR outside temp'); process.exit(1); }

let pass = 0, fail = 0; const failures = [];
const ck = (n, ok, extra) => { if (ok) { pass++; console.log('  ok   ' + n); } else { fail++; failures.push(n); console.log('  FAIL ' + n + (extra === undefined ? '' : ' — ' + JSON.stringify(extra).slice(0, 220))); } };
const section = (t) => console.log('\n' + t);

const up = require(R('helpers/unrecordedPayments.js'));

// `spent` is the field bankOut.withdrawals() reads — NOT `amount`. My first
// fixture used amount and found nothing, which looked exactly like "all
// clear". Worth stating: a silent zero is this feature's failure mode.
const ROWS = [
    { id: 'w1', date: '2026-10-20', spent: 12000, desc: 'WIRE OUT MAZAREIGOS', party: 'MAZAREIGOS', bank: 'bofa' },
    { id: 'w2', date: '2026-10-21', spent: 3400, desc: 'ZELLE INESH CORES', party: 'INESH', bank: 'bofa' },
    { id: 'w3', date: '2026-10-21', spent: 900, desc: 'ALREADY TICKED', matched: true, bank: 'bofa' },
    { id: 'd1', date: '2026-10-21', received: 5000, desc: 'MONEY IN', bank: 'bofa' },
];

(async () => {

section('A — it finds money out with nothing recorded against it');
{
    const r = up.find({ rows: ROWS, lines: [], includeAlreadyChased: true });
    ck('the sweep ran', r.ok === true, r);
    ck('two unrecorded withdrawals', r.rows.length === 2, r.rows.map((x) => x.id));
    ck('  totalling $15,400', r.total === 15400, r.total);
    ck('a row she has already ticked off is NOT chased', !r.rows.some((x) => /ALREADY TICKED/.test(x.description)));
    ck('money coming IN is not a missing payment', !r.rows.some((x) => /MONEY IN/.test(x.description)));
}

section('B — it stays quiet when there is nothing to say');
{
    const quiet = await up.chase({ rows: [ROWS[2], ROWS[3]], lines: [], includeAlreadyChased: true, dryRun: true });
    // An all-clear every morning is how the one that matters gets muted.
    ck('nothing unrecorded means NO message', quiet.sent === false && /nothing unrecorded/.test(quiet.reason), quiet.reason);
}

section('C — the message says what she needs to act on');
{
    const dry = await up.chase({ rows: ROWS, lines: [], includeAlreadyChased: true, dryRun: true });
    ck('the subject counts them', /2 payments not recorded in Jarvis/.test(dry.subject), dry.subject);
    ck('  the total is in the first line', /\$15,400\.00 in total/.test(dry.body));
    ck('  every row is listed with its date and amount',
        /2026-10-20\s+\$12,000\.00\s+WIRE OUT MAZAREIGOS/.test(dry.body) && /ZELLE INESH CORES/.test(dry.body), dry.body);
    // The reason, so it is not just a chore. Both consequences are real:
    // an overstated payable, and paying the same supplier twice.
    ck('  it says WHY it matters', /overstates what we owe/.test(dry.body) && /paying twice/.test(dry.body));
    ck('  and nothing was sent on a dry run', dry.sent === false && dry.reason === 'dry run');
}

section('D — she is not chased about the same row every morning');
{
    const sent = [];
    const notifyStub = { messageAccounts: async (s, b) => { sent.push({ s, b }); return { sent: true, whatsapp: true, email: true, skipped: [], errors: [] }; } };

    const first = await up.chase({ rows: ROWS, lines: [], notify: notifyStub });
    ck('the first chase goes', first.sent === true && sent.length === 1, first.reason);

    const second = await up.chase({ rows: ROWS, lines: [], notify: notifyStub });
    ck('the SAME rows do not produce a second message', second.sent === false && sent.length === 1, second.reason);

    // A new one must still get through — suppression must not become silence.
    const more = ROWS.concat([{ id: 'w9', date: '2026-10-22', spent: 777, desc: 'NEW WIRE', bank: 'bofa' }]);
    const third = await up.chase({ rows: more, lines: [], notify: notifyStub });
    ck('  but a NEW unrecorded payment still gets through', third.sent === true && sent.length === 2, third.reason);
    ck('  and names only the new one', /NEW WIRE/.test(sent[1].b) && !/MAZAREIGOS/.test(sent[1].b), sent[1].b);
}

section('E — a failed send is not recorded as done');
{
    // The one thing worse than chasing twice is never chasing at all: if the
    // message did not go, the rows must stay due.
    const dead = { messageAccounts: async () => ({ sent: false, whatsapp: false, email: false, skipped: ['no contact set'], errors: [] }) };
    const rows = [{ id: 'z1', date: '2026-10-22', spent: 4242, desc: 'UNSENT CHASE', bank: 'bofa' }];
    const a = await up.chase({ rows, lines: [], notify: dead });
    ck('a chase that did not send reports that', a.sent === false, a);
    const still = up.find({ rows, lines: [] });
    ck('  and the row is still outstanding, not silently marked chased',
        still.rows.length === 1 && still.rows[0].description === 'UNSENT CHASE', still.rows);
}

section('F — something actually calls it');
// The whole point of the morning this was built: an engine nothing runs is
// the #152 pattern this repo keeps hitting. chase() with no caller is a
// chase that never happens, and nobody would notice for months.
//
// Matched on the SCHEDULER SOURCE, the same way tests/ai-usage.js guards the
// hourly cost watch — the cron registration is the only thing that makes
// this real on the VM.
{
    const sched = fs.readFileSync(R('scheduler.js'), 'utf8');
    ck('the chase is registered as a cron job',
        /cron\.schedule\('0 7 \* \* \*'[\s\S]{0,400}unrecordedPayments[\s\S]{0,200}chase\(\)/.test(sched));
    ck('  once a day, not hourly — it messages a person, not a log',
        !/cron\.schedule\('[0-9]+ \* \* \* \*'[\s\S]{0,200}unrecordedPayments/.test(sched));
    // After the overnight pull, or it names rows she recorded yesterday.
    ck('  and AFTER the 06:30 integrity sweep, so the feed has refreshed',
        sched.indexOf("integritySweepJob") < sched.indexOf('unrecordedPayments'));
    ck('  a failure is logged, not swallowed',
        /\[SCHED\] unrecorded-payments:/.test(sched));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('  FAILED:'); failures.forEach((f) => console.log('   · ' + f)); }
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW', e && e.stack || e); process.exit(1); });
