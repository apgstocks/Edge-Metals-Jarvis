// ── helpers/proformaPricing.js — Customer pricing memory for the Proforma tab ──
// Added 2026-08-19 as part of the Documents (Invoice/Proforma/Verification)
// build-out. Ported from the already-built-and-tested `customer_pricing.py`
// in the separate Flask app (apgstocks/Edge-internal), rewired to this
// repo's storage conventions:
//   - file I/O goes through helpers/json.js's loadJson/saveJson/mutateJson
//     (proper-lockfile based) instead of raw fs + os.replace, matching every
//     other JSON store in this codebase (bookings, workflow, address book…)
//   - the file path comes from cfg.PROFORMA_PRICING_FILE (config.js), not a
//     hardcoded path next to this module
//
// Standalone module — does not touch bookings.json, workflow, or any other
// existing store, so it can't break anything already working.
//
// This is deliberately narrower than a full "customer profile" store: buyer
// ADDRESSES already have a working source of truth in this repo
// (helpers/addressBook.js, backed by the Google Doc at cfg.ADDRESS_BOOK_DOC_ID).
// Duplicating that here would create two places address data could drift out
// of sync. What's genuinely missing is PER-ITEM PRICE HISTORY per customer —
// so that's the only thing this module owns: customer name -> {trade terms,
// port of discharge, {item description -> last rate}}.
//
// Data model (proforma_pricing.json, created on first save):
// {
//   "customers": {
//     "<NORMALIZED NAME>": {
//       "canonical_name": "Taewon Automotive Co., Ltd.",
//       "trade_terms": "TT CIF Busan, South Korea",
//       "port_discharge": "Busan, South Korea",
//       "items": {
//         "<NORMALIZED ITEM DESC>": {
//           "display_desc": "AL Combo",
//           "rate": 1150.0,
//           "unit": "MT",
//           "updated_at": "2026-08-19"
//         }
//       }
//     }
//   }
// }

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

const DEFAULT_STORE = { customers: {} };

// Product-name vocabulary lifted from this repo's existing Gemini prompts in
// helpers/gemini.js, so the paste-in parser recognizes the same names this
// system already uses elsewhere — not a separate vocabulary that silently
// fails to match. Kept identical to the Flask app's list for continuity;
// extend here (not in two places) if new item types come up.
const KNOWN_ITEM_NAMES = [
    'AL Combo', 'Aluminium Combo', 'Regular Combo', 'Steel/Reg Combo',
    'Auto Cast', 'Scrap Auto Parts', 'Aluminium Wheels', 'Chrome Wheels',
    'Harness Wire', 'Taint Tabour', 'Mixed Load', 'Sealed Units',
    'Mixed Motors', 'Rotors and Drums', 'Mixed Combo', 'Battery',
];
const KNOWN_TERMS_TOKENS = ['CIF', 'FOB', 'CFR', 'CNF', 'EXW', 'DDP', 'DAP', 'FAS', 'TT'];

function norm(s) {
    return String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

// Item description matching is intentionally looser than customer-name
// matching: "AL Combo", "AL COMBO", "Al  combo" should all hit the same
// saved price, since the item field is free text, not a fixed dropdown.
function normItem(s) {
    return String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

function load() {
    return loadJson(cfg.PROFORMA_PRICING_FILE, DEFAULT_STORE);
}

function listCustomers() {
    const data = load();
    const out = Object.entries(data.customers || {}).map(([key, c]) => ({
        key,
        canonical_name: c.canonical_name || key,
        item_count: Object.keys(c.items || {}).length,
    }));
    out.sort((a, b) => a.canonical_name.localeCompare(b.canonical_name));
    return out;
}

// Returns {} for an unknown customer — not an error, just nothing to
// prefill yet. Callers should leave the form blank/manual in that case.
function lookup(customerName) {
    const data = load();
    const c = (data.customers || {})[norm(customerName)];
    if (!c) return {};
    const items = {};
    for (const [key, item] of Object.entries(c.items || {})) {
        items[item.display_desc || key] = {
            rate: item.rate || 0,
            unit: item.unit || 'MT',
            updated_at: item.updated_at || '',
        };
    }
    return {
        canonical_name: c.canonical_name || customerName,
        trade_terms: c.trade_terms || '',
        port_discharge: c.port_discharge || '',
        items,
    };
}

// Returns {rate, unit} or null. Used while a user is typing an item
// description into an existing row, so a match can be offered without
// waiting for a full customer lookup round-trip.
function lookupItemRate(customerName, itemDesc) {
    const data = load();
    const c = (data.customers || {})[norm(customerName)];
    if (!c) return null;
    const item = (c.items || {})[normItem(itemDesc)];
    if (!item) return null;
    return { rate: item.rate || 0, unit: item.unit || 'MT' };
}

// items: [{desc, rate, unit}, ...]. Merges — an item not included keeps its
// previously saved rate. Returns the updated customer record.
async function upsert(customerName, { tradeTerms = '', portDischarge = '', items = [] } = {}) {
    const key = norm(customerName);
    if (!key) throw new Error('Customer name is required.');

    return mutateJson(cfg.PROFORMA_PRICING_FILE, DEFAULT_STORE, (data) => {
        if (!data.customers) data.customers = {};
        const existing = data.customers[key] || {
            canonical_name: String(customerName).trim(),
            trade_terms: '', port_discharge: '', items: {},
        };
        if (tradeTerms) existing.trade_terms = tradeTerms;
        if (portDischarge) existing.port_discharge = portDischarge;
        if (!existing.items) existing.items = {};

        const today = new Date().toISOString().slice(0, 10);
        for (const item of (items || [])) {
            const desc = String(item.desc || '').trim();
            if (!desc) continue;
            const rate = Number(item.rate) || 0;
            if (rate <= 0) continue; // a $0 rate is never useful to remember as "the price"
            existing.items[normItem(desc)] = {
                display_desc: desc,
                rate,
                unit: item.unit || 'MT',
                updated_at: today,
            };
        }

        data.customers[key] = existing;
        return data;
    }).then((data) => data.customers[key]);
}

// Called automatically after a proforma actually generates, so pricing
// memory improves on its own from real usage — no separate data-entry step
// required once a customer's been generated for even once. Callers MUST
// wrap this in try/catch: a failure here must never break PDF generation,
// only the self-improvement side effect.
async function recordFromGeneration(customerName, tradeTerms, portDischarge, lineItems) {
    if (!customerName) return;
    const items = (lineItems || [])
        .filter((it) => it.desc)
        .map((it) => ({ desc: it.desc || '', rate: it.rate || 0, unit: it.unit || 'MT' }));
    if (!items.length) return;
    await upsert(customerName, { tradeTerms, portDischarge, items });
}

// ─────────────────────────────────────────────────────────────────────────
//  PARSING A PASTED PREVIOUS PROFORMA (first-time setup)
// ─────────────────────────────────────────────────────────────────────────
// Same principle as the rest of this system: never silently trust a regex's
// guess on numbers that end up on a financial document. This returns
// candidates for the setup UI's editable review table — nothing is saved
// until the human confirms.

const RATE_RE = /\$?\s?([\d][\d,]*\.?\d{0,2})\s*(?:\/\s*(MT|LBS|LB|KG))?/gi;

function parsePastedText(text) {
    text = text || '';
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const upperText = text.toUpperCase();

    let tradeTerms = '';
    const termsMatch = upperText.match(/\b(CIF|FOB|CFR|CNF|EXW|DDP|DAP|FAS)\b[^\n]{0,60}/);
    if (termsMatch) {
        tradeTerms = text.slice(termsMatch.index, termsMatch.index + termsMatch[0].length).trim();
    }

    let portDischarge = '';
    const portMatch = text.match(/PORT\s+OF\s+DISCHARGE\s*[:\-]?\s*([^\n]{2,60})/i);
    if (portMatch) portDischarge = portMatch[1].trim();

    const items = [];
    const seen = new Set();
    for (const line of lines) {
        for (const name of KNOWN_ITEM_NAMES) {
            if (line.toUpperCase().includes(name.toUpperCase())) {
                const rateMatches = [...line.matchAll(RATE_RE)];
                let rate = 0, unit = 'MT';
                if (rateMatches.length) {
                    const last = rateMatches[rateMatches.length - 1];
                    const rawRate = last[1], rawUnit = last[2];
                    rate = parseFloat(String(rawRate || '').replace(/,/g, '')) || 0;
                    if (rawUnit) unit = rawUnit.toUpperCase().replace('LB', 'LBS');
                }
                const key = normItem(name);
                if (seen.has(key)) continue;
                seen.add(key);
                items.push({ desc: name, rate, unit });
                break;
            }
        }
    }

    let confidence = 'low';
    if (items.length && tradeTerms && portDischarge) confidence = 'high';
    else if (items.length) confidence = 'medium';

    return { trade_terms: tradeTerms, port_discharge: portDischarge, items, confidence };
}

module.exports = {
    listCustomers, lookup, lookupItemRate, upsert, recordFromGeneration, parsePastedText,
    KNOWN_ITEM_NAMES, KNOWN_TERMS_TOKENS,
};
