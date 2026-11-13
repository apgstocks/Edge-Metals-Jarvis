// ── helpers/neverCc.js — addresses that must never be Cc'd or Bcc'd ──────────
// Apsara, 2026-11-13: "Except yard report, i dont want any mail to be cc-ed to
// Bose." (Earlier, 2026-10-26: removed from the 07:50 digest; the yard report
// keeps him — he is a TO recipient there, which this does not touch.)
//
// Applied at the one place every email leaves (helpers/gmail.js sendEmail) and
// again where drafts build their Cc line, so the preview she confirms shows
// what will actually go. Only Cc and Bcc are filtered: a mail addressed TO him
// (the yard report) is unaffected.
//
// The list is a default, overridable in settings (`never_cc`, comma-separated),
// so adding someone is a settings change and not a code change.
const DEFAULT = ['bose@edgemetals.com'];

function list() {
    let extra = '';
    try { extra = String((require('../config').getSettings() || {}).never_cc || ''); } catch (e) { /* defaults */ }
    const set = new Set(DEFAULT);
    extra.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).forEach((a) => set.add(a));
    return set;
}

const bare = (s) => { const m = /<([^>]+)>/.exec(s); return String(m ? m[1] : s).trim().toLowerCase(); };

// Accepts a comma string or an array; returns the same shape without the
// blocked addresses ('' / [] / null stay as they were).
function strip(value) {
    if (!value) return value;
    const block = list();
    const keep = (a) => !block.has(bare(a));
    if (Array.isArray(value)) return value.some((a) => !keep(a)) ? value.filter(keep) : value;
    // Untouched when nothing is blocked: callers compare/print the original text.
    if (String(value).split(',').every((a) => !a.trim() || keep(a))) return value;
    return String(value).split(',').map((s) => s.trim()).filter(Boolean).filter(keep).join(', ');
}

module.exports = { strip, list, DEFAULT };
