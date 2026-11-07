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
//   helpers/paymentFollowups.js  chases payments   (2026-11-07: now the DRAFT SOURCE for
//                                                    the payment half below, which is
//                                                    this agent's and tells HER, never
//                                                    the customer - see paymentChaser.js)
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
        // ── ADAPTED, NEVER REPLACED ──────────────────────────────────
        // pickupAgent decides; learning only tunes WHEN and HOW. It cannot
        // remove a rung, stop the ask, or move the escalation off the day —
        // "Chase twice, then tell the team" is hers and stands.
        decide: (row, now) => pickupAgent.nextAction(row, now,
            { profile: safeProfile(row.company) }),
        channels: (row) => require('./pickupLearn')
            .adaptChannels(pickupAgent.channelsFor(row), safeProfile(row.company)),
        message: (row, step) => pickupAgent.messageFor(row, step),
        record: (row, step, detail) => pickups.recordSent(row.id, step, detail),
    },
};

const str = (v) => String(v == null ? '' : v).trim();

// Learning is an improvement, never a dependency. A store that cannot be
// read leaves the agent behaving exactly as it did before any of this —
// which is also what a brand new carrier gets.
function safeProfile(company) {
    try { return require('./pickupLearn').profileFor(company); } catch (e) { return null; }
}

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
    const sendToManager = typeof opts.sendToManager === 'function' ? opts.sendToManager : null;
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
                    // ── THE REWARD SIGNAL, AT THE MOMENT IT IS FINAL ─────
                    // Escalating means the day ended with no answer. That is
                    // the negative outcome, and it is as much of a lesson as
                    // a fast reply: it is what eventually retires a channel
                    // this carrier never reads.
                    try { await require('./pickupLearn').observe(pickups.get(row.id) || row); }
                    catch (e) { /* learning must never cost her an escalation */ }
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
                        body: msg.body,
                        threadId: str(row.thread_id) || null,
                        // "follow up should happen in corresponding email
                        // thread only" — the carrier's client threads on
                        // this, not on Gmail's id.
                        messageId: str(row.last_message_id) || null,
                        pickupId: row.id });
                    landed.push('email');
                    // The reply watch closes this pickup when the carrier
                    // answers, so the thread id is worth keeping the moment
                    // we learn it — and the Message-ID, so the NEXT rung
                    // replies to this one rather than starting again.
                    const keep = {};
                    if (r && r.threadId && !str(row.thread_id)) keep.thread_id = String(r.threadId);
                    if (r && r.messageId) keep.last_message_id = String(r.messageId);
                    if (Object.keys(keep).length) {
                        try { await pickups.patch(row.id, keep, 'follow-up-agent'); }
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
    // ── CUSTOMER PAYMENTS (2026-11-07) ───────────────────────────────────
    // After the pickups and walled off from them: whatever happens here, a pickup rung
    // has already fired, and a failure here is reported rather than thrown.
    try { out.payments = await runPayments({ sendToManager, sendToTeam, now: opts.now, drafts: opts.paymentDrafts, findRemittance: opts.findRemittance, stageCustomerEmail: opts.stageCustomerEmail, qbSurvey: opts.qbSurvey, findDeposit: opts.findDeposit, askAboutHold: opts.askAboutHold }); }
    catch (e) { out.payments = { asked: 0, chased: 0, escalated: 0, failed: [{ why: 'payment follow-ups could not run: ' + (e && e.message) }] }; }
    return out;
}

// ── THE PAYMENT HALF ─────────────────────────────────────────────────────
// Drafts only; this never contacts a customer (see helpers/paymentChaser.js). One batched
// message to her for the asks and chases, one to the team per escalation. A rung is
// recorded only AFTER the message went, so a failed send is retried next run rather than
// buried.
async function runPayments({ sendToManager, sendToTeam, now, drafts, findRemittance, stageCustomerEmail, qbSurvey, findDeposit, askAboutHold }) {
    const res = { asked: 0, chased: 0, escalated: 0, held: 0, staged: 0, failed: [] };
    if (String(process.env.PAYMENT_CHASE || '').toLowerCase() === 'off') return { ...res, off: true };
    const chaser = require('./paymentChaser');
    const t = now ? new Date(now).getTime() : Date.now();
    let list = drafts;
    if (!list) list = require('./paymentFollowups').build({ now: t }).drafts;
    const log = chaser.prune(chaser.readLog(), list);

    // QUICKBOOKS DECIDES WHO OWES (Apsara, 2026-11-07). Jarvis's ledger has no payments in it (Rad Metal: 96 sales, 0 receipts,
    // "$4.78M open", a customer who always pays), so when a survey is supplied nothing is followed up unless QuickBooks shows the
    // invoice open. FAILS CLOSED: if QuickBooks cannot be read, nobody is followed up and she is told once a week.
    if (typeof qbSurvey === 'function') {
        const truth = require('./paymentTruth');
        const note = async (text, key) => {
            const last = log[key] ? Date.parse(log[key].at) : 0;
            if (sendToManager && (!last || t - last > 7 * 86400000)) {
                try { await sendToManager(text); log[key] = { at: new Date(t).toISOString() }; await chaser.writeLog(log); }
                catch (e) { res.failed.push({ why: 'could not tell her: ' + (e && e.message) }); }
            }
        };
        let sv = null;
        try { sv = await qbSurvey(); } catch (e) { sv = null; res.qb_error = (e && e.message) || 'unreadable'; }
        if (!sv) {
            await note('Payment follow-ups are paused: I cannot read QuickBooks (' + (res.qb_error || 'no data') + '), and I will not chase anyone without confirming they owe. Nobody was contacted.', '_qbdown');
            return { ...res, paused: true };
        }
        const rec = truth.reconcile(list, sv);
        list = rec.drafts; res.skipped = rec.skipped.length;
        for (const sk of rec.skipped) delete log[chaser.keyOf(sk.customer)];     // forgotten, so a real balance starts with a fresh first note
        const line = truth.skippedLine(rec.skipped);
        if (line) await note(line, '_qbskip');
    }

    // SEND MODE ONLY. Apsara, 2026-11-07, on the first live run: a 52-line "draft ready (no email on file)" wall. A customer
    // with no address cannot be emailed, so listing each one every run is noise and the list is already on the Payment
    // follow-ups screen. They are left out of the ladder (and forgotten from the log, so once an address is added they start
    // with a fresh first note) and mentioned in ONE line, at most once a week.
    if (typeof stageCustomerEmail === 'function' && String(process.env.PAYMENT_CHASE_SEND || '').toLowerCase() !== 'off') {
        const noAddr = list.filter((d) => !chaser.hasAddress(d) && d.total > 0.005 && !chaser.isLcDraft(d));
        for (const d of noAddr) delete log[chaser.keyOf(d.customer)];
        list = list.filter((d) => chaser.hasAddress(d) || chaser.isLcDraft(d) || !(d.total > 0.005));
        const last = log._noaddr ? Date.parse(log._noaddr.at) : 0;
        if (noAddr.length && sendToManager && (!last || t - last > 7 * 86400000)) {
            const top = [...noAddr].sort((a, b) => b.total - a.total).slice(0, 3).map((d) => `${d.customer} (${chaser.money(d.total)})`).join(', ');
            const sum = noAddr.reduce((a, d) => a + d.total, 0);
            try {
                await sendToManager(`${noAddr.length} customer${noAddr.length === 1 ? ' has' : 's have'} open invoices (${chaser.money(sum)} in all) but no email address on file, so I can't draft follow-ups for ${noAddr.length === 1 ? 'them' : 'them'}. Add the address${noAddr.length === 1 ? '' : 'es'} in the address book and ${noAddr.length === 1 ? 'they' : 'they'}'ll be picked up automatically. Largest: ${top}.`);
                log._noaddr = { at: new Date(t).toISOString() };
                await chaser.writeLog(log);
            } catch (e) { res.failed.push({ why: 'could not tell her about customers without an address: ' + (e && e.message) }); }
        }
    }
    let todo = chaser.plan(list, log, t);

    // Mail from the customer that looks like proof of payment HOLDS the follow-up and tells her to look (Apsara, 2026-11-07).
    // Read-only: nothing is marked paid. A hold lapses after HOLD_DAYS if no receipt has been recorded, then the ladder resumes.
    const heldNotes = []; let newHolds = 0;
    if ((typeof findRemittance === 'function' || typeof findDeposit === 'function') && todo.length) {
        const HOLD_MS = require('./remittanceMail').HOLD_DAYS * 86400000;
        const keep = [];
        for (const x of todo) {
            const entry = log[x.key];
            const held = entry && entry.held;
            // dismissed by her ("no, not theirs") or lapsed; a hold she CONFIRMED lasts until its own date (30 days).
            const stale = held && (held.dismissed || (held.promisedUntil ? t > held.promisedUntil : held.confirmed ? t > (held.until || 0) : (t - held.at) > HOLD_MS));
            let hit = null;
            try {
                const since = entry && entry.firstAt ? Date.parse(entry.firstAt) : t - 45 * 86400000;
                const opts = { sinceMs: since, ignoreId: stale ? held.id : undefined };
                if (typeof findRemittance === 'function') hit = await findRemittance(x.draft, opts);
                // The bank feed too (Apsara, 2026-11-07: "You have Plaid as well"): money that has already ARRIVED but is not matched yet.
                if (!hit && typeof findDeposit === 'function') hit = await findDeposit(x.draft, opts);
            } catch (e) { hit = null; }
            if (!hit) { keep.push(x); continue; }
            res.held += 1;
            if (!held || held.id !== hit.id) {
                log[x.key] = { ...(entry || { set: null, firstAt: new Date(t).toISOString(), lastStep: null, lastAt: null, customer: x.draft.customer }), held: { id: hit.id, at: hit.dateMs || t } };
                newHolds += 1;
                // A PROMISE: the mail states when they will pay. Recorded (inside the company, undoable by the log), the follow-up waits
                // until the day after, and she is told in one line. No question needed - nothing external happens.
                if (hit.promisedOn) {
                    log[x.key].held.promisedUntil = Date.parse(hit.promisedOn + 'T23:59:59Z');
                    log[x.key].held.promisedOn = hit.promisedOn;
                    heldNotes.push(`${x.draft.customer} \u2014 ${chaser.money(x.draft.total)} open: they wrote that they will pay by ${hit.promisedOn.slice(5, 7)}/${hit.promisedOn.slice(8, 10)}${hit.subject ? ' ("' + hit.subject + '")' : ''}. I'll hold their follow-up until then and check again.`);
                    continue;
                }
                // If something may be theirs and she can be asked, ASK (Apsara, 2026-11-07: "if it has any question, ask").
                let asked = false;
                if (typeof askAboutHold === 'function') {
                    try { const q = await askAboutHold({ customer: x.draft.customer, key: x.key, hit, total: x.draft.total, now: t }); asked = !!(q && q.staged); } catch (e) { asked = false; }
                }
                if (!asked) heldNotes.push(hit.kind === 'bank'
                    ? `${x.draft.customer} \u2014 ${chaser.money(x.draft.total)} open: the bank shows a ${hit.subject} that may be theirs. Match it to their invoices; follow-up on hold.`
                    : `${x.draft.customer} \u2014 ${chaser.money(x.draft.total)} open: they emailed something that looks like proof of payment (${hit.subject ? '"' + hit.subject + '"' : 'no subject'}). Check it and record the receipt; follow-up on hold.`);
            }
        }
        todo = keep;
        if (heldNotes.length && sendToManager) {
            try { await sendToManager('Possible payment received:\n' + heldNotes.map((n) => '  \u00b7 ' + n).join('\n')); }
            catch (e) { res.failed.push({ why: 'could not tell her about a possible payment: ' + (e && e.message) }); }
        }
        if (heldNotes.length || newHolds) await chaser.writeLog(log);
    }
    if (!todo.length) { if (JSON.stringify(log) !== JSON.stringify(chaser.readLog())) await chaser.writeLog(log); return res; }

    const told = [];
    // CUSTOMER EMAIL, ONLY AFTER HER YES (Apsara, 2026-11-07: "Ask for my confirmation in whatsapp"). Where a customer has a
    // valid address the draft is staged on WhatsApp as a send-confirmation instead of listed; nothing is sent here. One per
    // run, and only when she has nothing else open - the rest are tried on the next hourly run, unrecorded until she has seen them.
    let toList = todo.filter((x) => x.step !== 'escalate');
    if (typeof stageCustomerEmail === 'function' && String(process.env.PAYMENT_CHASE_SEND || '').toLowerCase() !== 'off') {
        const sendable = toList.filter((x) => chaser.hasAddress(x.draft));
        const rest = toList.filter((x) => !chaser.hasAddress(x.draft));
        let did = false;
        for (const x of sendable) {
            if (did) continue;
            try {
                const r = await stageCustomerEmail(x.draft, x.step);
                if (r && r.staged) { did = true; told.push(x); res.staged += 1; if (x.step === 'ask') res.asked += 1; else res.chased += 1; }
            } catch (e) { res.failed.push({ company: x.draft.customer, why: 'could not stage the email: ' + (e && e.message) }); }
        }
        toList = rest;
    }
    const forMe = toList;
    if (forMe.length) {
        if (!sendToManager) res.failed.push({ why: 'nothing to tell her with (payment follow-ups are waiting)' });
        else {
            const asks = forMe.filter((x) => x.step === 'ask');
            const chases = forMe.filter((x) => x.step === 'chase');
            const parts = [];
            if (asks.length) parts.push(`Payment follow-ups ready (${asks.length}):`, ...asks.map((x) => '  \u00b7 ' + chaser.lineFor(x.draft, 'ask')));
            if (chases.length) parts.push(...(parts.length ? [''] : []), `Still unpaid (${chases.length}):`, ...chases.map((x) => '  \u00b7 ' + chaser.lineFor(x.draft, 'chase')));
            parts.push('', 'The drafts are in Jarvis under Payment follow-ups. Nothing has been sent to any customer.');
            try { await sendToManager(parts.join('\n')); told.push(...forMe); res.asked += asks.length; res.chased += chases.length; }
            catch (e) { res.failed.push({ why: 'could not tell her: ' + (e && e.message) }); }
        }
    }
    for (const x of todo.filter((y) => y.step === 'escalate')) {
        if (!sendToTeam) { res.failed.push({ company: x.draft.customer, why: 'nothing to tell the team with' }); continue; }
        try { await sendToTeam(chaser.lineFor(x.draft, 'escalate')); told.push(x); res.escalated += 1; }
        catch (e) { res.failed.push({ company: x.draft.customer, why: 'escalation failed: ' + (e && e.message) }); }
    }
    if (told.length) await chaser.writeLog(chaser.recorded(log, told, t));
    return res;
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
    const pay = r.payments || {};
    if (pay.asked || pay.chased || pay.escalated) {
        // (counts include emails waiting for her yes)
        const pb = [];
        if (pay.asked) pb.push(`${pay.asked} payment follow-up${pay.asked === 1 ? '' : 's'} drafted`);
        if (pay.chased) pb.push(`${pay.chased} still unpaid`);
        if (pay.escalated) pb.push(`${pay.escalated} passed to the team`);
        lines.push('Payments: ' + pb.join(' \u00b7 '));
    }
    for (const f of (pay.failed || [])) lines.push(`Payment follow-up failed${f.company ? ' for ' + f.company : ''}: ${f.why}`);
    for (const u of (r.unreachable || [])) {
        lines.push(`No way to reach ${u.company || 'a carrier'} about ${u.container_no || 'a pickup'} — ${u.why}`);
    }
    for (const f of (r.failed || [])) {
        lines.push(`Follow-up failed${f.company ? ' for ' + f.company : ''}: ${f.why}`);
    }
    return lines.join('\n');
}

module.exports = { run, summarise, KINDS };
