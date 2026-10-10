// ── tests/price-units-e2e.js ──────────────────────────────────────────────
// Apsara, 2026-09-17: "ALwyas test end to end when you add a new feature."
//
// tests/price-units.js proves the table and the arithmetic. This proves the
// WIRE, which is where the gaps have always been: the route not forwarding
// the new field, the client sending `pieces` and the route reading
// `piece_count`, the screen computing one figure and the server storing
// another.
//
// For this feature the specific risk is that `pieces` is a brand-new field
// on a load item. api.js passes `items: b.items` straight through, so it
// should arrive — but "should" is what a test is for, and a field that is
// silently dropped on the way in produces a /piece row with no amount,
// which looks like a typo rather than a bug.
//
// Every figure here is read back out of the route the SCREEN reads, and
// measured as a DELTA where an earlier section has already written.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-units-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';
process.env.JARVIS_PASSWORD = process.env.JARVIS_PASSWORD || 'jarvis-pw-dddddddddddd';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated'); process.exit(1);
}

(async () => {

const { createApi } = require(path.join(ROOT, 'api'));
const app = createApi();
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (sid) headers.Authorization = `Bearer ${sid}`;
    const rq = http.request(base + p, { method, headers }, (res) => {
        let raw = ''; res.on('data', (c) => { raw += c; });
        res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j, raw }); });
    });
    rq.on('error', reject); if (data) rq.write(data); rq.end();
});
const login = async (pw) => ((await req('POST', '/login', { body: { password: pw } })).json || {}).sid;
const sid = await login(process.env.ADMIN_PASSWORD);

// 46,560 lb net — the figure from the September invoice bug, so the numbers
// below are ones she has seen go wrong before.
const GROSS = 50000;
const TARE = 3440;          // net 46,560
const itemsFor = (unit, price, pieces) => ([{
    description: 'Copper', gross_weight: GROSS, tare_weight: TARE,
    price, unit, ...(pieces === undefined ? {} : { pieces }),
}]);

const postLoad = (unit, price, pieces, extra = {}) => req('POST', '/api/loads', { sid, body: {
    date: '2026-10-10', seller: 'Hugo', items: itemsFor(unit, price, pieces),
    created_by: 'test', ...extra } });

// Both POST routes answer { ok, load: record }, and the PUT answers the same
// shape — NOT the record at the top level. My first version read
// (r.json || {}).items and got undefined for every figure while section F,
// which reads the list route, passed: the data was right all along and the
// test was looking in the wrong place. Worth the comment because a helper
// that returns {} for a shape it does not recognise fails as a wrong VALUE
// rather than as a missing key, which is the slower thing to spot.
const loadOf = (r) => ((r.json || {}).load || r.json || {});
const itemOf = (r) => ((loadOf(r).items) || [])[0] || {};

// ── A — THE THREE WEIGHT UNITS, THROUGH THE ROUTE ────────────────────────
{
    section('A — a ton is which ton');
    const lb = await postLoad('lb', 0.31);
    ck('a pound load saves', lb.status === 200 || lb.status === 201, `${lb.status} ${lb.raw.slice(0, 160)}`);
    ck('  and is priced on the net itself: 46,560 x 0.31 = 14,433.60',
       itemOf(lb).amount === 14433.6, String(itemOf(lb).amount));

    const nt = await postLoad('nt', 300);
    ck('a NET ton load saves', nt.status === 200 || nt.status === 201, `${nt.status} ${nt.raw.slice(0, 200)}`);
    ck('  23.28 net tons at $300 = $6,984.00', itemOf(nt).amount === 6984, String(itemOf(nt).amount));
    ck('  and the unit was STORED as nt, not coerced', itemOf(nt).unit === 'nt', itemOf(nt).unit);

    const gt = await postLoad('gt', 300);
    ck('a GROSS ton load saves', gt.status === 200 || gt.status === 201, `${gt.status}`);
    ck('  20.7857 gross tons at $300 = $6,235.71', itemOf(gt).amount === 6235.71, String(itemOf(gt).amount));

    // ── THE 12% THAT IS THE WHOLE REASON THEY ARE SEPARATE ───────────────
    // Both are "a ton" out loud. $748.29 on a single row, and on the buy
    // side the gross-ton reading is cheaper — the direction nobody queries.
    ck('the two tons differ by $748.29 on this one row',
       Math.abs((itemOf(nt).amount - itemOf(gt).amount) - 748.29) < 0.005,
       String(itemOf(nt).amount - itemOf(gt).amount));

    const mt = await postLoad('mt', 300);
    ck('a tonne load still computes as it always did: 21.11928 x 300 = 6,335.79',
       itemOf(mt).amount === 6335.79, String(itemOf(mt).amount));

    // The net weight is the thing on the ticket the seller signs. It must be
    // pounds on every one of them.
    ck('every one of them stored the net in POUNDS, unconverted',
       [lb, nt, gt, mt].every((r) => itemOf(r).net_weight === 46560),
       JSON.stringify([lb, nt, gt, mt].map((r) => itemOf(r).net_weight)));
}

// ── B — /piece, AND THE FIELD THAT DID NOT EXIST BEFORE TODAY ────────────
{
    section('B — pieces');
    const pc = await postLoad('piece', 5, 12);
    ck('a /piece load saves', pc.status === 200 || pc.status === 201, `${pc.status} ${pc.raw.slice(0, 200)}`);
    // THE ONE THAT MATTERS. If `pieces` were dropped on the way in, this
    // would be null and look like a typo; if the unit fell through to the
    // pound branch it would be 46,560 x 5 = $232,800.
    ck('  12 pieces at $5 is $60.00', itemOf(pc).amount === 60, String(itemOf(pc).amount));
    ck('  NOT $232,800 — the pound branch is not reached',
       itemOf(pc).amount !== 232800, String(itemOf(pc).amount));
    ck('  the count survived the wire', itemOf(pc).pieces === 12, String(itemOf(pc).pieces));
    ck('  and the WEIGHT is still recorded, because the truck was still weighed',
       itemOf(pc).net_weight === 46560, String(itemOf(pc).net_weight));

    const noCount = await postLoad('piece', 5);
    ck('a /piece row with no count has NO amount — not zero, not the weight',
       itemOf(noCount).amount === null, String(itemOf(noCount).amount));
    const zero = await postLoad('piece', 5, 0);
    ck('a count of zero is a real answer and gives zero',
       itemOf(zero).amount === 0, String(itemOf(zero).amount));

    // A stray count on a weight row must change nothing, or changing a row
    // from /piece back to /lb would keep pricing by the count.
    const stray = await postLoad('lb', 0.31, 9999);
    ck('a stray count on a POUND row is ignored and dropped',
       itemOf(stray).amount === 14433.6 && itemOf(stray).pieces === null,
       JSON.stringify([itemOf(stray).amount, itemOf(stray).pieces]));
}

// ── C — AN UNKNOWN UNIT IS REFUSED, NOT PRICED AS POUNDS ─────────────────
{
    section('C — the refusal');
    const bad = await postLoad('bushel', 5);
    ck('a unit Jarvis does not price in is REFUSED', bad.status >= 400,
       `${bad.status} ${bad.raw.slice(0, 200)}`);
    ck('  and the message names the unit', /bushel/.test(bad.raw), bad.raw.slice(0, 200));
    ck('  and nothing was stored at the pound figure',
       !/14433\.6|232800/.test(bad.raw), bad.raw.slice(0, 200));
}

// ── D — AN EDIT KEEPS THE UNIT AND THE COUNT ─────────────────────────────
// The path that loses a value: a client that omits a field on edit, and a
// server that treats absent as cleared.
{
    section('D — reopening and saving');
    const made = await postLoad('piece', 5, 12);
    const id = loadOf(made).id;
    ck('the load has an id', !!id, JSON.stringify(Object.keys(loadOf(made))));

    // Edit something unrelated — the seller — sending the items back exactly
    // as a client would after a cold open.
    const back = itemOf(made);
    const edited = await req('PUT', `/api/loads/${id}`, { sid, body: {
        seller: 'Hugo Trading', items: [{
            description: back.description, gross_weight: back.gross_weight,
            tare_weight: back.tare_weight, price: back.price,
            unit: back.unit, pieces: back.pieces }] } });
    ck('the edit saves', edited.status === 200, `${edited.status} ${edited.raw.slice(0, 200)}`);
    ck('  the unit survived the round trip', itemOf(edited).unit === 'piece', itemOf(edited).unit);
    ck('  the count survived it', itemOf(edited).pieces === 12, String(itemOf(edited).pieces));
    ck('  and the amount is unchanged — the figure did not jump on save',
       itemOf(edited).amount === 60, String(itemOf(edited).amount));

    // ── AND THE WEBSITE'S DISPLAY-ONLY PICKER CANNOT DESTROY IT ──────────
    // Her call was that the website displays the new units without offering
    // them. A two-option <select> handed 'nt' silently becomes "" and
    // syncItemsFromDom's `|| 'lb'` turns that into POUNDS — so opening a net
    // ton load there and pressing Save, changing nothing, would reprice it
    // by 2,000. The markup renders the current unit as a selected disabled
    // option so the value round-trips; this is that round trip, performed
    // through the route.
    const ntLoad = await postLoad('nt', 300);
    const ntId = loadOf(ntLoad).id;
    const ntItem = itemOf(ntLoad);
    const resaved = await req('PUT', `/api/loads/${ntId}`, { sid, body: {
        // seller is required by the route — a PUT without it is a 400, which
        // my first version of this check hit and read as "the unit was lost".
        seller: 'Hugo',
        items: [{ description: ntItem.description, gross_weight: ntItem.gross_weight,
            tare_weight: ntItem.tare_weight, price: ntItem.price,
            unit: ntItem.unit, pieces: ntItem.pieces }] } });
    ck('a net ton load re-saved unchanged is STILL a net ton',
       itemOf(resaved).unit === 'nt', itemOf(resaved).unit);
    ck('  and still $6,984.00, not $13,968,000', itemOf(resaved).amount === 6984,
       String(itemOf(resaved).amount));
}

// ── E — SALES TOO, HER CALL ──────────────────────────────────────────────
// Asked whether this should reach sales as well as purchases she said both.
// outboundLoads.js has its OWN copy of computeItem, deliberately, so the
// sale side is a separate wire and gets its own section.
{
    section('E — the sale side');
    const sold = await req('POST', '/api/outbound-loads', { sid, body: {
        date: '2026-10-10', buyer: 'Eccomelt',
        items: itemsFor('nt', 300), created_by: 'test' } });
    ck('a sale priced per net ton saves', sold.status === 200 || sold.status === 201,
       `${sold.status} ${sold.raw.slice(0, 200)}`);
    ck('  at $6,984.00, the same arithmetic as the buy side',
       itemOf(sold).amount === 6984, String(itemOf(sold).amount));
    ck('  and the unit stored as nt', itemOf(sold).unit === 'nt', itemOf(sold).unit);

    const soldPc = await req('POST', '/api/outbound-loads', { sid, body: {
        date: '2026-10-10', buyer: 'Eccomelt',
        items: itemsFor('piece', 5, 12), created_by: 'test' } });
    ck('a sale priced per piece saves at $60.00', itemOf(soldPc).amount === 60,
       String(itemOf(soldPc).amount));
    // A sale is where the 2,204x error would be in the CUSTOMER's favour
    // being wrong the other way, so the refusal matters on this side too.
    const soldBad = await req('POST', '/api/outbound-loads', { sid, body: {
        date: '2026-10-10', buyer: 'Eccomelt',
        items: itemsFor('bushel', 5), created_by: 'test' } });
    ck('and an unknown unit is refused on the sale side as well',
       soldBad.status >= 400, `${soldBad.status} ${soldBad.raw.slice(0, 160)}`);
}

// ── F — THE READ ROUTE THE SCREEN ACTUALLY READS ─────────────────────────
// A delta, not an absolute: sections A–E have written a pile of loads.
{
    section('F — reading it back out of /api/loads');
    const list = await req('GET', '/api/loads', { sid });
    ck('the list route answers', list.status === 200, String(list.status));
    const rows = (list.json || {}).loads || list.json || [];
    const all = (Array.isArray(rows) ? rows : []).flatMap((l) => l.items || []);
    ck('  the net ton rows come back with their unit on them',
       all.some((i) => i.unit === 'nt' && i.amount === 6984),
       JSON.stringify(all.filter((i) => i.unit === 'nt').map((i) => i.amount)));
    ck('  the gross ton rows too, and NOT at the net ton figure',
       all.some((i) => i.unit === 'gt' && i.amount === 6235.71),
       JSON.stringify(all.filter((i) => i.unit === 'gt').map((i) => i.amount)));
    ck('  and the counted rows carry their count',
       all.some((i) => i.unit === 'piece' && i.pieces === 12 && i.amount === 60),
       JSON.stringify(all.filter((i) => i.unit === 'piece').map((i) => [i.pieces, i.amount])));
    ck('  no row anywhere came back at the pound figure for a non-pound unit',
       !all.some((i) => i.unit && i.unit !== 'lb' && i.amount === 14433.6
           && Number(i.price) === 300),
       JSON.stringify(all.map((i) => [i.unit, i.amount])));
}

server.close();

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
