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

// ── WHAT COUNTS AS A MATERIAL ────────────────────────────────────────────
// Apsara, 2026-09-06: "my user doesnt know about nouns."
//
// This started as twenty-one metals I typed from memory. Scrap grades are
// not twenty-one words — they are ISRI names (Birch, Cliff, Zorba, Talk),
// house shorthand ("500 series", "Al combo"), and whatever she and the buyer
// agreed to call it this month. Anything outside my list came back null and
// she was asked "What material?" about a sentence that had already said it.
//
// Three sources, in order of how sure we are:
//   1. HER CATALOG — data/item_types.json, the descriptions she actually
//      types on load tickets. Same move as the ports in answerCards.js: the
//      vocabulary already exists in her data, and hardcoding a rival list is
//      me deciding what her yard is allowed to trade in.
//   2. The metals list, kept as a floor for things the catalog may not carry
//      (nobody makes a load ticket for "copper" in the abstract).
//   3. AN EXPLICIT CUE — "material is X", "21 MT of X at 8450". If she names
//      it in a position where only a material can go, the word is the
//      material whether or not anyone has heard of it.
//
// The looseness is safe HERE in a way it would not be for `rate`, and the
// distinction is the whole design: material is free text printed on a
// document she previews before it is sent. Getting it wrong shows her a
// wrong word to correct. Getting a RATE wrong sends $441 where $177,450
// belonged, which is why that field stays strict and this one does not.
const KNOWN_METALS = /\b(copper|brass|aluminium|aluminum|steel|iron|radiators?|compressors?|alternators?|starters?|motors?|sealed units?|zorba|zurik|birch|cliff|honey|berry|candy|talk|barley|shred|ubc)\b/i;

// Words that sit where a material would but are never one. Without this,
// "make a proforma for Daekwang of 21 MT at 8450" reads "MT" as the material.
const NOT_A_MATERIAL = /^(mt|ton|tons|tonne|tonnes|metric|it|that|this|the|a|an|them|those|stuff|material|cargo|goods|usd|dollars?)$/i;

let _matCache = null;
let _matCacheAt = 0;
const MAT_CACHE_MS = 30 * 1000;

// Her own item descriptions, longest first so "Al rims(Dirty)" wins over
// "Al". Punctuation in a catalog entry is escaped, not assumed away — "Al
// rims(Dirty)" has parentheses in it and would otherwise be a broken regex.
function catalogMaterials() {
    if (_matCache && Date.now() - _matCacheAt < MAT_CACHE_MS) return _matCache;
    let list = [];
    try {
        list = require('./itemTypes').loadCustomItemTypes() || [];
    } catch (e) {
        console.warn('[PROFORMA] could not read the item catalog:', e.message);
    }
    _patCache.clear();
    _matCache = list
        .map((s) => String(s || '').trim())
        .filter((s) => s.length >= 3 && !NOT_A_MATERIAL.test(s))
        .sort((a, b) => b.length - a.length);
    _matCacheAt = Date.now();
    return _matCache;
}

// "Auto cast" → /\bauto[\s\-]*cast(?:ing|ed|s|es)?\b/i, so "auto cast",
// "autocast", "Auto-cast" and "autocasting" all resolve to the one catalog
// entry. Built once per entry and cached with the list, because this runs on
// every utterance and RegExp compilation is not free.
const _patCache = new Map();
function catalogPattern(name) {
    if (_patCache.has(name)) return _patCache.get(name);
    const words = String(name).trim().split(/\s+/).map(
        (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    // [\s\-]* between words, NOT \s+ — that is what lets the spoken
    // run-together form match the written two-word one.
    const re = new RegExp(
        '(?:^|[^A-Za-z0-9])' + words.join('[\\s\\-]*') + '(?:ing|ed|es|s)?(?![A-Za-z0-9])', 'i');
    _patCache.set(name, re);
    return re;
}

function materialIn(text) {
    const t = String(text || '');
    if (!t.trim()) return null;

    // 1. HER CATALOG, matched the way it is SAID rather than the way it is
    //    typed. "Auto cast" is the catalog entry; she says "autocast", and
    //    whisper writes "autocasting". The exact-spelling match failed all
    //    three variants and she was asked "What material?" about a sentence
    //    that named it.
    //
    //    So the space between words becomes optional, and a plain English
    //    suffix is allowed on the end. Returning the CATALOG's spelling, not
    //    hers, is the point: the description line on the document then reads
    //    "Auto cast" like every other document she has ever raised, instead
    //    of "autocasting".
    for (const name of catalogMaterials()) {
        if (catalogPattern(name).test(t)) return name;
    }

    // 2. The metals floor.
    const m = KNOWN_METALS.exec(t);
    if (m) return m[0];

    // 3. A position only a material can occupy. "21 MT of 500 series at
    //    8450", "material is Taldon". Stops at a price, a quantity or a
    //    clause end so the rate is never swallowed into the description.
    // The capture starts [A-Za-z0-9], not [A-Za-z]: "500 series" is one of
    // her real grades and a letters-only opener silently skipped it — which
    // is precisely the noun-vocabulary failure this whole change is about,
    // reintroduced one character wide.
    const cue = /\b(?:material\s+(?:is\s+|of\s+)?|\d[\d,.]*\s*(?:mt|metric tons?|tons?|tonnes?)\s+of\s+|\bof\s+)([A-Za-z0-9][A-Za-z0-9&./\- ]{1,40}?)(?=\s*(?:$|[,.;]|\bat\b|\brate\b|\bfor\b|\bwith\b|\$|\d[\d,]*\s*(?:mt|per)\b))/i.exec(t);
    if (cue) {
        const v = cue[1].trim().replace(/[.,]$/, '');
        // A quantity is not a material, however it is phrased. Letting the
        // digit in above means "of 21 MT" can now reach here, and "21 MT"
        // on the description line of a proforma is a document she has to
        // throw away.
        if (v && !NOT_A_MATERIAL.test(v)
            && !/^\d[\d,.]*$/.test(v)
            && !/^\d[\d,.]*\s*(?:mt|metric tons?|tons?|tonnes?)$/i.test(v)) return v;
    }
    return null;
}

// Things that appear after "to" in a correction but are never a buyer.
// Incoterms and the names of the other fields on the document. Anchored at
// the start of the captured name so "change it to FOB and payment terms"
// resolves to no consignee at all rather than to a company called that.
// The words that turn a material into a company. Only consulted on a
// MULTI-WORD name, so a bare "chrome" stays goods while "Chrome Metals" is a
// customer. "Steel" and "Iron" are in here precisely because they are the
// commonest company tails in this trade — Hyundai Steel, POSCO — and the
// commonest way a buyer gets mistaken for its own cargo.
const COMPANY_TAIL = /\b(metals?|trading|traders?|steel|iron|corp|corporation|co|ltd|limited|inc|llc|gmbh|industries|industrial|impex|international|resources|recycling|group|enterprises?|holdings?)\b/i;

const NOT_A_CONSIGNEE = /^(?:cif|fob|cfr|cnf|exw|ddp|dap|fca|fas|dat|payment|shipment|trade|delivery|the\s+rate|rate|it|that|this|them|us|me|him|her|mt|\d)/i;

// Order matters: this is the order the document reads, so the conversation
// follows the page rather than the shape of the data structure.
const FIELDS = [
    {
        key: 'consignee',
        ask: 'Who is the consignee?',
        // A name, not a number. Anything is acceptable except emptiness.
        parse: (t) => {
            // NON-GREEDY, and stopped at a clause boundary. The greedy
            // version ran straight through the rest of the sentence: "make a
            // proforma for Daekwang of 21 MT at 8450" gave a consignee of
            // "Daekwang of 21 MT at 8450", which is the name that would have
            // been printed at the top of a document sent to a customer.
            // Found by widening the material parser, not by looking for it.
            // "consignee to Hyundai Steel" and "consignee should be X"
            // both used to capture the preposition as part of the name —
            // "to Hyundai Steel" went on the document, and into the address
            // book lookup, which then failed for a company that exists.
            const m = /\b(?:consignee\s+(?:is\s+|to\s+|should\s+be\s+)?|for\s+|to\s+)([A-Za-z][\w&.\- ]{1,60}?)(?=\s*(?:$|[,.;]|\bof\b|\bat\b|\brate\b|\bwith\b|\bmaterial\b|\d))/i.exec(t);
            if (!m) return null;
            const name = m[1].trim().replace(/[.,]$/, '');
            // ── A TERM IS NOT A COMPANY ──────────────────────────────────
            // "change it TO FOB and payment terms" matched the `to` branch
            // and set the consignee to "FOB and payment terms" — a garbage
            // company name on a document about to be emailed to a customer.
            // Found by running her own correction sentence, not by reading
            // the regex, and it existed before today: "send the proforma to
            // CIF" would have done the same thing.
            //
            // Checked on the START of the capture, not the whole of it, so a
            // real company whose name happens to begin with one of these
            // words is still refused rather than mangled — but "Chrome
            // Metals" and "Talk Trading" are untouched, because the words
            // here are incoterms and field names, not materials.
            if (NOT_A_CONSIGNEE.test(name)) return null;
            return name;
        },
    },
    {
        key: 'material',
        ask: 'What material?',
        parse: (t) => materialIn(t),
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
            // "the rate SHOULD BE 8600" — how a correction is actually
            // phrased, and it parsed to nothing, so "no, the rate should be
            // 8600" was not recognised as an amendment at all and fell
            // through to the AI classifier with a confirm still open.
            const m = /\brate\s+(?:should\s+be\s+|needs?\s+to\s+be\s+|is\s+|of\s+|to\s+|=\s*)?(?:\$|usd\s*)?(\d[\d,]*(?:\.\d+)?)/i.exec(t)
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

// ── THE VERBS SHE ACTUALLY USES ──────────────────────────────────────────
// Apsara, 2026-09-07: "when i say Hey Jarvis..send a proforma for autocasting
// tense..still it asks what is the material".
//
// "send" was not in this list. Her exact sentence did not start a draft AT
// ALL — handle() returned null and the whole thing fell through to the
// router. Seven verbs I thought of, and the first one she reached for was not
// among them. This is the noun problem again wearing a verb.
//
// "send" is the interesting one, because it means BOTH "make me one" (here)
// and "post the one on screen" (the confirm). That is not a conflict: while a
// draft is staged, handle() only answers a correction or a brand-new start,
// and a bare "send it" is neither — it reaches the brain, which is what
// actually sends. The overlap resolves by which of them has a document.
const START = /\b(create|make|raise|draw\s+up|prepare|prep|generate|issue|send|do|put\s+together|draft|new)\b[^.]{0,24}\b(proforma|pi|p\.i\.|invoice)\b/i;

// ── "SEND A PROFORMA" MAKES ONE. "SEND THE PROFORMA" POSTS ONE. ──────────
// Adding "send" to the verbs above created a real collision, and the article
// is what resolves it: "send A proforma for autocasting" is a new document,
// "send THE proforma to Joey" is the one that already exists, which is
// startProformaFromEmail's job and not this module's at all.
//
// Without this, "send the proforma to Joey" started a blank draft and began
// asking her for a consignee she had just named. Caught by an assertion that
// already existed and that my widening broke — which is the whole reason it
// was written.
const NOT_A_START = /\b(?:send|mail|email|forward|resend|post)\s+(?:the|that|this|it|him|her|them)\b/i;

// Verbs that can ONLY mean "make me one". No article test is needed for
// these, and applying one to them was a bug: "create a proforma for Daekwang,
// 21 MT of copper at 8450, email it to Yurim" contains "email it", so the
// blanket veto killed a sentence that unambiguously creates a document. The
// veto exists for the ambiguous verbs only.
const CREATE_VERB = /\b(create|make|raise|draw\s+up|prepare|prep|generate|put\s+together|draft|new)\b/i;

function isStart(text) {
    const t = String(text || '');
    if (!START.test(t)) return false;
    // "create ... email it to Yurim" — unambiguous, whatever else it says.
    if (CREATE_VERB.test(t)) return true;
    // Only send/do/issue are ambiguous, and the article decides: "send A
    // proforma" makes one, "send THE proforma" posts the one that exists.
    return !NOT_A_START.test(t);
}

// Pulls out everything the sentence already contains. Called on the opening
// request AND on every answer, so "actually make it 25 MT at 4200" fills two
// fields in one go rather than being read as an answer to one question.
// Deliberately NOT a member of FIELDS. It is never asked for as a question
// (the consignee answers it in almost every case, see recipient()), and
// adding it there would list it under `defaulted` in the preview as though it
// were a standing default she should check.
const SEND_TO = /\b(?:send|mail|email|e-mail)\s+(?:it|this|that|the\s+(?:proforma|pi|invoice))?\s*to\s+([A-Za-z][\w&.@\- ]{1,60}?)(?=\s*(?:$|[,.;]|\bplease\b|\band\b))/i;

function absorb(text) {
    const t = String(text || '');
    const got = {};

    // ── THE CONSIGNEE'S NAME IS NOT A MATERIAL ───────────────────────────
    // "change the consignee to Hyundai Steel" set material = "Steel", because
    // materialIn() reads the whole sentence and half her buyers are named
    // after metals — Hyundai Steel, POSCO, Chrome Metals. The description
    // line on the proforma would have silently changed along with the buyer.
    //
    // So the consignee is parsed FIRST and its span blanked out of the text
    // every other field is read from. Blanking rather than reordering,
    // because the name can sit anywhere in the sentence.
    const consigneeField = FIELDS.find((f) => f.key === 'consignee');
    let who = consigneeField ? consigneeField.parse(t) : null;

    // ── "A PROFORMA FOR AUTOCASTING" IS NOT A COMPANY CALLED AUTOCASTING ──
    // Apsara, 2026-09-07: "send a proforma for autocasting tense..still it
    // asks what is the material".
    //
    // "for X" is how she names BOTH the buyer and the goods — "a proforma for
    // Daekwang" and "a proforma for autocasting" are the same shape. The
    // consignee parser took the first one it saw, so the MATERIAL became the
    // buyer, the material field stayed empty, and she was asked "What
    // material?" about a sentence whose whole subject was the material.
    //
    // THE DISCRIMINATOR IS HER CATALOG, NOT THE METALS LIST. My first version
    // used materialIn(), which includes the plain metals — and half her
    // buyers are named after metals, so "change the consignee to Hyundai
    // Steel" turned the buyer into goods and put "Steel" on the description
    // line. Her item catalog is curated: it contains "Auto cast" and "Al
    // rims(Dirty)", which no company is called, and NOT bare "steel" or
    // "iron", which many are.
    //
    // Plus a company-suffix escape, because "Chrome" IS a catalog entry and
    // "Chrome Metals" is a customer. A trailing Metals/Trading/Corp/Steel on
    // a multi-word name means a company, whatever the first word is.
    if (who) {
        const inCatalog = catalogMaterials().some((n) => catalogPattern(n).test(who));
        const multiWord = /\s/.test(who.trim());
        const looksLikeCompany = multiWord && COMPANY_TAIL.test(who);
        if (inCatalog && !looksLikeCompany) {
            console.log(`[PROFORMA] "${who}" is in the item catalog — reading it as the goods, not the buyer`);
            who = null;
        }
    }

    let rest = t;
    if (who) {
        got.consignee = who;
        const esc = who.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        rest = t.replace(new RegExp(esc, 'i'), ' ');
    }

    for (const f of FIELDS) {
        if (f.key === 'consignee') continue;
        const v = f.parse(rest);
        if (v !== null && v !== undefined && v !== '') got[f.key] = v;
    }
    // "email it to Yurim" — an explicit recipient that is NOT the consignee.
    // Broker-shipped orders are the case: the document is made out to the
    // buyer and sent to the agent who placed it.
    const m = SEND_TO.exec(t);
    if (m) got.send_to = m[1].trim().replace(/[.,]$/, '');
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

// ── THE SHAPE THE *SENDER* WANTS, WHICH IS A THIRD ONE ───────────────────
// Apsara, 2026-09-06: "it should be able to send the proforma in mail."
//
// It could not. The preview said 'say "send it" when you are happy' and
// NOTHING ANYWHERE CONSUMED "send it" — the draft stayed open and simply
// re-previewed itself for ever. My own test asserted that the preview text
// contained the string "send it", which is a test that the lie is spelled
// correctly. That is the exact failure I have spent this whole session
// pointing at in other people's code.
//
// WHAT I AM DELIBERATELY NOT DOING: writing a second sender.
// workflow/actions.js:generateProformaFromPending already builds the PDF,
// archives a copy, records the price in the pricing memory, logs it to the
// sheet and emails it — and it is the path her existing proformas go
// through. A voice-only copy of that would be a second set of rules to keep
// in step, and the one that drifts is the one that puts a wrong document in
// front of a customer. Same argument I made for not reimplementing
// forwardBooking.
//
// So this returns the `draft` that generateProformaFromPending expects, the
// voice flow stages the SAME `confirm_proforma` pending the email flow
// stages, and her "yes" is resolved by the code that already resolves it.
// Nothing about sending lives in this file.
function brainDraft() {
    const p = payload();
    if (!p) return null;
    return {
        consignee: p.consignee,
        // `desc`, not `description` — the two shapes differ by that one word,
        // and pdfPayload() above exists because I once handed a generator an
        // object shaped the way I imagined. Copied from the email path, not
        // guessed.
        items: [{ desc: p.items[0].description, qty: p.items[0].qty, rate: p.items[0].rate }],
        // One container unless she said otherwise. prepareProformaNumbers()
        // mints one container number per count, so a wrong number here is a
        // document with container numbers that do not exist.
        containerCount: 1,
        trade_terms: p.shipment_terms,
        // The voice flow never asks for a discharge port and must not invent
        // one — an empty field on the document is a gap she can see, a
        // guessed port is a gap she cannot.
        port_discharge: '',
        payment_term: p.payment_terms,
    };
}

// Who the mail goes to. Almost always the consignee, so it is NOT asked as a
// seventh question — deriving it from a name she already gave is the whole
// point of "my user doesnt know about nouns", and reading an email address
// aloud ("purchasing at daekwang dot com") is miserable.
//
// resolveContact() is the same address book draft_email uses, so a contact
// saved once works everywhere. It returns null rather than a guess when the
// name is unknown, and ambiguous when several match — both of which must
// reach her as a question, never as a send.
function recipient(spoken) {
    const f = (draft && draft.fields) || {};
    const who = String(spoken || f.consignee || '').trim();
    if (!who) return { ok: false, why: 'no-name' };
    try {
        const hit = require('./emailContacts').resolveContact(who);
        if (!hit) return { ok: false, why: 'unknown', who };
        if (hit.type === 'ambiguous') {
            return { ok: false, why: 'ambiguous', who, matches: hit.matches || [] };
        }
        const email = hit.contact && hit.contact.email;
        if (!email) return { ok: false, why: 'unknown', who };
        return { ok: true, who, email, name: (hit.contact.name || who) };
    } catch (e) {
        console.warn('[PROFORMA] address book unreadable:', e.message);
        return { ok: false, why: 'error', who, error: e.message };
    }
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
// ── "WAIT. CHANGE THESE AND CREATE" ──────────────────────────────────────
// Apsara, 2026-09-07, reading the preview back to me: "what if i want change
// in cif and payment terms. if i say wait.change these andccreate, how jarvis
// would take that?"
//
// Badly, was the answer. While the draft is open a correction works — absorb()
// re-reads the whole sentence on every turn, so "make it FOB" simply
// overwrites the term. But the moment the preview is READY, api.js stages the
// confirm_proforma pending and the draft was cleared, so "wait, change the
// terms" returned null, fell through to a brain holding an open yes/no
// question, and got reclassified from scratch by the AI. I wrote a comment
// naming that cost and shipped it anyway; she found it in one reading.
//
// So a staged draft is kept, but INERT. While staged it answers only two
// things — a correction, or a brand new proforma — and returns null for
// everything else, so an ordinary sentence never re-opens a document that is
// already sitting in front of her waiting for a yes.
//
// A CORRECTION NEEDS A CUE, and that is the whole safety of it. "Change it to
// FOB" is a correction; "forward that to Sher Trucking" is not — but the
// consignee parser matches "to Sher Trucking" perfectly happily, so absorbing
// any sentence that yields a field would quietly rewrite the consignee of a
// document she is about to send. Requiring an explicit cue AND a field is
// what keeps those apart.
const CORRECTION_CUE = /\b(wait|hold on|hang on|actually|instead|change|correct|make it|make that|should be|rather|scrap that|no[,.]|not\s+\w+,?\s+(?:make|change))\b/i;

function isAmendment(text) {
    const t = String(text || '');
    if (!t.trim() || !draft) return false;
    if (!CORRECTION_CUE.test(t)) return false;
    // It must actually CHANGE something. "Wait" on its own is a hesitation,
    // and treating it as an amendment would cancel a confirmation she had
    // not finished thinking about.
    const got = absorb(t);
    return Object.keys(got).length > 0;
}

// api.js calls this after staging the pending, so a later correction has
// something to correct.
function markStaged() { if (draft) draft.staged = true; }
function isStaged() { return !!(draft && draft.staged); }

function handle(text) {
    const open = !!draft;
    if (!isStart(text) && !open) return null;

    // A staged draft is waiting on her yes. It must not absorb whatever she
    // says next — "any bookings from Houston" would be read as an answer and
    // silently redraw a document that is already staged for sending.
    if (open && draft.staged && !isStart(text)) {
        if (!isAmendment(text)) return null;
        // A real correction reopens it. The caller is responsible for tearing
        // down the pending it staged — see api.js — because a document that
        // has been amended must not still be confirmable in its old form.
        draft.staged = false;
    }

    if (!open) start(text); else answer(text);

    const q = nextQuestion();
    if (q) return { stage: 'asking', say: q, have: Object.assign({}, draft.fields) };

    const p = payload();
    const line = summary();

    // ── THE PREVIEW NOW ASKS A QUESTION IT CAN ACT ON ────────────────────
    // It used to say 'say "send it" when you are happy' and nothing listened.
    // What it says now depends on whether there is somewhere to send it, and
    // each branch is a question with a real answer behind it.
    const to = recipient(draft.fields.send_to);
    if (!to.ok) {
        // NOT a send with a missing address, and not a silent preview-only
        // that leaves her thinking it went. She is told what is in the way.
        const why = to.why === 'ambiguous'
            ? `I have ${to.matches.length} contacts matching ${to.who} — which one?`
            : `I don't have an email address for ${to.who || 'them'}. Add the contact, or tell me the address.`;
        return {
            stage: 'preview', ready: false, blocked: to.why,
            say: `${line} ${why}`,
            summary: line, recipient: to,
            fields: Object.assign({}, draft.fields),
            defaulted: p.defaulted, pdf: pdfPayload(), draft: brainDraft(),
        };
    }

    return {
        stage: 'preview', ready: true,
        say: `${line} Send it to ${to.name}? Say yes and it goes.`,
        summary: line, recipient: to,
        fields: Object.assign({}, draft.fields),
        defaulted: p.defaulted,
        pdf: pdfPayload(),
        // Handed to workflow/actions.js's existing confirm_proforma pending.
        draft: brainDraft(),
    };
}

module.exports = {
    materialIn, catalogMaterials, catalogPattern, KNOWN_METALS, NOT_A_MATERIAL,
    _clearMaterialCache: () => { _matCache = null; _matCacheAt = 0; _patCache.clear(); },
    handle, brainDraft, recipient, SEND_TO,
    isAmendment, markStaged, isStaged, CORRECTION_CUE, NOT_A_CONSIGNEE, COMPANY_TAIL, START, NOT_A_START, CREATE_VERB,
    isStart, start, answer, current, clear, missing, nextQuestion, payload, pdfPayload, summary,
    absorb, FIELDS, REQUIRED, DEFAULT_MT, DEFAULT_PAYMENT_TERMS, DEFAULT_SHIPMENT_TERMS,
};
