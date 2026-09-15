// ── helpers/packingList.js — the packing list, read off a photo ─────────────
//
// Apsara, 2026-09-16: "in edge metals,i want to create a sub tab under invoice
// -documents as packing list.it should allow to upload photo/pdf ,it scan and
// fill fields and then create fields like container nuber,booking no,invoice
// number,rows and columns of items."
//
// EDGE METALS. A packing list belongs to a container going out under an
// invoice; it has nothing to do with the yard, and she said so in the same
// breath ("edge metals invoice doesnt have anything to do with yard").
//
// ── THE SCAN FILLS A FORM. IT NEVER SAVES. ──────────────────────────────────
// This is the rule the whole file is arranged around, and it is the same one
// helpers/itemMatch.js and the BOL flow follow: the model proposes, she
// disposes. scan() returns fields; nothing here writes them. A scanner that
// files its own guesses produces a stack of documents nobody has read, and the
// first wrong container number is found by a customer.
//
// ── AND IT NEVER INVENTS ────────────────────────────────────────────────────
// Every field may come back null. A packing list that is genuinely missing a
// booking number must produce null, not a plausible one — a blank she can see
// and fill is recoverable, a confident wrong value is not. The prompt says so
// repeatedly because that is the failure this kind of extraction actually has.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

// ── WHAT A ROW IS ──────────────────────────────────────────────────────────
// Her words: "rows and columns of items". A packing list's columns vary by
// customer, but these are the ones that appear on every one Edge Metals
// issues. Anything the document has that is not here lands in `note` rather
// than being dropped — losing a column silently is worse than an untidy one.
const ROW_FIELDS = ['marks', 'description', 'pieces', 'gross_weight', 'net_weight', 'note'];

// Kept as the STRINGS on the document. The same rule as the BOL's weights
// (helpers/bols.js): "46,300" must read back as "46,300" after an edit that
// never touched it, and a scanned figure must be comparable to the paper it
// came from without a rounding step in between.
const str = (v) => (v == null ? '' : String(v).trim());

function newId() {
    return `PL_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// Matched on the CONTAINER, which is what identifies a packing list in
// practice — one container, one list. Normalised so "TCLU 123 456 7" and
// "tclu1234567" are the same container, because carriers space them
// differently on every document.
function keyOf(containerNo) {
    return str(containerNo).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function buildRecord(input, prev) {
    const i = input || {};
    const rows = Array.isArray(i.rows) ? i.rows : [];
    return {
        id: (prev && prev.id) || newId(),
        container_no: str(i.container_no),
        booking_no: str(i.booking_no),
        invoice_no: str(i.invoice_no),
        date: i.date || null,
        customer: str(i.customer),
        seal_no: str(i.seal_no),
        weight_unit: str(i.weight_unit) || 'lb',
        rows: rows.map((r) => {
            const out = {};
            for (const f of ROW_FIELDS) out[f] = str(r && r[f]);
            return out;
        }),
        // ── PROVENANCE ───────────────────────────────────────────────────
        // Which fields came off a scan rather than from her. Kept because six
        // weeks later "was this number read off the photo or typed?" is a
        // question with real money behind it, and because a screen that can
        // show it lets her check the scanned ones first.
        scanned_fields: Array.isArray(i.scanned_fields) ? i.scanned_fields.slice(0, 40) : [],
        source_filename: str(i.source_filename) || (prev && prev.source_filename) || null,
        created_at: (prev && prev.created_at) || new Date().toISOString(),
        created_by: (prev && prev.created_by) || i.created_by || null,
        updated_at: new Date().toISOString(),
        updated_by: i.created_by || null,
    };
}

function loadAll() {
    const rows = loadJson(cfg.PACKING_LISTS_FILE, []);
    return Array.isArray(rows) ? rows : [];
}

// Newest first — she comes back to a packing list to correct the one she just
// made far more often than to read an old one.
function list() {
    return loadAll().slice().sort((a, b) =>
        String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}

function get(id) {
    return loadAll().find((r) => r && r.id === id) || null;
}

// Upserted by container number, so re-scanning a document she has already
// filed corrects it rather than leaving two lists both claiming to describe
// TCLU1234567. A list with NO container number can only ever be new — blank
// keys must never match each other, the same trap helpers/oncePerSave.js
// documents.
async function save(input) {
    let saved = null;
    await mutateJson(cfg.PACKING_LISTS_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        const k = keyOf(input && input.container_no);
        const idx = (input && input.id)
            ? rows.findIndex((r) => r && r.id === input.id)
            : (k ? rows.findIndex((r) => r && keyOf(r.container_no) === k) : -1);
        saved = buildRecord(input, idx >= 0 ? rows[idx] : null);
        if (idx >= 0) rows[idx] = saved; else rows.push(saved);
        return rows;
    });
    return saved;
}

async function remove(id) {
    let removed = false;
    await mutateJson(cfg.PACKING_LISTS_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        const next = rows.filter((r) => !(r && r.id === id));
        removed = next.length !== rows.length;
        return next;
    });
    return removed;
}

// ── READING ONE OFF A PHOTO OR A PDF ───────────────────────────────────────
// `ask` is injectable for the same reason it is in helpers/itemMatch.js: tests
// must never reach the real Gemini or her live data, and a function that
// reaches for a network client on require() cannot be tested at all.
async function scan(base64, mimeType, { ask } = {}) {
    if (!base64) throw new Error('a file is required');

    const prompt = `You are reading a PACKING LIST for a container of scrap metal.
Extract what is actually printed. Return ONLY raw JSON — no markdown, no prose.

{
  "container_no": null,   // e.g. "TCLU1234567". The container/trailer this list describes.
  "booking_no": null,     // the carrier booking reference, if the document shows one
  "invoice_no": null,     // the commercial invoice number this list accompanies
  "seal_no": null,        // seal number, if shown
  "date": null,           // MM/DD/YYYY. If the document uses DD/MM/YYYY, still output MM/DD/YYYY.
  "customer": null,       // who it is going to — the consignee or buyer named on the list
  "weight_unit": null,    // "lb", "kg" or "mt" — whichever the weights on this document are in
  "rows": [               // one entry per LINE ITEM in the items table, in the order printed
    {
      "marks": null,        // marks/numbers or bundle/pallet id, if the table has such a column
      "description": null,  // the material as written, e.g. "Aluminium Extrusion 6063"
      "pieces": null,       // count of pieces/bundles/bales for this line
      "gross_weight": null, // exactly as printed, keep any thousands separators
      "net_weight": null,   // exactly as printed
      "note": null          // anything else in that row that does not fit the columns above
    }
  ]
}

RULES, in order of importance:

1. NEVER GUESS. If a field is not printed on the document, return null for it.
   A null she can see and fill in is recoverable; a plausible invented value is
   not, and will end up on a document sent to a customer.
2. Copy numbers EXACTLY as printed, as strings — keep commas, keep decimal
   points, do not round, do not convert units. "46,300" stays "46,300".
3. Return EVERY line in the items table, including ones that look like
   sub-totals only if they are genuinely separate line items. Do NOT include
   the table's TOTAL row as an item.
4. If the document is not a packing list at all, return {"not_a_packing_list": true}
   and nothing else.
5. Do not translate or tidy the descriptions. They are matched against stock
   by name elsewhere, and a helpful rewording breaks that.`;

    // ── NO TEST EVER REACHES THE REAL MODEL ──────────────────────────────
    // The standing rule in this project, and it was not holding: the first run
    // of tests/packing-list.js called live Gemini through the route, because
    // the ROUTE has no `ask` to inject and a key happens to be configured in
    // this environment. It fail-softed and the test passed, which is the worst
    // shape of that mistake — a suite quietly billing a real API and depending
    // on a network.
    //
    // JARVIS_TEST with no injected `ask` is a refusal, not a silent fallback.
    // A test that wants an answer injects one; a test that does not gets the
    // fail-soft path, which is what it was exercising anyway.
    if (!ask && process.env.JARVIS_TEST) {
        return { ok: false, error: 'Could not read that file. Fill the form in by hand.', fields: null };
    }

    const run = ask || (async (p, b64, mime) => {
        const { getClient, getModelName } = require('./gemini');
        const model = getClient().getGenerativeModel({
            model: getModelName(),
            generationConfig: { temperature: 0, responseMimeType: 'application/json' },
        });
        const result = await model.generateContent([
            { text: p },
            { inlineData: { mimeType: mime, data: b64 } },
        ]);
        return result.response.text();
    });

    let parsed = null;
    try {
        const raw = await run(prompt, base64, mimeType || 'application/pdf');
        parsed = typeof raw === 'string' ? JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '')) : raw;
    } catch (e) {
        // FAIL SOFT, and say so. A scan that cannot run leaves her with an
        // empty form she can type into — which is exactly where she would be
        // without this feature. Throwing would turn a helper into a blocker.
        console.error('[packingList] scan failed:', e.message);
        return { ok: false, error: 'Could not read that file. Fill the form in by hand.', fields: null };
    }

    if (!parsed || typeof parsed !== 'object' || parsed.not_a_packing_list) {
        return { ok: false, error: "That does not look like a packing list. Check the file, or fill the form in by hand.", fields: null };
    }

    return { ok: true, ...normaliseScan(parsed) };
}

// Turns whatever came back into the record shape, and reports WHICH fields the
// scan actually filled.
//
// Separated from scan() so it can be tested without a model in the loop — the
// shape-handling is where the bugs live, not the network call.
function normaliseScan(parsed) {
    const fields = {
        container_no: str(parsed.container_no),
        booking_no: str(parsed.booking_no),
        invoice_no: str(parsed.invoice_no),
        seal_no: str(parsed.seal_no),
        date: str(parsed.date),
        customer: str(parsed.customer),
        // Only a unit this system understands. A model answering "pounds" or
        // "LBS" must not become a unit string nothing else recognises.
        weight_unit: (() => {
            const u = str(parsed.weight_unit).toLowerCase();
            if (/^(lb|lbs|pound)/.test(u)) return 'lb';
            if (/^(kg|kilo)/.test(u)) return 'kg';
            if (/^(mt|tonne|metric)/.test(u)) return 'mt';
            return '';
        })(),
    };

    const rows = (Array.isArray(parsed.rows) ? parsed.rows : [])
        .map((r) => {
            const out = {};
            for (const f of ROW_FIELDS) out[f] = str(r && r[f]);
            return out;
        })
        // A row with nothing on it is not a row. Models pad tables.
        .filter((r) => ROW_FIELDS.some((f) => r[f]));

    // Named so the screen can mark them. Only fields that came back with a
    // VALUE count as scanned — flagging a null as "read from the document"
    // would tell her the scan looked and found nothing, which is not what
    // happened when the scan simply failed to read that box.
    const scanned_fields = Object.keys(fields).filter((k) => fields[k]);
    if (rows.length) scanned_fields.push('rows');

    return { fields, rows, scanned_fields };
}

module.exports = {
    ROW_FIELDS, keyOf, buildRecord, loadAll, list, get, save, remove,
    scan, normaliseScan,
};
