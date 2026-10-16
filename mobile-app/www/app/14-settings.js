// mobile-app/www/app/14-settings.js — split from mobile-app/www/index.html's <script> (helpers/sourceParts.js reconstructs the original)
// ── Admin settings modal ─────────────────────────────────────────────────
// Fetches the current yard_report_enabled / next_load_number values on
// EVERY open — not cached — so neither can show something stale if it
// changed from the dashboard since the app was last opened.
// The renumber dropdown this used to also populate (and the
// btnDoRenumber handler that followed) were removed 2026-08-17 per
// Apsara, along with the markup — see the modal's own comment.
$('btnAdminSettings').addEventListener('click', async () => {
  $('as_report_msg').textContent = '';
  $('adminSettingsModal').classList.remove('hidden');
  // Server address: wired and filled on every open, same as the fields below,
  // so it never shows a stale value if it was changed from the recovery path.
  wireAdminServerBox();
  $('as_server_url').value = storedApiBase() || DEFAULT_API_BASE;
  $('as_server_msg').textContent = '';
  try {
    const settings = await api('/api/settings');
    $('as_report_enabled').checked = !!settings.yard_report_enabled;
    $('as_next_load_number').value = settings.next_load_number ?? '';
  } catch (err) {
    $('as_report_msg').textContent = 'Could not load current setting: ' + err.message;
    $('as_report_msg').style.color = 'var(--status-danger)';
  }
  // Outside the try: a failed /api/settings read must not also swallow the
  // description list, they're independent panels in the same modal.
  renderItemTypeManager('as');
});
$('btnCloseAdminSettings').addEventListener('click', () => $('adminSettingsModal').classList.add('hidden'));

$('btnSaveReportToggle').addEventListener('click', async () => {
  const msg = $('as_report_msg');
  const btn = $('btnSaveReportToggle');
  btn.disabled = true; btn.textContent = 'Saving…';
  msg.textContent = '';
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ yard_report_enabled: $('as_report_enabled').checked }) });
    msg.style.color = 'var(--status-success, #3fae55)';
    msg.textContent = 'Saved.';
  } catch (err) {
    msg.style.color = 'var(--status-danger)';
    msg.textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Save';
  }
});

$('btnSaveNextLoadNumber').addEventListener('click', async () => {
  const msg = $('as_next_load_msg');
  const btn = $('btnSaveNextLoadNumber');
  const raw = $('as_next_load_number').value.trim();
  btn.disabled = true; btn.textContent = 'Saving…';
  msg.textContent = '';
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ next_load_number: raw ? parseInt(raw, 10) : null }) });
    msg.style.color = 'var(--status-success, #3fae55)';
    msg.textContent = 'Saved.';
  } catch (err) {
    msg.style.color = 'var(--status-danger)';
    msg.textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Save';
  }
});

// ── Staff settings modal ─────────────────────────────────────────────────
// Per Apsara 2026-08-16 ("settings for staff user with load number reset
// ... and this remove description"). Uses /api/loads/next-number, NOT
// /api/settings — see that route's comment in api.js for why (staff gets
// exactly this one field, not the whole admin settings object).
$('btnStaffSettings').addEventListener('click', async () => {
  $('ss_next_load_msg').textContent = '';
  $('staffSettingsModal').classList.remove('hidden');
  try {
    const s = await api('/api/loads/next-number');
    $('ss_next_load_number').value = s.next_load_number ?? '';
  } catch (err) {
    $('ss_next_load_msg').style.color = 'var(--status-danger)';
    $('ss_next_load_msg').textContent = 'Could not load current setting: ' + err.message;
  }
  renderItemTypeManager('ss');
});
$('btnCloseStaffSettings').addEventListener('click', () => $('staffSettingsModal').classList.add('hidden'));

$('btnSaveStaffNextLoadNumber').addEventListener('click', async () => {
  const msg = $('ss_next_load_msg');
  const btn = $('btnSaveStaffNextLoadNumber');
  const raw = $('ss_next_load_number').value.trim();
  btn.disabled = true; btn.textContent = 'Saving…';
  msg.textContent = '';
  try {
    await api('/api/loads/next-number', { method: 'PUT', body: JSON.stringify({ next_load_number: raw ? parseInt(raw, 10) : null }) });
    msg.style.color = 'var(--status-success, #3fae55)';
    msg.textContent = 'Saved.';
  } catch (err) {
    msg.style.color = 'var(--status-danger)';
    msg.textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Save';
  }
});

// ── Item description catalog manager (Settings) ───────────────────────
// One renderer, two mounts: the admin modal ("as_" ids) and the staff modal
// ("ss_" ids). Per Apsara 2026-08-20 the list is manageable from BOTH — see
// the panel markup comment. Writing it once means the two can't drift, which
// is exactly the failure mode that made the hardcoded description array a
// problem in the first place.
async function renderItemTypeManager(prefix) {
  const rows = $(`${prefix}_item_type_rows`);
  if (!rows) return; // modal not mounted / closed before this resolved
  try {
    // No client-side sort: GET /api/item-types is already A-Z (see
    // helpers/itemTypes.js). Sorting again here is how the managed list and
    // the type-ahead list used to end up ordered differently.
    const types = await api('/api/item-types');
    rows.innerHTML = types.length ? types.map(d => `
      <div style="display:flex; align-items:center; gap:8px; padding:9px 10px; background:var(--steel-900); border-radius:8px;" data-desc="${esc(d)}">
        <span class="itm-label" style="flex:1; min-width:0; font-size:12.5px; color:var(--steel-100, #fff); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(d)}</span>
        <button class="btn btn-ren-item-type" data-desc="${esc(d)}" style="padding:5px 10px; font-size:10px;">Rename</button>
        <button class="btn btn-danger btn-del-item-type" data-desc="${esc(d)}" style="padding:5px 10px; font-size:10px;">Remove</button>
      </div>`).join('') : '<div style="font-family:var(--font-mono); font-size:11px; color:var(--steel-500); text-align:center; padding:8px 0;">No descriptions yet.</div>';

    rows.querySelectorAll('.btn-ren-item-type').forEach(btn => btn.addEventListener('click', async () => {
      const from = btn.dataset.desc;
      // prompt() rather than an inline edit field: this is a rare,
      // deliberate action in a settings modal, not something worth its own
      // editing mode. Same reasoning the next-load-number field gets a
      // plain input instead of a stepper.
      const to = prompt(`Rename "${from}" to:`, from);
      if (to === null) return;              // cancelled
      if (!to.trim() || to.trim() === from) return;  // blank or unchanged
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        const r = await api('/api/item-types', { method: 'PUT', body: JSON.stringify({ from, to: to.trim() }) });
        // Keep the in-memory type-ahead cache in step so the old wording
        // doesn't keep showing up on the load form until a full app reload.
        customItemTypes = customItemTypes.filter(x => String(x).toLowerCase() !== from.toLowerCase());
        if (!r.merged) customItemTypes.push(to.trim());
        renderItemTypeManager(prefix);
      } catch (e) { alert(e.message); btn.disabled = false; btn.textContent = 'Rename'; }
    }));

    rows.querySelectorAll('.btn-del-item-type').forEach(btn => btn.addEventListener('click', async () => {
      if (!await askYesNo(`Remove "${btn.dataset.desc}" from the item description list?\n\nLoads that already used it keep it — this only stops it being suggested.`)) return;
      btn.disabled = true; btn.textContent = 'Removing…';
      try {
        await api('/api/item-types', { method: 'DELETE', body: JSON.stringify({ description: btn.dataset.desc }) });
        customItemTypes = customItemTypes.filter(x => String(x).toLowerCase() !== btn.dataset.desc.toLowerCase());
        renderItemTypeManager(prefix);
      } catch (e) { alert(e.message); btn.disabled = false; btn.textContent = 'Remove'; }
    }));
  } catch (e) {
    rows.innerHTML = `<div style="color:var(--status-danger); font-size:11.5px;">Couldn't load the description list: ${esc(e.message)}</div>`;
  }
}

// Add straight from Settings, so the catalog can be set up before anyone
// types a load — the auto-add-on-save path (see the save handler) only ever
// grows the list as a side effect of real work.
['as', 'ss'].forEach(prefix => {
  const btn = $(`${prefix}_btn_add_item_type`);
  const input = $(`${prefix}_item_type_new`);
  if (!btn || !input) return;
  const add = async () => {
    const v = input.value.trim();
    if (!v) return;
    btn.disabled = true;
    try {
      await api('/api/item-types', { method: 'POST', body: JSON.stringify({ description: v }) });
      if (!customItemTypes.some(x => String(x).toLowerCase() === v.toLowerCase())) customItemTypes.push(v);
      input.value = '';
      renderItemTypeManager(prefix);
    } catch (e) { alert(e.message); } finally { btn.disabled = false; }
  };
  btn.addEventListener('click', add);
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); add(); } });
});


// ══════════════════════════════════════════════════════════════════════
// DOCUMENTS TAB — Proforma + Invoice (admin only)
// ══════════════════════════════════════════════════════════════════════
// Added 2026-08-22 per Apsara: "integrate proforma/invoice creation into
// mobile app admin access."
//
// SCOPE, decided with her before building: Proforma and Invoice only —
// Verification stays on the dashboard, because all five carrier checks are
// driven by uploading spreadsheet/PDF statements, which is desk work. And
// the PROFORMA side is the 3-step wizard only, not the full form.
//
// That second decision is the important one. On the dashboard the wizard is
// a fast path that hands off to a 14-field form for the final pass. Porting
// that whole form to a phone would produce a screen nobody could fill in
// standing in a yard. Instead the wizard's step 3 here does double duty:
// rates AND the handful of document fields that actually vary, with the
// same defaults the full form applies (see PF_DEFAULTS). Everything else —
// multi-container blocks, per-container item lists, pricing-memory
// browsing — stays on the dashboard, which is the right tool for it.
//
// What this deliberately REUSES rather than reimplements: every calculation
// that ends up on a legal document is server-side already
// (helpers/proformaPdf.js, helpers/invoicePdf.js, helpers/invoiceSheet.js).
// This screen only collects fields and POSTs the same payload shape the
// dashboard sends. The one thing that had to be copied is deriveItemCode()
// and its rule table, because the invoice-number format depends on it and
// it lives in dashboard/documents.html as client code. That duplication is
// a real risk — flagged in DOC_ITEM_CODE_RULES' comment.

let docsSubTab = 'proforma';
// docsAddressBook now lives up with addressBookCache — see the comment there.

// ── Copied from dashboard/documents.html ──────────────────────────────────
// DUPLICATED CODE, KNOWINGLY. These four functions are the item-code and
// address-book-label rules that decide what the Invoice No looks like
// ("260820_AC_26JY95"). They live as client-side code in
// dashboard/documents.html, so there is no server endpoint to call for
// them. Copying is the lesser evil against a phone that silently produces a
// DIFFERENT invoice number format than the dashboard for the same material.
//
// If the material list or the code map ever changes, BOTH copies must
// change. The right long-term fix is to move deriveItemCode server-side and
// expose it — worth doing the next time this table is touched.
const DOC_ITEM_CODE_RULES = [
  ['AW', ['ALUMINUM WHEEL', 'ALUMINIUM WHEEL', 'AL WHEEL', 'ALLOY WHEEL']],
  ['CW', ['CHROME WHEEL']],
  ['AL', ['ALUMINIUM COMBO', 'ALUMINUM COMBO', 'AL COMBO']],
  ['AC', ['AUTO CAST']],
  ['AP', ['SCRAP AUTO PART', 'AUTO PART']],
  ['RC', ['REGULAR COMBO']],
  ['BT', ['BATTERY', 'BATTERIES']],
  ['HW', ['HARNESS WIRE', 'HARNESS']],
  ['TT', ['TAINT TABOUR', 'TAINT TABOR', 'TOUGH TABOO', 'TAINT TABOO']],
  ['ML', ['MIXED LOAD']],
  ['SU', ['SEALED UNIT']],
  ['MM', ['MIXED MOTOR']],
  ['RD', ['ROTOR', 'DRUM']],
  ['MC', ['MIXED COMBO']],
];
// Letters only, so "AUTOCAST", "AUTO-CAST" and "AUTO CAST" all match the
// same rule — the dashboard learned this the hard way.
function docNormalizeForItemMatch(s) { return (s || '').toUpperCase().replace(/[^A-Z]/g, ''); }
function docDeriveItemCode(desc) {
  const norm = docNormalizeForItemMatch(desc);
  if (!norm) return null;
  for (const [code, keywords] of DOC_ITEM_CODE_RULES) {
    if (keywords.some(k => norm.includes(docNormalizeForItemMatch(k)))) return code;
  }
  return null;
}
function docSearchAddressBook(q) {
  const aliasHits = [], rawOnlyHits = [];
  docsAddressBook.forEach(e => {
    if ((e.aliases || []).some(a => a.toLowerCase().includes(q))) aliasHits.push(e);
    else if ((e.raw || '').toLowerCase().includes(q)) rawOnlyHits.push(e);
  });
  return aliasHits.concat(rawOnlyHits);
}
// "Joey/Taewon" -> "Taewon": some entries store a contact name and the
// company name as aliases. The company is what belongs on the document;
// the contact is only there to search by.
function docConsigneeName(entry) {
  const combined = (entry.aliases || []).join('/');
  if (combined.includes('/')) {
    const parts = combined.split('/').map(s => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return ((entry.aliases || [])[0] || '').trim();
}
function docEntryLabel(entry) {
  const aliases = entry.aliases || [];
  const rawFirst = (entry.raw || '').split('\n')[0].trim();
  const aliasText = aliases.join(' / ');
  if (rawFirst && !aliases.some(a => a.toLowerCase() === rawFirst.toLowerCase())) {
    return aliasText ? `${aliasText} — ${rawFirst}` : rawFirst;
  }
  return aliasText;
}

// Same values the dashboard's full form ships with as its input defaults.
// The wizard on this side never shows that form, so without these a phone
// proforma would go out missing payment terms and country of origin.
const PF_DEFAULTS = {
  payment_term: 'T/T 100% Against Shipping Documents',
  country_of_origin: 'USA',
  shipment_allowance: '+/- 10% on weights',
  freight_label: 'CIF (freight included)',
  qty_unit: 'MT',
};

// Joins container codes writing the shared prefix ONCE — "26JY95,96,97,98,99"
// rather than repeating "26JY" five times. Apsara, 2026-09-01.
//
// MUST stay byte-identical to helpers/proformaSheetLog.js's function of the
// same name AND to dashboard/documents.html's copy: one builds the Inv No for
// the SHEET, one for the website's PDF and this one for the app's, and any two
// of them disagreeing is the exact bug this pairing exists to avoid.
// helpers/invoiceSheet.js's invNoTailCodes expands it back so the Inv No
// search still finds every container.
//
// A code with a different alpha prefix (a run crossing a code change, e.g.
// 26JY99 then 26KA01) is kept whole — shortening it would be ambiguous, and
// an ambiguous container reference on an invoice is worth the extra
// characters.
//
// PORTED TO THE APP 2026-09-02, per Apsara: "mimic proforma changes on website
// to docs of app". Until now a three-container proforma raised in the app got
// an Inv No naming ONE container, while the same proforma on the website named
// all three — and the Inv No is the key that joins the PDF to the Edge Metals
// sheet.
function shortenContainerCodes(codes) {
  const list = (codes || []).filter(Boolean);
  if (!list.length) return '';
  const m = String(list[0]).match(/^(.*?)(\d+)$/);
  const prefix = m && m[1] ? m[1] : null;
  return list.map((c, i) => {
    if (i === 0 || !prefix) return c;
    return String(c).startsWith(prefix) ? String(c).slice(prefix.length) : c;
  }).join(',');
}

function docTodayISO() { return new Date().toISOString().slice(0, 10); }

