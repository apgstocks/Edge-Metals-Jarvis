// ── scheduler.js — node-cron jobs (replaces Cloud Scheduler + Pub/Sub) ───────
// All schedules run in America/Los_Angeles because every freight deadline
// (ERD/cutoff) is a US port date. Dedup via brain.proactive_sent so a restart
// mid-day never double-sends.

const cron = require('node-cron');
const { loadBookings, loadWorkflow, mutateBrain, loadBrain,
        mutateJson, loadHistory } = require('./helpers/json');
const { daysUntil, getLADate }    = require('./helpers/time');
const { getUrgentBookings }       = require('./helpers/booking');
const { stepLabel }               = require('./helpers/booking');
const { pushAlert }               = require('./alerts');
const cfg = require('./config');

let _sendToManager = async () => {}, _sendToTeam = async () => {};
function init({ sendToManager, sendToTeam }) {
    _sendToManager = sendToManager;
    _sendToTeam    = sendToTeam;
}

const TZ = { timezone: 'America/Los_Angeles' };
const todayKey = () => getLADate().toDateString();

async function markSent(key) { await mutateBrain(b => { b.proactive_sent[key] = new Date().toISOString(); }); }
const alreadySent = (key) => !!loadBrain().proactive_sent[key];

// ── 8AM — morning digest ──────────────────────────────────────────────────────
async function morningDigest() {
    const key = `daily_digest_${todayKey()}`;
    if (alreadySent(key)) return;

    const bookings = loadBookings();
    const workflow = loadWorkflow();
    const active   = Object.values(bookings);
    if (!active.length) return;

    const urgent = getUrgentBookings();
    const stuck  = Object.entries(workflow).filter(([bkgNo, wf]) => {
        if (!bookings[bkgNo] || cfg.TERMINAL_STEPS.includes(wf.step)) return false;
        const last = new Date(wf.updated_at || wf.created_at || 0).getTime();
        return Date.now() - last > 2 * 86400000; // no movement in 48h
    });

    const lines = [
        `Morning digest — ${active.length} active booking(s)`,
        '',
        urgent.length ? 'URGENT CUTOFFS:' : 'No urgent cutoffs.',
        ...urgent.map(b => `- ${b.booking_number} cutoff ${b.cutoff_date} (${daysUntil(b.cutoff_date)}d) — ${stepLabel(workflow[b.booking_number]?.step)}`),
    ];
    if (stuck.length) {
        lines.push('', 'STUCK (48h+ no movement):');
        lines.push(...stuck.map(([bkgNo, wf]) => `- ${bkgNo} at ${stepLabel(wf.step)}`));
    }

    await _sendToManager(lines.join('\n'));
    await markSent(key);
    console.log('[SCHED] Morning digest sent');
}

// ── Hourly 9–17 — urgent cutoff watch ─────────────────────────────────────────
async function urgentWatch() {
    const workflow = loadWorkflow();
    for (const b of getUrgentBookings()) {
        const wf = workflow[b.booking_number] || {};
        if (cfg.TERMINAL_STEPS.includes(wf.step)) continue;

        const d   = daysUntil(b.cutoff_date);
        const key = `urgent_${b.booking_number}_${todayKey()}`;
        if (alreadySent(key)) continue;

        await pushAlert({
            type    : 'cutoff_risk',
            bkgNo   : b.booking_number,
            message : `${b.booking_number}: cutoff in ${d}d, still at "${stepLabel(wf.step)}"`,
            severity: d <= 1 ? 'high' : 'warning',
        });
        if (d <= 1) await _sendToTeam(`${b.booking_number}: cutoff TOMORROW and still at "${stepLabel(wf.step)}". Escalate now.`);
        await markSent(key);
    }
}

// ── 11PM — auto-archive (cutoff passed yesterday, no ingate, not kept) ────────
async function autoArchive() {
    const bookings = loadBookings();
    const workflow = loadWorkflow();
    const archived = [];

    for (const [bkgNo, b] of Object.entries(bookings)) {
        if (!b.cutoff_date) continue;
        const d  = daysUntil(b.cutoff_date);
        const wf = workflow[bkgNo] || {};
        if (d !== -1) continue;                                  // exactly one day past — older ones handled in earlier runs
        if (cfg.TERMINAL_STEPS.includes(wf.step)) continue;
        if (wf.keep_active) continue;

        await mutateJson(cfg.HISTORY_FILE, {}, (h) => {
            h[bkgNo] = { ...b, archived_at: new Date().toISOString(), archive_reason: 'cutoff_passed_auto', final_step: wf.step || 'not_started' };
            return h;
        });
        await mutateJson(cfg.BOOKINGS_FILE, {}, (x) => { delete x[bkgNo]; return x; });
        await mutateJson(cfg.WORKFLOW_FILE, {}, (x) => { delete x[bkgNo]; return x; });
        archived.push(bkgNo);
    }

    if (!archived.length) return;
    const msg = [`Auto-archived ${archived.length} booking(s):`, ...archived, '', 'Cutoff passed with no ingate. See dashboard → history.'].join('\n');
    await _sendToTeam(msg);
    await _sendToManager(msg);
    await pushAlert({ type: 'auto_archived', bkgNo: null, message: `Auto-archived: ${archived.join(', ')}`, severity: 'info' });
}

function start() {
    cron.schedule('0 8 * * *',    () => morningDigest().catch(e => console.error('[SCHED] digest:', e)), TZ);
    cron.schedule('0 9-17 * * *', () => urgentWatch().catch(e => console.error('[SCHED] urgent:', e)),   TZ);
    cron.schedule('0 23 * * *',   () => autoArchive().catch(e => console.error('[SCHED] archive:', e)),  TZ);
    console.log('[SCHED] Jobs registered (8AM digest, hourly urgent 9-17, 11PM archive — LA time)');
}

module.exports = { init, start, morningDigest, urgentWatch, autoArchive };
