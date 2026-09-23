#!/usr/bin/env node
// ── scripts/label.js — build the labelled dataset from the audit log ─────────
//
// READ-ONLY over data/logs/. Writes exactly one file: data/learning/labels.jsonl
//
// WHY THIS RUNS BEFORE ANY MODEL IS WRITTEN
// The point of this script is to answer one question honestly: HOW MANY
// LABELLED DECISIONS DO WE ACTUALLY HAVE? Every learning design so far has
// assumed the answer is "enough". Nobody has counted. If the answer comes back
// as 40 rows with 2 rejections, no model of any kind is fittable and the
// correct next step is to wait and collect — not to fit something anyway and
// call the output a policy.
//
// Two label sources, kept strictly separate in the output so they can be
// weighted differently later:
//
//   EXPLICIT — a source:'outcome' row written by helpers/outcome.js. Ground
//   truth: she answered a specific pending a specific way.
//
//   DERIVED — inferred from the shape of the log alone, so it works
//   RETROACTIVELY over logs written before outcome.js existed. The signal is
//   repetition: if she sends a near-identical message again on the same chat
//   within the window, the first handling did not satisfy her. This is the
//   only derived signal used, on purpose — it is the one with a real causal
//   story behind it. Derived labels are NEGATIVE-ONLY: a message not repeated
//   is not evidence of success, it is absence of evidence, and labelling it
//   'approved' would manufacture a majority class out of silence.
//
// Usage:  node scripts/label.js [--days 90] [--window 20] [--out <path>]

const fs   = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
function opt(name, dflt) {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}

const DAYS        = parseInt(opt('--days', '90'), 10);
const WINDOW_MIN  = parseInt(opt('--window', '20'), 10);
const SIMILARITY  = 0.6;   // Jaccard over content tokens
const RULE_ROLES  = new Set(['manager', 'team']);

// Resolve DATA_DIR the same way the app does, without booting config.js
// (config.js has side effects; this script must stay inert).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const LOGS_DIR = process.env.LOGS_DIR || path.join(DATA_DIR, 'logs');
const OUT_PATH = opt('--out', path.join(DATA_DIR, 'learning', 'labels.jsonl'));

// ── load ────────────────────────────────────────────────────────────────────
function loadEntries() {
    if (!fs.existsSync(LOGS_DIR)) {
        console.error(`[LABEL] no log directory at ${LOGS_DIR}`);
        return [];
    }
    const cutoff = Date.now() - DAYS * 86400000;
    const files  = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.jsonl')).sort();
    const out    = [];
    for (const f of files) {
        let text;
        try { text = fs.readFileSync(path.join(LOGS_DIR, f), 'utf8'); }
        catch { continue; }
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            let e;
            try { e = JSON.parse(line); } catch { continue; }   // truncated tail is normal
            const t = new Date(e.at).getTime();
            if (!Number.isFinite(t) || t < cutoff) continue;
            e._t = t;
            e._day = f.replace('.jsonl', '');
            out.push(e);
        }
    }
    out.sort((a, b) => a._t - b._t);
    return out;
}

// ── text similarity, for the repetition signal ──────────────────────────────
const STOP = new Set(['the','a','an','is','are','to','for','of','and','or','on','in','me','my','you','please','pls','can','do','did','it','that','this','with','at','be','i']);
function tokens(s) {
    return new Set(String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 1 && !STOP.has(w)));
}
function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    return inter / (a.size + b.size - inter);
}

// ── main ────────────────────────────────────────────────────────────────────
const entries = loadEntries();
if (!entries.length) {
    console.error(`[LABEL] no entries in the last ${DAYS} days under ${LOGS_DIR}`);
    console.error('[LABEL] If this is a source checkout, the live log is on the VM. Run it there.');
    process.exit(1);
}

// Decisions we could ever label: manager/team WhatsApp decisions from brain.js.
// Same fail-closed attribution rule as dailyLearning.findGaps — an entry whose
// author cannot be established is not a training row.
const decisions = entries.filter(e =>
    e.source === 'core' && RULE_ROLES.has(e.senderRole));

const outcomes = entries.filter(e => e.source === 'outcome');

const labelled = [];
const usedOutcome = new Set();

// 1. EXPLICIT — pair each outcome row to the most recent preceding decision on
//    the same chat. Nearest-preceding is the correct join here because a
//    pending is always created by a decision and answered after it.
for (const o of outcomes) {
    let best = null;
    for (let i = decisions.length - 1; i >= 0; i--) {
        const d = decisions[i];
        if (d._t > o._t) continue;
        if (d.chatId !== o.chatId) continue;
        best = d;
        break;
    }
    if (!best) continue;
    usedOutcome.add(best);
    labelled.push({
        label_source: 'explicit',
        at          : best.at,
        day         : best._day,
        chatId      : best.chatId,
        intent      : best.intent,
        resolvedBy  : best.resolvedBy,
        confidence  : typeof best.confidence === 'number' ? best.confidence : null,
        actionTaken : best.actionTaken,
        durationMs  : best.durationMs ?? null,
        decisionType: o.decisionType || null,
        actionType  : o.actionType || null,
        target      : o.target || null,
        outcome     : o.outcome,
        latencyMs   : o.latencyMs ?? null,
    });
}

// 2. DERIVED (negative only) — she asked again, near-identically, soon after.
const windowMs = WINDOW_MIN * 60000;
for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i];
    if (usedOutcome.has(d)) continue;          // explicit label wins, always
    if (!d.text) continue;
    const dt = tokens(d.text);
    if (dt.size < 2) continue;                 // "ok" / "yes" are not repeats
    let repeated = false;
    for (let j = i + 1; j < decisions.length; j++) {
        const n = decisions[j];
        if (n._t - d._t > windowMs) break;
        if (n.chatId !== d.chatId) continue;
        if (jaccard(dt, tokens(n.text)) >= SIMILARITY) { repeated = true; break; }
    }
    if (!repeated) continue;                   // NOT labelled 'approved' — see header
    labelled.push({
        label_source: 'derived',
        at          : d.at,
        day         : d._day,
        chatId      : d.chatId,
        intent      : d.intent,
        resolvedBy  : d.resolvedBy,
        confidence  : typeof d.confidence === 'number' ? d.confidence : null,
        actionTaken : d.actionTaken,
        durationMs  : d.durationMs ?? null,
        decisionType: null,
        actionType  : null,
        target      : null,
        outcome     : 'repeated',
        latencyMs   : null,
    });
}

labelled.sort((a, b) => new Date(a.at) - new Date(b.at));

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, labelled.map(r => JSON.stringify(r)).join('\n') + (labelled.length ? '\n' : ''), 'utf8');

// ── the report, which is the actual product of this script ──────────────────
const days = new Set(entries.map(e => e._day));
const by = (arr, k) => arr.reduce((m, r) => (m[r[k] ?? 'null'] = (m[r[k] ?? 'null'] || 0) + 1, m), {});
const pct = (n, d) => d ? `${((n / d) * 100).toFixed(1)}%` : '—';

console.log('');
console.log('══ LABELLING REPORT ══════════════════════════════════════════════');
console.log(`log days present      : ${days.size}  (${[...days].sort()[0] || '—'} → ${[...days].sort().pop() || '—'})`);
console.log(`audit entries read    : ${entries.length}`);
console.log(`  of which core       : ${entries.filter(e => e.source === 'core').length}`);
console.log(`  manager/team only   : ${decisions.length}   ← the only labelable population`);
console.log(`  explicit outcomes   : ${outcomes.length}`);
console.log('');
console.log(`LABELLED ROWS         : ${labelled.length}   (${pct(labelled.length, decisions.length)} of labelable)`);
console.log(`  explicit            : ${labelled.filter(r => r.label_source === 'explicit').length}`);
console.log(`  derived (negative)  : ${labelled.filter(r => r.label_source === 'derived').length}`);
console.log('');
console.log('outcome distribution  :', JSON.stringify(by(labelled, 'outcome')));
console.log('by action type        :', JSON.stringify(by(labelled.filter(r => r.actionType), 'actionType')));
const withConf = labelled.filter(r => r.confidence !== null).length;
console.log(`rows carrying confidence: ${withConf}  ← calibration needs these`);
console.log('');

// The verdict. Deliberately blunt, because the failure mode this guards
// against is fitting a model to 40 rows and believing the output.
const neg = labelled.filter(r => r.outcome !== 'approved').length;
const pos = labelled.filter(r => r.outcome === 'approved').length;
if (labelled.length < 200 || neg < 30 || pos < 30) {
    console.log('VERDICT: NOT ENOUGH DATA TO FIT ANYTHING.');
    console.log(`  Need roughly 200+ rows with 30+ in each class. Have ${labelled.length} (${pos} approved / ${neg} not).`);
    console.log('  Correct action is to keep collecting, not to fit a model anyway.');
} else {
    console.log('VERDICT: enough to attempt calibration (Stage 1). Bandit still needs per-pattern volume.');
}
console.log('══════════════════════════════════════════════════════════════════');
console.log(`\nwrote ${labelled.length} rows → ${OUT_PATH}`);
