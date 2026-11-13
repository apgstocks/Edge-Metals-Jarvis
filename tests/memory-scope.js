// tests/memory-scope.js — layer 0: another party's conversation never reaches your prompt. Real formatForAI, stubbed search results.
const fs = require('fs'), os = require('os'), path = require('path');
const R = (p) => path.join(__dirname, '..', p);
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
process.env.JARVIS_TEST = '1';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mscope-'));
process.env.DATA_DIR = path.join(TMP, 'data'); process.env.API_TOKEN = 't';
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
const cfgApp = require(R('config.js'));
for (const f of [cfgApp.BOOKINGS_FILE, cfgApp.WORKFLOW_FILE, cfgApp.TRANSCRIPTS_FILE]) fs.writeFileSync(f, '{}');
fs.writeFileSync(cfgApp.FACTS_FILE, '[]');
const ms = require(R('helpers/memoryScope'));
const emb = require(R('helpers/embeddings'));
const d = (n) => new Date(Date.now() - n * 86400000).toISOString();
const ROWS = [
  { id: 1, chatId: 'SUPA', type: 'session_summary', text: 'Supplier A said price 0.42 for motors', created_at: d(2), similarity: 0.9 },
  { id: 2, chatId: 'SUPB', type: 'session_summary', text: 'Supplier B said price 0.40 for motors', created_at: d(3), similarity: 0.88 },
  { id: 3, chatId: 'MGR', type: 'session_summary', text: 'Manager decided to hold the Houston load', created_at: d(1), similarity: 0.8 },
  { id: 4, chatId: null, type: 'fact', text: 'DALA numbers can have a dash', created_at: d(9), similarity: 0.7 },
  { id: 5, chatId: 'SUPA', type: 'something_new', text: 'unknown kind', created_at: d(1), similarity: 0.7 },
];
emb.searchSimilar = async () => ROWS.map((r) => ({ ...r }));
const ctxH = require(R('helpers/context'));
const base = { text: 'what price for motors', senderName: 'x', session: {}, pendingAction: null, activeBooking: null, activeSlots: [], truckers: [], suppliers: [], allBookings: {}, allWorkflow: {}, urgentBookings: [] };
const view = async (role, chatId) => (await ctxH.formatForAI({ ...base, role, chatId })).semanticMemory;
(async () => {
  console.log('\n=== the rule ===');
  ck('manager sees every chat', ROWS.every((r) => ms.canSee(r, { role: 'manager', chatId: 'MGR' })));
  ck('a supplier sees only their own chat\'s summaries', ms.canSee(ROWS[0], { role: 'supplier', chatId: 'SUPA' }) && !ms.canSee(ROWS[1], { role: 'supplier', chatId: 'SUPA' }) && !ms.canSee(ROWS[2], { role: 'supplier', chatId: 'SUPA' }));
  ck('business facts pass for every role, unchanged', ms.canSee(ROWS[3], { role: 'trucker', chatId: 'T' }));
  ck('an unknown kind of memory is withheld from non-managers (fail closed)', !ms.canSee(ROWS[4], { role: 'supplier', chatId: 'SUPA' }) && ms.canSee(ROWS[4], { role: 'manager' }));
  ck('no chat id on either side: nothing is shown', !ms.canSee({ type: 'session_summary', chatId: null }, { role: 'supplier', chatId: null }) && !ms.canSee({ type: 'session_summary', chatId: 'X' }, { role: 'supplier' }) && !ms.canSee(null, { role: 'supplier' }));
  ck('filter never mutates its input', (() => { const c = ROWS.slice(); ms.filter(ROWS, { role: 'supplier', chatId: 'SUPA' }); return c.every((r, i) => r === ROWS[i]); })());
  console.log('\n=== through the real prompt builder ===');
  const mgr = await view('manager', 'MGR');
  ck('manager prompt recalls the supplier chats and her own, as before', /Supplier A/.test(mgr) && /Supplier B/.test(mgr) && /Houston/.test(mgr), mgr);
  const a = await view('supplier', 'SUPA');
  ck('supplier A is shown their own past', /Supplier A said price 0.42/.test(a), a);
  ck('...and NOT supplier B\'s price or the manager\'s decision', !/Supplier B/.test(a) && !/0\.40/.test(a) && !/Houston/.test(a), a);
  const t = await view('trucker', 'TRK');
  ck('a trucker with no history of their own gets nothing from anyone else', t === '(none)', t);
  const tm = await view('team', 'TEAM');
  ck('team members get their own chat only, not the manager\'s or suppliers\'', !/Houston|Supplier/.test(tm), tm);
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
