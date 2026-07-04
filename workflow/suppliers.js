// ── workflow/suppliers.js — Supplier identity + chat routing ─────────────────
// Same identity rules as truckers: group_id first, @c.us only, @lid ignored.

const { loadSuppliers, loadWorkflow, loadBookings } = require('../helpers/json');
const cfg = require('../config');

const digits = (v) => String(v || '').replace(/\D/g, '');

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
    const suppliers = loadSuppliers();
    if (!suppliers.length) return { text: 'No suppliers registered. Add one from the dashboard first.', list: [] };
    const lines = suppliers.map((s, i) => `${i + 1}. ${s.name}${s.group_id ? '' : ' (DM)'}`);
    return {
        text: [`Assign supplier to ${bkgNo} — which one?`, '', ...lines, '', 'Reply with a number or name.'].join('\n'),
        list: suppliers,
    };
}

module.exports = {
    matchSupplierByChat, getSupplierChatId, getSupplier,
    getSupplierGroupIdForBooking, buildSupplierSelectionMessage,
};
