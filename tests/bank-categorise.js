// ── tests/bank-categorise.js ───────────────────────────────────────────────
// Apsara, 2026-10-13: a $5 "External transfer fee" sat in For review with no way
// to say what it was — "there should be a categoriser dropdown and post/match
// button, just like QuickBooks or even better."
//
//   A  the rules: what can be categorised, to what, and what is refused
//   B  the books: one balanced entry, the right company and bank, undo removes it
//   C  the traps: a second identical fee is NOT swallowed by the first one's entry
//   D  END TO END: real server — preview, post, queue, double press, non-admin, undo
//   E  wiring: the screen, and the account code that was wrong (6300 vs 6200)
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-bcat-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
process.env.BANK_TX_FILE = path.join(TMP, 'bank-tx.json');
process.env.BANK_LEARN_FILE = path.join(TMP, 'bank-learn.json');
process.env.QB_DECISIONS_FILE = path.join(TMP, 'qb-decisions.json');
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaa'; process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
const R = (p) => path.join(ROOT, p);

const row = (o) => ({ id: 'r1', date: '2026-10-07', desc: 'External transfer fee - Next Day - 10/06/2026 Confirmation: XXXXX6844', party: '',
    spent: 5, received: 0, amount: 5, direction: 'out', bank: 'BofA', company: 'Edge Metals INC', pending: false, excluded: false, matched: null, history: [], ...o });
fs.writeFileSync(process.env.BANK_TX_FILE, JSON.stringify([
    row({ id: 'fee1' }),
    row({ id: 'fee2', date: '2026-10-09' }),                                         // same $5, two days later
    row({ id: 'chase', bank: 'Chase Bank', company: 'EDGE TRADING INC', desc: 'Monthly service fee' }),
    row({ id: 'nocompany', company: null, desc: 'Mystery debit' }),
    row({ id: 'incoming', direction: 'in', spent: 0, received: 5, amount: 5, desc: 'Deposit' }),
    row({ id: 'pend', pending: true }),
]));

(async () => {
    const BE = require(R('helpers/bankEntries'));
    const ledger = require(R('helpers/bankLedger'));
    const BB = require(R('helpers/booksBuild'));
    const BO = require(R('helpers/bankOut'));
    const get = (id) => ledger.list().find((r) => r.id === id);

    section('A. the rules');
    {
        const codes = BE.categories().map((c) => c.code);
        ck('bank charges and other operating expenses are offered', codes.includes('6200') && codes.includes('6900') && codes.includes('6180'));
        ck('owner drawings are offered', codes.includes('3100'));
        ck('receivable, payable, advances, inter-company, the banks and material are NOT',
            !['1200', '2010', '1350', '1400', '2400', '1010', '1020', '5000', '5200', '4000'].some((c) => codes.includes(c)), codes.join(','));
        ck('her fee is suggested as Bank charges', BE.suggest(get('fee1').desc) === '6200');
        ck('an unclear description is NOT given a default', BE.suggest('ZIMEX LLC') === null && BE.suggest('DMV registration fee') === null);
        ck('a good pick is plannable, with the company from the row', BE.plan(get('fee1'), { account: '6200' }).ok && BE.plan(get('fee1'), { account: '6200' }).entry.entity);
        ck('  and says what it will book', /Dr 6200 .*5[.]00 [/] Cr 1010/.test(BE.plan(get('fee1'), { account: '6200' }).effect), BE.plan(get('fee1'), { account: '6200' }).effect);
        ck('Chase fee -> the Chase bank, and the other company', BE.plan(get('chase'), { account: '6200' }).entry.bank_code === '1020'
            && BE.plan(get('chase'), { account: '6200' }).entry.entity !== BE.plan(get('fee1'), { account: '6200' }).entry.entity);
        ck('an account that is not offered is refused', !BE.plan(get('fee1'), { account: '1200' }).ok && !BE.plan(get('fee1'), { account: '1010' }).ok);
        ck('no account is refused', !BE.plan(get('fee1'), {}).ok);
        ck('money IN is refused', !BE.plan(get('incoming'), { account: '6200' }).ok);
        ck('a pending line is refused', !BE.plan(get('pend'), { account: '6200' }).ok);
        const nc = BE.plan(get('nocompany'), { account: '6200' });
        ck('a line with no known company will not post until she chooses', !nc.ok && nc.problems.some((p) => /which company/.test(p)));
        ck('  and posts once she does', BE.plan(get('nocompany'), { account: '6200', entity: BE.plan(get('fee1'), { account: '6200' }).entry.entity }).ok);
    }

    section('B. the books');
    {
        const before = BB.build({});
        const out = await BE.post(get('fee1'), { account: '6200', by: 'Apsara' });
        ck('it books', !!out.entry.id && !out.already);
        const after = BB.build({});
        const mine = after.lines.filter((l) => l.source && l.source.store === 'bank_entries');
        ck('one balanced pair: Dr 6200, Cr 1010, 5.00', mine.length === 2
            && mine.some((l) => l.account === '6200' && l.debit === 5) && mine.some((l) => l.account === '1010' && l.credit === 5), JSON.stringify(mine));
        ck('  on the right company', mine.every((l) => l.entity === out.entry.entity));
        ck('  and the whole journal still balances, per company too', after.journal.balanced && after.journal.everyEntityBalanced);
        ck('  and nothing else moved', after.lines.length - before.lines.length === 2);
        ck('the bank row is ticked, with the key the journal line really has',
            get('fee1').matched && get('fee1').matched.keys[0] === BO.payments(after.lines, { code: '1010' }).find((p) => p.source && p.source.store === 'bank_entries').key,
            JSON.stringify(get('fee1').matched));
        ck('pressing it twice books it once', (await BE.post(get('fee1').matched ? { ...get('fee1'), matched: null } : get('fee1'), { account: '6200' })).already === true
            && BB.build({}).lines.filter((l) => l.source && l.source.store === 'bank_entries').length === 2);
        ck('a row already ticked is refused', !BE.plan(get('fee1'), { account: '6200' }).ok);
    }

    section('C. the trap — a second identical fee');
    {
        const built = BB.build({});
        const sweep = BO.sweep({ rows: ledger.list(), lines: built.lines, code: '1010' });
        // No payment is recorded anywhere in this fixture except the entries Jarvis
        // made itself, so NO bank row may come back matched: any 'matched' here is a
        // row (this fee, or another $5 row in the fixture) swallowed by someone
        // else's entry and left unbooked.
        ck("no bank row is matched to an entry made for a different row (that would leave it unbooked)",
            sweep.results.every((r) => r.outcome !== 'matched' && r.outcome !== 'combined'), JSON.stringify(sweep.results.map((r) => r.row.id + ':' + r.outcome)));
        ck('  and the pool of recorded payments holds none of them', sweep.recorded === 0, String(sweep.recorded));
        ck("  and fee #1's entry is not offered as an unclaimed payment either", !sweep.unclaimed.some((u) => u.source && u.source.store === 'bank_entries'));
        const out2 = await BE.post(get('fee2'), { account: '6200' });
        ck('fee #2 books on its own', !out2.already && BB.build({}).lines.filter((l) => l.source && l.source.store === 'bank_entries').length === 4);
    }

    section('D. the undo');
    {
        const undone = await BE.undoForRow('fee1', { by: 'Apsara' });
        ck('undo finds it', !!undone);
        ck('  the books lose exactly that pair', BB.build({}).lines.filter((l) => l.source && l.source.store === 'bank_entries').length === 2);
        ck('  the bank row is un-ticked', !get('fee1').matched);
        ck('  the entry is kept, marked reversed (audit trail)', BE.list().find((e) => e.id === undone.id).reversed_at);
        ck('undoing a row with nothing booked is null, not an error', (await BE.undoForRow('chase')) === null);
        ck('and it can be categorised again after an undo', (await BE.post(get('fee1'), { account: '6900' })).already === false);
        await BE.undoForRow('fee1'); await BE.undoForRow('fee2');
    }

    section('E. END TO END — real server, the routes the screen uses');
    {
        const { createApi } = require(R('api'));
        const srv = http.createServer(createApi()).listen(0);
        await new Promise((r) => srv.once('listening', r));
        const port = srv.address().port;
        const call = (method, p2, sid, body) => new Promise((resolve, reject) => {
            const d = body === undefined ? null : JSON.stringify(body);
            const headers = {};
            if (sid) headers.Authorization = `Bearer ${sid}`;
            if (d) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(d); }
            const r = http.request({ host: '127.0.0.1', port, path: p2, method, headers }, (res) => {
                let raw = ''; res.on('data', (c) => { raw += c; });
                res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j, raw }); });
            });
            r.on('error', reject); if (d) r.write(d); r.end();
        });
        const admin = ((await call('POST', '/login', null, { password: process.env.ADMIN_PASSWORD })).json || {}).sid;
        const user = ((await call('POST', '/login', null, { password: process.env.APP_PASSWORD })).json || {}).sid;
        ck('two sessions', !!admin && !!user);

        const q0 = await call('GET', '/api/bank/review', admin);
        const fee = (q0.json.queue.rows || []).find((r) => r.id === 'fee1');
        ck("her line is in For review as something to categorise, suggested 6200", fee && (fee.state === 'ask' || fee.state === 'add') && fee.categorise && fee.categorise.suggested === '6200', JSON.stringify(fee));
        const cats = await call('GET', '/api/bank/review/categories', admin);
        ck('the dropdown list and companies come from the server', cats.status === 200 && cats.json.categories.length >= 10 && cats.json.companies.length >= 2);

        const pv = await call('POST', '/api/bank/review/categorise', admin, { id: 'fee1', account: '6200', preview: true });
        ck('preview says what would be booked and writes nothing', pv.json.ok && /Cr 1010/.test(pv.json.effect) && BE.list().filter((e) => !e.reversed_at).length === 0, pv.raw.slice(0, 200));
        const nc = await call('POST', '/api/bank/review/categorise', admin, { id: 'nocompany', account: '6200', preview: true });
        ck('a line with no company says the screen must ask', nc.json.needs_company === true);

        const denied = await call('POST', '/api/bank/review/categorise', user, { id: 'fee1', account: '6200' });
        ck('a non-admin cannot post', denied.status === 403 && BE.list().filter((e) => !e.reversed_at).length === 0);
        const bad = await call('POST', '/api/bank/review/categorise', admin, { id: 'fee1', account: '1200' });
        ck('an account that is not offered is refused', bad.status === 400);
        const gone = await call('POST', '/api/bank/review/categorise', admin, { id: 'nope', account: '6200' });
        ck('an unknown row is a 404', gone.status === 404);

        const ok = await call('POST', '/api/bank/review/categorise', admin, { id: 'fee1', account: '6200' });
        ck('admin posts it', ok.status === 200 && ok.json.ok && !ok.json.already, ok.raw.slice(0, 200));
        const q1 = await call('GET', '/api/bank/review', admin);
        ck('the line leaves For review', !(q1.json.queue.rows || []).some((r) => r.id === 'fee1'));
        ck('  but the second identical fee is still there to be dealt with', (q1.json.queue.rows || []).some((r) => r.id === 'fee2'));
        const again = await call('POST', '/api/bank/review/categorise', admin, { id: 'fee1', account: '6200' });
        ck('a second press on the same row is refused, not booked twice', again.status === 409 && BE.list().filter((e) => !e.reversed_at).length === 1, again.raw.slice(0, 200));
        const listed = await call('GET', '/api/bank/review/categorised', admin);
        ck('it shows under "Booked from this screen"', listed.json.entries.length === 1 && listed.json.entries[0].bank_row_id === 'fee1');
        const audits = require(R('helpers/audit')).listEntries().filter((a) => a.action === 'categorise-bank-line');
        ck('the post is in the audit log, done', audits.length === 1 && audits[0].outcome === 'done' && audits[0].subject === 'fee1', JSON.stringify(audits));

        const nu = await call('POST', '/api/bank/review/categorise/undo', user, { id: 'fee1' });
        ck('a non-admin cannot undo', nu.status === 403);
        const un = await call('POST', '/api/bank/review/categorise/undo', admin, { id: 'fee1' });
        ck('admin undoes it', un.status === 200 && un.json.ok);
        ck('  the line is back in For review', (await call('GET', '/api/bank/review', admin)).json.queue.rows.some((r) => r.id === 'fee1'));
        ck('  and the books no longer have it', BB.build({}).lines.filter((l) => l.source && l.source.store === 'bank_entries').length === 0);
        ck('undo with nothing booked is a 404', (await call('POST', '/api/bank/review/categorise/undo', admin, { id: 'fee1' })).status === 404);
        srv.close();
    }

    section('F. wiring');
    {
        const html = fs.readFileSync(R('dashboard/bank-match.html'), 'utf8');
        ck('the screen has the dropdown, Post and Undo', /data-cat-sel/.test(html) && /data-cat-post/.test(html) && /data-uncat/.test(html));
        ck('  and no longer tells her the only action is a plan screen that does not exist', !/that creates a record, so it goes through the plan screen/.test(html));
        ck('the bank-charge kind points at account 6200, which the chart has', /account: '6200'/.test(fs.readFileSync(R('helpers/bankReview.js'), 'utf8'))
            && !!require(R('helpers/chartOfAccounts')).get('6200') && !require(R('helpers/chartOfAccounts')).get('6300'));
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
