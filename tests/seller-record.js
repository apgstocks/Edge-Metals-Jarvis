// ── tests/seller-record.js ────────────────────────────────────────────────
// Edge Yard is a California junk dealer / recycler (EDGE TRADING INC, 2453 E
// 25th Street, Los Angeles). helpers/sellerRecord.js reads her yard purchases
// against BPC §21606 and §21608.5 and reports what the record is missing.
//
// ── WHAT THESE CHECKS ARE REALLY DEFENDING ───────────────────────────────
// One thing, in four shapes: this module must never tell her a statutory
// record is complete when it is not.
//
//   1. An unconfirmed reading of the law cannot produce `complete`. Every
//      law ships unverified, so every load reads cannot_say until a NAMED
//      person confirms the statute. The failure being prevented is the stale
//      "agrees with QuickBooks" badge, applied to a criminal statute.
//   2. seller_signature must never satisfy §21606(a)(6). She HAS a
//      signature; it attests to weights and price, not to ownership.
//      Counting it is the single most likely wrong turn in this file and the
//      most dangerous, because it would look like coverage.
//   3. An unrecognised metal name must never be treated as ferrous. Ferrous
//      switches off six requirements including a thumbprint.
//   4. `missing` and `not_captured` must stay distinct. One is fixed by
//      typing, the other by building. Collapsing them turns an actionable
//      report into a shrug.
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const S = require(path.join(ROOT, 'helpers/sellerRecord'));

// Laws confirmed by a person, so the `complete` / `incomplete` half of the
// logic can be reached at all. Nothing in the shipped register looks like
// this, and section A proves that.
const CONFIRMED = () => [
    { id: 'ca-21606', title: '21606', verified_by: 'Apsara', verified_on: '2026-11-07',
      expires_on: '2027-05-06', disputed: false },
    { id: 'ca-21608-5', title: '21608.5', verified_by: 'Apsara', verified_on: '2026-11-07',
      expires_on: '2027-05-06', disputed: false },
];

const aLoad = (over = {}) => ({
    id: 'EY_1', date: '2026-11-02', created_by: 'Bose', seller: 'ABC Metals LLC',
    seller_address: '100 Main St, Los Angeles CA', seller_phone: '3105551212',
    amount: 8000, net_weight: 12000, weight_unit: 'lb',
    items: [{ item: 'Al wheel dirty' }], ...over,
});

const field = (r, id) => r.fields.find((f) => f.id === id);

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — an unconfirmed statute can NEVER read as complete');
// ══════════════════════════════════════════════════════════════════════════
// The doctrine the whole file rests on, taken from helpers/exportRules.js:
// `unknown` is not `clear`, ever, and it is never the fallback.
{
    const laws = S.laws();
    ck('every shipped law is unverified', laws.length > 0 && laws.every((l) => !l.verified_on && !l.verified_by),
       JSON.stringify(laws.map((l) => ({ id: l.id, on: l.verified_on, by: l.verified_by }))));
    ck('  and §21608.5 ships DISPUTED, because its source was twelve years old',
       (laws.find((l) => l.id === 'ca-21608-5') || {}).disputed === true);
    ck('  while §21606 is not disputed — its current text and amending act were both found',
       (laws.find((l) => l.id === 'ca-21606') || {}).disputed === false);
    ck('  and §21606 records that AB 476 amended it, effective 2026-01-01',
       /AB 476/.test((laws.find((l) => l.id === 'ca-21606') || {}).amended || ''),
       'two of its requirements are less than a year old; advice predating it is stale');
    ck('every law carries a source somebody can open',
       laws.every((l) => /^https?:\/\//.test(String(l.source || ''))), JSON.stringify(laws.map((l) => l.source)));

    // THE CENTRAL CHECK. A load with nothing wrong with it still cannot be
    // called complete while the law behind it is unconfirmed.
    const r = S.checkLoad(aLoad());
    ck('a load read against unconfirmed law is cannot_say', r.outcome === 'cannot_say', r.outcome);
    ck('  and it names which rules nobody has confirmed',
       r.unverified.length === 2 && r.unverified.some((u) => u.why === 'never_verified')
       && r.unverified.some((u) => u.why === 'disputed'),
       JSON.stringify(r.unverified.map((u) => u.law + ':' + u.why)));

    // And the stronger version: even a load where EVERY field is present
    // stays cannot_say. Proven by stubbing the requirements down to ones
    // that are satisfied, so nothing but the law's status can be the cause.
    const allPresent = [{ id: 'date', cite: 'x', what: 'date', law: 'ca-21606',
        read: (l) => ({ verdict: 'present', value: l.date }) }];
    const perfect = S.checkLoad(aLoad(), { requirements: allPresent });
    ck('a load with NO gaps at all is still cannot_say under unconfirmed law',
       perfect.outcome === 'cannot_say'
       && perfect.fields.every((f) => f.verdict === 'present'), JSON.stringify(perfect.outcome));
    ck('  and the same load IS complete once a person confirms the law',
       S.checkLoad(aLoad(), { requirements: allPresent, lawRows: CONFIRMED() }).outcome === 'complete');

    // Confirmed but STALE is not confirmed. Shared with exportRules.statusOf
    // deliberately, so the staleness doctrine cannot drift apart.
    const stale = CONFIRMED().map((l) => ({ ...l, verified_on: '2025-01-01', expires_on: '2025-07-01' }));
    ck('a confirmation that has expired stops counting',
       S.checkLoad(aLoad(), { requirements: allPresent, lawRows: stale }).outcome === 'cannot_say');
}

// ══════════════════════════════════════════════════════════════════════════
section('B — the signature she HAS does not sign what §21606(a)(6) asks');
// ══════════════════════════════════════════════════════════════════════════
// §21606(a)(6) wants a signed statement that the seller OWNS the metal, or
// names who they got it from. loads.js has seller_signature — and resets it
// whenever the weights or price change, which is the tell: it is a signature
// about figures. Counting it here would put a tick on a declaration that was
// never made, on a record whose falsity is a misdemeanour under (b).
{
    const signed = aLoad({ seller_signature: 'data:image/png;base64,AAAA',
        seller_signed_at: '2026-11-02T19:00:00Z' });
    const r = S.checkLoad(signed, { lawRows: CONFIRMED() });
    const own = field(r, 'ownership_statement');
    ck('a signed ticket does NOT satisfy the ownership statement',
       own && own.verdict === 'not_captured', JSON.stringify(own));
    ck('  and the row says what has to be built: wording on the ticket',
       /ownership declaration/i.test(String(own.needs)), String(own.needs));
    ck('  and the note explains why the existing signature was not counted',
       /weights and the price/i.test(String(own.note)), 'the next person will be tempted');

    // A signed load is therefore not complete, which is the point.
    ck('so a fully signed load is still incomplete', r.outcome === 'incomplete', r.outcome);
}

// ══════════════════════════════════════════════════════════════════════════
section('C — an unrecognised metal is never assumed ferrous');
// ══════════════════════════════════════════════════════════════════════════
// §21608.5 applies to copper, copper alloys, stainless steel and aluminium.
// Guessing ferrous would silently drop six requirements, the thumbprint among
// them. So unknown means in scope, and says it is a guess.
{
    ck('aluminium wheels are nonferrous', S.materialClass(aLoad()).kind === 'nonferrous');
    ck('  so is copper', S.materialClass(aLoad({ items: [{ item: 'Copper 2' }] })).kind === 'nonferrous');
    ck('  and stainless, without "steel" deciding it',
       S.materialClass(aLoad({ items: [{ item: 'SS 304' }] })).kind === 'nonferrous');

    const odd = S.materialClass(aLoad({ items: [{ item: 'mixed yard sweepings' }] }));
    ck('an unrecognised name is UNKNOWN, not ferrous', odd.kind === 'unknown', odd.kind);
    ck('  and says plainly that it is not being assumed ferrous',
       /NOT assumed to be ferrous/.test(odd.why), odd.why);

    // The consequence, which is the thing that matters.
    const r = S.checkLoad(aLoad({ items: [{ item: 'mixed yard sweepings' }] }), { lawRows: CONFIRMED() });
    ck('an unknown metal still gets the nonferrous requirements',
       r.nonferrous_in_scope === true && !!field(r, 'nf_thumbprint'),
       'dropping them on a guess is how a thumbprint requirement disappears');

    const none = S.materialClass({ items: [] });
    ck('a load with no item name at all is unknown, not ferrous', none.kind === 'unknown');
}

// ══════════════════════════════════════════════════════════════════════════
section('D — "nobody can type this" is a different finding from "empty"');
// ══════════════════════════════════════════════════════════════════════════
{
    const r = S.checkLoad(aLoad({ created_by: 'unknown' }), { lawRows: CONFIRMED() });

    const emp = field(r, 'employee');
    ck('created_by of the literal string "unknown" counts as MISSING',
       emp.verdict === 'missing', JSON.stringify(emp));
    ck('  but a real name counts as present',
       field(S.checkLoad(aLoad({ created_by: 'Bose' }), { lawRows: CONFIRMED() }), 'employee')
           .verdict === 'present');

    for (const id of ['seller_id', 'vehicle', 'time', 'marks', 'serials', 'nf_thumbprint']) {
        const f = field(r, id);
        ck(`${id} is not_captured — there is no field for it`, f && f.verdict === 'not_captured',
           JSON.stringify(f && f.verdict));
        ck(`  and it says what would have to be built`, f && !!f.needs, JSON.stringify(f && f.needs));
    }

    // The TIME row is the one most likely to be "fixed" wrongly, by handing
    // over created_at. That is the save moment, not the transaction.
    const t = field(r, 'time');
    ck('the TIME row refuses to offer created_at as the transaction time',
       /SAVED/.test(String(t.note)), String(t.note));
    ck('  and records that AB 476 added it this year', /AB 476/.test(String(t.note)));
}

// ══════════════════════════════════════════════════════════════════════════
section('E — the scale photographs are offered WITH their caveat');
// ══════════════════════════════════════════════════════════════════════════
// §21608.5(a)(4) wants a clear photograph of the material. She photographs
// every weighing. Whether a weighbridge shot is that photograph is a
// judgement about evidence, and the module is not entitled to make it
// silently in either direction.
{
    const withPhotos = aLoad({ items: [{ item: 'Al wheel dirty',
        gross_photo_link: 'https://drive/g', tare_photo_link: 'https://drive/t' }] });
    const f = field(S.checkLoad(withPhotos, { lawRows: CONFIRMED() }), 'nf_material_photo');
    ck('weight photos are reported as present', f.verdict === 'present', JSON.stringify(f));
    ck('  but never without the caveat', /judgement about evidence/i.test(String(f.caveat)), String(f.caveat));
    ck('  and the caveat survives into the aggregated report',
       /judgement about evidence/i.test(String((S.report({ loads: [withPhotos], lawRows: CONFIRMED() })
           .gaps.find((g) => g.id === 'nf_material_photo') || {}).caveat)));

    const noPhotos = field(S.checkLoad(aLoad(), { lawRows: CONFIRMED() }), 'nf_material_photo');
    ck('a load with no weight photos has nothing to offer at all',
       noPhotos.verdict === 'not_captured', JSON.stringify(noPhotos));
}

// ══════════════════════════════════════════════════════════════════════════
section('F — §21608.5(c): the exemption that decides what gets built');
// ══════════════════════════════════════════════════════════════════════════
// If the yard holds a business seller's name, address, phone, business
// licence or tax ID, AND a copy of the delivering driver's licence, §21608.5
// does not apply to that transaction at all. Three of the five are already
// captured. The report must say which two are not, by name, because two
// fields replacing five builds — one of them biometric — is the decision
// this whole exercise exists to put in front of her.
{
    const f = field(S.checkLoad(aLoad(), { lawRows: CONFIRMED() }), 'nf_business_exemption');
    ck('the exemption row reports what is ALREADY on file',
       /business name/.test(String(f.value)) && /physical business address/.test(String(f.value))
       && /business telephone/.test(String(f.value)), String(f.value));
    ck('  and names the two things that are not, specifically',
       /tax ID/i.test(String(f.needs)) && /driver/i.test(String(f.needs)), String(f.needs));
    ck('  and says the exemption is the thing to settle first',
       /HIGHEST-LEVERAGE/.test(String(f.note)), String(f.note));

    // A seller with no address on file has one FEWER of the five, and the
    // row must notice rather than printing the same sentence regardless.
    const bare = field(S.checkLoad(aLoad({ seller_address: '', seller_phone: '' }),
        { lawRows: CONFIRMED() }), 'nf_business_exemption');
    ck('a seller with no address or phone is reported as further from the exemption',
       /physical business address/.test(String(bare.needs))
       && /business telephone/.test(String(bare.needs)), String(bare.needs));
    ck('  and it is still not_captured, because two fields do not exist either way',
       bare.verdict === 'not_captured');
}

// ══════════════════════════════════════════════════════════════════════════
section('G — the report groups by FINDING, not by load');
// ══════════════════════════════════════════════════════════════════════════
// Sixty loads each missing the same four fields is one finding. Sixty lines
// of it is a report she stops opening — the rule integritySweepJob states.
{
    const many = [aLoad({ id: 'A' }), aLoad({ id: 'B' }), aLoad({ id: 'C' })];
    const r = S.report({ loads: many, lawRows: CONFIRMED() });
    ck('three loads produce ONE row per requirement',
       r.gaps.filter((g) => g.id === 'seller_id').length === 1, String(r.gaps.length));
    ck('  carrying the count of loads affected',
       (r.gaps.find((g) => g.id === 'seller_id') || {}).not_captured === 3);
    ck('the two asks are separated: buildable vs typeable',
       r.buildable.every((g) => g.not_captured > 0) && r.typeable.every((g) => g.missing > 0 && g.not_captured === 0),
       JSON.stringify({ b: r.buildable.map((g) => g.id), t: r.typeable.map((g) => g.id) }));
    ck('  and the biggest build gap sorts first', r.buildable.length > 0
       && r.buildable[0].not_captured >= r.buildable[r.buildable.length - 1].not_captured);

    // Headline honesty, both ways.
    ck('with unconfirmed law the headline says NONE can be called complete',
       /NONE can be called complete/.test(S.report({ loads: many }).headline),
       S.report({ loads: many }).headline);
    ck('  and an empty period says so rather than reporting zero problems',
       /No yard purchases/.test(S.report({ loads: [], lawRows: CONFIRMED() }).headline));
    ck('  an empty period still surfaces the unconfirmed register',
       S.report({ loads: [] }).unverified.length === 2,
       'with no loads there is nothing to hang a law status on, so it is read directly');

    // The date window must actually filter.
    const windowed = S.report({ loads: [aLoad({ id: 'in', date: '2026-11-02' }),
        aLoad({ id: 'out', date: '2026-03-01' })], from: '2026-10-01', to: '2026-11-30',
        lawRows: CONFIRMED() });
    ck('the period filters loads out', windowed.loads === 1, String(windowed.loads));
}

// ══════════════════════════════════════════════════════════════════════════
section('H — it writes nothing, and it blocks nothing');
// ══════════════════════════════════════════════════════════════════════════
// CLAUDE.md, three separate incidents: a requirement added to shared code
// reaches callers nobody was looking at, and twice that caller has been the
// voice path, which has no form to put a field on. So this module must not
// be anywhere near the save path, and the test says so about the SOURCE
// rather than hoping.
{
    const fs = require('fs');
    const src = fs.readFileSync(path.join(ROOT, 'helpers/sellerRecord.js'), 'utf8');
    // ── FIRST WRITTEN AS A WORD SEARCH, WHICH MATCHED ITS OWN COMMENT ────
    // The first version grepped for /addLoad|editLoad/ and went red on a
    // sentence in sellerRecord.js's own header explaining that it is NOT
    // wired into addLoad. A check that cannot tell an explanation from a
    // call is not testing the thing its name claims. The property is about
    // the DEPENDENCY, so ask the module registry: a module that never
    // required loads.js cannot write a load, whatever words it contains.
    ck('sellerRecord does not require loads.js at all',
       !/require\(['"]\.\/loads['"]\)/.test(src), 'it reads the store file directly, read-only');
    ck('  and the only store it opens is LOADS_FILE, through loadJson',
       (src.match(/loadJson\(/g) || []).length === 2
       && /loadJson\(cfg\.LOADS_FILE/.test(src),
       'two reads: the law register and the loads');
    ck('  its only writer is verify(), which records a HUMAN confirmation',
       (src.match(/mutateJson\(/g) || []).length === 1, 'one writer, and it writes the register');

    const loads = fs.readFileSync(path.join(ROOT, 'helpers/loads.js'), 'utf8');
    ck('loads.js does not require sellerRecord — nothing new can refuse a save',
       !/sellerRecord/.test(loads), 'a statutory field that stops her recording real work is worse than a gap');
    const tools = fs.readFileSync(path.join(ROOT, 'helpers/tools.js'), 'utf8');
    ck('  and the voice path is likewise untouched', !/sellerRecord/.test(tools),
       'the caller that broke twice before, for exactly this reason');

    // verify() demands a person. A register entry confirmed by nobody is the
    // thing the register exists to prevent.
    // verify() is async, so a synchronous try/catch sees NOTHING — the first
    // version of this check passed `null` into the assertion and failed for
    // the right reason by luck. Await it.
    let threw = null;
    try { await S.verify({ id: 'ca-21606' }); } catch (e) { threw = e.message; }
    ck('verify refuses to record a confirmation with no name on it',
       /who confirmed/.test(String(threw)), String(threw));
    let threw2 = null;
    try { await S.verify({ by: 'Apsara' }); } catch (e) { threw2 = e.message; }
    ck('  and refuses one that does not say WHICH law', /which law/.test(String(threw2)), String(threw2));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})();
