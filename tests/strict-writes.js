// ── tests/strict-writes.js ──────────────────────────────────────────────────
// Apsara, 2026-09-19, asked whether the ledgers should move from JSON files to
// a database. Counting the writes to answer her turned up this:
//
//     146 mutateJson writes in the codebase.  15 strict.  131 silent.
//
// mutateJson is forgiving by default. On failure it logs, returns loadJson()
// and NEVER RUNS THE MUTATOR — handing the caller plausible-looking data with
// no way to tell the write never landed. helpers/json.js's own note says the
// paths where a lost write means lost DATA should opt in. Adding a bill,
// editing a bill, recording a supplier payment, an expense: none of them had.
//
// ── AND IT SWALLOWS MUTATOR BUGS TOO, NOT JUST LOCK CONTENTION ──────────────
// The catch wraps the whole read-modify-write. A bug thrown inside the mutator
// takes the same silent path and returns stale data as though it had worked,
// which is worse than the contention case because it needs no second writer.
//
// ── WHY NOT A DATABASE INSTEAD ──────────────────────────────────────────────
// Her data is ~600 containers a year and a few MB; nothing is slow. Writes are
// already atomic — lock, temp file, rename, unique temp name per write. The
// genuine wins of a database here are transactions across stores and joins,
// neither of which is urgent, and a migration touches 234 call sites across 56
// files. This is the part that can actually lose one of her entries, and it is
// an afternoon.

const fs = require('fs');
const os = require('os');
const path = require('path');
const lockfile = require('proper-lockfile');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-strict-'));
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
const { mutateJson, loadJson } = require(path.join(ROOT, 'helpers/json'));
const bills = require(path.join(ROOT, 'helpers/bills'));

const BILL = { date: '09/10/2026', supplier: 'Gomez', container_no: 'AAAU1111111',
               gross: 44000, truck: 15000, supplier_price: 0.32 };

(async () => {

// ── A. THE ORDINARY PATH IS UNCHANGED ───────────────────────────────────────
// Said first, because a change that makes writes fail loudly is worthless if
// it also makes them fail when nothing is wrong.
section('A. a normal save still saves');
{
    const saved = await bills.addBill(BILL);
    ck('adding a bill works', !!saved && !!saved.id);
    ck('  and it is really on disk',
       loadJson(cfg.BILLS_FILE, []).some((b) => b.id === saved.id));

    const edited = await bills.editBill(saved.id, { supplier: 'Gomez Metals' });
    ck('editing works', edited && edited.supplier === 'Gomez Metals', JSON.stringify(edited && edited.supplier));
    ck('  and is on disk',
       loadJson(cfg.BILLS_FILE, []).find((b) => b.id === saved.id).supplier === 'Gomez Metals');

    await bills.deleteBill(saved.id);
    ck('deleting works', !loadJson(cfg.BILLS_FILE, []).some((b) => b.id === saved.id));
}

// ── B. A WRITE THAT CANNOT LAND SAYS SO ─────────────────────────────────────
// The whole point. The lock is held by someone else for longer than
// LOCK_OPTS will wait (8 retries, 40ms to 400ms), so the write genuinely
// cannot happen — exactly the two-people-at-once case.
section('B. a blocked write throws instead of lying');
{
    const before = loadJson(cfg.BILLS_FILE, []).length;
    // ensureFile has run by now, so there is a file to lock.
    const release = await lockfile.lock(cfg.BILLS_FILE, { stale: 30000, realpath: false });

    let err = null, result;
    try { result = await bills.addBill({ ...BILL, container_no: 'BLOCKED0001' }); }
    catch (e) { err = e; }
    await release();

    ck('it THROWS rather than returning', !!err && result === undefined,
       err ? '' : 'it returned ' + JSON.stringify(result) + ' having written nothing');
    ck('  and nothing was written', loadJson(cfg.BILLS_FILE, []).length === before,
       'the count moved, so something landed after all');
    ck('  and the bill really is not there',
       !loadJson(cfg.BILLS_FILE, []).some((b) => b.container_no === 'BLOCKED0001'));

    // ── THE OLD BEHAVIOUR, FOR CONTRAST ─────────────────────────────────
    // A non-strict write in the same situation returns the CURRENT contents
    // and never runs the mutator. It looks exactly like success, and that is
    // what 131 writes were doing.
    const release2 = await lockfile.lock(cfg.BILLS_FILE, { stale: 30000, realpath: false });
    let ran = false;
    const forgiving = await mutateJson(cfg.BILLS_FILE, [], (all) => { ran = true; all.push({ id: 'X' }); return all; });
    await release2();
    ck('a NON-strict write in the same situation returns data and never ran',
       ran === false && Array.isArray(forgiving),
       'if this ever fails, mutateJson\'s default changed and 131 call sites changed with it');
    ck('  which is indistinguishable from success', !forgiving.some((b) => b.id === 'X'),
       'the caller gets a plausible array back and no way to know');
}

// ── C. A BUG IN THE MUTATOR SURFACES TOO ────────────────────────────────────
// The sharper half: this needs no second writer at all.
section('C. a throwing mutator is not swallowed');
{
    let strictErr = null;
    try {
        await mutateJson(cfg.BILLS_FILE, [], () => { throw new Error('bug in the mutator'); }, { strict: true });
    } catch (e) { strictErr = e; }
    ck('strict surfaces it', !!strictErr && /bug in the mutator/.test(strictErr.message),
       String(strictErr));

    const quiet = await mutateJson(cfg.BILLS_FILE, [], () => { throw new Error('bug in the mutator'); });
    ck('  while the forgiving default returns data as though it worked', Array.isArray(quiet),
       'the same silent shape, reachable with one writer and a typo');
}

// ── D. THE MONEY STORES ARE STRICT, AND STAY STRICT ─────────────────────────
// A source guard, because the next write added to bills.js will default back
// to forgiving unless someone remembers. Nobody remembered 131 times.
section('D. every money write opts in');
{
    // ── THE LIST THAT MISSED THE ONE THAT MATTERED ───────────────────────
    // This was five names, and `loads` was not among them. On 2026-09-21
    // Apsara entered a load, saw it in the app, could not find it on the
    // website, and found it gone from the app after a restart — loads.json
    // was still on the forgiving default, so the write failed, addLoad
    // returned the record anyway and the route answered 200. Her yard's
    // PRIMARY ledger, guarded by a test that did not look at it.
    //
    // So the list is now every store that holds something she cannot
    // reconstruct: the money, and the loads the money is about.
    const MONEY = ['bills', 'sales', 'billPayments', 'payments', 'expenses',
                   'loads', 'outboundLoads', 'pettyCash', 'truckerBills', 'metalsTrucking'];
    for (const name of MONEY) {
        const src = fs.readFileSync(path.join(ROOT, `helpers/${name}.js`), 'utf8');

        // ── TWO IDIOMS, AND THE COUNT ONLY UNDERSTOOD ONE ────────────────
        // The old check compared how many times `mutateJson(` appears to how
        // many `{ strict: true }` do. That works when every call site passes
        // the option, and reports a FALSE FAILURE for the other idiom — one
        // wrapper at the top of the file, strict once, used everywhere. So
        // the rule is stated the way it actually matters instead: this file
        // must never be able to reach the FORGIVING mutateJson.
        const wraps = /mutateJson:\s*mutateJsonRaw/.test(src)
            && /const mutateJson\s*=\s*\(.*\)\s*=>\s*mutateJsonRaw\([^)]*\{ strict: true \}\s*\)/.test(src);
        const writes = (src.match(/mutateJson\(/g) || []).length;
        if (wraps) {
            ck(`${name}: wraps mutateJson strictly, so all ${writes} writes are`, writes > 0);
            // A wrapper only helps while nothing bypasses it.
            ck(`  ${name}: and nothing calls the raw one directly`,
               !/mutateJsonRaw\(/.test(src.replace(/const mutateJson\s*=[^;]+;/, '')),
               'a call that skips the wrapper skips the strictness with it');
        } else {
            const strict = (src.match(/\{ strict: true \}/g) || []).length;
            ck(`${name}: all ${writes} writes are strict`, writes > 0 && strict >= writes,
               `${strict} of ${writes} — a forgiving write here can lose one of her entries`);
        }
    }

    // And the note saying why, so the next person adding a write sees it.
    const b = fs.readFileSync(path.join(ROOT, 'helpers/bills.js'), 'utf8');
    ck('  with the reason written down', /STRICT: THIS WRITE EITHER HAPPENS OR SAYS SO/.test(b));
    ck('  and no retry loop bolted on top',
       !/for \(let attempt/.test(b.slice(b.indexOf('STRICT: THIS WRITE'), b.indexOf('STRICT: THIS WRITE') + 2000)),
       'LOCK_OPTS already backs off eight times; a second layer defends against nothing');
}

// ── E. EVERY CALLER CAN SURVIVE A THROW ─────────────────────────────────────
// Making a shared write throw is a new requirement on every caller — the
// 2026-09-17 lesson in CLAUDE.md, where a rule added to shared code broke the
// one path that could not satisfy it. Here the hazard is different and worse:
// an un-awaited write becomes an unhandled rejection, and Node 22 exits on
// those. Checked by grep at the time (18 route call sites, all inside a try;
// no floating calls anywhere) and asserted here so it stays true.
section('E. no write is left floating');
{
    const WRITERS = ['addBill', 'editBill', 'deleteBill', 'addSale', 'editSale', 'deleteSale',
                     'addBillPayment', 'addAdvance', 'applyAdvance', 'deleteBillPayment',
                     'addExpense', 'editExpense', 'deleteExpense', 'addPayment', 'deletePayment'];
    const re = new RegExp(`(?<![\\w.])(${WRITERS.join('|')})\\s*\\(`);
    const floating = [];
    const walk = (dir) => {
        for (const f of fs.readdirSync(dir)) {
            const p = path.join(dir, f);
            if (fs.statSync(p).isDirectory()) continue;
            if (!f.endsWith('.js')) continue;
            fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => {
                const m = re.exec(l);
                if (!m) return;
                if (/^\s*(\/\/|\*)/.test(l)) return;
                if (/async function|function |module\.exports|require\(/.test(l)) return;
                const before = l.slice(0, m.index).trimEnd();
                if (/(await|return|=|\.then|=>|\bcatch\()\s*$/.test(before)) return;
                floating.push(`${path.relative(ROOT, p)}:${i + 1}  ${l.trim().slice(0, 80)}`);
            });
        }
    };
    walk(path.join(ROOT, 'helpers'));
    walk(path.join(ROOT, 'workflow'));
    walk(ROOT);
    ck('no money write is called without await', floating.length === 0,
       floating.join('\n        ') + '\n        an unhandled rejection exits the process on Node 22');

    // The routes catch. A 500 she can see beats a save that quietly did
    // nothing — but only if the process is still up to send it.
    const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8').split('\n');
    let unprotected = 0;
    api.forEach((l, i) => {
        if (!re.test(l)) return;
        let guarded = false;
        for (let j = i; j > Math.max(0, i - 60); j--) {
            if (/^\s*app\.(get|post|put|delete|patch)\(/.test(api[j])) break;
            if (/\btry\s*\{/.test(api[j])) { guarded = true; break; }
        }
        if (!guarded) unprotected += 1;
    });
    ck('  and every route call sits inside a try', unprotected === 0, String(unprotected));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
