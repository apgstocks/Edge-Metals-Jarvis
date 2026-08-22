// ── workflow/truckers.js — Trucker identity + chat routing ───────────────────
// RULE (established, do not weaken): match by group_id if present; otherwise
// match ONLY @c.us numbers. @lid linked-device IDs are never used for identity.
// v2: loadTruckers/loadBookings are now DB-backed (Supabase) and async —
// every function here is now async as a result. All callers updated to match.

const { loadTruckers, loadWorkflow, loadBookings } = require('../helpers/json');
const { findByNormalizedName } = require('../helpers/nameMatch');
const cfg = require('../config');

const digits = (v) => String(v || '').replace(/\D/g, '');

// Locality match — mirror of dashboard/index.html localityMatchesPort.
// If either side is empty, no match (strict: unknown locality is not "any port").
function localityMatchesPort(loc, port) {
    const l = String(loc || '').toLowerCase().trim().replace(/\s+/g, ' ');
    const p = String(port || '').toLowerCase().trim().replace(/\s+/g, ' ');
    if (!l || !p) return false;
    return l.includes(p) || p.includes(l);
}

// Identify which trucker a chat/sender belongs to. Returns trucker object or null.
async function matchTruckerByChat(chatId, senderNumber) {
    const truckers = await loadTruckers();

    // 1. Group match — strongest signal
    const byGroup = truckers.find(t => t.group_id && t.group_id === chatId);
    if (byGroup) return byGroup;

    // 2. Direct chat — @c.us only, never @lid
    if (String(chatId).endsWith('@c.us')) {
        const num = digits(chatId);
        const byChat = truckers.find(t => digits(t.whatsapp) === num);
        if (byChat) return byChat;
    }

    // 3. Sender inside a non-registered group — @c.us format only
    if (senderNumber && !String(senderNumber).includes('@lid')) {
        const num = digits(senderNumber);
        if (num) return truckers.find(t => digits(t.whatsapp) === num) || null;
    }
    return null;
}

// Where do we message this trucker? group → personal DM → default trucker group
async function getTruckerChatId(truckerName) {
    if (!truckerName) return cfg.GROUP_TRUCKER;
    const all = await loadTruckers();
    const t = all.find(x => (x.name || '').toLowerCase() === truckerName.toLowerCase());
    if (!t) return cfg.GROUP_TRUCKER;
    if (t.group_id) return t.group_id;
    if (t.whatsapp) return digits(t.whatsapp) + '@c.us';
    console.log(`[TRUCKERS] "${truckerName}" has no group and no number — default group`);
    return cfg.GROUP_TRUCKER;
}

async function getTrucker(truckerName) {
    const all = await loadTruckers();
    return all.find(x => (x.name || '').toLowerCase() === String(truckerName || '').toLowerCase()) || null;
}

// ── ALL matches by name (for smartAssign) — see suppliers.js's getSuppliersByName
// for the full reasoning, identical here.
async function getTruckersByName(name) {
    const lower = String(name || '').trim().toLowerCase();
    if (!lower) return [];
    const all = await loadTruckers();
    const exact = all.filter(x => (x.name || '').toLowerCase() === lower);
    if (exact.length) return exact;
    const sub = all.filter(x => (x.name || '').toLowerCase().includes(lower));
    if (sub.length) return sub;
    // See helpers/nameMatch.js — spacing/punctuation-tolerant last resort.
    return findByNormalizedName(all, name);
}

async function getTruckerGroupIdForBooking(bkgNo) {
    const wf = loadWorkflow()[bkgNo] || {};
    if (wf.trucker_group_id) return wf.trucker_group_id;
    const bookings = loadBookings();
    return getTruckerChatId(wf.trucker_name || bookings[bkgNo]?.trucker || '');
}

// Numbered list for manager selection (policy resolves the reply by index/name).
// Strict locality: only offer truckers whose locality matches the booking's POL.
async function buildTruckerSelectionMessage(bkgNo) {
    const all = await loadTruckers();
    if (!all.length) return { text: 'No truckers registered. Add one from the dashboard first.', list: [] };

    const port = loadBookings()[bkgNo]?.port_of_loading || '';
    const truckers = port ? all.filter(t => localityMatchesPort(t.locality, port)) : all;

    if (!truckers.length) {
        return {
            text: `No trucker registered at ${port}. Add one from the dashboard (Truckers tab) with locality "${port}" first.`,
            list: [],
        };
    }
    const header = port ? `Forward ${bkgNo} (${port}) — which trucker?` : `Forward ${bkgNo} — which trucker?`;
    const lines = truckers.map((t, i) => `${i + 1}. ${t.name}${t.group_id ? '' : ' (DM)'}`);
    return {
        text: [header, '', ...lines, '', 'Reply with a number or name.'].join('\n'),
        list: truckers,
    };
}

// Same resolution logic as suppliers.js's resolveDefaultSupplier — see there
// for the full reasoning.
async function resolveDefaultTrucker(port) {
    const all = await loadTruckers();
    const matches = all.filter(t => localityMatchesPort(t.locality, port));
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    return matches.find(t => t.is_default) || null;
}

module.exports = {
    matchTruckerByChat, getTruckerChatId, getTrucker, getTruckersByName,
    getTruckerGroupIdForBooking, buildTruckerSelectionMessage, resolveDefaultTrucker,
};