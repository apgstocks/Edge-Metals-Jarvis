#!/usr/bin/env node
// ── scripts/qb-bank-match.js — the pending bank list, matched to open books ──
//
// Apsara, 2026-09-22: "cant you match automatically". QuickBooks does not let
// an app read or clear the "For Review" list (Intuit confirms it on their
// developer forum), so this reads the CSV she exports from that screen and
// says, line by line, which open bill or invoice it pays. It WRITES NOTHING:
// the output is a review sheet the accountant works down, clicking Match.
//
//   node scripts/qb-bank-match.js <export.csv> [--since=2026-01-01]
//                                 [--out=<file.csv>] [--env=production]
//
// Matching, deliberately conservative — a wrong match in her books costs more
// than a line she has to look at herself:
//   exact   one open record, same amount to the cent, right direction, within
//           the date window, and nothing else it could be
//   group   2-4 records of ONE party adding to the amount (the wire that pays
//           four containers at once: TRHU/MSNU/MSDU/FCIU, 2026-09-15)
//   near    the amount is within $100 or 0.5% — fees, short payments
//   none    nothing sensible
// Anything that is not `exact` stays for a human. Ambiguity downgrades: if two
// records could be the same wire, it is `near`, never `exact`.
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
if (arg('env')) process.env.QB_ENV = arg('env');
const client = require('../helpers/quickbooks/client');

const SINCE = arg('since') || '2026-01-01';
const WINDOW_DAYS = 45;          // a wire can lag its invoice by weeks
const NEAR_ABS = 100;            // bank fee territory
const NEAR_PCT = 0.005;
const round2 = (n) => Math.round(n * 100) / 100;
const cents = (n) => Math.round(Number(n) * 100);

// ── CSV in, whatever QuickBooks calls its columns this year ─────────────────
function parseCsv(text) {
    const rows = []; let row = [], cell = '', q = false;
    const s = text.replace(/^﻿/, '');
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (q) {
            if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; }
            else if (ch === '"') q = false;
            else cell += ch;
        } else if (ch === '"') q = true;
        else if (ch === ',') { row.push(cell); cell = ''; }
        else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
        else if (ch !== '\r') cell += ch;
    }
    if (cell.length || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

const HEADER = {
    date: /^(date|bank date|posted|transaction date)/i,
    desc: /(description|memo|detail)/i,
    party: /(from\/to|payee|name|vendor|customer)/i,
    category: /(match|categor|account)/i,
    spent: /(spent|debit|withdraw|payment|money out|amount out)/i,
    received: /(received|credit|deposit|money in|amount in)/i,
    amount: /^(amount|value)$/i,
};
function headerRow(rows) {
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
        const r = rows[i].map((c) => String(c).trim());
        if (r.some((c) => HEADER.date.test(c)) && r.some((c) => HEADER.spent.test(c) || HEADER.received.test(c) || HEADER.amount.test(c))) return i;
    }
    return -1;
}
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : 0; };
function isoDate(v) {
    const s = String(v || '').trim();
    let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s); if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s); if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    const d = new Date(s); return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// Takes a path (the script) or { text } (the upload on the QuickBooks page,
// 2026-09-26 — Apsara: "i need it"). Same reader either way: one parser, one
// set of column guesses, one behaviour to trust.
function readBankLines(file) {
    const rows = parseCsv(file && file.text !== undefined ? String(file.text) : fs.readFileSync(file, 'utf8'));
    const h = headerRow(rows);
    if (h === -1) throw new Error('could not find the header row — send me the first few lines of the file');
    const head = rows[h].map((c) => String(c).trim());
    const col = (re) => head.findIndex((c) => re.test(c));
    const iDate = col(HEADER.date), iDesc = col(HEADER.desc), iSpent = col(HEADER.spent), iRecv = col(HEADER.received), iAmt = col(HEADER.amount);
    // QuickBooks' own export carries two more columns worth having: the payee
    // it guessed (From/To) and the category the accountant has already set.
    const iParty = col(HEADER.party), iCat = col(HEADER.category);
    const out = [];
    for (const r of rows.slice(h + 1)) {
        const date = isoDate(r[iDate]); if (!date) continue;
        let spent = iSpent > -1 ? num(r[iSpent]) : 0, received = iRecv > -1 ? num(r[iRecv]) : 0;
        if (!spent && !received && iAmt > -1) { const a = num(r[iAmt]); if (a < 0) spent = -a; else received = a; }
        if (!spent && !received) continue;
        out.push({ date, desc: (iDesc > -1 ? String(r[iDesc] || '') : '').trim(),
            party: (iParty > -1 ? String(r[iParty] || '') : '').trim(),
            category: (iCat > -1 ? String(r[iCat] || '') : '').trim(),
            spent: round2(spent), received: round2(received),
            amount: round2(spent || received), direction: spent ? 'out' : 'in' });
    }
    return { lines: out, columns: { date: head[iDate], desc: head[iDesc], party: head[iParty], spent: head[iSpent], received: head[iRecv], category: head[iCat] } };
}

// ── what is still open in QuickBooks ────────────────────────────────────────
async function openDocs(env, since = SINCE) {
    const pull = async (t) => { let all = [], s = 1; for (;;) {
        const r = (await client.query(`select * from ${t} where Balance > '0' and TxnDate >= '${since}' startposition ${s} maxresults 1000`, { env }))[t] || [];
        all = all.concat(r); if (r.length < 1000) break; s += 1000; } return all; };
    const bills = (await pull('Bill')).map((b) => ({ type: 'Bill', id: b.Id, doc: b.DocNumber || '', date: b.TxnDate,
        party: (b.VendorRef || {}).name || '', partyId: (b.VendorRef || {}).value, balance: round2(b.Balance), total: round2(b.TotalAmt),
        containers: containersIn(b) }));
    const invs = (await pull('Invoice')).map((b) => ({ type: 'Invoice', id: b.Id, doc: b.DocNumber || '', date: b.TxnDate,
        party: (b.CustomerRef || {}).name || '', partyId: (b.CustomerRef || {}).value, balance: round2(b.Balance), total: round2(b.TotalAmt),
        containers: containersIn(b) }));
    return { out: bills, in: invs };
}
function containersIn(x) {
    const txt = (x.Line || []).map((l) => l.Description || '').join(' ') + ' ' + (x.PrivateNote || '') + ' ' + ((x.CustomerMemo || {}).value || '');
    return (txt.match(/[A-Z]{4}\d{7}/g) || []).filter((v, i, a) => a.indexOf(v) === i);
}

// ── matching ────────────────────────────────────────────────────────────────
const days = (a, b) => Math.abs((new Date(a) - new Date(b)) / 864e5);
// "Inesh Cores Chapin" is not "Calderon Cores": the trade words are shared by
// half the suppliers, so a name only counts when a word that is theirs alone
// appears. Found 2026-09-23 on the real bank export, matching a $60,000 wire
// to the wrong supplier.
const GENERIC = new Set(['CORE', 'CORES', 'METAL', 'METALS', 'RECYCLING', 'RECYCLERS', 'TRADING', 'TRADE', 'AUTO', 'AUTOS', 'SCRAP', 'JUNK',
    'TRANSPORT', 'TRUCKING', 'LOGISTICS', 'EXPORT', 'IMPORT', 'COMPANY', 'GROUP', 'ENTERPRISE', 'ENTERPRISES', 'INDUSTRIES', 'INDUSTRIAL',
    'INC', 'LLC', 'LTD', 'CORP', 'THE', 'AND', 'YARD', 'SALES', 'SERVICES', 'SOLUTIONS', 'WIRE', 'TYPE', 'TRANSFER', 'BANK', 'AMERICA']);
// 3 letters, not 4: "FMC Metal" is FMC plus a word every supplier shares.
const words = (v) => String(v || '').toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !GENERIC.has(w));
const squash = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const nameHit = (desc, party) => {
    const d = ' ' + String(desc || '').toUpperCase().replace(/[^A-Z ]/g, ' ') + ' ';
    const own = words(party);
    if (own.length) return own.some((w) => d.includes(' ' + w) || d.includes(w + ' '));
    // nothing distinctive left ("5 Core Trading Inc") — only an outright
    // containment of the whole name counts, never a shared trade word.
    const a = squash(party), b = squash(desc);
    return a.length > 4 && b.includes(a);
};

// Most of the 661 pending lines are not trade at all — bank fees, the phone
// bill, the IRS, loan repayments, transfers between her own accounts. They are
// the accountant's work and no bill or invoice will ever match them, so they
// are set aside by name rather than left as 39 lines of "nothing matches".
const NOT_TRADE_CATEGORY = /(bank charge|loan|tax|office|travel|phone|insurance|payroll|meals|fuel|rent|utilit|interest|owner|equit)/i;
const NOT_TRADE_DESC = /(transfer fee|analysis fee|service charge|verizon|arco|internal revenue|ondeck|acura|payroll|interest)/i;
function notTrade(line) {
    if (NOT_TRADE_CATEGORY.test(line.category || '')) return `already categorized as ${line.category}`;
    if (NOT_TRADE_DESC.test(line.desc || '')) return 'not a supplier or customer payment';
    return null;
}

// A customer wire almost never equals the invoice: the banks take their cut on
// the way. Apsara, 2026-09-21: "A but keep track of whatevers marked" — the
// short-fall becomes a Bank charges credit note. Under a dollar it is not
// worth a line; over $250 it is not a fee, it is a short payment.
const FEE_MAX = 250;
function feeShort(line, pool) {
    if (line.direction !== 'in') return null;
    const hits = pool.map((d) => ({ d, gap: round2(d.balance - line.amount) }))
        .filter((x) => x.gap > 0 && x.gap <= Math.min(FEE_MAX, Math.max(25, line.amount * 0.01)))
        .sort((a, b) => a.gap - b.gap);
    if (hits.length !== 1) return null;
    return { how: 'fee', docs: [hits[0].d], why: `invoice is $${hits[0].gap} more than the wire — bank fee, needs a Bank charges credit note` };
}

// A wire of $60,000 to Inesh Cores pays no single bill; it pays down whatever
// is open. Jarvis shows what it would clear, oldest first, and leaves the
// decision to a person — it never guesses which bills the supplier meant.
function lumpSum(line, pool) {
    if (line.direction !== 'out') return null;
    const party = (line.party || '').trim();
    if (!party) return null;
    const theirs = pool.filter((d) => nameHit(party, d.party) || nameHit(d.party, party))
        .sort((a, b) => a.date.localeCompare(b.date));
    if (!theirs.length) return null;
    const open = round2(theirs.reduce((s, d) => s + d.balance, 0));
    const take = []; let left = line.amount;
    for (const d of theirs) { if (left <= 0) break; take.push(d); left = round2(left - d.balance); }
    return { how: 'lump', docs: take,
        why: `${theirs.length} bills open for ${theirs[0].party} ($${open}) — this would clear the oldest ${take.length}${left > 0 ? `, still $${left} left over` : ''}` };
}

// The bank line names a payee; the records carry a party. When the two
// disagree, the match is a coincidence of amount until a person says
// otherwise — "5 Core Trading Inc" sending $62,380.92 is not two Edge Metals
// Recycling invoices that happen to add up near it.
function payeeGuard(line, m) {
    if (!line.party || !m.docs.length) return m;
    if (m.docs.some((d) => nameHit(line.party, d.party) || nameHit(d.party, line.party))) return m;
    const parties = m.docs.map((d) => d.party).filter((v, i, a) => a.indexOf(v) === i).join(', ');
    return { how: m.how === 'exact' || m.how === 'group' ? 'near' : m.how,
        docs: m.docs, why: `${m.why} — BUT the bank says ${line.party}, the record says ${parties}` };
}

function matchLine(line, docs) {
    const skip = notTrade(line);
    if (skip) return { how: 'not-trade', docs: [], why: skip };
    return payeeGuard(line, match(line, docs));
}

function match(line, docs) {
    let pool = docs[line.direction === 'out' ? 'out' : 'in'].filter((d) => days(d.date, line.date) <= WINDOW_DAYS);
    // QuickBooks' own From/To guess is the best signal in the file. When it
    // names somebody Jarvis has open records for, nothing else is a candidate:
    // a $104,995.59 wire from Edge Metals Inc is not a Daekwang invoice that
    // happens to be $316 away.
    if (line.party) { const theirs = pool.filter((d) => nameHit(line.party, d.party)); if (theirs.length) pool = theirs; }
    const want = cents(line.amount);
    const single = pool.filter((d) => cents(d.balance) === want);
    if (single.length === 1) return { how: 'exact', docs: single, why: 'one open record, same amount' };
    if (single.length > 1) {
        const named = single.filter((d) => nameHit(`${line.desc} ${line.party || ''}`, d.party));
        if (named.length === 1) return { how: 'exact', docs: named, why: 'same amount, and the name is in the bank line' };
        return { how: 'near', docs: single, why: `${single.length} records have this exact amount — needs a person` };
    }
    // one party, 2-4 records adding up (the four-container wire)
    const byParty = {};
    for (const d of pool) (byParty[d.partyId || d.party] = byParty[d.partyId || d.party] || []).push(d);
    const tol = Math.max(NEAR_ABS, line.amount * NEAR_PCT);
    const groups = [], nearGroups = [];
    for (const list of Object.values(byParty)) {
        if (list.length < 2) continue;
        const sorted = list.slice().sort((a, b) => a.date.localeCompare(b.date));
        for (let n = 2; n <= Math.min(4, sorted.length); n++) combos(sorted, n, (pick) => {
            const gap = Math.abs(round2(pick.reduce((s, d) => s + d.balance, 0)) - line.amount);
            if (cents(gap) === 0) groups.push(pick);
            else if (gap <= tol) nearGroups.push({ pick, gap });
        });
    }
    if (groups.length === 1) return { how: 'group', docs: groups[0], why: `${groups[0].length} records of ${groups[0][0].party} add up to this` };
    if (groups.length > 1) return { how: 'near', docs: groups[0], why: `${groups.length} different combinations add up to this — needs a person` };
    // a wire that is a few dollars off a set of invoices — the 2026-09-15
    // $110,525.28 against four containers of $110,501.60, $23.68 over
    const near = pool.map((d) => ({ docs: [d], gap: Math.abs(d.balance - line.amount) }))
        .concat(nearGroups.map((g) => ({ docs: g.pick, gap: g.gap })))
        .filter((x) => x.gap <= tol)
        .sort((a, b) => a.gap - b.gap);
    const fee = feeShort(line, pool);
    if (fee) return fee;
    if (near.length) return { how: 'near', docs: near[0].docs, why: `$${round2(near[0].gap)} away from ${near[0].docs.length === 1 ? 'this record' : near[0].docs.length + ' records of ' + near[0].docs[0].party}` };
    const lump = lumpSum(line, pool);
    if (lump) return lump;
    return { how: 'none', docs: [], why: 'nothing open matches' };
}
function combos(list, n, fn, start = 0, pick = []) {
    if (pick.length === n) return fn(pick.slice());
    for (let i = start; i < list.length; i++) { pick.push(list[i]); combos(list, n, fn, i + 1, pick); pick.pop(); }
}

// ── run ─────────────────────────────────────────────────────────────────────
async function main() {
    const file = process.argv.slice(2).find((x) => !x.startsWith('--'));
    if (!file) { console.log('usage: node scripts/qb-bank-match.js <export.csv> [--since=2026-01-01] [--out=file.csv]'); process.exit(1); }
    const env = require('../helpers/quickbooks/auth').qbEnv();
    const { lines, columns } = readBankLines(file);
    console.log(`${lines.length} bank lines · columns used: ${JSON.stringify(columns)}`);
    const docs = await openDocs(env);
    console.log(`open in QuickBooks since ${SINCE}: ${docs.out.length} bills, ${docs.in.length} invoices`);
    const tally = {}; const rows = [['bank date', 'description', 'payee (QuickBooks guess)', 'spent', 'received', 'already categorized as', 'confidence', 'match', 'QB #', 'invoice/bill no', 'party', 'container', 'why']];
    for (const line of lines) {
        const m = matchLine(line, docs);
        tally[m.how] = (tally[m.how] || 0) + 1;
        rows.push([line.date, line.desc, line.party, line.spent || '', line.received || '', line.category, m.how,
            m.docs.map((d) => d.type).join(' + '), m.docs.map((d) => '#' + d.id).join(' + '),
            m.docs.map((d) => d.doc).join(' + '), m.docs.map((d) => d.party).filter((v, i, a) => a.indexOf(v) === i).join(' + '),
            m.docs.flatMap((d) => d.containers).join(' '), m.why]);
    }
    const out = arg('out') || path.join(path.dirname(file), 'qb-bank-match.csv');
    fs.writeFileSync(out, rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'));
    console.log(tally);
    console.log('written:', out);
    console.log('NOTHING was written to QuickBooks — this sheet is for the accountant to work down.');
}

module.exports = { parseCsv, words, payeeGuard, notTrade, feeShort, lumpSum, readBankLines, matchLine, openDocs, containersIn, nameHit, isoDate };
if (require.main === module) main().catch((e) => { console.error('qb-bank-match failed:', e.message); process.exit(1); });
