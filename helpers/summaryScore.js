// ── helpers/summaryScore.js — the summary ruler, one definition ─────────────
// Extracted 2026-08-29 from tests/summary-quality.js so the fixture test and
// the live sweep (scripts/ruler.js) cannot drift apart. A ruler that measures
// two different things depending on who calls it is worse than no ruler, and
// that is exactly what a copied score() would have become.
//
// TWO KINDS OF MEASUREMENT LIVE HERE, and the difference matters:
//
//   scoreFacts()  needs an adjudicated fixture — the list of facts a correct
//                 summary must carry. Accurate, and it does not scale: every
//                 fixture costs a human judgement.
//
//   scoreShape()  needs nothing but the summary text. It cannot tell you
//                 whether a summary is TRUE, only whether it is the kind of
//                 sentence that has been wrong all week: opening with a
//                 category instead of content, a relative date that expires
//                 overnight, or a summary carrying no concrete noun at all.
//                 Cheap, so it runs on every email in a sweep.
//
// Neither replaces the other. scoreShape() at volume tells you WHERE to spend
// the adjudication that scoreFacts() needs.

// A summary that opens by naming the kind of email rather than saying what it
// says. "Sender wants confirmation of unit price adjustment" — a sentence that
// survives having the email removed from underneath it.
const CATEGORY_OPENER = /^(the\s+)?(sender|this email|the email|an email|someone)\b/i;

// A word that stops being true tomorrow. The digest is read hours after it is
// written and kept for days; "tomorrow" in it is a lie on a timer.
const RELATIVE_DATE = /\b(tomorrow|today|tonight|asap|eod|next week|this morning|yesterday)\b/i;

// Something a reader could act on: a figure, a date, a booking/lot reference,
// or a capitalised name. A summary with none of these is grammatical and
// useless — "the sender is requesting information regarding the shipment".
const CONCRETE = [
    /\d/,                                   // any figure at all
    /\b[A-Z]{2,6}\s?\d{4,}\b/,              // booking / lot references
    /\b[A-Z][a-z]{2,}\b/,                   // a proper noun
];

function scoreShape(summary) {
    const t = String(summary || '').trim();
    const words = t ? t.split(/\s+/).filter(Boolean).length : 0;
    return {
        text: t,
        words,
        empty: !t,
        categoryOpener: CATEGORY_OPENER.test(t),
        relativeDate: RELATIVE_DATE.test(t),
        // Under six words has never once been a usable summary in this app —
        // "confirmation of calculations" is four.
        stub: !!t && words < 6,
        concrete: CONCRETE.some((re) => re.test(t)),
        // The single roll-up: a summary is SOUND when it trips none of them.
        get sound() {
            return !this.empty && !this.categoryOpener && !this.relativeDate
                && !this.stub && this.concrete;
        },
    };
}

// Fact-carrying against an adjudicated fixture. `facts` is [{name, re}].
function scoreFacts(summary, facts) {
    const t = String(summary || '');
    const list = facts || [];
    const carried = list.filter((f) => f.re.test(t));
    const shape = scoreShape(t);
    return {
        carried: carried.map((f) => f.name),
        missing: list.filter((f) => !f.re.test(t)).map((f) => f.name),
        ratio: list.length ? carried.length / list.length : 0,
        categoryOpener: shape.categoryOpener,
        relativeDate: shape.relativeDate,
        words: shape.words,
    };
}

// An input is THIN when the model was given almost nothing to work with. This
// is the harness/judgement discriminator: a wrong summary on a thin input is
// a harness problem — the thread never reached the prompt — and no amount of
// prompt engineering fixes it.
const THIN_BODY_CHARS = 200;
function isThin(inputs) {
    if (!inputs) return true;
    const thread = Number(inputs.threadChars) || 0;
    const body = Number(inputs.bodyChars) || 0;
    return thread === 0 || body < THIN_BODY_CHARS;
}

module.exports = { scoreShape, scoreFacts, isThin, THIN_BODY_CHARS };
