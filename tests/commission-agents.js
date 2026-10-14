// ── tests/commission-agents.js ───────────────────────────────────────────
// Apsara, 2026-10-14: "WHy joey commission not built in jarvis?" — then,
// on how it should work: "We have already told about pan metal commission."
// and "Mimic that."
//
// It was not built because a sale has ONE commission field and NO PAYEE:
// helpers/sales.js:320 holds commission_per_mt and commission_amount and
// nothing to say whose they are. Her own mails routinely name two or three
// agents on one sale — proformaFromEmail.js quotes her example verbatim,
// "$2,520 CIF Busan (10c for Mr.Kim and 10c for Hynos included)" — so two
// of three commissions had nowhere to live and none had a name.
//
// Pan Metal was already the answer and nobody noticed: in the party-invoice
// REGISTER, amountOf() reads `commission` for panmetal where every other
// party uses an invoice total. An agent is a party whose line amount IS the
// commission. That gives her the register row, the filter, edit, delete,
// pay, one payment across several lines, and derived balances — all of it
// already built and already tested.
//
//   A  an agent is a party, and its amount is the commission
//   B  two agents on ONE container are two payable lines, not one
//   C  it still posts nothing to the books, so nothing double-counts
//   D  paying one agent, through the machinery that already exists
//   E  the blast radius: the mail sweep and sheet sync are NOT widened

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-comm-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

const PI = require(path.join(ROOT, 'helpers/partyInvoices'));

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — an agent is a party, and its amount is the commission');

{
    ck('Joey is a party', PI.PARTIES.joey === 'Joey', JSON.stringify(PI.PARTIES.joey));
    // JOEY ONLY. Her Verification tab reads "Under commission-Joey,Pan
    // metal" and has had a Joey sub-tab since it was built. Mr. Kim and
    // Hynos are in her mails but she has never asked for them as tabs, and
    // a name read out of an email is not a decision.
    ck('  and Mr. Kim and Hynos are NOT, because she never asked for them',
       !PI.PARTIES.mrkim && !PI.PARTIES.hynos,
       'a name from an email is not an instruction');
    // The screen builds its own filter from PARTIES (routes/money.js:403),
    // so being in here IS being on the register.
    ck('  which is what puts them on the register screen',
       Object.keys(PI.PARTIES).includes('joey'),
       'the party filter is built from this object, server-side');

    // THE PAN METAL RULE, now a list rather than a special case.
    ck('Pan Metal is still a commission party', PI.COMMISSION_PARTIES.has('panmetal'),
       'its behaviour must not change — it was the precedent');
    ck('  and Joey joins it', PI.COMMISSION_PARTIES.has('joey'));
    ck('  while a hauler is NOT one', !PI.COMMISSION_PARTIES.has('jio')
       && !PI.COMMISSION_PARTIES.has('zimex'), 'those bill her, they do not take commission');

    // amountOf: the field read is the difference between the two kinds.
    ck('an agent line reads `commission`', PI.amountOf('joey', { commission: 245.5, amount: 9999 }) === 245.5,
       String(PI.amountOf('joey', { commission: 245.5, amount: 9999 })));
    ck('  Pan Metal unchanged', PI.amountOf('panmetal', { commission: 100, amount: 9999 }) === 100);
    ck('  a freight party still reads its invoice total',
       PI.amountOf('zimex', { commission: 1, net_amount: 850 }) === 850,
       String(PI.amountOf('zimex', { commission: 1, net_amount: 850 })));
    // Falls back to `amount` when the export calls it that, exactly as Pan
    // Metal always has.
    ck('  and falls back to amount when there is no commission field',
       PI.amountOf('joey', { amount: 60 }) === 60);
}

// ══════════════════════════════════════════════════════════════════════════
section('B — two agents on ONE container are two payable lines');
// The thing a sale row cannot express. "10c for Mr.Kim and 10c for Hynos"
// on the same container must be two debts to two people.

{
    const mk = (party, extra = {}) => PI.normalize({ party, container_no: 'MSCU7654321',
        commission: 245.5, invoice_date: '2026-08-15', ...extra });

    // Her own Commission group: Joey and Pan Metal. Both take a commission
    // on the same container, which is the case a single sale field cannot
    // express at all.
    const joey = mk('joey'), pan = mk('panmetal');
    ck('each normalises to a row', !!(joey.row && pan.row),
       JSON.stringify([joey.skip, pan.skip]));
    ck('  keyed on the container, with no invoice number needed',
       joey.row.key === 'joey:(none):MSCU7654321', joey.row.key);
    // THE POINT. Three distinct keys for one container.
    const keys = [joey.row.key, pan.row.key];
    ck('two commission parties, one container, TWO distinct lines',
       new Set(keys).size === 2, JSON.stringify(keys));
    ck('  each carrying its own amount', joey.row.amount === 245.5 && pan.row.amount === 245.5);
    ck('  and each naming who it is for', joey.row.party === 'joey' && pan.row.party === 'panmetal');

    // An agent is not a trucker, so the per-load drayage cap must not apply
    // — a commission on a big container is legitimately four figures.
    const big = PI.normalize({ party: 'joey', container_no: 'TGHU1112223', commission: 4200 });
    ck('a four-figure commission is not rejected as "too big for a hauler"',
       !!big.row && big.row.amount === 4200, JSON.stringify(big.skip || big.row.amount));

    // Still refuses what it should: nothing to key on.
    const nokey = PI.normalize({ party: 'joey', commission: 100 });
    ck('  but a commission with no container and no invoice is refused',
       !!nokey.skip, JSON.stringify(nokey));
    const nomoney = PI.normalize({ party: 'joey', container_no: 'MSCU7654321' });
    ck('  and so is one with no amount', !!nomoney.skip, JSON.stringify(nomoney));
}

// ══════════════════════════════════════════════════════════════════════════
section('C — it posts nothing, so nothing double-counts');
// The risk I flagged when she chose a separate ledger: the sale's
// commission_amount ALREADY posts 5300/2100 in helpers/postings.js. If the
// register posted too, every commission would be counted twice.

{
    const src = fs.readFileSync(path.join(ROOT, 'helpers/partyInvoices.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const m of ['postings', 'booksBuild', 'bills', 'qbPush', 'quickbooks']) {
        ck(`the register does not reach for ${m}`, !new RegExp(`require\\(['"][^'"]*${m}`, 'i').test(code),
           'a register that posts would double-count the sale\'s own commission');
    }
    // And the sale side is untouched — the figure the books use still comes
    // from sales.js, exactly as before.
    const postings = fs.readFileSync(path.join(ROOT, 'helpers/postings.js'), 'utf8');
    ck('the books still post commission from the SALE', /tx\.commission/.test(postings),
       'this is the figure that must not change');
    ck('  and the books do not read the register', !/partyInvoices/.test(postings));
}

// ══════════════════════════════════════════════════════════════════════════
section('D — paying one agent, through machinery that already exists');

{
    const rows = ['joey', 'panmetal'].map((p) => PI.normalize({
        party: p, container_no: 'MSCU7654321', commission: 245.5 }).row);
    await PI.upsertMany(rows);
    const all = PI.list();
    ck('both are stored', all.length === 2, String(all.length));

    const joeyRow = all.find((r) => r.party === 'joey');
    // One payment against Joey's line only.
    const pay = await PI.addPayment({ party: 'joey', amount: 245.5, mode: 'Wire', paid_on: '2026-09-01',
        allocations: [{ row_id: joeyRow.id, amount: 245.5 }] }, 'test');
    ck('a payment to Joey is recorded', !!pay, JSON.stringify(pay && pay.id));

    const withPaid = PI.withPaid(PI.list());
    const joeyPaid = withPaid.find((r) => r.party === 'joey');
    const panPaid = withPaid.find((r) => r.party === 'panmetal');
    ck('  Joey\'s line reads paid', Number(joeyPaid.paid) === 245.5, JSON.stringify(joeyPaid.paid));
    ck('  with nothing outstanding', Number(joeyPaid.balance) === 0, JSON.stringify(joeyPaid.balance));
    // THE WHOLE POINT OF NAMING THEM: paying one does not pay the others.
    ck('  and Pan Metal is still owed theirs', Number(panPaid.paid || 0) === 0 && Number(panPaid.balance) === 245.5,
       JSON.stringify([panPaid.paid, panPaid.balance]));

    // The register's own rules still hold for an agent. validatePayment
    // THROWS rather than returning an error object — this store fails loudly
    // by design, so the test has to catch rather than inspect.
    const refuses = (input) => {
        try { PI.validatePayment(input); return null; } catch (e) { return e.message; }
    };
    const over = refuses({ party: 'joey', amount: 500, mode: 'Wire', paid_on: '2026-09-02',
        allocations: [{ row_id: joeyRow.id, amount: 500 }] });
    ck('a line cannot be paid more than it is owed', !!over, 'it accepted an overpayment');
    // ── "ONE PAYMENT GOES TO ONE PARTY", CHECKED PROPERLY ───────────────
    // My first version asserted that stating party:'joey' while allocating
    // to a Hynos line is refused. It is not, and the code is RIGHT: the
    // party is DERIVED from the allocated lines and the stated one is
    // ignored, which makes a mismatch impossible rather than illegal. The
    // invariant to check is the one that can actually be violated — two
    // lines, two owners, one payment.
    const panRow = withPaid.find((r) => r.party === 'panmetal');
    // BOTH LINES UNPAID, or the overpay check fires first and the test
    // passes for the wrong reason — which it did on the first attempt:
    // Joey's line was settled above, so the refusal read "owes only 0.00".
    // A refusal is not evidence unless it is the refusal you meant.
    await PI.upsertMany([PI.normalize({ party: 'joey', container_no: 'TGHU9990001',
        commission: 300 }).row]);
    const joey2 = PI.withPaid(PI.list()).find((r) => r.party === 'joey' && r.container_no === 'TGHU9990001');
    const spans = refuses({ party: 'joey', amount: 545.5, mode: 'Wire', paid_on: '2026-09-02',
        allocations: [{ row_id: joey2.id, amount: 300 }, { row_id: panRow.id, amount: 245.5 }] });
    ck('  one payment cannot settle two different parties', !!spans, 'two parties, one payment');
    ck('    saying so plainly, and not for some other reason',
       /different parties/.test(spans || ''), spans);
    // And the derived party is what gets stored, so a mistyped party on the
    // way in cannot file Hynos's money under Joey.
    const derived = PI.validatePayment({ party: 'joey', amount: 245.5, mode: 'Wire', paid_on: '2026-09-02',
        allocations: [{ row_id: panRow.id, amount: 245.5 }] });
    ck('  and the party is taken from the LINE, not from what was typed',
       derived.party === 'panmetal', derived.party);
    // And a good one is still accepted, or the two checks above would pass
    // on a function that refuses everything.
    ck('  while a correct payment to Pan Metal is accepted',
       refuses({ party: 'panmetal', amount: 245.5, mode: 'Wire', paid_on: '2026-09-02',
           allocations: [{ row_id: panRow.id, amount: 245.5 }] }) === null,
       'refusing everything would make the two checks above meaningless');
}

// ══════════════════════════════════════════════════════════════════════════
section('E — the blast radius: nothing else was widened');
// PARTIES has five other readers. Adding an agent must not make the mail
// sweep chase Joey for invoices he never sends, or the sheet sync look for
// a tab that does not exist.

{
    const nightly = fs.readFileSync(path.join(ROOT, 'helpers/partyInvoiceNightly.js'), 'utf8');
    ck('the mail sweep has its OWN party list', /SWEEP_PARTIES = \[/.test(nightly));
    ck('  and Joey is not on it', !/SWEEP_PARTIES = \[[^\]]*joey/i.test(nightly),
       'the sweep would look for invoices an agent never sends');
    // The nightly summary iterates PARTIES but skips a party with no lines,
    // so an agent cannot add an empty "Joey — 0 lines" line to her mail.
    ck('  and the summary skips a party with nothing', /if \(!r\.length\) continue;/.test(nightly));

    const sheet = fs.readFileSync(path.join(ROOT, 'helpers/partyInvoiceSheetSync.js'), 'utf8');
    ck('the sheet sync has its own tab list', /party: 'panmetal', tab:/.test(sheet));
    ck('  with no agent tab', !/party: 'joey'/.test(sheet),
       'it would look for a sheet tab that does not exist');
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log('  - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('ABORT', e); process.exit(1); });
