// ── helpers/qbAgentJob.js — the QuickBooks agent's daily run ──────────────
// Apsara, 2026-10-01: "Assign one agent for quickbook next", "so
// (bills+invoice) agent should talk to this agent".
//
// ── IT RUNS BEFORE THE LEDGER AGENT, AND HANDS IT THE ANSWER ──────────────
// Order matters and is the point of the pairing:
//
//   00:00  the nightly QuickBooks run pushes what it can
//   07:25  THIS: a dry sweep, so we know what is still stuck and why
//   07:30  the ledger agent fills blanks — and is told which of them are
//          holding up her books, so those are chased first and said loudly
//
// Five minutes, not zero, because the dry sweep talks to QuickBooks for the
// rows that get past the blocked checks and a slow morning must not make the
// ledger agent wait on it. The ledger agent runs with or without this: if
// 07:25 failed or QuickBooks is down, 07:30 goes ahead with no blocking
// information rather than being skipped. An agent that stops working because
// a different agent failed is two outages for the price of one.
//
// ── ONE SWEEP PER MORNING ─────────────────────────────────────────────────
// The result is cached on the module and handed to the ledger agent. A dry
// sweep is not free — it fetches her QuickBooks name snapshots and looks for
// existing matches — and running it twice at 07:25 and again at 07:30 would
// double that for no new information.
//
// ── NO NEW POWERS, STILL ──────────────────────────────────────────────────
// Dry run always. This job cannot push, cannot create a vendor, cannot
// journal. QB_PROD_WRITES and QB_SYNC keep meaning exactly what they meant;
// see helpers/qbAgent.js for why that line is drawn where it is.

const cfg = require('../config');

// What the ledger agent reads at 07:30. Null until a run has happened, which
// it treats as "no blocking information" rather than "nothing is blocked" —
// the difference matters, so it is a null and not an empty Map.
let lastLook = null;
const look = () => lastLook;
const forget = () => { lastLook = null; };

// ── THE RUN ───────────────────────────────────────────────────────────────
// `sweep`, `send`, `alreadySent` and `markSent` are injected for the same
// reason they are in ledgerAgentJob: the first version of that file invented
// two module names that did not exist, and because the calls were wrapped in
// a fail-soft try/catch it would have quietly never sent. A file that names
// no modules cannot be wrong about one.
async function run({ sweep, send, alreadySent, markSent, now = new Date() } = {}) {
    const agent = require('./qbAgent');
    const dateKey = now.toISOString().slice(0, 10);
    const key = `qb_agent_${dateKey}`;

    if (alreadySent && await alreadySent(key)) {
        return { skipped: true, why: 'already ran today' };
    }
    const mark = markSent || (async () => {});

    let result = null;
    try {
        result = await agent.look({ sweep });
    } catch (e) {
        // ── A FAILED SWEEP IS NEWS, NOT SILENCE ──────────────────────────
        // An expired token or a QuickBooks outage means her books did not
        // get checked this morning. Reporting "nothing is blocked" would be
        // the worst available answer — it is the one that reads as good.
        //
        // NOT marked as sent: a transient 500 at 07:25 should be retried by
        // the next run rather than written off for the day.
        const why = String((e && e.message) || e).slice(0, 200);
        console.error('[qb-agent] sweep failed:', why);
        lastLook = null;
        const to = recipients();
        if (to && send) {
            try {
                await send({ to, subject: 'QuickBooks agent — could not check this morning',
                    body: `The QuickBooks check did not run.\n\n  ${why}\n\n`
                        + 'Nothing was changed. This usually means the QuickBooks token '
                        + 'needs reconnecting on the QuickBooks page.' });
            } catch (e2) { console.error('[qb-agent] could not even send the failure:', e2.message); }
        }
        return { ok: false, error: why, sent: !!(to && send) };
    }

    // Cached for the ledger agent BEFORE the email, so a send failure does
    // not cost the 07:30 run its blocking information.
    lastLook = result;

    const text = agent.reportText(result);
    await mark(key);

    if (!text) return { ...result, sent: false, why: 'nothing is stuck' };

    const to = recipients();
    if (!to) {
        console.log('[qb-agent] no recipient configured (QB_AGENT_EMAILS) — not sending');
        return { ...result, sent: false, why: 'no recipient configured', text };
    }

    // Counted from what is actually IN the email — the Jarvis blanks are
    // handled by the other agent and deliberately not listed here, so
    // counting all blocked rows would promise a longer email than it is.
    const mine = result.blocked.reduce((n, b) =>
        n + b.found.filter((f) => f.side !== 'jarvis').length, 0);
    const subject = mine
        ? `QuickBooks agent — ${mine} thing${mine === 1 ? ' needs' : 's need'} you`
        : 'QuickBooks agent — held up, but nothing needs you';

    try {
        const mail = send || ((o) => require('./gmail').sendEmail(o));
        await mail({ to, subject, body: text });
        return { ...result, sent: true, text };
    } catch (e) {
        console.error('[qb-agent] send failed:', e.message);
        return { ...result, sent: false, error: e.message, text };
    }
}

// QB_AGENT_EMAILS, then the general alert address. Checked against config.js's
// real exports — ALERT_EMAIL_TO, not ALERT_EMAIL, which is the name this
// codebase invented once already this morning and which reads as unset.
function recipients() {
    return String(cfg.QB_AGENT_EMAILS || cfg.ALERT_EMAIL_TO || '').trim() || null;
}

// Everything except the email. What a route or a screen should call.
const preview = (opts = {}) => require('./qbAgent').look(opts);

module.exports = { run, preview, look, forget, recipients };
