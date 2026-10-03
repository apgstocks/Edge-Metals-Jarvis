// ── helpers/supplierPayAI.js — reading a payment she typed in a hurry ─────
// Apsara, 2026-10-03: "If there is spelling mistake and they say we paid 4000
// for Hugo. I want this to be read by model and comorehend the meaning. in
// case of doubt, ask user." And, in the same message: "when i sent this in
// whatsapp, its taking more than a minute to process it and show the next
// question. why?"
//
// Those two are the same problem, and this file is the answer to both.
//
// ── WHY IT WAS SLOW ───────────────────────────────────────────────────────
// A message that MATCHES the payment regex never touches a model — her live
// transcript shows those answered in 2 to 4 seconds. A message that MISSES it
// fell through to the general classifier, whose prompt carries every active
// booking, the port summary, every trucker and every supplier on file. Tens
// of thousands of tokens, to answer "is this a payment?". Then it was
// upgraded to the larger model, which made the slow path slower still.
//
// So the fix is not a faster model. It is a SMALLER QUESTION. This prompt is
// a few hundred tokens: one sentence, four fields, no business context at
// all. Small prompt, good model, fast answer.
//
// ── WHAT IT IS ALLOWED TO DECIDE ──────────────────────────────────────────
// It reads. It does not record, and it does not resolve a supplier — the name
// it returns is still matched against her real supplier list by
// supplierPayTalk.resolve, which offers candidates and never invents one. A
// model that mishears "Hugo" as "Hugh" must produce a question, not a payment
// against the wrong person.
//
// ── AND IT SAYS WHEN IT IS NOT SURE ───────────────────────────────────────
// Her words: "in case of doubt, ask user." So `confident` is part of the
// contract, not a nicety. Anything less than confident becomes a question
// with the reading offered, never a silent assumption. The regex path stays
// first and unchanged: deterministic where it can be, model only where it
// cannot.

const PROMPT = (text) => `A scrap-metal trader typed this message to her assistant. She may have
typos, missing words, or odd phrasing. Decide whether she is telling you about
MONEY SHE PAID OUT to a supplier.

Message: ${JSON.stringify(String(text || '').slice(0, 400))}

Reply with JSON only:
{
  "is_payment": true|false,
  "amount": number|null,
  "supplier": "the name as she wrote it"|null,
  "kind": "advance"|"bill"|null,
  "mode": "Zelle"|"Wire"|"Cash"|null,
  "confident": true|false
}

Rules:
- "is_payment" is true ONLY for money going OUT to a supplier. Money coming IN
  from a customer is NOT a payment here — set is_payment false.
- "supplier" is the name only. Strip how it was sent: "Hugo via Zelle" is
  "Hugo", "arturo via zelle" is "arturo".
- Correct obvious typos in ordinary words ("payed" -> paid). Do NOT correct the
  supplier's name — return it as she wrote it, even if it looks misspelled.
  Someone else checks it against the real supplier list.
- "kind" is "advance" only if she said advance, or "bill" if she said it is
  against a bill or invoice. If she did not say, use null. Never guess this.
- "mode" only if she named it. Otherwise null.
- "confident" is false if you are unsure of the amount or the supplier, or if
  the message could reasonably mean something else. When false, it becomes a
  question for her rather than an action.`;

const num = (v) => {
    const n = Number(String(v == null ? '' : v).replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};
const str = (v, max = 120) => String(v == null ? '' : v).trim().slice(0, max);

const MODES = ['Zelle', 'Wire', 'Cash'];

// `ask` is injected for the reason this codebase keeps relearning: a helper
// that reaches for a network client on require() cannot be tested at all, and
// a file that names its own model can be wrong about it inside a fail-soft
// catch and simply never work.
async function read(text, { ask } = {}) {
    if (typeof ask !== 'function') return null;
    let out = null;
    try { out = await ask(PROMPT(text)); } catch (e) {
        // A model that is down must not take the payment flow with it. The
        // caller falls back to asking her in words.
        console.error('[pay-ai] could not read the message:', e.message);
        return null;
    }
    if (!out || typeof out !== 'object' || out.is_payment !== true) return null;

    const amount = num(out.amount);
    const supplier = str(out.supplier);
    // Without both, there is nothing to confirm and nothing to ask about.
    if (!amount || !supplier) return null;

    const kind = out.kind === 'advance' || out.kind === 'bill' ? out.kind : null;
    const mode = MODES.find((m) => m.toLowerCase() === str(out.mode).toLowerCase()) || null;

    return {
        amount,
        supplier,
        // Shaped exactly like supplierPayTalk.parse's result, so the action
        // cannot tell which path produced it and there is one flow, not two.
        saidAdvance: kind === 'advance',
        saidAgainstBill: kind === 'bill',
        mode,
        said: String(text || ''),
        // The model's own doubt, carried through. Her instruction was "in
        // case of doubt, ask user", and that is only possible if the doubt
        // survives the function that produced it.
        confident: out.confident === true,
        viaModel: true,
    };
}

module.exports = { read, PROMPT, MODES };
