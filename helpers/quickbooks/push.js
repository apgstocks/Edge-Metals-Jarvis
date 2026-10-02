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
        if (pairFits(g.qty, g.price, g.amount)) {
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
// a Jarvis bill for those containers would count the cost twice.
//
// That WAS a date rule: nothing before the cutover, and in production an unset
// cutover refused everything. Both are gone (2026-10-02). The cost-counted-
// twice case is now asked directly, per container, in costAlreadyOnACheque();
// an unset boundary means 2026 is open and the evidence decides.
//
// ── WHERE THE CUTOVER LIVES (2026-09-26) ────────────────────────────────────
// It used to live only in .env. That meant moving the boundary was an SSH
// session and a pm2 restart, and — worse — the nightly run silently skipped
// every row older than whatever was pinned there. It now also lives in a
// settings file Jarvis can write, so the date can be moved from the QuickBooks
// page and the next run honours it with no restart.
//
// Three places, in this order:
//   1. an in-process override — a script that says "for this run, go back to
//      1 Jan" (scripts/qb-push-list.js). Never persisted.
//   2. the settings file she edits on the page. This is the real boundary.
//   3. .env — the machine's default, and all a fresh install has.
// The page says which one is in force, because "I changed it and nothing
// happened" is the worst answer a screen can give.
const CUTOVER_FILE = () => process.env.QB_CUTOVER_FILE || path.join(DATA_DIR, 'qb-cutover.json');
const CUT_KEY = { bill: 'bills', invoice: 'invoices' };
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// ── "everyday that cut over should be toay" (Apsara, 2026-10-02) ───────────
// A date pinned in a file is wrong the day after it is typed — that is how the
// VM sat on 24 Sep for eight days skipping every row the sheet sync wrote. So
// the boundary can now be the WORD "today" instead of a date, resolved at read
// time: it moves with the day and never needs editing again.
//
// But read literally as a LOCK, "today" refuses every row dated before today —
// which is every bill she enters for last week, and is exactly the silence
// that was just removed. A boundary that is always today is only safe in one
// direction, so there are two of them now:
//
//   HORIZON — always today, not configurable, no way to get it wrong.
//             Nothing dated AFTER today is entered. A bill dated 2027 is a
//             typo, not a document. This is the rolling boundary.
//   LOCK    — optional, off unless she sets it. Refuses dates BEFORE it,
//             for a period she closed on purpose. It accepts "today" too,
//             because she may mean it, and the doctor says out loud what that
//             costs: nothing back-dated gets in at all.
const ROLLING = /^(today|rolling|auto)$/i;
// "none" from the page is a DECISION, not an absence. If it merely deleted the
// key, .env (QB_CUTOVER_BILLS=2026-09-24 is still on the VM) would quietly take
// over and the click would appear to do nothing — the worst thing a screen can
// do. So it is stored, and it outranks .env.
const CLEARS = /^(none|off|open|clear|no lock|unset)$/i;
function todayISO() {
    try { return require('../time').todayLocal(); }
    catch { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); }
}
// what a stored value MEANS today
function cutValue(v) {
    const s = String(v === undefined || v === null ? '' : v).trim();
    if (ROLLING.test(s)) return todayISO();
    return ISO_DAY.test(s) ? s : null;
}
// what gets written back — "today" stays the word, not the day it was typed
function cutRaw(v) {
    const s = String(v === undefined || v === null ? '' : v).trim();
    if (ROLLING.test(s)) return 'today';
    return ISO_DAY.test(s) ? s : null;
}

function cutoverStore() {
    try { const j = JSON.parse(fs.readFileSync(CUTOVER_FILE(), 'utf8')); return (j && typeof j === 'object') ? j : {}; }
    catch { return {}; }
}
function envRaw(kind) {
    return cutRaw(process.env[kind === 'bill' ? 'QB_CUTOVER_BILLS' : 'QB_CUTOVER_INVOICES']);
}
function cutoverEnv(kind) { return cutValue(envRaw(kind)); }
// For one process only, and only where a script means it: qb-push-list.js
// pushes a list she has already reviewed, which is exactly the case where the
// boundary should step aside. Nothing is written to the file.
let OVERRIDE = {};
function setCutover(next = {}) {
    OVERRIDE = {};
    for (const k of ['bills', 'invoices']) {
        const v = cutRaw(next[k]);
        if (v) OVERRIDE[k] = v;
    }
    return { ...OVERRIDE };
}
function clearCutover() { OVERRIDE = {}; }
function cutoverRaw(kind) {
    const k = CUT_KEY[kind] || kind;
    const over = cutRaw(OVERRIDE[k]);
    if (over) return { raw: over, from: 'override' };
    const savedRaw = String(cutoverStore()[k] || '').trim();
    if (CLEARS.test(savedRaw)) return { raw: null, from: 'unlocked' };
    const saved = cutRaw(savedRaw);
    if (saved) return { raw: saved, from: 'setting' };
    const fromEnv = envRaw(kind);
    if (fromEnv) return { raw: fromEnv, from: 'env' };
    return { raw: null, from: 'unset' };
}
function cutoverFor(kind, env) { return cutValue(cutoverRaw(kind).raw); }
function cutoverSource(kind) { return cutoverRaw(kind).from; }
// true when the lock is the word, not a day — the page and the doctor say so,
// because "2026-10-02 (setting)" and "today, every day" are different facts.
function cutoverIsRolling(kind) { return ROLLING.test(String(cutoverRaw(kind).raw || '')); }
// Moving the boundary is a decision about her real books, so it is written
// with who moved it and when. The last 25 moves stay in the file.
function saveCutover(next = {}, who = '') {
    const store = cutoverStore();
    const changed = {};
    for (const k of ['bills', 'invoices']) {
        const v = next[k] === undefined || next[k] === null ? '' : String(next[k]).trim();
        if (!v) continue;
        // No lock is the normal state now, so it has to be reachable from the
        // page — not only by editing a file on the VM.
        if (CLEARS.test(v)) { if (store[k] !== 'none') changed[k] = 'none'; store[k] = 'none'; continue; }
        const raw = cutRaw(v);
        if (!raw) throw new Error(`the ${k} cutover must be a date like 2026-09-06, or the word "today" — got "${next[k]}"`);
        if (store[k] !== raw) changed[k] = raw;
        store[k] = raw;
    }
    if (!Object.keys(changed).length) return { saved: store, changed };
    store.history = [{ at: new Date().toISOString(), by: who || 'jarvis', ...changed }, ...(store.history || [])].slice(0, 25);
    fs.mkdirSync(path.dirname(CUTOVER_FILE()), { recursive: true });
    fs.writeFileSync(CUTOVER_FILE(), JSON.stringify(store, null, 2));
    return { saved: store, changed };
}
// QuickBooks recomputes Amount = Qty x UnitPrice itself and rejects the line
// if its own answer differs by a cent, and it rounds a half-cent up where
// JavaScript's floating point can round it down (2026-09-23: an Aris line of
// 8,563.99 was refused twice). So Qty and UnitPrice only travel when the
// multiplication lands exactly on a cent AND agrees with Jarvis's amount.
// Otherwise the line carries the amount alone, which QuickBooks never argues
// with; the weight and rate stay visible in Jarvis and on her own invoice.
function pairFits(qty, price, amount) {
    if (typeof qty !== 'number' || typeof price !== 'number' || typeof amount !== 'number') return false;
    if (!isFinite(qty) || !isFinite(price)) return false;
    // QuickBooks rounds a half-cent UP; JavaScript's Math.round on a float
    // that landed a hair below (1392361.4999999998) rounds it down. Settle the
    // float first, then round half-up the way QuickBooks does.
    const cents = Math.round(qty * price * 1e8) / 1e6;
    const qb = Math.floor(cents + 0.5);
    return qb === Math.round(amount * 100);
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

// ── THE DATE RULE IS GONE (Apsara, 2026-10-02: "remove that hard cutover
// days rules") ────────────────────────────────────────────────────────────
// A date was always a blunt stand-in for the real question. It said "anything
// before the 6th of September is her accountant's", which was true in
// September and wrong by October — and on the VM it sat on the day it was
// typed for eight days, skipping every row the sheet sync wrote, in silence.
//
// What the date was protecting against was never the date. It was three
// things, and each can be asked directly:
//   1. is it already in QuickBooks?            — the duplicate search
//   2. is its cost already there without a
//      document, on a cheque straight to Cost
//      of Goods Sold?                          — evidenceGate(), below
//   3. has she declared that period closed?    — an OPTIONAL lock, off unless
//                                                she sets one
// So a date is now a lock she may choose, not a rule the code insists on. An
// unreadable date is still refused: a row whose date cannot be read cannot be
// reasoned about at all.
function beforeCutover(kind, date, env) {
    const d = isoDate(date);
    if (!d) return `${kind} date "${date}" can't be read — refusing`;
    // the rolling half: today, every day, and nothing past it
    const t = todayISO();
    if (d > t) return `${kind} dated ${d} is in the future (today is ${t}) — refusing until the date is fixed`;
    const c = cutoverFor(kind, env);
    if (c === null) return null;                 // no lock set: evidence decides
    return d < c ? `${kind} dated ${d} is before the locked period (${c}) — she closed that period deliberately` : null;
}
// Two reasons a row is refused that she must SEE rather than have counted as
// "left alone": a date that cannot be read, and a date in the future. Both are
// a row to fix, not a period to respect.
const NEEDS_FIX = /can't be read|is in the future/;

// ── EVIDENCE, IN PLACE OF A DATE ──────────────────────────────────────────
// The one thing no duplicate search can see: a container whose cost already
// went to Cost of Goods Sold on a cheque with no bill behind it. There is no
// document to find, so a bill for that container lands the cost a second
// time. 16 of those on her 2026 books, $411,276.27, January to May — exactly
// the period a date rule used to fence off.
let costCache = { at: 0, env: null, rows: null };
async function costAlreadyOnACheque(containerNo, { env = auth.qbEnv(), maxAgeMs = 30 * 60 * 1000 } = {}) {
    if (!containerNo) return null;
    const key = String(containerNo).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!costCache.rows || costCache.env !== env || Date.now() - costCache.at > maxAgeMs) {
        const rows = [];
        for (let start = 1; ; start += 1000) {
            const r = await client.query(`select * from Purchase where TxnDate >= '${new Date().getFullYear()}-01-01' startposition ${start} maxresults 1000`, { env });
            const got = r.Purchase || [];
            for (const p of got) {
                const lines = (p.Line || []).filter((l) => /cost of goods/i.test(((((l.AccountBasedExpenseLineDetail || {}).AccountRef) || {}).name) || ''));
                if (!lines.length) continue;
                const text = (p.Line || []).map((l) => l.Description || '').join(' ') + ' ' + (p.PrivateNote || '');
                rows.push({ id: String(p.Id), date: p.TxnDate,
                    amount: round2(lines.reduce((s, l) => s + Number(l.Amount || 0), 0)),
                    containers: [...new Set((text.match(/[A-Z]{4}\d{7}/g) || []))].map((c) => c.toUpperCase()) });
            }
            if (got.length < 1000) break;
        }
        costCache = { at: Date.now(), env, rows };
    }
    const hit = (costCache.rows || []).find((p) => p.containers.includes(key));
    return hit ? `${containerNo} already carries ${hit.amount} of cost on cheque #${hit.id} (${hit.date}) with no bill behind it — entering a bill would count it twice` : null;
}

async function pushBill(b, snapshots, { env = auth.qbEnv(), dryRun = true, fetchImpl } = {}) {
    const opts = { env, fetchImpl };
    // Every decision goes in the journal (helpers/quickbooks/journal.js) — only
    // on a real run; a dry run decides nothing. Apsara 2026-09-22: "everything
    // should be tracked". This is set up BEFORE the gates below, because the
    // nightly email takes its counts from the sweep but its REASONS from the
    // journal: a gate that returned early produced "blocked: 3" with nothing
    // beside it, which is a number she cannot act on.
    const journal = require('./journal');
    const jarvis = { id: b.id, container: b.container_no, invoice_no: docNumberFor(b), supplier: b.supplier, date: b.date, net_payable: b.net_payable };
    const note = (action, extra) => { if (!dryRun) journal.record({ env, kind: 'bill', action, jarvis, qb: {}, ...extra }); };

    const cut = beforeCutover('bill', b.date, env);
    if (cut) {
        if (!NEEDS_FIX.test(cut)) return { status: 'before-cutover', problems: [cut] };
        note('blocked', { reason: cut });
        return { status: 'blocked', problems: [cut] };
    }
    // With no date rule, this is what stands in its place: a container whose
    // cost is already in the books on a cheque, with no document to find.
    if (b.container_no) {
        const paidAlready = await costAlreadyOnACheque(b.container_no, { env }).catch(() => null);
        if (paidAlready) { note('asked', { reason: paidAlready }); return { status: 'ask', problems: [paidAlready] }; }
    }
    const key = linkKey(env, 'bill', b.id || b.container_no);
    const linked = loadLinks()[key];
    if (linked) return { status: 'already-linked', qbId: linked.qbId };

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

module.exports = { isoDate, pairFits, UNREADABLE, NEEDS_FIX, todayISO, cutValue, cutRaw, cutoverRaw, cutoverIsRolling, docNumberFor, confirmedName, idByName, ensureSandbox, saveLink, linkKey, cutoverFor, cutoverSource, cutoverStore, saveCutover, setCutover, clearCutover, costAlreadyOnACheque, beforeCutover, buildBill, resolveRefs, findExisting, findExistingDoc, judgeExisting, pushBill, loadLinks, LINKS_FILE, DOC_MAX };
