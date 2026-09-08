// ── helpers/voiceVocab.js ────────────────────────────────────────────────
// Apsara, 2026-09-07: "Check siri/alexa's paper.. And keep on building this
// voice code of jarvis."
//
// WHAT THE PAPERS ACTUALLY SAY, and it changes where the fix belongs
// ------------------------------------------------------------------
// Her bug was "Jeyshree" transcribed as "Jayashree". helpers/nameSuggest.js
// repairs that AFTER the fact. The literature is unanimous that the better
// place is BEFORE it.
//
// Zhao et al., "Shallow-Fusion End-to-End Contextual Biasing" (Interspeech
// 2019), and Amazon's own "Slot-triggered contextual biasing for personalized
// speech recognition using neural transducers", both start from the same
// observation: contextual biasing toward a user's own contact names, app
// names and song titles is a component of any production ASR system, because
// end-to-end models "do poorly on proper nouns, which is the main source of
// biasing phrases."
//
// That is this bug exactly. A proper noun, from a small private list, that
// the model has no reason to prefer over a commoner spelling. Siri and Alexa
// do not fuzzy-match their way out of it — they tell the recogniser what
// names it is likely to hear.
//
// AND WHISPER TAKES THE SAME TREATMENT
// ------------------------------------
// "Contextual Biasing to Improve Domain-specific Custom Vocabulary Audio
// Transcription without Explicit Fine-Tuning of Whisper" (arXiv 2410.18363)
// does it through the documented `initial_prompt`, with no retraining: the
// prompt biases the decoder toward the words in it while still reconciling
// against the audio. Reported gains on proper-noun-dense speech are large —
// one study measured a 17% relative WER reduction.
//
// desktop/speech.js ALREADY passes an initial_prompt. What it passes is a
// fixed sentence about copper and petty cash, with not one name from her
// business in it. Every buyer, trucker, supplier and port she says out loud
// twenty times a day was left for the decoder to guess at.
//
// TWO CONSTRAINTS FROM THE SAME PAPER, both obeyed below:
//   1. The prompt is capped at 224 tokens. Past that it is silently
//      truncated, so an unbounded roster would push the earliest names out
//      and nobody would ever see why.
//   2. Attention weights tokens at the END of the prompt more heavily. So
//      the names likeliest to be said go LAST, not first.
//
// And one from the file this replaces a constant in: a long or narrative
// prompt makes Whisper hallucinate its own style into silence. Bare names,
// comma separated, no sentences.

const MAX_TOKENS = 224;
// Whisper's tokeniser is BPE; a rough characters-per-token of 4 is the
// standard approximation and is deliberately pessimistic here. Being under
// the cap costs a few names; being over it silently loses them.
const CHARS_PER_TOKEN = 4;
const BUDGET = Math.floor(MAX_TOKENS * CHARS_PER_TOKEN * 0.8);

// The fixed part. Kept from desktop/speech.js unchanged — it earned its place
// fixing "Hey Jarvis" heard as "I'll see you later" — and placed FIRST so the
// names she actually says land in the high-attention tail.
const BASE = 'Jarvis. Edge Metals yard. Loads, trucker bills, suppliers, '
    + 'inventory, petty cash, invoices. Payments by Zelle, wire, cash, card. '
    + 'Copper, brass, aluminium, steel, radiators.';

function clean(name) {
    return String(name || '').replace(/[^A-Za-z0-9 &.'-]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── WHAT GOES IN, AND IN WHICH ORDER ─────────────────────────────────────
// Ordered by how likely she is to say it in the next sentence, weakest
// first, because the tail is what the decoder weights. Bookings and their
// consignees are at the end: they are the live work.
//
// Every list is capped on its own as well as collectively, so one enormous
// contact book cannot crowd out every trucker.
function terms(sources) {
    const s = sources || {};
    const take = (arr, n, get) => [...new Set((arr || [])
        .map((x) => clean(get ? get(x) : x))
        .filter((x) => x.length > 2))].slice(0, n);

    return {
        ports: take(s.ports, 12),
        suppliers: take(s.suppliers, 15, (x) => x.name),
        truckers: take(s.truckers, 15, (x) => x.name),
        contacts: take(s.contacts, 30, (x) => x.displayName || x.name),
        consignees: take(s.consignees, 20),
    };
}

// Builds the prompt. Trims from the FRONT of the name list when over budget,
// so the most valuable names — the ones nearest the end — survive.
function buildPrompt(sources) {
    const t = terms(sources);
    // Weakest to strongest. Ports are said least ambiguously (they are common
    // English words); people's names are said most often and heard worst.
    const ordered = [...t.ports, ...t.suppliers, ...t.truckers, ...t.consignees, ...t.contacts];
    if (!ordered.length) return BASE;

    let names = ordered;
    let tail = names.join(', ');
    while (names.length && (BASE.length + 2 + tail.length) > BUDGET) {
        names = names.slice(1);          // drop from the FRONT, keep the tail
        tail = names.join(', ');
    }
    if (!names.length) return BASE;
    return `${BASE} ${tail}.`;
}

// Reads her live data. Every source is optional and every failure is
// swallowed to a warning: a biasing prompt is an accuracy improvement, and an
// accuracy improvement that can break transcription entirely is a bad trade.
function fromData() {
    const out = { ports: [], suppliers: [], truckers: [], contacts: [], consignees: [] };
    try {
        const { loadBookings } = require('./json');
        const rows = Object.values(loadBookings() || {}).filter((b) => b && !b.archived);
        for (const b of rows) {
            if (b.port_of_loading) out.ports.push(b.port_of_loading);
            if (b.port_of_discharge) out.ports.push(b.port_of_discharge);
            if (b.buyer) out.consignees.push(b.buyer);
            if (b.consignee) out.consignees.push(b.consignee);
        }
    } catch (e) { console.warn('[VOCAB] bookings unavailable:', e.message); }
    try {
        out.contacts = require('./emailContacts').loadContacts() || [];
    } catch (e) { console.warn('[VOCAB] contacts unavailable:', e.message); }
    return out;
}

// Async because truckers and suppliers live in Supabase, not on disk — a fact
// that cost an afternoon to rediscover while building the end-to-end harness.
async function fromDataAsync() {
    const out = fromData();
    try {
        const { loadTruckers, loadSuppliers } = require('./json');
        out.truckers = (await loadTruckers()) || [];
        out.suppliers = (await loadSuppliers()) || [];
    } catch (e) { console.warn('[VOCAB] truckers/suppliers unavailable:', e.message); }
    return out;
}

module.exports = { buildPrompt, terms, fromData, fromDataAsync, BASE, MAX_TOKENS, BUDGET, clean };
