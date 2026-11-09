// ── tests/payment-case-graph.js — the LangGraph payment follow-up (agents/paymentCase) ──
// Runs against temp directories, never data/. No model, no network: the graph has no LLM in it.
// "End to end" here means: public runner API -> real graph -> real disk checkpoint journal on disk ->
// a SECOND runner built from scratch on the same directory (what a pm2 restart does) -> answer -> real
// disk log. It is NOT through an HTTP route, because nothing wires this graph to a route yet; the day it
// is wired, CLAUDE.md rule 3 means that change adds the server section (tests/paid-via.js section F).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const disk = require('../helpers/disk');
const chaser = require('../helpers/paymentChaser');
const { createRunner, ANSWERS } = require('../agents/paymentCase');
const { DiskCheckpointer } = require('../agents/paymentCase/checkpointer');

let pass = 0, fail = 0;
const failures = [];
async function check(name, fn) {
    try { await fn(); pass++; }
    catch (e) { fail++; failures.push(name); console.log(`  ✗ ${name}\n      ${String(e.message).split('\n')[0]}`); }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-case-'));
const NOW = Date.UTC(2026, 10, 9);
const DAY = 86400000;
const iso = (t) => new Date(t).toISOString();
const draft = (customer, over = {}) => ({ customer, total: 1200, count: 1, kind: 'remittance', to: 'buyer@example.com',
    lines: [{ id: `INV-${customer.replace(/\s+/g, '')}`, due: '2026-11-01', terms: 'T/T' }], ...over });
// A runner whose notify is a spy. mk() twice on the same dir = a restart.
function mk(dir, o = {}) {
    const sent = [];
    const runner = createRunner({ disk: disk.open({ dir }), company: 'company' in o ? o.company : 'edge_metals',
        notify: o.notify || (async (m) => { sent.push(m); }) });
    return { runner, sent, dir };
}
const stats = (dir, customer) => disk.open({ dir }).for('edge_metals').log.stats(`payment-chase:${chaser.keyOf(customer)}`);

(async () => {
    // ── the ladder is the existing one ────────────────────────────────────
    await check('nothing due -> no thread, no message, no checkpoint file', async () => {
        const { runner, sent, dir } = mk(tmp());
        for (const d of [draft('Zero Co', { total: 0 }),
            draft('Lc Co', { lines: [{ id: 'L1', due: '2026-11-01', terms: 'LC at sight' }] })]) {
            // an LC customer only skips once a rung has already fired; fresh LC still gets the first "draft ready"
            const r = await runner.start({ draft: d, now: NOW });
            if (d.total === 0) assert.strictEqual(r.status, 'nothing_due');
        }
        assert.strictEqual((await runner.start({ draft: draft('Zero Co', { total: 0 }), now: NOW })).status, 'nothing_due');
        const { runner: r2, sent: s2, dir: d2 } = mk(tmp());
        await r2.start({ draft: draft('Zero Co', { total: 0 }), now: NOW });
        assert.strictEqual(s2.length, 0);
        assert.ok(!fs.existsSync(path.join(d2, 'edge_metals', 'checkpoints.jsonl')), 'a no-op must not create state');
        void sent;
    });
    await check('agrees with paymentChaser.nextAction on the rung for each case', async () => {
        const cases = [
            { d: draft('Case A'), e: undefined },
            { d: draft('Case B'), e: { set: chaser.setKey(draft('Case B')), firstAt: iso(NOW - 8 * DAY), lastStep: 'ask', lastAt: iso(NOW - 8 * DAY) } },
            { d: draft('Case C'), e: { set: chaser.setKey(draft('Case C')), firstAt: iso(NOW - 30 * DAY), lastStep: 'chase', lastAt: iso(NOW - 10 * DAY) } },
            { d: draft('Case D'), e: { set: chaser.setKey(draft('Case D')), firstAt: iso(NOW - 2 * DAY), lastStep: 'ask', lastAt: iso(NOW - 2 * DAY) } },
        ];
        for (const c of cases) {
            const want = chaser.nextAction(c.d, c.e, NOW).step;
            const { runner } = mk(tmp());
            const r = await runner.start({ draft: c.d, entry: c.e, now: NOW });
            assert.strictEqual(r.status === 'nothing_due' ? null : r.step, want, c.d.customer);
        }
    });

    // ── she is told once; the customer is never contacted ─────────────────
    await check('start tells her once and parks; the payload carries no customer address', async () => {
        const { runner, sent } = mk(tmp());
        const r = await runner.start({ draft: draft('Rad Metal'), now: NOW });
        assert.strictEqual(r.status, 'waiting');
        assert.strictEqual(sent.length, 1);
        assert.strictEqual(sent[0].audience, 'owner');
        assert.ok(/Rad Metal/.test(sent[0].text) && /1,200\.00/.test(sent[0].text));
        assert.ok(!JSON.stringify(sent[0]).includes('buyer@example.com'), 'customer address must not leave the draft');
        assert.ok(!('to' in sent[0]) && !('cc' in sent[0]));
    });
    await check('escalation goes to the team, not to her alone', async () => {
        const d = draft('Slow Payer');
        const e = { set: chaser.setKey(d), firstAt: iso(NOW - 30 * DAY), lastStep: 'chase', lastAt: iso(NOW - 10 * DAY) };
        const { runner, sent } = mk(tmp());
        const r = await runner.start({ draft: d, entry: e, now: NOW });
        assert.strictEqual(r.step, 'escalate');
        assert.strictEqual(sent[0].audience, 'team');
    });

    // ── idempotent: an hourly job can call start() freely ─────────────────
    await check('start twice for the same rung messages her once; after her answer, never again', async () => {
        const { runner, sent } = mk(tmp());
        const a = await runner.start({ draft: draft('Rad Metal'), now: NOW });
        const b = await runner.start({ draft: draft('Rad Metal'), now: NOW + 3600000 });
        assert.strictEqual(b.status, 'already_waiting');
        assert.strictEqual(sent.length, 1);
        await runner.answer(a.threadId, 'sent');
        const c = await runner.start({ draft: draft('Rad Metal'), now: NOW + 2 * 3600000 });
        assert.strictEqual(c.status, 'already_answered');
        assert.strictEqual(sent.length, 1, 'answering must not re-notify, and neither may a later start');
    });

    // ── the point of LangGraph here: the wait survives a restart ──────────
    await check('RESTART: a brand-new runner on the same directory still has her waiting; answering works; no second message', async () => {
        const dir = tmp();
        const first = mk(dir);
        const r = await first.runner.start({ draft: draft('Rad Metal'), now: NOW });
        assert.strictEqual(first.sent.length, 1);
        const second = mk(dir);               // new Disk, new saver, new graph: nothing shared in memory
        const w = await second.runner.waiting();
        assert.strictEqual(w.length, 1);
        assert.strictEqual(w[0].threadId, r.threadId);
        assert.strictEqual(w[0].customer, 'Rad Metal');
        const done = await second.runner.answer(r.threadId, 'sent');
        assert.strictEqual(done.outcome, 'approved');
        assert.strictEqual(second.sent.length, 0, 'resuming must not message her again');
        assert.deepStrictEqual(await second.runner.waiting(), []);
        assert.strictEqual(stats(dir, 'Rad Metal').approved, 1);
        const third = mk(dir);                 // and a restart AFTER the answer remembers it was answered
        assert.strictEqual((await third.runner.start({ draft: draft('Rad Metal'), now: NOW })).status, 'already_answered');
        assert.strictEqual(third.sent.length, 0);
    });
    await check('every answer is filed in the closed vocabulary: sent=approved hold=rejected skip=rejected paid=corrected', async () => {
        const want = { sent: 'approved', hold: 'rejected', skip: 'rejected', paid: 'corrected' };
        assert.deepStrictEqual([...ANSWERS].sort(), Object.keys(want).sort());
        for (const [ans, outcome] of Object.entries(want)) {
            const dir = tmp();
            const { runner } = mk(dir);
            const r = await runner.start({ draft: draft(`Cust ${ans}`), now: NOW });
            assert.strictEqual((await runner.answer(r.threadId, ans.toUpperCase())).outcome, outcome);   // case-insensitive
            const s = stats(dir, `Cust ${ans}`);
            assert.strictEqual(s.total, 1);
            assert.strictEqual(s.last, outcome);
        }
    });

    // ── bad input does not use up the pause ───────────────────────────────
    await check('a typo answer throws and leaves her still waiting; answering a finished thread throws', async () => {
        const { runner } = mk(tmp());
        const r = await runner.start({ draft: draft('Rad Metal'), now: NOW });
        for (const bad of ['yes', '', null, undefined, 'sent!']) await assert.rejects(() => runner.answer(r.threadId, bad), /answer must be one of/);
        assert.strictEqual((await runner.waiting()).length, 1);
        await runner.answer(r.threadId, 'hold');
        await assert.rejects(() => runner.answer(r.threadId, 'sent'), /nothing is waiting/);
        await assert.rejects(() => runner.answer('edge_metals::nobody::x::ask', 'sent'), /nothing is waiting/);
    });

    // ── Edge Yard is a different company ──────────────────────────────────
    await check('a runner for Edge Yard (or anything else) refuses to exist', async () => {
        for (const c of ['edge_yard', 'Edge Yard', 'edge-yard', '', undefined, 'acme']) {
            assert.throws(() => mk(tmp(), { company: c }), /Edge Metals only/, String(c));
        }
    });
    await check('state lives only in the Edge Metals folder; an Edge Yard thread id cannot be answered', async () => {
        const dir = tmp();
        const { runner } = mk(dir);
        const r = await runner.start({ draft: draft('Rad Metal'), now: NOW });
        assert.ok(fs.existsSync(path.join(dir, 'edge_metals', 'checkpoints.jsonl')));
        assert.ok(!fs.existsSync(path.join(dir, 'edge_yard')), 'nothing may be created for the other company');
        await assert.rejects(() => runner.answer(r.threadId.replace('edge_metals::', 'edge_yard::'), 'sent'), /does not belong/);
    });
    await check('notify and start are required: no default that could send', async () => {
        assert.throws(() => createRunner({ disk: disk.open({ dir: tmp() }), company: 'edge_metals' }), /needs notify/);
        assert.throws(() => createRunner({ company: 'edge_metals', notify: async () => {} }), /needs the disk/);
        const { runner } = mk(tmp());
        await assert.rejects(() => runner.start({}), /needs a draft/);
        await assert.rejects(() => runner.start(), /needs a draft/);
    });

    // ── failure handling ──────────────────────────────────────────────────
    await check('notify throws: no log row, start rejects; a later start retries and tells her exactly once', async () => {
        const dir = tmp();
        let boom = true; const sent = [];
        const notify = async (m) => { if (boom) throw new Error('whatsapp down'); sent.push(m); };
        const { runner } = mk(dir, { notify });
        await assert.rejects(() => runner.start({ draft: draft('Rad Metal'), now: NOW }), /whatsapp down/);
        assert.strictEqual(disk.open({ dir }).for('edge_metals').log.recent('payment-chase:rad metal').length, 0, 'no decision may be logged for a message that never went');
        assert.deepStrictEqual(await runner.waiting(), [], 'a run that never told her is not "waiting on her"');
        boom = false;
        const r = await mk(dir, { notify }).runner.start({ draft: draft('Rad Metal'), now: NOW });   // after a restart, too
        assert.strictEqual(r.status, 'waiting');
        assert.strictEqual(sent.length, 1);
    });
    await check('a torn last line in the journal is skipped, counted, and does not lose what came before', async () => {
        const dir = tmp();
        const first = mk(dir);
        const r = await first.runner.start({ draft: draft('Rad Metal'), now: NOW });
        fs.appendFileSync(path.join(dir, 'edge_metals', 'checkpoints.jsonl'), '{"k":"c","t":"edge_metals::x","ns":"","id":"1","v":["QUJD"');   // crash mid-write
        const second = mk(dir);
        assert.strictEqual((await second.runner.waiting()).length, 1);
        const s = new DiskCheckpointer({ dir: path.join(dir, 'edge_metals') });
        assert.strictEqual(s.badLines, 1);
        assert.strictEqual((await second.runner.answer(r.threadId, 'sent')).outcome, 'approved');
        // and the next write after a torn line must still be a whole line
        const lines = fs.readFileSync(path.join(dir, 'edge_metals', 'checkpoints.jsonl'), 'utf8').split('\n').filter(Boolean);
        assert.strictEqual(lines.filter((l) => { try { JSON.parse(l); return false; } catch (_) { return true; } }).length, 1, 'only the one torn line is unparseable');
    });
    await check('journal replay is idempotent: loading the same file three times gives the same waiting list', async () => {
        const dir = tmp();
        const { runner } = mk(dir);
        await runner.start({ draft: draft('Rad Metal'), now: NOW });
        await runner.start({ draft: draft('Mk Trading'), now: NOW });
        const a = JSON.stringify((await mk(dir).runner.waiting()).map((x) => x.threadId).sort());
        const b = JSON.stringify((await mk(dir).runner.waiting()).map((x) => x.threadId).sort());
        assert.strictEqual(a, b);
        assert.strictEqual(JSON.parse(a).length, 2);
    });

    // ── what she has taught is shown, never decisive ──────────────────────
    await check('a taught customer rule is shown to her and does NOT change the rung', async () => {
        const dir = tmp();
        const part = disk.open({ dir }).for('edge_metals');
        part.facts.put({ scopeType: 'customer', scopeId: 'rad-metal', name: 'always_pays', value: 'Always pays on the 15th; do not chase before the 20th.', by: 'apsara', role: 'manager' });
        const taught = mk(dir);
        const plain = mk(tmp());
        const a = await taught.runner.start({ draft: draft('Rad Metal'), now: NOW });
        const b = await plain.runner.start({ draft: draft('Rad Metal'), now: NOW });
        assert.strictEqual(a.step, b.step, 'advice must not move the rung');
        assert.ok(/on file: always_pays/.test(taught.sent[0].text) && /15th/.test(taught.sent[0].text));
        assert.ok(!/on file/.test(plain.sent[0].text));
        assert.ok(!/on file/.test(mk(dir).sent.join('')), 'sanity');
    });
    await check('a rule taught for another customer is not shown', async () => {
        const dir = tmp();
        disk.open({ dir }).for('edge_metals').facts.put({ scopeType: 'customer', scopeId: 'mk-trading', name: 'always_pays', value: 'MK pays late but pays.', by: 'apsara', role: 'manager' });
        const { runner, sent } = mk(dir);
        await runner.start({ draft: draft('Rad Metal'), now: NOW });
        assert.ok(!/MK pays/.test(sent[0].text));
    });

    // ── the dependency story ──────────────────────────────────────────────
    await check('exact pinned versions, and the unused packages stay out', async () => {
        const pkg = require('../package.json');
        assert.strictEqual(pkg.dependencies['@langchain/langgraph'], '1.7.2');
        assert.strictEqual(pkg.dependencies['@langchain/core'], '1.3.5');
        assert.ok(!('langchain' in pkg.dependencies), 'the umbrella langchain package is not used by anything');
        assert.ok(!('langsmith' in pkg.dependencies));
    });
    await check('nothing in agents/ reads a customer address or posts to a network', async () => {
        for (const f of ['graph.js', 'index.js', 'checkpointer.js']) {
            const src = fs.readFileSync(path.join(__dirname, '..', 'agents', 'paymentCase', f), 'utf8').replace(/\/\/.*$/gm, '');
            assert.ok(!/draft\.to\b|\.cc\b|hasAddress|require\(['"](nodemailer|twilio|whatsapp-web\.js|https?)['"]\)|\bfetch\(/.test(src), `${f} touches an address or the network`);
        }
    });

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED: ' + failures.join(', ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
