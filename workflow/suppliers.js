// ── workflow/suppliers.js — Supplier identity + chat routing ─────────────────
// Same identity rules as truckers: group_id first, @c.us only, @lid ignored.
// v2: loadSuppliers/loadBookings are now DB-backed (Supabase) and async —
// every function here is now async as a result. All callers updated to match.

const { loadSuppliers, loadWorkflow, loadBookings } = require('../helpers/json');
const cfg = require('../config');

const digits = (v) => String(v || '').replace(/\D/g, '');

// Locality match — mirror of dashboard/index.html localityMatchesPort.
function localityMatchesPort(loc, port) {
    const l = String(loc || '').toLowerCase().trim().replace(/\s+/g, ' ');
    const p = String(port || '').toLowerCase().trim().replace(/\s+/g, ' ');
    if (!l || !p) return false;
    return l.includes(p) || p.includes(l);
}

async function matchSupplierByChat(chatId, senderNumber) {
    const suppliers = await loadSuppliers();

    const byGroup = suppliers.find(s => s.group_id && s.group_id === chatId);
    if (byGroup) return byGroup;

    if (String(chatId).endsWith('@c.us')) {
        const num = digits(chatId);
        const byChat = suppliers.find(s => digits(s.whatsapp) === num);
        if (byChat) return byChat;
    }

    if (senderNumber && !String(senderNumber).includes('@lid')) {
        const num = digits(senderNumber);
        if (num) return suppliers.find(s => digits(s.whatsapp) === num) || null;
    }
    return null;
}

async function getSupplierChatId(supplierName) {
    if (!supplierName) return cfg.GROUP_SUPPLIER;
    const all = await loadSuppliers();
    const s = all.find(x => (x.name || '').toLowerCase() === supplierName.toLowerCase());
    if (!s) return cfg.GROUP_SUPPLIER;
    if (s.group_id) return s.group_id;
    if (s.whatsapp) return digits(s.whatsapp) + '@c.us';
    console.log(`[SUPPLIERS] "${supplierName}" has no group and no number — default group`);
    return cfg.GROUP_SUPPLIER;
}

async function getSupplier(supplierName) {
    const all = await loadSuppliers();
    return all.find(x => (x.name || '').toLowerCase() === String(supplierName || '').toLowerCase()) || null;
}

async function getSupplierGroupIdForBooking(bkgNo) {
    const wf = loadWorkflow()[bkgNo] || {};
    if (wf.supplier_group_id) return wf.supplier_group_id;
    const name = wf.supplier || loadBookings()[bkgNo]?.supplier || '';
    return getSupplierChatId(name);
}

async function buildSupplierSelectionMessage(bkgNo) {
    const all = await loadSuppliers();
    if (!all.length) return { text: 'No suppliers registered. Add one from the dashboard first.', list: [] };

    const port = loadBookings()[bkgNo]?.port_of_loading || '';
    const suppliers = port ? all.filter(s => localityMatchesPort(s.locality, port)) : all;

    if (!suppliers.length) {
        return {
            text: `No supplier registered at ${port}. Add one from the dashboard (Suppliers tab) with locality "${port}" first.`,
            list: [],
        };
    }
    const header = port ? `Assign supplier to ${bkgNo} (${port}) — which one?` : `Assign supplier to ${bkgNo} — which one?`;
    const lines = suppliers.map((s, i) => `${i + 1}. ${s.name}${s.group_id ? '' : ' (DM)'}`);
    return {
        text: [header, '', ...lines, '', 'Reply with a number or name.'].join('\n'),
        list: suppliers,
    };
}

// Resolve a supplier for a given port WITHOUT asking, if possible:
//   - exactly one registered supplier at that locality → use it
//   - multiple, one explicitly flagged is_default → use that one
//   - multiple, none flagged → return null (genuinely needs asking)
async function resolveDefaultSupplier(port) {
    const all = await loadSuppliers();
    const matches = all.filter(s => localityMatchesPort(s.locality, port));
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    return matches.find(s => s.is_default) || null;
}

module.exports = {
    matchSupplierByChat, getSupplierChatId, getSupplier,
    getSupplierGroupIdForBooking, buildSupplierSelectionMessage, resolveDefaultSupplier,
};