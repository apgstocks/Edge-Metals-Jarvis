// ── helpers/quickbooks/stuckFix.js — where does a stuck row get fixed? ─────
//
// Apsara, 2026-10-05: "Improve jarvis specifically in qb area as of now",
// looking at the 4 October mail where 24 rows were stuck.
//
// ── WHAT WAS WRONG ───────────────────────────────────────────────────────
// Every stuck row on the QuickBooks page is clickable, and every one of them
// did the same thing:
//
//     const [kind, name] = tr.dataset.open.split('|');
//     if (name) openParty(kind, decodeURIComponent(name));
//
// It opens the SUPPLIER'S QUICKBOOKS NAME MAPPING. For 21 of the 24 rows that
// morning the reason was "no supplier amount yet; grade 'Auto Cast' has no
// amount" — a price missing on a BILL. The vendor mapping is fine, and
// looking at it tells her nothing. She clicks, lands somewhere correct and
// irrelevant, and concludes the thing is confused.
//
// Opening the wrong screen is worse than opening none: it costs a click, a
// context switch, and a little more trust each time.
//
// ── SO THIS SAYS WHERE THE FIX LIVES ─────────────────────────────────────
// Pure, and separate from the page, so the email and the screen can agree
// about the same row and a test can run it without QuickBooks. It decides
// nothing about the books — it only reads the reasons push.js already wrote
// and says which screen answers them.
//
// There is deliberately NO deep link. dashboard/index.html has no openTab()
// — the name appears only in comments — so a link into the Bills ledger
// would be invented rather than used. Naming the destination and the
// container is honest; a link that does not work is not.

// The grade name out of 'grade "Auto Cast" has no amount'.
const GRADE_RE = /grade "([^"]+)" has no amount/;
const GRADE_NO_ITEM_RE = /grade "([^"]+)" has no QuickBooks item/;
const ITEM_RE = /item "([^"]+)" is (none|suggest)/;
const PARTY_RE = /(vendor|customer) "([^"]+)" is (none|suggest)/;

// Ordered: the FIRST rule that matches decides where she is sent, because a
// row with several problems is still one journey. Money-on-the-bill comes
// before naming problems — an unpriced grade blocks the row whatever the
// mapping says, and pricing it is the step she can take today.
const RULES = [
    { where: 'bill', test: (p) => GRADE_RE.test(p) || /no supplier amount yet/.test(p) },
    { where: 'bill', test: (p) => /no invoice number/.test(p) },
    { where: 'bill', test: (p) => /no bill date/.test(p) },
    { where: 'bill', test: (p) => /lines add to .* but Jarvis says/.test(p) },
    { where: 'bill', test: (p) => /invoice number longer than QuickBooks allows/.test(p) },
    { where: 'item', test: (p) => ITEM_RE.test(p) || GRADE_NO_ITEM_RE.test(p) },
    { where: 'party', test: (p) => PARTY_RE.test(p) },
    { where: 'setup', test: (p) => /no "Trucking" account/.test(p) },
];

const WHERE_LABEL = {
    bill: 'Bills',
    sale: 'Invoices',
    item: 'QuickBooks items',
    party: 'QuickBooks names',
    setup: 'QuickBooks setup',
    unknown: '—',
};

// Returns { where, label, title, detail, grades, items, container, party }.
// Never throws: a reason nobody has seen before becomes 'unknown' with the
// text shown as-is, which is strictly better than guessing a destination.
function stuckFix(row) {
    // ── TWO SHAPES REACH HERE, AND ONLY ONE WAS OBVIOUS ──────────────────
    // sync.js writes rows as { kind, id, container_no, party, problems[] }.
    // But what the PAGE and the EMAIL are handed comes from
    // quickbooksNightly.js, which rebuilds them off the journal as
    // { kind, who, what, why } with every reason joined into one string.
    //
    // I wrote this for the first shape and nearly wired it to the second —
    // where `problems` is undefined, so every row would have routed to
    // 'unknown' and the whole thing would have quietly done nothing. The
    // field the route does not forward is the CLAUDE.md rule-3 failure, and
    // it was waiting right here.
    const problems = Array.isArray(row && row.problems)
        ? row.problems.filter(Boolean).map(String)
        : String((row && row.why) || '').split(';').map((x) => x.trim()).filter(Boolean);
    const container = (row && (row.container_no || row.what || row.invoice_no || row.id)) || null;
    const party = (row && (row.party || row.who)) || null;

    const grades = [];
    const items = [];
    for (const p of problems) {
        const g = GRADE_RE.exec(p) || GRADE_NO_ITEM_RE.exec(p);
        if (g) grades.push(g[1]);
        const i = ITEM_RE.exec(p);
        if (i) items.push(i[1]);
    }

    let where = 'unknown';
    for (const rule of RULES) {
        if (problems.some(rule.test)) { where = rule.where; break; }
    }
    // ── A SALE IS NOT A BILL ─────────────────────────────────────────────
    // Caught by this file's own test. The money rules above are written
    // about "the bill", and an unpriced grade on an INVOICE matched them —
    // so "invoice Custom Alloys — grade AL WHEELS DIRTY has no amount" was
    // being sent to Bills, where it does not exist. Same problem, other
    // ledger. The row already says which it is; nothing else needed to
    // change.
    if (where === 'bill' && row && row.kind === 'invoice') where = 'sale';

    // ── WHAT TO DO, IN THE WORDS OF THE THING SHE OPENS ──────────────────
    // Not a restatement of the problem. "grade Auto Cast has no amount" is
    // the symptom; "price 1 grade on this bill" is the job.
    let title = '';
    let detail = '';
    if (where === 'bill' || where === 'sale') {
        const bits = [];
        if (grades.length) {
            bits.push(`price ${grades.length} grade${grades.length === 1 ? '' : 's'}`
                + ` (${[...new Set(grades)].slice(0, 4).join(', ')}${grades.length > 4 ? '…' : ''})`);
        }
        if (problems.some((p) => /no invoice number/.test(p))) bits.push('give it an invoice number');
        if (problems.some((p) => /no bill date/.test(p))) bits.push('give it a date');
        if (problems.some((p) => /lines add to/.test(p))) bits.push('the lines do not add up to what is payable');
        if (problems.some((p) => /longer than QuickBooks allows/.test(p))) bits.push('shorten the invoice number');
        title = `${WHERE_LABEL[where]}${container ? ` → ${container}` : ''}`;
        detail = bits.join('; ') || `fix this ${where === 'sale' ? 'invoice' : 'bill'}`;
    } else if (where === 'item') {
        title = 'QuickBooks items';
        detail = items.length
            ? `confirm ${[...new Set(items)].slice(0, 4).join(', ')}${items.length > 4 ? '…' : ''}`
            : `confirm ${[...new Set(grades)].join(', ') || 'the item'}`;
    } else if (where === 'party') {
        title = 'QuickBooks names';
        detail = `match ${party || 'this name'}`;
    } else if (where === 'setup') {
        title = 'QuickBooks setup';
        detail = 'no Trucking account to post to';
    } else {
        title = WHERE_LABEL.unknown;
        detail = problems[0] || 'no reason recorded';
    }

    return { where, label: WHERE_LABEL[where], title, detail, grades, items, container, party };
}

// ── NINETEEN ROWS, ONE JOB ───────────────────────────────────────────────
// That morning's list read as 19 separate failures. It was one: yard grades
// bought without a price. Grouped by destination AND by what the job is, so
// the page can show "price grades on 19 bills" with the containers under it
// rather than nineteen lines she scrolls past.
//
// The ORDER is by how many rows a group holds, because the biggest group is
// the one worth an afternoon.
function groupStuck(rows) {
    const out = new Map();
    for (const row of (rows || [])) {
        const fix = stuckFix(row);
        // Keyed on the destination and the SHAPE of the job, not the detail —
        // "price 1 grade (Auto Cast)" and "price 4 grades (…)" are the same
        // job on different bills.
        const shape = [
            fix.where,
            fix.grades.length ? 'price' : '',
            /invoice number/.test(fix.detail) ? 'invoice_no' : '',
            /a date/.test(fix.detail) ? 'date' : '',
            /do not add up/.test(fix.detail) ? 'total' : '',
            fix.where === 'item' ? 'item' : '',
            fix.where === 'party' ? 'party' : '',
        ].filter(Boolean).join('|');
        const g = out.get(shape) || { where: fix.where, label: fix.label, shape, rows: [], containers: [], grades: new Set() };
        g.rows.push(row);
        if (fix.container) g.containers.push(fix.container);
        for (const x of fix.grades) g.grades.add(x);
        out.set(shape, g);
    }
    return [...out.values()]
        .map((g) => ({ ...g, count: g.rows.length, grades: [...g.grades] }))
        .sort((a, b) => b.count - a.count);
}

module.exports = { stuckFix, groupStuck, WHERE_LABEL };
