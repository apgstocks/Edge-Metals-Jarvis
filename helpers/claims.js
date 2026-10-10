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
// There is deliberately NO list of claim kinds here. Apsara, 2026-09-26: "let ai
// decide dynamically". A kind is a slug the model named, recorded in
// helpers/claimKinds.js; `claim_type` is one of those slugs, or null for a claim
// nothing has been able to classify yet. Null is a real state, not a gap — it is
// flagged and shown on the page rather than defaulted to the commonest kind.
const claimKinds = require('./claimKinds');
const UNITS = ['MT', 'LB', 'KG'];

// Flags are the reasons a human still has to look. They are not errors — a
// claim with flags is a normal claim that is not yet worth money.
const FLAG_NO_UNIT = 'unit_not_stated';
const FLAG_UNKNOWN_CONTAINER = 'container_unknown';
const FLAG_FIGURE_CHANGED = 'figure_changed';
const FLAG_NO_SUPPLIER = 'supplier_unknown';
const FLAG_KIND_UNKNOWN = 'kind_unknown';

// ── HOW A CLAIM IS ASSESSED (2026-10-10) ────────────────────────────────────
// Apsara: "Add like remarks if its foreign material with a downloadable claim
// report", and the Claims page "should be the most user friendly tab".
//
// A claim KIND is the model's free-form name for it (claimKinds.js) and stays
// that way. The ASSESSMENT is a different, closed question — how is the money
// worked out — and there are only three answers:
//   weight        invoiced minus received, at a rate          (verify(), unchanged)
//   contamination a share of the net weight was not the metal (assess())
//   grade         the metal arrived as a cheaper grade         (assess())
// Keeping them apart means a kind she renames tomorrow still assesses the way
// it did today, and no kind name is ever written into the code.
// null means "never chosen" and is treated as weight, which is what every claim
// before this date was.
const ASSESSMENTS = ['weight', 'contamination', 'grade'];
// What can be found in a container. Shown as tick boxes; `sealed_hazard` is the
// one that is not a price question at all (radioactive or explosive items —
// every scrap shipment into India carries a declaration that there are none).
const FINDINGS = ['dirt', 'rubber_plastic', 'iron_attached', 'oil_moisture', 'other_metals', 'wood_paper', 'sealed_hazard'];
// How the contamination was measured. Strength is shown on the page so a
// deduction backed only by the customer's photos is not argued as if surveyed.
const MEASURED_BY = ['surveyor', 'split_sample', 'sorted_weighed', 'photos_only'];

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
        // Edge's SELL rate. It values what the customer is claiming and it
        // never leaves the building — printing it on a supplier statement
        // hands them Edge's margin.
        sell_price: null, sell_price_unit: null,
        // What Edge PAID this supplier, from that container's purchase bill.
        // This is the rate the recovery is argued at, because it is the only
        // one the supplier already agreed to. helpers/claimPrice.js finds it.
        supplier_price: null, supplier_price_unit: null, supplier_price_source: '',
        claim_amount: null, our_claim: null,
        evidence: [], mail: [], quotes: {}, flags: [], history: [],
        note: '',
        // The date ON the claim document, which is NOT created_at. A sheet
        // imported in one go gives every row the same created_at, and a
        // supplier reading that on a statement reads it as the claim date.
        claim_date: null,
        // ── added 2026-10-10, all optional; a claim without them behaves
        // exactly as before. See ASSESSMENTS above.
        assessment: null,
        findings: [], measured_by: null,
        contam_claimed_pct: null, contam_accepted_pct: null, contaminated_weight: null,
        grade_sold: '', grade_received: '', grade_weight: null,
        grade_price_sold: null, grade_price_received: null,
        // Contract tolerance on a weight shortage. Blank = no allowance, which
        // is how every claim was worked out before it existed.
        tolerance_pct: null, claimable_shortage: null,
        // Her own words about the claim. Printed on the INTERNAL report only:
        // a remark is free text and can name the customer, so it never goes on
        // the document a supplier receives.
        remarks: '',
        created_at: null, created_by: '', updated_at: null,
    };
}

function withFlags(c) {
    const flags = new Set(c.flags || []);
    if (!c.weight_unit) flags.add(FLAG_NO_UNIT); else flags.delete(FLAG_NO_UNIT);
    if (!String(c.supplier || '').trim()) flags.add(FLAG_NO_SUPPLIER); else flags.delete(FLAG_NO_SUPPLIER);
    if (!c.claim_type) flags.add(FLAG_KIND_UNKNOWN); else flags.delete(FLAG_KIND_UNKNOWN);
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
        claim_type: input.claim_type ? claimKinds.slugify(input.claim_type) : null,
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
    // ── CONTRACT TOLERANCE, ONLY WHEN SOMEONE STATES ONE (2026-10-10) ──────
    // A blank tolerance means none — the figure is worked out exactly as it
    // always was. `shortage` stays the real difference; only the CLAIMABLE part
    // shrinks, so the page and the report can show both.
    const stated = (v) => v !== undefined && v !== null && String(v).trim() !== '';
    const tolerance_pct = stated(fields.tolerance_pct) ? num(fields.tolerance_pct)
        : (fields.tolerance_pct === undefined && stated(c.tolerance_pct) ? num(c.tolerance_pct) : null);
    if (tolerance_pct !== null && (tolerance_pct < 0 || tolerance_pct > 20)) throw new Error('a tolerance must be between 0% and 20%');
    const claimable_shortage = tolerance_pct === null ? null
        : Math.max(0, Math.round((shortage - invoice_weight * tolerance_pct / 100) * 1e6) / 1e6);
    const charged = claimable_shortage === null ? shortage : claimable_shortage;

    let claim_amount = null;
    if (sell_price !== null) {
        const shortInRateUnit = sell_price_unit === unit ? charged : convert(charged, unit, sell_price_unit);
        if (shortInRateUnit !== null) claim_amount = Math.round(shortInRateUnit * sell_price * 100) / 100;
    }

    return update(id, {
        weight_unit: unit, invoice_weight, claimed_weight, sell_price, sell_price_unit,
        shortage, shortage_pct, claim_amount, tolerance_pct, claimable_shortage,
        // verify() IS the weight arithmetic, so a claim confirmed here is a
        // weight claim, whatever it was assessed as before.
        assessment: 'weight',
        status: c.status === 'unverified' ? 'verified' : c.status,
    }, by, 'verified');
}

// ── ASSESS — contamination and grade claims (2026-10-10) ───────────────────
// The same contract as verify(): the money is computed here, from figures a
// person typed, in a unit a person chose — never on creation, never guessed.
// Weight claims still go through verify(); this refuses them so there is one
// path per kind of arithmetic.
async function assess(id, fields = {}, by = 'manager') {
    const c = get(id);
    if (!c) throw new Error('no such claim');
    const kind = fields.assessment;
    if (kind === 'weight') throw new Error('a weight shortage is confirmed through verify, not assess');
    if (!ASSESSMENTS.includes(kind)) throw new Error('assessment must be contamination or grade');

    const unit = UNITS.includes(fields.weight_unit) ? fields.weight_unit : (UNITS.includes(c.weight_unit) ? c.weight_unit : null);
    if (!unit) throw new Error('assessing a claim needs the weight unit — MT, LB or KG');
    const given = (k) => (fields[k] !== undefined ? fields[k] : c[k]);
    const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';
    const sell_price = has(given('sell_price')) ? num(given('sell_price')) : null;
    const sell_price_unit = UNITS.includes(fields.sell_price_unit) ? fields.sell_price_unit
        : UNITS.includes(c.sell_price_unit) ? c.sell_price_unit : unit;

    const patch = { assessment: kind, weight_unit: unit, status: c.status === 'unverified' ? 'verified' : c.status };
    let claim_amount = null;

    if (kind === 'contamination') {
        const invoice_weight = has(given('invoice_weight')) ? num(given('invoice_weight')) : null;
        const accepted = has(given('contam_accepted_pct')) ? num(given('contam_accepted_pct')) : null;
        if (invoice_weight === null || invoice_weight <= 0) throw new Error('assessing contamination needs the net weight that was invoiced');
        if (accepted === null) throw new Error('assessing contamination needs the share Edge accepts was not metal — a percentage');
        if (accepted < 0 || accepted > 100) throw new Error('a contamination share must be between 0% and 100%');
        const claimedPct = has(given('contam_claimed_pct')) ? num(given('contam_claimed_pct')) : null;
        const contaminated_weight = Math.round(invoice_weight * accepted / 100 * 1e6) / 1e6;
        if (sell_price !== null) {
            const q = sell_price_unit === unit ? contaminated_weight : convert(contaminated_weight, unit, sell_price_unit);
            if (q !== null) claim_amount = Math.round(q * sell_price * 100) / 100;
        }
        const findings = Array.isArray(given('findings')) ? given('findings').filter((f) => FINDINGS.includes(f)) : [];
        const measured_by = MEASURED_BY.includes(given('measured_by')) ? given('measured_by') : null;
        Object.assign(patch, { invoice_weight, contam_accepted_pct: accepted, contam_claimed_pct: claimedPct,
            contaminated_weight, findings, measured_by, sell_price, sell_price_unit });
    } else {
        const w = has(given('grade_weight')) ? num(given('grade_weight')) : null;
        const sold = has(given('grade_price_sold')) ? num(given('grade_price_sold')) : null;
        const recv = has(given('grade_price_received')) ? num(given('grade_price_received')) : null;
        if (w === null || w <= 0) throw new Error('assessing a downgrade needs the weight that was affected');
        if (sold === null || recv === null) throw new Error('assessing a downgrade needs both prices — the grade sold and the grade received');
        if (recv > sold) throw new Error('the received grade is priced above the grade sold — that is not a downgrade');
        // Both prices are per the claim's weight unit; the page labels them so.
        claim_amount = Math.round(w * (sold - recv) * 100) / 100;
        Object.assign(patch, { grade_weight: w, grade_price_sold: sold, grade_price_received: recv,
            grade_sold: String(given('grade_sold') || '').slice(0, 80), grade_received: String(given('grade_received') || '').slice(0, 80) });
    }
    patch.claim_amount = claim_amount;
    return update(id, patch, by, kind === 'contamination' ? 'contamination assessed' : 'downgrade assessed');
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
        // Grouped by whatever kinds actually turned up, not by a fixed set.
        by_kind: live.reduce((o, c) => {
            const k = c.claim_type || '(not classified)';
            if (!o[k]) o[k] = { claims: 0, claimed: 0 };
            o[k].claims += 1; o[k].claimed += num(c.claim_amount) || 0;
            return o;
        }, {}),
        unclassified: all.filter((c) => !c.claim_type).length,
    };
}

module.exports = {
    list, get, findByKey, keyOf, create, update, verify, assess, raiseRecovery, setStatus, addMail, stats,
    ASSESSMENTS, FINDINGS, MEASURED_BY,
    convert, toMT, newId, blank,
    STATUSES, UNITS,
    FLAG_NO_UNIT, FLAG_UNKNOWN_CONTAINER, FLAG_FIGURE_CHANGED, FLAG_NO_SUPPLIER, FLAG_KIND_UNKNOWN,
    FILE,
};
