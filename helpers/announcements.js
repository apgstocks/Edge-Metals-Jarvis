// ── helpers/announcements.js — Jarvis speaks up on its own ─────────────────
//
// Apsara, 2026-09-20: picked "Jarvis speaks up on its own" — while the
// dashboard is open, the things that today only reach her on WhatsApp are
// SAID. Edge Metals only, by her rule ("yard has no scope in jarvis"): the
// sources below are the alert history (bookings, cutoffs, stalls, quotes,
// mail — all Metals or system) and Metals customer receipts. Nothing from
// loads, petty cash, yard payments or outbound loads.
//
// What is worth interrupting her for is deliberately narrow:
//   · alerts at severity 'high' or 'warning' — never 'info' (a forward she
//     did herself, an auto-archive) — and never one she snoozed or muted;
//   · a payment received.
// At most three are spoken at once; the rest are counted, not read out.
// A first poll returns NOTHING but the cursor, so opening the dashboard in
// the morning does not replay yesterday.

const cfg = require('../config');
const { loadJson } = require('./json');

const MAX_SPOKEN = 3;
const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');

function suppressed(state, a) {
    if (a.bkgNo && state.muted && state.muted[a.bkgNo]) return true;
    const until = state.snoozed && state.snoozed[`${a.type}:${a.bkgNo || 'global'}`];
    return !!(until && Date.parse(until) > Date.now());
}

function collect(sinceMs) {
    const out = [];
    const state = loadJson(cfg.ALERTS_FILE, { snoozed: {}, muted: {}, history: [] }) || {};
    for (const a of state.history || []) {
        const at = Date.parse(a.at || '');
        if (!Number.isFinite(at) || at <= sinceMs) continue;
        if (a.severity !== 'high' && a.severity !== 'warning') continue;
        if (suppressed(state, a)) continue;
        out.push({ id: `alert:${a.at}:${a.type}:${a.bkgNo || ''}`, at, kind: a.type || 'alert',
            urgent: a.severity === 'high', text: String(a.message || '').trim() });
    }
    try {
        for (const r of require('./salesReceipts').list() || []) {
            const at = Date.parse(r.created_at || '');
            if (!Number.isFinite(at) || at <= sinceMs) continue;
            out.push({ id: `receipt:${r.id}`, at, kind: 'payment', urgent: false,
                text: `Payment in: ${money(r.amount)} from ${r.customer}${r.mode ? ` by ${r.mode}` : ''}.` });
        }
    } catch (e) { /* no receipts store */ }
    return out.filter((x) => x.text).sort((x, y) => (y.urgent - x.urgent) || (x.at - y.at));
}

// since: ISO string or null. Returns { now, items, spoken, screen }.
function poll(since, now = Date.now()) {
    const sinceMs = Date.parse(since || '');
    if (!Number.isFinite(sinceMs)) return { now: new Date(now).toISOString(), items: [], spoken: '', screen: '' };
    const all = collect(sinceMs).filter((x) => x.at <= now);
    if (!all.length) return { now: new Date(now).toISOString(), items: [], spoken: '', screen: '' };
    const { forSpeech } = require('./spokenAnswer');
    const head = all.slice(0, MAX_SPOKEN);
    const rest = all.length - head.length;
    const spoken = ['Heads up.', ...head.map((x) => forSpeech(x.text.replace(/\s+—\s+/g, '. ')))]
        .concat(rest ? [`And ${rest} more on the board.`] : []).join(' ');
    const screen = all.map((x) => `• ${x.text}`).join('\n');
    return { now: new Date(now).toISOString(), items: all, spoken, screen };
}

// "Jarvis, stop announcements" / "announcements on"
function toggleIn(text) {
    const t = String(text || '').toLowerCase().replace(/[.!?]+$/, '').trim()
        .replace(/^(?:(?:ok(?:ay)?|hey|jarvis|please)[,\s]+)+/, '');
    const NOUN = '(?:announcements?|alerts?|updates|notifications|speaking\\s+up)';
    if (new RegExp(`^(?:turn\\s+off|stop|mute|pause|disable|no\\s+more|quiet)\\s+(?:the\\s+|your\\s+)?${NOUN}$|^${NOUN}\\s+off$|^stop\\s+speaking\\s+up$|^don'?t\\s+(?:speak\\s+up|interrupt\\s+me)$`).test(t)) return 'off';
    if (new RegExp(`^(?:turn\\s+on|start|unmute|resume|enable)\\s+(?:the\\s+|your\\s+)?${NOUN}$|^${NOUN}\\s+on$|^(?:you\\s+can\\s+)?speak\\s+up(?:\\s+again)?$`).test(t)) return 'on';
    return null;
}

module.exports = { poll, collect, toggleIn, MAX_SPOKEN };
