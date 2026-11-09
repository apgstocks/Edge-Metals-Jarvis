// ── helpers/playbook.js — the Playbook: every rule Apsara has given, in one list ──
// docs/OWNERSHIP-PLAN.md section 5: "Everything she says becomes a rule in one
// Playbook: a readable list, with the date and her words, that Jarvis applies and
// she can edit or delete."
//
// This is the FIRST, READ-ONLY slice of that. It stores the rules in the disk's
// facts layer (helpers/disk) and lets her list them, ask what Jarvis would recall
// for a situation, and delete one. It CHANGES NO DECISION: nothing in the app reads
// the Playbook yet, so paymentChaser, paymentFollowups and paymentTruth behave exactly
// as before. Seeing what Jarvis "knows" comes before letting it act on it.
//
// Edge METALS only. The seed below is Edge Metals' rules; Edge Yard's partition is
// never written here (CLAUDE.md rule 5).
//
// The seed is NOT a second source of truth for terms she has already given Jarvis
// elsewhere (per-customer ETA terms live in CUSTOMER_PAY_TERMS_FILE). It holds the
// standing rules she stated in words, which until now lived in code comments and chat.

const WHO = { by: 'apsara', role: 'manager' };
const SRC = 'stated 2026-11-07; seeded from docs/OWNERSHIP-PLAN.md section 5';

// Her words of 2026-11-07, kept as close to what she said as a rule can be.
const SEED = [
    { scopeType: 'global', scopeId: '', name: 'lc_customers_no_followup',
      value: 'Customers on LC terms get no payment follow-up notifications at all: not the first note, not the chase, not the escalation.' },
    { scopeType: 'global', scopeId: '', name: 'customer_emails',
      value: 'Customer payment emails are staged on WhatsApp and sent only after her yes, as a reply in the same thread as the invoice email, in a professional tone.' },
    { scopeType: 'global', scopeId: '', name: 'payment_truth',
      value: 'Whether a customer still owes is decided by QuickBooks, the Plaid bank feed and the books, not by Jarvis\'s own sales ledger, which holds no payments.' },
    { scopeType: 'global', scopeId: '', name: 'if_unsure_ask',
      value: 'If Jarvis is unsure (for example a deposit or mail that may be a customer\'s payment) it asks her a yes/no question instead of guessing or only reporting.' },
    { scopeType: 'global', scopeId: '', name: 'report_style',
      value: 'Keep WhatsApp and email reports short: one crisp line or one heading per reason, never a long list.' },
    { scopeType: 'customer', scopeId: 'rad-metal', name: 'always_pays',
      value: 'Always pays. Any open balance Jarvis shows for this customer is false (its ledger has no payments).' },
    { scopeType: 'customer', scopeId: 'mk-trading', name: 'always_pays',
      value: 'Always pays. Any open balance Jarvis shows for this customer is false (its ledger has no payments).' },
    { scopeType: 'customer', scopeId: 'fmc-metals', name: 'always_pays',
      value: 'Always pays. Any open balance Jarvis shows for this customer is false (its ledger has no payments).' },
];

/**
 * Write the seed rules into a partition. Idempotent, and it never overwrites: a rule
 * that already exists with the same words is skipped, one that exists with DIFFERENT
 * words (she edited it) is reported as a conflict and left exactly as she has it. A rule
 * she deleted stays deleted and is listed under `forgotten`.
 */
function seed(partition) {
    const out = { added: [], skipped: [], conflicts: [], forgotten: [] };
    for (const r of SEED) {
        const have = partition.facts.get(r.scopeType, r.scopeId, r.name);
        if (have && have.value === r.value) { out.skipped.push(r.name); continue; }
        if (have) { out.conflicts.push({ name: r.name, scope: have.scope, keeps: have.value }); continue; }
        // She deleted it on purpose. Running seed again must not quietly bring it back.
        if (partition.facts.history(r.scopeType, r.scopeId, r.name).some((h) => h.forgottenAt)) {
            out.forgotten.push(`${r.scopeId ? r.scopeId + ': ' : ''}${r.name}`); continue;
        }
        const res = partition.facts.put({ ...r, ...WHO, sourceMsg: SRC });
        if (res.ok) out.added.push(`${r.scopeId ? r.scopeId + ': ' : ''}${r.name}`);
        else out.conflicts.push({ name: r.name, scope: r.scopeType, keeps: res.reason });
    }
    return out;
}

/** The whole Playbook, oldest first. */
function list(partition) {
    return partition.facts.all();
}

/** What Jarvis would recall for this situation, labelled exact vs possibly-relevant. */
function ask(partition, text) {
    const q = partition.query({ text });
    return { exact: q.facts.exact, related: q.facts.related, entities: q.entities, ambiguous: q.ambiguous, brief: q.brief };
}

/** "Forget this rule." */
function forget(partition, id) {
    return partition.facts.forget(Number(id), WHO);
}

module.exports = { SEED, seed, list, ask, forget, WHO, SRC };
