// mobile-app/www/app/04-payments.js — split from mobile-app/www/index.html's <script> (helpers/sourceParts.js reconstructs the original)
// ── Payments (mirrors dashboard/index.html) ────────────────────────────────
// Same helper, same wording, same rules. The website copy is the reference;
// if these two ever disagree about what "part paid" means, the number on a
// phone and the number on a laptop stop matching for the same load.
// ── which of Delete / Pay a load still deserves ───────────────────────────
// Per Apsara 2026-09-01: "delete should not be there for partial and full
// payment ... once full payment is done - remove pay option."
//
// Both read the SERVER's payment summary (GET /api/loads attaches
// `payment` from helpers/payments.paymentSummary) rather than recomputing
// paid/pending here. One place owns the arithmetic; a card cannot disagree
// with a ticket about whether something is settled.
//
// THESE ARE UI GUARDS, NOT SECURITY. DELETE /api/loads/:id and
// POST /api/payments both still work exactly as before — deliberately.
// Hiding a button is the right way to stop a mistake; removing a route is a
// breaking API change, and the server is also what the yard assistant and
// the tests talk to.
//
// The escape hatch is intentional and worth knowing: delete the PAYMENT
// first (the Pay sheet lists them, each with its own remove), and the load
// becomes deletable again. Money entered against a load has to be
// unwound before the load itself can go — which is the correct order anyway.
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

// Payable while anything is outstanding. Note the two edge cases:
//   - `overpaid` — already MORE than settled, so no Pay. If she needs to
//     correct an overpayment the fix is removing the wrong payment, not
//     adding another.
//   - `paid_amount_unknown` — a load with no priced items has no total to
//     settle against, so "is it fully paid" has no answer. Pay stays, since
//     hiding it would strand a real load with no way to record money
//     against it.
function loadIsPayable(l) {
  const p = l && l.payment;
  if (!p) return true;
  return p.status !== 'paid' && p.status !== 'overpaid';
}

// ── the signature is frozen once it has been paid against ─────────────────
// Per Apsara 2026-09-02: "once payment initiated, signed-resign should not be
// there."
//
// WHY THIS IS THE RE-SIGN AND NOT THE SIGN
// ----------------------------------------
// POST /api/loads/:id/signature does two things: it overwrites
// seller_signature, and it then calls generateAndStoreLoadPdfs, which REBUILDS
// the ticket and the POS receipt. So re-signing a load that has already been
// paid rewrites the very document that justified the payment — the old ticket
// is gone, and nothing records that it changed. That is the hole worth
// closing, and it is the one she named ("signed-resign", which is the label
// this button wears only when a signature already exists).
//
// The FIRST signature is deliberately still allowed on a paid load. Payment by
// bank transfer routinely lands before the seller is back at the yard with a
// pen, and blocking it there would leave a real load permanently unsignable
// with no way out but deleting the payment. Adding a missing signature is not
// the same act as replacing one.
//
// Escape hatch, same shape as Delete: remove the payment and the button
// returns. Deliberate — changing a paid ticket should cost a step.
//
// UI GUARD, NOT SECURITY: the endpoint is unchanged. If a signature genuinely
// has to be corrected after payment, that is still possible; it just is not a
// thing anyone does by tapping the wrong card.
function loadIsResignable(l) {
  // Lifted for the Jarvis profile — Apsara 2026-09-03. Worth being clear what
  // this one costs: re-signing regenerates the ticket and the POS receipt, so
  // the document that justified the payment is replaced and the original is
  // gone. The audit row keeps the previous signing timestamp, which is the
  // only part of the old ticket that survives.
  if (IS_SUPER) return true;
  const p = l && l.payment;
  return !(p && Number(p.paid) > 0);
}

// The button is offered when it would either capture a first signature, or
// legitimately replace an existing one.
// ── is this load signed? ──────────────────────────────────────────────────
// The list response stopped carrying the signature IMAGE on 2026-09-03. It
// was 4.4 MB of a 4.5 MB /api/loads payload — a base64 PNG per signed load —
// and nothing here ever drew it; every use was this question. The server now
// answers it directly with `seller_signed`.
//
// BOTH FIELDS ARE ACCEPTED, and that is not belt-and-braces. This app is
// installed before the VM is updated, every time — so a new APK spends a
// while talking to a server that still sends the old shape. Reading only
// `seller_signed` would make every signed load in the yard read as unsigned
// during exactly that window.
function loadIsSigned(l) {
  if (!l) return false;
  return l.seller_signed != null ? !!l.seller_signed : !!l.seller_signature;
}

function loadIsSignable(l) {
  if (!loadIsSigned(l)) return true;   // never signed — always offer
  return loadIsResignable(l);
}

function paymentBadgeHtml(l) {
  const p = l && l.payment;
  if (!p || !p.paid) return '';
  // Shows WHEN, not just how much — per Apsara 2026-08-29 ("record payment
  // date as well"). The date was already captured, stored, listed in the Pay
  // form's history and printed on the ticket; the load card was the one place
  // it never reached, which is the place she actually looks while working.
  //
  // The LAST payment's date, since with instalments "when did this last move"
  // is the useful fact — the full sequence is in the Pay form.
  //
  // Parsed by splitting the string rather than new Date('2026-08-22'), which
  // JavaScript reads as UTC midnight and then renders in local time: west of
  // Greenwich that prints the day BEFORE. A payment dated the 22nd showing as
  // the 21st on a ticket is exactly the sort of small wrongness nobody
  // notices until it matters.
  const payDate = (ymd) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    if (!m) return '';
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
  };
  const rows = (p.payments || []).filter((r) => r && r.paid_on);
  const lastOn = rows.length ? payDate(rows[rows.length - 1].paid_on) : '';
  const on = lastOn ? ` · ${lastOn}` : '';

  // Uses payMoney rather than a local formatter of its own.
  //
  // This badge had its OWN copy that did not add the $, which is how it ended
  // up printing "PART PAID 12,000.00" after every other amount on the screen
  // had one. Worse, my patch for that targeted a variable name this function
  // no longer used — the two hosts had been aligned in between and the local
  // was renamed — so it silently changed nothing, and the test I wrote checked
  // fmtAmount and payMoney without ever rendering the badge. Deleting the
  // duplicate is the fix; there is now one money formatter in the payments UI
  // and nothing to keep in step.
  const money = payMoney;

  // ── THE WAY BACK INTO A SETTLED LOAD (2026-09-23) ──────────────────────
  // Apsara: "say i have unknowingly made some payment..Full paid.if i want to
  // reverse that?" — and there was no way to. loadIsPayable hides Pay once a
  // load reads paid or overpaid, Pay is the only caller of openPayModal, and
  // the payment history with its ✕ lives INSIDE that modal. So the route
  // worked, the button existed, and the screen holding it was unreachable.
  //
  // Asked how to open that door, she chose: "Make the paid badge open only on
  // jarvis profile.if i delete the payment-payment should reverse".
  //
  // JARVIS PROFILE ONLY, so IS_SUPER and not ROLE — an admin may still remove
  // one payment of several from a load that is still owing (payCanDelete,
  // unchanged), but unwinding a load that already reads SETTLED is hers.
  //
  // UI GUARD, NOT SECURITY, the same as payCanDelete: the ✕ inside posts to
  // DELETE /api/payments/:id, which is requireAdmin on the server whatever
  // this function decides.
  const settled = p.status === 'paid' || p.status === 'overpaid';
  const openable = settled && IS_SUPER;
  // Built as whole attributes rather than by splicing quotes into the class
  // list — a first version closed the class attribute inside this variable
  // and emitted class="pay-badge pay-full"" on the path that is NOT openable.
  const badge = (cls, text) => (openable
    ? `<span class="pay-badge ${cls} pay-badge-open" data-open-payments="${esc(l.id)}"`
      + ` data-kind="${esc(l._kind || 'purchase')}" title="Open the payments on this load"`
      + ` style="cursor:pointer; text-decoration:underline dotted;">${text}</span>`
    : `<span class="pay-badge ${cls}">${text}</span>`);
  if (p.status === 'paid') {
    return badge('pay-full', `PAID ${money(p.paid)}${on}`);
  }
  if (p.status === 'overpaid') {
    return badge('pay-over', `OVERPAID by ${money(p.over)}${on}`);
  }
  if (p.status === 'paid_amount_unknown') {
    return `<span class="pay-badge pay-part">PAID ${money(p.paid)}${on} · load has no price yet</span>`;
  }
  return `<span class="pay-badge pay-part">PART PAID ${money(p.paid)}${on} · ${money(p.pending)} pending</span>`;
}

let payingLoad = null;
// Same rule as fmtAmount — every amount on screen carries its $.
const payMoney = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── THE BANK ON A ZELLE OR A WIRE ────────────────────────────────────────
// Apsara, 2026-09-09: "options like BofA, Chase Bank, Others. when they select
// others a text box should appear in mobile app and website."
//
// The list comes from the SERVER (GET /api/payments returns it) rather than
// being written out here and again on the website. Two hardcoded copies drift,
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
// Investment, Chase is Edge Yard's, and anything unrecognised is not narrowed.
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


// opts.historyOnly marks the NEW shape, never the old — called with nothing
// this is exactly the modal it has always been. Only the paid-badge path
// passes it, and only the Jarvis profile can reach that path.
function openPayModal(loadId, kind, opts) {
  const historyOnly = !!(opts && opts.historyOnly);
  const l = loadsCache.find(x => x.id === loadId);
  if (!l) return;
  // ── THE CASH FIGURES HAVE TO BE FETCHED, NOT ASSUMED ─────────────────
  // Apsara, 2026-10-14, on going straight to Loads and pressing Pay: every
  // bucket $0.00, and right after visiting Petty cash the same modal is
  // correct. Nothing was stale — pettyCash had never been loaded, because
  // only renderPettyCashTab fetches it and this modal never asked.
  //
  // NOT AWAITED: the modal opens at once and the figures drop in when they
  // arrive. She is on a phone at a weighbridge and asked for this to be
  // fast. refreshPettyCash keeps the last known figure on a failure, so a
  // bad signal leaves what was there rather than zeroing it.
  if (pettyCash.by_source === null && typeof refreshPettyCash === 'function') {
    refreshPettyCash().then(() => {
      // Only if this modal is still open — a fetch landing after she has
      // closed it and opened another row must not redraw that one.
      const m = $('payModal');
      if (m && !m.classList.contains('hidden')) syncBankFields('pay');
    }).catch(() => {});
  }
  // `amount` here is what the OVERPAYMENT check subtracts against, so it has
  // to be the payable, not the metal's figure — otherwise a load with $200
  // deducted would accept a $200 overpayment without a word. The sale branch
  // is untouched: a sale has no net_payable, so ?? falls through to l.amount.
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
    // she would query is the one that is right.
    : `${sale ? 'Sale' : 'Load'} ${esc(l.id)}${esc(who)}<br>${sale ? 'Sale' : 'Load'} total ${payMoney(l.amount)}${
        !sale && Number(l.trucking_amount) > 0 ? ` · less trucking ${payMoney(l.trucking_amount)}` : ''
      } · already ${sale ? 'received' : 'paid'} ${payMoney(p.paid)} · <strong>${payMoney(p.pending)} outstanding</strong>`;
  // The modes THIS ROW accepts — see the note in dashboard/index.html's
  // openPayModal. A sale takes Cash or Bank transfer; a purchase keeps the
  // full list, because paying a supplier by Zelle is money going the other
  // way. Rebuilt on every open so a sale row cannot leave its shorter list
  // behind on the next purchase.
  // Cleared on every open, or the company chosen on the LAST payment is
  // pre-answered on this one.
  if ($('pay_via')) $('pay_via').value = '';
  // Rebuilt on every open from the server's list, so a bucket added later
  // needs no change here. Unassigned is offered: cash never banked is a real
  // pot to spend from, and forcing a bank on it would put money against an
  // account it never came out of. Defaults to the fullest bucket, so the
  // common case needs no thought and the borrow prompt stays rare.
  {
    // Apsara, 2026-09-22: "when pay via cash,option of chase/bofa .when
    // bofa-->Edge metals ac or aaa investments should be asked". Bank first,
    // account inside it. pay_cash_source keeps its id and still holds the
    // ACCOUNT, so the submit path is untouched. Mirrors dashboard/index.html.
    const sel = $('pay_cash_source');
    if (sel) {
      const srcs = (pettyCash.sources || []).length ? pettyCash.sources
        : ['Edge Metals', 'AAA Investment', 'Chase Bank', 'Unassigned'];
      const held = (x) => Number((pettyCash.by_source || {})[x]) || 0;
      const withAmount = (x) => `${x}${(pettyCash.by_source || {})[x] != null ? ` — ${fmtAmount(held(x))}` : ''}`;
      const bankFor = (a) => (pettyCash.bank_of || {})[a] || a;
      const bankSel = $('pay_cash_bank');
      const label = $('pay_cash_source_label');

      // Twin of the website's block — see dashboard/index.html for the full
      // reasoning. Short version: Apsara 2026-10-01, "why it was all
      // showiung 0 when i have available petty cash". Her rows are filed
      // under a cash_source outside SOURCES ('BofA', pre-split), which
      // balanceBySource counts and this picker cannot name. So the screen
      // says WHICH situation she is in and names the money it can see but
      // cannot spend, instead of showing four zeros or claiming the box is
      // empty when it is not.
      {
        const note = $('pay_cash_empty');
        if (note) {
          const known = pettyCash.by_source && typeof pettyCash.by_source === 'object';
          const listed = known ? srcs.reduce((t, a) => t + held(a), 0) : null;
          const whole = Number(pettyCash.balance) || 0;
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
      // ALWAYS leaves pay_cash_source holding a real account, including when
      // the bank has only one. A hidden select holding nothing would post an
      // empty cash_source — how the pay modal broke in September.
      const fillAccounts = (bank) => {
        const under = srcs.filter((a) => bankFor(a) === bank);
        sel.innerHTML = under.map((x) => `<option value="${esc(x)}">${esc(withAmount(x))}</option>`).join('');
        const best = under.slice().sort((a, b) => held(b) - held(a))[0];
        sel.value = best || under[0] || '';
        const only = under.length < 2;
        sel.style.display = only ? 'none' : '';
        if (label) label.style.display = only ? 'none' : '';
      };
      // ── THE GROUPING IS THE SERVER'S KNOWLEDGE, NOT A GUESS ───────────
      // Apsara, 2026-10-14, with two screenshots: before visiting Petty cash
      // the modal showed ONE dropdown reading "Which bank - Edge Metals
      // $0.00"; after, "Which bank - BofA" and "Which account - Edge Metals".
      // Not just missing figures, the WRONG QUESTION: bankFor() falls back to
      // the account's own name when bank_of has not arrived, so each fallback
      // ACCOUNT became its own bank, fillAccounts found one account under it
      // and HID the account row. The label said Which bank over accounts.
      // While the grouping is unknown the bank row is not shown at all, and
      // she is asked for the ACCOUNT, which is what the fallback really is.
      // pay_cash_source keeps a real value throughout: the submit path reads
      // it, and a select holding nothing posts an empty cash_source.
      const grouped = !!(pettyCash.bank_of && Object.keys(pettyCash.bank_of).length);
      if (bankSel && !grouped) {
        const bankLbl = bankSel.previousElementSibling;
        bankSel.style.display = 'none';
        if (bankLbl && bankLbl.tagName === 'LABEL') bankLbl.style.display = 'none';
        sel.innerHTML = srcs.map((x) => `<option value="${esc(x)}">${esc(withAmount(x))}</option>`).join('');
        sel.value = srcs[0] || '';
        sel.style.display = '';
        if (label) { label.style.display = ''; label.textContent = 'Which account'; }
      } else if (bankSel) {
        const bankLbl = bankSel.previousElementSibling;
        bankSel.style.display = '';
        if (bankLbl && bankLbl.tagName === 'LABEL') bankLbl.style.display = '';
        const banks = srcs.map(bankFor).filter((b, i, all) => all.indexOf(b) === i);
        const bankTotal = (b) => srcs.filter((x) => bankFor(x) === b).reduce((t, x) => t + held(x), 0);
        bankSel.innerHTML = banks.map((b) =>
          `<option value="${esc(b)}">${esc(b)} — ${esc(fmtAmount(bankTotal(b)))}</option>`).join('');
        bankSel.value = banks.slice().sort((a, b) => bankTotal(b) - bankTotal(a))[0] || banks[0];
        bankSel.onchange = () => fillAccounts(bankSel.value);
        fillAccounts(bankSel.value);
      } else {
        fillAccounts(bankFor(srcs[0]));
      }
    }
  }
  if ($('pay_via_row')) $('pay_via_row').dataset.kind = payingLoad.kind;
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
  // A default that exists in the list: selecting 'Zelle' on a list without it
  // leaves the select at "", and an untouched dropdown then posts no mode.
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
  syncBankFields('pay');
  loadBankOptions().then(() => { paintBankOptions($('pay_bank')); syncBankFields('pay'); });
  $('pay_date').value = toUsDate(todayLocalDateStr());
  wireUsDateField('pay_date');
  // Pre-filled with what is actually outstanding, since settling the balance
  // is the common case — still fully editable for a part payment.
  $('pay_amount').value = (p.pending != null && p.pending > 0) ? p.pending : '';
  $('pay_ref').value = '';
  $('payErr').textContent = '';
  renderPayHistory();
  updatePayPreview();
  // ── HISTORY ONLY: EVERYTHING BUT THE LIST GOES AWAY ─────────────────
  // Walked rather than listed by id: this form has grown a bank row, a
  // cash-source row, a paid-via row and a preview, and a list written here
  // would be one short the next time a field is added — leaving half a form
  // under a heading that says the load is settled.
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
    if ($('btnSavePay')) $('btnSavePay').style.display = historyOnly ? 'none' : '';
    if ($('btnCancelPay')) $('btnCancelPay').textContent = historyOnly ? 'Close' : 'Cancel';
  }
  // Fired, not awaited — the modal must open at once. Twin of the website's
  // refreshPrepayCredit; see dashboard/index.html for the reasoning.
  refreshPrepayCredit();

  $('payModal').classList.remove('hidden');
}
