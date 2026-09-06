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

const ROOT2 = path.join(__dirname, '..');
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

section('H2 — the verbs she actually reaches for');
{
    // Apsara, 2026-09-07: "when i say Hey Jarvis..send a proforma for
    // autocasting tense..still it asks what is the material".
    //
    // "send" was not in the START list. Her exact sentence did not start a
    // draft AT ALL — handle() returned null and the whole thing fell through
    // to the router. Seven verbs I thought of; the first one she reached for
    // was not among them.
    for (const t of [
        'send a proforma for autocasting tense',
        'create a proforma for Daekwang',
        'make a proforma for Daekwang',
        'raise a PI for Yurim',
        'issue a proforma for Daekwang',
        'do a proforma for Daekwang',
        'put together a proforma for Daekwang',
        'draft a proforma for Daekwang',
        'prepare an invoice for Daekwang',
    ]) ck(`"${t}" starts a draft`, d.isStart(t) === true);

    // And what must NOT start one. "send" is now a start verb AND the word
    // she uses to post a finished document — the noun is what keeps them
    // apart.
    for (const t of [
        'send the booking to Sher Trucking',
        'send it', 'send that to Yurim',
        'do we have any bookings from Houston',
        'make it 25 MT',
    ]) ck(`  "${t}" does not`, d.isStart(t) === false);
}

section('H3 — the word itself, as whisper hears it');
{
    // Apsara, 2026-09-07: "if i say proforma-sometimes it is getting treated
    // as 'create a propharma' ..it is unable to resolve. instead it shows no
    // bookings found."
    //
    // The pattern demanded the literal string "proforma". Every mishearing
    // failed to start a draft, fell through to the router, and came back "no
    // bookings found" — a baffling thing to hear after asking for an invoice.
    for (const t of [
        'create a propharma for Daekwang',      // HER REPORTED CASE
        'create a profarma for Daekwang',
        'create a prophorma for Daekwang',
        'make a profoma for Daekwang',
        'raise a performa for Yurim',
        'make a pro forma for Yurim',           // two tokens, neither meaningful alone
        'make a pro pharma for Yurim',
        'do a proform for Daekwang',
        'create a preforma for Daekwang',
    ]) ck(`"${t}" starts a draft`, d.isStart(t) === true);

    // SHE ALSO SAYS IT WITH NO VERB AT ALL. "proforma for Daekwang, 21 MT of
    // copper at 8450" is a complete request; demanding a verb made it nothing.
    for (const t of [
        'proforma for Daekwang, 21 MT of copper at 8450',
        'propharma for Daekwang',
        'hey jarvis proforma for Daekwang',
        'a proforma for Daekwang',
    ]) ck(`  "${t}" starts one too`, d.isStart(t) === true);

    // WHAT MUST NOT. Edit distance was measured and REJECTED for exactly
    // this: "propharma" is 3 edits from "proforma", and so are "perform" and
    // "forma". "perform a scan" becoming a proforma is worse than the bug.
    for (const t of [
        'perform a scan for bookings past cutoff',
        'run a scan and perform the archive',
        'what is our performance this month',
        'platform update',
        'pharma company enquiry',
        'send the proforma to Joey',            // posts an existing one
        'any bookings from Houston',
        'forward that to Sher Trucking',
    ]) ck(`  "${t}" does NOT`, d.isStart(t) === false);

    // The word-level test on its own, since isStart also needs a verb or an
    // opening position and could mask a broken shape check.
    for (const w of ['proforma', 'propharma', 'profarma', 'prophorma', 'performa', 'preforma', 'proform', 'profoma'])
        ck(`  "${w}" is recognised as the word`, d.looksLikeProforma(w) === true);
    for (const w of [
        'perform', 'performance', 'platform', 'pharma', 'forma', 'form', 'proof', 'promo',
        // THE WORDS THAT EXERCISE THE pro/pre/per ANCHOR. Every one of these
        // contains the f-vowel-rm shape; only the anchor keeps them out, and
        // without these my false-positive list was so easy that deleting the
        // anchor entirely left all 153 assertions green.
        'information', 'transform', 'transformer', 'confirm', 'confirmation',
        'uniform', 'farm', 'formal', 'formula', 'reform', 'informal',
    ]) ck(`  "${w}" is not`, d.looksLikeProforma(w) === false);

    // And in a whole sentence, which is how they actually arrive.
    for (const t of [
        'confirm the booking for Daekwang',
        'send Yurim the shipping information',
        'is that the formal name',
    ]) ck(`  "${t}" starts nothing`, d.isStart(t) === false);

    // The stoplist is what separates the shape from real English, so it must
    // actually be consulted rather than merely present.
    ck('  the stoplist covers the perform family',
       d.PROFORMA_STOP.has('perform') && d.PROFORMA_STOP.has('performance')
       && d.PROFORMA_STOP.has('platform'));

    // "PI" stays EXACT. Two letters cannot be fuzzy-matched without
    // swallowing half the language.
    ck('  "PI" still works', d.isStart('raise a PI for Yurim') === true);
    ck('  and is not fuzzy-matched', d.namesProforma('pie for lunch') === false,
       'a two-letter token matched loosely would fire on everything');
}

section('I — the material is whatever she calls it');
{
    // Apsara, 2026-09-06: "my user doesnt know about nouns."
    //
    // The material parser was twenty-one metals I typed from memory. Scrap
    // grades are ISRI names, house shorthand and whatever the buyer agreed
    // to call it — so anything off my list came back null and she was asked
    // "What material?" about a sentence that had already said it.

    // 1. HER CATALOG. data/item_types.json is the descriptions she actually
    //    types on load tickets, and it grows without anyone editing this file.
    const cat = d.catalogMaterials();
    // Asserted on the COUNT, not just non-empty: the loop below silently
    // checks nothing when the catalog is empty, so a mutation that removed
    // the catalog entirely cost only one failing assertion instead of four.
    ck('her own item catalog is the vocabulary', cat.length >= 5, cat.join(','));
    for (const name of cat.slice(0, 3)) {
        ck(`  "${name}" is understood`,
           d.materialIn(`21 MT of ${name} at 900`) === name,
           'got ' + d.materialIn(`21 MT of ${name} at 900`));
    }
    // Parentheses in a catalog entry must be escaped, not compiled as a group.
    if (cat.includes('Al rims(Dirty)')) {
        ck('  and a catalog entry with punctuation does not break the regex',
           d.materialIn('material is Al rims(Dirty), rate 900') === 'Al rims(Dirty)');
    }

    // LONGEST FIRST. Her real catalog happens to contain no nested pair, so
    // a mutation removing the sort left everything green — the same hole the
    // port list had. This stubs a catalog that does contain one, because
    // "Al combo" and "Al combo clean" is exactly what a user-editable list
    // grows into, and the failure is silent: the short grade on the document,
    // under a preview that looks complete.
    {
        const itPath = require.resolve(path.join(__dirname, '../helpers/itemTypes.js'));
        const real = require.cache[itPath];
        require.cache[itPath] = {
            id: itPath, filename: itPath, loaded: true,
            exports: { loadCustomItemTypes: () => ['Al combo', 'Al combo clean', 'Zorba'] },
        };
        d._clearMaterialCache();
        ck('  the longer of two overlapping grades wins',
           d.materialIn('21 MT of Al combo clean at 900') === 'Al combo clean',
           'got ' + d.materialIn('21 MT of Al combo clean at 900'));
        ck('  while the shorter one still matches on its own',
           d.materialIn('21 MT of Al combo at 900') === 'Al combo');
        if (real) require.cache[itPath] = real; else delete require.cache[itPath];
        d._clearMaterialCache();
    }

    // 2. THE METALS FLOOR — nobody writes a load ticket for "copper" in the
    //    abstract, so the catalog will not carry it.
    // SAID, not typed. "Auto cast" is the catalog entry; she says "autocast"
    // and whisper writes "autocasting". All three failed the exact-spelling
    // match and she was asked "What material?" about a sentence that named it.
    for (const said of ['autocast', 'autocasting', 'auto cast', 'Auto-cast', 'auto casts']) {
        ck(`  "${said}" resolves to the catalog entry`,
           d.materialIn(`21 MT of ${said} at 900`) === 'Auto cast',
           'got ' + d.materialIn(`21 MT of ${said} at 900`));
    }
    ck('  and the CATALOG spelling is what goes on the document',
       d.materialIn('21 MT of autocasting at 900') === 'Auto cast',
       'the description line should read like every other document she has raised');

    ck('the plain metals still work', d.materialIn('21 MT of copper at 8450') === 'copper');

    // 3. A POSITION ONLY A MATERIAL CAN OCCUPY. This is the part that means
    //    she never has to have heard of my list.
    ck('a grade nobody hardcoded is understood',
       d.materialIn('21 MT of Taldon at 4200') === 'Taldon');
    ck('  and one that starts with a digit',
       d.materialIn('21 MT of 500 series at 8450 per MT') === '500 series',
       'a letters-only opener skipped "500 series" — the same failure one character wide');
    ck('  and an explicit "material is"',
       d.materialIn('material is Tweak, rate 1200') === 'Tweak');

    // WHAT IT MUST NOT SWALLOW. Loosening this field is only safe because a
    // material is free text she previews; it stops being safe the moment it
    // starts eating the quantity or the price.
    ck('a quantity is never a material',
       d.materialIn('for Daekwang of 21 MT at 8450') === null,
       'got ' + d.materialIn('for Daekwang of 21 MT at 8450') + ' — "21 MT" on the description line is a wasted document');
    ck('  nor a bare number', d.materialIn('of 8450') === null);
    ck('  nor the word "material" itself', d.materialIn('material is material') === null);
    ck('  and the rate is not dragged into the description',
       !/8450/.test(String(d.materialIn('21 MT of 500 series at 8450 per MT'))));
    ck('  a sentence with no material at all gives null',
       d.materialIn('what time do we close') === null);
    ck('  and so does silence', d.materialIn('') === null && d.materialIn(null) === null);

    // Widening it must not have widened the RATE. That distinction is the
    // whole design: material is a word on a page she checks, a rate is money.
    d.clear();
    const loose = d.start('create a proforma for Daekwang, 21 MT of 500 series at 8450 per MT');
    ck('the rate is still read strictly', loose.fields.rate === 8450, String(loose.fields.rate));
    ck('  and the quantity is still 21', loose.fields.mt === 21);
    d.clear();
    const noRate = d.start('create a proforma for Daekwang, 21 MT of Taldon');
    ck('  and an unstated rate is still asked for, never guessed',
       noRate.fields.rate === undefined && d.missing().includes('rate'));
}

section('I2 — "a proforma for autocasting" is not a company called that');
{
    // "for X" names BOTH the buyer and the goods. The consignee parser took
    // the first one it saw, so the MATERIAL became the buyer, the material
    // stayed empty, and she was asked "What material?" about a sentence whose
    // entire subject was the material.
    d.clear();
    const r = d.handle('send a proforma for autocasting tense');
    // `!!r &&` on every one of these: without it a regression makes handle()
    // return null, the test THROWS, node exits, and the run prints no totals
    // at all — which reads as a broken suite rather than a caught bug.
    ck('the sentence starts a draft at all', !!r,
       'handle() returned null — "send" is missing from the START verbs again');
    ck('the material is read as the material', !!r && r.have && r.have.material === 'Auto cast',
       JSON.stringify(r && r.have));
    ck('  and NOT as the buyer',
       !!r && !r.have.consignee,
       'got consignee "' + r.have.consignee + '" — that name would print at the top of the document');
    ck('  so it asks the one thing genuinely missing',
       !!r && /consignee/i.test(r.say), r && r.say);

    // The failure direction is deliberate: losing a consignee costs one
    // question, which the flow exists to ask. Losing the material puts a
    // company name on the description line.
    d.clear();
    ck('a real buyer is still a buyer',
       d.handle('create a proforma for Daekwang, 21 MT of copper at 8450').fields.consignee === 'Daekwang');

    // AND THE COMPANIES NAMED AFTER METALS, which is half of them.
    // The discriminator is HER CATALOG, not the metals list. My first version
    // used materialIn(), which includes the plain metals — and "change the
    // consignee to Hyundai Steel" turned the buyer into goods and put "Steel"
    // on the description line. The catalog contains "Auto cast" and "Al
    // rims(Dirty)", which no company is called; it does NOT contain bare
    // "steel" or "iron", which many are.
    for (const [sentence, buyer] of [
        ['create a proforma for Chrome Metals, 21 MT of copper at 8450', 'Chrome Metals'],
        ['create a proforma for Steel Co, 21 MT of copper at 8450', 'Steel Co'],
        ['create a proforma for Motors Trading, 21 MT of copper at 8450', 'Motors Trading'],
        ['create a proforma for Hyundai Steel, 21 MT of copper at 8450', 'Hyundai Steel'],
        ['create a proforma for Mixed Metals Inc, 21 MT of copper at 8450', 'Mixed Metals Inc'],
        // NO COMPANY SUFFIX, but a metal in the name. This is the case that
        // separates the catalog from the metals list: with materialIn() as
        // the discriminator "Copper Bay" becomes goods and the buyer vanishes,
        // and the company-suffix escape does not save it because there is no
        // suffix to find.
        ['create a proforma for Copper Bay, 21 MT of brass at 4000', 'Copper Bay'],
        ['create a proforma for Iron Bridge, 21 MT of brass at 4000', 'Iron Bridge'],
    ]) {
        d.clear();
        // Guarded: with the discriminator wrong, handle() returns an ASKING
        // stage (no consignee, so it asks for one) and `.fields` is undefined
        // — the assertion threw instead of failing, and a throw prints no
        // totals, so the run looked broken rather than the check looking
        // wrong. Same guard I have had to add three times today.
        const step = d.handle(sentence);
        const got = step && (step.fields || step.have) && (step.fields || step.have).consignee;
        ck(`  "${buyer}" is a buyer, not goods`, got === buyer,
           'got ' + got + (step ? ' (stage ' + step.stage + ')' : ' — handle() returned null'));
    }
}

section('I3 — when the catalog grows a word that is also a company tail');
{
    // Her catalog is hers to edit. The moment she adds "Steel" as an item
    // type, a bare "steel" is goods AND "Hyundai Steel" is still a buyer —
    // which is exactly what the multi-word guard on the company-suffix test
    // is for. Nothing covered it, because her catalog happens to contain no
    // such entry today, so a mutation making the suffix test apply to single
    // words changed nothing.
    const itPath = require.resolve(path.join(__dirname, '../helpers/itemTypes.js'));
    const real = require.cache[itPath];
    require.cache[itPath] = {
        id: itPath, filename: itPath, loaded: true,
        exports: { loadCustomItemTypes: () => ['Steel', 'Auto cast', 'Chrome'] },
    };
    d._clearMaterialCache();

    d.clear();
    const goods = d.handle('create a proforma for steel, 21 MT at 4000');
    ck('a bare catalog word is goods', (goods.fields || goods.have).material === 'Steel',
       JSON.stringify(goods.fields || goods.have));
    ck('  and does not become the buyer', !(goods.fields || goods.have).consignee,
       'got ' + (goods.fields || goods.have).consignee);

    d.clear();
    const buyer = d.handle('create a proforma for Hyundai Steel, 21 MT of brass at 4000');
    ck('while the same word inside a company name is the buyer',
       (buyer.fields || buyer.have).consignee === 'Hyundai Steel',
       JSON.stringify(buyer.fields || buyer.have));

    if (real) require.cache[itPath] = real; else delete require.cache[itPath];
    d._clearMaterialCache();
}

section('I4 — the customer\'s own name for it goes on the document');
{
    // Apsara, 2026-09-07: "customers can have it different name than my
    // description."
    //
    // This makes a decision from an hour earlier wrong. materialIn()
    // normalises what she says to HER catalog spelling — "autocasting"
    // becomes "Auto cast" — and that spelling was then printed. But "Auto
    // cast" is yard shorthand; Daekwang's purchase order says "Aluminium Auto
    // Casting Scrap", and a proforma whose description does not match the PO
    // is a document their accounts team queries.
    //
    // RECOGNISE in her words, PRINT in theirs. Two jobs I had collapsed into
    // one. Their wording is already on file: proformaPricing keeps a
    // display_desc per customer per item from every proforma generated.
    const fs2 = require('fs'), os = require('os');
    const dir = fs2.mkdtempSync(path.join(os.tmpdir(), 'jv-price-'));
    // A REAL temp dir. I seeded her actual data/proforma_pricing.json while
    // exploring this and had to delete it — a test that writes to the live
    // store is a test that edits her business records.
    const realDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dir;
    for (const k of Object.keys(require.cache)) {
        if (/helpers\/(json|proformaPricing|proformaDraft)|config\.js$/.test(k)) delete require.cache[k];
    }
    const pp = require(path.join(ROOT2, 'helpers/proformaPricing.js'));
    const pd = require(path.join(ROOT2, 'helpers/proformaDraft.js'));

    return (async () => {
        // BOTH forms on file, which is what actually happens over time: the
        // early proformas used her shorthand, then their PO arrived and the
        // later ones used the full description. The fuller one is what their
        // accounts team matches against, so it has to win — and with no
        // longest-first sort the shorthand comes back and the mutation
        // survived every other assertion here.
        await pp.upsert('Daekwang', { tradeTerms: 'CIF', portDischarge: 'Busan', items: [
            { desc: 'Auto cast', rate: 2050, unit: 'MT' },
            { desc: 'Aluminium Auto Casting Scrap', rate: 2100, unit: 'MT' }] });

        ck('the FULLER of two past descriptions wins',
           pd.describeFor('Daekwang', 'autocasting') === 'Aluminium Auto Casting Scrap',
           'got ' + pd.describeFor('Daekwang', 'autocasting')
           + ' — the shorthand is hers, the long one is on their purchase order');
        ck('their wording is used when we have sent them one before',
           pd.describeFor('Daekwang', 'Auto cast') === 'Aluminium Auto Casting Scrap',
           'got ' + pd.describeFor('Daekwang', 'Auto cast'));
        ck('  matched through the same pattern that recognised hers',
           pd.describeFor('Daekwang', 'autocasting') === 'Aluminium Auto Casting Scrap'
           || pd.describeFor('Daekwang', 'Auto cast') === 'Aluminium Auto Casting Scrap',
           '"Auto cast" has to match "Aluminium Auto Casting Scrap" — the -ing ending is why');

        ck('  a NEW customer gets her tidy catalog name',
           pd.describeFor('Brand New Ltd', 'Auto cast') === 'Auto cast',
           'not whatever whisper heard');
        ck('  and no consignee changes nothing',
           pd.describeFor('', 'Auto cast') === 'Auto cast');
        ck('  a material they have never been sent is left alone',
           pd.describeFor('Daekwang', 'copper') === 'copper',
           'got ' + pd.describeFor('Daekwang', 'copper') + ' — inventing a description they have not seen is worse than a plain one');

        // IT MUST NOT BE SILENT. She said "autocast"; the paper will say
        // "Aluminium Auto Casting Scrap". Finding that out by reading the PDF
        // is a small betrayal.
        pd.clear();
        pd.start('create a proforma for Daekwang, 21 MT of autocasting at 2100');
        const pay = pd.payload();
        ck('the document carries THEIR wording',
           pay.items[0].description === 'Aluminium Auto Casting Scrap', pay.items[0].description);
        ck('  and what she said is kept alongside',
           pay.material_said === 'Auto cast', pay.material_said);
        const sum = pd.summary();
        ck('  the read-back names both', /Aluminium Auto Casting Scrap/.test(sum) && /Auto cast/.test(sum), sum);
        ck('  once, not twice',
           (sum.match(/Aluminium Auto Casting Scrap/g) || []).length === 1, sum);

        // ...and says nothing extra when they agree, which is the common case.
        pd.clear();
        pd.start('create a proforma for Brand New Ltd, 21 MT of autocasting at 2100');
        ck('  and stays quiet when the wording is the same',
           !/\(your /.test(pd.summary()), pd.summary());

        process.env.DATA_DIR = realDir;
        for (const k of Object.keys(require.cache)) {
            if (/helpers\/(json|proformaPricing|proformaDraft)|config\.js$/.test(k)) delete require.cache[k];
        }
        rest();
    })();
}

function rest() {

section('J — the consignee stops at the end of the name');
{
    // FOUND BY WIDENING THE MATERIAL PARSER, not by looking for it. The
    // consignee pattern was greedy and ran through the rest of the sentence:
    // "make a proforma for Daekwang of 21 MT at 8450" produced a consignee of
    // "Daekwang of 21 MT at 8450" — the name printed at the top of a document
    // sent to a customer.
    const consignee = (t) => { d.clear(); return d.start(t).fields.consignee; };
    ck('"for Daekwang of 21 MT at 8450" → Daekwang',
       consignee('make a proforma for Daekwang of 21 MT at 8450') === 'Daekwang',
       'got ' + consignee('make a proforma for Daekwang of 21 MT at 8450'));
    ck('  a comma ends the name',
       consignee('create a proforma for Daekwang, 21 MT of copper at 8450') === 'Daekwang');
    ck('  "at" ends it', consignee('proforma for Hyundai at 2100') === 'Hyundai');
    ck('  a digit ends it', consignee('proforma for Yurim 21 MT of copper rate 900') === 'Yurim');
    ck('  and a two-word name survives',
       consignee('create a proforma for Sung Il, 25 MT of Zorba at 1150') === 'Sung Il',
       'got ' + consignee('create a proforma for Sung Il, 25 MT of Zorba at 1150'));
    ck('  as does one at the end of the sentence',
       consignee('raise a proforma for Kim Metals') === 'Kim Metals');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

}
