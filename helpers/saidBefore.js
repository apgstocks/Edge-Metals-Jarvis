// helpers/saidBefore.js — "what has she already told me that bears on this message?"
// Reads helpers/inboundLog.js. Apsara, 2026-11-09: "No decision reads your notes yet it must use".
//
// ADVISORY ONLY. The lines go into the classifier prompt under a header that says they are
// history, not instructions. This module decides nothing and runs no action.
//
// Deliberately NOT built on textIndex: that index is rebuilt whenever its sources change,
// and this log changes on every message, so using it per message would rebuild the whole
// mail/invoice index every time she types.
//
// Match rule: a past message is related only if it shares at least 2 distinctive words
// (4+ letters, not stop words) with the new one. One shared word ("Zimex") is too loose.
// Never throws. Off switch: JARVIS_SAID_BEFORE=0.
'use strict';
const il = require('./inboundLog');

const STOP = new Set(('that this with from have will your what when where which would could should about there their them they then than into over '
    + 'just also please need want send make give tell show check does done been being were was are and for the you our not but can get got let '
    + 'now still more some any all one two new old').split(/\s+/));
const words = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)));
const clip = (s, n) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

let cache = { key: '', rows: [] };
function rows(file) {
    try {
        const st = require('fs').statSync(file);
        const key = st.mtimeMs + ':' + st.size;
        if (cache.file === file && cache.key === key) return cache.rows;
        cache = { file, key, rows: il.readAll(file) };
        return cache.rows;
    } catch (e) { return []; }
}

function related(text, opts) {
    try {
        if (process.env.JARVIS_SAID_BEFORE === '0') return [];
        const { limit = 3, messageId = null, clipTo = 240, file = il.logFile() } = opts || {};
        if (!file) return [];
        const mine = words(text);
        if (mine.size < 2) return [];
        const self = String(text || '').replace(/\s+/g, ' ').trim();
        const scored = [];
        for (const r of rows(file)) {
            if (messageId && r.messageId === messageId) continue;
            if (String(r.text).replace(/\s+/g, ' ').trim() === self) continue;   // the same words again are not new information
            const theirs = words(r.text);
            let shared = 0;
            for (const w of mine) if (theirs.has(w)) shared++;
            if (shared >= 2) scored.push({ shared, at: String(r.at || ''), text: r.text });
        }
        scored.sort((a, b) => b.shared - a.shared || b.at.localeCompare(a.at));
        return scored.slice(0, Math.max(0, limit)).map((s) => ({ at: s.at.slice(0, 10), text: clip(s.text, clipTo) }));
    } catch (e) { return []; }
}

// The block for the prompt, or '' when there is nothing.
function block(text, opts) {
    const hits = related(text, opts);
    if (!hits.length) return '';
    return hits.map((h) => `- ${h.at || 'earlier'}: "${h.text}"`).join('\n');
}

module.exports = { related, block };
