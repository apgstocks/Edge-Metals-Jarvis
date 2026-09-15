// ── helpers/itemSpelling.js — one metal, one spelling ───────────────────────
//
// Apsara, 2026-09-16: "also in item description-say if i saved description say
// HMS and when i type ike hms in small,it i considering that as a new item."
//
// ── WHAT THIS IS AND IS NOT ─────────────────────────────────────────────────
// This is CASE ONLY. "HMS" and "hms" are the same word typed differently and
// nobody has to be asked about that.
//
// It is emphatically NOT the alias feature. "Al combo" and "Aluminium combo"
// are different words that MIGHT mean the same metal, and "Al 6061" and
// "Al 6063" differ by one character and are different alloys worth different
// money. Deciding those needs her, which is what helpers/itemAliases.js and
// the warn-then-remember flow exist for. Nothing here joins two spellings that
// differ by anything but capitals — a resemblance test in this file would
// silently merge two alloys and put a wrong number on a report.
//
// ── WHY ON THE WAY IN, RATHER THAN ON EVERY SCREEN ──────────────────────────
// The readers were already careful: groupItemsByDescription keys on lowercase,
// stockGuard falls back to lowercase, itemTypes refuses a case-duplicate. So
// the TOTALS were right. What was wrong is everything that shows a name — the
// type-ahead offering to add a description that already exists, a report
// headed "hms" the week after she typed "HMS", a BOL line in the wrong case.
//
// Fixing that on each screen means finding every screen, and missing one is
// the normal outcome. Normalising once, where the load is written, means every
// reader — including any written later — sees the spelling she chose.
//
// The stored list of item types is the authority on spelling. It is what she
// curates on the Item types screen, so it is where "how this is written" is
// actually decided.

// Returns the spelling already on file for this description, or the text as
// typed when it is genuinely new.
//
// `known` is injected rather than read here so tests can drive it without a
// data directory, and so a caller that already has the list does not re-read
// the file per item on a twenty-line load.
function canonicalSpelling(typed, known) {
    const clean = String(typed == null ? '' : typed).trim();
    if (!clean) return clean;
    const want = clean.toLowerCase();
    for (const k of (known || [])) {
        // Trimmed on BOTH sides: a stored type with a trailing space would
        // otherwise never match anything she types, and the mismatch would
        // look like this fix simply not working.
        if (String(k == null ? '' : k).trim().toLowerCase() === want) return String(k).trim();
    }
    return clean;
}

// Applies it across a load's items. Returns a NEW list; the caller's array is
// left alone, because these helpers are called from inside mutateJson mutators
// where a surprise in-place edit is very hard to trace.
function canonicaliseItems(items, known) {
    if (!Array.isArray(items)) return items;
    return items.map((it) => {
        if (!it || typeof it !== 'object') return it;
        const fixed = canonicalSpelling(it.description, known);
        return fixed === it.description ? it : { ...it, description: fixed };
    });
}

// Convenience for callers that do not already hold the list. Fail-soft: if the
// item types cannot be read, the description is stored exactly as typed. That
// is the OLD behaviour, which is merely untidy — refusing to save a load
// because a spelling list is unreadable would be far worse.
function knownSpellings() {
    try {
        const { loadCustomItemTypes } = require('./itemTypes');
        const list = loadCustomItemTypes();
        return Array.isArray(list) ? list : [];
    } catch (e) {
        console.error('[itemSpelling] item types unreadable, keeping descriptions as typed:', e.message);
        return [];
    }
}

module.exports = { canonicalSpelling, canonicaliseItems, knownSpellings };
