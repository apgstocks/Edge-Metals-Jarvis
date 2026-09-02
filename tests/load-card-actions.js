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
    // This assertion has now followed the code twice in two days: search-only,
    // then either-filter when the dropdown arrived, then search-only again
    // when she asked for the dropdown to go. The PROPERTY has never changed —
    // clearing the box must bring the date sections back — which is why it
    // keeps getting rewritten instead of deleted.
    ck(`${label}: the deck goes flat only while something is typed`, /flat: !!q/.test(src),
       'if this ever became "always true", the date grouping would be gone for good');
    ck(`${label}:   and the query is read from the box each time`,
       /const q = String\(searchInput\.value \|\| ''\)\.trim\(\);/.test(src));
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
// Apsara, 2026-09-02, twice. First: "in load tab also, i should filter by item
// detail" — which produced a search that reached the items PLUS a dropdown of
// the item types present. Then, having seen it: "instead of select option of
// item detail filter, make it as type and match .. add it to search by date,
// seller, item, price."
//
// So the dropdown is gone and there is ONE typed box. These assertions were
// rewritten rather than deleted: the behaviour being protected — that a
// material can be found at all — is unchanged, only the control is.
section('G — one search box, matching the load AND its items');
for (const [label, src] of [['app', MOBILE], ['website', DASH]]) {
    const filter = new Function(grab(src, 'filterLoads', label) + '; return filterLoads;')();

    const LOADS = [
        { id: 'L1', date: '2026-08-10', seller: 'Acme', items: [{ description: 'Sealed Units', price: 0.5 }, { description: 'Copper', price: 2 }] },
        { id: 'L2', date: '2026-09-01', seller: 'Vega', items: [{ description: ' sealed units ', price: 0.55 }] },
        { id: 'L3', date: '2026-09-02', seller: 'Acme', items: [{ description: 'Brass', price: 1 }] },
        { id: 'L4', date: '2026-09-02', seller: 'Zed', items: [] },
    ];
    const ids = (r) => r.map(x => x.id).join(',');

    // THE ORIGINAL GAP. The haystack never included the items, so searching a
    // material found nothing unless those words were in the load's own
    // description — while Inventory could group by exactly that field.
    ck(`${label}: searching a material finds the loads carrying it`, ids(filter(LOADS, 'sealed')) === 'L1,L2',
       'item descriptions were not in the search at all before 2026-09-02');
    ck(`${label}: a per-item price is searchable`, ids(filter(LOADS, '0.55')) === 'L2',
       '"which loads did we pay that rate on" is a real question');

    // TYPE AND MATCH — partial, which is the point of replacing the dropdown.
    // The dropdown demanded the whole name; typing three letters should work.
    ck(`${label}: a partial word matches`, ids(filter(LOADS, 'seal')) === 'L1,L2');
    ck(`${label}: a middle-of-the-word match works too`, ids(filter(LOADS, 'nits')) === 'L1,L2',
       'substring, not prefix — people type the bit they remember');
    ck(`${label}: case does not matter`, ids(filter(LOADS, 'SEALED')) === 'L1,L2');
    ck(`${label}: it matches the trimmed value`, ids(filter(LOADS, 'sealed units')) === 'L1,L2');

    // The four fields she named, in one box.
    ck(`${label}: by date`, ids(filter(LOADS, '2026-08-10')) === 'L1');
    ck(`${label}: by seller`, ids(filter(LOADS, 'acme')) === 'L1,L3');
    ck(`${label}: by item`, ids(filter(LOADS, 'brass')) === 'L3');
    ck(`${label}: by price`, ids(filter(LOADS, '0.5')) === 'L1,L2',
       '0.5 is a substring of 0.55 — a load priced at either is a fair answer to typing "0.5"');

    ck(`${label}: an empty box returns everything`, ids(filter(LOADS, '')) === 'L1,L2,L3,L4');
    ck(`${label}: whitespace counts as empty`, ids(filter(LOADS, '   ')) === 'L1,L2,L3,L4');
    ck(`${label}: no match is empty, not everything`, ids(filter(LOADS, 'titanium')) === '');
    ck(`${label}: a load with no items does not throw`, filter(LOADS, 'brass').length === 1);
    ck(`${label}: a load whose items key is missing does not throw`,
       filter([{ id: 'X', seller: 'Q' }], 'brass').length === 0);

    // ── the dropdown is really gone ───────────────────────────────────────
    // Not just unused — removed. A hidden <select> still in the markup would
    // be dead weight that the next person has to work out the status of.
    ck(`${label}: no item-type <select> remains`, !/id="loadItemFilter"/.test(src));
    ck(`${label}: and its helpers went with it`,
       !/function loadItemTypes\(/.test(src) && !/loadItemFilterValue/.test(src),
       'leaving them would be dead code that looks load-bearing');
    ck(`${label}: filterLoads takes just the query now`,
       /function filterLoads\(loads, query\) \{/.test(src),
       'an unused third parameter is a promise the function no longer keeps');

    // Item WEIGHTS stay out, deliberately.
    const weighted = [{ id: 'W1', seller: 'A', items: [{ description: 'Copper', price: 1, net_weight: 300, gross_weight: 300 }] }];
    ck(`${label}: an item weight is not searchable`, filter(weighted, '300').length === 0,
       'a weight of 300 would make every load with a 300 anywhere in it match');

    ck(`${label}: the placeholder names what it searches`,
       /Search by date, seller, item, price…/.test(src),
       'a box that quietly got broader is one nobody knows to use');
    ck(`${label}: results go flat while something is typed`, /flat: !!q/.test(src));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
process.exit(fail ? 1 : 0);
