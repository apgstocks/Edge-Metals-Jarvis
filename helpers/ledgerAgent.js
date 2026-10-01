// ── helpers/ledgerAgent.js — the thing that keeps bills and invoices tidy ──
// Apsara, 2026-10-01: "Let an AI agent handle both bills and invoice and
// associated things", "which scans regularly and keep things perfect and
// neat", "resolves all payment confusion", "Every day,ensure that there is no
// discrepancy."
//
// And, asked what it may change by itself, she chose: only things with ONE
// POSSIBLE ANSWER. Anything touching money is proposed with both figures and
// waits for her.
//
// ── THE LINE, AND WHY IT IS DRAWN HERE ────────────────────────────────────
// Every finding this agent produces is one of exactly two kinds, and the kind
// is a property of the FINDING, not a confidence score:
//
//   SETTLED   there is one possible answer and the data already contains it.
//             "Fede" and "FEDE" on the same booking are one supplier; a row
//             with lbs and no MT has an MT; a container already on the
//             booking is that container. Applying it adds no information —
//             it writes down what is already true.
//
//   PROPOSED  more than one answer is possible, or the answer is money.
//             Which payment settles which bill. A figure that disagrees with
//             the sheet. A weight gap. These carry BOTH numbers and change
//             nothing.
//
// The reason the line is here and not at a threshold: a wrong auto-match
// between a payment and a bill is almost impossible to find afterwards,
// because both rows look perfectly ordinary once it is done. Nothing in the
// ledger says "this was guessed". A spelling fix that turns out wrong is
// visible the moment she reads the name.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────
// It does not scan. Five jobs already do that — the 6:30 integrity sweep, the
// 23:15 sheet sync, the log digest, the morning digest, QuickBooks at
// midnight — and a sixth scanner would be a sixth voice telling her slightly
// different things. This READS what they already compute, decides which side
// of the line each finding falls, applies the settled ones and reports the
// rest.
//
// That is also why it has no model call in it. "AI agent" is what she asked
// for and judgement is what she wants out of it, but the judgement that
// matters here is the SORTING, and the sorting is a rule she can read. A
// model deciding which bill a payment belongs to is exactly the thing she
// said to propose rather than apply.

const { round2 } = require('./money');

const str = (v) => String(v == null ? '' : v).trim();

// ── THE TWO KINDS ─────────────────────────────────────────────────────────
const SETTLED = 'settled';     // one possible answer; safe to write
const PROPOSED = 'proposed';   // needs her; carries both figures

// A finding that touches any of these is NEVER settled, whatever else is true
// about it. Checked by field name rather than by the check that produced it,
// so a new check cannot opt itself into auto-fixing money by accident.
const MONEY_FIELDS = new Set([
    'amount', 'price', 'supplier_price', 'advance', 'paid', 'pending',
    'total', 'freight', 'commission', 'claim_amount', 'trucking_amount',
    'net_payable', 'rate', 'value',
]);

function touchesMoney(fix) {
    if (!fix || typeof fix !== 'object') return false;
    const field = str(fix.field).toLowerCase();
    if (MONEY_FIELDS.has(field)) return true;
    // A field this file has not heard of is treated as money when its name
    // smells of it. Over-cautious on purpose: the cost of proposing something
    // that could have been applied is one click; the cost of applying
    // something that should have been proposed is a ledger she cannot trust.
    return /price|amount|cost|paid|owed|total|\$/.test(field);
}

// ── IS THIS FINDING SETTLED? ──────────────────────────────────────────────
// Three things must all hold. Any one missing makes it a proposal.
//
//   1. it names a field and a value to put there
//   2. that field is not money
//   3. the value came from the DATA, not from a guess — `from` says where,
//      and a fix with no provenance is a guess however sure it looks
function classify(fix) {
    if (!fix || typeof fix !== 'object') return PROPOSED;
    if (!str(fix.field) || fix.to === undefined || fix.to === null || str(fix.to) === '') return PROPOSED;
    if (touchesMoney(fix)) return PROPOSED;
    if (!str(fix.from_source)) return PROPOSED;
    // An explicit refusal always wins. A check that knows its own answer is
    // uncertain says so, and nothing here overrides it.
    if (fix.needs_her === true) return PROPOSED;
    return SETTLED;
}

// ── SORT A RUN'S FINDINGS ─────────────────────────────────────────────────
// Takes whatever the existing jobs produced, normalised into findings with an
// optional `fix`, and splits them. Pure: it reads, it decides, it writes
// nothing. The applying is a separate call so a caller can show her the split
// first — and so a dry run is the default rather than a flag.
function sort(findings) {
    const settled = [];
    const proposed = [];
    for (const f of (Array.isArray(findings) ? findings : [])) {
        if (!f) continue;
        const kind = classify(f.fix);
        (kind === SETTLED ? settled : proposed).push({ ...f, kind });
    }
    return { settled, proposed, total: settled.length + proposed.length };
}

// ── WHAT A DAY'S RUN LOOKS LIKE ───────────────────────────────────────────
// Reads the checks that already exist rather than re-deriving them. Each
// source is wrapped: one throwing source must not cost her the whole report,
// and a source that breaks should say so in the email rather than vanish —
// the same contract integritySweep already uses for its own checks.
function collect({ sources } = {}) {
    const findings = [];
    const broken = [];
    const use = sources || defaultSources();
    for (const s of use) {
        try {
            const got = s.run() || [];
            for (const g of got) findings.push({ source: s.id, ...g });
        } catch (e) {
            broken.push({ id: s.id, error: String((e && e.message) || e).slice(0, 200) });
        }
    }
    return { findings, broken };
}

// The existing jobs, read rather than repeated. Deliberately a function and
// not a constant: requiring these at module load would pull half the app into
// anything that merely wants `classify`.
function defaultSources() {
    return [
        {
            id: 'integrity-sweep',
            // Already runs at 06:30 and is already silent when clean. Its
            // findings arrive here WITHOUT a `fix`, so every one of them is a
            // proposal — which is correct: a weight gap or an unjoined
            // container is a question, not a typo.
            run() {
                const sweep = require('./integritySweep');
                const res = sweep.run();
                const out = [];
                for (const f of (res.findings || [])) {
                    for (const item of (f.items || [])) {
                        out.push({ check: f.id, title: f.title, why: f.why,
                                   what: item.what, detail: item.detail });
                    }
                }
                return out;
            },
        },
        {
            id: 'yard-claims',
            // Her daily claim reminder, carried into the same report so an
            // open claim is visible beside the paperwork it belongs to.
            run() {
                const yc = require('./yardClaims');
                return yc.openForReminder().map((c) => ({
                    check: 'open-claim',
                    title: 'Claim still open',
                    what: `${c.load_id}${c.seller ? ` — ${c.seller}` : ''}`,
                    detail: `$${Number(c.amount).toFixed(2)} · ${c.reason}`
                        + (c.age_days == null ? '' : ` · ${c.age_days} day${c.age_days === 1 ? '' : 's'} old`),
                }));
            },
        },
    ];
}

// ── THE EMAIL ─────────────────────────────────────────────────────────────
// Her own daily mail, which is what she chose over folding into the sweep.
// Two sections, in this order, because the second is the one needing her:
// what was tidied (so she can see it was done and object), then what is
// waiting (so she can act).
//
// SILENT WHEN THERE IS NOTHING. A daily email that arrives saying "all clear"
// every day for a month is an email that stops being opened, and the day it
// matters she will not open it either.
function reportText(run) {
    const s = run.settled || [];
    const p = run.proposed || [];
    const broken = run.broken || [];
    if (!s.length && !p.length && !broken.length) return null;

    const out = [];
    if (p.length) {
        // The VERB agrees too. "1 thing need you" is the kind of line that
        // makes a person trust the rest of the email slightly less, and this
        // mail exists to be trusted at a glance.
        out.push(p.length === 1 ? '1 thing needs you.' : `${p.length} things need you.`);
    } else {
        out.push('Nothing needs you today.');
    }
    out.push('');

    if (p.length) {
        out.push('── WAITING FOR YOU ──────────────────────────────');
        for (const f of p) {
            out.push(`  · ${f.what || f.title}`);
            if (f.detail) out.push(`      ${f.detail}`);
            // Both figures, always, when there are two. This is the whole
            // point of a proposal — she should not have to go and look one up
            // to judge the other.
            if (f.fix && f.fix.field) {
                out.push(`      ${f.fix.field}: ${str(f.fix.from) || '(blank)'} → ${str(f.fix.to)}`
                    + (f.fix.from_source ? `  (${f.fix.from_source})` : ''));
            }
        }
        out.push('');
    }

    if (s.length) {
        out.push(`── TIDIED, NOTHING TO DO ───────────────────────`);
        out.push('  (one possible answer each — say so if any of these look wrong)');
        for (const f of s) {
            out.push(`  · ${f.what || f.title}`
                + (f.fix ? `: ${f.fix.field} → ${str(f.fix.to)}` : ''));
        }
        out.push('');
    }

    if (broken.length) {
        // Said out loud rather than swallowed. A check that silently stopped
        // running is worse than one that fails, because the report keeps
        // looking clean.
        out.push('── A CHECK DID NOT RUN ─────────────────────────');
        for (const b of broken) out.push(`  · ${b.id}: ${b.error}`);
    }
    return out.join('\n');
}

module.exports = {
    SETTLED, PROPOSED, MONEY_FIELDS,
    touchesMoney, classify, sort, collect, defaultSources, reportText,
};
