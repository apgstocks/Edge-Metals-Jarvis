// ── tests/yard-payment-modes.js ───────────────────────────────────────────
// Apsara, 2026-09-16, correcting an earlier message of hers that I had read as
// Edge Metals: "whn i talked about receive payment-i was talking only about
// edge yard ..in loads,there are two options na..create invoice and sale..in
// receive payment-i should have only cash and bank transfer".
//
// EDGE YARD ONLY. The two options she names are the Loads tab's "+ Create
// invoice" and "+ Sale" — load kinds 'purchase' and 'sale'.
//
// ── THE THREE WAYS THIS COULD BE GOT WRONG ──────────────────────────────────
//
//   TOO LITTLE. Change the dropdown and nothing else. The screen shows two, the
//   yard assistant goes on filing Zelles, and "I should have only cash and bank
//   transfer" is answered with a suggestion rather than a rule. Section B.
//
//   TOO MUCH, sideways. Narrow PAYMENT_MODES itself and Edge Metals loses
//   Zelle, Wire and Cheque with it — a company she did not mention, in an app
//   arranged around keeping the two apart. Section C.
//
//   TOO MUCH, backwards. Drop the old modes from the file entirely and every
//   yard payment already recorded as Zelle names a mode the server no longer
//   knows, with the bank matcher left nothing to key on. Section D.
//
//   TOO MUCH, AND IT SHIPPED. 2026-09-17: this file's own rule caught
//   'purchase' as well as 'sale', reading "yard" where she wrote "receive
//   payment". RECEIVE PAYMENT IS A SALE. Paying a SUPPLIER is money going the
//   other way and she does it by Zelle and Wire — the bank picker exists for
//   those two modes. So for a day, a supplier payment by Zelle was refused
//   outright, and the modal opened by selecting 'Zelle' on a list that no
//   longer had it: a <select> set to a missing value goes to "", so an
//   untouched dropdown posted an empty mode and the save failed.
//
//   Four checks in THIS FILE asserted that over-reach. tests/jarvis-profile.js
//   had been crashing on it since the day it landed, and nothing said so
//   because the full runner was not being used. Section E now holds the line
//   from the other side.
//
// So the assertions are as much about what did NOT change as what did.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-yardmodes-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

const pay = require(path.join(ROOT, 'helpers/payments'));
const petty = require(path.join(ROOT, 'helpers/pettyCash'));
const banks = require(path.join(ROOT, 'helpers/banks'));

const DASH = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');

// The <select id="pay_mode"> block, comments stripped. Comments are removed
// before scanning because this project has twice had an assertion satisfied by
// the comment explaining the rule rather than by the markup obeying it.
function payModeOptions(src) {
    const clean = src.replace(/<!--[\s\S]*?-->/g, '');
    const i = clean.indexOf('<select id="pay_mode">');
    if (i < 0) return null;
    const block = clean.slice(i, clean.indexOf('</select>', i));
    return [...block.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
}

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the yard pay modal offers exactly two');
// ══════════════════════════════════════════════════════════════════════════
{
    // ── BUILT PER ROW, NOT HARDCODED ─────────────────────────────────────
    // The markup used to carry two <option> tags and this section read them.
    // That is what made the over-reach invisible: the same modal is "Receive
    // payment" on a sale and "Record payment" on a purchase, and a fixed list
    // cannot be right for both. openPayModal fills it now, so the check is on
    // the CODE THAT FILLS IT.
    for (const [who, src] of [['website', DASH], ['app', APP]]) {
        const opts = payModeOptions(src);
        ck(`${who}: the markup carries no fixed list`,
           !opts || opts.length === 0, JSON.stringify(opts));

        const fill = (src.match(/const payModes = sale \? \[([^\]]*)\] : \[([^\]]*)\]/) || []);
        ck(`  ${who}: a sale offers exactly two`,
           /'Cash', 'Bank transfer'/.test(fill[1] || ''), fill[1]);
        ck(`  ${who}: and no Zelle on a sale`, !/Zelle/.test(fill[1] || ''), fill[1]);
        ck(`  ${who}: a purchase keeps the full list`,
           /Zelle/.test(fill[2] || '') && /Wire/.test(fill[2] || '') && /Cheque/.test(fill[2] || ''),
           fill[2] + ' — paying a supplier is money going the other way');

        // THE BUG THAT MADE IT WORSE: the modal selected 'Zelle' as its
        // default. On a list without it a <select> goes to "", so a dropdown
        // she never touched posted no mode at all and the save was refused.
        ck(`  ${who}: the default is a mode the list actually has`,
           /payModes\.includes\('Zelle'\) \? 'Zelle' : 'Cash'/.test(src),
           "a <select> set to a value it does not have silently becomes ''");
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('B — and the SERVER holds the rule, not just the dropdown');
// ══════════════════════════════════════════════════════════════════════════
{
    // "The screen offers two" and "the yard records two" are different
    // promises. She asked for the second: a dropdown is a suggestion, and the
    // yard assistant records payments without going near one.
    await petty.addTopUp({ amount: 10000, date: '2026-09-15', note: 'float' });

    // A SALE — receive payment, money in. Her rule.
    for (const mode of ['Zelle', 'Wire', 'Cheque']) {
        let err = null;
        try { await pay.addPayment({ load_id: `L_sale_${mode}`, load_kind: 'sale', mode, amount: 10, paid_on: '2026-09-16', bank: 'Chase Bank' }); }
        catch (e) { err = e; }
        ck(`receive payment cannot be ${mode}`, !!err, 'recorded anyway');
    }

    // ── AND A PURCHASE MUST STILL TAKE ALL FIVE ──────────────────────────
    // This is the line that was crossed. Paying a supplier is not receiving
    // payment, and she pays those by Zelle and Wire — there is a whole
    // bank-account picker for exactly those two modes.
    for (const mode of ['Zelle', 'Wire', 'Cheque', 'Cash', 'Bank transfer']) {
        let err = null; let rec = null;
        // A bank only where a bank makes sense — Cash and Cheque are refused
        // one, correctly, and my first version of this check sent one anyway
        // and then read the refusal as the restriction still being in place.
        const extra = (mode === 'Zelle' || mode === 'Wire') ? { bank: 'Chase Bank' } : {};
        try { rec = await pay.addPayment({ load_id: `L_buy_${mode}`, load_kind: 'purchase', mode, amount: 10, paid_on: '2026-09-16', ...extra }); }
        catch (e) { err = e; }
        ck(`  paying a supplier by ${mode} still records`, !err && rec && rec.mode === mode,
           err ? err.message : JSON.stringify(rec && rec.mode));
    }

    // The message must name the list THAT APPLIES. Being refused a Zelle and
    // then told "must be one of: Cash, Bank transfer, Zelle, Wire, Cheque"
    // reads as a bug in the software rather than an answer.
    let msg = '';
    try { await pay.addPayment({ load_id: 'L_MSG', load_kind: 'sale', mode: 'Zelle', amount: 10, paid_on: '2026-09-16' }); }
    catch (e) { msg = e.message; }
    ck('  and the refusal names only the two that are allowed',
       /Cash/.test(msg) && /Bank transfer/.test(msg) && !/Zelle/.test(msg) && !/Cheque/.test(msg), msg);

    // The two that ARE allowed still work, both ways round.
    const p1 = await pay.addPayment({ load_id: 'L_OK1', load_kind: 'purchase', mode: 'Cash', amount: 100, paid_on: '2026-09-16' });
    ck('cash on a purchase still records', !!p1 && p1.mode === 'Cash');
    const p2 = await pay.addPayment({ load_id: 'L_OK2', load_kind: 'sale', mode: 'Bank transfer', amount: 100, paid_on: '2026-09-16', bank: 'BofA' });
    ck('a bank transfer on a sale still records', !!p2 && p2.mode === 'Bank transfer', JSON.stringify(p2 && p2.mode));
    ck('  carrying the account it landed in', p2 && p2.bank === 'BofA', JSON.stringify(p2 && p2.bank));
    ck('  because a transfer is a mode with a bank behind it',
       banks.MODES_WITH_BANK.includes('Bank transfer'), banks.MODES_WITH_BANK.join(','));

    // ── THE YARD ASSISTANT USES THE SAME LIST ────────────────────────────
    // It records against yard loads too. If it proposed a Zelle, addPayment
    // would refuse at run time — a confirmed action that then fails, which is
    // worse than never offering it.
    const tools = fs.readFileSync(path.join(ROOT, 'helpers/tools.js'), 'utf8');
    // Asked for the LOAD'S kind, not a hardcoded one: the two kinds now take
    // different lists, so a tool that always asked for 'purchase' would offer
    // Zelle on a sale and be refused by the server it just agreed with.
    ck('the yard assistant asks modesForKind for the load\'s own kind',
       /modesForKind\(load\._kind \|\| load\.load_kind \|\| 'purchase'\)/.test(tools)
       && !/PAYMENT_MODES\.find/.test(tools),
       'two validators disagreeing shows up as a confirmed payment that then errors');
    ck('  and tells the model the two it may use',
       /describe: 'Cash or Bank transfer'/.test(tools));
}

// ══════════════════════════════════════════════════════════════════════════
section('C — Edge Metals keeps its full list');
// ══════════════════════════════════════════════════════════════════════════
{
    // She said Edge Yard, twice. Narrowing the other company would be me
    // deciding something she did not ask about — and doing it to the company
    // this whole app works hardest to keep separate.
    for (const kind of ['bill', 'sale_cost', 'metals_trucking']) {
        const modes = pay.modesForKind(kind);
        ck(`${kind} still offers every mode`, modes.length === pay.PAYMENT_MODES.length, modes.join(','));
        ck(`  including Zelle and Cheque`, modes.includes('Zelle') && modes.includes('Cheque'), modes.join(','));
    }

    // Trucker bills are a YARD thing but have their own form and their own
    // mode list, and she did not mention them. Left alone deliberately —
    // sweeping them in would be the same over-reach in a smaller place.
    const t = pay.modesForKind('trucker');
    ck('trucker bills were not swept in', t.includes('Zelle'), t.join(','));

    const em = await pay.addPayment({ load_id: 'BILL_1', load_kind: 'bill', mode: 'Zelle', amount: 50, paid_on: '2026-09-16', bank: 'Chase Bank' });
    ck('  and an Edge Metals Zelle still records', !!em && em.mode === 'Zelle');
}

// ══════════════════════════════════════════════════════════════════════════
section('D — what is already on file still means what it meant');
// ══════════════════════════════════════════════════════════════════════════
{
    // The modes are narrowed for NEW yard entries. They are not deleted from
    // the file's vocabulary: a yard payment recorded as Zelle last month must
    // keep reading as Zelle everywhere it appears, and helpers/bankMatch.js
    // keys on Zelle/Wire.
    for (const m of ['Zelle', 'Wire', 'Cheque']) {
        ck(`${m} is still a mode this file knows`, pay.PAYMENT_MODES.includes(m), pay.PAYMENT_MODES.join(','));
    }
    ck('and the yard list is a SUBSET of it, not a separate vocabulary',
       pay.YARD_LOAD_MODES.every((m) => pay.PAYMENT_MODES.includes(m)),
       `${pay.YARD_LOAD_MODES.join(',')} vs ${pay.PAYMENT_MODES.join(',')}`);

    // This is what makes the narrowing safe: there is no update path, so a
    // stored payment is never re-validated. If one is ever added, it has to
    // reckon with rows whose mode its own form can no longer produce.
    ck('there is still no way to re-save an existing payment',
       typeof pay.updatePayment !== 'function' && typeof pay.editPayment !== 'function',
       'an update path would re-validate old rows against the narrowed list and reject them');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error(e); process.exit(1); });
