// ── tests/disk.js — Jarvis's disk: partitions, facts, log, links, query, backup
// Runs against a temp directory, never data/. Needs nothing newer than Node 20.
// NOT YET END-TO-END: the disk is not wired to any route or screen, so there is
// no route to post through. CLAUDE.md rule 3 applies the day it is wired, and that
// change must add the server section (tests/paid-via.js section F is the shape).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const disk = require('../helpers/disk');
const { PartitionError } = disk;

let pass = 0, fail = 0;
const failures = [];
function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { fail++; failures.push(name); console.log(`  ✗ ${name}\n      ${String(e.message).split('\n')[0]}`); }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-disk-'));
const M = { by: 'apsara', role: 'manager' };
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 10, 9, 0, 0, tick++));   // deterministic, strictly increasing

// ── the module must not drag the app in ─────────────────────────────────
check('requiring the disk does not load config (no data dir side effects)', () => {
    assert.ok(!Object.keys(require.cache).some((k) => /[\\/]config\.js$/.test(k)));
});

// ── PARTITIONS ──────────────────────────────────────────────────────────
check('no company, empty, or unregistered company throws PartitionError', () => {
    const d = disk.open({ dir: tmp() });
    for (const bad of [undefined, null, '', '  ', 'acme', 'edge-yard-typo']) {
        assert.throws(() => d.for(bad), PartitionError);
    }
});
check('company names are normalised: Edge Metals == edge_metals', () => {
    const d = disk.open({ dir: tmp() });
    assert.strictEqual(d.for('Edge Metals'), d.for('edge_metals'));
});
check('Edge Yard and Edge Metals never see each other (facts, links, log, query)', () => {
    const d = disk.open({ dir: tmp(), clock });
    const em = d.for('edge_metals'), ey = d.for('edge_yard');
    em.facts.put({ scopeType: 'customer', scopeId: 'rad-metal', name: 'terms', value: 'always pays', ...M });
    ey.facts.put({ scopeType: 'customer', scopeId: 'rad-metal', name: 'terms', value: 'net 10', ...M });
    em.links.add({ from: { type: 'container', id: 'c1' }, rel: 'for', to: { type: 'customer', id: 'rad-metal' }, by: 'x', role: 'system' });
    em.log.outcome(em.log.event({ decisionType: 'x', key: 'k' }), 'approved');
    assert.strictEqual(em.facts.get('customer', 'rad-metal', 'terms').value, 'always pays');
    assert.strictEqual(ey.facts.get('customer', 'rad-metal', 'terms').value, 'net 10');
    assert.strictEqual(ey.links.neighbors({ type: 'container', id: 'c1' }).length, 0);
    assert.strictEqual(ey.log.stats('k').total, 0);
    const q = ey.query({ about: [{ type: 'customer', id: 'rad-metal' }] });
    assert.ok(q.facts.exact.every((f) => f.value !== 'always pays'));
});
check('companies live in separate directories', () => {
    const dir = tmp(); const d = disk.open({ dir });
    d.for('edge_metals').facts.put({ name: 'a', value: 1, ...M });
    d.for('edge_yard').facts.put({ name: 'b', value: 2, ...M });
    assert.ok(fs.existsSync(path.join(dir, 'edge_metals', 'facts.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, 'edge_yard', 'facts.jsonl')));
    assert.ok(!fs.readFileSync(path.join(dir, 'edge_metals', 'facts.jsonl'), 'utf8').includes('"b"'));
});
check('a future tenant needs registering before it exists', () => {
    const d = disk.open({ dir: tmp(), companies: ['edge_metals', 'zimex'] });
    assert.doesNotThrow(() => d.for('zimex'));
    assert.throws(() => d.for('edge_yard'), PartitionError);
});

// ── FACTS ───────────────────────────────────────────────────────────────
check('manager/team can teach', () => {
    const p = disk.open({ dir: tmp() }).for('edge_metals');
    assert.strictEqual(p.facts.put({ name: 'tone', value: 'professional', ...M }).ok, true);
    assert.strictEqual(p.facts.put({ name: 'x', value: 1, by: 'joey', role: 'team' }).ok, true);
});
check('supplier / trucker / customer / jarvis / missing role can NEVER teach', () => {
    const p = disk.open({ dir: tmp() }).for('edge_metals');
    for (const role of ['supplier', 'trucker', 'customer', 'jarvis', 'system', '', undefined, null]) {
        assert.strictEqual(p.facts.put({ name: 'evil', value: 'x', by: 'someone', role }).ok, false, `role ${role}`);
    }
    assert.strictEqual(p.facts.get('global', '', 'evil'), null);
});
check('a correction replaces: one live value, history kept (5100 -> 5200)', () => {
    const p = disk.open({ dir: tmp() }).for('edge_metals');
    p.facts.put({ scopeType: 'carrier', scopeId: 'ntg', name: 'bill_account', value: 5100, ...M });
    const r = p.facts.put({ scopeType: 'carrier', scopeId: 'ntg', name: 'bill_account', value: 5200, ...M });
    assert.ok(r.replaced);
    assert.strictEqual(p.facts.get('carrier', 'ntg', 'bill_account').value, 5200);
    assert.strictEqual(p.facts.list('carrier', 'ntg').length, 1);
    assert.deepStrictEqual(p.facts.history('carrier', 'ntg', 'bill_account').map((h) => h.value), [5100, 5200]);
});
check('everything survives close and reopen (replay)', () => {
    const dir = tmp();
    let p = disk.open({ dir }).for('edge_metals');
    p.facts.put({ scopeType: 'carrier', scopeId: 'ntg', name: 'bill_account', value: 5100, ...M });
    p.facts.put({ scopeType: 'carrier', scopeId: 'ntg', name: 'bill_account', value: 5200, ...M });
    p.facts.addAlias({ alias: 'N.T.G.', scopeType: 'carrier', scopeId: 'ntg', ...M });
    p = disk.open({ dir }).for('edge_metals');
    assert.strictEqual(p.facts.get('carrier', 'ntg', 'bill_account').value, 5200);
    assert.strictEqual(p.facts.history('carrier', 'ntg', 'bill_account').length, 2);
    assert.strictEqual(p.facts.resolve('bill from N.T.G. today').entities.length, 1);
    const id = p.facts.put({ name: 'later', value: 1, ...M }).id;
    assert.ok(id > 2, 'ids keep climbing after reopen');
});
check('forget hides it from recall but the history is kept', () => {
    const p = disk.open({ dir: tmp() }).for('edge_metals');
    const { id } = p.facts.put({ scopeType: 'customer', scopeId: 'rad-metal', name: 'terms', value: 'always pays', ...M });
    assert.strictEqual(p.facts.forget(id, { by: 'apsara', role: 'supplier' }), false);   // not allowed
    assert.strictEqual(p.facts.forget(id, M), true);
    assert.strictEqual(p.facts.get('customer', 'rad-metal', 'terms'), null);
    assert.strictEqual(p.facts.history('customer', 'rad-metal', 'terms').length, 1);
    assert.strictEqual(p.facts.put({ scopeType: 'customer', scopeId: 'rad-metal', name: 'terms', value: 'net 30', ...M }).ok, true);
});
check('all() lists every live fact, and only live ones, oldest first', () => {
    const p = disk.open({ dir: tmp() }).for('edge_metals');
    const one = p.facts.put({ name: 'one', value: 1, ...M }).id;
    p.facts.put({ scopeType: 'customer', scopeId: 'rad-metal', name: 'two', value: 2, ...M });
    p.facts.put({ name: 'one', value: 11, ...M });                      // replaces
    const gone = p.facts.put({ name: 'three', value: 3, ...M }).id;
    p.facts.forget(gone, M);
    const all = p.facts.all();
    assert.deepStrictEqual(all.map((f) => `${f.name}=${f.value}`), ['two=2', 'one=11']);
    assert.ok(!all.some((f) => f.id === one || f.id === gone));
});
check('forget survives reopen (a forgotten fact does not come back)', () => {
    const dir = tmp();
    let p = disk.open({ dir }).for('edge_metals');
    const { id } = p.facts.put({ name: 'secret_rule', value: 'x', ...M });
    p.facts.forget(id, M);
    p = disk.open({ dir }).for('edge_metals');
    assert.strictEqual(p.facts.get('global', '', 'secret_rule'), null);
});
check('names are case/space-insensitive: "Rad Metal" == rad-metal', () => {
    const p = disk.open({ dir: tmp() }).for('edge_metals');
    p.facts.put({ scopeType: 'Customer', scopeId: 'Rad Metal', name: 'Payment Terms', value: 'x', ...M });
    assert.strictEqual(p.facts.get('customer', 'rad-metal', 'payment_terms').value, 'x');
});
check('bad input never throws and writes nothing', () => {
    const p = disk.open({ dir: tmp() }).for('edge_metals');
    assert.doesNotThrow(() => p.facts.put());
    assert.doesNotThrow(() => p.facts.put(null));
    assert.strictEqual(p.facts.put({ name: 'x', ...M }).ok, false);                        // no value
    assert.strictEqual(p.facts.put({ scopeType: 'customer', name: 'x', value: 1, ...M }).ok, false);  // scoped but no id
    assert.strictEqual(p.facts.forget(999, M), false);
    assert.doesNotThrow(() => { p.facts.forget(1, null); p.facts.addAlias(null); p.facts.search('x y', null); p.query(null); p.links.neighbors(null, null); p.links.add(); p.links.remove(null); p.log.event(); });
    assert.strictEqual(p.facts.recall([null, {}, { type: 'x' }]).length, 0);
});
check('a torn last line and an unparseable line are survived, and the next write recovers', () => {
    const dir = tmp();
    let p = disk.open({ dir }).for('edge_metals');
    p.facts.put({ name: 'good_one', value: 1, ...M });
    const file = path.join(dir, 'edge_metals', 'facts.jsonl');
    fs.appendFileSync(file, 'this is not json\n{"t":"put","id":99,"scopeType":"global","scopeI');   // torn, no newline
    p = disk.open({ dir }).for('edge_metals');
    assert.strictEqual(p.health().badLines.facts, 2);
    assert.strictEqual(p.facts.get('global', '', 'good_one').value, 1);
    assert.strictEqual(p.facts.put({ name: 'after_crash', value: 2, ...M }).ok, true);
    p = disk.open({ dir }).for('edge_metals');
    assert.strictEqual(p.facts.get('global', '', 'after_crash').value, 2, 'the write after a torn line must not be glued to it');
    assert.strictEqual(p.facts.get('global', '', 'good_one').value, 1);
});

// ── ALIASES + NAME RESOLUTION ───────────────────────────────────────────
check('alias maps another spelling to the same thing; suppliers cannot add one', () => {
    const p = disk.open({ dir: tmp() }).for('edge_metals');
    p.facts.put({ scopeType: 'customer', scopeId: 'rad-metal', name: 'terms', value: 'x', ...M });
    assert.strictEqual(p.facts.addAlias({ alias: 'Rad Metals Inc', scopeType: 'customer', scopeId: 'rad-metal', ...M }), true);
    assert.strictEqual(p.facts.addAlias({ alias: 'evil', scopeType: 'customer', scopeId: 'rad-metal', by: 'b', role: 'supplier' }), false);
    const r = p.facts.resolve('Invoice question from RAD METALS INC about container 4');
    assert.deepStrictEqual(r.entities, [{ type: 'customer', id: 'rad-metal' }]);
    assert.strictEqual(p.facts.resolve('mail from evil').entities.length, 0);
});
check('an ambiguous alias is reported and never guessed', () => {
    const p = disk.open({ dir: tmp() }).for('edge_metals');
    p.facts.addAlias({ alias: 'rad', scopeType: 'customer', scopeId: 'rad-metal', ...M });
    p.facts.addAlias({ alias: 'rad', scopeType: 'customer', scopeId: 'rad-steel', ...M });
    const r = p.facts.resolve('payment from rad');
    assert.strictEqual(r.entities.length, 0);
    assert.strictEqual(r.ambiguous.length, 1);
});
check('1-2 letter ids never match ordinary words; partial words do not match', () => {
    const p = disk.open({ dir: tmp() }).for('edge_metals');
    p.facts.put({ scopeType: 'customer', scopeId: 'a', name: 't', value: 1, ...M });
    p.facts.put({ scopeType: 'carrier', scopeId: 'ntg', name: 't', value: 1, ...M });
    assert.strictEqual(p.facts.resolve('send a bill to the office').entities.length, 0);
    assert.strictEqual(p.facts.resolve('mail from NTG about it').entities.length, 1);
    assert.strictEqual(p.facts.resolve('the ntgx company').entities.length, 0);
});

// ── SEARCH (meaning, no names needed) ───────────────────────────────────
check('a lesson with no names in it is found by what it says', () => {
    const p = disk.open({ dir: tmp() }).for('edge_metals');
    p.facts.put({ scopeType: 'task', scopeId: 'booking-requests', name: 'accounting', value: 'booking requests from Accounting are not mine, do not surface them', ...M });
    const r = p.facts.search('Accounting team sent a booking request for next week');
    assert.ok(r.length === 1 && r[0].name === 'accounting' && r[0].basis === 'related');
});
check('stemming: reminder finds reminders; bookings finds booking', () => {
    const p = disk.open({ dir: tmp() }).for('edge_metals');
    p.facts.put({ scopeType: 'customer', scopeId: 'lc-co', name: 'followups', value: 'LC customers get no payment reminders', ...M });
    assert.ok(p.facts.search('send payment reminder to LC customer').length === 1);
});
check('one stray shared word is not a match; an unrelated question finds nothing', () => {
    const p = disk.open({ dir: tmp() }).for('edge_metals');
    p.facts.put({ name: 'lc', value: 'LC customers get no payment reminders', ...M });
    assert.deepStrictEqual(p.facts.search('payment helicopter'), []);
    assert.deepStrictEqual(p.facts.search('weather forecast tomorrow in Tuticorin'), []);
    assert.deepStrictEqual(p.facts.search(''), []);
    assert.deepStrictEqual(p.facts.search('the and of'), []);
});
check('superseded and forgotten facts are never searchable', () => {
    const p = disk.open({ dir: tmp() }).for('edge_metals');
    p.facts.put({ scopeType: 'carrier', scopeId: 'ntg', name: 'acct', value: 'bills go to account 5100', ...M });
    p.facts.put({ scopeType: 'carrier', scopeId: 'ntg', name: 'acct', value: 'bills go to account 5200', ...M });
    const r = p.facts.search('which account do ntg bills go to');
    assert.ok(r.length === 1 && /5200/.test(r[0].value));
    p.facts.forget(r[0].id, M);
    assert.deepStrictEqual(p.facts.search('which account do ntg bills go to'), []);
});

// ── LOG ─────────────────────────────────────────────────────────────────
check('decisions and outcomes record; closed vocabulary; unknown event refused', () => {
    const l = disk.open({ dir: tmp() }).for('edge_metals').log;
    const id = l.event({ decisionType: 'email', key: 'ignore_email', risk: 'low', confidence: 0.9, chatId: 'c1' });
    assert.ok(id > 0);
    assert.strictEqual(l.outcome(id, 'maybe'), false);
    assert.strictEqual(l.outcome(9999, 'approved'), false);
    assert.strictEqual(l.outcome(id, 'approved'), true);
    assert.strictEqual(l.event({}), null);
    assert.strictEqual(l.event(null), null);
});
check('streak resets on a rejection/correction; expired and superseded are not evidence', () => {
    const l = disk.open({ dir: tmp() }).for('edge_metals').log;
    for (const o of ['approved', 'approved', 'expired', 'approved', 'corrected', 'approved', 'approved', 'superseded']) {
        l.outcome(l.event({ decisionType: 'x', key: 'pay_reminder' }), o);
    }
    assert.deepStrictEqual(l.stats('pay_reminder'), { total: 6, approved: 5, streak: 2, last: 'approved' });
    assert.deepStrictEqual(l.stats('nope'), { total: 0, approved: 0, streak: 0, last: null });
});
check('the log survives reopen and keeps counting', () => {
    const dir = tmp();
    let p = disk.open({ dir }).for('edge_metals');
    p.log.outcome(p.log.event({ decisionType: 'x', key: 'k' }), 'approved');
    p = disk.open({ dir }).for('edge_metals');
    assert.strictEqual(p.log.stats('k').total, 1);
    const id2 = p.log.event({ decisionType: 'x', key: 'k' });
    assert.ok(id2 > 1);
    assert.strictEqual(p.log.outcome(id2, 'rejected'), true);
    assert.strictEqual(p.log.stats('k').streak, 0);
});
check('the log is append-only: no API edits or removes a row', () => {
    const l = disk.open({ dir: tmp() }).for('edge_metals').log;
    for (const m of ['update', 'delete', 'remove', 'edit', 'set', 'clear']) assert.strictEqual(l[m], undefined, m);
});

// ── LINKS (the graph) ───────────────────────────────────────────────────
const C = { type: 'container', id: 'abcu1234567' }, B = { type: 'booking', id: 'bk-1' }, K = { type: 'customer', id: 'rad-metal' };
check('only manager/team/system may write links; a supplier cannot', () => {
    const k = disk.open({ dir: tmp() }).for('edge_metals').links;
    assert.strictEqual(k.add({ from: C, rel: 'on', to: B, by: 'x', role: 'supplier' }).ok, false);
    assert.strictEqual(k.add({ from: C, rel: 'on', to: B, by: 'x', role: 'trucker' }).ok, false);
    assert.strictEqual(k.add({ from: C, rel: 'on', to: B, by: 'jarvis', role: 'system' }).ok, true);
    assert.strictEqual(k.add({ from: C, rel: '', to: B, by: 'x', role: 'system' }).ok, false);
});
check('traversal follows connections, by depth, with the path that got there', () => {
    const k = disk.open({ dir: tmp() }).for('edge_metals').links;
    k.add({ from: C, rel: 'on', to: B, by: 'j', role: 'system' });
    k.add({ from: B, rel: 'for', to: K, by: 'j', role: 'system' });
    const d2 = k.neighbors(C, { depth: 2 });
    assert.deepStrictEqual(d2.map((n) => `${n.node.type}:${n.node.id}`).sort(), ['booking:bk-1', 'customer:rad-metal']);
    assert.ok(d2.find((n) => n.node.type === 'customer').via.length === 2);
    assert.strictEqual(k.neighbors(C, { depth: 1 }).length, 1);
    assert.strictEqual(k.neighbors(K, { depth: 2 }).length, 2, 'works backwards too');
});
check('duplicate add is idempotent; unlink removes; both survive reopen', () => {
    const dir = tmp();
    let p = disk.open({ dir }).for('edge_metals');
    p.links.add({ from: C, rel: 'on', to: B, by: 'j', role: 'system' });
    assert.strictEqual(p.links.add({ from: C, rel: 'on', to: B, by: 'j', role: 'system' }).existed, true);
    p = disk.open({ dir }).for('edge_metals');
    assert.strictEqual(p.links.neighbors(C).length, 1);
    p.links.remove({ from: C, rel: 'on', to: B, by: 'j', role: 'system' });
    p = disk.open({ dir }).for('edge_metals');
    assert.strictEqual(p.links.neighbors(C).length, 0);
});
check('a cycle does not loop forever, and the result is capped', () => {
    const k = disk.open({ dir: tmp() }).for('edge_metals').links;
    const n = (i) => ({ type: 'node', id: `n${i}` });
    for (let i = 0; i < 80; i++) k.add({ from: n(i), rel: 'next', to: n((i + 1) % 80), by: 'j', role: 'system' });
    assert.ok(k.neighbors(n(0), { depth: 5, max: 20 }).length <= 20);
    assert.ok(k.neighbors(n(0), { depth: 100 }).length <= 50);
});

// ── QUERY: the whole point ──────────────────────────────────────────────
check('QUERY: a container finds its customer\'s terms through the graph, and says how', () => {
    const p = disk.open({ dir: tmp() }).for('edge_metals');
    p.facts.put({ scopeType: 'customer', scopeId: 'rad-metal', name: 'payment_terms', value: 'ETA minus 7 days', ...M });
    p.links.add({ from: C, rel: 'on', to: B, by: 'j', role: 'system' });
    p.links.add({ from: B, rel: 'for', to: K, by: 'j', role: 'system' });
    const withGraph = p.query({ about: [C], include: { links: { depth: 2 } } });
    const hit = withGraph.facts.exact.find((f) => f.name === 'payment_terms');
    assert.ok(hit && hit.basis === 'exact' && /container:abcu1234567/.test(hit.via));
    assert.ok(/ETA minus 7 days/.test(withGraph.brief) && /via /.test(withGraph.brief));
    const without = p.query({ about: [C] });
    assert.ok(!without.facts.exact.some((f) => f.name === 'payment_terms'), 'no link followed => not returned');
});
check('QUERY: names in free text are resolved; meaning-matches are labelled apart and never "exact"', () => {
    const p = disk.open({ dir: tmp() }).for('edge_metals');
    p.facts.put({ scopeType: 'customer', scopeId: 'rad-metal', name: 'followups', value: 'always pays, no payment reminders', ...M });
    p.facts.put({ name: 'tone', value: 'professional one line', ...M });
    p.facts.put({ scopeType: 'task', scopeId: 'accounting-mail', name: 'rule', value: 'accounting booking requests are not mine', ...M });
    const q = p.query({ text: 'Rad Metal wants a payment reminder; Accounting sent a booking request' });
    assert.ok(q.facts.exact.some((f) => f.name === 'followups'));
    assert.ok(q.facts.exact.some((f) => f.name === 'tone'), 'global rules always apply');
    assert.ok(q.facts.related.some((f) => f.name === 'rule'));
    assert.ok(q.facts.related.every((f) => f.basis === 'related'));
    assert.ok(!q.facts.related.some((f) => q.facts.exact.some((e) => e.id === f.id)), 'never listed twice');
    assert.ok(/possibly relevant, not exact/.test(q.brief));
});
check('QUERY: log section and read-only adapters; a broken adapter never takes the query down', () => {
    const d = disk.open({ dir: tmp() });
    const p = d.for('edge_metals');
    p.log.outcome(p.log.event({ decisionType: 'x', key: 'pay_reminder' }), 'approved');
    d.registerAdapter('trust', (company, action, who) => ({ company, action, who, streak: 7 }));
    d.registerAdapter('broken', () => { throw new Error('ledger missing'); });
    const q = p.query({ include: { log: { key: 'pay_reminder' }, adapters: { trust: ['forward', 'bose'], broken: [] } } });
    assert.strictEqual(q.log.stats.approved, 1);
    assert.deepStrictEqual(q.adapters.trust, { company: 'edge_metals', action: 'forward', who: 'bose', streak: 7 });
    assert.ok(q.adapters.broken.error);
    assert.strictEqual(typeof d.registerAdapter, 'function');
    assert.strictEqual(p.adapters, undefined);
    assert.throws(() => p.read('nope'), /no adapter/);
});
check('QUERY: adapters are handed the company, so they can keep the companies apart', () => {
    const d = disk.open({ dir: tmp() });
    d.registerAdapter('whoami', (company) => company);
    assert.strictEqual(d.for('edge_yard').read('whoami'), 'edge_yard');
    assert.strictEqual(d.for('edge_metals').read('whoami'), 'edge_metals');
});
check('QUERY: empty and hostile input never throws', () => {
    const p = disk.open({ dir: tmp() }).for('edge_metals');
    assert.doesNotThrow(() => p.query());
    assert.doesNotThrow(() => p.query({}));
    assert.doesNotThrow(() => p.query({ about: [null, {}, { type: 'x' }], text: '"; DROP TABLE facts; --' }));
    assert.doesNotThrow(() => p.query({ text: '\u0000￿ <script>' }));
});

// ── BACKUP ──────────────────────────────────────────────────────────────
check('snapshot writes backup.json that the REAL backup walker collects (and .jsonl alone would not be)', () => {
    const dir = tmp();
    const p = disk.open({ dir }).for('edge_metals');
    p.facts.put({ name: 'rule_one', value: 'x', ...M });
    p.log.outcome(p.log.event({ decisionType: 'x', key: 'k' }), 'approved');
    p.snapshot();
    const { collectStores } = require('../helpers/backup');
    const { stores, problems } = collectStores(dir);
    assert.deepStrictEqual(problems, []);
    assert.deepStrictEqual(Object.keys(stores), ['edge_metals/backup.json'], 'only backup.json is collected; the .jsonl layers are skipped');
    assert.ok(stores['edge_metals/backup.json'].facts.length === 1);
});
check('restore rebuilds an empty partition from a snapshot, exactly', () => {
    const dirA = tmp(), dirB = tmp();
    const a = disk.open({ dir: dirA }).for('edge_metals');
    a.facts.put({ scopeType: 'carrier', scopeId: 'ntg', name: 'acct', value: 5100, ...M });
    a.facts.put({ scopeType: 'carrier', scopeId: 'ntg', name: 'acct', value: 5200, ...M });
    a.facts.addAlias({ alias: 'NTG Freight', scopeType: 'carrier', scopeId: 'ntg', ...M });
    a.links.add({ from: C, rel: 'on', to: B, by: 'j', role: 'system' });
    a.log.outcome(a.log.event({ decisionType: 'x', key: 'k' }), 'approved');
    const snap = JSON.parse(fs.readFileSync(a.snapshot().file, 'utf8'));
    const b = disk.open({ dir: dirB }).for('edge_metals');
    b.restore(snap);
    assert.strictEqual(b.facts.get('carrier', 'ntg', 'acct').value, 5200);
    assert.strictEqual(b.facts.history('carrier', 'ntg', 'acct').length, 2);
    assert.strictEqual(b.facts.resolve('bill from NTG Freight').entities.length, 1);
    assert.strictEqual(b.links.neighbors(C).length, 1);
    assert.strictEqual(b.log.stats('k').approved, 1);
});
check('restore refuses a non-empty partition and a snapshot from another company', () => {
    const d = disk.open({ dir: tmp() });
    const em = d.for('edge_metals');
    em.facts.put({ name: 'x', value: 1, ...M });
    const snap = JSON.parse(fs.readFileSync(em.snapshot().file, 'utf8'));
    assert.throws(() => em.restore(snap), /not empty/);
    assert.throws(() => d.for('edge_yard').restore(snap), /not for this company/);
    assert.throws(() => em.restore(null));
});

// ── SCALE: her volume is tens of decisions a day; prove 100x of it is still instant ──
check('5,000 facts + 20,000 log rows reload in under 3s and still answer', () => {
    const dir = tmp();
    let p = disk.open({ dir }).for('edge_metals');
    for (let i = 0; i < 5000; i++) p.facts.put({ scopeType: 'customer', scopeId: `cust-${i % 500}`, name: `rule_${i}`, value: `terms number ${i} payment reminder`, ...M });
    for (let i = 0; i < 20000; i++) { const id = p.log.event({ decisionType: 'x', key: `k${i % 50}` }); p.log.outcome(id, 'approved'); }
    const t0 = Date.now();
    p = disk.open({ dir }).for('edge_metals');
    assert.ok(Date.now() - t0 < 3000, `reload took ${Date.now() - t0}ms`);
    assert.ok(p.query({ text: 'payment reminder for cust 7' }).facts.related.length > 0);
    assert.ok(p.log.stats('k3').total === 400);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED: ' + failures.join(', ')); process.exit(1); }
