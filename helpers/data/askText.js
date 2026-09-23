// ── helpers/data/askText.js — "what did they actually say?" ────────────────
//
// The other half of Phase 2. helpers/data/askData.js answers questions whose
// answer is a NUMBER; this one answers questions whose answer is in WORDS —
// mail, the invoices Jarvis printed, the documents on disk, quote replies,
// and the things she has taught it.
//
// ── RETRIEVE, THEN READ. NOT "ASK THE MODEL" ────────────────────────────────
// Three rules, and they are the difference between a search that can be
// trusted and one that sounds right:
//   1. The model sees ONLY the passages retrieved for this question. It is
//      told, in the prompt, that anything not in them does not exist.
//   2. Every claim carries a source number, and the sources are printed under
//      the answer with who, what and when — so a wrong answer is traceable in
//      one glance rather than being a sentence with no parents.
//   3. When the passages do not contain the answer, saying so IS the answer.
//      A retrieval system that never says "not in what I have" is one that
//      invents, and on a customer's terms that is worse than silence.
//
// The index holds Jarvis's own assessments of mail (helpers/data/textIndex.js
// says why the mailbox itself is not copied here), so when the hits are
// emails their REAL bodies are fetched from Gmail, live, for the handful this
// question landed on — the summary finds it, the actual words answer it.
const textIndex = require('./textIndex');

const MAX_BODY = 4000;
const cut = (s, n) => (String(s || '').length > n ? String(s).slice(0, n) + ' …' : String(s || ''));

// The real text of the emails the search landed on. Best effort: no Gmail on
// this box, or a message that has since been deleted, degrades to the
// assessment Jarvis already had, and the answer says which it used.
async function hydrate(hits, { max = 3 } = {}) {
    const wanted = hits.filter((h) => h.kind === 'email' && h.ref).slice(0, max);
    if (!wanted.length) return { hits, fetched: 0 };
    let gmail = null;
    try {
        const { getGmailRead } = require('../gmail');
        gmail = await getGmailRead();
    } catch (e) { gmail = null; }
    if (!gmail) return { hits, fetched: 0, gmail: false };
    const { getMessage, getEmailContent } = require('../gmail');
    let fetched = 0;
    const out = [];
    for (const h of hits) {
        if (!wanted.includes(h)) { out.push(h); continue; }
        try {
            const full = await getMessage(gmail, h.ref);
            const { body } = getEmailContent(full.payload) || {};
            if (body && body.trim()) {
                fetched += 1;
                out.push({ ...h, body: cut(body.trim(), MAX_BODY), full_text: true });
                continue;
            }
        } catch (e) { console.warn(`[ASKTEXT] could not read email ${h.ref}: ${e.message}`); }
        out.push(h);
    }
    return { hits: out, fetched, gmail: true };
}

const LABEL = { email: 'Email received', sent_email: 'Email Jarvis sent', invoice: 'Invoice',
    document: 'Document on file', quote_reply: 'Quote reply', fact: 'Something you told me', context: 'Business context' };

function passages(hits) {
    return hits.map((h, i) => [
        `[${i + 1}] ${LABEL[h.kind] || h.kind}${h.who ? ` from ${h.who}` : ''}${h.when_at ? ` on ${h.when_at}` : ''}`,
        h.title ? `Subject: ${h.title}` : '',
        cut(h.body, MAX_BODY),
    ].filter(Boolean).join('\n')).join('\n\n');
}

function prompt(question, hits) {
    return `Answer Apsara's question about her freight business USING ONLY the passages below.

RULES:
- Every fact in your answer must come from a passage, and you cite it as [1], [2].
- If the passages do not answer the question, say so plainly in "answer" and set "found" to false. Do not guess, and do not fill a gap with what is usually true.
- Quote figures, dates and container numbers exactly as the passage writes them.
- Two or three sentences. She is often listening rather than reading.

PASSAGES:
${passages(hits)}

QUESTION: ${question}

JSON only: {"answer": "...", "found": true, "used": [1, 2]}`;
}

// Returns { ok, spoken, screen, hits, used }.
async function ask(question, opts = {}) {
    const { callGeminiJSON } = require('../gemini');
    let found;
    try { found = textIndex.search(question, { limit: opts.limit || 10, kinds: opts.kinds || null }); }
    catch (e) { return { ok: false, spoken: `I can't search what I've got right now: ${e.message}`, screen: null, error: e.message }; }

    if (!found.hits.length) {
        const what = found.info && found.info.total;
        return { ok: true, empty: true,
            spoken: "Nothing I have on file mentions that.",
            screen: `Nothing matched "${question}".\n\nI searched ${what || 0} things: mail I've assessed, mail I've sent, invoices, documents, quote replies and what you've taught me. If it was only ever said on a call or on WhatsApp, it isn't here.`,
            hits: [] };
    }

    const { hits, fetched, gmail } = await hydrate(found.hits, { max: opts.fetch === 0 ? 0 : 3 });
    const out = await callGeminiJSON(prompt(question, hits));
    if (!out || typeof out.answer !== 'string' || !out.answer.trim()) {
        // The retrieval still worked, so she gets the sources rather than
        // nothing — the search is useful even when the summariser is not.
        return { ok: true, degraded: true,
            spoken: `I found ${hits.length} things that mention that but couldn't read them back — they're on screen.`,
            screen: sourceList(hits), hits };
    }

    const used = Array.isArray(out.used) ? out.used.filter((n) => Number.isInteger(n) && n >= 1 && n <= hits.length) : [];
    const cited = used.length ? used.map((n) => hits[n - 1]) : hits.slice(0, 3);
    const answer = String(out.answer).trim();
    const screen = [
        answer,
        sourceList(cited, used.length ? used : null),
        `Searched ${found.info.total} things on file${fetched ? `, read ${fetched} email${fetched === 1 ? '' : 's'} in full` : ''}${gmail === false ? ' (Gmail not connected, so I used my own notes on the mail)' : ''}.`,
    ].join('\n\n');

    return { ok: true, found: out.found !== false, spoken: answer, screen, hits, used: cited };
}

function sourceList(hits, numbers) {
    return ['Where that comes from:', ...hits.map((h, i) => {
        const n = numbers ? numbers[i] : i + 1;
        return `[${n}] ${LABEL[h.kind] || h.kind}${h.who ? ` — ${h.who}` : ''}${h.title ? ` — ${h.title}` : ''}${h.when_at ? ` (${h.when_at})` : ''}`;
    })].join('\n');
}

module.exports = { ask, prompt, passages, hydrate, sourceList };
