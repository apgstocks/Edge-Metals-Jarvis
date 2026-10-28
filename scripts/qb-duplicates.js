#!/usr/bin/env node
// ── scripts/qb-duplicates.js — the same bill or invoice entered twice ────
//
//     node scripts/qb-duplicates.js            # live QB, 2026-01-01 -> today
//     node scripts/qb-duplicates.js --offline  # the snapshot on disk instead
//     node scripts/qb-duplicates.js --from 2026-01-01 --to 2026-06-30
//
// Apsara, 2026-10-28: "Check for duplicates for 2026 bills and invoices in
// quickbook".
//
// READ-ONLY. It never deletes or edits anything in QuickBooks. Removing a bill
// that a payment is applied to is a two-step unwind and it is hers, on the
// screen that does it with the guards. A script that quietly deleted a payable
// would be the worst thing in this repo.
//
// ── WHY THE OBVIOUS CHECK IS USELESS HERE ───────────────────────────────
// "Same vendor, same amount, same day" fires constantly in her trade. Garduno's
// Logistics billed 8,370.00 twice on 2026-04-02 and 9,300.00 twice on
// 2026-03-05 — different reference numbers, completely different container
// lists, two real freight bills at the same rate. A tool that called those
// duplicates would be deleted in a week, which is the lesson already written
// into scripts/duplicate-invoices.js: several rows per container is NORMAL and
// a count alone says nothing.
//
// ── WHAT ACTUALLY SEPARATES A DUPLICATE ─────────────────────────────────
// Three things, and the tool says which one fired rather than just "duplicate":
//
//   SAME LINES   the strongest signal by far. Identical line amounts in the
//                same order, same vendor, same date. Two bills that agree to
//                the cent line by line are one bill entered twice.
//   SAME NUMBER  the vendor's own reference, or an invoice number, used twice.
//                Real but weaker: she splits one container's bill across two
//                rows under one reference, and an invoice number can be
//                mistyped onto a genuinely different shipment.
//   MINUTES      created seconds or minutes apart with the same total. The
//                discriminator scripts/duplicate-invoices.js found in her own
//                data: rows saved in ONE operation share a timestamp, rows
//                typed on different days do not. Here it cuts the other way —
//                a gap of DAYS with identical lines means someone re-entered
//                it from the paperwork a second time.
//
// Every finding prints the balance and whether a payment is applied, because
// that decides how she fixes it: an unpaid duplicate can be deleted, a paid one
// has to have its payment unwound first.
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
// ── THE WINDOW IS ROLLING ───────────────────────────────────────────────
// Apsara, 2026-10-28: "it should be a rolling date..from 01-01-2026 to rolling
// date". So 2026-01-01 to TODAY, every run — not a calendar year, which asked
// QuickBooks for rows dated up to 2026-12-31 and made "this year" mean
// something different on every machine's clock. --from and --to override it.
const FROM = String(flag('--from', '2026-01-01'));
const TO = String(flag('--to', new Date().toISOString().slice(0, 10)));
const inWindow = (r) => {
    const d = String(r.TxnDate || '').slice(0, 10);
    return d && d >= FROM && d <= TO;          // string compare, no date maths
};
const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n2 = (v) => Number(Number(v || 0).toFixed(2));

// ── LOADING ─────────────────────────────────────────────────────────────
// Offline from a file, or live from QuickBooks WITH PAGINATION. The
// pagination is not a nicety: the snapshots in data/ hold exactly 1000 bills
// and exactly 1000 invoices and stop at 2026-09-05 and 2026-08-27, weeks
// before the day they were written. Whatever produced them took one page and
// called it the books, so a clean run against those files would have been a
// false all-clear over a third of the year. helpers/quickbooks/snapshot.js
// already pages properly; this copies it rather than inventing a third way.
async function fetchAll(table) {
    const client = require('../helpers/quickbooks/client');
    const auth = require('../helpers/quickbooks/auth');
    const env = auth.qbEnv();
    const where = `TxnDate >= '${FROM}' and TxnDate <= '${TO}'`;
    const out = [];
    for (let start = 1; start <= 20000; start += 1000) {
        const r = await client.query(
            `select * from ${table} where ${where} maxresults 1000 startposition ${start}`, { env });
        // client.query ALREADY returns QueryResponse — it ends `return
        // d.QueryResponse || {}`. My first version read r.QueryResponse[table],
        // which is always undefined, so every live run would have found zero
        // rows and reported a clean year. A false all-clear from the one tool
        // written to prevent exactly that. helpers/quickbooks/snapshot.js has
        // had `r[table]` all along; I did not read it before writing mine.
        const rows = (r || {})[table] || [];
        out.push(...rows);
        if (rows.length < 1000) break;
    }
    return { rows: out, env };
}

// The snapshot on disk, through the helper that owns its shape, so this reads
// the rolling wrapper and the old bare array without a second opinion about
// either. --bills/--invoices still take an explicit path for a one-off file.
function fromSnapshot(kind) {
    const snap = require('../helpers/quickbooks/snapshot').rows(kind);
    if (!snap) return { rows: [], warn: `no ${kind} snapshot on disk — run: node scripts/qb-snapshot.js` };
    const rows = snap.rows.filter(inWindow);
    const last = rows.map((r) => r.TxnDate).sort().pop() || '(none)';
    let warn = null;
    // Say it, every time. A truncated page that looks complete is how a clean
    // bill of health gets handed over on a third of the data.
    if (snap.legacy) {
        warn = `${path.basename(snap.file)} is the OLD bare-array file (${snap.count} rows, ends ${last})`
            + (snap.count === 1000 ? ' — exactly 1000 rows, so one unpaginated page, NOT the whole window.' : '.')
            + ' Refresh it: node scripts/qb-snapshot.js';
    } else if (snap.until && snap.until < TO) {
        warn = `snapshot is from ${snap.until} and you asked up to ${TO} — ${kind} after ${snap.until} are not in it.`;
    }
    return { rows, warn, env: snap.env };
}

function fromFile(p) {
    const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
    if (!fs.existsSync(abs)) { console.error(`no such file: ${p}`); process.exit(1); }
    const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
    const all = Array.isArray(raw) ? raw : (raw.rows || []);
    const rows = all.filter(inWindow);
    const last = rows.map((r) => r.TxnDate).sort().pop() || '(none)';
    return { rows, env: raw.env || null, warn: all.length === 1000
        ? `${p} holds EXACTLY 1000 rows and ends ${last} — one unpaginated page, NOT the whole window.`
        : null };
}

// ── THE SIGNALS ─────────────────────────────────────────────────────────
const party = (r) => String(((r.VendorRef || r.CustomerRef || {}).name) || '?').trim();
const created = (r) => String((r.MetaData || {}).CreateTime || '');
const doc = (r) => String(r.DocNumber || '').trim();
// Only the real charge lines. QuickBooks adds its own SubTotalLineDetail row,
// which repeats the total and would make every single invoice look doubled —
// it did, on the first run, until the DetailType was read.
const charge = (r) => (r.Line || [])
    .filter((l) => l.DetailType !== 'SubTotalLineDetail' && l.Amount != null)
    .map((l) => n2(l.Amount));
const lineKey = (r) => charge(r).join('+');
// What the lines SAY, not just what they add up to. In her books a line
// description is a list of container numbers, and a container cannot be
// freighted twice at the same price under the same reference. Blank
// descriptions give an empty signature and are never matched on — that is the
// Garduno's lump-line case, where the text carries nothing.
const textKey = (r) => (r.Line || [])
    .filter((l) => l.DetailType !== 'SubTotalLineDetail' && l.Amount != null)
    .map((l) => String(l.Description || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim())
    .filter(Boolean)
    .sort()
    .join(' | ');
const paid = (r) => {
    const links = (r.LinkedTxn || []).map((t) => t.TxnType);
    return links.length ? links.join(', ') : null;
};
const daysApart = (a, b) => {
    const t1 = Date.parse(created(a)), t2 = Date.parse(created(b));
    if (!isFinite(t1) || !isFinite(t2)) return null;
    return Math.abs(t1 - t2) / 86400000;
};

// "1 minutes apart" for 89 seconds reads as deliberate; it is not. The gap is
// the evidence for whether this was one operation or two, so it is spelled
// at the resolution that answers that.
function apart(days) {
    const mins = days * 24 * 60;
    if (mins < 2) return Math.round(mins * 60) + ' seconds';
    if (mins < 90) return Math.round(mins) + ' minutes';
    if (days < 1.5) return Math.round(mins / 60) + ' hours';
    return Math.round(days) + ' days';
}

function clusters(rows, keyfn) {
    const m = new Map();
    for (const r of rows) {
        const k = keyfn(r);
        if (!k) continue;
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(r);
    }
    return [...m.entries()].filter(([, v]) => v.length > 1);
}

function report(label, rows) {
    console.log(`\n═══ ${label} — ${rows.length} row(s) from ${FROM} to ${TO} ═══`);
    const seen = new Set();
    const hits = [];

    // 1. SAME LINES. Same party, same date, identical charge lines — AND the
    //    same reference, when there is one.
    //
    //    The reference is in this key because leaving it out made the tool do
    //    the exact thing its header promises it would not. Garduno's two
    //    freight bills are each a SINGLE line equal to the total, so their
    //    "line signature" is identical ($8,370.00) while the bills are plainly
    //    different: refs 'Inv 174,175,176,177' vs 'Inv 170,171', and entirely
    //    different container lists in the note. One lump line carries no
    //    information, so matching on it alone is matching on the total.
    //
    //    Two different non-empty references mean two different documents, so
    //    they land in different clusters here and fall through to SAME TOTAL
    //    ONLY, which is where that shape belongs. Rows with no reference at
    //    all still cluster together, so a genuine duplicate typed without a
    //    ref is not missed.
    for (const [, v] of clusters(rows, (r) => `${party(r)}|${r.TxnDate}|${lineKey(r)}|${doc(r)}`)) {
        if (!lineKey(v[0])) continue;
        hits.push({ why: 'SAME LINES', rows: v });
        for (const r of v) seen.add(r.Id);
    }
    // 1a. SAME CHARGE, ANY DATE. Same party, same reference, same total, and
    //     the same line TEXT — but the transaction dates differ, so signal 1
    //     above never sees them.
    //
    //     Found by her live run on 2026-10-28, after this tool had just told
    //     her "Nothing with identical lines twice". EAGLE TRANS SHIPPING ref
    //     UCSE/010480: $3,440.00 dated 2026-03-18 and PAID, and $3,440.00
    //     dated 2026-05-05 still OWING, both for the same two containers
    //     SEGU5270538 + ECMU2613694, created five days apart. The same freight
    //     charge entered twice under two transaction dates. My strongest
    //     signal keyed on TxnDate, so it landed in SAME NUMBER with the
    //     reference reuses — unflagged, and counted as nothing overstated.
    //
    //     The date is the one field a re-entry is most likely to get
    //     differently: she types the invoice date off the paperwork the second
    //     time, or the bill date instead of the shipment date. Keying on it
    //     made the check shaped like the tidy case.
    for (const [, v] of clusters(rows.filter((r) => doc(r) && textKey(r)),
        (r) => `${party(r)}|${doc(r)}|${n2(r.TotalAmt)}|${textKey(r)}`)) {
        if (v.every((r) => seen.has(r.Id))) continue;
        hits.push({ why: 'SAME CHARGE, DIFFERENT DATES', rows: v });
        for (const r of v) seen.add(r.Id);
    }
    // 1b. SUBSET. One bill's whole total is a LINE inside another bill from
    //     the same party under the same reference. Found in her data on the
    //     first run and initially reported only as SAME NUMBER, which buried
    //     it: Houston Junk Car Buyers ref 26ME06, container MRKU2278150, has
    //     a 1,387.00 bill of its own AND a 21,317.04 bill whose five lines
    //     are 1,387.00 + 11,881.92 + 311.24 + 3,980.88 + 3,756.00. The piece
    //     was entered alone, then the whole bill including it was entered 20
    //     hours later. The overstatement is the SMALL one, not the whole bill,
    //     which is why this needs its own signal and its own arithmetic — a
    //     plain "duplicate" label here would have had her looking at 21,317.04
    //     when the error is 1,387.00.
    for (const [, v] of clusters(rows.filter((r) => doc(r)), (r) => `${party(r)}|${doc(r)}`)) {
        if (v.length !== 2) continue;
        const [big, small] = [...v].sort((a, b) => n2(b.TotalAmt) - n2(a.TotalAmt));
        if (n2(big.TotalAmt) === n2(small.TotalAmt)) continue;      // not a subset, a twin
        if (!charge(big).includes(n2(small.TotalAmt))) continue;
        if (charge(big).length < 2) continue;                       // one lump proves nothing
        hits.push({ why: 'ONE IS A LINE OF THE OTHER', rows: [big, small], subset: n2(small.TotalAmt) });
        for (const r of v) seen.add(r.Id);
    }
    // 2. SAME NUMBER, not already caught by the lines.
    for (const [, v] of clusters(rows.filter((r) => doc(r)), (r) => `${party(r)}|${doc(r)}`)) {
        if (v.every((r) => seen.has(r.Id))) continue;
        hits.push({ why: 'SAME NUMBER', rows: v });
        for (const r of v) seen.add(r.Id);
    }
    // 3. SAME TOTAL on the same day, different numbers and different lines.
    //    The Garduno's shape. Reported LAST and labelled as probably fine,
    //    because in her trade it usually is.
    for (const [, v] of clusters(rows, (r) => `${party(r)}|${r.TxnDate}|${n2(r.TotalAmt)}`)) {
        if (v.every((r) => seen.has(r.Id))) continue;
        hits.push({ why: 'SAME TOTAL ONLY', rows: v });
        for (const r of v) seen.add(r.Id);
    }

    if (!hits.length) { console.log('  nothing looks entered twice.'); return 0; }
    let exposure = 0;
    for (const h of hits) {
        const v = h.rows;
        const gap = daysApart(v[0], v[1]);
        const sameTotal = new Set(v.map((r) => n2(r.TotalAmt))).size === 1;
        const strong = (h.why === 'SAME LINES' && sameTotal)
            || h.why === 'ONE IS A LINE OF THE OTHER'
            || h.why === 'SAME CHARGE, DIFFERENT DATES';
        if ((h.why === 'SAME LINES' && sameTotal) || h.why === 'SAME CHARGE, DIFFERENT DATES') {
            exposure += n2(v[0].TotalAmt) * (v.length - 1);
        }
        if (h.why === 'ONE IS A LINE OF THE OTHER') exposure += h.subset;
        console.log(`\n  [${h.why}]${strong ? '  <-- LOOK AT THIS ONE' : ''}  ${party(v[0])}`
            + (doc(v[0]) ? `   ref ${doc(v[0])}` : '')
            + (gap == null ? '' : `   entered ${apart(gap)} apart`));
        for (const r of v) {
            console.log(`      id ${r.Id}  ${r.TxnDate}  ${money(r.TotalAmt)}`
                + `  owing ${money(r.Balance)}  ${paid(r) ? 'PAYMENT APPLIED (' + paid(r) + ')' : 'nothing applied'}`);
            console.log(`         lines ${charge(r).map(money).join(' / ') || '(none)'}`);
            const note = String(r.PrivateNote || '').replace(/\s+/g, ' ').trim();
            if (note) console.log(`         note  ${note.slice(0, 90)}`);
        }
        if (h.why === 'SAME CHARGE, DIFFERENT DATES') {
            const unpaid = v.filter((r) => n2(r.Balance) > 0.005);
            console.log('         (same reference, same amount and the SAME line text, on different'
                + ' transaction dates — one charge entered twice)');
            if (unpaid.length === 1 && v.length === 2) {
                console.log(`         the one still owing is id ${unpaid[0].Id} (${money(unpaid[0].TotalAmt)})`
                    + ' — the other is already paid, so that is the one to remove');
            }
        }
        if (h.why === 'ONE IS A LINE OF THE OTHER') {
            console.log(`         (the ${money(h.subset)} bill is also a LINE inside the `
                + `${money(n2(v[0].TotalAmt))} one — the overstatement is ${money(h.subset)}, not the whole bill)`);
        }
        if (h.why === 'SAME TOTAL ONLY') {
            console.log('         (same amount and day but different references AND different lines'
                + ' — in her trade this is usually two real loads at one rate)');
        }
    }
    return exposure;
}

(async () => {
    const bf = flag('--bills'), inf = flag('--invoices');
    const offline = argv.includes('--offline');
    let bills, invs, env = 'file', warns = [];
    if (bf || inf) {
        const b = bf ? fromFile(bf) : { rows: [], warn: null };
        const i = inf ? fromFile(inf) : { rows: [], warn: null };
        bills = b.rows; invs = i.rows; env = b.env || i.env || 'file';
        warns = [b.warn, i.warn].filter(Boolean);
    } else if (offline) {
        const b = fromSnapshot('bills'), i = fromSnapshot('invoices');
        bills = b.rows; invs = i.rows; env = b.env || i.env || 'snapshot on disk';
        warns = [b.warn, i.warn].filter(Boolean);
    } else {
        const b = await fetchAll('Bill');
        const i = await fetchAll('Invoice');
        bills = b.rows; invs = i.rows; env = b.env;
    }

    console.log(`QuickBooks duplicate check · ${FROM} to ${TO} · source: ${env}`);
    if (env === 'sandbox') console.log('  NOTE: sandbox, not her live books.');
    for (const w of warns) console.log(`  INCOMPLETE DATA: ${w}`);

    let exposure = 0;
    exposure += report('BILLS (money she owes)', bills);
    exposure += report('INVOICES (money owed to her)', invs);

    console.log('\n───────────────────────────────────────────────────────────');
    console.log(exposure > 0
        ? `Overstated by ${money(exposure)} if every [SAME LINES] pair is one entry made twice.`
        : 'Nothing with identical lines twice.');
    console.log('Nothing was changed. Deleting a bill or invoice is yours to do in QuickBooks,');
    console.log('and a row with a payment applied has to have the payment unwound first.');
})().catch((e) => {
    console.error('\ncould not run: ' + (e && e.message || e));
    console.error('If this is an auth error, QuickBooks tokens live on the VM — run it there.');
    process.exit(1);
});
