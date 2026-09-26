// ── helpers/claims.js — the weight-shortage claim register ──────────────────
//
// Apsara, 2026-09-26: "Revamp weight shortage sheet .. So it should read the
// mail with weight shortage detail and create automatically."
//
// WHY THIS IS A STORE AND NOT A SHEET TAB
// The "Weight Shortage 2025" tab on Shipments 2026 is seven different tables
// stacked down one grid — weight shortage, grade recovery, Reg/Al engine,
// steel engine and transmission, container damage, quality, and a 2025 legacy
// register — each re-labelling the same columns. Nothing can append to it
// safely: row 92's header means something different from row 117's, so an
// appended row has no defined meaning. Automation needs one row per claim with
// a fixed shape, so the record lives here and the page reads this.
//
// WHAT IS DELIBERATELY NOT AUTOMATIC
// `claim_amount` stays null until a human verifies the weights AND the unit.
// Her own tab is the argument: it already holds "ALUMINUM SCRAP 1,305.9KG
// SHORTAGE", "60661 kg" beside "58.901", "23,718" in a column headed MT, and
// the Ala International rows in pounds at a $/lb rate. A parser that guesses
// MT is wrong by a factor of 1000, and that number would land in the figure
// she shows her uncle and her customers. So the row is created from the mail;
// the money is computed by `verify()`, from figures a person confirmed.
const path = require('path');
const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

const FILE = () => cfg.CLAIMS_FILE || path.join(cfg.DATA_DIR, 'claims.json');

// Status is a closed set. 'unverified' is where every parsed claim starts.
const STATUSES = ['unverified', 'verified', 'recovery_raised', 'settled', 'rejected', 'withdrawn'];
const TYPES = ['weight_shortage', 'grade_recovery', 'quality', 'damage', 'other'];
const UNITS = ['MT', 'LB', 'KG'];

// Flags are the reasons a human still has to look. They are not errors — a
// claim with flags is a normal claim that is not yet worth money.
const FLAG_NO_UNIT = 'unit_not_stated';
const FLAG_UNKNOWN_CONTAINER = 'container_unknown';
const FLAG_FIGURE_CHANGED = 'figure_changed';
const FLAG_NO_SUPPLIER = 'supplier_unknown';

const newId = () => `clm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const norm = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : null; };

// The dedupe key. A claim is one customer chasing one container on one
// invoice, however many mails that takes. Container alone is not enough —
// ledger-data says a booking reference can be a TRAILER that goes out again.
function keyOf(invoice_no, container_no) { return `${norm(invoice_no)}|${norm(container_no)}`; }

function list() { return loadJson(FILE(), []) || []; }
function get(id) { return list().find((c) => c && c.id === id) || null; }
function findByKey(invoice_no, container_no) {
    const k = keyOf(invoice_no, container_no);
    return list().find((c) => c && c.key === k) || null;
}

// ── UNITS ───────────────────────────────────────────────────────────────────
// Converted only where a person has already said what the unit IS. Nothing
// here ever guesses one.
const TO_MT = { MT: 1, LB: 1 / 2204.62, KG: 1 / 1000 };
function toMT(value, unit) {
    const v = num(value);
    if (v === null || !TO_MT[unit]) return null;
    return v * TO_MT[unit];
}
function convert(value, from, to) {
    const mt = toMT(value, from);
    if (mt === null || !TO_MT[to]) return null;
    return mt / TO_MT[to];
}

function blank() {
    return {
        id: null, key: null,
        status: 'unverified', claim_type: 'weight_shortage',
        customer: '', supplier: '',
        invoice_no: '', container_no: '',
        invoice_weight: null, claimed_weight: null, weight_unit: null,
        shortage: null, shortage_pct: null,
        sell_price: null, sell_price_unit: null,
        claim_amount: null, our_claim: null,
        evidence: [], mail: [], quotes: {}, flags: [], history: [],
        note: '',
        created_at: null, created_by: '', updated_at: null,
    };
}

function withFlags(c) {
    const flags = new Set(c.flags || []);
    if (!c.weight_unit) flags.add(FLAG_NO_UNIT); else flags.delete(FLAG_NO_UNIT);
    if (!String(c.supplier || '').trim()) flags.add(FLAG_NO_SUPPLIER); else flags.delete(FLAG_NO_SUPPLIER);
    c.flags = [...flags];
    return c;
}

// ── CREATE ──────────────────────────────────────────────────────────────────
// strict:true on purpose. mutateJson swallows anything thrown inside its
// mutator and hands the caller plausible stale data (helpers/json.js:111), so
// without strict a claim can look created and never have been written. A lost
// claim is lost money.
async function create(input = {}, by = 'claims') {
    const now = new Date().toISOString();
    const rec = withFlags({
        ...blank(), ...input,
        id: newId(),
        key: keyOf(input.invoice_no, input.container_no),
        status: STATUSES.includes(input.status) ? input.status : 'unverified',
        claim_type: TYPES.includes(input.claim_type) ? input.claim_type : 'weight_shortage',
        weight_unit: UNITS.includes(input.weight_unit) ? input.weight_unit : null,
        claim_amount: null,          // never on creation — verify() computes it
        created_at: now, updated_at: now, created_by: by,
        history: [{ at: now, what: 'created', by }],
    });
    await mutateJson(FILE(), [], (all) => { all.push(rec); return all; }, { strict: true });
    return rec;
}

async function update(id, patch = {}, by = 'claims', what = 'updated') {
    const now = new Date().toISOString();
    let out = null;
    await mutateJson(FILE(), [], (all) => {
        const i = all.findIndex((c) => c && c.id === id);
        if (i < 0) return all;
        const merged = withFlags({ ...all[i], ...patch, id: all[i].id, updated_at: now });
        merged.key = keyOf(merged.invoice_no, merged.container_no);
        merged.history = [...(all[i].history || []), { at: now, what, by }];
        all[i] = merged; out = merged; return all;
    }, { strict: true });
    return out;
}

// ── VERIFY — the only place a claim becomes money ───────────────────────────
// The caller must state the unit. Everything is computed from figures a human
// confirmed, in the unit they confirmed them in.
async function verify(id, fields = {}, by = 'manager') {
    const c = get(id);
    if (!c) throw new Error('no such claim');
    const unit = UNITS.includes(fields.weight_unit) ? fields.weight_unit : null;
    if (!unit) throw new Error('verifying a claim needs the weight unit — MT, LB or KG');

    const invoice_weight = fields.invoice_weight !== undefined ? num(fields.invoice_weight) : num(c.invoice_weight);
    const claimed_weight = fields.claimed_weight !== undefined ? num(fields.claimed_weight) : num(c.claimed_weight);
    if (invoice_weight === null || claimed_weight === null) throw new Error('verifying a claim needs both the invoiced and the received weight');

    const sell_price = fields.sell_price !== undefined ? num(fields.sell_price) : num(c.sell_price);
    const sell_price_unit = UNITS.includes(fields.sell_price_unit) ? fields.sell_price_unit
        : UNITS.includes(c.sell_price_unit) ? c.sell_price_unit : unit;

    const shortage = Math.round((invoice_weight - claimed_weight) * 1e6) / 1e6;
    const shortage_pct = invoice_weight > 0 ? Math.round((shortage / invoice_weight) * 10000) / 100 : null;

    // The rate may be quoted per a different unit than the weights — she buys
    // in pounds and the commercial invoice prints MT. Convert the SHORTAGE
    // into the rate's unit rather than converting the rate.
    let claim_amount = null;
    if (sell_price !== null) {
        const shortInRateUnit = sell_price_unit === unit ? shortage : convert(shortage, unit, sell_price_unit);
        if (shortInRateUnit !== null) claim_amount = Math.round(shortInRateUnit * sell_price * 100) / 100;
    }

    return update(id, {
        weight_unit: unit, invoice_weight, claimed_weight, sell_price, sell_price_unit,
        shortage, shortage_pct, claim_amount,
        status: c.status === 'unverified' ? 'verified' : c.status,
    }, by, 'verified');
}

// Recovery from the supplier. This is the half of a claim that is actually
// actionable, and the half that keeps not happening: most of what Edge has
// absorbed is a recovery nobody raised.
async function raiseRecovery(id, { our_claim, note } = {}, by = 'manager') {
    const patch = { status: 'recovery_raised' };
    if (our_claim !== undefined) patch.our_claim = num(our_claim);
    if (note) patch.note = note;
    return update(id, patch, by, 'recovery raised on supplier');
}

async function setStatus(id, status, by = 'manager', note) {
    if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
    return update(id, note ? { status, note } : { status }, by, `status → ${status}`);
}

// Append a mail to a claim's trail. Returns {added, changed} — `changed` is
// true when the customer's own figure moved, which is a negotiation event
// somebody has to see, not an overwrite to apply silently.
async function addMail(id, mail = {}, seen = {}) {
    const c = get(id);
    if (!c) return { added: false, changed: false };
    const already = (c.mail || []).some((m) => m && m.message_id && m.message_id === mail.message_id);
    if (already) return { added: false, changed: false };

    const changed = seen.claimed_weight != null && num(c.claimed_weight) != null
        && Math.abs(num(seen.claimed_weight) - num(c.claimed_weight)) > 1e-6;
    const patch = { mail: [...(c.mail || []), mail] };
    if (changed) {
        patch.flags = [...new Set([...(c.flags || []), FLAG_FIGURE_CHANGED])];
        patch.note = `${c.note ? c.note + ' | ' : ''}customer figure moved ${c.claimed_weight} → ${seen.claimed_weight}`;
    }
    await update(id, patch, 'claims', changed ? 'another mail — figure changed' : 'another mail on this claim');
    return { added: true, changed };
}

// ── THE NUMBERS THE PAGE LEADS WITH ─────────────────────────────────────────
// Net is what Edge actually absorbs: claimed against it, less what it got back
// from the supplier. That is the figure the sheet could never produce, because
// no formula could total seven stacked tables.
function stats(rows) {
    const all = (rows || list()).filter(Boolean);
    const live = all.filter((c) => !['rejected', 'withdrawn'].includes(c.status));
    const sum = (f) => live.reduce((t, c) => t + (num(c[f]) || 0), 0);
    const claimed = sum('claim_amount');
    const recovered = sum('our_claim');
    const unverified = all.filter((c) => c.status === 'unverified');
    return {
        total: all.length,
        claimed, recovered, net: Math.round((claimed - recovered) * 100) / 100,
        recovery_rate: claimed > 0 ? Math.round((recovered / claimed) * 1000) / 10 : 0,
        unverified: unverified.length,
        awaiting_recovery: live.filter((c) => c.status === 'verified' && !num(c.our_claim)).length,
        open: live.filter((c) => !['settled'].includes(c.status)).length,
        by_status: STATUSES.reduce((o, s) => { o[s] = all.filter((c) => c.status === s).length; return o; }, {}),
    };
}

module.exports = {
    list, get, findByKey, keyOf, create, update, verify, raiseRecovery, setStatus, addMail, stats,
    convert, toMT, newId, blank,
    STATUSES, TYPES, UNITS,
    FLAG_NO_UNIT, FLAG_UNKNOWN_CONTAINER, FLAG_FIGURE_CHANGED, FLAG_NO_SUPPLIER,
    FILE,
};
