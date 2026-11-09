// ── agents/teach/index.js — teach Jarvis a rule in her own words ──────────────
// createRunner({ disk, company, embedder, notify, askAbove }) -> { start, answer, waiting, recall, company }
//
//   start({ text, by, role })   keeps her words, or asks first if they look like something she already said.
//   answer(threadId, reply)     'replace 4' | 'keep' | 'cancel'. Checked BEFORE the pause is used.
//   waiting()                   questions parked on her, this company only.
//   recall(text, { k })         what she has said that relates to `text`. Advisory; labelled; never throws.
//
// One partition per runner: a rule taught for Edge Yard is in Edge Yard's folder and cannot be found from
// Edge Metals, by construction. There is no default company. Only manager/team may teach (the MemPoison rule),
// and that is checked before anything is embedded or asked.
const crypto = require('crypto');
const { Command } = require('@langchain/langgraph');
const { DiskCheckpointer } = require('../paymentCase/checkpointer');
const { build } = require('./graph');
const { FACT_TEACHERS } = require('../../helpers/disk');
const { spaced } = require('../../helpers/disk/text');

function parseReply(reply) {
    if (reply && typeof reply === 'object') return { action: String(reply.action || '').toLowerCase(), id: reply.id };
    const s = String(reply == null ? '' : reply).trim().toLowerCase();
    if (/^keep( both)?$/.test(s)) return { action: 'keep' };
    if (/^cancel$/.test(s)) return { action: 'cancel' };
    const m = /^replace\s*#?\s*(\d+)$/.exec(s);
    if (m) return { action: 'replace', id: Number(m[1]) };
    return null;
}

function createRunner(opts) {
    const { disk, company, embedder, notify, askAbove = 0.8 } = opts || {};
    if (!disk || typeof disk.for !== 'function') throw new Error('createRunner needs the disk');
    if (!embedder || typeof embedder.embed !== 'function' || !embedder.model) throw new Error('createRunner needs an embedder { model, embed() }');
    if (typeof notify !== 'function') throw new Error('createRunner needs notify(): there is no default, so nothing is sent by accident');
    if (!(askAbove > 0 && askAbove <= 1)) throw new Error('askAbove must be between 0 and 1');

    const partition = disk.for(company);          // throws PartitionError for a missing or unregistered company
    const co = partition.company;
    const saver = new DiskCheckpointer({ dir: partition.dir, name: 'teach' });
    const graph = build({ partition, embedder, notify, askAbove }).compile({ checkpointer: saver });
    const prefix = `${co}::teach::`;
    const cfgFor = (t) => ({ configurable: { thread_id: t } });
    const mine = (t) => typeof t === 'string' && t.startsWith(prefix);

    // "waiting" = parked on HER answer (a real interrupt). A run that stopped earlier (embedder down) has steps left but is not waiting.
    async function snapshot(threadId) {
        const s = await graph.getState(cfgFor(threadId));
        const exists = !!(s && s.config && s.config.configurable && s.config.configurable.checkpoint_id);
        const parked = ((s && s.tasks) || []).some((t) => t.interrupts && t.interrupts.length);
        return { exists, waiting: parked, finished: exists && !((s.next || []).length), values: (s && s.values) || {} };
    }
    const summarise = (threadId, v) => {
        const r = v.result;
        if (r) return r.action === 'failed' ? { status: 'failed', threadId, reason: r.reason }
            : r.action === 'already_known' ? { status: 'already_known', threadId, id: r.id }
            : { status: r.action, threadId, id: r.id || null, replaced: r.replaced || null };
        return { status: 'waiting', threadId, question: v.question, candidates: v.candidates };
    };

    async function start(args) {
        const { text, by, role } = args || {};
        if (!FACT_TEACHERS.has(role)) return { status: 'refused', reason: 'only manager/team may teach Jarvis' };
        if (!by) return { status: 'refused', reason: 'by is required' };
        const t = typeof text === 'string' ? text.trim() : '';
        if (!t) return { status: 'refused', reason: 'nothing to remember' };
        const hash = crypto.createHash('sha1').update(spaced(t)).digest('hex').slice(0, 10);

        // The same words can be taught again later (after a cancel, say), so a FINISHED thread is skipped, not reused.
        for (let n = 0; n < 50; n++) {
            const threadId = `${prefix}${hash}${n ? `::${n}` : ''}`;
            const prior = await snapshot(threadId);
            if (!prior.exists) {
                await graph.invoke({ company: co, text: t, by: String(by), role }, cfgFor(threadId));
                return summarise(threadId, (await snapshot(threadId)).values);
            }
            if (prior.waiting) return { status: 'already_waiting', threadId, question: prior.values.question, candidates: prior.values.candidates };
            if (prior.finished) continue;
            await graph.invoke(null, cfgFor(threadId));      // an earlier attempt stopped part-way (embedder was down): carry on
            return summarise(threadId, (await snapshot(threadId)).values);
        }
        throw new Error('too many earlier attempts at the same words');
    }

    async function answer(threadId, reply) {
        if (!mine(threadId)) throw new Error(`thread does not belong to ${co}`);
        const d = parseReply(reply);
        if (!d || !['replace', 'keep', 'cancel'].includes(d.action)) throw new Error('reply must be: replace <number> | keep | cancel');
        const before = await snapshot(threadId);
        if (!before.waiting) throw new Error('nothing is waiting on that thread');
        if (d.action === 'replace' && !(before.values.candidates || []).some((c) => c.id === d.id)) {
            throw new Error(`replace needs one of: ${(before.values.candidates || []).map((c) => c.id).join(', ')}`);   // before resuming, so a wrong number does not use up the pause
        }
        await graph.invoke(new Command({ resume: d }), cfgFor(threadId));
        return summarise(threadId, (await snapshot(threadId)).values);
    }

    async function waiting() {
        const out = [];
        for (const t of saver.threads()) {
            if (!mine(t)) continue;
            const s = await snapshot(t);
            if (s.waiting) out.push({ threadId: t, text: s.values.text, question: s.values.question, candidates: s.values.candidates });
        }
        return out;
    }

    async function recall(text, o) {
        const { k = 5, minScore = 0.5 } = o || {};
        let vector = null, embedderError = null;
        try { vector = await embedder.embed(text); } catch (e) { embedderError = e && e.message ? e.message : String(e); }
        const notes = partition.notes.search({ vector, model: vector ? embedder.model : undefined, text, k, minScore });
        return { notes, via: vector ? 'meaning+keywords' : 'keywords', embedderError };
    }

    return { start, answer, waiting, recall, company: co };
}

module.exports = { createRunner, parseReply };
