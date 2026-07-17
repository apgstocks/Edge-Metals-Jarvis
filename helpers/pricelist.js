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
// _getBrowser resolves the SAME Puppeteer browser instance whatsapp-web.js
// already runs for the WhatsApp Web connection (client.pupBrowser). Injected
// as a getter, not a value, because it doesn't exist yet at boot time — only
// once client.initialize() has actually launched Chromium. Used only by
// renderPriceListImage() below; every other function in this file works
// without it.
let _getBrowser = () => null;
function init({ sendMessage, getBrowser } = {}) {
    if (sendMessage) _send = sendMessage;
    if (getBrowser) _getBrowser = getBrowser;
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

// ── Text formatting (fallback path — see renderPriceListImage for primary) ───
// WhatsApp renders normal text with a proportional font, so plain space-padding
// never lines up — "Auto cast" and "Al rims(Dirty)" take different pixel widths
// even with the same number of spaces after them. Wrapping the block in a
// ```triple-backtick``` fence forces WhatsApp to render it in its fixed-width
// font, so padding every item name to the same character width lines the
// prices up in a column — on WhatsApp Web. Confirmed on-device that WhatsApp
// Android's monospace/code-block renderer injects extra spacing into price
// digits that plain (non-code-block) text does not get, and that survived a
// zero-width-character workaround — so this text path is kept only as a
// fallback for when image rendering isn't available (see below), not as the
// primary way prices get sent.
function formatPriceRows(rows) {
    if (!rows.length) return '';
    // Google Sheets copy/paste routinely smuggles in non-breaking spaces, tabs,
    // or other invisible whitespace inside cell text — invisible in a normal
    // font, but a phone's monospace fallback font can render e.g. an NBSP at a
    // different width than a plain ASCII space, throwing off padEnd() columns.
    const clean = s => String(s).replace(/[\s\u00A0\u200B\u2007\u202F]+/g, ' ').trim();
    const items = rows.map(r => clean(r.item));
    const width = Math.max(...items.map(s => s.length)) + 2;
    return '```\n' + rows.map((r, i) => `${items[i].padEnd(width)}${clean(r.priceRaw)}`).join('\n') + '\n```';
}

function formatPriceList(data, { title = 'Edge Metals — Price List' } = {}) {
    const lines = [title, `Updated: ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} (LA time)`, ''];
    for (const [city, rows] of Object.entries(data)) {
        if (!rows.length) continue;
        lines.push(`*${city}*`);
        lines.push(formatPriceRows(rows));
        lines.push('');
    }
    return lines.join('\n').trim();
}

// ── Image rendering (primary path — guaranteed cross-client alignment) ───────
// A PNG looks pixel-identical on every WhatsApp client: no font substitution,
// no on-device text classifier, nothing left to differ between Web and
// mobile. Renders via the SAME Chromium instance whatsapp-web.js already
// runs (client.pupBrowser, injected through init() above) — no new
// dependency, no second browser process. Throws if the browser isn't
// available yet (e.g. WhatsApp still reconnecting); callers catch that and
// fall back to the text path.
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function renderPriceListImage(rows, title, subtitle) {
    const browser = _getBrowser();
    if (!browser) throw new Error('WhatsApp browser not ready — cannot render price list image');

    const rowsHtml = rows.map(r => `
        <tr>
            <td class="item">${escapeHtml(r.item)}</td>
            <td class="price">${escapeHtml(r.priceRaw)}</td>
        </tr>`).join('');

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; background: #ffffff; padding: 24px; width: 480px; }
    h1 { font-size: 22px; color: #111111; margin-bottom: 4px; }
    .subtitle { font-size: 13px; color: #666666; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 8px 4px; font-size: 16px; border-bottom: 1px solid #eeeeee; }
    .item { color: #222222; text-align: left; }
    .price { color: #111111; font-weight: 700; text-align: right; white-space: nowrap; padding-left: 16px; }
    tr:last-child td { border-bottom: none; }
</style></head>
<body>
    <h1>${escapeHtml(title)}</h1>
    <div class="subtitle">${escapeHtml(subtitle)}</div>
    <table>${rowsHtml}</table>
</body></html>`;

    const page = await browser.newPage();
    try {
        await page.setViewport({ width: 480, height: 100 });
        await page.setContent(html, { waitUntil: 'domcontentloaded' });
        const base64 = await page.screenshot({ type: 'png', fullPage: true, encoding: 'base64' });
        return base64;
    } finally {
        await page.close().catch(() => {});
    }
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

// ── Single-city variant — "send price list" now asks which city first ───────
// city must be one of PRICE_TABS' exact strings (brain.js resolves the user's
// reply — a number or partial name — against that list before calling this).
function formatSingleCity(data, city) {
    const rows = data[city] || [];
    const lines = [`*Edge Metals — ${city} Price List*`,
        `Updated: ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} (LA time)`, ''];
    if (!rows.length) return lines.concat(['(no items found for this sheet)']).join('\n');
    lines.push(formatPriceRows(rows));
    return lines.join('\n');
}

// targetNameOrNumber may be null — in that case send back to fallbackChatId
// (the chat that asked), which is the common case for "send price list" with
// no recipient specified. Tries the image path first (see
// renderPriceListImage); falls back to the old text format if the browser
// isn't ready or rendering fails for any reason, so this never hard-fails
// just because the image path had a bad moment.
async function sendPriceListCityTo(targetNameOrNumber, city, fallbackChatId) {
    const data = await readPriceSheet();
    const rows = data[city] || [];
    const updatedLine = `Updated: ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} (LA time)`;

    let media = null;
    let text = null;
    if (rows.length) {
        try {
            const base64 = await renderPriceListImage(rows, `Edge Metals — ${city} Price List`, updatedLine);
            media = { mimetype: 'image/png', base64, filename: `${city.replace(/\s+/g, '_')}_pricelist.png` };
        } catch (err) {
            console.warn('[PRICELIST] Image render failed, falling back to text:', err.message);
        }
    }
    if (!media) {
        text = formatSingleCity(data, city);
    }

    if (!targetNameOrNumber) {
        const ok = await _send(fallbackChatId, text, media);
        return { ok, target: 'you' };
    }
    const target = resolveTarget(targetNameOrNumber);
    if (!target) return { ok: false, reason: 'not_found' };
    const ok = await _send(target.chatId, text, media);
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
    formatSingleCity, sendPriceListCityTo,
};
