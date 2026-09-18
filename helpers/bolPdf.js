// ── helpers/bolPdf.js — Edge Metals Bill of Lading PDF ───────────────────────
// Apsara, 2026-09-15: "I want to create a BOL for edge metals with seller as
// edge metals .you have the address already.Buyer i will just give the name.It
// should be matched with address book as i type" — design C of three shown,
// plus the fields she caught me missing: "Driver name,Pickup date and time,PO
// number,appointment id,Gross trare net weight missing?"
//
// EDGE METALS, NOT EDGE YARD. She corrected me on exactly this: I had started
// designing it against outbound loads, which are the yard's sales. The shipper
// is fixed in the template and there is no seller parameter to get wrong.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
// It does not read a sale. Asked how she wanted to start one, her answer was
// "Type everything fresh", so this takes a plain object of typed values and
// renders it. That means the BOL can disagree with the Sales row for the same
// container, which is a real cost — so the ONE cross-check that matters is
// done here and surfaced, not silently corrected: see weightWarnings().
//
// It also does not borrow the pickup time from anywhere. The yard stores
// delivery_eta_date/time, which is when a trucker promised to DELIVER; a BOL
// records when the truck was LOADED. Printing one as the other would be
// plausible and wrong, and nobody would notice until a buyer disputed a
// delivery window. Pickup is typed, or it prints blank.
//
// Renders through headless Chromium like the invoice and proforma (see
// proformaPdf.js's header for why puppeteer and not pdfkit). Fonts are
// borrowed from assets/proforma-dc2/ rather than copied into assets/bol/ —
// the same two families, and a second copy on disk is a second thing to
// forget when one is replaced.

const fs   = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ASSETS_DIR = path.join(__dirname, '..', 'assets', 'bol');
const FONTS_DIR  = path.join(__dirname, '..', 'assets', 'proforma-dc2');

let _templateCache = null;
function loadTemplate() {
    if (_templateCache) return _templateCache;
    const fontFile = (name) => {
        const buf = fs.readFileSync(path.join(FONTS_DIR, name));
        return `data:font/ttf;base64,${buf.toString('base64')}`;
    };
    let html = fs.readFileSync(path.join(ASSETS_DIR, 'template.html'), 'utf8');
    html = html
        .replace('__FONT_DMSANS_REGULAR__',      fontFile('DMSans-Regular.ttf'))
        .replace('__FONT_DMSANS_SEMIBOLD__',     fontFile('DMSans-SemiBold.ttf'))
        .replace('__FONT_DMSANS_BOLD__',         fontFile('DMSans-Bold.ttf'))
        .replace('__FONT_IBMPLEXMONO_REGULAR__', fontFile('IBMPlexMono-Regular.ttf'))
        .replace('__FONT_IBMPLEXMONO_BOLD__',    fontFile('IBMPlexMono-Bold.ttf'));
    // HTML comments are stripped. Two reasons, and the first one bit
    // immediately: the template's own header comment discusses placeholders
    // by name ("{{seller_name}}"), and the unfilled-placeholder guard at the
    // bottom of buildBolHtml scans the whole document, so prose ABOUT a
    // placeholder read as an unfilled one and threw. Second, this file's
    // comments are notes to ourselves about why the design is what it is;
    // they have no business travelling inside a document sent to a buyer.
    html = html.replace(/<!--[\s\S]*?-->/g, '');

    _templateCache = html;
    return html;
}

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const toNum = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = parseFloat(String(v).replace(/,/g, ''));
    return isFinite(n) ? n : null;
};

// Weights print with thousands separators and no decimals — a scale ticket
// reads 46,300 and so should the document beside it.
//
// ── A BLANK PRINTS BLANK ────────────────────────────────────────────────────
// Apsara, 2026-09-18: "if i didnt enter anything keep it empty. dont place
// hyphen". These returned an em-dash, so a BOL with no tare printed a row of
// dashes across the weight columns.
//
// The distinction the dash was protecting is UNCHANGED and still matters: a
// null is never rendered as 0, because a zero tare is a CLAIM (the container
// weighed nothing) and a blank tare is an absence. Empty says "not recorded"
// just as well as a dash did, and it is what she asked for.
function fmtWeight(n) {
    const v = toNum(n);
    if (v === null) return '';
    return Math.round(v).toLocaleString('en-US');
}
function fmtCount(n) {
    const v = toNum(n);
    if (v === null) return '';
    return String(Math.round(v));
}

// ── DATES ────────────────────────────────────────────────────────────────
// BORROWED, NOT REWRITTEN. This file first shipped its own formatter
// rendering '15 Sep 2026', which was wrong twice over: it breaks Apsara's
// standing instruction from 2026-09-01 — "wherever date applicable it should
// be mm/dd/yyyy only" — and it would have put a differently-formatted date on
// the BOL than on the invoice for the very same container. helpers/invoicePdf
// reuses proformaPdf's formatDate for exactly this reason, so this does too:
// one date format on every document that leaves the building, changed in one
// place if it ever changes.
//
// It parses 'YYYY-MM-DD' with a regex rather than new Date(s), which JS reads
// as UTC midnight — in Texas that is the evening before, so a date-only
// string would render as the previous day. Already handled there.
const { formatDate } = require('./proformaPdf');

// '09:30' → '9:30 AM'. Returns '' for anything unparseable so the pickup box
// prints the date alone rather than the date followed by garbage.
function formatTime(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
    if (!m) return '';
    let h = Number(m[1]);
    const min = m[2];
    if (h < 0 || h > 23 || Number(min) > 59) return '';
    const ampm = h < 12 ? 'AM' : 'PM';
    h = h % 12; if (h === 0) h = 12;
    return `${h}:${min} ${ampm}`;
}

// ── THE ONE CHECK THAT EARNS ITS KEEP ────────────────────────────────────
// She types gross, tare and net herself, so nothing stops net from failing to
// equal gross minus tare. This does not CORRECT it — a document that quietly
// rewrites a weight she typed is worse than one that disagrees with her,
// because she would never find out. It returns warnings for the screen to
// show BEFORE she generates, and the PDF prints exactly what she typed.
//
// 1 lb of slack is allowed for rounding. Anything more is a typo worth a look.
function weightWarnings(items) {
    const out = [];
    (items || []).forEach((it, i) => {
        const g = toNum(it.gross_weight), t = toNum(it.tare_weight), n = toNum(it.net_weight);
        const where = it.description ? `"${it.description}"` : `line ${i + 1}`;
        if (g !== null && t !== null && n !== null && Math.abs((g - t) - n) > 1) {
            out.push(`${where}: net ${fmtWeight(n)} but gross minus tare is ${fmtWeight(g - t)}.`);
        }
        if (t !== null && g !== null && t > g) {
            out.push(`${where}: tare ${fmtWeight(t)} is heavier than gross ${fmtWeight(g)}.`);
        }
        if (n !== null && n <= 0) {
            out.push(`${where}: net weight is ${fmtWeight(n)}.`);
        }
    });
    return out;
}

function totals(items) {
    const sum = (key) => {
        // A column where NOTHING was entered totals to null, not 0. Printing
        // "0" under TARE when she left every tare blank asserts the containers
        // weighed nothing; the em-dash says she did not record it.
        let any = false, acc = 0;
        for (const it of (items || [])) {
            const v = toNum(it[key]);
            if (v !== null) { any = true; acc += v; }
        }
        return any ? acc : null;
    };
    return {
        pieces: sum('pieces'),
        gross_weight: sum('gross_weight'),
        tare_weight: sum('tare_weight'),
        net_weight: sum('net_weight'),
    };
}

// Splits a raw address-book block into lines. The address book stores `raw`
// as multi-line free text on purpose (see helpers/addressBook.js) and the
// first line is usually the company name, which is already printed as the
// consignee name — so a first line that merely repeats the name is dropped
// rather than printed twice.
function addressLines(raw, name) {
    const lines = String(raw || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (lines.length && name && norm(lines[0]) === norm(name)) lines.shift();
    return lines;
}

// A {{placeholder}} left in the output means the template gained a field this
// file does not fill. Silently shipping a literal "{{seal_no}}" to a driver is
// the kind of thing noticed by the buyer, not by us.
//
// Pulled out and exported so it can be tested on its own. Inline, it was
// unreachable from a test: every placeholder IS filled on the happy path, so
// deleting the guard entirely changed no observable behaviour and a mutation
// doing exactly that survived. A guard that cannot be shown to fire is
// indistinguishable from no guard.
function assertNoUnfilledPlaceholders(html) {
    const leftover = String(html || '').match(/\{\{[a-z_0-9]+\}\}/gi);
    if (leftover) throw new Error(`bol template has unfilled placeholders: ${[...new Set(leftover)].join(', ')}`);
    return true;
}

function buildBolHtml(data) {
    const d = data || {};
    const items = Array.isArray(d.items) ? d.items.filter(
        (it) => it && (String(it.description || '').trim() || toNum(it.gross_weight) !== null || toNum(it.net_weight) !== null)
    ) : [];
    const t = totals(items);
    const unit = String(d.weight_unit || 'lb').trim() || 'lb';

    const item_rows = items.map((it) => `      <tr>
        <td class="desc">${escapeHtml(it.description || '')}</td>
        <td>${escapeHtml(fmtCount(it.pieces))}</td>
        <td>${escapeHtml(fmtWeight(it.gross_weight))}</td>
        <td>${escapeHtml(fmtWeight(it.tare_weight))}</td>
        <td>${escapeHtml(fmtWeight(it.net_weight))}</td>
      </tr>`).join('\n');

    const pickupDate = d.pickup_date ? formatDate(d.pickup_date) : '';
    const pickupTime = formatTime(d.pickup_time);
    const pickup = [pickupDate, pickupTime].filter(Boolean).join(' · ');

    // Notes has its own block in the template rather than being a fact cell,
    // so the layout's decision about it is applied here. A layout that hides
    // Notes hides them even if the form carried some: the field being off for
    // this customer is the point, and printing them anyway would make the
    // switch a lie.
    const notesHidden = Array.isArray(d.layout) && d.layout.length
        && !d.layout.some((f) => f && f.key === 'notes' && f.shown !== false);
    const notes = notesHidden ? '' : String(d.notes || '').trim();
    const notes_block = notes
        ? `<div class="notes"><div class="lbl">NOTES</div>${escapeHtml(notes).replace(/\n/g, '<br>')}</div>`
        : '';

    const consigneeName = String(d.consignee_name || '').trim();
    const lines = Array.isArray(d.consignee_address_lines)
        ? d.consignee_address_lines.map((l) => String(l).trim()).filter(Boolean)
        : addressLines(d.consignee_address, consigneeName);

    // An empty value still renders its box, greyed — see the template's note.
    const blank = (v) => (String(v || '').trim() ? '' : ' empty');
    // Was orDash. Apsara, 2026-09-18: "if i didnt enter anything keep it
    // empty. dont place hyphen". The BOX still prints — see blank() above and
    // the template's note — it is only the dash inside it that goes.
    const orBlank = (v) => String(v || '').trim();

    // ── THE LAYOUT GRID ──────────────────────────────────────────────────
    // Apsara, 2026-09-16: "what if i want them in different places.change the
    // position and size", and on the required blocks: "Let me move them too."
    //
    // Twelve columns. Every block on the document — the consignee card, the
    // number, the date, each optional field, the goods table and the notes —
    // is placed by her layout. helpers/bolLayouts.js explains why a grid
    // rather than free X/Y; the short version is that a grid cannot produce
    // two boxes on top of each other or a field half off the paper, and those
    // are the only things free positioning would have bought that she would
    // never actually want.
    //
    // The layout is passed IN (d.layout) rather than read from disk, so this
    // stays a pure function of its argument — every test in tests/bol.js calls
    // it directly, and a helper that quietly loaded a file would make those
    // tests depend on whatever layouts happen to exist.
    const L = require('./bolLayouts');

    // Each block, as the HTML that goes inside its grid cell. A block with no
    // renderer here is skipped rather than guessed at.
    const factBox = (label, value, raw) => `<div class="fact"><div class="lbl">${escapeHtml(label)}</div><div class="v${blank(raw)}">${escapeHtml(value)}</div></div>`;

    const BLOCK = {
        // ── SHIPPER AND CONSIGNEE, SIDE BY SIDE ──────────────────────
        // Apsara, 2026-09-18: "make shipper and consignee next to each other."
        //
        // SHIPPER used to be a fixed card in its own strip ABOVE the grid, so
        // the two stacked: Edge Metals across the full width, the buyer across
        // the full width beneath it. They are the two ends of one shipment and
        // belong on one line, which is how the sample she approved reads.
        //
        // They are emitted as ONE cell holding two half-width cards, rather
        // than as two grid cells. That is what makes them inseparable: the
        // pair always adds to a whole row and always stays together, whatever
        // span a stored layout gives the consignee and wherever she moves it.
        // Shipper is still not a layout field — it is Edge Metals' own name on
        // Edge Metals' own document, not one of her fields — it simply travels
        // with the consignee now instead of being pinned to the top.
        consignee: () => `<div class="cards">`
            + `<div class="card"><div class="lbl">SHIPPER</div>`
            + `<div class="nm">Edge Metals Inc</div>`
            + `<div class="ad">14750 Devonshire Ln<br>Frisco, TX 75035<br>Tel (310) 938-2525</div></div>`
            + `<div class="card to"><div class="lbl">CONSIGNEE</div>`
            + `<div class="nm">${escapeHtml(consigneeName)}</div>`
            + `<div class="ad">${lines.map(escapeHtml).join('<br>')}</div></div>`
            + `</div>`,
        bol_date:  () => factBox('DATE', d.bol_date ? formatDate(d.bol_date) : '', d.bol_date),
        po_number:      () => factBox('PO NUMBER', orBlank(d.po_number), d.po_number),
        appointment_id: () => factBox('APPOINTMENT ID', orBlank(d.appointment_id), d.appointment_id),
        // ── ONE BOX, ONE LINE ────────────────────────────────────────
        // Apsara, 2026-09-18: "pickupdate should be in one ine", on the sample
        // she approved the same day, which reads "09/16/2026 · 9:00 AM".
        //
        // THIS REVERSES 2026-09-16. That day she said "pickup date and time
        // next to each other" and it was split into two boxes; seeing it on a
        // quarter-width cell, the pair is cramped and she asked for the single
        // line back. Her newer word wins, and the older one is recorded here
        // rather than quietly overwritten — the two readings of "next to each
        // other" (two boxes side by side, or two values on one line) are both
        // honest, and this is the one she wants.
        //
        // Still ONE layout field either way, which is why this is a renderer
        // change and nothing stored had to move.
        pickup: () => factBox('PICKUP',
            [pickupDate, pickupTime].filter(Boolean).join(' \u00b7 '),
            pickupDate || pickupTime),
        carrier:        () => factBox('CARRIER', orBlank(d.carrier), d.carrier),
        driver:         () => factBox('DRIVER', orBlank(d.driver), d.driver),
        container_no:   () => factBox('CONTAINER', orBlank(d.container_no), d.container_no),
        seal_no:        () => factBox('SEAL', orBlank(d.seal_no), d.seal_no),
        goods: () => `<table class="goods">
      <tr>
        <th class="desc">DESCRIPTION OF GOODS</th>
        <th style="width:52pt;">PIECES</th>
        <th style="width:66pt;">GROSS</th>
        <th style="width:60pt;">TARE</th>
        <th style="width:66pt;">NET</th>
      </tr>
${item_rows}
      <tr class="total">
        <td class="desc">Total <span class="unit">(${escapeHtml(unit)})</span></td>
        <td>${escapeHtml(fmtCount(t.pieces))}</td>
        <td>${escapeHtml(fmtWeight(t.gross_weight))}</td>
        <td>${escapeHtml(fmtWeight(t.tare_weight))}</td>
        <td>${escapeHtml(fmtWeight(t.net_weight))}</td>
      </tr>
    </table>`,
        notes: () => notes_block,
    };

    // A field she named herself. Its VALUE comes from the BOL's custom_fields,
    // keyed by the layout key.
    const customBlock = (f) => {
        const label = String(f.label || '').trim();
        if (!label) return '';
        const v = (d.custom_fields || {})[f.key];
        return factBox(label.toUpperCase(), orBlank(v), v);
    };

    // No layout supplied means the document she has always had. A missing
    // layout must NEVER mean an empty document — the same "blank never
    // silently means a default" rule the rest of this project runs on,
    // pointed the other way.
    const layoutFields = (Array.isArray(d.layout) && d.layout.length)
        ? L.decorate(d.layout)
        : L.defaultFields();

    const layout_rows = L.rowsFor(layoutFields).map((row) => {
        const cells = row.fields.map((f) => {
            const html = f.custom ? customBlock(f) : (BLOCK[f.key] ? BLOCK[f.key]() : '');
            if (!html) return '';
            return `<div style="grid-column:span ${f.span};">${html}</div>`;
        }).filter(Boolean);
        if (!cells.length) return '';
        return '    <div class="grid">\n      ' + cells.join('\n      ') + '\n    </div>';
    }).filter(Boolean).join('\n');

    const subs = {
        layout_rows,
        bol_no: escapeHtml(d.bol_no || ''),
        bol_date: escapeHtml(d.bol_date ? formatDate(d.bol_date) : ''),
        // The seven per-field substitutions that used to live here are gone:
        // the template no longer names them, because fact_rows above decides
        // which of them appear and in what order. Left-behind substitutions
        // for placeholders that no longer exist read like live code and send
        // the next person looking for a template that stopped using them.
        weight_unit: escapeHtml(unit),
        total_pieces: escapeHtml(fmtCount(t.pieces)),
        total_gross: escapeHtml(fmtWeight(t.gross_weight)),
        total_tare: escapeHtml(fmtWeight(t.tare_weight)),
        total_net: escapeHtml(fmtWeight(t.net_weight)),
        // ── THE SHIPPER'S SIGNATURE ──────────────────────────────────────
        // Apsara, 2026-09-16: "Give chandra bose sign to shipper".
        //
        // The same image the commercial invoice and the proforma already
        // carry — helpers/signature.js, one file and one loader, so every
        // document Edge Metals issues is signed identically and nobody has to
        // remember which template has it inlined. That module exists because
        // the signature was once pasted into a single template's HTML and so
        // could not be reused; adding a second copy here would rebuild the
        // exact problem it was written to remove.
        //
        // FAIL SOFT, inherited: an unreadable file yields an empty block of
        // the same height, so the layout is identical and the line can be
        // signed by hand. A BOL that refuses to render because a PNG was
        // missing would be far worse than one printing a blank rule — the
        // driver is waiting either way.
        //
        // The DRIVER and CONSIGNEE lines stay blank on purpose. Those are
        // signed on the spot by the people receiving the goods, and printing
        // a signature for them would be signing on someone else's behalf.
        shipper_signature: require('./signature').signatureBlockHtml({
            height: '30px', maxHeight: '28px', maxWidth: '150px',
            align: 'flex-end', justify: 'flex-start', marginBottom: 0,
        }).replace('<div style="height:30px;', '<div class="sigink" style="height:30px;'),
    };

    let html = loadTemplate();
    for (const [key, val] of Object.entries(subs)) {
        html = html.split(`{{${key}}}`).join(val);
    }

    assertNoUnfilledPlaceholders(html);

    return { html, totals: t, warnings: weightWarnings(items), item_count: items.length };
}

// ── QUEUED ──────────────────────────────────────────────────────────────────
// Apsara, 2026-09-18: "parallel simulatenous connection should be allowed in
// website and document". The whole launch-render-close is inside the slot, not
// just the launch — holding it for the launch alone would let two Chromiums
// overlap, which is the entire problem. See helpers/pdfQueue.js.
async function generateBolPdf(data, opts = {}) {
    return require('./pdfQueue').run(
        () => generateBolPdfUnqueued(data, opts),
        `bol ${(data && data.bol_no) || ''}`.trim());
}

async function generateBolPdfUnqueued(data, opts = {}) {
    // ── WHERE THE SECONDS GO ─────────────────────────────────────────────
    // Apsara, 2026-09-16: "why invoice and bol takes more time to generate?"
    // Measured rather than reasoned about — see helpers/pdfTiming.js. The
    // BOL's html is ~625KB, of which ~615KB is five fonts inlined as base64,
    // so `html` is reported alongside the phases: if setContent is the slow
    // one, that is why.
    const timer = require('./pdfTiming').start(`bol ${(data && data.bol_no) || ''}`.trim());
    const { html } = buildBolHtml(data);
    timer.mark('build-html');
    const browser = await puppeteer.launch({
        headless: true,
        args: opts.launchArgs || ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    timer.mark('launch-chromium');
    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        timer.mark('load-page');
        const { pdfFittedToOnePage } = require('./pdfFit');
        // One page. A BOL that runs to two is a BOL whose second page gets
        // left on the desk, and the signatures live at the bottom.
        const pdf = await pdfFittedToOnePage(page, {
            width: '8.5in',
            printBackground: true,
            preferCSSPageSize: true,
        }, { pageWidthMm: 215.9, pageHeightMm: 279.4, timer,
             label: `bol ${data && data.bol_no ? data.bol_no : ''}`.trim() });
        // puppeteer resolves page.pdf() with a Uint8Array, not a Buffer —
        // res.send() JSON-stringifies it byte by byte without this.
        return Buffer.from(pdf);
    } finally {
        await browser.close();
        timer.mark('close-chromium');
        timer.done({ html_kb: Math.round(html.length / 1024) });
    }
}

module.exports = {
    buildBolHtml, generateBolPdf, assertNoUnfilledPlaceholders,
    formatDate, formatTime, fmtWeight, fmtCount,
    totals, weightWarnings, addressLines,
};
