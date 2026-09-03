// ── tests/petty-cash-clients.js ───────────────────────────────────────────
// The client half of petty cash, extracted from the shipped HTML and run.
//
// The server rules are covered by tests/petty-cash.js. What that file cannot
// see is whether the UI ever ASKS before capping a payment — and "make it as
// partial payment and notify user" is a request about the asking. A perfect
// server rule behind a form that silently retries, or never retries, fails her
// request in opposite ways and both look fine from the server's side.
//
// Also here: the duplicate-row button, whose one rule that matters is what it
// does NOT copy.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const CLIENTS = [
    ['app', fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8')],
    ['website', fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8')],
];
const pending = [];
const nocomment = (t) => String(t).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

function grab(src, name, label) {
    for (const kw of ['async function ', 'function ']) {
        const i = src.indexOf(kw + name + '(');
        if (i < 0) continue;
        // Start at the BODY, not the first '{' after the name — a destructured
        // parameter list would otherwise be mistaken for the whole function.
        // (That exact mistake cost three false failures in tests/report-sheets.js.)
        const bodyStart = src.indexOf(') {', src.indexOf('(', i)) + 2;
        let d = 0;
        for (let k = bodyStart; k < src.length; k++) {
            if (src[k] === '{') d++;
            else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
        }
    }
    throw new Error(`${label}: could not find ${name}()`);
}

console.log('\n─ petty cash and duplicate row, in the shipped clients ──────');

// ── 1. the Pay form asks before it caps ───────────────────────────────────
section('A — a short cash balance is a question, not a silent cap');
for (const [label, src] of CLIENTS) {
    const handler = (() => {
        const i = src.indexOf("$('btnSavePay').addEventListener");
        const j = src.indexOf("$('payErr').textContent = e.message", i);
        return nocomment(src.slice(i, j));
    })();

    ck(`${label}: the shortfall is recognised by CODE, not by message text alone`,
       /err\.code === 'PETTY_CASH_SHORT'/.test(handler),
       'matching only on words means the prompt fires on unrelated failures, or not at all');
    ck(`${label}: it asks before recording anything`, /confirm\(/.test(handler));
    ck(`${label}: the prompt states what is available and what is left over`,
       /Only \$\{fmtAmount\(avail\)\}/.test(handler) && /outstanding/.test(handler));
    ck(`${label}: declining records NOTHING`,
       /if \(!ok\) \{[^}]*return;/.test(handler),
       'a cancelled prompt that still posts is worse than no prompt');

    // THE CENTRAL RULE. allow_partial must appear exactly once, on the retry
    // that follows the confirm — never on the first attempt, or the server's
    // refusal is bypassed and the cap becomes silent after all.
    ck(`${label}: allow_partial is sent exactly once`,
       (handler.match(/allow_partial/g) || []).length === 1);
    const firstPost = handler.slice(0, handler.indexOf('confirm('));
    ck(`${label}:   ...and NOT on the first attempt`, !/allow_partial/.test(firstPost),
       'sending it up front skips the server refusal entirely — the operator would never be asked');
    ck(`${label}:   ...but on the retry, after the confirm`,
       handler.indexOf('allow_partial') > handler.indexOf('confirm('));

    // The retry must resend the ORIGINAL amount and let the server cap it.
    // Sending the balance this browser saw reintroduces the race the file
    // lock exists to close.
    const retry = handler.slice(handler.indexOf('allow_partial') - 200);
    ck(`${label}: the retry does not send the balance the browser saw`,
       !/amount:\s*avail/.test(retry),
       'the server re-reads under its lock; a browser-supplied figure could be stale');
}

// ── 2. api() has to carry the numbers through ─────────────────────────────
section('B — the structured error survives api()');
for (const [label, src] of CLIENTS) {
    const api = nocomment(grab(src, 'api', label));
    ck(`${label}: non-error fields are copied onto the Error`,
       /for \(const k of Object\.keys\(data \|\| \{\}\)\) \{ if \(k !== 'error'\)/.test(api),
       'without this err.available is undefined and the prompt can never fire');
    ck(`${label}: the status is kept too`, /\.status = res\.status/.test(api));

    // Behavioural: run the real function against a fake fetch and check the
    // fields actually arrive. Source-matching alone would pass on a line that
    // is present but wrong.
    // The GET cache added 2026-09-03 lives in the same scope as api() and the
    // function now closes over it, so the extraction has to bring it along.
    // Without it this threw ReferenceError — which is how the change was
    // noticed here, rather than this file quietly testing an old shape.
    //
    // Taken as ONE contiguous slice from the cache declarations through the
    // end of api(), so a future declaration added between them cannot be
    // double-counted into an "already declared" error.
    const cacheAndApi = (() => {
        const start = src.indexOf('const apiCache = new Map();');
        if (start < 0) return grab(src, 'api', label);      // website, no cache
        const apiStart = src.indexOf('async function api(path, opts = {})');
        let d = 0;
        for (let k = src.indexOf(') {', apiStart) + 2; k < src.length; k++) {
            if (src[k] === '{') d++;
            else if (src[k] === '}') { d--; if (!d) return src.slice(start, k + 1); }
        }
        return grab(src, 'api', label);
    })();
    const fn = new Function('fetch', 'location', 'setToken', 'showLoginScreen', 'getToken', 'API_BASE',
        cacheAndApi + '; return api;')(
        async () => ({ status: 400, ok: false, json: async () => ({ error: 'nope', code: 'PETTY_CASH_SHORT', available: 400, requested: 1500 }) }),
        { href: '' }, () => {}, () => {}, () => null, '');
    // COLLECTED, not returned. The first version wrote `return fn(...)` inside
    // this loop — and at CommonJS module scope `return` is legal, so it exited
    // the whole file after the first client. Sections C and D never ran and
    // the suite still reported a clean pass. Exactly the shape of the dead
    // test this project has already shipped once.
    pending.push(fn('/api/payments', { method: 'POST' }).then(
        () => ck(`${label}: a 400 rejects`, false),
        (e) => {
            ck(`${label}: err.code arrives`, e.code === 'PETTY_CASH_SHORT');
            ck(`${label}: err.available arrives`, e.available === 400);
            ck(`${label}: err.requested arrives`, e.requested === 1500);
            ck(`${label}: and the message still reads`, e.message === 'nope');
        }));
}

// ── 3. the tab ────────────────────────────────────────────────────────────
section('C — the tab is visible to staff and writable only by admin');
for (const [label, src] of CLIENTS) {
    const tab = nocomment(grab(src, 'renderPettyCashTab', label));
    ck(`${label}: the balance comes from the server, not summed here`,
       /pettyCash\.balance/.test(tab) && !/reduce\(/.test(tab),
       'a balance computed in two places is a balance two screens can disagree about');
    ck(`${label}: the top-up button is admin-only`, /\$\{isAdmin \? '<button id="btnAddPetty"/.test(tab));
    ck(`${label}: an empty box says cash payments will be refused`,
       /Cash payments are refused while this is empty/.test(tab),
       'she chose refusal over a negative balance — the screen has to say so before someone tries');
    ck(`${label}: only top-ups offer Delete`,
       /e\.kind === 'topup' \? `<button class="btn btn-danger btn-del-petty"/.test(tab),
       'a withdrawal is undone by deleting its payment, which reverses it properly');

    const refresh = nocomment(grab(src, 'refreshPettyCash', label));
    ck(`${label}: a failed refresh keeps the last balance rather than showing $0`,
       !/balance:\s*0/.test(refresh.slice(refresh.indexOf('catch'))),
       'showing $0.00 because a request failed is a false statement about money');
}

// staff visibility — the half of the change that is easy to forget
{
    const web = CLIENTS.find(c => c[0] === 'website')[1];
    ck('website: the nav entry is NOT adminOnly',
       /\{ id: 'petty',\s+label: 'Petty Cash',\s+group: 'Yard' \},/.test(web));
    ck('website: and staff are not filtered out of it',
       /ROLE !== 'staff' \|\| n\.id === 'loads' \|\| n\.id === 'petty'/.test(web),
       'the staff filter allowed only Loads — without this the tab exists and staff never see it');
    ck('website: the tab routes to the renderer', /if \(tab === 'petty'\) return renderPettyCashTab\(\);/.test(web));

    const app = CLIENTS.find(c => c[0] === 'app')[1];
    ck('app: the tab button is outside the admin-only group',
       /tabBtn\('petty', 'Petty cash'\),/.test(app)
       && app.indexOf("tabBtn('petty'") < app.indexOf("ROLE === 'admin' ? [tabBtn('expenses'"));
    ck('app: the tab routes to the renderer', /currentMobileTab === 'petty'\) \{ await renderPettyCashTab\(\); return; \}/.test(app));
}

// ── 4. duplicate row ──────────────────────────────────────────────────────
section('D — duplicate copies what was typed, never the evidence');
for (const [label, src] of CLIENTS) {
    const i = src.indexOf(".btn-dup-item').forEach");
    const block = nocomment(src.slice(i, src.indexOf('}));', i)));

    ck(`${label}: the duplicate button exists`, /class="btn btn-dup-item"/.test(src));
    for (const field of ['description', 'gross_weight', 'tare_weight', 'price', 'unit']) {
        ck(`${label}: copies ${field}`, new RegExp(field + '\\s*:').test(block));
    }
    // THE RULE THAT MATTERS. A scale photo is a picture of ONE weighing.
    // Cloning it onto another item puts a photograph of a different load's
    // weight against that item, and it looks exactly like real evidence on the
    // ticket and in Drive. A fabricated audit trail is worse than no photo.
    for (const f of ['gross_photo_link', 'tare_photo_link', 'gross_photo_drive_id', 'tare_photo_drive_id', 'grossPhoto', 'tarePhoto']) {
        ck(`${label}: does NOT copy ${f}`, !new RegExp(f + '\\s*:').test(block),
           'cloning a scale photo onto another item fabricates evidence');
    }
    ck(`${label}: it starts from a blank item, so new fields default safely`,
       /Object\.assign\(blankLoadItem\(\)/.test(block),
       'spreading the source instead would silently carry any field added later, photos included');
    ck(`${label}: the row goes directly below the one copied`, /splice\(idx \+ 1, 0,/.test(block));
    ck(`${label}: "+" still inserts a BLANK row`,
       /btn-insert-item'\)\.forEach[\s\S]{0,400}blankLoadItem\(\)\);/.test(nocomment(src)));
}

// Waits on the async api() checks explicitly rather than guessing at a
// timeout — a suite that reports before its assertions have run is a suite
// that can only ever pass.
Promise.all(pending).then(() => {
    console.log(`\n  ${pass} passed, ${fail} failed`);
    if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
    process.exit(fail ? 1 : 0);
});
