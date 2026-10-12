// ── tests/date-pickers.js ────────────────────────────────────────────────
// Apsara, 2026-10-11: "ensure that Wherever date is used,date picker should
// be hthere" — said for the THIRD time:
//
//   2026-09-01  "wherever date applicable it should be mm/dd/yyyy only."
//   2026-09-02  "date picker should be there wherever date used."
//   2026-10-11  this.
//
// It has been asked three times because it was answered three times by
// hand. wireUsDateField exists and is good; what was missing is anything
// that notices a NEW date box added without it. So this file does not check
// the four fields that were wrong today — a test that names them passes
// forever and catches nothing. It ENUMERATES every date input on every
// screen and insists each one is wired.
//
//   A  the inventory of date fields, per screen, none unwired
//   B  the two rules that pull against each other are both still kept
//   C  the picker machinery itself, on the pages that carry their own copy
//
// Her two rules, and why the answer is not <input type="date">: a native
// date input renders in the DEVICE's locale and cannot be forced, so on a
// phone set to en-IN it shows DD/MM/YYYY. The visible box is text and is
// MM/DD/YYYY on every device; an invisible native input beside it opens the
// platform calendar.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { return ''; } };

// Every screen, plus the files dashboard/index.html's <script> was split
// into — a field's markup and its wiring call now live in different files,
// so the search for "is it wired" has to span all of them.
const SCREENS = ['dashboard/index.html', 'dashboard/documents.html', 'dashboard/outbound-loads.html',
    'dashboard/edge-inventory.html', 'dashboard/claims.html', 'dashboard/books.html',
    'dashboard/bank-match.html', 'dashboard/quickbooks.html', 'dashboard/address-book.html',
    'dashboard/quote-requests.html', 'dashboard/contact-quote-requests.html',
    'dashboard/design-bol.html', 'mobile-app/www/index.html'];

let APP_JS = [];
try {
    APP_JS = fs.readdirSync(path.join(ROOT, 'dashboard/app'))
        .filter(f => f.endsWith('.js')).map(f => 'dashboard/app/' + f);
} catch (e) { /* the split may be reverted; the screens still carry it all */ }

// One haystack: a field declared in documents.html may be wired in
// dashboard/app/*.js, and index.html's fields now ALL are.
const ALL = [...SCREENS, ...APP_JS].map(read).join('\n');

const wiredSomewhere = (id) => ALL.includes(`wireUsDateField('${id}')`)
    || ALL.includes(`wireUsDateField("${id}")`)
    // Wired from a list, which is how edge-inventory.html does its three.
    || new RegExp(`\\[[^\\]]*['"\`]${id}['"\`][^\\]]*\\]\\s*\\.forEach\\(\\s*wireUsDateField`).test(ALL)
    || new RegExp(`wireUsDateField\\(\\s*\\$\\(\\s*['"\`]${id}['"\`]`).test(ALL);

// ══════════════════════════════════════════════════════════════════════════
section('A — every date box on every screen, and whether it has a calendar');

let totalFields = 0;
const unwired = [];
for (const f of SCREENS) {
    const src = read(f);
    if (!src) continue;
    const ids = new Set();
    for (const m of src.matchAll(/<input[^>]*>/g)) {
        // The MM/DD/YYYY placeholder is what MARKS a date box in this app —
        // the type is text precisely so the format cannot drift (rule 1).
        if (!/placeholder="MM\/DD\/YYYY"/.test(m[0])) continue;
        const id = (m[0].match(/\bid="([^"]+)"/) || [])[1];
        // An id is not optional for a date box: wireUsDateField is called by
        // id, so one without an id cannot be wired at all.
        if (!id) { unwired.push(`${f}: a MM/DD/YYYY input with NO id`); continue; }
        ids.add(id);
    }
    totalFields += ids.size;
    const bad = [...ids].filter(id => !wiredSomewhere(id));
    if (bad.length) unwired.push(`${f}: ${bad.join(', ')}`);
}

// A guard that finds nothing is a guard that is not looking. If the
// placeholder convention is ever renamed this drops to zero and says so,
// rather than reporting all-clear over an empty list.
ck(`the sweep found date fields at all (${totalFields})`, totalFields >= 25,
   `only ${totalFields} — has the MM/DD/YYYY convention changed? this check is now blind`);
ck('EVERY date field has a calendar button', unwired.length === 0,
   unwired.join('  |  '));

// The four that were missed, named so the fix is explicit about what it was
// for — but the sweep above is what protects the NEXT one.
for (const id of ['fFrom', 'fTo', 'rm_date', 'inv_date']) {
    ck(`  ${id} specifically (missed until 2026-10-11)`, wiredSomewhere(id));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — her two rules, which pull against each other');

{
    // Rule 1: nothing a person TYPES a date into may be a native date input,
    // because its format follows the device. Report From/To filters are the
    // deliberate exception — they never reach a document — so this checks the
    // rule where it bites: anything whose value lands on paper.
    const docs = read('dashboard/documents.html');
    ck('the invoice date is a text box, not <input type="date">',
       /<input id="inv_date"[^>]*placeholder="MM\/DD\/YYYY"/.test(docs)
       && !/<input[^>]*id="inv_date"[^>]*type="date"/.test(docs));
    ck('  and so is the proforma\'s', /id="pf_inv_date"[^>]*placeholder="MM\/DD\/YYYY"/.test(docs));

    // Rule 2: the calendar. The native input the button drives must NOT be
    // display:none — showPicker() throws on an unrendered element, which is
    // the trap that makes a 📅 do nothing on some devices.
    const core = read('dashboard/app/01-core.js') || read('dashboard/index.html');
    const inv = read('dashboard/edge-inventory.html');
    for (const [where, src] of [['01-core.js', core], ['edge-inventory.html', inv]]) {
        if (!/function wireUsDateField/.test(src)) continue;
        const body = src.slice(src.indexOf('function wireUsDateField'));
        ck(`${where}: the hidden input is zero-size, not display:none`,
           /width:1px; height:1px; opacity:0/.test(body) && !/native\.style[^;]*display:\s*none/.test(body),
           'showPicker() throws on an element that is not rendered');
        ck(`${where}: a picked date fires input AND change`,
           /dispatchEvent\(new Event\('input'/.test(body) && /dispatchEvent\(new Event\('change'/.test(body),
           'the From/To filters reload on their own events — a silent pick looks applied and is not');
        // NOT /dataset\.dpWired/ — that passed happily when the guard was
        // deleted from the `if` and the assignment left behind two lines
        // down. Section D runs the function and counts buttons instead.
        ck(`${where}: the calendar opens on the month already in the box`,
           /native\.value = toIso(Date)?\(el\.value\)/.test(body));
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('C — edge-inventory.html carries its own copy, and why');

{
    const inv = read('dashboard/edge-inventory.html');
    ck('it has wireUsDateField', /function wireUsDateField/.test(inv));
    // It must NOT be made to load 01-core.js instead: that file is ~1000
    // lines, redefines $ and esc, and attaches to #hamburgerBtn, which this
    // page does not have. A future "let us just share it" would break the
    // page at load.
    // Comments stripped FIRST. The comment above the copied helper explains
    // why 01-core.js is not loaded, and so names it — scanning the raw file
    // finds the thing in the prose about the thing. Third time that trap has
    // bitten today, after the pdfBrowser subresource scan and the scheduler
    // guard check.
    const code = inv.replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ck('  and does NOT load dashboard/app/01-core.js',
       !/01-core\.js/.test(code),
       '01-core.js attaches to #hamburgerBtn, which this page has not got');
    // One date parser on the page, not two. The copy deliberately reuses the
    // page's own toIso rather than importing a second, more forgiving one.
    const body = inv.slice(inv.indexOf('function wireUsDateField'));
    ck('  and reuses this page\'s own toIso', /toIso\(el\.value\)/.test(body)
       && !/toIsoDate\(/.test(body),
       'two date parsers on one screen is how one of them drifts');
}

// ══════════════════════════════════════════════════════════════════════════
section('D — RUN the picker, do not read it');
// Section B's checks are text-shaped, and one of them was worthless: a
// mutation deleted `|| el.dataset.dpWired` from the guard and left the
// assignment two lines below, so /dataset\.dpWired/ still matched and the
// test passed on code that nests a second wrapper around the field every
// time it is wired. The only honest check is to call the function and count
// what ends up in the DOM.

{
    const { JSDOM } = require('jsdom');
    const inv = read('dashboard/edge-inventory.html');

    // Lift the real function out of the page rather than reimplementing it —
    // a harness copy of the thing under test passes while the shipped copy
    // is broken, which is how the client unit tables drifted in September.
    const lift = (src, name) => {
        const at = src.indexOf(`function ${name}(`);
        if (at < 0) return null;
        let i = src.indexOf('{', at), depth = 0;
        for (let j = i; j < src.length; j++) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') { depth--; if (!depth) return src.slice(at, j + 1); }
        }
        return null;
    };
    const fnSrc = lift(inv, 'wireUsDateField');
    ck('wireUsDateField could be lifted out of the page', !!fnSrc);

    const dom = new JSDOM('<!doctype html><body>'
        + '<div class="field"><label>From</label><input id="fFrom" placeholder="MM/DD/YYYY"></div>'
        + '</body>', { runScripts: 'outside-only' });
    const w = dom.window;
    const toIsoSrc = (inv.match(/^const toIso = .*$/m) || [])[0] || '';
    // On window, not `const`: each w.eval() is its own block scope, so a
    // const declared in one is invisible to the next.
    w.eval(`window.$ = (id) => document.getElementById(id);\n`
        + `${toIsoSrc.replace(/^const /, 'window.')}\n`
        + `window.wireUsDateField = ${fnSrc.replace(/^function wireUsDateField/, 'function')};`);

    const el = w.document.getElementById('fFrom');
    w.eval("wireUsDateField('fFrom')");
    const buttons = () => w.document.querySelectorAll('button[aria-label="Open the calendar"]').length;
    const natives = () => w.document.querySelectorAll('input[type="date"]').length;

    ck('wiring it adds exactly one calendar button', buttons() === 1, `got ${buttons()}`);
    ck('  and exactly one hidden native input', natives() === 1, `got ${natives()}`);
    ck('  and the text box keeps its own id and value path', el.id === 'fFrom');
    ck('  and the box is still reachable through $()',
       w.eval("$('fFrom') === document.getElementById('fFrom')"),
       'moving the input into a wrapper must not change how every call site finds it');

    // THE MUTATION THAT SURVIVED: wire it again.
    w.eval("wireUsDateField('fFrom')");
    ck('wiring the SAME field twice adds nothing', buttons() === 1 && natives() === 1,
       `after two calls: ${buttons()} button(s), ${natives()} native input(s) — the wrapper was rebuilt`);

    // And a picked date must come back out as MM/DD/YYYY and tell the page.
    const native = w.document.querySelector('input[type="date"]');
    let heard = 0;
    el.addEventListener('change', () => { heard++; });
    native.value = '2026-03-09';
    native.dispatchEvent(new w.Event('change', { bubbles: true }));
    ck('a date picked in the calendar lands as MM/DD/YYYY', el.value === '03/09/2026', el.value);
    ck('  and the page is told about it', heard === 1, `change fired ${heard} time(s)`);

    // Typed input is tidied on blur, which is the half that makes typing and
    // tapping agree.
    el.value = '3/9/2026';
    el.dispatchEvent(new w.Event('blur', { bubbles: true }));
    ck('a typed "3/9/2026" settles as "03/09/2026"', el.value === '03/09/2026', el.value);
    // And a value it cannot parse is LEFT ALONE rather than blanked — losing
    // what someone typed is worse than showing it back to them untidied.
    el.value = 'next tuesday';
    el.dispatchEvent(new w.Event('blur', { bubbles: true }));
    ck('  and something unparseable is left for her to fix, not erased',
       el.value === 'next tuesday', el.value);
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log('Failures:'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
