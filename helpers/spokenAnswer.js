// ── helpers/spokenAnswer.js — what Jarvis SAYS, as opposed to what it shows ──
//
// Apsara, 2026-09-19: "i dont want it to say out the booking number aloud.
// bcoz it doesnt make any sense"
//
// "Two seven two seven six six four eight zero cuts off next Wednesday" is
// noise: nobody can hold nine digits heard once, and the number is already on
// the card in front of her. So the SPOKEN copy replaces a booking number with
// what a person would say — "the first booking" when it is numbered on the
// panel (which is what she then says back: "forward the first one"), "this
// booking" otherwise.
//
// SCOPE, deliberately narrow:
//   · the screen text is untouched — the card still shows the number;
//   · only BOOKING numbers. Container numbers, PO numbers, amounts and dates
//     are still spoken. Widening that is her call, not this file's.
//   · a booking number is recognised two ways only: it exists in the
//     bookings store, or the word "booking" sits right in front of it. No
//     guessing by shape — a shape rule would eat container and PO numbers.

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth',
    'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function knownBookingNumbers() {
    try {
        const { loadBookings } = require('./json');
        const all = loadBookings() || {};
        const out = new Set();
        for (const [k, b] of Object.entries(all)) {
            for (const v of [k, b && b.booking_number]) {
                const s = String(v || '').trim();
                if (s.length >= 5 && /\d/.test(s)) out.add(s.toUpperCase());
            }
        }
        return out;
    } catch (e) {
        // No store is no vocabulary, never a failed answer.
        return new Set();
    }
}

// rows: the on-screen panel rows ({ n, booking_number }), when there is one.
function forSpeech(text, opts) {
    const src = String(text || '');
    if (!src) return src;
    const o = opts || {};
    const rows = Array.isArray(o.rows) ? o.rows : [];
    const onScreen = new Map();
    for (const r of rows) {
        if (r && r.booking_number && r.n) onScreen.set(String(r.booking_number).toUpperCase(), r.n);
    }
    const known = o.known instanceof Set ? o.known : knownBookingNumbers();
    for (const k of onScreen.keys()) known.add(k);

    const refFor = (num) => {
        const n = onScreen.get(String(num).toUpperCase());
        if (n && n <= ORDINALS.length) return 'the ' + ORDINALS[n - 1] + ' booking';
        if (n) return 'booking ' + n;
        return 'this booking';
    };

    let out = src;
    const DET = '(?:(?:the|this|that|your)\\s+)?';
    const LEAD = '(?:booking|bkg)(?:\\s+(?:number|no\\.?|#))?\\s*[:#]?\\s*';

    // 1. "booking 123456789" / "booking no. XYZ" — the word itself marks it,
    //    whether or not the store knows the number.
    out = out.replace(new RegExp('\\b' + DET + LEAD + '([A-Z]{0,5}\\d[A-Z0-9-]{3,})\\b', 'gi'),
        (m, num) => refFor(num));

    // 2. Any number the store knows, however it is framed.
    const list = [...known].sort((a, b) => b.length - a.length);   // longest first
    for (const num of list) {
        // "HOU111/1" is container 1 of that booking — say it that way
        // rather than "this booking slash one".
        const slot = new RegExp('\\b(?:' + DET + LEAD + '|' + DET + ')' + esc(num) + '\\s*/\\s*(\\d{1,2})\\b', 'gi');
        out = out.replace(slot, (m, n) => 'container ' + n + ' of ' + refFor(num));
        const re = new RegExp('(\\(\\s*)?\\b(?:' + DET + LEAD + '|' + DET + ')' + esc(num) + '\\b(\\s*\\))?', 'gi');
        out = out.replace(re, (m, open, close) => {
            // "Houston booking (272766480)" — the bracket only repeats what
            // the sentence already said, so it goes entirely.
            if (open && close) return '';
            return (open || '') + refFor(num) + (close || '');
        });
    }

    // Tidy what the removals left behind.
    out = out
        .replace(/\s+([,.;:!?])/g, '$1')
        .replace(/\(\s*\)/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/(^|[.!?]\s+|\n\s*)(the|this|booking|container)\b/g,
            (m, pre, w) => pre + w.charAt(0).toUpperCase() + w.slice(1))
        .trim();
    return out || src;
}

module.exports = { forSpeech, knownBookingNumbers };
