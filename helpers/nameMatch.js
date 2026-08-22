// ── helpers/nameMatch.js — space/punctuation-tolerant name matching ──────────
//
// WHY THIS EXISTS
//
// Apsara, 2026-08-22, correcting a rule I had defended:
//   me:  "that rule stopped the AI mangling 'mkmetaltrading' into
//         'mk metal trading'"
//   her: "But it is mk metal trading only."
//
// She is right, and the original diagnosis was wrong. The company really is
// MK Metal Trading. The AI expanding "mkmetaltrading" into "mk metal trading"
// was not mangling anything — it was reading the name correctly, the way any
// person would. The lookup then failed and the AI got blamed for it.
//
// The actual defect was here, in matching. Every name lookup in this codebase
// — contacts, address book, truckers, suppliers — compared strings that were
// lowercased but NOT stripped of spacing:
//
//     'mkmetaltrading'.includes('mk metal trading')   // false
//     'mk metal trading'.includes('mkmetaltrading')   // false
//
// So the two spellings of one real company could never match, in either
// direction. The "fix" applied at the time was to forbid the AI from ever
// normalizing a compressed name — which papered over a search bug by
// permanently making the classifier dumber, and left the reverse case (she
// types the name WITH spaces, it is stored without) broken anyway.
//
// This is the fix at the layer that was actually broken.
//
// DESIGN — PURELY ADDITIVE, ZERO BEHAVIOUR CHANGE ON EXISTING MATCHES
//
// normalizeName() collapses a name to comparable form: lowercase, and every
// non-alphanumeric character removed. "MK Metal Trading", "mkmetaltrading",
// "M.K. Metal-Trading" and "mk  metal  trading" all become "mkmetaltrading".
//
// Callers must run this ONLY as a last resort, after exact and substring
// matching have both come back empty. That ordering matters: it means every
// lookup that works today keeps returning exactly what it returns today,
// and this can only ever turn a "not found" into a find. Nothing that
// currently resolves can be re-pointed at a different record by this change.
//
// DELIBERATELY NOT FUZZY
//
// No edit distance, no similarity score, no Levenshtein, no Fuse.js. Those
// match things that are merely SIMILAR, and in this business a near-miss
// resolves to the wrong company and a real quote request or email goes to
// them. Normalization is exact matching with formatting noise removed — the
// compared strings must still be character-for-character identical once the
// spaces and punctuation are gone. "NTG" will never match "NTG Freight" here;
// only the substring tier (already present, unchanged) can do that.

// Collapse a name to its comparable form. Returns '' for empty/invalid input,
// which callers must treat as "no match possible" rather than as a wildcard —
// an empty normalized query would otherwise match every record.
function normalizeName(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Find records whose name matches `query` once spacing and punctuation are
// ignored. `getName` extracts the comparable string from a record; it
// defaults to `r.name`, which suits contacts/truckers/suppliers.
//
// Returns [] when the query normalizes to empty, so an all-punctuation or
// blank query can never sweep up the entire roster.
function findByNormalizedName(records, query, getName = (r) => r.name) {
    const q = normalizeName(query);
    if (!q) return [];
    return (records || []).filter((r) => normalizeName(getName(r)) === q);
}

// Address-book variant: an entry carries several aliases and matches if ANY
// of them normalizes to the query.
function findByNormalizedAlias(entries, query, getAliases = (e) => e.aliases) {
    const q = normalizeName(query);
    if (!q) return [];
    return (entries || []).filter((e) =>
        (getAliases(e) || []).some((a) => normalizeName(a) === q));
}

module.exports = { normalizeName, findByNormalizedName, findByNormalizedAlias };
