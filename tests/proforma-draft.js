// ── tests/proforma-draft.js ───────────────────────────────────────────────
// Apsara, 2026-09-06: "if i ask jarvis to create proforma, it should create
// that .. it can ask whatever data is needed from me to create proforma like
// consignee, material, rate, MT (Typically 21 MT), payment terms, shipment
// terms."
//
// WHAT THIS IS GUARDING
// ---------------------
// The output is a document that goes to a customer with a price on it. Every
// other assistant failure today has cost a round trip; a wrong number here
// costs money and is discovered by the person paying it.
//
// So the rule the whole file exists to enforce: ANYTHING NOT SAID IS ASKED
// FOR, NEVER GUESSED. A defaulted term is fine and is shown as defaulted. An
// invented rate is not fine under any circumstances.
//
// The second thing it guards is the opposite failure — a form in disguise.
// An assistant that asks six questions it could have read out of the first
// sentence is worse than the dashboard form she already has.

const path = require('path');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const d = require(path.join(__dirname, '../helpers/proformaDraft.js'));

console.log('\n─ building a proforma by being asked ────────────────────────');

section('A — it asks for what is missing, one thing at a time');
{
    d.clear();
    ck('"create a proforma" starts one', d.isStart('jarvis create a proforma') === true);
    ck('  and so do her other words for it',
       d.isStart('raise a PI') && d.isStart('make a proforma invoice') && d.isStart('prepare a proforma'));
    ck('  but an ordinary sentence does not',
       !d.isStart('what is in inventory') && !d.isStart('send the proforma to Joey'),
       'sending an existing one is not making a new one');

    d.start('create a proforma');
    ck('it asks for the consignee first', /consignee/i.test(d.nextQuestion()),
       'the order follows the document, not the data structure');

    d.answer('Daekwang');
    ck('  a bare name is accepted as the answer', d.current().fields.consignee === 'Daekwang',
       JSON.stringify(d.current().fields));

    ck('then the material', /material/i.test(d.nextQuestion()));
    d.answer('copper');
    ck('  taken', d.current().fields.material === 'copper');

    ck('then the rate', /rate/i.test(d.nextQuestion()));
    d.answer('rate is 8450');
    ck('  and read as a number', d.current().fields.rate === 8450,
       JSON.stringify(d.current().fields.rate));

    ck('and then it stops asking', d.nextQuestion() === null,
       'MT, payment and shipment terms have defaults — asking about them is asking her to confirm what she just told me');
}

section('B — IT DOES NOT ASK WHAT SHE ALREADY SAID');
{
    // The form-in-disguise failure. Everything in one sentence should take
    // zero questions.
    d.clear();
    d.start('create a proforma for Taewon, 21 MT of brass at 5200 per MT');
    const f = d.current().fields;
    ck('the consignee was read from the sentence', f.consignee === 'Taewon', JSON.stringify(f));
    ck('  the material too', f.material === 'brass');
    ck('  and the rate', f.rate === 5200);
    ck('  and the tonnage', f.mt === 21);
    ck('so it asks nothing at all', d.nextQuestion() === null,
       'asking six questions it could have read is worse than the form she already has');
}

section('C — 21 MT is the default, not a question');
{
    d.clear();
    d.start('create a proforma for Joey, copper at 8000 per MT');
    ck('it does not ask about tonnage', d.nextQuestion() === null);
    ck('  and uses 21', d.payload().items[0].qty === 21, 'she said 21 is typical');
    ck('  which is marked as a default, not something she said',
       d.payload().defaulted.indexOf('mt') !== -1,
       'a default she cannot see is indistinguishable from a value she gave');

    // ...but she can override it.
    d.clear();
    d.start('proforma for Joey, 25 MT of copper at 8000 per MT');
    ck('and a stated tonnage wins', d.payload().items[0].qty === 25);
    ck('  and is NOT marked as defaulted', d.payload().defaulted.indexOf('mt') === -1);
}

section('D — THE RATE IS NEVER GUESSED');
{
    // The one field where a wrong value reaches a customer as a price.
    d.clear();
    d.start('create a proforma for Daekwang, copper');
    d.answer('Daekwang');
    let q = d.nextQuestion();
    while (q && !/rate/i.test(q)) { d.answer('copper'); q = d.nextQuestion(); }
    ck('it asks for the rate', /rate/i.test(q || ''), q);

    // A vague answer must NOT be stored as text.
    d.answer('about four thousand or so');
    ck('a vague answer is not accepted as a rate',
       d.current().fields.rate === undefined,
       'stored: ' + JSON.stringify(d.current().fields.rate)
       + ' — a non-number here reaches a customer as a price');
    ck('  so it asks again', /rate/i.test(d.nextQuestion() || ''));

    d.answer('4200');
    ck('  and a plain number is taken', d.current().fields.rate === 4200,
       JSON.stringify(d.current().fields.rate));

    // Nor is a tonnage guessed from a stray number.
    d.clear();
    d.start('create a proforma');
    d.answer('Daekwang');
    ck('a bare name is not read as a tonnage', d.current().fields.mt === undefined);
}

section('E — the arithmetic, which is the part that gets checked');
{
    d.clear();
    d.start('proforma for Daekwang, 21 MT copper at 8450 per MT');
    const p = d.payload();
    ck('the total is qty x rate', p.total === 21 * 8450, String(p.total));
    ck('  to two decimals', Math.round(p.total * 100) === p.total * 100);

    d.clear();
    d.start('proforma for X, 20.5 MT brass at 5199.99 per MT');
    const p2 = d.payload();
    ck('  and it survives fractions', p2.total === Math.round(20.5 * 5199.99 * 100) / 100,
       String(p2.total) + ' — floating point on a document someone pays against');
}

section('F — the read-back before anything is built');
{
    d.clear();
    d.start('proforma for Daekwang, 21 MT of copper at 8450 per MT');
    const s = d.summary();
    ck('it names the consignee', /Daekwang/.test(s), s);
    ck('  the material and tonnage', /21 MT of copper/.test(s), s);
    ck('  the rate', /\$8,450\.00/.test(s), s);
    ck('  and the total', /\$177,450\.00/.test(s), s);
    ck('  with the terms', /CIF/.test(s) && /100% TT/.test(s), s);
    ck('and it is short enough to be spoken', s.length < 220,
       s.length + ' chars — past a couple of lines nobody is listening');
}

section('G — she can change her mind mid-flow');
{
    d.clear();
    d.start('create a proforma for Joey, copper at 8000 per MT');
    d.answer('actually make it 25 MT at 8200');
    const f = d.current().fields;
    ck('a correction updates the tonnage', f.mt === 25, JSON.stringify(f));
    ck('  and the rate, in the same breath', f.rate === 8200, JSON.stringify(f));
    ck('  without losing what came before', f.consignee === 'Joey' && f.material === 'copper');
}

section('H — terms are defaults she can override');
{
    d.clear();
    d.start('proforma for Joey, copper at 8000 per MT');
    ck('the shipment term defaults to CIF', d.payload().shipment_terms === 'CIF');
    ck('  and payment to her usual', /100% TT/.test(d.payload().payment_terms));

    d.clear();
    d.start('proforma for Joey, copper at 8000 per MT, FOB');
    ck('but FOB is heard', d.payload().shipment_terms === 'FOB');
    ck('  and not marked as a default', d.payload().defaulted.indexOf('shipment_terms') === -1);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
