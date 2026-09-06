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

// ── TWO CATALOGUES, IN ORDER ─────────────────────────────────────────────
// Apsara, 2026-09-07: "maintain a separate catalogue for edge metals. keep on
// appending to that new catalogue as i generate proforma and keep the
// existing workflow catalogue for yard."
//
// The TRADE catalogue first — the selling words, learned from documents that
// have actually gone out (helpers/tradeCatalog.js). The YARD catalogue after
// it, READ ONLY, because on day one the trade list is empty and dropping the
// yard list would put us straight back into the bug she reported an hour ago:
// "send a proforma for autocasting tense" going unrecognised because nothing
// in the vocabulary matched.
//
// Nothing here writes to the yard list. That is the whole point of the
// separation: the yard's dropdown does not fill up with export phrasing, and
// her export documents stop carrying scale-house shorthand.
//
// Sorted LONGEST FIRST, so "Aluminium Auto Casting Scrap" wins over "Auto
// cast" and "Al rims(Dirty)" over "Al". Punctuation in an entry is escaped by
// catalogPattern rather than assumed away — "Al rims(Dirty)" has parentheses
// in it and would otherwise compile as a capture group.
function catalogMaterials() {
    if (_matCache && Date.now() - _matCacheAt < MAT_CACHE_MS) return _matCache;
    let list = [];
    try {
        list = require('./tradeCatalog').list() || [];
    } catch (e) {
        console.warn('[PROFORMA] could not read the trade catalogue:', e.message);
    }
    try {
        // Appended, not merged-and-sorted-together: the sort below is by
        // LENGTH, so both lists end up interleaved by specificity anyway, and
        // an entry that appears in both is deduplicated here rather than
        // producing two identical patterns.
        const yard = require('./itemTypes').loadCustomItemTypes() || [];
        const seen = new Set(list.map((x) => String(x).toLowerCase()));
        for (const y of yard) if (!seen.has(String(y).toLowerCase())) list.push(y);
    } catch (e) {
        console.warn('[PROFORMA] could not read the yard item catalog:', e.message);
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

// `\.(?!\d)` rather than a bare `.` in the terminator: a period INSIDE a
// number is a decimal point, not a clause end. With the bare version "Copper
// Millberry 99.9%" was captured as "Copper Millberry 99" — a different grade
// at a different price on a document a buyer pays against.
//
// The position a material occupies in her sentence — "21 MT of X at 8450",
// "material is X". Hoisted out of materialIn so materialPhrase() below reads
// from the same one; two copies of this and they drift.
const MATERIAL_CUE = /\b(?:material\s+(?:is\s+|of\s+)?|\d[\d,.]*\s*(?:mt|metric tons?|tons?|tonnes?)\s+of\s+|\bof\s+)([A-Za-z0-9][A-Za-z0-9&./%+'\- ]{1,40}?)(?=\s*(?:$|[,;]|\.(?!\d)|\bat\b|\brate\b|\bfor\b|\bwith\b|\$|\d[\d,]*\s*(?:mt|per)\b))/i;

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
    const cue = MATERIAL_CUE.exec(t);
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

// One incoterm list, used by the term parser AND by the port parser to
// reject a second incoterm ("change from FOB to CIF" must not read CIF as a
// place). Two copies would drift.
const INCOTERM = /\b(cif|fob|cfr|cnf|exw|ddp|dap|fca|fas|dat|cpt|cip)\b/i;

// ── HER WORDS BEAT MY TIDYING ────────────────────────────────────────────
// Apsara, 2026-09-07: "a brand-new buyer still my update should win."
//
// materialIn() normalises to the catalog spelling, which is right for
// RECOGNITION — "autocasting" is a whisper artefact and "Auto cast" is what
// she meant. But it was also what went on the DOCUMENT, so:
//
//     she said "Aluminium Auto Casting Scrap"  → printed "Auto cast"
//     she said "Copper Millberry 99.9%"        → printed "Copper"
//     she said "Zorba 95/5"                    → printed "Zorba"
//
// Every one of those is her being MORE specific than my catalog, and I
// replaced it with less. "Copper" instead of "Copper Millberry 99.9%" is a
// different grade at a different price on a document a buyer pays against.
//
// THE TEST IS WHETHER SHE ADDED ANYTHING. Strip the recognised term out of
// what she said; if meaningful words remain, hers is the fuller description
// and hers is what goes on the paper. If nothing remains, she said the term
// itself — possibly mangled — and the tidy spelling is the improvement.
//
// Same shape as the buyer-vs-goods test: remove the part we recognised and
// look at what is left.
function materialPhrase(text) {
    const t = String(text || '');
    const canon = materialIn(t);
    if (!canon) return null;

    // What she actually said, in the position a material occupies.
    const m = MATERIAL_CUE.exec(t);
    const said = m ? m[1].trim().replace(/[.,]$/, '') : '';
    if (!said) return canon;

    // Guards already applied by materialIn's own cue branch, repeated here
    // because this branch can be reached when the CATALOG matched instead.
    if (NOT_A_MATERIAL.test(said) || /^\d[\d,.]*$/.test(said)
        || /^\d[\d,.]*\s*(?:mt|metric tons?|tons?|tonnes?)$/i.test(said)) return canon;

    const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
    // Her phrase has to CONTAIN what we recognised, or they are two different
    // things and the recognised one is the safer answer.
    if (!norm(said).includes(norm(canon))) return canon;

    // Residue that is ONLY an English ending is the whisper artefact, not her
    // being specific: "autocasting" minus "autocast" leaves "ing", which is
    // three characters and would have passed a bare length test. Stripped
    // before measuring, which is the difference between tidying a mishearing
    // and overwriting a grade.
    const extra = norm(said).replace(norm(canon), '').replace(/^(?:ing|ed|es|s)$/, '');
    // Two characters of residue is noise — a plural, a hyphen. More than that
    // is a grade, a purity, an alloy: information she added on purpose.
    return extra.length > 2 ? said : canon;
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
        parse: (t) => materialPhrase(t),
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
        // ── HOW MANY CONTAINERS ──────────────────────────────────────────
        // Apsara, 2026-09-07: "Multiple containers each take the next number,
        // not the same one repeated. 5 loads → 95, 96, 97, 98, 99."
        //
        // prepareProformaNumbers has minted one number per container all
        // along; the voice flow hardcoded the count to 1, so that loop always
        // ran once and her rule was structurally unreachable from here.
        //
        // Optional, defaulting to one, because most proformas are one
        // container and asking every time would be the form-in-disguise this
        // flow exists to avoid. She says "2 containers" when it is two.
        key: 'containers',
        optional: true,
        fallback: 1,
        parse: (t) => {
            // The SAME parser the booking-request flow uses. A container
            // count is a container count, and two implementations of "how
            // many boxes" would drift — this one already knows "2x40HC",
            // "two 40 high cubes" and "a couple", and already refuses a bare
            // number in a sentence.
            try {
                const { count } = require('./bookingRequest').containersIn(t);
                return count;
            } catch (e) {
                console.warn('[PROFORMA] container parser unavailable:', e.message);
                return null;
            }
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
            // "change FROM fob TO cif" — she names the old one first, and
            // taking the first match set it right back to what she was
            // changing away from. The destination is the one she means.
            const swap = /\bfrom\s+(cif|fob|cfr|cnf|exw|ddp|dap|fca|fas|dat|cpt|cip)\b[^.]{0,12}?\bto\s+(cif|fob|cfr|cnf|exw|ddp|dap|fca|fas|dat|cpt|cip)\b/i.exec(t);
            if (swap) return swap[2].toUpperCase();
            const m = INCOTERM.exec(t);
            return m ? m[1].toUpperCase() : null;
        },
    },
    {
        // ── "CIF BUSAN" IS TWO FACTS ─────────────────────────────────────
        // Apsara, 2026-09-07: "i have asked to change trade terms to cif
        // busan still it was not updating."
        //
        // It half-updated, which is worse than not updating. The term parser
        // took "CIF" — which was ALREADY the default, so nothing on screen
        // changed — and "Busan" was dropped on the floor. port_discharge was
        // hardcoded to '' in the draft handed to the generator, so the
        // document would have gone out with no port of discharge at all and
        // she would have found out from the buyer.
        //
        // An incoterm is written WITH its named place — that is what the term
        // means. CIF Busan and CIF Qingdao are different prices. So the port
        // is read from the same phrase, and it is a field of its own rather
        // than text glued onto the term, because proformaPdf.js prints them
        // in two different places.
        key: 'port_discharge',
        optional: true,
        fallback: '',
        parse: (t) => {
            // Right after the incoterm — the standard way it is written and
            // said. Stops at a clause end so "CIF Busan, 21 MT" does not take
            // the quantity with it.
            const m = /\b(?:cif|fob|cfr|cnf|exw|ddp|dap|fca|fas|dat)\s+([A-Za-z][A-Za-z\s.'-]{1,28}?)(?=\s*(?:$|[,.;]|\band\b|\bat\b|\brate\b|\bpayment\b|\d))/i.exec(t);
            if (m) {
                const v = m[1].trim().replace(/[.,]$/, '');
                // "CIF terms" / "FOB basis" are not places. Nor is a second
                // incoterm, which is what "change from FOB to CIF" produces.
                if (!/^(terms?|basis|price|value|only|now|instead|to|from|and)$/i.test(v)
                    && !INCOTERM.test(v)) return v.toUpperCase();
            }
            // Said on its own — "port of discharge is Busan", "discharge
            // Busan". Deliberately NOT a bare "to Busan": that collides with
            // the consignee's own "to X", and getting the buyer wrong is a
            // worse failure than leaving a port blank.
            const p = /\b(?:port\s+of\s+discharge|discharge\s+port|discharge|pod)\s*(?:is\s+|:\s*|at\s+)?([A-Za-z][A-Za-z\s.'-]{1,28}?)(?=\s*(?:$|[,.;]|\band\b|\bat\b|\d))/i.exec(t);
            if (p) {
                const v = p[1].trim().replace(/[.,]$/, '');
                if (v && !/^(is|the|a|an|port)$/i.test(v)) return v.toUpperCase();
            }
            return null;
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
const START_VERB = /\b(create|make|raise|draw\s+up|prepare|prep|generate|issue|send|do|put\s+together|draft|new)\b/i;

// ── THE WORD ITSELF, AS WHISPER HEARS IT ─────────────────────────────────
// Apsara, 2026-09-07: "if i say proforma-sometimes it is getting treated as
// 'create a propharma' ..it is unable to resolve. instead it shows no
// bookings found."
//
// The pattern above demanded the literal string "proforma". Whisper writes
// "propharma", "profarma", "performa", "pro forma", "proform" — and every one
// of those failed to start a draft, fell through to the router, and came back
// "no bookings found", which is a baffling thing to hear after asking for an
// invoice.
//
// EDIT DISTANCE DOES NOT WORK HERE, and I measured before choosing rather
// than after. "propharma" is 3 edits from "proforma" — but so are "perform"
// and "forma", and "perform a scan" turning into a proforma is worse than the
// bug being fixed.
//
// So the rule is STRUCTURAL: a pro/pre/per prefix immediately followed by an
// f or ph, then up to two vowels, then an optional r, then an m. That is the
// shape of every mishearing and not the shape of "platform" or "pharma". The
// handful of real English words that still fit are stoplisted by name.
const PROFORMA_STOP = new Set([
    'perform', 'performs', 'performed', 'performing',
    'performance', 'performances', 'platform', 'platforms',
]);
const PROFORMA_SHAPE = /^(?:pro|pre|per)(?:f|ph)[aeiou]{0,2}r?m/;

function looksLikeProforma(word) {
    const t = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
    // "proform" is the shortest real mishearing at seven characters. Below
    // that the only strings matching the shape are things like "profm" — junk
    // no transcriber emits.
    //
    // I wrote this as `t.length < 7 && t !== 'proform'`, and the second half
    // was dead: "proform" is seven characters, so the first half is already
    // false for it. A condition that reads as load-bearing and never fires is
    // worse than no condition, because the next person keeps it.
    if (t.length < 7) return false;
    if (PROFORMA_STOP.has(t)) return false;
    return PROFORMA_SHAPE.test(t);
}

// Does the sentence name the document at all, however it was heard?
//
// "PI" and "P.I." stay EXACT. Two letters cannot be fuzzy-matched without
// swallowing half the language, and she says them clearly because they are
// initials.
function namesProforma(text) {
    const t = String(text || '');
    if (/\b(?:p\.?\s?i\.?|invoice)\b/i.test(t)) return true;
    const words = t.split(/[^A-Za-z]+/).filter(Boolean);
    for (let i = 0; i < words.length; i += 1) {
        if (looksLikeProforma(words[i])) return true;
        // Adjacent words joined too: "pro forma" and "pro pharma" arrive as
        // two tokens and neither half means anything on its own.
        if (i + 1 < words.length && /^(?:pro|pre|per)$/i.test(words[i])
            && looksLikeProforma(words[i] + words[i + 1])) return true;
    }
    return false;
}

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
    // The document has to be named, however it was heard.
    if (!namesProforma(t)) return false;

    // ...and either a verb asks for one, or the sentence OPENS with the word.
    // "proforma for Daekwang, 21 MT of copper at 8450" is a complete request
    // and she says it exactly that way; demanding a verb turned it into
    // nothing at all.
    const opener = /^\s*(?:hey\s+jarvis[,\s]*)?(?:a\s+|an\s+|the\s+)?([A-Za-z]+(?:\s+[A-Za-z]+)?)/.exec(t);
    const opensWithIt = !!(opener && namesProforma(opener[1]));
    if (!START_VERB.test(t) && !opensWithIt) return false;
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

// ── THE NAME SHE SAYS vs THE NAME ON THE DOCUMENT ────────────────────────
// Apsara, 2026-09-07: "when i say consignee name, try matching it with
// address book."
//
// She says "Daekwang". The address book has "Daekwang Metal Co., Ltd." with
// its full postal address, and that is what belongs at the top of a proforma
// — a document naming a buyer by the nickname she uses in the yard is not one
// their accounts department can file.
//
// prepareProformaNumbers already looked the address up, but only to fetch the
// ADDRESS LINES; the consignee NAME on the document stayed exactly as spoken.
// So the address block said "Daekwang Metal Co., Ltd." while the line above it
// said "Daekwang".
//
// AMBIGUOUS IS A QUESTION, NOT A GUESS. Two entries matching "Kim" is the same
// situation as two contacts matching a recipient, and the same answer: ask.
// Unknown is NOT a question — she may be quoting a new buyer who is not in the
// book yet, and refusing to draft for them would be worse than a document
// carrying the name she gave.
function resolveConsignee(said) {
    const raw = String(said || '').trim();
    if (!raw) return { ok: false, why: 'empty', said: raw, name: '' };
    let hit = null;
    try {
        hit = require('./addressBook').resolveAddress(raw);
    } catch (e) {
        console.warn('[PROFORMA] address book unreadable:', e.message);
        return { ok: true, why: 'error', said: raw, name: raw, lines: [] };
    }
    if (!hit) {
        // A buyer she has not saved yet. Her words go on the document, and
        // prepareProformaNumbers already warns that no address was found.
        return { ok: true, why: 'unknown', said: raw, name: raw, lines: [] };
    }
    if (hit.type === 'ambiguous') {
        return {
            ok: false, why: 'ambiguous', said: raw, name: raw,
            matches: (hit.matches || []).map((m) => String(m.raw || '').split('\n')[0].trim()).filter(Boolean),
        };
    }
    const lines = String((hit.entry && hit.entry.raw) || '').split('\n').map((l) => l.trim()).filter(Boolean);
    // The FIRST line of the saved address is the company as it is written
    // formally — that is the name the document wants. Falling back to her
    // words if the entry somehow has no first line, because a blank consignee
    // is worse than an informal one.
    const name = lines[0] || raw;
    return { ok: true, why: hit.type, said: raw, name, lines, entry: hit.entry };
}

// ── HER TERMS FOR THIS CUSTOMER, NOT MY GLOBAL DEFAULT ───────────────────
// Apsara, 2026-09-07: "Trade terms should be as per my update."
//
// DEFAULT_SHIPMENT_TERMS is 'CIF' for everyone, which is a guess dressed as a
// standard. Her real terms differ per buyer, and she already told the system
// so — 2026-08-22, recorded in helpers/proformaPricing.js: "PORT OF DISCHARGE,
// TRADE TERMS, PAYMENT TERMS SHOULD BE AUTO POPULATED." The dashboard reads
// them per customer; this flow ignored all three and used constants.
//
// So the order is: what she said in THIS sentence, then what this customer's
// last proforma used, then the global default. Her words always win — this
// only fills what she did not say.
function rememberedTerms(consignee) {
    const out = { trade_terms: '', port_discharge: '', payment_terms: '' };
    if (!consignee) return out;
    try {
        const past = require('./proformaPricing').lookup(consignee);
        if (past) {
            out.trade_terms = past.trade_terms || '';
            out.port_discharge = past.port_discharge || '';
            out.payment_terms = past.payment_terms || '';
        }
    } catch (e) {
        console.warn('[PROFORMA] could not read this customer\'s terms:', e.message);
    }
    return out;
}

// ── WHAT THE CUSTOMER CALLS IT ───────────────────────────────────────────
// Apsara, 2026-09-07: "customers can have it different name than my
// description."
//
// She is right, and it makes a decision I took an hour ago wrong. materialIn()
// now normalises what she says to HER catalog spelling — "autocasting" becomes
// "Auto cast" — and I then put that on the document. But "Auto cast" is yard
// shorthand. Daekwang's purchase order says something like "Aluminium Auto
// Casting Scrap", and a proforma whose description does not match the PO is a
// document their accounts team queries.
//
// So: RECOGNISE in her words, PRINT in theirs. Those are two different jobs
// and I had collapsed them into one.
//
// The customer's wording is already in her data. proformaPricing records
// {desc, rate, unit} per customer on every proforma generated, keeping a
// `display_desc` — so the description Daekwang has actually been sent before
// is on file, and it is the right thing to send again. Same principle as the
// ports and the item catalog: the vocabulary exists in her files, and my job
// is to look it up rather than invent one.
//
// Falls back to the catalog spelling, and then to exactly what she said. The
// order matters: a new customer with no history gets her tidy catalog name
// rather than whatever whisper heard, and a customer with history gets the
// words they already recognise.
function describeFor(consignee, material) {
    const raw = String(material || '').trim();
    if (!raw || !consignee) return raw;
    // ── NORMALISED FOR LOOKUP ONLY, NEVER FOR OUTPUT ─────────────────────
    // Apsara, 2026-09-07: "a brand-new buyer still my update should win."
    //
    // This line used to be `const said = materialIn(raw) || raw` AND the
    // function returned `said` when nothing matched — so my catalog tidying
    // came back out the other end and overwrote her. She would say "Aluminium
    // Auto Casting Scrap" and the document printed "Auto cast": materialPhrase
    // had correctly kept her words, and this undid it one function later.
    //
    // The normalised form is still needed to FIND the customer's wording —
    // catalogPattern("autocasting") does not match "Aluminium Auto Casting
    // Scrap", but catalogPattern("Auto cast") does. So it is used to search
    // and then thrown away.
    const lookupKey = materialIn(raw) || raw;
    try {
        const past = require('./proformaPricing').lookup(consignee);
        const seen = Object.keys((past && past.items) || {});
        // No early-out for an empty history: the filter below already returns
        // nothing and falls through to `said`. A mutation deleting the guard
        // changed no behaviour at all, which is the definition of code nobody
        // is maintaining — so it is gone rather than sitting here looking
        // load-bearing.

        // Their wording is matched against the SAME catalog pattern that
        // recognised hers — "Auto cast" matches "Aluminium Auto Casting
        // Scrap", because the pattern already allows an -ing ending and
        // ignores what sits around it. Longest first: if a customer has been
        // sent both "Auto cast" and "Aluminium Auto Casting Scrap", the fuller
        // description is the one their PO carries.
        const pat = catalogPattern(lookupKey);
        const hit = seen
            .filter((d) => pat.test(d) || catalogPattern(d).test(lookupKey))
            .sort((a, b) => b.length - a.length)[0];
        if (hit && hit.toLowerCase() !== raw.toLowerCase()) {
            console.log(`[PROFORMA] ${consignee} calls "${raw}" → "${hit}" — using their wording`);
            return hit;
        }
    } catch (e) {
        // No pricing history is the normal case for a new customer, and an
        // unreadable store must not cost her the document.
        console.warn('[PROFORMA] could not read the customer price history:', e.message);
    }
    // HER WORDS, unchanged. materialPhrase() has already decided whether the
    // tidy catalog spelling or her fuller description belongs here; re-tidying
    // it now is the bug this comment block is about.
    return raw;
}

function payload() {
    if (!draft) return null;
    const f = draft.fields;
    const mt = f.mt != null ? Number(f.mt) : Number(fallbackFor('mt'));
    const rate = Number(f.rate);

    // The address book's formal name on the document, her words kept beside
    // it. "Daekwang" is what she says; "Daekwang Metal Co., Ltd." is what
    // their accounts department files.
    const who = resolveConsignee(f.consignee);

    // HER TERMS FOR THIS BUYER, ahead of my global constants. Only fills what
    // she did not say — anything in this sentence still wins.
    const past = rememberedTerms(who.name || f.consignee);

    return {
        consignee: who.name || f.consignee || '',
        consignee_said: f.consignee || '',
        consignee_lines: who.lines || [],
        consignee_match: who.why || null,
        items: [{
            // What the CUSTOMER calls it, when we have sent them one before.
            // Recognition normalises to her catalog; the document does not.
            description: describeFor(f.consignee, f.material) || '',
            qty: mt,
            rate: rate,
        }],
        // Kept alongside, so the preview can say "you said X, they call it Y"
        // and she is never surprised by a word she did not choose.
        material_said: f.material || '',
        payment_terms: f.payment_terms || past.payment_terms || fallbackFor('payment_terms'),
        shipment_terms: f.shipment_terms || past.trade_terms || fallbackFor('shipment_terms'),
        port_discharge: f.port_discharge || past.port_discharge || '',
        // Which of the three came from HER last proforma to this buyer rather
        // than from a global constant. Shown in the preview so a remembered
        // term is never mistaken for one she just gave.
        remembered: ['payment_terms', 'shipment_terms', 'port_discharge'].filter(
            (k) => !f[k] && (k === 'shipment_terms' ? past.trade_terms
                : k === 'payment_terms' ? past.payment_terms : past.port_discharge)),
        shipment_allowance: DEFAULT_ALLOWANCE,
        containers: f.containers != null ? Number(f.containers) : Number(fallbackFor('containers')),
        // PER CONTAINER, times the count. 2 containers of 21 MT at 8450 is
        // $354,900, not $177,450 — and the read-back is the last place she
        // sees the figure before it goes to a customer.
        total: Math.round(mt * rate * (f.containers != null ? Number(f.containers) : Number(fallbackFor('containers'))) * 100) / 100,
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
        port_discharge: opts.port_discharge || p.port_discharge || '',
        payment_term: p.payment_terms,
        freight_label: /^FOB/i.test(trade) ? 'FOB (freight excluded)' : 'CIF (freight included)',
        buyer_po: '', buyer_po_date: '',
        country_of_origin: 'USA',
        shipment_allowance: p.shipment_allowance,
        // ── ONE BLOCK PER CONTAINER, WITH ITS NUMBER ─────────────────────
        // Apsara, 2026-09-07: "both invoice nd container no - not updated."
        //
        // This was hardcoded to a SINGLE block with container_no: '' — so the
        // preview she was shown carried an empty container number and, with
        // inv_no also defaulting to '', an empty invoice number too. The
        // numbering itself was working the whole time; it was minted AFTER
        // the preview was built and never reached it.
        //
        // A preview that shows blanks where the two identifying numbers go is
        // worse than no preview: it is a document that looks wrong for a
        // reason she cannot see, and the only thing to do with it is not
        // trust it.
        containers: (Array.isArray(opts.containerNos) && opts.containerNos.length
            ? opts.containerNos
            : new Array(Math.max(1, Number(p.containers) || 1)).fill(''))
            .map((no) => ({
                container_no: no,
                item_code: opts.item_code || null,
                items: p.items.map((i) => ({
                    desc: i.description, qty: i.qty, rate: i.rate, unit: 'MT',
                })),
            })),
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
        // The address book's formal name, resolved in payload().
        consignee: p.consignee,
        // `desc`, not `description` — the two shapes differ by that one word,
        // and pdfPayload() above exists because I once handed a generator an
        // object shaped the way I imagined. Copied from the email path, not
        // guessed.
        items: [{ desc: p.items[0].description, qty: p.items[0].qty, rate: p.items[0].rate }],
        // One container unless she said otherwise — and she can now say
        // otherwise. prepareProformaNumbers() mints one number per count, so
        // a wrong number here is a document with container numbers that do
        // not exist.
        containerCount: p.containers,
        trade_terms: p.shipment_terms,
        // Read from "CIF Busan" now, rather than hardcoded empty. Still never
        // INVENTED: if she did not say a port, this stays blank, because an
        // empty field on the document is a gap she can see and a guessed port
        // is a gap she cannot.
        port_discharge: p.port_discharge || '',
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
    const shown = p.items[0].description;

    // ── SAID IN HER WORDS, WRITTEN IN THEIRS, AND SHE IS TOLD ────────────
    // Apsara: "customers can have it different name than my description."
    // The document now carries the customer's own wording, taken from what
    // they have been sent before. That is right for the document and would be
    // wrong to do SILENTLY — she said "autocast" and the paper says
    // "Aluminium Auto Casting Scrap", and finding that out by reading the PDF
    // is a small betrayal. So the read-back names both, once, and only when
    // they actually differ.
    const swapped = p.material_said && shown
        && shown.toLowerCase() !== String(p.material_said).toLowerCase();

    // The term and its port read as one thing, because that is what an
    // incoterm IS — "CIF Busan", not "CIF" with a port hidden elsewhere. She
    // said the terms were not updating; half the reason was that the port
    // never appeared anywhere she could see.
    const terms = p.shipment_terms + (p.port_discharge ? ` ${p.port_discharge}` : '');

    // HER word for the buyer, not the address book's formal one. This is
    // spoken aloud, and "Daekwang Metal Co., Ltd." is a mouthful where
    // "Daekwang" is what she just said. The formal name is on the document
    // and in the preview panel, which is where it matters.
    const buyer = p.consignee_said || p.consignee;

    // The container count is SAID when it is more than one. "$354,900 total"
    // with no mention of two containers is a figure she cannot check.
    const boxes = p.containers > 1 ? `${p.containers} containers of ` : '';

    // ── A HALF-BUILT DRAFT HAS NO PRICE YET ──────────────────────────────
    // summary() was written for the preview, where every field is filled. It
    // is now also read when she PARKS a draft mid-build, and a missing rate
    // came out as "$NaN per MT — $NaN total" — which is not a number, it is a
    // bug wearing a dollar sign, and it appeared in the sentence confirming
    // her work had been safely put down.
    const priced = Number.isFinite(p.items[0].rate) && p.items[0].rate > 0;

    return `${boxes}${p.items[0].qty} MT of ${shown}`
        + (swapped ? ` (your "${p.material_said}")` : '')
        + ` for ${buyer}`
        + (priced ? ` at ${money(p.items[0].rate)} per MT — ${money(p.total)} total` : '')
        + `, ${terms}, ${p.payment_terms}.`;
}

// ── WHAT ELSE THE CONVERSATION IS ABOUT RIGHT NOW ────────────────────────
// Apsara, 2026-09-07: "if proforma is being generated.. Say if i want to send
// a mail asking for something, then it should be linked to this context na.."
//
// She is describing a SUBDIALOGUE, and the theory for it is old and settled.
// Grosz & Sidner, "Attention, Intentions, and the Structure of Discourse"
// (Computational Linguistics 12(3), 1986) splits a conversation into three
// things, and the one that matters here is the ATTENTIONAL STATE: a stack of
// focus spaces holding the objects that are salient right now. Starting a
// sub-task PUSHES a focus space; it does not replace the one underneath, and
// the entities in the outer space stay reachable throughout.
//
// So while a proforma for Daekwang is open, "send Yurim a mail asking for a
// booking" is not a new conversation. It is a segment pushed on top of one
// that already has a buyer, a material, a quantity and a set of terms in it,
// and an assistant that cannot see them makes her say all four again.
//
// RavenClaw (Bohus & Rudnicky, Eurospeech 2003; Computer Speech & Language
// 23(3), 2009) is the same idea built for real: a dialog STACK alongside a
// task tree, sub-tasks pushed and popped, the parent still there underneath.
// This is a much smaller version of that — one level, one open task — but the
// shape is theirs and it is worth naming rather than inventing badly.
//
// Returns null when nothing is in progress, which is the common case and must
// stay cheap.
function contextLine() {
    if (!draft) return null;
    const f = draft.fields;
    if (!f.consignee && !f.material) return null;   // nothing worth carrying
    const p = payload();
    if (!p) return null;

    const bits = [];
    if (p.consignee) bits.push(`for ${p.consignee_said || p.consignee}`);
    if (p.containers > 1) bits.push(`${p.containers} containers`);
    if (p.items[0].description) {
        bits.push(`${p.items[0].qty} MT of ${p.items[0].description}`);
    }
    if (Number.isFinite(p.items[0].rate) && p.items[0].rate > 0) {
        bits.push(`at $${p.items[0].rate}/MT`);
    }
    if (p.shipment_terms) {
        bits.push(p.shipment_terms + (p.port_discharge ? ` ${p.port_discharge}` : ''));
    }
    return `A proforma is being drafted right now ${bits.join(', ')}.`;
}

// The container count of the proforma in progress, for a booking request that
// does not name one. Returned as a number with its provenance, so the caller
// can SAY where it came from rather than quietly committing her to a carrier
// for a figure she never spoke.
function openContainerCount() {
    if (!draft) return null;
    const p = payload();
    const n = p && Number(p.containers);
    return Number.isFinite(n) && n >= 1 ? n : null;
}

// ── "LETS HOLD THIS AND WORK ON EMAIL" ───────────────────────────────────
// Apsara, 2026-09-07: "what if while creating a proforma-i want to send a
// mail,can i just say lets hold this and work on email?"
//
// She could not. That exact sentence was fed to answer(), absorbed nothing,
// and came back "What rate per metric ton?" — the assistant carrying on with
// its question while she asked it to stop. There was no way to put a
// half-built document down.
//
// This is the POP that Grosz & Sidner's focus stack (1986) implies and that
// the previous change only did halfway. Pushing a sub-task was already
// handled: an email drafted mid-proforma inherits the proforma's entities.
// What was missing is the ability to SAY the transition — to close the focus
// space explicitly rather than leaving it open and hoping nothing eats it.
//
// A parked draft is HELD, not finished and not cancelled. It comes back with
// every field intact, including the answers she had already given.
const PARK = /\b(?:hold|park|pause|shelve|stash)\s+(?:this|that|it|the\s+(?:proforma|pi|invoice))\b|\b(?:set|put)\s+(?:this|that|it)\s+aside\b|\bleave\s+(?:this|that|it)\s+(?:for\s+now|aside)\b|\bcome\s+back\s+to\s+(?:this|that|it)\b|\b(?:hold|park)\s+on\s+to\s+(?:this|that|it)\b/i;

// Coming back. "where were we" is in here because it is what people actually
// say after a detour, and it means nothing else while a draft is parked.
const RESUME = /\b(?:back\s+to|resume|carry\s+on\s+with|continue\s+with|finish|pick\s+up)\s+(?:the\s+)?(?:proforma|pi|invoice|that|it)\b|\bwhere\s+(?:were|was)\s+we\b|\b(?:unpark|unhold)\b/i;

// One slot. A second park overwrites the first, and that is SAID rather than
// silently losing the earlier one — the whole point of parking is not losing
// work.
let parked = null;

// Two hours. Long enough for an email detour, a phone call and a cup of tea;
// short enough that a draft abandoned yesterday does not reappear halfway
// through today's. Same reasoning as the referent TTL in voiceMemory.js: a
// context that outlives its usefulness is worse than one that expires.
const PARK_TTL_MS = 2 * 60 * 60 * 1000;

function parkedDraft() {
    if (!parked) return null;
    if (Date.now() - parked.at > PARK_TTL_MS) {
        console.log('[PROFORMA] the parked draft expired');
        parked = null;
        return null;
    }
    return parked;
}

function isPark(text) { return PARK.test(String(text || '')); }
function isResume(text) { return RESUME.test(String(text || '')); }

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

// ── WHAT THE DYNAMIC CLASSIFIER NEEDS TO SEE ─────────────────────────────
// helpers/draftIntent.js cannot tell "hold on, 8450" (an answer) from "hold
// this, Yurim needs a reply" (a park) without knowing what was just asked.
// So the state goes out with the sentence. Guarded, because a draft that has
// only just started has no items yet and summary() reaching into items[0] on
// one would throw inside a voice turn — which is how contextLine() failed.
function transitionState() {
    const held = parkedDraft();
    let line = '';
    if (draft) { try { line = summary(); } catch (e) { line = ''; } }
    else if (held) line = held.line || '';
    let q = null;
    if (draft) { try { q = nextQuestion(); } catch (e) { q = null; } }
    return { open: !!draft, parked: !!held, summary: line, question: q };
}

// `opts.transition` is the dynamic decision from helpers/draftIntent.js:
// 'park' | 'resume' | 'none'. When it is supplied it is AUTHORITATIVE — the
// classifier has already run these same patterns as its own fast path, so
// re-testing them here would give a second, quieter layer a vote on something
// that was already decided. When it is absent (every other caller, and the
// tests) the patterns decide exactly as before, which is what keeps this
// change from touching any path but the voice one.
function handle(text, opts) {
    const decided = (opts && opts.transition) || null;
    const wantsResume = decided ? decided === 'resume' : isResume(text);
    const wantsPark   = decided ? decided === 'park'   : isPark(text);

    // ── COMING BACK ──────────────────────────────────────────────────────
    // Checked FIRST, and before the `!open` early return, because the whole
    // point is that nothing is open when she says it.
    const held = parkedDraft();
    if (held && wantsResume) {
        draft = held.draft;
        parked = null;
        const q = nextQuestion();
        const p = payload();
        console.log('[PROFORMA] resumed the parked draft');
        return {
            stage: q ? 'asking' : 'preview',
            resumed: true,
            say: q ? `Back to it — ${summary()} ${q}` : summary(),
            have: Object.assign({}, draft.fields),
            fields: Object.assign({}, draft.fields),
            defaulted: p ? p.defaulted : [],
        };
    }

    const open = !!draft;

    // ── PUTTING IT DOWN ──────────────────────────────────────────────────
    // Before answer(), because otherwise "lets hold this and work on email"
    // is absorbed as an answer to whatever was last asked — which is exactly
    // what it did: it swallowed the sentence and repeated "What rate per
    // metric ton?" at her.
    if (open && wantsPark) {
        const line = summary();
        const overwritten = parkedDraft();
        // The line is stored with it: once `draft` is nulled there is nothing
        // left to summarise, and transitionState() has to describe the held
        // draft to the classifier so "lets get back to Daekwang" can be
        // recognised as a resume.
        parked = { draft, at: Date.now(), line };
        draft = null;
        console.log('[PROFORMA] parked the draft');
        return {
            stage: 'parked',
            say: `Held it — ${line} Say "back to the proforma" when you want it.`
                // A second park would otherwise lose the first without a word,
                // and not losing work is the entire reason this exists.
                + (overwritten ? ' Note: that replaces the one you parked earlier.' : ''),
            summary: line,
        };
    }

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
    // ── WHICH BUYER? ────────────────────────────────────────────────────
    // Two address-book entries matching what she said is the same situation
    // as two contacts matching a recipient, and gets the same answer: ask.
    // Guessing puts one company's name and another's address on one document.
    const who = resolveConsignee(draft.fields.consignee);
    if (!who.ok && who.why === 'ambiguous') {
        return {
            stage: 'preview', ready: false, blocked: 'consignee_ambiguous',
            say: `${line} Which ${draft.fields.consignee} — ${(who.matches || []).join(', ')}?`,
            summary: line, recipient: null, consignee: who,
            fields: Object.assign({}, draft.fields),
            defaulted: p.defaulted, pdf: pdfPayload(), draft: brainDraft(),
        };
    }

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
    materialIn, materialPhrase, MATERIAL_CUE, catalogMaterials, catalogPattern, describeFor, resolveConsignee, rememberedTerms,
    KNOWN_METALS, NOT_A_MATERIAL,
    _clearMaterialCache: () => { _matCache = null; _matCacheAt = 0; _patCache.clear(); },
    _clearParked: () => { parked = null; },
    handle, brainDraft, recipient, SEND_TO, contextLine, openContainerCount,
    isPark, isResume, parkedDraft, transitionState, PARK, RESUME, PARK_TTL_MS,
    isAmendment, markStaged, isStaged, CORRECTION_CUE, NOT_A_CONSIGNEE, COMPANY_TAIL, INCOTERM, START_VERB, NOT_A_START, CREATE_VERB,
    namesProforma, looksLikeProforma, PROFORMA_STOP, PROFORMA_SHAPE,
    isStart, start, answer, current, clear, missing, nextQuestion, payload, pdfPayload, summary,
    absorb, FIELDS, REQUIRED, DEFAULT_MT, DEFAULT_PAYMENT_TERMS, DEFAULT_SHIPMENT_TERMS,
};
