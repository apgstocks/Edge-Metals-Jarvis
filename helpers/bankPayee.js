// ── helpers/bankPayee.js — the name out of a bank line ────────────────────
//
// Apsara, 2026-11-05, on a deposit Jarvis could not place:
// "why my jarvis was not able to identify that?", then "Jarvis should able to
// identify everytgibg", then "Thats the edge we have over intutit quickbooks".
//
// The line was:
//
//   ARIS ENTERPRISES DES:ACH Pmt ID:XXXXX620487 INDN:Edge Metal Inc.
//   CO ID:XXXXX02235 CCD PMT INFO:Balance payment for Inv 261009_AP_26ARIS 03
//   on our PO 2026-641
//
// and helpers/bankLearn.js's resolver normalised THE WHOLE THING and looked
// for a ledger name equal to
// "arisenterprisesdesachpmtidxxxxx620487indnedgemetalinc...". Nothing is
// called that, so it asked her. The company name was the first two words.
//
// ── PARSING IS NOT GUESSING, AND THAT IS THE WHOLE POINT ─────────────────
// helpers/nameMatch.js refuses to match on near-misses, and it is right:
// "a near-miss resolves to the wrong company, and here that would allocate
// real money to the wrong customer's invoice." Nothing below weakens that.
//
// This file does not decide WHO a line belongs to. It only answers "which
// characters of this line are the counterparty's name", using the structure
// the banks themselves put there — DES:, ID:, INDN:, CO ID:, CCD, PMT INFO:
// are NACHA field markers, not prose. Removing a field marker and the value
// behind it is reading a format, the same way reading a CSV column is.
//
// What comes out is then matched EXACTLY, by the existing rules. "ARIS
// ENTERPRISES" either equals a ledger name after normalising or it does not.
// She is still asked when it does not. The difference is that she is asked
// once per COMPANY instead of once per PAYMENT.
//
// ── WHY ONCE PER PAYMENT WAS THE REAL BUG ────────────────────────────────
// The alias was keyed on the whole line, which contains "Pmt ID:XXXXX620487"
// and "PO 2026-641". Every ARIS payment carries a different payment id, so
// the next one missed again — while the screen promised "name it once and
// every future deposit from them matches itself". Proven by changing only
// the reference on a second line: with the alias in place it still resolved
// to null. The promise was false, and she would have been naming the same
// company forever.
'use strict';

// ── TWO SHAPES, AND A REFUSAL ────────────────────────────────────────────
// My first version assumed one shape — name first, machine detail after —
// and got 4 of 9 real formats right. The ones it broke taught the rest:
//
//   ARIS ENTERPRISES DES:ACH Pmt ID:...        name BEFORE the markers
//   ORIG CO NAME:NUR METAL ORIG ID:123         name AFTER a label
//   WIRE TYPE:WIRE IN DATE:... ORIG:INESH      name AFTER a label, late
//
// So a labelled name is looked for FIRST, and only if there is none does it
// fall back to "everything before the first marker".
//
// And when neither works cleanly it returns '' — which makes the screen ASK
// her. Apsara, 2026-11-05: "IF it find any difficulty,it should have asked
// for my help rather than neglecting or sitting dle". A wrong name here
// allocates real money to the wrong company; an honest '' costs one question.

// Labels whose VALUE is the counterparty. Ordered longest-first so
// 'ORIG CO NAME:' wins over 'ORIG:' on the same line.
//
// INDN: is deliberately NOT here. On a deposit it is the RECEIVER — Edge
// Metals itself — and using it would name every single incoming payment
// "Edge Metal Inc." Her own ARIS line proves it: "INDN:Edge Metal Inc."
const NAME_LABELS = ['ORIG CO NAME:', 'ORIG CO:', 'ORIG NAME:', 'COMPANY NAME:',
    'ORIG:', 'BNF:', 'OBI:', 'FROM:', 'PAYER:', 'PAYEE:', 'MERCHANT:'];

// Field markers. Everything from the first one onward is machine detail.
// Longest-first where one contains another, or a short marker cuts a long
// one in half and leaves its fragment glued to the name.
const MARKERS = [
    // 'ORIG ID:' before 'ID:', or the short one matches inside the long
    // one and leaves 'ORIG' stuck to the end of the name — which is
    // exactly what 'NUR METAL ORIG' was.
    'ORIG CO NAME:', 'ORIG CO:', 'ORIG ID:', 'ORIG NAME:', 'IND NAME:',
    'COMPANY NAME:', 'DESC DATE:', 'PMT INFO:', 'PMT ID:',
    'CO ID:', 'CO. ID:', 'COID:', 'ENTRY DESCR:', 'IND ID:', 'TRACE#:',
    'TRACE #:', 'EFFECTIVE:', 'DES:', 'INDN:', 'ORIG:', 'TRN:', 'RFB:',
    'OBI:', 'BNF:', 'EED:', 'SEC:', 'DISC:', 'ACCT:', 'REF:', 'MEMO:',
    'INFO:', 'TYPE:', 'DATE:', 'TIME:', 'ID:', 'NAME:',
];

// Lead-ins the bank prints BEFORE the name.
const LEAD_INS = [
    'DEPOSIT', 'WITHDRAWAL', 'ACH CREDIT', 'ACH DEBIT', 'ACH', 'CREDIT', 'DEBIT',
    'INCOMING WIRE', 'OUTGOING WIRE', 'WIRE TYPE', 'WIRE', 'BOOK TRANSFER',
    'PREAUTHORIZED', 'PPD', 'CCD', 'CTX', 'WEB', 'TEL', 'ELECTRONIC',
    'EXTERNAL TRANSFER', 'TRANSFER', 'PAYMENT FROM', 'PAYMENT', 'FROM',
    'ONLINE', 'MOBILE', 'DIRECT DEP', 'DIRECT DEPOSIT', 'REMOTE',
    'COUNTER CREDIT', 'ORIG',
];

// Lines that are the BANK talking, not a counterparty. Jarvis must not
// invent a company called "Service Charge".
const NOT_A_PARTY = [
    'ATM WITHDRAWAL', 'ATM DEPOSIT', 'ATM', 'CHECK', 'CHEQUE', 'SERVICE CHARGE',
    'MONTHLY FEE', 'MAINTENANCE FEE', 'OVERDRAFT', 'NSF FEE', 'WIRE FEE',
    'INTEREST', 'INTEREST PAID', 'ANALYSIS CHARGE', 'RETURNED ITEM',
    'COUNTER CREDIT', 'CASH DEPOSIT', 'BRANCH DEPOSIT', 'ADJUSTMENT',
];

// Reference phrases that trail a real name: "... FOR INV 26ME07",
// "... ON OUR PO 2026-641". Cut at the connective, with what follows.
const TAIL_PHRASES = /\s+\b(FOR|RE|REF|ON|AGAINST|TOWARDS?|VIA|PER)\b[\s:].*$/i;

// Trailing junk: a date, a long digit run, a masked reference.
const TAIL_JUNK = [
    /\s+\d{1,2}[\/-]\d{1,2}([\/-]\d{2,4})?$/,
    /\s+\d{4}-\d{2}-\d{2}$/,
    /\s+#?\d{5,}$/,
    /\s+[Xx]{3,}\d*$/,
];

const upper = (s) => String(s == null ? '' : s).toUpperCase();

function firstMarkerAt(text, from) {
    const U = upper(text);
    let cut = -1;
    for (const m of MARKERS) {
        const at = U.indexOf(m, from || 0);
        if (at >= 0 && (cut < 0 || at < cut)) cut = at;
    }
    return cut;
}

// A labelled name: the text after the label, up to the next marker.
function labelledName(text) {
    const U = upper(text);
    let best = null;
    for (const lab of NAME_LABELS) {
        const at = U.indexOf(lab);
        if (at < 0) continue;
        if (best && best.at <= at) continue;
        best = { at, lab };
    }
    if (!best) return '';
    const from = best.at + best.lab.length;
    const end = firstMarkerAt(text, from);
    return (end < 0 ? text.slice(from) : text.slice(from, end)).trim();
}

function beforeFirstMarker(text) {
    const cut = firstMarkerAt(text, 0);
    return cut < 0 ? text : text.slice(0, cut);
}

function stripLeadIns(text) {
    let out = String(text || '').trim();
    for (let guard = 0; guard < 6; guard += 1) {
        const U = upper(out);
        let hit = '';
        for (const w of LEAD_INS) {
            if (U === w) { hit = w; break; }
            if (U.startsWith(w + ' ') && w.length > hit.length) hit = w;
        }
        if (!hit) break;
        out = out.slice(hit.length).replace(/^[\s:\u00b7,-]+/, '').trim();
        if (!out) break;
    }
    return out;
}

function stripTail(text) {
    let out = String(text || '').replace(TAIL_PHRASES, '').trim();
    for (let guard = 0; guard < 4; guard += 1) {
        const before = out;
        for (const re of TAIL_JUNK) out = out.replace(re, '').trim();
        if (out === before) break;
    }
    return out;
}

// ── THE ONE EXPORT THAT MATTERS ──────────────────────────────────────────
// Returns the counterparty's name as it appears in the line, or '' when the
// line carries no name at all. NEVER returns a guess and never returns a
// partial word: when nothing survives the strip, '' is the honest answer and
// the caller falls back to asking her.
function payeeOf(descriptor) {
    const raw = String(descriptor == null ? '' : descriptor).replace(/\s+/g, ' ').trim();
    if (!raw) return '';

    // A labelled name wins: 'ORIG CO NAME:NUR METAL' means the bank told us
    // outright. Only when there is no label do we take the leading text.
    let name = stripTail(stripLeadIns(labelledName(raw)));
    if (!name) name = stripTail(stripLeadIns(beforeFirstMarker(raw)));

    // Trailing connective words left behind by a cut: "PAYMENT FROM ARIS
    // ENTERPRISES FOR" -> "ARIS ENTERPRISES".
    name = name.replace(/\s+(FOR|TO|VIA|REF|ON|OUR)$/i, '').trim();
    // Punctuation a cut can strand at either end.
    name = name.replace(/^[\s:*·,.-]+|[\s:*·,.-]+$/g, '').trim();

    // ── WHEN NOT TO ANSWER ───────────────────────────────────────────────
    // A single character, or nothing but digits and symbols, is not a name.
    // Returning it would hand the exact-matcher a token that could collide
    // with a real short ledger name, which is the near-miss nameMatch.js
    // exists to prevent.
    if (name.length < 2) return '';
    if (!/[A-Za-z]/.test(name)) return '';
    // The bank talking to itself is not a counterparty.
    const U = upper(name);
    if (NOT_A_PARTY.some((w) => U === w || U.startsWith(w + ' '))) return '';
    // ── A COLON LEFT BEHIND MEANS I DID NOT UNDERSTAND THE FORMAT ────────
    // Rather than hand the exact-matcher half a field name, say nothing and
    // let her be asked. "IF it find any difficulty,it should have asked for
    // my help rather than neglecting" — an honest '' is the ask.
    if (/[:]/.test(name)) return '';
    return name;
}

// True when the line gave up a name DIFFERENT from the whole line — i.e.
// there was machine detail to strip. Used by the screen to explain itself
// ("read as ARIS ENTERPRISES") rather than silently changing what it matched.
function wasTrimmed(descriptor) {
    const raw = String(descriptor == null ? '' : descriptor).replace(/\s+/g, ' ').trim();
    const name = payeeOf(raw);
    return !!name && name.toLowerCase() !== raw.toLowerCase();
}

module.exports = { payeeOf, wasTrimmed, MARKERS, LEAD_INS };
