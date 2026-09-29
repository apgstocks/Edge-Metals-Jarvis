// ── helpers/integritySweep.js — what disagrees with itself ────────────────
//
// Apsara, 2026-09-26: "Is it possible to run an agent everyday in website to
// find out any issue or discrepancy?" Email, and everything it notices.
//
// ── THIS INVENTS NO CHECKS ────────────────────────────────────────────────
// Every finding below comes from a function that already existed and was on
// no schedule. bills.duplicates() and sales.duplicates() were computed once
// per page load and shown only if she happened to be looking at that tab.
// weight_gap was on the row and read by nobody. helpers/reconcile.js was
// written and never called by anything that runs on its own. The gap was
// never "we cannot tell" — it was that nothing ever looked.
//
// So this file is a caller, not a rule-maker. That matters: a sweep that
// invents its own idea of what is wrong will disagree with the screens, and
// then she has two answers and no way to choose.
//
// ── PURE. IT FINDS, IT DOES NOT SEND ──────────────────────────────────────
// run() returns findings. helpers/integritySweepJob.js is what emails them.
// Split because a check is worth testing and an email is not — and because a
// function that both computes and sends cannot be run to see what it would
// say.
//
// ── AND IT IS READ ONLY ───────────────────────────────────────────────────
// Nothing here writes. A nightly job that quietly "tidies" a ledger is how
// you lose a figure you cannot get back; every finding names the rows and
// stops. She decides.

const round2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);
const money = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// A weight gap of a few pounds is the weighbridge and the packing list
// disagreeing, which is normal and constant. Worth reporting only when it is
// big enough to be an error rather than a rounding — her own bills.js comment
// says the two "disagree by a few pounds as a matter of course".
const WEIGHT_GAP_LB = 50;

// Below this, an unreconciled payment is a timing difference, not a problem.
const STALE_DAYS = 21;

const daysSince = (d) => {
    const t = Date.parse(String(d || ''));
    return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
};

// ── EACH CHECK RETURNS A FINDING OR NOTHING ───────────────────────────────
// Every one is wrapped by run() so a single broken check reports itself and
// the other seven still run. A sweep that dies on its first problem tells her
// nothing about the other six ledgers, which is the opposite of the point.
const CHECKS = [

    // ── TWO BILLS ON ONE CONTAINER ────────────────────────────────────────
    // The one that costs money, and it is already documented in api.js:
    // margin.js keeps only the LAST bill for a container, so a duplicate
    // makes that container read cheaper than it was, and the margin on it is
    // wrong in her favour — which is the direction nobody questions.
    {
        id: 'duplicate-bills',
        title: 'Two bills for the same container',
        why: 'margin keeps only the last one, so the container reads cheaper than it was',
        run() {
            const bills = require('./bills');
            const dups = bills.duplicates(bills.listWithTotals());
            return dups.map((d) => ({
                what: `${d.container_no || '(no container)'} on ${d.booking_no || '(no booking)'}`
                    + (d.item ? ` — ${d.item}` : ''),
                detail: `${d.ids.length} bills: ${d.ids.join(', ')}`,
            }));
        },
    },

    {
        id: 'duplicate-sales',
        title: 'Two invoices for the same container',
        why: 'the container is billed to the customer twice',
        run() {
            const sales = require('./sales');
            const dups = sales.duplicates(sales.listWithTotals());
            return dups.map((d) => ({
                what: `${d.container_no || '(no container)'} on ${d.booking_no || '(no booking)'}`
                    + (d.item ? ` — ${d.item}` : ''),
                detail: `${d.ids.length} invoices: ${d.ids.join(', ')}`,
            }));
        },
    },

    // ── THE ITEMS DO NOT ADD UP TO THE CONTAINER ──────────────────────────
    // Her own rule, from bills.js: reported, never refused, because the
    // weighbridge and the packing list disagree by a few pounds as a matter
    // of course. So the threshold is what turns a fact into a finding.
    {
        id: 'weight-gap',
        title: `Line items miss the container net by more than ${WEIGHT_GAP_LB} lb`,
        why: 'the grades were typed from one sheet and the container weighed on another',
        run() {
            const bills = require('./bills');
            return bills.listWithTotals()
                .filter((b) => Number.isFinite(b.weight_gap) && Math.abs(b.weight_gap) > WEIGHT_GAP_LB)
                .map((b) => ({
                    what: `${b.container_no || b.id} — ${b.supplier || 'no supplier'}`,
                    detail: `${b.weight_gap > 0 ? '+' : ''}${round2(b.weight_gap)} lb between the items and the net`,
                }));
        },
    },

    // ── BOUGHT AND NEVER SOLD, SOLD AND NEVER BOUGHT ──────────────────────
    // margin.rows() already joins the two sides and labels the state. A
    // container stuck on 'bought' for months is either stock nobody counted
    // or an invoice nobody raised; one on 'sold' with no bill behind it is
    // revenue with no cost, which flatters every margin it touches.
    {
        id: 'unjoined-containers',
        title: 'A container with only one side of the trade',
        why: 'sold with no bill flatters the margin; bought with no sale may be an invoice nobody raised',
        run() {
            const margin = require('./margin');
            const rows = margin.rows() || [];
            const out = [];
            // ── THE SAME CONTAINER, TWICE, IS ONE PROBLEM NOT TWO ────────
            // Her first live run, 2026-09-26:
            //
            //   CAIU9824029 — Calderon:     bought 277 days ago and not sold
            //   CAIU9824029 — SOLINE METAL: sold 277 days ago with no bill
            //
            // A bill AND a sale, same container, same day, reported as two
            // separate gaps. They are not. margin.js:58 keys a row on
            // BOOKING + CONTAINER, so two halves that agree on the container
            // and disagree on the booking never meet — and the container is
            // counted twice with its real margin computed nowhere.
            //
            // Reporting that as two missing halves sends her looking for two
            // documents that both already exist, which is worse than saying
            // nothing. Grouped by container first, so the pair is named as
            // what it is.
            // ── A LEAKED RECORD ID IS NOT A CONTAINER ────────────────────
            // Apsara, 2026-09-29, reading this very report:
            //
            //   BILL_1789990307231_2eiz5 — DRM
            //   "ignore all these things likle BILL_,SALE_"
            //
            // A Jarvis row id sitting in the container column. It can never
            // join to anything and the sheet will never supply a matching
            // half, so every night it reports a gap that cannot be closed —
            // and a nightly report carrying items nobody can act on is a
            // report that stops being read. Dropped here rather than in the
            // email, so every consumer of this check agrees.
            //
            // Only the id shape is dropped, not everything odd: a genuinely
            // unfamiliar container number is still worth her seeing.
            const RECORD_ID = /^(BILL|SALE)_/i;

            const byContainer = new Map();
            for (const r of rows) {
                if (r.state === 'closed') continue;
                const c = String(r.container_no || '').trim().toUpperCase();
                if (!c) continue;
                if (RECORD_ID.test(c)) continue;
                if (!byContainer.has(c)) byContainer.set(c, []);
                byContainer.get(c).push(r);
            }
            for (const [container, group] of byContainer) {
                const age = Math.max(...group.map((r) => daysSince(r.bill_date || r.sale_date) || 0));
                if (age < STALE_DAYS) continue;                 // still in flight
                const bought = group.find((r) => r.state === 'bought');
                const sold = group.find((r) => r.state === 'sold');
                if (bought && sold) {
                    out.push({
                        what: `${container} — ${bought.supplier || '?'} to ${sold.customer || '?'}`,
                        detail: `both halves exist but the booking numbers differ, so the margin is computed nowhere`
                            + ` (bill ${bought.booking_no || 'blank'}, sale ${sold.booking_no || 'blank'})`,
                    });
                    continue;
                }
                const r = group[0];
                out.push({
                    what: `${container} — ${r.supplier || r.customer || 'unnamed'}`,
                    detail: r.state === 'bought'
                        ? `bought ${age} days ago and not sold`
                        : `sold ${age} days ago with no bill behind it`,
                });
            }
            return out;
        },
    },

    // ── A BILL NOBODY FINISHED ────────────────────────────────────────────
    // bills.missingFor() is the one implementation of "what is this bill
    // still waiting for" — date, supplier, container, weights, and either a
    // price or a typed amount.
    //
    // The first version of this read `b.is_finished`, which does not exist on
    // a bill: it is DERIVED in helpers/data/dataMirror.js for the SQL mirror,
    // out of this very function. The filter was therefore always false and
    // the check could never fire — it read correctly, it ran every night, and
    // it found nothing forever. Caught by seeding a fixture and noticing two
    // of seven checks stayed silent, not by reading the code.
    {
        id: 'unfinished-bills',
        title: 'Bills that are still missing something',
        why: 'an unfinished bill has a figure nobody can rely on',
        run() {
            const bills = require('./bills');
            return bills.listWithTotals()
                .map((b) => ({ b, needs: bills.missingFor(b) || [] }))
                .filter((x) => x.needs.length)
                // A bill typed this morning is not a problem; one from three
                // weeks ago that still has gaps is.
                //
                // `=== null` rather than `||`. daysSince() returns 0 for
                // today, and `0 || STALE_DAYS` takes the undated fallback —
                // so every bill typed this morning was reported as overdue.
                // Caught by the test, and it is the same falsy-zero trap that
                // made an invoice note of "0" vanish: a legitimate zero is
                // not a missing value.
                .filter((x) => { const d = daysSince(x.b.date); return d === null || d >= STALE_DAYS; })
                .map((x) => ({
                    what: `${x.b.container_no || x.b.id} — ${x.b.supplier || 'no supplier'}`,
                    detail: `needs ${x.needs.join(', ')}`,
                }));
        },
    },

    // ── A ROW WITH NO DATE OR NO PARTY ────────────────────────────────────
    // compute() already marks these `incomplete` rather than refusing them,
    // deliberately — a form that refuses a real bill is a form she works
    // around. But nothing ever came back to them afterwards.
    {
        id: 'incomplete-rows',
        title: 'Rows missing a date or a party',
        why: 'they were allowed in on purpose, and then nobody came back to them',
        run() {
            const bills = require('./bills');
            return bills.listWithTotals()
                .filter((b) => Array.isArray(b.incomplete) && b.incomplete.length)
                .map((b) => ({
                    what: `${b.container_no || b.id}`,
                    detail: `no ${b.incomplete.join(', no ')}`,
                }));
        },
    },

    // ── WHAT IS DELIBERATELY NOT HERE: THE BANK RECONCILIATION ────────────
    // helpers/reconcile.js computes exactly the finding this sweep wants —
    // money recorded in Jarvis that the statement has never seen. It is NOT
    // wired in, and that is a decision rather than an oversight.
    //
    // Two reasons. It has no caller anywhere in the app, so nothing has ever
    // exercised it against real rows. And it takes its inputs explicitly —
    // reconcile({ payments, expenses, bills, transactions }) — where
    // bookedOutflows() keys on p.load_id, which is a YARD payment; the metals
    // side pays through helpers/billPayments.js and its allocations. Feeding
    // it the wrong store would produce a confident list of discrepancies that
    // are not discrepancies, in an email whose whole value is that she can
    // trust it.
    //
    // data/bank-transactions.json is empty on this machine, so I cannot see
    // the shape to wire it correctly. It goes in once I can — the same rule
    // that kept the metals catalog from being written from fixtures.
];

// ── RUN THEM ALL, AND SURVIVE ANY OF THEM ─────────────────────────────────
// A check that throws becomes a finding of its own rather than taking the
// sweep down. She should hear "the reconcile check is broken" from the same
// email, not discover a week later that it silently stopped running.
function run({ limitPerCheck = 25 } = {}) {
    const findings = [];
    const broken = [];
    for (const c of CHECKS) {
        let hits = [];
        try { hits = c.run() || []; }
        catch (e) { broken.push({ id: c.id, title: c.title, error: String(e.message || e).slice(0, 200) }); continue; }
        if (!hits.length) continue;
        findings.push({
            id: c.id, title: c.title, why: c.why,
            count: hits.length,
            // Capped for the email, and the count above says how many there
            // really were — a truncated list that hides its own truncation is
            // how a hundred problems look like twenty-five.
            items: hits.slice(0, limitPerCheck),
            truncated: Math.max(0, hits.length - limitPerCheck),
        });
    }
    const total = findings.reduce((a, f) => a + f.count, 0);
    return { at: new Date().toISOString(), clean: total === 0 && !broken.length, total, findings, broken, checks: CHECKS.length };
}

// Plain text, because it goes in an email she reads on a phone.
function reportText(res) {
    if (res.clean) return `Nothing to report. ${res.checks} checks, no discrepancies.`;
    const out = [];
    out.push(`${res.total} thing${res.total === 1 ? '' : 's'} worth a look, across ${res.findings.length} of ${res.checks} checks.`);
    for (const f of res.findings) {
        out.push('');
        out.push(`${f.title} — ${f.count}`);
        out.push(`  (${f.why})`);
        for (const i of f.items) out.push(`  · ${i.what}: ${i.detail}`);
        if (f.truncated) out.push(`  … and ${f.truncated} more`);
    }
    if (res.broken.length) {
        out.push('');
        out.push('CHECKS THAT DID NOT RUN');
        for (const b of res.broken) out.push(`  · ${b.title}: ${b.error}`);
    }
    return out.join('\n');
}

module.exports = { run, reportText, CHECKS, WEIGHT_GAP_LB, STALE_DAYS };
