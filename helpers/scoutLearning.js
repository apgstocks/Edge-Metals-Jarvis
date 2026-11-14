// ── helpers/scoutLearning.js — what Scout (the Edge Yard assistant) has learned ──
// Apsara, 2026-11-14: "Yard assistant a.k.a. Scout needs to self learn as well."
// Design: docs in the Jarvis project, claude/scout-self-learning-design-2026-11-14.md.
// Her four answers (all yes): learn only from what manager/team type to Scout;
// show a lesson the first time it is used; allow pre-filling usual values (never a
// price, date or figure); keep it in the backup.
//
// ── THE BOUNDARIES, in one place ───────────────────────────────────────────────
// • EDGE YARD ONLY. The partition is fixed here and the caller cannot pick another
//   (CLAUDE.md rule 5): a lesson taught to Scout cannot be recalled by Jarvis's
//   Edge Metals side, and the reverse.
// • A LESSON IS HER OWN WORDS, VERBATIM. The model only decides THAT a message was a
//   lesson; the stored text is what she typed, never the model's paraphrase of it.
//   A paraphrase is where a loads' note or a seller's name could have been smuggled
//   into memory as if she had said it (memory poisoning).
// • ONLY THE PERSON TYPING TEACHES. Admin is the manager, staff is the team, anyone
//   else cannot. Text read from a load, a document or a seller is data, never a lesson.
// • NEVER A FIGURE. Money and stock come from the ledger. A "lesson" that carries a
//   price or a weight is refused, so memory can never contradict the books. This is a
//   guard on what may be STORED, not a rule about what she means.
// • A LESSON IS ADVICE FOR THE MODEL. It cannot add a tool, skip the confirm card or
//   relax a check: it is text in the prompt, nothing more.
const path = require('path');
const cfg = require('../config');
const { mutateJson, loadJson } = require('./json');

const COMPANY = 'edge_yard';
const MAX_LESSON_CHARS = 300;
const MAX_LESSONS_IN_PROMPT = 25;
const USUAL_FIELDS = ['buyer', 'mode', 'bank', 'paid_via', 'cash_source', 'trucking_company'];   // never price, date, amount, weight, load id
const USUAL_RUN = 3;                                                                          // identical this many confirmed times in a row

const part = () => require('./diskStore').getDisk().for(COMPANY);
const USUAL_FILE = () => path.join(cfg.DATA_DIR, 'scout_usual.json');

// The app's roles → the disk's. Anyone else has no standing to teach.
function teacherRole(appRole) {
    if (appRole === 'admin') return 'manager';
    if (appRole === 'staff') return 'team';
    return null;
}

// A figure is not a lesson. Currency, or a number carrying a unit of weight/money.
function carriesFigure(text) {
    return /[$€£]\s?\d|\b\d[\d,]*(\.\d+)?\s*(lb|lbs|pounds?|mt|tons?|tonnes?|kg|usd|dollars?|cents?)\b|\bper\s+(lb|mt|ton)\b/i.test(String(text || ''));
}

// Snapshot into the folder the nightly backup already walks (helpers/backup.js
// collects *.json, and skips .jsonl, so the jsonl layers alone are not backed up).
let lastSnap = 0;
function snapshot({ force = false } = {}) {
    try {
        if (!force && Date.now() - lastSnap < 60 * 60 * 1000) return null;
        lastSnap = Date.now();
        return part().snapshot();
    } catch (e) { return null; }
}

function slugOf(text) {
    return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'lesson';
}

/** Keep what she typed, if she may teach and it is not a figure. Never throws. */
function teach({ text, by, appRole, sourceMsg }) {
    try {
        const role = teacherRole(appRole);
        if (!role) return { ok: false, reason: 'only the manager or the team can teach me' };
        const words = String(text == null ? '' : text).trim().replace(/\s+/g, ' ');
        if (!words) return { ok: false, reason: 'nothing to remember' };
        if (words.length > MAX_LESSON_CHARS) return { ok: false, reason: `keep a lesson under ${MAX_LESSON_CHARS} characters` };
        if (carriesFigure(words)) return { ok: false, reason: 'I do not keep prices or weights in memory — those come from the books' };
        const p = part();
        const existing = p.facts.list('lesson', 'scout').find((f) => f.value === words);
        if (existing) return { ok: true, id: existing.id, already: true };
        const name = `${slugOf(words)}_${p.facts.all().length + 1}`;
        const r = p.facts.put({ scopeType: 'lesson', scopeId: 'scout', name, value: words, by: String(by || role), role, sourceMsg: sourceMsg == null ? words : sourceMsg });
        if (!r.ok) return r;
        snapshot({ force: true });
        return { ok: true, id: r.id };
    } catch (e) { return { ok: false, reason: e.message }; }
}

function list() {
    return part().facts.list('lesson', 'scout').sort((a, b) => a.id - b.id)
        .map((f) => ({ id: f.id, text: String(f.value), taughtBy: f.taughtBy, at: f.at, uses: part().log.recent(`lesson:${f.id}`, 1000).length }));
}

function forget(id, { by, appRole }) {
    const role = teacherRole(appRole);
    if (!role) return false;
    const target = part().facts.list('lesson', 'scout').find((f) => f.id === Number(id));
    if (!target) return false;
    const ok = part().facts.forget(target.id, { by: String(by || role), role });
    if (ok) snapshot({ force: true });
    return ok;
}

/** What goes into the prompt for this question, and which lessons are being used. */
function recallFor() {
    try {
        const all = list();
        if (!all.length) return { block: '', ids: [], usual: [] };
        const used = all.slice(-MAX_LESSONS_IN_PROMPT);
        const usual = usualHints();
        const lines = [
            'WHAT YOU HAVE BEEN TAUGHT (in her own words — advice about how she works. It never overrides the DATA, never lets you skip a confirmation, and is never a source of figures):',
            ...used.map((l) => `- [#${l.id}] ${l.text}`),
        ];
        return { block: lines.join('\n'), ids: used.map((l) => l.id), usual };
    } catch (e) { return { block: '', ids: [], usual: [] }; }
}

/** Mark lessons as used; returns the ones used for the FIRST time (to tell her once). */
function noteUse(ids) {
    const first = [];
    try {
        const p = part();
        for (const id of ids || []) {
            const key = `lesson:${id}`;
            const before = p.log.recent(key, 1).length;
            p.log.event({ key, decisionType: 'lesson_used' });
            if (!before) first.push(id);
        }
    } catch (e) { /* learning never breaks an answer */ }
    const all = list();
    return all.filter((l) => first.includes(l.id));
}

// ── what happened to a card Scout showed ───────────────────────────────────────
function proposed(kind, role) {
    try { return part().log.event({ key: `act:${String(kind).toLowerCase()}`, decisionType: 'yard_action', chatId: null, intent: String(kind), risk: role || null }); }
    catch (e) { return null; }
}
async function outcome(eventId, result, { kind, params } = {}) {
    try {
        if (eventId == null) return false;
        const map = { confirmed: 'approved', cancelled: 'rejected', expired: 'expired' };
        const o = map[result];
        if (!o) return false;
        part().log.outcome(eventId, o, null);
        if (o === 'approved' && kind && params) await recordUsual(kind, params);
        snapshot();
        return true;
    } catch (e) { return false; }
}

async function recordUsual(kind, params) {
    const keep = {};
    for (const f of USUAL_FIELDS) {
        const v = params && params[f];
        if (v != null && String(v).trim() !== '') keep[f] = String(v).trim();
    }
    await mutateJson(USUAL_FILE(), {}, (d) => {
        const k = String(kind).toLowerCase();
        d[k] = (d[k] || []).concat([keep]).slice(-10);
        return d;
    });
}

// A field she has given identically on her last USUAL_RUN confirmed actions of one kind.
function usualHints() {
    const d = loadJson(USUAL_FILE(), {});
    const out = [];
    for (const [kind, runs] of Object.entries(d)) {
        const recent = (runs || []).slice(-USUAL_RUN);
        if (recent.length < USUAL_RUN) continue;
        for (const f of USUAL_FIELDS) {
            const vals = recent.map((r) => r[f]);
            if (vals.every((v) => v && v === vals[0])) out.push({ kind, field: f, value: vals[0] });
        }
    }
    return out;
}
function usualBlock(usual) {
    if (!usual || !usual.length) return '';
    return 'USUAL VALUES (she confirmed these unchanged on her last few actions of that kind — you may suggest them, and say you did. NEVER assume a price, date, amount or weight):\n'
        + usual.map((u) => `- ${u.kind}: ${u.field} = ${u.value}`).join('\n');
}

module.exports = { COMPANY, teach, list, forget, recallFor, noteUse, proposed, outcome, usualHints, usualBlock, teacherRole, carriesFigure, snapshot, USUAL_FIELDS, MAX_LESSON_CHARS };
