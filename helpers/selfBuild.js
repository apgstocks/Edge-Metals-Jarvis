// helpers/selfBuild.js — Jarvis changes its own code, and only her "yes" makes it real.
// Apsara, 2026-11-09: "Who understands everything and do whatever I ask without constantly
// rewriting its code. If I have to rewrite, it should do so." / "just like Iron Man Jarvis".
//
// THE SHAPE (nothing here deploys, pushes, or touches live data):
//   request  -> a private branch + worktree is cut from HEAD
//   build    -> a pluggable "coder" edits ONLY that worktree
//   guard    -> protected files, test edits, size, secrets: checked by code, not by the coder
//   verify   -> the whole test suite runs in the worktree; compared with the known-red baseline
//   ready    -> a plain-words summary written by THIS code (the coder's own words are labelled as such)
//   approve  -> only the manager; only the exact commit that was tested; merges locally, never ships
//   rollback -> a revert commit; history is never rewritten
//
// WHY THE SAFETY LIVES HERE AND NOT IN A PROMPT: a coder that is told "do not touch X" can still
// touch X. These checks read the real diff. The suite (hundreds of files) is the net that makes
// self-modification survivable at all.
//
// Roles: only 'manager' may request or approve. A supplier's message can never start a build.
// Never throws out of the public functions' contract: failures become a recorded state.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');

// What a coder may NEVER add, change or delete. Match is on repo-relative paths.
const PROTECTED = [
    /^\.git(\/|$)/, /^\.env/, /^data(\/|$)/, /^node_modules(\/|$)/, /^\.wwebjs/,
    /^ship\.sh$/, /^CLAUDE\.md$/, /^package(-lock)?\.json$/,
    /(^|\/)(gdrive-sa|gmail-[\w-]+)\.json$/, /credentials/i, /\.(pem|key|p12)$/i,
    /^helpers\/selfBuild\.js$/, /^scripts\/self-build\.js$/, /^tests\/self-build\.js$/,
];
const LIMITS = { files: 15, lines: 800 };
const SECRET_LINE = /(AIza[0-9A-Za-z_\-]{30,}|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"\s]{12,}['"])/i;

const STATES = ['requested', 'building', 'blocked', 'failed', 'ready', 'merged', 'rejected', 'rolled_back'];

function git(cwd, args, opts) {
    const r = spawnSync('git', args, Object.assign({ cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, opts || {}));
    return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), status: r.status };
}

// ── the record: append-only, one JSON line per event, newest state wins on read ───────────────
function logPath(cfg) { return path.join(cfg.dataDir, 'self_build.jsonl'); }
function append(cfg, ev) {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.appendFileSync(logPath(cfg), '\n' + JSON.stringify(Object.assign({ at: new Date().toISOString() }, ev)) + '\n');
}
function events(cfg) {
    const out = [];
    try {
        for (const l of fs.readFileSync(logPath(cfg), 'utf8').split('\n')) {
            if (!l.trim()) continue;
            try { const o = JSON.parse(l); if (o && o.id) out.push(o); } catch (e) { /* torn line */ }
        }
    } catch (e) { /* none yet */ }
    return out;
}
function get(cfg, id) {
    const mine = events(cfg).filter((e) => e.id === id);
    if (!mine.length) return null;
    return mine.reduce((acc, e) => Object.assign(acc, e), {});
}
function list(cfg) {
    const ids = [...new Set(events(cfg).map((e) => e.id))];
    return ids.map((id) => get(cfg, id));
}

// ── the guard: reads the REAL diff between base and the branch ────────────────────────────────
function inspectDiff(repo, base, head, opts) {
    const allowTestEdits = !!(opts && opts.allowTestEdits);
    const names = git(repo, ['diff', '--name-status', '--no-renames', `${base}..${head}`]);
    if (!names.ok) return { ok: false, problems: ['could not read the diff: ' + names.err], files: [] };
    const files = names.out ? names.out.split('\n').map((l) => { const [s, ...p] = l.split('\t'); return { status: s, file: p.join('\t') }; }) : [];
    const problems = [];
    for (const f of files) {
        if (PROTECTED.some((re) => re.test(f.file))) problems.push(`touches a protected file: ${f.file}`);
        else if (/^tests\//.test(f.file) && f.status !== 'A' && !allowTestEdits) problems.push(`changes or deletes an existing test (${f.status} ${f.file}); new tests are fine, weakening old ones is not`);
        if (!/^[\w@.\-\/ ]+$/.test(f.file) || f.file.includes('..')) problems.push(`odd file name: ${f.file}`);
    }
    if (files.length > LIMITS.files) problems.push(`too many files (${files.length} > ${LIMITS.files}); split the request`);
    const num = git(repo, ['diff', '--numstat', '--no-renames', `${base}..${head}`]);
    let added = 0, removed = 0;
    for (const l of num.out ? num.out.split('\n') : []) { const [a, r] = l.split('\t'); added += Number(a) || 0; removed += Number(r) || 0; }
    if (added + removed > LIMITS.lines) problems.push(`too large (${added + removed} lines > ${LIMITS.lines}); split the request`);
    const body = git(repo, ['diff', '--no-renames', '-U0', `${base}..${head}`]).out;
    for (const l of body.split('\n')) if (l.startsWith('+') && !l.startsWith('+++') && SECRET_LINE.test(l)) { problems.push('adds something that looks like a secret'); break; }
    // Submodule / symlink / mode tricks: a build may not add links or change executability.
    const modes = git(repo, ['diff', '--raw', '--no-renames', `${base}..${head}`]).out;
    for (const l of modes ? modes.split('\n') : []) { const m = l.match(/^:(\d+) (\d+) /); if (m && (m[2] === '120000' || m[2] === '160000' || (m[1] !== m[2] && m[1] !== '000000'))) problems.push('adds a link or changes file permissions'); }
    return { ok: problems.length === 0, problems, files, added, removed };
}

// ── verify: per-file test runner, same judging rules as the repo's own batch runner ───────────
function defaultRunTests(dir, { timeoutMs = 100000 } = {}) {
    const tdir = path.join(dir, 'tests');
    const files = fs.existsSync(tdir) ? fs.readdirSync(tdir).filter((f) => f.endsWith('.js') && !/^mutat/.test(f)).sort() : [];
    const failed = []; let passed = 0, asserts = 0;
    for (const f of files) {
        const r = spawnSync(process.execPath, [path.join(tdir, f)], { cwd: dir, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: Object.assign({}, process.env, { JARVIS_TEST: '1', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sb-')) }) });
        const out = (r.stdout || '') + (r.stderr || '');
        const m = [...out.matchAll(/(\d+) passed, (\d+) failed/g)].pop();
        const skipped = !m && r.status === 0 && /^\s*SKIPPED\b/m.test(out);
        const bad = (!m && !skipped) || (m && Number(m[2]) > 0) || (r.status !== 0 && !skipped) || (r.error && r.error.code === 'ETIMEDOUT');
        if (m) asserts += Number(m[1]);
        if (bad) failed.push(f); else passed++;
    }
    return { files: files.length, passedFiles: passed, asserts, failed };
}

function baselinePath(cfg) { return path.join(cfg.dataDir, 'self_build_baseline.json'); }
function loadBaseline(cfg) { try { const j = JSON.parse(fs.readFileSync(baselinePath(cfg), 'utf8')); return Array.isArray(j.failed) ? j.failed : null; } catch (e) { return null; } }
function recordBaseline(cfg, runTests) {
    const res = (runTests || defaultRunTests)(cfg.repo);
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.writeFileSync(baselinePath(cfg), JSON.stringify({ at: new Date().toISOString(), failed: res.failed, files: res.files }, null, 2));
    return res;
}

// ── the coder: pluggable. The default shells out to the Claude Code CLI inside the worktree ────
function constitution(cfg) {
    let rules = '';
    try { rules = fs.readFileSync(path.join(cfg.repo, 'CLAUDE.md'), 'utf8'); } catch (e) { /* none */ }
    return [
        'You are changing the Jarvis codebase on a private branch. A human approves before anything goes live.',
        'THINK FIRST. Before editing, write .self-build-plan.md: what you will change, every caller of any shared code you touch (grep for it), what could break on OTHER screens, and whether Edge Yard and Edge Metals are affected differently. If the request is ambiguous or wider than it sounds, say so in the plan and make the narrowest reading.',
        'Make the SMALLEST change that does what is asked. Add tests for it (new files under tests/ only; never edit existing tests).',
        'Never touch: .env*, data/, ship.sh, CLAUDE.md, package.json, package-lock.json, credentials, helpers/selfBuild.js, scripts/self-build.js.',
        'A request about one screen changes that screen only. List the callers of any shared function you change and check each.',
        'Do not deploy, push, or run anything against live data. When done, write 3-6 plain sentences about what you changed to .self-build-summary.md.',
        '', '--- repo working rules (CLAUDE.md) ---', rules,
    ].join('\n');
}
function claudeCoder({ worktree, request, constitution: rules, timeoutMs = 20 * 60 * 1000, bin = 'claude' }) {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, ['-p', `${rules}\n\n--- REQUEST FROM THE MANAGER ---\n${request}`, '--permission-mode', 'acceptEdits'], { cwd: worktree, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = ''; let done = false;
        const t = setTimeout(() => { if (!done) { done = true; child.kill('SIGKILL'); reject(new Error('the coder timed out')); } }, timeoutMs);
        child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
        child.on('error', (e) => { if (!done) { done = true; clearTimeout(t); reject(e); } });
        child.on('close', (code) => { if (done) return; done = true; clearTimeout(t); code === 0 ? resolve({ transcript: out.slice(-4000) }) : reject(new Error('the coder exited ' + code + ': ' + err.slice(-500))); });
    });
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'change';
const isManager = (by) => by === 'manager';

function plainSummary(rec, d, tests, baseline, coderNote, plan) {
    const lines = [];
    lines.push(`Build ${rec.id}: ${rec.request.replace(/\s+/g, ' ').slice(0, 140)}`);
    lines.push(`I changed ${d.files.length} file${d.files.length === 1 ? '' : 's'} (+${d.added} / -${d.removed} lines):`);
    for (const f of d.files.slice(0, 12)) lines.push(`  ${f.status === 'A' ? 'new' : f.status === 'D' ? 'deleted' : 'edited'}: ${f.file}`);
    const newTests = d.files.filter((f) => f.status === 'A' && /^tests\//.test(f.file)).length;
    lines.push(`New tests added: ${newTests}${newTests ? '' : ' (none — be careful)'}.`);
    const known = baseline ? tests.failed.filter((f) => baseline.includes(f)) : [];
    const fresh = baseline ? tests.failed.filter((f) => !baseline.includes(f)) : tests.failed;
    lines.push(`Checks: ${tests.asserts} passed across ${tests.files} files; new failures: ${fresh.length}${known.length ? `; ${known.length} already red before (not caused by this)` : ''}.`);
    if (!baseline) lines.push('Note: no baseline of known-red tests was recorded, so every failure counts.');
    if (plan) lines.push(`Its plan and impact check (its own words, not verified): ${String(plan).replace(/\s+/g, ' ').slice(0, 500)}`);
    else lines.push('Warning: it wrote no plan or impact check.');
    if (coderNote) lines.push(`The coder says (its own words, not verified): ${String(coderNote).replace(/\s+/g, ' ').slice(0, 400)}`);
    lines.push('Nothing is live. Reply "yes build ' + rec.id + '" to merge it here (you still run ship.sh), or "no build ' + rec.id + '".');
    return lines.join('\n');
}

// request() runs the whole build; resolves with the final record. `coder` and `runTests` are injectable.
async function request(cfg, { by, text, coder, runTests, allowTestEdits = false }) {
    if (!isManager(by)) return { ok: false, error: 'only the manager can ask Jarvis to change its code' };
    const reqText = String(text || '').trim();
    if (reqText.length < 8) return { ok: false, error: 'say what you want built' };
    const id = 'b' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
    const branch = `jarvis/${id}-${slug(reqText)}`;
    const dir = path.join(cfg.workRoot || path.join(os.tmpdir(), 'jarvis-builds'), id);
    append(cfg, { id, state: 'requested', request: reqText, by, branch, allowTestEdits });
    const base = git(cfg.repo, ['rev-parse', 'HEAD']);
    if (!base.ok) { append(cfg, { id, state: 'failed', reason: 'not a git repository' }); return get(cfg, id); }
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const wt = git(cfg.repo, ['worktree', 'add', '-q', '-b', branch, dir, 'HEAD']);
    if (!wt.ok) { append(cfg, { id, state: 'failed', reason: 'could not make a private copy: ' + wt.err.split('\n')[0] }); return get(cfg, id); }
    append(cfg, { id, state: 'building', base: base.out, dir });
    let coderNote = '', plan = '';
    try {
        const res = await (coder || claudeCoder)({ worktree: dir, request: reqText, constitution: constitution(cfg), id });
        coderNote = (res && res.summary) || '';
        try { coderNote = coderNote || fs.readFileSync(path.join(dir, '.self-build-summary.md'), 'utf8'); } catch (e) { /* none */ }
        try { plan = (res && res.plan) || fs.readFileSync(path.join(dir, '.self-build-plan.md'), 'utf8'); } catch (e) { /* none */ }
    } catch (e) {
        append(cfg, { id, state: 'failed', reason: 'the coder failed: ' + e.message });
        discard(cfg, id);
        return get(cfg, id);
    }
    for (const n of ['.self-build-summary.md', '.self-build-plan.md']) { try { fs.rmSync(path.join(dir, n), { force: true }); } catch (e) { /* ignore */ } }
    git(dir, ['add', '-A']);
    const status = git(dir, ['status', '--porcelain']).out;
    if (!status) { append(cfg, { id, state: 'failed', reason: 'the coder changed nothing' }); discard(cfg, id); return get(cfg, id); }
    git(dir, ['-c', 'user.name=Jarvis', '-c', 'user.email=jarvis@localhost', 'commit', '-q', '-m', `Jarvis build ${id}: ${reqText.slice(0, 60)}`]);
    const head = git(dir, ['rev-parse', 'HEAD']).out;
    const d = inspectDiff(cfg.repo, base.out, head, { allowTestEdits });
    if (!d.ok) { append(cfg, { id, state: 'blocked', reason: d.problems.join('; '), head }); discard(cfg, id, { keepBranch: true }); return get(cfg, id); }
    const tests = (runTests || defaultRunTests)(dir);
    const baseline = loadBaseline(cfg);
    const fresh = baseline ? tests.failed.filter((f) => !baseline.includes(f)) : tests.failed;
    if (fresh.length) {
        append(cfg, { id, state: 'failed', reason: `the checks failed: ${fresh.slice(0, 5).join(', ')}`, head, tests });
        discard(cfg, id, { keepBranch: true }); return get(cfg, id);
    }
    const rec = get(cfg, id);
    const summary = plainSummary(rec, d, tests, baseline, coderNote, plan);
    append(cfg, { id, state: 'ready', head, tests, summary, diff: { files: d.files, added: d.added, removed: d.removed } });
    discard(cfg, id, { keepBranch: true });   // the worktree dir is no longer needed; the branch stays
    return get(cfg, id);
}

function discard(cfg, id, { keepBranch = false } = {}) {
    const r = get(cfg, id); if (!r) return;
    try { if (r.dir) git(cfg.repo, ['worktree', 'remove', '--force', r.dir]); } catch (e) { /* ignore */ }
    try { if (r.dir) fs.rmSync(r.dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    git(cfg.repo, ['worktree', 'prune']);
    if (!keepBranch && r.branch) git(cfg.repo, ['branch', '-D', r.branch]);
}

// approve(): the exact commit that was tested, re-guarded, merged locally. Never deploys.
function approve(cfg, { by, id }) {
    if (!isManager(by)) return { ok: false, error: 'only the manager can approve a change to the code' };
    const r = get(cfg, id);
    if (!r) return { ok: false, error: 'no such build' };
    if (r.state !== 'ready') return { ok: false, error: `build ${id} is "${r.state}", not ready` };
    const head = git(cfg.repo, ['rev-parse', r.branch]);
    if (!head.ok || head.out !== r.head) return { ok: false, error: 'the branch is no longer the commit that was tested; nothing merged' };
    const d = inspectDiff(cfg.repo, r.base, r.head, { allowTestEdits: r.allowTestEdits });
    if (!d.ok) return { ok: false, error: 'the guard now refuses it: ' + d.problems.join('; ') };
    // Her working tree is often mid-edit. Refuse if any file this build touches is dirty there.
    const dirty = git(cfg.repo, ['status', '--porcelain']).out.split('\n').filter(Boolean).map((l) => l.slice(3));
    const clash = d.files.map((f) => f.file).filter((f) => dirty.includes(f));
    if (clash.length) return { ok: false, error: `these files have uncommitted changes here, so I will not merge over them: ${clash.join(', ')}` };
    const m = git(cfg.repo, ['-c', 'user.name=Jarvis', '-c', 'user.email=jarvis@localhost', 'merge', '--no-ff', '-q', '-m', `Merge Jarvis build ${id}: ${r.request.slice(0, 60)} (approved by manager)`, r.branch]);
    if (!m.ok) { git(cfg.repo, ['merge', '--abort']); return { ok: false, error: 'the merge did not apply cleanly; nothing changed: ' + (m.err || m.out).split('\n')[0] }; }
    const sha = git(cfg.repo, ['rev-parse', 'HEAD']).out;
    append(cfg, { id, state: 'merged', mergeSha: sha, approvedBy: by });
    return { ok: true, mergeSha: sha, note: 'merged here only. Nothing is deployed: run ship.sh, then pull and restart on the VM.' };
}

function reject(cfg, { by, id }) {
    if (!isManager(by)) return { ok: false, error: 'only the manager can reject a build' };
    const r = get(cfg, id);
    if (!r || r.state !== 'ready') return { ok: false, error: 'nothing ready to reject' };
    append(cfg, { id, state: 'rejected', rejectedBy: by });
    if (r.branch) git(cfg.repo, ['branch', '-D', r.branch]);
    return { ok: true };
}

// rollback(): a new revert commit for a merged build. Refuses if the revert would conflict.
function rollback(cfg, { by, id }) {
    if (!isManager(by)) return { ok: false, error: 'only the manager can roll a build back' };
    const r = get(cfg, id);
    if (!r || r.state !== 'merged') return { ok: false, error: 'that build is not merged' };
    const dirty = git(cfg.repo, ['status', '--porcelain', '--untracked-files=no']).out;
    if (dirty) return { ok: false, error: 'there are uncommitted changes here; commit or stash them first' };
    const v = git(cfg.repo, ['-c', 'user.name=Jarvis', '-c', 'user.email=jarvis@localhost', 'revert', '-m', '1', '--no-edit', r.mergeSha]);
    if (!v.ok) { git(cfg.repo, ['revert', '--abort']); return { ok: false, error: 'could not revert cleanly: ' + (v.err || v.out).split('\n')[0] }; }
    append(cfg, { id, state: 'rolled_back', revertSha: git(cfg.repo, ['rev-parse', 'HEAD']).out });
    return { ok: true };
}

module.exports = { request, approve, reject, rollback, get, list, recordBaseline, inspectDiff, defaultRunTests, claudeCoder, constitution, PROTECTED, LIMITS, STATES };
