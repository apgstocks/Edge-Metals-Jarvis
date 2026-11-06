// ── tests/name-cleanup.js ─────────────────────────────────────────────────
// Apsara, 2026-09-19, after importing the Shipments workbook: "There are like
// calderon CALDERON,upper case,Space issue like EDGE YARD,EDGEYARD ,MODern
// modern enterprises getting treated as diff suppliers in bills. make jarvis
// work on that and fix this."
//
// ── THE THREE CASES ARE NOT ONE PROBLEM ─────────────────────────────────────
// Case and spacing are a rule. "MODern" against "modern enterprises" is not —
// those are different strings, and helpers/nameMatch.js refuses fuzzy matching
// on purpose: "a near-miss is a wrong answer with a confident face", and here
// a near-miss means paying the wrong company. So the third case is a QUESTION,
// and the sharpest checks in this file are the ones asserting it stays one.
//
// ── AND THE ONE THAT MUST NEVER HAPPEN ──────────────────────────────────────
// Edge Yard and Edge Metals are different companies. That separation is most
// of what this app is for, and "EDGE YARD" appearing as a supplier in Edge
// Metals' bills is a real counterparty, not a typo.
//
// ── WHY THE STORES MOVE TOGETHER ────────────────────────────────────────────
// A payment records WHO WAS PAID by name — supplierAccount.js and
// billPayments.js both compare supplier strings. Rewriting bills.json alone
// would leave every existing payment matching nothing, and the balance on a
// supplier she has already paid would jump back to the full invoice amount.
// Section C is that check, and it is the reason this file is long.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-supmerge-'));
process.env.JARVIS_TEST = '1';
process.env.ADMIN_PASSWORD = 'admin-pw-ggggggggggg';
process.env.JARVIS_PASSWORD = 'jarvis-pw-hhhhhhhhhh';

const ROOT = path.join(__dirname, '..');
const nc = require(path.join(ROOT, 'helpers/nameCleanup'));
// Every call is field-scoped now; `sm` keeps the supplier-shaped checks below
// reading the way they did when supplier was the only field there was.
const sm = {
    clusters: () => nc.clusters('supplier'),
    proposals: () => nc.proposals('supplier'),
    plan: (o) => nc.plan('supplier', o),
    apply: (p2) => nc.apply(p2),
    undo: (id) => nc.undo(id),
    merges: () => nc.merges(),
    addAlias: (f, t, by) => nc.addAlias('supplier', f, t, by),
    removeAlias: (f) => nc.removeAlias('supplier', f),
};
const bills = require(path.join(ROOT, 'helpers/bills'));
const bp = require(path.join(ROOT, 'helpers/billPayments'));
const supplierAccount = require(path.join(ROOT, 'helpers/supplierAccount'));

const addBill = (supplier, bk) => bills.addBill({
    date: '09/10/2026', supplier, carrier: 'MSC', booking_no: bk,
    container_no: bk + 'U1111111', route: 'HOUSTON / BUSAN',
    gross: 44000, truck: 15000, container: 8000, chassis: 6000, boxes: 500,
    supplier_price: 0.32, price_unit: 'lb' });

(async () => {

// Her three cases as she reported them, plus Edge Metals — which must never
// be drawn into Edge Yard.
const FIXTURE = [
    ['calderon', 'B1'], ['CALDERON', 'B2'], ['CALDERON', 'B3'],
    // TWO of "EDGE YARD" deliberately. With one each it is a genuine tie and
    // the winner comes down to which bill was saved a millisecond later —
    // correct behaviour, but a test asserting a NAME on it is flaky, and it
    // was: three runs in five. Frequency is the rule; the tie-break is tested
    // on its own below, for determinism rather than for a particular name.
    ['EDGE YARD', 'B4'], ['EDGEYARD', 'B5'], ['EDGE YARD', 'B10'],
    ['MODern', 'B6'], ['modern enterprises', 'B7'], ['modern enterprises', 'B8'],
    ['Edge Metals', 'B9'],
];
const made = [];
for (const [s, b] of FIXTURE) made.push(await addBill(s, b));

// ── A. WHAT THE RULE CAN JOIN ───────────────────────────────────────────────
section('A. case and spacing');
{
    const cs = sm.clusters();
    const byWinner = Object.fromEntries(cs.map((c) => [c.winner, c.losers.map((l) => l.name).sort()]));

    ck('calderon and CALDERON are one supplier',
       JSON.stringify(byWinner['CALDERON']) === JSON.stringify(['calderon']), JSON.stringify(byWinner));
    ck('  and the spelling she uses MOST wins',
       !!byWinner['CALDERON'], 'CALDERON appears twice, calderon once');
    ck('EDGE YARD and EDGEYARD are one supplier',
       JSON.stringify(byWinner['EDGE YARD']) === JSON.stringify(['EDGEYARD']), JSON.stringify(byWinner));

    // ── NOT TITLE-CASED ─────────────────────────────────────────────────
    // The obvious move is to capitalise on the way in, and it is wrong: "MK
    // Metal Trading", "d.c. scrap", "JB's" are real company names. Nothing is
    // invented — a spelling SHE established wins. See canonicalName.js.
    ck('  no name is invented — the winner is one she already typed',
       cs.every((c) => c.names.some((x) => x.name === c.winner)),
       cs.map((c) => c.winner).join(', '));

    ck('a supplier with one spelling is not listed at all',
       !cs.some((c) => c.key === 'edgemetals'), 'nothing to fix is not a cluster');

    // ── A TRUE TIE STILL HAS TO GIVE THE SAME ANSWER TWICE ──────────────
    // Not "which name" — with equal use either is defensible. But the answer
    // must not change between two reads of the same data, or the preview
    // names one spelling and the merge writes the other.
    const a1 = sm.clusters().map((c) => c.winner).join('|');
    const a2 = sm.clusters().map((c) => c.winner).join('|');
    const a3 = sm.clusters().map((c) => c.winner).join('|');
    ck('  and the answer is the same every time it is asked',
       a1 === a2 && a2 === a3, `${a1} / ${a2} / ${a3}`);
}

// ── B. WHAT NO RULE MAY DECIDE ──────────────────────────────────────────────
section('B. MODern is a question, not a merge');
{
    const cs = sm.clusters();
    ck('MODern is NOT silently merged into modern enterprises',
       !cs.some((c) => c.losers.some((l) => l.name === 'MODern') || c.winner === 'MODern'),
       JSON.stringify(cs.map((c) => [c.winner, c.losers.map((l) => l.name)])));

    const ps = sm.proposals();
    const one = ps.find((p) => p.shorter === 'MODern');
    ck('  it is PROPOSED instead', !!one, JSON.stringify(ps));
    ck('  as a question, in her words', one && /Is "MODern" .* the same supplier as "modern enterprises"/.test(one.question),
       one && one.question);
    ck('  with how many rows each name has, so she can judge',
       one && one.shorter_uses === 1 && one.longer_uses === 2,
       one && `${one.shorter_uses}/${one.longer_uses}`);

    // ── AND NOTHING ELSE IS PROPOSED ────────────────────────────────────
    // A panel of twenty guesses is a panel she stops reading. Prefix only,
    // four characters minimum — "Edge Metals" and "EDGE YARD" share a prefix
    // in English but not in normalised form, so they are not offered.
    ck('  and Edge Metals is not offered as a match for anything',
       !ps.some((p) => /edge/i.test(p.shorter) || /edge/i.test(p.longer)),
       JSON.stringify(ps.map((p) => [p.shorter, p.longer])));

    // ── HER ANSWER IS WHAT MERGES THEM ──────────────────────────────────
    await sm.addAlias('MODern', 'modern enterprises', 'test');
    const after = sm.clusters();
    const modern = after.find((c) => c.winner === 'modern enterprises');
    ck('once she answers, they ARE one supplier',
       !!modern && modern.losers.some((l) => l.name === 'MODern'),
       JSON.stringify(after.map((c) => [c.winner, c.losers.map((l) => l.name)])));
    ck('  and her answer beats the vote',
       modern && modern.confirmed === true, 'she said which name is right; frequency does not get to disagree');
    ck('  and it is not asked again', !sm.proposals().some((p) => p.shorter === 'MODern'));

    let err = null;
    try { await sm.addAlias('calderon', 'CALDERON'); } catch (e) { err = e; }
    ck('  an alias between two spellings of one name is refused as pointless',
       !!err && /already the same name/.test(err.message), err && err.message);
}

// ── C. THE STORES MOVE TOGETHER ─────────────────────────────────────────────
// The check this whole file exists for.
section('C. bills and payments, or the balances break');
{
    // A payment recorded against the LOWER-CASE spelling, which is how this
    // goes wrong in real life: she paid Calderon before anyone noticed the
    // ledger held two of him.
    const target = made.find((b) => b.supplier === 'calderon');
    await bp.addBillPayment({ date: '09/12/2026', amount: 500, mode: 'Wire', bank: 'Chase',
                              supplier: 'calderon', paid_via: 'Edge Metals',
                              allocations: [{ bill_id: target.id, amount: 500 }] });

    // supplierAccount.rows() is what the Supplier account screen reads, and it
    // matches on the NAME — which is the whole hazard this section is about.
    const creditRows = (who) => supplierAccount.rows(who).filter((r) => (r.credit || 0) > 0);
    ck('before the merge, the payment is attached to the old spelling',
       creditRows('calderon').length === 1, JSON.stringify(creditRows('calderon')));

    // ── A PAYMENT DOES NOT GET A VOTE ON THE SPELLING ───────────────────
    // The real bug this section found. "calderon" had 1 bill; "CALDERON" had
    // 2. Adding a payment against "calderon" made it 2-2 on raw counts, and
    // the merge renamed CALDERON → calderon on every bill — backwards.
    //
    // A payment INHERITS whatever spelling was current when it was written;
    // it is not a second decision. Only the bills she types and the supplier
    // list she keeps get a say.
    ck('the payment did NOT flip which spelling wins',
       sm.clusters().find((c) => c.key === 'calderon').winner === 'CALDERON',
       sm.clusters().find((c) => c.key === 'calderon').winner
       + ' — an inherited row voted, and outvoted the bills');

    const planned = sm.plan();
    ck('the plan covers BOTH stores, not just bills',
       planned.byStore.bills > 0 && planned.byStore.payments > 0, JSON.stringify(planned.byStore));

    const out = await sm.apply(planned);
    ck('the merge reports what it changed', out.changed === planned.total, `${out.changed} vs ${planned.total}`);

    // ── AND THE MONEY STILL LINES UP ────────────────────────────────────
    // supplierAccount matches supplier by NAME. If bills moved and payments
    // did not, this supplier's balance would jump back to the full invoice
    // amount — a supplier she has already paid, showing as unpaid.
    ck('AFTER the merge the payment is still attached',
       creditRows('CALDERON').length === 1,
       'bills moved and payments did not — every settled supplier would read as unpaid');
    ck('  and the $500 is still the $500',
       creditRows('CALDERON')[0].credit === 500, String(creditRows('CALDERON')[0].credit));
    // ── ASSERTED ON THE STORED STRINGS, NOT ON supplierAccount ──────────
    // supplierAccount.sameSupplier already lowercases, so rows('calderon')
    // and rows('CALDERON') return the same rows whether or not anything was
    // merged — the first version of this check could not fail. Worth knowing
    // in its own right: CASE was never breaking the supplier account, it was
    // breaking the bills table's grouping and its supplier dropdown. SPACING
    // ("EDGE YARD" vs "EDGEYARD") breaks both, because sameSupplier does not
    // strip spaces.
    ck('  and no bill still carries the old spelling',
       !bills.list().some((b) => b.supplier === 'calderon'),
       JSON.stringify([...new Set(bills.list().map((b) => b.supplier))]));
    ck('  nor does the payment',
       !require(path.join(ROOT, 'helpers/billPayments')).list().some((p2) => p2.supplier === 'calderon'));
}

// ── D. EVERY ROW KEEPS ITS ORIGINAL ─────────────────────────────────────────
// She did not ask for this. It is here because "the original spelling is
// gone" is not an acceptable answer on a financial record the day a merge
// turns out to be wrong.
section('D. it can be undone');
{
    // Keyed by FIELD now — a bill has a supplier AND a carrier AND a trucker,
    // and a flat pair would have the second merge overwrite the first's
    // original while still claiming to be undoable.
    const changed = bills.list().filter((b) => b.name_was && b.name_was.supplier);
    ck('changed rows carry the spelling they had', changed.length > 0,
       'nothing recorded what it used to be');
    ck('  and the merge that changed them', changed.every((b) => !!(b.name_merge && b.name_merge.supplier)));
    ck('  while untouched rows carry neither',
       bills.list().filter((b) => b.supplier === 'Edge Metals')
           .every((b) => !(b.name_was && b.name_was.supplier) && !(b.name_merge && b.name_merge.supplier)));

    const merges = sm.merges();
    ck('the merge is listed, so an undo has something to name', merges.length === 1, String(merges.length));

    const restored = await sm.undo(merges[0].merge_id);
    ck('undoing puts every spelling back', restored === merges[0].rows,
       `${restored} restored, ${merges[0].rows} recorded as changed`);
    const names = [...new Set(bills.list().map((b) => b.supplier))].sort();
    ck('  exactly as it was', names.join('|') === ['CALDERON', 'EDGE YARD', 'EDGEYARD', 'Edge Metals', 'MODern', 'calderon', 'modern enterprises'].join('|'),
       names.join('|'));
    ck('  and the markers are gone too',
       bills.list().every((b) => !(b.name_was && b.name_was.supplier)
                                 && !(b.name_merge && b.name_merge.supplier)));
}

// ── E. EDGE YARD IS NOT EDGE METALS ─────────────────────────────────────────
// Said repeatedly and worth a test of its own. Nothing in this file may ever
// bring the two together, by rule or by proposal.
section('E. two companies stay two companies');
{
    const { normalizeName } = require(path.join(ROOT, 'helpers/nameMatch'));
    ck('their normalised names differ',
       normalizeName('Edge Yard') !== normalizeName('Edge Metals'),
       `${normalizeName('Edge Yard')} vs ${normalizeName('Edge Metals')}`);
    ck('  so no cluster contains both',
       !sm.clusters().some((c) => {
           const all = c.names.map((x) => x.name.toLowerCase()).join(' ');
           return /yard/.test(all) && /metals/.test(all);
       }));
    ck('  and neither is proposed as the other',
       !sm.proposals().some((p) => /yard/i.test(p.shorter + p.longer) && /metals/i.test(p.shorter + p.longer)));

    // Edge Yard's own ledger is a different company's books and keys on
    // `seller`, not `supplier`. Nothing here may reach into it.
    const src = fs.readFileSync(path.join(ROOT, 'helpers/nameCleanup.js'), 'utf8');
    // TRUCKER_BILLS_FILE added 2026-09-20. The regex named the two LOAD
    // stores and stopped, so the yard's HAULAGE ledger — the one whose rows
    // carry a company name, and therefore the one a Trucker cleanup would
    // most plausibly be pointed at one day — was the single yard store this
    // guard did not cover. Behaviour was already correct; the test just could
    // not have caught it changing.
    // ── NARROWED 2026-11-07, AND DELIBERATELY ───────────────────────────
    // This was a blanket grep: LOADS_FILE must not appear in nameCleanup.js
    // AT ALL. That was right while the yard was wholly out of scope.
    //
    // Apsara then asked for the yard's own seller names to be cleanable
    // ("clean the names"), because her Bought-from list carried MAZARIEGOES
    // beside MAZARIEGOS. So a `seller` field exists now, and a text search
    // for LOADS_FILE can no longer tell a legitimate yard field from an
    // Edge Metals field reaching across the line.
    //
    // Replaced by a STRUCTURAL check, which is stronger than the grep it
    // replaces: it reads the actual targets of every field rather than the
    // file's text, so it still catches the thing that matters even if the
    // constant is renamed or reached through a variable.
    //
    // THE TWO STORES SHE DID NOT ASK FOR STAY UNTOUCHABLE. Outbound loads
    // (buyers) and trucker bills (haulage) are not part of cleaning seller
    // names, and nothing may quietly grow into them.
    const YARD_ONLY_FOR = 'seller';
    const everyTarget = nc.FIELD_KEYS.flatMap((f) => nc.targetsFor(f).map((t) => ({ f, ...t })));
    ck('no Edge Metals field reaches the yard ledger',
       !everyTarget.some((t) => t.f !== YARD_ONLY_FOR && /loads|drafts/.test(t.key)),
       JSON.stringify(everyTarget.filter((t) => /loads|drafts/.test(t.key)).map((t) => t.f + ':' + t.key)));
    // ── cfg IS REQUIRED HERE, NOT AT THE TOP OF THE FILE ────────────────
    // config.js computes every *_FILE from DATA_DIR AT LOAD TIME. Requiring
    // it before this suite has redirected DATA_DIR pins the REAL paths — and
    // a test suite holding her live filenames is how four rows once landed
    // in the real petty cash. Required here, after the redirect, where it is
    // only ever read.
    const cfgNow = require(path.join(ROOT, 'config'));
    ck('  and NOTHING rewrites outbound loads or trucker bills',
       !everyTarget.some((t) => t.file === cfgNow.OUTBOUND_LOADS_FILE || t.file === cfgNow.TRUCKER_BILLS_FILE),
       'buyers and haulage were not part of what she asked to clean');
}

// ── F. THROUGH THE REAL ROUTES ──────────────────────────────────────────────
section('F. the routes, and who may use them');
{
    const http = require('http');
    const { createApi } = require(path.join(ROOT, 'api'));
    const app = createApi();
    const listener = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${listener.address().port}`;
    const req = (method, p2, { body, sid } = {}) => new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r2 = http.request(base + p2, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
        });
        r2.on('error', reject); if (data) r2.write(data); r2.end();
    });

    const admin = ((await req('POST', '/login', { body: { password: 'admin-pw-ggggggggggg' } })).json || {}).sid;
    const jarvis = ((await req('POST', '/login', { body: { password: 'jarvis-pw-hhhhhhhhhh' } })).json || {}).sid;
    ck('logged in as both profiles', !!admin && !!jarvis);

    const before = bills.list().map((b) => b.supplier).join('|');
    const prev = await req('GET', '/api/names/supplier/preview', { sid: admin });
    ck('the preview answers', prev.status === 200 && (prev.json.clusters || []).length > 0,
       JSON.stringify(prev.json).slice(0, 140));
    ck('  and WRITES NOTHING', bills.list().map((b) => b.supplier).join('|') === before,
       'the screen she decides on must not be the thing that decides');
    ck('  it carries the questions too', (prev.json.proposals || []).length >= 0 && !!prev.json.aliases);

    // ── THE GATE ────────────────────────────────────────────────────────
    // Rewriting hundreds of financial records across four stores is a bigger
    // act than editing one bill.
    const denied = await req('POST', '/api/names/supplier/merge', { sid: admin, body: {} });
    ck('an ADMIN cannot merge', denied.status === 403, String(denied.status));
    ck('  and nothing changed', bills.list().map((b) => b.supplier).join('|') === before);

    const done = await req('POST', '/api/names/supplier/merge', { sid: jarvis, body: {} });
    ck('the Jarvis profile can', done.status === 200 && done.json.changed > 0,
       `${done.status} ${JSON.stringify(done.json).slice(0, 120)}`);

    const undone = await req('DELETE', '/api/names/merge/' + encodeURIComponent(done.json.merge_id), { sid: jarvis });
    ck('  and can undo it', undone.status === 200 && undone.json.restored > 0, JSON.stringify(undone.json));
    ck('  putting the ledger back exactly', bills.list().map((b) => b.supplier).join('|') === before);

    // Both writes are audited, or a rewrite of 492 financial records leaves
    // no record of who did it.
    const audit = fs.readFileSync(path.join(ROOT, 'helpers/audit.js'), 'utf8');
    ck('both actions are registered for audit',
       /'merge-names'/.test(audit) && /'undo-name-merge'/.test(audit),
       'an unregistered action logs as "unknown-action"');

    listener.close();
}

// ── G. SAYING IT HERSELF ────────────────────────────────────────────────────
// Apsara, 2026-09-19: "in supplier names,it should allow me to type say carlos
// g&c ,g&c both are same".
//
// The gap was real and this section is the proof of it: NOTHING proposes that
// pair. "carlos g&c" normalises to carlosgc and "g&c" to gc, which share no
// prefix, so the suggestion list would never offer it and there was no other
// way in. A panel that only shows what an algorithm noticed is a panel that
// cannot be corrected.
section('G. two names she says are the same');
{
    for (const [sup, bk] of [['carlos g&c', 'C1'], ['carlos g&c', 'C2'], ['g&c', 'C3'], ['G & C', 'C4']]) {
        await addBill(sup, bk);
    }

    ck('nothing proposes carlos g&c and g&c',
       !sm.proposals().some((p) => /g&c/i.test(p.shorter) && /carlos/i.test(p.longer)),
       'if this ever passes by itself the typed form is still the only way she can be sure');
    // The two that DO share a rule are already together — punctuation and
    // spacing, which is normalizeName's job.
    ck('  though "g&c" and "G & C" already are one, by rule',
       !!sm.clusters().find((c) => c.key === 'gc'), JSON.stringify(sm.clusters().map((c) => c.key)));

    await sm.addAlias('g&c', 'carlos g&c', 'apsara');
    const c = sm.clusters().find((x) => x.winner === 'carlos g&c');
    ck('after she types it, all three spellings are one supplier',
       !!c && ['g&c', 'G & C'].every((n) => c.losers.some((l) => l.name === n)),
       JSON.stringify(c && c.losers.map((l) => l.name)));

    // ── ALIASES CHAIN ───────────────────────────────────────────────────
    // She says one thing today, someone says another in March. Following one
    // hop would leave the first pair pointing at a name that has itself moved
    // on, and the cluster splits in two — the problem this file exists to fix,
    // reintroduced by its own mechanism.
    await sm.addAlias('carlos g&c', 'Carlos G&C Metals', 'apsara');
    const chained = sm.clusters().find((x) => x.winner === 'Carlos G&C Metals');
    ck('a chain of aliases resolves all the way',
       !!chained && ['carlos g&c', 'g&c', 'G & C'].every((n) => chained.losers.some((l) => l.name === n)),
       JSON.stringify(chained && chained.losers.map((l) => l.name)));

    // ── AND THE TARGET NEED NOT EXIST YET ───────────────────────────────
    // "Carlos G&C Metals" has never been typed on a bill. A pure rename is
    // still an instruction she gave, and skipping it because the group has
    // one spelling would silently ignore her.
    ck('  even to a spelling not yet used anywhere',
       !!chained && !chained.names.some((n) => n.name === 'Carlos G&C Metals'),
       'the target was already in the ledger, so this did not test a rename');

    // ── A PLAIN RENAME, WITH NOTHING TO MERGE ───────────────────────────
    // One supplier, one spelling, aliased to a name that has never been typed.
    // There is no second spelling to group with, so the "fewer than two names
    // is nothing to fix" rule skips it — and skipping it silently ignores an
    // instruction she gave. A mutation removing that exception survived every
    // other check in this file, because the chain case above happens to have
    // three names in its group.
    await addBill('Solo Metals', 'C5');
    ck('a lone supplier is not a cluster to begin with',
       !sm.clusters().some((c) => c.names.some((x) => x.name === 'Solo Metals')));
    await sm.addAlias('Solo Metals', 'Solo Metals LLC', 'apsara');
    const solo = sm.clusters().find((c) => c.winner === 'Solo Metals LLC');
    ck('  but renaming it to a brand-new spelling IS a change',
       !!solo && solo.losers.some((l) => l.name === 'Solo Metals'),
       JSON.stringify(sm.clusters().map((c) => c.winner)));
    ck('  and the rename reaches the plan',
       sm.plan().changes.some((c) => c.from === 'Solo Metals' && c.to === 'Solo Metals LLC'),
       JSON.stringify(sm.plan().changes.map((c) => c.from + '->' + c.to)));

    let cyc = null;
    try { await sm.addAlias('Carlos G&C Metals', 'g&c', 'apsara'); } catch (e) { cyc = e; }
    ck('a cycle is refused', !!cyc && /already recorded as being/.test(cyc.message), cyc && cyc.message);
    ck('  naming both, so the fix is obvious',
       !!cyc && /Carlos G&C Metals/.test(cyc.message) && /g&c/.test(cyc.message), cyc && cyc.message);

    // ── AND SHE CAN TAKE ONE BACK ───────────────────────────────────────
    // An alias typed in error is otherwise permanent, and it drives the
    // destructive step.
    ck('an alias can be forgotten', (await sm.removeAlias('carlos g&c')) === true);
    const afterDrop = sm.clusters().find((x) => x.winner === 'carlos g&c');
    ck('  and the grouping goes back to what it was',
       !!afterDrop && !sm.clusters().some((x) => x.winner === 'Carlos G&C Metals'),
       JSON.stringify(sm.clusters().map((x) => x.winner)));
    ck('  while the alias she kept still holds',
       afterDrop.losers.some((l) => l.name === 'g&c'));

    ck('forgetting one that was never there says so, rather than pretending',
       (await sm.removeAlias('nobody at all')) === false);
}

// ── H. THE FORM THAT DOES IT ────────────────────────────────────────────────
// The helper being right proves nothing about whether the panel can reach it.
section('H. the panel can say it');
{
    const src = require('../helpers/sourceParts').indexHtml();
    const panel = src.slice(src.indexOf('async function openNameCleanup'),
                            src.indexOf('// ── IMPORTING A SHIPMENTS WORKBOOK'));
    // NOT named smFrom/smTo: tests/mobile-layout.js requires every field whose
    // id contains from/to/date to be wired to the US date picker, because a
    // bare text box renders DD/MM/YYYY on her phone. These are names, not
    // dates, and the convention is worth more than my naming.
    ck('there are two boxes to type names into',
       /id="smAliasName"/.test(panel) && /id="smAliasReal"/.test(panel), 'no way in but the suggestions');
    ck('  and they are not named like date fields',
       !/id="sm(From|To)"/.test(panel), 'the date-picker check would flag them, correctly');
    ck('  offering the names already in use', /list="smNames"/.test(panel) && /datalist id="smNames"/.test(panel),
       'she would have to remember exactly how a name was typed');
    ck('  and Save posts the alias', /smSave.*onclick/s.test(panel) && /answer\(from, to\)/.test(panel));
    ck('  refusing to post half of one',
       /Both boxes, please/.test(panel), 'an empty box would post and fail on the server');
    ck('  with a way to forget one', /smDropAlias/.test(panel) && /\/api\/names\/\$\{field\}\/alias\//.test(panel));

    // The preview has to CARRY the names, or the datalist is empty however
    // well the form is wired.
    const api = require('../helpers/sourceParts').apiSource();
    // The route is registered with the FIELD as a path parameter, so it is
    // ':field', not 'supplier' — an earlier rename substituted the call site
    // and missed the registration, and the slice came back empty.
    const from = api.indexOf("app.get('/api/names/:field/preview'");
    const to = api.indexOf("app.post('/api/names/:field/alias'");
    const route = from >= 0 && to > from ? api.slice(from, to) : '';
    ck('the preview route is registered with a field parameter', !!route,
       'one button, an option per field — the field cannot be baked into the path');
    ck('the preview route sends the names to offer', /names: nc\.usage\(field\)/.test(route),
       route.slice(0, 160));
}


// ── I. THE SAME PROBLEM IN THE OTHER FIELDS ─────────────────────────────────
// Apsara, 2026-09-19: "Even in carrier-that supplier name same problem is
// there.dont make sepratae button for this.instead ,make one button give an
// opion for each field to correct this."
//
// So the field is a parameter. These are the checks that only mean anything
// once it is: that each field reads its OWN stores, that merging one leaves
// the others alone, and that a row merged twice keeps both originals.
section('I. carrier, trucker and customer');
{
    const sales = require(path.join(ROOT, 'helpers/sales'));
    // ── TWO OF THE PREFERRED SPELLING, ONE OF THE OTHER ─────────────────
    // Deliberately not one each. With a 1-1 tie the winner comes down to the
    // tie-break — newest, then longest, then alphabetical — and a check that
    // names a WINNER on that is flaky. Three of these were, the first time
    // this section was written, which is the same mistake the EDGE YARD
    // fixture in section A already carries a note about. Frequency is the
    // rule; the tie-break is tested on its own, for determinism only.
    const bill = (bk, carrier, trucker) => bills.addBill({ date: '09/14/2026', supplier: 'Gomez',
        carrier, trucking_company: trucker, booking_no: bk, container_no: 'CCCU00000' + bk.slice(2),
        gross: 44000, truck: 15000, supplier_price: 0.32 });
    await bill('NC1', 'MSC', 'Sher Trucking');
    await bill('NC2', 'M S C', 'SHER TRUCKING');
    await bill('NC3', 'MSC', 'Sher Trucking');
    const sale = (no, customer) => sales.addSale({ date: '09/14/2026', customer, invoice_no: no,
        container_no: 'SALE' + no, weight: 20, invoice_price: 1000 });
    await sale('S1', 'Aris Enterprises');
    await sale('S2', 'ARIS  ENTERPRISES');
    await sale('S3', 'Aris Enterprises');

    for (const [f, expect] of [['carrier', 'MSC'], ['trucker', 'Sher Trucking'],
                               ['customer', 'Aris Enterprises']]) {
        const cs = nc.clusters(f);
        ck(`${f}: the two spellings are one`, cs.length >= 1 && cs.some((c) => c.winner === expect),
           JSON.stringify(cs.map((c) => [c.winner, c.losers.map((l) => l.name)])));
    }

    ck('an unknown field is refused, not quietly cleaned', (() => {
        try { nc.clusters('nonsense'); return false; } catch (e) { return /unknown field/.test(e.message); }
    })());

    // ── EACH FIELD READS ITS OWN STORES ─────────────────────────────────
    ck('carrier does not reach into the supplier payments store',
       !nc.targetsFor('carrier').some((t) => t.key === 'payments'),
       'a carrier merge rewriting payments would be editing who was paid');
    ck('customer does not reach into bills at all',
       nc.targetsFor('customer').every((t) => t.key === 'sales'));
    ck('trucker uses the bill\'s trucking_company column',
       nc.targetsFor('trucker').some((t) => t.key === 'bills' && t.field === 'trucking_company'),
       'her word for it is Trucker; the column is trucking_company');

    // ── THE YARD'S OWN SELLERS (2026-11-07) ──────────────────────────────
    // Apsara: "clean the names", after the Spend report showed MAZARIEGOES
    // beside MAZARIEGOS and CORES CHAPIN INESH beside INESH CORES CHAPIN —
    // the same two counterparties twice, so "how much have I paid them" was
    // split and both answers were wrong.
    //
    // This field was deliberately absent while every field here belonged to
    // EDGE METALS: pulling loads.json into `supplier` would have merged
    // across two companies. It is its own field now, listing only Edge
    // Yard's stores, so the separation holds in both directions.
    ck('seller is a cleanable field', nc.FIELD_KEYS.includes('seller'));

    // THE ONE THAT WOULD COST HER MONEY. A PREPAYMENT row stores the
    // seller's name and prepaymentCredit() finds unapplied credit BY that
    // name. Rewriting loads.json alone leaves an advance filed under the old
    // spelling: the money stays on disk and vanishes from the screen that
    // says what a seller is holding.
    ck('  and it reaches PREPAYMENTS, not just the loads',
       nc.targetsFor('seller').some((t) => t.key === 'prepayments'),
       'an advance left under the old spelling is money that disappears from the screen');
    ck('  and the drafts, so the old spelling cannot come back on the next load',
       nc.targetsFor('seller').some((t) => t.key === 'drafts'));
    ck('  loads is the vote — the ledger decides the winning spelling',
       nc.targetsFor('seller').some((t) => t.key === 'loads' && t.votes === true));

    // ── AND IT NEVER CROSSES INTO EDGE METALS ───────────────────────────
    // CLAUDE.md rule 5. This is the check that would fail if somebody
    // "tidied up" by folding seller into the supplier field.
    const METALS = ['bills', 'suppliers', 'sales', 'bookings', 'workflow'];
    ck('a seller merge touches no Edge Metals store',
       !nc.targetsFor('seller').some((t) => METALS.includes(t.key)),
       JSON.stringify(nc.targetsFor('seller').map((t) => t.key)));
    ck('  and no Edge Metals field reaches the yard ledger',
       ['supplier', 'carrier', 'trucker', 'customer']
           .every((f) => !nc.targetsFor(f).some((t) => t.key === 'loads' || t.key === 'drafts')),
       'the yard is another company\'s books');

    // Her two real pairs normalise to DIFFERENT keys, so neither is merged
    // automatically — they are proposed and she answers. Asserted here
    // because a future "make it smarter" would merge them silently, and a
    // near-miss here means paying the wrong person.
    const { normalizeName } = require(path.join(ROOT, 'helpers/nameMatch'));
    for (const [a, b] of [['MAZARIEGOES', 'MAZARIEGOS'],
                          ['CORES CHAPIN INESH', 'INESH CORES CHAPIN']]) {
        ck(`"${a}" / "${b}" is NOT auto-merged`, normalizeName(a) !== normalizeName(b),
           'a near-miss is a wrong answer with a confident face — she confirms these');
    }

    // ── MERGING ONE LEAVES THE OTHERS ALONE ─────────────────────────────
    const suppliersBefore = [...new Set(bills.list().map((b) => b.supplier))].sort().join('|');
    const carrierMerge = await nc.apply(nc.plan('carrier'));
    ck('merging carrier changes carriers', carrierMerge.changed > 0, String(carrierMerge.changed));
    ck('  and leaves every supplier untouched',
       [...new Set(bills.list().map((b) => b.supplier))].sort().join('|') === suppliersBefore,
       'one field\'s merge reaching another is the whole reason this is scoped');
    ck('  and leaves the truckers untouched',
       bills.list().some((b) => b.trucking_company === 'SHER TRUCKING'));

    // ── A ROW MERGED TWICE KEEPS BOTH ORIGINALS ─────────────────────────
    // The reason the stamps are keyed by field. A flat pair would have the
    // second merge overwrite the first's original, leaving it unrecoverable
    // while still claiming to be undoable.
    const truckerMerge = await nc.apply(nc.plan('trucker'));
    const twice = bills.list().find((b) => b.booking_no === 'NC2');
    ck('a row merged on two fields keeps both originals',
       twice && twice.name_was && twice.name_was.carrier === 'M S C'
       && twice.name_was.trucker === 'SHER TRUCKING',
       `carrier merge ${carrierMerge.changed} rows, trucker merge ${truckerMerge.changed} rows; `
       + `C2 name_was = ${JSON.stringify(twice && twice.name_was)}`);

    // ── AND UNDOING ONE UNDOES ONLY THAT ONE ────────────────────────────
    const restored = await nc.undo(carrierMerge.merge_id);
    ck('undoing the carrier merge puts the carriers back',
       restored > 0 && bills.list().some((b) => b.carrier === 'M S C'), String(restored));
    ck('  and leaves the trucker merge standing',
       !bills.list().some((b) => b.trucking_company === 'SHER TRUCKING'),
       'an undo that reaches other fields is worse than no undo');
    const c2 = bills.list().find((b) => b.booking_no === 'NC2');
    ck('  with the trucker original still on file',
       !!c2 && !!c2.name_was && c2.name_was.trucker === 'SHER TRUCKING',
       JSON.stringify(c2 && c2.name_was));

    // Each merge is listed with the field it belongs to, or an undo is a
    // guess about what it will touch.
    ck('past merges say which field they were',
       nc.merges().every((m) => !!m.field && !!m.label),
       JSON.stringify(nc.merges().map((m) => [m.field, m.rows])));
}

// ── K. THE YARD'S SELLERS, END TO END ──────────────────────────────────────
section("K. cleaning a yard seller reaches the money, not just the ledger");
{
    // Apsara, 2026-11-07: "clean the names".
    //
    // The check that matters is the PREPAYMENT. A prepayment row stores the
    // seller's name and prepaymentCredit() finds unapplied credit BY that
    // name, so a merge that rewrote loads.json alone would leave an advance
    // filed under a spelling nothing looks for any more: the money stays on
    // disk and vanishes from the screen that says what a seller is holding.
    //
    // Written as a DELTA against a fixture built here, not against whatever
    // earlier sections left behind.
    const cfgK = require(path.join(ROOT, 'config'));
    const put = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));
    const get = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

    // "Randy Recycling" wins on count: three loads against one.
    put(cfgK.LOADS_FILE, [
        { id: 'K1', date: '2026-10-01', seller: 'Randy Recycling', amount: 1000, items: [] },
        { id: 'K2', date: '2026-10-02', seller: 'Randy Recycling', amount: 2000, items: [] },
        { id: 'K3', date: '2026-10-03', seller: 'Randy Recycling', amount: 500, items: [] },
        { id: 'K4', date: '2026-10-04', seller: 'RANDY  RECYCLING', amount: 300, items: [] },
        { id: 'K5', date: '2026-10-05', seller: 'Nur Metal', amount: 900, items: [] },
    ]);
    put(cfgK.LOAD_DRAFTS_FILE, [{ id: 'KD1', seller: 'RANDY  RECYCLING' }]);
    put(cfgK.PAYMENTS_FILE, [{ id: 'KP1', load_kind: 'prepayment', is_prepayment: true,
        seller: 'RANDY  RECYCLING', amount: 400, paid_on: '2026-10-05', mode: 'Cash' }]);

    const planK = nc.plan('seller');
    const cl = planK.clusters.find((c) => /randy/i.test(c.winner));
    ck('the tidy spelling wins on count, not on luck',
       cl && cl.winner === 'Randy Recycling', JSON.stringify(cl && cl.winner));
    ck('  and the preview counts all THREE stores, not just the ledger',
       planK.byStore.loads === 1 && planK.byStore.drafts === 1 && planK.byStore.prepayments === 1,
       JSON.stringify(planK.byStore));

    const applied = await nc.apply(planK);
    ck('applying changes three rows', applied.changed === 3, String(applied.changed));
    ck('  the load is rewritten',
       get(cfgK.LOADS_FILE).find((l) => l.id === 'K4').seller === 'Randy Recycling');
    ck('  the draft is rewritten, so the old spelling cannot come back',
       get(cfgK.LOAD_DRAFTS_FILE)[0].seller === 'Randy Recycling');
    ck('  AND THE PREPAYMENT IS REWRITTEN — the advance stays findable',
       get(cfgK.PAYMENTS_FILE)[0].seller === 'Randy Recycling',
       'left behind, $400 of credit would be on disk and invisible on screen');
    ck('  a different seller is untouched',
       get(cfgK.LOADS_FILE).find((l) => l.id === 'K5').seller === 'Nur Metal');

    // Every changed row keeps the handle that undoes it.
    const changedRow = get(cfgK.LOADS_FILE).find((l) => l.id === 'K4');
    ck('every changed row carries its merge id',
       !!(changedRow.name_merge && changedRow.name_merge.seller),
       JSON.stringify(changedRow.name_merge));
    const mergeId = changedRow.name_merge.seller;
    await nc.undo(mergeId);
    ck('undo puts the ledger back',
       get(cfgK.LOADS_FILE).find((l) => l.id === 'K4').seller === 'RANDY  RECYCLING');
    ck('  and puts the PREPAYMENT back too',
       get(cfgK.PAYMENTS_FILE)[0].seller === 'RANDY  RECYCLING',
       'an undo that forgets the money is not an undo');
}

// ── J. THE ANSWERS SHE ALREADY GAVE ARE NOT LOST ────────────────────────────
// supplierMerge.js wrote data/supplier_aliases.json with no field on it. A
// refactor that forgets a decision she made by hand is a refactor that costs
// her the same afternoon twice.
section('J. the pre-field-scope aliases still count');
{
    const fsx = require('fs');
    const legacy = path.join(process.env.DATA_DIR, 'supplier_aliases.json');
    fsx.writeFileSync(legacy, JSON.stringify([{ from: 'GMZ', to: 'Gomez', at: '2026-09-19T00:00:00Z' }]));
    ck('an old supplier alias is read, and read as a SUPPLIER one',
       nc.aliases('supplier').some((a) => a.from === 'GMZ' && a.field === 'supplier'),
       JSON.stringify(nc.aliases('supplier')));
    ck('  and does not leak into another field',
       !nc.aliases('carrier').some((a) => a.from === 'GMZ'),
       JSON.stringify(nc.aliases('carrier')));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
