// ── tests/pickup-learn.js ─────────────────────────────────────────────────
// Apsara, 2026-11-06, in five messages:
//   "it should learn and adapt"
//   "i cant custom train as per buyer.it should learn and adapt"
//   "reinforcement"  "learning"  "adaptiv learning"
//
// The complaint is specific: a settings page with a row per carrier is work
// she will never do. Zimex answers in twenty minutes on WhatsApp, A.LEE next
// morning by email, and one of them has not answered at all this year. None
// of that should be typed in — it is all visible in what already happened.
//
// ── WHAT THESE CHECKS ARE REALLY FOR ─────────────────────────────────────
// A system that learns is a system that can learn something WRONG and then
// act on it in her name. So the halves are:
//
//   does it learn?      sections B, C, D
//   is it BOUNDED?      sections A, E, F — and those matter more
//
// The bounds: a brand-new carrier behaves exactly as it did before any of
// this existed; learning can never leave a carrier unreachable; it can never
// remove a rung, skip the ask, or move the escalation off the pickup day.
// "Chase twice, then tell the team" is hers and is not up for learning.
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.JARVIS_TEST = '1';
const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickup-learn-'));
const cfg = require(path.join(ROOT, 'config'));
cfg.DATA_DIR = dir;
cfg.PICKUPS_FILE = path.join(dir, 'pickups.json');
cfg.PICKUP_LEARN_FILE = path.join(dir, 'pickup-learn.json');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const learn = require(path.join(ROOT, 'helpers/pickupLearn'));
const agent = require(path.join(ROOT, 'helpers/pickupAgent'));
const pickups = require(path.join(ROOT, 'helpers/pickups'));

const la = (H, day = 6) => new Date(Date.UTC(2026, 10, day, H + 8, 30));
// A finished pickup, as the store would have it: asked at 08:00, answered
// `mins` later on `via`, or never if mins is null.
let n = 0;
const done = (company, { mins = null, via = 'email reply', tried = 'email', day = 6 } = {}) => {
    const askAt = new Date(Date.UTC(2026, 10, day, 16, 0)).toISOString(); // 08:00 LA
    const p = { id: `p${++n}`, company, pickup_date: `2026-11-0${day}`,
        sent: [{ step: 'ask', at: askAt, via: tried }],
        contact_email: 'ops@' + company.toLowerCase().replace(/[^a-z]/g, '') + '.example' };
    if (mins != null) {
        p.eta = 'yes';
        p.confirmed_at = new Date(Date.parse(askAt) + mins * 60000).toISOString();
        p.confirmed_via = via;
    }
    return p;
};

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — COLD START: a new carrier behaves exactly as before');
// ══════════════════════════════════════════════════════════════════════════
// The most important section in the file. If this is wrong, every pickup in
// the system changed behaviour the moment learning was added.
{
    const prof = learn.profileFor('Never Heard Of Them');
    ck('an unknown carrier has no profile', prof.known === false, JSON.stringify(prof));
    ck('  no learned timing', prof.chase_after_minutes === null);
    ck('  no channel is dropped', prof.drop_channels.length === 0);
    ck('  and it says so in words', /no history/.test(prof.why), prof.why);

    // The ladder is untouched: 08:00 ask, 11:00 chase, 14:00 team.
    const p = { company: 'Never Heard Of Them', pickup_date: '2026-11-06', status: 'arranged',
        sent: [{ step: 'ask', at: new Date(Date.UTC(2026, 10, 6, 16, 0)).toISOString(), via: 'email' }],
        contact_email: 'a@b.example' };
    ck('the chase still waits for 11:00', agent.nextAction(p, la(10), { profile: prof }).step === null);
    ck('  and happens at 11:00', agent.nextAction(p, la(11), { profile: prof }).step === 'chase');
    // And with NO profile at all — the path every existing caller takes.
    ck('  with no profile argument at all, identical',
       agent.nextAction(p, la(11)).step === 'chase' && agent.nextAction(p, la(10)).step === null);
}

// ══════════════════════════════════════════════════════════════════════════
section('B — it learns how to reach them, so she never types it twice');
// ══════════════════════════════════════════════════════════════════════════
// "i cant custom train as per buyer" — the direct answer.
{
    await learn.observe(done('Zimex Freight', { mins: 20 }));
    const c = learn.contactsFor('Zimex Freight');
    ck('the address is remembered', c.contact_email === 'ops@zimexfreight.example', JSON.stringify(c));
    ck('  and found however she capitalises it',
       learn.contactsFor('ZIMEX   freight').contact_email === 'ops@zimexfreight.example');

    // The whole point: a pickup recorded with nothing but a name is chaseable.
    const rec = await pickups.create({ company: 'Zimex Freight', pickup_date: '2026-11-20' }, 'apsara');
    ck('a pickup recorded with ONLY a name gets the address',
       rec.contact_email === 'ops@zimexfreight.example', JSON.stringify(rec.contact_email));
    ck('  it is reachable rather than on the unreachable list',
       agent.channelsFor(rec).reachable === true);
    ck('  and it is flagged, because she did not type it',
       rec.contacts_learned === true, JSON.stringify(rec.contacts_learned));

    // What she types always wins — the learned value is last year's dispatcher.
    const typed = await pickups.create({ company: 'Zimex Freight', pickup_date: '2026-11-21',
        contact_email: 'new.desk@zimex.example' }, 'apsara');
    ck('an address SHE types beats the learned one',
       typed.contact_email === 'new.desk@zimex.example', typed.contact_email);
    ck('  and is not flagged as learned', typed.contacts_learned === false);
}

// ══════════════════════════════════════════════════════════════════════════
section('C — it learns how long they take, and chases when overdue');
// ══════════════════════════════════════════════════════════════════════════
{
    // One reply is not a pattern. Two is not either.
    ck('one reply does not move anything',
       learn.profileFor('Zimex Freight').chase_after_minutes === null,
       JSON.stringify(learn.profileFor('Zimex Freight')));
    await learn.observe(done('Zimex Freight', { mins: 24, day: 7 }));
    ck('  nor two', learn.profileFor('Zimex Freight').chase_after_minutes === null);

    await learn.observe(done('Zimex Freight', { mins: 22, day: 8 }));
    const prof = learn.profileFor('Zimex Freight');
    ck('three replies is enough to form a view', prof.chase_after_minutes !== null, JSON.stringify(prof));
    ck('  the typical time is the median, not the mean of outliers',
       prof.typical_reply_minutes === 22, String(prof.typical_reply_minutes));
    ck('  and it can explain itself', /usually in about 22 minutes/.test(prof.why), prof.why);

    // 22 minutes * 1.5 = 33, floored at the 60-minute minimum → chase at 09:00.
    const p = { company: 'Zimex Freight', pickup_date: '2026-11-06', status: 'arranged',
        sent: [{ step: 'ask', at: new Date(Date.UTC(2026, 10, 6, 16, 0)).toISOString(), via: 'email' }],
        contact_email: 'a@b.example' };
    ck('a fast carrier is chased at 09:00, not 11:00',
       agent.nextAction(p, la(9), { profile: prof }).step === 'chase',
       JSON.stringify(agent.nextAction(p, la(9), { profile: prof })));
    // NOT the EARLIEST_CHASE_MIN floor — see the tombstone on that constant.
    // What actually holds this is the hour-granular ladder plus Math.ceil,
    // and this check says so rather than crediting a bound that is doing
    // nothing.
    ck('  and never inside the hour it was asked in',
       agent.nextAction(p, la(8), { profile: prof }).step === null,
       'a carrier chased 20 minutes after being asked learns to ignore us');

    // A slow carrier is left alone until later.
    for (const d of [6, 7, 8, 9]) await learn.observe(done('Slow Haulage', { mins: 240, day: d }));
    const slow = learn.profileFor('Slow Haulage');
    const sp = Object.assign({}, p, { company: 'Slow Haulage' });
    ck('a slow carrier is NOT chased at 11:00', agent.nextAction(sp, la(11), { profile: slow }).step === null,
       JSON.stringify(slow));
    ck('  but is chased before the team is told',
       agent.nextAction(sp, la(13), { profile: slow }).step === 'chase');
    ck('  because the chase can never be pushed past 13:00',
       (slow.chase_after_minutes / 60) + 8 >= agent.LATEST_CHASE_HOUR,
       `${slow.chase_after_minutes} minutes would otherwise land at ${8 + slow.chase_after_minutes / 60}:00`);
}

// ══════════════════════════════════════════════════════════════════════════
section('D — it learns which channel they actually answer on');
// ══════════════════════════════════════════════════════════════════════════
{
    // Four asks on both channels, every answer on WhatsApp, none on email.
    for (const d of [1, 2, 3, 4]) {
        await learn.observe(done('Whatsapp Only Ltd',
            { mins: 30, via: 'whatsapp', tried: 'email+whatsapp', day: d }));
    }
    const prof = learn.profileFor('Whatsapp Only Ltd');
    ck('a channel tried four times with nothing back is dropped',
       prof.drop_channels.includes('email'), JSON.stringify(prof.drop_channels));
    ck('  and the one that works is kept', !prof.drop_channels.includes('whatsapp'));

    const ch = learn.adaptChannels(
        { email: 'a@b.example', whatsapp: '+1555', reachable: true }, prof);
    ck('the dead channel stops being used', ch.email === null && ch.whatsapp === '+1555',
       JSON.stringify(ch));
    ck('  and it says which it dropped', (ch.dropped || []).includes('email'), JSON.stringify(ch.dropped));

    // ── THE BOUND THAT MATTERS MOST ──────────────────────────────────────
    // Dropping the only channel leaves a pickup nobody chases, which is the
    // exact fault this feature exists to fix. Learning may never do that.
    const emailOnly = learn.adaptChannels({ email: 'a@b.example', whatsapp: null, reachable: true }, prof);
    ck('it will NEVER drop the last channel standing',
       emailOnly.email === 'a@b.example' && emailOnly.reachable === true,
       JSON.stringify(emailOnly));

    // Three tries is not enough.
    for (const d of [1, 2, 3] ) await learn.observe(done('Maybe Freight',
        { mins: 30, via: 'whatsapp', tried: 'email+whatsapp', day: d }));
    ck('three tries is not yet evidence',
       learn.profileFor('Maybe Freight').drop_channels.length === 0,
       JSON.stringify(learn.profileFor('Maybe Freight')));
}

// ══════════════════════════════════════════════════════════════════════════
section('E — silence is a lesson too, but it changes the WORDS not the rule');
// ══════════════════════════════════════════════════════════════════════════
{
    for (const d of [1, 2, 3, 4]) await learn.observe(done('Ghost Logistics', { mins: null, day: d }));
    const prof = learn.profileFor('Ghost Logistics');
    ck('a carrier that never answers is known to never answer',
       prof.never_answers === true, JSON.stringify(prof));
    ck('  with the count behind it', prof.answers === 0 && prof.asks === 4, JSON.stringify(prof));

    // Her rule stands. It is not chased less, and the team is still told.
    const p = { company: 'Ghost Logistics', pickup_date: '2026-11-06', status: 'arranged',
        sent: [{ step: 'ask', at: new Date(Date.UTC(2026, 10, 6, 16, 0)).toISOString(), via: 'email' }],
        contact_email: 'a@b.example' };
    ck('it is STILL chased — learning does not remove a rung',
       agent.nextAction(p, la(11), { profile: prof }).step === 'chase',
       '"Chase twice, then tell the team" is hers, not something to learn away');
    const two = Object.assign({}, p, { sent: p.sent.concat([{ step: 'chase', at: new Date().toISOString() }]) });
    ck('  and the team is STILL told at 14:00',
       agent.nextAction(two, la(14), { profile: prof }).step === 'escalate');
}

// ══════════════════════════════════════════════════════════════════════════
section('F — it cannot be taught the same lesson twice');
// ══════════════════════════════════════════════════════════════════════════
// The job re-runs hourly and the reply watch polls every five minutes. If a
// finished pickup could be observed repeatedly, one reliable reply would
// look like ten and a carrier would be judged on a loop rather than on
// anything that happened.
{
    const before = learn.profileFor('Zimex Freight');
    const p = done('Zimex Freight', { mins: 25, day: 9 });
    await learn.observe(p);
    const once = learn.profileFor('Zimex Freight');
    ck('observing a new pickup counts once', once.asks === before.asks + 1,
       `${before.asks} -> ${once.asks}`);
    await learn.observe(p);
    await learn.observe(p);
    const thrice = learn.profileFor('Zimex Freight');
    ck('  observing it twice more counts for nothing', thrice.asks === once.asks,
       `${once.asks} -> ${thrice.asks}`);

    // A pickup nobody ever asked about teaches nothing either — there is no
    // outcome, only an absence.
    const untouched = { id: 'never', company: 'Zimex Freight', sent: [] };
    await learn.observe(untouched);
    ck('a pickup that was never asked about teaches nothing',
       learn.profileFor('Zimex Freight').asks === thrice.asks);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.log('CRASHED: ' + (e && e.stack || e)); process.exit(1); });
