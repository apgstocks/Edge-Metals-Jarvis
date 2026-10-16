// ── tests/drive-guard.js ─────────────────────────────────────────────────
// WAS tests/_guardprobe.js, a nine-line scratch probe that printed "GUARDED:"
// and no totals, so the runner reported it CRASHED on every single run. It
// had been red for long enough to become scenery — which is the real cost:
// a suite with a permanent red is one where a NEW red goes unnoticed.
//
// It is kept rather than deleted, because the thing it pokes at is the most
// expensive guard in this repo. From helpers/drive.js's own comment:
//
//   · 2026-08-29 — a fixture in tests/yard-chat-log.js uploaded a transcript
//     saying "we owe Acme Metals $8,822.00" into Apsara's LIVE business
//     Drive. Not a sandbox. Her actual records.
//   · 2026-10-05 — the JARVIS_TEST flag alone was not enough. Running the
//     suites a different way (`node tests/<file>.js` in a loop, without the
//     env the runner sets) left the guard inert, and the same suite
//     overwrote the live file yard/log/2026-08-29.jsonl with the byte "x".
//
// So the guard has TWO halves and the second one is the one that matters:
// it also trips when the process was STARTED on a file inside tests/, which
// nobody has to remember to arm. The old probe only ever exercised whichever
// half happened to fire first. This asserts both, separately, and proves the
// unflagged half is genuinely doing the work.
//
// SAFE TO RUN. getDrive() throws at its first two lines, before it reads the
// keyfile and long before any network call — so asserting the refusal cannot
// itself reach Drive. That ordering is checked in section C, because if the
// throw ever moved below the client setup this file would become the thing
// that uploads to her Drive.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
process.env.JARVIS_TEST = '1';
const drive = require(path.join(ROOT, 'helpers/drive'));

const refused = async (fn, ...args) => {
    try { await fn(...args); return null; }           // null = IT DID NOT REFUSE
    catch (e) { return String(e && e.message || e); }
};

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — with the flag set, every door into Drive refuses');
{
    // Not one function: the comment says fifteen entry points reach getDrive()
    // transitively, so a sample across read, write and delete is checked.
    // A guard on the read path only would still have let the 2026-08-29
    // upload through.
    const doors = [
        ['findPdfByBooking (read)', () => drive.findPdfByBooking('DALA90721600')],
        ['listAllPdfs (read)', () => drive.listAllPdfs()],
        ['uploadPdfToDrive (write)', () => drive.uploadPdfToDrive('DALA90721600', Buffer.from('x'), 'x.pdf')],
        ['uploadYardChatLog (write)', () => drive.uploadYardChatLog('2026-08-29', 'x')],
        ['uploadBackupJson (write)', () => drive.uploadBackupJson('loads.json', '[]')],
        ['deletePdfByBooking (delete)', () => drive.deletePdfByBooking('DALA90721600')],
    ];
    for (const [name, call] of doors) {
        const msg = await refused(call);
        ck(`${name} refuses`, !!msg, 'IT REACHED DRIVE — this is the 2026-08-29 incident');
        if (msg) {
            ck(`  and says why`, /Drive is disabled under JARVIS_TEST/.test(msg), msg);
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('B — and WITHOUT the flag, because nobody remembers to arm it');
{
    // THE HALF THAT ACTUALLY SAVED HER. On 2026-10-05 the flag was not set
    // and the live log was overwritten; the entry-point check was added
    // after. Deleting the flag here reproduces that run exactly: this file
    // IS under tests/, so process.argv[1] alone must be enough.
    const had = process.env.JARVIS_TEST;
    delete process.env.JARVIS_TEST;
    try {
        ck('the flag really is unset for this section', process.env.JARVIS_TEST === undefined);
        ck('  and the entry point really is under tests/',
           /(^|[/\\])tests[/\\][^/\\]+\.js$/.test(String(process.argv[1] || '')),
           `argv[1] = ${process.argv[1]} — if this is not under tests/ the section proves nothing`);

        const msg = await refused(() => drive.uploadYardChatLog('2026-08-29', 'x'));
        ck('an unflagged write STILL refuses', !!msg,
           'this is the exact call that overwrote yard/log/2026-08-29.jsonl with "x"');
        ck('  and says it was the entry point, not the flag',
           !!msg && /entry point .* is under tests\//.test(msg), msg);

        const read = await refused(() => drive.findPdfByBooking('DALA90721600'));
        ck('an unflagged read refuses too', !!read, read || 'reached Drive');
    } finally {
        if (had === undefined) delete process.env.JARVIS_TEST; else process.env.JARVIS_TEST = had;
    }
    ck('the flag is restored for anything after this', process.env.JARVIS_TEST === '1');
}

// ══════════════════════════════════════════════════════════════════════════
section('C — the refusal comes BEFORE anything is opened or sent');
{
    // If the throw ever moves below the keyfile read or the client setup,
    // this very file becomes the thing that talks to her Drive. So the
    // ORDER is asserted, not just the outcome.
    const src = fs.readFileSync(path.join(ROOT, 'helpers/drive.js'), 'utf8');
    const fn = src.slice(src.indexOf('function getDrive()'), src.indexOf('function getDrive()') + 3000);

    const atThrow = fn.indexOf('Drive is disabled under JARVIS_TEST');
    const atKeyfile = fn.indexOf('cfg.GDRIVE_KEYFILE');
    const atClient = fn.indexOf('google.auth');

    ck('getDrive throws for a test', atThrow > 0);
    ck('  before it reads the service-account keyfile',
       atKeyfile > atThrow, `throw at ${atThrow}, keyfile at ${atKeyfile}`);
    ck('  and before any auth client is built',
       atClient === -1 || atClient > atThrow, `throw at ${atThrow}, auth at ${atClient}`);

    // Both halves still present. A silent edit that dropped either one would
    // leave sections A and B passing on the surviving half alone.
    ck('the flag half is still there', /process\.env\.JARVIS_TEST === '1'/.test(fn));
    ck('the entry-point half is still there', /tests\[\\\/\\\\\]/.test(fn) || /underTest/.test(fn));
    ck('  and they are OR\x27d, so either one is enough',
       /process\.env\.JARVIS_TEST === '1' \|\| underTest/.test(fn),
       'if these became && then forgetting the flag unguards Drive again');
}

// ══════════════════════════════════════════════════════════════════════════
section('D — the old probe is gone, not just renamed');
{
    // It printed no totals, so run-tests.js scored it CRASHED forever. Its
    // name also began with an underscore, which sorted it to the top of every
    // run — the first thing anyone saw was a red that meant nothing.
    ck('tests/_guardprobe.js no longer exists',
       !fs.existsSync(path.join(ROOT, 'tests/_guardprobe.js')));
    ck('and nothing still refers to it',
       !fs.readdirSync(path.join(ROOT, 'tests'))
          .filter((f) => f.endsWith('.js') && f !== 'drive-guard.js')
          .some((f) => fs.readFileSync(path.join(ROOT, 'tests', f), 'utf8').includes('_guardprobe')));
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('ABORT', e); process.exit(1); });
