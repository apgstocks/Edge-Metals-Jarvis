// ── helpers/booksParity.js — Jarvis's books against QuickBooks', side by side ─
//
// Apsara, 2026-10-23: "for now we are using quickbooks this year for edge
// metals.from next year-no qb", "so accounts should be perfectly handled",
// "so that we can convince owner to let go of qb and jarvis does better".
//
// ── THE WINDOW CLOSES WHEN QUICKBOOKS DOES ──────────────────────────────────
// This is the only period in which the claim "Jarvis's books are right" can
// be PROVED rather than asserted. While QB is live the two can be put side by
// side; from January there is nothing to compare against. So the comparison
// has to be run, and the gaps closed, during the overlap — not after it.
//
// It is also the argument itself. An owner does not move his books because a
// system has more features; he moves them when shown that the new one agrees
// with the old one to the cent, and then does something the old one cannot.
// This produces the first half of that sentence.
//
// ── IT COMPARES, IT NEVER ADJUSTS ───────────────────────────────────────────
// Nothing here writes to either side. A parity tool that "fixes" a difference
// is a tool that hides the one thing worth knowing. Every gap is reported
// with both figures and left alone.
//
// The two shapes already line up, which is why this file is short:
//
//     QuickBooks (helpers/quickbooks/books.profitAndLoss)
//        income · cogs · grossProfit · expenses · netIncome
//     Jarvis (helpers/statements.profitAndLoss)
//        incomeTotal · cogsTotal · grossProfit · expenseTotal · netIncome
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

// The five figures an owner actually reads, in the order he reads them.
// Labelled in his words, not in either system's field names.
const FIGURES = [
    { key: 'income',      label: 'Income',        qb: 'income',      js: 'incomeTotal' },
    { key: 'cogs',        label: 'Cost of goods', qb: 'cogs',        js: 'cogsTotal' },
    { key: 'grossProfit', label: 'Gross profit',  qb: 'grossProfit', js: 'grossProfit' },
    { key: 'expenses',    label: 'Expenses',      qb: 'expenses',    js: 'expenseTotal' },
    { key: 'netIncome',   label: 'Net income',    qb: 'netIncome',   js: 'netIncome' },
];

// ── WHAT COUNTS AS AGREEMENT ────────────────────────────────────────────────
// HALF a cent, not a cent. The difference matters and this file had it wrong
// first time: with a 0.01 tolerance and `<=`, two books a real penny apart
// reported as agreeing. That is the exact failure this tool must not have —
// a report that says "agrees" when it does not is worse than no report,
// because the owner acts on it.
//
// 0.005 absorbs floating-point noise from summing thousands of lines (which
// is what an epsilon is for) while treating an actual cent as the difference
// it is. "Close enough" is the answer that loses the argument with an
// accountant.
//
// A wider tolerance is available per call — useful when hunting a big gap
// and the pennies are noise — but it is never the default and the report
// always states which was used.
const EXACT = 0.005;

function compare(qb, jarvis, { tolerance = EXACT } = {}) {
    const tol = Math.max(0, Number(tolerance) || 0) || EXACT;
    const rows = FIGURES.map((f) => {
        const q = num(qb && qb[f.qb]);
        const j = num(jarvis && jarvis[f.js]);
        // A figure MISSING on one side is not agreement, and it is not a
        // difference of zero either — it is the most important kind of gap,
        // because it means one book does not have the concept at all.
        if (q === null || j === null) {
            return { ...f, qb: q, jarvis: j, delta: null,
                agrees: false, missing: q === null ? 'quickbooks' : 'jarvis' };
        }
        const delta = r2(j - q);
        return { ...f, qb: r2(q), jarvis: r2(j), delta,
            agrees: Math.abs(delta) <= tol, missing: null };
    });

    const differing = rows.filter((r) => !r.agrees)
        // Biggest gap first: that is the one to explain, and usually the one
        // that explains the others.
        .sort((a, b) => Math.abs(b.delta || Infinity) - Math.abs(a.delta || Infinity));

    return {
        tolerance: tol,
        from: (qb && qb.from) || (jarvis && jarvis.from) || null,
        to: (qb && qb.to) || (jarvis && jarvis.to) || null,
        rows,
        differing,
        agrees: differing.length === 0,
        // The headline. Net income is the number the owner argues about.
        netIncomeAgrees: !!(rows.find((r) => r.key === 'netIncome') || {}).agrees,
    };
}

// ── WHERE TO LOOK, RATHER THAN A GUESS AT THE CAUSE ─────────────────────────
// Deliberately phrased as "check this", never as "the cause is". Jarvis
// cannot see inside QuickBooks' journal, and a confident wrong explanation
// costs more than none — she would chase it instead of looking.
//
// The hints come from differences this codebase has ALREADY produced, which
// is why they are specific: the container-key bug that cost real money, the
// $5.4M of prepayments never applied to a bill (quickbooks/books.js's own
// note), and containers whose bill and sale never joined (#141).
function whereToLook(row) {
    if (!row || row.agrees) return '';
    if (row.missing === 'jarvis') return 'Jarvis has no figure at all — the accounts behind it may be unmapped. Check the chart against QuickBooks’.';
    if (row.missing === 'quickbooks') return 'QuickBooks returned nothing for this line — check the report period and that the company is the right one.';
    const over = (row.delta || 0) > 0;
    switch (row.key) {
        case 'income':
            return over
                ? 'Jarvis shows MORE income. Look for sales counted twice — a container invoiced under two numbers, or a sale and its invoice both posted.'
                : 'Jarvis shows LESS income. Look for sales with no invoice joined to them (#141), and for invoices QuickBooks has that never reached Jarvis.';
        case 'cogs':
            return over
                ? 'Jarvis shows MORE cost. Look for bills posted twice, and for trucking counted both in the bill and as its own expense.'
                : 'Jarvis shows LESS cost. Look for bills in QuickBooks with no matching purchase in Jarvis, and for containers whose bill never joined its sale.';
        case 'expenses':
            return over
                ? 'Jarvis shows MORE expense. Check petty cash and trucking for entries that also exist as bills.'
                : 'Jarvis shows LESS expense. Check for expense categories in QuickBooks with no account mapped on this side.';
        default:
            return 'This line is the sum of the ones above it — fix those first and it usually follows.';
    }
}

// A plain-words summary, because the person being convinced is not going to
// read a table of deltas.
function verdict(cmp) {
    if (!cmp) return '';
    const money = (v) => (v === null ? '—' : (v < 0 ? '-$' : '$')
        + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    if (cmp.agrees) {
        return `Jarvis and QuickBooks agree on all five figures for ${cmp.from} to ${cmp.to}, to the cent.`;
    }
    const worst = cmp.differing[0];
    const n = cmp.differing.length;
    return `${n} of 5 figures differ for ${cmp.from} to ${cmp.to}. `
        + `Biggest: ${worst.label} — Jarvis ${money(worst.jarvis)}, QuickBooks ${money(worst.qb)}`
        + (worst.delta === null ? '.' : ` (${money(worst.delta)} apart).`);
}

module.exports = { compare, whereToLook, verdict, FIGURES, EXACT };
