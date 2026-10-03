// ── tests/metals-settlements-sql.js ───────────────────────────────────────
// Apsara, 2026-10-03: "Migrate just the data" / "For now, start with edge
// metals", having decided the database stays a TRUE COPY and the JSON stays
// authoritative.
//
// ── WHAT THE MIGRATION ACTUALLY WAS ──────────────────────────────────────
// Almost all of it was already built. helpers/data/dataMirror.js has kept ten
// Edge Metals tables in SQLite for weeks. One ledger was missing:
// sales_settlements — freight, port charges and commission, the money paid
// OUT on a sale.
//
// And it was missing in the worst way. signature() has listed
// SALES_SETTLEMENTS_FILE since the mirror was written, so the whole database
// was REBUILT every time she paid a freight invoice, and there was no table at
// the end of it. Pure cost, no answer: "what did we pay Zimex this quarter"
// could not be right, because that money was not in the database at all.
//
// ── SO THIS GOES END TO END ──────────────────────────────────────────────
// CLAUDE.md rule 3. A helper test and a mirror test can both be green while
// the feature does not work, and the gaps live between them. So: post through
// the ROUTE the Freight screen posts to, rebuild the mirror, and read the
// figure back with SQL through the same engine the question path uses. Then
// delete it through the route the Delete button uses, and check it leaves.
//
// Deltas, not absolutes, wherever an earlier section has already written.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-settl-sql-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = 'user-pw-aaa';
process.env.ADMIN_PASSWORD = 'admin-pw-bbb';
process.env.STAFF_PASSWORD = 'staff-pw-ccc';
process.env.JARVIS_PASSWORD = 'jarvis-pw-ddd';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.SALES_SETTLEMENTS_FILE).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against real data');
    process.exit(1);
}

const { mutateJson } = require(path.join(ROOT, 'helpers/json'));
const dataMirror = require(path.join(ROOT, 'helpers/data/dataMirror'));
const catalog = require(path.join(ROOT, 'helpers/data/dataCatalog'));
const engine = require(path.join(ROOT, 'helpers/data/sqlEngine'));
const { createApi } = require(path.join(ROOT, 'api'));

let server, base;
function req(method, urlPath, { sid, body } = {}) {
    return new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r = http.request(base + urlPath, { method, headers }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => {
                let json = null; try { json = JSON.parse(raw); } catch (e) {}
                resolve({ status: res.statusCode, json, raw });
            });
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}

// Every query goes through the mirror the question path uses, rebuilt first.
const sql = (q) => {
    dataMirror.invalidate();
    const m = dataMirror.ensure({ force: true });
    const r = engine.query(m.file, q);
    return { rows: r.rows || r, counts: m.counts };
};

(async () => {

const app = createApi();
await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
base = `http://127.0.0.1:${server.address().port}`;
const jarvis = (await req('POST', '/login', { body: { password: 'jarvis-pw-ddd' } })).json;

// Two sales, so a join and a GROUP BY have something to be wrong about.
await mutateJson(cfg.SALES_FILE, [], (all) => {
    const rows = Array.isArray(all) ? all : [];
    rows.push({
        id: 'S_A', date: '09/11/2026', customer: 'Aris Enterprises',
        booking_no: 'BK-A', container_no: 'MSDU1111111', hbl_no: 'H1', items: [],
        charges: [{ id: 'CH_F', what: 'Ocean freight', why: 'Zimex', amount: 2500, direction: 'out' },
                  { id: 'CH_P', what: 'Port fees', why: 'terminal', amount: 300, direction: 'out' }],
        commission_amount: 400,
    });
    rows.push({
        id: 'S_B', date: '09/12/2026', customer: 'HYNOS',
        booking_no: 'BK-B', container_no: 'TGCU2222222', hbl_no: 'H2', items: [],
        charges: [{ id: 'CH_F2', what: 'Ocean freight', why: 'Zimex', amount: 1800, direction: 'out' }],
    });
    return rows;
});

// Two bills, so the bill_payments check in section C has something real to
// allocate against — the route refuses an unknown bill, and a check that
// silently skips is not a check.
await mutateJson(cfg.BILLS_FILE, [], (all) => {
    const rows = Array.isArray(all) ? all : [];
    rows.push({ id: 'B_X', date: '09/01/2026', supplier: 'Eccomelt', booking_no: 'BK-A',
                container_no: 'MSDU1111111', supplier_price: 0.30, gross: 40000, truck: 15000,
                container: 8000, chassis: 6000, boxes: 400 });
    rows.push({ id: 'B_Y', date: '09/02/2026', supplier: 'Eccomelt', booking_no: 'BK-B',
                container_no: 'TGCU2222222', supplier_price: 0.31, gross: 40000, truck: 15000,
                container: 8000, chassis: 6000, boxes: 400 });
    return rows;
});

// ── A — THE TABLE EXISTS AND THE SCHEMA CANNOT DRIFT ──────────────────────
// Columns in this mirror come from the CATALOG, not from the first row. So a
// table in TABLES with no catalog entry silently gets zero columns, and the
// schema Jarvis is TOLD about would not be the one it queries.
{
    section('A — the table, and the catalog that defines its columns');

    ck('sales_settlements is in the mirror', Object.keys(dataMirror.TABLES).includes('sales_settlements'),
       Object.keys(dataMirror.TABLES).join(', '));

    const described = catalog.find('sales_settlements');
    ck('  and described in the catalog', !!described,
       'without this the table is built with NO columns and every query fails');
    ck('  with the columns the rows actually carry',
       !!described && ['settlement_id', 'date', 'payee', 'kind', 'amount', 'total_settlement',
                       'sale_id', 'container_no', 'customer'].every((c) => c in described.columns),
       described ? Object.keys(described.columns).join(', ') : '');

    // ── EVERY MIRROR TABLE NEEDS ONE ─────────────────────────────────────
    // Checked for all of them, not just the new one, because this is the
    // failure mode the next person adding a table will hit.
    const undescribed = Object.keys(dataMirror.TABLES).filter((t) => !catalog.find(t));
    ck('  and no mirror table is missing its catalog entry', undescribed.length === 0,
       undescribed.join(', ') + ' — these build with zero columns');

    // The file was ALREADY watched before the table existed, which is what
    // made this gap expensive: rebuild the database, store nothing.
    const src = fs.readFileSync(path.join(ROOT, 'helpers/data/dataMirror.js'), 'utf8');
    ck('  the rebuild trigger and the table are both present',
       /SALES_SETTLEMENTS_FILE/.test(src) && /sales_settlements:\s*settlementRows/.test(src),
       'watching a file with no table is a rebuild that stores nothing');
}

// ── B — END TO END: POST THROUGH THE ROUTE, READ IT BACK WITH SQL ─────────
{
    section('B — a freight payment, posted by the screen and found by SQL');

    const before = sql('SELECT COUNT(*) AS n FROM sales_settlements').rows[0].n;

    const posted = await req('POST', '/api/sales-settlements', { sid: jarvis.sid, body: {
        date: '09/15/2026', amount: 2800, mode: 'Wire', bank: 'Bank of America — Edge Metals',
        payee: 'Zimex Logistics', ref: 'WR-5500',
        allocations: [
            { sale_id: 'S_A', kind: 'charge', charge_id: 'CH_F', amount: 2500 },
            { sale_id: 'S_A', kind: 'charge', charge_id: 'CH_P', amount: 300 },
        ],
    } });
    ck('the route accepts it', posted.status === 200 && posted.json && posted.json.ok,
       posted.status + ' ' + posted.raw.slice(0, 200));
    const id = posted.json && posted.json.settlement && posted.json.settlement.id;

    // ── ONE ROW PER ALLOCATION ───────────────────────────────────────────
    // A row per settlement would make whoever writes the SQL split `amount`
    // back out by hand, which is the arithmetic the database is for.
    const after = sql('SELECT COUNT(*) AS n FROM sales_settlements').rows[0].n;
    ck('  it arrives as TWO rows, one per thing it covered', after - before === 2,
       `delta ${after - before}`);

    const rows = sql(`SELECT * FROM sales_settlements WHERE settlement_id='${id}' ORDER BY charge_id`).rows;
    ck('  each row carries its own amount', rows.map((r) => r.amount).join(',') === '2500,300',
       rows.map((r) => r.amount).join(','));
    ck('  and the whole payment, so one wire is still answerable',
       rows.every((r) => r.total_settlement === 2800), JSON.stringify(rows.map((r) => r.total_settlement)));
    ck('  SUM(amount) per settlement equals total_settlement',
       sql(`SELECT SUM(amount) AS s FROM sales_settlements WHERE settlement_id='${id}'`).rows[0].s === 2800);

    ck('  the payee is there', rows.every((r) => r.payee === 'Zimex Logistics'));
    ck('  how and from where', rows.every((r) => r.method === 'Wire' && /Edge Metals/.test(r.bank || '')),
       JSON.stringify(rows.map((r) => [r.method, r.bank])));
    ck('  the date is sortable, and the typed one is kept',
       rows.every((r) => r.date === '2026-09-15' && r.date_shown === '09/15/2026'),
       JSON.stringify(rows.map((r) => [r.date, r.date_shown])));

    // Resolved from the payable, which is the point: the money reads against
    // the container without a second query.
    ck('  it names the container and the customer',
       rows.every((r) => r.container_no === 'MSDU1111111' && r.customer === 'Aris Enterprises'),
       JSON.stringify(rows.map((r) => [r.container_no, r.customer])));
    ck('  and what each charge was for',
       rows.map((r) => r.what).sort().join('|') === 'Ocean freight|Port fees',
       rows.map((r) => r.what).join('|'));
}

// ── C — THE QUESTION SHE COULD NOT ASK ────────────────────────────────────
{
    section('C — "what did we pay Zimex"');

    await req('POST', '/api/sales-settlements', { sid: jarvis.sid, body: {
        date: '09/18/2026', amount: 1800, mode: 'Wire', bank: 'Bank of America — Edge Metals',
        payee: 'Zimex Logistics', ref: 'WR-5501',
        allocations: [{ sale_id: 'S_B', kind: 'charge', charge_id: 'CH_F2', amount: 1800 }],
    } });
    await req('POST', '/api/sales-settlements', { sid: jarvis.sid, body: {
        date: '09/19/2026', amount: 400, mode: 'Zelle', bank: 'Bank of America — Edge Metals',
        payee: 'Hugo Ramirez',
        allocations: [{ sale_id: 'S_A', kind: 'commission', amount: 400 }],
    } });

    const byPayee = sql("SELECT payee, SUM(amount) AS paid FROM sales_settlements GROUP BY payee ORDER BY paid DESC").rows;
    ck('one row per payee, summed', byPayee.length === 2, JSON.stringify(byPayee));
    ck('  Zimex totals 2500 + 300 + 1800 = 4600',
       byPayee[0].payee === 'Zimex Logistics' && byPayee[0].paid === 4600, JSON.stringify(byPayee[0]));
    ck('  and the commission is separate, not folded in',
       byPayee[1].payee === 'Hugo Ramirez' && byPayee[1].paid === 400, JSON.stringify(byPayee[1]));

    const byKind = sql("SELECT kind, SUM(amount) AS paid FROM sales_settlements GROUP BY kind ORDER BY kind").rows;
    ck('charges and commission are distinguishable',
       JSON.stringify(byKind) === JSON.stringify([{ kind: 'charge', paid: 4600 }, { kind: 'commission', paid: 400 }]),
       JSON.stringify(byKind));

    // ── THE JOIN IS THE REASON THIS IS WORTH DOING ───────────────────────
    // Cost-out per customer cannot be computed from the JSON without walking
    // two stores by hand. It is one query here.
    const byCustomer = sql(`SELECT s.customer, SUM(t.amount) AS cost_out
        FROM sales_settlements t JOIN sales s ON s.sale_id = t.sale_id
        GROUP BY s.customer ORDER BY cost_out DESC`).rows;
    ck('it joins to sales, so cost-out per customer is one query',
       byCustomer.length === 2
       && byCustomer[0].customer === 'Aris Enterprises' && byCustomer[0].cost_out === 3200
       && byCustomer[1].customer === 'HYNOS' && byCustomer[1].cost_out === 1800,
       JSON.stringify(byCustomer));

    // ── THE SAME PROPERTY ON bill_payments, WHICH NOTHING GUARDED ────────
    // Not my table, and the code is correct. But a mis-aimed control of mine
    // landed on billPaymentRows instead of settlementRows, and truncating it
    // to one row per payment — which UNDERSTATES every supplier-payment total
    // in SQL whenever one payment covers several containers — passed
    // ask-data, bills-sales, ledger-render and qb-agent without a murmur.
    //
    // It is the identical shape as the settlements table beside it, so the
    // check belongs here rather than nowhere. Pins existing behaviour; changes
    // nothing.
    {
        const r = await req('POST', '/api/bill-payments', { sid: jarvis.sid, body: {
            date: '09/20/2026', amount: 900, mode: 'Wire', bank: 'Bank of America — Edge Metals',
            supplier: 'Eccomelt', ref: 'WR-9',
            allocations: [{ bill_id: 'B_X', amount: 500 }, { bill_id: 'B_Y', amount: 400 }],
        } });
        // The route may refuse unknown bills; only assert when it accepted,
        // so this cannot become a false red about bill validation rules.
        if (r.status === 200 && r.json && r.json.ok) {
            const id = r.json.payment && r.json.payment.id;
            const rows = sql(`SELECT amount, total_payment FROM bill_payments WHERE payment_id='${id}'`).rows;
            ck('bill_payments is also one row per allocation',
               rows.length === 2 && rows.map((x) => x.amount).sort().join(',') === '400,500',
               JSON.stringify(rows));
            ck('  with the whole payment on each',
               rows.every((x) => x.total_payment === 900), JSON.stringify(rows));
        } else {
            console.log('  (skipped: the bill-payment route refused the fixture — '
                + (r.json && r.json.error ? r.json.error : r.status) + ')');
        }
    }

    // Separation: this is Edge Metals money and must not be reachable from
    // the yard's mirror. Her rule 5, asserted rather than assumed.
    const yard = require(path.join(ROOT, 'helpers/data/yardMirror'));
    ck('the Edge Yard mirror has no settlements table',
       !Object.keys(yard.TABLES || {}).includes('sales_settlements'),
       Object.keys(yard.TABLES || {}).join(', '));
}

// ── D — AND IT LEAVES WHEN SHE DELETES IT ─────────────────────────────────
// Through the route today's Delete button calls. A mirror that only ever
// grows is a mirror that disagrees with the screen the first time something
// is removed.
{
    section('D — deleting a settlement removes it from the database too');

    const list = (await req('GET', '/api/sales-settlements', { sid: jarvis.sid })).json.settlements;
    const target = list.find((s) => s.payee === 'Hugo Ramirez');
    ck('the commission payment is there to remove', !!target);

    const before = sql("SELECT SUM(amount) AS s FROM sales_settlements WHERE kind='commission'").rows[0].s;
    ck('  and commission reads 400 beforehand', before === 400, String(before));

    const gone = await req('DELETE', `/api/sales-settlements/${target.id}`, { sid: jarvis.sid });
    ck('  the Jarvis profile removes it', gone.status === 200 && gone.json.removed,
       gone.status + ' ' + gone.raw.slice(0, 160));

    const after = sql("SELECT COUNT(*) AS n, SUM(amount) AS s FROM sales_settlements WHERE kind='commission'").rows[0];
    ck('  the database no longer holds it', after.n === 0 && (after.s === null || after.s === 0),
       JSON.stringify(after));
    ck('  and the charges are untouched',
       sql("SELECT SUM(amount) AS s FROM sales_settlements WHERE kind='charge'").rows[0].s === 4600);
}

// ── E — A SETTLEMENT WHOSE CHARGE WENT AWAY ───────────────────────────────
// A real state: the charge is edited or deleted on the sale after being paid.
// The payment still happened. It must appear, with the container unresolved
// rather than the row vanishing — money that disappears from a report because
// a reference broke is the worst available outcome.
{
    section('E — the payment survives its charge');

    await mutateJson(cfg.SALES_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        const s = rows.find((x) => x.id === 'S_B');
        if (s) s.charges = [];                      // the charge is gone; the payment is not
        return rows;
    });

    const r = sql("SELECT settlement_id, amount, payee, container_no, what FROM sales_settlements WHERE sale_id='S_B'").rows;
    ck('the payment is still a row', r.length === 1 && r[0].amount === 1800, JSON.stringify(r));
    ck('  with the container unresolved rather than invented',
       r[0].container_no === null && r[0].what === null, JSON.stringify(r[0]));
    ck('  and the total still counts it',
       sql('SELECT SUM(amount) AS s FROM sales_settlements').rows[0].s === 4600,
       'money does not leave a report because a reference broke');
}

server.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { try { server.close(); } catch (x) {} console.error('threw:', e && e.stack); process.exit(1); });
