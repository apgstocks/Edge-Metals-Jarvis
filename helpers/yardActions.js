// ── helpers/yardActions.js — what the yard assistant is allowed to DO ──────
//
// Per Apsara 2026-08-29: "you cannot DO anything is totally wrong. it can do
// anything but within scope of edge yard."
//
// So it acts now. The shape of that is PROPOSE, THEN CONFIRM — her choice, and
// the right one. The model never writes. It produces a REQUEST; this file
// rebuilds the actual change from the real records, shows it as a sentence with
// exact figures, and only writes after a human taps Confirm.
//
// Why not let it write directly, when it is already trusted to answer? Because
// answering and writing fail differently. A wrong answer is a wrong sentence on
// a screen, and the person reading it can see it is odd. A wrong write is a
// wrong number in the books that nobody sees again until an invoice goes out.
// This model has already been caught producing a confident, fluent, wrong
// total in this very app — $11,281.00 when the true figure was $12,446.50, and
// not even self-consistent with its own average. That is not a reason to keep
// it read-only; it is a reason to put a human between the sentence and the
// ledger.
//
// ── the boundary ──────────────────────────────────────────────────────────
// THREE actions, allowlisted by name. Anything else is refused by default
// rather than passed through, so a new capability has to be added here on
// purpose. DELETE is deliberately absent: it is the one operation in this app
// with no undo, and it is the least worth saving a tap on.
//
// The model's parameters are treated as UNTRUSTED INPUT, exactly like a form
// post from a browser. Every load id is looked up and must exist. Every amount
// is re-parsed as a number. Every payment mode is matched against the same
// allowlist the Pay button uses. A field that is not in the allowlist below is
// dropped, not passed along. If the model names a seller or a load that is not
// in the data, nothing is proposed at all.

const cfg = require('../config');

// A proposal is worthless if it can be edited between being shown and being
// run, so the CLIENT NEVER SENDS PARAMETERS BACK. The server keeps the
// validated proposal and hands out only an opaque id; confirming quotes that
// id. That way "record $12,000" cannot become "record $120,000" in transit,
// and a compromised page cannot invent a write that was never proposed.
const crypto = require('crypto');
const pending = new Map();

// Five minutes. Long enough to read the card and think; short enough that a
// proposal cannot be confirmed tomorrow against data that has since moved on.
const PROPOSAL_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 50;

function sweep() {
    const now = Date.now();
    for (const [id, p] of pending) if (now - p.created > PROPOSAL_TTL_MS) pending.delete(id);
    // Hard cap as well as a TTL: the TTL alone bounds age, not count, so a
    // flood of questions inside one minute could still grow this without limit.
    while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
}

const money = (n) => `$${(Math.round(Number(n) * 100) / 100).toFixed(2)}`;

// ── the allowlist ─────────────────────────────────────────────────────────
// Only these fields can be changed on an existing load. Notably absent:
// id, created_by, created_at, status, and every *_drive_id / *_link — an
// assistant must not be able to repoint a load at a different PDF or photo,
// or rewrite who recorded it.
const EDITABLE_LOAD_FIELDS = ['date', 'seller', 'seller_address', 'seller_phone', 'description', 'weight_unit'];

const ACTIONS = {
    // ── record a payment ──────────────────────────────────────────────────
    async record_payment(p) {
        const { getLoad } = require('./loads');
        const { PAYMENT_MODES, paymentSummary } = require('./payments');

        const loadId = String(p.load_id || '').trim();
        if (!loadId) throw new Error('which load the payment is against was not specified');
        const load = await getLoad(loadId);
        // The single most valuable check here. A hallucinated load id is the
        // most likely way this goes wrong, and it dies at this line.
        if (!load) throw new Error(`there is no load ${loadId} in the records`);

        const amount = Math.round(Number(p.amount) * 100) / 100;
        if (!Number.isFinite(amount) || amount <= 0) throw new Error('a payment needs an amount greater than zero');

        const mode = PAYMENT_MODES.find((m) => m.toLowerCase() === String(p.mode || '').trim().toLowerCase());
        if (!mode) throw new Error(`payment mode must be one of: ${PAYMENT_MODES.join(', ')}`);

        // Recomputed from the ledger, NOT from anything the model said, so the
        // pending figure on the card is the same arithmetic the invoice uses.
        const before = paymentSummary(loadId, load.amount);
        const after = Math.round((before.pending - amount) * 100) / 100;

        const paidOn = /^\d{4}-\d{2}-\d{2}$/.test(String(p.paid_on || '')) ? p.paid_on : require('./time').todayLocal();

        const warnings = [];
        // Overpayment is allowed but never silent — it is usually a typo, and
        // it is far cheaper to question here than to unpick from the ledger.
        if (after < 0) warnings.push(`This is ${money(-after)} MORE than the ${money(before.pending)} still outstanding on this load.`);
        if (before.pending === 0) warnings.push('This load is already fully paid.');

        return {
            summary: `Record a ${mode} payment of ${money(amount)} against ${loadId} (${load.seller || 'no seller'}), dated ${paidOn}.`,
            details: [
                ['Load', `${loadId} — ${load.seller || 'no seller'}, ${money(load.amount || 0)}`],
                ['Already paid', money(before.paid)],
                ['This payment', `${money(amount)} by ${mode}`],
                ['Left pending after', money(Math.max(after, 0))],
            ],
            warnings,
            run: async (ctx) => {
                const { addPayment } = require('./payments');
                return addPayment({ load_id: loadId, amount, mode, paid_on: paidOn, note: p.note, created_by: ctx.role || 'yard-assistant' });
            },
        };
    },

    // ── start a load ──────────────────────────────────────────────────────
    // Creates a DRAFT, not a finished load, and that is on purpose rather than
    // a shortcut. Weights in this yard are captured by photographing the scale;
    // helpers/visionOcr.js and the whole camera pipeline exist so that every
    // weight on a ticket has an image behind it. A load conjured from a
    // sentence would be the only load in the system with no audit trail, and
    // the seller signs against those numbers. So the assistant sets the load
    // up, and it lands in the draft strip for someone to open, weigh and save.
    async create_load(p) {
        const seller = String(p.seller || '').trim();
        if (!seller) throw new Error('a load needs a seller');

        const items = (Array.isArray(p.items) ? p.items : []).slice(0, 40).map((it) => ({
            description: String(it.description || '').trim(),
            gross_weight: Number(it.gross_weight) || null,
            tare_weight: Number(it.tare_weight) || null,
            price: Number(it.price) || null,
            unit: String(it.unit || '').trim(),
        })).filter((it) => it.description || it.gross_weight != null);

        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(p.date || '')) ? p.date : require('./time').todayLocal();

        return {
            summary: `Start a draft load for ${seller} dated ${date}${items.length ? ` with ${items.length} item${items.length > 1 ? 's' : ''}` : ''}.`,
            details: [
                ['Seller', seller],
                ['Date', date],
                ['Items', items.length ? items.map((i) => i.description || '(unnamed)').join(', ') : 'none yet'],
            ],
            warnings: ['This creates a DRAFT. Open it from Drafts to photograph the weights and save it as a real load.'],
            run: async (ctx) => {
                const { saveDraft } = require('./loadDrafts');
                return saveDraft({
                    date, seller, items,
                    seller_address: String(p.seller_address || '').trim(),
                    seller_phone: String(p.seller_phone || '').trim(),
                    created_by: ctx.role || 'yard-assistant',
                });
            },
        };
    },

    // ── edit an existing load ─────────────────────────────────────────────
    async edit_load(p) {
        const { getLoad } = require('./loads');
        const loadId = String(p.load_id || '').trim();
        if (!loadId) throw new Error('which load to edit was not specified');
        const load = await getLoad(loadId);
        if (!load) throw new Error(`there is no load ${loadId} in the records`);

        const changes = [];
        const patch = {};
        for (const f of EDITABLE_LOAD_FIELDS) {
            if (p[f] === undefined || p[f] === null) continue;
            const next = String(p[f]).trim();
            const prev = load[f] == null ? '' : String(load[f]);
            if (next === prev) continue;
            patch[f] = next;
            changes.push([f.replace(/_/g, ' '), `${prev || '(blank)'} → ${next}`]);
        }

        // Item edits are handled separately: they move money, so they are
        // shown as a before/after on the load TOTAL rather than as a field
        // rename, and the totals are recomputed by helpers/loads.js — the same
        // code the form uses — not by the model.
        let items = null;
        if (Array.isArray(p.items) && p.items.length) {
            items = p.items.slice(0, 40).map((it, i) => {
                const old = (load.items || [])[i] || {};
                return {
                    description: it.description !== undefined ? String(it.description).trim() : (old.description || ''),
                    gross_weight: it.gross_weight !== undefined ? Number(it.gross_weight) : old.gross_weight,
                    tare_weight: it.tare_weight !== undefined ? Number(it.tare_weight) : old.tare_weight,
                    price: it.price !== undefined ? Number(it.price) : old.price,
                    unit: it.unit !== undefined ? String(it.unit).trim() : (old.unit || ''),
                };
            });
            changes.push(['items', `${(load.items || []).length} → ${items.length}, totals recalculated`]);
        }

        if (!changes.length) throw new Error('that would not change anything on the load');

        const warnings = [];
        // These consequences are invisible from the chat window and are the
        // reason an edit deserves a confirmation more than a payment does.
        if (load.seller_signature) warnings.push('The seller signature on this load will be cleared — it attests to the current numbers.');
        if (load.pdf_link || load.pdf_drive_id) warnings.push('The generated PDF will be discarded and must be regenerated.');
        const { paymentSummary } = require('./payments');
        const pay = paymentSummary(loadId, load.amount);
        if (items && pay.paid > 0) warnings.push(`${money(pay.paid)} has already been paid against this load — changing the amount changes what is still owed.`);

        return {
            summary: `Edit load ${loadId} (${load.seller || 'no seller'}): ${changes.map((c) => c[0]).join(', ')}.`,
            details: changes,
            warnings,
            run: async (ctx) => {
                const { editLoad } = require('./loads');
                // Full entry, because editLoad recomputes totals from items —
                // passing a partial would blank the fields it did not receive.
                return editLoad(loadId, {
                    date: patch.date ?? load.date,
                    seller: patch.seller ?? load.seller,
                    seller_address: patch.seller_address ?? load.seller_address,
                    seller_phone: patch.seller_phone ?? load.seller_phone,
                    buyer: load.buyer, buyer_address: load.buyer_address,
                    description: patch.description ?? load.description,
                    weight_unit: patch.weight_unit ?? load.weight_unit,
                    items: items || load.items || [],
                    edited_by: ctx.role || 'yard-assistant',
                });
            },
        };
    },
};

// Names the model is told about. Kept next to the implementations so the two
// cannot drift — a prompt advertising an action that does not exist produces
// confident nonsense, which is the worst of both.
const ACTION_NAMES = Object.keys(ACTIONS);

// ── propose ───────────────────────────────────────────────────────────────
// Takes whatever the model produced. Returns something safe to show, or throws
// with a reason plain enough to hand straight back to the person.
async function proposeAction(raw, ctx = {}) {
    sweep();
    if (!raw || typeof raw !== 'object') throw new Error('no action was described');
    const kind = String(raw.kind || raw.action || '').trim().toLowerCase();

    // Refuse by NAME, and say so specifically when it is a deletion, because
    // "I can't do that" invites a rephrase whereas naming the boundary does not.
    if (/delete|remove|void|cancel/.test(kind)) {
        throw new Error('I will not delete anything. Deleting a load or a payment has no undo, so it has to be done by hand in the app.');
    }
    if (!Object.prototype.hasOwnProperty.call(ACTIONS, kind)) {
        throw new Error(`I can only record a payment, start a draft load, or edit a load. I cannot do "${kind || 'that'}".`);
    }

    const built = await ACTIONS[kind](raw.params || raw);
    const id = crypto.randomBytes(16).toString('hex');
    pending.set(id, { id, kind, created: Date.now(), built, role: ctx.role || null });
    return {
        id,
        kind,
        summary: built.summary,
        details: built.details || [],
        warnings: built.warnings || [],
        expires_in_ms: PROPOSAL_TTL_MS,
    };
}

// ── confirm ───────────────────────────────────────────────────────────────
// SINGLE USE. The proposal is removed before it runs, so a double-tap or a
// retried request cannot record the same payment twice — a duplicate payment
// is exactly the kind of quiet error this whole design exists to prevent.
async function confirmAction(id, ctx = {}) {
    sweep();
    const p = pending.get(String(id || ''));
    if (!p) throw new Error('That confirmation has expired or was already used. Ask again and I will re-propose it.');
    pending.delete(p.id);
    const result = await p.built.run(ctx);
    return { ok: true, kind: p.kind, summary: p.built.summary, result };
}

function cancelAction(id) { return pending.delete(String(id || '')); }
function pendingCount() { sweep(); return pending.size; }

module.exports = { proposeAction, confirmAction, cancelAction, pendingCount, ACTION_NAMES, EDITABLE_LOAD_FIELDS, PROPOSAL_TTL_MS };
