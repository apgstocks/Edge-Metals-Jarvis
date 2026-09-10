// ── helpers/deliveryEnquiry.js — "did the load get there?" at the ETA ────
// Apsara, 2026-09-10: "say i do local transit, we will pay the trucker and
// trucker will give estimated delivery date and time. I want to send a enquiry
// at that date and time reg the load delivery status".
//
// ── WHICH TRUCKING THIS IS, AND WHICH IT IS NOT ─────────────────────────
// This codebase has three things called trucking and they are not the same:
//
//   · helpers/metalsTrucking.js  drayage on an Edge METALS export container.
//                                Has a booking, a vessel and an ocean ETA.
//   · helpers/truckerBills.js    the yard's payables ledger. A bill and an
//                                amount, with no delivery in it at all.
//   · this file                  a domestic truck taking an OUTBOUND load to
//                                a buyer's yard. "Local transit". The load
//                                leaves, and some hours later it either
//                                arrives or it does not.
//
// Her sentence names all three of that last one's nouns — local transit, the
// trucker we pay, the LOAD's delivery status — so it hangs off
// helpers/outboundLoads.js and nothing else. Edge Yard is not Edge Metals.
//
// ── IT DOES NOT OWN A SCHEDULER ─────────────────────────────────────────
// There is already a minute-resolution task queue (helpers/tasks.js, drained
// by scheduler.js's taskRunner) that fires a message at an instant, resolves
// a trucker's name to a WhatsApp chat OR falls back to email for an
// email-only haulier, retries, and archives. A second timer would be the same
// "two mechanisms answering one question" mistake this codebase keeps paying
// for. So this file mints an ORDINARY task and adds no runner branch at all:
// type 'delivery_status_enquiry' falls through taskRunner's generic path,
// which already does every one of those things.
//
// ── THE FAILURE THIS FILE MOSTLY EXISTS TO PREVENT ──────────────────────
// taskRunner resolves target_name against the trucker roster with an EXACT
// `x.name === task.target_name`. outboundLoads.trucker_name is free text on a
// form. When they disagree — "Jose AJ" typed against "Jose AJ Transport" on
// file — the task burns its three tries and archives itself as
// 'no_chatid_resolved', and NOBODY IS TOLD. That is not hypothetical: the
// comments in scheduler.js record it happening to her quote reminders, an
// entire chain dying silently.
//
// So the roster is consulted HERE, at scheduling time, when she is still
// looking at the screen and can fix it — and what gets stored as target_name
// is the roster's own spelling, never hers, so the exact match at fire time
// cannot fail after this said it would work.
//
// ── AND THE TRUCKER DOES NOT SEE THE PRICE ──────────────────────────────
// The enquiry names the buyer, the material and the weight, because that is
// how the driver knows which load is being asked about. It carries no amount
// and no per-lb price. The haulier being asked to confirm delivery is not
// entitled to know what the buyer paid for the metal, and a message composed
// from a record that has the figure right there is exactly how it would leak.

const tasks = require('./tasks');
const { findByNormalizedName } = require('./nameMatch');

const TASK_TYPE = 'delivery_status_enquiry';
const DEFAULT_TZ = tasks.DEFAULT_TZ;                 // America/Los_Angeles

// ── THE ETA IS A WALL CLOCK, NOT AN INSTANT ─────────────────────────────
// She types "3:30 PM" meaning half past three where the truck is, and the
// server may be anywhere. Converted through tasks.js's own zone maths, which
// probes Intl rather than carrying an offset table, so an ETA on a DST
// changeover day lands at the time she meant instead of an hour out.
function etaInstant(dateStr, timeStr, tz = DEFAULT_TZ) {
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
    if (!d) return null;
    const t = tasks.parseAtTime(timeStr);
    if (!t) return null;
    // Reached through tasks.js so there is one implementation of this
    // conversion in the process, not two that can drift apart on a DST day.
    return tasks.instantForZonedWallClock(+d[1], +d[2], +d[3], t.hh, t.mm, tz || DEFAULT_TZ);
}

const hasEta = (load) =>
    !!(load && String(load.delivery_eta_date || '').trim() && String(load.delivery_eta_time || '').trim());

function etaFor(load) {
    if (!hasEta(load)) return null;
    return etaInstant(load.delivery_eta_date, load.delivery_eta_time,
                      load.delivery_eta_tz || DEFAULT_TZ);
}

// For confirmations and for the card. 12-hour, because that is how she and
// every driver says it.
function describeEta(load, tz) {
    const at = etaFor(load);
    if (!at) return null;
    return new Intl.DateTimeFormat('en-US', {
        timeZone: tz || load.delivery_eta_tz || DEFAULT_TZ,
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(at);
}

// ── WHO IT GOES TO ──────────────────────────────────────────────────────
// Exact roster name first, so nothing that resolves today can be re-pointed
// by the normalised tier below it — the ordering helpers/nameMatch.js asks
// its callers to keep.
// `roster` is injectable for one reason: helpers/json.js's loadTruckers()
// reads SUPABASE, not a file, so a test that does not inject one silently
// queries her live production roster — which is how tests/delivery-enquiry.js
// behaved until it was caught. Production never passes it.
async function resolveTrucker(name, { roster: given = null } = {}) {
    const typed = String(name || '').trim();
    if (!typed) return { ok: false, why: 'no_trucker', message: 'this load has no trucker on it, so there is nobody to ask' };

    const { loadTruckers } = require('./json');
    const roster = given || await loadTruckers();

    let hit = roster.find((t) => t.name === typed);
    if (!hit) {
        const near = findByNormalizedName(roster, typed);
        // More than one roster entry collapsing to the same normalised name
        // is a roster problem, and picking one of them here would send the
        // enquiry to a coin toss.
        if (near.length === 1) hit = near[0];
        else if (near.length > 1) {
            return { ok: false, why: 'ambiguous_trucker',
                     message: `"${typed}" matches ${near.length} truckers on file — give the load the exact name` };
        }
    }
    if (!hit) {
        return { ok: false, why: 'unknown_trucker',
                 message: `"${typed}" is not in the trucker list, so I have no number or address to send the enquiry to` };
    }

    const reachable = !!(hit.group_id || hit.whatsapp
        || (hit.preferred_mode === 'email' && hit.email));
    if (!reachable) {
        return { ok: false, why: 'unreachable_trucker',
                 message: `${hit.name} has no WhatsApp number, no group and no email on file — nothing to send the enquiry to` };
    }
    // The ROSTER's spelling, not hers. taskRunner matches on `===`.
    return { ok: true, record: hit, canonical: hit.name };
}

// ── WHAT IT SAYS ────────────────────────────────────────────────────────
// Enough for the driver to know which load, and no money. See the header.
function enquiryMessage(load) {
    const buyer = String(load.buyer || '').trim();
    const what = (load.items || [])
        .map((i) => String(i.description || '').trim()).filter(Boolean);
    const unit = load.weight_unit || 'lb';
    const net = load.net_weight;

    const bits = [];
    if (what.length) bits.push(what.length === 1 ? what[0] : `${what[0]} +${what.length - 1} more`);
    if (net) bits.push(`${net} ${unit}`);
    const load_ = bits.length ? ` (${bits.join(', ')})` : '';

    const to = buyer ? ` to ${buyer}` : '';
    const when = describeEta(load);
    // Named as an ETA that has come round rather than as an accusation — it
    // is due now, not late, and a driver told he is late when he is not
    // stops answering these.
    return `Checking on the load${to}${load_} — it was due ${when ? when : 'about now'}. Has it been delivered?`;
}

// ── SCHEDULING ──────────────────────────────────────────────────────────
// Returns a REASON in every case where it does not schedule, so the caller
// can put it on screen. Returning a bare false is what lets this go quiet.
async function scheduleForLoad(load, { created_by = 'web', now = new Date(), roster = null } = {}) {
    if (!load || !load.id) return { scheduled: false, why: 'no_load' };
    if (isDelivered(load)) {
        return { scheduled: false, why: 'already_delivered',
                 message: 'that load is already marked delivered, so no enquiry was scheduled' };
    }
    if (!hasEta(load)) return { scheduled: false, why: 'no_eta' };

    const at = etaFor(load);
    if (!at) {
        return { scheduled: false, why: 'bad_eta',
                 message: `I could not read "${load.delivery_eta_date} ${load.delivery_eta_time}" as a delivery date and time` };
    }
    // A past ETA is not an error — she may be entering a load after the fact —
    // but firing an enquiry the instant she saves it is not what she asked
    // for either, so it is declined with a reason rather than fired at once.
    if (at.getTime() <= now.getTime()) {
        return { scheduled: false, why: 'eta_passed',
                 message: `${describeEta(load)} has already passed, so no enquiry was scheduled` };
    }

    const who = await resolveTrucker(load.trucker_name, { roster });
    if (!who.ok) return { scheduled: false, why: who.why, message: who.message };

    const task = await tasks.enqueue({
        type: TASK_TYPE,
        target_kind: 'trucker',
        target_name: who.canonical,
        message: enquiryMessage(load),
        fire_at: at.toISOString(),
        // Pinned to the instant this was scheduled FOR. If the load's ETA has
        // moved by the time it comes due, this one is stale and skips itself —
        // a second line behind syncForLoad, so a re-enqueue that half failed
        // leaves no enquiry rather than two.
        // load_created_at is not decoration. outboundLoads.nextOutboundId
        // derives the next id from the highest one PRESENT, so deleting OUT_07
        // hands OUT_07 to the next load created. A task keyed on the id alone
        // would then be pointing at a different load, with a different buyer
        // and possibly a different trucker, and the gate below would let it
        // through if the two happened to share an ETA. Compared here rather
        // than fixed in nextOutboundId, because changing how ids are allocated
        // reaches payments, the ticket PDFs and the stock draws, and that is a
        // separate decision from this feature. FLAGGED, not silently absorbed.
        condition: {
            type: 'outbound_load_delivered',
            load_id: load.id,
            eta_at: at.toISOString(),
            load_created_at: load.created_at || null,
        },
        outbound_load_id: load.id,
        created_by,
    });
    return { scheduled: true, task, at, message: `I'll ask ${who.canonical} about this load on ${describeEta(load)}.` };
}

function pendingForLoad(loadId) {
    return tasks.loadTasks().filter((t) =>
        t.type === TASK_TYPE && t.status === 'pending' && t.outbound_load_id === loadId);
}

async function cancelForLoad(loadId, reason = 'user_cancelled') {
    const doomed = pendingForLoad(loadId);
    for (const t of doomed) await tasks.cancel(t.id, reason);
    return doomed.length;
}

// Create, edit and delete all go through here. Cancel-then-schedule rather
// than patch-in-place: an edit can change the trucker as well as the time, and
// a patched task would keep pointing at whoever was on it before.
async function syncForLoad(load, opts = {}) {
    const cancelled = await cancelForLoad(load && load.id, opts.reason || 'eta_changed');
    const res = await scheduleForLoad(load, opts);
    return { ...res, cancelled };
}

const isDelivered = (load) =>
    String((load && load.delivery_status) || '').trim().toLowerCase() === 'delivered';

module.exports = {
    TASK_TYPE, DEFAULT_TZ,
    etaInstant, etaFor, hasEta, describeEta, isDelivered,
    resolveTrucker, enquiryMessage,
    scheduleForLoad, cancelForLoad, syncForLoad, pendingForLoad,
};
