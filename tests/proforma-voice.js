// ── tests/proforma-voice.js ───────────────────────────────────────────────
// Apsara, 2026-09-06: "if i ask jarvis to create proforma, it should create
// that .. it can ask whatever data is needed from me .. Then it can create
// and preview me the proforma. post my voice confirmation - it can generate."
//
// tests/proforma-draft.js proves the SLOT FILLING — what gets asked, what
// gets defaulted, and that a rate is never invented. This file proves the
// two things that only matter once it is wired to a voice:
//
//   1. THE DRAFT OWNS THE CONVERSATION while it is open. "Daekwang" said in
//      the middle of raising an invoice is an ANSWER, not a question about a
//      seller. Without this it goes to the router, scores as yard
//      vocabulary, reaches Scout, and she gets "no loads for Daekwang" in
//      the middle of a document.
//
//   2. NOTHING IS SENT. The preview is a preview. Every irreversible step in
//      this system is proposed and confirmed, and a document with a price on
//      it going to a customer is the most irreversible thing here.
//
// The generator is the REAL one — helpers/proformaPdf.js, the same one her
// existing proformas go through. A preview rendered by a different path is
// not a preview of what will be sent.

const path = require('path');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const pro = require(path.join(ROOT, 'helpers/proformaDraft.js'));
const { buildProformaDc2Html } = require(path.join(ROOT, 'helpers/proformaPdf.js'));

console.log('\n─ a proforma, raised by voice ───────────────────────────────');

section('A — the document is the REAL one');
{
    pro.clear();
    pro.start('create a proforma for Daekwang, 21 MT of copper at 8450 per MT');
    const built = buildProformaDc2Html(pro.pdfPayload());
    const html = built && built.html ? built.html : '';

    ck('the generator accepts the payload', html.length > 0,
       'a shape it half-accepts renders a document with empty fields on it');
    ck('  the consignee is on it', html.indexOf('Daekwang') !== -1);
    ck('  the material', html.indexOf('copper') !== -1);
    ck('  the rate, formatted as money', html.indexOf('8,450.00') !== -1);
    ck('  and the total', html.indexOf('177,450.00') !== -1,
       '21 x 8450 = 177,450 — the arithmetic a customer checks first');
    ck('  with the trade term', html.indexOf('CIF') !== -1);

    // The generator computes its own total. If it disagrees with the one
    // read aloud, she approved a different number from the one on the page.
    ck('the spoken total matches the printed one',
       built.totalDue === pro.payload().total,
       'spoken ' + pro.payload().total + ' vs printed ' + built.totalDue);
    ck('  and so does the quantity', built.totalQty === pro.payload().items[0].qty);
}

section('B — THE DRAFT OWNS THE CONVERSATION');
{
    // The failure this prevents: mid-proforma, she says a consignee name,
    // and the router reads it as a yard question.
    pro.clear();
    pro.start('create a proforma');
    ck('a draft is open', !!pro.current());

    const q = pro.nextQuestion();
    ck('  and it is asking something', typeof q === 'string' && q.length > 0, q);

    // A bare name, which is EXACTLY what would otherwise route to Scout.
    pro.answer('Daekwang');
    ck('  a bare name is taken as the answer, not a new question',
       pro.current().fields.consignee === 'Daekwang',
       JSON.stringify(pro.current().fields));

    // And a word that IS yard vocabulary.
    pro.answer('copper');
    ck('  and so is a material that is also a yard word',
       pro.current().fields.material === 'copper',
       '"copper" mid-proforma is an answer; routed to Scout it becomes a stock question');
}

section('C — NOTHING IS SENT, AND NOTHING IS FINISHED EARLY');
{
    pro.clear();
    pro.start('create a proforma for X, copper');
    ck('an incomplete draft has no preview to offer', pro.nextQuestion() !== null,
       'it must ask for the rate rather than build a document without a price');

    // A missing rate must never render as zero or blank.
    const p = pro.payload();
    ck('  and its payload has no usable total yet',
       !Number.isFinite(p.total) || p.total === 0 || Number.isNaN(p.total),
       'total is ' + p.total + ' — a document showing $0.00 would look finished');
}

section('D — the read-back she confirms against');
{
    pro.clear();
    pro.start('proforma for Daekwang, 21 MT of copper at 8450 per MT');
    const s = pro.summary();
    // Everything she is agreeing to must be IN the sentence she hears,
    // because the confirmation is spoken and she may not be looking.
    for (const bit of ['Daekwang', 'copper', '21 MT', '$8,450.00', '$177,450.00', 'CIF']) {
        ck(`the read-back names ${bit}`, s.indexOf(bit) !== -1, s);
    }
    ck('  and it stays short enough to listen to', s.length < 220, s.length + ' chars');
}

section('E — a default is visible as a default');
{
    pro.clear();
    pro.start('proforma for Joey, copper at 8000 per MT');
    const p = pro.payload();
    ck('the tonnage was defaulted', p.defaulted.indexOf('mt') !== -1);
    ck('  the terms too', p.defaulted.indexOf('payment_terms') !== -1
       && p.defaulted.indexOf('shipment_terms') !== -1);
    // Checked against what formatQty ACTUALLY produces ("21.00"), not the
    // format I assumed. Guessing at a renderer's output is how a test comes
    // to fail on correct code.
    ck('  and they still reach the document',
       buildProformaDc2Html(pro.pdfPayload()).html.indexOf('>21.00<') !== -1,
       'a default that never reaches the page is a silently empty field');

    pro.clear();
    pro.start('proforma for Joey, 25 MT copper at 8000 per MT, FOB');
    const p2 = pro.payload();
    ck('what she said is NOT marked as defaulted',
       p2.defaulted.indexOf('mt') === -1 && p2.defaulted.indexOf('shipment_terms') === -1,
       JSON.stringify(p2.defaulted));
    ck('  and FOB changes the freight label on the document',
       /FOB \(freight excluded\)/.test(pro.pdfPayload().freight_label),
       pro.pdfPayload().freight_label);
}

section('F0 — the decision, EXECUTED');
{
    // Section F below still checks the ORDER of things in api.js, which is a
    // source-level property and can only be read. But the DECISION itself is
    // now a function, and these run it — because two mutations survived the
    // whole suite when this was inline and only grepped: the flow turned off
    // entirely, and the draft restarted on every answer so it never finished.
    pro.clear();
    ck('an unrelated question is not the proforma flow',
       pro.handle('how much do we owe acme') === null,
       'claiming every utterance would swallow the whole assistant');
    ck('  nor is sending an existing one', pro.handle('send the proforma to Joey') === null);

    const s1 = pro.handle('jarvis create a proforma');
    ck('"create a proforma" IS', s1 && s1.stage === 'asking', JSON.stringify(s1));
    ck('  and it asks for the consignee', /consignee/i.test(s1.say), s1.say);

    // THE ONE THAT SURVIVED. Each answer must ADVANCE the draft, not restart
    // it — a restart means it asks the same question for ever.
    const s2 = pro.handle('Daekwang');
    ck('an answer advances rather than restarting',
       s2 && s2.stage === 'asking' && !/consignee/i.test(s2.say),
       'asked again: ' + (s2 && s2.say) + ' — a restart loops on the first question for ever');
    ck('  and the answer was kept', pro.current().fields.consignee === 'Daekwang');

    const s3 = pro.handle('copper');
    ck('  next it asks the rate', /rate/i.test(s3.say), s3.say);
    const s4 = pro.handle('8450');
    ck('and then it previews', s4 && s4.stage === 'preview', JSON.stringify(s4 && s4.stage));
    ck('  with a payload the generator can render',
       !!buildProformaDc2Html(s4.pdf).html, 'the preview must be the real document');
    ck('  naming the total', /177,450/.test(s4.summary), s4.summary);
    ck('  and telling her how to send it', /send it/i.test(s4.say), s4.say);

    // Once previewed, the draft is still open — she may correct it.
    const s5 = pro.handle('actually make it 25 MT');
    ck('a correction after the preview is taken',
       s5 && s5.stage === 'preview' && /25 MT/.test(s5.summary), s5 && s5.summary);
    ck('  and the total is recalculated', /211,250/.test(s5.summary),
       '25 x 8450 = 211,250 — a stale total is the number she would approve');
}

section('F — the wiring in api.js');
{
    // Read rather than executed: standing the whole server up for this needs
    // Gmail, WhatsApp and a Gemini key. What matters is the ORDER — the
    // draft is consulted BEFORE the router, or a mid-proforma answer goes to
    // the wrong assistant.
    const all = require('fs').readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    // SCOPED TO THE VOICE HANDLER. My first version searched the whole file
    // and compared against the FIRST askYard require anywhere in it — which
    // belongs to /api/yard/ask, a different endpoint several hundred lines
    // earlier. The test failed on correct code, which is the same class of
    // mistake as a test passing on broken code.
    // Bounded by the NEXT route registration, whatever it happens to be.
    // My first attempt bounded it with the phrase endpoint, which sits
    // BEFORE this one in the file — so the slice was empty and the test
    // failed on correct code. Twice now in this section: guessing at file
    // layout instead of reading it.
    const from = all.indexOf("app.post('/api/voice/ask'");
    const nextRoute = all.indexOf('\n    app.', from + 10);
    const to = nextRoute === -1 ? all.length : nextRoute;
    ck('the voice endpoint was found', from !== -1 && to > from,
       'from ' + from + ' to ' + to);
    const src = all.slice(from, to);

    const iDraft = src.indexOf("require('./helpers/proformaDraft')");
    const iScout = src.indexOf("require('./helpers/yardAsk')");
    const iBrain = src.indexOf("require('./workflow/brain')");
    ck('the proforma draft is consulted', iDraft !== -1);
    ck('  BEFORE Scout', iDraft !== -1 && iScout !== -1 && iDraft < iScout,
       'otherwise "Daekwang" mid-proforma becomes a yard question');
    ck('  and before the brain', iDraft !== -1 && iBrain !== -1 && iDraft < iBrain);
    ck('  and it never sends at the preview stage',
       !/proforma[\s\S]{0,400}sendMail|sendProforma/.test(src.slice(iDraft, iDraft + 2000)),
       'the preview must be a preview');
    // The wording lives with the decision now, in helpers/proformaDraft.js,
    // and F0 above asserts it on the value actually returned. Checking api.js
    // for it would only assert where the code happens to sit.
    const draftSrc = require('fs').readFileSync(path.join(ROOT, 'helpers/proformaDraft.js'), 'utf8');
    ck('  the preview says how to confirm', /say "send it"/.test(draftSrc),
       'a preview with no stated way forward is a dead end');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
