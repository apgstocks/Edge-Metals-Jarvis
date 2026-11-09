// ── helpers/depositAutoApply.js — certain deposits placed by Jarvis, with a reason and an undo ──
//
// Apsara, 2026-11-09: "applying certain deposits automatically ... I want a daily report of what was applied
// automatically, against what, the reason behind why the AI wanted to apply it, with an undo button. Then learn
// if I undo — what was wrong, the AI should find out."
//
// THIS REVERSES A RULE. helpers/bankAutoTick.js says "deposits are never auto: a deposit match applies money to an
// invoice". She has now said yes to exactly that, for the narrow case below. Nothing else about deposits changes:
// every deposit that is not certain still goes to her screen as a question, exactly as before.
//
// ── "CERTAIN" IS HER OWN BAR, PLUS ONE THING ─────────────────────────────
// The "Confirm all sure matches" button on the bank page already has a definition (dashboard/bank-match.html:
// sureOf + bulkable): one clear answer at 95%+, pays its invoice in full with nothing short, the account is known,
// and the bank line says how it came (WIRE or ZELLE). This uses the same bar, and adds ONE INVOICE ONLY ("exact
// amount, one invoice, name matches" — docs/OWNERSHIP-PLAN.md slice 4). A deposit that pays several invoices at
// once, however confident, is hers.
//
// The proposals come from bankMatchRoutes.depositProposals — the SAME function the screen's route uses — so the
// company filter (Edge Metals only, rule 5), the not-trade filter and the between-your-companies filter are not
// copied here and cannot drift. The model's payer-reading is switched OFF: a payer it had to guess at is a question,
// never an action.
//
// ── WHAT PLACING A DEPOSIT DOES ──────────────────────────────────────────
// Exactly what the screen's Confirm does: POST /api/sales-receipts -> salesReceipts.addReceipt, then
// quickbooks/sync.after('receipt'). Same validation, same one-customer rule, same QuickBooks side effect. The
// receipt carries ref = the bank row's id (as the screen's does) and created_by 'jarvis-auto', so it can always be
// found, and is labelled in the note.
//
// ── IT IS ALLOWED TO BE WRONG; THAT IS WHY IT CAN BE UNDONE AND WHY IT LEARNS ──
//   undo(): deletes the receipt through the same path as DELETE /api/sales-receipts (audited, QuickBooks told),
//     marks the entry undone, and PAUSES auto-apply for that customer and that payer until she lifts it. A deposit
//     she undid is never auto-applied a second time.
//   diagnose(): after an undo, WATCH what she does with that deposit and work out what was wrong, from evidence not
//     a guess: applied to a different invoice of the same customer = wrong invoice; to a different customer = wrong
//     customer (the payer name is suspect); set aside = not our money; same invoice but a different bank or mode =
//     wrong bank/mode. No evidence yet = "not known yet"; it never invents a cause.
//
// ── LIMITS I SET, NOT HERS ───────────────────────────────────────────────
// MAX_AGE_DAYS (30): only deposits from the last month, so switching this on does not silently place a year of
// backlog in one night; older ones stay on her screen. MAX_PER_RUN (20): a runaway matcher cannot place 200 in a
// night. Both can be changed by environment variable. These are my safeguards; say so if you want them different.
//
// OFF UNLESS JARVIS_AUTO_APPLY=1. dryRun always works and writes nothing.
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_AGE_DAYS = () => Number(process.env.JARVIS_AUTO_APPLY_MAX_AGE_DAYS) || 30;
const MAX_PER_RUN = () => Number(process.env.JARVIS_AUTO_APPLY_MAX_PER_RUN) || 20;
const MAX_ASKS = () => Number(process.env.JARVIS_AUTO_APPLY_MAX_ASKS) || 8;
const CENT = 0.005;

const on = () => process.env.JARVIS_AUTO_APPLY === '1';
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const day = (s) => String(s || '').slice(0, 10);
const money = (n) => '$' + round2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function file() {
    return process.env.JARVIS_AUTO_APPLIED_FILE || path.join(require('../config').DATA_DIR, 'auto_applied.json');
}
function read() {
    const j = require('./json');
    const d = j.loadJson(file(), { entries: [], blocks: [], asks: [] });
    return { entries: Array.isArray(d.entries) ? d.entries : [], blocks: Array.isArray(d.blocks) ? d.blocks : [], asks: Array.isArray(d.asks) ? d.asks : [] };
}
// Strict: a lost write here means a receipt with no record of why, or an undo that did not stick.
async function mutate(fn) {
    const j = require('./json');
    return j.mutateJson(file(), { entries: [], blocks: [], asks: [] }, (d) => {
        d.entries = Array.isArray(d.entries) ? d.entries : []; d.blocks = Array.isArray(d.blocks) ? d.blocks : []; d.asks = Array.isArray(d.asks) ? d.asks : [];
        return fn(d) || d;
    }, { strict: true });
}

const newId = () => 'aa_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
// Four characters she can type in WhatsApp. Unambiguous letters only.
const codeFor = (id) => {
    const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let h = 0;
    for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    let s = ''; for (let i = 0; i < 4; i++) { s += a[h % a.length]; h = Math.floor(h / a.length) + 7; }
    return s;
};

// The invoice as a person reads it: the label is "LT-2 · 2026-10-26 · Auto Cast" or "LT-2 (Auto Cast)"; keep the first part.
const labelOf = (a) => String((a && a.label) || '').split(' · ')[0].split(' (')[0].trim() || 'the invoice';

// Same reading of the bank line the screen uses (bulkable()).
function modeFrom(descriptor, modes) {
    const d = String(descriptor || '');
    const m = /\bZELLE\b/i.test(d) ? 'Zelle' : (/\bWIRE\b/i.test(d) ? 'Wire' : null);
    return m && (modes || []).includes(m) ? m : null;
}

function isBlocked(state, customer, payer) {
    const c = norm(customer), p = norm(payer);
    return state.blocks.find((b) => !b.lifted && ((c && norm(b.customer) === c) || (p && b.payer && norm(b.payer) === p))) || null;
}

// ── THE DESCRIPTION, NOT ONLY THE AMOUNT AND THE NAME ────────────────────
// Apsara, 2026-11-09: "It needs to look at the deposit and the description as well. If unsure, always ask."
// An exact amount from a known payer is not enough: the bank line can say it is a refund, an advance, a part payment,
// or name a DIFFERENT invoice or a different customer. Any such doubt means it does not place the deposit; it asks.
// Returns { doubts:[...], confirms:[...] }. Pure.
const DOUBT_WORDS = /\b(refund(?:ed)?|return(?:ed)?|revers(?:al|ed)|charge ?back|rejected|nsf|credit memo|advance|prepay(?:ment)?|down ?payment|partial|part[- ]payment|on account|balance of|deduct(?:ion|ed)?|claim|short ?pay|loan|interest|own account|inter-?company|duplicate|dup|test)\b/i;
function descriptionDoubts(row, sales) {
    const dep = row.deposit || {};
    const text = [dep.descriptor, dep.desc, dep.memo, row.bank_text].filter(Boolean).join(' | ');
    const doubts = [], confirms = [];
    const w = text.match(DOUBT_WORDS);
    if (w) doubts.push(`the bank description says "${w[1]}"`);
    const low = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
    const has = (ref) => { const r = String(ref || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); return r.length >= 4 && (' ' + low + ' ').includes(' ' + r + ' '); };
    const p = (row.proposals || [])[0]; const a = p && (p.allocations || [])[0];
    const mine = (sales || []).find((x) => a && x.id === a.doc_id) || null;
    for (const sl of (sales || [])) {
        if (mine && sl.id === mine.id) continue;
        const hit = [sl.invoice_no, sl.container_no, sl.booking_no].find(has);
        if (hit) doubts.push(`the description names ${hit}, which is a different invoice from the one I would pay`);
    }
    if (mine) { const hit = [mine.invoice_no, mine.container_no, mine.booking_no].find(has); if (hit) confirms.push(`the bank line itself names ${hit}`); }
    const party = norm(row.party);
    const others = new Set();
    for (const sl of (sales || [])) { const c = norm(sl.customer); if (c && c.length >= 5 && c !== party && !party.includes(c) && !c.includes(party)) others.add(c); }
    for (const c of others) if ((' ' + low + ' ').includes(' ' + c + ' ')) doubts.push(`the description also names ${c}`);
    return { doubts: [...new Set(doubts)], confirms };
}

// → { ok:true, mode, reasons[] } | { ok:false, why, hard? }   (hard = not hers to ask about: handled, too old, future)
function eligible(row, { state, receipts, modes, sales = [], now = Date.now() }) {
    const dep = row && row.deposit;
    if (!dep || !dep.id) return { ok: false, why: 'no deposit' };
    const p = (row.proposals || [])[0];
    if (row.outcome !== 'proposed' || !p) return { ok: false, why: 'no clear proposal' };
    if (row.ambiguous) return { ok: false, why: 'more than one fits' };
    if (row.truncated) return { ok: false, why: 'search was cut short' };
    if ((p.allocations || []).length !== 1) return { ok: false, why: 'pays more than one invoice' };
    if (!(p.score >= 0.95)) return { ok: false, why: `confidence ${p.score} is under 0.95` };
    const a = p.allocations[0];
    if (a.shortfall || !a.clears) return { ok: false, why: 'does not pay the invoice in full' };
    if (Math.abs(round2(a.amount) - round2(dep.amount)) > CENT) return { ok: false, why: 'not equal to the deposit to the cent' };
    if (!row.party) return { ok: false, why: 'payer not matched to a customer' };
    if (row.claim_hint) return { ok: false, why: 'looks like a customer claim' };
    if (!dep.bank_guess) return { ok: false, why: 'bank account unknown' };
    const mode = modeFrom(dep.descriptor || dep.desc, modes);
    if (!mode) return { ok: false, why: 'the bank line does not say WIRE or ZELLE' };
    const age = (now - Date.parse(day(dep.date) + 'T12:00:00Z')) / 864e5;
    if (!isFinite(age) || age > MAX_AGE_DAYS()) return { ok: false, hard: true, why: `older than ${MAX_AGE_DAYS()} days — left for her screen` };
    if (age < -1) return { ok: false, hard: true, why: 'dated in the future' };
    if (state.entries.some((e) => e.depositId === dep.id)) return { ok: false, hard: true, why: 'already handled (applied or undone)' };
    if ((receipts || []).some((r) => r && r.ref === dep.id)) return { ok: false, hard: true, why: 'a receipt already exists for this deposit' };
    const blk = isBlocked(state, row.party, row.payer || dep.descriptor);
    if (blk) return { ok: false, why: `paused for ${blk.customer} since she undid one` };
    const dd = descriptionDoubts(row, sales);
    if (dd.doubts.length) return { ok: false, doubt: true, why: 'not sure — ' + dd.doubts.join('; ') };
    const reasons = [];
    reasons.push(`the payer "${String(dep.descriptor || dep.desc || '').trim().slice(0, 60)}" is ${row.party}, a name already matched`);
    for (const r of (p.reasons || [])) reasons.push(r);
    reasons.push(`pays ${labelOf(a)} in full`);
    reasons.push(`${mode} into ${dep.bank_guess}`);
    for (const c of dd.confirms) reasons.push(c);
    reasons.push('nothing in the bank description argues against it');
    reasons.push(`confidence ${Math.round(p.score * 100)}%`);
    return { ok: true, mode, reasons, alloc: a, score: p.score };
}

// Places ONE deposit exactly as the screen's Confirm would. Shared by the nightly run (by 'jarvis') and by her "yes <CODE>"
// answer to a question (by 'her'). Returns { entry } or { error }.
async function place({ dep, party, alloc, mode, reasons, score, sale, by = 'jarvis', now = Date.now(), state = null }) {
    const entry = {
        id: newId(), depositId: dep.id, customer: party, payer: String(dep.descriptor || dep.desc || '').slice(0, 120),
        amount: round2(dep.amount), date: dep.date, mode, bank: dep.bank_guess,
        saleId: alloc.doc_id, invoice_no: (sale || {}).invoice_no || null, container_no: (sale || {}).container_no || null, booking_no: (sale || {}).booking_no || null,
        reasons, score, appliedAt: new Date(now).toISOString(), receiptId: null,
        reported: by === 'her', undone: null, diagnosis: null, placedBy: by,
    };
    entry.code = codeFor(entry.id);
    const sr = require('./salesReceipts');
    try {
        const rec = await sr.addReceipt({ date: dep.date, amount: dep.amount, mode, bank: dep.bank_guess, customer: party,
            ref: dep.id, note: (by === 'her' ? 'applied by Jarvis on her yes (' : 'applied automatically by Jarvis (') + entry.code + ')',
            allocations: [{ sale_id: alloc.doc_id, amount: alloc.amount }], created_by: 'jarvis-auto' });
        entry.receiptId = rec && rec.id;
        try { require('./quickbooks/sync').after('receipt', entry.receiptId); } catch (err) { /* same as the route: a sync that cannot run does not undo the receipt */ }
        try {
            await require('./audit').record({ action: 'auto-apply-deposit', subject: entry.receiptId, actor: by === 'her' ? 'her (answered a question)' : 'jarvis-auto', role: 'system',
                detail: { deposit: dep.id, customer: party, amount: entry.amount, sale: entry.saleId, reasons } });
        } catch (err) { /* the entry below is the record of why; the audit line is the second copy */ }
        await mutate((d) => { d.entries.push(entry); });
        if (state) state.entries.push(entry);
        return { entry };
    } catch (err) { return { error: String(err && err.message || err) }; }
}

// A deposit it is NOT sure about becomes a QUESTION (Apsara: "if unsure, always ask"), once per deposit, never silently dropped.
function makeAsk(row, e, now) {
    const dep = row.deposit; const p = (row.proposals || [])[0]; const a = p && (p.allocations || []).length === 1 ? p.allocations[0] : null;
    const proposal = a && a.clears && !a.shortfall && dep.bank_guess && modeFrom(dep.descriptor || dep.desc, ['Wire', 'Zelle'])
        ? { docId: a.doc_id, amount: round2(a.amount), label: labelOf(a), mode: modeFrom(dep.descriptor || dep.desc, ['Wire', 'Zelle']), bank: dep.bank_guess, score: p.score, reasons: p.reasons || [] } : null;
    const id = 'aq_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    return { id, code: codeFor(id), depositId: dep.id, customer: row.party || null, amount: round2(dep.amount), date: dep.date,
        descriptor: String(dep.descriptor || dep.desc || '').slice(0, 120), why: e.why, proposal, askedAt: new Date(now).toISOString(), reported: false, answer: null };
}

// → { applied:[entry], skipped:[{deposit, why}], asked:[ask], failed:[{deposit, error}], dryRun, off? }
async function run({ dryRun = false, now = Date.now(), proposals = null } = {}) {
    if (!dryRun && !on()) return { applied: [], skipped: [], asked: [], failed: [], dryRun: false, off: true };
    const out = { applied: [], skipped: [], asked: [], failed: [], dryRun: !!dryRun };
    const props = proposals || await require('./bankMatchRoutes').depositProposals({ ai: false });
    const sr = require('./salesReceipts');
    const state = read();
    const receipts = sr.list();
    const modes = sr.RECEIPT_MODES;
    const sales = require('./sales').list();
    let n = 0, nAsk = 0;
    const taken = new Set();   // invoices this run has already paid: a second deposit proposing the same one is hers (a duplicate or an overpayment)
    for (const row of (props.rows || [])) {
        const e = eligible(row, { state, receipts, modes, sales, now });
        const askable = (why) => !e.hard && row && row.deposit && row.outcome === 'proposed' && !state.asks.some((q) => q.depositId === row.deposit.id) && why !== null;
        const ask = async (why) => {
            if (!askable(why)) return;
            if (nAsk >= MAX_ASKS()) { out.skipped.push({ deposit: row.deposit.id, why: why + ' (more questions than I send in one day; it is on the Bank page)' }); return; }
            const q = makeAsk(row, { ...e, why }, now); nAsk++; out.asked.push(q);
            if (!dryRun) { await mutate((d) => { d.asks.push(q); }); state.asks.push(q); }
        };
        if (!e.ok) { if (row && row.deposit) out.skipped.push({ deposit: row.deposit.id, why: e.why }); await ask(e.why); continue; }
        if (n >= MAX_PER_RUN()) { out.skipped.push({ deposit: row.deposit.id, why: `more than ${MAX_PER_RUN()} in one run — the rest wait` }); continue; }
        if (taken.has(e.alloc.doc_id)) { const why = 'another deposit in this run already paid that invoice'; out.skipped.push({ deposit: row.deposit.id, why }); await ask(why); continue; }
        const dep = row.deposit;
        const sale = sales.find((s) => s.id === e.alloc.doc_id) || {};
        if (dryRun) { out.applied.push({ depositId: dep.id, customer: row.party, amount: round2(dep.amount), reasons: e.reasons, invoice_no: sale.invoice_no || null, saleId: e.alloc.doc_id }); n++; continue; }
        const r = await place({ dep, party: row.party, alloc: e.alloc, mode: e.mode, reasons: e.reasons, score: e.score, sale, by: 'jarvis', now, state });
        if (r.error) { out.failed.push({ deposit: dep.id, error: r.error }); continue; }
        receipts.push({ ref: dep.id }); taken.add(e.alloc.doc_id); out.applied.push(r.entry); n++;
    }
    return out;
}

// Her "yes <CODE>" to a question. Re-checks the world first: it asked hours ago.
async function confirmAsk(code, { by = 'her', now = Date.now() } = {}) {
    const st = read(); const q = st.asks.find((x) => String(x.code).toLowerCase() === String(code).toLowerCase());
    if (!q) return { ok: false, error: 'no such question' };
    if (q.answer) return { ok: false, error: 'you already answered that one (' + q.answer.kind + ')' };
    if (!q.proposal) return { ok: false, error: 'I had no single invoice to suggest for that one — place it from the Bank page' };
    const sr = require('./salesReceipts');
    if (st.entries.some((e) => e.depositId === q.depositId) || sr.list().some((r) => r.ref === q.depositId)) return { ok: false, error: 'that deposit has been dealt with since I asked' };
    const sale = require('./sales').listWithTotals().find((x) => x.id === q.proposal.docId);
    if (!sale || Math.abs(round2(sale.balance) - q.proposal.amount) > CENT) return { ok: false, error: 'that invoice has changed since I asked (it no longer owes exactly this amount) — use the Bank page' };
    const dep = { id: q.depositId, amount: q.amount, date: q.date, descriptor: q.descriptor, bank_guess: q.proposal.bank };
    const r = await place({ dep, party: q.customer, alloc: { doc_id: q.proposal.docId, amount: q.proposal.amount }, mode: q.proposal.mode,
        reasons: [`you said yes when I asked (I was unsure: ${q.why})`, ...(q.proposal.reasons || [])], score: q.proposal.score, sale, by: 'her', now });
    if (r.error) return { ok: false, error: r.error };
    await mutate((d) => { const x = d.asks.find((y) => y.id === q.id); if (x) x.answer = { kind: 'yes', at: new Date(now).toISOString(), by, entry: r.entry.id }; });
    try { const oc = require('./outcomes'); oc.recordDecision({ ref: 'auto-ask:' + q.id, surfaced: true, source: 'deposit-auto-apply' }); oc.recordOutcome({ ref: 'auto-ask:' + q.id, outcome: oc.OUTCOMES.APPROVED, by, detail: q.why }); } catch (e) { /* learning is best effort */ }
    return { ok: true, entry: r.entry, ask: q };
}
async function declineAsk(code, { by = 'her', now = Date.now() } = {}) {
    const st = read(); const q = st.asks.find((x) => String(x.code).toLowerCase() === String(code).toLowerCase());
    if (!q) return { ok: false, error: 'no such question' };
    if (q.answer) return { ok: false, error: 'you already answered that one (' + q.answer.kind + ')' };
    await mutate((d) => { const x = d.asks.find((y) => y.id === q.id); if (x) x.answer = { kind: 'no', at: new Date(now).toISOString(), by }; });
    try { const oc = require('./outcomes'); oc.recordDecision({ ref: 'auto-ask:' + q.id, surfaced: true, source: 'deposit-auto-apply' }); oc.recordOutcome({ ref: 'auto-ask:' + q.id, outcome: oc.OUTCOMES.DECLINED, by, detail: q.why }); } catch (e) { /* best effort */ }
    return { ok: true, ask: q };
}

// She presses Undo. Returns { ok, entry } or { ok:false, error }.
async function undo(idOrCode, { by = 'her', reason = null } = {}) {
    const state = read();
    const key = String(idOrCode || '').trim();
    const entry = state.entries.find((e) => e.id === key || String(e.code).toLowerCase() === key.toLowerCase());
    if (!entry) return { ok: false, error: 'no such automatic deposit' };
    if (entry.undone) return { ok: false, error: 'already undone', already: true };
    const sr = require('./salesReceipts');
    const rec = sr.list().find((r) => r.id === entry.receiptId);
    // ONLY what Jarvis itself placed. This path must never become a way to delete an arbitrary receipt: the receipt has to be
    // the one this entry made, and say so (created_by), or nothing is removed.
    if (rec && (rec.created_by !== 'jarvis-auto' || rec.ref !== entry.depositId)) return { ok: false, error: 'that receipt was not placed automatically — remove it from the receipts screen' };
    let auditEntry = null;
    try {
        if (rec) {
            const audit = require('./audit');
            auditEntry = await audit.record({ action: 'undo-auto-apply-deposit', subject: rec.id, actor: by, role: 'admin',
                detail: { company: 'edge-metals', customer: rec.customer, amount: rec.amount, allocations: rec.allocations || [], deposit: entry.depositId, reason } });
            await sr.deleteReceipt(rec.id);
            try { require('./quickbooks/sync').after('receipt', rec.id, 'deleted'); } catch (e) { /* as the route */ }
            await audit.complete(auditEntry, 'done', { containers_reopened: (rec.allocations || []).length });
        }
    } catch (e) { return { ok: false, error: 'could not remove the receipt: ' + e.message }; }
    const at = new Date().toISOString();
    await mutate((d) => {
        const x = d.entries.find((y) => y.id === entry.id); if (!x) return;
        x.undone = { at, by, reason: reason ? String(reason).slice(0, 200) : null, receiptWasThere: !!rec };
        d.blocks.push({ id: 'blk_' + Date.now().toString(36), customer: entry.customer, payer: entry.payer, entryId: entry.id, at, lifted: null,
            why: 'she undid ' + money(entry.amount) + ' (' + entry.code + ')' });
    });
    // The signal the learning loop already reads: a decision she corrected. Never blocks the undo.
    try {
        const oc = require('./outcomes');
        oc.recordDecision({ ref: 'auto-apply:' + entry.id, surfaced: true, source: 'deposit-auto-apply' });
        oc.recordOutcome({ ref: 'auto-apply:' + entry.id, outcome: oc.OUTCOMES.CORRECTED, by, said: reason || null, detail: 'undid an automatic deposit placement' });
    } catch (e) { /* learning is best effort */ }
    return { ok: true, entry: read().entries.find((e) => e.id === entry.id) };
}

// Lift the pause on a customer (her word). Returns number lifted.
async function lift(customer, { by = 'her' } = {}) {
    let n = 0; const at = new Date().toISOString();
    await mutate((d) => { for (const b of d.blocks) if (!b.lifted && norm(b.customer) === norm(customer)) { b.lifted = { at, by }; n++; } });
    return n;
}

// ── WORKING OUT WHAT WAS WRONG, FROM WHAT SHE DID NEXT ───────────────────
// Evidence only. The deposit's bank row id is the thread: whatever she did with that row after the undo says what the
// automatic placement got wrong. `now` and the stores are injectable for tests.
function diagnoseOne(entry, { receipts, bankRows, now = Date.now(), waitDays = 14 }) {
    const after = Date.parse(entry.undone.at);
    const mine = (receipts || []).filter((r) => r && r.ref === entry.depositId && r.id !== entry.receiptId && Date.parse(r.created_at || r.at || now) >= after - 1000);
    if (mine.length) {
        const r = mine[0];
        const sameCust = norm(r.customer) === norm(entry.customer);
        const sales = (r.allocations || []).map((a) => a.sale_id);
        if (!sameCust) return { kind: 'wrong_customer', detail: `she placed it with ${r.customer}, not ${entry.customer} — the payer name "${entry.payer}" is suspect` };
        if (sales.length && !sales.includes(entry.saleId)) return { kind: 'wrong_invoice', detail: `she placed it on a different ${entry.customer} invoice (${sales.join(', ')}), not ${entry.invoice_no || entry.saleId}` };
        if (norm(r.mode) !== norm(entry.mode) || norm(r.bank) !== norm(entry.bank)) return { kind: 'wrong_bank_or_mode', detail: `same invoice, but she recorded ${r.mode}${r.bank ? ' into ' + r.bank : ''} instead of ${entry.mode} into ${entry.bank}` };
        return { kind: 'same_again', detail: 'she placed it exactly as Jarvis had — the undo may have been a slip or a change of mind' };
    }
    const row = (bankRows || []).find((b) => b && b.id === entry.depositId);
    if (row && row.excluded) return { kind: 'not_ours', detail: 'she set the deposit aside — it was not customer money for this company' };
    if (entry.undone.reason) return { kind: 'her_reason', detail: entry.undone.reason };
    if (now - after > waitDays * 864e5) return { kind: 'unknown', detail: `no sign of what she did with it after ${waitDays} days` };
    return null;   // nothing to conclude yet
}

// Records a diagnosis for every undone entry that has evidence. Returns the new ones.
async function diagnose({ now = Date.now(), receipts = null, bankRows = null } = {}) {
    const state = read();
    // A reason she typed is PROVISIONAL (kind 'her_reason'): what she then does with the deposit is evidence, and evidence wins.
    const todo = state.entries.filter((e) => e.undone && (!e.diagnosis || e.diagnosis.kind === 'her_reason'));
    if (!todo.length) return [];
    const rc = receipts || require('./salesReceipts').list();
    let br = bankRows; if (!br) { try { br = require('./bankLedger').list(); } catch (e) { br = []; } }
    const found = [];
    for (const e of todo) { const d = diagnoseOne(e, { receipts: rc, bankRows: br, now }); if (d && !(e.diagnosis && e.diagnosis.kind === d.kind)) found.push([e.id, d]); }
    if (!found.length) return [];
    const at = new Date(now).toISOString();
    await mutate((d) => { for (const [id, dx] of found) { const x = d.entries.find((y) => y.id === id); if (x) x.diagnosis = { ...dx, at, reported: false }; } });
    return found.map(([id, dx]) => ({ id, ...dx }));
}

// The daily message. null when there is nothing to say (no noise on a quiet day).
function dailyText({ now = Date.now() } = {}) {
    const st = read();
    const fresh = st.entries.filter((e) => !e.reported && e.receiptId);
    const news = st.entries.filter((e) => e.diagnosis && !e.diagnosis.reported);
    const newAsks = st.asks.filter((q) => !q.reported && !q.answer);
    if (!fresh.length && !news.length && !newAsks.length) return null;
    const L = [];
    if (fresh.length) {
        L.push(`Deposits I applied by myself (${fresh.length}, ${money(fresh.reduce((t, e) => t + e.amount, 0))}):`);
        for (const e of fresh) {
            const inv = [e.invoice_no, e.container_no, e.booking_no].filter(Boolean).join(' / ') || e.saleId;
            L.push(`• ${money(e.amount)} from ${e.customer} (${e.date}) → ${inv}`);
            L.push(`  Why: ${e.reasons.join('; ')}.`);
            L.push(`  Wrong? Reply "undo ${e.code}" or press Undo on the Bank page.`);
        }
    }
    if (news.length) {
        L.push(fresh.length ? '' : null);
        L.push('What I learned from your undos:');
        for (const e of news) {
            const t = { wrong_customer: 'I will ask for every deposit from that payer', wrong_invoice: `I stay paused for ${e.customer} and ask each time`,
                wrong_bank_or_mode: 'I keep asking for this customer until you lift the pause', not_ours: 'I will stop treating that payer as a customer', same_again: 'I stay paused until you say otherwise',
                her_reason: 'I stay paused until you say otherwise', unknown: 'I stay paused until you say otherwise' }[e.diagnosis.kind] || '';
            L.push(`• ${e.customer} ${money(e.amount)} (${e.code}): ${e.diagnosis.detail}. ${t}.`);
        }
    }
    if (newAsks.length) {
        L.push(fresh.length || news.length ? '' : null);
        L.push(`Not sure about ${newAsks.length} deposit${newAsks.length === 1 ? '' : 's'} — I did not place ${newAsks.length === 1 ? 'it' : 'them'}, please tell me:`);
        for (const q of newAsks) {
            L.push(`• ${money(q.amount)}${q.customer ? ' from ' + q.customer : ''} (${q.date}): ${q.why}.`);
            L.push(q.proposal ? `  My best guess: pay ${q.proposal.label || 'the invoice'} in full. Reply "yes ${q.code}" to place it, or "no ${q.code}" to leave it for the Bank page.`
                : '  I had no single invoice to suggest — please place it from the Bank page.');
        }
    }
    const paused = [...new Set(st.blocks.filter((b) => !b.lifted).map((b) => b.customer))];
    if (paused.length) L.push(`Paused (I ask instead): ${paused.join(', ')}. Say "resume auto deposits for <name>" to lift.`);
    return L.filter((x) => x !== null).join('\n');
}

async function markReported() {
    await mutate((d) => { for (const e of d.entries) { if (e.receiptId) e.reported = true; if (e.diagnosis) e.diagnosis.reported = true; } for (const q of d.asks) q.reported = true; });
}

// One nightly pass: learn from undos, place what is certain, tell her. Never throws.
async function runDaily({ sendToManager, now = Date.now(), proposals = null } = {}) {
    if (!on()) return { off: true };
    const res = { diagnosed: [], run: null, sent: false };
    try { res.diagnosed = await diagnose({ now }); } catch (e) { console.error('[AUTO-APPLY] diagnose:', e.message); }
    try { res.run = await run({ now, proposals }); } catch (e) { console.error('[AUTO-APPLY] run:', e.message); res.run = { applied: [], failed: [{ error: e.message }] }; }
    try {
        const text = dailyText({ now });
        const bad = ((res.run && res.run.failed) || []).length;
        const msg = [text, bad ? `Could not place ${bad} deposit(s): ${res.run.failed.map((f) => f.error).slice(0, 2).join('; ')}. They are still on the Bank page.` : null].filter(Boolean).join('\n');
        if (msg && typeof sendToManager === 'function') { await sendToManager(msg); res.sent = true; if (text) await markReported(); }
    } catch (e) { console.error('[AUTO-APPLY] report:', e.message); }
    return res;
}

function list() { return read(); }

module.exports = { run, undo, lift, confirmAsk, declineAsk, diagnose, diagnoseOne, dailyText, runDaily, markReported, eligible, descriptionDoubts, list, on, codeFor, MAX_AGE_DAYS, MAX_PER_RUN, MAX_ASKS };
