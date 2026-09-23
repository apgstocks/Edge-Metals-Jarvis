// tests/quickbooks-page.js — the QuickBooks page's own routes.
// No network: QB_ENV is pointed at an env with no token, so every QuickBooks
// call fails fast and the page must still answer from Jarvis's own ledgers.
process.env.QB_ENV = 'sandbox';
process.env.QB_TOKEN_FILE = '/tmp/qb-page-test-no-token.json';
process.env.QB_PARTY_MAP_FILE = '/tmp/qb-page-test-map.json';
process.env.QB_JOURNAL_FILE = '/tmp/qb-page-test-journal.jsonl';
delete process.env.QB_CUTOVER_INVOICES; delete process.env.QB_CUTOVER_BILLS;
const fs = require('fs');
for (const f of [process.env.QB_PARTY_MAP_FILE, process.env.QB_JOURNAL_FILE]) { try { fs.unlinkSync(f); } catch {} }

const express = require('express');
const routes = require('../helpers/quickbooks/routes');
let pass = 0, fail = 0; const failures = [];
const ck = (name, ok, extra) => { if (ok) { pass++; console.log('  PASS ', name); } else { fail++; failures.push(name); console.log('  FAIL ', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 200)); } };

(async () => {
    const app = express();
    app.use(express.json());
    let role = 'admin';
    app.use((req, res, next) => { req.role = role; next(); });
    routes.mount(app, { ROOT: require('path').join(__dirname, '..') });
    const server = app.listen(0);
    const port = server.address().port;
    const get = async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { code: r.status, body: await r.json().catch(() => null) }; };
    const post = async (p, body) => {
        const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { code: r.status, body: await r.json().catch(() => null) };
    };

    const status = await get('/api/qb/status');
    ck('status answers even with QuickBooks unreachable', status.code === 200 && status.body.env === 'sandbox', status.body);
    ck('status says whether writes are on', typeof status.body.writes === 'boolean' && typeof status.body.autoSync === 'boolean');
    ck('status lists the account roles so an unmapped one is visible', Array.isArray(status.body.roles) && status.body.roles.some((r) => r.role === 'prepayment'));

    const parties = await get('/api/qb/parties?qb=0');
    ck('the party list comes from Jarvis ledgers, no QuickBooks needed', parties.code === 200 && Array.isArray(parties.body.parties), parties.body);

    const page = await fetch(`http://127.0.0.1:${port}/quickbooks`);
    const html = await page.text();
    ck('the page itself is served', page.status === 200 && /Ask Jarvis|id="ask"/.test(html));
    ck('the page is locked when it loads', /🔒 Locked/.test(html));

    // ── the padlock ────────────────────────────────────────────────────────
    ck('locked: a mapping change is refused', (await post('/api/qb/map', { kind: 'vendor', jarvisName: 'X', qbId: '1' })).code === 400);
    ck('locked: a push is refused', (await post('/api/qb/push', { kind: 'bill', id: 'B1' })).code === 400);
    ck('locked: an undo is refused', (await post('/api/qb/undo', { journalId: 'J1', reason: 'because' })).code === 400);
    role = 'staff';
    const staff = await post('/api/qb/map', { kind: 'vendor', jarvisName: 'X', qbId: '1', unlock: true });
    ck('unlocked but not admin: still refused, and says why', staff.code === 403 && /admin/.test(staff.body.error), staff.body);
    role = 'admin';

    const mapped = await post('/api/qb/map', { kind: 'vendor', jarvisName: 'Mario', qbId: '588', qbName: 'LA Recycling', unlock: true });
    ck('unlocked admin: the mapping saves', mapped.code === 200 && mapped.body.saved.qbId === '588', mapped.body);
    ck('...and it reminds her to commit qb-settings', /commit/.test(mapped.body.note || ''));
    const map = JSON.parse(fs.readFileSync(process.env.QB_PARTY_MAP_FILE, 'utf8'));
    ck('...and it really is in the file', JSON.stringify(map.vendor).includes('LA Recycling'));

    const noReason = await post('/api/qb/undo', { journalId: 'J1', reason: 'x', unlock: true });
    ck('an undo without a real reason is refused', noReason.code === 400 && /reason/.test(noReason.body.error), noReason.body);
    const badKind = await post('/api/qb/push', { kind: 'nonsense', id: 'B1', unlock: true });
    ck('push only knows bill, invoice and advance', badKind.code === 400);
    const missing = await post('/api/qb/push', { kind: 'bill', id: 'NOPE', dryRun: true, unlock: true });
    ck('a push for a record that is not there says so, it does not crash', [404, 500].includes(missing.code), missing.body);

    const ask = await post('/api/qb/ask', { question: 'what do I owe him?', kind: 'vendor', name: 'Mario' });
    ck('Ask Jarvis always answers', ask.code === 200 && typeof ask.body.answer === 'string' && ask.body.answer.length > 0, ask.body);
    ck('...and always comes back with a follow-up question', /\?\s*$/.test(String(ask.body.followUp || '').trim()), ask.body);
    ck('an empty question is refused', (await post('/api/qb/ask', { question: '  ' })).code === 400);

    server.close();
    console.log(`\nquickbooks-page: ${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
})();
