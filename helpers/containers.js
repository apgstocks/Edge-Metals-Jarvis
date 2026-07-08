// ── helpers/containers.js — multi-container schema + migration ─────────────
// A booking has 1+ containers. Each container has its own supplier, trucker,
// and stage. Booking-level fields (carrier, ports, vessel, dates) are shared.
//
// This module is used by every part of the pipeline (dashboard, brain, actions,
// scheduler, alerts) so behavior is consistent. Keep container semantics here.

const cfg = require('../config');

// Legacy bookings (pre-multi-container) had flat container_size / container_number.
// migrate() reshapes them into a containers[] array so all downstream code can
// assume containers[] exists. Safe to call on already-migrated bookings.
function migrate(booking) {
    if (!booking || typeof booking !== 'object') return booking;
    if (Array.isArray(booking.containers) && booking.containers.length > 0) return booking; // already migrated

    // Parse "40HC X 3" → { size: "40HC", count: 3 } (from container_size field)
    const raw   = String(booking.container_size || '').trim();
    const parts = raw.match(/^\s*(\d+[A-Z]{2,3})\s*[xX*]\s*(\d+)\s*$/);
    let size, count;
    if (parts)                { size = parts[1]; count = parseInt(parts[2], 10) || 1; }
    else if (raw)             { size = raw;      count = 1; }
    else                      { size = null;     count = 1; }

    const containers = [];
    for (let i = 1; i <= count; i++) {
        containers.push({
            seq              : i,
            size,
            container_number : (i === 1 ? (booking.container_number || null) : null),
            supplier         : (i === 1 ? (booking.supplier || null)         : null),
            trucker          : (i === 1 ? (booking.trucker || null)          : null),
            stage            : (i === 1 && booking.stage ? booking.stage      : 'not_started'),
            pdf_drive_id     : null,
            pdf_uploaded_at  : null,
        });
    }
    // Preserve flat fields for backward-compat display while old code paths still exist.
    // We do NOT delete container_size/container_number — Phase 2+ removes those refs
    // once dashboard/workflow migrate their reads.
    return { ...booking, containers };
}

// Utility: iterate migrated bookings dict in place (used by loadBookings)
function migrateAll(bookingsDict) {
    if (!bookingsDict) return {};
    for (const bkg of Object.keys(bookingsDict)) {
        bookingsDict[bkg] = migrate(bookingsDict[bkg]);
    }
    return bookingsDict;
}

// Get one container by seq (1-indexed). Returns null if not found.
function getContainer(booking, seq) {
    if (!booking?.containers) return null;
    const n = Number(seq);
    return booking.containers.find(c => c.seq === n) || null;
}

// A booking's overall stage is the min of its containers' stages (weakest link).
// Used by dashboard summary and 'ready to close' calculations.
function bookingStage(booking) {
    const stages = (booking?.containers || []).map(c => c.stage || 'not_started');
    if (!stages.length) return 'not_started';
    const order = cfg.WORKFLOW_STAGES || ['not_started','supplier_assigned','forwarded','empty_dropped','load_ready','picked_up','ingate_received','done'];
    let minIdx = order.length;
    for (const s of stages) {
        const i = order.indexOf(s);
        if (i >= 0 && i < minIdx) minIdx = i;
    }
    return order[minIdx] || 'not_started';
}

// How many containers are assigned to a supplier / trucker
function assignedCount(booking, kind /* 'supplier'|'trucker' */) {
    return (booking?.containers || []).filter(c => c[kind]).length;
}

// Return lowest-seq container missing the given assignment (kind: 'supplier'|'trucker').
// Returns null if all containers already have that kind assigned (capacity full).
function nextUnassignedContainer(booking, kind) {
    if (!booking?.containers) return null;
    const sorted = [...booking.containers].sort((a, b) => a.seq - b.seq);
    return sorted.find(c => !c[kind]) || null;
}

// Look up which container of a booking is assigned to a person by name.
// Used later by trucker/supplier replies to disambiguate which container's stage advances.
function containerAssignedTo(booking, kind, name) {
    if (!booking?.containers || !name) return null;
    const lower = String(name).toLowerCase();
    return booking.containers.find(c => c[kind] && String(c[kind]).toLowerCase() === lower) || null;
}

module.exports = { migrate, migrateAll, getContainer, bookingStage, assignedCount, nextUnassignedContainer, containerAssignedTo };