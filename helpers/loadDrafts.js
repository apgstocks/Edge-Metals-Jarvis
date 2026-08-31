// ── helpers/loadDrafts.js — unfinished loads, saved server-side ────────────
//
// Per Apsara 2026-08-28: "draft needs to be saved and can be edited later."
//
// An earlier version kept drafts in the browser's localStorage. That answered
// "don't lose my typing" but not what was actually asked: a draft you can come
// back to has to survive a different browser, a different device, a phone that
// died, and someone else picking the load up. So it lives on the server.
//
// DELIBERATELY ITS OWN STORE, not a `draft: true` flag on loads.json. See the
// note on LOAD_DRAFTS_FILE in config.js: a flag would leave half-finished
// loads one forgotten filter away from the day's totals, the yard report, the
// inventory netting and the seller statements. Nothing that reads loads.json
// can see a draft, because a draft is not in there. That is a structural
// guarantee rather than a discipline that has to be remembered at every call
// site — and this file has already been bitten once by "an object slipped
// through a truthiness guard", so structure beats discipline.
//
// A draft is DELETED when the real load is saved, never converted. Conversion
// would mean a record that is a draft and a load at the same moment, which is
// exactly the ambiguity this design avoids.
//
// NO VALIDATION. That is the point of a draft — it is allowed to be
// incomplete, contradictory, and missing required fields. Validation happens
// when it becomes a real load, in helpers/loads.js, which is unchanged.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

// Drafts carry photos as base64, because a draft that loses the weight photos
// has lost the expensive part of the work — re-typing a description is quick,
// re-weighing a truck is not. Cap the file so a forgotten draft with a dozen
// photographed items cannot grow without limit; oldest goes first.
const MAX_DRAFTS = 25;

const listDrafts = () => {
    const raw = loadJson(cfg.LOAD_DRAFTS_FILE, []);
    return Array.isArray(raw) ? raw : [];
};

const getDraft = (id) => listDrafts().find((d) => d.id === id) || null;

function newDraftId() {
    return `DRAFT_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Upsert. A client autosaving every few seconds must not create a new record
// each time, so an id round-trips: the first save allocates one, and every
// save after that reuses it.
async function saveDraft(input = {}) {
    const now = new Date().toISOString();
    const id = input.id && String(input.id).startsWith('DRAFT_') ? String(input.id) : newDraftId();
    const record = {
        id,
        kind: input.kind === 'sale' ? 'sale' : 'purchase',
        date: input.date || null,
        seller: input.seller || null,
        seller_address: input.seller_address || null,
        seller_phone: input.seller_phone || null,
        description: input.description || '',
        weight_unit: input.weight_unit || 'lb',
        items: Array.isArray(input.items) ? input.items : [],
        created_at: input.created_at || now,
        updated_at: now,
        created_by: input.created_by || null,
    };
    await mutateJson(cfg.LOAD_DRAFTS_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        const i = list.findIndex((d) => d.id === id);
        if (i >= 0) {
            // created_at belongs to the draft, not to this save — keep the
            // original so "started at 09:12" stays true across autosaves.
            record.created_at = list[i].created_at || record.created_at;
            list[i] = record;
        } else {
            list.push(record);
        }
        // Newest first, so the trim below drops the stalest.
        list.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
        return list.slice(0, MAX_DRAFTS);
    });
    return record;
}

async function deleteDraft(id) {
    let removed = false;
    await mutateJson(cfg.LOAD_DRAFTS_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        const next = list.filter((d) => d.id !== id);
        removed = next.length !== list.length;
        return next;
    });
    return removed;
}

// A draft is worth keeping only once there is something in it worth losing.
// Matches the client's rule so the two cannot disagree about when a draft
// exists — the server is the one that decides, and the client asks.
function isWorthSaving(input = {}) {
    const items = Array.isArray(input.items) ? input.items : [];
    const filled = items.filter((it) => it && (
        String(it.description || '').trim()
        || Number(it.gross_weight) || Number(it.tare_weight) || Number(it.net_weight)
    ));
    // ONE item, not two. Apsara 2026-08-29: "as soon user starts typing 1
    // item, it needs to auto save."
    //
    // The original two-item rule was there to stop a form someone merely
    // opened and tapped from becoming a draft. That job is already done by
    // itemHasContent(): a row only counts once it carries a description or a
    // weight, so an untouched blank row still saves nothing. Requiring a SECOND
    // row on top of that was protecting against a case that cannot happen, at
    // the cost of losing the first item if the phone died or the app was
    // closed — which in a yard is the whole reason drafts exist.
    return filled.length >= 1;
}

module.exports = { listDrafts, getDraft, saveDraft, deleteDraft, isWorthSaving, MAX_DRAFTS };
