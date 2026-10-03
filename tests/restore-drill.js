// ── tests/restore-drill.js ────────────────────────────────────────────────
// Apsara, 2026-10-03, asked which productionisation work came first and chose
// the backup restore drill: prove the whole data directory can be rebuilt
// from an archive onto a fresh box, and time it.
//
// ── WHAT THE DRILL FOUND BEFORE IT RAN ───────────────────────────────────
// There was no restore code. helpers/backup.js has uploaded a dated archive
// every night for weeks and says "restore" three times — all comments, one of
// them "the restore script" as though one existed. A nightly archive nobody
// has ever read back is not a backup; it is a habit. So helpers/restore.js is
// new, and this file is the drill.
//
// ── IT USES THE REAL BACKUP CODE ─────────────────────────────────────────
// buildArchive() from helpers/backup.js, against a data directory this file
// builds — not a hand-written archive literal. A drill against a fixture that
// I wrote to match my own restore code proves the two agree with each other
// and nothing about the thing that runs at night. The archive here is
// produced by exactly the function the scheduler calls.
//
// Drive is never touched: buildArchive only reads the disk. runBackup is the
// function that uploads, and it is not called here.
//
// ── AND IT MEASURES ──────────────────────────────────────────────────────
// The question "can we restore" has a second half: how long, and what is
// still missing afterwards. Section G prints both, because a drill whose
// answer is "yes" and nothing else has not told the operator what their
// morning looks like.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-restore-drill-'));
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.JARVIS_TEST = '1';
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against real data');
    process.exit(1);
}

const backup = require(path.join(ROOT, 'helpers/backup'));
const restore = require(path.join(ROOT, 'helpers/restore'));

const LIVE = cfg.DATA_DIR;
const w = (rel, obj) => {
    const abs = path.join(LIVE, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(obj, null, 2) + '\n');
};

// ── A DATA DIRECTORY SHAPED LIKE THE REAL ONE ────────────────────────────
// Every CRITICAL store by its real configured name, so the critical-store
// accounting is exercised rather than assumed; a SUBDIRECTORY, because
// collectStores walks recursively and a restore that forgets to recreate
// directories fails on exactly the stores filed under one; a SECRET and a
// BANK file, which must not come back; a SKIP_DIR and a non-JSON file, which
// must not either.
const CRITICAL = backup.CRITICAL;
let i = 0;
for (const name of CRITICAL) w(name, [{ id: `C${i += 1}`, amount: 100 * i, note: name }]);

w('settings.json', { manager_name: 'Manager', gemini_model: 'gemini-2.5-flash-lite' });
w('nested/deep/thing.json', { deep: true, rows: [1, 2, 3] });
w('unicode.json', { supplier: 'Carlos G & C', note: 'tonnes — 21 MT, café' });
w('big.json', Array.from({ length: 500 }, (_, n) => ({ n, container: `MSKU${1000000 + n}` })));

// Must NOT be restored.
w('bank-item.json', { access_token: 'THIS-MUST-NEVER-LEAVE-THE-VM' });
w('bank-transactions.json', [{ amount: 1, desc: 'private' }]);
fs.writeFileSync(path.join(LIVE, 'drive-token.json'), JSON.stringify({ refresh_token: 'secret' }));
fs.mkdirSync(path.join(LIVE, 'logs'), { recursive: true });
fs.writeFileSync(path.join(LIVE, 'logs', 'app.json'), JSON.stringify([{ line: 'noisy' }]));
fs.mkdirSync(path.join(LIVE, 'documents_saved'), { recursive: true });
fs.writeFileSync(path.join(LIVE, 'documents_saved', 'inv.json'), JSON.stringify({ n: 1 }));
// ── THE WHATSAPP SESSION, WHICH IS 141 MB OF THE 149 ON HER VM ───────────
// Chromium's own manifests, nested four deep. Not credentials — the real
// session is LevelDB and sqlite, which this walker never takes because it
// only collects .json. Excluded because a RESTORE would otherwise re-create
// .wwebjs_auth/session/ holding manifests and nothing else: a half-populated
// profile that fails obscurely, where an absent one cleanly asks for a QR.
fs.mkdirSync(path.join(LIVE, '.wwebjs_auth', 'session', 'component_crx_cache'), { recursive: true });
fs.writeFileSync(path.join(LIVE, '.wwebjs_auth', 'session', 'component_crx_cache', 'metadata.json'),
    JSON.stringify({ chromium: 'internal' }));
fs.writeFileSync(path.join(LIVE, 'notes.txt'), 'not json');
fs.writeFileSync(path.join(LIVE, 'loads.json.lock'), '');

(async () => {

// ── A — THE ARCHIVE, FROM THE CODE THAT RUNS AT NIGHT ─────────────────────
let archive = null;
{
    section('A — the nightly archive');

    archive = backup.buildArchive(new Date('2026-10-03T12:00:00Z'));

    ck('it is a Jarvis backup', archive._meta.kind === 'jarvis-data-backup'
        && archive._meta.version === 1, JSON.stringify(archive._meta.kind));
    ck('  every critical store is in it',
       CRITICAL.every((c) => Object.prototype.hasOwnProperty.call(archive.stores, c)),
       CRITICAL.filter((c) => !archive.stores[c]).join(', '));
    ck('  nothing was unreadable', (archive._meta.problems || []).length === 0,
       JSON.stringify(archive._meta.problems));

    // The exclusions, asserted on the ARCHIVE rather than trusted. If a bank
    // token is in here, it is already on a shared Drive folder.
    for (const secret of ['bank-item.json', 'bank-transactions.json', 'drive-token.json']) {
        ck(`  ${secret} is NOT in the archive`,
           !Object.prototype.hasOwnProperty.call(archive.stores, secret),
           'this archive goes to a shared Drive folder');
    }
    ck('  skipped directories are not in it',
       !Object.keys(archive.stores).some((k) => k.startsWith('logs/') || k.startsWith('documents_saved/')),
       Object.keys(archive.stores).filter((k) => k.includes('/')).join(', '));
    ck('  and neither is the WhatsApp Chromium profile',
       !Object.keys(archive.stores).some((k) => k.startsWith('.wwebjs_auth/')),
       Object.keys(archive.stores).filter((k) => k.startsWith('.wwebjs_auth')).join(', '));
    ck('  but a real subdirectory IS',
       Object.prototype.hasOwnProperty.call(archive.stores, 'nested/deep/thing.json'));
}

// ── B — VALIDATION REFUSES WHAT IT SHOULD ─────────────────────────────────
// Before any restore runs, because the operator reading this is frightened
// and in a hurry and the archive came off the internet.
{
    section('B — what validation refuses');

    const good = restore.validateArchive(archive);
    ck('the real archive validates', good.ok, JSON.stringify(good.errors));
    ck('  and counts its stores', good.storeCount === Object.keys(archive.stores).length,
       `${good.storeCount}`);

    const cases = [
        ['not an object', 'a string', /not a JSON object/],
        ['no _meta', { stores: { 'a.json': [] } }, /not a Jarvis backup/],
        ['wrong kind', { _meta: { kind: 'something-else', version: 1 }, stores: { 'a.json': [] } }, /kind/],
        ['a version this code does not know',
         { _meta: { kind: 'jarvis-data-backup', version: 99 }, stores: { 'a.json': [] } }, /version/],
        ['no stores', { _meta: { kind: 'jarvis-data-backup', version: 1 } }, /nothing to restore/],
        ['empty stores', { _meta: { kind: 'jarvis-data-backup', version: 1 }, stores: {} }, /empty/],
    ];
    for (const [label, input, re] of cases) {
        const v = restore.validateArchive(input);
        ck(`  refuses ${label}`, !v.ok && v.errors.some((e) => re.test(e)),
           JSON.stringify(v.errors));
    }

    // ── THE ONE THAT MATTERS MOST ────────────────────────────────────────
    // The store names are relative paths out of a file that has been to a
    // shared Drive folder and back. Written as given, these land outside the
    // target directory.
    for (const evil of ['../../.ssh/authorized_keys', '/etc/passwd', 'a/../../b.json',
                        './x.json', 'C:/windows/x.json']) {
        ck(`  refuses the store name ${JSON.stringify(evil)}`,
           restore.safeRel(evil) === null, String(restore.safeRel(evil)));
        const v = restore.validateArchive({
            _meta: { kind: 'jarvis-data-backup', version: 1 }, stores: { [evil]: [] },
        });
        ck(`    and will not restore an archive containing it`, !v.ok,
           JSON.stringify(v.errors));
    }
    ck('  while an ordinary nested name is fine',
       restore.safeRel('nested/deep/thing.json') === 'nested/deep/thing.json');

    // An archive that recorded problems the night it was taken restores, but
    // says so — the store it could not read is the one that will be missing.
    const noisy = restore.validateArchive({
        _meta: { kind: 'jarvis-data-backup', version: 1, problems: [{ path: 'loads.json', error: 'EACCES' }] },
        stores: { 'a.json': [] },
    });
    ck('  warns (not refuses) about stores unreadable at backup time',
       noisy.ok && noisy.warnings.some((x) => /unreadable/.test(x)),
       JSON.stringify(noisy.warnings));
}

// ── C — THE PLAN CHANGES NOTHING ──────────────────────────────────────────
{
    section('C — dry run');

    const fresh = path.join(TMP, 'restore-dryrun');
    const plan = restore.planRestore(archive, fresh);

    ck('the plan lists every store', plan.writes.length === Object.keys(archive.stores).length,
       `${plan.writes.length}`);
    ck('  and the directories they need',
       plan.dirs.includes('nested/deep'), JSON.stringify(plan.dirs));
    ck('  with a byte total', plan.totalBytes > 0, String(plan.totalBytes));
    ck('  it names what the archive cannot give back',
       plan.notInArchive.length >= 4
       && plan.notInArchive.some(([k]) => /bank/i.test(k))
       && plan.notInArchive.some(([k]) => /\.env/.test(k)),
       plan.notInArchive.map(([k]) => k).join(' | '));
    ck('  and it WROTE NOTHING', !fs.existsSync(fresh),
       'a dry run that creates the directory is not a dry run');
}

// ── D — THE RESTORE ITSELF, ONTO A FRESH BOX ──────────────────────────────
let result = null;
{
    section('D — restore onto an empty directory');

    const fresh = path.join(TMP, 'restore-fresh');
    result = restore.applyRestore(archive, fresh);

    ck('it reports what it wrote', result.storesWritten === Object.keys(archive.stores).length,
       `${result.storesWritten}`);
    ck('  and moved nothing aside', result.movedAsideTo === null, String(result.movedAsideTo));

    // ── THE ACTUAL QUESTION ──────────────────────────────────────────────
    // Read back off disk and compared to the archive, store by store. Not
    // "applyRestore returned" — that is a different claim.
    const v = restore.verifyRestore(archive, fresh);
    ck('EVERY store reads back identical to the archive', v.ok,
       JSON.stringify(v.problems.slice(0, 4)));
    ck(`  ${v.checked} stores verified`, v.checked === Object.keys(archive.stores).length,
       `${v.checked}`);

    // Spot checks that do not depend on verifyRestore being right.
    const loads = JSON.parse(fs.readFileSync(path.join(fresh, CRITICAL[0]), 'utf8'));
    ck(`  ${CRITICAL[0]} has its rows`, Array.isArray(loads) && loads.length === 1 && loads[0].amount === 100,
       JSON.stringify(loads));
    ck('  the subdirectory was recreated',
       fs.existsSync(path.join(fresh, 'nested/deep/thing.json')));
    const uni = JSON.parse(fs.readFileSync(path.join(fresh, 'unicode.json'), 'utf8'));
    ck('  and non-ASCII survived the round trip',
       uni.supplier === 'Carlos G & C' && /café/.test(uni.note), JSON.stringify(uni));
    const big = JSON.parse(fs.readFileSync(path.join(fresh, 'big.json'), 'utf8'));
    ck('  a 500-row store is whole', big.length === 500 && big[499].container === 'MSKU1000499',
       `${big.length}`);

    // And the exclusions are still excluded after a restore, which is the
    // half that would quietly re-create a bank token on a new box.
    for (const secret of ['bank-item.json', 'bank-transactions.json', 'drive-token.json']) {
        ck(`  ${secret} did NOT come back`, !fs.existsSync(path.join(fresh, secret)));
    }
    ck('  and neither did logs/ or documents_saved/',
       !fs.existsSync(path.join(fresh, 'logs')) && !fs.existsSync(path.join(fresh, 'documents_saved')));
    ck('  and no half-populated WhatsApp profile was created',
       !fs.existsSync(path.join(fresh, '.wwebjs_auth')),
       'an absent session asks for a QR; a partial one fails obscurely');
    ck('  nor the non-JSON strays', !fs.existsSync(path.join(fresh, 'notes.txt')));

    // ── THE FORMAT MATCHES WHAT helpers/json.js WRITES ───────────────────
    // Because the first thing anyone does after a restore is diff the result
    // against something, and a whole-directory false positive wastes the one
    // hour nobody has.
    const raw = fs.readFileSync(path.join(fresh, 'settings.json'), 'utf8');
    ck('  stores are written 2-space, newline-terminated, as json.js does',
       raw === JSON.stringify(archive.stores['settings.json'], null, 2) + '\n',
       JSON.stringify(raw.slice(0, 40)));
}

// ── E — IT WILL NOT QUIETLY EAT A LIVE DIRECTORY ──────────────────────────
{
    section('E — refusing a target that already has data');

    const occupied = path.join(TMP, 'restore-occupied');
    fs.mkdirSync(occupied, { recursive: true });
    fs.writeFileSync(path.join(occupied, 'loads.json'), JSON.stringify([{ id: 'PRECIOUS' }]));

    let err = null;
    try { restore.applyRestore(archive, occupied); } catch (e) { err = e; }
    ck('it refuses by default', !!err && /already holds/.test(err.message), err && err.message);
    const still = JSON.parse(fs.readFileSync(path.join(occupied, 'loads.json'), 'utf8'));
    ck('  and the existing data is untouched', still[0].id === 'PRECIOUS', JSON.stringify(still));
    ck('  the refusal says how to proceed on purpose',
       !!err && /replace/.test(err.message), err && err.message);

    // onto:'replace' — moves aside, never deletes.
    const r2 = restore.applyRestore(archive, occupied, { onto: 'replace' });
    ck('onto:replace restores', r2.storesWritten > 0 && restore.verifyRestore(archive, occupied).ok);
    ck('  and KEPT the old directory', !!r2.movedAsideTo && fs.existsSync(r2.movedAsideTo),
       String(r2.movedAsideTo));
    const kept = JSON.parse(fs.readFileSync(path.join(r2.movedAsideTo, 'loads.json'), 'utf8'));
    ck('  with the old data intact inside it', kept[0].id === 'PRECIOUS', JSON.stringify(kept));
}

// ── F — ALL OR NOTHING ────────────────────────────────────────────────────
// The state that must not exist is "some stores restored". A half-restored
// ledger reads plausibly and does not balance, and nobody can tell which half
// is which.
{
    section('F — a failure part-way leaves nothing behind');

    const target = path.join(TMP, 'restore-atomic');

    // A value JSON.stringify throws on, placed in the middle of the set, so
    // the write loop fails after some stores have been staged.
    const circular = { name: 'bad' };
    circular.self = circular;
    const broken = {
        _meta: { kind: 'jarvis-data-backup', version: 1, taken_at: new Date().toISOString() },
        stores: { 'aaa.json': [{ ok: 1 }], 'mmm.json': circular, 'zzz.json': [{ ok: 2 }] },
    };

    // ── REFUSED BEFORE ANYTHING IS STAGED, NOT FAILED PART-WAY ───────────
    // My first version of this check expected applyRestore's "nothing was
    // moved into place" message, i.e. it expected the write loop to get
    // half-way and unwind. It did not — because planRestore called
    // serialise() to compute byte counts and threw first, so the DRY RUN
    // crashed too, with 'Converting circular structure to JSON' and no store
    // name. That is worse than the failure I was testing for: an operator
    // reading it cannot tell whether the directory was touched.
    //
    // Refusing up front is the better behaviour, so the code changed and this
    // check now asserts THAT. The property is unchanged: a store that cannot
    // be written means no store is written, and the message names it.
    const dry = restore.planRestore(broken, target);
    ck('the plan refuses it rather than throwing', !dry.ok,
       'a dry run must never crash — it is the thing you run when frightened');
    ck('  naming the store that cannot be written',
       dry.errors.some((e) => /mmm\.json/.test(e) && /cannot be written/.test(e)),
       JSON.stringify(dry.errors));

    let err = null;
    try { restore.applyRestore(broken, target); } catch (e) { err = e; }
    ck('and applyRestore refuses too', !!err && /refusing to restore/.test(err.message),
       err && err.message);
    ck('  naming the store, not a raw serialiser error',
       !!err && /mmm\.json/.test(err.message) && !/^Converting circular/.test(err.message),
       err && err.message);
    ck('  and the target does not exist', !fs.existsSync(target),
       'a partial restore is worse than no restore');

    // And the staging directory is cleaned up rather than left beside it.
    const litter = fs.readdirSync(TMP).filter((e) => e.startsWith('.jarvis-restore-'));
    ck('  no staging directory left behind', litter.length === 0, litter.join(', '));
}

// ── G — THE DRILL REPORT ──────────────────────────────────────────────────
// What an operator wants at 3am: how long, how much, and what is still to do
// by hand. Printed, and the timing is NOT asserted — a wall-clock threshold
// in a test is a test that fails on a busy machine and teaches people to
// ignore it.
{
    section('G — the drill, measured');

    const target = path.join(TMP, 'restore-timed');
    const t0 = Date.now();
    const r = restore.applyRestore(archive, target);
    const v = restore.verifyRestore(archive, target);
    const total = Date.now() - t0;

    ck('restore + verify both clean', r.storesWritten > 0 && v.ok,
       JSON.stringify(v.problems.slice(0, 3)));

    console.log('');
    console.log(`    archive taken   ${archive._meta.taken_at}`);
    console.log(`    stores          ${r.storesWritten}`);
    console.log(`    bytes           ${r.bytes.toLocaleString('en-US')}`);
    console.log(`    write           ${r.ms} ms`);
    console.log(`    write + verify  ${total} ms  (${v.checked} stores read back and compared)`);
    console.log('');
    console.log('    STILL TO DO BY HAND — none of this is in the archive:');
    for (const [what, why] of r.notInArchive) {
        console.log(`      · ${what}`);
        console.log(`        ${why}`);
    }
    console.log('');

    // The scaling claim, so "it took 40ms on a fixture" is not mistaken for
    // "it will take 40ms on her 149 MB". Reported as a rate, not a promise.
    const perMb = r.bytes ? (r.ms / (r.bytes / 1048576)) : 0;
    if (perMb > 0) {
        console.log(`    ~${perMb.toFixed(0)} ms per MB written here. Her live data directory is`);
        console.log('    about 149 MB, of which the archive carries the JSON stores only.');
        console.log('    Run scripts/restore-from-backup.js on the VM for the real figure.');
        console.log('');
    }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
