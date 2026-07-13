// ── workflow/truckers.js — Trucker identity + chat routing ───────────────────
// RULE (established, do not weaken): match by group_id if present; otherwise
// match ONLY @c.us numbers. @lid linked-device IDs are never used for identity.

const { loadTruckers, loadWorkflow, loadBookings } = require('../helpers/json');
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
function matchTruckerByChat(chatId, senderNumber) {
    const truckers = loadTruckers();

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
function getTruckerChatId(truckerName) {
    if (!truckerName) return cfg.GROUP_TRUCKER;
    const t = loadTruckers().find(x => (x.name || '').toLowerCase() === truckerName.toLowerCase());
    if (!t) return cfg.GROUP_TRUCKER;
    if (t.group_id) return t.group_id;
    if (t.whatsapp) return digits(t.whatsapp) + '@c.us';
    console.log(`[TRUCKERS] "${truckerName}" has no group and no number — default group`);
    return cfg.GROUP_TRUCKER;
}

function getTrucker(truckerName) {
    return loadTruckers().find(x => (x.name || '').toLowerCase() === String(truckerName || '').toLowerCase()) || null;
}

function getTruckerGroupIdForBooking(bkgNo) {
    const wf = loadWorkflow()[bkgNo] || {};
    if (wf.trucker_group_id) return wf.trucker_group_id;
    return getTruckerChatId(wf.trucker_name || loadBookings()[bkgNo]?.trucker || '');
}

// Numbered list for manager selection (policy resolves the reply by index/name).
// Strict locality: only offer truckers whose locality matches the booking's POL.
function buildTruckerSelectionMessage(bkgNo) {
    const all = loadTruckers();
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

module.exports = {
    matchTruckerByChat, getTruckerChatId, getTrucker,
    getTruckerGroupIdForBooking, buildTruckerSelectionMessage,
};