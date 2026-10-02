// ── helpers/claimsAgentJob.js — the chase, every morning ───────────────────
// Apsara, 2026-10-02: "Also for handling claims-I want to have an advanced
// agent because thats where we are losing money."
//
// Asked which of four leaks it was, she said ALL FOUR. Asked what the agent
// may do, she chose find-and-chase AND draft the recovery email — never
// touch a figure. Asked what the claim window is: "We need to remind them -
// there is no specific window - the faster the better."
//
// ── SO AGE IS THE WHOLE MECHANISM ─────────────────────────────────────────
// There is no deadline to count down to, which means a chase that fires once
// and goes quiet is a chase that gets ignored. "The faster the better" means
// it must get LOUDER the longer something sits, and it must not stop. The
// ladder is in LOUDNESS below.
//
// ── WHAT IT IS ALLOWED TO DO ──────────────────────────────────────────────
// Find, total, chase, and write a draft. It writes nothing to the claims
// register — no status, no claim_amount, no our_claim — and sends no mail to
// a supplier. helpers/claimsAgent.js has no store and no writer at all; this
// file adds the clock, the messages and the draft, and still writes only its
// own "already said this today" marker.
//
// THE DRAFT IS THE POINT OF THE SECOND POWER. The leak she is losing money to
// is a recovery NOBODY RAISED — helpers/claims.js says so in its own comment
// above raiseRecovery. The reason a recovery does not get raised is rarely
// that she decided against it; it is that writing the email is a job and the
// job never reaches the top of the list. So the email arrives written.

const cfg = require('../config');

// ── HOW LOUD, BY HOW LONG ─────────────────────────────────────────────────
// Her words were "the faster the better", so the first nudge is early and
// cheap, and the volume goes up rather than the frequency. A daily repeat at
// one volume is how a person learns to scroll past something.
//
//   nudge   a line in the morning message. Easy to act on, easy to ignore
//           once, and it will be back tomorrow louder.
//   named   the supplier, the container and the figure, on their own line.
//   urgent  top of the message every single day until it moves, with the age
//           in days said out loud, because "this has been sitting 34 days" is
//           a different sentence from "this is open".
const LOUDNESS = [
    { at: 21, level: 'urgent' },
    { at: 7, level: 'named' },
    { at: 0, level: 'nudge' },
];

const loudnessFor = (ageDays) => {
    const d = Number(ageDays) || 0;
    for (const step of LOUDNESS) if (d >= step.at) return step.level;
    return 'nudge';
};

const money = (n) => '$' + Number(n || 0).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const str = (v) => String(v == null ? '' : v).trim();

// ── THE DRAFTED RECOVERY EMAIL ────────────────────────────────────────────
// Written for her to read, correct and send — NOT sent. Deliberately plain:
// a claim letter is a commercial document that may be read back to her in a
// dispute, so it states facts and asks a question. No adjectives, no threat,
// no apology.
//
// EVERY FIGURE IN IT COMES FROM THE RECORD. Nothing is computed here and
// nothing is rounded differently from the register, because a claim letter
// quoting a number that does not match her own ledger is worse than no
// letter. Where a figure is missing it says so rather than leaving a gap the
// reader fills in.
function draftRecovery(claim, assessed) {
    const c = claim || {};
    const supplier = str(c.supplier) || 'the supplier';
    const container = str(c.container_no);
    const invoice = str(c.invoice_no);
    const amount = assessed && assessed.money !== null && assessed.money !== undefined
        ? money(assessed.money) : null;

    const lines = [];
    lines.push(`Subject: Weight shortage claim${container ? ` — ${container}` : ''}`
        + `${invoice ? ` / ${invoice}` : ''}`);
    lines.push('');
    lines.push(`Dear ${supplier},`);
    lines.push('');
    lines.push('We have received a weight shortage claim from our customer on the'
        + ` shipment below, and we are passing it to you for recovery.`);
    lines.push('');
    if (container) lines.push(`  Container      ${container}`);
    if (invoice) lines.push(`  Invoice        ${invoice}`);
    if (c.date) lines.push(`  Date           ${str(c.date)}`);
    if (c.invoice_weight != null && c.claimed_weight != null) {
        const u = str(c.weight_unit) || '';
        lines.push(`  Invoiced       ${c.invoice_weight} ${u}`.trimEnd());
        lines.push(`  Received       ${c.claimed_weight} ${u}`.trimEnd());
        if (c.shortage != null) lines.push(`  Shortage       ${c.shortage} ${u}`.trimEnd());
    }
    lines.push(`  Amount claimed ${amount || '(to be confirmed)'}`);
    lines.push('');
    lines.push('Please confirm whether you accept this, and how you would like to settle'
        + ' it — by credit note against the next shipment, or by payment.');
    lines.push('');
    lines.push('If you believe the figures are wrong, send us your weighbridge record'
        + ' for this container and we will compare it against ours.');
    lines.push('');
    lines.push('Regards,');
    lines.push('Edge Metals');

    return {
        to_name: supplier,
        subject: `Weight shortage claim${container ? ` — ${container}` : ''}${invoice ? ` / ${invoice}` : ''}`,
        body: lines.join('\n'),
        // Said plainly so she is never guessing what state this is in.
        status: 'DRAFT — not sent. Nothing goes to the supplier until you say so.',
        // Named, because a draft missing the amount needs her before it needs
        // sending, and that is a different action.
        needs: amount ? [] : ['the claim amount is not computed yet — verify the weights first'],
    };
}

// ── THE MORNING MESSAGE ───────────────────────────────────────────────────
// One message, ordered by what it costs her: money we are ABSORBING first,
// because that is the leak she named; then money a supplier owes; then the
// ones that have not been quantified at all.
//
// SILENT WHEN THERE IS NOTHING. Every other daily job here follows that rule
// and it is right: a chase that arrives saying "nothing to chase" every day
// for a fortnight is a chase she stops reading, and the day it matters she
// stops reading that too.
function chaseText(t) {
    if (!t || !t.counts || !t.counts.flagged) return null;

    const L = [];
    const absorbing = t.absorbing || [];
    const unsettled = t.unsettled || [];
    const unverified = t.unverified || [];

    // The headline is the sentence she needs, and it leads with the number
    // that is leaving.
    if (t.money.absorbing > 0) {
        L.push(`*${money(t.money.absorbing)} is sitting on us* — `
            + `${absorbing.length} claim${absorbing.length === 1 ? '' : 's'} verified, `
            + `with nothing asked of the supplier.`);
    } else {
        L.push(`*${t.counts.flagged} claim${t.counts.flagged === 1 ? '' : 's'} need chasing.*`);
    }
    L.push('');

    const line = (a) => {
        const who = [a.container_no, a.supplier || a.customer].filter(Boolean).join(' · ');
        const age = a.ageDays === null ? '' : ` — ${a.ageDays}d`;
        const amt = a.money !== null ? `  ${money(a.money)}` : '  (not priced)';
        const loud = loudnessFor(a.ageDays);
        return `${loud === 'urgent' ? '‼️ ' : ''}${who || a.id}${age}${amt}`;
    };

    if (absorbing.length) {
        L.push('*Nobody has asked the supplier:*');
        for (const a of absorbing.slice(0, 8)) L.push('  ' + line(a));
        if (absorbing.length > 8) L.push(`  …and ${absorbing.length - 8} more`);
        L.push('');
    }
    if (unsettled.length) {
        L.push(`*Asked and not answered${t.money.unsettled ? ` — ${money(t.money.unsettled)}` : ''}:*`);
        for (const a of unsettled.slice(0, 6)) L.push('  ' + line(a));
        if (unsettled.length > 6) L.push(`  …and ${unsettled.length - 6} more`);
        L.push('');
    }
    if (unverified.length) {
        L.push('*Not verified, so claimed from nobody:*');
        for (const a of unverified.slice(0, 5)) L.push('  ' + line(a));
        if (unverified.length > 5) L.push(`  …and ${unverified.length - 5} more`);
        L.push('');
    }
    if (t.counts.unquantified) {
        L.push(`${t.counts.unquantified} of these ${t.counts.unquantified === 1 ? 'has' : 'have'} no `
            + 'figure yet, so no total includes them.');
    }
    L.push('');
    L.push('Say *draft claim <container>* and I will write the recovery email for you to check.');
    return L.join('\n');
}

// ── THE RUN ───────────────────────────────────────────────────────────────
// Everything injected, for the reason this codebase keeps relearning: a first
// version of ledgerAgentJob invented two module names, and because the calls
// were in a fail-soft try/catch it would have silently never sent.
async function run({ claims, send, alreadySent, markSent, now = new Date(), windows } = {}) {
    const agent = require('./claimsAgent');
    const list = claims || (() => { try { return require('./claims').list(); } catch { return []; } })();

    const dateKey = now.toISOString().slice(0, 10);
    const key = `claims_chase_${dateKey}`;
    if (alreadySent && await alreadySent(key)) return { skipped: true, why: 'already chased today' };

    const t = agent.triage(list, { now: now.getTime(), windows });
    const text = chaseText(t);

    const mark = markSent || (async () => {});
    await mark(key);

    if (!text) return { ...t, sent: false, why: 'nothing to chase' };
    if (!send) return { ...t, sent: false, why: 'no sender', text };

    try {
        await send(text);
        return { ...t, sent: true, text };
    } catch (e) {
        console.error('[claims-agent] could not send the chase:', e.message);
        return { ...t, sent: false, error: e.message, text };
    }
}

// What a screen or a chat command calls: the same assessment, no message, no
// marker, no writes.
function preview({ claims, now = new Date(), windows } = {}) {
    const agent = require('./claimsAgent');
    const list = claims || (() => { try { return require('./claims').list(); } catch { return []; } })();
    return agent.triage(list, { now: now.getTime(), windows });
}

module.exports = { run, preview, chaseText, draftRecovery, loudnessFor, LOUDNESS };
