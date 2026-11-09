// ── helpers/disk/notes.js — what she said, in her own words, findable by meaning ──
// Apsara, 2026-11-09: "I dont want strict rules.. Rules on the go, as I say, all these
// should be stored as embeddings in Jarvis." So this layer has NO schema: no scope, no
// name, no field. A note is her sentence, kept verbatim, plus a vector for finding it again
// when something similar comes up. (L1 facts stay as they are; this sits beside them.)
//
// ── THE RULES THAT MATTER ────────────────────────────────────────────────
//   Append-only JSONL, replayed at load (same as facts/log/links). A correction is a new
//   note that REPLACES an old one; the old one stays in the file, marked superseded.
//   Only manager/team may add a note (the MemPoison rule). Text from a supplier, trucker
//   or customer can never become one. Nothing here reads a message; callers pass text.
//   A vector is only ever compared with vectors made by THE SAME MODEL (the tag is stored
//   with it). Two models' vectors are not comparable and silently mixing them returns
//   confident nonsense, so a note with a missing or different-model vector is found by
//   keywords instead, never skipped and never mis-scored.
//   Every hit is 'related' (advisory) unless the text is identical. A meaning match may
//   shape a question to her; it must never be the only reason Jarvis acts alone.
//   Vectors are stored L2-normalised as base64 float32, so a score is a dot product.
//   snapshot() carries the TEXT only (vectors are re-derivable; see needsEmbedding()).
const { append, readAll } = require('./jsonl');
const { tokens, spaced } = require('./text');

const TEACHERS = new Set(['manager', 'team']);
const MAX_TEXT = 2000;
const nowIso = (clock) => clock().toISOString();

function normalise(vector) {
    if (!vector || typeof vector.length !== 'number' || vector.length < 1) return null;
    let sum = 0;
    for (let i = 0; i < vector.length; i++) {
        const x = Number(vector[i]);
        if (!Number.isFinite(x)) return null;
        sum += x * x;
    }
    if (!(sum > 0)) return null;
    const n = Math.sqrt(sum), out = new Float32Array(vector.length);
    for (let i = 0; i < vector.length; i++) out[i] = Number(vector[i]) / n;
    return out;
}
const encode = (f32) => Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
function decode(b64) {
    try {
        const u8 = new Uint8Array(Buffer.from(String(b64), 'base64'));
        return u8.length && u8.length % 4 === 0 ? new Float32Array(u8.buffer) : null;
    } catch (_) { return null; }
}
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

class Notes {
    constructor(file, clock) {
        this.file = file; this.clock = clock;
        this.byId = new Map();
        this.nextId = 1;
        const { rows, bad } = readAll(file);
        this.badLines = bad;
        for (const r of rows) { try { this._apply(r); } catch (_) { this.badLines++; } }
    }

    _apply(r) {
        if (r.t === 'note') {
            const n = { id: r.id, at: r.at, text: r.text, by: r.by, role: r.role, model: r.model || null,
                vec: r.vec ? decode(r.vec) : null, replaces: r.replaces || null, supersededBy: null, live: true, forgotten: false };
            if (!n.vec) n.model = null;           // a model tag with no vector means nothing
            this.byId.set(n.id, n);
            this.nextId = Math.max(this.nextId, n.id + 1);
            if (n.replaces && this.byId.has(n.replaces)) { const o = this.byId.get(n.replaces); o.live = false; o.supersededBy = n.id; }
        } else if (r.t === 'vec') {
            const n = this.byId.get(r.id); const v = decode(r.vec);
            if (n && v && r.model) { n.vec = v; n.model = r.model; }
        } else if (r.t === 'forget') {
            const n = this.byId.get(r.id);
            if (n) { n.live = false; n.forgotten = true; }
        }
    }

    _pub(n, extra) {
        return { id: n.id, text: n.text, by: n.by, at: n.at, embedded: !!n.vec, ...extra };
    }

    /** Add her words. Returns { ok, id, replaced } | { ok:true, id, duplicate:true } | { ok:false, reason }. */
    add(args) {
        const { text, by, role, model, vector, replaces } = args || {};
        if (!TEACHERS.has(role)) return { ok: false, reason: 'only manager/team may teach Jarvis' };
        if (!by) return { ok: false, reason: 'by is required' };
        const t = typeof text === 'string' ? text.trim() : '';
        if (!t) return { ok: false, reason: 'nothing to remember' };
        if (t.length > MAX_TEXT) return { ok: false, reason: `too long (${t.length} > ${MAX_TEXT}); say it shorter or in two notes` };
        let vec = null;
        if (vector != null) {
            if (!model || typeof model !== 'string') return { ok: false, reason: 'a vector must say which model made it' };
            vec = normalise(vector);
            if (!vec) return { ok: false, reason: 'vector is empty, not a list of numbers, or all zero' };
        }
        let old = null;
        if (replaces != null) {
            old = this.byId.get(replaces);
            if (!old || !old.live) return { ok: false, reason: `note ${replaces} is not a live note to replace` };
        } else {
            const same = [...this.byId.values()].find((n) => n.live && spaced(n.text) === spaced(t));
            if (same) return { ok: true, id: same.id, duplicate: true };   // she said exactly this already; nothing to write
        }
        const row = { t: 'note', id: this.nextId, at: nowIso(this.clock), text: t, by: String(by), role,
            model: vec ? model : null, vec: vec ? encode(vec) : null, replaces: old ? old.id : null };
        try { append(this.file, row); } catch (e) { return { ok: false, reason: `write failed: ${e.message}` }; }
        this._apply(row);
        return { ok: true, id: row.id, replaced: old ? old.id : null };
    }

    /** Give an existing note a vector (after a restore, or when the embedding model changed). */
    setVector(id, args) {
        const { model, vector, by, role } = args || {};
        if (!TEACHERS.has(role) && role !== 'system') return false;
        const n = this.byId.get(id); const vec = normalise(vector);
        if (!n || !vec || !model || !by) return false;
        const row = { t: 'vec', id, model: String(model), vec: encode(vec), by: String(by), at: nowIso(this.clock) };
        try { append(this.file, row); } catch (_) { return false; }
        this._apply(row);
        return true;
    }

    forget(id, args) {
        const { by, role } = args || {};
        if (!TEACHERS.has(role) || !by) return false;
        const n = this.byId.get(id);
        if (!n || !n.live) return false;
        const row = { t: 'forget', id, by: String(by), at: nowIso(this.clock) };
        try { append(this.file, row); } catch (_) { return false; }
        this._apply(row);
        return true;
    }

    get(id) { const n = this.byId.get(id); return n ? this._pub(n, { live: n.live, replaces: n.replaces, supersededBy: n.supersededBy }) : null; }
    list() { return [...this.byId.values()].filter((n) => n.live).map((n) => this._pub(n)); }
    size() { let c = 0; for (const n of this.byId.values()) if (n.live) c++; return c; }

    /** The chain of wordings for one idea, oldest first, following replaces / supersededBy. */
    history(id) {
        let n = this.byId.get(id); if (!n) return [];
        while (n.replaces && this.byId.has(n.replaces)) n = this.byId.get(n.replaces);
        const out = [];
        for (let guard = 0; n && guard < 1000; guard++) { out.push(this._pub(n, { live: n.live })); n = n.supersededBy ? this.byId.get(n.supersededBy) : null; }
        return out;
    }

    /** Live notes with no vector from `model` (just restored, or the model changed). */
    needsEmbedding(model) {
        return [...this.byId.values()].filter((n) => n.live && (!n.vec || n.model !== model)).map((n) => ({ id: n.id, text: n.text }));
    }

    /**
     * Find what she said that relates to this. Advisory only.
     *   vector + model  meaning search (only against vectors from the same model, same length)
     *   text            keyword search, which also covers notes that have no usable vector
     * Meaning hits come first (cosine, best first), then keyword-only hits. Never throws.
     */
    search(args) {
        const { vector, model, text, k = 5, minScore = 0.5, minTerms = 2 } = args || {};
        const out = [], seen = new Set();
        const q = vector != null && model ? normalise(vector) : null;
        const want = spaced(text);
        if (q) {
            for (const n of this.byId.values()) {
                if (!n.live || !n.vec || n.model !== model || n.vec.length !== q.length) continue;
                const score = dot(q, n.vec);
                if (score >= minScore) { out.push(this._pub(n, { score: Math.round(score * 1000) / 1000, via: 'meaning', basis: want && spaced(n.text) === want ? 'exact' : 'related' })); seen.add(n.id); }
            }
            out.sort((a, b) => b.score - a.score || b.id - a.id);
        }
        const qt = [...new Set(tokens(text))];
        if (qt.length) {
            const need = Math.min(minTerms, qt.length), kw = [];
            for (const n of this.byId.values()) {
                if (!n.live || seen.has(n.id)) continue;
                const nt = new Set(tokens(n.text));
                let c = 0; for (const t of qt) if (nt.has(t)) c++;
                if (c >= need) kw.push(this._pub(n, { score: Math.round((c / qt.length) * 1000) / 1000, via: 'keywords', basis: want && spaced(n.text) === want ? 'exact' : 'related' }));
            }
            kw.sort((a, b) => b.score - a.score || b.id - a.id);
            out.push(...kw);
        }
        return out.slice(0, Math.max(0, k));
    }
}

module.exports = { Notes, TEACHERS, MAX_TEXT, normalise };
