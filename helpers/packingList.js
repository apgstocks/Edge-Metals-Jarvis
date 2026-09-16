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
// THE COLUMNS EDGE METALS ACTUALLY USES, not a guess at them.
//
// The first version of this file invented a generic shape — marks,
// description, pieces, gross, net, note — without checking. Apsara has been
// issuing packing lists since 2026-09-09 through the invoice's "Separate
// invoice & packing list" flag, and hers is a WEIGHT BREAKDOWN per container:
//
//   Container | Gross | Truck | Container tare | Chassis | Boxes | Net (lbs) | Net (mt)
//
// Gross minus the four tare components is the net. That is the document a
// broker receives from her, so it is the document this must read and produce.
// A scanner reading fields her packing list does not have, feeding a PDF in a
// shape her customers have never seen, would have been worse than no feature.
//
// Same columns as assets/invoice-classic/template.html's packing table and
// helpers/invoicePdf.js's packingRowsHtml — deliberately, so a packing list
// made here and one made from an invoice are the same document.
// ── AND THEN SHE ASKED FOR THREE ───────────────────────────────────────────
// Apsara, 2026-09-16: "in packing list,i juxt want gross,tare ,net".
//
// Truck, container tare, chassis and boxes are four separate columns on the
// printed document, but they are four ways of saying TARE, and typing them
// into four narrow boxes is not what she wants from this form. So the stored
// row carries one `tare_lbs`.
//
// THE FOUR COMPONENTS ARE STILL ACCEPTED, because a scanned document has them
// printed separately and throwing them away would lose what the paper said.
// They are read, kept, and summed into tare_lbs when the document she is
// reading breaks them out — see tareOf. What she TYPES is one number; what a
// SCAN finds may be four, and both end up in the same place.
const ROW_FIELDS = [
    'container_no',
    'gross_weight_lbs',
    'tare_lbs',
    'net_weight_lbs',
    // Kept but not shown on her form. A scanned page that prints the tare
    // broken out still has those numbers, and discarding them would mean the
    // stored record disagrees with the paper it came from.
    'truck_lbs',
    'container_tare_lbs',
    'chassis_lbs',
    'boxes_weight_lbs',
    'net_weight_mt',
    // Anything the scanned page carries that does not fit above lands here
    // rather than being dropped — losing a column silently is worse than an
    // untidy one.
    'note',
];

// The columns the ITEM GRID shows, in order. Exported so the screen cannot
// drift from the store about which three she asked for.
//
// The container is NOT among them — Apsara, 2026-09-16: "remove container in
// item grid". It is a field at the top of the form and the key this store
// matches a packing list on, so putting it on every row asked her to type one
// number twice and gave it two places to disagree. Rows still CARRY one in the
// store, because a scanned page may list several; generatePdf and
// compareToInvoice both fall back to the header's when a row has none.
const FORM_FIELDS = ['gross_weight_lbs', 'tare_lbs', 'net_weight_lbs'];

const toNum = (v) => {
    const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '').trim());
    return isFinite(n) ? n : null;
};

// One tare from whichever the row carries. Her single figure wins when she has
// typed one; otherwise the four components are added up, which is what the
// printed document means by tare anyway.
//
// Returns null rather than 0 when there is nothing to add: a zero tare is a
// CLAIM that the container weighed nothing, and a blank is an absence. On a
// weight document those are different, and the BOL learned it the hard way.
function tareOf(row) {
    const r = row || {};
    const own = toNum(r.tare_lbs);
    if (own != null) return own;
    const parts = ['truck_lbs', 'container_tare_lbs', 'chassis_lbs', 'boxes_weight_lbs']
        .map((k) => toNum(r[k])).filter((n) => n != null);
    if (!parts.length) return null;
    return parts.reduce((a, b) => a + b, 0);
}

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
            // A scanned page that printed the tare in four columns gets one
            // tare filled in from them, so the form she opens shows a figure
            // rather than a blank beside four numbers she cannot see.
            if (!out.tare_lbs) {
                const t = tareOf(r);
                // Formatted with separators, like every other weight in this
                // project. A summed tare landing as "29500" beside a gross of
                // "46,300" reads as a different kind of number.
                if (t != null) out.tare_lbs = t.toLocaleString('en-US');
            }
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

    const prompt = `You are reading a source document for a PACKING LIST for a
container of scrap metal. Extract what is actually on it. Return ONLY raw JSON
— no markdown, no prose.

IT MAY BE EITHER OF TWO VERY DIFFERENT THINGS, and both are normal:

  (A) A PRINTED PACKING TABLE, with columns like Container / Gross / Tare /
      Net. One row per container.

  (B) A HANDWRITTEN TALLY of bundle or bale weights — a numbered list, one
      weight per line, often on a scrap of paper or a notepad photographed on
      a desk. It looks like:

          #1 - 3599 lbs
          #2 - 3475 lbs
          #3 - 4146 lbs
          ...

      This is the WEIGH SHEET the packing list is built from. Each numbered
      line is ONE BUNDLE and becomes ONE ROW. The single weight on the line is
      the bundle's NET weight — a bale on a scale has no truck, container or
      chassis under it, so there is no gross and no tare to find. Put it in
      net_weight_lbs and leave gross and tare null. Put the bundle's number
      (the "#1", "#2") in that row's "note".

      READ EVERY NUMBERED LINE, including ones that continue onto a second
      sheet or a second photo, and including ones that have been crossed out
      and rewritten — use the CORRECTED figure where a line was amended.
      Do not stop at the first few. A tally with fifteen lines must return
      fifteen rows.

      A heading like "3599 - weight" at the top is a note to herself, usually
      repeating the first entry. It is NOT a row and NOT a container number.

{
  "container_no": null,   // e.g. "TCLU1234567". Only if the document actually shows one — a handwritten weigh sheet usually does not, and a made-up container number is worse than a blank.
  "booking_no": null,     // the carrier booking reference, if the document shows one
  "invoice_no": null,     // the commercial invoice number this list accompanies
  "seal_no": null,        // seal number, if shown
  "date": null,           // MM/DD/YYYY. If the document uses DD/MM/YYYY, still output MM/DD/YYYY.
  "customer": null,       // who it is going to — the consignee or buyer named on the list
  "weight_unit": null,    // "lb", "kg" or "mt" — whichever the weights on this document are in
  "rows": [               // one row per CONTAINER (shape A) or per BUNDLE (shape B), in the order written
    {
      "container_no": null,        // the container this row is for, e.g. "TCLU1234567"
      "gross_weight_lbs": null,    // exactly as printed, keep thousands separators
      "tare_lbs": null,            // the TOTAL tare, if the document prints one single figure
      "net_weight_lbs": null,      // net after the tare, exactly as printed
      // Some packing lists break the tare into its parts instead of printing
      // one total. Fill these in when they are printed separately, and leave
      // tare_lbs null — do NOT add them up yourself. Adding is arithmetic the
      // reader can do; guessing which columns are tare components is not.
      "truck_lbs": null,           // the truck's own weight
      "container_tare_lbs": null,  // the container's tare weight
      "chassis_lbs": null,         // the chassis weight
      "boxes_weight_lbs": null,    // weight of boxes or packaging
      "net_weight_mt": null,       // net in metric tonnes if the document shows it
      "note": null                 // anything else in that row that does not fit the columns above
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

// ── THE PDF ────────────────────────────────────────────────────────────────
// Apsara, 2026-09-16, asked what the tab should do: "Scan ,fill data auto and
// generate pdf."
//
// It renders through assets/invoice-classic/template.html in its standalone
// packing mode — the SAME document the invoice's "Separate invoice & packing
// list" flag has produced since 2026-09-09. Not a second design: a packing
// list made here and one made from an invoice must be the same document, or
// her customers receive two different-looking papers from one company.
//
// ── IT BORROWS THE INVOICE'S HEADER ─────────────────────────────────────────
// That template's standalone packing list carries the full invoice header —
// exporter, invoice no, date, buyer address, terms, vessel, four ports. This
// form holds none of that and should not: she has typed it once already on the
// invoice for the same container.
//
// So the header comes from the stored invoice payload, found by CONTAINER,
// and if there is no invoice for that container this REFUSES rather than
// printing a headerless page. A packing list with a blank exporter block looks
// finished and is useless to a broker — the same reason extractInvoiceHeader
// fails loudly instead of rendering an empty header.
async function generatePdf(record, { renderer } = {}) {
    const rec = record || {};
    const container = str(rec.container_no);
    if (!container) {
        const e = new Error('This packing list has no container number, so there is no invoice to take the header from.');
        e.code = 'NO_CONTAINER';
        throw e;
    }

    const { getLatestInvoicePayload } = require('./invoiceVersions');
    const invoice = getLatestInvoicePayload(container);
    if (!invoice) {
        const e = new Error(`No invoice on file for ${container}. Make the invoice first — the packing list takes its header from it.`);
        e.code = 'NO_INVOICE';
        throw e;
    }

    // Her weight rows, in the shape helpers/invoicePdf.js's packingRowsHtml
    // reads. One lineItem per row, carrying only the packing block: the
    // packing list prints no rates and no totals, so the money fields on the
    // invoice's own line items are deliberately not copied across.
    // `line_items`, NOT `lineItems`. helpers/invoicePdf.js reads
    // `data.line_items`, and the first version of this handed it the camelCase
    // name — which is not an error, it is an EMPTY packing table. The PDF
    // rendered, the header was right, and every weight row was missing. A
    // wrong key on an optional field is the quietest bug there is.
    const line_items = (rec.rows || []).filter((r) => ROW_FIELDS.some((f) => str(r[f]))).map((r) => ({
        container_no: str(r.container_no) || container,
        weight: str(r.net_weight_mt),
        packing: {
            gross_weight_lbs: str(r.gross_weight_lbs),
            // One tare, however the row arrived at it — typed, or summed from
            // the four components a scanned page printed separately. tareOf is
            // the single answer to "what is the tare"; invoicePdf calls the
            // same function rather than repeating the rule.
            tare_lbs: (() => { const t = tareOf(r); return t == null ? '' : t.toLocaleString('en-US'); })(),
            net_weight_lbs: str(r.net_weight_lbs),
            net_weight_mt: str(r.net_weight_mt),
        },
    }));
    if (!line_items.length) {
        const e = new Error('This packing list has no weight rows to print.');
        e.code = 'NO_ROWS';
        throw e;
    }

    // The invoice's header, HER rows. Her own container/invoice numbers win
    // where she has typed one — the scan read them off the paper in front of
    // her, and a stale invoice payload should not overwrite that.
    const data = {
        ...invoice,
        container_no: container,
        inv_no: str(rec.invoice_no) || invoice.inv_no,
        line_items,
    };

    const { buildInvoiceClassicHtml, renderModes } = require('./invoicePdf');
    const { html } = buildInvoiceClassicHtml(data);
    const run = renderer || renderModes;
    const out = await run(html, ['packing'], {});
    return out.packing;
}

// ── DOES IT AGREE WITH THE INVOICE? ────────────────────────────────────────
// Apsara, 2026-09-16, asked whether a scanned packing list should be checked
// against its invoice: "Yes — warn me when they disagree."
//
// Compared per CONTAINER, on the two figures that matter: net lbs and net mt.
// Gross and the tare components are the packing list's own working; the net is
// the number both documents assert, and the one a customer will notice.
//
// Returns [] when there is nothing to compare against. "No invoice yet" is not
// a disagreement, and reporting it as one would teach her to ignore the list.
function compareToInvoice(record) {
    const rec = record || {};
    const container = str(rec.container_no);
    if (!container) return [];

    let invoice = null;
    try { invoice = require('./invoiceVersions').getLatestInvoicePayload(container); }
    catch (e) { console.error('[packingList] could not read the invoice to compare:', e.message); return []; }
    // The stored payload is whatever the Review & Generate screen posts, and
    // that screen sends `line_items` — the same key helpers/invoicePdf.js
    // reads. `lineItems` is accepted as well rather than assumed absent,
    // because a saved payload from an older client may carry either.
    const invLines = (Array.isArray(invoice && invoice.line_items) && invoice.line_items)
        || (Array.isArray(invoice && invoice.lineItems) && invoice.lineItems) || [];
    if (!invLines.length) return [];

    const num = (v) => {
        const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '').trim());
        return isFinite(n) ? n : null;
    };
    const byContainer = new Map();
    for (const li of invLines) {
        const k = keyOf((li && li.container_no) || invoice.container_no);
        if (k) byContainer.set(k, li);
    }

    const out = [];
    for (const r of (rec.rows || [])) {
        const k = keyOf(r.container_no || container);
        const li = byContainer.get(k);
        if (!li) continue;
        const p = li.packing || {};
        // A tonne of slack on lbs and a kilo on mt. Both documents are typed by
        // hand from the same scale tickets, and flagging a 1 lb rounding would
        // make the warning noise rather than information.
        const checks = [
            ['net weight (lbs)', num(r.net_weight_lbs), num(p.net_weight_lbs), 1],
            ['net weight (mt)',  num(r.net_weight_mt),  num(p.net_weight_mt) ?? num(li.weight), 0.001],
        ];
        for (const [what, mine, theirs, slack] of checks) {
            if (mine == null || theirs == null) continue;
            if (Math.abs(mine - theirs) <= slack) continue;
            out.push({
                container: r.container_no || container,
                field: what,
                packing_list: mine,
                invoice: theirs,
                // Said in words, because a client that renders the numbers and
                // not the sentence leaves her to work out which is which.
                message: `${r.container_no || container}: the packing list says ${what} ${mine.toLocaleString()}, the invoice says ${theirs.toLocaleString()}.`,
            });
        }
    }
    return out;
}

module.exports = {
    ROW_FIELDS, FORM_FIELDS, tareOf, keyOf, buildRecord, loadAll, list, get, save, remove,
    scan, normaliseScan, generatePdf, compareToInvoice,
};
