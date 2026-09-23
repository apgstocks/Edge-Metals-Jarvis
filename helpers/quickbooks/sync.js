// ── helpers/quickbooks/sync.js — Jarvis saves, QuickBooks follows ───────────
// Apsara, 2026-09-22: "Why none of this change is reflected in qb?" — because
// nothing called the push code. This is the caller.
//
// ── HOW IT IS WIRED ─────────────────────────────────────────────────────────
// api.js calls after('bill', id) etc. AFTER a save has succeeded and after the
// response is decided. after() never throws and never waits: the push runs
// on the next tick, so a slow or down QuickBooks can never fail, slow, or
// change a save in Jarvis. Whatever happens is in the journal.
//
// ── THREE SWITCHES, ALL OFF BY DEFAULT ──────────────────────────────────────
//   QB_SYNC=on          the hooks do anything at all. Off: deploying this file
//                       changes nothing — the save routes behave as today.
//   QB_ENV=production   which company. Anything else is the sandbox.
//   QB_PROD_WRITES=on   client.js lets a write reach the live books.
// Plus the cutover dates (push.js) — nothing before them, ever.
//
// ── WHAT IT DOES NOT DO YET ─────────────────────────────────────────────────
// An EDIT or DELETE in Jarvis of something already in QuickBooks is not
// pushed as an update/delete. It is journalled as 'asked' with what changed,
// so `qb-journal check` lists it and she decides (undo + re-push, or fix by
// hand). Updating her books on every edit is a separate, riskier step.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../../config');
const auth = require('./auth');
const client = require('./client');
const mapping = require('./mapping');
const push = require('./push');
const pushInvoice = require('./pushInvoice');
const pushPayments = require('./pushPayments');
const journal = require('./journal');

const on = () => String(process.env.QB_SYNC || '').trim().toLowerCase() === 'on';
const SNAP_TTL_MS = 60 * 60 * 1000;

// Name lists from her books, refreshed hourly (a new vendor she adds in
// QuickBooks becomes matchable within the hour). Falls back to the snapshot
// files so a QuickBooks outage does not block matching of known names.
let snapCache = { at: 0, env: null, data: null };
//
// Names are ALWAYS matched against her LIVE books (read-only), whichever
// company is being written to: every mapping she confirmed is a production
// name, and the sandbox only mirrors those names. Found by the end-to-end
// test 2026-09-22 — against the sandbox's own list, "MK Trading" (an exact
// live match) was unknown and the invoice was blocked.
async function snapshots() {
    const env = auth.status('production').connected ? 'production' : auth.qbEnv();
    if (snapCache.data && snapCache.env === env && Date.now() - snapCache.at < SNAP_TTL_MS) return snapCache.data;
    const opts = { env };
    try {
        const data = {};
        for (const k of ['vendor', 'customer', 'item', 'bank', 'account']) data[k] = await mapping.fetchParties(k, client, opts);
        snapCache = { at: Date.now(), env, data };
        return data;
    } catch (e) {
        const f = (n) => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, n), 'utf8')); } catch { return []; } };
        const p = f('qb-snapshot-parties.json');
        return { vendor: p.vendor || [], customer: p.customer || [], item: f('qb-snapshot-items.json'), bank: f('qb-snapshot-banks.json'), account: f('qb-snapshot-accounts.json') };
    }
}

// ── one record ──────────────────────────────────────────────────────────────
async function syncBill(id, env) {
    const bills = require('../bills');
    const raw = bills.list().find((b) => b.id === id);
    if (!raw) return { status: 'gone' };
    return push.pushBill(bills.withTotals(raw), await snapshots(env), { env, dryRun: false });
}

// one invoice = every sales row carrying that invoice number
async function syncSale(id, env) {
    const sales = require('../sales');
    const one = sales.getSale(id);
    if (!one) return { status: 'gone' };
    const no = push.docNumberFor(one);
    if (!no) return { status: 'waiting', problems: ['no invoice number yet — entered once it has one'] };
    const rows = sales.list().filter((s) => push.docNumberFor(s) === no).map((s) => sales.withTotals(s));
    return pushInvoice.pushInvoice(rows, await snapshots(env), { env, dryRun: false });
}

async function syncBillPayment(id, env) {
    const p = require('../billPayments').list().find((x) => x.id === id);
    if (!p) return { status: 'gone' };
    // a payment waits for every bill it pays
    for (const a of (p.allocations || [])) await syncBill(a.bill_id, env).catch(() => {});
    return pushPayments.pushBillPayment(p, await snapshots(env), { env, dryRun: false });
}

async function syncReceipt(id, env) {
    const sales = require('../sales');
    const r = require('../salesReceipts').list().find((x) => x.id === id);
    if (!r) return { status: 'gone' };
    for (const a of (r.allocations || [])) await syncSale(a.sale_id, env).catch(() => {});
    return pushPayments.pushCustomerPayment(r, await snapshots(env), { env, dryRun: false,
        saleInvoiceNo: (saleId) => { const s = sales.getSale(saleId); return s && push.docNumberFor(s); } });
}

const SYNC = { bill: syncBill, sale: syncSale, billpayment: syncBillPayment, receipt: syncReceipt };
const LINK_KIND = { bill: 'bill', sale: 'invoice', billpayment: 'billpayment', receipt: 'payment' };

// An edit or delete of something already entered: recorded, not pushed.
function noteChange(kind, id, what, env) {
    const links = push.loadLinks();
    let key = push.linkKey(env, LINK_KIND[kind], id);
    if (kind === 'sale') {
        const s = require('../sales').getSale(id);
        if (s && push.docNumberFor(s)) key = push.linkKey(env, 'invoice', push.docNumberFor(s));
    }
    const l = links[key];
    if (!l) return false;
    journal.record({ env, kind: LINK_KIND[kind] === 'invoice' ? 'invoice' : LINK_KIND[kind], action: 'asked', linkKey: key,
        jarvis: { id, change: what }, qb: { id: l.qbId },
        reason: `${what} in Jarvis after it was entered in QuickBooks (#${l.qbId}) — QuickBooks was NOT changed; undo and re-push, or fix it there` });
    return true;
}

// ── the hook ────────────────────────────────────────────────────────────────
// change: 'saved' (new or edited) | 'deleted'
function after(kind, id, change = 'saved') {
    if (!on() || !id || !SYNC[kind]) return;
    setImmediate(async () => {
        const env = auth.qbEnv();
        try {
            if (change === 'deleted') { noteChange(kind, id, 'deleted', env); return; }
            const r = await SYNC[kind](String(id), env);
            if (r && r.status === 'already-linked') noteChange(kind, id, 'edited', env);
            if (r && !['created', 'exists', 'already-linked', 'before-cutover', 'waiting', 'gone'].includes(r.status)) {
                console.warn(`[QB] ${kind} ${id}: ${r.status}${r.problems ? ' — ' + r.problems.join('; ') : ''}`);
            }
        } catch (e) {
            console.warn(`[QB] ${kind} ${id} failed: ${e.message}`);
            try { journal.record({ env, kind: LINK_KIND[kind] === 'invoice' ? 'invoice' : LINK_KIND[kind], action: 'blocked', jarvis: { id }, qb: {}, reason: `error: ${e.message}` }); } catch { /* the save already stood; nothing more to do */ }
        }
    });
}

// ── the sweep: everything since the cutover, in dependency order ────────────
// Catches saves that arrived another way (imports, the invoice flow, a time
// QB_SYNC was off or QuickBooks was down). Idempotent: linked records are
// skipped, everything else goes through the same checks as a hook.
async function sweep({ env = auth.qbEnv(), dryRun = false } = {}) {
    const res = { bill: {}, sale: {}, billpayment: {}, receipt: {} };
    const count = (k, r) => { const s = (r && r.status) || 'error'; res[k][s] = (res[k][s] || 0) + 1; };
    // keep a row if it is after the cutover OR its date can't be read — the
    // push functions then report it as blocked instead of it vanishing.
    const since = (kind, d) => { const c = push.beforeCutover(kind, d, env); return !c || push.UNREADABLE.test(c); };
    const bills = require('../bills').list().filter((b) => since('bill', b.date));
    const sales = require('../sales').list().filter((s) => since('invoice', s.date));
    const bps = require('../billPayments').list().filter((p) => since('bill', p.date));
    const recs = require('../salesReceipts').list().filter((r) => since('invoice', r.date));
    const snaps = await snapshots(env);
    if (dryRun) {
        const B = require('../bills'), S = require('../sales');
        for (const b of bills) count('bill', await push.pushBill(B.withTotals(b), snaps, { env, dryRun: true }).catch((e) => ({ status: 'error: ' + e.message })));
        const byInv = {};
        for (const s of sales) { const n = push.docNumberFor(s); if (n) (byInv[n] = byInv[n] || []).push(S.withTotals(s)); }
        for (const rows of Object.values(byInv)) count('sale', await pushInvoice.pushInvoice(rows, snaps, { env, dryRun: true }).catch((e) => ({ status: 'error: ' + e.message })));
        // payments too — they only find their bill/invoice once it is linked
        for (const p of bps) count('billpayment', await pushPayments.pushBillPayment(p, snaps, { env, dryRun: true }).catch((e) => ({ status: 'error: ' + e.message })));
        for (const r of recs) count('receipt', await pushPayments.pushCustomerPayment(r, snaps, { env, dryRun: true,
            saleInvoiceNo: (saleId) => { const s = S.getSale(saleId); return s && push.docNumberFor(s); } }).catch((e) => ({ status: 'error: ' + e.message })));
        return res;
    }
    for (const b of bills) count('bill', await syncBill(b.id, env).catch((e) => ({ status: 'error: ' + e.message })));
    const seen = new Set();
    for (const s of sales) { const no = push.docNumberFor(s); if (no && seen.has(no)) continue; seen.add(no); count('sale', await syncSale(s.id, env).catch((e) => ({ status: 'error: ' + e.message }))); }
    for (const p of bps) count('billpayment', await syncBillPayment(p.id, env).catch((e) => ({ status: 'error: ' + e.message })));
    for (const r of recs) count('receipt', await syncReceipt(r.id, env).catch((e) => ({ status: 'error: ' + e.message })));
    return res;
}

module.exports = { after, sweep, syncBill, syncSale, syncBillPayment, syncReceipt, on, snapshots };
