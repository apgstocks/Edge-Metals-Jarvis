// ── helpers/disk/index.js — Jarvis's disk: one door, separate layers ─────────
//
// Apsara, 2026-11-09: "a storage layer which inbuilt contains various layers
// inside, like a hard disk for Jarvis", and "it should mimic a human: remember
// whatever I taught it, use it when needed".
//
// NOTHING IN THE APP CALLS THIS YET. It is new files only; no existing store
// is read, changed or migrated by it. Wiring is a separate step that needs her
// yes (CLAUDE.md rule 1).
//
// ── THE SHAPE ──────────────────────────────────────────────────────────────
//   disk.for('edge_metals')      the PARTITION. Every layer hangs off one.
//     .facts    what she TAUGHT it  (a newer value replaces the older; history kept)
//     .log      what Jarvis DECIDED and what she DID about it (append-only)
//     .links    which thing is connected to which (container -> booking -> customer)
//     .read()   read-only windows onto stores that already exist (trust ledger...)
//     .query()  ask a question across all of the above in one call
//     .snapshot()/.restore()  a backup.json that helpers/backup.js already collects
//
// ── WHY A PARTITION FIRST ─────────────────────────────────────────────────
// Edge Yard and Edge Metals are different companies (CLAUDE.md rule 5), and
// Jarvis is meant to be sold to others. So there is no way to reach a layer
// without naming a company, a name that is not registered throws
// PartitionError, and the two companies live in separate directories. A rule
// taught for one cannot be recalled for the other because it is not in the
// same place, not because a query remembered to filter.
//
// ── WHY NOT GRAPHQL ───────────────────────────────────────────────────────
// What GraphQL gives that is worth having is a declarative "give me these
// things, connected" request. query() takes exactly that shape. What it costs
// -- a server, a schema compiler, resolvers, a dependency -- buys nothing in a
// single-process, single-VM app with no outside clients. If Jarvis is later
// sold behind an API, a GraphQL facade can sit on query() unchanged.
//
// ── DESIGN RULES THAT ARE LOAD-BEARING ────────────────────────────────────
//   Source of truth is append-only JSONL, same as helpers/outcomes.js. Memory
//   is rebuilt by replaying it. No lock, no edit-in-place, no SQLite (which
//   needs Node >= 22; package.json says >= 20).
//   Only manager/team may TEACH a fact (the MemPoison rule, 2026-08-25). Text
//   from a supplier, trucker or customer can never become one.
//   Links may also be written by role 'system' (code that has just created a
//   booking). Wiring must never derive a link from text a third party wrote.
//   A match by NAME or by LINK is 'exact'. A match by meaning is 'related' and
//   is advisory: it may shape a question to her; it must never be the only
//   reason Jarvis acts alone.
//   One Disk per process. Two on the same directory would diverge in memory.
const fs = require('fs');
const path = require('path');
const { append, readAll, isEmpty, writeAtomic } = require('./jsonl');
const { tokens, spaced } = require('./text');
const { Notes } = require('./notes');

const DEFAULT_COMPANIES = ['edge_metals', 'edge_yard'];
const FACT_TEACHERS = new Set(['manager', 'team']);
const LINK_WRITERS = new Set(['manager', 'team', 'system']);
// Same closed vocabulary as helpers/outcomes.js and outcome.js.
const OUTCOMES = new Set(['approved', 'rejected', 'corrected', 'expired', 'superseded']);
const COUNTED = new Set(['approved', 'rejected', 'corrected']);   // expired/superseded are not evidence

class PartitionError extends Error {
    constructor(msg) { super(msg); this.name = 'PartitionError'; }
}

const slug = (s, sep) => {
    const re = new RegExp(`^${sep}+|${sep}+$`, 'g');
    return String(s == null ? '' : s).trim().toLowerCase().replace(/[^a-z0-9]+/g, sep).replace(re, '');
};
const normNode = (n) => (n && n.type && n.id ? { type: slug(n.type, '-'), id: slug(n.id, '-') } : null);
const nodeKey = (n) => `${n.type}:${n.id}`;
const nowIso = (clock) => clock().toISOString();

// ─────────────────────────────────────────────────────────────────────────
// L1  FACTS — what she taught it
// ─────────────────────────────────────────────────────────────────────────
class Facts {
    constructor(file, clock) {
        this.file = file; this.clock = clock;
        this.byId = new Map();          // id -> fact
        this.live = new Map();          // scope/name key -> the one live fact
        this.hist = new Map();          // scope/name key -> every value ever, oldest first
        this.aliases = new Map();       // spaced alias -> Set of 'type:id'
        this.index = new Map();         // stem -> Set of live fact ids
        this.nextId = 1;
        const { rows, bad } = readAll(file);
        this.badLines = bad;
        for (const r of rows) this._apply(r);
    }

    _key(st, si, nm) { return `${st}\u0000${si}\u0000${nm}`; }

    _factText(f) {
        const v = typeof f.value === 'string' ? f.value : JSON.stringify(f.value);
        // 'global' is a placeholder, not a word anyone means; leave it out of the index.
        return `${f.name.replace(/_/g, ' ')} ${f.scopeType === 'global' ? '' : f.scopeType} ${f.scopeId.replace(/-/g, ' ')} ${v}`;
    }
    _index(f) {
        f._tokens = new Set(tokens(this._factText(f)));
        for (const t of f._tokens) {
            if (!this.index.has(t)) this.index.set(t, new Set());
            this.index.get(t).add(f.id);
        }
    }
    _unindex(f) {
        for (const t of f._tokens || []) {
            const s = this.index.get(t);
            if (s) { s.delete(f.id); if (!s.size) this.index.delete(t); }
        }
    }

    _apply(r) {
        if (r.t === 'put') {
            const f = { id: r.id, scopeType: r.scopeType, scopeId: r.scopeId, name: r.name, value: r.value,
                by: r.by, role: r.role, src: r.src || null, at: r.at, live: true };
            const k = this._key(f.scopeType, f.scopeId, f.name);
            const prev = this.live.get(k);
            if (prev) { prev.live = false; prev.supersededBy = f.id; this._unindex(prev); }
            this.byId.set(f.id, f);
            this.live.set(k, f);
            if (!this.hist.has(k)) this.hist.set(k, []);
            this.hist.get(k).push(f);
            this._index(f);
            this.nextId = Math.max(this.nextId, f.id + 1);
        } else if (r.t === 'forget') {
            const f = this.byId.get(r.id);
            if (f && f.live) {
                f.live = false; f.forgottenAt = r.at;
                this.live.delete(this._key(f.scopeType, f.scopeId, f.name));
                this._unindex(f);
            }
        } else if (r.t === 'alias') {
            const a = spaced(r.alias);
            if (!this.aliases.has(a)) this.aliases.set(a, new Set());
            this.aliases.get(a).add(`${r.scopeType}:${r.scopeId}`);
        }
    }

    _pub(f) {
        return { id: f.id, scope: f.scopeId ? `${f.scopeType}:${f.scopeId}` : f.scopeType,
            scopeType: f.scopeType, scopeId: f.scopeId, name: f.name, value: f.value,
            taughtBy: f.by, at: f.at, sourceMsg: f.src };
    }

    /** Teach a fact. Manager/team only. A newer value for the same scope+name replaces the older one. */
    put(args) {
        // destructure inside: a default parameter only catches undefined, and put(null) must not throw
        const { scopeType = 'global', scopeId = '', name, value, by, role, sourceMsg } = args || {};
        if (!FACT_TEACHERS.has(role)) return { ok: false, reason: 'only manager/team may teach Jarvis' };
        const st = slug(scopeType, '-'), si = slug(scopeId, '-'), nm = slug(name, '_');
        if (!st || !nm || value === undefined || !by) return { ok: false, reason: 'name, value and by are required' };
        if (st !== 'global' && !si) return { ok: false, reason: `a ${st} fact needs a scopeId` };
        const prev = this.live.get(this._key(st, si, nm));
        const row = { t: 'put', id: this.nextId, scopeType: st, scopeId: si, name: nm, value, by: String(by),
            role, src: sourceMsg == null ? null : String(sourceMsg), at: nowIso(this.clock) };
        try { append(this.file, row); } catch (e) { return { ok: false, reason: `write failed: ${e.message}` }; }
        this._apply(row);
        return { ok: true, id: row.id, replaced: prev ? prev.id : null };
    }

    /** "Forget this." The fact stops being recalled; the log still shows it was taught and withdrawn. */
    forget(id, args) {
        const { by, role } = args || {};
        if (!FACT_TEACHERS.has(role) || !by) return false;
        const f = this.byId.get(id);
        if (!f || !f.live) return false;
        try { append(this.file, { t: 'forget', id, by: String(by), at: nowIso(this.clock) }); } catch (_) { return false; }
        this._apply({ t: 'forget', id, at: nowIso(this.clock) });
        return true;
    }

    addAlias(args) {
        const { alias, scopeType, scopeId, by, role } = args || {};
        if (!FACT_TEACHERS.has(role) || !by) return false;
        const a = spaced(alias), st = slug(scopeType, '-'), si = slug(scopeId, '-');
        if (a.length < 2 || !st || !si) return false;
        const row = { t: 'alias', alias: a, scopeType: st, scopeId: si, by: String(by), at: nowIso(this.clock) };
        try { append(this.file, row); } catch (_) { return false; }
        this._apply(row);
        return true;
    }

    /** Every live fact in the partition, for a human-readable list (the Playbook). */
    all() {
        return [...this.live.values()].sort((a, b) => a.id - b.id).map((f) => this._pub(f));
    }

    get(scopeType, scopeId, name) {
        const f = this.live.get(this._key(slug(scopeType, '-'), slug(scopeId, '-'), slug(name, '_')));
        return f ? this._pub(f) : null;
    }
    list(scopeType, scopeId) {
        const st = slug(scopeType, '-'), si = slug(scopeId, '-');
        return [...this.live.values()].filter((f) => f.scopeType === st && f.scopeId === si)
            .sort((a, b) => a.name.localeCompare(b.name)).map((f) => this._pub(f));
    }
    history(scopeType, scopeId, name) {
        const h = this.hist.get(this._key(slug(scopeType, '-'), slug(scopeId, '-'), slug(name, '_'))) || [];
        return h.map((f) => ({ ...this._pub(f), live: f.live, supersededBy: f.supersededBy || null, forgottenAt: f.forgottenAt || null }));
    }

    /** Every live fact for these scopes plus global. Exact scope only, never by similarity. */
    recall(scopes = []) {
        const wanted = [{ type: 'global', id: '' }];
        for (const s of scopes) { const n = normNode(s); if (n) wanted.push(n); }
        const seen = new Set(), out = [];
        for (const s of wanted) {
            for (const f of this.list(s.type, s.id)) if (!seen.has(f.id)) { seen.add(f.id); out.push(f); }
        }
        return out;
    }

    /** Which known things does this text name? Aliases + scope ids (3+ letters, whole words only). */
    resolve(text, extraNodes = []) {
        const hay = ` ${spaced(text)} `;
        const names = new Map();   // spaced name -> Set of 'type:id'
        const add = (n, key) => { if (!n) return; if (!names.has(n)) names.set(n, new Set()); names.get(n).add(key); };
        for (const [a, set] of this.aliases) for (const key of set) add(a, key);
        for (const f of this.live.values()) {
            if (f.scopeId) { const n = spaced(f.scopeId); if (n.length >= 3) add(n, `${f.scopeType}:${f.scopeId}`); }
        }
        for (const n of extraNodes) { const sp = spaced(n.id); if (sp.length >= 3) add(sp, nodeKey(n)); }
        const found = new Map(), ambiguous = [];
        for (const [n, set] of names) {
            if (!n || !hay.includes(` ${n} `)) continue;
            if (set.size > 1) { ambiguous.push({ name: n, could_be: [...set] }); continue; }   // never guess between two
            const key = [...set][0];
            const i = key.indexOf(':');
            found.set(key, { type: key.slice(0, i), id: key.slice(i + 1) });
        }
        return { entities: [...found.values()], ambiguous };
    }

    /** Meaning-overlap search. A hit must share >= minTerms meaningful words; one stray word is not a match. */
    search(text, opts) {
        const { k = 5, minTerms = 2, exclude = new Set() } = opts || {};
        const q = [...new Set(tokens(text))];
        if (!q.length) return [];
        const need = Math.min(minTerms, q.length);
        const hits = new Map();
        for (const t of q) for (const id of this.index.get(t) || []) hits.set(id, (hits.get(id) || 0) + 1);
        return [...hits].filter(([id, c]) => c >= need && !exclude.has(id))
            .sort((a, b) => b[1] - a[1] || b[0] - a[0]).slice(0, k)
            .map(([id, c]) => ({ ...this._pub(this.byId.get(id)), matchedTerms: c, basis: 'related' }));
    }
}

// ─────────────────────────────────────────────────────────────────────────
// L2  LOG — what Jarvis decided, and what she did about it
// ─────────────────────────────────────────────────────────────────────────
class Log {
    constructor(file, clock) {
        this.file = file; this.clock = clock;
        this.events = new Map();   // id -> { key, at }
        this.byKey = new Map();    // key -> [ outcome rows ] in order
        this.recentByKey = new Map();
        this.nextId = 1;
        const { rows, bad } = readAll(file);
        this.badLines = bad;
        for (const r of rows) this._apply(r);
    }
    _apply(r) {
        if (r.t === 'event') {
            this.events.set(r.id, { key: r.key, at: r.at, decisionType: r.decisionType, risk: r.risk, chatId: r.chatId });
            this.nextId = Math.max(this.nextId, r.id + 1);
            if (!this.recentByKey.has(r.key)) this.recentByKey.set(r.key, []);
            this.recentByKey.get(r.key).push(r.id);
        } else if (r.t === 'outcome') {
            const ev = this.events.get(r.eventId);
            if (!ev) return;
            if (!this.byKey.has(ev.key)) this.byKey.set(ev.key, []);
            this.byKey.get(ev.key).push({ eventId: r.eventId, outcome: r.outcome, at: r.at });
        }
    }
    /** Record a decision. Never throws; returns the event id or null. Carries no message text on purpose. */
    event(e) {
        try {
            if (!e || !e.key || !e.decisionType) return null;
            const row = { t: 'event', id: this.nextId, at: nowIso(this.clock), chatId: e.chatId == null ? null : String(e.chatId),
                decisionType: String(e.decisionType), key: String(e.key).trim().toLowerCase(),
                risk: e.risk || null, intent: e.intent || null,
                confidence: typeof e.confidence === 'number' ? e.confidence : null };
            append(this.file, row);
            this._apply(row);
            return row.id;
        } catch (_) { return null; }
    }
    /** Record what she did. Closed vocabulary. Never throws. */
    outcome(eventId, outcome, meta) {
        try {
            if (!OUTCOMES.has(outcome) || !this.events.has(eventId)) return false;
            const at = nowIso(this.clock);
            const row = { t: 'outcome', eventId, outcome, at,
                latencyMs: Date.parse(at) - Date.parse(this.events.get(eventId).at), meta: meta || null };
            append(this.file, row);
            this._apply(row);
            return true;
        } catch (_) { return false; }
    }
    /** total / approved / current clean streak for one decision key. */
    stats(key) {
        const rows = (this.byKey.get(String(key).trim().toLowerCase()) || []).filter((r) => COUNTED.has(r.outcome));
        let approved = 0, streak = 0;
        for (const r of rows) { if (r.outcome === 'approved') { approved++; streak++; } else streak = 0; }
        return { total: rows.length, approved, streak, last: rows.length ? rows[rows.length - 1].outcome : null };
    }
    recent(key, n = 5) {
        const ids = (this.recentByKey.get(String(key).trim().toLowerCase()) || []).slice(-n);
        return ids.map((id) => {
            const ev = this.events.get(id);
            const outs = (this.byKey.get(ev.key) || []).filter((o) => o.eventId === id);
            return { id, at: ev.at, decisionType: ev.decisionType, outcome: outs.length ? outs[outs.length - 1].outcome : null };
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────
// LINKS — what is connected to what (the graph)
// ─────────────────────────────────────────────────────────────────────────
class Links {
    constructor(file, clock) {
        this.file = file; this.clock = clock;
        this.edges = new Map();   // edge key -> { from, rel, to }
        this.adj = new Map();     // node key -> Set of edge keys
        const { rows, bad } = readAll(file);
        this.badLines = bad;
        for (const r of rows) this._apply(r);
    }
    _ek(from, rel, to) { return `${nodeKey(from)}|${rel}|${nodeKey(to)}`; }
    _apply(r) {
        const k = this._ek(r.from, r.rel, r.to);
        if (r.t === 'link') {
            this.edges.set(k, { from: r.from, rel: r.rel, to: r.to });
            for (const n of [r.from, r.to]) {
                if (!this.adj.has(nodeKey(n))) this.adj.set(nodeKey(n), new Set());
                this.adj.get(nodeKey(n)).add(k);
            }
        } else if (r.t === 'unlink') {
            this.edges.delete(k);
            for (const n of [r.from, r.to]) { const s = this.adj.get(nodeKey(n)); if (s) s.delete(k); }
        }
    }
    _write(t, { from, rel, to, by, role }) {
        if (!LINK_WRITERS.has(role) || !by) return { ok: false, reason: 'only manager/team/system may write links' };
        const f = normNode(from), tt = normNode(to), rl = slug(rel, '_');
        if (!f || !tt || !rl) return { ok: false, reason: 'from, rel and to are required' };
        const k = this._ek(f, rl, tt);
        if (t === 'link' && this.edges.has(k)) return { ok: true, existed: true };
        if (t === 'unlink' && !this.edges.has(k)) return { ok: true, existed: false };
        const row = { t, from: f, rel: rl, to: tt, by: String(by), role, at: nowIso(this.clock) };
        try { append(this.file, row); } catch (e) { return { ok: false, reason: `write failed: ${e.message}` }; }
        this._apply(row);
        return { ok: true };
    }
    add(args) { return this._write('link', args || {}); }
    remove(args) { return this._write('unlink', args || {}); }

    nodes() {
        const out = [];
        for (const e of this.edges.values()) out.push(e.from, e.to);
        return out;
    }
    /** Everything reachable within `depth` hops (either direction), with the path that got there. */
    neighbors(node, opts) {
        const { depth = 2, max = 50 } = opts || {};
        const start = normNode(node);
        if (!start) return [];
        const seen = new Set([nodeKey(start)]);
        let frontier = [{ node: start, via: [] }];
        const out = [];
        for (let d = 1; d <= depth && frontier.length && out.length < max; d++) {
            const next = [];
            for (const { node: cur, via } of frontier) {
                for (const ek of this.adj.get(nodeKey(cur)) || []) {
                    const e = this.edges.get(ek);
                    if (!e) continue;
                    const forward = nodeKey(e.from) === nodeKey(cur);
                    const other = forward ? e.to : e.from;
                    if (seen.has(nodeKey(other))) continue;
                    seen.add(nodeKey(other));
                    const step = forward ? `${nodeKey(cur)} -[${e.rel}]-> ${nodeKey(other)}` : `${nodeKey(cur)} <-[${e.rel}]- ${nodeKey(other)}`;
                    const entry = { node: other, depth: d, via: [...via, step] };
                    out.push(entry);
                    next.push(entry);
                    if (out.length >= max) return out;
                }
            }
            frontier = next;
        }
        return out;
    }
}

// ─────────────────────────────────────────────────────────────────────────
// A PARTITION — one company's whole disk
// ─────────────────────────────────────────────────────────────────────────
class Partition {
    constructor(disk, company) {
        this.company = company;
        this._disk = disk;
        this.dir = path.join(disk.dir, company);
        this._load();
    }
    _files() {
        return { facts: path.join(this.dir, 'facts.jsonl'), log: path.join(this.dir, 'log.jsonl'), links: path.join(this.dir, 'links.jsonl'), notes: path.join(this.dir, 'notes.jsonl') };
    }
    _load() {
        const f = this._files();
        this.facts = new Facts(f.facts, this._disk.clock);
        this.log = new Log(f.log, this._disk.clock);
        this.links = new Links(f.links, this._disk.clock);
        this.notes = new Notes(f.notes, this._disk.clock);   // her words, verbatim, findable by meaning (helpers/disk/notes.js)
    }
    /** Lines that could not be parsed at load. Non-zero means look at the files; it never blocks boot. */
    health() {
        return { company: this.company, badLines: { facts: this.facts.badLines, log: this.log.badLines, links: this.links.badLines, notes: this.notes.badLines } };
    }

    /** Read-only window onto a store that already exists. The adapter is handed the company first. */
    read(name, ...args) {
        const fn = this._disk.adapters.get(name);
        if (!fn) throw new Error(`no adapter registered: ${name}`);
        return fn(this.company, ...args);
    }

    /**
     * Ask one question across every layer. GraphQL-shaped: say what you are asking about and which
     * parts you want back.
     *
     *   query({
     *     about:   [{ type: 'container', id: 'abcu1234567' }],   // things, by name
     *     text:    'customer asks about payment reminder',        // and/or free text
     *     include: { facts: true, related: true,                  // what she taught
     *                links: { depth: 2 },                         // follow connections
     *                log: { key: 'pay_reminder', limit: 3 },      // decisions + record
     *                adapters: { trust: ['forward', 'bose'] } },   // existing stores, read-only
     *   })
     */
    query(args) {
        const { about = [], text = '', include = {} } = args || {};
        const inc = { facts: true, related: true, ...(include || {}) };
        const explicit = (about || []).map(normNode).filter(Boolean);
        const named = this.facts.resolve(text, this.links.nodes());
        const entities = new Map();
        for (const e of [...explicit, ...named.entities]) entities.set(nodeKey(e), { ...e, via: null });

        // Follow the graph: container -> booking -> customer.
        if (inc.links) {
            const depth = (inc.links && inc.links.depth) || 2;
            for (const e of [...entities.values()]) {
                for (const n of this.links.neighbors(e, { depth })) {
                    if (!entities.has(nodeKey(n.node))) entities.set(nodeKey(n.node), { ...n.node, via: n.via.join(' ; ') });
                }
            }
        }

        const out = { company: this.company, entities: [...entities.values()], ambiguous: named.ambiguous };
        const exact = inc.facts ? this.facts.recall([...entities.values()]).map((f) => {
            const e = entities.get(`${f.scopeType}:${f.scopeId}`);
            return { ...f, basis: 'exact', via: e && e.via ? e.via : null };
        }) : [];
        const related = inc.facts && inc.related && text
            ? this.facts.search(text, { exclude: new Set(exact.map((f) => f.id)) }) : [];
        out.facts = { exact, related };

        if (inc.log) {
            const key = inc.log.key;
            out.log = key ? { key, stats: this.log.stats(key), recent: this.log.recent(key, inc.log.limit || 5) } : null;
        }
        if (inc.adapters) {
            out.adapters = {};
            for (const [name, args] of Object.entries(inc.adapters)) {
                try { out.adapters[name] = this.read(name, ...(Array.isArray(args) ? args : [args])); }
                catch (e) { out.adapters[name] = { error: e.message }; }   // a broken adapter never takes the query down
            }
        }

        const val = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
        const line = (f, tag) => `- ${tag}[${f.scope}] ${f.name}: ${val(f.value)} (taught by ${f.taughtBy}, ${f.at.slice(0, 10)})${f.via ? `  via ${f.via}` : ''}`;
        out.brief = [...exact.map((f) => line(f, '')), ...related.map((f) => line(f, 'possibly relevant, not exact: '))].join('\n');
        return out;
    }

    // ── backup ───────────────────────────────────────────────────────────
    // helpers/backup.js collects only *.json under data/ and skips .jsonl, so
    // the append-only layers would never reach the nightly backup on their own.
    // This writes one atomic backup.json beside them, which its walker DOES pick
    // up, without touching backup.js. Wiring should call it on a schedule.
    snapshot() {
        const f = this._files();
        const snap = { format: 1, company: this.company, at: nowIso(this._disk.clock),
            facts: readAll(f.facts).rows, log: readAll(f.log).rows, links: readAll(f.links).rows,
            // notes travel as TEXT only: vectors are large and re-derivable (needsEmbedding() lists what to re-embed after a restore)
            notes: readAll(f.notes).rows.filter((r) => r.t !== 'vec').map((r) => (r.t === 'note' ? { ...r, vec: null, model: null } : r)) };
        const file = path.join(this.dir, 'backup.json');
        writeAtomic(file, JSON.stringify(snap));
        return { file, rows: snap.facts.length + snap.log.length + snap.links.length + snap.notes.length };
    }
    /** Rebuild an EMPTY partition from a snapshot. Refuses to overwrite anything. */
    restore(snap) {
        if (!snap || snap.format !== 1 || snap.company !== this.company) throw new Error('snapshot is not for this company/format');
        const f = this._files();
        for (const file of Object.values(f)) if (!isEmpty(file)) throw new Error('partition is not empty; refusing to overwrite');
        for (const [layer, file] of Object.entries(f)) {
            const rows = snap[layer] || [];   // a snapshot taken before notes existed has no notes layer
            writeAtomic(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
        }
        this._load();
        return true;
    }
}

// ─────────────────────────────────────────────────────────────────────────
// THE DISK
// ─────────────────────────────────────────────────────────────────────────
class Disk {
    constructor({ dir, companies = DEFAULT_COMPANIES, clock = () => new Date() } = {}) {
        if (!dir) throw new Error('disk needs a directory');
        this.dir = dir;
        this.companies = new Set(companies.map((c) => slug(c, '_')));
        this.clock = clock;
        this.adapters = new Map();
        this._parts = new Map();
    }
    /** Register a read-only window onto an existing store: fn(company, ...args) -> data. */
    registerAdapter(name, fn) {
        if (typeof fn !== 'function') throw new Error('adapter must be a function');
        this.adapters.set(name, fn);
    }
    /** The only way in. No company, or an unregistered one, is an error and not a default. */
    for(company) {
        const c = slug(company, '_');
        if (!c || !this.companies.has(c)) {
            throw new PartitionError(`unknown company "${company}"; registered: ${[...this.companies].join(', ')}`);
        }
        if (!this._parts.has(c)) this._parts.set(c, new Partition(this, c));
        return this._parts.get(c);
    }
}

function open(opts) { return new Disk(opts); }

module.exports = { open, Disk, PartitionError, DEFAULT_COMPANIES, FACT_TEACHERS, LINK_WRITERS, OUTCOMES };
