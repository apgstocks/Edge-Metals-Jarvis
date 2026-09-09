// ── tests/booking-request.js ──────────────────────────────────────────────
// Apsara, 2026-09-06: "if i say jarvis,send a mail to say yurim,asking for a
// booking -it should ask how many containers... It can learn the pattern of
// how generally i ask for booking in my mail and then mimic my behaviour-the
// tone."
//
// WHAT WAS ALREADY THERE, AND IT IS MOST OF IT
// --------------------------------------------
// draftEmailForConfirm resolves the recipient from her address book, drafts
// the body through Gemini WITH helpers/writingStyle.js applied — that IS the
// tone mimicry, and it has been wired for weeks — and sends only on "yes".
// It also carries real scar tissue from August: a hallucinated
// "mike@example.com" recipient and an invented "I miss you" body, both caught
// live, both now guarded.
//
// The gap was the ONE QUESTION. A booking request with no quantity was
// drafted and sent anyway, and a carrier reading "please book us space" with
// no number replies asking how many. That is a day gone.
//
// WHAT THIS FILE GUARDS
// ---------------------
// Three things, in order of how badly they fail:
//   1. the detection, because a false positive interrupts an ORDINARY email
//      with "how many containers?" — the kind of thing that makes someone
//      stop using an assistant
//   2. the count parsing, because a wrong number is a real commitment to a
//      shipping line
//   3. the handover, because an answer that does not reach the pending gets
//      reclassified as a brand new request — a bug this codebase has already
//      hit once, documented in brain.js as the "Schedule this mail" incident

const path = require('path');
const fs = require('fs');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
process.env.DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const br = require(path.join(ROOT, 'helpers/bookingRequest.js'));

console.log('\n─ asking a carrier for space ────────────────────────────────');

section('A — is she asking for a booking?');
{
    // HER SENTENCE, and the ways round it she would actually use.
    for (const t of [
        'send a mail to Yurim asking for a booking',
        'ask Yurim for a booking',
        'email Yurim asking for a booking',
        'request space from MSC for next week',
        'see if Yurim can give us a booking',
        'check with Yurim for a slot',
        'ask MSC for allocation',
    ]) ck(`"${t}"`, br.isRequest(t) === true);
}

section('B — and everything it must NOT interrupt');
{
    // A false positive here asks "how many containers?" in the middle of an
    // unrelated email. That is worse than the bug being fixed, because the
    // bug only costs a round trip with a carrier while this costs her trust
    // in the whole flow.
    for (const t of [
        // Chasing a booking she ALREADY has. Answering this with "how many
        // containers?" is nonsense — the containers exist.
        'email Yurim about booking DALA123 cutoff',
        'ask Zimex about booking MEDUX9988',
        'email Zimex checking in',
        'send Yurim the proforma',
        'reply to Yurim saying we will confirm tomorrow',
        // BOOKING VOCABULARY, NO ASKING VERB. These are why isRequest needs
        // BOTH halves — a mutation dropping the verb test left every other
        // negative in this list passing, because they were all caught by the
        // existing-booking guard instead.
        'tell Yurim we got the booking',
        'forward the booking to Sher Trucking',
        'send Yurim the booking confirmation',
        'let Yurim know there is no space this week',
        'tell Sher Trucking the container is ready',
        'email accounts about the invoice',
        '',
    ]) ck(`"${t || '(nothing)'}" is not a booking request`, br.isRequest(t) === false);
}

section('C — how many, read out of a sentence');
{
    // containersIn is the STRICT one: it reads a count out of a sentence she
    // was not asked a question about, so a bare number must not count.
    const cases = [
        ['ask Yurim for a booking, 2 containers', 2, null],
        ['ask Yurim for 2x40HC', 2, '40HC'],
        ['ask Yurim for 3 x 40HC', 3, '40HC'],
        ['request two 40 high cubes from MSC', 2, '40HC'],
        ['ask for a couple of 40HCs', 2, '40HC'],
        ['book us 4 20GP', 4, '20GP'],
        ['ask Yurim for 2 x 45HC', 2, '45HC'],
    ];
    for (const [t, n, sz] of cases) {
        const got = br.containersIn(t);
        ck(`"${t}" → ${n}${sz ? ' ' + sz : ''}`,
           got.count === n && got.size === sz, JSON.stringify(got));
    }

    // "2x40HC" is the single most compact way she writes this, and it FAILED
    // — SIZE was anchored with \b and there is no word boundary between the
    // "x" and the "4". Found by running the parser, not by reading it.
    ck('the compact form works at all', br.containersIn('2x40HC').count === 2,
       'the \\b-anchored size could never match after an "x"');

    // What must NOT be read as a count.
    for (const t of ['call me in 2 hours', 'ask Yurim for a booking', 'two', '2']) {
        ck(`"${t}" yields no count from a sentence`, br.containersIn(t).count === null,
           JSON.stringify(br.containersIn(t)) + ' — a bare number in a sentence is usually not containers');
    }
    // 40 is a SIZE, not forty containers.
    ck('"40HC" alone is a size, not a count',
       br.containersIn('ask for 40HC').count === null
       && br.containersIn('ask for 40HC').size === '40HC');
    // Absurd counts are refused rather than sent to a carrier.
    ck('a three-digit count is refused',
       br.containersIn('ask for 400 containers').count === null,
       'far more likely a misheard year than the largest booking her company has made');
    ck('  and zero', br.containersIn('ask for 0 containers').count === null);
}

section('D — how many, ANSWERING the question');
{
    // Once "How many containers?" has been asked, the whole reply is the
    // answer, and "two" is what a person says. Refusing it would be the
    // assistant not listening — so this is a SEPARATE function, and the
    // difference between the two is whether the question was asked.
    for (const [t, n, sz] of [
        ['two', 2, null], ['2', 2, null], ['Two.', 2, null],
        ['2 containers', 2, null], ['just 3', 3, null], ['only two', 2, null],
        ['2x40HC', 2, '40HC'], ['two 40 high cubes', 2, '40HC'],
        ['a couple of 40HCs', 2, '40HC'], ['4 please', 4, null],
    ]) {
        const got = br.countInAnswer(t);
        ck(`"${t}" → ${n}${sz ? ' ' + sz : ''}`, got.count === n && got.size === sz,
           JSON.stringify(got));
    }

    // AND IT STILL REFUSES. An unreadable answer re-asks; it does not default
    // to one container and commit her to a carrier.
    for (const t of ['next tuesday', 'call me in 2 hours', 'whatever they have', '', '40HC',
        // A trailing number in an unrelated reply. These are what the ^
        // anchor is for — without it "ready in 3" reads as three containers,
        // and every other reject in this list is caught by the tail pattern
        // instead, so the anchor looked untested.
        'ready in 3', 'call me at 4', 'we discussed 2']) {
        ck(`"${t || '(nothing)'}" is not a count`, br.countInAnswer(t).count === null,
           JSON.stringify(br.countInAnswer(t)));
    }
    ck('  though a size-only reply keeps the size for the re-ask',
       br.countInAnswer('40HC').size === '40HC');

    // THE BUG THIS ALMOST WAS. The resolver first used containersIn, which
    // refuses a bare "two" — so the commonest possible answer would have been
    // re-asked for ever.
    const acts = fs.readFileSync(path.join(ROOT, 'workflow/actions.js'), 'utf8');
    // Bounded by the NEXT pending's handler rather than by a character count.
    // The window was 1200 chars and the cutoff branch, added above the count
    // branch on 2026-09-09, pushed countInAnswer past it — a green assertion
    // turning red because correct code moved, which is the third time a
    // fixed-width slice has done that in this suite.
    const segFrom = acts.indexOf("pending.type === 'await_booking_details'");
    const segTo = acts.indexOf("pending.type === 'confirm_proforma'", segFrom);
    const seg = acts.slice(segFrom, segTo);
    ck('the resolver uses countInAnswer, not containersIn',
       /br\.countInAnswer\(said\)/.test(seg),
       'containersIn refuses a bare "two" — the resolver would loop for ever on the commonest reply');
}

section('D2 — the question itself');
{
    const q = br.ask('Yurim');
    ck('it names the recipient', /Yurim/.test(q), q);
    ck('  asks the one thing', /how many containers/i.test(q), q);
    ck('  and offers the shape of a useful answer without demanding it',
       /40\s*high\s*cube|40HC/i.test(q) && /if it matters/i.test(q), q);
    ck('  short enough to be spoken', q.length < 140, q.length + ' chars');
    ck('  and it copes with no name', /them/.test(br.ask(null)), br.ask(null));
}

section('E — what the drafter is told');
{
    const d = br.details(2, '40HC', 'ask Yurim for a booking please');
    ck('the count is stated', /\b2x40HC\b/.test(d), d);
    ck('  as a sentence the drafter may not reword',
       /exact/i.test(d) && /do not[\s\S]{0,80}re-?word/i.test(d),
       'every figure in that line is a commitment to a carrier');
    ck('  with her original words kept', /ask Yurim for a booking please/.test(d), d);
    ck('  and the routing words stripped',
       !/^\s*hey jarvis/i.test(br.details(2, null, 'Hey Jarvis, send an email to Yurim asking for a booking from Houston')),
       br.details(2, null, 'Hey Jarvis, send an email to Yurim asking for a booking from Houston'));

    // ── HER SENTENCE, HER WORDS ──────────────────────────────────────────
    // Apsara, 2026-09-09: "I want jarvis to communicate in similar terms like
    // need bookings from Houston to Busan 1x40HC with cut off as [date].
    // [Optional:ERD]" — checked against that shape literally, because the
    // point of it is that it reads the way she writes and not the way a
    // language model would summarise her.
    const full = br.line({
        from: 'Houston', to: 'Busan', count: 1, size: '40HC',
        cutoff: br.cutoffInAnswer('the 20th', new Date('2026-09-09T12:00:00-07:00')),
    });
    ck('the line is the one she asked for',
       /^Need bookings from HOUSTON to BUSAN 1x40HC with cut off as \d{1,2} \w{3} \d{4}\.$/.test(full), full);
    ck('  ERD rides along when it is known, and only then',
       / ERD 15 Sep 2026\.$/.test(br.line({ count: 1, size: '40HC', erd: new Date(Date.UTC(2026, 8, 15, 19)) }))
       && !/ERD/.test(full), full);
    ck('  a missing cutoff is left out, not written as a blank',
       br.line({ from: 'Houston', to: 'Busan', count: 2, size: '40HC' })
           === 'Need bookings from HOUSTON to BUSAN 2x40HC.',
       br.line({ from: 'Houston', to: 'Busan', count: 2, size: '40HC' }));
    // "3xcontainers" is not English and not a booking request. Found by
    // printing the output rather than by reading the code.
    ck('  and with no size it falls back to words',
       br.line({ count: 3 }) === 'Need bookings 3 containers.', br.line({ count: 3 }));
    ck('  one container is singular', /1 container\./.test(br.line({ count: 1 })), br.line({ count: 1 }));

    // The count and size are FACTS handed over, not prose to embellish. Tone
    // is writingStyle.js's job and must not be duplicated here.
    // COMMENTS STRIPPED. This failed against correct code because the file's
    // own comment says "whether she says 'kindly'" — I matched my own prose,
    // for the third time this session. A check that reads commentary is
    // checking the wrong thing.
    const helperCode = fs.readFileSync(path.join(ROOT, 'helpers/bookingRequest.js'), 'utf8')
        .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    ck('the helper does not write the email itself',
       !/dear|regards|kindly|best wishes/i.test(helperCode),
       'the wording is writingStyle.js\'s job — a second voice here would drift from hers');
}

section('E2 — the dates, and the timezone that got one wrong');
{
    const now = new Date('2026-09-09T12:00:00-07:00');
    const f = br.forCarrier;

    // ── THE BUG THIS SECTION EXISTS FOR ──────────────────────────────────
    // "cutoff 20 sep" came back as "21 Sep 2026". chrono had it right —
    // 2026-09-20T19:00Z is midday in Houston — and then .getDate() read that
    // instant in the SERVER's timezone, which on the box I measured on is
    // Asia/Calcutta, where it is already half past midnight on the 21st.
    //
    // Run under four zones on purpose. A single-zone assertion passes on the
    // developer's machine and ships a cutoff a day out, which is a booking
    // request for a vessel that has sailed.
    const zones = ['America/Los_Angeles', 'Asia/Calcutta', 'UTC', 'Pacific/Auckland'];
    const seen = new Set();
    for (const tz of zones) {
        const before = process.env.TZ;
        process.env.TZ = tz;
        // laParts asks Intl each time, so no module cache to bust — but the
        // Date constructor does read process.env.TZ lazily on some builds, so
        // the value is recomputed rather than reused from an earlier loop.
        seen.add(f(br.cutoffInAnswer('sept 20', now)));
        process.env.TZ = before;
    }
    ck('the same date in four timezones is the same date',
       seen.size === 1 && seen.has('20 Sep 2026'), [...seen].join(' | '));

    ck('a cutoff is written unambiguously for a carrier',
       /^\d{1,2} \w{3} \d{4}$/.test(f(br.cutoffInAnswer('the 20th', now))),
       '"09/20/2026" is 9 December to half the world, and this mail goes to Korea');
    ck('  while the store keeps her own MM/DD/YYYY',
       br.forStore(br.cutoffInAnswer('the 20th', now)) === '09/20/2026',
       'bookings.json is US-format and must not be changed under her');

    // ── LABELLED ONLY ────────────────────────────────────────────────────
    // A date in a sentence is not a cutoff unless she said it was. "send it
    // tomorrow" is a SCHEDULE — resolveScheduledFor's job — and reading it as
    // a cutoff puts a wrong date in front of a carrier.
    ck('a bare date in a sentence is NOT a cutoff',
       br.datesIn('ask zimex for space and send it tomorrow', now).cutoff === null,
       '"send it tomorrow" schedules the send, it does not close the vessel');
    ck('  but a labelled one is',
       f(br.datesIn('ask zimex for space, cut off the 20th', now).cutoff) === '20 Sep 2026');
    ck('  and two labels in one sentence do not collide',
       f(br.datesIn('cutoff 20 sep, erd the 15th', now).cutoff) === '20 Sep 2026'
       && f(br.datesIn('cutoff 20 sep, erd the 15th', now).erd) === '15 Sep 2026',
       JSON.stringify(br.datesIn('cutoff 20 sep, erd the 15th', now)));

    // Once the question HAS been asked, the whole reply is the answer — the
    // same asymmetry as countInAnswer, and for the same reason.
    ck('an answer to the question needs no label', f(br.cutoffInAnswer('the 20th', now)) === '20 Sep 2026');
    ck('  chrono returns null for a bare day of the month, so it is handled here',
       require('../helpers/time').parseNaturalTime('the 25th', now) === null
       && f(br.cutoffInAnswer('the 25th', now)) === '25 Sep 2026',
       'one of the commonest ways she says a near date');
    ck('  a day already past rolls to next month',
       f(br.cutoffInAnswer('the 5th', now)) === '5 Oct 2026', f(br.cutoffInAnswer('the 5th', now)));
    ck('  and a day that month does not have is skipped, not rolled',
       f(br.cutoffInAnswer('the 31st', now)) === '31 Oct 2026',
       'September has 30 days; new Date(y,8,31) is 1 Oct, which is not the date she said');
    ck('  something with no date in it is refused, not defaulted',
       br.cutoffInAnswer('soon', now) === null && br.cutoffInAnswer('', now) === null);

    // ── A HEDGE IS NOT A DATE ────────────────────────────────────────────
    // Straight out of her own sentence: "cut off us somewhere next week
    // someday in next week". chrono returns Wednesday the 16th for that — a
    // specific, confident date she never said, which would then be written to
    // a carrier as "with cut off as 16 Sep 2026".
    for (const t of ['cut off us somewhere next week', 'cutoff sometime next week',
                     'cutoff around the 20th', 'cutoff early next week',
                     'cut off maybe friday', 'cutoff mid october']) {
        ck(`  "${t}" is a range, so it asks rather than picking a day`,
           br.datesIn(t, now).cutoff === null, f(br.datesIn(t, now).cutoff));
    }
    ck('  while a definite one still lands', f(br.datesIn('cut off the 20th', now).cutoff) === '20 Sep 2026');
}

section('E2b — she named a party, so it is not a search');
{
    // Her screenshot, 2026-09-09. The predicate that stops three different
    // code paths claiming "send email to Wimax asking for booking from
    // Houston" as a bookings query. Both directions asserted, because the
    // fix is only worth anything if ordinary searches survive it.
    for (const t of ['send email to Wimax asking for booking from Houston to Busan',
                     'send email to Wimax asking for booking from Houston',
                     'ask yurim for a booking from oakland',
                     'email zimex asking for space from houston',
                     'send a mail to zimex, asking for space out of HOUSTON',
                     'check with MSC about space from LA',
                     'write to zimex for a booking from houston',
                     'drop a line to yurim for space out of houston']) {
        ck(`  "${t}" names someone to ask`, br.isRequestToSomeone(t) === true);
    }
    for (const t of ['show me bookings from houston', 'any bookings from houston',
                     'check bookings from houston', 'check the bookings for houston',
                     'available bookings from oakland', 'see bookings from LA',
                     'bookings from houston with cutoff next week',
                     'how many bookings from houston',
                     'forward the houston booking to the trucker',
                     'what is the cutoff on the oakland booking']) {
        ck(`  "${t}" is a question for Jarvis`, br.isRequestToSomeone(t) === false);
    }
    // The two carve-outs, each earning its place.
    ck('  a booking she already HAS is not a request for new space',
       br.isRequestToSomeone('ask Zimex about booking MEDUX9988') === false,
       'chasing an existing booking is a relay, not a fresh request');
    ck('  and the thing asked FOR is never read as the party asked',
       br.isRequestToSomeone('check the bookings for houston') === false,
       'without NOT_A_PARTY, "bookings" becomes the recipient and a real search gets vetoed');
}

section('E2b2 — a company is not called "Zimex asking"');
{
    // ── A RECORDED LIVE INCIDENT ─────────────────────────────────────────
    // api.js: "'to zimex asking for space' made the recipient 'zimex asking',
    // with an address invented to match. The draft went to a contact that does
    // not exist." That was fixed by putting a comma in the sentence JARVIS
    // writes for itself — which protects exactly that one sentence. Apsara
    // then said, with no comma anywhere: "send email to Wimax asking for
    // booking from Houston to Busan".
    //
    // TESTED DIRECTLY, and that is the point of this section. There are two
    // guards against this shape now — the classifier stub stops at "asking",
    // and actions.js trims it afterwards — and a mutation that removed the
    // production one SURVIVED, because the stub was quietly covering for it.
    // Belt and braces are only worth having if each is known to hold alone.
    const trim = require(path.join(ROOT, 'workflow/actions.js')).trimTrailingConnective;
    ck('"Wimax asking" is Wimax', trim('Wimax asking') === 'Wimax');
    ck('  "zimex asking for" is zimex', trim('zimex asking for') === 'zimex',
       'both connectives go, not just the last one');
    ck('  "Sher Trucking regarding" keeps the two-word name',
       trim('Sher Trucking regarding') === 'Sher Trucking');
    ck('  and a real name is left completely alone',
       trim('MK Metal Trading') === 'MK Metal Trading' && trim('Bayou Haulage') === 'Bayou Haulage');
    ck('  a single word is never trimmed away',
       trim('asking') === 'asking' && trim('for') === 'for',
       'losing the only word there is guarantees a failure; trimming it only risks one');
    ck('  and nothing in, nothing out', trim('') === '' && trim(null) === '');
}

section('E2c — a whole sentence is not a place');
{
    // helpers/booking.js:localityMatchesPort was `l.includes(p) || p.includes(l)`,
    // so her 96-character sentence "matched" the port of Houston — and
    // workflow/brain.js calls it to decide a phrase is "unambiguously a
    // location query". The guard was not weak, it was inert.
    const bk = require(path.join(ROOT, 'helpers/booking.js'));
    const n = (s) => bk.queryBookingsByLocation(s, undefined).count;
    ck('a sentence mentioning Houston does not match Houston',
       n('houston to bhushan with erd as yesterday and cut off us somewhere next week someday in next week') === 0,
       'this is the sentence from her screenshot');
    ck('  while the place itself still does', n('houston') === 2);
    ck('  with her extra words allowed', n('Houston, TX') === 2 && n('port of houston') === 2);
    ck('  and a multi-word port', n('los angeles') === 1);
    ck('  and nothing is not somewhere', n('') === 0);

    // ── TESTED ON THE FUNCTION, NOT THROUGH HER DATA ─────────────────────
    // The whole-word rule cannot be reached through bookings.json: her LOAD
    // ports are Houston, Los Angeles and Oakland, and none of them contains
    // another one as a fragment. Asserting `n('san') === 0` therefore proved
    // nothing — a mutation that put fragment matching back survived it,
    // because "san" finds no load port either way. BUSAN is her DISCHARGE
    // port, which this function never sees.
    //
    // So the pairs are named directly. localityMatchesPort was exported for
    // this: a rule that only holds for today's four bookings is not a rule.
    const L = bk.localityMatchesPort;
    ck('a fragment is not a match — "san" is not BUSAN',
       L('BUSAN', 'san') === false,
       'the substring version matched, so "bookings from San" would answer about Busan');
    ck('  nor the other way round', L('san', 'BUSAN') === false);
    ck('  exact still matches', L('HOUSTON', 'houston') === true);
    ck('  and a word she adds', L('HOUSTON', 'houston tx') === true && L('HOUSTON, TX', 'houston') === true);
    ck('  multi-word ports match on all their words',
       L('LOS ANGELES', 'los angeles') === true && L('LOS ANGELES', 'angeles') === true);
    ck('  but not on just any one of them',
       L('LOS ANGELES', 'new los santos angeles beach city') === false,
       'a place is a couple of words longer at most, not a clause');
    ck('  a sentence is never a place',
       L('HOUSTON', 'houston to bhushan with erd as yesterday and cut off next week') === false,
       'this is the exact string from her screenshot');
    ck('  and neither side may be empty', L('', 'houston') === false && L('HOUSTON', '') === false);
}

section('E3 — what her own bookings will and will not tell you');
{
    // MEASURED, NOT ASSUMED. Every booking in bookings.json today discharges
    // at BUSAN and every container is a 40HC, across three different load
    // ports — so the destination and box size are safe to fill in and the LOAD
    // port is not. That is a fact about her data, so it is read off her data.
    const u = br.usualRoute('HOUSTON');
    ck('the discharge port is inferable', u.to === 'BUSAN', JSON.stringify(u));
    ck('  and the box size', u.size === '40HC', JSON.stringify(u));
    ck('  and nothing claims to know the load port',
       !('from' in u), 'Houston, Los Angeles and Oakland are all in there — there is nothing to infer');

    // The threshold, on synthetic tallies rather than on her live file, so the
    // rule is pinned even when her data changes.
    ck('a unanimous history is offered', br.commonest(['BUSAN', 'BUSAN']).value === 'BUSAN');
    ck('  a clear majority too', br.commonest(['BUSAN', 'BUSAN', 'QINGDAO']).value === 'BUSAN');
    ck('  but a split leaves it EMPTY, rather than guessing',
       br.commonest(['BUSAN', 'QINGDAO']) === null,
       'naming the wrong discharge port is worse than leaving the forwarder to ask');
    ck('  and nothing at all is not an answer either', br.commonest([]) === null);
}

section('E4 — correcting the draft, and refusing to');
{
    const now = new Date('2026-09-09T12:00:00-07:00');
    const state = { from: 'HOUSTON', to: 'BUSAN', count: 2, size: '40HC' };
    const c = (t) => br.correctionIn(t, state, now);

    ck('"no, Qingdao not Busan" changes the discharge port', c('no, Qingdao not Busan')?.to === 'QINGDAO');
    ck('  either way round', c('not Busan, Qingdao')?.to === 'QINGDAO');
    ck('  and a label works without a negation', c('POD Qingdao')?.to === 'QINGDAO');
    ck('  the load port too', c('no not Houston, Savannah')?.from === 'SAVANNAH');
    ck('"make it 3 containers" changes the count', c('make it 3 containers')?.count === 3);
    ck('  and a bare number is a COUNT, not a day of the month',
       c('make it 3')?.count === 3 && c('make it 3')?.cutoff === undefined,
       'the first version read "make it 3" as "cut off 3 Oct" — a date she never said, on a mail to a carrier');
    ck('  while an ordinal is a date', br.forCarrier(c('make it the 3rd')?.cutoff) === '3 Oct 2026');
    ck('"cut off the 25th" moves the cutoff', br.forCarrier(c('cut off the 25th')?.cutoff) === '25 Sep 2026');
    ck('  and an ERD is kept apart from it', br.forCarrier(c('ERD the 22nd')?.erd) === '22 Sep 2026');

    // ── AND THE ONES IT MUST REFUSE ──────────────────────────────────────
    // helpers/draftIntent.js records "forward that to Sher Trucking" silently
    // rewriting the buyer on an invoice, because "to X" parses as a company.
    // The same shape here would put a haulier's name in the discharge port of
    // a booking request.
    for (const t of ['send it to Zimex', 'yes', 'no', 'looks good', 'thanks', 'ok go',
                     'schedule this at 7am', 'any bookings from houston', 'make it shorter']) {
        ck(`  "${t}" is not a correction`, c(t) === null, JSON.stringify(c(t)));
    }
    ck('  and neither is restating what the draft already says',
       c('make it 2') === null && c('2') === null,
       'a "correction" that changes nothing would re-draft for no reason');
    ck('  nor a negation of something not on the draft',
       c('no, Qingdao not Shanghai') === null,
       'the rejected half has to be what the draft says, or this is not about this draft');

    // SAID OUT LOUD. The guard that replaces a cue word: a mis-parse has to be
    // audible before she is asked to confirm again.
    ck('what changed is describable', /3 containers/.test(br.describeCorrection({ count: 3 })));
    ck('  including ports and dates',
       /to QINGDAO/.test(br.describeCorrection({ to: 'QINGDAO' }))
       && /cut off 20 Sep 2026/.test(br.describeCorrection({ cutoff: new Date(Date.UTC(2026, 8, 20, 19)) })));
}

section('F — the handover, in the right order');
{
    const acts = fs.readFileSync(path.join(ROOT, 'workflow/actions.js'), 'utf8')
        .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');

    // Asked AFTER the address is resolved. Asking "how many containers?" and
    // only then discovering there is no email address for them is two
    // questions where one would do.
    // ── ONE PLACE DECIDES WHAT IS STILL MISSING ──────────────────────────
    // 2026-09-09: this used to be two copies — the entry path asked for the
    // count, the resolver drafted — and adding the cutoff question would have
    // made it two copies of a two-step sequence. continueBookingRequest is now
    // the only thing that decides, and both entry points call it. Same move as
    // resolveSpokenBooking, for the same reason: the forward and assign paths
    // drifted apart for exactly as long as they were separate.
    const iSeq = acts.indexOf('async function continueBookingRequest(');
    ck('one function decides what is still missing', iSeq !== -1,
       'two copies of the sequence is two places for the cutoff step to be wrong');
    const seqEnd = acts.indexOf('async function draftEmailWithAddress(', iSeq);
    const seq = acts.slice(iSeq, seqEnd);
    ck('  and both entry points go through it',
       (acts.match(/continueBookingRequest\(chatId,/g) || []).length >= 3,
       'the request path, the count answer and the cutoff answer all resume here');

    const iDraft = acts.indexOf('return draftEmailWithAddress(chatId, targetName, details, bkgNo, to, toSource, scheduledFor);');
    // Asked AFTER the address is resolved — asking "how many containers?" and
    // only then finding there is no email address for them is two questions
    // where one would do — and BEFORE the ordinary-draft fallthrough, which is
    // what would otherwise send a quantity-less request to a carrier.
    ck('the question is staged before the ordinary draft',
       iSeq !== -1 && iDraft !== -1
       && acts.indexOf('return continueBookingRequest(chatId, state);') !== -1
       && acts.indexOf('return continueBookingRequest(chatId, state);') < iDraft);

    // AND THE QUESTION IS ACTUALLY ASKED. Deleting this one line left every
    // other assertion in the file green: the pending would be staged, she
    // would be asked nothing at all, and the blocking pending would sit there
    // swallowing her next few sentences. Silence is the worst failure shape
    // this codebase has, and I nearly shipped another one.
    ck('  and the question is actually sent',
       /await _send\(chatId, question\)/.test(seq),
       'staging a pending and asking nothing leaves her in silence with everything blocked');
    ck('  naming who it is for',
       /br\.ask\(s\.target_name\)/.test(seq) && /\$\{who/.test(
           fs.readFileSync(path.join(ROOT, 'helpers/bookingRequest.js'), 'utf8')),
       '"How many containers?" with two drafts in flight is ambiguous');
    ck('  and a queued pending says so rather than going quiet',
       /staged\.queued/.test(seq), seq.slice(0, 120));
    ck('  and the pending carries everything needed to resume',
       /target_name: s\.target_name/.test(seq) && /to: s\.to, to_source: s\.to_source/.test(seq),
       'a pending missing the address means re-resolving it later, and a different answer');
    // Named fields, not a spread. A prior pending is spread INTO this
    // function, carrying setPending's own created_at/expires_at — re-storing
    // those would pin the new question to the old question's expiry, so a
    // cutoff asked late in a slow exchange could arrive already dead.
    ck('  without carrying the previous pending\'s expiry',
       !/setPending\(chatId, \{\s*type: 'await_booking_details', \.\.\./.test(seq),
       'a re-staged pending must start its own clock, not inherit a spent one');

    // ── COUNT FIRST, THEN CUTOFF ─────────────────────────────────────────
    // Her instruction was one question at a time. The order is not arbitrary:
    // a carrier cannot reply at all without a quantity.
    ck('  the count is asked before the cutoff',
       seq.indexOf('br.ask(s.target_name)') !== -1
       && seq.indexOf('br.ask(s.target_name)') < seq.indexOf('br.askCutoff('),
       'two questions in one breath is the form-read-aloud she rejected');
    ck('  and the cutoff is never inferred',
       !/usualRoute[\s\S]{0,200}cutoff/.test(seq) && /br\.askCutoff\(/.test(seq),
       'a cutoff comes from when the metal is ready — the last booking\'s is a date in the past');

    // Resumes through the SAME drafting tail, not a second one.
    // Bounded by something that SURVIVES comment-stripping. I first ended
    // this slice at '// Proforma confirmation' — a comment, in a string I had
    // just stripped comments out of — so indexOf returned -1, the slice ran
    // to the end of the file, and "never sends directly" failed against
    // correct code because api.js's other routes send plenty of mail. Same
    // over-broad-haystack mistake as tests/proforma-send.js.
    const resFrom = acts.indexOf("pending.type === 'await_booking_details'");
    const resTo = acts.indexOf("pending.type === 'confirm_proforma'", resFrom);
    ck('  the resolver block was located', resFrom !== -1 && resTo > resFrom,
       'from ' + resFrom + ' to ' + resTo);
    const res = acts.slice(resFrom, resTo);
    ck('  it resumes into the existing drafter',
       /return continueBookingRequest\(/.test(res) && /return draftEmailWithAddress\(/.test(seq),
       'a second drafting path would not get writingStyle.js and would drift');
    ck('  never sending directly',
       !/sendEmail|sendDraftedEmail/.test(res),
       'the await_email_confirm gate stays — she still approves the actual text');

    // "no" must still cancel.
    // THE RE-ASK. A resolver that drafted anyway on an unreadable answer
    // would commit her to a carrier for a number nobody said. Asserted on the
    // source because standing the resolver up needs setPending, Gmail, Gemini
    // and Supabase — stated plainly rather than dressed up as behavioural.
    ck('  an unreadable answer re-asks instead of drafting',
       /if \(count == null\) \{[\s\S]{0,400}?didn't catch a number/.test(res)
       && /booking_details_reasked/.test(res),
       'defaulting to one container is a real commitment to a shipping line');
    ck('    and keeps the pending open',
       res.indexOf('booking_details_reasked') < res.lastIndexOf('await clearPending'),
       'clearing it would drop the question and lose the email');

    // ── THE SECOND QUESTION, IN THE SAME PENDING ─────────────────────────
    // Which question is outstanding is read off the STATE (a count already
    // stored means the count step is behind us), not from a flag set when the
    // question was asked. A flag goes stale the moment she answers "two, cut
    // off the 20th" — one reply that settles both.
    ck('  the cutoff answer is told apart by the state, not a flag',
       /const awaitingCutoff = pending\.count != null/.test(res),
       'a flag set at ask-time is wrong as soon as she answers both at once');
    ck('  an unreadable date re-asks rather than drafting without one',
       /didn't catch a date/.test(res) && /booking_cutoff_reasked/.test(res),
       'a wrong cutoff books the wrong vessel');
    ck('  and "skip" is a real answer, not a cancel',
       /cutoff_skipped: true/.test(res),
       'she can say "not sure" — re-asking for ever is worse than sending without one');

    ck('  and "no" still cancels',
       /pending\.type === 'await_booking_details' && answer !== 'no'/.test(res),
       'declining to say how many means do not send the mail');

    // A number in the FIRST sentence means no question at all — the entry
    // path hands the count it already read straight into the sequence, which
    // then only asks for what is still missing.
    ck('a count given up front is not asked about again',
       /said, from_port: fromPort, count, size,/.test(acts)
       && /if \(s\.count == null\) \{[\s\S]{0,200}br\.ask\(/.test(seq),
       'asking for something she just said is the form-in-disguise this flow exists to avoid');
    ck('  and a cutoff given up front is not asked about either',
       /const dates = br\.datesIn\(said\)/.test(acts)
       && /if \(!s\.cutoff && !s\.cutoff_skipped\)/.test(seq),
       'same rule, second question');

    // And the whole check must never be able to lose the email.
    const guard = acts.slice(acts.indexOf("const br = require('../helpers/bookingRequest')"), iDraft);
    ck('a failure in the check falls through to an ordinary draft',
       /catch \(err\)/.test(guard),
       'a booking request drafted without the quantity is better than an email that vanishes');
}

section('G — her answer reaches the pending, not the classifier');
{
    // THE DOCUMENTED FAILURE MODE, one pending type over. brain.js records it
    // verbatim: with an email confirm open, "Schedule this mail @7am" fell
    // through every policy rule, was reclassified from scratch as a new email
    // request, found the same pending unresolved and queued a second draft
    // behind it — going in circles.
    //
    // "two" answering "how many containers?" is the same shape: not yes, not
    // no, not a numbered option.
    const brain = fs.readFileSync(path.join(ROOT, 'workflow/brain.js'), 'utf8');
    const catchIdx = brain.indexOf("p.type === 'await_booking_details'");
    ck('brain.js catches the answer at policy level', catchIdx !== -1,
       'without this it is reclassified as a brand new request');
    ck('  passing the whole sentence as the selection',
       /selection: ctx\.text/.test(brain.slice(catchIdx, catchIdx + 400)),
       'a free-text answer has nowhere else to travel');

    // ORDER. After YES/NO so a bare "no" still cancels; before the AI
    // fallthrough so the answer never reaches it.
    const iNo = brain.indexOf('if (NO.includes(t))');
    const iOptions = brain.indexOf('if (p.options) {');
    ck('  after the yes/no check', iNo !== -1 && iNo < catchIdx,
       '"no" must still mean cancel');
    ck('  and before the list-selection fallthrough', catchIdx < iOptions);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
