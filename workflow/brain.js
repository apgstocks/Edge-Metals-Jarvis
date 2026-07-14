// ── workflow/brain.js — The pipeline ─────────────────────────────────────────
// inbound → dedupe → context → policy (deterministic) → AI (only if needed)
// → route to actions → transcript.
// Policy resolves everything it can without Gemini: pending yes/no + list
// selections, exact commands, booking numbers, role-scoped media. AI is the
// fallback for ambiguity, never the first resort.
const llmIntent = require('../helpers/llm-intent');
const { loadBrain, saveBrain } = require('../helpers/json');
const { loadSettings, saveTranscript }            = require('../helpers/json');
const { buildContext, formatForAI, updateSession } = require('../helpers/context');
const { resolveBookingNumber, queryBookingsByLocation, formatBookingLine } = require('../helpers/booking');
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

    // ── A0. Ready-check pending — applies to whoever the question was sent to
    // (the supplier), not just manager/team. Runs before everything else so a
    // supplier's yes/no/date reply is never mis-routed to the keyword grammar
    // in section D. ──────────────────────────────────────────────────────────
    if (ctx.pendingAction?.type === 'await_ready_check') {
        const p = ctx.pendingAction;
        if (p.stage === 'yesno') {
            if (/(yes|ready|loaded|done|good to go)/.test(t) && !/not\s+ready/.test(t))
                return { intent: 'ready_check_yes', resolvedBy: 'policy', data: {} };
            if (/(no|not\s+ready|not\s+yet|delay)/.test(t))
                return { intent: 'ready_check_no', resolvedBy: 'policy', data: {} };
            return { intent: 'reply', resolvedBy: 'policy', data: { reply: 'Sorry, is the container ready for pickup? Reply yes or no.' } };
        }
        if (p.stage === 'date') {
            return { intent: 'ready_check_date', resolvedBy: 'policy', data: { date_text: ctx.text.trim() } };
        }
    }

    // ── A. Pending action always wins — never chat-history string matching ────
    if (ctx.isManagerOrTeam && ctx.pendingAction) {
        const p = ctx.pendingAction;
        if (YES.includes(t)) return { intent: 'resolve_pending', resolvedBy: 'policy', data: { answer: 'yes' } };
        if (NO.includes(t))  return { intent: 'resolve_pending', resolvedBy: 'policy', data: { answer: 'no' } };
        if (p.options) {
            const pick = resolveListSelection(ctx.text, p.options);
            if (pick) return { intent: 'resolve_pending', resolvedBy: 'policy', data: { answer: 'yes', selection: pick } };
        }
        if (p.type === 'await_bkg_no') {
            const bkgResolved = resolveBookingNumber(ctx.text);
            if (bkgResolved) return { intent: p.nextIntent, resolvedBy: 'policy', data: { bkg_no: bkgResolved } };
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

        if (t === 'bookings' || /^(?:show\s+(?:me\s+)?|list\s+)?(?:all\s+)?bookings?$/.test(t)) return { intent: 'bookings_menu', resolvedBy: 'policy' };
        if (t === 'urgent' || /^(?:show\s+(?:me\s+)?|list\s+)?urgent\s+bookings?$/.test(t)) return { intent: 'show_bookings_urgent', resolvedBy: 'policy' };
        if (t === 'available' || /^(?:show\s+(?:me\s+)?|list\s+)?available\s+bookings?$/.test(t)) return { intent: 'show_bookings_available', resolvedBy: 'policy' };
        if (['truckers', 'suppliers', 'contacts'].includes(t)) return { intent: 'show_contacts', resolvedBy: 'policy' };

        let m;
        // Grammar supports optional /N suffix for container seq: "forward BKG/1 to Dave"
        // No slash → auto-picks next unassigned container in executeForward.
        // Order-agnostic: "forward BKG to Dave" AND "forward Dave to BKG" both work —
        // whichever captured token actually matches the booking-number FORMAT wins,
        // regardless of position. Without this, "assign him to DALA52325500" silently
        // treated "him" as the booking and DALA52325500 as the supplier name.
        if ((m = t.match(/^forward\s+([A-Za-z0-9-]+)(?:\/(\d+))?(?:\s+to\s+(.+))?$/))) {
            const [first, seq, second] = [m[1], m[2], m[3]];
            const firstIsBkg = resolveBookingNumber(first);
            const secondIsBkg = second && resolveBookingNumber(second);
            const bkg_no = firstIsBkg ? firstIsBkg : (secondIsBkg || first.toUpperCase());
            const trucker_name = firstIsBkg ? (second || null) : (secondIsBkg ? first : (second || null));
            return { intent: 'forward_booking', resolvedBy: 'policy', data: { bkg_no, container_seq: seq ? parseInt(seq, 10) : null, trucker_name } };
        }
        if ((m = t.match(/^assign\s+([A-Za-z0-9-]+)(?:\/(\d+))?(?:\s+to\s+(.+))?$/))) {
            const [first, seq, second] = [m[1], m[2], m[3]];
            const firstIsBkg = resolveBookingNumber(first);
            const secondIsBkg = second && resolveBookingNumber(second);
            const bkg_no = firstIsBkg ? firstIsBkg : (secondIsBkg || first.toUpperCase());
            const supplier_name = firstIsBkg ? (second || null) : (secondIsBkg ? first : (second || null));
            return { intent: 'assign_supplier', resolvedBy: 'policy', data: { bkg_no, container_seq: seq ? parseInt(seq, 10) : null, supplier_name } };
        }
        if ((m = t.match(/^recall\s+(\S+)$/)))
            return { intent: 'recall_booking', resolvedBy: 'policy', data: { bkg_no: m[1].toUpperCase() } };
        if ((m = t.match(/^archive\s+(\S+)$/)))
            return { intent: 'archive_booking', resolvedBy: 'policy', data: { bkg_no: m[1].toUpperCase() } };
        if ((m = t.match(/^status\s+(\S+)$/)))
            return { intent: 'show_booking_status', resolvedBy: 'policy', data: { bkg_no: m[1].toUpperCase() } };

        // "follow up with X" / "please follow up with X in N minutes/hours" — optionally "re BKG123"
        if ((m = t.match(/^(?:please\s+)?follow\s*up\s+with\s+(.+?)(?:\s+in\s+(\d+)\s*(min|mins|minute|minutes|hr|hrs|hour|hours))?(?:\s+(?:re|regarding|about|on)\s+([A-Za-z0-9-]+))?$/))) {
            const rawMins = m[2] ? parseInt(m[2], 10) : null;
            const unit    = m[3] || '';
            const minutes = rawMins != null ? (unit.startsWith('h') ? rawMins * 60 : rawMins) : null;
            return {
                intent: 'schedule_followup', resolvedBy: 'policy',
                data: { target_name: m[1].trim(), minutes, bkg_no: (m[4] || ctx.activeBooking || null)?.toUpperCase?.() || m[4] || ctx.activeBooking || null },
            };
        }

        // "how many bookings [are] unassigned from LA" / "how many bookings from LA" etc.
        if ((m = t.match(/^how\s+many\s+(?:(unassigned|available|assigned|no\s+supplier|without\s+(?:a\s+)?supplier)\s+)?bookings?\s*(?:are\s+|do\s+we\s+have\s+)?(?:(unassigned|available|assigned|no\s+supplier|without\s+(?:a\s+)?supplier)\s+)?(?:from|at|in)\s+(.+?)\??$/))) {
            const statusRaw = (m[1] || m[2] || '').trim();
            const filter = /unassigned|available|no\s+supplier|without/.test(statusRaw) ? 'unassigned'
                         : statusRaw === 'assigned' ? 'assigned' : null;
            return { intent: 'bookings_count_query', resolvedBy: 'policy', data: { location: m[3].trim(), filter } };
        }

        // "show/list [unassigned] bookings from LA" — same filter logic as above,
        // but returns the actual list, not just a count.
        if ((m = t.match(/^(?:show(?:\s+me)?|list)\s+(?:(unassigned|available|assigned|no\s+supplier|without\s+(?:a\s+)?supplier)\s+)?bookings?\s*(?:that\s+are\s+)?(?:(unassigned|available|assigned|no\s+supplier|without\s+(?:a\s+)?supplier)\s+)?(?:from|at|in)\s+(.+?)\??$/))) {
            const statusRaw = (m[1] || m[2] || '').trim();
            const filter = /unassigned|available|no\s+supplier|without/.test(statusRaw) ? 'unassigned'
                         : statusRaw === 'assigned' ? 'assigned' : null;
            return { intent: 'bookings_list_query', resolvedBy: 'policy', data: { location: m[3].trim(), filter } };
        }

        // "remember X" / "note X" / "remember that X" — explicit standing-fact capture.
        // ctx.text (not lowercased t) preserves the original casing of the fact itself.
        if ((m = ctx.text.trim().match(/^(?:please\s+)?(?:remember|note)(?:\s+that)?:?\s+(.+)$/i)))
            return { intent: 'remember_fact', resolvedBy: 'policy', data: { fact: m[1].trim() } };

        // "business context: X" / "context note: X" — durable situational notes,
        // deliberately a different trigger phrase from remember/note (facts).
        if ((m = ctx.text.trim().match(/^(?:business\s+context|context\s+note)\s*:\s*(.+)$/i)))
            return { intent: 'add_business_context', resolvedBy: 'policy', data: { note: m[1].trim() } };

        // "check supplier BKG123" — pings the supplier for pickup readiness
        if ((m = t.match(/^check\s+supplier\s+(\S+)$/)))
            return { intent: 'check_supplier', resolvedBy: 'policy', data: { bkg_no: m[1].toUpperCase() } };

        // Bare booking number → status
        const bkg = resolveBookingNumber(ctx.text);
        if (bkg && t.split(/\s+/).length === 1)
            return { intent: 'show_booking_status', resolvedBy: 'policy', data: { bkg_no: bkg } };
    }

    // ── C. Trucker signals — with per-container disambiguation ───────────────
    // Trucker types a state message ("empty dropped"). We need to figure out:
    //   which booking, and which container within that booking.
    // Options:
    //   0 active assignments → silent (out-of-scope)
    //   1 booking + 1 container → auto-apply
    //   1 booking + 2+ containers matching stage → ask "which container?"
    //   2+ bookings → ask "which booking?" first
    if (ctx.isTrucker) {
        const containers = require('../helpers/containers');
        const { loadBookings } = require('../helpers/json');
        const bookings = loadBookings();
        const truckerName = ctx.matchedTrucker?.name;

        // Which state intent is this message? Returns {kind, requiredStage} or null.
        const classify = () => {
            if (ctx.hasMedia) {
                // Media alone can't tell us the stage — infer from what containers this trucker has.
                // Pick the most-common current stage among their assignments; brain uses that to route.
                return { kind: 'media', requiredStage: null };
            }
            if (/(empty|dropped)/.test(t))               return { kind: 'empty_drop',   requiredStage: 'forwarded' };
            if (/(picked\s*up|loaded)/.test(t))          return { kind: 'picked_up',    requiredStage: 'load_ready' };
            if (/(scale|ticket)/.test(t))                return { kind: 'scale_ticket', requiredStage: 'picked_up' };
            if (/(ingate|in-gate|gated)/.test(t))        return { kind: 'ingate',       requiredStage: 'picked_up' };
            return null;
        };

        const stateSig = classify();
        if (stateSig) {
            // Find every active (in-progress) container this trucker owns.
            const active = truckerName
                ? containers.findActiveAssignments(bookings, 'trucker', truckerName)
                : [];

            // Filter to those matching the required stage (empty-drop only from forwarded containers, etc).
            // For media (kind='media'), don't stage-filter — accept any active assignment.
            const matches = stateSig.kind === 'media'
                ? active
                : active.filter(a => (a.container.stage || 'not_started') === stateSig.requiredStage);

            if (matches.length === 0) {
                // Trucker used a state keyword but has no matching container. Silent (whitelist rule).
                return { intent: 'silent', resolvedBy: 'policy', data: {} };
            }

            // For 'media' with mixed stages, prefer inferring the actual state.
            let stageKind = stateSig.kind;
            if (stageKind === 'media') {
                // Auto-pick based on the container's current stage.
                const stagesInMatches = new Set(matches.map(m => m.container.stage));
                if      (stagesInMatches.has('forwarded'))     stageKind = 'empty_drop';
                else if (stagesInMatches.has('load_ready'))    stageKind = 'picked_up';
                else if (stagesInMatches.has('picked_up'))     stageKind = 'ingate';
                else return { intent: 'silent', resolvedBy: 'policy', data: {} };
            }

            const intentName =
                stageKind === 'empty_drop'   ? 'empty_drop_confirmed' :
                stageKind === 'picked_up'    ? 'picked_up_confirmed'  :
                stageKind === 'scale_ticket' ? 'scale_ticket_received':
                                               'ingate_received';

            // Count DISTINCT bookings in matches.
            const bookingsInMatches = [...new Set(matches.map(m => m.bookingNumber))];

            // Case 1: 1 booking, 1 matching container → auto-apply.
            if (bookingsInMatches.length === 1 && matches.length === 1) {
                return { intent: intentName, resolvedBy: 'policy',
                         data: { bkg_no: matches[0].bookingNumber, container_seq: matches[0].container.seq,
                                 scale_ticket: stageKind === 'picked_up' && stateSig.kind === 'media' } };
            }

            // Case 2: 1 booking, 2+ matching containers → ask which container.
            if (bookingsInMatches.length === 1) {
                return { intent: 'ask_which_container', resolvedBy: 'policy',
                         data: { bkg_no: bookingsInMatches[0], intent_to_resolve: intentName,
                                 has_media: !!ctx.hasMedia,
                                 container_options: matches.map(m => m.container.seq) } };
            }

            // Case 3: 2+ bookings → ask which booking first.
            return { intent: 'ask_which_booking', resolvedBy: 'policy',
                     data: { intent_to_resolve: intentName, has_media: !!ctx.hasMedia,
                             booking_options: bookingsInMatches } };
        }

        // Info queries — trucker asks ERD / cutoff. Requires activeBooking (single-container heuristic).
        if (ctx.activeBooking) {
            if (/\berd\b/.test(t))
                return { intent: 'trucker_ask_erd', resolvedBy: 'policy', data: { bkg_no: ctx.activeBooking } };
            if (/(cut\s*off|cutoff)/.test(t))
                return { intent: 'trucker_ask_cutoff', resolvedBy: 'policy', data: { bkg_no: ctx.activeBooking } };
        }
        // No keyword matched at all — this is genuinely unrecognized free text (e.g. "truck broke
        // down"), not a known-shape message with nothing to do. Let AI take a pass; if AI also
        // can't classify it, route()'s NEED_DATA fallback escalates to the manager.
        return { intent: null, resolvedBy: null, needsAI: true };
    }

    // ── D. Supplier signals ──────────────────────────────────────────────────
    if (ctx.isSupplier) {
        const containers = require('../helpers/containers');
        const { loadBookings } = require('../helpers/json');
        const bookings = loadBookings();
        const supplierName = ctx.matchedSupplier?.name;

        // Supplier fires "load ready" — must be on a container currently at supplier_assigned or empty_dropped.
        if (/(load\s*ready|loaded|ready)/.test(t)) {
            const active = supplierName
                ? containers.findActiveAssignments(bookings, 'supplier', supplierName, ['supplier_assigned','empty_dropped'])
                : [];
            if (active.length === 0) return { intent: 'silent', resolvedBy: 'policy', data: {} };

            const bookingsInMatches = [...new Set(active.map(m => m.bookingNumber))];

            if (bookingsInMatches.length === 1 && active.length === 1) {
                return { intent: 'load_ready_received', resolvedBy: 'policy',
                         data: { bkg_no: active[0].bookingNumber, container_seq: active[0].container.seq } };
            }

            if (bookingsInMatches.length === 1) {
                return { intent: 'ask_which_container', resolvedBy: 'policy',
                         data: { bkg_no: bookingsInMatches[0], intent_to_resolve: 'load_ready_received',
                                 has_media: false, container_options: active.map(m => m.container.seq) } };
            }

            return { intent: 'ask_which_booking', resolvedBy: 'policy',
                     data: { intent_to_resolve: 'load_ready_received', has_media: false,
                             booking_options: bookingsInMatches } };
        }

        // Info queries scoped to activeBooking (single-container heuristic).
        if (ctx.activeBooking) {
            if (/\berd\b/.test(t))
                return { intent: 'supplier_ask_erd', resolvedBy: 'policy', data: { bkg_no: ctx.activeBooking } };
            if (/(cut\s*off|cutoff)/.test(t))
                return { intent: 'supplier_ask_cutoff', resolvedBy: 'policy', data: { bkg_no: ctx.activeBooking } };
        }
        // Same rule as trucker section: unrecognized free text goes to AI, not hard silence.
        return { intent: null, resolvedBy: null, needsAI: true };
    }

    // ── E. Trucker/supplier with multiple bookings and a booking no. in text ──
    if ((ctx.isTrucker || ctx.isSupplier) && !ctx.activeBooking && ctx.activeSlots.length > 1) {
        const bkg = resolveBookingNumber(ctx.text);
        if (!bkg) return { intent: 'ask_which_booking', resolvedBy: 'policy', data: { slots: ctx.activeSlots.map(s => s.bkgNo) } };
        // re-run C/D logic with explicit booking — hand to AI with strong hint instead of duplicating
    }

    // ── F. Bare location follow-up to a just-shown bookings listing ───────────
    // "show available bookings" → "from oakland" / "Oakland" (no "show/list/how
    // many" wrapper) should narrow the SAME query, not repeat it unfiltered.
    // Guarded tightly: only fires for manager/team, only right after a bookings
    // query, and only for short alphabetic text — avoids treating "thanks" or
    // "ok" typed right after a listing as a location.
    if (ctx.isManagerOrTeam && ctx.session?.lastInstruction === 'bookings_query') {
        const stripped = t.replace(/^(?:from|at|in)\s+/, '').trim();
        const wordCount = stripped.split(/\s+/).filter(Boolean).length;
        const looksLikeLocation = stripped.length >= 2 && wordCount <= 3 && /^[a-z\s.'-]+$/i.test(stripped)
            && !['yes','no','ok','okay','thanks','thank you','hi','hello','menu','cancel'].includes(stripped);
        if (looksLikeLocation) {
            return {
                intent: 'bookings_list_query', resolvedBy: 'policy',
                data: { location: stripped, filter: ctx.session.lastBookingsFilter ?? null },
            };
        }
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
- You reach this prompt ONLY when the deterministic command grammar found no exact match — that's expected for typos, informal phrasing, or wording it doesn't anticipate, NOT a sign the message is unintelligible. Read past spelling: "bookking" means "booking", "avilable" means "available", "shw me" means "show me". If the corrected reading maps clearly onto one of the AVAILABLE ACTIONS below, use that action confidently — do not fall back to NEED_DATA or a generic "couldn't understand" reply just because the exact letters didn't match a pattern. A real assistant reads intent through typos; only use NEED_DATA when the actual MEANING is genuinely ambiguous or missing information, never because of spelling.
- For anything specific to Edge Metals' own data — booking status, dates, who's assigned, counts, contacts — use ONLY the context below. The ALL ACTIVE BOOKINGS / PORT SUMMARY / TRUCKERS ON FILE / SUPPLIERS ON FILE sections are your complete knowledge base for everything currently active — search across ALL of it, not just activeBooking, before saying you don't know. Never invent or guess a fact that isn't there.
- Archived/completed bookings are NOT included in the context above (kept out to bound token cost). If a question is plausibly about an older/closed booking not in ALL ACTIVE BOOKINGS, say it may be archived and suggest checking the dashboard → History — do not guess, and do not claim it doesn't exist.
- For general freight/logistics knowledge NOT specific to Edge Metals' data (e.g. "what does FCL mean", "what happens if we miss cutoff", "typical transit time LA to Busan", "what's a bill of lading") — answer from your own general knowledge via "reply", like a knowledgeable freight ops assistant would. Don't refuse or say NEED_DATA just because it's not in the context block; that restriction is only for YOUR business's specific data, not general domain expertise. If mixing the two, clearly ground the business-specific part in context and flag anything you're unsure of.
- If required fields are missing, return action: "NEED_DATA".
- If the action is irreversible or high-risk, return action: "NEED_APPROVAL".
- Never return free text outside the JSON.
- Do not assume media exists unless hasMedia is true.
- Do not assume a booking is active unless activeBooking is set.
- The AVAILABLE ACTIONS list is EXHAUSTIVE. The ONLY future/deferred capability you have is "schedule_followup" (a WhatsApp nudge sent later to a trucker or supplier). You cannot set reminders for the manager, send emails, make phone calls, or do anything else deferred. If asked for any of those, use "reply" to briefly decline — do NOT promise anything you can't do.
- For "schedule_followup": target_name is REQUIRED (the trucker/supplier name — from context if not restated). minutes is optional (defaults to 30 if omitted — say so in reasoning). bkg_no should be activeBooking if the conversation is clearly about one booking.
- When activeBooking is set AND the message clearly refers to an action verb ("forward", "assign", "recall", "archive", "status") WITHOUT naming a booking number, use activeBooking as bkg_no. Do NOT return NEED_DATA in this case.
- For action "reply": NEVER restate, paraphrase, or echo the user's message back to them. A reply must add information, ask a specific clarifying question, or state what you can/cannot do. If you have nothing useful to add, use "NEED_DATA" instead of a hollow reply.
- "silent" is ONLY for a trucker/supplier message that is clearly not operational (small talk, wrong-number chatter, an emoji with no context). If the sender (role is "trucker" or "supplier") sent something that could plausibly be about their job — a question, a problem, a status update you can't quite place — use "NEED_DATA", not "silent". NEED_DATA for a trucker/supplier gets escalated to the manager; "silent" gets no response at all, so default to NEED_DATA when unsure.
- If the sender's role is "manager" or "team" and the message is a genuine question rather than a command (e.g. "why is DALA23991600 stuck", "how many bookings are unassigned from LA", "what does FCL mean", "which truckers do we have in Houston", "what's the busiest lane this week", "should I worry about anything today", "what's Jey's status"), ANSWER IT — using the ALL ACTIVE BOOKINGS / PORT SUMMARY / TRUCKERS ON FILE / SUPPLIERS ON FILE / SESSION / FACTS / URGENT context for anything Edge-Metals-specific, and your own general freight knowledge for anything else. Give a direct, specific answer via action "reply". Do not fall back to NEED_DATA just because the question isn't one of the defined command actions. NEED_DATA is ONLY for when a question needs Edge Metals' own specific data that genuinely isn't in the context above (including plausibly-archived bookings) — say specifically what's missing. It is never a valid response to a general knowledge question; if you know the answer generally, answer it.
- Two DIFFERENT questions that sound similar — never blur them: (1) "who is THE supplier/trucker FOR BOOKING X" or "for the Oakland booking" means the contact actually ASSIGNED to that specific booking — check the booking's own supplier/trucker field in ALL ACTIVE BOOKINGS, and if it's empty, say clearly it isn't assigned yet. (2) "who is A supplier/trucker IN/AT/FOR [a city]" or "show me Oakland suppliers" means the roster — check TRUCKERS ON FILE / SUPPLIERS ON FILE for contacts whose locality matches, which has NOTHING to do with any specific booking's assignment. When answering (2), never phrase it as "X is THE supplier for [booking/city]" — that reads as an assignment claim. Say "X is a registered supplier based in [city]" instead, and if relevant, separately note whether any booking there is still unassigned.
- If the manager is CORRECTING something you (or an earlier assistant turn in LAST 5 MESSAGES) got wrong, or giving a standing instruction/preference for the future (e.g. "no, always CC me on archives", "actually DALA numbers can have a dash", "from now on default follow-ups to 15 minutes"), use action "remember_fact" with a short, self-contained fact string in the "fact" field — written so it makes sense on its own later, without today's conversation. Still also use "reply" wording is not needed for this action; a brief confirmation is generated automatically. Do not use "remember_fact" for one-off operational commands (those already have real actions) — only for corrections or durable preferences that should change future behavior.
- If the manager is sharing ongoing situational background that ISN'T a correction — e.g. "we're onboarding a new supplier in Houston this month", "trucker capacity is tight through the holidays" — use action "add_business_context" with the note in the "note" field, not "remember_fact". Distinction: remember_fact changes how you should BEHAVE (a rule/correction); add_business_context is just something true right now worth knowing about (a situation).

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

═══ FACTS (corrections / standing instructions) ═══
${a.facts}

═══ BUSINESS CONTEXT (ongoing situations, not corrections) ═══
${a.businessContext}

═══ RECENT SESSIONS WITH THIS CHAT (continuity across restarts/idle gaps) ═══
${a.recentSummaries}

═══ URGENT ═══
${a.urgentBookings}

═══ ALL ACTIVE BOOKINGS (your full knowledge base — not just activeBooking) ═══
${a.bookingsTable}

═══ PORT SUMMARY ═══
${a.portStats}

═══ TRUCKERS ON FILE ═══
${a.truckerRoster}

═══ SUPPLIERS ON FILE ═══
${a.supplierRoster}

═══ NEW MESSAGE ═══
"${a.message}"

═══ AVAILABLE ACTIONS ═══
forward_booking, assign_supplier, recall_booking, archive_booking,
show_booking_status, show_bookings_all, show_bookings_urgent,
show_bookings_available, show_bookings_week, show_menu, show_contacts,
empty_drop_confirmed, load_ready_received, picked_up_confirmed,
scale_ticket_received, ingate_received, schedule_followup, remember_fact, add_business_context,
reply, silent, NEED_DATA, NEED_APPROVAL

Return ONLY this JSON:
{
  "action": "one_of_the_actions_above",
  "confidence": 0.0,
  "bkg_no": null,
  "supplier_name": null,
  "trucker_name": null,
  "target_name": null,
  "minutes": null,
  "fact": null,
  "note": null,
  "reply": null,
  "reasoning": "one sentence"
}`;
}

const SAFE_ACTIONS = new Set([
    'reply', 'silent', 'NEED_DATA', 'NEED_APPROVAL',
    'show_menu', 'bookings_menu', 'show_booking_status', 'show_bookings_all',
    'show_bookings_urgent', 'show_bookings_available', 'show_bookings_week',
    'show_contacts', 'check_supplier', 'remember_fact', 'add_business_context',
    'trucker_ask_erd', 'supplier_ask_erd', 'trucker_ask_cutoff', 'supplier_ask_cutoff',
]);

async function aiDecide(ctx) {
    const decision = await callGeminiJSON(buildPrompt(ctx));
    if (!decision) return { action: 'NEED_DATA', confidence: 0, reasoning: 'AI unavailable' };
    // Confidence gate protects actions that mutate data (forward, assign, archive, etc).
    // A conversational "reply" or a read-only lookup has no side effects — don't crush
    // a genuinely useful answer into a canned "I couldn't pin that down" just because
    // Gemini's confidence score for free-text Q&A tends to run lower than for clean commands.
    if (!SAFE_ACTIONS.has(decision.action) && (decision.confidence ?? 0) < 0.6) {
        console.warn(`[AI] Low confidence ${decision.confidence} on mutating action "${decision.action}" → NEED_DATA`);
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
    const askBkg = async (id, text, nextIntent) => {
        await actions.setPending(id, { type: 'await_bkg_no', nextIntent });
        return send(id, text);
    };
    if (ctx.pendingAction?.type === 'await_bkg_no') {
        try { await actions.clearPending(chatId); } catch {}
    }

    switch (decision.intent) {
        case 'resolve_pending':        return actions.resolvePending(chatId, ctx.pendingAction, d.answer, d.selection);
        case 'show_menu':              return actions.showMenu(chatId);
        case 'bookings_menu':          return actions.showBookingsMenu(chatId);
        case 'show_booking_status':    return bkg ? actions.showBookingStatus(chatId, bkg) : askBkg(chatId, 'Which booking number?', 'show_booking_status');
        case 'show_bookings_all':      return actions.showBookingsAll(chatId);
        case 'show_bookings_urgent':   return actions.showBookingsUrgent(chatId);
        case 'show_bookings_available':updateSession(chatId, { lastInstruction: 'bookings_query', lastBookingsFilter: 'unassigned' }); return actions.showBookingsAvailable(chatId);
        case 'show_bookings_week':     return actions.showBookingsWeek(chatId);
        case 'show_contacts':          return actions.showContacts(chatId);
        case 'forward_booking':        return bkg ? actions.forwardBooking(chatId, bkg, d.trucker_name, d.container_seq) : askBkg(chatId, 'Which booking should I forward? e.g. "forward BK123456"', 'forward_booking');
        case 'assign_supplier':        return bkg ? actions.assignSupplier(chatId, bkg, d.supplier_name, d.container_seq) : askBkg(chatId, 'Which booking should I assign? e.g. "assign BK123456"', 'assign_supplier');
        case 'recall_booking':         return bkg ? actions.recallBooking(chatId, bkg) : askBkg(chatId, 'Which booking should I recall?', 'recall_booking');
        case 'archive_booking':        return bkg ? actions.archiveNow(chatId, bkg) : askBkg(chatId, 'Which booking should I archive?', 'archive_booking');
        case 'schedule_followup':      return d.target_name ? actions.scheduleFollowup(chatId, d.target_name, d.minutes, bkg, ctx.senderName) : ask(chatId, 'Follow up with whom?');
        case 'remember_fact':          return actions.rememberFact(chatId, d.fact);
        case 'add_business_context':   return actions.addBusinessContext(chatId, d.note);
        case 'bookings_count_query': {
            updateSession(chatId, { lastInstruction: 'bookings_query', lastBookingsFilter: d.filter });
            const { count, bookings } = queryBookingsByLocation(d.location, d.filter);
            const label = d.filter === 'unassigned' ? 'unassigned (no supplier) ' : d.filter === 'assigned' ? 'assigned ' : '';
            const list = count && count <= 10 ? `: ${bookings.join(', ')}` : '';
            return send(chatId, `${count} ${label}booking${count === 1 ? '' : 's'} from ${d.location}${list}`);
        }
        case 'bookings_list_query': {
            updateSession(chatId, { lastInstruction: 'bookings_query', lastBookingsFilter: d.filter });
            const { count, records } = queryBookingsByLocation(d.location, d.filter);
            const label = d.filter === 'unassigned' ? 'Unassigned (no supplier) ' : d.filter === 'assigned' ? 'Assigned ' : '';
            if (!count) return send(chatId, `No ${label.toLowerCase()}bookings from ${d.location}.`);
            const body = records.map(b => formatBookingLine(b)).join('\n');
            return send(chatId, `${label}bookings from ${d.location} (${count}):\n${body}`);
        }
        case 'empty_drop_confirmed':   return actions.emptyDropConfirmed(bkg, ctx.senderName, d.container_seq);
        case 'load_ready_received':    return actions.loadReadyReceived(bkg, ctx.senderName, d.container_seq);
        case 'picked_up_confirmed':    return actions.pickedUpConfirmed(bkg, !!d.scale_ticket, ctx.senderName, d.container_seq);
        case 'scale_ticket_received':  return actions.scaleTicketReceived(bkg, d.container_seq);
        case 'ingate_received':        return actions.ingateReceived(bkg, ctx.senderName, d.container_seq);
        case 'ask_which_container':    return actions.askWhichContainer(chatId, d);
        case 'ask_which_booking':      return actions.askWhichBooking(chatId, d, ctx.matchedTrucker?.name || ctx.matchedSupplier?.name, ctx.isSupplier ? 'supplier' : 'trucker');
        case 'check_supplier':         return bkg ? actions.checkSupplierReadiness(chatId, bkg, d.container_seq) : askBkg(chatId, 'Which booking? I will ping its supplier for pickup status.', 'check_supplier');
        case 'ready_check_yes':        return actions.resolveReadyCheckYes(chatId, ctx.pendingAction);
        case 'ready_check_no':         return actions.resolveReadyCheckNo(chatId, ctx.pendingAction);
        case 'ready_check_date':       return actions.resolveReadyCheckDate(chatId, ctx.pendingAction, d.date_text);
        // Whitelist info queries — trucker/supplier can ask ERD or cutoff of their active booking.
        case 'trucker_ask_erd':
        case 'supplier_ask_erd':       return actions.showErd ? actions.showErd(chatId, bkg) : ask(chatId, `ERD: ${(actions.getBookingField && actions.getBookingField(bkg, 'erd_date')) || 'not set'}`);
        case 'trucker_ask_cutoff':
        case 'supplier_ask_cutoff':    return actions.showCutoff ? actions.showCutoff(chatId, bkg) : ask(chatId, `Cutoff: ${(actions.getBookingField && actions.getBookingField(bkg, 'cutoff_date')) || 'not set'}`);
        // Silence — trucker/supplier used a recognized keyword but no container matched it.
        // Deliberate: this is a known-shape message with nothing to do, not "we don't understand".
        case 'silent':                 return { action_taken: 'silent' };
        case 'forward_booking_menu':
        case 'ask_booking_number':     return askBkg(chatId, 'Type the booking number.', 'show_booking_status');
        case 'ask_which_booking':      return ask(chatId, `This chat has multiple bookings: ${(d.slots || []).join(', ')}. Which one?`);
        case 'reply':                  return d.reply ? send(chatId, d.reply) : { action_taken: 'noop' };
        case 'NEED_APPROVAL':          return ask(chatId, `This needs your explicit confirmation. ${d.reply || 'Please restate the exact action.'}`);
        case 'NEED_DATA':
        default:
            if (ctx.isManagerOrTeam) {
                // Only log as a "gap to learn from" when this genuinely reached Gemini and
                // came back unresolved — not when Gemini itself was unavailable (that's an
                // outage, not a knowledge gap) and not on trivial policy-layer misses.
                if (decision.resolvedBy === 'ai' && d.reasoning !== 'AI unavailable') {
                    try { await actions.logKnowledgeGap(ctx, d.reasoning); } catch (e) { console.error('[BRAIN] gap log failed:', e.message); }
                }
                return ask(chatId, d.reply || "I couldn't pin that down. Type 'menu' for options or give me a booking number.");
            }
            // Trucker/supplier said something we genuinely couldn't classify (reached here via
            // AI fallback, not the policy-layer keyword-silence above). Escalate, don't ignore.
            if (ctx.isTrucker || ctx.isSupplier) return actions.escalateUnclear(ctx);
            return { action_taken: 'silent' }; // truly unknown sender — stay silent
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

    // Pending state now applies to any authorized chat, not just manager/team —
    // the "check supplier" ready flow needs a pending question on the SUPPLIER's
    // own chat (awaiting yes/no, then possibly a date).
    const pending = actions.getPending(inbound.chatId);
    const ctx     = buildContext(inbound, pending);

    let decision = policyDecide(ctx);
    if (decision.needsAI) {
        const ai = await aiDecide(ctx);
        decision = {
            intent    : ai.action,
            resolvedBy: 'ai',
            data      : { bkg_no: ai.bkg_no, supplier_name: ai.supplier_name, trucker_name: ai.trucker_name, target_name: ai.target_name, minutes: ai.minutes, fact: ai.fact, note: ai.note, reply: ai.reply },
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
// ── LLM fallback for manager/team messages ──────────────────────────────────
// Called ONLY when deterministic policy layer returns unresolved.
// Returns { intent, data, resolvedBy, confidence } for router, or null to
// fall through to menu / "I don't understand".
async function handleManagerLLMFallback(text, chatId, sendMessage) {
    const decision = await llmIntent.extractManagerIntent(text);
    const verdict  = llmIntent.gate(decision);

    if (verdict === 'fallthrough') return null;

    if (verdict === 'fire') {
        return {
            intent     : decision.intent,
            data       : decision.data,
            resolvedBy : 'llm',
            confidence : decision.confidence,
        };
    }

    // verdict === 'confirm' — stash pending, ask yes/no
    const brain = loadBrain();
    const key   = `llm_confirm_${Date.now()}`;
    brain.pending_actions = brain.pending_actions || {};
    brain.pending_actions[key] = {
        description : llmIntent.describeIntent(decision),
        data        : { intent: decision.intent, data: decision.data },
        expected    : 'yes_no',
        source      : 'llm',
        created_at  : new Date().toISOString(),
        expires_at  : new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };
    saveBrain(brain);

    await sendMessage(chatId,
        `Did you mean: ${llmIntent.describeIntent(decision)}?\n\n` +
        `Reply 1 to confirm, 2 to cancel.`
    );

    return { intent: 'awaiting_confirmation', resolvedBy: 'llm', data: {}, confidence: decision.confidence };
}

module.exports = { process, normalize, policyDecide };