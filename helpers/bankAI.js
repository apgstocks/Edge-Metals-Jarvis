// ── helpers/bankAI.js — the answer when pattern matching has none ────────
// Apsara, 2026-11-05, after being shown "could be Edge Metals Recycling or
// A.LEE METAL TRADING — too close to call":
//
//   "How can it assume its edge recycling?"   -> fixed in bankPayee/bankLearn
//   "still bad"
//   "dont just use pattern matching,if its unable to answer,let jarvis ai
//    answers"
//
// Everything before this file is string work: helpers/bankPayee.js finds the
// characters that are a name, helpers/partyName.js decides whether that name
// IS a ledger name, and helpers/nameMatch.js refuses anything short of exact.
// That chain is right and stays first. What it cannot do is READ:
//
//   PMT INFO:Balance payment for Inv 261009_AP_26ARIS 03 on our PO 2026-641
//
// A human reads "26ARIS" and knows. No containment rule gets there, so the
// line went to her as a question, which is the "sitting idle" she objected
// to. This file is what happens after the strings run out.
//
// ══════════════════════════════════════════════════════════════════════════
//  THE RULE THIS FILE DOES NOT BREAK
// ══════════════════════════════════════════════════════════════════════════
// helpers/nameMatch.js refuses near-misses, and the comment there says why:
// "a near-miss resolves to the wrong company, and here that would allocate
// real money to the wrong customer's invoice." A language model is a
// near-miss machine. So two hard limits, both enforced HERE and not in the
// prompt — a prompt is a request, and this has to be a guarantee:
//
//   1. THE MODEL CANNOT NAME A COMPANY. It picks an index out of the ledger
//      list it was given, or it declines. A name it invents, or one it
//      spells differently, is dropped on the floor. It cannot type
//      "A.LEE METAL TRADNG" into her books because it never types a name.
//
//   2. THE MODEL CANNOT MATCH ANYTHING. What comes back is a SUGGESTION
//      with its reason, labelled ai:true, that she confirms with one click.
//      Nothing here writes, aliases, allocates or ticks. The confirm goes
//      through the same route her own click has always gone through.
//
// So the worst case is a suggestion she rejects. That is strictly better than
// the current worst case, which is a question with no help attached.
//
// ── WHY NOT ASK THE MODEL FIRST, WHICH WOULD BE SIMPLER ──────────────────
// Because the deterministic path is auditable and free and she has already
// trained it with aliases. 'ARIS ENTERPRISES' resolving to Aris Enterprises
// must not depend on a network call, a quota, or today's model weights. The
// AI runs ONLY where the chain came back with nothing or with a tie.
const { normalizeName } = require('./nameMatch');

const MAX_LINES = 25;      // one prompt, not one per row
const MAX_CANDIDATES = 120; // her ledger, capped so the prompt stays sane

const basisOf = (why) => 'Jarvis AI read the bank line' + (why ? ` — ${why}` : '');

// ── THE PROMPT ───────────────────────────────────────────────────────────
// It is given the NUMBERED ledger and asked for numbers. "pick" is the only
// verb available to it.
function buildPrompt(lines, candidates) {
    const list = candidates.map((c, i) => `${i}. ${c}`).join('\n');
    const rows = lines.map((l, i) => {
        const amt = (l.amount == null || !isFinite(Number(l.amount)))
            ? '' : ` [amount ${Number(l.amount).toFixed(2)}]`;
        return `${i}. ${String(l.descriptor || '').slice(0, 400)}${amt}`;
    }).join('\n');

    return `You read US bank statement descriptions for a metal recycling and export business (Edge Metals). For each bank line below, decide WHICH of the numbered companies sent or received that money.

THE COMPANIES (this is the complete list — you may not name any other):
${list}

THE BANK LINES:
${rows}

HOW THESE LINES ARE BUILT:
- "DES:", "CO ID:", "PMT ID:", "TRN:", "ORIG ID:", "TRACE#:" and similar are the bank's own machine fields. They are never a company name.
- "INDN:" on an incoming payment is the RECEIVER, which is Edge Metals itself. It is never the payer. Never pick a company because it appears after INDN:.
- "PMT INFO:", "MEMO:", "OBI:", "REF:" and "DESC:" carry what a person typed: invoice numbers, PO numbers, container numbers. Invoice numbers often embed an abbreviation of the company — for example "Inv 261009_AP_26ARIS 03" points to ARIS ENTERPRISES, and "26ME07" points to Modern Enterprises. This is usually the strongest clue on a line the machine fields obscured.
- Banks truncate. "ALEE METAL TRADI" is "A.LEE METAL TRADING". "TAEWON METALS CO L" is "TAEWON METALS CO LTD".

RULES YOU MUST FOLLOW:
- Answer with the company's NUMBER from the list above. Never write a company name.
- Pick nothing (use null) unless you have a reason you could point at in the text. A wrong pick allocates real money to the wrong customer's invoice.
- Pick nothing for bank fees, interest, ATM activity, card payments, taxes, loan payments and transfers between the business's own accounts.
- Two companies could genuinely fit: pick nothing and say so in the reason.
- Never pick Edge Metals, Edge Yard, Edge Scrap, AAA Investment or any other Edge entity — those are the business itself, not a counterparty.

Return ONLY raw JSON, no markdown:
{"answers":[{"line":0,"company":3,"confidence":"high","reason":"invoice number 26ARIS in PMT INFO names this company"},{"line":1,"company":null,"confidence":"low","reason":"only a trace number, no company anywhere on the line"}]}

confidence is "high", "medium" or "low". reason is one short sentence quoting what in the line made you decide, written for the business owner to check in two seconds.`;
}

// ── identifyParties(lines, candidates, opts) ──────────────────────────────
// lines:      [{ id, descriptor, amount }]
// candidates: the ledger names the answer must come from
// returns:    Map id -> { customer, basis, confidence, reason, ai: true }
//
// callGemini is INJECTED, like resolveParty is injected into bankMatch, so
// this file can be tested without a network and so the matching path never
// hard-depends on the model being reachable.
async function identifyParties(lines, candidates, opts = {}) {
    const out = new Map();
    const rows = (lines || []).filter((l) => l && String(l.descriptor || '').trim()).slice(0, MAX_LINES);
    const names = [...new Set((candidates || []).map((c) => String(c || '').trim()).filter(Boolean))]
        .slice(0, MAX_CANDIDATES);
    if (!rows.length || !names.length) return out;

    // ── EDGE'S OWN COMPANIES NEVER GO IN THE LIST ────────────────────────
    // The prompt says not to pick them, and a prompt is a request. They are
    // simply not offered, so there is no index for the model to return.
    // This is the same bug she caught by eye: her own company was a
    // candidate because INDN: was in the haystack.
    const ownRe = opts.ownRe instanceof RegExp ? opts.ownRe : /\b(edge|aaa investment)\b/i;
    const offered = names.filter((n) => !ownRe.test(n));
    if (!offered.length) return out;

    const call = typeof opts.callGemini === 'function' ? opts.callGemini : null;
    if (!call) return out;

    let res = null;
    try {
        res = await call(buildPrompt(rows, offered));
    } catch (e) {
        // A model that is down, out of quota or slow must cost her nothing
        // but the help it would have given. The row stays a question.
        return out;
    }

    const answers = (res && Array.isArray(res.answers)) ? res.answers : null;
    if (!answers) return out;

    // Known names, normalised, so a returned INDEX can be turned back into
    // the ledger's own spelling and nothing else.
    const byNorm = new Map(offered.map((n) => [normalizeName(n), n]));

    for (const a of answers) {
        if (!a || typeof a !== 'object') continue;
        const li = Number(a.line);
        if (!Number.isInteger(li) || li < 0 || li >= rows.length) continue;
        const row = rows[li];
        if (out.has(row.id)) continue;   // first answer for a line wins

        // ── THE GUARD. A NUMBER, OR NOTHING ──────────────────────────────
        // company must be an index into the list the model was handed. A
        // string, a float, an out-of-range number, or a name it decided to
        // type anyway is discarded — there is no path from the model's
        // output to a company this ledger does not already contain.
        let picked = null;
        if (Number.isInteger(a.company) && a.company >= 0 && a.company < offered.length) {
            picked = offered[a.company];
        } else if (typeof a.company === 'string') {
            // Models return the name sometimes whatever the instruction. It
            // is accepted ONLY if it normalises onto a name already in the
            // list — the same exactness nameMatch.js requires — never as a
            // near miss.
            picked = byNorm.get(normalizeName(a.company)) || null;
        }
        if (!picked) continue;
        if (ownRe.test(picked)) continue;   // belt and braces

        const conf = ['high', 'medium', 'low'].includes(String(a.confidence || '').toLowerCase())
            ? String(a.confidence).toLowerCase() : 'low';
        const reason = String(a.reason || '').replace(/\s+/g, ' ').trim().slice(0, 200);

        out.set(row.id, {
            customer: picked,
            basis: basisOf(reason),
            reason,
            confidence: conf,
            // The screen and the bot both key off this to label the row as
            // the AI's reading rather than a found name, and to keep the
            // confirm button saying "confirm", not "matched".
            ai: true,
        });
    }
    return out;
}

// The default caller: her own Gemini helper, on the smart model, because
// being wrong here costs money — the same reasoning config.GEMINI_MODEL_SMART
// was introduced for ("Use the best model in google for QB and Claims").
function geminiCaller() {
    const gemini = require('./gemini');
    const cfg = (() => { try { return require('../config'); } catch (e) { return {}; } })();
    return (prompt) => gemini.callGeminiJSON(prompt, 1, null,
        cfg.GEMINI_MODEL_SMART ? { model: cfg.GEMINI_MODEL_SMART } : {});
}

module.exports = { identifyParties, buildPrompt, geminiCaller, MAX_LINES };
