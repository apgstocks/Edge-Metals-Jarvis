// helpers/depositCommands.js — the exact words that talk to helpers/depositAutoApply.js over WhatsApp.
// Strict grammar, pure, no I/O. The AI classifier never chooses these: "undo" removes a receipt.
//   undo <CODE>                      undo one automatic deposit (CODE is the 4 characters in the daily report)
//   undo <CODE>: <what was wrong>    the same, and tell Jarvis what was wrong
//   resume auto deposits for <name>  lift the pause on a customer
//   yes <CODE> / no <CODE>           answer a "not sure" question from the daily message (place it / leave it)
// A bare "undo send" must NOT match: the brain only acts on an undo whose code belongs to a real automatic deposit.
'use strict';
const CODE = '([A-HJ-NP-Z2-9]{4})';
function parse(text) {
    const t = String(text == null ? '' : text).trim();
    let m;
    if ((m = t.match(new RegExp(`^undo(?:\\s+deposit)?\\s+${CODE}(?:\\s*(?::|-|because)\\s*([\\s\\S]{2,200}))?$`, 'i')))) {
        return { kind: 'undo', code: m[1].toUpperCase(), reason: m[2] ? m[2].trim() : null };
    }
    if ((m = t.match(new RegExp(`^(yes|no)\\s+${CODE}$`, 'i')))) return { kind: m[1].toLowerCase() === 'yes' ? 'confirm' : 'decline', code: m[2].toUpperCase() };
    if ((m = t.match(/^resume\s+auto\s+deposits?\s+for\s+([^\n]{2,60})$/i))) return { kind: 'resume', customer: m[1].trim() };
    return null;
}
module.exports = { parse };
