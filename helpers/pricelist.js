// ── helpers/pricelist.js — Price list formatting, contacts, change detection ─
// Reads the Google Sheet via helpers/sheets.js, formats a WhatsApp-friendly
// message, tracks a snapshot to detect real price changes (not just any edit
// to the sheet — someone fixing a typo in an unrelated cell shouldn't fire a
// blast to 3 people), and sends via the sendMessage primitive injected from
// index.js (same pattern as alerts.js / workflow/actions.js / scheduler.js).

const fs  = require('fs');
const cfg = require('../config');
const { readPriceSheet } = require('./sheets');
const { loadJson, mutateJson } = require('./json');

// ── Messaging injected at boot by index.js (same wiring pattern as actions.js) ─
let _send = async () => { console.warn('[PRICELIST] sendMessage not wired yet'); return false; };
function init({ sendMessage }) {
    if (sendMessage) _send = sendMessage;
}

// ── Contacts (the "3 people" + anyone added ad hoc) ──────────────────────────
// Deliberately its own file, NOT truckers.json/suppliers.json — recipients of
// a price list (buyers/customers) are a different concern from operational
// trucker/supplier contacts, even if some names overlap.
function loadContacts() {
    return loadJson(cfg.PRICELIST_CONTACTS_FILE, []);
}

async function addContact(name, whatsapp, standing = false) {
    if (!name || !whatsapp) throw new Error('name and whatsapp required');
    const digits = String(whatsapp).replace(/\D/g, '');
    if (digits.length < 8) throw new Error('whatsapp number looks invalid');
    await mutateJson(cfg.PRICELIST_CONTACTS_FILE, [], (list) => {
        const i = list.findIndex(x => x.name.toLowerCase() === name.toLowerCase());
        const entry = { name, whatsapp: digits, standing: !!standing };
        if (i >= 0) list[i] = { ...list[i], ...entry };
        else list.push(entry);
        return list;
    });
    return true;
}

async function removeContact(name) {
    await mutateJson(cfg.PRICELIST_CONTACTS_FILE, [], (list) =>
        list.filter(x => x.name.toLowerCase() !== String(name).toLowerCase()));
}

// Resolve "whoever I tell" — either a raw phone number, or a saved contact name
// (exact match first, then substring, mirroring getTruckersByName's pattern).
function resolveTarget(nameOrNumber) {
    const raw = String(nameOrNumber || '').trim();
    if (!raw) return null;

    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 8 && digits.length === raw.replace(/[\s()+-]/g, '').length) {
        return { chatId: digits + '@c.us', label: raw };
    }

    const contacts = loadContacts();
    const exact = contacts.find(c => c.name.toLowerCase() === raw.toLowerCase());
    if (exact) return { chatId: exact.whatsapp + '@c.us', label: exact.name };

    const partial = contacts.find(c => c.name.toLowerCase().includes(raw.toLowerCase()));
    if (partial) return { chatId: partial.whatsapp + '@c.us', label: partial.name };

    return null;
}

// The 3 (or however many) standing recipients who get auto-notified on change.
function standingContacts() {
    return loadContacts().filter(c => c.standing);
}

// ── Formatting ────────────────────────────────────────────────────────────────
function formatPriceList(data, { title = 'Edge Metals — Price List' } = {}) {
    const lines = [title, `Updated: ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} (LA time)`, ''];
    for (const [city, rows] of Object.entries(data)) {
        if (!rows.length) continue;
        lines.push(`*${city}*`);
        for (const r of rows) {
            lines.push(`${r.item}  ${r.priceRaw}`);
        }
        lines.push('');
    }
    return lines.join('\n').trim();
}

// ── Send current price list to one resolved target ───────────────────────────
async function sendPriceListTo(nameOrNumber) {
    const target = resolveTarget(nameOrNumber);
    if (!target) return { ok: false, reason: 'not_found' };
    const data = await readPriceSheet();
    const text = formatPriceList(data);
    const ok = await _send(target.chatId, text);
    return { ok, target: target.label };
}

// ── Change detection ──────────────────────────────────────────────────────────
// Snapshot = last-known {city: [{item, priceRaw}]}. Diffs on item+priceRaw only
// (ignores row order / unrelated columns). Returns a human-readable diff list,
// or [] if nothing that matters changed.
function diffPriceData(oldData, newData) {
    const changes = [];
    const cities = new Set([...Object.keys(oldData || {}), ...Object.keys(newData || {})]);
    for (const city of cities) {
        const oldRows = new Map((oldData?.[city] || []).map(r => [r.item, r.priceRaw]));
        const newRows = new Map((newData?.[city] || []).map(r => [r.item, r.priceRaw]));
        for (const [item, price] of newRows) {
            if (!oldRows.has(item)) changes.push(`${city}: ${item} added at ${price}`);
            else if (oldRows.get(item) !== price) changes.push(`${city}: ${item} ${oldRows.get(item)} → ${price}`);
        }
        for (const [item] of oldRows) {
            if (!newRows.has(item)) changes.push(`${city}: ${item} removed`);
        }
    }
    return changes;
}

// Called by the Apps Script webhook AND by the daily fallback cron. Reads the
// sheet fresh, diffs against the stored snapshot, and — only if something
// actually changed — sends the full updated list to every standing contact
// and saves the new snapshot. Fails soft: sheet-read errors are thrown to the
// caller (webhook route logs + returns 500; cron route catches and logs).
async function checkForChangesAndNotify() {
    const newData = await readPriceSheet();
    const oldData = loadJson(cfg.PRICELIST_SNAPSHOT_FILE, null);

    if (!oldData) {
        // First run ever — establish the baseline, don't blast anyone.
        await mutateJson(cfg.PRICELIST_SNAPSHOT_FILE, {}, () => newData);
        return { changed: false, first_run: true };
    }

    const changes = diffPriceData(oldData, newData);
    if (!changes.length) return { changed: false };

    const contacts = standingContacts();
    const text = formatPriceList(newData) + '\n\n_Changed: ' + changes.join('; ') + '_';
    const results = [];
    for (const c of contacts) {
        const ok = await _send(c.whatsapp + '@c.us', text);
        results.push({ name: c.name, ok });
    }

    await mutateJson(cfg.PRICELIST_SNAPSHOT_FILE, {}, () => newData);
    return { changed: true, changes, notified: results };
}

module.exports = {
    init, loadContacts, addContact, removeContact,
    resolveTarget, standingContacts, formatPriceList,
    sendPriceListTo, diffPriceData, checkForChangesAndNotify,
};