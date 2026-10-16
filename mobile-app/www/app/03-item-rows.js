// mobile-app/www/app/03-item-rows.js — split from mobile-app/www/index.html's <script> (helpers/sourceParts.js reconstructs the original)
// ── WHAT A PRICE IS PER ─────────────────────────────────────────────────
// Apsara, 2026-10-10: "in edge yard app,in addition to lbs-MT-Item can be
// /piece as well. and gross ton and net ton as well."
//
// THE SAME NUMBERS AS helpers/priceUnits.js, and tests/price-units.js reads
// this table out of the HTML and compares it. A comment promising the
// constants match is what the old code had, in both clients, while one of
// them was wrong — that is where the $15m figure came from.
//
// Net ton is the US short ton, gross ton is the UK long ton. Twelve per cent
// apart and both called "a ton" out loud, which is why they are separate
// codes rather than one. `piece` is null because it is not a weight: it
// multiplies a COUNT.
const LB_PER_UNIT = { lb: 1, nt: 2000, gt: 2240, mt: 2204.62, piece: null };
const UNIT_LABEL = { lb: '/lb', nt: '/net ton', gt: '/gross ton', mt: '/MT', piece: '/piece' };
// '' is pounds, and that is a fact about her data rather than a convenience:
// every row saved before 2026-09-24 has no unit on it and they are all pound
// rows. An unrecognised unit returns null and the caller shows no amount —
// it must NEVER fall through to pounds, which would price a /piece row's
// 46,560 lb at $5 a piece as $232,800.
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
  const unitNow = row.querySelector('.ld-item-unit')?.value || 'lb';
  const qty = qtyForUnit(unitNow, net, row.querySelector('.ld-item-pieces')?.value);
  const amount = (qty != null && isFinite(price)) ? Math.round(qty * price * 100) / 100 : null;
  // The Pieces box only exists for a counted unit, and the weight boxes stay
  // put — she still weighs the truck, and the seller signs a ticket with that
  // weight on it. Only what the price multiplies changes.
  const pieceWrap = row.querySelector('.ld-item-pieces-wrap');
  if (pieceWrap) pieceWrap.style.display = (unitOf(unitNow) === 'piece') ? '' : 'none';
  row.querySelector('.ld-item-amount').value = fmtAmount(amount);
  // Refreshed here rather than at each call site. recomputeRowTotals is called
  // from typing AND from the scale scanner filling a weight in, so putting it
  // at the source means a scanner read updates the totals for free and a new
  // caller cannot forget it.
  updateItemTotals();
}

// Sums the item rows and paints the totals line. Identical to the website's,
// on purpose — the same numbers must add up the same way whichever screen the
// load is typed on.
//
// Reads the DOM rather than currentLoadItems: the inputs are the live truth
// while someone is typing, and the model only catches up on the next
// syncItemsFromDom(), so summing the model would show a figure one keystroke
// behind. On a weight that is worse than showing nothing.
function updateItemTotals() {
  const el = document.getElementById('ld_item_totals');
  if (!el) return;
  const rows = document.querySelectorAll('#ld_items .item-row');
  let g = 0, t = 0, n = 0, amt = 0, any = false;
  rows.forEach((row) => {
    const gv = parseFloat(row.querySelector('.ld-item-gross')?.value);
    const tv = parseFloat(row.querySelector('.ld-item-tare')?.value);
    const nv = parseFloat(row.querySelector('.ld-item-net')?.value);
    // Amount is a formatted string (fmtAmount adds thousands separators), so
    // strip anything that is not part of a number before adding it.
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


// Drafts live on the SERVER (data/load_drafts.json, see helpers/loadDrafts.js).
//
// They were in localStorage first, which answered "don't lose my typing" but
// not what was actually asked: a draft you can come back to has to survive a
// closed tab, a flat phone, and being picked up on a different device.
// Browser storage cannot do any of that.
//
// Photos ride along. A draft that keeps the descriptions but loses the weight
// photos has lost the expensive half — re-typing a description takes seconds,
// re-weighing a truck does not.
const DRAFT_DEBOUNCE_MS = 900;
let draftTimer = null;
let currentDraftId = null;     // round-trips so autosave updates ONE record
let draftSaveInFlight = false;

// An item counts once it has a description or any weight — an untouched blank
// row must not make the form look like work in progress. Mirrors
// isWorthSaving() in helpers/loadDrafts.js; the server has the final say.
function itemHasContent(it) {
  if (!it) return false;
  return !!(String(it.description || '').trim()
    || Number(it.gross_weight) || Number(it.tare_weight) || Number(it.net_weight));
}

// Says on screen what the draft is doing. A silent autosave is
// indistinguishable from a broken one.
function setDraftStatus(state, detail) {
  const el = $('draftStatus');
  if (!el) return;
  el.className = state === 'saving' ? 'saving' : (state === 'saved' ? '' : 'idle');
  if (state === 'saved') {
    el.innerHTML = `<span class="dot"></span><span>Draft saved ${detail}</span>`;
  } else if (state === 'saving') {
    el.innerHTML = '<span class="dot"></span><span>Saving draft…</span>';
  } else if (state === 'waiting') {
    el.innerHTML = '<span>Autosaves as soon as you enter an item</span>';
  } else {
    el.innerHTML = '';
  }
}

function currentDraftPayload() {
  syncItemsFromDom();
  return {
    id: currentDraftId,
    kind: (typeof loadModalMode !== 'undefined' && loadModalMode === 'sale') ? 'sale' : 'purchase',
    date: $('ld_date') ? toIsoDate($('ld_date').value) : '',
    seller: $('ld_seller') ? $('ld_seller').value : '',
    seller_address: $('ld_seller_address') ? $('ld_seller_address').value : '',
    seller_phone: $('ld_seller_phone') ? $('ld_seller_phone').value : '',
    description: editingLoadDescription || '',
    // On the draft too — see helpers/loadDrafts.js. A recovered load that
    // comes back without its deduction is worse than one that comes back
    // empty, because it looks finished.
    trucking_company: $('ld_trucking_company') ? $('ld_trucking_company').value : '',
    trucking_amount: $('ld_trucking_amount') ? $('ld_trucking_amount').value : '',
    trucking_note: $('ld_trucking_note') ? $('ld_trucking_note').value : '',
    items: (currentLoadItems || []).filter(itemHasContent),
  };
}

async function saveLoadDraft() {
  // Drafts are only for NEW loads. An edit already has a saved record behind
  // it, and a stale draft restored over one is a way to silently revert a
  // correction someone else made.
  if (editingLoadId) { setDraftStatus('none'); return; }
  const payload = currentDraftPayload();
  if (payload.items.length < 2) { setDraftStatus('waiting'); return; }
  if (draftSaveInFlight) { queueLoadDraftSave(); return; }  // coalesce, never overlap
  draftSaveInFlight = true;
  try {
    const r = await api('/api/load-drafts', { method: 'POST', body: JSON.stringify(payload) });
    if (r && r.saved && r.id) {
      currentDraftId = r.id;
      setDraftStatus('saved', new Date(r.updated_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    } else {
      currentDraftId = null;
      setDraftStatus('waiting');
    }
  } catch (e) {
    // Never blocks the form, and never claims a save it did not get. If the
    // safety net is not there, the person relying on it needs to know.
    const el = $('draftStatus');
    if (el) { el.className = 'idle'; el.innerHTML = '<span style="color:var(--status-danger);">Draft not saved — check connection</span>'; }
  } finally {
    draftSaveInFlight = false;
  }
}

function queueLoadDraftSave() {
  if (draftTimer) clearTimeout(draftTimer);
  if (!editingLoadId) {
    // ONE item is enough — per Apsara, and matching isWorthSaving() in
    // helpers/loadDrafts.js. The two must agree or the badge says "Saving…"
    // for something the server then refuses to save, which is worse than no
    // badge at all.
    const filled = (currentLoadItems || []).filter(itemHasContent).length;
    if (filled >= 1) setDraftStatus('saving');
  }
  draftTimer = setTimeout(saveLoadDraft, DRAFT_DEBOUNCE_MS);
}

// Called after a real load is saved. DELETES the draft rather than converting
// it — a record that is both a draft and a load at the same moment is exactly
// the ambiguity the separate store exists to prevent.
async function clearLoadDraft() {
  if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }

  // ── WAIT FOR AN AUTOSAVE STILL IN THE AIR ─────────────────────────────
  // Apsara, 2026-09-30, on two identical loads a minute apart: "He just
  // saved it first.then edit ,continue or cancel.he clicked continue,then it
  // generated twice."
  //
  // currentDraftId is set only when the autosave POST RESOLVES. Press Save
  // while one is still in flight and this ran with id === null, returned
  // having deleted nothing, and the autosave then landed — leaving a draft
  // on the server for a load that had just been saved for real.
  //
  // The Loads screen offers that orphan as "Unfinished load...". Continuing
  // it calls openLoadDraft -> resetLoadModal, which sets editingLoadId to
  // null, so the form is in CREATE mode and Save writes a SECOND load. Same
  // seller, same weight, same money, sequential ids: EDGE_98 and EDGE_99.
  //
  // So the in-flight save is waited for rather than raced. BOUNDED, because
  // a draft is a convenience and must never hold up the confirmation of a
  // load that is already committed to disk.
  const startedWaiting = Date.now();
  while (draftSaveInFlight && Date.now() - startedWaiting < 3000) {
    await new Promise((r) => setTimeout(r, 50));
  }

  const id = currentDraftId;
  currentDraftId = null;
  setDraftStatus('none');
  if (!id) return;
  try { await api(`/api/load-drafts/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch (e) {}
}

// Repaints the Unfinished strip from the server.
//
// THE BUG THIS FIXES (Apsara 2026-08-29: "it is showing that autosaved but
// nowhere the draft is showing in app"): autosaving writes the draft and the
// footer correctly says so, but nothing told the Loads screen behind the
// modal. The strip was rendered when the tab loaded — before the draft
// existed — so it stayed empty until you navigated away and back. The draft
// was never lost; it was just invisible, which for a safety net is nearly as
// bad.
//
// Repaints ONLY the strip rather than reloading the whole tab: a full reload
// would refetch every load and throw away scroll position for a change that
// affects one row of the page.
async function refreshDraftStrip() {
  const el = document.getElementById('draftStrip');
  if (!el) return;
  pendingDrafts = await fetchLoadDrafts();
  el.innerHTML = draftStripHtml();
}

async function fetchLoadDrafts() {
  try { return asArray(await api('/api/load-drafts')); } catch (e) { return []; }
}

// Fills the form from a draft and ADOPTS its id, so continuing to type keeps
// updating the same record instead of spawning a second one.
function applyLoadDraft(d) {
  if (!d) return;
  currentDraftId = d.id;
  if ($('ld_date') && d.date) $('ld_date').value = toUsDate(d.date);
  if ($('ld_seller')) $('ld_seller').value = d.seller || '';
  if ($('ld_seller_address')) $('ld_seller_address').value = d.seller_address || '';
  if ($('ld_seller_phone')) $('ld_seller_phone').value = d.seller_phone || '';
  editingLoadDescription = d.description || '';
  if ($('ld_trucking_company')) $('ld_trucking_company').value = d.trucking_company || '';
  if ($('ld_trucking_amount'))  $('ld_trucking_amount').value  = d.trucking_amount != null ? d.trucking_amount : '';
  if ($('ld_trucking_note'))    $('ld_trucking_note').value    = d.trucking_note || '';
  // Opened when there is one, so a restored deduction is visible rather than
  // folded away behind a summary she has no reason to click.
  if ($('ld_trucking_details')) $('ld_trucking_details').open = !!d.trucking_amount;
  updateTruckingSummary();
  syncTruckerBillCheckbox();
  currentLoadItems = Array.isArray(d.items) && d.items.length ? d.items.slice() : [blankLoadItem()];
  renderItemRows();
  const bar = $('draftBar'); if (bar) bar.classList.add('hidden');
  setDraftStatus('saved', new Date(d.updated_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
}

// Offered on a blank form, never applied on its own — silently replacing what
// is on screen with something typed hours ago turns a safety net into a
// hazard.
async function offerLoadDraft() {
  const bar = $('draftBar');
  if (!bar) return;
  bar.classList.add('hidden');
  if (editingLoadId) return;
  const drafts = await fetchLoadDrafts();
  if (!drafts.length) return;
  const d = drafts[0];   // server returns newest first
  const mins = Math.round((Date.now() - new Date(d.updated_at).getTime()) / 60000);
  const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago`
    : new Date(d.updated_at).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
  const more = drafts.length > 1 ? ` (${drafts.length - 1} more below)` : '';
  $('draftBarText').textContent = `Unfinished load from ${ago} — ${(d.items || []).length} items${d.seller ? `, ${d.seller}` : ''}.${more}`;
  bar.dataset.draftId = d.id;
  bar.classList.remove('hidden');
}

// The strip above the Loads deck. This is what "can be edited later" means in
// practice — an unfinished load is visible from the list, not only from the
// moment you happen to open a blank form.
function draftStripHtml() {
  if (!pendingDrafts.length) return '';
  const card = (d) => {
    const items = Array.isArray(d.items) ? d.items : [];
    const names = items.map(i => String(i.description || '').trim()).filter(Boolean);
    const when = d.updated_at ? new Date(d.updated_at).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : '';
    return `
      <div class="draft-card">
        <div class="d-main">
          <div class="d-title">${esc(d.seller || 'Unnamed load')}${d.kind === 'sale' ? ' — sale' : ''}</div>
          <div class="d-sub">${items.length} item${items.length === 1 ? '' : 's'}${names.length ? ' · ' + esc(names.slice(0, 3).join(', ')) : ''} · last edited ${esc(when)}</div>
        </div>
        <button class="btn btn-resume-draft" data-id="${esc(d.id)}" style="padding:7px 14px; font-size:12px;">Continue</button>
        <button class="btn btn-drop-draft" data-id="${esc(d.id)}" style="padding:7px 12px; font-size:12px;">Delete</button>
      </div>`;
  };
  return `<div class="draft-strip">
      <div class="draft-strip-head">Unfinished — not saved as loads yet (${pendingDrafts.length})</div>
      ${pendingDrafts.map(card).join('')}
    </div>`;
}

// Reopens a draft in the load modal. Adopts its id, so finishing it updates
// the same draft and then deletes it on save rather than leaving a twin.
async function resumeDraft(id) {
  const d = pendingDrafts.find(x => x.id === id) || (await fetchLoadDrafts()).find(x => x.id === id);
  if (!d) return;
  resetLoadModal(d.kind === 'sale' ? 'sale' : 'purchase');
  $('loadModal').classList.remove('hidden');
  applyLoadDraft(d);
}

async function restoreLoadDraft() {
  const bar = $('draftBar');
  const id = bar && bar.dataset.draftId;
  const drafts = await fetchLoadDrafts();
  applyLoadDraft(drafts.find((x) => x.id === id) || drafts[0]);
}

// Discards from the bar: removes the RECORD, not just the notice.
async function discardOfferedDraft() {
  const bar = $('draftBar');
  const id = bar && bar.dataset.draftId;
  if (bar) bar.classList.add('hidden');
  if (!id) return;
  try { await api(`/api/load-drafts/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch (e) {}
  if (currentDraftId === id) { currentDraftId = null; setDraftStatus('waiting'); }
}

function draftStripHtml() {
  if (!pendingDrafts.length) return '';
  const card = (d) => {
    const items = Array.isArray(d.items) ? d.items : [];
    const names = items.map(i => String(i.description || '').trim()).filter(Boolean);
    const when = d.updated_at ? new Date(d.updated_at).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : '';
    return `
      <div class="draft-card">
        <div class="d-main">
          <div class="d-title">${esc(d.seller || 'Unnamed load')}${d.kind === 'sale' ? ' — sale' : ''}</div>
          <div class="d-sub">${items.length} item${items.length === 1 ? '' : 's'}${names.length ? ' · ' + esc(names.slice(0, 3).join(', ')) : ''} · last edited ${esc(when)}</div>
        </div>
        <button class="btn btn-resume-draft" data-id="${esc(d.id)}" style="padding:7px 14px; font-size:12px;">Continue</button>
        <button class="btn btn-drop-draft" data-id="${esc(d.id)}" style="padding:7px 12px; font-size:12px;">Delete</button>
      </div>`;
  };
  return `<div class="draft-strip">
      <div class="draft-strip-head">Unfinished — not saved as loads yet (${pendingDrafts.length})</div>
      ${pendingDrafts.map(card).join('')}
    </div>`;
}

async function resumeDraft(id) {
  const d = pendingDrafts.find(x => x.id === id) || (await fetchLoadDrafts()).find(x => x.id === id);
  if (!d) return;
  resetLoadModal(d.kind === 'sale' ? 'sale' : 'purchase');
  $('loadModal').classList.remove('hidden');
  applyLoadDraft(d);
}

