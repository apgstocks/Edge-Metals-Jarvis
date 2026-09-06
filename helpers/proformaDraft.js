// ── helpers/proformaDraft.js — building a proforma by being asked ─────────
//
// Apsara, 2026-09-06: "if i ask jarvis to create proforma, it should create
// that .. it can ask whatever data is needed from me to create proforma like
// consignee, material, rate, MT (Typically 21 MT), payment terms, shipment
// terms. Then it can create and preview me the proforma."
//
// WHAT ALREADY EXISTED, AND WHAT DID NOT
// --------------------------------------
// The proforma machinery is all here: helpers/proformaPdf.js renders it,
// helpers/proformaFromEmail.js has the order schema, and the brain has a
// generate_proforma intent that reads a customer's email, pulls out the
// materials and prices the email STATES, reads them back, and emails the
// document once she says yes.
//
// Every one of those starts from an EMAIL. There was no way to make one from
// nothing by being asked for the fields, which is what she is describing —
// and it is the case where there is no email to read because she is quoting
// someone on the phone.
//
// ONE QUESTION AT A TIME, AND ONLY THE ONES IT NEEDS
// -------------------------------------------------
// The failure to avoid is the form-in-disguise: an assistant that asks six
// questions in a row it could have inferred. So:
//
//   - anything she already said is taken from the sentence and not asked
//   - MT defaults to 21, because she said it is typical — asked only if she
//     wants something else
//   - payment and shipment terms default to what her own proformas use
//   - it asks for what is genuinely missing, in the order the document reads
//
// NOTHING IS INVENTED. A rate that was not given is asked for, never guessed,
// because a wrong number on a document sent to a customer is a different
// class of mistake from a wrong answer on a screen.

const DEFAULT_MT = 21;
// Her own standing terms, taken from the existing proformas rather than
// chosen here. Defaults, not decisions: each one is overridable by saying so.
const DEFAULT_PAYMENT_TERMS = '100% TT against scan copy of documents';
const DEFAULT_SHIPMENT_TERMS = 'CIF';
const DEFAULT_ALLOWANCE = '+/- 10% on weights';

// Order matters: this is the order the document reads, so the conversation
// follows the page rather than the shape of the data structure.
const FIELDS = [
    {
        key: 'consignee',
        ask: 'Who is the consignee?',
        // A name, not a number. Anything is acceptable except emptiness.
        parse: (t) => {
            const m = /\b(?:for|to|consignee(?:\s+is)?)\s+([A-Za-z][\w&.\- ]{1,60})/i.exec(t);
            return m ? m[1].trim().replace(/[.,]$/, '') : null;
        },
    },
    {
        key: 'material',
        ask: 'What material?',
        parse: (t) => {
            const KNOWN = /\b(copper|brass|aluminium|aluminum|steel|iron|radiators?|compressors?|alternators?|starters?|motors?|sealed units?|zorba|zurik|birch|cliff|honey|berry|candy|talk|barley|shred|ubc)\b/i;
            const m = KNOWN.exec(t);
            return m ? m[0] : null;
        },
    },
    {
        key: 'rate',
        ask: 'What rate per metric ton?',
        // A price, and the one field that must never be guessed.
        //
        // THE PATTERN THAT NEARLY SHIPPED: `(\d+)\s*(?:\/|per\s+)?(?:mt|ton)`
        // made the "per" OPTIONAL, so in "21 MT of copper at 8450 per MT" it
        // matched "21 MT" first and the rate became TWENTY-ONE DOLLARS. The
        // total came to $441 instead of $177,450, and it would have gone to
        // a customer looking entirely plausible.
        //
        // So a rate is only ever read from an explicit PRICE context: after
        // "at", after "rate", behind a currency symbol, or with a genuine
        // "per"/"/" before the unit. A bare "N MT" is a quantity and can
        // never be a price.
        parse: (t) => {
            const m = /\brate\s+(?:is\s+|of\s+)?(?:\$|usd\s*)?(\d[\d,]*(?:\.\d+)?)/i.exec(t)
                || /(?:\$|\busd\s*)(\d[\d,]*(?:\.\d+)?)/i.exec(t)
                || /(\d[\d,]*(?:\.\d+)?)\s*(?:\/|per\s+)(?:mt|ton|tonne)\b/i.exec(t)
                || /\bat\s+(?:\$|usd\s*)?(\d[\d,]*(?:\.\d+)?)\b/i.exec(t);
            if (!m) return null;
            const n = Number(String(m[1]).replace(/,/g, ''));
            return Number.isFinite(n) && n > 0 ? n : null;
        },
    },
    {
        key: 'mt',
        // Asked ONLY if she volunteers something other than the usual. She
        // said 21 is typical, so asking every time is asking her to confirm
        // a fact she just told me.
        optional: true,
        fallback: DEFAULT_MT,
        parse: (t) => {
            const m = /(\d[\d,]*(?:\.\d+)?)\s*(?:mt|metric tons?|tons?|tonnes?)\b/i.exec(t);
            if (!m) return null;
            const n = Number(String(m[1]).replace(/,/g, ''));
            return Number.isFinite(n) && n > 0 ? n : null;
        },
    },
    {
        key: 'payment_terms',
        optional: true,
        fallback: DEFAULT_PAYMENT_TERMS,
        parse: (t) => {
            const m = /\bpayment\s+terms?\s+(?:is\s+|are\s+|as\s+)?(.{3,80})/i.exec(t);
            return m ? m[1].trim().replace(/[.]$/, '') : null;
        },
    },
    {
        key: 'shipment_terms',
        optional: true,
        fallback: DEFAULT_SHIPMENT_TERMS,
        parse: (t) => {
            const m = /\b(cif|fob|cfr|exw|ddp|dap)\b/i.exec(t);
            return m ? m[1].toUpperCase() : null;
        },
    },
];

const REQUIRED = FIELDS.filter((f) => !f.optional).map((f) => f.key);

// One draft at a time. Same reasoning as the referent set in
// helpers/voiceMemory.js: one user, one conversation, and a Map keyed by
// session is the change to make if that ever stops being true.
let draft = null;

const START = /\b(create|make|raise|draw up|prepare|generate|new)\b[^.]{0,20}\b(proforma|pi|p\.i\.|invoice)\b/i;

function isStart(text) { return START.test(String(text || '')); }

// Pulls out everything the sentence already contains. Called on the opening
// request AND on every answer, so "actually make it 25 MT at 4200" fills two
// fields in one go rather than being read as an answer to one question.
function absorb(text) {
    const t = String(text || '');
    const got = {};
    for (const f of FIELDS) {
        const v = f.parse(t);
        if (v !== null && v !== undefined && v !== '') got[f.key] = v;
    }
    return got;
}

function start(text) {
    draft = { fields: absorb(text), asked: null, startedAt: Date.now() };
    return draft;
}

function current() { return draft; }
function clear() { draft = null; }

// What is still genuinely unknown — optional fields with a fallback do not
// count as missing.
function missing() {
    if (!draft) return REQUIRED.slice();
    return REQUIRED.filter((k) => draft.fields[k] === undefined || draft.fields[k] === null);
}

// The next question, or null when there is nothing left to ask.
function nextQuestion() {
    if (!draft) return null;
    const need = missing();
    if (!need.length) return null;
    const f = FIELDS.find((x) => x.key === need[0]);
    draft.asked = f.key;
    return f.ask;
}

// Feeds an answer in. Tries to read it as a full sentence FIRST — she often
// answers with more than was asked — and falls back to treating the whole
// utterance as the value of the field just asked about, which is what a bare
// "Daekwang" is.
function answer(text) {
    if (!draft) return null;
    const got = absorb(text);
    Object.assign(draft.fields, got);

    if (draft.asked && draft.fields[draft.asked] === undefined) {
        const f = FIELDS.find((x) => x.key === draft.asked);
        const raw = String(text || '').trim();
        // A bare answer only counts for fields where any text is a valid
        // value. Never for `rate`: "about four thousand" must be asked
        // again rather than stored as a string that later reads as NaN on a
        // document sent to a customer.
        if (f && (f.key === 'rate' || f.key === 'mt')) {
            // A NUMERIC field answered with a bare number is a direct answer,
            // not a guess: asked "what rate?", "4200" means 4200. But it must
            // be a CLEAN number — "about four thousand or so" is not one, and
            // storing it would put a string where a price belongs.
            const n = Number(raw.replace(/[$,]/g, '').replace(/\s*(?:mt|per mt|usd|dollars?)\s*$/i, '').trim());
            if (Number.isFinite(n) && n > 0) draft.fields[f.key] = n;
        } else if (raw && f) {
            draft.fields[f.key] = raw.replace(/[.]$/, '');
        }
    }
    return draft;
}

// Everything the PDF generator needs, with the defaults applied at the last
// moment so they are visible in the preview rather than buried.
// Every default comes from the FIELD that declares it. There used to be a
// `fallback` on each optional field AND a separate constant used here, and a
// mutation changing the fallback survived every test — because nothing read
// it. Two places to state one default is one place too many; the one that is
// wrong is always the one nobody is looking at.
function fallbackFor(key) {
    const f = FIELDS.find((x) => x.key === key);
    return f ? f.fallback : undefined;
}

function payload() {
    if (!draft) return null;
    const f = draft.fields;
    const mt = f.mt != null ? Number(f.mt) : Number(fallbackFor('mt'));
    const rate = Number(f.rate);
    return {
        consignee: f.consignee || '',
        items: [{
            description: f.material || '',
            qty: mt,
            rate: rate,
        }],
        payment_terms: f.payment_terms || fallbackFor('payment_terms'),
        shipment_terms: f.shipment_terms || fallbackFor('shipment_terms'),
        shipment_allowance: DEFAULT_ALLOWANCE,
        total: Math.round(mt * rate * 100) / 100,
        // Which values she gave and which are standing defaults. Shown in the
        // preview so a default is never mistaken for something she said.
        defaulted: FIELDS.filter((x) => x.optional && (f[x.key] == null)).map((x) => x.key),
    };
}

// ── THE SHAPE THE GENERATOR ACTUALLY WANTS ───────────────────────────────
// payload() above is the shape this MODULE reasons about — flat, one item,
// easy to read back in a sentence. helpers/proformaPdf.js wants something
// else entirely: containers, each holding items, with trade terms and a
// freight label and a country of origin.
//
// Kept as two functions rather than one, and translated here, because the
// alternative is what I nearly did: invent a payload shaped the way I
// imagined and hand it to a generator that expects another. That is the same
// mistake as reading smart-whisper's typings instead of running it — a
// plausible object, accepted without complaint, producing a document with
// empty fields on it.
//
// Every literal below is copied from generateProformaFromPending() in
// workflow/actions.js, which is the path her existing proformas already go
// through. A document raised by voice must not differ from one raised from
// an email in anything but how it was asked for.
function pdfPayload(opts = {}) {
    const p = payload();
    if (!p) return null;
    const trade = p.shipment_terms;
    return {
        inv_no: opts.inv_no || '',
        inv_date: new Date().toISOString().slice(0, 10),
        reference: '',
        qty_unit: 'MT',
        consignee: p.consignee,
        consignee_sheet_tag: p.consignee,
        consignee_address: Array.isArray(opts.addressLines) ? opts.addressLines : [],
        trade_terms: trade,
        port_discharge: opts.port_discharge || '',
        payment_term: p.payment_terms,
        freight_label: /^FOB/i.test(trade) ? 'FOB (freight excluded)' : 'CIF (freight included)',
        buyer_po: '', buyer_po_date: '',
        country_of_origin: 'USA',
        shipment_allowance: p.shipment_allowance,
        containers: [{
            container_no: '',
            item_code: null,
            items: p.items.map((i) => ({
                desc: i.description, qty: i.qty, rate: i.rate, unit: 'MT',
            })),
        }],
    };
}

// A sentence for reading back before it is built. Deliberately short: this
// is spoken, and past a couple of lines nobody is listening any more.
function summary() {
    const p = payload();
    if (!p) return '';
    const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${p.items[0].qty} MT of ${p.items[0].description} for ${p.consignee} `
        + `at ${money(p.items[0].rate)} per MT — ${money(p.total)} total, `
        + `${p.shipment_terms}, ${p.payment_terms}.`;
}

// ── THE WHOLE DECISION, IN ONE TESTABLE PLACE ────────────────────────────
// This lived inline in api.js's /api/voice/ask handler, and two mutations
// survived the entire suite because of it: turning the flow off completely,
// and restarting the draft on every answer so it could never finish. Both
// are catastrophic and both were invisible, because the only test that
// touched them GREPPED THE SOURCE for the order of two require() calls.
// Reading a file is not running it.
//
// So the decision moves here, where it can be executed, and api.js keeps
// only the plumbing. Returns null when this utterance is nothing to do with
// a proforma — which is the common case and must stay cheap.
function handle(text) {
    const open = !!draft;
    if (!isStart(text) && !open) return null;

    if (!open) start(text); else answer(text);

    const q = nextQuestion();
    if (q) return { stage: 'asking', say: q, have: Object.assign({}, draft.fields) };

    const p = payload();
    const line = summary();
    return {
        stage: 'preview',
        say: line + ' Have a look — say "send it" when you are happy.',
        summary: line,
        fields: Object.assign({}, draft.fields),
        defaulted: p.defaulted,
        pdf: pdfPayload(),
    };
}

module.exports = {
    handle,
    isStart, start, answer, current, clear, missing, nextQuestion, payload, pdfPayload, summary,
    absorb, FIELDS, REQUIRED, DEFAULT_MT, DEFAULT_PAYMENT_TERMS, DEFAULT_SHIPMENT_TERMS,
};
