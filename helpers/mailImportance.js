// ── helpers/mailImportance.js — IMPORTANCE, measured from evidence ──────────
//
// Apsara, 2026-09-17: "Basically it should act like an ai assistant which
// watches the mail and notify if there is any improtant mail."
//
// WHAT WAS ACTUALLY WRONG. Jarvis has never measured importance. It measures
// "does somebody want a reply from you", which is a different quantity, and
// the whole pipeline gates on it:
//
//   (needs_reply && confidence >= MIN) || is_order || owed || bystander || colleague
//
// Every branch but is_order needs a QUOTABLE REQUEST SENTENCE. MEASURED over
// three days of her real inbox, with live assess() calls: 60 emails, 11
// shown, 44 dropped, and 22 of the dropped carrying real consequence —
//
//   "Andy is reminding you that the DG SI CUTOFF is September 17 morning at
//    10 AM and to please provide..."                              -> dropped
//   "Rajkumar wants you to print and courier the attached OBL to Mrs.
//    Akansha in Gurugram"                                          -> dropped
//   "Bose asks if the payment has been wired and to wire the amount asap"
//                                                                  -> dropped
//   "Kristal updates the ERD to 9/21, C/O to 9/25, and ETD to 9/30"-> dropped
//   "Eccomelt sent a payment remittance ... $13,992.00"            -> dropped
//
// The cutoff was that same morning. All 22 have asked_for: null — the same
// field that lost the purchase orders. Freight mail mostly does not ASK. It
// states a fact with a consequence: a cutoff, a figure, a schedule change,
// an instruction.
//
// SO IMPORTANCE IS ITS OWN AXIS, and it is derived in CODE, not asserted by
// the model. That is not a stylistic preference — it is what the last three
// weeks taught this file's neighbours:
//
//   * Self-reported confidence came back 1.0 on 16 of 16 live emails. A field
//     the model grades itself on carries no information.
//   * asked_for was fixed by DEMANDING A VERBATIM SPAN and checking it, not
//     by asking the model to try harder (Chain-of-Verification,
//     arXiv:2309.11495 — do not re-ask "are you sure", ask for something
//     independently checkable).
//
// So every signal below must carry a QUOTE THAT LITERALLY OCCURS in the
// sender's own text. A signal that cannot produce one is dropped, silently
// and by design. The model's judgement is still used — it wrote the summary
// and the deadline — but it cannot manufacture importance out of nothing.

// ── WHAT "RELATED TO EDGE METALS" MEANS ────────────────────────────────────
// Apsara: "Ignore all the mails not related to edgemetals."
//
// I nearly built this as a sender-domain rule and it would have been a
// disaster. MEASURED on the same three days, grouped by domain:
//
//   edgemetals.com 19 · zimexglt 8 · mkmetaltrading 5 · hynos.co.kr 4
//   eagleinbrit 3 · eccomelt 2 · fmcmet 1 · nicrometals 1
//
// Almost everything she gets IS Edge Metals business, and almost none of it
// is on her own domain. A domain test would have deleted the customers and
// carriers — the business — to remove three Google billing notices.
//
// The honest test is whether the mail references a LIVE EDGE METALS OBJECT:
// a booking, a container, a purchase order, a contract, an invoice, a vessel.
// That is checkable, it is domain-independent, and it is how she talks about
// her own work. Mail carrying none of those and no money figure is admin —
// banking, software billing, insurance — and goes quiet rather than missing.
const BUSINESS_REF = [
    // Booking references as they actually appear in her mail: DALA20928700,
    // EBKG18670536, DALA2504820. Carrier prefix + a long number.
    ['booking',   /\b(?:DALA|EBKG|HDMU|MEDU|MAEU|COSU|ONEY|HLCU|EGLV|SUDU|CMDU)\s?\d{6,12}\b/i],
    // ISO 6346 container: four letters then seven digits (HMMU4892142).
    // The check digit is NOT validated — a typo'd container is still a
    // container reference, and rejecting it would lose the email.
    ['container', /\b[A-Z]{4}\s?\d{7}\b/],
    // Purchase orders — the same shape helpers/poTracker.js extracts.
    ['po',        /\b(?:purchase\s+order|p\.?\s?o\.?)\s*(?:number|no\.?|#)?\s*[:#]?\s*\d{4,12}\b/i],
    // Her contract/lot numbering: 26JY79, 26MT14, 26EM07, 26TM03.
    ['contract',  /\b\d{2}[A-Z]{2}\d{1,3}\b/],
    ['invoice',   /\b(?:invoice|inv|bill|remittance|purchase\s+ticket)\s*(?:no\.?|number|#|id)?\s*[:#]?\s*[A-Z]{0,4}-?\d{3,10}\b/i],
    ['vessel',    /\b(?:vessel|voyage|mv|m\/v)\b[^.\n]{0,40}\b\d{3,4}[A-Z]?\b/i],
];

function businessRefs(text) {
    const t = String(text || '');
    const out = [];
    for (const [kind, re] of BUSINESS_REF) {
        const m = t.match(re);
        if (m) out.push({ kind, quote: m[0].trim() });
    }
    return out;
}

// ── THE SIGNALS ────────────────────────────────────────────────────────────
// Each one is a SENTENCE MATCHER, not a word matcher, and it returns the
// sentence. A keyword hit with no sentence around it is not evidence of
// anything — "payment" appears in every email footer in this industry.
const SENTENCE_SPLIT = /(?<=[.!?\n])\s+/;

// Money, as written. NEVER computed, totalled or rounded — the same rule the
// digest's key_figures follow, for the same reason: a wrong figure on a live
// money thread is worse than no figure.
const MONEY_RE = /(?:US\s?\$|USD|\$|₹|INR|€|£)\s?\d[\d,]*(?:\.\d{2})?\b|\b\d[\d,]{2,}(?:\.\d{2})?\s?(?:USD|usd|dollars)\b/;

// A cutoff is the single most consequential fact in this business: miss it
// and the container does not sail. Named explicitly rather than folded into
// a generic "deadline", because the words are standard and unambiguous.
const CUTOFF_RE = /\b(?:si\s*cut[\s-]?off|dg\s*si|cut[\s-]?off|cutoff|erd|early\s*return\s*date|doc\s*cut|vgm\s*cut|gate\s*in|last\s*free\s*day|sailing|etd|closing)\b/i;

// An instruction aimed at US. "please send", "kindly issue", "need you to
// courier" — the imperative that carries an obligation without ever being
// phrased as a question, which is exactly the class asked_for cannot see.
const INSTRUCTION_RE = /\b(?:please|kindly|need(?:s)?\s+(?:you|us)\s+to|you\s+(?:need|have)\s+to|make\s+sure|ensure|do\s+not\s+forget|requesting\s+you)\b[^.\n]{0,120}?\b(?:send|share|provide|issue|release|courier|print|wire|transfer|remit|pay|confirm|approve|arrange|book|submit|upload|return|collect|deliver|revert|advise|update)\b/i;

// Something has gone wrong. These cost money directly and they escalate if
// nobody answers, which makes them the worst possible thing to drop.
const PROBLEM_RE = /\b(?:claim|shortage|short\s*shipped|damage[ds]?|discrepanc(?:y|ies)|dispute|penalt(?:y|ies)|detention|demurrage|on\s+hold|held\s+(?:up|at)|customs\s+hold|reject(?:ed|ion)?|short\s*landed|missing|not\s+received|wrong\s+(?:container|weight|documents?))\b/i;

// A SERVICE she depends on is about to stop. This is admin mail, but it is
// the admin mail that costs her something — Workspace suspended, a card
// declined, an account closed.
//
// DELIBERATELY NOT FOLDED INTO PROBLEM_RE, which I tried first. Everything in
// PROBLEM is `critical`, and `critical` is what earns an immediate message.
// Marketing writes "don't let your account be cancelled" all day; waking her
// for that is exactly how a notifier gets switched off. This lifts admin mail
// into the digest and no further.
const SERVICE_RE = /\b(?:suspend(?:ed|ing|sion)?|deactivat(?:ed|ion)|terminat(?:ed|ion)|account\s+clos(?:ed|ure)|final\s+notice|past\s+due|payment\s+(?:failed|declined)|card\s+declined|will\s+be\s+(?:cut\s+off|disconnected))\b/i;

function sentencesOf(text) {
    return String(text || '').split(SENTENCE_SPLIT)
        .map((s) => s.replace(/\s+/g, ' ').trim())
        .filter((s) => s.length >= 12 && s.length <= 400);
}

// Returns {kind, quote} or null. The quote is the SENTENCE, trimmed, so the
// digest can show her why Jarvis thought this mattered.
function firstSentenceMatching(sentences, re) {
    for (const s of sentences) if (re.test(s)) return s.slice(0, 220);
    return null;
}

// ── A STORED VALUE CONTRADICTED ────────────────────────────────────────────
// Apsara chose "notify me straight away" for consequential mail that is not
// hers to answer, and this is the sharpest case of it: an ERD or cutoff that
// MOVED. By the next digest it can already be too late, and nobody in the
// thread is asking her anything — Kristal simply states the new date.
//
// Only fires when Jarvis ALREADY HELD a different value, which is what makes
// it a change rather than an announcement. bookings.json is the record.
const DATEISH = /\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b/g;
function datesIn(text) {
    const out = [];
    for (const m of String(text || '').matchAll(DATEISH)) {
        const mo = Number(m[1]), da = Number(m[2]);
        if (mo < 1 || mo > 12 || da < 1 || da > 31) continue;
        out.push({ raw: m[0], month: mo, day: da });
    }
    return out;
}
const sameDay = (a, b) => a && b && a.month === b.month && a.day === b.day;

// bookings: the parsed bookings.json map, or null to skip this signal.
//
// PER-FIELD, AND SENTENCE-SCOPED. My first version collected every date in
// the mail and compared it against every stored field independently, which
// made this mail a CHANGE:
//
//   "Confirming the ERD remains 9/9 for booking DALA25048200."
//
// The ERD matched, so it moved on to the cutoff, found no 9/12 among the
// dates, and reported that the cutoff had changed — off a mail that never
// mentions the cutoff at all. And `change` is the one signal that pings her
// immediately, so the first thing this feature would have done is wake her
// for a confirmation.
//
// A field is only compared when THE SAME SENTENCE names it. That is the
// narrowest reading that can still catch "ERD is now 9/21", and it is
// deliberately biased towards missing a change over inventing one: a missed
// change costs her the old behaviour, an invented one costs her trust in the
// only alert allowed to interrupt her.
const FIELD_WORDS = [
    ['erd_date',    'ERD',    /\b(?:erd|early\s*return\s*date)\b/i],
    ['cutoff_date', 'cutoff', /\b(?:si\s*cut[\s-]?off|doc\s*cut[\s-]?off|cut[\s-]?off|cutoff|closing)\b/i],
];
// `text` here is the BODY AND THREAD, deliberately NOT the subject — and
// this was caught by testing against a real subject line rather than one I
// made up:
//
//   RE: Need booking from oakland/Busan 2 *40HC with erd 9/9 - DALA25048200
//   body: "Kristal updates the ERD to 9/21 for booking DALA25048200."
//
// The subject names the ERD and carries 9/9, which is exactly what we hold.
// Scoring it as a stated date made the mail look like a confirmation and the
// real change — 9/21, in the body — was never reported. Her subjects
// routinely carry the ORIGINAL date this way ("with erd 9/9", "with 9/11
// erd"), because that is how the thread was opened.
//
// So the subject is treated as the thread's framing, not as this message's
// claim. The booking REFERENCE is still taken from the full text, because the
// booking number is often only in the subject.
//
// Accepted cost: a change announced in the subject alone, with a body that
// does not restate it, is missed. That is the same bias as everywhere else
// here — missing a change costs her the old behaviour, inventing one spends
// the only interruption she has agreed to.
function changedBookingDate(text, refs, bookings) {
    if (!bookings) return null;
    const bookingRef = refs.find((r) => r.kind === 'booking');
    if (!bookingRef) return null;
    const want = bookingRef.quote.replace(/\s/g, '').toUpperCase();
    const key = Object.keys(bookings).find((k) => k.replace(/\s/g, '').toUpperCase() === want);
    if (!key) return null;
    const b = bookings[key] || {};
    const sentences = sentencesOf(text);
    for (const [field, label, re] of FIELD_WORDS) {
        const held = datesIn(b[field] || '')[0];
        if (!held) continue;
        // Dates from the sentences that name THIS field, and nowhere else.
        const stated = [];
        for (const sent of sentences) {
            if (!re.test(sent)) continue;
            for (const d of datesIn(sent)) stated.push(d);
        }
        if (!stated.length) continue;
        // The mail repeats what we hold: a confirmation, not a change.
        if (stated.some((d) => sameDay(d, held))) continue;
        return {
            kind: 'change',
            quote: `${label} on ${key}: we hold ${b[field]}, this mail says ${stated.map((d) => d.raw).slice(0, 3).join(' / ')}`,
            field, booking: key, held: b[field], stated: stated.map((d) => d.raw).slice(0, 3),
        };
    }
    return null;
}

// ── THE VERDICT ────────────────────────────────────────────────────────────
// level:
//   critical  something moved, something broke, or a cutoff is on top of us.
//             This is what earns an immediate message.
//   high      money, or an instruction aimed at us, or a cutoff further out.
//             Shown in the next digest whether or not anyone asked her.
//   normal    a business reference and nothing sharp. Shown if the existing
//             gates want it; never promoted on importance alone.
//   low       no grounded signal, or admin mail with no business reference.
//             Watched, recorded, and quiet.
const IMMINENT_DAYS = 2;

// HOW SOON IS THE CUTOFF? From the CUTOFF SENTENCE ITSELF, not from any date
// elsewhere in the mail.
//
// Found by the 7-day report before this shipped, which is exactly why the
// report was written first: 37 of 153 emails came out `critical`, about five
// interruptions a day, and the top hit was
//
//   "RE: Need booking from oakland/Busan 2 *40HC with erd 9/9 - DALA25048200"
//
// Scanning the whole message for a date found 9/9 -- a week in the PAST, in
// the subject line, naming the ERD the thread was opened about -- read it as
// seven days overdue, and therefore imminent, and therefore critical. The
// same stale-subject problem that defeated changedBookingDate.
//
// So: the date must come from the sentence that names the cutoff, and the
// subject is excluded. `parseDate` is injected rather than required, because
// the parser lives in workflow/replyWatch.js and requiring it here would be
// circular -- and because a caller with no parser must degrade to the
// supplied deadlineDays rather than silently treating everything as urgent.
function cutoffImminence(cutoffSentence, parseDate, receivedAt) {
    if (!cutoffSentence || typeof parseDate !== 'function') return null;
    const when = parseDate(cutoffSentence, receivedAt instanceof Date ? receivedAt : new Date());
    if (!(when instanceof Date) || isNaN(when.getTime())) return null;
    const base = receivedAt instanceof Date && !isNaN(receivedAt.getTime()) ? receivedAt : new Date();
    return Math.round((when.getTime() - base.getTime()) / 86400000);
}

// ── WHO IS THIS PERSON TO US? ──────────────────────────────────────────────
// The content cannot settle the admin question and I tried to make it. My
// first version demoted anything with no business reference and no money —
// which sent "Please print and courier the attached OBL to Mrs. Akansha" to
// the quiet pile, because MEDUADA20500 is not a shape my booking regex knows
// and nobody quoted a price. An explicit instruction aimed at Edge Metals is
// business by definition; no software vendor asks her to courier a Bill of
// Lading.
//
// The deeper problem is that these two are IDENTICAL as text:
//
//   "Payment ID 4004930 has been issued for $13,992.00"   <- her customer
//   "Your invoice INV-4023 for $49.00 is due"             <- her software
//
// One is revenue and one is admin, and no amount of keyword work separates
// them. What separates them is WHO SENT IT, and Jarvis already knows: she has
// emailed her counterparties and has never emailed Google. sentIndex (built
// from her Sent folder by refreshSentIndex) and senderStats are that record.
//
// Supplied by the caller rather than read here, because this module must stay
// a pure function — it is the only way the 7-day report can score a week of
// real mail without a store, and the only way the tests can be honest.
// Absent predicate means EVERY sender counts as known, i.e. nothing is
// demoted: failing towards noise, never towards silence.
function importanceOf({ subject = '', body = '', thread = '', deadlineDays = null,
                        bookings = null, isKnownCounterparty = null, from = '',
                        parseDate = null, receivedAt = null } = {}) {
    // The sender's own words only. `thread` is included because a cutoff is
    // routinely stated once and then referred to — but the SUMMARY is never
    // used, which would be circular: the model's own output grading itself.
    const text = `${subject}\n${body}\n${thread}`;
    const sentences = sentencesOf(`${subject}. ${body}\n${thread}`);
    const refs = businessRefs(text);
    const signals = [];

    const changed = changedBookingDate(`${body}\n${thread}`, refs, bookings);
    if (changed) signals.push(changed);

    const problem = firstSentenceMatching(sentences, PROBLEM_RE);
    if (problem) signals.push({ kind: 'problem', quote: problem });

    // The BODY's cutoff sentence decides imminence; the subject's may be the
    // stale one the thread was named after. Both still raise the signal.
    const cutoff = firstSentenceMatching(sentences, CUTOFF_RE);
    const bodyCutoff = firstSentenceMatching(sentencesOf(`${body}\n${thread}`), CUTOFF_RE);
    const cutoffDays = cutoffImminence(bodyCutoff, parseDate, receivedAt);
    if (cutoff) signals.push({ kind: 'cutoff', quote: bodyCutoff || cutoff, inDays: cutoffDays });

    const moneySentence = firstSentenceMatching(sentences, MONEY_RE);
    if (moneySentence) {
        const fig = moneySentence.match(MONEY_RE);
        signals.push({ kind: 'money', quote: moneySentence, figure: fig ? fig[0] : null });
    }

    const instruction = firstSentenceMatching(sentences, INSTRUCTION_RE);
    if (instruction) signals.push({ kind: 'instruction', quote: instruction });

    const service = firstSentenceMatching(sentences, SERVICE_RE);
    if (service) signals.push({ kind: 'service', quote: service });

    const has = (k) => signals.some((s) => s.kind === k);
    // A cutoff counts as imminent only when we can DATE it and that date is
    // close. An undatable cutoff stays `high`: it reaches her in the next
    // digest, which is the honest answer to "we cannot tell when this is".
    //
    // `deadlineDays` remains the fallback for callers with no parser, and a
    // NEGATIVE value no longer qualifies: "overdue by 7 days" almost always
    // means a stale date was picked up somewhere in the mail, and waking her
    // for it is how the report found 37 false criticals.
    const imminent = typeof cutoffDays === 'number'
        ? (cutoffDays >= 0 && cutoffDays <= IMMINENT_DAYS)
        : (typeof deadlineDays === 'number' && deadlineDays >= 0 && deadlineDays <= IMMINENT_DAYS);

    let level = 'low';
    if (has('change') || has('problem') || (has('cutoff') && imminent)) level = 'critical';
    else if (has('money') || has('instruction') || has('cutoff') || has('service')) level = 'high';
    else if (refs.length) level = 'normal';

    // ── ADMIN MAIL GOES QUIET ──────────────────────────────────────────────
    // Her ask, translated into something safe: no reference to any live Edge
    // Metals object, and no money. Software billing, banking, insurance,
    // subscriptions. DEMOTED, never deleted — it is still assessed, still
    // recorded, still answerable by "what else came in". The failure this
    // whole session has been about is mail disappearing with nothing logged,
    // and a filter that does that quietly would be the same mistake wearing
    // a feature's clothes.
    //
    // A PROBLEM still beats this: "your account is suspended" carries no
    // booking number and is not something to hide.
    // A STRONG reference is a live operational object. An invoice number on
    // its own is NOT one — every software vendor on earth has invoice
    // numbers, and that is precisely the mail she wants quiet.
    const STRONG = new Set(['booking', 'container', 'po', 'contract', 'vessel']);
    const strongRefs = refs.filter((r) => STRONG.has(r.kind));
    const known = typeof isKnownCounterparty === 'function'
        ? !!isKnownCounterparty(from)
        : true;    // no predicate supplied: assume known, demote nothing

    // ADMIN MAIL GOES QUIET — and every one of these clauses is load-bearing:
    //   no strong ref      a booking, container, PO or contract means it is
    //                      operational whoever sent it.
    //   no problem         an operational failure is never admin.
    //   no service         a suspension or a declined card IS admin mail, and
    //                      it is the admin mail that costs her something. It
    //                      stays at `high` — in the digest, never a ping.
    //   no instruction     the OBL case above.
    //   no cutoff          a date that governs a sailing is never admin.
    //   not a counterparty the money discriminator. Her customer's remittance
    //                      survives; her software vendor's invoice does not.
    const admin = !strongRefs.length && !has('problem') && !has('service')
        && !has('instruction') && !has('cutoff') && !known;
    // DEMOTED, NEVER DELETED. It is still assessed, still recorded, still
    // answerable by "what else came in". The failure this entire session has
    // been about is mail vanishing with nothing logged, and a filter that did
    // that quietly would be the same mistake wearing a feature's clothes.
    if (admin) level = 'low';

    return {
        level,
        signals,
        refs,
        strongRefs,
        admin,
        knownCounterparty: known,
        // Her choice, 2026-09-17, on mail that is consequential but not hers
        // to answer: "Notify me straight away". Only `critical` qualifies, so
        // the interruption budget is spent on a date that moved, a claim, or
        // a cutoff inside two days — never on a remittance advice.
        notifyNow: level === 'critical',
        // One line for the digest, so she can see WHY Jarvis thought this
        // mattered rather than trusting a label. A judgement she cannot audit
        // is one she has to either accept or switch off.
        because: signals.length
            ? signals.map((s) => s.kind).join('+') + ': ' + String(signals[0].quote).slice(0, 140)
            : null,
    };
}

module.exports = {
    importanceOf, cutoffImminence, businessRefs, datesIn, changedBookingDate, sentencesOf,
    MONEY_RE, CUTOFF_RE, INSTRUCTION_RE, PROBLEM_RE, SERVICE_RE, IMMINENT_DAYS,
};
