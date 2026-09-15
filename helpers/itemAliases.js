// ── helpers/itemAliases.js — "Al combo" and "Aluminium combo" are one metal ──
//
// Apsara, 2026-09-16, after a probe showed one pile of aluminium reported as
// two rows with one of them impossible:
//
//   "Warn me if al combo and aluminium combo,remember my selection-then next
//    time let ai decide based on knowldge"
//
// Three instructions in one sentence, and they are in a deliberate order:
// WARN first (do not guess), REMEMBER the answer, and only then let the model
// act on what it has been taught. This file is the middle one — the memory.
// helpers/itemMatch.js is the first and third.
//
// ── WHY THIS IS NOT JUST FUZZY MATCHING ─────────────────────────────────────
// The tempting version compares two strings, decides they are similar enough,
// and silently merges them. It is wrong here for a reason specific to this
// business: "Al 6061" and "Al 6063" are two alloys that differ by one
// character and sell for different money, while "Al combo" and "Aluminium
// combo" differ by seven and are the same pile. Similarity cannot tell those
// apart, and the cost of being wrong is a stock figure that is quietly false.
//
// So nothing is merged by resemblance. A pair is joined only because SHE said
// so, once, and the answer is kept. What resemblance is allowed to do is pick
// which question to ask.
//
// ── "DIFFERENT" IS AN ANSWER TOO, AND IT IS THE ONE THAT MATTERS ────────────
// Saying no has to be remembered as firmly as saying yes, or the app asks
// about the same two alloys every week until she stops reading the prompts —
// at which point the next prompt, the one that matters, gets clicked through
// too. A decision store that only records agreement is a nagging machine.
//
// ── GROUPS, NOT PAIRS ───────────────────────────────────────────────────────
// Say "Al combo" ≡ "Aluminium combo", then later "Aluminium combo" ≡ "ALUM
// COMBO". All three are one material and a report must treat them as one row,
// so the pairs are resolved into connected groups rather than consulted one at
// a time. Union-find, small and exact, over a list that will never be large.
//
// A "different" verdict does NOT split a group. It only prevents that pair
// being proposed again — because two names can both be the same as a third
// and it is not this file's job to referee a contradiction she created. What
// it does instead is report it, through conflicts(), so it can be shown.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

const FILE = () => cfg.ITEM_ALIASES_FILE;

// Case, spacing and punctuation are noise here — "AL-COMBO" and "al combo"
// are not a decision anyone should be asked to make. Matches the rule in
// helpers/nameMatch.js so one idea of "the same text" runs through the app.
function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// A pair is stored under a stable, order-independent key, so answering about
// (A, B) is also an answer about (B, A).
function pairKey(a, b) {
    const x = norm(a), y = norm(b);
    return x < y ? `${x}|${y}` : `${y}|${x}`;
}

const loadAliases = () => {
    const raw = loadJson(FILE(), []);
    return Array.isArray(raw) ? raw : [];
};

// Records her answer. `same: true` joins the two; `same: false` records that
// she was asked and said no, so it is never proposed again.
async function remember(a, b, same, meta = {}) {
    const A = String(a || '').trim(), B = String(b || '').trim();
    if (!norm(A) || !norm(B) || norm(A) === norm(B)) return null;
    const key = pairKey(A, B);
    let saved = null;
    await mutateJson(FILE(), [], (rows) => {
        const list = Array.isArray(rows) ? rows : [];
        const idx = list.findIndex((r) => r && r.key === key);
        saved = {
            key,
            // Both spellings are kept verbatim. The group's display name is
            // chosen later from what she actually uses; throwing away the
            // original text here would make that impossible.
            a: A, b: B,
            same: !!same,
            decided_at: new Date().toISOString(),
            decided_by: meta.by || null,
            // 'user' or 'ai'. Only a USER decision is ever treated as settled
            // — see settled() below. This is the line between a machine that
            // learns from her and one that learns from itself.
            source: meta.source === 'ai' ? 'ai' : 'user',
            note: meta.note || null,
        };
        if (idx === -1) list.unshift(saved); else list[idx] = saved;
        return list;
    });
    return saved;
}

// Has this exact pair already been decided BY HER? Only user decisions count,
// deliberately: if the model's own guesses were treated as settled, one wrong
// guess would become permanent truth with nobody ever asked.
function settled(a, b) {
    const key = pairKey(a, b);
    const hit = loadAliases().find((r) => r && r.key === key && r.source === 'user');
    return hit || null;
}

// Every description joined to `desc` by her yeses, including itself.
function groupOf(desc, rows) {
    const list = rows || loadAliases();
    const start = norm(desc);
    if (!start) return [];
    const adj = new Map();
    const add = (x, y) => {
        if (!adj.has(x)) adj.set(x, new Set());
        adj.get(x).add(y);
    };
    const names = new Map([[start, String(desc || '').trim()]]);
    for (const r of list) {
        if (!r || !r.same || r.source !== 'user') continue;
        const x = norm(r.a), y = norm(r.b);
        if (!x || !y) continue;
        add(x, y); add(y, x);
        if (!names.has(x)) names.set(x, r.a);
        if (!names.has(y)) names.set(y, r.b);
    }
    // Breadth-first over the joins. Small by nature — this is a list of
    // materials a scrap yard trades, not a graph problem.
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
        const cur = queue.shift();
        for (const next of (adj.get(cur) || [])) {
            if (seen.has(next)) continue;
            seen.add(next);
            queue.push(next);
        }
    }
    return [...seen].map((k) => names.get(k) || k);
}

// The key a report should group by. Every member of a group resolves to the
// same string, so two spellings become one row.
//
// The group's key is its alphabetically-first normalised member — chosen
// because it is STABLE. Picking "the most used" would make the key move as
// she records loads, and a grouping key that changes underneath a cached
// report is a bug that only shows up at month end.
function canonicalKey(desc, rows) {
    const group = groupOf(desc, rows);
    if (!group.length) return norm(desc);
    return group.map(norm).filter(Boolean).sort()[0];
}

// What to CALL the group on screen: the spelling used most in the records the
// caller passes in, falling back to the longest member so a made-up short
// form does not become the label. Display and grouping are different jobs —
// the lesson from the inventory rows that printed "al combo" beside
// "Al combo".
function displayName(desc, usedDescriptions, rows) {
    const group = groupOf(desc, rows);
    if (!group.length) return String(desc || '').trim();
    const members = new Set(group.map(norm));
    const counts = new Map();
    for (const raw of (usedDescriptions || [])) {
        const t = String(raw || '').trim();
        const k = norm(t);
        if (!k || !members.has(k)) continue;
        const cur = counts.get(t) || 0;
        counts.set(t, cur + 1);
    }
    if (counts.size) {
        return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    }
    return group.slice().sort((a, b) => b.length - a.length)[0];
}

// Pairs she has called the same AND called different — contradictions she
// created, which this file reports rather than silently resolving. Two names
// can both be joined to a third while she has said those two differ; refereeing
// that quietly would mean overruling her with arithmetic.
function conflicts() {
    const rows = loadAliases();
    const out = [];
    for (const r of rows) {
        if (!r || r.same || r.source !== 'user') continue;
        const g = groupOf(r.a, rows).map(norm);
        if (g.includes(norm(r.b))) out.push({ a: r.a, b: r.b, why: 'joined through another name' });
    }
    return out;
}

function list() { return loadAliases(); }

async function forget(a, b) {
    const key = pairKey(a, b);
    let removed = false;
    await mutateJson(FILE(), [], (rows) => {
        const l = Array.isArray(rows) ? rows : [];
        const i = l.findIndex((r) => r && r.key === key);
        if (i === -1) return l;
        l.splice(i, 1); removed = true;
        return l;
    });
    return removed;
}

module.exports = { norm, pairKey, remember, settled, groupOf, canonicalKey, displayName, conflicts, list, forget };
