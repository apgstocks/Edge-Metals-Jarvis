// ── helpers/poTracker.js — a purchase order as a LIVE MATTER ────────────────
//
// WHY THIS FILE EXISTS. Apsara, 2026-09-17: "Why all my PO gets ignored in
// email?" I ran the real pipeline over every PO email in her inbox from the
// previous 20 days. 30 emails. 5 shown. 24 silently dropped — 17 of them from
// outside the company (eccomelt, Schneider, FMC).
//
// Every one of the 24 died on the same field:
//
//     asked_for: (none)     ← all 24
//     needs_reply: false    ← all 24
//     waiting_on: them (18), colleague (5), nobody (1)
//
// An email reaches her digest only through this gate in replyWatch.js:
//
//     (needs_reply && confidence >= MIN) || is_order || owed || bystander || colleague
//
// needs_reply is false on a PO thread because nobody asks a question —
// "delivery confirmed 9/11 at 1100", "container arrived this morning". And
// the other four gates ALL require a named asked_for. A PO coordination
// thread contains no request sentence, so it fails all five and vanishes.
//
// This was not the grounding gate over-firing: only 1 of the 24 had an
// asked_for that got nulled as ungrounded. The other 23 came back null from
// the model, correctly. There was no ask to find.
//
// So it is a DESIGN GAP, not a bug. replyWatch knows two things: "someone
// wants a reply" and "someone is owed a named thing". A live PO is neither.
// It is a multi-week workflow — raised, appointment requested, rescheduled,
// delivered, confirmed — where every message is operationally significant and
// none of them is a question. That category did not exist in the code.
//
// WHY NOT JUST LOOSEN isOwedItem. Because the asked_for requirement is what
// killed the "Yurim Cha attached surrendered HBL / asked Accounting Edge"
// noise she complained about on 28 Aug. Dropping it would bring that back
// across her whole inbox to fix one category. This file keys on a PO
// REFERENCE instead, so nothing outside PO mail changes behaviour at all.
//
// WHAT THIS DELIBERATELY DOES NOT DO: it does not decide anything. No
// needs_reply, no urgency, no reply drafting. It records that a PO moved and
// says so in its own section, below the numbered list. See buildPoLines.

const PO_STALE_DAYS = 14;    // no movement for this long and it stops being live
const MAX_EVENTS = 12;       // per PO, newest kept
const MAX_POS = 40;          // total tracked, most-recently-moved kept
const DAY_MS = 86400000;

// ── EXTRACTION ─────────────────────────────────────────────────────────────
// Matches "Purchase Order #4302902", "PO 4302902", "PO# 4302902", "P.O. No.
// 4302902", "po number 4302902".
//
// THE DIGITS ARE MANDATORY. Her inbox contains "PO from Edge Metals" (a
// QuickBooks notification) and "Rental Invoice # 920043344 ... PO#" with
// nothing after the hash — both real, both from the 20-day sample. A bare
// "PO" is not a reference to anything and must never open a tracked matter.
//
// 4 to 12 digits: hers run 7 ("4302902"). Three or fewer matches a quantity,
// a price or a time ("PO 12") often enough to be useless.
const PO_REF = /\b(?:purchase\s+order|p\.?\s?o\.?)\s*(?:number|no\.?|#)?\s*[:#]?\s*(\d{4,12})\b/gi;

// "P.O. Box 90210" in an email signature is the false positive that would
// recur forever — every message from that sender opening the same phantom PO.
// It needs NO guard of its own, and I wrote one before checking: the digits
// requirement above already excludes it, because "Box" sits between the
// "P.O." and the number and nothing in the pattern matches a word there.
//
// The guard was removed after reverse-verification showed it dead: disabling
// it broke no test, while disabling the digits rule broke the P.O. Box test
// along with the other two. A guard that guards nothing is worse than no
// guard — it tells the next reader the danger is handled somewhere it isn't.
// AE4 in tests/emailwatch-signals.js pins the behaviour to the digits rule.
function poReferencesIn(...texts) {
    const found = new Set();
    for (const t of texts) {
        const s = String(t || '');
        if (!s) continue;
        for (const m of s.matchAll(PO_REF)) found.add(m[1]);
    }
    return [...found];
}

// ── RECORDING ──────────────────────────────────────────────────────────────
// Called for EVERY assessed email that carries a PO reference, whether or not
// the digest gates let it through. That independence is the entire point: the
// gates are what lost these emails.
//
// Deduped on messageId. A rescan re-assesses mail it has already seen, and a
// PO whose history doubles every rescan is worse than no history.
// The `at` a caller hands in is a Gmail Date header that has been through
// helpers/gmail.js's parseEmailDate, which returns an ISO STRING when it can
// parse and THE RAW HEADER when it cannot. An unparseable value stored here
// makes staleDays() return Infinity, so the PO is never open and never
// pruned — invisible, permanent, and with nothing logged.
//
// Found the hard way: the first wiring called .toISOString() on that return
// value, which threw on every single email, and the try/catch around the
// call site swallowed it. The scan would have kept running and recorded
// nothing at all. Validated here rather than at the call site, because this
// module should not trust its input to be a date just because the field is
// called `at`.
function usableDate(v) {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
}

function recordPoMovement(store, ev) {
    const po = String(ev && ev.po || '').trim();
    if (!po) return null;
    store.pos = (store.pos && typeof store.pos === 'object' && !Array.isArray(store.pos)) ? store.pos : {};
    const at = usableDate(ev.at) || new Date().toISOString();
    const rec = store.pos[po] || {
        po, firstSeenAt: at, lastMovedAt: at, threadIds: [], events: [],
        closedAt: null, closedBy: null,
    };

    // A PO she CLOSED by hand stays closed. She said it was done; new mail on
    // it is recorded for the audit trail but does not drag it back into her
    // list. An auto-close (staleness) is different — see isOpen: that one is
    // Jarvis forgetting, not her deciding, and fresh movement revives it.
    if (ev.messageId && rec.events.some((e) => e.messageId === ev.messageId)) return rec;

    rec.events.push({
        at,
        by: ev.fromName || ev.from || null,
        ours: !!ev.ours,
        summary: ev.summary || ev.subject || null,
        waiting_on: ev.waiting_on || null,
        messageId: ev.messageId || null,
    });
    // Newest last, capped. FORGETTING IS AN OPERATION — an events array that
    // only grows turns the store into a log file and the digest line into a
    // guess about which of 200 entries matters.
    rec.events.sort((a, b) => new Date(a.at) - new Date(b.at));
    if (rec.events.length > MAX_EVENTS) rec.events = rec.events.slice(-MAX_EVENTS);
    if (ev.threadId && !rec.threadIds.includes(ev.threadId)) rec.threadIds.push(ev.threadId);
    rec.lastMovedAt = rec.events[rec.events.length - 1].at;
    if (new Date(rec.firstSeenAt) > new Date(at)) rec.firstSeenAt = at;
    store.pos[po] = rec;
    return rec;
}

// ── WHAT COUNTS AS LIVE ────────────────────────────────────────────────────
function staleDays(rec, now) {
    const last = new Date(rec && rec.lastMovedAt || NaN).getTime();
    if (isNaN(last)) return Infinity;
    return (now - last) / DAY_MS;
}

function isOpen(rec, now = Date.now()) {
    if (!rec) return false;
    if (rec.closedAt) return false;                       // she closed it
    return staleDays(rec, now) <= PO_STALE_DAYS;          // or it went quiet
}

// ── WHAT IS WORTH INTERRUPTING HER FOR ─────────────────────────────────────
// The digest's send gate is `queued.length > 0`. On a day whose only mail is
// PO coordination, queued is empty and nothing goes out — which is the
// complaint, restated. So PO movement has to be able to trigger a digest.
//
// It must NOT trigger on every message, or a 26-message appointment thread
// (she has one) becomes an hourly ping. Two conditions, both necessary:
//
//   EXTERNAL. Our own mail moving the PO is not news to her — she or Bose
//   wrote it. Only a counterparty's message counts.
//
//   UNREPORTED. Newer than the last time this PO's state was put in front of
//   her. Without this, one movement would be re-announced every hour until
//   the next one arrived.
//
// Combined with the existing gapElapsed gate (never on urgency, never
// overnight), the worst case is one extra message an hour on a day that has
// PO mail in it, and zero on a day that does not.
function lastExternalEvent(rec) {
    const ext = (rec.events || []).filter((e) => !e.ours);
    return ext.length ? ext[ext.length - 1] : null;
}

function unreportedPos(store, now = Date.now()) {
    return openPos(store, now).filter((r) => {
        const ext = lastExternalEvent(r);
        if (!ext) return false;
        if (!r.lastToldAt) return true;
        return new Date(ext.at) > new Date(r.lastToldAt);
    });
}

// Called only after a message has actually gone out. Marking before the send
// loses the movement when WhatsApp is down — sendMessage returns false rather
// than throwing, which is the exact trap the digest's own delivery code
// documents.
function markPosTold(store, pos, at = new Date().toISOString()) {
    for (const r of pos || []) {
        if (store.pos && store.pos[r.po]) store.pos[r.po].lastToldAt = at;
    }
}

// Most recently moved first — the order she would sort them in herself.
function openPos(store, now = Date.now()) {
    const all = (store && store.pos) || {};
    return Object.values(all)
        .filter((r) => isOpen(r, now))
        .sort((a, b) => new Date(b.lastMovedAt) - new Date(a.lastMovedAt));
}

// Called by her: "close po 4302902". Deletion-free, same reasoning as the
// mute fix — a release that depends on deleting a key fails silently in a
// sandbox and leaves the thing it was releasing still held.
function closePo(store, po, by = 'apsara') {
    const key = String(po || '').trim();
    if (!key || !store.pos || !store.pos[key]) return null;
    store.pos[key].closedAt = new Date().toISOString();
    store.pos[key].closedBy = by;
    return store.pos[key];
}

function reopenPo(store, po) {
    const key = String(po || '').trim();
    if (!key || !store.pos || !store.pos[key]) return null;
    store.pos[key].closedAt = null;
    store.pos[key].closedBy = null;
    return store.pos[key];
}

// Drops what nobody will ever read again. Runs at the end of a scan, never
// mid-render: a prune that happens while a list is being built can remove the
// row that list was about.
function prunePos(store, now = Date.now()) {
    if (!store.pos) return 0;
    let dropped = 0;
    // A PO closed long ago has served its purpose. Kept for one stale window
    // after closing so "close po X" followed by "what happened to X" still
    // answers.
    for (const [k, r] of Object.entries(store.pos)) {
        const age = staleDays(r, now);
        if (age > PO_STALE_DAYS * 3 || (r.closedAt && age > PO_STALE_DAYS)) {
            delete store.pos[k]; dropped++;
        }
    }
    const keys = Object.keys(store.pos);
    if (keys.length > MAX_POS) {
        const order = keys.sort((a, b) => new Date(store.pos[b].lastMovedAt) - new Date(store.pos[a].lastMovedAt));
        for (const k of order.slice(MAX_POS)) { delete store.pos[k]; dropped++; }
    }
    return dropped;
}

// ── RENDERING ──────────────────────────────────────────────────────────────
// NOT NUMBERED IN THE DIGEST'S SEQUENCE, and this is not a style choice.
// "reply to 1" and "ignore 1" resolve against store.lastDigest, which is the
// `matters` array. A PO line carrying a 1. would make "ignore 1" ambiguous
// between two different lists — the exact failure she hit on 01 Sep, when
// "ignore 1" answered "I don't have a #undefined from a recent digest".
// The PO NUMBER is the handle instead: it is unambiguous, and it is the thing
// she already uses to talk about the order.
function agePhrase(days) {
    if (days < 1) return 'today';
    if (days < 2) return 'yesterday';
    return `${Math.floor(days)}d ago`;
}

function buildPoLines(pos, now = Date.now()) {
    if (!pos || !pos.length) return [];
    const lines = ['', `📋 ${pos.length} open PO${pos.length === 1 ? '' : 's'}:`, ''];
    for (const r of pos) {
        const last = r.events[r.events.length - 1] || {};
        const age = staleDays(r, now);
        // The LATEST movement, not a summary of the whole thread. What she
        // needs off a glance is where the PO stands now; the count tells her
        // how much conversation sits behind it if she wants to open it.
        lines.push(`• *PO ${r.po}* — ${last.summary || 'no detail captured'}`);
        const who = last.ours ? `us (${last.by || 'Edge Metals'})` : (last.by || 'unknown');
        lines.push(`   last moved ${agePhrase(age)} by ${who}${r.events.length > 1 ? `, ${r.events.length} messages` : ''}`);
        lines.push('');
    }
    lines.push('Say "close po <number>" when one is done, or "po <number>" for its history.');
    return lines;
}

// Her asking about one directly.
function poHistoryLines(rec) {
    if (!rec) return ['I have no movement recorded against that PO.'];
    const out = [`*PO ${rec.po}* — ${rec.events.length} message${rec.events.length === 1 ? '' : 's'}`
        + (rec.closedAt ? ` (closed ${String(rec.closedAt).slice(0, 10)})` : ''), ''];
    for (const e of rec.events) {
        out.push(`${String(e.at).slice(0, 10)}  ${e.ours ? 'us' : (e.by || '?')}: ${e.summary || '(no detail)'}`);
    }
    return out;
}

module.exports = {
    poReferencesIn, recordPoMovement, openPos, usableDate, isOpen, closePo, reopenPo,
    prunePos, buildPoLines, poHistoryLines, staleDays,
    unreportedPos, markPosTold, lastExternalEvent,
    PO_STALE_DAYS, MAX_EVENTS, MAX_POS,
};
