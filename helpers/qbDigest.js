// ── helpers/qbDigest.js — one QuickBooks email, not three ─────────────────
// Apsara, 2026-10-02, asked which of the three nightly QuickBooks emails she
// wanted and chose: one 07:25 digest.
//
// What she was getting, all to the same inbox:
//
//   00:00  the entry sweep        — what went in, what is stuck
//   00:30  the QB Agent           — unallocated, duplicates, miscoded, bank gap
//   07:25  the blocked-rows agent — why each stuck row will not go in
//
// Three messages from one subsystem is how all three stop being read. They
// are not duplicates — the sweep WRITES, the QB Agent audits what is already
// inside QuickBooks, and the blocked-rows agent explains what cannot get in —
// so the answer is not to delete one. It is to put them in one envelope.
//
// ── THE JOBS DO NOT CHANGE ────────────────────────────────────────────────
// Each still runs at its own time, still logs its own line, still has its own
// emailReport() for scripts and tests. The only thing that moved is who posts
// the letter. That matters: 00:00 has to keep writing at 00:00, and the
// blocking handoff to the ledger agent at 07:30 still depends on 07:25 having
// run five minutes earlier.
//
// ── A FAILURE STILL GOES OUT AT ONCE ──────────────────────────────────────
// Folding a FAILURE into the digest would mean an expired QuickBooks token at
// midnight reaches her at 07:25 — seven hours in which she believes her books
// are being kept and they are not. Routine reports wait; "this did not run"
// does not. That split is the whole reason this file has a `urgent` flag
// rather than just a bag of texts.
//
// ── AND A PART THAT NEVER ARRIVED IS SAID, NOT SKIPPED ────────────────────
// If the process restarted at 02:00, the 00:00 sweep's entry is gone. Printing
// the two parts that survived would produce a digest that looks complete and
// is not — the exact failure mode of the nightly sheet sync, which went
// missing for days because a silent skip reads like a quiet night. A part
// older than STALE_HOURS is reported as "did not run", by name.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

const FILE = cfg.QB_DIGEST_FILE || 'qb_digest.json';

// Each part names itself, in the order she should read them: what was written
// overnight, then what is wrong inside the books, then what could not get in.
const PARTS = [
    { id: 'sweep', title: 'Entered overnight', when: '00:00' },
    { id: 'agent', title: 'QB Agent — what is not right in the books', when: '00:30' },
    // ── THE 07:25 JOB IS SILENT NOW (Apsara, 2026-10-02) ─────────────────
    // "why two qb Agents? one should be enough na. What is the use?"
    //
    // She was right and I had defended it. Compared properly: the 00:00
    // sweep ALREADY lists every stuck row with its reason —
    //   bill Mazariegos HMMU4933766 — no supplier amount yet
    // — and the 07:25 email reprinted the same rows with the same reasons,
    // adding only a "how to ask for it" line. A second email to say what the
    // first one said.
    //
    // What the job does that nothing else does is NOT the email: it works
    // out WHICH LEDGER FIELD is blocking each row and hands that to the
    // ledger agent at 07:30, which then chases those blanks first. That is
    // invisible to her and worth keeping. So the job stays, the report goes.
    //
    // `optional` means: never reported as "did not run". It is expected to
    // say nothing on a normal day, and flagging that every morning would be
    // the false alarm this file exists to avoid. It still speaks up when it
    // FAILED, because a failed 07:25 means the ledger agent is working blind
    // at 07:30 and she should know why its chase got quieter.
    { id: 'blocked', title: 'Blocked rows — the 07:25 check did not run', when: '07:25',
      optional: true },
];

// Older than this and the part is treated as never having run this cycle.
// 20h rather than 24h: the digest goes out at 07:25 and the earliest part is
// written at 00:00, so a healthy gap is ~7.5h and anything approaching a full
// day means a missed night.
const STALE_HOURS = 20;

const str = (v) => String(v == null ? '' : v).trim();

// ── RECORDING ─────────────────────────────────────────────────────────────
// Called by each job in place of its own emailReport. Stores the text the job
// already knows how to write, so each agent keeps its own wording and this
// file never has to understand QuickBooks.
async function record(id, { text, summary = null, at = new Date(), ok = true } = {}) {
    if (!PARTS.some((p) => p.id === id)) throw new Error(`unknown digest part: ${id}`);
    const entry = { id, text: str(text) || null, summary, ok: !!ok, at: new Date(at).toISOString() };
    try {
        await mutateJson(FILE, {}, (all) => ({ ...(all && typeof all === 'object' ? all : {}), [id]: entry }),
            { strict: true });
    } catch (e) {
        // A digest that cannot be written is a report she will not get. Said
        // out loud rather than swallowed, and the caller decides what to do.
        console.error(`[qb-digest] could not record "${id}":`, e.message);
        throw e;
    }
    return entry;
}

// loadJson NEVER THROWS — a missing or torn file reads as {}, which composes
// into "none of the three ran", and that is the honest answer rather than a
// crash inside the morning cron.
const read = () => {
    const all = loadJson(FILE, {});
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
};

const hoursOld = (iso, now) => {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return Infinity;
    return (now.getTime() - t) / 3600000;
};

// ── COMPOSING ─────────────────────────────────────────────────────────────
// Returns { subject, body, parts } or null when there is genuinely nothing to
// say — every part ran and every one of them was quiet.
function compose({ now = new Date(), stash = null } = {}) {
    const all = stash || read();
    const when = now.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' });

    const seen = [];
    const missing = [];
    for (const p of PARTS) {
        const e = all[p.id];
        if (!e || hoursOld(e.at, now) > STALE_HOURS) {
            // An optional part that said nothing is a normal night, not a
            // missing report.
            if (!p.optional) missing.push(p);
            continue;
        }
        seen.push({ ...p, entry: e });
    }

    // Nothing ran at all. Worth a message of its own — three silent jobs is
    // not a quiet night, it is a scheduler that is not running.
    if (!seen.length && !PARTS.every((p) => p.optional)) {
        return {
            subject: `QuickBooks — nothing ran last night (${when})`,
            body: ['None of the three QuickBooks jobs reported in the last '
                + `${STALE_HOURS} hours:`, '',
                ...PARTS.map((p) => `  ${p.when}  ${p.title}`), '',
                'That usually means the scheduler is not running, or Jarvis restarted',
                'and has not reached these times yet. Nothing was changed either way.'].join('\n'),
            parts: [], missing: PARTS.map((p) => p.id), empty: false,
        };
    }

    // Everything that ran had nothing to say, and nothing is missing.
    const anyText = seen.some((s) => s.entry.text);
    if (!anyText && !missing.length) return null;

    const L = [];
    L.push(`QuickBooks, ${when}`);
    L.push('');

    // The one-line scoreboard, so the whole night is readable without
    // scrolling. Built from each part's own summary; a part that supplied
    // none simply does not appear here.
    const score = [];
    for (const s of seen) {
        const sm = s.entry.summary;
        if (!sm) continue;
        if (s.id === 'sweep') {
            score.push(`entered ${sm.made || 0}`
                + (sm.blocked ? `, ${sm.blocked} stuck` : '')
                + (sm.left ? `, ${sm.left} held by the period lock` : ''));
        } else if (s.id === 'agent' && sm.open != null) {
            score.push(`${sm.open} invariant${sm.open === 1 ? '' : 's'} open`);
        } else if (s.id === 'blocked' && sm.needsHer != null) {
            score.push(`${sm.needsHer} need you`);
        }
    }
    if (score.length) { L.push(score.join(' · ')); L.push(''); }

    for (const s of seen) {
        if (!s.entry.text) continue;
        L.push(`${'─'.repeat(8)} ${s.title} (${s.when}) ${'─'.repeat(8)}`);
        L.push('');
        L.push(s.entry.text);
        L.push('');
    }

    // ── WHAT DID NOT REPORT ──────────────────────────────────────────────
    // Last, and never omitted. A digest that quietly drops a missing part is
    // a digest that reads as complete while a third of her books went
    // unchecked.
    if (missing.length) {
        L.push(`${'─'.repeat(8)} Did not run ${'─'.repeat(8)}`);
        L.push('');
        for (const p of missing) L.push(`  ${p.when}  ${p.title}`);
        L.push('');
        L.push('These reported nothing in the last ' + STALE_HOURS + ' hours. If Jarvis');
        L.push('restarted overnight that is expected; otherwise check pm2 and the logs.');
        L.push('');
    }

    L.push('Open the QuickBooks page in Jarvis to fix a stuck row or undo anything here.');

    const quiet = seen.filter((s) => s.entry.text).length === 0;
    const subject = quiet
        ? `QuickBooks — ${missing.length} job(s) did not run (${when})`
        : `QuickBooks — ${score.length ? score.join(', ') : 'overnight report'} (${when})`;

    return { subject, body: L.join('\n'), parts: seen.map((s) => s.id),
             missing: missing.map((p) => p.id), empty: false };
}

// ── SENDING ───────────────────────────────────────────────────────────────
// Everything injected, for the reason ledgerAgentJob learned the hard way: a
// file that names its own modules can be wrong about one and, inside a
// fail-soft catch, silently never send.
//
// The stash is cleared ONLY after the send succeeds. A failed send keeps every
// part, so tomorrow's digest still carries tonight's news rather than losing
// it to a transient SMTP error.
async function send({ mail, to, now = new Date(), alreadySent, markSent } = {}) {
    const key = `qb_digest_${new Date(now).toISOString().slice(0, 10)}`;
    if (alreadySent && await alreadySent(key)) return { skipped: true, why: 'already sent today' };

    const composed = compose({ now });
    if (!composed) {
        // Quiet night, everything ran. Clear so a silent part tomorrow is not
        // mistaken for today's silence.
        await clear();
        if (markSent) await markSent(key);
        return { sent: false, why: 'nothing to report' };
    }

    const addr = str(to) || str(cfg.QB_AGENT_EMAILS) || str(cfg.ALERT_EMAIL_TO)
        || str(process.env.QB_REPORT_TO) || null;
    if (!addr) {
        console.log('[qb-digest] no recipient configured — not sending');
        return { sent: false, why: 'no recipient', ...composed };
    }

    try {
        const post = mail || ((o) => require('./gmail').sendEmail(o));
        await post({ to: addr, subject: composed.subject, body: composed.body });
        await clear();
        if (markSent) await markSent(key);
        return { sent: true, ...composed };
    } catch (e) {
        // NOT marked as sent and NOT cleared: tomorrow retries with tonight's
        // content still in hand.
        console.error('[qb-digest] send failed, keeping the night for the next run:', e.message);
        return { sent: false, error: e.message, ...composed };
    }
}

// mutateJson's mutator returning null/undefined means "no change" and writes
// NOTHING (helpers/json.js: `await mutator(data) ?? data`) — the trap that let
// a stale qbAgent cache survive a forget(). `{}` is an actual write.
async function clear() {
    try { await mutateJson(FILE, {}, () => ({}), { strict: true }); }
    catch (e) { console.error('[qb-digest] could not clear:', e.message); }
}

module.exports = { record, read, compose, send, clear, PARTS, STALE_HOURS, FILE };
