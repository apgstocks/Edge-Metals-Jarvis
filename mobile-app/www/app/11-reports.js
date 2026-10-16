// mobile-app/www/app/11-reports.js — split from mobile-app/www/index.html's <script> (helpers/sourceParts.js reconstructs the original)
// ── Trucker tab ──────────────────────────────────────────────────────────
// Apsara 2026-09-03: "now include a tab called trucker for everyone ... it
// contains date, company name, load ticket number (optional), amount. edit,
// delete, pay option should be there. when i click pay - option should be as
// zelle/wire. once paid, hide delete option for staff and admin."
//
// NOT the trucker ROSTER on the website, which is a directory of hauliers and
// their WhatsApp groups. This is what the yard OWES them. Two different things
// wearing the same word — see helpers/truckerBills.js.
let truckerBills = [];
let truckerModes = ['Zelle', 'Wire'];
let editingTruckerBillId = null;
let payingTruckerBill = null;

// Mirrors loadIsDeletable exactly, including the Jarvis exception. Same rule,
// same shape, so the two cannot drift into meaning different things about the
// same idea.
function truckerBillIsDeletable(b) {
  if (IS_SUPER) return true;
  const p = b && b.payment;
  return !(p && Number(p.paid) > 0);
}
// Payable while anything is outstanding — and only for a session that is
// allowed to record payments at all. Staff see the tab and the amounts; they
// do not settle bills, because /api/payments would 403 them and a button that
// always fails is worse than no button.
function truckerBillIsPayable(b) {
  if (ROLE === 'staff') return false;
  const p = b && b.payment;
  if (!p) return true;
  return p.status !== 'paid' && p.status !== 'overpaid';
}

function truckerBadge(b) {
  const p = b && b.payment;
  if (!p || !p.paid) return '<span class="pay-badge pay-none">UNPAID</span>';
  if (p.status === 'overpaid') return `<span class="pay-badge pay-over">OVERPAID ${payMoney(p.over)}</span>`;
  if (p.status === 'paid') return `<span class="pay-badge pay-full">PAID ${payMoney(p.paid)}</span>`;
  return `<span class="pay-badge pay-part">PART ${payMoney(p.paid)}</span>`;
}

async function renderTruckerTab() {
  // Wire on first visit — see wireTruckerModals for why not at boot.
  wireTruckerModals();
  const data = await api('/api/trucker-bills');
  truckerBills = Array.isArray(data.bills) ? data.bills : [];
  truckerModes = Array.isArray(data.modes) && data.modes.length ? data.modes : truckerModes;
  if (Array.isArray(data.banks) && data.banks.length) bankOptions = data.banks;
  if (Array.isArray(data.bank_modes) && data.bank_modes.length) bankModes = data.bank_modes;
  if (typeof data.other === 'string' && data.other) bankOther = data.other;
  const rep = data.report || { billed: 0, paid: 0, outstanding: 0, overpaid: 0, count: 0 };

  $('viewRoot').innerHTML = `
    <div style="padding:16px 14px 90px;">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:14px;">
        <div>
          <div class="eyebrow">// Trucker</div>
          <h2 style="font-size:19px; text-transform:uppercase; margin:0;">Haulage bills</h2>
        </div>
        <button id="btnAddTruckerBill" class="btn btn-primary" style="font-size:12px; padding:8px 14px;">+ Add bill</button>
      </div>

      <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; margin-bottom:16px;">
        <div class="card" style="padding:12px;">
          <div style="font-family:var(--font-mono); font-size:9px; letter-spacing:.12em; text-transform:uppercase; color:var(--text-muted);">Billed</div>
          <div style="font-size:16px; font-weight:700; margin-top:4px;">${payMoney(rep.billed)}</div>
        </div>
        <div class="card" style="padding:12px;">
          <div style="font-family:var(--font-mono); font-size:9px; letter-spacing:.12em; text-transform:uppercase; color:var(--text-muted);">Paid</div>
          <div style="font-size:16px; font-weight:700; margin-top:4px;">${payMoney(rep.paid)}</div>
        </div>
        <div class="card" style="padding:12px;">
          <div style="font-family:var(--font-mono); font-size:9px; letter-spacing:.12em; text-transform:uppercase; color:var(--text-muted);">Outstanding</div>
          <div style="font-size:16px; font-weight:700; margin-top:4px; color:${rep.outstanding > 0 ? 'var(--status-warn)' : 'var(--text-strong)'};">${payMoney(rep.outstanding)}</div>
        </div>
      </div>
      ${rep.overpaid > 0 ? `
      <!-- Shown ONLY when it is non-zero, and never netted against
           outstanding. Money paid beyond what was billed is something to ring
           the hauler about, not a credit to quietly subtract — see
           billsReport in helpers/truckerBills.js. -->
      <div class="card" style="padding:10px 12px; margin-bottom:14px; border-color:var(--status-warn);">
        <span style="font-family:var(--font-mono); font-size:11px; color:var(--status-warn);">
          ${payMoney(rep.overpaid)} paid beyond what was billed — chase it back.
        </span>
      </div>` : ''}

      <div class="card" style="overflow:hidden;">
        <table id="trkBillsTable" class="stack-table" style="width:100%; border-collapse:collapse; font-size:12.5px; min-width:560px;">
          <thead>
            <tr style="background:var(--surface-sunken); color:var(--text-muted); font-family:var(--font-mono); font-size:9.5px; letter-spacing:.12em; text-transform:uppercase;">
              <th style="padding:9px 12px; text-align:left;">Company</th>
              <th style="padding:9px 12px; text-align:left;">Date</th>
              <th style="padding:9px 12px; text-align:left;">Ticket</th>
              <th style="padding:9px 12px; text-align:right;">Amount</th>
              <th style="padding:9px 12px; text-align:left;">Status</th>
              <th style="padding:9px 12px; text-align:right;">Actions</th>
            </tr>
          </thead>
          <tbody>
          ${truckerBills.length ? truckerBills.map(b => `
            <tr style="border-bottom:1px solid var(--border-subtle);">
              <td class="st-head" style="padding:9px 12px; font-weight:600; color:var(--text-strong);">${esc(b.company)}</td>
              <td data-label="Date" style="padding:9px 12px; font-family:var(--font-mono); color:var(--text-muted);">${esc(fmtDate(b.date))}</td>
              <td data-label="Ticket" style="padding:9px 12px; font-family:var(--font-mono); color:var(--text-muted);">${b.load_ticket ? esc(b.load_ticket) : '—'}</td>
              <td data-label="Amount" style="padding:9px 12px; text-align:right; font-family:var(--font-mono);">${payMoney(b.amount)}</td>
              <td data-label="Status" style="padding:9px 12px;">${truckerBadge(b)}</td>
              <td data-label="Actions" style="padding:9px 12px; text-align:right;">
                <div style="display:flex; gap:5px; justify-content:flex-end; flex-wrap:wrap;">
                  <button class="btn btn-secondary btn-edit-trk" data-id="${esc(b.id)}" style="padding:5px 10px; font-size:10.5px;">Edit</button>
                  ${truckerBillIsPayable(b) ? `<button class="btn btn-pay-trk" data-id="${esc(b.id)}" style="padding:5px 10px; font-size:10.5px;">Pay</button>` : ''}
                  ${truckerBillIsDeletable(b) ? `<button class="btn btn-danger btn-del-trk" data-id="${esc(b.id)}" style="padding:5px 10px; font-size:10.5px;">Delete</button>` : ''}
                </div>
              </td>
            </tr>`).join('')
          : `<tr><td colspan="6" style="padding:34px; text-align:center; color:var(--text-faint); font-family:var(--font-mono); font-size:12px;">No trucker bills yet.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>`;

  $('btnAddTruckerBill').addEventListener('click', () => openTruckerBillModal(null));
  document.querySelectorAll('.btn-edit-trk').forEach(btn => btn.addEventListener('click', () =>
    openTruckerBillModal(truckerBills.find(b => b.id === btn.dataset.id) || null)));
  document.querySelectorAll('.btn-pay-trk').forEach(btn => btn.addEventListener('click', () =>
    openTruckerPayModal(truckerBills.find(b => b.id === btn.dataset.id) || null)));
  document.querySelectorAll('.btn-del-trk').forEach(btn => btn.addEventListener('click', async () => {
    const b = truckerBills.find(x => x.id === btn.dataset.id);
    if (!b) return;
    if (!confirm(`Are you sure you want to delete the ${b.company} bill for ${payMoney(b.amount)}?`)) return;
    // The paid case only ever reaches a Jarvis session — everyone else is not
    // shown the button, and the server returns 409 regardless. Same second
    // prompt as a paid load, for the same reason: this erases the record that
    // money moved.
    const paid = b.payment && Number(b.payment.paid);
    if (paid > 0 && !confirm(
      `${b.company} has ${payMoney(paid)} recorded as paid against this bill.\n\n`
      + `Deleting it removes those payment records too.\n\n`
      + `This is logged against the Jarvis profile. Continue?`)) return;
    try {
      await api(`/api/trucker-bills/${encodeURIComponent(b.id)}`, { method: 'DELETE' });
      await renderTruckerTab();
    } catch (err) {
      // The server's own words. BILL_HAS_PAYMENTS carries a sentence that
      // already explains the way out, so restating it here would only give
      // the operator a second, worse version of the same message.
      alert(err.message);
    }
  }));
}

function openTruckerBillModal(b) {
  editingTruckerBillId = b ? b.id : null;
  $('trkTitle').textContent = b ? `Edit ${b.id}` : 'Add trucker bill';
  $('trk_date').value = toUsDate(b ? (b.date || '') : todayLocalDateStrForExpense());
  wireUsDateField('trk_date');
  $('trk_company').value = b ? (b.company || '') : '';
  $('trk_ticket').value = b ? (b.load_ticket || '') : '';
  $('trk_amount').value = b ? (b.amount ?? '') : '';
  $('trkErr').textContent = '';
  $('truckerModal').classList.remove('hidden');
  $('truckerModal').style.display = 'flex';
}
function closeTruckerBillModal() {
  $('truckerModal').classList.add('hidden');
  $('truckerModal').style.display = '';
  editingTruckerBillId = null;
}

function openTruckerPayModal(b) {
  if (!b) return;
  payingTruckerBill = b;
  const pending = (b.payment && Number(b.payment.pending)) || b.amount;
  $('trkPayTitle').textContent = `Pay ${b.company}`;
  $('trkPaySub').textContent = `${b.id} · ${payMoney(b.amount)} billed · ${payMoney((b.payment && b.payment.paid) || 0)} paid`;
  // Built from the SERVER's list, so the dropdown cannot offer something the
  // server would reject — and the server refuses Cash on this ledger whatever
  // the dropdown says.
  $('trk_pay_mode').innerHTML = truckerModes.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  paintBankOptions($('trk_pay_bank'));
  if ($('trk_pay_bank_other')) $('trk_pay_bank_other').value = '';
  syncBankFields('trk_pay');
  // Pre-filled with what is still outstanding, rounded here rather than left
  // as a float — 1000 - 333.33 - 333.33 is 333.34000000000003, and a Pay box
  // that opens showing that is a Pay box nobody trusts.
  $('trk_pay_amount').value = pending > 0 ? Math.round(pending * 100) / 100 : '';
  $('trk_pay_date').value = toUsDate(todayLocalDateStrForExpense());
  wireUsDateField('trk_pay_date');
  $('trkPayErr').textContent = '';
  $('truckerPayModal').classList.remove('hidden');
  $('truckerPayModal').style.display = 'flex';
}
function closeTruckerPayModal() {
  $('truckerPayModal').classList.add('hidden');
  $('truckerPayModal').style.display = '';
  payingTruckerBill = null;
}

let truckerModalsWired = false;
function wireTruckerModals() {
  // ── LAZY, IDEMPOTENT, AND NULL-SAFE ───────────────────────────────────
  // Called from renderTruckerTab rather than at boot. On the website boot()
  // runs from an inline script partway down the document while these modals
  // are markup at the very END of it, so at boot time the elements do not
  // exist — wiring there threw and took renderNav() and loadTab() down with
  // it, leaving a signed-in page with an empty sidebar and an empty body.
  //
  // Idempotent because it now runs on every visit to the tab, and binding a
  // second listener to the same Save button would record every bill twice.
  //
  // Null-safe because a missing element must never again cost the whole
  // page. If the markup is not there, the tab renders and its buttons do
  // nothing — bad, but visibly bad, and only here.
  if (truckerModalsWired) return;
  const need = ['trkClose', 'trkSave', 'trkPayClose', 'trkPaySave'];
  if (need.some((id) => !$(id))) {
    console.warn('[TRUCKER] modal markup missing — buttons will not respond:',
                 need.filter((id) => !$(id)).join(', '));
    return;
  }
  truckerModalsWired = true;
  $('trkClose').addEventListener('click', closeTruckerBillModal);
  $('trk_pay_mode').addEventListener('change', () => syncBankFields('trk_pay'));
  $('trk_pay_bank').addEventListener('change', () => syncBankFields('trk_pay'));
  $('trkSave').addEventListener('click', async () => {
    const payload = {
      date: toIsoDate($('trk_date').value),
      company: $('trk_company').value.trim(),
      load_ticket: $('trk_ticket').value.trim() || null,
      amount: $('trk_amount').value,
    };
    const btn = $('trkSave');
    btn.disabled = true; btn.textContent = 'Saving…';
    $('trkErr').textContent = '';
    try {
      await (editingTruckerBillId
        ? api(`/api/trucker-bills/${encodeURIComponent(editingTruckerBillId)}`, { method: 'PUT', body: JSON.stringify(payload) })
        : api('/api/trucker-bills', { method: 'POST', body: JSON.stringify(payload) }));
      closeTruckerBillModal();
      await renderTruckerTab();
    } catch (err) {
      $('trkErr').textContent = String(err.message || '').replace(/^Validation:\s*/, '');
    } finally {
      btn.disabled = false; btn.textContent = 'Save bill';
    }
  });

  $('trkPayClose').addEventListener('click', closeTruckerPayModal);
  $('trkPaySave').addEventListener('click', async () => {
    if (!payingTruckerBill) return;
    const btn = $('trkPaySave');
    btn.disabled = true; btn.textContent = 'Recording…';
    $('trkPayErr').textContent = '';
    try {
      await api('/api/payments', {
        method: 'POST',
        body: JSON.stringify({
          load_id: payingTruckerBill.id,
          // The field the whole report split hangs off. Without it the payment
          // is stored as a purchase and the haulage disappears into what the
          // yard paid for metal — see helpers/payments.js.
          load_kind: 'trucker',
          mode: $('trk_pay_mode').value,
          bank: bankValue('trk_pay'),
          amount: $('trk_pay_amount').value,
          paid_on: toIsoDate($('trk_pay_date').value),
        }),
      });
      closeTruckerPayModal();
      await renderTruckerTab();
    } catch (err) {
      $('trkPayErr').textContent = err.message;
    } finally {
      btn.disabled = false; btn.textContent = 'Record payment';
    }
  });
}

// ── Expenses tab (admin only) ────────────────────────────────────────────
// Per Apsara 2026-08-19. Entries here feed the same live-sync machinery the
// loads use (helpers/sheetSync.js), so every add/edit/delete updates the
// "Expenses-Overall" Google Sheet and the current month's per-day workbook
// within seconds — no separate "publish" step.
let expenseCategories = [];
// The server's list of payment methods, fetched with the expenses. Kept in a
// variable rather than hardcoded so the form and the server cannot disagree.
let expenseMethods = [];
// Which one starts selected on a NEW expense. From the server too, for the
// same reason — a hardcoded 'Cash' here would keep pre-selecting Cash long
// after the server stopped offering it.
let expenseDefaultMethod = '';
// Methods the server no longer OFFERS but still ACCEPTS. Needed to tell a real
// retired value apart from legacy free text — see openExpenseModal. Null, not
// [], so "the server did not tell us" is distinguishable from "there are
// none": an older server sends neither, and there the old behaviour is kept.
let expenseRetiredMethods = null;
let editingExpenseId = null;

function todayLocalDateStrForExpense() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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
let spendFrom = '';
let spendTo = '';
// '' means every method. Held here so it survives a repaint, like the date
// range — a filter that resets itself when you tap Apply is worse than none.
let spendMethod = '';
// '' means every bank. Same reasoning as spendMethod: a filter that resets on
// repaint is worse than no filter.
let spendBank = '';

// ── THE REPORT TAB IS A MENU ───────────────────────────────────────────────
// Apsara, 2026-09-16: "There should be multiple reports in yard app na?" —
// and she was right. Report was ONE view, the spend report, while the server
// had been producing a sales report the phone never showed and the website
// had for weeks.
//
// Asked what the tab should become, she chose a menu over one long page. That
// is also the right call on a phone: a stacked page loads every report to
// answer one question, and the tab bar is already seven items wide, so a new
// report cannot be a new tab.
//
// The four are the ones she said she actually opens. Adding a fifth is one
// entry in this array and one render function — deliberately, because "there
// should be more reports" is a sentence that gets said again.
let reportView = null;   // null = the menu; otherwise the id being shown

const YARD_REPORTS = [
  { id: 'sales',  title: 'Sales',        blurb: 'Who you sold to, weight and amount — with margin where the material is linked to what it cost.' },
  { id: 'stock',  title: 'Stock on hand', blurb: 'What is left in the yard by item type, after everything shipped out.' },
  { id: 'spend',  title: 'Spend',        blurb: 'Money out, by month, method and bank.' },
  { id: 'profit', title: 'Profit',       blurb: 'Bought against sold, and the margin on what actually left.' },
];

async function renderReportsMenu() {
  if (reportView) {
    const hit = YARD_REPORTS.find((r) => r.id === reportView);
    if (hit) return renderOneReport(hit);
    reportView = null;   // an id that no longer exists must not strand her
  }
  $('viewRoot').innerHTML = `
    <section style="max-width:600px; margin:0 auto; padding:20px 16px 60px;">
      <div style="font-family:var(--font-mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--text-muted); margin-bottom:6px;">Reports</div>
      <div style="font-size:12.5px; color:var(--text-muted); margin-bottom:16px; line-height:1.55;">Edge Yard only — Edge Metals keeps its own books.</div>
      ${YARD_REPORTS.map((r) => `
        <button type="button" class="rep-open" data-rep="${esc(r.id)}"
          style="display:block; width:100%; text-align:left; background:var(--surface-card); border:1px solid var(--border-subtle); border-radius:var(--radius-sm); padding:14px 16px; margin-bottom:10px;">
          <div style="font-size:15px; font-weight:700; color:var(--text-strong);">${esc(r.title)}</div>
          <div style="font-size:12.5px; color:var(--text-muted); margin-top:3px; line-height:1.5;">${esc(r.blurb)}</div>
        </button>`).join('')}
    </section>`;
  $('viewRoot').querySelectorAll('.rep-open').forEach((b) => b.addEventListener('click', () => {
    reportView = b.dataset.rep;
    renderReportsMenu();
  }));
}

async function renderOneReport(rep) {
  // Painted before the fetch so a slow report shows its own title and a way
  // back, rather than a blank screen she cannot leave.
  $('viewRoot').innerHTML = `
    <section style="max-width:600px; margin:0 auto; padding:16px 16px 60px;">
      <button type="button" id="repBack" class="btn" style="font-size:12px; padding:6px 12px; margin-bottom:12px;">&larr; Reports</button>
      <div style="font-size:17px; font-weight:700; color:var(--text-strong); margin-bottom:12px;">${esc(rep.title)}</div>
      <div id="repBody" style="font-size:13px; color:var(--text-muted);">Loading…</div>
    </section>`;
  $('repBack').addEventListener('click', () => { reportView = null; renderReportsMenu(); });
  try {
    // Spend is the one report that predates this menu, and it owns the whole
    // view — filters, method columns, bank columns, all tested. It is left
    // exactly as it was and simply given a way back, rather than being
    // rewritten to paint into a div: re-plumbing a working money report to
    // fit a new menu is how a working money report stops working.
    if (rep.id === 'spend') {
      await renderSpendReportTab();
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'btn';
      back.style.cssText = 'font-size:12px; padding:6px 12px; margin:16px 0 0 16px;';
      back.textContent = '← Reports';
      back.addEventListener('click', () => { reportView = null; renderReportsMenu(); });
      $('viewRoot').insertBefore(back, $('viewRoot').firstChild);
      return;
    }
    if (rep.id === 'sales')  return await renderSalesReportInto('repBody');
    if (rep.id === 'stock')  return await renderStockReportInto('repBody');
    if (rep.id === 'profit') return await renderProfitReportInto('repBody');
  } catch (e) {
    $('repBody').innerHTML = `<div style="color:var(--status-danger);">${esc(e.message)}</div>`;
  }
}

const repMoney = (n) => (n === null || n === undefined ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const repNum = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));

// ── SALES — the one the phone never had ────────────────────────────────────
async function renderSalesReportInto(id) {
  const data = await api('/api/outbound-loads/report');
  const rows = data.byBuyer || [];
  $(id).innerHTML = `
    <div style="display:flex; gap:18px; margin-bottom:14px;">
      <div><div style="font-size:20px; font-weight:700; color:var(--text-strong);">${repMoney(data.totalAmount)}</div><div style="font-size:11px; color:var(--text-muted);">sold</div></div>
      <div><div style="font-size:20px; font-weight:700; color:var(--text-strong);">${data.totalMargin === null ? '—' : repMoney(data.totalMargin)}</div><div style="font-size:11px; color:var(--text-muted);">margin</div></div>
    </div>
    ${data.totalMargin === null ? `<div style="font-size:11.5px; color:var(--status-warning, #d69e2e); margin-bottom:12px; line-height:1.5;">No sale is linked to the loads it came from, so there is no cost to measure against.</div>` : ''}
    ${rows.length ? rows.map((b) => `
      <div style="border-top:1px solid var(--border-subtle); padding:9px 0;">
        <div style="display:flex; justify-content:space-between; gap:10px;">
          <span style="color:var(--text-strong); font-weight:700;">${esc(b.buyer)}</span>
          <span style="font-family:var(--font-mono);">${repMoney(b.amount)}</span>
        </div>
        <div style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">
          ${repNum(b.net)} ${esc(data.unit || 'lb')} · ${b.loadCount} load${b.loadCount === 1 ? '' : 's'}${
            b.margin === null ? ' · cost not linked' : ` · margin ${repMoney(b.margin)}`}
        </div>
      </div>`).join('') : '<div>Nothing sold yet.</div>'}`;
}

// ── STOCK ON HAND ──────────────────────────────────────────────────────────
async function renderStockReportInto(id) {
  // No date range: on hand is a point in time, and "bought this week minus
  // shipped ever" is not a number that means anything. The Inventory tab says
  // the same thing when a filter is set.
  const data = await api('/api/loads/inventory');
  const rows = (data.byType || []).filter((g) => (g.onHand === undefined ? g.net : g.onHand) !== 0);
  const oh = data.onHandAvailable;
  $(id).innerHTML = `
    ${oh ? '' : '<div style="font-size:11.5px; color:var(--status-warning, #d69e2e); margin-bottom:10px;">On-hand could not be worked out, so this shows what came IN.</div>'}
    ${rows.length ? rows.map((g) => `
      <div style="display:flex; justify-content:space-between; gap:10px; border-top:1px solid var(--border-subtle); padding:9px 0;">
        <div style="min-width:0;">
          <div style="color:var(--text-strong);">${esc(g.description)}</div>
          <div style="font-size:11.5px; color:var(--text-muted);">${repNum(g.net)} in${oh ? ` · ${repNum(g.shipped || 0)} out` : ''}</div>
        </div>
        <span style="font-family:var(--font-mono); font-weight:700; color:${oh && g.onHand < 0 ? 'var(--status-danger)' : 'var(--text-strong)'};">
          ${repNum(oh ? g.onHand : g.net)} ${esc(data.unit || 'lb')}${oh && g.onHand < 0 ? ' ⚠' : ''}
        </span>
      </div>`).join('') : '<div>Nothing on hand.</div>'}`;
}

// ── PROFIT ─────────────────────────────────────────────────────────────────
async function renderProfitReportInto(id) {
  const d = await api('/api/reports/yard-profit');
  const m = d.margin || {}, c = d.cash || {};
  $(id).innerHTML = `
    <div style="font-size:11px; letter-spacing:.1em; color:var(--text-muted); margin-bottom:6px;">MARGIN ON WHAT WAS SOLD</div>
    <div style="display:flex; gap:18px; margin-bottom:6px;">
      <div><div style="font-size:20px; font-weight:700; color:var(--text-strong);">${repMoney(m.revenue)}</div><div style="font-size:11px; color:var(--text-muted);">revenue</div></div>
      <div><div style="font-size:20px; font-weight:700; color:var(--text-strong);">${repMoney(m.cost_of_material_sold)}</div><div style="font-size:11px; color:var(--text-muted);">cost</div></div>
      <div><div style="font-size:20px; font-weight:700; color:${(m.margin || 0) < 0 ? 'var(--status-danger)' : 'var(--text-strong)'};">${repMoney(m.margin)}</div><div style="font-size:11px; color:var(--text-muted);">margin</div></div>
    </div>
    ${m.caveat ? `<div style="font-size:11.5px; color:var(--status-warning, #d69e2e); margin-bottom:14px; line-height:1.5;">${esc(m.caveat)}</div>` : '<div style="margin-bottom:14px;"></div>'}

    <div style="font-size:11px; letter-spacing:.1em; color:var(--text-muted); margin-bottom:6px;">MONEY IN AND OUT — NOT PROFIT</div>
    <div style="font-family:var(--font-mono); font-size:12.5px; line-height:1.9; color:var(--text-muted);">
      bought ${repMoney(c.bought)}<br>
      sold ${repMoney(c.sold)}<br>
      expenses ${repMoney(c.expenses)}<br>
      trucking ${repMoney(c.trucking)}<br>
      <strong style="color:var(--text-strong);">net ${repMoney(c.net)}</strong>
    </div>
    <div style="font-size:11.5px; color:var(--text-muted); margin-top:8px; line-height:1.5;">${esc(c.note || '')}</div>
    ${(d.partial || []).length ? `<div style="font-size:11.5px; color:var(--status-danger); margin-top:8px;">Could not read: ${esc((d.partial || []).join(', '))}.</div>` : ''}`;
}

async function renderSpendReportTab() {
  const qs = [];
  if (spendFrom) qs.push('from=' + encodeURIComponent(spendFrom));
  if (spendTo) qs.push('to=' + encodeURIComponent(spendTo));
  if (spendMethod) qs.push('method=' + encodeURIComponent(spendMethod));
  if (spendBank) qs.push('bank=' + encodeURIComponent(spendBank));
  let rep;
  try {
    rep = await api('/api/reports/spend' + (qs.length ? '?' + qs.join('&') : ''));
  } catch (e) {
    $('viewRoot').innerHTML = `<section style="max-width:1000px; margin:0 auto; padding:40px 20px;"><div class="card" style="padding:24px; color:var(--status-danger);">Could not load the report: ${esc(e.message || '')}</div></section>`;
    return;
  }

  // ── one method selected means ONE column ────────────────────────────────
  // Apsara, 2026-09-02: "when i choose zelle, only zelle amount should come
  // not everything."
  //
  // The server already zeroes the other methods, but the table was still
  // drawing all seven columns — six of them full of dashes. Technically
  // filtered, and it reads as "everything is still here". Narrowing the
  // columns is what makes the filter visible rather than merely true.
  //
  // The Total column stays: with one method it equals that method, and it is
  // what the month rows are checked against.
  const cols = rep.method ? [rep.method] : (rep.columns || []);
  const money = (n) => fmtAmount(Number(n) || 0) || '$0.00';
  // Zero renders as a dash, not $0.00 — a page of $0.00 is hard to read past,
  // and "nothing by Wire in August" is what the dash says.
  const cell = (n) => (Math.abs(Number(n) || 0) < 0.005 ? '<span style="color:var(--text-faint);">—</span>' : esc(money(n)));

  // Preset ranges, because "this month" is the question actually asked and
  // typing two dates to ask it is friction. QuickBooks does the same.
  const presets = [
    ['This month', () => { const d = new Date(); const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; return [m + '-01', m + '-31']; }],
    ['Last month', () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; return [m + '-01', m + '-31']; }],
    ['This year',  () => { const y = new Date().getFullYear(); return [`${y}-01-01`, `${y}-12-31`]; }],
    ['All time',   () => ['', '']],
  ];

  $('viewRoot').innerHTML = `
    <section style="max-width:1080px; margin:0 auto; padding:28px 20px 80px;">
      <div style="margin-bottom:18px;">
        <div class="eyebrow">// Reports</div>
        <h2 style="font-size:24px; text-transform:uppercase; margin-bottom:4px;">Where the money went</h2>
        <div style="font-size:13px; color:var(--text-muted);">${spendMethod
          ? `Showing <strong style="color:var(--text-strong);">${esc(spendMethod)}</strong> only — every figure below is ${esc(spendMethod)}.`
          : 'Money OUT — what you paid sellers and spent on expenses, by month and by how it was paid. Sales income is shown separately.'}</div>
      </div>

      <!-- ── the filter bar ───────────────────────────────────────────────
           Apsara, 2026-09-02: "report layout is not proper. apply this month
           coming in one libe why?" — From, To, Apply and four preset buttons
           were all one flex row with a flex:1 spacer between them. On a phone
           that spacer eats the line and the presets get pushed into a cramped
           strip beside Apply.
           Three stacked rows now, each with a job: the range, then the
           presets, then the method. Every row wraps on its own. -->
      <div class="card" style="padding:14px 16px; margin-bottom:18px;">
        <div style="display:flex; gap:10px; align-items:flex-end; flex-wrap:wrap;">
          <div class="field" style="margin-bottom:0; flex:1 1 130px; min-width:130px;"><label>From</label><input id="spend_from" placeholder="MM/DD/YYYY" autocomplete="off" value="${esc(typeof toUsDate === 'function' ? toUsDate(spendFrom) : spendFrom)}"></div>
          <div class="field" style="margin-bottom:0; flex:1 1 130px; min-width:130px;"><label>To</label><input id="spend_to" placeholder="MM/DD/YYYY" autocomplete="off" value="${esc(typeof toUsDate === 'function' ? toUsDate(spendTo) : spendTo)}"></div>
          <button id="btnSpendApply" class="btn btn-primary" style="padding:10px 18px;">Apply</button>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px;">
          ${presets.map((p, i) => `<button class="btn btn-spend-preset" data-i="${i}" style="font-size:11.5px; padding:7px 12px;">${esc(p[0])}</button>`).join('')}
        </div>
        <!-- ── one method at a time ──────────────────────────────────────
             Apsara, 2026-09-02: "in reports what if i want to see report
             wherever just zelle is used/wire/just cash. mimic quickbook
             report workflow."
             QuickBooks narrows a report by a column and every figure follows
             — not just the rows. So picking a method here re-runs the whole
             report against it: the totals, the month rows and the cash
             reconciliation all mean "of this method", never "of everything,
             with some rows hidden". -->
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; padding-top:12px; border-top:1px solid var(--border-subtle);">
          <span style="font-family:var(--font-mono); font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--text-muted); align-self:center; margin-right:2px;">Paid by</span>
          ${['', ...(rep.columns || [])].map(m => `
            <button class="btn btn-spend-method" data-method="${esc(m)}" style="font-size:11.5px; padding:7px 12px; ${spendMethod === m ? 'background:var(--accent); color:#0C0E10; font-weight:700;' : ''}">${esc(m || 'All')}</button>`).join('')}
        </div>
        <!-- ── AND OUT OF WHICH ACCOUNT ──────────────────────────────────
             Apsara, 2026-09-09. Narrows the whole report the same way the
             method does. Only rendered when there is more than one bank to
             choose between: a single-bank row of chips is a control that
             cannot change anything.

             "Not recorded" is offered as a filter on purpose — it is how she
             finds the Zelles from before the bank field existed, which is the
             only way that gap ever gets closed. -->
        ${(rep.bankColumns || []).length > 1 ? `
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
          <span style="font-family:var(--font-mono); font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--text-muted); align-self:center; margin-right:2px;">Out of</span>
          ${['', ...(rep.bankColumns || [])].map(b => `
            <button class="btn btn-spend-bank" data-bank="${esc(b)}" style="font-size:11.5px; padding:7px 12px; ${spendBank === b ? 'background:var(--accent); color:#0C0E10; font-weight:700;' : ''}">${esc(b || 'All')}</button>`).join('')}
        </div>` : ''}
      </div>

      <!-- ── WHAT LEFT EACH ACCOUNT ──────────────────────────────────────
           Apsara, 2026-09-09. Sits beside the totals rather than replacing
           the method table: the method answers "how", the bank answers "from
           where", and she reconciles against a statement using the second.

           These add up to Total out exactly, INCLUDING "Not recorded" — a
           breakdown that quietly omits the rows it has no bank for would
           disagree with the total and invite her to pick which number to
           believe. -->
      ${Object.keys(rep.byBank || {}).length ? `
      <div class="card" style="padding:16px 18px; margin-bottom:18px;">
        <div style="font-family:var(--font-mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--text-muted); margin-bottom:10px;">Out of each account</div>
        <div style="display:flex; gap:26px; flex-wrap:wrap;">
          ${Object.keys(rep.byBank).sort((a, b) => (rep.byBank[b] || 0) - (rep.byBank[a] || 0)).map(b => `
            <div>
              <div style="font-family:var(--font-mono); font-size:11px; color:var(--text-muted);">${esc(b)}</div>
              <div style="font-size:20px; font-weight:800; color:var(--text-strong);">${esc(money(rep.byBank[b]))}</div>
            </div>`).join('')}
        </div>
      </div>` : ''}

      <!-- Whose money. Apsara, 2026-09-17 — mirrors dashboard/index.html;
           adds up to Total out exactly, including "Not recorded". -->
      ${Object.keys(rep.byPaidVia || {}).length ? `
      <div class="card" style="padding:16px 18px; margin-bottom:18px;">
        <div style="font-family:var(--font-mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--text-muted); margin-bottom:10px;">Paid via</div>
        <div style="display:flex; gap:26px; flex-wrap:wrap;">
          ${Object.keys(rep.byPaidVia).sort((a, b) => (rep.byPaidVia[b] || 0) - (rep.byPaidVia[a] || 0)).map(v => `
            <div>
              <div style="font-family:var(--font-mono); font-size:11px; color:var(--text-muted);">${esc(v)}</div>
              <div style="font-size:20px; font-weight:800; color:var(--text-strong);">${esc(money(rep.byPaidVia[v]))}</div>
            </div>`).join('')}
        </div>
      </div>` : ''}

      <div class="card" style="padding:16px 18px; margin-bottom:18px; display:flex; gap:26px; flex-wrap:wrap;">
        <div><div style="font-family:var(--font-mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--text-muted);">Total out</div><div style="font-size:22px; font-weight:800; color:var(--text-strong);">${esc(money(rep.total))}</div></div>
        <div><div style="font-family:var(--font-mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--text-muted);">Loads</div><div style="font-size:22px; font-weight:800; color:var(--text-strong);">${esc(money(rep.loadTotal))}</div></div>
        <div><div style="font-family:var(--font-mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--text-muted);">Expenses</div><div style="font-size:22px; font-weight:800; color:var(--text-strong);">${esc(money(rep.expenseTotal))}</div></div>
        <div><div style="font-family:var(--font-mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--text-muted);">Entries</div><div style="font-size:22px; font-weight:800; color:var(--text-strong);">${esc(rep.count)}</div></div>
      </div>

      <!-- ── money IN, kept apart from money out ──────────────────────────
           A payment against a SALE is a buyer paying US. Until 2026-09-02
           this report added those to "where the money went", so on any yard
           recording sales every total was inflated by its own income —
           Apsara: "check the reports behaviour. i dont think this is
           correct." She was right.
           Shown here rather than dropped: discarding rows is its own way of
           being wrong, and "paid out X, took in Y" is two facts. -->
      ${rep.received && rep.received.count ? `
      <div class="card" style="padding:16px 18px; margin-bottom:18px; display:flex; gap:26px; flex-wrap:wrap; align-items:center;">
        <div>
          <div style="font-family:var(--font-mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--text-muted);">Received from buyers</div>
          <div style="font-size:22px; font-weight:800; color:var(--leaf-600, #2e7d32);">${esc(money(rep.received.total))}</div>
        </div>
        <div style="font-size:12.5px; color:var(--text-muted); flex:1; min-width:180px;">
          ${esc(rep.received.count)} sale payment${rep.received.count === 1 ? '' : 's'} in this period — <strong>not</strong> counted in the figures above, which are money out only.
        </div>
      </div>` : ''}

      <!-- The cash box, reconciled over the same window — her "money out, plus
           cash in". Opened with X, took in Y, paid out Z, so it should hold W;
           that last figure is what gets counted against the drawer. -->
      <div class="card" style="padding:16px 18px; margin-bottom:18px;">
        <div style="font-family:var(--font-mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--text-muted); margin-bottom:10px;">Petty cash over this period</div>
        <div style="display:flex; gap:26px; flex-wrap:wrap; font-family:var(--font-mono); font-size:13px;">
          <div>Opened <strong>${esc(money(rep.cash.opening))}</strong></div>
          <div style="color:var(--leaf-600, #2e7d32);">Cash in <strong>+${esc(money(rep.cash.in))}</strong></div>
          <div style="color:var(--status-danger, #c53030);">Cash out <strong>-${esc(money(rep.cash.out))}</strong></div>
          <div>Should hold <strong style="color:${Number(rep.cash.closing) < 0 ? 'var(--status-danger, #c53030)' : 'var(--text-strong)'};">${esc(money(rep.cash.closing))}</strong></div>
        </div>
        ${Number(rep.cash.closing) < 0 ? `<div style="margin-top:9px; font-size:12.5px; color:var(--status-warning, #d69e2e);">Negative — cash left the drawer that was never entered on the Petty cash tab.</div>` : ''}
      </div>

      ${(rep.months || []).length ? `
      <div class="card" style="padding:0; overflow-x:auto; margin-bottom:18px;">
        <table id="spendReportTable" class="stack-table" style="width:100%; border-collapse:collapse; font-size:13px; min-width:600px;">
          <thead><tr style="background:var(--surface-sunken); text-align:right;">
            <th style="padding:10px 12px; text-align:left; font-family:var(--font-mono); font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted);">Month</th>
            ${cols.map(c => `<th style="padding:10px 12px; font-family:var(--font-mono); font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted);">${esc(c)}</th>`).join('')}
            <th style="padding:10px 12px; font-family:var(--font-mono); font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-strong);">Total</th>
          </tr></thead>
          <tbody>
            ${rep.months.map(m => `
            <tr style="border-top:1px solid var(--border-subtle); text-align:right;">
              <td class="st-head" style="padding:10px 12px; text-align:left; font-family:var(--font-mono); color:var(--text-strong);">${esc(m.month)}</td>
              ${cols.map(c => `<td data-label="${esc(c)}" style="padding:10px 12px; font-family:var(--font-mono);">${cell(m[c])}</td>`).join('')}
              <td data-label="Total" style="padding:10px 12px; font-family:var(--font-mono); font-weight:700; color:var(--text-strong);">${esc(money(m.total))}</td>
            </tr>`).join('')}
            <tr class="st-total" style="border-top:2px solid var(--border-default); text-align:right; background:var(--surface-sunken);">
              <td class="st-head" style="padding:10px 12px; text-align:left; font-family:var(--font-mono); font-weight:700;">All months</td>
              ${cols.map(c => `<td data-label="${esc(c)}" style="padding:10px 12px; font-family:var(--font-mono); font-weight:700;">${cell(rep.byMethod[c])}</td>`).join('')}
              <td data-label="Total" style="padding:10px 12px; font-family:var(--font-mono); font-weight:800; color:var(--text-strong);">${esc(money(rep.total))}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <details>
        <summary style="cursor:pointer; font-family:var(--font-mono); font-size:11.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted); padding:8px 0;">Every entry behind these figures (${esc(rep.rows.length)})</summary>
        <div class="card" style="padding:0; overflow:hidden; margin-top:10px;">
          <table class="stack-table" style="width:100%; border-collapse:collapse; font-size:12.5px;">
            <tbody>
              ${rep.rows.map(r => `
              <tr style="border-top:1px solid var(--border-subtle);">
                <td class="st-head" style="padding:8px 12px;"><span style="font-family:var(--font-mono); font-size:10.5px; color:var(--text-faint);">${esc(r.kind === 'load' ? 'LOAD' : 'EXP')}</span> ${esc(r.label)}</td>
                <td data-label="Date" style="padding:8px 12px; font-family:var(--font-mono); color:var(--text-muted); white-space:nowrap;">${esc(typeof fmtDate === 'function' ? fmtDate(r.date) : r.date)}</td>
                <td data-label="Paid by" style="padding:8px 12px; font-family:var(--font-mono); color:var(--text-muted);">${esc(r.method)}</td>
                <td data-label="Amount" style="padding:8px 12px; text-align:right; font-family:var(--font-mono); font-weight:700;">${esc(money(r.amount))}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </details>`
      : `<div style="padding:60px; text-align:center; color:var(--text-faint); font-family:var(--font-mono); font-size:12px;">Nothing was paid out in this period.</div>`}
    </section>`;

  // Dates are typed as MM/DD/YYYY and sent as ISO — the same split the rest of
  // the app uses: what a person reads, versus what goes over the wire.
  if (typeof wireUsDateField === 'function') { wireUsDateField('spend_from'); wireUsDateField('spend_to'); }
  $('btnSpendApply').addEventListener('click', () => {
    const iso = (v) => (typeof toIsoDate === 'function' ? toIsoDate(v) : v);
    spendFrom = iso($('spend_from').value) || '';
    spendTo = iso($('spend_to').value) || '';
    renderSpendReportTab();
  });
  document.querySelectorAll('.btn-spend-preset').forEach(b => b.addEventListener('click', () => {
    const [f, t] = presets[Number(b.dataset.i)][1]();
    spendFrom = f; spendTo = t;
    renderSpendReportTab();
  }));
  // One method at a time. Re-runs the whole report rather than hiding rows —
  // see helpers/spendReport.js for why every figure has to follow the filter.
  document.querySelectorAll('.btn-spend-method').forEach(b => b.addEventListener('click', () => {
    spendMethod = b.dataset.method || '';
    renderSpendReportTab();
  }));
  document.querySelectorAll('.btn-spend-bank').forEach(b => b.addEventListener('click', () => {
    spendBank = b.dataset.bank || '';
    renderSpendReportTab();
  }));
}

