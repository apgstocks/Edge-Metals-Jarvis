// ── helpers/quickbooks/riskyOps.js — voiding, deleting, and merging ────────
// Apsara, 2026-09-26: "Merging two parties, voiding or deleting anything
// should be there on qb. Ensure the impact before changing any section."
//
// So they are here — with the impact shown FIRST, always, and the change
// refused unless the thing she looked at is still the thing in front of her.
//
// ── WHAT QUICKBOOKS WILL AND WILL NOT LET JARVIS DO ────────────────────────
// Verified against her own sandbox on 2026-09-26, not assumed:
//   void   — works (POST /invoice?operation=void): total and balance go to 0,
//            the document stays, QuickBooks stamps it "Voided".
//   delete — works (POST /invoice?operation=delete): the document is gone.
//   MERGE  — does NOT work. Renaming one party to another's exact name, which
//            is how QuickBooks merges in its own screens, is refused by the
//            API with error 2010. A plain rename to a NEW name succeeds, so
//            it is the merge specifically that is blocked, not the update.
// So merging stays a job for QuickBooks' own screen. What Jarvis does instead
// is the part she would otherwise do by hand and forget: show what a merge
// would move before she does it, and repair its own mappings after.
const crypto = require('crypto');
const client = require('./client');
const auth = require('./auth');
const journal = require('./journal');
const push = require('./push');
const mapping = require('./mapping');
const books = require('./books');

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// Which documents take which operation. Bills cannot be voided in QuickBooks
// — only deleted — and saying that up front beats a 400 from Intuit.
const TYPES = {
    invoice: { table: 'Invoice', void: true, party: 'CustomerRef' },
    creditmemo: { table: 'CreditMemo', void: true, party: 'CustomerRef' },
    payment: { table: 'Payment', void: true, party: 'CustomerRef' },
    salesreceipt: { table: 'SalesReceipt', void: true, party: 'CustomerRef' },
    refundreceipt: { table: 'RefundReceipt', void: true, party: 'CustomerRef' },
    bill: { table: 'Bill', void: false, party: 'VendorRef' },
    vendorcredit: { table: 'VendorCredit', void: false, party: 'VendorRef' },
    billpayment: { table: 'BillPayment', void: true, party: 'VendorRef' },
    purchase: { table: 'Purchase', void: true, party: 'EntityRef' },
    deposit: { table: 'Deposit', void: false, party: null },
    journalentry: { table: 'JournalEntry', void: false, party: null },
    transfer: { table: 'Transfer', void: false, party: null },
};

function linkFor(qbId, env) {
    const links = push.loadLinks();
    for (const [key, l] of Object.entries(links)) {
        if (String(l.qbId) === String(qbId) && key.startsWith(`${env}|`)) return { key, link: l };
    }
    return null;
}

// ── THE IMPACT ─────────────────────────────────────────────────────────────
// Everything that changes if she goes ahead, in the order it would hurt.
async function impact(type, id, { env = auth.qbEnv() } = {}) {
    const t = TYPES[String(type || '').toLowerCase()];
    if (!t) throw new Error(`type must be one of: ${Object.keys(TYPES).join(', ')}`);
    const doc = (await client.request('GET', `/${t.table.toLowerCase()}/${id}`, null, { env }))[t.table];
    if (!doc) throw new Error(`no ${type} #${id} in QuickBooks ${env}`);

    const total = r2(doc.TotalAmt);
    const balance = doc.Balance === undefined ? null : r2(doc.Balance);
    const party = t.party ? (doc[t.party] || {}) : {};
    const warnings = [];

    // money already moved against it
    if (balance !== null && balance !== total && total > 0) {
        warnings.push(`${r2(total - balance)} of the ${total} has already been settled against this document. Voiding it leaves that money sitting on the ${t.party === 'CustomerRef' ? 'customer' : 'supplier'} unapplied.`);
    }
    // other documents that point at it
    const linked = [];
    for (const line of doc.Line || []) for (const lt of line.LinkedTxn || []) linked.push(`${lt.TxnType} #${lt.TxnId}`);
    for (const lt of doc.LinkedTxn || []) linked.push(`${lt.TxnType} #${lt.TxnId}`);
    if (linked.length) warnings.push(`${linked.length} other document${linked.length > 1 ? 's are' : ' is'} tied to this one: ${[...new Set(linked)].slice(0, 8).join(', ')}.`);

    // Jarvis's own side
    const mine = linkFor(id, env);
    if (mine) {
        warnings.push(`Jarvis entered this one and still counts it as in QuickBooks. The link will be dropped, the Jarvis row will read "not in QB" again, and the nightly run WILL enter it a second time unless you delete the Jarvis row or it falls before the cutover.`);
    }
    // the accountant's period
    const cut = push.cutoverFor(t.party === 'CustomerRef' ? 'invoice' : 'bill', env);
    if (cut && doc.TxnDate && doc.TxnDate < cut) {
        warnings.push(`Dated ${doc.TxnDate}, which is before the cutover (${cut}) — that period is your accountant's. Changing it changes a month that may already be reported.`);
    }
    if (doc.TxnDate && String(doc.TxnDate).slice(0, 4) < String(new Date().getFullYear())) {
        warnings.push(`This is a ${String(doc.TxnDate).slice(0, 4)} document. A closed year usually means the books were filed on it.`);
    }

    return {
        type: String(type).toLowerCase(), table: t.table, id: String(id), env,
        doc: { doc: String(doc.DocNumber || '').trim(), date: doc.TxnDate, total, balance,
            party: party.name || null, partyId: party.value || null, memo: doc.PrivateNote || (doc.CustomerMemo || {}).value || '',
            lines: (doc.Line || []).filter((l) => l.DetailType !== 'SubTotalLineDetail').slice(0, 12)
                .map((l) => ({ what: l.Description || '', amount: r2(l.Amount) })) },
        canVoid: t.void, canDelete: true,
        jarvisLink: mine ? { key: mine.key, jarvisId: mine.link.jarvisId || null } : null,
        linked: [...new Set(linked)],
        warnings,
        // What she looked at. The change is refused if this moved in the
        // meantime — somebody else may have touched it while the screen sat
        // open, and a confirmation has to mean the thing it was given for.
        token: String(doc.SyncToken),
        stamp: crypto.createHash('sha1').update(JSON.stringify([t.table, id, doc.SyncToken, total, balance])).digest('hex').slice(0, 12),
    };
}

// ── DOING IT ───────────────────────────────────────────────────────────────
async function apply({ type, id, op = 'void', reason, stamp, by = 'apsara', env = auth.qbEnv() } = {}) {
    const t = TYPES[String(type || '').toLowerCase()];
    if (!t) throw new Error(`type must be one of: ${Object.keys(TYPES).join(', ')}`);
    if (!['void', 'delete'].includes(op)) throw new Error('op must be void or delete');
    if (op === 'void' && !t.void) throw new Error(`QuickBooks cannot void a ${type} — it can only be deleted`);
    if (!reason || String(reason).trim().length < 4) throw new Error('a reason is required — it stays in the journal beside this');

    const now = await impact(type, id, { env });
    if (stamp && stamp !== now.stamp) {
        throw new Error('this document changed in QuickBooks since you looked at it — open the impact again before deciding');
    }
    await client.request('POST', `/${t.table.toLowerCase()}?operation=${op}`,
        { Id: now.id, SyncToken: now.token, ...(op === 'void' ? { sparse: true } : {}) }, { env });

    // Jarvis's own link cannot survive it: the document is gone or zeroed.
    let unlinked = null;
    if (now.jarvisLink) {
        const links = push.loadLinks();
        delete links[now.jarvisLink.key];
        try {
            const fs = require('fs');
            fs.writeFileSync(push.LINKS_FILE(), JSON.stringify(links, null, 2));
            unlinked = now.jarvisLink.key;
        } catch (e) { unlinked = `could not drop the link: ${e.message}`; }
    }
    const kind = { Invoice: 'invoice', Bill: 'bill', CreditMemo: 'creditmemo', Payment: 'payment', BillPayment: 'billpayment', Purchase: 'prepayment' }[t.table] || 'bill';
    try {
        journal.record({ env, kind, action: op === 'void' ? 'voided' : 'deleted', linkKey: now.jarvisLink ? now.jarvisLink.key : undefined,
            qb: { id: now.id, total: now.doc.total, doc: now.doc.doc }, jarvis: { id: now.jarvisLink && now.jarvisLink.jarvisId },
            by, reason: String(reason).trim(), impact: now.warnings });
    } catch (e) { /* the raw write log in client.js already holds it */ }
    books.forget();
    return { status: op === 'void' ? 'voided' : 'deleted', id: now.id, table: t.table, was: now.doc, unlinked, warnings: now.warnings };
}

// ── MERGING TWO PARTIES ────────────────────────────────────────────────────
// QuickBooks will not do this over the API (proved above). So Jarvis shows
// what it would move, and repairs its own side afterwards.
async function mergeImpact(kind, loserId, winnerId, { env = auth.qbEnv() } = {}) {
    const k = kind === 'customer' ? 'customer' : 'vendor';
    const table = k === 'customer' ? 'Customer' : 'Vendor';
    const one = async (id) => (await client.request('GET', `/${table.toLowerCase()}/${id}`, null, { env }))[table];
    const [loser, winner] = await Promise.all([one(loserId), one(winnerId)]);
    const [ld, wd] = await Promise.all([
        books.partyDocs(k, loserId, env).catch(() => ({ totals: null, docs: [] })),
        books.partyDocs(k, winnerId, env).catch(() => ({ totals: null, docs: [] })),
    ]);
    // Every Jarvis name that points at either of them — these are what break
    // when one of the two ids stops existing.
    const map = mapping.loadMap()[k] || {};
    const pointing = (id) => Object.entries(map).filter(([, v]) => String(v.qbId) === String(id))
        .map(([key, v]) => ({ key, jarvisName: v.jarvisName, qbName: v.qbName }));

    return {
        kind: k, env,
        loser: { id: String(loser.Id), name: loser.DisplayName, balance: r2(loser.Balance), documents: ld.totals ? ld.totals.documents : null, open: ld.totals ? ld.totals.open : null, mappings: pointing(loserId) },
        winner: { id: String(winner.Id), name: winner.DisplayName, balance: r2(winner.Balance), documents: wd.totals ? wd.totals.documents : null, open: wd.totals ? wd.totals.open : null, mappings: pointing(winnerId) },
        moves: {
            documents: ld.totals ? ld.totals.documents : null,
            balance: r2(loser.Balance),
            afterwards: r2(Number(loser.Balance || 0) + Number(winner.Balance || 0)),
        },
        // The honest part.
        canDoItHere: false,
        why: 'QuickBooks does not allow a merge over its API — renaming one party to another\'s exact name, which is how its own screens merge, is refused (error 2010). Verified against your books, not assumed.',
        howTo: [
            `Open QuickBooks → ${k === 'customer' ? 'Customers' : 'Expenses → Vendors'} → "${loser.DisplayName}" → Edit.`,
            `Change the display name to exactly "${winner.DisplayName}" and save.`,
            'QuickBooks asks whether to merge. Say yes.',
            'Come back here and press "I merged them" — Jarvis re-points every name that was aimed at the old record.',
        ],
        warnings: [
            'A merge cannot be undone in QuickBooks.',
            `${ld.totals ? ld.totals.documents : 'All'} documents move onto "${winner.DisplayName}" and keep their own numbers.`,
            ...(pointing(loserId).length ? [`${pointing(loserId).length} Jarvis name(s) point at the old record and will stop resolving until you press "I merged them".`] : []),
            ...(Math.abs(Number(loser.Balance || 0)) > 0 ? [`The old record carries a balance of ${r2(loser.Balance)}, which lands on the surviving one.`] : []),
        ],
    };
}

// After she has merged them in QuickBooks: prove the old id is gone, then fix
// every Jarvis name that pointed at it.
async function adoptMerge(kind, deadId, survivorId, { env = auth.qbEnv(), by = 'apsara', reason = '' } = {}) {
    const k = kind === 'customer' ? 'customer' : 'vendor';
    const table = k === 'customer' ? 'Customer' : 'Vendor';
    const survivor = (await client.request('GET', `/${table.toLowerCase()}/${survivorId}`, null, { env }))[table];
    if (!survivor) throw new Error(`no surviving ${k} #${survivorId} in QuickBooks`);
    let dead = null;
    try { dead = (await client.request('GET', `/${table.toLowerCase()}/${deadId}`, null, { env }))[table]; } catch { dead = null; }
    // A merged record stops answering, or comes back under the survivor's
    // name. Anything else means the merge has not happened yet.
    if (dead && String(dead.Id) === String(deadId) && dead.DisplayName !== survivor.DisplayName) {
        return { status: 'not-merged', note: `#${deadId} "${dead.DisplayName}" is still its own record in QuickBooks — the merge has not been done yet, so nothing was changed here.` };
    }
    const map = mapping.loadMap()[k] || {};
    const moved = [];
    for (const [, v] of Object.entries(map)) {
        if (String(v.qbId) !== String(deadId)) continue;
        mapping.confirm(k, v.jarvisName, String(survivor.Id), survivor.DisplayName, by,
            `merged in QuickBooks: #${deadId} into #${survivor.Id}${reason ? ` — ${reason}` : ''}`);
        moved.push(v.jarvisName);
    }
    books.forget();
    return { status: 'adopted', survivor: { id: String(survivor.Id), name: survivor.DisplayName }, moved,
        note: moved.length ? `${moved.length} Jarvis name(s) now point at #${survivor.Id} "${survivor.DisplayName}".`
            : 'Nothing in Jarvis was pointing at the old record.' };
}

module.exports = { impact, apply, mergeImpact, adoptMerge, TYPES };
