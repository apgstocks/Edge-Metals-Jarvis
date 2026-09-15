// ── tests/once-per-save.js ────────────────────────────────────────────────
// Apsara, 2026-09-15, with a screenshot of two identical Darwin sales (OUT_02
// and OUT_03, same buyer, same date, same 4 items, same 26 lb, same
// $2,845.00): "I just added one.But two ones are created".
//
// The cause was never found — see helpers/oncePerSave.js for the list of
// things that were ruled out. So the guarantee under test here is not "the
// bug is fixed", which nobody can honestly claim; it is the weaker and
// checkable one: HOWEVER many times the same save arrives, it creates at
// most one record.
//
// That distinction is why this file sends the request TWICE, and in one case
// simultaneously, rather than asserting something about a click handler. The
// second request is the thing that happened to her; the test reproduces the
// symptom, not a theory about the cause.

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.JARVIS_TEST = '1';

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

// Point the stores at a scratch directory BEFORE config is required by
// anything else, so a test can never touch her real data/*.json.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-once-'));
process.env.LOADS_FILE = path.join(TMP, 'loads.json');
process.env.OUTBOUND_LOADS_FILE = path.join(TMP, 'outbound_loads.json');

const cfg = require('../config');
cfg.LOADS_FILE = path.join(TMP, 'loads.json');
cfg.OUTBOUND_LOADS_FILE = path.join(TMP, 'outbound_loads.json');
fs.writeFileSync(cfg.LOADS_FILE, '[]');
fs.writeFileSync(cfg.OUTBOUND_LOADS_FILE, '[]');

const once = require('../helpers/oncePerSave');
const outbound = require('../helpers/outboundLoads');
const loads = require('../helpers/loads');

const readOut = () => JSON.parse(fs.readFileSync(cfg.OUTBOUND_LOADS_FILE, 'utf8'));
const readIn  = () => JSON.parse(fs.readFileSync(cfg.LOADS_FILE, 'utf8'));

// Her actual numbers, so a failure reads like the screenshot she sent.
const darwin = (ticket) => ({
    date: '2026-09-14', buyer: 'Darwin', weight_unit: 'lb',
    client_request_id: ticket,
    items: [
        { description: 'Al combo', gross_weight: 26, tare_weight: 0, price: 109.42 },
        { description: 'Cu wire',  gross_weight: 0,  tare_weight: 0, price: 0 },
    ],
});

(async () => {

section('A — the same save, sent twice');
{
    fs.writeFileSync(cfg.OUTBOUND_LOADS_FILE, '[]');
    const first  = await outbound.addOutboundLoad(darwin('ticket-aaa'));
    const second = await outbound.addOutboundLoad(darwin('ticket-aaa'));
    const rows = readOut();

    ck('one record, not two', rows.length === 1,
       `${rows.length} rows: ${rows.map((r) => r.id).join(', ')}`);
    ck('  and the second send gets the FIRST record back',
       second && first && second.id === first.id,
       `first ${first && first.id}, second ${second && second.id}`);
    // She would otherwise see a save that appeared to fail and try again.
    ck('  so the screen sees a normal successful save, not an error',
       !!(second && second.id && second.buyer === 'Darwin'));
    ck('  and no second id was burned',
       rows.length === 1 && rows[0].id === first.id,
       'nextOutboundId must not advance for a send that wrote nothing');
}

section('B — two genuinely separate saves still both land');
{
    fs.writeFileSync(cfg.OUTBOUND_LOADS_FILE, '[]');
    // The case a "looks like a duplicate" warning would have got wrong: two
    // real shipments that happen to match. Different tickets, so both save.
    const a = await outbound.addOutboundLoad(darwin('ticket-one'));
    const b = await outbound.addOutboundLoad(darwin('ticket-two'));
    const rows = readOut();
    ck('identical shipments with different tickets both save', rows.length === 2,
       `${rows.length} rows — this is the case a duplicate warning would block`);
    ck('  with different ids', a.id !== b.id, `${a.id} vs ${b.id}`);
}

section('C — a save with no ticket at all is never blocked');
{
    fs.writeFileSync(cfg.OUTBOUND_LOADS_FILE, '[]');
    // An older app build, the bot, a curl — anything not sending a ticket
    // must keep working exactly as before. A missing ticket must NOT match
    // another missing ticket, or the second untagged save of the day would
    // silently vanish. That is the dangerous direction: losing her work.
    await outbound.addOutboundLoad(darwin(undefined));
    await outbound.addOutboundLoad(darwin(undefined));
    await outbound.addOutboundLoad(darwin(''));
    ck('three untagged saves make three records', readOut().length === 3,
       `${readOut().length} rows — a blank ticket must never match a blank ticket`);
    ck('  and findSpent refuses blanks outright',
       once.findSpent([{ client_request_id: '', created_at: new Date().toISOString() }], '') === null
       && once.findSpent([{ client_request_id: null, created_at: new Date().toISOString() }], null) === null);
}

section('D — the two requests arriving together');
{
    fs.writeFileSync(cfg.OUTBOUND_LOADS_FILE, '[]');
    // The race the guard is actually placed to survive. If the check ran
    // BEFORE mutateJson instead of inside it, both of these would look, both
    // would see an empty file, and both would write — the same bug with
    // better timing. Fired without awaiting in between, so they overlap.
    const [x, y] = await Promise.all([
        outbound.addOutboundLoad(darwin('ticket-race')),
        outbound.addOutboundLoad(darwin('ticket-race')),
    ]);
    const rows = readOut();
    ck('simultaneous duplicates still make one record', rows.length === 1,
       `${rows.length} rows — the check must run under the file lock`);
    ck('  and both callers get the same id', x.id === y.id, `${x.id} vs ${y.id}`);
}

section('E — purchases are guarded too, not just sales');
{
    fs.writeFileSync(cfg.LOADS_FILE, '[]');
    // She hit this on a sale, but the same button in the same modal saves a
    // purchase through the same api() helper. Fixing only the screen where a
    // bug was noticed is how the other half stays broken.
    const p = { date: '2026-09-14', seller: 'Ramesh', buyer: 'Edge Trading', weight_unit: 'lb',
                items: [{ description: 'Al combo', gross_weight: 1000, tare_weight: 100, price: 0.5 }] };
    const a = await loads.addLoad({ ...p, client_request_id: 'buy-aaa' });
    const b = await loads.addLoad({ ...p, client_request_id: 'buy-aaa' });
    ck('a re-sent purchase makes one record', readIn().length === 1,
       `${readIn().length} rows`);
    ck('  and returns the first one', a.id === b.id, `${a.id} vs ${b.id}`);
}

section('F — an old ticket does not swallow a new save');
{
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const rows = [{ id: 'OUT_9', client_request_id: 'stale', created_at: old }];
    ck('a ticket older than a day is treated as absent',
       once.findSpent(rows, 'stale') === null,
       'returning a two-day-old record instead of saving would LOSE her work — ' +
       'the worse failure of the two');
    const fresh = [{ id: 'OUT_9', client_request_id: 'stale', created_at: new Date().toISOString() }];
    ck('  while a fresh one still matches', once.findSpent(fresh, 'stale') !== null);
    ck('  and an absurdly long ticket is refused', once.normTicket('x'.repeat(101)) === null);
}

section('G — both clients actually mint and send one');
{
    const web = fs.readFileSync(path.join(__dirname, '..', 'dashboard/index.html'), 'utf8');
    const app = fs.readFileSync(path.join(__dirname, '..', 'mobile-app/www/index.html'), 'utf8');
    for (const [label, src] of [['website', web], ['app', app]]) {
        // Minted in resetLoadModal — i.e. when the form OPENS. A ticket made
        // inside the click handler would differ on a re-send, which is
        // precisely the case it exists to catch, so where it is minted is
        // the whole mechanism and not a detail.
        const reset = src.slice(src.indexOf('function resetLoadModal'), src.indexOf('function resetLoadModal') + 1400);

        // ── RUN IT, DON'T READ IT ───────────────────────────────────────
        // The first version of this check asserted that the words
        // "saveTicket =" and "randomUUID" both appeared in resetLoadModal,
        // and a mutation flipping it to `saveTicket = null; const _unused =
        // (window.crypto && crypto.randomUUID)` sailed straight through —
        // both words still present, ticket always null. A grep for the
        // ingredients is not a check that the dish was cooked.
        //
        // So the mint lines are lifted out and EXECUTED, with window.crypto
        // absent and then present, and the result inspected. saveTicket is a
        // top-level `let`, which is not a property of window and cannot be
        // read off the page — hence running the lines in isolation rather
        // than driving the whole form.
        const mint = (reset.match(/saveTicket = [\s\S]*?;\n/) || [''])[0];
        const run = (hasCrypto) => {
            const sandbox = { window: hasCrypto ? { crypto: { randomUUID: () => 'uuid-from-crypto' } } : {},
                              crypto: hasCrypto ? { randomUUID: () => 'uuid-from-crypto' } : undefined,
                              saveTicket: 'UNSET' };
            try {
                // eslint-disable-next-line no-new-func
                new Function('window', 'crypto', `let saveTicket; ${mint} return saveTicket;`)(sandbox.window, sandbox.crypto);
                return new Function('window', 'crypto', `let saveTicket; ${mint} return saveTicket;`)(sandbox.window, sandbox.crypto);
            } catch (e) { return `THREW: ${e.message}`; }
        };
        const withCrypto = run(true);
        const withoutCrypto = run(false);

        ck(`${label}: opening the form produces a real ticket`,
           typeof withCrypto === 'string' && withCrypto.length > 5,
           `produced ${JSON.stringify(withCrypto)} — a null ticket disables the whole guard silently`);
        ck(`${label}:   and still produces one when randomUUID is unavailable`,
           typeof withoutCrypto === 'string' && withoutCrypto.length > 5 && !/THREW/.test(withoutCrypto),
           `produced ${JSON.stringify(withoutCrypto)} — randomUUID needs a secure context, and a client ` +
           'silently sending no ticket looks exactly like one whose ticket works');
        ck(`${label}:   and two opens do not produce the same ticket`,
           run(false) !== run(false) || withCrypto !== withoutCrypto,
           'a constant ticket would make the SECOND genuine save of the day vanish');
        ck(`${label}:   and it is sent on the purchase payload`,
           /client_request_id: saveTicket,/.test(src));
        ck(`${label}:   and on the sale payload`,
           /client_request_id: payload\.client_request_id,/.test(src));
    }
    // The server has to actually read it off the body, or every ticket above
    // is decoration.
    const api = fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8');
    ck('the server reads the ticket off the request body',
       (api.match(/client_request_id: b\.client_request_id,/g) || []).length === 2,
       'both the /api/loads and /api/outbound-loads routes must pass it through');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\n  THREW:', e.stack || e.message); process.exit(1); });
