// ── helpers/followUpAgentJob.js — the Follow-up Agent ────────────────────
// Apsara, 2026-11-06: "Have a followup agent", straight after being told
// Jarvis had six and after:
//
//   "if i book a shipment pickup with a logistics company,say pickup arranged
//    @11/05 say on that particular day,it should follow up with the logistic
//    company about the pickup eta na?if no response,it needs to follow up and
//    communicate the same to my team"
//
// So this is the seventh agent, and it is the one that CHASES PEOPLE.
//
// ── IT ONLY DOES PICKUPS TODAY, AND THAT IS DELIBERATE ───────────────────
// "Follow-up Agent" sounds like it should chase everything Jarvis is waiting
// on. It does not, because three chasers already exist and own their ground:
//
//   helpers/claimsAgentJob.js    chases claims, and gets LOUDER with age
//   workflow/quoteRequests.js    chases truckers who have not quoted
//   helpers/paymentFollowups.js  chases payments
//
// Pointing a second agent at any of those would mail the same supplier about
// the same thing twice in one morning, from the same address, which is how a
// supplier starts filtering Jarvis. CLAUDE.md rule 1: a rule that is right
// for one screen landing in code other callers reach. The KINDS registry
// below is the honest way to grow this — when she wants another follow-up
// kind, it is added here and the owner of that ground is retired at the same
// time, in the same commit, as a decision rather than as a duplicate.
//
// ── THE ONE REAL DIFFERENCE FROM THE OTHER SIX ───────────────────────────
// claimsAgentJob's header says it "sends no mail to a supplier" — it chases
// HER. This one mails the logistics company directly, because that is
// precisely what she asked for: "it should follow up with the logistic
// company". That is her instruction and it is the whole point, but it means
// this agent is the only one whose mistakes land in someone else's inbox.
// Everything defensive in helpers/pickupAgent.js exists for that reason.
//
// ── WHAT IT MAY DO ───────────────────────────────────────────────────────
// Ask, chase, escalate, and write what it sent onto the pickup. It never
// changes a pickup's date, company or status, never cancels one, and never
// decides a pickup happened. A truck arriving is a fact from the yard, not
// an inference from silence.
const pickupAgent = require('./pickupAgent');
const pickups = require('./pickups');

// ── THE KINDS THIS AGENT FOLLOWS UP ──────────────────────────────────────
// One entry today. The shape is here so the second one is an entry rather
// than a rewrite, and so the comment above about not duplicating the
// existing chasers has somewhere to live.
const KINDS = {
    pickup: {
        label: 'pickup',
        due: () => pickups.list(),
        decide: (row, now) => pickupAgent.nextAction(row, now),
        channels: (row) => pickupAgent.channelsFor(row),
        message: (row, step) => pickupAgent.messageFor(row, step),
        record: (row, step, detail) => pickups.recordSent(row.id, step, detail),
    },
};

const str = (v) => String(v == null ? '' : v).trim();

// ── run({ sendEmail, sendWhatsapp, sendToTeam, now }) ────────────────────
// Every sender is INJECTED. Nothing in this file knows what a mailbox is,
// which is what lets the whole ladder be driven in a test without a network
// — and, more to the point, lets a test prove that a given pickup causes NO
// send at all. Proving silence is impossible if the sender is hard-wired.
//
// A missing sender is not an error: she may have WhatsApp down, or the
// sender-read token not deployed. The run reports what it could not use
// rather than throwing, because an agent that dies on a missing channel is
// an agent that stops watching everything else too.
async function run(opts = {}) {
    const sendEmail = typeof opts.sendEmail === 'function' ? opts.sendEmail : null;
    const sendWhatsapp = typeof opts.sendWhatsapp === 'function' ? opts.sendWhatsapp : null;
    const sendToTeam = typeof opts.sendToTeam === 'function' ? opts.sendToTeam : null;
    const now = opts.now || null;

    const out = {
        considered: 0, asked: 0, chased: 0, escalated: 0,
        // Named, never silently dropped. Each of these is a pickup that is
        // NOT being watched properly, and she asked for this feature because
        // things were going unwatched quietly.
        unreachable: [], failed: [], skipped: 0,
    };

    for (const kind of Object.values(KINDS)) {
        let rows = [];
        try { rows = kind.due() || []; } catch (e) {
            out.failed.push({ kind: kind.label, why: 'could not be read: ' + (e && e.message) });
            continue;
        }

        for (const row of rows) {
            if (!row || !row.id) continue;
            out.considered += 1;

            let decision;
            try { decision = kind.decide(row, now); } catch (e) {
                out.failed.push({ id: row.id, why: 'decide failed: ' + (e && e.message) });
                continue;
            }
            if (!decision || !decision.step) { out.skipped += 1; continue; }

            const step = decision.step;
            const msg = kind.message(row, step);

            // ── ESCALATION GOES TO HER TEAM, NOT TO THE COMPANY ──────────
            // Different recipient, different wording, and it must not be
            // able to leak to the carrier: a note saying "someone needs to
            // call them" arriving AT them would be mortifying. Separate
            // branch rather than a flag on the send, so there is no shared
            // path where a wrong argument could cross them over.
            if (step === 'escalate') {
                if (!sendToTeam) {
                    out.failed.push({ id: row.id, why: 'nothing to tell the team with' });
                    continue;
                }
                try {
                    await sendToTeam(`${msg.subject}\n\n${msg.body}`);
                    await kind.record(row, step, { to: 'team' });
                    out.escalated += 1;
                } catch (e) {
                    out.failed.push({ id: row.id, why: 'escalation failed: ' + (e && e.message) });
                }
                continue;
            }

            // ── ASK AND CHASE GO TO THE COMPANY, ON BOTH CHANNELS ────────
            // She chose email AND WhatsApp. Both are attempted; ONE landing
            // is enough to count the rung as sent, because the question has
            // reached them and asking again tomorrow on the other channel
            // would be the duplicate-chase problem.
            const ch = kind.channels(row);
            if (!ch.reachable) {
                out.unreachable.push({ id: row.id, company: str(row.company),
                    container_no: str(row.container_no), why: ch.why });
                continue;
            }

            const landed = [];
            const trouble = [];
            if (ch.email && sendEmail) {
                try {
                    const r = await sendEmail({ to: ch.email, subject: msg.subject,
                        body: msg.body, threadId: str(row.thread_id) || null, pickupId: row.id });
                    landed.push('email');
                    // The reply watch closes this pickup when the carrier
                    // answers, so the thread id is worth keeping the moment
                    // we learn it.
                    if (r && r.threadId && !str(row.thread_id)) {
                        try { await pickups.patch(row.id, { thread_id: String(r.threadId) }, 'follow-up-agent'); }
                        catch (e) { /* the send happened; a lost id is not worth failing over */ }
                    }
                } catch (e) { trouble.push('email: ' + (e && e.message)); }
            }
            if (ch.whatsapp && sendWhatsapp) {
                try {
                    await sendWhatsapp(ch.whatsapp, `${msg.subject}\n\n${msg.body}`);
                    landed.push('whatsapp');
                } catch (e) { trouble.push('whatsapp: ' + (e && e.message)); }
            }

            if (!landed.length) {
                // NOT recorded as sent. The rung has not happened, so the
                // next run must try it again — recording a failed send would
                // bury a pickup nobody ever asked about, which is exactly
                // the behaviour this agent exists to end.
                out.failed.push({ id: row.id, company: str(row.company),
                    why: trouble.join('; ') || 'no channel available to send on' });
                continue;
            }

            try { await kind.record(row, step, { via: landed.join('+') }); }
            catch (e) { out.failed.push({ id: row.id, why: 'sent but not recorded: ' + (e && e.message) }); }

            if (step === 'ask') out.asked += 1;
            else if (step === 'chase') out.chased += 1;
        }
    }
    return out;
}

// ── A LINE FOR THE MORNING BRIEFING ──────────────────────────────────────
// Silent when there is nothing to say. Every other agent in this app that
// speaks daily whether or not anything happened has had to be quietened
// later — helpers/ledgerAgent.js carries a note about exactly that — so it
// starts quiet.
//
// The two things she is told about are the ones a person must act on: a
// pickup with nobody to contact, and a send that failed.
function summarise(result) {
    const r = result || {};
    const bits = [];
    if (r.asked) bits.push(`${r.asked} pickup${r.asked === 1 ? '' : 's'} asked for an ETA`);
    if (r.chased) bits.push(`${r.chased} chased`);
    if (r.escalated) bits.push(`${r.escalated} passed to the team`);
    const lines = bits.length ? ['Follow-ups: ' + bits.join(' · ')] : [];
    for (const u of (r.unreachable || [])) {
        lines.push(`No way to reach ${u.company || 'a carrier'} about ${u.container_no || 'a pickup'} — ${u.why}`);
    }
    for (const f of (r.failed || [])) {
        lines.push(`Follow-up failed${f.company ? ' for ' + f.company : ''}: ${f.why}`);
    }
    return lines.join('\n');
}

module.exports = { run, summarise, KINDS };
