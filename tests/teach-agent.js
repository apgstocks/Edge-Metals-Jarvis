// ── tests/teach-agent.js — "rules on the go" (agents/teach + scripts/notes.js) ──
// Temp directories only; the stub embedder (shared words, not meaning); no network, no model.
// End to end = public runner API -> real LangGraph graph -> real disk journal -> a SECOND runner built from scratch on
// the same directory (a restart) -> real notes file. Section CLI does the same across separate OS PROCESSES.
// NOT through an HTTP route: nothing wires this to one yet, so when it is wired that change adds the server section
// (CLAUDE.md rule 3; tests/paid-via.js section F is the shape).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const disk = require('../helpers/disk');
const { PartitionError } = disk;
const embedders = require('../helpers/disk/embedder');
const { createRunner } = require('../agents/teach');
const payment = require('../agents/paymentCase');

let pass = 0, fail = 0;
const failures = [];
async function check(name, fn) {
    try { await fn(); pass++; }
    catch (e) { fail++; failures.push(name); console.log(`  ✗ ${name}\n      ${String(e.message).split('\n')[0]}`); }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-teach-'));
const M = { by: 'apsara', role: 'manager' };
const A = 'Rad Metal always pays on the 15th of the month';
const A2 = 'rad metal pays on the 15th every month';          // same idea, other words
const OTHER = 'Zimex wants every invoice in Canadian dollars';
function mk(dir, o = {}) {
    const sent = [], embedded = [];
    const base = o.embedder || embedders.stub();
    const embedder = { model: base.model, embed: async (t) => { embedded.push(t); return base.embed(t); } };
    const d = disk.open({ dir });
    const runner = createRunner({ disk: d, company: 'company' in o ? o.company : 'edge_metals', embedder,
        askAbove: o.askAbove, notify: o.notify || (async (m) => { sent.push(m); }) });
    return { runner, sent, embedded, dir, disk: d, notes: (c = 'edge_metals') => d.for(c).notes };
}

(async () => {
    // ── saving ────────────────────────────────────────────────────────────
    await check('nothing similar: saved straight away, verbatim, embedded, and she is not asked anything', async () => {
        const { runner, sent, notes } = mk(tmp());
        const r = await runner.start({ text: `  ${A}  `, ...M });
        assert.strictEqual(r.status, 'saved');
        assert.strictEqual(sent.length, 0);
        const n = notes().list();
        assert.deepStrictEqual(n.map((x) => [x.text, x.embedded]), [[A, true]]);
    });
    await check('a different rule about the same customer is NOT mistaken for a duplicate', async () => {
        const { runner, sent } = mk(tmp());
        await runner.start({ text: A, ...M });
        const r = await runner.start({ text: 'Rad Metal wants invoices in CAD', ...M });
        assert.strictEqual(r.status, 'saved', 'two shared words ("rad metal") are the same customer, not the same rule');
        assert.strictEqual(sent.length, 0);
    });

    // ── asking ────────────────────────────────────────────────────────────
    await check('similar: asks once, names the old note, saves NOTHING until she answers', async () => {
        const { runner, sent, notes } = mk(tmp());
        await runner.start({ text: A, ...M });
        const r = await runner.start({ text: A2, ...M });
        assert.strictEqual(r.status, 'waiting');
        assert.deepStrictEqual(r.candidates.map((c) => c.id), [1]);
        assert.strictEqual(sent.length, 1);
        assert.strictEqual(sent[0].audience, 'owner');
        assert.ok(sent[0].text.includes(A) && /replace <number>/.test(sent[0].text) && sent[0].text.includes('#1'));
        assert.deepStrictEqual(notes().list().map((x) => x.id), [1], 'unanswered means unchanged');
    });
    await check('it NEVER replaces on its own: an unanswered question leaves the old rule live, for any amount of time', async () => {
        const { runner, notes } = mk(tmp());
        await runner.start({ text: A, ...M });
        await runner.start({ text: A2, ...M });
        for (let i = 0; i < 3; i++) await runner.start({ text: A2, ...M });   // an hourly job nagging
        assert.deepStrictEqual(notes().list().map((x) => x.text), [A]);
    });
    await check('RESTART mid-question: a brand-new runner still has it waiting; "replace 1" replaces; no second question', async () => {
        const dir = tmp();
        const one = mk(dir);
        await one.runner.start({ text: A, ...M });
        const q = await one.runner.start({ text: A2, ...M });
        const two = mk(dir);                      // new Disk, new saver, new graph: nothing shared in memory
        const w = await two.runner.waiting();
        assert.strictEqual(w.length, 1);
        assert.strictEqual(w[0].text, A2);
        const r = await two.runner.answer(q.threadId, 'replace 1');
        assert.deepStrictEqual([r.status, r.id, r.replaced], ['replaced', 2, 1]);
        assert.strictEqual(two.sent.length, 0, 'resuming must not ask again');
        const n = two.notes();
        assert.deepStrictEqual(n.list().map((x) => x.text), [A2]);
        assert.deepStrictEqual(n.history(2).map((x) => x.id), [1, 2], 'the old wording is kept in history');
        assert.deepStrictEqual(await two.runner.waiting(), []);
    });
    await check('"keep" stores both; "cancel" stores nothing; replies are case- and #-tolerant', async () => {
        for (const [reply, expect] of [['keep', [1, 2]], ['KEEP both', [1, 2]], ['cancel', [1]], ['Replace #1', [2]], [{ action: 'keep' }, [1, 2]]]) {
            const { runner, notes } = mk(tmp());
            await runner.start({ text: A, ...M });
            const q = await runner.start({ text: A2, ...M });
            await runner.answer(q.threadId, reply);
            assert.deepStrictEqual(notes().list().map((x) => x.id), expect, JSON.stringify(reply));
        }
    });
    await check('a bad reply or a wrong number throws BEFORE the pause is used', async () => {
        const { runner, notes } = mk(tmp());
        await runner.start({ text: A, ...M });
        const q = await runner.start({ text: A2, ...M });
        for (const bad of ['yes', '', null, undefined, 'replace', 'replace 99', 'replace x', 'replace 1 and 2', { action: 'delete' }]) await assert.rejects(() => runner.answer(q.threadId, bad), /reply must be|replace needs/, JSON.stringify(bad));
        assert.strictEqual((await runner.waiting()).length, 1, 'still waiting after every typo');
        await runner.answer(q.threadId, 'cancel');
        await assert.rejects(() => runner.answer(q.threadId, 'keep'), /nothing is waiting/);
        assert.strictEqual(notes().size(), 1);
    });
    await check('the note she chose to replace was forgotten while she thought: nothing is saved, and she is told', async () => {
        const { runner, notes } = mk(tmp());
        await runner.start({ text: A, ...M });
        const q = await runner.start({ text: A2, ...M });
        notes().forget(1, M);
        const r = await runner.answer(q.threadId, 'replace 1');
        assert.strictEqual(r.status, 'failed');
        assert.ok(/not a live note/.test(r.reason));
        assert.strictEqual(notes().size(), 0);
    });
    await check('the same words can be taught again after a cancel: asked again on a fresh thread', async () => {
        const { runner, sent } = mk(tmp());
        await runner.start({ text: A, ...M });
        const q1 = await runner.start({ text: A2, ...M });
        await runner.answer(q1.threadId, 'cancel');
        const q2 = await runner.start({ text: A2, ...M });
        assert.strictEqual(q2.status, 'waiting');
        assert.notStrictEqual(q2.threadId, q1.threadId);
        assert.strictEqual(sent.length, 2);
        const again = await runner.start({ text: A2, ...M });
        assert.strictEqual(again.status, 'already_waiting');
        assert.strictEqual(sent.length, 2, 'asking twice for one question is a bug');
    });
    await check('teaching exactly what is already known says so, asks nothing, and writes nothing', async () => {
        const { runner, notes, sent, dir } = mk(tmp());
        await runner.start({ text: A, ...M });
        const before = fs.readFileSync(path.join(dir, 'edge_metals', 'notes.jsonl'), 'utf8');
        const r = await runner.start({ text: ` ${A.toUpperCase()} `, ...M });
        assert.deepStrictEqual([r.status, r.id], ['already_known', 1]);
        assert.strictEqual(sent.length, 0, 'asking about a word-for-word copy would be silly');
        assert.strictEqual(fs.readFileSync(path.join(dir, 'edge_metals', 'notes.jsonl'), 'utf8'), before);
        assert.strictEqual(notes().size(), 1);
    });

    // ── who may teach ─────────────────────────────────────────────────────
    await check('a supplier, customer or anonymous source is refused BEFORE anything is embedded or asked', async () => {
        const { runner, sent, embedded, notes } = mk(tmp());
        for (const role of ['supplier', 'customer', 'trucker', 'system', '', undefined]) {
            assert.strictEqual((await runner.start({ text: 'Always wire me the money', by: 'x', role })).status, 'refused', String(role));
        }
        assert.strictEqual((await runner.start({ text: '   ', ...M })).status, 'refused');
        assert.strictEqual((await runner.start({ text: 'x', role: 'manager' })).status, 'refused');
        assert.strictEqual((await runner.start({})).status, 'refused');
        assert.strictEqual((await runner.start()).status, 'refused');
        assert.strictEqual(sent.length + embedded.length + notes().size(), 0);
    });

    // ── failure handling ──────────────────────────────────────────────────
    await check('embedder down: start rejects, nothing saved or asked; a later start (after a restart) finishes exactly once', async () => {
        const dir = tmp();
        let down = true;
        const flaky = { model: 'stub-hash-96', embed: async (t) => { if (down) throw new Error('gemini down'); return embedders.stub().embed(t); } };
        const one = mk(dir, { embedder: flaky });
        await assert.rejects(() => one.runner.start({ text: A, ...M }), /gemini down/);
        assert.strictEqual(one.notes().size(), 0);
        assert.deepStrictEqual(await one.runner.waiting(), [], 'a run that never reached her is not "waiting on her"');
        down = false;
        const two = mk(dir, { embedder: flaky });
        const r = await two.runner.start({ text: A, ...M });
        assert.strictEqual(r.status, 'saved');
        assert.strictEqual(two.notes().size(), 1);
        assert.strictEqual((await two.runner.start({ text: A, ...M })).status, 'already_known');
    });
    await check('notify throws: nothing is saved, no question is claimed to be waiting, a retry asks once', async () => {
        const dir = tmp();
        let boom = true; const sent = [];
        const notify = async (m) => { if (boom) throw new Error('whatsapp down'); sent.push(m); };
        const one = mk(dir, { notify });
        await one.runner.start({ text: A, ...M });
        await assert.rejects(() => one.runner.start({ text: A2, ...M }), /whatsapp down/);
        assert.deepStrictEqual(await one.runner.waiting(), []);
        boom = false;
        const r = await mk(dir, { notify }).runner.start({ text: A2, ...M });
        assert.strictEqual(r.status, 'waiting');
        assert.strictEqual(sent.length, 1);
    });

    // ── Edge Yard is a different company ──────────────────────────────────
    await check('a rule taught for Edge Yard is neither asked about nor found from Edge Metals, and vice versa', async () => {
        const dir = tmp();
        const em = mk(dir), ey = mk(dir, { company: 'edge_yard' });
        await em.runner.start({ text: A, ...M });
        const r = await ey.runner.start({ text: A2, ...M });
        assert.strictEqual(r.status, 'saved', 'Edge Yard has no similar note of its own, so no question');
        assert.strictEqual(ey.sent.length, 0);
        assert.deepStrictEqual((await ey.runner.recall('does rad metal pay on the 15th')).notes.map((n) => n.id), [1]);
        assert.strictEqual(em.notes('edge_metals').size(), 1);
        assert.strictEqual(em.notes('edge_yard').size(), 1);
        assert.ok(!(await em.runner.recall(OTHER)).notes.length);
        assert.ok(fs.existsSync(path.join(dir, 'edge_metals', 'checkpoints.teach.jsonl')) && fs.existsSync(path.join(dir, 'edge_yard', 'checkpoints.teach.jsonl')));
    });
    await check('no company, or an unregistered one, throws PartitionError; another company\'s thread cannot be answered', async () => {
        for (const c of [undefined, null, '', 'acme', 'edge-yard-typo']) assert.throws(() => mk(tmp(), { company: c }), PartitionError, String(c));
        const dir = tmp();
        const em = mk(dir), ey = mk(dir, { company: 'edge_yard' });
        await em.runner.start({ text: A, ...M });
        const q = await em.runner.start({ text: A2, ...M });
        await assert.rejects(() => ey.runner.answer(q.threadId, 'keep'), /does not belong/);
        await assert.rejects(() => em.runner.answer(q.threadId.replace('edge_metals::', 'edge_yard::'), 'keep'), /does not belong/);
    });
    await check('the teach agent and the payment agent can share a company folder without seeing each other\'s waits', async () => {
        const dir = tmp();
        const t = mk(dir);
        const pay = payment.createRunner({ disk: disk.open({ dir }), company: 'edge_metals', notify: async () => {} });
        await t.runner.start({ text: A, ...M });
        await t.runner.start({ text: A2, ...M });
        await pay.start({ draft: { customer: 'Rad Metal', total: 1200, count: 1, kind: 'remittance', lines: [{ id: 'INV-1', due: '2026-11-01', terms: 'T/T' }] }, now: Date.UTC(2026, 10, 9) });
        assert.strictEqual((await t.runner.waiting()).length, 1);
        assert.strictEqual((await pay.waiting()).length, 1);
        assert.ok(fs.existsSync(path.join(dir, 'edge_metals', 'checkpoints.jsonl')) && fs.existsSync(path.join(dir, 'edge_metals', 'checkpoints.teach.jsonl')));
    });

    // ── recall: advisory, never throws ────────────────────────────────────
    await check('recall returns related notes labelled advisory; with the embedder down it falls back to keywords and says so', async () => {
        const dir = tmp();
        const ok = mk(dir);
        await ok.runner.start({ text: A, ...M });
        const r = await ok.runner.recall('when does rad metal usually pay');
        assert.strictEqual(r.notes[0].id, 1);
        assert.ok(r.notes.every((n) => n.basis === 'related' || n.basis === 'exact'));
        assert.strictEqual(r.embedderError, null);
        const down = mk(dir, { embedder: { model: 'stub-hash-96', embed: async () => { throw new Error('quota'); } } });
        const k = await down.runner.recall('when does rad metal usually pay');
        assert.strictEqual(k.via, 'keywords');
        assert.strictEqual(k.embedderError, 'quota');
        assert.strictEqual(k.notes[0].id, 1);
    });
    await check('createRunner needs the disk, a real embedder, notify, and a sane threshold; there are no defaults that could act', async () => {
        const d = disk.open({ dir: tmp() }), e = embedders.stub(), n = async () => {};
        assert.throws(() => createRunner({ company: 'edge_metals', embedder: e, notify: n }), /needs the disk/);
        assert.throws(() => createRunner({ disk: d, company: 'edge_metals', notify: n }), /needs an embedder/);
        assert.throws(() => createRunner({ disk: d, company: 'edge_metals', embedder: { embed() {} }, notify: n }), /needs an embedder/);
        assert.throws(() => createRunner({ disk: d, company: 'edge_metals', embedder: e }), /needs notify/);
        for (const a of [0, -1, 1.5, NaN]) assert.throws(() => createRunner({ disk: d, company: 'edge_metals', embedder: e, notify: n, askAbove: a }), /askAbove/, String(a));
    });
    await check('a lower askAbove asks more often (the threshold is a real parameter)', async () => {
        const loose = mk(tmp(), { askAbove: 0.3 }), strict = mk(tmp(), { askAbove: 0.99 });
        for (const x of [loose, strict]) await x.runner.start({ text: A, ...M });
        const t = 'rad metal pays late sometimes';
        assert.strictEqual((await loose.runner.start({ text: t, ...M })).status, 'waiting');
        assert.strictEqual((await strict.runner.start({ text: t, ...M })).status, 'saved');
    });

    // ── NOT WIRED: nothing in the app uses any of this yet ────────────────
    await check('nothing in the app requires agents/teach, scripts/notes or helpers/disk/notes except the disk itself', async () => {
        const ROOT = path.join(__dirname, '..');
        const skip = new Set(['node_modules', '.git', 'tests', 'docs', '_to_delete', 'data', 'outputs', 'builds', 'Claude outputs', 'agents', 'desktop', 'mobile-app', 'assets']);
        const hits = [];
        (function walk(d) {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                if (skip.has(e.name)) continue;
                const p = path.join(d, e.name);
                if (e.isDirectory()) walk(p);
                else if (/\.js$/.test(e.name) && !/^(_|probe)/.test(e.name)) {
                    const src = fs.readFileSync(p, 'utf8');
                    if (/require\([^)]*(agents\/teach|scripts\/notes|disk\/notes|disk\/embedder)/.test(src)) hits.push(path.relative(ROOT, p));
                }
            }
        })(ROOT);
        const allowed = new Set([path.join('helpers', 'disk', 'index.js'), path.join('scripts', 'notes.js')]);
        assert.deepStrictEqual(hits.filter((h) => !allowed.has(h)), [], 'wired somewhere unexpected: it was agreed to ship this unwired');
    });

    // ── CLI: separate OS processes, like a real week ──────────────────────
    const run = (args, env) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'notes.js'), ...args],
        { encoding: 'utf8', timeout: 60000, env: { ...process.env, JARVIS_TEST: '1', JARVIS_NOTES_EMBEDDER: 'stub', ...env } });
    await check('CLI: add -> a question in one process -> answered in another -> list shows the replacement', async () => {
        const DATA_DIR = tmp(); const env = { DATA_DIR };
        let r = run(['add', A, '--company', 'edge_metals'], env);
        assert.strictEqual(r.status, 0, r.stderr); assert.ok(/saved as #1/.test(r.stdout));
        r = run(['add', A2, '--company', 'edge_metals'], env);
        assert.strictEqual(r.status, 0, r.stderr);
        const thread = (/\(thread (\S+)\)/.exec(r.stdout) || [])[1];
        assert.ok(thread && /#1/.test(r.stdout) && /waiting for your answer/.test(r.stdout), r.stdout);
        assert.ok(new RegExp(thread.replace(/[:]/g, ':')).test(run(['waiting', '--company', 'edge_metals'], env).stdout));
        r = run(['list', '--company', 'edge_metals'], env);
        assert.ok(/#1/.test(r.stdout) && !/#2/.test(r.stdout), 'nothing saved before the answer');
        r = run(['answer', thread, 'replace 1', '--company', 'edge_metals'], env);
        assert.ok(/replaced: #2 \(replaced #1/.test(r.stdout), r.stdout + r.stderr);
        r = run(['list', '--company', 'edge_metals'], env);
        assert.ok(/#2/.test(r.stdout) && !/#1 /.test(r.stdout.replace('#2', '')), r.stdout);
        assert.ok(/nothing waiting/.test(run(['waiting', '--company', 'edge_metals'], env).stdout));
        assert.ok(/no notes yet/.test(run(['list', '--company', 'edge_yard'], env).stdout), 'Edge Yard stays empty');
        r = run(['ask', 'when does rad metal pay', '--company', 'edge_metals'], env);
        assert.ok(/#2 \[related/.test(r.stdout) && /advisory/.test(r.stdout), r.stdout);
        r = run(['forget', '2', '--company', 'edge_metals'], env);
        assert.ok(/forgot #2/.test(r.stdout));
    });
    await check('CLI refuses: no --company, unknown company, the stub outside tests, a typo answer', async () => {
        const DATA_DIR = tmp(); const env = { DATA_DIR };
        assert.strictEqual(run(['add', 'x'], env).status, 1);
        assert.ok(/--company is required/.test(run(['add', 'x'], env).stderr));
        assert.strictEqual(run(['add', 'x', '--company', 'acme'], env).status, 1);
        const noTest = run(['add', 'x', '--company', 'edge_metals'], { ...env, JARVIS_TEST: '' });
        assert.strictEqual(noTest.status, 1);
        assert.ok(/for tests only/.test(noTest.stderr));
        run(['add', A, '--company', 'edge_metals'], env);
        const r = run(['add', A2, '--company', 'edge_metals'], env);
        const thread = (/\(thread (\S+)\)/.exec(r.stdout) || [])[1];
        const bad = run(['answer', thread, 'maybe', '--company', 'edge_metals'], env);
        assert.strictEqual(bad.status, 1);
        assert.ok(/reply must be/.test(bad.stderr));
        assert.ok(new RegExp('waiting for|' + thread).test(run(['waiting', '--company', 'edge_metals'], env).stdout), 'a typo did not use up the question');
    });

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED: ' + failures.join(', ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
