// tests/self-build-whatsapp.js — "build: ..." over WhatsApp, end to end through the real brain.process().
// The repo is a temp git repo and the coder is a stub; everything else (policy rule, route, actions,
// worktree, guard, test run, merge) is real.
const fs = require('fs'), os = require('os'), path = require('path'), { spawnSync } = require('child_process');
const R = (p) => path.join(__dirname, '..', p);
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const sh = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });

// parser (pure)
const P = require(R('helpers/selfBuildCommands.js')).parse;
ck('grammar: build: <ask>', P('build: add a wave helper').kind === 'request' && P('Jarvis, build: add a wave helper').text === 'add a wave helper');
ck('grammar: approve / reject / rollback / list', P('yes build babc123').kind === 'approve' && P('no build babc123').kind === 'reject' && P('rollback build babc123').kind === 'rollback' && P('builds').kind === 'list');
ck('grammar: ordinary sentences are NOT builds', ['build the container list', 'we need to build a relationship with Zimex', 'yes', 'yes build', 'build:', 'how many builds', 'please build: x'].every((t) => P(t) === null), JSON.stringify(['build the container list', 'yes build', 'build:'].map(P)));

process.env.JARVIS_TEST = '1';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sbw-'));
process.env.DATA_DIR = path.join(TMP, 'data'); process.env.API_TOKEN = 't';
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
delete require.cache[R('config.js')];
const cfgApp = require(R('config.js'));
const MGR_NUM = '19998887777', MGR = MGR_NUM + '@c.us', TEAM_NUM = '19990001111', SUP_NUM = '19994443333';
fs.writeFileSync(cfgApp.SETTINGS_FILE, JSON.stringify({ manager_number: MGR_NUM, manager_name: 'Apsara', internal_team: [{ name: 'Tim', whatsapp: TEAM_NUM }], yard_staff: [], team_group_id: '', gemini_model: 'x', bot_mode: 'handholding', gmail_watch_enabled: false }));
for (const f of [cfgApp.BOOKINGS_FILE, cfgApp.WORKFLOW_FILE, cfgApp.TRANSCRIPTS_FILE]) fs.writeFileSync(f, '{}');
fs.writeFileSync(cfgApp.FACTS_FILE, '[]');

// a tiny repo to build in
const REPO = path.join(TMP, 'repo');
fs.mkdirSync(path.join(REPO, 'tests'), { recursive: true }); fs.mkdirSync(path.join(REPO, 'helpers'));
fs.writeFileSync(path.join(REPO, 'helpers/a.js'), 'module.exports = 1;\n');
fs.writeFileSync(path.join(REPO, 'tests/a.js'), "console.log('1 passed, 0 failed');\n");
sh(REPO, 'init', '-q', '-b', 'main'); sh(REPO, 'add', '-A'); sh(REPO, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
const bcfg = { repo: REPO, dataDir: path.join(TMP, 'jdata'), workRoot: path.join(TMP, 'work') };

const emb = require(R('helpers/embeddings.js')); emb.storeEmbedding = async () => {}; emb.searchSimilar = async () => []; emb.deleteEmbeddingsByText = async () => 0;
const gemini = require(R('helpers/gemini.js'));
let AI = { action: 'reply', reply: 'noted', confidence: 0.9 };
gemini.callGeminiJSON = async () => AI;
const jsonH = require(R('helpers/json.js')); jsonH.loadTruckers = async () => [];
jsonH.loadSuppliers = async () => [{ name: 'Inesh', whatsapp: SUP_NUM, number: SUP_NUM, phone: SUP_NUM, whatsapp_number: SUP_NUM }];
const brain = require(R('workflow/brain.js')), actions = require(R('workflow/actions.js'));
let sent = [];
const sendMessage = async (c, t) => { sent.push(String(t)); };
actions.init({ sendMessage, sendToManager: sendMessage, sendToTeam: sendMessage, pushAlert: () => {} });
const coder = async ({ worktree }) => { fs.writeFileSync(path.join(worktree, 'helpers/wave.js'), "module.exports = 'wave';\n"); fs.writeFileSync(path.join(worktree, 'tests/wave.js'), "console.log('1 passed, 0 failed');\n"); fs.writeFileSync(path.join(worktree, '.self-build-plan.md'), 'new file, no callers'); return { summary: 'added wave' }; };
let seq = 0;
async function say(text, { num = MGR_NUM, from = MGR } = {}) {
    sent = []; seq++; let threw = null;
    try { await brain.process({ messageId: 'sw-' + seq, chatId: from, senderNumber: num, senderName: 'x', text, hasMedia: false, isGroup: false }, sendMessage); } catch (e) { threw = e; }
    return { threw, all: sent.join('\n'), n: sent.length };
}
const builds = () => { try { return require(R('helpers/selfBuild.js')).list(bcfg); } catch (e) { return []; } };

(async () => {
    console.log('\n=== off by default ===');
    delete process.env.JARVIS_SELF_BUILD;
    actions._setSelfBuildDeps({ cfg: bcfg, coder, await: true });
    let r = await say('build: add a wave helper to the repo');
    ck('without JARVIS_SELF_BUILD=1 it says it is switched off and builds nothing', /switched off/.test(r.all) && builds().length === 0 && sh(REPO, 'branch', '--list', 'jarvis/*').stdout.trim() === '', r.all);

    console.log('\n=== who can start one ===');
    process.env.JARVIS_SELF_BUILD = '1';
    r = await say('build: add a wave helper to the repo', { num: SUP_NUM, from: SUP_NUM + '@c.us' });
    ck('a supplier saying "build: ..." starts nothing', builds().length === 0 && !/On it/.test(r.all), r.all);
    r = await say('build: add a wave helper to the repo', { num: TEAM_NUM, from: TEAM_NUM + '@c.us' });
    ck('team saying "build: ..." starts nothing either', builds().length === 0 && !/On it/.test(r.all), r.all);
    AI = { action: 'self_build', confidence: 0.99, reply: 'x' };
    r = await say('please make the invoice nicer somehow');
    ck('the AI classifier cannot choose a code change by itself', builds().length === 0 && !/On it/.test(r.all), r.all);
    AI = { action: 'reply', reply: 'noted', confidence: 0.9 };

    console.log('\n=== the manager, end to end ===');
    r = await say('build: add a wave helper to the repo');
    ck('she gets an immediate "on it" and later the summary', /On it/.test(r.all) && /Build b\w+: add a wave helper/.test(r.all) && /yes build b\w+/.test(r.all), r.all);
    const rec = builds()[0];
    ck('a ready build exists, nothing is merged yet', rec && rec.state === 'ready' && !fs.existsSync(path.join(REPO, 'helpers/wave.js')));
    r = await say('builds');
    ck('"builds" lists it', new RegExp(rec.id + '\\s+ready').test(r.all), r.all);
    r = await say('yes build ' + rec.id, { num: TEAM_NUM, from: TEAM_NUM + '@c.us' });
    ck('team saying "yes build <id>" does not merge it', !fs.existsSync(path.join(REPO, 'helpers/wave.js')) && builds()[0].state === 'ready');
    r = await say('yes build ' + rec.id);
    ck('her "yes build <id>" merges it, says it is not deployed', fs.existsSync(path.join(REPO, 'helpers/wave.js')) && /Merged build/.test(r.all) && /Nothing is deployed/.test(r.all), r.all);
    r = await say('rollback build ' + rec.id);
    ck('"rollback build <id>" undoes it', !fs.existsSync(path.join(REPO, 'helpers/wave.js')) && /Rolled build/.test(r.all), r.all);
    r = await say('build: add another helper for later');
    const rec2 = builds().find((b) => b.id !== rec.id);
    r = await say('no build ' + rec2.id);
    ck('"no build <id>" drops it', /Dropped build/.test(r.all) && builds().find((b) => b.id === rec2.id).state === 'rejected', r.all);
    r = await say('yes build bzzzzzzzz');
    ck('an unknown id is a plain "not done"', /Not done/.test(r.all) && !r.threw, r.all);

    console.log('\n=== one at a time; bad input to the action itself ===');
    let release; const gate = new Promise((res) => { release = res; });
    actions._setSelfBuildDeps({ cfg: bcfg, coder: async (a) => { await gate; return coder(a); }, await: false });
    const first = await say('build: a slow helper that waits for a moment');
    const second = await say('build: another helper while the first one runs');
    ck('a second build while one runs is told to wait, and starts nothing', /One build at a time/.test(second.all) && !/On it/.test(second.all) && builds().filter((b) => b.state === 'building' || b.state === 'requested').length === 1, second.all);
    release(); await new Promise((res) => setTimeout(res, 3000));
    actions._setSelfBuildDeps({ cfg: bcfg, coder, await: true });
    sent = [];
    const bad = await actions.selfBuildCommand(MGR, { kind: 'wipe', text: 'build: something' });
    const none = await actions.selfBuildCommand(MGR, undefined);
    ck('the action ignores an unknown kind or no data, and sends nothing', bad.action_taken === 'ignored' && none.action_taken === 'ignored' && sent.length === 0);

    console.log('\n=== a failing build is reported, nothing changes ===');
    const before = sh(REPO, 'rev-parse', 'HEAD').stdout;
    actions._setSelfBuildDeps({ cfg: bcfg, coder: async ({ worktree }) => { fs.writeFileSync(path.join(worktree, 'ship.sh'), 'x'); }, await: true });
    r = await say('build: change the ship script please');
    ck('a blocked build tells her why and offers nothing to approve', /did not make it/.test(r.all) && /protected file/.test(r.all) && !/yes build/.test(r.all), r.all);
    ck('main is unchanged', sh(REPO, 'rev-parse', 'HEAD').stdout === before);
    actions._setSelfBuildDeps({ cfg: bcfg, coder: async () => { throw new Error('model unavailable'); }, await: true });
    r = await say('build: this will explode on purpose');
    ck('a coder that throws is reported, the server carries on', /did not make it/.test(r.all) && !r.threw, r.all);
    r = await say('hello what is the weather');
    ck('normal messages still go to the normal path afterwards', r.n >= 1 && !/build/i.test(r.all), r.all);

    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
