// ── agents/paymentCase/checkpointer.js — LangGraph state that survives a restart ──
// LangGraph's own MemorySaver keeps a graph's progress in memory. That is what makes
// "ask her, wait three days, carry on" impossible: a pm2 restart forgets the wait.
// This keeps MemorySaver's reading logic (getTuple / list / getDeltaChannelHistory are
// LangGraph's own, untouched) and adds only persistence: every write is also APPENDED to
// a JSONL journal, and the journal is replayed at construction. Same design as
// helpers/disk/jsonl.js and for the same reason: nothing here edits a line in place, so
// one write cannot clobber another, and a torn last line is skipped, not fatal.
//
// It lives inside ONE company's partition directory. There is no company argument to get
// wrong and no shared file: a checkpoint written for Edge Metals is in Edge Metals' folder.
//
// NOT in the nightly backup: helpers/backup.js only collects *.json (the same gap that
// already hides data/outcomes.jsonl). These are in-flight states, not knowledge, but a
// restore from backup would forget any answer she had not yet given.
const path = require('path');
const { MemorySaver } = require('@langchain/langgraph');
const { append, readAll } = require('../../helpers/disk/jsonl');

const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const wkey = (t, ns, id) => JSON.stringify([t, ns, id]);   // same key shape MemorySaver uses

class DiskCheckpointer extends MemorySaver {
    constructor(opts) {
        super();
        const { dir, name } = opts || {};
        if (!dir) throw new Error('DiskCheckpointer needs the partition directory');
        if (name != null && !/^[a-z]{2,20}$/.test(name)) throw new Error('checkpointer name must be 2-20 lower-case letters');
        // No name = the payment agent's original file. Another agent passes a name so two graphs never share one journal
        // (a thread id from one would otherwise show up as 'waiting' in the other).
        this.file = path.join(dir, name ? `checkpoints.${name}.jsonl` : 'checkpoints.jsonl');
        const { rows, bad } = readAll(this.file);
        this.badLines = bad;
        for (const r of rows) this._replay(r);
    }

    _replay(r) {
        if (!r || typeof r !== 'object') return;
        if (r.k === 'c') {
            const s = (this.storage[r.t] ||= Object.create(null));
            const n = (s[r.ns] ||= Object.create(null));
            n[r.id] = [unb64(r.v[0]), unb64(r.v[1]), r.v[2] == null ? undefined : r.v[2]];
        } else if (r.k === 'w') {
            const o = (this.writes[r.key] ||= Object.create(null));
            o[r.inner] = [r.rec[0], r.rec[1], unb64(r.rec[2]), r.rec[3]];
        } else if (r.k === 'd') {
            super.deleteThread(r.t);
        }
    }

    async put(config, checkpoint, metadata) {
        const out = await super.put(config, checkpoint, metadata);
        const t = config.configurable.thread_id;
        const ns = config.configurable.checkpoint_ns ?? '';
        const e = this.storage[t][ns][checkpoint.id];
        append(this.file, { k: 'c', t, ns, id: checkpoint.id, v: [b64(e[0]), b64(e[1]), e[2] ?? null] });
        return out;
    }

    async putWrites(config, writes, taskId, taskPath) {
        await super.putWrites(config, writes, taskId, taskPath);
        const c = config.configurable;
        const key = wkey(c.thread_id, c.checkpoint_ns, c.checkpoint_id);
        const stored = this.writes[key] || {};
        for (const inner of Object.keys(stored)) {
            if (!inner.startsWith(`${taskId},`)) continue;
            const rec = stored[inner];
            append(this.file, { k: 'w', key, inner, rec: [rec[0], rec[1], b64(rec[2]), rec[3]] });   // replaying the same line twice is harmless
        }
    }

    async deleteThread(threadId) {
        await super.deleteThread(threadId);
        append(this.file, { k: 'd', t: threadId });
    }

    /** Thread ids that have any saved state. */
    threads() { return Object.keys(this.storage); }
}

module.exports = { DiskCheckpointer };
