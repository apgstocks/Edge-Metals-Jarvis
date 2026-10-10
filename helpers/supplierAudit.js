// ── helpers/supplierAudit.js — "how much have we paid them, and is it right?" ─
// Apsara, 2026-10-10: "If i ask anything just like i ask human, it should able
// to detect that. For eg: How much have we paid for supplier A so far
// including advance. and check how much is pending. If i paid more than what
// was already there. It should able to detect that. and help me in finding
// out where it gone wrong exactly."
//
// THREE ANSWERS, ONE PASS
//   1. What went out: payments + advances (both kinds — see ADVANCES).
//   2. What is pending: what the supplier is owed, less what went out.
//   3. If the two do not square — overpaid, or a container paid past its
//      bill — WHICH rows did it, ranked by how much each one explains, and
//      the date the account first tipped into overpayment.
//
// READ ONLY. Nothing here writes, pays, edits or merges. A finding is a
// pointer to a row she can open, never a correction made on her behalf.
//
// ── "OWED" IS THE BILLS TAB'S DEFINITION, NOT THE SUPPLIER ACCOUNT'S ─────
// helpers/bills.js names the chain at every link: amount − trucking =
// net_payable, "what the supplier is owed" (trucking is haulage she pays ON
// THE SUPPLIER'S BEHALF). helpers/supplierAccount.js debits the gross amount
// instead, so on every container with trucking the two screens disagree by
// the trucking. This file does not pick a winner silently: pending is
// computed her Bills-tab way, and the gap to the Supplier Account screen is
// reported as its own line so she can say which is right. Neither screen is
// changed here.
//
// ── ADVANCES COME FROM TWO PLACES ────────────────────────────────────────
//   · an advance RECORD (billPayments, kind 'advance') — money that left
//     before there was a container; its allocations say where it was applied
//   · the ADVANCE COLUMN on a bill (from her sheet) — money already paid on
//     that container
// Both are real money out. The trap is the same money recorded in both: an
// advance record applied to a container AND typed into that container's
// advance column. Each looks ordinary on its own; together the supplier
// looks paid twice. That is finding `advance_twice`.
//
// ── AN APPLIED ADVANCE IS NOT A SECOND PAYMENT ───────────────────────────
// Money out is counted from the payment RECORD, once, on its own date —
// never by walking allocations (which would count an advance again each
// time a slice of it is applied). Same rule as supplierAccount.js.

const CENT = 0.01;
const SLACK = 1;                         // under a dollar is rounding, not a finding
const DUP_WINDOW_DAYS = 7;

const round2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);
const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/[$,\s]/g, ''));
    return isFinite(n) ? n : null;
};
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const money = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function deps(d = {}) {
    return { bills: d.bills || require('./bills'), billPayments: d.billPayments || require('./billPayments') };
}

// ── WHICH SUPPLIER SHE MEANT ─────────────────────────────────────────────
// Spacing, punctuation and case are ignored. A name that is part of exactly
// one supplier's name ("gomez" → "Gomez Recycling") resolves; part of two or
// more is ASKED, never guessed — the answer is a money figure for one
// company, and the wrong company's balance read out confidently is the worst
// possible reply.
function allSuppliers(d) {
    const seen = new Map();
    const add = (s) => { const t = String(s || '').trim(); if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t); };
    for (const b of d.bills.list()) add(b.supplier);
    for (const p of d.billPayments.list()) add(p.supplier);
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

function resolveSupplier(query, opts = {}) {
    const d = deps(opts);
    const names = allSuppliers(d);
    const q = norm(query);
    if (!q) return { status: 'none', candidates: [] };
    const exact = names.filter((n) => norm(n) === q);
    if (exact.length === 1) return { status: 'ok', name: exact[0] };
    const part = names.filter((n) => norm(n).includes(q) || (norm(n).length >= 4 && q.includes(norm(n))));
    if (part.length === 1) return { status: 'ok', name: part[0] };
    if (part.length > 1) return { status: 'ambiguous', candidates: part };
    // Every word she said is the start of a word in the name: "oak met" → "Oakland Metals".
    const words = String(query).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
    const byWords = words.length ? names.filter((n) => {
        const nw = String(n).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
        return words.every((w) => nw.some((x) => x.startsWith(w)));
    }) : [];
    if (byWords.length === 1) return { status: 'ok', name: byWords[0] };
    if (byWords.length > 1) return { status: 'ambiguous', candidates: byWords };
    return { status: 'none', candidates: [] };
}

// Names that are probably the same company spelled another way. Reported,
// never merged — "Eccomelt" and "Eccomelt LLC" being one company is her call.
function nameVariants(name, d) {
    const me = norm(name);
    if (me.length < 3) return [];
    return allSuppliers(d).filter((n) => {
        const o = norm(n);
        return o !== me && o.length >= 3 && (o.includes(me) || me.includes(o));
    });
}

// ── THE AUDIT ────────────────────────────────────────────────────────────
function audit(supplier, opts = {}) {
    const d = deps(opts);
    const who = String(supplier || '').trim();
    const allBills = d.bills.list();
    const billsById = new Map(allBills.map((b) => [b.id, b]));
    const payments = d.billPayments.list().filter((p) => same(p.supplier, who));
    const mine = allBills.filter((b) => same(b.supplier, who));
    const iso = (v) => (d.bills.sortableDate ? d.bills.sortableDate(v) : null) || String(v || '');

    // Money applied to each bill, and by which payment — from allocations,
    // used ONLY for the per-container view, never for the money-out total.
    const appliedTo = new Map();
    for (const p of d.billPayments.list()) {
        for (const a of (p.allocations || [])) {
            const k = String(a.bill_id);
            if (!appliedTo.has(k)) appliedTo.set(k, []);
            appliedTo.get(k).push({ payment_id: p.id, kind: p.kind === 'advance' ? 'advance' : 'payment',
                supplier: p.supplier, date: p.date || null, mode: p.mode || null, ref: p.ref || null,
                amount: round2(num(a.amount) || 0) });
        }
    }

    // ── per container ──
    const containers = mine.map((b) => {
        const c = d.bills.compute(b);
        const amount = round2(num(c.amount));
        const trucking = round2(num(c.trucking_amount_used)) || 0;
        const net = amount === null ? null : round2(amount - trucking);
        const advanceCol = round2(num(b.advance)) || 0;
        const applied = appliedTo.get(String(b.id)) || [];
        const appliedSum = round2(applied.reduce((s, a) => s + a.amount, 0)) || 0;
        const covered = round2(appliedSum + advanceCol);
        return {
            id: b.id, date: b.date || null, iso: iso(b.date),
            container_no: b.container_no || null, booking_no: b.booking_no || null, invoice_no: b.invoice_no || null,
            amount, trucking, net_payable: net, advance_col: advanceCol,
            applied, applied_sum: appliedSum, covered,
            balance: net === null ? null : round2(net - covered),
            computed_amount: round2(num(c.computed_amount)),
            amount_differs: !!c.amount_differs,
        };
    });

    // ── money out, once per record ──
    const payRows = payments.map((p) => {
        const amt = round2(num(p.amount)) || 0;
        const alloc = round2((p.allocations || []).reduce((s, a) => s + (num(a.amount) || 0), 0)) || 0;
        return { id: p.id, kind: p.kind === 'advance' ? 'advance' : 'payment', date: p.date || null, iso: iso(p.date),
            mode: p.mode || null, bank: p.bank || null, ref: p.ref || null, amount: amt,
            allocated: alloc, unallocated: round2(amt - alloc) };
    });

    const sum = (xs, f) => round2(xs.reduce((s, x) => s + (f(x) || 0), 0)) || 0;
    const billed = sum(containers, (c) => c.amount);
    const truckingTotal = sum(containers, (c) => (c.amount === null ? 0 : c.trucking));
    const owed = sum(containers, (c) => c.net_payable);
    const paidPayments = sum(payRows.filter((p) => p.kind === 'payment'), (p) => p.amount);
    const advRecords = sum(payRows.filter((p) => p.kind === 'advance'), (p) => p.amount);
    const advColumn = sum(containers, (c) => c.advance_col);
    const advUnapplied = sum(payRows.filter((p) => p.kind === 'advance'), (p) => Math.max(0, p.unallocated));
    const totalOut = round2(paidPayments + advRecords + advColumn);
    const pending = round2(owed - totalOut);

    const findings = [];
    const add = (f) => findings.push(f);

    // 1. Money against a container whose bill has no amount. The account
    //    counts the money out but not the bill, so it reads as overpaid by
    //    exactly that money.
    for (const c of containers.filter((x) => x.amount === null)) {
        const money_against = round2(c.applied_sum + c.advance_col);
        add({ code: 'bill_without_amount', explains: money_against > SLACK ? money_against : 0,
            severity: money_against > SLACK ? 'high' : 'low',
            title: `${c.container_no || c.invoice_no || 'A bill'} has no amount${money_against > SLACK ? `, but ${money(money_against)} was paid on it` : ''}`,
            detail: 'Fill in the weight and price (or the stated amount) on this bill. Until then the money paid on it counts, but what it cost does not.',
            bill_id: c.id, container_no: c.container_no });
    }

    // 2. Same money recorded twice: an advance record applied to a container
    //    AND the container's advance column filled in.
    for (const c of containers) {
        const advApplied = round2(c.applied.filter((a) => a.kind === 'advance').reduce((s, a) => s + a.amount, 0)) || 0;
        if (c.advance_col > SLACK && advApplied > SLACK) {
            const dbl = round2(Math.min(c.advance_col, advApplied));
            add({ code: 'advance_twice', explains: dbl, severity: 'high',
                title: `${c.container_no || 'A container'}: the advance may be counted twice (${money(dbl)})`,
                detail: `An advance record of ${money(advApplied)} was applied to this container, and its Advance column also says ${money(c.advance_col)}. If they are the same money, clear one of them.`,
                bill_id: c.id, container_no: c.container_no });
        }
    }

    // 3. Duplicate payments: same amount within a week, or the same reference twice.
    const seenPair = new Set();
    for (let i = 0; i < payRows.length; i++) {
        for (let j = i + 1; j < payRows.length; j++) {
            const a = payRows[i], b = payRows[j];
            if (a.amount < SLACK) continue;
            const sameRef = a.ref && b.ref && norm(a.ref) && norm(a.ref) === norm(b.ref);
            const ta = Date.parse(a.iso), tb = Date.parse(b.iso);
            const close = isFinite(ta) && isFinite(tb) && Math.abs(ta - tb) <= DUP_WINDOW_DAYS * 86400000;
            if (!(sameRef || (Math.abs(a.amount - b.amount) < CENT && close))) continue;
            const key = [a.id, b.id].sort().join('|');
            if (seenPair.has(key)) continue;
            seenPair.add(key);
            add({ code: 'duplicate_payment', explains: b.amount, severity: 'high',
                title: `Possible duplicate: ${money(a.amount)} on ${a.date || '?'} and ${money(b.amount)} on ${b.date || '?'}${sameRef ? ` (same reference ${a.ref})` : ''}`,
                detail: 'Check the bank statement: if only one transfer left, delete the extra record.',
                payment_ids: [a.id, b.id] });
        }
    }

    // 4. A container paid past what is owed on it.
    for (const c of containers) {
        if (c.balance === null || c.balance >= -SLACK) continue;
        // The parts already explained by an earlier finding on this bill are not
        // counted again here — the total must not explain more than happened.
        const already = round2(findings.filter((f) => f.bill_id === c.id).reduce((s, f) => s + (f.explains || 0), 0)) || 0;
        const excess = round2(-c.balance);
        const paidGrossInstead = c.trucking > SLACK && Math.abs(c.covered - c.amount) < SLACK;
        add({ code: 'container_overpaid', explains: Math.max(0, round2(excess - already)), severity: 'high',
            title: `${c.container_no || c.invoice_no || 'A container'} was paid ${money(excess)} more than owed`,
            detail: paidGrossInstead
                ? `It was paid the full ${money(c.amount)}, but ${money(c.trucking)} of trucking is deducted — owed is ${money(c.net_payable)}. Either the trucking should not be deducted, or the supplier was paid the trucking too.`
                : `Owed ${money(c.net_payable)}${c.trucking ? ` (after ${money(c.trucking)} trucking)` : ''}; paid ${money(c.covered)}: ${c.applied.map((a) => `${money(a.amount)} ${a.kind} ${a.date || ''}${a.ref ? ' ref ' + a.ref : ''}`.trim()).concat(c.advance_col ? [`${money(c.advance_col)} advance column`] : []).join(', ')}.`,
            bill_id: c.id, container_no: c.container_no });
    }

    // 5. A typed amount that does not match weight x price.
    for (const c of containers) {
        if (!c.amount_differs || c.computed_amount === null || c.amount === null) continue;
        const gap = round2(c.amount - c.computed_amount);
        if (Math.abs(gap) < SLACK) continue;
        add({ code: 'amount_differs', explains: 0, severity: 'medium',
            title: `${c.container_no || 'A container'}: bill says ${money(c.amount)} but weight x price is ${money(c.computed_amount)}`,
            detail: `A ${money(Math.abs(gap))} gap. If the supplier billed the weight-times-price figure, what is owed is ${gap > 0 ? 'lower' : 'higher'} than this account shows.`,
            bill_id: c.id, container_no: c.container_no });
    }

    // 6. Money that left but sits on no container.
    for (const p of payRows) {
        if (p.unallocated <= SLACK) continue;
        add(p.kind === 'advance'
            ? { code: 'advance_unapplied', explains: 0, severity: 'info',
                title: `${money(p.unallocated)} of the ${p.date || ''} advance is not applied to any container yet`,
                detail: 'This is credit with the supplier. Apply it to a container when the bill arrives.', payment_ids: [p.id] }
            : { code: 'payment_unallocated', explains: 0, severity: 'medium',
                title: `${money(p.unallocated)} of the ${p.date || ''} payment is on no container`,
                detail: 'A payment should sit on a container. Allocate it, or change it to an advance.', payment_ids: [p.id] });
    }

    // 7. The same supplier under another spelling — money may be split across names.
    for (const v of nameVariants(who, d)) {
        const vb = allBills.filter((b) => same(b.supplier, v)).length;
        const vp = d.billPayments.list().filter((p) => same(p.supplier, v));
        const vpAmt = round2(vp.reduce((s, p) => s + (num(p.amount) || 0), 0)) || 0;
        add({ code: 'name_variant', explains: 0, severity: 'medium',
            title: `"${v}" may be the same supplier (${vb} bill${vb === 1 ? '' : 's'}, ${money(vpAmt)} paid)`,
            detail: `If "${v}" is ${who}, their figures belong in this account and these totals are incomplete.`, variant: v });
    }

    // Money ahead of the bills is CREDIT up to what is sitting in unapplied
    // advances — an advance waiting for its container is not a mistake.
    // Only what is beyond that is overpaid.
    const ahead = pending < -SLACK ? round2(-pending) : 0;
    const credit = round2(Math.min(ahead, advUnapplied)) || 0;
    const overpaid = round2(ahead - credit) > SLACK ? round2(ahead - credit) : 0;

    // ── WHEN IT TIPPED ───────────────────────────────────────────────────
    // Walk the account in date order — owed going up on each bill, down on
    // each payment — and name the first event that took it below zero.
    const events = [];
    for (const c of containers) {
        if (c.net_payable !== null) events.push({ iso: c.iso, date: c.date, delta: c.net_payable, what: `Bill ${c.container_no || c.invoice_no || ''}`.trim() });
        if (c.advance_col > CENT) events.push({ iso: c.iso, date: c.date, delta: -c.advance_col, what: `Advance column on ${c.container_no || 'a bill'}` });
    }
    for (const p of payRows) events.push({ iso: p.iso, date: p.date, delta: -p.amount, what: `${p.mode || ''} ${p.kind}${p.ref ? ' ref ' + p.ref : ''}`.trim(), payment_id: p.id });
    // Bills before payments on the same day, so a same-day bill-and-pay is not a false tip.
    events.sort((a, b) => String(a.iso).localeCompare(String(b.iso)) || (b.delta - a.delta));
    let run = 0, tipped = null;
    for (const e of events) {
        run = round2(run + e.delta);
        if (tipped === null && run < -(SLACK + credit)) tipped = { ...e, balance_after: run };
    }

    findings.sort((a, b) => (b.explains || 0) - (a.explains || 0)
        || ['high', 'medium', 'low', 'info'].indexOf(a.severity) - ['high', 'medium', 'low', 'info'].indexOf(b.severity));
    const explained = round2(findings.reduce((s, f) => s + (f.explains || 0), 0)) || 0;

    return {
        supplier: who,
        containers: containers.length,
        billed, trucking: truckingTotal, owed,
        paid: paidPayments, advances: round2(advRecords + advColumn), advance_records: advRecords, advance_column: advColumn,
        advance_unapplied: advUnapplied,
        total_out: totalOut,
        pending, overpaid, credit,
        // What the Supplier Account screen shows instead (gross, no trucking deducted).
        supplier_account_screen: round2(billed - totalOut),
        bills_without_amount: containers.filter((c) => c.amount === null).length,
        explained: overpaid ? Math.min(explained, overpaid) : explained,
        tipped,
        findings,
        open: containers.filter((c) => c.balance !== null && c.balance > SLACK).map((c) => ({ container_no: c.container_no, balance: c.balance })),
    };
}

// ── WHAT JARVIS SAYS, AND WHAT IT SHOWS ──────────────────────────────────
function report(a) {
    const lines = [];
    const status = a.overpaid ? `OVERPAID by ${money(a.overpaid)}`
        : a.pending > SLACK ? `${money(a.pending)} pending`
        : a.credit > SLACK ? `${money(a.credit)} credit (advance not yet used)` : 'settled';
    let spoken;
    if (a.overpaid) {
        const top = a.findings.find((f) => f.explains > SLACK);
        spoken = `${a.supplier}: we've paid ${money(a.total_out)}, including ${money(a.advances)} in advances, against ${money(a.owed)} owed. That's ${money(a.overpaid)} more than owed.`
            + (top ? ` The biggest reason: ${top.title}.` : ' I could not find the cause in the records — the detail is on screen.');
    } else {
        spoken = `${a.supplier}: we've paid ${money(a.total_out)}, including ${money(a.advances)} in advances. `
            + (a.pending > SLACK ? `${money(a.pending)} is still pending on ${a.open.length} container${a.open.length === 1 ? '' : 's'}.`
               : a.credit > SLACK ? `Nothing is pending, and ${money(a.credit)} of advance is sitting with them as credit.` : 'Nothing is pending.');
        const issues = a.findings.filter((f) => ['high', 'medium'].includes(f.severity)).length;
        if (issues) spoken += ` ${issues} thing${issues === 1 ? '' : 's'} need${issues === 1 ? 's' : ''} checking — see the screen.`;
    }

    lines.push(`SUPPLIER ACCOUNT — ${a.supplier} — ${status}`);
    lines.push(`Billed ${money(a.billed)} on ${a.containers} container${a.containers === 1 ? '' : 's'}`
        + (a.trucking ? ` − trucking ${money(a.trucking)} = owed ${money(a.owed)}` : ` = owed ${money(a.owed)}`));
    lines.push(`Paid ${money(a.paid)} + advances ${money(a.advances)}`
        + (a.advance_column && a.advance_records ? ` (${money(a.advance_records)} advance records, ${money(a.advance_column)} on bills)` : '')
        + ` = ${money(a.total_out)} out`);
    lines.push(a.overpaid ? `Overpaid ${money(a.overpaid)}${a.credit > SLACK ? ` (beyond ${money(a.credit)} of unused advance)` : ''}`
        : a.credit > SLACK ? `Credit ${money(a.credit)} — advance not yet applied` : `Pending ${money(a.pending)}`);
    if (a.advance_unapplied > SLACK) lines.push(`Of the advances, ${money(a.advance_unapplied)} is not applied to a container yet.`);
    if (a.trucking > SLACK && Math.abs(a.supplier_account_screen - a.pending) > SLACK) {
        lines.push(`Note: the Supplier Account screen shows ${money(a.supplier_account_screen)} because it does not deduct trucking. Bills tab deducts it. Tell me which is right.`);
    }
    if (a.overpaid && a.tipped) lines.push(`Went into overpayment on ${a.tipped.date || '?'} — ${a.tipped.what} (balance ${money(a.tipped.balance_after)}).`);
    if (a.overpaid) lines.push(`The findings below explain ${money(a.explained)} of the ${money(a.overpaid)}.`);

    const shown = a.findings.filter((f) => f.severity !== 'info' || !a.overpaid);
    if (shown.length) {
        lines.push('');
        lines.push(a.overpaid ? 'WHERE IT WENT WRONG' : 'CHECK THESE');
        for (const f of shown.slice(0, 10)) lines.push(`• ${f.title}${f.explains > SLACK ? ` [explains ${money(f.explains)}]` : ''}\n  ${f.detail}`);
        if (shown.length > 10) lines.push(`…and ${shown.length - 10} more`);
    }
    if (!a.overpaid && a.open.length) {
        lines.push('');
        lines.push('STILL OWED');
        for (const o of a.open.slice(0, 12)) lines.push(`• ${o.container_no || '—'} ${money(o.balance)}`);
        if (a.open.length > 12) lines.push(`…and ${a.open.length - 12} more`);
    }
    return { spoken, screen: lines.join('\n') };
}

// One call for Jarvis: resolve the name, audit, phrase it.
function answer(query, opts = {}) {
    const r = resolveSupplier(query, opts);
    if (r.status === 'ambiguous') {
        const list = r.candidates.slice(0, 6).join(', ');
        return { spoken: `Which supplier — ${list}?`, screen: `More than one supplier matches "${query}": ${list}. Say the full name.`, ambiguous: r.candidates };
    }
    if (r.status !== 'ok') {
        return { spoken: `I don't have a supplier called ${query}.`, screen: `No supplier matches "${query}".` };
    }
    const a = audit(r.name, opts);
    return { ...report(a), audit: a };
}

module.exports = { audit, report, answer, resolveSupplier, nameVariants, SLACK, DUP_WINDOW_DAYS };
