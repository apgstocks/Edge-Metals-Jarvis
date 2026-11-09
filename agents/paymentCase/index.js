// ── agents/paymentCase/index.js — start a payment follow-up, answer it later ──────
// createRunner({ disk, company, notify }) -> { start, answer, waiting }
//
//   start({ draft, entry, now })  decides the rung; if one is due, tells her and parks the run.
//                                 Idempotent: calling it again for the same customer + invoices +
//                                 rung while it is still waiting (or already answered) does NOT
//                                 message her a second time. An hourly job can call it freely.
//   answer(threadId, 'sent'|'hold'|'skip'|'paid')   resumes the parked run and logs the outcome.
//   waiting()                     what is parked, for this company only.
//
// EDGE METALS ONLY. The payment ladder and paymentFollowups read Edge Metals' sales; Edge Yard has
// no such flow. A runner for any other company refuses to exist rather than quietly using the same
// rules (CLAUDE.md rule 5: Edge Yard and Edge Metals are different companies).
const { Command } = require('@langchain/langgraph');
const { DiskCheckpointer } = require('./checkpointer');
const { build, ANSWERS } = require('./graph');
const chaser = require('../../helpers/paymentChaser');

const ALLOWED = ['edge_metals'];
const norm = (c) => String(c == null ? '' : c).trim().toLowerCase().replace(/[\s-]+/g, '_');

function createRunner(opts) {
    const { disk, company, notify } = opts || {};
    const co = norm(company);
    if (!ALLOWED.includes(co)) throw new Error(`payment follow-up graph is Edge Metals only; refusing "${company}"`);
    if (!disk || typeof disk.for !== 'function') throw new Error('createRunner needs the disk');
    if (typeof notify !== 'function') throw new Error('createRunner needs notify(): there is no default, so nothing can be sent by accident');

    const partition = disk.for(co);
    const saver = new DiskCheckpointer({ dir: partition.dir });
    const graph = build({ partition, notify }).compile({ checkpointer: saver });
    const prefix = `${co}::`;
    const cfgFor = (threadId) => ({ configurable: { thread_id: threadId } });
    const mine = (threadId) => typeof threadId === 'string' && threadId.startsWith(prefix);

    // "waiting" means PARKED ON HER ANSWER (a real interrupt), not merely "has a step left". A run that
    // crashed before she was told (say notify threw) has a step left too, and must be retried, not skipped.
    async function snapshot(threadId) {
        const s = await graph.getState(cfgFor(threadId));
        const v = (s && s.values) || {};
        const exists = !!(s && s.config && s.config.configurable && s.config.configurable.checkpoint_id);
        const parked = ((s && s.tasks) || []).some((t) => t.interrupts && t.interrupts.length);
        return { exists, waiting: parked, finished: exists && !((s.next || []).length), values: v };
    }

    async function start(args) {
        const { draft, entry, now } = args || {};
        if (!draft || !draft.customer) throw new Error('start needs a draft with a customer');
        const at = now == null ? Date.now() : now;
        const a = chaser.nextAction(draft, entry, at);
        if (!a.step) return { status: 'nothing_due', why: a.why };

        const threadId = `${prefix}${chaser.keyOf(draft.customer)}::${chaser.setKey(draft)}::${a.step}`;
        const prior = await snapshot(threadId);
        if (prior.exists) {
            if (prior.waiting) return { status: 'already_waiting', threadId, step: a.step };
            if (prior.finished) return { status: 'already_answered', threadId, step: a.step, outcome: prior.values.outcome };
            await graph.invoke(null, cfgFor(threadId));   // an earlier attempt died before she was told: carry on from its last good step
        } else {
            await graph.invoke({ company: co, draft, entry: entry || null, now: at }, cfgFor(threadId));
        }
        const s = await snapshot(threadId);
        return { status: 'waiting', threadId, step: a.step, audience: s.values.audience, text: s.values.text };
    }

    async function answer(threadId, reply) {
        if (!mine(threadId)) throw new Error(`thread does not belong to ${co}`);
        const r = String(reply == null ? '' : reply).trim().toLowerCase();
        if (!ANSWERS.includes(r)) throw new Error(`answer must be one of: ${ANSWERS.join(', ')}`);   // checked BEFORE resuming, so a typo does not use up the pause
        const before = await snapshot(threadId);
        if (!before.waiting) throw new Error('nothing is waiting on that thread');
        await graph.invoke(new Command({ resume: r }), cfgFor(threadId));
        const after = await snapshot(threadId);
        return { status: 'done', threadId, answer: r, outcome: after.values.outcome };
    }

    async function waiting() {
        const out = [];
        for (const t of saver.threads()) {
            if (!mine(t)) continue;
            const s = await snapshot(t);
            if (s.waiting) out.push({ threadId: t, customer: s.values.draft && s.values.draft.customer, step: s.values.step, text: s.values.text });
        }
        return out;
    }

    return { start, answer, waiting, company: co };
}

module.exports = { createRunner, ALLOWED, ANSWERS };
