// ── helpers/ledgerAgentJob.js — the agent's daily run ─────────────────────
// Apsara, 2026-10-01: "Let an AI agent handle both bills and invoice and
// associated things", "which scans regularly and keep things perfect and
// neat", "Every day,ensure that there is no discrepancy", and its own daily
// email rather than folding into the 6:30 sweep.
//
// This is the wiring. The judgement lives in helpers/ledgerAgent.js and the
// scanning lives in the jobs that already run; this gets them into the same
// room once a day and sends the result.
//
// ── WHY IT RUNS AT 07:30 ──────────────────────────────────────────────────
// After the 06:30 integrity sweep, so the sweep's findings are of today; and
// after the 23:15 sheet sync of the night before, whose report it reuses
// rather than fetching her workbook a second time. Before 08:00, so it lands
// with the morning digest rather than an hour behind it.
//
// ── DRY BY DEFAULT ────────────────────────────────────────────────────────
// run() APPLIES. preview() does everything except the writing and returns the
// same shape, which is what the route and any screen should call. A function
// whose default behaviour edits her ledger is one that gets called by accident
// exactly once.

const cfg = require('../config');

// ── THE SCHEDULER OWNS THE DEDUP AND THE MAILBOX, SO IT HANDS THEM IN ────
// The first version of this file reached for helpers/sentOnce and
// helpers/mailer. NEITHER EXISTS. markSent/alreadySent live in scheduler.js
// on top of brain.proactive_sent, and mail goes out through
// helpers/gmail.sendEmail — and because both of my calls were wrapped in a
// fail-soft try/catch, the mistake would not have thrown. It would have
// quietly never marked and never sent, which is the failure shape this whole
// project keeps running into: a thing that looks like it is working.
//
// So they are parameters. The scheduler passes what it already has, tests
// pass fakes, and this file cannot be wrong about a module name again
// because it names none.

// ── GATHER, DECIDE, (OPTIONALLY) WRITE ────────────────────────────────────
// `sheetReport` is handed in by the caller when it has one — the night sync
// already fetched the workbook, and the agent is deliberately network-free.
// Absent, the sheet half simply produces nothing and the run is sweep-only,
// which is a smaller report rather than a failure.
// ── `qbLook` IS THE OTHER AGENT TALKING ───────────────────────────────────
// Apsara, 2026-10-01: "so (bills+invoice) agent should talk to this agent."
// The 07:25 QuickBooks job leaves its result on its module; this reads it and
// turns it into "which of my findings are holding up her books".
//
// OPTIONAL, deliberately. Absent or failed, this run proceeds with no
// blocking information — the blanks still get filled, they are just not
// marked urgent. An agent that will not work because a different agent failed
// is two outages for the price of one.
async function build({ sheetReport = null, apply = false, qbLook = undefined } = {}) {
    const agent = require('./ledgerAgent');
    const sources = agent.defaultSources();
    for (const s of sources) if (s.id === 'sheet-diff') s.report = sheetReport;

    const { findings, broken } = agent.collect({ sources });

    // What QuickBooks is waiting on. Wrapped: a change in the other agent's
    // shape must cost a mark of urgency, never the morning's whole report.
    let blocking = new Map();
    try {
        const look = qbLook === undefined ? require('./qbAgentJob').look() : qbLook;
        if (look) blocking = require('./qbAgent').blockingFields(look);
    } catch (e) {
        broken.push({ id: 'quickbooks-blocking', error: String((e && e.message) || e).slice(0, 200) });
    }

    const sorted = agent.sort(agent.markBlocking(findings, blocking));
    // Urgent first within each list. A sort, not a filter — nothing hidden.
    sorted.settled = agent.blockingFirst(sorted.settled);
    sorted.proposed = agent.blockingFirst(sorted.proposed);

    let written = { applied: [], skipped: [], failed: [] };
    if (apply && sorted.settled.length) {
        written = await agent.apply(sorted.settled);
    }

    // What the email reports as "tidied" is what was ACTUALLY written, not
    // what was eligible. A row she filled in herself between the scan and the
    // send is skipped, and telling her it was tidied would be a small lie
    // that makes the next one harder to believe.
    const settledForReport = apply ? written.applied : sorted.settled;

    // A skip is not silent either: "already filled in" is reassuring, but
    // "row is gone" or a write that threw is something she should see.
    const notable = [
        ...written.skipped.filter((s) => !/already filled in/.test(String(s.why || ''))),
        ...written.failed,
    ].map((s) => ({
        what: s.what || (s.fix && s.fix.field) || 'a fix',
        detail: s.error ? `could not be applied: ${s.error}` : `not applied: ${s.why}`,
    }));

    return {
        at: new Date().toISOString(),
        applied: apply,
        settled: settledForReport,
        proposed: [...sorted.proposed, ...notable],
        broken,
        counts: {
            settled: settledForReport.length,
            proposed: sorted.proposed.length,
            skipped: written.skipped.length,
            failed: written.failed.length,
        },
    };
}

// Everything except the writing. What a screen or a route should call.
const preview = (opts = {}) => build({ ...opts, apply: false });

async function run({ sheetReport = null, send, alreadySent, markSent, qbLook = undefined, now = new Date() } = {}) {
    const dateKey = now.toISOString().slice(0, 10);
    const key = `ledger_agent_${dateKey}`;
    // No dedup passed means the caller is running it on purpose (the route,
    // a hand run) and wants it now. The CRON always passes one.
    if (alreadySent && await alreadySent(key)) {
        return { skipped: true, why: 'already ran today' };
    }
    const mark = markSent || (async () => {});

    const result = await build({ sheetReport, apply: true, qbLook });
    const agent = require('./ledgerAgent');
    const text = agent.reportText(result);

    // SILENT WHEN THERE IS NOTHING. reportText returns null for an empty day,
    // and a daily "all clear" for a month is an email she stops opening —
    // including the day it matters. Marked as run either way, so a quiet day
    // does not get re-run every minute.
    if (!text) {
        await mark(key);
        return { ...result, sent: false, why: 'nothing to report' };
    }

    // Marked BEFORE sending, like every other daily job here: a crash
    // mid-send costs one skipped day, not a duplicate email.
    await mark(key);

    // ALERT_EMAIL_TO, not ALERT_EMAIL. The second invented config name in
    // this file; checked against config.js's exports this time.
    const to = (cfg.LEDGER_AGENT_EMAILS || cfg.ALERT_EMAIL_TO || '').toString();
    if (!to.trim()) {
        // Nothing configured is not an error — it is a setting she has not
        // filled in. Logged once a day rather than thrown.
        console.log('[ledger-agent] no recipient configured (LEDGER_AGENT_EMAILS) — not sending');
        return { ...result, sent: false, why: 'no recipient configured', text };
    }

    // "1 thing need you" — the verb has to agree too, not just the noun.
    // Second time this exact bug: reportText had its own copy of the phrase
    // and fixing that one did not fix this one.
    const n = result.counts.proposed;
    const subject = n
        ? `Ledger agent — ${n} thing${n === 1 ? ' needs' : 's need'} you`
        : 'Ledger agent — tidied, nothing needs you';

    try {
        // helpers/gmail.sendEmail takes { to, subject, body } — body, not
        // text. Checked against scheduler.js:406 rather than assumed, which
        // is how the two names above got here in the first place.
        const mail = send || ((o) => require('./gmail').sendEmail(o));
        await mail({ to, subject, body: text });
        return { ...result, sent: true, text };
    } catch (e) {
        // A send failure must not look like a clean day. It is logged loudly
        // and returned, so whatever called this can say so.
        console.error('[ledger-agent] send failed:', e.message);
        return { ...result, sent: false, error: e.message, text };
    }
}

module.exports = { build, preview, run };
