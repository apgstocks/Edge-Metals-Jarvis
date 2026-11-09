// ── agents/paymentCase/graph.js — one customer's payment follow-up as a LangGraph ──
// plan -> recall -> tell -> wait -> record
//
//   plan    helpers/paymentChaser.nextAction decides the rung (ask / chase / escalate).
//           That function is the ladder; it is reused as it is, not re-implemented.
//   recall  READ-ONLY look at what she has taught the disk about this customer. Advice only.
//           It is shown to her; it never changes the rung. (disk rule: 'related' is advisory.)
//   tell    tells HER (or, for an escalation, her team). Never the customer: Apsara chose
//           drafts-only for customer payments on 2026-10-21 and this graph has no customer
//           address anywhere in it, so there is nothing that could send to one.
//   wait    the only thing LangGraph adds. interrupt() parks the run, saved to disk, until she
//           answers: minutes or days, across restarts.
//   record  writes what she did to the company's disk log.
//
// WHY tell AND wait ARE SEPARATE NODES: on resume LangGraph re-runs the interrupted node from
// its first line. A notify inside the same node would message her again on every resume.
//
// NOT WIRED to followUpAgentJob or anything else. That job already tells her and keeps its own
// ladder memory (PAYMENT_CHASE_LOG_FILE). Running both would send her two messages for one
// customer, so this does not write that file either; the caller decides what to do with `step`.
const { StateGraph, Annotation, START, END, interrupt } = require('@langchain/langgraph');
const chaser = require('../../helpers/paymentChaser');

// What she can answer. These four words are MY labels, not a decision of hers; they mirror the
// hold / promise ideas already in tests/payment-hold-question.js. Change them with her.
const ANSWERS = ['sent', 'hold', 'skip', 'paid'];
// How an answer is filed in the log's closed vocabulary. Also my mapping, not hers:
// sent = she followed the proposal; hold/skip = she did not; paid = the proposal was wrong.
const OUTCOME_FOR = { sent: 'approved', hold: 'rejected', skip: 'rejected', paid: 'corrected' };

const State = Annotation.Root({
    company: Annotation(),
    draft: Annotation(),
    entry: Annotation(),
    now: Annotation(),
    step: Annotation(),
    why: Annotation(),
    advice: Annotation(),
    text: Annotation(),
    audience: Annotation(),
    eventId: Annotation(),
    answer: Annotation(),
    outcome: Annotation(),
});

const clip = (v, n = 140) => { const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function build({ partition, notify }) {
    const plan = (s) => {
        const a = chaser.nextAction(s.draft, s.entry, s.now);
        return { step: a.step || null, why: a.why };
    };

    const recall = (s) => {
        const name = (s.draft && s.draft.customer) || '';
        const { entities } = partition.facts.resolve(name);
        const own = partition.facts.recall(entities.filter((e) => e.type === 'customer'));
        const taught = own.filter((f) => f.scopeType === 'customer').map((f) => ({ basis: 'exact', name: f.name, value: clip(f.value) }));
        return { advice: taught };
    };

    const tell = async (s, config) => {
        const audience = s.step === 'escalate' ? 'team' : 'owner';
        const lines = [chaser.lineFor(s.draft, s.step)];
        for (const a of s.advice || []) lines.push(`  on file: ${a.name} - ${a.value}`);
        const text = lines.join('\n');
        // Notify FIRST, log second: a crash between them can only leave a message without a log row,
        // never a log row for a message that was not sent.
        await notify({ company: s.company, audience, customer: s.draft.customer, step: s.step, text,
            threadId: config && config.configurable && config.configurable.thread_id });
        const eventId = partition.log.event({ decisionType: `payment_chase_${s.step}`,
            key: `payment-chase:${chaser.keyOf(s.draft.customer)}`, risk: 'money' });
        return { text, audience, eventId };
    };

    // Nothing but the pause. Any side effect here would repeat on every resume.
    const wait = (s) => {
        const answer = interrupt({ customer: s.draft.customer, step: s.step, text: s.text, options: ANSWERS });
        return { answer: String(answer) };
    };

    const record = (s) => {
        const outcome = OUTCOME_FOR[s.answer];
        if (!outcome) throw new Error(`unknown answer "${s.answer}"`);
        if (s.eventId != null) partition.log.outcome(s.eventId, outcome, { answer: s.answer });
        return { outcome };
    };

    return new StateGraph(State)
        .addNode('plan', plan)
        .addNode('recall', recall)
        .addNode('tell', tell)
        .addNode('wait', wait)
        .addNode('record', record)
        .addEdge(START, 'plan')
        .addConditionalEdges('plan', (s) => (s.step ? 'recall' : END), ['recall', END])
        .addEdge('recall', 'tell')
        .addEdge('tell', 'wait')
        .addEdge('wait', 'record')
        .addEdge('record', END);
}

module.exports = { build, ANSWERS, OUTCOME_FOR };
