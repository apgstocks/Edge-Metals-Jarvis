// ── helpers/qbDuplicates.js — one bill or invoice entered twice ──────────
//
// Apsara, 2026-10-28: "Check for duplicates for 2026 bills and invoices in
// quickbook", then: "MAKE IT VERY EASY.ASSIGN A AI TO THIS TO DO ALL THE JOBS"
// and "AN AGENT ONLY FOR QB,BOOKS,BANK".
//
// ── WHY THIS IS A HELPER AND NOT A SECOND COPY ──────────────────────────
// The signals were written inside scripts/qb-duplicates.js this morning. When
// the accounts agent needed them too, the easy move was to paste them in —
// and two implementations of "what is a duplicate" would drift the first time
// one changed, which is the sin this repo has paid for repeatedly (CLAUDE.md
// records a flag, a payment mode and a packing list going that way). So the
// script keeps the printing and this keeps the judgement, and there is
// exactly one answer to what a duplicate is.
//
// find(rows) -> [{ why, rows, subset? }], strongest first. It decides and
// returns; it never prints, writes, or deletes.
//
// THE FOUR SIGNALS, and why each exists, is documented at its branch below.
// All four came out of her real 2026 books on the day they were written, and
// so did both false positives they refuse to fire on.
const n2 = (v) => Math.round((Number(v || 0)) * 100) / 100;

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


// ── FIND ────────────────────────────────────────────────────────────────
function find(rows) {
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

    return hits;
}

// Which of a pair she should remove, and it is not always "the unpaid one".
// Three cases, and the first version got the easiest one wrong — it returned
// null when BOTH were unpaid, telling her the Houston pair "needs unwinding"
// when in fact nothing is applied to either and the duplicate can simply be
// deleted. The hardest answer was being given for the simplest case.
function removable(hit) {
    const rows = hit.rows || [];
    if (rows.length !== 2) return null;
    const unpaid = rows.filter((r) => n2(r.Balance) > 0.005);
    // Exactly one unpaid: that is the one. The other is settled and unwinding
    // a payment to delete it would be the longer road for no reason.
    if (unpaid.length === 1) return unpaid[0];
    // Both unpaid: either can go, so name the LATER-CREATED one, which is the
    // re-entry. Her Houston pair is this shape.
    if (unpaid.length === 2) {
        return [...rows].sort((a, b) => Date.parse(created(b)) - Date.parse(created(a)))[0];
    }
    // Both paid: she has to unwind a payment first, whichever she keeps, so
    // there is no useful answer here and saying nothing is the honest one.
    return null;
}

// What the overstatement is, which is NOT always a whole document: on a
// subset the error is the small bill inside the big one.
function overstatement(hit) {
    if (hit.why === 'ONE IS A LINE OF THE OTHER') return n2(hit.subset);
    const same = new Set((hit.rows || []).map((r) => n2(r.TotalAmt))).size === 1;
    if ((hit.why === 'SAME LINES' && same) || hit.why === 'SAME CHARGE, DIFFERENT DATES') {
        return n2(n2(hit.rows[0].TotalAmt) * (hit.rows.length - 1));
    }
    return 0;
}

const STRONG = new Set(['SAME LINES', 'ONE IS A LINE OF THE OTHER', 'SAME CHARGE, DIFFERENT DATES']);

module.exports = { find, removable, overstatement, STRONG,
    party, doc, charge, textKey, created, daysApart, apart, clusters, paid };
