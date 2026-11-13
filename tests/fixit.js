// Accounts "Fix it", END TO END: real server, real login, the routes the page
// calls, and the page itself in a DOM. CLAUDE.md rule 3.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { JSDOM } = require('jsdom');
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) pass++; else { fail++; console.log('FAIL', n, d ? '\n   ' + d : ''); } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fixit-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';
process.env.JARVIS_PASSWORD = 'jarvis-pw-ddddddddddd';   // the Edge Metals ledger needs the Jarvis profile (requireSuper)
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('ABORT not isolated'); process.exit(1); }
const { mutateJson } = require(path.join(ROOT, 'helpers/json'));

(async () => {
  // ── the books: what the morning email complains about ──
  await mutateJson(cfg.BILLS_FILE, [], () => [
    { id: 'BILL_A', date: '2026-09-10', supplier: 'Nur Metal', container_no: 'NOPR1111111', booking_no: 'B1', gross: 38000, truck: 20000 },   // weight, no price
    { id: 'BILL_OK', date: '2026-09-10', supplier: 'Taewon', container_no: 'OKOK2222222', booking_no: 'B2', gross: 38000, truck: 20000, supplier_price: 0.2, price_unit: 'lb' },
  ]);
  const S = (id, inv, item, t) => ({ id, date: '2026-09-12', booking_no: 'B9', container_no: 'DUPE3333333', invoice_no: inv, customer: 'Cust', item, weight: 1000, invoice_price: 1, created_at: t });
  await mutateJson(cfg.SALES_FILE, [], () => [
    S('SALE_1_old', 'INV-OLD', 'Alternator', '2026-09-12T00:00:00Z'),
    S('SALE_2_new', 'INV-NEW', 'Alternator', '2026-09-20T00:00:00Z'),
    S('SALE_2_new2', 'INV-NEW', 'Starter', '2026-09-20T00:00:00Z'),
    { ...S('SALE_3_a', 'COMBO', 'Alternator', '2026-09-12T00:00:00Z'), container_no: 'COMB4444444', booking_no: 'B8' },
    { ...S('SALE_3_b', 'COMBO', 'Starter', '2026-09-12T00:00:00Z'), container_no: 'COMB4444444', booking_no: 'B8' },
  ]);
  await mutateJson(cfg.PACKING_LISTS_FILE, [], () => [
    { id: 'PL_OLD', container_no: 'PACK5555555', rows: [], updated_at: '2026-09-01T00:00:00Z' },
    { id: 'PL_NEW', container_no: 'PACK5555555', rows: [], updated_at: '2026-09-09T00:00:00Z' },
  ]);

  const { createApi } = require(path.join(ROOT, 'api'));
  const server = await new Promise((r) => { const s = createApi().listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = {}; if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (sid) headers.Authorization = `Bearer ${sid}`;
    const r2 = http.request(base + p, { method, headers }, (res) => { let raw = ''; res.on('data', (c) => { raw += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j, raw }); }); });
    r2.on('error', reject); if (data) r2.write(data); r2.end();
  });
  const login = async (pw) => ((await req('POST', '/login', { body: { password: pw } })).json || {}).sid;
  const sid = await login(process.env.JARVIS_PASSWORD);
  ck('signed in with the Jarvis profile', !!sid);
  const adm = await req('GET', '/api/fixit', { sid: await login(process.env.ADMIN_PASSWORD) });
  ck('plain admin (no Jarvis profile) is refused — Edge Metals ledger rule', adm.status === 403, String(adm.status));

  // staff cannot see or use it
  const staff = await login(process.env.STAFF_PASSWORD);
  const sg = await req('GET', '/api/fixit', { sid: staff });
  ck('staff is refused', sg.status === 401 || sg.status === 403, String(sg.status));

  // ── perceive + diagnose + triage ──
  const first = await req('GET', '/api/fixit', { sid }); if (!first.json || !first.json.cards) console.log('GET /api/fixit ->', first.status, first.raw.slice(0, 300));
  let list = first.json;
  const by = (k) => list.cards.filter((c) => c.kind === k);
  ck('a no-amount card for the bill with a weight but no price', by('no-amount').some((c) => c.row && c.row.id === 'BILL_A'), JSON.stringify(list.cards.map((c) => c.title)));
  const noAmt = by('no-amount').find((c) => c.row && c.row.id === 'BILL_A');
  ck('it diagnoses the cause, not the symptom', noAmt && /supplier price/.test(noAmt.diagnosis), noAmt && noAmt.diagnosis);
  ck('it asks rather than guessing the amount', noAmt && noAmt.proposal.confidence === 'ask' && !!noAmt.ask);
  ck('the healthy bill has no card', !by('no-amount').some((c) => c.row && c.row.id === 'BILL_OK'));
  const dup = by('duplicate-invoice').find((c) => /DUPE3333333/.test(c.title));
  ck('repeat invoice found, with a high-confidence delete of the OLD one only',
     dup && dup.proposal.confidence === 'high' && JSON.stringify(dup.proposal.args.ids) === JSON.stringify(['SALE_1_old']), JSON.stringify(dup && dup.proposal));
  ck('a combo load (one invoice number, many lines) is NOT flagged', !by('duplicate-invoice').some((c) => /COMB4444444/.test(c.title)));
  ck('duplicate packing list found', by('duplicate-packing').some((c) => /PACK5555555/.test(c.title)));
  ck('safe fixes are listed before questions', list.cards.findIndex((c) => c.proposal.confidence === 'high') < list.cards.findIndex((c) => c.proposal.confidence === 'ask'));

  // ── ask: refuse without an answer, then apply it ──
  const noVal = await req('POST', '/api/fixit/apply', { sid, body: { id: noAmt.id } });
  ck('no answer, no change', noVal.status === 400 && /amount/i.test((noVal.json || {}).error || ''), noVal.raw);
  const set = await req('POST', '/api/fixit/apply', { sid, body: { id: noAmt.id, value: '3,600' } });
  ck('typed amount applied through the route', set.status === 200 && set.json.set === 3600, set.raw);
  const bills = JSON.parse(fs.readFileSync(cfg.BILLS_FILE, 'utf8'));
  ck('and it is on the bill, other fields untouched', bills.find((b) => b.id === 'BILL_A').supplier_invoice_amount === 3600 && bills.find((b) => b.id === 'BILL_A').container_no === 'NOPR1111111');
  list = (await req('GET', '/api/fixit', { sid })).json;
  ck('the card clears once true', !list.cards.some((c) => c.id === noAmt.id));

  // ── delete the older invoice; archived; undo ──
  const del = await req('POST', '/api/fixit/apply', { sid, body: { id: dup.id } });
  ck('older invoice deleted', del.status === 200 && del.json.removed === 1, del.raw);
  let sales = JSON.parse(fs.readFileSync(cfg.SALES_FILE, 'utf8')).map((r) => r.id).sort();
  ck('newest invoice and the combo load are untouched', JSON.stringify(sales) === JSON.stringify(['SALE_2_new', 'SALE_2_new2', 'SALE_3_a', 'SALE_3_b']), sales.join());
  const undo = await req('POST', '/api/ledger/bulk-delete/restore', { sid, body: { batch: del.json.batch } });
  ck('undo restores it', undo.status === 200 && JSON.parse(fs.readFileSync(cfg.SALES_FILE, 'utf8')).some((r) => r.id === 'SALE_1_old'), undo.raw);

  // ── a stale card cannot act ──
  const stale = await req('POST', '/api/fixit/apply', { sid, body: { id: 'deadbeef0000' } });
  ck('an unknown/stale card is refused', stale.status === 400 && /no longer true/.test((stale.json || {}).error || ''), stale.raw);

  // ── a payment on the old invoice blocks the delete (money is never orphaned) ──
  await mutateJson(cfg.SALES_RECEIPTS_FILE || path.join(TMP, 'sales_receipts.json'), [], () => [
    { id: 'RC1', customer: 'Cust', mode: 'Wire', bank: 'Chase', amount: 100, date: '2026-09-15', allocations: [{ sale_id: 'SALE_1_old', amount: 100 }] }]);
  list = (await req('GET', '/api/fixit', { sid })).json;
  const dup2 = list.cards.find((c) => c.kind === 'duplicate-invoice' && /DUPE3333333/.test(c.title));
  ck('with a payment on the old invoice the card turns into a question', dup2 && dup2.proposal.confidence === 'ask' && dup2.proposal.do === 'none', JSON.stringify(dup2 && dup2.proposal));
  const blocked = await req('POST', '/api/fixit/apply', { sid, body: { id: dup2.id } });
  ck('and applying it is refused', blocked.status === 400);
  ck('nothing was deleted', JSON.parse(fs.readFileSync(cfg.SALES_FILE, 'utf8')).some((r) => r.id === 'SALE_1_old'));

  // ── packing list ──
  const pk = list.cards.find((c) => c.kind === 'duplicate-packing');
  const pkr = await req('POST', '/api/fixit/apply', { sid, body: { id: pk.id } });
  const pls = JSON.parse(fs.readFileSync(cfg.PACKING_LISTS_FILE, 'utf8')).map((r) => r.id);
  ck('older packing list removed, newest kept, copy archived', pkr.status === 200 && JSON.stringify(pls) === '["PL_NEW"]' && fs.existsSync(path.join(TMP, 'deleted_packing_lists.json')), pkr.raw);

  // ── memory: dismiss hides it and it stays hidden ──
  const dm = list.cards.find((c) => c.id === dup2.id);
  await req('POST', '/api/fixit/dismiss', { sid, body: { id: dm.id, note: 'payment being moved' } });
  list = (await req('GET', '/api/fixit', { sid })).json;
  ck('dismissed card is hidden and counted', !list.cards.some((c) => c.id === dm.id) && list.hidden >= 1);
  const mem = JSON.parse(fs.readFileSync(path.join(TMP, 'fixit_memory.json'), 'utf8'));
  ck('memory holds the decisions and her note', mem.dismissed[dm.id].note === 'payment being moved' && mem.done.length >= 3);

  // ── the page itself ──
  const page = await req('GET', '/fixit', { sid });
  const html = fs.readFileSync(path.join(ROOT, 'dashboard', 'fixit.html'), 'utf8');
  const cards = [{ id: 'c1', kind: 'no-amount', company: 'metals', title: 'T <b>x</b>', diagnosis: 'D', evidence: ['e1'], money: 12.5,
                   ask: { label: 'Amount', hint: 'h' }, proposal: { do: 'set-bill-amount', label: 'Save', confidence: 'ask', why: 'W' } },
                 { id: 'c2', kind: 'duplicate-packing', company: 'metals', title: 'P', diagnosis: 'D', evidence: [], proposal: { do: 'delete-packing', label: 'Remove', confidence: 'high', why: 'W' }, habit: 'You have approved this kind 3 times.' }];
  const calls = [];
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: base + '/fixit', beforeParse(w) {
    w.confirm = () => true; w.prompt = () => 'later';
    w.fetch = async (p, o) => { calls.push([p, o && o.body]); return { ok: true, status: 200, json: async () => (p === '/api/fixit' ? { cards, hidden: 0, broken: [] } : { ok: true, removed: 1 }) }; };
  } });
  await new Promise((r) => setTimeout(r, 100));
  const d = dom.window.document;
  ck('page route serves it', page.status === 200, String(page.status) + ' ' + String(page.raw).slice(0,120));
  ck('page shows both cards, grouped by certainty', d.querySelectorAll('.card').length === 2 && /Ready to fix/.test(d.body.textContent) && /Needs an answer/.test(d.body.textContent));
  ck('titles are escaped, not injected as HTML', !d.querySelector('[data-id="c1"] .title b') && /T <b>x<\/b>/.test(d.querySelector('[data-id="c1"] .title').textContent));
  ck('the habit line is shown and says it still waits', /approved this kind 3 times/.test(d.body.textContent) && /still wait/.test(d.body.textContent));
  d.querySelector('[data-id="c1"] [data-do]').click();
  await new Promise((r) => setTimeout(r, 30));
  ck('ask card will not post without an answer', !calls.some((c) => c[0] === '/api/fixit/apply') && /Type the amount/.test(d.querySelector('[data-id="c1"] [data-msg]').textContent));
  d.querySelector('[data-id="c1"] [data-ask]').value = '500';
  d.querySelector('[data-id="c1"] [data-do]').click();
  await new Promise((r) => setTimeout(r, 30));
  const posted = calls.find((c) => c[0] === '/api/fixit/apply');
  ck('the page posts the id and the typed value to the real route', posted && JSON.parse(posted[1]).id === 'c1' && JSON.parse(posted[1]).value === '500', JSON.stringify(calls));
  d.querySelector('[data-id="c2"] [data-dismiss]').click();
  await new Promise((r) => setTimeout(r, 30));
  ck('dismiss posts the note and removes the card', calls.some((c) => c[0] === '/api/fixit/dismiss' && JSON.parse(c[1]).note === 'later') && !d.querySelector('[data-id="c2"]'));

  server.close();
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
