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
    // ── stated as a PROPERTY, not as today's variable name ───────────────
    // This has now chased the code four times in two days: search-only, then
    // either-filter when the dropdown arrived, then search-only when the
    // dropdown went, now either-filter again with the item picker. The thing
    // being protected never changed — the deck is flat while something is
    // narrowing it, and grouped when nothing is — so it is finally written
    // that way instead of matching a literal.
    const narrowedDef = /const narrowed = ([^;]+);/.exec(src);
    ck(`${label}: something decides whether the deck is narrowed`, !!narrowedDef);
    ck(`${label}:   and the flat/grouped choice follows it`, /flat: narrowed/.test(src),
       'if this ever became "always true", the date grouping would be gone for good');
    if (narrowedDef) {
        // Every filter the deck supports must appear in that expression. Add a
        // third filter and forget it here, and the deck silently stays grouped
        // while filtered — hiding most of the answer behind collapsed dates.
        const expr = narrowedDef[1];
        ck(`${label}:   the free-text search counts`, /\bq\b/.test(expr));
        ck(`${label}:   the chosen item counts too`, /chosenItemDetail/.test(expr),
           'a filter missing from this expression leaves the deck grouped while narrowed');
    }
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
    // (the flat/grouped rule is asserted once, in section E, as a property —
    // repeating it here in a second form is how the two drift apart)
}

// ── 8. the explicit "by item detail" filter ───────────────────────────────
// Apsara, 2026-09-02: "when i type sealed units in load detail, its not
// filtering. alternatively you give a check box as by item detail. then give
// text box, as user starts typing, show all matching item detail. once user
// select, show all matching load ticket."
//
// The free-text box above DOES match item descriptions — verified in section G
// — so the report was almost certainly about a build that predates it. But the
// underlying complaint is real and not about a bug: when a search returns
// nothing there is no way to tell "no loads have this" from "the search is not
// looking there". Picking from a list the app itself offers removes that
// doubt, which is why this is worth having alongside the search rather than
// instead of it.
section('H — pick an item from a list, get the loads carrying it');
for (const [label, src] of [['app', MOBILE], ['website', DASH]]) {
    const details = new Function(grab(src, 'itemDetailsInLoads', label) + '; return itemDetailsInLoads;')();
    const withItem = new Function(grab(src, 'loadsWithItem', label) + '; return loadsWithItem;')();

    const LOADS = [
        { id: 'L1', items: [{ description: 'Sealed Units' }, { description: 'Copper' }] },
        { id: 'L2', items: [{ description: ' sealed units ' }] },
        { id: 'L3', items: [{ description: 'Brass' }] },
        { id: 'L4', items: [] },
        { id: 'L5' },
    ];
    const ids = (r) => r.map(x => x.id).join(',');

    ck(`${label}: the list offers each distinct item once`,
       details(LOADS).join('|') === 'Brass|Copper|Sealed Units');
    ck(`${label}:   de-duplicated case- and space-insensitively`,
       details(LOADS).filter(d => /sealed/i.test(d)).length === 1,
       'offering "Sealed Units" and " sealed units " as two choices would be two ways to ask one question');
    ck(`${label}:   sorted, so it can be scanned`, details(LOADS)[0] === 'Brass');
    ck(`${label}:   a load with no items contributes nothing`, !details(LOADS).includes(''));
    ck(`${label}:   and one with no items key does not throw`, details([{ id: 'X' }]).length === 0);

    // EXACT match, the same comparison the Inventory grouping and drill-down
    // use. Anything looser would put a load under a material it does not have.
    ck(`${label}: selecting an item returns the loads carrying it`, ids(withItem(LOADS, 'Sealed Units')) === 'L1,L2');
    ck(`${label}:   matching ignores case and surrounding space`, ids(withItem(LOADS, 'sealed units')) === 'L1,L2');
    ck(`${label}:   but never on a substring`, ids(withItem(LOADS, 'Sealed')) === '',
       'this is a chosen option, not a search — a partial match here would be a different feature');
    ck(`${label}:   an item nothing carries returns nothing, not everything`,
       ids(withItem(LOADS, 'Titanium')) === '');
    ck(`${label}:   no selection returns everything`, withItem(LOADS, '').length === LOADS.length);

    // ── the wiring ────────────────────────────────────────────────────────
    ck(`${label}: there is a checkbox to turn it on`, /id="byItemToggle"/.test(src));
    ck(`${label}:   revealing a text box`, /id="itemFilterInput"/.test(src));
    ck(`${label}:   with a suggestion list`, /id="itemFilterAc"/.test(src));
    ck(`${label}: off by default, so the ordinary case is still one box`,
       /<div id="byItemPanel" class="hidden"/.test(src));

    // Suggestions must come from the DECK. Offering a material from the full
    // catalogue that no load carries recreates the exact ambiguity — you pick
    // something and get nothing — that this control exists to remove.
    ck(`${label}: suggestions are built from the loads on screen`,
       /itemDetailsInLoads\(loadsCache\)/.test(src),
       'offering a material with no loads behind it can only ever answer "nothing found"');
    ck(`${label}:   each suggestion says how many loads it has`,
       /loadsWithItem\(loadsCache, d\)\.length/.test(src),
       'a zero is then visible before you pick it, not after');
    ck(`${label}: an empty box offers the whole list`, /const matches = q \? all\.filter/.test(src),
       'someone who does not remember the exact wording needs a way in');
    ck(`${label}: no match says so rather than showing an empty menu`,
       /No item matches/.test(src));

    // Selection state has to survive a repaint, and must never outlive the
    // control that set it.
    ck(`${label}: the choice survives a tab repaint`, /let chosenItemDetail = '';/.test(src),
       'losing it after generating a PDF would show every load again — which reads as the filter not working');
    ck(`${label}: unticking the box clears the filter`,
       /chosenItemDetail = '';\s*\n\s*itemInput\.value = '';/.test(src),
       'a filtered deck with its control hidden is the worst of both');
    ck(`${label}: typing past the chosen item drops the selection`,
       /if \(chosenItemDetail && itemInput\.value\.trim\(\)\.toLowerCase\(\) !== chosenItemDetail\.toLowerCase\(\)\)/.test(src),
       'the deck must never be filtered by something the box no longer says');
    ck(`${label}: what is showing, and how many, is stated on screen`,
       /Showing <strong[^>]*>\$\{esc\(chosenItemDetail\)\}<\/strong> — \$\{rows\.length\} load/.test(src),
       'a genuine zero has to be unmistakable — that ambiguity is the whole reason this exists');
    ck(`${label}: picking uses mousedown, not click`, /el\.addEventListener\('mousedown'/.test(src),
       'blur fires first on a click and closes the menu before the click lands');
    ck(`${label}: both controls repaint through ONE function`,
       (src.match(/searchInput\.addEventListener\('input', repaintDeck\)/g) || []).length === 1
       && /const repaintDeck = \(\) => \{/.test(src),
       'two render paths is how they end up disagreeing about what is on screen');
    ck(`${label}: search and item filter compose`,
       /let rows = filterLoads\(loadsCache, q\);\s*\n\s*if \(chosenItemDetail\) rows = loadsWithItem\(rows, chosenItemDetail\);/.test(src));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
process.exit(fail ? 1 : 0);
