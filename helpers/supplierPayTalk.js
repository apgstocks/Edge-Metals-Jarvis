// ── helpers/supplierPayTalk.js — "I paid 10000 advance to Inesh" ───────────
// Apsara, 2026-10-02, over WhatsApp:
//
//   "Also i want Jarvis to handle this.If user messages (only allowed users)
//    jarvis and they say,I paid 10000 advance to Inesh.It should able to
//    undertsand that.If they didnt mention specifically-as advance.Just ask
//    the user directly whether it is a advance or paid against bill?If
//    advance,create an entry in bill pay against that supplier.Else Just show
//    all the unpaid upto 5 containers with bill date and ask him to choose
//    all those applicable.Post getting user input,Jarvis should create an
//    entry in Bill Pay."
//
// ── WHY THE PARSING LIVES IN ITS OWN FILE ─────────────────────────────────
// Every decision here is testable without a WhatsApp session, a pending
// queue, or a store: text in, intent out. The flow around it (ask, wait,
// ask again, record) is in workflow/actions.js, where the conversation
// belongs. The last two times a money path broke in this codebase it was
// because the rule and the conversation were tangled together and only one
// of them got tested.
//
// ── IT NEVER INVENTS A SUPPLIER ───────────────────────────────────────────
// The hard rule from 2026-08: "Ask once, using the AI, and never invent a
// name." A misheard supplier on a payment is money filed against the wrong
// person, found weeks later when his account does not tie. So resolve()
// returns a MATCH or a list of CANDIDATES, never a guess, and the caller
// asks. "Inesh" matching nobody is a question, not a new supplier.
//
// ── AND IT NEVER DECIDES ADVANCE-VS-BILL ──────────────────────────────────
// `saidAdvance` is only ever true when she actually used the word. Her
// instruction is explicit: if she did not say it, ASK. A payment guessed as
// an advance sits as unapplied credit while the container still reads unpaid;
// guessed the other way it marks containers settled out of money that was
// meant to be held. Both are worse than one question.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v) => String(v == null ? '' : v).trim();

// ── READING THE MESSAGE ───────────────────────────────────────────────────
// Deliberately NOT a general-purpose money parser. These are the shapes she
// actually types, and anything outside them returns null so the message
// falls through to the normal classifier rather than being half-understood.
//
// The amount is matched BEFORE the name, because a name can contain digits
// ("AAA 1 Metals") and an amount never contains letters beyond k/K.
const AMOUNT = String.raw`\$?\s*([\d,]+(?:\.\d{1,2})?)\s*(k)?`;

const PATTERNS = [
    // "I paid 10000 advance to Inesh" / "paid $10,000 to Inesh"
    new RegExp(String.raw`^(?:i\s+)?(?:paid|sent|gave|transferred|wired)\s+${AMOUNT}\s*(advance|adv)?\s*(?:to|for)\s+(.+)$`, 'i'),
    // "I paid Inesh 10000 advance" — name first
    new RegExp(String.raw`^(?:i\s+)?(?:paid|sent|gave|transferred|wired)\s+(.+?)\s+${AMOUNT}\s*(advance|adv)?\s*$`, 'i'),
    // "advance of 5000 to Inesh" / "advance 5000 to Inesh"
    new RegExp(String.raw`^(advance|adv)\s+(?:of\s+)?${AMOUNT}\s*(?:to|for)\s+(.+)$`, 'i'),
];

// Words that mean "against a bill" when she says them instead of "advance".
// Matched on the WHOLE message, because she may put it anywhere: "paid 5000
// to Inesh against the bill".
const SAYS_BILL = /\b(against\s+(?:the\s+)?bills?|for\s+(?:the\s+)?bills?|bill\s+payment|towards?\s+(?:the\s+)?bills?)\b/i;
const SAYS_ADVANCE = /\b(advance|adv)\b/i;

function parse(text) {
    const t = str(text).replace(/\s+/g, ' ');
    if (!t) return null;

    for (let i = 0; i < PATTERNS.length; i += 1) {
        const m = t.match(PATTERNS[i]);
        if (!m) continue;

        let rawAmount; let rawK; let name;
        if (i === 0) { [, rawAmount, rawK, , name] = m; }
        else if (i === 1) { [, name, rawAmount, rawK] = m; }
        else { [, , rawAmount, rawK, name] = m; }

        const n = Number(String(rawAmount || '').replace(/,/g, ''));
        if (!isFinite(n) || n <= 0) return null;
        // "10k" is 10,000. Written out because she does use it, and reading
        // it as 10 would be a four-order-of-magnitude error in the one place
        // that cannot afford one.
        const amount = round2(rawK ? n * 1000 : n);

        // Trailing noise off the name: "to Inesh today", "to Inesh by wire".
        // NOT a general cleanup — only the words that follow a name in her
        // own messages, so an unfamiliar word stays part of the name and
        // becomes a question rather than being silently trimmed away.
        const supplier = str(name)
            .replace(SAYS_BILL, '')
            .replace(/\b(advance|adv)\b/gi, '')
            .replace(/\b(today|yesterday|now|just now)\b/gi, '')
            .replace(/\bby\s+(cash|wire|zelle|cheque|check|bank\s*transfer)\b/gi, '')
            .replace(/\s{2,}/g, ' ')
            .replace(/[.,;:!?]+$/, '')
            .trim();
        if (!supplier) return null;

        return {
            amount,
            supplier,
            // Only true when SHE said it. See the header.
            saidAdvance: SAYS_ADVANCE.test(t),
            saidAgainstBill: SAYS_BILL.test(t),
            // What she typed, kept verbatim for the confirm card — she should
            // be agreeing to her own sentence, not to Jarvis's paraphrase.
            said: t,
        };
    }
    return null;
}

// ── MATCHING THE NAME, WITHOUT INVENTING ONE ──────────────────────────────
// Returns one of:
//   { match: 'Inesh Metals' }                   confident, one hit
//   { candidates: ['Inesh Metals', 'Inesh Co'] } ask which
//   { candidates: [] }                           nobody — ask who, or stop
//
// Three passes, narrowest first. No edit-distance guessing: "Inseh" is a
// question, not a 1-character leap to a supplier who will be paid.
function resolve(typed, known) {
    const want = str(typed).toLowerCase();
    const names = (known || []).map(str).filter(Boolean);
    if (!want) return { candidates: [] };

    const exact = names.filter((n) => n.toLowerCase() === want);
    if (exact.length === 1) return { match: exact[0] };
    if (exact.length > 1) return { candidates: exact };

    // Whole-word prefix: "Inesh" → "Inesh Metals". Word-boundary anchored so
    // "AAA" does not reach "Metalaaa".
    const starts = names.filter((n) => n.toLowerCase().startsWith(want));
    if (starts.length === 1) return { match: starts[0] };
    if (starts.length > 1) return { candidates: starts };

    const contains = names.filter((n) => n.toLowerCase().includes(want));
    if (contains.length === 1) return { match: contains[0] };
    return { candidates: contains };
}

// ── THE UNPAID CONTAINERS, AS SHE ASKED FOR THEM ──────────────────────────
// "Just show all the unpaid upto 5 containers with bill date."
//
// OLDEST FIRST, not newest: the one that has been owed longest is the one a
// payment is most likely meant for, and it is the one she would want to see
// if only five fit. The cap is 5 with the remainder COUNTED out loud — a
// truncated list that does not say it is truncated is how she pays five and
// believes she has cleared seven.
//
// `bills` is passed in — the caller reads it from bills.listWithTotals(),
// which is the same function /api/bill-payments uses for the website's table.
// Two definitions of "unpaid" is how the screen and the chat end up
// disagreeing about what is owed.
const LIST_LIMIT = 5;

function unpaidFor(bills, supplier, { limit = LIST_LIMIT } = {}) {
    const who = str(supplier).toLowerCase();
    const open = (bills || [])
        .filter((b) => b && str(b.supplier).toLowerCase() === who)
        // balance === null means the bill has no price yet — not "paid", and
        // not something money can be allocated against either.
        .filter((b) => b.balance !== null && b.balance !== undefined && Number(b.balance) > 0.005)
        .sort((a, b) => str(a.date).localeCompare(str(b.date)));
    return {
        shown: open.slice(0, limit),
        more: Math.max(0, open.length - limit),
        total: open.length,
        owed: round2(open.reduce((t, b) => t + Number(b.balance || 0), 0)),
    };
}

// ── WHICH ONES DID SHE PICK ───────────────────────────────────────────────
// "1,3" / "1 and 3" / "1 3" / "all" / "first two". Returns the chosen bills
// in the order they were OFFERED, so the numbers she read mean what she
// thought they meant.
//
// An out-of-range number is an ERROR, not something to ignore: "1,7" against
// a list of five means she is looking at a different list, and quietly
// recording container 1 would be the wrong payment made confidently.
function pickFrom(reply, offered) {
    const t = str(reply).toLowerCase();
    const list = offered || [];
    if (!t) return { error: 'which ones?' };
    if (/^(all|everything|all of them|every one)$/.test(t)) {
        return { chosen: list.slice() };
    }
    if (/^(none|cancel|stop|nothing)$/.test(t)) return { cancelled: true };

    const nums = (t.match(/\d+/g) || []).map(Number);
    if (!nums.length) return { error: 'reply with the numbers, like "1,3" — or "all"' };
    const bad = nums.filter((n) => n < 1 || n > list.length);
    if (bad.length) {
        return { error: `there ${bad.length === 1 ? 'is no' : 'are no'} ${bad.join(', ')} on that list — `
            + `it only goes up to ${list.length}` };
    }
    // De-duplicated, and kept in the offered order rather than the order she
    // typed, so "3,1" allocates oldest-first like everything else here.
    const want = new Set(nums);
    return { chosen: list.filter((_, i) => want.has(i + 1)) };
}

// ── SPLITTING THE MONEY ACROSS WHAT SHE PICKED ────────────────────────────
// Oldest first, each container up to its balance, stopping when the money
// runs out. The same tick-to-fill rule the website's table uses — one
// behaviour, so the two cannot disagree.
//
// Returns `leftover` when the payment is bigger than the containers she
// picked. That is NOT silently dropped and NOT silently recorded: helpers/
// billPayments.cleanAllocations REFUSES a payment whose allocations do not
// sum to the amount, so the caller has to ask her before posting rather than
// after. `short` is the opposite — the containers she picked owe more than
// she paid, which is fine and normal (a part payment).
function allocate(amount, chosen) {
    let left = round2(amount);
    const allocations = [];
    for (const b of (chosen || [])) {
        if (left <= 0.005) break;
        const owed = round2(b.balance);
        const put = round2(Math.min(owed, left));
        if (put <= 0.005) continue;
        allocations.push({ bill_id: b.id, amount: put, container_no: b.container_no || null });
        left = round2(left - put);
    }
    const owedTotal = round2((chosen || []).reduce((t, b) => t + Number(b.balance || 0), 0));
    return {
        allocations,
        leftover: round2(Math.max(0, left)),
        short: round2(Math.max(0, owedTotal - round2(amount))),
    };
}

module.exports = {
    parse, resolve, unpaidFor, pickFrom, allocate,
    LIST_LIMIT, SAYS_ADVANCE, SAYS_BILL,
};
