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
    // ── GENERATED, NOT WRITTEN HERE ───────────────────────────────────────
    // This block used to be hand-typed prose listing three actions and their
    // parameters, kept in step with helpers/yardActions.js by memory. It
    // drifted: six features shipped after it was written — trucker bills,
    // expenses, petty cash, the spend report, the inventory drill-down, sales
    // — and the assistant was told about none of them, so it answered "I
    // can't do that" to things the app had done for weeks.
    //
    // It is now built from helpers/tools.js, which is where a capability is
    // declared. The prompt cannot advertise a tool that does not exist, and
    // cannot miss one that does.
    // ── AND IT CAN NOW ACTUALLY CALL THEM ─────────────────────────────────
    // Apsara, 2026-09-06: "when i ask jarvis what bookings that we have from
    // houston, its saying that it doesnt have any idea about this."
    //
    // It did not, and the reason was structural. This prompt has DESCRIBED
    // the read tools since the registry was written, and nothing has ever
    // EXECUTED one: runRead() in helpers/tools.js had no caller outside its
    // own tests. So the model was handed a list of instruments it could not
    // pick up, plus a fixed digest of loads and stock, and asked to answer
    // from that. Anything outside the digest — bookings, containers, cutoffs
    // — was genuinely unknowable to it, and "I don't have any idea" was the
    // honest answer to a question it had no way to look up.
    //
    // Adding a find_bookings tool did not fix that and could not have. The
    // tool worked when called directly; nothing called it.
    '4. LOOKING THINGS UP. The DATA below is a SUMMARY, not everything there is.'
        + ' When the answer needs something it does not contain — a specific booking,'
        + ' container, port, cutoff, a load by seller, a bill — ASK FOR IT with the'
        + ' `tool` field instead of saying you do not know:',
    '   {"tool": {"name": "find_bookings", "params": {"port": "houston"}}, "answer": "", "have_data": false}',
    '   You will be given the result and asked again. Use it. Only say something'
        + ' is not in the records after you have looked with the right tool and it'
        + ' came back empty.',
    '5. WHAT YOU CAN DO:',
    require('./tools').describeTools(),
    '   To act, put it in the `action` field: {"kind":"record_payment","params":{...}}. Do NOT claim you have done it — you are PROPOSING, and the person confirms it. Word `answer` as what WILL happen: "Record $12,000 by Zelle against EDGE_07?" Never "I have recorded".',
    '   Only ever propose an action when you are actually asked to DO something. A question is a question — answer it, leave `action` out.',
    '   Use a load id that is really in the DATA. If you cannot tell which load is meant, ask which one instead of guessing.',
    '   A SHORT FOLLOW-UP is not a command. "How", "Why", "How so", "Show me", "Break it down", "Which ones" mean: explain the answer you just gave. Show the rows behind the figure. Never answer one of these by saying you cannot perform actions — that is a misreading, and it looks broken.',
    '5. Be brief. One or two sentences for a simple question. Use a short list only when the answer really is a list.',
    '   Brevity does not apply when asked to explain or break something down — then show the individual loads or payments that make up the figure, even if that takes several lines.',
    '6. Never invent a seller, load id, date or amount. If someone asks about a name you cannot see in the data, say it is not in the records you have.',
].join('\n');

// Trimmed so an unusual question cannot walk the model into a long essay, and
// so a runaway response cannot cost much.
const MAX_QUESTION_CHARS = 500;

// Plainly about a figure. Deliberately conservative — a question that is not
// obviously arithmetic keeps the old path.
const FIGURE_QUESTION = /\b(how much|how many|total|totals|sum|average|avg|owe|owed|owing|outstanding|balance|spent|spend|spending|paid|pay|revenue|profit|margin|most|least|highest|lowest|per (lb|pound|ton|load)|this (month|week|year|quarter)|last (month|week|year|quarter)|in (january|february|march|april|may|june|july|august|september|october|november|december)|since|between)\b/i;

// ── EVERY ANSWER IS LOGGED, AT THE FUNCTION RATHER THAN THE ROUTE ────────
// Apsara, 2026-09-26: Jarvis "is dumb most of the times".
//
// There was no way to check. THREE routes call askYard — api.js 2167 (the
// chat box), 2541 and 3571 (the voice paths) — and not one of them recorded
// whether it answered. The only thing in data/ask_log.json was the LEDGER
// FALLBACK inside this file, which is the last resort and fires on a handful
// of questions. So the log showed 22 entries, all failures, and I read that
// as her experience. It was the test suite.
//
// Wrapping the function instead of the three callers is the point: a fourth
// route cannot be added without logging, and none of the eight return
// statements below has to remember anything.
async function askYard(question, opts = {}) {
    const started = Date.now();
    let out;
    try {
        out = await askYardInner(question, opts);
        return out;
    } finally {
        // ── NEVER BLOCKS THE ANSWER ──────────────────────────────────────
        // No await: record() writes a file, and a question should not wait on
        // a log. record() already swallows its own errors, and the catch here
        // is the belt to that braces — a logging failure must never be what
        // turns a working answer into an error.
        try {
            // The ledger fallback records its own, more detailed row. Marked
            // so the report can collapse the pair rather than count the
            // question twice and halve the apparent success rate.
            const viaLedger = !!(out && out.from === 'ledger');
            require('./data/askLog').record({
                kind: 'data', source: 'scout-ask', question,
                outcome: !out ? 'failed'
                    : (!out.ok ? 'could_not_answer'
                        : (out.have_data === false ? 'nothing_matched' : 'answered')),
                proposed: !!(out && out.proposal),
                via_ledger: viaLedger,
                ms: Date.now() - started,
            });
        } catch (e) { /* a log is never worth an answer */ }
    }
}

async function askYardInner(question, opts = {}) {
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

    // ── THE LOOKUP LOOP ──────────────────────────────────────────────────
    // Bounded at three rounds. Each one is a round trip to Gemini plus a
    // local query, so the ceiling is what keeps a confused model from
    // turning one question into a minute of tool calls and a bill. Three is
    // enough for the realistic chains here — find the booking, then the
    // loads against it, then answer — and a model that has not got there by
    // the third round is not going to.
    const MAX_LOOKUPS = 3;
    const found = [];        // what the tools returned, fed back each round

    function buildPrompt() {
        return [
            SYSTEM_RULES,
            '',
            'DATA (a summary — ask for anything else with `tool`):',
            JSON.stringify(brief),
            found.length
                ? '\nWHAT YOU LOOKED UP:\n' + found.map((f) => (
                    `${f.name}(${JSON.stringify(f.params)}) -> ${JSON.stringify(f.result).slice(0, 4000)}`
                )).join('\n')
                : '',
            // ── HISTORY SITS NEXT TO THE QUESTION, NOT IN THE MIDDLE ─────
            // Moved 2026-09-06. Liu et al. (TACL 2024), "Lost in the
            // Middle": across every model they tested, a fact placed at the
            // start or the end of the context is used reliably and one in
            // the middle is not — accuracy on a mid-context fact can fall
            // below what the same model achieves with NO context at all.
            //
            // The conversation was sitting after a large DATA blob and a
            // tool-result dump, which is the middle. It is what "what is the
            // ERD" depends on entirely, so it now sits directly against the
            // question it modifies. A one-line move with real evidence
            // behind it.
            historyText,
            '',
            `QUESTION: ${asked}`,
            '',
            'Reply as JSON: {"answer": "...", "have_data": true|false, '
            + '"tool": null | {"name": "...", "params": {...}}, '
            + '"action": null | {"kind": "...", "params": {...}}}. '
            + 'Plain sentences in `answer`, no markdown. '
            + 'Use `tool` to LOOK SOMETHING UP — leave `answer` empty when you do. '
            + 'Set have_data to false only after looking and finding nothing. '
            + 'Leave `action` null unless you were asked to do something.',
        ].join('\n');
    }

    let prompt = buildPrompt();

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
        let res = await callGeminiJSON(prompt, 1);

        // ── run whatever it asked to look up, then ask again ─────────────
        for (let round = 0; round < MAX_LOOKUPS; round += 1) {
            const want = res && res.tool;
            if (!want || typeof want !== 'object' || !want.name) break;

            const name = String(want.name);
            const params = (want.params && typeof want.params === 'object') ? want.params : {};
            let result;
            try {
                const { runRead } = require('./tools');
                result = await runRead(name, params, { role: opts.role });
            } catch (e) {
                // The failure is handed BACK to the model rather than thrown.
                // "there is no tool called find_container" is something it can
                // recover from by picking the right one; an exception here
                // would turn a recoverable mistake into a 500.
                result = { error: e.message };
            }
            console.log(`[YARD-ASK] looked up ${name}(${JSON.stringify(params)})`);
            found.push({ name, params, result });

            prompt = buildPrompt();
            res = await callGeminiJSON(prompt, 1);
        }

        const text = String((res && res.answer) || '').trim();

        // ── THE LEDGER, WHEN THE BRIEF COULD NOT (2026-09-23) ────────────
        // The brief above is a THIRTY DAY window. Outside it there is nothing
        // to read, so "what did we pay Junk Car in March" came back as "I
        // don't have that" — or, worse, was worked out from the little that
        // was in front of it. The yard mirror holds every load, sale, trucker
        // bill, expense and petty-cash row there has ever been, and SQLite
        // does the arithmetic (helpers/data/askData.js has the argument).
        //
        // DELIBERATELY SECOND, not first. Asking the ledger first would add a
        // model call to every question the brief already answers — a real cost
        // on her bill and a real delay on voice, and tests/yard-ask-tools.js
        // holds the one-call-per-plain-question property. So it runs only when
        // the old path has come back empty-handed, and only for a question
        // plainly about a figure.
        const briefFailed = !text || (res && res.have_data === false);
        if (briefFailed && opts.ledger !== false && FIGURE_QUESTION.test(q)) {
            try {
                const out = await require('./data/askData').ask(q, { book: 'yard' });
                try {
                    await require('./data/askLog').record({
                        kind: 'data', question: q, source: 'scout',
                        outcome: !out.ok ? (out.scope === 'metals' ? 'metals' : 'could_not_answer')
                            : (out.empty ? 'nothing_matched' : 'answered'),
                        tables: out.tables || [], sql: out.sql || null,
                        rows: (out.rows || []).length, repaired: !!out.repaired,
                    });
                } catch (e) { /* logging never breaks answering */ }
                if (out.ok && !out.empty) {
                    return { ok: true, have_data: true, from: 'ledger',
                        answer: out.screen || out.spoken, spoken: out.spoken, sql: out.sql };
                }
                if (!out.ok && out.scope === 'metals') {
                    return { ok: true, have_data: false, from: 'ledger', answer: out.spoken, spoken: out.spoken };
                }
            } catch (e) {
                console.warn('[YARDASK] the ledger could not answer either:', e.message);
            }
        }
        if (!text) {
            // Distinguished from a plain empty answer: if it was still asking
            // for tools when the budget ran out, saying "try rephrasing" would
            // be misleading — it was working, just not fast enough.
            if (res && res.tool) {
                console.warn('[YARD-ASK] still looking things up after ' + MAX_LOOKUPS + ' rounds');
                return { ok: false, answer: "I looked in a few places and couldn't pin that down. Can you narrow it a little?" };
            }
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
