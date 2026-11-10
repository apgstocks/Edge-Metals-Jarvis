// helpers/priceCommands.js — the exact words that answer a price question over WhatsApp. Strict grammar, pure, no I/O.
//   normal <CODE>    that price is normal for them
//   check <CODE>     that price is wrong or needs looking at
// The AI classifier never chooses these, and one acts only when its code belongs to a real, unanswered price question
// (workflow/brain.js checks that), so "check ABCD" in an ordinary sentence changes nothing.
'use strict';
const CODE = '([A-HJ-NP-Z2-9]{4})';
function parse(text) {
    const m = String(text == null ? '' : text).trim().match(new RegExp(`^(normal|check)\\s+${CODE}$`, 'i'));
    return m ? { kind: 'price_answer', label: m[1].toLowerCase(), code: m[2].toUpperCase() } : null;
}
module.exports = { parse };
