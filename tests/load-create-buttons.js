// ── tests/load-create-buttons.js ──────────────────────────────────────────
// Apsara, 2026-10-15: "on purchases,hide the sale button(create),on sale
// page,hide the create invocie button.create invoce rename to +load" — then,
// asked which client: "in edge yard".
//
// The Edge Yard Loads tab has ONE deck with an All / Purchases / Sales
// segmented filter and TWO create buttons that were both always visible:
// "+ Create invoice" (btnAddLoad, purchase mode) and "+ Sale" (btnAddSale).
// Standing on Purchases with a Sale button next to it is an invitation to
// record the wrong kind, which is the actual cost here.
//
// "+ Create invoice" never created an invoice — it opens the load form in
// purchase mode and writes an inbound load. Renamed to "+ Load". Asked and
// confirmed 2026-10-15, the modal title and its Save button moved with it
// ('New load' / 'Save load'), because landing on a form headed "Create
// invoice" after pressing "+ Load" reads like the wrong screen.
//
//   A  the label changed, and the old one is gone from that header
//   B  the filter drives which create button is on screen — DRIVEN, not read
//   C  both buttons stay in the DOM in every state
//   D  the modal's own words follow the mode, and the SALE side is unchanged
//   E  THE BLAST RADIUS: the website's Loads tab is untouched

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

process.env.JARVIS_TEST = '1';

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const APP = 'mobile-app/www/index.html';
const ROUTES = {
    '/api/me': { ok: true, role: 'admin' },
    '/api/loads': [], '/api/outbound-loads': [], '/api/load-drafts': [],
    '/api/item-types': { ok: true, items: ['Al combo'] },
    '/api/contacts': { ok: true, contacts: [], groups: [] },
};

function boot(file) {
    // The website is ASSEMBLED from dashboard/index.html plus dashboard/app/*.js
    // — reading index.html alone would load a shell with none of the code
    // under test, and every check below would pass on an empty page.
    const HTML = file === 'dashboard/index.html'
        ? require('../helpers/sourceParts').indexHtml()
        : file === APP ? require('../helpers/sourceParts').mobileHtml()
        : fs.readFileSync(path.join(ROOT, file), 'utf8');
    const store = {};
    const dom = new JSDOM(HTML, {
        runScripts: 'dangerously', url: 'http://localhost/',
        beforeParse(w) {
            w.fetch = (u) => {
                const k = String(u).split('?')[0];
                return Promise.resolve({ ok: true, status: 200,
                    json: () => Promise.resolve(k in ROUTES ? ROUTES[k] : { ok: true }) });
            };
            w.alert = () => {}; w.confirm = () => true;
            // loadKindFilter is PERSISTED, so a stale value would decide the
            // answer before the test does. Starts empty every run.
            Object.defineProperty(w, 'localStorage', { value: {
                getItem: (k) => (k in store ? store[k] : null),
                setItem: (k, v) => { store[k] = String(v); },
                removeItem: (k) => { delete store[k]; },
            } });
            w.addEventListener('error', () => {});
        },
    });
    return dom;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// VISIBLE means what the operator sees, so it reads the class the code
// actually sets rather than trusting a boolean the code also computes.
const shown = (d, id) => {
    const b = d.getElementById(id);
    return !!b && !b.classList.contains('hidden');
};

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the label');
{
    const src = require('../helpers/sourceParts').mobileHtml();
    // The header button, as it ships in the markup.
    ck('the create button reads "+ Load"', /<button id="btnAddLoad"[^>]*>\+ Load<\/button>/.test(src),
       (src.match(/<button id="btnAddLoad"[^>]*>[^<]*</) || ['?'])[0]);
    ck('  and the Sale button beside it is untouched',
       /<button id="btnAddSale" class="btn">\+ Sale<\/button>/.test(src));

    // "Create invoice" is gone from the loads screen entirely — header,
    // modal title, Save button and the error-restore path. Scoped to the
    // Loads section so an unrelated Edge Metals invoice string elsewhere in
    // this 11k-line file cannot make this pass or fail by accident.
    const from = src.indexOf('<h2 style="font-size:24px; text-transform:uppercase; margin-bottom:4px;">Yard loads</h2>');
    ck('  the Yard loads header is findable', from > 0);
    // COMMENTS STRIPPED FIRST. The comments on this change QUOTE the old
    // label to explain itself, so a raw scan matches the explanation rather
    // than the screen — this suite has already been fooled that way three
    // times today, once by a comment describing the very code it removed.
    const stripped = src.slice(from, src.indexOf("$('btnSaveLoad')", from) + 4000)
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .split('\n').filter((l) => !/^\s*(\/\/|<!--)/.test(l)).join('\n');
    ck('  the comments really were stripped', !/create invoce rename/.test(stripped),
       'the strip did not work, so the next check proves nothing');
    ck('  and "Create invoice" appears nowhere in that screen', !/Create invoice/.test(stripped),
       (stripped.match(/.{0,40}Create invoice.{0,40}/) || [''])[0]);
}

// ══════════════════════════════════════════════════════════════════════════
section('B — the filter decides which create button is on screen');
{
    const dom = boot(APP);
    await sleep(800);
    const w = dom.window, d = w.document;
    if (typeof w.loadTab === 'function') await w.loadTab('loads');
    await sleep(400);

    const bar = d.getElementById('loadKindBar');
    ck('the All / Purchases / Sales bar rendered', !!bar && bar.children.length === 3,
       bar ? `${bar.children.length} buttons` : 'no bar');

    const press = async (kind) => {
        const b = d.querySelector(`.load-kind-btn[data-kind="${kind}"]`);
        if (!b) return false;
        b.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
        await sleep(200);
        return true;
    };
    // loadKindFilter is a script-scoped `let`, which is NOT a window
    // property under jsdom, so reading w.loadKindFilter gives undefined and
    // proves nothing. aria-pressed is what paintLoadKindBar writes into the
    // DOM, so it is both observable and the thing a screen reader uses.
    const activeKind = () => {
        const on = d.querySelector('.load-kind-btn[aria-pressed="true"]');
        return on ? on.dataset.kind : null;
    };

    // DRIVEN THROUGH THE REAL CONTROL, not by calling paintLoadKindBar with
    // a kind. A test that sets the variable itself would pass even if the
    // segmented control were wired to nothing, which is the only way this
    // feature can actually be broken for her.
    ck('All (the default) shows BOTH', shown(d, 'btnAddLoad') && shown(d, 'btnAddSale'),
       `load=${shown(d, 'btnAddLoad')} sale=${shown(d, 'btnAddSale')}`);

    ck('Purchases is pressable', await press('purchase'));
    ck('  the filter actually moved', activeKind() === 'purchase', String(activeKind()));
    ck('  + Load stays', shown(d, 'btnAddLoad'));
    ck('  and the Sale button is HIDDEN', !shown(d, 'btnAddSale'),
       'standing on Purchases with a Sale button is how the wrong kind gets recorded');

    ck('Sales is pressable', await press('sale'));
    ck('  the filter actually moved', activeKind() === 'sale', String(activeKind()));
    ck('  + Sale stays', shown(d, 'btnAddSale'));
    ck('  and + Load is HIDDEN', !shown(d, 'btnAddLoad'));

    ck('back to All', await press('all'));
    ck('  shows both again', shown(d, 'btnAddLoad') && shown(d, 'btnAddSale'),
       'All is the view not claiming to be one kind — hiding a button there would leave no way to add a sale');

    // ── C ── Both elements survive every state. tests/yard-clients.js
    // section E checks btnAddSale exists in BOTH clients by name, and
    // tests/item-row-net.js opens the form through btnAddLoad. Hiding by
    // REMOVING either would turn this feature into two red suites somewhere
    // else, which is the shape of break this repo keeps paying for.
    section('C — hidden, never removed');
    for (const kind of ['purchase', 'sale', 'all']) {
        await press(kind);
        ck(`  on ${kind}: btnAddLoad is still in the DOM`, !!d.getElementById('btnAddLoad'));
        ck(`  on ${kind}: btnAddSale is still in the DOM`, !!d.getElementById('btnAddSale'));
    }

    // ── D ── The modal's own words.
    section('D — the modal follows the mode');
    await press('all');
    // GUARDED. If section C has just caught the button being REMOVED rather
    // than hidden, this line would throw and the runner would report the
    // whole file as CRASHED — losing C's clean, specific failure. A test that
    // reports "crashed" where it could report "btnAddSale is gone" makes the
    // next person debug the test instead of the bug.
    const openBtn = d.getElementById('btnAddLoad');
    ck('the + Load button is there to open the form', !!openBtn,
       'cannot drive the modal — see section C, it was probably removed rather than hidden');
    if (openBtn) openBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(250);
    const txt = (id) => { const e = d.getElementById(id); return e ? e.textContent : '(no such element)'; };
    ck('a purchase is titled "New load"', txt('loadModalTitle') === 'New load', txt('loadModalTitle'));
    ck('  and saves with "Save load"', txt('btnSaveLoad') === 'Save load', txt('btnSaveLoad'));

    // THE SALE SIDE IS UNCHANGED. She named the purchase label; if this moved
    // too it would be the widening CLAUDE.md rule 1 is about.
    if (typeof w.applyLoadModalMode === 'function') {
        w.applyLoadModalMode('sale');
        ck('a sale is still titled "Record sale"', txt('loadModalTitle') === 'Record sale', txt('loadModalTitle'));
        ck('  and still saves with "Record sale"', txt('btnSaveLoad') === 'Record sale', txt('btnSaveLoad'));
        w.applyLoadModalMode('purchase');
        ck('  and switching back restores the load wording',
           txt('loadModalTitle') === 'New load' && txt('btnSaveLoad') === 'Save load',
           `${txt('loadModalTitle')} / ${txt('btnSaveLoad')}`);
    } else {
        ck('applyLoadModalMode is reachable', false, 'cannot check the sale side');
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('D2 — the error path restores the MODE\'s label, not a fixed one');
{
    // This line read `isEdit ? 'Save changes' : 'Create invoice'` flat, so a
    // failed save on a SALE put the PURCHASE label back and the Save button
    // on a sale form said "Create invoice" until the modal was reopened.
    // Pre-existing; renaming the word without fixing the shape would have
    // left the same bug saying "Save load" instead.
    const src = require('../helpers/sourceParts').mobileHtml();
    const line = src.split('\n').find((l) => /btn\.textContent = isEdit \? 'Save changes'/.test(l));
    ck('the restore line is findable', !!line, 'the shape changed — re-anchor this check');
    ck('  and it branches on loadModalMode', !!line && /loadModalMode === 'sale'/.test(line), line);
    ck('  so it can say "Record sale"', !!line && /'Record sale'/.test(line), line);
    ck('  and no longer hardcodes one label', !!line && !/: 'Create invoice'/.test(line), line);
}

// ══════════════════════════════════════════════════════════════════════════
section('E — the WEBSITE, which is the screen she was actually looking at');
{
    // SHE MEANT THIS ONE. Asked which client, she said "in edge yard", which
    // was read as the phone app — so it was built there, and she came back
    // with a screenshot of the website's Loads tab: "This is still remaining
    // same only". mobile-app/www is not served over the web at all (routes/
    // pages.js mounts express.static on dashboard/ only), so Edge Yard the
    // APP exists solely as an APK on a phone, while the Loads tab IS the
    // Edge Yard view of the website. Both now carry the change, which is
    // also what tests/yard-clients.js section E expects of this screen.
    const dash = require('../helpers/sourceParts').indexHtml();
    const render = fs.readFileSync(path.join(ROOT, 'dashboard/app/13-loads-render.js'), 'utf8');
    const wizard = fs.readFileSync(path.join(ROOT, 'dashboard/app/04-loads-wizard.js'), 'utf8');
    const pricing = fs.readFileSync(path.join(ROOT, 'dashboard/app/05-load-pricing.js'), 'utf8');

    ck('the website create button reads "+ Load"',
       /<button id="btnAddLoad" class="btn btn-primary">\+ Load<\/button>/.test(render),
       (render.match(/<button id="btnAddLoad"[^>]*>[^<]*</) || ['?'])[0]);
    ck('  and its Sale button is untouched',
       /<button id="btnAddSale" class="btn">\+ Sale<\/button>/.test(render));
    ck('  the website modal is titled "New load"', /">New load<\/div>/.test(render));
    ck('  and saves with "Save load"', /<button id="btnSaveLoad" class="btn btn-primary">Save load<\/button>/.test(render));

    // Comments stripped, same trap as section A — these comments quote the
    // old label to explain themselves.
    const strip = (txt) => txt.replace(/<!--[\s\S]*?-->/g, ' ')
        .split('\n').filter((l) => !/^\s*(\/\/|<!--)/.test(l)).join('\n');
    for (const [name, txt] of [['13-loads-render.js', render], ['05-load-pricing.js', pricing]]) {
        ck(`  "Create invoice" is gone from ${name}`, !/Create invoice/.test(strip(txt)),
           (strip(txt).match(/.{0,40}Create invoice.{0,40}/) || [''])[0]);
    }

    ck('the website hides the create button by filter too',
       /toggleCreate\('btnAddLoad', loadKindFilter !== 'sale'\)/.test(wizard)
       && /toggleCreate\('btnAddSale', loadKindFilter !== 'purchase'\)/.test(wizard));
    ck('  from paintLoadKindBar, the one place that runs on every change',
       wizard.indexOf('toggleCreate') > wizard.indexOf('function paintLoadKindBar'));
    ck('  and hides rather than removes', /classList\.toggle\('hidden', !show\)/.test(wizard));

    ck('the website error path branches on the mode',
       /isEdit \? 'Save changes' : \(loadModalMode === 'sale' \? 'Record sale' : 'Save load'\)/.test(render),
       'a failed save on a sale would put the purchase label back');
    ck('  and the website sale side still says "Record sale"',
       /const title = sale \? 'Record sale' : 'New load';/.test(pricing)
       && /const t = sale \? 'Record sale' : 'Save load';/.test(pricing));
    ck('  with the TITLE using title, not the save wording',
       /loadModalTitle'\)\.textContent = editingLoadId \? \(sale \? 'Edit sale' : 'Edit load'\) : title;/.test(pricing));

    ck('  both create buttons still exist on the website', dash.includes('btnAddLoad') || render.includes('btnAddLoad'));
}

// ══════════════════════════════════════════════════════════════════════════
section('E2 — the website, DRIVEN through its own filter');
{
    // Section E reads the source. This one presses the buttons, because a
    // source scan cannot tell whether paintLoadKindBar is still wired to the
    // segmented control — and that wiring is the only way this can be broken
    // for her on the screen she showed in the screenshot.
    const dom = boot('dashboard/index.html');
    await sleep(900);
    const w = dom.window, d = w.document;
    if (typeof w.switchTab === 'function') w.switchTab('loads');
    await sleep(500);

    const bar = d.getElementById('loadKindBar');
    ck('the website kind bar rendered', !!bar && bar.children.length === 3,
       bar ? `${bar.children.length} buttons` : 'no bar — the Loads tab did not render');

    if (bar && bar.children.length === 3) {
        const press = async (kind) => {
            const b = d.querySelector(`.load-kind-btn[data-kind="${kind}"]`);
            if (!b) return false;
            b.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
            await sleep(250);
            return true;
        };
        const activeKind = () => {
            const on = d.querySelector('.load-kind-btn[aria-pressed="true"]');
            return on ? on.dataset.kind : null;
        };

        ck('the website shows "+ Load", not "+ Create invoice"',
           (d.getElementById('btnAddLoad') || {}).textContent === '+ Load',
           (d.getElementById('btnAddLoad') || {}).textContent);

        ck('All shows both', shown(d, 'btnAddLoad') && shown(d, 'btnAddSale'));
        await press('purchase');
        ck('Purchases: the filter moved', activeKind() === 'purchase', String(activeKind()));
        ck('  + Load stays', shown(d, 'btnAddLoad'));
        ck('  and the Sale button is HIDDEN', !shown(d, 'btnAddSale'));
        await press('sale');
        ck('Sales: the filter moved', activeKind() === 'sale', String(activeKind()));
        ck('  + Sale stays', shown(d, 'btnAddSale'));
        ck('  and + Load is HIDDEN', !shown(d, 'btnAddLoad'));
        await press('all');
        ck('All again: both back', shown(d, 'btnAddLoad') && shown(d, 'btnAddSale'));
        ck('  and both are still in the DOM throughout',
           !!d.getElementById('btnAddLoad') && !!d.getElementById('btnAddSale'));
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('F — the APK actually carries what www says');
{
    // WHY THIS EXISTS. mobile-app/www is the source; the Android project
    // builds from a COPY at android/app/src/main/assets/public. Nothing
    // checked that they agreed, and on 2026-10-15 the copy was 195 lines
    // behind — so TWO fixes Apsara had asked for and been told were done had
    // never reached her phone:
    //
    //   · the Pay-shows-$0 fix (by_source: null) — the copy still had `{}`,
    //     which is the exact bug she reported on 2026-10-14
    //   · the five-option price-unit picker — the copy still had lb/MT only
    //
    // Neither was visible from anywhere: every test read www, the suite was
    // green, and the phone was wrong. A sync step that a human remembers is a
    // sync step that eventually nobody does, so it is checked here instead.
    //
    // cordova.js and cordova_plugins.js are injected by Capacitor into the
    // assets directory and have no counterpart in www. They are NOT drift.
    const INJECTED = new Set(['cordova.js', 'cordova_plugins.js']);
    const WWW = path.join(ROOT, 'mobile-app/www');
    const ASSETS = path.join(ROOT, 'mobile-app/android/app/src/main/assets/public');

    const walk = (dir, base = '') => fs.readdirSync(path.join(dir, base), { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? walk(dir, path.join(base, e.name)) : [path.join(base, e.name)]));

    ck('the Android assets directory exists', fs.existsSync(ASSETS));
    if (fs.existsSync(ASSETS)) {
        const drift = [];
        for (const rel of walk(WWW)) {
            const a = path.join(WWW, rel), b = path.join(ASSETS, rel);
            if (!fs.existsSync(b)) { drift.push(`${rel} — missing from the APK`); continue; }
            if (fs.readFileSync(a, 'utf8') !== fs.readFileSync(b, 'utf8')) drift.push(`${rel} — differs`);
        }
        ck('every www file is in the Android assets, byte for byte', drift.length === 0,
           `${drift.length}: ${drift.join('; ')} — copy mobile-app/www over mobile-app/android/app/src/main/assets/public and rebuild the APK`);

        const extra = walk(ASSETS).filter((rel) => !INJECTED.has(rel) && !fs.existsSync(path.join(WWW, rel)));
        ck('  and the APK carries nothing www does not', extra.length === 0,
           `${extra.join('; ')} — a file only in the APK cannot be reviewed or tested`);
        ck('  the injected Capacitor files are still present, not swept away',
           [...INJECTED].every((f) => fs.existsSync(path.join(ASSETS, f))),
           'deleting these breaks the native bridge');
    }

    // The version must move, or she installs an APK Android considers the
    // same build and the old assets stay in place.
    const gradle = fs.readFileSync(path.join(ROOT, 'mobile-app/android/app/build.gradle'), 'utf8');
    const code = Number((gradle.match(/versionCode (\d+)/) || [])[1]);
    ck('versionCode is past the last shipped build (75 / 9.2)', code > 75, String(code));
    // ── WAS /versionName "9\.5"/ — A BAKED-IN VALUE, 2026-10-24 ──────────
    // That assertion went red the moment the version moved, which is every
    // single release: 9.5 -> 9.8 tripped it. A check shaped like the code
    // rather than like the property, which is the thing CLAUDE.md warns
    // about — and its name says "moved with it", so it was always meant to
    // test movement, not a particular number.
    //
    // The property is: versionName is past the last SHIPPED build, the same
    // 9.2 the line above is measured against. Compared numerically rather
    // than as a string, or "9.10" would read as older than "9.2".
    const nameStr = (gradle.match(/versionName "([\d.]+)"/) || [])[1] || '';
    const asNum = (v) => {
        const p = String(v).split('.').map((x) => Number(x) || 0);
        return p[0] * 10000 + (p[1] || 0) * 100 + (p[2] || 0);
    };
    ck('  and versionName moved with it', !!nameStr && asNum(nameStr) > asNum('9.2'),
       (gradle.match(/versionName "[^"]*"/) || ['?'])[0]);
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('ABORT', e); process.exit(1); });
