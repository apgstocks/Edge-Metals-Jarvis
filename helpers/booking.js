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

function formatBookingLine(b) {
    const wf = loadWorkflow()[b.booking_number] || {};
    return `${b.booking_number} | ${stepLabel(wf.step)} | Trucker: ${wf.trucker_name || '—'} | Cutoff: ${b.cutoff_date || '—'}`;
}

function formatBookingAvailable(b) {
    return [
        `${b.booking_number}`,
        `Route: ${b.port_of_loading || '—'} → ${b.port_of_discharge || '—'}`,
        `ERD: ${b.erd_date || '—'} | Cutoff: ${b.cutoff_date || '—'}`,
    ].join('\n');
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

function getAvailableBookings() {
    return Object.values(loadBookings()).filter(b => !b.supplier);
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
    const stages = ['waiting_empty_drop', 'empty_dropped', 'load_ready'];
    const candidates = Object.entries(workflow)
        .filter(([bkgNo, wf]) => stages.includes(wf.step) && bookings[bkgNo])
        .map(([bkgNo]) => bkgNo);
    return candidates.length === 1 ? candidates[0] : null;
}

// Extract a booking number from free text
function resolveBookingNumber(text) {
    const match = String(text).trim().toUpperCase().match(/\b([A-Z]{2,6}\d{6,}|\d{7,})\b/);
    return match ? match[1] : null;
}

module.exports = {
    getBooking, stepLabel,
    formatBookingFull, formatBookingLine, formatBookingAvailable,
    getUrgentBookings, getBookingsThisWeek, getAvailableBookings,
    getBookingsByRoute, findBookingInLoadingStage, resolveBookingNumber,
};
