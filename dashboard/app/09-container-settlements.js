// dashboard/app/09-container-settlements.js — split from dashboard/index.html's <script> (helpers/sourceParts.js reconstructs the original)
async function openTruckingPay(data, company) {
  const L = LEDGER_LIGHT;
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const all = (data.open_payables || []);
  const fieldCss = `width:100%; height:34px; padding:0 10px; background:${L.paper}; border:1px solid ${L.line}; border-radius:var(--radius-sm); color:${L.ink}; outline:none; font-size:13px;`;
  const lab = `display:block; font-size:11px; color:${L.inkMuted}; margin-bottom:5px; white-space:nowrap;`;

  if (!company) {
    const by = new Map();
    for (const r of all) {
      const n = String(r.trucking_company || '').trim();
      if (!n) continue;
      const cur = by.get(n) || { name: n, count: 0, owed: 0 };
      cur.count += 1; cur.owed = Math.round((cur.owed + (Number(r.balance) || 0)) * 100) / 100;
      by.set(n, cur);
    }
    const list = [...by.values()].sort((a, b) => b.owed - a.owed);
    document.body.insertAdjacentHTML('beforeend', `
      <div id="trkWho" style="position:fixed; inset:0; background:rgba(0,0,0,.66); z-index:9100; display:flex; align-items:flex-start; justify-content:center; overflow-y:auto; padding:32px 16px;">
        <div class="card" style="width:min(560px,100%); padding:20px 22px 18px; background:${L.sunken}; border-color:${L.line};">
          <div style="display:flex; align-items:baseline; justify-content:space-between; margin-bottom:4px;">
            <h3 style="margin:0; font-size:16px; text-transform:none; color:${L.ink};">Pay a trucker</h3>
            ${ledgerThemeToggle()}
            <button id="trkWhoClose" aria-label="Close" style="background:none; border:none; color:${L.inkMuted}; font-size:22px; line-height:1; cursor:pointer;">&times;</button>
          </div>
          <div style="font-size:12px; color:${L.inkFaint}; margin-bottom:14px;">Who are you paying?</div>
          <div style="background:${L.paper}; border:1px solid ${L.line}; border-radius:var(--radius-sm); max-height:320px; overflow-y:auto;">
            ${list.length ? list.map((c) => `
              <button class="trkWhoPick" data-company="${esc(c.name)}" style="display:flex; width:100%; align-items:center; gap:10px; padding:10px 12px; background:none; border:none; border-bottom:1px solid ${L.lineSoft}; cursor:pointer; text-align:left;">
                <span style="flex:1; font-size:13px; color:${L.ink};">${esc(c.name)}</span>
                <span style="font-size:11px; color:${L.inkFaint};">${c.count} haul${c.count === 1 ? '' : 's'}</span>
                <span style="font-family:var(--font-mono); font-size:12px; color:${L.ink};">${money(c.owed)} owing</span>
              </button>`).join('')
              : `<div style="padding:18px; text-align:center; font-size:12px; color:${L.inkFaint};">Nothing outstanding.</div>`}
          </div>
        </div>
      </div>`);
    const closeWho = () => { const m = $('trkWho'); if (m) m.remove(); };
    $('trkWhoClose').onclick = closeWho;
    ledgerReopen = () => { closeWho(); openTruckingPay(data); };
    document.querySelectorAll('.trkWhoPick').forEach((b) => {
      b.onclick = () => { closeWho(); openTruckingPay(data, b.dataset.company); };
    });
    return;
  }

  const open = all.filter((r) => String(r.trucking_company || '').trim().toLowerCase() === String(company).trim().toLowerCase());
  document.body.insertAdjacentHTML('beforeend', `
    <div id="trkModal" style="position:fixed; inset:0; background:rgba(0,0,0,.66); z-index:9100; display:flex; align-items:flex-start; justify-content:center; overflow-y:auto; padding:32px 16px;">
      <div class="card" style="width:min(860px,100%); padding:20px 22px 18px; background:${L.sunken}; border-color:${L.line};">
        <div style="display:flex; align-items:baseline; justify-content:space-between; margin-bottom:14px;">
          <h3 style="margin:0; font-size:16px; text-transform:none; color:${L.ink};">Pay ${esc(company)}</h3>
          ${ledgerThemeToggle()}
          <button id="trkClose" aria-label="Close" style="background:none; border:none; color:${L.inkMuted}; font-size:22px; line-height:1; cursor:pointer;">&times;</button>
        </div>
        <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; margin-bottom:14px;">
          <div><label style="${lab}">Date</label><input id="trkDate" placeholder="MM/DD/YYYY" autocomplete="off" style="${fieldCss}"></div>
          <div><label style="${lab}">Amount sent</label><input id="trkAmount" inputmode="decimal" autocomplete="off" style="${fieldCss} text-align:right; font-family:var(--font-mono);"></div>
          <div><label style="${lab}">How</label><select id="trkMode" style="${fieldCss}">${(data.modes || []).map((m) => `<option>${esc(m)}</option>`).join('')}</select></div>
          <div id="trkBankField"><label style="${lab}">From</label><select id="trkBank" style="${fieldCss}">${(data.banks || []).map((b) => `<option>${esc(b)}</option>`).join('')}</select></div>
          <div><label style="${lab}">Reference</label><input id="trkRef" autocomplete="off" style="${fieldCss}"></div>
        </div>
        <div style="font-size:12px; color:${L.inkFaint}; margin:14px 0 6px;">Which hauls does it cover?</div>
        <div style="background:${L.paper}; border:1px solid ${L.line}; border-radius:var(--radius-sm); max-height:260px; overflow-y:auto;">
          <table style="width:100%; border-collapse:collapse;"><tbody id="trkRows">${open.length ? open.map((r) => `
            <tr data-bill="${esc(r.bill_id)}" style="border-top:1px solid ${L.lineSoft};">
              <td style="padding:6px 8px;"><input type="checkbox" class="trkPick" data-bill="${esc(r.bill_id)}"></td>
              <td style="padding:6px 8px; font-size:12px; font-family:var(--font-mono); color:${L.inkMuted};">${esc(r.date || '')}</td>
              <td style="padding:6px 8px; font-size:12px; font-family:var(--font-mono); color:${L.ink};">${esc(r.container_no || r.booking_no || '')}</td>
              <td style="padding:6px 8px; font-size:12px; text-align:right; font-family:var(--font-mono); color:${L.inkMuted};">${money(r.balance)}${
                r.paid > 0.005 ? `<div style="font-size:10px; color:${L.inkFaint};">${money(r.paid)} paid of ${money(r.amount)}</div>` : ''}</td>
              <td style="padding:6px 8px;"><input class="trkAmt" data-bill="${esc(r.bill_id)}" data-balance="${esc(r.balance)}" inputmode="decimal" autocomplete="off" style="width:110px; height:28px; padding:0 8px; text-align:right; font-family:var(--font-mono); font-size:12px; background:${L.paper}; border:1px solid ${L.line}; border-radius:var(--radius-sm); color:${L.ink}; outline:none;"></td>
            </tr>`).join('') : `<tr><td style="padding:18px; text-align:center; font-size:12px; color:${L.inkFaint};">Nothing owing to ${esc(company)}.</td></tr>`}</tbody></table>
        </div>
        <div style="border-top:1px solid ${L.line}; padding-top:13px; margin-top:14px; display:flex; align-items:flex-end; gap:24px; flex-wrap:wrap;">
          <div><div style="font-size:11px; color:${L.inkFaint};">Allocated</div><div id="trkAllocated" style="font-size:17px; font-weight:500; font-family:var(--font-mono); color:${L.ink};">$0.00</div></div>
          <div><div style="font-size:11px; color:${L.inkFaint};">Still to allocate</div><div id="trkLeft" style="font-size:17px; font-weight:500; font-family:var(--font-mono); color:${L.ink};">$0.00</div></div>
          <div style="flex:1;"></div>
          <button id="trkCancel" class="btn btn-secondary" style="font-size:11px; padding:8px 16px; background:${L.paper}; color:${L.inkMuted}; border-color:${L.line};">Cancel</button>
          <button id="trkSave" class="btn btn-primary" style="font-size:11px; padding:8px 20px; background:${L.accent}; border-color:${L.accent}; color:${L.accentInk};">Record payment</button>
        </div>
        <div id="trkErr" style="color:${L.danger}; font-size:11px; margin-top:8px;"></div>
      </div>
    </div>`);

  $('trkDate').value = toUsDate(todayYardDateStr());
  wireUsDateField('trkDate');
  const close = () => { const m = $('trkModal'); if (m) m.remove(); document.removeEventListener('keydown', esc2); };
  const esc2 = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc2);
  $('trkClose').onclick = close; $('trkCancel').onclick = close;
  ledgerReopen = () => { close(); openTruckingPay(data, company); };

  const num = (v) => { const n = parseFloat(String(v || '').replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; };
  const allocs = () => [...document.querySelectorAll('.trkAmt')]
    .map((el) => ({ bill_id: el.dataset.bill, amount: num(el.value) })).filter((a) => a.amount > 0);
  const retotal = () => {
    const sent = num($('trkAmount').value);
    const a = allocs().reduce((t, x) => t + x.amount, 0);
    const left = Math.round((sent - a) * 100) / 100;
    $('trkAllocated').textContent = money(a);
    $('trkLeft').textContent = money(left);
    $('trkLeft').style.color = left < -0.005 ? L.danger : (Math.abs(left) < 0.005 ? L.ok : L.ink);
    const ok = sent > 0 && Math.abs(left) < 0.005;
    $('trkSave').disabled = !ok;
    $('trkSave').style.opacity = ok ? '1' : '.45';
    const m = $('trkMode').value;
    if ($('trkBankField')) $('trkBankField').style.display = (m === 'Wire' || m === 'Zelle') ? '' : 'none';
  };
  document.querySelectorAll('.trkPick').forEach((cb) => {
    cb.onchange = () => {
      const amt = document.querySelector(`.trkAmt[data-bill="${cb.dataset.bill}"]`);
      if (!amt) return;
      if (cb.checked) {
        const sent = num($('trkAmount').value);
        const already = allocs().reduce((t, x) => t + x.amount, 0);
        const room = sent > 0 ? Math.max(0, sent - already) : Infinity;
        const bal = num(amt.dataset.balance);
        amt.value = (room === Infinity ? bal : Math.min(bal, room)).toFixed(2);
      } else { amt.value = ''; }
      retotal();
    };
  });
  document.querySelectorAll('.trkAmt').forEach((el) => { el.oninput = retotal; });
  $('trkAmount').oninput = retotal;
  $('trkMode').onchange = retotal;
  retotal();

  $('trkSave').onclick = async () => {
    $('trkErr').textContent = '';
    try {
      const mode = $('trkMode').value;
      await api('/api/metals-trucking', { method: 'POST', body: JSON.stringify({
        date: $('trkDate').value, amount: $('trkAmount').value, mode,
        bank: (mode === 'Wire' || mode === 'Zelle') ? $('trkBank').value : '',
        ref: $('trkRef').value, trucking_company: company, allocations: allocs(),
      }) });
      close();
      renderMetalsTruckingTab();
    } catch (e) { $('trkErr').textContent = e.message || 'Could not record it'; }
  };
}

// ── INCOMING, FREIGHT, COMMISSION ────────────────────────────────────────
// Three screens over the SAME container rows. Freight and Commission read
// helpers/salesSettlements.payables(), which derives both from the charge
// list and the commission rate on the row — so there is exactly one place
// each of those numbers is decided, and a tab cannot disagree with the tab
// beside it.
async function renderSalesSubTab(which) {
  metalsTab.sales = which;
  const [eyebrow, title] = SALES_TAB_TITLES[which] || ['Invoice', which];
  const root = $('viewRoot');
  root.innerHTML = `
    <div style="max-width:100%; margin:0 auto; padding:34px 28px 80px;">
      <div style="margin-bottom:14px;">
        <div class="eyebrow">${esc(eyebrow)}</div>
        <h2 style="font-size:19px; text-transform:uppercase; margin:0;">${esc(title)}</h2>
      </div>
      ${metalsTabBar('sales')}
      <div id="subBody" style="color:var(--text-muted); font-size:13px;">Loading…</div>
    </div>`;
  wireMetalsTabs();
  try {
    if (which === 'incoming') await renderIncoming();
    else if (which === 'margin') await renderMargin();
    else await renderPayables(which);
  } catch (e) {
    $('subBody').innerHTML = `<div style="color:var(--status-warn); font-size:13px;">${esc(e.message || 'could not load')}</div>`;
  }
}

const salesMoney = (n) => (n === null || n === undefined || isNaN(Number(n)))
  ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── WHAT EACH CONTAINER MADE ─────────────────────────────────────────────
// Every figure comes from the server, which gets each one from the single
// place that decides it. Nothing here does arithmetic except reading the
// answer — a second opinion about her formulas would be free to drift from
// the first.
let marginFilters = {};

async function renderMargin() {
  const qs = Object.entries(marginFilters).filter(([, v]) => String(v || '').trim() !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const data = await api('/api/margin' + (qs ? `?${qs}` : ''));
  const rows = data.rows || [];
  const sum = data.summary || {};
  const facets = data.facets || {};
  const un = data.unjoinable || { bills: [], sales: [] };
  const active = Object.values(marginFilters).filter((v) => String(v || '').trim() !== '').length;

  const card = (label, value, tone) => `
    <div class="card" style="padding:12px;">
      <div style="font-family:var(--font-mono); font-size:9px; letter-spacing:.12em; text-transform:uppercase; color:var(--text-muted);">${label}</div>
      <div style="font-size:16px; font-weight:700; margin-top:4px; ${tone ? `color:${tone};` : ''}">${value}</div>
    </div>`;

  const sel = (key, label, opts, width) => `
    <div>
      <div style="font-family:var(--font-mono); font-size:9px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted); margin-bottom:4px;">${label}</div>
      <select data-mg-filter="${key}" style="width:${width}px; padding:7px 9px; background:var(--surface-card); border:1px solid var(--border-default); border-radius:var(--radius-sm); color:var(--text-strong); outline:none; font-size:12px;">
        <option value="">All</option>
        ${(opts || []).map((o) => `<option value="${esc(o)}" ${marginFilters[key] === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
      </select></div>`;

  const state = (r) => {
    const map = { closed: ['var(--text-muted)', 'closed'],
                  bought: ['var(--status-warn)', 'not sold yet'],
                  sold: ['var(--status-warn)', 'no bill'] };
    const [c, t] = map[r.state] || map.closed;
    return `<span style="font-size:10px; padding:2px 8px; border-radius:var(--radius-sm); border:1px solid ${c}; color:${c};">${t}</span>`;
  };

  $('subBody').innerHTML = `
    <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:8px; margin-bottom:12px;">
      ${card('Revenue', ledMoney(sum.revenue))}
      ${card('Cost', ledMoney(sum.cost))}
      ${card('Margin', ledMoney(sum.margin),
             (sum.margin || 0) < 0 ? 'var(--status-danger)' : 'var(--status-good, #4ade80)')}
      ${card('Margin %', sum.margin_pct === null || sum.margin_pct === undefined ? '—' : `${sum.margin_pct}%`)}
      ${card('Closed', `${sum.closed || 0} of ${sum.count || 0}`)}
      ${sum.conflicted ? card('Duplicated', ledNum(sum.conflicted), 'var(--status-danger)') : ''}
    </div>

    <div style="display:flex; flex-wrap:wrap; gap:8px; align-items:flex-end; margin-bottom:14px; padding:12px 14px; border:1px solid var(--border-subtle); border-radius:var(--radius-sm); background:var(--surface-sunken);">
      ${sel('state', 'State', data.states, 120)}
      ${sel('customer', 'Customer', facets.customer, 150)}
      ${sel('supplier', 'Supplier', facets.supplier, 150)}
      <button id="mgClear" class="btn btn-secondary" style="font-size:11px; padding:8px 14px;">Clear</button>
      <div style="flex:1;"></div>
      <div style="font-family:var(--font-mono); font-size:10px; color:var(--text-faint); padding-bottom:9px;">
        ${active ? `${active} filter${active === 1 ? '' : 's'} · ` : ''}${rows.length} of ${data.total_unfiltered ?? rows.length}
      </div>
    </div>

    ${(un.bills.length || un.sales.length) ? `
      <div style="margin-bottom:12px; padding:9px 12px; border:1px solid var(--status-warn); border-radius:var(--radius-sm); font-size:12px; color:var(--status-warn);">
        ${un.bills.length ? `${un.bills.length} bill${un.bills.length === 1 ? '' : 's'}` : ''}${un.bills.length && un.sales.length ? ' and ' : ''}${un.sales.length ? `${un.sales.length} invoice${un.sales.length === 1 ? '' : 's'}` : ''} carry no container number, so ${un.bills.length + un.sales.length === 1 ? 'it can' : 'they can'} never be matched. Add one and ${un.bills.length + un.sales.length === 1 ? 'it appears' : 'they appear'} here.
      </div>` : ''}

    <div class="card" style="padding:0; overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse; font-size:12px;">
        <thead><tr style="background:var(--bg-sunken);">
          ${['Booking', 'Container', 'Supplier', 'Customer', 'Bought', 'Trucking', 'Sold', 'Charges', 'Commission', 'Margin', '/MT', '']
            .map((h, i) => `<th style="padding:8px 9px; text-align:${i >= 4 && i <= 10 ? 'right' : 'left'}; white-space:nowrap; font-family:var(--font-mono); font-size:9px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted);">${h}</th>`).join('')}
        </tr></thead>
        <tbody>${rows.length ? rows.map((r) => `
          <tr data-key="${esc(r.key)}" style="border-top:1px solid var(--line);">
            <td style="padding:7px 9px; font-family:var(--font-mono); color:var(--text-muted);">${ledText(r.booking_no)}</td>
            <td style="padding:7px 9px; font-family:var(--font-mono);">${ledText(r.container_no)}</td>
            <td style="padding:7px 9px; white-space:nowrap;">${ledText(r.supplier)}</td>
            <td style="padding:7px 9px; white-space:nowrap;">${ledText(r.customer)}</td>
            <td style="padding:7px 9px; text-align:right; font-family:var(--font-mono);">${ledMoney(r.bill_amount)}</td>
            <td style="padding:7px 9px; text-align:right; font-family:var(--font-mono); color:var(--text-muted);">${ledMoney(r.trucking)}</td>
            <td style="padding:7px 9px; text-align:right; font-family:var(--font-mono);">${ledMoney(r.invoice_amount)}</td>
            <td style="padding:7px 9px; text-align:right; font-family:var(--font-mono); color:var(--text-muted);" title="${esc((r.charges_in || 0) ? `${ledMoney(r.charges_in)} billed to the customer` : 'nothing billed on')}">${ledMoney(r.charges_out)}</td>
            <td style="padding:7px 9px; text-align:right; font-family:var(--font-mono); color:var(--text-muted);">${ledMoney(r.commission)}</td>
            <td style="padding:7px 9px; text-align:right; font-family:var(--font-mono); ${r.margin === null ? 'color:var(--text-faint);' : ((r.margin < 0) ? 'color:var(--status-danger);' : 'color:var(--status-good, #4ade80);')}">${r.margin === null ? '—' : ledMoney(r.margin)}${r.margin_pct === null ? '' : `<div style="font-size:10px; color:var(--text-muted);">${r.margin_pct}%</div>`}</td>
            <td style="padding:7px 9px; text-align:right; font-family:var(--font-mono); color:var(--text-muted);">${r.margin_per_mt === null ? '—' : ledMoney(r.margin_per_mt)}</td>
            <td style="padding:7px 9px;">${(r.duplicate_bill_ids || []).length || (r.duplicate_sale_ids || []).length
              ? `<span title="More than one row claims this container — this margin uses only one of them" style="font-size:10px; color:var(--status-danger);">duplicated</span>`
              : ''}${r.state === 'closed' ? (r.weight_gap ? `<span title="Bought ${ledNum(r.bought_weight_lb)} lbs, sold ${ledNum(r.sold_weight_lb)}" style="font-size:10px; color:var(--status-warn);">${ledNum(r.weight_gap)} lb gap</span>` : '') : state(r)}</td>
          </tr>`).join('')
          : `<tr><td colspan="12" style="padding:26px; text-align:center; color:var(--text-faint); font-family:var(--font-mono); font-size:12px;">${active ? 'Nothing matches those filters.' : 'No container has both a bill and an invoice yet.'}</td></tr>`}</tbody>
      </table>
    </div>
    <div style="margin-top:10px; font-family:var(--font-mono); font-size:10px; color:var(--text-faint);">
      Margin is invoice + charges billed on, less supplier, trucking, charges paid and commission · only a container with both sides carries a figure · totals cover closed containers only
    </div>`;

  document.querySelectorAll('[data-mg-filter]').forEach((el) => {
    el.onchange = () => { marginFilters[el.dataset.mgFilter] = el.value; renderMargin(); };
  });
  $('mgClear').onclick = () => { marginFilters = {}; renderMargin(); };
}

async function renderIncoming() {
  const data = await api('/api/sales-receipts');
  const rows = (data.receipts || []).slice().reverse();
  const sum = data.summary || {};
  const open = data.open_invoices || [];
  const owed = open.reduce((t, x) => t + (Number(x.balance) || 0), 0);

  $('subBody').innerHTML = `
    <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin-bottom:14px;">
      ${[['Received', salesMoney(sum.received)], ['Still owed', salesMoney(owed)],
         ['Bank charges', salesMoney(sum.bank_charges)], ['Discounts', salesMoney(sum.discounts)]]
        .map(([l, v]) => `<div class="card" style="padding:12px;">
          <div style="font-family:var(--font-mono); font-size:9px; letter-spacing:.12em; text-transform:uppercase; color:var(--text-muted);">${l}</div>
          <div style="font-size:16px; font-weight:700; margin-top:4px;">${v}</div></div>`).join('')}
    </div>
    <div style="display:flex; justify-content:flex-end; margin-bottom:10px;">
      <button id="btnReceipt" class="btn btn-primary" style="font-size:12px; padding:8px 14px;">Record receipt</button>
    </div>
    <div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse; font-size:12px;">
      <thead><tr style="color:var(--text-muted); text-align:left;">
        ${['Date', 'Customer', 'How', 'Into', 'Reference', 'Containers', 'Amount', ''].map((h, i) => `<th style="padding:6px 9px; font-weight:400; ${i === 6 ? 'text-align:right;' : ''}">${h}</th>`).join('')}
      </tr></thead>
      <tbody>${rows.length ? rows.map((r) => `
        <tr data-receipt="${esc(r.id)}" style="border-top:1px solid var(--line);">
          <td style="padding:7px 9px; font-family:var(--font-mono);">${esc(r.date || '')}</td>
          <td style="padding:7px 9px;">${esc(r.customer || '')}</td>
          <td style="padding:7px 9px;">${esc(r.mode || '')}</td>
          <td style="padding:7px 9px; color:var(--text-muted);">${esc(r.bank || '—')}</td>
          <td style="padding:7px 9px; color:var(--text-muted);">${esc(r.ref || '—')}</td>
          <td style="padding:7px 9px; color:var(--text-muted);">${(r.allocations || []).length}${
            (r.allocations || []).some((a) => a.deduction_amount) ? ` · ${salesMoney((r.allocations || []).reduce((t, a) => t + (Number(a.deduction_amount) || 0), 0))} deducted` : ''}</td>
          <td style="padding:7px 9px; text-align:right; font-family:var(--font-mono);">${salesMoney(r.amount)}</td>
          <td style="padding:7px 9px;">${metalsCanDelete() ? `<button class="rcpt-del" data-id="${esc(r.id)}" style="background:none; border:1px solid var(--line); border-radius:var(--radius-sm); padding:3px 9px; font-size:10px; color:var(--status-warn); cursor:pointer;">Delete</button>` : `<span title="Sign in with the Jarvis profile to remove a receipt" style="font-size:10px; color:var(--text-faint);">&mdash;</span>`}</td>
        </tr>`).join('')
        : `<tr><td colspan="8" style="padding:22px; text-align:center; color:var(--text-muted);">Nothing received yet.</td></tr>`}</tbody>
    </table></div>`;

  $('btnReceipt').onclick = () => openReceiptForm(data);
  document.querySelectorAll('.rcpt-del').forEach((b) => {
    b.onclick = async () => {
      if (b.dataset.armed !== '1') {
        document.querySelectorAll('.rcpt-del').forEach((x) => { x.dataset.armed = ''; x.textContent = 'Delete'; });
        b.dataset.armed = '1'; b.textContent = 'Delete — reopens its containers?';
        setTimeout(() => { if (b.dataset.armed === '1') { b.dataset.armed = ''; b.textContent = 'Delete'; } }, 5000);
        return;
      }
      await api(`/api/sales-receipts/${encodeURIComponent(b.dataset.id)}`, { method: 'DELETE' });
      loadTab('sales-incoming');
    };
  });
}

// Freight and Commission are the same screen over a filtered payables list.
// Written once: they differ by which rows and which columns, and two copies
// would have drifted the first time a settle rule changed.
async function renderPayables(which) {
  const data = await api('/api/sales-settlements');
  const all = (data.payables || []).filter((p) => which === 'commission'
    ? p.kind === 'commission' : p.kind === 'charge');
  const outstanding = all.reduce((t, p) => t + Math.max(0, Number(p.balance) || 0), 0);
  const total = all.reduce((t, p) => t + (Number(p.amount) || 0), 0);

  // A settlement belongs on this tab if ANY of its allocations is this kind.
  // Newest first, the same way the receipts and bill-payment lists read.
  const wantKind = which === 'commission' ? 'commission' : 'charge';
  const settlementsHere = [...(data.settlements || [])]
    .filter((s) => (s.allocations || []).some((a) => a && a.kind === wantKind))
    .reverse();

  $('subBody').innerHTML = `
    <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin-bottom:14px;">
      ${[[which === 'commission' ? 'Commission' : 'Charges', salesMoney(total)],
         ['Outstanding', salesMoney(outstanding)],
         ['Lines', String(all.length)]]
        .map(([l, v]) => `<div class="card" style="padding:12px;">
          <div style="font-family:var(--font-mono); font-size:9px; letter-spacing:.12em; text-transform:uppercase; color:var(--text-muted);">${l}</div>
          <div style="font-size:16px; font-weight:700; margin-top:4px;">${v}</div></div>`).join('')}
    </div>
    <div style="display:flex; justify-content:flex-end; margin-bottom:10px;">
      <button id="btnSettle" class="btn btn-primary" style="font-size:12px; padding:8px 14px;">Pay</button>
    </div>
    <div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse; font-size:12px;">
      <thead><tr style="color:var(--text-muted); text-align:left;">
        <th style="padding:6px 9px; font-weight:400;">Booking</th>
        <th style="padding:6px 9px; font-weight:400;">Container</th>
        <th style="padding:6px 9px; font-weight:400;">HBL</th>
        <th style="padding:6px 9px; font-weight:400;">${which === 'commission' ? 'Basis' : 'What'}</th>
        <th style="padding:6px 9px; font-weight:400; text-align:right;">Amount</th>
        <th style="padding:6px 9px; font-weight:400; text-align:right;">Paid</th>
        <th style="padding:6px 9px; font-weight:400; text-align:right;">Outstanding</th>
      </tr></thead>
      <tbody>${all.length ? all.map((p) => `
        <tr style="border-top:1px solid var(--line);">
          <td style="padding:7px 9px; font-family:var(--font-mono);">${esc(p.booking_no || '—')}</td>
          <td style="padding:7px 9px; font-family:var(--font-mono);">${esc(p.container_no || '—')}</td>
          <td style="padding:7px 9px; color:var(--text-muted);">${esc(p.hbl_no || '—')}</td>
          <td style="padding:7px 9px;">${esc(which === 'commission' ? p.why : p.what)}${
            which === 'commission' ? '' : `<div style="font-size:10px; color:var(--text-muted); white-space:normal; max-width:340px;">${esc(p.why || '')}</div>`}</td>
          <td style="padding:7px 9px; text-align:right; font-family:var(--font-mono);">${salesMoney(p.amount)}</td>
          <td style="padding:7px 9px; text-align:right; font-family:var(--font-mono); color:var(--text-muted);">${salesMoney(p.paid)}</td>
          <td style="padding:7px 9px; text-align:right; font-family:var(--font-mono); color:${p.balance > 0.005 ? 'var(--text-primary)' : 'var(--status-good, #4ade80)'};">${p.balance > 0.005 ? salesMoney(p.balance) : 'settled'}</td>
        </tr>`).join('')
        : `<tr><td colspan="7" style="padding:22px; text-align:center; color:var(--text-muted);">Nothing here yet. ${which === 'commission' ? 'Set a commission rate on a container.' : 'Add a charge you pay to a container.'}</td></tr>`}</tbody>
    </table></div>

    <!-- ── THE SETTLEMENTS THEMSELVES ──────────────────────────────────
         Apsara, 2026-10-03: "I want jarvis profile to have access to delete
         payments on edge metals."

         DELETE /api/sales-settlements/:id is requireSuper and has never had
         a caller. This screen listed what is OWED and what has been paid
         against it, with no row for the payment itself — so a settlement
         entered against the wrong charge could be seen in the Paid column
         and not reached. The route removes it, unwinds the mirrored ledger
         row and audits it; data.settlements was already on the response.

         SHOWN BY WHICH KIND IT TOUCHES, since one settlement may cover a
         charge AND a commission. A mixed one appears on both tabs and says
         so on each, because deleting it from here removes its other half
         too and that is not a thing to discover afterwards. -->
    ${settlementsHere.length ? `
    <div style="margin-top:22px;">
      <div style="font-family:var(--font-mono); font-size:9px; letter-spacing:.12em; text-transform:uppercase; color:var(--text-muted); margin-bottom:7px;">Payments recorded</div>
      <div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse; font-size:12px;">
        <thead><tr style="color:var(--text-muted); text-align:left;">
          <th style="padding:6px 9px; font-weight:400;">Date</th>
          <th style="padding:6px 9px; font-weight:400;">Paid to</th>
          <th style="padding:6px 9px; font-weight:400;">How</th>
          <th style="padding:6px 9px; font-weight:400;">Reference</th>
          <th style="padding:6px 9px; font-weight:400;">Covers</th>
          <th style="padding:6px 9px; font-weight:400; text-align:right;">Amount</th>
          <th style="padding:6px 9px; font-weight:400;"></th>
        </tr></thead>
        <tbody>${settlementsHere.map((s) => {
          const mixed = (s.allocations || []).some((a) => a.kind !== (which === 'commission' ? 'commission' : 'charge'));
          return `
          <tr style="border-top:1px solid var(--line);">
            <td style="padding:7px 9px; white-space:nowrap; font-family:var(--font-mono);">${esc(s.date || '—')}</td>
            <td style="padding:7px 9px;">${esc(s.payee || '—')}</td>
            <td style="padding:7px 9px; white-space:nowrap;">${esc(s.mode || '')}${s.bank ? ' · ' + esc(s.bank) : ''}</td>
            <td style="padding:7px 9px; color:var(--text-muted);">${esc(s.ref || '—')}</td>
            <td style="padding:7px 9px; white-space:nowrap; color:var(--text-muted);">${(s.allocations || []).length} line${(s.allocations || []).length === 1 ? '' : 's'}${
              mixed ? `<span title="This payment also covers the other tab — removing it here removes all of it" style="color:var(--status-warn);"> · spans both</span>` : ''}</td>
            <td style="padding:7px 9px; text-align:right; font-family:var(--font-mono);">${salesMoney(s.amount)}</td>
            <td style="padding:7px 9px; white-space:nowrap;">${metalsCanDelete()
              ? `<button class="stlEdit" data-id="${esc(s.id)}" style="background:none; border:1px solid var(--line); border-radius:var(--radius-sm); padding:3px 9px; font-size:10px; color:var(--text-body); cursor:pointer; margin-right:6px;">Edit</button>`
                + `<button class="stlDel" data-id="${esc(s.id)}" data-who="${esc(s.payee || '')}" data-amount="${esc(salesMoney(s.amount))}" data-lines="${(s.allocations || []).length}" data-mixed="${mixed ? '1' : ''}" style="background:none; border:1px solid var(--line); border-radius:var(--radius-sm); padding:3px 9px; font-size:10px; color:var(--status-warn); cursor:pointer;">Delete</button>`
              : `<span title="Sign in with the Jarvis profile to change a payment" style="font-size:10px; color:var(--text-faint);">&mdash;</span>`}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
    </div>` : ''}`;

  $('btnSettle').onclick = () => openSettleForm(data, which);

  document.querySelectorAll('.stlDel').forEach((btn) => {
    btn.onclick = async () => {
      const n = Number(btn.dataset.lines) || 0;
      const ok = confirm(`Remove the ${btn.dataset.amount} payment to ${btn.dataset.who}?\n\n`
        + `${n} line${n === 1 ? '' : 's'} go back to outstanding, and the payment disappears `
        + 'from the spend report.'
        + (btn.dataset.mixed ? '\n\nThis payment also covers the other tab. ALL of it is removed, not just the part shown here.' : '')
        + '\n\nThis is written to the audit log.');
      if (!ok) return;
      btn.disabled = true;
      try {
        await api(`/api/sales-settlements/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
        await renderPayables(which);
      } catch (e) {
        btn.disabled = false;
        alert(e.message || 'Could not remove that payment.');
      }
    };
  });

  // ── CHANGING ONE ─────────────────────────────────────────────────────
  // Commission and freight, the other two cost types she named. Both live in
  // one store, so one button serves both tabs.
  //
  // A settlement that SPANS both tabs is already refused by editPaymentFlow,
  // because spanning means more than one allocation — the "spans both" warning
  // on Delete has no twin here for that reason, not by omission.
  document.querySelectorAll('.stlEdit').forEach((btn) => {
    btn.onclick = () => editPaymentFlow({
      btn,
      id: btn.dataset.id,
      row: (data.settlements || []).find((s) => String(s.id) === String(btn.dataset.id)),
      preview: (body) => api('/api/sales-settlements/' + encodeURIComponent(btn.dataset.id) + '/preview-edit',
                             { method: 'POST', body }),
      save: (body) => api('/api/sales-settlements/' + encodeURIComponent(btn.dataset.id),
                          { method: 'PUT', body }),
      noun: 'lines',
      elsewhere: 'Record a payment on this tab',
      reload: () => renderPayables(which),
    });
  });
}

// ── ONE RECEIPT, SEVERAL CONTAINERS ──────────────────────────────────────
// The customer-side twin of openBillPayForm. Same rule, same reason: it asks
// WHO PAID first, then lists only that customer's outstanding containers.
// A TT from Daekwang ticked against a container invoiced to someone else is a
// false statement about who is square, and the route refuses it — this is the
// step that means she never gets told off for it.
async function openReceiptForm(data, customer) {
  const L = LEDGER_LIGHT;
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const all = data.open_invoices || [];
  const fieldCss = `width:100%; height:34px; padding:0 10px; background:${L.paper}; border:1px solid ${L.line}; border-radius:var(--radius-sm); color:${L.ink}; outline:none; font-size:13px;`;
  const lab = `display:block; font-size:11px; color:${L.inkMuted}; margin-bottom:5px; white-space:nowrap;`;

  if (!customer) {
    const by = new Map();
    for (const x of all) {
      const n = String(x.customer || '').trim();
      if (!n) continue;
      const cur = by.get(n) || { name: n, count: 0, owed: 0 };
      cur.count += 1; cur.owed = Math.round((cur.owed + (Number(x.balance) || 0)) * 100) / 100;
      by.set(n, cur);
    }
    const list = [...by.values()].sort((a, b) => b.owed - a.owed);
    document.body.insertAdjacentHTML('beforeend', `
      <div id="rcWho" style="position:fixed; inset:0; background:rgba(0,0,0,.66); z-index:9100; display:flex; align-items:flex-start; justify-content:center; overflow-y:auto; padding:32px 16px;">
        <div class="card" style="width:min(560px,100%); padding:20px 22px 18px; background:${L.sunken}; border-color:${L.line};">
          <div style="display:flex; align-items:baseline; justify-content:space-between; margin-bottom:4px;">
            <h3 style="margin:0; font-size:16px; text-transform:none; color:${L.ink};">Record receipt</h3>
            <button id="rcWhoClose" aria-label="Close" style="background:none; border:none; color:${L.inkMuted}; font-size:22px; line-height:1; cursor:pointer;">&times;</button>
          </div>
          <div style="font-size:12px; color:${L.inkFaint}; margin-bottom:14px;">Who paid?</div>
          <div style="background:${L.paper}; border:1px solid ${L.line}; border-radius:var(--radius-sm); max-height:320px; overflow-y:auto;">
            ${list.length ? list.map((c) => `
              <button class="rcWhoPick" data-customer="${esc(c.name)}" style="display:flex; width:100%; align-items:center; gap:10px; padding:10px 12px; background:none; border:none; border-bottom:1px solid ${L.lineSoft}; cursor:pointer; text-align:left;">
                <span style="flex:1; font-size:13px; color:${L.ink};">${esc(c.name)}</span>
                <span style="font-size:11px; color:${L.inkFaint};">${c.count} container${c.count === 1 ? '' : 's'}</span>
                <span style="font-family:var(--font-mono); font-size:12px; color:${L.ink};">${money(c.owed)} owing</span>
              </button>`).join('')
              : `<div style="padding:18px; text-align:center; font-size:12px; color:${L.inkFaint};">Nothing outstanding.</div>`}
          </div>
        </div>
      </div>`);
    const closeWho = () => { const m = $('rcWho'); if (m) m.remove(); };
    $('rcWhoClose').onclick = closeWho;
    document.querySelectorAll('.rcWhoPick').forEach((b) => {
      b.onclick = () => { closeWho(); openReceiptForm(data, b.dataset.customer); };
    });
    return;
  }

  const open = all.filter((x) => String(x.customer || '').trim().toLowerCase() === String(customer).trim().toLowerCase());
  document.body.insertAdjacentHTML('beforeend', `
    <div id="rcModal" style="position:fixed; inset:0; background:rgba(0,0,0,.66); z-index:9100; display:flex; align-items:flex-start; justify-content:center; overflow-y:auto; padding:32px 16px;">
      <div class="card" style="width:min(860px,100%); padding:20px 22px 18px; background:${L.sunken}; border-color:${L.line};">
        <div style="display:flex; align-items:baseline; justify-content:space-between; margin-bottom:14px;">
          <h3 style="margin:0; font-size:16px; text-transform:none; color:${L.ink};">Receipt — ${esc(customer)}</h3>
          ${ledgerThemeToggle()}
          <button id="rcClose" aria-label="Close" style="background:none; border:none; color:${L.inkMuted}; font-size:22px; line-height:1; cursor:pointer;">&times;</button>
        </div>
        <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; margin-bottom:14px;">
          <div><label style="${lab}">Received on</label><input id="rcDate" placeholder="MM/DD/YYYY" autocomplete="off" style="${fieldCss}"></div>
          <div><label style="${lab}">Amount arrived</label><input id="rcAmount" inputmode="decimal" autocomplete="off" style="${fieldCss} text-align:right; font-family:var(--font-mono);"></div>
          <div><label style="${lab}">How</label><select id="rcMode" style="${fieldCss}">${(data.modes || []).map((m) => `<option>${esc(m)}</option>`).join('')}</select></div>
          <div id="rcBankField"><label style="${lab}">Into</label><select id="rcBank" style="${fieldCss}">${(data.banks || []).map((b) => `<option>${esc(b)}</option>`).join('')}</select></div>
          <div><label style="${lab}">Reference</label><input id="rcRef" autocomplete="off" style="${fieldCss}"></div>
        </div>
        <div style="font-size:12px; color:${L.inkFaint}; margin:14px 0 6px;">Which containers does it cover?</div>
        <div style="background:${L.paper}; border:1px solid ${L.line}; border-radius:var(--radius-sm); max-height:260px; overflow-y:auto;">
          <table style="width:100%; border-collapse:collapse;">
            <tbody id="rcRows">${open.length ? open.map((b) => `
              <tr data-sale="${esc(b.id)}" style="border-top:1px solid ${L.lineSoft};">
                <td style="padding:6px 8px;"><input type="checkbox" class="rcPick" data-sale="${esc(b.id)}"></td>
                <td style="padding:6px 8px; font-size:12px; font-family:var(--font-mono); color:${L.inkMuted};">${esc(b.booking_no || '')}</td>
                <td style="padding:6px 8px; font-size:12px; font-family:var(--font-mono); color:${L.ink};">${esc(b.container_no || b.invoice_no || '')}</td>
                <td style="padding:6px 8px; font-size:12px; text-align:right; font-family:var(--font-mono); color:${L.inkMuted};">${money(b.balance)}</td>
                <td style="padding:6px 8px;"><input class="rcAmt" data-sale="${esc(b.id)}" data-balance="${esc(b.balance)}" inputmode="decimal" autocomplete="off" style="width:110px; height:28px; padding:0 8px; text-align:right; font-family:var(--font-mono); font-size:12px; background:${L.paper}; border:1px solid ${L.line}; border-radius:var(--radius-sm); color:${L.ink}; outline:none;"></td>
              </tr>`).join('') : `<tr><td style="padding:18px; text-align:center; font-size:12px; color:${L.inkFaint};">Nothing owing from ${esc(customer)}.</td></tr>`}</tbody>
          </table>
        </div>
        <div style="border-top:1px solid ${L.line}; padding-top:13px; margin-top:14px; display:flex; align-items:flex-end; gap:24px; flex-wrap:wrap;">
          <div><div style="font-size:11px; color:${L.inkFaint};">Allocated</div><div id="rcAllocated" style="font-size:17px; font-weight:500; font-family:var(--font-mono); color:${L.ink};">$0.00</div></div>
          <div><div style="font-size:11px; color:${L.inkFaint};">Still to allocate</div><div id="rcLeft" style="font-size:17px; font-weight:500; font-family:var(--font-mono); color:${L.ink};">$0.00</div></div>
          <div style="flex:1;"></div>
          <button id="rcCancel" class="btn btn-secondary" style="font-size:11px; padding:8px 16px; background:${L.paper}; color:${L.inkMuted}; border-color:${L.line};">Cancel</button>
          <button id="rcSave" class="btn btn-primary" style="font-size:11px; padding:8px 20px; background:${L.accent}; border-color:${L.accent}; color:${L.accentInk};">Record it</button>
        </div>
        <div id="rcErr" style="color:${L.danger}; font-size:11px; margin-top:8px;"></div>
      </div>
    </div>`);

  $('rcDate').value = toUsDate(todayYardDateStr());
  wireUsDateField('rcDate');
  const close = () => { const m = $('rcModal'); if (m) m.remove(); document.removeEventListener('keydown', esc2); };
  const esc2 = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc2);
  $('rcClose').onclick = close; $('rcCancel').onclick = close;
  ledgerReopen = () => { close(); openReceiptForm(data, customer); };

  const num = (v) => { const n = parseFloat(String(v || '').replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; };
  const allocs = () => [...document.querySelectorAll('.rcAmt')]
    .map((el) => ({ sale_id: el.dataset.sale, amount: num(el.value) })).filter((a) => a.amount > 0);
  const retotal = () => {
    const sent = num($('rcAmount').value);
    const a = allocs().reduce((t, x) => t + x.amount, 0);
    const left = Math.round((sent - a) * 100) / 100;
    $('rcAllocated').textContent = money(a);
    $('rcLeft').textContent = money(left);
    $('rcLeft').style.color = left < -0.005 ? L.danger : (Math.abs(left) < 0.005 ? L.ok : L.ink);
    const ok = sent > 0 && Math.abs(left) < 0.005;
    $('rcSave').disabled = !ok;
    $('rcSave').style.opacity = ok ? '1' : '.45';
    const m = $('rcMode').value;
    if ($('rcBankField')) $('rcBankField').style.display = (m === 'Wire' || m === 'Zelle') ? '' : 'none';
  };
  document.querySelectorAll('.rcPick').forEach((cb) => {
    cb.onchange = () => {
      const amt = document.querySelector(`.rcAmt[data-sale="${cb.dataset.sale}"]`);
      if (!amt) return;
      if (cb.checked) {
        const sent = num($('rcAmount').value);
        const already = allocs().reduce((t, x) => t + x.amount, 0);
        const room = sent > 0 ? Math.max(0, sent - already) : Infinity;
        const bal = num(amt.dataset.balance);
        amt.value = (room === Infinity ? bal : Math.min(bal, room)).toFixed(2);
      } else { amt.value = ''; }
      retotal();
    };
  });
  document.querySelectorAll('.rcAmt').forEach((el) => { el.oninput = retotal; });
  $('rcAmount').oninput = retotal;
  $('rcMode').onchange = retotal;
  retotal();

  $('rcSave').onclick = async () => {
    $('rcErr').textContent = '';
    try {
      const mode = $('rcMode').value;
      await api('/api/sales-receipts', { method: 'POST', body: JSON.stringify({
        date: $('rcDate').value, amount: $('rcAmount').value, mode,
        bank: (mode === 'Wire' || mode === 'Zelle') ? $('rcBank').value : '',
        ref: $('rcRef').value, customer, allocations: allocs(),
      }) });
      close();
      loadTab('sales-incoming');
    } catch (e) { $('rcErr').textContent = e.message || 'Could not record it'; }
  };
}

// ── PAYING A CHARGE OR A COMMISSION ──────────────────────────────────────
// One transfer across several payables, the third form of this shape. Payee
// is free text and NOT checked against the lines: a charge records what it
// was for, not who to pay, so there is nothing here to check it against.
// Recording an unverifiable claim is honest; pretending to verify it is not.
async function openSettleForm(data, which) {
  const L = LEDGER_LIGHT;
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const open = (data.open_payables || []).filter((p) => which === 'commission'
    ? p.kind === 'commission' : p.kind === 'charge');
  const fieldCss = `width:100%; height:34px; padding:0 10px; background:${L.paper}; border:1px solid ${L.line}; border-radius:var(--radius-sm); color:${L.ink}; outline:none; font-size:13px;`;
  const lab = `display:block; font-size:11px; color:${L.inkMuted}; margin-bottom:5px; white-space:nowrap;`;

  document.body.insertAdjacentHTML('beforeend', `
    <div id="stModal" style="position:fixed; inset:0; background:rgba(0,0,0,.66); z-index:9100; display:flex; align-items:flex-start; justify-content:center; overflow-y:auto; padding:32px 16px;">
      <div class="card" style="width:min(860px,100%); padding:20px 22px 18px; background:${L.sunken}; border-color:${L.line};">
        <div style="display:flex; align-items:baseline; justify-content:space-between; margin-bottom:14px;">
          <h3 style="margin:0; font-size:16px; text-transform:none; color:${L.ink};">Pay ${which === 'commission' ? 'commission' : 'charges'}</h3>
          ${ledgerThemeToggle()}
          <button id="stClose" aria-label="Close" style="background:none; border:none; color:${L.inkMuted}; font-size:22px; line-height:1; cursor:pointer;">&times;</button>
        </div>
        <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; margin-bottom:14px;">
          <div><label style="${lab}">Date</label><input id="stDate" placeholder="MM/DD/YYYY" autocomplete="off" style="${fieldCss}"></div>
          <div><label style="${lab}">Amount sent</label><input id="stAmount" inputmode="decimal" autocomplete="off" style="${fieldCss} text-align:right; font-family:var(--font-mono);"></div>
          <div><label style="${lab}">Paid to</label><input id="stPayee" autocomplete="off" list="stpayees" style="${fieldCss}"><datalist id="stpayees">${(data.payees || []).map((x) => `<option value="${esc(x)}"></option>`).join('')}</datalist></div>
          <div><label style="${lab}">How</label><select id="stMode" style="${fieldCss}">${(data.modes || []).map((m) => `<option>${esc(m)}</option>`).join('')}</select></div>
          <div id="stBankField"><label style="${lab}">From</label><select id="stBank" style="${fieldCss}">${(data.banks || []).map((b) => `<option>${esc(b)}</option>`).join('')}</select></div>
          <div><label style="${lab}">Reference</label><input id="stRef" autocomplete="off" style="${fieldCss}"></div>
        </div>
        <div style="font-size:12px; color:${L.inkFaint}; margin:14px 0 6px;">What is this paying?</div>
        <div style="background:${L.paper}; border:1px solid ${L.line}; border-radius:var(--radius-sm); max-height:260px; overflow-y:auto;">
          <table style="width:100%; border-collapse:collapse;"><tbody id="stRows">${open.length ? open.map((p) => `
            <tr data-key="${esc(p.key)}" style="border-top:1px solid ${L.lineSoft};">
              <td style="padding:6px 8px;"><input type="checkbox" class="stPick" data-key="${esc(p.key)}"></td>
              <td style="padding:6px 8px; font-size:12px; font-family:var(--font-mono); color:${L.inkMuted};">${esc(p.booking_no || '')}</td>
              <td style="padding:6px 8px; font-size:12px; font-family:var(--font-mono); color:${L.ink};">${esc(p.container_no || '')}</td>
              <td style="padding:6px 8px; font-size:12px; color:${L.ink};">${esc(p.what)}</td>
              <td style="padding:6px 8px; font-size:12px; text-align:right; font-family:var(--font-mono); color:${L.inkMuted};">${money(p.balance)}</td>
              <td style="padding:6px 8px;"><input class="stAmt" data-key="${esc(p.key)}" data-sale="${esc(p.sale_id)}" data-kind="${esc(p.kind)}" data-charge="${esc(p.charge_id || '')}" data-balance="${esc(p.balance)}" inputmode="decimal" autocomplete="off" style="width:110px; height:28px; padding:0 8px; text-align:right; font-family:var(--font-mono); font-size:12px; background:${L.paper}; border:1px solid ${L.line}; border-radius:var(--radius-sm); color:${L.ink}; outline:none;"></td>
            </tr>`).join('') : `<tr><td style="padding:18px; text-align:center; font-size:12px; color:${L.inkFaint};">Nothing outstanding.</td></tr>`}</tbody></table>
        </div>
        <div style="border-top:1px solid ${L.line}; padding-top:13px; margin-top:14px; display:flex; align-items:flex-end; gap:24px; flex-wrap:wrap;">
          <div><div style="font-size:11px; color:${L.inkFaint};">Allocated</div><div id="stAllocated" style="font-size:17px; font-weight:500; font-family:var(--font-mono); color:${L.ink};">$0.00</div></div>
          <div><div style="font-size:11px; color:${L.inkFaint};">Still to allocate</div><div id="stLeft" style="font-size:17px; font-weight:500; font-family:var(--font-mono); color:${L.ink};">$0.00</div></div>
          <div style="flex:1;"></div>
          <button id="stCancel" class="btn btn-secondary" style="font-size:11px; padding:8px 16px; background:${L.paper}; color:${L.inkMuted}; border-color:${L.line};">Cancel</button>
          <button id="stSave" class="btn btn-primary" style="font-size:11px; padding:8px 20px; background:${L.accent}; border-color:${L.accent}; color:${L.accentInk};">Record payment</button>
        </div>
        <div id="stErr" style="color:${L.danger}; font-size:11px; margin-top:8px;"></div>
      </div>
    </div>`);

  $('stDate').value = toUsDate(todayYardDateStr());
  wireUsDateField('stDate');
  const close = () => { const m = $('stModal'); if (m) m.remove(); document.removeEventListener('keydown', esc2); };
  const esc2 = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc2);
  $('stClose').onclick = close; $('stCancel').onclick = close;
  ledgerReopen = () => { close(); openSettleForm(data, which); };

  const num = (v) => { const n = parseFloat(String(v || '').replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; };
  const allocs = () => [...document.querySelectorAll('.stAmt')]
    .map((el) => ({ sale_id: el.dataset.sale, kind: el.dataset.kind,
                    charge_id: el.dataset.charge || null, amount: num(el.value) }))
    .filter((a) => a.amount > 0);
  const retotal = () => {
    const sent = num($('stAmount').value);
    const a = allocs().reduce((t, x) => t + x.amount, 0);
    const left = Math.round((sent - a) * 100) / 100;
    $('stAllocated').textContent = money(a);
    $('stLeft').textContent = money(left);
    $('stLeft').style.color = left < -0.005 ? L.danger : (Math.abs(left) < 0.005 ? L.ok : L.ink);
    const ok = sent > 0 && Math.abs(left) < 0.005;
    $('stSave').disabled = !ok;
    $('stSave').style.opacity = ok ? '1' : '.45';
    const m = $('stMode').value;
    if ($('stBankField')) $('stBankField').style.display = (m === 'Wire' || m === 'Zelle') ? '' : 'none';
  };
  document.querySelectorAll('.stPick').forEach((cb) => {
    cb.onchange = () => {
      const amt = document.querySelector(`.stAmt[data-key="${cb.dataset.key}"]`);
      if (!amt) return;
      if (cb.checked) {
        const sent = num($('stAmount').value);
        const already = allocs().reduce((t, x) => t + x.amount, 0);
        const room = sent > 0 ? Math.max(0, sent - already) : Infinity;
        const bal = num(amt.dataset.balance);
        amt.value = (room === Infinity ? bal : Math.min(bal, room)).toFixed(2);
      } else { amt.value = ''; }
      retotal();
    };
  });
  document.querySelectorAll('.stAmt').forEach((el) => { el.oninput = retotal; });
  $('stAmount').oninput = retotal;
  $('stMode').onchange = retotal;
  retotal();

  $('stSave').onclick = async () => {
    $('stErr').textContent = '';
    try {
      const mode = $('stMode').value;
      await api('/api/sales-settlements', { method: 'POST', body: JSON.stringify({
        date: $('stDate').value, amount: $('stAmount').value, mode,
        bank: (mode === 'Wire' || mode === 'Zelle') ? $('stBank').value : '',
        ref: $('stRef').value, payee: $('stPayee').value, allocations: allocs(),
      }) });
      close();
      loadTab(which === 'commission' ? 'sales-commission' : 'sales-freight');
    } catch (e) { $('stErr').textContent = e.message || 'Could not record it'; }
  };
}

// ── MARK AS PAID, AND THE MONEY THE BANK KEPT ────────────────────────────
// Apsara, 2026-09-10: "In outgoing-give the option as mark as paid..sometimes
// there might be a deduction in received amount because of wire deduction by
// bank".
//
// The tempting build is a tick box. It is wrong, and the second half of her
// sentence is why: the customer wires 12,340 and 12,315 lands. A tick says
// settled; the statement says 12,315; nothing says where the 25 went. So this
// records a RECEIPT, and the shortfall has to be named before it will save.
//
// The amount box is pre-filled with the full balance, because that is the
// ordinary case and she should not have to type it. The moment she changes it
// to something smaller, the shortfall panel appears — it is not a question
// asked up front, it is a question asked when it becomes one.
async function openMarkPaid(row) {
  const L = LEDGER_LIGHT;
  const data = await api('/api/sales-receipts');
  const banks = data.banks || [];
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const owed = Number(row.balance || 0);
  const fieldCss = `width:100%; height:34px; padding:0 10px; background:${L.paper}; border:1px solid ${L.line}; border-radius:var(--radius-sm); color:${L.ink}; outline:none; font-size:13px;`;
  const lab = `display:block; font-size:11px; color:${L.inkMuted}; margin-bottom:5px; white-space:nowrap;`;

  document.body.insertAdjacentHTML('beforeend', `
    <div id="mpModal" style="position:fixed; inset:0; background:rgba(0,0,0,.66); z-index:9100; display:flex; align-items:flex-start; justify-content:center; overflow-y:auto; padding:32px 16px;">
      <div class="card" style="width:min(600px,100%); padding:20px 22px 18px; background:${L.sunken}; border-color:${L.line};">
        <div style="display:flex; align-items:baseline; justify-content:space-between; margin-bottom:4px;">
          <h3 style="margin:0; font-size:16px; text-transform:none; color:${L.ink};">Receive payment — ${esc(row.container_no || row.invoice_no || 'container')}</h3>
          ${ledgerThemeToggle()}
          <button id="mpClose" aria-label="Close" title="Close (Esc)" style="background:none; border:none; color:${L.inkMuted}; font-size:22px; line-height:1; cursor:pointer;">&times;</button>
        </div>
        <div style="font-size:12px; color:${L.inkFaint}; margin-bottom:14px;">
          ${esc(row.customer || 'This customer')} owes <b style="color:${L.ink};">${money(owed)}</b>${row.booking_no ? ` on ${esc(row.booking_no)}` : ''}
        </div>

        <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px;">
          <div><label style="${lab}">How much arrived</label>
            <input id="mpAmount" inputmode="decimal" autocomplete="off" value="${owed.toFixed(2)}"
              style="${fieldCss} text-align:right; font-family:var(--font-mono);"></div>
          <div><label style="${lab}">Received on</label>
            <input id="mpDate" placeholder="MM/DD/YYYY" autocomplete="off" style="${fieldCss}"></div>
          <div><label style="${lab}">How</label>
            <select id="mpMode" style="${fieldCss}">${(data.modes || []).map((m) => `<option>${esc(m)}</option>`).join('')}</select></div>
          <div id="mpBankField"><label style="${lab}">Into</label>
            <select id="mpBank" style="${fieldCss}">${banks.map((b) => `<option>${esc(b)}</option>`).join('')}</select></div>
          <div><label style="${lab}">Reference</label>
            <input id="mpRef" autocomplete="off" placeholder="wire no" style="${fieldCss}"></div>
        </div>

        <div id="mpShort" style="display:none; margin-top:14px; padding:12px; background:${L.paper}; border:1px solid ${L.line}; border-radius:var(--radius-sm);">
          <div style="font-size:12px; color:${L.ink}; margin-bottom:8px;">
            <b id="mpShortAmt" style="font-family:var(--font-mono);"></b> less than the balance. What happened to it?
          </div>
          <div style="display:flex; flex-direction:column; gap:6px;">
            <label style="display:flex; align-items:flex-start; gap:8px; font-size:12px; color:${L.ink}; cursor:pointer;">
              <input type="radio" name="mpWhy" value="bank_charge" checked style="margin-top:2px;">
              <span>The bank took it in transit<br><span style="font-size:11px; color:${L.inkFaint};">A cost to Edge Metals. The invoice stays at its full value — they did pay it.</span></span>
            </label>
            <label style="display:flex; align-items:flex-start; gap:8px; font-size:12px; color:${L.ink}; cursor:pointer;">
              <input type="radio" name="mpWhy" value="discount" style="margin-top:2px;">
              <span>I agreed to take less<br><span style="font-size:11px; color:${L.inkFaint};">A discount. Less was earned — not a cost, and counted apart from bank charges.</span></span>
            </label>
            <label style="display:flex; align-items:flex-start; gap:8px; font-size:12px; color:${L.ink}; cursor:pointer;">
              <input type="radio" name="mpWhy" value="" style="margin-top:2px;">
              <span>They still owe it<br><span style="font-size:11px; color:${L.inkFaint};">Records what arrived and leaves the rest outstanding.</span></span>
            </label>
          </div>
          <input id="mpWhyNote" autocomplete="off" placeholder="note (optional)"
            style="${fieldCss} margin-top:8px; font-size:12px;">
        </div>

        <div style="border-top:1px solid ${L.line}; padding-top:13px; margin-top:14px; display:flex; align-items:center; gap:12px;">
          <span id="mpAfter" style="font-size:12px; color:${L.inkMuted};"></span>
          <span style="flex:1;"></span>
          <button id="mpCancel" class="btn btn-secondary" style="font-size:11px; padding:8px 16px; background:${L.paper}; color:${L.inkMuted}; border-color:${L.line};">Cancel</button>
          <button id="mpSave" class="btn btn-primary" style="font-size:11px; padding:8px 20px; background:${L.accent}; border-color:${L.accent}; color:${L.accentInk};">Record it</button>
        </div>
        <div id="mpErr" style="color:${L.danger}; font-size:11px; margin-top:8px;"></div>
      </div>
    </div>`);

  $('mpDate').value = toUsDate(todayYardDateStr());
  wireUsDateField('mpDate');

  const close = () => { const m = $('mpModal'); if (m) m.remove(); document.removeEventListener('keydown', esc2); };
  const esc2 = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc2);
  $('mpClose').onclick = close;
  $('mpCancel').onclick = close;
  ledgerReopen = () => { close(); openMarkPaid(row); };

  const num = (v) => { const n = parseFloat(String(v || '').replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; };
  const chosen = () => {
    const r = document.querySelector('input[name="mpWhy"]:checked');
    return r ? r.value : 'bank_charge';
  };

  const refresh = () => {
    const got = num($('mpAmount').value);
    const short = Math.round((owed - got) * 100) / 100;
    // Only a SHORTFALL raises the question. Over-payment is a different
    // conversation and the server refuses it, so there is nothing to ask.
    $('mpShort').style.display = short > 0.005 ? 'block' : 'none';
    if (short > 0.005) $('mpShortAmt').textContent = money(short);
    const closes = short <= 0.005 || !!chosen();
    $('mpAfter').textContent = short <= 0.005
      ? 'Settles the container.'
      : (closes ? `Settles it — ${money(short)} recorded as ${chosen() === 'discount' ? 'a discount' : 'a bank charge'}.`
                : `${money(short)} stays outstanding.`);
    if ($('mpBankField')) {
      const m = $('mpMode').value;
      $('mpBankField').style.display = (m === 'Wire' || m === 'Zelle') ? '' : 'none';
    }
  };
  $('mpAmount').oninput = refresh;
  $('mpMode').onchange = refresh;
  document.querySelectorAll('input[name="mpWhy"]').forEach((r) => { r.onchange = refresh; });
  refresh();

  $('mpSave').onclick = async () => {
    $('mpErr').textContent = '';
    try {
      const got = num($('mpAmount').value);
      const short = Math.round((owed - got) * 100) / 100;
      const why = short > 0.005 ? chosen() : '';
      const alloc = { sale_id: row.id, amount: got };
      if (why) {
        alloc.deduction_amount = short;
        alloc.deduction_reason = why;
        alloc.deduction_note = $('mpWhyNote').value || null;
      }
      const mode = $('mpMode').value;
      await api('/api/sales-receipts', { method: 'POST', body: JSON.stringify({
        date: $('mpDate').value, amount: got, mode,
        bank: (mode === 'Wire' || mode === 'Zelle') ? $('mpBank').value : '',
        ref: $('mpRef').value, customer: row.customer, allocations: [alloc],
      }) });
      close();
      await renderLedgerTab('sales');
    } catch (e) { $('mpErr').textContent = e.message || 'Could not record it'; }
  };
}

// ── STEP ONE: WHO IS BEING PAID ──────────────────────────────────────────
// Apsara, 2026-09-10: "On record a payment -> It must ask to select the
// supplier first. Then populate the supplier field in forms. Then show only
// related supplier container which are unpaid/part paid. if balance is
// pending, mention how much is pending."
//
// Each supplier is shown with what is actually outstanding against them, so
// the first screen already answers "who do I owe, and how much" — which is
// the question that sends her to this form in the first place.
//
// A supplier with NO open containers is still reachable through the box at
// the bottom: an advance is usually paid before any bill exists, and a picker
// built only from open bills would have made that impossible to record.
function openBillPaySupplier(data) {
  const L = LEDGER_LIGHT;
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const credit = data.credit || {};
  const openBills = data.open_bills || [];

  const bySupplier = new Map();
  let unnamed = 0;
  for (const b of openBills) {
    const name = String(b.supplier || '').trim();
    if (!name) { unnamed += 1; continue; }   // cannot be paid until the bill names someone
    const cur = bySupplier.get(name) || { name, count: 0, pending: 0 };
    cur.count += 1;
    cur.pending = Math.round((cur.pending + (Number(b.balance) || 0)) * 100) / 100;
    bySupplier.set(name, cur);
  }
  // Credit-only suppliers belong here too: she may want to apply an advance
  // she is already holding, and this is the screen she arrives at.
  for (const name of Object.keys(credit)) {
    if (!bySupplier.has(name)) bySupplier.set(name, { name, count: 0, pending: 0 });
  }
  const rows = [...bySupplier.values()].sort((a, b) => b.pending - a.pending);

  document.body.insertAdjacentHTML('beforeend', `
    <div id="bpWho" style="position:fixed; inset:0; background:rgba(0,0,0,.66); z-index:9100; display:flex; align-items:flex-start; justify-content:center; overflow-y:auto; padding:32px 16px;">
      <div class="card" style="width:min(560px,100%); padding:20px 22px 18px; background:${L.sunken}; border-color:${L.line};">
        <div style="display:flex; align-items:baseline; justify-content:space-between; margin-bottom:4px;">
          <h3 style="margin:0; font-size:16px; text-transform:none; color:${L.ink};">Record a payment</h3>
          ${ledgerThemeToggle()}
          <button id="bpWhoClose" aria-label="Close" title="Close (Esc)" style="background:none; border:none; color:${L.inkMuted}; font-size:22px; line-height:1; cursor:pointer;">&times;</button>
        </div>
        <div style="font-size:12px; color:${L.inkFaint}; margin-bottom:14px;">Who are you paying?</div>

        <div style="background:${L.paper}; border:1px solid ${L.line}; border-radius:var(--radius-sm); max-height:320px; overflow-y:auto;">
          ${rows.length ? rows.map((r) => `
            <button class="bpWhoPick" data-supplier="${esc(r.name)}"
              style="display:flex; width:100%; align-items:center; gap:10px; padding:10px 12px; background:none; border:none; border-bottom:1px solid ${L.lineSoft}; cursor:pointer; text-align:left;">
              <span style="flex:1; font-size:13px; color:${L.ink};">${esc(r.name)}</span>
              ${credit[r.name] ? `<span style="font-size:11px; color:${L.ok};">${money(credit[r.name])} credit</span>` : ''}
              <span style="font-size:11px; color:${L.inkFaint}; white-space:nowrap;">${r.count} container${r.count === 1 ? '' : 's'}</span>
              <span style="font-family:var(--font-mono); font-size:12px; color:${r.pending > 0 ? L.ink : L.inkFaint}; white-space:nowrap;">${r.pending > 0 ? money(r.pending) + ' pending' : 'nothing pending'}</span>
            </button>`).join('')
            : `<div style="padding:18px; text-align:center; font-size:12px; color:${L.inkFaint};">Nothing outstanding. Name a supplier below to record an advance.</div>`}
        </div>

        ${unnamed ? `<div style="margin-top:8px; font-size:11px; color:${L.warn};">${unnamed} container${unnamed === 1 ? ' has' : 's have'} no supplier on the bill, so ${unnamed === 1 ? 'it cannot' : 'they cannot'} be paid yet — open the bill and add one.</div>` : ''}

        <div style="display:flex; gap:8px; align-items:flex-end; margin-top:14px; padding-top:13px; border-top:1px solid ${L.line};">
          <div style="flex:1;">
            <label style="display:block; font-size:11px; color:${L.inkMuted}; margin-bottom:5px;">Someone else</label>
            <input id="bpWhoOther" autocomplete="off" list="bpwholist" placeholder="supplier name"
              style="width:100%; height:34px; padding:0 10px; background:${L.paper}; border:1px solid ${L.line}; border-radius:var(--radius-sm); color:${L.ink}; outline:none; font-size:13px;">
            <datalist id="bpwholist">${rows.map((r) => `<option value="${esc(r.name)}"></option>`).join('')}</datalist>
          </div>
          <button id="bpWhoGo" class="btn btn-primary" style="font-size:11px; padding:8px 18px; background:${L.accent}; border-color:${L.accent}; color:${L.accentInk};">Continue</button>
        </div>
      </div>
    </div>`);

  const close = () => { const m = $('bpWho'); if (m) m.remove(); document.removeEventListener('keydown', esc2); };
  const esc2 = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc2);
  $('bpWhoClose').onclick = close;
  ledgerReopen = () => { close(); openBillPaySupplier(data); };
  const go = (name) => { if (!String(name || '').trim()) return; close(); openBillPayForm({ supplier: String(name).trim() }); };
  document.querySelectorAll('.bpWhoPick').forEach((b) => { b.onclick = () => go(b.dataset.supplier); });
  $('bpWhoGo').onclick = () => go($('bpWhoOther').value);
  $('bpWhoOther').onkeydown = (e) => { if (e.key === 'Enter') go($('bpWhoOther').value); };
}

// ── PAYING FOR CONTAINERS ────────────────────────────────────────────────
// Apsara, 2026-09-10: "We need pay option.in payment,there is a possible of
// giving advance deduction and multiple container paynebt at once."
//
// One transfer, several containers, and she types the amount per container —
// her choice when asked, over splitting evenly or filling balances in order.
// Supplier invoices rarely divide evenly, so exact beats fast here.
//
// THE RUNNING REMAINDER IS THE WHOLE INTERACTION. She enters what left the
// bank, then divides it. Without a live "still to allocate" figure she is
// doing subtraction in her head against a number she typed thirty seconds
// ago, and the server will reject the total she guessed wrong. So it is
// computed on every keystroke and it is the biggest thing on the panel.
//
// An ADVANCE is the same form with no containers ticked: money against the
// supplier, sitting as credit until she applies it.
// ── ONE SUPPLIER, ONE SPELLING ──────────────────────────────────────────────
// Apsara, 2026-09-19, after importing the workbook: "There are like calderon
// CALDERON,upper case,Space issue like EDGE YARD,EDGEYARD ,MODern modern
// enterprises getting treated as diff suppliers in bills. make jarvis work on
// that and fix this."
//
// Two lists on this panel, and the split is the whole point:
//
//   WHAT THE RULE CAN JOIN — case and spacing only. "calderon"/"CALDERON",
//     "EDGE YARD"/"EDGEYARD". Shown with the winning spelling and every row
//     it would touch, and merged in one go.
//
//   WHAT ONLY SHE CAN ANSWER — "MODern" and "modern enterprises" are
//     genuinely different strings. helpers/nameMatch.js refuses fuzzy
//     matching on purpose, because a near-miss here means paying the wrong
//     company. So Jarvis asks, once, and her answer becomes an alias.
//
// Merging is behind the Jarvis profile. It rewrites hundreds of live
// financial records across four stores at once, and a payment records WHO WAS
// PAID by name — so bills and payments have to move together or the balances
// on suppliers she has already paid jump back to the full invoice amount.
async function openNameCleanup(startField) {
  const L = LEDGER_LIGHT;
  // Which field is being cleaned. Apsara, 2026-09-19: "dont make sepratae
  // button for this.instead ,make one button give an opion for each field to
  // correct this." One panel, one control, four fields.
  let field = startField || 'supplier';
  document.body.insertAdjacentHTML('beforeend', `
    <div id="smModal" style="position:fixed; inset:0; background:rgba(0,0,0,.66); z-index:9100; display:flex; align-items:flex-start; justify-content:center; overflow-y:auto; padding:32px 16px;">
      <div class="card" style="width:min(880px,100%); padding:20px 22px 18px; background:${L.sunken}; border-color:${L.line};">
        <div style="display:flex; align-items:baseline; justify-content:space-between; margin-bottom:6px;">
          <h3 style="margin:0; font-size:16px; text-transform:none; color:${L.ink};">Clean up names</h3>
          <button id="smClose" aria-label="Close" title="Close (Esc)" style="background:none; border:none; color:${L.inkMuted}; font-size:22px; line-height:1; cursor:pointer;">&times;</button>
        </div>
        <div id="smFields" style="display:flex; gap:4px; border-bottom:1px solid ${L.line}; margin-bottom:12px;"></div>
        <div id="smWhere" style="font-size:12px; color:${L.inkFaint}; margin-bottom:16px; line-height:1.55;"></div>
        <div id="smBody" style="font-size:12.5px; color:${L.inkMuted};">Looking…</div>
      </div>
    </div>`);

  const close = () => { const m = $('smModal'); if (m) m.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  $('smClose').onclick = close;
  $('smModal').addEventListener('click', (e) => { if (e.target.id === 'smModal') close(); });

  const n = (v) => Number(v || 0).toLocaleString('en-US');

  async function draw(note) {
    let d;
    try { d = await api(`/api/names/${field}/preview`); }
    catch (e) { $('smBody').innerHTML = `<div style="color:${L.danger};">${esc(e.message)}</div>`; return; }

    const clusters = d.clusters || [];
    const proposals = d.proposals || [];
    const merges = d.merges || [];

    // The tabs, and the sentence naming exactly which stores this field
    // touches — so "merge" is never a button she presses without knowing what
    // it reaches.
    $('smFields').innerHTML = (d.fields || []).map((f) => {
      const on = f.key === field;
      return `<button class="smField" data-field="${esc(f.key)}" style="background:none; border:none; cursor:pointer;
        font-size:12px; padding:7px 13px; color:${on ? L.ink : L.inkMuted};
        border-bottom:2px solid ${on ? L.accent : 'transparent'};">${esc(f.label)}</button>`;
    }).join('');
    const here = (d.fields || []).find((f) => f.key === field);
    $('smWhere').innerHTML = here
      ? `The same ${esc(here.label.toLowerCase())} typed two ways counts twice — in the totals, in the filters and in the dropdown.
         Merging rewrites the stored name across ${esc(here.where)}, together.`
      : '';
    document.querySelectorAll('.smField').forEach((b) => {
      b.onclick = () => { field = b.dataset.field; draw(); };
    });

    $('smBody').innerHTML = `
      ${note ? `<div style="margin-bottom:12px; padding:9px 12px; border:1px solid ${L.ok}; border-radius:var(--radius-sm); color:${L.ink};">${esc(note)}</div>` : ''}

      ${clusters.length ? `
        <div style="font-size:11px; color:${L.inkFaint}; margin-bottom:6px;">Same name, different spelling — ${n(d.total)} row${d.total === 1 ? '' : 's'} would change</div>
        <div style="border:1px solid ${L.line}; border-radius:var(--radius-sm); background:${L.paper};">
          ${clusters.map((c) => `
            <div style="padding:9px 12px; border-bottom:1px solid ${L.lineSoft};">
              <div style="color:${L.ink};"><b>${esc(c.winner)}</b>
                <span style="color:${L.inkFaint}; font-size:11px;">&nbsp;keeps this spelling${c.confirmed ? ' — you chose it' : ' — the one you use most'}</span></div>
              <div style="color:${L.inkMuted}; font-size:11.5px; margin-top:3px;">
                absorbs ${c.losers.map((l) => `<b style="color:${L.ink};">${esc(l.name)}</b> (${n(l.total)})`).join(', ')}
              </div>
            </div>`).join('')}
        </div>
        <div style="font-size:11px; color:${L.inkFaint}; margin-top:7px;">
          Across ${Object.entries(d.byStore || {}).map(([k, v]) => `${n(v)} in ${esc(k)}`).join(', ')}.
          Every changed row keeps its original spelling, so this can be undone.
        </div>
        <div style="margin-top:12px; display:flex; align-items:center; gap:10px;">
          <span style="flex:1;"></span>
          ${metalsCanDelete()
            ? `<button id="smGo" class="btn btn-primary" style="font-size:12px; padding:8px 16px;">Merge ${n(d.total)} rows</button>`
            : `<span style="font-size:11px; color:${L.inkFaint};">Merging needs the Jarvis profile — it rewrites financial records in several places at once.</span>`}
        </div>`
        : `<div style="padding:12px; border:1px solid ${L.line}; border-radius:var(--radius-sm); background:${L.paper}; color:${L.inkMuted};">
             No spelling differences left here. Every ${esc((here && here.label.toLowerCase()) || 'name')} appears under one name.
           </div>`}

      <!-- ── SAYING IT YOURSELF ──────────────────────────────────────
           Apsara, 2026-09-19: "in supplier names,it should allow me to type
           say carlos g&c ,g&c both are same".

           She is right, and the gap was real. Nothing proposes that pair:
           "carlos g&c" normalises to carlosgc and "g&c" to gc, which share
           no prefix, so the suggestion list would never have offered it and
           there was no other way in. A panel that only ever shows what an
           algorithm noticed is a panel that cannot be corrected. -->
        <div style="font-size:11px; color:${L.inkFaint}; margin:18px 0 6px;">Tell it two names are the same</div>
        <div style="border:1px solid ${L.line}; border-radius:var(--radius-sm); background:${L.paper}; padding:12px;">
          <div style="display:flex; gap:8px; align-items:flex-end; flex-wrap:wrap;">
            <div style="flex:1; min-width:170px;">
              <label style="display:block; font-size:11px; color:${L.inkMuted}; margin-bottom:4px;">This name</label>
              <input id="smAliasName" list="smNames" autocomplete="off" placeholder="g&amp;c"
                style="width:100%; height:34px; padding:0 10px; background:${L.paper}; border:1px solid ${L.line}; border-radius:var(--radius-sm); color:${L.ink}; font-size:13px;"></div>
            <div style="padding-bottom:9px; color:${L.inkFaint}; font-size:12px;">is really</div>
            <div style="flex:1; min-width:170px;">
              <label style="display:block; font-size:11px; color:${L.inkMuted}; margin-bottom:4px;">This one</label>
              <input id="smAliasReal" list="smNames" autocomplete="off" placeholder="carlos g&amp;c"
                style="width:100%; height:34px; padding:0 10px; background:${L.paper}; border:1px solid ${L.line}; border-radius:var(--radius-sm); color:${L.ink}; font-size:13px;"></div>
            <button id="smSave" class="btn btn-secondary" style="font-size:12px; padding:8px 14px;">Save</button>
          </div>
          <datalist id="smNames">${(d.names || []).map((u) => `<option value="${esc(u.name)}"></option>`).join('')}</datalist>
          <div style="font-size:11px; color:${L.inkFaint}; margin-top:7px; line-height:1.5;">
            Pick from the names already in use, or type the spelling you would rather keep — the second box can be a
            name that is not in the ledger yet, and the rows will move to it.
          </div>
          ${(d.aliases || []).length ? `<div style="margin-top:10px; display:flex; flex-wrap:wrap; gap:6px;">
            ${(d.aliases || []).map((a) => `<span style="display:inline-flex; align-items:center; gap:6px; font-size:11px; color:${L.inkMuted}; border:1px solid ${L.line}; border-radius:999px; padding:3px 8px 3px 10px;">
              ${esc(a.from)} &rarr; <b style="color:${L.ink};">${esc(a.to)}</b>
              <button class="smDropAlias" data-from="${esc(a.from)}" title="Forget this" style="background:none; border:none; color:${L.inkFaint}; cursor:pointer; font-size:14px; line-height:1; padding:0 2px;">&times;</button>
            </span>`).join('')}
          </div>` : ''}
        </div>

      ${proposals.length ? `
        <div style="font-size:11px; color:${L.inkFaint}; margin:18px 0 6px;">These might be the same — only you can say</div>
        <div style="border:1px solid ${L.warn}; border-radius:var(--radius-sm); background:${L.paper};">
          ${proposals.map((p, i) => `
            <div style="padding:10px 12px; border-bottom:1px solid ${L.lineSoft}; display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
              <span style="flex:1; min-width:280px; color:${L.ink};">${esc(p.question)}</span>
              <button class="smYes btn btn-secondary" data-i="${i}" style="font-size:11px; padding:5px 12px;">Yes — both are “${esc(p.suggest)}”</button>
              <button class="smYesOther btn btn-secondary" data-i="${i}" style="font-size:11px; padding:5px 12px;">Yes — both are “${esc(p.shorter)}”</button>
            </div>`).join('')}
        </div>
        <div style="font-size:11px; color:${L.inkFaint}; margin-top:7px; line-height:1.5;">
          Nothing is merged by guessing. Name matching here is case- and spacing-tolerant but never fuzzy — a near-miss
          would mean paying the wrong company. Answer once and it is remembered.
        </div>` : ''}

      ${merges.length ? `
        <div style="font-size:11px; color:${L.inkFaint}; margin:18px 0 6px;">Merged before</div>
        <div style="border:1px solid ${L.line}; border-radius:var(--radius-sm); background:${L.paper};">
          ${merges.map((m) => `
            <div style="display:flex; align-items:center; gap:10px; padding:7px 10px; border-bottom:1px solid ${L.lineSoft}; font-size:11.5px;">
              <span style="color:${L.ink};">${esc(m.label || m.field || '')}</span>
              <span style="font-family:var(--font-mono); color:${L.inkMuted};">${esc(String(m.merge_id).slice(0, 22))}</span>
              <span style="flex:1;"></span>
              <span style="color:${L.inkFaint};">${n(m.rows)} rows</span>
              ${metalsCanDelete() ? `<button class="smUndo" data-id="${esc(m.merge_id)}" style="background:none; border:1px solid ${L.line}; border-radius:var(--radius-sm); padding:3px 9px; font-size:11px; color:${L.danger}; cursor:pointer;">Undo</button>` : ''}
            </div>`).join('')}
        </div>` : ''}
      <div id="smErr"></div>`;

    if ($('smGo')) $('smGo').onclick = async (e) => {
      const btn = e.currentTarget;
      if (!confirm(`Rewrite ${d.total} rows so each supplier has one spelling?\n\n`
        + clusters.map((c) => `  ${c.losers.map((l) => l.name).join(', ')} → ${c.winner}`).join('\n')
        + `\n\nBills, supplier payments, the supplier list and bookings change together. Every row keeps its original spelling, so this can be undone.`)) return;
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Merging…';
      try {
        const r = await api(`/api/names/${field}/merge`, { method: 'POST', body: JSON.stringify({}) });
        await draw(`Merged — ${n(r.changed)} rows now use one spelling.`);
        renderLedgerTab('bills');
      } catch (err) {
        btn.disabled = false; btn.textContent = 'Try again';
        $('smErr').innerHTML = `<div style="margin-top:12px; color:${L.danger};">${esc(err.message)}</div>`;
      }
    };

    // Her answer. Stored as an alias; it does NOT merge on its own — the next
    // draw simply shows the two names as one cluster and she still presses
    // Merge. One decision at a time, each one hers.
    const answer = async (from, to) => {
      try {
        await api(`/api/names/${field}/alias`, { method: 'POST', body: JSON.stringify({ from, to }) });
        await draw(`Noted — “${from}” means “${to}”. It is in the list above now.`);
      } catch (err) {
        $('smErr').innerHTML = `<div style="margin-top:12px; color:${L.danger};">${esc(err.message)}</div>`;
      }
    };
    document.querySelectorAll('.smYes').forEach((b) => {
      b.onclick = () => { const p = proposals[Number(b.dataset.i)]; answer(p.shorter, p.suggest); };
    });
    document.querySelectorAll('.smYesOther').forEach((b) => {
      b.onclick = () => { const p = proposals[Number(b.dataset.i)]; answer(p.longer, p.shorter); };
    });
    if ($('smSave')) $('smSave').onclick = async () => {
      const from = $('smAliasName').value.trim(), to = $('smAliasReal').value.trim();
      if (!from || !to) {
        $('smErr').innerHTML = `<div style="margin-top:12px; color:${L.danger};">Both boxes, please — which name, and what it really is.</div>`;
        return;
      }
      await answer(from, to);
    };
    document.querySelectorAll('.smDropAlias').forEach((b) => {
      b.onclick = async () => {
        try {
          await api(`/api/names/${field}/alias/` + encodeURIComponent(b.dataset.from), { method: 'DELETE' });
          await draw(`Forgotten — "${b.dataset.from}" stands on its own again.`);
        } catch (err) {
          $('smErr').innerHTML = `<div style="margin-top:12px; color:${L.danger};">${esc(err.message)}</div>`;
        }
      };
    });
    document.querySelectorAll('.smUndo').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Put every one of these rows back to the spelling it had?')) return;
        b.disabled = true; b.textContent = '…';
        try {
          const r = await api('/api/names/merge/' + encodeURIComponent(b.dataset.id), { method: 'DELETE' });
          await draw(`Undone — ${n(r.restored)} rows back to their original spelling.`);
          renderLedgerTab('bills');
        } catch (err) {
          b.disabled = false; b.textContent = 'Undo';
          $('smErr').innerHTML = `<div style="margin-top:12px; color:${L.danger};">${esc(err.message)}</div>`;
        }
      };
    });
  }

  draw();
}

// ── IMPORTING A SHIPMENTS WORKBOOK ──────────────────────────────────────────
// Apsara, 2026-09-19: "I want to have a upload option in jarvis for bills and
// invoice where i can import this."
//
// ── WHY IT IS TWO BUTTONS AND NOT ONE ───────────────────────────────────────
// Preview READS the file and writes nothing; Import writes. The click that
// puts 568 bills into live data is deliberately not the click that opens the
// file, because there is no way to look at a spreadsheet and know what it
// will become — the six reader bugs found on 2026-09-19 were every one of
// them invisible until the numbers were on screen.
//
// ── ONE WORKBOOK FILLS BOTH SCREENS ─────────────────────────────────────────
// Shipments becomes Bills and Order Details becomes Invoices, so an import
// started from EITHER screen does both. Stated on the panel, because the
// obvious guess is that the Bills screen imports bills — and acting on that
// guess means uploading the same file twice. (The server refuses the second
// one, but being refused is a worse way to learn this than being told.)
