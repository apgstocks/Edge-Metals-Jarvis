// tests/quickbooks-page.js — the QuickBooks page's own routes.
// No network: QB_ENV is pointed at an env with no token, so every QuickBooks
// call fails fast and the page must still answer from Jarvis's own ledgers.
process.env.QB_ENV = 'sandbox';
// A fresh directory per run. Fixed /tmp paths broke the day a leftover file
// from an earlier run belonged to another user: the atomic rename inside
// saveMap() failed with EPERM and the test blamed the code (2026-09-25).
const _tmp = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'qbpage-'));
process.env.QB_TOKEN_FILE = require('path').join(_tmp, 'token.json');
process.env.QB_PARTY_MAP_FILE = require('path').join(_tmp, 'party-map.json');
process.env.QB_JOURNAL_FILE = require('path').join(_tmp, 'journal.jsonl');
delete process.env.QB_CUTOVER_INVOICES; delete process.env.QB_CUTOVER_BILLS;
const fs = require('fs');

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

    // ── who is ahead ───────────────────────────────────────────────────────
    // The chat told her she owed Hugo $144,792.91 while he held $806,619.75 of
    // her money (2026-09-24). One signed number, said in words.
    const R = require('../helpers/quickbooks/routes');
    const fake = (bills, advances) => {
        const d = { bills, invoices: [], advances, journal: [] };
        const sum = (a) => Math.round(a.reduce((s, x) => s + x.amount, 0) * 100) / 100;
        return { owed: Math.round((sum(bills) - sum(advances.filter(x => x.kind === 'advance'))) * 100) / 100 };
    };
    ck('advances bigger than bills means HE is holding her money',
       fake([{ amount: 144792.91 }], [{ kind: 'advance', amount: 806619.75 }]).owed < 0);
    ck('bills bigger than advances means she owes him',
       fake([{ amount: 90000 }], [{ kind: 'advance', amount: 10000 }]).owed === 80000);
    const askHugo = await post('/api/qb/ask', { question: 'do we owe anything to Hugo?', kind: 'vendor', name: 'Hugo' });
    ck('the answer never leaves the two piles unresolved',
       askHugo.code === 200 && (!askHugo.body.degraded || /holding|owe|no bills|no records/i.test(askHugo.body.answer)), askHugo.body);

    // an exact name must be OFFERED, not hidden behind "(no near matches)"
    const M = require('../helpers/quickbooks/mapping');
    const qbNames = [{ Id: '561', DisplayName: 'FMC METALS', Active: true }, { Id: '571', DisplayName: 'FMC Metal', Active: true }];
    const hit = M.matchParty('FMC METALS', qbNames, 'customer');
    ck('an exact name comes back under qb, not candidates — the trap', hit.status === 'exact' && !!hit.qb && (hit.candidates || []).length === 0, hit.status);
    const routesSrc = fs.readFileSync(require('path').join(__dirname, '..', 'helpers', 'quickbooks', 'routes.js'), 'utf8');
    ck('...so the candidates route puts it at the head of the list', /const exact = m\.qb \?/.test(routesSrc));
    const pageSrc = fs.readFileSync(require('path').join(__dirname, '..', 'dashboard', 'quickbooks.html'), 'utf8');
    ck('...and the dialog marks it', /same name, almost certainly this one/.test(pageSrc));

    server.close();
    try { fs.rmSync(_tmp, { recursive: true, force: true }); } catch {}
    console.log(`\nquickbooks-page: ${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
})();
