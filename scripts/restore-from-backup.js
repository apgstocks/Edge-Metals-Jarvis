#!/usr/bin/env node
// ── scripts/restore-from-backup.js ────────────────────────────────────────
// Rebuild a Jarvis data directory from a nightly backup archive.
//
// Apsara, 2026-10-03, picked this as the first productionisation job: prove
// the data directory can be rebuilt from a Drive archive onto a fresh box,
// and time it. Writing it found that there was no restore code at all —
// helpers/backup.js has uploaded an archive every night for weeks and
// mentions "restore" only in comments, one of them referring to "the restore
// script" as though it existed.
//
// ── IT DOES NOTHING UNLESS YOU SAY --write ───────────────────────────────
//
//   # what is on Drive
//   node scripts/restore-from-backup.js --list
//
//   # read last night's archive and say what a restore WOULD do
//   node scripts/restore-from-backup.js --latest
//
//   # actually write it, into a NEW directory
//   node scripts/restore-from-backup.js --latest --into /opt/jarvis-restore-test --write
//
//   # from a file you already downloaded
//   node scripts/restore-from-backup.js --file ~/jarvis-data-2026-10-02.json
//
// ── IT WILL NOT WRITE INTO THE LIVE DATA DIRECTORY ───────────────────────
// --into is REQUIRED for --write, and pointing it at DATA_DIR is refused
// outright. The drill is: restore somewhere else, look at it, and only then
// decide to swap. A script that can overwrite the live ledgers with one
// mistyped flag is a script that will, on the worst day of the year.
//
// --replace moves an existing target aside (dated, never deleted) rather than
// writing into it.
//
// Drive reads need JARVIS_TEST unset and real credentials — it is listing and
// downloading only, and never writes to Drive.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
const restore = require(path.join(ROOT, 'helpers/restore'));

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1] || null; };

const WRITE = has('--write');
const REPLACE = has('--replace');
const INTO = val('--into');
const FILE = val('--file');
const DATE = val('--date');

const money = (n) => Number(n).toLocaleString('en-US');

function usage(why) {
    if (why) console.error(`\n${why}\n`);
    console.log(fs.readFileSync(__filename, 'utf8')
        .split('\n').filter((l) => l.startsWith('//')).slice(0, 34)
        .map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(why ? 1 : 0);
}

(async () => {

if (has('--help') || (!FILE && !has('--latest') && !has('--list') && !DATE)) {
    usage(argv.length ? null : 'Nothing to do — pass --list, --latest, --date or --file.');
}

// ── WHERE THE ARCHIVE COMES FROM ─────────────────────────────────────────
let archive = null;
let source = null;

if (has('--list') || ((has('--latest') || DATE) && !FILE)) {
    const drive = require(path.join(ROOT, 'helpers/drive'));
    let backups;
    try { backups = await drive.listBackups(); }
    catch (e) {
        console.error(`\nCould not list backups on Drive: ${e.message}`);
        console.error('Run this on the VM, where the Google credentials are, or download the');
        console.error('archive yourself and use --file.\n');
        process.exit(1);
    }
    backups.sort((a, b) => String(b.name).localeCompare(String(a.name)));

    if (has('--list')) {
        console.log(`\n${backups.length} archive(s) on Drive, newest first:\n`);
        for (const b of backups.slice(0, 40)) {
            console.log(`  ${b.name}${b.size ? '  ' + money(b.size) + ' bytes' : ''}`);
        }
        console.log('');
        process.exit(0);
    }

    const wanted = DATE ? backups.find((b) => String(b.name).includes(DATE)) : backups[0];
    if (!wanted) {
        console.error(`\nNo archive${DATE ? ` for ${DATE}` : ''} on Drive. Try --list.\n`);
        process.exit(1);
    }
    source = `Drive: ${wanted.name}`;
    const buf = await drive.downloadBackupJson(wanted.id);
    try { archive = JSON.parse(buf.toString('utf8')); }
    catch (e) { console.error(`\n${wanted.name} is not valid JSON: ${e.message}\n`); process.exit(1); }
} else {
    source = path.resolve(FILE);
    if (!fs.existsSync(source)) { console.error(`\nNo such file: ${source}\n`); process.exit(1); }
    try { archive = JSON.parse(fs.readFileSync(source, 'utf8')); }
    catch (e) { console.error(`\n${source} is not valid JSON: ${e.message}\n`); process.exit(1); }
}

// ── WHERE IT WOULD GO ────────────────────────────────────────────────────
// Defaulted only for the dry run, so a plan can always be printed. --write
// insists on being told, and refuses the live directory whatever it is told.
const target = INTO ? path.resolve(INTO)
    : path.resolve(path.join(path.dirname(cfg.DATA_DIR), 'jarvis-restore-preview'));

if (WRITE) {
    if (!INTO) {
        usage('--write needs --into <dir>. Deliberate: nothing here guesses where to put 53 money stores.');
    }
    // ── THE LIVE DIRECTORY IS NOT A VALID TARGET, EVER ───────────────────
    // Not "are you sure", not --force. The drill is restore-elsewhere-then-
    // look, and the one-keystroke path from a restore drill to overwriting
    // the live ledgers should not exist. Compared by resolved real path, so
    // a symlink or a trailing slash cannot slip past it.
    const real = (p) => { try { return fs.realpathSync(p); } catch (e) { return path.resolve(p); } };
    if (real(INTO) === real(cfg.DATA_DIR)) {
        console.error(`\n  REFUSING: --into is the LIVE data directory (${cfg.DATA_DIR}).`);
        console.error('  Restore somewhere else, check it, then swap it over by hand.\n');
        process.exit(1);
    }
}

const plan = restore.planRestore(archive, target);

console.log(`\nRESTORE PLAN\n`);
console.log(`  from            ${source}`);
if (plan.meta) {
    console.log(`  taken           ${plan.meta.taken_at || '(not recorded)'}`);
    console.log(`  original dir    ${plan.meta.data_dir || '(not recorded)'}`);
}
console.log(`  into            ${target}`);
console.log(`  stores          ${plan.writes.length}`);
console.log(`  bytes           ${money(plan.totalBytes)}`);
if (plan.dirs.length) console.log(`  subdirectories  ${plan.dirs.join(', ')}`);

const st = plan.targetState;
console.log(`  target now      ${!st.exists ? 'does not exist' : st.empty ? 'exists, empty'
    : `exists and holds ${st.entries} entr${st.entries === 1 ? 'y' : 'ies'} (${st.jsonFiles} .json)`}`);

if (plan.errors.length) {
    console.error(`\n  REFUSING — this archive cannot be restored:\n`);
    for (const e of plan.errors) console.error(`    · ${e}`);
    console.error('');
    process.exit(1);
}
if (plan.warnings.length) {
    console.log(`\n  WARNINGS — it will restore, and you should know:\n`);
    for (const x of plan.warnings) console.log(`    · ${x}`);
}

console.log(`\n  NOT IN THE ARCHIVE — still to do by hand afterwards:\n`);
for (const [what, why] of plan.notInArchive) {
    console.log(`    · ${what}`);
    console.log(`      ${why}`);
}

if (!WRITE) {
    console.log(`\n  Dry run. Nothing was written. Add --write --into <dir> to do it.\n`);
    process.exit(0);
}

const started = Date.now();
let result;
try {
    result = restore.applyRestore(archive, target, { onto: REPLACE ? 'replace' : 'empty' });
} catch (e) {
    console.error(`\n  FAILED: ${e.message}\n`);
    process.exit(1);
}

const verify = restore.verifyRestore(archive, target);

console.log(`\n  RESTORED\n`);
console.log(`    stores written  ${result.storesWritten}`);
console.log(`    bytes           ${money(result.bytes)}`);
console.log(`    write           ${result.ms} ms`);
console.log(`    verified        ${verify.checked} store(s) read back and compared to the archive`);
if (result.movedAsideTo) console.log(`    previous target kept at  ${result.movedAsideTo}`);
console.log(`    total           ${Date.now() - started} ms`);

if (!verify.ok) {
    console.error(`\n    VERIFY FAILED on ${verify.problems.length} store(s):`);
    for (const p of verify.problems.slice(0, 10)) console.error(`      · ${p.store} — ${p.error}`);
    console.error('');
    process.exit(1);
}

console.log(`\n  Every store matches the archive. This is a RESTORE PREVIEW, not a cutover:`);
console.log(`  nothing points at ${target} yet. To use it, stop jarvis, move it over`);
console.log(`  ${cfg.DATA_DIR} (keeping the old one), re-create the excluded files above,`);
console.log(`  and start jarvis.\n`);

})().catch((e) => { console.error('\nthrew:', e && e.message, '\n'); process.exit(1); });
