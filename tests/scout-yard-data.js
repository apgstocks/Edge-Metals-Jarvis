// ── tests/scout-yard-data.js ──────────────────────────────────────────────
// Apsara, 2026-11-20, with her Petty cash screen showing "$-25,386.03 company not stated": "i want scout to answer
// such kind of questions" — and then, wider: "any data available in edge yard should be reasoned by scout".
//
// A — petty cash, explained: per account, per company, and a negative bucket traced to its own rows.
// B — the other yard stores Scout could not see: every payment, supplier credit, the audit log, addresses, metal types.
// C — END TO END (CLAUDE.md §3): Scout's real route, the model stubbed to ask for the tool, and the figures that reach
//     the model's second turn checked against the seeded data — the gap between "the tool works" and "Scout can answer".
// D — coverage: every Edge Yard store has a Scout read, and every new one is read-only and described to the model.

const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (x !== undefined) console.log('        ' + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 600)); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-scoutdata-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
process.env.CHANGE_LOG_DIR = path.join(TMP, 'change-log');
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }
const W = (f, v) => fs.writeFileSync(f, JSON.stringify(v));

// ── seed: Unassigned goes negative because a big cash payment came out of it ──
W(cfg.LOADS_FILE, [
    { id: 'EDGE_01', date: '2026-09-02', seller: 'Randy Recycling', amount: 3000, items: [{ description: 'Rotors', net_weight: 10000, price: 0.3, amount: 3000 }] },
    { id: 'EDGE_02', date: '2026-10-05', seller: 'Fred Metals', amount: 900, items: [{ description: 'HMS', net_weight: 3000, price: 0.3, amount: 900 }] },
]);
W(cfg.OUTBOUND_LOADS_FILE, [{ id: 'OUT_01', date: '2026-10-20', buyer: 'Metalco', items: [] }]);
W(cfg.PETTY_CASH_FILE, [
    { id: 'PC_1', kind: 'topup', amount: 1000, date: '2026-09-01', note: 'opening float' },
    { id: 'PC_2', kind: 'payment', amount: -3000, date: '2026-09-02', load_id: 'EDGE_01', payment_id: 'P1' },
    { id: 'PC_3', kind: 'topup', amount: 500, date: '2026-10-01', cash_source: 'Chase Bank' },
    { id: 'PC_4', kind: 'topup', amount: 2000, date: '2026-10-02', cash_source: 'Edge Metals' },
    { id: 'PC_5', kind: 'payment', amount: -400, date: '2026-10-05', cash_source: 'Edge Metals', load_id: 'EDGE_02' },
]);
W(cfg.PAYMENTS_FILE, [
    { id: 'P1', load_id: 'EDGE_01', load_kind: 'purchase', mode: 'Cash', amount: 3000, paid_on: '2026-09-02' },
    { id: 'P2', load_id: 'EDGE_02', load_kind: 'purchase', mode: 'Zelle', bank: 'Chase Bank', paid_via: 'Edge Yard', amount: 500, paid_on: '2026-10-05' },
    { id: 'A1', is_advance: true, seller: 'Fred Metals', mode: 'Wire', amount: 800, paid_on: '2026-10-01' },
    { id: 'P3', load_id: 'EDGE_02', load_kind: 'purchase', applied_from: 'A1', amount: 300, paid_on: '2026-10-06' },
    { id: 'P4', load_id: 'OUT_01', load_kind: 'sale', mode: 'Bank transfer', amount: 1200, paid_on: '2026-10-21' },
]);
W(cfg.ADDRESS_BOOK_FILE, [{ id: 'ab1', name: 'Randy Recycling LLC', aliases: ['Randy'], address: '12 Scrap Rd, Fontana CA', phone: '+1 909 555 0101' }]);

const tools = require(path.join(ROOT, 'helpers/tools'));
const run = (n, p) => tools.runRead(n, p || {});

(async () => {
section('A — petty cash, explained');
{
    const all = await run('petty_cash');
    ck('the total cash in hand is still there', all.balance === 100, all.balance);
    ck('  and so are the recent movements, as before', Array.isArray(all.rows) && all.rows.length === 5);
    ck('per company, matching the screen: Company not stated −2,000, Edge Metals 1,600, Edge Yard 500',
        all.by_company['Company not stated'] === -2000 && all.by_company['Edge Metals'] === 1600 && all.by_company['Edge Yard'] === 500, all.by_company);
    ck('per account, with Chase belonging to Edge Yard', all.by_account.Unassigned === -2000 && all.company_of_account['Chase Bank'] === 'Edge Yard', all.by_account);
    ck('it says in words what "Company not stated" means, and not to guess a company', /Unassigned account/.test(all.company_not_stated_means) && /do not assign/i.test(all.company_not_stated_means));

    const ex = await run('petty_cash', { account: 'Company not stated' });
    ck('explaining "Company not stated" reads the Unassigned account', JSON.stringify(ex.explaining.accounts) === '["Unassigned"]', ex.explaining);
    ck('  its balance, money in and money out add up from its own rows (−2,000 = 1,000 in − 3,000 out)',
        ex.explaining.balance === -2000 && ex.explaining.money_in === 1000 && ex.explaining.money_out === -3000, ex.explaining);
    ck('  totalled by kind (top-up in, payment out)', ex.explaining.by_kind.topup.in === 1000 && ex.explaining.by_kind.payment.out === -3000, ex.explaining.by_kind);
    ck('  the biggest withdrawal is named: 3,000 for EDGE_01, paid to Randy Recycling',
        ex.largest_outflows[0] && ex.largest_outflows[0].amount === -3000 && ex.largest_outflows[0].load_id === 'EDGE_01' && ex.largest_outflows[0].seller === 'Randy Recycling', ex.largest_outflows);
    ck('  only that account\'s rows are listed', ex.rows.length === 2 && ex.rows.every((r) => r.account === 'Unassigned'));
    ck('"unassigned" and a company name both work', (await run('petty_cash', { account: 'unassigned' })).explaining.balance === -2000
        && (await run('petty_cash', { account: 'Edge Yard' })).explaining.accounts.join() === 'Chase Bank');
    ck('an unknown name says so and lists the accounts, rather than answering for the wrong one', /not a cash account/.test((await run('petty_cash', { account: 'Wells' })).error || ''));
    ck('a date range narrows the explanation', (await run('petty_cash', { account: 'Unassigned', to: '2026-09-01' })).explaining.balance === 1000);
}

section('B — the other yard stores');
{
    const p = await run('find_payments');
    ck('every payment is searchable, with who it was for', p.count === 5 && p.rows.find((r) => r.id === 'P1').who === 'Randy Recycling'
        && p.rows.find((r) => r.id === 'P4').who === 'Metalco' && p.rows.find((r) => r.id === 'A1').who === 'Fred Metals', p.rows);
    ck('  kinds are told apart: purchase, sale, prepayment', p.by_kind.purchase === 3800 && p.by_kind.sale === 1200 && p.by_kind.prepayment === 800, p.by_kind);
    ck('  filter by mode', (await run('find_payments', { mode: 'zelle' })).total_amount === 500);
    ck('  by which company paid', (await run('find_payments', { paid_via: 'Edge Yard' })).count === 1);
    ck('  by person, loosely', (await run('find_payments', { who: 'randy' })).total_amount === 3000);
    ck('  by date', (await run('find_payments', { from: '2026-10-01', to: '2026-10-31' })).count === 4);
    ck('  the money total and the row count are separate figures', p.total_amount === 5800 && p.total === 5);
    ck('  a prepayment applied to a load says which prepayment', p.rows.find((r) => r.id === 'P3').applied_from_prepayment === 'A1');

    const c = await run('seller_credit');
    ck('seller credit: Fred has 500 left of an 800 prepayment', c.rows.length === 1 && c.rows[0].seller === 'Fred Metals' && c.rows[0].available === 500, c);
    ck('  and for one seller', (await run('seller_credit', { seller: 'Fred Metals' })).available === 500);

    require(path.join(ROOT, 'helpers/changeLog')).record({ actor: 'maria', action: 'Load edited', subject: 'EDGE_01', ok: true, changes: [{ field: 'items[1].price', from: 0.32, to: 0.3 }] });
    const h = await run('change_history', { subject: 'EDGE_01' });
    ck('the audit log is readable: who changed EDGE_01, and the price before → after', h.total === 1 && h.rows[0].actor === 'maria' && h.rows[0].changes[0].from === 0.32, h);

    const a = await run('find_address', { name: 'randy' });
    ck('addresses are found by name or alias', a.rows.length === 1 && /Fontana/.test(a.rows[0].address));

    const cat = await run('item_catalogue');
    ck('the item catalogue now carries ferrous / non-ferrous', cat.metal_types && typeof cat.metal_types === 'object');
}

section('C — end to end: ask Scout on its real route, and see the figures reach the model');
{
    const gem = require(path.join(ROOT, 'helpers', 'gemini'));
    const { createApi } = require(path.join(ROOT, 'api'));
    const server = await new Promise((r) => { const s = createApi().listen(0, '127.0.0.1', () => r(s)); });
    const port = server.address().port;
    const req = (m, p, body, sid) => new Promise((resolve) => {
        const d = body ? JSON.stringify(body) : null; const h = {};
        if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); }
        if (sid) h.Authorization = 'Bearer ' + sid;
        const r = http.request({ host: '127.0.0.1', port, path: p, method: m, headers: h }, (res) => { let raw = ''; res.on('data', (x) => { raw += x; }); res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) { /* */ } resolve({ status: res.statusCode, json: j, raw }); }); });
        r.on('error', () => resolve({ status: 0 })); if (d) r.write(d); r.end();
    });
    const prompts = [];
    const real = gem.callGeminiJSON;
    // First turn: the model asks for the tool. Second turn: it answers — and we keep the prompt to see what it was given.
    gem.callGeminiJSON = async (prompt) => {
        prompts.push(prompt);
        if (prompts.length === 1) return { answer: '', have_data: true, tool: { name: 'petty_cash', params: { account: 'Company not stated' } }, action: null };
        return { answer: 'Company not stated is minus 2,000 because 3,000 cash paid for EDGE_01 to Randy Recycling came out of the Unassigned account, which only had a 1,000 float.', have_data: true, tool: null, action: null };
    };
    try {
        const sid = ((await req('POST', '/login', { password: process.env.ADMIN_PASSWORD })).json || {}).sid;
        const r = await req('POST', '/api/yard/ask', { question: 'Why is company not stated negative in petty cash?', source: 'website' }, sid);
        ck('Scout answers on its real route', r.status === 200 && /minus 2,000/.test((r.json || {}).answer || ''), r.raw.slice(0, 300));
        ck('  the model was told about the new petty cash tool', /petty_cash/.test(prompts[0] || '') && /Company not stated/.test(prompts[0] || ''));
        const second = prompts[1] || '';
        ck('  and on its second turn it was given the real figures: −2000, the 3000 withdrawal, EDGE_01, Randy Recycling',
            /-2000/.test(second) && /-3000/.test(second) && /EDGE_01/.test(second) && /Randy Recycling/.test(second), second.slice(-1500));
        ck('  with the instruction not to assign that money to a company', /do not assign it to a company/.test(second));
        const promptHasAll = ['find_payments', 'seller_credit', 'change_history', 'find_address'].every((n) => (prompts[0] || '').includes(n));
        ck('every new yard tool is offered to the model', promptHasAll);
    } finally { gem.callGeminiJSON = real; server.close(); }
}

section('D — coverage and safety');
{
    const reads = tools.readToolNames();
    // Every Edge Yard store, and the Scout read that reaches it. A new yard store with no line here is a store Scout
    // cannot reason about — which is the gap she asked to close.
    const STORE_TO_TOOL = {
        LOADS_FILE: 'find_loads', OUTBOUND_LOADS_FILE: 'find_sales', PAYMENTS_FILE: 'find_payments', PETTY_CASH_FILE: 'petty_cash',
        TRUCKER_BILLS_FILE: 'trucker_bills', EXPENSES_FILE: 'find_expenses', ADDRESS_BOOK_FILE: 'find_address',
    };
    for (const [store, tool] of Object.entries(STORE_TO_TOOL)) ck(`${store} → ${tool}`, !!cfg[store] && reads.includes(tool), { store, tool });
    for (const t of ['load_drafts', 'scale_tickets', 'item_catalogue', 'seller_credit', 'change_history', 'inventory', 'explain_stock', 'yard_profit', 'spend_report'])
        ck(`  and ${t}`, reads.includes(t));
    for (const n of ['petty_cash', 'find_payments', 'seller_credit', 'change_history', 'find_address'])
        ck(`${n} only reads (no confirmation card, nothing written)`, tools.TOOLS[n].kind === 'read' && !tools.TOOLS[n].propose);
    const before = fs.readFileSync(cfg.PETTY_CASH_FILE, 'utf8') + fs.readFileSync(cfg.PAYMENTS_FILE, 'utf8');
    for (const n of ['petty_cash', 'find_payments', 'seller_credit']) await run(n, n === 'petty_cash' ? { account: 'Unassigned' } : {});
    ck('reading changed no file', before === fs.readFileSync(cfg.PETTY_CASH_FILE, 'utf8') + fs.readFileSync(cfg.PAYMENTS_FILE, 'utf8'));
    ck('no freight words in the new descriptions (the router must not send these questions to the freight bot)',
        !['petty_cash', 'find_payments', 'seller_credit', 'change_history', 'find_address'].some((n) => /\b(container|booking|invoice|vessel|freight)\b/i.test(tools.TOOLS[n].description)));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
