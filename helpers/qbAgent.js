// ── helpers/qbAgent.js — the QuickBooks agent ─────────────────────────────
// Apsara, 2026-10-01: "Assign one agent for quickbook next", and then "so
// (bills+invoice) agent should talk to this agent".
//
// ── WHAT IT IS FOR ────────────────────────────────────────────────────────
// The nightly QuickBooks run already pushes what it can. What it cannot push
// it counts: her email says "7 blocked" and stops there. Seven rows, no names
// and no reasons, and the only way to find out was a terminal script. So a
// blocked row stayed blocked, and the number quietly grew.
//
// This agent turns that count into a list she can act on, and splits it by
// WHO CAN ACT.
//
// ── THE SPLIT, WHICH IS THE WHOLE DESIGN ──────────────────────────────────
// push.js reports two completely different kinds of problem in one array,
// and treating them alike is why "7 blocked" was useless:
//
//   JARVIS IS MISSING SOMETHING
//     'no bill date', 'no invoice number', 'no supplier amount yet',
//     'grade "X" has no amount'
//     → A blank in a bill or a sale. The 07:30 ledger agent already fills
//       blanks from her sheet. So these are HANDED TO IT — not re-implemented
//       here. This agent's contribution is that it knows these particular
//       blanks are holding up her books, which makes them urgent rather than
//       merely untidy.
//
//   QUICKBOOKS IS MISSING SOMETHING
//     'vendor "X" not found', 'item "Y" not found', 'no "Trucking" account'
//     → Nothing in Jarvis can fix this. It needs a vendor or an item CREATED
//       IN HER BOOKS, and this agent will never do that on its own: a vendor
//       invented at 7am is a line in her chart of accounts she did not
//       choose, and scripts/qb-create-party.js is deliberately a thing a
//       person runs. So these are reported to her, with the script named.
//
//   AND A THIRD, WHICH IS NOT A PROBLEM AT ALL
//     'before-cutover' — the period that belongs to her accountant. Counted,
//     never chased. Her 2026-09-26 rule: moving the boundary would turn the
//     sweep loose on a closed period.
//
// ── IT WRITES NOTHING. AT ALL. ────────────────────────────────────────────
// Not to QuickBooks, not to the ledgers, not to the journal. It runs the
// sweep in DRY RUN and reads what comes back. Every power it might want —
// pushing, creating a vendor, voiding — already exists behind her two
// switches (QB_PROD_WRITES, QB_SYNC) and her own screens, and an agent that
// quietly added an eighth path into her books would undo the point of having
// them.
//
// That is also why this file has no apply(). The ledger agent has one because
// filling a blank in Jarvis is reversible and visible. Nothing here is.

const LEDGER_FOR = { bill: 'bills', sale: 'sales' };

// ── TRANSLATING A SENTENCE INTO A FIELD ───────────────────────────────────
// push.js's problems are English, written for a person. To hand one to the
// ledger agent it has to become a field name.
//
// Matched on the WORDING push.js uses, which makes this a contract between
// two files and therefore a thing that can rot silently. tests/qb-agent.js
// asserts every pattern here still matches a real problem string produced by
// the real buildBill — the lesson from this morning, when a source read a
// report key that had never existed and simply returned nothing for ever.
//
// Deliberately NOT a catch-all regex. An unrecognised problem is reported to
// her verbatim under "needs you" rather than guessed at — a wrong guess here
// becomes a wrong auto-fill in her ledger, which is the one outcome worth
// paying real caution for.
const JARVIS_BLANKS = [
    { re: /^no bill date$/i,                      field: 'date' },
    { re: /^no invoice number\b/i,                field: 'invoice_no' },
    { re: /^no supplier amount yet$/i,            field: 'amount' },
    { re: /^no customer amount yet$/i,            field: 'amount' },
    { re: /^grade "[^"]*" has no amount$/i,       field: 'amount' },
];

// QuickBooks-side: nothing in Jarvis can fix these, and each has a specific
// thing SHE does. The hint is the script or screen, named — a report that
// says "vendor not found" and not what to do about it is the "7 blocked"
// problem again, one level down.
const QB_SIDE = [
    { re: /vendor "([^"]*)" not found/i,  what: (m) => `vendor "${m[1]}" is not in QuickBooks`,
      hint: 'add it there, or run scripts/qb-create-party.js to create it from Jarvis' },
    { re: /customer "([^"]*)" not found/i, what: (m) => `customer "${m[1]}" is not in QuickBooks`,
      hint: 'add it there, or run scripts/qb-create-party.js to create it from Jarvis' },
    { re: /item "([^"]*)" not found/i,    what: (m) => `item "${m[1]}" is not in QuickBooks`,
      hint: 'add the item there, or map the grade on the QuickBooks page' },
    { re: /grade "([^"]*)" has no QuickBooks item/i, what: (m) => `grade "${m[1]}" is not mapped to a QuickBooks item`,
      hint: 'map it on the QuickBooks page' },
    { re: /no "Trucking" account found/i, what: () => 'there is no Trucking account in QuickBooks',
      hint: 'create it there — the trucking line cannot be posted without it' },
    { re: /longer than QuickBooks allows/i, what: (m) => m[0],
      hint: 'shorten the invoice number in Jarvis, or in QuickBooks after it is in' },
];

// Mismatched arithmetic is its own category: BOTH books are internally fine,
// and the disagreement is a real one that only she can call.
const ARITHMETIC = /lines add to ([\d.]+) but Jarvis says ([\d.]+)/i;

// ── THE SAME ADVICE, SAID DIFFERENTLY ON A PHONE (2026-10-02) ─────────────
// The hints above name terminal scripts, which is right in an email she
// reads at a desk and wrong in a chat message she reads on her phone. Her
// 2026-09-26 words were "i basically want my website to handle whatever we
// can do from qb from here" — so a chat hint telling her to open a terminal
// is the opposite of that.
//
// WHAT IS ACTUALLY TRUE TODAY, and worth being exact about: the server HAS
// POST /api/qb/create-party, but the QuickBooks page has NO CONTROL for it
// (grep: zero hits in dashboard/index.html). So there is no on-screen way to
// create a vendor from Jarvis, and a chat hint claiming otherwise would be
// the promise-is-the-bug failure again. Until that button exists, the
// honest phone answer is "add it in QuickBooks, the name must match" —
// because push.js matches on the exact confirmed name, so a near-miss
// spelling blocks the row again tomorrow.
//
// One function so the two channels cannot drift; the email keeps the script,
// which is the better instruction when she is at a keyboard.
const PHONE_HINT = [
    [/qb-create-party/, 'add the name in QuickBooks exactly as Jarvis spells it — '
        + 'an almost-match blocks the row again tomorrow'],
    [/map the grade on the QuickBooks page/, 'map the grade on the QuickBooks page'],
    [/create it there/, 'it has to be created in QuickBooks before the trucking line can post'],
];

function hintFor(finding, { channel = 'email' } = {}) {
    const hint = str(finding && finding.hint);
    if (!hint || channel !== 'chat') return hint || '';
    for (const [re, phone] of PHONE_HINT) if (re.test(hint)) return phone;
    return hint;
}

const str = (v) => String(v == null ? '' : v).trim();

// ── ONE PROBLEM, CLASSIFIED ───────────────────────────────────────────────
function classifyProblem(problem) {
    const p = str(problem);
    if (!p) return null;
    for (const m of JARVIS_BLANKS) {
        if (m.re.test(p)) return { side: 'jarvis', field: m.field, problem: p };
    }
    const arith = p.match(ARITHMETIC);
    if (arith) {
        return { side: 'her', problem: p,
            hint: 'the line amounts and the payable figure disagree — one of them is wrong' };
    }
    for (const m of QB_SIDE) {
        const hit = p.match(m.re);
        if (hit) return { side: 'quickbooks', problem: p, what: m.what(hit), hint: m.hint };
    }
    // Unrecognised. Reported verbatim, never guessed at.
    return { side: 'unknown', problem: p };
}

// ── A DRY SWEEP, READ ─────────────────────────────────────────────────────
// `sweep` is injected so this is testable without a QuickBooks token, and so
// the job can hand in a sweep it already ran rather than running a second
// one. A dry sweep still TALKS to QuickBooks for the rows that get past the
// blocked checks (it looks for an existing match), so it is not free and must
// not be run twice in a morning.
async function look({ sweep, env } = {}) {
    const run = sweep || ((o) => require('./quickbooks/sync').sweep(o));
    const res = await run({ env, dryRun: true });
    const rows = Array.isArray(res && res.rows) ? res.rows : [];

    const blocked = [];
    for (const r of rows) {
        // 'created'/'exists'/'already-linked'/'waiting' are fine. 'before-cutover'
        // is her accountant's period and is left alone by design.
        if (!/^(blocked|error)/i.test(str(r.status))) continue;
        const parts = (r.problems && r.problems.length)
            ? r.problems
            // An error status with no problems array still has to appear —
            // a thrown push is the loudest kind of blocked.
            : [`the push failed: ${r.status}`];
        blocked.push({ ...r, found: parts.map(classifyProblem).filter(Boolean) });
    }
    return { blocked, counts: tally(blocked), rowsSeen: rows.length };
}

function tally(blocked) {
    const t = { rows: blocked.length, jarvis: 0, quickbooks: 0, her: 0, unknown: 0 };
    for (const b of blocked) for (const f of b.found) t[f.side] = (t[f.side] || 0) + 1;
    return t;
}

// ── THE HANDOFF TO THE LEDGER AGENT ───────────────────────────────────────
// Her words: "so (bills+invoice) agent should talk to this agent."
//
// This is the shape that conversation takes, and it is deliberately NOT a new
// protocol: it returns the field-level facts the ledger agent already works
// in, so that agent's existing sort/classify/apply handle them with no new
// code. One shared vocabulary beats two agents with an interface between
// them, which is a thing to maintain and get wrong.
//
// NOTE WHAT IS *NOT* RETURNED: a value. This agent knows a bill has no date;
// it does not know what the date should be. Only her sheet knows that, and
// the ledger agent is the one that reads it. So this hands over WHICH FIELD
// ON WHICH ROW IS HOLDING UP HER BOOKS, and the ledger agent — which already
// has the sheet open — decides whether it can fill it.
//
// Returns a Set-like lookup keyed `ledger:row_id:field`, because that is how
// the ledger agent identifies one of its own findings.
function blockingFields({ blocked } = {}) {
    const out = new Map();
    for (const b of (blocked || [])) {
        const ledger = LEDGER_FOR[str(b.kind)];
        if (!ledger) continue;              // payments are not a ledger row the agent fills
        for (const f of (b.found || [])) {
            if (f.side !== 'jarvis' || !f.field) continue;
            // Keyed by id AND container, because push links by either and a
            // ledger finding may carry only one of them.
            for (const id of [b.id, b.container_no].map(str).filter(Boolean)) {
                out.set(`${ledger}:${id}:${f.field}`, {
                    ledger, field: f.field, kind: b.kind,
                    why: `QuickBooks cannot take this row until ${f.field} is filled in`,
                });
            }
        }
    }
    return out;
}

// ── HER EMAIL ─────────────────────────────────────────────────────────────
// Only what she can act on, and only what the other agent is not already
// handling. A QuickBooks-side problem is hers; a Jarvis blank is the ledger
// agent's and is mentioned as a count, not re-listed — two emails listing the
// same row is how both stop being read.
//
// SILENT WHEN THERE IS NOTHING, like every other daily job here.
function reportText(look_) {
    const blocked = (look_ && look_.blocked) || [];
    if (!blocked.length) return null;

    const hers = [];
    const unknown = [];
    let handed = 0;
    for (const b of blocked) {
        const who = [b.container_no, b.invoice_no, b.party].map(str).filter(Boolean).join(' / ') || b.id || '(unidentified row)';
        for (const f of b.found) {
            if (f.side === 'jarvis') { handed += 1; continue; }
            // THROUGH hintFor, like the chat path. This read f.hint
            // directly while the comment above claimed "one function so the
            // two channels cannot drift" — so the function was the single
            // source of truth for exactly one of its two callers, and a
            // mutation that broke the channel switch could not be seen from
            // the email at all. The comment was true of the intent and false
            // of the code.
            const emailHint = hintFor(f, { channel: 'email' });
            const line = `  · ${who}\n      ${f.what || f.problem}`
                + (emailHint ? `\n      → ${emailHint}` : '');
            (f.side === 'unknown' ? unknown : hers).push(line);
        }
    }

    const out = [];
    const n = hers.length + unknown.length;
    out.push(n === 0
        ? 'QuickBooks is held up, but only on things the ledger agent is already filling.'
        : `${n} thing${n === 1 ? '' : 's'} ${n === 1 ? 'is' : 'are'} stopping rows going into QuickBooks.`);
    out.push('');

    if (hers.length) {
        out.push('── NEEDS YOU, IN QUICKBOOKS ─────────────────────');
        out.push(...hers);
        out.push('');
    }
    if (unknown.length) {
        // Verbatim, because a problem this file does not recognise is one it
        // must not paraphrase. Paraphrasing is how a wrong fix gets written.
        out.push('── BLOCKED, REASON NOT RECOGNISED ───────────────');
        out.push('  (reported exactly as QuickBooks gave it)');
        out.push(...unknown);
        out.push('');
    }
    if (handed) {
        out.push(`── ${handed} blank${handed === 1 ? '' : 's'} in Jarvis ────────────────────────`);
        out.push('  These are holding up QuickBooks too. The ledger agent is');
        out.push('  filling what your sheet has and will ask you about the rest,');
        out.push('  so they are not listed twice.');
        out.push('');
    }
    out.push(`Nothing was changed — in Jarvis or in QuickBooks. ${blocked.length} of ${look_.rowsSeen} rows are stuck.`);
    return out.join('\n');
}

module.exports = {
    JARVIS_BLANKS, QB_SIDE, LEDGER_FOR,
    classifyProblem, look, tally, blockingFields, reportText, hintFor, PHONE_HINT,
};
