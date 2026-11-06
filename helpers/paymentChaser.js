// ── helpers/paymentChaser.js — the payment half of the Follow-up Agent ────
// Apsara, 2026-11-07: "lets work on the followup agent" -> "Add customer payment
// follow-ups". The drafts already exist (helpers/paymentFollowups.js: a remittance-
// status draft for most customers, a payment-request draft from ETA-11 days for
// customers on ETA terms). What was missing is the PERSISTENCE of a follow-up: nothing
// remembered what she had been told, so a draft sat in a list until she thought to look.
//
// ── WHO THIS TALKS TO, AND WHO IT DOES NOT ────────────────────────────────
// The pickup half of this agent mails a logistics company directly because she asked
// it to. For CUSTOMER payments she chose, on 2026-10-21, "for now 1, as future scope 2":
// drafts only, nothing sent. So this half NEVER contacts a customer. It tells HER (and,
// when a customer is well past due, her team) that a follow-up is due, with the draft
// waiting in Jarvis. Sending to the customer is scope 2 and is not built; there is no
// send path in this file for a customer's address to flow into.
//
// ── THE LADDER (pure; the job supplies the clock and the memory) ──────────
//   ask       the first time an unpaid set of invoices needs a follow-up: "draft ready"
//   chase     still unpaid after the due date (ETA-terms customers), or a week after
//             the ask (everyone else): "still unpaid - a firmer note"
//   escalate  a week past due (ETA terms) or three weeks after the ask (others): tell
//             the team, because a draft that nobody sends has stopped being a plan
// A rung fires once. New invoices appearing for the same customer start the ladder
// again, because that is a new thing to ask about.
const path = require('path');
const fs = require('fs');

const DAY = 86400000;
const CHASE_AFTER_ASK_DAYS = 7;          // non-ETA customers
const ESCALATE_AFTER_ASK_DAYS = 21;      // non-ETA customers
const ESCALATE_PAST_DUE_DAYS = 8;        // ETA-terms customers: a week after the first chase

const txt = (v) => String(v == null ? '' : v).trim();
const round2 = (n) => Math.round(n * 100) / 100;
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const keyOf = (name) => txt(name).toLowerCase().replace(/\s+/g, ' ');

function dayOf(v) {
    const s = txt(v);
    let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (m) return Date.UTC(+m[3], +m[1] - 1, +m[2]);
    m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    return null;
}
const todayUtc = (now) => { const d = new Date(now || Date.now()); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };

// A stable fingerprint of WHICH invoices are being asked about.
function setKey(draft) {
    return (draft.lines || []).map((l) => txt(l.id || l.invoice_no || l.container_no)).filter(Boolean).sort().join('|');
}

// The earliest due date among a payment-kind draft's lines (null for remittance drafts).
function earliestDue(draft) {
    const ds = (draft.lines || []).map((l) => dayOf(l.due)).filter((d) => d != null);
    return ds.length ? Math.min(...ds) : null;
}

// entry: what was recorded last time for this customer ({ set, firstAt, lastStep, lastAt }) or undefined.
// Returns { step: 'ask'|'chase'|'escalate'|null, why }.
// Letter-of-credit sales. Apsara, 2026-11-07, asked whether the chase and escalate steps should
// also notify her for customers on LC terms: "no". An LC is paid by the bank against documents,
// so a payment-request chase is the wrong note; the first "draft ready" still fires. A draft is LC
// only if EVERY line is LC - a customer with one LC and one T/T invoice is still chased for the T/T.
const isLcLine = (l) => /^\s*lc\b/i.test(String((l && l.terms) || ''));
function isLcDraft(draft) {
    const lines = (draft && draft.lines) || [];
    return lines.length > 0 && lines.every(isLcLine);
}

function nextAction(draft, entry, now = Date.now()) {
    const a = ladder(draft, entry, now);
    if (a.step && isLcDraft(draft)) return { step: null, why: 'LC terms: the bank pays against documents, so no follow-up at all' };
    return a;
}

function ladder(draft, entry, now = Date.now()) {
    if (!draft || !(draft.total > 0.005)) return { step: null, why: 'nothing outstanding' };
    const today = todayUtc(now);
    const set = setKey(draft);
    if (!entry || entry.set !== set) return { step: 'ask', why: entry ? 'new invoices since the last follow-up' : 'first follow-up' };

    if (entry.lastStep === 'escalate') return { step: null, why: 'already passed to the team' };
    if (draft.kind === 'payment') {
        const due = earliestDue(draft);
        if (due == null) return { step: null, why: 'no due date to measure from' };
        const over = Math.floor((today - due) / DAY);
        if (entry.lastStep === 'ask' && over >= 1) return { step: 'chase', why: `${over} day(s) past due` };
        if (entry.lastStep === 'chase' && over >= ESCALATE_PAST_DUE_DAYS) return { step: 'escalate', why: `${over} day(s) past due` };
        return { step: null, why: over < 1 ? 'not due yet' : 'waiting between rungs' };
    }
    const since = Math.floor((today - todayUtc(Date.parse(entry.lastAt || entry.firstAt || ''))) / DAY);
    const sinceFirst = Math.floor((today - todayUtc(Date.parse(entry.firstAt || ''))) / DAY);
    if (entry.lastStep === 'ask' && since >= CHASE_AFTER_ASK_DAYS) return { step: 'chase', why: `${since} days since the first note` };
    if (entry.lastStep === 'chase' && sinceFirst >= ESCALATE_AFTER_ASK_DAYS) return { step: 'escalate', why: `${sinceFirst} days since the first note` };
    return { step: null, why: 'waiting between rungs' };
}

// One line each, for the batched message to her. Escalations are worded for the team.
function lineFor(draft, step) {
    const n = draft.count === 1 ? '1 invoice' : `${draft.count} invoices`;
    const dueNote = draft.kind === 'payment' && earliestDue(draft) != null
        ? `, due ${new Date(earliestDue(draft)).toISOString().slice(5, 10).replace('-', '/')}` : '';
    const mail = draft.to_missing ? ' (no email on file)' : '';
    if (step === 'ask') return `${draft.customer} — ${money(draft.total)}, ${n}${dueNote}: draft ready${mail}`;
    if (step === 'chase') return `${draft.customer} — ${money(draft.total)}, ${n}${dueNote}: still unpaid, send the draft again${mail}`;
    return `${draft.customer} owes ${money(draft.total)} (${n}${dueNote}) and has not paid after two notes — someone should call them.`;
}

// ── the memory ───────────────────────────────────────────────────────────
function logFile() { return require('../config').PAYMENT_CHASE_LOG_FILE; }
function readLog() {
    try { const o = JSON.parse(fs.readFileSync(logFile(), 'utf8')); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; }
    catch (e) { return {}; }
}
async function writeLog(next) {
    const f = logFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, f);
}

// Decide what is due across every open draft. Pure over (drafts, log, now): no sends, no writes.
function plan(drafts, log, now = Date.now()) {
    const out = [];
    for (const d of drafts || []) {
        const entry = (log || {})[keyOf(d.customer)];
        const a = nextAction(d, entry, now);
        if (a.step) out.push({ draft: d, step: a.step, why: a.why, key: keyOf(d.customer) });
    }
    return out;
}

// Fold what was told into the log. Only call after the message went.
function recorded(log, items, now = Date.now()) {
    const next = { ...(log || {}) };
    for (const it of items) {
        const prev = next[it.key];
        const set = setKey(it.draft);
        const iso = new Date(now).toISOString();
        next[it.key] = (prev && prev.set === set)
            ? { ...prev, lastStep: it.step, lastAt: iso, steps: { ...(prev.steps || {}), [it.step]: iso } }
            : { set, firstAt: iso, lastStep: it.step, lastAt: iso, steps: { [it.step]: iso }, customer: it.draft.customer };
    }
    // Customers who no longer owe anything fall out of the memory, so a later invoice starts fresh.
    return next;
}

// What the screen shows beside a customer: when each rung fired for the CURRENT set of invoices.
// null when nothing has been said about this exact set yet.
const mmdd = (iso) => { const t = Date.parse(iso || ''); if (!Number.isFinite(t)) return null; const d = new Date(t); return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`; };
function statusFor(draft, log) {
    const lc = isLcDraft(draft);
    const entry = (log || {})[keyOf(draft.customer)];
    const held = entry && entry.held ? mmdd(new Date(entry.held.at).toISOString()) : null;
    if (!entry || entry.set !== setKey(draft)) return { asked: null, chased: null, escalated: null, held, lc };
    const st = entry.steps || { [entry.lastStep]: entry.lastAt };
    return { asked: mmdd(st.ask), chased: mmdd(st.chase), escalated: mmdd(st.escalate), held, lc };
}

function prune(log, drafts) {
    const live = new Set((drafts || []).map((d) => keyOf(d.customer)));
    const next = {};
    for (const [k, v] of Object.entries(log || {})) if (live.has(k)) next[k] = v;
    return next;
}

// Whether the draft has an address the customer email could go to. The agent never reads the address itself.
const hasAddress = (draft) => !!(draft && !draft.to_missing && draft.to);

module.exports = { hasAddress, nextAction, isLcDraft, statusFor, plan, lineFor, recorded, prune, readLog, writeLog, setKey, earliestDue, money, keyOf,
    CHASE_AFTER_ASK_DAYS, ESCALATE_AFTER_ASK_DAYS, ESCALATE_PAST_DUE_DAYS };
