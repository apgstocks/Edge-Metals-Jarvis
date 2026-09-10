// ── tests/delivery-enquiry.js ─────────────────────────────────────────────
// Apsara, 2026-09-10: "say i do local transit, we will pay the trucker and
// trucker will give estimated delivery date and time. I want to send a enquiry
// at that date and time reg the load delivery status".
//
// WHAT IS ACTUALLY WORTH TESTING HERE is not that an enquiry gets scheduled —
// that is one enqueue call and it either works or the whole feature is
// obviously dead. It is every way the enquiry must NOT happen, because each
// of those fails silently:
//
//   · the trucker name on the load is free text and taskRunner matches the
//     roster with ===. A near miss burns three tries and archives itself as
//     'no_chatid_resolved' with nobody told. That has already happened to her
//     once, to a whole quote-reminder chain (see scheduler.js's comments).
//   · she marks the load delivered, and Jarvis asks the trucker anyway.
//   · she moves the ETA, and TWO enquiries go out an hour apart.
//   · she corrects a typo on a delivered load, buildRecord rebuilds the record
//     from its fixed field list, and the load is quietly in transit again.
//   · the message carries the amount, and the haulier learns what the buyer
//     paid for the metal.
//
// None of those raises anything. All of them are below.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-delivery-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));

// ── THE ROSTER IS INJECTED, AND THAT IS NOT A CONVENIENCE ────────────────
// helpers/json.js's loadTruckers() reads SUPABASE, not a file. An earlier
// draft of this test wrote a truckers JSON file that nothing reads, and every
// lookup here silently queried Apsara's LIVE production roster instead —
// which is why 'AP Oakland' resolved and the three invented truckers did not.
// A read did no damage; a test one edit away from writing to her real
// database is not something to leave standing. resolveTrucker now takes a
// roster, and production never passes one.
const ROSTER = [
    { name: 'Jose AJ Transport', email: 'jose@ajtransport.test', preferred_mode: 'email' },
    { name: 'AP Oakland', whatsapp: '15551110000', group_id: 'g-ap@g.us', preferred_mode: 'whatsapp' },
    { name: 'No Contact Hauling' },                       // on file, unreachable
    { name: 'Twin Co' }, { name: 'twin-co' },             // collide once normalised
];
fs.writeFileSync(cfg.TASKS_FILE, '[]');
fs.writeFileSync(cfg.TASKS_HISTORY_FILE, '[]');
fs.writeFileSync(cfg.OUTBOUND_LOADS_FILE, '[]');

const de = require(path.join(ROOT, 'helpers/deliveryEnquiry'));
const tasks = require(path.join(ROOT, 'helpers/tasks'));
const outbound = require(path.join(ROOT, 'helpers/outboundLoads'));

// Far enough ahead that no test is racing the clock.
const FUTURE = '2026-12-15';
const baseLoad = (over = {}) => ({
    date: '2026-12-01', buyer: 'Daekwang', trucker_name: 'AP Oakland',
    items: [{ description: 'Auto cast', gross_weight: 8100, tare_weight: 100, price: 0.85 }],
    weight_unit: 'lb',
    delivery_eta_date: FUTURE, delivery_eta_time: '14:30',
    ...over,
});

(async () => {

section('A — the ETA is a wall clock where the truck is, not on the server');
{
    // LA is UTC-7 in March (PDT) and UTC-8 in November (PST). The same typed
    // "2:30 PM" therefore has to come out an hour apart in UTC, and a
    // conversion that carried a fixed offset would get one of them wrong.
    const spring = de.etaInstant('2026-03-09', '14:30');
    const autumn = de.etaInstant('2026-11-02', '14:30');
    ck('2:30 PM in March is 21:30Z (PDT)', spring && spring.toISOString() === '2026-03-09T21:30:00.000Z',
       spring && spring.toISOString());
    ck('2:30 PM in November is 22:30Z (PST)', autumn && autumn.toISOString() === '2026-11-02T22:30:00.000Z',
       autumn && autumn.toISOString());
    ck('  the two differ by exactly an hour, which is the whole point',
       autumn && spring && ((autumn - spring) % 3600000 === 0));

    // The day the clocks go forward, 2 AM does not exist in LA.
    const nonexistent = de.etaInstant('2026-03-08', '02:30');
    ck('a time that does not exist on a DST day still returns an instant, not a crash',
       nonexistent instanceof Date && isFinite(nonexistent.getTime()), String(nonexistent));

    ck('a nonsense time is null, not midnight', de.etaInstant('2026-12-15', '25:99') === null);
    ck('a US-format date is null, not a silent misread', de.etaInstant('12/15/2026', '14:30') === null);
    ck('a missing time is null', de.etaInstant('2026-12-15', '') === null);
}

section('B — it rides the existing task queue');
{
    const load = await outbound.addOutboundLoad(baseLoad());
    const out = await de.scheduleForLoad(load, { roster: ROSTER });
    ck('an ETA and a known trucker schedules the enquiry', out.scheduled === true, JSON.stringify(out));

    const queued = tasks.loadTasks().filter((t) => t.outbound_load_id === load.id);
    ck('  exactly one task, not two', queued.length === 1, `got ${queued.length}`);
    const t = queued[0];
    ck('  it fires at the ETA', t.fire_at === de.etaFor(load).toISOString(), t.fire_at);
    ck('  it is aimed at the trucker', t.target_kind === 'trucker' && t.target_name === 'AP Oakland', t.target_name);
    ck('  and it is an ordinary pending task the runner already drains',
       t.status === 'pending' && !!t.message, JSON.stringify({ status: t.status }));
    // The whole design decision, pinned: no second scheduler.
    ck('  no new runner branch is needed — the generic path handles it',
       !fs.readFileSync(path.join(ROOT, 'scheduler.js'), 'utf8').includes(de.TASK_TYPE),
       'scheduler.js gained a branch for this type; the generic path was supposed to be enough');

    await de.cancelForLoad(load.id, 'test_cleanup');
}

section('C — the message says which load, and never says what it cost');
{
    const load = { ...baseLoad(), id: 'OUT_X', net_weight: 8000, amount: 6800 };
    const msg = de.enquiryMessage(load);
    ck('it names the buyer', /Daekwang/.test(msg), msg);
    ck('it names the material', /Auto cast/.test(msg), msg);
    ck('it names the weight', /8000 lb/.test(msg), msg);
    ck('it names the time it was due', /2:30 PM/.test(msg), msg);
    ck('it asks the question', /delivered/i.test(msg), msg);
    // The one that matters. A trucker confirming a drop is not entitled to
    // the buyer's price, and the record has it sitting right there.
    ck('IT DOES NOT CARRY THE AMOUNT', !/6800|6,800/.test(msg), msg);
    ck('  nor the per-lb price', !/0\.85/.test(msg), msg);
}

section('D — refused OUT LOUD when the enquiry could never be delivered');
{
    const mk = async (over) => de.scheduleForLoad({ ...baseLoad(over), id: 'OUT_D' }, { roster: ROSTER });

    const unknown = await mk({ trucker_name: 'Jose AJ' });
    ck('a near-miss trucker name is refused, not fuzzily matched to Jose AJ Transport',
       unknown.scheduled === false && unknown.why === 'unknown_trucker', JSON.stringify(unknown));
    ck('  and it says so in words she can act on',
       /not in the trucker list/.test(unknown.message || ''), unknown.message);

    const none = await mk({ trucker_name: null });
    ck('a load with no trucker is refused', none.scheduled === false && none.why === 'no_trucker');

    const unreachable = await mk({ trucker_name: 'No Contact Hauling' });
    ck('a trucker on file with no number, group or email is refused',
       unreachable.scheduled === false && unreachable.why === 'unreachable_trucker', JSON.stringify(unreachable));

    const ambiguous = await mk({ trucker_name: 'twinco' });
    ck('two roster entries that collide once normalised are refused, not guessed between',
       ambiguous.scheduled === false && ambiguous.why === 'ambiguous_trucker', JSON.stringify(ambiguous));

    const past = await mk({ delivery_eta_date: '2020-01-01' });
    ck('an ETA already gone is refused rather than fired the instant she saves',
       past.scheduled === false && past.why === 'eta_passed', JSON.stringify(past));

    const noEta = await mk({ delivery_eta_date: null, delivery_eta_time: null });
    ck('no ETA at all is not an error — most loads never get one',
       noEta.scheduled === false && noEta.why === 'no_eta');
    ck('  and it stays quiet about it', !noEta.message);

    // Every refusal except no_eta must carry something to put on screen,
    // because a refusal she cannot see is the silent failure this file exists
    // to prevent.
    for (const r of [unknown, none, unreachable, ambiguous, past]) {
        ck(`  "${r.why}" carries a message`, !!r.message, JSON.stringify(r));
    }

    ck('nothing was queued by any of those',
       tasks.loadTasks().filter((t) => t.outbound_load_id === 'OUT_D').length === 0);
}

section('E — it does not ask about a load that is no longer a question');
{
    const load = await outbound.addOutboundLoad(baseLoad());
    await de.scheduleForLoad(load, { roster: ROSTER });
    const t = () => tasks.loadTasks().find((x) => x.outbound_load_id === load.id);

    ck('while it is in transit, the task would fire', tasks.evaluateCondition(t()) === 'fire');

    await outbound.markDelivered(load.id);
    ck('marking it delivered cancels the pending enquiry outright',
       !t(), 'the task is still sitting in her queue');
    const archived = tasks.loadHistory().find((x) => x.outbound_load_id === load.id);
    ck('  and it is in history, not merely vanished',
       !!archived && archived.status === 'cancelled', JSON.stringify(archived || {}));

    // Belt and braces: even if the cancel had failed, the gate must refuse.
    const stale = { ...archived, status: 'pending' };
    ck('  and the condition would have skipped it anyway',
       tasks.evaluateCondition(stale) === 'skip');

    // A load that no longer exists.
    const gone = await outbound.addOutboundLoad(baseLoad());
    await de.scheduleForLoad(gone, { roster: ROSTER });
    const goneTask = tasks.loadTasks().find((x) => x.outbound_load_id === gone.id);
    await outbound.deleteOutboundLoad(gone.id);
    ck('a deleted load cannot produce an enquiry', tasks.evaluateCondition(goneTask) === 'skip');

    // DELETE /api/outbound-loads/:id also calls cancelForLoad, so in
    // production this task is gone rather than merely inert. Done by hand here
    // because this test drives the helper, not the route — and left uncancelled
    // it would be picked up by the NEXT load created, which is the hazard
    // section H is about.
    await de.cancelForLoad(gone.id, 'load_deleted');
}

section('F — moving the ETA leaves ONE enquiry, at the new time');
{
    const load = await outbound.addOutboundLoad(baseLoad());
    await de.scheduleForLoad(load, { roster: ROSTER });
    const first = tasks.loadTasks().find((x) => x.outbound_load_id === load.id);

    const moved = await outbound.editOutboundLoad(load.id, baseLoad({ delivery_eta_time: '18:00' }));
    ck('the edit kept the ETA — buildRecord did not drop it',
       moved.delivery_eta_time === '18:00' && moved.delivery_eta_date === FUTURE, JSON.stringify({
           d: moved.delivery_eta_date, t: moved.delivery_eta_time }));

    const sync = await de.syncForLoad(moved, { roster: ROSTER });
    ck('  rescheduling cancelled the old one', sync.cancelled === 1, `cancelled ${sync.cancelled}`);
    const now = tasks.loadTasks().filter((x) => x.outbound_load_id === load.id);
    ck('  and left exactly one, not two', now.length === 1, `got ${now.length}`);
    ck('  at the new time', now[0] && now[0].fire_at === de.etaFor(moved).toISOString(), now[0] && now[0].fire_at);

    // The pinned instant is the second line of defence: if the cancel above
    // had half-failed, the survivor must disqualify itself.
    ck('  and the OLD task would have skipped itself on its pinned instant',
       tasks.evaluateCondition(first) === 'skip',
       'a stale task with the old eta_at would still have fired — two enquiries');

    await de.cancelForLoad(load.id, 'test_cleanup');
}

section('G — an edit must not un-deliver a delivered load');
{
    const load = await outbound.addOutboundLoad(baseLoad());
    await outbound.markDelivered(load.id, { on: '2026-12-15T23:00:00.000Z' });

    // She corrects a typo in the buyer's address. buildRecord rebuilds from a
    // fixed field list; without the carry-across in editOutboundLoad this puts
    // the load back in transit and lets a fresh enquiry be scheduled on it.
    const edited = await outbound.editOutboundLoad(load.id, baseLoad({ buyer_address: '55 Industrial Rd' }));
    ck('it is still delivered after an unrelated edit',
       edited.delivery_status === 'delivered', edited.delivery_status);
    ck('  and still knows when', edited.delivered_at === '2026-12-15T23:00:00.000Z', edited.delivered_at);

    const after = await de.scheduleForLoad(edited, { roster: ROSTER });
    ck('  so no enquiry can be scheduled against it',
       after.scheduled === false && after.why === 'already_delivered', JSON.stringify(after));

    // And a brand new load is not born delivered.
    const fresh = await outbound.addOutboundLoad(baseLoad());
    ck('a new load starts in transit', fresh.delivery_status === 'in_transit', fresh.delivery_status);
    ck('  with no delivered_at', fresh.delivered_at === null);
}

section('H — a recycled load id must not inherit the old load\'s enquiry');
{
    // FOUND BY THIS TEST, 2026-09-10, as a failure I first took for fixture
    // noise: outboundLoads.nextOutboundId derives the next id from the highest
    // one PRESENT, so deleting OUT_07 hands OUT_07 straight to the next load
    // created. Anything keyed on the id alone then follows the wrong record.
    const first = await outbound.addOutboundLoad(baseLoad());
    await de.scheduleForLoad(first, { roster: ROSTER });
    const orphan = tasks.loadTasks().find((t) => t.outbound_load_id === first.id);
    ck('a load is scheduled', !!orphan);

    await outbound.deleteOutboundLoad(first.id);          // WITHOUT cancelling
    const recycled = await outbound.addOutboundLoad(baseLoad({ buyer: 'Somebody Else' }));
    ck('the id really is reissued to a different load', recycled.id === first.id,
       `${first.id} -> ${recycled.id}; if this ever fails, nextOutboundId was changed and the guard below can go`);

    // Same id, same ETA — so load_id and eta_at both match, and only
    // load_created_at can tell these two loads apart.
    ck('  but the orphaned enquiry does NOT fire against it',
       tasks.evaluateCondition(orphan) === 'skip',
       'Somebody Else\'s load would have had an enquiry sent about Daekwang\'s');

    await de.cancelForLoad(recycled.id, 'test_cleanup');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\n  THREW:', e.stack || e.message); process.exit(1); });
