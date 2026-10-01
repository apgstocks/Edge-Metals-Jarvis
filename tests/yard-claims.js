// ── tests/yard-claims.js ──────────────────────────────────────────────────
// Apsara, 2026-10-01, asked how the yard handles a claim against a load a
// supplier sold us. It did not — claims were an export concept keyed on
// (invoice_no, container_no), and nothing in loads.js or payments.js had ever
// heard of one. Then she specified it:
//
//   "or if he clicks claim,ask him to select the load.if payment is already
//    made for that load-track separately.however put it in load track that
//    paid so n so.claim made on date so n so.remind user abut the claim every
//    day.if load payment not already made,ask user whether it can be adjusted
//    in load invoice?"
//
// And, asked the two questions that change the build:
//   · partly paid → "Ask me each time"
//   · on the seller's printed ticket → "Yes, as its own line saying Claim"
//
// ── THE PIVOT IS WHETHER THE MONEY HAS GONE ───────────────────────────────
// You cannot deduct from money already paid. So the branch is not a setting,
// it is a fact about the load, and adjustable() below computes an OFFER
// rather than applying a rule — because her answer to the third case was
// that she decides.

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');

process.env.JARVIS_TEST = '1';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-yclaims-'));
process.env.DATA_DIR = TMP;

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const cfg = require('../config');
cfg.YARD_CLAIMS_FILE = path.join(TMP, 'yard_claims.json');
cfg.LOADS_FILE = path.join(TMP, 'loads.json');
cfg.PAYMENTS_FILE = path.join(TMP, 'payments.json');
cfg.PETTY_CASH_FILE = path.join(TMP, 'petty_cash.json');
for (const f of [cfg.YARD_CLAIMS_FILE, cfg.LOADS_FILE, cfg.PAYMENTS_FILE, cfg.PETTY_CASH_FILE]) {
    fs.writeFileSync(f, '[]');
}

const yc = require('../helpers/yardClaims');
const loads = require('../helpers/loads');

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — WHAT CAN BE DONE, FROM THE LEDGER');
// ══════════════════════════════════════════════════════════════════════════
// Her exact example, and the three states around it.
{
    const partly = yc.adjustable({ payable: 5000, paid: 3000, claimAmount: 2500 });
    ck('partly paid is recognised as its own case', partly.state === 'partly_paid');
    ck('  outstanding is computed, not guessed', partly.outstanding === 2000);
    ck('  it can absorb 2000 of the 2500', partly.can_adjust === 2000);
    ck('  and 500 has to be chased', partly.must_track === 500);
    ck('  and the sentence says SHE decides', /you decide/.test(partly.why), partly.why);

    const unpaid = yc.adjustable({ payable: 5000, paid: 0, claimAmount: 2500 });
    ck('nothing paid: the whole claim can come off', unpaid.state === 'unpaid'
        && unpaid.can_adjust === 2500 && unpaid.must_track === 0);

    const paid = yc.adjustable({ payable: 5000, paid: 5000, claimAmount: 2500 });
    ck('fully paid: nothing can be adjusted', paid.state === 'paid'
        && paid.can_adjust === 0 && paid.adjustable_now === 0);
    ck('  so the whole claim is tracked', paid.must_track === 2500);
    ck('  and the sentence says why', /already paid/.test(paid.why), paid.why);
}
{
    // ── THE TWO CASES A RULE WOULD HAVE GOT WRONG ────────────────────────
    const unpriced = yc.adjustable({ payable: null, paid: 0, claimAmount: 400 });
    ck('a load with NO PRICE says so rather than offering an adjustment',
       unpriced.state === 'unpriced' && unpriced.can_adjust === 0 && unpriced.must_track === 400,
       'offering to deduct from a balance that does not exist is a guess dressed as a fact');

    // An overpaid load has negative outstanding. Math.min(claim, outstanding)
    // without the floor would return a NEGATIVE adjustment — which would ADD
    // money to what he is owed, off the back of a claim against him.
    const over = yc.adjustable({ payable: 5000, paid: 5600, claimAmount: 400 });
    ck('an OVERPAID load absorbs nothing, never a negative amount',
       over.can_adjust === 0 && over.must_track === 400,
       `can_adjust ${over.can_adjust} — a negative here would pay him MORE because of a claim`);
    ck('  and it reads as paid', over.state === 'paid');
}

// ══════════════════════════════════════════════════════════════════════════
section('B — raising one');
{
    const c = await yc.raise({ load_id: 'EDGE_12', seller: 'Ramesh', amount: 450,
        reason: '20% dirt in the Al combo', raised_on: '2026-09-01' });
    ck('it is stored against the load', c.load_id === 'EDGE_12');
    ck('and opens as open', c.status === 'open');
    ck('with her date', c.raised_on === '2026-09-01');
    ck('and nothing settled yet', c.settled_on === null && c.settled_how === null);
}
{
    // ── THE REASON IS REQUIRED, UNLIKE MOST NOTES HERE ───────────────────
    // A claim is argued about with a supplier weeks later. "claim $400" with
    // no reason is unusable then, and it is the one field that cannot be
    // reconstructed from anything else.
    let threw = null;
    try { await yc.raise({ load_id: 'EDGE_1', amount: 100 }); } catch (e) { threw = e.message; }
    ck('a claim with no reason is refused', /what is the claim for/i.test(threw || ''), String(threw));

    for (const [what, input] of [
        ['no load', { amount: 100, reason: 'x' }],
        ['no amount', { load_id: 'EDGE_1', reason: 'x' }],
        ['zero', { load_id: 'EDGE_1', amount: 0, reason: 'x' }],
        ['negative', { load_id: 'EDGE_1', amount: -5, reason: 'x' }],
    ]) {
        let t = false;
        try { await yc.raise(input); } catch (e) { t = true; }
        ck(`${what} is refused`, t);
    }
}
{
    const ticket = 'CLAIM_TICKET_1';
    const a = await yc.raise({ load_id: 'EDGE_7', amount: 200, reason: 'short', client_request_id: ticket });
    const b = await yc.raise({ load_id: 'EDGE_7', amount: 200, reason: 'short', client_request_id: ticket });
    ck('a double-tap raises ONE claim', a.id === b.id,
       'two $200 claims on one load is an argument with a supplier that she loses');
}

// ══════════════════════════════════════════════════════════════════════════
section('C — only UNSETTLED claims reduce anything');
// ══════════════════════════════════════════════════════════════════════════
// The double-deduction trap. An adjusted claim already lives inside
// net_payable; a recovered one has been paid back. Counting either here as
// well would deduct the same money twice.
{
    ck('an open claim counts', yc.openAmountForLoad('EDGE_12') === 450);
    const open = yc.forLoad('EDGE_12')[0];
    await yc.settle(open.id, { how: 'adjusted' });
    ck('an ADJUSTED claim stops counting', yc.openAmountForLoad('EDGE_12') === 0,
       'it is already inside net_payable — counting it here deducts it twice');

    const c2 = await yc.raise({ load_id: 'EDGE_13', amount: 300, reason: 'wet' });
    await yc.settle(c2.id, { how: 'recovered', note: 'credited next load' });
    ck('a RECOVERED claim stops counting', yc.openAmountForLoad('EDGE_13') === 0);

    const c3 = await yc.raise({ load_id: 'EDGE_14', amount: 90, reason: 'minor' });
    await yc.settle(c3.id, { how: 'dropped', note: 'not worth the argument' });
    ck('a DROPPED claim stops counting', yc.openAmountForLoad('EDGE_14') === 0);
    ck('  but is kept, not deleted', yc.forLoad('EDGE_14').length === 1,
       '"how often do we drop claims against this supplier" has to stay answerable');
}
{
    // Re-settling would move settled_on and make "how long was this open"
    // wrong — which is the only thing the register is for.
    const done = yc.forLoad('EDGE_13')[0];
    let threw = null;
    try { await yc.settle(done.id, { how: 'adjusted' }); } catch (e) { threw = e.message; }
    ck('settling an already-settled claim is refused', /already settled/.test(threw || ''), String(threw));
    let threw2 = null;
    try { await yc.settle(done.id, { how: 'nonsense' }); } catch (e) { threw2 = e.message; }
    ck('and a made-up settlement is refused', !!threw2);
}

// ══════════════════════════════════════════════════════════════════════════
section('D — THE DEDUCTION REACHES EVERY "WHAT IS OWED"');
// ══════════════════════════════════════════════════════════════════════════
// payableOf has ~20 callers — the load card, the pay sheet, the seller's
// ticket, yardProfit, yardBrief, the voice path. Routing the claim through
// payableFrom/net_payable is what makes them agree; a figure that differs
// between the ticket and what Jarvis says out loud is worse than no figure.
{
    ck('payableFrom with two args is unchanged', loads.payableFrom(5000, 200) === 4800,
       'every existing caller passes two and must keep its exact arithmetic');
    ck('and subtracts a claim when given one', loads.payableFrom(5000, 200, 300) === 4500);
    ck('an unpriced load stays unpriced', loads.payableFrom(null, 200, 300) === null);
}
{
    const rec = await loads.addLoad({ date: '2026-10-01', seller: 'Ramesh', weight_unit: 'lb',
        items: [{ description: 'Al combo', gross_weight: 1000, tare_weight: 0, price: 5 }] });
    ck('a new load starts with no claim', rec.claim_amount === null);
    ck('  and net_payable is the full amount', rec.net_payable === 5000);

    await loads.updateLoad(rec.id, { claim_amount: 600 });
    // ── AND AN EDIT MUST NOT WIPE IT ─────────────────────────────────────
    // editLoad recomputes net_payable from whatever survived the patch. The
    // claim is not on that form, so it is never in `entry` — leave it out of
    // the recompute and correcting a typo silently hands the supplier back
    // money she had deducted. This file already records that trap springing
    // on pdf_link, and outboundLoads.js on delivery_status and draft_id.
    await loads.editLoad(rec.id, { date: '2026-10-01', seller: 'Ramesh Metals', weight_unit: 'lb',
        items: [{ description: 'Al combo', gross_weight: 1000, tare_weight: 0, price: 5 }] });
    const after = (await loads.loadLoads()).find((l) => l.id === rec.id);
    ck('an edit KEEPS the adjusted claim', after.claim_amount === 600,
       'the third time this shape has bitten: pdf_link, delivery_status, now this');
    ck('  and net_payable still reflects it', after.net_payable === 4400);
    ck('  and payableOf agrees', loads.payableOf(after) === 4400,
       'this is the single figure twenty callers read');
    ck('  and the edit did apply', after.seller === 'Ramesh Metals');
}

// ══════════════════════════════════════════════════════════════════════════
section('E — ON THE TICKET HE SIGNS');
// ══════════════════════════════════════════════════════════════════════════
// Her answer, 2026-10-01: "Yes, as its own line saying Claim". He signs this.
// A ticket quietly showing $4,400 on a $5,000 load is an argument next week,
// and the one person who cannot look it up is the man holding the pen.
{
    const src = fs.readFileSync(path.join(ROOT, 'helpers/pdf.js'), 'utf8');
    ck('the summary box prints a claim line', /label: 'Less claim'/.test(src));
    ck('the paper slip prints one too', /Less claim: -\$\$\{fmtAmount\(rcpClaim\)\}/.test(src),
       'the slip is what he physically walks away with');
    ck('each deduction prints only when there is one',
       /\.\.\.\(trucking > 0 \? \[\{ label: 'Less trucking'/.test(src),
       'a load with trucking and no claim must print exactly the rows it printed before');
    ck('and a SALE ticket carries neither',
       /const claim = !isSale \? Number\(load\.claim_amount\) \|\| 0 : 0;/.test(src),
       "a buyer's copy has no business carrying what we claimed off a supplier");
    ck('the net is reduced by BOTH deductions',
       /const deducted = trucking \+ claim;/.test(src));
}

// ══════════════════════════════════════════════════════════════════════════
section('F — REMINDED EVERY DAY, AND SILENT WHEN THERE IS NOTHING');
// ══════════════════════════════════════════════════════════════════════════
// Her words: "remind user abut the claim every day". It rides on the 6:30am
// sweep she already reads, which is silent when clean — so settling a claim
// stops the reminder by itself, with nothing to dismiss, and no second daily
// email competes with the first.
{
    fs.writeFileSync(cfg.YARD_CLAIMS_FILE, '[]');
    const sweep = require('../helpers/integritySweep');
    const idOf = (res) => (res.findings || []).filter((f) => f.id === 'open-yard-claims');

    ck('no claims: the check says nothing', idOf(sweep.run()).length === 0,
       'a reminder that fires on an empty register teaches her to skip the email');

    await yc.raise({ load_id: 'EDGE_A', seller: 'Ramesh', amount: 450,
        reason: '20% dirt in the Al combo', raised_on: '2026-09-01' });
    await yc.raise({ load_id: 'EDGE_B', seller: 'Gomez', amount: 120,
        reason: 'short 300 lb', raised_on: '2026-09-28' });

    const found = idOf(sweep.run());
    ck('two open claims are reported', found.length === 1 && found[0].count === 2);
    const items = found[0].items;
    ck('  oldest first', /EDGE_A/.test(items[0].what),
       'the one ignored longest is the one she needs at the top');
    ck('  with the seller and the amount', /Ramesh/.test(items[0].what) && /450/.test(items[0].what));
    ck('  the reason, because that is what she argues from', /dirt/.test(items[0].detail));
    ck('  and the AGE, which is the part that makes her act',
       /30 days ago/.test(items[0].detail), items[0].detail);
    ck('  singular day is not "1 days"', !/1 days ago/.test(items.map((i) => i.detail).join(' ')));

    // Settling stops it. No dismiss, no snooze — the register IS the state.
    for (const c of yc.openClaims()) await yc.settle(c.id, { how: 'adjusted' });
    ck('settling them makes the reminder stop', idOf(sweep.run()).length === 0);
}
{
    // The sweep must survive a broken check rather than losing the whole
    // email — this one is new, so it is worth proving it is wired like the
    // others.
    const sweep = require('../helpers/integritySweep');
    const res = sweep.run();
    ck('the check is registered in the sweep',
       (sweep.CHECKS || []).some((c) => c.id === 'open-yard-claims'));
    ck('and the sweep reports it as one of its checks', res.checks >= 7);
    ck('and nothing is broken', (res.broken || []).length === 0, JSON.stringify(res.broken));
}

// ══════════════════════════════════════════════════════════════════════════
section('G — kept apart from the EXPORT claims register');
{
    const src = fs.readFileSync(path.join(ROOT, 'helpers/yardClaims.js'), 'utf8');
    ck('yard claims key on a LOAD', /load_id: loadId,/.test(src));
    const exp = fs.readFileSync(path.join(ROOT, 'helpers/claims.js'), 'utf8');
    ck('the export register still keys on invoice + container',
       /keyOf/.test(exp),
       'one record whose key is sometimes a container and sometimes a load id is a reader guessing');
    ck('and the two stores are different files',
       cfg.YARD_CLAIMS_FILE !== cfg.CLAIMS_FILE);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\n  THREW:', e.stack || e.message); process.exit(1); });
