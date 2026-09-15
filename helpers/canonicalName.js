// ── helpers/canonicalName.js — one counterparty, one spelling ────────────────
// Apsara, 2026-09-16: "Sellers name/bUyers name-make it case insensitive".
//
// Two different jobs hide inside that sentence, and conflating them is how
// this kind of fix goes wrong:
//
//   GROUPING   "Ramesh" and "ramesh" are the same seller, so the Inventory
//              tab's per-seller totals must be ONE row, not two. Nothing
//              about the stored data needs to change for this — it is a
//              question of which key the report groups on.
//
//   DISPLAY    Having grouped them, the row still has to be labelled
//              something, and the lower-cased key is the wrong answer: it
//              prints "ramesh" beside properly-cased rows. That exact
//              mistake was found in the Inventory tab the day before this
//              file was written, on sold-only item rows.
//
//   STORAGE    Separately: the LOAD records still hold whatever was typed,
//              so two tickets for the same man carry two spellings of his
//              name. Grouping does not fix a printed ticket.
//
// This file does the third. The first two are handled where the reports are
// built (helpers/loads.js bySeller, helpers/outboundLoads.js byBuyer).
//
// ── WHY SNAP TO AN EXISTING SPELLING, RATHER THAN TITLE-CASE ────────────────
// The obvious move is to capitalise names on the way in. It is also wrong:
// "MK Metal Trading", "d.c. scrap", "JB's" — real company names are not
// title-cased, and a rule that rewrites them is a rule that has to be
// fought. So nothing is invented here. If the typed name already exists in
// her records under a different case, the spelling SHE established wins; if
// it is new, it is stored exactly as typed and becomes the established one.
//
// This is the same rule helpers/vendorFromText.js already applies to expense
// vendors, for the reason stated there: "so the vendor column does not grow
// 'santiago' beside 'Santiago'".
//
// ── WHICH SPELLING WINS ─────────────────────────────────────────────────────
// The most frequently used one, ties broken by whichever the caller lists
// first (both stores keep newest first, so a tie goes to the most recent).
// Not "the oldest", which would let a single early all-caps typo brand a
// supplier for ever; not "the newest", which would make the name flap about
// with every entry. Frequency is the closest thing to what she actually
// uses, and it self-heals: correct it a few times and the correction wins.

// Case- and punctuation-insensitive, matching helpers/nameMatch.js's rule so
// "MK Metal" and "mkmetal" are one company here too. Required, because a name
// differing only in a full stop is the same complaint one keystroke over.
const { normalizeName } = require('./nameMatch');

// Builds spelling -> count from a list of names, newest first.
function tally(names) {
    const counts = new Map();
    (names || []).forEach((raw, i) => {
        const name = String(raw == null ? '' : raw).trim();
        if (!name) return;
        const k = normalizeName(name);
        if (!k) return;
        const bucket = counts.get(k) || new Map();
        const cur = bucket.get(name) || { n: 0, first: i };
        cur.n += 1;
        bucket.set(name, cur);
        counts.set(k, bucket);
    });
    return counts;
}

// The established spelling for `typed`, or `typed` itself (trimmed) when it
// is new. Never returns a name that does not appear in `names` unless it is
// the typed one — nothing is invented.
function canonicalName(names, typed) {
    const name = String(typed == null ? '' : typed).trim();
    if (!name) return name;
    const k = normalizeName(name);
    if (!k) return name;                 // punctuation-only: leave it alone
    const bucket = tally(names).get(k);
    if (!bucket || !bucket.size) return name;

    let best = null;
    for (const [spelling, meta] of bucket) {
        if (!best) { best = { spelling, ...meta }; continue; }
        // More uses wins; equal uses, the earlier position in the list wins
        // (callers pass newest first, so that is the most recent spelling).
        if (meta.n > best.n || (meta.n === best.n && meta.first < best.first)) {
            best = { spelling, ...meta };
        }
    }
    return best ? best.spelling : name;
}

// Groups rows by a name, case- and punctuation-insensitively, and labels each
// group with the spelling used most. Returns a Map of key -> { label, rows }.
//
// Used by the per-seller and per-buyer reports. Written once because the two
// were identical code with one word changed, and a fix applied to one of them
// only is how half a bug survives.
function groupByName(rows, getName, fallbackLabel) {
    const out = new Map();
    (rows || []).forEach((row, i) => {
        const raw = String(getName(row) == null ? '' : getName(row)).trim();
        const k = raw ? normalizeName(raw) : '';
        // A blank name is its own bucket and keeps the caller's label for it
        // ("Unknown seller"); it is not merged into whatever sorts first.
        const key = k || '~blank';
        const cur = out.get(key) || { label: raw || fallbackLabel, spellings: new Map(), rows: [] };
        if (raw) {
            const s = cur.spellings.get(raw) || { n: 0, first: i };
            s.n += 1;
            cur.spellings.set(raw, s);
        }
        cur.rows.push(row);
        out.set(key, cur);
    });
    // Label each group with its most-used spelling, now that every row is in.
    for (const g of out.values()) {
        let best = null;
        for (const [spelling, meta] of g.spellings) {
            if (!best || meta.n > best.n || (meta.n === best.n && meta.first < best.first)) {
                best = { spelling, ...meta };
            }
        }
        if (best) g.label = best.spelling;
        delete g.spellings;
    }
    return out;
}

module.exports = { canonicalName, groupByName, normalizeName };
