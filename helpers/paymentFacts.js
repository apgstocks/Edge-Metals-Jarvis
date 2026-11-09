// ── helpers/paymentFacts.js — what she has told Jarvis about THIS customer ───────────────────
// Apsara, 2026-11-09: "No decision reads your notes yet, it must use." Her "remember: ..." facts reach the
// AI-written replies (helpers/context.js puts them in the prompt) but NOT the rule-based payment follow-up job,
// so "Rad Metal always pays on the 15th" could sit in memory while the job still drafted a chase on the 12th.
//
// This is the smallest honest use of them: when the job tells HER a follow-up is due, it also shows the facts she
// gave that name that customer. ADVISORY ONLY. It never changes who is chased, when, or whether; a free-text
// sentence cannot safely become code, and the decision stays hers. (If she confirms such a rule a few times, letting
// it skip a chase is a separate, later step that needs her yes.)
//
// MATCH = the customer's full name appears in the fact as whole words, any case or spacing. Deterministic, no
// network, no embeddings: the job runs hourly and must not depend on Gemini or Supabase being up. A fact that never
// names the customer ("never chase before the 20th") is NOT found here; that needs a rule she can attach to a customer.
// Pure over (customer, facts). The caller supplies the facts, already filtered to ones Jarvis may believe
// (helpers/json loadBelievableFacts drops anything that came from outside), so a sentence a supplier typed into an
// email can never appear here as if she had said it.
const spaced = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const clip = (s, n) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/** -> [{ text, inferred }], pinned first then newest, at most `max`. */
function onFile(customer, facts, opts) {
    const { max = 2, clipTo = 140 } = opts || {};
    const name = spaced(customer);
    if (name.length < 3 || !Array.isArray(facts)) return [];          // "LA" is not a customer name worth matching on
    const needle = ` ${name} `;
    const hits = [];
    for (const f of facts) {
        if (!f || typeof f !== 'object' || typeof f.text !== 'string') continue;
        if (!` ${spaced(f.text)} `.includes(needle)) continue;
        hits.push(f);
    }
    hits.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || String(b.created_at || '').localeCompare(String(a.created_at || '')));
    return hits.slice(0, Math.max(0, max)).map((f) => ({ text: clip(f.text, clipTo), inferred: f.authority === 'inform' }));
}

module.exports = { onFile };
