// ── agents/teach/graph.js — "rules on the go": she says it, Jarvis keeps it ───────
// embed -> find -> ( nothing similar ? save : ask -> wait -> apply )
//
//   embed  text -> vector (the injected embedder; Gemini in production)
//   find   notes she already gave that look like this one. A MEANING match, or a keyword match covering most
//          of her words, counts. Advisory: it only decides whether to ASK.
//   save   nothing similar: store her words as they are. She said it; that is her yes.
//   ask    something similar: tell her what it found and what the options are.
//   wait   the pause. Alone in its node so a resume cannot ask twice. Survives restarts.
//   apply  replace #N (old note kept in history, marked superseded) / keep both / cancel.
//
// NEVER REPLACES ON ITS OWN. A similarity score is a guess; replacing a rule she gave is a decision of hers.
// The 0.80 default for "similar enough to ask" is UNCALIBRATED against real Gemini vectors. Asking too often is
// an annoyance; asking too rarely only leaves two notes side by side, which she can see and forget. So it errs
// toward asking, and it is a parameter, not a constant.
const { StateGraph, Annotation, START, END, interrupt } = require('@langchain/langgraph');

const State = Annotation.Root({
    company: Annotation(), text: Annotation(), by: Annotation(), role: Annotation(),
    vector: Annotation(), model: Annotation(), candidates: Annotation(),
    question: Annotation(), decision: Annotation(), result: Annotation(),
});

const clip = (v, n = 160) => { const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const OPTIONS = ['replace <number>', 'keep', 'cancel'];

function build({ partition, embedder, notify, askAbove }) {
    const embed = async (s) => ({ vector: await embedder.embed(s.text), model: embedder.model });

    const find = (s) => {
        const hits = partition.notes.search({ vector: s.vector, model: s.model, text: s.text, k: 3, minScore: askAbove });
        // A keyword-only hit must cover most of her words to count; two shared words ("rad metal") is the same customer, not the same rule.
        // Word for word what she already has: nothing to ask. save -> notes.add reports it as already known and writes nothing.
        if (hits.some((h) => h.basis === 'exact')) return { candidates: [] };
        const near = hits.filter((h) => h.via === 'meaning' || h.score >= 0.7);
        return { candidates: near.map((h) => ({ id: h.id, text: h.text, score: h.score, via: h.via })) };
    };

    const ask = async (s, config) => {
        const lines = [`You said: "${clip(s.text)}"`, 'I already have something like it:'];
        for (const c of s.candidates) lines.push(`  #${c.id} "${clip(c.text)}"`);
        lines.push('Reply: replace <number> (the old one stays in history) | keep (both) | cancel');
        const question = lines.join('\n');
        await notify({ company: s.company, audience: 'owner', kind: 'teach_question', text: question, candidates: s.candidates,
            threadId: config && config.configurable && config.configurable.thread_id });
        return { question };
    };

    const wait = (s) => ({ decision: interrupt({ question: s.question, candidates: s.candidates, options: OPTIONS }) });

    const put = (s, replaces) => {
        const r = partition.notes.add({ text: s.text, by: s.by, role: s.role, model: s.model, vector: s.vector, replaces });
        if (!r.ok) return { result: { action: 'failed', reason: r.reason } };   // e.g. the note she chose was forgotten while she was thinking
        return { result: { action: r.duplicate ? 'already_known' : replaces ? 'replaced' : 'saved', id: r.id, replaced: r.replaced || null } };
    };
    const save = (s) => put(s, null);
    const apply = (s) => {
        const d = s.decision || {};
        if (d.action === 'cancel') return { result: { action: 'cancelled' } };
        if (d.action === 'keep') return put(s, null);
        if (d.action === 'replace') return put(s, d.id);
        return { result: { action: 'failed', reason: `unknown decision "${d.action}"` } };
    };

    return new StateGraph(State)
        .addNode('embed', embed).addNode('find', find).addNode('save', save)
        .addNode('ask', ask).addNode('wait', wait).addNode('apply', apply)
        .addEdge(START, 'embed').addEdge('embed', 'find')
        .addConditionalEdges('find', (s) => (s.candidates && s.candidates.length ? 'ask' : 'save'), ['ask', 'save'])
        .addEdge('save', END).addEdge('ask', 'wait').addEdge('wait', 'apply').addEdge('apply', END);
}

module.exports = { build, OPTIONS };
