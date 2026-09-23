// ── tests/ask-data.js ───────────────────────────────────────────────────────
// Apsara, 2026-09-23: "give all data access and possible advanced rag type
// chat bot ... Jarvis for Edge Metals. Scout for edge yard."
//
// What this guards, in the order it would hurt:
//   A. the GUARD — nothing but one SELECT reaches SQLite, ever
//   B. the MIRROR — its figures are the helpers' figures, and the yard is
//      not in it at all
//   C. BOTH ENGINES — node:sqlite and the python bridge give the same answer,
//      because an untested fallback is a second bug waiting
//   D. the ANSWER — every figure spoken comes from the query result; a
//      placeholder the query did not return is never silently dropped
//   E. the REPAIR — SQLite's own error goes back once, and a fixed query wins
//   F. END TO END by voice and WhatsApp, through the real server
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const R = (p) => path.join(__dirname, '..', p);

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');
const A = (r) => (r && r.json && r.json.answer) || '';
const SP = (r) => (r && r.json && r.json.spoken) || '';

function bot(port, text) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ text });
        const req = http.request({ host: '127.0.0.1', port, path: '/api/bot/command', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
                Authorization: `Bearer ${process.env.API_TOKEN}` } }, (res) => {
            let raw = ''; res.on('data', (d) => { raw += d; });
            res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json, raw }); });
        });
        req.on('error', reject); req.write(body); req.end();
    });
}
const T = (r) => ((r.json && r.json.replies) || []).map((x) => x.text).filter(Boolean).join('\n');

(async () => {

section('A. the guard — one SELECT, nothing else');
{
    const guard = require(R('helpers/data/sqlGuard'));
    for (const bad of [
        'DELETE FROM bills',
        'UPDATE bills SET balance = 0',
        'DROP TABLE sales',
        'SELECT 1; DROP TABLE sales',
        "INSERT INTO bills VALUES ('x')",
        'PRAGMA table_info(bills)',
        'ATTACH DATABASE \'/etc/passwd\' AS x',
        'WITH x AS (SELECT 1) DELETE FROM bills',
        '',
    ]) ck(`refused: ${bad.slice(0, 40) || '(empty)'}`, guard.check(bad).ok === false, JSON.stringify(guard.check(bad)));

    ck('a plain SELECT passes', guard.check('SELECT supplier FROM bills').ok === true);
    ck('a WITH ... SELECT passes', guard.check('WITH x AS (SELECT 1 AS a) SELECT a FROM x').ok === true);
    ck('a keyword INSIDE a string is data, not a command',
       guard.check("SELECT * FROM bills WHERE still_needs LIKE '%create%'").ok === true,
       JSON.stringify(guard.check("SELECT * FROM bills WHERE still_needs LIKE '%create%'")));
    ck('a LIMIT is added when there is none', /LIMIT 200$/.test(guard.withLimit('SELECT 1')));
    ck('  and her own LIMIT is left alone', guard.withLimit('SELECT 1 LIMIT 3') === 'SELECT 1 LIMIT 3');
}

section('B. the mirror — the helpers\' own figures, and no yard');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-mirror-'));
    process.env.DATA_DIR = dir;
    for (const k of Object.keys(require.cache)) if (k.startsWith(R(''))) delete require.cache[k];
    const bills = require(R('helpers/bills'));
    const sales = require(R('helpers/sales'));
    const mirror = require(R('helpers/data/dataMirror'));
    const engine = require(R('helpers/data/sqlEngine'));

    await bills.addBill({ date: '09/18/2026', supplier: 'Inesh Cores Chapin', booking_no: 'BK1', container_no: 'TCLU9988776',
        gross: 31250, truck: 9000, container: 4400, chassis: 1250, boxes: 0, supplier_price: 0.30, trucking_amount: 800,
        description: 'Electric motors' });
    await bills.addBill({ date: '09/02/2026', supplier: 'Gomez', booking_no: 'BK2', container_no: 'MSDU2726332',
        gross: 29250, truck: 8700, container: 4400, chassis: 1250, boxes: 0, supplier_price: 0.32 });
    await sales.addSale({ date: '09/20/2026', customer: 'Daekwang', booking_no: 'BK1', container_no: 'TCLU9988776',
        item: 'Electric motors', weight: 16600, invoice_price: 0.55, invoice_no: '26DK15' });
    // Deliberately half-entered — the shape her bills really arrive in, and
    // what "which bills are not finished" has to be able to find.
    await bills.addBill({ date: '09/21/2026', supplier: 'Inesh', gross: 20000, truck: 6000 });

    const info = mirror.ensure();
    const q = (sql) => engine.query(info.file, sql).rows;
    const bill = bills.listWithTotals().find((b) => b.container_no === 'TCLU9988776');
    const row = q("SELECT * FROM bills WHERE container_no = 'TCLU9988776'")[0];
    ck('the bill is there', !!row);
    ck('  net weight is the helper\'s net weight', row && row.net_lb === bill.net_lb, `${row && row.net_lb} vs ${bill.net_lb}`);
    ck('  amount is the helper\'s amount', row && row.amount === bill.amount, `${row && row.amount} vs ${bill.amount}`);
    ck('  balance is the helper\'s balance', row && row.balance === bill.balance, `${row && row.balance} vs ${bill.balance}`);
    const unfinished = bills.listWithTotals().find((b) => (bills.missingFor(b) || []).length);
    const urow = unfinished ? q(`SELECT * FROM bills WHERE bill_id = '${unfinished.id}'`)[0] : null;
    ck('  an unfinished bill says so, in English rather than field names',
       !!urow && urow.is_finished === 0 && typeof urow.still_needs === 'string' && !/_/.test(urow.still_needs),
       JSON.stringify(urow && { is_finished: urow.is_finished, still_needs: urow.still_needs }));
    ck('  and a finished one is marked finished', row && row.is_finished === (bills.missingFor(bill).length ? 0 : 1));

    // THE SCHEMA JARVIS IS TOLD ABOUT IS THE SCHEMA IT QUERIES. A column that
    // exists in one and not the other is a question that fails for a reason
    // nobody can see, so the two are asserted equal rather than compatible.
    const catalog = require(R('helpers/data/dataCatalog'));
    let drift = [];
    for (const name of Object.keys(mirror.TABLES)) {
        const described = Object.keys((catalog.find(name) || { columns: {} }).columns).sort();
        const real = q(`SELECT * FROM ${name} LIMIT 0`);
        const actual = (require(R('helpers/data/sqlEngine')).query(info.file, `SELECT name FROM pragma_table_info('${name}')`).rows || []).map((r) => r.name).sort();
        if (JSON.stringify(described) !== JSON.stringify(actual)) drift.push(`${name}: catalog ${described.join(',')} vs table ${actual.join(',')}`);
        void real;
    }
    ck('every table matches its description, column for column', drift.length === 0, drift.join(' | '));
    const sale = sales.listWithTotals()[0];
    const srow = q("SELECT * FROM sales WHERE container_no = 'TCLU9988776'")[0];
    ck('the sale matches too', srow && srow.amount === sale.amount && srow.balance === sale.balance, JSON.stringify(srow));
    const m = q('SELECT * FROM margin')[0];
    ck('margin joins the two sides', m && m.container_no === 'TCLU9988776' && m.revenue === sale.amount, JSON.stringify(m));

    // HER RULE: the yard is not Jarvis's. Not filtered — ABSENT.
    const names = q("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
    ck('no yard table exists in the mirror',
       !names.some((n) => /^(loads|inventory|petty_cash|outbound_loads|expenses|trucker_bills)$/.test(n)), names.join(','));
    ck('  the Metals tables do', ['bills', 'sales', 'margin', 'bookings', 'trucking_bills'].every((n) => names.includes(n)), names.join(','));

    // A ledger that changed must be visible to the next question.
    const before = q('SELECT COUNT(*) AS n FROM bills')[0].n;
    await bills.addBill({ date: '09/21/2026', supplier: 'Inesh', container_no: 'AAAU1111111', gross: 20000, truck: 6000 });
    const after = require(R('helpers/data/sqlEngine')).query(mirror.ensure().file, 'SELECT COUNT(*) AS n FROM bills').rows[0].n;
    ck('a new bill appears without a restart', after === before + 1, `${before} -> ${after}`);
    fs.rmSync(dir, { recursive: true, force: true });
}

section('C. both engines agree');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-engines-'));
    process.env.DATA_DIR = dir;
    for (const k of Object.keys(require.cache)) if (k.startsWith(R(''))) delete require.cache[k];
    const bills = require(R('helpers/bills'));
    await bills.addBill({ date: '09/18/2026', supplier: 'Inesh', container_no: 'C1', gross: 31250, truck: 9000, container: 4400, chassis: 1250, supplier_price: 0.3 });
    await bills.addBill({ date: '09/19/2026', supplier: 'Gomez', container_no: 'C2', gross: 20000, truck: 6000, supplier_price: 0.25 });
    const SQL = 'SELECT supplier, ROUND(SUM(amount), 2) AS spent, COUNT(*) AS n FROM bills GROUP BY supplier ORDER BY supplier';

    delete process.env.JARVIS_SQL_ENGINE;
    for (const k of Object.keys(require.cache)) if (k.startsWith(R(''))) delete require.cache[k];
    const m1 = require(R('helpers/data/dataMirror')).ensure({ force: true });
    const nodeOut = require(R('helpers/data/sqlEngine')).query(m1.file, SQL);

    process.env.JARVIS_SQL_ENGINE = 'python';
    for (const k of Object.keys(require.cache)) if (k.startsWith(R(''))) delete require.cache[k];
    const eng2 = require(R('helpers/data/sqlEngine'));
    const m2 = require(R('helpers/data/dataMirror')).ensure({ force: true });
    const pyOut = eng2.query(m2.file, SQL);

    ck('node:sqlite answered', m1.engine === 'node:sqlite' && nodeOut.rows.length === 2, m1.engine + ' ' + JSON.stringify(nodeOut.rows));
    ck('the python bridge answered', m2.engine === 'python3' && pyOut.rows.length === 2, m2.engine + ' ' + JSON.stringify(pyOut.rows));
    ck('  and the two are identical', JSON.stringify(nodeOut.rows) === JSON.stringify(pyOut.rows),
       JSON.stringify(nodeOut.rows) + ' vs ' + JSON.stringify(pyOut.rows));
    // The error text is what the repair step works from, on both engines.
    let nodeErr = '', pyErr = '';
    try { require(R('helpers/data/sqlEngine')).query(m2.file, 'SELECT nope FROM bills'); } catch (e) { pyErr = e.message; }
    delete process.env.JARVIS_SQL_ENGINE;
    for (const k of Object.keys(require.cache)) if (k.startsWith(R(''))) delete require.cache[k];
    try { require(R('helpers/data/sqlEngine')).query(m1.file, 'SELECT nope FROM bills'); } catch (e) { nodeErr = e.message; }
    ck('both say WHICH column is wrong', /nope/.test(nodeErr) && /nope/.test(pyErr), `${nodeErr} | ${pyErr}`);
    fs.rmSync(dir, { recursive: true, force: true });
}

section('D. the answer — the model never writes a number');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-ask-'));
    process.env.DATA_DIR = dir;
    for (const k of Object.keys(require.cache)) if (k.startsWith(R(''))) delete require.cache[k];
    const bills = require(R('helpers/bills'));
    await bills.addBill({ date: '09/18/2026', supplier: 'Inesh', container_no: 'C1', gross: 31250, truck: 9000, container: 4400, chassis: 1250, supplier_price: 0.30 });
    const askData = require(R('helpers/data/askData'));

    // The binder is the guarantee, so it is tested directly as well as through
    // the flow: a figure can only come from a row.
    const b1 = askData.bind('We owe {supplier} {owed}.', { supplier: 'Inesh', owed: 4300.5 }, { owed: 'money' }, 1);
    ck('placeholders are filled from the row', b1.text === 'We owe Inesh $4,300.50.' && !b1.missing.length, b1.text);
    const b2 = askData.bind('We owe {owed}.', { other: 1 }, {}, 1);
    ck('a placeholder the query did not return is reported, not dropped', b2.missing.includes('owed'), JSON.stringify(b2));
    ck('{count} is the row count', askData.bind('{count} rows.', {}, {}, 12).text === '12 rows.');
    ck('money, weights and percents are formatted here',
       askData.fmt(1234.5, 'money') === '$1,234.50' && askData.fmt(16600, 'weight_lb') === '16,600 lb' && askData.fmt(12.5, 'percent') === '12.5%');

    // Now the whole flow, with a stubbed planner.
    const gem = require(R('helpers/gemini'));
    const plans = [];
    gem.callGeminiJSON = async (p) => { plans.push(p); return plans.plan(p); };

    plans.plan = () => ({ scope: 'metals', tables: ['bills'],
        sql: 'SELECT supplier, ROUND(SUM(balance), 2) AS owed FROM bills GROUP BY supplier',
        shape: 'single', headline: 'We owe {supplier} {owed}.', formats: { owed: 'money' } });
    let out = await askData.ask('how much do we owe Inesh');
    ck('a query that worked first time is not marked as repaired', out.repaired === false, JSON.stringify(out.repaired));
    const bill = bills.listWithTotals()[0];
    ck('the figure spoken is the figure in the ledger', out.ok && out.spoken === `We owe Inesh ${askData.fmt(bill.balance, 'money')}.`, out.spoken);
    ck('  the screen says where it came from', /From bills · 1 row/.test(out.screen), out.screen);
    ck('  and shows the query result', /owed/.test(out.screen));

    plans.plan = () => ({ scope: 'metals', tables: ['bills'],
        sql: "SELECT supplier, SUM(balance) AS owed FROM bills WHERE supplier = 'Nobody At All' GROUP BY supplier",
        shape: 'single', headline: 'We owe {supplier} {owed}.', formats: { owed: 'money' } });
    out = await askData.ask('how much do we owe Nobody At All');
    ck('nothing matched is said as nothing, not as zero', out.ok && out.empty === true && /Nothing in the ledgers matched/.test(out.spoken), out.spoken);
    ck('  and it shows what it looked for', /Nobody At All/.test(out.screen), out.screen);

    plans.plan = () => ({ scope: 'yard', tables: [], sql: '', shape: 'single', headline: '' });
    out = await askData.ask('how many loads did the yard take yesterday');
    ck('a yard question is sent to Scout, not answered', out.ok === false && out.scope === 'yard' && /Scout/.test(out.spoken), out.spoken);

    // E — the repair loop.
    let asked = 0;
    plans.plan = () => {
        asked += 1;
        return asked === 1
            ? { scope: 'metals', tables: ['bills'], sql: 'SELECT suplier, SUM(balance) AS owed FROM bills', shape: 'single', headline: '{owed}', formats: { owed: 'money' } }
            : { scope: 'metals', tables: ['bills'], sql: 'SELECT ROUND(SUM(balance), 2) AS owed FROM bills', shape: 'single', headline: 'We owe {owed} in all.', formats: { owed: 'money' } };
    };
    out = await askData.ask('what do we owe in total');
    ck('a bad column is repaired on the second attempt and answered', out.ok && /We owe \$/.test(out.spoken), out.spoken);
    // scripts/ask-eval.js counts these to show what the questions really cost,
    // so the flag has to be true when a repair happened and absent when not.
    ck('  and the repair is REPORTED, not just logged', out.repaired === true, JSON.stringify(out.repaired));
    ck('  and SQLite\'s own words went back to the planner', /no such column: suplier/i.test(plans[plans.length - 1] || ''), 'the repair prompt did not carry the error');

    // A query that will not run at all is reported honestly — not as "no data".
    plans.plan = () => ({ scope: 'metals', tables: ['bills'], sql: 'SELECT * FROM not_a_table', shape: 'list', headline: '{count}' });
    out = await askData.ask('something impossible');
    ck('an unanswerable question says so and shows what it tried', out.ok === false && /different way/.test(out.spoken) && /not_a_table/.test(out.screen || ''), out.spoken);

    // A write that somehow got planned never reaches the database.
    plans.plan = () => ({ scope: 'metals', tables: ['bills'], sql: 'DELETE FROM bills', shape: 'single', headline: 'gone' });
    const countBefore = bills.list().length;
    out = await askData.ask('delete everything');
    ck('a planned DELETE is refused', out.ok === false && bills.list().length === countBefore, out.spoken);
    fs.rmSync(dir, { recursive: true, force: true });
}

section('F. end to end — voice and WhatsApp, through the server');
{
    for (const k of Object.keys(require.cache)) if (k.startsWith(R(''))) delete require.cache[k];
    const { boot } = require('./helpers/e2e');
    const j = await boot({});
    const bills = require(R('helpers/bills'));
    const sales = require(R('helpers/sales'));
    await bills.addBill({ date: '09/18/2026', supplier: 'Inesh', booking_no: 'BK1', container_no: 'TCLU9988776',
        gross: 31250, truck: 9000, container: 4400, chassis: 1250, supplier_price: 0.30, description: 'Motors' });
    await bills.addBill({ date: '09/12/2026', supplier: 'Gomez', booking_no: 'BK2', container_no: 'MSDU2726332',
        gross: 29250, truck: 8700, container: 4400, chassis: 1250, supplier_price: 0.32 });
    await sales.addSale({ date: '09/20/2026', customer: 'Daekwang', booking_no: 'BK1', container_no: 'TCLU9988776',
        item: 'Motors', weight: 16600, invoice_price: 0.55, invoice_no: '26DK15' });

    const one = await j.say('how much do we owe our suppliers');
    ck('voice answers a question nothing was hardcoded for', one.status === 200 && /suppliers are owed money/i.test(A(one)), A(one));
    ck('  the table is on screen', /Inesh/.test(A(one)) && /Gomez/.test(A(one)), A(one));
    ck('  the spoken form is the sentence only, not the table',
       /suppliers are owed money/.test(SP(one)) && !/Gomez/.test(SP(one)), SP(one));
    ck('  and it says which ledger it came from', /From bills/.test(A(one)), A(one));

    // "margin" alone is already the Margin SCREEN report (2026-09-20) and
    // stays that way — this asks something no report answers.
    const two = await j.say('how much have we spent with suppliers this year');
    ck('a second question uses a different ledger', /We spent \$/.test(A(two)) && /From bills/.test(A(two)), A(two));

    const three = await bot(j.port, 'how much do we owe our suppliers');
    ck('WhatsApp gets the same answer with the table', three.status === 200 && /Inesh/.test(T(three)) && /From bills/.test(T(three)), T(three));

    const four = await j.say('how many loads did the yard take yesterday');
    ck('a yard question is still Scout\'s', !/From bills|From margin/.test(A(four)), A(four));
    await j.stop();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log('\nFAILED:\n  - ' + failures.join('\n  - '));
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
