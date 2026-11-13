// ── helpers/fixIt.js — the Accounts "Fix it" brain ─────────────────────────
// Apsara, 2026-11-13/14: "Lets work on qb and books today and finish
// accounting", then "build properly", then "it should mimic human brain".
//
// WHAT "LIKE A HUMAN ACCOUNTANT'S HEAD" MEANS HERE (and what it does not):
//   PERCEIVE  look at the books the way the morning email does, but keep the
//             ROW behind every complaint, not just a count.
//   DIAGNOSE  say what is actually wrong with each row ("weight 18,000 but no
//             supplier price") instead of the symptom ("has no amount").
//   PROPOSE   one concrete fix, with how sure it is and WHY. A card is either
//             "high" (nothing contradicts it), "check" (a person should look)
//             or "ask" (it cannot be decided without her).
//   TRIAGE    biggest money and most certain first; the pile is a short list,
//             not 140 lines.
//   REMEMBER  what she dismissed stays quiet until the facts change; what she
//             approved is counted, so a kind she always approves is labelled
//             as such. Memory is data/fixit_memory.json.
//   ASK       anything it cannot decide becomes a question with a box, never a
//             guess written into the books.
//
// WHAT IT DOES NOT DO: act on its own. Every fix waits for her click (autonomy
// level L3 in docs/OWNERSHIP-PLAN.md); a kind she approves often is shown as
// such but is NOT promoted to automatic — that is her call to make, later.
//
// SAFETY, inherited rather than reinvented:
//   • deletes go through helpers/ledgerBulkDelete (archive first, restorable,
//     refuses a row with payments or a live claim);
//   • apply() RE-DERIVES the card server-side from the current books and
//     ignores whatever the browser says it was shown — a card from before
//     lunch cannot delete something that has since been paid;
//   • Edge Yard rows are never written to from here (CLAUDE.md rule 5): they
//     appear with where to fix them, because the Yard is a different company;
//   • nothing here writes to QuickBooks. A QuickBooks double entry is shown
//     with the bill id and she removes it there; "I removed it" is recorded.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('../config');

const FILE = () => path.join(cfg.DATA_DIR, 'fixit_memory.json');
const CENT = 0.005;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : 0; };
const idOf = (...parts) => crypto.createHash('sha1').update(parts.map(String).join('|')).digest('hex').slice(0, 12);

// ── memory ────────────────────────────────────────────────────────────────
function loadMemory() {
    try {
        const m = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
        return { dismissed: m.dismissed || {}, done: Array.isArray(m.done) ? m.done : [] };
    } catch (e) { return { dismissed: {}, done: [] }; }
}
function saveMemory(m) {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    const tmp = FILE() + '.tmp' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
    fs.renameSync(tmp, FILE());
}
function approvedCount(mem, kind) { return mem.done.filter((d) => d.kind === kind && d.result !== 'failed').length; }

// ── perceive: one detector per kind, each wrapped so one failing cannot hide the rest ──
function noAmountCards() {
    const P = require('./postings');
    const BB = require('./booksBuild');
    let txs = [];
    const orig = P.journal;
    P.journal = (t) => { txs = t; return orig.call(P, t); };     // sync build: nothing can interleave
    try { BB.build({}); } finally { P.journal = orig; }
    const bad = txs.filter((t) => Math.abs(num(t.amount)) < CENT && t.kind !== 'advance-applied' && t.source);
    const cards = [];
    for (const t of bad) {
        const s = t.source;
        const company = (t.entity && /yard/i.test(String(t.entity))) || s.store === 'loads' || s.store === 'outbound_loads' ? 'yard' : 'metals';
        let raw = null;
        try {
            if (s.store === 'bills') raw = require('./bills').listWithTotals().find((r) => r.id === s.id);
            else if (s.store === 'loads') raw = require('./loads').loadLoads().find((r) => r.id === s.id);
            else if (s.store === 'outbound_loads') raw = require('./outboundLoads').loadOutboundLoads().find((r) => r.id === s.id);
            else if (s.store === 'sales') raw = require('./sales').listWithTotals().find((r) => r.id === s.id);
        } catch (e) { /* the row may be gone */ }
        const name = `${t.kind}: ${t.party || 'no party'}${t.memo ? ' · ' + t.memo : ''}${t.date ? ' · ' + t.date : ''}`;
        const ev = raw ? ['container_no', 'invoice_no', 'supplier', 'seller', 'buyer', 'gross', 'weight', 'supplier_price', 'price', 'amount', 'note']
            .filter((k) => raw[k] != null && raw[k] !== '').map((k) => `${k}: ${raw[k]}`) : ['the row can no longer be read'];
        const hasAnything = raw && ['container_no', 'invoice_no', 'supplier', 'seller', 'buyer', 'gross', 'weight', 'supplier_price', 'price']
            .some((k) => raw[k] != null && raw[k] !== '');
        const base = { kind: 'no-amount', company, title: name, evidence: ev, money: null,
                       row: { store: s.store, id: s.id } };
        if (!raw) {
            cards.push({ ...base, id: idOf('no-amount', s.store, s.id, 'gone'), diagnosis: 'The row behind this entry cannot be found any more.',
                proposal: { do: 'none', label: 'Nothing to fix here', confidence: 'check', why: 'It will drop off by itself once the books are rebuilt; if it keeps coming back, tell me.' } });
        } else if (!hasAnything && s.store === 'bills') {
            cards.push({ ...base, id: idOf('no-amount', s.store, s.id, 'empty'),
                diagnosis: 'This bill is completely empty: no container, supplier, weight or price.',
                proposal: { do: 'delete-rows', args: { kind: 'bills', ids: [s.id] }, label: 'Delete the empty bill', confidence: 'high',
                    why: 'Nothing was ever entered on it, so it cannot be a real purchase. It is archived first and can be restored.', reversible: true } });
        } else if (s.store === 'bills') {
            const missing = [];
            // bills.compute(): net = gross minus the four tares; amount = net × supplier_price.
            if (!(num(raw.gross) || num(raw.weight))) missing.push('a weight');
            if (!num(raw.supplier_price)) missing.push('a supplier price');
            cards.push({ ...base, id: idOf('no-amount', s.store, s.id, 'fill'),
                diagnosis: missing.length ? `The invoice amount is worked out from weight × price, and this bill has no ${missing.join(' and ')}.`
                                          : 'It has a weight and a price but the amount still comes out as zero.',
                ask: { field: 'supplier_invoice_amount', label: 'Supplier invoice amount ($)', hint: 'Type what the supplier invoice says; leave the weight and price as they are.' },
                proposal: { do: 'set-bill-amount', label: 'Save this amount on the bill', confidence: 'ask',
                    why: 'I cannot invent a supplier amount. Typing it here does the same as the Invoice amount box on the Bills screen.', reversible: true } });
        } else {
            cards.push({ ...base, id: idOf('no-amount', s.store, s.id, 'link'),
                diagnosis: company === 'yard' ? 'An Edge Yard row with no amount. Edge Yard is a separate company, so I will not change it from here.'
                                              : 'A row with no amount.',
                proposal: { do: 'open', label: company === 'yard' ? 'Fix it on the Loads / Outbound screen' : 'Fix it on its own screen',
                    confidence: 'check', why: 'Edge Yard and Edge Metals are kept apart on purpose; the amount is typed on the load itself.' } });
        }
    }
    return cards;
}

function duplicateInvoiceCards() {
    const opc = require('./onePerContainer');
    const sales = require('./sales');
    const bd = require('./ledgerBulkDelete');
    const rows = sales.listWithTotals();
    const out = [];
    const { found, skipped } = opc.invoices(rows);
    for (const g of found) {
        const dropRows = g.drop.flatMap((d) => d.rows);
        const money = r2(dropRows.reduce((a, r) => a + num(r.amount || r.receivable || 0), 0));
        let planned = null;
        try { planned = bd.plan('sales', dropRows.map((r) => r.id), { reason: 'Fix-it: keep latest invoice per container' }); } catch (e) { /* shown as ask */ }
        const refused = planned ? planned.refused : [];
        const clean = planned && !refused.length;
        out.push({ id: idOf('dup-invoice', g.container, g.booking, g.keep.invoice_no, dropRows.map((r) => r.id).sort().join(',')),
            kind: 'duplicate-invoice', company: 'metals', money,
            title: `${g.container}: ${g.drop.length + 1} invoices`,
            evidence: [`keep ${g.keep.invoice_no} (${g.keep.rows.length} line${g.keep.rows.length === 1 ? '' : 's'}, newest)`,
                       ...g.drop.map((d) => `drop ${d.invoice_no} (${d.rows.length} line${d.rows.length === 1 ? '' : 's'}: ${d.rows.map((r) => r.item || '—').join(', ')})`),
                       ...refused.map((x) => `cannot delete ${x.what}: ${x.why}`)],
            diagnosis: 'One container should have one invoice. The older invoice number is a repeat.',
            proposal: clean
                ? { do: 'delete-rows', args: { kind: 'sales', ids: dropRows.map((r) => r.id) }, label: `Delete the older invoice${g.drop.length > 1 ? 's' : ''}, keep ${g.keep.invoice_no}`,
                    confidence: 'high', why: 'Newest invoice stays. The older lines have no payments or open claims, and they are archived first so they can be restored.', reversible: true }
                : { do: 'none', label: 'Needs you', confidence: 'ask',
                    why: 'The older invoice has money or a claim against it, so I will not delete it. Move the payment to the kept invoice first, then this card will clear.' } });
    }
    for (const s of skipped) {
        out.push({ id: idOf('dup-invoice-skip', s.container), kind: 'duplicate-invoice', company: 'metals', money: null,
            title: `${s.container}: several invoices, cannot tell which`, evidence: [s.why], diagnosis: s.why,
            proposal: { do: 'none', label: 'Needs you', confidence: 'ask', why: 'Give the rows their invoice numbers and this will sort itself out.' } });
    }
    return out;
}

function duplicatePackingCards() {
    const opc = require('./onePerContainer');
    const pl = require('./packingList');
    return opc.packingLists(pl.list()).found.map((g) => ({
        id: idOf('dup-packing', g.container, g.drop.map((r) => r.id).sort().join(',')),
        kind: 'duplicate-packing', company: 'metals', money: null,
        title: `${g.container}: ${g.drop.length + 1} packing lists`,
        evidence: [`keep the one updated ${g.keep.updated_at || '?'}`, ...g.drop.map((r) => `drop the one updated ${r.updated_at || '?'}`)],
        diagnosis: 'One container should have one packing list.',
        proposal: { do: 'delete-packing', args: { ids: g.drop.map((r) => r.id) }, label: 'Keep the newest list, remove the others',
            confidence: 'high', why: 'Saving already replaces a list by container, so these are old leftovers. Copies are kept in deleted_packing_lists.json.', reversible: true } }));
}

function quickbooksCards() {
    const q = require('./accountsAgent').quickbooks();
    if (!q || q.missing || !Array.isArray(q.duplicates)) return [];
    return q.duplicates.map((d) => ({
        id: idOf('qb-dup', d.kind, d.ref, d.removeId || 'none'),
        kind: 'qb-duplicate', company: 'metals', money: r2(d.over),
        title: `QuickBooks ${d.kind} entered twice: ${d.who || ''} ${d.ref || ''}`.trim(),
        evidence: [`${d.why}`, d.removeId ? `delete ${d.kind} id ${d.removeId} in QuickBooks` : 'both are already paid, so neither can simply be removed',
                   q.stale ? `QuickBooks data is ${q.ageDays} day(s) old — check it is still there` : `as at ${q.at}`],
        diagnosis: `The same charge appears twice and overstates what you owe by $${r2(d.over).toLocaleString('en-US', { minimumFractionDigits: 2 })}.`,
        proposal: d.removeId
            ? { do: 'ack-qb', label: `I removed ${d.kind} ${d.removeId} in QuickBooks`, confidence: 'check',
                why: 'Same charge with different dates can also be two real charges. Look at both in QuickBooks, delete the extra one there, then tell me. Jarvis does not write to QuickBooks from here.' }
            : { do: 'none', label: 'Needs you', confidence: 'ask', why: 'Both copies are paid; this needs a decision about which payment to unwind.' } }));
}

const DETECTORS = [['no-amount', noAmountCards], ['duplicate-invoice', duplicateInvoiceCards],
                   ['duplicate-packing', duplicatePackingCards], ['qb-duplicate', quickbooksCards]];
const CONF_RANK = { high: 0, check: 1, ask: 2 };

// ── triage: certain-and-large first ─────────────────────────────────────────
function collect() {
    const mem = loadMemory();
    const cards = [], broken = [];
    for (const [name, fn] of DETECTORS) {
        try { cards.push(...fn()); } catch (e) { broken.push({ detector: name, error: String(e.message || e).slice(0, 200) }); }
    }
    const shown = [];
    let hidden = 0;
    for (const c of cards) {
        if (mem.dismissed[c.id]) { hidden++; continue; }
        const n = approvedCount(mem, c.kind);
        c.seen = n;
        if (n >= 3) c.habit = `You have approved this kind ${n} times.`;
        shown.push(c);
    }
    shown.sort((a, b) => (CONF_RANK[a.proposal.confidence] - CONF_RANK[b.proposal.confidence])
        || (Math.abs(b.money || 0) - Math.abs(a.money || 0)));
    return { at: new Date().toISOString(), cards: shown, hidden, broken,
             counts: shown.reduce((m, c) => { m[c.kind] = (m[c.kind] || 0) + 1; return m; }, {}) };
}

// ── act ─────────────────────────────────────────────────────────────────────
async function apply(cardId, { value, note } = {}) {
    // Re-derived, never trusted from the client.
    const all = []; for (const [, fn] of DETECTORS) { try { all.push(...fn()); } catch (e) { /* that detector is down */ } }
    const card = all.find((c) => c.id === cardId);
    if (!card) throw new Error('That card is no longer true — the books have changed since you opened it. Reload.');
    const p = card.proposal;
    const mem = loadMemory();
    const record = (result, extra) => { mem.done.push({ id: cardId, kind: card.kind, what: card.title, at: new Date().toISOString(), result, note: note || null, ...extra }); saveMemory(mem); };
    let out = { ok: true };
    try {
        if (p.do === 'delete-rows') {
            const bd = require('./ledgerBulkDelete');
            const planned = bd.plan(p.args.kind, p.args.ids, { reason: 'Fix-it: ' + card.title });
            if (!planned.going.length) throw new Error('Nothing could be deleted: ' + planned.refused.map((x) => x.why).join('; '));
            const res = await bd.commit(planned);
            for (const row of planned.going) {
                try { require('./quickbooks/sync').after(p.args.kind === 'bills' ? 'bill' : 'sale', String(row.id), 'deleted'); } catch (e) { /* rows already gone */ }
            }
            out = { ok: true, removed: res.removed, batch: res.batch, refused: planned.refused };
        } else if (p.do === 'delete-packing') {
            const pl = require('./packingList');
            const arch = path.join(path.dirname(cfg.PACKING_LISTS_FILE), 'deleted_packing_lists.json');
            let old = []; try { old = JSON.parse(fs.readFileSync(arch, 'utf8')); } catch (e) { /* none yet */ }
            const gone = pl.list().filter((r) => p.args.ids.includes(r.id));
            fs.writeFileSync(arch, JSON.stringify(old.concat(gone.map((r) => ({ ...r, _deleted_at: new Date().toISOString() }))), null, 2));
            for (const r of gone) await pl.remove(r.id);
            out = { ok: true, removed: gone.length };
        } else if (p.do === 'set-bill-amount') {
            const amt = num(value);
            if (!(amt > 0)) throw new Error('Type an amount above zero.');
            await require('./bills').editBill(card.row.id, { supplier_invoice_amount: amt });
            out = { ok: true, set: amt };
        } else if (p.do === 'ack-qb') {
            out = { ok: true, note: 'Noted. It stays hidden while QuickBooks still lists it only if you dismiss it; otherwise it clears when the next QuickBooks pull no longer has it.' };
        } else {
            throw new Error('This one cannot be done from here: ' + p.why);
        }
    } catch (e) { record('failed', { error: e.message }); throw e; }
    record('applied', { batch: out.batch || null });
    return out;
}

function dismiss(cardId, note) {
    const mem = loadMemory();
    mem.dismissed[cardId] = { at: new Date().toISOString(), note: String(note || '').slice(0, 300) || null };
    saveMemory(mem);
    return { ok: true };
}
function undismiss(cardId) { const mem = loadMemory(); delete mem.dismissed[cardId]; saveMemory(mem); return { ok: true }; }

module.exports = { collect, apply, dismiss, undismiss, loadMemory, _FILE: FILE };
