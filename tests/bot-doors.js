// ── tests/bot-doors.js ────────────────────────────────────────────────────
// Apsara, 2026-11-05: "what about our own bot", then "give door access".
//
// The bot had eighteen tools — loads, inventory, sales, expenses, petty
// cash, trucker bills — and NONE of them touched the bank or claims. So the
// QuickBooks Ask box could answer about Intuit's data while her own bot
// could not say who a deposit was from or which claims were open. That is
// backwards, and it is the whole argument for Jarvis over QuickBooks.
//
// Four read tools. The writes stay on the screens: confirming a receipt
// asks about fees, discounts and the payment mode, and CLAUDE.md records
// the voice path breaking twice because it is the caller with no form to
// put a field on. Section D is what holds that line.
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.JARVIS_TEST = '1';
const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-doors-'));
const cfg = require(path.join(ROOT, 'config'));
cfg.DATA_DIR = dir;
cfg.CLAIMS_FILE = path.join(dir, 'claims.json');
cfg.CLAIM_KINDS_FILE = path.join(dir, 'claim_kinds.json');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const claims = require(path.join(ROOT, 'helpers/claims'));
const tools = require(path.join(ROOT, 'helpers/tools'));
const T = tools.TOOLS;
const rowsOf = (r) => r.rows || r.data || r.items || [];

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the doors exist at all');
// ══════════════════════════════════════════════════════════════════════════
{
    const names = tools.TOOL_NAMES || Object.keys(T);
    for (const n of ['bank_unmatched', 'bank_who_is', 'find_claims', 'claim_detail']) {
        ck(`${n} is a tool the bot can reach`, names.includes(n), names.join(' '));
    }
    // The gap this file exists to close: before today, both of these were
    // empty lists.
    ck('the bot can now see the bank', names.some((n) => /^bank_/.test(n)));
    ck('  and claims', names.some((n) => /claim/.test(n)));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — claims, the way she asks about them');
// ══════════════════════════════════════════════════════════════════════════
{
    await claims.create({ supplier: 'Taewon', container_no: 'HMMU6180208', invoice_no: 'X1',
        weight_unit: 'LB', claim_date: '2026-09-01', status: 'recovery_raised' }, 't');
    await claims.create({ supplier: 'Taewon', container_no: 'KOCU5251324', invoice_no: 'X2',
        weight_unit: 'LB', claim_date: '2026-10-20', status: 'settled' }, 't');
    await claims.create({ supplier: 'Nur Metal', container_no: 'TEMU7944250', invoice_no: 'X3',
        weight_unit: 'LB', claim_date: '2026-10-25', status: 'unverified' }, 't');

    const open = await T.find_claims.run({ status: 'open' });
    ck('"which claims are open" leaves the settled one out', open.claims === 2, String(open.claims));

    const settled = await T.find_claims.run({ status: 'settled' });
    ck('"which are settled" is its own answer', settled.claims === 1, String(settled.claims));

    const bySup = await T.find_claims.run({ supplier: 'taewon' });
    ck('"what about Taewon" matches however she types it', bySup.claims === 2, String(bySup.claims));

    // ── AGE IS THE ESCALATION ────────────────────────────────────────────
    // Her own rule, recorded when she refused a deadline field: "age itself
    // is the escalation". A claim nobody has chased is the answer to most
    // questions about claims, so it is on every row and it sorts the list.
    const first = rowsOf(open)[0];
    ck('every open claim says how long it has been sitting',
       first && typeof first.days_open === 'number' && first.days_open > 0,
       JSON.stringify(first));
    ck('  and the oldest is first, because that is the one that is costing her',
       rowsOf(open).every((r, i, a) => i === 0 || (a[i - 1].days_open || 0) >= (r.days_open || 0)),
       JSON.stringify(rowsOf(open).map((r) => r.days_open)));
    ck('a settled claim has no days_open — it is not open',
       rowsOf(settled).every((r) => r.days_open === null), JSON.stringify(rowsOf(settled)));

    const one = await T.claim_detail.run({ container: 'TEMU7944250' });
    ck('one container answers with its supplier and what is waiting',
       one.found && one.suppliers.includes('Nur Metal') && one.waiting_on_you === 1,
       JSON.stringify({ s: one.suppliers, w: one.waiting_on_you }));
    const miss = await T.claim_detail.run({ container: 'NOSUCH0000000' });
    ck('  and a container with no claims says so rather than inventing one',
       miss.found === false, JSON.stringify(miss));
}

// ══════════════════════════════════════════════════════════════════════════
section('C — the bank, including the line she showed me');
// ══════════════════════════════════════════════════════════════════════════
{
    const HERS = 'ARIS ENTERPRISES DES:ACH Pmt ID:XXXXX620487 INDN:Edge Metal Inc. '
        + 'CO ID:XXXXX02235 CCD PMT INFO:Balance payment for Inv 261009_AP_26ARIS 03';
    const who = await T.bank_who_is.run({ descriptor: HERS });
    ck('the bot reads the company off the bank line', who.read_as === 'ARIS ENTERPRISES', JSON.stringify(who));
    ck('  and says plainly when it still needs her', who.needs_you === true, JSON.stringify(who));
    // Never a single guess dressed as an answer — nameMatch.js refuses
    // near-misses because a wrong one pays the wrong company.
    // WAS `matched === null || typeof matched === 'string'`, which is true
    // whatever the code does — it could not go red, and a mutation that
    // promoted a suggestion to a match SURVIVED it. The property is exact:
    // if it still needs her, it has NOT matched anyone.
    ck('  a line it needs her for has matched nobody',
       who.needs_you === true && who.matched === null, JSON.stringify(who));

    const fee = await T.bank_who_is.run({ descriptor: 'SERVICE CHARGE' });
    ck('a bank fee is not read as a company', fee.read_as === null, JSON.stringify(fee));

    // bank_unmatched must survive an empty or absent ledger — the bot is
    // asked this on a phone, and a throw there is a dead assistant.
    const un = await T.bank_unmatched.run({});
    ck('"what is unexplained in the bank" answers even with nothing there',
       typeof un.unexplained_rows === 'number' && typeof un.unexplained_total === 'number',
       JSON.stringify(un).slice(0, 120));
}

// ══════════════════════════════════════════════════════════════════════════
section('D — the line that must not move');
// ══════════════════════════════════════════════════════════════════════════
{
    for (const n of ['bank_unmatched', 'bank_who_is', 'find_claims', 'claim_detail']) {
        ck(`${n} is READ, never write`, T[n].kind === 'read', T[n].kind);
        ck(`  and has no buildWrite`, typeof T[n].build !== 'function');
    }
    // Confirming a receipt asks about fees, discounts and the payment mode.
    // A spoken "mark it received" would skip all three, and CLAUDE.md
    // records the voice path breaking twice for exactly that shape.
    const src = fs.readFileSync(path.join(ROOT, 'helpers/tools.js'), 'utf8');
    const mine = src.slice(src.indexOf('bank_unmatched:'), src.indexOf('// ══ WRITE'));
    ck('none of the four writes to a store',
       !/mutateJson|learnAlias|setStatus|raiseRecovery|setMatched|markMatched/.test(mine),
       'the writes stay on the screens that ask about fees and mode');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.log('CRASHED: ' + (e && e.stack || e)); process.exit(1); });
