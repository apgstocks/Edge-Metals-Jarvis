// tests/owner-report.js — the weekly owner report. Read-only; every line computed from data.
// Section B reads the REAL stores (receipts, outcomes, inbound log, follow-ups) in a temp DATA_DIR.
const fs = require('fs'), os = require('os'), path = require('path');
const R = (p) => path.join(__dirname, '..', p);
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
process.env.JARVIS_TEST = '1';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-or-'));
process.env.DATA_DIR = TMP; process.env.API_TOKEN = 't';
process.env.JARVIS_INBOUND_LOG_FILE = path.join(TMP, 'inbound.jsonl');
delete require.cache[R('config.js')];
const rep = require(R('helpers/ownerReport.js'));
const NOW = Date.parse('2026-11-09T12:00:00Z');
const iso = (d) => new Date(NOW - d * 864e5).toISOString();
const ymd = (d) => iso(d).slice(0, 10);

console.log('\n=== A. the numbers (injected data) ===');
const src = {
    receipts: () => [
        { date: ymd(1), amount: 10000, customer: 'Eccomelt' }, { date: ymd(3), amount: 2500.5, customer: 'Eccomelt' },
        { date: ymd(2), amount: 4000, customer: 'Daekwang' }, { date: ymd(20), amount: 99999, customer: 'Old Co' }, { date: ymd(1), amount: -5, customer: 'Refund' },
    ],
    followups: () => ({ open_invoices: 7, total_outstanding: 55000, waiting_eta: [{}, {}], drafts: [
        { customer: 'Zimex', total: 30000, kind: 'payment', to_missing: false }, { customer: 'Taewon', total: 15000, kind: 'remittance', to_missing: true },
        { customer: 'NoMail', total: 10000, kind: 'payment', to_missing: true } ] }),
    outcomes: () => [
        { kind: 'outcome', at: iso(1), outcome: 'approved' }, { kind: 'outcome', at: iso(2), outcome: 'approved' }, { kind: 'outcome', at: iso(2), outcome: 'declined' },
        { kind: 'outcome', at: iso(30), outcome: 'approved' }, { kind: 'decision', at: iso(1) } ],
    builds: () => [{ state: 'merged', at: iso(2) }, { state: 'merged', at: iso(40) }, { state: 'ready', at: iso(1) }],
    slow: () => [{ customer: 'Zimex', invoice_no: 'Z1', balance: 30000, age: 61, usual: 28 }, { customer: 'A', balance: 1, age: 50, usual: 9 }, { customer: 'B', balance: 1, age: 50, usual: 9 }, { customer: 'C', balance: 1, age: 50, usual: 9 }],
    told: () => [{ at: iso(1), text: 'a' }, { at: iso(2), text: 'b' }, { at: iso(30), text: 'c' }],
};
let r = rep.build({ now: NOW, src });
ck('cash in counts only this week, only positive amounts', r.cash.total === 16500.5 && r.cash.count === 3, JSON.stringify(r.cash));
ck('top payers ranked', r.cash.top[0].customer === 'Eccomelt' && r.cash.top[0].total === 12500.5);
ck('open total and biggest', r.open.total === 55000 && r.open.invoices === 7 && r.open.top[0].customer === 'Zimex');
ck('"needs you": no address, no terms, waiting ETA', r.needs.noAddress.join() === 'Taewon,NoMail' && r.needs.noTerms.join() === 'Taewon' && r.needs.waitingEta === 2);
ck('"what I did" counts only this week, only outcomes', r.did.approved === 2 && r.did.declined === 1);
ck('builds merged this week and waiting', r.builds.merged === 1 && r.builds.waiting === 1);
ck('slower-than-usual: counted, biggest first three kept', r.slow && r.slow.count === 4 && r.slow.top.length === 3 && r.slow.top[0].customer === 'Zimex', JSON.stringify(r.slow));
ck('messages heard this week', r.told === 2);
const t = rep.text(r);
ck('the text has every part, short', /Cash in: \$16,500\.5 from 3 payments/.test(t) && /Still open: \$55,000 on 7 invoices/.test(t) && /What I did: 2 approved by you, 1 declined, 1 code change merged/.test(t) && /Needs you:/.test(t) && t.split('\n').length <= 7, t);
ck('the text names who is slower than usual, and how many more', /Slower than their usual: Zimex \$30,000 \(day 61, usually 28\), A \$1 \(day 50, usually 9\), B \$1 \(day 50, usually 9\) and 1 more\./.test(t), t);
ck('"needs you" names the people', /no email address on file for Taewon, NoMail/.test(t) && /payment terms for Taewon/.test(t) && /1 code change ready for your yes/.test(t));

console.log('\n=== quiet weeks and broken sources ===');
const quiet = rep.text(rep.build({ now: NOW, src: { receipts: () => [], followups: () => ({ open_invoices: 0, total_outstanding: 0, drafts: [], waiting_eta: [] }), outcomes: () => [], builds: () => [], told: () => [], slow: () => [] } }));
ck('a quiet week says so and invents nothing', /no payments recorded this week/.test(quiet) && !/Slower/.test(quiet) && !/What I did/.test(quiet) && !/Needs you/.test(quiet) && !/Heard from you/.test(quiet), quiet);
const bt = rep.text(rep.build({ now: NOW, src: { receipts: () => ({ __error: 'x' }), followups: src.followups, outcomes: () => ({ __error: 'x' }), builds: src.builds, told: src.told } }));
ck('an unreadable source is named, not shown as zero', /Could not read: receipts, outcomes/.test(bt) && !/Cash in/.test(bt) && /Still open/.test(bt), bt);
const thrown = rep.text(rep.build({ now: NOW, src: Object.assign({}, src, { receipts: () => { throw new Error('boom'); } }) }));
ck('a source that THROWS is named as unreadable and the rest of the report still comes', /Could not read: receipts/.test(thrown) && /Still open/.test(thrown), thrown);
const edge = rep.build({ now: NOW, src: { receipts: () => [{ date: ymd(6), amount: 100, customer: 'In' }, { date: ymd(9), amount: 900, customer: 'Out' }], outcomes: () => [{ kind: 'outcome', at: iso(6), outcome: 'approved' }, { kind: 'outcome', at: iso(9), outcome: 'approved' }], told: () => [{ at: iso(6) }, { at: iso(9) }], builds: () => [{ state: 'merged', at: iso(6) }, { state: 'merged', at: iso(9) }] } });
ck('the 7-day edge: a day-6 item is in, a day-9 item is out, for every source', edge.cash.total === 100 && edge.did.approved === 1 && edge.told === 1 && edge.builds.merged === 1, JSON.stringify([edge.cash, edge.did, edge.told, edge.builds]));
const bs = rep.text(rep.build({ now: NOW, src: Object.assign({}, src, { slow: () => ({ __error: 'x' }) }) }));
ck('unreadable pay habits are named, not hidden', /Could not read: pay habits/.test(bs) && !/Slower than/.test(bs), bs);
ck('days is respected', rep.build({ now: NOW, days: 30, src }).cash.total === 16500.5 + 99999);

(async () => {
console.log('\n=== B. the real stores ===');
const sales = require(R('helpers/sales.js'));
const rec = require(R('helpers/salesReceipts.js'));
const oc = require(R('helpers/outcomes.js'));
const il = require(R('helpers/inboundLog.js'));
const today = new Date().toISOString().slice(0, 10);
const s1 = (await sales.addSale({ customer: 'Eccomelt', invoice_no: 'OR-1', date: today, item: 'Auto Cast', weight: 40000, invoice_price: 0.5, price_unit: 'lb', weight_unit: 'lb' })).id;
const s2 = (await sales.addSale({ customer: 'Daekwang', invoice_no: 'OR-2', date: today, item: 'Electric motors', weight: 16600, invoice_price: 0.55 })).id;
await rec.addReceipt({ date: today, amount: 7000, customer: 'Eccomelt', mode: 'Wire', bank: 'BofA', allocations: [{ sale_id: s1, amount: 7000 }] });
await rec.addReceipt({ date: today, amount: 1500, customer: 'Daekwang', mode: 'Cash', allocations: [{ sale_id: s2, amount: 1500 }] });
oc.recordDecision({ ref: 'm1', surfaced: true }); oc.recordOutcome({ ref: 'm1', outcome: 'approved', by: 'manager' });
oc.recordDecision({ ref: 'm2', surfaced: true }); oc.recordOutcome({ ref: 'm2', outcome: 'declined', by: 'manager' });
il.record({ chatId: '1@c.us', role: 'manager', text: 'Eccomelt pays late, ignore their first reminder' });
const real = rep.build({});
ck('real receipts: this week\'s cash is read from the store', real.cash && real.cash.total === 8500 && real.cash.top[0].customer === 'Eccomelt', JSON.stringify(real.cash));
ck('real outcomes: approved and declined counted', real.did && real.did.approved === 1 && real.did.declined === 1, JSON.stringify(real.did));
ck('real message log: counted', real.told === 1, String(real.told));
ck('the follow-up read does not crash on an empty install', real.open !== undefined);
const printed = require('child_process').spawnSync(process.execPath, [R('scripts/owner-report.js'), '--days=7'], { encoding: 'utf8', env: Object.assign({}, process.env) });
ck('the command prints the report, exits 0, sends nothing', printed.status === 0 && /Weekly report \(last 7 days\)/.test(printed.stdout) && /Cash in: \$8,500/.test(printed.stdout), printed.stdout + printed.stderr);
const before = fs.readdirSync(TMP).sort().join();
rep.text(rep.build({}));
ck('building the report writes nothing', fs.readdirSync(TMP).sort().join() === before);

})().then(() => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }, (e) => { console.log('CRASH', e); process.exit(1); });
