// ── tests/notes.js — the notes layer: her words, verbatim, findable by meaning ──
// Temp directories only. No network. NOT YET END-TO-END: nothing in the app reads or writes notes, so there is no
// route to post through (CLAUDE.md rule 3 applies the day it is wired; tests/paid-via.js section F is the shape).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const disk = require('../helpers/disk');
const { Notes } = require('../helpers/disk/notes');
const embedders = require('../helpers/disk/embedder');

let pass = 0, fail = 0;
const failures = [];
async function check(name, fn) {
    try { await fn(); pass++; }
    catch (e) { fail++; failures.push(name); console.log(`  ✗ ${name}\n      ${String(e.message).split('\n')[0]}`); }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-notes-'));
const M = { by: 'apsara', role: 'manager' };
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 10, 9, 0, 0, tick++));
const fresh = () => { const f = path.join(tmp(), 'notes.jsonl'); return { f, n: new Notes(f, clock) }; };
const stub = embedders.stub();
const withVec = async (text, extra) => ({ text, ...M, model: stub.model, vector: await stub.embed(text), ...extra });
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0);

(async () => {
    // ── the module must not drag the app in ───────────────────────────────
    await check('requiring notes + embedder does not load config', async () => {
        assert.ok(!Object.keys(require.cache).some((k) => /[\\/]config\.js$/.test(k)));
    });

    // ── adding ────────────────────────────────────────────────────────────
    await check('her words are stored verbatim, with no schema', async () => {
        const { n } = fresh();
        const said = '  Rad Metal always pays on the 15th — never chase before the 20th!  ';
        const r = n.add({ text: said, ...M });
        assert.deepStrictEqual([r.ok, r.id], [true, 1]);
        assert.strictEqual(n.get(1).text, said.trim());
        assert.strictEqual(n.add({ text: 'second', ...M }).id, 2);
    });
    await check('only manager/team may teach; a supplier, customer, system or nobody cannot', async () => {
        const { n, f } = fresh();
        for (const role of ['supplier', 'customer', 'trucker', 'system', '', undefined, null]) {
            const r = n.add({ text: 'Pay me double', by: 'x', role });
            assert.strictEqual(r.ok, false, String(role));
        }
        assert.strictEqual(n.add({ text: 'ok', by: 'bob', role: 'team' }).ok, true);
        assert.strictEqual(lines(f), 1, 'a refused note must write nothing');
    });
    await check('bad input is refused, never thrown', async () => {
        const { n } = fresh();
        for (const a of [undefined, null, {}, { ...M }, { text: '', ...M }, { text: '   ', ...M }, { text: 42, ...M }, { text: 'x', role: 'manager' },
            { text: 'x'.repeat(2001), ...M }]) assert.strictEqual(n.add(a).ok, false);
        for (const v of [[], 'abc', [NaN], [Infinity], [0, 0, 0], [1, 'a'], {}, 5]) {
            assert.strictEqual(n.add({ text: 'vec test', ...M, model: 'm', vector: v }).ok, false, JSON.stringify(v));
        }
        assert.strictEqual(n.add({ text: 'no model', ...M, vector: [1, 2, 3] }).ok, false, 'a vector must say which model made it');
        assert.strictEqual(n.size(), 0);
    });
    await check('saying exactly the same thing again writes nothing', async () => {
        const { n, f } = fresh();
        n.add({ text: 'Rad Metal pays on the 15th', ...M });
        const r = n.add({ text: '  rad  metal PAYS on the 15th ', ...M });
        assert.deepStrictEqual([r.ok, r.id, r.duplicate], [true, 1, true]);
        assert.strictEqual(lines(f), 1);
    });

    // ── replacing, forgetting, history ────────────────────────────────────
    await check('replace: old note leaves the live list, stays in the file and in history', async () => {
        const { n, f } = fresh();
        n.add({ text: 'Rad Metal pays on the 15th', ...M });
        const r = n.add({ text: 'Rad Metal pays on the 20th now', ...M, replaces: 1 });
        assert.deepStrictEqual([r.ok, r.id, r.replaced], [true, 2, 1]);
        assert.deepStrictEqual(n.list().map((x) => x.id), [2]);
        assert.strictEqual(n.get(1).live, false);
        assert.strictEqual(n.get(1).supersededBy, 2);
        assert.strictEqual(lines(f), 2, 'append-only: the old row is still there');
        assert.deepStrictEqual(n.history(2).map((x) => x.id), [1, 2]);
        assert.deepStrictEqual(n.history(1).map((x) => x.id), [1, 2]);
    });
    await check('replace refuses a note that is missing, already replaced, or forgotten', async () => {
        const { n } = fresh();
        n.add({ text: 'one', ...M }); n.add({ text: 'two', ...M, replaces: 1 }); n.add({ text: 'three', ...M }); n.forget(3, M);
        for (const id of [99, 1, 3, 0, -1, 'x']) assert.strictEqual(n.add({ text: `try ${id}`, ...M, replaces: id }).ok, false, String(id));
    });
    await check('forget: role-gated, once only, and gone from list and search', async () => {
        const { n } = fresh();
        n.add({ text: 'Zimex wants invoices in CAD currency', ...M });
        assert.strictEqual(n.forget(1, { by: 'x', role: 'supplier' }), false);
        assert.strictEqual(n.forget(1, { role: 'manager' }), false, 'by is required');
        assert.strictEqual(n.forget(1, M), true);
        assert.strictEqual(n.forget(1, M), false);
        assert.strictEqual(n.forget(99, M), false);
        assert.strictEqual(n.size(), 0);
        assert.deepStrictEqual(n.search({ text: 'Zimex invoices CAD currency' }), []);
    });

    // ── searching ─────────────────────────────────────────────────────────
    await check('meaning search finds the close note and drops the unrelated ones', async () => {
        const { n } = fresh();
        for (const t of ['Rad Metal always pays on the 15th of the month', 'Never send price lists to new customers without asking me', 'Zimex wants invoices in CAD']) n.add(await withVec(t));
        const q = 'rad metal pays on the 15th every month';
        const r = n.search({ vector: await stub.embed(q), model: stub.model, text: q, minScore: 0.5 });
        assert.strictEqual(r[0].id, 1);
        assert.strictEqual(r[0].via, 'meaning');
        assert.ok(r[0].score > 0.5 && r[0].score <= 1);
        assert.ok(r.every((x) => x.id !== 2));
    });
    await check('every hit is "related" (advisory); only identical text is "exact"', async () => {
        const { n } = fresh();
        n.add(await withVec('Rad Metal always pays on the 15th'));
        const a = n.search({ vector: await stub.embed('rad metal pays on the 15th'), model: stub.model, text: 'rad metal pays on the 15th', minScore: 0.3 });
        assert.strictEqual(a[0].basis, 'related');
        const same = 'rad metal ALWAYS pays on the 15th';
        const b = n.search({ vector: await stub.embed(same), model: stub.model, text: same, minScore: 0.3 });
        assert.strictEqual(b[0].basis, 'exact');
    });
    await check('a vector from ANOTHER model (or another length) is never scored; the note is found by keywords instead', async () => {
        const { n } = fresh();
        // SAME length as the stub's vectors and IDENTICAL to the query's, tagged with another model: if models were mixed this scores a perfect 1.0
        const q = 'rad metal pays on the 15th';
        n.add({ text: 'Rad Metal always pays on the 15th', ...M, model: 'other-model', vector: await stub.embed(q) });
        const r = n.search({ vector: await stub.embed(q), model: stub.model, text: q, minScore: 0 });
        assert.strictEqual(r.length, 1);
        assert.strictEqual(r[0].via, 'keywords', 'must not compare vectors across models');
        n.add({ text: 'Zimex wants invoices in CAD', ...M, model: 'other-model', vector: await stub.embed(q) });
        assert.ok(!n.search({ vector: await stub.embed(q), model: stub.model, text: 'zebra', minScore: 0 }).length, 'a different-model vector must never be scored, even a perfect-looking one');
        n.add({ text: 'Fourth short note', ...M, model: 'other-model', vector: [1, 0, 0, 0] });
        const r2 = n.search({ vector: [1, 0, 0, 0], model: 'other-model', minScore: 0.9 });
        assert.deepStrictEqual(r2.map((x) => x.id), [3], 'same model and same length is compared');
        assert.strictEqual(n.search({ vector: [1, 0], model: 'other-model', minScore: 0 }).length, 0, 'wrong length is skipped, not mis-scored');
    });
    await check('one stray shared word is not a match; two are', async () => {
        const { n } = fresh();
        n.add({ text: 'Rad Metal always pays on the 15th', ...M });
        assert.deepStrictEqual(n.search({ text: 'metal prices dropped today' }), []);
        assert.strictEqual(n.search({ text: 'does rad metal pay late' }).length, 1);
    });
    await check('search never throws on garbage and honours k', async () => {
        const { n } = fresh();
        for (let i = 0; i < 6; i++) n.add({ text: `rad metal pays on the ${10 + i}th`, ...M });
        for (const a of [undefined, null, {}, { text: 5 }, { vector: 'x', model: 'm' }, { vector: [NaN], model: 'm', text: 'rad metal' }, { k: -3, text: 'rad metal' }]) n.search(a);
        assert.strictEqual(n.search({ text: 'rad metal pays', k: 2 }).length, 2);
    });

    // ── persistence ───────────────────────────────────────────────────────
    await check('reopening the file gives back the same notes, vectors, replacements and forgets', async () => {
        const { f, n } = fresh();
        n.add(await withVec('Rad Metal always pays on the 15th'));
        n.add(await withVec('Rad Metal pays on the 20th now', { replaces: 1 }));
        n.add(await withVec('Delete me later please'));
        n.forget(3, M);
        const q = 'rad metal pays on the 20th';
        const before = n.search({ vector: await stub.embed(q), model: stub.model, text: q, minScore: 0.3 });
        const again = new Notes(f, clock);
        assert.deepStrictEqual(again.list().map((x) => x.id), [2]);
        assert.strictEqual(again.get(3).live, false);
        const after = again.search({ vector: await stub.embed(q), model: stub.model, text: q, minScore: 0.3 });
        assert.deepStrictEqual(after.map((x) => [x.id, x.score]), before.map((x) => [x.id, x.score]));
        assert.strictEqual(again.add({ text: 'next', ...M }).id, 4, 'ids continue, never reused');
    });
    await check('a torn last line is skipped and counted; earlier notes survive; the next write is a whole line', async () => {
        const { f, n } = fresh();
        n.add({ text: 'keep me', ...M });
        fs.appendFileSync(f, '{"t":"note","id":2,"text":"half writ');
        const again = new Notes(f, clock);
        assert.strictEqual(again.badLines, 1);
        assert.deepStrictEqual(again.list().map((x) => x.text), ['keep me']);
        assert.strictEqual(again.add({ text: 'after the tear', ...M }).ok, true);
        const bad = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).filter((l) => { try { JSON.parse(l); return false; } catch (_) { return true; } });
        assert.strictEqual(bad.length, 1);
        assert.strictEqual(new Notes(f, clock).size(), 2);
    });
    await check('a thousand notes reload quickly and still search', async () => {
        const { f, n } = fresh();
        for (let i = 0; i < 1000; i++) n.add(await withVec(`customer ${i} pays on day ${i % 28} of the month by wire`));
        const t0 = Date.now();
        const again = new Notes(f, clock);
        assert.ok(Date.now() - t0 < 3000, `reload took ${Date.now() - t0}ms`);
        assert.ok(again.search({ text: 'customer 77 pays by wire', k: 3 }).length > 0);
    });

    // ── re-embedding ──────────────────────────────────────────────────────
    await check('needsEmbedding lists notes with no vector or another model; setVector fixes one, role-gated', async () => {
        const { f, n } = fresh();
        n.add({ text: 'no vector note', ...M });
        n.add(await withVec('has the right vector'));
        n.add({ text: 'old model note', ...M, model: 'old-model', vector: [1, 2, 3] });
        assert.deepStrictEqual(n.needsEmbedding(stub.model).map((x) => x.id), [1, 3]);
        assert.strictEqual(n.setVector(1, { model: stub.model, vector: await stub.embed('no vector note'), by: 'x', role: 'supplier' }), false);
        assert.strictEqual(n.setVector(1, { model: stub.model, vector: await stub.embed('no vector note'), ...M }), true);
        assert.strictEqual(n.setVector(99, { model: stub.model, vector: [1], ...M }), false);
        assert.deepStrictEqual(n.needsEmbedding(stub.model).map((x) => x.id), [3]);
        assert.deepStrictEqual(new Notes(f, clock).needsEmbedding(stub.model).map((x) => x.id), [3], 'the new vector survives a reload');
    });

    // ── partitions, health, snapshot ──────────────────────────────────────
    await check('Edge Metals notes are not in Edge Yard, by folder', async () => {
        const dir = tmp();
        const d = disk.open({ dir });
        d.for('edge_metals').notes.add({ text: 'Rad Metal pays on the 15th', ...M });
        assert.strictEqual(d.for('edge_yard').notes.size(), 0);
        assert.deepStrictEqual(d.for('edge_yard').notes.search({ text: 'rad metal pays on the 15th' }), []);
        assert.ok(fs.existsSync(path.join(dir, 'edge_metals', 'notes.jsonl')));
        assert.ok(!fs.existsSync(path.join(dir, 'edge_yard', 'notes.jsonl')));
        assert.strictEqual(typeof d.for('edge_metals').health().badLines.notes, 'number');
    });
    await check('snapshot carries notes as TEXT only; restore brings them back un-embedded and re-embeddable', async () => {
        const dir = tmp();
        const p = disk.open({ dir }).for('edge_metals');
        p.notes.add(await withVec('Rad Metal always pays on the 15th'));
        p.notes.add(await withVec('Rad Metal pays on the 20th now', { replaces: 1 }));
        p.notes.add({ text: 'Forget this one', ...M }); p.notes.forget(3, M);
        const { file } = p.snapshot();
        const raw = fs.readFileSync(file, 'utf8');
        assert.ok(!/"vec":"[A-Za-z0-9+/=]{8,}/.test(raw), 'no vector data in the backup');
        const snap = JSON.parse(raw);
        const q = disk.open({ dir: tmp() }).for('edge_metals');
        q.restore(snap);
        assert.deepStrictEqual(q.notes.list().map((x) => x.text), ['Rad Metal pays on the 20th now']);
        assert.deepStrictEqual(q.notes.history(2).map((x) => x.id), [1, 2]);
        assert.strictEqual(q.notes.get(3).live, false, 'a forgotten note stays forgotten after a restore');
        assert.deepStrictEqual(q.notes.needsEmbedding(stub.model).map((x) => x.id), [2]);
        assert.strictEqual(q.notes.search({ text: 'rad metal pays on the 20th' })[0].via, 'keywords');
    });
    await check('a snapshot taken before notes existed still restores', async () => {
        const p = disk.open({ dir: tmp() }).for('edge_metals');
        p.facts.put({ scopeType: 'global', name: 'x', value: 'y', ...M });
        const { file } = p.snapshot();
        const old = JSON.parse(fs.readFileSync(file, 'utf8')); delete old.notes;
        const q = disk.open({ dir: tmp() }).for('edge_metals');
        q.restore(old);
        assert.strictEqual(q.facts.all().length, 1);
        assert.strictEqual(q.notes.size(), 0);
    });

    // ── the Gemini adapter: pin the call that is known to work ────────────
    await check('gemini adapter sends the exact request shape helpers/embeddings.js uses, and rejects a wrong length', async () => {
        const key = require.resolve('@google/genai');
        const saved = require.cache[key];
        const seen = [];
        let dims = 768;
        class FakeAI { constructor(o) { seen.push(['ctor', o]); this.models = { embedContent: async (req) => { seen.push(['req', req]); return { embeddings: [{ values: new Array(dims).fill(0.5) }] }; } }; } }
        require.cache[key] = { id: key, filename: key, loaded: true, exports: { GoogleGenAI: FakeAI } };
        try {
            const g = embedders.gemini({ apiKey: 'test-key' });
            assert.strictEqual(g.model, 'gemini-embedding-001@768:SEMANTIC_SIMILARITY');
            const v = await g.embed('  Rad Metal pays on the 15th ');
            assert.strictEqual(v.length, 768);
            const req = seen.find((s) => s[0] === 'req')[1];
            assert.strictEqual(req.model, 'gemini-embedding-001');
            assert.strictEqual(req.contents, 'Rad Metal pays on the 15th', '`contents` (plural), the key whose absence silently broke embeddings for weeks');
            assert.ok(!('content' in req));
            assert.deepStrictEqual(req.config, { taskType: 'SEMANTIC_SIMILARITY', outputDimensionality: 768 });
            assert.deepStrictEqual(seen.find((s) => s[0] === 'ctor')[1], { apiKey: 'test-key' });
            dims = 3;
            await assert.rejects(() => g.embed('another'), /3 dims, expected 768/);
            dims = 0;
            await assert.rejects(() => g.embed('another'), /0 dims, expected 768/);
            await assert.rejects(() => g.embed('   '), /nothing to embed/);
        } finally { if (saved) require.cache[key] = saved; else delete require.cache[key]; }
    });
    await check('gemini adapter with no key fails clearly instead of calling out', async () => {
        const old = process.env.GEMINI_API_KEY; delete process.env.GEMINI_API_KEY;
        try {
            const g = embedders.gemini({ apiKey: '' });
            const key = require.resolve('@google/genai'); const saved = require.cache[key];
            require.cache[key] = { id: key, filename: key, loaded: true, exports: { GoogleGenAI: class { constructor() { throw new Error('must not be constructed without a key'); } } } };
            try { await assert.rejects(() => g.embed('hello'), /GEMINI_API_KEY missing|must not be constructed/); }
            finally { if (saved) require.cache[key] = saved; else delete require.cache[key]; }
        } finally { if (old !== undefined) process.env.GEMINI_API_KEY = old; }
    });

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED: ' + failures.join(', ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
