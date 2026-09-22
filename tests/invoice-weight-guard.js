// ── tests/invoice-weight-guard.js ───────────────────────────────────────────
// Apsara, 2026-09-19, sending 260918_AP_26ARIS02.pdf and, asked whether it had
// gone out: "yes invoice sent".
//
// That invoice states Quantity 15,642.000 MT at $0.548 US$/MT. Her own packing
// list for the same container, generated the same day, says 7.095 MT. Pounds
// in the MT column, on a customs document, in a buyer's hands — 52,233 MT
// declared against a real 23.693.
//
// The money was right ($0.548/lb is $1,208/MT, so the amount is the amount she
// meant). Only the printed quantity and rate were wrong, which is the worst
// version of this: nothing was short-paid, so nothing would ever have surfaced
// it except someone reading the tonnage.
//
// ── WHY NOTHING CAUGHT IT ───────────────────────────────────────────────────
// The row carries its own gross and tare. Net is gross minus tare and MT is
// net over 2204.62 — the chain documents.html computes when she EDITS a weight
// box, and only then. A quantity that arrived any other way was never compared
// with the weights sitting beside it in the same row.
//
// ── WHAT THIS FILE ASSERTS ──────────────────────────────────────────────────
//   the check finds HER case, by the real figures off that document;
//   it stays quiet on ordinary variance, or it gets clicked through and is
//     not there on the day it matters;
//   the ROUTE refuses, over real HTTP, and can be overridden;
//   the SCREEN re-posts the override rather than swallowing the refusal;
//   and both screens do — a requirement added to shared code that one caller
//     cannot satisfy is the 2026-09-17 mistake, written down in CLAUDE.md.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-wguard-'));
process.env.JARVIS_TEST = '1';
process.env.ADMIN_PASSWORD = 'admin-pw-ddddddddddd';

const ROOT = path.join(__dirname, '..');
const iw = require(path.join(ROOT, 'helpers/invoiceWeights'));

// Her real row: 16,122 gross, 480 tare, 15,642 net, 7.095 MT.
const row = (over = {}) => ({
    item_desc: 'Sealed units', rate: 1208, container_no: 'MSDU2726332', seal_no: '0173873',
    packing: { gross_weight_lbs: '16122', truck_lbs: '480' },
    ...over,
});

(async () => {

// ── A. THE CHECK, ON THE DOCUMENT THAT PROMPTED IT ──────────────────────────
section('A. the check finds her case');
{
    const p = iw.problemFor(row({ weight: 15642 }), 0);
    ck('15,642 in the MT box against a 15,642lb net is caught', !!p);
    ck('  and it is NAMED, not just flagged as odd', p && p.kind === 'POUNDS_IN_MT', p && p.kind);
    ck('  the sentence says what she did', p && /net weight in POUNDS/.test(p.why), p && p.why);
    ck('  and what the figure should have been', p && /7\.095/.test(p.why), p && p.why);
    ck('  carrying the row number so she can go and look', p && p.row === 1);
    ck('  and the item, because "row 3" on a four-row invoice is not much help',
       p && p.item === 'Sealed units');

    // A rounded net — she reads 15,642 off a packing list computed from
    // 16,122 - 480. Same figure here, but the tolerance is what keeps this
    // case landing on the nameable finding rather than the vague one.
    const rounded = iw.problemFor(row({ weight: 15640, packing: { gross_weight_lbs: '16122', truck_lbs: '480' } }), 0);
    ck('a net rounded by a couple of pounds still reads as POUNDS',
       rounded && rounded.kind === 'POUNDS_IN_MT', rounded && rounded.kind);
}

// ── B. AND STAYS QUIET OTHERWISE ────────────────────────────────────────────
// The failure mode of a check like this is not missing a bad invoice, it is
// firing on good ones until she stops reading it.
section('B. it does not cry wolf');
{
    const quiet = (w, label, over) => {
        const p = iw.problemFor(row({ weight: w, ...(over || {}) }), 0);
        ck(`  ${label}`, !p, p && p.why);
    };
    quiet(7.095, 'the correct MT passes');
    quiet(7.1, 'a rounded MT passes');
    quiet(7.5, 'a 6% difference passes — a contract weight is not an error');
    quiet(6.5, 'and so does 8% the other way');
    quiet(9.0, 'even 27% passes: she may have agreed a different figure');

    // Nothing to compare is NOT a pass — it is silence, and the difference
    // matters: an invoice row with no weights has not been checked.
    //
    // This used weight: 15642 as its example and asserted silence. That was
    // the hole. Apsara, 2026-09-22, having said it once before: "normally mt
    // will be within 100." A weightless row stating 15,642 in a column headed
    // MT was going through unexamined — the same shape of document as
    // 260918_AP_26ARIS02. The intent of the check stands and the example was
    // wrong: a PLAUSIBLE quantity with nothing to compare it to is still
    // silence.
    const noWeights = iw.problemFor({ item_desc: 'X', weight: 22.571, packing: {} }, 0);
    ck('  a plausible quantity with no packing weights is not judged', !noWeights);
    const noQty = iw.problemFor(row({ weight: 0 }), 0);
    ck('  nor is a row with no quantity', !noQty);

    // ── HER RULE: A TONNAGE IS A SMALL NUMBER ───────────────────────────
    // This needs nothing to compare against, which is the whole point — it
    // is the only check that can speak when the row carries no weights.
    const impossible = iw.problemFor({ item_desc: 'Sealed Units', weight: 49760, packing: {} }, 0);
    ck('  but an impossible tonnage is caught with no weights at all',
       impossible && impossible.kind === 'IMPOSSIBLE_MT', impossible && impossible.kind);
    ck('    and it offers the figure in MT, so she can just type it',
       impossible && /22\.571/.test(impossible.why), impossible && impossible.why);
    ck('  99 MT passes — the line is generous on purpose',
       !iw.problemFor({ item_desc: 'X', weight: 99, packing: {} }, 0));
    ck('  101 MT does not',
       (iw.problemFor({ item_desc: 'X', weight: 101, packing: {} }, 0) || {}).kind === 'IMPOSSIBLE_MT');

    // THE ORDERING. When the row HAS weights, they give the better sentence —
    // "this is your net weight in POUNDS, and in MT it is 22.571" beats "that
    // is not a tonnage". The ceiling must not steal that case.
    const both = iw.problemFor({ item_desc: 'X', weight: 49760, packing: { net_weight_lbs: '49760' } }, 0);
    ck('  a row that trips BOTH still reports the pounds finding',
       both && both.kind === 'POUNDS_IN_MT', both && both.kind);

    // The vaguer finding, for a mistake that is not the pounds one.
    const far = iw.problemFor(row({ weight: 71 }), 0);
    ck('  but a tenfold difference IS caught', far && far.kind === 'FAR_OFF', far && far.kind);
    ck('    and says how far apart they are', far && /10 times apart/.test(far.why), far && far.why);
}

// ── C. THROUGH THE REAL ROUTE ───────────────────────────────────────────────
// Apsara's rule, 2026-09-17: "ALwyas test end to end when you add a new
// feature." The helper being right proves nothing about whether the route
// consults it or whether the refusal can be got past.
section('C. the route refuses, and can be overridden');
{
    const http = require('http');
    const { createApi } = require(path.join(ROOT, 'api'));
    const app = createApi();
    const listener = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${listener.address().port}`;
    const req = (p2, body, sid) => new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r2 = http.request(base + p2, { method: 'POST', headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
        });
        r2.on('error', reject); r2.write(data); r2.end();
    });
    const sid = ((await req('/login', { password: 'admin-pw-ddddddddddd' })).json || {}).sid;
    ck('logged in', !!sid);

    const payload = (over) => ({
        inv_no: '260918_AP_26Aris02', inv_date: '09/18/2026', consignee: 'Aris Enterprises USA LLC',
        container_no: 'MSDU2726332', booking_no: 'EBKG18670536',
        line_items: [row({ weight: 15642, rate: 0.548 })], ...over,
    });

    const refused = await req('/api/invoice/generate', payload(), sid);
    ck('the route REFUSES her invoice', refused.status === 409,
       `${refused.status} — it would have generated a document declaring 15,642 MT`);
    ck('  with a code the screen can act on',
       refused.json && refused.json.code === 'WEIGHT_MISMATCH', JSON.stringify(refused.json).slice(0, 140));
    ck('  and the offending rows, not just a sentence',
       refused.json && (refused.json.problems || []).length === 1
       && refused.json.problems[0].kind === 'POUNDS_IN_MT');
    ck('  the message names the consequence, not the rule',
       refused.json && /wrong tonnage/.test(refused.json.error), refused.json && refused.json.error);

    // ── AND IT IS A QUESTION, NOT A WALL ────────────────────────────────
    // A quantity that disagrees with the weights is not automatically wrong:
    // a contract weight, an agreed deduction or a buyer's own scale all
    // produce a legitimate difference. Blocking her from invoicing would be
    // a worse bug than the one this fixes.
    const forced = await req('/api/invoice/generate', payload({ weights_ok: true }), sid);
    ck('weights_ok gets past the guard',
       forced.status !== 409 && !(forced.json && forced.json.code === 'WEIGHT_MISMATCH'),
       `${forced.status} ${JSON.stringify(forced.json).slice(0, 120)}`);

    // A correct invoice is not asked anything at all.
    const fine = await req('/api/invoice/generate',
        payload({ line_items: [row({ weight: 7.095, rate: 1208 })] }), sid);
    ck('a correct invoice is never questioned',
       !(fine.json && fine.json.code === 'WEIGHT_MISMATCH'), JSON.stringify(fine.json).slice(0, 120));

    listener.close();
}

// ── D. THE SCREEN RE-POSTS THE OVERRIDE ─────────────────────────────────────
// The half a server test cannot see. If the screen swallows the 409, the
// refusal reads to her as "Generate did nothing" — and the next thing anyone
// does with a button that did nothing is press it again.
section('D. the website handles the refusal');
{
    const { JSDOM } = require('jsdom');
    const WEB = fs.readFileSync(path.join(ROOT, 'dashboard/documents.html'), 'utf8');
    const posts = [];
    let asked = null;
    const dom = new JSDOM(WEB, { runScripts: 'dangerously', url: 'http://localhost/documents',
        beforeParse(w) {
            w.fetch = (u, o) => {
                const s = String(u);
                if (s.includes('/api/invoice/generate')) {
                    const body = JSON.parse((o && o.body) || '{}');
                    posts.push(body);
                    if (body.weights_ok !== true) {
                        return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({
                            error: '1 row states a quantity in POUNDS in the MT column. This invoice would go out declaring the wrong tonnage.',
                            code: 'WEIGHT_MISMATCH',
                            problems: [{ row: 1, item: 'Sealed units', kind: 'POUNDS_IN_MT',
                                         why: "Quantity reads 15,642, which is this row's net weight in POUNDS. In MT that is 7.095." }],
                        }) });
                    }
                    return Promise.resolve({ ok: true, status: 200,
                        json: () => Promise.resolve({ ok: true, saved_filename: 'X.pdf' }) });
                }
                return Promise.resolve({ ok: true, status: 200,
                    json: () => Promise.resolve({ ok: true, entries: [], bols: [], packing_lists: [] }),
                    blob: () => Promise.resolve({ size: 0 }) });
            };
            w.alert = () => {};
            w.confirm = (m) => { asked = m; return true; };
        } });
    await new Promise((r) => setTimeout(r, 400));
    const w = dom.window;

    w.eval("$('inv_no').value='260918_AP_26Aris02'; $('inv_container').value='MSDU2726332';"
         + "$('invItemsEditor').innerHTML = invItemRowHtml({ item_desc:'Sealed units', weight:15642, rate:0.548, packing:{gross_weight_lbs:'16122', truck_lbs:'480'} }, 0);"
         + "$('invItemsEditor').querySelectorAll('.inv-item-row').forEach(wireInvItemRow);");
    w.document.getElementById('btnInvGenerate').click();
    await new Promise((r) => setTimeout(r, 400));

    ck('it posted, was refused, and posted again',
       posts.length === 2, posts.length + ' post(s) — ' + JSON.stringify(posts.map((p2) => !!p2.weights_ok)));
    ck('  the first time WITHOUT the override', posts[0] && posts[0].weights_ok !== true);
    ck('  the second time WITH it', posts[1] && posts[1].weights_ok === true);
    ck('  and she was asked in between', !!asked);
    // Not a bare "are you sure": the rows, so she can decide without going
    // to look. The first version of this asked before showing anything.
    ck('  shown the actual row and figure', !!asked && /Row 1/.test(asked) && /15,642/.test(asked)
       && /7\.095/.test(asked), String(asked).slice(0, 200));

    // ── AND SAYING NO MEANS NO ──────────────────────────────────────────
    posts.length = 0;
    dom.window.confirm = () => false;
    w.document.getElementById('btnInvGenerate').click();
    await new Promise((r) => setTimeout(r, 400));
    ck('declining generates NOTHING', posts.length === 1 && !posts[0].weights_ok,
       JSON.stringify(posts.map((p2) => !!p2.weights_ok)));
    ck('  and says why, rather than looking like a dead button',
       /disagrees with the packing weights/.test(w.document.getElementById('invSuccessMsg').textContent),
       w.document.getElementById('invSuccessMsg').textContent);

    dom.window.close();
}

// ── E. BOTH CALLERS, NOT JUST THE ONE I WAS LOOKING AT ──────────────────────
// CLAUDE.md: "Before adding a requirement to shared code, list its callers and
// check each one can satisfy it." weights_ok is exactly such a requirement.
// The callers of /api/invoice/generate are dashboard/documents.html and
// mobile-app/www/index.html — grepped, both opened, both updated. This check
// is what stops the next change to one of them leaving the other behind.
section('E. the phone does the same thing');
{
    const files = { website: 'dashboard/documents.html', app: 'mobile-app/www/index.html' };
    for (const [who, f] of Object.entries(files)) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        ck(`the ${who} recognises WEIGHT_MISMATCH`, /WEIGHT_MISMATCH/.test(src));
        ck(`  and re-posts with weights_ok`, /weights_ok:\s*true/.test(src));
        ck(`  and does not swallow other errors`,
           /e\.code !== 'WEIGHT_MISMATCH'\) throw e;/.test(src),
           'a catch-all here would hide every other failure behind a weights prompt');
    }

    // ── THE THREE api() HELPERS MUST CARRY THE SAME THINGS ──────────────
    // documents.html's had quietly stopped: it copied `code` and nothing
    // else, so `problems` arrived nowhere and the prompt listing the bad rows
    // printed "undefined". The other two say in a comment that they mirror
    // each other; this is what makes that true of all three.
    for (const [who, f] of Object.entries({ documents: 'dashboard/documents.html',
                                            dashboard: 'dashboard/index.html',
                                            app: 'mobile-app/www/index.html' })) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        ck(`${who}'s api() carries every field the route sent`,
           /for \(const k of Object\.keys\(data \|\| \{\}\)\)/.test(src),
           'a route\'s structured extras would arrive nowhere, silently');
    }

    // The route's own caller list, asserted rather than remembered. A third
    // caller appearing without an answer to this question is the break.
    const callers = [];
    for (const f of ['dashboard/documents.html', 'mobile-app/www/index.html', 'helpers/tools.js',
                     'workflow/actions.js', 'workflow/brain.js']) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        if (/\/api\/invoice\/generate/.test(src)) callers.push(f);
    }
    ck('only the two screens call the generate route', callers.length === 2,
       callers.join(', ') + ' — a voice path has no form to put this question on, which is exactly how '
       + 'recording a wire payment broke on 2026-09-17');
}

// ── F. THE ITEM LABEL SAYS WHAT IS IN THE CONTAINER ─────────────────────────
// Apsara, 2026-09-19: "WHY ITS COMING AS SU?" — and then, plainly, "it is
// scrap auto parts. yeah it will include more than one item in the container."
//
// A container of SCRAP AUTO PARTS holds sealed units, alternators, starters
// and electric motors. Those are things inside the grade, not four grades. The
// per-item scan matched "Sealed units" to SU, found nothing for the other
// three, and announced the container as SU-SEALED UNITS — while the invoice
// NUMBER printed two lines above it said AP.
section('F. the item label follows the invoice number');
{
    const inv = require(path.join(ROOT, 'helpers/invoicePdf'));
    const { ITEM_CODE_MAP } = require(path.join(ROOT, 'helpers/invoiceSheet'));
    const li = (d) => ({ container_no: 'C1', seal_no: 'S', item_desc: d, weight: 7.095, rate: 1208,
                         packing: { gross_weight_lbs: '16122', truck_lbs: '480' } });
    const labelsOn = (invNo, items) => {
        const built = inv.buildInvoiceClassicHtml({ inv_no: invNo, inv_date: '09/18/2026',
            consignee: 'A', booking_no: 'B', line_items: items.map(li) });
        const html = typeof built === 'string' ? built : (built && built.html);
        return Object.entries(ITEM_CODE_MAP).map(([c, n]) => `${c}-${n}`).filter((l) => html.includes(l));
    };

    const hers = labelsOn('260918_AP_26Aris02', ['Sealed units', 'Alternator', 'starter', 'Electric motor']);
    ck('her invoice says what the container IS', hers.join(', ') === 'AP-SCRAP AUTO PARTS', hers.join(', '));
    ck('  and no longer says SU-SEALED UNITS', !hers.includes('SU-SEALED UNITS'),
       'one of four things inside the container, announced as the whole container');

    // ── THE CASE THE OLD ORDER WAS PROTECTING ───────────────────────────
    // Apsara, 2026-09-09: "Invoice description should be Aluminium combo,
    // regular combo as both are there." Her multi-container numbers carry one
    // code per container, so reading ALL of them keeps this right — and
    // reading all of them rather than the first is precisely what makes it
    // safe for the number to lead.
    const two = labelsOn('260901_AL_26JY96_260901_RC_26JY97', ['Aluminium combo', 'Regular combo']);
    ck('a two-material invoice still names both',
       two.join(', ') === 'AL-ALUMINIUM COMBO, RC-REGULAR COMBO', two.join(', '));

    // ── THE DIRECTION THE FIRST ATTEMPT BROKE ───────────────────────────
    // Reading the number first, full stop, made an invoice covering ONE of
    // the containers in a merged number announce BOTH materials. That is
    // worse than the bug it fixed: the SU bug under-named what was in the
    // container, this one would have invented what was in it. Caught by two
    // checks already in tests/invoice-header.js; kept here too because this
    // is the file that explains why the rule is shaped the way it is.
    const oneOfTwo = labelsOn('260901_AL_26JY96_260901_RC_26JY97', ['Regular combo']);
    ck('an invoice for one container of a merged number names only ITS material',
       oneOfTwo.join(', ') === 'RC-REGULAR COMBO', oneOfTwo.join(', '));

    // The sub-item rule, on the signal she actually described: several rows
    // inside ONE container.
    const sub = (() => {
        const built = inv.buildInvoiceClassicHtml({ inv_no: '260918_AP_26Aris02', inv_date: '09/18/2026',
            consignee: 'A', booking_no: 'B',
            line_items: ['Sealed units', 'Alternator'].map((d) => ({ ...li(d), container_no: 'MSDU2726332' })) });
        const html = typeof built === 'string' ? built : built.html;
        return Object.entries(ITEM_CODE_MAP).map(([c, n]) => `${c}-${n}`).filter((l) => html.includes(l));
    })();
    ck('two rows in ONE container are sub-items, so the number wins',
       sub.join(', ') === 'AP-SCRAP AUTO PARTS', sub.join(', '));

    const twoContainers = (() => {
        const built = inv.buildInvoiceClassicHtml({ inv_no: '260901_AL_26JY96_260901_RC_26JY97',
            inv_date: '09/18/2026', consignee: 'A', booking_no: 'B',
            line_items: [{ ...li('Regular combo'), container_no: 'AAAU1111111' },
                         { ...li('Aluminium combo'), container_no: 'BBBU2222222' }] });
        const html = typeof built === 'string' ? built : built.html;
        return Object.entries(ITEM_CODE_MAP).map(([c, n]) => `${c}-${n}`).filter((l) => html.includes(l));
    })();
    ck('  but two rows in TWO containers are grades, so the rows win',
       twoContainers.length === 2, twoContainers.join(', '));

    // ── THE SAME INVOICE WITH container_no NOT FILLED IN ────────────────
    // The clause nothing covered. A mutation deleting "more rows than the
    // number has codes" left every check green, because the fixtures either
    // set container_no or happened to agree both ways. This is the case it
    // is actually for: four sub-item rows, no container on any of them, and
    // descriptions that match a DIFFERENT code from the number. Without the
    // clause this comes back SU-SEALED UNITS — the original bug.
    // li() sets container_no: 'C1', so it has to be stripped or this fixture
    // is not bare and the check passes on the container clause instead —
    // which is exactly what it did the first time it was written.
    const bare = (() => {
        const built = inv.buildInvoiceClassicHtml({ inv_no: '260918_AP_26Aris02', inv_date: '09/18/2026',
            consignee: 'A', booking_no: 'B',
            line_items: ['Sealed units', 'Alternator', 'starter', 'Electric motor']
                .map((d) => { const r = li(d); delete r.container_no; return r; }) });
        const html = typeof built === 'string' ? built : built.html;
        return Object.entries(ITEM_CODE_MAP).map(([c, n]) => `${c}-${n}`).filter((l) => html.includes(l));
    })();
    ck('sub-items with no container_no still follow the number',
       bare.join(', ') === 'AP-SCRAP AUTO PARTS', bare.join(', '));

    const noCode = labelsOn('PLAIN-1234', ['Aluminium combo', 'Regular combo']);
    ck('a number with no code falls back to the line items',
       noCode.join(', ') === 'AL-ALUMINIUM COMBO, RC-REGULAR COMBO', noCode.join(', '));
    ck('  and an unrecognised material still labels nothing rather than guessing',
       labelsOn('PLAIN-1234', ['Widget', 'Doohickey']).length === 0);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
