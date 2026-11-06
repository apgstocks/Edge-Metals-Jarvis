// ── tests/pickup-agent.js ─────────────────────────────────────────────────
// Apsara, 2026-11-06:
//   "Boss..what is jarvis doing???it is monitoring all my mails..In case say
//    if i book a shipment pickup with a logistics company,say pickup arranged
//    @11/05 say on that particular day,it should follow up with the logistic
//    company about the pickup eta na? if no response,it needs to follow up and
//    communicate the same to my team"
//
// Asked how it should chase, she chose email AND WhatsApp, and for the
// escalation: "Chase twice, then tell the team."
//
// ── WHAT IS BEING DEFENDED ───────────────────────────────────────────────
// This agent SENDS MAIL IN HER NAME to a company she buys from. Every check
// below is really one of two questions:
//
//   1. does it chase when it should?
//   2. does it SHUT UP when it should?
//
// The second is the one that loses her a supplier relationship. A chaser
// that asks again after being answered, or that mails her team about a
// company it never actually asked, is worse than no chaser — she turns it
// off, and then nothing is watched at all.
//
// Times are LA, because every freight deadline in this app is evaluated in
// America/Los_Angeles. `now` is injected so these can stand at 10:59 and at
// 11:00 without waiting an hour.
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const agent = require(path.join(ROOT, 'helpers/pickupAgent'));

// LA is UTC-8 on this date. LA hour H on 2026-11-06 is UTC H+8 the same day.
const la = (H, day = 6) => new Date(Date.UTC(2026, 10, day, H + 8, 30));
const P = (o) => Object.assign({
    id: 'pk1', company: 'Zimex Freight', container_no: 'TEMU7944250',
    pickup_date: '2026-11-06', status: 'arranged', sent: [],
    contact_email: 'ops@zimex.example',
}, o);
const step = (p, H, day) => agent.nextAction(p, la(H, day)).step;

(() => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the harness is standing where it thinks it is');
// ══════════════════════════════════════════════════════════════════════════
// If this is wrong every other check below is meaningless, which is how a
// whole file of green checks ends up guarding nothing.
{
    const t = agent.laNow(la(8));
    ck('LA 08:30 reads as the 6th at hour 8', t.day === '2026-11-06' && t.hour === 8, JSON.stringify(t));
    const u = agent.laNow(la(23));
    ck('  and LA 23:30 has not rolled into the 7th', u.day === '2026-11-06' && u.hour === 23, JSON.stringify(u));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — the ladder she asked for: ask, chase, then the team');
// ══════════════════════════════════════════════════════════════════════════
{
    ck('nothing goes out before 08:00', step(P(), 7) === null);
    ck('at 08:00 it asks for the ETA', step(P(), 8) === 'ask');
    ck('  and does not ask twice', step(P({ sent: [{ step: 'ask' }] }), 8) === null,
       'a question asked twice in an hour is how a sender gets filtered');

    ck('at 11:00, with no answer, it chases',
       step(P({ sent: [{ step: 'ask' }] }), 11) === 'chase');
    ck('  but not before 11:00', step(P({ sent: [{ step: 'ask' }] }), 10) === null);

    ck('at 14:00, still nothing, the TEAM is told',
       step(P({ sent: [{ step: 'ask' }, { step: 'chase' }] }), 14) === 'escalate');
    ck('  and that is the end of it — the team is told ONCE',
       step(P({ sent: [{ step: 'ask' }, { step: 'chase' }, { step: 'escalate' }] }), 23) === null,
       'an agent that keeps shouting is an agent she mutes');

    // Exactly two asks reach the company, which is what "chase twice" means.
    const toCompany = agent.LADDER.filter((r) => r.step !== 'escalate');
    ck('exactly two rungs go to the logistics company', toCompany.length === 2,
       JSON.stringify(agent.LADDER.map((r) => r.step)));
}

// ══════════════════════════════════════════════════════════════════════════
section('C — the silences: when it must NOT send');
// ══════════════════════════════════════════════════════════════════════════
// Each of these is a way to annoy a company she depends on.
{
    ck('a pickup booked for tomorrow is not chased today',
       step(P({ pickup_date: '2026-11-07' }), 14) === null,
       'a truck booked for the 7th is not late on the 6th');

    ck('once an ETA is given, the asking stops',
       step(P({ eta: '3pm', sent: [{ step: 'ask' }] }), 14) === null);
    ck('  a confirmation with no time stops it too',
       step(P({ confirmed_at: '2026-11-06T09:02:00Z', sent: [{ step: 'ask' }] }), 14) === null);

    for (const s of agent.CLOSED) {
        ck(`a ${s} pickup is left alone`, step(P({ status: s }), 14) === null);
    }

    ck('a pickup with no readable date is never chased',
       step(P({ pickup_date: '' }), 14) === null,
       'guessing a date here would chase a company about nothing');
    ck('  and nor is one with a date Jarvis cannot parse',
       step(P({ pickup_date: 'next tuesday' }), 14) === null);
}

// ══════════════════════════════════════════════════════════════════════════
section('D — the job was down all morning');
// ══════════════════════════════════════════════════════════════════════════
// THE CHECK I MOST WANT TO BE TRUE. pm2 restarts, the VM reboots, the cron
// slot is missed. If the agent simply fires whatever rung the clock says, it
// mails her team at 14:00 that Zimex has not answered — about a question
// Jarvis never asked. That is indefensible: it accuses a supplier of
// silence Jarvis caused.
{
    const r = agent.nextAction(P(), la(14));
    ck('waking at 14:00 with nothing sent, it ASKS first', r.step === 'ask', r.step);
    ck('  and says it is catching up', r.caughtUp === true, JSON.stringify(r));
    ck('  it does NOT escalate about a company it never asked',
       r.step !== 'escalate',
       'this would accuse the carrier of ignoring a mail that was never sent');

    // Having asked late, the next rungs still follow in order.
    const after = agent.nextAction(P({ sent: [{ step: 'ask' }] }), la(14));
    ck('  the chase comes next, not the escalation', after.step === 'chase', after.step);
}

// ══════════════════════════════════════════════════════════════════════════
section('E — the day has passed and nobody ever answered');
// ══════════════════════════════════════════════════════════════════════════
{
    const missed = P({ pickup_date: '2026-11-05', sent: [{ step: 'ask' }, { step: 'chase' }] });
    const r = agent.nextAction(missed, la(9));
    ck('a pickup day that passed with no ETA reaches the team', r.step === 'escalate', r.step);
    ck('  and is marked overdue', r.overdue === true, JSON.stringify(r));
    ck('  but only once, not every morning afterwards',
       agent.nextAction(P({ pickup_date: '2026-11-05', sent: [{ step: 'escalate' }] }), la(9)).step === null,
       'a daily reminder about last week is noise she will filter');
    // The company is NOT chased after its day. That conversation has moved
    // to a phone call between people.
    ck('  and the company is not chased the next day',
       !['ask', 'chase'].includes(String(agent.nextAction(missed, la(9)).step)));
}

// ══════════════════════════════════════════════════════════════════════════
section('F — both dates formats, because there are two entry points');
// ══════════════════════════════════════════════════════════════════════════
// She chose BOTH "Jarvis arranges it" and "I record it". Those two will not
// agree on a date format — bookings.json is MM/DD/YYYY, computed dates are
// YYYY-MM-DD — and a pickup silently dropped over a slash is precisely the
// silent-skip failure this feature exists to end.
{
    ck('YYYY-MM-DD is understood', step(P({ pickup_date: '2026-11-06' }), 8) === 'ask');
    ck('MM/DD/YYYY is understood too', step(P({ pickup_date: '11/06/2026' }), 8) === 'ask');
    ck('  single-digit month and day as well', agent.isoDay('1/6/2026') === '2026-01-06',
       agent.isoDay('1/6/2026'));
    ck('  and an ISO timestamp keeps its day', agent.isoDay('2026-11-06T17:00:00Z') === '2026-11-06');
}

// ══════════════════════════════════════════════════════════════════════════
section('G — a pickup it cannot reach is REPORTED, never skipped');
// ══════════════════════════════════════════════════════════════════════════
// The whole complaint was that things go unwatched quietly. A pickup with no
// contact must not become the new silent gap.
{
    const none = agent.channelsFor({ company: 'Zimex Freight' });
    ck('no email and no WhatsApp is not reachable', none.reachable === false);
    ck('  and it says so, naming the company', /Zimex Freight/.test(none.why || ''), none.why);

    const mail = agent.channelsFor({ contact_email: 'ops@zimex.example' });
    ck('an email alone is reachable', mail.reachable === true && mail.email === 'ops@zimex.example');
    const wa = agent.channelsFor({ contact_whatsapp: '+15550001111' });
    ck('a WhatsApp number alone is reachable', wa.reachable === true && wa.whatsapp === '+15550001111');
    const both = agent.channelsFor({ contact_email: 'a@b.c', contact_whatsapp: '+1555' });
    ck('  and both are carried, because she asked for both',
       both.email === 'a@b.c' && both.whatsapp === '+1555', JSON.stringify(both));
}

// ══════════════════════════════════════════════════════════════════════════
section('H — what the messages actually say');
// ══════════════════════════════════════════════════════════════════════════
// These leave the building. "Any update?" makes the reader go and work out
// which job it is, which is how a chase gets put off until tomorrow.
{
    const p = P({ location: 'the yard' });
    const ask = agent.messageFor(p, 'ask');
    ck('the first ask names the container', /TEMU7944250/.test(ask.body), ask.body);
    ck('  and the date', /2026-11-06/.test(ask.body));
    ck('  and asks for the ETA in plain words', /ETA/.test(ask.body));
    ck('  without shouting on the first ask', !/urgent|immediately|ASAP/i.test(ask.body), ask.body);

    const chase = agent.messageFor(p, 'chase');
    ck('the chase refers to the earlier note', /[Ff]ollowing up/.test(chase.body), chase.body);
    ck('  and threads off the first subject', /^Re: /.test(chase.subject), chase.subject);

    // ── THE ESCALATION IS TO HER TEAM, ABOUT THE COMPANY ─────────────────
    const esc = agent.messageFor(P({ sent: [{ step: 'ask' }, { step: 'chase' }] }), 'escalate');
    ck('the escalation names the company that went quiet', /Zimex Freight/.test(esc.body), esc.body);
    ck('  says how many times Jarvis asked, so nobody re-reads the thread',
       /asked 2 times/.test(esc.body), esc.body);
    ck('  and asks a PERSON to act', /call them/i.test(esc.body), esc.body);
    // It must not be written as if it were going to the carrier.
    ck('  it does not address the carrier', !/^Good morning/.test(esc.body), esc.body);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})();
