// ── workflow/brain.js — The pipeline ─────────────────────────────────────────
// inbound → dedupe → context → policy (deterministic) → AI (only if needed)
// → route to actions → transcript.
// Policy resolves everything it can without Gemini: pending yes/no + list
// selections, exact commands, booking numbers, role-scoped media. AI is the
// fallback for ambiguity, never the first resort.
const llmIntent = require('../helpers/llm-intent');
const { appendAuditLog } = require('../helpers/auditlog');
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
async function normalize(raw) {
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

    // Group identity resolves FIRST, unconditionally — a message sent
    // inside a registered trucker/supplier group belongs to that
    // trucker/supplier, regardless of who's personally typing it. The
    // manager is often a member of these groups for visibility; a real
    // incident: the manager typed "load ready" inside APS's supplier group,
    // and the OLD order (isManager checked before group matching) silently
    // attributed it to the manager instead of APS, skipping the whole
    // trucker-notification flow entirely. Only when the chat ISN'T a
    // registered group does personal-number-based manager/team detection apply.
    const trucker  = await matchTruckerByChat(raw.chatId, raw.senderNumber);
    const supplier = !trucker ? await matchSupplierByChat(raw.chatId, raw.senderNumber) : null;
    const isRegisteredGroupChat = (trucker && trucker.group_id === raw.chatId) || (supplier && supplier.group_id === raw.chatId);

    const isManager = !isRegisteredGroupChat && !!managerNum && senderNum === managerNum;
    const isTeam    = !isRegisteredGroupChat && (teamNums.includes(senderNum) ||
                      (!!settings.team_group_id && raw.chatId === settings.team_group_id));

    // Group identity wins for group chats; for personal DMs, manager/team
    // identity still wins over a coincidental personal-number match.
    const finalTrucker  = isRegisteredGroupChat ? trucker  : (!isManager && !isTeam ? trucker  : null);
    const finalSupplier = isRegisteredGroupChat ? supplier : (!isManager && !isTeam ? supplier : null);

    const role = isManager ? 'manager' : isTeam ? 'team' : finalTrucker ? 'trucker' : finalSupplier ? 'supplier' : 'unknown';

    return {
        ...raw,
        textLower      : String(raw.text || '').toLowerCase().trim(),
        role,
        matchedTrucker : finalTrucker,
        matchedSupplier: finalSupplier,
        isManagerOrTeam: isManager || isTeam,
        isTrucker      : !!finalTrucker,
        isSupplier     : !!finalSupplier,
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

// ── Typo tolerance — deterministic, not LLM-dependent ────────────────────────
// Relying on Gemini to "read through" typos proved unreliable in practice
// (tested twice with explicit prompt instructions, still missed "bookking").
// This fixes it in code instead: single-word edit-distance correction against
// the small set of command keywords the grammar below actually looks for.
// Only touches the LOCAL text used for policy matching — ctx.text/textLower
// stay untouched, so the AI still sees the person's original wording verbatim
// if it ever needs to fall back that far.
const COMMAND_KEYWORDS = [
    'booking', 'bookings', 'available', 'unassigned', 'assigned', 'supplier', 'suppliers',
    'trucker', 'truckers', 'forward', 'assign', 'archive', 'recall', 'status', 'cutoff',
    'menu', 'urgent', 'contacts', 'remember', 'context',
];
// Abbreviations aren't typos — "avl" isn't letter-close to "available", it's a
// different word entirely that happens to mean the same thing. Edit-distance
// can never catch these; they need a direct dictionary lookup instead, tried
// FIRST (exact match on the whole token) before the fuzzy edit-distance pass.
const ABBREVIATIONS = {
    avl: 'available', avail: 'available',
    bkg: 'booking', bkgs: 'bookings', bk: 'booking', bks: 'bookings',
    sup: 'supplier', sups: 'suppliers', splr: 'supplier',
    trk: 'trucker', trks: 'truckers', trkr: 'trucker',
    unassgn: 'unassigned', unassn: 'unassigned',
    asgn: 'assign', asn: 'assign',
    fwd: 'forward',
    mgr: 'manager',
    cntx: 'context', ctx: 'context',
};
function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
        dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    return dp[m][n];
}
function fuzzyCorrectKeywords(text) {
    return text.split(/(\s+)/).map(tok => {
        if (!/^[a-z]+$/i.test(tok)) return tok; // skip whitespace, punctuation, booking numbers
        const lower = tok.toLowerCase();
        if (COMMAND_KEYWORDS.includes(lower)) return tok; // already correct
        if (ABBREVIATIONS[lower]) return ABBREVIATIONS[lower]; // exact abbreviation match, no distance check needed
        if (lower.length < 4) return tok; // too short for safe fuzzy matching (avoids "to"/"at" false positives)
        let best = null, bestDist = Infinity;
        for (const kw of COMMAND_KEYWORDS) {
            const d = levenshtein(lower, kw);
            if (d < bestDist) { bestDist = d; best = kw; }
        }
        const maxAllowed = lower.length >= 7 ? 2 : 1; // longer words tolerate more edits
        return (best && bestDist <= maxAllowed) ? best : tok;
    }).join('');
}

function policyDecide(ctx) {
    const t = fuzzyCorrectKeywords(ctx.textLower);

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

    // ── A0b. Container-number pending — no fixed format exists for these
    // (confirmed — not ISO-standard, don't pattern-match), so the ONLY
    // reliable way to capture it is: whatever they reply to THIS specific
    // question, verbatim, is the answer. Same priority as A0 so it can't be
    // mis-routed to keyword grammar either.
    if (ctx.pendingAction?.type === 'await_container_number') {
        return { intent: 'container_number_received', resolvedBy: 'policy', data: { container_number: ctx.text.trim() } };
    }

    // ── A0c. Relay-question reply — whatever the target says in response to
    // "ask_contact" is captured verbatim and relayed back to whoever asked.
    // Same reasoning as the container-number capture: no fixed format to
    // match against, the pending itself is the validation.
    if (ctx.pendingAction?.type === 'await_relay_reply') {
        return { intent: 'relay_reply_received', resolvedBy: 'policy', data: { reply_text: ctx.text.trim() } };
    }

    // ── A0b. End-of-day fact-batch confirmation — same "runs before section A's
    // generic yes/no" reasoning as await_ready_check above: "all" and "1,3"
    // don't match the YES/NO arrays or a plain list selection, so this needs
    // its own parse, not the generic pending handler. ──────────────────────────
    if (ctx.pendingAction?.type === 'await_fact_batch') {
        const tt = ctx.text.trim().toLowerCase();
        if (/^(no|none|skip|cancel)$/.test(tt))
            return { intent: 'resolve_fact_batch', resolvedBy: 'policy', data: { selection: [] } };
        if (tt === 'all')
            return { intent: 'resolve_fact_batch', resolvedBy: 'policy', data: { selection: 'all' } };
        const nums = tt.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n) && n > 0);
        if (nums.length)
            return { intent: 'resolve_fact_batch', resolvedBy: 'policy', data: { selection: nums } };
        return { intent: 'reply', resolvedBy: 'policy', data: { reply: 'Reply with numbers (e.g. "1,3"), "all", or "no".' } };
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
        // "send price list" asked which city — this reply should be 1/2/3 or a
        // partial city name. Self-contained: doesn't touch actions.resolvePending
        // at all, same pattern as await_bkg_no above.
        if (p.type === 'await_pricelist_city') {
            const cityMatch = resolveListSelection(ctx.text, ['Los Angeles', 'Houston', 'San Antonio']);
            if (cityMatch) return { intent: 'send_pricelist_city', resolvedBy: 'policy', data: { city: cityMatch, target_name: p.target_name || null } };
            return { intent: 'reply', resolvedBy: 'policy', data: { reply: 'Reply 1 for Los Angeles, 2 for Houston, or 3 for San Antonio.' } };
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

        // Location-qualified bookings query — MUST be checked before the plain
        // "available bookings" rule below, and routes to bookings_list_query
        // (which actually supports location filtering via queryBookingsByLocation)
        // rather than show_bookings_available (which has NO location awareness
        // at all). A real incident: "available bookings from oakland" got
        // routed to show_bookings_available by the AI, which just dumped every
        // available booking from every port, ignoring "from oakland" entirely.
        // Not anchored to the start of the string — deliberately searches for
        // the pattern anywhere in the text, so a typo'd prefix ("shoe" instead
        // of "show") doesn't prevent the match; only the meaningful part needs
        // to be right.
        const locQueryMatch = t.match(/\b(available|unassigned|assigned)?\s*bookings?\s+(?:from|at|in|for)\s+(.+?)\s*$/i);
        if (locQueryMatch) {
            const filter = locQueryMatch[1] === 'assigned' ? 'assigned' : (locQueryMatch[1] ? 'unassigned' : undefined);
            const location = locQueryMatch[2].trim();
            if (location) return { intent: 'bookings_list_query', resolvedBy: 'policy', data: { location, filter } };
        }

        if (t === 'bookings' || /^(?:show\s+(?:me\s+)?|list\s+)?(?:all\s+)?bookings?$/.test(t)) return { intent: 'bookings_menu', resolvedBy: 'policy' };
        if (t === 'urgent' || /^(?:show\s+(?:me\s+)?|list\s+)?urgent\s+bookings?$/.test(t)) return { intent: 'show_bookings_urgent', resolvedBy: 'policy' };
        if (t === 'available' || /^(?:show\s+(?:me\s+)?|list\s+)?available\s+bookings?$/.test(t)) return { intent: 'show_bookings_available', resolvedBy: 'policy' };
        if (t === 'truckers' || t === 'suppliers' || t === 'contacts' ||
            /^(?:show\s+(?:me\s+)?|list\s+)?(?:truckers|suppliers|contacts)$/.test(t))
            return { intent: 'show_contacts', resolvedBy: 'policy' };

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
        // Any status-type phrasing containing a real booking number, anywhere
        // in the text — not anchored to an exact "status X" shape. A real
        // gap found by simulation testing: "status of 274150389" (natural
        // phrasing with "of") fell all the way through to the AI because the
        // old regex only matched the exact two-word form. resolveBookingNumber
        // already reliably extracts a booking number from free text; this
        // just adds the "status"-intent check alongside it.
        if (/\bstatus\b/.test(t)) {
            const statusBkg = resolveBookingNumber(ctx.text);
            if (statusBkg) return { intent: 'show_booking_status', resolvedBy: 'policy', data: { bkg_no: statusBkg } };
        }

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

        // "reply to X about Y" / "reply to X's email about Y: Z" / "reply to X saying Z" —
        // finds a REAL prior email from X and replies inside that thread, not
        // a fresh compose. Deliberately checked before search_mail/draft_email
        // so "reply to..." always wins over the more general "email X..." shape.
        if ((m = ctx.text.trim().match(/^(?:please\s+)?reply\s+to\s+(.+?)(?:'s\s+(?:last\s+)?(?:email|mail|message))?(?:\s*[:\-]\s*|\s+(?:about|re|regarding|saying|and\s+say)\s+)(.+)$/i))) {
            const detailsBkg = resolveBookingNumber(m[2]);
            return {
                intent: 'reply_email', resolvedBy: 'policy',
                data: { target_name: m[1].trim(), email_details: m[2].trim(), bkg_no: detailsBkg || ctx.activeBooking || null },
            };
        }

        // "did X reply about Y" / "has X replied" / "search mail for X about Y" /
        // "check email from X about Y" — read-only Gmail search, answered
        // directly. No pending/confirmation needed, nothing is sent or changed.
        if ((m = ctx.text.trim().match(/^(?:did|has)\s+(.+?)\s+repl(?:y|ied)(?:\s+yet)?(?:\s+(?:about|re|regarding)\s+(.+))?\??$/i)) ||
            (m = ctx.text.trim().match(/^(?:search|check)\s+(?:mail|emails?)\s+(?:for|from)\s+(.+?)(?:\s+(?:about|re|regarding)\s+(.+))?$/i))) {
            const detailsBkg = m[2] ? resolveBookingNumber(m[2]) : null;
            return {
                intent: 'search_mail', resolvedBy: 'policy',
                data: { target_name: m[1].trim(), note: m[2] ? m[2].trim() : null, bkg_no: detailsBkg || ctx.activeBooking || null },
            };
        }

        // "email X about Y" / "email X re Y" / "please email X regarding Y" —
        // manager explicitly instructing an outbound email. Uses ctx.text (not
        // lowercased t) so the details clause keeps its original casing for the
        // draft. Never sends directly — draftEmailForConfirm always stages a
        // yes/no confirmation first; this regex only gets that flow started.
        if ((m = ctx.text.trim().match(/^(?:please\s+)?email\s+(.+?)\s+(?:about|re|regarding)\s+(.+)$/i))) {
            const detailsBkg = resolveBookingNumber(m[2]);
            return {
                intent: 'draft_email', resolvedBy: 'policy',
                data: { target_name: m[1].trim(), email_details: m[2].trim(), bkg_no: detailsBkg || ctx.activeBooking || null },
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

        // "send price list" / "send price list to X" / "price list" — always
        // asks which city (Los Angeles / Houston / San Antonio) before sending,
        // regardless of whether a target was named. Target is optional — if
        // omitted, the list goes back to whoever asked. Resolution happens in
        // actions.js/helpers/pricelist.js, not here — policy only extracts the
        // target string (if any). Deliberately kept OUT of the Gemini/llm-intent
        // path (see helpers/pricelist.js header).
        if ((m = t.match(/^(?:send\s+)?price\s*list(?:\s+(?:to\s+)?(.+))?$/)) ||
            (m = t.match(/^send\s+prices?(?:\s+to\s+(.+))?$/)))
            return { intent: 'ask_pricelist_city', resolvedBy: 'policy', data: { target_name: m[1] ? m[1].trim() : null } };

        // Bare booking number → status
        const bkg = resolveBookingNumber(ctx.text);
        if (bkg && t.split(/\s+/).length === 1)
            return { intent: 'show_booking_status', resolvedBy: 'policy', data: { bkg_no: bkg } };
    }

    // ── B2. Trucker/supplier "menu" and bare-digit replies — silent, not a
    // menu display. Menu grammar (Section B above) only applies to
    // manager/team; a trucker sending "menu" or a bare digit like "1" used
    // to fall through to the AI, which had no context for what a digit
    // should mean and kept re-showing show_menu — an infinite loop with no
    // progress. The manager's menu (forward/assign/etc.) isn't even
    // meaningful for a trucker anyway, so silence is correct here, not a
    // fallback menu — there's no real trucker menu to show yet.
    if ((ctx.isTrucker || ctx.isSupplier) && (t === 'menu' || /^\d+$/.test(t))) {
        return { intent: 'silent', resolvedBy: 'policy' };
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
    // "show available bookings" → "from oakland" / "for oakland" / "Oakland"
    // (no "show/list/how many" wrapper) should narrow the SAME query, not
    // repeat it unfiltered. Guarded tightly: only fires for manager/team, only
    // right after a bookings query, and only for short alphabetic text with no
    // question/reference words — a real follow-up QUESTION like "whats its
    // erd" must never be swallowed as if it were a location name.
    if (ctx.isManagerOrTeam && ctx.session?.lastInstruction === 'bookings_query') {
        const stripped = t.replace(/^(?:from|at|in|for)\s+/, '').trim();
        const words = stripped.split(/\s+/).filter(Boolean);
        const wordCount = words.length;
        const QUESTION_WORDS = new Set([
            'what', 'whats', "what's", 'why', 'when', 'where', 'who', 'whos', "who's", 'how',
            'its', 'it', "it's", 'his', 'her', 'their', 'is', 'are', 'was', 'were',
            'does', 'do', 'did', 'can', 'could', 'would', 'should', 'will',
        ]);
        const hasQuestionWord = words.some(w => QUESTION_WORDS.has(w));
        // Known command words must never be swallowed as a location
        // follow-up, no matter how stale ctx.session.lastInstruction is —
        // a real bug found via simulation: "show contacts", sent well
        // after an earlier bookings query, matched this heuristic (short,
        // letters-only, no question word) and got treated as a location
        // filter instead of the contacts command it actually was. Strips
        // a "show "/"list " prefix before checking — an EXACT array match
        // on the raw stripped text alone would miss "show contacts" even
        // with "contacts" in the list, since they're different strings.
        const withoutVerb = stripped.replace(/^(?:show(?:\s+me)?|list)\s+/, '');
        const KNOWN_COMMANDS = new Set(['yes','no','ok','okay','thanks','thank you','hi','hello','menu','cancel',
             'contacts','truckers','suppliers','bookings','status','help','urgent',
             'available','recall','archive','price list','pricelist']);
        const isKnownCommand = KNOWN_COMMANDS.has(stripped) || KNOWN_COMMANDS.has(withoutVerb);
        const looksLikeLocation = stripped.length >= 2 && wordCount <= 3 && !hasQuestionWord
            && /^[a-z\s.'-]+$/i.test(stripped) && !isKnownCommand;
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
async function buildPrompt(ctx) {
    const a = await formatForAI(ctx);
    return `You are Jarvis — the freight operations AI for Edge Metals Inc.
You are one step in a pipeline. The policy layer already handled deterministic cases.
You are called because the message intent is ambiguous.

STRICT RULES:
- You reach this prompt ONLY when the deterministic command grammar found no exact match — that's expected for typos, informal phrasing, or wording it doesn't anticipate, NOT a sign the message is unintelligible. Read past spelling: "bookking" means "booking", "avilable" means "available", "shw me" means "show me". If the corrected reading maps clearly onto one of the AVAILABLE ACTIONS below, use that action confidently — do not fall back to NEED_DATA or a generic "couldn't understand" reply just because the exact letters didn't match a pattern. A real assistant reads intent through typos; only use NEED_DATA when the actual MEANING is genuinely ambiguous or missing information, never because of spelling.
- SEMANTIC MEMORY entries are a similarity-based RECALL AID, not verified fact — they were embedded from past session summaries, which are themselves brief and can be stale, superseded, or only loosely related despite the similarity score. Use them to inform tone and continuity ("last time this came up, X was the concern") and to jog what to ask about, but NEVER state something from semantic memory as current fact — always verify against ALL ACTIVE BOOKINGS / FACTS / BUSINESS CONTEXT for anything that could have changed since. If semantic memory conflicts with current data, current data wins, always, and it's worth surfacing the conflict ("last time it was assigned to X, but it now shows unassigned — did that change?") rather than silently picking one.
- For anything specific to Edge Metals' own data — booking status, dates, who's assigned, counts, contacts — use ONLY the context below. The ALL ACTIVE BOOKINGS / PORT SUMMARY / TRUCKERS ON FILE / SUPPLIERS ON FILE sections are your complete knowledge base for everything currently active — search across ALL of it, not just activeBooking, before saying you don't know. Never invent or guess a fact that isn't there.
- Archived/completed bookings are NOT included in the context above (kept out to bound token cost). If a question is plausibly about an older/closed booking not in ALL ACTIVE BOOKINGS, say it may be archived and suggest checking the dashboard → History — do not guess, and do not claim it doesn't exist.
- For general freight/logistics knowledge NOT specific to Edge Metals' data (e.g. "what does FCL mean", "what happens if we miss cutoff", "typical transit time LA to Busan", "what's a bill of lading") — answer from your own general knowledge via "reply", like a knowledgeable freight ops assistant would. Don't refuse or say NEED_DATA just because it's not in the context block; that restriction is only for YOUR business's specific data, not general domain expertise. If mixing the two, clearly ground the business-specific part in context and flag anything you're unsure of.
- If required fields are missing, return action: "NEED_DATA".
- If the action is irreversible or high-risk, return action: "NEED_APPROVAL".
- Never return free text outside the JSON.
- Do not assume media exists unless hasMedia is true.
- Do not assume a booking is active unless activeBooking is set.
- The AVAILABLE ACTIONS list is EXHAUSTIVE — never invent an action name not on it, even one that seems reasonable. If the manager wants a question relayed to a trucker/supplier and an answer brought back ("ask him whether X", "check with the supplier about Y"), use "ask_contact": target_name = who to ask, bkg_no = the booking if relevant, note = the exact question to send. This sets up a proper pending so their reply gets relayed back to whoever asked, instead of silently landing as an unrelated ambiguous message. "schedule_followup" is a WhatsApp nudge sent later to a trucker or supplier. "draft_email" is for when the manager explicitly asks you to email someone (e.g. "email Zimex about DALA123's cutoff") — target_name = who to email, email_details = what it should say, bkg_no = the booking if relevant. This only DRAFTS and stages the email for the manager's yes/no confirmation — it is never sent without that confirmation, and you must never treat it as already sent. "search_mail" is for a QUESTION about mail that already exists (e.g. "did Zimex reply about DALA123's cutoff", "check email for anything from Eaglebrit about ERD") — target_name = who to check, note = what to look for, bkg_no = the booking if relevant. This is read-only and answers directly, no confirmation needed, and is a completely separate action from draft_email — never use draft_email to answer a question about existing mail, and never use search_mail when the manager wants something SENT. "reply_email" is for when the manager explicitly wants to reply INSIDE an existing email thread from someone (e.g. "reply to Zimex about DALA123: confirmed") rather than send a standalone new email — target_name = whose email to reply to, email_details = what the reply should say, bkg_no = the booking if relevant. Like draft_email, this only DRAFTS and stages for yes/no confirmation, never sends directly. Use draft_email (not reply_email) when there's no indication of replying to something specific — "reply to X" or "reply to X's email" means reply_email; "email X" alone means draft_email. You still cannot set reminders for the manager, make phone calls, or do anything else deferred beyond schedule_followup, draft_email, search_mail, and reply_email. If asked for any of those, use "reply" to briefly decline — do NOT promise anything you can't do.

- CRITICAL, never violate this: empty_drop_confirmed, load_ready_received, picked_up_confirmed, scale_ticket_received, and ingate_received each represent a TRUCKER OR SUPPLIER confirming that something physically happened. They must NEVER fire from a message the MANAGER sent — not even if the manager's wording sounds like a statement ("empty is dropped"), and especially not from a QUESTION ("check whether empty dropped", "has he picked up yet", "is it ready"). A manager asking or wondering about status is asking a question, not reporting a physical event they witnessed — treat any manager message about container/pickup/load status as either show_booking_status (if they want to know current recorded status) or ask_contact (if they want it verified with the trucker/supplier directly). These five confirm actions are only ever correct when resolvedBy is 'policy' from the trucker/supplier's own organic message, or via ask_contact's relay-reply mechanism — never as a direct AI classification of anything the manager typed.
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

═══ SEMANTIC MEMORY (meaning-based match across ALL past conversations, any day, any chat — may be exactly relevant or may be a loose match; use judgment) ═══
${a.semanticMemory}

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
ask_contact, draft_email, search_mail, reply_email, reply, silent, NEED_DATA, NEED_APPROVAL

Return ONLY this JSON:
{
  "action": "one_of_the_actions_above",
  "confidence": 0.0,
  "bkg_no": null,
  "supplier_name": null,
  "trucker_name": null,
  "target_name": null,
  "email_details": null,
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
    'ask_contact', 'draft_email', 'search_mail', 'reply_email',
]);

async function aiDecide(ctx) {
    const decision = await callGeminiJSON(await buildPrompt(ctx));
    if (!decision) return { action: 'NEED_DATA', confidence: 0, reasoning: 'AI unavailable' };

    // Hard guard, not just a prompt instruction — these five represent a
    // TRUCKER/SUPPLIER physically confirming something happened. They must
    // never fire from the manager's own message, at any confidence, no
    // matter how the AI classified it. A real incident: "check whether empty
    // dropped" (a manager QUESTION) got fired as empty_drop_confirmed at
    // confidence 1.0, silently marking a container dropped that was never
    // actually verified with anyone. Rather than just blocking and making
    // the manager retype an explicit "ask X" command, actively verify with
    // whoever already owns that stage — the booking already knows who that
    // is, no reason to ask the manager to re-supply information Jarvis has.
    const CONFIRM_ACTION_PARTY = {
        empty_drop_confirmed  : 'trucker',  // trucker is the one who drops the empty
        load_ready_received   : 'supplier', // supplier is the one loading
        picked_up_confirmed   : 'trucker',
        scale_ticket_received : 'trucker',
        ingate_received       : 'trucker',
    };
    const CONFIRM_ACTION_QUESTION = {
        empty_drop_confirmed  : 'Is the empty container dropped yet?',
        load_ready_received   : 'Is the load ready for pickup?',
        picked_up_confirmed   : 'Has pickup happened yet?',
        scale_ticket_received : 'Do you have the scale ticket yet?',
        ingate_received       : 'Has it been ingated at the port yet?',
    };
    const VERIFY_PHRASING = /\b(check|whether|verify|confirm|has|did|is)\b/i;
    const detectedIntent = ctx.isManagerOrTeam ? actions.detectExpectedIntent(ctx.text) : null;
    let effectiveAction = decision.action;
    if (detectedIntent && VERIFY_PHRASING.test(ctx.text) && decision.action !== 'ask_contact') {
        console.warn(`[AI] Text pattern-matched to "${detectedIntent}" despite AI choosing "${decision.action}" — overriding before the guard below runs`);
        effectiveAction = detectedIntent;
    }

    if (ctx.isManagerOrTeam && CONFIRM_ACTION_PARTY[effectiveAction]) {
        const bkgNo = decision.bkg_no || ctx.activeBooking;
        const party = CONFIRM_ACTION_PARTY[effectiveAction];
        const wf = bkgNo ? (require('../helpers/json').loadWorkflow()[bkgNo] || {}) : {};
        const contactName = party === 'trucker' ? wf.trucker_name : wf.supplier;

        if (bkgNo && contactName) {
            console.warn(`[AI] Manager's "${effectiveAction}" attempt redirected to ask_contact — verifying with ${party} ${contactName} instead of trusting the manager's own claim`);
            return {
                action: 'ask_contact', confidence: 1, bkg_no: bkgNo, target_name: contactName,
                note: CONFIRM_ACTION_QUESTION[effectiveAction],
                reasoning: `Manager asked about status — auto-verifying with ${party} ${contactName} rather than confirming from the manager's own message.`,
            };
        }
        // No contact assigned yet to ask — genuinely can't verify, say so plainly.
        return {
            action: 'NEED_DATA', confidence: 0,
            reasoning: `Manager message misclassified as a contact-confirm action (${effectiveAction}) — blocked, no ${party} assigned yet to verify with.`,
            reply: `No ${party} assigned to ${bkgNo || 'that booking'} yet, so I can't verify this with anyone. Assign one first, or tell me who to ask directly.`,
        };
    }

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
    // Same clear needed for the price-list city prompt — otherwise it never
    // resolves and every message after the first "which city?" answer keeps
    // getting re-interpreted as another city reply.
    if (ctx.pendingAction?.type === 'await_pricelist_city') {
        try { await actions.clearPending(chatId); } catch {}
    }

    switch (decision.intent) {
        case 'resolve_pending':        return actions.resolvePending(chatId, ctx.pendingAction, d.answer, d.selection);
        case 'resolve_fact_batch':     return actions.resolveFactBatch(chatId, ctx.pendingAction, d.selection);
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
        case 'draft_email':             return actions.draftEmailForConfirm(chatId, d.target_name, d.email_details, bkg);
        case 'search_mail':             return actions.searchMail(chatId, d.target_name, d.note, bkg);
        case 'reply_email':             return actions.draftReplyForConfirm(chatId, d.target_name, d.email_details, bkg);
        case 'remember_fact':          return actions.rememberFact(chatId, d.fact);
        case 'add_business_context':   return actions.addBusinessContext(chatId, d.note);
        case 'ask_contact': {
            let { target_name, note, bkg_no } = d;
            // The AI has been observed correctly REASONING about who to ask
            // and what to ask, while leaving the actual target_name/note
            // fields empty in the same response — don't just fail with a
            // generic "who/what" question when there's enough context to
            // resolve it deterministically. Same auto-resolve logic as the
            // confirm-action guard above: figure out which party owns the
            // detected event, pull their name from the booking's own record.
            if ((!target_name || !note) && (bkg_no || ctx.activeBooking)) {
                const resolvedBkg = bkg_no || ctx.activeBooking;
                const wf = require('../helpers/json').loadWorkflow()[resolvedBkg] || {};
                const intent = actions.detectExpectedIntent(note || ctx.text);
                const party = intent === 'load_ready_received' ? 'supplier' : (intent ? 'trucker' : null);
                if (!target_name && party) target_name = party === 'trucker' ? wf.trucker_name : wf.supplier;
                if (!note) {
                    const QUESTION_BY_INTENT = {
                        empty_drop_confirmed: 'Is the empty container dropped yet?',
                        load_ready_received: 'Is the load ready for pickup?',
                        picked_up_confirmed: 'Has pickup happened yet?',
                        scale_ticket_received: 'Do you have the scale ticket yet?',
                        ingate_received: 'Has it been ingated at the port yet?',
                    };
                    note = QUESTION_BY_INTENT[intent] || ctx.text;
                }
                bkg_no = resolvedBkg;
                if (target_name) console.warn(`[BRAIN] ask_contact: AI left target_name/note empty despite reasoning about it — backfilled from booking ${resolvedBkg} (${party}: ${target_name})`);
            }
            return actions.relayQuestionToContact(chatId, target_name, note, bkg_no);
        }
        case 'ask_pricelist_city': {
            await actions.setPending(chatId, { type: 'await_pricelist_city', target_name: d.target_name || null });
            return send(chatId, 'Which price list?\n1. Los Angeles\n2. Houston\n3. San Antonio');
        }
        case 'send_pricelist_city':    return actions.sendPriceListCity(chatId, d.city, d.target_name);
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
        case 'container_number_received': return actions.recordContainerNumber(chatId, ctx.pendingAction, d.container_number);
        case 'relay_reply_received':      return actions.relayReplyReceived(chatId, ctx.pendingAction, d.reply_text);
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
                    try { await actions.logKnowledgeGap(ctx, d.reasoning, false); } catch (e) { console.error('[BRAIN] gap log failed:', e.message); }
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
// The "(Still pending...)" reminder tail used to hardcode "reply yes/no" for
// every pending type. That's wrong for anything that isn't a literal yes/no
// confirm — e.g. await_followup_minutes wants a number/time, await_bkg_no
// wants a booking number, await_pricelist_city wants a pick. Telling the
// manager "reply yes/no" when the pending actually wants a time value is
// actively misleading. Give a hint that matches what the pending actually expects.
function pendingHint(p) {
    if (p.type === 'await_followup_minutes') return 'reply with a number of minutes (e.g. 15) or a time like "2 hours"';
    if (p.type === 'await_bkg_no') return 'reply with the booking number';
    if (p.type === 'await_pricelist_city') return 'reply 1, 2, or 3, or the city name';
    if (p.options && p.options.length) return `reply with one of: ${p.options.join(', ')}`;
    return 'reply yes/no';
}

// Wizard pendings get a FULL restated question instead of the terse generic
// template — "reply yes/no" with no context on what it's asking led to a
// real incident: the manager, days after the daily wizard trigger fired and
// went unanswered, had no idea what "wizard start" meant and asked the AI to
// explain, which then answered from general knowledge instead of the actual
// pending — a hallucinated-sounding but wrong explanation. Restating the
// original question directly in the reminder prevents that confusion from
// happening in the first place, rather than relying on the AI to explain a
// pending it has no real visibility into.
function pendingFullReminder(p) {
    if (p.type === 'wizard_start') return '(Still waiting on this from earlier: any bookings need to go out to a trucker today? Reply yes or no — or "cancel" to dismiss this.)';
    if (p.type === 'wizard_await_port') return `(Still waiting: which port? ${(p.options || []).map((o, i) => `${i + 1}. ${o}`).join(', ')} — or "cancel" to dismiss.)`;
    if (p.type === 'wizard_await_booking') return `(Still waiting: which booking? ${(p.options || []).map((o, i) => `${i + 1}. ${o}`).join(', ')} — or "cancel" to dismiss.)`;
    if (p.type === 'wizard_confirm') return `(Still waiting: confirm ${p.bkg_no} — Supplier: ${p.supplier_name}, Trucker: ${p.trucker_name}? Reply yes or no.)`;
    if (p.type === 'await_fact_batch') {
        const list = (p.candidates || []).map((c, i) => `${i + 1}. ${c}`).join('\n');
        return `(Still waiting: end-of-day review —\n${list}\n\nReply with numbers to accept (e.g. "1,3"), "all", or "no" to skip all.)`;
    }
    if (p.type === 'await_email_confirm') return `(Still waiting: send this email to ${p.target_name} <${p.to}>? Subject: ${p.subject}\n\n${p.body}\n\nReply yes or no.)`;
    return null; // no type-specific text — use the generic template
}

async function process(rawEvent, sendMessage) {
    const started = Date.now();
    const inbound = await normalize(rawEvent);

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
    const ctx     = await buildContext(inbound, pending);

    let decision = policyDecide(ctx);
    if (decision.needsAI) {
        const ai = await aiDecide(ctx);
        decision = {
            intent    : ai.action,
            resolvedBy: 'ai',
            confidence: ai.confidence ?? null,
            data      : { bkg_no: ai.bkg_no, supplier_name: ai.supplier_name, trucker_name: ai.trucker_name, target_name: ai.target_name, email_details: ai.email_details, minutes: ai.minutes, fact: ai.fact, note: ai.note, reply: ai.reply, reasoning: ai.reasoning },
        };
    }

    let result = { action_taken: 'error' };
    try {
        result = await route(decision, ctx, sendMessage);
    } catch (err) {
        console.error('[BRAIN] Route failed:', err);
        if (inbound.isManagerOrTeam) await sendMessage(inbound.chatId, `Something broke while handling that: ${err.message}`);
    }

    // If this message's own handling freed up the pending slot on this chat
    // (answered a wizard step, confirmed/declined an email send, etc.) and
    // didn't immediately re-claim it for a follow-up step of its own, bring
    // in whatever was queued behind it — see actions.js's promoteQueued.
    try { await actions.promoteQueued(inbound.chatId); } catch (e) { console.error('[BRAIN] promoteQueued failed:', e.message); }

    // Reminder tail — pending still open after an unrelated exchange
    if (inbound.isManagerOrTeam && pending &&
        !['confirmed_pending', 'cancelled_pending', 'forwarded', 'assigned', 'recalled'].includes(result?.action_taken)) {
        const fresh = actions.getPending(inbound.chatId);
        if (fresh && fresh.created_at === pending.created_at) {
            const fullReminder = pendingFullReminder(fresh);
            if (fullReminder) {
                await sendMessage(inbound.chatId, fullReminder);
            } else {
                const bkgPart = fresh.bkg_no ? ` for ${fresh.bkg_no}` : '';
                await sendMessage(inbound.chatId, `(Still pending: ${fresh.type.replace(/_/g, ' ')}${bkgPart} — ${pendingHint(fresh)}.)`);
            }
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
    await appendAuditLog({
        source     : 'core',
        chatId     : inbound.chatId,
        messageId  : inbound.messageId,
        senderRole : inbound.role,
        senderName : inbound.senderName,
        text       : inbound.text,
        hasMedia   : !!inbound.hasMedia,
        intent     : decision.intent,
        resolvedBy : decision.resolvedBy,
        confidence : decision.confidence ?? (decision.resolvedBy === 'policy' ? 1 : null),
        actionTaken: result?.action_taken,
        durationMs : Date.now() - started,
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

module.exports = { process, normalize, policyDecide, pendingFullReminder };