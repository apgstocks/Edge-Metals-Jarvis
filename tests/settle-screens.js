// ── tests/settle-screens.js ──────────────────────────────────────────────
// Apsara, 2026-10-16: "when we pay load/sales-there should be a option to
// adjust against sale incase of load and against load in case of sale."
//
// THE TWO PAY MODALS DRIFT, AND IT IS ALWAYS THE PHONE THAT IS LEFT BEHIND.
// The website and the Edge Yard app carry the same modal twice, by hand, in
// dashboard/app/ and mobile-app/www/app/. This repo has paid for that
// separation repeatedly — most recently 2026-10-16, when a button change was
// built on mobile-app/www while the screenshot she sent was the WEBSITE, and
// her reply was "What did you change.I dont undertsand .This is still
// remaining same only".
//
// So this does not test that the control works — tests/settle-against.js
// section H does that, through the real routes. This tests that the two
// clients have not diverged, by name, which is the failure no behavioural
// test on either side can see.
//
//   A  the website has the control
//   B  the phone has the control
//   C  they agree, id for id
//   D  and the engine is reached through the ROUTE, not re-implemented
//   E  a settlement is not drawn as a cash payment

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
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Whole-client text, because a control's markup, its behaviour and its
// binding live in three different part files on both sides.
const WEB = ['dashboard/app/12-payments-recording.js', 'dashboard/app/13-loads-render.js'].map(read).join('\n');
const APP = ['mobile-app/www/app/04-payments.js', 'mobile-app/www/app/05-payment-roles.js',
             'mobile-app/www/app/09-loads-deck.js'].map(read).join('\n');

// The ids the feature is made of. Named once, checked against both — a list
// per client is how one side quietly loses a field.
const IDS = ['paySettleBox', 'paySettleLead', 'pay_settle_against', 'pay_settle_amount',
             'btnSettleAgainst', 'paySettleNote'];

// ══════════════════════════════════════════════════════════════════════════
section('A — the website has it');
{
    for (const id of IDS) {
        ck(`${id} exists`, WEB.includes(id), 'the website is missing part of the control');
    }
    // INVERTED 2026-10-17. It used to assert the box started hidden. Apsara,
    // on the 9.6 APK: "still adjust against that feature not there in app".
    // Hidden-unless-applicable is indistinguishable from never-built, so the
    // property now required is the opposite one.
    ck('the box is NOT hidden by default', !/id="paySettleBox" class="hidden"/.test(WEB),
       'a control she cannot see reads as a missing feature');
    ck('  and it explains itself when empty', /Nothing open on the other side/.test(WEB),
       'an empty control with no reason is a bug report waiting to happen');
    ck('  naming the party, so she knows it looked at the right person',
       /Nothing open on the other side for/.test(WEB));
    ck('  and a server without the route says so instead of going quiet',
       /ahead of it/.test(WEB),
       'the 2026-10-17 case: APK shipped, VM not restarted, feature looked absent');
    ck('it is fired when the modal opens', /refreshSettleOptions\(\)/.test(WEB));
    ck('  and the button is wired to the writer', /btnSettleAgainst'\)\.addEventListener/.test(WEB));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — and so does the phone');
{
    for (const id of IDS) {
        ck(`${id} exists`, APP.includes(id), 'THE PHONE IS BEHIND THE WEBSITE AGAIN');
    }
    ck('the box is NOT hidden by default', !/id="paySettleBox" class="hidden"/.test(APP));
    ck('  and it explains itself when empty', /Nothing open on the other side for/.test(APP));
    ck('  and a server without the route says so instead of going quiet', /ahead of it/.test(APP));
    ck('it is fired when the modal opens', /refreshSettleOptions\(\)/.test(APP));
    ck('  and the button is wired to the writer', /btnSettleAgainst'\)\.addEventListener/.test(APP));
}

// ══════════════════════════════════════════════════════════════════════════
section('C — and they agree, id for id');
{
    // The real check: not "both have a list I wrote twice", but that neither
    // side carries a pay_settle_* field the other does not. A new field added
    // to one client only is exactly the drift this file exists to catch, and
    // it would pass sections A and B.
    const fields = (src) => {
        const found = new Set();
        const re = /\b(pay_settle_[a-z_]+|paySettle[A-Za-z]+|btnSettleAgainst)\b/g;
        let m; while ((m = re.exec(src))) found.add(m[1]);
        return found;
    };
    const w = fields(WEB), a = fields(APP);
    const onlyWeb = [...w].filter((x) => !a.has(x));
    const onlyApp = [...a].filter((x) => !w.has(x));
    ck('nothing exists only on the website', onlyWeb.length === 0, onlyWeb.join(', '));
    ck('nothing exists only on the phone', onlyApp.length === 0, onlyApp.join(', '));
    ck('  and there is something to compare', w.size >= IDS.length, `${w.size} found`);
}

// ══════════════════════════════════════════════════════════════════════════
section('C2 — the failure is SAID, not swallowed');
{
    // The original catch was an empty block with a comment, which is how a
    // missing route on the server became indistinguishable from a missing
    // feature in the app. Recording a payment must still never be blocked —
    // so the control is disabled and the reason shown, never thrown.
    for (const [name, src] of [['website', WEB], ['phone', APP]]) {
        ck(`${name} has no silent catch in the settle lookup`,
           !/catch \(e\) \{\s*\/\/[^\n]*\n\s*\}/.test(src.slice(src.indexOf('refreshSettleOptions'), src.indexOf('settleAgainstSelected'))),
           'an empty catch here is what made this undiagnosable');
        ck(`  ${name} disables the control rather than hiding it`,
           /setEmpty\(/.test(src) && /btn\) btn\.disabled = true/.test(src));
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('D — the engine is REACHED, not re-implemented');
{
    // The arithmetic — the same-party rule, the cap on both sides, the two
    // rows written atomically — lives in helpers/payments.js. A client that
    // computed any of it would be a second implementation that drifts.
    for (const [name, src] of [['website', WEB], ['phone', APP]]) {
        ck(`${name} asks the server what can be settled`,
           /\/api\/payments\/settle-options/.test(src));
        ck(`  and posts to the settle route`, /'\/api\/payments\/settle'/.test(src));
        ck(`  it does not decide who the parties are`,
           !/normalizeName|canonicalName/.test(src),
           'the same-party rule is the server’s — a client copy will disagree with it');
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('E — a settlement is not drawn as cash');
{
    // helpers/payments.js deliberately gives these rows mode 'Settlement'
    // and no petty-cash entry. The history list offers to put cash back when
    // deleting a Cash row; offering that on a settlement would promise money
    // that was never taken.
    const hist = read('helpers/payments.js');
    ck('the engine still marks the row as a settlement', /is_settlement: true/.test(hist));
    ck('  with no petty cash entry', /petty_cash_entry_id: null/.test(hist));
    for (const [name, src] of [['website', WEB], ['phone', APP]]) {
        ck(`${name}'s delete prompt only promises cash back for Cash`,
           /mode \|\| ''\)\.toLowerCase\(\) === 'cash'/.test(src)
           || /toLowerCase\(\) === 'cash'/.test(src),
           'a settlement would offer to return cash that never moved');
    }
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
