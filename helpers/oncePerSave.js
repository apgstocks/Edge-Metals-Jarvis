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

module.exports = { findSpent, normTicket, TICKET_TTL_MS };
