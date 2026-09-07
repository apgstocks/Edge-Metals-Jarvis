// ── tests/cutoff-scan.js ──────────────────────────────────────────────────
// Apsara, 2026-09-06: "if i say jarvis-run a scan for booking that are past
// cut off date, it shuld run a test and archive those bookings automaticlaly."
//
// WHAT ALREADY EXISTED
// --------------------
// scheduler.js:autoArchive() — the nightly 11PM job — has scanned, archived
// and notified for weeks. It was exported and called from NOWHERE except its
// own cron registration: no intent, no route, no way to ask for it. The rule
// worked; the door did not exist.
//
// WHAT THIS FILE GUARDS, in order of how badly it fails:
//   1. ONE definition of "past cutoff". Two copies means the preview shows
//      her one set of bookings and the nightly job archives another, and no
//      way to tell which was right.
//   2. keep_active is honoured on BOTH paths — an on-demand scan that ignored
//      it would undo a decision she made on purpose.
//   3. the list she said yes to is the list that gets archived
//   4. "archive DALA123" never becomes "archive everything expired"

const path = require('path');
const fs = require('fs');
const os = require('os');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');

// A temp DATA_DIR, always. These fixtures describe expired bookings, and a
// test that ran against data/ would be a test that archives her real ones.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-cutoff-'));
process.env.DATA_DIR = dir;
for (const k of Object.keys(require.cache)) {
    if (/helpers\/(json|cutoffScan|time)|config\.js$/.test(k)) delete require.cache[k];
}

const ymd = (offsetDays) => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
};

// MEASURED, not assumed — and measured AT RUN TIME, which is the second
// lesson. daysUntil() rounds from a moment, so the offset that lands on
// daysUntil -1 is not the same in the morning as it is in the evening: this
// suite passed all afternoon on ymd(-2)/ymd(-1) and went red at midnight when
// the date rolled and every fixture shifted a day. A test that depends on the
// hour is a test people learn to ignore.
//
// So the two boundary offsets are PROBED rather than hardcoded. The rule keeps
// days <= -1, so:
//   EDGE_IN  → the newest offset that IS archived (daysUntil -1)
//   EDGE_OUT → one day younger, NOT archived (daysUntil 0)
// If the probe cannot find them the suite says so instead of quietly testing
// two bookings that both sit well inside the same side of the line.
const { daysUntil } = require(path.join(ROOT, 'helpers/time.js'));
let EDGE_IN = null, EDGE_OUT = null;
for (let o = 0; o >= -4; o--) {
    const d = daysUntil(ymd(o));
    if (d === -1 && EDGE_IN === null) EDGE_IN = o;
    if (d === 0 && EDGE_OUT === null) EDGE_OUT = o;
}
fs.writeFileSync(path.join(dir, 'bookings.json'), JSON.stringify({
    // Insertion order deliberately NOT expiry order, so the sort has
    // something to do. With the list already in the right order a mutation
    // deleting the sort survived every assertion.
    EXPIRED2: { booking_number: 'EXPIRED2', cutoff_date: ymd(-3), carrier: 'MSC', port_of_loading: 'OAKLAND' },
    LONGGONE: { booking_number: 'LONGGONE', cutoff_date: ymd(-12), carrier: 'Maersk', port_of_loading: 'HOUSTON', containers: [{ seq: 1 }] },
    HELDOPEN: { booking_number: 'HELDOPEN', cutoff_date: ymd(-5), carrier: 'CMA' },
    // daysUntil -1: the newest booking that still counts as expired.
    JUSTOVER: { booking_number: 'JUSTOVER', cutoff_date: ymd(EDGE_IN), carrier: 'ONE' },
    // daysUntil 0: one day younger, and NOT expired. Archiving this strands a
    // booking whose container can still be gated.
    STILLOK:  { booking_number: 'STILLOK',  cutoff_date: ymd(EDGE_OUT), carrier: 'ONE' },
    TOMORROW: { booking_number: 'TOMORROW', cutoff_date: ymd(+1), carrier: 'ONE' },
    NODATE:   { booking_number: 'NODATE',   carrier: 'Hapag' },
}));
fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    HELDOPEN: { keep_active: true, step: 'trucker_assigned' },
}));

const scan = require(path.join(ROOT, 'helpers/cutoffScan.js'));

// The probe has to have worked, or the two boundary assertions below are
// comparing bookings that are not on the boundary at all — which is exactly
// the failure this file already recorded once.
ck('the archive boundary was located', EDGE_IN !== null && EDGE_OUT === EDGE_IN + 1,
   `EDGE_IN=${EDGE_IN} EDGE_OUT=${EDGE_OUT} — daysUntil no longer yields -1 and 0 on `
   + 'consecutive days, so the fixtures cannot straddle the line');

console.log('\n─ scanning for bookings past cutoff ─────────────────────────');

section('A — which bookings the scan finds');
{
    const rows = scan.pastCutoff();
    const nos = rows.map((r) => r.bkgNo);

    ck('the long-expired one is found', nos.includes('LONGGONE'), JSON.stringify(nos));
    ck('  and the recently expired one', nos.includes('EXPIRED2'));

    // HER EXPLICIT HOLD. An on-demand scan that ignored keep_active would
    // undo a decision she made on purpose, and she would find out by the
    // booking vanishing off her board.
    ck('  a booking she flagged keep_active is NOT', !nos.includes('HELDOPEN'),
       JSON.stringify(nos) + ' — keep_active is her decision, on both paths');

    // THE BOUNDARY, and it is one day wide. These two bookings differ by a
    // single day and fall on opposite sides of the rule.
    ck('  the newest expired booking IS included', nos.includes('JUSTOVER'),
       JSON.stringify(nos) + ' — daysUntil -1 is expired');
    ck('  and the one a day younger is NOT', !nos.includes('STILLOK'),
       JSON.stringify(nos) + ' — daysUntil 0; its container can still be gated');
    ck('  nor tomorrow\'s', !nos.includes('TOMORROW'));

    // No cutoff date is "could not be determined", not "expired". The 10:45PM
    // backfill job exists to fill these in before the 11PM archive runs.
    //
    // WORTH BEING HONEST ABOUT: deleting the explicit !cutoff_date guard in
    // cutoffScan.js does NOT change this outcome, because daysUntil returns a
    // 999 sentinel for a missing date and 999 fails the comparison anyway.
    // The guard is belt-and-braces against that sentinel changing, and this
    // assertion cannot distinguish the two. Recorded rather than dressed up
    // as something the test proves.
    ck('  and a booking with no cutoff date at all is left alone',
       !nos.includes('NODATE'),
       'no date is unknown, not expired — the nightly backfill runs first for exactly this');

    ck('exactly three are past cutoff', rows.length === 3, JSON.stringify(nos));
}

section('B — the order, and the sentence');
{
    const rows = scan.pastCutoff();
    ck('longest expired first', rows[0].bkgNo === 'LONGGONE', rows.map((r) => r.bkgNo).join(','));
    // NOT asserted as exactly -12. daysUntil measures from a moment, so a
    // cutoff set 12 calendar days back reads as -11 or -12 depending on the
    // time of day the suite runs — and a test that fails at 6pm and passes at
    // 9am is a test people learn to ignore.
    ck('  days are negative, as daysUntil reports them',
       rows[0].days <= -11 && rows[0].days >= -13,
       String(rows[0].days) + ' — converting to a positive "days ago" here would be a third representation of one fact');

    const said = scan.describe(rows);
    ck('the sentence counts them', /3 bookings past cutoff/.test(said), said);
    ck('  and names the oldest', new RegExp(`${Math.abs(rows[0].days)} days ago`).test(said), said);
    ck('  and says so plainly when there are none',
       /nothing is past/i.test(scan.describe([])), scan.describe([]));
}

section('C — ONE rule, shared with the nightly job');
{
    // Two copies of "past cutoff" would mean the preview showing one set and
    // the 11PM job archiving another. This is the assertion that matters most
    // in the file.
    const sched = fs.readFileSync(path.join(ROOT, 'scheduler.js'), 'utf8');
    ck('the nightly job uses the shared scan',
       /require\('\.\/helpers\/cutoffScan'\)\.pastCutoff\(\)/.test(sched),
       'autoArchive must not keep its own loop');
    ck('  and no longer carries its own cutoff comparison',
       !/if \(d > -1\) continue;/.test(sched),
       'the old inline rule is still there — two definitions, one of them wrong eventually');

    const acts = fs.readFileSync(path.join(ROOT, 'workflow/actions.js'), 'utf8');
    ck('  the on-demand scan uses it too',
       /require\('\.\.\/helpers\/cutoffScan'\)/.test(acts));
    ck('  and does not reimplement the comparison',
       !/daysUntil\([^)]*cutoff_date\)[\s\S]{0,80}> -1/.test(acts),
       'a second comparison is the drift this whole refactor exists to prevent');

    // The boundary constant is named once so the two cannot disagree by a day.
    ck('  the boundary is a named constant', scan.PAST_BY_DAYS === -1, String(scan.PAST_BY_DAYS));
}

section('D — it asks before archiving a batch');
{
    const acts = fs.readFileSync(path.join(ROOT, 'workflow/actions.js'), 'utf8');
    const fn = acts.slice(acts.indexOf('async function scanPastCutoff'),
                          acts.indexOf('// ── Pending resolution'));

    ck('nothing is archived by the scan itself',
       !/archiveBooking\(/.test(fn),
       'the scan shows and asks; the archive happens on her yes');
    ck('  it stages a confirmation', /type: 'confirm_archive_batch'/.test(fn));
    ck('  asking a yes/no question', /\(yes\/no\)/.test(fn));
    ck('  and lists what would go', /r\.bkgNo/.test(fn) && /r\.cutoff/.test(fn),
       'a batch archive with no list is a batch archive she cannot check');

    // THE LIST SHE SAW IS THE LIST THAT GOES. Re-scanning at confirm time
    // would archive a different set if a cutoff passed in between.
    ck('  the booking numbers are carried on the pending',
       /bkg_nos: rows\.map\(\(r\) => r\.bkgNo\)/.test(fn),
       're-scanning at confirm time archives something she never saw');

    const res = acts.slice(acts.indexOf("case 'confirm_archive_batch'"),
                           acts.indexOf("case 'confirm_archive_batch'") + 1400);
    ck('the confirmation archives through the SHARED writer',
       /archiveBooking\(no, 'cutoff_passed_scan'\)/.test(res),
       'the same function the manual archive and the dashboard use');
    ck('  from the pending, not from a fresh scan',
       /pending\.bkg_nos/.test(res) && !/pastCutoff\(\)/.test(res));
    ck('  and anything that failed is named, not swallowed',
       /missed/.test(res) && /Couldn't archive/.test(res),
       'a booking she thinks is archived and is not is still on her board');
}

section('E — nothing found is said out loud');
{
    const acts = fs.readFileSync(path.join(ROOT, 'workflow/actions.js'), 'utf8');
    const fn = acts.slice(acts.indexOf('async function scanPastCutoff'),
                          acts.indexOf('// ── Pending resolution'));
    ck('an empty result answers her',
       /nothing is past its cutoff/i.test(fn),
       '"nothing happened" and "it did not run" look identical from outside, and she just asked it to do something');
}

section('F — asking for it, without asking for something else');
{
    const brain = fs.readFileSync(path.join(ROOT, 'workflow/brain.js'), 'utf8');
    ck('scan_cutoffs is dispatched', /case 'scan_cutoffs':\s*return actions\.scanPastCutoff\(chatId\)/.test(brain));
    // The action list the model is shown. Bounded by the NEXT heading rather
    // than by a character count I guessed at — my first window was 900 chars
    // and stopped short of the line, failing against correct code.
    // Anchored on the LIST'S OWN FIRST LINE, not on a heading. Two attempts
    // failed here: indexOf('AVAILABLE ACTIONS') landed on a paragraph of
    // prose about the list, and the box-drawing heading did not match what I
    // typed. The list starts with forward_booking and that is stable.
    const listFrom = brain.indexOf('forward_booking, assign_supplier, recall_booking');
    const actionList = listFrom === -1 ? '' : brain.slice(listFrom, listFrom + 900);
    ck('  and offered to the classifier', /scan_cutoffs/.test(actionList),
       listFrom === -1 ? 'could not find the action list at all' : actionList.slice(0, 240));

    // The policy shortcut. Three conditions, and the third is what keeps
    // "run a scan" from triggering a batch archive.
    const re1 = /\b(scan|check|find|look|any|which|show)\b/i;
    const re2 = /\b(past|passed|expired|expiry|overdue|beyond|after)\b/i;
    const re3 = /\b(cut\s*-?\s*off|cutoff|cutoffs)\b/i;
    const hits = (t) => re1.test(t) && re2.test(t) && re3.test(t);

    for (const t of [
        'run a scan for booking that are past cut off date',   // her exact words
        'scan for bookings past cutoff',
        'which bookings are past their cutoff',
        'show me anything past cutoff',
    ]) ck(`"${t}" asks for the scan`, hits(t) === true);

    // AND WHAT MUST NOT. "archive DALA123" sits one word from "archive
    // everything expired", and a misread there archives the wrong thing.
    for (const t of [
        'archive DALA123',
        'run a scan',                       // of what? she has other things
        'what is the cutoff for DALA123',
        'when is the cutoff',
        'any bookings from Houston',
    ]) ck(`  "${t}" does not`, hits(t) === false);

    // The single-booking archive still works and is a different intent.
    ck('archive_booking is still its own intent',
       /case 'archive_booking':\s*return bkg \? actions\.archiveNow/.test(brain));
}

section('G — the router sends it to Jarvis, not Scout');
{
    // Scout is yard-only and cannot archive anything. A scan landing there
    // would answer "that is not in the records".
    const { routeVoice } = require(path.join(ROOT, 'helpers/voiceRouter.js'));
    for (const t of [
        'run a scan for bookings past cut off date',
        'scan for bookings past cutoff',
        'archive the ones past cutoff',
    ]) ck(`"${t}" → Jarvis`, routeVoice(t).agent === 'jarvis', routeVoice(t).agent);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
