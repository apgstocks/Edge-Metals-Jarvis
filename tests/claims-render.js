// ── tests/claims-render.js — the claims page actually RUNS ───────────────
//
// Apsara, 2026-10-29: "getting this error on claim creation Could not load
// claims — Can't find variable: fld".
//
// ── WHY 139 GREEN CHECKS DID NOT CATCH IT ────────────────────────────────
// paneLines() was declared at the top level of claims.html while reading
// twelve of claimCard's locals — c, fld, unit, unitOpt, pk, sortedRow and
// the rest. A top-level function cannot see another function's locals, so
// rendering ANY claim threw `ReferenceError: fld is not defined` and the
// page said "Could not load claims". It had been that way since the commit
// that introduced it (c7d9f2c, 2026-10-23): the sorted and damaged panes had
// never once worked.
//
// Every check in tests/claims-sorted.js, claims-assess.js and
// claims-evidence.js reads this file as TEXT — regex over source. Source
// checks are the right tool for "is this field still sent" and they found
// real bugs. But not one of them ever EXECUTED the page, so a file that
// could not run looked perfectly healthy: the strings were all present and
// in the right order.
//
// This file exists to close exactly that gap, and it asserts almost nothing
// about the markup. It asserts that the page loads and that a card renders
// for every assessment type and for the ugly data shapes her real claims
// carry. A page that throws is not a formatting problem, it is an outage.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'dashboard/claims.html');

// Held at its first await, and no network: the same treatment
// tests/load-deck-grouping.js documents. boot() is async and resumes as a
// microtask after the window is gone, and its first $() throws — which
// printed "all passed" and then exited 1 in another file until it was fixed.
function mount() {
    const html = fs.readFileSync(FILE, 'utf8');
    const SCRIPT = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)]
        .map((m) => m[1]).join('\n');
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
    dom.window.fetch = () => new Promise(() => {});
    dom.window.setInterval = () => 0;
    let evalError = null;
    try { dom.window.eval(SCRIPT); } catch (e) { evalError = e; }
    return { dom, w: dom.window, evalError };
}

// ══════════════════════════════════════════════════════════════════════════
section('A — the page loads at all');
const { w, evalError } = mount();
ck('the script evaluates without throwing', evalError === null,
   evalError && (evalError.constructor.name + ': ' + evalError.message));
ck('  and claimCard is reachable', typeof w.claimCard === 'function',
   typeof w.claimCard);

// ══════════════════════════════════════════════════════════════════════════
section('B — a card renders for EVERY assessment, which is where it broke');
// The assessment decides which pane is built. 'sorted' and 'damage' are the
// two that share paneLines and the two that were broken; the others are
// included so a future extraction out of claimCard cannot break one quietly.
const BASE = {
    id: 'C1', status: 'unverified', container_no: 'ABCD1234567',
    customer: 'Rigo Metals', supplier: 'Garduno', paid_price: 0.85,
    paid_price_unit: 'LB', invoice_weight: 40000, sell_price: 2140,
    weight_unit: 'LB',
};
for (const a of ['sorted', 'damage', 'contamination', 'quality', 'grade', null]) {
    const claim = { ...BASE, assessment: a, sorted_lines: [], damage_lines: [] };
    let out = null, threw = null;
    try { out = w.claimCard(claim, 0, {}); } catch (e) { threw = e; }
    ck(`a ${a || 'never-assessed'} claim renders`, !threw && typeof out === 'string' && out.length > 200,
       threw ? `${threw.constructor.name}: ${threw.message}` : `got ${typeof out}`);
}

// ══════════════════════════════════════════════════════════════════════════
section('C — and on the data shapes her real claims actually carry');
// A claim arrives from the mail reader with almost nothing filled in. The
// render must survive that, because the whole point of the screen is to BE
// where she fills it in.
const SHAPES = {
    'nothing but an id': { id: 'C2' },
    'no container, no customer': { id: 'C3', assessment: 'sorted' },
    'nulls where numbers go': { id: 'C4', assessment: 'sorted', paid_price: null,
        invoice_weight: null, sell_price: null, sorted_lines: null },
    'lines with missing fields': { id: 'C5', assessment: 'sorted',
        sorted_lines: [{}, { type: 'clad' }, { weight: 100 }] },
    'a damage claim with lines': { id: 'C6', assessment: 'damage',
        damage_lines: [{ type: 'Bent rims', weight: 400, worth: 0.2 }] },
    'already settled': { id: 'C7', assessment: 'sorted', status: 'settled',
        claim_amount: 1656, sorted_lines: [] },
};
for (const [name, claim] of Object.entries(SHAPES)) {
    let threw = null;
    try { w.claimCard(claim, 0, {}); } catch (e) { threw = e; }
    ck(`  ${name}`, !threw, threw && `${threw.constructor.name}: ${threw.message}`);
}

// ══════════════════════════════════════════════════════════════════════════
section('D — no function the page calls is declared outside the scope it reads');
// The general shape of the bug, asserted directly rather than only through
// the symptom above. Any helper that reads claimCard's locals must live
// inside claimCard; one declared at the top level will throw the moment it
// runs, however complete the source looks.
{
    const src = fs.readFileSync(FILE, 'utf8');
    const lines = src.split('\n');
    const cardAt = lines.findIndex((l) => /^function claimCard\(/.test(l));
    ck('claimCard is found', cardAt > 0, String(cardAt));
    // Brace-balance claimCard, ignoring braces inside strings and comments.
    let depth = 0, started = false, cardEnd = -1;
    for (let i = cardAt; i < lines.length; i++) {
        const L = lines[i];
        let q = null;
        for (let j = 0; j < L.length; j++) {
            const ch = L[j];
            if (q) { if (ch === q && L[j - 1] !== '\\') q = null; continue; }
            if (ch === "'" || ch === '"' || ch === '`') { q = ch; continue; }
            if (ch === '/' && L[j + 1] === '/') break;
            if (ch === '{') { depth += 1; started = true; }
            else if (ch === '}') { depth -= 1; if (started && depth === 0) { cardEnd = i; break; } }
        }
        if (cardEnd >= 0) break;
    }
    ck('  and its extent is known', cardEnd > cardAt, `${cardAt} -> ${cardEnd}`);
    const inside = lines.slice(cardAt, cardEnd + 1).join('\n');
    ck('paneLines lives INSIDE claimCard', /function paneLines\(/.test(inside),
       'declared outside, it cannot see c, fld, unit, unitOpt, pk or sortedRow — '
       + 'which is the outage of 2026-10-29');
    // Only one copy of it, or the one outside is the one that runs.
    ck('  and there is exactly one of it',
       (src.match(/function paneLines\(/g) || []).length === 1,
       String((src.match(/function paneLines\(/g) || []).length));
}

// ══════════════════════════════════════════════════════════════════════════
// THE LANDING STATE — NOTHING OPENS ITSELF, AND THE LIST OWNS THE PAGE
// ══════════════════════════════════════════════════════════════════════════
// Apsara, 2026-11-05, in three messages:
//   "by default,some calim is getting opneed .i feel it to be too clumpsy"
//   "Just let the user do what he wants"
//   "make the headers not just restricted to left side of screen ,unless user
//    selects a container/claim.once user selects something,push the list to
//    left side and proceed"
//
// These RENDER the page. Every claims check that read the file as source text
// stayed green for six days while the page was dead (#243), so a regex here
// would prove nothing: the auto-select lived in load(), the layout lives in a
// body class, and only running it can tell you what the page actually did.
{
    const fsx = require('fs');
    const pathx = require('path');
    const HTML = fsx.readFileSync(pathx.join(__dirname, '..', 'dashboard', 'claims.html'), 'utf8');
    const rows = [
        { id: 1, container_no: 'TEMU7944250', supplier: 'Nur Metal', customer: 'Modern enterprises',
          invoice_no: '26ME07', status: 'verified', claim_date: '2026-10-20', claim_amount: 3550, weight_unit: 'LB' },
        { id: 2, container_no: 'HMMU6180208', supplier: 'Taewon', customer: 'ACME',
          invoice_no: 'X9', status: 'unverified', claim_date: '2026-09-01', claim_amount: 3840.8, weight_unit: 'LB' },
    ];
    // WIDE, because the wide screen is the one that auto-opened. matchMedia
    // returning false is "not narrow".
    const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'http://localhost/claims',
        beforeParse(w) {
            w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
            w.scrollTo = () => {};
            w.fetch = () => Promise.resolve({ ok: true, status: 200, headers: { get: () => 'application/json' },
                json: () => Promise.resolve({ claims: rows, stats: {}, kinds: [],
                    parties: { suppliers: [], customers: [] }, materials: [] }),
                text: () => Promise.resolve('{}') });
        } });
    const w = dom.window, d = w.document;
    const sel = () => d.querySelectorAll('#rows .prow.sel').length;
    const browsing = () => d.body.classList.contains('browsing');

    setTimeout(() => {
        // ── ON ARRIVAL ───────────────────────────────────────────────────
        ck('the list has rows to show', d.querySelectorAll('#rows .prow').length === 2,
           String(d.querySelectorAll('#rows .prow').length));
        ck('NOTHING is open on arrival', sel() === 0,
           'the page used to pick the first container for her');
        ck('  the detail pane is the empty one', /Pick a container on the left/.test(d.getElementById('detail').textContent || ''));
        ck('  and it says only that — no paragraph', (d.getElementById('detail').textContent || '').trim().length < 60,
           JSON.stringify((d.getElementById('detail').textContent || '').trim().slice(0, 80)));

        // ── THE HEADERS, WHICH ARE NOT DATA ──────────────────────────────
        const gb = [...d.getElementById('groupBy').querySelectorAll('button')].map((b) => b.textContent);
        const tb = [...d.getElementById('tabs').querySelectorAll('button')].map((b) => b.textContent);
        // Not a count — a count has to be edited every time she asks for
        // another lens, and an edited check is one nobody re-reads. The
        // property is that the lenses she named are all offered.
        ck('the Group-by header is drawn',
           ['Container', 'Supplier', 'Customer', 'Month'].every((x) => gb.includes(x)), gb.join('|'));
        ck('  and the Open/Settled headers are drawn', tb.length >= 4, tb.join('|'));

        // ── WIDTH: THE LIST OWNS THE PAGE UNTIL SHE PICKS ────────────────
        ck('while browsing, the page is in its full-width state', browsing() === true,
           'the 340px column exists to leave room for a detail pane that is not there');

        // ── SHE PICKS ONE ────────────────────────────────────────────────
        d.querySelector('#rows .prow').click();
        setTimeout(() => {
            ck('picking a container opens it', sel() === 1, String(sel()));
            ck('  and the list goes back to the left', browsing() === false,
               '"once user selects something,push the list to left side and proceed"');
            ck('  with the detail pane filled', (d.getElementById('detail').textContent || '').length > 80);

            // ── AND LETTING GO OF IT RETURNS THE WIDTH ───────────────────
            // Changing the lens drops the selection, because a container id
            // means nothing inside a supplier grouping. The layout has to
            // follow it back, or she is left with a narrow list and no pane.
            d.querySelector('#groupBy button[data-g="supplier"]').click();
            setTimeout(() => {
                ck('changing the lens lets go of the selection', sel() === 0, String(sel()));
                ck('  and the page goes full width again', browsing() === true,
                   'one choke point in renderDetail, or six paths each get it wrong separately');

                // ── THE CUSTOMER LENS ────────────────────────────────────
                // Apsara, 2026-11-05: "Also group by customer as well".
                // Supplier is who Edge recovers FROM; customer is who
                // claimed. Both rows in this fixture are Modern enterprises
                // against two DIFFERENT suppliers, which is the case that
                // matters: it is what makes the claim report wrong here.
                const lenses = [...d.querySelectorAll('#groupBy button')].map((b) => b.textContent);
                ck('Customer is one of the lenses', lenses.includes('Customer'), lenses.join('|'));
                const cb = d.querySelector('#groupBy button[data-g="customer"]');
                ck('  and it is clickable', !!cb);
                cb.click();
                setTimeout(() => {
                    const who = [...d.querySelectorAll('#rows .prow .who')].map((e) => e.textContent);
                    ck('claims group under the customer who claimed',
                       who.includes('Modern enterprises'), who.join('|'));
                    ck('  two containers from one customer become ONE row',
                       who.filter((x) => x === 'Modern enterprises').length === 1, who.join('|'));

                    // The row this asserts on, not whichever sorts first —
                    // the sort is by money and this fixture's amounts are
                    // not the point of the check.
                    const mrow = [...d.querySelectorAll('#rows .prow')]
                        .find((b) => /Modern enterprises/.test(b.textContent));
                    ck('  and that row can be opened', !!mrow);
                    mrow.click();
                    setTimeout(() => {
                        const det = d.getElementById('detail');
                        const sub = (det.querySelector('.sub') || {}).textContent || '';
                        ck('the pane is headed by the customer',
                           (det.querySelector('h2') || {}).textContent === 'Modern enterprises');
                        ck('  and still names who to recover from', /recover from/.test(sub), sub);

                        // ── THE GUARD, AND THE REASON FOR IT ─────────────
                        // The claim report is a demand ADDRESSED TO ONE
                        // supplier. This row spans two. Offering it would
                        // build Taewon's document out of Nur Metal's claims,
                        // and reportMenu's container branch would fetch
                        // container="Modern enterprises" — empty, with
                        // nothing on screen saying why.
                        ck('a claim report is NOT offered under the customer lens',
                           !/Claim report/.test(det.textContent),
                           'a demand to one supplier cannot be built from a customer row');
                        ck('  nor "+ another claim", which would invent a container',
                           !d.getElementById('addClaim'));

                        console.log(`\n  ${pass} passed, ${fail} failed`);
                        if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }
                        process.exit(0);
                    }, 60);
                }, 60);
                return;
                /* eslint-disable no-unreachable */
                console.log(`\n  ${pass} passed, ${fail} failed`);
                if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }
                process.exit(0);
            }, 60);
        }, 60);
    }, 700);
}

// The page's own boot is async, so the summary is printed inside the block
// above, after the last timeout. This is the only way out if it never boots.
setTimeout(() => {
    console.log('\n  CRASHED: the claims page never finished booting');
    process.exit(1);
}, 6000);
