// dashboard/app/05-load-pricing.js — split from dashboard/index.html's <script> (helpers/sourceParts.js reconstructs the original)
const LB_PER_UNIT = { lb: 1, nt: 2000, gt: 2240, mt: 2204.62, piece: null };
const UNIT_LABEL = { lb: '/lb', nt: '/net ton', gt: '/gross ton', mt: '/MT', piece: '/piece' };
// An unrecognised unit returns null and the caller shows no amount. It must
// never fall through to pounds.
function unitOf(u) {
  const k = String(u == null ? '' : u).trim().toLowerCase();
  if (k === '') return 'lb';
  return Object.prototype.hasOwnProperty.call(LB_PER_UNIT, k) ? k : null;
}
function qtyForUnit(unit, net, pieces) {
  const u = unitOf(unit);
  if (u === null) return null;
  if (u === 'piece') {
    const c = parseFloat(pieces);
    return (isFinite(c) && c >= 0) ? c : null;
  }
  return (net == null || !isFinite(net)) ? null : net / LB_PER_UNIT[u];
}

function recomputeRowTotals(row) {
  // ── type="number" REPORTS AN EMPTY VALUE FOR ANYTHING IT CANNOT PARSE ──
  // This is the whole reason a weight can vanish without a trace. On a
  // number input, if what the field currently holds is not a valid number —
  // "1," from a phone keypad that emits a decimal comma, a stray character,
  // a half-typed "1." — the browser reports .value as the EMPTY STRING while
  // the box on screen still shows what was typed. The code sees nothing, the
  // operator sees "1", and net goes blank with no explanation.
  //
  // validity.badInput is how the browser says "there is text here and it is
  // not a number", and it is the only way to tell that case apart from a
  // genuinely empty box. jsdom does not set it (it sanitises programmatic
  // assignments instead), so this branch is real-device-only — which is
  // consistent with Apsara seeing this on the phone and it never once
  // reproducing here.
  const grossEl = row.querySelector('.ld-item-gross');
  const tareEl  = row.querySelector('.ld-item-tare');
  const badGross = !!(grossEl.validity && grossEl.validity.badInput);
  const badTare  = !!(tareEl.validity  && tareEl.validity.badInput);
  const grossRaw = grossEl.value;
  const tareRaw  = tareEl.value;
  const g = parseFloat(grossRaw);
  const t = parseFloat(tareRaw);
  const net = (isFinite(g) && isFinite(t)) ? Math.round((g - t) * 100) / 100 : null;
  const netEl = row.querySelector('.ld-item-net');
  netEl.value = net != null ? net : '';

  // ── A BLANK NET NOW SAYS WHY IT IS BLANK ──────────────────────────────
  // Apsara, 2026-09-16: "sometimes when i give gross lbs as 1.net is cnot
  // cmng as 1 ... this is only for newly added item", on the phone, with the
  // tare box reading 0.
  //
  // I could not reproduce it. Driven in jsdom on both clients — first row,
  // newly added row, first keystroke, after a re-render, after a description
  // blur — net computes every time. So the cause is something about the real
  // device that this code cannot see from here, and guessing at a fix would
  // mean shipping a change I cannot show fixes anything.
  //
  // What CAN be fixed without knowing the cause is the diagnosis. Net is
  // derived from two boxes, and when either one is not a number this used to
  // go silently blank — identical on screen to "the app is broken". The
  // placeholder now names the missing half, so the next time it happens she
  // can read what the form thinks is wrong instead of describing a symptom.
  //
  // Placeholder rather than a new element on purpose: it appears exactly
  // where she is already looking, only when the box is empty, and it cannot
  // shift the layout of a row on a narrow phone screen.
  if (net != null) {
    netEl.placeholder = '';
    netEl.removeAttribute('title');
  } else {
    const missing = [];
    if (!isFinite(g)) missing.push(badGross ? 'a valid gross' : 'gross');
    if (!isFinite(t)) missing.push(badTare ? 'a valid tare' : 'tare');
    netEl.placeholder = 'needs ' + missing.join(' + ');
    netEl.title = (badGross || badTare)
        ? `The ${badGross ? 'gross' : 'tare'} box contains something that is not a number — retype it.`
        : `Net is gross minus tare. Waiting on: ${missing.join(', ')}.`;
    // A box the browser cannot parse is flagged where the problem IS, not
    // only in the net column. Without this the operator stares at a weight
    // that looks perfectly fine and at an empty net, with nothing connecting
    // the two.
    grossEl.style.borderColor = badGross ? 'var(--status-danger)' : '';
    tareEl.style.borderColor  = badTare  ? 'var(--status-danger)' : '';
  }
  const price = parseFloat(row.querySelector('.ld-item-price').value);
  // ── THE PRICE IS PER POUND, OR PER TONNE ────────────────────────────────
  // THE NET IS NOT CONVERTED. It stays in pounds, as the weighbridge read
  // it and as the seller's ticket prints it. Only the QUANTITY the price
  // multiplies changes — which is why 'lb' and a missing unit take the same
  // branch, and every row anyone has ever entered computes as it always did.
  // Mirrors computeItem in helpers/loads.js, which is the source of truth and
  // recomputes this on save; if the two ever disagree the server wins and the
  // figure on screen was a lie. Same constant, deliberately.
  // Reads the row's CURRENT unit, whatever it is — including one this
  // screen's own picker cannot set, because the app can and the server
  // recomputes from it.
  const unitNow = row.querySelector('.ld-item-unit')?.value || 'lb';
  const qty = qtyForUnit(unitNow, net, row.querySelector('.ld-item-pieces')?.value);
  const amount = (qty != null && isFinite(price)) ? Math.round(qty * price * 100) / 100 : null;
  row.querySelector('.ld-item-amount').value = fmtAmount(amount);
  // Totals refresh here rather than at each call site. recomputeRowTotals is
  // called from typing, from a scanner read filling a weight in, and from a
  // photo-derived weight — putting it at the source means a new caller cannot
  // forget it and leave a stale total sitting under the rows.
  updateItemTotals();
}

// Sums every item row and paints the totals line. Called after any edit, and
// after add/remove/insert, so the figure at the bottom is never one keystroke
// out of date.
//
// Reads the DOM rather than currentLoadItems on purpose: the inputs are the
// live truth while someone is typing, and currentLoadItems only catches up on
// the next syncItemsFromDom(). Summing the model would show a total one
// character behind, which on a weight is worse than showing none.
function updateItemTotals() {
  const el = document.getElementById('ld_item_totals');
  if (!el) return;
  const rows = document.querySelectorAll('#ld_items .item-row');
  let g = 0, t = 0, n = 0, amt = 0, any = false;
  rows.forEach((row) => {
    const gv = parseFloat(row.querySelector('.ld-item-gross')?.value);
    const tv = parseFloat(row.querySelector('.ld-item-tare')?.value);
    const nv = parseFloat(row.querySelector('.ld-item-net')?.value);
    // Amount is a formatted string (fmtAmount), so strip anything that is
    // not part of a number before adding it up.
    const av = parseFloat(String(row.querySelector('.ld-item-amount')?.value || '').replace(/[^0-9.\-]/g, ''));
    if (isFinite(gv)) { g += gv; any = true; }
    if (isFinite(tv)) { t += tv; any = true; }
    if (isFinite(nv)) { n += nv; any = true; }
    if (isFinite(av)) { amt += av; }
  });
  if (!any) { el.innerHTML = ''; return; }
  const r2 = (x) => Math.round(x * 100) / 100;
  el.innerHTML = `
    <span class="tl-label">Total (${rows.length} item${rows.length === 1 ? '' : 's'})</span>
    <span class="tl-num" data-label="Gross">${r2(g).toLocaleString()}</span>
    <span class="tl-num" data-label="Tare">${r2(t).toLocaleString()}</span>
    <span class="tl-num tl-strong" data-label="Net">${r2(n).toLocaleString()}</span>
    <span></span>
    <span class="tl-num tl-strong" data-label="Amount">${amt ? fmtAmount(r2(amt)) : ''}</span>
    <span></span>`;
  // The payable line is "amount minus trucking", so it goes stale the moment
  // an item price changes. Refreshed from here rather than wired to every
  // item input separately — this function already runs on all of them.
  updateTruckingSummary();
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
    // Apsara, 2026-10-08, reopening a saved sale: "first time on saving
    // showing properly.but on edit,it is refactoring". Her screenshot showed
    // 46,560 lb at 330 /MT reading $15,364,800 — which is 46,560 × 330, the
    // POUND arithmetic, under a select correctly showing /MT.
    //
    // This line was `net * price`, with no unit in it. recomputeRowTotals()
    // forty lines up has always been right, so the figure was correct the
    // moment anything in the row was touched and wrong every time the modal
    // was merely OPENED — which is exactly "fine on save, wrong on edit".
    //
    // My bug, from 2026-09-24: I added the unit to the recompute path and to
    // the server's computeItem, and left the initial render on the old
    // formula. Two of the three places were updated, which is why every test
    // stayed green — they all drive the recompute.
    //
    // Nothing was ever SAVED wrong: syncItemsFromDom does not post `amount`,
    // and helpers/loads.js and helpers/outboundLoads.js both recompute it
    // from the unit. This was a lie on screen, not in the ledger — but a lie
    // large enough that correcting it by hand would have made it real.
    // Same function as the typing path above — the only way the two cannot
    // disagree again. This line is where the $15m came from: it had no unit
    // in it at all.
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
          <!-- ── TWO OPTIONS, HER CALL — AND A THIRD THAT PROTECTS THE ROW ──
               Asked whether this screen should offer net ton, gross ton and
               /piece as well, she chose display-only: pick them in the Edge
               Yard app, read them here.

               But a two-option <select> handed a value it has no option for
               silently becomes "" — which is how a pay modal posted an empty
               mode in September — and syncItemsFromDom's 'or lb' fallback would
               then turn that into POUNDS. So opening a /net ton load on this
               screen and pressing Save, changing nothing, would have
               repriced it by a factor of 2,000.

               So when the row carries a unit this picker does not offer, it
               is rendered as a disabled option AND selected. Disabled means
               she cannot newly choose it here; selected means the value
               round-trips untouched through a save. Switching it to /lb or
               /MT is still possible, because that is a decision she made
               rather than one the markup made for her. -->
          <select class="ld-item-unit" title="What is this price per? Net ton, gross ton and /piece are set in the Edge Yard app">
            ${(() => {
              const cur = unitOf(it.unit) || 'lb';
              const here = ['lb', 'mt'];
              const opts = here.map((u) => `<option value="${u}"${cur === u ? ' selected' : ''}>${UNIT_LABEL[u]}</option>`);
              if (!here.includes(cur)) {
                opts.push(`<option value="${cur}" selected disabled>${UNIT_LABEL[cur]} (set in the app)</option>`);
              }
              return opts.join('');
            })()}
          </select>
        </div>
        <!-- Hidden, not absent. This screen does not let her EDIT a count —
             that is the app's job by her choice — but the value has to be on
             the page for syncItemsFromDom to post it back, or saving a
             counted row here would blank its amount. A /piece row shows the
             count beside the amount in the read-only view below. -->
        <input type="hidden" class="ld-item-pieces" value="${it.pieces ?? ''}">
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
    <!-- Running totals, per Apsara 2026-08-28. Shares .item-row's grid so
         each figure sits directly under the column it sums, which is the
         only way a total is checkable at a glance against the scale
         tickets. Rendered here rather than as a fake item row so it can
         never be picked up by syncItemsFromDom(). -->
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
        onCamera: () => row.querySelector(`.ld-item-${role}-file-camera`).click(),
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
      // unitOf() rather than last.unit raw. This screen's picker offers
      // only /lb and /MT by her choice, so recalling a grade last bought
      // per NET TON would set <select>.value to a value it has no option
      // for — which silently becomes '' and then POUNDS on save. unitOf
      // returns null for anything this picker cannot represent and the
      // fallback is lb, which is at least a unit she can see.
      const unitSel = row.querySelector('.ld-item-unit');
      if (unitSel) {
        const want = last && unitOf(last.unit);
        const canShow = want && [...unitSel.options].some((o) => o.value === want);
        unitSel.value = canShow ? want : 'lb';
      }
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
      // Float it over the modal rather than inside its scroll box, so the
      // list is visible the moment it opens instead of below the fold.
      positionAcMenu(input, menu);
      menu.querySelectorAll('.ac-item').forEach(el => el.addEventListener('mousedown', (ev) => {
        // mousedown, not click: blur fires first on a click and would close
        // the menu before the click ever landed. preventDefault keeps focus
        // in the input so the pick doesn't also trigger the blur handler.
        ev.preventDefault();
        input.value = el.dataset.val;
        close();
        applyPriceIfChanged();
        syncItemsFromDom();
      }));
    };

    input.addEventListener('focus', openMatches);
    input.addEventListener('input', openMatches);
    trackAcMenu(input, menu);
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
      // ── THE COUNT ROUND-TRIPS EVEN THOUGH THIS SCREEN CANNOT SET IT ────
      // A /piece row's amount IS its count times its price. If this screen
      // posted no `pieces`, computeItem would see undefined, store null, and
      // the amount would go blank — so opening a counted load here and
      // saving would erase the figure. Carried in a hidden input rather than
      // left out.
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
async function processWeightImage(row, roleKey, base64, mime, statusEl) {
  const idx = parseInt(row.dataset.idx, 10);

  // Added 2026-08-11 — see the identical block in mobile-app/www/index.html
  // for the full reasoning. Capture-time quality gate, run before the photo
  // is attached or sent for a real OCR read: rejects a photo whose display
  // is measurably cut off at the frame edge and asks for a retake, instead
  // of accepting it and hoping OCR recovers digits that were never in the
  // shot. Fails open on any error — never blocks a real capture.
  if (statusEl) { statusEl.style.color = ''; statusEl.style.fontWeight = ''; statusEl.textContent = 'Checking photo…'; }
  try {
    const quality = await api('/api/vision/check-photo-quality', {
      method: 'POST',
      body: JSON.stringify({ image_base64: base64, mime_type: mime }),
    });
    if (quality && quality.ok === false) {
      if (statusEl) {
        statusEl.textContent = `⚠ ${quality.message || 'Photo not clear enough — please retake.'}`;
        statusEl.style.color = 'var(--status-danger)';
        statusEl.style.fontWeight = '700';
      }
      return;
    }
  } catch (err) {
    console.warn('[photo-quality-check] failed, proceeding without it:', err.message);
  }

  syncItemsFromDom(); // capture whatever's already typed before we mutate a photo onto it
  if (currentLoadItems[idx]) currentLoadItems[idx][roleKey === 'gross' ? 'grossPhoto' : 'tarePhoto'] = { base64, mime };
  if (statusEl) { statusEl.style.color = ''; statusEl.style.fontWeight = ''; statusEl.textContent = 'Reading scale…'; }
  try {
    const result = await api('/api/vision/read-weight', {
      method: 'POST',
      body: JSON.stringify({ image_base64: base64, mime_type: mime }),
    });
    // Full reasoning (raw_text/displays_seen) goes to the console instead of
    // the on-screen status now — useful for debugging a bad read without
    // cluttering the form with a paragraph of model commentary every time.
    console.log('[weight-read]', roleKey, JSON.stringify(result));
    if (result.weight != null) {
      row.querySelector(roleKey === 'gross' ? '.ld-item-gross' : '.ld-item-tare').value = result.weight;
      recomputeRowTotals(row);
      syncItemsFromDom();
      if (statusEl) {
        // result.ambiguous covers TWO distinct cases as of 2026-08-10:
        // (1) no display could be isolated in time and this number came
        // from reading the WHOLE photo, which can contain more than one
        // number (a bench-scale reading, a date, etc.) — no specific
        // alternate number in this case, or (2) a display WAS isolated and
        // read, but Gemini's own independent read of the SAME crop
        // disagreed — in which case result.alternate_weight carries
        // Gemini's actual number, so the message can show BOTH candidates
        // directly instead of a vague "didn't agree," letting the operator
        // resolve it with one glance instead of walking back to the scale.
        // Confirmed live 2026-08-10 on a real photo: Vision hallucinated a
        // blank cell into "82258," Gemini correctly read the same crop as
        // "2251" — Vision is NOT universally more accurate than Gemini
        // across every display type, so this shows both rather than
        // silently trusting Vision's default.
        if (result.ambiguous) {
          if (result.alternate_weight != null) {
            statusEl.textContent = `⚠ TWO DIFFERENT READS — one check says ${result.weight} ${result.weight_unit || ''}, another says ${result.alternate_weight} ${result.weight_unit || ''}. Check the scale and enter the correct value.`;
          } else {
            statusEl.textContent = `⚠ UNSURE — read ${result.weight} ${result.weight_unit || ''}, but a second check didn't confidently agree. Double-check against the scale before saving.`;
          }
          statusEl.style.color = 'var(--status-danger)';
          statusEl.style.fontWeight = '700';
        } else {
          statusEl.textContent = `Read: ${result.weight} ${result.weight_unit || ''} — check it matches the scale before saving.`;
          statusEl.style.color = '';
          statusEl.style.fontWeight = '';
        }
      }
    } else if (statusEl) {
      statusEl.style.color = '';
      statusEl.style.fontWeight = '';
      statusEl.textContent = "Couldn't read a number — enter manually.";
    }
  } catch (err) {
    if (statusEl) { statusEl.style.color = ''; statusEl.style.fontWeight = ''; statusEl.textContent = 'Read failed: ' + err.message + ' — enter manually.'; }
  }
}

// Changed 2026-08-11: this used to cap long edge at 1600px, on the theory
// that reading a handful of digits off a scale display doesn't need full
// resolution. Tested directly against production traffic and that theory
// was wrong — same 3 photos, same backend code, only this cap changed:
// at 1600px the weight-OCR pipeline got 0/3 correct (wrong reads: 1150 vs
// true 71920, 87528 vs true 81528, 41516 vs true 28460); at original
// resolution it got 3/3 correct. The 1600px downscale was silently
// corrupting the exact digits the pipeline needs, not just shrinking
// irrelevant background. So: send original resolution now (maxDim
// effectively unbounded), quality bumped to 0.95 to match what was tested.
// PayloadTooLargeError (the original reason for the 1600px cap) is fixed
// on the backend instead — api.js's PUT /api/loads/:id already uses
// express.json({limit:'40mb'}) — and realistic full-res phone JPEGs from
// this app's own uploads folder run ~1.7-1.9MB, comfortably under that.
// If a specific device produces much larger originals than that and hits
// the body-parser limit again, raise the backend limit further rather than
// re-adding a client-side resolution cap — that's the lever that was just
// proven to break accuracy, not payload size.
function downscaleToBase64(source, srcW, srcH, maxDim = 1e9, quality = 0.95) {
  let w = srcW, h = srcH;
  if (w > maxDim || h > maxDim) {
    const scale = maxDim / Math.max(w, h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(source, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', quality).split(',')[1];
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image file')); };
    img.src = url;
  });
}

// `row` is the specific item-row DOM element this file input lives in —
// scoped per item now, not per load.
async function handleFileUpload(row, roleKey, file) {
  if (!file) return;
  // One shared status line per row now (not per gross/tare) — keeps the row
  // itself a single line; this line only fills in transiently during a read.
  const statusEl = row.querySelector('.ld-item-status');
  statusEl.textContent = 'Preparing photo…';
  try {
    const img = await loadImageFromFile(file);
    const base64 = downscaleToBase64(img, img.naturalWidth || img.width, img.naturalHeight || img.height);
    await processWeightImage(row, roleKey, base64, 'image/jpeg', statusEl);
  } catch (err) {
    statusEl.textContent = err.message;
  }
}

// Small floating "Take Photo / Choose File" menu, shown when a row's 📷
// button is clicked — per Apsara, a single plain file input's OS chooser
// was surfacing Google Photos ahead of an actual camera option, with no way
// to just say "take a new photo." Appended to <body> (not inside the row)
// so it isn't clipped by #ld_items' horizontal-scroll overflow, positioned
// off the button's real screen position. Dismissed on choosing either
// option or clicking anywhere else.
function showCaptureMenu(anchorBtn, { onCamera, onFiles }) {
  document.querySelectorAll('.capture-menu').forEach(m => m.remove());
  const rect = anchorBtn.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'capture-menu';
  menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
  menu.style.left = `${rect.left + window.scrollX}px`;
  menu.innerHTML = `
    <button type="button" class="capture-menu-btn" data-action="camera">📷 Take Photo</button>
    <button type="button" class="capture-menu-btn" data-action="files">📁 Choose File</button>
  `;
  document.body.appendChild(menu);
  const close = () => { menu.remove(); document.removeEventListener('click', outsideClick, true); };
  const outsideClick = (e) => { if (!menu.contains(e.target) && e.target !== anchorBtn) close(); };
  menu.querySelector('[data-action="camera"]').addEventListener('click', () => { close(); onCamera(); });
  menu.querySelector('[data-action="files"]').addEventListener('click', () => { close(); onFiles(); });
  // Deferred one tick so the SAME click that opened the menu (which is still
  // bubbling up to document right now) doesn't immediately close it again.
  setTimeout(() => document.addEventListener('click', outsideClick, true), 0);
}

// tare_weight defaults to "0" now, not blank — per Apsara 2026-08-15 ("by
// default tare should be zero, unless user overrides"): most items on this
// scale aren't in a container/vehicle with its own tare weight, so typing
// "0" on every single row was pure friction. Still a plain editable input —
// override it same as before for anything that actually has a tare.
// validateItemsBeforeSave/the item filter above both EXCLUDE tare_weight
// from "does this row have data" on purpose, so an untouched spare row
// (still showing the "0" default, nothing else filled in) isn't wrongly
// treated as a real item requiring a description.
function blankLoadItem() {
  return { description: '', gross_weight: '', tare_weight: '0', price: '', unit: '', grossPhoto: null, tarePhoto: null, gross_photo_link: null, tare_photo_link: null, gross_photo_drive_id: null, tare_photo_drive_id: null };
}

// Edge Trading is always the BUYER on every load — per Apsara 2026-08-15
// ("no. buyer should be edge trading"), correcting the field that used to be
// fixed here (it was "Seller" = "Edge Metals Inc.", backwards: Edge Trading
// is the one buying the scrap, so it's the buyer, and the outside company is
// the seller). Field stays visible (locked/disabled input) rather than
// removed, so it's still obvious on screen who the buyer is without anyone
// being able to accidentally type over it. See helpers/loads.js's
// getInventoryReport and pdf.js — both read the SELLER field now (the
// editable one, below) for the counterparty's name.
const BUYER_FIXED_NAME = 'Edge Trading';

// ── Address Book integration on the Seller name field — per Apsara
// 2026-08-15: typing a name here should suggest existing /address-book
// entries; picking one fills in the address; a name that matches NOTHING
// gets both name+address saved back to the Address Book automatically once
// the load save succeeds, so the book grows on its own. Cache is small (same
// "let the client filter" reasoning as api.js's own comment on this route)
// and refreshed every time the load modal opens, not just once per page
// load, so a Sync-from-Doc or manual add elsewhere is picked up promptly.
let addressBookCache = [];
async function refreshAddressBookCache() {
  try { addressBookCache = await api('/api/address-book'); }
  catch (err) { addressBookCache = []; } // best-effort — autocomplete just won't suggest anything
}
function addressBookExactMatch(name) {
  const q = String(name || '').trim().toLowerCase();
  if (!q) return null;
  return addressBookCache.find(e => (e.aliases || []).some(a => a.toLowerCase() === q)) || null;
}

// Local (not UTC) YYYY-MM-DD — a load dated by UTC-conversion could land on
// the WRONG calendar day for anyone west of Greenwich in the evening
// (e.g. 9pm Pacific is already the next day in UTC), which is exactly the
// kind of off-by-one that would misfile a load into tomorrow's date group.
function todayLocalDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── TODAY WHERE THE BUSINESS IS, NOT WHERE THE LAPTOP IS ─────────────────
// Apsara, 2026-09-10: "Bill date and invoice date should be by default today
// in LA date".
//
// todayLocalDateStr() above reads the BROWSER's clock. Opened from India at
// nine in the morning, that is already tomorrow by Los Angeles reckoning, so
// every bill and invoice created before ~12:30pm IST would carry a date the
// yard has not reached yet — and it would go straight into the Edge Metals
// Shipment tab that way. Same bug class as helpers/bookingRequest.js, where
// a server-local getDate() turned "cut off 20 Sep" into 21 Sep.
//
// en-CA gives YYYY-MM-DD directly, so there is no month-name parsing to get
// wrong. Deliberately a SECOND function rather than a change to the one
// above: the Edge Yard forms (load date, trucker bill, yard payment) still
// use browser-local, and moving their dates is a money-visible change to the
// spend report's ranges that she has not asked for.
const YARD_TZ = 'America/Los_Angeles';
function todayYardDateStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: YARD_TZ });
}

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
  const t = sale ? 'Record sale' : 'Create invoice';
  if ($('loadModalTitle')) $('loadModalTitle').textContent = editingLoadId ? (sale ? 'Edit sale' : 'Edit load') : t;
  if ($('btnSaveLoad')) $('btnSaveLoad').textContent = editingLoadId ? 'Save changes' : t;
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
  // Phone now shares a row with the address, so hiding it on a sale would
  // leave the address in a half-width column with a gap beside it. Collapse
  // the row to one column so the address simply takes the space.
  const row2 = $('ld_party_row2');
  if (row2) row2.style.gridTemplateColumns = sale ? '1fr' : '';
  // Trucking is a PURCHASE deduction — what she pays the seller, less the
  // haulage she covered. There is no equivalent on a sale: a customer owes
  // the invoice, and quietly reducing it by what a hauler charged her would
  // be inventing a discount. Hidden rather than disabled so nothing about it
  // can reach a sale payload by accident.
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
  // Summed from the DOM, same source updateItemTotals reads and for the same
  // reason: the inputs are the live truth while someone is typing.
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
  stopCamera();
  // A new blank form is exactly where an unfinished one is worth offering.
  offerLoadDraft();
  setDraftStatus(editingLoadId ? 'none' : 'waiting');
  refreshAddressBookCache();
  // Re-render after the fetch lands so any description typed via "Others…"
  // on a previous load shows up as a real option, not just the base list —
  // renderItemRows() above already ran synchronously with whatever
  // customItemTypes held before this call (usually last load modal's data,
  // or empty on first open), so this catches it up.
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
  if ($('ld_seller'))          $('ld_seller').value          = load.seller || '';
  if ($('ld_seller_address'))  $('ld_seller_address').value  = load.seller_address || '';
  if ($('ld_seller_phone'))    $('ld_seller_phone').value    = load.seller_phone || '';
  editingLoadDescription = load.description || '';
  if ($('ld_desc'))            $('ld_desc').value            = load.description || '';
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
  // how a second payable gets written for one haul. The server refuses the
  // duplicate anyway — this stops her being asked to make the mistake.
  if ($('ld_trucking_bill')) { $('ld_trucking_bill').checked = false; $('ld_trucking_bill').dataset.touched = '1'; }
  updateTruckingSummary();
  $('loadModalErr').textContent = '';
  // Set AFTER editingLoadId is assigned — applyLoadModalMode runs before this
  // while it is still null, so its title is the create-mode one.
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
          <div style="font-family:var(--font-mono); font-size:11px; color:var(--text-muted); margin-top:2px;">${esc(fmtDate(l.date, '—'))} · ${esc(l.id)}</div>
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
             ticket uses, formatted by the shared fmtAmount so it carries the
             $ and two decimals like everywhere else.
             An em-dash when there is no total, NOT $0.00: a load whose items
             have no price yet is worth "not priced", and printing $0.00 would
             read as "worth nothing", which is a different claim.
             Mirrors mobile-app/www/index.html. -->
        <span style="font-weight:700; color:var(--text-strong);">Amount: ${l.amount != null && fmtAmount(l.amount) ? esc(fmtAmount(l.amount)) : '—'}</span>
        <!-- The deduction, and only when there is one. Every card in the deck
             is otherwise exactly the card it was — a "Trucking —" line on
             hundreds of tiles would be noise on the screen she scans most.
             Mirrors mobile-app/www/index.html. -->
        ${Number(l.trucking_amount) > 0 ? `
        <span style="font-size:11px; color:var(--text-muted);">Less trucking: ${esc(fmtAmount(l.trucking_amount))}${l.trucking_company ? ' · ' + esc(l.trucking_company) : ''}</span>
        <span style="font-weight:700; color:var(--text-strong);">Payable: ${l.net_payable != null && fmtAmount(l.net_payable) ? esc(fmtAmount(l.net_payable)) : '—'}</span>` : ''}
      </div>
      ${paymentBadgeHtml(l)}
      <div style="margin-top:12px; display:flex; flex-direction:column; align-items:flex-start; gap:6px;">
        ${l.pdf_link ? `<a href="${esc(l.pdf_link)}" target="_blank" rel="noopener" style="font-size:12px;">View PDF →</a>` : ''}
        ${l.weights_pdf_link ? `<a href="${esc(l.weights_pdf_link)}" target="_blank" rel="noopener" style="font-size:12px;">View weights PDF →</a>` : ''}
        <!-- POS receipt PDF (80mm width) — per Apsara 2026-08-17. Mirrors
             mobile-app/www/index.html's identical link. -->
        ${l.receipt_pdf_link ? `<a href="${esc(l.receipt_pdf_link)}" target="_blank" rel="noopener" style="font-size:12px;">Print (POS receipt) →</a>` : ''}
        <!-- Ticket actions are purchase-only: a sale has no yard ticket to
             generate, no seller to send one to and nothing to sign. Hidden
             rather than shown-and-failing. Mirrors the app. -->
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
        <!-- Send to seller — only once a PDF exists. Shown even without a
             phone on file so the click handler can surface that as a
             clear error rather than the option just silently not being
             there — per Apsara 2026-08-17. Mirrors mobile-app/www/index.html. -->
        ${l.pdf_link && l._kind !== 'sale' ? `<button class="btn btn-send-seller" data-id="${esc(l.id)}" style="font-size:12px; padding:6px 12px;">Send to seller (WhatsApp)</button>` : ''}
      </div>
      <div style="margin-top:10px; display:flex; gap:8px; border-top:1px solid var(--border-subtle); padding-top:10px;">
        <button class="btn btn-edit-load" data-id="${esc(l.id)}" style="font-size:11px; padding:5px 10px;">Edit</button>
        <!-- Renumber button REMOVED 2026-08-17 per Apsara ("remove the
             renumber button in app for both staff and admin access",
             confirmed "remove it everywhere, no exceptions") — mirrors
             the identical removal in mobile-app/www/index.html.
             PUT /api/loads/:id/renumber still exists server-side (still
             requireAdmin-gated), deliberately left rather than deleted:
             removing a route is a breaking API change and nothing calls
             it anymore anyway. -->
        ${loadIsDeletable(l) ? `<button class="btn btn-danger btn-delete-load" data-id="${esc(l.id)}" style="font-size:11px; padding:5px 10px;">Delete</button>` : ''}
        <!-- Pay, per Apsara 2026-08-28. Sits with Edit/Delete because it is a
             thing done TO an existing load, not part of creating one. -->
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

// ── WHICH KIND OF ROW ───────────────────────────────────────────────────
// The deck merges purchases (helpers/loads.js) and sales (outboundLoads.js);
// the map that builds loadsCache tags each with _kind and aliases a sale's
// buyer into `seller`. Anything untagged is a purchase, which is what every
// row was before sales existed — so an old record filters correctly without
// being migrated.
const LOAD_KINDS = [['all', 'All'], ['purchase', 'Purchases'], ['sale', 'Sales']];

// ── THE FIGURES AT THE TOP FOLLOW THE FILTER ───────────────────────────────
// Apsara, 2026-09-16: "also in loads,only loads are coming what about sales
// and its value when i click on sales???"
//
// She was right and it was worse than it looked. The three figures were
// computed from loadsCache — EVERYTHING — while the deck below them showed the
// filtered set. Press Sales and the list narrowed while "62 loads · $650,590"
// sat unchanged above it, which does not read as a bug: it reads as the total
// for what is on screen. A wrong number that looks like an answer is worse
// than no number.
//
// ── AND "VALUE" ON *ALL* WAS NEVER A REAL FIGURE ────────────────────────────
// This is the part she did not ask about and is the more serious half. On All,
// `value` summed the amount of every load — purchases AND sales — into one
// total. A purchase amount is money OUT and a sale amount is money IN; adding
// them produces a number that means nothing at all, and it grows every time
// she trades, so it looks like a business figure going up.
//
// So All no longer prints one blended total. It shows what was bought and what
// was sold, side by side and separately, and neither is called profit — the
// yard's actual margin needs the cost of the specific metal sold, which is
// what helpers/yardProfit.js exists to work out.
function loadStats(rows, kind) {
  const list = rows || [];
  const sum = (f) => list.reduce((t, l) => t + (Number(f(l)) || 0), 0);
  const net = sum((l) => l.net_weight).toLocaleString();
  const money = (k) => fmtAmount(list.filter((l) => (l._kind === 'sale' ? 'sale' : 'purchase') === k)
    .reduce((t, l) => t + (Number(l.amount) || 0), 0)) || '—';

  if (kind === 'sale') {
    return [['sales', String(list.length)], ['net weight', esc(net)], ['sold for', esc(money('sale'))]];
  }
  if (kind === 'purchase') {
    return [['purchases', String(list.length)], ['net weight', esc(net)], ['paid', esc(money('purchase'))]];
  }
  return [
    ['loads', String(list.length)],
    ['net weight', esc(net)],
    ['bought', esc(money('purchase'))],
    ['sold', esc(money('sale'))],
  ];
}

function filterLoadsByKind(loads, kind) {
  if (!kind || kind === 'all') return loads;
  return (loads || []).filter((l) => (l._kind === 'sale' ? 'sale' : 'purchase') === kind);
}

function filterLoads(loads, query) {
  // ── ONE box, typed, matching everything on the load ─────────────────────
  // Apsara, 2026-09-02: "instead of select option of item detail filter, make
  // it as type and match .. add it to search by date, seller, item, price."
  //
  // There WAS a second control here — a dropdown of the item types present in
  // the deck, added earlier the same day. It is gone. Two controls answering
  // the same question is one more than anyone wants to reach for on a phone in
  // a yard, and the dropdown's only real advantage was exact matching, which
  // is not what you want when you are looking for a load: typing "sealed"
  // should find Sealed Units, and it does.
  //
  // So the haystack is everything a person might type: the load's own fields,
  // and its ITEMS — descriptions and per-item prices. Item weights stay out;
  // an item weighing 300 would make every load with a 300 anywhere in it
  // match, and the load-level weights are already in here.
  const q = (query || '').trim().toLowerCase();
  if (!q) return loads;
  return loads.filter(l => {
    const items = Array.isArray(l.items) ? l.items : [];
    const haystack = [l.id, l.date, l.seller, l.description, l.gross_weight, l.tare_weight, l.net_weight, l.amount, l.status]
      .concat(items.map(it => it.description))
      .concat(items.map(it => it.price))
      .map(v => String(v ?? '').toLowerCase()).join(' ');
    return haystack.includes(q);
  });
}

// Builds just the deck markup (date sections + cards), reused by both the
// initial render and every search-box keystroke so filtering doesn't have
// to re-render the whole tab (modal, header, styles) each time. Each date
// section is a native <details>/<summary> — free expand/collapse with zero
// extra JS — with only the FIRST (most recent) group open by default once
// there's more than one, per Apsara's "expand based on dates" once the deck
// has more cards than fits comfortably on one screen.
// opts.flat renders ONE grid instead of per-date sections.
//
// Per Apsara 2026-09-01: "on filtering of load by say, seller - it should not
// group by date." The date sections exist to make a particular day findable
// in a long deck — but once you have searched for a seller you are no longer
// looking for a day, and splitting six results across five collapsed date
// headers hides four of them behind a disclosure triangle. (Only the FIRST
// section renders open.) So a search result is a flat, newest-first list.
//
// The unfiltered deck keeps its date sections — that view genuinely is
// "what happened when". Mirrors mobile-app/www/index.html.
// ── the lines behind an Inventory row ──────────────────────────────────────
// Apsara, 2026-09-02: "if i select sealed units, i want the matching loads
// that contain sealed units to be displayed .. matching sealed units from
// every load in rows with gross tare net price amount. on clicking that row,
// that load ticket should open."
//
// FETCHED ON OPEN, not shipped with the summary. The Inventory report is
// requested every time the tab is visited and exists to summarise; attaching
// every item line to every group would send the whole item history to draw a
// summary — tens of thousands of lines over a yard-year.
//
// The date filter currently on screen is passed through, so opening a type
// while a range is applied shows that range's lines and not silently all of
// them.
const invLinesCache = {};        // description -> payload, per render
let invLinesOpen = null;         // which type is expanded

async function toggleInvLines(description, from, to) {
  const key = String(description || '');
  invLinesOpen = (invLinesOpen === key) ? null : key;
  if (invLinesOpen && !invLinesCache[key]) {
    const qs = ['description=' + encodeURIComponent(key)];
    if (from) qs.push('from=' + encodeURIComponent(from));
    if (to) qs.push('to=' + encodeURIComponent(to));
    try {
      invLinesCache[key] = await api('/api/loads/inventory/items?' + qs.join('&'));
    } catch (e) {
      // An error, not an empty list. A failed fetch that renders as "no rows"
      // says the material does not exist, which is a different and wrong
      // statement — the same mistake the description catalogue was making.
      invLinesCache[key] = { error: e.message || 'could not load', lines: [], count: 0 };
    }
  }
  renderInvLines();
}

// ── wire the item-type drill-down ─────────────────────────────────────────
// Called after EVERY repaint of the inventory rows, and there is more than one
// such path — which is exactly how this broke.
//
// Apsara, 2026-09-02: "in inventory when i click item type sealed units, it is
// not displaying anything." The wiring had been added only to the sub-tab
// SWITCH path, so tapping a type on a freshly opened Inventory tab did
// nothing at all. It worked on the website, where the initial render is the
// same function, and I verified it there and shipped both. One client tested,
// two clients shipped.
//
// Pulled out here so a paint path cannot exist without the wiring sitting
// beside it.
function wireInvLineToggles(from, to) {
  document.querySelectorAll('[data-inv-toggle]').forEach((el) => el.addEventListener('click', () => {
    toggleInvLines(el.getAttribute('data-inv-toggle'), from, to);
  }));
  renderInvLines();
}

function invLinesHtml(key) {
  const d = invLinesCache[key];
  if (!d) return '<div style="padding:14px; font-family:var(--font-mono); font-size:11.5px; color:var(--text-faint);">Loading…</div>';
  if (d.error) return `<div style="padding:14px; font-size:12.5px; color:var(--status-danger);">Could not load these lines: ${esc(d.error)}</div>`;
  if (!d.count) return '<div style="padding:14px; font-family:var(--font-mono); font-size:11.5px; color:var(--text-faint);">No lines in this range.</div>';
  const n = (v) => (v == null || v === '' ? '—' : esc(v));
  const t = d.totals || {};
  return `
    <div style="overflow-x:auto;">
    <table id="invLinesTable" class="stack-table" style="width:100%; border-collapse:collapse; font-size:12.5px; min-width:560px;">
      <thead><tr style="background:var(--surface-sunken); text-align:right;">
        <th style="padding:8px 10px; text-align:left; font-family:var(--font-mono); font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted);">Load</th>
        <th style="padding:8px 10px; text-align:left; font-family:var(--font-mono); font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted);">Seller</th>
        ${['Gross','Tare','Net','Price','Amount'].map(h => `<th style="padding:8px 10px; font-family:var(--font-mono); font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted);">${h}</th>`).join('')}
      </tr></thead>
      <tbody>
        ${d.lines.map(r => `
        <tr class="inv-line-row" data-pdf="${esc(r.pdf_link || '')}" data-load="${esc(r.load_id)}"
            title="${r.pdf_link ? 'Open this load ticket' : 'No ticket generated for this load yet'}"
            style="border-top:1px solid var(--border-subtle); text-align:right; cursor:${r.pdf_link ? 'pointer' : 'default'};">
          <td class="st-head" style="padding:8px 10px; text-align:left; font-family:var(--font-mono); color:${r.pdf_link ? 'var(--accent)' : 'var(--text-strong)'};">${esc(r.load_id)}${r.pdf_link ? '' : ' <span style="color:var(--text-faint); font-size:10px;">(no ticket)</span>'}</td>
          <td data-label="Seller" style="padding:8px 10px; text-align:left;">${esc(r.seller || '—')}<div style="font-family:var(--font-mono); font-size:10px; color:var(--text-faint);">${esc(typeof fmtDate === 'function' ? fmtDate(r.date) : (r.date || ''))}</div></td>
          <td data-label="Gross" style="padding:8px 10px; font-family:var(--font-mono);">${n(r.gross_weight)}</td>
          <td data-label="Tare" style="padding:8px 10px; font-family:var(--font-mono);">${n(r.tare_weight)}</td>
          <td data-label="Net" style="padding:8px 10px; font-family:var(--font-mono); font-weight:700;">${n(r.net_weight)}</td>
          <td data-label="Price" style="padding:8px 10px; font-family:var(--font-mono);">${r.price == null ? '—' : esc(fmtRate ? fmtRate(r.price) : r.price)}</td>
          <td data-label="Amount" style="padding:8px 10px; font-family:var(--font-mono); font-weight:700;">${r.amount == null ? '—' : esc(fmtAmount(r.amount))}</td>
        </tr>`).join('')}
        <tr class="st-total" style="border-top:2px solid var(--border-default); text-align:right; background:var(--surface-sunken);">
          <td class="st-head" colspan="2" style="padding:8px 10px; text-align:left; font-family:var(--font-mono); font-weight:700;">${esc(d.count)} line${d.count === 1 ? '' : 's'}</td>
          <td data-label="Gross" style="padding:8px 10px; font-family:var(--font-mono); font-weight:700;">${n(t.gross)}</td>
          <td data-label="Tare" style="padding:8px 10px; font-family:var(--font-mono); font-weight:700;">${n(t.tare)}</td>
          <td data-label="Net" style="padding:8px 10px; font-family:var(--font-mono); font-weight:800;">${n(t.net)}</td>
          <td class="st-spacer" style="padding:8px 10px;"></td>
          <td data-label="Amount" style="padding:8px 10px; font-family:var(--font-mono); font-weight:800;">${t.amount == null ? '—' : esc(fmtAmount(t.amount))}</td>
        </tr>
      </tbody>
    </table></div>`;
}

// Paints the open panel and wires the row clicks. Delegated per render rather
// than bound once, because the panel is rebuilt on every toggle.
function renderInvLines() {
  document.querySelectorAll('[data-inv-lines]').forEach((el) => {
    const key = el.getAttribute('data-inv-lines');
    const on = invLinesOpen === key;
    el.innerHTML = on ? invLinesHtml(key) : '';
    el.style.display = on ? 'block' : 'none';
  });
  document.querySelectorAll('[data-inv-toggle]').forEach((el) => {
    el.setAttribute('aria-expanded', invLinesOpen === el.getAttribute('data-inv-toggle') ? 'true' : 'false');
  });
  document.querySelectorAll('.inv-line-row').forEach((row) => row.addEventListener('click', () => {
    const pdf = row.dataset.pdf;
    // A row with no ticket yet does nothing rather than opening a broken tab.
    // The row already says "(no ticket)", so the click having no effect is
    // consistent with what it shows.
    if (!pdf) return;
    window.open(pdf, '_blank', 'noopener');
  }));
}

// ── Spend report ───────────────────────────────────────────────────────────
// Apsara, 2026-09-02: "A report needs to be there.. where i can track the
// monthly spent of cash/zelle/wire. date wise filter can also be there like
// quickbook."
//
// Every figure is SERVER-COMPUTED (helpers/spendReport.js). This screen
// renders and filters; it never adds anything up. A report that does its own
// arithmetic is a second implementation waiting to disagree with the ledger it
// claims to describe — and here the two ledgers are money.
