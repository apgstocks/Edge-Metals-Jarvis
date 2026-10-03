// ── tests/backup-watch.js ─────────────────────────────────────────────────
// Apsara, 2026-10-02: "Protect the data of edge yard no matter what."
//
// Three holes were open when she said that, and every one of them is the same
// shape: the system looked protected and was not.
//
//   1. The nightly backup's only failure path was console.error. A Drive
//      token expires, backups stop, NOBODY IS TOLD, and she goes on
//      believing she has thirty dated copies of payments.json.
//   2. CRITICAL named five stores. bill_payments.json (every supplier
//      advance), sales_receipts.json (money in), trucker_bills.json and
//      yard_claims.json were not among them — and critical_missing is the
//      ONLY mechanism that notices a store has vanished.
//   3. There was no restore. The only one in the codebase was six lines of
//      fs.writeFileSync inside tests/backup.js, which proves the archive is
//      sufficient and leaves nobody a tool.
//
// So the checks here are mostly about the alarm, not the copy. The copy has
// worked since September; it was the knowing-when-it-stops that was missing.

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');

process.env.JARVIS_TEST = '1';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-bwatch-'));
process.env.DATA_DIR = TMP;

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

(async () => {

const cfg = require('../config');
const watch = require('../helpers/backupWatch');
const backup = require('../helpers/backup');

const clearLog = () => { try { fs.unlinkSync(watch.LOG_FILE()); } catch {} };
const DAY = 86400000;
const okRun = (over = {}) => ({ meta: { store_count: 12, critical_missing: [], problems: [] },
                                name: 'jarvis-data-x.json', bytes: 2048, ...over });

// ── A — WHAT MUST BE IN THE ARCHIVE AT ALL ────────────────────────────────
{
    section('A — CRITICAL covers the yard\'s money');

    // Every one of these was absent from CRITICAL before today, and
    // critical_missing is the only thing that notices a vanished store.
    for (const f of ['payments.json', 'petty_cash.json', 'loads.json', 'outbound_loads.json',
                     'expenses.json', 'bill_payments.json', 'sales_receipts.json',
                     'trucker_bills.json', 'yard_claims.json', 'load_drafts.json',
                     'item_types.json', 'item_aliases.json']) {
        ck(`${f} is treated as critical`, backup.CRITICAL.includes(f), backup.CRITICAL.join(', '));
    }

    // ── DERIVED FROM CONFIG, NOT FROM GUESSED FILENAMES ──────────────────
    // The first version of this widening wrote the names as literals and two
    // of them did not exist. A guessed name HERE is the worst place for one:
    // it would sit in critical_missing every night, so the alarm that means
    // "a store has vanished" would cry wolf until it was ignored — and a
    // store that really vanished would be lost in the noise.
    const src = fs.readFileSync(path.join(ROOT, 'helpers/backup.js'), 'utf8');
    ck('the list is built from config keys, not hardcoded filenames',
       /CRITICAL_KEYS/.test(src) && /path\.basename\(v\)/.test(src),
       'a renamed store must move with its config entry');
    for (const name of backup.CRITICAL) {
        const key = Object.keys(cfg).find((k) => typeof cfg[k] === 'string' && path.basename(cfg[k]) === name);
        ck(`  ${name} resolves from a real config entry`, !!key, 'not reachable from config — so it was guessed');
    }
}

// ── B — THE HEALTH READ ───────────────────────────────────────────────────
{
    section('B — is the backup still happening?');

    clearLog();
    const fresh = watch.health();
    ck('no history is NOT reported as a problem',
       fresh.known === false && fresh.problems.length === 0,
       'a fresh install is not evidence of a broken backup, and an alarm that '
       + 'cries wolf on day one is an alarm that gets muted');

    const now = Date.parse('2026-10-02T09:00:00Z');
    await watch.record({ at: new Date(now - 1 * DAY), ok: true, criticalMissing: [] });
    const good = watch.health({ now });
    ck('a backup from last night is fine',
       good.problems.length === 0 && good.failingFor === 0, JSON.stringify(good.problems));

    clearLog();
    await watch.record({ at: new Date(now - 5 * DAY), ok: true, criticalMissing: [] });
    const stale = watch.health({ now });
    ck('five days with no copy is stale, and says how many',
       stale.problems.some((p) => /^backup_stale_5d$/.test(p)), JSON.stringify(stale.problems));

    clearLog();
    await watch.record({ at: new Date(now - 4 * DAY), ok: true, criticalMissing: [] });
    for (const d of [3, 2, 1]) await watch.record({ at: new Date(now - d * DAY), ok: false, error: '401' });
    const failing = watch.health({ now });
    ck('a run of failures is counted, not just noticed',
       failing.failingFor === 3 && failing.problems.some((p) => p === 'backup_failing_3'),
       JSON.stringify(failing));
    ck('  and the last GOOD copy is named',
       String(failing.last).startsWith('2026-09-28'),
       '"it has failed three nights and the last good copy is from the 28th" is a '
       + 'different sentence from "it failed" — ' + failing.last);

    // criticalVanished, not criticalMissing — the latter includes stores that
    // have never existed, which is not a problem and is the false alarm this
    // split exists to kill.
    clearLog();
    await watch.record({ at: new Date(now - 1 * DAY), ok: true,
                         criticalMissing: ['payments.json'], criticalVanished: ['payments.json'] });
    const incomplete = watch.health({ now });
    ck('a backup that RAN but lost a critical store is a problem',
       incomplete.problems.includes('backup_store_vanished'),
       'it will not restore the thing it exists for — ' + JSON.stringify(incomplete.problems));

    // NEVER THROWS: /healthz calls this, and a health endpoint that 500s is
    // one nobody can rely on.
    fs.writeFileSync(watch.LOG_FILE(), '{{{ not json');
    const broken = watch.health({ now });
    ck('an unreadable log is a problem, not an exception',
       Array.isArray(broken.problems) && broken.problems.length > 0,
       'a receipt we cannot read is not proof of anything');
    clearLog();
}

// ── C — IT SPEAKS UP ──────────────────────────────────────────────────────
{
    section('C — the alarm');

    cfg.BACKUP_ALERT_EMAILS = 'apsara@example.com';
    const TUE = new Date('2026-09-29T02:00:00Z');   // not Monday
    const MON = new Date('2026-09-28T02:00:00Z');   // Monday

    clearLog();
    let mail = null;
    const send = async (o) => { mail = o; };

    await watch.nightly({ runBackup: async () => { throw new Error('invalid_grant: token revoked'); },
                          send, now: TUE });
    ck('a FAILED backup emails her',
       !!mail && /BACKUP FAILED/.test(mail.subject),
       'this was console.error and nothing else — ' + JSON.stringify(mail && mail.subject));
    ck('  and the body carries the actual reason',
       /invalid_grant/.test(mail.body), mail.body);
    ck('  and says plainly that nothing was copied',
       /DID NOT HAPPEN|Nothing was copied/.test(mail.body));

    mail = null;
    clearLog();
    await watch.nightly({ runBackup: async () => okRun(), send, now: TUE });
    ck('a clean night on a Tuesday is silent',
       mail === null, 'a daily all-clear is an email that stops being read');

    mail = null;
    clearLog();
    await watch.nightly({ runBackup: async () => okRun(), send, now: MON });
    ck('but Monday gets a heartbeat',
       !!mail && /Backups are fine/.test(mail.subject),
       'silent-when-working AND silent-when-broken conveys nothing; the absence '
       + 'of this line has to be a signal too');
    ck('  and it says so, so she knows what its absence means',
       /If it stops arriving/.test(mail.body), mail.body);

    // ── ABSENT MEANS TWO DIFFERENT THINGS (2026-10-03) ──────────────────
    // This used to alarm on critical_missing, which is just "not in the
    // archive". On a fresh data directory that is ELEVEN stores, and on her
    // live VM it was three — sales_receipts, trucker_bills, yard_claims —
    // none of which had ever been written because those features were unused.
    //
    // I read that warning and told her twice, forcefully, that her Edge Yard
    // data was not being backed up and would not come back. It was a false
    // alarm, and the note above CRITICAL_KEYS had predicted exactly it: the
    // alarm that means "a store has vanished" cries wolf until it is ignored.
    //
    // So: a store that was in a previous archive and is now gone is the
    // alarm. A store never seen is silence.
    mail = null;
    clearLog();
    await watch.nightly({ runBackup: async () => okRun({ meta: { store_count: 11,
        critical_missing: ['yard_claims.json'], critical_vanished: [],
        critical_not_yet_used: ['yard_claims.json'], problems: [] } }), send, now: TUE });
    ck('a store NEVER USED does not email', !mail,
       'this is the false alarm that cost her two warnings about data she had not lost');

    mail = null;
    clearLog();
    await watch.nightly({ runBackup: async () => okRun({ meta: { store_count: 11,
        critical_missing: ['payments.json'], critical_vanished: ['payments.json'],
        critical_not_yet_used: [], problems: [] } }), send, now: TUE });
    ck('a store that VANISHED emails even on a "successful" night',
       !!mail && /GONE/.test(mail.subject), JSON.stringify(mail && mail.subject));
    ck('  and names it', !!mail && /payments\.json/.test(mail.body), mail && mail.body);

    // An archive written BEFORE the split has no criticalVanished field. It
    // must not be read as "everything vanished" — that would re-raise the
    // same false alarm against history that cannot answer back.
    mail = null;
    clearLog();
    await watch.nightly({ runBackup: async () => okRun({ meta: { store_count: 11,
        critical_missing: ['payments.json', 'loads.json'], problems: [] } }), send, now: TUE });
    ck('an OLD archive with no split does not alarm', !mail,
       'pre-split receipts cannot tell the two apart; guessing is how the wolf gets cried');

    mail = null;
    clearLog();
    await watch.nightly({ runBackup: async () => okRun({ meta: { store_count: 11, critical_missing: [],
        problems: [{ path: 'petty_cash.json', error: 'Unexpected token }' }] } }), send, now: TUE });
    ck('a store that would not PARSE emails too',
       !!mail && /petty_cash\.json/.test(mail.body),
       'the live file is damaged and the dated copies only reach back 30 days');
    ck('  and points at the restore tool',
       /restore-backup\.js/.test(mail.body), mail.body);

    // ── THE RECEIPT IS WRITTEN EITHER WAY ────────────────────────────────
    clearLog();
    await watch.nightly({ runBackup: async () => { throw new Error('boom'); }, send, now: TUE });
    const log = watch.readLog();
    ck('a failure is recorded, not only emailed',
       log.length === 1 && log[0].ok === false && /boom/.test(log[0].error),
       'the receipt is what lets the NEXT run say "three nights running" — ' + JSON.stringify(log));

    // ── IT NEVER THROWS AT THE SCHEDULER ─────────────────────────────────
    clearLog();
    let threw = false;
    try {
        await watch.nightly({ runBackup: async () => okRun({ meta: { store_count: 1,
            critical_missing: ['payments.json'], problems: [] } }),
            send: async () => { throw new Error('smtp down'); }, now: TUE });
    } catch { threw = true; }
    ck('a send failure does not throw at the caller',
       !threw, 'the alarm failing must not also take the scheduler down');

    clearLog();
    const noTo = { ...cfg };
    const saved = cfg.BACKUP_ALERT_EMAILS;
    cfg.BACKUP_ALERT_EMAILS = '';
    cfg.ALERT_EMAIL_TO = '';
    const quiet = await watch.nightly({ runBackup: async () => { throw new Error('x'); }, send, now: TUE });
    ck('no recipient configured is reported, not thrown',
       quiet.sent === false && /no recipient/.test(quiet.why || ''), JSON.stringify(quiet.why));
    cfg.BACKUP_ALERT_EMAILS = saved;
    void noTo;
}

// ── D — THE SCHEDULER AND THE PUBLIC ENDPOINT ─────────────────────────────
{
    section('D — wired where it matters');

    const sched = fs.readFileSync(path.join(ROOT, 'scheduler.js'), 'utf8');
    ck('the nightly job goes through the watcher now',
       /require\('\.\/helpers\/backupWatch'\)\.nightly\(\)/.test(sched),
       'bare runBackup() with a console.error catch is the hole this closes');
    ck('  and the bare runBackup call is gone from the schedule',
       !/require\('\.\/helpers\/backup'\)\.runBackup\(\)/.test(sched),
       'two paths means one of them is the one that stays silent');

    // ── /healthz IS THE ONLY THING THAT CATCHES "NOT RUNNING AT ALL" ─────
    // An email cannot report that the process is down: no cron fires, so
    // nothing sends. An external monitor already watches this route for a
    // 503, which is why backups belong on it.
    const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    const healthz = api.slice(api.indexOf("app.get('/healthz'"), api.indexOf("app.get('/healthz'") + 4000);
    ck('healthz reads backup health',
       /backupWatch'\)\.health\(\)/.test(healthz),
       'the one failure an email can never report is the one where nothing runs');
    ck('  behind the boot grace, like the scan check',
       /uptime > HEALTHZ_BOOT_GRACE_S/.test(healthz.slice(healthz.indexOf('backupWatch') - 400)),
       'flapping on every deploy is how an alert gets muted');

    // ── AND IT MUST NOT LEAK ─────────────────────────────────────────────
    // That route is PUBLIC by design — a monitor cannot carry a session
    // cookie. So it may say "stale", and must not say which store is gone.
    ck('healthz does NOT put store names on a public route',
       !/criticalMissing/.test(healthz),
       'health() returns the names for the EMAIL; the public endpoint says '
       + 'backup_stale_4d and nothing more');
}

// ── E — THE RESTORE EXISTS, AND REFUSES TO BE DANGEROUS ───────────────────
{
    section('E — the restore tool');

    const p = path.join(ROOT, 'scripts/restore-backup.js');
    ck('there is a restore script at all',
       fs.existsSync(p),
       'the only restore in this codebase was six lines inside tests/backup.js');
    const src = fs.readFileSync(p, 'utf8');

    ck('it is DRY by default',
       /const WRITE = has\('--write'\)/.test(src) && /if \(!WRITE\)/.test(src),
       'a restore script whose default action overwrites the live ledger is a loaded gun');
    ck('it refuses to guess a date',
       /Which copy\?/.test(src),
       'the newest copy is exactly the wrong one when last night captured the damage');
    ck('it keeps what it replaces',
       /before-restore-/.test(src),
       'a restore of the wrong date has to be undoable too');
    ck('  and the keepsake is not a .json, so the backup cannot sweep it back in',
       /NOT a \.json/.test(src) || /\$\{p\.abs\}\.before-restore-/.test(src));
    ck('it never deletes a store the archive has not heard of',
       /LEFT ALONE/.test(src) && /never deletes/.test(src),
       'yard_claims.json is three days old — an older archive predates it');
    ck('it writes atomically',
       /renameSync/.test(src), 'a half-written money ledger is worse than the damaged one');
    ck('it checks the file is one of ours before touching anything',
       /jarvis-data-backup/.test(src) && /Refusing to touch anything/.test(src));
    ck('it refuses an archive version it does not understand',
       /understands version 1/.test(src), 'guessing at a future shape is how a restore corrupts');
    ck('it warns when the ARCHIVE was already incomplete',
       /ALREADY INCOMPLETE/.test(src),
       'restoring from a copy that was missing payments.json needs saying BEFORE it lands');
    ck('it flags a restore that would LOSE rows',
       /LOSES/.test(src),
       'a backup with fewer rows than the live file is a restore throwing work away');

    // ── AND IT ACTUALLY WORKS ────────────────────────────────────────────
    // Run for real against a built archive, in a throwaway tree. The point of
    // a backup is the restore, and "the script exists" is not that.
    const { execFileSync } = require('child_process');
    const BOX = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-restore-live-'));
    fs.writeFileSync(path.join(BOX, 'payments.json'),
        '[{"id":"PAY_1","amount":400},{"id":"PAY_2","amount":900}]');
    fs.writeFileSync(path.join(BOX, 'loads.json'), '[{"id":"L1"}]');

    const archive = execFileSync(process.execPath, ['-e',
        'const b=require("' + path.join(ROOT, 'helpers/backup.js').replace(/\\/g, '\\\\') + '");'
        + 'process.stdout.write(JSON.stringify(b.buildArchive(new Date("2026-09-28T02:00:00Z"))))'],
        { env: { ...process.env, DATA_DIR: BOX }, encoding: 'utf8' });
    const archivePath = path.join(BOX, 'arch.json');
    fs.writeFileSync(archivePath, archive);

    // Damage it, the way a bad write would.
    fs.writeFileSync(path.join(BOX, 'payments.json'), '[{"id":"PAY_1","amount":400}]');

    const run = (args) => execFileSync(process.execPath, [p, ...args],
        { env: { ...process.env, DATA_DIR: BOX }, encoding: 'utf8' });

    const dry = run(['--file', archivePath, '--date', 'x', '--only', 'payments.json']);
    ck('a dry run changes nothing',
       JSON.parse(fs.readFileSync(path.join(BOX, 'payments.json'), 'utf8')).length === 1,
       'it printed a plan and wrote anyway');
    ck('  and says what it would do',
       /WOULD RESTORE/.test(dry) && /DRY RUN/.test(dry), dry.slice(0, 200));

    run(['--file', archivePath, '--date', 'x', '--only', 'payments.json', '--write']);
    const back = JSON.parse(fs.readFileSync(path.join(BOX, 'payments.json'), 'utf8'));
    ck('--write puts the damaged store back',
       back.length === 2 && back[1].amount === 900, JSON.stringify(back));
    ck('  and keeps the damaged version beside it',
       fs.readdirSync(BOX).some((f) => f.startsWith('payments.json.before-restore-')),
       fs.readdirSync(BOX).join(', '));
    ck('  and leaves the OTHER stores alone',
       JSON.parse(fs.readFileSync(path.join(BOX, 'loads.json'), 'utf8')).length === 1,
       'restoring everything to fix one file rolls back a day of real work elsewhere');

    // A file that is not one of ours must be refused outright.
    fs.writeFileSync(path.join(BOX, 'junk.json'), '{"hello":"world"}');
    let refused = false;
    try { run(['--file', path.join(BOX, 'junk.json'), '--date', 'x', '--write']); }
    catch (e) { refused = /not a Jarvis data backup/.test(String(e.stderr || e.stdout || e.message)); }
    ck('a file that is not a Jarvis archive is refused',
       refused, 'and refused BEFORE anything is written');

    fs.rmSync(BOX, { recursive: true, force: true });
}


// ── F — /healthz FOR REAL, NOT BY GREP ────────────────────────────────────
// A mutation that deleted the push loop — leaving the health() call in place
// — SURVIVED section D, because section D greps api.js for the call. A check
// shaped like the code rather than like the property, exactly as CLAUDE.md
// describes. So this starts the real app and reads the real response.
//
// This is the only failure an email can never report: the process is down or
// the cron never fires, nothing runs, and nothing complains. An external
// monitor watching this route for a 503 is the backstop.
{
    section('F — the public endpoint, over HTTP');

    const http = require('http');
    process.env.API_TOKEN = process.env.API_TOKEN || 'test-token-for-suite';
    delete require.cache[require.resolve(path.join(ROOT, 'api.js'))];
    const { createApi } = require(path.join(ROOT, 'api.js'));
    const srv = http.createServer(createApi()).listen(0);
    await new Promise((r) => srv.once('listening', r));
    const port = srv.address().port;

    const hz = () => new Promise((resolve) => {
        http.get({ host: '127.0.0.1', port, path: '/healthz' }, (res) => {
            let body = ''; res.on('data', (d) => (body += d));
            res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
                                   catch { resolve({ status: res.statusCode, raw: body }); } });
        }).on('error', (e) => resolve({ status: 0, raw: e.message }));
    });

    // Past the boot grace — otherwise the route deliberately stays quiet, and
    // a test that forgot this would be measuring the grace period instead.
    const savedUptime = process.uptime;
    process.uptime = () => 99999;

    clearLog();
    const quiet = await hz();
    ck('no backup history does not make healthz unhealthy',
       !(quiet.json && (quiet.json.problems || []).some((p) => /^backup/.test(p))),
       'a fresh install must not fire the alarm — ' + JSON.stringify(quiet.json && quiet.json.problems));

    // Now a backup that has not run for a week.
    await watch.record({ at: new Date(Date.now() - 7 * DAY), ok: true, criticalMissing: [] });
    const stale = await hz();
    const probs = (stale.json && stale.json.problems) || [];
    ck('a week-old backup shows up on healthz',
       probs.some((p) => /^backup_stale_\d+d$/.test(p)), JSON.stringify(probs));
    ck('  and it answers 503, which is what a monitor can alert on',
       stale.status === 503,
       'a monitor cannot keyword-match a JSON body — it watches the status code');

    // PUBLIC ROUTE: it may say stale, it must not say which store.
    const raw = JSON.stringify(stale.json);
    ck('  and it discloses no store names',
       !/payments\.json|petty_cash|yard_claims|bill_payments/.test(raw), raw);

    // A healthy backup clears it again — the alarm has to be able to stop.
    clearLog();
    await watch.record({ at: new Date(), ok: true, criticalMissing: [] });
    const good = await hz();
    ck('last night\'s backup clears the problem',
       !((good.json && good.json.problems) || []).some((p) => /^backup/.test(p)),
       'an alarm that never clears gets muted — ' + JSON.stringify(good.json && good.json.problems));

    process.uptime = savedUptime;
    srv.close();
    clearLog();
}

// ── G — THE SAFETY NET CANNOT SHRINK QUIETLY ──────────────────────────────
// A mutation that deleted the throw in criticalNames() survived: with every
// key present nothing changes, so the guard was never exercised. It matters
// because a config entry that gets renamed or removed would otherwise make
// CRITICAL quietly SHORTER — and CRITICAL is the only thing that notices a
// store has vanished. A smaller safety net that looks the same size is worse
// than no safety net.
{
    section('G — a vanished config key is loud');

    const saved = cfg.YARD_CLAIMS_FILE;
    delete cfg.YARD_CLAIMS_FILE;
    let threw = null;
    try { backup.criticalNames(); } catch (e) { threw = e.message; }
    cfg.YARD_CLAIMS_FILE = saved;

    ck('a missing config key throws rather than shortening the list',
       !!threw && /YARD_CLAIMS_FILE/.test(threw),
       'otherwise the protected-store list silently shrinks: ' + String(threw));
    ck('  and it is restored for the rest of the run',
       backup.criticalNames().includes('yard_claims.json'));

    // And the list is not trivially satisfiable.
    ck('every key in CRITICAL_KEYS is a real config entry today',
       backup.CRITICAL_KEYS.every((k) => typeof cfg[k] === 'string' && cfg[k]),
       backup.CRITICAL_KEYS.filter((k) => !cfg[k]).join(', '));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\n  THREW:', e.stack || e.message); process.exit(1); });
