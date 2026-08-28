// ── helpers/yardAsk.js — the Edge Yard helper bot ──────────────────────────
//
// Per Apsara 2026-08-28: "a helper bot which has complete idea about edge
// yard. if i ask any question related to that data, it should answer."
//
// STRICTLY READ-ONLY, and that is a deliberate boundary rather than an
// omission. This repo already has a bot path that DOES things —
// /api/bot/command routes into workflow/brain.js and can message truckers,
// book loads and send WhatsApp messages for real. Answering "how much do we
// owe Acme?" must not be one keystroke away from messaging Acme. So this is a
// separate endpoint with no route into the brain, no actions, and nothing it
// can write. The worst outcome of a bad answer here is a wrong sentence, not a
// wrong message sent to a supplier.
//
// THE MODEL DOES NO ARITHMETIC. Every figure comes pre-computed from
// helpers/yardBrief.js, which reuses the same tested code the screens use. A
// model asked to total forty loads returns a fluent, confident, slightly wrong
// number — and slightly wrong, about money, in a confident tone is the worst
// possible failure for this. The prompt says so explicitly, and the fallback
// below assumes the model may still get it wrong.

const { buildYardBrief } = require('./yardBrief');

const SYSTEM_RULES = [
    'You are the Edge Yard assistant for Edge Trading, a scrap metal yard.',
    'You answer questions about the yard data you are given. Nothing else.',
    '',
    'HARD RULES:',
    '1. Use ONLY the DATA below. If the answer is not in it, say plainly that you do not have that information and name what you would need. Never guess and never fill a gap with something plausible.',
    '2. Do NOT do arithmetic. Every total, balance and weight you need has already been calculated and is in the DATA. Quote those figures exactly as given. If a question needs a number that is not there, say so instead of working it out.',
    '3. Money figures are US dollars. Weights are pounds (lb) unless a record says otherwise. Keep the two decimal places exactly as given.',
    '4. You cannot DO anything — you cannot create, edit, delete, send or pay. If asked to, say that you can only answer questions, and tell them where in the app to do it.',
    '5. Be brief. One or two sentences for a simple question. Use a short list only when the answer really is a list.',
    '6. Never invent a seller, load id, date or amount. If someone asks about a name you cannot see in the data, say it is not in the records you have.',
].join('\n');

// Trimmed so an unusual question cannot walk the model into a long essay, and
// so a runaway response cannot cost much.
const MAX_QUESTION_CHARS = 500;

async function askYard(question, opts = {}) {
    const q = String(question || '').trim().slice(0, MAX_QUESTION_CHARS);
    if (!q) return { ok: false, answer: 'Ask me something about the yard — loads, sellers, stock, or what is still owed.' };

    const brief = buildYardBrief({ days: opts.days || 30 });

    // Recent turns, so "and how much of that is unpaid?" works. Bounded hard:
    // an unbounded transcript is a slow, expensive prompt that also gives the
    // model more room to drift off the data.
    const history = Array.isArray(opts.history) ? opts.history.slice(-6) : [];
    const historyText = history.length
        ? '\nEARLIER IN THIS CONVERSATION:\n' + history.map((h) => `${h.role === 'bot' ? 'You' : 'They'}: ${String(h.text || '').slice(0, 300)}`).join('\n')
        : '';

    const prompt = [
        SYSTEM_RULES,
        '',
        'DATA (this is the complete set of facts available to you):',
        JSON.stringify(brief),
        historyText,
        '',
        `QUESTION: ${q}`,
        '',
        'Reply as JSON: {"answer": "...", "have_data": true|false}. Plain sentences in `answer`, no markdown. Set have_data to false when the DATA does not contain what was asked.',
    ].join('\n');

    try {
        // callGeminiJSON, not a text call. helpers/gemini.js records that
        // callGeminiText was removed in a 2026-07-16 cleanup along with its
        // dead callers, and says explicitly: if a text-only call is wanted
        // again, re-add it deliberately rather than restoring that pair. So
        // this uses the live, tested JSON path instead of resurrecting it.
        //
        // The schema also earns its place: `have_data` lets the bot say "not
        // in the records" as a distinct outcome rather than dressing a gap up
        // as an answer, which is the failure this whole file is built to
        // avoid.
        const { callGeminiJSON } = require('./gemini');
        // No schema argument. callGeminiJSON's third parameter takes a ZOD
        // schema and calls .safeParse on it — a plain JSON-Schema object has
        // no such method, so passing one throws inside the retry loop and
        // every question comes back empty. Found by running real questions
        // through it rather than by reading the signature.
        //
        // The shape is small enough to check here, which also avoids making
        // this file depend on zod loading, something helpers/gemini.js already
        // guards defensively.
        const res = await callGeminiJSON(prompt, 1);
        const text = String((res && res.answer) || '').trim();
        if (!text) {
            return { ok: false, answer: "I couldn't work out an answer to that. Try asking it a different way." };
        }
        return { ok: true, answer: text, have_data: res.have_data !== false, data_as_of: brief.generated_at };
    } catch (err) {
        console.error('[YARD-ASK] failed:', err.message);
        // Says what went wrong rather than producing a made-up answer. A bot
        // that invents something when its model is unreachable is worse than
        // one that admits it is offline.
        return { ok: false, answer: "I can't reach the assistant right now. The data is fine — it's the answering service that's down." };
    }
}

module.exports = { askYard, SYSTEM_RULES };
