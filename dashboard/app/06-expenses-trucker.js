// dashboard/app/06-expenses-trucker.js — split from dashboard/index.html's <script> (helpers/sourceParts.js reconstructs the original)
let spendFrom = '';
let spendTo = '';
// Apsara 2026-11-07: "TWO FILTERS,WHOM WE BUY,WHOM WE SELL". Two, because
// they narrow opposite directions of money — see helpers/spendReport.js.
let spendBought = '';
let spendSold = '';
// ── DEFAULTS TO EDGE YARD ────────────────────────────────────────────────
// Apsara, 2026-11-07: this screen "should be the one stop thing for the edge
// yard", and asked whether the default should change her headline figure she
// chose Edge Yard knowing it would.
//
// It does change it. The old total added Edge Yard and Edge Metals together
// — loads, expenses and trucker bills on one side, supplier payments, sale
// costs and metals haulage on the other — so the figure she has been reading
// was two companies in one number. Scoped to the yard it DROPS, and that
// drop is the fix, not a regression.
//
// The engine defaults to every company; only this screen defaults to the
// yard. So the voice path and every other caller are untouched.
let spendCompany = 'edge-trading';
// '' means every method. Held here so it survives a repaint, like the date
// range — a filter that resets itself when you tap Apply is worse than none.
let spendMethod = '';
// '' means every bank. Same reasoning as spendMethod: a filter that resets on
// repaint is worse than no filter.
let spendBank = '';
// '' means every company. Apsara, 2026-09-17 — same reasoning as spendBank:
// a filter that resets on every render is a filter she has to re-apply after
// every date change.
let spendPaidVia = '';

// ── EXPENSES ────────────────────────────────────────────────────────────
// Apsara, 2026-09-15: "there is a expense tab in app but not website", and
// when asked how far to take it: the full tab, same as the app.
//
// A DELIBERATE SECOND COPY, and worth naming as such. This is the same screen
// as mobile-app/www/index.html's, and two copies of one screen is how the
// Load form has drifted twice already. tests/form-parity.js now guards this
// pair the way it guards that one — the categories, the methods, the retired
// -method rule and the petty-cash warning are asserted on BOTH files, so a
// change to one that is not made to the other fails rather than ships.
//
// Everything here comes from the SERVER: categories, payment methods, the
// default method and the retired list. Hardcoding any of them would let the
// form offer something the server rejects, which is an option that silently
// does not take.
let expenseCategories = [];
let expenseMethods = [];
let expenseDefaultMethod = '';
// Null, not [], so "the server did not tell us" stays distinguishable from
// "there are none" — an older server sends neither and the old behaviour is
// kept. See openExpenseModal.
let expenseRetiredMethods = null;
let editingExpenseId = null;

async function renderExpensesTab() {
  const data = await api('/api/expenses');
  expenseCategories = data.categories || [];
  expenseMethods = data.methods || [];
  expenseDefaultMethod = data.default_method || '';
  expenseRetiredMethods = Array.isArray(data.retired_methods) ? data.retired_methods : null;
  const expenses = data.expenses || [];
  const report = data.report || { total: 0, count: 0, byCategory: [], byDay: [] };
  const today = todayYardDateStr();
  const todayTotal = ((report.byDay || []).find((d) => d.date === today) || {}).amount || 0;

  // Grouped by date, newest first — the Loads deck groups the same way, so
  // both tabs read alike.
  const byDate = new Map();
  for (const e of expenses) {
    const k = e.date || 'No date';
    if (!byDate.has(k)) byDate.set(k, []);
    byDate.get(k).push(e);
  }
  const dates = Array.from(byDate.keys()).sort((a, b) => (a < b ? 1 : -1));
  const m = (n) => `$${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  $('viewRoot').innerHTML = `
    <section style="max-width:1000px; margin:0 auto; padding:28px 20px 80px;">
      ${pageHead('Expenses', {
        note: 'Admin only. Syncs to the Expenses Google Sheet automatically.',
        // The summary CARD is gone with the heading it sat under: those three
        // figures are the heading now, larger than they were.
        stats: [['all-time', esc(m(report.total))], ['today', esc(m(todayTotal))], ['entries', esc(report.count)]],
        chips: ['admin only', 'syncs to sheet'],
        actions: '<button id="btnAddExpense" class="btn btn-primary">+ Add expense</button>',
      })}
      ${dates.length ? dates.map((date) => {
        const rows = byDate.get(date);
        const dayTotal = rows.reduce((t, e) => t + (e.amount || 0), 0);
        return `
        <div style="margin-bottom:20px;">
          <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px;">
            <div style="font-family:var(--font-mono); font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--text-muted);">${esc(date)}</div>
            <div style="font-family:var(--font-mono); font-size:12px; color:var(--text-strong); font-weight:700;">${esc(m(dayTotal))}</div>
          </div>
          ${rows.map((e) => `
            <div class="card" style="padding:12px 14px; margin-bottom:8px;">
              <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
                <div style="min-width:0;">
                  <div style="font-size:13.5px; font-weight:700; color:var(--text-strong);">${esc(e.description || '')}</div>
                  <div style="font-family:var(--font-mono); font-size:10.5px; color:var(--text-muted); margin-top:3px;">${esc(e.id)} · ${esc(e.category || 'Other')}${e.vendor ? ' · ' + esc(e.vendor) : ''}${e.payment_method ? ' · ' + esc(e.payment_method) : ''}</div>
                </div>
                <div style="font-size:15px; font-weight:800; color:var(--text-strong); white-space:nowrap;">${esc(m(e.amount))}</div>
              </div>
              <div style="margin-top:10px; display:flex; gap:8px; border-top:1px solid var(--border-subtle); padding-top:9px;">
                <button class="btn btn-edit-expense" data-id="${esc(e.id)}" style="font-size:11px; padding:5px 10px;">Edit</button>
                <button class="btn btn-danger btn-delete-expense" data-id="${esc(e.id)}" style="font-size:11px; padding:5px 10px;">Delete</button>
              </div>
            </div>`).join('')}
        </div>`;
      }).join('') : '<div style="padding:50px; text-align:center; color:var(--text-faint); font-family:var(--font-mono); font-size:12.5px;">No expenses recorded yet.</div>'}
    </section>`;

  $('btnAddExpense').addEventListener('click', () => openExpenseModal(null));
  document.querySelectorAll('.btn-edit-expense').forEach((b) => b.addEventListener('click', () => {
    openExpenseModal(expenses.find((x) => x.id === b.dataset.id) || null);
  }));
  document.querySelectorAll('.btn-delete-expense').forEach((b) => b.addEventListener('click', async () => {
    if (!await askYesNo(`Delete expense ${b.dataset.id}?`)) return;
    b.disabled = true; b.textContent = 'Deleting…';
    try { await api(`/api/expenses/${encodeURIComponent(b.dataset.id)}`, { method: 'DELETE' }); await renderExpensesTab(); }
    catch (err) { alert('Delete failed: ' + err.message); b.disabled = false; b.textContent = 'Delete'; }
  }));
}

// ── BUILT ON DEMAND, APPENDED TO BODY ────────────────────────────────────
// NOT static markup, and the first attempt at this was: the modal was placed
// beside #payModal, which LOOKS like page markup and is not — it lives inside
// renderLoads's `$('viewRoot').innerHTML = ...` template. So it exists only
// while the Loads tab is on screen, and every id in it was null the moment
// the Expenses tab rendered. jsdom caught it; "syntax ok" never would.
//
// This follows openLedgerForm and the receipt modal instead: build it, append
// it, wire it, remove it on close. Nothing to keep in the page, and no
// listeners stacking up across visits.
function expenseModalHtml() {
  return `
    <div id="expenseModal" class="modal-overlay" style="align-items:center; display:flex;">
      <div class="modal-shell" style="max-width:480px;">
        <div class="modal-stripe"></div>
        <div class="modal-head">
          <div id="expTitle" style="font-weight:700; text-transform:uppercase; font-size:14px;">Add expense</div>
          <button id="expClose" class="btn" style="padding:4px 10px;">&#10005;</button>
        </div>
        <div class="modal-body">
          <div class="ld-grid-2">
            <div class="field"><label>Date</label><input id="exp_date" placeholder="MM/DD/YYYY" autocomplete="off"></div>
            <div class="field"><label>Amount ($)</label><input id="exp_amount" type="number" step="any" inputmode="decimal" placeholder="0.00"></div>
          </div>
          <div class="field" style="margin-top:14px;"><label>Category</label><select id="exp_category"></select></div>
          <div class="field" style="margin-top:14px;"><label>Description</label><input id="exp_description" placeholder="e.g. Diesel for the loader"></div>
          <div class="ld-grid-2" style="margin-top:14px;">
            <div class="field"><label>Vendor (optional)</label><input id="exp_vendor" placeholder="e.g. Shell"></div>
            <!-- A fixed list since 2026-09-02, not free text. The spend report
                 groups by this, and "cash", "Cash" and "cash app" are three
                 different strings — any grouping of them would be a guess
                 about money. Choosing Cash also draws the amount out of petty
                 cash. -->
            <div class="field"><label>Paid by</label><select id="exp_payment"></select></div>
          </div>
          <div id="expVendorAsk" style="display:none; margin-top:10px; font-size:12px;"></div>
          <div id="expErr" style="margin-top:10px; font-family:var(--font-mono); font-size:11.5px; color:var(--status-danger);"></div>
        </div>
        <div class="modal-foot">
          <button id="expSave" class="btn btn-primary">Save expense</button>
        </div>
      </div>
    </div>`;
}

function openExpenseModal(expense) {
  const old = $('expenseModal');
  if (old) old.remove();
  document.body.insertAdjacentHTML('beforeend', expenseModalHtml());
  wireExpenseModal();
  wireVendorSuggest();
  editingExpenseId = expense ? expense.id : null;
  $('expTitle').textContent = expense ? `Edit ${expense.id}` : 'Add expense';
  $('exp_date').value = toUsDate(expense ? (expense.date || '') : todayYardDateStr());
  wireUsDateField('exp_date');
  $('exp_category').innerHTML = expenseCategories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if (expense && expense.category) {
    // A category typed before this list existed, or edited on the sheet, must
    // not silently switch to something else because it is not in the current
    // picker — added as an option so the value round-trips.
    if (!expenseCategories.includes(expense.category)) {
      $('exp_category').insertAdjacentHTML('afterbegin', `<option value="${esc(expense.category)}">${esc(expense.category)}</option>`);
    }
    $('exp_category').value = expense.category;
  }
  $('exp_description').value = expense ? (expense.description || '') : '';
  $('exp_vendor').value = expense ? (expense.vendor || '') : '';

  // ── RETIRED METHODS ARE KEPT, NEVER OFFERED ──────────────────────────
  // Cheque and Other were removed 2026-09-02, Zelle and Wire 2026-09-03.
  // They are RETIRED, not forbidden: an expense already recorded with one
  // keeps it as an option so editing the description cannot silently erase
  // how it was paid. Only a value the server would still ACCEPT is offered
  // back — legacy free text ("cash app") matches nothing and shows as blank,
  // which is her rule: "leave old entries blank".
  //
  // expenseRetiredMethods === null means the server never sent the list (a
  // client pointed at a VM that has not been updated). The old, wider
  // behaviour is kept there on purpose: the narrower rule needs the server's
  // list to be safe, and without it, treating every stored value as unknown
  // would blank a real method and erase it on save.
  const sel = $('exp_payment');
  const acceptable = expenseRetiredMethods
    ? (expenseMethods || []).concat(expenseRetiredMethods)
    : null;
  const retired = expense && expense.payment_method
    && !(expenseMethods || []).includes(expense.payment_method)
    && (!acceptable || acceptable.includes(expense.payment_method))
    ? expense.payment_method : null;
  sel.innerHTML = ['<option value="">— not recorded —</option>']
    .concat((expenseMethods || []).map((mm) => `<option value="${esc(mm)}">${esc(mm)}</option>`))
    .concat(retired ? [`<option value="${esc(retired)}">${esc(retired)} (no longer offered)</option>`] : [])
    .join('');
  // The default reaches a NEW expense only. On an EDIT it would make an old
  // expense with no recorded method come up reading "Cash", and saving would
  // both rewrite it and withdraw from petty cash for money that may never
  // have left the box.
  sel.value = expense
    ? (((expenseMethods || []).includes(expense.payment_method) || retired === expense.payment_method)
        ? expense.payment_method : '')
    : (expenseDefaultMethod || '');
  $('exp_amount').value = expense ? (expense.amount ?? '') : '';
  $('expErr').textContent = '';
}


// ── "IS THIS FOR SANTIAGO?" ──────────────────────────────────────────────
// Apsara, 2026-09-15: "it should read the description and ask user whether
// they mean salary for santiago".
//
// ON BLUR, NOT ON SAVE. Asking at save time would put a network call in front
// of the Save button, and a suggestion service having a slow day would then
// feel like the form being slow. By the time she reaches Save the question is
// already on screen, or it never arrived and nothing is different.
//
// Fires only when the vendor box is EMPTY — if she typed one, second-guessing
// it is worse than useless — and the answer is hers. Nothing is filled in
// until she says yes.
let vendorAskedFor = '';
function wireVendorSuggest() {
  const desc = $('exp_description');
  const box = $('expVendorAsk');
  if (!desc || !box) return;
  const hide = () => { box.style.display = 'none'; box.innerHTML = ''; };
  hide();

  // One question at a time. When a line answers both — a name AND a category
  // that disagrees with the box — the vendor is asked first and the category
  // follows once she has answered, rather than stacking two prompts on a form
  // she is halfway through.
  function askQuestion(r, onDone) {
    if (!r || !r.suggest) { hide(); if (onDone) onDone(); return; }
    const opts = r.ambiguous && r.ambiguous.length >= 2
      // AMBIGUOUS: her own example. "Salary paid $200 for tools" argues for
      // Labour AND for Equipment, and only she knows which. Both are offered
      // by name; neither is preselected.
      ? r.ambiguous.slice(0, 2).map((c, i) => `<button type="button" class="btn expAskOpt" data-cat="${esc(c)}" style="font-size:11px; padding:4px 10px; margin-left:${i ? 6 : 8}px;">${esc(c)}</button>`).join('')
      : `<button type="button" class="btn expAskYes" style="font-size:11px; padding:4px 10px; margin-left:8px;">${r.kind === 'category' ? 'Change' : 'Yes'}</button>`;
    box.innerHTML = `<span style="color:var(--text-muted);">${esc(r.question)}</span>${opts}
      <button type="button" class="btn expAskNo" style="font-size:11px; padding:4px 10px;">${r.ambiguous ? 'Leave it' : (r.kind === 'category' ? 'Keep' : 'No')}</button>`;
    box.style.display = 'block';
    const done = () => { hide(); if (onDone) onDone(); };
    // ── SETTING A <select> TO A MISSING OPTION DOES NOTHING ───────────────
    // Silently. She clicks "Equipment", the box does not change, and there is
    // nothing on screen to say why. openExpenseModal already guards this for
    // an expense's own stored category; accepting a suggestion needs the same
    // guard. In production the suggestion can only offer a category from the
    // server's list, which is also what builds this dropdown — so this should
    // be unreachable, and that is exactly the kind of "should" that is worth
    // four lines rather than a silent no-op.
    const setCategory = (c) => {
      const sel = $('exp_category');
      if (!sel) return;
      if (![...sel.options].some((o) => o.value === c)) {
        sel.insertAdjacentHTML('afterbegin', `<option value="${esc(c)}">${esc(c)}</option>`);
      }
      sel.value = c;
    };
    box.querySelectorAll('.expAskOpt').forEach((b2) => b2.addEventListener('click', () => {
      setCategory(b2.dataset.cat); done();
    }));
    const yes = box.querySelector('.expAskYes');
    if (yes) yes.addEventListener('click', () => {
      if (r.kind === 'category') setCategory(r.category);
      else $('exp_vendor').value = r.vendor;
      done();
    });
    box.querySelector('.expAskNo').addEventListener('click', done);
  }

  desc.addEventListener('blur', async () => {
    const text = desc.value.trim();
    // Asked about this exact line already — including when she said no.
    // Re-asking the same question is how a helpful prompt becomes a nag.
    if (!text || text === vendorAskedFor) return;
    if ($('exp_vendor').value.trim()) { hide(); return; }
    vendorAskedFor = text;
    let r = null;
    try {
      r = await api('/api/expenses/suggest-vendor', {
        method: 'POST',
        body: JSON.stringify({ description: text, vendor: $('exp_vendor').value, category: $('exp_category').value }),
      });
    } catch (e) { hide(); return; }          // never let this surface as an error
    if (!r || !r.suggest) { hide(); return; }
    // No is remembered for this line by vendorAskedFor above, so it does not
    // come straight back when she tabs away again.
    askQuestion(r, () => {
      // A vendor answer can carry a category disagreement with it. Asked
      // second, so she is never looking at two prompts at once.
      if (r.kind === 'vendor' && r.category_hint) {
        askQuestion({ suggest: true, kind: 'category', ...r.category_hint });
      }
    });
  });
}

function closeExpenseModal() {
  const el = $('expenseModal');
  if (el) el.remove();
  editingExpenseId = null;
}

function wireExpenseModal() {
  if (!$('expClose')) return;
  $('expClose').addEventListener('click', closeExpenseModal);
  $('expSave').addEventListener('click', async () => {
    const payload = {
      date: toIsoDate($('exp_date').value),
      category: $('exp_category').value,
      description: $('exp_description').value.trim(),
      vendor: $('exp_vendor').value.trim() || null,
      payment_method: $('exp_payment').value || null,
      amount: $('exp_amount').value,
    };
    const btn = $('expSave');
    btn.disabled = true; btn.textContent = 'Saving…';
    $('expErr').textContent = '';
    try {
      const saved = editingExpenseId
        ? await api(`/api/expenses/${encodeURIComponent(editingExpenseId)}`, { method: 'PUT', body: JSON.stringify(payload) })
        : await api('/api/expenses', { method: 'POST', body: JSON.stringify(payload) });
      closeExpenseModal();
      await renderExpensesTab();
      // ── THE BOX DID NOT COVER IT ────────────────────────────────────────
      // A cash expense draws down petty cash. When the box did not have it,
      // the balance goes negative — meaning cash left the drawer that was
      // never entered. Said out loud, because a negative balance nobody
      // mentions is one nobody reconciles.
      if (saved && saved.expense && saved.expense.cash_shortfall) {
        const sf = Number(saved.expense.cash_shortfall);
        alert(`Recorded — but petty cash was $${sf.toFixed(2)} short of this.\n\n`
            + 'The cash box now shows a negative balance, which means cash left the drawer that was never entered here. '
            + 'Add that cash on the Petty cash tab to bring it back in line.');
      }
    } catch (err) {
      // Server validation messages are prefixed "Validation:" — stripped,
      // because that is our label and not something she needs to read.
      $('expErr').textContent = String(err.message || '').replace(/^Validation:\s*/, '');
    } finally {
      btn.disabled = false; btn.textContent = 'Save expense';
    }
  });
}

async function renderSpendReportTab() {
  const qs = [];
  if (spendFrom) qs.push('from=' + encodeURIComponent(spendFrom));
  if (spendTo) qs.push('to=' + encodeURIComponent(spendTo));
  if (spendMethod) qs.push('method=' + encodeURIComponent(spendMethod));
  if (spendBank) qs.push('bank=' + encodeURIComponent(spendBank));
  if (spendPaidVia) qs.push('paid_via=' + encodeURIComponent(spendPaidVia));
  if (spendBought) qs.push('bought_from=' + encodeURIComponent(spendBought));
  if (spendSold) qs.push('sold_to=' + encodeURIComponent(spendSold));
  if (spendCompany) qs.push('company=' + encodeURIComponent(spendCompany));
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

  // ── THE LOOK, 2026-11-07 ────────────────────────────────────────────────
  // Apsara: "Ugly". Fifteen filter chips in solid light grey, three rows of
  // them, shouting louder than the money. An inactive control should be
  // legible and quiet; only the SELECTED one earns contrast. Same classes and
  // the same data- attributes, so every click handler below is untouched —
  // this is paint, not wiring.
  const chipCss = (on) => on
    ? 'font-size:11.5px; padding:6px 13px; border-radius:999px; background:var(--accent); '
      + 'color:#0C0E10; font-weight:700; border:1px solid var(--accent);'
    : 'font-size:11.5px; padding:6px 13px; border-radius:999px; background:transparent; '
      + 'color:var(--text-muted); font-weight:500; border:1px solid var(--border-subtle);';

  const groupLabel = 'font-family:var(--font-mono); font-size:9.5px; letter-spacing:.14em; '
    + 'text-transform:uppercase; color:var(--text-faint); align-self:center; '
    + 'width:64px; flex:0 0 64px;';

  // A proportion bar. The point of the whole redesign: "$2,049,070.70" and
  // "95% of everything" are the same number and only one of them is read.
  const pct = (n, of) => (!of ? 0 : Math.max(0, Math.min(100, (Number(n) || 0) / of * 100)));
  const bar = (n, of, colour) => `
    <div style="height:5px; border-radius:3px; background:var(--surface-sunken); overflow:hidden; margin-top:5px;">
      <div style="height:100%; width:${pct(n, of).toFixed(1)}%; background:${colour}; border-radius:3px;"></div>
    </div>`;

  // ── THE SOLD-TO CARD TAKES A DIFFERENT DENOMINATOR ─────────────────────
  // splitCard proportions everything against rep.total, which is money OUT.
  // The sold-to figures are money IN, so running them through splitCard
  // would print percentages of the wrong number — 9,000 received shown as
  // "0% of out" if she happened to buy more than she sold that month. A
  // percentage of the wrong denominator is worse than no percentage: it is
  // a wrong figure that looks computed.
  const soldCard = (title, obj, ofTotal) => {
    const keys = Object.keys(obj || {});
    if (!keys.length) return '';
    const of = Number(ofTotal) || keys.reduce((a, k) => a + (Number(obj[k]) || 0), 0);
    return `
      <div style="flex:1 1 300px; min-width:260px;">
        <div style="font-family:var(--font-mono); font-size:9.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--text-faint); margin-bottom:12px;">${esc(title)}<span style="color:var(--text-faint); text-transform:none; letter-spacing:0; font-size:10px;"> — of money received</span></div>
        ${keys.sort((a, b) => (obj[b] || 0) - (obj[a] || 0)).map((k) => {
          const gap = k === NOT_REC;
          return `
          <div style="margin-bottom:12px;">
            <div style="display:flex; justify-content:space-between; align-items:baseline; gap:10px;">
              <span style="font-size:12.5px; color:${gap ? 'var(--status-warning, #d69e2e)' : 'var(--text-muted)'};">${esc(k)}</span>
              <span style="font-family:var(--font-mono); font-size:13px; font-weight:700; color:var(--leaf-600, #2e7d32); white-space:nowrap;">${esc(money(obj[k]))}<span style="color:var(--text-faint); font-weight:400; font-size:11px; margin-left:6px;">${pct(obj[k], of).toFixed(0)}%</span></span>
            </div>
            ${bar(obj[k], of, gap ? 'var(--status-warning, #d69e2e)' : 'var(--leaf-600, #2e7d32)')}
          </div>`;
        }).join('')}
      </div>`;
  };

  // ── WHAT "OUT" IS MADE OF ───────────────────────────────────────────────
  // Named in the order she thinks about them. Only the non-zero parts are
  // shown, but NOTHING is dropped for being awkward: these add to rep.total
  // exactly, which is the property tests/spend-report.js already asserts on
  // the engine and the reason the heading can stop guessing.
  const PARTS = [
    ['Paid to sellers',   rep.loadTotal,           'var(--accent)'],
    ['Trucking',          rep.truckerTotal,        '#6B8FB5'],
    ['Suppliers',         rep.supplierTotal,       '#8E7CC3'],
    ['Cost of sales',     rep.saleCostTotal,       '#C98A5E'],
    ['Edge Metals haulage', rep.metalsTruckingTotal, '#5E9E8E'],
    ['Expenses',          rep.expenseTotal,        '#B5736B'],
  ].filter((r) => Math.abs(Number(r[1]) || 0) > 0.005);
  const partsSum = PARTS.reduce((a, r) => a + (Number(r[1]) || 0), 0);
  // If these ever stop reconciling, SAY SO rather than printing a tidy bar
  // that is quietly short. An unexplained remainder is exactly the thing
  // this card exists to have stopped.
  const partsGap = Math.round((Number(rep.total) || 0) - partsSum, 2);

  // One card for both breakdowns. "Not recorded" is a gap, not a bank and not
  // a company, so it is drawn in warning amber wherever it appears — it was
  // previously indistinguishable from a real account sitting between BofA and
  // Chase.
  const NOT_REC = 'Not recorded';
  const splitCard = (title, obj, note) => {
    const keys = Object.keys(obj || {});
    if (!keys.length) return '';
    const of = Number(rep.total) || keys.reduce((a, k) => a + (Number(obj[k]) || 0), 0);
    const rows = keys.sort((a, b) => (obj[b] || 0) - (obj[a] || 0));
    return `
      <div style="flex:1 1 300px; min-width:260px;">
        <div style="font-family:var(--font-mono); font-size:9.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--text-faint); margin-bottom:12px;">${esc(title)}</div>
        ${rows.map((k) => {
          const gap = k === NOT_REC;
          const colour = gap ? 'var(--status-warning, #d69e2e)' : 'var(--accent)';
          return `
          <div style="margin-bottom:12px;">
            <div style="display:flex; justify-content:space-between; align-items:baseline; gap:10px;">
              <span style="font-size:12.5px; color:${gap ? 'var(--status-warning, #d69e2e)' : 'var(--text-muted)'};">${esc(k)}</span>
              <span style="font-family:var(--font-mono); font-size:13px; font-weight:700; color:var(--text-strong); white-space:nowrap;">${esc(money(obj[k]))}<span style="color:var(--text-faint); font-weight:400; font-size:11px; margin-left:6px;">${pct(obj[k], of).toFixed(0)}%</span></span>
            </div>
            ${bar(obj[k], of, colour)}
          </div>`;
        }).join('')}
        ${note && Number(obj[NOT_REC]) > 0 ? `<div style="font-size:11.5px; color:var(--status-warning, #d69e2e); line-height:1.5; margin-top:-2px;">${esc(note)}</div>` : ''}
      </div>`;
  };

  $('viewRoot').innerHTML = `
    <section style="max-width:1080px; margin:0 auto; padding:28px 20px 80px;">
      ${pageHead('Spend report', {
        note: spendMethod
          ? `Showing <strong style="color:var(--text-strong);">${esc(spendMethod)}</strong> only — every figure below is ${esc(spendMethod)}.`
          : 'Money OUT — what you paid sellers and spent on expenses, by month and by how it was paid. Sales income is shown separately.',
        // ── FOUR FIGURES, AND THREE OF THEM DID NOT ADD UP ──────────────
        // Apsara, 2026-11-07, on this screen: "Ugly".
        //
        // It was, and the worst of it was not the styling. The heading read
        // out $2,153,593.65 / loads $857,196.72 / expenses $111,925.00 —
        // which invites the obvious subtraction, and the obvious subtraction
        // leaves $1,184,471.93 with no name on it. FIFTY-FIVE PER CENT of
        // the money on her spend report was in categories the screen never
        // mentioned: trucking, suppliers, sale costs, Edge Metals haulage.
        //
        // The engine has had all four since the day each was added and
        // tests/spend-report.js already asserts they sum to the total. Only
        // the screen was picking two to show. So the heading now carries the
        // total and the count, and the composition below it names every
        // part — see the "Where it went" card.
        stats: [['out', esc(money(rep.total))], ['entries', esc(rep.count)]],
        chips: [spendMethod ? `${spendMethod} only` : null, 'admin only'],
      })}

      <!-- ── the filter bar ───────────────────────────────────────────────
           Apsara, 2026-09-02: "report layout is not proper. apply this month
           coming in one libe why?" — From, To, Apply and four preset buttons
           were all one flex row with a flex:1 spacer between them. On a phone
           that spacer eats the line and the presets get pushed into a cramped
           strip beside Apply.
           Three stacked rows now, each with a job: the range, then the
           presets, then the method. Every row wraps on its own. -->
      <!-- ── WHOSE BOOKS, FIRST, AND ON ITS OWN ─────────────────────────
           Apsara, 2026-11-07: this "should be the one stop thing for the
           edge yard". It sits above everything else and outside the filter
           card because it is not a filter like the others — it decides
           which company the whole page is about, and CLAUDE.md rule 5 says
           those two must never be read as one. -->
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:14px;">
        ${[['edge-trading', 'Edge Yard'], ['edge-metals', 'Edge Metals'], ['', 'Both companies']]
          .map(([id, label]) => `
          <button class="btn btn-spend-company" data-company="${esc(id)}" style="${
            spendCompany === id
              ? 'font-size:12px; padding:7px 16px; border-radius:999px; background:var(--text-strong); color:#0C0E10; font-weight:700; border:1px solid var(--text-strong);'
              : 'font-size:12px; padding:7px 16px; border-radius:999px; background:transparent; color:var(--text-muted); font-weight:500; border:1px solid var(--border-subtle);'
          }">${esc(label)}</button>`).join('')}
        ${spendCompany === '' ? `<span style="font-size:11.5px; color:var(--status-warning, #d69e2e);">Two companies in one figure — useful for a bank total, never for a return.</span>` : ''}
      </div>

      <div class="card" style="padding:16px 18px; margin-bottom:18px;">
        <!-- ── PERIOD ──────────────────────────────────────────────────
             Apsara, 2026-11-07: "if i select it should auto app;y". There
             is no Apply button any more. Changing either box re-runs the
             report, and so does a preset. The button existed only because
             the boxes were read nowhere else, which is the same defect that
             made typing a range and then clicking a filter throw the range
             away. -->
        <div style="display:flex; gap:10px; align-items:flex-end; flex-wrap:wrap;">
          <span style="${groupLabel} align-self:flex-end; padding-bottom:11px;">Period</span>
          <div class="field" style="margin-bottom:0; flex:0 1 150px; min-width:130px;"><label>From</label><input id="spend_from" placeholder="MM/DD/YYYY" autocomplete="off" value="${esc(typeof toUsDate === 'function' ? toUsDate(spendFrom) : spendFrom)}"></div>
          <div class="field" style="margin-bottom:0; flex:0 1 150px; min-width:130px;"><label>To</label><input id="spend_to" placeholder="MM/DD/YYYY" autocomplete="off" value="${esc(typeof toUsDate === 'function' ? toUsDate(spendTo) : spendTo)}"></div>
          <div style="display:flex; gap:8px; flex-wrap:wrap; padding-bottom:1px;">
            ${presets.map((p, i) => `<button class="btn btn-spend-preset" data-i="${i}" style="${chipCss(false)}">${esc(p[0])}</button>`).join('')}
          </div>
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
            <button class="btn btn-spend-method" data-method="${esc(m)}" style="${chipCss(spendMethod === m)}">${esc(m || 'All')}</button>`).join('')}
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
            <button class="btn btn-spend-bank" data-bank="${esc(b)}" style="${chipCss(spendBank === b)}">${esc(b || 'All')}</button>`).join('')}
        </div>` : ''}
        <!-- ── AND WHOSE MONEY ───────────────────────────────────────────
             Apsara, 2026-09-17: "We need to keep track of this also in
             report", and, asked where: the breakdown AND a filter.

             Narrows the whole report the same way the method and the bank do
             — every figure below means "of this company", never "of
             everything, with some rows hidden".

             Only rendered when there is more than one to choose between, and
             "Not recorded" is offered on purpose: it is how she finds the
             transfers written before this field existed. -->
        ${(rep.paidViaColumns || []).length > 1 ? `
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
          <span style="font-family:var(--font-mono); font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--text-muted); align-self:center; margin-right:2px;">Paid via</span>
          ${['', ...(rep.paidViaColumns || [])].map(v => `
            <button class="btn btn-spend-via" data-via="${esc(v)}" style="${chipCss(spendPaidVia === v)}">${esc(v || 'All')}</button>`).join('')}
        </div>` : ''}
        <!-- ── WHOM WE BUY, AND WHOM WE SELL ─────────────────────────────
             Apsara, 2026-11-07: "What if i want supplier wise filter in edge
             yard", and when asked which counterparty she meant: "TWO
             FILTERS,WHOM WE BUY,WHOM WE SELL".

             TWO, not one. Each narrows its own direction of money and leaves
             the other alone — "Bought from" the spend, "Sold to" the
             received. One combined filter would empty the received block
             whenever the name is a seller, and this business already has a
             settleAgainst path precisely because the same party can be both.

             Rendered only when there is more than one name to choose
             between, exactly like the bank and company rows: a single-value
             row of chips is a control that cannot change anything. Until the
             counterparty is recorded against a payment these lists are one
             entry long, so the rows stay hidden rather than appearing broken.
        -->
        ${(rep.boughtFromColumns || []).length > 1 ? `
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; padding-top:10px; border-top:1px solid var(--border-subtle);">
          <span style="${groupLabel}">Bought from</span>
          ${['', ...(rep.boughtFromColumns || [])].map(v => `
            <button class="btn btn-spend-bought" data-bought="${esc(v)}" style="${chipCss(spendBought === v)}">${esc(v || 'All')}</button>`).join('')}
        </div>` : ''}
        ${(rep.soldToColumns || []).length > 1 ? `
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
          <span style="${groupLabel}">Sold to</span>
          ${['', ...(rep.soldToColumns || [])].map(v => `
            <button class="btn btn-spend-sold" data-sold="${esc(v)}" style="${chipCss(spendSold === v)}">${esc(v || 'All')}</button>`).join('')}
        </div>` : ''}
      </div>

      <!-- ── WHERE IT WENT ───────────────────────────────────────────────
           The card that had to exist before any of this could be called
           tidy. The heading used to print out / loads / expenses, which do
           not add up, leaving 55% of her money unnamed on screen. Every
           part is named here and they sum to the total exactly. -->
      ${PARTS.length ? `
      <div class="card" style="padding:18px 20px; margin-bottom:18px;">
        <div style="font-family:var(--font-mono); font-size:9.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--text-faint); margin-bottom:14px;">Where it went</div>
        <div style="display:flex; height:8px; border-radius:4px; overflow:hidden; background:var(--surface-sunken); margin-bottom:16px;">
          ${PARTS.map(([, v, c]) => `<div title="${esc(money(v))}" style="width:${pct(v, rep.total).toFixed(2)}%; background:${c};"></div>`).join('')}
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:14px 30px;">
          ${PARTS.map(([label, v, c]) => `
            <div style="min-width:132px;">
              <div style="display:flex; align-items:center; gap:7px;">
                <span style="width:8px; height:8px; border-radius:2px; background:${c}; flex:0 0 8px;"></span>
                <span style="font-size:11.5px; color:var(--text-muted);">${esc(label)}</span>
              </div>
              <div style="font-family:var(--font-mono); font-size:15px; font-weight:700; color:var(--text-strong); margin-top:3px;">${esc(money(v))}</div>
              <div style="font-size:10.5px; color:var(--text-faint);">${pct(v, rep.total).toFixed(1)}% of out</div>
            </div>`).join('')}
        </div>
        ${Math.abs(partsGap) > 0.01 ? `
        <div style="margin-top:14px; font-size:12px; color:var(--status-danger, #c53030);">
          These parts come to ${esc(money(partsSum))}, which is ${esc(money(Math.abs(partsGap)))} ${partsGap > 0 ? 'short of' : 'more than'} the ${esc(money(rep.total))} total. One of the two is wrong — do not file from this screen until it is found.
        </div>` : ''}
      </div>` : ''}

      <!-- ── OUT OF WHICH ACCOUNT, AND WHOSE MONEY ───────────────────────
           Apsara 2026-09-09 and 2026-09-17, two cards until today. They
           answer neighbouring questions about the same total, so they sit
           side by side now and each figure carries its share.

           Both still include "Not recorded" and both still add to Total out
           exactly — a breakdown that quietly omits the rows it cannot
           classify disagrees with its own total and invites her to pick
           which number to believe. What has changed is that the gap is
           drawn AS a gap: amber, with its percentage, instead of sitting
           between BofA and Chase looking like a third account. -->
      ${(Object.keys(rep.byBank || {}).length || Object.keys(rep.byPaidVia || {}).length) ? `
      <div class="card" style="padding:18px 20px; margin-bottom:18px; display:flex; gap:36px; flex-wrap:wrap;">
        ${splitCard('Out of each account', rep.byBank,
          'Money that left with no account recorded. Filter "Out of → Not recorded" to find and fix these.')}
        ${splitCard('Whose money it was', rep.byPaidVia,
          'Spend with no paying company against it. Edge Yard and Edge Metals are different companies, so an unattributed payment sits on neither return.')}
      </div>` : ''}

      <!-- ── WHOM WE BUY, WHOM WE SELL ───────────────────────────────────
           Apsara, 2026-11-07. The two breakdowns behind the two filters.

           byBoughtFrom adds to Total out; bySoldTo adds to Received. They
           are NEVER added to each other — the whole reason she asked for two
           filters is that money out and money in are two questions, and one
           combined "counterparty" figure would answer neither. -->
      ${(Object.keys(rep.byBoughtFrom || {}).length || Object.keys(rep.bySoldTo || {}).length) ? `
      <div class="card" style="padding:18px 20px; margin-bottom:18px; display:flex; gap:36px; flex-wrap:wrap;">
        ${splitCard('Whom we buy from', rep.byBoughtFrom,
          'Money paid out with no counterparty recorded against it. Until that is closed these two lists cannot answer "how much have I paid them this year".')}
        ${rep.received && rep.received.total
          ? soldCard('Whom we sell to', rep.bySoldTo, rep.received.total)
          : ''}
      </div>` : ''}

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
  // ── TAKE THE DATES OFF THE SCREEN BEFORE EVERY RE-RUN ──────────────────
  // Apsara, 2026-11-07: "What if i want from this date to this date in this
  // filter".
  //
  // The dates and the filters DO combine — the server ANDs all five, proven
  // in tests/spend-parties.js section C. The hole was on this side. Only
  // Apply read the two boxes. Every chip handler set its own variable and
  // re-rendered, and the re-render repaints the boxes from spendFrom /
  // spendTo — so typing a date range and then clicking a filter, without
  // pressing Apply first, silently threw the typed dates away and ran the
  // old window.
  //
  // Nothing errored and nothing looked broken: the report came back for
  // whatever range was set before, which is the worst shape a date bug can
  // take, because the figures are real and simply answer a different
  // question than the one on screen.
  //
  // So every control that re-runs the report takes the boxes first. The
  // presets still OVERWRITE them, which is the whole point of a preset.
  const takeDates = () => {
    const iso = (v) => (typeof toIsoDate === 'function' ? toIsoDate(v) : v);
    const f = $('spend_from'), t = $('spend_to');
    if (f) spendFrom = iso(f.value) || '';
    if (t) spendTo = iso(t.value) || '';
  };

  // ── AUTO-APPLY ─────────────────────────────────────────────────────────
  // Apsara: "if i select it should auto app;y". `change` fires when a date
  // picker commits a selection AND when a typed box loses focus or takes
  // Enter, so both ways of entering a date re-run the report without a
  // button. An unparseable half-typed date becomes '' — open-ended — rather
  // than throwing or freezing the old window in place.
  for (const id of ['spend_from', 'spend_to']) {
    const el = $(id);
    if (el) el.addEventListener('change', () => { takeDates(); renderSpendReportTab(); });
  }
  document.querySelectorAll('.btn-spend-company').forEach(b => b.addEventListener('click', () => {
    takeDates();
    spendCompany = b.dataset.company || '';
    renderSpendReportTab();
  }));
  document.querySelectorAll('.btn-spend-preset').forEach(b => b.addEventListener('click', () => {
    const [f, t] = presets[Number(b.dataset.i)][1]();
    spendFrom = f; spendTo = t;
    renderSpendReportTab();
  }));
  // One method at a time. Re-runs the whole report rather than hiding rows —
  // see helpers/spendReport.js for why every figure has to follow the filter.
  document.querySelectorAll('.btn-spend-method').forEach(b => b.addEventListener('click', () => {
    takeDates();
    spendMethod = b.dataset.method || '';
    renderSpendReportTab();
  }));
  document.querySelectorAll('.btn-spend-bank').forEach(b => b.addEventListener('click', () => {
    takeDates();
    spendBank = b.dataset.bank || '';
    renderSpendReportTab();
  }));
  document.querySelectorAll('.btn-spend-via').forEach(b => b.addEventListener('click', () => {
    takeDates();
    spendPaidVia = b.dataset.via || '';
    renderSpendReportTab();
  }));
  document.querySelectorAll('.btn-spend-bought').forEach(b => b.addEventListener('click', () => {
    takeDates();
    spendBought = b.dataset.bought || '';
    renderSpendReportTab();
  }));
  document.querySelectorAll('.btn-spend-sold').forEach(b => b.addEventListener('click', () => {
    takeDates();
    spendSold = b.dataset.sold || '';
    renderSpendReportTab();
  }));
}

// ── Petty cash ─────────────────────────────────────────────────────────────
// Apsara, 2026-09-02: "a new tab called Petty cash. Date and cash amount needs
// to be entered here. So it is like cash reserve."
//
// The balance is SERVER-COMPUTED (helpers/pettyCash.js sums the ledger). This
// screen never adds the rows up itself — one place owns the arithmetic, and a
// cash balance that two screens disagree about is worse than no screen at all.
//
// Staff SEE it, admin CHANGES it — her choice. Hiding the form for staff is UX
// only: POST/DELETE /api/petty-cash are requireAdmin server-side, so a staff
// session that reached them another way gets a 403.
// by_source / borrowings / transfers added 2026-09-21. `balance` keeps its
// name and its meaning — Cash in hand, the sum of every row — so nothing that
// already read it changes.
// ── by_source STARTS null, NOT {} ───────────────────────────────────────
// Apsara, 2026-10-14: "WHEN I CLICK LOADS,THEN PAY IT IS SHOWING 0.AFTER
// JSUT VISITING PERTY CASE,THEN I CLICK PAY IN LOADS,IT IS SHOWING
// PROPERLY."
//
// The pay modal reads this object and nothing fetched it, so until the Petty
// cash tab had been opened every bucket read $0.00 — and worse, the empty
// note told her "There is no cash recorded in any account yet", which is a
// FALSE STATEMENT ABOUT MONEY printed on her screen.
//
// That note already guards against exactly this: it only speaks when
// by_source is "known", because (its own words) "claiming 'there is no
// cash' while the figures are still loading would be a lie that clears
// itself a second later". The guard tests `by_source && typeof === 'object'`
// — and an EMPTY OBJECT passes it. The default defeated the defence.
//
// null makes "not fetched yet" different from "fetched, and empty", which is
// the distinction the whole note depends on. Every reader already writes
// `(pettyCash.by_source || {})`, so nothing has to change to cope with it —
// checked, all eleven.
let pettyCash = { balance: 0, entries: [], by_source: null, borrowings: [], transfers: [], sources: [] };
// Which sub-tab of Petty cash is open. Her words: "Keep this borrowing
// tracking in petty cash as a tab inside petty cash."
let pettyTab = 'cash';

async function refreshPettyCash() {
  try {
    const d = await api('/api/petty-cash');
    pettyCash = {
      balance: Number(d.balance) || 0,
      entries: Array.isArray(d.entries) ? d.entries : [],
      by_source: (d && d.by_source) || {},
      borrowings: Array.isArray(d && d.borrowings) ? d.borrowings : [],
      transfers: Array.isArray(d && d.transfers) ? d.transfers : [],
      // From the SERVER, never a list typed here. helpers/pettyCash.js says
      // why: six copies of a dropdown drift faster than three.
      sources: Array.isArray(d && d.sources) ? d.sources : [],
      by_company: (d && d.by_company) || {},
      company_of: (d && d.company_of) || {},
      bank_of: (d && d.bank_of) || {},
      company_unknown: (d && d.company_unknown) || 'Company not stated',
    };
  } catch (e) {
    // Keep the last known figure rather than showing $0.00, which would read
    // as "the box is empty" — a false statement about money. Same lesson as
    // the description catalogue emptying itself on a failed request.
    console.warn('[petty] could not refresh the balance:', e && e.message);
  }
  return pettyCash;
}

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

// ── Bills and Sales — the Edge Metals pair ───────────────────────────────
// Apsara, 2026-09-09, listing 23 columns for one and 10 for the other, and
// "Both as new tabs under Operations."
//
// ONE RENDERER FOR BOTH, and driven by the COLUMNS the server sends rather
// than by 33 columns written out here. Two reasons, and the second is the
// real one:
//
//  1. Twenty-three <th> elements hand-typed in her order is twenty-three
//     chances to put Chassis where Boxes goes.
//  2. helpers/bills.js and helpers/sales.js already define what a row IS —
//     which fields exist, which are computed, and in what order she wants to
//     read them. A second list here would be a copy that drifts, and the
//     first symptom of drift is a column heading over the wrong number. This
//     app has a comment about three implementations of one sum being two
//     chances to disagree about money; this is the same argument for shape.
//
// So the server is the single source of truth for the table, and the client
// renders whatever it is handed.
const LEDGER_KINDS = {
  bills: {
    eyebrow: '// Edge Metals', title: 'Purchase bills', addLabel: '+ Add bill', editLabel: 'Edit bill',
    path: '/api/bills', listKey: 'bills', itemKey: 'bill',
    money: ['supplier_price', 'amount', 'trucking_amount', 'advance', 'net_payable', 'balance'],
    filters: ['supplier', 'carrier', 'trucking_company'],
    weights: ['gross', 'truck', 'container', 'chassis', 'boxes', 'total', 'net_lb', 'net_mt'],
    cards: [['Total tare', 'total', 'num'], ['Net weight (lbs)', 'net_lb', 'num'],
            ['Net weight (MT)', 'net_mt', 'num'],
            ['Supplier invoice amount', 'amount', 'money'],
            // Apsara, 2026-09-10: "bill amount shoud be one thing after
            // deducting trucking,it should get auto adjusted na". It always
            // was — this is the step in between, so the deduction is a figure
            // she reads rather than one she reconstructs.
            ['Payable', 'net_payable', 'money'], ['Balance', 'balance', 'money']],
  },
  sales: {
    eyebrow: '// Edge Metals', title: 'Invoice register', addLabel: '+ Add invoice', editLabel: 'Edit invoice',
    path: '/api/sales', listKey: 'sales', itemKey: 'sale',
    money: ['invoice_price', 'amount', 'commission_per_mt', 'commission_amount',
            'received', 'balance'],
    filters: ['customer', 'terms', 'item'],
    weights: ['weight'],
    // ── WHAT THE LIVE STRIP SHOWS WHILE SHE TYPES ────────────────────────
    // Apsara, 2026-09-10: "also i want invoice amount and commission amount
    // to be computed dynamically". Both were already computed server-side;
    // what was missing is that this list — which drives BOTH the totals strip
    // in the form and the cards on the tab — still named freight_charges, a
    // column that became a charge with a note, and never named commission at
    // all. So the figure existed and she could not see it until after saving.
    //
    // Every one of these comes back from POST /api/sales/preview on each
    // keystroke. Computing them in the browser would be a second
    // implementation of her own formulas, free to disagree with the first.
    // Balance is deliberately NOT here: it depends on receipts, so a preview
    // of an unsaved row can only ever show a dash, and a permanent dash in a
    // live strip trains her to stop reading the strip. It is a column on the
    // table, where there is a saved row for it to mean something about.
    cards: [['Weight (MT)', 'weight_mt', 'num'],
            ['Invoice amount', 'amount', 'money'],
            ['Commission', 'commission_amount', 'money'],
            ['Receivable', 'receivable', 'money']],
  },
};

let ledgerState = { kind: null, rows: [], columns: [], summary: null };

const activeFilterCount = (f) => Object.values(f || {}).filter((v) => String(v || '').trim() !== '').length;

function ledFilterBox(key, label, placeholder, value, width) {
  return `<div>
    <div style="font-family:var(--font-mono); font-size:9px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted); margin-bottom:4px;">${label}</div>
    <input data-led-filter="${key}" value="${esc(value || '')}" placeholder="${esc(placeholder)}" autocomplete="off"
      style="width:${width}px; padding:7px 9px; background:var(--surface-card); border:1px solid var(--border-default); border-radius:var(--radius-sm); color:var(--text-strong); outline:none; font-size:12px;">
  </div>`;
}

// Built from the values actually PRESENT, so it can never offer a choice that
// returns nothing — a dropdown with an option that finds no rows reads as
// broken. The server sends facets computed over every row, not the filtered
// ones, or narrowing by supplier would empty the supplier list she just used.
function ledFilterSelect(key, facets, value) {
  const opts = (facets[key] || []);
  if (!opts.length) return '';
  // The column's OWN label, so the dropdown says "Trucker" like the table
  // does. Deriving it from the key gave "Trucking Company" — a third name for
  // one thing, on the same screen as the other two.
  const col = (ledgerState.fields || []).find((c) => c.key === key);
  const label = col ? col.label : key.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
  return `<div>
    <div style="font-family:var(--font-mono); font-size:9px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted); margin-bottom:4px;">${esc(label)}</div>
    <select data-led-filter="${key}" style="padding:7px 9px; background:var(--surface-card); border:1px solid var(--border-default); border-radius:var(--radius-sm); color:var(--text-strong); outline:none; font-size:12px;">
      <option value="">All</option>
      ${opts.map((o) => `<option value="${esc(o)}"${o === value ? ' selected' : ''}>${esc(o)}</option>`).join('')}
    </select>
  </div>`;
}

// ── NO BARE <input type="date"> ──────────────────────────────────────────
// Caught by tests/mobile-layout.js, which has been guarding this since the
// "give every date field a picker" work: a native date input renders in the
// DEVICE's locale, so on her en-IN phone it shows DD/MM/YYYY while every
// stored date in this app is MM/DD/YYYY. A cutoff read a month wrong is the
// same class of error as the one in helpers/bookingRequest.js.
//
// So the ledger forms use the same wireUsDateField + attachDatePicker
// treatment as every other date box here. I reached for type="date" out of
// habit and the existing test stopped me, which is what it is for.
const isLedgerDate = (k) => k === 'date' || /_date$/.test(k);

const ledMoney = (n) => (n === null || n === undefined || n === '' || isNaN(Number(n)))
  ? '—'
  : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ledNum = (n) => (n === null || n === undefined || n === '' || isNaN(Number(n)))
  ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 });
const ledText = (v) => (v === null || v === undefined || v === '') ? '—' : esc(String(v));

// One cell. The price columns carry their UNIT, which is not decoration:
// helpers/bills.js infers /lb vs /MT from the magnitude of the price, and
// getting that wrong is a figure out by a factor of 2204 in a column she pays
// from. Her answer when asked was "Yes — show '/lb' or '/MT' on the row", and
// this is the only thing that makes a bad inference visible at a glance.
function ledgerCell(row, col, cfgK) {
  const v = row[col.key];
  // ── PHOTOS ARE LINKS, AND THE URL WAS PASTED BY HAND ─────────────────
  // Apsara, 2026-09-10: "In bill,i want photos field where url can be
  // pasted." Rendered as links rather than as raw text, because a column of
  // 90-character URLs makes the table unreadable.
  //
  // helpers/bills.js:cleanPhotos already dropped anything that is not http
  // or https before it was stored — a "javascript:" URL pasted here would
  // otherwise run on click. esc() on top, because the href is her text.
  if (col.key === 'photos') {
    const urls = Array.isArray(v) ? v : [];
    if (!urls.length) return '—';
    return urls.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent); text-decoration:none;">#${i + 1}</a>`).join(' ');
  }
  if (col.key === 'supplier_price' || col.key === 'invoice_price') {
    if (v === null || v === undefined || v === '') return '—';
    const u = row.price_unit === 'lb' ? '/lb' : row.price_unit === 'mt' ? '/MT' : '';
    return ledMoney(v) + (u ? `<span style="color:var(--text-muted); font-size:10px;">${u}</span>` : '');
  }
  if (cfgK.money.includes(col.key)) return ledMoney(v);
  if (cfgK.weights.includes(col.key) || col.key === 'net_mt' || col.key === 'weight_mt') return ledNum(v);
  return ledText(v);
}

// ── FILTERS, AND SEVERAL AT ONCE ─────────────────────────────────────────
// Apsara, 2026-09-10: "also i want filter.ultiple filters can also be
// applied." Held per tab so switching to Sales and back does not silently
// lose what she narrowed to.
const ledgerFilters = { bills: {}, sales: {} };

// ── FOUR TABS, TWO STORES ────────────────────────────────────────────────
// Apsara, 2026-09-10: "What if we have tabs like Outgoing(invoice data),
// Incoming(payment data), Freight(...) Similarly a tab called commission"
//
// She gets the four tabs. Freight and Commission are VIEWS of the container
// row, not stores of their own: both would otherwise hold their own copy of
// booking, container, carrier and weight, and four copies of the same fact
// disagree. Commission especially — it is weight x rate, so a second weight
// on a Commission table would compute the agent's money off a stale figure
// and nothing on screen would say so.
// The three derived sales views share one render function; the NAV is what
// switches between them (see the Operations block above), so there is no
// current-sub-tab state to keep. There WAS, briefly, and it was a bug: a
// leftover `if (salesSubTab !== 'outgoing') return renderSalesSubTab(...)`
// at the top of renderLedgerTab meant clicking Outgoing rendered whichever
// sales view had been open last. Caught by its own test, which could not
// find the New-from-bill button because the page was showing Incoming.
// Which tab is showing in each section. Reset by the nav on arrival.
