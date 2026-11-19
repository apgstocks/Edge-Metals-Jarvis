// ── tests/yard-spanish.js — the English / Spanish switch on the YARD screens ──
//
// Apsara, 2026-11-19: "Some of the customers are in spanish ... add a toggle in app at the top right", scoped to
// "yard only and website". dashboard/yard-lang.js translates what is on screen; these checks pin the properties
// that matter more than any one word:
//   A  English is the default and changes NOTHING on the page.
//   B  Spanish on a yard tab translates text, placeholders and dropdown labels — and never what the form SENDS.
//   C  Freight tabs stay English, and switching back restores every original string exactly.
//   D  Native dialogs: translated only while Spanish is on, answers untouched.
//   E  The page loads it (outside the numbered app parts), and the trial copy would carry no Edge names in it.
//   F  End to end: a real server serves the page with the switch and the file itself.
//   G  Coverage: the yard screens' main labels all have Spanish.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-yardes-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'dashboard', 'yard-lang.js'), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 60));

// A small page shaped like the real one: a yard tab with a form, a select with and without value="", a textarea.
const BODY = `
  <nav id="side"><button class="nav-btn">Loads</button><button class="nav-btn">Petty Cash</button><div>Sign out</div></nav>
  <div id="viewRoot">
    <h1>Loads</h1>
    <button id="save">Save load</button>
    <input id="seller" placeholder="Seller name" value="Gold Coast Drayage">
    <textarea id="addr" placeholder="Seller address">Save load</textarea>
    <div id="gw">Gross weight: 3000 lb</div>
    <div id="day">Tuesday, November 17, 2026</div>
    <div id="unknown">Some sentence nobody translated</div>
    <select id="mode"><option>Cash</option><option value="Zelle">Zelle</option><option value="Wire">Wire</option></select>
  </div>`;

function mount(tab, { storedLang } = {}) {
    const dom = new JSDOM(`<!doctype html><html lang="en"><head></head><body>${BODY}</body></html>`,
        { runScripts: 'dangerously', url: 'http://localhost/' });
    const w = dom.window;
    if (storedLang) w.localStorage.setItem('yard_ui_lang', storedLang);
    w.__dialogs = [];
    w.alert = (m) => { w.__dialogs.push(['alert', m]); };
    w.confirm = (m) => { w.__dialogs.push(['confirm', m]); return true; };
    w.prompt = (m, d) => { w.__dialogs.push(['prompt', m]); return '42'; };
    const s0 = w.document.createElement('script'); s0.textContent = `let CURRENT_TAB = ${JSON.stringify(tab)};`; w.document.head.appendChild(s0);
    const s = w.document.createElement('script'); s.textContent = SRC; w.document.body.appendChild(s);
    return w;
}
const text = (w, id) => w.document.getElementById(id).textContent;

(async () => {
    section('A — English is the default and touches nothing');
    {
        const w = mount('loads');
        const before = w.document.getElementById('viewRoot').innerHTML;
        await tick();
        ck('starts in English', w.yardLang.get() === 'en');
        ck('the yard screen is byte-for-byte unchanged', w.document.getElementById('viewRoot').innerHTML === before);
        ck('the switch is shown on a yard tab, at the top right', (() => { const t = w.document.getElementById('yardLangToggle'); return t && t.style.display === 'flex' && /right:\s*72px/.test(t.style.cssText); })());
        w.confirm('Are you sure you want to delete load X1?');
        ck('dialogs pass through untouched in English', w.__dialogs[0][1] === 'Are you sure you want to delete load X1?');
        ck('no option was given a value in English', !w.document.querySelector('#mode option').hasAttribute('value'));
    }

    section('B — Spanish on a yard tab');
    const w = mount('loads');
    await tick();
    w.yardLang.set('es');
    await tick();
    ck('a button label is translated', text(w, 'save') === 'Guardar carga', text(w, 'save'));
    ck('the menu is translated', w.document.querySelector('#side .nav-btn').textContent === 'Cargas');
    ck('a placeholder is translated', w.document.getElementById('seller').getAttribute('placeholder') === 'Nombre del vendedor');
    ck('what was typed is never touched (input value)', w.document.getElementById('seller').value === 'Gold Coast Drayage');
    ck('a textarea keeps its typed text, only its placeholder changes', w.document.getElementById('addr').value === 'Save load' && w.document.getElementById('addr').getAttribute('placeholder') === 'Dirección del vendedor');
    ck('a figure inside a sentence is kept (pattern)', text(w, 'gw') === 'Peso bruto: 3000 lb', text(w, 'gw'));
    ck('a long date is written the Spanish way', text(w, 'day') === 'martes, 17 de noviembre de 2026', text(w, 'day'));
    ck('a string with no Spanish stays English', text(w, 'unknown') === 'Some sentence nobody translated');
    const sel = w.document.getElementById('mode');
    ck('a dropdown label is translated', sel.options[0].textContent === 'Efectivo');
    ck('…but an option with no value="" still SENDS the English word', sel.options[0].value === 'Cash' && (sel.selectedIndex = 0, sel.value === 'Cash'), sel.value);
    sel.value = 'Wire';
    ck('an option that already had a value sends it unchanged', sel.value === 'Wire' && sel.options[2].textContent === 'Transferencia (wire)');
    ck('the page says lang="es"', w.document.documentElement.getAttribute('lang') === 'es');
    ck('the choice is remembered in this browser', w.localStorage.getItem('yard_ui_lang') === 'es');
    // the app re-renders a piece of the screen: new English text must come in Spanish
    const n = w.document.createElement('button'); n.textContent = 'Record payment'; w.document.getElementById('viewRoot').appendChild(n);
    await tick();
    ck('a piece the app draws later is translated too', n.textContent === 'Registrar pago', n.textContent);
    w.document.getElementById('save').firstChild.nodeValue = 'Saving…';
    await tick();
    ck('a label the app changes while busy is translated again', text(w, 'save') === 'Guardando…', text(w, 'save'));

    section('C — freight stays English; back to English restores everything');
    {
        const w2 = mount('loads', { storedLang: 'es' });
        await tick();
        ck('a stored Spanish choice applies on the next visit', text(w2, 'save') === 'Guardar carga');
        w2.eval("CURRENT_TAB = 'board'");
        const extra = w2.document.createElement('div'); extra.textContent = 'Delete'; w2.document.getElementById('viewRoot').appendChild(extra);
        await tick();
        ck('on a freight tab nothing is translated', extra.textContent === 'Delete');
        ck('leaving the yard puts the yard words back', text(w2, 'save') === 'Save load' && w2.document.querySelector('#side .nav-btn').textContent === 'Loads');
        ck('the switch is hidden on a freight tab', w2.document.getElementById('yardLangToggle').style.display === 'none');
    }
    {
        const w3 = mount('loads');
        const before = w3.document.getElementById('viewRoot').innerHTML;
        await tick(); w3.yardLang.set('es'); await tick(); w3.yardLang.set('en'); await tick();
        const after = w3.document.getElementById('viewRoot').innerHTML.replace(/ value="Cash"/, '');
        ck('ES then EN gives back the exact original text and placeholders', after === before, after.slice(0, 300));
    }

    section('D — dialogs');
    w.__dialogs.length = 0;
    const ans = w.confirm('Are you sure you want to delete sale OUT_03?\n\nThe material goes back into inventory as on hand.');
    ck('a delete question is asked in Spanish', w.__dialogs[0][1] === '¿Seguro que quiere eliminar la venta OUT_03?\n\nEl material regresa al inventario como existencia.', JSON.stringify(w.__dialogs[0][1]));
    ck('…and the answer comes back unchanged', ans === true);
    ck('a prompt is asked in Spanish and its typed answer returned as typed', w.prompt('How much cash is going into the box?') === '42' && w.__dialogs[1][1] === '¿Cuánto efectivo entra a la caja?');
    w.alert('PDF generation failed: disk full');
    ck('a server error keeps its own words after the Spanish lead', w.__dialogs[2][1] === 'No se pudo generar el PDF: disk full');

    section('E — wiring');
    const html = fs.readFileSync(path.join(ROOT, 'dashboard', 'index.html'), 'utf8');
    ck('the page loads yard-lang.js', /<script src="yard-lang\.js"><\/script>/.test(html));
    ck('…after every numbered app part (so CURRENT_TAB exists)', html.indexOf('yard-lang.js') > html.indexOf('/app/14-facts-boot.js'));
    const sp = require(path.join(ROOT, 'helpers', 'sourceParts'));
    const rebuilt = typeof sp.indexHtml === 'function' ? sp.indexHtml() : (typeof sp.dashboardHtml === 'function' ? sp.dashboardHtml() : null);
    ck('…and outside the numbered parts, so the rebuilt single script ~100 tests read is unchanged', rebuilt == null || !/yardLang|yard_ui_lang/.test(rebuilt.replace(/<script src="yard-lang\.js"><\/script>/, '')));
    ck('no Edge names in the file (it ships in trial copies)', !/edge[ _-]?(metals?|trading|yard)|apsara|edgemetals/i.test(SRC.replace(/^\/\/.*$/gm, '')));

    section('F — END TO END: a real server serves the page and the switch');
    {
        const http = require('http');
        process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'user-pw-aaaaaaaaaaaa';
        process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
        process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';
        const { createApi } = require(path.join(ROOT, 'api'));
        const server = await new Promise((r) => { const s = createApi().listen(0, '127.0.0.1', () => r(s)); });
        const base = `http://127.0.0.1:${server.address().port}`;
        const call = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
            const data = body == null ? null : JSON.stringify(body);
            const headers = { Accept: 'text/html,application/javascript,*/*' };
            if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
            if (sid) headers.Authorization = `Bearer ${sid}`;
            const r2 = http.request(base + p, { method, headers }, (res) => { let raw = ''; res.setEncoding('utf8'); res.on('data', (c) => { raw += c; }); res.on('end', () => resolve({ status: res.statusCode, raw })); });
            r2.on('error', reject); if (data) r2.write(data); r2.end();
        });
        let sid = null;
        const get = (p) => call('GET', p, { sid });
        try {
            const login = await call('POST', '/login', { body: { password: process.env.STAFF_PASSWORD } });
            try { sid = JSON.parse(login.raw).sid; } catch (e) { /* checked below */ }
            ck('signed in as yard staff (the people most likely to want Spanish)', !!sid, login.status);
            const page = await get('/');
            ck('the page the browser gets carries the switch', page.status === 200 && /yard-lang\.js/.test(page.raw), page.status);
            const js = await get('/yard-lang.js');
            ck('the switch file is served, and it is this file', js.status === 200 && js.raw.includes("var KEY = 'yard_ui_lang'"), js.status);
            // Run the served page's own copy in a browser-like DOM: proves what is served actually works.
            const w4 = mount('loads');
            w4.eval(js.raw.replace("var KEY = 'yard_ui_lang'", "var KEY = 'yard_ui_lang_e2e'"));
            await tick(); w4.yardLang.set('es'); await tick();
            ck('the served file translates a yard screen', w4.document.getElementById('save').textContent === 'Guardar carga');
        } finally { server.close(); }
    }

    section('G — coverage of the yard screens\' main labels');
    const MUST = ['Loads', 'Inventory', 'Petty Cash', 'Trucker Bills', 'Expenses', 'Price Lists', 'Spend Report', 'Sign out',
        '+ Load', '+ Sale', 'Generate PDF', 'Edit', 'Delete', 'Pay', 'Receive payment', 'Save load', 'Record sale', 'Save changes', 'Cancel',
        'Date', 'Seller', 'Buyer', 'Gross', 'Tare', 'Net', 'Price', 'Amount', '+ Add item', 'Trucking', 'Ferrous', 'Non-ferrous',
        'Record payment', 'Payment mode', 'Bank', 'Settle it', 'Cash', 'Wire', 'Cheque', 'Bank transfer',
        '+ Add cash', 'Borrowing', '+ Add bill', 'Save bill', '+ Add expense', 'Save expense', 'Category', 'Paid by',
        '+ Add group', '+ Add contact', 'Export as Excel', 'Export as PDF', 'Sign in', 'Continue'];
    const missing = MUST.filter((k) => !w.yardLang.tr(k));
    ck(`every main yard label has Spanish (${MUST.length})`, missing.length === 0, missing.join(', '));
    const es = w.yardLang._ES;
    ck('no Spanish entry is empty or still English', Object.keys(es).every((k) => es[k] && (es[k] !== k || /^(No|Zelle|Cheque|\/)/.test(k))), Object.keys(es).filter((k) => !es[k] || es[k] === k).join(', '));
    ck('every pattern matches a whole string', w.yardLang._PATTERNS.every(([re]) => re.source.startsWith('^') && re.source.endsWith('$')));

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* the runner cleans tmp */ }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILURES:'); failures.forEach((f) => console.log('  ' + f)); }
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
