// ── tests/supplier-merge.js ─────────────────────────────────────────────────
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
const sm = require(path.join(ROOT, 'helpers/supplierMerge'));
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
    const changed = bills.list().filter((b) => b.supplier_was);
    ck('changed rows carry the spelling they had', changed.length > 0,
       'nothing recorded what it used to be');
    ck('  and the merge that changed them', changed.every((b) => !!b.supplier_merge));
    ck('  while untouched rows carry neither',
       bills.list().filter((b) => b.supplier === 'Edge Metals').every((b) => !b.supplier_was && !b.supplier_merge));

    const merges = sm.merges();
    ck('the merge is listed, so an undo has something to name', merges.length === 1, String(merges.length));

    const restored = await sm.undo(merges[0].merge_id);
    ck('undoing puts every spelling back', restored === merges[0].rows,
       `${restored} restored, ${merges[0].rows} recorded as changed`);
    const names = [...new Set(bills.list().map((b) => b.supplier))].sort();
    ck('  exactly as it was', names.join('|') === ['CALDERON', 'EDGE YARD', 'EDGEYARD', 'Edge Metals', 'MODern', 'calderon', 'modern enterprises'].join('|'),
       names.join('|'));
    ck('  and the markers are gone too',
       bills.list().every((b) => b.supplier_was === undefined && b.supplier_merge === undefined));
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
    const src = fs.readFileSync(path.join(ROOT, 'helpers/supplierMerge.js'), 'utf8');
    ck('the yard ledger is not among the stores this rewrites',
       !/LOADS_FILE|OUTBOUND_LOADS_FILE/.test(src),
       'a merge would be editing the other company\'s books');
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
    const prev = await req('GET', '/api/suppliers/merge/preview', { sid: admin });
    ck('the preview answers', prev.status === 200 && (prev.json.clusters || []).length > 0,
       JSON.stringify(prev.json).slice(0, 140));
    ck('  and WRITES NOTHING', bills.list().map((b) => b.supplier).join('|') === before,
       'the screen she decides on must not be the thing that decides');
    ck('  it carries the questions too', (prev.json.proposals || []).length >= 0 && !!prev.json.aliases);

    // ── THE GATE ────────────────────────────────────────────────────────
    // Rewriting hundreds of financial records across four stores is a bigger
    // act than editing one bill.
    const denied = await req('POST', '/api/suppliers/merge', { sid: admin, body: {} });
    ck('an ADMIN cannot merge', denied.status === 403, String(denied.status));
    ck('  and nothing changed', bills.list().map((b) => b.supplier).join('|') === before);

    const done = await req('POST', '/api/suppliers/merge', { sid: jarvis, body: {} });
    ck('the Jarvis profile can', done.status === 200 && done.json.changed > 0,
       `${done.status} ${JSON.stringify(done.json).slice(0, 120)}`);

    const undone = await req('DELETE', '/api/suppliers/merge/' + encodeURIComponent(done.json.merge_id), { sid: jarvis });
    ck('  and can undo it', undone.status === 200 && undone.json.restored > 0, JSON.stringify(undone.json));
    ck('  putting the ledger back exactly', bills.list().map((b) => b.supplier).join('|') === before);

    // Both writes are audited, or a rewrite of 492 financial records leaves
    // no record of who did it.
    const audit = fs.readFileSync(path.join(ROOT, 'helpers/audit.js'), 'utf8');
    ck('both actions are registered for audit',
       /'merge-suppliers'/.test(audit) && /'undo-supplier-merge'/.test(audit),
       'an unregistered action logs as "unknown-action"');

    listener.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
