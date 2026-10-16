// mobile-app/www/app/16-proforma.js — split from mobile-app/www/index.html's <script> (helpers/sourceParts.js reconstructs the original)
// ── PROFORMA — 3-step wizard ──────────────────────────────────────────────
let pfw = null;
function resetPfWizard() {
  pfCustomerDescs = []; // last consignee's history must not leak into a new proforma
  pfw = {
    step: 1,
    consignee: '', consigneeEntry: null, consigneeTag: null,
    items: [{ desc: '', qty: 21, rate: 0 }],
    containerCount: 1,
    invNo: '', invNoSuggestion: null, invDate: docTodayISO(),
    tradeTerms: '', portDischarge: '', reference: '', buyerPo: '', buyerPoDate: '',
    // Editable as of 2026-08-22 per Apsara ("payment terms should be
    // modifiable"). Seeded from the standard value rather than left blank —
    // it's the same on most deals, and a blank required-ish field on a phone
    // is a worse default than a correct one you can overwrite.
    paymentTerm: PF_DEFAULTS.payment_term,
    // True once she edits the box herself. Gates the pricing-memory prefill
    // below: memory may replace the house default, never her own typing.
    paymentTermTouched: false,
    // Made editable at the same time, but for a CORRECTNESS reason rather
    // than a request: trade terms are editable here, and helpers/proformaPdf.js
    // derives the document's short term from trade_terms' first word while
    // taking the freight wording from freight_label separately. With this
    // pinned to CIF, typing "FOB Busan" into trade terms produced a proforma
    // reading "FOB" in one place and "freight included" in another. It now
    // follows trade terms by default (see pfSyncFreightToTradeTerms) and can
    // still be overridden for the genuinely mixed cases.
    freightLabel: PF_DEFAULTS.freight_label,
    containerSeq: null, containerNos: [],
  };
}

function renderPfWizard() {
  if (!pfw) resetPfWizard();
  const stepBody = { 1: pfStep1Html, 2: pfStep2Html, 3: pfStep3Html }[pfw.step]();
  $('docBody').innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
      <div style="font-family:var(--font-mono); font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--text-faint);">Step ${pfw.step} of 3</div>
      <button id="btnPfReset" class="btn" style="padding:4px 10px; font-size:10px;">Start over</button>
    </div>
    ${stepBody}
    <div id="pfMsg" style="margin-top:14px; font-family:var(--font-mono); font-size:11px;"></div>`;
  $('btnPfReset').addEventListener('click', async () => {
    if (!await askYesNo('Discard this proforma and start over?')) return;
    resetPfWizard(); renderPfWizard();
  });
  ({ 1: wirePfStep1, 2: wirePfStep2, 3: wirePfStep3 }[pfw.step])();
  // Step 3 carries the invoice date. Wired here rather than inside
  // wirePfStep3 so the picker arrives with the step, whichever step it is —
  // a paint path without its wiring is how the Inventory drill-down shipped
  // dead earlier today.
  wireUsDateField('pfw_invDate');
}

// Step 1 — who is it for.
function pfStep1Html() {
  return `
    <div class="field" style="position:relative;">
      <label>Consignee</label>
      <input id="pfw_consignee" placeholder="Start typing a customer" autocomplete="off" value="${esc(pfw.consignee)}">
      <div id="pfwConsigneeList" class="ac-dropdown hidden"></div>
    </div>
    <div style="font-size:12px; color:var(--text-muted); margin:-4px 0 16px;">Picked from your address book, so the address and pricing history come with it.</div>
    <button id="btnPfNext1" class="btn btn-primary" style="width:100%;">Next</button>`;
}
function wirePfStep1() {
  wireDocTypeahead('pfw_consignee', 'pfwConsigneeList',
    (entry) => {
      pfw.consigneeEntry = entry;
      pfw.consignee = docConsigneeName(entry);
      // FULL alias tag, not the display name — the server groups
      // agent-tagged consignees by what's BEFORE the "/", so it needs
      // "Joey" to find Joey's other customers' invoice numbers.
      pfw.consigneeTag = (entry.aliases || []).join('/') || pfw.consignee;
      $('pfw_consignee').value = pfw.consignee;
    },
    () => { pfw.consigneeEntry = null; pfw.consigneeTag = null; });
  $('btnPfNext1').addEventListener('click', () => {
    const name = $('pfw_consignee').value.trim();
    if (!name) { $('pfMsg').style.color = 'var(--status-danger)'; $('pfMsg').textContent = 'Pick or type a consignee first.'; return; }
    // A hand-typed consignee with no address-book match is allowed — same
    // as the dashboard. It just means no address and no pricing memory.
    pfw.consignee = name;
    if (!pfw.consigneeTag) pfw.consigneeTag = name;
    // Fire-and-forget: the material step opens immediately and the history
    // lands a moment later. Suggestions appear on focus/typing, by which
    // point this has almost always resolved; if it hasn't, the generic
    // catalog still shows and nothing is blocked waiting on it.
    pfPreloadCustomerDescs(pfw.consignee);
    pfw.step = 2; renderPfWizard();
  });
}

// Step 2 — what's in it. Freeform material rows, defaulting to 21 MT, per
// Apsara on the dashboard build: "no matter whatever it is 21 MT just ask
// user to enter the material" — there are no material presets by design.
function pfStep2Html() {
  return `
    <div style="font-family:var(--font-mono); font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--text-muted); margin-bottom:8px;">Material</div>
    <div id="pfwItems" style="display:flex; flex-direction:column; gap:8px;"></div>
    <button id="btnPfAddItem" class="btn" style="width:100%; margin-top:10px; font-size:11px;">+ Add material</button>
    <div class="field" style="margin-top:18px;">
      <label>How many containers</label>
      <input id="pfw_containerCount" type="number" min="1" value="${pfw.containerCount}">
    </div>
    <div style="font-size:12px; color:var(--text-muted); margin:-4px 0 16px;">Each container gets the same materials. Container numbers are filled in automatically on the next step.</div>

    <!-- Apsara, 2026-09-02: "mimic this proforma behaviour in docs of mobile
         app" — matching the dashboard, where payment terms is asked with the
         material rather than left to the review step.
         It was already editable here, but only on step 3, ninth in a stack of
         detail fields. It is not a detail: it is a deal term she is quoting,
         and since 2026-09-01 it is also what lands in the Terms column of the
         Edge Metals sheet (helpers/proformaSheetLog.js), so it is no longer a
         PDF-only field. Asked here, confirmed on step 3. -->
    <div class="field" style="position:relative;">
      <label>Payment terms</label>
      <input id="pfw_paymentTerm2" value="${esc(pfw.paymentTerm)}" placeholder="e.g. LC" autocomplete="off">
      <div id="pfwPayTermList" class="ac-dropdown hidden"></div>
    </div>
    <div style="font-size:12px; color:var(--text-muted); margin:-4px 0 16px;">Prefilled from this customer's last proforma where we have one. Editable, and shown again on the last step.</div>

    <div style="display:flex; gap:8px;">
      <button id="btnPfBack2" class="btn" style="flex:1;">Back</button>
      <button id="btnPfNext2" class="btn btn-primary" style="flex:2;">Next</button>
    </div>`;
}
function pfRenderItems() {
  $('pfwItems').innerHTML = pfw.items.map((it, i) => `
    <div class="pfw-item" data-i="${i}" style="display:grid; grid-template-columns:1fr 84px auto; gap:6px; align-items:center;">
      <div style="position:relative; min-width:0;">
      <input class="pfw-desc" placeholder="material" value="${esc(it.desc)}" autocomplete="off" style="width:100%;">
      <div class="ac-dropdown pfw-desc-list hidden"></div>
      </div>
      <input class="pfw-qty" type="number" step="any" placeholder="MT" value="${it.qty || ''}">
      <button type="button" class="btn btn-danger pfw-del" style="padding:6px 9px; font-size:10px;">✕</button>
    </div>`).join('');
  // Read the DOM back into state on every keystroke, so switching steps or
  // adding a row can never silently drop what was just typed.
  const sync = () => {
    pfw.items = Array.from($('pfwItems').querySelectorAll('.pfw-item')).map(row => ({
      desc: row.querySelector('.pfw-desc').value,
      qty: parseFloat(row.querySelector('.pfw-qty').value) || 0,
      rate: pfw.items[Number(row.dataset.i)] ? pfw.items[Number(row.dataset.i)].rate : 0,
    }));
  };
  $('pfwItems').querySelectorAll('input').forEach(inp => inp.addEventListener('input', sync));

  // Material suggestions per row.
  $('pfwItems').querySelectorAll('.pfw-item').forEach(row => {
    const input = row.querySelector('.pfw-desc');
    const box = row.querySelector('.pfw-desc-list');
    const close = () => { box.classList.add('hidden'); box.innerHTML = ''; };
    const show = async () => {
      const generic = await pfLoadGenericDescs();
      const items = pfDescSuggestions(input.value, pfCustomerDescs, generic);
      // Don't cover the field with a list whose only entry is what's already
      // typed in full.
      if (!items.length || (items.length === 1 && items[0].text.toLowerCase() === input.value.trim().toLowerCase())) return close();
      box.innerHTML = items.map((it, i) =>
        `<div class="ac-item" data-i="${i}">${esc(it.text)}${it.fromHistory ? ' <span style="color:var(--status-success, #3fae55); font-size:9.5px; font-family:var(--font-mono);">● known price</span>' : ''}</div>`
      ).join('');
      box.classList.remove('hidden');
      box.querySelectorAll('.ac-item').forEach(el => el.addEventListener('mousedown', (ev) => {
        // mousedown + preventDefault: blur fires first on a click and would
        // close the list before the click landed.
        ev.preventDefault();
        input.value = items[+el.dataset.i].text;
        blurPicked(input);
        close();
        sync(); // so Next reads the picked value, not the half-typed one
      }));
    };
    input.addEventListener('input', show);
    input.addEventListener('focus', show);
    input.addEventListener('blur', () => setTimeout(close, 150));
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') close(); });
  });
  $('pfwItems').querySelectorAll('.pfw-del').forEach(btn => btn.addEventListener('click', () => {
    // Never leave zero rows — an empty step 2 has no way back to a usable
    // state except Start over.
    if (pfw.items.length <= 1) return;
    sync();
    pfw.items.splice(Number(btn.closest('.pfw-item').dataset.i), 1);
    pfRenderItems();
  }));
}
// Offered to save typing on a phone keyboard; the box is plain text and
// anything typed is used as-is. This customer's remembered terms come first
// and are marked, same idea as the material suggestions above.
const PF_PAY_TERM_SUGGESTIONS = [
  'LC',
  'LC at sight',
  'T/T 100% Against Shipping Documents',
  'T/T 30% advance, 70% against shipping documents',
  'DP (Documents against Payment)',
  'DA (Documents against Acceptance)',
];
function wirePfPayTermField(inputId, listId) {
  const input = $(inputId), box = $(listId);
  if (!input || !box) return;
  const close = () => { box.classList.add('hidden'); box.innerHTML = ''; };
  const show = () => {
    const q = input.value.trim().toLowerCase();
    const seen = new Set();
    const list = [];
    const remembered = String(pfMemoryPaymentTerms || '').trim();
    if (remembered) { list.push({ text: remembered, known: true }); seen.add(remembered.toLowerCase()); }
    for (const v of PF_PAY_TERM_SUGGESTIONS) {
      if (seen.has(v.toLowerCase())) continue;
      seen.add(v.toLowerCase());
      list.push({ text: v, known: false });
    }
    const items = list.filter(x => !q || x.text.toLowerCase().includes(q)).slice(0, 6);
    if (!items.length || (items.length === 1 && items[0].text.toLowerCase() === q)) return close();
    box.innerHTML = items.map((it, i) =>
      `<div class="ac-item" data-i="${i}">${esc(it.text)}${it.known ? ' <span style="color:var(--status-success, #3fae55); font-size:9.5px; font-family:var(--font-mono);">● last used</span>' : ''}</div>`
    ).join('');
    box.classList.remove('hidden');
    // mousedown + preventDefault: blur fires first on a tap and would close
    // the list before the tap landed. Same fix as the material list.
    box.querySelectorAll('.ac-item').forEach(el => el.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      input.value = items[+el.dataset.i].text;
      input.dataset.touched = '1';
      pfw.paymentTermTouched = true;
      pfw.paymentTerm = input.value;
      blurPicked(input);
      close();
    }));
  };
  input.addEventListener('input', () => {
    input.dataset.touched = '1';
    pfw.paymentTermTouched = true;
    pfw.paymentTerm = input.value;
    show();
  });
  input.addEventListener('focus', show);
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') close(); });
}

function wirePfStep2() {
  pfRenderItems();
  wirePfPayTermField('pfw_paymentTerm2', 'pfwPayTermList');
  // The lookup fired on step 1 may already have resolved while this step was
  // painting — apply it now rather than waiting for another one.
  pfApplyMemoryPaymentTerm();
  $('btnPfAddItem').addEventListener('click', () => { pfw.items.push({ desc: '', qty: 21, rate: 0 }); pfRenderItems(); });
  $('btnPfBack2').addEventListener('click', () => { pfw.step = 1; renderPfWizard(); });
  $('btnPfNext2').addEventListener('click', async () => {
    // Read the box directly rather than trusting the input handler — a paste,
    // an autofill or a suggestion tap that raced the blur would otherwise
    // carry the previous value onto the document.
    const payEl = $('pfw_paymentTerm2');
    if (payEl) {
      const v = payEl.value.trim();
      if (v !== String(pfw.paymentTerm || '').trim()) pfw.paymentTermTouched = true;
      pfw.paymentTerm = v;
    }
    pfw.items = pfw.items.filter(it => it.desc.trim());
    if (!pfw.items.length) {
      $('pfMsg').style.color = 'var(--status-danger)';
      $('pfMsg').textContent = 'Enter at least one material.';
      pfw.items = [{ desc: '', qty: 21, rate: 0 }]; pfRenderItems();
      return;
    }
    pfw.containerCount = Math.max(1, parseInt($('pfw_containerCount').value, 10) || 1);
    const btn = $('btnPfNext2');
    btn.disabled = true; btn.textContent = 'Looking up pricing…';
    try { await pfLoadSuggestions(); } finally { btn.disabled = false; btn.textContent = 'Next'; }
    pfw.step = 3; renderPfWizard();
  });
}

// Everything the dashboard's full form would have auto-filled on arrival:
// pricing memory, trade terms, port of discharge, the next invoice number,
// and the running container-number sequence. All of it is a SUGGESTION —
// every field stays editable on step 3, same rule as the dashboard.
async function pfLoadSuggestions() {
  const tag = pfw.consigneeTag || pfw.consignee;

  // Per-item rates from what this customer paid last time.
  await Promise.all(pfw.items.map(async (it) => {
    if (it.rate) return; // already typed by hand — never overwrite
    try {
      const r = await api(`/api/customer-pricing/item-rate?customer=${encodeURIComponent(pfw.consignee)}&item=${encodeURIComponent(it.desc)}`);
      if (r && r.rate) { it.rate = r.rate; it.rateFromMemory = true; }
    } catch (e) { /* no history for this item — stays manual */ }
  }));

  try {
    const info = await api('/api/customer-pricing/lookup?customer=' + encodeURIComponent(pfw.consignee));
    if (info && info.canonical_name) {
      if (info.trade_terms && !pfw.tradeTerms) pfw.tradeTerms = info.trade_terms;
      if (info.port_discharge && !pfw.portDischarge) pfw.portDischarge = info.port_discharge;
      // Payment terms was being read from this response and thrown away, so a
      // customer on LC still arrived on the standard T/T wording. Same
      // "suggest, never overwrite" rule as the two above: it fills only while
      // the box is untouched and still on the house default.
      if (info.payment_terms) {
        pfMemoryPaymentTerms = info.payment_terms;
        pfApplyMemoryPaymentTerm();
      }
    }
  } catch (e) { /* unknown customer — fields stay blank */ }
  // Same hardcoded default the dashboard applies for these three customers.
  if (/taewon|daekwang|dooin/i.test(pfw.consignee) && !pfw.portDischarge) pfw.portDischarge = 'South Korea';
  pfSyncFreightToTradeTerms();

  try {
    const sug = await api('/api/proforma/next-inv-no?consignee=' + encodeURIComponent(tag));
    if (sug && sug.inv_no) {
      const dateStr = sug.inv_no.split(' ')[0];
      const itemCode = docDeriveItemCode(pfw.items[0] && pfw.items[0].desc);
      // "[date]_[item]_[code]" when the material is known, which on this
      // wizard it always is by step 3 — unlike the dashboard's full form,
      // where the consignee is often picked before any item is typed and a
      // retrofit pass is needed later. Here the order is fixed, so the
      // retrofit machinery isn't needed at all.
      pfw.invNoSuggestion = { highest: sug.highest_existing };
      pfw.containerSeq = {
        yy: sug.year_prefix, letterCode: sug.letter_code, nextNumber: sug.next_number,
        numberDigits: sug.number_digits, numberHadLeadingZero: sug.number_had_leading_zero,
      };
      pfw.invNoParts = { dateStr, itemCode, codeOnly: sug.code_only, fallback: sug.inv_no };
    }
  } catch (e) { /* no history — invoice number stays manual */ }

  // Container numbers: bare "26JY52" with no item code, per Apsara
  // 2026-08-22 on the dashboard. The item code still reaches the Edge
  // Metals sheet, but as its own field (see the payload below).
  //
  // GENERATED BEFORE THE INV NO, as of 2026-09-02. The Inv No's tail names
  // every container on the proforma, so it cannot be built until they exist.
  // It used to be composed first, from sug.code_only alone — which is the
  // FIRST container — so a three-container proforma was numbered as though it
  // had one.
  pfw.containerNos = [];
  for (let i = 0; i < pfw.containerCount; i++) {
    if (!pfw.containerSeq) { pfw.containerNos.push(''); continue; }
    const n = pfw.containerSeq.nextNumber++;
    const numStr = pfw.containerSeq.numberHadLeadingZero
      ? String(n).padStart(pfw.containerSeq.numberDigits, '0') : String(n);
    pfw.containerNos.push(`${pfw.containerSeq.yy}${pfw.containerSeq.letterCode}${numStr}`);
  }

  // ── the Inv No, naming every container ──────────────────────────────────
  // Matches dashboard/documents.html's retrofitInvNoContainers, which does the
  // same job the hard way: on the website the consignee is often picked before
  // any material is typed, so the number has to be rewritten afterwards. Here
  // the wizard's order is fixed — material, then consignee, then this — so the
  // number can simply be built correctly the first time and no retrofit pass
  // is needed.
  //
  // One container gives exactly what it gave before, because shortening a
  // single code returns that code.
  if (pfw.invNoParts) {
    const p = pfw.invNoParts;
    const tail = shortenContainerCodes(pfw.containerNos.filter(Boolean)) || p.codeOnly;
    pfw.invNo = p.itemCode ? `${p.dateStr}_${p.itemCode}_${tail}` : p.fallback;
  }
}

// Step 3 — rates + the document fields that actually vary, then generate.
// On the dashboard this step only sets rates and then hands off to the full
// form. There's no full form here, so it also carries Invoice No, date,
// trade terms, port and container numbers. Everything else comes from
// PF_DEFAULTS.
// Keeps the freight wording consistent with whatever trade terms say.
// proformaPdf.js prints trade_terms' FIRST WORD as the document's term and
// freight_label as the freight line, from two independent fields — so "FOB
// Busan" with a CIF freight label yields a self-contradicting document.
// Only ever changes the value when it currently disagrees, so a deliberate
// override on step 3 survives.
function pfSyncFreightToTradeTerms() {
  const first = (pfw.tradeTerms || '').trim().split(/\s+/)[0].toUpperCase();
  if (first === 'FOB' && !/^FOB/.test(pfw.freightLabel)) pfw.freightLabel = 'FOB (freight excluded)';
  else if (first === 'CIF' && !/^CIF/.test(pfw.freightLabel)) pfw.freightLabel = 'CIF (freight included)';
}

function pfStep3Html() {
  const money = (n) => n ? Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';
  const total = pfw.items.reduce((s, it) => s + (it.qty || 0) * (it.rate || 0), 0) * pfw.containerCount;
  return `
    <div style="font-family:var(--font-mono); font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--text-muted); margin-bottom:8px;">Rate per ${PF_DEFAULTS.qty_unit}</div>
    <div id="pfwRates" style="display:flex; flex-direction:column; gap:8px;">
      ${pfw.items.map((it, i) => `
        <div class="pfw-rate-row" data-i="${i}" style="display:grid; grid-template-columns:1fr 96px; gap:8px; align-items:center;">
          <div style="font-size:13px; color:var(--text-strong); min-width:0;">
            ${esc(it.desc)}
            <span style="color:var(--text-faint); font-size:11px;"> · ${it.qty} ${PF_DEFAULTS.qty_unit}</span>
            ${it.rateFromMemory ? '<span style="display:block; font-size:9.5px; color:var(--status-success, #3fae55); font-family:var(--font-mono);">from pricing memory</span>' : ''}
          </div>
          <input class="pfw-rate" type="number" step="any" placeholder="rate" value="${it.rate || ''}">
        </div>`).join('')}
    </div>
    <div id="pfwTotal" style="margin-top:10px; text-align:right; font-family:var(--font-mono); font-size:12px; color:var(--text-muted);">
      Total across ${pfw.containerCount} container(s): <span style="color:var(--text-strong);">$${money(total)}</span>
    </div>

    <div style="height:1px; background:var(--border-subtle); margin:20px 0;"></div>

    <div class="field"><label>Invoice No</label><input id="pfw_invNo" value="${esc(pfw.invNo)}" autocomplete="off"></div>
    ${pfw.invNoSuggestion ? `<div style="font-family:var(--font-mono); font-size:10px; color:var(--status-success, #3fae55); margin:-6px 0 12px;">● suggested — last was ${esc(pfw.invNoSuggestion.highest)}</div>` : ''}
    <div class="field"><label>Invoice date</label><input id="pfw_invDate" placeholder="MM/DD/YYYY" autocomplete="off" value="${esc(toUsDate(pfw.invDate))}"></div>
    <div class="field"><label>Container numbers</label><input id="pfw_containerNos" value="${esc(pfw.containerNos.join(', '))}" placeholder="comma separated" autocomplete="off"></div>
    <div class="field"><label>Trade terms</label><input id="pfw_tradeTerms" value="${esc(pfw.tradeTerms)}" placeholder="e.g. CIF Busan, South Korea" autocomplete="off"></div>
    <div class="field"><label>Port of discharge</label><input id="pfw_portDischarge" value="${esc(pfw.portDischarge)}" autocomplete="off"></div>
    <div class="field" style="position:relative;"><label>Payment terms</label>
      <input id="pfw_paymentTerm" value="${esc(pfw.paymentTerm)}" autocomplete="off">
      <div id="pfwPayTermList3" class="ac-dropdown hidden"></div>
    </div>
    <div class="field"><label>Freight basis</label>
      <select id="pfw_freightLabel">
        ${['CIF (freight included)', 'FOB (freight excluded)'].map(o => `<option value="${esc(o)}" ${pfw.freightLabel === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
      </select>
    </div>
    <div class="field"><label>Reference (optional)</label><input id="pfw_reference" value="${esc(pfw.reference)}" autocomplete="off"></div>
    <div class="field"><label>Buyer PO (optional)</label><input id="pfw_buyerPo" value="${esc(pfw.buyerPo)}" autocomplete="off"></div>

    <div style="font-size:11.5px; color:var(--text-faint); margin-bottom:16px; line-height:1.5;">
      Country of origin and shipment allowance use your standard values (${esc(PF_DEFAULTS.country_of_origin)}, ${esc(PF_DEFAULTS.shipment_allowance)}). Change those on the dashboard if a deal needs different ones.
    </div>

    <div style="display:flex; gap:8px;">
      <button id="btnPfBack3" class="btn" style="flex:1;">Back</button>
      <button id="btnPfPreview" class="btn" style="flex:1;">Preview</button>
      <button id="btnPfGenerate" class="btn btn-primary" style="flex:2;">Generate</button>
    </div>`;
}

function pfCollectStep3() {
  $('pfwRates').querySelectorAll('.pfw-rate-row').forEach(row => {
    const it = pfw.items[Number(row.dataset.i)];
    if (it) it.rate = parseFloat(row.querySelector('.pfw-rate').value) || 0;
  });
  pfw.invNo = $('pfw_invNo').value.trim();
  pfw.invDate = toIsoDate($('pfw_invDate').value);
  pfw.containerNos = $('pfw_containerNos').value.split(',').map(s => s.trim()).filter(Boolean);
  pfw.tradeTerms = $('pfw_tradeTerms').value.trim();
  pfw.portDischarge = $('pfw_portDischarge').value.trim();
  pfw.paymentTerm = $('pfw_paymentTerm').value.trim();
  pfw.freightLabel = $('pfw_freightLabel').value;
  pfw.reference = $('pfw_reference').value.trim();
  pfw.buyerPo = $('pfw_buyerPo').value.trim();
}

// Builds the SAME payload shape dashboard/documents.html's
// collectProformaPayload() sends. Field names and nesting are load-bearing:
// helpers/proformaPdf.js and helpers/proformaSheetLog.js read them directly,
// so a rename here silently produces a blank column on her Edge Metals sheet
// rather than an error.
function pfBuildPayload() {
  const containers = pfw.containerNos.map(no => ({
    container_no: no,
    // Sent ALONGSIDE container_no, not glued into it — the Container # box
    // stays bare, but proformaSheetLog.js still needs the code to build its
    // "Inv No." column as [date]_[item]_[code].
    item_code: docDeriveItemCode(pfw.items[0] && pfw.items[0].desc) || null,
    items: pfw.items.map(it => ({ desc: it.desc.trim(), qty: it.qty || 0, rate: it.rate || 0, unit: PF_DEFAULTS.qty_unit })),
  })).filter(c => c.container_no && c.items.length);

  return {
    inv_no: pfw.invNo,
    inv_date: pfw.invDate,
    reference: pfw.reference,
    qty_unit: PF_DEFAULTS.qty_unit,
    consignee: pfw.consignee,
    // Full alias tag for the sheet log; falls back to the plain name for a
    // hand-typed consignee with no address-book entry.
    consignee_sheet_tag: pfw.consigneeTag || pfw.consignee,
    consignee_address: pfw.consigneeEntry
      ? (pfw.consigneeEntry.raw || '').split('\n').map(l => l.trim()).filter(Boolean)
      : [],
    trade_terms: pfw.tradeTerms,
    port_discharge: pfw.portDischarge,
    // Both editable on step 3 now — fall back to the standard values only if
    // the boxes were cleared entirely, since proformaPdf.js prints whatever
    // it's given and a blank payment term on a real proforma is worse than
    // the usual one.
    payment_term: pfw.paymentTerm || PF_DEFAULTS.payment_term,
    freight_label: pfw.freightLabel || PF_DEFAULTS.freight_label,
    buyer_po: pfw.buyerPo,
    buyer_po_date: pfw.buyerPoDate,
    country_of_origin: PF_DEFAULTS.country_of_origin,
    shipment_allowance: PF_DEFAULTS.shipment_allowance,
    containers,
  };
}

function wirePfStep3() {
  wirePfPayTermField('pfw_paymentTerm', 'pfwPayTermList3');
  const retotal = () => {
    pfCollectStep3();
    const total = pfw.items.reduce((s, it) => s + (it.qty || 0) * (it.rate || 0), 0) * pfw.containerCount;
    $('pfwTotal').innerHTML = `Total across ${pfw.containerCount} container(s): <span style="color:var(--text-strong);">$${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`;
  };
  $('pfwRates').querySelectorAll('.pfw-rate').forEach(inp => inp.addEventListener('input', retotal));

  // Editing trade terms here re-syncs the freight basis, so switching a deal
  // to "FOB Busan" on this screen doesn't leave a CIF freight line behind it.
  // pfSyncFreightToTradeTerms only moves the value when the two disagree, so
  // deliberately choosing FOB under CIF trade terms (or the reverse) sticks.
  $('pfw_tradeTerms').addEventListener('blur', () => {
    pfw.tradeTerms = $('pfw_tradeTerms').value.trim();
    const before = pfw.freightLabel;
    pfSyncFreightToTradeTerms();
    if (pfw.freightLabel !== before) $('pfw_freightLabel').value = pfw.freightLabel;
  });

  $('btnPfBack3').addEventListener('click', () => { pfCollectStep3(); pfw.step = 2; renderPfWizard(); });

  $('btnPfPreview').addEventListener('click', () => pfSubmit(true));
  $('btnPfGenerate').addEventListener('click', () => pfSubmit(false));
}

async function pfSubmit(preview) {
  pfCollectStep3();
  const payload = pfBuildPayload();
  const msg = $('pfMsg');
  // Validate before spending a round trip. The server would reject these
  // too, but a 500 with a stack-trace message is not an answer anyone can
  // act on while standing in a yard.
  if (!payload.inv_no) { msg.style.color = 'var(--status-danger)'; msg.textContent = 'Invoice No is required.'; return; }
  if (!payload.containers.length) { msg.style.color = 'var(--status-danger)'; msg.textContent = 'Enter at least one container number.'; return; }
  if (payload.containers.some(c => c.items.some(it => !it.rate))) {
    if (!await askYesNo('Some materials have no rate, so they will show as $0 on the proforma.\n\nGenerate anyway?')) return;
  }

  const btn = preview ? $('btnPfPreview') : $('btnPfGenerate');
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = preview ? 'Building…' : 'Generating…';
  msg.textContent = '';
  try {
    if (preview) {
      // preview=1 returns the PDF inline and archives nothing — the same
      // "look before you commit" step the dashboard has.
      const res = await fetch(API_BASE + '/api/proforma/generate?preview=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await docErrText(res));
      const blob = await res.blob();
      if (!blob.size) throw new Error('the server returned an empty PDF');
      await deliverExportedFile(blob, `proforma-preview-${payload.inv_no.replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`, 'pdf');
    } else {
      const result = await api('/api/proforma/generate', { method: 'POST', body: JSON.stringify(payload) });
      msg.style.color = 'var(--status-success, #3fae55)';
      msg.textContent = '✓ Generated and saved.';
      if (result && result.saved_filename) {
        await docShareSaved('proforma', result.saved_filename, payload.inv_no, '');
      }
    }
  } catch (err) {
    msg.style.color = 'var(--status-danger)';
    msg.textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

// Server error bodies are JSON {error}; fall back to the status code when
// the response isn't JSON at all (a proxy error page, say).
async function docErrText(res) {
  try { const j = await res.json(); if (j && j.error) return j.error; } catch (e) {}
  return `request failed (${res.status})`;
}

// The non-preview routes archive the PDF server-side and return only a
// filename, so the actual bytes have to be fetched back through the
// documents-download route before they can be shared.
async function docShareSaved(kind, filename, label, containerNo) {
  try {
    // ── bolTodayISO(), NOT docTodayISO() ────────────────────────────────────
    // This is the folder guess, and it has to agree with the date the SERVER
    // filed the document under. Both were UTC and therefore agreed by
    // accident; helpers/documentsSaved.js moved to America/Los_Angeles on
    // 2026-09-17, so this moved with it in the same commit.
    //
    // docTodayISO() is deliberately NOT changed here: it also seeds the date
    // PRINTED on an invoice, and moving that is a change to a document
    // customers receive. Same UTC problem, still worth fixing, still worth
    // fixing on purpose rather than as a side effect of this.
    const qs = `?kind=${kind}&file=${encodeURIComponent(filename)}&date=${bolTodayISO()}` +
      (containerNo ? `&container=${encodeURIComponent(containerNo)}` : '');
    const res = await fetch(API_BASE + '/api/documents/download' + qs, { headers: { Authorization: 'Bearer ' + getToken() } });
    if (!res.ok) return; // saved fine, just can't hand it over — message above already says "saved"
    const blob = await res.blob();
    if (!blob.size) return;
    await deliverExportedFile(blob, filename, 'pdf');
  } catch (e) { /* sharing is a convenience; the document is already saved */ }
}

// ── INVOICE — search, pick, review, generate ──────────────────────────────
// Deliberately single-container. The dashboard's multi-select batch queue
// (several containers under one booking merged into one invoice, reviewed
// one group at a time) is not ported: it's a desk workflow, and getting it
// subtly wrong would produce a WRONG commercial invoice rather than a
// cosmetic bug. Search by container number still accepts anything typed, so
// a booking-merged invoice can be found and re-checked on the dashboard.
let invw = null;
function resetInvFlow() {
  invw = {
    step: 1, buyer: '', buyerTag: null, containers: [], data: null,
    // Multi-container selection, added 2026-08-22 per Apsara ("multiple
    // container selection not there in app inv"). I left this out of the
    // original port on the grounds that getting a merged commercial invoice
    // subtly wrong is worse than not offering it — she needs it, so it's
    // ported from the dashboard's logic rather than reinvented.
    picked: new Set(),   // container_no values ticked on step 2
    mergeAll: false,     // manual override — see pickInvGroups
    queue: [], queueIndex: 0,
    // Buyer search returns everything on record — 67 containers for Taewon.
    // Only the newest few are ever the answer to "what am I invoicing now",
    // so the list is capped and the full set kept here behind a Show all.
    allContainers: [], showAll: false, cappedFrom: 0,
  };
}

// The 5 most recent containers for a buyer, per Apsara 2026-08-22 ("just show
// last 5 containers against the buyer").
//
// Sorted by INVOICE DATE, not by the order the server returns. The server
// reverses sheet order as a proxy for recency, which is usually right but
// isn't a date sort — on the live sheet the top two rows for Taewon are
// "USED IT FOR WOOSHIN Mixed Load" and "2/8", neither of which is a real
// container and neither of which has a date. Taking the server's first five
// would have spent two of the five slots on those and pushed a genuinely
// recent shipment off the list.
//
// Undated rows sort to the BOTTOM rather than being dropped: they're
// unusual, but a container with a blank invoice date is still a real
// container, and silently hiding one is exactly the failure this cap could
// otherwise cause.
// ── Proforma material suggestions ─────────────────────────────────────────
// Ported from dashboard/documents.html 2026-08-22 after Apsara: "in material
// of proforma, the change i told is missing" — then "check my dashboard",
// where it already existed. The phone's material box was plain text with no
// suggestions at all, which is worst precisely on the step a proforma STARTS
// from.
//
// TWO sources, in this order, matching the dashboard exactly:
//   1. What THIS consignee has ordered before (from customer-pricing memory).
//      Flagged "known price" because picking one also means a rate is already
//      remembered for it, which is the difference between a suggestion worth
//      taking and one that just saves typing.
//   2. The shared item-description catalog (/api/item-types) — the same list
//      the Loads screen uses. Sharing it is the dashboard's existing choice,
//      not a new one I made here; keeping a separate proforma list would have
//      meant the same material typed in the yard never appearing here.
//
// A description in both lists appears ONCE, as history, so the customer's own
// wording wins over the generic entry.
let pfGenericDescs = null, pfGenericDescsLoading = null, pfCustomerDescs = [], pfMemoryPaymentTerms = '';

async function pfLoadGenericDescs() {
  if (pfGenericDescs) return pfGenericDescs;
  // One in-flight request shared by every row — several material rows all
  // asking on first keystroke should not be several identical fetches.
  if (!pfGenericDescsLoading) {
    pfGenericDescsLoading = api('/api/item-types')
      .then(l => { pfGenericDescs = Array.isArray(l) ? l : []; return pfGenericDescs; })
      .catch(() => { pfGenericDescs = []; return pfGenericDescs; }) // offline: history still works
      .finally(() => { pfGenericDescsLoading = null; });
  }
  return pfGenericDescsLoading;
}

// Read-only half of the pricing lookup. lookupPricingMemory's full version
// also fills trade terms, port and invoice number — which must NOT happen at
// step 1, a full step before those fields exist. Same split the dashboard
// makes for the same reason.
async function pfPreloadCustomerDescs(customer) {
  const name = String(customer || '').trim();
  if (!name) { pfCustomerDescs = []; pfMemoryPaymentTerms = ''; return; }
  try {
    const info = await api('/api/customer-pricing/lookup?customer=' + encodeURIComponent(name));
    pfCustomerDescs = (info && info.items) ? Object.keys(info.items) : [];
    // Payment terms too, now that step 2 asks for them. The same lookup was
    // already being made and this field was being thrown away.
    pfMemoryPaymentTerms = (info && info.payment_terms) || '';
    pfApplyMemoryPaymentTerm();
  } catch (e) { pfCustomerDescs = []; pfMemoryPaymentTerms = ''; }
}

// Fills the payment-terms box from what this customer was last invoiced on.
// Called when the lookup resolves rather than when the step opens, because the
// lookup is deliberately fire-and-forget (see btnPfNext1) so the material step
// paints instantly on a phone rather than waiting on the network.
//
// Precedence: what she types > this customer's memory > the house default.
function pfApplyMemoryPaymentTerm() {
  if (!pfw || !pfMemoryPaymentTerms) return;
  if (pfw.paymentTermTouched) return;
  const cur = String(pfw.paymentTerm || '').trim();
  if (cur && cur !== PF_DEFAULTS.payment_term) return;
  pfw.paymentTerm = pfMemoryPaymentTerms;
  // Whichever box is on screen — step 2 asks, step 3 confirms.
  for (const id of ['pfw_paymentTerm2', 'pfw_paymentTerm']) {
    const el = $(id);
    if (el && !el.dataset.touched) el.value = pfMemoryPaymentTerms;
  }
}

function pfDescSuggestions(q, customerDescs, genericDescs) {
  const needle = String(q || '').trim().toLowerCase();
  const seen = new Set();
  const out = [];
  const push = (text, fromHistory) => {
    const key = String(text || '').trim().toLowerCase();
    if (!key || seen.has(key)) return;   // a description in both lists is shown once, as history
    seen.add(key);
    out.push({ text: String(text).trim(), fromHistory });
  };
  // Empty query still lists this customer's own history — she asked for the
  // list "as soon as I type", and on an empty box the most useful thing is
  // what this customer always orders.
  const match = (t) => !needle || String(t).toLowerCase().includes(needle);
  (customerDescs || []).filter(match).forEach((t) => push(t, true));
  (genericDescs || []).filter(match).forEach((t) => push(t, false));
  return out.slice(0, 12);
}

const INV_BUYER_LIMIT = 5;
function invRecentFirst(containers) {
  const parse = (d) => {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(d || '').trim());
    return m ? new Date(+m[3], +m[1] - 1, +m[2]).getTime() : null;
  };
  return containers
    .map((c, i) => ({ c, t: parse(c.inv_date), i }))
    .sort((a, b) => {
      if (a.t === null && b.t === null) return a.i - b.i; // keep server order among undated
      if (a.t === null) return 1;
      if (b.t === null) return -1;
      return b.t - a.t;
    })
    .map((x) => x.c);
}

// Decides how the ticked containers become invoices. Lifted from
// dashboard/documents.html's groupSelectedContainersByBooking, deliberately
// unchanged in behaviour — two clients producing different invoices from the
// same tick boxes would be a genuinely dangerous divergence.
//
//   mergeAll ticked   -> everything selected becomes ONE invoice, whatever
//                        their bookings. This is the manual override for
//                        "merge these two even though they shipped apart".
//   otherwise         -> containers sharing a booking # merge automatically;
//                        a container with no booking # NEVER merges, not even
//                        with another blank one, because there'd be no actual
//                        basis for combining them.
function pickInvGroups(containers) {
  if (invw.mergeAll && containers.length > 1) {
    const bookings = [...new Set(containers.map(c => (c.booking_no || '').trim().toUpperCase()).filter(Boolean))];
    return [{
      // Version history keys off booking_no, and a cross-booking merge has no
      // single one — join them rather than picking the first, which would
      // quietly overwrite another shipment's history.
      booking_no: bookings.join('+'),
      containers: containers.map(c => c.container_no),
    }];
  }
  const groups = new Map();
  let singleton = 0;
  for (const c of containers) {
    const booking = (c.booking_no || '').trim().toUpperCase();
    const key = booking || `__single__${singleton++}`;
    if (!groups.has(key)) groups.set(key, { booking_no: booking, containers: [] });
    groups.get(key).containers.push(c.container_no);
  }
  return [...groups.values()];
}

// Loads the next group in the queue into the review screen. A group that
// fails to load is reported and SKIPPED rather than aborting the batch —
// one bad container shouldn't cost you the other four you selected.
async function loadNextInvGroup() {
  if (invw.queueIndex >= invw.queue.length) {
    invw.queue = []; invw.queueIndex = 0;
    invw.step = 2; renderInvFlow();
    return;
  }
  const group = invw.queue[invw.queueIndex];
  const multi = group.containers.length > 1;
  try {
    invw.data = multi
      ? await api('/api/invoice/preview-multi?containers=' + encodeURIComponent(group.containers.join(',')))
      : await api('/api/invoice/preview?container=' + encodeURIComponent(group.containers[0]));
    // Where this review came from, so Refresh can ask the same question again.
    // NOT read back off the form: she may have corrected the container box,
    // and refreshing would then pull a different shipment's figures into an
    // invoice that already carries this one's.
    invw.source = { containers: group.containers.slice(), multi };
    invw.step = 3; renderInvFlow();
  } catch (e) {
    alert(`${group.containers.join(', ')}: ${e.message}`);
    invw.queueIndex++;
    await loadNextInvGroup();
  }
}

function renderInvFlow() {
  if (!invw) resetInvFlow();
  const body = { 1: invStep1Html, 2: invStep2Html, 3: invStep3Html }[invw.step]();
  $('docBody').innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
      <div style="font-family:var(--font-mono); font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--text-faint);">Step ${invw.step} of 3</div>
      ${invw.step > 1 ? '<button id="btnInvReset" class="btn" style="padding:4px 10px; font-size:10px;">Start over</button>' : ''}
    </div>
    ${body}
    <div id="invMsg" style="margin-top:14px; font-family:var(--font-mono); font-size:11px;"></div>`;
  if ($('btnInvReset')) $('btnInvReset').addEventListener('click', () => { resetInvFlow(); renderInvFlow(); });
  ({ 1: wireInvStep1, 2: wireInvStep2, 3: wireInvStep3 }[invw.step])();
}

function invStep1Html() {
  return `
    <div class="field" style="position:relative;">
      <label>Buyer</label>
      <input id="invw_buyer" placeholder="Start typing a customer" autocomplete="off" value="${esc(invw.buyer)}">
      <div id="invwBuyerList" class="ac-dropdown hidden"></div>
    </div>
    <button id="btnInvSearchBuyer" class="btn btn-primary" style="width:100%;">Find their shipments</button>
    <div style="display:flex; align-items:center; gap:10px; margin:18px 0;">
      <div style="flex:1; height:1px; background:var(--border-subtle);"></div>
      <span style="font-family:var(--font-mono); font-size:10px; color:var(--text-faint);">OR SEARCH DIRECTLY</span>
      <div style="flex:1; height:1px; background:var(--border-subtle);"></div>
    </div>
    <div class="field"><label>Container number</label><input id="invw_containerSearch" placeholder="e.g. 26JY52" autocomplete="off"></div>
    <button id="btnInvSearchContainer" class="btn" style="width:100%;">Search by container</button>
    <!-- Invoice-number search, added 2026-08-22 to match the dashboard: the
         route (/api/invoice/by-inv-no, commit 8dc3495 "INV BY INV NO")
         already existed server-side but nothing on the phone called it.
         Useful when you have the paperwork in hand and the invoice number is
         the only thing on it you can read. -->
    <div class="field" style="margin-top:14px;"><label>Invoice number</label><input id="invw_invNoSearch" placeholder="e.g. 260822_AC_26JY95" autocomplete="off"></div>
    <button id="btnInvSearchInvNo" class="btn" style="width:100%;">Search by invoice no</button>`;
}
function wireInvStep1() {
  wireDocTypeahead('invw_buyer', 'invwBuyerList',
    (entry) => {
      // The sheet is queried by the FULL alias tag, matching the dashboard —
      // the buyer column there holds the tagged form.
      invw.buyerTag = (entry.aliases || []).join('/') || docConsigneeName(entry);
      invw.buyer = docConsigneeName(entry);
      $('invw_buyer').value = invw.buyer;
    },
    () => { invw.buyerTag = null; });

  // cap=true only for the buyer path. A container-number or invoice-number
  // search is a targeted lookup — you already know what you're after, and
  // trimming those results would just hide the thing you searched for.
  const search = async (btn, url, label, cap) => {
    btn.disabled = true; const old = btn.textContent; btn.textContent = 'Searching…';
    $('invMsg').textContent = '';
    try {
      const { containers } = await api(url);
      if (!containers || !containers.length) {
        $('invMsg').style.color = 'var(--status-warning)';
        $('invMsg').textContent = `No shipments found for ${label}. Check the spelling, or it may not be logged in the Invoice sheet yet.`;
        return;
      }
      const ordered = cap ? invRecentFirst(containers) : containers;
      invw.allContainers = ordered;
      invw.showAll = !cap;
      invw.cappedFrom = cap ? ordered.length : 0;
      invw.containers = cap ? ordered.slice(0, INV_BUYER_LIMIT) : ordered;
      invw.picked = new Set(); // a new search invalidates the old ticks
      invw.step = 2; renderInvFlow();
    } catch (e) {
      $('invMsg').style.color = 'var(--status-danger)';
      $('invMsg').textContent = e.message;
    } finally { btn.disabled = false; btn.textContent = old; }
  };

  $('btnInvSearchBuyer').addEventListener('click', () => {
    const buyer = invw.buyerTag || $('invw_buyer').value.trim();
    if (!buyer) return;
    invw.buyer = $('invw_buyer').value.trim();
    search($('btnInvSearchBuyer'), '/api/invoice/by-buyer?buyer=' + encodeURIComponent(buyer), invw.buyer, true);
  });
  $('btnInvSearchContainer').addEventListener('click', () => {
    const q = $('invw_containerSearch').value.trim();
    if (!q) return;
    search($('btnInvSearchContainer'), '/api/invoice/by-container?q=' + encodeURIComponent(q), q, false);
  });
  $('invw_containerSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnInvSearchContainer').click(); });
  $('btnInvSearchInvNo').addEventListener('click', () => {
    const q = $('invw_invNoSearch').value.trim();
    if (!q) return;
    search($('btnInvSearchInvNo'), '/api/invoice/by-inv-no?q=' + encodeURIComponent(q), q, false);
  });
  $('invw_invNoSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnInvSearchInvNo').click(); });
}

function invStep2Html() {
  return `
    <div style="font-size:12px; color:var(--text-muted); margin-bottom:12px;">
      ${invw.cappedFrom && !invw.showAll
        ? `Showing the ${invw.containers.length} most recent of ${invw.cappedFrom} on record.`
        : `${invw.containers.length} shipment${invw.containers.length === 1 ? '' : 's'} found.`}
      Tap one to invoice it on its own, or tick several to do a batch.
    </div>
    ${invw.cappedFrom > INV_BUYER_LIMIT && !invw.showAll
      ? `<button id="btnInvShowAll" class="btn" style="width:100%; margin-bottom:12px; font-size:11.5px;">Show all ${invw.cappedFrom}</button>` : ''}
    <div style="display:flex; flex-direction:column; gap:8px;">
      ${invw.containers.map((c, i) => `
        <div class="inv-row" data-i="${i}" style="display:flex; align-items:center; gap:11px; padding:11px 13px; background:var(--surface-sunken); border-radius:var(--radius-sm);">
          <input type="checkbox" class="inv-check" data-i="${i}" ${invw.picked.has(c.container_no) ? 'checked' : ''} style="width:20px; height:20px; flex-shrink:0; margin:0;">
          <div class="inv-open" data-i="${i}" style="flex:1; min-width:0;">
            <div style="font-family:var(--font-mono); font-size:13px; font-weight:700; color:var(--text-strong);">${esc(c.container_no)}</div>
            <div style="font-size:11.5px; color:var(--text-muted); margin-top:3px;">${esc(c.consignee || '')} · ${c.item_count} item row${c.item_count === 1 ? '' : 's'}</div>
            <div style="font-family:var(--font-mono); font-size:10.5px; color:var(--text-faint); margin-top:2px;">
              ${esc(c.inv_no || '—')} ${esc(c.inv_date || '')}${c.booking_no ? ` · bkg ${esc(c.booking_no)}` : ''}
            </div>
          </div>
        </div>`).join('')}
    </div>

    <!-- Batch bar. Hidden until something is ticked, so the single-container
         path (still the common one) looks exactly as it did. -->
    <div id="invBatchBar" class="hidden" style="margin-top:14px; padding:12px 13px; background:var(--surface-sunken); border-radius:var(--radius-sm); border:1px solid var(--border-default);">
      <div id="invBatchCount" style="font-size:12.5px; font-weight:600; color:var(--text-strong);"></div>
      <label style="display:flex; align-items:start; gap:9px; margin-top:10px; cursor:pointer;">
        <input type="checkbox" id="invMergeAll" ${invw.mergeAll ? 'checked' : ''} style="width:18px; height:18px; margin:0; flex-shrink:0;">
        <span style="font-size:12px; color:var(--text-muted); line-height:1.45;">
          Merge everything selected into ONE invoice, even across bookings.
        </span>
      </label>
      <div id="invBatchPlan" style="font-family:var(--font-mono); font-size:10.5px; color:var(--text-faint); margin-top:9px; line-height:1.55;"></div>
      <button id="btnInvBatch" class="btn btn-primary" style="width:100%; margin-top:11px;">Review selected</button>
    </div>

    <button id="btnInvBack2" class="btn" style="width:100%; margin-top:14px;">Back</button>`;
}
function wireInvStep2() {
  wireUsDateField('invw_date');
  $('btnInvBack2').addEventListener('click', () => { invw.step = 1; renderInvFlow(); });
  // Escape hatch. Capping a list without one is how you end up unable to
  // invoice the sixth-newest shipment at all.
  if ($('btnInvShowAll')) $('btnInvShowAll').addEventListener('click', () => {
    invw.showAll = true;
    invw.containers = invw.allContainers;
    renderInvFlow();
  });

  // Shows, in plain terms, what the current ticks will actually produce
  // BEFORE anything is generated. Worth the space: "3 selected" does not tell
  // you whether that means one merged invoice or three separate ones, and
  // that difference is the whole point of the feature.
  const refreshBatchBar = () => {
    const picked = invw.containers.filter(c => invw.picked.has(c.container_no));
    const bar = $('invBatchBar');
    if (!picked.length) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    $('invBatchCount').textContent = `${picked.length} container${picked.length === 1 ? '' : 's'} selected`;
    const groups = pickInvGroups(picked);
    $('invBatchPlan').innerHTML = groups.map(g => g.containers.length > 1
      ? `→ one invoice for ${g.containers.length}: ${esc(g.containers.join(', '))}${g.booking_no ? ` (bkg ${esc(g.booking_no)})` : ''}`
      : `→ one invoice for ${esc(g.containers[0])}`).join('<br>');
    $('btnInvBatch').textContent = groups.length === 1
      ? 'Review 1 invoice'
      : `Review ${groups.length} invoices, one at a time`;
  };

  $('docBody').querySelectorAll('.inv-check').forEach(box => box.addEventListener('change', () => {
    const c = invw.containers[Number(box.dataset.i)];
    if (box.checked) invw.picked.add(c.container_no); else invw.picked.delete(c.container_no);
    refreshBatchBar();
  }));
  $('invMergeAll').addEventListener('change', () => { invw.mergeAll = $('invMergeAll').checked; refreshBatchBar(); });
  refreshBatchBar();

  // Tapping the row body (not the checkbox) still opens that one container
  // straight away — the single-invoice path is unchanged and stays one tap.
  $('docBody').querySelectorAll('.inv-open').forEach(el => el.addEventListener('click', async () => {
    const c = invw.containers[Number(el.dataset.i)];
    $('invMsg').textContent = 'Loading…';
    try {
      // The server computes every figure from the Invoice sheet — weights,
      // rates, packing breakdown, the lot. Nothing here recalculates it.
      invw.data = await api('/api/invoice/preview?container=' + encodeURIComponent(c.container_no));
      invw.source = { containers: [c.container_no], multi: false };
      invw.queue = []; invw.queueIndex = 0; // a direct tap is not a batch
      invw.step = 3; renderInvFlow();
    } catch (e) {
      $('invMsg').style.color = 'var(--status-danger)';
      $('invMsg').textContent = e.message;
    }
  }));

  $('btnInvBatch').addEventListener('click', async () => {
    const picked = invw.containers.filter(c => invw.picked.has(c.container_no));
    if (!picked.length) return;
    const btn = $('btnInvBatch');
    btn.disabled = true; btn.textContent = 'Loading…';
    invw.queue = pickInvGroups(picked);
    invw.queueIndex = 0;
    await loadNextInvGroup();
  });
}

// Step 3 — review and generate. The figures arrive computed; this screen
// exists so a human looks before a real commercial invoice goes out, which
// is the same principle the old Flask tool's generate.html had.
function invStep3Html() {
  const d = invw.data || {};
  const items = (d.line_items || []).map(it => ({
    ...it,
    container_no: it.container_no || d.container_no || '',
    seal_no: it.seal_no || d.seal_no || '',
  }));
  const notes = Array.isArray(d.notes) ? d.notes
    : (Number(d.freight) > 0 ? [{ label: 'Less: Freight Charges', amount: -Number(d.freight) }] : []);
  const addr = (d.consignee_address && d.consignee_address.length)
    ? d.consignee_address.join('\n')
    : invLookupAddress(d.consignee || '');
  const g = invw.queue[invw.queueIndex];
  const inQueue = invw.queue.length > 0 && g;
  const banner = inQueue ? `
    <div style="padding:10px 13px; margin-bottom:14px; border-radius:var(--radius-sm); background:rgba(214,158,46,.12); border:1px solid var(--status-warning, #d69e2e);">
      <div style="font-size:12px; font-weight:700; color:var(--text-strong);">Reviewing ${invw.queueIndex + 1} of ${invw.queue.length}</div>
      <div style="font-size:11.5px; color:var(--text-muted); margin-top:3px; line-height:1.45;">
        ${g.containers.length > 1
          ? `${g.containers.length} containers merged into this one invoice: ${esc(g.containers.join(', '))}${g.booking_no ? ` (booking ${esc(g.booking_no)})` : ''}`
          : esc(g.containers[0])}
      </div>
      <button id="btnInvQueueCancel" class="btn" style="margin-top:9px; padding:5px 11px; font-size:10.5px;">Stop the batch</button>
    </div>` : '';
  return `
    ${banner}
    <div style="background:var(--surface-sunken); border-radius:var(--radius-sm); padding:12px 14px; margin-bottom:16px;">
      <div style="font-family:var(--font-mono); font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--text-faint);">Consignee</div>
      <div style="font-size:13.5px; font-weight:600; color:var(--text-strong); margin-top:3px;">${esc(d.consignee || '—')}</div>
    </div>

    <!-- Apsara, 2026-09-16: "provide refresh button so that it can fetch
         latets data from order details." Asked what it should overwrite she
         chose "Ask me each time", so it asks rather than guessing between
         losing her header edits and ignoring a sheet correction to them. -->
    <div style="display:flex; gap:8px; align-items:center; margin-bottom:12px; flex-wrap:wrap;">
      <button id="btnInvwRefresh" class="btn" style="padding:6px 11px; font-size:11px;">Refresh from order details</button>
      <span id="invwRefreshStatus" style="font-size:11px; color:var(--text-muted);"></span>
    </div>
    <div id="invwRefreshChoice" class="hidden" style="border:1px solid var(--border-subtle); border-radius:var(--radius-sm); padding:10px 12px; margin-bottom:12px;">
      <div style="font-size:12px; color:var(--text-strong); margin-bottom:8px;">Refresh what?</div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button id="btnInvwRefreshRows" class="btn" style="padding:6px 10px; font-size:10.5px;">Just the item rows</button>
        <button id="btnInvwRefreshAll" class="btn" style="padding:6px 10px; font-size:10.5px;">The whole invoice</button>
        <button id="btnInvwRefreshCancel" class="btn" style="padding:6px 10px; font-size:10.5px;">Cancel</button>
      </div>
      <div style="font-size:11px; color:var(--text-faint); margin-top:8px; line-height:1.45;">Rows only keeps your invoice number, date, address and adjustments.</div>
    </div>

    <div class="field"><label>Invoice No</label><input id="invw_no" value="${esc(d.inv_no || '')}" autocomplete="off"></div>
    <div class="field"><label>Invoice date</label><input id="invw_date" placeholder="MM/DD/YYYY" value="${esc(toUsDate(d.inv_date || ''))}" autocomplete="off"></div>
    <!-- One unit, chosen here, drives the quantity column, the rate column
         and both printed headings. They cannot disagree because one decides
         the others. LB is the default for a NEW invoice because that is how
         she buys and prices; a REOPENED one keeps whatever it was saved as,
         which is what invwUnitsOfData works out. -->
    <div class="field"><label for="invw_units">Invoice in</label>
      <select id="invw_units">
        <option value="lb"${invwUnitsOfData(d) === 'lb' ? ' selected' : ''}>Pounds &mdash; qty in lbs, rate in US$/lb</option>
        <option value="mt"${invwUnitsOfData(d) === 'mt' ? ' selected' : ''}>Metric tonnes &mdash; qty in MT, rate in US$/MT</option>
      </select></div>
    <div class="field"><label>Consignee address</label><textarea id="invw_address" rows="3" style="width:100%; padding:11px 12px; background:var(--surface-sunken); border:1px solid var(--border-default); border-radius:var(--radius-sm); color:var(--text-strong); outline:none; font-family:inherit; font-size:13px; resize:vertical;">${esc(addr)}</textarea></div>

    <!-- Full line-items table, added 2026-08-22 per Apsara ("show item table
         as well in inv"). It replaces a stacked card per item, which showed
         only description/weight/rate/container/seal and carried the SIX
         packing figures through invisibly from the server preview — gross,
         truck, container tare, chassis, boxes and net lbs. Those figures are
         printed on the finished invoice, so being unable to see or correct
         them on the phone meant the one screen that exists to be checked
         before a real commercial document goes out was hiding a third of what
         goes on it.
         Same 13 columns as the dashboard, in the same order. Scrolls
         sideways rather than wrapping: a squeezed 13-column grid on a phone
         is unreadable, and these are figures people check against paperwork,
         so legibility beats fitting. -->
    <div style="display:flex; justify-content:space-between; align-items:baseline; margin:18px 0 8px;">
      <div style="font-family:var(--font-mono); font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--text-muted);">Line items &amp; packing weights</div>
      <div style="font-family:var(--font-mono); font-size:9.5px; color:var(--text-faint);">scroll →</div>
    </div>
    <div style="overflow-x:auto; -webkit-overflow-scrolling:touch; border:1px solid var(--border-default); border-radius:var(--radius-sm);">
      <!-- data-wide="deliberate": this one does NOT stack into cards on a
           phone, unlike the Petty cash / Report / Inventory tables. 13
           columns of figures being checked line by line against a paper
           document read better as a grid you scroll than as 13 stacked
           labels per row — see the note above. The attribute exists so
           tests/mobile-layout.js can tell a considered exception from a
           table someone simply forgot about. -->
      <table id="invwItems" data-wide="deliberate" style="border-collapse:collapse; min-width:920px; font-size:12px;">
        <thead>
          <tr style="background:var(--surface-sunken);">
            <!-- The quantity and rate headings carry ids because they name a
                 unit that can change after this table is rendered. "Qty MT"
                 printed above a pounds figure is precisely how the $13.09
                 invoice got signed, so the heading is never a fixed string. -->
            ${[['#'], ['Container #'], ['Seal #'], ['Description'],
               [invwUnitsOfData(d) === 'mt' ? 'Qty MT' : 'Qty lbs', 'invwQtyHead'],
               [invwUnitsOfData(d) === 'mt' ? 'Rate US$/MT' : 'Rate US$/lb', 'invwRateHead'],
               ['Amount'], ['Gross lbs'], ['Truck lbs'], ['Tare lbs'], ['Chassis lbs'], ['Boxes lbs'], ['Net lbs']]
              .map(([h, id]) => `<th${id ? ` id="${id}"` : ''} style="padding:7px 8px; text-align:left; font-family:var(--font-mono); font-size:9.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); white-space:nowrap; border-bottom:1px solid var(--border-default);">${h}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
        ${items.map((it, i) => {
          const p = it.packing || {};
          const cell = (inner) => `<td style="padding:5px 6px; border-bottom:1px solid var(--border-subtle);">${inner}</td>`;
          const inp = (cls, val, w, type) => `<input class="${cls}" ${type ? `type="${type}" step="any"` : ''} value="${esc(val ?? '')}" style="width:${w}px; padding:6px 7px; background:var(--surface-sunken); border:1px solid var(--border-default); border-radius:4px; color:var(--text-strong); outline:none; font-size:12px;">`;
          return `<tr class="invw-item" data-i="${i}">
            ${cell(`<span style="font-family:var(--font-mono); font-size:11px; color:var(--text-faint);">${i + 1}</span>`)}
            ${cell(inp('invw-container', it.container_no, 92))}
            ${cell(inp('invw-seal', it.seal_no, 78))}
            ${cell(inp('invw-desc', it.item_desc, 150))}
            ${cell(inp('invw-weight', it.weight, 72, 'number'))}
            ${cell(inp('invw-rate', it.rate, 72, 'number'))}
            ${cell(`<span class="invw-amount" style="font-family:var(--font-mono); font-size:11.5px; color:var(--text-muted); white-space:nowrap;"></span>`)}
            ${cell(inp('invw-p-gross', p.gross_weight_lbs, 78))}
            ${cell(inp('invw-p-truck', p.truck_lbs, 78))}
            ${cell(inp('invw-p-tare', p.container_tare_lbs, 78))}
            ${cell(inp('invw-p-chassis', p.chassis_lbs, 78))}
            ${cell(inp('invw-p-boxes', p.boxes_weight_lbs, 78))}
            ${cell(`<input class="invw-p-net" readonly tabindex="-1" value="${esc(p.net_weight_lbs ?? '')}" style="width:84px; padding:6px 7px; background:var(--surface-sunken); border:1px solid var(--border-subtle); border-radius:4px; color:var(--text-muted); outline:none; font-size:12px;">`)}
          </tr>`;
        }).join('')}
        </tbody>
      </table>
    </div>

    <div style="font-family:var(--font-mono); font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--text-muted); margin:18px 0 8px;">Adjustments</div>
    <div id="invwNotes" style="display:flex; flex-direction:column; gap:8px;">
      ${notes.map((n, i) => `
        <div class="invw-note" data-i="${i}" style="display:grid; grid-template-columns:1fr 104px auto; gap:6px; align-items:center;">
          <input class="invw-note-label" value="${esc(n.label || '')}" placeholder="e.g. Less: Freight">
          <input class="invw-note-amount" type="text" inputmode="decimal" value="${n.amount ?? ''}">
          <button type="button" class="btn btn-danger invw-note-del" style="padding:6px 9px; font-size:10px;">✕</button>
        </div>`).join('')}
    </div>
    <button id="btnInvAddNote" class="btn" style="width:100%; margin-top:8px; font-size:11px;">+ Add adjustment</button>
    <div style="font-size:11.5px; color:var(--text-faint); margin-top:6px;">Use a negative amount to deduct, e.g. freight.</div>

    <div id="invwTotals" style="margin-top:16px; padding:12px 14px; background:var(--surface-sunken); border-radius:var(--radius-sm); font-family:var(--font-mono); font-size:12px;"></div>

    <div style="display:flex; gap:8px; margin-top:16px;">
      <button id="btnInvBack3" class="btn" style="flex:1;">Back</button>
      <button id="btnInvPreview" class="btn" style="flex:1;">Preview</button>
      <button id="btnInvGenerate" class="btn btn-primary" style="flex:2;">Generate</button>
    </div>`;
}

// The Invoice sheet has no address columns, so a fresh preview carries only
// the consignee tag — the address is looked up from the address book, same
// as the dashboard does.
function invLookupAddress(consigneeTag) {
  const parts = consigneeTag.split('/').map(s => s.trim()).filter(Boolean);
  const term = (parts[parts.length - 1] || consigneeTag).toLowerCase();
  if (!term) return consigneeTag;
  const entries = docSearchAddressBook(term);
  const match = entries.find(e => (e.aliases || []).join('/').toLowerCase() === consigneeTag.toLowerCase()) || entries[0];
  return match ? (match.raw || '') : consigneeTag;
}

function invCollectPayload() {
  const d = invw.data || {};
  const items = Array.from($('invwItems').querySelectorAll('.invw-item')).map(row => {
    const weight = parseFloat(row.querySelector('.invw-weight').value) || 0;
    const rate = parseFloat(row.querySelector('.invw-rate').value) || 0;
    const i = Number(row.dataset.i);
    const orig = (d.line_items || [])[i] || {};
    return {
      item_desc: row.querySelector('.invw-desc').value.trim(),
      container_no: row.querySelector('.invw-container').value.trim(),
      seal_no: row.querySelector('.invw-seal').value.trim(),
      weight, rate, amount: weight * rate,
      // Read back from the table now that the packing columns are visible
      // (2026-08-22). Previously these were carried through blind from the
      // server preview, which meant a wrong figure on the sheet could not be
      // corrected from the phone even though it prints on the invoice.
      //
      // Spread `orig.packing` FIRST so any key the server sends that this
      // table doesn't render survives — the six columns here are the ones the
      // dashboard shows, not necessarily every key invoiceSheet.js may add
      // later. Losing an unrendered field silently is exactly the class of
      // bug this whole change is fixing.
      //
      // net_weight_mt stays derived rather than typed: it must agree with the
      // Qty MT column, and two hand-editable fields that have to match is a
      // contradiction waiting to be printed.
      packing: {
        ...(orig.packing || {}),
        gross_weight_lbs: row.querySelector('.invw-p-gross').value.trim(),
        truck_lbs: row.querySelector('.invw-p-truck').value.trim(),
        container_tare_lbs: row.querySelector('.invw-p-tare').value.trim(),
        chassis_lbs: row.querySelector('.invw-p-chassis').value.trim(),
        boxes_weight_lbs: row.querySelector('.invw-p-boxes').value.trim(),
        net_weight_lbs: row.querySelector('.invw-p-net').value.trim(),
        // FROM THE NET POUNDS, not from the quantity box. When the invoice is
        // written in pounds the quantity IS the pounds, so reading it here
        // printed "Net Weight (MT) 49760.000" on a real reissued PDF. The net
        // is the one figure that means the same thing in either unit.
        net_weight_mt: (() => {
          const net = invwRowNetLbs(row);
          if (net != null && net > 0) return (net / INVW_LBS_PER_MT).toFixed(3);
          // No weights to derive from: only a quantity already in MT can
          // stand in for it. A pounds quantity has nothing to say here.
          return (invwUnits() === 'mt' && weight) ? weight.toFixed(3) : '';
        })(),
      },
    };
  }).filter(it => it.item_desc);

  const notes = Array.from($('invwNotes').querySelectorAll('.invw-note')).map(row => ({
    label: row.querySelector('.invw-note-label').value.trim(),
    amount: invwMoney(row.querySelector('.invw-note-amount').value) || 0,
  })).filter(n => n.label && n.amount !== 0);

  const subtotal = items.reduce((s, it) => s + it.amount, 0);
  const notesTotal = notes.reduce((s, n) => s + n.amount, 0);

  return {
    inv_no: $('invw_no').value.trim(),
    inv_date: toIsoDate($('invw_date').value) || $('invw_date').value.trim(),
    // Shipment fields aren't editable on the phone — they come from the
    // sheet and are carried straight through. Editing vessel/port/booking
    // is a desk correction, and dropping them would blank real fields on
    // the PDF.
    reference: d.reference || '',
    terms: d.terms || '',
    container_no: d.container_no || '',
    booking_no: d.booking_no || '',
    seal_no: d.seal_no || '',
    place_of_receipt: d.place_of_receipt || '',
    port_loading: d.port_loading || '',
    port_discharge: d.port_discharge || '',
    vessel: d.vessel || '',
    country_of_origin: d.country_of_origin || 'USA',
    consignee: d.consignee || '',
    consignee_address: $('invw_address').value.split('\n').map(l => l.trim()).filter(Boolean),
    proforma_date: d.proforma_date || '',
    // The unit BOTH money columns are in. The server heads the printed
    // Quantity and Rate columns from this, so an invoice generated on the
    // phone and the same one generated at the desk print identically.
    units: invwUnits(),
    notes,
    subtotal,
    final_amount: subtotal + notesTotal,
    line_items: items,
  };
}

