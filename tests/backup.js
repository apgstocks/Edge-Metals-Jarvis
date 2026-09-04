// ── tests/backup.js ───────────────────────────────────────────────────────
// Apsara, 2026-09-02: "What if some day this app goes down?"
//
// The audit behind this: everything that already reached Drive was a DERIVED
// report. payments.json and petty_cash.json — who was paid what, and the cash
// ledger — lived in one file on one machine, and cannot be rebuilt from a
// spreadsheet of weights.
//
// The assertion that matters most in this file is the one about CREDENTIALS.
// This code reads the whole data directory and uploads it to a shared Drive.
// If it ever swept up gdrive-sa.json or a Gmail token, one shared folder link
// would hand over both the data and the keys to the mailbox it came from. That
// is a worse outcome than the data loss this exists to prevent, so it is
// tested from several directions rather than trusted to a comment.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-backup-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config is not isolated'); process.exit(1); }

const backup = require(path.join(ROOT, 'helpers/backup'));

const write = (rel, obj) => {
    const abs = path.join(TMP, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof obj === 'string' ? obj : JSON.stringify(obj));
};

// A data directory shaped like the real one, secrets and all.
write('payments.json', [{ id: 'PAY_1', load_id: 'EDGE_01', amount: 400, mode: 'Cash' }]);
write('petty_cash.json', [{ id: 'PC_1', kind: 'topup', amount: 1000 }]);
write('loads.json', [{ id: 'EDGE_01', seller: 'Acme' }]);
write('outbound_loads.json', []);
write('expenses.json', [{ id: 'EXP_1', amount: 50 }]);
write('settings.json', { manager_number: '911234567890' });
write('memory/facts.json', [{ id: 'F1', text: 'a fact' }]);
// ── the things that must NOT travel ───────────────────────────────────────
write('gdrive-sa.json', { private_key: '-----BEGIN PRIVATE KEY-----AAAA' });
write('gmail-token.json', { refresh_token: 'SECRET-REFRESH' });
write('gmail-credentials.json', { client_secret: 'SECRET-CLIENT' });
write('gmail-token-read.json', { refresh_token: 'SECRET-READ' });
// ── bank data, excluded before the first real row could exist ─────────────
// Apsara 2026-09-03, asked where bank data should sit in this archive:
// "exclude bank data from the backup." This goes to a SHARED Drive folder.
//
// bank-item.json is the dangerous one. It holds the Plaid access token, which
// is not a copy of the data — it is the standing ability to fetch more of it,
// and it does not expire on its own.
write('bank-item.json', { access_token: 'SECRET-PLAID-ACCESS', item_id: 'itm_1', cursor: 'abc' });
write('bank-transactions.json', [{ transaction_id: 'tx_1', amount: 1200, name: 'SECRET-BANK-PAYEE' }]);
// ── noise ─────────────────────────────────────────────────────────────────
write('brain.json.lock', 'lock');
write('manager_outbox.json.bak-20260901', '{}');
write('voice-cache/a.json', { cached: true });
write('logs/x.json', { log: true });
write('broken.json', '{ this is not json');

section('A — everything that matters is in the archive');
{
    const { stores, problems } = backup.collectStores();
    for (const f of ['payments.json', 'petty_cash.json', 'loads.json', 'outbound_loads.json', 'expenses.json', 'settings.json']) {
        ck(`${f} is backed up`, Object.prototype.hasOwnProperty.call(stores, f));
    }
    ck('nested stores are included', !!stores['memory/facts.json'],
       'memory/ is a directory, and a walker that only reads the top level would miss it');
    ck('the contents are the real contents', stores['payments.json'][0].amount === 400);
    ck('an unreadable store is REPORTED, not silently skipped',
       problems.some(p => p.path === 'broken.json'),
       'a backup that quietly omits a corrupted file tells you everything is fine on the night it is not');
}

section('B — credentials never leave the machine');
{
    const { stores } = backup.collectStores();
    for (const f of ['gdrive-sa.json', 'gmail-token.json', 'gmail-credentials.json', 'gmail-token-read.json']) {
        ck(`${f} is EXCLUDED`, !Object.prototype.hasOwnProperty.call(stores, f),
           'this file is uploaded to a shared Drive — a key in it is a key one share link away from anyone');
    }

    // The strongest form of the check: serialise the whole archive and grep it
    // for the secret VALUES. A filename filter that someone later loosens
    // would still pass a key-by-key test; it cannot pass this one.
    const blob = JSON.stringify(backup.buildArchive());
    for (const secret of ['BEGIN PRIVATE KEY', 'SECRET-REFRESH', 'SECRET-CLIENT', 'SECRET-READ',
                          // Bank data, added 2026-09-03. The access token
                          // first: it is worth more than the statement, since
                          // it fetches every future one too.
                          'SECRET-PLAID-ACCESS', 'SECRET-BANK-PAYEE']) {
        ck(`  no trace of ${secret.slice(0, 18)} anywhere in the archive`, !blob.includes(secret));
    }

    // And the matcher itself, against names it has not seen.
    ck('the filter catches an unfamiliar token file', backup.isSecret('gmail-token-sender-read.json'));
    ck('  a stray credentials file', backup.isSecret('some-credentials.json'));
    ck('  a private key', backup.isSecret('server.key') && backup.isSecret('cert.pem'));
    ck('  the release keystore', backup.isSecret('edge-yard-release.jks'));
    ck('  but not an ordinary store', !backup.isSecret('payments.json') && !backup.isSecret('loads.json'));

    // ── bank data ─────────────────────────────────────────────────────────
    // Asserted through the REAL collector, not just the matcher, because the
    // question is whether these files reach the archive — not whether a regex
    // in isolation says they should not.
    for (const f of ['bank-item.json', 'bank-transactions.json']) {
        ck(`${f} is EXCLUDED`, !Object.prototype.hasOwnProperty.call(stores, f),
           'a bank statement in a shared Drive folder is one share link away from everyone');
    }
    ck('the matcher catches a bank file it has not seen', backup.isSecret('bank-accounts.json'),
       'the next bank file must be excluded by the rule, not by someone remembering');
    ck('  and the item file however it is cased', backup.isSecret('BANK-ITEM.JSON'));
    // Narrow enough not to swallow ordinary stores. "bank" as a whole word at
    // the start is the rule; a file that merely CONTAINS the letters is not a
    // bank file, and excluding those would silently stop backing them up.
    ck('  but not a store that merely contains the word',
       !backup.isSecret('embankment.json') && !backup.isSecret('loads-bank.json'),
       'over-matching here would quietly drop real stores out of the backup');
}

section('C — noise stays out');
{
    const { stores } = backup.collectStores();
    ck('lock files are skipped', !stores['brain.json.lock']);
    ck('.bak files are skipped', !Object.keys(stores).some(k => k.includes('.bak-')));
    ck('the voice cache is skipped', !Object.keys(stores).some(k => k.startsWith('voice-cache/')),
       'it regenerates, and it is audio');
    ck('logs are skipped', !Object.keys(stores).some(k => k.startsWith('logs/')));
}

section('D — the archive says what it is and what is missing');
{
    const a = backup.buildArchive(new Date('2026-09-02T09:00:00Z'));
    ck('it identifies itself', a._meta.kind === 'jarvis-data-backup' && a._meta.version === 1);
    ck('it is dated in the yard\'s day, not UTC',
       a._meta.date === require(path.join(ROOT, 'helpers/time')).todayLocal(new Date('2026-09-02T09:00:00Z')));
    ck('it counts what it holds', a._meta.store_count === Object.keys(a.stores).length);
    ck('it names the critical stores it DOES have',
       a._meta.critical_present.includes('payments.json') && a._meta.critical_present.includes('petty_cash.json'),
       '"is payments in here?" should not require reading the whole file');
    ck('it lists none missing when none are', a._meta.critical_missing.length === 0);
    ck('it carries the unreadable ones', a._meta.problems.some(p => p.path === 'broken.json'));

    // Remove a critical store and confirm the archive SAYS SO rather than
    // quietly being smaller. A backup missing the payment ledger that looks
    // identical to one containing it is the worst possible artefact.
    fs.unlinkSync(path.join(TMP, 'payments.json'));
    const b = backup.buildArchive();
    ck('a missing critical store is called out by name',
       b._meta.critical_missing.includes('payments.json'),
       'silence here would mean discovering it during a restore');
    write('payments.json', [{ id: 'PAY_1', load_id: 'EDGE_01', amount: 400, mode: 'Cash' }]);
}

section('E — an archive can actually be restored from');
{
    // The point of a backup is the restore. This does not test the upload — it
    // tests that what gets uploaded is sufficient and correctly shaped to put
    // every file back where it came from.
    const a = backup.buildArchive();
    const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-restore-'));
    for (const [rel, data] of Object.entries(a.stores)) {
        const abs = path.join(OUT, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, JSON.stringify(data, null, 2));
    }
    ck('every store round-trips to disk', fs.existsSync(path.join(OUT, 'payments.json')));
    ck('  nested paths are recreated', fs.existsSync(path.join(OUT, 'memory/facts.json')));
    const back = JSON.parse(fs.readFileSync(path.join(OUT, 'payments.json'), 'utf8'));
    ck('  and the data is identical', back[0].id === 'PAY_1' && back[0].amount === 400);
    ck('  the restored tree contains no credentials',
       !fs.existsSync(path.join(OUT, 'gdrive-sa.json')),
       'a restore re-issues keys from the Google console — see the note in _meta');
    fs.rmSync(OUT, { recursive: true, force: true });
}

section('F — the schedule and the Drive side');
{
    const sched = fs.readFileSync(path.join(ROOT, 'scheduler.js'), 'utf8');
    ck('a nightly job is registered', /require\('\.\/helpers\/backup'\)\.runBackup\(\)/.test(sched));
    // Compared as CLOCK TIMES, not as positions in the file. The first version
    // of this assertion checked that the backup's cron.schedule call appeared
    // earlier in scheduler.js than the fact replica's — which is meaningless:
    // cron fires on the clock, not in registration order. It failed against
    // correct code and the TEST was the thing that was wrong.
    const minutesOf = (expr) => {
        const m = new RegExp(`cron\\.schedule\\('${expr.replace(/\*/g, '\\*')}'`).test(sched);
        if (!m) return null;
        const [min, hr] = expr.split(' ');
        return Number(hr) * 60 + Number(min);
    };
    const backupAt = minutesOf('0 2 * * *');
    const replicaAt = minutesOf('30 3 * * *');
    const reviewAt = minutesOf('45 23 * * *');     // learning review
    ck('  it runs at 02:00', backupAt === 120);
    // The window is what matters, and it wraps midnight: everything else at
    // night runs at 23:00/23:45 (before midnight) or 03:30 (after the backup).
    // So "quiet" means strictly after midnight and strictly before the fact
    // replica. Stated as two facts rather than one clever comparison — the
    // first attempt at this line was an unreadable chain that evaluated to
    // nonsense and failed against correct code.
    ck('  after midnight, so the 23:00 archive and 23:45 review have finished',
       reviewAt === 1425 && backupAt > 0 && backupAt < 6 * 60);
    ck('  and before the 03:30 fact replica', replicaAt === 210 && backupAt < replicaAt,
       'the archive must not be taken while another job is mid-write');
    ck('  a failure is logged loudly rather than swallowed',
       /nightly data backup FAILED/.test(sched));

    const drive = fs.readFileSync(path.join(ROOT, 'helpers/drive.js'), 'utf8');
    ck('backups go to their OWN folder, not Reports',
       /name = 'Backups'/.test(drive),
       'Reports is a folder people share; raw stores must not ride along with it');
    ck('old archives are TRASHED, not hard-deleted', /requestBody: \{ trashed: true \}/.test(drive),
       'a backup routine that hard-deletes is one bad sort away from deleting the wrong thing');
    ck('retention sorts by NAME, which is the date', /orderBy: 'name desc'/.test(drive),
       'sorting by modifiedTime would let a re-uploaded old archive push out a recent one');
    ck('each night is its own dated file', /jarvis-data-/.test(fs.readFileSync(path.join(ROOT, 'helpers/backup.js'), 'utf8')),
       'one rolling file is corrupt the night after a bad write corrupts a store');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
