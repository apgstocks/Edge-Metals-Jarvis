// tests/party-invoice-nightly.js — the nightly freight/trucker invoice sweep + the morning note.
// Apsara, 2026-10-08. The sweep itself (Gmail + Gemini) is stubbed — it cannot run here — but everything
// after it is real: the export file it writes, normalize/upsertMany into the register, the register route
// the screen reads, and the digest email's content. Gmail's sender is stubbed so nothing is mailed.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-nightly-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = 'user-pw-aaa'; process.env.ADMIN_PASSWORD = 'admin-pw-bbb'; process.env.STAFF_PASSWORD = 'staff-pw-ccc';
delete process.env.PARTY_INVOICE_SWEEP;
let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); if (x) console.log('        ' + x); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const PI = require(path.join(ROOT, 'helpers/partyInvoices'));
const N = require(path.join(ROOT, 'helpers/partyInvoiceNightly'));
const DAY = 86400000;

// What the sweep writes to --export-json: [{ party, ...record }].
const REC = [
    { party: 'jio', invoice_no: 'J100', container_no: 'AAAA1111111', net_amount: 900, status: 'verified', source_file: 'j.pdf' },
    { party: 'ajtransport', invoice_no: 'A200', container_no: 'BBBB2222222', total_amount: 800, status: 'not_in_sheet' },
    { party: 'zimex', invoice_no: 'Z300', hbl_no: 'HBL3', amount: 1500, status: 'match' },
    { party: 'jio', invoice_no: 'JX', container_no: 'HMMU4285998', net_amount: 20671.2, status: 'verified' },     // Edge's own invoice: over the cap
    { party: 'eaglebrit', invoice_no: 'XSCRN/1', kind: 'credit_note', booking_no: 'EBKG1', containers: ['CCCC3333333'], amount: -75, status: 'credit_note' },
];
// A stand-in for the sweep script: records the arguments it was called with and writes the export it is told to.
const fakeSweep = (records, { fail = null } = {}) => { const calls = []; const f = async (args) => { calls.push(args); if (fail) throw Object.assign(new Error('sweep exited 1'), { stderr: fail }); const i = args.indexOf('--export-json'); fs.writeFileSync(args[i + 1], JSON.stringify({ exported_at: 'now', records })); return { stdout: '' }; }; f.calls = calls; return f; };

(async () => {
    section('A. the night run');
    const t0 = Date.parse('2026-10-08T06:30:00Z');             // 23:30 on 7 Oct, Los Angeles
    const sw = fakeSweep(REC);
    const r1 = await N.runNightly({ exec: sw, now: t0 });
    const a = sw.calls[0];
    ck('asks the sweep for RECENT mail only (--newer-than), not all of 2026', a[a.indexOf('--newer-than') + 1] === '3d');
    ck('asks for exactly the register parties — no NTG/TQL/Schneider, no stray', a[a.indexOf('--party') + 1] === 'zimex,jio,sher,ajtransport,panmetal,gardunos,eaglebrit');
    ck('does NOT pass --write (nothing goes to the Google sheet tabs)', !a.includes('--write'));
    ck('the run is ok and counts what it did: 4 added (junk over-cap left out)', r1.run.ok && r1.run.added === 4 && r1.run.read === 5, JSON.stringify(r1.run));
    const reg = PI.list();
    ck('the lines are in the register against their party', reg.find((r) => r.invoice_no === 'J100').party === 'jio' && reg.find((r) => r.invoice_no === 'A200').party === 'ajtransport' && reg.find((r) => r.invoice_no === 'Z300').party === 'zimex');
    ck('Eagle (sweep key "eaglebrit") files under Eagle Trans, credit note kept negative', reg.find((r) => r.invoice_no === 'XSCRN/1').party === 'eagle' && reg.find((r) => r.invoice_no === 'XSCRN/1').amount === -75);
    ck('the over-cap junk row never reached the register', !reg.some((r) => r.invoice_no === 'JX') && r1.run.skipped && Object.keys(r1.run.skipped).some((k) => /over \$3000/.test(k)));
    ck('nothing was written to bills / sales / payments', ['bills.json', 'sales.json', 'bill_payments.json', 'metals_trucking.json'].every((f) => !fs.existsSync(path.join(TMP, f))));

    section('B. it is safe to run every night');
    const again = await N.runNightly({ exec: fakeSweep(REC), now: t0 + DAY });
    ck('the same mail again adds NOTHING (overlapping window is harmless)', again.run.ok && again.run.added === 0 && PI.list().length === 4);
    const row = PI.list().find((r) => r.invoice_no === 'J100');
    await PI.editRow(row.id, { amount: 950, note: 'rate corrected' });
    const third = await N.runNightly({ exec: fakeSweep(REC), now: t0 + 2 * DAY });
    ck('a line she edited by hand is NOT overwritten by the sweep', PI.list().find((r) => r.id === row.id).amount === 950 && third.run.kept_locked >= 1);
    await PI.addPayment({ amount: 800, paid_on: '2026-10-08', mode: 'Wire', allocations: [{ row_id: PI.list().find((r) => r.invoice_no === 'A200').id, amount: 800 }] });
    const lowered = await N.runNightly({ exec: fakeSweep([{ ...REC[1], total_amount: 500 }]), now: t0 + 3 * DAY });
    ck('a re-read figure never drops a line below what is already paid', PI.list().find((r) => r.invoice_no === 'A200').amount === 800 && lowered.run.kept_locked === 1);

    section('C. a failed night says so and adds nothing');
    const before = PI.list().length;
    const bad = await N.runNightly({ exec: fakeSweep([], { fail: 'STOPPED: bose@edgemetals.com is not among the mailboxes being scanned.' }), now: t0 + 4 * DAY });
    ck('failure is recorded with the reason, not swallowed', !bad.run.ok && /bose@edgemetals\.com/.test(bad.run.error), JSON.stringify(bad.run));
    ck('and nothing was added', PI.list().length === before);
    const stale = await N.runNightly({ exec: async () => ({ stdout: '' }), now: t0 + 5 * DAY });
    ck('a sweep that "succeeds" but wrote no export is a failure, not an empty night (and a stale export is never reused)', !stale.run.ok && /no export/.test(stale.run.error));

    section('D. the window follows the last GOOD night');
    {
        const runs = JSON.parse(fs.readFileSync(path.join(TMP, 'party_invoice_nightly.json'), 'utf8')).runs;
        const lastOk = Date.parse(runs.filter((x) => x.ok).pop().at);
        ck('two nights after a good one: reaches back past it', N.windowDays(lastOk + 2 * DAY) === 3);
        ck('a week of failures: window grows to cover it', N.windowDays(lastOk + 7 * DAY) === 8);
        ck('capped at 30 days', N.windowDays(lastOk + 90 * DAY) === 30);
    }

    section('E. the morning note');
    fs.unlinkSync(path.join(TMP, 'party_invoice_nightly.json'));   // a clean log: sections A-D used invented future dates
    const sent = [];
    // Fresh store state for a clean digest: new rows now, last note was the day before.
    await new Promise((r) => setTimeout(r, 20));
    const base = Date.now();
    await new Promise((r) => setTimeout(r, 20));
    const f2 = fakeSweep([{ party: 'sher', invoice_no: 'S9', booking_no: 'BKS9', quantity: 1, amount: 640, status: 'not_in_sheet' }, { party: 'gardunos', invoice_no: '170', container_no: 'DDDD4444444', total_amount: 930, status: 'verified' }]);
    await N.runNightly({ exec: f2, now: Date.now() });
    await new Promise((r) => setTimeout(r, 20));
    const d = N.buildDigest({ since: new Date(base).toISOString(), now: Date.now() + 60000 });
    ck('lists ONLY what was added since the last note (2, not the earlier 4)', d.fresh.length === 2, String(d.fresh.length));
    ck('grouped by party, with invoice, reference and amount', /Sher Trucking — 1 line/.test(d.body) && /S9\s+BKS9\s+\$640\.00/.test(d.body) && /Garduno's — 1 line/.test(d.body) && /170\s+DDDD4444444\s+\$930\.00/.test(d.body), d.body);
    ck('flags a line that is not on the sheet', /S9[^\n]*NOT on the sheet/.test(d.body) && /1 of these are not on your Invoice sheet/.test(d.body));
    ck('subject says how many are new', /Invoice register: 2 new/.test(d.subject), d.subject);
    { const f = path.join(TMP, 'party_invoice_nightly.json'); const cur = JSON.parse(fs.readFileSync(f, 'utf8')); cur.digest_through = new Date(base).toISOString(); fs.writeFileSync(f, JSON.stringify(cur)); }   // the last note went out just before the E run
    const note = await N.sendDigest({ send: async (m) => { sent.push(m); }, now: Date.now() + 60000 });
    ck('sent once, to bose@, apsara@ and accounts@edgemetals.com — all three on the one email', sent.length === 1 && ['bose@edgemetals.com', 'apsara@edgemetals.com', 'accounts@edgemetals.com'].every((a) => sent[0].to.includes(a)) && !/gmail/.test(sent[0].to) && /Invoice register: \d+ new/.test(sent[0].subject), sent[0] && sent[0].to);
    {   // the REAL MIME builder must accept that To value as three recipients (a stubbed sender would hide a bad header)
        const raw = Buffer.from(require(path.join(ROOT, 'helpers/gmail')).buildMimeMessage({ to: sent[0].to, subject: sent[0].subject, body: sent[0].body }), 'base64').toString('utf8');
        const toLine = (raw.match(/^To: (.*)$/mi) || [])[1] || '';
        ck('the MIME To header carries all three addresses', ['bose@', 'apsara@', 'accounts@'].every((a) => toLine.includes(a)), toLine);
    }
    await N.runNightly({ exec: fakeSweep([]), now: base + 60000 + DAY / 2 });   // the next night finds nothing
    const nextDay = await N.sendDigest({ send: async (m) => { sent.push(m); }, now: base + 60000 + DAY });
    ck('the next note does not repeat them (the "since" mark moved)', nextDay.fresh.length === 0 && sent.length === 2);
    ck('a night with nothing new still sends a note that says so — silence would read as a quiet night', /nothing new/.test(sent[1].subject) && !/PROBLEM/.test(sent[1].subject), sent[1].subject);
    const failedNote = N.buildDigest({ since: new Date(t0 + 3.5 * DAY).toISOString(), now: t0 + 4.5 * DAY, runs: [{ at: new Date(t0 + 4 * DAY).toISOString(), ok: false, error: 'STOPPED: bose@edgemetals.com is not among the mailboxes being scanned.' }] });
    ck('a failed night is in the note, with the reason, and the subject says PROBLEM', /PROBLEM/.test(failedNote.subject) && /FAILED/.test(failedNote.body) && /bose@edgemetals\.com/.test(failedNote.body), failedNote.body);
    const noRun = N.buildDigest({ since: new Date(t0 + 20 * DAY).toISOString(), now: t0 + 21 * DAY, runs: [] });
    ck('a night that did not run at all is called out, not reported as "nothing new"', /DID NOT RUN/.test(noRun.body) && /PROBLEM/.test(noRun.subject));
    let sendFailed = null;
    const keep = JSON.parse(fs.readFileSync(path.join(TMP, 'party_invoice_nightly.json'), 'utf8')).digest_through;
    try { await N.sendDigest({ send: async () => { throw new Error('smtp down'); }, now: base + 3 * DAY }); } catch (e) { sendFailed = e.message; }
    ck('if the email fails, the "since" mark does NOT move (tomorrow\'s note still carries it)', /smtp down/.test(sendFailed || '') && JSON.parse(fs.readFileSync(path.join(TMP, 'party_invoice_nightly.json'), 'utf8')).digest_through === keep);

    section('F. end to end: what the night added is what the screen reads');
    const { createApi } = require(path.join(ROOT, 'api'));
    const server = await new Promise((r) => { const s = createApi().listen(0, '127.0.0.1', () => r(s)); });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const req = (method, p, { sid, body } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body); const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r = http.request(baseUrl + p, { method, headers }, (res) => { let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); }); });
        r.on('error', reject); if (data) r.write(data); r.end();
    });
    const sid = (await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json.sid;
    const list = (await req('GET', '/api/party-invoices?party=gardunos', { sid })).json;
    ck("Garduno's line the night imported is on the register route the screen reads", list.rows.length === 1 && list.rows[0].invoice_no === '170' && list.rows[0].amount === 930);
    ck('and Eagle\'s credit note, against Eagle Trans', (await req('GET', '/api/party-invoices?party=eagle', { sid })).json.rows.some((r) => r.invoice_no === 'XSCRN/1'));
    server.close();

    section('G. switches and wiring');
    process.env.PARTY_INVOICE_SWEEP = 'off';
    const off = await N.runNightly({ exec: fakeSweep(REC) });
    ck('PARTY_INVOICE_SWEEP=off: the night does nothing', !!off.skipped && !off.run);
    ck('...and the morning note is off too', !!(await N.sendDigest({ send: async () => { throw new Error('must not send'); } })).skipped);
    delete process.env.PARTY_INVOICE_SWEEP;
    const sched = fs.readFileSync(path.join(ROOT, 'scheduler.js'), 'utf8');
    const sweepScript = fs.readFileSync(path.join(ROOT, 'scripts/freight-2026-email-sweep.js'), 'utf8');
    ck('scheduler: night run at 23:30 (after the 23:15 sheet sync), note at 07:50', /cron\.schedule\('30 23 \* \* \*',[^\n]*\n?\s*require\('\.\/helpers\/partyInvoiceNightly'\)\.runNightly|'30 23 \* \* \*',\s+\(\) => require\('\.\/helpers\/partyInvoiceNightly'\)\.runNightly/.test(sched) && /'50 7 \* \* \*',\s+\(\) => require\('\.\/helpers\/partyInvoiceNightly'\)\.sendDigest/.test(sched) && /'15 23 \* \* \*'/.test(sched));
    ck('scheduler: a failed night is logged as FAILED — NOTHING WAS ADDED, not as a summary', /party-invoice-sweep FAILED — NOTHING WAS ADDED/.test(sched));
    ck('the sweep script takes --newer-than and still defaults to all of 2026 without it', /--newer-than/.test(sweepScript) && /: 'after:2026\/1\/1 before:2027\/1\/1'/.test(sweepScript));
    ck('--newer-than is validated (digits + d only) before it reaches a Gmail query', /\^\\d\{1,3\}d\$/.test(sweepScript));

    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
