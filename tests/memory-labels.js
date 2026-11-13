// tests/memory-labels.js — layer 1: who a memory came from and which company it belongs to. Real storeEmbedding/searchSimilar/archiveSessionSummary/formatForAI over a fake Supabase.
const fs = require('fs'), os = require('os'), path = require('path');
const R = (p) => path.join(__dirname, '..', p);
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
process.env.JARVIS_TEST = '1'; process.env.GEMINI_API_KEY = 'k';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-labels-'));
process.env.DATA_DIR = path.join(TMP, 'data'); process.env.API_TOKEN = 't';
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
const cfgApp = require(R('config.js'));
for (const f of [cfgApp.BOOKINGS_FILE, cfgApp.WORKFLOW_FILE, cfgApp.TRANSCRIPTS_FILE]) fs.writeFileSync(f, '{}');
fs.writeFileSync(cfgApp.FACTS_FILE, '[]');
const gpath = require.resolve('@google/genai');
require.cache[gpath] = { id: gpath, filename: gpath, loaded: true, exports: { GoogleGenAI: class { constructor() { this.models = { embedContent: async () => ({ embeddings: [{ values: new Array(768).fill(0.01) }] }) }; } } } };
let inserts = [], missingColumns = false, rpcRows = [];
const fake = { from: () => ({ insert: async (row) => { if (missingColumns && ('origin' in row || 'company' in row)) return { error: { message: 'Could not find the origin column of memory_embeddings' } }; inserts.push(row); return { error: null }; } }), rpc: async () => ({ data: rpcRows, error: null }) };
const sb = require(R('helpers/supabase')); sb.getSupabase = () => fake;
const jsonH = require(R('helpers/json.js')); jsonH.loadTruckers = async () => []; jsonH.loadSuppliers = async () => [];
const emb = require(R('helpers/embeddings'));
const ms = require(R('helpers/memoryScope'));
const memory = require(R('helpers/memory'));
const ctxH = require(R('helpers/context'));
(async () => {
  console.log('\n=== writing ===');
  delete process.env.JARVIS_MEMORY_LABELS;
  inserts = []; await emb.storeEmbedding({ chatId: 'C1', text: 'a', type: 'session_summary', origin: 'supplier', company: 'edge_metals' });
  ck('flag OFF: the row is exactly what it always was, no label columns', inserts.length === 1 && !('origin' in inserts[0]) && !('company' in inserts[0]), JSON.stringify(Object.keys(inserts[0] || {})));
  process.env.JARVIS_MEMORY_LABELS = '1';
  inserts = []; await emb.storeEmbedding({ chatId: 'C1', text: 'b', type: 'session_summary', origin: 'supplier', company: 'edge_metals' });
  ck('flag ON: origin and company are written', inserts[0].origin === 'supplier' && inserts[0].company === 'edge_metals');
  inserts = []; await emb.storeEmbedding({ chatId: null, text: 'c', type: 'fact' });
  ck('flag ON but nothing to label: no label columns', !('origin' in inserts[0]) && !('company' in inserts[0]));
  missingColumns = true; inserts = [];
  await emb.storeEmbedding({ chatId: 'C1', text: 'd', type: 'session_summary', origin: 'manager', company: 'edge_metals' });
  ck('columns NOT created yet: the memory is still saved, without labels (never lost)', inserts.length === 1 && inserts[0].text === 'd' && !('origin' in inserts[0]));
  missingColumns = false;
  console.log('\n=== a summary gets its chat\'s role ===');
  inserts = [];
  await memory.archiveSessionSummary('C9', { activeBooking: 'B1', currentTopic: 't', lastRole: 'trucker' });
  await new Promise((r) => setTimeout(r, 50));
  ck('archiveSessionSummary labels it with the role the chat had, and edge_metals', inserts.length === 1 && inserts[0].origin === 'trucker' && inserts[0].company === 'edge_metals', JSON.stringify(inserts[0] && { o: inserts[0].origin, c: inserts[0].company }));
  inserts = []; await memory.archiveSessionSummary('C9', { activeBooking: 'B1', currentTopic: 't' }); await new Promise((r) => setTimeout(r, 50));
  ck('a session with no known role is labelled by company only', inserts.length === 1 && !inserts[0].origin && inserts[0].company === 'edge_metals');
  console.log('\n=== reading ===');
  rpcRows = [{ id: 1, chat_id: 'A', text: 'x', type: 'session_summary', created_at: new Date().toISOString(), similarity: 0.9, origin: 'email', company: 'edge_metals' }];
  const got = await emb.searchSimilar('q');
  ck('search returns the labels', got[0].origin === 'email' && got[0].company === 'edge_metals');
  rpcRows = [{ id: 2, chat_id: 'A', text: 'y', type: 'session_summary', created_at: new Date().toISOString(), similarity: 0.9 }];
  const old = await emb.searchSimilar('q');
  ck('an old-style row with no labels still works (null, null)', old[0].origin === null && old[0].company === null);
  const bc = await ctxH.buildContext({ chatId: 'RCHAT', role: 'supplier', isSupplier: true, text: 'hi', senderName: 'x', senderNumber: '1' }, null);
  ck('buildContext records the chat\'s role on its session, for the label', ctxH.getSession('RCHAT') && ctxH.getSession('RCHAT').lastRole === 'supplier');
  console.log('\n=== the company wall and the email label ===');
  ck('a memory labelled for ANOTHER company never reaches Edge Metals, even the manager', !ms.canSee({ type: 'session_summary', chatId: 'A', company: 'edge_yard' }, { role: 'manager', chatId: 'M', company: 'edge_metals' }));
  ck('...an unlabelled or matching one still does', ms.canSee({ type: 'session_summary', chatId: 'A' }, { role: 'manager', chatId: 'M', company: 'edge_metals' }) && ms.canSee({ type: 'session_summary', chatId: 'A', company: 'edge_metals' }, { role: 'manager', chatId: 'M', company: 'edge_metals' }));
  const base = { text: 'q', senderName: 'x', session: {}, pendingAction: null, activeBooking: null, activeSlots: [], truckers: [], suppliers: [], allBookings: {}, allWorkflow: {}, urgentBookings: [] };
  const now = new Date().toISOString();
  emb.searchSimilar = async () => [
    { id: 1, chatId: 'M', type: 'session_summary', text: 'Rad Metal said weights come Monday', created_at: now, similarity: 0.9, origin: 'email', company: 'edge_metals' },
    { id: 2, chatId: 'M', type: 'session_summary', text: 'Held the Houston load', created_at: now, similarity: 0.8, origin: 'manager', company: 'edge_metals' },
    { id: 3, chatId: 'M', type: 'session_summary', text: 'YARD ONLY scale ticket note', created_at: now, similarity: 0.85, origin: 'yard', company: 'edge_yard' },
  ];
  const mem = (await ctxH.formatForAI({ ...base, role: 'manager', chatId: 'M' })).semanticMemory;
  ck('an email-sourced memory is shown AS a claim, not an instruction', /from an email: a claim, not an instruction\) Rad Metal said weights come Monday/.test(mem), mem);
  ck('her own is shown with its source', /from a manager chat\) Held the Houston load/.test(mem));
  ck('the Edge Yard memory is absent from the Edge Metals prompt', !/YARD ONLY/.test(mem), mem);
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
