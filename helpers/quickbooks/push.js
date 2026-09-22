// ── helpers/quickbooks/push.js — a Jarvis bill, entered the way she enters it ─
// Apsara, 2026-09-21: "pull from qb against suppliers for bills ... check then
// enter". Read with the live books on 2026-09-21, this is how a container bill
// already looks in Edge Metals Inc (e.g. Mazariegos, SEKU4687753, 5 Aug 2026):
//
//   DocNumber   = Edge's own invoice no (260716_AC_26RMT48) — the SAME number
//                 the sale invoice carries, which is what ties buy to sell
//   line 1      = item AUTO CAST, Qty 45,000 (lbs), UnitPrice 1.02, 45,900,
//                 description = the container number
//   line 2      = account "Trucking", −800   (haulage taken off the supplier)
//   total       = 45,100  = Jarvis net_payable (amount − trucking)
//
// So the builder produces exactly that, from bills.withTotals() — Jarvis's own
// arithmetic, never a second copy of it.
//
// ── WHAT THIS FILE DELIBERATELY DOES NOT DO ─────────────────────────────────
//   · no trucker bill. In 2026 none of her 11 trucking-deduction bills has a
//     matching per-container trucker bill; truckers are billed per statement
//     (TQL, monarca, Eagle Trans) or paid straight from the bank. Creating one
//     per container would double her trucking cost. Her decision, pending.
//   · no advance. An advance is money already sent — a payment, not a bill
//     line (see helpers/bills.js on why it sits with `paid`). Payments are the
//     next piece, and they carry the double-count risk.
//   · no guessing. A supplier or grade without a confirmed mapping stops the
//     bill with the reason; nothing is created in her live books to fill a gap.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../../config');
const mapping = require('./mapping');
const client = require('./client');
const auth = require('./auth');

const LINKS_FILE = () => process.env.QB_LINKS_FILE || path.join(DATA_DIR, 'qb-links.json');
const DOC_MAX = 21;   // QuickBooks DocNumber limit
const round2 = (n) => Math.round(n * 100) / 100;

// ── LOCAL DELIVERIES (Apsara, 2026-09-22: "2.a") ────────────────────────────
// A row with no container is a local delivery (memory: ledger-data), and most
// carry no invoice number — yet QuickBooks needs one to tie a bill to its sale.
// Such a row gets a number made from ITS OWN date and Jarvis id, so the same
// row always gets the same number (a re-run finds it instead of doubling it):
//   LOCAL-260908-A1B2C3   (19 characters; QuickBooks allows 21)
// A row WITH a container but no invoice number still stops: that is a real
// gap in her paperwork, not a local delivery.
function docNumberFor(r) {
    const given = String((r && r.invoice_no) || '').trim();
    if (given) return given;
    if (String((r && r.container_no) || '').trim()) return '';
    let d = String((r && r.date) || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}/.test(d)) { try { d = require('../bills').sortableDate(d) || ''; } catch { d = ''; } }
    const ymd = d.replace(/-/g, '').slice(2, 8);
    const id = String((r && r.id) || '').replace(/[^A-Za-z0-9]/g, '').slice(-6).toUpperCase();
    return ymd.length === 6 && id ? `LOCAL-${ymd}-${id}` : '';
}

function loadLinks() { try { return JSON.parse(fs.readFileSync(LINKS_FILE(), 'utf8')); } catch { return {}; } }
function saveLink(key, v) {
    const all = loadLinks(); all[key] = v;
    const f = LINKS_FILE(), tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2)); fs.renameSync(tmp, f);
}
const linkKey = (env, kind, jarvisId) => `${env}:${kind}:${jarvisId}`;

// Mapping answers are stored with the PRODUCTION name. In any environment the
// Id is looked up by that name, so a sandbox run exercises the same path the
// live one will — only the Ids differ.
function confirmedName(kind, jarvisName, qbList) {
    const r = mapping.matchParty(jarvisName, qbList, kind);
    if (r.status === 'exact' || r.status === 'confirmed') return { name: r.qb.DisplayName };
    return { problem: `${kind} "${jarvisName}" is ${r.status}${r.candidates && r.candidates.length ? ` (maybe ${r.candidates.map((c) => c.DisplayName).join(' / ')})` : ''} — confirm it first` };
}

// Pure: Jarvis bill (after bills.withTotals) + resolved Ids → Bill payload.
// refs = { vendorId, itemIds: {grade: id}, truckingAccountId, apAccountId? }
function buildBill(b, refs) {
    const problems = [];
    const container = String(b.container_no || '').trim().toUpperCase();
    const doc = docNumberFor(b);
    if (!b.date) problems.push('no bill date');
    if (!doc) problems.push('no invoice number — the number that ties this bill to its sale');
    if (doc.length > DOC_MAX) problems.push(`invoice number longer than QuickBooks allows (${DOC_MAX})`);
    if (typeof b.amount !== 'number' || !(b.amount > 0)) problems.push('no supplier amount yet');

    const grades = (b.items && b.items.length)
        ? b.items.map((i) => ({ grade: i.description, qty: i.price_unit === 'mt' ? i.weight_mt : i.weight, price: i.price, amount: i.amount }))
        : [{ grade: b.description, qty: b.price_unit === 'mt' ? b.net_mt : b.net_lb, price: b.supplier_price, amount: b.amount }];
    const Line = [];
    for (const g of grades) {
        const id = refs.itemIds[g.grade];
        if (!id) { problems.push(`grade "${g.grade}" has no QuickBooks item`); continue; }
        if (typeof g.amount !== 'number') { problems.push(`grade "${g.grade}" has no amount`); continue; }
        const detail = { ItemRef: { value: String(id) }, BillableStatus: 'NotBillable' };
        if (typeof g.qty === 'number' && typeof g.price === 'number' && round2(g.qty * g.price) === round2(g.amount)) {
            detail.Qty = g.qty; detail.UnitPrice = g.price;
        }
        Line.push({ DetailType: 'ItemBasedExpenseLineDetail', Amount: round2(g.amount), Description: container || undefined, ItemBasedExpenseLineDetail: detail });
    }
    const trucking = Number(b.trucking_amount_used || 0);
    if (trucking > 0) {
        if (!refs.truckingAccountId) problems.push('no "Trucking" account found');
        else Line.push({ DetailType: 'AccountBasedExpenseLineDetail', Amount: -round2(trucking), Description: container || undefined,
            AccountBasedExpenseLineDetail: { AccountRef: { value: String(refs.truckingAccountId) }, BillableStatus: 'NotBillable' } });
    }
    const total = round2(Line.reduce((s, l) => s + l.Amount, 0));
    if (!problems.length && typeof b.net_payable === 'number' && total !== round2(b.net_payable)) {
        problems.push(`lines add to ${total} but Jarvis says ${b.net_payable} is payable`);
    }
    if (problems.length) return { problems };
    const bill = {
        VendorRef: { value: String(refs.vendorId) },
        TxnDate: isoDate(b.date),
        DocNumber: doc,
        PrivateNote: [container && `Container ${container}`, b.booking_no && `Booking ${b.booking_no}`, b.seal_no && `Seal ${b.seal_no}`, b.id && `Jarvis bill ${b.id}`].filter(Boolean).join(' · '),
        Line,
    };
    if (refs.apAccountId) bill.APAccountRef = { value: String(refs.apAccountId) };
    return { bill, total };
}

// ── looking her books up by name ────────────────────────────────────────────
const esc = (s) => String(s).replace(/'/g, "\\'");
async function idByName(table, field, name, opts) {
    const r = await client.query(`select Id, ${field} from ${table} where ${field} = '${esc(name)}'`, opts);
    const rows = r[table] || [];
    return rows.length === 1 ? rows[0].Id : null;
}

// Sandbox only: make the vendor/item/account the live company already has, so
// a test runs against the same names. Refuses anywhere else — in production a
// missing name is a question for her, never something to create.
async function ensureSandbox(kind, name, opts) {
    if ((opts.env || auth.qbEnv()) !== 'sandbox') throw new Error(`refusing to create ${kind} "${name}" outside the sandbox`);
    if (kind === 'vendor') return (await client.request('POST', '/vendor', { DisplayName: name }, opts)).Vendor.Id;
    if (kind === 'account') return (await client.request('POST', '/account', { Name: name, AccountType: 'Cost of Goods Sold' }, opts)).Account.Id;
    if (kind === 'term') return (await client.request('POST', '/term', { Name: name, DueDays: 0 }, opts)).Term.Id;
    if (kind === 'customer') return (await client.request('POST', '/customer', { DisplayName: name }, opts)).Customer.Id;
    if (kind === 'item') {
        const inc = await idByName('Account', 'Name', 'Sales of Product Income', opts);
        const cogs = await idByName('Account', 'Name', 'Cost of Goods Sold', opts);
        return (await client.request('POST', '/item', { Name: name, Type: 'NonInventory', IncomeAccountRef: { value: inc }, ExpenseAccountRef: { value: cogs } }, opts)).Item.Id;
    }
}

async function resolveRefs(b, snapshots, opts) {
    const env = opts.env || auth.qbEnv();
    const problems = [];
    const vendor = confirmedName('vendor', b.supplier, snapshots.vendor);
    if (vendor.problem) problems.push(vendor.problem);
    const grades = (b.items && b.items.length) ? b.items.map((i) => i.description) : [b.description];
    const itemNames = {};
    for (const g of grades) { const r = confirmedName('item', g, snapshots.item); if (r.problem) problems.push(r.problem); else itemNames[g] = r.name; }
    if (problems.length) return { problems };

    const get = async (kind, table, field, name) => (await idByName(table, field, name, opts))
        || (env === 'sandbox' ? ensureSandbox(kind, name, opts) : null);
    const refs = { vendorId: await get('vendor', 'Vendor', 'DisplayName', vendor.name), itemIds: {} };
    for (const [g, n] of Object.entries(itemNames)) refs.itemIds[g] = await get('item', 'Item', 'Name', n);
    refs.truckingAccountId = await get('account', 'Account', 'Name', 'Trucking');
    if (env === 'production') refs.apAccountId = await idByName('Account', 'Name', 'Vendor Payable', opts);
    if (!refs.vendorId) problems.push(`vendor "${vendor.name}" not found in QuickBooks ${env}`);
    for (const [g, id] of Object.entries(refs.itemIds)) if (!id) problems.push(`item "${itemNames[g]}" not found in QuickBooks ${env}`);
    return problems.length ? { problems } : { refs, vendorName: vendor.name };
}

// ── check, then enter ───────────────────────────────────────────────────────
// Before creating: is this container already in her books? Searched across ALL
// suppliers/customers, not just the one Jarvis would use — found 2026-09-22 on
// TXGU8942580: Jarvis says TAEWON AUTOMOTIVE CO, her accountant invoiced it to
// TAEWON PRECEISION, and a search limited to the Jarvis customer would have
// missed it and entered the container twice. Same invoice number, or the
// container number in a line/memo, within 120 days either side.
async function findExistingDoc(table, { date, container, doc }, opts) {
    container = String(container || '').trim().toUpperCase();
    doc = String(doc || '').trim();
    const d = new Date(String(date).slice(0, 10));
    const from = new Date(d.getTime() - 120 * 864e5).toISOString().slice(0, 10);
    const to = new Date(d.getTime() + 120 * 864e5).toISOString().slice(0, 10);
    const hits = [];
    for (let start = 1; ; start += 1000) {
        const r = await client.query(`select * from ${table} where TxnDate >= '${from}' and TxnDate <= '${to}' startposition ${start} maxresults 1000`, opts);
        const rows = r[table] || [];
        for (const x of rows) {
            const text = JSON.stringify([x.PrivateNote, (x.Line || []).map((l) => l.Description)]).toUpperCase();
            if ((doc && x.DocNumber === doc) || (container && text.includes(container))) {
                const party = x.VendorRef || x.CustomerRef || {};
                hits.push({ Id: x.Id, DocNumber: x.DocNumber, TxnDate: x.TxnDate, TotalAmt: x.TotalAmt, partyId: party.value, party: party.name,
                    containers: (text.match(/[A-Z]{4}\d{7}/g) || []).filter((v, i, a) => a.indexOf(v) === i) });
            }
        }
        if (rows.length < 1000) break;
    }
    return hits;
}
// sure = one hit, same party, same total. Anything else she decides.
function judgeExisting(hits, partyId, total) {
    const same = hits.filter((h) => h.partyId === String(partyId) && Math.abs(h.TotalAmt - total) < 0.005);
    if (same.length === 1 && hits.length === 1) return { sure: same[0] };
    if (!hits.length) return {};
    const why = hits.map((h) => h.partyId !== String(partyId) ? `#${h.Id} is under ${h.party}` : Math.abs(h.TotalAmt - total) >= 0.005 ? `#${h.Id} totals ${h.TotalAmt}, Jarvis ${total}` : `#${h.Id} matches`);
    return { ask: hits, why };
}
async function findExisting(b, vendorId, opts) {
    return findExistingDoc('Bill', { date: b.date, container: b.container_no, doc: docNumberFor(b) }, opts);
}

// ── CUTOVER ─────────────────────────────────────────────────────────────────
// Apsara, 2026-09-22: "Jarvis fills everything after that". Her books are
// complete by hand to 5 Sep 2026 (bills) and 27 Aug 2026 (invoices), and Jan–May
// supplier wires were booked straight to Cost of Goods Sold with no bill —
// a Jarvis bill for those containers would count the cost twice. So Jarvis
// only ever enters documents dated AFTER the cutover. In production an unset
// cutover refuses everything: no date is not the same as "all dates".
function cutoverFor(kind, env) {
    const v = String(process.env[kind === 'bill' ? 'QB_CUTOVER_BILLS' : 'QB_CUTOVER_INVOICES'] || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    return env === 'production' ? null : '0000-00-00';
}
// Jarvis stores dates as typed ("9/15/2026" or "2026-09-15"). Compared as
// plain text, "9/15/2026" sorts before "2026-09-06" and was silently treated
// as pre-cutover — so it never reached QuickBooks. Normalise first.
function isoDate(v) {
    const s = String(v || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    try { return require('../bills').sortableDate(s) || null; } catch { return null; }
}
const UNREADABLE = /can't be read/;

function beforeCutover(kind, date, env) {
    const c = cutoverFor(kind, env);
    if (c === null) return `no ${kind} cutover date set for production — refusing`;
    const d = isoDate(date);
    if (!d) return `${kind} date "${date}" can't be read — refusing`;
    return d < c ? `${kind} dated ${d} is before the cutover (${c}) — her books already hold that period` : null;
}

async function pushBill(b, snapshots, { env = auth.qbEnv(), dryRun = true, fetchImpl } = {}) {
    const opts = { env, fetchImpl };
    const cut = beforeCutover('bill', b.date, env);
    if (cut) return { status: UNREADABLE.test(cut) ? 'blocked' : 'before-cutover', problems: [cut] };
    const key = linkKey(env, 'bill', b.id || b.container_no);
    const linked = loadLinks()[key];
    if (linked) return { status: 'already-linked', qbId: linked.qbId };

    // Every decision goes in the journal (helpers/quickbooks/journal.js) — only
    // on a real run; a dry run decides nothing. Apsara 2026-09-22: "everything
    // should be tracked".
    const journal = require('./journal');
    const jarvis = { id: b.id, container: b.container_no, invoice_no: docNumberFor(b), supplier: b.supplier, date: b.date, net_payable: b.net_payable };
    const note = (action, extra) => { if (!dryRun) journal.record({ env, kind: 'bill', action, jarvis, qb: {}, ...extra }); };

    const res = await resolveRefs(b, snapshots, opts);
    if (res.problems) { note('blocked', { reason: res.problems.join('; ') }); return { status: 'blocked', problems: res.problems }; }
    const built = buildBill(b, res.refs);
    if (built.problems) { note('blocked', { reason: built.problems.join('; ') }); return { status: 'blocked', problems: built.problems }; }

    const existing = await findExisting(b, res.refs.vendorId, opts);
    const j = judgeExisting(existing, res.refs.vendorId, built.total);
    if (j.sure) {
        if (!dryRun) saveLink(key, { qbId: j.sure.Id, how: 'matched-existing', at: new Date().toISOString() });
        note('linked-existing', { linkKey: key, jarvisTotal: built.total, qb: { id: j.sure.Id, total: j.sure.TotalAmt, partyId: j.sure.partyId, party: j.sure.party }, reason: 'same supplier, same total, found by container/invoice no' });
        return { status: 'exists', qbId: j.sure.Id, note: 'already in QuickBooks — linked, nothing entered' };
    }
    if (j.ask) { note('asked', { candidates: j.ask, reason: j.why.join('; ') }); return { status: 'ask', candidates: j.ask, why: j.why, bill: built.bill, note: 'this container is already in QuickBooks but not exactly as Jarvis has it — she decides' }; }
    if (dryRun) return { status: 'would-create', bill: built.bill, total: built.total };

    const out = await client.request('POST', '/bill', built.bill, opts);
    saveLink(key, { qbId: out.Bill.Id, syncToken: out.Bill.SyncToken, how: 'created', total: out.Bill.TotalAmt, at: new Date().toISOString() });
    const je = journal.record({ env, kind: 'bill', action: 'created', jarvis, linkKey: key, jarvisTotal: b.net_payable,
        qb: { id: out.Bill.Id, syncToken: out.Bill.SyncToken, fp: journal.fingerprint(out.Bill), total: out.Bill.TotalAmt, partyId: res.refs.vendorId, party: res.vendorName } });
    return { status: 'created', qbId: out.Bill.Id, total: out.Bill.TotalAmt, bill: out.Bill, journalId: je.id };
}

module.exports = { isoDate, UNREADABLE, docNumberFor, confirmedName, idByName, ensureSandbox, saveLink, linkKey, cutoverFor, beforeCutover, buildBill, resolveRefs, findExisting, findExistingDoc, judgeExisting, pushBill, loadLinks, LINKS_FILE, DOC_MAX };
