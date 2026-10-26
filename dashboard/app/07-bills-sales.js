// dashboard/app/07-bills-sales.js — split from dashboard/index.html's <script> (helpers/sourceParts.js reconstructs the original)
const metalsTab = { bills: 'bills', sales: 'outgoing' };

const METALS_TABS = {
  // ── MONEY SENT TO SUPPLIERS ───────────────────────────────────────────
  // Apsara, 2026-09-29: "in bill,i need to have a tab to show advance/payment
  // send to suppliers .I dont want outgoing tab in bills".
  //
  // Outgoing was added to Bills earlier the same day and removed here at her
  // word — it is the invoice table, and the Invoice register is where it
  // belongs. The `bar` option on renderLedgerTab existed only to support it
  // and went with it, rather than staying behind as machinery in shared code
  // that nothing calls.
  //
  // Payments is not the same thing wearing a different label. Bills says what
  // is OWED to a supplier; this says what has been SENT to them — every
  // payment and every advance, including credit not yet applied to a
  // container. Until now that only existed inside the pay modal, one supplier
  // at a time, and only while she was in the act of paying somebody.
  bills: [['bills', 'Bills'], ['payments', 'Payments'], ['trucking', 'Trucking']],
  // ── THE LABEL IS 'Sales'; THE ID STAYS 'outgoing' ─────────────────────
  // Apsara, 2026-09-29: "change the tab name of outgoing to sales in invoice
  // tab" — and, a message earlier, having asked whether Incoming and Outgoing
  // were customers and suppliers: they are both the CUSTOMER side. Outgoing
  // was named for the direction the containers travel and Incoming for the
  // direction the cash travels, which is why the pair read as opposites when
  // they are not.
  //
  // ONLY the label changes. The id is what openTab, wireMetalsTabs,
  // metalsTab.sales and every test key on; renaming it would be a rename of
  // the tab's identity to fix the word on a button. A display string is the
  // smallest change that does what she asked.
  sales: [['outgoing', 'Sales'], ['incoming', 'Incoming'],
          ['freight', 'Freight'], ['commission', 'Commission'],
          // The join, and the reason the two sides were keyed the same way.
          ['margin', 'Margin']],
};

function metalsTabBar(section) {
  const cur = metalsTab[section];
  const one = ([id, label]) => {
    const on = cur === id;
    return `<button class="metals-tab" data-section="${section}" data-tab="${id}"`
      + ` style="background:none; border:none; cursor:pointer; font-size:12px; padding:8px 14px;`
      + ` color:${on ? 'var(--text-primary)' : 'var(--text-muted)'};`
      + ` border-bottom:2px solid ${on ? 'var(--accent)' : 'transparent'};">${label}</button>`;
  };
  return `<div style="display:flex; gap:4px; border-bottom:1px solid var(--line); margin-bottom:14px;">`
    + METALS_TABS[section].map(one).join('') + `</div>`;
}

function wireMetalsTabs() {
  document.querySelectorAll('.metals-tab').forEach((b) => {
    b.onclick = () => {
      const { section, tab } = b.dataset;
      metalsTab[section] = tab;
      if (section === 'bills') {
        if (tab === 'trucking') return renderMetalsTruckingTab();
        if (tab === 'payments') return renderSupplierPaymentsTab();
        return renderLedgerTab('bills');
      }
      return tab === 'outgoing' ? renderLedgerTab('sales') : renderSalesSubTab(tab);
    };
  });
}

// Eyebrows for the sub-tabs. 'Invoice' rather than 'Sales' since 2026-09-16 —
// the section is called Invoice now and an eyebrow still reading Sales would
// be the one place the old name survived.
const SALES_TAB_TITLES = {
  incoming: ['Invoice', 'Incoming'],
  margin: ['Edge Metals', 'Margin per container'],
  freight: ['Invoice', 'Freight'],
  commission: ['Invoice', 'Commission'],
};

async function renderLedgerTab(kind) {
  // Incoming, Freight and Commission are their own screens — they are not the
  // sales table with different columns, and pretending otherwise is how a
  // charge list ends up rendered as a row of blanks.
  const K = LEDGER_KINDS[kind];
  const f = ledgerFilters[kind] || {};
  // Sent to the SERVER, which filters and then totals — so the summary row
  // always describes the rows on screen. See /api/bills for why.
  const qs = Object.entries(f).filter(([, v]) => String(v || '').trim() !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const data = await api(K.path + (qs ? `?${qs}` : ''));
  const rows = asArray(data[K.listKey]) .length ? data[K.listKey] : (data[K.listKey] || []);
  const columns = Array.isArray(data.columns) ? data.columns : [];
  const sum = data.summary || {};
  ledgerState = { kind, rows, columns, summary: sum, writable: data.writable || [],
                  fields: data.fields || columns, groups: data.groups || [],
                  facets: data.facets || {} };

  const cards = K.cards.map(([label, key, how]) => `
    <div class="card" style="padding:12px;">
      <div style="font-family:var(--font-mono); font-size:9px; letter-spacing:.12em; text-transform:uppercase; color:var(--text-muted);">${label}</div>
      <div style="font-size:16px; font-weight:700; margin-top:4px;">${how === 'money' ? ledMoney(sum[key]) : ledNum(sum[key])}</div>
    </div>`).join('');

  // ── A ROW THAT CANNOT BE COMPUTED SAYS SO ────────────────────────────
  // helpers/bills.js returns missing_tares rather than treating a blank
  // chassis weight as zero, because a zero tare silently inflates the net
  // weight and therefore the amount. That warning is worth nothing if the
  // table does not show it.
  // ── THE TICK COLUMN ────────────────────────────────────────────────────
  // Apsara, 2026-09-29: "What if i want to delte multiple rows in bills and
  // invoice", and asked which ways in she needed: "1,2,3".
  //
  // JARVIS PROFILE ONLY. A single bill is an admin's to correct; a SELECTION
  // is the one control on this screen that can empty a year in one press, so
  // it sits behind the same lock as every other deletion of Edge Metals money
  // (/api/ledger/bulk-delete/* is requireSuper — this is only the UI half, and
  // hiding a button is not a permission).
  // ── A SCANNABLE TABLE, AND THE REST ONE CLICK AWAY (2026-10-02) ───────
  // Apsara, with a screenshot: "It looks unprofessional and ugly.i want this
  // to be neat.when i click the bill,if it has multiple rows,i want this to
  // expand".
  //
  // WHAT WAS ACTUALLY WRONG. The server sends 25 columns and every cell is
  // white-space:nowrap, so the table was far wider than any screen and
  // scrolled sideways. The actions cell is position:sticky; right:0 — correct
  // on its own — which means it FLOATS OVER the scrolled content. That is the
  // green credit badge sitting on top of the seal number in her screenshot:
  // not a rendering bug, the sticky column doing its job over a table that
  // should never have been that wide.
  //
  // So the fix for "ugly" and the fix for the overlap are the same fix: stop
  // the sideways scroll. The columns she scans by stay; the rest go in a
  // panel under the row, grouped the way the server already groups them.
  // Nothing is removed — everything is one click nearer than a scrollbar.
  //
  // WHICH COLUMNS ARE CORE IS THE SERVER'S CALL. helpers/bills.js marks them,
  // because a key list kept here is a second copy of the column definitions
  // and drifts the moment one is renamed — the hazard tests/bills-sales.js
  // already guards for headings.
  //
  // BILLS ONLY FOR NOW. This renderer is shared with sales, and CLAUDE.md's
  // first rule is that a request about one screen changes that screen only.
  // The flag marks the NEW shape, never the old: sales has no core-marked
  // columns, so it renders exactly as before.
  const anyCore = columns.some((c) => c && c.core);
  const shown = anyCore ? columns.filter((c) => c.core) : columns;
  const hidden = anyCore ? columns.filter((c) => !c.core) : [];

  const canBulk = IS_SUPER === true;
  // Supplier -> unapplied advance. From /api/bills (see the route), so the
  // table and the badges are one request and cannot disagree about a figure.
  const ledCredit = (kind === 'bills' && data.credit) ? data.credit : {};
  // One detail panel per row, built from the columns the table no longer
  // shows. Rendered WITH the row rather than on demand: the data is already
  // here, and fetching on expand would make a click wait on a network for
  // something that is sitting in memory.
  const detailFor = (r) => {
    if (!hidden.length) return '';
    const byGroup = (ledgerState.groups || []).map((g) => {
      const keys = Array.isArray(g.keys) ? g.keys : [];
      const cols = hidden.filter((c) => keys.includes(c.key));
      if (!cols.length) return '';
      return `<div style="min-width:190px;">
          <div style="font-family:var(--font-mono); font-size:9px; letter-spacing:.11em; text-transform:uppercase; color:var(--text-muted); margin-bottom:6px;">${esc(g.label || g.id)}</div>
          ${cols.map((c) => `<div style="display:flex; gap:10px; padding:2px 0; font-size:12px;">
              <span style="color:var(--text-faint); min-width:96px;">${esc(c.label || c.key)}</span>
              <span style="color:var(--text-strong);">${ledgerCell(r, c, K) || '<span style=\"color:var(--text-faint)\">—</span>'}</span>
            </div>`).join('')}
        </div>`;
    }).filter(Boolean).join('');
    // Anything the server did not put in a group still has to appear, or the
    // expand quietly loses a field. Grouped last, under its own heading.
    const grouped = new Set((ledgerState.groups || []).flatMap((g) => g.keys || []));
    const rest = hidden.filter((c) => !grouped.has(c.key));
    const restBlock = rest.length ? `<div style="min-width:190px;">
        <div style="font-family:var(--font-mono); font-size:9px; letter-spacing:.11em; text-transform:uppercase; color:var(--text-muted); margin-bottom:6px;">Weights and the rest</div>
        ${rest.map((c) => `<div style="display:flex; gap:10px; padding:2px 0; font-size:12px;">
            <span style="color:var(--text-faint); min-width:96px;">${esc(c.label || c.key)}</span>
            <span style="color:var(--text-strong);">${ledgerCell(r, c, K) || '<span style=\"color:var(--text-faint)\">—</span>'}</span>
          </div>`).join('')}
      </div>` : '';
    return `<div style="display:flex; flex-wrap:wrap; gap:26px; padding:14px 16px 16px; background:var(--surface-sunken); border-top:1px dashed var(--line);">${byGroup}${restBlock}</div>`;
  };

  const body = rows.length ? rows.map((r, i) => `
    <tr class="ledRow" data-id="${esc(r.id)}" style="border-top:1px solid var(--line); cursor:pointer;" title="Click for the full detail">
      ${canBulk ? `<td style="padding:7px 4px 7px 10px; width:26px;"><input type="checkbox" class="ledPick" data-id="${esc(r.id)}" aria-label="Select ${esc(r.container_no || r.id)}" style="cursor:pointer;"></td>` : ''}
      ${shown.map((c) => `<td style="padding:8px 9px; white-space:nowrap; ${c.derived ? 'color:var(--text-muted);' : ''}">${ledgerCell(r, c, K)}</td>`).join('')}
      <td style="padding:7px 9px; white-space:nowrap; position:sticky; right:0; background:var(--surface-card); box-shadow:-8px 0 8px -8px rgba(0,0,0,.55); z-index:2;">
        <!-- ── ON A SALE, MONEY COMES IN ────────────────────────────────
             Apsara, 2026-09-15: "In add sales ,there should be receive payment
             na instead of pay". Right, and it was her own phrase from
             2026-09-10 — "In outgoing-give the option as mark as paid" — that
             I took literally without noticing the word inverts on the sell
             side. "Paid" on a row she INVOICED reads as money she paid out.
             The modal behind this button already said "How much arrived",
             "Received on" and "Into" — the model was right and only the label
             on the way in was wrong. -->
        <!-- ── ONE ICON, NOT FOUR BUTTONS ───────────────────────────────
             Apsara, 2026-09-19, with a screenshot of the same four words
             repeating down the whole screen: "i dont want something like
             button keep on piling up.perhaps a small icon ..on clicking,
             these button should expand."

             She is right, and it was getting worse by design: every feature
             added this month put another word in this cell. RECEIVE PAYMENT
             GENERATE EDIT DELETE, x 651 rows, is about 2,600 buttons drawn
             on a tab she opens all day — which is also a real part of why
             that tab is slow.

             So the cell is a single ⋯ that opens a small menu. The same
             stacked-dots idea she asked for on the export ("three dots
             option.i want three dots to stacked vertically"), horizontal
             here because it sits in a row of actions rather than at the end
             of a toolbar.

             WHAT STAYS VISIBLE: the status marks. "received", the missing
             tare warning, the "still needs" marker and the amount-differs
             flag are not actions — they are things she is meant to SEE
             while scanning, and hiding a warning behind a click is how a
             warning stops working. Only the buttons fold away.

             AND NO BACKTICKS IN HERE. This whole cell is inside a template
             literal, so one backtick in a comment ends the string and the
             page stops parsing — which is exactly what the first version of
             this comment did, quoting "received" in backticks. -->
        <!-- ── CREDIT SITTING WITH THIS SUPPLIER ─────────────────────────
             Apsara, 2026-09-29: "see all unapplied advacne against the
             suppl[i]er". This is the per-ROW half of that — the panel above
             the table is the list.

             It sits with the status marks rather than the buttons, because
             like them it is something she is meant to SEE while scanning: a
             bill with a balance owing while the same supplier is holding an
             advance is a payment that may not need making. Not an action.

             BILLS ONLY. Credit against a SUPPLIER has no meaning on a sale,
             where the other party is a customer — a customer's credit is a
             different store (sales receipts and deductions) and putting the
             supplier figure on both would be a number that is simply wrong
             half the time. -->
        ${kind === 'bills' && ledCredit[String(r.supplier || '').trim()] > 0.005
          ? `<span title="${esc(String(r.supplier || '').trim())} is holding ${ledMoney(ledCredit[String(r.supplier || '').trim()])} of unapplied advance — it may cover part of this" style="color:var(--status-good, #4ade80); font-size:10px; font-family:var(--font-mono); margin-right:6px;">${ledMoney(ledCredit[String(r.supplier || '').trim()])} credit</span>` : ''}
        ${kind === 'sales' && r.balance !== null && Math.abs(r.balance) <= 0.005
          ? `<span title="Settled${r.bank_charge ? ` — ${ledMoney(r.bank_charge)} of it was a bank charge` : ''}${r.discount ? ` — ${ledMoney(r.discount)} discounted` : ''}" style="color:var(--status-good, #4ade80); font-size:10px; font-family:var(--font-mono); margin-right:6px;">received${r.bank_charge || r.discount ? ' *' : ''}</span>` : ''}
        <!-- The items themselves are built in actionsFor(), below. Generate
             appears on SALES rows only, because an invoice is what she bills
             a CUSTOMER and a bill has no customer on it — and on every sales
             row rather than only the complete ones, since the route answers
             422 with the list of what is still missing, which is a more
             useful thing to read than a button that is not there. -->
        <button class="row-menu-btn" data-id="${esc(r.id)}" aria-label="Actions" title="Actions"
          style="background:none; border:1px solid var(--line); border-radius:var(--radius-sm); color:var(--text-muted); font-size:13px; line-height:1; padding:3px 8px; cursor:pointer;">&#8943;</button>
        ${(r.missing_tares && r.missing_tares.length)
          ? ` <span title="No weight recorded for: ${esc(r.missing_tares.join(', '))} — the net is computed without them" style="color:var(--status-warn); font-family:var(--font-mono); font-size:10px;">⚠ ${esc(r.missing_tares.length)}</span>` : ''}
        ${(r.incomplete && r.incomplete.length)
          ? ` <span title="Still needs: ${esc(r.incomplete.join(', '))}" style="color:var(--status-warn); font-family:var(--font-mono); font-size:10px;">◦ ${esc(r.incomplete.join(', '))}</span>` : ''}
        ${(r.amount_differs !== null && r.amount_differs !== undefined)
          ? ` <span title="You typed ${ledMoney(r.amount)}; the weight and price give ${ledMoney(r.computed_amount)}" style="color:var(--status-warn); font-family:var(--font-mono); font-size:10px;">⚠ ${ledMoney(r.amount_differs)}</span>` : ''}
      </td>
    </tr>
    ${hidden.length ? `<tr class="ledDetail" data-for="${esc(r.id)}" style="display:none;">
      <td colspan="${shown.length + (canBulk ? 2 : 1)}" style="padding:0;">${detailFor(r)}</td>
    </tr>` : ''}`).join('')
    : `<tr><td colspan="${shown.length + (canBulk ? 2 : 1)}" style="padding:26px; text-align:center; color:var(--text-faint); font-family:var(--font-mono); font-size:12px;">Nothing here yet.</td></tr>`;

  $('viewRoot').innerHTML = `
    <div style="max-width:100%; margin:0 auto; padding:34px 28px 80px;">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:14px;">
        <div>
          <div class="eyebrow">${K.eyebrow}</div>
          <h2 style="font-size:19px; text-transform:uppercase; margin:0;">${K.title}</h2>
        </div>
        <div style="display:flex; gap:8px;">
          ${kind === 'bills' ? '<button id="btnPay" class="btn btn-secondary" style="font-size:12px; padding:8px 14px;">Pay</button>' : ''}
          ${kind === 'sales' ? '<button id="btnFromBill" class="btn btn-secondary" style="font-size:12px; padding:8px 14px;">New from bill</button>' : ''}
          ${kind === 'sales' ? '<button id="btnFollowups" class="btn btn-secondary" style="font-size:12px; padding:8px 14px;">Payment follow-ups</button>' : ''}
          ${kind === 'bills' || kind === 'sales' ? '<button id="btnNameCleanup" class="btn btn-ghost" style="font-size:12px; padding:8px 12px;" title="The same name typed two ways">Clean names</button>' : ''}
          ${kind === 'bills' || kind === 'sales' ? '<button id="btnImport" class="btn btn-secondary" style="font-size:12px; padding:8px 14px;" title="Import a shipments workbook">Import</button>' : ''}
          <button id="btnAddLedger" class="btn btn-primary" style="font-size:12px; padding:8px 14px;">${K.addLabel}</button>
          ${kind === 'bills' || kind === 'sales' ? `<div style="position:relative;">
            <button id="btnExport" class="btn btn-ghost" aria-haspopup="menu" aria-expanded="false"
              style="font-size:17px; line-height:1; padding:8px 10px;"
              title="Export these ${rows.length} rows">&#8942;</button>
            <div id="exportMenu" class="hidden" role="menu"
              style="position:absolute; right:0; top:calc(100% + 6px); z-index:60; min-width:190px;
                     background:var(--surface-card); border:1px solid var(--line); border-radius:var(--radius-sm);
                     box-shadow:0 8px 24px rgba(0,0,0,.45); overflow:hidden;">
              <div style="padding:7px 12px; font-family:var(--font-mono); font-size:9px; letter-spacing:.12em;
                          text-transform:uppercase; color:var(--text-muted); border-bottom:1px solid var(--line);">
                Export ${rows.length} row${rows.length === 1 ? '' : 's'}</div>
              <button class="exp-opt" data-format="xlsx" role="menuitem"
                style="display:block; width:100%; text-align:left; background:none; border:none; cursor:pointer;
                       padding:9px 12px; font-size:12.5px; color:var(--text-primary);">Excel
                <span style="color:var(--text-faint); font-size:11px;">&nbsp;— .xlsx, figures you can add up</span></button>
              <button class="exp-opt" data-format="pdf" role="menuitem"
                style="display:block; width:100%; text-align:left; background:none; border:none; cursor:pointer;
                       padding:9px 12px; font-size:12.5px; color:var(--text-primary); border-top:1px solid var(--line);">PDF
                <span style="color:var(--text-faint); font-size:11px;">&nbsp;— to print or send</span></button>

              <!-- ── UNDO, WHERE SOMEONE WOULD LOOK FOR IT ──────────────
                   Apsara, 2026-09-19, after six rounds of me hunting a
                   rendering bug that did not exist: "undo import s there only
                   in import button".

                   It was rendering the whole time. The only route to it was a
                   button labelled IMPORT, which is not where anyone looks to
                   UNDO one — you have to re-enter the thing you want to
                   reverse. That is a discoverability fault, and it is mine.

                   Hidden until the batches come back, because an "Undo last
                   import" offered when there has never been an import is a
                   dead entry she will click once and distrust after. -->
              <div id="undoImportWrap" class="hidden" style="border-top:1px solid var(--line);">
                <div style="padding:7px 12px; font-family:var(--font-mono); font-size:9px; letter-spacing:.12em;
                            text-transform:uppercase; color:var(--text-muted);">Import</div>
                <button id="btnUndoImport" role="menuitem"
                  style="display:block; width:100%; text-align:left; background:none; border:none; cursor:pointer;
                         padding:9px 12px; font-size:12.5px; color:var(--status-warn, #d98324);">Undo last import
                  <span id="undoImportWhat" style="color:var(--text-faint); font-size:11px;"></span></button>
              </div>
            </div>
          </div>` : ''}
        </div>
      </div>
      ${kind === 'sales' || kind === 'bills' ? metalsTabBar(kind === 'sales' ? 'sales' : 'bills') : ''}
      ${kind === 'sales' && (data.duplicates || []).length ? `<div style="margin-bottom:12px; padding:9px 12px; border:1px solid var(--status-warn); border-radius:var(--radius-sm); font-size:12px; color:var(--status-warn);">
        ${(data.duplicates || []).map((d) => `${esc(d.container_no)} appears ${d.ids.length} times under ${esc(d.booking_no)}`).join(' · ')}
        — usually a typo, occasionally a container split across two invoices. Worth a look either way: the margin against Bills counts it twice.
      </div>` : ''}
      <div style="display:grid; grid-template-columns:repeat(${K.cards.length}, 1fr); gap:8px; margin-bottom:12px;">${cards}</div>
      <div style="display:flex; flex-wrap:wrap; gap:8px; align-items:flex-end; margin-bottom:14px; padding:12px 14px; border:1px solid var(--border-subtle); border-radius:var(--radius-sm); background:var(--surface-sunken);">
        ${ledFilterBox('q', 'Search', 'any field', f.q, 200)}
        ${(K.filters || []).map((key) => ledFilterSelect(key, data.facets || {}, f[key])).join('')}
        ${ledFilterBox('from', 'From', 'MM/DD/YYYY', f.from, 120)}
        ${ledFilterBox('to', 'To', 'MM/DD/YYYY', f.to, 120)}
        <button id="ledClear" class="btn btn-secondary" style="font-size:11px; padding:8px 14px;">Clear</button>
        <div style="flex:1;"></div>
        <div style="font-family:var(--font-mono); font-size:10px; color:var(--text-faint); padding-bottom:9px;">
          ${activeFilterCount(f) ? `${activeFilterCount(f)} filter${activeFilterCount(f) === 1 ? '' : 's'} · ` : ''}${rows.length} of ${data.total_unfiltered ?? rows.length}
        </div>
      </div>
      <!-- ── MONEY ALREADY WITH THE SUPPLIER ───────────────────────────
           Apsara, 2026-09-29: "see all unapplied advacne against the
           suppl[i]er".

           creditBySupplier() has existed for weeks and reached exactly one
           place: the "who are you paying?" step of the pay modal. So the
           figure was only visible to someone already in the act of paying
           somebody — which is the one moment she does not need reminding.

           Shown only when there IS credit. A strip reading "$0.00 sitting"
           on every visit is furniture, and furniture stops being read. -->
      ${kind === 'bills' && Object.keys(ledCredit).length ? `<div id="ledCreditBar" style="display:flex; align-items:center; gap:10px; margin-bottom:10px; padding:9px 13px;
           border:1px solid var(--status-good, #4ade80); border-radius:var(--radius-sm); background:var(--surface-sunken);">
        <span style="font-family:var(--font-mono); font-size:11px; color:var(--text-body);">
          ${ledMoney(Object.values(ledCredit).reduce((a, b) => a + b, 0))} of advances sitting unapplied
          across ${Object.keys(ledCredit).length} supplier${Object.keys(ledCredit).length === 1 ? '' : 's'}
        </span>
        <div style="flex:1;"></div>
        <button id="ledCreditShow" class="btn btn-ghost" style="font-size:11px; padding:6px 14px;">Show them</button>
      </div>` : ''}
      ${canBulk ? `<div id="ledSelBar" style="display:none; align-items:center; gap:10px; margin-bottom:10px; padding:9px 13px;
           border:1px solid var(--accent); border-radius:var(--radius-sm); background:var(--surface-sunken);">
        <span id="ledSelCount" style="font-family:var(--font-mono); font-size:11px; color:var(--text-body);"></span>
        <div style="flex:1;"></div>
        <button id="ledSelNone" class="btn btn-ghost" style="font-size:11px; padding:6px 12px;">Clear</button>
        <button id="ledSelDel" class="btn btn-secondary" style="font-size:11px; padding:6px 14px; border-color:var(--status-warn); color:var(--status-warn);">Delete selected&hellip;</button>
      </div>
      <div id="ledUndoBar" style="display:none; align-items:center; gap:10px; margin-bottom:10px; padding:9px 13px;
           border:1px solid var(--status-good, #4ade80); border-radius:var(--radius-sm); background:var(--surface-sunken);">
        <span id="ledUndoWhat" style="font-family:var(--font-mono); font-size:11px; color:var(--text-body);"></span>
        <div style="flex:1;"></div>
        <button id="ledUndoGo" class="btn btn-ghost" style="font-size:11px; padding:6px 14px;">Put them back</button>
      </div>` : ''}
      <div class="card" style="padding:0; overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:12px;">
          <thead>
            <tr style="background:var(--bg-sunken);">
              ${canBulk ? '<th style="padding:8px 4px 8px 10px; width:26px;"><input type="checkbox" id="ledPickAll" title="Select every row shown" aria-label="Select every row shown" style="cursor:pointer;"></th>' : ''}
              ${shown.map((c) => `<th style="padding:8px 9px; text-align:left; white-space:nowrap; font-family:var(--font-mono); font-size:9px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted);">${esc(c.label)}${c.derived ? '<span title="Computed by the server from the other columns — not typed" style="opacity:.6;"> ƒ</span>' : ''}</th>`).join('')}
              <th style="padding:8px 9px; position:sticky; right:0; background:var(--bg-sunken); box-shadow:-8px 0 8px -8px rgba(0,0,0,.55); z-index:3;"></th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      <div style="margin-top:10px; font-family:var(--font-mono); font-size:10px; color:var(--text-faint);">
        <span id="ledBuild" title="Which build of the app you are looking at"></span>${rows.length} row${rows.length === 1 ? '' : 's'} · Edit and Delete stay pinned on the right as the table scrolls · ƒ columns are computed server-side · price shows /lb or /MT so a wrong unit is visible
      </div>
      <button id="ledTop" title="Back to the newest ${kind === 'bills' ? 'bill' : 'invoice'}" aria-label="Back to the top of the list"
        style="position:fixed; right:26px; bottom:26px; z-index:40; width:42px; height:42px; border-radius:50%;
               display:none; align-items:center; justify-content:center; cursor:pointer;
               background:var(--surface-card); color:var(--text-body);
               border:1px solid var(--border-default); box-shadow:0 6px 18px rgba(0,0,0,.34);
               transition:opacity .16s ease, transform .16s ease; opacity:0;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
      </button>
    </div>`;

  // Applied on ENTER or on leaving the box, not on every keystroke: each
  // change is a server round trip, and re-fetching per character would make
  // the table flicker while she is still typing a container number.
  document.querySelectorAll('[data-led-filter]').forEach((el) => {
    const key = el.dataset.ledFilter;
    const apply = () => {
      const v = String(el.value || '').trim();
      if ((ledgerFilters[kind][key] || '') === v) return;   // nothing changed
      ledgerFilters[kind][key] = v;
      renderLedgerTab(kind);
    };
    el.addEventListener('change', apply);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
  });
  $('ledClear').onclick = () => { ledgerFilters[kind] = {}; renderLedgerTab(kind); };

  // ── THE UNAPPLIED ADVANCES LIST ──────────────────────────────────────
  // The strip says how much; this says which. A total alone does not tell her
  // what to go and look at, so the list names the supplier, the date the
  // advance was paid, what it was, how much has been applied and what is left.
  //
  // The individual advances come from /api/bill-payments rather than riding
  // on every bills request — most visits to this tab never open this, and
  // loading the whole payment ledger to render a strip nobody pressed would
  // slow the table for everyone.
  if ($('ledCreditShow')) {
    $('ledCreditShow').onclick = async () => {
      let rows = [];
      try {
        const d = await api('/api/bill-payments');
        rows = (d.advances || []).slice().sort((a, b) => (b.available || 0) - (a.available || 0));
      } catch (e) { alert(e.message || 'Could not read the advances'); return; }

      const back = document.createElement('div');
      back.className = 'modal-overlay';
      back.style.display = 'flex';
      back.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" aria-label="Unapplied advances" style="max-width:720px; width:100%;">
          <div style="padding:18px 22px 12px; border-bottom:1px solid var(--border-subtle);">
            <h3 style="margin:0; font-size:16px; text-transform:uppercase;">Advances sitting unapplied</h3>
            <p style="margin:6px 0 0; font-size:12px; color:var(--text-muted);">
              Money already sent to a supplier that no container has been put against yet.
              Apply one from Pay, on the supplier it belongs to.</p>
          </div>
          <div class="modal-body" style="padding:0;">
            ${rows.length ? `<table style="width:100%; border-collapse:collapse; font-size:12px;">
              <thead><tr style="background:var(--bg-sunken);">
                ${['Supplier', 'Paid on', 'Advance', 'Applied', 'Left'].map((h, i) => `<th style="padding:8px 12px; text-align:${i > 1 ? 'right' : 'left'}; font-family:var(--font-mono); font-size:9px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted);">${h}</th>`).join('')}
              </tr></thead>
              <tbody>${rows.map((a) => `<tr style="border-top:1px solid var(--line);">
                <td style="padding:8px 12px;">${esc(a.supplier || '—')}</td>
                <td style="padding:8px 12px; font-family:var(--font-mono);">${esc(a.date || '—')}</td>
                <td style="padding:8px 12px; text-align:right; font-family:var(--font-mono);">${ledMoney(a.amount)}</td>
                <td style="padding:8px 12px; text-align:right; font-family:var(--font-mono); color:var(--text-muted);">${ledMoney(a.used)}</td>
                <td style="padding:8px 12px; text-align:right; font-family:var(--font-mono); color:var(--status-good, #4ade80);">${ledMoney(a.available)}</td>
              </tr>`).join('')}</tbody>
            </table>` : '<div style="padding:26px; text-align:center; color:var(--text-faint); font-size:12px;">Nothing sitting unapplied.</div>'}
          </div>
          <div style="padding:14px 22px; border-top:1px solid var(--border-subtle); display:flex; justify-content:flex-end;">
            <button id="credClose" class="btn btn-secondary" style="font-size:12px; padding:8px 18px;">Close</button>
          </div>
        </div>`;
      document.body.appendChild(back);
      const close = () => back.remove();
      back.querySelector('#credClose').onclick = close;
      back.addEventListener('click', (e) => { if (e.target === back) close(); });
    };
  }

  // ── CLEARING SEVERAL ROWS ────────────────────────────────────────────
  // Apsara, 2026-09-29: "What if i want to delte multiple rows in bills and
  // invoice". Asked which ways in she needed she answered "1,2,3" — a bad
  // import, a date range, and rows she ticks — and on a row with money against
  // it: "Refuse it, delete the rest".
  //
  // All three are ONE modal with three radios, because they differ only in how
  // the row list is chosen. The plan comes from the server and nothing has
  // happened while she is reading it.
  if (canBulk) {
    const picked = () => [...document.querySelectorAll('.ledPick:checked')].map((c) => c.dataset.id);
    const syncSel = () => {
      const n = picked().length;
      const bar = $('ledSelBar');
      if (bar) { bar.style.display = n ? 'flex' : 'none'; }
      const c = $('ledSelCount');
      if (c) c.textContent = `${n} ${K.title.toLowerCase().replace(/s$/, '')}${n === 1 ? '' : 's'} selected`;
      const all = $('ledPickAll');
      const boxes = document.querySelectorAll('.ledPick');
      if (all) {
        all.checked = boxes.length > 0 && n === boxes.length;
        all.indeterminate = n > 0 && n < boxes.length;
      }
    };
    document.querySelectorAll('.ledPick').forEach((b) => b.addEventListener('change', syncSel));
    if ($('ledPickAll')) {
      $('ledPickAll').addEventListener('change', (e) => {
        document.querySelectorAll('.ledPick').forEach((b) => { b.checked = e.target.checked; });
        syncSel();
      });
    }
    if ($('ledSelNone')) $('ledSelNone').onclick = () => {
      document.querySelectorAll('.ledPick').forEach((b) => { b.checked = false; });
      syncSel();
    };
    syncSel();

    // ── THE UNDO STRIP ────────────────────────────────────────────────
    // Shown only after a deletion in THIS session. The archive keeps every
    // batch for ever, but a permanent "put something back" bar on a ledger
    // is an invitation to restore a batch she deliberately cleared weeks ago.
    const showUndo = (batch, n) => {
      const bar = $('ledUndoBar');
      if (!bar) return;
      bar.style.display = 'flex';
      $('ledUndoWhat').textContent = `${n} row${n === 1 ? '' : 's'} deleted — ${batch}`;
      $('ledUndoGo').onclick = async () => {
        $('ledUndoGo').disabled = true;
        try {
          const r = await api('/api/ledger/bulk-delete/restore', {
            method: 'POST', body: JSON.stringify({ batch }) });
          alert(`${r.restored} row${r.restored === 1 ? '' : 's'} put back.`);
          renderLedgerTab(kind);
        } catch (e) { $('ledUndoGo').disabled = false; alert(e.message || 'Could not restore'); }
      };
    };

    if ($('ledSelDel')) $('ledSelDel').onclick = async () => {
      let imports = [];
      try { imports = (await api('/api/ledger/bulk-delete/batches')).imports || []; } catch (e) { imports = []; }

      const filterWords = () => {
        const bits = [];
        if (f.from || f.to) bits.push(`${f.from || 'the start'} to ${f.to || 'today'}`);
        for (const k of Object.keys(f)) {
          if (k === 'from' || k === 'to') continue;
          if (String(f[k] ?? '').trim() !== '') bits.push(`${k} ${f[k]}`);
        }
        return bits.join(', ');
      };
      const fw = filterWords();

      const back = document.createElement('div');
      back.className = 'modal-overlay';
      back.style.display = 'flex';
      back.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" aria-label="Delete rows" style="max-width:640px; width:100%;">
          <div class="modal-head" style="padding:18px 22px 12px; border-bottom:1px solid var(--border-subtle);">
            <h3 style="margin:0; font-size:16px; text-transform:uppercase;">Delete ${esc(K.title.toLowerCase())}</h3>
            <p style="margin:6px 0 0; font-size:12px; color:var(--text-muted);">
              Nothing is removed until you press the red button. Anything with a payment,
              a credit note or an open claim against it is refused and stays.</p>
          </div>
          <div class="modal-body" style="padding:18px 22px;">
            <div style="display:flex; flex-direction:column; gap:9px; font-size:12.5px;">
              <label style="display:flex; gap:9px; align-items:flex-start; cursor:pointer;">
                <input type="radio" name="bdWay" value="picked" checked style="margin-top:3px;">
                <span>The <strong>${picked().length}</strong> row${picked().length === 1 ? '' : 's'} I ticked</span></label>
              <label style="display:flex; gap:9px; align-items:flex-start; cursor:${fw ? 'pointer' : 'not-allowed'}; opacity:${fw ? 1 : .45};">
                <input type="radio" name="bdWay" value="filters" ${fw ? '' : 'disabled'} style="margin-top:3px;">
                <span>Everything matching the filters on screen<br>
                  <span style="color:var(--text-faint); font-family:var(--font-mono); font-size:11px;">${fw ? esc(fw) : 'set a From/To or another filter first'}</span></span></label>
              <label style="display:flex; gap:9px; align-items:flex-start; cursor:${imports.length ? 'pointer' : 'not-allowed'}; opacity:${imports.length ? 1 : .45};">
                <input type="radio" name="bdWay" value="import" ${imports.length ? '' : 'disabled'} style="margin-top:3px;">
                <span>Everything from one import<br>
                  <select id="bdImport" ${imports.length ? '' : 'disabled'} style="margin-top:5px; font-size:11.5px; padding:5px 8px; max-width:100%;">
                    ${imports.map((b) => `<option value="${esc(b.batch)}">${esc(b.at || b.batch)} — ${b.bills} bills, ${b.sales} invoices${b.source ? ` (${esc(b.source)})` : ''}</option>`).join('')}
                  </select></span></label>
            </div>
            <label style="display:block; margin-top:16px; font-size:11px; font-family:var(--font-mono); letter-spacing:.08em; text-transform:uppercase; color:var(--text-muted);">Why (kept with the archived rows)</label>
            <input id="bdReason" placeholder="duplicate import, wrong year, typed twice&hellip;" style="width:100%; margin-top:5px; padding:8px 10px; font-size:12.5px;">
            <div id="bdPlan" style="margin-top:16px; font-size:12px; color:var(--text-muted);">Checking&hellip;</div>
          </div>
          <div class="modal-foot" style="padding:14px 22px; border-top:1px solid var(--border-subtle); display:flex; gap:9px; justify-content:flex-end;">
            <button id="bdCancel" class="btn btn-ghost" style="font-size:12px; padding:8px 16px;">Cancel</button>
            <button id="bdGo" class="btn btn-secondary" disabled style="font-size:12px; padding:8px 18px; border-color:var(--status-warn); color:var(--status-warn);">Delete</button>
          </div>
        </div>`;
      document.body.appendChild(back);
      const close = () => back.remove();
      back.querySelector('#bdCancel').onclick = close;
      back.addEventListener('click', (e) => { if (e.target === back) close(); });

      const selectorNow = () => {
        const way = back.querySelector('input[name="bdWay"]:checked').value;
        if (way === 'picked') return { ids: picked() };
        if (way === 'import') return { import_batch: back.querySelector('#bdImport').value };
        return { filters: f };
      };

      // ── THE PLAN IS ASKED FOR, NEVER GUESSED ────────────────────────
      // Which rows are refused depends on payments, credit notes and claims
      // the browser does not have. Working it out client-side would be a
      // second set of guards, drifting from the real ones.
      let planned = null;
      const recheck = async () => {
        const go = back.querySelector('#bdGo');
        const out = back.querySelector('#bdPlan');
        go.disabled = true;
        out.textContent = 'Checking\u2026';
        try {
          planned = await api('/api/ledger/bulk-delete/plan', {
            method: 'POST',
            body: JSON.stringify({ kind, selector: selectorNow(), reason: back.querySelector('#bdReason').value }) });
        } catch (e) {
          planned = null;
          out.innerHTML = `<span style="color:var(--status-warn);">${esc(e.message || 'Could not check')}</span>`;
          return;
        }
        const g = planned.going.length, r = planned.refused.length;
        out.innerHTML = `
          <div style="font-size:13px; color:var(--text-body);"><strong>${g}</strong> will be deleted${r ? `, <strong>${r}</strong> refused` : ''}.</div>
          ${r ? `<div style="margin-top:9px; max-height:170px; overflow-y:auto; border:1px solid var(--border-subtle); border-radius:var(--radius-sm); padding:9px 11px;">
            ${planned.refused.map((x) => `<div style="font-size:11.5px; color:var(--status-warn); margin-bottom:5px;">${esc(x.what || x.id)} — ${esc(x.why)}</div>`).join('')}
          </div>` : ''}`;
        go.disabled = g === 0;
        go.textContent = g ? `Delete ${g} row${g === 1 ? '' : 's'}` : 'Nothing to delete';
      };
      back.querySelectorAll('input[name="bdWay"]').forEach((el) => el.addEventListener('change', recheck));
      back.querySelector('#bdImport').addEventListener('change', recheck);
      await recheck();

      back.querySelector('#bdGo').onclick = async () => {
        const go = back.querySelector('#bdGo');
        go.disabled = true; go.textContent = 'Deleting\u2026';
        try {
          // The SELECTOR goes back, not the row list — see the route. The
          // server re-plans, so the guards are this instant's.
          const res = await api('/api/ledger/bulk-delete/commit', {
            method: 'POST',
            body: JSON.stringify({ kind, selector: selectorNow(), reason: back.querySelector('#bdReason').value }) });
          close();
          await renderLedgerTab(kind);
          if (res.removed) showUndo(res.batch, res.removed);
          else alert('Nothing was deleted — every row was refused.');
        } catch (e) {
          go.disabled = false; go.textContent = 'Delete';
          alert(e.message || 'Could not delete');
        }
      };
    };
  }

  // ── BACK TO THE TOP OF THE LIST ──────────────────────────────────────
  // Apsara, 2026-09-29: "There should be a arrow button in the bill/invoice
  // when i scroll down to move to the top bill".
  //
  // THE PART THAT IS EASY TO GET WRONG: this page does not scroll the window.
  // body is `overflow:hidden` (line ~74) and the scrolling element is
  // #viewRoot (`flex:1; overflow-y:auto`). window.scrollTo(0, 0) here does
  // nothing at all — the button would look right, press nicely and move the
  // page not one pixel. Everything below talks to #viewRoot.
  //
  // Scoped to this function on purpose. renderLedgerTab is reached only with
  // 'bills' and 'sales' (every call site checked), so the button exists on
  // the two ledgers she named and nowhere else. It lives INSIDE the tab's own
  // markup, so switching tabs removes it with the rest of the content.
  {
    const scroller = $('viewRoot');
    const btn = $('ledTop');
    if (scroller && btn) {
      // One listener, always. renderLedgerTab runs again on every filter
      // change, and #viewRoot outlives the tab — so without removing the
      // previous handler first, a morning of filtering leaves dozens of them
      // attached, all firing on every scroll event.
      if (scroller._ledTopHandler) scroller.removeEventListener('scroll', scroller._ledTopHandler);

      const SHOW_AFTER = 320;     // roughly one screen of rows
      const sync = () => {
        const on = scroller.scrollTop > SHOW_AFTER;
        btn.style.display = on ? 'flex' : 'none';
        btn.style.opacity = on ? '1' : '0';
        btn.style.transform = on ? 'translateY(0)' : 'translateY(6px)';
      };
      scroller._ledTopHandler = sync;
      scroller.addEventListener('scroll', sync, { passive: true });

      btn.onclick = () => {
        scroller.scrollTo({ top: 0, behavior: 'smooth' });
        // The filter box is where she usually goes next after jumping up.
        const q = document.querySelector('[data-led-filter="q"]');
        if (q) setTimeout(() => { try { q.focus({ preventScroll: true }); } catch (e) { q.focus(); } }, 320);
      };
      btn.onmouseenter = () => { btn.style.borderColor = 'var(--accent)'; };
      btn.onmouseleave = () => { btn.style.borderColor = 'var(--border-default)'; };

      // A re-render after she had scrolled down keeps the scroll position, so
      // decide the button's state now rather than waiting for the next scroll.
      sync();
    }
  }

  // ── WHICH BUILD AM I LOOKING AT ──────────────────────────────────────
  // Apsara, 2026-09-10, twice: "Why edit option not there in bills?" and then
  // "see no edit option". Both times the button was in the code and both
  // times she was running an older build — the second time I could only tell
  // by recognising the ORDER OF THE MARKUP in her screenshot as a fingerprint
  // of commit 7f16c64, which is a ridiculous way to answer the question.
  //
  // /api/health has reported the running commit for weeks. Nothing showed it
  // anywhere she would look, so "is this the new code?" was unanswerable from
  // the screen. Now it is one glance.
  //
  // Failure here is silent on purpose: not knowing the build must never stop
  // the table rendering.
  api('/api/health').then((h) => {
    const v = h && h.version;
    const el = $('ledBuild');
    if (!el || !v) return;
    // ── THE PAGE'S OWN BUILD, NOT JUST THE SERVER'S ────────────────────
    // Apsara, 2026-09-19: the footer said "build 9861a0d" while the fix in
    // 9861a0d was not on her screen. It was not lying — it reports the
    // SERVER's commit, and the markup around it came from a separately
    // cached file. A stale tab reporting the new build is worse than
    // reporting nothing, because it retires the only check there was.
    //
    // The server substitutes this meta at send time, so it describes THIS
    // COPY of the page. When the two disagree, the page is old.
    const meta = document.querySelector('meta[name="jarvis-build"]');
    const pageBuild = meta ? String(meta.content || '').trim() : '';
    const stale = pageBuild && pageBuild !== '{{JARVIS_BUILD}}' && pageBuild !== v.short;
    el.textContent = `build ${v.short}${v.dirty ? '+local' : ''} · `;
    el.title = `${v.subject || ''} — committed ${v.committed_at || '?'}, running since ${v.booted_at || '?'}`;
    if (stale) {
      el.textContent = `this page is build ${pageBuild}, the server is on ${v.short} — RELOAD · `;
      el.style.color = 'var(--status-warn, #d98324)';
      el.title = 'Your browser is showing an older copy of the page. Hard reload (Cmd+Shift+R).';
    }
  }).catch(() => {});

  wireMetalsTabs();
  if ($('btnFromBill')) $('btnFromBill').onclick = () => openFromBill();
  if ($('btnFollowups')) $('btnFollowups').onclick = () => openFollowups();
  if ($('btnPay')) $('btnPay').onclick = () => openBillPayForm();
  if ($('btnImport')) $('btnImport').onclick = () => openImportModal(kind);
  if ($('btnNameCleanup')) $('btnNameCleanup').onclick = () => openNameCleanup(kind === 'sales' ? 'customer' : 'supplier');

  // ── EXPORT WHAT IS ON SCREEN ─────────────────────────────────────────
  // Apsara, 2026-09-19: "Add export option to bill and invoice-export as xls
  // and pdf" — and, on what it should contain, exactly what is on screen.
  //
  // So it sends THE SAME query string the table was drawn with, built from
  // the same ledgerFilters object a line above. Re-deriving it would let the
  // file and the screen disagree about what "these rows" means, which is the
  // one thing an export must never do.
  //
  // A plain link, not api(): the response is a FILE, and api() parses every
  // response as JSON — it would swallow the workbook and throw.
  const exportTo = (format, btn) => {
    const qs = Object.entries(ledgerFilters[kind] || {})
      .filter(([, v]) => String(v || '').trim() !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    btn.disabled = true;
    const was = btn.innerHTML;
    btn.textContent = '…';
    // The PDF of 492 rows takes a few seconds and goes through the same
    // single-slot queue every other document does, so the button has to say
    // something is happening or she presses it again and joins the queue
    // twice. Released on a timer rather than on the download, because a
    // navigation-triggered download fires no event this page can see.
    const url = `/api/${kind === 'sales' ? 'sales' : 'bills'}/export?format=${format}${qs ? '&' + qs : ''}`;
    const a = document.createElement('a');
    a.href = url; a.download = '';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => { btn.disabled = false; btn.innerHTML = was; }, format === 'pdf' ? 4000 : 1500);
  };
  // ── ONE BUTTON, A MENU BEHIND IT ─────────────────────────────────────
  // Apsara, 2026-09-19: "for export i want to have a three dott button.so
  // export three dot button.on clicking it should show select box as
  // excel,pdf".
  //
  // Closed by a click anywhere else and by Escape, and the handler is removed
  // when it closes — a document-level listener left behind by every render of
  // this tab would accumulate one per visit and they all keep firing.
  if ($('btnExport')) {
    const btn = $('btnExport'), menu = $('exportMenu');
    let away = null;
    const shut = () => {
      menu.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
      if (away) { document.removeEventListener('click', away, true); document.removeEventListener('keydown', away); away = null; }
    };
    btn.onclick = (e) => {
      e.stopPropagation();
      if (!menu.classList.contains('hidden')) return shut();
      menu.classList.remove('hidden');
      btn.setAttribute('aria-expanded', 'true');
      // Asked for as the menu opens rather than on every table render: it is
      // one small request, and only when she is actually looking.
      loadUndoImport();
      away = (ev) => {
        if (ev.type === 'keydown') { if (ev.key === 'Escape') shut(); return; }
        if (!menu.contains(ev.target) && ev.target !== btn) shut();
      };
      document.addEventListener('click', away, true);
      document.addEventListener('keydown', away);
    };
    // ── THE LAST IMPORT, IF THERE IS ONE ──────────────────────────────
    // Failure is quiet HERE and only here: not knowing whether an import
    // exists must not stop her exporting, and the Import panel still lists
    // every batch with its own reason when it cannot load them.
    async function loadUndoImport() {
      const wrap = $('undoImportWrap');
      if (!wrap) return;
      try {
        const { batches } = await api('/api/import/batches');
        const last = (batches || [])[0];
        if (!last) { wrap.classList.add('hidden'); return; }
        $('undoImportWhat').textContent =
          `\u2014 ${esc(last.source || 'workbook')}, ${Number(last.bills || 0).toLocaleString('en-US')} bills`
          + ` and ${Number(last.sales || 0).toLocaleString('en-US')} invoices`;
        $('btnUndoImport').dataset.batch = last.batch;
        wrap.classList.remove('hidden');
      } catch (e) { wrap.classList.add('hidden'); }
    }
    if ($('btnUndoImport')) {
      $('btnUndoImport').onclick = async (e) => {
        e.stopPropagation();
        const b = e.currentTarget;
        const batch = b.dataset.batch;
        if (!batch) return;
        if (!confirm(`Remove every row that came from this import?\n\n${batch}\n\n`
          + 'Rows typed by hand are not touched. This needs the Jarvis profile.')) return;
        b.disabled = true; b.textContent = 'Undoing…';
        try {
          const r = await api('/api/import/' + encodeURIComponent(batch), { method: 'DELETE' });
          shut();
          await renderLedgerTab(kind);
          alert(`Undone — ${Number(r.removed || 0).toLocaleString('en-US')} rows removed.`);
        } catch (err) {
          b.disabled = false; b.textContent = 'Undo last import';
          alert(err.message || 'Could not undo that import.');
        }
      };
    }

    menu.querySelectorAll('.exp-opt').forEach((opt) => {
      opt.onmouseenter = () => { opt.style.background = 'var(--bg-sunken)'; };
      opt.onmouseleave = () => { opt.style.background = 'none'; };
      opt.onclick = (e) => { e.stopPropagation(); shut(); exportTo(opt.dataset.format, btn); };
    });
  }
  $('btnAddLedger').onclick = () => openLedgerForm(kind);
  // ── EDIT ─────────────────────────────────────────────────────────────
  // Apsara, 2026-09-10: "i want edit option in bill". Until now a typo in a
  // seal number meant deleting the row and typing all 18 fields again.
  //
  // The SAME form does both — one place that knows how a bill is laid out,
  // so an edit form cannot drift from the add form the way two copies would.
  // The row is taken from what is already on screen rather than re-fetched:
  // it is the row she clicked, and a second GET could hand back a different
  // one if something changed underneath.
  // ── THE ROW MENU ────────────────────────────────────────────────────
  // Apsara, 2026-09-19: "i dont want something like button keep on piling
  // up.perhaps a small icon ..on clicking,these button should expand."
  //
  // ONE listener on the table, not one per row. 651 rows x 4 buttons was
  // 2,600 handlers bound on every render, and binding them is a measurable
  // part of why this tab is slow — the same reason the export menu is built
  // once and shown, rather than built per row.
  //
  // The menu is built at CLICK time from the row she clicked, so which items
  // appear can depend on that row (Receive payment only where money is
  // owed) without every row paying for the decision up front.
  const actionsFor = (row) => {
    const items = [];
    if (kind === 'sales' && row.balance !== null && row.balance > 0.005) {
      items.push(['Receive payment', () => openMarkPaid(row)]);
    }
    if (kind === 'sales') {
      items.push(['Generate invoice & email', () => openGenerateInvoice(row)]);
    }
    items.push(['Edit', () => openLedgerForm(kind, row)]);
    items.push(['Delete', async () => {
      if (!confirm('Delete this row?')) return;
      try {
        await api(`${K.path}/${encodeURIComponent(row.id)}`, { method: 'DELETE' });
        renderLedgerTab(kind);
      } catch (e) { alert(e.message || 'Could not delete'); }
    }, 'danger']);
    return items;
  };

  const closeRowMenu = () => { const m = $('rowMenu'); if (m) m.remove(); };

  // ── NOT capture: true ───────────────────────────────────────────────
  // The dismiss-on-outside-click listener must run AFTER the icon's own
  // handler, not before it. On capture it ran first, so a second click on
  // the SAME icon removed the menu and then the handler — finding nothing
  // open — drew it again. The icon could open the menu and never close it.
  //
  // On the bubble phase the handler's stopPropagation keeps this listener
  // from seeing clicks on the icon at all, which is exactly the intent: an
  // outside click closes, the icon itself toggles.

  // ── CLICK A BILL TO SEE EVERYTHING ABOUT IT (2026-10-02) ──────────────
  // Apsara: "when i click the bill,if it has multiple rows,i want this to
  // expand". The eighteen columns the table no longer shows live in the
  // panel under the row, grouped as the server groups them.
  //
  // THE WHOLE ROW IS THE TARGET, not a chevron: a 7px-tall triangle is a
  // thing to aim at, and she is doing this on a laptop trackpad all day.
  //
  // EXCEPT where a click already means something else. A click on the tick
  // box, on the actions menu, or on a link inside a cell must do THAT and
  // not also unfold the row — selecting three bills to delete and having the
  // page grow by three panels underneath is the opposite of help.
  document.querySelectorAll('tr.ledRow').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('input, button, a, label, select')) return;
      const detail = document.querySelector(`tr.ledDetail[data-for="${CSS.escape(tr.dataset.id || '')}"]`);
      if (!detail) return;
      const open = detail.style.display !== 'none';
      detail.style.display = open ? 'none' : '';
      // The row itself shows it is open, so a long panel still has a visible
      // owner once the heading has scrolled past.
      tr.style.background = open ? '' : 'var(--surface-sunken)';
    });
  });

  document.querySelectorAll('.row-menu-btn').forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const already = $('rowMenu');
      closeRowMenu();
      // A second click on the same button closes it rather than redrawing
      // it — otherwise the icon has no way to undo itself.
      if (already && already.dataset.for === b.dataset.id) return;

      const row = (ledgerState.rows || []).find((r) => r.id === b.dataset.id);
      if (!row) return;
      const L = LEDGER_LIGHT;
      const items = actionsFor(row);
      const rect = b.getBoundingClientRect();
      document.body.insertAdjacentHTML('beforeend', `
        <div id="rowMenu" data-for="${esc(row.id)}" style="position:fixed; z-index:9200;
             background:${L.sunken}; border:1px solid ${L.line}; border-radius:var(--radius-sm);
             box-shadow:0 10px 30px rgba(0,0,0,.45); min-width:190px; padding:4px;">
          ${items.map(([label, , tone], i) => `
            <button data-i="${i}" style="display:block; width:100%; text-align:left; padding:7px 11px;
              background:none; border:none; cursor:pointer; font-size:12px; border-radius:4px;
              color:${tone === 'danger' ? L.danger : L.ink};">${esc(label)}</button>`).join('')}
        </div>`);
      const menu = $('rowMenu');
      // Placed after it exists, so its real height decides whether it opens
      // upward — a menu on the last row of a long table must not be drawn
      // off the bottom of the window where she cannot reach it.
      const h = menu.offsetHeight, w = menu.offsetWidth;
      const top = (rect.bottom + h > window.innerHeight - 8) ? Math.max(8, rect.top - h - 4) : rect.bottom + 4;
      menu.style.top = `${top}px`;
      menu.style.left = `${Math.max(8, Math.min(rect.right - w, window.innerWidth - w - 8))}px`;
      menu.querySelectorAll('button').forEach((mb) => {
        mb.onmouseenter = () => { mb.style.background = L.paper; };
        mb.onmouseleave = () => { mb.style.background = 'none'; };
        mb.onclick = (e2) => {
          e2.stopPropagation();
          const fn = items[Number(mb.dataset.i)][1];
          closeRowMenu();
          fn();
        };
      });
      document.addEventListener('click', closeRowMenu, { once: true });
      document.addEventListener('keydown', function esc3(e3) {
        if (e3.key !== 'Escape') return;
        closeRowMenu();
        document.removeEventListener('keydown', esc3);
      });
    };
  });

  // ── .ledger-receive / .ledger-edit / .ledger-del ARE GONE ───────────
  // Their three querySelectorAll loops were deleted with the markup on
  // 2026-09-19, not left behind. Nothing renders those classes any more, so
  // a loop over them binds nothing while looking exactly like working code —
  // and the next person to change how a row is deleted would edit the copy
  // that never runs. Everything they did now lives in actionsFor() above.
}

// ── THE SHEET, IN TWO PALETTES ───────────────────────────────────────────
// Apsara, 2026-09-10: "i want light colour on that bill", then — shown three
// palettes side by side and asked which — "B but give an option to toggle to
// C as well".
//
// B is the paper one: warm off-white, soft borders, BLUE for money and for
// Save. The green it replaces is the dark app's accent doing a job it was not
// designed for: a green button beside a black amount on a stark white sheet
// is the specific thing that read as wrong.
//
// C is the app's own dark, for when a light panel in a dark app is the thing
// that grates. Her choice, remembered per browser.
//
// ONE OBJECT, TWO VALUES. Every form in the Edge Metals set reads these keys
// and nothing else — no form carries a hex of its own — so a third palette
// would be twelve lines here and nothing anywhere else. The status colours
// live here too for the same reason: they were hardcoded in eleven places,
// which is eleven places to miss when the sheet goes dark and that red stops
// being readable.
const LEDGER_THEMES = {
  paper: {
    paper: '#FFFFFF', sunken: '#FBFBFA', line: '#DAD7D2', lineSoft: '#E7E5E1',
    ink: '#1C1B19', inkMuted: '#6B6862', inkFaint: '#8C8983',
    accent: '#185FA5', accentInk: '#FFFFFF',
    danger: '#A32D2D', ok: '#0F6E56', warn: '#854F0B',
  },
  dark: {
    paper: '#1B2126', sunken: '#14181B', line: '#2A3036', lineSoft: '#232A30',
    ink: '#E8EDF0', inkMuted: '#93A1AA', inkFaint: '#6E7A83',
    accent: '#378ADD', accentInk: '#FFFFFF',
    danger: '#F09595', ok: '#5DCAA5', warn: '#EF9F27',
  },
};

// Which one is showing. `let`, because the toggle swaps it and re-renders —
// the forms read it at render time, so nothing needs to know it changed.
let LEDGER_THEME_NAME = (() => {
  try { return localStorage.getItem('ledgerTheme') === 'dark' ? 'dark' : 'paper'; }
  catch (e) { return 'paper'; }   // private mode, embedded webview, whatever
})();
let LEDGER_LIGHT = LEDGER_THEMES[LEDGER_THEME_NAME];

// ── ONE HANDLER FOR EVERY COPY OF THE BUTTON ─────────────────────────────
// Delegated on the document rather than wired per form: seven forms carry the
// toggle and an eighth will be added without remembering to bind it. Re-renders
// whatever is currently open by closing and reopening it — the forms read the
// palette at render time, so there is nothing to repaint in place.
if (typeof window !== 'undefined' && !window.__ledThemeWired) {
  window.__ledThemeWired = true;
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('#ledTheme');
    if (!btn) return;
    setLedgerTheme(LEDGER_THEME_NAME === 'dark' ? 'paper' : 'dark');
    // Reopen whatever is showing. Each form registers how to rebuild itself
    // when it opens (ledgerReopen below) — a repaint threaded through seven
    // forms would be seven places to miss a colour, and the forms read the
    // palette at render time anyway. Nothing typed is lost on the bill form
    // because it autosaves; the payment forms are short.
    if (typeof ledgerReopen === 'function') ledgerReopen();
  });
}

// ── THE SPECS ────────────────────────────────────────────────────────────
// Apsara, 2026-09-29: "Next to toggle dark mode,add specs emoji.on clicking
// it,font size of the page should increase to larger than current size.On
// toggling off,it should get back to old font size".
//
// ── WHY THIS IS A ZOOM AND NOT A FONT SIZE, SAID PLAINLY ─────────────────
// Almost every size in this file is an inline `font-size:13px`. Raising the
// root font-size would move the handful of rem/em values and leave the
// ledger tables, the cards and the forms — which is to say the page —
// exactly as they were. It would look like the button did nothing.
//
// `zoom` scales the rendered result, so everything grows together and the
// layout stays in proportion. It does mean padding and icons grow too, not
// only the text. For reading glasses that is the behaviour you want; it is
// still not literally what she asked for, so it is written down here rather
// than quietly relabelled.
//
// ONE STEP, NOT A SLIDER. She asked for on and off.
const BIG_ZOOM = 1.18;
let LEDGER_BIG = (() => {
  try { return localStorage.getItem('ledgerBigFont') === '1'; } catch (e) { return false; }
})();

function applyBigFont() {
  const el = document.documentElement;
  if (!el) return;
  // Cleared to '' rather than set to '1' — an explicit zoom of 1 still makes
  // the element a zoom container, and anything she sets in the browser's own
  // zoom would then compound oddly against it.
  el.style.zoom = LEDGER_BIG ? String(BIG_ZOOM) : '';
  document.querySelectorAll('#ledBig').forEach((b) => {
    b.setAttribute('aria-pressed', LEDGER_BIG ? 'true' : 'false');
    b.title = LEDGER_BIG ? 'Back to the normal size' : 'Make everything bigger';
  });
}

function setBigFont(on) {
  LEDGER_BIG = !!on;
  try { localStorage.setItem('ledgerBigFont', LEDGER_BIG ? '1' : '0'); } catch (e) { /* not fatal */ }
  applyBigFont();
}

// Delegated for the same reason the theme button is: the control appears in
// seven forms and an eighth will arrive without anyone remembering to bind it.
//
// It does NOT call ledgerReopen. The theme button has to, because the forms
// bake the palette into their markup at render time; a zoom is applied by the
// browser to what is already on screen, so reopening would only throw away
// whatever she had half-typed.
if (typeof window !== 'undefined' && !window.__ledBigWired) {
  window.__ledBigWired = true;
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('#ledBig');
    if (!btn) return;
    setBigFont(!LEDGER_BIG);
  });
  // The saved choice has to be put back on load, or it lasts until reload and
  // she has to press it every morning.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyBigFont);
  } else { applyBigFont(); }
}

// Set by whichever Edge Metals form is open, cleared when it closes.
let ledgerReopen = null;

// A function, not the const, because a top-level `const` is in scope for this
// script and is NOT a property of window — so tests (and anything else
// outside) cannot see it. Learned the hard way on salesSubTab, which a test
// read as undefined and happily compared against.
function ledgerTheme() { return LEDGER_LIGHT; }

function setLedgerTheme(name) {
  LEDGER_THEME_NAME = LEDGER_THEMES[name] ? name : 'paper';
  LEDGER_LIGHT = LEDGER_THEMES[LEDGER_THEME_NAME];
  try { localStorage.setItem('ledgerTheme', LEDGER_THEME_NAME); } catch (e) {}
}

// The control itself, so every form shows the same one in the same place.
function ledgerThemeToggle() {
  const L = LEDGER_LIGHT;
  const on = LEDGER_THEME_NAME === 'dark';
  // The specs sit beside it — "Next to toggle dark mode,add specs emoji".
  // Same size and border so the pair reads as one control, and the emoji is
  // given an aria-label because a screen reader announcing "eyeglasses" is
  // not an instruction.
  return `<button id="ledTheme" title="${on ? 'Switch to the paper sheet' : 'Switch to the dark sheet'}"
    aria-label="Switch sheet colour"
    style="background:none; border:1px solid ${L.line}; border-radius:var(--radius-sm); padding:3px 9px; font-size:11px; color:${L.inkMuted}; cursor:pointer;">${on ? 'Paper' : 'Dark'}</button>`
    + `<button id="ledBig" aria-pressed="${LEDGER_BIG ? 'true' : 'false'}"
    title="${LEDGER_BIG ? 'Back to the normal size' : 'Make everything bigger'}"
    aria-label="${LEDGER_BIG ? 'Back to the normal size' : 'Make everything bigger'}"
    style="background:${LEDGER_BIG ? L.line : 'none'}; border:1px solid ${L.line}; border-radius:var(--radius-sm); padding:3px 9px; font-size:11px; line-height:1.3; color:${L.inkMuted}; cursor:pointer; margin-left:5px;">\u{1F453}</button>`;
}

// ── PAYMENT FOLLOW-UPS (Apsara, 2026-10-26) ──────────────────────────────
// One draft per customer who owes Edge Metals, asking for payment status and the remittance details.
// Customers on ETA-based terms (ETA-10, ETA+7 …) are listed underneath and get no draft. NOTHING IS SENT from
// here: Copy, or Open in mail. Her "option 1"; sending is a later step.
async function openFollowups() {
  const L = LEDGER_LIGHT;
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const data = await api('/api/payment-followups');
  const drafts = data.drafts || [], waiting = data.waiting_eta || [];
  document.body.insertAdjacentHTML('beforeend', `
    <div id="pfModal" style="position:fixed; inset:0; background:rgba(0,0,0,.66); z-index:9100; display:flex; align-items:flex-start; justify-content:center; overflow-y:auto; padding:40px 16px;">
      <div class="card" style="width:min(780px,100%); padding:20px 22px 18px; background:${L.sunken}; border-color:${L.line};">
        <div style="display:flex; align-items:baseline; justify-content:space-between; margin-bottom:4px;">
          <h3 style="margin:0; font-size:16px; text-transform:none; color:${L.ink};">Payment follow-ups</h3>
          <button id="pfClose" aria-label="Close" style="background:none; border:none; color:${L.inkMuted}; font-size:22px; line-height:1; cursor:pointer;">&times;</button>
        </div>
        <div style="font-size:12px; color:${L.inkFaint}; margin-bottom:12px;">
          ${data.open_invoices || 0} open invoice${data.open_invoices === 1 ? '' : 's'}, ${money(data.total_outstanding)} outstanding.
          ${drafts.length} draft${drafts.length === 1 ? '' : 's'} below (${money(data.drafted_total)}) — <b>nothing is sent from here</b>.
        </div>
        <div id="pfDrafts">${drafts.length ? drafts.map((d, i) => `
          <div class="pfCard" style="background:${L.paper}; border:1px solid ${L.line}; border-radius:var(--radius-sm); padding:12px 14px; margin-bottom:10px;">
            <div style="display:flex; gap:10px; align-items:baseline; flex-wrap:wrap;">
              <b style="color:${L.ink};">${esc(d.customer)}</b>
              <span style="font-size:11px; padding:1px 7px; border-radius:9px; border:1px solid ${L.line}; color:${L.inkMuted};">${d.kind === 'payment' ? 'payment due · ' + esc(d.eta_terms) : 'remittance status'}</span>
              <span style="font-size:12px; color:${L.inkMuted};">${d.count} invoice${d.count === 1 ? '' : 's'} · ${money(d.total)}</span>
              <span style="font-size:12px; color:${d.to_missing ? L.danger : L.inkFaint};">${d.to_missing ? 'no single email in the address book' : 'to ' + esc(d.to)}</span>
              <span style="flex:1"></span>
              <input class="pfEta" data-customer="${esc(d.customer)}" placeholder="ETA terms e.g. ETA-10" style="width:150px; padding:4px 8px; font-size:12px;" title="Customers on ETA-based terms get no draft. Type ETA-10 or ETA+7 and press Enter.">
            </div>
            <textarea class="pfBody" data-i="${i}" rows="11" style="width:100%; margin-top:8px; font-size:12px; font-family:var(--font-mono); padding:8px;">${esc(d.body)}</textarea>
            <div style="display:flex; gap:8px; margin-top:8px;">
              <button class="btn btn-secondary pfCopy" data-i="${i}" style="font-size:12px; padding:6px 12px;">Copy</button>
              <button class="btn btn-secondary pfMail" data-i="${i}" style="font-size:12px; padding:6px 12px;">Open in mail</button>
            </div>
          </div>`).join('') : `<div style="padding:16px; text-align:center; font-size:12px; color:${L.inkFaint};">Nobody needs chasing.</div>`}</div>
        ${waiting.length ? `<div style="margin-top:14px; font-size:12px; color:${L.inkMuted};"><b>On ETA-based terms — not yet (${waiting.length})</b> <span style="color:${L.inkFaint};">a draft starts ${data.lead_days || 11} days before each invoice's vessel ETA (from the booking)</span>
          ${waiting.map((s) => `<div style="display:flex; gap:10px; padding:4px 0; border-bottom:1px solid ${L.lineSoft};"><span style="flex:1;">${esc(s.customer)}${(s.eta_unknown || []).length ? ` <span style="color:${L.danger};">· no ETA on the booking for ${esc(s.eta_unknown.join(', '))}</span>` : ''}</span><span style="font-family:var(--font-mono);">${esc(s.eta_terms)}</span><span>${s.next_draft ? 'draft from ' + esc(s.next_draft) : ''}</span><span>${s.count} · ${money(s.total)}</span><a href="#" class="pfEtaClear" data-customer="${esc(s.customer)}" style="color:${L.danger};">remove terms</a></div>`).join('')}</div>` : ''}
        <div id="pfErr" style="color:${L.danger}; font-size:11px; margin-top:8px;"></div>
      </div>
    </div>`);
  const close = () => { const m = $('pfModal'); if (m) m.remove(); document.removeEventListener('keydown', esc2); };
  const esc2 = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc2);
  $('pfClose').onclick = close;
  const bodyOf = (i) => document.querySelector(`.pfBody[data-i="${i}"]`).value;   // what is in the box, edits included
  document.querySelectorAll('.pfCopy').forEach((b) => { b.onclick = async () => {
    try { await navigator.clipboard.writeText(bodyOf(b.dataset.i)); b.textContent = 'Copied'; } catch (e) { $('pfErr').textContent = 'Could not copy — select the text and copy it by hand.'; } }; });
  document.querySelectorAll('.pfMail').forEach((b) => { b.onclick = () => {
    const d = drafts[b.dataset.i];
    const q = `subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(bodyOf(b.dataset.i))}${d.cc ? '&cc=' + encodeURIComponent([].concat(d.cc).join(',')) : ''}`;
    window.location.href = `mailto:${encodeURIComponent(d.to || '')}?${q}`; }; });
  const setTerms = async (customer, value) => {
    try { await api('/api/payment-followups/terms', { method: 'PUT', body: JSON.stringify({ customer, eta_terms: value }) }); close(); openFollowups(); }
    catch (e) { $('pfErr').textContent = e.message || 'Could not save'; }
  };
  document.querySelectorAll('.pfEta').forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && el.value.trim()) setTerms(el.dataset.customer, el.value.trim()); }));
  document.querySelectorAll('.pfEtaClear').forEach((el) => el.addEventListener('click', (e) => { e.preventDefault(); setTerms(el.dataset.customer, ''); }));
}

// ── SELLING A CONTAINER SHE ALREADY BOUGHT ───────────────────────────────
// Apsara, 2026-09-10, asked how a Sales row is created: "From the matching
// Bill." It carries the container number across instead of having it typed a
// second time, which is the only reason margin-per-container can be worked
// out at all — a typo here breaks the join in silence: no error, just a
// container that cost something and earned nothing.
//
// Bills already sold are shown and NOT offered. A second sales row on one
// container would double-count on that same join.
async function openFromBill() {
  const L = LEDGER_LIGHT;
  const data = await api('/api/sales/sellable');
  const rows = data.bills || [];
  const money = (n) => (n === null || n === undefined) ? '—'
    : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  document.body.insertAdjacentHTML('beforeend', `
    <div id="fbModal" style="position:fixed; inset:0; background:rgba(0,0,0,.66); z-index:9100; display:flex; align-items:flex-start; justify-content:center; overflow-y:auto; padding:32px 16px;">
      <div class="card" style="width:min(700px,100%); padding:20px 22px 18px; background:${L.sunken}; border-color:${L.line};">
        <div style="display:flex; align-items:baseline; justify-content:space-between; margin-bottom:4px;">
          <h3 style="margin:0; font-size:16px; text-transform:none; color:${L.ink};">New invoice from a bill</h3>
          ${ledgerThemeToggle()}
          <button id="fbClose" aria-label="Close" style="background:none; border:none; color:${L.inkMuted}; font-size:22px; line-height:1; cursor:pointer;">&times;</button>
        </div>
        <div style="font-size:12px; color:${L.inkFaint}; margin-bottom:14px;">Which container are you selling?</div>
        <div style="background:${L.paper}; border:1px solid ${L.line}; border-radius:var(--radius-sm); max-height:360px; overflow-y:auto;">
          ${rows.length ? rows.map((b) => `
            <button class="fbPick" data-id="${esc(b.id)}" ${b.sold ? 'disabled' : ''}
              style="display:flex; width:100%; align-items:center; gap:10px; padding:9px 12px; background:none; border:none; border-bottom:1px solid ${L.lineSoft}; text-align:left; cursor:${b.sold ? 'default' : 'pointer'}; opacity:${b.sold ? '.45' : '1'};">
              <span style="font-family:var(--font-mono); font-size:11px; color:${L.inkMuted}; width:82px;">${esc(b.booking_no || '—')}</span>
              <span style="font-family:var(--font-mono); font-size:12px; color:${L.ink}; width:110px;">${esc(b.container_no)}</span>
              <span style="flex:1; font-size:12px; color:${L.inkMuted}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(b.supplier || '')}${b.description ? ' · ' + esc(b.description) : ''}</span>
              <span style="font-family:var(--font-mono); font-size:11px; color:${L.inkFaint};">${money(b.amount)}</span>
              ${b.sold ? `<span style="font-size:10px; color:${L.ok};">sold</span>` : ''}
            </button>`).join('')
            : `<div style="padding:18px; text-align:center; font-size:12px; color:${L.inkFaint};">No bills with a container number yet.</div>`}
        </div>
        <div style="margin-top:10px; font-size:11px; color:${L.inkFaint};">
          ${data.unsold || 0} of ${rows.length} not sold yet. Nothing here? Use Add invoice for a container that never had a bill.
        </div>
        <div id="fbErr" style="color:${L.danger}; font-size:11px; margin-top:8px;"></div>
      </div>
    </div>`);

  const close = () => { const m = $('fbModal'); if (m) m.remove(); document.removeEventListener('keydown', esc2); };
  const esc2 = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc2);
  $('fbClose').onclick = close;
  ledgerReopen = () => { close(); openFromBill(); };

  document.querySelectorAll('.fbPick').forEach((b) => {
    if (b.disabled) return;
    b.onclick = async () => {
      try {
        const r = await api(`/api/sales/from-bill/${encodeURIComponent(b.dataset.id)}`);
        if (r.already_sold) {
          $('fbErr').textContent = 'That container already has an invoice against it.';
          return;
        }
        close();
        // A SUGGESTION into the ordinary add form — nothing is saved until
        // she presses save, same contract as pre-filling a bill from a
        // booking.
        openLedgerForm('sales', null, r.suggestion);
      } catch (e) { $('fbErr').textContent = e.message || 'Could not read that bill'; }
    };
  });
}

// ══ GENERATE: THE INVOICE, THEN THE EMAIL ═══════════════════════════════
//
// Apsara, 2026-09-19:
//
//   "if all important details of bills is entered,if i say create invoice(it
//    needs to ask-separate invoice and packing list/normal) -upon my
//    confirmation-it needs to create automatically (get verfiication from me
//    by showing that on screen)andupon confirm- mail it to the customer with
//    loading photos"
//
//   "first need to show the generated invoice then draft mail"
//
// Three steps, in her order, and she can stop at any of them:
//
//   1  ASK      separate invoice and packing list, or normal
//   2  LOOK     the real PDF, the figures, and anything odd about it
//   3  SEND     the actual email, with the actual address, before it goes
//
// ── WHY STEP 2 SHOWS THE PDF AND NOT A SUMMARY ──────────────────────────
// Because a summary is something I would have written, and the customer
// does not receive my summary. 260918_AP_26ARIS02 went out saying 15,642 MT;
// the only artefact that could ever have shown that is the document itself.
// The iframe is the file that is going to be attached, fetched back from
// disk through the same download route she uses everywhere else.
//
// ── AND WHY IT DOES NOT AUTO-ADVANCE ────────────────────────────────────
// Each step needs a press. "upon my confirmation" and "upon confirm" are two
// separate confirmations in her sentence, and collapsing them into one would
// mean the last thing she pressed was about the PDF while the thing that
// happened was an email to a buyer.
