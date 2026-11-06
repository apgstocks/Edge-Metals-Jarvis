// ── tests/pickup-learn.js ─────────────────────────────────────────────────
// Apsara, 2026-11-06:
//   "it should learn and adapt"
//   "i cant custom train as per buyer.it should learn and adapt"
//   "reinforcement"  "learning"  "adaptiv learning"
//   "use renorcement and adaptive learning concepts"
//
// ── WHY THE FIRST VERSION FAILED HER BRIEF ───────────────────────────────
// It counted failures and applied a threshold, and a channel once dropped
// was dropped FOREVER. Pure exploitation. If Zimex fixed their mail server
// Jarvis would never find out, because it had stopped generating the
// evidence that would change its mind. Section E is that defect's gravestone
// and the most important section here.
//
// ── WHAT THESE CHECKS ARE FOR ────────────────────────────────────────────
// A system that learns can learn something WRONG and then act on it in her
// name — by mailing, or by going quiet. So:
//
//   does it learn?    C, D, F, G
//   is it BOUNDED?    A, E, H, I — and those matter more
//
// A is the one that would matter most if it broke: a carrier with no history
// must behave EXACTLY as it did before any of this was written.
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
// A finished pickup as the store would hold it: asked at 08:00 LA, answered
// `mins` later on `via` (or never), with `tried` channels recorded.
let seq = 0;
const outcome = (company, { mins = null, via = 'email reply', tried = 'email', chases = 0 } = {}) => {
    seq += 1;
    const at = new Date(Date.UTC(2026, 9, 1, 16, 0) + seq * 86400000).toISOString();
    const sent = [{ step: 'ask', at, via: tried }];
    for (let i = 0; i < chases; i++) sent.push({ step: 'chase', at, via: tried });
    const p = { id: `o${seq}`, company, pickup_date: '2026-11-06', sent,
        contact_email: 'ops@' + company.toLowerCase().replace(/[^a-z]/g, '') + '.example' };
    if (mins != null) {
        p.eta = 'yes';
        p.confirmed_at = new Date(Date.parse(at) + mins * 60000).toISOString();
        p.confirmed_via = via;
    }
    return p;
};
// A pickup mid-flight, asked at 08:00 today.
const live = (company) => ({ company, pickup_date: '2026-11-06', status: 'arranged',
    sent: [{ step: 'ask', at: new Date(Date.UTC(2026, 10, 6, 16, 0)).toISOString(), via: 'email' }],
    contact_email: 'a@b.example' });

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — COLD START: a new carrier behaves exactly as before');
// ══════════════════════════════════════════════════════════════════════════
// Beta(1,1) is uniform — it knows nothing and assumes nothing. If this broke,
// every pickup in the system changed behaviour the day learning landed.
{
    const prof = learn.profileFor('Never Heard Of Them');
    ck('an unknown carrier has no profile', prof.known === false, JSON.stringify(prof));
    ck('  no learned timing', prof.chase_after_minutes === null);
    ck('  nothing set aside', prof.set_aside.length === 0);
    ck('  and it says so in words', /no history/.test(prof.why), prof.why);

    const p = live('Never Heard Of Them');
    ck('the chase still waits for 11:00', agent.nextAction(p, la(10), { profile: prof }).step === null);
    ck('  and happens at 11:00', agent.nextAction(p, la(11), { profile: prof }).step === 'chase');
    ck('  with NO profile argument at all, identical',
       agent.nextAction(p, la(11)).step === 'chase' && agent.nextAction(p, la(10)).step === null);
}

// ══════════════════════════════════════════════════════════════════════════
section('B — the reward function, written down and readable');
// ══════════════════════════════════════════════════════════════════════════
// A reward you cannot read is a policy nobody can argue with.
{
    ck('answered on the first ask scores 1',
       learn.rewardFor({ eta: '2pm', sent: [{ step: 'ask' }] }) === 1);
    ck('  answered after one chase is worth less',
       learn.rewardFor({ eta: '2pm', sent: [{ step: 'ask' }, { step: 'chase' }] }) === 0.7);
    ck('  but still clearly good — they did answer',
       learn.rewardFor({ eta: '2pm', sent: [{ step: 'ask' }, { step: 'chase' }] }) >= 0.5);
    ck('never answered scores 0', learn.rewardFor({ sent: [{ step: 'ask' }] }) === 0);
    // A pickup is not scored on whether the truck turned up — that is the
    // yard's fact, and scoring it would punish a carrier for weather.
    ck('a confirmed ETA scores the same whatever happened later',
       learn.rewardFor({ confirmed_at: 'x', status: 'cancelled', sent: [{ step: 'ask' }] }) === 1);
}

// ══════════════════════════════════════════════════════════════════════════
section('C — the posterior carries its own uncertainty');
// ══════════════════════════════════════════════════════════════════════════
// The whole reason for Beta rather than a hit count: 0 of 2 and 0 of 40 are
// both zero, and only the second is evidence.
{
    ck('a cold arm is a coin flip', learn.armMean({ a: 1, b: 1 }) === 0.5);
    ck('  and completely uncertain', learn.armUpper({ a: 1, b: 1 }) === 1);
    ck('0 of 2 is NOT evidence', learn.armUpper({ a: 1, b: 3 }) > 0.5,
       String(learn.armUpper({ a: 1, b: 3 })));
    ck('  but 0 of 20 is', learn.armUpper({ a: 1, b: 21 }) < 0.2,
       String(learn.armUpper({ a: 1, b: 21 })));
    ck('the prior is not counted as evidence', learn.armEvidence({ a: 1, b: 1 }) === 0);
}

// ══════════════════════════════════════════════════════════════════════════
section('D — it learns how to reach them, so she never types it twice');
// ══════════════════════════════════════════════════════════════════════════
// "i cant custom train as per buyer" — the direct answer.
{
    await learn.observe(outcome('Zimex Freight', { mins: 20 }));
    ck('the address is remembered',
       learn.contactsFor('Zimex Freight').contact_email === 'ops@zimexfreight.example');
    ck('  and found however she capitalises it',
       learn.contactsFor('ZIMEX   freight').contact_email === 'ops@zimexfreight.example');

    const rec = await pickups.create({ company: 'Zimex Freight', pickup_date: '2026-11-20' }, 'apsara');
    ck('a pickup recorded with ONLY a name gets the address',
       rec.contact_email === 'ops@zimexfreight.example', rec.contact_email);
    ck('  so it is reachable, not on the unreachable list',
       agent.channelsFor(rec).reachable === true);
    ck('  and flagged, because she did not type it', rec.contacts_learned === true);

    const typed = await pickups.create({ company: 'Zimex Freight', pickup_date: '2026-11-21',
        contact_email: 'new.desk@zimex.example' }, 'apsara');
    ck('an address SHE types beats the learned one',
       typed.contact_email === 'new.desk@zimex.example', typed.contact_email);
    ck('  and is not flagged as learned', typed.contacts_learned === false);
}

// ══════════════════════════════════════════════════════════════════════════
section('E — the online value estimate moves the chase to when it is overdue');
// ══════════════════════════════════════════════════════════════════════════
{
    ck('one reply moves nothing', learn.profileFor('Zimex Freight').chase_after_minutes === null);
    await learn.observe(outcome('Zimex Freight', { mins: 24 }));
    await learn.observe(outcome('Zimex Freight', { mins: 22 }));
    ck('  nor three — MIN_EVIDENCE is effective, not raw, count',
       learn.profileFor('Zimex Freight').chase_after_minutes === null,
       JSON.stringify(learn.profileFor('Zimex Freight')));

    for (let i = 0; i < 4; i++) await learn.observe(outcome('Zimex Freight', { mins: 22 }));
    const prof = learn.profileFor('Zimex Freight');
    ck('enough replies forms a view', prof.chase_after_minutes !== null, JSON.stringify(prof));
    ck('  it can explain itself', /usually in about \d+ minutes/.test(prof.why), prof.why);
    ck('  and reports the average reward it has been getting',
       typeof prof.avg_reward === 'number' && prof.avg_reward > 0.9, String(prof.avg_reward));

    const p = live('Zimex Freight');
    ck('a fast carrier is chased at 09:00, not 11:00',
       agent.nextAction(p, la(9), { profile: prof }).step === 'chase', JSON.stringify(prof));
    ck('  and never inside the hour it was asked in',
       agent.nextAction(p, la(8), { profile: prof }).step === null);

    for (let i = 0; i < 8; i++) await learn.observe(outcome('Slow Haulage', { mins: 240 }));
    const slow = learn.profileFor('Slow Haulage');
    const sp = live('Slow Haulage');
    ck('a slow carrier is NOT nagged at 11:00',
       agent.nextAction(sp, la(11), { profile: slow }).step === null, JSON.stringify(slow));
    ck('  but is still chased before the team is told',
       agent.nextAction(sp, la(13), { profile: slow }).step === 'chase');
    ck('  because the chase can never be pushed past 13:00',
       8 + (slow.chase_after_minutes / 60) > agent.LATEST_CHASE_HOUR,
       `${slow.chase_after_minutes}min would land at ${8 + slow.chase_after_minutes / 60}:00`);
}

// ══════════════════════════════════════════════════════════════════════════
section('F — the bandit sets a dead channel aside, but only on real evidence');
// ══════════════════════════════════════════════════════════════════════════
{
    let firedAt = null;
    for (let i = 1; i <= 25; i++) {
        await learn.observe(outcome('Wa Only Ltd',
            { mins: 30, via: 'whatsapp', tried: 'email+whatsapp' }));
        if (!firedAt && learn.profileFor('Wa Only Ltd').set_aside.length) firedAt = i;
        if (i === 5) {
            ck('five one-sided outcomes is NOT enough to write a channel off',
               learn.profileFor('Wa Only Ltd').set_aside.length === 0,
               JSON.stringify(learn.profileFor('Wa Only Ltd').arms));
        }
    }
    ck('sustained evidence eventually sets the dead channel aside', firedAt !== null,
       'if this never fires the whole mechanism is dead code');
    ck('  and it took real evidence to do it', firedAt > 10, `fired after ${firedAt}`);
    const prof = learn.profileFor('Wa Only Ltd');
    ck('  it is email that was set aside', prof.set_aside.includes('email'), JSON.stringify(prof.set_aside));
    ck('  the working one is kept', !prof.set_aside.includes('whatsapp'));

    // ── A CARRIER THAT WAS GOOD AND GOES BAD ─────────────────────────
    // THIS is what recency discounting is FOR, and the check that catches
    // its removal. Reliable Ltd answers on email for twenty pickups, then
    // the dispatcher changes and it never answers there again. Without the
    // gamma decay those old successes stay on the books forever and the
    // channel is never set aside — the carrier is judged on last year.
    for (let i = 1; i <= 20; i++) {
        await learn.observe(outcome('Reliable Ltd',
            { mins: 25, via: 'email reply', tried: 'email+whatsapp' }));
    }
    const good = learn.profileFor('Reliable Ltd');
    ck('a reliable email carrier is not set aside', !good.set_aside.includes('email'),
       JSON.stringify(good.arms.email));

    // 50, not 25, and that is the honest number: a carrier with twenty good
    // outcomes earns the benefit of the doubt, and gamma=0.92 gives it about
    // forty-five reversals before the posterior gives up on them. Slow is
    // the right direction to be wrong in when the action is "stop mailing
    // this address".
    for (let i = 1; i <= 50; i++) {
        await learn.observe(outcome('Reliable Ltd',
            { mins: 25, via: 'whatsapp', tried: 'email+whatsapp' }));
    }
    const gone = learn.profileFor('Reliable Ltd');
    ck('  but when it STOPS working, the old successes fade',
       gone.arms.email.mean < good.arms.email.mean,
       `${good.arms.email.mean} -> ${gone.arms.email.mean} — without recency discounting this never falls`);
    ck('  and it falls a long way, not a rounding amount',
       gone.arms.email.mean < good.arms.email.mean / 2,
       `${good.arms.email.mean} -> ${gone.arms.email.mean}`);
    ck('  and it is eventually set aside despite a good history',
       gone.set_aside.includes('email'), JSON.stringify(gone.arms));

    // A carrier that answers on both must never have either set aside.
    for (let i = 1; i <= 25; i++) {
        await learn.observe(outcome('Mixed Freight',
            { mins: 30, via: i % 2 ? 'email reply' : 'whatsapp', tried: 'email+whatsapp' }));
    }
    ck('a carrier who answers on BOTH keeps both',
       learn.profileFor('Mixed Freight').set_aside.length === 0,
       JSON.stringify(learn.profileFor('Mixed Freight').arms));
}

// ══════════════════════════════════════════════════════════════════════════
section('G — EXPLORATION NEVER REACHES ZERO. The old defect\'s gravestone');
// ══════════════════════════════════════════════════════════════════════════
// The first version dropped a channel permanently and so could never learn
// that it had started working again. This is the check that it cannot
// happen twice.
{
    const prof = learn.profileFor('Wa Only Ltd');
    const ch = { email: 'a@b.example', whatsapp: '+1555', reachable: true };

    // rng returns 1 → above any epsilon → exploit.
    const exploit = learn.adaptChannels(ch, prof, { rng: () => 1 });
    ck('exploiting, the set-aside channel is not used',
       exploit.email === null && exploit.whatsapp === '+1555', JSON.stringify(exploit));
    ck('  and it says which it quieted', (exploit.set_aside || []).includes('email'));

    // rng returns 0 → below any epsilon → explore.
    const explore = learn.adaptChannels(ch, prof, { rng: () => 0 });
    ck('EXPLORING, the set-aside channel is tried anyway',
       explore.email === 'a@b.example', JSON.stringify(explore));
    ck('  and it says it is exploring, so the cost is visible',
       (explore.exploring || []).includes('email'), JSON.stringify(explore.exploring));

    ck('the exploration rate never decays to zero',
       learn.exploreRate(prof, 'email') >= learn.EXPLORE_FLOOR,
       String(learn.exploreRate(prof, 'email')));
    ck('  not even with overwhelming evidence',
       learn.exploreRate({ arms: { email: { evidence: 10000 } } }, 'email') >= learn.EXPLORE_FLOOR);
    ck('  and it is lower for a carrier it is sure about than for a new one',
       learn.exploreRate({ arms: { email: { evidence: 20 } } }, 'email')
       < learn.exploreRate({ arms: { email: { evidence: 0 } } }, 'email'));

    // ── AND THE RECOVERY ACTUALLY HAPPENS ────────────────────────────────
    // Email starts working again. The posterior must climb back and the
    // channel come off the set-aside list — the thing the old version could
    // never do.
    for (let i = 1; i <= 12; i++) {
        await learn.observe(outcome('Wa Only Ltd',
            { mins: 15, via: 'email reply', tried: 'email+whatsapp' }));
    }
    const back = learn.profileFor('Wa Only Ltd');
    ck('a channel that starts working again is RECOVERED',
       !back.set_aside.includes('email'), JSON.stringify(back.arms));
    ck('  because the posterior decays toward the prior and re-learns',
       back.arms.email.mean > prof.arms.email.mean,
       `${prof.arms.email.mean} -> ${back.arms.email.mean}`);
}

// ══════════════════════════════════════════════════════════════════════════
section('H — bounds the policy may never cross');
// ══════════════════════════════════════════════════════════════════════════
{
    const prof = learn.profileFor('Mixed Freight');
    const forced = Object.assign({}, prof, { set_aside: ['email', 'whatsapp'] });
    const both = learn.adaptChannels({ email: 'a@b.example', whatsapp: '+1', reachable: true },
        forced, { rng: () => 1 });
    ck('it will never set aside BOTH channels',
       both.email === 'a@b.example' && both.whatsapp === '+1', JSON.stringify(both));

    const onlyEmail = learn.adaptChannels({ email: 'a@b.example', whatsapp: null, reachable: true },
        Object.assign({}, prof, { set_aside: ['email'] }), { rng: () => 1 });
    ck('  nor the last one standing', onlyEmail.email === 'a@b.example' && onlyEmail.reachable);

    // Her rule is not up for learning.
    for (let i = 0; i < 6; i++) await learn.observe(outcome('Ghost Logistics', { mins: null }));
    const ghost = learn.profileFor('Ghost Logistics');
    ck('a carrier that never answers is known to never answer', ghost.never_answers === true,
       JSON.stringify(ghost));
    const g = live('Ghost Logistics');
    ck('  it is STILL chased — learning does not remove a rung',
       agent.nextAction(g, la(11), { profile: ghost }).step === 'chase',
       '"Chase twice, then tell the team" is hers');
    const two = Object.assign({}, g, { sent: g.sent.concat([{ step: 'chase', at: new Date().toISOString() }]) });
    ck('  and the team is STILL told at 14:00',
       agent.nextAction(two, la(14), { profile: ghost }).step === 'escalate');
}

// ══════════════════════════════════════════════════════════════════════════
section('I — it cannot be taught the same lesson twice');
// ══════════════════════════════════════════════════════════════════════════
{
    const before = learn.profileFor('Zimex Freight').asks;
    const p = outcome('Zimex Freight', { mins: 25 });
    await learn.observe(p);
    const once = learn.profileFor('Zimex Freight').asks;
    ck('a new outcome counts once', once === before + 1, `${before} -> ${once}`);
    await learn.observe(p); await learn.observe(p);
    ck('  replaying it counts for nothing', learn.profileFor('Zimex Freight').asks === once,
       'the job re-runs hourly; without this one reply would look like ten');
    await learn.observe({ id: 'never', company: 'Zimex Freight', sent: [] });
    ck('a pickup nobody ever asked about teaches nothing',
       learn.profileFor('Zimex Freight').asks === once);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.log('CRASHED: ' + (e && e.stack || e)); process.exit(1); });
