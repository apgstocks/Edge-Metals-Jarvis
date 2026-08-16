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

// ── Scheduled-send detection ("email X ... at 7am LA time") ─────────────────
// Built 2026-08-04: "Send a mail to Mathew at 7 am LA time whether they have
// reached the pickup location?" needed the SEND itself held until 7am, not
// fired immediately. Deliberately regex-based, not another AI-extracted JSON
// field — same "AI classifies intent, deterministic code does exact
// extraction" split already used throughout this file (resolveBookingNumber,
// the policy regexes above). A regex match against ctx.text is grounded by
// construction (it IS a literal substring of what the manager actually
// typed), so unlike target_name/email_details there's no separate
// hallucination-guard needed here — the match itself IS the proof. Only
// returns the matched phrase; helpers/time.js's parseNaturalTime (already
// deterministic) does the actual date math. Ordered most-specific first so
// e.g. "next monday at 9am" is captured whole rather than the generic
// "at CLOCK" pattern only grabbing "at 9am" out of it.
// "@" is treated as a synonym for "at" before a clock time throughout —
// real incident, 2026-08-04: "Schedule this mail @7am LA time" wasn't
// caught because every pattern only recognized the WORD "at", not the "@"
// shorthand she actually uses (also seen in her own subject lines, e.g.
// "Loading schedule from LA to Humble-8/4 @7am").
const AT = '(?:at\\s+|@\\s*)';
const SCHEDULE_PATTERNS = [
    /\b((?:next|this)\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s*(?:at\s+|@\s*)\d{1,2}(?::\d{2})?\s*(?:am|pm))?)\b/i,
    new RegExp(`\\b(tomorrow\\s*${AT}\\d{1,2}(?::\\d{2})?\\s*(?:am|pm))\\b`, 'i'),
    new RegExp(`\\b(today\\s*${AT}\\d{1,2}(?::\\d{2})?\\s*(?:am|pm))\\b`, 'i'),
    /\b(in\s+\d+\s+(?:minutes?|mins?|hours?|hrs?|days?))\b/i,
    new RegExp(`${AT}(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)(?:\\s*(?:la|los angeles|pacific)\\s*time)?)\\b`, 'i'),
];
function extractScheduleClause(rawText) {
    const text = String(rawText || '');
    for (const re of SCHEDULE_PATTERNS) {
        const m = text.match(re);
        if (m) return m[1];
    }
    return null;
}

// Parses "get quote from <origin> to <destination> [ask <names>] [email
// <addr[, addr2...]>]" — "ask" and "email" clauses can appear in either
// order, or not at all. Pulling both OUT of the "to ___" tail (rather than
// one combined regex trying to capture destination/names/emails all in one
// pass) is what lets "Richmond email apg0596@gmail.com" correctly split into
// destination "Richmond" + emails ["apg0596@gmail.com"] instead of reading
// the whole trailing phrase as one (nonexistent) address-book destination —
// the real gap found 2026-08-05 when this syntax didn't exist yet at all.
// Returns null if the text isn't a "get quote" command in the first place.
function parseGetQuoteCommand(rawText) {
    // REAL GAP (found 2026-08-06, live): "send a quote from LA to Humble
    // email Jose" / "request a quote from LA to Humble email Jose" both
    // missed this entirely — the old regex only accepted the literal verb
    // "get". Neither fell through to a sane fallback either: with no
    // policy match, the AI classifier read "email Jose" as a generic
    // draft_email target and staged an unrelated "what's Jose's address"
    // pending, which then swallowed her well-formed retry too (same
    // pending is reused for reclassification below — see A0d). Broadened
    // to accept get/send/request/obtain as the leading verb.
    //
    // REAL GAP (found 2026-08-16, live — Apsara: "Send quote request to
    // apg0596@gmail.com from Junk car to Eccomelt"): two more misses, same
    // failure mode as the 2026-08-06 gap above — no policy match, fell
    // through to the AI/draft_email path, which locked onto the literal
    // email address as the target contact and asked for "a past email"
    // instead of ever reaching this parser or the quote-request flow.
    //   1. "quote request" (noun phrase) never matched — the old regex
    //      required "quote"/"quotes" to be followed IMMEDIATELY by "from".
    //      "quote request to X from Y to Z" has "request to X" sitting
    //      between them, so it just didn't match at all.
    //   2. Even with "quote request" accepted, a stray "to <email>" clause
    //      landing BEFORE "from" (a natural way to say "send it to me from
    //      A to B") still isn't part of the real origin/destination pair
    //      and was never tolerated.
    // Fixed both by (a) accepting an optional "request(s)" noun after
    // "quote(s)", and (b) searching for the first "from ... to ..." lane
    // pattern anywhere after that, rather than requiring it immediately —
    // anything between the quote-noun and "from" (like a misplaced "to
    // <email>") is simply skipped, not treated as part of the lane. This
    // only WIDENS what matches; the origin/destination/email/ask
    // extraction below (already working, unit-tested by the 2026-08-05/06
    // gaps above) is completely unchanged.
    const base = String(rawText || '').trim().match(/^(?:get|send|request|obtain)\s+(?:a\s+)?quotes?(?:\s+requests?)?\b[\s\S]*?\bfrom\s+(.+?)\s+to\s+(.+)$/i);
    if (!base) return null;
    const origin = base[1].trim();
    let rest = base[2].trim();

    let emails = null;
    const emailMatch = rest.match(/,?\s*\bemail\b\s+([\w.+-]+@[\w.-]+\.[a-z]{2,}(?:\s*(?:,|&|\band\b)\s*[\w.+-]+@[\w.-]+\.[a-z]{2,})*)/i);
    if (emailMatch) {
        emails = emailMatch[1].split(/,|&|\band\b/i).map((s) => s.trim()).filter(Boolean);
        rest = (rest.slice(0, emailMatch.index) + rest.slice(emailMatch.index + emailMatch[0].length)).trim();
    }

    // "ask Jose" (always meant a saved-trucker name) — and now also
    // "email Jose", the colloquial version of the same thing, once a real
    // email ADDRESS clause (handled above) has already been stripped out.
    // By the time we get here, "email <real@address>" is gone from `rest`,
    // so a leftover bare "email <word(s)>" can only mean a trucker name.
    let namesText = null;
    const askMatch = rest.match(/,?\s*\b(?:ask|email)\b\s+(.+)$/i);
    if (askMatch) {
        namesText = askMatch[1].trim();
        rest = rest.slice(0, askMatch.index).trim();
    }

    const destination = rest.replace(/,\s*$/, '').trim();
    return { origin, destination, namesText, emails };
}

// Parses "[send/request] [a] quote [request] to <recipient> for <details>" —
// built 2026-08-16 per Apsara's "another tab" ask (see workflow/contactQuoteRequests.js's
// header). Deliberately a SEPARATE parser/pattern from parseGetQuoteCommand
// above, not a shared one — that one is keyed on "...from X to Y" (a lane);
// this one is keyed on "...to X for Y" (a recipient + what you're asking
// them for), and the two verbs ("from"/"for") never collide: a message
// containing "from" and no "for" only ever matches the trucker-lane parser
// above (checked first), and vice versa. Returns null if the text isn't a
// "quote to X for Y" command at all.
function parseContactQuoteCommand(rawText) {
    const m = String(rawText || '').trim().match(/^(?:send|request)?\s*(?:a\s+)?quote(?:\s+request)?\s+to\s+(.+?)\s+for\s+(.+)$/i);
    if (!m) return null;
    return { recipientQuery: m[1].trim(), details: m[2].trim().replace(/[.?!]+$/, '') };
}
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
    // Yard/scale staff — separate allowlist from internal_team (settings.yard_staff),
    // deliberately its own role so a photo from one of these numbers routes to the
    // standalone scale-ticket pipeline (workflow/actions.js's yardScaleTicketReceived),
    // never into the manager/team command grammar or the trucker/supplier booking flow.
    const yardNums   = (settings.yard_staff || [])
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
    const isYard    = !isRegisteredGroupChat && yardNums.includes(senderNum);

    // Group identity wins for group chats; for personal DMs, manager/team/yard
    // identity still wins over a coincidental personal-number match.
    const finalTrucker  = isRegisteredGroupChat ? trucker  : (!isManager && !isTeam && !isYard ? trucker  : null);
    const finalSupplier = isRegisteredGroupChat ? supplier : (!isManager && !isTeam && !isYard ? supplier : null);

    const role = isManager ? 'manager' : isTeam ? 'team' : isYard ? 'yard' : finalTrucker ? 'trucker' : finalSupplier ? 'supplier' : 'unknown';

    return {
        ...raw,
        textLower      : String(raw.text || '').toLowerCase().trim(),
        role,
        matchedTrucker : finalTrucker,
        matchedSupplier: finalSupplier,
        isManagerOrTeam: isManager || isTeam,
        isTrucker      : !!finalTrucker,
        isSupplier     : !!finalSupplier,
        isYard         : isYard,
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

    // ── A0d. Manual email-address pending — same "capture verbatim, no
    // reclassification" reasoning as A0b/A0c above. Built 2026-08-03 after a
    // real live bug: draftEmailForConfirm/draftReplyForConfirm used to ask
    // "give me the exact email address" and then just return, discarding
    // the original request. The manager's next message (the address) went
    // through NORMAL classification and usually landed on a generic AI
    // clarifying question, silently dropping what she'd already typed. This
    // pending captures the whole original request (target/details/booking)
    // so ANY next message is treated as "the address I asked for", not
    // reclassified from scratch.
    if (ctx.pendingAction?.type === 'await_manual_email_address') {
        // REAL BUG (found 2026-08-05, live): a typo'd "get quote" ("ote from
        // LA to Richmond email X" — autocorrect/typing glitch ate the "get
        // qu") didn't match the get_quote pattern at all, fell through to
        // the OLD draft_email/ask_contact classifier, and staged THIS
        // pending. Every message after that — including a perfectly-typed
        // "get quote from LA to Richmond email apg0596@gmail.com" on the
        // NEXT try — got swallowed as "the address I asked for" instead of
        // ever reaching the get_quote regex below, since this check runs
        // first and (by design, for good reason in its original context)
        // treats ANY next message as the answer, no reclassification. A
        // fresh, clearly-recognizable "get quote from X to Y" command is
        // clearly NOT an email address and clearly NOT answering this
        // pending — same "let a distinctly different, well-formed command
        // jump the pending queue" reasoning as the 'await_email_confirm' +
        // "schedule" carve-out above. route() clears this stale pending
        // when it sees this intent (search for this comment there).
        const parsed = parseGetQuoteCommand(ctx.text);
        if (parsed) {
            return {
                intent: 'get_quote', resolvedBy: 'policy',
                data: { origin: parsed.origin, destination: parsed.destination, names_text: parsed.namesText, emails: parsed.emails },
            };
        }
        return { intent: 'manual_email_address_received', resolvedBy: 'policy', data: { address_text: ctx.text.trim() } };
    }

    // ── A0e. Domain-learn name pending — "learn radmetals contacts" found a
    // shared/docs-style address whose local-part is identical to the domain
    // term itself (e.g. radmetals@radmetals.com), so it couldn't infer a
    // name. Same verbatim-capture reasoning as A0b/A0c/A0d: whatever she
    // replies IS the name (or names, comma-separated), not something to
    // reclassify. See workflow/actions.js's resolveDomainLearnName.
    if (ctx.pendingAction?.type === 'await_domain_learn_name') {
        return { intent: 'domain_learn_name_received', resolvedBy: 'policy', data: { name_text: ctx.text.trim() } };
    }

    // ── A0f0. Cargo description/value prompt (2026-08-06, per Apsara: "I
    // want jarvis to ask about cargo description, cargo value") — asked
    // right before a quote request actually sends, once recipients are
    // already locked in. Same verbatim-capture reasoning as A0b/A0c/A0d/A0e
    // above: no fixed format for "cargo description and value" to validate
    // against, so whatever she replies IS the answer — "skip"/"none"/"n/a"
    // (any casing) is the one recognized escape hatch, handled inside
    // actions.js's resumeQuoteWithCargoDetails rather than here, so this
    // stays a plain pass-through like the others.
    if (ctx.pendingAction?.type === 'await_quote_cargo_details') {
        return { intent: 'quote_cargo_details_received', resolvedBy: 'policy', data: { cargo_text: ctx.text.trim() } };
    }

    // ── A0f-1. Reply to "couldn't find a trucker named X — correct name or
    // email?" (pauseForUnresolvedTrucker, 2026-08-06). Same verbatim-capture
    // reasoning — whatever she sends next is either "cancel", a corrected
    // name, or an email address; actions.js's resumeQuoteWithTruckerRetry
    // sorts out which.
    if (ctx.pendingAction?.type === 'await_quote_trucker_retry') {
        return { intent: 'quote_trucker_retry_received', resolvedBy: 'policy', data: { retry_text: ctx.text.trim() } };
    }

    // ── A0f-2. Contact quote-request pending (2026-08-16, see
    // workflow/contactQuoteRequests.js). Same verbatim-capture reasoning as
    // A0f-1 above — "couldn't find X — correct name, or an email address to
    // use directly?"
    //
    // The sibling await_contact_quote_whatsapp_confirm pending ("use this
    // unverified mobile for WhatsApp too? yes/no") that used to live here was
    // REMOVED 2026-08-16 per Apsara ("just have whatsapp verify button in
    // phon[e] number") — WhatsApp verification is now a one-time toggle on
    // the Address Book dashboard page (helpers/addressBook.js's
    // setMobileVerified), not a per-request chat prompt. If you're looking
    // for that flow, it no longer exists on purpose.
    if (ctx.pendingAction?.type === 'await_contact_quote_recipient_retry') {
        return { intent: 'contact_quote_recipient_retry_received', resolvedBy: 'policy', data: {} };
    }

    // ── A0f. Multi-select reply to "who should I ask?" (quote request with
    // no trucker named — see helpers/quoteRequests.js / workflow/quoteRequests.js).
    // Unlike every other p.options pending (single-pick, handled generically
    // in section A below), this one needs MULTIPLE picks from one reply
    // ("Joey, Daekwang" or "1,3") — same comma-list parsing style as
    // await_fact_batch above, just against names/numbers instead of digits only.
    if (ctx.pendingAction?.type === 'await_quote_truckers') {
        const p = ctx.pendingAction;
        const tt = ctx.text.trim();
        if (/^(no|none|cancel)$/i.test(tt)) return { intent: 'resolve_pending', resolvedBy: 'policy', data: { answer: 'no' } };
        const tokens = tt.split(/,|&|\band\b/i).map((s) => s.trim()).filter(Boolean);
        const picked = [];
        for (const tok of tokens) {
            if (/^\d+$/.test(tok)) {
                const i = parseInt(tok, 10) - 1;
                if (i >= 0 && i < p.options.length) picked.push(p.options[i]);
            } else {
                const match = p.options.find((o) => o.toLowerCase() === tok.toLowerCase() || o.toLowerCase().includes(tok.toLowerCase()));
                if (match) picked.push(match);
            }
        }
        if (picked.length) return { intent: 'quote_truckers_selected', resolvedBy: 'policy', data: { names: [...new Set(picked)] } };
        return { intent: 'reply', resolvedBy: 'policy', data: { reply: 'Didn\'t catch a name/number — reply with names or numbers (comma-separated for more than one), or "cancel".' } };
    }

    // ── A0g. Active quote-request leg reply — a message from a chat that's
    // currently awaiting a price on an open quote request is almost
    // certainly that reply, not a new command. Backed by its own store
    // (data/quote_requests.json), looked up directly by chatId rather than
    // through ctx.pendingAction — a trucker's own chat normally has no
    // pending_actions entry at all, so this can't be folded into the A0
    // pendingAction checks above. Only kicks in when there ISN'T already a
    // more specific pending on this exact chat (e.g. an unrelated
    // await_ready_check), so it never hijacks a flow already in progress.
    if (!ctx.pendingAction) {
        const { findActiveLegByTarget } = require('../helpers/quoteRequests');
        if (findActiveLegByTarget(ctx.chatId).length) {
            return { intent: 'quote_leg_reply_received', resolvedBy: 'policy', data: {} };
        }

        // ── A0g2. Same check, contact-quote-request store (2026-08-16) ──────
        // Parallel to the trucker leg-reply check just above, but against
        // helpers/contactQuoteRequests.js's own store (data/contact_quote_
        // requests.json) instead of helpers/quoteRequests.js's — a WhatsApp
        // reply from a non-trucker contact with an open contact-quote leg.
        // Checked second so a chat that happens to be BOTH an active trucker
        // leg AND (implausibly) an active contact-quote leg still resolves
        // to the trucker flow unchanged — this can only fire when the
        // trucker check just above found nothing.
        const { findActiveLegByTarget: findActiveContactQuoteLeg } = require('../helpers/contactQuoteRequests');
        if (findActiveContactQuoteLeg(ctx.chatId).length) {
            return { intent: 'contact_quote_leg_reply_received', resolvedBy: 'policy', data: {} };
        }
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
        // REAL BUG (found 2026-08-04, live): with an already-drafted
        // "send this email to Mathew? yes/no" pending active, "Schedule
        // this mail @7am LA time" fell through Section A entirely (it's
        // not yes/no, has no options) and got reclassified from scratch by
        // the AI as a brand-new email request — which then found the SAME
        // pending still unresolved and just queued a second, redundant
        // draft behind it, going in circles. "Schedule ___" while an email
        // confirm is already pending is unambiguously an answer to THAT
        // pending (send later instead of now/not-at-all), not a new
        // request — must be caught here, before it ever reaches general
        // classification. Reuses the already-drafted to/cc/bcc/subject/body
        // as-is; only converts WHEN it sends, never re-drafts anything.
        if (p.type === 'await_email_confirm' && /\bschedule\b/i.test(ctx.text)) {
            const clause = extractScheduleClause(ctx.text);
            if (clause) return { intent: 'reschedule_pending_email', resolvedBy: 'policy', data: { send_at_text: clause } };
            return { intent: 'reply', resolvedBy: 'policy', data: { reply: 'Schedule it for when? e.g. "schedule this at 7am LA time" or "schedule for tomorrow 9am".' } };
        }
        if (p.options) {
            const pick = resolveListSelection(ctx.text, p.options);
            if (pick) return { intent: 'resolve_pending', resolvedBy: 'policy', data: { answer: 'yes', selection: pick } };
            // REAL BUG (found 2026-08-06, live): a "confirm_quote_lane"
            // pending was active (5 numbered address options), and a reply
            // that matched none of them ("Jose" — she meant to answer a
            // DIFFERENT, earlier question) fell straight through this whole
            // function with no match, past every other check below, and
            // got picked up by an unrelated "bookings from X" pattern much
            // further down — replying "No bookings from jose." instead of
            // re-asking which numbered option she meant. Her own read on
            // it: "rather than rejecting straightaway confirm whom to ask."
            // Scoped to just the two quote-disambiguation pending types —
            // NOT touching the shared p.options fallthrough for
            // select_trucker/select_supplier/wizard_*/
            // await_contact_disambiguation, whose current fallthrough
            // behavior hasn't been audited here and may be relied on
            // elsewhere.
            if (p.type === 'confirm_quote_lane' || p.type === 'confirm_quote_trucker') {
                return { intent: 'reply', resolvedBy: 'policy', data: { reply: `Didn't catch which one — reply with the number (1-${p.options.length}), or "cancel".` } };
            }
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

        // "backfill missing cutoffs" / "fill missing fields" / "check missing
        // data from mail" / "fill in whatever's missing" — auto-fills (never
        // overwrites) any booking missing cutoff/ERD/ETD/ETA/vessel/route
        // fields by searching existing mail for its booking number. Was
        // cutoff-only originally; generalized 2026-08-03 per Apsara ("not
        // only cutoff backfill, whatever is missing in booking, but
        // especially cutoff/ERD/ETA/ETD") — see helpers/cutoffBackfill.js's
        // BACKFILL_FIELDS for the exact field list and what's deliberately
        // excluded. Old cutoff-only phrasing still matches (first regex) and
        // now just triggers the same broader action — a "backfill cutoffs"
        // request is a valid subset of "backfill missing fields", not a
        // different feature. No parameters needed either way.
        if (/^(?:backfill|fill(?:\s+in)?|check)\s+(?:the\s+|any\s+|all\s+)?missing\s+cutoffs?(?:\s+from\s+(?:mail|email))?$/i.test(t) ||
            /^(?:backfill|fill(?:\s+in)?)\s+cutoffs?\s+from\s+(?:mail|email)$/i.test(t) ||
            /^(?:backfill|fill(?:\s+in)?|check)\s+(?:the\s+|any\s+|all\s+)?missing\s+(?:fields?|data|info(?:rmation)?)(?:\s+(?:in|from|for)\s+(?:the\s+)?bookings?)?(?:\s+from\s+(?:mail|email))?$/i.test(t) ||
            /^(?:backfill|fill(?:\s+in)?)\s+(?:whatever(?:'s|\s+is)?\s+missing|missing\s+(?:fields?|data))\s+(?:in\s+)?bookings?(?:\s+from\s+(?:mail|email))?$/i.test(t)) {
            return { intent: 'backfill_cutoffs', resolvedBy: 'policy', data: {} };
        }

        // "learn radmetals contacts" / "learn radmetals domain" / "scan
        // radmetals contacts" — scans mail and proposes a domain-tree
        // contact group (primary/secondary/shared roles from real From/Cc/To
        // frequency), always with a confirm step before anything is saved.
        // Deliberately deterministic-only (not wired into the AI classifier
        // below) — this touches saved contacts/cc behavior for every future
        // email to that domain, so it shouldn't be reachable via a fuzzy AI
        // guess at intent; she has to actually say "learn".
        {
            const learnMatch = t.match(/^(?:learn|scan)\s+([a-z0-9][a-z0-9.\-]*)\s*(?:contacts?|domain)?$/i);
            if (learnMatch) return { intent: 'learn_domain', resolvedBy: 'policy', data: { term: learnMatch[1] } };
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

        // "get quote from LA to Richmond" / "...ask Joey and Daekwang" /
        // "...email apg0596@gmail.com" / both together, either order —
        // multi-trucker quote-request flow (2026-08-05). Matched against the
        // ORIGINAL text (case-insensitive), not the fuzzy-corrected/
        // lowercased `t`, so names/emails keep their real casing — same
        // reasoning as the "reply to X" pattern just below. Deliberately
        // checked before search_mail/draft_email/reply_email so "get quote"
        // always wins over any of those being misread as vaguely email-shaped.
        //
        // REAL GAP (found 2026-08-05, live): "get quote from LA to Richmond
        // email apg0596@gmail.com" — a one-off recipient who isn't a saved
        // trucker at all — wasn't supported; the old single regex had no
        // "email ___" clause, so "Richmond email apg0596@gmail.com" was read
        // as one (nonexistent) destination string. parseGetQuoteCommand
        // below pulls "ask ___" and "email ___" out of whatever trails "to",
        // in either order, and whatever's left over is the real destination.
        {
            const parsed = parseGetQuoteCommand(ctx.text);
            if (parsed) {
                return {
                    intent: 'get_quote', resolvedBy: 'policy',
                    data: { origin: parsed.origin, destination: parsed.destination, names_text: parsed.namesText, emails: parsed.emails },
                };
            }
        }

        // "quote to Eccomelt for junk cars" / "send a quote request to X for Y" —
        // contact quote-request flow (2026-08-16, see workflow/contactQuoteRequests.js).
        // Checked right after get_quote's lane parser above, same "let the more
        // specific well-formed command win" reasoning — a message that failed
        // the "from...to" lane shape gets one more specific try here before
        // falling through to the generic draft_email/AI classifier.
        {
            const parsed = parseContactQuoteCommand(ctx.text);
            if (parsed) {
                return {
                    intent: 'get_contact_quote', resolvedBy: 'policy',
                    data: { recipient_query: parsed.recipientQuery, details: parsed.details },
                };
            }
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

    // ── D2. Yard/scale staff — standalone capture channel, independent of the
    // trucker/booking workflow above. A photo triggers Gemini extraction into
    // its own record (helpers/scaleTickets.js); never touches bookings.json
    // or workflow.json. Yard staff aren't expected to type commands, so any
    // non-media text is just acknowledged, not run through AI fallback —
    // keeps this channel narrow and cheap (no Gemini call on stray "ok"s).
    if (ctx.isYard) {
        if (ctx.hasMedia && ctx.mediaBase64) {
            return { intent: 'yard_scale_ticket_received', resolvedBy: 'policy',
                     data: { image_base64: ctx.mediaBase64, mime_type: ctx.mediaMimeType } };
        }
        if (ctx.hasMedia && !ctx.mediaBase64) {
            // Media flagged but bytes weren't captured (download failed, or it
            // wasn't an image — see index.js's message handler). Ask to resend
            // rather than silently dropping it.
            return { intent: 'reply', resolvedBy: 'policy',
                     data: { reply: "Couldn't read that — please resend the scale ticket as a photo." } };
        }
        return { intent: 'silent', resolvedBy: 'policy', data: {} };
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
- The AVAILABLE ACTIONS list is EXHAUSTIVE — never invent an action name not on it, even one that seems reasonable. If the manager wants a question relayed to a trucker/supplier and an answer brought back ("ask him whether X", "check with the supplier about Y"), use "ask_contact": target_name = who to ask, bkg_no = the booking if relevant, note = the exact question to send. This sets up a proper pending so their reply gets relayed back to whoever asked, instead of silently landing as an unrelated ambiguous message. "schedule_followup" is a WhatsApp nudge sent later to a trucker or supplier. "draft_email" is for when the manager explicitly asks you to email someone (e.g. "email Zimex about DALA123's cutoff") — target_name = who to email, email_details = what it should say, bkg_no = the booking if relevant. CRITICAL: target_name is ALWAYS exactly the name/company the manager said, verbatim — a bare first name like "Mike" stays "Mike". If the manager typed a company name as ONE compressed word (e.g. "mkmetaltrading"), keep it as that exact one word — do NOT split or "clean up" it into separate words (e.g. "mk metal trading"); a real incident already happened where doing this broke address lookup entirely, because the search then went looking for a phrase that doesn't actually appear anywhere in real mail. Preserve the manager's exact spelling and spacing, whatever it is. NEVER invent, guess, or auto-complete an email address into target_name (e.g. turning "Mike" into "mike@example.com" or "mike@gmail.com") — you do not know their real address, and a fabricated one silently sent to would be a serious mistake. target_name may ONLY be a full email address if that literal address string is actually present in the manager's message. Actual address lookup (saved contacts, mail search, or asking the manager directly) is handled separately, after your classification — that is not your job here. SAME RULE for email_details: it is ONLY what the manager actually said the email should say — if they gave no content at all (e.g. "send mail to radmetals" with nothing else), email_details MUST be null. Do NOT invent a plausible-sounding reason or message ("just checking in", "I miss you", or similar filler) — a real incident already happened where this produced a fabricated "I miss you" email nobody asked for. Leaving email_details null is always correct when nothing was actually said; a downstream step handles that case properly (grounds the draft in real past correspondence, or asks a concrete question) — it does not need you to paper over the gap. This only DRAFTS and stages the email for the manager's yes/no confirmation — it is never sent without that confirmation, and you must never treat it as already sent. "search_mail" is for a QUESTION about mail that already exists (e.g. "did Zimex reply about DALA123's cutoff", "check email for anything from Eaglebrit about ERD") — target_name = who to check, note = what to look for, bkg_no = the booking if relevant. This is read-only and answers directly, no confirmation needed, and is a completely separate action from draft_email — never use draft_email to answer a question about existing mail, and never use search_mail when the manager wants something SENT. "reply_email" is for when the manager explicitly wants to reply INSIDE an existing email thread from someone (e.g. "reply to Zimex about DALA123: confirmed") rather than send a standalone new email — target_name = whose email to reply to, email_details = what the reply should say, bkg_no = the booking if relevant. Same rule as draft_email: target_name is verbatim what the manager said, never a guessed/invented email address. Like draft_email, this only DRAFTS and stages for yes/no confirmation, never sends directly. Use draft_email (not reply_email) when there's no indication of replying to something specific — "reply to X" or "reply to X's email" means reply_email; "email X" alone means draft_email. "backfill_cutoffs" is for when the manager wants blank booking fields (cutoff, ERD, ETD, ETA, vessel/voyage, port of loading/discharge) filled in from existing mail — e.g. "backfill missing cutoffs", "fill in whatever's missing in bookings", "check mail for missing ERD/ETA". No target/details needed — it scans every active booking on its own. This auto-fills only genuinely blank fields (never overwrites anything already set) and reports back after, no confirmation needed before running it. You still cannot set reminders for the manager, make phone calls, or do anything else deferred beyond schedule_followup, draft_email, search_mail, reply_email, and backfill_cutoffs. If asked for any of those, use "reply" to briefly decline — do NOT promise anything you can't do.

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
ask_contact, draft_email, search_mail, reply_email, backfill_cutoffs, reply, silent, NEED_DATA, NEED_APPROVAL

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
    'ask_contact', 'draft_email', 'search_mail', 'reply_email', 'backfill_cutoffs',
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
    // REAL BUG (found 2026-08-04, live): "Send a mail to Mathew ... whether
    // they have reached the pickup location? it should [be] a reply to
    // subject: Loading schedule from LA to Humble..." got hijacked into
    // "No trucker assigned to that booking yet, so I can't verify this with
    // anyone" — the exact canned reply from the guard below, which has
    // nothing to do with email at all. Root cause: detectExpectedIntent()
    // regex-matches ANY substring containing "pick...up" to
    // picked_up_confirmed, and VERIFY_PHRASING matches "whether" — between
    // the two, this override fired and threw away whatever the AI had
    // almost certainly already correctly classified (draft_email or
    // reply_email — she said "Send a mail"/"Email to Mathew" and "reply to
    // subject:..." explicitly). "Pickup" is an extremely common word in
    // ordinary freight email requests, not just in physical status reports,
    // so this wasn't a rare edge case — any "email X about pickup ___"
    // message was at risk. The guard's whole PURPOSE (per the comment
    // above) is catching the manager's own message being misread as a
    // trucker/supplier physically reporting an event — an explicit email
    // request is never that, so it must never be a candidate for this
    // override in the first place, regardless of what words happen to
    // appear inside the email's own content.
    const EMAIL_ACTIONS = new Set(['draft_email', 'reply_email', 'search_mail']);
    let effectiveAction = decision.action;
    if (detectedIntent && VERIFY_PHRASING.test(ctx.text) && decision.action !== 'ask_contact' && !EMAIL_ACTIONS.has(decision.action)) {
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
    // Same reasoning again for the manual-email-address prompt, but ONLY
    // when policyDecide's A0d carve-out (above) has already decided this
    // message is really a fresh get_quote command, not the address it asked
    // for — see that carve-out's comment for the real incident this fixes.
    if (ctx.pendingAction?.type === 'await_manual_email_address' && decision.intent === 'get_quote') {
        try { await actions.clearPending(chatId); } catch {}
    }

    switch (decision.intent) {
        case 'resolve_pending':        return actions.resolvePending(chatId, ctx.pendingAction, d.answer, d.selection);
        case 'reschedule_pending_email': return actions.reschedulePendingEmail(chatId, ctx.pendingAction, d.send_at_text);
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
        case 'draft_email':             return actions.draftEmailForConfirm(chatId, d.target_name, d.email_details, bkg, ctx.text, extractScheduleClause(ctx.text));
        case 'search_mail':             return actions.searchMail(chatId, d.target_name, d.note, bkg);
        case 'reply_email':             return actions.draftReplyForConfirm(chatId, d.target_name, d.email_details, bkg, ctx.text, extractScheduleClause(ctx.text));
        case 'backfill_cutoffs':         return actions.backfillCutoffs(chatId);
        case 'get_quote':               return actions.startQuoteRequestFlow(chatId, d.origin, d.destination, d.names_text, d.emails);
        case 'get_contact_quote':       return actions.startContactQuoteRequestFlow(chatId, d.recipient_query, d.details);
        case 'contact_quote_recipient_retry_received': return actions.resumeContactQuoteWithRetry(chatId, ctx.pendingAction, ctx.text.trim());
        case 'quote_truckers_selected': return actions.resumeQuoteWithTruckerNames(chatId, ctx.pendingAction, d.names);
        case 'quote_cargo_details_received': return actions.resumeQuoteWithCargoDetails(chatId, ctx.pendingAction, d.cargo_text);
        case 'quote_trucker_retry_received':  return actions.resumeQuoteWithTruckerRetry(chatId, ctx.pendingAction, d.retry_text);
        case 'quote_leg_reply_received': return actions.handleQuoteLegReply(chatId, ctx.text.trim());
        case 'contact_quote_leg_reply_received': return actions.handleContactQuoteLegReply(chatId, ctx.text.trim());
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
        // Standalone yard pipeline — deliberately NOT the same case as
        // 'scale_ticket_received' above (that one flips a flag on a booking's
        // container; this one is its own record, unrelated to bkg/container).
        case 'yard_scale_ticket_received': return actions.yardScaleTicketReceived(chatId, ctx.senderName, d.image_base64, d.mime_type);
        case 'ingate_received':        return actions.ingateReceived(bkg, ctx.senderName, d.container_seq);
        case 'ask_which_container':    return actions.askWhichContainer(chatId, d);
        case 'ask_which_booking':      return actions.askWhichBooking(chatId, d, ctx.matchedTrucker?.name || ctx.matchedSupplier?.name, ctx.isSupplier ? 'supplier' : 'trucker');
        case 'check_supplier':         return bkg ? actions.checkSupplierReadiness(chatId, bkg, d.container_seq) : askBkg(chatId, 'Which booking? I will ping its supplier for pickup status.', 'check_supplier');
        case 'ready_check_yes':        return actions.resolveReadyCheckYes(chatId, ctx.pendingAction);
        case 'ready_check_no':         return actions.resolveReadyCheckNo(chatId, ctx.pendingAction);
        case 'ready_check_date':       return actions.resolveReadyCheckDate(chatId, ctx.pendingAction, d.date_text);
        case 'container_number_received': return actions.recordContainerNumber(chatId, ctx.pendingAction, d.container_number);
        case 'relay_reply_received':      return actions.relayReplyReceived(chatId, ctx.pendingAction, d.reply_text);
        case 'manual_email_address_received': return actions.resolveManualEmailAddress(chatId, d.address_text);
        case 'learn_domain':                  return actions.learnDomainForConfirm(chatId, d.term);
        case 'domain_learn_name_received':    return actions.resolveDomainLearnName(chatId, d.name_text);
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
    if (p.type === 'await_email_confirm') {
        const ccBcc = [p.cc ? `Cc: ${p.cc}` : null, p.bcc ? `Bcc: ${p.bcc}` : null].filter(Boolean).join('\n');
        return `(Still waiting: send this email to ${p.target_name} <${p.to}>?\n${ccBcc ? ccBcc + '\n' : ''}Subject: ${p.subject}\n\n${p.body}\n\nReply yes or no.)`;
    }
    if (p.type === 'await_manual_email_address') {
        // Restates that contacts + mail were already checked — the original
        // staging message says this, but this reminder-tail (shown later,
        // out of context from that first message) didn't, which read like
        // no search happened at all. Real feedback, 2026-08-03 ("why it is
        // not checking mail?") — fixed for clarity, not a logic change; the
        // search itself already always ran before this pending exists.
        return `(Still waiting on ${p.target_name}'s email — checked saved contacts and mail, found nothing. I'll draft the email to them about "${p.details || '(what you asked)'}" once you give me the address — or reply "cancel".)`;
    }
    if (p.type === 'await_cc_pattern_confirm') {
        return `(Still waiting: save ${p.detected_cc.join(', ')} as ${p.target_name}'s standing cc? Reply yes or no — either way I'll draft the email to them next.)`;
    }
    if (p.type === 'await_contact_disambiguation') {
        const listText = (p.matches || []).map((c, i) => `${i + 1}. ${c.name} <${c.email}>`).join('\n');
        return `(Still waiting — which saved contact did you mean for "${p.target_name}"?\n${listText}\n\nReply with the number, or "cancel".)`;
    }
    if (p.type === 'await_domain_learn_name') {
        return `(Still waiting on a name for ${(p.needs_name || []).join(', ')} before I can save the ${p.domain} contacts — or reply "cancel".)`;
    }
    if (p.type === 'await_domain_learn_confirm') {
        return `(Still waiting: save the ${p.domain} contacts I proposed? Reply yes or no.)`;
    }
    if (p.type === 'await_quote_trucker_retry') {
        return `(Still waiting — couldn't find a saved trucker named "${(p.unresolvedNames || []).join(', ')}". Reply with the correct name, or their email address, or "cancel".)`;
    }
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
    // REAL BUG (found 2026-08-05, live): a "get quote from LA to Richmond
    // ask X" sent while an earlier quote-request pending was ALREADY
    // unresolved on that chat gets queued behind it (setPending's own
    // never-overwrite rule) — pauseForLaneAmbiguity/pauseForTruckerAmbiguity/
    // askWhichTruckers already say so explicitly ("...but you have a pending
    // X to answer first"). Without this exclusion, THIS generic tail fires
    // right after that same message and re-prints the still-active pending's
    // full question again — a redundant second message describing the exact
    // same thing the first one just said. The three *_queued outcomes below
    // are the only action_taken values those three functions return when
    // setPending reports queued:true — excluding them here doesn't touch any
    // other pending type's reminder-tail behavior.
    if (inbound.isManagerOrTeam && pending &&
        !['confirmed_pending', 'cancelled_pending', 'forwarded', 'assigned', 'recalled',
          'quote_lane_ambiguous_queued', 'quote_trucker_ambiguous_queued', 'quote_awaiting_truckers_queued',
          // Missed when the cargo-details question shipped 2026-08-06 —
          // askForCargoDetails returns this exact action_taken when its own
          // setPending reports queued:true, same as the three above it.
          // Without it, the generic reminder-tail re-prints the still-active
          // earlier pending's full question again right after
          // askForCargoDetails already said "you have a pending X first."
          'quote_awaiting_cargo_queued',
          // Same pattern again for pauseForUnresolvedTrucker, added
          // alongside it 2026-08-06.
          'quote_trucker_unresolved_queued'].includes(result?.action_taken)) {
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