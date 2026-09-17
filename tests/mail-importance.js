// ── tests/mail-importance.js ────────────────────────────────────────────────
// Apsara, 2026-09-17: "Basically it should act like an ai assistant which
// watches the mail and notify if there is any improtant mail."
//
// EVERY CASE BELOW IS A REAL EMAIL from the three days I measured before
// building this — 60 emails, 11 shown, 44 dropped, 22 of the dropped carrying
// real consequence. The summaries are what live assess() calls actually
// produced. No invented fixtures: the point of the exercise was that my
// intuitions about her inbox were worth less than her inbox.
const path = require('path');
const R = (p) => path.join(__dirname, '..', p);
const I = require(R('helpers/mailImportance.js'));

let pass = 0, fail = 0;
const failures = [];
function ck(name, cond, detail) {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

// Her real counterparties, from the domain tally over those three days.
const KNOWN = (f) => /eccomelt|zimexglt|schneider|hynos|fmcmet|nicrometals|eagleinbrit|edgemetals|mkmetaltrading|radmetals/i.test(f || '');
const BOOKINGS = {
    DALA25048200: { erd_date: '09/09/2026', cutoff_date: '09/12/2026' },
    DALA61376400: { erd_date: '09/14/2026', cutoff_date: '09/17/2026' },
};
const score = (o) => I.importanceOf({ isKnownCounterparty: KNOWN, bookings: BOOKINGS, ...o });

section('CA — the 22 that were dropped now carry a level');
{
    // THE WORST ONE. This arrived and was dropped; the cutoff it names was
    // that same morning at 10 AM.
    const dg = score({
        from: 'Andy Park <andy@mkmetaltrading.com>',
        subject: 'Re: MK Trading - Battery HMM BKG #DALA61376400 from Los Angeles, CA',
        body: 'Reminding you that the DG SI CUTOFF is September 17 morning at 10 AM. Please provide the DG declaration before then.',
        deadlineDays: 0,
    });
    ck('CA1 a cutoff landing today is critical', dg.level === 'critical', JSON.stringify(dg.level));
    ck('CA2 and it interrupts her', dg.notifyNow === true);
    ck('CA3 naming the sentence that decided it',
        /DG SI CUTOFF is September 17/.test(dg.because), dg.because);

    // An instruction with an obligation and no question mark anywhere. The
    // case that broke my first definition of "admin".
    const obl = score({
        from: '"Rajkumar.Prajapati@EagleInbrit - US" <raj@eagleinbrit.com>',
        subject: '**RELEASE**: **REVISED DRAFT**: Draft Bill of Lading MEDUADA20500',
        body: 'Please print and courier the attached OBL to Mrs. Akansha in Gurugram at your earliest.',
    });
    ck('CA4 an instruction aimed at us is high, not quiet', obl.level === 'high', obl.level);
    ck('CA5 and is never classed as admin', obl.admin === false);

    // waiting_on was 'nobody'. asked_for null. $13,992 of her own money.
    const rem = score({
        from: 'Eccomelt Accounts Payable <ap@eccomelt.com>',
        subject: 'Eccomelt - Payment Remittance - Payment #4004930',
        body: 'Payment ID: 4004930 has been issued for $13,992.00 against invoice 4404951.',
    });
    ck('CA6 a customer remittance is high', rem.level === 'high', rem.level);
    ck('CA7 but does NOT interrupt her — it is good news, not a deadline',
        rem.notifyNow === false);

    const claim = score({
        from: 'Nicro <x@nicrometals.com>',
        subject: 'WEIGHT SHORTAGE CLAIM || REF NO: HB26170A / HB26170B',
        body: 'We are raising a weight shortage claim on container HMMU4892142. Please advise how you wish to proceed.',
    });
    ck('CA8 a claim is critical and interrupts', claim.level === 'critical' && claim.notifyNow);
}

section('CB — a date that MOVED is the one thing allowed to wake her');
{
    // Her explicit choice, 2026-09-17, for consequential mail that is not
    // hers to answer: "Notify me straight away". Kristal asks nothing; she
    // states a new ERD, and by the next digest it can be too late.
    const moved = score({
        from: 'Kristal Sosethan <k@zimexglt.com>',
        subject: 'RE: Need booking from oakland/Busan 2 *40HC with erd 9/9 - DALA25048200',
        body: 'Kristal updates the ERD to 9/21 for booking DALA25048200.',
    });
    ck('CB1 an ERD that differs from the one on file is critical',
        moved.level === 'critical' && moved.notifyNow, JSON.stringify({ l: moved.level, n: moved.notifyNow }));
    ck('CB2 and the alert states BOTH values, not just the new one',
        /we hold 09\/09\/2026/.test(moved.because) && /9\/21/.test(moved.because), moved.because);

    // THE FAILURE MODE THAT WOULD HAVE KILLED THIS FEATURE ON DAY ONE. My
    // first version compared every date in the mail against every stored
    // field, so a mail CONFIRMING the ERD reported that the cutoff had
    // changed — and change is the only signal that pings. The first thing
    // this would have done is wake her for a confirmation.
    const same = score({
        from: 'Kristal Sosethan <k@zimexglt.com>', subject: 'RE: DALA25048200',
        body: 'Confirming the ERD remains 9/9 for booking DALA25048200.',
    });
    ck('CB3 a mail repeating the date we hold is NOT a change',
        !same.signals.some((s) => s.kind === 'change'), JSON.stringify(same.signals.map((s) => s.kind)));
    ck('CB4 and does not interrupt her', same.notifyNow === false);
    const both = score({
        from: 'k@zimexglt.com', subject: 'RE: DALA25048200',
        body: 'ERD stays 9/9 and the cutoff stays 9/12 on DALA25048200.',
    });
    ck('CB5 two fields confirmed is still not a change', both.notifyNow === false);
    // A date with no field word next to it is not a claim about the ERD.
    const loose = score({
        from: 'k@zimexglt.com', subject: 'RE: DALA25048200',
        body: 'We loaded on 9/21 against DALA25048200.',
    });
    ck('CB6 a bare date is not read as a schedule change',
        !loose.signals.some((s) => s.kind === 'change'), JSON.stringify(loose.signals.map((s) => s.kind)));
    // A booking we have never heard of cannot have changed.
    const unknown = score({
        from: 'k@zimexglt.com', subject: 'RE: DALA99999999',
        body: 'ERD is now 9/21 for booking DALA99999999.',
    });
    ck('CB7 an unknown booking is not a change — we held nothing',
        !unknown.signals.some((s) => s.kind === 'change') && unknown.level === 'high', unknown.level);
}

section('CC — "ignore all the mails not related to edgemetals", done safely');
{
    // MEASURED, and it is why this is not a domain rule: over those three
    // days her inbox was zimexglt 8, mkmetaltrading 5, hynos 4, eagleinbrit
    // 3, eccomelt 2, fmcmet 1, nicrometals 1 — the business, none of it on
    // her own domain. A sender-domain filter would have deleted her
    // customers and carriers to remove three Google billing notices.
    const saas = score({
        from: 'billing@some-saas.com', subject: 'Your invoice is ready',
        body: 'Your invoice INV-4023 for $49.00 is due on Oct 1.',
    });
    ck('CC1 a vendor invoice from someone she never emails goes quiet',
        saas.level === 'low' && saas.admin === true, JSON.stringify({ l: saas.level, a: saas.admin }));
    // Identical text, identical figure shape, opposite answer — because the
    // discriminator is who sent it, which is the only thing that separates
    // these two.
    const cust = score({
        from: 'ap@eccomelt.com', subject: 'Payment Remittance',
        body: 'Your invoice INV-4023 for $49.00 is due on Oct 1.',
    });
    ck('CC2 the SAME text from a real counterparty does not',
        cust.level === 'high' && cust.admin === false, JSON.stringify({ l: cust.level, a: cust.admin }));
    ck('CC3 marketing with no signal at all is quiet',
        score({ from: 'promo@saas.com', subject: 'Last chance',
                body: 'Do not let your free trial be cancelled - upgrade today!' }).level === 'low');
    // Admin mail that COSTS her something is not hidden — but it does not
    // ping either. That distinction is deliberate: everything in `critical`
    // interrupts, and marketing writes "your account will be cancelled" all
    // day long.
    const susp = score({
        from: 'billing@some-saas.com', subject: 'Action required',
        body: 'Your account has been suspended due to a failed payment.',
    });
    ck('CC4 a real suspension reaches the digest', susp.level === 'high', susp.level);
    ck('CC5 but does not interrupt her', susp.notifyNow === false);
    // A booking number makes it operational whoever sent it.
    const strange = score({
        from: 'someone@never-seen.com', subject: 'Container HMMU4892142',
        body: 'The container HMMU4892142 has been gated in.',
    });
    // AN INSTRUCTION FROM A SENDER SHE HAS NEVER EMAILED. Reverse-verifying
    // found that the !has('instruction') clause in the admin test produced no
    // failure at all, because every instruction case above came from a known
    // counterparty — so the clause was load-bearing but untested, which is one
    // edit away from being deleted by someone tidying up.
    //
    // This is a real shape: a new forwarder's first mail, or an agent writing
    // on a customer's behalf, telling Edge Metals to do something. No software
    // vendor asks her to courier a Bill of Lading.
    const newForwarder = score({
        from: 'operations@brand-new-forwarder.com',
        subject: 'Draft Bill of Lading MEDUADA20500',
        body: 'Please print and courier the attached OBL to Mrs. Akansha in Gurugram at your earliest.',
    });
    ck('CC6 an instruction from an unknown sender is not demoted to admin',
        newForwarder.admin === false && newForwarder.level === 'high',
        JSON.stringify({ a: newForwarder.admin, l: newForwarder.level }));
    // The same unknown sender with no instruction, no strong reference and
    // just a figure IS the admin shape, and must go quiet.
    const newVendor = score({
        from: 'operations@brand-new-forwarder.com', subject: 'Our rates',
        body: 'Our handling fee is $250.00 per container.',
    });
    ck('CC6b the same unknown sender with only a figure does go quiet',
        newVendor.admin === true && newVendor.level === 'low',
        JSON.stringify({ a: newVendor.admin, l: newVendor.level }));

    ck('CC7 a live container reference beats the unknown sender',
        strange.admin === false, JSON.stringify(strange.refs));
    // No predicate supplied must fail towards NOISE, never towards silence.
    const noPred = I.importanceOf({ from: 'billing@some-saas.com', subject: 'x',
                                    body: 'Your invoice INV-4023 for $49.00 is due.' });
    ck('CC8 with no counterparty record, nothing is demoted',
        noPred.admin === false && noPred.level === 'high', JSON.stringify({ a: noPred.admin, l: noPred.level }));
}

section('CD — evidence, not vibes');
{
    // Every signal must produce a sentence the sender actually wrote. This is
    // the same rule asked_for_quote enforces, for the same reason: a model
    // cannot be asked to be sure, only to point at something.
    const r = score({ from: 'ap@eccomelt.com', subject: 'Payment',
                      body: 'Payment ID: 4004930 has been issued for $13,992.00.' });
    ck('CD1 every signal carries a quote', r.signals.every((s) => s.quote && s.quote.length >= 12),
        JSON.stringify(r.signals));
    ck('CD2 the quote is the sender\'s own sentence',
        r.signals.some((s) => /issued for \$13,992\.00/.test(s.quote)), JSON.stringify(r.signals));
    // Keywords with no sentence around them are not evidence. This is why
    // the matchers are sentence-scoped: "payment" is in every footer in
    // this industry.
    const bare = score({ from: 'ap@eccomelt.com', subject: 'payment', body: 'ok' });
    ck('CD3 a bare keyword with no sentence is not a money signal',
        !bare.signals.some((s) => s.kind === 'money'), JSON.stringify(bare.signals));
    // The summary is NEVER an input. Scoring importance off the model's own
    // output would be the model grading itself — the circularity that made
    // confidence worthless (1.0 on 16 of 16 live emails).
    const src = require('fs').readFileSync(R('helpers/mailImportance.js'), 'utf8');
    ck('CD4 importanceOf takes no summary', !/\bsummary\b\s*[,=:]/.test(src.split('function importanceOf')[1].split('\n').slice(0, 12).join('\n')));
}

console.log(`\n================================================================`);
console.log(`${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILED:'); failures.forEach((f) => console.log(`  - ${f}`)); }
process.exit(fail ? 1 : 0);
