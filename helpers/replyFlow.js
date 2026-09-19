// ── helpers/replyFlow.js — "reply to …" said the way people say it ──────────
//
// Apsara, 2026-09-19: "say in email digest-we have received something. if i
// ask jarvis voice-to send a reply to that. can it do it?" — then "all four",
// and: "if i have two emails from A, if i say reply to A --> then it should
// show two mails --> ask which one to respond to .. on user confirmation start
// drafting the mail - it should show the drafted mail. if user says like
// jarvis --> Tell them that we are in some issue and we will send it later.
// Jarvis should able to draft it professionally ... Ask for confirmation by
// showing drafted email to user."
//
// Measured before this file existed, against a real server:
//   "reply to 2 saying …"            worked
//   "reply to two / the second one / number 2 saying …"   read "two" as a PERSON
//   "reply to the Houston cutoff email …"                  same
//   "reply to that"                                        "I couldn't pin that down"
//
// Everything here is PURE — no I/O, no Gemini — so brain.js's synchronous
// policy layer can call it and tests can pin it down exactly. The actions that
// use it live in workflow/actions.js beside the reply code they extend.

const { positionOf } = require('./pickFromList');

// ── 1. "reply to two", "reply to the second one", "reply to number 2" ──────
// Returns { index, details } or null. Digits are NOT handled here — brain.js
// already has an exact rule for "reply to 2", and this only adds the spoken
// forms a speech engine or a person produces instead of a digit.
const DETAILS_SPLIT = /\s*(?:[:\-—]\s*|\s+(?:saying|with|about|and\s+say|and\s+tell\s+them|tell(?:ing)?\s+them)\s+)/i;
function spokenDigestIndex(text) {
    const t = String(text || '').trim().replace(/[.!?]+$/, '');
    const m = /^(?:please\s+)?(?:jarvis[,\s]+)?reply\s+(?:to\s+)?(.+)$/i.exec(t);
    if (!m) return null;
    let head = m[1], details = null;
    const cut = DETAILS_SPLIT.exec(head);
    if (cut) { details = head.slice(cut.index + cut[0].length).trim() || null; head = head.slice(0, cut.index); }
    head = head.replace(/\s+(?:email|mail|message|one)$/i, ' one').trim();
    // Must be ONLY a position — "reply to two containers" is not one.
    if (!/^(?:(?:the|number|no\.?|#)\s+)*(?:[a-z]+|\d{1,2}(?:st|nd|rd|th)?)(?:\s+one)?$/i.test(head)) return null;
    if (/^\d{1,2}$/.test(head)) return null;          // brain.js's own rule
    const pos = positionOf(head, 99);
    if (!pos || pos < 1 || pos > 50) return null;
    // "to", "too", "for", "won", "ate" are in WORD_NUMBERS for answering a
    // numbered list, where nothing else is plausible. After "reply to" they
    // are far more likely to be the start of a name — refuse them here.
    if (/^(?:to|too|tu|for|won|ate)$/i.test(head.trim())) return null;
    return { index: String(pos), details };
}

// ── 2. "reply to the Houston cutoff email" ──────────────────────────────────
// Matched against what the digest actually said, never guessed at. Returns
// { index } for one clear winner, { ambiguous: [indexes] } for a tie, or null.
const STOP = new Set(('the a an to of for on in about from re regarding that this those these '
    + 'email mail message one thread reply respond please jarvis my our their them it '
    + 'and or with is was be at by as').split(' '));
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));

function describedDigestTarget(text) {
    const t = String(text || '').trim().replace(/[.!?]+$/, '');
    const m = /^(?:please\s+)?(?:jarvis[,\s]+)?reply\s+to\s+(?:the\s+)?(.+?)\s+(?:email|mail|message|one|thread)(?:\s+(?:from\s+.+?))?(?:\s*(?:[:\-—]\s*|\s+(?:saying|with|and\s+say|and\s+tell\s+them|tell(?:ing)?\s+them)\s+)(.+))?$/i.exec(t);
    if (!m) return null;
    return { desc: m[1].trim(), details: (m[2] || '').trim() || null };
}

function matchDigest(desc, items) {
    const want = words(desc);
    if (!want.length || !Array.isArray(items) || !items.length) return null;
    const scored = items.map((it, i) => {
        const have = new Set(words([it.fromName, it.from, it.subject, it.gist, it.summary, it.asked_for].filter(Boolean).join(' ')));
        return { index: i + 1, score: want.filter((w) => have.has(w)).length };
    });
    const best = Math.max(...scored.map((s) => s.score));
    // At least half of what she said has to be in the item — one shared word
    // like "container" is not a match on a freight inbox.
    if (best < Math.max(1, Math.ceil(want.length / 2))) return null;
    const top = scored.filter((s) => s.score === best).map((s) => s.index);
    return top.length === 1 ? { index: String(top[0]) } : { ambiguous: top };
}

// ── 3. "reply to that" ──────────────────────────────────────────────────────
function replyToThat(text) {
    const t = String(text || '').trim().replace(/[.!?]+$/, '');
    const m = /^(?:please\s+)?(?:jarvis[,\s]+)?(?:reply|respond)\s+to\s+(?:that|this|it)(?:\s+(?:one|email|mail|message))?(?:\s*(?:[:\-—]\s*|\s+(?:saying|with|and\s+say|and\s+tell\s+them|tell(?:ing)?\s+them)\s+)(.+))?$/i.exec(t);
    return m ? { details: (m[1] || '').trim() || null } : null;
}

// ── 4. An instruction to CHANGE an open draft ──────────────────────────────
// "tell them we are in some issue and will send it later", "make it
// shorter", "add that the truck is delayed". Deliberately a closed list of
// how an instruction STARTS: anything else at an open draft keeps today's
// behaviour (yes / no / schedule / the arbiter), because a brand-new request
// misread as an edit would quietly rewrite a mail she already approved the
// wording of.
const REVISE = /^(?:ok(?:ay)?[,\s]+|no[,\s]+|actually[,\s]+|instead[,\s]+|jarvis[,\s]+|please\s+|pls\s+|and\s+)*(?:tell\s+(?:them|him|her)|let\s+(?:them|him|her)\s+know|say\s+(?:that|we|i|it)|mention|add|include|ask\s+(?:them|him|her)|inform\s+(?:them|him|her)|apologi[sz]e|explain|write|rewrite|reword|rephrase|redo|redraft|change|make\s+it|keep\s+it|remove|drop|take\s+out|don'?t\s+(?:say|mention)|also\s+(?:say|mention|tell|add|ask)|be\s+(?:more|less)|sound\s+(?:more|less)|more\s+(?:formal|polite|friendly|firm)|less\s+(?:formal|casual)|shorter|longer|softer|firmer)\b/i;
function isRevision(text) {
    return REVISE.test(String(text || '').trim());
}

// ── the picker's labels ─────────────────────────────────────────────────────
function threadLabel(c) {
    const subj = String(c.subject || '(no subject)').replace(/\s+/g, ' ').trim().slice(0, 70);
    const d = c.date ? new Date(c.date) : null;
    const when = d && !isNaN(d) ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    return `"${subj}"${when ? ' — ' + when : ''}`;
}

module.exports = { spokenDigestIndex, describedDigestTarget, matchDigest, replyToThat, isRevision, threadLabel };
