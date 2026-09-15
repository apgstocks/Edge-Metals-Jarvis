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
// reads 46,300 and so should the document beside it. A null prints as an
// em-dash, never as 0: a zero tare is a claim (the container weighed nothing)
// and a blank tare is an absence, and on a weight document those differ.
function fmtWeight(n) {
    const v = toNum(n);
    if (v === null) return '—';
    return Math.round(v).toLocaleString('en-US');
}
function fmtCount(n) {
    const v = toNum(n);
    if (v === null) return '—';
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
    const orDash = (v) => (String(v || '').trim() ? String(v).trim() : '—');

    // ── THE FIELDS THIS CUSTOMER'S BOL CARRIES ───────────────────────────
    // Apsara, 2026-09-16: "For different customer,i can have different field
    // in bol". The two fixed rows the template used to hard-code are built
    // here from helpers/bolLayouts.js.
    //
    // DATE IS FIRST AND CANNOT BE TURNED OFF. It is not in the layout's
    // optional list at all — an undated bill of lading is not a document
    // anyone can act on, and this is not a decision worth leaving to a
    // screen where it could be switched off by accident.
    //
    // The layout is passed IN (d.layout) rather than read from disk here, so
    // this stays a pure function of its argument: every test in tests/bol.js
    // calls it directly, and a helper that quietly loaded a file would make
    // those tests depend on whatever layouts happen to exist. The caller —
    // api.js's /api/bol/generate — resolves it.
    const factValue = {
        po_number:      { label: 'PO NUMBER',      value: orDash(d.po_number),      raw: d.po_number },
        appointment_id: { label: 'APPOINTMENT ID', value: orDash(d.appointment_id), raw: d.appointment_id },
        pickup:         { label: 'PICKUP',         value: pickup || '—',            raw: pickup },
        carrier:        { label: 'CARRIER',        value: orDash(d.carrier),        raw: d.carrier },
        driver:         { label: 'DRIVER',         value: orDash(d.driver),         raw: d.driver },
        container_no:   { label: 'CONTAINER',      value: orDash(d.container_no),   raw: d.container_no },
        seal_no:        { label: 'SEAL',           value: orDash(d.seal_no),        raw: d.seal_no },
    };

    const layout = Array.isArray(d.layout) && d.layout.length
        ? d.layout.filter((f) => f && f.shown !== false)
        // No layout supplied means the document she has always had: the seven
        // optional fields in their original order. A missing layout must never
        // mean an EMPTY document — the same "blank never silently means a
        // default" rule the rest of this project runs on, pointed the other way.
        : ['po_number', 'appointment_id', 'pickup', 'carrier', 'driver', 'container_no', 'seal_no'].map((key) => ({ key }));

    const cells = [{ label: 'DATE', value: d.bol_date ? formatDate(d.bol_date) : '', cls: '' }];
    for (const f of layout) {
        const known = factValue[f.key];
        if (known) { cells.push({ label: known.label, value: known.value, cls: blank(known.raw) }); continue; }
        // A field she named herself. 'notes' has its own block further down
        // the template and is handled there, so it is not a fact cell.
        if (f.key === 'notes') continue;
        if (String(f.key || '').startsWith('custom:')) {
            const label = String(f.label || '').trim();
            if (!label) continue;
            const v = (d.custom_fields || {})[f.key];
            cells.push({ label: label.toUpperCase(), value: orDash(v), cls: blank(v) });
        }
    }

    // Four to a row, which is the grid the template's .facts class is built
    // for. A short final row simply has fewer boxes.
    const fact_rows = [];
    for (let i = 0; i < cells.length; i += 4) {
        fact_rows.push('    <div class="facts">\n' + cells.slice(i, i + 4).map((c) =>
            `      <div class="fact"><div class="lbl">${escapeHtml(c.label)}</div><div class="v${c.cls}">${escapeHtml(c.value)}</div></div>`
        ).join('\n') + '\n    </div>');
    }

    const subs = {
        fact_rows: fact_rows.join('\n\n'),
        bol_no: escapeHtml(d.bol_no || ''),
        bol_date: escapeHtml(d.bol_date ? formatDate(d.bol_date) : ''),
        consignee_name: escapeHtml(consigneeName || '—'),
        consignee_address_lines: lines.map(escapeHtml).join('<br>'),
        // The seven per-field substitutions that used to live here are gone:
        // the template no longer names them, because fact_rows above decides
        // which of them appear and in what order. Left-behind substitutions
        // for placeholders that no longer exist read like live code and send
        // the next person looking for a template that stopped using them.
        item_rows,
        weight_unit: escapeHtml(unit),
        total_pieces: escapeHtml(fmtCount(t.pieces)),
        total_gross: escapeHtml(fmtWeight(t.gross_weight)),
        total_tare: escapeHtml(fmtWeight(t.tare_weight)),
        total_net: escapeHtml(fmtWeight(t.net_weight)),
        notes_block,
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

async function generateBolPdf(data, opts = {}) {
    const { html } = buildBolHtml(data);
    const browser = await puppeteer.launch({
        headless: true,
        args: opts.launchArgs || ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const { pdfFittedToOnePage } = require('./pdfFit');
        // One page. A BOL that runs to two is a BOL whose second page gets
        // left on the desk, and the signatures live at the bottom.
        const pdf = await pdfFittedToOnePage(page, {
            width: '8.5in',
            printBackground: true,
            preferCSSPageSize: true,
        }, { pageWidthMm: 215.9, pageHeightMm: 279.4, label: `bol ${data && data.bol_no ? data.bol_no : ''}`.trim() });
        // puppeteer resolves page.pdf() with a Uint8Array, not a Buffer —
        // res.send() JSON-stringifies it byte by byte without this.
        return Buffer.from(pdf);
    } finally {
        await browser.close();
    }
}

module.exports = {
    buildBolHtml, generateBolPdf, assertNoUnfilledPlaceholders,
    formatDate, formatTime, fmtWeight, fmtCount,
    totals, weightWarnings, addressLines,
};
