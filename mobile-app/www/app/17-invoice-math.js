// mobile-app/www/app/17-invoice-math.js — split from mobile-app/www/index.html's <script> (helpers/sourceParts.js reconstructs the original)
// ── THE CHAIN, FROM A SCALE TICKET TO AN AMOUNT ───────────────────────────
// Apsara, 2026-09-16: "When i change the gross,tare,box,container wight is
// invoice tab,corresponding net weight in mt,lbs should be computed auto so
// as rate."
//
//   gross - (truck + container tare + chassis + boxes) = NET LBS
//   net lbs / 2204.62                                  = QTY MT
//   qty x rate                                         = AMOUNT
//
// Same three lines as dashboard/documents.html, deliberately: one invoice
// corrected on a phone and the same one corrected on the website must reach
// the same total, and a second rule written slightly differently is how they
// stop doing that.
//
// ONLY ON AN EDIT, never on render. Opening an invoice from March must not
// restate its tonnage because 2204.62 disagrees with the figure her sheet
// carried.
const INVW_LBS_PER_MT = 2204.62;

// ── ONE UNIT PER INVOICE (2026-09-23) ─────────────────────────────────────
// Ported from dashboard/documents.html, where this was fixed first. The
// phone was still converting every quantity to MT unconditionally while
// leaving the rate exactly as typed, which is what billed 260831_SU_26EM05
// at 22.571 x $0.58 = $13.09 for a container worth $28,860.80.
//
// The rate is NOT converted here either, and that is deliberate rather than
// unfinished: nothing on screen says which unit a typed rate is already in,
// so converting it would be a guess applied to money. Instead the row has
// ONE unit and the quantity is written in it. In pounds nothing converts at
// all, so 49,760 x 0.58 = 28,860.80 multiplies out exactly.
// ── READING A TYPED MONEY FIGURE ──────────────────────────────────────────
// Identical to invMoney in dashboard/documents.html. Returns null — NOT 0 —
// when there is no number in the text, because "zero" and "I could not read
// that" must not be the same answer. An input type=number holding "-$205"
// returns the EMPTY STRING from .value while still showing what was typed,
// which is how a filled-in freight deduction reached neither the total nor
// the PDF on 260923_MC_26MK80.
function invwMoney(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || /-/.test(s);
  const digits = s.replace(/[^0-9.]/g, '');
  if (!digits || !/[0-9]/.test(digits)) return null;
  const n = parseFloat(digits);
  if (!isFinite(n)) return null;
  return neg ? -n : n;
}

const invwUnits = () => (($('invw_units') || {}).value === 'mt' ? 'mt' : 'lb');

// Which unit an EXISTING invoice was written in. Reopening March's invoice
// must not re-head its tonnes as pounds, so the saved value wins; when the
// document predates the units field, the quantity is compared against the
// net it was derived from and whichever it is nearer to, proportionally,
// is the answer.
function invwUnitsOfData(data) {
  const u = String((data && data.units) || '').trim().toLowerCase();
  if (u === 'lb' || u === 'mt') return u;

  const n = (v) => Number(String(v == null ? '' : v).replace(/,/g, ''));
  for (const it of ((data && data.line_items) || [])) {
    const qty = Number(it && it.weight);
    if (!isFinite(qty) || qty <= 0) continue;
    const p = (it && it.packing) || {};
    const stated = n(p.net_weight_lbs), gross = n(p.gross_weight_lbs);
    let net = isFinite(stated) && stated > 0 ? stated : null;
    if (net == null && isFinite(gross) && gross > 0) {
      const tare = ['truck_lbs', 'container_tare_lbs', 'chassis_lbs', 'boxes_weight_lbs']
        .map((k) => n(p[k])).filter((x) => isFinite(x)).reduce((a, b) => a + b, 0);
      net = gross - tare;
    }
    if (net == null || !(net > 0)) continue;
    const asLb = Math.abs(qty - net) / net;
    const asMt = Math.abs(qty - net / INVW_LBS_PER_MT) / (net / INVW_LBS_PER_MT);
    return asLb <= asMt ? 'lb' : 'mt';
  }
  // Her rule, 2026-09-22 — "normally mt will be within 100" — read in
  // reverse: a quantity that small cannot be pounds of scrap in a container,
  // so it is tonnes. Anything larger is pounds.
  const first = Number((((data && data.line_items) || [])[0] || {}).weight);
  return (isFinite(first) && first > 0 && first <= 100) ? 'mt' : 'lb';
}

// The two column headings that name a unit. Updated live, because the select
// sits above a table that is not re-rendered when it changes.
function invwSyncUnitHeads() {
  const lb = invwUnits() === 'lb';
  const q = $('invwQtyHead'), r = $('invwRateHead');
  if (q) q.textContent = lb ? 'Qty lbs' : 'Qty MT';
  if (r) r.textContent = lb ? 'Rate US$/lb' : 'Rate US$/MT';
}

const invwNumOf = (el) => {
  const v = parseFloat(String((el && el.value) || '').replace(/,/g, '').trim());
  return isFinite(v) ? v : null;
};
function invwRowNetLbs(row) {
  const gross = invwNumOf(row.querySelector('.invw-p-gross'));
  if (gross == null) return null;   // null, not 0 — a zero net is a claim
  const tare = ['.invw-p-truck', '.invw-p-tare', '.invw-p-chassis', '.invw-p-boxes']
    .map((sel) => invwNumOf(row.querySelector(sel)))
    .filter((n) => n != null)
    .reduce((a, b) => a + b, 0);
  return gross - tare;
}

function wireInvStep3() {
  const money = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const recalc = () => {
    let subtotal = 0;
    $('invwItems').querySelectorAll('.invw-item').forEach(row => {
      const amt = (parseFloat(row.querySelector('.invw-weight').value) || 0) * (parseFloat(row.querySelector('.invw-rate').value) || 0);
      subtotal += amt;
      row.querySelector('.invw-amount').textContent = '$' + money(amt);
    });
    let notesTotal = 0;
    $('invwNotes').querySelectorAll('.invw-note').forEach(row => { notesTotal += invwMoney(row.querySelector('.invw-note-amount').value) || 0; });
    $('invwTotals').innerHTML = `
      <div style="display:flex; justify-content:space-between; color:var(--text-muted);"><span>Subtotal</span><span>$${money(subtotal)}</span></div>
      ${notesTotal ? `<div style="display:flex; justify-content:space-between; color:var(--text-muted); margin-top:4px;"><span>Adjustments</span><span>$${money(notesTotal)}</span></div>` : ''}
      <div style="display:flex; justify-content:space-between; margin-top:8px; padding-top:8px; border-top:1px solid var(--border-subtle); color:var(--text-strong); font-weight:700;"><span>Total</span><span>$${money(subtotal + notesTotal)}</span></div>`;
  };
  const wireNoteDel = () => $('invwNotes').querySelectorAll('.invw-note-del').forEach(b => b.addEventListener('click', () => { b.closest('.invw-note').remove(); recalc(); }));

  // ── REFRESH FROM THE ORDER SHEET ───────────────────────────────────────
  // The same endpoint this review was OPENED with, for the same containers:
  // a merged booking must refresh as a merge, or the second container quietly
  // disappears from an invoice whose header still names it.
  //
  // "Rows only" rebuilds the table from the response and re-renders the whole
  // screen from a data object carrying the NEW line items and the OLD header —
  // this screen is rendered from invw.data in one pass, so patching the table
  // in place would leave the two disagreeing about what is on the invoice.
  const refreshFetch = async () => {
    const src = invw.source;
    if (!src || !src.containers || !src.containers.length) throw new Error('nothing to refresh — open a container first');
    return src.multi
      ? api('/api/invoice/preview-multi?containers=' + encodeURIComponent(src.containers.join(',')))
      : api('/api/invoice/preview?container=' + encodeURIComponent(src.containers[0]));
  };
  const doRefresh = async (scope) => {
    $('invwRefreshChoice').classList.add('hidden');
    $('invwRefreshStatus').textContent = 'Fetching…';
    try {
      const fresh = await refreshFetch();
      // Read back what she has typed BEFORE re-rendering, or "rows only"
      // loses the very edits it exists to protect.
      const keep = {
        inv_no: $('invw_no').value, inv_date: $('invw_date').value,
        consignee_address: String($('invw_address').value || '').split('\n'),
        notes: Array.from($('invwNotes').querySelectorAll('.invw-note')).map((r) => ({
          label: r.querySelector('.invw-note-label').value.trim(),
          amount: invwMoney(r.querySelector('.invw-note-amount').value) || 0,
        })).filter((n) => n.label && n.amount !== 0),
      };
      invw.data = scope === 'all' ? fresh : { ...invw.data, line_items: fresh.line_items || [], ...keep };
      renderInvFlow();
      const n = ((invw.data.line_items) || []).length;
      if ($('invwRefreshStatus')) $('invwRefreshStatus').textContent = `Refreshed — ${n} line${n === 1 ? '' : 's'} from the sheet.`;
    } catch (e) {
      // The screen still holds everything she typed, and saying so matters: a
      // refresh that fails quietly reads as one that worked.
      $('invwRefreshStatus').textContent = `Could not refresh: ${e.message}. Nothing changed.`;
    }
  };
  if ($('btnInvwRefresh')) $('btnInvwRefresh').addEventListener('click', () => {
    $('invwRefreshStatus').textContent = '';
    $('invwRefreshChoice').classList.toggle('hidden');
  });
  if ($('btnInvwRefreshRows')) $('btnInvwRefreshRows').addEventListener('click', () => doRefresh('rows'));
  if ($('btnInvwRefreshAll')) $('btnInvwRefreshAll').addEventListener('click', () => doRefresh('all'));
  if ($('btnInvwRefreshCancel')) $('btnInvwRefreshCancel').addEventListener('click', () => $('invwRefreshChoice').classList.add('hidden'));
  // Includes the packing inputs, which don't affect totals but keep the
  // recalc harmless — cheaper than maintaining a second, narrower selector
  // that would silently stop matching if a column is ever added.
  // A weight column changed: net lbs, then the quantity IN THIS INVOICE'S
  // UNIT, then the amount. Only the two derived boxes are rewritten, so the
  // caret stays where she is typing.
  //
  // This line used to divide by 2204.62 unconditionally while the rate box
  // kept whatever she had typed, which is cents per POUND — see the note on
  // invwUnits. In pounds nothing is converted, so the printed figures
  // multiply out exactly.
  const recalcWeights = (row) => {
    const net = invwRowNetLbs(row);
    row.querySelector('.invw-p-net').value = net == null ? '' : net.toLocaleString('en-US');
    row.querySelector('.invw-weight').value = net == null ? ''
      : (invwUnits() === 'lb' ? String(Math.round(net * 100) / 100)
                              : (net / INVW_LBS_PER_MT).toFixed(3));
    recalc();
  };
  // Changing the unit re-heads the columns and rewrites every quantity that
  // has a net to derive from. A row she typed a quantity into by hand and
  // never gave weights to is left alone — there is nothing to convert it
  // from, and silently rescaling a number she typed is the same class of
  // mistake as the bug this fixes.
  if ($('invw_units')) $('invw_units').addEventListener('change', () => {
    invwSyncUnitHeads();
    $('invwItems').querySelectorAll('.invw-item').forEach((row) => {
      if (invwRowNetLbs(row) != null) recalcWeights(row);
    });
    recalc();
  });
  invwSyncUnitHeads();
  $('docBody').querySelectorAll('#invwItems input, #invwNotes input').forEach(inp => inp.addEventListener('input', recalc));
  $('invwItems').querySelectorAll('.invw-item').forEach((row) => {
    for (const sel of ['.invw-p-gross', '.invw-p-truck', '.invw-p-tare', '.invw-p-chassis', '.invw-p-boxes']) {
      const el = row.querySelector(sel);
      if (el) el.addEventListener('input', () => recalcWeights(row));
    }
  });
  wireNoteDel();
  recalc();

  $('btnInvAddNote').addEventListener('click', () => {
    const div = document.createElement('div');
    div.className = 'invw-note';
    div.style.cssText = 'display:grid; grid-template-columns:1fr 104px auto; gap:6px; align-items:center;';
    div.innerHTML = `<input class="invw-note-label" placeholder="e.g. Less: Freight"><input class="invw-note-amount" type="text" inputmode="decimal"><button type="button" class="btn btn-danger invw-note-del" style="padding:6px 9px; font-size:10px;">✕</button>`;
    $('invwNotes').appendChild(div);
    div.querySelectorAll('input').forEach(inp => inp.addEventListener('input', recalc));
    div.querySelector('.invw-note-del').addEventListener('click', () => { div.remove(); recalc(); });
  });

  if ($('btnInvQueueCancel')) $('btnInvQueueCancel').addEventListener('click', async () => {
    const left = invw.queue.length - invw.queueIndex;
    if (left > 1 && !await askYesNo(`Stop the batch? ${left - 1} invoice${left - 1 === 1 ? '' : 's'} still to review.\n\nAnything already generated is saved and unaffected.`)) return;
    invw.queue = []; invw.queueIndex = 0;
    invw.step = 2; renderInvFlow();
  });
  // Back leaves the whole batch, not just this one — stepping "back" into a
  // half-finished queue with no way to resume would be worse than restarting
  // the selection, which is still ticked on step 2.
  $('btnInvBack3').addEventListener('click', () => { invw.queue = []; invw.queueIndex = 0; invw.step = 2; renderInvFlow(); });
  $('btnInvPreview').addEventListener('click', () => invSubmit(true));
  $('btnInvGenerate').addEventListener('click', () => invSubmit(false));
}

async function invSubmit(preview) {
  const payload = invCollectPayload();
  const msg = $('invMsg');
  if (!payload.inv_no || !payload.line_items.length) {
    msg.style.color = 'var(--status-danger)';
    msg.textContent = 'Invoice No and at least one item are required.';
    return;
  }
  const btn = preview ? $('btnInvPreview') : $('btnInvGenerate');
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = preview ? 'Building…' : 'Generating…';
  msg.textContent = '';
  try {
    if (preview) {
      const res = await fetch(API_BASE + '/api/invoice/generate?preview=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await docErrText(res));
      const blob = await res.blob();
      if (!blob.size) throw new Error('the server returned an empty PDF');
      await deliverExportedFile(blob, `invoice-preview-${payload.inv_no.replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`, 'pdf');
    } else {
      // ── THE QUANTITY MUST AGREE WITH THE WEIGHTS ──────────────────
      // Mirrors dashboard/documents.html. The CHECK is on the server, in
      // helpers/invoiceWeights.js, and there is exactly one of it — the two
      // screens only render what it found and ask. 260918_AP_26ARIS02 went
      // to the buyer stating 15,642 MT where the packing list says 7.095.
      let result;
      try {
        result = await api('/api/invoice/generate', { method: 'POST', body: JSON.stringify(payload) });
      } catch (e) {
        if (e.code !== 'WEIGHT_MISMATCH') throw e;
        const lines = (e.problems || []).map((p2) =>
          `Row ${p2.row}${p2.item ? ' (' + p2.item + ')' : ''}: ${p2.why}`).join('\n\n');
        if (!confirm(`${e.message}\n\n${lines}\n\nGenerate it anyway?`)) {
          msg.style.color = 'var(--status-warn, #d98324)';
          msg.textContent = 'Not generated — the Quantity column disagrees with the packing weights.';
          btn.disabled = false; btn.textContent = label;
          return;
        }
        result = await api('/api/invoice/generate',
          { method: 'POST', body: JSON.stringify({ ...payload, weights_ok: true }) });
      }
      msg.style.color = 'var(--status-success, #3fae55)';
      msg.textContent = '✓ Generated and saved.';
      if (result && result.saved_filename) {
        await docShareSaved('invoice', result.saved_filename, payload.inv_no, payload.container_no);
      }
      // Mid-batch: move to the next group rather than stranding you on a
      // screen you've finished with. The pause is so the success line is
      // actually readable before the form repopulates underneath it.
      if (invw.queue.length > 0) {
        btn.disabled = false; btn.textContent = label;
        await new Promise(r => setTimeout(r, 900));
        invw.queueIndex++;
        await loadNextInvGroup();
        return;
      }
    }
  } catch (err) {
    msg.style.color = 'var(--status-danger)';
    msg.textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}


