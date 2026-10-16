// mobile-app/www/app/08-load-modal.js — split from mobile-app/www/index.html's <script> (helpers/sourceParts.js reconstructs the original)
// ── Purchase vs sale ──────────────────────────────────────────────────────
// Apsara, 2026-08-24: "next to create invoice, i want another button as sales
// replicating the same template — only change is: i want buyer and buyer
// address instead of seller. on save, inventory to be updated. on deletion,
// inventory roll back."
//
// ONE modal, two modes. Deliberately not a second copy of the form: the item
// rows carry the scale scanner, per-item photos, the description type-ahead,
// last-price fill and the totals maths, and a duplicate would have started
// identical and drifted within a week — this file has already been through
// that with the two clients.
//
// What actually differs is small and lives in applyLoadModalMode(): which
// party is editable, what the fields are called, and where the save goes.
//
// Inventory movement needs no special handling either way. A purchase writes
// an inbound load and a sale writes an outbound one, and getInventoryReport
// nets the two by item type — so a sale reduces on-hand on save and deleting
// it puts the material back, with no rollback code anywhere. That is exactly
// why sales are stored as outbound loads rather than as negative purchases.
let loadModalMode = 'purchase'; // 'purchase' | 'sale'

function applyLoadModalMode(mode) {
  loadModalMode = mode === 'sale' ? 'sale' : 'purchase';
  const sale = loadModalMode === 'sale';
  // Both of these said 'Create invoice' on the purchase side until
  // 2026-10-15, when the button that opens this modal became "+ Load"
  // (Apsara: "create invoce rename to +load"). Landing on a form headed
  // 'Create invoice' after pressing '+ Load' reads like the wrong screen, and
  // nothing here creates an invoice. She was asked before these two moved.
  // THE SALE SIDE IS BYTE-FOR-BYTE UNCHANGED — she named the purchase label.
  const title = sale ? 'Record sale' : 'New load';
  const save = sale ? 'Record sale' : 'Save load';
  if ($('loadModalTitle')) $('loadModalTitle').textContent = editingLoadId ? (sale ? 'Edit sale' : 'Edit load') : title;
  if ($('btnSaveLoad')) $('btnSaveLoad').textContent = editingLoadId ? 'Save changes' : save;
  // The counterparty swaps sides: on a purchase Edge Trading is the buyer and
  // the seller is typed; on a sale Edge Trading is the seller and the buyer is
  // typed. Same two inputs, relabelled, so every downstream handler keeps
  // working on the same element ids.
  if ($('ld_party_label')) $('ld_party_label').textContent = sale ? 'Buyer' : 'Seller';
  if ($('ld_party_addr_label')) $('ld_party_addr_label').textContent = sale ? 'Buyer address' : 'Seller address';
  if ($('ld_seller')) $('ld_seller').placeholder = sale ? 'Buyer name' : 'Seller name';
  // Phone is a purchase-side convenience (the "send ticket to seller" button)
  // and has no meaning on a sale — hidden rather than left to collect a
  // number nothing will ever use.
  const phoneWrap = $('ld_seller_phone') && $('ld_seller_phone').closest('.field');
  if (phoneWrap) phoneWrap.style.display = sale ? 'none' : '';
  // Phone shares a row with the address now, and is hidden on a sale (it only
  // feeds the "send ticket to seller" button, meaningless outbound). Collapse
  // the row so the address takes the space instead of leaving a gap.
  const row2 = $('ld_party_row2');
  if (row2) row2.style.gridTemplateColumns = sale ? '1fr' : '';
  // Trucking is a PURCHASE deduction — what she pays the seller, less the
  // haulage she covered. There is no equivalent on a sale: a customer owes
  // the invoice, and quietly reducing it by what a hauler charged her would
  // be inventing a discount. Hidden rather than disabled so nothing about it
  // can reach a sale payload by accident. Mirrors dashboard/index.html.
  const truck = $('ld_trucking_section');
  if (truck) truck.style.display = sale ? 'none' : '';
}

// ── WHAT THIS DEDUCTION DOES TO THE PAYABLE, WHILE SHE TYPES ─────────────
// The arithmetic is trivial and that is exactly why it belongs on screen: the
// figure she cares about is not what she typed, it is what goes in the
// seller's hand, and asking her to do the subtraction at a gate with a queue
// behind her is how the wrong cash gets counted out.
function updateTruckingSummary() {
  const el = $('ld_trucking_summary');
  const badge = $('ld_trucking_badge');
  const amtEl = $('ld_trucking_amount');
  if (!el || !amtEl) return;
  const trucking = parseFloat(String(amtEl.value || '').replace(/[^0-9.\-]/g, ''));
  let amount = 0;
  document.querySelectorAll('#ld_items .item-row').forEach((row) => {
    const av = parseFloat(String(row.querySelector('.ld-item-amount')?.value || '').replace(/[^0-9.\-]/g, ''));
    if (isFinite(av)) amount += av;
  });
  if (!isFinite(trucking) || trucking <= 0) {
    el.textContent = '';
    if (badge) badge.textContent = '';
    return;
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  if (badge) badge.textContent = '− ' + fmtAmount(r2(trucking));
  el.textContent = `Amount ${fmtAmount(r2(amount))} − trucking ${fmtAmount(r2(trucking))} = ${fmtAmount(r2(amount - trucking))} payable to the seller`;
}

// Ticked when a hauling company is named, cleared when the name goes away —
// but ONLY while she has not touched the box herself. Once she has, her
// choice stands: a checkbox that keeps re-deciding after you have decided is
// worse than one that never helps at all.
function syncTruckerBillCheckbox() {
  const box = $('ld_trucking_bill');
  const co = $('ld_trucking_company');
  const amt = $('ld_trucking_amount');
  if (!box || !co || !amt) return;
  if (box.dataset.touched === '1') return;
  const trucking = parseFloat(String(amt.value || '').replace(/[^0-9.\-]/g, ''));
  box.checked = !!co.value.trim() && isFinite(trucking) && trucking > 0;
}

// ── WHAT HAPPENED TO THE TICKED BOX ─────────────────────────────────────
// Said out loud, because the alternative is a checkbox that sometimes works
// and never explains itself. Silent when she did not tick it.
function reportTruckerBill(tb) {
  if (!tb || tb.reason === 'not_requested') return;
  if (tb.created && tb.bill) {
    alert(`Trucker Bill ${tb.bill.id} created — ${tb.bill.company}, ${fmtAmount(tb.bill.amount)}, against load ${tb.bill.load_ticket}.\n\nIt is now a payable in Trucker Bills. Pay it from there.`);
    return;
  }
  if (tb.reason === 'already_exists') {
    alert(`Trucker Bill ${tb.bill_id} already exists against this load, for ${fmtAmount(tb.existing_amount)}.\n\nNothing was created — a second one would double what you owe the hauler. If the figure changed, edit ${tb.bill_id} in Trucker Bills.`);
    return;
  }
  if (tb.reason === 'no_trucking_company') {
    alert('No Trucker Bill was created — a bill needs the name of whoever hauled it.\n\nThe deduction is saved on the load either way. If you collected it with your own truck, leave the box clear: a bill would be a payable to nobody.');
    return;
  }
  if (tb.reason === 'no_trucking_amount') {
    alert('No Trucker Bill was created — there is no trucking amount on this load.');
    return;
  }
  if (tb.reason === 'error') {
    alert('The load saved, but the Trucker Bill could not be created: ' + (tb.message || 'unknown error') + '\n\nAdd it by hand in Trucker Bills.');
  }
}

function resetLoadModal(mode) {
  editingLoadId = null;
  // ── ONE-TIME SAVE TICKET ────────────────────────────────────────────────
  // Apsara, 2026-09-15, with a screenshot of two identical Darwin sales:
  // "I just added one.But two ones are created". Minted HERE, when the form
  // opens, and NOT at click time — a ticket created inside the click handler
  // would be a different ticket on a second send, which is exactly the case
  // it has to catch. The server spends it once (helpers/oncePerSave.js); a
  // second request carrying the same ticket gets the first record back and
  // writes nothing.
  //
  // crypto.randomUUID needs a secure context. It is there on https and on
  // localhost, and the app's WebView counts as one — but the fallback is
  // kept rather than assumed, because a client that silently sends no ticket
  // would look identical to one whose ticket works, right up until it
  // doesn't.
  saveTicket = (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'tk-' + Date.now() + '-' + Math.random().toString(36).slice(2, 11);
  currentLoadItems = [blankLoadItem()];
  ['ld_date', 'ld_seller', 'ld_seller_address', 'ld_seller_phone', 'ld_desc',
   'ld_trucking_company', 'ld_trucking_amount', 'ld_trucking_note'].forEach(id => { if ($(id)) $(id).value = ''; });
  // A fresh form is a fresh decision about the checkbox too — `touched`
  // surviving from the previous load is how the box stops auto-ticking for
  // the rest of the session after one manual change.
  if ($('ld_trucking_bill')) { $('ld_trucking_bill').checked = false; delete $('ld_trucking_bill').dataset.touched; }
  if ($('ld_trucking_details')) $('ld_trucking_details').open = false;
  updateTruckingSummary();
  editingLoadDescription = '';
  // Date defaults to TODAY instead of blank — per Apsara, having to pick it
  // manually on every single load was pure friction for what's almost
  // always "today." Still fully editable for a load being entered late.
  if ($('ld_date')) { $('ld_date').value = toUsDate(todayLocalDateStr()); wireUsDateField('ld_date'); }
  $('loadModalErr').textContent = '';
  applyLoadModalMode(mode);
  renderItemRows();
  // A new blank form is exactly where an unfinished one is worth offering.
  offerLoadDraft();
  setDraftStatus(editingLoadId ? 'none' : 'waiting');
  stopCamera();
  refreshAddressBookCache();
  refreshCustomItemTypes().then(renderItemRows);
}

// Opens the SAME modal used for creating a load, pre-filled from an existing
// record — per Apsara, there was no way to fix a typo or a wrong weight
// after saving short of deleting the whole load and starting over. Existing
// items' photo links are carried into currentLoadItems (not re-downloaded —
// just the link/id so a save that doesn't touch that item's photo keeps it,
// see computeItem in helpers/loads.js); grossPhoto/tarePhoto stay null
// unless the user actually re-captures that item's photo in this session.
function openEditLoadModal(load) {
  editingLoadId = load.id;
  const items = Array.isArray(load.items) && load.items.length ? load.items : [{}];
  currentLoadItems = items.map(it => ({
    description: it.description || '',
    gross_weight: it.gross_weight ?? '',
    // Blank tare renders as 0, per Apsara 2026-08-19 ("tare should be by
    // default 0"). New rows already defaulted to '0' via blankLoadItem,
    // but EDITING a load whose tare was stored null still showed an empty
    // box — so the default held for new loads and quietly didn't for
    // edits, which is the case she was hitting.
    tare_weight : (it.tare_weight ?? '') === '' ? '0' : it.tare_weight,
    price: fmtRate(it.price),
    unit : it.unit || '',
    grossPhoto: null, tarePhoto: null,
    gross_photo_link: it.gross_photo_link || null, gross_photo_drive_id: it.gross_photo_drive_id || null,
    tare_photo_link : it.tare_photo_link  || null, tare_photo_drive_id : it.tare_photo_drive_id  || null,
  }));
  if ($('ld_date'))            $('ld_date').value            = toUsDate(load.date) || '';
  // On a sale the deck already mapped buyer -> seller when tagging the record
  // (see renderCurrentMobileTab), so these two lines serve both modes without
  // a branch — the fields are the same inputs, only relabelled.
  if ($('ld_seller'))          $('ld_seller').value          = load.seller || '';
  if ($('ld_seller_address'))  $('ld_seller_address').value  = load.seller_address || '';
  if ($('ld_seller_phone'))    $('ld_seller_phone').value    = load.seller_phone || '';
  editingLoadDescription = load.description || '';
  if ($('ld_desc'))           $('ld_desc').value           = load.description || '';
  // ── TRUCKING ON AN EXISTING LOAD ────────────────────────────────────
  // Opened, not just filled. A deduction folded inside a collapsed section
  // is a deduction she will not see while checking the numbers, and this
  // form's whole job at this moment is letting her check the numbers.
  if ($('ld_trucking_company')) $('ld_trucking_company').value = load.trucking_company || '';
  if ($('ld_trucking_amount'))  $('ld_trucking_amount').value  = load.trucking_amount != null ? fmtAmount(load.trucking_amount) : '';
  if ($('ld_trucking_note'))    $('ld_trucking_note').value    = load.trucking_note || '';
  if ($('ld_trucking_details')) $('ld_trucking_details').open  = !!load.trucking_amount;
  // NOT auto-ticked on an edit, and marked touched so nothing ticks it
  // later either. The bill for this load, if there is one, was already
  // offered when it was created; re-offering it on every subsequent edit is
  // how a second payable gets written for one haul.
  if ($('ld_trucking_bill')) { $('ld_trucking_bill').checked = false; $('ld_trucking_bill').dataset.touched = '1'; }
  updateTruckingSummary();
  $('loadModalErr').textContent = '';
  // Mode-aware: the edit handler calls applyLoadModalMode BEFORE this, but
  // that runs while editingLoadId is still null, so the title it computes is
  // the create-mode one. Setting it here, after editingLoadId is assigned, is
  // what makes an edited sale say "Edit sale" instead of "Edit load".
  if ($('loadModalTitle')) $('loadModalTitle').textContent = `${loadModalMode === 'sale' ? 'Edit sale' : 'Edit load'} — ${load.id}`;
  if ($('btnSaveLoad')) $('btnSaveLoad').textContent = 'Save changes';
  renderItemRows();
  stopCamera();
  refreshAddressBookCache();
  refreshCustomItemTypes().then(renderItemRows);
  $('loadModal').classList.remove('hidden');
}

// Deck-of-cards visual: a responsive grid of card tiles, each with a subtle
// depth cue (layered shadow) rather than a plain stacked list.
function loadCardHtml(l) {
  return `
    <div class="card load-card" data-id="${esc(l.id)}">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px;">
        <div>
          <div style="font-size:14px; font-weight:700; color:var(--text-strong);">${esc(l.seller || 'Unnamed seller')}</div>
          <div style="font-family:var(--font-mono); font-size:11px; color:var(--text-muted); margin-top:2px;">${esc(l.date || '—')} · ${esc(l.id)}</div>
        </div>
        ${l._kind === 'sale'
          ? `<span class="badge" style="background:var(--status-warning, #d69e2e); color:#fff; white-space:nowrap;">SALE</span>`
          : `<span class="badge" style="background:${l.status === 'pdf_generated' ? 'var(--accent)' : 'var(--steel-100)'}; color:${l.status === 'pdf_generated' ? '#fff' : 'var(--steel-700)'}; white-space:nowrap;">${l.status === 'pdf_generated' ? 'PDF ready' : 'Open'}</span>`}
      </div>
      ${(l.warnings && l.warnings.length) ? `
      <!-- Warning banner — per Apsara 2026-08-20. Photo/PDF/Drive failures
           used to be logged server-side and swallowed: the load saved, the
           app said success, and a missing scale photo was discovered days
           later. Now the load carries the warning and wears it here, where
           the operator sees it while they can still retake the photo.
           Shows the operator-facing message, never the raw exception. -->
      <div style="margin-top:10px; padding:9px 11px; border-radius:var(--radius-xs); background:rgba(217,154,43,.12); border:1px solid var(--status-warning); color:var(--status-warning); font-size:11.5px; line-height:1.45;">
        ${l.warnings.map(w => `<div>⚠ ${esc(w.message || w.code)}</div>`).join('')}
      </div>` : ''}
      ${l.description ? `<div style="margin-top:10px; font-size:12px; color:var(--text-body);">${esc(l.description)}</div>` : ''}
      <div style="font-family:var(--font-mono); font-size:10.5px; color:var(--text-faint); margin-top:10px;">${(l.items || []).length} item${(l.items || []).length === 1 ? '' : 's'}</div>
      <!-- Gross/tare/net are now per item (see item table in the modal / PDF)
           — these are sums across all items, computed server-side in
           helpers/loads.js, not a single load-level weight anymore. Stacked
           vertically (was a flex-wrap row) — on a narrower card the row wrapped
           mid-line so "Total net" ended up crammed against "Total tare" on
           the right instead of reading top-to-bottom; per Apsara, each on
           its own line, no wrapping to fight. -->
      <div style="display:flex; flex-direction:column; gap:3px; margin-top:8px; font-family:var(--font-mono); font-size:12px; color:var(--text-body);">
        <span>Gross weight: ${l.gross_weight ?? '—'} ${esc(l.weight_unit || '')}</span>
        <span>Tare weight: ${l.tare_weight ?? '—'} ${esc(l.weight_unit || '')}</span>
        <span style="font-weight:700; color:var(--text-strong);">Net weight: ${l.net_weight ?? '—'} ${esc(l.weight_unit || '')}</span>
        <!-- Amount — per Apsara 2026-09-01 ("add invoice amount in grid box
             in addition to gross,tare,net"). Same server-computed total the
             ticket and the Pay sheet use (l.amount, summed from priced items
             in helpers/loads.js), formatted by the shared fmtAmount so it
             carries the $ and two decimals like everywhere else.
             An em-dash when there is no total, NOT $0.00: a load whose items
             have no price yet is worth "not priced", and printing $0.00
             would read as "worth nothing", which is a different claim. -->
        <span style="font-weight:700; color:var(--text-strong);">Amount: ${l.amount != null && fmtAmount(l.amount) ? esc(fmtAmount(l.amount)) : '—'}</span>
        <!-- The deduction, and only when there is one. Every card in the deck
             is otherwise exactly the card it was — a "Trucking —" line on
             hundreds of tiles would be noise on the screen she scans most.
             Mirrors dashboard/index.html. -->
        ${Number(l.trucking_amount) > 0 ? `
        <span style="font-size:11px; color:var(--text-muted);">Less trucking: ${esc(fmtAmount(l.trucking_amount))}${l.trucking_company ? ' · ' + esc(l.trucking_company) : ''}</span>
        <span style="font-weight:700; color:var(--text-strong);">Payable: ${l.net_payable != null && fmtAmount(l.net_payable) ? esc(fmtAmount(l.net_payable)) : '—'}</span>` : ''}
      </div>
      ${paymentBadgeHtml(l)}
      <div style="margin-top:12px; display:flex; flex-direction:column; align-items:flex-start; gap:6px;">
        ${l.pdf_link ? `<a href="${esc(l.pdf_link)}" target="_blank" rel="noopener" style="font-size:12px;">View PDF →</a>` : ''}
        ${l.weights_pdf_link ? `<a href="${esc(l.weights_pdf_link)}" target="_blank" rel="noopener" style="font-size:12px;">View weights PDF →</a>` : ''}
        <!-- POS receipt PDF (80mm width) — per Apsara 2026-08-17 ("I want
             print option once pdf generated... pos dimension for
             printing"). Same <a target="_blank"> pattern as View PDF/View
             weights PDF above (not a JS window.open() button) — that
             pattern already works in this WebView; window.open() from a
             click handler does not (see the Send-to-seller fix). Opening
             the PDF hands off to whatever app/viewer the phone has for
             PDFs, which is where the actual "Print" action lives (Android's
             system print dialog lists any installed POS printer service
             from there) — there's no way to skip straight to a specific
             printer without a dedicated printer SDK, which wasn't asked
             for here. -->
        ${l.receipt_pdf_link ? `<a href="${esc(l.receipt_pdf_link)}" target="_blank" rel="noopener" style="font-size:12px;">Print (POS receipt) →</a>` : ''}
        <!-- Ticket actions are purchase-only: a sale has no yard ticket to
             generate, no seller to send one to and nothing to sign. Hidden
             rather than shown-and-failing. -->
        <!-- Sales get a ticket too — Apsara 2026-08-24 ("what if i want to
             have ticket actions"). data-kind tells the handler which route to
             call; the document itself says "SALE TICKET / Buyer:" and carries
             no signature line, per "no sign needed". -->
        ${!l.pdf_link
          ? `<button class="btn btn-primary btn-gen-pdf" data-id="${esc(l.id)}" data-kind="${esc(l._kind || 'purchase')}" style="font-size:12px; padding:6px 12px;">Generate PDF</button>`
          : `<button class="btn btn-gen-pdf" data-id="${esc(l.id)}" data-kind="${esc(l._kind || 'purchase')}" style="font-size:11px; padding:5px 10px;">Regenerate PDF</button>`}
        <!-- No stale-ticket warning here, deliberately. It was built and then
             removed the same day per Apsara 2026-08-20 ("don't do that. user
             will get irritated"), and she's right: on first deploy EVERY
             existing ticket would wear it, and a badge that fires on
             everything is one people learn to ignore — which would also
             blunt the photo/PDF failure warnings that genuinely need
             attention.
             The server still stamps pdf_template_version and still returns
             pdf_stale (see GET /api/loads) — it costs nothing, and it's
             useful for answering "was this ticket built before or after that
             change" when diagnosing. It just doesn't nag the operator. -->
        <!-- Send to seller — only once a PDF exists (nothing to forward
             before that). Shown even without a phone on file so the
             button's own click handler can surface that as a clear error
             rather than the option just silently not being there — per
             Apsara 2026-08-17 ("introduce send option once pdf
             generated..."). -->
        ${l.pdf_link && l._kind !== 'sale' ? `<button class="btn btn-send-seller" data-id="${esc(l.id)}" style="font-size:12px; padding:6px 12px;">Send to seller (WhatsApp)</button>` : ''}
        <!-- Sign — per Apsara 2026-08-17, offered once the PDF exists
             ("post pdf generation, there should be an option called
             sign"). Saving a signature regenerates the ticket + receipt
             so it appears above the "Seller signature" line on both.
             Label reflects current state so it's obvious at a glance
             whether this load has been signed.
             Per Apsara 2026-09-02 the RE-sign half goes away once money is
             booked — see loadIsResignable. A signed+paid load shows a plain
             "✓ Signed" chip instead, so the state is still legible; it just
             is not a button any more. -->
        ${l.pdf_link && l._kind !== 'sale' ? (
          loadIsSignable(l)
            ? `<button class="btn btn-sign-load" data-id="${esc(l.id)}" style="font-size:12px; padding:6px 12px;">${loadIsSigned(l) ? '✓ Signed — re-sign' : 'Sign'}</button>`
            : `<span class="badge" title="Signed, and locked because a payment has been recorded against this load" style="font-size:12px; padding:6px 12px; background:var(--steel-100); color:var(--steel-700);">✓ Signed</span>`
        ) : ''}
      </div>
      <div style="margin-top:10px; display:flex; gap:8px; border-top:1px solid var(--border-subtle); padding-top:10px;">
        <button class="btn btn-edit-load" data-id="${esc(l.id)}" style="font-size:11px; padding:5px 10px;">Edit</button>
        <!-- Renumber button REMOVED 2026-08-17 per Apsara ("remove the
             renumber button in app for both staff and admin access",
             confirmed "remove it everywhere, no exceptions"). Earlier
             the same day it had been narrowed to admin-only; now it's
             gone from this app for every role, along with the
             Renumber-a-load section that was in the Admin settings
             modal. PUT /api/loads/:id/renumber still exists server-side
             (still requireAdmin-gated) — deliberately left there rather
             than deleted, since removing a route is a breaking API
             change and nothing in this app calls it anymore anyway. -->
        ${loadIsDeletable(l) ? `<button class="btn btn-danger btn-delete-load" data-id="${esc(l.id)}" style="font-size:11px; padding:5px 10px;">Delete</button>` : ''}
        <!-- Pay, mirroring the website (2026-08-28). Sits with Edit/Delete
             because it is something done TO an existing load. Disappears once
             there is nothing left to pay — see loadIsPayable. -->
        ${loadIsPayable(l) ? `<button class="btn btn-pay-load" data-id="${esc(l.id)}" data-kind="${esc(l._kind || 'purchase')}" style="font-size:11px; padding:5px 10px;">${l._kind === 'sale' ? 'Receive payment' : 'Pay'}</button>` : ''}
      </div>
    </div>`;
}

// Groups loads by their `date` field (the date picked in the modal, not
// created_at — a load entered today can still be dated yesterday's yard
// activity) and sorts groups newest-first, undated loads last. Each group
// becomes its own labeled section in the deck instead of one flat grid, per
// Apsara — makes a specific day's loads findable without scanning the whole
// deck once there are more than a screenful.
function groupLoadsByDate(loads) {
  const groups = new Map();
  for (const l of loads) {
    const key = l.date || 'undated';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l);
  }
  const keys = Array.from(groups.keys()).sort((a, b) => {
    if (a === 'undated') return 1;
    if (b === 'undated') return -1;
    return b.localeCompare(a); // ISO yyyy-mm-dd sorts correctly as a string, newest first
  });
  return keys.map(key => ({ key, label: formatLoadDateHeading(key), loads: groups.get(key) }));
}

function formatLoadDateHeading(key) {
  if (key === 'undated') return 'No date set';
  const d = new Date(key + 'T00:00:00');
  if (isNaN(d.getTime())) return key;
  return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

// Free-text filter across the fields Apsara actually asked for ("it can be
// anything like date and seller/amount") — one search box rather than
// several per-field dropdowns, matched as a substring against a flattened
// string of id/date/seller/description/weights/amount. Client-side against
// loadsCache (already fetched for the deck) rather than a server round trip
// per keystroke — the loads list is small enough that this is instant.
// The item picked from the "by item detail" list, or '' for none. Module
// scope so it survives a repaint of the Loads tab — losing it after
// generating a PDF would silently show every load again, which reads exactly
// like the filter not working.
let chosenItemDetail = '';

// Every distinct item description in the deck, for the type-ahead. Built from
// the loads ON SCREEN, not the /api/item-types catalogue: the catalogue lists
// everything ever typed, and offering a material with no loads behind it is an
// option that can only ever answer "nothing found" — the exact ambiguity this
// control exists to remove.
function itemDetailsInLoads(loads) {
  const seen = new Map();
  for (const l of (loads || [])) {
    for (const it of (Array.isArray(l.items) ? l.items : [])) {
      const raw = String(it.description || '').trim();
      if (!raw) continue;
      const k = raw.toLowerCase();
      if (!seen.has(k)) seen.set(k, raw);
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
}

// Loads carrying a given item. EXACT match on the description, trimmed and
// case-insensitive — the same comparison groupItemsByDescription and the
// Inventory drill-down use. It has to be the same, or a load could appear
// under a material heading it does not belong to.
function loadsWithItem(loads, description) {
  const want = String(description || '').trim().toLowerCase();
  if (!want) return loads;
  return (loads || []).filter(l => (Array.isArray(l.items) ? l.items : [])
    .some(it => String(it.description || 'Other').trim().toLowerCase() === want));
}

