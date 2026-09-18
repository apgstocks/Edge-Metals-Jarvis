// ── helpers/digestVerify.js — Jarvis reads its own message before sending ───
//
// Apsara asked for "loop engineering". This is the loop that pays for itself
// here: a verification pass between deciding and sending.
//
// WHY, AND THE EVIDENCE IS THE LAST THREE WEEKS OF HER OWN MESSAGES. Every
// single one of these reached her phone, and every one was found by HER
// reading it, not by a test:
//
//   "tomorrow tomorrow — confirmation of calculations"
//   "TOMORROW (after tomorrow morning) — release timing for shipment"
//   "Apsara: Ignore 1  /  Jarv: I don't have a #undefined from a recent digest"
//   "1. . Rajkumar sends a draft BoL for your review / Review and approve
//         (you are only copied in)"                     <- contradicts itself
//   "!! ... — by 9/17 (today)"  off an estimated ready date
//   a deadline of "September 17" parsed as the year 2001 -> OVERDUE by 9131d
//
// Not one of them needed a model to spot. Each is a property of the RENDERED
// TEXT that arithmetic can check: a word repeated, a literal "undefined", a
// number no real deadline can hold, two clauses that cannot both be true.
//
// THE DESIGN DECISION THAT MATTERS: what to do when a check trips.
//
// Not "don't send". Silence is the failure this whole month has been about —
// 24 purchase orders and 22 consequential emails vanished quietly and she
// only found out by noticing an absence. A verifier that answers a bad line
// with no message at all would be the same mistake with a safety badge on.
//
// So: DROP THE OFFENDING ITEM AND RE-RENDER. She still gets everything else,
// the numbering stays contiguous so "ignore 2" cannot drift, and the
// suppression is logged by name with the line that caused it. If a
// MESSAGE-level check still fails after that, the text is returned anyway
// with `ok: false` and the caller decides — reporting a flawed digest beats
// swallowing a real one.
//
// Re-rendering rather than editing the string is deliberate: "reply to N"
// resolves against the ITEM ARRAY, so a line deleted from the text would
// leave the numbers pointing at the wrong mail. That is the exact bug class
// this file exists to catch, and it would be embarrassing to introduce it
// here.

// A word that stops being true tomorrow. Allowed in the COMPUTED suffix the
// digest adds ("(today)", "(tomorrow)") and never inside a summary, which is
// stored and re-rendered for days.
const RELATIVE_WORD = /\b(today|tomorrow|tonight|yesterday|this morning|this afternoon|next week)\b/i;

// No real deadline in freight is a year away in either direction. A number
// bigger than this is a parse failure wearing a date's clothes — the
// "OVERDUE by 9131d" case, which was V8 reading "september 17" as the year
// 2001.
const ABSURD_DAYS = 365;

// Template and null leakage. Each of these has actually printed.
const LEAKED = [
    ['undefined', /\bundefined\b/],
    ['null',      /(^|[\s(#:])null([\s).,]|$)/],
    ['NaN',       /\bNaN\b/],
    ['[object',   /\[object \w+\]/],
    ['unexpanded template', /\$\{/],
];

// ── ITEM-LEVEL CHECKS ──────────────────────────────────────────────────────
// Each takes the item and the lines rendered for it, and returns a reason
// string when it fails. Dropping the item fixes an item-level failure.
const ITEM_CHECKS = [
    {
        name: 'relative-date-in-summary',
        // "tomorrow tomorrow — confirmation of calculations". A summary is
        // stored when the mail arrives and re-rendered for days afterwards,
        // so a relative word in it is a lie on a timer. resolveRelativeDates
        // exists to prevent this; the check is what proves it ran.
        test: (item) => {
            const m = RELATIVE_WORD.exec(String(item.summary || ''));
            return m ? `summary says "${m[1]}", which means a different day each time it is re-rendered` : null;
        },
    },
    {
        name: 'deadline-word-doubled',
        // "TOMORROW (after tomorrow morning)". The label is computed and the
        // parenthetical is the sender's words; when both say tomorrow, one
        // of them is wrong and she has to work out which.
        test: (item, lines) => {
            const text = lines.join(' ');
            for (const w of ['today', 'tomorrow', 'tonight', 'yesterday']) {
                const n = (text.match(new RegExp(`\\b${w}\\b`, 'gi')) || []).length;
                if (n > 1) return `"${w}" appears ${n} times in one item — the computed label and the sender's own words are both saying it`;
            }
            return null;
        },
    },
    {
        name: 'absurd-deadline',
        test: (item) => (typeof item.daysToDeadline === 'number' && Math.abs(item.daysToDeadline) > ABSURD_DAYS)
            ? `deadline is ${item.daysToDeadline} days away — that is a date-parsing failure, not a deadline`
            : null,
    },
    {
        name: 'contradicts-itself',
        // "for your review / Review and approve / (you are only copied in)".
        // Either it is hers or it is somebody else's; the line said both.
        test: (item, lines) => {
            const text = lines.join(' ').toLowerCase();
            const mine = /\bwants:|needs you|for your (review|approval)|→ /.test(text);
            const notMine = /you are only copied in|your team, not you/.test(text);
            return (mine && notMine)
                ? 'the item asks her to act AND says it is not hers'
                : null;
        },
    },
    {
        name: 'nothing-to-say',
        test: (item) => {
            const s = String(item.summary || item.subject || '').trim();
            return s.length < 3 ? 'no summary and no subject — the line would be blank' : null;
        },
    },
];

// ── MESSAGE-LEVEL CHECKS ───────────────────────────────────────────────────
// Dropping an item cannot fix these, so they are reported, not repaired.
const MESSAGE_CHECKS = [
    {
        name: 'leaked-value',
        test: (text) => {
            for (const [label, re] of LEAKED) {
                if (re.test(text)) return `the message contains a literal "${label}"`;
            }
            return null;
        },
    },
    {
        name: 'numbering-broken',
        // "ignore 1" answered "I don't have a #undefined from a recent
        // digest". Every numbered line must be 1..N with no gaps, because
        // that number is the only handle she has on an item.
        test: (text) => {
            const nums = [...text.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
            if (!nums.length) return null;                    // a list with no numbers is fine
            for (let i = 0; i < nums.length; i++) {
                if (nums[i] !== i + 1) return `numbered lines run ${nums.join(',')} — "reply to N" would resolve to the wrong mail`;
            }
            return null;
        },
    },
    {
        name: 'count-disagrees-with-list',
        // "3 emails waiting on you" over two items. The headline is the one
        // line she reads if she reads nothing else.
        test: (text) => {
            const listed = [...text.matchAll(/^(\d+)\. /gm)].length;
            if (!listed) return null;
            const m = /^(\d+)\s+(?:email|thing)/m.exec(text);
            if (!m) return null;
            const claimed = Number(m[1]);
            // The headline legitimately counts EMAILS while the list shows
            // MATTERS, and grouping makes the first bigger. Only the
            // impossible direction is a defect.
            return claimed < listed
                ? `the headline says ${claimed} but ${listed} items are listed`
                : null;
        },
    },
];

// items:  the array the digest was rendered from (order matters — it is the
//         numbering).
// render: (items) => string. Passed in rather than imported so this module
//         has no dependency on replyWatch, and so the same verifier can guard
//         the chase message and the deadline reminder.
function verifyDigest(items, render, { log = console } = {}) {
    const list = Array.isArray(items) ? items.slice() : [];
    const failures = [];
    const dropped = [];

    // One pass per dropped item. The bound is captured BEFORE the loop, and
    // that is not fussiness: `guard <= list.length` re-reads a length that
    // SHRINKS on every drop, so with three bad items the loop exited after
    // two and shipped the third. Caught by DI1 in tests/digest-verify.js --
    // a verifier with an off-by-one in its own loop is exactly the kind of
    // thing that makes a safety net worse than none.
    const maxPasses = list.length + 1;
    let text = render(list);
    for (let guard = 0; guard < maxPasses; guard++) {
        const lineage = itemLines(text, list.length);
        let offender = -1;
        for (let i = 0; i < list.length; i++) {
            for (const check of ITEM_CHECKS) {
                const why = check.test(list[i], lineage[i] || []);
                if (!why) continue;
                failures.push({ level: 'item', check: check.name, index: i, why,
                                line: (lineage[i] || [])[0] || null,
                                summary: String(list[i].summary || '').slice(0, 80) });
                offender = i;
                break;
            }
            if (offender >= 0) break;
        }
        if (offender < 0) break;
        dropped.push(list[offender]);
        list.splice(offender, 1);
        // RE-RENDERED, not string-edited. "reply to N" resolves against the
        // item array, so cutting a line out of the text would leave the
        // numbers pointing at different mail.
        text = render(list);
    }

    for (const check of MESSAGE_CHECKS) {
        const why = check.test(text);
        if (why) failures.push({ level: 'message', check: check.name, why });
    }

    // NAMED, ALWAYS. A filter that acts silently is one she cannot audit, and
    // the PO and importance gaps went unnoticed for weeks precisely because
    // nothing was written down when something was dropped.
    for (const f of failures) {
        log.warn(`[VERIFY] ${f.check}: ${f.why}`
            + (f.summary ? `  — "${f.summary}"` : ''));
    }
    if (dropped.length) {
        log.warn(`[VERIFY] held back ${dropped.length} item(s) from this digest; ${list.length} still going out`);
    }

    return {
        // `ok` means nothing survived unexplained. Item failures that were
        // repaired by dropping do NOT make it false — they were handled.
        ok: !failures.some((f) => f.level === 'message'),
        text, items: list, dropped, failures,
    };
}

// Splits the rendered message into the lines belonging to each numbered item.
// Anything before "1." is the headline and anything after the last item's
// block is the footer; neither is attributed to an item.
function itemLines(text, count) {
    const out = Array.from({ length: count }, () => []);
    let current = -1;
    for (const line of String(text || '').split('\n')) {
        const m = /^(\d+)\. /.exec(line);
        if (m) {
            const n = Number(m[1]);
            current = (n >= 1 && n <= count) ? n - 1 : -1;
        } else if (/^[A-Za-z(]/.test(line) && !/^\s/.test(line)) {
            current = -1;                    // a footer paragraph, not an item
        }
        if (current >= 0) out[current].push(line);
    }
    return out;
}

module.exports = { verifyDigest, itemLines, ITEM_CHECKS, MESSAGE_CHECKS, ABSURD_DAYS, RELATIVE_WORD };
