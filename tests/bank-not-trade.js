// ── tests/bank-not-trade.js ───────────────────────────────────────────────
// #167: "Port payeeGuard, notTrade and lumpSum to the Plaid matcher."
//
// Only ONE of the three was ported, and the other two are written down here as
// findings rather than left as a half-done item somebody finishes blindly.
//
// ── payeeGuard CANNOT FIRE IN helpers/bankMatch.js ───────────────────────
// On the CSV path it downgrades a match when the bank names one party and the
// records name another. In the Plaid matcher that disagreement is structurally
// impossible: the party comes from resolving the descriptor, and candidates are
// filtered `d.party !== party`, so a document can only be a candidate if its
// party already IS the bank's. Porting it would add a check that can never go
// red — which is worse than no check, because it advertises protection that is
// never exercised. Section C pins the structural guarantee instead, so if that
// filter is ever loosened this file says so.
//
// ── lumpSum IS AN OUTFLOW FEATURE AND THERE IS NO OUTFLOW PATH ───────────
// It proposes which open bills a $60,000 supplier wire would clear, oldest
// first. bankInflows() keeps only money IN, so the Plaid matcher has no
// outbound direction at all. That is a feature, not a port, and pretending
// otherwise would have shipped a function nothing calls. Section D pins the
// absence so the day outflows arrive, this is the reminder.
//
// ── notTrade WAS A REAL GAP, AND WORSE THAN MISSING ──────────────────────
// Every non-trade line fell through to `no_party`, whose message is "name it
// once and every future deposit from them matches itself". For a bank charge
// that is an invitation to alias a fee to a customer. Sections A and B.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const { notTrade } = require(path.join(ROOT, 'helpers/notTrade'));

(async () => {

// ── A — THE EXTRACTION CHANGED NOTHING ────────────────────────────────────
// helpers/partyName.js set the precedent on 2026-10-05: lifted verbatim, and
// the extraction "is required to change nothing". The ORACLE below is the
// original implementation from scripts/qb-bank-match.js, inlined, so this
// keeps proving equivalence even after that file stops containing it.
{
    section('A — same verdicts as the CSV path it was lifted from');

    const C = /(bank charge|loan|tax|office|travel|phone|insurance|payroll|meals|fuel|rent|utilit|interest|owner|equit)/i;
    const D = /(transfer fee|analysis fee|service charge|verizon|arco|internal revenue|ondeck|acura|payroll|interest)/i;
    const oracle = (line) => {
        if (C.test(line.category || '')) return `already categorized as ${line.category}`;
        if (D.test(line.desc || '')) return 'not a supplier or customer payment';
        return null;
    };

    const cats = ['', 'Bank Charges', 'Loans', 'Taxes & Licenses', 'Office Expenses', 'Travel',
        'Telephone', 'Insurance', 'Payroll Expenses', 'Meals and Entertainment Expense For Clients',
        'Fuel', 'Rent or Lease of Buildings', 'Utilities', 'Interest Paid', 'Owner Draw', 'Equity',
        'Cost of Goods Sold', 'Uncategorized Asset', 'Accounts Receivable', null, undefined];
    const descs = ['', 'TRANSFER FEE', 'ANALYSIS FEE 00042', 'SERVICE CHARGE', 'VERIZON WIRELESS PMT',
        'ARCO #4412', 'INTERNAL REVENUE SERVICE', 'ONDECK CAPITAL', 'ACURA FINANCIAL', 'PAYROLL ADP',
        'INTEREST EARNED', 'WIRE IN INESH CORES', 'ZELLE FROM DRM METALS', 'CHECK 1042',
        '5 CORE TRADING INC', null, undefined];

    let compared = 0;
    const diffs = [];
    for (const category of cats) {
        for (const desc of descs) {
            const line = { category, desc };
            compared += 1;
            if (String(oracle(line)) !== String(notTrade(line))) {
                diffs.push(`${JSON.stringify(line)}: was ${oracle(line)}, now ${notTrade(line)}`);
            }
        }
    }
    ck(`${compared} line shapes give identical verdicts`, diffs.length === 0, diffs.slice(0, 4).join(' | '));

    // The reason text matters as much as the verdict: it is what the screen
    // shows her. A first version truncated the category to four words, so a
    // five-word QuickBooks category came back with a different sentence than
    // the CSV path produced — a silent wording change inside an extraction
    // that promised to change nothing.
    ck('a long category is quoted in full, not truncated',
       notTrade({ category: 'Meals and Entertainment Expense For Clients' })
         === 'already categorized as Meals and Entertainment Expense For Clients',
       notTrade({ category: 'Meals and Entertainment Expense For Clients' }));

    ck('the CSV script now uses the helper rather than its own copy',
       /require\(['"]\.\.\/helpers\/notTrade['"]\)/
           .test(fs.readFileSync(path.join(ROOT, 'scripts/qb-bank-match.js'), 'utf8')),
       'two copies of this list is the drift the extraction exists to prevent');
}

// ── B — WHAT IT MUST AND MUST NOT SET ASIDE ───────────────────────────────
{
    section('B — a bank charge is set aside, a customer wire is not');

    for (const [line, why] of [
        [{ desc: 'TRANSFER FEE' }, 'a bank fee'],
        [{ desc: 'VERIZON WIRELESS AUTOPAY' }, 'the phone bill'],
        [{ desc: 'INTERNAL REVENUE SERVICE USATAXPYMT' }, 'the IRS'],
        [{ category: 'Bank Charges' }, 'already categorised'],
        [{ merchant_name: 'ONDECK CAPITAL' }, 'a Plaid merchant_name'],
        [{ name: 'ACURA FINANCIAL SERVICES' }, 'a Plaid name'],
        [{ personal_finance_category: { primary: 'LOAN_PAYMENTS', detailed: 'LOAN_PAYMENTS_CAR' } },
         'a Plaid finance category'],
        [{ category: ['TRANSFER', 'Payroll'] }, 'a Plaid legacy category ARRAY'],
    ]) {
        ck(`set aside: ${why}`, !!notTrade(line), JSON.stringify(line));
    }

    // ── THE EXPENSIVE DIRECTION ──────────────────────────────────────────
    // A set-aside line is one nobody looks at again. Setting aside a real
    // customer payment loses it silently, which is worse than asking her to
    // name one extra descriptor.
    for (const [line, why] of [
        [{ desc: 'WIRE IN INESH CORES CHAPIN' }, 'a supplier wire'],
        [{ desc: 'ZELLE FROM DRM METALS LLC' }, 'a customer Zelle'],
        [{ desc: '5 CORE TRADING INC' }, 'a customer with generic words in its name'],
        [{ desc: 'CHECK 1042' }, 'a cheque with no name at all'],
        [{ descriptor: 'CUSTOM ALLOYS LLC PAYMENT' }, 'the Plaid descriptor field'],
        [{ category: 'Accounts Receivable', desc: 'WIRE IN' }, 'a receivable category'],
        [{ category: 'Cost of Goods Sold', desc: 'ACH DEBIT' }, 'cost of goods'],
        [{}, 'an empty row'],
        [null, 'a null row'],
        ['not an object', 'a string where a row should be'],
    ]) {
        ck(`NOT set aside: ${why}`, !notTrade(line), JSON.stringify(line));
    }

    ck('the reason names the rule, so the screen can say why',
       notTrade({ desc: 'TRANSFER FEE' }) === 'not a supplier or customer payment'
       && /^already categorized as /.test(notTrade({ category: 'Loans' })),
       `${notTrade({ desc: 'TRANSFER FEE' })} / ${notTrade({ category: 'Loans' })}`);
}

// ── C — THE ENGINE STAYS PURE, AND payeeGuard STAYS OUT ───────────────────
{
    section('C — where the filter lives, and why');

    const eng = fs.readFileSync(path.join(ROOT, 'helpers/bankMatch.js'), 'utf8');
    const code = eng.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

    // tests/bank-match.js section I already asserts this. Repeated here with
    // the REASON, because this is the file that tried to break it: the filter
    // went into the engine first and that test went red, correctly.
    ck('helpers/bankMatch.js still requires nothing',
       !/\brequire\s*\(/.test(code),
       (code.match(/require\s*\([^)]*\)/g) || []).join(' ')
       + ' — the not-trade filter belongs in the route, which already does I/O');
    ck('  and the route is where the filter runs',
       /require\(['"]\.\/notTrade['"]\)/
           .test(fs.readFileSync(path.join(ROOT, 'helpers/bankMatchRoutes.js'), 'utf8')));

    // ── payeeGuard's job, done structurally ──────────────────────────────
    // A document can only be a candidate if its party IS the resolved party.
    // That is why payeeGuard was not ported. If this filter is ever loosened,
    // the guard becomes necessary and this check is the warning.
    ck('a document is only a candidate when its party matches the bank\'s',
       /d\.party\s*!==\s*party/.test(eng),
       'payeeGuard was deliberately NOT ported because this makes the '
       + 'bank-says-X/record-says-Y case impossible. Loosen this and it is needed.');

    const m = require(path.join(ROOT, 'helpers/bankMatch'));
    const doc = (id, party, amount) => ({ id, party, date: '2026-03-01', amount, applied: 0,
        label: id });
    const docs = [doc('I1', 'Custom Alloys', 1000), doc('I2', 'Other Buyer', 1000)];
    const r = m.matchDeposit({ id: 'd1', date: '2026-03-02', amount: 1000, descriptor: 'X' },
        docs, { resolveParty: () => 'Custom Alloys' });
    ck('  so another party\'s identical invoice is never proposed',
       r.proposals.every((p) => p.allocations.every((a) => a.doc_id !== 'I2')),
       JSON.stringify(r.proposals.map((p) => p.allocations.map((a) => a.doc_id))));
}

// ── D — lumpSum: THE ABSENCE, WRITTEN DOWN ────────────────────────────────
{
    section('D — there is no outflow path yet, and that is why lumpSum is not here');

    const m = require(path.join(ROOT, 'helpers/bankMatch'));
    // Plaid's sign convention: money IN is negative. bankInflows keeps those
    // and drops the rest, so a supplier payment never reaches the matcher.
    const feed = [
        { transaction_id: 'in1', date: '2026-03-02', amount: -5000, name: 'WIRE IN CUSTOM ALLOYS' },
        { transaction_id: 'out1', date: '2026-03-03', amount: 60000, name: 'WIRE OUT INESH CORES' },
    ];
    const got = m.bankInflows(feed);
    ck('only money IN reaches the matcher', got.length === 1 && got[0].id === 'in1',
       JSON.stringify(got.map((g) => g.id)));
    ck('  so a $60,000 supplier wire is not matched at all — by design, for now',
       !got.some((g) => g.id === 'out1'),
       'lumpSum proposes which open BILLS an outbound wire clears. Until there '
       + 'is an outflow path there is nothing for it to run on, so it was not '
       + 'ported. When outflows arrive, port it then.');

    ck('and the CSV path still has lumpSum for the direction it does handle',
       typeof require(path.join(ROOT, 'scripts/qb-bank-match')).lumpSum === 'function');
}

// ── E — THROUGH THE REAL ROUTE, WHICH IS WHERE #167 ACTUALLY LIVES ────────
// Sections A–D test the helper and the engine. Two mutations on the ROUTE
// SURVIVED all of them — emptying the set-aside id list, and dropping the
// reported rows — because nothing here exercised the partition, which is the
// entire feature. The helper being right is worthless if the route does not
// use it, and that is the gap CLAUDE.md names.
{
    section('E — /api/bank/match sets them aside and says so');

    const os = require('os');
    const http = require('http');

    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-nt-'));
    process.env.DATA_DIR = TMP;
    process.env.JARVIS_TEST = '1';
    process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaaa';
    process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
    process.env.JARVIS_PASSWORD = 'jarvis-pw-ddddddddddd';
    for (const k of Object.keys(require.cache)) if (k.startsWith(ROOT)) delete require.cache[k];
    const cfg = require(path.join(ROOT, 'config'));
    if (!String(cfg.DATA_DIR).startsWith(TMP)) {
        console.error('  ABORT  config is not isolated');
        process.exit(1);
    }

    // One real customer invoice to match against...
    fs.writeFileSync(cfg.SALES_FILE, JSON.stringify([{
        id: 'S1', customer: 'Custom Alloys', date: '2026-03-01', container_no: 'C1',
        item: 'Cu', weight: 10000, weight_unit: 'lb', invoice_price: 2, price_unit: 'lb',
    }], null, 2));

    // ...and a feed holding a genuine deposit beside three lines that are not
    // trade at all. `company` is set on every row: an unmapped account is
    // filtered out earlier by rule 5, which would hide this entirely.
    const row = (id, desc, amount, party) => ({
        id, date: '2026-03-05', desc, party: party || '', category: '',
        spent: 0, received: amount, amount, direction: 'in',
        // 'Edge Metals INC' — the LEGAL name, which is what
        // bankMatchRoutes.js's METALS constant holds. A first version used the
        // id 'edge-metals' and rule 5's company filter dropped EVERY row, so
        // the three "not in the queue" checks passed against an empty queue.
        // That is why the positive case is asserted beside them.
        account_id: 'acct1', company: 'Edge Metals INC', bank: 'BofA',
        pending: false, excluded: false, excluded_reason: null,
    });
    fs.writeFileSync(cfg.BANK_TX_FILE, JSON.stringify([
        row('good', 'ZELLE FROM CUSTOM ALLOYS', 20000, 'Custom Alloys'),
        row('fee', 'ANALYSIS FEE 00042', 35),
        row('phone', 'VERIZON WIRELESS AUTOPAY REFUND', 120),
        row('irs', 'INTERNAL REVENUE SERVICE REFUND', 900),
    ], null, 2));

    const { createApi } = require(path.join(ROOT, 'api'));
    const app = createApi();
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, body) => new Promise((resolve, reject) => {
        const d = JSON.stringify(body);
        const r = http.request(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
            (x) => { let o = ''; x.on('data', (c) => { o += c; }); x.on('end', () => { let j = null; try { j = JSON.parse(o); } catch (e) {} resolve(j); }); });
        r.on('error', reject); r.write(d); r.end();
    });
    const get = (p, sid) => new Promise((resolve, reject) => {
        const r = http.request(base + p, { headers: { Authorization: `Bearer ${sid}` } },
            (x) => { let o = ''; x.on('data', (c) => { o += c; }); x.on('end', () => { let j = null; try { j = JSON.parse(o); } catch (e) {} resolve({ code: x.statusCode, json: j }); }); });
        r.on('error', reject); r.end();
    });

    const lg = await post('/login', { password: process.env.JARVIS_PASSWORD });
    const sid = (lg && (lg.sid || lg.session_id)) || null;
    const r = await get('/api/bank/match', sid);
    ck('the review route answers', r.code === 200, `${r.code} ${JSON.stringify(r.json && r.json.error)}`);

    const d = r.json || {};
    const ids = (d.rows || []).map((x) => x.deposit && x.deposit.id);
    const aside = (d.not_trade || []).map((x) => x.id);

    ck('the three non-trade lines are NOT in the review queue',
       !ids.includes('fee') && !ids.includes('phone') && !ids.includes('irs'),
       `queue holds: ${ids.join(', ')}`);
    ck('  and the real deposit still is', ids.includes('good'), `queue holds: ${ids.join(', ')}`);
    ck('  so she is never asked to NAME a bank fee as a customer',
       !(d.rows || []).some((x) => x.outcome === 'no_party'
           && /ANALYSIS FEE|VERIZON|INTERNAL REVENUE/i.test(String(x.deposit.descriptor || x.deposit.desc || ''))),
       JSON.stringify((d.rows || []).filter((x) => x.outcome === 'no_party')
           .map((x) => x.deposit.descriptor)));

    ck('the set-aside rows are REPORTED, not silently dropped',
       aside.length === 3 && ['fee', 'phone', 'irs'].every((i) => aside.includes(i)),
       `not_trade: ${aside.join(', ')}`);
    ck('  each with the rule that set it aside',
       (d.not_trade || []).every((x) => typeof x.why === 'string' && x.why.length > 8),
       JSON.stringify(d.not_trade));
    ck('  and its amount, so the money is still accounted for',
       (d.not_trade || []).reduce((t, x) => t + Number(x.amount || 0), 0) === 1055,
       JSON.stringify((d.not_trade || []).map((x) => x.amount)));

    server.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
