// helpers/selfBuildCommands.js — the exact words that talk to helpers/selfBuild.js over WhatsApp.
// Strict grammar on purpose: a build is a code change, so nothing here is guessed from loose
// wording and the AI classifier is never allowed to choose it. Pure; no I/O.
//   build: <what you want>        start a build
//   yes build <id> / no build <id> / rollback build <id>
//   builds                        list recent builds
'use strict';
const ID = '(b[0-9a-z]{6,12})';
function parse(text) {
    const t = String(text == null ? '' : text).trim();
    let m;
    if ((m = t.match(/^(?:jarvis[,:\s]+)?build\s*:\s*([\s\S]{8,})$/i))) return { kind: 'request', text: m[1].trim() };
    if ((m = t.match(new RegExp(`^yes\\s+build\\s+${ID}$`, 'i')))) return { kind: 'approve', id: m[1].toLowerCase() };
    if ((m = t.match(new RegExp(`^no\\s+build\\s+${ID}$`, 'i')))) return { kind: 'reject', id: m[1].toLowerCase() };
    if ((m = t.match(new RegExp(`^rollback\\s+build\\s+${ID}$`, 'i')))) return { kind: 'rollback', id: m[1].toLowerCase() };
    if (/^(?:builds|list\s+builds|show\s+builds)$/i.test(t)) return { kind: 'list' };
    return null;
}
module.exports = { parse };
