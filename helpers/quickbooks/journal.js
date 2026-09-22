// ── helpers/quickbooks/journal.js — every match, kept, and undoable ─────────
// Apsara, 2026-09-22: "Log this matching of payments. we might need to find
// any discrepancy in payments later and might undo it."
//
// Three jobs, one file:
//   RECORD      every decision Jarvis makes about her books — created, linked
//               to something already there, asked her, blocked — with what it
//               saw at the time: Jarvis's figures, QuickBooks's figures, which
//               bills/invoices a payment was matched to, and why.
//   DISCREPANCY read every record Jarvis created or linked back out of
//               QuickBooks and say where it no longer agrees: deleted, total
//               changed, re-pointed to other bills, moved to another party.
//               Read-only. This is the "find it later" half.
//   UNDO        take back one thing Jarvis did.
//
// ── THE RULES OF UNDO ───────────────────────────────────────────────────────
//   · a LINK to something already in her books is undone by forgetting the
//     link. The record itself is hers (or her accountant's) and Jarvis never
//     deletes what it did not create.
//   · something Jarvis CREATED is deleted — but only if nobody has touched it
//     since: same SyncToken as when Jarvis made it, and for a bill or invoice,
//     nothing paid against it. Otherwise it is refused with the reason; a
//     record someone else has built on is a conversation, not a button.
//   · payments before the documents they pay: a bill/invoice whose Jarvis
//     payment is still standing is refused until that payment is undone.
//   · the full QuickBooks record is copied into the journal BEFORE it is
//     deleted, so an undo can itself be reconstructed.
//   · in her live books a delete is still a write: client.js refuses it while
//     QB_PROD_WRITES is not "on".
//
// The journal is append-only JSON lines. Nothing in it is ever rewritten —
// "undone" is a new line pointing at the old one, not an edit of the old one.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('../../config');
const client = require('./client');
const auth = require('./auth');

const JOURNAL_FILE = () => process.env.QB_JOURNAL_FILE || path.join(DATA_DIR, 'qb-journal.jsonl');
const LINKS_FILE = () => process.env.QB_LINKS_FILE || path.join(DATA_DIR, 'qb-links.json');
const QB_TYPE = { bill: 'Bill', invoice: 'Invoice', billpayment: 'BillPayment', payment: 'Payment', creditmemo: 'CreditMemo' };
const ACTIONS = ['created', 'linked-existing', 'asked', 'blocked', 'undone', 'unlinked', 'discrepancy'];
const round2 = (n) => Math.round(Number(n) * 100) / 100;

// A crash can leave a half-written last line. Appending straight after it
// would glue the next entry onto the torn one and lose BOTH — so a missing
// final newline is closed off first. (Found by the test, not in the wild.)
function appendLine(obj) {
    const f = JOURNAL_FILE();
    let needsNl = false;
    try {
        const fd = fs.openSync(f, 'r'); const size = fs.fstatSync(fd).size;
        if (size > 0) { const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, size - 1); needsNl = b[0] !== 10; }
        fs.closeSync(fd);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    fs.appendFileSync(f, (needsNl ? '\n' : '') + JSON.stringify(obj) + '\n');
}

// What a bill/invoice/credit memo SAYS, not its version number. QuickBooks
// bumps SyncToken on a bill whenever a payment is linked to it — found
// 2026-09-22 when paying sandbox bill #145 made the check call it "edited".
// So documents are compared by content; payments keep the SyncToken test.
function fingerprint(x) {
    if (!x) return null;
    const party = (x.VendorRef || x.CustomerRef || {}).value;
    const lines = (x.Line || []).filter((l) => l.DetailType !== 'SubTotalLineDetail').map((l) => {
        const d = l.ItemBasedExpenseLineDetail || l.SalesItemLineDetail || l.AccountBasedExpenseLineDetail || {};
        return [round2(l.Amount), (d.ItemRef || d.AccountRef || {}).value || '', d.Qty ?? '', d.UnitPrice ?? ''].join('|');
    }).sort();
    return crypto.createHash('sha1').update(JSON.stringify([x.DocNumber || '', x.TxnDate || '', party || '', round2(x.TotalAmt), lines])).digest('hex').slice(0, 16);
}
const IS_DOC = (k) => k === 'bill' || k === 'invoice' || k === 'creditmemo';

function newId() { return `J_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`; }

// ── EVERY WRITE, WITHOUT EXCEPTION ──────────────────────────────────────────
// Apsara, 2026-09-22: "keep track of whatever's marked in qb, everything should
// be tracked." The decision entries above are written by the push code; this
// is the floor beneath them. client.js calls recordWrite for EVERY non-GET
// request — before it is sent (intent) and after (done / failed). If the
// intent line cannot be written, client.js refuses to send: a write Jarvis
// cannot log is a write Jarvis does not make. So even code that forgets to
// journal its decision still leaves a trace of what reached her books.
function recordWrite({ env, phase, method, path: p, body, result, error, writeId }) {
    const entry = { id: writeId || newId(), at: new Date().toISOString(), env: env || auth.qbEnv(), kind: 'raw', action: 'write', phase, method, path: p };
    if (phase === 'intent') entry.body = body;
    if (phase === 'done') entry.result = result;
    if (phase === 'failed' || phase === 'refused') entry.error = String(error || '').slice(0, 500);
    appendLine(entry);
    return entry;
}

// intent lines with no done/failed after them: the process died mid-write, so
// whether it reached QuickBooks is unknown — the discrepancy check lists them.
function unfinishedWrites(env = auth.qbEnv()) {
    const open = new Map();
    for (const e of list({ env, kind: 'raw' })) {
        if (e.phase === 'intent') open.set(e.id, e); else if (e.phase !== 'refused') open.delete(e.id);
    }
    return [...open.values()];
}

function record(e) {
    if (!QB_TYPE[e.kind]) throw new Error(`journal kind must be ${Object.keys(QB_TYPE).join('|')}, got ${e.kind}`);
    if (!ACTIONS.includes(e.action)) throw new Error(`journal action must be ${ACTIONS.join('|')}, got ${e.action}`);
    const entry = { id: newId(), at: new Date().toISOString(), env: e.env || auth.qbEnv(), by: e.by || 'jarvis', ...e };
    appendLine(entry);
    return entry;
}

function list(filter = {}) {
    let raw = '';
    try { raw = fs.readFileSync(JOURNAL_FILE(), 'utf8'); } catch { return []; }
    const out = [];
    for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* a torn last line is skipped, never fatal */ }
    }
    return out.filter((e) => Object.entries(filter).every(([k, v]) => e[k] === v));
}

// The one current state per link key: the last created/linked entry not
// followed by an undone/unlinked for it.
function active(env = auth.qbEnv()) {
    const state = new Map();
    for (const e of list({ env })) {
        if (!e.linkKey) continue;
        if (e.action === 'created' || e.action === 'linked-existing') state.set(e.linkKey, e);
        if (e.action === 'undone' || e.action === 'unlinked') state.delete(e.linkKey);
    }
    return [...state.values()];
}

function loadLinks() { try { return JSON.parse(fs.readFileSync(LINKS_FILE(), 'utf8')); } catch { return {}; } }
function writeLinks(all) { const f = LINKS_FILE(), tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(all, null, 2)); fs.renameSync(tmp, f); }

// ── DISCREPANCIES — read-only ──────────────────────────────────────────────
async function discrepancies({ env = auth.qbEnv(), fetchImpl } = {}) {
    const opts = { env, fetchImpl };
    const out = [];
    for (const e of active(env)) {
        const type = QB_TYPE[e.kind];
        let now = null;
        try { now = (await client.request('GET', `/${type.toLowerCase()}/${e.qb.id}`, null, opts))[type]; }
        catch (err) { if (err.status === 400 || err.status === 404) now = null; else throw err; }
        const issues = [];
        if (!now) issues.push('no longer in QuickBooks (deleted or voided)');
        else {
            if (e.qb.total != null && round2(now.TotalAmt) !== round2(e.qb.total)) issues.push(`total was ${e.qb.total}, now ${now.TotalAmt}`);
            const party = (now.VendorRef || now.CustomerRef || {}).value;
            if (e.qb.partyId && party && String(party) !== String(e.qb.partyId)) issues.push(`moved from ${e.qb.party || e.qb.partyId} to ${(now.VendorRef || now.CustomerRef).name}`);
            if (e.qb.linked) {
                const nowLinked = (now.Line || []).flatMap((l) => (l.LinkedTxn || []).map((t) => `${t.TxnType}:${t.TxnId}:${round2(l.Amount)}`)).sort().join(',');
                const was = e.qb.linked.map((t) => `${t.type}:${t.id}:${round2(t.amount)}`).sort().join(',');
                if (nowLinked !== was) issues.push(`now pays ${nowLinked || 'nothing'}; Jarvis matched ${was}`);
            }
            if (e.jarvisTotal != null && round2(now.TotalAmt) !== round2(e.jarvisTotal)) issues.push(`QuickBooks ${now.TotalAmt} vs Jarvis ${e.jarvisTotal}`);
            if (e.action === 'created') {
                if (IS_DOC(e.kind)) { if (e.qb.fp && fingerprint(now) !== e.qb.fp) issues.push('edited in QuickBooks since Jarvis created it (lines, date, number or party changed)'); }
                else if (e.qb.syncToken != null && String(now.SyncToken) !== String(e.qb.syncToken)) issues.push('edited in QuickBooks since Jarvis created it');
            }
        }
        if (issues.length) out.push({ journalId: e.id, kind: e.kind, linkKey: e.linkKey, jarvis: e.jarvis, qbId: e.qb.id, issues });
    }
    for (const w of unfinishedWrites(env)) {
        out.push({ journalId: w.id, kind: 'raw', qbId: null, issues: [`${w.method} ${w.path} was started ${w.at} and never confirmed — check QuickBooks by hand`] });
    }
    return out;
}

// ── UNDO ────────────────────────────────────────────────────────────────────
async function undo(journalId, { env = auth.qbEnv(), fetchImpl, dryRun = true, by = 'apsara', reason = '' } = {}) {
    const opts = { env, fetchImpl };
    const e = list({ env }).find((x) => x.id === journalId);
    if (!e) return { status: 'refused', why: `no journal entry ${journalId} in ${env}` };
    const current = active(env).find((x) => x.linkKey === e.linkKey);
    if (!current || current.id !== e.id) return { status: 'refused', why: 'not the standing entry for this record — already undone, or superseded' };
    if (!String(reason).trim()) return { status: 'refused', why: 'an undo needs a reason — it stays in the journal' };

    if (e.action === 'linked-existing') {
        if (dryRun) return { status: 'would-unlink', note: `forget the link to ${QB_TYPE[e.kind]} #${e.qb.id}; the record stays in QuickBooks untouched` };
        const links = loadLinks(); delete links[e.linkKey]; writeLinks(links);
        const u = record({ env, kind: e.kind, action: 'unlinked', linkKey: e.linkKey, undoes: e.id, qb: e.qb, jarvis: e.jarvis, by, reason });
        return { status: 'unlinked', journalId: u.id };
    }

    // created by Jarvis: the payments that stand on it come first
    if (e.kind === 'bill' || e.kind === 'invoice' || e.kind === 'creditmemo') {
        const payKind = e.kind === 'bill' ? 'billpayment' : 'payment';
        const standing = active(env).filter((x) => x.kind === payKind && (x.qb.linked || []).some((t) => String(t.id) === String(e.qb.id)));
        if (standing.length) return { status: 'refused', why: `undo the payment(s) first: ${standing.map((s) => s.id).join(', ')}` };
    }
    const type = QB_TYPE[e.kind];
    const now = (await client.request('GET', `/${type.toLowerCase()}/${e.qb.id}`, null, opts))[type];
    const edited = IS_DOC(e.kind)
        ? (e.qb.fp ? fingerprint(now) !== e.qb.fp : (round2(now.TotalAmt) !== round2(e.qb.total) || String((now.VendorRef || now.CustomerRef || {}).value) !== String(e.qb.partyId)))
        : (e.qb.syncToken != null && String(now.SyncToken) !== String(e.qb.syncToken));
    if (edited) return { status: 'refused', why: 'edited in QuickBooks since Jarvis created it — someone has worked on it; decide with the accountant' };
    if ((e.kind === 'bill' || e.kind === 'invoice' || e.kind === 'creditmemo') && now.Balance != null && round2(now.Balance) !== round2(now.TotalAmt)) {
        return { status: 'refused', why: `something has been paid against it in QuickBooks (balance ${now.Balance} of ${now.TotalAmt})` };
    }
    if (dryRun) return { status: 'would-delete', note: `delete ${type} #${e.qb.id} (${now.TotalAmt}) that Jarvis created`, snapshot: now };
    await client.request('POST', `/${type.toLowerCase()}?operation=delete`, { Id: now.Id, SyncToken: now.SyncToken }, opts);
    const links = loadLinks(); delete links[e.linkKey]; writeLinks(links);
    const u = record({ env, kind: e.kind, action: 'undone', linkKey: e.linkKey, undoes: e.id, qb: e.qb, jarvis: e.jarvis, deletedRecord: now, by, reason });
    return { status: 'undone', journalId: u.id };
}

module.exports = { fingerprint, record, recordWrite, unfinishedWrites, list, active, discrepancies, undo, JOURNAL_FILE, QB_TYPE, ACTIONS };
