// ── tests/proforma-parity.js ──────────────────────────────────────────────
// Apsara, 2026-09-02: "mimic proforma changes on website to docs of app."
//
// The proforma exists three times over — the website's full form, the app's
// wizard, and the server that writes the Edge Metals sheet — and the Inv No is
// the key that joins the PDF to that sheet. When they disagree about how a
// number is spelled, a document and its sheet row stop referring to each other.
//
// THE DIVERGENCE THIS FILE WAS WRITTEN FOR
// A three-container proforma raised on the WEBSITE was numbered
// "26AU_SU_26JY95,96,97" — every container, prefix written once. The same
// proforma raised in the APP was numbered "26AU_SU_26JY95": the app built its
// number from the server's code_only, which is only the FIRST container, and
// then generated the rest afterwards without going back to fix it.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const grab = (src, name) => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) return null;
    const b = src.indexOf('{', src.indexOf(')', i));
    let d = 0;
    for (let k = b; k < src.length; k++) {
        if (src[k] === '{') d++;
        else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
    }
    return null;
};
// Comments are removed before comparing, TRAILING ones included. The first
// version stripped only full-line comments, so two byte-identical functions
// compared unequal because the website's copy carries one extra note at the
// end of a line. The test failed and the code was right.
//
// The negative lookbehind spares "https://" — a bare /\/\/.*$/ would eat the
// rest of any line containing a URL and could make two genuinely different
// functions look the same.
const decomment = (t) => String(t)
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .map((l) => l.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');
const strip = (t) => decomment(t).replace(/\s+/g, ' ').trim();

console.log('\n─ proforma: the app, the website and the sheet agree ────────');

// ── 1. one function, three homes ──────────────────────────────────────────
section('A — shortenContainerCodes is identical everywhere it lives');
{
    const copies = {
        website: grab(read('dashboard/documents.html'), 'shortenContainerCodes'),
        app: grab(read('mobile-app/www/index.html'), 'shortenContainerCodes'),
        server: grab(read('helpers/proformaSheetLog.js'), 'shortenContainerCodes'),
    };
    for (const [where, src] of Object.entries(copies)) {
        ck(`${where} has it`, !!src,
           'the app was missing it entirely until 2026-09-02');
    }
    ck('website and app are byte-identical', strip(copies.website) === strip(copies.app));
    ck('website and server are byte-identical', strip(copies.website) === strip(copies.server),
       'one builds the Inv No for the sheet, one for the PDF — disagreeing is the bug this pairing exists to prevent');

    // Behaviour, not just text. Three identical-looking functions that all do
    // the wrong thing would pass the comparison above.
    const f = new Function(copies.app + '; return shortenContainerCodes;')();
    ck('one container is returned unchanged', f(['26JY95']) === '26JY95',
       'a single-container proforma must be numbered exactly as it was before this change');
    ck('a run shares its prefix once', f(['26JY95', '26JY96', '26JY97']) === '26JY95,96,97');
    ck('  and keeps working across five', f(['26JY95', '26JY96', '26JY97', '26JY98', '26JY99']) === '26JY95,96,97,98,99');
    // A run crossing a letter-code change is ambiguous if shortened, and an
    // ambiguous container reference on an invoice is worth the characters.
    ck('a code with a different prefix is kept whole', f(['26JY99', '26KA01']) === '26JY99,26KA01');
    ck('nothing in, nothing out', f([]) === '' && f(null) === '');
    ck('blanks are dropped', f(['26JY95', '', null, '26JY96']) === '26JY95,96');
}

// ── 2. the app builds the number AFTER the containers ─────────────────────
section('B — the Inv No cannot be built before the containers exist');
{
    const app = read('mobile-app/www/index.html');
    const nocomment = app.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

    const containersAt = nocomment.indexOf('pfw.containerNos.push(`${pfw.containerSeq.yy}');
    const invNoAt = nocomment.indexOf('pfw.invNo = p.itemCode');
    ck('the containers are generated first', containersAt > 0 && invNoAt > containersAt,
       'building the number first is exactly how it ended up naming one container out of three');

    ck('the number is built from ALL of them', /shortenContainerCodes\(pfw\.containerNos\.filter\(Boolean\)\)/.test(nocomment));
    ck('  falling back to the single code when there are none',
       /\|\| p\.codeOnly;/.test(nocomment),
       'a proforma with no container sequence must still get a number');
    ck('the old single-code composition is gone',
       !/pfw\.invNo = itemCode \? `\$\{dateStr\}_\$\{itemCode\}_\$\{sug\.code_only\}`/.test(nocomment));
}

// ── 3. what the two clients send ──────────────────────────────────────────
section('C — the payloads still agree field for field');
{
    // Both post to /api/proforma/generate, so a field present on one and
    // absent on the other is a document that comes out different depending on
    // which screen raised it.
    const web = read('dashboard/documents.html');
    const app = read('mobile-app/www/index.html');
    const FIELDS = ['inv_no', 'inv_date', 'reference', 'qty_unit', 'consignee',
                    'consignee_sheet_tag', 'consignee_address', 'trade_terms',
                    'port_discharge', 'payment_term', 'freight_label',
                    'buyer_po', 'buyer_po_date', 'country_of_origin',
                    'shipment_allowance', 'item_code', 'container_no'];
    for (const f of FIELDS) {
        ck(`both send ${f}`, new RegExp(`\\b${f}:`).test(web) && new RegExp(`\\b${f}:`).test(app));
    }
    // The app fixes four of these to PF_DEFAULTS where the website lets them
    // be typed. That is a DELIBERATE difference — the wizard exists to be
    // quick on a phone — but it is recorded here so it is a decision rather
    // than an accident someone finds later.
    ck('the app fills the rarely-changed fields from PF_DEFAULTS',
       /country_of_origin: PF_DEFAULTS\.country_of_origin/.test(app)
       && /shipment_allowance: PF_DEFAULTS\.shipment_allowance/.test(app),
       'the wizard trades editability for speed on a phone — deliberate, not missing');
}

// ── 4. the material type-ahead exists on both ─────────────────────────────
section('D — description suggestions, under whatever name');
{
    const web = read('dashboard/documents.html');
    const app = read('mobile-app/www/index.html');
    ck('both share pfDescSuggestions', !!grab(web, 'pfDescSuggestions') && !!grab(app, 'pfDescSuggestions'));
    ck('  and it is the same function', strip(grab(web, 'pfDescSuggestions')) === strip(grab(app, 'pfDescSuggestions')),
       'the ranking of remembered vs generic descriptions decides which price gets filled in');
    ck('both mark a remembered description', /known price/.test(web) && /known price/.test(app));
    ck('both pick on mousedown, not click',
       /addEventListener\('mousedown'/.test(web) && /addEventListener\('mousedown'/.test(app),
       'blur fires first on a click and closes the list before it lands');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
process.exit(fail ? 1 : 0);
