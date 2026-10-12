// ── helpers/qbDocNumbers.js — numbers QuickBooks made that Jarvis left blank ─
// Apsara, 2026-10-12: "There are some invoices / bills which are empty here
// but in quickbook some random invoice number and bill number is generated.
// Find them and put it back in jarvis so that i can reference it later."
// And on the nightly sweep: "if invoice no and bill no is empty in sheet but
// it is there in quickbook — keep it as per quickbook. I don't want to make
// them back to empty on daily sweep."
//
// WHAT THIS DOES
//   · finds Jarvis sales / bills whose Invoice no. is blank,
//   · finds the QuickBooks invoice / bill for the same container,
//   · says how sure it is, and — only on request — writes the number into the
//     normal Invoice no. field.
//
// SURE, OR IT IS ONLY LISTED. A row is "sure" only when ALL of these hold:
//   1. exactly ONE QuickBooks document (invoice for a sale, bill for a bill)
//      carries that container;
//   2. that document has a number of its own;
//   3. the party agrees (loose name match);
//   4. the total agrees to the cent.
// Anything else is "ask" with the reason printed. A wrong invoice number on a
// customer document is worse than a blank one, so doubt means "she decides".
//
// READ-ONLY WITHOUT apply. This module never calls QuickBooks to write and
// never changes a QuickBooks record; it only reads a snapshot or runs a
// read query. The sweep's side of the same request (a blank no longer makes
// a duplicate) lives in helpers/metalsSheetSync.js.

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const CONTAINER = /[A-Z]{4}\d{7}/g;
const norm = (v) => String(v == null ? '' : v).trim();
const flat = (v) => norm(v).toUpperCase().replace(/[^A-Z0-9]/g, '');

// Container numbers in a QuickBooks document: the line descriptions AND the
// memo (her bills list the containers in PrivateNote).
function containersOfDoc(doc) {
    const text = [(doc.Line || []).map((l) => l.Description || '').join(' '), doc.PrivateNote || ''].join(' ').toUpperCase();
    return [...new Set(text.match(CONTAINER) || [])];
}

// Normalised QuickBooks documents: { kind, id, doc, date, party, containers, total }.
function fromQuickBooks({ invoices = [], bills = [] }) {
    const shape = (kind, x, ref) => ({
        kind, id: String(x.Id), doc: norm(x.DocNumber), date: String(x.TxnDate || '').slice(0, 10),
        party: norm((x[ref] || {}).name), containers: containersOfDoc(x), total: r2(x.TotalAmt),
        text: [x.PrivateNote, (x.Line || []).map((l) => l.Description).filter(Boolean).join(' ')].join(' ').toUpperCase().replace(/[^A-Z0-9]/g, ''),
        memo: [x.PrivateNote, (x.Line || []).map((l) => l.Description).filter(Boolean).join(' / ')].filter(Boolean).join(' | ').replace(/\s+/g, ' ').slice(0, 140),
    });
    return [...invoices.map((x) => shape('invoice', x, 'CustomerRef')), ...bills.map((x) => shape('bill', x, 'VendorRef'))];
}

// ── HER CONTAINER NUMBERS ARE NOT ALWAYS 4 LETTERS + 7 DIGITS ────────────────
// The first live run (2026-10-12) missed four bills whose QuickBooks memo was
// exactly the container, same party, same total to the cent: EMHU260742,
// EMHU273618, UMXU935580, UMXU268411 — six digits, no check digit. The
// 4+7 pattern above never saw them. So a Jarvis container that looks like a
// container at all (4 letters + 6 or 7 digits) is also looked for AS TYPED in
// the document's text. Reference numbers (4009760, PO#...) are never searched
// this way: a bare number inside free text is not proof of anything.
const CONTAINERISH = /^[A-Z]{4}\d{6,7}$/;

// The same shape out of the nightly snapshot rows (helpers/quickbooks/snapshot.js),
// which keep only the first container: a document with more is marked so it can
// never be called "sure" from here.
function fromSnapshot(snap) {
    const shape = (kind, x, partyKey) => ({
        kind, id: String(x.qb_id), doc: norm(x.doc_no), date: x.date, party: norm(x[partyKey]),
        containers: x.container_no ? [String(x.container_no).toUpperCase()] : [],
        multi: (x.containers || 0) > 1, total: r2(x.total),
    });
    return [...(snap.invoices || []).map((x) => shape('invoice', x, 'customer')), ...(snap.bills || []).map((x) => shape('bill', x, 'supplier'))];
}

const partyAgrees = (a, b) => { const x = flat(a), y = flat(b); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };

// ── Jarvis side, grouped the way the document is ────────────────────────────
// A sale is one row per grade; the invoice number belongs to the invoice, so
// the blank rows of one booking + container + customer are ONE candidate and
// get the same number. A bill is one row per container.
function groupSales(sales, withTotals) {
    const groups = new Map();
    for (const s of sales) {
        if (norm(s.invoice_no) || !norm(s.container_no)) continue;
        const k = [flat(s.booking_no), flat(s.container_no), flat(s.customer)].join('|');
        if (!groups.has(k)) groups.set(k, { kind: 'invoice', store: 'sales', container: norm(s.container_no).toUpperCase(),
            party: norm(s.customer), date: s.date, ids: [], total: 0 });
        const g = groups.get(k); g.ids.push(s.id); g.total = r2(g.total + (Number(withTotals(s).amount) || 0));
    }
    return [...groups.values()];
}
// The number push.js gives a row with no container: LOCAL-<yymmdd>-<last 6 of
// the id>. Rows pushed that way carry it in QuickBooks while Jarvis kept the
// field blank, so it can be recomputed exactly — no guessing from amounts.
function localDocFor(r) {
    let d = norm(r.date);
    if (!/^\d{4}-\d{2}-\d{2}/.test(d)) { try { d = require('./bills').sortableDate(d) || ''; } catch (e) { d = ''; } }
    const ymd = d.replace(/-/g, '').slice(2, 8);
    const id = norm(r.id).replace(/[^A-Za-z0-9]/g, '').slice(-6).toUpperCase();
    return ymd.length === 6 && id ? `LOCAL-${ymd}-${id}` : '';
}
function groupBills(bills, withTotals) {
    const out = [];
    for (const b of bills) {
        if (norm(b.invoice_no) || !norm(b.container_no)) continue;
        // Push builds the QuickBooks bill at net_payable (amount less trucking).
        const t = withTotals(b);
        out.push({ kind: 'bill', store: 'bills', container: norm(b.container_no).toUpperCase(), party: norm(b.supplier),
            date: b.date, ids: [b.id], total: r2(t.net_payable != null ? t.net_payable : t.amount), localDoc: localDocFor(b) });
    }
    return out;
}

function judge(group, qbDocs) {
    const base = { ...group, qb: null, status: 'ask', why: '' };
    // Exactly the number Jarvis would have made for this row: no doubt about whose it is.
    if (group.localDoc) {
        const mine = qbDocs.filter((d) => d.kind === group.kind && d.doc === group.localDoc);
        if (mine.length === 1) {
            const d = mine[0];
            if (!partyAgrees(group.party, d.party)) return { ...base, qb: d, why: `Jarvis's own number ${d.doc} exists, but the party differs: "${group.party}" vs "${d.party}"` };
            if (Math.abs(group.total - d.total) >= 0.005) return { ...base, qb: d, why: `Jarvis's own number ${d.doc} exists, but total differs: Jarvis ${group.total} vs QuickBooks ${d.total}` };
            return { ...base, qb: d, status: 'sure', why: 'the LOCAL number Jarvis made for this row, same party, same total' };
        }
    }
    const asTyped = CONTAINERISH.test(flat(group.container)) ? flat(group.container) : null;
    const hits = qbDocs.filter((d) => d.kind === group.kind
        && (d.containers.includes(group.container) || (asTyped && d.text && d.text.includes(asTyped))));
    if (!hits.length) return { ...base, status: 'none', why: 'no QuickBooks document carries this container' };
    if (hits.length > 1) return { ...base, qb: hits, why: `${hits.length} QuickBooks documents carry this container (${hits.map((h) => '#' + h.id + ' ' + (h.doc || 'no number')).join(', ')})` };
    const d = hits[0];
    const out = { ...base, qb: d };
    if (!d.doc) return { ...out, status: 'none', why: `QuickBooks #${d.id} has no number either` };
    if (d.multi || d.containers.length > 1) return { ...out, why: `QuickBooks ${d.doc} covers several containers, so its number is not this row's alone` };
    if (!partyAgrees(group.party, d.party)) return { ...out, why: `party differs: Jarvis "${group.party}" vs QuickBooks "${d.party}"` };
    if (Math.abs(group.total - d.total) >= 0.005) return { ...out, why: `total differs: Jarvis ${group.total} vs QuickBooks ${d.total}` };
    return { ...out, status: 'sure', why: 'one document, same party, same total' };
}

// ── SECOND LOOK: SAME PARTY, SAME TOTAL, CONTAINER NOT NAMED ───────────────
// The container search finds nothing when QuickBooks documents do not name the
// container in a line or memo. For those rows (status 'none', money on them),
// look for a document of the same kind, same party, same total to the cent.
// NEVER 'sure': a matching amount is a lead, not proof — she decides.
function byAmount(results, qbDocs) {
    return results.map((r) => {
        if (r.status !== 'none' || !(r.total > 0)) return r;
        const hits = qbDocs.filter((d) => d.kind === r.kind && d.doc && Math.abs(d.total - r.total) < 0.005 && partyAgrees(r.party, d.party));
        if (!hits.length) return r;
        return { ...r, status: 'ask', qb: hits.length === 1 ? hits[0] : hits,
            why: hits.length === 1
                ? `same party and total, container not named — QuickBooks #${hits[0].id} dated ${hits[0].date}: "${hits[0].memo || 'no memo'}"`
                : `${hits.length} QuickBooks documents share this party and total (${hits.map((h) => h.doc).join(', ')})` };
    });
}

// Pure: what the lists would say.
function plan({ sales, bills, qbDocs, salesWithTotals, billsWithTotals }) {
    return [...groupSales(sales, salesWithTotals), ...groupBills(bills, billsWithTotals)].map((g) => judge(g, qbDocs));
}

// Writes the number into the normal Invoice no. field on every row of each
// SURE group. `edit` is injected (sales.editSale / bills.editBill) so a test
// never reaches the live ledgers. Re-checks that the row is STILL blank, so a
// number she typed since the list was made is never overwritten.
async function apply(results, { editSale, editBill, getSale, getBill }) {
    const done = [], skipped = [];
    for (const r of results.filter((x) => x.status === 'sure')) {
        for (const id of r.ids) {
            const cur = r.store === 'sales' ? getSale(id) : getBill(id);
            if (!cur || norm(cur.invoice_no)) { skipped.push({ id, container: r.container, why: 'no longer blank' }); continue; }
            if (r.store === 'sales') await editSale(id, { invoice_no: r.qb.doc }); else await editBill(id, { invoice_no: r.qb.doc });
            done.push({ id, container: r.container, store: r.store, invoice_no: r.qb.doc });
        }
    }
    return { done, skipped };
}

module.exports = { byAmount, containersOfDoc, fromQuickBooks, fromSnapshot, groupSales, groupBills, judge, plan, apply, partyAgrees };
