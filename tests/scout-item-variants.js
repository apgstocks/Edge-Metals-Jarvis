// ── tests/scout-item-variants.js — Scout finds item twins, she confirms ─────
// Apsara, 2026-11-18: "Rotor and Rotors ... all this cleaning should be handled by Scout automatically"; asked how
// far, "Scout finds, you confirm". find_item_variants only LISTS; merge_item_names is only ever a confirm card.
//   A  what counts as a twin (and what must not)
//   B  the read tool: lists, writes nothing
//   C  the confirm card: untrusted input, admin only, nothing written until confirmed
//   D  confirming merges names only, keeps ferrous answer, undo works
//   E  END TO END through /api/yard/act and the Item maintenance route
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
let pass = 0, fail = 0; const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); if (x) console.log('        ' + x); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-scoutvar-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaaa'; process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb'; process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc';
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
const { loadJson } = require(path.join(ROOT, 'helpers/json'));
const IM = require(path.join(ROOT, 'helpers/itemMaintenance'));
const M = require(path.join(ROOT, 'helpers/itemMetal'));
const tools = require(path.join(ROOT, 'helpers/tools'));
const ya = require(path.join(ROOT, 'helpers/yardActions'));
const loads = require(path.join(ROOT, 'helpers/loads'));
const outbound = require(path.join(ROOT, 'helpers/outboundLoads'));
const buy = (date, desc, w) => loads.addLoad({ date, seller: 'S', weight_unit: 'lb', items: [{ description: desc, gross_weight: w, tare_weight: 0, price: 1 }] });
const sell = (date, desc, w) => outbound.addOutboundLoad({ date, buyer: 'B', weight_unit: 'lb', items: [{ description: desc, gross_weight: w, tare_weight: 0, price: 2 }] });
const files = () => [cfg.LOADS_FILE, cfg.OUTBOUND_LOADS_FILE].map((f) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '').join('|');

(async () => {
    section('A — what is a twin');
    {
        const same = (a, b) => IM.twinKey(a) === IM.twinKey(b);
        ck('Rotor / Rotors', same('Rotor', 'Rotors'));
        ck('case and spacing: "ROTORS" / "rotors "', same('ROTORS', ' rotors '));
        ck('hyphen: Al-combo / Al combo', same('Al-combo', 'Al combo'));
        ck('y/ies: Battery / Batteries', same('Battery', 'Batteries'));
        ck('different grade is NOT a twin (Aluminium 6061 / 6063)', !same('Aluminium 6061', 'Aluminium 6063'));
        ck('different word is NOT a twin (Copper wire / Copper pipe)', !same('Copper wire', 'Copper pipe'));
        ck('a name ending in ss is not stripped (Brass / Bras)', !same('Brass', 'Bras'));
    }

    await buy('2026-11-01', 'Rotors', 1000); await buy('2026-11-02', 'Rotors', 500); await buy('2026-11-03', 'Rotor', 200);
    await buy('2026-11-04', 'Al-combo', 300); await buy('2026-11-05', 'Al combo', 100); await buy('2026-11-06', 'Steel', 900);
    await sell('2026-11-07', 'Rotor', 100);
    await buy('2026-11-08', 'Scrap Cans', 50); await buy('2026-11-08', 'Scrap Can', 40);
    await M.remember('Scrap Cans', 'ferrous'); await M.remember('Scrap Can', 'non-ferrous');
    await M.remember('Rotor', 'ferrous');

    section('B — the read tool');
    {
        ck('it is a READ tool and not a write tool', tools.readToolNames().includes('find_item_variants') && !tools.writeToolNames().includes('find_item_variants'));
        const before = files();
        const r = await tools.runRead('find_item_variants', {});
        ck('it finds Rotor/Rotors and Al combo twins, and not Steel', r.groups.some((g) => g.names.map((n) => n.name).sort().join() === 'Rotor,Rotors') && r.groups.some((g) => g.names.length === 2 && /al.combo/i.test(g.suggested)) && !r.groups.some((g) => /steel/i.test(g.suggested)), JSON.stringify(r.groups.map((g) => g.suggested)));
        const rot = r.groups.find((g) => /^rotor/i.test(g.suggested));
        ck('it suggests the spelling used most (Rotors: 2 loads vs 1 + a sale)', rot.suggested === 'Rotors' || rot.suggested === 'Rotor', rot.suggested);
        ck('names carry their counts', rot.names.every((n) => n.lines >= 1));
        ck('two names filed as ferrous AND non-ferrous are flagged as a conflict', r.groups.find((g) => /scrap can/i.test(g.suggested)).conflict === true && rot.conflict === false);
        ck('reading wrote nothing', files() === before);
        ck('its description tells the model never to merge a conflict', /conflict/.test(tools.TOOLS.find_item_variants.description));
    }

    section('C — the confirm card');
    {
        const before = files();
        const card = await ya.proposeAction({ kind: 'merge_item_names', params: { from: ['Rotor', 'Rotors'], to: 'Rotors' } }, { role: 'admin' });
        ck('a card comes back with the exact change', /Rotor.*Rotors/.test(card.summary) && card.details.some((d) => d[0] === 'Not changed'), card.summary);
        ck('proposing wrote nothing', files() === before);
        const err = async (p, ctx) => { try { await ya.proposeAction({ kind: 'merge_item_names', params: p }, ctx || { role: 'admin' }); return null; } catch (e) { return e.message; } };
        ck('an item that does not exist is refused, nothing proposed', /cannot find an item called "Nonexistent"/.test(await err({ from: ['Nonexistent', 'Rotors'], to: 'Rotors' }) || ''));
        ck('a missing target is refused', !!(await err({ from: ['Rotor'], to: '' })));
        ck('staff cannot even propose it (it rewrites saved loads)', /only the manager/.test(await err({ from: ['Rotor', 'Rotors'], to: 'Rotors' }, { role: 'staff' }) || ''));
        ck('the conflict warning shows when metal types differ', (await ya.proposeAction({ kind: 'merge_item_names', params: { from: ['Scrap Can', 'Scrap Cans'], to: 'Scrap Cans' } }, { role: 'admin' })).warnings.length === 1);
        let stale = null; try { await ya.confirmAction(card.id, { role: 'staff' }); } catch (e) { stale = e.message; }
        ck('a staff confirm of an admin card is refused at the write itself', /Only the manager/.test(stale || ''));
        ck('  and nothing changed', files() === before);
    }

    section('D — confirming');
    let mergeId = null;
    {
        const card = await ya.proposeAction({ kind: 'merge_item_names', params: { from: ['Rotor', 'Rotors'], to: 'Rotors' } }, { role: 'admin' });
        const w0 = loads.loadLoads().concat(outbound.loadOutboundLoads()).map((l) => l.items.map((i) => [i.net_weight, i.price, i.amount].join(':')).join(',')).join('|');
        const out = await ya.confirmAction(card.id, { role: 'admin' });
        mergeId = out.result.id;
        const names = loads.loadLoads().concat(outbound.loadOutboundLoads()).flatMap((l) => l.items.map((i) => i.description));
        ck('every Rotor line is now Rotors, on loads bought and sold', !names.includes('Rotor') && names.filter((n) => n === 'Rotors').length === 4, names.join());
        const w1 = loads.loadLoads().concat(outbound.loadOutboundLoads()).map((l) => l.items.map((i) => [i.net_weight, i.price, i.amount].join(':')).join(',')).join('|');
        ck('weights, prices and amounts are untouched', w0 === w1);
        ck('her ferrous answer moved to the merged name', M.typeOf('Rotors') === 'ferrous');
        ck('it is in the rename journal, so Undo in Settings works', (loadJson(cfg.ITEM_RENAMES_FILE, []).find((e) => e.id === mergeId) || {}).by === 'scout');
        let again = null; try { await ya.confirmAction(card.id, { role: 'admin' }); } catch (e) { again = e; }
        ck('a second tap does nothing (single use)', !!again);
        ck('the twins are gone from the finder', !(await tools.runRead('find_item_variants', {})).groups.some((g) => /^rotor/i.test(g.suggested)));
        await IM.undo(mergeId);
        ck('Undo puts the old spellings back', loads.loadLoads().flatMap((l) => l.items.map((i) => i.description)).includes('Rotor'));
    }

    section('E — through the real server');
    {
        const { createApi } = require(path.join(ROOT, 'api'));
        const server = await new Promise((r) => { const s = createApi().listen(0, '127.0.0.1', () => r(s)); });
        const req = (m, p, body, sid) => new Promise((res, rej) => { const d = body ? JSON.stringify(body) : null; const h = {}; if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); } if (sid) h.Authorization = 'Bearer ' + sid; const q = http.request(`http://127.0.0.1:${server.address().port}${p}`, { method: m, headers: h }, (r) => { let raw = ''; r.on('data', (c) => raw += c); r.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} res({ status: r.statusCode, json: j }); }); }); q.on('error', rej); if (d) q.write(d); q.end(); });
        const admin = (await req('POST', '/login', { password: process.env.ADMIN_PASSWORD })).json.sid;
        const staff = (await req('POST', '/login', { password: process.env.STAFF_PASSWORD })).json.sid;
        const card = await ya.proposeAction({ kind: 'merge_item_names', params: { from: ['Al-combo', 'Al combo'], to: 'Al combo' } }, { role: 'admin' });
        const staffTry = await req('POST', '/api/yard/act', { id: card.id }, staff);
        ck('staff confirming through the real route is refused', staffTry.status >= 400, JSON.stringify(staffTry.json));
        const card2 = await ya.proposeAction({ kind: 'merge_item_names', params: { from: ['Al-combo', 'Al combo'], to: 'Al combo' } }, { role: 'admin' });
        const okTry = await req('POST', '/api/yard/act', { id: card2.id }, admin);
        ck('the manager confirming through /api/yard/act merges them', okTry.status === 200 && okTry.json.ok === true, JSON.stringify(okTry.json));
        const list = (await req('GET', '/api/item-maintenance', null, admin)).json.items.map((i) => i.name);
        ck('the Item maintenance screen now lists ONE Al combo, as the screen reads it', list.filter((n) => /al.combo/i.test(n)).length === 1 && !list.includes('Al-combo'), list.join());
        const hist = (await req('GET', '/api/item-maintenance', null, admin)).json.history;
        ck('and the merge shows under Recent renames so she can Undo it', hist.some((h) => h.to === 'Al combo'));
        server.close();
    }
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
