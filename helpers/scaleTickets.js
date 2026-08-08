// ── helpers/scaleTickets.js — Yard scale-ticket store ────────────────────────
// NEW FILE. Deliberately separate from bookings.json/workflow.json — per
// Apsara: this is a different feature for yard operations, not tied to a
// booking or container record. Flat array, newest-first, same storage
// pattern (mutateJson/lockfile) as address_book.json / quote_requests.json.
//
// Images are NOT stored inline here (see note in addScaleTicket below) —
// only a Drive file id/link, set via updateScaleTicket() after upload.
// Keeping base64 image data out of this file matters: it's read/parsed as a
// whole JSON blob on every write (same lockfile pattern as every other file
// in helpers/json.js), and this file lives on a 2GB-RAM VM. A few thousand
// tickets with embedded photos would make every single write progressively
// slower and heavier — the same problem GDRIVE_FOLDER_ID already solves for
// booking PDFs.

const { mutateJson, loadJson } = require('./json');
const cfg = require('../config');

function loadScaleTickets() {
    return loadJson(cfg.SCALE_TICKETS_FILE, []);
}

async function addScaleTicket(entry) {
    return mutateJson(cfg.SCALE_TICKETS_FILE, [], (tickets) => {
        const record = {
            id            : `ST-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            received_at   : new Date().toISOString(),
            drive_file_id : null,
            drive_link    : null,
            ...entry,
        };
        tickets.unshift(record);
        if (tickets.length > 2000) tickets.length = 2000;
        return tickets;
    });
}

async function updateScaleTicket(id, patch) {
    return mutateJson(cfg.SCALE_TICKETS_FILE, [], (tickets) => {
        const t = tickets.find(x => x.id === id);
        if (t) Object.assign(t, patch, { updated_at: new Date().toISOString() });
        return tickets;
    });
}

module.exports = { loadScaleTickets, addScaleTicket, updateScaleTicket };
