// ── tests/claims-page.js — the claims page and its routes ────────────────────
// The one thing worth asserting hardest: the figure the page shows you BEFORE
// you press the button is the same figure the server stores after. If those two
// drift, the page is lying about money.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claimspage-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
delete require.cache[require.resolve(path.join(__dirname, '..', 'config.js'))];
const cfg = require('../config.js');
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('ABORT — DATA_DIR outside temp'); process.exit(1); }

const express = require('express');
const routes = require('../helpers/claims/routes');
const claims = require('../helpers/claims');

let pass = 0, fail = 0; const failures = [];
const ck = (n, ok, extra) => { if (ok) { pass++; console.log('  PASS ', n); } else { fail++; failures.push(n); console.log('  FAIL ', n, extra === undefined ? '' : JSON.stringify(extra).slice(0, 200)); } };

const HTML = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'claims.html'), 'utf8');

(async () => {

console.log('\n=== A — the page is part of this app, not a stranger to it ===');
{
    const qb = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'quickbooks.html'), 'utf8');
    const tokens = ['--steel-900:#14181B', '--leaf-500:#3DA836', '--copper-300:#E29C68',
        '--bg-base:#0C0E10', '--surface-card:#14181B', '--text-strong:#FFFFFF',
        "--font-display:'Archivo'", "--font-mono:'IBM Plex Mono'"];
    ck('every design token matches the rest of the dashboard verbatim',
        tokens.every((t) => HTML.includes(t) && qb.includes(t)),
        tokens.filter((t) => !HTML.includes(t)));
    ck('it links back to Jarvis like the other standalone pages', /class="back" href="\/"/.test(HTML));
    ck('no external script is pulled in', !/<script[^>]+src=/i.test(HTML));
    ck('it works down to phone width', /@media \(max-width:1020px\)/.test(HTML));
    ck('the nav knows about it', /dataset\.tab === 'claims'/.test(fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8')));
}

console.log('\n=== B — the preview maths are the server maths ===');
{
    // Lift the page's OWN unit table and compute() out of its source and run the
    // same cases through helpers/claims.verify(). Extracting rather than booting
    // the whole script keeps this a test of the maths instead of a test of a
    // fake browser — and it is the real source text, not a copy.
    const js = HTML.split('<script>')[1].split('</script>')[0];
    const mtDecl = js.match(/const MT = \{[^}]*\};/);
    const computeDecl = js.match(/function compute\(\{[\s\S]*?\n\}/);
    ck('the page still declares its unit table where this test can find it', !!mtDecl);
    ck('the page still declares compute() where this test can find it', !!computeDecl);
    let compute = null;
    if (mtDecl && computeDecl) {
        const box = { console };
        vm.createContext(box);
        vm.runInContext(`${mtDecl[0]}\n${computeDecl[0]}\nglobalThis.__compute = compute;`, box);
        compute = box.__compute;
    }
    ck('and it runs on its own', typeof compute === 'function');

    const cases = [
        { name: 'MT weights, $/MT rate', inv: 21.582, recv: 19.66, unit: 'MT', rate: 2140, rateUnit: 'MT' },
        { name: 'MT weights, $/lb rate (how she actually buys)', inv: 21.582, recv: 19.66, unit: 'MT', rate: 0.87, rateUnit: 'LB' },
        { name: 'pounds at a $/lb rate (the Ala International rows)', inv: 42920, recv: 42196, unit: 'LB', rate: 0.1475, rateUnit: 'LB' },
        { name: 'kilos, quoted per MT', inv: 24000, recv: 22800, unit: 'KG', rate: 390, rateUnit: 'MT' },
        { name: 'a tiny shortage', inv: 22.861, recv: 22.81, unit: 'MT', rate: 2660, rateUnit: 'MT' },
    ];
    for (const c of cases) {
        const page = compute ? compute(c) : null;
        const rec = await claims.create({ customer: 'T', invoice_no: 'INV' + Math.random().toString(36).slice(2, 7), container_no: 'ABCD1234567' }, 'test');
        const server = await claims.verify(rec.id, {
            invoice_weight: c.inv, claimed_weight: c.recv, weight_unit: c.unit,
            sell_price: c.rate, sell_price_unit: c.rateUnit,
        });
        ck(`${c.name} — shortage agrees`, page && Math.abs(page.shortage - server.shortage) < 1e-6, { page: page && page.shortage, server: server.shortage });
        ck(`${c.name} — amount agrees to the cent`, page && Math.abs(page.amount - server.claim_amount) < 0.011, { page: page && page.amount, server: server.claim_amount });
        ck(`${c.name} — percentage agrees`, page && Math.abs(page.pct - server.shortage_pct) < 0.011, { page: page && page.pct, server: server.shortage_pct });
    }
    ck('with no unit the page computes nothing at all',
        compute && compute({ inv: 21.5, recv: 19.6, unit: null, rate: 2140, rateUnit: 'MT' }).amount === null);
    ck('with no rate it still shows the shortage but no money',
        compute && compute({ inv: 21.5, recv: 19.6, unit: 'MT', rate: null, rateUnit: 'MT' }).shortage !== null
        && compute({ inv: 21.5, recv: 19.6, unit: 'MT', rate: null, rateUnit: 'MT' }).amount === null);
}

console.log('\n=== C — the page refuses to let you skip the unit ===');
{
    ck('the unit buttons are marked as needed until one is picked', /\(unit\?'':'need'\)/.test(HTML));
    ck('the confirm button is disabled without a unit', /\.f_verify'\)\.disabled = !f\.unit/.test(HTML));
    ck('and it says why in words', /Pick the unit first\./.test(HTML));
    ck('the 2204x danger is spelled out where it matters', /2204x/.test(HTML));
    ck("the customer's own figure is labelled as theirs, not Edge's", /that is their figure, not yet yours/.test(HTML));
    ck('an unverified claim shows the asking figure as asked-for, never as the claim',
        /money\(c\.stated_claim_amount\) \+ ' asked'/.test(HTML));
}

console.log('\n=== E — the page is organised per CONTAINER, not per row ===');
{
    // Lift the page's own grouping out of its source and feed it claims.
    const js = HTML.split('<script>')[1].split('</script>')[0];
    // All three helpers are single-line declarations in the page; a [^;]+
    // pattern truncates numOf at its first inner semicolon and the sandbox then
    // fails to parse, which is how this test lied about itself once already.
    const parts = [
        js.match(/^const containerKey = .*$/m),
        js.match(/^const numOf = .*$/m),
        js.match(/^const kindLabel = .*$/m),
        js.match(/^function containers\(\)\{[\s\S]*?^\}$/m),
    ];
    ck('the page still declares its per-container grouping', parts.every(Boolean), parts.map((p) => !!p));
    let containers = null, box = null;
    if (parts.every(Boolean)) {
        box = { console, STATE: { labels: {} } };
        vm.createContext(box);
        vm.runInContext(parts.map((p) => p[0]).join('\n') + '\nglobalThis.__c = containers;', box);
        containers = box.__c;
    }
    ck('and it runs on its own', typeof containers === 'function');

    box.STATE.claims = [
        { id: 'a', container_no: 'TEMU7944250', invoice_no: '26ME07', customer: 'Modern enterprises', supplier: 'Nur Metal', claim_type: 'foreign_material', claim_amount: 450, our_claim: null, status: 'verified', created_at: '2026-03-03' },
        { id: 'b', container_no: 'TEMU7944250', invoice_no: '26ME07', customer: 'Modern enterprises', supplier: 'Nur Metal', claim_type: 'recovery_shortfall', claim_amount: 3100, our_claim: 500, status: 'unverified', created_at: '2026-03-04' },
        { id: 'c', container_no: 'CAIU9975642', invoice_no: '26JY05', customer: 'Joey/Daekwang', supplier: 'Junk car', claim_type: 'weight_shortage', claim_amount: 4113.08, our_claim: 3686.43, status: 'settled', created_at: '2026-05-18' },
    ];
    const g = containers();
    ck('three claims across two containers become two entries', g.length === 2, g.length);
    const me07 = g.find((x) => x.key === 'TEMU7944250');
    ck('a container with two claims keeps both', me07 && me07.claims.length === 2, me07 && me07.claims.length);
    ck('and lists BOTH kinds, because they are not the same claim',
        me07 && me07.kinds.length === 2 && me07.kinds.includes('foreign_material') && me07.kinds.includes('recovery_shortfall'), me07 && me07.kinds);
    ck('the container total is the sum of its claims', me07 && me07.claimed === 3550, me07 && me07.claimed);
    ck('absorbed is claimed less what was recovered', me07 && me07.net === 3050, me07 && me07.net);
    ck('it counts what is still waiting on a person', me07 && me07.needs === 2, me07 && me07.needs);
    const jy = g.find((x) => x.key === 'CAIU9975642');
    ck('a settled, fully recovered container needs nothing', jy && jy.needs === 0, jy && jy.needs);
    ck('a claim with no container still gets an entry, keyed on its invoice', (() => {
        box.STATE.claims = [{ id: 'd', container_no: '', invoice_no: 'LOCAL-1', claim_type: 'other', claim_amount: 10, our_claim: null, status: 'unverified' }];
        const r = containers();
        return r.length === 1 && r[0].key === 'LOCAL-1';
    })());
    // The whole point of the rewrite: there is no list of kinds anywhere, so
    // there cannot be a CSS class per kind either.
    ck('there is NO css class per kind', (HTML.match(/\.k-[a-z_]+\s*\{/g) || []).length === 0, (HTML.match(/\.k-[a-z_]+\s*\{/g) || []));
    ck('a kind is coloured from a hue the server derives from its slug', /--kh/.test(HTML) && /hsl\(var\(--kh/.test(HTML));
    ck('no kind name is hardcoded in the page',
        (HTML.match(/weight_shortage|grade_downgrade|recovery_shortfall|foreign_material/g) || []).length === 0);
    ck('a claim with no kind says so rather than showing a default', /not classified yet/.test(HTML));
    ck('she can rename a kind and fold two together', /claim-kinds\/rename/.test(HTML) && /claim-kinds\/merge/.test(HTML));
    ck('and name a kind the model has never met', /name a new kind/.test(HTML));
    ck('a container can be given another claim from its own page', /\+ another claim/.test(HTML));
    ck('the detail pane explains why one container has several claims', /three different arguments with the customer/.test(HTML));
}

console.log('\n=== D — the routes the page posts to ===');
{
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.role = 'admin'; next(); });
    routes.mount(app, { ROOT: path.join(__dirname, '..') });
    const server = app.listen(0);
    const port = server.address().port;
    const get = async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { code: r.status, body: await r.json().catch(() => null) }; };
    const post = async (p, body) => {
        const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { code: r.status, body: await r.json().catch(() => null) };
    };

    const page = await fetch(`http://127.0.0.1:${port}/claims`);
    ck('the page is served', page.status === 200 && /Claims — Jarvis|id="strip"/.test(await page.text()));

    const listed = await get('/api/claims');
    ck('one call gives the page its rows AND its totals',
        listed.code === 200 && Array.isArray(listed.body.claims) && listed.body.stats
        && typeof listed.body.stats.net === 'number', listed.body && Object.keys(listed.body));
    ck('the closed set of statuses comes with it, so the page cannot invent one',
        Array.isArray(listed.body.statuses) && listed.body.statuses.includes('unverified'));
    ck('the live vocabulary travels with the rows, so the page cannot spell a kind differently',
        Array.isArray(listed.body.kinds), listed.body.kinds);
    ck('and the server sends no fixed list of kinds at all',
        !('types' in listed.body) && !('typeLabels' in listed.body), Object.keys(listed.body));
    ck('the header count is CONTAINERS, not rows', typeof listed.body.stats.containers === 'number');

    const made = await post('/api/claims', { customer: 'Metal Bridge', container_no: 'TRHU6472030', invoice_no: '26MB02' });
    ck('a manual claim can be created', made.code === 200 && made.body.status === 'unverified', made.body);
    ck('and it carries no money figure', made.body && made.body.claim_amount === null);

    const empty = await post('/api/claims', { customer: 'nobody' });
    ck('a claim with neither container nor invoice is refused', empty.code >= 400);
    ck('and the refusal says what is missing', /container|invoice/i.test((empty.body || {}).error || ''));

    const noUnit = await post(`/api/claims/${made.body.id}/verify`, { invoice_weight: 21.455, claimed_weight: 20.99 });
    ck('verify with no unit is refused by the route', noUnit.code >= 400 && /unit/i.test((noUnit.body || {}).error || ''), noUnit.body);

    const ok = await post(`/api/claims/${made.body.id}/verify`, { invoice_weight: 21.455, claimed_weight: 20.99, weight_unit: 'MT', sell_price: 2660, sell_price_unit: 'MT' });
    ck('verify with a unit works', ok.code === 200 && Math.abs(ok.body.claim_amount - 1236.9) < 0.6, ok.body && ok.body.claim_amount);

    const badStatus = await post(`/api/claims/${made.body.id}/status`, { status: 'whatever' });
    ck('an unknown status is refused', badStatus.code >= 400 && /status must be one of/.test((badStatus.body || {}).error || ''));

    const gone = await get('/api/claims/clm_nope');
    ck('an unknown claim is a clean 404', gone.code === 404);

    server.close();
}

console.log('\n=== F — uploading a sheet, from the page ===');
{
    const app = express();
    app.use(express.json({ limit: '40mb' }));
    app.use((req, res, next) => { req.role = 'admin'; next(); });
    routes.mount(app, { ROOT: path.join(__dirname, '..') });
    const server = app.listen(0);
    const port = server.address().port;
    const post = async (p2, body) => {
        const r = await fetch(`http://127.0.0.1:${port}${p2}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { code: r.status, body: await r.json().catch(() => null) };
    };

    // The shape that actually catches people out: the legacy block, where "Amount"
    // is the customer's claim and "Claim Amount" is Edge's recovery, plus a second
    // block with the normal columns.
    const CSV = [
        ',,Cont No.,Gross,Received ,Shortage in MT,Shortage in LBS,Selling Price,Amount,,Buyer,Buying Price,Claim Amount',
        'Varo Trading,25VT03,CCLU7611723,21.192,21.01,0.182,401,1875,341.25,Paid,Gomez,0.775,310.775',
        'Soline,25ST36,SEGU6045439,21.464,21.1,0.364,802,1990,724.36,,INES,0.88,706.18',
        ',,,,,,,,,,,,',
        'Supplier,date,Inv Nbr,Container number,Inv Weight,Inv Price,Total Amt,Loading photos,Customer Name,Claimed Weight,Difference,Claim amount,Our Claim',
        'Gomez,04/21/2026,26JY03,HMMU6316059,20.239,2140,43311.46,Photos,Joey/Daekwang,19.94,0.299,639.86,580',
    ].join('\n');

    // Deltas, not absolutes: sections B, D and E of this file have already
    // written to this store, and CLAUDE.md is explicit that a test which breaks
    // when an unrelated fixture moves is a test that gets deleted.
    const tasksFile = path.join(TMP, 'tasks.json');
    const tasksBefore = fs.existsSync(tasksFile) ? JSON.parse(fs.readFileSync(tasksFile, 'utf8')).length : 0;
    const claimsBefore = claims.list().length;

    const pv = await post('/api/claims/import/preview', { csv: CSV, name: 'Weight Shortage.csv', useAi: false });
    ck('a sheet can be handed straight to the page', pv.code === 200 && pv.body.count === 3, pv.body && (pv.body.error || pv.body.count));
    ck('it says which sheet it read', /Weight Shortage\.csv/.test(pv.body.source), pv.body.source);
    ck('and reports where each figure came from, per block', pv.body.blocks.length === 2 && pv.body.blocks[0].legacy === true, pv.body.blocks);
    ck('the legacy block is read the right way round — "Amount" is the customer\'s claim',
        pv.body.blocks[0].claimFrom === 'Amount' && pv.body.blocks[0].recoveryFrom === 'Claim Amount', pv.body.blocks[0]);
    ck('and "Buyer" is understood to be the supplier', pv.body.blocks[0].supplierFrom === 'Buyer');
    ck('the totals are computed before anything is written',
        Math.abs(pv.body.totals.claimed - 1705.47) < 0.01 && Math.abs(pv.body.totals.net - (1705.47 - 1596.955)) < 0.01, pv.body.totals);

    // The plan is the server's. A browser must not be able to hand back figures.
    ck('the page is given an id, not the rows', !!pv.body.planId && !('alreadyRows' in pv.body) && !Array.isArray(pv.body.claims), Object.keys(pv.body));
    ck('every claim it would create is shown for checking', Array.isArray(pv.body.preview) && pv.body.preview.length === 3);
    ck('nothing was written by the preview', claims.list().length === claimsBefore, { before: claimsBefore, now: claims.list().length });

    const stale = await post('/api/claims/import/commit', { planId: 'plan_nonsense' });
    ck('an unknown plan id is refused', stale.code >= 400 && /expired/.test(stale.body.error), stale.body);

    const done = await post('/api/claims/import/commit', { planId: pv.body.planId });
    ck('confirming imports exactly what was previewed', done.code === 200 && done.body.created === 3, done.body);
    ck('and the register now holds them', claims.list().length === claimsBefore + 3, { before: claimsBefore, now: claims.list().length });
    ck('the customer claim landed as the claim, not the recovery',
        (claims.list().find((c) => c.invoice_no === '25VT03') || {}).claim_amount === 341.25);
    ck('and the recovery landed as the recovery',
        (claims.list().find((c) => c.invoice_no === '25VT03') || {}).our_claim === 310.775);
    // The point of the whole two-step design: importing history must not nag her
    // once per historical claim.
    const tasksAfter = fs.existsSync(tasksFile) ? JSON.parse(fs.readFileSync(tasksFile, 'utf8')).length : 0;
    ck('importing three claims raised no to-do at all', tasksAfter === tasksBefore, { before: tasksBefore, after: tasksAfter });

    const twice = await post('/api/claims/import/commit', { planId: pv.body.planId });
    ck('the same plan cannot be committed twice', twice.code >= 400, twice.body);

    const again = await post('/api/claims/import/preview', { csv: CSV, useAi: false });
    ck('reading the same sheet again finds them already in', again.body.count === 0 && again.body.already === 3, { c: again.body.count, a: again.body.already });

    // What she would actually drag in.
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const other = wb.addWorksheet('Order Details');
    other.addRow(['nothing to do with claims']);
    const ws = wb.addWorksheet('Weight Shortage 2025');
    for (const line of CSV.split('\n')) ws.addRow(line.split(','));
    const buf = await wb.xlsx.writeBuffer();
    const xl = await post('/api/claims/import/preview', { xlsxBase64: Buffer.from(buf).toString('base64'), name: 'Shipments 2026.xlsx', useAi: false });
    ck('a real .xlsx workbook can be uploaded', xl.code === 200, xl.body && xl.body.error);
    ck('and the right sheet is found without being told which', /Weight Shortage 2025/.test(xl.body.source), xl.body.source);
    ck('the other sheets are listed so a wrong pick is visible', (xl.body.tabs || []).includes('Order Details'), xl.body.tabs);
    ck('it reads the same claims out of the workbook as out of the csv', xl.body.already === 3, { a: xl.body.already });

    server.close();
}

console.log('\n=== F2 — a failure is never a silent nothing ===');
{
    // From her screen recording, 2026-09-26 16:16: she pressed "Read the live tab
    // instead", it spun for two seconds, then cleared with no message at all. The
    // error WAS raised — it rendered at z-index 50, behind the modal's 60.
    const z = (sel) => { const m = HTML.match(new RegExp('\\' + sel + '\\{[^}]*z-index:(\\d+)')); return m ? Number(m[1]) : null; };
    ck('the toast sits ABOVE the modal that raised it', z('.toast') > z('.modal'), { toast: z('.toast'), modal: z('.modal') });
    ck('an import failure is also written into the modal, not only toasted', /That did not work/.test(HTML));
    ck('and it says nothing was written', /Nothing was written\./.test(HTML));
    ck('a file that cannot be read says so', /could not be read from disk/.test(HTML));

    // And the server-side message has to name which step failed.
    const src = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'claims', 'importSheet.js'), 'utf8');
    ck('an unreachable Google is named as that', /could not reach Google Sheets/.test(src));
    ck('a sign-in page is named as that', /sign-in page instead of the sheet/.test(src));
    ck('a refusal is named as that', /shared as "anyone with the link can view"/.test(src));
    ck('every one of them points at uploading the file instead',
        (src.match(/upload the file instead/g) || []).length >= 4);
    ck('and the server logs the failure for pm2', /import preview failed/.test(fs.readFileSync(path.join(__dirname, '..', 'helpers', 'claims', 'routes.js'), 'utf8')));
}

console.log('\n=== F3 — kinds from an older import are still hers to fix ===');
{
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.role = 'admin'; next(); });
    routes.mount(app, { ROOT: path.join(__dirname, '..') });
    const server = app.listen(0);
    const port = server.address().port;
    const get = async (p2) => { const r = await fetch(`http://127.0.0.1:${port}${p2}`); return { code: r.status, body: await r.json().catch(() => null) }; };
    const post = async (p2, body) => {
        const r = await fetch(`http://127.0.0.1:${port}${p2}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { code: r.status, body: await r.json().catch(() => null) };
    };

    // Exactly her situation: claims carrying a slug the registry never recorded,
    // because they were imported before the vocabulary existed.
    const a = await claims.create({ customer: 'Modern enterprises', container_no: 'TEMU7944250', invoice_no: '26ME07-a', claim_type: 'foreign_material' }, 'test');
    const b = await claims.create({ customer: 'Taewon', container_no: 'HMMU6180208', invoice_no: '25JY84-a', claim_type: 'grade_downgrade' }, 'test');
    void a; void b;

    const v = await get('/api/claim-kinds');
    const slugs = (v.body.kinds || []).map((k) => k.slug);
    ck('a kind only in use on claims is still listed', slugs.includes('foreign_material') && slugs.includes('grade_downgrade'), slugs);
    ck('it reads as words, not as a slug', (v.body.kinds.find((k) => k.slug === 'foreign_material') || {}).label === 'foreign material');
    ck('and it carries a colour like any other', typeof (v.body.kinds.find((k) => k.slug === 'grade_downgrade') || {}).hue === 'number');
    ck('the page header would no longer say 0 kinds', (await get('/api/claims')).body.kinds.length >= 2);

    const m = await post('/api/claim-kinds/merge', { from: 'grade_downgrade', into: 'foreign_material' });
    ck('two of them can be folded together even though neither was registered', m.code === 200, m.body);
    ck('and the claims move with it', (claims.get(b.id) || {}).claim_type === 'foreign_material', (claims.get(b.id) || {}).claim_type);

    server.close();
}

console.log('\n=== G — the import controls are on the page ===');
{
    ck('there is an Import button', /id="impBtn"/.test(HTML) && /Import sheet/.test(HTML));
    ck('a file can be dropped or chosen', /type="file"/.test(HTML) && /ondrop/.test(HTML) && /accept=".xlsx/.test(HTML));
    ck('or the live tab read instead', /Read the live tab instead/.test(HTML));
    ck('classifying can be turned off', /let the model classify them/.test(HTML));
    ck('it posts to preview and then to commit', /claims\/import\/preview/.test(HTML) && /claims\/import\/commit/.test(HTML));
    ck('commit sends only the plan id', /commit', \{ planId: p\.planId \}/.test(HTML));
    ck('the confirm button says how many', /Import these ' \+ p\.count \+ ' claims/.test(HTML));
    ck('it promises no to-do and no WhatsApp, where she can see it', /No to-do, no WhatsApp/.test(HTML));
    ck('the reversed legacy columns are called out on screen', /reverse of every other block/.test(HTML));
    ck('and the difference between claimed and exposure is explained',
        /withdrawn and rejected claims are not exposure/.test(HTML));
    ck('a not-classified row is shown as such in the preview table', /not classified<\/span>/.test(HTML));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\nTEST CRASHED:', e && e.stack || e); process.exit(1); });
