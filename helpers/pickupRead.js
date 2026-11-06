// ── helpers/pickupRead.js — the pickup Jarvis was never told about ───────
// Apsara, 2026-11-06: "even if i dont tell,based on my email,it should know".
//
// She was offered this entry point earlier the same day and chose the other
// two. She has changed her mind, and she is right: a pickup she arranged by
// replying "yes please" to a carrier is a pickup she will not then go and
// type into a screen, and a feature that only watches what she remembers to
// tell it is a feature that watches the easy half.
//
// ── THE PRECEDENT, AND THE ONE PLACE IT DOES NOT REACH ───────────────────
// workflow/emailWatcher.js already creates BOOKINGS straight out of her mail
// with no approval gate, and its header records why: "per Apsara 2026-08-20:
// 'I don't want any human to do that'". So automatic is the house style and
// this follows it.
//
// But creating a booking writes a row. Creating a pickup makes Jarvis EMAIL
// A THIRD PARTY in her name, on a day it chose, about an arrangement it
// inferred. The danger in that sentence is not reading the mail wrong. It is
// INVENTING A RECIPIENT — the same failure helpers/nameMatch.js refuses for
// money, where "a near-miss resolves to the wrong company".
//
// ── SO THE CARRIER IS NEVER EXTRACTED. IT IS THE SENDER ──────────────────
// The contact for an email-born pickup is the address that actually wrote to
// her, and the chase is a reply on that same thread. The model is never
// asked for an email address and its answer would be discarded if it gave
// one. There is no path from a hallucination to a stranger's inbox: the
// worst case is a reply, on a real thread, to a person who really did email
// her about a pickup.
//
// What is left to get wrong is the DATE (chasing on the wrong morning) and
// whether it was a pickup at all (one needless question to a carrier she
// already deals with). Both are recoverable in a sentence. Neither is money
// and neither reaches a stranger.
//
// ── CHEAP FIRST, MODEL SECOND ────────────────────────────────────────────
// Every mail in her box would otherwise be a model call. The prefilter is
// deterministic and deliberately loose — it is allowed to pass junk to the
// model, which can decline; it must not DROP a real pickup, because a
// dropped one is the silent gap this whole feature exists to close.
const str = (v) => String(v == null ? '' : v).trim();

// Words that make a mail worth paying a model to read. Loose on purpose.
const PICKUP_WORDS = [
    'pickup', 'pick up', 'pick-up', 'collection', 'collect',
    'dispatch', 'driver', 'truck', 'haul', 'drayage', 'pull the container',
];
// At least one of these too, so "pick up the phone" and "truck parts" do not
// buy a model call on their own.
const FREIGHT_WORDS = [
    'container', 'booking', 'bol', 'b/l', 'load', 'yard', 'warehouse',
    'eta', 'schedule', 'scheduled', 'appointment', 'chassis', 'seal',
];

// Mail Jarvis sent, or machine noise. Never a pickup arrangement.
const NEVER = [
    'out of office', 'automatic reply', 'undeliverable', 'delivery status notification',
    'unsubscribe', 'no-reply', 'noreply', 'mailer-daemon', 'newsletter',
];

function looksLikePickup(mail = {}) {
    const hay = `${str(mail.subject)} ${str(mail.body)}`.toLowerCase();
    if (!hay.trim()) return false;
    const from = str(mail.from).toLowerCase();
    if (NEVER.some((w) => hay.includes(w) || from.includes(w))) return false;
    return PICKUP_WORDS.some((w) => hay.includes(w)) && FREIGHT_WORDS.some((w) => hay.includes(w));
}

// Containers are ISO 6346: four letters then seven digits. Pulled in code
// rather than asked of the model, because a container number is a checkable
// shape and a model transposing two digits would file the pickup against a
// box that does not exist.
const containerIn = (text) => {
    const m = /\b([A-Z]{4}\s?\d{7})\b/.exec(String(text || '').toUpperCase());
    return m ? m[1].replace(/\s/g, '') : '';
};

function buildPrompt(mail) {
    return `You read freight emails for a metal exporter. Decide whether this email is a logistics company CONFIRMING or ARRANGING a pickup/collection of a container or load, and if so on what date.

FROM: ${str(mail.from)}
DATE RECEIVED: ${str(mail.received_at) || 'unknown'}
SUBJECT: ${str(mail.subject)}

BODY:
${str(mail.body).slice(0, 4000)}

RULES:
- "is_pickup" is true ONLY if a party is collecting goods on a stated or clearly implied day. A quote, a rate sheet, an invoice, an arrival notice, a delivery to a customer, or a general enquiry is NOT a pickup arrangement.
- "pickup_date" must be an actual calendar date in YYYY-MM-DD. Resolve "tomorrow", "Monday" and similar against DATE RECEIVED. If you cannot work out a specific day, set is_pickup false — a pickup with no day cannot be followed up.
- "company" is the logistics company or trucker doing the collecting, as written. Never an email address.
- Do NOT return any email address or phone number. They are taken from the message itself, not from you.
- "location" only if the email says where they are collecting from.
- If you are unsure, say is_pickup false. A missed pickup is recoverable; a wrong one makes us ask a carrier about a job that does not exist.

Return ONLY raw JSON:
{"is_pickup":true,"company":"Zimex Freight","pickup_date":"2026-11-20","location":"the yard","confidence":"high","why":"says driver will collect the container Friday 20th from the yard"}
or
{"is_pickup":false,"why":"this is a rate quote, nobody is collecting anything"}

confidence is "high", "medium" or "low".`;
}

// ── readPickup(mail, { callGemini }) ─────────────────────────────────────
// Returns a pickup ready for pickups.create(), or null with a reason.
// callGemini is INJECTED, like every other model call in this feature, so
// the whole reader is testable without a network — and so a test can prove
// it declines.
async function readPickup(mail = {}, opts = {}) {
    if (!looksLikePickup(mail)) return { pickup: null, why: 'does not read like a pickup arrangement' };

    const call = typeof opts.callGemini === 'function' ? opts.callGemini : null;
    if (!call) return { pickup: null, why: 'no model available to read it' };

    let res = null;
    try { res = await call(buildPrompt(mail)); } catch (e) {
        return { pickup: null, why: 'the model could not be reached' };
    }
    if (!res || typeof res !== 'object') return { pickup: null, why: 'the model said nothing usable' };
    if (res.is_pickup !== true) return { pickup: null, why: str(res.why) || 'the model says this is not a pickup' };

    const company = str(res.company);
    const date = str(res.pickup_date);
    if (!company) return { pickup: null, why: 'no company named, so there would be nobody to ask' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return { pickup: null, why: `no usable date (${date || 'none given'}), so there is no day to chase on` };
    }

    // ── THE ADDRESS IS THE SENDER'S, FULL STOP ───────────────────────────
    // Not asked of the model, and discarded if volunteered. This is the one
    // line that makes an auto-created pickup safe to chase: the worst case
    // is a reply to someone who really did email her.
    const fromAddr = (/<([^>]+)>/.exec(str(mail.from)) || [null, str(mail.from)])[1] || '';
    const contact_email = /@/.test(fromAddr) ? fromAddr.trim() : '';
    if (!contact_email) {
        return { pickup: null, why: 'no readable sender address, and Jarvis will not invent one' };
    }

    return {
        pickup: {
            company,
            pickup_date: date,
            // Read in code, not by the model — a transposed digit would file
            // this against a container that does not exist.
            container_no: containerIn(`${mail.subject} ${mail.body}`),
            location: str(res.location),
            contact_email,
            // The chase replies on THIS thread, so the carrier sees one
            // conversation rather than a stranger's cold mail.
            thread_id: str(mail.thread_id),
            // And in THEIR client too: their mail reader threads on
            // In-Reply-To/References, not on Gmail's thread id.
            last_message_id: str(mail.message_id),
            source: 'email',
        },
        confidence: ['high', 'medium', 'low'].includes(str(res.confidence).toLowerCase())
            ? str(res.confidence).toLowerCase() : 'low',
        why: str(res.why).slice(0, 200),
    };
}

// ── ALREADY KNOWN? ───────────────────────────────────────────────────────
// A carrier confirms, then re-confirms, then replies to its own thread. Three
// mails, one truck. Matching on container+date when there is a container,
// and company+date when there is not — a second pickup for the same company
// on the same day is far more likely to be the same job said twice than two
// trucks nobody mentioned.
function alreadyKnown(candidate, existing = []) {
    const c = candidate || {};
    const cont = str(c.container_no).toUpperCase();
    const day = str(c.pickup_date);
    const co = str(c.company).toLowerCase();
    return (existing || []).find((p) => {
        if (!p || str(p.pickup_date) !== day) return false;
        if (cont) return str(p.container_no).toUpperCase() === cont;
        return str(p.company).toLowerCase() === co;
    }) || null;
}

module.exports = { readPickup, looksLikePickup, alreadyKnown, buildPrompt, containerIn,
    PICKUP_WORDS, FREIGHT_WORDS };
