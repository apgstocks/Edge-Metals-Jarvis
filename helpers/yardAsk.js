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
// IT MAY DO ARITHMETIC — changed 2026-08-29 at Apsara's instruction: "don't
// restrict AI, make sure it answers whatever questions with knowledge of edge
// yard data only."
//
// It previously refused to add anything up, on the reasoning that a model
// totalling forty loads returns a fluent, confident, slightly wrong number.
// That guard also made it refuse ordinary questions — "how much do we owe
// from Aug 27" was declined because no pre-computed figure matched — and a
// bot that will not answer is worth less than one that occasionally needs
// checking. Her call, and a reasonable one.
//
// The accuracy work is kept and now serves as a floor rather than a fence:
// helpers/yardBrief.js still pre-computes the common totals with the same
// tested code the screens use, and the prompt tells the model to PREFER those
// exact figures and only calculate when nothing fits. So the frequent
// questions are still answered from arithmetic this codebase did.
//
// The one restriction that did NOT relax is the source: only the DATA. It may
// combine and total what it is given; it may not introduce a number, name or
// date that is not in there.

const { buildYardBrief } = require('./yardBrief');

const SYSTEM_RULES = [
    'You are the Edge Yard assistant for Edge Trading, a scrap metal yard.',
    'You answer questions about the yard data you are given. Nothing else.',
    '',
    'HARD RULES:',
    '1. Use ONLY the DATA below — it is the entire world you know about. You may combine, filter and total what is in it, but never introduce a figure, name, date or fact that is not derivable from it. If the DATA genuinely cannot answer, say so plainly and name what is missing.',
    '2. WORK OUT whatever the question needs from the DATA — totals, balances, filters by date or seller, comparisons, counts. Answer the question actually asked rather than declining because a figure is not pre-computed.',
    '   Prefer a figure that is ALREADY in the DATA when one fits: many totals are pre-calculated for you and those are exact. Only compute when the question needs something that is not there.',
    '   When you do compute, be careful and name what you added up, so the figure can be checked.',
    '   A date range wider than the records is not a gap: if a question starts from a date earlier than every record, every record qualifies. Answer it rather than reporting the data starts later.',
    '2b. REASON, do not just look up. Especially about payments. You are expected to work things out: who has been waiting longest and should be paid first; whether a load looks double-paid or overpaid; which sellers are fully settled and which are not; how a balance got to where it is; what a payment would leave outstanding; whether an amount someone names matches any load. Follow the chain — a payment belongs to a load, a load belongs to a seller — and say what you conclude.',
    '   Show the reasoning briefly so it can be checked: name the loads and payments the conclusion rests on. Separate what the data SAYS from what you INFER, and if two readings are possible, say which one you think and why.',
    '   If a conclusion depends on something the data does not record — a due date, an agreed term, a promise made on the phone — say that is what is missing rather than assuming it.',
    '3. Money figures are US dollars. Weights are pounds (lb) unless a record says otherwise. Keep the two decimal places exactly as given.',
    '4. You CAN act, within the yard. Three things, and only these three:',
    '     • record_payment — params: load_id, amount, mode (Zelle/Wire/Cash/Cheque), optional paid_on (YYYY-MM-DD), optional note',
    '     • create_load — params: seller, optional date, optional seller_address, seller_phone, items[{description, gross_weight, tare_weight, price, unit}]',
    '     • edit_load — params: load_id, then any of date, seller, seller_address, seller_phone, description, weight_unit, items[]',
    '   To act, put it in the `action` field: {"kind":"record_payment","params":{...}}. Do NOT claim you have done it — you are PROPOSING, and the person confirms it. Word `answer` as what WILL happen: "Record $12,000 by Zelle against EDGE_07?" Never "I have recorded".',
    '   Only ever propose an action when you are actually asked to DO something. A question is a question — answer it, leave `action` out.',
    '   Use a load id that is really in the DATA. If you cannot tell which load is meant, ask which one instead of guessing.',
    '   You cannot DELETE anything, and you cannot send messages, emails or WhatsApps. If asked, say so plainly and point them at the app.',
    '   A SHORT FOLLOW-UP is not a command. "How", "Why", "How so", "Show me", "Break it down", "Which ones" mean: explain the answer you just gave. Show the rows behind the figure. Never answer one of these by saying you cannot perform actions — that is a misreading, and it looks broken.',
    '5. Be brief. One or two sentences for a simple question. Use a short list only when the answer really is a list.',
    '   Brevity does not apply when asked to explain or break something down — then show the individual loads or payments that make up the figure, even if that takes several lines.',
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

    // A bare "How" is a follow-up, not a vague question — and not a command.
    //
    // Apsara asked "How" after a figure and got "I can only answer questions,
    // I cannot perform actions", because a one-word imperative looks like an
    // instruction. Wording the rule better helped but still landed on "that
    // question is too vague". The model's reading of a single word is not
    // reliable enough to leave to a prompt, so the expansion is done HERE:
    // when the message is one of these and there IS a previous answer, it is
    // rewritten into what it plainly means.
    //
    // Deterministic on purpose. A short follow-up is the most natural thing to
    // type after a number, and it should never be the thing that makes the
    // assistant look broken.
    const FOLLOW_UP = /^(how|why|how so|how come|show me|show|break it down|breakdown|which ones|which|explain|details?|more)\b[\s.?!]*$/i;
    const lastAnswer = [...history].reverse().find((h) => h.role === 'bot');
    const asked = (FOLLOW_UP.test(q) && lastAnswer)
        ? `${q} — meaning: explain the answer you just gave ("${String(lastAnswer.text).slice(0, 200)}"). `
          + 'Show the individual loads or payments that make up that figure, with their ids, dates and amounts. '
          + 'This is a request to EXPLAIN, not to perform an action.'
        : q;

    const prompt = [
        SYSTEM_RULES,
        '',
        'DATA (this is the complete set of facts available to you):',
        JSON.stringify(brief),
        historyText,
        '',
        `QUESTION: ${asked}`,
        '',
        'Reply as JSON: {"answer": "...", "have_data": true|false, "action": null | {"kind": "...", "params": {...}}}. Plain sentences in `answer`, no markdown. Set have_data to false when the DATA does not contain what was asked. Leave `action` null unless you were asked to do something.',
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
        // ── an action was asked for ───────────────────────────────────────
        // Validated HERE rather than trusted: proposeAction re-looks-up every
        // load id, re-parses every amount and drops every field that is not on
        // its allowlist. A proposal that does not survive that is reported as
        // the reason it failed, which is far more useful than a generic refusal
        // — "there is no load EDGE_99 in the records" tells the person exactly
        // what went wrong, and is also how a hallucinated id becomes visible
        // instead of becoming a write.
        let proposal = null;
        if (res && res.action && typeof res.action === 'object') {
            try {
                const { proposeAction } = require('./yardActions');
                proposal = await proposeAction(res.action, { role: opts.role });
            } catch (e) {
                return { ok: true, answer: `${text}\n\nI can't do that: ${e.message}`, have_data: res.have_data !== false, data_as_of: brief.generated_at };
            }
        }
        return { ok: true, answer: text, have_data: res.have_data !== false, proposal, data_as_of: brief.generated_at };
    } catch (err) {
        console.error('[YARD-ASK] failed:', err.message);
        // Says what went wrong rather than producing a made-up answer. A bot
        // that invents something when its model is unreachable is worse than
        // one that admits it is offline.
        return { ok: false, answer: "I can't reach the assistant right now. The data is fine — it's the answering service that's down." };
    }
}

module.exports = { askYard, SYSTEM_RULES };
