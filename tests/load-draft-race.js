// ── tests/load-draft-race.js — the draft that outlived its own save ───────
//
// Apsara, 2026-09-30, about EDGE_98 and EDGE_99 — same seller, same 9,260 lb,
// same $6,405.96, one minute apart:
//
//   "He just saved it first.then edit ,continue or cancel.he clicked
//    continue,then it generated twice."
//
// ── THE RACE ──────────────────────────────────────────────────────────────
// currentDraftId is assigned only when the autosave POST RESOLVES:
//
//     const r = await api('/api/load-drafts', ...);
//     if (r && r.saved && r.id) currentDraftId = r.id;
//
// Press Save while one is still in the air and clearLoadDraft ran with
// currentDraftId === null, hit `if (!id) return;` and deleted NOTHING. The
// autosave then landed and set the id — leaving a draft on the server for a
// load that had already been committed.
//
// The Loads screen offers that orphan as "Unfinished load...". Continuing it
// goes openLoadDraft -> resetLoadModal, which sets editingLoadId = null, so
// the form is in CREATE mode and Save writes a SECOND load. Two records, one
// delivery, and Josue is owed $6,405.96 once but shown twice.
//
// ── WHY THIS IS ITS OWN FILE, AND WHY IT RUNS THE FUNCTION ────────────────
// The bug is a matter of ORDER, and no regex over the source can see order.
// So the REAL clearLoadDraft is executed against a REAL in-flight save.
//
// It is separate from tests/dashboard-load-draft.js because that file ends
// with a synchronous process.exit, which killed an async check added to it
// before the check could finish — it reported green having run nothing.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass += 1; console.log('  PASS  ' + n); }
    else { fail += 1; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};

// Pulled out of the page the same way tests/dashboard-load-draft.js does it.
const grabFrom = (src, name) => {
    const i = src.indexOf('async function ' + name + '(');
    if (i < 0) throw new Error('not found: ' + name);
    let d = 0, j = src.indexOf('{', i);
    for (let k = j; k < src.length; k += 1) {
        if (src[k] === '{') d += 1;
        else if (src[k] === '}') { d -= 1; if (!d) return src.slice(i, k + 1); }
    }
    throw new Error('unbalanced: ' + name);
};

(async () => {
for (const file of ['dashboard/index.html', 'mobile-app/www/index.html']) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const fnSrc = grabFrom(src, 'clearLoadDraft');
    console.log(`\n=== ${file} ===`);

    // ── RUN IT, WITH AN AUTOSAVE STILL IN FLIGHT ──────────────────────────
    // The function closes over module-level variables, so it is rebuilt
    // inside a scope that provides them and resolves the autosave late —
    // exactly the sequence that produced the duplicate.
    const harness = new Function('deps', `
        let { draftTimer, draftSaveInFlight, currentDraftId, api, setDraftStatus } = deps;
        deps.resolveLate(() => { currentDraftId = 'draft-99'; draftSaveInFlight = false; });
        ${fnSrc}
        return clearLoadDraft();
    `);

    let deleted = null;
    let resolver = null;
    await harness({
        draftTimer: null,
        draftSaveInFlight: true,       // in the air
        currentDraftId: null,          // ...and not yet known
        setDraftStatus: () => {},
        api: async (url, opts) => { if (opts && opts.method === 'DELETE') deleted = url; return {}; },
        resolveLate: (fn) => { resolver = setTimeout(fn, 120); },
    });
    clearTimeout(resolver);

    ck('a draft whose autosave was still in flight is STILL deleted',
       deleted === '/api/load-drafts/draft-99',
       `deleted = ${JSON.stringify(deleted)} — an orphan here becomes the second load`);

    // ── THE WAIT MUST BE BOUNDED ──────────────────────────────────────────
    // A draft is a convenience. It must never hold up confirming a load that
    // is already on disk, however wedged the autosave gets.
    ck('  the wait is bounded, not indefinite',
       /Date\.now\(\) - startedWaiting < \d+/.test(fnSrc),
       'an unbounded wait turns a slow draft save into a frozen Save button');
    ck('  and it waits on the flag, not on a fixed sleep',
       /while \(draftSaveInFlight/.test(fnSrc),
       'a fixed sleep is both too long usually and too short sometimes');

    // ── AND IT STILL DOES WHAT IT ALWAYS DID ──────────────────────────────
    // Nothing in flight: the ordinary path must be unchanged and immediate.
    let deleted2 = null;
    const h2 = new Function('deps', `
        let { draftTimer, draftSaveInFlight, currentDraftId, api, setDraftStatus } = deps;
        ${fnSrc}
        return clearLoadDraft();
    `);
    const t0 = Date.now();
    await h2({
        draftTimer: null, draftSaveInFlight: false, currentDraftId: 'draft-7',
        setDraftStatus: () => {},
        api: async (url, opts) => { if (opts && opts.method === 'DELETE') deleted2 = url; return {}; },
    });
    ck('  with nothing in flight it deletes as before', deleted2 === '/api/load-drafts/draft-7',
       String(deleted2));
    ck('  and does not linger', Date.now() - t0 < 60, `${Date.now() - t0}ms`);

    // No draft at all is still a no-op, not a DELETE of undefined.
    let deleted3 = 'untouched';
    const h3 = new Function('deps', `
        let { draftTimer, draftSaveInFlight, currentDraftId, api, setDraftStatus } = deps;
        ${fnSrc}
        return clearLoadDraft();
    `);
    await h3({
        draftTimer: null, draftSaveInFlight: false, currentDraftId: null,
        setDraftStatus: () => {},
        api: async (url, opts) => { if (opts && opts.method === 'DELETE') deleted3 = url; return {}; },
    });
    ck('  no draft at all deletes nothing', deleted3 === 'untouched', String(deleted3));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
