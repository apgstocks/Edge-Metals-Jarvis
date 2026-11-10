// ── helpers/ticketPackingList.js - the scale-ticket style packing list ─────
// Apsara, 2026-11-10: a supplier's scale ticket re-issued under the Edge Metals
// header as a "Packing List" (Exporter | Consignee, Invoice No / Date / Container /
// Seal, then Gross / Tare / Net rows per item). It is an ADDITIONAL document shape:
// it is only ever produced when the Documents screen's "Scale-ticket packing list"
// box is ticked AND invoice + packing list are generated separately, where it
// REPLACES that run's packing-list PDF. Nothing here is reached otherwise, so the
// existing packing list (and its truck/tare/chassis/boxes columns) cannot change.
//
// Colours are the packing list's own orange from assets/invoice-classic/template.html
// (--orange / --light-orange), not an approximation.
//
// The arithmetic is done HERE, from the ticket's printed Gross and Tare, never taken
// from the model that read the ticket: net = gross - tare; if pallets are listed,
// pallet tare = pallets x per-pallet tare and a second net follows. A figure that
// does not add up is reported, not silently "fixed".
const ORANGE = '#B5531A', LIGHT_ORANGE = '#FAE8D8';
const EXPORTER = { name: 'EDGE METALS INC', addr: '14750 DEVONSHIRE LN, FRISCO, TX 75035', tel: 'TEL: (310) 938-2525' };

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v) => { const t = String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''); if (t === '' || t === '-' || t === '.') return null; const n = Number(t); return Number.isFinite(n) ? n : null; };
const fmt = (n) => (n == null ? '' : Math.round(n).toLocaleString('en-US'));

// mm/dd/yyyy, whatever shape she or the ticket gave it in.
function mdy(v) {
    const s = String(v || '').trim();
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    if (m) return `${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}/${m[1]}`;
    m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/.exec(s);
    if (m) return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3].length === 2 ? '20' + m[3] : m[3]}`;
    return s;
}

// groups: [{ item, gross, tare, pallets, pallet_tare }] -> rows + problems
function computeGroups(groups) {
    const problems = [];
    const out = (Array.isArray(groups) ? groups : []).map((g, i) => {
        const gross = num(g.gross), tare = num(g.tare);
        const pallets = num(g.pallets) || 0;
        const palletTare = pallets ? (num(g.pallet_tare) == null ? 60 : num(g.pallet_tare)) : 0;
        const label = g.item || `item ${i + 1}`;
        if (gross == null || tare == null) problems.push(`${label}: gross and tare are both needed`);
        else if (tare > gross) problems.push(`${label}: tare (${fmt(tare)}) is more than gross (${fmt(gross)})`);
        const net = gross != null && tare != null ? gross - tare : null;
        const palletsTotal = pallets * palletTare;
        const net2 = pallets && net != null ? net - palletsTotal : null;
        if (net2 != null && net2 < 0) problems.push(`${label}: pallet tare is more than the net weight`);
        return { item: g.item || '', gross, tare, net, pallets, palletTare, palletsTotal, net2 };
    });
    return { rows: out, problems };
}

function buildTicketPackingHtml(d) {
    const data = d || {};
    const { rows, problems } = computeGroups(data.groups);
    const consignee = (Array.isArray(data.consignee_lines) ? data.consignee_lines : String(data.consignee || '').split(/\n/))
        .map((x) => String(x).trim()).filter(Boolean);
    const line = (cls, a, b, c) => `<tr class="${cls}"><td></td><td>${a}</td><td class="n">${b}</td><td class="n">${c}</td></tr>`;
    let body = '';
    rows.forEach((r, i) => {
        if (i > 0) body += '<tr class="gap"><td colspan="4"></td></tr>';
        body += `<tr><td class="ct">${i === 0 ? esc(data.container_no) : ''}</td><td class="it">${esc(r.item)}</td><td></td><td></td></tr>`;
        body += line('', 'Gross', fmt(r.gross), 'Lbs');
        body += line('', 'Tare', fmt(r.tare), 'Lbs');
        body += line('tot', 'Net', fmt(r.net), 'Lbs');
        if (r.pallets) {
            body += line('', `${fmt(r.pallets)} Pallets x ${fmt(r.palletTare)} lb`, '', '');
            body += line('', 'Tare', fmt(r.palletsTotal), 'Lbs');
            body += line('tot', 'Net', fmt(r.net2), 'Lbs');
        }
    });
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page{size:A4;margin:0}
:root{--orange:${ORANGE};--light-orange:${LIGHT_ORANGE}}
body{font-family:Helvetica,Arial,sans-serif;font-size:9pt;margin:0;padding:12mm}
.box{border:1px solid #000}
.bar{background:var(--orange);color:var(--light-orange);text-align:center;font-weight:700;font-size:18pt;height:15mm;display:flex;align-items:center;justify-content:center}
table{border-collapse:collapse;width:100%}
td{border:1px solid #000;padding:1.6mm 2mm;vertical-align:top}
.lbl{background:var(--light-orange);font-weight:700;font-size:9pt}
.party{height:24mm}
.n{text-align:right}
.head td{background:var(--orange);color:var(--light-orange);font-weight:700}
.ct,.it{font-weight:700}
.tot td{font-weight:700;background:var(--light-orange)}
.gap td{border-top:none;border-bottom:none;height:4mm}
</style></head><body><div class="box">
<div class="bar">Packing List</div>
<table>
<tr><td class="lbl" style="width:50%">Exporter</td><td class="lbl">Consignee</td></tr>
<tr><td class="party"><b style="font-size:10.5pt">${esc(EXPORTER.name)}</b><br>${esc(EXPORTER.addr)}<br>${esc(EXPORTER.tel)}</td>
<td class="party">${consignee.map((l) => esc(l)).join('<br>')}</td></tr>
</table>
<table><tr>
<td class="lbl" style="width:12%">Invoice No</td><td style="width:19%">${esc(data.invoice_no)}</td>
<td class="lbl" style="width:8%">Date</td><td style="width:11%">${esc(mdy(data.date))}</td>
<td class="lbl" style="width:11%">Container #</td><td style="width:17%">${esc(data.container_no)}</td>
<td class="lbl" style="width:9%">Seal #</td><td>${esc(data.seal_no)}</td></tr></table>
<table><tr class="head"><td style="width:20%">Container #</td><td>Item</td><td class="n" style="width:18%">Weight</td><td class="n" style="width:10%">Lbs</td></tr>${body}</table>
</div></body></html>`;
    return { html, rows, problems };
}

// opts.render is injectable (Chromium cannot launch in the test sandbox), same as
// helpers/invoicePdf.js. Refuses figures that do not add up rather than printing them.
async function generateTicketPackingPdf(data, opts = {}) {
    const { html, problems } = buildTicketPackingHtml(data);
    if (problems.length) { const e = new Error(`Scale-ticket packing list: ${problems.join('; ')}`); e.code = 'TICKET_PACKING_INVALID'; e.problems = problems; throw e; }
    const render = opts.render || require('./invoicePdf').renderModes;
    const out = await render(html, ['both'], opts);
    return out.both || out;
}


// ── Scan: read a supplier scale ticket (PDF or photo) into the boxes ─────────
// The model only TRANSCRIBES printed gross and tare per item; it never computes a net.
// She reviews and can edit every box before generating, and computeGroups() does the
// arithmetic, so a misread digit shows as an odd figure on her screen, not as a trusted
// total. _setReader lets tests run without the network.
async function defaultReader(base64, mime) {
    const { getClient, getModelName, extractJson } = require('./gemini');
    const model = getClient().getGenerativeModel({ model: getModelName(), generationConfig: { temperature: 0, responseMimeType: 'application/json' } });
    const prompt = `This is a supplier's scale (weighbridge) ticket for a container of scrap. Transcribe what is PRINTED. Return ONLY JSON:
{"ticket_no":null,"date":null,"container_no":null,"seal_no":null,"unit":null,
 "groups":[{"item":null,"gross":null,"tare":null,"pallets":null}]}
One group per material/commodity weighed (e.g. steel cased batteries, auto batteries). gross and tare are the printed numbers for that material, digits only, in the unit shown. pallets = a pallet count if printed, else null. Never compute a net. Use null for anything not printed.`;
    const res = await model.generateContent([{ text: prompt }, { inlineData: { mimeType: mime || 'application/pdf', data: base64 } }]);
    return extractJson(res.response.text());
}
let _reader = defaultReader;
function _setReader(fn) { _reader = fn || defaultReader; }
async function readTicket(base64, mime) {
    if (!base64) { const e = new Error('no ticket file'); e.code = 'NO_FILE'; throw e; }
    const raw = await _reader(base64, mime);
    if (!raw || typeof raw !== 'object') { const e = new Error('Could not read that ticket - type the weights in instead.'); e.code = 'UNREADABLE'; throw e; }
    const groups = (Array.isArray(raw.groups) ? raw.groups : []).slice(0, 12).map((g) => ({
        item: g && g.item ? String(g.item).slice(0, 80) : '',
        gross: g && num(g.gross) != null ? num(g.gross) : '',
        tare: g && num(g.tare) != null ? num(g.tare) : '',
        pallets: g && num(g.pallets) ? num(g.pallets) : '',
    }));
    return { ticket_no: raw.ticket_no || '', date: raw.date ? mdy(raw.date) : '', container_no: raw.container_no || '', seal_no: raw.seal_no || '', unit: raw.unit || '', groups };
}

module.exports = { readTicket, _setReader, buildTicketPackingHtml, generateTicketPackingPdf, computeGroups, mdy, ORANGE, LIGHT_ORANGE, EXPORTER };
