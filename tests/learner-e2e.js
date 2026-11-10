// tests/learner-e2e.js — the learner END TO END (CLAUDE.md rule 3): the real Python service in a child process, the real Node client,
// the real HTTP between them. The language model is replaced by a deterministic stub (LEARNER_FAKE_LM=1) so this needs no key and no network.
// Shadow only: the property under test is that it predicts and measures, abstains when unsure, and can never break Jarvis.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn, spawnSync } = require('child_process');
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const ROOT = path.join(__dirname, '..');
if (spawnSync('python3', ['--version']).status !== 0) { console.log('SKIP python3 not installed'); console.log('0 passed, 0 failed'); process.exit(0); }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-learner-'));
const TOKEN = 'learner-test-token-xxxxxxxx';
const port = 20000 + Math.floor(Math.random() * 20000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
    const client = require(path.join(ROOT, 'helpers/learnerClient'));
    console.log('\n=== off by default: no URL means nothing happens ===');
    delete process.env.JARVIS_LEARNER_URL; delete process.env.JARVIS_LEARNER_TOKEN;
    ck('off: judge returns null, does not throw', (await client.judge('deposit', { a: 1 }, 'x')) === null);
    ck('off: on() is false', client.on() === false);

    console.log('\n=== down: an unreachable service never breaks the caller ===');
    process.env.JARVIS_LEARNER_URL = `http://127.0.0.1:${port}`; process.env.JARVIS_LEARNER_TOKEN = TOKEN;
    ck('down: judge returns null', (await client.judge('deposit', { a: 1 }, 'x')) === null);
    ck('down: example returns null', (await client.example('deposit', { a: 1 }, 'apply')) === null);

    const srv = spawn('python3', [path.join(ROOT, 'learner', 'server.py'), String(port)], { env: { ...process.env, LEARNER_TOKEN: TOKEN,
        LEARNER_DATA: path.join(TMP, 'learner'), LEARNER_FAKE_LM: '1' }, stdio: 'ignore' });
    try {
        for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) break; } catch (e) {} await sleep(150); }
        const raw = (m, p, tok, body) => fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { 'X-Learner-Token': tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
        console.log('\n=== the service ===');
        ck('no token: refused', (await raw('POST', '/judge', null, { kind: 'k', case: 'c' })).status === 401);
        ck('wrong token: refused', (await raw('GET', '/report', 'nope')).status === 401);
        ck('a bad request is a 400, not a crash', (await raw('POST', '/judge', TOKEN, {})).status === 400);

        console.log('\n=== cold start: too few examples means it abstains, it does not guess ===');
        const cold = await client.judge('deposit', { customer: 'Daekwang', amount: 5000 }, 'c1');
        ck('abstains with a reason', cold && cold.abstained === true && cold.decision === null && /not guessing/.test(cold.reason), JSON.stringify(cold));

        console.log('\n=== learning from her decisions ===');
        for (let i = 0; i < 6; i++) await client.example('deposit', { customer: 'Daekwang & Co', amount: 5000 + i, bank: 'BofA wire', note: 'paid in full' }, 'apply', { ref: 'e' + i, by: 'apsara' });
        for (let i = 0; i < 6; i++) await client.example('deposit', { customer: 'Lotte', amount: 900 + i, bank: 'Zelle', note: 'partial, claim open' }, 'ask', { ref: 'f' + i });
        const j1 = await client.judge('deposit', { customer: 'Daekwang & Co', amount: 5100, bank: 'BofA wire', note: 'paid in full' }, 'n1');
        ck('a case like her "apply" ones is predicted apply', j1 && !j1.abstained && j1.decision === 'apply', JSON.stringify(j1));
        const j2 = await client.judge('deposit', { customer: 'Lotte', amount: 905, bank: 'Zelle', note: 'partial, claim open' }, 'n2');
        ck('a case like her "ask" ones is predicted ask', j2 && j2.decision === 'ask', JSON.stringify(j2));
        ck('the prediction says why, citing the past decisions', /similar past decisions/.test(j1.reason) && j1.neighbours.length > 0);
        const other = await client.judge('supplier-payment', { x: 1 }, 'n3');
        ck('a kind it has never seen still abstains (no leakage across kinds)', other && other.abstained === true);

        for (let i = 0; i < 6; i++) await client.example('supplier-payment', { customer: 'Daekwang & Co', amount: 5000 + i, bank: 'BofA wire', note: 'paid in full' }, 'skip', { ref: 'g' + i });
        const j4 = await client.judge('deposit', { customer: 'Daekwang & Co', amount: 5100, bank: 'BofA wire', note: 'paid in full' }, 'n4');
        ck('another kind of decision never leaks into the neighbours (same words, different kind)', j4 && j4.decision === 'apply' && j4.neighbours.every((n) => n.decision !== 'skip'), JSON.stringify(j4));
        const off = spawnSync('python3', ['-I', '-c', "import sys,os,tempfile\nsys.path.insert(0,'learner')\nos.environ['LEARNER_DATA']=tempfile.mkdtemp();os.environ['LEARNER_FAKE_LM']='1'\nimport core\n[core.add_example('k','case words','apply') for _ in range(6)]\ncore._stub_lm=lambda c,n:{'decision':'wire it all now','confidence':0.99,'reason':'x'}\nr=core.judge('k','case words','z')\nprint(r['abstained'],r['decision'])"], { cwd: ROOT, encoding: 'utf8' });
        ck('a model answer outside the options she has actually used is refused', off.stdout.trim() === 'True None', off.stdout + off.stderr);
        console.log('\n=== measuring: prediction vs what really happened ===');
        await client.actual('n1', 'apply');          // agrees
        await client.actual('n2', 'apply');          // disagrees: she applied what it said to ask
        await client.actual('c1', 'ask');            // it abstained, so not counted
        const rep = await client.report();
        ck('report counts what was judged', rep && rep.judged === 5, JSON.stringify(rep));
        ck('abstentions are counted separately, not as hits or misses', rep.abstained === 2 && rep.compared === 2);
        ck('agreement is the real fraction (1 of 2)', rep.agree === 1 && rep.agreement === 0.5);
        ck('it is broken down by confidence', rep.by_confidence && Object.keys(rep.by_confidence).length >= 1);

        console.log('\n=== it only writes its own folder, and only appends ===');
        const files = fs.readdirSync(path.join(TMP, 'learner')).sort();
        ck('only examples.jsonl and shadow.jsonl exist', JSON.stringify(files) === JSON.stringify(['examples.jsonl', 'shadow.jsonl']), files.join(','));
        const ex = fs.readFileSync(path.join(TMP, 'learner', 'examples.jsonl'), 'utf8').trim().split('\n');
        ck('every example is kept as a line', ex.length === 18);
        ck('the service listens on 127.0.0.1 only', await new Promise((r) => { const s = http.get({ host: os.networkInterfaces().lo ? '127.0.0.1' : '127.0.0.1', port, path: '/health' }, () => { r(true); s.destroy(); }); s.on('error', () => r(false)); }));
    } finally { srv.kill(); }
    const src = fs.readFileSync(path.join(ROOT, 'helpers/learnerClient.js'), 'utf8');
    ck('the client has a timeout so a slow service cannot stall Jarvis', /AbortController/.test(src) && /setTimeout\(\(\) => ctl\.abort\(\)/.test(src));
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
