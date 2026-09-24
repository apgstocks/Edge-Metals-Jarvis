// ── helpers/data/followUps.js — what to ask her next ──────────────────────
//
// Apsara, 2026-09-24, shown "How much did we owe Fede? — The total amount owed
// to Fede is $11,426.50": "I told you that follow up questions need to be
// thrown for business. Check research papers on chat bots".
//
// ── WHAT THE RESEARCH SAYS, AND WHAT IT CHANGES HERE ───────────────────────
// Two findings from the work on follow-up generation are worth the code they
// cost, and one warning is worth heeding:
//
//   1. KNOWLEDGE-DRIVEN BEATS TEMPLATED. Xiao et al. (2023) on follow-ups in
//      conversational surveys: a model steered by what is actually KNOWN
//      produces more informative, coherent and clear questions than a GPT
//      baseline generating from the question alone. So these are built from
//      the ROWS AND COLUMNS the query returned, not from the words she typed.
//      "Which containers make that up?" is only offered when the answer
//      actually came from rows that have containers.
//
//   2. FOLLOW-UPS ARE FOR RESOLVING AND EXTENDING, not for filling silence.
//      The clarifying-agent literature uses them to remove ambiguity before
//      acting. So a question is offered only when the data can answer it —
//      never "would you like to know more?", which is a question that costs
//      her a decision and returns nothing.
//
//   3. AND THE WARNING, which is already written into this codebase: the note
//      on the old nextStep() said an offer that also opens a pending "would
//      make every answer a question she has to dismiss". That concern was
//      right. These are OFFERS — the screen draws them as chips she may tap.
//      Nothing is staged, nothing blocks, ignoring them costs nothing.
//
// ── SO: AT MOST THREE, ALWAYS ANSWERABLE ──────────────────────────────────
// Three is the ceiling because a list of six is a menu, and a menu is work.

const MAX = 3;

const has = (tables, t) => (tables || []).includes(t);
const col = (columns, c) => (columns || []).includes(c);
const firstOf = (rows, c) => {
    for (const r of (rows || [])) if (r && r[c] != null && String(r[c]).trim()) return String(r[c]).trim();
    return null;
};

// A supplier or customer named IN THE ANSWER, so the follow-up can name them
// back. Asking "which containers?" is weaker than "which containers is Fede
// waiting on?" — the second is answerable on its own, and she can say it out
// loud without the previous turn for context.
function party(rows, columns) {
    for (const c of ['supplier', 'customer', 'consignee', 'trucking_company', 'seller', 'buyer']) {
        if (col(columns, c)) {
            const v = firstOf(rows, c);
            if (v) return { field: c, name: v };
        }
    }
    return null;
}

// ── THE RULES ──────────────────────────────────────────────────────────────
// Each returns a question she could ASK NEXT and that this data can answer.
// Ordered by how often she actually follows up that way — money first, then
// the documents, then the wider view.
function followUps(question, { tables = [], rows = [], columns = [], shape } = {}) {
    const q = String(question || '').toLowerCase();
    const out = [];
    const add = (text) => { if (text && !out.includes(text) && out.length < MAX) out.push(text); };

    const p = party(rows, columns);
    const who = p ? p.name : null;
    const money = /owe|owed|balance|outstanding|payable|unpaid|due/.test(q);

    // ── MONEY: the breakdown, then the age, then the payments ─────────────
    // "How much do we owe Fede" answered with one figure is a number she can
    // read but not act on. The three things she does next with it are: see
    // which containers, see how old they are, and see what has been paid.
    if (money && has(tables, 'bills')) {
        // Only offered when the answer was a TOTAL. If she already has the
        // rows, "which containers" is a question she can see the answer to.
        if (shape === 'single' || rows.length <= 1) {
            add(who ? `Which containers make up what we owe ${who}?`
                    : 'Which containers make up that balance?');
        }
        add(who ? `What is the oldest unpaid bill for ${who}?`
                : 'What is the oldest unpaid bill?');
        add(who ? `What have we paid ${who} this month?` : 'What have we paid out this month?');
    }

    if (money && has(tables, 'sales')) {
        if (shape === 'single' || rows.length <= 1) {
            add(who ? `Which invoices is ${who} still to pay?` : 'Which invoices are still unpaid?');
        }
        add(who ? `What is the oldest unpaid invoice for ${who}?` : 'What is the oldest unpaid invoice?');
    }

    if (money && has(tables, 'trucking_bills')) {
        add(who ? `What else do we owe ${who} on trucking?` : 'How much trucking is unpaid?');
    }

    // ── A CONTAINER IN THE ANSWER: its paperwork and its margin ───────────
    // The two questions she asks about a container she has just seen named.
    const container = col(columns, 'container_no') ? firstOf(rows, 'container_no') : null;
    if (container) {
        add(`What documents do we have for ${container}?`);
        if (!has(tables, 'margin')) add(`What was the margin on ${container}?`);
    }

    // ── MARGIN AND SPEND: the comparison ──────────────────────────────────
    if (has(tables, 'margin') && /margin|profit/.test(q)) {
        add(who ? `How does ${who} compare with our other customers?` : 'Which containers lost money?');
    }
    if (/spend|spent|purchase|bought/.test(q) && has(tables, 'bills')) {
        add('Which supplier did we spend the most with?');
    }

    // ── AN EMPTY ANSWER IS A QUESTION ABOUT THE QUESTION ──────────────────
    // The clarifying case. Nothing came back, so the useful next move is to
    // widen it rather than to offer more of nothing.
    if (!rows.length) {
        out.length = 0;
        if (who) add(`Do we have anything at all under ${who}?`);
        add('Should I look over a wider date range?');
        return out;
    }

    return out;
}

module.exports = { followUps, MAX, party };
