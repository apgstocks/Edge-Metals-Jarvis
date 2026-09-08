// ── helpers/pendingLabel.js ───────────────────────────────────────────────
// Apsara, 2026-09-07, with a screenshot of Jarvis saying to her:
//
//   Couldn't find a past email from "Jayashree" — no address to send to, and
//   you already have a pending "await_fact_batch" to answer first.
//
// "await_fact_batch" is a variable name. It is the end-of-day review of what
// Jarvis learned that day, and there is no reason on earth she should have to
// know that string to understand her own assistant. Same message, in her
// words: "...and there's still the end-of-day review of what I learned today
// waiting on you."
//
// Twenty places interpolated `staged.blockedBy` raw. Every one of them is a
// message she reads.
//
// THE FALLBACK IS THE POINT. A map that covers the types I happened to think
// of leaves the next new pending type leaking its identifier at her, which is
// how this bug got here in the first place. So an unmapped type does NOT get
// de-snake-cased into a guess like "a fact batch" — it becomes the honest
// generic "an earlier question", which is always true and never leaks. Adding
// a nicer phrase later is an improvement; leaking a symbol is a regression,
// and only one of those should be possible by default.
//
// Checked by tests/pending-label.js, which walks the pending types actually
// used in the code and fails on any label that still looks like an
// identifier — so this file cannot silently fall behind the code again.

const LABELS = {
    // Things she is being asked to confirm
    confirm_forward: 'a booking waiting to go to a trucker',
    confirm_recall: 'a booking waiting to be recalled',
    confirm_assign: 'a supplier assignment waiting on you',
    confirm_proforma: 'a proforma waiting to be sent',
    confirm_archive_batch: 'a batch of expired bookings waiting to be archived',
    confirm_quote_lane: 'a quote lane waiting to be confirmed',
    confirm_quote_trucker: 'a trucker waiting to be confirmed for a quote',
    await_email_confirm: 'an email waiting for your OK to send',
    await_payment_confirm: 'a payment waiting for your OK',
    await_verify_apply: 'some booking changes waiting to be applied',
    await_ready_check: 'a load waiting to be marked ready',

    // Things she is being asked FOR
    await_bkg_no: 'a booking number I asked you for',
    await_container_number: 'a container number I asked you for',
    await_booking_details: 'the booking details I asked you for',
    await_manual_email_address: 'an email address I asked you for',
    await_pricelist_city: 'a city I asked you for',
    await_quote_cargo_details: 'the cargo details I asked you for',
    await_quote_scale_tickets: 'the scale tickets I asked you for',
    await_quote_truckers: 'which truckers to ask for a quote',
    await_quote_trucker_retry: 'which truckers to ask for a quote',
    await_contact_quote_recipient_retry: 'who to ask for a quote',
    await_link_purpose: 'what to do with a link you sent',
    await_domain_learn_name: 'a name for some addresses I found',

    // Disambiguation — she is being asked WHICH
    await_contact_disambiguation: 'which contact you meant',
    await_name_confirm: 'a name I wasn\'t sure I heard right',
    select_trucker: 'which trucker you meant',
    select_supplier: 'which supplier you meant',

    // Reviews and confirmations Jarvis raised on its own
    await_fact_batch: 'the end-of-day review of what I learned today',
    await_fact_conflict: 'something I learned that contradicts what I had',
    await_cc_pattern_confirm: 'a cc pattern I noticed and wanted to check',
    await_domain_learn_confirm: 'some addresses I found and wanted to save',
    await_relay_reply: 'a reply I was waiting to relay',

    // The booking wizard
    wizard_await_booking: 'the booking wizard, part way through',
    select_booking_for_action: 'which booking you meant',
    wizard_await_port: 'the booking wizard, part way through',
    wizard_await_supplier: 'the booking wizard, part way through',
    wizard_await_trucker: 'the booking wizard, part way through',
    wizard_confirm: 'the booking wizard, waiting on your OK',
    wizard_start: 'the booking wizard, part way through',
};

// The honest generic. Not a de-snake-cased guess — see the header.
const GENERIC = 'an earlier question';

function describePending(type) {
    const key = String(type || '').trim();
    if (!key) return GENERIC;
    return LABELS[key] || GENERIC;
}

// True when a label would still expose an identifier. Used by the test, and
// worth having as a function rather than a regex copied into it, so the rule
// lives next to the thing it governs.
function looksLikeIdentifier(s) {
    return /_/.test(String(s || '')) || /^[a-z]+[A-Z]/.test(String(s || ''));
}

module.exports = { describePending, looksLikeIdentifier, LABELS, GENERIC };
