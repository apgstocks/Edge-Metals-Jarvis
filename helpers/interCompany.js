// ── helpers/interCompany.js — money moving between her own companies ──────
//
// Apsara, 2026-10-09: "Transfers between Edge Metals and Edge Yard (chase
// bank) are recognised as transfers between your own companies, never as
// income so as AAA investment." Asked loan or owner's transfer: "put it as
// loan for now" — her CPA decides later.
//
// So this file does two things and only two:
//
//   detect()  — PURE. Reads bank rows and proposes pairs: money leaving one
//               of her companies and the same amount arriving in another
//               within a few days. Proposes; never records.
//   record()  — writes one transfer she confirmed, treated as a LOAN, and
//               ticks the bank row(s) it explains so they leave the queue.
//
// booksBuild posts each record as 'inter-company-loan' (postings.js): on the
// lender's books Dr 1400 Due from related companies / Cr its bank, on the
// borrower's Dr its bank / Cr 2400 Due to related companies. Both or neither
// — postings.js refuses half of it, because a one-sided inter-company entry
// unbalances two companies at once.
//
// ── WHY "LOAN" IS STORED ON EVERY RECORD ─────────────────────────────────
// `treatment: 'loan'` is written per row rather than assumed by the poster.
// When her CPA says some of these were owner contributions instead, each
// record can be re-treated without guessing which ones were decided when.
// That the default is a loan is HER call (quoted above), not mine.

const path = require('path');
const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');
const E = require('./entities');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const day = (d) => String(d || '').slice(0, 10);
const CENT = 0.005;

function FILE() { return process.env.INTER_COMPANY_FILE || path.join(cfg.DATA_DIR, 'inter-company.json'); }

const TREATMENTS = ['loan'];

// ── which company a bank row belongs to ──────────────────────────────────
// row.company is stamped at ingest from qb-settings/bank-accounts.json. A row
// with no company is NOT guessed into one — it is left out of detection, the
// same rule /api/bank/match follows for unknown accounts.
function entityOfRow(row) {
    return row && row.company ? E.resolve(row.company) : null;
}

// ── a sister company named in the bank's description ─────────────────────
// Used only for ONE-SIDED proposals (the other company's account is not in
// the feed, which is AAA today). Deliberately narrow: bare "AAA" is the
// motoring club as often as it is her company, so AAA must be followed by
// INV. A miss here costs a manual tick; a false hit would call a customer's
// money a loan.
const NAMED = [
    ['edge-metals', /\bEDGE\s*METALS?\b/i],
    ['edge-trading', /\bEDGE\s*(?:TRADING|YARD)\b/i],
    ['aaa-investment', /\bAAA\s*INV/i],
];
function sisterNamed(text, notThis) {
    const s = String(text || '');
    const hits = NAMED.filter(([id, re]) => id !== notThis && re.test(s)).map(([id]) => id);
    return hits.length === 1 ? hits[0] : null;   // two named = cannot tell which
}

const moneyOf = (r) => r2(r.direction === 'out' ? num(r.spent) : num(r.received));
const daysApart = (a, b) => Math.abs((Date.parse(day(a)) - Date.parse(day(b))) / 86400000);
const linked = (r) => !!(r && r.matched && (r.matched.keys || []).some((k) => String(k).startsWith('transfer:')));

// ── detect ───────────────────────────────────────────────────────────────
// Returns { pairs, oneSided }.
//
// pairs: an OUT row in company A and an IN row in company B (A ≠ B), same
// amount to the cent, within `windowDays`. If an out row has two in rows that
// fit equally well, NEITHER is proposed as sure — `rivals` says why, and the
// screen asks. Picking one would be a coin toss with money on it.
//
// oneSided: a row whose description names a sister company and that has no
// partner in the feed. Proposed, never sure.
function detect(rows, { windowDays = 5 } = {}) {
    const live = (rows || []).filter((r) => r && !r.pending && !r.excluded && !r.matched
        && moneyOf(r) > CENT && entityOfRow(r));
    const outs = live.filter((r) => r.direction === 'out');
    const ins = live.filter((r) => r.direction === 'in');

    const pairs = [];
    const usedIn = new Set();
    const usedOut = new Set();

    // Closest dates first, so two transfers of the same amount on different
    // days pair with their own partners rather than crosswise.
    const cands = [];
    for (const o of outs) {
        const eo = entityOfRow(o);
        for (const i of ins) {
            const ei = entityOfRow(i);
            if (ei === eo) continue;
            if (Math.abs(moneyOf(o) - moneyOf(i)) >= CENT) continue;
            const gap = daysApart(o.date, i.date);
            if (!(gap <= windowDays)) continue;
            cands.push({ o, i, gap, eo, ei });
        }
    }
    cands.sort((a, b) => a.gap - b.gap || String(a.o.id).localeCompare(String(b.o.id)));

    for (const c of cands) {
        if (usedOut.has(c.o.id) || usedIn.has(c.i.id)) continue;
        // A rival is another unused partner for either leg at the SAME gap.
        const rivals = cands.filter((x) => x !== c && x.gap === c.gap
            && ((x.o.id === c.o.id && !usedIn.has(x.i.id)) || (x.i.id === c.i.id && !usedOut.has(x.o.id))));
        const reasons = [
            `${E.get(c.eo).uiName} sent $${moneyOf(c.o).toLocaleString('en-US', { minimumFractionDigits: 2 })} and ${E.get(c.ei).uiName} received the same amount`,
            c.gap === 0 ? 'on the same day' : `${c.gap} day${c.gap === 1 ? '' : 's'} apart`,
        ];
        if (sisterNamed(c.o.desc || c.o.party, c.eo) === c.ei || sisterNamed(c.i.desc || c.i.party, c.ei) === c.eo) {
            reasons.push('the bank description names the other company');
        }
        if (rivals.length) reasons.push(`${rivals.length} other row(s) fit just as well — check which is the partner`);
        pairs.push({
            id: `pair:${c.o.id}|${c.i.id}`,
            from: c.eo, to: c.ei, amount: moneyOf(c.o),
            date: day(c.o.date) <= day(c.i.date) ? day(c.o.date) : day(c.i.date),
            out_row: slim(c.o), in_row: slim(c.i),
            sure: rivals.length === 0,
            reasons,
        });
        usedOut.add(c.o.id); usedIn.add(c.i.id);
    }

    const oneSided = [];
    for (const r of live) {
        if (usedOut.has(r.id) || usedIn.has(r.id)) continue;
        const mine = entityOfRow(r);
        const other = sisterNamed(`${r.desc || ''} ${r.party || ''}`, mine);
        if (!other) continue;
        const outward = r.direction === 'out';
        oneSided.push({
            id: `one:${r.id}`,
            from: outward ? mine : other, to: outward ? other : mine,
            amount: moneyOf(r), date: day(r.date),
            out_row: outward ? slim(r) : null, in_row: outward ? null : slim(r),
            sure: false,
            reasons: [`the bank description names ${E.get(other).uiName}`,
                `${E.get(other).uiName}'s side is not in the bank feed, so only this half can be seen`],
        });
    }
    return { pairs, oneSided };
}

function slim(r) {
    return { id: r.id, date: day(r.date), amount: moneyOf(r), direction: r.direction,
        desc: r.desc || r.party || '', company: r.company || null, bank: r.bank || null,
        account_id: r.account_id || null };
}

// ── the bank account code each side moves ────────────────────────────────
// From the bank row when there is one — that is a fact — else the company's
// own bank from entities.js. postings.bankAccount maps both.
function bankCodeFor(entityId, row) {
    const P = require('./postings');
    const fromRow = row && row.bank ? P.bankAccount({ bank: row.bank }) : null;
    if (fromRow) return fromRow;
    const e = E.get(entityId);
    return e && e.banks && e.banks[0] ? P.bankAccount({ bank: e.banks[0] }) : null;
}

// ── validate one confirmation against the live rows ──────────────────────
// Pure: the route calls it with ledger.list() and the store. Throws a sentence
// she can act on. Every check here is a way a wrong loan would otherwise get
// onto two companies' books at once.
function plan(input, rows, existing = []) {
    const b = input || {};
    const from = String(b.from || ''), to = String(b.to || '');
    if (!E.get(from) || !E.get(to)) throw new Error('both companies must be one of Edge Metals, Edge Yard or AAA Investment');
    if (from === to) throw new Error('a transfer inside one company is not a loan between companies');
    const treatment = String(b.treatment || 'loan');
    if (!TREATMENTS.includes(treatment)) throw new Error(`"${treatment}" is not a treatment Jarvis records yet — only loan`);

    const byId = new Map((rows || []).map((r) => [r.id, r]));
    const taken = new Set(existing.flatMap((t) => t.bank_rows || []));
    const outRow = b.out_id ? byId.get(String(b.out_id)) : null;
    const inRow = b.in_id ? byId.get(String(b.in_id)) : null;
    if (b.out_id && !outRow) throw new Error('the money-out row is not in the bank feed any more — reload');
    if (b.in_id && !inRow) throw new Error('the money-in row is not in the bank feed any more — reload');
    if (!outRow && !inRow) throw new Error('a transfer needs at least one bank row behind it');

    for (const [r, dir, who] of [[outRow, 'out', from], [inRow, 'in', to]]) {
        if (!r) continue;
        if (taken.has(r.id) || linked(r)) throw new Error('that bank row is already recorded as a transfer');
        if (r.matched) throw new Error('that bank row is already matched to something else — undo that first');
        if (r.direction !== dir) throw new Error(`the ${dir === 'out' ? 'sending' : 'receiving'} row is money ${r.direction}, not ${dir}`);
        const ent = entityOfRow(r);
        if (ent !== who) {
            throw new Error(`that ${dir === 'out' ? 'sending' : 'receiving'} row is in `
                + `${ent ? E.get(ent).uiName : 'an account with no company'}'s account, not ${E.get(who).uiName}'s`);
        }
    }
    const amount = r2(outRow ? moneyOf(outRow) : moneyOf(inRow));
    if (outRow && inRow && Math.abs(moneyOf(outRow) - moneyOf(inRow)) >= CENT) {
        throw new Error('the two sides are different amounts, so they are not one transfer');
    }
    if (b.amount != null && Math.abs(num(b.amount) - amount) >= CENT) {
        throw new Error('the amount changed since the page loaded — reload');
    }
    const fromBank = bankCodeFor(from, outRow);
    const toBank = bankCodeFor(to, inRow);
    if (!fromBank || !toBank) throw new Error('cannot tell which bank account one side moved through');

    const date = day(outRow ? outRow.date : inRow.date);
    return {
        date, amount, from, to, treatment,
        from_bank: fromBank, to_bank: toBank,
        bank_rows: [outRow, inRow].filter(Boolean).map((r) => r.id),
        desc: [outRow, inRow].filter(Boolean).map((r) => r.desc || r.party || '').filter(Boolean).join(' / ') || null,
    };
}

// ── disk ─────────────────────────────────────────────────────────────────
function list() {
    const raw = loadJson(FILE(), { transfers: [] });
    return raw && Array.isArray(raw.transfers) ? raw.transfers : [];
}

async function record(input, { by = null } = {}) {
    const ledger = require('./bankLedger');
    const p = plan(input, ledger.list(), list());
    const rec = { id: 'ict-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        ...p, recorded_at: new Date().toISOString(), by: by || null };
    await mutateJson(FILE(), { transfers: [] }, (all) => {
        const s = all && Array.isArray(all.transfers) ? all : { transfers: [] };
        // Re-checked inside the lock: two presses of the same button must not
        // book one transfer twice.
        if (s.transfers.some((t) => (t.bank_rows || []).some((id) => rec.bank_rows.includes(id)))) {
            throw new Error('that bank row is already recorded as a transfer');
        }
        s.transfers.push(rec);
        return s;
    }, { strict: true });
    // Tick the rows it explains. If that fails the record is taken back out,
    // so a loan never sits in the books while its bank rows still wait in the
    // queue looking unexplained.
    const done = [];
    try {
        for (const id of rec.bank_rows) {
            const row = await ledger.markMatched(id, { keys: ['transfer:' + rec.id],
                why: `transfer between ${E.get(rec.from).uiName} and ${E.get(rec.to).uiName}, recorded as a loan` },
            { by, how: 'her' });
            // markMatched swallows a failed write and hands back null; that
            // must not read as success.
            if (!row || !linked(row)) throw new Error(`bank row ${id} was not ticked`);
            done.push(id);
        }
    } catch (e) {
        for (const id of done) { try { await ledger.markMatched(id, null, { by }); } catch (x) { /* reported below */ } }
        await mutateJson(FILE(), { transfers: [] }, (s) => ({ transfers: (s.transfers || []).filter((t) => t.id !== rec.id) }));
        throw new Error('could not tick the bank rows, so nothing was recorded: ' + e.message);
    }
    return rec;
}

async function undo(id, { by = null } = {}) {
    const ledger = require('./bankLedger');
    const rec = list().find((t) => t.id === id);
    if (!rec) throw new Error('no transfer with that id');
    await mutateJson(FILE(), { transfers: [] }, (s) => ({ transfers: (s.transfers || []).filter((t) => t.id !== id) }), { strict: true });
    for (const rid of rec.bank_rows || []) {
        const row = ledger.list().find((r) => r.id === rid);
        if (row && linked(row)) await ledger.markMatched(rid, null, { by });
    }
    return rec;
}

// What booksBuild posts. Kept here so the record's shape and its posting
// change together.
function toTx(rec) {
    return {
        kind: 'inter-company-loan', entity: rec.from, borrower: rec.to,
        date: rec.date, amount: num(rec.amount),
        fromBank: rec.from_bank, toBank: rec.to_bank,
        memo: `loan to ${E.get(rec.to) ? E.get(rec.to).uiName : rec.to}`,
        source: { store: 'inter_company', id: rec.id },
    };
}

module.exports = { FILE, TREATMENTS, detect, plan, list, record, undo, toTx, entityOfRow, sisterNamed, bankCodeFor, linked };
