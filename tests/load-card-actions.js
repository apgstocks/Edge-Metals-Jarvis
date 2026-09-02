// ── tests/load-card-actions.js ─────────────────────────────────────────────
// Apsara, 2026-09-01, five changes in one line:
//
//   "delete should not be there for partial and full payment. remove the audio
//    option in app. on filtering of load by say, seller - it should not group
//    by date. once full payment is done - remove pay option. add invoice
//    amount in grid box in addition to gross, tare, net"
//
// Four of the five are load-card behaviour and are tested here. (The fifth,
// the mic button, is a UI flag and is asserted in tests/voice-machine.js
// against the shipped source, with tests/voice-e2e.js flipping it on so the
// machinery underneath is still exercised.)
//
// WHY EXTRACT RATHER THAN REIMPLEMENT
// -----------------------------------
// These pull the real functions out of the shipped HTML and run them. This
// project has already shipped a test that asserted index.html merely
// *mentioned* a feature and passed green against a completely dead build. A
// rule about money — which loads can be deleted, which can still be paid —
// is not a rule worth testing against a copy of itself.
//
// So: every assertion below fails if the button logic is removed from the
// client it claims to be testing.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const MOBILE = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');
const DASH = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');

// Pulls one named function out of a client, by source text. Throws rather than
// returning undefined: a silently missing function would make every assertion
// below vacuously pass, which is the failure mode this file exists to avoid.
function grab(src, name, label) {
    const re = new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}', 'm');
    const m = re.exec(src);
    if (!m) throw new Error(`${label}: could not find function ${name}() — if it was renamed, update this test rather than deleting it`);
    return m[0];
}

console.log('\n─ load card: Delete, Pay, Amount, and flat search results ─');

// ── 1. Delete disappears once money has been booked against a load ────────
section('A — a load with a payment cannot be deleted from either client');
for (const [label, src] of [['app', MOBILE], ['website', DASH]]) {
    const deletable = new Function(grab(src, 'loadIsDeletable', label) + '; return loadIsDeletable;')();

    ck(`${label}: an unpaid load is deletable`, deletable({ id: 'L1', payment: { paid: 0, pending: 500, status: 'unpaid' } }));
    ck(`${label}: a load with NO payment record at all is deletable`, deletable({ id: 'L1' }));
    ck(`${label}: a PARTIALLY paid load is not`, !deletable({ id: 'L1', payment: { paid: 200, pending: 300, status: 'partial' } }));
    ck(`${label}: a FULLY paid load is not`, !deletable({ id: 'L1', payment: { paid: 500, pending: 0, status: 'paid' } }));
    ck(`${label}: an OVERpaid load is not`, !deletable({ id: 'L1', payment: { paid: 600, pending: 0, over: 100, status: 'overpaid' } }));
    // A single cent still counts. The rule is "money has been booked against
    // this", not "a meaningful amount has been" — and a payment of 0.01 is
    // still a payment row that would be silently destroyed by the cascade in
    // DELETE /api/loads/:id.
    ck(`${label}: even one cent blocks the delete`, !deletable({ id: 'L1', payment: { paid: 0.01, pending: 499.99, status: 'partial' } }));
    // paid_amount_unknown: money paid against a load with no priced items.
    // There is no total to settle against, but there IS a payment — so the
    // delete must still be blocked. This is the case a status-string check
    // would get wrong, which is why the function keys off `paid` instead.
    ck(`${label}: money on an unpriced load blocks the delete`,
       !deletable({ id: 'L1', payment: { paid: 250, total: null, pending: null, status: 'paid_amount_unknown' } }));
}

// ── 2. Pay disappears once there is nothing left to pay ───────────────────
section('B — Pay is gone once the load is settled');
{
    // Mobile only: the website has no payment UI at all (no Pay button, no
    // pay modal). Asserting it in both clients would be asserting a fiction.
    const payable = new Function(grab(MOBILE, 'loadIsPayable', 'app') + '; return loadIsPayable;')();

    ck('unpaid is payable', payable({ payment: { paid: 0, pending: 500, status: 'unpaid' } }));
    ck('partially paid is still payable', payable({ payment: { paid: 200, pending: 300, status: 'partial' } }));
    ck('fully paid is NOT payable', !payable({ payment: { paid: 500, pending: 0, status: 'paid' } }));
    ck('overpaid is NOT payable', !payable({ payment: { paid: 600, pending: 0, over: 100, status: 'overpaid' } }),
       'adding another payment on top of an overpayment is never the fix — removing the wrong one is');
    // No priced items means no answer to "is it settled", so Pay stays. The
    // alternative strands a real load with no way to record money against it.
    ck('an unpriced load stays payable', payable({ payment: { paid: 250, total: null, pending: null, status: 'paid_amount_unknown' } }));
    ck('a load the server sent no summary for stays payable', payable({ id: 'L1' }));
}

// ── 2b. the signature freezes once it has been paid against ───────────────
section('B2 — re-sign is gone once money is booked, but a FIRST sign is not');
{
    // Mobile only — the website has no Sign button (and, since commit
    // b060298, no payment UI either).
    const src = MOBILE;
    const resignable = new Function(grab(src, 'loadIsResignable', 'app') + '; return loadIsResignable;')();
    const signable = new Function(
        grab(src, 'loadIsResignable', 'app') + grab(src, 'loadIsSignable', 'app') + '; return loadIsSignable;')();

    const unpaid = { payment: { paid: 0, pending: 500, status: 'unpaid' } };
    const partial = { payment: { paid: 200, pending: 300, status: 'partial' } };
    const paid = { payment: { paid: 500, pending: 0, status: 'paid' } };
    const signed = { seller_signature: 'data:image/png;base64,AAA' };

    ck('an unpaid signed load can still be re-signed', signable({ ...signed, ...unpaid }));
    ck('a PARTIALLY paid signed load cannot', !signable({ ...signed, ...partial }));
    ck('a FULLY paid signed load cannot', !signable({ ...signed, ...paid }));

    // THE DISTINCTION SHE CHOSE. Payment by transfer routinely lands before
    // the seller is back with a pen; blocking the first signature would leave
    // that load permanently unsignable.
    ck('a paid but NEVER-signed load can still be signed', signable({ ...paid }),
       'adding a missing signature is not the same act as replacing one');
    ck('  ...and partially paid too', signable({ ...partial }));
    ck('an unsigned unpaid load can be signed', signable({ ...unpaid }));

    // Keyed off `paid`, so money on an unpriced load counts — same reasoning
    // as loadIsDeletable.
    ck('money on an unpriced load freezes the signature too',
       !signable({ ...signed, payment: { paid: 250, total: null, pending: null, status: 'paid_amount_unknown' } }));
    ck('the predicate itself ignores whether it is signed', !resignable(partial) && resignable(unpaid));

    // The card must actually consult it, and must still SAY it is signed —
    // dropping the button silently would read as "never signed".
    const card = grab(src, 'loadCardHtml', 'app');
    ck('the card gates the Sign button on loadIsSignable', /loadIsSignable\(l\)[\s\S]{0,400}btn-sign-load/.test(card));
    ck('  and a frozen signature still shows as signed', /✓ Signed<\/span>/.test(card),
       'a signed+paid load that shows nothing is indistinguishable from an unsigned one');

    // The endpoint is untouched, exactly as with Delete and Pay.
    const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    ck('POST /api/loads/:id/signature still exists', /app\.post\('\/api\/loads\/:id\/signature'/.test(api));
    // The reason the rule exists at all: signing REBUILDS the documents.
    ck('signing still regenerates the ticket and receipt', /generateAndStoreLoadPdfs\(signed/.test(api),
       'if this ever stops being true, the whole justification for freezing re-sign changes');
}

// ── 3. the card actually consults them ────────────────────────────────────
section('C — the card wires the rules, it does not just define them');
{
    // The predicates being right is worth nothing if loadCardHtml renders the
    // button unconditionally anyway. This is the exact gap that let a dead
    // voice feature pass its own test suite.
    const mCard = grab(MOBILE, 'loadCardHtml', 'app');
    const dCard = grab(DASH, 'loadCardHtml', 'website');

    ck('app: Delete is behind loadIsDeletable', /loadIsDeletable\(l\)\s*\?[\s\S]{0,240}btn-delete-load/.test(mCard));
    ck('app: Pay is behind loadIsPayable', /loadIsPayable\(l\)\s*\?[\s\S]{0,240}btn-pay-load/.test(mCard));
    ck('website: Delete is behind loadIsDeletable', /loadIsDeletable\(l\)\s*\?[\s\S]{0,240}btn-delete-load/.test(dCard));
    // Edit must NOT be gated — a paid load with a typo in the seller name
    // still has to be correctable. Only the destructive action is withheld.
    ck('app: Edit is still unconditional', /<button class="btn btn-edit-load"/.test(mCard));
    ck('website: Edit is still unconditional', /<button class="btn btn-edit-load"/.test(dCard));
}

// ── 4. the server did NOT lose the routes ─────────────────────────────────
section('D — hiding a button is not the same as removing an endpoint');
{
    const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    // Deliberate: the UI guard stops a mistake, the route stays because
    // removing it is a breaking API change and because the yard assistant,
    // the tests and any older installed APK all still call it.
    ck('DELETE /api/loads/:id still exists', /app\.delete\('\/api\/loads\/:id'/.test(api));
    ck('POST /api/payments still exists', /app\.post\('\/api\/payments'/.test(api));
    // And the clients read the SERVER's arithmetic rather than doing their
    // own, so a card cannot disagree with a ticket about what is settled.
    ck('/api/loads attaches the server-computed payment summary',
       /payment: paymentSummary\(l\.id, l\.amount\)/.test(api));
}

// ── 5. a search result is a flat list, not date sections ──────────────────
section('E — filtering by seller does not group by date');
for (const [label, src] of [['app', MOBILE], ['website', DASH]]) {
    // loadDeckSectionsHtml calls loadCardHtml and esc; both are stubbed so
    // this tests the GROUPING decision, which is what changed, rather than
    // re-testing card markup that section C already covers.
    const fn = new Function(
        'loadCardHtml', 'esc', 'groupLoadsByDate',
        grab(src, 'loadDeckSectionsHtml', label) + '; return loadDeckSectionsHtml;'
    )(
        (l) => `<card id="${l.id}">`,
        (s) => String(s),
        new Function(grab(src, 'groupLoadsByDate', label) + grab(src, 'formatLoadDateHeading', label) + '; return groupLoadsByDate;')()
    );

    const rows = [
        { id: 'A', date: '2026-08-30', seller: 'Acme' },
        { id: 'B', date: '2026-08-28', seller: 'Acme' },
        { id: 'C', date: '2026-08-30', seller: 'Acme' },
    ];

    const grouped = fn(rows, 'none', undefined);
    const flat = fn(rows, 'none', { flat: true });

    ck(`${label}: the plain deck still groups by date`, /<details/.test(grouped) && /load-date-heading/.test(grouped));
    ck(`${label}: a filtered deck has no date sections`, !/<details/.test(flat) && !/load-date-heading/.test(flat));
    ck(`${label}: and it is one grid`, (flat.match(/load-deck-grid/g) || []).length === 1);
    ck(`${label}: with every match visible`, ['A', 'B', 'C'].every((id) => flat.includes(`id="${id}"`)));

    // THE POINT OF THE CHANGE. Only the first <details> renders open, so
    // grouping a 3-result search across 2 days hid one of them behind a
    // collapsed triangle. If this ever regresses, results go missing again.
    ck(`${label}: grouping would have hidden a match, flat does not`,
       (grouped.match(/<details/g) || []).length === 2 && (grouped.match(/open/g) || []).length === 1);

    // Newest first, undated last — the same ordering the groups produced,
    // just without the headings, so the flat view is not a random shuffle.
    const ordered = fn(
        [{ id: 'old', date: '2026-01-01' }, { id: 'none' }, { id: 'new', date: '2026-08-30' }],
        'none', { flat: true });
    ck(`${label}: flat results are newest first, undated last`,
       ordered.indexOf('id="new"') < ordered.indexOf('id="old"')
       && ordered.indexOf('id="old"') < ordered.indexOf('id="none"'));

    ck(`${label}: an empty filtered deck still says so`, /none/.test(fn([], 'none', { flat: true })));

    // Clearing the box must bring the date sections BACK. Passing flat once
    // and never unsetting it would leave the grouping gone for the rest of
    // the session — a plausible bug, so it gets an assertion.
    // Rewritten 2026-09-02: the wiring gained an item-type dropdown, so the
    // flat/grouped decision is now driven by EITHER filter rather than by the
    // search text alone. The property being protected is unchanged — clearing
    // everything has to bring the date sections back — so the assertion
    // follows the code rather than being deleted with it.
    ck(`${label}: the deck goes flat while EITHER filter is on`, /flat: narrowed/.test(src));
    ck(`${label}:   and 'narrowed' is false only when both are empty`,
       /const narrowed = !!q \|\| !!loadItemFilterValue;/.test(src),
       'if this ever became "always true", the date grouping would be gone for good');
}

// ── 6. the amount is on the card ──────────────────────────────────────────
section('F — invoice amount sits with gross / tare / net');
for (const [label, src] of [['app', MOBILE], ['website', DASH]]) {
    const card = grab(src, 'loadCardHtml', label);
    const block = /Gross weight:[\s\S]*?<\/div>/.exec(card);
    ck(`${label}: the weights block is still findable`, !!block);
    if (!block) continue;

    // Anchored on the '>' that opens the span, not a bare /Amount:/ — the
    // loose version matched "XAmount:" and passed against a deliberately
    // broken build when this test was verified. An assertion that survives
    // the mutation it was written to catch is not an assertion.
    ck(`${label}: Amount is in the SAME block as the weights`, />Amount: /.test(block[0]),
       'she asked for it "in grid box in addition to gross,tare,net" — not in a box of its own');
    ck(`${label}: it uses the shared formatter`, /fmtAmount\(l\.amount\)/.test(block[0]),
       'a local formatter here is how the payment badge once lost its $');
    // $0.00 and "not priced yet" are different claims. A load whose items
    // have no price is not a load worth nothing.
    ck(`${label}: an unpriced load shows a dash, not $0.00`,
       /l\.amount != null && fmtAmount\(l\.amount\) \? esc\(fmtAmount\(l\.amount\)\) : '—'/.test(block[0]));
    ck(`${label}: the weights are all still there`,
       /Gross weight:/.test(block[0]) && /Tare weight:/.test(block[0]) && /Net weight:/.test(block[0]));
}

// ── 7. filtering the deck by what is ON the load ──────────────────────────
// Apsara, 2026-09-02: "in load tab also, i should filter by item detail."
section('G — search and filter reach the item rows, not just the load');
for (const [label, src] of [['app', MOBILE], ['website', DASH]]) {
    const filter = new Function(grab(src, 'filterLoads', label) + '; return filterLoads;')();
    const types = new Function(grab(src, 'loadItemTypes', label) + '; return loadItemTypes;')();

    const LOADS = [
        { id: 'L1', date: '2026-08-10', seller: 'Acme', items: [{ description: 'Sealed Units', price: 0.5 }, { description: 'Copper', price: 2 }] },
        { id: 'L2', date: '2026-09-01', seller: 'Vega', items: [{ description: ' sealed units ', price: 0.55 }] },
        { id: 'L3', date: '2026-09-02', seller: 'Acme', items: [{ description: 'Brass', price: 1 }] },
        { id: 'L4', date: '2026-09-02', seller: 'Zed', items: [] },
    ];
    const ids = (r) => r.map(x => x.id).join(',');

    // THE REPORTED GAP. The haystack never included the items, so searching a
    // material found nothing unless those words happened to be in the load's
    // own description — while Inventory could group by exactly that.
    ck(`${label}: searching a material finds the loads carrying it`, ids(filter(LOADS, 'sealed')) === 'L1,L2',
       'this is what did not work — item descriptions were not in the search at all');
    ck(`${label}: a per-item price is searchable`, ids(filter(LOADS, '0.55')) === 'L2',
       '"which loads did we pay that rate on" is a real question');

    // The dropdown is an EXACT match, and matched the same way Inventory
    // groups — trimmed, case-insensitive — or a load lands under a heading it
    // does not belong to.
    ck(`${label}: the type filter matches exactly`, ids(filter(LOADS, '', 'Sealed Units')) === 'L1,L2');
    ck(`${label}:   ignoring case and space, like the Inventory grouping`,
       ids(filter(LOADS, '', 'sealed units')) === 'L1,L2');
    ck(`${label}:   and does not match on a substring`, ids(filter(LOADS, '', 'Sealed')) === '',
       'a dropdown is an exact choice; loose matching there would be a different feature wearing its clothes');

    ck(`${label}: the two filters combine`, ids(filter(LOADS, 'vega', 'Sealed Units')) === 'L2');
    ck(`${label}: neither filter set returns everything`, ids(filter(LOADS, '', '')) === 'L1,L2,L3,L4');
    ck(`${label}: a load with no items is not matched by a type`,
       !filter(LOADS, '', 'Brass').some(l => l.id === 'L4'));
    ck(`${label}: searching what was already searchable still works`,
       ids(filter(LOADS, 'acme')) === 'L1,L3', 'the seller search must not have regressed');

    // Options come from the deck, so the dropdown cannot offer a material
    // that would return nothing.
    ck(`${label}: the dropdown lists the types actually present`, types(LOADS).join('|') === 'Brass|Copper|Sealed Units');
    ck(`${label}:   de-duplicated case-insensitively`, types(LOADS).filter(t => /sealed/i.test(t)).length === 1);
    ck(`${label}:   and sorted`, types(LOADS)[0] === 'Brass');

    // Wiring: the filter has to survive a repaint, and both controls have to
    // drive the same path.
    ck(`${label}: the selected type survives a tab repaint`, /let loadItemFilterValue = '';/.test(src),
       'losing it on repaint would silently show every load again after generating a PDF');
    ck(`${label}: both controls run the same filter`,
       /searchInput\.addEventListener\('input', applyLoadFilters\)/.test(src)
       && /itemFilter\.addEventListener\('change', applyLoadFilters\)/.test(src));
    ck(`${label}: results go flat while either filter is on`, /flat: narrowed/.test(src));
    ck(`${label}: the placeholder says items are searchable now`,
       /Search by date, seller, item, price, or amount/.test(src),
       'a search box that quietly got broader is one nobody knows to use');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
process.exit(fail ? 1 : 0);
