// ── tests/bank-pull-job.js ────────────────────────────────────────────────
// Apsara, 2026-10-05: "i should nt struggle at all during tax filing."
//
// The 05:45 pull. Its interesting property is not that it fetches — that is
// helpers/plaid.js's job and tests/plaid.js covers it — but WHEN IT SPEAKS.
//
// Silence is the default, for the reason helpers/integritySweepJob.js gives:
// a nightly "4 deposits pulled" email is one she stops opening inside a
// fortnight, and then the morning it says something real she does not open
// that either.
//
// But silence has a cost here that it does not have for the sweep. If the
// Plaid item dies, deposits stop arriving and the matching screen looks calm
// and EMPTY — indistinguishable from a quiet week, and nothing else in the
// system would ever notice. So sections C to E are about the three failures
// that must break the silence, and section B is about everything that must
// not.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-bank-pull-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.BANK_TX_FILE = path.join(TMP, 'bank-transactions.json');
process.env.BANK_ITEM_FILE = path.join(TMP, 'bank-item.json');

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against real data');
    process.exit(1);
}
const J = require(path.join(ROOT, 'helpers/bankPullJob'));

// ── fakes ─────────────────────────────────────────────────────────────────
const sent = [];
const sendEmail = async (m) => { sent.push(m); };
const row = (id, o = {}) => ({ id, date: '2026-09-05', desc: 'WIRE IN', amount: 1000,
    spent: 0, received: 1000, direction: 'in', excluded: false, history: [], drift: null, ...o });

const plaidOf = (o) => ({
    status: () => ({ configured: true, items: [{ item_id: 'item-1' }], ...(o.status || {}) }),
    syncAll: o.syncAll || (async () => ({ added: 0, modified: 0, removed: [], errors: [], items: [] })),
});
const ledgerOf = (before, after) => {
    let n = 0;
    return { list: () => { n += 1; return n === 1 ? before : (after || before); } };
};

(async () => {

// ── A — IT DOES NOT RUN WHEN THERE IS NOTHING TO RUN ──────────────────────
{
    section('A — before the keys and before a bank');

    let r = await J.pull({ plaid: { status: () => ({ configured: false, items: [] }) }, ledger: ledgerOf([]) });
    ck('with no keys it does not pretend to have run', r.ran === false, JSON.stringify(r.why));
    ck('  and says which half is missing', /not configured/.test(r.why || ''), String(r.why));
    ck('  and does NOT email — an unconfigured server is not a 5am emergency',
       r.needsHer === false);

    r = await J.pull({ plaid: { status: () => ({ configured: true, items: [] }) }, ledger: ledgerOf([]) });
    ck('with no bank linked it is quiet too', r.ran === false && r.needsHer === false, JSON.stringify(r));
    ck('  and says so plainly', /no bank is linked/.test(r.why || ''), String(r.why));
}

// ── B — A NORMAL MORNING IS SILENT ────────────────────────────────────────
{
    section('B — nothing wrong, nothing sent');

    sent.length = 0;
    let r = await J.run({ plaid: plaidOf({ syncAll: async () => ({ added: 4, modified: 0, removed: [], errors: [], items: [] }) }),
        ledger: ledgerOf([], [row('T1'), row('T2'), row('T3'), row('T4')]), sendEmail, to: 'x@y.com' });
    ck('four deposits arrived', r.added === 4, JSON.stringify(r.added));
    ck('  and nothing was emailed', sent.length === 0 && r.sent === false, JSON.stringify(sent.map((m) => m.subject)));
    ck('  the reason is recorded rather than left blank', /nothing needs her/.test(r.reason || ''), String(r.reason));

    // A quiet day is not a fault.
    sent.length = 0;
    r = await J.run({ plaid: plaidOf({}), ledger: ledgerOf([row('T1')]), sendEmail, to: 'x@y.com' });
    ck('a day with no new deposits is also silent', r.added === 0 && sent.length === 0, JSON.stringify(r));

    // A TRANSIENT failure is not hers to fix, so it stays off her morning.
    sent.length = 0;
    r = await J.run({ plaid: plaidOf({ syncAll: async () => ({ added: 0, modified: 0, removed: [], items: [],
        errors: [{ item_id: 'item-1', institution: 'BofA', error: 'Plaid /transactions/sync did not answer: timeout' }] }) }),
        ledger: ledgerOf([]), sendEmail, to: 'x@y.com' });
    ck('a timeout is NOT emailed — the next run gets it',
       sent.length === 0 && r.needsHer === false, JSON.stringify(sent.map((m) => m.subject)));
    ck('  but it is still reported to the caller', r.errors.length === 1, JSON.stringify(r.errors));

    // SEND_ALWAYS is the override for the first few days.
    sent.length = 0;
    r = await J.run({ plaid: plaidOf({}), ledger: ledgerOf([]), sendEmail, to: 'x@y.com', sendAlways: true });
    ck('SEND_ALWAYS sends even on a clean run', sent.length === 1, String(sent.length));
    ck('  with a subject that says it is fine',
       /the bank feed is fine/.test(sent[0].subject), sent[0].subject);
}

// ── C — A DEAD FEED MUST BREAK THE SILENCE ────────────────────────────────
// The failure nothing else in the system can see.
{
    section('C — the bank wants her to sign in again');

    sent.length = 0;
    const r = await J.run({ plaid: plaidOf({ syncAll: async () => ({ added: 0, modified: 0, removed: [], items: [],
        errors: [{ item_id: 'item-2', institution: 'Chase', error: 'ITEM_LOGIN_REQUIRED — the user must repair this item' }] }) }),
        ledger: ledgerOf([]), sendEmail, to: 'x@y.com' });

    ck('it emails', sent.length === 1 && r.sent === true, JSON.stringify(sent.map((m) => m.subject)));
    ck('  naming the bank in the subject', /chase/i.test(sent[0].subject), sent[0].subject);
    ck('  and saying what she has to do', /sign in again/i.test(sent[0].subject + sent[0].body), sent[0].subject);
    // THE SENTENCE THAT MATTERS. Without it she reads an empty screen as a
    // quiet week.
    ck('  and warning that the screen will look empty rather than broken',
       /look empty rather than broken/.test(sent[0].body), sent[0].body.slice(0, 400));
    ck('  and where to reconnect it', /bank matching page/.test(sent[0].body), sent[0].body.slice(0, 400));

    // Every kind in NEEDS_HER, and the ones deliberately left out.
    for (const code of ['ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION', 'INVALID_CREDENTIALS', 'ITEM_LOCKED', 'USER_PERMISSION_REVOKED']) {
        ck(`  ${code} wakes her`, J.NEEDS_HER.test(code), code);
    }
    for (const code of ['INTERNAL_SERVER_ERROR', 'RATE_LIMIT_EXCEEDED', 'PLANNED_MAINTENANCE', 'timeout']) {
        ck(`  ${code} does not`, !J.NEEDS_HER.test(code), code);
    }

    // A total failure of the sync — not one item, the whole call.
    sent.length = 0;
    const hard = await J.run({ plaid: { status: () => ({ configured: true, items: [{ item_id: 'i' }] }),
        syncAll: async () => { throw new Error('Plaid is not configured — set PLAID_CLIENT_ID'); } },
        ledger: ledgerOf([]), sendEmail, to: 'x@y.com' });
    ck('a sync that cannot run at all is emailed too',
       sent.length === 1 && /could not run at all/.test(sent[0].body), JSON.stringify(hard.findings));
}

// ── D — A RESTATED ROW SHE HAD ALREADY DEALT WITH ─────────────────────────
{
    section('D — the bank changed its mind after she acted');

    sent.length = 0;
    const before = [row('T1', { excluded: true, history: [{ what: 'excluded' }] })];
    const after = [row('T1', { excluded: true, history: [{ what: 'excluded' }], amount: 1500, received: 1500,
        drift: { at: '2026-10-05T00:00:00Z', fields: ['amount'], was: { amount: 1000 }, now: { amount: 1500 } } })];
    const r = await J.run({ plaid: plaidOf({ syncAll: async () => ({ added: 0, modified: 1, removed: [], errors: [], items: [] }) }),
        ledger: ledgerOf(before, after), sendEmail, to: 'x@y.com' });

    ck('a NEW drift flag is emailed', sent.length === 1, JSON.stringify(sent.map((m) => m.subject)));
    ck('  with both figures, so she can see what moved',
       /1000/.test(sent[0].body) && /1500/.test(sent[0].body), sent[0].body.slice(0, 300));
    ck('  and the field that changed', /amount/.test(sent[0].body));
    void r;

    // A drift that was ALREADY there yesterday must not be re-sent every
    // morning — that is how a real alert becomes wallpaper.
    sent.length = 0;
    const already = [row('T1', { drift: { fields: ['amount'], was: { amount: 1 }, now: { amount: 2 } } })];
    await J.run({ plaid: plaidOf({}), ledger: ledgerOf(already, already), sendEmail, to: 'x@y.com' });
    ck('a drift she has already been told about is not re-sent',
       sent.length === 0, JSON.stringify(sent.map((m) => m.subject)));
}

// ── E — THE LOUDEST ONE ───────────────────────────────────────────────────
// The bank withdrew a transaction she had already allocated against an
// invoice. Her receipt now rests on a bank movement the bank says never
// happened.
{
    section('E — a withdrawn transaction she had already used');

    // The receipt's ref is the bank transaction id — which is exactly why
    // the matching screen writes it there.
    const receipts = require(path.join(ROOT, 'helpers/salesReceipts'));
    const realList = receipts.list;
    receipts.list = () => ([{ id: 'R1', date: '2026-09-05', amount: 47000, customer: 'Custom Alloys', ref: 'T9' }]);
    try {
        sent.length = 0;
        const r = await J.run({ plaid: plaidOf({ syncAll: async () => ({ added: 0, modified: 0,
            removed: ['T9'], errors: [], items: [] }) }),
            ledger: ledgerOf([row('T9')]), sendEmail, to: 'x@y.com' });

        ck('it emails', sent.length === 1, JSON.stringify(sent.map((m) => m.subject)));
        ck('  and this is the subject, not drift — it is the worse of the two',
           /withdrew a transaction you had used/.test(sent[0].subject), sent[0].subject);
        ck('  naming the receipt, its customer and its amount',
           /R1/.test(sent[0].body) && /Custom Alloys/.test(sent[0].body) && /47,000/.test(sent[0].body),
           sent[0].body.slice(0, 400));
        // IT DOES NOT REVERSE ANYTHING. Reversing her money because a bank
        // changed its mind overnight would be its own kind of wrong.
        ck('  and says plainly that nothing was reversed automatically',
           /NOT reversed automatically/.test(sent[0].body), sent[0].body.slice(0, 500));
        ck('  telling her what to check', /delete the receipt if the payment really did not arrive/.test(sent[0].body));
        void r;

        // A withdrawn row nobody had touched is housekeeping, not news.
        receipts.list = () => [];
        sent.length = 0;
        await J.run({ plaid: plaidOf({ syncAll: async () => ({ added: 0, modified: 0, removed: ['T8'], errors: [], items: [] }) }),
            ledger: ledgerOf([row('T8')]), sendEmail, to: 'x@y.com' });
        ck('a withdrawn row she never used is NOT emailed',
           sent.length === 0, JSON.stringify(sent.map((m) => m.subject)));
    } finally { receipts.list = realList; }
    ck('  and the stub was restored', receipts.list === realList);
}

// ── F — WHERE THE EMAIL GOES ──────────────────────────────────────────────
// config.js:676 records helpers/ledgerAgentJob.js falling back to a
// cfg.ALERT_EMAIL that does not exist, so the job "logged 'no recipient
// configured' and sent nothing — for ever, without erroring". I wrote the
// same line in this file. For a job whose entire purpose is to be the one
// thing that notices a dead feed, that is the worst available bug, so the
// address is asserted rather than the code path.
{
    section('F — the address actually resolves');

    ck('cfg.ALERT_EMAIL_TO is the real name and it has a value',
       typeof cfg.ALERT_EMAIL_TO === 'string' && cfg.ALERT_EMAIL_TO.includes('@'),
       JSON.stringify(cfg.ALERT_EMAIL_TO));
    ck('  and the two names that do not exist still do not',
       cfg.ALERT_EMAIL === undefined && cfg.OWNER_EMAIL === undefined,
       JSON.stringify({ a: cfg.ALERT_EMAIL, o: cfg.OWNER_EMAIL }));

    const src = fs.readFileSync(path.join(ROOT, 'helpers/bankPullJob.js'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ck('the job reads ALERT_EMAIL_TO', /cfg\.ALERT_EMAIL_TO/.test(code), 'not a name that is undefined');
    ck('  and does not fall back to a name that does not exist',
       !/cfg\.ALERT_EMAIL\b/.test(code) && !/cfg\.OWNER_EMAIL/.test(code),
       (code.match(/cfg\.[A-Z_]+/g) || []).join(', '));

    // With no address at all it must say so, not silently succeed. Passing
    // to: '' is not enough — it falls through to the configured address,
    // which exists here. The config value itself has to be empty, which is
    // the state on a server where ALERT_EMAIL_TO was never set.
    sent.length = 0;
    const keepAddr = cfg.ALERT_EMAIL_TO;
    cfg.ALERT_EMAIL_TO = '';
    let r;
    try {
        r = await J.run({ plaid: plaidOf({ syncAll: async () => ({ added: 0, modified: 0, removed: [], items: [],
            errors: [{ item_id: 'i', institution: 'BofA', error: 'ITEM_LOGIN_REQUIRED' }] }) }),
            ledger: ledgerOf([]), sendEmail, to: null });
    } finally { cfg.ALERT_EMAIL_TO = keepAddr; }
    ck('  and the address was restored afterwards',
       cfg.ALERT_EMAIL_TO === keepAddr && cfg.ALERT_EMAIL_TO.includes('@'), JSON.stringify(cfg.ALERT_EMAIL_TO));
    ck('with no recipient it reports that, rather than claiming it sent',
       r.sent === false && /ALERT_EMAIL_TO/.test(r.reason || ''), JSON.stringify(r.reason));
    ck('  and still carries the finding, so the log has it',
       r.findings.length === 1, JSON.stringify(r.findings.map((f) => f.kind)));

    // A mail failure must not read as a clean run either.
    const boom = await J.run({ plaid: plaidOf({ syncAll: async () => ({ added: 0, modified: 0, removed: [], items: [],
        errors: [{ item_id: 'i', institution: 'BofA', error: 'ITEM_LOGIN_REQUIRED' }] }) }),
        ledger: ledgerOf([]), sendEmail: async () => { throw new Error('smtp down'); }, to: 'x@y.com' });
    ck('a send that fails is reported as not sent',
       boom.sent === false && /smtp down/.test(boom.reason || ''), JSON.stringify(boom.reason));
    ck('  and needsHer stays true, so nothing looks resolved', boom.needsHer === true);
}

// ── G — THE CRON SLOT ─────────────────────────────────────────────────────
{
    section('G — 05:45, and why not 06:00');

    const sched = fs.readFileSync(path.join(ROOT, 'scheduler.js'), 'utf8');
    ck('the job is scheduled', /cron\.schedule\('45 5 \* \* \*'/.test(sched));
    ck('  and it calls this file', /helpers\/bankPullJob'\)\.run\(\)/.test(sched));
    ck('  in her timezone, like the others',
       /cron\.schedule\('45 5 \* \* \*'[\s\S]{0,400}?TZ\)/.test(sched));
    // BEFORE the jobs that read the ledgers. A deposit arriving after the
    // 06:30 sweep is one the sweep discussed without knowing about.
    ck('  ahead of the 06:30 sweep and the 07:25/07:30 agents',
       sched.indexOf("'45 5 * * *'") > -1 && /'30 6 \* \* \*'|'25 7 \* \* \*'|'30 7 \* \* \*'/.test(sched),
       'the cascade only works if the bank is in before anything reads it');
    ck('  and not sharing a minute with the 06:00 pricelist job',
       !/cron\.schedule\('0 6 \* \* \*'[^;]*bankPullJob/.test(sched));
    ck('  a failure is caught, so one bad morning cannot stop the scheduler',
       /bankPullJob'\)\.run\(\)[\s\S]{0,300}?\.catch\(/.test(sched));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
