// Joey (Hynos) commission verification — his REAL invoice (EM-261014-01) and
// Commission List (tests/fixtures), the checks, the route a real server serves,
// and the page. CLAUDE.md rule 3: end to end. Gemini and Google are stubbed;
// nothing else is.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { JSDOM } = require('jsdom');
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) pass++; else { fail++; console.log('FAIL', n, d ? '\n   ' + d : ''); } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'joey-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaaa'; process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb'; process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc';
const ROOT = path.join(__dirname, '..');
const J = require(path.join(ROOT, 'helpers/joeyCommission'));
const invoiceSheet = require(path.join(ROOT, 'helpers/invoiceSheet'));
const gem = require(path.join(ROOT, 'helpers/gemini'));
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/joey-invoice-extracted.json'), 'utf8'));
const XLSX = fs.readFileSync(path.join(__dirname, 'fixtures/joey-commission-list.xlsx'));

// our Invoice sheet: one row per invoice line, as it is in real life
const HEAD = ['inv no.', 'consignee', 'container no.', 'weight', 'commissions', 'commissions'];
function sheetRows(tweak) {
  let rows = FX.records.map((r, i) => ['2606' + String(i).padStart(2, '0') + '_JY_' + r.contract_no, 'Joey/Taewon', r.container_no, String(r.mt), String(r.comm_per_mt), String(r.commission)]);
  return tweak ? tweak(rows) : rows;
}
const TWEAKED = (rows) => {
  const by = (c, mt) => rows.find((r) => r[2] === c && (mt == null || Number(r[3]) === mt));
  by('TCKU7036876')[4] = '12';                         // our rate differs from what he printed
  by('HMMU4059389')[3] = '18.0';                       // our weight differs
  rows = rows.filter((r) => r[2] !== 'SEGU6013365');   // not on our sheet at all
  by('TXGU8942580', 21.587)[4] = '';                   // our rate blank -> his rate is used, and says so
  rows.push(['260699_JY_26JY99', 'Joey/Daekwang', 'ZZZU1234567', '20', '30', '600']);   // ours, not billed
  rows.push(['260698_PM_26MT01', 'Pan Metal/HK', 'PPPU7654321', '20', '10', '200']);    // someone else's: never listed
  return rows;
};

(async () => {
  // ═══ A — his files, read and checked ═══
  const list = await J.parseCommissionList(XLSX);
  ck('his list: first tab, 62 lines', list.tab.includes('2610') && list.lines.length === 62, list.tab + ' ' + list.lines.length);
  ck('his claim (-200 on 26JY52) is read', list.claims.length === 1 && list.claims[0].amount === -200 && list.claims[0].contract_no === 'JY52'.replace('JY', '26JY'), JSON.stringify(list.claims));
  ck('formulas are worked out (MT x rate)', Math.abs(list.lines[0].commission - 184.52) < 0.006, JSON.stringify(list.lines[0]));
  const flat = J.flatten({ records: FX.records, claims: FX.claims }, 'inv.pdf');
  ck('claim becomes a negative line, not a container line', flat.filter((l) => l.is_claim).length === 1 && flat.find((l) => l.is_claim).commission === -200 && flat.length === 63);

  const clean = J.crossCheck(flat, { headers: HEAD, rows: sheetRows(), invoiceSheet, list });
  const st = (s) => clean.matched.filter((m) => m.status === s).length;
  ck('clean sheet: all 62 container lines match', st('match') === 62 && st('claim_deduction') === 1, JSON.stringify(clean.matched.map((m) => m.status).filter((s) => s !== 'match')));
  ck('rounding is not a mismatch (4.199 MT x $5 billed as $21.00)', clean.matched.find((m) => m.container_no === 'HMMU6566042' && m.mt === 4.199).status === 'match');
  ck('a container with two lines matches each by its own MT', clean.matched.filter((m) => m.container_no === 'KOCU5148281').every((m) => m.status === 'match') && clean.matched.filter((m) => m.container_no === 'KOCU5148281').length === 2);
  ck('every line agrees with his own list', clean.matched.filter((m) => !m.is_claim).every((m) => m.list && m.list.found && m.list.same_mt && m.list.agrees));
  ck('totals: lines, claim, net', Math.abs(clean.totals.lines - 11948.33) < 0.006 && clean.totals.claims === -200 && Math.abs(clean.totals.net - 11748.33) < 0.006, JSON.stringify(clean.totals));

  const tw = J.crossCheck(flat, { headers: HEAD, rows: sheetRows(TWEAKED), invoiceSheet });
  const one = (c, mt) => tw.matched.find((m) => m.container_no === c && (mt == null || m.mt === mt));
  ck('rate on our sheet differs from his -> mismatch, named', one('TCKU7036876').status === 'mismatch' && one('TCKU7036876').rate_differs && one('TCKU7036876').rate_used === 12, JSON.stringify(one('TCKU7036876')));
  ck('our weight differs -> says so, shows ours', one('HMMU4059389').status === 'weight_differs' && one('HMMU4059389').sheet.weight === '18', JSON.stringify(one('HMMU4059389').sheet));
  ck('container not on our sheet', one('SEGU6013365').status === 'not_in_sheet');
  ck('our rate blank -> his rate used, flagged as such', one('TXGU8942580', 21.587).status === 'match' && one('TXGU8942580', 21.587).rate_source === 'pdf_fallback');
  ck("Joey's unbilled container is listed; Pan Metal's is not", tw.sheet_only.some((r) => r.container_no === 'ZZZU1234567') && !tw.sheet_only.some((r) => r.container_no === 'PPPU7654321'), JSON.stringify(tw.sheet_only));
  const against = J.crossCheck([{ container_no: 'TCKU7036876', mt: 18.452, comm_per_mt: 10, commission: 184.52 }, { container_no: 'NEWU0000001', mt: 5, comm_per_mt: 10, commission: 50 }], { headers: HEAD, rows: sheetRows(), invoiceSheet, list });
  ck('a line not on his own list is called out', against.matched[1].list && against.matched[1].list.found === false);

  // ═══ B — through the real route ═══
  let ROWS = sheetRows(TWEAKED);
  gem.extractJoeyCommissionInvoice = async () => ({ ...FX, invoice_no: 'EM-261014-01', invoice_date: '10/14/2026', total: 11748.21 });
  invoiceSheet.fetchRawSheet = async () => ({ headers: HEAD, rows: ROWS });
  let LOGGED = null;
  require(path.join(ROOT, 'helpers/joeySheetLog')).logJoeyVerification = async (m) => { LOGGED = m; return { logged: m.filter((x) => x.status === 'match').length, updated: 0 }; };
  const { createApi } = require(path.join(ROOT, 'api'));
  const server = await new Promise((r) => { const s = createApi().listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = {}; if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (sid) headers.Authorization = `Bearer ${sid}`;
    const r2 = http.request(base + p, { method, headers }, (res) => { let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j, raw }); }); });
    r2.on('error', reject); if (data) r2.write(data); r2.end();
  });
  const sid = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
  const none = await req('POST', '/api/verify/joey', { sid, body: { pdfs: [] } });
  ck('no PDF -> 400', none.status === 400);
  const anon = await req('POST', '/api/verify/joey', { body: { pdfs: [{ name: 'a.pdf', base64: 'x' }] } });
  ck('not signed in -> refused', anon.status === 401 || anon.status === 403, String(anon.status));
  const res = await req('POST', '/api/verify/joey', { sid, body: { pdfs: [{ name: 'inv.pdf', base64: 'JVBERi0=' }], list: { name: 'l.xlsx', base64: XLSX.toString('base64') } } });
  ck('route answers', res.status === 200 && res.json && Array.isArray(res.json.matched), res.raw.slice(0, 300));
  const out = res.json;
  ck('route result carries the same findings', out.matched.filter((m) => m.status === 'match').length === 59 && out.matched.some((m) => m.status === 'weight_differs') && out.matched.some((m) => m.status === 'not_in_sheet'), JSON.stringify(out.matched.reduce((a, m) => (a[m.status] = (a[m.status] || 0) + 1, a), {})));
  ck("his list rides along: tab, 62 lines, net", out.list && out.list.lines === 62 && Math.abs(out.list.sum - 11748.31) < 0.006, JSON.stringify(out.list && { l: out.list.lines, s: out.list.sum }));
  ck("his stated total is compared with his own lines (11,748.21 vs 11,748.33)", out.totals.stated === 11748.21 && Math.abs(out.totals.total_diff + 0.12) < 0.006, JSON.stringify(out.totals));
  ck('only MATCHED lines are sent to the sheet log', LOGGED && LOGGED.length > 0 && res.json.sheet_log.logged === 59, JSON.stringify(res.json.sheet_log));
  gem.extractJoeyCommissionInvoice = async () => { throw new Error('model down'); };
  const bad = await req('POST', '/api/verify/joey', { sid, body: { pdfs: [{ name: 'bad.pdf', base64: 'x' }] } });
  ck('one unreadable PDF is a row, not a crash', bad.status === 200 && bad.json.matched.some((m) => m.status === 'extraction_failed'), bad.raw.slice(0, 200));
  const badList = await req('POST', '/api/verify/joey', { sid, body: { pdfs: [{ name: 'a.pdf', base64: 'x' }], list: { name: 'bad.xlsx', base64: Buffer.from('not a workbook').toString('base64') } } });
  ck('an unreadable list is reported, the check still runs', badList.status === 200 && !!badList.json.list_error, badList.raw.slice(0, 200));

  // ═══ C — the page ═══
  const html = fs.readFileSync(path.join(ROOT, 'dashboard/documents.html'), 'utf8');
  ck('the placeholder is gone', !/Joey commission verification isn't built here yet/.test(html));
  const calls = [];
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: base + '/documents', pretendToBeVisual: true, beforeParse(w) {
    w.alert = () => {}; w.confirm = () => true; w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
    w.fetch = async (p, o) => { calls.push([p, o && o.body]); if (/verify\/joey/.test(p)) return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => out, text: async () => JSON.stringify(out) };
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}), text: async () => '{}' }; };
  } });
  await new Promise((r) => setTimeout(r, 300));
  const d = dom.window.document;
  ck('the Joey panel has its upload zone, list button and Run button', !!d.getElementById('joeyDropZone') && !!d.getElementById('joeyListBtn') && !!d.getElementById('btnJoeyVerify'));
  ck('Pan Metal panel is untouched', !!d.getElementById('panMetalDropZone') && !!d.getElementById('btnPanMetalVerify'));
  d.getElementById('btnJoeyVerify').click();
  await new Promise((r) => setTimeout(r, 50));
  ck('Run with no file asks for one and posts nothing', !calls.some((c) => /verify\/joey/.test(c[0])));
  dom.window.eval(`joeyFiles.push({ name: 'inv.pdf', base64: 'JVBERi0=' }); joeyList = { name: 'l.xlsx', base64: 'AAAA' };`);
  d.getElementById('btnJoeyVerify').click();
  await new Promise((r) => setTimeout(r, 200));
  const posted = calls.find((c) => /verify\/joey/.test(c[0]));
  ck('the page posts the PDF and the list to the real route', posted && JSON.parse(posted[1]).pdfs.length === 1 && JSON.parse(posted[1]).list.name === 'l.xlsx', JSON.stringify(calls.map((c) => c[0])));
  const rows = d.querySelectorAll('#joeyResultsBody tr');
  ck('every invoice line and the claim are drawn', rows.length === out.matched.length, `${rows.length} vs ${out.matched.length}`);
  ck('claim row is labelled, not shown as a container line', /Claim deduction/.test(d.getElementById('joeyResultsBody').textContent));
  ck('his total difference is said in words', /per-line rounding|Ask him before paying/.test(d.getElementById('joeyNotes').textContent) && /Lines add to/.test(d.getElementById('joeyNotes').textContent), d.getElementById('joeyNotes').textContent);
  ck("Joey's unbilled containers are listed", /ZZZU1234567/.test(d.getElementById('joeySheetOnlyBody').textContent));
  server.close();
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
