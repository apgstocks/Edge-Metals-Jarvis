// ── helpers/ledgerBulkDelete.js — clearing several rows, safely ───────────
//
// Apsara, 2026-09-29: "What if i want to delte multiple rows in bills and
// invoice". Asked what she needed to clear she said all three — a bad import,
// an old date range, and rows she picks on screen — and asked that a row with
// payments against it be REFUSED while the rest go.
//
// ── WHAT WAS THERE BEFORE ─────────────────────────────────────────────────
// deleteBill(id) and deleteSale(id): find the row, splice it out, return. No
// check of any kind, and no way back. One row at a time that is a small risk;
// multiplied by a selection it is not.
//
// Two things that makes possible, both quiet:
//
//   ORPHANED MONEY. A payment points at a bill through its allocations. Delete
//   the bill and the payment survives, allocated to an id nothing answers to.
//   The money has left the account and belongs to no container — it does not
//   show as missing anywhere, it simply stops being attached to a cost.
//
//   NO WAY BACK. The single-row path has none. A mis-click on a selection of
//   forty is forty rows to re-type from paper.
//
// So this file is plan / commit / restore, and never a bare delete.
//
// ── ALLOCATIONS, NOT A FLAT ID ────────────────────────────────────────────
// A payment reaches a bill through `allocations[].bill_id`, and a receipt
// reaches a sale through `allocations[].sale_id` — one wire can settle several
// containers. I wrote this guard the wrong way once already today, in
// scripts/bills-year-audit.js: it read `p.bill_id`, which exists nowhere in
// this codebase, so it counted zero payments everywhere and the refusal could
// never fire. A safety check that cannot trigger is worse than none, because
// it is believed. Both sides here go through the SAME helpers the ledgers use
// to compute what is paid, rather than a second reading of the same files.

const fs = require('fs');
const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

// ── AN UNREADABLE LEDGER IS NOT AN EMPTY ONE ──────────────────────────────
// helpers/json.js's loadJson CATCHES a parse failure, logs it and returns the
// default. That is the right call for a store that self-heals on the next
// write. It is the wrong one here: a corrupt bill_payments.json would come
// back as [], paidByBill() would return {}, and the guard would see no
// payments against any bill and cheerfully delete every one of them.
//
// Found by this file's own test — the check "an unreadable payments file
// stops the delete" returned a plan instead of refusing. A guard that reads
// "cannot tell" as "nothing to worry about" is the same failure as a guard
// that cannot fire.
function mustParse(file, what) {
    if (!fs.existsSync(file)) return;          // never written is genuinely empty
    try { JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { throw new Error(`${what} cannot be read (${e.message}) — refusing to delete anything until it can`); }
}

// Where removed rows go before they are removed. Not a log — the rows
// themselves, entire, so restore() can put them back exactly.
const ARCHIVE = require('path').join(require('path').dirname(cfg.BILLS_FILE), 'deleted_rows.json');

const KINDS = {
    bills: {
        file: () => cfg.BILLS_FILE,
        label: 'bill',
        list: () => require('./bills').listWithTotals(),
        // What is allocated against each id, keyed the way the ledger keys it.
        allocated: () => {
            mustParse(cfg.BILL_PAYMENTS_FILE, 'bill_payments.json');
            try { return require('./billPayments').paidByBill() || {}; }
            catch (e) { throw new Error(`cannot read bill payments, so nothing can be deleted safely: ${e.message}`); }
        },
        describe: (r) => `${r.container_no || r.id} — ${r.supplier || 'no supplier'}`,
    },
    sales: {
        file: () => cfg.SALES_FILE,
        label: 'invoice',
        list: () => require('./sales').listWithTotals(),
        allocated: () => {
            mustParse(cfg.SALES_RECEIPTS_FILE, 'sales_receipts.json');
            try {
                const sr = require('./salesReceipts');
                const got = sr.receivedBySale() || {};
                // A deduction is money too — a container settled partly by
                // credit note still has something pointing at it.
                //
                // deductedBySale() returns an OBJECT per sale,
                // { total, bank_charge, discount } — not a number. The first
                // version of this line added that object to a number, got NaN,
                // and plan()'s `Number(x) || 0` turned the NaN back into 0. So
                // an invoice settled ENTIRELY by credit note read as unpaid
                // and would have been deleted. Take .total.
                const ded = typeof sr.deductedBySale === 'function' ? (sr.deductedBySale() || {}) : {};
                const out = { ...got };
                for (const k of Object.keys(ded)) {
                    const d = ded[k];
                    const amt = Number(d && typeof d === 'object' ? d.total : d) || 0;
                    out[k] = (Number(out[k]) || 0) + amt;
                }
                return out;
            } catch (e) { throw new Error(`cannot read receipts, so nothing can be deleted safely: ${e.message}`); }
        },
        describe: (r) => `${r.container_no || r.invoice_no || r.id} — ${r.customer || 'no customer'}`,
    },
};

// ── A CLAIM IS A THIRD THING POINTING AT A ROW ────────────────────────────
// Apsara, 2026-09-29: "What if we receive a claim against that invoice?" —
// and she was right, the guard above could not have seen one.
//
// A claim does NOT carry a sale_id or a bill_id. helpers/claims.js keys it on
//     keyOf(invoice_no, container_no) => `${invoice_no}|${container_no}`
// so a guard keyed by row id — which is what payments and receipts use — is
// looking in a place a claim never appears. It would have returned "nothing
// allocated" against a claimed invoice every single time.
//
// It reaches BOTH ledgers, not just invoices. The customer claims against our
// invoice; raiseRecovery() then goes after the SUPPLIER on that container
// ("recovery raised on supplier"), which is the bill. Delete either row and
// the claim is left naming a document that no longer exists, with its
// evidence, its mail trail and its claim_amount still on the books.
//
// Matched on CONTAINER, plus invoice number where the row has one. Container
// is the field both ledgers share and the one a claim always carries.
//
// ── A JUDGEMENT OF MINE, NOT HERS ─────────────────────────────────────────
// A settled / rejected / withdrawn claim does NOT block the delete, or an old
// invoice could never be cleared once anyone had ever claimed on it. Live
// claims — unverified, verified, recovery_raised — refuse. That line is my
// call and she has not ruled on it; if she wants closed claims to block too,
// it is one entry in this array.
const LIVE_CLAIM_STATUSES = ['unverified', 'verified', 'recovery_raised'];

function liveClaims() {
    let all = [];
    try {
        const claims = require('./claims');
        mustParse(claims.FILE(), 'claims.json');
        all = claims.list() || [];
    } catch (e) {
        throw new Error(`cannot read claims, so nothing can be deleted safely: ${e.message}`);
    }
    const byContainer = new Map();
    for (const c of all) {
        if (!c || !LIVE_CLAIM_STATUSES.includes(c.status)) continue;
        const k = String(c.container_no || '').trim().toUpperCase();
        if (!k) continue;
        if (!byContainer.has(k)) byContainer.set(k, []);
        byContainer.get(k).push(c);
    }
    return byContainer;
}

// What to say about a claim on the row she is trying to delete.
function claimRefusal(row, byContainer) {
    const k = String(row.container_no || '').trim().toUpperCase();
    if (!k) return null;
    const hits = byContainer.get(k) || [];
    if (!hits.length) return null;
    const c = hits[0];
    const amt = Number(c.claim_amount || c.our_claim) || 0;
    return `an open claim against ${c.container_no}`
        + (c.invoice_no ? ` (invoice ${c.invoice_no})` : '')
        + `, status ${c.status}`
        + (amt ? `, ${amt.toFixed(2)}` : '')
        + ` — settle or withdraw the claim first`;
}

const batchId = () => `DEL_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 6)}`;

// ── WHAT WOULD HAPPEN. NOTHING IS TOUCHED ─────────────────────────────────
// Separate from commit so a selection can be shown before it is acted on, and
// so the refusals can be read without having deleted anything to find out.
function plan(kind, ids, { reason = '' } = {}) {
    const K = KINDS[kind];
    if (!K) throw new Error(`unknown ledger "${kind}" — bills or sales`);
    const wanted = [...new Set((ids || []).map((x) => String(x || '').trim()).filter(Boolean))];
    if (!wanted.length) throw new Error('no rows selected');

    const rows = K.list();
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    const allocated = K.allocated();
    const claimsByContainer = liveClaims();

    const going = [];
    const refused = [];
    for (const id of wanted) {
        const row = byId.get(id);
        if (!row) { refused.push({ id, why: `no ${K.label} ${id} — already gone?` }); continue; }
        const paid = Number(allocated[id]) || 0;
        if (paid > 0.005) {
            // Her rule: refuse this one, take the rest.
            refused.push({ id, what: K.describe(row), why: `${paid.toFixed(2)} allocated against it — delete the payment first` });
            continue;
        }
        const claimWhy = claimRefusal(row, claimsByContainer);
        if (claimWhy) { refused.push({ id, what: K.describe(row), why: claimWhy }); continue; }
        going.push(row);
    }
    return { kind, batch: batchId(), reason: String(reason || '').slice(0, 300), going, refused,
             counts: { asked: wanted.length, going: going.length, refused: refused.length } };
}

// ── ARCHIVE FIRST, THEN REMOVE ────────────────────────────────────────────
// In that order, deliberately. If the archive write fails the rows are still
// in the ledger and she has lost nothing; the other order loses them both.
async function commit(planned) {
    if (!planned || !planned.batch) throw new Error('nothing planned to delete');
    const K = KINDS[planned.kind];
    if (!K) throw new Error(`unknown ledger "${planned.kind}"`);
    if (!planned.going.length) return { batch: planned.batch, removed: 0, refused: planned.refused };

    const stamp = new Date().toISOString();
    await mutateJson(ARCHIVE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        for (const row of planned.going) {
            list.push({ batch: planned.batch, kind: planned.kind, at: stamp,
                        reason: planned.reason || null, row });
        }
        return list;
    }, { strict: true });

    const doomed = new Set(planned.going.map((r) => String(r.id)));
    let removed = 0;
    await mutateJson(K.file(), [], (all) => {
        const list = Array.isArray(all) ? all : [];
        const keep = list.filter((r) => !(r && doomed.has(String(r.id))));
        removed = list.length - keep.length;
        return keep;
    }, { strict: true });

    return { batch: planned.batch, removed, refused: planned.refused, archived: ARCHIVE };
}

// ── PUTTING A BATCH BACK ──────────────────────────────────────────────────
// The rows are kept whole, so this is an append of exactly what was taken. A
// row whose id is somehow present again is skipped rather than duplicated —
// two bills for one container is the finding the nightly sweep exists to
// report, and restore() must not create one.
async function restore(batch) {
    if (!batch) throw new Error('which deletion? a batch id is required');
    const archive = loadJson(ARCHIVE, []) || [];
    const mine = archive.filter((x) => x && x.batch === batch);
    if (!mine.length) throw new Error(`no deletion ${batch}`);

    const byKind = {};
    for (const x of mine) (byKind[x.kind] = byKind[x.kind] || []).push(x.row);

    let back = 0;
    for (const kind of Object.keys(byKind)) {
        const K = KINDS[kind];
        if (!K) continue;
        await mutateJson(K.file(), [], (all) => {
            const list = Array.isArray(all) ? all : [];
            const have = new Set(list.map((r) => String(r && r.id)));
            for (const row of byKind[kind]) {
                if (have.has(String(row.id))) continue;
                list.push(row);
                back += 1;
            }
            return list;
        }, { strict: true });
    }
    return back;
}

// Every deletion that has ever run, newest first — so a restore has something
// to name.
function batches() {
    const archive = loadJson(ARCHIVE, []) || [];
    const seen = new Map();
    for (const x of archive) {
        if (!x || !x.batch) continue;
        const b = seen.get(x.batch) || { batch: x.batch, at: x.at, kind: x.kind, reason: x.reason, rows: 0 };
        b.rows += 1;
        seen.set(x.batch, b);
    }
    return [...seen.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

function reportText(result, planned) {
    const out = [];
    out.push(`${result.removed} row${result.removed === 1 ? '' : 's'} deleted as batch ${result.batch}.`);
    if (result.refused.length) {
        out.push('');
        out.push(`${result.refused.length} refused:`);
        for (const r of result.refused) out.push(`  · ${r.what || r.id}: ${r.why}`);
    }
    if (result.removed) out.push('', `To put them back:  restore('${result.batch}')`);
    return out.join('\n');
}

module.exports = { plan, commit, restore, batches, reportText, KINDS, ARCHIVE };
