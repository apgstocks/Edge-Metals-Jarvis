// ── helpers/booking.js — Booking queries, formatting ─────────────────────────
const { loadBookings, loadHistory, loadWorkflow } = require('./json');
const { daysUntil, getLADate, parseUSDate }       = require('./time');
const { STEP_LABELS, URGENT_CUTOFF_DAYS }         = require('../config');

function getBooking(bkgNo) {
    bkgNo = String(bkgNo).toUpperCase();
    const b = loadBookings()[bkgNo];
    if (b) return { booking: b, status: 'active' };
    const h = loadHistory()[bkgNo];
    if (h) return { booking: h, status: 'archived' };
    return { booking: null, status: '' };
}

const stepLabel = (step) => STEP_LABELS[step] || STEP_LABELS.not_started;

// ── Formatting (plain labels, no emoji indicators) ────────────────────────────
function formatBookingFull(b) {
    const wf   = loadWorkflow()[b.booking_number] || {};
    const days = b.cutoff_date ? daysUntil(b.cutoff_date) : null;
    const urgency = days !== null && days >= 0 && days <= URGENT_CUTOFF_DAYS
        ? ` (${days} day${days !== 1 ? 's' : ''} — URGENT)` : '';
    return [
        `Booking: ${b.booking_number}`,
        `Status: ${stepLabel(wf.step)}${urgency}`,
        `Vessel: ${b.vessel_voyage || '—'} | ${b.carrier || '—'}`,
        `Route: ${b.port_of_loading || '—'} → ${b.port_of_discharge || '—'}`,
        `ERD: ${b.erd_date || '—'} | Cutoff: ${b.cutoff_date || '—'} | ETD: ${b.etd || '—'}`,
        `Supplier: ${b.supplier || wf.supplier || '—'} | Trucker: ${wf.trucker_name || '—'}`,
    ].join('\n');
}

// Minimal 5-field summary for forward + assign messages to truckers / suppliers.
// Deliberately excludes vessel / carrier / buyer / consignee — user requirement.
// If a trucker asks vessel/carrier via WhatsApp, add that as a follow-up query
// (whitelist doesn't cover it today — future work).
function formatBookingForForward(b) {
    return [
        `Booking: ${b.booking_number}`,
        `Route: ${b.port_of_loading || '—'} → ${b.port_of_discharge || '—'}`,
        `ERD: ${b.erd_date || '—'}`,
        `Cutoff: ${b.cutoff_date || '—'}`,
    ].join('\n');
}

// ERD ALONGSIDE CUTOFF. Apsara, 2026-09-08: "it should fetch unassigned
// houston bookings with ERD and cut off dates."
//
// This line had the cutoff and not the ERD, so a list answered half her
// question and she had to ask about each booking one at a time to get the
// other half. They are the two dates that decide whether a booking can move,
// and they belong together wherever bookings are listed.
function formatBookingLine(b) {
    const wf = loadWorkflow()[b.booking_number] || {};
    return `${b.booking_number} | ${stepLabel(wf.step)} | Trucker: ${wf.trucker_name || '—'} `
         + `| ERD: ${b.erd_date || '—'} | Cutoff: ${b.cutoff_date || '—'}`;
}

function formatBookingAvailable(b) {
    return [
        `${b.booking_number}`,
        `Route: ${b.port_of_loading || '—'} → ${b.port_of_discharge || '—'}`,
        `ERD: ${b.erd_date || '—'} | Cutoff: ${b.cutoff_date || '—'}`,
    ].join('\n');
}

// ── "WITH CUTOFF ANYWHERE NEXT WEEK" ─────────────────────────────────────
// Apsara, 2026-09-08: "If i say,no..check houston bookings with cut off
// anywhere next week. Instead of running that-its assuming something."
//
// She is describing the worst failure this app has: it ran a DIFFERENT query
// and presented the result as though it were the one she asked for. The
// "next week" was dropped silently, so she got every Houston booking back and
// no indication that half her sentence had been ignored. A narrower answer
// than requested is visibly wrong; a WIDER one looks like a complete answer.
//
// Real calendar weeks, not "within 7 days". When she says next week she means
// Monday to Sunday of next week, and she is deciding whether a container can
// physically make a date — so an answer that quietly means "the next seven
// days" would include this Saturday and exclude next Sunday, both wrong in a
// way she would only discover at the port.
//
// Returns null when she said no such thing, and null is the signal to apply
// no window at all rather than to guess one.
// IT PARSES TIME WORDS. IT DOES NOT DECIDE WHETHER SHE MEANT THE CUTOFF.
//
// My first version required the word "cutoff" to appear in the text, which
// broke the moment the model did its job: asked for her timing words, Gemini
// returns "this week" — the cutoff word stripped, because it had already
// understood that part. The function then found no cutoff word and returned
// no window, so the better the model got, the worse this behaved.
//
// The division that keeps this honest: the MODEL decides she was narrowing by
// cutoff (it fills cutoff_phrase or leaves it null). This function converts
// words to dates and nothing else. Deciding meaning here as well is how a
// second, dumber opinion ends up overruling the first.
function cutoffWindow(text, now) {
    const t = String(text || '').toLowerCase();
    const base = now ? new Date(now) : new Date();
    base.setHours(0, 0, 0, 0);
    // Monday as the start of the week; getDay() is 0=Sunday.
    const dow = base.getDay();
    const monday = new Date(base); monday.setDate(base.getDate() - ((dow + 6) % 7));

    const mk = (start, days, label) => {
        const from = new Date(start);
        const to = new Date(start); to.setDate(start.getDate() + days - 1);
        return { from, to, label };
    };

    if (/\bnext week\b/.test(t)) { const m = new Date(monday); m.setDate(monday.getDate() + 7); return mk(m, 7, 'next week'); }
    if (/\bthis week\b/.test(t)) return mk(monday, 7, 'this week');
    const inDays = /\b(?:in|within|next)\s+(\d{1,2})\s+days?\b/.exec(t);
    if (inDays) return mk(base, parseInt(inDays[1], 10) + 1, `the next ${inDays[1]} days`);
    if (/\btomorrow\b/.test(t)) { const d = new Date(base); d.setDate(base.getDate() + 1); return mk(d, 1, 'tomorrow'); }
    if (/\btoday\b/.test(t)) return mk(base, 1, 'today');
    return null;
}

// Applies the window from cutoffWindow(). A booking with NO cutoff date is
// excluded: she asked which ones fall in a range, and "we do not know" is not
// a yes. It is worth saying out loud rather than silently dropping, which is
// why the caller reports the count it removed.
function withinCutoffWindow(rows, win) {
    if (!win) return { rows, undated: 0 };
    let undated = 0;
    const kept = (rows || []).filter((b) => {
        const d = parseUSDate(b.cutoff_date);
        if (!d) { undated += 1; return false; }
        return d >= win.from && d <= win.to;
    });
    return { rows: kept, undated };
}

// ── Queries ───────────────────────────────────────────────────────────────────
function getUrgentBookings(days = URGENT_CUTOFF_DAYS) {
    return Object.values(loadBookings()).filter(b => {
        if (!b.cutoff_date) return false;
        const d = daysUntil(b.cutoff_date);
        return d >= 0 && d <= days;
    });
}

function getBookingsThisWeek() {
    const today = getLADate(); today.setHours(0, 0, 0, 0);
    const weekEnd = new Date(today); weekEnd.setDate(weekEnd.getDate() + 7);
    return Object.values(loadBookings()).filter(b => {
        const date = parseUSDate(b.etd || b.cutoff_date);
        return date && date >= today && date <= weekEnd;
    });
}

// A booking counts as "has a supplier" if EITHER the legacy flat field
// (b.supplier — pre-container-model bookings) OR the workflow record's
// supplier field (wf.supplier — what executeAssign() in workflow/actions.js
// actually writes on every real assignment, container-based or not) is set.
// BUG FIX (2026-07-16): getAvailableBookings() and queryBookingsByLocation()
// below used to check b.supplier ONLY. Since the app moved to the
// per-container assignment model, executeAssign() never writes b.supplier —
// only wf.supplier and the container's own .supplier field — so every
// booking assigned since then was permanently misreported as "unassigned"
// by these two functions specifically (api.js's dashboard decorateBooking()
// already checked wf.supplier || b.supplier correctly; these two just never
// got updated to match when the schema changed). Confirmed live: booking
// 272766480 had Dave assigned as supplier (wf.supplier = 'Dave') but kept
// showing up under "available"/"unassigned" queries on WhatsApp.
function hasSupplierAssigned(b, wf) {
    return !!(wf?.supplier || b.supplier);
}

function getAvailableBookings() {
    const workflow = loadWorkflow();
    return Object.values(loadBookings()).filter(b => !hasSupplierAssigned(b, workflow[b.booking_number]));
}

// Loose substring match — mirrors the same rule used in dashboard/index.html
// and workflow/truckers.js|suppliers.js for locality filtering. Kept as its
// own copy here deliberately (matches existing pattern in this codebase);
// flagged in the July 14 review as worth consolidating into one shared helper.
function localityMatchesPort(loc, port) {
    const l = String(loc || '').toLowerCase().trim().replace(/\s+/g, ' ');
    const p = String(port || '').toLowerCase().trim().replace(/\s+/g, ' ');
    if (!l || !p) return false;
    return l.includes(p) || p.includes(l);
}

// Deterministic answer for "how many bookings [are] unassigned from LA"-style
// questions — no LLM call needed, zero hallucination risk. Filter:
//   'unassigned' → no supplier set (matches dashboard's "Available" definition)
//   'assigned'   → has a supplier
//   null         → no status filter, just count bookings at that location
function queryBookingsByLocation(location, filter) {
    const workflow = loadWorkflow();
    const all = Object.values(loadBookings()).filter(b => localityMatchesPort(b.port_of_loading, location));
    const filtered = filter === 'unassigned' ? all.filter(b => !hasSupplierAssigned(b, workflow[b.booking_number]))
                    : filter === 'assigned'   ? all.filter(b => hasSupplierAssigned(b, workflow[b.booking_number]))
                    : all;
    return { count: filtered.length, bookings: filtered.map(b => b.booking_number), records: filtered };
}

function getBookingsByRoute(pol, pod) {
    return Object.values(loadBookings()).filter(b =>
        (b.port_of_loading  || '').toLowerCase().includes(pol.toLowerCase()) &&
        (b.port_of_discharge || '').toLowerCase().includes(pod.toLowerCase())
    );
}

// Single booking currently in a loading-ish stage (for context inference)
function findBookingInLoadingStage() {
    const workflow = loadWorkflow();
    const bookings = loadBookings();
    const stages = ['empty_dropped', 'load_ready'];
    const candidates = Object.entries(workflow)
        .filter(([bkgNo, wf]) => stages.includes(wf.step) && bookings[bkgNo])
        .map(([bkgNo]) => bkgNo);
    return candidates.length === 1 ? candidates[0] : null;
}

// Extract a booking number from free text
// Apsara pasted a Google Sheets link into WhatsApp on 2026-08-25 and got:
//
//     Apsara: https://docs.google.com/spreadsheets/d/1gwEOz.../edit?gid=2098848345
//     Jarv:   No booking found for 2098848345.
//
// 2098848345 is the SHEET TAB ID. \d{7,} matched it happily, because this
// function scans the whole string and a URL is full of long digit runs — gids,
// timestamps, message ids, tracking codes. Every caller inherited that, so any
// pasted link could be mistaken for a booking anywhere in the app.
//
// URLs are stripped before matching. A booking number written INSIDE a link is
// not a reference she is making; it is part of somebody's address.
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
function resolveBookingNumber(text) {
    const withoutUrls = String(text || '').replace(URL_RE, ' ');
    const match = withoutUrls.trim().toUpperCase().match(/\b([A-Z]{2,6}\d{6,}|\d{7,})\b/);
    return match ? match[1] : null;
}

// Is the message nothing but a link? Used to stop a pasted URL being read as a
// one-word command — see the "bare booking number" branch in workflow/brain.js.
function isBareUrl(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    return /^(?:https?:\/\/|www\.)\S+$/i.test(t);
}

module.exports = {
    getBooking, stepLabel,
    formatBookingFull, formatBookingLine, formatBookingAvailable, formatBookingForForward,
    getUrgentBookings, getBookingsThisWeek, getAvailableBookings,
    getBookingsByRoute, findBookingInLoadingStage, resolveBookingNumber,
    cutoffWindow, withinCutoffWindow,
    queryBookingsByLocation, hasSupplierAssigned, isBareUrl,
};