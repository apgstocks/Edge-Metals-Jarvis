// tests/self-build.js — Jarvis changes its own code; only her yes makes it real.
// Real git repo in a temp dir, real worktrees, real test running, real merge. The coder is a stub
// (the default coder shells out to the Claude CLI, which cannot run here).
const fs = require('fs'), os = require('os'), path = require('path'), { spawnSync } = require('child_process');
const sb = require(path.join(__dirname, '..', 'helpers', 'selfBuild.js'));
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const sh = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sbt-'));
const REPO = path.join(TMP, 'repo');
fs.mkdirSync(path.join(REPO, 'tests'), { recursive: true }); fs.mkdirSync(path.join(REPO, 'helpers'), { recursive: true }); fs.mkdirSync(path.join(REPO, 'data'));
fs.writeFileSync(path.join(REPO, 'helpers/greet.js'), "module.exports = () => 'hello';\n");
fs.writeFileSync(path.join(REPO, 'tests/greet.js'), "const g=require('../helpers/greet.js');const ok=g()==='hello';console.log(ok?'1 passed, 0 failed':'0 passed, 1 failed');process.exit(ok?0:1);\n");
fs.writeFileSync(path.join(REPO, 'ship.sh'), 'echo ship\n'); fs.writeFileSync(path.join(REPO, 'package.json'), '{"name":"x"}\n'); fs.writeFileSync(path.join(REPO, 'CLAUDE.md'), 'rules\n');
fs.writeFileSync(path.join(REPO, 'data/live.json'), '{"payments":1}\n');
sh(REPO, 'init', '-q', '-b', 'main'); sh(REPO, 'add', '-A'); sh(REPO, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
const cfg = { repo: REPO, dataDir: path.join(TMP, 'jdata'), workRoot: path.join(TMP, 'work') };
const headOf = () => sh(REPO, 'rev-parse', 'HEAD').stdout.trim();
const treeClean = () => sh(REPO, 'status', '--porcelain').stdout.trim() === '';
const write = (d, f, c) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); };
const NEWTEST = (name) => `console.log('2 passed, 0 failed');\n// ${name}\n`;
const good = async ({ worktree }) => { write(worktree, 'helpers/wave.js', "module.exports = () => 'wave';\n"); write(worktree, 'tests/wave.js', NEWTEST('wave')); write(worktree, '.self-build-plan.md', 'Adds helpers/wave.js. No callers: it is new. Edge Metals and Edge Yard unaffected.'); return { summary: 'Added wave().' }; };

(async () => {
    const BASE = headOf();
    console.log('\n=== who may ask ===');
    let r = await sb.request(cfg, { by: 'supplier', text: 'add a wave helper please', coder: good });
    ck('a supplier cannot start a build', r.ok === false && /only the manager/.test(r.error));
    r = await sb.request(cfg, { by: 'team', text: 'add a wave helper please', coder: good });
    ck('team cannot either', r.ok === false);
    r = await sb.request(cfg, { by: 'manager', text: 'hi', coder: good });
    ck('an empty ask is refused', r.ok === false);
    ck('refusals leave no branch and no record', sh(REPO, 'branch', '--list', 'jarvis/*').stdout.trim() === '' && sb.list(cfg).length === 0);

    console.log('\n=== a good build ===');
    const g = await sb.request(cfg, { by: 'manager', text: 'add a wave helper please', coder: good });
    ck('it ends "ready"', g.state === 'ready', JSON.stringify(g));
    ck('her working copy was never touched while it built', headOf() === BASE && treeClean());
    ck('the change is NOT in main yet', !fs.existsSync(path.join(REPO, 'helpers/wave.js')));
    ck('the summary is written by the code, lists files, tests and what is not live', /helpers\/wave\.js/.test(g.summary) && /New tests added: 1/.test(g.summary) && /Nothing is live/.test(g.summary) && /yes build /.test(g.summary), g.summary);
    ck('the coder\'s words are labelled as unverified', /its own words, not verified/.test(g.summary) && /plan and impact check/.test(g.summary));
    ck('the private worktree is cleaned up, the branch kept', !fs.existsSync(g.dir) && sh(REPO, 'branch', '--list', g.branch).stdout.includes('jarvis/'));
    ck('no scratch files from the coder end up in the commit', !sh(REPO, 'ls-tree', '-r', '--name-only', g.branch).stdout.includes('.self-build'));

    console.log('\n=== approval ===');
    ck('team cannot approve', sb.approve(cfg, { by: 'team', id: g.id }).ok === false);
    ck('an unknown build is refused', sb.approve(cfg, { by: 'manager', id: 'nope' }).ok === false);
    // her tree is dirty on a file the build touches -> refuse to merge over it
    write(REPO, 'helpers/wave.js', 'my own uncommitted work\n');
    const clash = sb.approve(cfg, { by: 'manager', id: g.id });
    ck('it will not merge over her uncommitted work on the same file', clash.ok === false && /uncommitted/.test(clash.error), JSON.stringify(clash));
    fs.rmSync(path.join(REPO, 'helpers/wave.js'));
    // the branch moves after testing -> refuse (what she approved is what was tested)
    const wt2 = path.join(TMP, 'tamper');
    sh(REPO, 'worktree', 'add', '-q', wt2, g.branch);
    write(wt2, 'helpers/sneaky.js', 'x\n'); sh(wt2, 'add', '-A'); sh(wt2, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'sneak');
    const moved = sb.approve(cfg, { by: 'manager', id: g.id });
    ck('if the branch changed after testing, it refuses', moved.ok === false && /no longer the commit that was tested/.test(moved.error), JSON.stringify(moved));
    sh(REPO, 'worktree', 'remove', '--force', wt2);
    sh(REPO, 'branch', '-f', g.branch, g.head);           // put it back to the tested commit
    const ok = sb.approve(cfg, { by: 'manager', id: g.id });
    ck('approved by the manager: merged', ok.ok === true && fs.existsSync(path.join(REPO, 'helpers/wave.js')), JSON.stringify(ok));
    ck('and the merge says it is not deployed', /Nothing is deployed/.test(ok.note));
    ck('approving twice is refused', sb.approve(cfg, { by: 'manager', id: g.id }).ok === false);
    ck('live data was not touched', fs.readFileSync(path.join(REPO, 'data/live.json'), 'utf8') === '{"payments":1}\n');

    console.log('\n=== rollback ===');
    ck('team cannot roll back', sb.rollback(cfg, { by: 'team', id: g.id }).ok === false);
    const rb = sb.rollback(cfg, { by: 'manager', id: g.id });
    ck('manager rolls it back with a revert commit', rb.ok === true && !fs.existsSync(path.join(REPO, 'helpers/wave.js')), JSON.stringify(rb));
    ck('history is kept (revert is a new commit)', sh(REPO, 'log', '--oneline').stdout.split('\n').length >= 4);
    ck('state says rolled back', sb.get(cfg, g.id).state === 'rolled_back');

    console.log('\n=== the guard blocks what a prompt could not stop ===');
    const blocked = async (name, coder, re, opts) => {
        const x = await sb.request(cfg, Object.assign({ by: 'manager', text: 'do a thing: ' + name, coder }, opts || {}));
        ck(`${name}: blocked`, x.state === 'blocked' && re.test(x.reason || ''), JSON.stringify([x.state, x.reason]));
        ck(`  ...and never offered for approval`, sb.approve(cfg, { by: 'manager', id: x.id }).ok === false);
        return x;
    };
    await blocked('edits ship.sh', async ({ worktree }) => { write(worktree, 'ship.sh', 'rm -rf /\n'); }, /protected file: ship\.sh/);
    await blocked('edits live data', async ({ worktree }) => { write(worktree, 'data/live.json', '{}'); }, /protected file: data\/live\.json/);
    await blocked('edits package.json', async ({ worktree }) => { write(worktree, 'package.json', '{"dependencies":{"evil":"1"}}'); }, /package\.json/);
    await blocked('edits CLAUDE.md', async ({ worktree }) => { write(worktree, 'CLAUDE.md', 'no rules'); }, /CLAUDE\.md/);
    await blocked('rewrites an existing test', async ({ worktree }) => { write(worktree, 'tests/greet.js', "console.log('1 passed, 0 failed')"); }, /changes or deletes an existing test/);
    await blocked('deletes a test', async ({ worktree }) => { fs.rmSync(path.join(worktree, 'tests/greet.js')); }, /existing test/);
    await blocked('touches the self-build guard itself', async ({ worktree }) => { write(worktree, 'helpers/selfBuild.js', '// weaker'); }, /selfBuild\.js/);
    await blocked('adds a secret', async ({ worktree }) => { write(worktree, 'helpers/k.js', "const apiKey = 'AIzaSyA1234567890abcdefghijklmnopqrstuvw';\n"); }, /secret/);
    await blocked('adds a symlink', async ({ worktree }) => { fs.symlinkSync('/etc/passwd', path.join(worktree, 'helpers/link.js')); }, /link or changes file permissions/);
    await blocked('is too big', async ({ worktree }) => { for (let i = 0; i < 16; i++) write(worktree, `helpers/f${i}.js`, 'x\n'); }, /too many files/);
    await blocked('is too long', async ({ worktree }) => { write(worktree, 'helpers/long.js', 'x\n'.repeat(900)); }, /too large/);
    const edited = await sb.request(cfg, { by: 'manager', text: 'update the greeting test', allowTestEdits: true, coder: async ({ worktree }) => { write(worktree, 'tests/greet.js', "console.log('1 passed, 0 failed')"); write(worktree, '.self-build-plan.md', 'p'); } });
    ck('test edits are possible only when explicitly allowed for that build', edited.state === 'ready', JSON.stringify([edited.state, edited.reason]));

    console.log('\n=== the checks decide ===');
    const breaks = await sb.request(cfg, { by: 'manager', text: 'change the greeting word', coder: async ({ worktree }) => { write(worktree, 'helpers/greet.js', "module.exports = () => 'hola';\n"); } });
    ck('a change that turns a test red is "failed", never offered', breaks.state === 'failed' && /greet\.js/.test(breaks.reason), JSON.stringify([breaks.state, breaks.reason]));
    ck('  ...and main is untouched', headOf() && !fs.readFileSync(path.join(REPO, 'helpers/greet.js'), 'utf8').includes('hola'));
    sb.recordBaseline(cfg, () => ({ files: 1, failed: ['greet.js'] }));
    const known = await sb.request(cfg, { by: 'manager', text: 'change the greeting word again', coder: async ({ worktree }) => { write(worktree, 'helpers/greet.js', "module.exports = () => 'hola';\n"); write(worktree, 'tests/hola.js', NEWTEST('h')); } });
    ck('a test already red in the baseline is not blamed on the build', known.state === 'ready' && /already red/.test(known.summary), JSON.stringify([known.state, known.reason]));
    fs.rmSync(path.join(cfg.dataDir, 'self_build_baseline.json'));

    console.log('\n=== the coder misbehaving ===');
    const threw = await sb.request(cfg, { by: 'manager', text: 'something that explodes', coder: async () => { throw new Error('model unavailable'); } });
    ck('a coder that throws is recorded as failed, no branch left behind', threw.state === 'failed' && /model unavailable/.test(threw.reason) && !sh(REPO, 'branch', '--list', threw.branch).stdout.trim());
    const nothing = await sb.request(cfg, { by: 'manager', text: 'do nothing at all please', coder: async () => ({}) });
    ck('a coder that changes nothing is a failed build, not a "ready" one', nothing.state === 'failed' && /changed nothing/.test(nothing.reason));
    const noplan = await sb.request(cfg, { by: 'manager', text: 'add a thing without any plan', coder: async ({ worktree }) => { write(worktree, 'helpers/np.js', 'x\n'); write(worktree, 'tests/np.js', NEWTEST('np')); } });
    ck('no plan is called out in the summary', noplan.state === 'ready' && /wrote no plan/.test(noplan.summary));

    console.log('\n=== it can be rejected, and the record only grows ===');
    ck('manager rejects a ready build', sb.reject(cfg, { by: 'manager', id: noplan.id }).ok === true && sb.get(cfg, noplan.id).state === 'rejected');
    ck('a rejected build cannot be approved afterwards', sb.approve(cfg, { by: 'manager', id: noplan.id }).ok === false);
    const raw = fs.readFileSync(path.join(cfg.dataDir, 'self_build.jsonl'), 'utf8');
    ck('every build left a history of states', (raw.match(/"state":"requested"/g) || []).length >= 10 && /"state":"merged"/.test(raw) && /"state":"rolled_back"/.test(raw));
    ck('her working tree is still clean and on the same branch', treeClean() && sh(REPO, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim() === 'main');

    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
