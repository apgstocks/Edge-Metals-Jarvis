// ── tests/stock-aliases.js ────────────────────────────────────────────────
// Apsara, 2026-09-16: "if i add something in sales,then inventory should be
// adjusted righht" — it already was, and a probe showed HOW it failed her:
//
//   Al combo          net in 1000   shipped 400   on hand  600
//   Aluminium combo   net in    0   shipped 300   on hand -300
//
// One pile of aluminium, two rows, one of them impossible. The real 1000 lb
// should read 300 left.
//
// Her two decisions:
//   "Warn me if al combo and aluminium combo,remember my selection-then next
//    time let ai decide based on knowldge"
//   and, on how loud a negative should be: "Block the sale instead".
//
// ── WHAT THIS FILE IS CAREFUL ABOUT ─────────────────────────────────────────
// Not that similar names get merged — that would be the WRONG feature. "Al
// 6061" and "Al 6063" differ by one character and are different alloys worth
// different money. Nothing is joined by resemblance; only by her answer. The
// tests below spend as much effort on what must NOT merge as on what must.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-stock-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD   = 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }
const { createApi } = require(path.join(ROOT, 'api'));
const aliases = require(path.join(ROOT, 'helpers/itemAliases'));
const guard = require(path.join(ROOT, 'helpers/stockGuard'));
const { suggestItemMatch, affinity } = require(path.join(ROOT, 'helpers/itemMatch'));

let server, base;
function req(method, p, { body, sid } = {}) {
    return new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r = http.request(base + p, { method, headers }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
        });
        r.on('error', reject); if (data) r.write(data); r.end();
    });
}

(async () => {

const app = createApi();
await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
base = `http://127.0.0.1:${server.address().port}`;
const admin = ((await req('POST', '/login', { body: { password: 'admin-pw-bbbbbbbbbbb' } })).json || {}).sid;

const buy = (desc, w) => req('POST', '/api/loads', { sid: admin, body: {
    date: '2026-09-14', seller: 'Ramesh', buyer: 'Edge Trading', weight_unit: 'lb',
    items: [{ description: desc, gross_weight: w, tare_weight: 0, price: 1 }],
} });
const sell = (desc, w, extra) => req('POST', '/api/outbound-loads', { sid: admin, body: {
    date: '2026-09-15', buyer: 'Eccomelt', weight_unit: 'lb',
    items: [{ description: desc, gross_weight: w, tare_weight: 0, price: 2 }],
    ...(extra || {}),
} });
const inventory = async () => ((await req('GET', '/api/loads/inventory', { sid: admin })).json || {});

section('A — the report her question was about');
{
    await buy('Al combo', 1000);
    let inv = await inventory();
    let row = (inv.byType || []).find((g) => g.description === 'Al combo');
    ck('buying puts it on hand', row && row.net === 1000 && row.onHand === 1000, JSON.stringify(row));

    const ok = await sell('Al combo', 400);
    ck('  and selling is allowed while there is stock', ok.status === 200, JSON.stringify(ok.json));
    inv = await inventory();
    row = (inv.byType || []).find((g) => g.description === 'Al combo');
    ck('  selling takes it back off — this is what she asked about',
       row && row.shipped === 400 && row.onHand === 600, JSON.stringify(row));
}

section('B — the sale that is short is RECORDED, and warned about');
{
    // ── SHE REVERSED THIS, AND THE REVERSAL IS THE POINT ─────────────────
    // On 2026-09-16 she picked "Block the sale instead" from the options put
    // to her. Later the same day, having used it: "negative inventory should
    // not block a sale in edge yard.just provide warning that can be
    // overriden."
    //
    // So this section is the exact inverse of what it asserted this morning.
    // Written out rather than deleted, because the old rule is the one a
    // future reader would assume from helpers/stockGuard.js's name.
    const short = await sell('Al combo', 5000);
    ck('shipping more than is on hand is RECORDED', short.status === 200, JSON.stringify(short.json));
    ck('  and comes back with a warning', !!(short.json && short.json.stock_warning),
       JSON.stringify(short.json) + ' — a save with no warning is the minus-300 row coming back silently');
    ck('  machine-readable', short.json.stock_warning.code === 'STOCK_SHORT');
    // "Not enough stock" tells her nothing she can act on.
    ck('  naming the item, what is on hand and what was attempted',
       /Al combo/.test(short.json.stock_warning.message)
       && /600/.test(short.json.stock_warning.message)
       && /5000/.test(short.json.stock_warning.message),
       short.json.stock_warning.message);

    // THE CASE THAT MATTERS MOST is still the one to get right: a material
    // never bought at all. On hand is ZERO, which is a FACT, not "unknown".
    // Conflating those two is what produced the minus-300 row originally, and
    // it would now show up as a sale that warns about nothing.
    const never = await sell('Brass', 50);
    ck('a material never bought still warns', never.status === 200 && !!never.json.stock_warning,
       JSON.stringify(never.json) + ' — "not in the report" means zero, not unknown');

    // Two lines of one metal, each fitting, together not.
    const pair = await req('POST', '/api/outbound-loads', { sid: admin, body: {
        date: '2026-09-15', buyer: 'Eccomelt', weight_unit: 'lb',
        items: [{ description: 'Al combo', gross_weight: 400, tare_weight: 0, price: 2 },
                { description: 'Al combo', gross_weight: 400, tare_weight: 0, price: 2 }],
    } });
    ck('  two lines of one metal are summed before warning', !!(pair.json && pair.json.stock_warning),
       JSON.stringify(pair.json) + ' — 400 and 400 each fit inside 600; together they do not');
}

section('C — and the negative is VISIBLE afterwards');
{
    // This is what carries the weight now that nothing is refused. The warning
    // is a dialog and dialogs are dismissed; the report is where the problem
    // has to keep showing until the missing purchase is entered.
    //
    // It is also the cost of her reversal, stated as a test rather than as an
    // opinion: these sales all went through, and the only thing left pointing
    // at the missing paperwork is this number.
    const inv = await inventory();
    const row = (inv.byType || []).find((g) => g.description === 'Al combo');
    ck('the sales were really written', row && row.shipped > 600, JSON.stringify(row));
    ck('  and on-hand has gone negative, where it can be seen',
       row && row.onHand < 0, JSON.stringify(row) + ' — the point is that it shows');
}

section('D — "Al combo" and "Aluminium combo", once she says so');
{
    fs.writeFileSync(cfg.LOADS_FILE, '[]');
    fs.writeFileSync(cfg.OUTBOUND_LOADS_FILE, '[]');
    fs.writeFileSync(cfg.ITEM_ALIASES_FILE, '[]');
    // Bought under BOTH spellings, which is what really happens: 700 lb
    // entered one day as "Al combo", 300 another day as "Aluminium combo".
    // Without this the report has only ONE inbound row and the folding loop
    // is never exercised — a mutation disabling it survived, because the
    // single row looked right for an unrelated reason.
    await buy('Al combo', 700);
    await buy('Aluminium combo', 300);
    await sell('Al combo', 400);

    // Before her answer this is refused — which is the WARNING she asked for,
    // arriving at the moment it can still be fixed.
    const twoRows = await inventory();
    ck('before her answer, one metal reports as TWO rows',
       (twoRows.byType || []).filter((g) => /combo/i.test(g.description)).length === 2,
       (twoRows.byType || []).map((g) => `${g.description}:${g.onHand}`).join(' | ') +
       ' — this is the split she was looking at');

    // 300 is on hand under the second name, so 800 is more than that spelling
    // holds — and the split is exactly why. Since 2026-09-16 it warns rather
    // than refusing ("just provide warning that can be overriden"), so the
    // sale IS written; what is asserted is that she is told.
    //
    // It is deliberately NOT sold here. Recording it would shift the numbers
    // the rest of this section checks, and the subject of those checks is the
    // merge, not the warning.
    const wouldWarn = await req('POST', '/api/outbound-loads', { sid: admin, body: {
        date: '2026-09-15', buyer: 'Eccomelt', weight_unit: 'lb',
        items: [{ description: 'Aluminium combo', gross_weight: 800, tare_weight: 0, price: 2 }],
    } });
    ck('selling more than that name holds warns', !!(wouldWarn.json && wouldWarn.json.stock_warning),
       JSON.stringify(wouldWarn.json) + ' — 300 came in under this spelling, 800 is going out');
    // Undone, so the merge assertions below read the numbers they describe.
    if (wouldWarn.json && wouldWarn.json.load) {
        await req('DELETE', `/api/outbound-loads/${encodeURIComponent(wouldWarn.json.load.id)}`, { sid: admin });
    }

    const yes = await req('POST', '/api/item-aliases', { sid: admin, body: {
        a: 'Aluminium combo', b: 'Al combo', same: true } });
    ck('  her answer is recorded', yes.status === 200 && yes.json.alias.same === true);
    ck('  and recorded as HERS, not the machine', yes.json.alias.source === 'user',
       'an AI verdict must never be stored as settled, or one wrong guess becomes permanent');

    const now = await sell('Aluminium combo', 300);
    ck('  and then the same sale goes through', now.status === 200, JSON.stringify(now.json));
    ck('    with no warning, because the stock is genuinely there now',
       !now.json.stock_warning, JSON.stringify(now.json && now.json.stock_warning) +
       ' — the whole point of her answering the question');

    const inv = await inventory();
    const rows = (inv.byType || []).filter((g) => /combo/i.test(g.description));
    ck('ONE row, not two', rows.length === 1, rows.map((r) => `${r.description}:${r.onHand}`).join(' | '));
    ck('  with the two inbound lots ADDED, not just relabelled',
       rows[0] && rows[0].net === 1000, JSON.stringify(rows[0]) +
       ' — 700 under one spelling plus 300 under the other');
    ck('  reading 1000 in, 700 shipped, 300 left', rows[0] && rows[0].net === 1000
       && rows[0].shipped === 700 && rows[0].onHand === 300, JSON.stringify(rows[0]));
    ck('  and labelled with the spelling she uses, not the key',
       rows[0] && rows[0].description === 'Al combo', rows[0] && rows[0].description);
}

section('E — what must NOT merge');
{
    // The whole reason nothing is joined by resemblance. These two differ by
    // ONE character and are different alloys worth different money; a fuzzy
    // matcher would combine them and quietly corrupt a stock figure.
    ck('two alloys are not joined just because they look alike',
       aliases.canonicalKey('Al 6061') !== aliases.canonicalKey('Al 6063'));

    const no = await req('POST', '/api/item-aliases', { sid: admin, body: {
        a: 'Al 6061', b: 'Al 6063', same: false } });
    ck('  saying NO is recorded as firmly as saying yes', no.status === 200 && no.json.alias.same === false,
       'a store that only keeps agreement becomes a nagging machine, and then ' +
       'the prompt that matters gets clicked through with the rest');
    ck('  and they still do not merge', aliases.canonicalKey('Al 6061') !== aliases.canonicalKey('Al 6063'));

    // ── AND WHAT THE MACHINE'S OWN OPINION IS WORTH ──────────────────────
    // Nothing, until she confirms it. Written directly rather than through
    // the route, because the route forces source:'user' on purpose — there
    // is deliberately no way for a client to file an AI verdict as settled.
    //
    // Two mutations survived until this existed: one dropping the source
    // check in settled(), one dropping it in groupOf(). Both are the same
    // failure — one wrong guess becoming permanent truth with nobody asked.
    await aliases.remember('Zorba', 'Al combo', true, { source: 'ai' });
    ck('an AI verdict is NOT treated as settled', aliases.settled('Zorba', 'Al combo') === null,
       JSON.stringify(aliases.settled('Zorba', 'Al combo')));
    ck('  and does NOT join the two in a report',
       aliases.canonicalKey('Zorba') !== aliases.canonicalKey('Al combo'),
       'a guess that silently merges two materials makes a stock figure quietly false');
    ck('  so she is still asked about it',
       (await suggestItemMatch('Zorba', ['Al combo'], { ask: async () => ({ match: 'Al combo', confidence: 'high' }) })).ask === true);

    // Having said no, she must never be asked about that pair again.
    const asked = await suggestItemMatch('Al 6063', ['Al 6061'], { ask: async () => ({ match: 'Al 6061', confidence: 'high' }) });
    ck('  and she is never asked about it again', asked.ask === false && asked.why === 'all_decided',
       JSON.stringify(asked));
}

section('F — the suggestion never invents a material');
{
    const stock = ['Al combo', 'Copper #2 birch/cliff'];
    // A name with NO prior decision. The first version reused "Aluminium
    // combo", which section D had already matched — so suggestItemMatch
    // short-circuited on already_matched and never reached the guard this
    // section exists to test. The check was failing for the right reason and
    // testing the wrong thing.
    const invented = await suggestItemMatch('Zorba', stock,
        { ask: async () => ({ match: 'Al COMBO SCRAP XYZ', confidence: 'high' }) });
    ck('a name not in stock is discarded', invented.ask === false && invented.why === 'not_in_stock',
       JSON.stringify(invented) + ' — offering a material that does not exist is worse than offering nothing');

    const unsure = await suggestItemMatch('Mystery metal', stock, { ask: async () => ({ match: 'Al combo', confidence: 'low' }) });
    ck('  a low-confidence guess is not put to her', unsure.ask === false && unsure.why === 'unsure');

    // Every failure path returns silence, never an exception: a sale must be
    // recordable when a suggestion service is down.
    for (const [label, answer] of [['no key / no answer', null], ['bad JSON', 'not json'], ['empty match', { match: '', confidence: 'high' }]]) {
        const out = await suggestItemMatch('Zorba', stock, { ask: async () => answer });
        ck(`  ${label} is silent, not fatal`, out && out.ask === false, JSON.stringify(out));
    }

    ck('  and ranking puts the plausible candidate first',
       affinity('Aluminium combo', 'Al combo') > affinity('Aluminium combo', 'Copper #2 birch/cliff'),
       'ranking only chooses which question to ask — it never decides anything');
}

section('G — an edit is not refused for its own weight');
{
    fs.writeFileSync(cfg.LOADS_FILE, '[]');
    fs.writeFileSync(cfg.OUTBOUND_LOADS_FILE, '[]');
    await buy('Al combo', 1000);
    const made = await sell('Al combo', 900);
    const id = made.json && (made.json.id || (made.json.load && made.json.load.id));
    ck('a sale of 900 out of 1000 is fine', made.status === 200, JSON.stringify(made.json));

    // Correcting 900 to 880 must be allowed. Without adding this load's own
    // weight back first, its original 900 still counts against stock and the
    // correction is refused — an edit that reduces a figure being blocked for
    // being too large.
    const down = await req('PUT', `/api/outbound-loads/${encodeURIComponent(id)}`, { sid: admin, body: {
        date: '2026-09-15', buyer: 'Eccomelt', weight_unit: 'lb',
        items: [{ description: 'Al combo', gross_weight: 880, tare_weight: 0, price: 2 }],
    } });
    ck('  correcting it DOWN to 880 is allowed', down.status === 200, JSON.stringify(down.json));
    // AND with no warning. Now that nothing is refused, "allowed" is true of
    // every edit — so the exclusion is only observable through the warning
    // being absent. Without this the check above passes on a broken guard.
    ck('    and comes back clean, which is what the exclusion is for',
       !down.json.stock_warning, JSON.stringify(down.json && down.json.stock_warning));

    const up = await req('PUT', `/api/outbound-loads/${encodeURIComponent(id)}`, { sid: admin, body: {
        date: '2026-09-15', buyer: 'Eccomelt', weight_unit: 'lb',
        items: [{ description: 'Al combo', gross_weight: 1200, tare_weight: 0, price: 2 }],
    } });
    ck('  while raising it past stock warns instead of refusing',
       up.status === 200 && !!up.json.stock_warning,
       JSON.stringify(up.json) + ' — she reversed the block on 2026-09-16; what matters on an edit is that the exclusion still works, so 880 passes clean and 1200 does not')
}

section('H — the clients still ask about the NAME');
{
    // The ordering is the design. Most refusals are not a shortage at all —
    // they are one metal typed two ways. Asking about the override first
    // would teach her to click through a prompt whose real answer is "you
    // typed it differently", and the stock figure would stay wrong.
    for (const [label, file] of [['website', 'dashboard/index.html'], ['app', 'mobile-app/www/index.html']]) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        const fn = src.slice(src.indexOf('async function handleStockShort'),
                             src.indexOf('async function handleStockShort') + 3000).replace(/\/\/[^\n]*/g, '');
        ck(`${label}: the naming question is still asked`,
           fn.indexOf('/api/item-aliases/suggest') !== -1,
           'the spelling is still the likeliest cause, and asking is what stops it recurring');
        ck(`${label}:   both answers are recorded, not just "same"`,
           /same,\s*\}\)/.test(fn) && !/same: true/.test(fn),
           'storing only agreement turns this into a nagging machine');
        // She reversed the block on 2026-09-16 ("just provide warning that can
        // be overriden"), so there is nothing to retry and nothing to
        // override: the sale is already saved by the time this runs.
        ck(`${label}:   nothing is retried, because nothing was refused`,
           !/await sendSale\(/.test(fn),
           'a retry here would record the sale a second time');
        ck(`${label}:   allow_negative is gone entirely`,
           !/allow_negative/.test(fn),
           'an override for a rule that no longer exists is a switch nobody can explain');
        ck(`${label}:   and the warning is skipped when she has just explained it away`,
           /if \(learned\) return;/.test(fn),
           'warning that stock is short right after she said it is not reads as not listening');
    }
}

section('I — profit, and how much of it is actually known');
{
    // Apsara picked this report off a list because it existed nowhere:
    // "Profit — bought vs sold". The app test stubs the route, so the MATHS
    // is exercised here — a mutation computing the margin over sales with no
    // known cost survived until this section existed.
    fs.writeFileSync(cfg.LOADS_FILE, '[]');
    fs.writeFileSync(cfg.OUTBOUND_LOADS_FILE, '[]');
    fs.writeFileSync(cfg.ITEM_ALIASES_FILE, '[]');

    const bought = (await req('POST', '/api/loads', { sid: admin, body: {
        date: '2026-09-10', seller: 'Ramesh', buyer: 'Edge Trading', weight_unit: 'lb',
        items: [{ description: 'Al combo', gross_weight: 1000, tare_weight: 0, price: 0.50 }],
    } })).json;
    const loadId = bought && (bought.id || (bought.load && bought.load.id));

    // One sale LINKED to the load it came from, one not. That mix is the
    // normal state of the yard, and it is what makes coverage meaningful.
    await req('POST', '/api/outbound-loads', { sid: admin, body: {
        date: '2026-09-15', buyer: 'Eccomelt', weight_unit: 'lb',
        linked_inbound_load_ids: [loadId],
        items: [{ description: 'Al combo', gross_weight: 600, tare_weight: 0, price: 1.00 }],
    } });
    await req('POST', '/api/outbound-loads', { sid: admin, body: {
        date: '2026-09-15', buyer: 'Daekwang', weight_unit: 'lb',
        items: [{ description: 'Al combo', gross_weight: 200, tare_weight: 0, price: 1.20 }],
    } });

    const r = (await req('GET', '/api/reports/yard-profit?from=2026-09-01&to=2026-09-30', { sid: admin })).json || {};
    const m = r.margin || {};
    ck('revenue is every sale in the range', m.revenue === 840, JSON.stringify(m));
    ck('  cost is only the material that was LINKED', m.cost_of_material_sold === 500, JSON.stringify(m));
    ck('  and the margin is the difference', m.margin === 340, JSON.stringify(m));

    // ── THE HONEST PART ──────────────────────────────────────────────────
    // 600 of 840 has a cost behind it. A margin quietly computed on 71% of
    // sales and shown as the whole business is the most misleading number
    // this app could produce.
    ck('coverage says how much of the sales the margin covers',
       m.coverage_pct === 71.4, `coverage ${m.coverage_pct}% — 600 linked of 840 sold`);
    ck('  and it is said in words, not left as a number to interpret',
       /71\.4/.test(m.caveat || '') && /not linked/.test(m.caveat || ''), m.caveat);

    // The cash block must never be mistaken for profit.
    ck('the cash figures are separate from the margin',
       r.cash && r.cash.bought === 500 && r.cash.sold === 840, JSON.stringify(r.cash));
    ck('  and carry the warning that they are NOT profit',
       /NOT profit/.test((r.cash || {}).note || ''),
       'metal bought this month is usually sold in another — read as profit, ' +
       'a big purchase looks like a loss it never was');
    ck('  with nothing unreadable', Array.isArray(r.partial) && r.partial.length === 0,
       JSON.stringify(r.partial));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
server.close();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\n  THREW:', e.stack || e.message); try { server.close(); } catch {} process.exit(1); });
