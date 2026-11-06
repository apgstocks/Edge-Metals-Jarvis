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
    for (const n of ['bank_unmatched', 'bank_who_is']) {
        ck(`${n} is a tool the bot can reach`, names.includes(n), names.join(' '));
    }
    // ── AND THE CLAIMS DOORS ARE SHUT (2026-11-07, Apsara) ──────────────
    // find_claims and claim_detail used to be here. helpers/tools.js IS the
    // YARD assistant's registry, and claims are raised against SUPPLIERS on
    // CONTAINERS — the export side. tests/voice-router.js caught it.
    // Asked whether to narrow that guard or remove the tools, she said
    // "Neither — take both back out."
    for (const n of ['find_claims', 'claim_detail']) {
        ck(`${n} is NOT on the yard assistant`, !names.includes(n),
           'claims belong to Edge Metals; the yard assistant must not learn them');
    }
    // The gap this file exists to close: before this file, the bot could not
    // see the bank at all.
    ck('the bot can now see the bank', names.some((n) => /^bank_/.test(n)));
    // The claims half of that sentence is gone on purpose — see above. The
    // check is INVERTED rather than deleted, because "no tool whose name
    // mentions a claim" is now the rule, and a rule with no check is a rule
    // that comes back by accident.
    ck('  and sees no claims at all', !names.some((n) => /claim/i.test(n)),
       names.filter((n) => /claim/i.test(n)).join(', '));
}

// ══════════════════════════════════════════════════════════════════════════
// SECTION B — REMOVED 2026-11-07, WITH THE CODE IT COVERED
// ══════════════════════════════════════════════════════════════════════════
// It exercised find_claims and claim_detail: open vs settled, matching a
// supplier however she types it, days_open on every open row, the oldest
// first because "age itself is the escalation" (her rule, when she refused a
// deadline field), a settled claim having no days_open, and a container with
// no claims saying so rather than inventing one.
//
// That shaping lived INSIDE the two tools in helpers/tools.js, not in
// helpers/claims.js — so when Apsara had the tools taken off the yard
// assistant ("Neither — take both back out"), the code these checks covered
// went with them. Deleting the checks quietly would have made the suite look
// unchanged while real behaviour stopped being guarded, so this stone is
// here instead.
//
// IF CLAIMS EVER COME BACK — in Jarvis proper (workflow/brain.js), which is
// where they would belong — bring these checks back with them. The rules
// they encode are hers and did not stop being true:
//   · open and settled are separate answers, never one list
//   · a supplier matches however she spells it
//   · every open claim says how long it has been sitting, and the oldest
//     sorts first, because that is the one costing her money
//   · a settled claim has no days_open
//   · a container with no claims says so rather than inventing one
// The removed section is in git: tests/bot-doors.js before this commit.

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
    for (const n of ['bank_unmatched', 'bank_who_is']) {
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
