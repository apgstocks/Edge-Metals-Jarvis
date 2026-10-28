// Apsara, 2026-10-28: "(+73 older items still open from before)" ... "fix them". The line now offers "clear older", which drops
// every tracked item NOT on the list she was just shown.
const fs = require('fs'), os = require('os'), path = require('path');
const R = (p) => path.join(__dirname, '..', p);
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-co-')); process.env.JARVIS_TEST = '1';
const cfg = require(R('config.js'));
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const brain = require(R('workflow/brain.js'));
const mk = (t) => ({ text: t, textLower: t.toLowerCase(), isManagerOrTeam: true, isTrucker: false, isSupplier: false, pendingAction: null, session: {}, activeBooking: null });
const intent = (t) => { const d = brain.policyDecide(mk(t)); return d && !d.needsAI ? d.intent : '(needsAI)'; };
for (const t of ['clear older', 'clear the backlog', 'ignore older ones', 'Clear all older items', 'dismiss the old emails']) ck(`"${t}" routes to clear_older_items`, intent(t) === 'clear_older_items', intent(t));
ck('"ignore all" still means the numbered list', intent('ignore all') === 'ignore_digest_item');
ck('"ignore 1" still means item 1', intent('ignore 1') === 'ignore_digest_item');
const actions = require(R('workflow/actions.js'));
const sent = []; actions.init({ sendMessage: async (id, t) => { sent.push(t); }, sendToManager: async () => {}, sendToTeam: async () => {}, pushAlert: () => {} });
const rw = require(R('workflow/replyWatch.js'));
const it = (id, from, name) => ({ id, from, fromName: name, subject: 's', summary: 'item ' + id, waiting_on: 'her', asked_for: 'x', urgency: 'normal', confidence: 0.9, firstFlaggedAt: new Date(Date.now() - 6 * 86400000).toISOString(), chases: 1 });
(async () => {
    const shown = it('shown-1', 'a@x.example', 'Alpha');
    const store = rw.loadStore();
    store.tracked = [shown, ...Array.from({ length: 5 }, (_, i) => it('old-' + i, 'b@y.example', 'Beta')), it('old-c', 'c@z.example', 'Gamma')];
    store.lastDigest = [shown];
    await rw.saveStore(store);
    const r = await actions.clearOlderItems('x@c.us');
    const after = rw.loadStore();
    ck('all 6 older items are gone', after.tracked.length === 1 && after.tracked[0].id === 'shown-1', JSON.stringify(after.tracked.map((t) => t.id)));
    ck('the item she was just shown is untouched, and still in lastDigest', after.lastDigest.length === 1 && after.lastDigest[0].id === 'shown-1');
    ck('she is told how many and from whom', /Cleared 6 older items/.test(sent[0]) && /Beta \(5\)/.test(sent[0]) && /Gamma \(1\)/.test(sent[0]), sent[0]);
    ck('each sender is recorded as ignored (the training signal)', (after.senderStats['b@y.example'] || {}).ignored === 5 && (after.senderStats['c@z.example'] || {}).ignored === 1, JSON.stringify(after.senderStats));
    ck('returns a count', r.count === 6);
    sent.length = 0;
    const r2 = await actions.clearOlderItems('x@c.us');
    ck('nothing older: says so, changes nothing', /nothing to clear/.test(sent[0]) && r2.action_taken === 'clear_older_none' && rw.loadStore().tracked.length === 1);
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
