// BOL form: net weight is worked out (gross - tare) as gross/tare are typed.
// Runs the real BOL form code from dashboard/documents.html in a DOM.
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'documents.html'), 'utf8');
const a = html.indexOf('const bolNum = (v)'), b = html.indexOf("$('bol_unit') && $('bol_unit')");
if (a < 0 || b < 0) { console.log('FAIL could not find the BOL form code'); process.exit(1); }
const code = html.slice(a, b);
const dom = new JSDOM('<div id="bolItems"></div><div id="bolTotals"></div><div id="bolWarnings"></div><select id="bol_unit"><option value="lb">lb</option></select>', { runScripts: 'outside-only' });
const w = dom.window;
w.eval(`const $ = (id) => document.getElementById(id); const esc = (s) => String(s ?? '').replace(/"/g,'&quot;');
var bolRows = [{description:'Scrap',pieces:'',gross_weight:'',tare_weight:'',net_weight:''},
               {description:'Old',pieces:'',gross_weight:'1000',tare_weight:'100',net_weight:'777'}];
${code}
window.__t = { paint: bolPaintItems, rows: () => bolRows, net: bolNetOf };`);
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) pass++; else { fail++; console.log('FAIL', n, d || ''); } };
const type = (i, f, v) => { const el = w.document.querySelector(`input[data-bi="${i}"][data-bf="${f}"]`); el.value = v; el.dispatchEvent(new w.Event('input')); };
const net = (i) => w.document.querySelector(`input[data-bi="${i}"][data-bf="net_weight"]`);
w.__t.paint();
ck('opening an old saved BOL does not rewrite its net', net(1).value === '777', net(1).value);
ck('net box is read-only', net(0).readOnly === true);
type(0, 'gross_weight', '52,400');
ck('gross only: net = gross', net(0).value === '52,400', net(0).value);
ck('and the empty tare became 0, like the packing list', w.document.querySelector('input[data-bi="0"][data-bf="tare_weight"]').value === '0');
w.document.querySelector('input[data-bi="0"][data-bf="tare_weight"]').value='';
type(0, 'tare_weight', '33,150');
ck('gross - tare, commas handled', net(0).value === '19,250', net(0).value);
ck('stored in the row, so it is what gets saved', w.__t.rows()[0].net_weight === '19,250');
type(0, 'tare_weight', '33150.5');
ck('decimals rounded to 2 places', net(0).value === '19,249.5', net(0).value);
type(0, 'gross_weight', '');
ck('gross cleared: net cleared, not 0 or negative', net(0).value === '' && w.__t.rows()[0].net_weight === '', net(0).value);
ck('totals follow the net column (row 1 still 777)', /net 777/.test(w.document.getElementById('bolTotals').textContent));
type(1, 'tare_weight', '200');
ck('editing an old row recalculates it', net(1).value === '800', net(1).value);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
