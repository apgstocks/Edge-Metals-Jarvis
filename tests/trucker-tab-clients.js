// ── tests/trucker-tab-clients.js ──────────────────────────────────────────
// The client half of the Trucker tab. Server rules are in
// tests/trucker-bills.js; what that file cannot see is whether the buttons
// she asked for are actually drawn, and to whom.
//
// "once paid, hide delete option for staff and admin" is a statement about a
// button, so it needs a test that looks at buttons. And it is the fourth time
// in this app a money rule has been expressed as "hide the control" — twice
// the control was the ONLY enforcement — so both halves get asserted every
// time now: the rule on the server, and the button here.
//
// THE BUG THIS ALREADY CAUGHT
// ---------------------------
// The first port of the two modals into the website put them beside
// #payModal, which is built inside the Loads tab's TEMPLATE STRING. So they
// existed only while Loads was open, and opening the Trucker tab — which
// replaces #viewRoot — destroyed them. In a browser the Add button would have
// done nothing at all, with no error. Section D is that, pinned.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const CLIENTS = [
    ['app', fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8')],
    ['website', fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8')],
];
// Comments stripped before matching — a comment describing the thing being
// asserted has passed this kind of check four times in this repo.
const nocomment = (t) => String(t).split('\n').filter((l) => !/^\s*(\/\/|\*|<!--)/.test(l)).join('\n');

function grab(src, name) {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) return '';
    const bodyStart = src.indexOf(') {', src.indexOf('(', i)) + 2;
    let d = 0;
    for (let k = bodyStart; k < src.length; k++) {
        if (src[k] === '{') d++;
        else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
    }
    return '';
}
// Runs a predicate out of the shipped file with the globals it closes over
// supplied as parameters — the same approach as tests/load-card-actions.js.
const build = (src, name, { IS_SUPER = false, ROLE = 'admin' } = {}) =>
    new Function('IS_SUPER', 'ROLE', grab(src, name) + `; return ${name};`)(IS_SUPER, ROLE);

console.log('\n─ the Trucker tab, in both clients ──────────────────────────');

const UNPAID  = { id: 'TRK_001', amount: 500, payment: { paid: 0, pending: 500, status: 'unpaid' } };
const PARTIAL = { id: 'TRK_002', amount: 500, payment: { paid: 200, pending: 300, status: 'partial' } };
const PAID    = { id: 'TRK_003', amount: 500, payment: { paid: 500, pending: 0, status: 'paid' } };
const OVER    = { id: 'TRK_004', amount: 500, payment: { paid: 600, pending: 0, over: 100, status: 'overpaid' } };
const NOPAY   = { id: 'TRK_005', amount: 500 };

section('A — "once paid, hide delete option for staff and admin"');
for (const [label, src] of CLIENTS) {
    for (const role of ['admin', 'staff', 'user']) {
        const del = build(src, 'truckerBillIsDeletable', { ROLE: role });
        ck(`${label}/${role}: an unpaid bill can be deleted`, del(UNPAID));
        ck(`${label}/${role}:   one with no payment record at all can be deleted`, del(NOPAY));
        ck(`${label}/${role}: a PART paid bill cannot`, !del(PARTIAL),
           'her rule is "once paid", and a part payment is money that moved');
        ck(`${label}/${role}: a FULLY paid bill cannot`, !del(PAID));
        ck(`${label}/${role}: an OVERpaid bill cannot`, !del(OVER));
    }
    // One cent is still a payment row that the cascade would destroy.
    const del = build(src, 'truckerBillIsDeletable');
    ck(`${label}: even one cent blocks it`,
       !del({ id: 'X', amount: 500, payment: { paid: 0.01, pending: 499.99, status: 'partial' } }));

    // The Jarvis exception, same as loads.
    const sup = build(src, 'truckerBillIsDeletable', { IS_SUPER: true });
    ck(`${label}: the Jarvis profile deletes a paid bill`, sup(PAID) && sup(PARTIAL) && sup(OVER));
}

section('B — who may pay');
for (const [label, src] of CLIENTS) {
    const admin = build(src, 'truckerBillIsPayable', { ROLE: 'admin' });
    ck(`${label}: admin can pay an unpaid bill`, admin(UNPAID));
    ck(`${label}:   and a part-paid one`, admin(PARTIAL));
    ck(`${label}: a settled bill offers no Pay`, !admin(PAID),
       'correcting an overpayment means removing the wrong payment, not adding another');
    ck(`${label}:   nor an overpaid one`, !admin(OVER));

    // STAFF SEE THE TAB AND NOT THE PAY BUTTON. /api/payments is deliberately
    // absent from STAFF_ALLOWED_PATH_PREFIXES, so the button would 403 —
    // and a button that always fails is worse than no button.
    const staff = build(src, 'truckerBillIsPayable', { ROLE: 'staff' });
    ck(`${label}: staff get no Pay button at all`, !staff(UNPAID) && !staff(PARTIAL),
       'the server would 403 them; showing it would be a control that always fails');
}

section('C — the tab is offered to everyone');
{
    const [, app] = CLIENTS.find(c => c[0] === 'app');
    const appSrc = nocomment(app);
    // Not inside the ROLE === 'admin' spread that guards Expenses/Report/Docs.
    const bar = appSrc.slice(appSrc.indexOf("$('mobileTabBar').innerHTML"), appSrc.indexOf("].join('')"));
    ck('app: the Trucker tab is in the bar', /tabBtn\('trucker', 'Trucker'\)/.test(bar));
    ck('app:   and NOT behind the admin-only spread', (() => {
        const adminPart = bar.slice(bar.indexOf("ROLE === 'admin'"));
        return !/tabBtn\('trucker'/.test(adminPart);
    })(), 'she asked for it "for everyone"');

    const [, site] = CLIENTS.find(c => c[0] === 'website');
    ck('website: the tab exists', /id: 'trucker-bills'/.test(site));
    ck('website:   is not adminOnly', !/id: 'trucker-bills'[^}]*adminOnly/.test(site));
    ck('website:   and staff can see it', /n\.id === 'trucker-bills'/.test(nocomment(site)),
       'the staff nav filter is an allowlist — absent from it, the tab is invisible to staff');

    // NAMED DIFFERENTLY ON THE WEBSITE, on purpose: the dashboard already has
    // a "Truckers" tab that is a roster of hauliers and their WhatsApp groups.
    // Two tabs both called Trucker, one holding contacts and one holding
    // debts, is a mistake waiting for a hurried afternoon.
    ck('website: the existing trucker ROSTER tab is untouched', /id: 'truckers',\s*label: 'Truckers'/.test(site));
    ck('  and the bills tab is named apart from it', /id: 'trucker-bills', label: 'Trucker Bills'/.test(site));
}

section('D — the modals are real markup, not part of a tab');
for (const [label, src] of CLIENTS) {
    const doc = new JSDOM(src).window.document;
    // THE BUG. Ported beside #payModal on the website, these landed inside the
    // Loads tab's template string: present only while Loads was open, and
    // destroyed the moment the Trucker tab replaced #viewRoot. The Add button
    // would have done nothing, silently.
    for (const id of ['truckerModal', 'truckerPayModal']) {
        ck(`${label}: #${id} is in the document, not in a template string`, !!doc.getElementById(id),
           'inside a tab template it exists only while that tab is open');
    }
    // Every field the handlers touch.
    for (const id of ['trk_date', 'trk_company', 'trk_ticket', 'trk_amount', 'trkErr', 'trkSave', 'trkClose',
                      'trk_pay_mode', 'trk_pay_amount', 'trk_pay_date', 'trkPayErr', 'trkPaySave', 'trkPayClose']) {
        ck(`${label}:   #${id}`, !!doc.getElementById(id));
    }
    ck(`${label}: the modals are wired at boot`, /wireTruckerModals\(\)/.test(nocomment(src)));
}

section('E — the four fields she named, and the payment shape');
for (const [label, src] of CLIENTS) {
    const doc = new JSDOM(src).window.document;
    ck(`${label}: date, company, ticket, amount — and nothing else required`,
       !!doc.getElementById('trk_date') && !!doc.getElementById('trk_company')
       && !!doc.getElementById('trk_amount'));
    ck(`${label}:   the ticket is marked optional on the label`,
       /Load ticket \(optional\)/.test(src),
       'she said optional; a field that looks required gets filled with a guess');

    const clean = nocomment(src);
    // THE FIELD THE WHOLE REPORT SPLIT HANGS OFF. Without load_kind:'trucker'
    // the payment is stored as a purchase and the haulage vanishes into what
    // the yard paid for metal — with the grand total still correct.
    ck(`${label}: the payment is sent as load_kind 'trucker'`,
       /load_kind: 'trucker'/.test(clean),
       "stored as a purchase, it becomes load spend and no total looks wrong");
    ck(`${label}:   against the bill id`, /load_id: payingTruckerBill\.id/.test(clean));
    // Built from the server's list, never hardcoded here.
    ck(`${label}: the mode dropdown comes from the server`,
       /truckerModes\.map\(/.test(clean),
       'a hardcoded pair here would drift the day the server list changes');
    ck(`${label}:   with Zelle and Wire only as the fallback`,
       /truckerModes = \['Zelle', 'Wire'\]/.test(clean));
}

section('F — it works on a phone');
for (const [label, src] of CLIENTS) {
    // The bills table is 560px wide, so it must stack — the same rule
    // tests/mobile-layout.js enforces for every other wide table. Asserted
    // here too so a failure names the Trucker tab rather than a width.
    // Found by its OWN id, not by its style string. The first version matched
    // on `font-size:12.5px; min-width:560px` — which is byte-for-byte what the
    // inventory drill-down table already uses, so indexOf found that one
    // instead and this section spent its time asserting a different screen.
    // It failed, which is the only reason it was noticed; had the drill-down
    // been fully labelled it would have passed while checking nothing.
    const at = src.indexOf('<table id="trkBillsTable"');
    ck(`${label}: the bills table stacks below 600px`, at > 0);
    if (at < 0) continue;
    const head = src.slice(at, src.indexOf('>', at));
    ck(`${label}:   and carries the stack-table class`, /class="[^"]*\bstack-table\b/.test(head),
       'a 560px table on a ~370px screen scrolls sideways — she has rejected that layout once already');
    const block = src.slice(at, src.indexOf('</table>', at));
    const cells = [...block.matchAll(/<td\b([^>]*)>/g)].map(m => m[1]);
    // A colspan cell is the empty state — "No trucker bills yet." — which
    // spans every column and therefore has no single column name to carry.
    // Exempted explicitly rather than by a pattern that might swallow real
    // cells: guessing which cells are exempt is exactly how the spacer check
    // in tests/mobile-layout.js ended up exempting nearly the whole table.
    const unlabelled = cells.filter(a =>
        !/data-label=/.test(a)
        && !/class="[^"]*\bst-head\b/.test(a)
        && !/\bcolspan=/.test(a));
    ck(`${label}:   every data cell says which column it is`, unlabelled.length === 0,
       `unlabelled: ${unlabelled.slice(0, 2).join(' | ')}`);
    ck(`${label}:   and the empty state is a colspan row, not a bare cell`,
       cells.some(a => /\bcolspan="6"/.test(a)));
    ck(`${label}: the date field gets a picker`, /wireUsDateField\('trk_date'\)/.test(src));
    ck(`${label}:   and so does the payment date`, /wireUsDateField\('trk_pay_date'\)/.test(src));
}

section('G — deleting asks, and asks twice when money moved');
for (const [label, src] of CLIENTS) {
    ck(`${label}: it asks before deleting`, /Are you sure you want to delete the \$\{b\.company\} bill/.test(src));
    ck(`${label}:   and again when there are payments`,
       /recorded as paid against this bill/.test(src)
       && /logged against the Jarvis profile/.test(src),
       'erasing the record that money moved deserves its own question');
    ck(`${label}: a refusal shows the server's own sentence`,
       /alert\(err\.message\)/.test(nocomment(src)),
       'BILL_HAS_PAYMENTS already explains the way out — restating it gives a worse second version');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
process.exit(fail ? 1 : 0);
