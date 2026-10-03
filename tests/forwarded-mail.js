// ── tests/forwarded-mail.js ─────────────────────────────────────────────────
// Apsara, 2026-09-16: "Why all my PO gets ignoredin email?"
// Answered 2026-10-03, by measurement rather than by reading: forwards were
// judged as mail FROM BOSE. scripts/probe-forwards.js ran the real pipeline
// over all eight forwards in a 21-day window and both Metalco purchase
// orders came back is_order false, needs_reply false.
//
// EVERY FIXTURE BELOW IS A REAL BODY, byte for byte off her mailbox via
// helpers/gmail.getEmailContent, CRLFs and all. The signature block is Bose's
// actual signature, because its exact shape (courtesy word alone on a line,
// then contact lines) is what the stripper has to recognise.
const path = require('path');
const R = (p) => path.join(__dirname, '..', p);
// MUST be patched BEFORE replyWatch loads: it destructures callGeminiJSON at
// require time, so a later assignment on the module object is invisible to it.
// (That seam has bitten this repo before -- see the getGmailReadMailboxes note
// in tests/two-mailbox.js.)
const gemini = require(R('helpers/gemini.js'));
let AI = {};
let LAST_PROMPT = '';
gemini.callGeminiJSON = async (prompt) => { LAST_PROMPT = prompt; return AI; };
const rw = require(R('workflow/replyWatch.js'));
const pt = require(R('helpers/poTracker.js'));

let pass = 0, fail = 0;
const failures = [];
function ck(name, cond, detail) {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

// The real one, from Gmail, 2026-10-01.
const BOSE_SIG = 'Regards\r\n\r\nBose\r\n\r\nCEO\r\n\r\nBose@edgemetals.com\r\n\r\nCell:1- 310 938 2525 <(310)%20938-2525>\r\n\r\nFAX:1-425 940 9408 <(425)%20940-9408>\r\n\r\nwww.edgemetals.com\r\n';
const FWD_PO = BOSE_SIG + '\r\n---------- Forwarded message ---------\r\n'
    + 'From: Robert Han <robert@metalcous.com>\r\n'
    + 'Date: Thu, Oct 1, 2026, 4:39 PM\r\n'
    + 'Subject: New P.O. (Edge Metal) EMI-02 & 03\r\n'
    + 'To: bose@edgemetals.com <bose@edgemetals.com>\r\n'
    + 'Cc: James Park <james@metalcous.com>, Sarah Sung <sarah@metalcous.com>\r\n'
    + '\r\n\r\nHi Bose,\r\n\r\nPlease see the attached file for the additional P.O.\r\n'
    + 'If you have any questions, please let me know.\r\n\r\nThank you and best regards,\r\n\r\nRobert\r\nMetalco, Inc.\r\n';

section('FA — parseForward recovers the matter\'s origin');
{
    const f = rw.parseForward(FWD_PO);
    ck('FA1 a forward is recognised', !!f, 'returned null on a real forwarded body');
    ck('FA2 the ORIGINAL sender is recovered, not the forwarder',
        f && /robert@metalcous\.com/i.test(f.from) && !/edgemetals/i.test(f.from),
        f && `from = ${f.from}`);
    ck('FA3 the original date is kept', f && /Oct 1, 2026/.test(f.date || ''), f && `date = ${f.date}`);
    ck('FA4 the forwarded body is the original message, not the signature',
        f && /attached file for the additional P\.O\./.test(f.body) && !/FAX:1-425/.test(f.body),
        f && `body = ${JSON.stringify(String(f.body).slice(0, 80))}`);
    ck('FA5 a bare forward has an EMPTY note (the only non-quoted text was a signature)',
        f && f.note === '', f && `note = ${JSON.stringify(f.note)}`);
}

section('FB — ordinary mail is untouched (the regression that matters most)');
{
    ck('FB1 a plain message is not a forward', rw.parseForward('Can you confirm the 9/12 cutoff?') === null);
    ck('FB2 a quoted REPLY is not a forward',
        rw.parseForward('Yes that works.\r\n\r\nOn Thu, Oct 1, 2026 at 2:11 PM Robert Han <robert@metalcous.com> wrote:\r\n> Hi Bose,\r\n> please see the PO\r\n') === null);
    ck('FB3 a forward marker with NO From line underneath is rejected',
        rw.parseForward('see below\r\n\r\n-----Original Message-----\r\n> mangled quoted chain with no headers\r\n') === null);
    const plain = 'Please confirm container HMMU6298470 before the 8/27 cutoff.';
    ck('FB4 extractLatestMessage leaves plain mail alone', rw.extractLatestMessage(plain) === plain);
}

section('FC — extractLatestMessage puts the matter first, not the fax number');
{
    const v = rw.extractLatestMessage(FWD_PO);
    ck('FC1 the forwarded original survives', /attached file for the additional P\.O\./.test(v), JSON.stringify(v.slice(0, 120)));
    ck('FC2 the forwarder\'s signature is gone', !/FAX:1-425|310 938 2525/.test(v), JSON.stringify(v.slice(0, 120)));
    ck('FC3 the ORIGINAL sender is named in the first thing the model reads',
        /^-{2,} Forwarded message -{2,}\nFrom: Robert Han <robert@metalcous\.com>/.test(v), JSON.stringify(v.slice(0, 80)));
    // IDEMPOTENCE. assess() re-parses the body it is handed, so this transform
    // must survive being applied to its own output.
    ck('FC5 the transform is idempotent', rw.extractLatestMessage(v) === v, JSON.stringify(rw.extractLatestMessage(v).slice(0, 80)));
    ck('FC6 the origin is still recoverable from the transformed body',
        /metalcous\.com/.test((rw.parseForward(v) || {}).from || ''), JSON.stringify((rw.parseForward(v) || {}).from));
    // The measured failure: 437 chars -> 41, which then also tripped the
    // bodyChars < 200 "short body, attachments unread" confidence cap on a
    // message that was not short.
    ck('FC4 the body is not cut down to the forwarder\'s one line', v.length > 200, `length ${v.length}`);
}

section('FD — a forwarder who actually wrote something keeps their note');
{
    const withNote = 'Rudy, next time please copy all these ppl\r\n\r\n' + BOSE_SIG
        + '\r\n---------- Forwarded message ---------\r\nFrom: Rodolfo Mazariegos <rudy@fmcmet.com>\r\n'
        + 'Date: Thu, Oct 1, 2026, 9:02 AM\r\nSubject: 42890 Auto Batteries\r\nTo: bose@edgemetals.com\r\n'
        + '\r\nBose, we can take 42890 auto batteries at $0.42/lb delivered. Confirm by Friday.\r\n';
    const f = rw.parseForward(withNote);
    ck('FD1 the note is kept and the signature stripped out of it',
        f && f.note === 'Rudy, next time please copy all these ppl', f && JSON.stringify(f.note));
    const v = rw.extractLatestMessage(withNote);
    ck('FD2 the original offer leads', /42890 auto batteries at \$0\.42\/lb/.test(v), JSON.stringify(v.slice(0, 90)));
    ck('FD3 the note is carried as context, after the matter',
        v.indexOf('next time please copy') > v.indexOf('$0.42/lb'), JSON.stringify(v.slice(0, 160)));
}

section('FE — stripTrailingSignature is conservative');
{
    ck('FE1 a courtesy line alone is a sign-off',
        rw.stripTrailingSignature('Please confirm the cutoff.\r\n\r\nRegards\r\n\r\nBose\r\nCEO\r\n') === 'Please confirm the cutoff.');
    ck('FE2 "Thanks for sending the BL" is NOT a sign-off',
        /Thanks for sending the BL/.test(rw.stripTrailingSignature('Thanks for sending the BL over, I will check it.')));
    // THE SILENT-DROPPER GUARD. A message whose entire content is "Thanks"
    // must not become empty: the caller does `if (!visible) continue;`, so an
    // over-eager stripper would delete mail with nothing logged.
    ck('FE3 a message that is ONLY a sign-off does not become empty',
        rw.extractLatestMessage('Thanks\r\n\r\nBose\r\n').length > 0,
        JSON.stringify(rw.extractLatestMessage('Thanks\r\n\r\nBose\r\n')));
    ck('FE4 a long passage after a "Thanks" line is kept',
        rw.stripTrailingSignature('Thanks\r\n\r\n' + 'x'.repeat(400)).length > 350);
}

section('FF — PO_REF sees her own numbering scheme');
{
    ck('FF1 EMI-01 is a PO reference', pt.poReferencesIn('New P.O. (Edge Metal) EMI-01').includes('EMI-01'),
        JSON.stringify(pt.poReferencesIn('New P.O. (Edge Metal) EMI-01')));
    const two = pt.poReferencesIn('Fwd: New P.O. (Edge Metal) EMI-02 & 03');
    ck('FF2 "EMI-02 & 03" is TWO orders', two.includes('EMI-02') && two.includes('EMI-03'), JSON.stringify(two));
    ck('FF3 carrier-style digits still match', pt.poReferencesIn('PO 709275').includes('709275'));
    // The false positive the old comment said would recur forever. The naive
    // widening ([A-Z]{2,6}[- ]?\d{1,6} under /i) reintroduces it, because
    // [A-Z] matches "Box". The mandatory hyphen is what holds it out.
    ck('FF4 "P.O. Box 90210" is still not a purchase order',
        pt.poReferencesIn('P.O. Box 90210, Los Angeles CA').length === 0,
        JSON.stringify(pt.poReferencesIn('P.O. Box 90210, Los Angeles CA')));
    ck('FF5 a bare "PO" opens nothing', pt.poReferencesIn('PO from Edge Metals', 'Rental Invoice # 920043344 ... PO#').length === 0);
    ck('FF6 "PO 12" is a quantity, not a reference', pt.poReferencesIn('PO 12').length === 0);
}

section('FG — the prompt tells the model whose matter it is');
{
    const p = rw.buildPrompt({ from: 'Edge Metals Bose <bose@edgemetals.com>', to: 'apsara@edgemetals.com',
        subject: 'Fwd: New P.O. (Edge Metal) EMI-02 & 03', date: '2026-10-01', body: 'x',
        myAddress: 'apsara@edgemetals.com', forwardedFrom: 'Robert Han <robert@metalcous.com>' });
    ck('FG1 the original sender reaches the prompt', /robert@metalcous\.com/.test(p));
    ck('FG2 the model is told not to write "X forwards"', /NEVER write "X forwards/.test(p));
    const q = rw.buildPrompt({ from: 'Andy <andy@mkmetaltrading.com>', to: 'apsara@edgemetals.com',
        subject: 'Re: EDO', date: '2026-10-01', body: 'x', myAddress: 'apsara@edgemetals.com' });
    ck('FG3 ordinary mail gets no forwarding block', !/FORWARDED ON BY THE SENDER/.test(q));
    ck('FG4 the summary instruction now has a FLOOR', /15 to 25 words/.test(q) && /FIFTEEN WORDS IS A FLOOR/.test(q));
}

(async () => {
section('FH — THE HEADLINE FIX: a relayed order is an order');
    // Both Metalco P.O.s scored is_order false in production on 2026-10-03.
    // The model is told is_order true here; what is under test is purely
    // whether assess() lets a FORWARDED order survive its own code gate.
    AI = { waiting_on: 'her', asked_of: null, action_needed: null, key_figures: [],
        needs_reply: true, confidence: 0.8, urgency: 'normal',
        summary: 'Metalco sends purchase orders EMI-02 and EMI-03 for the additional material and wants questions raised.',
        asked_for: 'the additional P.O. reviewed',
        asked_for_quote: 'Please see the attached file for the additional P.O.',
        deadline: null, is_order: true, order_buyer: 'Metalco' };
    const email = {
        from: 'Edge Metals Bose <bose@edgemetals.com>',
        to: 'apsara@edgemetals.com', cc: '',
        subject: 'Fwd: New P.O. (Edge Metal) EMI-02 & 03',
        date: '2026-10-01T16:39:00Z',
        body: rw.extractLatestMessage(FWD_PO),
        attachments: ['EMI-02.pdf'],
        myAddress: 'apsara@edgemetals.com', managerAddress: 'apsara@edgemetals.com',
    };
    const a = await rw.assess(email);
    ck('FH1 the delivery is still correctly internal', a && a.from_internal === true,
        a && `from_internal = ${a.from_internal}`);
    ck('FH2 the MATTER is attributed to the outside sender', a && /metalcous\.com/i.test(a.forwarded_from || ''),
        a && `forwarded_from = ${a.forwarded_from}`);
    ck('FH3 A FORWARDED ORDER IS AN ORDER (was false in production)', a && a.is_order === true,
        a && `is_order = ${a.is_order}`);
    ck('FH4 the prompt it was judged on named Metalco, not Bose',
        /FORWARDED ON BY THE SENDER/.test(LAST_PROMPT) && /robert@metalcous\.com/.test(LAST_PROMPT));

    // THE CONVERSE, which is the clause this must not break: Bose writing to a
    // customer himself is NOT an order. We do not sell to ourselves, and that
    // is the whole reason !fromInternal was there.
    const b = await rw.assess({ ...email, subject: 'Re: JY71 combos',
        body: 'Robert, can you please send me another 42 MT. Also 1 Drums.',
        to: 'robert@metalcous.com', attachments: [] });
    ck('FH5 our own team writing out is still NOT an order', b && b.is_order === false,
        b && `is_order = ${b.is_order}`);
    ck('FH6 and carries no forwarded origin', b && b.forwarded_from === null,
        b && `forwarded_from = ${b.forwarded_from}`);

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED: ' + failures.join(', ')); process.exit(1); }
})();
