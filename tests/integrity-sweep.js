// ── tests/integrity-sweep.js ──────────────────────────────────────────────
// Apsara, 2026-09-26: "Is it possible to run an agent everyday in website to
// find out any issue or discrepancy?" — email, everything it notices.
//
// ── A CHECK THAT CANNOT FIRE IS THE WHOLE RISK ────────────────────────────
// This is a nightly job whose entire job is to find nothing most days. That
// makes it uniquely able to be broken without anyone noticing: a filter that
// never matches looks exactly like a clean ledger, every morning, forever.
//
// It nearly shipped that way. The first `unfinished-bills` read `b.is_finished`
// — a field that does not exist on a bill. It is DERIVED in
// helpers/data/dataMirror.js for the SQL mirror, out of bills.missingFor().
// The filter was always false. The check read correctly, would have run every
// night, and would have found nothing for the rest of its life. It was caught
// by seeding a fixture with one fault of each kind and noticing that two of
// seven checks stayed silent — not by reading the code, which looked fine.
//
// So section A is the important one: every check must FIRE against data that
// genuinely has its fault, and be SILENT against data that does not. Both
// halves, or a check that flags everything passes as easily as a real one.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sweep-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const sweep = require(path.join(ROOT, 'helpers/integritySweep'));

const ago = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const OLD = ago(60);          // past STALE_DAYS
const TODAY = ago(0);

const bill = (id, o) => Object.assign({
    id, date: OLD, supplier: 'Fede', booking_no: 'BK1', container_no: 'AAAU1111111',
    gross: 60000, truck: 14000, container: 5000, chassis: 0, boxes: 0,
    supplier_price: 0.32, advance: 0,
}, o);
const sale = (id, o) => Object.assign({
    id, date: OLD, customer: 'MK Trading', booking_no: 'BK1', container_no: 'DDDU4444444',
    weight: 20, price: 1000,
}, o);

const write = (bills, sales) => {
    fs.writeFileSync(path.join(TMP, 'bills.json'), JSON.stringify(bills, null, 1));
    fs.writeFileSync(path.join(TMP, 'sales.json'), JSON.stringify(sales, null, 1));
    // Every helper caches nothing across calls here, but the mirror does.
    try { require(path.join(ROOT, 'helpers/data/dataMirror')).invalidate(); } catch (e) {}
};

const fired = (id, res) => res.findings.some((f) => f.id === id);
const countOf = (id, res) => (res.findings.find((f) => f.id === id) || {}).count || 0;

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — EVERY CHECK FIRES ON ITS OWN FAULT, AND ONLY ON IT');
// ══════════════════════════════════════════════════════════════════════════
{
    // One clean bill and one clean sale, matched into a closed container.
    const CLEAN_B = [bill('OK1', { container_no: 'ZZZU9999999' })];
    const CLEAN_S = [sale('OKS1', { container_no: 'ZZZU9999999' })];

    write(CLEAN_B, CLEAN_S);
    const clean = sweep.run();
    ck('a matched pair raises nothing', clean.clean === true,
       clean.findings.map((f) => `${f.id}:${f.count}`).join(', '));
    ck('  and no check threw', clean.broken.length === 0,
       clean.broken.map((b) => `${b.id}: ${b.error}`).join(' | '));

    // Each fault, one at a time, so a check cannot pass by flagging
    // everything it is shown.
    const cases = [
        ['duplicate-bills', [...CLEAN_B, bill('D1'), bill('D2')], CLEAN_S],
        ['duplicate-sales', CLEAN_B, [...CLEAN_S, sale('DS1'), sale('DS2')]],
        ['weight-gap', [...CLEAN_B, bill('W1', { container_no: 'WWWU1111111', items: [{ description: 'Cu', weight: 100, price: 0.3 }] })], CLEAN_S],
        ['unfinished-bills', [...CLEAN_B, bill('U1', { container_no: 'UUUU1111111', gross: '' })], CLEAN_S],
        ['incomplete-rows', [...CLEAN_B, bill('I1', { container_no: 'IIIU1111111', supplier: '' })], CLEAN_S],
        ['unjoined-containers', [...CLEAN_B, bill('J1', { container_no: 'JJJU1111111' })], CLEAN_S],
    ];

    for (const [id, bills, sales] of cases) {
        write(bills, sales);
        const res = sweep.run();
        ck(`${id} fires on its own fault`, fired(id, res),
           'a filter that never matches looks exactly like a clean ledger');
        ck(`  and reports what to look at`,
           (res.findings.find((f) => f.id === id) || { items: [] }).items.every((i) => i.what && i.detail));
    }

    // The other half: silent when the fault is absent. Checked on the clean
    // pair, because a check that flags every row passes section A's first
    // half just as easily as a correct one.
    write(CLEAN_B, CLEAN_S);
    const back = sweep.run();
    for (const c of sweep.CHECKS) {
        ck(`  ${c.id} is silent when there is nothing wrong`, !fired(c.id, back));
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('B — a fresh row is not a problem yet');
// ══════════════════════════════════════════════════════════════════════════
// Everything typed this morning would otherwise be a finding on day one, and
// an email full of today's work is an email she learns to delete.
{
    write([bill('NEW1', { container_no: 'NNNU1111111', date: TODAY, gross: '' })], []);
    const res = sweep.run();
    ck('a bill typed today is not yet "unfinished"', !fired('unfinished-bills', res),
       JSON.stringify(res.findings.map((f) => f.id)));
    ck('  nor is a container bought today "unsold"', !fired('unjoined-containers', res));

    write([bill('OLD1', { container_no: 'NNNU1111111', date: OLD, gross: '' })], []);
    ck('  but the same bill at 60 days is', fired('unfinished-bills', sweep.run()));
}

// ══════════════════════════════════════════════════════════════════════════
section('C — a weight gap of a few pounds is not news');
// ══════════════════════════════════════════════════════════════════════════
// bills.js says it plainly: the weighbridge and the packing list disagree by
// a few pounds as a matter of course. The threshold is what turns a fact into
// a finding, so it has to be the thing under test.
{
    const net = 60000 - 14000 - 5000;             // 41,000 lb
    write([bill('G1', { container_no: 'GGGU1111111', items: [{ description: 'Cu', weight: net - 10, price: 0.3 }] })], []);
    ck(`${sweep.WEIGHT_GAP_LB > 10 ? 'a 10 lb gap' : 'a small gap'} is ignored`, !fired('weight-gap', sweep.run()));

    write([bill('G2', { container_no: 'GGGU2222222', items: [{ description: 'Cu', weight: net - 5000, price: 0.3 }] })], []);
    ck('  a 5,000 lb gap is reported', fired('weight-gap', sweep.run()));
}

// ══════════════════════════════════════════════════════════════════════════
section('D — it survives a broken check, and says which');
// ══════════════════════════════════════════════════════════════════════════
// Six checks in one pass. If the first to throw took the sweep with it, she
// would hear nothing about the other five ledgers — the opposite of the point.
{
    const saved = sweep.CHECKS[0].run;
    sweep.CHECKS[0].run = () => { throw new Error('deliberate'); };
    write([bill('D1'), bill('D2')], []);
    const res = sweep.run();
    ck('a throwing check does not stop the others', res.findings.length > 0,
       JSON.stringify(res.findings.map((f) => f.id)));
    ck('  and is reported as broken by name', res.broken.some((b) => b.id === sweep.CHECKS[0].id),
       JSON.stringify(res.broken));
    ck('  so a silently dead check cannot hide', res.clean === false);
    sweep.CHECKS[0].run = saved;
}

// ══════════════════════════════════════════════════════════════════════════
section('E — the email');
// ══════════════════════════════════════════════════════════════════════════
{
    const job = require(path.join(ROOT, 'helpers/integritySweepJob'));

    write([bill('E1'), bill('E2')], []);
    const res = sweep.run();
    const text = sweep.reportText(res);
    ck('the report names the container and the ids', /AAAU1111111/.test(text) && /E1, E2/.test(text), text.slice(0, 160));
    ck('  and says why it matters', /reads cheaper than it was/.test(text));
    ck('  the subject leads with the count', /^Jarvis: \d+ thing/.test(job.subjectFor(res)), job.subjectFor(res));

    write([bill('OK1', { container_no: 'ZZZU9999999' })], [sale('OKS1', { container_no: 'ZZZU9999999' })]);
    const cleanRes = sweep.run();
    ck('a clean sweep says so in one line', /^Nothing to report/.test(sweep.reportText(cleanRes)));

    // ── AND IT DOES NOT SEND WHEN THERE IS NOTHING TO SAY ────────────────
    // A daily "all fine" is one she stops opening, and then the morning it
    // matters she does not open that either.
    const out = await job.run();
    ck('nothing is sent when clean', out.sent === false && out.why === 'clean', JSON.stringify(out.why));

    // The guard that matters most in a test file: this must never reach her
    // mailbox from a test run.
    const jobSrc = fs.readFileSync(path.join(ROOT, 'helpers/integritySweepJob.js'), 'utf8');
    ck('the sender can be called without sending', /send = true/.test(jobSrc) && /if \(!send\)/.test(jobSrc));
    const dry = await job.run({ send: false });
    ck('  and send:false really does not send', dry.sent === false && dry.why === 'send:false');
    ck('  while still returning the findings', typeof dry.text === 'string' && dry.text.length > 0);

    // A missing destination must be reported, not thrown — the scheduler
    // wraps this in a .catch that only logs.
    ck('no destination is a warning, not a crash', /no destination/.test(jobSrc));
}

// ══════════════════════════════════════════════════════════════════════════
section('F — it never writes');
// ══════════════════════════════════════════════════════════════════════════
// A nightly job that quietly tidies a ledger is how a figure disappears that
// nobody can get back. Every finding names rows and stops.
{
    const src = fs.readFileSync(path.join(ROOT, 'helpers/integritySweep.js'), 'utf8');
    for (const bad of ['mutateJson', 'writeFileSync', 'unlink', 'rmSync', 'appendFile']) {
        ck(`  the sweep never calls ${bad}`, !src.includes(bad));
    }
    // And it reaches no outside service — it reads ledgers, nothing else.
    for (const bad of ['gemini', 'drive', 'sendEmail']) {
        ck(`  and never touches ${bad}`, !src.includes(bad));
    }

    const before = fs.readFileSync(path.join(TMP, 'bills.json'), 'utf8');
    sweep.run();
    ck('running it leaves the ledger byte-identical',
       fs.readFileSync(path.join(TMP, 'bills.json'), 'utf8') === before);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error(e); process.exit(1); });
