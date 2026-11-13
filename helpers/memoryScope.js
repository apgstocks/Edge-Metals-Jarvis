'use strict';
// helpers/memoryScope.js — LAYER 0 of Jarvis memory: who may hear what.
// Apsara, 2026-11-13: "mimic the human brain". A person never repeats what one
// supplier told them to another supplier, however similar the question sounds:
// remembering is one thing, knowing who may hear it is another, and the second
// is part of the memory. Without it the cross-chat recall (searchSimilar over
// ALL chats, no filter) could surface one trucker's or supplier's conversation
// in a different party's prompt.
//
// Rule (kept deliberately small, applied to what comes BACK from the search):
//   - the manager recalls across every chat (that is the point of the feature);
//   - everyone else recalls only conversations from their OWN chat;
//   - business-wide facts (type 'fact') are unchanged: they already reach every
//     role through the pinned/recent facts list;
//   - any other kind of memory is withheld from non-managers (fail closed).
// Pure and read-only: it removes matches, never changes or adds one.
// Read-time only. The stronger form is to LABEL each memory at write time with
// who it came from; that needs two nullable columns in Supabase and is the
// next layer (docs/OWNERSHIP-PLAN.md §8f).
function canSee(match, viewer) {
    const v = viewer || {};
    if (v.role === 'manager') return true;
    if (!match) return false;
    if (match.type === 'fact') return true;
    if (match.type === 'session_summary') return !!match.chatId && !!v.chatId && String(match.chatId) === String(v.chatId);
    return false;
}
function filter(matches, viewer) {
    return (Array.isArray(matches) ? matches : []).filter((m) => canSee(m, viewer));
}
module.exports = { canSee, filter };
