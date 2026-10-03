// ── helpers/backupWatch.js — proof the backup is still happening ──────────
// Apsara, 2026-10-02: "Protect the data of edge yard no matter what."
//
// ── WHAT WAS WRONG ────────────────────────────────────────────────────────
// The nightly backup was wired as:
//
//     .catch(e => console.error('[SCHED] nightly data backup FAILED:', e))
//
// and nothing else. A Drive token expires, or the Backups folder gets
// renamed, and from that night on there are no backups — and NOBODY IS TOLD.
// She goes on believing she has thirty dated copies of payments.json and
// petty_cash.json, and finds out on the one day it matters.
//
// Every other consequential job in this scheduler emails. The one guarding
// the money ledger did not.
//
// ── WHY "SILENT WHEN CLEAN" IS WRONG *HERE* ───────────────────────────────
// It is the house rule everywhere else in this codebase, and it is right
// everywhere else: a daily "all clear" is an email that stops being read.
//
// Backups are the exception, and the reason is specific. A backup system
// that is silent when it works AND silent when it breaks conveys nothing —
// and the failure is invisible for as long as nobody needs the data, which
// is precisely the period during which it accumulates. So:
//
//   · ANY trouble emails immediately — a failure, a critical store missing,
//     a store that would not parse, or a gap since the last success.
//   · ONE short heartbeat a week, on Monday, says it is working and names
//     the last success. That makes the ABSENCE of a message a signal too,
//     which is the only way a person can tell "fine" from "the alerting is
//     also broken".
//
// ── AND THE PART AN EMAIL CANNOT COVER ────────────────────────────────────
// If the process is down, no cron fires, so nothing emails — the outage
// hides itself. That gap is closed on /healthz instead (see health() below
// and api.js), which an external monitor polls from outside this box. The
// email is for "the backup ran and went wrong"; /healthz is for "the backup
// is not running at all".

const fs = require('fs');
const path = require('path');
const cfg = require('../config');

// A small append-only-ish log: one entry per attempt, newest last, trimmed.
// Its own file rather than brain.json because brain is rewritten constantly
// and this has to survive being the last thing anyone trusts.
const LOG_FILE = () => path.join(cfg.DATA_DIR, 'backup_log.json');
const KEEP = 90;

// How long without a success before it is a problem. One night can be missed
// for a dozen dull reasons (a reboot, a long deploy); two means something is
// actually wrong.
const STALE_DAYS = 2;

const iso = (d) => new Date(d).toISOString();

// ── READ DIRECTLY, *NOT* THROUGH loadJson ─────────────────────────────────
// loadJson NEVER THROWS — it returns the default and logs — which is right
// for a store whose absence should not stop a page rendering, and WRONG here.
//
// The first version used it, and a CORRUPTED receipt therefore read as "no
// history", which health() correctly treats as a fresh install and reports
// as fine. So a damaged log file would have made /healthz say backups were
// healthy for ever: the exact silent-failure shape this whole file exists to
// close, reintroduced by the helper meant to be safe.
//
// So the three cases are kept apart:
//   file absent      → no history. Fine; a fresh install.
//   file unparseable → THROWS, and health() reports backup_log_unreadable.
//   file fine        → the rows.
function readLog() {
    let raw;
    try { raw = fs.readFileSync(LOG_FILE(), 'utf8'); }
    catch (e) {
        if (e && e.code === 'ENOENT') return [];   // never written yet
        throw e;                                    // unreadable is not empty
    }
    if (!String(raw).trim()) return [];
    const parsed = JSON.parse(raw);                 // throws on damage, deliberately
    if (!Array.isArray(parsed)) throw new Error('backup log is not a list');
    return parsed;
}

async function record(entry) {
    const { mutateJson } = require('./json');
    const row = { at: iso(entry.at || Date.now()), ...entry };
    // strict:false deliberately. Failing to WRITE THE LOG must never be the
    // thing that makes a successful backup look failed — the backup is the
    // product, this is the receipt.
    await mutateJson(LOG_FILE(), [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        rows.push(row);
        return rows.slice(-KEEP);
    });
    return row;
}

// ── THE HEALTH READ, USED BY THE EMAIL *AND* BY /healthz ──────────────────
// One function so the two cannot disagree about whether backups are fine.
// Pure, synchronous, and NEVER THROWS: /healthz calling this must not be
// able to 500, because a health endpoint that errors is a health endpoint
// nobody can rely on.
function health({ now = Date.now(), staleDays = STALE_DAYS } = {}) {
    try {
        const rows = readLog();
        const ok = rows.filter((r) => r && r.ok);
        const last = ok.length ? ok[ok.length - 1] : null;
        const lastAttempt = rows.length ? rows[rows.length - 1] : null;

        // Consecutive failures since the most recent success — "it failed
        // once" and "it has failed for nine nights" need different reactions.
        let failingFor = 0;
        for (let i = rows.length - 1; i >= 0; i -= 1) {
            if (rows[i] && rows[i].ok) break;
            failingFor += 1;
        }

        const lastAt = last ? Date.parse(last.at) : NaN;
        const ageDays = isFinite(lastAt) ? Math.floor((now - lastAt) / 86400000) : null;

        const problems = [];
        if (!rows.length) {
            // NOT reported as stale. A fresh install, or the first night
            // after this shipped, has no history and is not evidence of a
            // broken backup — claiming otherwise would cry wolf on day one
            // and get the alarm ignored.
            return { known: false, problems: [], failingFor: 0, last: null,
                     lastAttempt: null, ageDays: null, criticalMissing: [] };
        }
        if (!last) problems.push('backup_never_succeeded');
        else if (ageDays !== null && ageDays >= staleDays) problems.push(`backup_stale_${ageDays}d`);
        if (failingFor > 0) problems.push(`backup_failing_${failingFor}`);
        // A backup that RAN but came back without a critical store is a
        // backup that will not restore the thing it exists for.
        // ── ONLY A STORE THAT VANISHED IS A PROBLEM ─────────────────────
        // Older receipts have no criticalVanished field. They fall back to
        // the empty array rather than to criticalMissing, deliberately: an
        // archive written before this split cannot tell the two apart, and
        // guessing "vanished" from it would re-raise the same false alarm
        // against history that cannot answer back.
        const vanished = (last && Array.isArray(last.criticalVanished)) ? last.criticalVanished : [];
        const missing = (last && Array.isArray(last.criticalMissing)) ? last.criticalMissing : [];
        if (vanished.length) problems.push('backup_store_vanished');

        return {
            known: true,
            problems,
            failingFor,
            last: last ? last.at : null,
            lastAttempt: lastAttempt ? lastAttempt.at : null,
            ageDays,
            // Names stay OFF /healthz — that route is public. The caller
            // decides whether to use them; the email does, the endpoint
            // must not.
            criticalMissing: missing,
            criticalVanished: vanished,
            lastError: lastAttempt && !lastAttempt.ok ? lastAttempt.error : null,
        };
    } catch (e) {
        // Unreadable log. Said as a problem rather than swallowed: a receipt
        // we cannot read is not proof of anything.
        return { known: true, problems: ['backup_log_unreadable'], failingFor: 0,
                 last: null, lastAttempt: null, ageDays: null, criticalMissing: [],
                 lastError: String((e && e.message) || e).slice(0, 120) };
    }
}

// ── THE NIGHTLY WRAPPER ───────────────────────────────────────────────────
// Runs the backup, writes the receipt, and speaks up when it should. Every
// dependency is injected for the same reason the two agents' jobs are: a
// first version of one of those invented two module names, and because the
// calls were in a fail-soft try/catch it would have silently never sent.
async function nightly({ runBackup, send, now = new Date(), staleDays = STALE_DAYS } = {}) {
    const run = runBackup || ((o) => require('./backup').runBackup(o));
    const mail = send || ((o) => require('./gmail').sendEmail(o));
    const to = String(cfg.BACKUP_ALERT_EMAILS || cfg.ALERT_EMAIL_TO || '').trim();

    let result = null;
    let error = null;
    try {
        result = await run({ now });
    } catch (e) {
        error = String((e && e.message) || e).slice(0, 300);
    }

    const meta = (result && result.meta) || {};
    const entry = await record({
        at: now,
        ok: !error,
        error,
        name: result ? result.name : null,
        bytes: result ? result.bytes : null,
        storeCount: meta.store_count || null,
        criticalMissing: Array.isArray(meta.critical_missing) ? meta.critical_missing : [],
        // ── THE MEMORY, AND THE TWO KINDS OF ABSENT (2026-10-03) ─────────
        // stores_present is what makes tomorrow able to tell a store that
        // VANISHED from one that was never written. criticalVanished is the
        // alarm; criticalNotYetUsed is a feature she has not used and says
        // nothing. They were one field, and reading it I told her twice that
        // her Edge Yard data was gone when it had simply never existed.
        storesPresent: Array.isArray(meta.stores_present) ? meta.stores_present : [],
        criticalVanished: Array.isArray(meta.critical_vanished) ? meta.critical_vanished : [],
        criticalNotYetUsed: Array.isArray(meta.critical_not_yet_used) ? meta.critical_not_yet_used : [],
        unreadable: Array.isArray(meta.problems) ? meta.problems.map((p) => p && p.path).filter(Boolean) : [],
    });

    // Health read AFTER the receipt, so "failing for N nights" counts tonight.
    const h = health({ now: now.getTime(), staleDays });

    const trouble = !!error
        || (entry.criticalVanished || []).length
        || entry.unreadable.length
        || h.problems.length;

    // Monday heartbeat — see the header for why silence is not safe here.
    const heartbeat = !trouble && now.getDay() === 1;

    if (!to) {
        if (trouble) console.error('[BACKUP-WATCH] trouble, and no recipient configured (BACKUP_ALERT_EMAILS)');
        return { ...entry, health: h, sent: false, why: 'no recipient configured', trouble };
    }
    if (!trouble && !heartbeat) return { ...entry, health: h, sent: false, why: 'clean' };

    const subject = error
        ? 'BACKUP FAILED — the yard data was not copied last night'
        : ((entry.criticalVanished || []).length ? 'A STORE THAT WAS BACKED UP IS GONE'
        : (h.problems.length ? 'BACKUP — something is wrong'
        : 'Backups are fine'));

    try {
        await mail({ to, subject, body: reportText({ entry, health: h, heartbeat }) });
        return { ...entry, health: h, sent: true, subject };
    } catch (e) {
        // A send failure on THIS job is the worst one in the system — it is
        // the alarm for the thing that cannot be rebuilt. Logged as loudly as
        // a console allows, and returned so a caller can say so.
        console.error('[BACKUP-WATCH] COULD NOT SEND THE BACKUP ALERT:', e.message);
        return { ...entry, health: h, sent: false, error: entry.error, sendError: e.message };
    }
}

function reportText({ entry, health: h, heartbeat }) {
    const L = [];
    if (heartbeat) {
        L.push(`Backups are working. Last one ${entry.name || '—'}, `
            + `${entry.storeCount || 0} stores, ${Math.round((entry.bytes || 0) / 1024)} KB.`);
        L.push('');
        L.push('This is the weekly line that says so. If it stops arriving, the');
        L.push('backup or this alert has broken — both are worth checking.');
        return L.join('\n');
    }

    if (entry.error) {
        L.push('LAST NIGHT\'S BACKUP DID NOT HAPPEN.');
        L.push('');
        L.push(`  ${entry.error}`);
        L.push('');
        L.push('Nothing was copied off the machine. If that mentions a token or');
        L.push('permission, reconnect Drive; the data is still on the VM and the');
        L.push('next run will pick it up.');
    } else {
        L.push('The backup ran, but it is not complete.');
    }

    if (h.failingFor > 1) {
        L.push('');
        L.push(`THIS HAS NOW FAILED ${h.failingFor} NIGHTS RUNNING.`);
        L.push(h.last ? `The last good copy is from ${String(h.last).slice(0, 10)}.`
                      : 'There is no successful backup on record at all.');
    }

    if ((entry.criticalVanished || []).length) {
        L.push('');
        L.push('MISSING FROM THE ARCHIVE — these cannot be rebuilt from anywhere else:');
        for (const m of entry.criticalVanished) L.push(`  · ${m}`);
    }
    if (entry.unreadable.length) {
        L.push('');
        L.push('WOULD NOT PARSE, so they were left out:');
        for (const u of entry.unreadable.slice(0, 20)) L.push(`  · ${u}`);
        L.push('');
        L.push('A store that will not parse is a bigger problem than a missed');
        L.push('backup: the live file is damaged, and the dated copies only');
        L.push('reach back 30 days. Restore that one from a copy taken before');
        L.push('the damage — scripts/restore-backup.js --list shows what there is.');
    }

    L.push('');
    L.push(`Last successful backup: ${h.last || 'never'}`);
    return L.join('\n');
}

module.exports = { nightly, health, record, readLog, reportText, LOG_FILE, STALE_DAYS, KEEP };
