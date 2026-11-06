// ── tests/follow-up-agent.js ──────────────────────────────────────────────
// Apsara, 2026-11-06: "Have a followup agent".
//
// The seventh agent, and the only one that mails a company she buys from.
// helpers/claimsAgentJob.js says in its own header that it "sends no mail to
// a supplier" — it chases HER. This one chases THEM, because that is exactly
// what she asked for: "it should follow up with the logistic company".
//
// ── THIS DRIVES THE REAL THING ───────────────────────────────────────────
// A real store on disk, the real agent, the real decision engine, a whole
// day walked hour by hour. The senders are fakes — not to avoid the network,
// but because that is the ONLY way to prove a send did NOT happen. A hard
// wired sender can be shown to work; it can never be shown to stay quiet.
//
// Half of these checks are that it stayed quiet.
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.JARVIS_TEST = '1';
const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'followup-'));
const cfg = require(path.join(ROOT, 'config'));
cfg.DATA_DIR = dir;
cfg.PICKUPS_FILE = path.join(dir, 'pickups.json');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const pickups = require(path.join(ROOT, 'helpers/pickups'));
const job = require(path.join(ROOT, 'helpers/followUpAgentJob'));

// LA is UTC-8 in November.
const la = (H, day = 6) => new Date(Date.UTC(2026, 10, day, H + 8, 30));

// A recording set of senders. Every run gets a fresh one so "it sent
// nothing" is a statement about THIS run.
function senders(opts = {}) {
    const sent = { email: [], whatsapp: [], team: [] };
    return {
        sent,
        sendEmail: opts.noEmail ? null : async (m) => {
            if (opts.emailThrows) throw new Error('smtp is down');
            sent.email.push(m); return { threadId: 'thr_' + sent.email.length };
        },
        sendWhatsapp: opts.noWa ? null : async (to, text) => {
            if (opts.waThrows) throw new Error('whatsapp session dead');
            sent.whatsapp.push({ to, text });
        },
        sendToTeam: opts.noTeam ? null : async (text) => { sent.team.push(text); },
    };
}
const runAt = async (H, day, o = {}) => {
    const s = senders(o);
    const r = await job.run({ sendEmail: s.sendEmail, sendWhatsapp: s.sendWhatsapp,
        sendToTeam: s.sendToTeam, now: la(H, day) });
    return { r, sent: s.sent };
};

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the record that did not exist until today');
// ══════════════════════════════════════════════════════════════════════════
{
    const p = await pickups.create({
        company: 'Zimex Freight', pickup_date: '2026-11-06',
        container_no: 'temu7944250', location: 'the yard',
        contact_email: 'ops@zimex.example', contact_whatsapp: '+15550001111',
    }, 'apsara');
    ck('a pickup can be recorded at all', !!p.id, JSON.stringify(p).slice(0, 80));
    ck('  container numbers are stored upper case', p.container_no === 'TEMU7944250', p.container_no);
    ck('  it starts as arranged, with nothing sent', p.status === 'arranged' && p.sent.length === 0);
    ck('  and it survives a reload from disk', (pickups.get(p.id) || {}).company === 'Zimex Freight');

    // The two things the agent cannot work without. Refused at the door with
    // a sentence that says WHY, because "invalid input" sends her guessing.
    let e1 = null; try { await pickups.create({ pickup_date: '2026-11-06' }); } catch (e) { e1 = e; }
    ck('a pickup with no company is refused', !!e1 && /nobody to ask/.test(e1.message), e1 && e1.message);
    let e2 = null; try { await pickups.create({ company: 'X' }); } catch (e) { e2 = e; }
    ck('  and one with no date', !!e2 && /no day to chase/.test(e2.message), e2 && e2.message);
}

// ══════════════════════════════════════════════════════════════════════════
section('B — a whole day, hour by hour, through the real agent');
// ══════════════════════════════════════════════════════════════════════════
{
    const early = await runAt(7);
    ck('07:00 — nothing is sent to anyone',
       early.sent.email.length === 0 && early.sent.whatsapp.length === 0 && early.sent.team.length === 0,
       JSON.stringify(early.r));

    const morning = await runAt(8);
    ck('08:00 — the carrier is asked for an ETA', morning.r.asked === 1, JSON.stringify(morning.r));
    ck('  on BOTH channels, as she chose',
       morning.sent.email.length === 1 && morning.sent.whatsapp.length === 1,
       JSON.stringify({ e: morning.sent.email.length, w: morning.sent.whatsapp.length }));
    ck('  the email names the container', /TEMU7944250/.test(morning.sent.email[0].body));
    ck('  it went to the carrier, not to her team',
       morning.sent.email[0].to === 'ops@zimex.example' && morning.sent.team.length === 0);
    ck('  and the thread id is kept, so a reply can close it',
       /^thr_/.test((pickups.list()[0] || {}).thread_id || ''), (pickups.list()[0] || {}).thread_id);

    const again = await runAt(9);
    ck('09:00 — it does NOT ask again',
       again.sent.email.length === 0 && again.sent.whatsapp.length === 0,
       'asking twice in an hour is how a sender gets filtered');

    const chase = await runAt(11);
    ck('11:00 — still no answer, so it chases', chase.r.chased === 1, JSON.stringify(chase.r));
    ck('  and the chase refers back', /[Ff]ollowing up/.test(chase.sent.email[0].body), chase.sent.email[0].body);
    ck('  the team has STILL not been bothered', chase.sent.team.length === 0);

    const esc = await runAt(14);
    ck('14:00 — the team is told', esc.r.escalated === 1 && esc.sent.team.length === 1, JSON.stringify(esc.r));
    ck('  the escalation names the company', /Zimex Freight/.test(esc.sent.team[0]), esc.sent.team[0]);
    ck('  and says Jarvis asked twice first', /asked 2 times/.test(esc.sent.team[0]), esc.sent.team[0]);
    // ── THE ONE THAT WOULD BE MORTIFYING ─────────────────────────────────
    // "Someone needs to call them" arriving AT the carrier.
    ck('  NOTHING went to the carrier on the escalation',
       esc.sent.email.length === 0 && esc.sent.whatsapp.length === 0,
       'a note telling her team to chase them must never reach them');

    const after = await runAt(16);
    ck('16:00 — it has finished; nothing more goes out',
       after.sent.email.length === 0 && after.sent.team.length === 0,
       'an agent that keeps shouting is an agent she mutes');
}

// ══════════════════════════════════════════════════════════════════════════
section('C — the carrier answers, and everything stops');
// ══════════════════════════════════════════════════════════════════════════
{
    const p = await pickups.create({ company: 'AJ Transport', pickup_date: '2026-11-06',
        container_no: 'HMMU6180208', contact_email: 'dispatch@aj.example' }, 'jarvis');
    const asked = await runAt(8);
    ck('a second pickup is asked on its own day', asked.r.asked === 1, JSON.stringify(asked.r));

    // Free text on purpose: carriers say "around 2pm", not an ISO timestamp.
    await pickups.recordEta(p.id, 'driver leaves at 2pm');
    const q = await runAt(11);
    ck('once an ETA is recorded, it is never chased again', q.r.chased === 0, JSON.stringify(q.r));
    const q2 = await runAt(14);
    ck('  and the team is never told about it', q2.sent.team.length === 0);
    ck('  the ETA is kept in the carrier\'s own words',
       (pickups.get(p.id) || {}).eta === 'driver leaves at 2pm');
}

// ══════════════════════════════════════════════════════════════════════════
section('D — a pickup it cannot reach is REPORTED, never dropped');
// ══════════════════════════════════════════════════════════════════════════
// This is the whole complaint in one check. Something unwatched must be
// NOTICED as unwatched.
{
    await pickups.create({ company: 'Nobody Logistics', pickup_date: '2026-11-06',
        container_no: 'KOCU5251324' }, 'apsara');
    const r = await runAt(8);
    ck('it is not quietly skipped', r.r.unreachable.length === 1, JSON.stringify(r.r.unreachable));
    ck('  the report names the company', /Nobody Logistics/.test(r.r.unreachable[0].company));
    ck('  and the briefing line says so', /No way to reach Nobody Logistics/.test(job.summarise(r.r)),
       job.summarise(r.r));
    ck('  nothing was invented to send to', r.sent.email.length === 0 && r.sent.whatsapp.length === 0);
}

// ══════════════════════════════════════════════════════════════════════════
section('E — when the sending itself fails');
// ══════════════════════════════════════════════════════════════════════════
{
    const p = await pickups.create({ company: 'Flaky Freight', pickup_date: '2026-11-07',
        container_no: 'TCNU1187745', contact_email: 'ops@flaky.example' }, 'apsara');

    const broke = await runAt(8, 7, { emailThrows: true });
    ck('a failed send is reported', broke.r.failed.some((f) => f.id === p.id), JSON.stringify(broke.r.failed));
    // ── THE IMPORTANT HALF ───────────────────────────────────────────────
    // Recording a rung that never left would bury this pickup forever: the
    // agent would think it had asked, and nobody would ever be asked.
    ck('  and is NOT recorded as sent', (pickups.get(p.id).sent || []).length === 0,
       JSON.stringify(pickups.get(p.id).sent));
    const retry = await runAt(9, 7);
    ck('  so the next run tries again', retry.sent.email.length === 1, JSON.stringify(retry.r));

    // One channel landing is enough. The question has reached them.
    const p2 = await pickups.create({ company: 'Half Freight', pickup_date: '2026-11-08',
        contact_email: 'a@b.example', contact_whatsapp: '+1555' }, 'apsara');
    const half = await runAt(8, 8, { waThrows: true });
    ck('WhatsApp failing does not stop an email that landed',
       half.sent.email.length === 1 && half.r.asked === 1, JSON.stringify(half.r));
    ck('  and the rung counts as done', (pickups.get(p2.id).sent || []).length === 1);
}

// ══════════════════════════════════════════════════════════════════════════
section('F — the agent survives its channels being gone');
// ══════════════════════════════════════════════════════════════════════════
// She may have WhatsApp down or a token undeployed. An agent that throws
// there stops watching everything else too.
{
    const p = await pickups.create({ company: 'Mute Freight', pickup_date: '2026-11-09',
        contact_email: 'x@y.example' }, 'apsara');
    let threw = null;
    let out = null;
    try { out = await job.run({ now: la(8, 9) }); } catch (e) { threw = e; }
    ck('running with NO senders at all does not throw', !threw, threw && threw.message);
    ck('  it reports the pickup it could not act on', !!out && out.failed.length > 0,
       JSON.stringify(out && out.failed));
    ck('  and records nothing as sent', (pickups.get(p.id).sent || []).length === 0);
}

// ══════════════════════════════════════════════════════════════════════════
section('G — it is quiet when there is nothing to say');
// ══════════════════════════════════════════════════════════════════════════
// Every daily-speaking agent in this app has had to be quietened later.
// This one starts quiet.
{
    ck('an empty run produces no briefing line',
       job.summarise({ considered: 3, asked: 0, chased: 0, escalated: 0, unreachable: [], failed: [] }) === '',
       JSON.stringify(job.summarise({ considered: 3, asked: 0, chased: 0, escalated: 0, unreachable: [], failed: [] })));
    ck('  but work done IS reported',
       /2 pickups asked for an ETA/.test(job.summarise({ asked: 2, unreachable: [], failed: [] })),
       job.summarise({ asked: 2, unreachable: [], failed: [] }));
}

// ══════════════════════════════════════════════════════════════════════════
section('H — it does not trespass on the chasers that already exist');
// ══════════════════════════════════════════════════════════════════════════
// claimsAgentJob chases claims, quoteRequests chases quotes,
// paymentFollowups chases payments. A second agent mailing the same supplier
// about the same thing on the same morning is how Jarvis gets filtered.
{
    const kinds = Object.keys(job.KINDS);
    ck('it follows up exactly one kind today', kinds.length === 1 && kinds[0] === 'pickup',
       kinds.join(','));
    const src = fs.readFileSync(path.join(ROOT, 'helpers/followUpAgentJob.js'), 'utf8');
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const owned of ['claimsAgent', 'quoteRequests', 'paymentFollowups']) {
        ck(`  it does not reach into ${owned}`, !new RegExp(owned).test(code),
           'that ground has an owner; two chasers means two mails');
    }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.log('CRASHED: ' + (e && e.stack || e)); process.exit(1); });
