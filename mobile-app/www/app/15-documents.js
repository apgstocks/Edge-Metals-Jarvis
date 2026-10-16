// mobile-app/www/app/15-documents.js — split from mobile-app/www/index.html's <script> (helpers/sourceParts.js reconstructs the original)
// ── Tab shell ─────────────────────────────────────────────────────────────
async function renderDocumentsTab() {
  // Address book backs the consignee/buyer typeaheads on both sub-tabs.
  // Fetched once per tab ENTRY, not per keystroke.
  //
  // This used to be guarded by `if (!docsAddressBook.length)` — fetch once
  // and never again — which is exactly why an address added after the app
  // was opened stayed invisible until she logged out. The guard is gone;
  // refreshAddressBookCache() is fail-soft and keeps the last good list, so
  // re-entering the tab on a bad signal cannot blank the typeahead.
  await refreshAddressBookCache();
  $('viewRoot').innerHTML = `
    <section style="max-width:600px; margin:0 auto; padding:20px 16px 60px;">
      <div style="font-family:var(--font-mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--text-muted); margin-bottom:12px;">Documents</div>
      <div style="display:flex; gap:4px; margin-bottom:18px; border-bottom:1px solid var(--border-subtle);">
        ${[['proforma', 'Proforma'], ['invoice', 'Invoice'], ['bol', 'BOL']].map(([id, label]) => `
          <button class="btn doc-subtab-btn" data-subtab="${id}" style="flex:1; border:none; border-radius:0; border-bottom:2px solid ${docsSubTab === id ? 'var(--accent)' : 'transparent'}; background:transparent; padding:9px 10px; font-size:12.5px; font-weight:${docsSubTab === id ? '700' : '500'}; color:${docsSubTab === id ? 'var(--text-strong)' : 'var(--text-muted)'};">${label}</button>`).join('')}
      </div>
      <div id="docBody"></div>
    </section>`;
  $('viewRoot').querySelectorAll('.doc-subtab-btn').forEach(btn => btn.addEventListener('click', () => {
    if (btn.dataset.subtab === docsSubTab) return;
    docsSubTab = btn.dataset.subtab;
    renderDocumentsTab();
  }));
  if (docsSubTab === 'proforma') renderPfWizard();
  // Paints from whatever layout is already loaded, then refreshes it for
  // the consignee on the form. Drawn first rather than awaited so the tab
  // is never blank while a layout request is in flight.
  else if (docsSubTab === 'bol') { renderBolForm(); bolwLoadLayout(bolw && bolw.consignee); }
  else renderInvFlow();
}

// Reusable consignee/buyer typeahead. Returns the picked address-book entry
// through onPick so the caller can keep the full alias tag ("Joey/Taewon"),
// which the server needs for pricing memory and invoice-number history even
// though only the company name goes on the document.
// ── THE KEYBOARD COMES DOWN WHEN SHE PICKS ────────────────────────────────
// Apsara, 2026-09-17: "in app,when i type the seller or anything,and i
// selected something from list,my keyboard should collapse na..Why it is
// expanded?"
//
// Because every one of these lists calls preventDefault() on mousedown — and
// has to. A tap blurs the input first, which closes the list, and the tap then
// lands on nothing; this project fixed that twice ("consignee not clickable")
// and the fix is to keep focus in the input.
//
// Keeping focus is exactly what holds the soft keyboard up. So the pick now
// hands focus back explicitly, AFTER the value is applied: preventDefault
// keeps the tap alive, blur() ends the editing. Both, in that order.
//
// blurPicked() rather than input.blur() at each site, so the reason lives in
// one place and a new type-ahead copied from an old one cannot lose it.
function blurPicked(el) {
    try { if (el && typeof el.blur === 'function') el.blur(); } catch (e) {}
}

function wireDocTypeahead(inputId, listId, onPick, onType) {
  const input = $(inputId), box = $(listId);
  if (!input || !box) return;
  const close = () => { box.classList.add('hidden'); box.innerHTML = ''; };
  input.addEventListener('input', () => {
    if (onType) onType();
    const q = input.value.trim().toLowerCase();
    if (!q) return close();
    const matches = docSearchAddressBook(q).slice(0, 8);
    if (!matches.length) return close();
    box.innerHTML = matches.map((m, i) => `<div class="ac-item" data-idx="${i}">${esc(docEntryLabel(m))}</div>`).join('');
    box.classList.remove('hidden');
    box.querySelectorAll('.ac-item').forEach(el => el.addEventListener('mousedown', (ev) => {
      // mousedown + preventDefault: a click would blur the input first and
      // close this list before the click landed. The dashboard hit this
      // exact bug twice ("consignee not clickable").
      ev.preventDefault();
      onPick(matches[Number(el.dataset.idx)]);
      blurPicked(input);
      close();
    }));
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
}

// ── BILL OF LADING ────────────────────────────────────────────────────────
// Apsara, 2026-09-16: "Build bol into edge yard app and website(under
// documents)". The website half shipped yesterday; this is the same document
// on the phone, which is where she is standing when the driver is waiting.
//
// SAME SERVER, SAME TEMPLATE, SAME PDF. This posts to /api/bol/generate like
// the dashboard does — it does not build its own document. Two clients
// rendering their own version of one legal shipping paper is the divergence
// this codebase already guards against for invoices (see pickInvGroups).
//
// EDGE METALS IS THE SHIPPER even though this lives in the Edge Yard app.
// She said so directly when I first built it — "No.its for edge metals." —
// and the shipper block is fixed in assets/bol/template.html, not a field.
// Being able to raise it from the yard phone does not make it a yard document.
//
// ONE COLUMN. The dashboard puts four fact boxes on a row; that is unusable
// on a phone, so the fields stack and the goods lines are a small card each
// rather than a five-column grid. Same fields, same order, same names.
let bolw = null;

function resetBolForm() {
  bolw = {
    editingId: null,
    consignee: '', consigneeAddress: '',
    bolNo: '', date: bolTodayISO(),
    po: '', appointment: '',
    pickupDate: '', pickupTime: '',
    carrier: '', driver: '',
    container: '', seal: '',
    unit: 'lb', notes: '',
    customFields: {},
    items: [bolBlankItem(), bolBlankItem()],
    status: '',
  };
}
function bolBlankItem() { return { description: '', pieces: '', gross_weight: '', tare_weight: '', net_weight: '' }; }

// ── TODAY, WHERE THE BUSINESS IS ───────────────────────────────────────────
// Apsara, 2026-09-16: "by default bol date should be today date".
//
// It did default to today — via docTodayISO(), which is UTC. Frisco is UTC-5
// in summer, so from 7pm local the UTC date is already TOMORROW and an
// evening BOL printed tomorrow's date. Right for most of the working day and
// quietly wrong at the end of it.
//
// A SEPARATE function rather than a fix to docTodayISO, deliberately. That
// one also seeds the invoice date AND builds the folder guess for downloading
// a saved proforma or invoice — a guess that has to agree with the folder the
// SERVER filed it under. Quietly changing it would move a date on documents
// customers already receive and could make a download look for the wrong day.
// The same UTC problem is there and is worth fixing; it is worth fixing on
// purpose, not as a side effect of this.
function bolTodayISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

const bolNum = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isFinite(n) ? n : null;
};
function bolTotal(field) {
  // A column nobody filled totals to nothing, not 0 — the same rule the PDF
  // follows. "0" under TARE claims the containers weighed nothing.
  let any = false, acc = 0;
  for (const r of (bolw.items || [])) { const v = bolNum(r[field]); if (v !== null) { any = true; acc += v; } }
  return any ? acc : null;
}
const bolFmt = (n) => (n === null ? '—' : Math.round(n).toLocaleString('en-US'));

// Shown, never enforced. She types all three weights off a scale ticket; if
// they do not reconcile this says so and gets out of the way. The PDF prints
// exactly what she typed — a document that silently rewrites a weight on a
// page the buyer re-weighs against is the worst thing this screen could do.
function bolWarnings() {
  const out = [];
  (bolw.items || []).forEach((r, i) => {
    const g = bolNum(r.gross_weight), t = bolNum(r.tare_weight), n = bolNum(r.net_weight);
    const where = String(r.description || '').trim() ? `"${r.description.trim()}"` : `line ${i + 1}`;
    if (g !== null && t !== null && n !== null && Math.abs((g - t) - n) > 1) {
      out.push(`${where}: net ${bolFmt(n)} but gross minus tare is ${bolFmt(g - t)}.`);
    }
    if (g !== null && t !== null && t > g) out.push(`${where}: tare is heavier than gross.`);
    if (n !== null && n <= 0) out.push(`${where}: net weight is ${bolFmt(n)}.`);
  });
  return out;
}

// ── THE CUSTOMER'S FIELD LAYOUT, ON THE PHONE ─────────────────────────────
// Apsara, 2026-09-16: "For different customer,i can have different field in
// bol .. make the fields drag and drop in website as Design menu". She chose
// one layout for both clients, so this reads the same /api/bol-layouts the
// website's Design screen writes.
//
// THE SERVER RESOLVES IT AGAIN AT GENERATE TIME from the consignee name, so
// what prints does not depend on this phone being up to date. This is only
// about which boxes she is shown.
let bolwLayout = null;

// The seven catalogue fields in their original order — the document she has
// always had. Used when no layout has loaded yet or the lookup failed.
//
// FAIL OPEN, deliberately: a layout service that cannot be reached must show
// MORE fields, never fewer. A form that quietly drops Carrier because a
// request timed out produces a BOL that is wrong in a way nobody notices
// until a driver is turned away.
const BOLW_FALLBACK = ['po_number', 'appointment_id', 'pickup', 'carrier', 'driver', 'container_no', 'seal_no'];

function bolwLayoutFields() {
  if (!bolwLayout || !Array.isArray(bolwLayout.fields) || !bolwLayout.fields.length) {
    return BOLW_FALLBACK.map((key) => ({ key, shown: true }));
  }
  return bolwLayout.fields.filter((f) => f && f.shown !== false);
}
function bolwShows(key) {
  return bolwLayoutFields().some((f) => f.key === key);
}

// One catalogue field -> its markup. Pickup is two inputs under one layout
// entry, matching how it prints as one box.
function BOLW_FIELD_HTML(f, w, fld) {
  switch (f.key) {
    case 'po_number':      return fld('bolw_po', 'PO number', w.po);
    case 'appointment_id': return fld('bolw_appt', 'Appointment ID', w.appointment);
    case 'pickup':         return fld('bolw_pdate', 'Pickup date', w.pickupDate, 'date')
                                + fld('bolw_ptime', 'Pickup time', w.pickupTime, 'time');
    case 'carrier':        return fld('bolw_carrier', 'Carrier', w.carrier, 'text', 'Trucking company');
    case 'driver':         return fld('bolw_driver', 'Driver', w.driver, 'text', "Driver's name");
    case 'container_no':   return fld('bolw_container', 'Container / trailer', w.container);
    case 'seal_no':        return fld('bolw_seal', 'Seal number', w.seal);
    // Notes has its own box further down, next to the goods it annotates.
    case 'notes':          return '';
    default: break;
  }
  // A field she named herself on the Design screen. Keyed by the layout key
  // so its value travels with it; the id is derived from the key rather than
  // an index, or reordering the layout would move values between boxes.
  if (String(f.key || '').startsWith('custom:') && String(f.label || '').trim()) {
    const id = 'bolwc_' + f.key.replace(/[^a-z0-9]+/gi, '_');
    return `
    <div class="field">
      <label for="${id}">${esc(f.label)}</label>
      <input id="${id}" data-customkey="${esc(f.key)}" type="text" value="${esc((w.customFields || {})[f.key] || '')}" autocomplete="off">
    </div>`;
  }
  // An unknown key means this phone is older than the layout. Skipped rather
  // than guessed at — and it cannot cost her the field on the document,
  // because the server resolves the layout itself when it builds the PDF.
  return '';
}

async function bolwLoadLayout(consignee) {
  try {
    bolwLayout = await api(`/api/bol-layouts/resolve?customer=${encodeURIComponent(consignee || '')}`);
  } catch (e) {
    console.error('[bol] layout unavailable, showing every field:', e.message);
    bolwLayout = null;
  }
  await bolwSuggestNumber(consignee);
  renderBolForm();
}

// ── THE NUMBER ─────────────────────────────────────────────────────────────
// Apsara, 2026-09-16: "make bol number auto generate/customerbasis in
// sequence" -> "include year in bol number as in 26ECC001".
//
// Same rule as the website: only ever into an empty box, or over a suggestion
// this function made. A number she typed is hers — her answer was "Yours wins,
// counter untouched" — and on a phone, where the form is rebuilt on every
// render, overwriting it would be that much easier to do by accident.
//
// The suggestion is NOT what ends up on the document. /api/bol/generate
// reserves the real one when the box is posted empty, and the response says
// which; two phones open on one customer are shown the same suggestion and
// only one of them can have it.
let bolwAutoNo = null;
async function bolwSuggestNumber(consignee) {
  if (!bolw) return;
  const current = String(bolw.bolNo || '').trim();
  if (current && current !== bolwAutoNo) return;
  if (!String(consignee || '').trim()) return;
  try {
    const d = await api(`/api/bols/next-number?customer=${encodeURIComponent(consignee)}`
                      + `&date=${encodeURIComponent(bolw.date || '')}`);
    const n = String((d && d.bol_no) || '').trim();
    if (!n) return;
    const now = String(bolw.bolNo || '').trim();
    if (now && now !== bolwAutoNo) return;
    bolw.bolNo = n;
    bolwAutoNo = n;
  } catch (e) {
    console.error('[bol] could not suggest a number:', e.message);
  }
}

function renderBolForm() {
  if (!bolw) resetBolForm();
  const w = bolw;
  const warn = bolWarnings();
  const fld = (id, label, val, type, ph) => `
    <div class="field">
      <label for="${id}">${label}</label>
      <input id="${id}" type="${type || 'text'}" value="${esc(val || '')}" ${ph ? `placeholder="${esc(ph)}"` : ''} autocomplete="off">
    </div>`;

  $('docBody').innerHTML = `
    <div style="font-size:13px; color:var(--text-muted); margin-bottom:14px; line-height:1.55;">
      Shipper is Edge Metals. Type the buyer and it matches your address book.
    </div>

    <div class="field" style="position:relative;">
      <label for="bolw_consignee">Consignee</label>
      <input id="bolw_consignee" placeholder="Start typing a customer" autocomplete="off" value="${esc(w.consignee)}">
      <div id="bolwConsigneeList" class="ac-dropdown hidden"></div>
    </div>
    <div class="field">
      <label for="bolw_address">Consignee address</label>
      <textarea id="bolw_address" rows="3" placeholder="Fills in when you pick a name">${esc(w.consigneeAddress)}</textarea>
    </div>

    <!-- ── THE FIELDS THIS CUSTOMER'S LAYOUT ASKS FOR ───────────────────
         Apsara, 2026-09-16: "For different customer,i can have different
         field in bol". Designed on the website (Design → BOL), stored on
         the server, and read here — she chose "one layout, both places",
         so the phone must honour the same layout or the same customer gets
         two different documents under one BOL number.

         BOL number and Date are outside the loop and cannot be switched
         off. They are not in the layout's optional list at all, so this is
         not a rule the phone is choosing to enforce on its own.

         The ORDER comes from the layout, which is why these are generated
         rather than written out: a hand-written list in source order would
         look correct and silently ignore every drag she made. -->
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
      ${fld('bolw_no', 'BOL number', w.bolNo, 'text', '26ECC001')}
      ${fld('bolw_date', 'Date', w.date, 'date')}
      ${bolwLayoutFields().map((f) => BOLW_FIELD_HTML(f, w, fld)).join('')}
    </div>

    <div style="display:flex; align-items:center; justify-content:space-between; margin:16px 0 8px;">
      <div style="font-size:13px; font-weight:700; color:var(--text-strong);">Goods</div>
      <select id="bolw_unit" style="width:auto; padding:6px 10px; font-size:12px;">
        <option value="lb"${w.unit === 'lb' ? ' selected' : ''}>lb</option>
        <option value="mt"${w.unit === 'mt' ? ' selected' : ''}>mt</option>
      </select>
    </div>
    <div style="font-size:11.5px; color:var(--text-muted); margin-bottom:10px; line-height:1.5;">
      Net should equal gross minus tare. Leave a box empty and it prints as a dash, not a zero.
    </div>

    ${w.items.map((r, i) => `
      <div style="border:1px solid var(--border-subtle); border-radius:var(--radius-sm); padding:10px 12px; margin-bottom:10px;">
        <!-- Apsara, 2026-09-16: "make pieces and commoity next to each other
             in goods section of bol on app and gross,tare,net should be in
             same line". So the line reads the way she says it aloud —
             WHAT and HOW MANY together, then the three weights together,
             which is also the order they come off the scale.

             Pieces is given a fixed 78px rather than a share of the row: a
             count is two or three characters and a description is not, and
             an even split leaves the commodity box too narrow to read on a
             phone. -->
        <div style="display:grid; grid-template-columns:1fr 78px 34px; gap:8px; align-items:center; margin-bottom:8px;">
          <input data-bi="${i}" data-bf="description" placeholder="Commodity" value="${esc(r.description)}" autocomplete="off">
          <input data-bi="${i}" data-bf="pieces" inputmode="decimal" placeholder="Pieces" value="${esc(r.pieces)}" autocomplete="off" style="text-align:right;">
          <button type="button" class="btn bolw-del" data-bi="${i}" style="padding:6px 8px; font-size:13px;">&times;</button>
        </div>
        <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:8px;">
          <input data-bi="${i}" data-bf="gross_weight" inputmode="decimal" placeholder="Gross" value="${esc(r.gross_weight)}" autocomplete="off" style="text-align:right;">
          <input data-bi="${i}" data-bf="tare_weight"  inputmode="decimal" placeholder="Tare"  value="${esc(r.tare_weight)}" autocomplete="off" style="text-align:right;">
          <input data-bi="${i}" data-bf="net_weight"   inputmode="decimal" placeholder="Net"   value="${esc(r.net_weight)}" autocomplete="off" style="text-align:right;">
        </div>
      </div>`).join('')}

    <button type="button" id="bolwAddRow" class="btn" style="font-size:12.5px; padding:8px 12px;">+ Add line</button>

    <div style="margin-top:14px; font-family:var(--font-mono); font-size:12px; color:var(--text-muted); line-height:1.7;">
      Pieces ${bolFmt(bolTotal('pieces'))} · Gross ${bolFmt(bolTotal('gross_weight'))} · Tare ${bolFmt(bolTotal('tare_weight'))}<br>
      <strong style="color:var(--text-strong);">Net ${bolFmt(bolTotal('net_weight'))} ${esc(w.unit)}</strong>
    </div>

    ${warn.length ? `
      <div style="margin-top:12px; border:1px solid var(--status-warning, #d69e2e); border-radius:var(--radius-sm); padding:10px 12px; font-size:12.5px; color:var(--status-warning, #d69e2e); line-height:1.6;">
        ${warn.map(esc).join('<br>')}
        <div style="color:var(--text-muted); margin-top:6px; font-size:11.5px;">The PDF prints exactly what you typed — nothing here is changed for you.</div>
      </div>` : ''}

    ${bolwShows('notes') ? `
    <div class="field" style="margin-top:14px;">
      <label for="bolw_notes">Notes</label>
      <textarea id="bolw_notes" rows="2" placeholder="Prints under the goods table">${esc(w.notes)}</textarea>
    </div>` : ''}

    <div style="display:flex; gap:10px; margin-top:16px;">
      <button type="button" id="bolwPreview" class="btn" style="flex:1;">Preview</button>
      <button type="button" id="bolwGenerate" class="btn btn-primary" style="flex:1;">Generate</button>
    </div>
    <div id="bolwStatus" style="margin-top:10px; font-size:12.5px; color:var(--text-muted); min-height:18px;">${esc(w.status || '')}</div>

    <div style="margin-top:22px; padding-top:14px; border-top:1px solid var(--border-subtle);">
      <div style="font-size:13px; font-weight:700; color:var(--text-strong); margin-bottom:8px;">Saved bills of lading</div>
      <div id="bolwSaved" style="font-size:12.5px; color:var(--text-muted);">Loading…</div>
    </div>`;

  // ── Consignee type-ahead ────────────────────────────────────────────────
  // The shared wireDocTypeahead, which already carries the three rules this
  // app learned the hard way: mousedown not click, selection by position not
  // entry.id, and a search that matches the raw address text as well as the
  // aliases.
  wireDocTypeahead('bolw_consignee', 'bolwConsigneeList', (entry) => {
    bolw.consignee = docConsigneeName(entry);
    bolw.consigneeAddress = entry.raw || '';
    $('bolw_consignee').value = bolw.consignee;
    $('bolw_address').value = bolw.consigneeAddress;
    // The customer is known, so show the fields THEIR BOL carries. This
    // re-renders the form, which is why it goes last: the two assignments
    // above have to have landed in the model first or the redraw would
    // paint the name and address back as they were.
    bolwLoadLayout(bolw.consignee);
  }, () => { bolw.consignee = $('bolw_consignee').value; });

  // Plain fields write straight to the model and do NOT re-render — a
  // repaint on every keystroke throws away the caret, which on a phone means
  // the cursor jumping to the end of every box as you type.
  const bind = (id, key) => { const el = $(id); if (el) el.addEventListener('input', () => { bolw[key] = el.value; }); };
  bind('bolw_address', 'consigneeAddress'); bind('bolw_no', 'bolNo'); bind('bolw_date', 'date');
  bind('bolw_po', 'po'); bind('bolw_appt', 'appointment');
  bind('bolw_pdate', 'pickupDate'); bind('bolw_ptime', 'pickupTime');
  bind('bolw_carrier', 'carrier'); bind('bolw_driver', 'driver');
  bind('bolw_container', 'container'); bind('bolw_seal', 'seal');
  bind('bolw_notes', 'notes');

  // Her own fields, keyed by the layout key rather than by a fixed name —
  // this app cannot know what she will add on the Design screen.
  $('docBody').querySelectorAll('input[data-customkey]').forEach((el) => {
    el.addEventListener('input', () => {
      if (!bolw.customFields) bolw.customFields = {};
      bolw.customFields[el.dataset.customkey] = el.value;
    });
  });

  // The weight boxes DO re-render, because the running total and the
  // reconcile warning below them have to keep up. Only that part is redrawn.
  $('docBody').querySelectorAll('input[data-bi]').forEach((el) => {
    el.addEventListener('input', () => {
      bolw.items[Number(el.dataset.bi)][el.dataset.bf] = el.value;
      bolRepaintTotals();
    });
  });
  $('docBody').querySelectorAll('.bolw-del').forEach((el) => el.addEventListener('click', () => {
    bolw.items.splice(Number(el.dataset.bi), 1);
    if (!bolw.items.length) bolw.items = [bolBlankItem()];
    renderBolForm();
  }));
  $('bolwAddRow').addEventListener('click', () => { bolw.items.push(bolBlankItem()); renderBolForm(); });
  $('bolw_unit').addEventListener('change', () => { bolw.unit = $('bolw_unit').value; bolRepaintTotals(); });
  $('bolwPreview').addEventListener('click', () => bolSubmit(true));
  $('bolwGenerate').addEventListener('click', () => bolSubmit(false));
  loadSavedBolsApp();
}

// ── EDIT ─────────────────────────────────────────────────────────────────
// Apsara, 2026-09-16: "Edit Bol option also needed". The BOL used to save
// only the PDF, so there was nothing to reopen — helpers/bols.js now stores
// what was typed. Generating again upserts by BOL number, so a correction
// replaces the document rather than leaving two both claiming to be EM-1047.
async function loadSavedBolsApp() {
  const box = $('bolwSaved');
  if (!box) return;
  try {
    const { bols } = await api('/api/bols');
    const rows = bols || [];
    box.innerHTML = rows.length
      ? rows.slice(0, 20).map((b) => `
          <div style="display:flex; align-items:center; gap:10px; padding:8px 0; border-top:1px solid var(--border-subtle);">
            <div style="flex:1; min-width:0;">
              <div style="font-family:var(--font-mono); color:var(--text-strong);">${esc(b.bol_no || '(no number)')}${
                b.generated_count > 1 ? `<span style="color:var(--text-faint); font-size:11px;"> ×${b.generated_count}</span>` : ''}</div>
              <div style="color:var(--text-muted); font-size:11.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                ${esc(b.consignee_name || '—')}${b.container_no ? ' · ' + esc(b.container_no) : ''}${b.bol_date ? ' · ' + esc(b.bol_date) : ''}</div>
            </div>
            <button type="button" class="btn bolw-edit" data-id="${esc(b.id)}" style="font-size:12px; padding:6px 12px;">Edit</button>
            <button type="button" class="btn bolw-del" data-id="${esc(b.id)}" data-no="${esc(b.bol_no || '')}" style="font-size:12px; padding:6px 12px; color:var(--danger, #c0392b);">Delete</button>
          </div>`).join('')
      : 'None yet.';
    box.querySelectorAll('.bolw-edit').forEach((el) => el.addEventListener('click', () => bolEditApp(el.dataset.id)));
    box.querySelectorAll('.bolw-del').forEach((el) => el.addEventListener('click', () => bolDeleteApp(el.dataset.id, el.dataset.no)));
  } catch (e) {
    box.textContent = e.message;
  }
}

async function bolEditApp(id) {
  try {
    const { bol } = await api(`/api/bols/${encodeURIComponent(id)}`);
    if (!bol) return;
    bolw = {
      editingId: bol.id,
      consignee: bol.consignee_name || '', consigneeAddress: bol.consignee_address || '',
      bolNo: bol.bol_no || '', date: bol.bol_date || '',
      po: bol.po_number || '', appointment: bol.appointment_id || '',
      pickupDate: bol.pickup_date || '', pickupTime: bol.pickup_time || '',
      carrier: bol.carrier || '', driver: bol.driver || '',
      container: bol.container_no || '', seal: bol.seal_no || '',
      unit: bol.weight_unit || 'lb', notes: bol.notes || '',
      customFields: bol.custom_fields || {},
      // Weights come back as the STRINGS she typed — see helpers/bols.js.
      // Parsing them would make "46,300" reappear as 46300 after an edit
      // that never touched that box.
      items: (bol.items || []).map((it) => ({
        description: it.description || '', pieces: it.pieces ?? '',
        gross_weight: it.gross_weight ?? '', tare_weight: it.tare_weight ?? '', net_weight: it.net_weight ?? '',
      })),
      status: `Editing ${bol.bol_no || 'this BOL'}. Generate replaces it.`,
    };
    if (!bolw.items.length) bolw.items = [bolBlankItem()];
    // Safe to re-render wholesale: this client's renderBolForm rebinds every
    // listener it needs, including the consignee type-ahead, because it
    // rebuilds the markup each time. (The website's version wires the
    // type-ahead once against a form that is NOT rebuilt — same feature, two
    // shapes, and mixing up which is which leaves a dropdown that silently
    // stops matching after the first edit.)
    // The layout for THIS BOL's customer, which also re-renders the form —
    // so an edited BOL shows the boxes that customer's document carries,
    // not whichever set was on screen a moment ago.
    bolwLoadLayout(bolw.consignee);
    $('docBody').scrollTop = 0;
  } catch (e) {
    if ($('bolwStatus')) $('bolwStatus').textContent = e.message;
  }
}

// Apsara, 2026-09-16: "also add delete option in bol generated".
//
// Mirrors the website's bolDelete, and says the same two things in the
// confirm for the same reasons: the BOL NUMBER (a column of near-identical
// rows on a small screen is precisely where a generic "Delete this?" gets a
// reflex Yes on the wrong one), and that the generated PDF is KEPT — which
// is what the server actually does, and it changes what "delete" means here.
// This removes the saved FORM, so the BOL leaves this list and can no longer
// be edited or reissued; the copy that may already be with a driver stays in
// documents_saved/bol.
//
// If the row being deleted is the one currently open in the form, the form
// is reset — otherwise Generate would quietly re-create the record she just
// removed, under the same number.
async function bolDeleteApp(id, bolNo) {
  const label = bolNo ? `BOL ${bolNo}` : 'this bill of lading';
  if (!confirm(`Delete ${label}?\n\nIt will leave this list and cannot be edited or reissued.\n\nThe PDF already generated is KEPT.`)) return;
  try {
    await api(`/api/bols/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (bolw && bolw.editingId === id) {
      resetBolForm();
      bolw.status = `${label} deleted. The generated PDF is still saved.`;
      renderBolForm();
    } else if ($('bolwStatus')) {
      $('bolwStatus').textContent = `${label} deleted. The generated PDF is still saved.`;
    }
    loadSavedBolsApp();
  } catch (e) {
    if ($('bolwStatus')) $('bolwStatus').textContent = e.message;
  }
}

// Redraws only the totals line and the warning box, leaving every input — and
// the caret inside whichever one is focused — exactly where it was.
function bolRepaintTotals() {
  const holder = $('docBody');
  if (!holder) return;
  const totals = holder.querySelector('[data-bol-totals]') || (() => {
    const el = holder.querySelector('div[style*="font-family:var(--font-mono)"]');
    if (el) el.setAttribute('data-bol-totals', '1');
    return el;
  })();
  if (totals) {
    totals.innerHTML = `Pieces ${bolFmt(bolTotal('pieces'))} · Gross ${bolFmt(bolTotal('gross_weight'))} · Tare ${bolFmt(bolTotal('tare_weight'))}<br>` +
      `<strong style="color:var(--text-strong);">Net ${bolFmt(bolTotal('net_weight'))} ${esc(bolw.unit)}</strong>`;
  }
  const warn = bolWarnings();
  let box = holder.querySelector('[data-bol-warn]');
  if (!warn.length) { if (box) box.remove(); return; }
  if (!box) {
    box = document.createElement('div');
    box.setAttribute('data-bol-warn', '1');
    box.style.cssText = 'margin-top:12px; border:1px solid var(--status-warning, #d69e2e); border-radius:var(--radius-sm); padding:10px 12px; font-size:12.5px; color:var(--status-warning, #d69e2e); line-height:1.6;';
    if (totals && totals.parentNode) totals.parentNode.insertBefore(box, totals.nextSibling);
    else holder.appendChild(box);
  }
  box.innerHTML = `${warn.map(esc).join('<br>')}<div style="color:var(--text-muted); margin-top:6px; font-size:11.5px;">The PDF prints exactly what you typed — nothing here is changed for you.</div>`;
}

function bolPayload() {
  const w = bolw;
  return {
    bol_no: (w.bolNo || '').trim(), bol_date: w.date,
    consignee_name: (w.consignee || '').trim(), consignee_address: w.consigneeAddress,
    po_number: (w.po || '').trim(), appointment_id: (w.appointment || '').trim(),
    pickup_date: w.pickupDate, pickup_time: w.pickupTime,
    carrier: (w.carrier || '').trim(), driver: (w.driver || '').trim(),
    container_no: (w.container || '').trim(), seal_no: (w.seal || '').trim(),
    weight_unit: w.unit || 'lb', notes: w.notes,
    // Fields she named herself on the Design screen, keyed by the layout key.
    // Sent even when the current layout hides one: helpers/bols.js keeps the
    // value on purpose, so switching a field back on does not find it empty.
    custom_fields: w.customFields || {},
    items: (w.items || []).map((r) => ({
      description: String(r.description || '').trim(),
      pieces: r.pieces, gross_weight: r.gross_weight,
      tare_weight: r.tare_weight, net_weight: r.net_weight,
    })),
  };
}

async function bolSubmit(preview) {
  const body = bolPayload();
  const set = (msg) => { bolw.status = msg; if ($('bolwStatus')) $('bolwStatus').textContent = msg; };
  if (!body.consignee_name) return set('Who is it going to? Fill the consignee.');
  if (!body.items.some((it) => it.description || bolNum(it.net_weight) !== null || bolNum(it.gross_weight) !== null)) {
    return set('Add at least one line of goods.');
  }
  set(preview ? 'Building preview…' : 'Generating…');
  try {
    if (preview) {
      // Opened as a blob: the route is a POST behind the session, so there is
      // no URL that would carry the form with it.
      // API_BASE and the Bearer token, not a bare path: the app is a
      // Capacitor WebView served from its own origin, so a relative URL does
      // not reach the server at all and there is no session cookie to lean
      // on. Same shape as the documents download at the bottom of this file.
      const res = await fetch(API_BASE + '/api/bol/generate?preview=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `preview failed (${res.status})`);
      const blob = await res.blob();
      if (!blob.size) throw new Error('the preview came back empty');
      // ── NOT window.open. THIS WAS ALREADY KNOWN HERE ──────────────────
      // Apsara, 2026-09-16: "in bol,preview not opened".
      //
      // Android's WebView does not support real popup/multi-window behaviour
      // unless the host app wires up WebChromeClient.onCreateWindow, which
      // this Capacitor app does not — so window.open() silently no-ops. This
      // file already says so in two places, and her words the first time it
      // happened, on 2026-08-17, were "it is pressed, but nothing happening".
      // I copied the website's shape into the app and reintroduced a bug this
      // codebase had already found, fixed and written down.
      //
      // deliverExportedFile is what the proforma and invoice previews in this
      // same file use: it writes the PDF and hands it to whatever on the
      // phone opens PDFs.
      //
      // Named …-preview so a file sitting in Downloads cannot be mistaken for
      // the issued document — nothing was saved on the server.
      await deliverExportedFile(blob, `bol-preview-${String(body.bol_no || 'draft').replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`, 'pdf');
      return set('Preview ready. Nothing was saved.');
    }
    const out = await api('/api/bol/generate', { method: 'POST', body: JSON.stringify(body) });
    bolw.editingId = out.id || bolw.editingId;
    // The number the server actually issued. It reserves one when the box was
    // posted empty, and it is not always the suggestion — so the form is told
    // what went on the paper rather than left showing a blank.
    if (out.bol_no) { bolw.bolNo = out.bol_no; bolwAutoNo = out.bol_no; }
    // ── HAND HER THE FILE ────────────────────────────────────────────────
    // Apsara, 2026-09-16: "When i click generate-It needs to get as
    // downloadable file". A filename is an inventory number, not a document.
    //
    // Pulled back through /api/documents/download so what lands on the phone
    // is the EXACT file the archive holds, and delivered by
    // deliverExportedFile — which on a real device writes it with the
    // Filesystem plugin and opens the share sheet, because an <a download>
    // does nothing in an Android WebView.
    set('Saved. Downloading…');
    try {
        const qs = `?kind=bol&date=${encodeURIComponent(out.saved_date || '')}&file=${encodeURIComponent(out.saved_filename)}`;
        const res = await fetch(API_BASE + '/api/documents/download' + qs, {
            headers: { Authorization: 'Bearer ' + getToken() },
        });
        if (!res.ok) throw new Error(`the archive returned ${res.status}`);
        const blob = await res.blob();
        if (!blob.size) throw new Error('the archive returned an empty file');
        await deliverExportedFile(blob, out.saved_filename, 'pdf');
        set(`Saved and downloaded — ${out.saved_filename}`);
    } catch (e) {
        // The PDF is generated and filed; only the handing-over failed.
        // Saying "could not download" alone would read as "it did not save".
        set(`Saved as ${out.saved_filename}, but the download did not start: ${e.message}`);
    }
    if (typeof loadSavedBolsApp === 'function') loadSavedBolsApp();
  } catch (e) {
    set(e.message);
  }
}

