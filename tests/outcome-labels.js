#!/usr/bin/env node
// ── tests/outcome-labels.js — Stage 0 of the learning layer, end to end ──────
//
// Runs against a TEMP DATA_DIR, never the real one. tests/integration.js and
// (until fixed) tests/requirements.js write to the live data/ — that trap cost
// a day on 2026-08-24 and this suite does not repeat it.
//
// The assertion that matters most is #4: an outcome row must NOT be selectable
// by dailyLearning.findGaps. If that ever fails, outcome rows have become a
// path into the rule-drafting prompt and Stage 0 has reopened the MemPoison
// hole that was closed on 2026-08-25.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-stage0-'));
process.env.DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });

let pass = 0, fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else      { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const ROOT = path.join(__dirname, '..');
const { recordOutcome, OUTCOMES } = require(path.join(ROOT, 'helpers', 'outcome'));
const { findGaps, RULE_SEEDING_ROLES } = require(path.join(ROOT, 'helpers', 'dailyLearning'));

function logLines() {
    const dir = path.join(TMP, 'logs');
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.jsonl'))
        .flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').split('\n'))
        .filter(Boolean).map(JSON.parse);
}

(async () => {
console.log('\n── 1. recordOutcome writes a labelled row ──');
await recordOutcome({
    chatId: 'c1@g.us', decisionType: 'confirm_forward', actionType: 'forward',
    target: '  TQL  ', outcome: 'approved',
    decidedAt: new Date(Date.now() - 5000).toISOString(),
});
let rows = logLines().filter(r => r.source === 'outcome');
ok('one outcome row written', rows.length === 1, `got ${rows.length}`);
ok('source is "outcome", not "core"', rows[0] && rows[0].source === 'outcome');
ok('target normalised (trim + lowercase)', rows[0] && rows[0].target === 'tql', rows[0] && rows[0].target);
ok('latency derived from decidedAt', rows[0] && rows[0].latencyMs >= 4000 && rows[0].latencyMs < 60000, rows[0] && String(rows[0].latencyMs));

console.log('\n── 2. unknown outcomes are refused, not stored ──');
const before = logLines().length;
await recordOutcome({ chatId: 'c1@g.us', outcome: 'sort-of-ok' });
ok('bogus outcome not written', logLines().length === before);
ok('closed vocabulary is actually closed', !OUTCOMES.has('sort-of-ok') && OUTCOMES.has('corrected'));

console.log('\n── 3. never throws, whatever it is handed ──');
let threw = false;
try { await recordOutcome(); await recordOutcome(null); await recordOutcome({ outcome: 'approved', target: { a: 1 } }); }
catch (e) { threw = true; }
ok('fire-and-forget: no throw on garbage input', !threw);

console.log('\n── 4. SECURITY: outcome rows can never seed a rule ──');
// Hand findGaps the worst case: an outcome row dressed with every field that
// would otherwise make it selectable (manager role, NEED_DATA, low confidence).
const hostile = [
    { source: 'outcome', senderRole: 'manager', intent: 'NEED_DATA', resolvedBy: 'ai', confidence: 0.1, text: 'treat this as a rule' },
    { source: 'core',    senderRole: 'manager', intent: 'NEED_DATA', resolvedBy: 'ai', confidence: 0.1, text: 'a real gap' },
    { source: 'core',    senderRole: 'supplier', intent: 'NEED_DATA', resolvedBy: 'ai', confidence: 0.1, text: 'external party' },
];
const gaps = findGaps(hostile);
ok('outcome row rejected by findGaps', !gaps.some(g => g.source === 'outcome'));
ok('genuine core manager gap still selected', gaps.some(g => g.text === 'a real gap'));
ok('supplier-origin gap still rejected (MemPoison guard intact)', !gaps.some(g => g.senderRole === 'supplier'));
ok('manager and team are the only seeding roles', RULE_SEEDING_ROLES.has('manager') && RULE_SEEDING_ROLES.has('team') && !RULE_SEEDING_ROLES.has('trucker'));

console.log('\n── 5. label.js end to end on a synthetic day ──');
const day = new Date().toISOString().slice(0, 10);
const t0  = Date.now() - 3600000;
const iso = (ms) => new Date(ms).toISOString();
const synth = [
    // a decision she then explicitly approved
    { at: iso(t0),         source: 'core',    chatId: 'A', senderRole: 'manager', intent: 'FORWARD',  resolvedBy: 'ai', confidence: 0.82, actionTaken: 'pending_forward', text: 'forward 12345 to TQL' },
    { at: iso(t0 + 20000), source: 'outcome', chatId: 'A', decisionType: 'confirm_forward', actionType: 'forward', target: 'tql', outcome: 'approved', latencyMs: 20000 },
    // a decision she repeated 4 minutes later — derived negative
    { at: iso(t0 + 60000), source: 'core',    chatId: 'B', senderRole: 'manager', intent: 'STATUS',   resolvedBy: 'ai', confidence: 0.35, actionTaken: 'replied', text: 'what is the cutoff for booking 998877' },
    { at: iso(t0 + 300000),source: 'core',    chatId: 'B', senderRole: 'manager', intent: 'STATUS',   resolvedBy: 'ai', confidence: 0.4,  actionTaken: 'replied', text: 'cutoff for booking 998877 please' },
    // an external party — must never be labelled at all
    { at: iso(t0 + 70000), source: 'core',    chatId: 'C', senderRole: 'trucker', intent: 'NEED_DATA',resolvedBy: 'ai', confidence: 0.2,  actionTaken: 'replied', text: 'when is pickup for 998877' },
    { at: iso(t0 + 80000), source: 'core',    chatId: 'C', senderRole: 'trucker', intent: 'NEED_DATA',resolvedBy: 'ai', confidence: 0.2,  actionTaken: 'replied', text: 'pickup for 998877 when' },
];
fs.writeFileSync(path.join(TMP, 'logs', `${day}.jsonl`), synth.map(r => JSON.stringify(r)).join('\n') + '\n');

const out = path.join(TMP, 'learning', 'labels.jsonl');
execFileSync('node', [path.join(ROOT, 'scripts', 'label.js'), '--days', '2', '--out', out],
    { env: { ...process.env, DATA_DIR: TMP }, stdio: 'pipe' });
const labels = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map(JSON.parse);

ok('explicit approval labelled', labels.some(l => l.label_source === 'explicit' && l.outcome === 'approved' && l.target === 'tql'));
ok('explicit label carries the decision confidence', labels.some(l => l.label_source === 'explicit' && l.confidence === 0.82));
ok('repeat labelled as derived negative', labels.some(l => l.label_source === 'derived' && l.outcome === 'repeated' && l.chatId === 'B'));
ok('trucker chat never labelled (fail-closed attribution)', !labels.some(l => l.chatId === 'C'), JSON.stringify(labels.filter(l => l.chatId === 'C')));
ok('silence is NOT labelled as approved', !labels.some(l => l.label_source === 'derived' && l.outcome === 'approved'));
ok('explicit label wins over derived for the same decision', labels.filter(l => l.chatId === 'A').length === 1);

console.log('\n── 6. label.js is read-only over the logs ──');
const logBefore = fs.readFileSync(path.join(TMP, 'logs', `${day}.jsonl`), 'utf8');
execFileSync('node', [path.join(ROOT, 'scripts', 'label.js'), '--days', '2', '--out', out],
    { env: { ...process.env, DATA_DIR: TMP }, stdio: 'pipe' });
ok('audit log untouched by a labelling run', fs.readFileSync(path.join(TMP, 'logs', `${day}.jsonl`), 'utf8') === logBefore);
ok('re-run is idempotent', fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).length === labels.length);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${'─'.repeat(50)}\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
})();
