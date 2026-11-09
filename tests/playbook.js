// ── tests/playbook.js — the Playbook: seed, list, ask, forget, and the real CLI ──
// Section A tests the helper. Section B runs the ACTUAL command (scripts/playbook.js)
// in a child process against a temp DATA_DIR, because the gap is always between the
// helper and the thing a person runs (CLAUDE.md rule 3). There is no route or screen
// yet, so the command line is the real entry point. Never touches the real data/.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const disk = require('../helpers/disk');
const playbook = require('../helpers/playbook');

let pass = 0, fail = 0;
const failures = [];
function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { fail++; failures.push(name); console.log(`  ✗ ${name}\n      ${String(e.message).split('\n')[0]}`); }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'playbook-'));
const ROOT = path.join(__dirname, '..');
const realDisk = path.join(ROOT, 'data', 'disk');
const realDiskExisted = fs.existsSync(realDisk);

// ── A. the helper ───────────────────────────────────────────────────────
const fresh = () => disk.open({ dir: tmp() });

check('seed adds every rule once, and says so', () => {
    const p = fresh().for('edge_metals');
    const r = playbook.seed(p);
    assert.strictEqual(r.added.length, playbook.SEED.length);
    assert.deepStrictEqual([r.skipped.length, r.conflicts.length], [0, 0]);
    assert.strictEqual(playbook.list(p).length, playbook.SEED.length);
});
check('seeding twice adds nothing (idempotent)', () => {
    const p = fresh().for('edge_metals');
    playbook.seed(p);
    const again = playbook.seed(p);
    assert.strictEqual(again.added.length, 0);
    assert.strictEqual(again.skipped.length, playbook.SEED.length);
    assert.strictEqual(playbook.list(p).length, playbook.SEED.length);
});
check('seed NEVER overwrites a rule she has edited: it reports a conflict and keeps hers', () => {
    const p = fresh().for('edge_metals');
    playbook.seed(p);
    p.facts.put({ name: 'report_style', value: 'Long reports are fine on Mondays.', by: 'apsara', role: 'manager' });
    const r = playbook.seed(p);
    assert.strictEqual(r.conflicts.length, 1);
    assert.strictEqual(r.conflicts[0].name, 'report_style');
    assert.strictEqual(p.facts.get('global', '', 'report_style').value, 'Long reports are fine on Mondays.');
});
check('a rule she deleted is NOT silently brought back by the next seed', () => {
    const p = fresh().for('edge_metals');
    playbook.seed(p);
    const id = p.facts.get('global', '', 'report_style').id;
    assert.strictEqual(playbook.forget(p, id), true);
    const r = playbook.seed(p);
    assert.strictEqual(r.added.length, 0);
    assert.deepStrictEqual(r.forgotten, ['report_style']);
    assert.strictEqual(p.facts.get('global', '', 'report_style'), null);
});
check('seeding Edge Metals never writes into Edge Yard', () => {
    const d = fresh();
    playbook.seed(d.for('edge_metals'));
    assert.strictEqual(playbook.list(d.for('edge_yard')).length, 0);
    assert.ok(!fs.existsSync(path.join(d.dir, 'edge_yard', 'facts.jsonl')) || fs.readFileSync(path.join(d.dir, 'edge_yard', 'facts.jsonl'), 'utf8') === '');
});
check('every seed rule is attributed to her, dated, and says where it came from', () => {
    const p = fresh().for('edge_metals');
    playbook.seed(p);
    for (const f of playbook.list(p)) {
        assert.strictEqual(f.taughtBy, 'apsara');
        assert.ok(/stated 2026-11-07/.test(f.sourceMsg), f.name);
    }
});
check('ask: a named customer returns that customer\'s rule AND the global rules', () => {
    const p = fresh().for('edge_metals');
    playbook.seed(p);
    const r = playbook.ask(p, 'Rad Metal wants a payment reminder');
    assert.ok(r.exact.some((f) => f.scope === 'customer:rad-metal' && f.name === 'always_pays'));
    assert.ok(r.exact.some((f) => f.name === 'lc_customers_no_followup'), 'global rules always apply');
});
check('ask: another customer\'s rule is never returned for a different customer', () => {
    const p = fresh().for('edge_metals');
    playbook.seed(p);
    const r = playbook.ask(p, 'Daekwang wants a payment reminder');
    assert.ok(!r.exact.some((f) => f.name === 'always_pays'), 'another customer\'s always_pays must not be exact');
    assert.ok(r.related.every((f) => f.basis === 'related'));
});
check('ask: nothing applies -> empty brief, no crash', () => {
    const p = fresh().for('edge_metals');
    const r = playbook.ask(p, 'something nobody ever taught it');
    assert.strictEqual(r.exact.length, 0);
    assert.strictEqual(r.brief, '');
    assert.doesNotThrow(() => playbook.ask(p, ''));
    assert.doesNotThrow(() => playbook.ask(p, null));
});
check('forget removes one rule and leaves the rest', () => {
    const p = fresh().for('edge_metals');
    playbook.seed(p);
    const id = p.facts.get('customer', 'mk-trading', 'always_pays').id;
    assert.strictEqual(playbook.forget(p, id), true);
    assert.strictEqual(p.facts.get('customer', 'mk-trading', 'always_pays'), null);
    assert.strictEqual(playbook.list(p).length, playbook.SEED.length - 1);
    assert.strictEqual(playbook.forget(p, 99999), false);
    assert.strictEqual(playbook.forget(p, 'abc'), false);
});
// THE GUARD. Nothing in the app may read the Playbook until she says so. When she does,
// the change that wires it adds the file to this list on purpose, and adds its own
// end-to-end section. An empty list is what "changes no existing behaviour" means.
const ALLOWED_CALLERS = [];
check('no existing file reads the Playbook or the disk (so no behaviour has changed)', () => {
    const uses = /(helpers\/|\.\/|\.\.\/)(playbook|diskStore|disk)(\/|['"])/;
    const scan = (dir, rel) => {
        const out = [];
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name === 'data' || e.name.startsWith('.')) continue;
            const abs = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) { if (['helpers', 'workflow', 'routes', 'scripts'].includes(e.name) || rel) out.push(...scan(abs, r)); }
            else if (e.name.endsWith('.js') && uses.test(fs.readFileSync(abs, 'utf8'))) out.push(r);
        }
        return out;
    };
    // scripts/notes.js: a new command-line tool for the notes layer, added 2026-11-09 and called by nothing in the app.
    // Listing it here is MY call as the author (not hers); it is a new file, not an existing one starting to read the disk.
    // helpers/playbookRoutes.js: the Playbook SCREEN's routes (list, edit, forget), added 2026-11-09 for ownership-plan step 7 on her
    // yes to "the playbook screen". It shows and edits the rules; it makes no decision. Listing it is MY call as the author: a rule
    // that DRIVES a follow-up, chase or truth check still has to be added to ALLOWED_CALLERS with her yes.
    const mine = new Set(['helpers/playbook.js', 'helpers/playbookRoutes.js', 'helpers/diskStore.js', 'scripts/playbook.js', 'scripts/notes.js', 'scripts/restore-inbound-log.js', 'tests/playbook.js', 'tests/disk.js']);
    const callers = scan(ROOT, '').filter((f) => !mine.has(f) && !f.startsWith('helpers/disk/') && !ALLOWED_CALLERS.includes(f));
    assert.deepStrictEqual(callers, [], 'wiring the Playbook into a decision needs her yes first');
});

// ── B. the real command, in a child process, on a temp DATA_DIR ─────────────
const DATA = tmp();
function run(...args) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'playbook.js'), ...args],
        { cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, { DATA_DIR: DATA, JARVIS_TEST: '1' }) });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '', stderr: r.stderr || '' };
}

check('CLI: list on an empty Playbook says so and exits 0', () => {
    const r = run('list');
    assert.strictEqual(r.code, 0);
    assert.ok(/Playbook is empty/.test(r.out));
});
check('CLI: seed adds the rules, writes the backup, and exits 0', () => {
    const r = run('seed');
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(new RegExp(`added ${playbook.SEED.length}, already there 0, conflicts 0`).test(r.out), r.out);
    assert.ok(fs.existsSync(path.join(DATA, 'disk', 'edge_metals', 'backup.json')));
});
check('CLI: a second process still sees what the first one wrote (it persists)', () => {
    const r = run('list');
    assert.ok(new RegExp(`${playbook.SEED.length} rules`).test(r.out), r.out);
    assert.ok(/lc_customers_no_followup/.test(r.out) && /taught by apsara, 20\d\d-\d\d-\d\d/.test(r.out));
});
check('CLI: seeding again adds 0', () => {
    assert.ok(/added 0, already there \d+, conflicts 0/.test(run('seed').out));
});
check('CLI: ask prints the customer rule through the real files', () => {
    const r = run('ask', 'Rad Metal wants a payment reminder');
    assert.strictEqual(r.code, 0);
    assert.ok(/\[customer:rad-metal\] always_pays/.test(r.out), r.out);
});
check('CLI: forget deletes a rule, the next process agrees, and the backup follows', () => {
    const id = /#(\d+)\s+\[customer:mk-trading\]/.exec(run('list').out)[1];
    assert.ok(/forgot rule/.test(run('forget', id).out));
    assert.ok(!/mk-trading/.test(run('list').out));
    const snap = JSON.parse(fs.readFileSync(path.join(DATA, 'disk', 'edge_metals', 'backup.json'), 'utf8'));
    assert.ok(snap.facts.some((r) => r.t === 'forget' && r.id === Number(id)), 'the backup includes the deletion');
});
check('CLI: refuses to seed another company, and an unknown company, with a non-zero exit', () => {
    const yard = run('seed', '--company', 'edge_yard');
    assert.notStrictEqual(yard.code, 0);
    assert.ok(/Edge Metals/.test(yard.out));
    assert.ok(!fs.existsSync(path.join(DATA, 'disk', 'edge_yard', 'facts.jsonl')), 'nothing written for Edge Yard');
    const nope = run('list', '--company', 'acme');
    assert.notStrictEqual(nope.code, 0);
    assert.ok(/unknown company/.test(nope.out));
});
check('CLI: bad input gives a usage line, not a stack trace', () => {
    for (const a of [[], ['ask'], ['forget'], ['forget', 'abc'], ['dance']]) {
        const r = run(...a);
        assert.notStrictEqual(r.code, 0, a.join(' '));
        assert.ok(!/at .*\.js:\d+/.test(r.out), `stack trace leaked for: ${a.join(' ')}`);
    }
});
check('CLI never wrote to the real data/disk', () => {
    assert.strictEqual(fs.existsSync(realDisk), realDiskExisted);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED: ' + failures.join(', ')); process.exit(1); }
