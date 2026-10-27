// ── helpers/bankEntries.js — a bank line she categorises, and what that books ─
//
// Apsara, 2026-10-13, on a $5 "External transfer fee": "Always set aside lines
// like this but there is no way to tell/type what it is ... it should not be
// like a real button, there should be a categoriser dropdown and post/match
// button, just like QuickBooks or even better."
//
// WHAT WAS WRONG: a withdrawal with no recorded payment behind it got the label
// "Tell Jarvis what this is" and nothing to press — the plan screen it points to
// was never built. The only action left was "set aside", which hides the line
// and books nothing, so every bank fee stayed out of the books for ever.
//
// WHAT THIS IS: the missing action. She picks an account from a list, presses
// Post, and one balanced entry is booked (Dr the account, Cr the bank), the
// bank row leaves the queue, and one press undoes it.
//
// ── DECIDED WITH HER (2026-10-13) ────────────────────────────────────────
//   · JARVIS'S BOOKS ONLY. Nothing is pushed to QuickBooks: if QuickBooks
//     already reads this bank feed, pushing would book the fee twice.
//   · COMPANY = the bank row's own company; if Jarvis cannot tell, the screen
//     asks and nothing posts until she chooses.
//
// ── WHY THE JOURNAL STAYS DERIVED ────────────────────────────────────────
// helpers/postings.js's whole design is that the journal is rebuilt from the
// stores every time. So this file does not write journal lines; it keeps ONE
// small store (data/bank-entries.json) that booksBuild reads, exactly like
// expenses or trucker bills. Undo is therefore "mark reversed": the entry stays
// in the file with who and when, and the next rebuild simply no longer has it.
//
// ── ONLY MONEY OUT, ONLY ACCOUNTS NOBODY ELSE POSTS ──────────────────────
// Money in with nothing to match stays as it was. The accounts offered are
// operating expenses and owner drawings. NOT material purchases, trucking,
// receivables, payables, advances or inter-company: each of those is created
// by a document (bill, invoice, payment) and a category pick here would book
// it a second time, or book it without the document that explains it.

const path = require('path');
const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');
const C = require('./chartOfAccounts');
const E = require('./entities');
const P = require('./postings');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const day = (d) => String(d || '').slice(0, 10);

function FILE() { return process.env.BANK_ENTRIES_FILE || path.join(cfg.DATA_DIR, 'bank-entries.json'); }
function list() { const r = loadJson(FILE(), []); return Array.isArray(r) ? r : []; }

// Offered in the dropdown. Expenses + owner drawings; see the header.
const EXTRA = new Set(['3100']);
function categories() {
    return C.ACCOUNTS
        .filter((a) => a.type === 'expense' || EXTRA.has(a.code))
        .map((a) => ({ code: a.code, name: a.name, type: a.type }))
        .sort((a, b) => a.code.localeCompare(b.code));
}
const isOffered = (code) => categories().some((c) => c.code === String(code));

// A suggestion, never a decision: the dropdown opens on it and she still
// presses Post. Only where the wording is unambiguous; otherwise null, and the
// dropdown opens on nothing (a default would be a category chosen by the
// absence of information, and 6900 would slowly fill with unclassified lines).
const SUGGEST = [
    { re: /\b(transfer fee|wire fee|service charge|monthly (service )?fee|maintenance fee|overdraft|nsf|returned item|analysis fee|account fee|ach fee)\b/i, code: '6200' },
];
function suggest(descriptor) {
    const d = String(descriptor || '');
    for (const s of SUGGEST) if (s.re.test(d)) return s.code;
    return null;
}

// The key bankOut.keyOf gives the journal line this entry produces, so the
// ledger row can be ticked against it. tests/bank-categorise.js proves it is
// the same string by building the real journal.
function keyOf(entry) {
    return ['bank_entries', entry.id, entry.bank_code, day(entry.date), r2(entry.amount).toFixed(2)].join('|');
}

// What would be booked, and why not if it cannot be. Pure.
// ── A PART OF A ROW, 2026-10-28 ──────────────────────────────────────────
// Apsara, on tying a bank row to a payment that does not quite match: "It
// should ask me to match the exact amount. just like quickbook. refer how qb
// works."
//
// QuickBooks' Find Match is multi-select with a running Difference that has
// to read zero. When it cannot be made to read zero — a wire fee eaten out of
// the payment, say — QuickBooks' Resolve Difference adds a RESOLVING
// TRANSACTION: she names the account, and the leftover is posted there as an
// adjusting entry in the general ledger. The match is then exact, and the
// books are whole rather than merely annotated.
//
// That is what `partial` is for. It means two things, together, and neither
// without the other:
//   · `amount` is a PART of the bank row, not the whole of it;
//   · the CALLER owns the row's tick, because the row is being ticked against
//     her chosen payments AND this entry at once. post() must not tick it
//     itself, or the two writers would fight over one field.
//
// Absent — which is every caller that existed before today, and there is
// exactly one, the categorise handler — this behaves to the character as it
// always did: the whole row, ticked here. The flag says "this one is the new
// shape", never "this one is the old shape"; CLAUDE.md carries the reason.
function plan(row, { account, entity = null, amount: part = null, partial = false } = {}) {
    const problems = [];
    if (!row) return { ok: false, problems: ['no such bank row'] };
    if (row.direction !== 'out' || num(row.spent) <= 0) problems.push('only money that left the bank can be categorised here');
    if (partial) {
        const want = r2(num(part));
        const whole = r2(num(row.spent));
        // A part has to BE a part. Zero is not a difference worth posting,
        // and more than the row would book money that never left the bank.
        if (!(want > 0)) problems.push('the difference to resolve has to be more than nothing');
        else if (want > whole + 0.004) {
            problems.push(`the difference (${want.toFixed(2)}) is larger than the bank line itself `
                + `(${whole.toFixed(2)}), so it cannot be a part of it`);
        }
    } else if (part != null) {
        // Guard against a caller that passes an amount and forgets the flag,
        // which would silently book the whole row instead of the part.
        problems.push('an amount was given without partial:true — refusing rather than booking the whole line');
    }
    if (row.pending) problems.push('this line is still pending at the bank — wait until it posts');
    if (row.matched) problems.push('this line is already matched or posted');
    if (row.excluded) problems.push('this line is set aside — put it back first');
    if (!account || !isOffered(account)) problems.push('pick one of the listed accounts');

    const ent = E.resolve(row.company) || (entity && E.get(entity) ? entity : null);
    if (!ent) problems.push('Jarvis cannot tell which company this bank line belongs to — choose the company');
    const bankCode = P.bankAccount({ bank: row.bank, mode: '' });
    if (!bankCode) problems.push(`cannot tell which bank "${row.bank || ''}" is, so the credit has nowhere to go`);

    const amount = partial ? r2(num(part)) : r2(num(row.spent));
    const acct = C.get(account);
    return {
        ok: problems.length === 0, problems,
        entry: problems.length ? null : {
            bank_row_id: row.id, date: day(row.date), amount, account: String(account),
            account_name: acct ? acct.name : null, entity: ent, bank: row.bank, bank_code: bankCode,
            descriptor: row.party || row.desc || '',
            // Only on a part, so an entry written before today is unchanged
            // byte for byte and booksBuild sees exactly what it always saw.
            ...(partial ? { partial: true, of: r2(num(row.spent)) } : {}),
        },
        // The two lines she is about to create, in her words, for the confirm text.
        effect: problems.length ? null : `Dr ${account} ${acct ? acct.name : ''} ${amount.toFixed(2)} / Cr ${bankCode} bank ${amount.toFixed(2)}`,
        entityFromRow: !!E.resolve(row.company),
    };
}

// Books it and ticks the bank row. If the tick fails the entry is reversed
// again, so there is never an entry with a row still asking about it.
async function post(row, { account, entity = null, by = null, note = null,
                           amount = null, partial = false } = {}) {
    const ledger = require('./bankLedger');
    const p = plan(row, { account, entity, amount, partial });
    if (!p.ok) { const e = new Error(p.problems.join('; ')); e.problems = p.problems; throw e; }
    const now = new Date().toISOString();
    let saved = null;
    await mutateJson(FILE(), [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        // One live entry per bank row: a double press must not book it twice.
        const live = rows.find((e) => e && e.bank_row_id === row.id && !e.reversed_at);
        if (live) { saved = { ...live, already: true }; return rows; }
        const id = `BE_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        saved = { id, ...p.entry, note: note ? String(note).slice(0, 200) : null, by: by || null, at: now, reversed_at: null };
        rows.push(saved);
        return rows;
    }, { strict: true });
    if (saved.already) return { entry: saved, already: true };
    // ── ON A PART, THE CALLER TICKS ─────────────────────────────────────
    // The row is being tied to her chosen payments AND to this entry in one
    // write, so ticking here would be the first of two writers to the same
    // field and the second would overwrite it. The caller reverses this entry
    // if its own tick then fails — the same undo this function does below,
    // moved to where the tick now lives.
    if (partial) return { entry: saved, already: false, ticked: false };
    try {
        await ledger.markMatched(row.id, { keys: [keyOf(saved)], why: `booked as ${saved.account} ${saved.account_name}` },
            { by: by || null, how: 'her' });
    } catch (e) {
        await reverse(saved.id, { by: 'system', why: 'could not tick the bank row' });
        throw e;
    }
    return { entry: saved, already: false, ticked: true };
}

async function reverse(entryId, { by = null, why = null } = {}) {
    let found = null;
    await mutateJson(FILE(), [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        const e = rows.find((x) => x && x.id === entryId);
        if (e && !e.reversed_at) { e.reversed_at = new Date().toISOString(); e.reversed_by = by || null; e.reversed_why = why || null; found = e; }
        return rows;
    }, { strict: true });
    return found;
}

// Undo from the bank row's side (that is what the screen has).
async function undoForRow(rowId, { by = null } = {}) {
    const ledger = require('./bankLedger');
    const live = list().find((e) => e && e.bank_row_id === rowId && !e.reversed_at);
    if (!live) return null;
    await reverse(live.id, { by, why: 'undone from the bank screen' });
    await ledger.markMatched(rowId, null, { by: by || null, how: 'her' });
    return live;
}

// Rows booksBuild turns into journal entries.
function toTxs() {
    return list().filter((e) => e && !e.reversed_at).map((e) => ({
        kind: 'bank-entry', entity: e.entity, date: e.date, amount: e.amount,
        account: e.account, bank: e.bank, party: e.descriptor || null,
        memo: `bank line categorised as ${e.account} ${e.account_name || ''}`.trim(),
        source: { store: 'bank_entries', id: e.id },
    }));
}

module.exports = { FILE, list, categories, suggest, plan, post, reverse, undoForRow, toTxs, keyOf };
