// dashboard/app/12-payments-recording.js — split from dashboard/index.html's <script> (helpers/sourceParts.js reconstructs the original)
function loadMonthKey(iso) { return String(iso || '').slice(0, 7); }

function loadWeekStart(iso) {
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  // getDay(): 0 = Sunday. Shift so Monday is the first day.
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  return d.toISOString().slice(0, 10);
}

function loadWeekLabel(days) {
  // Labelled by the days ACTUALLY PRESENT, not by the calendar week, so a
  // heading never advertises a range with nothing in most of it.
  const sorted = days.slice().sort();
  const fmt = (k) => new Date(k + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const a = sorted[0], b = sorted[sorted.length - 1];
  return a === b ? fmt(a) : `${fmt(a)} – ${fmt(b)}`;
}

function loadMonthLabel(key) {
  const d = new Date(key + '-01T00:00:00');
  if (isNaN(d.getTime())) return key;
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

// Splits the deck into the part that stays flat (this month, plus anything
// undated) and the older months, folded.
// ── LAST WEEK IS OPEN, THE REST FOLDS (2026-10-02) ───────────────────────
// Apsara: "in collapse phase of Edge Yard-I want last week load to
// visible.rest of them collapsible."
//
// This used to split on the CALENDAR MONTH: everything in the current month
// stayed open. On the 28th that is four weeks of day sections before the
// first fold, which is the scrolling the folding was meant to remove — and
// on the 1st it is nothing at all, so the screen went from four weeks to one
// day overnight.
//
// A ROLLING SEVEN DAYS, asked and confirmed: "always expanded... on a Monday
// that includes last Thu-Sun, which is usually what you want to still see."
// Same amount of work in view every day of the month, and no cliff on the
// 1st.
//
// LOCAL days, not UTC. new Date().toISOString() in the old version took the
// UTC date, so for the seven hours after 5pm Pacific it believed it was
// already tomorrow — which on the last day of a month moved the whole
// boundary a month early. Dates on a load are the yard's own day.
// ── A FUNCTION, NOT A CONST, ON PURPOSE ──────────────────────────────────
// tests/load-card-actions.js extracts single functions out of this file by
// name (`function <name>(`) and evaluates them in isolation — which is how
// it has twice caught a function quietly gaining a dependency on the global
// scope. A `const LOAD_RECENT_DAYS = 7` here was not extractable, so
// splitLoadsByRecency threw ReferenceError the moment that test ran it.
//
// Declaring it as a function keeps ONE source of truth for the seven and
// keeps the extraction working. Copying the 7 into the test instead would
// have left two numbers that can disagree.
function loadRecentDays() { return 7; }

function loadLocalDayKey(d) {
  const t = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

function splitLoadsByRecency(loads, opts) {
  const days = (opts && opts.days) || loadRecentDays();
  const from = new Date();
  // days - 1: seven days INCLUDING today, not today plus seven.
  from.setDate(from.getDate() - (days - 1));
  const cutoff = loadLocalDayKey(from);
  const recent = [], older = [];
  for (const l of (loads || [])) {
    const d = l && l.date ? String(l.date).slice(0, 10) : '';
    // Undated loads stay in the open part. Filing them under a month would
    // mean inventing one, and they are the rows most likely to need fixing.
    if (!d || d >= cutoff) recent.push(l);
    else older.push(l);
  }
  return { recent, older };
}

// Which months the data actually has, newest first, for the filter. Built
// from the loads rather than from a calendar: offering a month with nothing
// in it is a control that answers "no loads" and looks broken.
function loadMonthsPresent(loads) {
  const seen = new Map();
  for (const l of (loads || [])) {
    const k = loadMonthKey(l && l.date);
    if (!k) continue;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  return Array.from(seen.keys()).sort((a, b) => b.localeCompare(a))
    .map((k) => ({ key: k, count: seen.get(k), label: loadMonthLabel(k) }));
}

function loadMonthLabel(key) {
  const [y, m] = String(key || '').split('-');
  const names = ['January', 'February', 'March', 'April', 'May', 'June',
                 'July', 'August', 'September', 'October', 'November', 'December'];
  const name = names[Number(m) - 1];
  return name ? `${name} ${y}` : String(key || '');
}

// Undated loads are NOT swept into a month filter. They have no month, and
// showing them under one would be the same invention splitLoadsByRecency
// refuses to make.
function filterLoadsByMonth(loads, key) {
  if (!key) return loads || [];
  return (loads || []).filter((l) => loadMonthKey(l && l.date) === key);
}

// [{ key, label, count, weeks: [{ key, label, count, days: [{key,label,loads}] }] }]
function groupLoadsByMonthWeekDay(loads) {
  const byMonth = new Map();
  for (const l of (loads || [])) {
    const mk = loadMonthKey(l && l.date);
    if (!byMonth.has(mk)) byMonth.set(mk, []);
    byMonth.get(mk).push(l);
  }
  return Array.from(byMonth.keys()).sort((a, b) => b.localeCompare(a)).map((mk) => {
    const byWeek = new Map();
    for (const l of byMonth.get(mk)) {
      const wk = loadWeekStart(l.date);
      if (!byWeek.has(wk)) byWeek.set(wk, []);
      byWeek.get(wk).push(l);
    }
    const weeks = Array.from(byWeek.keys()).sort((a, b) => b.localeCompare(a)).map((wk) => {
      const byDay = new Map();
      for (const l of byWeek.get(wk)) {
        if (!byDay.has(l.date)) byDay.set(l.date, []);
        byDay.get(l.date).push(l);
      }
      const dayKeys = Array.from(byDay.keys()).sort((a, b) => b.localeCompare(a));
      return {
        key: wk,
        label: loadWeekLabel(dayKeys),
        count: byWeek.get(wk).length,
        days: dayKeys.map((dk) => ({ key: dk, label: formatLoadDateHeading(dk), loads: byDay.get(dk) })),
      };
    });
    return { key: mk, label: loadMonthLabel(mk), count: byMonth.get(mk).length, weeks };
  });
}

function loadCountLabel(n) { return `${n} load${n === 1 ? '' : 's'}`; }

// `allOpen` renders every fold expanded. Used when she has picked a month
// from the filter: "If they select that month -all that months load should be
// visible expanded." Default false, so nothing about the ordinary view moves.
function loadFoldedMonthsHtml(older, allOpen) {
  const o = allOpen ? ' open' : '';
  return groupLoadsByMonthWeekDay(older).map((m) => `
    <details class="load-month-section"${o}>
      <summary class="load-date-heading">${esc(m.label)}<span class="load-date-count">${loadCountLabel(m.count)}</span></summary>
      ${m.weeks.map((w) => `
        <details class="load-week-section"${o}>
          <summary class="load-week-heading">${esc(w.label)}<span class="load-date-count">${loadCountLabel(w.count)}</span></summary>
          ${w.days.map((d) => `
            <details class="load-day-section"${o}>
              <summary class="load-day-heading">${esc(d.label)}<span class="load-date-count">${loadCountLabel(d.loads.length)}</span></summary>
              <div class="load-deck-grid">${d.loads.map(loadCardHtml).join('')}</div>
            </details>`).join('')}
        </details>`).join('')}
    </details>`).join('');
}

function loadDeckSectionsHtml(loads, emptyMsg, opts) {
  const flat = !!(opts && opts.flat);
  const empty = `<div style="padding:60px; text-align:center; color:var(--text-faint); font-family:var(--font-mono); font-size:12px;">${esc(emptyMsg)}</div>`;

  if (flat) {
    const rows = (loads || []).slice().sort((a, b) => {
      // Newest first, undated last — the same ordering groupLoadsByDate
      // produces, just without the headings.
      const ad = a && a.date ? a.date : '';
      const bd = b && b.date ? b.date : '';
      if (!ad && !bd) return 0;
      if (!ad) return 1;
      if (!bd) return -1;
      return bd.localeCompare(ad);
    });
    if (!rows.length) return empty;
    return `<div class="load-deck-grid">${rows.map(loadCardHtml).join('')}</div>`;
  }

  // This month stays as day sections; older months fold into
  // month -> week -> day. See splitLoadsByRecency for why.
  // allOpen: she picked a month, so everything in view is expanded — the
  // last-week/older split still applies, it is just all open.
  const allOpen = !!(opts && opts.allOpen);
  const { recent, older } = splitLoadsByRecency(loads);
  const groups = groupLoadsByDate(recent);
  if (!groups.length && !older.length) {
    return empty;
  }
  // ── EVERY DAY IN THE WEEK IS OPEN, NOT JUST THE NEWEST ─────────────────
  // This was `i === 0` — only the most recent day. Under the old
  // this-month rule that was right: the alternative was four weeks of open
  // sections. Under "I want last week load to visible" it is wrong, and it
  // was the first thing my own test caught: one open day and six shut is the
  // scrolling the folding was meant to remove.
  //
  // `recent` IS the last seven days now, so opening all of it is exactly
  // what she asked for and is bounded by the window rather than by a month.
  const days = groups.map((g) => `
    <details class="load-date-section" open>
      <summary class="load-date-heading">${esc(g.label)}<span class="load-date-count">${g.loads.length} load${g.loads.length === 1 ? '' : 's'}</span></summary>
      <div class="load-deck-grid">${g.loads.map(loadCardHtml).join('')}</div>
    </details>`).join('');
  return days + (older.length ? loadFoldedMonthsHtml(older, allOpen) : '');
}


// Payment badge for a load card. Silent when nothing has been paid — an
// "UNPAID" tag on every load is noise, and a badge that appears on everything
// is one people stop reading.
// ── Recording a payment ────────────────────────────────────────────────────
let payingLoad = null;   // { id, kind, amount, seller, payment }

// Same rule as fmtAmount — every amount on screen carries its $.
const payMoney = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── THE BANK ON A ZELLE OR A WIRE ────────────────────────────────────────
// Apsara, 2026-09-09: "options like BofA, Chase Bank, Others. when they select
// others a text box should appear in mobile app and website."
//
// The list comes from the SERVER (GET /api/payments returns it) rather than
// being written out here and again in the app. Two hardcoded copies drift,
// and the one that drifts is the one that offers a bank the server rejects —
// which reads to her as a broken Save button, not as a mismatched list.
//
// Seeded with the same two the server starts with, so the form still works if
// that fetch has not landed yet.
let bankOptions = ['BofA', 'Chase Bank'];
// Only the fallback for the first paint; /api/banks replaces it with the
// server's MODES_WITH_BANK. Kept in step anyway, or a Bank transfer chosen
// before that response lands shows no bank field.
// The fallback until the server's list lands. Kept in step with
// helpers/banks.js's MODES_WITH_BANK, which has moved twice: Zelle came off
// it on 2026-09-17 ("should not have bank for zelle"), then Zelle and Cheque
// came back on as OPTIONAL on 2026-10-01 ("Zelle/Cheque also has a bank.but
// keep it as optional"). A stale fallback here hides the bank row for the
// first moment after the modal opens, which reads as the field not existing.
//
// This list is "may have a bank", i.e. show the row. It is NOT "must" —
// banks.js keeps MODES_EXPECTING_BANK separately for that, and this client
// must never send require_bank for Zelle or Cheque on the strength of
// appearing here.
let bankModes = ['Wire', 'Bank transfer', 'Zelle', 'Cheque'];
let bankOther = 'Others';

// ── AND SOMETHING HAS TO GO AND ASK ──────────────────────────────────────
// The Trucker tab happens to carry the list on its own payload, but the Pay
// form on a LOAD never fetched anything — so a bank she typed under Others
// would have appeared on one form and not the other, which is worse than not
// remembering it at all. Fetched when the Pay modal opens: one small request,
// at the moment the list is about to be used, so a bank added on her phone is
// on the website's dropdown the next time she pays somebody.
//
// Failure is silent ON PURPOSE. If it cannot be reached the form keeps the
// two seeded banks and Others still works — she can type the name and the
// server records it. A blocking error here would stop her recording a payment
// over a dropdown that had a working escape hatch all along.
// ── THE SAME STALENESS BUG THE ADDRESS BOOK HAD ────────────────────────────
// Apsara, 2026-09-16, asked whether anything ELSE goes stale until she logs
// out. This did.
//
// It was `if (bankListLoaded && !force) return;` with a latch that nothing
// ever forced — so the bank list was fetched once per session and never
// again. A bank she typed under "Others" on the website was invisible on the
// phone, and in the other browser tab, until the session was torn down. The
// identical shape of `if (!docsAddressBook.length)`, one screen over.
//
// Now refreshed on every pay-modal open. It is one small request, which is
// what the address book concluded too.
//
// AND THE LAST GOOD LIST SURVIVES A FAILURE. The assignments are guarded on
// `.length`, so a failed or empty response leaves the previous values in
// place rather than emptying the dropdown. A stale bank list is usable; an
// empty one means she cannot record which account a transfer came from.
async function loadBankOptions() {
  try {
    const d = await api('/api/payments');
    if (Array.isArray(d.banks) && d.banks.length) bankOptions = d.banks;
    if (Array.isArray(d.bank_modes) && d.bank_modes.length) bankModes = d.bank_modes;
    if (typeof d.other === 'string' && d.other) bankOther = d.other;
  } catch (e) {
    console.warn('[BANKS] could not refresh the bank list, keeping the last good one:', e.message);
  }
}

function paintBankOptions(sel) {
  if (!sel) return;
  const keep = sel.value;
  sel.innerHTML = bankOptions.map(b => `<option value="${esc(b)}">${esc(b)}</option>`).join('')
    + `<option value="${esc(bankOther)}">${esc(bankOther)}</option>`;
  // Her previous choice survives a repaint — losing it mid-form is how a
  // dropdown silently reverts to the first bank while she is looking at the
  // amount field.
  if (keep && [...sel.options].some(o => o.value === keep)) sel.value = keep;
}

// Shows or hides the bank row for the chosen mode, and the text box for
// Others. `prefix` is 'pay' or 'trk' — the two forms are identical in
// behaviour, so they share this rather than each growing their own copy.
// ── WHICH COMBINATIONS ASK, AND WHAT THEY ASK ─────────────────────────────
// Two directions, two questions. A PURCHASE pays a supplier — "Payment via",
// whose money went out, and Wire is the only transfer left on that side since
// she removed Bank transfer from it. A SALE receives money — "Paid to", which
// company it landed in, on Bank transfer.
//
// CASH NEVER ASKS, either way: cash from a yard sale goes into Edge Yard's
// petty cash box (her rule of 2026-09-02), so it is always the yard's and
// asking would let her file a contradiction with her own ledger.
//
// Kept in step with helpers/payments.js's PAID_VIA_BY_KIND, which is what the
// server enforces: a client that asks on different combinations than the
// server requires is a form that fails on save.
// Which companies can own money leaving a given bank. Mirrors
// helpers/payments.js's paidViaOptionsFor — BofA holds Edge Metals and AAA
// Investment, Chase is Edge Yard's, and anything unrecognised is not narrowed
// so an "Others" bank can never leave her unable to say whose money it was.
const PAID_VIA_ALL = ['Edge Yard', 'Edge Metals', 'AAA Investment'];
function paidViaOwnersFor(bank) {
  const b = String(bank == null ? '' : bank).trim();
  if (!b) return PAID_VIA_ALL.slice();
  if (/^chase/i.test(b)) return ['Edge Yard'];
  const of = (pettyCash && pettyCash.bank_of) || {};
  const owners = Object.keys(of).filter((a) => of[a] === b && PAID_VIA_ALL.includes(a));
  return owners.length ? owners : PAID_VIA_ALL.slice();
}

const paidViaModesFor = (sale) => (sale ? ['Bank transfer'] : ['Wire']);
const paidViaLabelFor = (sale) => (sale ? 'Paid to' : 'Payment via');
// ── WHOSE MONEY, AND WHY THE KIND COMES OFF THE ROW ───────────────────────
// Apsara, 2026-09-17: "on selecting wire-it should ask me Payment via Edge
// Yard/Edge Metals", and on which modes, "Wire and Bank Transfer".
//
// openPayModal stamps data-kind on the row. Reading `payingLoad` directly
// would work in the browser and be untestable outside it: payingLoad is a
// top-level `let`, which is a script-scope binding and NOT a window property,
// so a test that assigns w.payingLoad assigns a DIFFERENT variable and this
// function never sees it. Ninth time this project has been caught by that.
//
// It is also the better design: the DOM says what the modal is for.
//
// ── AND THE BODY IS IDENTICAL IN BOTH CLIENTS ─────────────────────────────
// tests/banks.js compares this function character for character across
// dashboard/index.html and mobile-app/www/index.html, because two helpers that
// are merely SIMILAR are two helpers that drift — and the way that fails is
// one client offering what the other cannot save. So every word of
// explanation lives out here, above the function, rather than inside it.
function syncBankFields(prefix) {
  const mode = ($(prefix + '_mode') || {}).value || '';
  const row = $(prefix + '_bank_row');
  const sel = $(prefix + '_bank');
  const otherField = $(prefix + '_bank_other_field');
  const needs = bankModes.some(m => m.toLowerCase() === String(mode).toLowerCase());
  if (row) row.style.display = needs ? '' : 'none';
  if (otherField) otherField.style.display = (needs && sel && sel.value === bankOther) ? '' : 'none';
  const viaRow = $(prefix + '_via_row');
  if (viaRow) {
    const sale = viaRow.dataset.kind === 'sale';
    const asks = paidViaModesFor(sale).some((m) => m.toLowerCase() === String(mode).toLowerCase());
    const lbl = viaRow.querySelector('label');
    if (lbl) lbl.textContent = paidViaLabelFor(sale);
    // ── THE OWNERS THIS BANK CAN HAVE (2026-09-24) ─────────────────────
    // Apsara: "Bofa has only two accounts.Edge Metals and AAA Investment".
    // Kept in step with helpers/payments.js's paidViaOptionsFor, which is
    // what addPayment enforces — a list here the server refuses is a save
    // that fails after she has filled the form in.
    const owners = paidViaOwnersFor(bankValue(prefix));
    const via = $(prefix + '_via');
    if (via) {
      const keep = via.value;
      via.innerHTML = (owners.length === 1 ? '' : '<option value="">Choose…</option>')
        + owners.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
      via.value = owners.includes(keep) ? keep : (owners.length === 1 ? owners[0] : '');
    }
    // ONE POSSIBLE OWNER IS NOT A QUESTION. A Chase wire can only be Edge
    // Yard, so the row hides and the value goes with the payment anyway —
    // the server resolves the same way if it arrives blank.
    viaRow.style.display = (asks && owners.length > 1) ? '' : 'none';
  }
  // ── AND WHICH CASH, WHICH FOLLOWS THE MODE ───────────────────────────
  // Wired here rather than only at open, or switching the dropdown from
  // Zelle to Cash would leave the question hidden and the payment would
  // silently come out of unbanked cash. Purchases only: a sale takes cash
  // IN, and `_via_row`'s kind is already the flag that says which.
  const cashRow = $(prefix + '_cash_source_row');
  if (cashRow) {
    const isSale = viaRow && viaRow.dataset.kind === 'sale';
    cashRow.style.display = (String(mode).toLowerCase() === 'cash' && !isSale) ? '' : 'none';
  }
}


// What to send. Null when the mode has no bank, so the server sees an absent
// field rather than an empty string — it refuses a bank on Cash, and "" is
// still a value.
function bankValue(prefix) {
  const mode = ($(prefix + '_mode') || {}).value || '';
  if (!bankModes.some(m => m.toLowerCase() === String(mode).toLowerCase())) return null;
  const sel = $(prefix + '_bank');
  if (!sel) return null;
  if (sel.value === bankOther) return (($(prefix + '_bank_other') || {}).value || '').trim() || null;
  return sel.value || null;
}

// ── opts.historyOnly MARKS THE NEW SHAPE, NEVER THE OLD ───────────────────
// CLAUDE.md: a flag on shared code says "this one is the new shape". Called
// with nothing, this modal is exactly what it has always been — the Pay form
// with the history under it. Only the paid-badge path passes the flag, and
// only the Jarvis profile can reach that path.
function openPayModal(loadId, kind, opts) {
  const historyOnly = !!(opts && opts.historyOnly);
  const l = loadsCache.find(x => x.id === loadId);
  if (!l) return;
  // ── THE CASH FIGURES HAVE TO BE FETCHED, NOT ASSUMED ─────────────────
  // Apsara, 2026-10-14: "WHEN I CLICK LOADS,THEN PAY IT IS SHOWING 0.AFTER
  // JSUT VISITING PERTY CASE,THEN I CLICK PAY IN LOADS,IT IS SHOWING
  // PROPERLY."
  //
  // `pettyCash` is filled by renderPettyCashTab, and this modal read it
  // without ever asking for it. Open the app, go straight to Loads, press
  // Pay: every bucket $0.00 and a note saying there is no cash. Visit Petty
  // cash once and it is right for the rest of the session. Nothing was
  // stale — it had never been loaded.
  //
  // NOT AWAITED, and the modal is not held open on a network call: she is on
  // a phone and asked for this to be fast. It opens immediately showing
  // "…", the figures arrive a moment later, and syncBankFields runs again to
  // put them in. refreshPettyCash keeps the last known figure on a failure,
  // so a bad connection leaves what was there rather than zeroing it.
  //
  // Fetched once per session unless the money has changed — every path that
  // changes it (add cash, repay, split, delete, and recording a payment
  // below) already calls refreshPettyCash itself.
  if (pettyCash.by_source === null && typeof refreshPettyCash === 'function') {
    refreshPettyCash().then(() => {
      // Only if this modal is still the one open. A fetch that lands after
      // she has closed it and opened another row must not redraw that one.
      const m = $('payModal');
      if (m && !m.classList.contains('hidden')) syncBankFields('pay');
    }).catch(() => {});
  }
  // `amount` here is what the OVERPAYMENT check below subtracts against, so
  // it has to be the payable, not the metal's figure — otherwise a load with
  // $200 deducted would accept a $200 overpayment without a word. The sale
  // branch is untouched: a sale has no net_payable and l.net_payable is
  // undefined on one, so ?? falls through to l.amount.
  payingLoad = { id: l.id, kind: kind || l._kind || 'purchase',
                 amount: (kind || l._kind) === 'sale' ? l.amount : (l.net_payable ?? l.amount),
                 seller: l.seller, payment: l.payment };
  const p = l.payment || { paid: 0, pending: payingLoad.amount, status: 'unpaid' };
  // A sale's BUYER is aliased into `seller` when the two lists are merged
  // (see the map that sets _kind), so the name shown is right either way.
  // The direction is not, and everything below keys off this.
  const sale = payingLoad.kind === 'sale';
  const who = l.seller ? ` · ${l.seller}` : '';
  const ttl = document.getElementById('payModalTitle');
  if (ttl) ttl.textContent = sale ? 'Receive payment' : 'Record payment';
  $('payLoadSummary').innerHTML = l.amount == null
    // A load with no priced items has nothing to settle against. Say so
    // plainly rather than showing "0.00 pending", which reads as "nothing
    // owed" when it actually means "we don't know yet".
    ? `${sale ? 'Sale' : 'Load'} ${esc(l.id)}${esc(who)}<br><span style="color:var(--status-warning);">This ${sale ? 'sale' : 'load'} has no price yet, so there is no balance to work against.</span>`
    // ── A SALE TAKES MONEY IN, SO IT SAYS SO ─────────────────────────────
    // Apsara, 2026-09-15: "In add sales ,there should be receive payment na
    // instead of pay". This list merges purchases and sales, and every word
    // here was written for a purchase — "Pay", "Load total", "already paid".
    // On a row she SOLD, that describes money leaving for material she is
    // being paid for.
    //
    // The ledger was already right: helpers/spendReport.js marks load_kind
    // 'sale' as direction 'in' and labels it "Sale". Only the words she reads
    // were backwards, which is the version that looks considered.
    // ── THE TOTAL THIS BALANCE IS MEASURED AGAINST ───────────────────────
    // `p.pending` comes from the server, which measures a purchase against
    // net_payable (helpers/loads.js's payableOf). So on a load with haulage
    // deducted, printing "Load total $2,459 · paid $0 · $2,259 outstanding"
    // would put two figures side by side that do not subtract — and the one
    // she would query is the one that is right. The deduction gets its own
    // clause instead, and only when there is one.
    : `${sale ? 'Sale' : 'Load'} ${esc(l.id)}${esc(who)}<br>${sale ? 'Sale' : 'Load'} total ${payMoney(l.amount)}${
        !sale && Number(l.trucking_amount) > 0 ? ` · less trucking ${payMoney(l.trucking_amount)}` : ''
      } · already ${sale ? 'received' : 'paid'} ${payMoney(p.paid)} · <strong>${payMoney(p.pending)} outstanding</strong>`;
  // ── THE MODES THIS ROW ACCEPTS ───────────────────────────────────────
  // A sale takes Cash or Bank transfer (her rule for receive payment); a
  // purchase keeps the full list, because paying a supplier by Zelle is
  // money going the other way and she does it constantly. Rebuilt on every
  // open, so switching from a sale row to a purchase row cannot leave the
  // previous row's options behind.
  //
  // Kept in step with helpers/payments.js's modesForKind, which is what the
  // SERVER enforces — a dropdown is a suggestion, and the yard assistant
  // records payments through the same validator.
  // Kept in step with helpers/payments.js's modesForKind, which is what the
  // server enforces. A sale receives money: Cash or Bank transfer, her rule of
  // 2026-09-16. A purchase pays a supplier: Cash, Zelle, Wire or Cheque —
  // Apsara, 2026-09-17, "in load of invoice pay-remove bank transfer", because
  // on that side it was a second name for Wire.
  // Kept in step with helpers/payments.js's modesForKind — the server is
  // what validates, and a list here it does not accept is a save that
  // fails after she has typed everything. Sale widened 2026-09-23 on her
  // instruction; the purchase list is untouched.
  const payModes = sale ? ['Cash', 'Bank transfer', 'Zelle', 'Cheque'] : ['Cash', 'Zelle', 'Wire', 'Cheque'];
  $('pay_mode').innerHTML = payModes.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  // A default that EXISTS in the list. Zelle was being selected on a list
  // that no longer had it, which is the bug this line is now written against.
  // ── THE DEFAULT MODE, AND WHY A SALE IS NOT ZELLE ────────────────────
  // This line read `payModes.includes('Zelle') ? 'Zelle' : 'Cash'`, written
  // when only a PURCHASE had Zelle — so a sale fell through to Cash by
  // accident rather than by decision. Widening receive payment on 2026-09-23
  // put Zelle on a sale too, which would silently have made every receive
  // payment open on Zelle.
  //
  // Nothing about receiving money changed, so nothing about its default
  // should: a sale still opens on Cash. Stated rather than inherited, so the
  // next change to either list cannot move it again by accident.
  $('pay_mode').value = (!sale && payModes.includes('Zelle')) ? 'Zelle' : 'Cash';
  paintBankOptions($('pay_bank'));
  $('pay_bank_other').value = '';
  // Cleared on every open, or the company she chose on the LAST payment is
  // pre-answered on this one — the failure mode a remembered dropdown always
  // has, and here it would file a transfer against the wrong company.
  if ($('pay_via')) $('pay_via').value = '';
  // ── WHICH CASH, SHOWN ONLY WHEN THE MODE IS CASH ────────────────────────
  // Rebuilt on every open from the server's list, so a bucket added later
  // needs no change here. Unassigned is offered: cash she has never banked is
  // a real pot to spend from, and forcing a bank on it would put money
  // against an account it never came out of.
  {
    const wrap = $('pay_cash_source_row');
    const sel = $('pay_cash_source');
    if (sel) {
      // FALLBACK ONLY — used when the server list has not arrived. It mirrors
      // helpers/pettyCash.SOURCES and tests/petty-cash-banks.js asserts the
      // two are identical, because a stale fallback here would quietly offer
      // 'BofA' as if it were still the only BofA account and she would file
      // Edge Metals' cash into the unsplit bucket without noticing.
      const srcs = (pettyCash.sources || []).length ? pettyCash.sources
        : ['Edge Metals', 'AAA Investment', 'Chase Bank', 'Unassigned'];
      const held = (x) => Number((pettyCash.by_source || {})[x]) || 0;
      const withAmount = (x) => `${x}${(pettyCash.by_source || {})[x] != null ? ` — ${fmtAmount(held(x))}` : ''}`;
      // Unbanked cash has no bank, so it stands as its own top-level choice
      // rather than being hidden under one it never came from.
      const bankFor = (a) => (pettyCash.bank_of || {})[a] || a;
      const bankSel = $('pay_cash_bank');
      const label = $('pay_cash_source_label');

      // ── FOUR ZEROS WITH NO EXPLANATION WAS THE BUG ────────────────────
      // Apsara, 2026-09-29: "it has every thing as 0.Bofa ,chase,AAA,
      // unassigned as 0". Decided on the TOTAL across accounts, not on the
      // selected one: a single empty bucket is ordinary and the borrow
      // prompt already covers it. Every bucket empty means the box has
      // never been floated, which is a different situation and a different
      // sentence.
      //
      // by_source missing entirely is NOT treated as empty — that is the
      // server list not having arrived, and claiming "there is no cash"
      // while the figures are still loading would be a lie that clears
      // itself a second later, which is the worst kind.
      //
      // ── AND THE CASE THAT WAS ACTUALLY HAPPENING ──────────────────────
      // Apsara, 2026-10-01: "Also check why it was all showiung 0 when i
      // have available petty cash". She has cash. So "the box is empty" was
      // the WRONG explanation, and a note saying so would have been a
      // falsehood printed on the screen — worse than the four zeros it
      // replaced.
      //
      // What is really happening: her rows are filed under a cash_source the
      // four-bucket scheme does not recognise — 'BofA', from before it was
      // split into Edge Metals and AAA Investment. balanceBySource KEEPS
      // that key and counts it (see helpers/pettyCash.js), and
      // petty.balance() includes it, so the money is right there in the
      // response. This picker builds its list from SOURCES and reads held()
      // for those four names only, so her money is in the payload and the
      // dropdown steps over it.
      //
      // It is not selectable either, and that is the part no dropdown change
      // can fix: withdrawForPayment calls cleanSource, which THROWS for any
      // name outside SOURCES. Offering 'BofA' here would turn four silent
      // zeros into an error after she pressed Pay. The only supported fix is
      // scripts/migrate-bofa-to-edge-metals.js, which renames those rows —
      // and that is hers to run, because it asserts none of that money was
      // AAA Investment's.
      //
      // So the screen's job is to say WHICH of the two situations she is in,
      // and name the money it can see but cannot spend.
      {
        const note = $('pay_cash_empty');
        if (note) {
          // by_source absent is the server list not having arrived. Claiming
          // anything then is a lie that clears itself a second later.
          const known = pettyCash.by_source && typeof pettyCash.by_source === 'object';
          const listed = known ? srcs.reduce((t, a) => t + held(a), 0) : null;
          // Every row in the box, including sources this picker cannot name.
          const whole = Number(pettyCash.balance) || 0;
          // The buckets holding money that is not on the list.
          const stranded = known
            ? Object.keys(pettyCash.by_source)
                .filter((k) => !srcs.includes(k) && (Number(pettyCash.by_source[k]) || 0) > 0)
            : [];

          // ── WHAT IS WAITING TO BE ASSIGNED ─────────────────────────
          // Apsara, 2026-10-01: "as of now put it n unassigned.ask the user
          // to assign it correctly later". Since sourceOf folds an
          // unrecognised name into Unassigned, that money is now spendable
          // from this very dropdown — so the old "cannot pay from" sentence
          // is no longer true and has gone. What remains is the ASK: say how
          // much of Unassigned came out of a bank nobody has named yet, so
          // she can put it right when she has a minute. Information, not a
          // warning: she can pay today either way.
          const pending = Number((pettyCash.pending_assignment || {}).total) || 0;
          const pendingNames = Object.keys((pettyCash.pending_assignment || {}).names || {});

          let msg = '';
          if (known && listed === 0 && stranded.length) {
            // Kept as a safety net, not an expected path: with folding there
            // should be no bucket outside the list holding money. If one ever
            // appears again, saying so beats showing zeros.
            msg = `Your cash is filed under <strong>${stranded.map(esc).join('</strong>, <strong>')}</strong>`
                + ` — ${fmtAmount(stranded.reduce((t, k) => t + (Number(pettyCash.by_source[k]) || 0), 0))}`
                + ` — which this list cannot pay from, so every account above reads zero.`
                + ` It is not lost. Move it to a named account on the <strong>Petty cash</strong> tab,`
                + ` or pay by another mode for now.`;
          } else if (known && pending > 0) {
            msg = `${fmtAmount(pending)} of Unassigned came from`
                + ` <strong>${pendingNames.map(esc).join('</strong>, <strong>')}</strong>`
                + ` and has no account against it yet. You can pay from it now;`
                + ` assign it to the right bank on the <strong>Petty cash</strong> tab when you have a minute.`;
          } else if (known && listed === 0 && whole === 0) {
            msg = 'There is no cash recorded in any account yet, so a cash payment has nothing to draw on.'
                + ' Add your opening float on the <strong>Petty cash</strong> tab first — or pay by another mode.';
          }
          note.innerHTML = msg;
          note.classList.toggle('hidden', !msg);
        }
      }

      // ── THE ACCOUNTS UNDER ONE BANK ───────────────────────────────────
      // Called on open and whenever the bank changes. It ALWAYS leaves
      // pay_cash_source holding a real account, including when the bank has
      // only one — the submit path reads that value and a hidden select
      // holding nothing would post an empty cash_source, which is how the
      // pay modal broke in September when a <select> was set to a value not
      // in its own list.
      const fillAccounts = (bank) => {
        const under = srcs.filter((a) => bankFor(a) === bank);
        sel.innerHTML = under.map((x) => `<option value="${esc(x)}">${esc(withAmount(x))}</option>`).join('');
        const best = under.slice().sort((a, b) => held(b) - held(a))[0];
        sel.value = best || under[0] || '';
        // One account under a bank is not a question. The select stays in the
        // DOM holding the answer; only the row is hidden.
        const only = under.length < 2;
        sel.style.display = only ? 'none' : '';
        if (label) label.style.display = only ? 'none' : '';
      };

      // ── THE GROUPING IS THE SERVER'S KNOWLEDGE, NOT A GUESS ───────────
      // Apsara, 2026-10-14, with two screenshots: before visiting Petty cash
      // the modal showed ONE dropdown reading "Which bank — Edge Metals
      // $0.00"; after, it showed "Which bank — BofA $70,126.61" and "Which
      // account — Edge Metals $48,916.07".
      //
      // Not just missing figures — the WRONG QUESTION. bankFor() falls back
      // to the account's own name when bank_of has not arrived, so each of
      // the four fallback ACCOUNTS became its own "bank", and fillAccounts
      // then found exactly one account under it and HID the account row. The
      // label said Which bank over a list of accounts.
      //
      // Fetching (openPayModal) fixes the figures but this still renders for
      // the moment before the answer lands, and a mislabelled question is
      // worse than a blank one. So while the grouping is unknown, the bank
      // row is not shown at all and the ACCOUNT list — which is genuinely
      // what the fallback holds — is what she is asked.
      //
      // pay_cash_source still holds a real account value throughout, because
      // the submit path reads it and a select holding nothing posts an empty
      // cash_source. That is how the pay modal broke in September.
      const grouped = !!(pettyCash.bank_of && Object.keys(pettyCash.bank_of).length);
      if (bankSel && !grouped) {
        const bankRow = bankSel.previousElementSibling;     // its <label>
        bankSel.style.display = 'none';
        if (bankRow && bankRow.tagName === 'LABEL') bankRow.style.display = 'none';
        sel.innerHTML = srcs.map((x) => `<option value="${esc(x)}">${esc(withAmount(x))}</option>`).join('');
        sel.value = srcs[0] || '';
        sel.style.display = '';
        if (label) { label.style.display = ''; label.textContent = 'Which account'; }
      } else if (bankSel) {
        const bankRow = bankSel.previousElementSibling;
        bankSel.style.display = '';
        if (bankRow && bankRow.tagName === 'LABEL') bankRow.style.display = '';
        const banks = srcs.map(bankFor).filter((b, i, all) => all.indexOf(b) === i);
        bankSel.innerHTML = banks.map((b) => {
          const total = srcs.filter((a) => bankFor(a) === b).reduce((t, a) => t + held(a), 0);
          return `<option value="${esc(b)}">${esc(b)} — ${esc(fmtAmount(total))}</option>`;
        }).join('');
        // Defaults to the bank holding the most, so the common case needs no
        // thought and the borrow prompt stays rare — the same rule the single
        // dropdown used, one level up.
        const bestBank = banks.slice().sort((a, b) =>
          srcs.filter((x) => bankFor(x) === b).reduce((t, x) => t + held(x), 0)
          - srcs.filter((x) => bankFor(x) === a).reduce((t, x) => t + held(x), 0))[0];
        bankSel.value = bestBank || banks[0];
        bankSel.onchange = () => fillAccounts(bankSel.value);
        fillAccounts(bankSel.value);
      } else {
        fillAccounts(bankFor(srcs[0]));
      }
    }
    // Visibility is syncBankFields' job — it runs on open AND on every mode
    // change, so leaving it there means one rule in one place.
    if (wrap && sale) wrap.style.display = 'none';
  }
  // What this modal is for, on the element itself — see syncBankFields.
  if ($('pay_via_row')) $('pay_via_row').dataset.kind = payingLoad.kind;
  syncBankFields('pay');
  // Repainted when it lands. Not awaited: the modal opens immediately with
  // the banks we already have, and a late arrival only ever ADDS options.
  loadBankOptions().then(() => { paintBankOptions($('pay_bank')); syncBankFields('pay'); });
  $('pay_date').value = toUsDate(todayLocalDateStr()); wireUsDateField('pay_date');
  // Pre-filled with what is actually outstanding, since settling the balance
  // is the common case — still fully editable for a part payment.
  $('pay_amount').value = (p.pending != null && p.pending > 0) ? p.pending : '';
  $('pay_ref').value = '';
  $('payErr').textContent = '';
  renderPayHistory();
  updatePayPreview();

  // ── HISTORY ONLY: EVERYTHING BUT THE LIST GOES AWAY ───────────────────
  // Hiding the entry fields by walking the modal body rather than by naming
  // each one. This form has grown a bank row, a cash-source row, a paid-via
  // row and a preview over three weeks, and a list of ids written here would
  // be one short the next time a field is added — leaving a half-form under
  // a heading that says the load is settled.
  //
  // The three that stay are the summary (what load this is), the history
  // (the payments and their ✕) and the error line.
  {
    const body = $('payModal') && $('payModal').querySelector('.modal-body');
    const keep = new Set(['payLoadSummary', 'payHistory', 'payErr']);
    if (body) {
      Array.from(body.children).forEach((el) => {
        const mine = el.id && keep.has(el.id);
        const holdsErr = !el.id && el.querySelector && el.querySelector('#payErr');
        el.style.display = (historyOnly && !mine && !holdsErr) ? 'none' : '';
      });
    }
    // Save is meaningless with no form above it, and Cancel becomes Close.
    if ($('btnSavePay')) $('btnSavePay').style.display = historyOnly ? 'none' : '';
    if ($('btnCancelPay')) $('btnCancelPay').textContent = historyOnly ? 'Close' : 'Cancel';
    if (ttl && historyOnly) ttl.textContent = sale ? 'Payments received' : 'Payments made';
  }
  // ── WHAT THIS SUPPLIER IS ALREADY HOLDING ────────────────────────────
  // Fired, not awaited. The modal must open at once: she pressed Pay to
  // record a payment, and making that wait on a second request would make a
  // working button feel broken whenever the network is slow. The box starts
  // hidden and appears only if there is credit, so the common case — no
  // prepayments — looks exactly as it did before this feature existed.
  refreshPrepayCredit();

  $('payModal').classList.remove('hidden');
}

// ── PREPAID CREDIT IN THE PAY MODAL ────────────────────────────────────────
// Apsara: "Add a supplier prepayment option in loads" / "streamline the
// process" / "Build prepayment properly". See the markup for why this lives
// in the modal she already opens rather than on a tab of its own.
async function refreshPrepayCredit() {
  const box = $('payPrepayBox');
  const creditRow = $('payPrepayAsCreditRow');
  if (!box || !creditRow) return;
  const sale = payingLoad && payingLoad.kind === 'sale';
  const seller = (payingLoad && payingLoad.seller) || '';

  // A prepayment is money going OUT to a supplier. On a sale this whole idea
  // is the wrong way round, and offering it would invite recording a
  // customer's money as supplier credit.
  if (sale || !seller) {
    box.classList.add('hidden');
    creditRow.classList.add('hidden');
    return;
  }

  // The checkbox does not depend on the request: holding money as credit is
  // offered whether or not any exists yet, because the first prepayment for
  // a supplier has to start somewhere.
  creditRow.classList.remove('hidden');
  const lbl = $('payAsPrepaymentLabel');
  if (lbl) lbl.textContent = `Hold as prepayment — credit ${seller}, not this load`;

  try {
    const c = await api('/api/prepayments/credit?seller=' + encodeURIComponent(seller));
    const avail = Number(c && c.available) || 0;
    // Guard against a slow answer for a supplier she has already navigated
    // away from: by the time this lands she may have closed the modal and
    // opened another row, and writing that row's panel with this row's
    // figures is a wrong number on screen next to a Pay button.
    if (!payingLoad || payingLoad.seller !== seller) return;
    if (avail <= 0) {
      box.classList.add('hidden');
      return;
    }
    payPrepayCredit = c;
    const pending = Number((payingLoad.payment || {}).pending);
    // Offer the SMALLER of what the credit has and what the load still owes,
    // so one click cannot turn a settled load into an overpayment with money
    // meant for another load. The server refuses over-applying outright; this
    // is so she never meets that refusal.
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
    // Never costs her the Pay modal. Credit she cannot see is a missing
    // convenience; a modal that fails to open is a payment she cannot record.
    console.error('[prepay] could not read supplier credit:', e.message);
    box.classList.add('hidden');
  }
}

let payPrepayCredit = null;

function closePayModal() { $('payModal').classList.add('hidden'); payingLoad = null; }

// Says what this payment will leave outstanding, before it is recorded.
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

// ── WHO MAY UNWIND AN EDGE METALS LEDGER ENTRY ──────────────────────────
// Apsara, 2026-09-16, asked which types the Jarvis profile should own:
// the Edge Metals ledgers too. So a supplier bill payment, a customer sales
// receipt, a sale-cost settlement and a metals trucking payment are all
// Jarvis-only — an admin keeps the yard loads, where a wrong figure is an
// everyday correction.
//
// The reason the line sits here and not at some amount: deleting one of
// these does not just remove a row. A bill payment moves a supplier's
// running account and reopens containers; a receipt moves a customer's
// balance. Those are the books this business is judged on.
//
// UI GUARD, NOT SECURITY. The four routes are requireSuper server-side;
// this stops a button being offered that the server would refuse.
function metalsCanDelete() {
  return IS_SUPER === true;
}

// ── ARM, THEN CONFIRM — ONE IMPLEMENTATION ──────────────────────────────
// #182. Two buttons delete a supplier payment: one on the Payments tab
// (.spDel) and one in the pay history inside the Pay sheet (.bpDel). Same
// route, same consequence, written on different days — and they had already
// drifted:
//
//   Payments tab   "Reopens 2 containers — sure?"
//   pay history    "Delete — reopens 2 containers?"
//
// Two different sentences for the same irreversible action, which is how a
// later change to one of them silently fails to reach the other. The wording
// now comes from here. I picked the pay-history phrasing, which keeps the word
// Delete visible in the armed state: someone who looks away and back can still
// tell what pressing it does. That choice was mine, not Apsara's.
//
// What legitimately differs between the two stays an argument: the colour
// source (the Pay sheet runs in the ledger's own palette), where an error is
// shown, and what to reload afterwards.
function armThenConfirm({ selector, danger, label = 'Delete', onConfirm, onError }) {
  const all = () => document.querySelectorAll(selector);
  const disarm = (b) => {
    b.textContent = label;
    b.style.background = 'none';
    b.style.color = danger;
  };
  let armed = null;
  all().forEach((btn) => {
    btn.onclick = async () => {
      if (armed !== btn) {
        all().forEach(disarm);
        armed = btn;
        // The count is the point: an advance against nothing is a typo, an
        // applied payment reopens containers that currently read as settled.
        // One button, two very different consequences.
        const n = Number(btn.dataset.containers || 0);
        btn.textContent = n ? `${label} — reopens ${n} container${n === 1 ? '' : 's'}?`
                            : `${label} — sure?`;
        btn.style.background = danger;
        btn.style.color = '#FFFFFF';
        // Disarms itself, so a button left armed on a screen she walked away
        // from is not a live delete waiting for a stray click.
        setTimeout(() => { if (armed === btn) { armed = null; disarm(btn); } }, 5000);
        return;
      }
      armed = null;
      btn.disabled = true;
      btn.textContent = 'Deleting…';
      try {
        await onConfirm(btn);
      } catch (e) {
        btn.disabled = false;
        disarm(btn);
        onError(btn, e);
      }
    };
  });
}

// ── EDIT A RECORDED PAYMENT, WITH THE CONSEQUENCES SHOWN FIRST ──────────
// Apsara, 2026-10-06, asked for "option to edit" alongside recording the
// payment of trucker / commission / freight, and on 2026-10-07, asked what an
// edit should do about what a payment had already settled: "Recompute
// everything, show me before saving." So this asks the server to COMPUTE the
// edit without doing it, shows what moves, and only writes when she presses
// the second button.
//
// ── WHY ONE FUNCTION AND NOT THREE COPIES ──────────────────────────────
// Four tabs now edit a payment: supplier payments, trucking, and commission
// and freight (which share one store). The conversation is identical on all
// of them — the same two-step, the same refusal, the same sentences — and
// #182 is open precisely because the two supplier-payment DELETE buttons were
// written twice and drifted. What differs between the four is data, not
// behaviour, so the differences are arguments.
//
// This is deliberately a CLIENT helper and not a shared server helper. Three
// routes call three different store helpers with three different 404 strings;
// a shared route factory would be the "requirement added to shared code" that
// CLAUDE.md rule 1 is written about. Here, every caller is a button on a
// screen I can see, and tests/payment-edit.js exercises all four.
//
// Amount only, for now. Re-allocating across several containers belongs in the
// Pay sheet where the picker already lives; a second allocation editor here
// would be two places to get the same arithmetic wrong.
// ── WHY THE CALLER PASSES TWO CLOSURES AND NOT A BASE PATH ──────────────
// The first version took `base` and built `${base}/${id}/preview-edit` here.
// check-route-reach.js promptly reported all three PUTs as "a permission that
// exists and cannot be used": it reads string literals out of each api() call,
// and a path assembled from a variable has no literal to read. That is the
// same mistake as registering the routes in a loop, made one file over — and
// #166 is open because thirteen routes are already invisible to that guard.
// So each screen keeps its own endpoint in plain sight, and this function
// keeps the conversation. The repo's tooling reads source, so source is what
// has to be readable.
async function editPaymentFlow({ btn, preview, save, id, row, noun, elsewhere, reload }) {
  if (!row || !id) return;
  const label = btn.textContent;
  const restore = () => { btn.disabled = false; btn.textContent = label; };

  // ── WHY THIS REFUSES A SPLIT PAYMENT ─────────────────────────────────
  // Changing the amount alone is only meaningful when there is ONE thing to
  // change it against. A payment split three ways has no single right answer
  // for where $2,000 comes off, and the server correctly refuses an amount
  // that no longer matches its allocations ("allocations come to $5000.00 but
  // the payment is $3000.00") — which the end-to-end test found by trying
  // exactly that, after this screen had shipped sending amount alone. Picking
  // a split here would be inventing her allocations.
  const allocs = (row.allocations || []);
  if (allocs.length > 1) {
    alert(`This payment covers ${allocs.length} ${noun}, so changing the amount means `
        + `deciding how much comes off each one.\n\nDo that from ${elsewhere}, where the `
        + `list is — or delete this payment and record it again.`);
    return;
  }

  const typed = prompt(`Amount for this payment (now ${ledMoney(row.amount)}):`, String(row.amount));
  if (typed === null) return;                            // she changed her mind
  const value = Number(String(typed).replace(/[$,\s]/g, ''));
  if (!isFinite(value) || value <= 0) { alert('That is not an amount.'); return; }

  // The single allocation follows the amount. Unambiguous, because there is
  // only one place it can go. SPREAD rather than naming the key: a trucking
  // allocation identifies a bill, a sale cost identifies a sale AND a charge,
  // and copying the whole row keeps both correct. Each store's own
  // cleanAllocations rebuilds from the fields it recognises, so extras are
  // dropped rather than trusted.
  const patch = allocs.length === 1
    ? { amount: value, allocations: [{ ...allocs[0], amount: value }] }
    : { amount: value };

  btn.disabled = true; btn.textContent = 'Checking…';
  let plan = null;
  try {
    const r = await preview(JSON.stringify(patch));
    plan = r.plan;
  } catch (e) {
    restore();
    // The server's sentence, not a code — it already says whether this is a
    // bank it does not know, or a payment QuickBooks is holding.
    alert(String((e && e.message) || e));
    return;
  }
  if (!plan || !plan.before || !plan.after) { restore(); alert('The server sent no plan back.'); return; }

  // ── WHAT SHE IS ABOUT TO DO, IN HER TERMS ────────────────────────────
  const lines = (plan.changes || []).map((c) => {
    const what = c.container_no || c.bill_id || c.sale_id || c.invoice_no || '';
    if (c.effect === 'reopens') return `  ${what} REOPENS — it will owe money again`;
    if (c.effect === 'becomes settled') return `  ${what} becomes settled`;
    if (c.effect === 'unchanged') return `  ${what} unchanged`;
    return `  ${what}: paid ${ledMoney(c.paid_before)} → ${ledMoney(c.paid_after)}`;
  });
  const ok = confirm(
    `Change this payment from ${ledMoney(plan.before.amount)} to ${ledMoney(plan.after.amount)}?\n\n`
    + (lines.length ? lines.join('\n') + '\n\n' : '')
    + (plan.reopens ? `${plan.reopens} ${noun.replace(/s$/, '')}(s) will owe money again.\n\n` : '')
    + 'The original is kept, and this is written to the audit log.');
  if (!ok) { restore(); return; }

  btn.textContent = 'Saving…';
  try {
    await save(JSON.stringify(patch));
    await reload();
  } catch (e) {
    restore();
    alert(String((e && e.message) || e));
  }
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
        <span style="color:var(--text-muted);">${esc(fmtDate(r.paid_on))}</span>
        <span>${esc(r.mode)}${r.bank ? ' · ' + esc(r.bank) : ''}</span>
        ${r.reference ? `<span style="color:var(--text-faint);">${esc(r.reference)}</span>` : ''}
        <span style="flex:1;"></span>
        <span style="font-weight:700;">${payMoney(r.amount)}</span>
        ${payCanDelete() ? `<button class="btn btn-danger btn-del-pay" data-id="${esc(r.id)}" data-mode="${esc(r.mode || '')}" data-amount="${esc(payMoney(r.amount))}" style="font-size:10px; padding:3px 8px;">✕</button>` : ''}
      </div>`).join('')}`;
}

// ── which of Delete / Pay a load still deserves ───────────────────────────
// Per Apsara 2026-09-01: "delete should not be there for partial and full
// payment ... once full payment is done - remove pay option."
//
// Both read the SERVER's payment summary (GET /api/loads attaches `payment`
// from helpers/payments.paymentSummary) rather than recomputing paid/pending
// here. One place owns the arithmetic; a card cannot disagree with a ticket
// about whether something is settled.
//
// THESE ARE UI GUARDS, NOT SECURITY. DELETE /api/loads/:id and
// POST /api/payments both still work exactly as before — hiding a button is
// the right way to stop a mistake, removing a route is a breaking API change.
//
// Escape hatch, by design: remove the PAYMENT first and the load becomes
// deletable again. Money is unwound before the record it was booked against.
//
// Mirrors mobile-app/www/index.html exactly — tests/load-card-actions.js
// asserts both clients.
function loadIsDeletable(l) {
  // The Jarvis profile deletes regardless — Apsara 2026-09-03, "delete option
  // enabled even after payments". The payments go with the load and any cash
  // among them is returned to petty cash, and the server writes an audit row
  // naming the load, the seller, the amount and every payment before the
  // record stops existing.
  if (IS_SUPER) return true;
  const p = l && l.payment;
  return !(p && Number(p.paid) > 0);
}

// Payable while anything is outstanding. Two edge cases:
//   - `overpaid` — already more than settled, so no Pay. Correcting an
//     overpayment means removing the wrong payment, not adding another.
//   - `paid_amount_unknown` — a load with no priced items has no total to
//     settle against, so "is it fully paid" has no answer. Pay stays, since
//     hiding it would strand a real load with no way to record money.
function loadIsPayable(l) {
  const p = l && l.payment;
  if (!p) return true;
  return p.status !== 'paid' && p.status !== 'overpaid';
}

