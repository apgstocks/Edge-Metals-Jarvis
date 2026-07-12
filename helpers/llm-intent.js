// ── helpers/llm-intent.js ────────────────────────────────────────────────────
// Phase 1: Manager NL command normalizer.
// Takes free-text from manager/team, returns a structured intent that maps to
// an existing action in workflow/brain.js.
//
// Fallback-only: called ONLY when the deterministic policy layer cannot resolve.
// Whitelist-only: intents outside ALLOWED_INTENTS become 'unknown'.
// Grounded: booking numbers, trucker names, supplier names must exist in JSON.
// Guardrails: kill switch, 2s timeout, confidence gating, cheap model.
//
// This file does NOT mutate state. It only returns a decision.
// Dispatch to actions.js happens in workflow/brain.js.

const cfg = require('../config');
const { loadBookings, loadTruckers, loadSuppliers, loadBrain } = require('./json');
const { callGeminiText } = require('./gemini');

// ── Whitelisted intents Phase 1 can produce ─────────────────────────────────
// Each MUST already have a handler in workflow/brain.js router.
// Adding a new intent here without a matching handler = silent no-op.
const ALLOWED_INTENTS = new Set([
    'forward_booking',       // { bkg_no, trucker_name?, supplier_name? }
    'recall_booking',        // { bkg_no, target: 'trucker'|'supplier'|'both' }
    'reassign_booking',      // { bkg_no }
    'rollback_booking',      // { bkg_no }
    'show_booking_status',   // { bkg_no }
    'show_pending',          // {}
    'clear_pending',         // {}
    'show_menu',             // {}
    'keep_reminding',        // { bkg_no }
    'unknown',               // fallback — always allowed
]);

// ── Build grounding context for LLM prompt ──────────────────────────────────
// Injected fresh every call. Never cached — booking state changes constantly.
function buildGroundingContext() {
    const bookings  = loadBookings()  || {};
    const truckers  = loadTruckers()  || [];
    const suppliers = loadSuppliers() || [];
    const brain     = loadBrain()     || {};

    // Active bookings only — closed/archived are noise + wasted tokens
    const activeBkgs = Object.entries(bookings)
        .filter(([, b]) => b && !b.archived && !b.closed)
        .map(([bkgNo, b]) => ({
            bkg_no : bkgNo,
            pol    : b.pol || b.port_of_loading    || '',
            pod    : b.pod || b.port_of_discharge  || '',
            erd    : b.erd    || '',
            cutoff : b.cutoff || '',
        }))
        .slice(0, 30); // cap prompt size

    const truckerNames = (Array.isArray(truckers) ? truckers : Object.values(truckers))
        .map(t => t?.name)
        .filter(Boolean);

    const supplierNames = (Array.isArray(suppliers) ? suppliers : Object.values(suppliers))
        .map(s => s?.name)
        .filter(Boolean);

    const pendingCount = Object.keys(brain?.pending_actions || {}).length;

    return { activeBkgs, truckerNames, supplierNames, pendingCount };
}

// ── Prompt builder ──────────────────────────────────────────────────────────
function buildPrompt(text, ctx) {
    const { activeBkgs, truckerNames, supplierNames, pendingCount } = ctx;

    const bkgLines = activeBkgs.length
        ? activeBkgs.map(b => `- ${b.bkg_no} | ${b.pol}→${b.pod} | ERD ${b.erd} | cutoff ${b.cutoff}`).join('\n')
        : '(none)';

    return `You are Jarvis, a freight ops assistant. Parse the manager's message into a structured intent.

STRICT RULES:
1. Respond with ONLY a JSON object. No markdown, no code fences, no prose.
2. intent MUST be one of: forward_booking, recall_booking, reassign_booking, rollback_booking, show_booking_status, show_pending, clear_pending, show_menu, keep_reminding, unknown.
3. bkg_no MUST match one from ACTIVE BOOKINGS exactly. If manager references a booking not in the list, return intent "unknown" with confidence 0.
4. trucker_name / supplier_name MUST match a name from the whitelists (case-insensitive substring is OK — pick the canonical whitelist name). If no match, omit the field.
5. confidence is 0.0–1.0. Be conservative: ambiguous = 0.3–0.5, clear = 0.85+.
6. For chit-chat, greetings, or anything you cannot map, return { "intent": "unknown", "confidence": 0 }.

ACTIVE BOOKINGS (${activeBkgs.length}):
${bkgLines}

TRUCKERS: ${truckerNames.join(', ') || '(none)'}
SUPPLIERS: ${supplierNames.join(', ') || '(none)'}
PENDING ACTIONS OPEN: ${pendingCount}

MANAGER MESSAGE:
"${text.replace(/"/g, '\\"')}"

Respond with JSON in exactly this shape:
{
  "intent": "<allowed intent>",
  "data": {
    "bkg_no": "<matched booking or omit>",
    "trucker_name": "<matched trucker or omit>",
    "supplier_name": "<matched supplier or omit>",
    "target": "<trucker|supplier|both — only for recall>"
  },
  "confidence": <0.0-1.0>,
  "reply": "<optional short human message, or empty string>"
}`;
}

// ── Parse and validate LLM response ─────────────────────────────────────────
function parseResponse(raw) {
    if (!raw || typeof raw !== 'string') return null;

    // Strip code fences if Gemini adds them despite instructions
    let clean = raw.trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();

    try {
        const obj = JSON.parse(clean);
        if (!obj || typeof obj !== 'object') return null;

        // Enforce intent whitelist — reject anything unexpected
        if (!ALLOWED_INTENTS.has(obj.intent)) {
            console.warn(`[LLM] Non-whitelisted intent rejected: ${obj.intent}`);
            return { intent: 'unknown', data: {}, confidence: 0, reply: '' };
        }

        return {
            intent    : obj.intent,
            data      : obj.data || {},
            confidence: typeof obj.confidence === 'number' ? obj.confidence : 0,
            reply     : typeof obj.reply === 'string' ? obj.reply : '',
        };
    } catch (err) {
        console.error(`[LLM] JSON parse failed: ${err.message} | raw: ${clean.substring(0, 200)}`);
        return null;
    }
}

// ── Validate grounding — booking must exist, names must resolve ─────────────
// Belt-and-suspenders check even though prompt already enforces this.
// If Gemini hallucinates a booking number, downgrade to unknown.
function validateGrounding(decision, groundingCtx) {
    const { activeBkgs, truckerNames, supplierNames } = groundingCtx;
    const d = decision.data || {};

    if (d.bkg_no) {
        const exists = activeBkgs.some(b => b.bkg_no === d.bkg_no);
        if (!exists) {
            console.warn(`[LLM] Hallucinated bkg_no ${d.bkg_no} — downgrading`);
            return { intent: 'unknown', data: {}, confidence: 0, reply: '' };
        }
    }

    if (d.trucker_name && !truckerNames.some(n => n.toLowerCase() === d.trucker_name.toLowerCase())) {
        console.warn(`[LLM] Unknown trucker ${d.trucker_name} — clearing field`);
        delete d.trucker_name;
    }

    if (d.supplier_name && !supplierNames.some(n => n.toLowerCase() === d.supplier_name.toLowerCase())) {
        console.warn(`[LLM] Unknown supplier ${d.supplier_name} — clearing field`);
        delete d.supplier_name;
    }

    return decision;
}

// ── Main extractor ──────────────────────────────────────────────────────────
async function extractManagerIntent(text) {
    const startTime = Date.now();

    // Kill switch — env var LLM_MANAGER_ENABLED=false disables entirely
    if (!cfg.LLM_MANAGER_ENABLED) {
        return { intent: 'unknown', data: {}, confidence: 0, reply: '', resolvedBy: 'llm_disabled' };
    }

    if (!text || text.trim().length < 2) {
        return { intent: 'unknown', data: {}, confidence: 0, reply: '', resolvedBy: 'empty' };
    }

    const groundingCtx = buildGroundingContext();
    const prompt       = buildPrompt(text, groundingCtx);

    let raw;
    try {
        const timeout = new Promise((_, rej) =>
            setTimeout(() => rej(new Error('LLM_TIMEOUT')), cfg.LLM_TIMEOUT_MS || 2000)
        );
        raw = await Promise.race([callGeminiText(prompt, 300), timeout]);
    } catch (err) {
        console.error(`[LLM] call failed after ${Date.now() - startTime}ms: ${err.message}`);
        return { intent: 'unknown', data: {}, confidence: 0, reply: '', resolvedBy: 'llm_error' };
    }

    let parsed = parseResponse(raw);
    if (!parsed) {
        console.warn(`[LLM] Unparseable response after ${Date.now() - startTime}ms`);
        return { intent: 'unknown', data: {}, confidence: 0, reply: '', resolvedBy: 'llm_bad_json' };
    }

    // Grounding validation — kill hallucinations
    parsed = validateGrounding(parsed, groundingCtx);

    const latencyMs = Date.now() - startTime;
    console.log(`[LLM] "${text.substring(0, 60)}" → ${parsed.intent} conf=${parsed.confidence.toFixed(2)} (${latencyMs}ms)`);

    return { ...parsed, resolvedBy: 'llm', latencyMs };
}

// ── Confidence gate ─────────────────────────────────────────────────────────
// Returns 'fire' | 'confirm' | 'fallthrough' based on thresholds.
// Called by workflow/brain.js after extractManagerIntent().
function gate(decision) {
    if (!decision || decision.intent === 'unknown') return 'fallthrough';
    const c = decision.confidence || 0;
    if (c >= (cfg.LLM_CONFIDENCE_HIGH || 0.85)) return 'fire';
    if (c >= (cfg.LLM_CONFIDENCE_LOW  || 0.5))  return 'confirm';
    return 'fallthrough';
}

// ── Human-readable intent description — used for confirmation prompt ────────
function describeIntent(decision) {
    const d = decision.data || {};
    switch (decision.intent) {
        case 'forward_booking':
            return `Forward ${d.bkg_no}` +
                (d.trucker_name  ? ` to ${d.trucker_name}`   : '') +
                (d.supplier_name ? ` (supplier: ${d.supplier_name})` : '');
        case 'recall_booking':
            return `Recall ${d.bkg_no}` + (d.target && d.target !== 'both' ? ` from ${d.target}` : '');
        case 'reassign_booking':    return `Reassign ${d.bkg_no}`;
        case 'rollback_booking':    return `Rollback ${d.bkg_no}`;
        case 'show_booking_status': return `Show status of ${d.bkg_no}`;
        case 'keep_reminding':      return `Keep reminding ${d.bkg_no}`;
        case 'show_pending':        return 'Show pending actions';
        case 'clear_pending':       return 'Clear all pending actions';
        case 'show_menu':           return 'Show main menu';
        default:                    return decision.intent;
    }
}

module.exports = {
    extractManagerIntent,
    gate,
    describeIntent,
    ALLOWED_INTENTS,
};