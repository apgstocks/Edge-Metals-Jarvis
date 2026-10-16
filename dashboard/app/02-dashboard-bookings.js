// dashboard/app/02-dashboard-bookings.js — split from dashboard/index.html's <script> (helpers/sourceParts.js reconstructs the original)
const INV_SUBTABS = [
  { id: 'byType',  label: 'By item type' },
  { id: 'byDay',   label: 'Per day' },
  { id: 'bySeller', label: 'Per seller' },
];
let invFrom = '', invTo = '', invSubTab = 'byType';

function invByTypeHtml(data) {
  // See mobInvByTypeHtml in the app for why On hand is absent under a date
  // filter — same rule, same reason, both clients.
  return data.byType.length ? `
    ${data.onHandAvailable ? '' : '<div style="font-family:var(--font-mono); font-size:11px; color:var(--text-faint); padding-bottom:8px;">Showing what came IN for this date range — clear the dates to see what\'s on hand.</div>'}
    <table style="width:100%; border-collapse:collapse; font-size:13px;">
      <thead><tr style="text-align:left; border-bottom:1px solid var(--border-subtle);">
        <th style="padding:8px 6px;">Item type</th><th style="padding:8px 6px;" title="How many separate loads carried this item">Loads</th><th style="padding:8px 6px;" title="How many weighed lines, across all those loads">Items</th><th style="padding:8px 6px;">Gross</th><th style="padding:8px 6px;">Tare</th><th style="padding:8px 6px;">Net in</th>${data.onHandAvailable ? '<th style="padding:8px 6px;">Shipped</th><th style="padding:8px 6px; font-weight:700;">On hand</th>' : ''}<th style="padding:8px 6px;">Amount</th>
      </tr></thead>
      <tbody>
        ${data.byType.map(g => `<tr class="inv-type-row" data-inv-toggle="${esc(g.description)}" title="Show every ${esc(g.description)} line, load by load" style="border-bottom:1px solid var(--border-subtle); cursor:pointer;">
          <td style="padding:8px 6px; color:var(--accent);">▸ ${esc(g.description)}</td>
          <!-- LOADS, then items. Apsara, 2026-10-17: "item basis what how
               much loads we bought from this date to that date". The count
               beside it is weighed LINES and was the only number here - one
               load can weigh alternators across four lines, so it answered a
               different question to the one she was asking.
               NO BACKTICKS IN HERE: this comment sits INSIDE a template
               literal, so a backtick ends the string and the whole file
               stops parsing. It did, and the test suite did not notice
               because section D reads this file as TEXT; the mutation
               harness caught it by refusing to mutate a file that will not
               parse. -->
          <td style="padding:8px 6px; font-weight:700;">${g.loadCount != null ? g.loadCount : '—'}</td>
          <td style="padding:8px 6px; color:var(--text-muted);">${g.count}</td>
          <td style="padding:8px 6px;">${g.gross} ${esc(data.unit)}</td>
          <td style="padding:8px 6px;">${g.tare} ${esc(data.unit)}</td>
          <td style="padding:8px 6px;">${g.net} ${esc(data.unit)}</td>
          ${data.onHandAvailable ? `<td style="padding:8px 6px; color:var(--text-muted);">${g.shipped || 0} ${esc(data.unit)}</td>
          <td style="padding:8px 6px; font-weight:700; color:${g.onHand < 0 ? 'var(--status-danger)' : 'var(--text-strong)'};">${g.onHand} ${esc(data.unit)}${g.onHand < 0 ? ' ⚠' : ''}</td>` : ''}
          <td style="padding:8px 6px;">${g.amount != null ? fmtAmount(g.amount) : '—'}</td>
        </tr>
        <!-- The lines behind that row, per Apsara 2026-09-02. Empty and
             hidden until the type is opened; filled by renderInvLines. -->
        <tr><td colspan="${data.onHandAvailable ? 9 : 7}" style="padding:0;"><div data-inv-lines="${esc(g.description)}" style="display:none;"></div></td></tr>`).join('')}
      </tbody>
    </table>
  ` : `<div style="padding:20px; color:var(--text-muted); font-size:13px;">No items in this range.</div>`;
}

function invByDayHtml(data) {
  return data.byDay.length ? `
    <table style="width:100%; border-collapse:collapse; font-size:13px;">
      <thead><tr style="text-align:left; border-bottom:1px solid var(--border-subtle);">
        <th style="padding:8px 6px;">Date</th><th style="padding:8px 6px;">Loads</th><th style="padding:8px 6px;">Net total</th><th style="padding:8px 6px;">Amount total</th>
      </tr></thead>
      <tbody>
        ${data.byDay.map(d => `<tr style="border-bottom:1px solid var(--border-subtle);">
          <td style="padding:8px 6px;">${esc(fmtDate(d.date))}</td>
          <td style="padding:8px 6px;">${d.loadCount}</td>
          <td style="padding:8px 6px;">${d.net} ${esc(data.unit)}</td>
          <td style="padding:8px 6px;">$${d.amount}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  ` : `<div style="padding:20px; color:var(--text-muted); font-size:13px;">No loads in this range.</div>`;
}

function invBySellerHtml(data) {
  return data.bySeller.length ? data.bySeller.map(s => `
    <details class="card" style="margin-bottom:8px; padding:0;">
      <summary style="cursor:pointer; padding:12px 16px; display:flex; justify-content:space-between; align-items:center; gap:12px; font-size:13px; list-style:none;">
        <span style="font-weight:600;">${esc(s.seller)}</span>
        <span style="font-family:var(--font-mono); font-size:12px; color:var(--text-muted); white-space:nowrap;">${s.loadCount} load${s.loadCount === 1 ? '' : 's'} · ${s.net} ${esc(data.unit)} · ${s.amount != null ? fmtAmount(s.amount) : '—'}</span>
      </summary>
      <div style="padding:0 16px 14px;">
        ${s.byType.length ? `
          <table style="width:100%; border-collapse:collapse; font-size:12px;">
            <thead><tr style="text-align:left; border-bottom:1px solid var(--border-subtle);">
              <th style="padding:6px;">Item type</th><th style="padding:6px;">Items</th><th style="padding:6px;">Net</th><th style="padding:6px;">Amount</th>
            </tr></thead>
            <tbody>
              ${s.byType.map(g => `<tr style="border-bottom:1px solid var(--border-subtle);">
                <td style="padding:6px;">${esc(g.description)}</td>
                <td style="padding:6px;">${g.count}</td>
                <td style="padding:6px;">${g.net} ${esc(data.unit)}</td>
                <td style="padding:6px;">${g.amount != null ? fmtAmount(g.amount) : '—'}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        ` : ''}
        <!-- The loads behind those totals, per Apsara 2026-08-24: "when i
             click it, it should open my load ticket". A seller row was a dead
             end before — it told you Ramesh brought 7,110 lb and gave you no
             way to reach the tickets that made it up. -->
        ${(s.loads || []).length ? `
          <div style="margin-top:12px; padding-top:10px; border-top:1px dashed var(--border-subtle);">
            <div style="font-family:var(--font-mono); font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-faint); margin-bottom:6px;">Load tickets</div>
            ${s.loads.map(l => l.pdf_link
              ? `<a href="${esc(l.pdf_link)}" target="_blank" rel="noopener" style="display:flex; justify-content:space-between; padding:7px 0; font-size:12.5px; text-decoration:none; border-bottom:1px solid var(--border-subtle);">
                   <span style="color:var(--accent);">${esc(l.id)} →</span>
                   <span style="color:var(--text-faint); font-family:var(--font-mono);">${esc(l.date || '')}${l.amount != null ? ' · ' + fmtAmount(l.amount) : ''}</span>
                 </a>`
              : `<div style="display:flex; justify-content:space-between; padding:7px 0; font-size:12.5px; border-bottom:1px solid var(--border-subtle);">
                   <span style="color:var(--text-muted);">${esc(l.id)}</span>
                   <span style="color:var(--text-faint); font-family:var(--font-mono);">${esc(l.date || '')}${l.amount != null ? ' · ' + fmtAmount(l.amount) : ''} · no PDF yet</span>
                 </div>`).join('')}
          </div>` : ''}
      </div>
    </details>
  `).join('') : `<div style="padding:20px; color:var(--text-muted); font-size:13px;">No sellers in this range.</div>`;
}

const INV_SUBTAB_RENDER = { byType: invByTypeHtml, byDay: invByDayHtml, bySeller: invBySellerHtml };
// Last inventory payload, so switching sub-tabs repaints instead of refetching.
let invData = null;

async function renderInventory() {
  const params = new URLSearchParams();
  if (invFrom) params.set('from', invFrom);
  if (invTo) params.set('to', invTo);
  const qs = params.toString() ? '?' + params.toString() : '';
  const root = $('viewRoot');
  root.innerHTML = '<div style="padding:60px; text-align:center; color:var(--text-faint); font-family:var(--font-mono); font-size:13px;">Loading…</div>';
  let data;
  try { data = invData = await api('/api/loads/inventory' + qs); }
  catch (err) { root.innerHTML = `<div style="padding:60px; text-align:center; color:var(--status-danger); font-family:var(--font-mono); font-size:13px;">${esc(err.message)}</div>`; return; }

  root.innerHTML = `
    <section style="max-width:1000px; margin:0 auto; padding:38px 40px 80px;">
      ${pageHead('Inventory', {
        note: 'Computed live from every current load — deleting a load removes its material.',
        stats: [['item types', String((data.byType || []).length)],
                ['on hand', esc(((data.byType || []).reduce((t, g) => t + (Number(g.net) || 0), 0)).toLocaleString() + ' ' + (data.unit || 'lb'))]],
        chips: ['live from loads'],
      })}
      <div style="display:flex; justify-content:flex-end; margin-bottom:12px;">
        <div style="position:relative;">
          <button id="btnInvExportMenu" class="btn" title="Export" style="padding:6px 10px; font-size:16px; line-height:1;">⋮</button>
          <div id="invExportMenu" class="ac-dropdown hidden" style="left:auto; right:0; width:170px; max-height:none;">
            <div class="ac-item" data-export="xlsx">Export as Excel</div>
            <div class="ac-item" data-export="pdf">Export as PDF</div>
          </div>
        </div>
      </div>

      <div style="display:flex; gap:10px; align-items:end; margin-bottom:16px; flex-wrap:wrap;">
        <div class="field" style="margin-bottom:0;"><label>From</label><input id="inv_from" placeholder="MM/DD/YYYY" autocomplete="off" value="${esc(toUsDate(invFrom))}"></div>
        <div class="field" style="margin-bottom:0;"><label>To</label><input id="inv_to" placeholder="MM/DD/YYYY" autocomplete="off" value="${esc(toUsDate(invTo))}"></div>
        <button id="btnInvApply" class="btn btn-primary">Apply</button>
        <button id="btnInvClear" class="btn">Clear</button>
      </div>

      <div style="display:flex; gap:6px; margin-bottom:22px; border-bottom:1px solid var(--border-subtle); flex-wrap:wrap;">
        ${INV_SUBTABS.map(t => `
          <button class="btn inv-subtab-btn" data-subtab="${t.id}" style="border:none; border-radius:0; border-bottom:2px solid ${invSubTab === t.id ? 'var(--accent)' : 'transparent'}; background:transparent; padding:9px 12px; font-size:12.5px; font-weight:${invSubTab === t.id ? '700' : '500'}; color:${invSubTab === t.id ? 'var(--text-strong)' : 'var(--text-muted)'};">${esc(t.label)}</button>
        `).join('')}
      </div>

      <div id="invSubtabBody">${INV_SUBTAB_RENDER[invSubTab](data)}</div>
    </section>`;

  wireInvLineToggles(invFrom, invTo);

  $('btnInvApply').addEventListener('click', () => { invFrom = toIsoDate($('inv_from').value); invTo = toIsoDate($('inv_to').value); renderInventory(); });
  wireUsDateField('inv_from'); wireUsDateField('inv_to');
  $('btnInvClear').addEventListener('click', () => { invFrom = ''; invTo = ''; renderInventory(); });
  // Sub-tab switch repaints from the payload already held — no refetch.
  // Item type / Per day / Per seller all come back in the SAME response, so
  // the old renderInventory() call here paid a full round trip (and a full
  // page rebuild, losing scroll position) to show data already in hand.
  // Same fix as the mobile app, 2026-08-21.
  root.querySelectorAll('.inv-subtab-btn').forEach(btn => btn.addEventListener('click', () => {
    if (btn.dataset.subtab === invSubTab || !invData) return;
    invSubTab = btn.dataset.subtab;
    $('invSubtabBody').innerHTML = INV_SUBTAB_RENDER[invSubTab](invData);
    // The sub-tab switch rebuilds the rows, so the toggles are re-bound.
    wireInvLineToggles(invFrom, invTo);
    root.querySelectorAll('.inv-subtab-btn').forEach(b => {
      const on = b.dataset.subtab === invSubTab;
      b.style.borderBottom = `2px solid ${on ? 'var(--accent)' : 'transparent'}`;
      b.style.fontWeight = on ? '700' : '500';
      b.style.color = on ? 'var(--text-strong)' : 'var(--text-muted)';
    });
  }));

  // Export menu — kebab toggles a small dropdown; picking an option navigates
  // to the export route with the current date filter attached (cookie auth
  // carries automatically, same as any other dashboard page load).
  const exportMenu = $('invExportMenu');
  $('btnInvExportMenu').addEventListener('click', (ev) => { ev.stopPropagation(); exportMenu.classList.toggle('hidden'); });
  document.addEventListener('click', () => exportMenu.classList.add('hidden'));
  exportMenu.querySelectorAll('.ac-item').forEach(item => item.addEventListener('click', () => {
    exportMenu.classList.add('hidden');
    location.href = `/api/loads/inventory/export.${item.dataset.export}${qs}`;
  }));
}

// ── BOARD ─────────────────────────────────────────────────────────────────
const RISK_COLOR = { high: 'var(--status-danger)', medium: 'var(--status-warning)', low: 'var(--accent)', done: 'var(--steel-400)' };
const RISK_LABEL = { high: 'High risk', medium: 'Medium risk', low: 'On track', done: 'Complete' };
let boardData = null;
let boardFilter = 'all';
// Apsara 2026-10-08 ("FIT INTO JARVIS", from a tracking-dashboard reel): a
// pipeline strip above the list and a 7-dot tracker in each row. Board screen
// only — the data was already there (/api/dashboard sends stageIndex and
// stages). boardStage is null for "all stages", else a stage index 0–6; it
// combines with the risk filter rather than replacing it (that was my call).
let boardStage = null;
const BOARD_STAGE_FALLBACK = ['Not Started', 'Assigned to Supplier', 'Forwarded to Trucker', 'Empty Dropped', 'Load Ready', 'Picked Up', 'Ingated'];
function boardStepper(b, n) {
  const idx = Number.isInteger(b.stageIndex) ? b.stageIndex : 0;
  const done = b.risk === 'done';
  const fill = done ? 'var(--steel-400)' : 'var(--accent)';
  let html = '';
  for (let i = 0; i < n; i++) {
    if (i > 0) html += `<span style="flex:1; min-width:6px; height:2px; background:${i <= idx ? fill : 'var(--border-default)'};"></span>`;
    const cur = i === idx && !done;
    html += cur
      ? `<span data-step="current" style="flex:none; width:14px; height:14px; border-radius:50%; box-sizing:border-box; background:var(--bg-base); border:3px solid ${RISK_COLOR[b.risk]}; outline:2px solid ${RISK_COLOR[b.risk]}; outline-offset:2px;"></span>`
      : `<span style="flex:none; width:10px; height:10px; border-radius:50%; box-sizing:border-box; ${i < idx || done ? 'background:' + fill + ';' : 'border:2px solid var(--steel-600);'}"></span>`;
  }
  return `<div class="board-stepper" role="img" aria-label="Stage ${idx + 1} of ${n}: ${esc(b.stageName || '')}" style="display:flex; align-items:center;">${html}</div>`;
}
function renderBoard(data) { boardData = data; boardFilter = 'all'; boardStage = null; renderBoardView(); }
function renderBoardView() {
  const data = boardData;
  const { counts, alerts, bookings } = data;
  const stageNames = Array.isArray(data.stages) && data.stages.length ? data.stages : BOARD_STAGE_FALLBACK;
  const byRisk = boardFilter === 'all' ? bookings : bookings.filter(b => b.risk === boardFilter);
  const filtered = boardStage === null ? byRisk : byRisk.filter(b => b.stageIndex === boardStage);
  const stageCounts = stageNames.map((_, i) => byRisk.filter(b => b.stageIndex === i).length);
  const kpiDefs = ['high', 'medium', 'low', 'done'];
  $('viewRoot').innerHTML = `
    <section style="max-width:1240px; margin:0 auto; padding:38px 40px 80px;">
      <div style="display:flex; align-items:flex-end; justify-content:space-between; gap:24px; margin-bottom:30px;">
        <div>
          <div class="eyebrow">// Booking scoreboard</div>
          <h1 style="font-size:clamp(26px,2.6vw,36px); text-transform:uppercase; line-height:1.05;">Every load,<br>accounted for.</h1>
        </div>
        <div style="text-align:right;">
          <div style="font-family:var(--font-mono); font-size:44px; font-weight:600; color:var(--text-strong); line-height:1;">${bookings.length}</div>
          <div style="font-family:var(--font-mono); font-size:10px; letter-spacing:.16em; text-transform:uppercase; color:var(--text-faint); margin-top:6px;">Active bookings</div>
        </div>
      </div>
      <div style="display:flex; gap:8px; margin-bottom:18px;">
        <button class="chip board-filter ${boardFilter === 'all' ? 'active' : ''}" data-filter="all">All</button>
        ${kpiDefs.map(k => `<button class="chip board-filter ${boardFilter === k ? 'active' : ''}" data-filter="${k}">${RISK_LABEL[k]}</button>`).join('')}
      </div>
      <div style="display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin-bottom:36px;">
        ${kpiDefs.map(k => `
          <button class="card board-filter" data-filter="${k}" style="text-align:left; cursor:pointer; border-top:3px solid ${RISK_COLOR[k]}; padding:18px 20px 16px; ${boardFilter === k ? 'box-shadow:0 0 0 2px ' + RISK_COLOR[k] + ' inset;' : ''}">
            <span style="font-family:var(--font-mono); font-size:34px; font-weight:600; color:var(--text-strong);">${counts[k] || 0}</span>
            <div style="font-family:var(--font-mono); font-size:10.5px; font-weight:600; letter-spacing:.16em; text-transform:uppercase; color:${RISK_COLOR[k]}; margin-top:12px;">${RISK_LABEL[k]}</div>
          </button>
        `).join('')}
      </div>
      <div style="display:flex; align-items:center; gap:12px; margin-bottom:12px;">
        <span style="font-family:var(--font-mono); font-size:11px; font-weight:600; letter-spacing:.2em; text-transform:uppercase; color:var(--accent-onSoft);">// Pipeline</span>
        <span style="flex:1; height:1px; background:var(--border-subtle);"></span>
        <span style="font-family:var(--font-mono); font-size:10.5px; color:var(--text-faint);">${boardStage === null ? 'Tap a stage to filter' : esc(stageNames[boardStage]) + ' · tap again to clear'}</span>
      </div>
      <div class="card" style="padding:16px 14px 12px; margin-bottom:36px; overflow-x:auto;">
        <div style="position:relative; display:grid; grid-template-columns:repeat(${stageNames.length}, minmax(96px,1fr)); min-width:${stageNames.length * 96}px;">
          <span style="position:absolute; left:${50 / stageNames.length}%; right:${50 / stageNames.length}%; top:22px; height:2px; background:var(--border-default);"></span>
          ${stageNames.map((name, i) => {
            const on = boardStage === i, has = stageCounts[i] > 0;
            return `<button type="button" class="board-stage" data-stage="${i}" aria-pressed="${on}" title="${esc(name)}" style="all:unset; cursor:pointer; position:relative; display:flex; flex-direction:column; align-items:center; gap:8px; padding:6px 4px 8px; border-radius:var(--radius-sm); text-align:center;">
              <span style="position:relative; display:flex; align-items:center; justify-content:center; width:32px; height:32px; border-radius:50%; box-sizing:border-box; font-family:var(--font-mono); font-size:13px; font-weight:600; ${on ? 'background:var(--accent); color:var(--bg-base); border:2px solid var(--leaf-300);' : has ? 'background:var(--surface-sunken); color:var(--text-strong); border:2px solid var(--accent);' : 'background:var(--surface-sunken); color:var(--text-faint); border:2px solid var(--border-default);'}">${stageCounts[i]}</span>
              <span style="font-family:var(--font-mono); font-size:10px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; line-height:1.3; max-width:110px; color:${on ? 'var(--text-strong)' : has ? 'var(--text-body)' : 'var(--text-faint)'};">${esc(name)}</span>
            </button>`;
          }).join('')}
        </div>
      </div>
      ${alerts.length ? `
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:14px;">
          <span style="font-family:var(--font-mono); font-size:11px; font-weight:600; letter-spacing:.2em; text-transform:uppercase; color:var(--copper-400);">// Needs attention</span>
          <span style="flex:1; height:1px; background-image:repeating-linear-gradient(-45deg, var(--copper-300) 0, var(--copper-300) 2px, transparent 2px, transparent 8px);"></span>
        </div>
        <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:14px; margin-bottom:40px;">
          ${alerts.map(a => `
            <div style="position:relative; background:var(--surface-card); border:1px solid var(--border-subtle); border-radius:var(--radius-sm); padding:16px 18px 16px 26px;">
              <div style="position:absolute; left:0; top:0; bottom:0; width:8px; background-image:repeating-linear-gradient(-45deg, var(--copper-400) 0, var(--copper-400) 3px, transparent 3px, transparent 10px);"></div>
              <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
                <span style="font-family:var(--font-mono); font-size:13.5px; font-weight:600; color:#fff;">${esc(a.bookingNo)}</span>
                <span class="badge" style="color:#fff; background:var(--status-danger);">${esc(a.deadlineLabel)}</span>
              </div>
              <div style="font-size:13px; color:var(--steel-300); margin-top:9px;">${esc(a.issue || '')}</div>
            </div>
          `).join('')}
        </div>` : ''}
      <div style="display:flex; flex-direction:column; gap:12px;">
        ${filtered.length ? filtered.map(b => `
          <div class="card" style="border-left:4px solid ${RISK_COLOR[b.risk]}; padding:20px 24px; display:grid; grid-template-columns:minmax(150px,200px) minmax(180px,1fr) minmax(160px,250px) minmax(110px,140px); align-items:center;">
            <div style="padding-right:22px; border-right:1px solid var(--border-subtle);">
              <div style="font-family:var(--font-mono); font-size:9px; letter-spacing:.16em; text-transform:uppercase; color:var(--text-faint); margin-bottom:5px;">${esc(b.container || '—')}</div>
              <div style="font-family:var(--font-mono); font-size:14.5px; font-weight:600; color:var(--text-strong);">${esc(b.bookingNo)}</div>
              <div style="font-size:12.5px; color:var(--text-body); margin-top:5px;">${esc(b.route)}</div>
            </div>
            <div style="padding:0 28px; border-right:1px solid var(--border-subtle);">
              ${boardStepper(b, stageNames.length)}
              <div style="display:flex; align-items:baseline; flex-wrap:wrap; gap:8px; margin-top:10px;">
                <span style="font-family:var(--font-mono); font-size:12px; font-weight:600; letter-spacing:.1em; text-transform:uppercase; color:var(--text-strong);">${esc(b.stageName)}</span>
                <span style="font-family:var(--font-mono); font-size:10.5px; color:var(--text-faint);">${(Number.isInteger(b.stageIndex) ? b.stageIndex : 0) + 1}/${stageNames.length}</span>
                ${b.subBranch ? `<span style="font-size:11.5px; color:var(--text-muted);">${esc(b.subBranch)}</span>` : ''}
              </div>
            </div>
            <div style="padding:0 26px; border-right:1px solid var(--border-subtle);">
              <div style="font-size:13px; line-height:1.45;">${esc(b.pending || '—')}</div>
              <div style="font-family:var(--font-mono); font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-faint); margin-top:6px;">${esc(b.owner || '')}</div>
            </div>
            <div style="text-align:right; padding-left:22px;">
              <div style="font-family:var(--font-mono); font-size:13px; font-weight:600; color:${RISK_COLOR[b.risk]};">${esc(b.deadlineLabel)}</div>
            </div>
          </div>
        `).join('') : '<div style="text-align:center; padding:60px 20px; color:var(--text-muted); font-family:var(--font-mono); font-size:13px; border:1px dashed var(--border-default); border-radius:var(--radius-sm);">No bookings in this view.</div>'}
      </div>
    </section>`;
  document.querySelectorAll('.board-filter').forEach(el => el.addEventListener('click', () => { boardFilter = el.dataset.filter; renderBoardView(); }));
  document.querySelectorAll('.board-stage').forEach(el => el.addEventListener('click', () => {
    const i = Number(el.dataset.stage);
    boardStage = boardStage === i ? null : i;
    renderBoardView();
  }));
}

// ── Shared: contact-option builder for booking container dropdowns ────────
function buildContactOptions(list, selectedName, port) {
  const p = normLoc(port);
  // Contacts with no locality set are always shown (matches the "Leave blank
  // to always show" hint on the contact form) — only exclude a contact when
  // it HAS a locality that doesn't match this booking's port of loading.
  const visible = p ? list.filter(c => !normLoc(c.locality) || localityMatchesPort(c.locality, p) || (selectedName && c.name === selectedName)) : list;
  let html = '<option value="">—</option>';
  html += visible.map(c => `<option value="${esc(c.name)}" ${selectedName === c.name ? 'selected' : ''}>${esc(c.name)}${c.locality ? ' · ' + esc(c.locality) : ''}</option>`).join('');
  return html;
}

// ── BOOKINGS ──────────────────────────────────────────────────────────────
let modalContainers = [];
let editingBookingNumber = null;
let modalPdfBase64 = null, modalPdfFile = null;
let modalTruckersList = [], modalSuppliersList = [];
let bookingsCache = {};

async function loadModalContacts() {
  try {
    const [t, s] = await Promise.all([api('/api/truckers'), api('/api/suppliers')]);
    modalTruckersList = Array.isArray(t) ? t.filter(x => x && x.name) : [];
    modalSuppliersList = Array.isArray(s) ? s.filter(x => x && x.name) : [];
  } catch { modalTruckersList = []; modalSuppliersList = []; }
}

function renderContainersInModal() {
  const wrap = $('containersList');
  const SIZES = ['20GP', '40GP', '40HC', '20RF', '40RF', '45HC'];
  const STAGES = ['not_started', 'supplier_assigned', 'forwarded', 'empty_dropped', 'load_ready', 'picked_up', 'ingate_received', 'done'];
  const pol = $('f_pol').value || '';
  const isEditing = !!editingBookingNumber;
  wrap.innerHTML = (isEditing ? `<div style="padding:8px 12px; background:var(--copper-soft); color:var(--copper-onSoft); border-radius:var(--radius-xs); font-size:11.5px; margin-bottom:4px;"><strong>Manual stage override:</strong> changing a stage here does not send WhatsApp messages — use only to correct an out-of-sync booking.</div>` : '')
    + modalContainers.map((c, i) => `
    <div class="card" data-idx="${i}" style="display:grid; grid-template-columns:50px 90px 1fr 1fr 1fr ${isEditing ? '150px' : ''} 36px; gap:8px; align-items:end; padding:10px 12px;">
      <div class="field" style="margin-bottom:0;"><label style="font-size:9px;">Seq</label><div style="padding:9px 0; font-family:var(--font-mono); font-weight:700; color:var(--copper-400);">#${c.seq}</div></div>
      <div class="field" style="margin-bottom:0;"><label style="font-size:9px;">Size</label><select class="mc_size">${SIZES.map(s => `<option ${c.size === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div class="field" style="margin-bottom:0;"><label style="font-size:9px;">Container #</label><input class="mc_num" value="${esc(c.container_number || '')}" placeholder="TCLU8841207"></div>
      <div class="field" style="margin-bottom:0;"><label style="font-size:9px;">Supplier</label><select class="mc_supplier">${buildContactOptions(modalSuppliersList, c.supplier, pol)}</select></div>
      <div class="field" style="margin-bottom:0;"><label style="font-size:9px;">Trucker</label><select class="mc_trucker">${buildContactOptions(modalTruckersList, c.trucker, pol)}</select></div>
      ${isEditing ? `<div class="field" style="margin-bottom:0;"><label style="font-size:9px; color:var(--status-danger);">Stage (manual)</label><select class="mc_stage" style="border-color:var(--status-danger);">${STAGES.map(s => `<option value="${s}" ${(c.stage || 'not_started') === s ? 'selected' : ''}>${s.replace(/_/g, ' ')}</option>`).join('')}</select></div>` : ''}
      <button class="btn btn-danger mc_remove" ${modalContainers.length <= 1 ? 'disabled' : ''} style="padding:9px 0;" title="Remove">×</button>
    </div>`).join('');

  wrap.querySelectorAll('[data-idx]').forEach(row => {
    const i = Number(row.dataset.idx);
    row.querySelector('.mc_size').addEventListener('change', e => modalContainers[i].size = e.target.value);
    row.querySelector('.mc_num').addEventListener('input', e => modalContainers[i].container_number = e.target.value);
    row.querySelector('.mc_supplier').addEventListener('change', e => modalContainers[i].supplier = e.target.value);
    row.querySelector('.mc_trucker').addEventListener('change', e => modalContainers[i].trucker = e.target.value);
    const stageEl = row.querySelector('.mc_stage');
    if (stageEl) stageEl.addEventListener('change', e => modalContainers[i].stage = e.target.value);
    row.querySelector('.mc_remove').addEventListener('click', () => {
      if (modalContainers.length <= 1) return;
      modalContainers.splice(i, 1);
      modalContainers.forEach((c, idx) => c.seq = idx + 1);
      renderContainersInModal();
    });
  });
}
let polDebounce = null;
$('f_pol').addEventListener('input', () => { clearTimeout(polDebounce); polDebounce = setTimeout(renderContainersInModal, 250); });
$('btnAddContainer').addEventListener('click', () => {
  const nextSeq = modalContainers.length ? Math.max(...modalContainers.map(c => c.seq)) + 1 : 1;
  modalContainers.push({ seq: nextSeq, size: modalContainers[0]?.size || '40HC', container_number: '', supplier: '', trucker: '', stage: 'not_started' });
  renderContainersInModal();
});

function renderDropZone() {
  const dz = $('pdfDropZone');
  if (modalPdfFile) {
    $('pdfDropLabel').textContent = `${modalPdfFile.name} — ready to scan`;
  } else {
    $('pdfDropLabel').textContent = "Drop the carrier's booking PDF here";
  }
}
function handlePdfFile(f) {
  if (!f || f.type !== 'application/pdf') return;
  modalPdfFile = f;
  const reader = new FileReader();
  reader.onload = () => { modalPdfBase64 = reader.result.split(',')[1]; $('scanBtn').classList.remove('hidden'); $('scannedBanner').classList.add('hidden'); renderDropZone(); };
  reader.readAsDataURL(f);
}
$('pdfDropZone').addEventListener('click', () => { if (!modalPdfFile) $('pdfInput').click(); });
$('pdfInput').addEventListener('change', () => handlePdfFile($('pdfInput').files[0]));
$('pdfDropZone').addEventListener('dragover', e => e.preventDefault());
$('pdfDropZone').addEventListener('drop', e => { e.preventDefault(); if (!modalPdfFile) handlePdfFile(e.dataTransfer.files[0]); });

$('scanBtn').addEventListener('click', async () => {
  if (!modalPdfBase64) return;
  const btn = $('scanBtn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Scanning…';
  try {
    const d = await api('/api/documents/scan', { method: 'POST', body: JSON.stringify({ pdf_base64: modalPdfBase64 }) });
    const f = d.fields || {};
    if (f.booking_number) $('f_bkg').value = f.booking_number;
    if (f.carrier) $('f_carrier').value = f.carrier;
    if (f.port_of_loading) $('f_pol').value = f.port_of_loading;
    if (f.port_of_discharge) $('f_pod').value = f.port_of_discharge;
    if (f.erd_date) $('f_erd').value = toUsDate(f.erd_date);
    if (f.cutoff_date) $('f_cutoff').value = toUsDate(f.cutoff_date);
    if (f.etd) $('f_etd').value = f.etd;
    if (f.eta) $('f_eta').value = f.eta;
    if (f.vessel_voyage) $('f_vessel').value = f.vessel_voyage;
    if (f.buyer) $('f_buyer').value = f.buyer; else if (f.consignee) $('f_buyer').value = f.consignee;
    if (f.container_size) {
      const raw = String(f.container_size).trim();
      const m = raw.match(/^\s*(\d+[A-Z]{2,3})\s*[xX*]\s*(\d+)\s*$/);
      const size = m ? m[1] : raw;
      const count = m ? (parseInt(m[2], 10) || 1) : 1;
      modalContainers = [];
      for (let i = 1; i <= count; i++) modalContainers.push({ seq: i, size, container_number: (i === 1 && f.container_number) ? f.container_number : '', supplier: '', trucker: '', stage: 'not_started' });
      renderContainersInModal();
    } else if (f.container_number) {
      modalContainers[0].container_number = f.container_number;
      renderContainersInModal();
    }
    $('scannedBanner').classList.remove('hidden');
    $('scanBtn').classList.add('hidden');
  } catch (e) {
    $('modalError').textContent = 'Scan failed: ' + e.message;
    btn.disabled = false; btn.innerHTML = 'Scan &amp; auto-fill fields';
  }
});

function resetBookingModal() {
  modalPdfBase64 = null; modalPdfFile = null; editingBookingNumber = null;
  ['f_bkg', 'f_carrier', 'f_vessel', 'f_pol', 'f_pod', 'f_erd', 'f_cutoff', 'f_etd', 'f_eta', 'f_buyer'].forEach(id => $(id).value = '');
  wireUsDateField('f_erd'); wireUsDateField('f_cutoff');
  $('f_bkg').disabled = false;
  modalContainers = [{ seq: 1, size: '40HC', container_number: '', supplier: '', trucker: '', stage: 'not_started' }];
  $('modalError').textContent = '';
  $('scannedBanner').classList.add('hidden');
  $('scanBtn').classList.add('hidden');
  $('bookingModalTitle').textContent = 'New booking';
  $('btnSaveBooking').textContent = 'Save booking';
  renderDropZone();
  renderContainersInModal();
}
async function openBookingModalForAdd() {
  await loadModalContacts();
  resetBookingModal();
  $('bookingModal').classList.remove('hidden');
}
async function openBookingModalForEdit(bkg) {
  await loadModalContacts();
  resetBookingModal();
  const b = bookingsCache[bkg];
  if (!b) { alert('Booking not found.'); return; }
  editingBookingNumber = bkg;
  $('f_bkg').value = b.booking_number || ''; $('f_bkg').disabled = true;
  $('f_carrier').value = b.carrier || '';
  $('f_pol').value = b.port_of_loading || '';
  $('f_pod').value = b.port_of_discharge || '';
  $('f_erd').value = toUsDate(b.erd_date) || '';
  $('f_cutoff').value = toUsDate(b.cutoff_date) || '';
  wireUsDateField('f_erd'); wireUsDateField('f_cutoff');
  $('f_etd').value = b.etd || '';
  $('f_eta').value = b.eta || '';
  $('f_vessel').value = b.vessel_voyage || '';
  $('f_buyer').value = b.buyer || b.consignee || '';
  modalContainers = Array.isArray(b.containers) && b.containers.length
    ? b.containers.map(c => ({ seq: c.seq, size: c.size || '', container_number: c.container_number || '', supplier: c.supplier || '', trucker: c.trucker || '', stage: c.stage || 'not_started' }))
    : [{ seq: 1, size: b.container_size || '40HC', container_number: b.container_number || '', supplier: '', trucker: '', stage: 'not_started' }];
  $('bookingModalTitle').textContent = `Edit booking — ${bkg}`;
  $('btnSaveBooking').textContent = 'Save changes';
  renderContainersInModal();
  $('bookingModal').classList.remove('hidden');
}
function closeBookingModal() { $('bookingModal').classList.add('hidden'); }
$('btnCloseBookingModal').addEventListener('click', closeBookingModal);
$('btnCancelBooking').addEventListener('click', closeBookingModal);

$('btnSaveBooking').addEventListener('click', async () => {
  const isEditing = !!editingBookingNumber;
  let bkg = $('f_bkg').value.trim().toUpperCase();
  if (!bkg && editingBookingNumber) bkg = editingBookingNumber;
  if (!bkg) { $('modalError').textContent = 'Booking number is required.'; return; }
  $('modalError').textContent = '';
  const btn = $('btnSaveBooking');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Saving…';
  try {
    const payload = {
      booking_number: bkg,
      carrier: $('f_carrier').value.trim() || null,
      port_of_loading: $('f_pol').value.trim() || null,
      port_of_discharge: $('f_pod').value.trim() || null,
      erd_date: toIsoDate($('f_erd').value) || null,
      cutoff_date: toIsoDate($('f_cutoff').value) || null,
      etd: $('f_etd').value.trim() || null,
      eta: $('f_eta').value.trim() || null,
      vessel_voyage: $('f_vessel').value.trim() || null,
      buyer: $('f_buyer').value.trim() || null,
      containers: modalContainers.map(c => ({
        seq: c.seq, size: c.size || null, container_number: (c.container_number || '').trim() || null,
        supplier: c.supplier || null, trucker: c.trucker || null, stage: c.stage || 'not_started',
      })),
    };
    isEditing
      ? await api(`/api/bookings/${encodeURIComponent(editingBookingNumber)}`, { method: 'PUT', body: JSON.stringify(payload) })
      : await api('/api/bookings', { method: 'POST', body: JSON.stringify(payload) });
    if (modalPdfBase64) {
      // Booking fields already saved above by this point — a PDF refusal here
      // (e.g. Drive's overwrite guard rejecting a non-confirmation document)
      // must NOT be swallowed silently, or the old PDF stays on file with no
      // indication anything went wrong. Surface it, but don't block the modal
      // from closing since the booking record itself did save successfully.
      try { await api('/api/bookings/upload-pdf', { method: 'POST', body: JSON.stringify({ booking_number: bkg, pdf_base64: modalPdfBase64, original_filename: modalPdfFile?.name }) }); }
      catch (e) { console.warn('[UPLOAD]', e.message); alert(`Booking saved, but the PDF was NOT attached:\n\n${e.message}`); }
    }
    closeBookingModal();
    if (CURRENT_TAB === 'bookings') loadTab('bookings'); else if (CURRENT_TAB === 'board') loadTab('board');
  } catch (e) {
    $('modalError').textContent = e.message;
    btn.disabled = false; btn.textContent = isEditing ? 'Save changes' : 'Save booking';
  }
});

// Sort key for a cutoff_date string (MM/DD/YYYY). Missing/unparseable dates
// sort LAST within their group (Infinity) — a booking with no cutoff yet
// shouldn't visually jump to the front of an ascending-urgency list.
function cutoffSortMs(dateStr) {
  const m = String(dateStr || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return Infinity;
  const t = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])).getTime();
  return isNaN(t) ? Infinity : t;
}

// Port of LA and Port of Long Beach are the same physical port complex (San
// Pedro Bay, adjacent terminals) — carriers and booking docs use either name
// for what is, for her purposes, the same place. Grouped together per
// Apsara (2026-08-05): "los angeles/long beach both are same only". Only
// affects the GROUP KEY — each booking row still shows its own real
// port_of_loading value untouched (bookingRow reads b.port_of_loading
// directly, not this normalized key).
function normalizePol(raw) {
  const s = String(raw || '').trim();
  if (!s) return '(No POL)';
  const lower = s.toLowerCase();
  if (/\blos angeles\b/.test(lower) || /\blong beach\b/.test(lower)) return 'Los Angeles / Long Beach';
  return s;
}

function renderBookings(bookingsObj) {
  bookingsCache = bookingsObj;
  const list = Object.values(bookingsObj);

  // Group by Port of Loading, sub-group by Port of Discharge, and within each
  // POL/POD pair sort bookings by cutoff ascending (soonest cutoff first —
  // matches how these get worked in practice). POL/POD groups themselves are
  // ordered alphabetically for a stable, predictable layout.
  const polOf = (b) => normalizePol(b.port_of_loading);
  const podOf = (b) => String(b.port_of_discharge || '').trim() || '(No POD)';
  const polGroups = new Map(); // pol -> Map(pod -> bookings[])
  for (const b of list) {
    const pol = polOf(b), pod = podOf(b);
    if (!polGroups.has(pol)) polGroups.set(pol, new Map());
    const podGroups = polGroups.get(pol);
    if (!podGroups.has(pod)) podGroups.set(pod, []);
    podGroups.get(pod).push(b);
  }
  const polNames = [...polGroups.keys()].sort((a, z) => a.localeCompare(z));
  for (const pol of polNames) {
    const podGroups = polGroups.get(pol);
    for (const pod of [...podGroups.keys()]) {
      podGroups.get(pod).sort((a, z) => cutoffSortMs(a.cutoff_date) - cutoffSortMs(z.cutoff_date));
    }
  }

  // Widened 2026-08-06 per Apsara ("i want erd,cutoff,etd,eta to show in
  // bookings tab website") — ERD/Cutoff were already columns here; added
  // ETD/ETA alongside them (same b.erd_date/b.cutoff_date/b.etd/b.eta
  // fields Gemini extracts from the carrier PDF and cutoffBackfill.js fills
  // in later — see helpers/booking.js's own formatting for the same 4
  // fields used in the WhatsApp-side ERD/cutoff replies). Route shrunk from
  // 1fr's full remaining space isn't practical to preserve with 2 more date
  // columns added — Containers/Actions narrowed slightly to make room
  // instead of letting the row overflow.
  const COLS = '24px 140px 1fr 92px 92px 92px 92px 90px 120px';
  // A container is "settled" (nothing to quick-assign/forward here anymore)
  // once it's reached 'forwarded' or any later stage — the stage badge
  // already shows that state, no action button needed in that slot.
  const FORWARDED_OR_LATER = new Set(['forwarded', 'empty_dropped', 'load_ready', 'picked_up', 'ingate_received', 'done']);
  function containerActionCell(bkg, c) {
    if (FORWARDED_OR_LATER.has(c.stage || 'not_started')) return '<div></div>';
    // No supplier yet → per Apsara: "if supplier/trucker not assigned, ask
    // them to assign first" — the Assign button IS that ask, not a blocking
    // alert with nowhere to go. Only once a supplier is on file does the
    // slot switch to Forward (which is itself both "pick a trucker" AND
    // "send it" in one step — matches workflow/actions.js's forwardBooking,
    // there's no separate silent "assign trucker" concept on the backend).
    if (!c.supplier) {
      return `<button class="btn btn-secondary btn-quick-assign" data-bkg="${esc(bkg)}" data-seq="${c.seq}" style="padding:6px 12px; font-size:10px;">Assign</button>`;
    }
    return `<button class="btn btn-primary btn-quick-forward" data-bkg="${esc(bkg)}" data-seq="${c.seq}" style="padding:6px 12px; font-size:10px;">Forward</button>`;
  }
  function bookingRow(b) {
    const containers = Array.isArray(b.containers) && b.containers.length ? b.containers : [{ seq: 1, size: b.container_size, container_number: b.container_number, stage: 'not_started' }];
    const subRows = containers.map(c => `
      <div style="display:grid; grid-template-columns:24px 60px 1fr 140px 120px 90px; gap:14px; padding:9px 18px 9px 40px; border-top:1px solid var(--border-subtle); background:var(--surface-sunken); font-size:12px; align-items:center;">
        <div></div>
        <div style="font-family:var(--font-mono); color:var(--copper-400); font-weight:700;">#${c.seq}</div>
        <div style="font-family:var(--font-mono);">${esc(c.size || '—')} ${c.container_number ? '· ' + esc(c.container_number) : ''}</div>
        <div style="font-family:var(--font-mono); color:${c.supplier || c.trucker ? 'var(--text-strong)' : 'var(--text-faint)'};">${esc(c.supplier && c.trucker ? c.supplier + ' → ' + c.trucker : (c.supplier || c.trucker || '—'))}</div>
        <div><span class="badge" style="background:var(--surface-card); border:1px solid var(--border-subtle); color:var(--text-body);">${esc((c.stage || 'not_started').replace(/_/g, ' '))}</span></div>
        <div onclick="event.stopPropagation();" style="text-align:right;">${containerActionCell(b.booking_number, c)}</div>
      </div>`).join('');
    return `
    <div data-bkg-group="${esc(b.booking_number)}">
      <div class="row-hover" data-bk-expand="${esc(b.booking_number)}" style="display:grid; grid-template-columns:${COLS}; gap:14px; padding:14px 18px; border-bottom:1px solid var(--border-subtle); align-items:center; cursor:pointer;">
        <div style="color:var(--text-faint); font-family:var(--font-mono);" class="bk-chevron">▸</div>
        <div style="font-family:var(--font-mono); font-size:12.5px; font-weight:600; color:var(--text-strong);">${esc(b.booking_number)}</div>
        <div style="font-family:var(--font-mono); font-size:11.5px; color:var(--text-body);">${esc(b.port_of_loading || '—')} → ${esc(b.port_of_discharge || '—')}</div>
        <div style="font-family:var(--font-mono); font-size:11px; color:var(--text-muted);">${esc(fmtDate(b.erd_date, '—'))}</div>
        <div style="font-family:var(--font-mono); font-size:11px; color:var(--text-muted);">${esc(fmtDate(b.cutoff_date, '—'))}</div>
        <div style="font-family:var(--font-mono); font-size:11px; color:var(--text-muted);">${esc(b.etd || '—')}</div>
        <div style="font-family:var(--font-mono); font-size:11px; color:var(--text-muted);">${esc(b.eta || '—')}</div>
        <div style="font-family:var(--font-mono); font-size:11px; color:var(--text-muted);">${containers.length}</div>
        <div style="display:flex; gap:6px; justify-content:flex-end;" onclick="event.stopPropagation();">
          <button class="btn btn-secondary btn-edit-booking" data-bkg="${esc(b.booking_number)}" style="padding:6px 12px; font-size:10px;">Edit</button>
          <button class="btn btn-danger btn-del-booking" data-bkg="${esc(b.booking_number)}" style="padding:6px 12px; font-size:10px;">Del</button>
        </div>
      </div>
      <div class="bk-containers hidden">${subRows}</div>
    </div>`;
  }

  function podHeader(pod, count) {
    return `<div style="padding:9px 18px 9px 34px; background:var(--surface-sunken); border-bottom:1px solid var(--border-subtle);">
      <div style="font-family:var(--font-mono); font-size:10.5px; font-weight:600; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted);">→ ${esc(pod)} <span style="color:var(--text-faint); font-weight:400; text-transform:none; letter-spacing:normal;">(${count})</span></div>
    </div>`;
  }

  // Each Port-of-Loading group is its own collapsible card — click the
  // header to expand/collapse. Starts expanded (matches the old always-open
  // behavior) so nothing looks different until she actually collapses one.
  function polCard(pol, count, bodyHtml) {
    return `
    <div class="card pol-group" data-pol-group style="overflow:hidden;">
      <div class="pol-toggle" data-pol-toggle style="cursor:pointer; display:flex; align-items:center; justify-content:space-between; padding:16px 20px; background:var(--surface-sunken); border-bottom:1px solid var(--border-subtle); border-top:2px solid var(--copper-400);">
        <div>
          <div class="eyebrow" style="margin-bottom:2px;">// Port of loading</div>
          <div style="font-size:15px; font-weight:700; color:var(--text-strong); text-transform:uppercase;">${esc(pol)}</div>
        </div>
        <div style="display:flex; align-items:center; gap:12px;">
          <span class="badge" style="background:var(--surface-card); border:1px solid var(--border-subtle); color:var(--text-muted);">${count} booking${count === 1 ? '' : 's'}</span>
          <span class="pol-chevron" style="font-family:var(--font-mono); font-size:15px; color:var(--text-faint);">▾</span>
        </div>
      </div>
      <div class="pol-body" data-pol-body>
        <div style="display:grid; grid-template-columns:${COLS}; gap:14px; padding:10px 18px; background:var(--surface-sunken); border-bottom:1px solid var(--border-subtle); font-family:var(--font-mono); font-size:9.5px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:var(--text-muted);">
          <div></div><div>Booking</div><div>Route</div><div>ERD</div><div>Cutoff</div><div>ETD</div><div>ETA</div><div>Containers</div><div style="text-align:right;">Actions</div>
        </div>
        ${bodyHtml}
      </div>
    </div>`;
  }

  const groupedHtml = polNames.map(pol => {
    const podGroups = polGroups.get(pol);
    const podNames = [...podGroups.keys()].sort((a, z) => a.localeCompare(z));
    const polCount = podNames.reduce((sum, pod) => sum + podGroups.get(pod).length, 0);
    const bodyHtml = podNames.map(pod => {
      const bookings = podGroups.get(pod);
      return podHeader(pod, bookings.length) + bookings.map(bookingRow).join('');
    }).join('');
    return polCard(pol, polCount, bodyHtml);
  }).join('');

  $('viewRoot').innerHTML = `
    <section style="max-width:1240px; margin:0 auto; padding:38px 40px 80px;">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:22px;">
        <div><div class="eyebrow">// Bookings</div><h2 style="font-size:24px; text-transform:uppercase;">Booking ledger</h2></div>
        <button id="btnAddBooking" class="btn btn-primary">+ Add booking</button>
      </div>
      <div style="display:flex; flex-direction:column; gap:16px;">
        ${list.length ? groupedHtml : '<div class="card" style="padding:40px; text-align:center; color:var(--text-faint); font-family:var(--font-mono); font-size:12px;">No bookings yet.</div>'}
      </div>
    </section>`;
  $('btnAddBooking').addEventListener('click', openBookingModalForAdd);
  document.querySelectorAll('[data-pol-toggle]').forEach(header => header.addEventListener('click', () => {
    const group = header.closest('[data-pol-group]');
    const body = group.querySelector('[data-pol-body]');
    const chev = header.querySelector('.pol-chevron');
    const open = !body.classList.contains('hidden');
    body.classList.toggle('hidden', open);
    chev.textContent = open ? '▸' : '▾';
  }));
  document.querySelectorAll('[data-bk-expand]').forEach(row => row.addEventListener('click', () => {
    const group = row.closest('[data-bkg-group]');
    const detail = group.querySelector('.bk-containers');
    const chev = row.querySelector('.bk-chevron');
    const open = !detail.classList.contains('hidden');
    detail.classList.toggle('hidden', open);
    chev.textContent = open ? '▸' : '▾';
  }));
  document.querySelectorAll('.btn-edit-booking').forEach(btn => btn.addEventListener('click', () => openBookingModalForEdit(btn.dataset.bkg)));
  document.querySelectorAll('.btn-del-booking').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm(`Archive booking ${btn.dataset.bkg}?`)) return;
    await api(`/api/bookings/${encodeURIComponent(btn.dataset.bkg)}`, { method: 'DELETE' });
    loadTab('bookings');
  }));
  document.querySelectorAll('.btn-quick-assign').forEach(btn => btn.addEventListener('click', () => openForwardModal(btn.dataset.bkg, Number(btn.dataset.seq), 'assign')));
  document.querySelectorAll('.btn-quick-forward').forEach(btn => btn.addEventListener('click', () => openForwardModal(btn.dataset.bkg, Number(btn.dataset.seq), 'forward')));
}

// ── Quick assign/forward modal ────────────────────────────────────────────
// Fires the REAL "assign"/"forward" command through /api/bot/command — the
// exact same execution path as typing it on WhatsApp or in the Bot tab
// (workflow/actions.js's assignSupplier/forwardBooking → executeAssign/
// executeForward), so the supplier/trucker actually gets notified. This is
// deliberately NOT the booking-edit modal's per-container Supplier/Trucker/
// Stage fields — those are an explicit "manual override, does not notify
// anyone" escape hatch (see its own on-screen warning), wrong tool for a
// real assign/forward action.
let forwardModalState = { bkg: null, seq: null, kind: null };
async function openForwardModal(bkg, seq, kind) {
  forwardModalState = { bkg, seq, kind };
  const isAssign = kind === 'assign';
  $('fwd_eyebrow').textContent = isAssign ? 'Assign' : 'Forward';
  $('fwd_title').textContent = isAssign ? 'Assign supplier' : 'Forward to trucker';
  $('fwd_label').textContent = isAssign ? 'Supplier' : 'Trucker';
  $('fwd_subtitle').textContent = `${bkg} / container #${seq}${isAssign ? ' — this sends the supplier their assignment notice on WhatsApp.' : ' — this sends the trucker the booking + PDF on WhatsApp.'}`;
  $('fwd_error').textContent = '';
  $('btnConfirmForward').disabled = false;
  $('btnConfirmForward').textContent = 'Send';

  // Contact list + booking POL for locality filtering — reuses the exact
  // same loader/filter the booking-edit modal already uses (loadModalContacts,
  // buildContactOptions), so "which contacts show up" behaves identically
  // in both places rather than drifting into two different filtering rules.
  // Always refetches fresh (same as the edit modal does on every open) —
  // no staleness risk if a trucker/supplier was just added elsewhere.
  await loadModalContacts();
  const b = bookingsCache[bkg];
  const pol = b?.port_of_loading || '';
  const list = isAssign ? modalSuppliersList : modalTruckersList;
  $('fwd_contact').innerHTML = buildContactOptions(list, '', pol);

  $('forwardModal').classList.remove('hidden');
}
function closeForwardModal() { $('forwardModal').classList.add('hidden'); }
$('btnCloseForwardModal').addEventListener('click', closeForwardModal);
$('btnCancelForward').addEventListener('click', closeForwardModal);
$('forwardModal').addEventListener('click', (e) => { if (e.target.id === 'forwardModal') closeForwardModal(); });
$('btnConfirmForward').addEventListener('click', async () => {
  const { bkg, seq, kind } = forwardModalState;
  const name = $('fwd_contact').value;
  if (!name) { $('fwd_error').textContent = 'Pick one first.'; return; }
  const btn = $('btnConfirmForward');
  btn.disabled = true; btn.textContent = 'Sending…';
  $('fwd_error').textContent = '';
  try {
    const text = `${kind} ${bkg}/${seq} to ${name}`;
    const res = await api('/api/bot/command', { method: 'POST', body: JSON.stringify({ text }) });
    const replies = (res.replies || []).map(r => r.text || '').filter(Boolean);
    // The backend's own guards (no supplier assigned, container not found,
    // trucker not on file, etc.) come back as plain reply text, not an HTTP
    // error — surface them as an error in the modal instead of pretending
    // it worked, so a blocked forward doesn't silently look like a success.
    const blocked = replies.some(t => /^(Can't|No booking found|Container .* not found|Trucker ".*" not found|Supplier ".*" not found)/.test(t));
    if (blocked) {
      $('fwd_error').textContent = replies.join(' ');
      btn.disabled = false; btn.textContent = 'Send';
      return;
    }
    closeForwardModal();
    await loadTab('bookings');
  } catch (e) {
    $('fwd_error').textContent = e.message;
    btn.disabled = false; btn.textContent = 'Send';
  }
});

// ── TRUCKERS / SUPPLIERS (shared contact modal) ──────────────────────────
let contactKind = null;
let contactListCache = [];

function openContactModal(kind, existing) {
  contactKind = kind;
  $('contactModalTitle').textContent = existing ? `Edit ${kind.slice(0, -1)}` : `New ${kind.slice(0, -1)}`;
  $('ct_name').value = existing?.name || ''; $('ct_name').disabled = !!existing;
  $('ct_locality').value = existing?.locality || '';
  $('ct_whatsapp').value = existing?.whatsapp || '';
  $('ct_email').value = existing?.email || '';
  $('ct_group_id').value = existing?.group_id || '';
  $('ct_group_name').value = existing?.group_name || '';
  $('ct_group_search').value = '';
  $('ct_group_search_results').innerHTML = '';
  $('ct_mode').value = existing?.preferred_mode || 'whatsapp';
  $('ct_verify_result').classList.add('hidden');
  $('ct_common_groups').classList.add('hidden');
  $('ct_error').textContent = '';
  $('contactModal').classList.remove('hidden');
}
function closeContactModal() { $('contactModal').classList.add('hidden'); $('ct_name').disabled = false; contactKind = null; }
$('btnCloseContactModal').addEventListener('click', closeContactModal);
$('btnCancelContact').addEventListener('click', closeContactModal);

// Verify a specific number is on WhatsApp, then show groups Jarvis shares
// with that exact contact — precise (guaranteed real overlap), narrower than
// the name-search picker below. Both are kept: this restores the original
// dashboard's flow; the name-search is what was asked for more recently.
$('ct_verify').addEventListener('click', async () => {
  const raw = $('ct_whatsapp').value.trim().replace(/\D/g, '');
  const result = $('ct_verify_result');
  if (raw.length < 8) { result.classList.remove('hidden'); result.style.background = 'var(--copper-soft)'; result.style.color = 'var(--copper-onSoft)'; result.textContent = 'Enter a full WhatsApp number first.'; return; }
  const btn = $('ct_verify');
  btn.disabled = true; btn.textContent = 'Checking…';
  result.classList.remove('hidden'); result.style.background = 'var(--surface-sunken)'; result.style.color = 'var(--text-muted)'; result.textContent = 'Contacting WhatsApp…';
  try {
    const vd = await api('/api/whatsapp/verify-number', { method: 'POST', body: JSON.stringify({ number: raw }) });
    if (!vd.registered) {
      result.style.background = '#FBE1E6'; result.style.color = 'var(--status-danger)'; result.textContent = '✗ Not on WhatsApp';
      $('ct_common_groups').classList.add('hidden');
      return;
    }
    result.style.background = 'var(--accent-soft)'; result.style.color = 'var(--accent-onSoft)'; result.textContent = '✓ On WhatsApp' + (vd.formatted ? ` (${vd.formatted})` : '');
    const cd = await api('/api/whatsapp/common-groups', { method: 'POST', body: JSON.stringify({ contactId: vd.contactId }) });
    const groups = cd.groups || [];
    $('ct_common_groups').classList.remove('hidden');
    if (!groups.length) {
      $('ct_common_groups_list').innerHTML = '';
      $('ct_common_groups_empty').classList.remove('hidden');
    } else {
      $('ct_common_groups_empty').classList.add('hidden');
      $('ct_common_groups_list').innerHTML = groups.map(g => {
        const unresolved = g.name && g.name.startsWith('(name unavailable');
        const testBtn = unresolved ? `<button type="button" class="btn btn-secondary cg-test" data-id="${esc(g.id)}" style="padding:5px 10px; font-size:9.5px; margin-right:6px;">Send test</button>` : '';
        return `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:7px 0; border-bottom:1px solid var(--border-subtle);">
          <div><div style="font-size:12.5px; font-weight:600;">${esc(g.name)}</div><div style="font-family:var(--font-mono); font-size:10px; color:var(--text-faint);">${esc(g.id)}${g.participants ? ' · ' + g.participants + ' members' : ''}</div></div>
          <div>${testBtn}<button type="button" class="btn btn-secondary cg-use" data-id="${esc(g.id)}" data-name="${esc(g.name)}" style="padding:5px 10px; font-size:9.5px;">Use</button></div>
        </div>`;
      }).join('');
      $('ct_common_groups_list').querySelectorAll('.cg-use').forEach(b => b.addEventListener('click', () => { $('ct_group_id').value = b.dataset.id; $('ct_group_name').value = b.dataset.name; }));
      $('ct_common_groups_list').querySelectorAll('.cg-test').forEach(b => {
        b.addEventListener('click', async () => {
          b.disabled = true; b.textContent = 'Sending…';
          try {
            const label = $('ct_name').value.trim() || 'this contact';
            await api('/api/whatsapp/test-group-message', { method: 'POST', body: JSON.stringify({ groupId: b.dataset.id, label }) });
            b.textContent = 'Sent ✓ check WhatsApp';
          } catch (e) {
            b.textContent = 'Failed';
            console.error('test-group-message failed:', e.message);
          }
        });
      });
    }
  } catch (e) {
    result.style.background = '#FBE1E6'; result.style.color = 'var(--status-danger)'; result.textContent = 'Verify failed: ' + e.message;
  } finally { btn.disabled = false; btn.textContent = 'Verify'; }
});

// Generic search-by-name group picker — shared with Settings' team-group and
// team-member rows. rowEl must contain .grp-search-input / .grp-search-results
// / .grp-id-target, and optionally .grp-name-target.
async function doGroupSearch(rowEl) {
  const name = rowEl.querySelector('.grp-search-input').value.trim();
  const box = rowEl.querySelector('.grp-search-results');
  const idField = rowEl.querySelector('.grp-id-target');
  const nameField = rowEl.querySelector('.grp-name-target');
  box.innerHTML = '<div style="font-family:var(--font-mono); font-size:10.5px; color:var(--text-faint);">Searching…</div>';
  try {
    const { groups } = await api('/api/whatsapp/find-groups', { method: 'POST', body: JSON.stringify({ name }) });
    if (!groups || !groups.length) { box.innerHTML = '<div style="font-family:var(--font-mono); font-size:10.5px; color:var(--text-faint);">No matches — make sure Jarvis has already been added to that group.</div>'; return; }
    box.innerHTML = groups.map(g => `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:7px 10px; background:var(--surface-sunken); border-radius:var(--radius-xs);">
        <div style="font-size:12px;"><strong>${esc(g.name || g.subject || '(unnamed)')}</strong> <span style="font-family:var(--font-mono); font-size:10px; color:var(--text-faint);">${esc(g.id || g.chatId || '')}</span></div>
        <button class="btn btn-secondary grp-use" data-id="${esc(g.id || g.chatId || '')}" data-name="${esc(g.name || g.subject || '')}" style="padding:5px 10px; font-size:9.5px;">Use</button>
      </div>`).join('');
    box.querySelectorAll('.grp-use').forEach(btn => btn.addEventListener('click', () => {
      idField.value = btn.dataset.id;
      if (nameField) nameField.value = btn.dataset.name;
      box.innerHTML = '';
    }));
  } catch (e) { box.innerHTML = `<div style="font-family:var(--font-mono); font-size:10.5px; color:var(--status-danger);">${esc(e.message)}</div>`; }
}
$('ct_group_search_btn').addEventListener('click', () => doGroupSearch($('contactModal')));

$('btnSaveContact').addEventListener('click', async () => {
  const name = $('ct_name').value.trim();
  if (!name) { $('ct_error').textContent = 'Name is required.'; return; }
  const whatsapp = $('ct_whatsapp').value.trim().replace(/\D/g, '');
  const email = $('ct_email').value.trim();
  const mode = $('ct_mode').value;
  const groupId = $('ct_group_id').value.trim();
  if (mode === 'whatsapp' && !whatsapp && !groupId) { $('ct_error').textContent = 'For WhatsApp mode, provide a number or a group ID.'; return; }
  if (mode === 'email' && !email) { $('ct_error').textContent = 'For Email mode, provide an email address.'; return; }
  $('ct_error').textContent = '';
  const btn = $('btnSaveContact');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Saving…';
  try {
    await api(`/api/${contactKind}`, { method: 'POST', body: JSON.stringify({
      name, locality: $('ct_locality').value.trim() || null, whatsapp: whatsapp || null,
      email: email || null, group_id: groupId || null, group_name: $('ct_group_name').value.trim() || null,
      preferred_mode: mode,
    }) });
    const kind = contactKind;
    closeContactModal();
    loadTab(kind);
  } catch (e) { $('ct_error').textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = 'Save'; }
});

// ── TRUCKERS & SUPPLIERS, ONE HEADING ─────────────────────────────────────
// Apsara, 2026-09-24: "can we combine truckers and suppliers into single
// heading .Inside that make sub tab as truckers,suppliers?"
//
// EDGE METALS. The yard's haulier screen is Trucker Bills and is a different
// thing entirely — a directory of contacts here, a list of debts there. The
// comment above that nav entry has said so since 2026-09-03.
//
// Which sub-tab is showing survives a switch away and back, the same way
// pettyTab does, so moving between Bookings and here does not keep resetting
// her to Truckers when she is working through suppliers.
let partnersTab = 'truckers';

async function renderPartners() {
    const kind = partnersTab === 'suppliers' ? 'suppliers' : 'truckers';
    const list = await api(kind === 'suppliers' ? '/api/suppliers' : '/api/truckers');
    // The screens are UNCHANGED — same renderer, same wording, same Add
    // button. Only the way in is shared, which is what she asked for.
    if (kind === 'suppliers') renderContacts('suppliers', 'Yard network', '+ Add supplier', list);
    else renderContacts('truckers', 'Drayage roster', '+ Add trucker', list);

    // The strip goes in AFTER the screen has drawn, rather than inside
    // renderContacts — that function is shared and has no business knowing it
    // is being shown under a combined tab.
    const host = $('viewRoot') && $('viewRoot').querySelector('section');
    if (!host) return;
    const btn = (id, label) => `<button class="btn partners-tab" data-partners-tab="${id}" style="font-size:12px; padding:6px 14px;${partnersTab === id ? ' background:var(--surface-raised); color:var(--text-strong);' : ''}">${label}</button>`;
    host.insertAdjacentHTML('afterbegin',
        `<div style="display:flex; gap:8px; margin-bottom:18px;">${btn('truckers', 'Truckers')}${btn('suppliers', 'Suppliers')}</div>`);
    host.querySelectorAll('.partners-tab').forEach((b) => b.addEventListener('click', () => {
        if (partnersTab === b.dataset.partnersTab) return;   // already here
        partnersTab = b.dataset.partnersTab;
        renderPartners();
    }));
}

function renderContacts(kind, title, addLabel, list) {
  contactListCache = list;
  $('viewRoot').innerHTML = `
    <section style="max-width:1120px; margin:0 auto; padding:38px 40px 80px;">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:22px;">
        <div><div class="eyebrow">// ${esc(kind[0].toUpperCase() + kind.slice(1))}</div><h2 style="font-size:24px; text-transform:uppercase;">${esc(title)}</h2></div>
        <button id="btnAddContact" class="btn btn-primary">${esc(addLabel)}</button>
      </div>
      <div class="card" style="overflow:hidden;">
        <div style="display:grid; grid-template-columns:150px 120px 1fr 90px 140px; gap:14px; padding:12px 18px; background:var(--surface-sunken); border-bottom:1px solid var(--border-subtle); font-family:var(--font-mono); font-size:9.5px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:var(--text-muted);">
          <div>Name</div><div>Locality</div><div>Email / Reaches via</div><div>Preferred</div><div style="text-align:right;">Actions</div>
        </div>
        ${list.length ? list.map(p => {
          const dest = p.group_id ? `${p.group_name || 'Group'} (${p.group_id})` : (p.whatsapp || '(no WhatsApp)');
          const modeLabel = p.preferred_mode === 'email' ? 'Email' : 'WhatsApp';
          return `
          <div class="row-hover" style="display:grid; grid-template-columns:150px 120px 1fr 90px 140px; gap:14px; padding:14px 18px; border-bottom:1px solid var(--border-subtle); align-items:center;">
            <div style="font-family:var(--font-mono); font-size:12.5px; font-weight:600; color:var(--text-strong);">${esc(p.name)}</div>
            <div>${p.locality ? `<span class="badge" style="background:var(--accent-soft); color:var(--accent-onSoft);">${esc(p.locality)}</span>` : '<span style="color:var(--text-faint);">—</span>'}</div>
            <div style="font-size:12px;">${esc(p.email || '—')}<br><span style="font-family:var(--font-mono); font-size:10.5px; color:var(--text-faint);">${esc(dest)}</span></div>
            <div style="font-family:var(--font-mono); font-size:11px; color:var(--text-muted);">${modeLabel}</div>
            <div style="display:flex; gap:6px; justify-content:flex-end;">
              <button class="btn btn-secondary btn-edit-contact" data-name="${esc(p.name)}" style="padding:6px 12px; font-size:10px;">Edit</button>
              <button class="btn btn-danger btn-del-contact" data-name="${esc(p.name)}" style="padding:6px 12px; font-size:10px;">Del</button>
            </div>
          </div>`;
        }).join('') : '<div style="padding:40px; text-align:center; color:var(--text-faint); font-family:var(--font-mono); font-size:12px;">None registered yet.</div>'}
      </div>
    </section>`;
  $('btnAddContact').addEventListener('click', () => openContactModal(kind, null));
  document.querySelectorAll('.btn-edit-contact').forEach(btn => btn.addEventListener('click', () => openContactModal(kind, contactListCache.find(c => c.name === btn.dataset.name))));
  document.querySelectorAll('.btn-del-contact').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm(`Remove ${btn.dataset.name}?`)) return;
    await api(`/api/${kind}/${encodeURIComponent(btn.dataset.name)}`, { method: 'DELETE' });
    loadTab(kind);
  }));
}

// ── WHATSAPP ──────────────────────────────────────────────────────────────
// Full-bleed 3D orbit scene, restored from the mockup. Decorative geometry
// (ring radii, beam angles, node positions) is fixed/hand-tuned to match what
// the mockup showed — the mockup's own values were template variables I never
// saw resolved. The DATA inside it is real: node cards pull actual trucker/
// supplier names, and the stats strip pulls real counts from the API, not
// placeholder numbers.
async function renderWhatsapp() {
  const root = $('viewRoot');
  let status = { status: 'unknown' }, truckers = [], suppliers = [], dash = null;
  try { status = await api('/api/whatsapp/status'); } catch {}
  try {
    [truckers, suppliers, dash] = await Promise.all([
      api('/api/truckers').catch(() => []),
      api('/api/suppliers').catch(() => []),
      api('/api/dashboard').catch(() => null),
    ]);
  } catch {}
  const isReady = status.status === 'ready';
  const isQr = status.status === 'qr';

  const NODE_POS = [
    { left: '16%', top: '26%', dur: '5.5s', delay: '0s' },
    { left: '80%', top: '22%', dur: '6.2s', delay: '.4s' },
    { left: '18%', top: '76%', dur: '5.8s', delay: '.8s' },
    { left: '80%', top: '72%', dur: '6.6s', delay: '.2s' },
  ];
  const nodeSource = [
    ...(Array.isArray(truckers) ? truckers : []).map(t => ({ name: t.name, line: (t.locality || 'Trucker') + (t.group_id ? ' · group' : '') })),
    ...(Array.isArray(suppliers) ? suppliers : []).map(s => ({ name: s.name, line: (s.locality || 'Supplier') + (s.group_id ? ' · group' : '') })),
  ].slice(0, 4);
  const nodes = nodeSource.map((n, i) => ({ ...n, ...NODE_POS[i] }));

  const stats = [
    { v: truckers.length || 0, k: 'Truckers linked' },
    { v: suppliers.length || 0, k: 'Suppliers linked' },
    { v: dash ? dash.bookings.length : '—', k: 'Active bookings' },
    { v: dash ? dash.alerts.length : '—', k: 'Needs attention' },
  ];

  root.innerHTML = `
    <div class="view-in" style="position:relative; height:100%; min-height:600px; overflow:hidden; background:radial-gradient(900px 600px at 50% 42%, rgba(61,168,54,.10), transparent 65%), #0C0E10;">
      <div style="position:absolute; inset:0; background-image:repeating-linear-gradient(-45deg, rgba(194,94,34,.05) 0, rgba(194,94,34,.05) 2px, transparent 2px, transparent 18px);"></div>
      <div style="position:absolute; left:50%; top:44%; width:0; height:0; perspective:1200px;">
        <div style="position:absolute; left:-370px; top:-370px; width:740px; height:740px; border-radius:50%; border:1px dashed rgba(87,190,73,.22); animation:emOrbit 34s linear infinite;">
          <span style="position:absolute; left:50%; top:-4px; width:8px; height:8px; margin-left:-4px; border-radius:50%; background:#57BE49; box-shadow:0 0 14px #57BE49;"></span>
          <span style="position:absolute; left:-4px; top:50%; width:6px; height:6px; margin-top:-3px; border-radius:50%; background:#D77E3D; box-shadow:0 0 12px #D77E3D;"></span>
        </div>
        <div style="position:absolute; left:-255px; top:-255px; width:510px; height:510px; border-radius:50%; border:1px solid rgba(87,190,73,.28); animation:emOrbitRev 22s linear infinite;">
          <span style="position:absolute; right:-5px; top:50%; width:9px; height:9px; margin-top:-4px; border-radius:50%; background:#57BE49; box-shadow:0 0 16px #57BE49;"></span>
          <span style="position:absolute; left:50%; bottom:-4px; width:6px; height:6px; margin-left:-3px; border-radius:50%; background:#7FD172; box-shadow:0 0 10px #7FD172;"></span>
        </div>
        <div style="position:absolute; left:-150px; top:-150px; width:300px; height:300px; border-radius:50%; border:1px dashed rgba(194,94,34,.3); animation:emOrbit 14s linear infinite;">
          <span style="position:absolute; left:50%; top:-4px; width:7px; height:7px; margin-left:-3px; border-radius:50%; background:#D77E3D; box-shadow:0 0 12px #D77E3D;"></span>
        </div>
        <div style="position:absolute; left:0; top:0; width:427px; height:2px; transform:rotate(200.6deg); transform-origin:0 50%; background-image:repeating-linear-gradient(90deg, rgba(87,190,73,.55) 0, rgba(87,190,73,.55) 8px, transparent 8px, transparent 20px); background-size:120px 2px; animation:emBeam 1.6s linear infinite;"></div>
        <div style="position:absolute; left:0; top:0; width:434px; height:2px; transform:rotate(-26deg); transform-origin:0 50%; background-image:repeating-linear-gradient(90deg, rgba(87,190,73,.55) 0, rgba(87,190,73,.55) 8px, transparent 8px, transparent 20px); background-size:120px 2px; animation:emBeam 1.9s linear infinite;"></div>
        <div style="position:absolute; left:0; top:0; width:402px; height:2px; transform:rotate(153.4deg); transform-origin:0 50%; background-image:repeating-linear-gradient(90deg, rgba(87,190,73,.55) 0, rgba(87,190,73,.55) 8px, transparent 8px, transparent 20px); background-size:120px 2px; animation:emBeam 2.2s linear infinite;"></div>
        <div style="position:absolute; left:0; top:0; width:449px; height:2px; transform:rotate(20.9deg); transform-origin:0 50%; background-image:repeating-linear-gradient(90deg, rgba(87,190,73,.55) 0, rgba(87,190,73,.55) 8px, transparent 8px, transparent 20px); background-size:120px 2px; animation:emBeam 1.4s linear infinite;"></div>
        <div style="position:absolute; left:-58px; top:-58px; width:116px; height:116px;">
          <span style="position:absolute; inset:0; border-radius:50%; border:1px solid rgba(87,190,73,.5); animation:emPing 2.4s cubic-bezier(.2,.7,.2,1) infinite;"></span>
          <span style="position:absolute; inset:0; border-radius:50%; border:1px solid rgba(87,190,73,.35); animation:emPing 2.4s cubic-bezier(.2,.7,.2,1) infinite; animation-delay:1.2s;"></span>
          <div style="position:absolute; inset:8px;">
            <span style="position:absolute; inset:-18px; border-radius:50%; background:radial-gradient(circle, rgba(215,126,61,.45), transparent 68%); animation:emGlow 2.2s ease-in-out infinite;"></span>
            <span style="position:absolute; inset:0; border-radius:50%; background:repeating-conic-gradient(rgba(215,126,61,.9) 0deg 14deg, transparent 14deg 36deg); -webkit-mask:radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 4px)); mask:radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 4px)); animation:emSpin 9s linear infinite;"></span>
            <span style="position:absolute; inset:8px; border-radius:50%; background:conic-gradient(from 0deg, transparent 0 64%, rgba(255,214,170,.95)); -webkit-mask:radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px)); mask:radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px)); animation:emSpin 2.4s linear infinite;"></span>
            <span style="position:absolute; inset:16px; border-radius:50%; background:repeating-conic-gradient(rgba(87,190,73,.7) 0deg 3deg, transparent 3deg 15deg); -webkit-mask:radial-gradient(farthest-side, transparent calc(100% - 7px), #000 calc(100% - 6px)); mask:radial-gradient(farthest-side, transparent calc(100% - 7px), #000 calc(100% - 6px)); animation:emSpinRev 6s linear infinite;"></span>
            <span style="position:absolute; inset:26px; border-radius:50%; background:repeating-conic-gradient(rgba(255,184,119,.95) 0deg 20deg, transparent 20deg 36deg); -webkit-mask:radial-gradient(farthest-side, transparent calc(100% - 9px), #000 calc(100% - 8px)); mask:radial-gradient(farthest-side, transparent calc(100% - 9px), #000 calc(100% - 8px)); animation:emSpinRev 14s linear infinite;"></span>
            <span style="position:absolute; inset:32px; border-radius:50%; border:1px solid rgba(255,214,170,.7); animation:emPing 2.2s cubic-bezier(.2,.7,.2,1) infinite;"></span>
            <span style="position:absolute; left:50%; top:50%; width:34px; height:34px; margin:-17px 0 0 -17px; border-radius:50%; background:radial-gradient(circle at 40% 38%, #FFFFFF, #FFE7CB 40%, #FFB877 70%, #D77E3D 100%); box-shadow:0 0 50px rgba(255,214,170,1), 0 0 110px rgba(215,126,61,.6); animation:emGlow 1.2s ease-in-out infinite;"></span>
          </div>
        </div>
        ${nodes.map(n => `
          <div style="position:absolute; left:${n.left}; top:${n.top}; transform:translate(-50%,-50%); display:flex; align-items:center; gap:10px; padding:10px 16px; background:rgba(20,24,27,.88); border:1px solid #2B3239; border-radius:4px; backdrop-filter:blur(6px); box-shadow:0 10px 30px rgba(0,0,0,.5); animation:emFloat ${n.dur} ease-in-out infinite; animation-delay:${n.delay};">
            <span style="width:7px; height:7px; border-radius:50%; background:#57BE49; box-shadow:0 0 10px #57BE49; animation:jarvis-pulse 2s ease-in-out infinite;"></span>
            <div>
              <div style="font-family:var(--font-display); font-size:12.5px; font-weight:800; text-transform:uppercase; color:#fff; letter-spacing:.03em;">${esc(n.name)}</div>
              <div style="font-family:var(--font-mono); font-size:9.5px; color:#7E8891;">${esc(n.line)}</div>
            </div>
          </div>`).join('')}
      </div>
      <div style="position:absolute; left:clamp(24px,5vw,64px); bottom:120px; max-width:560px; padding-right:20px;">
        <div style="font-family:var(--font-mono); font-size:11px; letter-spacing:.22em; text-transform:uppercase; color:var(--copper-400); margin-bottom:12px;">// WhatsApp link</div>
        ${isReady ? `
          <h1 style="margin:0; font-family:var(--font-display); font-size:clamp(46px,6vw,80px); font-weight:900; text-transform:uppercase; letter-spacing:-.03em; line-height:.94; color:#fff; text-shadow:0 0 80px rgba(87,190,73,.45);">Connected<span style="color:#57BE49;">.</span></h1>
          <div style="font-size:14px; color:#A7B0B7; margin-top:14px; max-width:420px;">Jarvis is on the wire. Every trucker, supplier, and team group routes through this link.</div>
        ` : isQr ? `
          <h1 style="margin:0; font-family:var(--font-display); font-size:clamp(36px,5vw,58px); font-weight:900; text-transform:uppercase; letter-spacing:-.03em; line-height:.98; color:#fff; text-shadow:0 0 80px rgba(217,154,43,.4);">Scan to connect<span style="color:var(--status-warning);">.</span></h1>
          <div style="font-size:14px; color:#A7B0B7; margin-top:14px; max-width:420px;">Open WhatsApp on the linked phone → Settings → Linked devices → Link a device, then scan this code. No need to sign out of this dashboard — this only resets Jarvis's WhatsApp link.</div>
          <div style="display:inline-block; margin-top:16px; padding:14px; background:rgba(20,24,27,.9); border:1px solid #2B3239; border-radius:8px; backdrop-filter:blur(6px);">
            <div id="waQrBox" style="display:inline-block; background:#fff; padding:10px; border-radius:4px; line-height:0;"></div>
          </div>
        ` : `
          <h1 style="margin:0; font-family:var(--font-display); font-size:clamp(46px,6vw,80px); font-weight:900; text-transform:uppercase; letter-spacing:-.03em; line-height:.94; color:#fff; text-shadow:0 0 80px rgba(197,64,47,.5);">Link down<span style="color:var(--status-danger);">.</span></h1>
          <div style="font-size:14px; color:#A7B0B7; margin-top:14px; max-width:420px;">${esc(status.error || 'The wire went quiet. Jarvis is retrying.')}</div>
        `}
      </div>
      <div style="position:absolute; left:clamp(24px,5vw,64px); right:clamp(24px,5vw,64px); bottom:20px; display:flex; flex-wrap:wrap; align-items:center; gap:clamp(14px,3vw,40px); padding-top:16px; border-top:1px solid #1E2429;">
        ${stats.map(s => `
          <div>
            <div style="font-family:var(--font-mono); font-size:20px; font-weight:600; color:#fff;">${esc(s.v)}</div>
            <div style="font-family:var(--font-mono); font-size:9px; letter-spacing:.16em; text-transform:uppercase; color:#57616A; margin-top:3px;">${esc(s.k)}</div>
          </div>`).join('')}
        <div style="flex:1;"></div>
        ${ROLE === 'admin' ? '<button id="btnWaReset" class="btn btn-dark" style="border-color:#2B3239;">Sign out &amp; re-scan</button>' : ''}
      </div>
    </div>`;
  // Render the actual scannable QR image (dashboard/qrcode.min.js — the browser
  // build of the "qrcode" npm package: create/toCanvas/toDataURL/toString, NOT
  // a davidshimjs-style `new QRCode(el, opts)` constructor). Verified against
  // this exact bundled file: toDataURL(text, cb) alone throws "You need to
  // specify a canvas element" in this build — it only works via toCanvas(el,
  // text, opts, cb) with a real <canvas> passed in. status.qr is the raw
  // string wa-state.js stores off the client's 'qr' event; /api/whatsapp/status
  // was already returning it, the dashboard just never drew it.
  if (isQr && status.qr && $('waQrBox')) {
    const box = $('waQrBox');
    box.innerHTML = '';
    const canvas = document.createElement('canvas');
    box.appendChild(canvas);
    QRCode.toCanvas(canvas, status.qr, { width: 200, margin: 1 }, (err) => {
      if (err) box.innerHTML = `<div style="color:var(--status-danger); font-size:12px; padding:8px;">QR render failed: ${esc(err.message)}</div>`;
    });
  }
  if ($('btnWaReset')) $('btnWaReset').addEventListener('click', async () => {
    if (!confirm('This logs Jarvis out of WhatsApp and requires a fresh QR scan. Continue?')) return;
    await api('/api/whatsapp/reset', { method: 'POST' });
    alert('Reset triggered — the process is restarting. Stay on this tab (no need to sign out) — the new QR will appear automatically in a few seconds.');
  });
  // WhatsApp's QR rotates every ~20-30s until scanned, and after a reset the
  // process has to fully respawn (pm2) before a new one exists. Keep polling
  // status + re-rendering this tab, only while it's the active tab, until we
  // land on 'ready' — so reconnecting never requires leaving this dashboard
  // session or hunting through server logs.
  if (waQrRefreshTimer) { clearInterval(waQrRefreshTimer); waQrRefreshTimer = null; }
  if (status.status !== 'ready') {
    waQrRefreshTimer = setInterval(() => { if (CURRENT_TAB === 'whatsapp') renderWhatsapp(); }, 20000);
  }
  updateWaBadge(status);
}
function updateWaBadge(status) {
  const dot = $('waStatusDot'), text = $('waStatusText'), banner = $('linkDownBanner'), bannerText = $('linkDownText');
  if (status.status === 'ready') {
    dot.style.background = 'var(--leaf-400)'; dot.style.boxShadow = '0 0 8px var(--leaf-400)'; dot.style.animation = 'jarvis-pulse 2.4s ease-in-out infinite';
    text.textContent = 'Live · synced from WhatsApp';
    // The line is hidden now; the dot is what she sees, so it carries the words.
    { const d = document.getElementById('waStatusDot'); if (d) d.title = 'Live · synced from WhatsApp'; }
    banner.classList.add('hidden');
  } else if (status.status === 'qr') {
    dot.style.background = 'var(--status-warning)'; dot.style.boxShadow = '0 0 8px var(--status-warning)';
    text.textContent = 'QR scan needed'; bannerText.textContent = 'WhatsApp needs a QR scan to connect.'; banner.classList.remove('hidden');
  } else {
    dot.style.background = 'var(--status-danger)'; dot.style.boxShadow = '0 0 8px var(--status-danger)';
    text.textContent = 'Link down — retrying'; bannerText.textContent = 'WhatsApp link is down.'; banner.classList.remove('hidden');
  }
}

// ── SETTINGS (admin only) ─────────────────────────────────────────────────
