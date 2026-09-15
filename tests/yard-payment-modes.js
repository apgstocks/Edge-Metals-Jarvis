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
    for (const [who, src] of [['website', DASH], ['app', APP]]) {
        const opts = payModeOptions(src);
        ck(`${who}: two options, not five`,
           !!opts && opts.length === 2, JSON.stringify(opts));
        ck(`  ${who}: Cash and Bank transfer`,
           !!opts && opts.join('|') === 'Cash|Bank transfer', JSON.stringify(opts));
        // Named individually so a failure says WHICH one came back.
        for (const gone of ['Zelle', 'Wire', 'Cheque']) {
            ck(`  ${who}: no ${gone}`, !!opts && !opts.includes(gone), JSON.stringify(opts));
        }
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

    for (const kind of ['purchase', 'sale']) {
        for (const mode of ['Zelle', 'Wire', 'Cheque']) {
            let err = null;
            try { await pay.addPayment({ load_id: `L_${kind}_${mode}`, load_kind: kind, mode, amount: 10, paid_on: '2026-09-16', bank: 'Chase Bank' }); }
            catch (e) { err = e; }
            ck(`a yard ${kind} cannot be paid by ${mode}`, !!err, 'recorded anyway');
        }
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
    ck('the yard assistant asks modesForKind rather than the full list',
       /modesForKind\('purchase'\)/.test(tools) && !/PAYMENT_MODES\.find/.test(tools),
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
