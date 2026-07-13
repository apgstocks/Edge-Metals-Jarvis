// ── workflow/suppliers.js — Supplier identity + chat routing ─────────────────
// Same identity rules as truckers: group_id first, @c.us only, @lid ignored.

const { loadSuppliers, loadWorkflow, loadBookings } = require('../helpers/json');
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

function matchSupplierByChat(chatId, senderNumber) {
    const suppliers = loadSuppliers();

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

function getSupplierChatId(supplierName) {
    if (!supplierName) return cfg.GROUP_SUPPLIER;
    const s = loadSuppliers().find(x => (x.name || '').toLowerCase() === supplierName.toLowerCase());
    if (!s) return cfg.GROUP_SUPPLIER;
    if (s.group_id) return s.group_id;
    if (s.whatsapp) return digits(s.whatsapp) + '@c.us';
    console.log(`[SUPPLIERS] "${supplierName}" has no group and no number — default group`);
    return cfg.GROUP_SUPPLIER;
}

function getSupplier(supplierName) {
    return loadSuppliers().find(x => (x.name || '').toLowerCase() === String(supplierName || '').toLowerCase()) || null;
}

function getSupplierGroupIdForBooking(bkgNo) {
    const wf = loadWorkflow()[bkgNo] || {};
    if (wf.supplier_group_id) return wf.supplier_group_id;
    const name = wf.supplier || loadBookings()[bkgNo]?.supplier || '';
    return getSupplierChatId(name);
}

function buildSupplierSelectionMessage(bkgNo) {
    const all = loadSuppliers();
    if (!all.length) return { text: 'No suppliers registered. Add one from the dashboard first.', list: [] };

    const port = loadBookings()[bkgNo]?.port_of_loading || '';
    // Strict: if POL is set, only offer suppliers at that port.
    // If POL is empty (unlikely but defensive), offer all.
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

module.exports = {
    matchSupplierByChat, getSupplierChatId, getSupplier,
    getSupplierGroupIdForBooking, buildSupplierSelectionMessage,
};