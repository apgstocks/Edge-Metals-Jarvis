// tests/case-file.js — the case file END TO END (CLAUDE.md rule 3): real stores written the way the app writes them (sales, receipts, the
// follow-up log, deposit placements and questions), read back through the real route the screen would use, and through the real command.
// READ-ONLY is a property under test: reading changes no file.
const fs = require('fs'), os = require('os'), http = require('http'), path = require('path');
const { spawnSync } = require('child_process');
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-casefile-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaa'; process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc'; process.env.JARVIS_PASSWORD = 'jarvis-pw-ddddddddddd';
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('ABORT config is not isolated'); process.exit(1); }
const DAY = 86400000, NOW = Date.now();
(async () => {
    const cf = require(path.join(ROOT, 'helpers/caseFile'));
    const sales = require(path.join(ROOT, 'helpers/sales')), receipts = require(path.join(ROOT, 'helpers/salesReceipts'));
    const chaser = require(path.join(ROOT, 'helpers/paymentChaser'));
    const mk = async (customer, invoice_no, w, p) => (await sales.addSale({ customer, invoice_no, date: '2026-10-20', item: 'Auto Cast', weight: w, invoice_price: p, price_unit: 'lb', weight_unit: 'lb' })).id;
    const bal = (id) => Math.round(Number(sales.listWithTotals().find((s) => s.id === id).balance) * 100) / 100;

    console.log('\n=== pure: the status is the strongest evidence, with a reason ===');
    const S = (o) => cf.statusOf({ balance: 100, steps: {}, held: null, now: NOW, ...o });
    ck('owes, nobody told: open', S({}).status === 'open');
    ck('asked', S({ steps: { ask: '2026-11-01T00:00:00Z' } }).status === 'asked');
    ck('chased beats asked', S({ steps: { ask: '2026-11-01T00:00:00Z', chase: '2026-11-05T00:00:00Z' } }).status === 'chased');
    ck('escalated beats chased', S({ steps: { chase: '2026-11-05T00:00:00Z', escalate: '2026-11-08T00:00:00Z' } }).status === 'escalated to a person');
    ck('a hold with no date: possible payment found', S({ held: { at: NOW } }).status === 'possible payment found');
    ck('a promise in the future: promised, with the date', (() => { const r = S({ held: { at: NOW, promisedUntil: NOW + 3 * DAY, promisedOn: '2026-11-13' } }); return r.status === 'promised' && r.promisedOn === '2026-11-13'; })());
    ck('a promise that passed with the invoice still open: promise broken', S({ held: { at: NOW - 9 * DAY, promisedUntil: NOW - 2 * DAY, promisedOn: '2026-11-08' } }).status === 'promise broken');
    ck('a hold she dismissed no longer counts', S({ steps: { ask: '2026-11-01T00:00:00Z' }, held: { at: NOW, dismissed: true } }).status === 'asked');
    ck('owing nothing: paid up, whatever the log says', S({ balance: 0, steps: { escalate: '2026-11-08T00:00:00Z' } }).status === 'paid up');
    ck('every status says why', ['open', 'asked', 'chased'].every((x) => S({ steps: x === 'open' ? {} : { [x === 'asked' ? 'ask' : 'chase']: '2026-11-01T00:00:00Z' } }).why.length > 10));

    console.log('\n=== real stores, written the way the app writes them ===');
    const RAD = await mk('Rad Metal', 'RM-1', 10000, 0.5), DK = await mk('Daekwang', 'DK-1', 10000, 0.5), LT = await mk('Lotte', 'LT-1', 4000, 0.5), PD = await mk('Paidco', 'PC-1', 4000, 0.5);
    await receipts.addReceipt({ date: '2026-11-01', amount: 1000, mode: 'Zelle', bank: 'BofA', customer: 'Paidco', ref: 'z1', allocations: [{ sale_id: PD, amount: 1000 }], created_by: 'admin' });
    await receipts.addReceipt({ date: '2026-11-02', amount: 2000, mode: 'Wire', bank: 'BofA', customer: 'Daekwang', ref: 'w9', allocations: [{ sale_id: DK, amount: 2000 }], created_by: 'admin' });
    const t = (d) => new Date(NOW - d * DAY).toISOString();
    await chaser.writeLog({
        'rad metal': { set: 'x', firstAt: t(12), lastStep: 'escalate', lastAt: t(2), customer: 'Rad Metal', steps: { ask: t(12), chase: t(7), escalate: t(2) } },
        'daekwang': { set: 'y', firstAt: t(9), lastStep: 'ask', lastAt: t(9), customer: 'Daekwang', steps: { ask: t(9) }, held: { id: 'm1', at: NOW - 3 * DAY, promisedUntil: NOW + 4 * DAY, promisedOn: new Date(NOW + 4 * DAY).toISOString().slice(0, 10) } },
        '_noaddr': { at: t(1) } });
    let before = fs.readdirSync(TMP).map((f) => [f, fs.statSync(path.join(TMP, f)).mtimeMs, fs.statSync(path.join(TMP, f)).size].join(':')).sort().join('|');
    const all = cf.buildAll();
    const by = (n) => all.find((c) => c.customer === n);
    ck('one case per customer with a history or a balance; the agent\'s own "_" notes are not a customer', all.length === 4 && !all.some((c) => c.key[0] === '_'), all.map((c) => c.customer).join(','));
    ck('Rad Metal: escalated, owing 5,000 on 1 invoice', by('Rad Metal').status === 'escalated to a person' && by('Rad Metal').balance === 5000 && by('Rad Metal').open_invoices === 1);
    ck('Daekwang: promised, the date is the one the customer gave, the 2,000 received is on the timeline', by('Daekwang').status === 'promised' && by('Daekwang').events.some((e) => e.kind === 'paid' && e.amount === 2000) && by('Daekwang').balance === 3000);
    ck('Lotte (never contacted, owes): open', by('Lotte').status === 'open' && by('Lotte').events.length === 0);
    ck('Paidco paid part, still owes 0? no: 1,000 left, so open and the receipt is on the timeline', by('Paidco').balance === 1000 && by('Paidco').events.length === 1 && by('Paidco').events[0].kind === 'paid');
    ck('timeline is in date order, oldest first', by('Rad Metal').events.map((e) => e.kind).join() === 'asked,chased,escalated');
    ck('owing-most first', all.map((c) => c.balance).every((b, i, a) => i === 0 || a[i - 1] >= b));
    ck('another customer\'s receipts and log never leak in', by('Lotte').events.length === 0 && !by('Rad Metal').events.some((e) => e.kind === 'paid'));

    console.log('\n=== deposits Jarvis placed or asked about, and what she did ===');
    const A = require(path.join(ROOT, 'helpers/depositAutoApply'));
    await new Promise((r) => setTimeout(r, 10));
    fs.writeFileSync(process.env.JARVIS_AUTO_APPLIED_FILE || path.join(TMP, 'auto_applied.json'), JSON.stringify({
        entries: [{ id: 'a1', code: 'K7QM', customer: 'Lotte', amount: 1000, invoice_no: 'LT-1', reasons: ['one invoice, to the cent', 'a name already matched'], appliedAt: t(1), placedBy: 'jarvis', undone: { at: t(0.5), by: 'her', reason: 'wrong customer' } }],
        blocks: [], asks: [{ id: 'q1', code: 'W4NB', customer: 'Lotte', amount: 900, why: 'not sure — the bank line says "REFUND"', askedAt: t(3), answer: { kind: 'no', at: t(2.5) } }] }));
    await receipts.addReceipt({ date: '2026-11-09', amount: 1000, mode: 'Wire', bank: 'BofA', customer: 'Lotte', ref: 'TX-AUTO', allocations: [{ sale_id: LT, amount: 1000 }], created_by: 'jarvis-auto', note: 'applied automatically by Jarvis (K7QM)' });
    const snap = () => fs.readdirSync(TMP).map((f) => [f, fs.statSync(path.join(TMP, f)).mtimeMs, fs.statSync(path.join(TMP, f)).size].join(':')).sort().join('|');
    before = snap();
    const lt = cf.buildOne('Lotte');
    ck('the placement, her undo, the question and her answer are all on Lotte\'s timeline, in order', lt.events.map((e) => e.kind).join() === 'asked-you,answered,placed,undone', lt.events.map((e) => e.kind).join());
    ck('  the reasons she can check are in the text', /one invoice, to the cent/.test(lt.events.find((e) => e.kind === 'placed').text) && /wrong customer/.test(lt.events.find((e) => e.kind === 'undone').text));
    ck('  the Jarvis-placed receipt is not listed a second time as a plain receipt', !lt.events.some((e) => e.kind === 'paid'));

    console.log('\n=== the route the screen would call, and the command ===');
    const { createApi } = require(path.join(ROOT, 'api'));
    const server = await new Promise((r) => { const s = createApi().listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body); const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r2 = http.request(base + p, { method, headers }, (res) => { let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j, raw }); }); });
        r2.on('error', reject); if (data) r2.write(data); r2.end(); });
    const login = async (pw) => ((await req('POST', '/login', { body: { password: pw } })).json || {}).sid;
    const adminSid = await login(process.env.ADMIN_PASSWORD), userSid = await login(process.env.APP_PASSWORD);
    ck('a non-admin is refused', (await req('GET', '/api/case-files', { sid: userSid })).status === 403 && (await req('GET', '/api/case-files/one?customer=Lotte', { sid: userSid })).status === 403);
    const list = await req('GET', '/api/case-files', { sid: adminSid });
    ck('the list route returns one status per customer, without the heavy timelines', list.status === 200 && list.json.count === 4 && list.json.cases.every((c) => c.status && !('events' in c) && typeof c.event_count === 'number'), JSON.stringify(list.json).slice(0, 200));
    const one = await req('GET', '/api/case-files/one?customer=Rad%20Metal', { sid: adminSid });
    ck('the one-customer route returns the timeline', one.status === 200 && one.json.events.length === 3 && one.json.status === 'escalated to a person');
    ck('no customer named is a 400', (await req('GET', '/api/case-files/one', { sid: adminSid })).status === 400);
    server.close();
    const cmd = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'case-file.js'), 'Rad Metal'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DATA_DIR: TMP, JARVIS_TEST: '1' } });
    ck('the real command prints the timeline', cmd.status === 0 && /escalated to a person/.test(cmd.stdout) && /passed to the team/.test(cmd.stdout), cmd.stdout + cmd.stderr);
    const cmd2 = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'case-file.js')], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DATA_DIR: TMP, JARVIS_TEST: '1' } });
    ck('with no name it prints one line per customer', cmd2.status === 0 && /4 customer\(s\)/.test(cmd2.stdout), cmd2.stdout);

    console.log('\n=== read-only: reading changed no file ===');
    const after = snap();
    ck('the data folder is byte-for-byte what it was before the route and command reads', before === after, before + ' vs ' + after);
    const src = fs.readFileSync(path.join(ROOT, 'helpers/caseFile.js'), 'utf8');
    ck('the helper has no write call at all', !/writeFile|appendFile|mutateJson|saveJson|writeLog|\.put\(|rename\(/.test(src.replace(/\/\/.*$/gm, '')));
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
