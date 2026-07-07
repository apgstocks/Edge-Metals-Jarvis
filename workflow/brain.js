// ── workflow/brain.js — The pipeline ─────────────────────────────────────────
// inbound → dedupe → context → policy (deterministic) → AI (only if needed)
// → route to actions → transcript.
// Policy resolves everything it can without Gemini: pending yes/no + list
// selections, exact commands, booking numbers, role-scoped media. AI is the
// fallback for ambiguity, never the first resort.

const { loadSettings, saveTranscript }            = require('../helpers/json');
const { buildContext, formatForAI, updateSession } = require('../helpers/context');
const { resolveBookingNumber }                     = require('../helpers/booking');
const { callGeminiJSON }                           = require('../helpers/gemini');
const { getLATime }                                = require('../helpers/time');
const { matchTruckerByChat }                       = require('./truckers');
const { matchSupplierByChat }                      = require('./suppliers');
const actions = require('./actions');
const cfg     = require('../config');

// ── Dedupe — in-memory ring (single process, restart-safe enough) ─────────────
const seen = new Set();
function isDuplicate(messageId) {
    if (!messageId) return false;
    if (seen.has(messageId)) return true;
    seen.add(messageId);
    if (seen.size > 500) { const first = seen.values().next().value; seen.delete(first); }
    return false;
}

// ── Step 1: normalize + authorize ─────────────────────────────────────────────
function normalize(raw) {
    const settings = loadSettings();
    const digits   = (v) => String(v || '').replace(/\D/g, '');

    const managerNum = digits(settings.manager_number);
    // internal_team supports two formats for backward compat:
    //   legacy: ['14155551111', '14155552222']
    //   new:    [{name, whatsapp, role}, ...]
    const teamNums   = (settings.internal_team || [])
        .map(x => digits(typeof x === 'string' ? x : (x?.whatsapp || '')))
        .filter(Boolean);
    const senderNum  = digits(raw.senderNumber);

    const isManager = !!managerNum && senderNum === managerNum;
    const isTeam    = teamNums.includes(senderNum) ||
                      (!!settings.team_group_id && raw.chatId === settings.team_group_id);

    const trucker  = !isManager && !isTeam ? matchTruckerByChat(raw.chatId, raw.senderNumber) : null;
    const supplier = !isManager && !isTeam && !trucker ? matchSupplierByChat(raw.chatId, raw.senderNumber) : null;

    const role = isManager ? 'manager' : isTeam ? 'team' : trucker ? 'trucker' : supplier ? 'supplier' : 'unknown';

    return {
        ...raw,
        textLower      : String(raw.text || '').toLowerCase().trim(),
        role,
        matchedTrucker : trucker,
        matchedSupplier: supplier,
        isManagerOrTeam: isManager || isTeam,
        isTrucker      : !!trucker,
        isSupplier     : !!supplier,
        isAuthorized   : role !== 'unknown',
    };
}

// ── Step 2: deterministic policy ──────────────────────────────────────────────
const YES = ['yes', 'y', 'confirm', 'proceed', 'go ahead', 'do it', 'ok', 'okay', 'sure'];
const NO  = ['no', 'n', 'cancel', 'stop', 'nope', "don't"];

function resolveListSelection(text, options) {
    const t = String(text).toLowerCase().trim();
    if (/^\d+$/.test(t)) {
        const i = parseInt(t) - 1;
        if (i >= 0 && i < options.length) return options[i];
    }
    return options.find(o => o.toLowerCase() === t || o.toLowerCase().includes(t)) || null;
}

function policyDecide(ctx) {
    const t = ctx.textLower;

    // ── A. Pending action always wins — never chat-history string matching ────
    if (ctx.isManagerOrTeam && ctx.pendingAction) {
        const p = ctx.pendingAction;
        if (YES.includes(t)) return { intent: 'resolve_pending', resolvedBy: 'policy', data: { answer: 'yes' } };
        if (NO.includes(t))  return { intent: 'resolve_pending', resolvedBy: 'policy', data: { answer: 'no' } };
        if (p.options) {
            const pick = resolveListSelection(ctx.text, p.options);
            if (pick) return { intent: 'resolve_pending', resolvedBy: 'policy', data: { answer: 'yes', selection: pick } };
        }
        // fall through — the manager may be asking something else mid-pending
    }

    // ── B. Manager/team commands ──────────────────────────────────────────────
    if (ctx.isManagerOrTeam) {
        if (['hi', 'hello', 'menu', 'help', 'jarvis'].includes(t)) return { intent: 'show_menu', resolvedBy: 'policy' };

        // Numbered menu replies
        if (/^\d$/.test(t) && ctx.session.menuContext === 'main') {
            const map = { 1: 'bookings_menu', 2: 'forward_booking', 3: 'assign_supplier', 4: 'check_supplier', 5: 'show_contacts', 6: 'show_bookings_week' };
            const intent = map[t];
            if (intent) return { intent, resolvedBy: 'policy', data: {} };
        }
        if (/^\d$/.test(t) && ctx.session.menuContext === 'bookings') {
            const map = { 1: 'show_bookings_urgent', 2: 'show_bookings_all', 3: 'show_bookings_available', 4: 'show_bookings_week', 5: 'ask_booking_number', 6: 'show_bookings_all' };
            const intent = map[t];
            if (intent) return { intent, resolvedBy: 'policy', data: {} };
        }

        if (t === 'bookings')                    return { intent: 'bookings_menu',           resolvedBy: 'policy' };
        if (t === 'urgent')                      return { intent: 'show_bookings_urgent',    resolvedBy: 'policy' };
        if (t === 'available')                   return { intent: 'show_bookings_available', resolvedBy: 'policy' };
        if (['truckers', 'suppliers', 'contacts'].includes(t)) return { intent: 'show_contacts', resolvedBy: 'policy' };

        let m;
        if ((m = t.match(/^forward\s+(\S+)(?:\s+to\s+(.+))?$/)))
            return { intent: 'forward_booking', resolvedBy: 'policy', data: { bkg_no: m[1].toUpperCase(), trucker_name: m[2] || null } };
        if ((m = t.match(/^assign\s+(\S+)(?:\s+to\s+(.+))?$/)))
            return { intent: 'assign_supplier', resolvedBy: 'policy', data: { bkg_no: m[1].toUpperCase(), supplier_name: m[2] || null } };
        if ((m = t.match(/^recall\s+(\S+)$/)))
            return { intent: 'recall_booking', resolvedBy: 'policy', data: { bkg_no: m[1].toUpperCase() } };
        if ((m = t.match(/^archive\s+(\S+)$/)))
            return { intent: 'archive_booking', resolvedBy: 'policy', data: { bkg_no: m[1].toUpperCase() } };
        if ((m = t.match(/^status\s+(\S+)$/)))
            return { intent: 'show_booking_status', resolvedBy: 'policy', data: { bkg_no: m[1].toUpperCase() } };

        // Bare booking number → status
        const bkg = resolveBookingNumber(ctx.text);
        if (bkg && t.split(/\s+/).length === 1)
            return { intent: 'show_booking_status', resolvedBy: 'policy', data: { bkg_no: bkg } };
    }

    // ── C. Trucker signals (single active booking required) ───────────────────
    if (ctx.isTrucker && ctx.activeBooking) {
        const step = ctx.workflow?.step;
        if (ctx.hasMedia) {
            if (step === 'forwarded')
                return { intent: 'empty_drop_confirmed', resolvedBy: 'policy', data: { bkg_no: ctx.activeBooking } };
            if (step === 'load_ready')
                return { intent: 'picked_up_confirmed', resolvedBy: 'policy', data: { bkg_no: ctx.activeBooking, scale_ticket: true } };
            if (step === 'picked_up' && !ctx.workflow?.scale_ticket)
                return { intent: 'scale_ticket_received', resolvedBy: 'policy', data: { bkg_no: ctx.activeBooking } };
            if (step === 'picked_up')
                return { intent: 'ingate_received', resolvedBy: 'policy', data: { bkg_no: ctx.activeBooking } };
        }
        // Whitelisted state-change signals — trucker's message must contain at least one keyword.
        if (/(empty|dropped)/.test(t) && step === 'forwarded')
            return { intent: 'empty_drop_confirmed', resolvedBy: 'policy', data: { bkg_no: ctx.activeBooking } };
        if (/(picked\s*up|loaded)/.test(t) && step === 'load_ready')
            return { intent: 'picked_up_confirmed', resolvedBy: 'policy', data: { bkg_no: ctx.activeBooking, scale_ticket: false } };
        if (/(scale|ticket)/.test(t) && step === 'picked_up' && !ctx.workflow?.scale_ticket)
            return { intent: 'scale_ticket_received', resolvedBy: 'policy', data: { bkg_no: ctx.activeBooking } };
        if (/(ingate|in-gate|gated)/.test(t) && step === 'picked_up')
            return { intent: 'ingate_received', resolvedBy: 'policy', data: { bkg_no: ctx.activeBooking } };
        // Whitelisted info queries — ERD / cutoff date lookup on the trucker's active booking.
        if (/\berd\b/.test(t))
            return { intent: 'trucker_ask_erd', resolvedBy: 'policy', data: { bkg_no: ctx.activeBooking } };
        if (/(cut\s*off|cutoff)/.test(t))
            return { intent: 'trucker_ask_cutoff', resolvedBy: 'policy', data: { bkg_no: ctx.activeBooking } };
        // Silence: message is out-of-scope. Jarvis does NOT reply. Per user rule.
        return { intent: 'silent', resolvedBy: 'policy', data: {} };
    }

    // ── D. Supplier signals ────────────────────────────────────────────────────
    if (ctx.isSupplier && ctx.activeBooking) {
        const step = ctx.workflow?.step;
        if (/(load\s*ready|loaded|ready)/.test(t) && ['supplier_assigned', 'empty_dropped'].includes(step))
            return { intent: 'load_ready_received', resolvedBy: 'policy', data: { bkg_no: ctx.activeBooking } };
        // Same whitelisted info queries for suppliers.
        if (/\berd\b/.test(t))
            return { intent: 'supplier_ask_erd', resolvedBy: 'policy', data: { bkg_no: ctx.activeBooking } };
        if (/(cut\s*off|cutoff)/.test(t))
            return { intent: 'supplier_ask_cutoff', resolvedBy: 'policy', data: { bkg_no: ctx.activeBooking } };
        // Silence: message is out-of-scope.
        return { intent: 'silent', resolvedBy: 'policy', data: {} };
    }

    // ── E. Trucker/supplier with multiple bookings and a booking no. in text ──
    if ((ctx.isTrucker || ctx.isSupplier) && !ctx.activeBooking && ctx.activeSlots.length > 1) {
        const bkg = resolveBookingNumber(ctx.text);
        if (!bkg) return { intent: 'ask_which_booking', resolvedBy: 'policy', data: { slots: ctx.activeSlots.map(s => s.bkgNo) } };
        // re-run C/D logic with explicit booking — hand to AI with strong hint instead of duplicating
    }

    return { intent: null, resolvedBy: null, needsAI: true };
}

// ── Step 3: AI fallback ───────────────────────────────────────────────────────
function buildPrompt(ctx) {
    const a = formatForAI(ctx);
    return `You are Jarvis — the freight operations AI for Edge Metals Inc.
You are one step in a pipeline. The policy layer already handled deterministic cases.
You are called because the message intent is ambiguous.

STRICT RULES:
- Use ONLY the context below. Never invent booking status or facts.
- If required fields are missing, return action: "NEED_DATA".
- If the action is irreversible or high-risk, return action: "NEED_APPROVAL".
- Never return free text outside the JSON.
- Do not assume media exists unless hasMedia is true.
- Do not assume a booking is active unless activeBooking is set.

═══ RUNTIME CONTEXT ═══
Time (LA): ${a.now_la}
Sender: ${a.senderName} | Role: ${a.role}
Has media: ${a.hasMedia}
Active booking: ${a.activeBooking}
Current step: ${a.currentStep}
Bookings owned by this chat: ${a.slots}
Pending action: ${a.pendingAction}

═══ BOOKING ═══
${a.bookingContext}

═══ SESSION ═══
${a.sessionSummary}

═══ LAST 5 MESSAGES ═══
${a.transcripts}

═══ FACTS ═══
${a.facts}

═══ URGENT ═══
${a.urgentBookings}

═══ NEW MESSAGE ═══
"${a.message}"

═══ AVAILABLE ACTIONS ═══
forward_booking, assign_supplier, recall_booking, archive_booking,
show_booking_status, show_bookings_all, show_bookings_urgent,
show_bookings_available, show_bookings_week, show_menu, show_contacts,
empty_drop_confirmed, load_ready_received, picked_up_confirmed,
scale_ticket_received, ingate_received, reply, silent, NEED_DATA, NEED_APPROVAL

Return ONLY this JSON:
{
  "action": "one_of_the_actions_above",
  "confidence": 0.0,
  "bkg_no": null,
  "supplier_name": null,
  "trucker_name": null,
  "reply": null,
  "reasoning": "one sentence"
}`;
}

async function aiDecide(ctx) {
    const decision = await callGeminiJSON(buildPrompt(ctx));
    if (!decision) return { action: 'NEED_DATA', confidence: 0, reasoning: 'AI unavailable' };
    if ((decision.confidence ?? 0) < 0.6) {
        console.warn(`[AI] Low confidence ${decision.confidence} → NEED_DATA`);
        return { ...decision, action: 'NEED_DATA' };
    }
    console.log(`[AI] ${decision.action} (${decision.confidence}) — ${decision.reasoning}`);
    return decision;
}

// ── Step 4: router ────────────────────────────────────────────────────────────
async function route(decision, ctx, sendMessage) {
    const d      = decision.data || {};
    const chatId = ctx.chatId;
    const bkg    = d.bkg_no || ctx.activeBooking;

    const send = async (id, text) => { await sendMessage(id, text); return { action_taken: 'replied' }; };
    const ask  = (id, text) => send(id, text);

    switch (decision.intent) {
        case 'resolve_pending':        return actions.resolvePending(chatId, ctx.pendingAction, d.answer, d.selection);
        case 'show_menu':              return actions.showMenu(chatId);
        case 'bookings_menu':          return actions.showBookingsMenu(chatId);
        case 'show_booking_status':    return bkg ? actions.showBookingStatus(chatId, bkg) : ask(chatId, 'Which booking number?');
        case 'show_bookings_all':      return actions.showBookingsAll(chatId);
        case 'show_bookings_urgent':   return actions.showBookingsUrgent(chatId);
        case 'show_bookings_available':return actions.showBookingsAvailable(chatId);
        case 'show_bookings_week':     return actions.showBookingsWeek(chatId);
        case 'show_contacts':          return actions.showContacts(chatId);
        case 'forward_booking':        return bkg ? actions.forwardBooking(chatId, bkg, d.trucker_name) : ask(chatId, 'Which booking should I forward? e.g. "forward BK123456"');
        case 'assign_supplier':        return bkg ? actions.assignSupplier(chatId, bkg, d.supplier_name) : ask(chatId, 'Which booking should I assign? e.g. "assign BK123456"');
        case 'recall_booking':         return bkg ? actions.recallBooking(chatId, bkg) : ask(chatId, 'Which booking should I recall?');
        case 'archive_booking':        return bkg ? actions.archiveNow(chatId, bkg) : ask(chatId, 'Which booking should I archive?');
        case 'empty_drop_confirmed':   return actions.emptyDropConfirmed(bkg, ctx.senderName);
        case 'load_ready_received':    return actions.loadReadyReceived(bkg, ctx.senderName);
        case 'picked_up_confirmed':    return actions.pickedUpConfirmed(bkg, !!d.scale_ticket, ctx.senderName);
        case 'scale_ticket_received':  return actions.scaleTicketReceived(bkg);
        case 'ingate_received':        return actions.ingateReceived(bkg, ctx.senderName);
        case 'check_supplier':         return ask(chatId, 'Which booking? I will ping its supplier for pickup status.');
        // Whitelist info queries — trucker/supplier can ask ERD or cutoff of their active booking.
        case 'trucker_ask_erd':
        case 'supplier_ask_erd':       return actions.showErd ? actions.showErd(chatId, bkg) : ask(chatId, `ERD: ${(actions.getBookingField && actions.getBookingField(bkg, 'erd_date')) || 'not set'}`);
        case 'trucker_ask_cutoff':
        case 'supplier_ask_cutoff':    return actions.showCutoff ? actions.showCutoff(chatId, bkg) : ask(chatId, `Cutoff: ${(actions.getBookingField && actions.getBookingField(bkg, 'cutoff_date')) || 'not set'}`);
        // Silence — trucker/supplier said something out-of-scope. Jarvis intentionally does not reply.
        case 'silent':                 return { action_taken: 'silent' };
        case 'forward_booking_menu':
        case 'ask_booking_number':     return ask(chatId, 'Type the booking number.');
        case 'ask_which_booking':      return ask(chatId, `This chat has multiple bookings: ${(d.slots || []).join(', ')}. Which one?`);
        case 'reply':                  return d.reply ? send(chatId, d.reply) : { action_taken: 'noop' };
        case 'NEED_APPROVAL':          return ask(chatId, `This needs your explicit confirmation. ${d.reply || 'Please restate the exact action.'}`);
        case 'NEED_DATA':
        default:
            if (ctx.isManagerOrTeam) return ask(chatId, d.reply || "I couldn't pin that down. Type 'menu' for options or give me a booking number.");
            return { action_taken: 'silent' }; // never confuse truckers/suppliers with meta-questions
    }
}

// ── Main entry ────────────────────────────────────────────────────────────────
async function process(rawEvent, sendMessage) {
    const started = Date.now();
    const inbound = normalize(rawEvent);

    if (!inbound.isAuthorized) {
        console.log(`[BRAIN] Unauthorized ${inbound.senderNumber} in ${inbound.chatId} — silent`);
        return;
    }
    if (isDuplicate(inbound.messageId)) return;

    console.log(`[BRAIN] ${inbound.role} | ${inbound.chatId} | "${String(inbound.text).slice(0, 60)}"`);

    const pending = inbound.isManagerOrTeam ? actions.getPending(inbound.chatId) : null;
    const ctx     = buildContext(inbound, pending);

    let decision = policyDecide(ctx);
    if (decision.needsAI) {
        const ai = await aiDecide(ctx);
        decision = {
            intent    : ai.action,
            resolvedBy: 'ai',
            data      : { bkg_no: ai.bkg_no, supplier_name: ai.supplier_name, trucker_name: ai.trucker_name, reply: ai.reply },
        };
    }

    let result = { action_taken: 'error' };
    try {
        result = await route(decision, ctx, sendMessage);
    } catch (err) {
        console.error('[BRAIN] Route failed:', err);
        if (inbound.isManagerOrTeam) await sendMessage(inbound.chatId, `Something broke while handling that: ${err.message}`);
    }

    // Reminder tail — pending still open after an unrelated exchange
    if (inbound.isManagerOrTeam && pending &&
        !['confirmed_pending', 'cancelled_pending', 'forwarded', 'assigned', 'recalled'].includes(result?.action_taken)) {
        const fresh = actions.getPending(inbound.chatId);
        if (fresh && fresh.created_at === pending.created_at) {
            await sendMessage(inbound.chatId, `(Still pending: ${fresh.type.replace(/_/g, ' ')} for ${fresh.bkg_no} — reply yes/no.)`);
        }
    }

    await saveTranscript(inbound.chatId, {
        messageId : inbound.messageId,
        senderRole: inbound.role,
        senderName: inbound.senderName,
        text      : inbound.text,
        hasMedia  : !!inbound.hasMedia,
        intent    : decision.intent,
        resolvedBy: decision.resolvedBy,
        actionTaken: result?.action_taken,
        at        : new Date().toISOString(),
    });

    console.log(`[BRAIN] ${decision.intent} → ${result?.action_taken} (${Date.now() - started}ms)`);
}

module.exports = { process, normalize, policyDecide };