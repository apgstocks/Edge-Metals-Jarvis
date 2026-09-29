// ── helpers/oncePerSave.js — one Save click may create at most one record ────
// Apsara, 2026-09-15, sending a screenshot of two identical Darwin sales,
// OUT_02 and OUT_03: "I just added one.But two ones are created".
//
// ── WHY THIS EXISTS RATHER THAN A FIX TO THE CAUSE ──────────────────────────
// I could not find the cause by reading the code, and I would rather say that
// plainly than ship a confident guess. Everything that usually explains a
// double-write was checked and ruled out:
//
//   · Both clients set btn.disabled = true before the request, so a second
//     click cannot start a second save.
//   · Both clients rebuild the whole view with innerHTML on every render, so
//     #btnSaveLoad is a NEW element each time and click listeners cannot
//     stack the way they do on static markup. (This was my first suspicion
//     and it was wrong.)
//   · api() does not retry. mutateJson does not retry. Browsers do not
//     silently re-send a POST.
//   · There is exactly one code path that creates an outbound load, and no
//     duplicate element ids on either page.
//
// So the second write came from a second HTTP request whose origin I cannot
// see from here — a flaky connection re-sending, a wedged WebView, a
// double-tap registering as two events on a touchscreen before the disable
// takes effect, something in Capacitor. Chasing that could take days and
// might never reproduce on demand.
//
// The fix that does not depend on knowing: make the create IDEMPOTENT. The
// client mints one ticket per save attempt; the server spends it once. A
// second request carrying a spent ticket gets back the record the first one
// created, and writes nothing. It does not matter why the second request
// happened — it cannot produce a second row.
//
// ── WHY NOT A "LOOKS LIKE A DUPLICATE" WARNING ──────────────────────────────
// That was my first proposal and she corrected it by describing what actually
// happened. A warning is right when a PERSON might be entering something
// twice; it is wrong here, because she only acted once. A warning would have
// asked her to police a bug on the app's behalf, every single save, forever —
// and two genuinely identical shipments (same buyer, same day, same weight)
// do happen in this business, so she would have learned to click through it.
//
// ── THE CHECK RUNS INSIDE THE LOCK ──────────────────────────────────────────
// findSpent() is called from within the mutateJson mutator, not before it.
// Checking first and writing after is the same race in slower clothes: two
// requests arriving together would both look, both see nothing, and both
// write. Inside the lock the second request reads a file that already
// contains the first record.

// Tickets are only meaningful for as long as a stray retry could plausibly
// arrive. A day is far past that, and bounding it stops a comparison against
// every row in the file for ever.
const TICKET_TTL_MS = 24 * 60 * 60 * 1000;

function normTicket(v) {
    const s = String(v == null ? '' : v).trim();
    // Length-bounded because it lands in a stored record and in log lines. A
    // ticket is a UUID from crypto.randomUUID(); anything long is not one.
    if (!s || s.length > 100) return null;
    return s;
}

// Returns the already-created record for this ticket, or null. `rows` is the
// live array inside the lock.
function findSpent(rows, ticket, { now = Date.now() } = {}) {
    const t = normTicket(ticket);
    if (!t) return null;
    for (const r of (rows || [])) {
        if (!r || normTicket(r.client_request_id) !== t) continue;
        // An expired ticket is treated as absent rather than as a match. If a
        // client somehow reuses a ticket a week later that is a genuinely new
        // save, and silently returning last week's record instead of creating
        // one would lose her work — which is a worse failure than the one
        // this file exists to prevent.
        const at = Date.parse(r.created_at || '');
        if (isFinite(at) && (now - at) > TICKET_TTL_MS) continue;
        return r;
    }
    return null;
}

// ── A DRAFT MAY BECOME AT MOST ONE LOAD, EVER ───────────────────────────────
// Apsara, 2026-09-29, on a load that generated twice ("He just saved it
// first.then edit,continue or cancel.he clicked continue,then it generated
// twice"), rejecting a fix that only narrowed the window:
//
//     "NO..IT IS BUSINESS LOGIC LOSE.ALWAYS ONE LOAD SHOULD BE CREATED"
//
// She is right, and the ticket above cannot carry that rule. A ticket is
// minted per SAVE ATTEMPT, so two deliberate saves of the same draft carry
// two different tickets and both are honoured — which is correct for the
// problem the ticket was built for, and wrong for this one. Continuing a
// draft is not a retry; it is a second save attempt of the SAME piece of
// paper, and a piece of paper is one delivery.
//
// So the DRAFT is the key. It is the only identifier that survives the
// things that produced the duplicate: a race between the save and the
// draft's deletion, the form being opened twice, the app and the website
// both holding it, a network retry, a second Continue a week later.
//
// ── NO TTL HERE, DELIBERATELY (my call, not hers) ───────────────────────────
// findSpent forgets a ticket after 24h, which is right for a retry: nothing
// legitimately re-sends a day later, and tickets would otherwise accumulate
// forever. A draft is the opposite. "ALWAYS ONE LOAD" has no clock in it —
// a draft that became a load in June must not become a second one in
// September. The lookup is over the loads that exist, so nothing accumulates
// that was not already being stored.
//
// ── ABSENT MEANS TODAY'S BEHAVIOUR ──────────────────────────────────────────
// A create with no draft id — the voice/assistant path, a straight-through
// save that never autosaved, any caller written before this — returns null
// here and proceeds exactly as it did. The flag marks the NEW shape; nothing
// has to be set to keep an existing path working.
function normDraftId(v) {
    const s = String(v == null ? '' : v).trim();
    // Shape-checked on purpose. An empty string, a stray null-as-text, or
    // anything that is not one of helpers/loadDrafts.js's ids is not a draft,
    // and must not become a key that two unrelated saves could share.
    if (!s || s.length > 100 || !/^DRAFT_/.test(s)) return null;
    return s;
}

function findByDraft(rows, draftId) {
    const d = normDraftId(draftId);
    if (!d) return null;
    for (const r of (rows || [])) {
        if (r && normDraftId(r.draft_id) === d) return r;
    }
    return null;
}

module.exports = { findSpent, normTicket, TICKET_TTL_MS, findByDraft, normDraftId };
