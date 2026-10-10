// dashboard/app/10-shipments-import.js — split from dashboard/index.html's <script> (helpers/sourceParts.js reconstructs the original)
let importFile = null;      // { name, base64 }
let importPreview = null;   // the last preview, or null

async function openImportModal(kind) {
  const L = LEDGER_LIGHT;
  importFile = null; importPreview = null;
  const fieldCss = `width:100%; height:34px; padding:0 10px; background:${L.paper}; border:1px solid ${L.line}; border-radius:var(--radius-sm); color:${L.ink}; outline:none; font-size:13px;`;
  const lab = `display:block; font-size:11px; color:${L.inkMuted}; margin-bottom:5px;`;

  document.body.insertAdjacentHTML('beforeend', `
    <div id="impModal" style="position:fixed; inset:0; background:rgba(0,0,0,.66); z-index:9100; display:flex; align-items:flex-start; justify-content:center; overflow-y:auto; padding:32px 16px;">
      <div class="card" style="width:min(940px,100%); padding:20px 22px 18px; background:${L.sunken}; border-color:${L.line};">
        <div style="display:flex; align-items:baseline; justify-content:space-between; margin-bottom:6px;">
          <h3 style="margin:0; font-size:16px; text-transform:none; color:${L.ink};">Import a shipments workbook</h3>
          <button id="impClose" aria-label="Close" title="Close (Esc)" style="background:none; border:none; color:${L.inkMuted}; font-size:22px; line-height:1; cursor:pointer;">&times;</button>
        </div>
        <div style="font-size:12px; color:${L.inkFaint}; margin-bottom:16px; line-height:1.55;">
          The <b>Shipments</b> tab becomes purchase <b>Bills</b>; <b>Order Details</b> becomes <b>Invoices</b>.
          One upload does both — there is no need to come back and do it again from the other screen.
        </div>
        <div id="impBody"></div>
      </div>
    </div>`);

  const close = () => { const m = $('impModal'); if (m) m.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  $('impClose').onclick = close;
  $('impModal').addEventListener('click', (e) => { if (e.target.id === 'impModal') close(); });

  // ── STEP ONE: THE FILE ────────────────────────────────────────────────
  function step1(err) {
    $('impBody').innerHTML = `
      ${err ? `<div style="margin-bottom:12px; padding:9px 12px; border:1px solid ${L.danger}; border-radius:var(--radius-sm); font-size:12px; color:${L.danger};">${esc(err)}</div>` : ''}
      <div id="impDrop" style="border:1px dashed ${L.line}; border-radius:var(--radius-sm); background:${L.paper}; padding:26px; text-align:center; cursor:pointer;">
        <div id="impDropLabel" style="font-size:13px; color:${L.inkMuted};">Drop the .xlsx here, or click to choose one</div>
      </div>
      <input type="file" id="impInput" accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" style="display:none;">

      <!-- ── WHERE THE REAL DATA STOPS ──────────────────────────────────
           Apsara, 2026-09-19: "till 665 rows only to beconsidered" and "in
           order details-till row 649 should be there". Both sheets have
           working space underneath.

           Left BLANK on purpose. 665 and 649 are true of the file she sent
           on the 19th and will not be true of the next one, and a prefilled
           number that has quietly gone stale is worse than an empty box —
           it would silently drop real rows off the end. The preview says
           which rows it actually read, so a wrong answer here is visible
           before anything is written. -->
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:16px;">
        <div><label style="${lab}">Shipments — last row to read</label>
          <input id="impShipLast" inputmode="numeric" placeholder="blank = to the end" style="${fieldCss}"></div>
        <div><label style="${lab}">Order Details — last row to read</label>
          <input id="impOrdLast" inputmode="numeric" placeholder="blank = to the end" style="${fieldCss}"></div>
      </div>
      <div style="font-size:11px; color:${L.inkFaint}; margin-top:7px; line-height:1.5;">
        Only if the sheet has working notes below the real data. Leave both blank and everything is read;
        the preview always says which rows it used.
      </div>

      <div style="border-top:1px solid ${L.line}; padding-top:14px; margin-top:16px; display:flex; align-items:center; gap:10px;">
        <span id="impNote" style="flex:1; font-size:11px; color:${L.inkFaint};">Nothing is written until you have seen the preview.</span>
        <button id="impCancel" class="btn btn-secondary" style="font-size:12px; padding:8px 14px;">Cancel</button>
        <button id="impPreview" class="btn btn-primary" style="font-size:12px; padding:8px 16px;" disabled>Preview</button>
      </div>
      <div id="impBatches" style="margin-top:18px;"></div>`;

    const take = (f) => {
      if (!f) return;
      if (!/\.xlsm?x?$/i.test(f.name)) return step1('That is not a spreadsheet — an .xlsx is expected.');
      const r = new FileReader();
      r.onload = () => {
        importFile = { name: f.name, base64: String(r.result).split(',')[1] };
        $('impDropLabel').innerHTML = `<b style="color:${L.ink};">${esc(f.name)}</b> — ${(f.size / 1048576).toFixed(1)} MB, ready`;
        $('impPreview').disabled = false;
      };
      r.readAsDataURL(f);
    };
    $('impDrop').onclick = () => $('impInput').click();
    $('impInput').onchange = () => take($('impInput').files[0]);
    $('impDrop').addEventListener('dragover', (e) => e.preventDefault());
    $('impDrop').addEventListener('drop', (e) => { e.preventDefault(); take(e.dataTransfer.files[0]); });
    $('impCancel').onclick = close;
    $('impPreview').onclick = doPreview;
    loadBatches();
  }

  const lastRows = () => ({
    shipments_last_row: Number($('impShipLast').value) || undefined,
    orders_last_row: Number($('impOrdLast').value) || undefined,
  });
  let chosenRows = {};

  async function doPreview() {
    const btn = $('impPreview');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Reading…';
    chosenRows = lastRows();
    try {
      importPreview = await api('/api/import/preview', { method: 'POST', body: JSON.stringify({
        file_base64: importFile.base64, filename: importFile.name, ...chosenRows }) });
      step2();
    } catch (e) {
      step1(e.message || 'Could not read that file.');
    }
  }

  const n = (v) => Number(v || 0).toLocaleString('en-US');
  const card = (label, value, warn) => `
    <div class="card" style="padding:11px; background:${L.paper}; border-color:${warn && value ? L.warn : L.line};">
      <div style="font-family:var(--font-mono); font-size:9px; letter-spacing:.12em; text-transform:uppercase; color:${L.inkMuted};">${label}</div>
      <div style="font-size:17px; font-weight:700; margin-top:4px; color:${warn && value ? L.warn : L.ink};">${n(value)}</div>
    </div>`;
  const fold = (title, count, inner) => (count ? `
    <details style="margin-top:10px; border:1px solid ${L.line}; border-radius:var(--radius-sm); background:${L.paper};">
      <summary style="padding:9px 12px; cursor:pointer; font-size:12px; color:${L.inkMuted};">${title} <b style="color:${L.ink};">${n(count)}</b></summary>
      <div style="padding:0 12px 12px; max-height:280px; overflow:auto;">${inner}</div>
    </details>` : '');
  const table = (heads, rows) => `
    <table style="width:100%; border-collapse:collapse; font-size:11.5px;">
      <thead><tr>${heads.map((h) => `<th style="text-align:left; padding:5px 7px; font-size:10px; color:${L.inkMuted}; font-weight:400; position:sticky; top:0; background:${L.paper};">${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody></table>`;
  const tr = (cells) => `<tr style="border-top:1px solid ${L.lineSoft};">${cells.map((c) => `<td style="padding:5px 7px; color:${L.ink}; vertical-align:top;">${c}</td>`).join('')}</tr>`;

  // ── STEP TWO: WHAT IT WOULD DO ────────────────────────────────────────
  function step2() {
    const p = importPreview;
    const s = p.summary || {};
    const sh = (p.sheets || {}).shipments, or = (p.sheets || {}).orders;
    const already = p.already_imported || [];
    const range = (x) => {
      if (!x) return '<b style="color:' + L.danger + ';">that sheet was not found</b>';
      return x.lastRow
        ? `${esc(x.name)}, rows 2–${n(x.lastRow)}${x.rowsBelowLastRow ? ` (${n(x.rowsBelowLastRow)} below that line ignored)` : ''}`
        : `${esc(x.name)}, all ${n(x.dataRows)} rows`;
    };
    // A column that moved or got renamed does not fail — the field simply
    // arrives empty on every row, which is invisible in a total. Said out
    // loud, because it is the one thing here that looks like success.
    const shortCols = [sh, or].filter((x) => x && x.headersMatched < x.headersTotal);

    $('impBody').innerHTML = `
      <div style="padding:9px 12px; border:1px solid ${L.line}; border-radius:var(--radius-sm); background:${L.paper}; font-size:12px; color:${L.ink}; margin-bottom:12px;">
        <b>Nothing has been written.</b> This is what the import would create.
      </div>

      ${already.length ? `<div style="margin-bottom:12px; padding:10px 12px; border:1px solid ${L.warn}; border-radius:var(--radius-sm); font-size:12px; color:${L.warn}; line-height:1.55;">
        <b>“${esc(importFile.name)}” has been imported before</b> — ${already.map((a) => `${n(a.rows)} rows on ${esc(String(a.at || '').slice(0, 10))}`).join('; ')}.
        Importing it again <b>doubles every row</b>, and the two copies are not distinguishable on the screen afterwards.
        Undo the earlier import first, or tick the box below if this really is meant to go in twice.
      </div>` : ''}

      <div style="display:grid; grid-template-columns:repeat(5,1fr); gap:8px;">
        ${card('Bills', s.bills)}
        ${card('Invoices', s.sales)}
        ${card('Refused', s.refused, true)}
        ${card('Rows skipped', s.rows_skipped)}
        ${card('Unreadable values', s.unreadable_values, true)}
      </div>
      ${s.bills_advance ? `<div style="margin-top:12px; padding:9px 12px; border:1px solid ${L.line}; border-radius:var(--radius-sm); background:${L.paper}; font-size:12px; color:${L.ink}; line-height:1.55;">
        Your <b>Advance /Trucking</b> column holds both: <b>${n(s.bills_trucking)}</b> read as trucking, <b>${n(s.bills_advance)}</b> as advances paid to the supplier, split at <b>$${n(s.advance_over)}</b>.
        ${(p.near_threshold || []).length
          ? `<span style="color:${L.warn};">${n((p.near_threshold || []).length)} figure${(p.near_threshold || []).length === 1 ? ' sits' : 's sit'} close to that line — worth a look: `
            + (p.near_threshold || []).slice(0, 6).map((x) => `${esc(x.container)} $${n(x.amount)} → ${esc(x.treated_as)}`).join('; ') + '</span>'
          : 'Nothing sits near that line in this file.'}
      </div>` : ''}

      <div style="font-size:11px; color:${L.inkFaint}; margin-top:9px; line-height:1.6;">
        Read ${range(sh)} and ${range(or)}.
        ${s.bills_multi_grade ? `${n(s.bills_multi_grade)} containers had several grades and became one bill each. ` : ''}
        ${s.bills_local_delivery ? `${n(s.bills_local_delivery)} had no container — local deliveries, imported and marked as such. ` : ''}
        ${s.cancelled_orders ? `${n(s.cancelled_orders)} cancelled or replaced orders were left out.` : ''}
      </div>

      ${shortCols.length ? `<div style="margin-top:14px; padding:10px 12px; border:1px solid ${L.warn}; border-radius:var(--radius-sm); font-size:12px; color:${L.warn}; line-height:1.55;">
        ${shortCols.map((x) => `Only ${n(x.headersMatched)} of the ${n(x.headersTotal)} expected columns were found in <b>${esc(x.name)}</b>`).join('; ')}.
        The missing ones import as blank on every row — which does not fail, and does not show up in any total. Worth checking a heading was not renamed before importing.
      </div>` : ''}

      ${(p.refused || []).length ? `<div style="margin-top:14px; padding:10px 12px; border:1px solid ${L.warn}; border-radius:var(--radius-sm); font-size:12px; color:${L.warn};">
        ${n((p.refused || []).length)} row${(p.refused || []).length === 1 ? '' : 's'} would be refused and <b>not imported</b>. They are listed below with the spreadsheet row, so they can be fixed and the file uploaded again.
      </div>` : ''}

      ${fold('Refused rows', (p.refused || []).length, table(['Row', 'Kind', 'Which', 'Why'],
        (p.refused || []).map((r) => tr([esc((r.rows || []).join(', ')), esc(r.kind),
          esc(r.container || r.invoice_no || r.supplier || r.customer || ''), esc(r.why)]))))}

      ${fold('Rows skipped — with what is actually in them', (p.skipped || []).length, table(['Sheet', 'Row', 'Why', 'What is in the row'],
        (p.skipped || []).slice(0, 150).map((r) => tr([esc(r.sheet), esc(r.row), esc(r.why),
          `<span style="color:${L.inkFaint};">${esc((r.content || []).join(' · ') || '(every cell empty)')}</span>`]))))}

      ${fold('Cancelled and replaced orders — left out', (p.cancelled || []).length, table(['Row', 'Invoice', 'Customer', 'What the row says'],
        (p.cancelled || []).map((c) => tr([esc(c.row), esc(c.invoice_no), esc(c.customer), esc(c.marker)]))))}

      ${fold('Values it could not read — the row still imports, that one value does not', (p.problems || []).length, table(['Sheet', 'Row', 'Field', 'What is there'],
        (p.problems || []).slice(0, 100).map((x) => tr([esc(x.sheet), esc(x.row), esc(x.field), esc(x.why)]))))}

      ${fold('Invoice totals that disagree with weight × price — reported, never corrected', (p.mismatches || []).length, table(['Row', 'Invoice', 'Sheet says', 'weight × price', 'Difference'],
        (p.mismatches || []).slice(0, 80).map((m) => tr([esc(m.row), esc(m.invoice_no), esc(m.sheet_says), esc(m.weight_x_price), esc(m.difference)]))))}

      ${fold('A sample of each kind, exactly as it would be stored', 1, `<pre style="font-size:10.5px; color:${L.ink}; white-space:pre-wrap; margin:10px 0 0;">${esc(JSON.stringify(p.samples || {}, null, 1))}</pre>`)}

      <div style="border-top:1px solid ${L.line}; padding-top:14px; margin-top:16px; display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
        ${already.length ? `<label style="font-size:11.5px; color:${L.warn}; display:flex; align-items:center; gap:6px; cursor:pointer;">
          <input type="checkbox" id="impForce"> Yes — import it a second time anyway</label>` : ''}
        <span style="flex:1;"></span>
        <button id="impBack" class="btn btn-secondary" style="font-size:12px; padding:8px 14px;">Choose another file</button>
        <button id="impGo" class="btn btn-primary" style="font-size:12px; padding:8px 16px;" ${already.length ? 'disabled' : ''}>Import ${n(s.bills)} bills and ${n(s.sales)} invoices</button>
      </div>
      <div id="impErr"></div>`;

    $('impBack').onclick = () => { importFile = null; importPreview = null; step1(); };
    if ($('impForce')) $('impForce').onchange = (e) => { $('impGo').disabled = !e.target.checked; };
    $('impGo').onclick = doCommit;
  }

  // ── STEP THREE: WRITE IT ──────────────────────────────────────────────
  async function doCommit() {
    const btn = $('impGo');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Importing…';
    try {
      // The file is sent AGAIN rather than the preview's rows being written.
      // The server re-reads the same bytes through the same reader, so what
      // lands is produced by the code that produced the preview — a preview
      // whose rows were shipped back to be written could be edited on the way.
      const r = await api('/api/import/commit', { method: 'POST', body: JSON.stringify({
        file_base64: importFile.base64, filename: importFile.name, ...chosenRows,
        force: !!($('impForce') && $('impForce').checked) }) });
      step3(r);
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Try again';
      $('impErr').innerHTML = `<div style="margin-top:12px; padding:10px 12px; border:1px solid ${L.danger}; border-radius:var(--radius-sm); font-size:12px; color:${L.danger}; line-height:1.55;">${esc(e.message || 'The import failed.')}</div>`;
    }
  }

  function step3(r) {
    $('impBody').innerHTML = `
      <div style="padding:14px 16px; border:1px solid ${L.ok}; border-radius:var(--radius-sm); background:${L.paper};">
        <div style="font-size:15px; color:${L.ink}; font-weight:600;">Imported.</div>
        <div style="font-size:12.5px; color:${L.inkMuted}; margin-top:6px; line-height:1.6;">
          ${n(r.bills)} bills and ${n(r.sales)} invoices from ${esc(r.source || importFile.name)}.
          ${r.refused ? `${n(r.refused)} rows were refused and are not in.` : ''}
        </div>
        <div style="font-family:var(--font-mono); font-size:10.5px; color:${L.inkFaint}; margin-top:8px;">${esc(r.batch)}</div>
      </div>
      <div style="border-top:1px solid ${L.line}; padding-top:14px; margin-top:16px; display:flex; align-items:center; gap:10px;">
        <span style="flex:1; font-size:11px; color:${L.inkFaint};">
          Undo removes exactly these rows and nothing that was typed by hand. It needs the Jarvis profile.
        </span>
        <button id="impUndo" class="btn btn-secondary" style="font-size:12px; padding:8px 14px; color:${L.danger};">Undo this import</button>
        <button id="impDone" class="btn btn-primary" style="font-size:12px; padding:8px 16px;">Done</button>
      </div>
      <div id="impErr"></div>`;
    $('impDone').onclick = () => { close(); renderLedgerTab(kind); };
    if ($('impUndo')) $('impUndo').onclick = () => undoBatch(r.batch, $('impUndo'));
  }

  async function undoBatch(batch, btn) {
    if (!confirm(`Remove every row that came from this import?\n\n${batch}\n\nRows typed by hand are not touched.`)) return;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Undoing…';
    try {
      const r = await api('/api/import/' + encodeURIComponent(batch), { method: 'DELETE' });
      $('impBody').innerHTML = `<div style="padding:14px 16px; border:1px solid ${L.line}; border-radius:var(--radius-sm); background:${L.paper}; font-size:13px; color:${L.ink};">
          Undone — ${n(r.removed)} rows removed.</div>
        <div style="border-top:1px solid ${L.line}; padding-top:14px; margin-top:16px; text-align:right;">
          <button id="impDone2" class="btn btn-primary" style="font-size:12px; padding:8px 16px;">Done</button></div>`;
      $('impDone2').onclick = () => { close(); renderLedgerTab(kind); };
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Undo this import';
      $('impErr').innerHTML = `<div style="margin-top:12px; padding:10px 12px; border:1px solid ${L.danger}; border-radius:var(--radius-sm); font-size:12px; color:${L.danger};">${esc(e.message || 'Could not undo.')}</div>`;
    }
  }

  // ── WHAT HAS BEEN IMPORTED BEFORE ─────────────────────────────────────
  // On the first screen, because "have I already done this?" is the question
  // that decides whether to upload at all. Failure is silent: not knowing the
  // history must not stop her importing.
  async function loadBatches() {
    const el = $('impBatches');
    if (!el) return;
    let batches;
    try {
      ({ batches } = await api('/api/import/batches'));
    } catch (e) {
      // ── NOT SILENT ANY MORE ──────────────────────────────────────────
      // Apsara, 2026-09-19: "undo not there in jarvis profile". It was not
      // the gate — a Jarvis session is role=admin and super=true and both
      // routes answer 200. It was this function, which used to swallow every
      // failure "so that not knowing the history does not stop her
      // importing". That reasoning is right for a decoration and wrong for
      // the ONLY WAY OUT of a bad import: the section simply did not appear,
      // and there was nothing on screen to say why.
      el.innerHTML = `<div style="font-size:11px; color:${L.warn};">Could not load the list of past imports — ${esc(e.message || 'no reason given')}. Reload and try again.</div>`;
      return;
    }
    if (!batches || !batches.length) {
      // "Nothing has been imported" and "the list failed" have to look
      // different, or the absence of an Undo button means nothing.
      el.innerHTML = `<div style="font-size:11px; color:${L.inkFaint};">No imports on record yet.</div>`;
      return;
    }
    {
      el.innerHTML = `
        <div style="font-size:11px; color:${L.inkFaint}; margin-bottom:6px;">Imported before</div>
        <div style="border:1px solid ${L.line}; border-radius:var(--radius-sm); background:${L.paper}; max-height:170px; overflow:auto;">
          ${batches.map((b) => `
            <div style="display:flex; align-items:center; gap:10px; padding:7px 10px; border-bottom:1px solid ${L.lineSoft}; font-size:11.5px;">
              <span style="color:${L.inkMuted}; font-family:var(--font-mono);">${esc(String(b.at || '').slice(0, 10))}</span>
              <span style="color:${L.ink}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(b.source || '')}</span>
              <span style="flex:1;"></span>
              <span style="color:${L.inkFaint}; white-space:nowrap;">${n(b.bills)} bills · ${n(b.sales)} invoices</span>
              <!-- ── ALWAYS DRAWN ────────────────────────────────────
                   This was behind metalsCanDelete(), which reads IS_SUPER —
                   a value the page fetches once at boot and that is wrong
                   the moment anything about that fetch goes wrong. When it
                   is wrong, the only route back out of a bad import
                   disappears with no explanation, which is what happened.

                   The REAL gate is the route: DELETE /api/import/:batch is
                   requireSuper and answers with a sentence naming the
                   profile. A button that explains why it cannot act beats a
                   button that is not there. -->
              <button class="impUndoRow" data-batch="${esc(b.batch)}" style="background:none; border:1px solid ${L.line}; border-radius:var(--radius-sm); padding:3px 9px; font-size:11px; color:${L.danger}; cursor:pointer; white-space:nowrap;">Undo</button>
            </div>`).join('')}
        </div>`;
      el.querySelectorAll('.impUndoRow').forEach((b) => {
        b.onclick = () => undoBatch(b.dataset.batch, b);
      });
    }
  }

  step1();
}

async function openBillPayForm(opts = {}) {
  const L = LEDGER_LIGHT;
  const data = await api('/api/bill-payments');
  // ── APPLYING CREDIT SHE ALREADY PAID ─────────────────────────────────
  // Her answer when asked whether an advance should apply itself: "I choose
  // when to apply it." So the same form has a second mode. Shipping the
  // advance without this would let credit accumulate with no way to spend
  // it — a number that only ever goes up is not a feature.
  //
  // Applying moves NO money and writes NO ledger row: the cash left the bank
  // on the day of the advance and was counted then. This only attaches it.
  const applying = !!opts.applySupplier;
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const sameSupplier = (a, b) =>
    String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  // Whose money this is. In apply mode the advance decides; otherwise she
  // picked it at the door (openBillPaySupplier below).
  const supplier = applying ? opts.applySupplier : (opts.supplier || null);
  const advances = (data.payments || [])
  // ── ONLY THIS SUPPLIER'S ADVANCES ────────────────────────────────────
  // Apsara, 2026-09-29: "If i select a supplier in pay,Any detail relared to
  // that supplier shoud come only".
  //
  // The containers below were filtered to the chosen supplier on 2026-09-10
  // ("show only related supplier container"). This list was not: the supplier
  // clause applied only in APPLY mode, so paying anyone normally offered the
  // advances of every supplier in the business in one dropdown.
  //
  // Not dangerous — helpers/billPayments.applyAdvance binds to the advance's
  // OWN supplier and throws on a mismatch, so the server was never going to
  // write it. It is worse than that in a quiet way: she picks the obvious
  // entry, presses save, and gets told off for a choice the screen offered
  // her. A control that offers what the server will refuse is a trap.
  //
  // sameSupplier rather than ===, matching the container filter below. Apply
  // mode was strict and case-sensitive; now the two lists in this one form
  // agree about what counts as the same name, which they did not before.
  .filter((p) => p.kind === 'advance' && sameSupplier(p.supplier, supplier))
    .map((p) => ({ ...p, available: round2(p.amount - (p.allocations || []).reduce((s, a) => s + Number(a.amount || 0), 0)) }))
    .filter((p) => p.available > 0.005);
  // ── ONLY THIS SUPPLIER'S CONTAINERS ──────────────────────────────────
  // Apsara, 2026-09-10: "show only related supplier container which are
  // unpaid/part paid". open_bills is already only the ones with a balance
  // left, so "unpaid/part paid" is the whole list — what was missing is the
  // supplier filter, and it is the same one apply mode has always used.
  const open = (data.open_bills || []).filter((b) => sameSupplier(b.supplier, supplier));

  // ── ASK WHO IS BEING PAID, FIRST ─────────────────────────────────────
  // Apsara, 2026-09-10: "It must ask to select the supplier first."
  //
  // Not merely a nicety. Before this, every open container in the business
  // was on one list with a tick box, so a wire to one supplier could be
  // allocated against another's container — a false statement about who was
  // paid, and it would settle the wrong company's invoice. The server refuses
  // that now too (helpers/billPayments.cleanAllocations); this is the step
  // that means she never gets told off for it.
  if (!applying && !supplier) return openBillPaySupplier(data);
  const banks = data.banks || [];
  const credit = data.credit || {};

  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fieldCss = `width:100%; height:34px; padding:0 10px; background:${L.paper}; border:1px solid ${L.line}; border-radius:var(--radius-sm); color:${L.ink}; outline:none; font-size:13px;`;
  const lab = `display:block; font-size:11px; color:${L.inkMuted}; margin-bottom:5px; white-space:nowrap;`;

  const rows = open.map((b) => `
    <tr data-bill="${esc(b.id)}" style="border-top:1px solid ${L.lineSoft};">
      <td style="padding:6px 8px;"><input type="checkbox" class="bpPick" data-bill="${esc(b.id)}"></td>
      <td style="padding:6px 8px; font-size:12px; color:${L.ink};">${esc(b.supplier || '—')}</td>
      <td style="padding:6px 8px; font-size:12px; color:${L.inkMuted}; font-family:var(--font-mono);">${esc(b.container_no || b.booking_no || '—')}</td>
      <td style="padding:6px 8px; font-size:12px; text-align:right; font-family:var(--font-mono); color:${L.inkMuted}; white-space:nowrap;">${money(b.balance)}${Number(b.paid) > 0 ? `<div style="font-size:10px; color:${L.inkFaint};">${money(b.paid)} paid of ${money(b.amount)}</div>` : ''}</td>
      <td style="padding:6px 8px;">
        <input class="bpAmt" data-bill="${esc(b.id)}" data-balance="${esc(b.balance)}" inputmode="decimal" autocomplete="off"
          style="width:110px; height:28px; padding:0 8px; text-align:right; font-family:var(--font-mono); font-size:12px; background:${L.paper}; border:1px solid ${L.line}; border-radius:var(--radius-sm); color:${L.ink}; outline:none;">
      </td>
    </tr>`).join('');

  // Clickable, because credit she can see and cannot spend is worse than no
  // credit at all — she would pay the same money twice and find out at close.
  // Newest first: the one she wants to undo is almost always the last one
  // she entered, and scrolling a ledger to find it is how the wrong row gets
  // deleted.
  // ── ONLY THIS SUPPLIER'S PAYMENTS ────────────────────────────────────
  // Apsara, 2026-09-29: "If i select a supplier in pay,Any detail relared to
  // that supplier shoud come only".
  //
  // "Already recorded" listed EVERY payment in the business. Having chosen
  // Eccomelt at the door, the history under the form was still Oakland
  // Metals, Calderon and everyone else, newest first — so the row she is most
  // likely to want to delete is buried among other suppliers' money, and the
  // Delete button beside each one is live. That is the arrangement in which a
  // wrong row gets removed.
  //
  // The containers were narrowed on 2026-09-10 ("show only related supplier
  // container"); these two lists were simply never done at the same time.
  const recorded = (data.payments || [])
    .filter((p) => sameSupplier(p.supplier, supplier))
    .slice().reverse();

  // ── AND ONLY THIS SUPPLIER'S CREDIT ──────────────────────────────────
  // Same message. "Credit on hand" printed every supplier holding an advance,
  // each one an "apply" button — so on a form for paying Eccomelt she could
  // press Oakland Metals' credit. helpers/billPayments.applyAdvance binds to
  // the advance's own supplier and throws, so nothing wrong could be written;
  // the defect is a form offering a button the server will refuse.
  //
  // The whole map is still on the Bills tab strip, which is where "who is
  // holding my money" belongs. Here the question is narrower.
  const creditLines = Object.entries(credit)
    .filter(([sup]) => sameSupplier(sup, supplier))
    .map(([sup, amt]) =>
    `<button class="bpApply" data-supplier="${esc(sup)}" style="background:none; border:none; padding:0 2px; cursor:pointer; font-size:11px; color:${L.inkMuted}; text-decoration:underline dotted;">${esc(sup)} <b style="color:${L.ok};">${money(amt)}</b> — apply</button>`).join(' · ');

  document.body.insertAdjacentHTML('beforeend', `
    <div id="bpModal" style="position:fixed; inset:0; background:rgba(0,0,0,.66); z-index:9100; display:flex; align-items:flex-start; justify-content:center; overflow-y:auto; padding:32px 16px;">
      <div class="card" style="width:min(860px,100%); padding:20px 22px 18px; background:${L.sunken}; border-color:${L.line};">
        <!-- ── HEADER, REDESIGNED (2026-10-02) ──────────────────────────────
             Apsara: "it looks not professional and off", pasting what she
             saw: Record a payment - Inesh Cores Chapin change / Paper (specs) x

             THREE LAYOUT FAULTS, no content problem at all:

             1. The row was flex with justify-content:space-between and THREE
                children, so the sheet-colour and text-size controls landed
                in the MIDDLE of the title bar. Reading aids, parked between
                the name of the payment and the close button.
             2. The change button sat INSIDE the h3, six pixels from the
                supplier and inheriting a heading context, so it read as one
                string: "Inesh Cores Chapin change". A supplier called
                "Chapin change" is not a thing, but that is what the line
                said.
             3. The supplier appeared TWICE: in the title and again as a
                readonly field at the end of the grid, repeating what the
                heading already said and unable to be edited either way.

             Now the title owns the first line with the close button, the
             supplier gets a quieter line under it with the change control
             clearly separate, and a rule closes the header off. Nothing is
             removed: the specs button is hers by request and simply moves to
             the footer, where a reading aid belongs. -->
        <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:16px;">
          <div style="min-width:0;">
            <h3 style="margin:0; font-size:17px; font-weight:600; letter-spacing:-.01em; text-transform:none; color:${L.ink};">${applying ? 'Apply advance' : 'Record a payment'}</h3>
            <div style="margin-top:5px; font-size:12.5px; color:${L.inkMuted}; display:flex; align-items:center; gap:9px; flex-wrap:wrap;">
              <span>to <span style="color:${L.ink}; font-weight:500;">${esc(supplier)}</span></span>
              ${applying ? '' : `<button id="bpWhoAgain" title="Switch supplier" style="background:none; border:1px solid ${L.line}; border-radius:var(--radius-sm); padding:1px 9px; font-size:11px; color:${L.inkMuted}; cursor:pointer;">change</button>`}
            </div>
          </div>
          <button id="bpClose" aria-label="Close" title="Close (Esc)" style="background:none; border:none; color:${L.inkMuted}; font-size:22px; line-height:1; cursor:pointer; margin:-2px -4px 0 0;">&times;</button>
        </div>
        <div style="height:1px; background:${L.line}; margin:15px 0 17px;"></div>

        <!-- TWO ROWS, NOT SIX COLUMNS. auto-fit at minmax(140px,1fr) across
             an 860px card put Date / Amount / Method / Bank / Reference /
             Supplier on ONE line: six squashed boxes with nowrap labels,
             which is the run-on she pasted. The two figures that matter,
             when and how much, now get their own row at a readable width;
             how it was sent follows underneath. -->
        <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:13px; margin-bottom:13px;${applying ? 'display:block;' : ''}">
        ${applying ? `<div><label style="${lab}">Which advance</label>
          <select id="bpAdvSel" style="${fieldCss}">${advances.map((a) => `<option value="${esc(a.id)}" data-available="${esc(a.available)}">${esc(a.date)} · ${esc(a.mode)}${a.ref ? ' · ' + esc(a.ref) : ''} · ${money(a.available)} left</option>`).join('')}</select></div>` : ''}
          <div style="${applying ? 'display:none;' : ''}"><label style="${lab}">Date</label><input id="bpDate" placeholder="MM/DD/YYYY" autocomplete="off" style="${fieldCss}"></div>
          <div style="${applying ? 'display:none;' : ''}"><label style="${lab}">Amount sent</label><input id="bpAmount" inputmode="decimal" autocomplete="off" style="${fieldCss} text-align:right; font-family:var(--font-mono);"></div>
        </div>
        <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(175px,1fr)); gap:13px; margin-bottom:15px;">
          <div style="${applying ? 'display:none;' : ''}"><label style="${lab}">Method</label><select id="bpMode" style="${fieldCss}">${(data.modes || []).map((m) => `<option>${esc(m)}</option>`).join('')}</select></div>
          <div id="bpBankField" style="${applying ? 'display:none;' : ''}"><label style="${lab}">Bank</label><select id="bpBank" style="${fieldCss}">${banks.map((b) => `<option>${esc(b)}</option>`).join('')}</select></div>
          <div style="${applying ? 'display:none;' : ''}"><label style="${lab}">Reference</label><input id="bpRef" autocomplete="off" placeholder="wire no" style="${fieldCss}"></div>
          <!-- The supplier is in the subtitle now. The element STAYS: send()
               reads its value, and the tests assert it is readonly. Removing
               it would break both. It is simply no longer a dead box
               repeating the heading. -->
          <div style="display:none;"><label style="${lab}">Supplier</label>
            <input id="bpSupplier" readonly value="${esc(supplier || '')}" tabindex="-1" style="${fieldCss}"></div>
        </div>

        ${applying ? '' : `
        <!-- ── ADVANCE OR AGAINST A BILL (2026-10-02) ────────────────────────
             Apsara: "instead of keeping save as advance as button, Give two
             option to choose from 1.Advance 2.Bill. then straight away record
             payment,cancel."

             A CHOICE rather than two Save buttons. The old shape had the
             decision hidden in which button you pressed, with the container
             table always on screen even for an advance that has no containers.

             NO DEFAULT, deliberately. Record payment stays disabled until she
             picks one. Defaulting to either means a mis-click records money as
             the wrong kind — and an advance recorded as a bill payment carries
             allocations that make containers read as paid, which is the
             expensive direction to be wrong in. -->
        <div style="font-size:12px; color:${L.inkFaint}; margin:16px 0 6px;">What is this payment?</div>
        <div id="bpKindChoice" style="display:flex; gap:8px;">
          <button type="button" class="bpKind" data-kind="advance"
            style="flex:1; padding:11px 14px; border:1px solid ${L.line}; border-radius:var(--radius-sm); background:${L.paper}; color:${L.ink}; font-size:13px; cursor:pointer; text-align:left;">
            <div style="font-weight:500;">Advance</div>
            <div style="font-size:11px; color:${L.inkFaint}; margin-top:2px;">Money up front, no container yet</div>
          </button>
          <button type="button" class="bpKind" data-kind="payment"
            style="flex:1; padding:11px 14px; border:1px solid ${L.line}; border-radius:var(--radius-sm); background:${L.paper}; color:${L.ink}; font-size:13px; cursor:pointer; text-align:left;">
            <div style="font-weight:500;">Against a bill</div>
            <div style="font-size:11px; color:${L.inkFaint}; margin-top:2px;">${open.length
              ? `${open.length} container${open.length === 1 ? '' : 's'} unpaid`
              : `nothing unpaid for ${esc(supplier)}`}</div>
          </button>
        </div>`}

        <!-- Hidden until she chooses "Against a bill". An advance has no
             containers, so showing the table for one is an invitation to
             allocate money that must not be allocated. -->
        <div id="bpBillBlock" ${applying ? '' : 'style="display:none;"'}>
        <div style="display:flex; align-items:baseline; gap:8px; margin:14px 0 6px;">
          <span style="font-size:12px; color:${L.inkFaint};">Which containers does it cover?</span>
          <span style="flex:1;"></span>
          <span id="bpPending" style="font-size:11px; color:${L.inkMuted};">${open.length
            ? `${money(open.reduce((t, b) => t + (Number(b.balance) || 0), 0))} pending across ${open.length} container${open.length === 1 ? '' : 's'}`
            : 'nothing pending'}</span>
        </div>
        <div style="background:${L.paper}; border:1px solid ${L.line}; border-radius:var(--radius-sm); max-height:260px; overflow-y:auto;">
          <table style="width:100%; border-collapse:collapse;">
            <thead><tr style="background:${L.sunken};">
              <th style="padding:6px 8px; width:28px;"></th>
              <th style="padding:6px 8px; text-align:left; font-size:11px; color:${L.inkMuted}; font-weight:400;">Supplier</th>
              <th style="padding:6px 8px; text-align:left; font-size:11px; color:${L.inkMuted}; font-weight:400;">Container</th>
              <th style="padding:6px 8px; text-align:right; font-size:11px; color:${L.inkMuted}; font-weight:400;">Owing</th>
              <th style="padding:6px 8px; text-align:right; font-size:11px; color:${L.inkMuted}; font-weight:400;">Pay</th>
            </tr></thead>
            <tbody id="bpRows">${rows || `<tr><td colspan="5" style="padding:20px; text-align:center; font-size:12px; color:${L.inkFaint};">Nothing owing to ${esc(supplier)}. Record this as an advance instead.</td></tr>`}</tbody>
          </table>
        </div>
        ${creditLines ? `<div style="margin-top:8px; font-size:11px; color:${L.inkFaint};">Credit on hand · ${creditLines}</div>` : ''}
        </div><!-- /bpBillBlock -->

        ${applying ? '' : `
        <div style="font-size:12px; color:${L.inkFaint}; margin:16px 0 6px;">Already recorded</div>
        <div style="background:${L.paper}; border:1px solid ${L.line}; border-radius:var(--radius-sm); max-height:200px; overflow-y:auto;">
          ${recorded.length ? recorded.map((pm) => `
            <div data-payment="${esc(pm.id)}" style="display:flex; align-items:center; gap:10px; padding:7px 10px; border-bottom:1px solid ${L.lineSoft}; font-size:12px;">
              <span style="color:${L.inkMuted}; font-family:var(--font-mono); white-space:nowrap;">${esc(pm.date || '—')}</span>
              <span style="color:${L.ink};">${esc(pm.kind === 'advance' ? 'Advance' : pm.mode || '')}${pm.ref ? ' · ' + esc(pm.ref) : ''}</span>
              <span style="color:${L.inkMuted}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(pm.supplier || '')}</span>
              <span style="flex:1;"></span>
              <span style="color:${L.inkFaint}; white-space:nowrap;">${(pm.allocations || []).length} container${(pm.allocations || []).length === 1 ? '' : 's'}</span>
              <span style="font-family:var(--font-mono); color:${L.ink}; white-space:nowrap;">${money(pm.amount)}</span>
              ${metalsCanDelete() ? `<button class="bpDel" data-payment="${esc(pm.id)}" data-containers="${(pm.allocations || []).length}"
                style="background:none; border:1px solid ${L.line}; border-radius:var(--radius-sm); padding:3px 9px; font-size:11px; color:${L.danger}; cursor:pointer; white-space:nowrap;">Delete</button>`
                : `<span title="Sign in with the Jarvis profile to remove a supplier payment" style="font-size:11px; color:${L.inkFaint}; white-space:nowrap;">&mdash;</span>`}
            </div>`).join('')
            : `<div style="padding:16px; text-align:center; font-size:12px; color:${L.inkFaint};">No payments recorded yet.</div>`}
        </div>`}

        <div style="border-top:1px solid ${L.line}; padding-top:13px; margin-top:14px; display:flex; align-items:flex-end; gap:24px; flex-wrap:wrap;">
          <div><div style="font-size:11px; color:${L.inkFaint};">Allocated</div><div id="bpAllocated" style="font-size:17px; font-weight:500; font-family:var(--font-mono); color:${L.ink};">$0.00</div></div>
          <div><div style="font-size:11px; color:${L.inkFaint};">Still to allocate</div><div id="bpLeft" style="font-size:17px; font-weight:500; font-family:var(--font-mono); color:${L.ink};">$0.00</div></div>
          <div style="flex:1;"></div>
          <!-- Sheet colour and text size: a reading aid, so it sits with the
               other chrome down here instead of inside the heading. -->
          <div style="display:flex; align-items:center; margin-right:6px;">${ledgerThemeToggle()}</div>
          <div style="display:flex; gap:8px;">
            <button id="bpCancel" class="btn btn-secondary" style="font-size:11px; padding:8px 16px; background:${L.paper}; color:${L.inkMuted}; border-color:${L.line};">Cancel</button>
            <button id="bpSave" class="btn btn-primary" style="font-size:11px; padding:8px 20px; background:${L.accent}; border-color:${L.accent}; color:${L.accentInk};">${applying ? 'Apply' : 'Record payment'}</button>
          </div>
        </div>
        <div id="bpErr" style="color:${L.danger}; font-size:11px; margin-top:8px;"></div>

      </div>
    </div>`);

  $('bpDate').value = toUsDate(todayYardDateStr());
  // The string form on purpose: tests/mobile-layout.js audits the source for
  // wireUsDateField('<id>') to prove no date box ships without a picker.
  // Passing the element works but is invisible to that audit, and a date field
  // with no calendar is exactly what she complained about in the first place.
  wireUsDateField('bpDate');

  // ── CASH HAS NO BANK ─────────────────────────────────────────────────
  // Apsara, 2026-09-10: "Always add cash as payment method", and separately
  // that Edge Metals cash is not the yard's petty cash box. helpers/banks.js
  // THROWS if a bank is supplied on a cash payment, so leaving the dropdown
  // on screen would show her choosing something that is about to be refused
  // — or, worse, quietly discarded.
  const syncBankField = () => {
    if (!$('bpBankField') || applying) return;
    $('bpBankField').style.display = ($('bpMode').value === 'Cash') ? 'none' : '';
  };
  if ($('bpMode')) $('bpMode').onchange = syncBankField;
  syncBankField();
  const close = () => { const m = $('bpModal'); if (m) m.remove(); document.removeEventListener('keydown', esc2); };
  const esc2 = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc2);
  $('bpClose').onclick = close;
  $('bpCancel').onclick = close;
  ledgerReopen = () => { close(); openBillPayForm(opts); };
  if ($('bpWhoAgain')) $('bpWhoAgain').onclick = () => { close(); openBillPayForm(); };

  const num = (v) => { const n = parseFloat(String(v || '').replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; };
  const allocations = () => [...document.querySelectorAll('.bpAmt')]
    .map((el) => ({ bill_id: el.dataset.bill, amount: num(el.value) }))
    .filter((a) => a.amount > 0);

  // Recomputed on every keystroke — the remainder is the thing she is
  // working towards, and it turns red the moment she has over-allocated so
  // she sees it before the server refuses it.
  const sentAmount = () => {
    if (!applying) return num($('bpAmount').value);
    const o = $('bpAdvSel') && $('bpAdvSel').selectedOptions[0];
    return o ? num(o.dataset.available) : 0;
  };
  // ── WHICH KIND SHE PICKED ───────────────────────────────────────────────
  // '' until she chooses. Not a boolean: three states matter (advance, bill,
  // not decided yet) and a boolean would make "not decided" indistinguishable
  // from "bill", which is the one that allocates money.
  //
  // DECLARED ABOVE retotal ON PURPOSE. retotal() runs once during the initial
  // paint, before the handlers below are wired — with the declaration further
  // down the function it was in the temporal dead zone and every open of this
  // modal threw "Cannot access 'bpKind' before initialization". Caught by
  // tests/ledger-render.js on the first run, which is the only reason it is
  // not a white screen on the Bills tab.
  let bpKind = '';

  const retotal = () => {
    const sent = sentAmount();
    const alloc = allocations().reduce((s, a) => s + a.amount, 0);
    const left = Math.round((sent - alloc) * 100) / 100;
    $('bpAllocated').textContent = money(alloc);
    $('bpLeft').textContent = money(left);
    $('bpLeft').style.color = left < -0.005 ? L.danger : (Math.abs(left) < 0.005 ? L.ok : L.ink);

    // helpers/billPayments.js cleanAllocations() REFUSES a plain payment whose
    // allocations don't sum to the amount — "record it as an advance instead".
    // The button mirrors that rule rather than letting her fill the whole form
    // and be told no on submit. The rule lives on the server; this is only its
    // reflection, so the server stays the one that decides.
    // ── THE CHOICE DECIDES WHAT "READY" MEANS (2026-10-02) ──────────────
    // An ADVANCE has no containers, so requiring the amount to be fully
    // allocated would make it impossible to record — which is what the old
    // separate "Save as advance" button existed to sidestep.
    // AGAINST A BILL keeps the existing rule exactly: cleanAllocations on the
    // server refuses a payment whose allocations do not sum to the amount, and
    // this is only that rule's reflection.
    // NOTHING CHOSEN is not ready. See bpKindChoice for why there is no
    // default.
    const settled = applying
      ? (sent > 0 && alloc > 0.005 && left > -0.005)   // partial is fine here
      : (bpKind === 'advance' ? sent > 0
        : (bpKind === 'payment' ? (sent > 0 && Math.abs(left) < 0.005)
          : false));
    $('bpSave').disabled = !settled;
    $('bpSave').style.opacity = settled ? '1' : '.45';
    $('bpSave').style.cursor = settled ? 'pointer' : 'not-allowed';
    $('bpSave').title = settled ? (applying ? 'Apply this credit' : 'Record this payment')
      : (!applying && !bpKind ? 'Choose Advance or Against a bill first'
        : (sent <= 0 ? (applying ? 'No credit left on this advance' : 'Enter the amount that left the bank')
          : (left < -0.005 ? `That is more than this ${applying ? 'advance has left' : 'transfer'}`
            : (applying ? 'Put some of it against a container'
              // No longer "or save it as an advance" — that button is gone,
              // and the way to record an advance now is to pick Advance above.
              : `${money(left)} is not on any container yet — allocate it, or record it as an Advance instead`))));
  };

  // Ticking a container fills its balance in, capped by what is left of the
  // transfer — the commonest case is "this wire clears these three".
  document.querySelectorAll('.bpPick').forEach((cb) => {
    cb.onchange = () => {
      const amt = document.querySelector(`.bpAmt[data-bill="${cb.dataset.bill}"]`);
      if (!amt) return;
      if (cb.checked) {
        const sent = sentAmount();
        const already = allocations().reduce((s, a) => s + a.amount, 0);
        const room = sent > 0 ? Math.max(0, sent - already) : Infinity;
        const bal = num(amt.dataset.balance);
        amt.value = (room === Infinity ? bal : Math.min(bal, room)).toFixed(2);
      } else { amt.value = ''; }
      retotal();
    };
  });
  document.querySelectorAll('.bpAmt').forEach((el) => { el.oninput = retotal; });
  $('bpAmount').oninput = retotal;
  if ($('bpAdvSel')) $('bpAdvSel').onchange = () => {
    document.querySelectorAll('.bpPick').forEach((cb) => { cb.checked = false; });
    document.querySelectorAll('.bpAmt').forEach((el) => { el.value = ''; });
    retotal();
  };
  document.querySelectorAll('.bpApply').forEach((btn) => {
    btn.onclick = () => { close(); openBillPayForm({ applySupplier: btn.dataset.supplier }); };
  });

  // ── DELETE, ARMED IN TWO CLICKS ──────────────────────────────────────
  // Apsara, 2026-09-10: "Now i want to have delete option in payment."
  //
  // Not window.confirm: it says "Are you sure?" about nothing in particular,
  // and it is the same dialog for deleting a typo and for deleting a $7,000
  // wire. The first click makes the button SAY what it is about to undo —
  // how many containers go back to owing money — and only the second one
  // does it. Disarms itself after five seconds, so a stray click left
  // hovering over a live delete button is not a thing that can happen.
  //
  // The server audits every one of these (api.js, delete-bill-payment) and
  // re-mirrors the affected containers to the Shipment tab, so the sheet
  // does not keep showing a payment that no longer exists.
  // Shared with the Payments tab's own Delete (#182) — same route, same
  // consequence, so the same sentence and the same 5-second disarm.
  armThenConfirm({
    selector: '.bpDel',
    danger: L.danger,
    onConfirm: async (btn) => {
      await api('/api/bill-payments/' + encodeURIComponent(btn.dataset.payment),
                { method: 'DELETE' });
      // Reopen rather than splice the row out: the balances, the credit on
      // hand and the open-container list all moved, and a list that agrees
      // with itself only in the part you happened to change is worse than a
      // reload.
      close();
      await renderLedgerTab('bills');
      await openBillPayForm();
    },
    onError: (btn, e) => {
      $('bpErr').textContent = e.message || 'Could not delete that payment';
    },
  });
  retotal();

  const paintKindChoice = () => {
    document.querySelectorAll('.bpKind').forEach((b) => {
      const on = b.dataset.kind === bpKind;
      b.style.borderColor = on ? L.accent : L.line;
      b.style.background = on ? L.sunken : L.paper;
      b.style.boxShadow = on ? `inset 0 0 0 1px ${L.accent}` : 'none';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const block = $('bpBillBlock');
    if (block) block.style.display = bpKind === 'payment' ? '' : 'none';
    // Choosing Advance clears any allocation already typed, so a half-filled
    // bill payment cannot be submitted as an advance carrying containers.
    if (bpKind === 'advance') {
      document.querySelectorAll('#bpRows input[data-bill]').forEach((i) => { i.value = ''; });
    }
    retotal();
  };

  document.querySelectorAll('.bpKind').forEach((b) => {
    b.onclick = () => { bpKind = b.dataset.kind; paintKindChoice(); };
  });

  const send = async (asAdvance) => {
    $('bpErr').textContent = '';
    try {
      if (applying) {
        const id = $('bpAdvSel') && $('bpAdvSel').value;
        if (!id) throw new Error('pick an advance');
        // No ledger row here. See helpers/billPayments.applyAdvance.
        await api(`/api/bill-payments/${encodeURIComponent(id)}/apply`,
                  { method: 'POST', body: JSON.stringify({ allocations: allocations() }) });
        close();
        await renderLedgerTab('bills');
        return;
      }
      // ── READ FROM THE CHOICE, NOT FROM WHICH BUTTON WAS PRESSED ───────
      // There is one Record payment button now. Refused here as well as
      // disabled above: a disabled button is a UI state, and this is money.
      if (!bpKind) throw new Error('Choose Advance or Against a bill first');
      const body = {
        kind: bpKind === 'advance' ? 'advance' : 'payment',
        date: $('bpDate').value, amount: $('bpAmount').value,
        mode: $('bpMode').value,
        bank: $('bpMode').value === 'Cash' ? '' : $('bpBank').value,
        ref: $('bpRef').value, supplier: $('bpSupplier').value,
        // An advance sends NO allocations. Not "whatever happens to be in the
        // boxes" — the table is hidden for an advance, so anything still in
        // it is a leftover from before she switched, and sending it would
        // mark containers paid out of money she said was an advance.
        allocations: bpKind === 'advance' ? [] : allocations(),
      };
      await api('/api/bill-payments', { method: 'POST', body: JSON.stringify(body) });
      close();
      await renderLedgerTab('bills');
    } catch (e) { $('bpErr').textContent = e.message || 'Could not record it'; }
  };
  $('bpSave').onclick = () => send();
  // bpAdvance is gone — the kind comes from bpKindChoice now.
  paintKindChoice();
}

// ── THE ADD FORM ─────────────────────────────────────────────────────────
// Apsara, 2026-09-10, on the first version: "This is ugly and not user
// friendly." It was: seventeen identical browser-default white boxes on a
// dark page, in one undifferentiated 3-column wall, with the word TRUCKING
// appearing twice — and no way at all to see what the numbers added up to
// until she pressed Save.
//
// Four things were actually wrong, and only the first was cosmetic:
//   1. It ignored the app's own `.field` convention, so the inputs fell back
//      to browser default. Everything else on this page uses .field.
//   2. 23 fields with no grouping. They arrive as four short sections now.
//   3. Two fields both labelled "Trucking" — the haulier and the cost. In the
//      TABLE her column order tells them apart; in a form it cannot, so the
//      store carries a `formLabel` for exactly those.
//   4. No live totals. She fills five weights and four money fields to
//      produce a Balance she cannot see. The preview below fixes that, and it
//      asks the SERVER rather than doing her arithmetic a second time here.
//
// Built from the `fields` the server sends, so a column added to the store
// appears here without an edit.
// `existing` present = editing that row; absent = adding a new one. ONE
// function for both, so the two layouts cannot drift apart.
// `seed` is a SUGGESTION for a new row — from the bill a container was bought
// on. Deliberately a third argument rather than being passed as `existing`:
// `existing` means editing a saved row, and conflating the two would have the
// autosave issue a PUT against an id that is not there. Named `seed` because
// `prefill` is already taken further down by the booking picker's markup.
