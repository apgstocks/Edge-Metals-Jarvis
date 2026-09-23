// ── tests/scout-yard-scope.js ─────────────────────────────────────────────
// Apsara, 2026-09-23: "scout's access to all edge yard data".
//
// Two halves, and the SECOND is the one worth having. The first proves the
// new stores reach Scout. The second proves Edge Metals does not — because
// the failure this guards against is silent: nobody notices the yard
// assistant quietly holding the other company's books until it repeats a
// figure back to someone.
//
// CLAUDE.md rule 5: Edge Yard and Edge Metals are different companies.

const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-'));
process.env.DATA_DIR = tmp;
process.env.JARVIS_TEST = '1';   // the Drive door, armed here and not by the runner
const R = path.join(__dirname, '..') + '/';

let pass = 0, fail = 0;
const ck = (name, ok) => { if (ok) { pass++; console.log('  PASS  ' + name); } else { fail++; console.log('  FAIL  ' + name); } };
const W = (f, v) => fs.writeFileSync(path.join(tmp, f), JSON.stringify(v, null, 2));

// ── fixtures ──────────────────────────────────────────────────────────────
// Deliberately small and deliberately DISTINCTIVE: every figure below is one
// that could not arrive by accident, so a section that shows up carrying the
// right number is carrying it from here.
W('expenses.json', [
    { id: 'E1', date: '2026-09-20', category: 'Fuel', description: 'Diesel for the loader', amount: 411.25, method: 'Cash' },
    { id: 'E2', date: '2026-09-21', category: 'Repairs', description: 'Baler belt', amount: 1288.00, method: 'Cash' },
]);
W('scale_tickets.json', [
    { id: 'ST-1', received_at: '2026-09-21T10:00:00Z', seller: 'Mazariegos', load_id: 'L9', gross: 78340, tare: 26060, net: 52280 },
]);
W('bols.json', [
    { bol_no: '26ECC001', date: '2026-09-19', buyer: 'Eccomelt', container_no: 'MSNU2312862' },
]);
W('address_book.json', [
    { name: 'Zimex Trucking', role: 'trucker', city: 'Fontana', mobile: '9095550111' },
]);

// ── and the Edge Metals stores, present but not Scout's ───────────────────
// Written into the SAME data dir on purpose. A test where the forbidden file
// does not exist proves nothing: absence would pass whether the rule is
// implemented or not.
W('petty_cash.json', [
    { id: 'P1', date: '2026-09-22', cash_source: 'Edge Metals', amount: 7777.77, note: 'AAA Investment transfer' },
]);
W('contacts.json', [{ id: 'C1', name: 'Edge Metals supplier — SHOULD NOT REACH SCOUT', company: 'Edge Metals' }]);
W('item_types.json', ['Sealed units', 'Auto cast']);

const { buildYardBrief } = require(R + 'helpers/yardBrief');
let brief, threw = null;
try { brief = buildYardBrief({}); } catch (e) { threw = e; }
const blob = JSON.stringify(brief || {});

console.log('\nA. the brief still builds');
ck('buildYardBrief did not throw', threw === null);
ck('it returned an object', !!brief && typeof brief === 'object');
ck('the four original sections survive', ['totals_all_time', 'recent_loads', 'stock_on_hand', 'money_outstanding'].every((k) => k in brief));

console.log('\nB. the yard stores she asked for are in it');
ck('expenses reached Scout', !!brief.expenses);
ck('the expense total was computed in code, not left to the model',
    !!brief.expenses && brief.expenses.all_time && Number(brief.expenses.all_time.total) === 1699.25);
ck('an individual expense is readable', /Baler belt/.test(blob));
ck('scale tickets reached Scout', !!brief.scale_tickets && brief.scale_tickets.count === 1);
ck('a ticket keeps its net', /52280/.test(blob));
ck('BOLs reached Scout — the one she said yes to', !!brief.bols && brief.bols.count === 1);
ck('the BOL number is readable', /26ECC001/.test(blob));
ck('the address book reached Scout', !!brief.address_book && brief.address_book.count === 1);
ck('yard profit is present', 'yard_profit' in brief);

console.log('\nC. EDGE METALS DID NOT (CLAUDE.md rule 5)');
ck('no petty cash section', !('petty_cash' in brief));
ck('the petty cash figure appears nowhere in the brief', !/7777\.77/.test(blob));
ck('"AAA Investment" appears nowhere in the brief', !/AAA Investment/i.test(blob));
ck('no quote contacts section — she said no', !('contacts' in brief) && !('quote_contacts' in brief));
ck('the Edge Metals contact did not leak', !/SHOULD NOT REACH SCOUT/.test(blob));
ck('no item catalogue section — she said no', !('item_types' in brief) && !('item_catalogue' in brief));

console.log('\nD. one broken store costs its own section and nothing else');
// The whole point of the per-section guard. Corrupt ONE file and the brief
// must still answer everything else — a brief that fails to build is a bot
// that says nothing at all.
fs.writeFileSync(path.join(tmp, 'expenses.json'), '{ this is not json');
let b2, threw2 = null;
try { b2 = buildYardBrief({}); } catch (e) { threw2 = e; }
ck('a corrupt expenses file does not throw', threw2 === null);
ck('and the other sections are still there', !!b2 && !!b2.bols && !!b2.scale_tickets);

console.log('\nE. the brief stays small enough to send every turn');
// It is prepended to EVERY question. Uncapped, this is a slower and more
// expensive answer to questions that never touch the new stores.
const kb = blob.length / 1024;
ck(`brief is ${kb.toFixed(1)} KB, under the 120 KB ceiling`, kb < 120);
ck('expenses list is capped', !brief.expenses || !brief.expenses.recent || brief.expenses.recent.length <= 40);
ck('address book is capped', !brief.address_book || brief.address_book.entries.length <= 60);

console.log(`\n  ${pass} passed, ${fail} failed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* tmp */ }
process.exit(fail ? 1 : 0);
