// ── helpers/pickups.js — the record that did not exist ───────────────────
// Apsara, 2026-11-06: "if i book a shipment pickup with a logistics company,
// say pickup arranged @11/05 say on that particular day,it should follow up
// with the logistic company about the pickup eta na?"
//
// It could not, because there was nothing to follow up ON. Before this file
// `pickup_date` lived in exactly two places — a box typed onto a BOL, and a
// column in the AJ Transport invoice log — and both are fields on a document,
// written once and read by a printer. This is the first time Jarvis holds a
// pickup as a live arrangement with a state.
//
// ── TWO WAYS IN, BECAUSE SHE ASKED FOR BOTH ──────────────────────────────
// Asked how a pickup should reach Jarvis she chose BOTH "Jarvis arranges it"
// and "I record it". So `source` is recorded on every row, and nothing in
// here cares which it was: the agent chases a pickup she typed exactly as
// hard as one Jarvis booked. A record that behaved differently depending on
// who made it would be two features wearing one name.
//
// ── WHAT THIS FILE WILL NOT DO ───────────────────────────────────────────
// It sends nothing and decides nothing. helpers/pickupAgent.js decides,
// helpers/followUpAgentJob.js sends, this remembers. Three files because the
// deciding has to be testable without a mailbox — the helpers/bankMatch.js
// rule, and the reason the claims engine could be trusted with money.
const path = require('path');
const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

const FILE = () => cfg.PICKUPS_FILE || path.join(cfg.DATA_DIR, 'pickups.json');

const str = (v) => String(v == null ? '' : v).trim();
const now = () => new Date().toISOString();

// Statuses. 'arranged' is the only one the agent chases; the rest are ends.
// Kept as a list rather than a free string so a typo cannot create a status
// that silently never gets chased — the silent skip is the whole complaint.
const STATUSES = ['arranged', 'collected', 'done', 'cancelled'];

function list() {
    const all = loadJson(FILE(), []);
    return Array.isArray(all) ? all : [];
}

const get = (id) => list().find((p) => p && p.id === str(id)) || null;

// ── create ───────────────────────────────────────────────────────────────
// `company` and `pickup_date` are the only things required, because they are
// the only two the agent cannot work without: who to ask, and when it
// matters. Everything else is nice to have and its absence is REPORTED
// later rather than refused here — a pickup rejected at the door for a
// missing phone number is a pickup that goes unwatched entirely, which is
// worse than one chased by email alone.
async function create(input = {}, by = 'jarvis') {
    const company = str(input.company);
    const date = str(input.pickup_date);
    if (!company) throw new Error('a pickup needs the logistics company — there is nobody to ask otherwise');
    if (!date) throw new Error('a pickup needs the date it is arranged for — there is no day to chase on otherwise');

    const status = STATUSES.includes(str(input.status)) ? str(input.status) : 'arranged';

    // ── WHAT JARVIS ALREADY KNOWS ABOUT THIS CARRIER ─────────────────────
    // Apsara, 2026-11-06: "i cant custom train as per buyer.it should learn
    // and adapt".
    //
    // She records "pickup with Zimex Friday" and nothing else. If Zimex has
    // written to Jarvis before, the address is already on file and this
    // pickup is chaseable instead of landing on the unreachable list. She
    // never types a contact twice, and there is no per-carrier settings page
    // for her to not fill in.
    //
    // ONLY fills what is missing. Anything she typed wins — the learned
    // value is last year's dispatcher, hers is today's.
    let learned = {};
    try { learned = require('./pickupLearn').contactsFor(company) || {}; } catch (e) { /* learning is optional */ }
    const email = str(input.contact_email) || str(learned.contact_email);
    const whatsapp = str(input.contact_whatsapp) || str(learned.contact_whatsapp);
    const rec = {
        id: 'pk_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
        company,
        pickup_date: date,
        pickup_window: str(input.pickup_window) || '',
        container_no: str(input.container_no).toUpperCase(),
        booking_no: str(input.booking_no),
        location: str(input.location),
        contact_email: email,
        contact_whatsapp: whatsapp,
        // Visible, because a contact she did not type is a thing she is
        // entitled to see before Jarvis mails it.
        contacts_learned: (!str(input.contact_email) && !!email)
            || (!str(input.contact_whatsapp) && !!whatsapp),
        status,
        // Where it came from — the ACTUAL caller, not a two-way label.
        // This first collapsed everything that was not Jarvis into
        // 'recorded', which threw away the one thing the field is for: a
        // pickup spoken to the bot and one typed on the screen look
        // identical afterwards, and when one of the two paths starts
        // dropping pickups there is nothing to count. The voice path is the
        // caller CLAUDE.md records breaking twice, so it is the one most
        // worth being able to see.
        //
        // Still never branched on: the agent chases a spoken pickup exactly
        // as hard as a typed one.
        source: str(input.source) || str(by) || 'recorded',
        created_at: now(),
        created_by: str(by),
        // Filled in when the company answers. Either one stops the chasing —
        // see pickupAgent: a question that has been answered is not asked
        // again.
        eta: '',
        confirmed_at: '',
        // The thread Jarvis is waiting on a reply to, so the existing
        // workflow/emailReplyWatch.js machinery can close this without a
        // second poller being written.
        thread_id: str(input.thread_id),
        // ── THE RFC Message-ID, WHICH IS A DIFFERENT THING ──────────────
        // Apsara, 2026-11-06: "follow up should happen in corresponding
        // email thread only".
        //
        // thread_id above is GMAIL's id. Passing it threads the chase in HER
        // mailbox and does nothing at all in the carrier's — their client
        // threads on In-Reply-To / References, which need this. Without it
        // every chase arrives at Zimex as a brand new message.
        last_message_id: str(input.last_message_id),
        // What has already gone out. The agent reads this to avoid sending a
        // rung twice; it is append-only.
        sent: [],
    };
    await mutateJson(FILE(), [], (all) => { all.push(rec); return all; }, { strict: true });
    return rec;
}

async function patch(id, fields = {}, by = 'jarvis') {
    const key = str(id);
    let out = null;
    await mutateJson(FILE(), [], (all) => all.map((p) => {
        if (!p || p.id !== key) return p;
        out = Object.assign({}, p, fields, { updated_at: now(), updated_by: str(by) });
        return out;
    }), { strict: true });
    if (!out) throw new Error(`no pickup with id ${key}`);
    return out;
}

// ── recordSent ───────────────────────────────────────────────────────────
// Appended the moment something goes out, BEFORE the next rung can be
// considered. The agent's "have I already done this" check reads this list,
// so if the job crashes between sending and recording, the worst case is one
// repeated message — not a silent gap. That is the right way round: a
// duplicate chase is embarrassing, an unwatched pickup is what she is
// complaining about.
async function recordSent(id, step, detail = {}) {
    const p = get(id);
    if (!p) throw new Error(`no pickup with id ${str(id)}`);
    const entry = Object.assign({ step: str(step), at: now() }, detail);
    return patch(id, { sent: (Array.isArray(p.sent) ? p.sent : []).concat([entry]) }, 'follow-up-agent');
}

// ── the answer arriving ──────────────────────────────────────────────────
// `eta` is free text on purpose. A carrier replies "around 2pm", "after
// lunch", "driver is loading now" — parsing that into a timestamp would be
// inventing precision, and a wrong parsed time is worse than her own eyes on
// the sentence. What matters to the agent is only that an answer EXISTS.
async function recordEta(id, eta, source = 'reply') {
    const rec = await patch(id, { eta: str(eta), confirmed_at: now(), confirmed_via: str(source) },
        'follow-up-agent');
    // ── THE REWARD SIGNAL ────────────────────────────────────────────────
    // "reinforcement". An answer arriving is the outcome worth learning
    // from: which channel it came back on, and how long after the first ask.
    // Recorded here rather than in the agent because the answer can arrive
    // three ways — the reply watch, the route, her voice — and all three
    // land on this function.
    //
    // Best effort, always. A learning write that failed must never cost her
    // the ETA that was the point of the whole exercise.
    try { await require('./pickupLearn').observe(rec); }
    catch (e) { console.warn('[PICKUPS] outcome not learned: ' + (e && e.message)); }
    return rec;
}

const open = () => list().filter((p) => p && p.status === 'arranged' && !str(p.eta));

module.exports = { list, get, create, patch, recordSent, recordEta, open, STATUSES, FILE };
