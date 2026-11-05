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

// ── WHAT QUICKBOOKS IS WAITING ON ─────────────────────────────────────────
// Apsara, 2026-10-01: "so (bills+invoice) agent should talk to this agent."
//
// The QuickBooks agent knows which blanks are stopping rows entering her
// books. It does NOT know what the values should be — only her sheet knows
// that, and this agent is the one reading it. So the conversation is one
// fact wide: WHICH FIELD ON WHICH ROW IS HOLDING UP THE BOOKS.
//
// What it changes is URGENCY, not the decision. A blank seal_no is untidy; a
// blank date is stopping a bill entering her accounts. Both get filled from
// the sheet by the same code — but the second is worth saying out loud, and
// sorting first, and chasing when the sheet cannot answer it.
//
// It never makes a finding MORE writable. A money field blocking QuickBooks
// is still proposed, because the gate that keeps money in front of her does
// not get to be overridden by urgency — that is exactly the kind of "but this
// one is important" exception that money controls exist to refuse.
//
// Pure, and takes the lookup rather than building it: this file does not
// import qbAgent, so neither agent depends on the other at load time and
// either can be tested without the other's token.
function markBlocking(findings, blockingMap) {
    const map = blockingMap || new Map();
    if (!map.size) return Array.isArray(findings) ? findings : [];
    return (Array.isArray(findings) ? findings : []).map((f) => {
        if (!f || !f.fix || !f.fix.field) return f;
        const ledger = str(f.ledger) || 'bills';
        const hit = map.get(`${ledger}:${str(f.row_id)}:${str(f.fix.field)}`);
        if (!hit) return f;
        return {
            ...f,
            blocks_quickbooks: true,
            detail: `${str(f.detail) ? `${f.detail}. ` : ''}QuickBooks cannot take this row until ${f.fix.field} is filled in.`,
        };
    });
}

// Urgent first, within whichever list they land in. A sort, not a filter —
// nothing is hidden.
const blockingFirst = (list) => [...(list || [])]
    .sort((a, b) => (b && b.blocks_quickbooks ? 1 : 0) - (a && a.blocks_quickbooks ? 1 : 0));

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
            id: 'sheet-diff',
            // ── WHERE THE SETTLED FIXES ACTUALLY COME FROM ───────────────
            // Apsara, 2026-10-01: "for rest of the others,check sheet
            // properly,whatever is missed in jarvis fill it."
            //
            // helpers/metalsSheetSync.differences() already compares her live
            // sheet against Jarvis field by field and reports {field, sheet,
            // jarvis}. The nightly job has been printing those for weeks and
            // nothing has ever acted on one.
            //
            // The split falls out of the data rather than needing a rule:
            //
            //   Jarvis BLANK, the sheet has a value  → one possible answer.
            //       Nothing is being overruled; a gap is being filled from
            //       the document she keeps it in. SETTLED, unless the field
            //       is money.
            //   BOTH have values and they disagree   → two answers, and only
            //       she knows which. ALWAYS a proposal, money or not: a
            //       container number typed in Jarvis and a different one on
            //       the sheet is not a gap, it is a contradiction.
            //
            // NO NETWORK IN HERE. The night job already fetched the workbook
            // and holds the report; it hands it in. A source that fetched on
            // its own would double her Google calls and make this file
            // untestable without one.
            report: null,
            run() {
                const rep = this.report;
                const out = [];
                // ── THE REAL KEYS ────────────────────────────────────────
                // The first version read `rep.differing`, which does not
                // exist. metalsSheetSync returns changedBills and
                // changedSales. Nothing threw — the source simply produced
                // NOTHING, for ever, and the email looked clean. Caught by
                // running the job end to end rather than by reading it.
                //
                // ── AND THE BLANKS COME FROM A DIFFERENT LIST ────────────
                // changedBills/changedSales are DISAGREEMENTS only. The sync's
                // same() returns true when either side is blank, on purpose
                // ("a field she has not filled in yet on one side is the
                // normal state of a live sheet") — so a blank never appears
                // there, and this source's whole fill-what-is-missing half
                // was unreachable. It could only ever propose.
                //
                // Her words were "whatever is missed in jarvis fill it", so
                // metalsSheetSync now also reports fillableBills /
                // fillableSales — blanks, kept out of the disagreements list
                // so they do not flood her nightly email. Both lists are read
                // here and carry the same shape; `differences` vs `blanks` is
                // the only difference, and jarvisBlank sorts out the rest.
                const rows = [
                    ...((rep && rep.changedBills) || []).map((r) => ({ ...r, ledger: 'bills' })),
                    ...((rep && rep.changedSales) || []).map((r) => ({ ...r, ledger: 'sales' })),
                    ...((rep && rep.fillableBills) || []).map((r) => ({ ...r, ledger: 'bills', differences: r.blanks })),
                    ...((rep && rep.fillableSales) || []).map((r) => ({ ...r, ledger: 'sales', differences: r.blanks })),
                ];
                for (const r of rows) {
                    for (const d of (r.differences || [])) {
                        const jarvisBlank = str(d.jarvis) === ''
                            || /^no [a-z ]+$/i.test(str(d.jarvis));
                        out.push({
                            check: 'sheet-diff',
                            // Which ledger and which row — apply() cannot
                            // write without both, and a finding that cannot
                            // be acted on is a finding that wastes her time.
                            ledger: r.ledger,
                            row_id: r.row_id,
                            title: jarvisBlank ? 'Missing in Jarvis' : 'Jarvis and the sheet disagree',
                            what: `${r.container_no || r.key || '(no container)'}`
                                + `${r.supplier || r.customer ? ` — ${r.supplier || r.customer}` : ''}`,
                            detail: `${d.field}: sheet says ${str(d.sheet) || '(blank)'}`
                                + (jarvisBlank ? ', Jarvis has nothing' : `, Jarvis says ${str(d.jarvis)}`),
                            fix: {
                                field: d.field,
                                from: d.jarvis,
                                to: d.sheet,
                                from_source: 'the sheet',
                                // A disagreement is never settled, whatever
                                // the field. classify() would already propose
                                // it for money; this makes it explicit for
                                // every other field too.
                                needs_her: !jarvisBlank,
                            },
                        });
                    }
                }
                return out;
            },
        },

        // ── NO YARD SOURCE HERE, AND THAT IS THE POINT ───────────────────
        // A yard-claims source sat here for one afternoon. Apsara removed it:
        // "EDGE_9 — Ramesh never involve yard with this."
        //
        // Her instruction was "handle both bills and invoice" — Edge Metals'
        // paperwork. A claim against a load the yard bought belongs to the
        // other company, and it has its own daily channel: the 8PM yard
        // report. One agent reading both ledgers would make two sets of books
        // look like one, which is the thing rule 5 exists to prevent.
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
// ── HOW IT READS (2026-11-05) ────────────────────────────────────────────
// Apsara, on the 4 Nov mail, 191 lines long: "this looks ugly, i dont feel like
// reading this mail at all". It listed every finding as three lines, so 100 of
// them were one container's sheet fields printed one per line. Now:
//   * a count per KIND at the top, so the shape of the day is visible in five lines;
//   * findings grouped by kind, and rows about the SAME container merged into one
//     line carrying all its fields;
//   * at most SHOW_PER_GROUP lines per kind in the body - the rest are in the
//     attached CSV, which opens in a sheet, so nothing is hidden, only moved;
//   * the same content as a clean HTML mail (reportHtml). The plain text stays for
//     clients that do not render HTML, and for the first-line contract the tests pin.
const SHOW_PER_GROUP = 5;

function fixLine(f) {
    return `${f.field}: ${str(f.from) || '(blank)'} \u2192 ${str(f.to)}`
        + (f.from_source ? `  (${f.from_source})` : '');
}

// Findings -> [{ title, count, compact, items: [{ what, lines }] }], first-appearance order.
// Same `what` inside one kind is ONE item with several lines.
//
// `compact` (Apsara, 2026-11-05: "if some containers has no suppliers put one heading
// ... list all container below ... make it crisp"): a kind whose findings carry no fix
// and all say the same thing once the numbers are ignored ("bought N days ago and not
// sold") needs only the containers listed under its heading, ALL of them, not capped.
// Kinds that carry values (a sheet figure against Jarvis's) keep the capped list with
// both figures; every row is in the attached CSV.
const normDetail = (d) => String(d || '').replace(/\d[\d,.]*/g, '#').trim().toLowerCase();

function groupFindings(list) {
    const groups = new Map();
    for (const f of list || []) {
        const title = f.title || 'Other';
        if (!groups.has(title)) groups.set(title, { title, count: 0, items: new Map(), details: new Set(), anyFix: false });
        const g = groups.get(title);
        g.count++;
        if (f.fix && f.fix.field) g.anyFix = true;
        g.details.add(normDetail(f.detail));
        // Compact only if the ONLY numbers in the detail are ages ("22 days ago"). A weight
        // or an amount ("52,220 lb weighed, no price") is the thing she decides on, so a
        // row carrying one keeps its detail line.
        if (/\d/.test(String(f.detail || '').replace(/\d+ days? ago/g, ''))) g.hasFigures = true;
        const key = String(f.what || f.title || '');
        if (!g.items.has(key)) g.items.set(key, { what: key, lines: [] });
        const it = g.items.get(key);
        const fixField = f.fix && f.fix.field ? String(f.fix.field) : '';
        // DON'T SAY THE SAME FIELD TWICE: the sheet source sets both a detail and a
        // fix on the same field; the fix line names where the number came from.
        const detailRepeats = fixField && String(f.detail || '').trim().startsWith(`${fixField}:`);
        if (f.detail && !detailRepeats) it.lines.push(String(f.detail));
        if (f.fix && f.fix.field) it.lines.push(fixLine(f.fix));
    }
    return [...groups.values()].map((g) => ({
        title: g.title, count: g.count,
        compact: !g.anyFix && !g.hasFigures && g.details.size <= 1 && g.items.size > 1,
        items: [...g.items.values()],
    }));
}

function itemText(it) {
    if (!it.lines.length) return [`  \u00b7 ${it.what}`];
    if (it.lines.length === 1) return [`  \u00b7 ${it.what} \u2014 ${it.lines[0]}`];
    return [`  \u00b7 ${it.what}`, ...it.lines.map((l) => `      ${l}`)];
}

function reportText(run, { csvName = null } = {}) {
    const s = run.settled || [];
    const p = run.proposed || [];
    const broken = run.broken || [];
    if (!s.length && !p.length && !broken.length) return null;

    const out = [];
    if (p.length) {
        // The VERB agrees too. "1 thing need you" makes a person trust the rest of
        // the email slightly less, and this mail exists to be trusted at a glance.
        out.push(p.length === 1 ? '1 thing needs you.' : `${p.length} things need you.`);
    } else {
        out.push('Nothing needs you today.');
    }
    out.push('');

    if (p.length) {
        const groups = groupFindings(p);
        out.push('\u2500\u2500 WAITING FOR YOU \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
        if (groups.length > 1) {
            for (const g of groups) out.push(`  ${String(g.count).padStart(4)}   ${g.title}`);
            out.push('');
        }
        let truncated = 0;
        for (const g of groups) {
            if (groups.length > 1) out.push(`${g.title} (${g.count})`);
            if (g.compact) {
                // every container, three to a line
                const names = g.items.map((it) => it.what);
                for (let i = 0; i < names.length; i += 3) out.push('  ' + names.slice(i, i + 3).join('   \u00b7   '));
                out.push('');
                continue;
            }
            for (const it of g.items.slice(0, SHOW_PER_GROUP)) out.push(...itemText(it));
            const rest = g.items.length - SHOW_PER_GROUP;
            if (rest > 0) { truncated += rest; out.push(`  ...and ${rest} more`); }
            out.push('');
        }
        if (truncated) out.push(csvName ? `The full list is attached (${csvName}) - it opens in a sheet.` : 'The full list is in the attached file.', '');
    }

    if (s.length) {
        out.push('\u2500\u2500 TIDIED, NOTHING TO DO \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
        out.push('  (one possible answer each - say so if any of these look wrong)');
        const shown = s.slice(0, SHOW_PER_GROUP * 2);
        for (const f of shown) {
            out.push(`  \u00b7 ${f.what || f.title}` + (f.fix ? `: ${f.fix.field} \u2192 ${str(f.fix.to)}` : ''));
        }
        if (s.length > shown.length) out.push(`  ...and ${s.length - shown.length} more`);
        out.push('');
    }

    if (broken.length) {
        // Said out loud rather than swallowed. A check that silently stopped
        // running is worse than one that fails, because the report keeps looking clean.
        out.push('\u2500\u2500 A CHECK DID NOT RUN \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
        for (const b of broken) out.push(`  \u00b7 ${b.id}: ${b.error}`);
    }
    return out.join('\n');
}

const escHtml = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The same report as a clean mail. Inline styles only (mail clients drop <style>).
function reportHtml(run, { csvName = null } = {}) {
    const s = run.settled || [];
    const p = run.proposed || [];
    const broken = run.broken || [];
    if (!s.length && !p.length && !broken.length) return null;
    const ink = '#1f2937', mute = '#6b7280', line = '#e5e7eb', accent = '#b45309';
    const h = (t) => `<div style="font:600 12px Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:${mute};margin:22px 0 8px">${escHtml(t)}</div>`;
    const out = [`<div style="font:14px/1.5 Arial,sans-serif;color:${ink};max-width:640px">`];
    out.push(`<div style="font:600 20px Arial,sans-serif;margin-bottom:2px">${p.length ? (p.length === 1 ? '1 thing needs you' : `${p.length} things need you`) : 'Nothing needs you today'}</div>`);
    if (p.length) {
        const groups = groupFindings(p);
        out.push(`<div style="color:${mute};margin-bottom:6px">Open the attached list for every line.</div>`);
        if (groups.length > 1) {
            out.push(`<table style="border-collapse:collapse;width:100%;margin:10px 0">`);
            for (const g of groups) {
                out.push(`<tr><td style="padding:6px 10px;border-bottom:1px solid ${line};width:56px;font-weight:700;color:${accent};text-align:right">${g.count}</td><td style="padding:6px 10px;border-bottom:1px solid ${line}">${escHtml(g.title)}</td></tr>`);
            }
            out.push('</table>');
        }
        for (const g of groups) {
            out.push(h(groups.length > 1 ? `${g.title} (${g.count})` : 'Waiting for you'));
            if (g.compact) {
                out.push(`<div style="line-height:1.9">${g.items.map((it) => `<span style="display:inline-block;background:#f3f4f6;border-radius:4px;padding:1px 8px;margin:0 6px 4px 0;font-size:13px">${escHtml(it.what)}</span>`).join('')}</div>`);
                continue;
            }
            out.push(`<table style="border-collapse:collapse;width:100%">`);
            for (const it of g.items.slice(0, SHOW_PER_GROUP)) {
                out.push(`<tr><td style="padding:7px 10px;border-bottom:1px solid ${line};vertical-align:top"><div style="font-weight:600">${escHtml(it.what)}</div>`
                    + it.lines.map((l) => `<div style="color:${mute};font-size:13px">${escHtml(l)}</div>`).join('') + '</td></tr>');
            }
            const rest = g.items.length - SHOW_PER_GROUP;
            if (rest > 0) out.push(`<tr><td style="padding:7px 10px;color:${mute}">\u2026and ${rest} more</td></tr>`);
            out.push('</table>');
        }
    }
    if (s.length) {
        out.push(h('Tidied, nothing to do'));
        out.push(`<div style="color:${mute};font-size:13px;margin-bottom:6px">One possible answer each \u2014 say so if any look wrong.</div>`);
        for (const f of s.slice(0, SHOW_PER_GROUP * 2)) {
            out.push(`<div style="padding:3px 0">${escHtml(f.what || f.title)}${f.fix ? ` <span style="color:${mute}">\u2014 ${escHtml(f.fix.field)} \u2192 ${escHtml(str(f.fix.to))}</span>` : ''}</div>`);
        }
        if (s.length > SHOW_PER_GROUP * 2) out.push(`<div style="color:${mute}">\u2026and ${s.length - SHOW_PER_GROUP * 2} more</div>`);
    }
    if (broken.length) {
        out.push(h('A check did not run'));
        for (const b of broken) out.push(`<div style="color:#b91c1c">${escHtml(b.id)}: ${escHtml(b.error)}</div>`);
    }
    if (csvName) out.push(`<div style="margin-top:22px;color:${mute};font-size:13px">Full list attached: ${escHtml(csvName)}</div>`);
    out.push('</div>');
    return out.join('');
}

// Every finding, one row each, for a spreadsheet. Nothing is truncated here.
function fullListCsv(run) {
    const q = (v) => { const t = String(v == null ? '' : v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const rows = [['Status', 'Kind', 'What', 'Detail', 'Field', 'Jarvis has', 'Should be', 'Source']];
    const add = (status, list) => { for (const f of list || []) {
        rows.push([status, f.title || '', f.what || '', f.detail || '',
            f.fix ? f.fix.field : '', f.fix ? str(f.fix.from) : '', f.fix ? str(f.fix.to) : '', f.fix ? (f.fix.from_source || '') : '']); } };
    add('Needs you', run.proposed); add('Tidied', run.settled);
    return rows.map((r) => r.map(q).join(',')).join('\r\n');
}

// ── WRITING THE SETTLED ONES ──────────────────────────────────────────────
// The only function in this file that changes anything, and it re-decides
// every fix for itself rather than trusting the `kind` it was handed.
//
// That is not paranoia about the caller — it is that sort() and apply() can
// be separated by a screen, a queue or a night, and a finding classified as
// settled an hour ago may be sitting next to a row she has edited since. The
// classification is cheap; being wrong about it is not.
//
// ONE ROW AT A TIME, through editBill/editSale, which PATCH rather than
// replace. helpers/loads.js records what happens when a writer rebuilds a
// record wholesale — pdf_link vanished — and a bill has twenty-three columns.
//
// NOTHING IS OVERWRITTEN. A fix is applied only if the field is STILL blank
// at write time. If she filled it in herself between the scan and the send,
// hers wins and the fix is reported as skipped — she typed it for a reason,
// and the sheet is not more right than the person looking at the paperwork.
// `allowMoney` — DEFAULT FALSE, so every existing caller behaves exactly as
// it did. The 07:30 agent passes nothing and still cannot write a money
// field; that refusal is the rule, not an accident, and it stays.
//
// The flag marks the NEW shape rather than the old one (CLAUDE.md: "a flag
// that must be set to keep an existing document unchanged will eventually
// not be set"). Only scripts/fill-money-blanks.js sets it, and only after
// Apsara has seen every figure and typed --apply.
//
// Why here rather than a second apply() in that script: the QuickBooks gate
// below is the part that must not be duplicated. A row already pushed to QB
// must never be auto-filled, it fails CLOSED when QB cannot be reached, and
// a second copy of that logic would drift from this one silently.
async function apply(findings, { kinds, allowMoney = false } = {}) {
    const applied = [];
    const skipped = [];
    const failed = [];
    const stores = kinds || {
        bills: { list: () => require('./bills').list(), edit: (id, p) => require('./bills').editBill(id, p) },
        sales: { list: () => require('./sales').list(), edit: (id, p) => require('./sales').editSale(id, p) },
    };

    // ── ASK QUICKBOOKS FIRST, ONCE ───────────────────────────────────────
    // Apsara, 2026-10-01: "so (bills+invoice) agent should talk to this
    // agent". This is that conversation, in the direction that prevents harm.
    //
    // A row already pushed to QuickBooks must not be auto-filled: QB is not
    // re-pushed for an edit, so the fill would leave her books saying one
    // thing and Jarvis another, with nothing recording who changed it. Her
    // instruction for this agent was "ensure that there is no discrepancy" —
    // an agent that silently creates one has failed at its only job.
    //
    // Read once per run from the local journal, not per row and not over the
    // network. See helpers/qbLinked.js for why it fails CLOSED.
    const qb = require('./qbLinked');
    let qbKeys = null;
    let qbKeysError = null;
    try { qbKeys = qb.liveKeys(); } catch (e) { qbKeysError = String((e && e.message) || e); }

    for (const f of (Array.isArray(findings) ? findings : [])) {
        if (!f || !f.fix) continue;
        // Re-decided here, every time.
        //
        // With allowMoney, a finding that is proposed ONLY because it touches
        // money is let through — and nothing else is. A fix with no field, no
        // value, no provenance, or an explicit needs_her is still refused,
        // because those are not "money needs her consent", they are "we do
        // not actually know the answer".
        const kind = classify(f.fix);
        if (kind !== SETTLED) {
            const onlyBecauseMoney = allowMoney
                && touchesMoney(f.fix)
                && str(f.fix.field) && f.fix.to !== undefined && f.fix.to !== null && str(f.fix.to) !== ''
                && str(f.fix.from_source)
                && f.fix.needs_her !== true;
            if (!onlyBecauseMoney) { skipped.push({ ...f, why: 'not settled' }); continue; }
        }
        const ledger = str(f.ledger) || 'bills';
        const store = stores[ledger];
        if (!store) { failed.push({ ...f, error: `unknown ledger ${ledger}` }); continue; }
        const id = str(f.row_id);
        if (!id) { skipped.push({ ...f, why: 'no row id' }); continue; }

        try {
            const row = (store.list() || []).find((r) => r && String(r.id) === id);
            if (!row) { skipped.push({ ...f, why: 'row is gone' }); continue; }

            // ── THE QUICKBOOKS GATE ──────────────────────────────────────
            // Checked against the ROW, after it is loaded, because the link
            // may be on the container rather than the id — push.js links by
            // `b.id || b.container_no`, and a finding only carries the id.
            //
            // Skipped, not failed: nothing is wrong. It becomes a proposal
            // in the email, which is where she can act on it in both books
            // at once. A failure would read as a bug and get ignored.
            const link = qbKeys
                ? qb.linkedRow(row, { kind: ledger, keys: qbKeys })
                : { linked: true, why: `could not check QuickBooks (${qbKeysError}) — nothing changed behind your books` };
            if (link.linked) {
                skipped.push({ ...f, why: `${link.why}. Change it in both, or leave it.` });
                continue;
            }

            if (str(row[f.fix.field]) !== '') {
                skipped.push({ ...f, why: `already filled in — ${str(row[f.fix.field])}` });
                continue;
            }
            await store.edit(id, { [f.fix.field]: f.fix.to });
            applied.push({ ...f });
        } catch (e) {
            // A failure on one row must not stop the rest, and must be said.
            failed.push({ ...f, error: String((e && e.message) || e).slice(0, 200) });
        }
    }
    return { applied, skipped, failed };
}

module.exports = {
    SETTLED, PROPOSED, MONEY_FIELDS,
    touchesMoney, classify, sort, collect, defaultSources, reportText, reportHtml, fullListCsv, groupFindings, SHOW_PER_GROUP, apply,
    markBlocking, blockingFirst,
};
