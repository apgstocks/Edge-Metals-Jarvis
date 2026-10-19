// mobile-app/www/app/05-payment-roles.js — split from mobile-app/www/index.html's <script> (helpers/sourceParts.js reconstructs the original)
// ── PREPAID CREDIT IN THE PAY MODAL ────────────────────────────────────────
// Twin of dashboard/index.html's. Kept byte-similar on purpose: the two
// clients drifting on a money screen is what tests/form-parity.js exists to
// catch, and the field that goes missing in a divergence is always the one
// nobody looks at.
let payPrepayCredit = null;

async function refreshPrepayCredit() {
  const box = $('payPrepayBox');
  const creditRow = $('payPrepayAsCreditRow');
  if (!box || !creditRow) return;
  const sale = payingLoad && payingLoad.kind === 'sale';
  const seller = (payingLoad && payingLoad.seller) || '';
  if (sale || !seller) {
    box.classList.add('hidden');
    creditRow.classList.add('hidden');
    return;
  }
  creditRow.classList.remove('hidden');
  const lbl = $('payAsPrepaymentLabel');
  if (lbl) lbl.textContent = `Hold as prepayment — credit ${seller}, not this load`;
  try {
    const c = await api('/api/prepayments/credit?seller=' + encodeURIComponent(seller));
    const avail = Number(c && c.available) || 0;
    // She may have closed this and opened another row while the request was
    // in flight; writing that row's figures here is a wrong number next to a
    // Pay button.
    if (!payingLoad || payingLoad.seller !== seller) return;
    if (avail <= 0) { box.classList.add('hidden'); return; }
    payPrepayCredit = c;
    const pending = Number((payingLoad.payment || {}).pending);
    const offer = isFinite(pending) && pending > 0 ? Math.min(avail, pending) : avail;
    $('payPrepayHeld').innerHTML =
      `<strong>${esc(seller)}</strong> is holding ${payMoney(avail)} in prepayments.`;
    $('pay_prepay_amount').value = offer ? offer.toFixed(2) : '';
    $('payPrepayNote').textContent = isFinite(pending) && pending > 0 && avail > pending
      ? `this load only owes ${payMoney(pending)}`
      : '';
    $('payPrepayApplyRow').classList.remove('hidden');
    box.classList.remove('hidden');
  } catch (e) {
    console.error('[prepay] could not read supplier credit:', e.message);
    box.classList.add('hidden');
  }
}


function closePayModal() { $('payModal').classList.add('hidden'); payingLoad = null; }

// Says what this payment leaves outstanding, before it is recorded — the
// pending figure is the point of the feature, so it belongs where the decision
// is made rather than only afterwards.
function updatePayPreview() {
  const el = $('payPreview');
  if (!el || !payingLoad) return;
  const amt = parseFloat($('pay_amount').value);
  if (!isFinite(amt) || amt <= 0) { el.innerHTML = ''; return; }
  if (payingLoad.amount == null) {
    el.innerHTML = `<span style="color:var(--text-muted);">Will record ${payMoney(amt)}. No load total, so no balance can be shown.</span>`;
    return;
  }
  const alreadyPaid = (payingLoad.payment && payingLoad.payment.paid) || 0;
  const after = Math.round((payingLoad.amount - alreadyPaid - amt) * 100) / 100;
  if (Math.abs(after) < 0.005) {
    el.innerHTML = `<span style="color:var(--status-good, #4ade80);">This settles the load in full.</span>`;
  } else if (after > 0) {
    el.innerHTML = `<span style="color:var(--status-warning, #d99a2b);">PARTIAL — ${payMoney(after)} will still be pending.</span>`;
  } else {
    el.innerHTML = `<span style="color:#d95a2b;">This is ${payMoney(-after)} MORE than the load total.</span>`;
  }
}

// ── WHO MAY REMOVE A PAYMENT ────────────────────────────────────────────
// Apsara, 2026-09-16: "in receive payment-what if i mistakenly added
// something-->give delete partial payment to admin..all types to jarvis
// profile" — and, asked what "partial" meant, she chose "one payment out of
// several". So an admin may take any single payment row back off a yard
// load, which is the everyday "I typed the wrong figure" correction. The
// load simply goes back to owing that money.
//
// This ✕ used to be shown to EVERYONE who could open the box, and
// DELETE /api/payments/:id had no gate at all — staff were stopped only
// because the whole path is off their allowlist, which left the plain 'user'
// role able to delete a payment from either client. The route is now
// requireAdmin; this hides a button the server would refuse.
//
// UI GUARD, NOT SECURITY — the same rule as loadIsDeletable below. Hiding a
// button prevents a mistake; the route is what prevents an attack.
function payCanDelete() {
  return ROLE === 'admin';
}

function renderPayHistory() {
  const el = $('payHistory');
  if (!el || !payingLoad) return;
  const rows = (payingLoad.payment && payingLoad.payment.payments) || [];
  if (!rows.length) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div style="font-family:var(--font-mono); font-size:10px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--text-muted); margin-bottom:8px;">Already recorded</div>
    ${rows.map(r => `
      <div style="display:flex; align-items:center; gap:10px; padding:7px 0; border-top:1px solid var(--border-subtle); font-family:var(--font-mono); font-size:12px;">
        <span style="color:var(--text-muted);">${esc(r.paid_on || '')}</span>
        <span>${esc(r.mode)}${r.bank ? ' · ' + esc(r.bank) : ''}</span>
        ${r.reference ? `<span style="color:var(--text-faint);">${esc(r.reference)}</span>` : ''}
        <span style="flex:1;"></span>
        <span style="font-weight:700;">${payMoney(r.amount)}</span>
        ${payCanDelete() ? `<button class="btn btn-danger btn-del-pay" data-id="${esc(r.id)}" data-mode="${esc(r.mode || '')}" data-amount="${esc(payMoney(r.amount))}" style="font-size:10px; padding:3px 8px;">✕</button>` : ''}
      </div>`).join('')}`;
}

function renderItemRows() {
  const box = $('ld_items');
  if (!box) return;
  // NOTE: the row wrapper uses class="item-row" (NOT a data-row attribute) —
  // the remove button below it also needs data-row to know its own index,
  // and querying by attribute would match BOTH the row and the button (a
  // real bug that shipped: syncItemsFromDom() below was matching the button
  // too, calling .querySelector('.ld-item-desc') on it, getting null, and
  // throwing — which is why Add Item/Save Load looked completely broken).
  const rowsHtml = currentLoadItems.map((it, i) => {
    const desc = it.description || '';
    const g = parseFloat(it.gross_weight), t = parseFloat(it.tare_weight);
    const net = (isFinite(g) && isFinite(t)) ? Math.round((g - t) * 100) / 100 : null;
    const price = parseFloat(it.price);
    // ── THE UNIT, ON FIRST PAINT TOO ────────────────────────────────────
    // Same fix as dashboard/index.html, same day, and the comment there has
    // the full story. Short version: this line was `net * price` with no
    // unit in it, so reopening a /MT row showed the POUND figure — 46,560 lb
    // at 330 /MT reading $15,364,800 — while recomputeRowTotals(), which
    // runs the moment anything is touched, was always right. Correct on
    // save, wrong on open.
    //
    // Ported here in the SAME commit rather than left for the next APK.
    // These two screens are the same form and the phone is where loads are
    // actually entered, standing at the scale; a fix that lands on the
    // website first means the wrong figure is on the device being used.
    // THIS is the line that produced $15m on 2026-10-09 — it had no unit in
    // it at all while the typing path above was unit-aware, so reopening a
    // priced row showed the pound figure. Same function as the typing path
    // now, which is the only way the two cannot disagree again.
    const qtyRow = qtyForUnit(it.unit, net, it.pieces);
    const amount = (qtyRow != null && isFinite(price)) ? Math.round(qtyRow * price * 100) / 100 : null;
    // One flat row of columns (see .item-row grid below) instead of the old
    // 3-stacked-boxes layout — per Apsara, wanted item detail condensed to a
    // single line per item. Per-field <label>s are gone in favor of one
    // shared column header above the list (rendered once, not per row); the
    // "Others" free-text box is the one thing still allowed to add a second
    // line, only when that description is actually picked.
    return `
    <div class="item-row" data-idx="${i}">
      <div class="ld-item-desc-wrap">
        <span class="ld-mobile-label">Description</span>
        <!-- Free-text type-ahead, not a <select>, since 2026-08-20 (Apsara:
             "make it as empty field, so that when user start typing
             something, start matching and show all matches. If they type
             something which is not in list, add that to list"). The old
             control was a dropdown of presets plus an "Others…" option that
             revealed a second text box on a second line — two controls and
             two taps for anything not already on the list. This is one box:
             known types autocomplete, unknown types are simply typed, and
             the save handler adds whatever was new to the catalog.
             Own relatively-positioned wrapper because .ld-item-desc-wrap is
             forced position:static in the phone grid below. -->
        <div class="ld-desc-ac-wrap">
          <input class="ld-item-desc-input" placeholder="Type description…" autocomplete="off" value="${esc(desc)}" data-prev="${esc(desc)}">
          <div class="ac-dropdown ld-desc-ac hidden"></div>
        </div>
      </div>
      <div class="ld-item-cap ld-item-cap-gross">
        <span class="ld-mobile-label">Gross</span>
        <div class="ld-item-cap-inputs"><input class="ld-item-gross" type="number" step="any" placeholder="0" value="${it.gross_weight ?? ''}"><button type="button" class="btn btn-photo-item" data-role="gross" title="${it.gross_photo_link ? 'Photo on file — click to replace' : 'Add gross weight photo'}">📷${it.gross_photo_link ? '✓' : ''}</button></div>
      </div>
      <div class="ld-item-cap ld-item-cap-tare">
        <span class="ld-mobile-label">Tare</span>
        <div class="ld-item-cap-inputs"><input class="ld-item-tare" type="number" step="any" placeholder="0" value="${it.tare_weight ?? ''}"><button type="button" class="btn btn-photo-item" data-role="tare" title="${it.tare_photo_link ? 'Photo on file — click to replace' : 'Add tare weight photo'}">📷${it.tare_photo_link ? '✓' : ''}</button></div>
      </div>
      <div class="ld-item-net-wrap"><span class="ld-mobile-label">Net</span><input class="ld-item-net" type="number" step="any" disabled title="Net weight" value="${net != null ? net : ''}"></div>
      <!-- Price, and the unit that price is PER. Apsara 2026-09-24: "in edge
           yard load app, it should have a provision to calculate amount by
           using MT or lbs rowise. By default lbs should be enabled" — so the
           select sits inside the price cell rather than taking a column of
           its own, because a rate and its unit are one fact and splitting
           them across the row would let someone read the wrong pair. It also
           means the phone grid (net|price) is untouched: this form gets used
           standing at a scale and its layout is not something to disturb for
           a feature that is only occasionally needed.
           DEFAULT IS lb. An item already on file with no unit — which is
           every load saved before today — renders as lb and computes exactly
           as it always did. -->
      <div class="ld-item-price-wrap"><span class="ld-mobile-label">Price</span>
        <div class="ld-item-price-inputs">
          <input class="ld-item-price" type="number" step="any" placeholder="0" title="Price" value="${it.price ?? ''}">
          <select class="ld-item-unit" title="What is this price per?">
            ${['lb', 'nt', 'gt', 'mt', 'piece'].map((u) => `<option value="${u}"${(unitOf(it.unit) || 'lb') === u ? ' selected' : ''}>${UNIT_LABEL[u]}</option>`).join('')}
          </select>
        </div>
      </div>
      <!-- ── PIECES, AND ONLY FOR A /piece ROW ────────────────────────────
           Apsara, 2026-10-10, asked for /piece alongside the weights. It is
           the one option that is not a divisor: every other unit divides the
           net weight, and a piece price has nothing to divide, so it needs a
           count. There was no such field on a load item until today.
           Hidden unless the unit is /piece, because an always-visible empty
           box on a form used standing at a scale is one more thing to
           mis-read. Gross, tare and net stay exactly where they are — the
           truck is still weighed and the ticket she prints still carries
           that weight; only what the price multiplies changes. -->
      <div class="ld-item-pieces-wrap" style="display:${unitOf(it.unit) === 'piece' ? '' : 'none'}">
        <span class="ld-mobile-label">Pieces</span>
        <input class="ld-item-pieces" type="number" step="1" min="0" placeholder="0"
               title="How many pieces" value="${it.pieces ?? ''}">
      </div>
      <div class="ld-item-amount-wrap"><span class="ld-mobile-label">Amount</span><input class="ld-item-amount" type="text" inputmode="decimal" disabled title="Amount" value="${amount != null ? fmtAmount(amount) : ''}"></div>
      <div class="ld-item-actions">
        <button type="button" class="btn btn-insert-item" data-row="${i}" title="Insert a blank item below">+</button>
        <!-- Duplicate, per Apsara 2026-09-02. Distinct from "+": that adds an
             EMPTY row, this copies this one. Several lines of the same
             material at the same price is the common case on a big load, and
             retyping the description and rate for each was the tedious part. -->
        <button type="button" class="btn btn-dup-item" data-row="${i}" title="Duplicate this item below">⧉</button>
        <button type="button" class="btn btn-danger btn-remove-item" data-row="${i}" title="Remove item">✕</button>
      </div>
      <!-- Two file inputs per role (camera-forced vs library/files) instead
           of one plain accept="image/*" input — per Apsara, the single
           generic input's OS chooser was surfacing Google Photos ahead of
           a direct camera option. Clicking the 📷 button now shows an
           explicit "Take Photo" / "Choose File" menu (see
           showCaptureMenu below) that triggers whichever of these two
           actually matches what was picked. capture="environment" is what
           forces a mobile browser straight into the camera app instead of
           any chooser at all. -->
      <input type="file" accept="image/*" capture="environment" class="ld-item-gross-file-camera hidden">
      <input type="file" accept="image/*" class="ld-item-gross-file-files hidden">
      <input type="file" accept="image/*" capture="environment" class="ld-item-tare-file-camera hidden">
      <input type="file" accept="image/*" class="ld-item-tare-file-files hidden">
      <div class="ld-item-status ld-cap-status"></div>
    </div>`;
  }).join('');
  box.innerHTML = `
    <div class="ld-item-header">
      <span>Description</span><span>Gross</span><span>Tare</span><span>Net</span><span>Price</span><span>Amount</span><span></span>
    </div>
    ${rowsHtml}
    <!-- Running totals, mirroring the website. Rendered here rather than as a
         fake item row so syncItemsFromDom() can never pick it up as a
         phantom item. -->
    <div class="ld-item-totals" id="ld_item_totals"></div>`;
  updateItemTotals();

  box.querySelectorAll('.item-row').forEach(row => {
    row.querySelectorAll('input:not([type=file])').forEach(inp => inp.addEventListener('input', () => {
      recomputeRowTotals(row);
      syncItemsFromDom();
    }));
    // The lb/MT select needs its own line: the selector above is `input`, and
    // a <select> is not one. Without this the amount would sit at the old
    // unit's figure until the next keystroke anywhere in the row — a wrong
    // number on screen that looks settled, which is the worst kind.
    row.querySelectorAll('select.ld-item-unit').forEach(sel => sel.addEventListener('change', () => {
      recomputeRowTotals(row);
      syncItemsFromDom();
    }));
    // Photo button now opens a small "Take Photo / Choose File" menu instead
    // of clicking straight into one generic file input — see showCaptureMenu.
    row.querySelectorAll('.btn-photo-item').forEach(btn => btn.addEventListener('click', () => {
      const role = btn.dataset.role; // 'gross' | 'tare'
      showCaptureMenu(btn, {
        // "Scan weight" is the primary path as of 2026-08-17 (Apsara: no
        // normal camera, a bounding box the user aligns the display in).
        // Falls back to the previous native-camera path if this device or
        // WebView won't hand over a live camera stream — better than a
        // dead button on a device that can't do getUserMedia.
        onCamera: async () => {
          const opened = await openScanner(row, role);
          if (opened) return;
          if (hasNativeCamera()) return captureViaNativeCamera(row, role);
          row.querySelector(`.ld-item-${role}-file-camera`).click();
        },
        onFiles : () => row.querySelector(`.ld-item-${role}-file-files`).click(),
      });
    }));
    row.querySelector('.ld-item-gross-file-camera').addEventListener('change', (e) => handleFileUpload(row, 'gross', e.target.files[0]));
    row.querySelector('.ld-item-gross-file-files').addEventListener('change', (e) => handleFileUpload(row, 'gross', e.target.files[0]));
    row.querySelector('.ld-item-tare-file-camera').addEventListener('change', (e) => handleFileUpload(row, 'tare', e.target.files[0]));
    row.querySelector('.ld-item-tare-file-files').addEventListener('change', (e) => handleFileUpload(row, 'tare', e.target.files[0]));
  });
  // ── Description type-ahead (2026-08-20) ─────────────────────────────────
  // Replaces the preset <select> + "Others…" pair. Starts empty, matches as
  // you type, and accepts anything — see the markup comment above.
  box.querySelectorAll('.ld-item-desc-input').forEach(input => {
    const row  = input.closest('.item-row');
    const menu = row.querySelector('.ld-desc-ac');
    const close = () => menu.classList.add('hidden');

    // Price follows the description, but ONLY when the description actually
    // changed — hence data-prev. The old select fired on 'change', which by
    // definition meant a different value; a text box fires on blur every
    // time it's tapped, and re-running the price fill on an unchanged
    // description would wipe a rate the operator had just typed by hand for
    // an item with no history. Apsara 2026-08-19: "just take the last
    // price" — on a REAL change, last price wins outright (a new
    // description means a different item, so the old rate is meaningless);
    // with no history the box clears rather than keeping a stale figure.
    const applyPriceIfChanged = () => {
      const now = input.value.trim();
      if (now.toLowerCase() === (input.dataset.prev || '').trim().toLowerCase()) return;
      input.dataset.prev = now;
      const priceInput = row.querySelector('.ld-item-price');
      if (!priceInput) return;
      const last = now ? lastPriceForDescription(now) : null;
      priceInput.value = last ? fmtRate(last.price) : '';
      // THE UNIT TRAVELS WITH THE PRICE, or this recall becomes a trap.
      // Rows are priced per lb or per MT since 2026-09-24. If the last
      // Copper row was $800/MT and this one is left on the lb default, an
      // $800 PER POUND rate lands in the box without anyone typing it — on
      // a 30,000 lb row that is a twenty-four-million-dollar load and a
      // signed ticket to match. Recalling one half of a pair is worse than
      // recalling neither.
      // unitOf() rather than last.unit raw: a stored unit the picker has no
      // option for would set <select>.value to a value not in its list,
      // which silently becomes '' — the exact failure that made a pay modal
      // post an empty mode in September. unitOf returns null for anything
      // unrecognised and this falls back to lb rather than to blank.
      const unitSel = row.querySelector('.ld-item-unit');
      if (unitSel) unitSel.value = (last && unitOf(last.unit)) || 'lb';
      // And the COUNT travels with them for a /piece row, for the same
      // reason the unit does: half a recalled pair is worse than none.
      const pcs = row.querySelector('.ld-item-pieces');
      if (pcs && last && unitOf(last.unit) === 'piece') pcs.value = last.pieces ?? '';
      recomputeRowTotals(row);
    };

    const openMatches = () => {
      const q = input.value.trim().toLowerCase();
      // Empty box shows the WHOLE catalog rather than nothing — the field is
      // empty by default now, so a blank dropdown on first tap would leave
      // someone who doesn't remember the exact wording with no way in.
      const all = itemDescSuggestions();
      const matches = q ? all.filter(o => String(o).toLowerCase().includes(q)) : all;
      // An exact, complete match is not worth a dropdown showing only the
      // thing already typed — it just covers the fields below it.
      if (!matches.length || (matches.length === 1 && String(matches[0]).toLowerCase() === q)) return close();
      menu.innerHTML = matches.map(o => `<div class="ac-item" data-val="${esc(o)}">${esc(o)}</div>`).join('');
      menu.classList.remove('hidden');
      menu.querySelectorAll('.ac-item').forEach(el => el.addEventListener('mousedown', (ev) => {
        // mousedown, not click: blur fires first on a click and would close
        // the menu before the click ever landed. preventDefault keeps focus
        // in the input so the pick doesn't also trigger the blur handler.
        ev.preventDefault();
        input.value = el.dataset.val;
        blurPicked(input);
        close();
        applyPriceIfChanged();
        syncItemsFromDom();
      }));
    };

    input.addEventListener('focus', openMatches);
    input.addEventListener('input', openMatches);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { close(); return; }
      // Enter accepts the only remaining match — the common case after
      // typing three letters — instead of submitting anything.
      if (ev.key === 'Enter') {
        ev.preventDefault();
        const only = menu.querySelectorAll('.ac-item');
        if (!menu.classList.contains('hidden') && only.length === 1) input.value = only[0].dataset.val;
        close();
        applyPriceIfChanged();
        syncItemsFromDom();
      }
    });
    input.addEventListener('blur', () => {
      setTimeout(close, 150);
      applyPriceIfChanged();
      syncItemsFromDom();
    });
  });
  box.querySelectorAll('.btn-remove-item').forEach(btn => btn.addEventListener('click', () => {
    syncItemsFromDom();
    currentLoadItems.splice(parseInt(btn.dataset.row, 10), 1);
    renderItemRows();
  }));
  // Inserts a new blank row directly AFTER this one — per Apsara, "+ Add
  // item" at the bottom only ever appended to the end, with no way to slot
  // a forgotten item in between two already-entered ones without deleting
  // and re-adding everything after it.
  box.querySelectorAll('.btn-insert-item').forEach(btn => btn.addEventListener('click', () => {
    syncItemsFromDom();
    const idx = parseInt(btn.dataset.row, 10);
    currentLoadItems.splice(idx + 1, 0, blankLoadItem());
    renderItemRows();
  }));
  // ── Duplicate a row (Apsara 2026-09-02) ─────────────────────────────────
  // Copies what was TYPED — description, gross, tare, price, unit — into a new
  // row directly below.
  //
  // PHOTOS ARE DELIBERATELY NOT COPIED. A gross/tare photo is a picture of the
  // scale for one specific weighing. Cloning it onto a second item would put a
  // photograph of a different load's weight against that item and it would
  // look, on the ticket and in Drive, exactly like real evidence. That is a
  // fabricated audit trail, which is worse than no photo at all — so the
  // duplicate starts with none and the operator photographs the real weight.
  //
  // Weights ARE copied, because they are typed values the operator is about to
  // correct anyway, and because several identical drums genuinely do weigh the
  // same. The photo is what makes a weight evidence, and that is not cloned.
  box.querySelectorAll('.btn-dup-item').forEach(btn => btn.addEventListener('click', () => {
    syncItemsFromDom();
    const idx = parseInt(btn.dataset.row, 10);
    const src = currentLoadItems[idx] || blankLoadItem();
    currentLoadItems.splice(idx + 1, 0, Object.assign(blankLoadItem(), {
      description : src.description || '',
      // The unit and, for a /piece row, the count — copied for the same
      // reason the price is: several identical drums are the common case,
      // and a duplicate that silently reverted to pounds would reprice the
      // row by 2,204 without anyone touching it.
      unit        : src.unit || 'lb',
      pieces      : src.pieces ?? '',
      gross_weight: src.gross_weight ?? '',
      // ?? ONLY CATCHES null AND undefined, NOT ''. syncItemsFromDom stores
      // these as raw input strings, so a tare the operator had cleared comes
      // through as '' — and `'' ?? '0'` is '', not '0'. The duplicated row
      // then had a blank tare, parseFloat('') is NaN, and recomputeRowTotals
      // blanks the net box for ANY gross entered. The row looked normal and
      // simply refused to compute.
      //
      // A fresh row from blankLoadItem() starts at '0', so a duplicate of a
      // cleared row landing on '0' is the same rule, not a new one — which is
      // plainly what `?? '0'` was reaching for.
      tare_weight : (src.tare_weight === '' || src.tare_weight == null) ? '0' : src.tare_weight,
      price       : src.price ?? '',
      unit        : src.unit || '',
    }));
    renderItemRows();
  }));
}

function syncItemsFromDom() {
  const rows = $('ld_items').querySelectorAll('.item-row');
  currentLoadItems = Array.from(rows).map((row, i) => {
    // One free-text box since 2026-08-20 — no select, no "Others" branch.
    const descInput = row.querySelector('.ld-item-desc-input');
    const description = (descInput ? descInput.value : '').trim();
    // grossPhoto/tarePhoto/gross_photo_link/tare_photo_link aren't DOM-backed
    // (a captured photo, or an existing Drive link from an edit, isn't shown
    // as a form field) — carry them over from the previous state by row
    // index so they survive every other field's input events re-running
    // this sync, and so an EDIT doesn't lose an item's existing photo link
    // just because the user only touched the price field.
    const prev = currentLoadItems[i] || {};
    return {
      description,
      gross_weight: row.querySelector('.ld-item-gross').value,
      tare_weight : row.querySelector('.ld-item-tare').value,
      price: row.querySelector('.ld-item-price').value,
      // A per-item unit again, 2026-09-24 — but not the one that used to be
      // here. The old .ld-item-unit was a FREE-TEXT box labelled "Unit" that
      // nothing computed from; she removed it in 1ca3d5e making the row fit a
      // phone, and removing an unread label was right. This one is a
      // two-option select that the arithmetic actually reads, on both sides
      // of the wire. It stays out of the phone grid by living inside the
      // price cell, so that layout is not disturbed a second time.
      unit : row.querySelector('.ld-item-unit')?.value || 'lb',
      // ── AND THE COUNT, FOR A /piece ROW ────────────────────────────────
      // Posted unconditionally rather than only when the unit is /piece:
      // computeItem on the server drops it for a weight row anyway, and a
      // field the client sometimes omits is the shape that loses a value on
      // an edit. Read as a raw string like the weights above — syncItemsFromDom
      // stores what was typed and the server is what parses it.
      pieces: row.querySelector('.ld-item-pieces')?.value ?? '',
      grossPhoto: prev.grossPhoto || null,
      tarePhoto : prev.tarePhoto  || null,
      gross_photo_link: prev.gross_photo_link || null,
      tare_photo_link : prev.tare_photo_link  || null,
      gross_photo_drive_id: prev.gross_photo_drive_id || null,
      tare_photo_drive_id : prev.tare_photo_drive_id  || null,
    };
  });
}

// Shared by both capture paths (camera snapshot and file upload) — sends the
// image to Gemini/Vision for a weight read, fills that row's gross or tare
// field, remembers the photo (per item now, not per load) so it gets
// archived to Drive on save. `row` is the specific item-row DOM element the
// photo button lives in — everything is scoped to that one row's fields.

// ── ADJUST AGAINST THE OTHER SIDE ──────────────────────────────────────────
// Apsara, 2026-10-16: "when we pay load/sales-there should be a option to
// adjust against sale incase of load and against load in case of sale."
//
// Fired, not awaited, exactly like refreshPrepayCredit above: she pressed Pay
// to record a payment, and making that wait on a second request would make a
// working button feel broken on a slow yard connection. The box starts hidden
// and appears only if this party has something open on the other side, so the
// common case — a supplier who does not also buy — looks untouched.
//
// api() THROWS on a non-2xx and carries the server's fields onto the Error;
// it does not return { ok: false }. Checking a falsy r.ok would therefore
// never fire and every refusal would surface as an unhandled rejection.
let paySettleInfo = null;
async function refreshSettleOptions() {
  const box = $('paySettleBox');
  if (!box || !payingLoad) return;
  const sel = $('pay_settle_against');
  const amt = $('pay_settle_amount');
  const lead = $('paySettleLead');
  const note = $('paySettleNote');
  const btn = $('btnSettleAgainst');
  paySettleInfo = null;
  if (sel) sel.innerHTML = '';
  if (amt) amt.value = '';
  if (note) note.textContent = '';

  // ── ALWAYS VISIBLE, 2026-10-17 ───────────────────────────────────────
  // This box used to start hidden and appear only when the party had
  // something open on the other side, copying payPrepayBox. Apsara, on the
  // 9.6 build: "still adjust against that feature not there in app".
  //
  // She was right, and hiding it was the mistake. A control that is invisible
  // whenever the data does not line up is indistinguishable from a control
  // that was never built — so the first time it did not apply, the feature
  // read as missing. The prepayment box can get away with it because nobody
  // asked for it; she asked for THIS one by name.
  //
  // So it is always drawn on a yard pay modal, and it SAYS why it is empty.
  // Empty-with-a-reason is a working feature; absent is a bug report.
  box.classList.remove('hidden');
  const sale = payingLoad.kind === 'sale';
  const thisWord = sale ? 'sale' : 'load';
  const otherWord = sale ? 'Purchase' : 'Sale';
  const setEmpty = (msg) => {
    if (lead) lead.textContent = msg;
    if (sel) sel.disabled = true;
    if (amt) amt.disabled = true;
    if (btn) btn.disabled = true;
  };
  const setReady = () => {
    if (sel) sel.disabled = false;
    if (amt) amt.disabled = false;
    if (btn) btn.disabled = false;
  };
  setEmpty('Checking the other side\u2026');

  try {
    const r = await api('/api/payments/settle-options?load_id='
      + encodeURIComponent(payingLoad.id)
      + '&load_kind=' + encodeURIComponent(payingLoad.kind || 'purchase'));
    const opts = (r && r.options) || [];
    if (!r || !r.ok) { setEmpty((r && r.error) || 'Could not check the other side.'); return; }
    if (!opts.length) {
      // NAMED, not generic. "Nothing to settle" leaves her wondering whether
      // it looked at the right person.
      setEmpty('Nothing open on the other side for ' + (r.party || 'this party')
        + ' \u2014 no ' + (sale ? 'purchase' : 'sale') + ' of theirs is still owing.');
      return;
    }
    paySettleInfo = r;
    setReady();
    if (lead) {
      lead.innerHTML = esc(r.party) + ' is on both sides of your books. You can net what '
        + (sale ? 'you owe them' : 'they owe you') + ' against this ' + thisWord
        + ' instead of moving the cash.';
    }
    for (const o of opts) {
      const el = document.createElement('option');
      el.value = o.id;
      el.textContent = otherWord + ' ' + o.id + (o.date ? ' \u00b7 ' + o.date : '')
        + ' \u00b7 ' + payMoney(o.outstanding) + ' open';
      el.dataset.outstanding = String(o.outstanding);
      sel.appendChild(el);
    }
    // The most that can actually be netted — the smaller of the two sides.
    // Still editable, because she may want only part of it.
    const capFor = (open) => Math.min(Number(r.outstanding) || 0, Number(open) || 0);
    const first = capFor(opts[0].outstanding);
    if (amt) amt.value = first > 0 ? first.toFixed(2) : '';
    if (note) note.textContent = 'This moves no cash.';
    // Re-cap on a different pick: the previous figure left in the box is a
    // refusal waiting to happen.
    sel.onchange = () => {
      const pick = sel.options[sel.selectedIndex];
      const c = capFor(pick ? pick.dataset.outstanding : 0);
      if (amt) amt.value = c > 0 ? c.toFixed(2) : '';
    };
  } catch (e) {
    // ── SAID, NOT SWALLOWED ──────────────────────────────────────────
    // The previous version caught this and left the box hidden, so a server
    // that does not have the route yet — exactly the case on 2026-10-17,
    // with the APK shipped and the VM not restarted — looked identical to a
    // feature that was never written. Recording a payment still must not be
    // blocked, so this only ever disables the control and explains itself.
    const stale = /404|not found|request failed \(404\)/i.test(String(e && e.message || ''));
    setEmpty(stale
      ? 'Settling against the other side needs the server updated \u2014 this app is ahead of it.'
      : ('Could not check the other side: ' + (e.message || 'request failed')));
  }
}

async function settleAgainstSelected() {
  if (!payingLoad) return;
  const sel = $('pay_settle_against');
  const amt = $('pay_settle_amount');
  const btn = $('btnSettleAgainst');
  $('payErr').textContent = '';
  if (!sel || !sel.value) { $('payErr').textContent = 'Pick what to settle this against.'; return; }
  const amount = Number(amt && amt.value);
  if (!isFinite(amount) || amount <= 0) {
    $('payErr').textContent = 'How much of it should be settled?'; return;
  }

  btn.disabled = true; btn.textContent = 'Settling…';
  try {
    const r = await api('/api/payments/settle', { method: 'POST', body: JSON.stringify({
      load_id: payingLoad.id,
      load_kind: payingLoad.kind || 'purchase',
      against_id: sel.value,
      against_kind: (payingLoad.kind === 'sale') ? 'purchase' : 'sale',
      amount,
    }) });
    // Reload and REOPEN on the same row, the way applying prepaid credit
    // does: she sees the new balance and the settlement in the history,
    // rather than being thrown back to the deck to find it. The other side's
    // card is refreshed by the same loadLoads().
    await loadLoads();
    openPayModal(payingLoad.id, payingLoad.kind);
    const left = (r && r.summary && r.summary.pending);
    if (left != null) {
      $('payErr').textContent = payMoney(r.amount) + ' settled, no cash moved. '
        + (left > 0.004 ? payMoney(left) + ' still to hand over.' : 'Nothing left to pay.');
    }
  } catch (e) {
    // The server's refusals are the useful ones — "this purchase only has
    // 2000.00 outstanding" — so its message is shown verbatim.
    $('payErr').textContent = e.message || 'Could not settle that.';
  } finally {
    btn.disabled = false; btn.textContent = 'Settle it';
  }
}

