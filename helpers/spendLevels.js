// ── helpers/spendLevels.js ────────────────────────────────────────────────
// The spend report, one level at a time.
//
// Apsara, 2026-11-08: "The spend report should be built in a way sich that
// we can disect into lower level from higher level in a humanely possible
// way."
//
// The report already computes a dozen breakdowns at once — by method, by
// bank, by company, by counterparty, by month — and prints them side by
// side. That is not dissection. Dissection is: here is one number, here is
// what it is made of, now pick one of those and see what IT is made of.
//
// ── THE ORDER, AND WHY IT IS THIS ONE ────────────────────────────────────
// It follows the question she actually asks, which is always narrowing:
//
//   1. WHOSE money      company      Edge Yard or Edge Metals. Rule 5: these
//                                    are different businesses and the figure
//                                    means nothing until you know which.
//   2. WHAT FOR         kind         metal, haulage, an expense, a supplier
//                                    settlement. "Where did it go" in the
//                                    sense of what it bought.
//   3. TO WHOM          party        the name on the other side of it.
//   4. WHEN             month        once a name is picked, the question is
//                                    always "when, and how often".
//   5. WHICH ONE        record       the payment itself, and its document.
//
// ── AND THE RULE THAT MAKES IT HUMANE ────────────────────────────────────
// A level that cannot split is skipped. Asking her to click "Edge Yard" to
// see Edge Yard, or a month that holds the only row, is ceremony — and
// ceremony is what makes a drill-down something people stop using. If a
// level has one child, this walks straight past it and says so in the
// breadcrumb, so she still knows where she is.
//
// Pure: it takes the rows the report already built (already windowed, already
// filtered) and groups them. It fetches nothing and knows no files, so the
// screen, Scout and the exports can all ask the same question and cannot get
// different answers.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const COMPANY_LABEL = { 'edge-trading': 'Edge Yard', 'edge-metals': 'Edge Metals' };
const KIND_LABEL = {
    load: 'Metal bought', sale: 'Metal sold', trucker: 'Haulage',
    supplier: 'Supplier settlements', sale_cost: 'Costs on sales',
    metals_trucking: 'Metals haulage', expense: 'Expenses',
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                'August', 'September', 'October', 'November', 'December'];

// Each level says how to get its key off a row and how to say that key out
// loud. One table, so a level cannot be grouped one way and labelled another.
const LEVELS = [
    { by: 'company', heading: 'Whose money',
      key: (r) => r.company || 'Company not stated',
      label: (k) => COMPANY_LABEL[k] || k },
    { by: 'kind', heading: 'What it went on',
      key: (r) => r.kind || 'other',
      label: (k) => KIND_LABEL[k] || k },
    { by: 'party', heading: 'Who it went to',
      key: (r) => r.party || 'Not recorded',
      label: (k) => k },
    { by: 'month', heading: 'When',
      key: (r) => String(r.date || '').slice(0, 7),
      label: (k) => {
          const m = /^(\d{4})-(\d{2})$/.exec(k);
          return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : (k || 'No date');
      } },
];

// ── WHICH ROWS ARE STILL IN PLAY ─────────────────────────────────────────
// `path` is what she has clicked, in order: [{by,key}, ...]. Narrowing is
// exact-match on the level's own key function, never on a label — two
// suppliers whose names render the same must not merge, and a label is for
// reading rather than for identity.
function narrow(rows, path) {
    let out = Array.isArray(rows) ? rows.slice() : [];
    for (const step of (path || [])) {
        const lvl = LEVELS.find((l) => l.by === step.by);
        if (!lvl) continue;
        out = out.filter((r) => lvl.key(r) === step.key);
    }
    return out;
}

// The level to show, given where she is. Returns null once there is nothing
// left to split by — the caller then shows the records themselves.
function nextLevel(path) {
    const used = new Set((path || []).map((p) => p.by));
    return LEVELS.find((l) => !used.has(l.by)) || null;
}

function groupBy(rows, lvl) {
    const by = new Map();
    for (const r of rows) {
        const k = lvl.key(r);
        if (!by.has(k)) by.set(k, { key: k, label: lvl.label(k), amount: 0, count: 0 });
        const g = by.get(k);
        g.amount = round2(g.amount + (Number(r.amount) || 0));
        g.count += 1;
    }
    return [...by.values()].sort((a, b) => b.amount - a.amount);
}

/**
 * One screenful of the dissection.
 *
 * rows   — the report's own rows, already windowed and filtered
 * path   — [{by,key}] of what she has clicked
 * opts.direction — 'out' (default) or 'in'. Money out and money in are two
 *                  different questions and summing them would answer
 *                  neither.
 */
function level(rows, path = [], { direction = 'out' } = {}) {
    const all = (Array.isArray(rows) ? rows : [])
        .filter((r) => (r.direction || 'out') === direction);
    const here = narrow(all, path);
    const total = round2(here.reduce((a, r) => a + (Number(r.amount) || 0), 0));

    // Where she is, said in words at every step, so a long path is still
    // readable and one click takes her back to any point in it.
    const crumbs = [{ label: direction === 'in' ? 'Money in' : 'Money out', path: [] }];
    for (let i = 0; i < (path || []).length; i += 1) {
        const lvl = LEVELS.find((l) => l.by === path[i].by);
        crumbs.push({ label: lvl ? lvl.label(path[i].key) : path[i].key,
                      path: path.slice(0, i + 1) });
    }

    // ── SKIP A LEVEL THAT CANNOT SPLIT ──────────────────────────────────
    // Walked here rather than at the click, so the breadcrumb records every
    // level that was passed through. She can still step back into one; she
    // is just never made to click through it on the way down.
    let lvl = nextLevel(path);
    let usePath = (path || []).slice();
    let skipped = [];
    while (lvl) {
        const groups = groupBy(narrow(all, usePath), lvl);
        if (groups.length > 1) break;
        if (groups.length === 1) {
            // ONE CHILD MEANS NOTHING IS CHOSEN BY CLICKING, so choose it and
            // say so. The first version added "and more than one row under
            // it", which looked careful and was wrong: a branch holding a
            // SINGLE payment then made her click company, kind, party and
            // month — four screens, each with one thing on it — to reach the
            // one row. That is the exact ceremony this rule exists to remove,
            // and the test for it is section D.
            usePath = usePath.concat([{ by: lvl.by, key: groups[0].key }]);
            skipped.push({ by: lvl.by, label: groups[0].label });
            lvl = nextLevel(usePath);
            continue;
        }
        break;
    }

    const groups = lvl ? groupBy(narrow(all, usePath), lvl) : [];
    const share = (n) => (total ? Math.round((n / total) * 1000) / 10 : 0);

    return {
        direction,
        crumbs,
        skipped,                       // levels walked past, and what they were
        heading: lvl ? lvl.heading : 'The payments themselves',
        by: lvl ? lvl.by : null,
        total,
        count: here.length,
        rows: groups.map((g) => ({
            ...g,
            share: share(g.amount),
            // Can this one be opened further? False at the bottom, so a
            // screen never offers a click that does nothing.
            canOpen: !!nextLevel(usePath.concat([{ by: lvl.by, key: g.key }])),
            path: usePath.concat([{ by: lvl.by, key: g.key }]),
        })),
        // At the bottom the records ARE the answer. Newest first, the way
        // every other list in this app reads.
        records: lvl ? [] : here.slice().sort((a, b) =>
            String(b.date || '').localeCompare(String(a.date || ''))),
        path: usePath,
    };
}

module.exports = { level, narrow, nextLevel, LEVELS, COMPANY_LABEL, KIND_LABEL };
