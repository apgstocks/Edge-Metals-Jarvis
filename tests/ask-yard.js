// ── tests/ask-yard.js ───────────────────────────────────────────────────────
// "Same treatment for Scout over Edge Yard data" (her answer, 2026-09-23),
// and CLAUDE.md rule 5: Edge Yard and Edge Metals are different companies.
//
// What this guards:
//   A. the YARD MIRROR — its figures are the yard helpers' figures
//   B. the WALL — the two books are separate files and neither can see the
//      other's tables, and a question aimed at the wrong one is handed back
//   C. SCOUT — a figure question is answered from the ledger, with the query
//      shown; everything else still goes the way it has since August
const path = require('path');
const fs = require('fs');
const os = require('os');
const R = (p) => path.join(__dirname, '..');
const Rp = (p) => path.join(__dirname, '..', p);

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

(async () => {

section('A. the yard mirror — the yard helpers\' own figures');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-yard-'));
    process.env.DATA_DIR = dir;
    for (const k of Object.keys(require.cache)) if (k.startsWith(Rp(''))) delete require.cache[k];
    const loads = require(Rp('helpers/loads'));
    const expenses = require(Rp('helpers/expenses'));
    const mirror = require(Rp('helpers/data/yardMirror'));
    const engine = require(Rp('helpers/data/sqlEngine'));

    const load = await loads.addLoad({ date: '2026-09-18', seller: 'Junk Car', gross_weight: 1200, tare_weight: 200,
        trucking_amount: 100, trucking_company: 'Sher',
        items: [{ description: 'Copper', gross_weight: 700, tare_weight: 100, price: 2.5 },
                { description: 'Brass', gross_weight: 500, tare_weight: 100, price: 1.5 }] });
    await expenses.addExpense({ date: '2026-09-19', category: 'Fuel', description: 'Diesel for the loader', amount: 60, method: 'cash', note: 'diesel' });

    const info = mirror.ensure({ force: true });
    const q = (sql) => engine.query(info.file, sql).rows;
    const row = q('SELECT * FROM yard_loads')[0];
    ck('the load is there', !!row);
    ck('  the amount is the helper\'s amount', row && row.amount === load.amount, `${row && row.amount} vs ${load.amount}`);
    ck('  and what the SELLER is owed is net of trucking, not the gross',
       row && row.net_payable === loads.payableOf(load) && row.net_payable === row.amount - 100,
       JSON.stringify({ net_payable: row && row.net_payable, amount: row && row.amount }));
    ck('  nothing paid yet, so the whole thing is pending', row && row.pending === row.net_payable && row.pay_status === 'unpaid', JSON.stringify(row && { pending: row.pending, status: row.pay_status }));

    const grades = q('SELECT grade, net_lb, amount FROM yard_load_items ORDER BY grade');
    ck('each grade is its own row', grades.length === 2 && grades[0].grade === 'Brass' && grades[1].grade === 'Copper', JSON.stringify(grades));
    ck('  with the weight net of its own tare', grades[1].net_lb === 600, JSON.stringify(grades[1]));

    const fuel = q("SELECT ROUND(SUM(amount), 2) AS spent FROM yard_expenses WHERE lower(category) LIKE '%fuel%'")[0];
    ck('expenses are queryable', fuel && fuel.spent === 60, JSON.stringify(fuel));
    fs.rmSync(dir, { recursive: true, force: true });
}

section('B. the wall between the two companies');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-wall-'));
    process.env.DATA_DIR = dir;
    for (const k of Object.keys(require.cache)) if (k.startsWith(Rp(''))) delete require.cache[k];
    const loads = require(Rp('helpers/loads'));
    const bills = require(Rp('helpers/bills'));
    await loads.addLoad({ date: '2026-09-18', seller: 'Junk Car', gross_weight: 1200, tare_weight: 200,
        items: [{ description: 'Copper', gross_weight: 700, tare_weight: 100, price: 2.5 }] });
    await bills.addBill({ date: '09/18/2026', supplier: 'Inesh', container_no: 'TCLU9988776', gross: 31250, truck: 9000, supplier_price: 0.3 });

    const yard = require(Rp('helpers/data/yardMirror')).ensure({ force: true });
    const metals = require(Rp('helpers/data/dataMirror')).ensure({ force: true });
    const engine = require(Rp('helpers/data/sqlEngine'));
    ck('they are two different files', yard.file !== metals.file, `${yard.file} vs ${metals.file}`);

    const yardTables = engine.query(yard.file, "SELECT name FROM sqlite_master WHERE type='table'").rows.map((r) => r.name);
    const metalTables = engine.query(metals.file, "SELECT name FROM sqlite_master WHERE type='table'").rows.map((r) => r.name);
    ck('Scout cannot see a Metals table', !yardTables.some((n) => ['bills', 'sales', 'margin', 'bookings'].includes(n)), yardTables.join(','));
    ck('Jarvis cannot see a yard table', !metalTables.some((n) => n.startsWith('yard_')), metalTables.join(','));
    let threw = null;
    try { engine.query(yard.file, 'SELECT * FROM bills'); } catch (e) { threw = e.message; }
    ck('  asking the yard book for bills is an error, not an empty answer', /no such table/i.test(threw || ''), String(threw));

    // A question for the other company is handed back, not answered.
    const gem = require(Rp('helpers/gemini'));
    gem.callGeminiJSON = async (p) => (/EDGE YARD/.test(p)
        ? { scope: 'metals', tables: [], sql: '', shape: 'single', headline: '' }
        : { scope: 'yard', tables: [], sql: '', shape: 'single', headline: '' });
    const askData = require(Rp('helpers/data/askData'));
    const toJarvis = await askData.ask('how many containers did we ship', { book: 'yard' });
    ck('Scout sends a Metals question to Jarvis', toJarvis.ok === false && toJarvis.scope === 'metals' && /ask Jarvis/i.test(toJarvis.spoken), toJarvis.spoken);
    const toScout = await askData.ask('how many loads did we take', { book: 'metals' });
    ck('Jarvis sends a yard question to Scout', toScout.ok === false && toScout.scope === 'yard' && /ask Scout/i.test(toScout.spoken), toScout.spoken);
    fs.rmSync(dir, { recursive: true, force: true });
}

section('C. Scout answers a figure question from the ledger');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-scout-'));
    process.env.DATA_DIR = dir;
    for (const k of Object.keys(require.cache)) if (k.startsWith(Rp(''))) delete require.cache[k];
    const loads = require(Rp('helpers/loads'));
    await loads.addLoad({ date: '2026-03-04', seller: 'Junk Car', gross_weight: 1200, tare_weight: 200, trucking_amount: 100,
        items: [{ description: 'Copper', gross_weight: 700, tare_weight: 100, price: 2.5 },
                { description: 'Brass', gross_weight: 500, tare_weight: 100, price: 1.5 }] });

    const gem = require(Rp('helpers/gemini'));
    const prompts = [];
    gem.callGeminiJSON = async (p) => {
        prompts.push(p);
        if (/EDGE YARD/.test(p) && /read-only SQLite query/.test(p)) {
            // Follows the NAME in the question, like a real planner would —
            // otherwise every question returns Junk Car's row and the
            // "nothing matched" case below proves nothing.
            const who = /nobody/i.test(p) ? 'nobody at all' : 'junk car';
            return { scope: 'yard', tables: ['yard_loads'],
                sql: `SELECT seller, ROUND(SUM(pending), 2) AS owed FROM yard_loads WHERE pending > 0 AND lower(seller) LIKE '%${who}%' GROUP BY seller`,
                shape: 'single', headline: 'We owe {seller} {owed}.', formats: { owed: 'money' } };
        }
        // The old brief path. `have_data: false` is what it really says about
        // a March question: the brief is a 30-day window and March is not in
        // it. That is exactly when the ledger takes over.
        if (/march|nobody/i.test(p)) return { answer: '', have_data: false };
        return { answer: 'FROM THE BRIEF', have_data: true };
    };
    const { askYard } = require(Rp('helpers/yardAsk'));

    const out = await askYard('how much do we owe Junk Car from March');
    ck('a figure question is answered from the ledger', out.ok && out.from === 'ledger' && /We owe Junk Car \$2,000\.00/.test(out.spoken || ''), JSON.stringify({ from: out.from, spoken: out.spoken }));
    ck('  the query is on screen with the answer', /SELECT/.test(out.answer) || /From yard_loads/.test(out.answer), out.answer);
    ck('  and it answered from OUTSIDE the 30-day brief window', /2,000/.test(out.spoken), out.spoken);

    // Everything else is untouched — the path she has had since August.
    const other = await askYard('what happened with the Junk Car load');
    ck('a question that is not about a figure still goes the old way',
       other && /FROM THE BRIEF/.test(other.answer || ''), JSON.stringify(other && other.answer));

    // AND THE COST: a question the brief CAN answer never reaches the ledger,
    // so it still costs one model call (tests/yard-ask-tools.js holds the
    // same property from the other side).
    const cheap = await askYard('how much did we buy this month');
    ck('a figure question the brief answers does not pay for a second look',
       cheap && /FROM THE BRIEF/.test(cheap.answer || '') && cheap.from !== 'ledger', JSON.stringify(cheap && cheap.answer));

    // And a ledger that cannot answer falls back rather than failing.
    // Neither side has it: the brief has nothing and the query matches no row.
    // She gets the honest answer rather than a figure from somewhere.
    const empty = await askYard('how much do we owe Nobody At All');
    ck('when neither the brief nor the ledger has it, it says so',
       empty && empty.ok === false && /couldn't work out an answer/i.test(empty.answer || ''),
       JSON.stringify(empty && empty.answer));

    const logged = require(Rp('helpers/data/askLog')).recent(10);
    ck('Scout\'s questions are logged too, marked as Scout\'s',
       logged.some((r) => r.source === 'scout' && /owe Junk Car/.test(r.question)), JSON.stringify(logged.map((r) => [r.source, r.outcome])));
    fs.rmSync(dir, { recursive: true, force: true });
}

section('D. the TEXT chat gets the same answer as voice');
{
    // Apsara, 2026-09-23: "even on text chat bot — give the same replica."
    // The yard chat box posts to /api/yard/ask and Jarvis's chat box posts to
    // /api/bot/command; both must produce the ledger answer, not a summary of
    // one. Asserted through the real routes, not the helpers.
    for (const k of Object.keys(require.cache)) if (k.startsWith(Rp(''))) delete require.cache[k];
    const http = require('http');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-yardchat-'));
    process.env.DATA_DIR = dir;
    process.env.JARVIS_TEST = '1';
    process.env.API_TOKEN = process.env.API_TOKEN || 'yard-token';
    const loads = require(Rp('helpers/loads'));
    await loads.addLoad({ date: '2026-03-04', seller: 'Junk Car', gross_weight: 1200, tare_weight: 200, trucking_amount: 100,
        items: [{ description: 'Copper', gross_weight: 700, tare_weight: 100, price: 2.5 }] });
    const gem = require(Rp('helpers/gemini'));
    gem.callGeminiJSON = async (p) => (/EDGE YARD/.test(p) && /read-only SQLite query/.test(p)
        ? { scope: 'yard', tables: ['yard_loads'],
            sql: 'SELECT seller, ROUND(SUM(pending), 2) AS owed FROM yard_loads WHERE pending > 0 GROUP BY seller',
            shape: 'single', headline: 'We owe {seller} {owed}.', formats: { owed: 'money' } }
        // The brief has nothing (the load is from March), which is what sends
        // the question on to the ledger.
        : { answer: '', have_data: false });

    const { createApi } = require(Rp('api'));
    const srv = http.createServer(createApi()).listen(0);
    await new Promise((r) => srv.once('listening', r));
    const port = srv.address().port;
    const post = (p2, body) => new Promise((resolve, reject) => {
        const d = JSON.stringify(body);
        const r = http.request({ host: '127.0.0.1', port, path: p2, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d),
                Authorization: `Bearer ${process.env.API_TOKEN}` } }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j, raw }); });
        });
        r.on('error', reject); r.write(d); r.end();
    });

    const chat = await post('/api/yard/ask', { question: 'how much do we owe Junk Car', source: 'chat' });
    ck('the yard chat box answers from the ledger',
       chat.status === 200 && /We owe Junk Car \$1,400\.00/.test((chat.json || {}).answer || ''),
       chat.raw.slice(0, 220));
    ck('  and shows the query behind it', /From yard_loads/.test((chat.json || {}).answer || '') || /SELECT/.test((chat.json || {}).sql || ''), (chat.json || {}).answer);
    ck('  the same text a voice turn would put on screen',
       (chat.json || {}).from === 'ledger' && typeof (chat.json || {}).spoken === 'string', JSON.stringify({ from: (chat.json || {}).from, spoken: (chat.json || {}).spoken }));

    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log('\nFAILED:\n  - ' + failures.join('\n  - '));
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
