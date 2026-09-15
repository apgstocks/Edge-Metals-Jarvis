// ── tests/address-refresh-bol-delete.js ───────────────────────────────────
// Two things Apsara asked for on 2026-09-16, in one file because they touch
// the same two screens.
//
//   "when i add a address ,post opening the app-i have to logout for the
//    change to be seen.change that.."
//   "also add delete option in bol generated"
//
// ── WHY THE ADDRESS BUG NEEDED DRIVING, NOT GREPPING ────────────────────────
// The cause was a one-line guard — `if (!docsAddressBook.length)` — around a
// fetch. Removing it LOOKS right in a diff and proves nothing: what matters
// is whether entering the Documents tab a SECOND time actually hits the
// server again. So section A enters the tab twice in jsdom and counts the
// requests. A source check would pass against a version that fetches once
// into a variable nobody reads.
//
// ── AND WHY THE FAILED-REFRESH CASE IS HERE ─────────────────────────────────
// The obvious fix makes a worse bug. The old code did
// `catch { docsAddressBook = []; }` — so one request failing on a bad signal
// in the yard emptied a perfectly good list. Refreshing on every tab entry
// turns that from a rare annoyance into a reliable way to lose the typeahead.
// A stale list is useful; an empty one is not. Section B fails the network
// and asserts the list survived.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-addr-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD   = 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

const APP = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');
const WEB = fs.readFileSync(path.join(ROOT, 'dashboard/documents.html'), 'utf8');

// Comments are STRIPPED before any source scan below. Twice already in this
// project an assertion has been satisfied by the comment explaining the rule
// rather than by the code obeying it — `delivery_eta` and `window.open` both.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const APP_CODE = stripComments(APP);
const WEB_CODE = stripComments(WEB);

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the app refetches the address book every time she opens Docs');
// ══════════════════════════════════════════════════════════════════════════
{
    const hits = [];
    let book = [{ id: 'a1', aliases: ['Eccomelt'], raw: '123 Mill Rd' }];
    let failNext = false;

    const ROUTES = () => ({
        '/api/me': { ok: true, role: 'admin', super: false },
        '/api/loads': [], '/api/outbound-loads': [], '/api/load-drafts': [],
        '/api/item-types': { ok: true, items: ['Al combo'] },
        '/api/address-book': book,
        '/api/contacts': { ok: true, contacts: [], groups: [] },
        '/api/bols': { ok: true, bols: [] },
    });

    const dom = new JSDOM(APP, {
        runScripts: 'dangerously', url: 'http://localhost/',
        beforeParse(w) {
            w.fetch = (u) => {
                const k = String(u).split('?')[0].replace(/^https?:\/\/[^/]+/, '');
                if (k === '/api/address-book') {
                    hits.push(k);
                    if (failNext) return Promise.reject(new Error('network down'));
                }
                const r = ROUTES();
                return Promise.resolve({ ok: true, status: 200,
                    json: () => Promise.resolve(k in r ? r[k] : { ok: true }) });
            };
            w.alert = () => {}; w.confirm = () => true;
        },
    });
    await new Promise((r) => setTimeout(r, 700));
    const w = dom.window;

    // ── First visit ──────────────────────────────────────────────────────
    await w.renderDocumentsTab();
    await new Promise((r) => setTimeout(r, 120));
    const afterFirst = hits.length;
    ck('opening Documents loads the address book', afterFirst >= 1, `${afterFirst} requests`);

    // ── She adds a contact somewhere else, then comes back ───────────────
    // This is her exact complaint. The old code's `if (!docsAddressBook.length)`
    // meant this second visit never asked the server, so Daekwang stayed
    // invisible until the session was torn down and rebuilt — i.e. logout.
    book = book.concat([{ id: 'a2', aliases: ['Daekwang'], raw: '9 Harbour St' }]);
    await w.renderDocumentsTab();
    await new Promise((r) => setTimeout(r, 120));
    ck('re-opening Documents asks the server AGAIN', hits.length > afterFirst,
       `${hits.length} total vs ${afterFirst} — a cached-forever list is the logout bug`);

    // The request happening is not the point; the NEW NAME being FINDABLE is.
    // A refetch into a variable the typeahead does not read would pass the
    // check above and still fail her.
    //
    // Asked through docSearchAddressBook — the function the consignee
    // typeahead itself calls — and not by reading docsAddressBook off the
    // window. That variable is a top-level `let`, which is NOT a window
    // property (the trap this project has now hit six times); the first
    // version of these two checks read `undefined`, reported `[]`, and blamed
    // the code for the fixture's mistake. A top-level `function`, by
    // contrast, IS reachable — so the search function is the way in.
    const found = (q) => (w.docSearchAddressBook(q) || []).flatMap((e) => e.aliases || []);
    ck('  and the newly added contact is findable without logging out',
       found('daekwang').includes('Daekwang'), JSON.stringify(found('daekwang')));

    // ══════════════════════════════════════════════════════════════════════
    section('B — a failed refresh keeps the last good list');
    // ══════════════════════════════════════════════════════════════════════
    // The regression the fix could easily have introduced: refreshing on every
    // tab entry while still blanking the cache on error means one bad moment
    // of signal empties the typeahead entirely.
    failNext = true;
    await w.renderDocumentsTab();
    await new Promise((r) => setTimeout(r, 120));
    ck('a refresh that fails does NOT empty the address book',
       found('eccomelt').includes('Eccomelt') && found('daekwang').includes('Daekwang'),
       JSON.stringify(found('e').concat(found('d'))) + ' — a stale list is useful, an empty one is not');
    failNext = false;

    // ── ONE list, not two ────────────────────────────────────────────────
    // Saving a load with an unknown seller auto-creates a contact. It used to
    // land in addressBookCache only, so the Documents consignee typeahead
    // could not see a contact the Loads screen had just made.
    //
    // NOT asserted by comparing the two variables off the window — both are
    // top-level `let`, both read as undefined, and `undefined === undefined`
    // made the first version of this check pass no matter what the code did.
    // A vacuous assertion is worse than no assertion: it reports green.
    // Asked instead through each side's own lookup, which is what the screens
    // actually use.
    ck('the Loads screen and the Documents screen see the same contacts',
       !!w.addressBookExactMatch('Daekwang') && found('daekwang').length > 0,
       'two copies of one list drift, and the drift is invisible');

    dom.window.close();
}

// ══════════════════════════════════════════════════════════════════════════
section('C — the guard that caused it cannot come back');
// ══════════════════════════════════════════════════════════════════════════
{
    ck('the fetch-once guard is gone from the app',
       !/if\s*\(\s*!\s*docsAddressBook\.length\s*\)/.test(APP_CODE),
       'this exact line is what made her log out');

    // Neither client may empty its cache in a catch. Asserted on stripped
    // source so the comments explaining the rule cannot satisfy it.
    ck('the app never blanks the cache on a failed fetch',
       !/catch[^{]*\{[^}]*(addressBookCache|docsAddressBook)\s*=\s*\[\]/.test(APP_CODE));
    ck('the website never blanks the cache on a failed fetch',
       !/catch[^{]*\{[^}]*addressBook\s*=\s*(\[\]|d\s*\|\|\s*\[\])/.test(WEB_CODE));

    // The website's Documents page holds its own snapshot too: the Address
    // Book is a SEPARATE page, so a contact added in another browser tab is
    // invisible here until this one is reloaded.
    ck('the website refreshes on sub-tab entry', /refreshAddressBook\(\)/.test(WEB_CODE));
    ck('  from setSubtab, which is where she arrives',
       /name === 'proforma' \|\| name === 'bol'\) refreshAddressBook\(\)/.test(WEB_CODE));
}

// ══════════════════════════════════════════════════════════════════════════
section('D — deleting a generated BOL, against a real server');
// ══════════════════════════════════════════════════════════════════════════
{
    const { createApi } = require(path.join(ROOT, 'api'));
    const audit = require(path.join(ROOT, 'helpers/audit'));
    const bols = require(path.join(ROOT, 'helpers/bols'));

    const app = createApi();
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r2 = http.request(base + p, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
        });
        r2.on('error', reject); if (data) r2.write(data); r2.end();
    });

    const admin = ((await req('POST', '/login', { body: { password: 'admin-pw-bbbbbbbbbbb' } })).json || {}).sid;
    const staff = ((await req('POST', '/login', { body: { password: 'staff-pw-ccccccccccc' } })).json || {}).sid;

    const saved = await bols.saveBol({
        bol_no: 'EM-2026-014', bol_date: '2026-09-16', consignee_name: 'Eccomelt',
        container_no: 'TCLU1234567', weight_unit: 'lb',
        items: [{ description: 'Al combo', pieces: '12', gross_weight: '46,300', tare_weight: '300', net_weight: '46,000' }],
    });

    const before = audit.listEntries().length;

    // Staff must not reach it. This is the same shape as every other delete
    // in this file, and worth pinning: the route is admin-gated by a
    // middleware that a refactor could drop without any test noticing.
    const refused = await req('DELETE', `/api/bols/${encodeURIComponent(saved.id)}`, { sid: staff });
    ck('staff cannot delete a bill of lading', refused.status === 401 || refused.status === 403,
       JSON.stringify(refused));
    ck('  and the refused attempt left the record alone',
       !!bols.getBol(saved.id), 'a half-refused delete is worse than an allowed one');

    const gone = await req('DELETE', `/api/bols/${encodeURIComponent(saved.id)}`, { sid: admin });
    ck('admin can delete it', gone.status === 200, JSON.stringify(gone.json));
    ck('  it leaves the list', !bols.getBol(saved.id));
    ck('  and deleting it twice says so rather than pretending',
       (await req('DELETE', `/api/bols/${encodeURIComponent(saved.id)}`, { sid: admin })).status === 404);

    // ── THE AUDIT ENTRY ──────────────────────────────────────────────────
    // This route predates her "Log every deletion" decision and was the last
    // delete in api.js writing no trace at all.
    const entries = audit.listEntries();
    ck('the deletion is logged', entries.length > before, `${before} -> ${entries.length}`);
    const row = entries.filter((e) => e.subject === saved.id).pop();
    ck('  under its own action name, not "unknown-action"',
       row && row.action === 'delete-bol',
       row ? `${row.action} / requested ${row.requested_action}` : 'no entry');
    // "deleted bol 7f3a" is useless six weeks later. The detail is read
    // BEFORE the delete precisely so this is answerable afterwards.
    ck('  naming which document went, not just its id',
       row && row.detail && row.detail.bol_no === 'EM-2026-014' && row.detail.consignee_name === 'Eccomelt',
       JSON.stringify(row && row.detail));
    ck('  and stamped as finished', row && row.outcome === 'done', row && row.outcome);

    server.close();
}

// ══════════════════════════════════════════════════════════════════════════
section('E — the button exists and is wired, on BOTH clients');
// ══════════════════════════════════════════════════════════════════════════
{
    // A button rendered but unwired looks perfect in source and does nothing.
    // Checked as a pair for that reason.
    ck('website: the saved-BOL list has a Delete button',
       /class="btn btn-secondary bol-del"/.test(WEB_CODE));
    ck('  wired to a handler', /\.bol-del'\)\.forEach/.test(WEB_CODE) && /function bolDelete\(/.test(WEB_CODE));
    ck('  carrying the BOL NUMBER, so the prompt can name it',
       /bol-del[^>]*data-no="/.test(WEB_CODE),
       'a column of near-identical rows is where a generic confirm gets a reflex Yes');

    ck('app: the saved-BOL list has a Delete button', /class="btn bolw-del"/.test(APP_CODE));
    ck('  wired to a handler', /\.bolw-del'\)\.forEach/.test(APP_CODE) && /function bolDeleteApp\(/.test(APP_CODE));
    ck('  carrying the BOL number too', /bolw-del[^>]*data-no="/.test(APP_CODE));

    // ── WHAT DELETE ACTUALLY MEANS ───────────────────────────────────────
    // The server keeps the archived PDF. Someone told "delete" without that
    // sentence would reasonably believe the document itself was destroyed —
    // and might re-issue under a new number to a driver already holding one.
    for (const [name, code] of [['website', WEB_CODE], ['app', APP_CODE]]) {
        const fn = code.slice(code.indexOf(name === 'website' ? 'async function bolDelete(' : 'async function bolDeleteApp('));
        const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
        ck(`${name}: it asks before deleting`, /confirm\(/.test(body));
        ck(`  and the prompt says the PDF is KEPT`, /KEPT|kept/.test(body),
           'delete here removes the form, not the document that is already with a driver');
        ck(`  and the prompt names the BOL`, /\$\{label\}/.test(body),
           'generic prompts get a reflex Yes on the wrong row');
        ck(`  the list is redrawn afterwards`,
           /loadSavedBols\(\)|loadSavedBolsApp\(\)/.test(body));
    }

    // Deleting the row that is currently open in the form must clear it —
    // otherwise Generate silently re-creates the record she just removed,
    // under the same number, and the delete looks like it never worked.
    ck('website: deleting the row being edited clears the form',
       /bolEditingId === id\) bolClearForm\(\)/.test(WEB_CODE));
    ck('  and the cleared form goes back to TODAY, not blank',
       /function bolClearForm\(\)[\s\S]{0,700}bolTodayStr\(\)/.test(WEB_CODE),
       'a blank default would let the next BOL generate with no date');
    ck('app: deleting the row being edited clears the form',
       /bolw\.editingId === id\)[\s\S]{0,80}resetBolForm\(\)/.test(APP_CODE));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error(e); process.exit(1); });
