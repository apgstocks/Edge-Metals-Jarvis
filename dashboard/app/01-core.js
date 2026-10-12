// dashboard/app/01-core.js — split from dashboard/index.html's <script> (helpers/sourceParts.js reconstructs the original)

// ── Dates are MM/DD/YYYY everywhere they are SHOWN ──────────────────────────
// Apsara, 2026-09-01: "wherever date applicable it should be mm/dd/yyyy only."
//
// Two separate jobs, deliberately kept apart:
//   fmtDate/toUsDate — what a PERSON sees. Always MM/DD/YYYY.
//   toIsoDate        — what goes over the WIRE and into storage. Always
//                      YYYY-MM-DD, because that is what every API, sheet and
//                      saved record in this app already expects, and it is
//                      the only shape that sorts and compares correctly.
//
// Native <input type="date"> was replaced wherever it appeared: it renders in
// the browser/OS locale with no way to force a format, so the same screen
// could read 2026-09-01 on one machine and 01/09/2026 on another. Fine for a
// personal app; not for dates that land on invoices.
function toUsDate(d) {
  if (!d) return '';
  if (typeof d === 'string') {
    const iso = d.match(/^(\d{4})-(\d{2})-(\d{2})/);        // YYYY-MM-DD[...]
    if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(d.trim())) return d.trim(); // already right
  }
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  return `${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}/${dt.getFullYear()}`;
}

// Display helper for table cells and read-only text: formats when it can,
// and returns the ORIGINAL string when it cannot. Never blanks a value it
// does not recognise — a date it fails to parse is still information, and
// showing "—" in its place would look like missing data.
function fmtDate(v, fallback = '') {
  if (v === null || v === undefined || v === '') return fallback;
  return toUsDate(v) || String(v);
}

// MM/DD/YYYY (and forgiving variants) -> YYYY-MM-DD. Returns '' rather than
// guessing — a wrong date is worse than an empty one someone is asked to fix.
function toIsoDate(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (!m) return '';
  let [, mm, dd, yy] = m;
  if (yy.length === 2) yy = String(2000 + Number(yy));
  const mi = Number(mm), di = Number(dd);
  // Reject impossible dates rather than letting Date roll them over —
  // "13/45/2026" must not quietly become a day in the following year.
  if (mi < 1 || mi > 12 || di < 1 || di > 31) return '';
  return `${yy}-${String(mi).padStart(2, '0')}-${String(di).padStart(2, '0')}`;
}

// Tidies what was typed to MM/DD/YYYY on blur, so "9/1/26" settles as
// "09/01/2026" instead of being silently rejected later.
function wireUsDateField(id) {
  const el = typeof id === 'string' ? $(id) : id;
  if (!el || el.dataset.dpWired) return;
  el.dataset.dpWired = '1';

  // Tidies what was typed to MM/DD/YYYY on blur, so "9/1/26" settles as
  // "09/01/2026" instead of being silently rejected later.
  el.addEventListener('blur', () => {
    const iso = toIsoDate(el.value);
    if (!iso) return;
    const [y, m, d] = iso.split('-');
    el.value = `${m}/${d}/${y}`;
  });

  // ── the picker ──────────────────────────────────────────────────────────
  // Apsara, 2026-09-02: "date picker should be there wherever date used."
  //
  // Her two requirements pull against each other, which is why this is not
  // just <input type="date">:
  //   "wherever date applicable it should be mm/dd/yyyy only" (2026-09-01)
  //   "date picker should be there wherever date used"        (2026-09-02)
  //
  // A native date input renders in the DEVICE's locale with no way to force a
  // format. On a phone set to en-IN — which hers is, going by the timezone on
  // her commits — it shows DD/MM/YYYY, breaking the first rule. That is
  // exactly why the native inputs were replaced by text boxes, and replacing
  // them is what took the calendar away.
  //
  // So: the VISIBLE field stays text and stays MM/DD/YYYY, guaranteed on every
  // device. Beside it sits a real <input type="date">, invisible, that exists
  // only to open the platform calendar. Picking a day writes MM/DD/YYYY back
  // into the text box. Type it or tap it — both work, and both read the same.
  //
  // The wrapper is built HERE rather than in each screen's markup, so a date
  // field gets a picker by being wired, and no call site can forget one.
  const wrap = document.createElement('span');
  wrap.style.cssText = 'position:relative; display:block; width:100%;';
  el.parentNode.insertBefore(wrap, el);
  wrap.appendChild(el);
  el.style.paddingRight = '38px';           // room for the button

  const native = document.createElement('input');
  native.type = 'date';
  native.tabIndex = -1;
  native.setAttribute('aria-hidden', 'true');
  // Not display:none — a hidden input cannot be focused, and showPicker()
  // throws on one that is not rendered. Zero-size and transparent instead.
  native.style.cssText = 'position:absolute; right:8px; bottom:0; width:1px; height:1px; opacity:0; border:0; padding:0; pointer-events:none;';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Open the calendar');
  btn.textContent = '📅';
  btn.style.cssText = 'position:absolute; right:4px; top:50%; transform:translateY(-50%); '
    + 'background:transparent; border:0; padding:4px 6px; font-size:15px; line-height:1; cursor:pointer;';

  wrap.appendChild(native);
  wrap.appendChild(btn);

  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    // Seed the calendar with whatever the box already says, so it opens on
    // the month being looked at rather than today.
    native.value = toIsoDate(el.value) || '';
    // showPicker is the supported way and is what Android's WebView uses;
    // .click() is the fallback for anything that does not have it. Wrapped
    // because showPicker throws if it is not called from a user gesture —
    // which this is, but a future refactor could break that quietly.
    try {
      if (typeof native.showPicker === 'function') native.showPicker();
      else native.click();
    } catch (e) { native.click(); }
  });

  native.addEventListener('change', () => {
    if (!native.value) return;
    const [y, m, d] = native.value.split('-');
    el.value = `${m}/${d}/${y}`;
    // Tell whatever listens to the text box that it changed — the inventory
    // and report filters read it on their own events, and a picked date that
    // does not fire input/change would sit there looking applied and not be.
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

// ══════════════════════════════════════════════════════════════════════════
// Jarvis dashboard — plain HTML/vanilla JS, no build step, no framework.
// Rebuilt twice this pass: (1) to match the "Jarvis Ops" visual mockup, then
// (2) to restore functional depth from the real original dashboard that the
// first pass dropped — contact Verify/common-groups, booking edit + per-
// container management, task nudge types with auto-cancel conditions, and
// the Facts tab. Every fetch() call is checked against the live api.js.
// ══════════════════════════════════════════════════════════════════════════
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Registers dashboard/sw.js — a deliberately no-op passthrough worker, added
// ONLY because Chrome/Edge require a registered service worker (alongside
// the manifest + HTTPS) before showing the "Install Jarvis" icon in the
// address bar. See sw.js's own comment for why it does no caching. Silently
// no-ops in browsers without serviceWorker support (older Safari) and over
// plain HTTP (the API is simply undefined there) rather than throwing.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(e => console.warn('[PWA] service worker registration failed:', e.message));
}

// Two money rules on screen, matching helpers/pdf.js exactly so the form
// and the printed ticket never disagree (Apsara 2026-08-19).
//   fmtRate   — a per-unit price: min 2 decimals, never rounded, so
//               0.6 -> "0.60" but 0.175 stays "0.175". Rounding a rate
//               would change what the seller is paid per pound.
//   fmtAmount — a money total: exactly 2 decimals with thousands
//               separators, so 23768.789 -> "23,768.79".
function fmtRate(n) {
  if (n === null || n === undefined || n === '' || !isFinite(Number(n))) return '';
  const s = String(n);
  const d = s.includes('.') ? s.split('.')[1].length : 0;
  return d >= 2 ? s : Number(n).toFixed(2);
}
// Per Apsara 2026-08-29: "for amount in app/website, always use $ before."
//
// The $ lives HERE rather than at each call site, because it was already at
// SOME call sites and not others — five places prefixed it by hand and the
// rest did not, which is exactly how a screen ends up showing "8,822.00" next
// to "$8,822.00" for the same kind of figure. One function owns it now and
// the manual prefixes are gone.
//
// Still returns EMPTY for a null/blank amount, deliberately: a bare "$" in an
// empty cell reads as zero dollars when it actually means "no price yet".
//
// Safe for the one place that reads a formatted amount back
// (updateItemTotals) because that already strips non-numeric characters
// before parsing — checked, not assumed.
function fmtAmount(n) {
  if (n === null || n === undefined || n === '' || !isFinite(Number(n))) return '';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Mirrors helpers/loads.js's normalizeSellerPhone / mobile-app/www/index.html's
// identical helper — see its comment for the full "No LID for user" story.
function normalizeSellerPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

// Custom Yes/No confirm — per Apsara 2026-08-17 ("for summary instead of
// okay/cancel give yes/no option"). The browser's native confirm() can't
// relabel its buttons (always "OK"/"Cancel", browser-localized), so this
// builds a real modal styled to match the rest of the app and resolves
// true/false the same way confirm() would. Mirrors mobile-app/www/index.html's
// identical helper.
function askYesNo(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.innerHTML = `
      <div class="modal-shell" style="max-width:360px;">
        <div class="modal-stripe"></div>
        <div class="modal-body" style="padding:22px 24px 6px;">
          <div style="font-size:14px; color:var(--text-strong); line-height:1.5;">${esc(message)}</div>
        </div>
        <div class="modal-foot">
          <button class="btn" id="askYesNoNo">No</button>
          <button class="btn btn-primary" id="askYesNoYes">Yes</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const cleanup = (result) => { overlay.remove(); resolve(result); };
    overlay.querySelector('#askYesNoYes').addEventListener('click', () => cleanup(true));
    overlay.querySelector('#askYesNoNo').addEventListener('click', () => cleanup(false));
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) cleanup(false); });
  });
}
const normLoc = (s) => String(s ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
function localityMatchesPort(loc, port) {
  const l = normLoc(loc), p = normLoc(port);
  if (!l || !p) return false;
  return l.includes(p) || p.includes(l);
}
let ROLE = 'user';
// ── the Jarvis top-level profile ──────────────────────────────────────────
// Apsara 2026-09-03: "create another profile as jarvis with delete option
// enabled even after payments ... this is like top level profile."
//
// A Jarvis session's ROLE is 'admin' — deliberately, so every admin check in
// this file keeps working untouched — and this flag lifts the payment locks
// on top of that. Mirrors mobile-app/www/index.html; tests/jarvis-profile.js
// asserts both clients, because the last time a rule was added to one client
// and not the other it shipped broken to the one nobody tested.
//
// DECIDES WHICH BUTTONS ARE DRAWN, NOTHING MORE. The server re-checks the
// session on every route these buttons hit.
let IS_SUPER = false;
let CURRENT_TAB = 'board';
let waQrRefreshTimer = null; // re-renders the WhatsApp tab while a QR is pending — WA rotates the QR string every ~20-30s until scanned

// Grouped for the sidebar (Apsara 2026-08-15: "admin console is unstructured").
// Order within NAV_ITEMS now reflects display order — group by group, not
// insertion history. renderNav() below reads `group` to insert section
// headers and only shows a header if at least one item in it survives the
// role filter (e.g. a non-admin 'user' role never sees "System").
// ── ONE HEADING, NOT SIX ────────────────────────────────────────────────
// Apsara, 2026-09-15: "it looks too much headers", after two attempts of mine
// that missed. She was right and the count is the proof — the Expenses page
// stacked SIX heading-ish things before one expense appeared:
//
//   YARD  ·  // EXPENSES  ·  EXPENSE TRACKER  ·  the description line  ·
//   TODAY / ALL-TIME / ENTRIES  ·  2026-09-12
//
// and every one of them used the same small uppercase mono treatment, so none
// of them won and the eye had nowhere to rest. My first fix merged three of
// the six and kept the rest, which is why it still read the same.
//
// THE RULE: exactly one thing on a page looks like a heading. Everything else
// is data, or a quiet word underneath data.
//
//   · the "// Something" eyebrow is gone. The sidebar already says Yard >
//     Expenses and highlights it; saying it twice more is the clutter.
//   · the title is sentence case at 19px, the SAME WORD as the nav item, so
//     the eye confirms rather than re-reads.
//   · the description line becomes a chip, or nothing. It is read once and is
//     furniture forever after.
//   · figures go ABOVE their labels and get BIGGER, not smaller. An earlier
//     draft of this shrank them into a muted mono string; she runs the
//     business on those numbers.
//
// `stats` is [label, value] — value first on screen, label quietly beneath.
// `chips` are the short caveats that used to be a sentence ("admin only").
// `note` is the one-line description under the title. It was dropped in the
// first cut of this and she asked for it back — "let the descripton of header
// be there" — so it stays. What went is the EYEBROW above it and the ALL-CAPS
// title, which were the two that said nothing the nav item had not.
// The stat row on its own, so a screen whose figures change with a filter can
// redraw JUST them. Added 2026-09-16 for the Loads tab — see loadStatsHtml.
const STAT_LABEL_CSS = 'font-size:11.5px; color:var(--text-muted); margin-top:2px;';
function statRowHtml(stats) {
  return (stats || []).filter(Boolean)
    .map(([label, value]) => `<div><div style="font-size:20px; font-weight:600; color:var(--text-strong); line-height:1.1;">${value}</div><div style="${STAT_LABEL_CSS}">${esc(label)}</div></div>`)
    .join('');
}

function pageHead(title, { note = '', stats = [], chips = [], actions = '', statsId = '' } = {}) {
  const L = STAT_LABEL_CSS;
  return `
    <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:14px; flex-wrap:wrap; margin-bottom:16px;">
      <div style="min-width:0;">
        <h2 style="font-size:19px; font-weight:600; text-transform:none; letter-spacing:-.01em; margin:0;">${esc(title)}</h2>
        ${note ? `<div style="font-size:12.5px; color:var(--text-muted); margin-top:5px; max-width:60ch;">${note}</div>` : ''}
        ${stats.length ? `<div${statsId ? ` id="${statsId}"` : ''} style="display:flex; gap:22px; flex-wrap:wrap; margin-top:12px;">${statRowHtml(stats)}</div>` : ''}
      </div>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        ${chips.filter(Boolean).map((c) => `<span style="font-family:var(--font-mono); font-size:10px; color:var(--text-faint); border:1px solid var(--border-subtle); border-radius:var(--radius-xs); padding:3px 7px;">${esc(c)}</span>`).join('')}
        ${actions}
      </div>
    </div>`;
}

// ── GROUPED BY COMPANY, NOT BY JOB ──────────────────────────────────────
// Apsara, 2026-09-15: "dont mix yard and edge metals".
//
// It was mixed, and the old group names hid it. "Operations" carried Board,
// Bookings, Truckers, Suppliers and Documents — the freight side — AND Bills,
// Sales and Edge Inventory, which helpers/bills.js opens by calling "EDGE
// METALS, NOT EDGE YARD". One heading over two companies whose figures must
// never meet is the sidebar version of the mistake every store in this app is
// built to prevent.
//
// So the top level is now the COMPANY. The names say which, rather than
// leaving "Yard" and "Operations" to be interpreted.
//
// SPEND REPORT BELONGS TO NEITHER and is filed under its own heading, because
// helpers/spendReport.js totals loadTotal, expenseTotal and truckerTotal (the
// yard) alongside supplierTotal, saleCostTotal and metalsTruckingTotal (Edge
// Metals). Putting it under one company would state that it is that company's
// report, which is exactly the false claim this regrouping is removing.
const NAV_ITEMS = [
  // Scrap-yard side of the app — per Apsara 2026-08-16 ("Price lists also
  // move it under Yard"): split out of the old single "Operations" bucket,
  // matching the "Yard" terminology already established elsewhere (Yard
  // Report, Settings > Yard sub-tab, the mobile app's own Loads/Inventory
  // scope). 'contacts' is really the price-list send-to list (see
  // renderPriceContacts's "Price list contacts" page title) — relabeled
  // here for clarity since it now sits next to Loads/Inventory instead of
  // next to Email Contacts/WhatsApp, where "Contacts" alone was ambiguous.
  { id: 'loads',     label: 'Loads',       group: 'Edge Yard' },
  { id: 'inventory', label: 'Inventory',   group: 'Edge Yard' },
  // Petty cash — the physical cash box, per Apsara 2026-09-02. NOT adminOnly:
  // staff see the balance ("staff can see the balance, admin can top up"),
  // and the page renders read-only for them. The write routes are
  // requireAdmin server-side, so the boundary does not depend on this flag.
  { id: 'petty',     label: 'Petty Cash',  group: 'Edge Yard' },
  // Trucker bills — what the yard OWES its hauliers. Apsara 2026-09-03,
  // "a tab called trucker for everyone", so not adminOnly, and added to the
  // staff nav filter below to match.
  //
  // NAMED 'Trucker Bills', NOT 'Trucker', because this dashboard already has
  // a "Truckers" tab under Operations and it is a completely different thing:
  // a directory of hauliers and their WhatsApp groups, used to route booking
  // messages. Two tabs both called Trucker, one holding contacts and one
  // holding debts, is a mistake waiting for a hurried afternoon. The mobile
  // app has no roster, so there the tab is just "Trucker" as she asked.
  { id: 'trucker-bills', label: 'Trucker Bills', group: 'Edge Yard' },
  // ── EXPENSES ─────────────────────────────────────────────────────────
  // Apsara, 2026-09-15: "there is a expense tab in app but not website".
  // Correct, and it had been that way since the tab was built on 2026-08-19
  // — the website carried only a single "Expenses $X" figure inside the
  // Spend Report, so what was spent could be totalled at the desk and never
  // read. It is also why "check in expenses" had nowhere to go.
  //
  // adminOnly, matching the app's own gate and the server's: expenses are
  // money out, and staff keep Loads and the cash balance.
  { id: 'expenses', label: 'Expenses', group: 'Edge Yard', adminOnly: true },
  // Spend report — every figure the business pays out, both sides of it,
  // so adminOnly. Staff keep Loads and the cash balance.
  { id: 'spend',     label: 'Spend Report', group: 'Both companies', adminOnly: true },
  { id: 'contacts',  label: 'Price Lists', group: 'Edge Yard', adminOnly: true },
  // Outbound loads (sales to buyers, e.g. Eccomelt) — mirror of Loads
  // above, but a separate standalone page (dashboard/outbound-loads.html),
  // not an in-app tab — same reasoning/pattern as address-book/quote-requests
  // below. adminOnly: carries buyer pricing/margin, same call as Bot &
  // Automation/Contacts & Outreach's admin-only entries.
  { id: 'outbound-loads', label: 'Outbound Loads', group: 'Edge Yard', adminOnly: true },

  // Freight-forwarding/booking side of the app.
  { id: 'board',     label: 'Board',     group: 'Edge Metals' },
  { id: 'bookings',  label: 'Bookings',  group: 'Edge Metals' },
  // ── ONE HEADING, TWO SUB-TABS (2026-09-24) ────────────────────────────
  // Apsara: "can we combine truckers and suppliers into single heading
  // .Inside that make sub tab as truckers,suppliers?"
  //
  // Two sidebar rows became one. The screens themselves are unchanged — both
  // are still renderContacts with their own list, their own Add button and
  // their own wording; only the way in is shared. The sub-tab strip is the
  // same pattern Petty Cash already uses for Cash / Borrowing.
  //
  // 'truckers' and 'suppliers' STILL WORK as tab ids (see loadTab). Anything
  // that deep-links to one, or calls loadTab with it, lands on the combined
  // tab with the right sub-tab already open. Retiring the ids would have been
  // the tidier diff and a worse change.
  { id: 'partners',  label: 'Truckers & Suppliers', group: 'Edge Metals' },
  // Invoice/Proforma/Verification — added 2026-08-19 per Apsara ("i want
  // invoice,proforma,verification in separate tabs under documents").
  // Standalone page (dashboard/documents.html via the /documents route),
  // same pattern as address-book/quote-requests/outbound-loads. NOT
  // adminOnly — Apsara confirmed pricing-memory + doc generation should be
  // usable by her own staff-facing 'user' role too, not admin-only, same as
  // the rest of Operations here. The narrower 'staff' role (Loads-only)
  // still can't reach it — server-side denied by omission from
  // STAFF_ALLOWED_PATH_PREFIXES in api.js, this is just matching UX.
  { id: 'documents', label: 'Documents', group: 'Edge Metals' },
  // Apsara, 2026-09-09: "This is for edge metals not for edge yard. now i want
  // to build a bill tab ... In sales tab-i want customer name,date,invoice
  // number,HBL number..." — and, asked where they should go: "Both as new tabs
  // under Operations." What a container COST and what it SOLD for.
  //
  // NOT adminOnly, matching the rest of Operations — but the SERVER is the
  // real boundary, and /api/bills and /api/sales are deliberately absent from
  // STAFF_ALLOWED_PATH_PREFIXES, so the narrow 'staff' role gets a 403 on
  // both. This nav filtering is only so nobody sees a tab that would refuse
  // them; api.js carries the reasoning.
  { id: 'bills', label: 'Bills', group: 'Edge Metals' },

  // ── TWO NAV ENTRIES, TABS INSIDE ─────────────────────────────────────
  // This has been round the houses and the last word is hers, seeing it
  // deployed: "i want them to be tabs inside not separate option".
  //
  // The history, so nobody re-litigates it: they began as sub-tabs inside
  // Sales; she said "i told that i want sales to be in different tabs na" and
  // they became six nav entries; then she saw those six stacked in the
  // sidebar — Bills, Outgoing, Incoming, Freight, Commission, Trucking — and
  // six top-level entries for what is two subjects reads as clutter. She is
  // right both times: they DO need to be tabs, and they need to be tabs
  // INSIDE something rather than a second row of chrome under a name that
  // mentions none of them.
  //
  // So: two entries, each with its own strip.
  //   Bills  → Bills · Trucking
  //   Sales  → Outgoing · Incoming · Freight · Commission
  //
  // Trucking sits under BILLS rather than Sales because that is where its
  // data comes from — a haulage line IS a bill's trucking amount, derived
  // and never stored (see helpers/metalsTrucking.js). Filing it under Sales
  // would put it one subject away from the thing it is made of. Say the word
  // and it moves; the strip is one array.
  // Apsara, 2026-09-16: "change the sales in edge metals as invoice."
  //
  // THE LABEL ONLY. The id stays 'sales', and so do /api/sales, the stored
  // records, the 'sale'/'sale_cost' payment kinds and helpers/sales.js.
  // Renaming any of those would rewrite data to change a word on a screen,
  // and /api/sales is deliberately ABSENT from STAFF_ALLOWED_PATH_PREFIXES —
  // a renamed path would silently stop being blocked for staff.
  //
  // Edge YARD sales (outbound loads) keep the word Sales. Different company,
  // and she said Edge Metals.
  { id: 'sales', label: 'Invoice', group: 'Edge Metals' },
  // ── EDGE INVENTORY ───────────────────────────────────────────────────
  // Apsara, 2026-09-11: "WANT TO HAVE a separate tab called Edge inventory.
  // there i want to maintain per supplier basis. inventory items and accounts
  // for that supplier."
  //
  // A standalone page (dashboard/edge-inventory.html via /edge-inventory),
  // the same pattern as outbound-loads and documents — it is a per-supplier
  // drill-down, not a table, and it would not sit inside the Bills strip
  // without becoming the thing she has twice said she does not want: more
  // chrome under a name that mentions none of it.
  //
  // Under OPERATIONS, with Bills and Sales, because it is Edge Metals. The
  // yard's own inventory is Loads, in the Yard group, and they are different
  // companies. adminOnly: it shows supplier prices and a running account, so
  // the same call as Spend Report — and the server agrees by leaving
  // /api/edge-inventory out of STAFF_ALLOWED_PATH_PREFIXES.
  { id: 'edge-inventory', label: 'Edge Inventory', group: 'Edge Metals', adminOnly: true },

  // QuickBooks — one page for the whole integration, a party at a time
  // (dashboard/quickbooks.html via /quickbooks). Apsara, 2026-09-24: "i want
  // to have a separate page where i can view everything related to qb
  // especially these Supplier specific things". Not adminOnly — she asked for
  // everyone who has Jarvis to see it — but the page is read-only until the
  // padlock is opened, and the server refuses every change unless the session
  // is admin, so a staff login can look and not touch.
  { id: 'quickbooks', label: 'QuickBooks', group: 'Edge Metals' },
  // ── BOOKS ────────────────────────────────────────────────────────────
  // Apsara, 2026-10-06: "Make the qb thing as separate portal". A separate
  // page (/books, dashboard/books.html) for the same reason QuickBooks is
  // one: it is a different question. QuickBooks asks whether Intuit agrees
  // with us and needs a live connection; Books is derived from her own
  // records and works without one.
  //
  // ── 'Edge Metals', DIRECTLY UNDER QuickBooks — HER CALL ──────────────
  // Apsara, 2026-10-07: "Built it professionally.under quickbook tab",
  // after looking for it and not finding it.
  //
  // I had filed it under 'Both companies' because the portal switches
  // between Edge Metals, Edge Trading and AAA Investment, so it is not one
  // company's screen. That reasoning was right and the placement was still
  // wrong: 'Both companies' is a DIFFERENT heading further down the rail,
  // so someone looking beside QuickBooks does not see it. Where she looks
  // for it beats where it logically belongs.
  //
  // It sits immediately after the QuickBooks entry in this array, and the
  // group sort is stable, so the two are adjacent in the rail.
  { id: 'books', label: 'Books', group: 'Edge Metals' },

  // ── BANK ──────────────────────────────────────────────────────────────
  // Apsara, 2026-10-05: "Where is bank match in jarvis?" — it was nowhere.
  // /bank-match has existed since 3e03fc8 with the route mounted and the page
  // working, and NOTHING linked to it: the only way in was typing the URL.
  // A screen nobody can reach is a screen nobody uses, which is the same
  // fault scripts/check-dead-helpers.js exists to catch in code.
  //
  // adminOnly, unlike QuickBooks. She asked for the QuickBooks page to be
  // visible to everyone with a Jarvis login; this one lists raw bank lines
  // from her accounts, which is a narrower thing. Easy to open up if she
  // wants it wider — one flag.
  { id: 'bank', label: 'Bank', group: 'Edge Metals', adminOnly: true },
  { id: 'claims', label: 'Claims', group: 'Edge Metals' },

  // Jarvis (the bot) itself — behavior, memory, to-dos.
  { id: 'bot',       label: 'Bot',   group: 'Bot & Automation' },
  { id: 'facts',     label: 'Facts', group: 'Bot & Automation', adminOnly: true },
  { id: 'tasks',     label: 'Tasks', group: 'Bot & Automation' },
  // ── BUGZILLA ─────────────────────────────────────────────────────────
  // Apsara, 2026-09-24: "create a bugzilla tab in website so that we can keep
  // track of all the fixes so that we can revisit it."
  //
  // NOT adminOnly — she and anyone on a normal login can file and read; the
  // status buttons render for admin only, matching the server (POST is open,
  // PATCH is requireAdmin).
  //
  // STAFF DO NOT SEE IT, and that is the existing rule rather than a judgement
  // about staff: their nav is deliberately Edge Yard work and nothing else
  // (tests/page-headings.js holds it to one Edge Yard heading). Adding this
  // put a "Bot & Automation" heading in their sidebar. If she wants the yard
  // crew reporting bugs too, that is a small change to the staff filter and
  // that test — her call, not one to make sideways.
  { id: 'bugzilla',  label: 'Bugzilla', group: 'Bot & Automation' },

  // Who Jarvis talks to and how — channels, directories, inbound requests.
  { id: 'whatsapp',       label: 'WhatsApp',       group: 'Contacts & Outreach', adminOnly: true },
  { id: 'email-contacts', label: 'Email Contacts', group: 'Contacts & Outreach', adminOnly: true },
  { id: 'address-book',   label: 'Address Book',   group: 'Contacts & Outreach', adminOnly: true },
  // ── DESIGN (2026-09-16) ──────────────────────────────────────────────
  // Apsara: "make the fields drag and drop in website as Design menu then
  // under it BOL". A group of its own, with room for the proforma and the
  // invoice to join it later — those have the same per-customer problem.
  // Standalone page (dashboard/design-bol.html, served via /design/bol),
  // same pattern as Address Book above rather than an in-app tab: it is
  // configuration she visits occasionally, not a screen she works in.
  { id: 'design-bol',     label: 'BOL',            group: 'Design', adminOnly: true },
  // 2026-08-16 per Apsara ("Contact Quotes and Quote Requests... both are
  // same"): this ONE tab now shows trucker lane quotes AND contact quotes
  // together (dashboard/quote-requests.html fetches both /api/quote-requests
  // and /api/contact-quote-requests and renders one combined list). A
  // separate "Contact Quotes" nav entry used to exist here — removed, since
  // that page's content lives on this same one now.
  { id: 'quote-requests', label: 'Quote Requests', group: 'Contacts & Outreach', adminOnly: true },

  // Health — Apsara 2026-10-12: "Why there is no provision for USers,
  // incidents,crash report?" Crashes, restarts, device reports and job
  // state, all of which were already being collected and none of which
  // anything read (helpers/healthReport.js explains at length). adminOnly
  // because a stack trace names files and sometimes fragments of what was
  // being processed when it threw — same tier as WhatsApp and Facts.
  //
  // MUST STAY IN STEP with dashboard/sidebar.js: tests/sidebar-pages.js
  // compares the two lists row for row, and a standalone page registered in
  // only one of them appears on some screens and not others.
  { id: 'health',    label: 'Health',   group: 'System', adminOnly: true },
  // Apsara, 2026-10-12: AI usage, cost and what Jarvis did. Its own page (/ai-usage).
  { id: 'ai-usage',  label: 'AI usage', group: 'System', adminOnly: true },

  // App-wide configuration.
  { id: 'settings',  label: 'Settings', group: 'System', adminOnly: true },
];

// Accepts whatever an endpoint hands back and guarantees an array.
// Exists because `x || []` does NOT protect a .map call: an object is
// truthy, so a { loads: [...] } response sailed past the guard and threw
// "sales.map is not a function", blanking the entire Loads list the moment
// a sale existed. Shape mismatches between a client and an endpoint are a
// recurring class of bug here, and they should degrade to an empty list
// rather than to a blank screen.
function asArray(x) {
  if (Array.isArray(x)) return x;
  if (x && Array.isArray(x.loads)) return x.loads;
  return [];
}

// Pins an autocomplete menu directly under its input, in viewport
// coordinates, so it floats ABOVE the modal instead of being clipped inside
// the modal's scroll box. Flips above the input when there isn't room below,
// so a row near the bottom of the form still shows its suggestions on screen
// rather than off it — the whole complaint was having to scroll to see them.
function positionAcMenu(input, menu) {
  const r = input.getBoundingClientRect();
  menu.classList.add('ac-floating');
  menu.style.width = r.width + 'px';
  menu.style.left = r.left + 'px';
  // Measure only after width is applied, or the height is wrong for a list
  // that wraps differently at its real width.
  const spaceBelow = window.innerHeight - r.bottom - 8;
  const spaceAbove = r.top - 8;
  const h = Math.min(menu.scrollHeight, 260);
  if (spaceBelow < h && spaceAbove > spaceBelow) {
    menu.style.top = Math.max(8, r.top - Math.min(h, spaceAbove) - 4) + 'px';
    menu.style.maxHeight = Math.min(260, spaceAbove) + 'px';
  } else {
    menu.style.top = (r.bottom + 4) + 'px';
    menu.style.maxHeight = Math.min(260, Math.max(120, spaceBelow)) + 'px';
  }
}

// A fixed menu does not travel with its input, so it has to be re-pinned
// while the form scrolls behind it. Capture phase catches scrolling inside
// .modal-body, which does not bubble.
function trackAcMenu(input, menu) {
  const reposition = () => {
    if (menu.classList.contains('hidden')) return;
    if (!document.body.contains(input)) return;
    positionAcMenu(input, menu);
  };
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (res.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Carry the server's structured fields onto the Error. Endpoints return
    // machine-readable extras — `reason`/`currentHead` on a conflict, and as
    // of 2026-09-02 `code`/`available`/`requested` from petty cash so the Pay
    // form can offer "only $400 in the box — record that and leave $1,100
    // outstanding?". Flattening everything to a message string threw that
    // away and left the caller parsing English to decide what to do.
    //
    // Copies EVERY key except `error`, rather than naming them one at a time:
    // the previous version listed reason and currentHead explicitly, so petty
    // cash's fields would have been dropped and the prompt would never have
    // fired. A new route adding a field should not need this line changed.
    // Mirrors mobile-app/www/index.html.
    const e = new Error(data.error || `request failed (${res.status})`);
    e.status = res.status;
    for (const k of Object.keys(data || {})) { if (k !== 'error') e[k] = data[k]; }
    throw e;
  }
  return data;
}

// ── THE COLLAPSED RAIL'S INITIALS ARE GONE ──────────────────────────────────
// navInitialsFor() lived here and turned "Edge Inventory" into EI, lengthening
// keys until no two collided (Board BO, Bookings BOO). It was careful code for
// a feature that should not have existed: Apsara, 2026-09-19, looking at the
// result — "This is not hw i want collapsible to work."
//
// Collapsing hides the sidebar entirely now and the hamburger brings the FULL
// menu back, so there is nothing to abbreviate. Deleted rather than left
// unreferenced: a function nothing calls is a function someone re-wires.

// ── THE FOUR GROUPS THAT START CLOSED ───────────────────────────────────
// Ten items between them, none of them daily. They were sitting above the
// fold competing with Loads. The two COMPANY groups are never foldable: those
// are the work.
const FOLD_GROUPS = ['Design', 'Bot & Automation', 'Contacts & Outreach', 'System'];

// ── ICONS ───────────────────────────────────────────────────────────────
// Inline SVG rather than an icon font: a font is a network request and a
// flash of unstyled rail on a screen she opens all day, for 25 glyphs.
// stroke:currentColor so hover/active colour them with the label, and a
// missing id falls back to a dot rather than a gap — a new NAV_ITEMS entry
// should never be able to make a row look broken.
const NAV_ICONS = {
  loads:'M3 7h11v7H3z M14 9h4l2 3v2h-6z M6.5 16.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3 M17 16.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3',
  inventory:'M3 8l9-4 9 4-9 4z M3 8v8l9 4 9-4V8 M12 12v8',
  petty:'M3 7h18v10H3z M12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4 M12 16v-4',
  'trucker-bills':'M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z M9 8h6 M9 12h6',
  expenses:'M4 4h16v16H4z M8 9h8 M8 13h5',
  'price-lists':'M4 4h9l7 7-9 9-7-7z M8.5 8.5h.01',
  'outbound-loads':'M3 7h11v7H3z M14 9h4l2 3v2h-6z M6.5 16.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3 M17 16.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3 M20 4l-3 3 3 3',
  spend:'M4 19V9 M10 19V5 M16 19v-7 M21 19H3',
  board:'M4 4h16v16H4z M4 10h16 M10 10v10',
  bookings:'M4 5h16v15H4z M4 9h16 M8 3v4 M16 3v4',
  partners:'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M3 20a6 6 0 0 1 12 0 M17 11a3 3 0 1 0 0-6 M17 14a6 6 0 0 1 4 6',
  documents:'M6 3h8l4 4v14H6z M14 3v4h4 M9 12h6 M9 16h6',
  bills:'M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z M9 9h6 M9 13h4',
  invoice:'M6 3h12v18l-3-2-3 2-3-2-3 2z M9 8h6 M9 12h6 M9 16h3',
  'edge-inventory':'M3 8l9-4 9 4-9 4z M3 8v8l9 4 9-4V8',
  quickbooks:'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18 M9 9a3 3 0 0 1 3-3v12',
  claims:'M12 4v14 M6 8h12 M6 8l-3 6h6z M18 8l3 6h-6z M8 20h8',
  bank:'M3 10l9-5 9 5z M5 10v8 M9 10v8 M15 10v8 M19 10v8 M3 21h18',
  bot:'M7 8h10v9H7z M12 5v3 M12 3a1 1 0 1 0 0 2 M9.5 12h.01 M14.5 12h.01 M4 11v3 M20 11v3',
  facts:'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18 M12 8h.01 M11 12h1v5h1',
  tasks:'M4 6h3v3H4z M4 15h3v3H4z M10 7.5h10 M10 16.5h10',
  bugzilla:'M8 6a4 4 0 0 1 8 0 M6 10h12v4a6 6 0 0 1-12 0z M3 12h3 M18 12h3 M5 7l2 2 M19 7l-2 2 M5 17l2-2 M19 17l-2-2',
  whatsapp:'M12 21a9 9 0 1 0-7.8-4.5L3 21l4.5-1.2A9 9 0 0 0 12 21 M9 9c0 4 2 6 6 6',
  'email-contacts':'M3 6h18v12H3z M3 7l9 6 9-6',
  'address-book':'M6 3h13v18H6z M6 8H3 M6 12H3 M6 16H3 M12.5 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4 M9 16a3.5 3.5 0 0 1 7 0',
  'quote-requests':'M4 5h16v11H8l-4 4z M8 9h8 M8 12h5',
  'design-bol':'M4 4h16v16H4z M4 9h16 M9 9v11',
  health:'M3 12h4l2-5 3 10 2-5h7',
  settings:'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.5 19.4a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 13.7a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 7.5a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10.3 3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.5 2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
};
function navIcon(id) {
  const d = NAV_ICONS[id] || 'M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4';
  return `<svg class="nav-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}

// ── WHICH COMPANY THE RAIL IS SHOWING ───────────────────────────────────
// Remembered across reloads, because the answer is almost always "the same
// one as last time" — she works a stretch of yard or a stretch of metals,
// not alternate screens. localStorage can throw (private mode, a locked
// profile), so every touch is wrapped: a rail that fails to render because
// a preference could not be read would be a far worse bug than a forgotten
// preference.
const NAV_CO_KEY = 'jarvisNavCompany';
function navCompany() {
  try { const v = localStorage.getItem(NAV_CO_KEY); if (v === 'Edge Metals' || v === 'Edge Yard') return v; }
  catch (e) { /* unreadable storage is not a reason to have no sidebar */ }
  return 'Edge Yard';
}
// The switcher FOLLOWS the open tab rather than fighting it. openTab() can
// land on a Metals screen from a deep link, from Jarvis, or from a button on
// another page; hiding the row she is standing on would look like the app
// had lost the page.
function syncNavCompany() {
  const item = (typeof NAV_ITEMS !== 'undefined' ? NAV_ITEMS : []).find((n) => n.id === CURRENT_TAB);
  const co = (item && (item.group === 'Edge Yard' || item.group === 'Edge Metals'))
    ? item.group : navCompany();
  try { localStorage.setItem(NAV_CO_KEY, co); } catch (e) { /* best effort */ }
  const nav = $('sideNav');
  if (nav) { nav.classList.toggle('co-yard', co === 'Edge Yard'); nav.classList.toggle('co-metals', co === 'Edge Metals'); }
  document.querySelectorAll('.nav-co').forEach((b) => b.classList.toggle('active', b.dataset.co === co));
  // Staff never see a Metals screen, so the switcher is noise for them.
  const box = document.getElementById('navCompany');
  if (box) box.style.display = (ROLE === 'staff') ? 'none' : 'flex';
}

function renderNav() {
  const nav = $('sideNav');
  // Staff see Loads and Petty Cash only. The petty-cash entry was added
  // 2026-09-02 — without it here the tab exists but is filtered out for
  // exactly the role she asked to be able to see the balance, which is the
  // sort of half-applied change that looks like it shipped and did not.
  // 'trucker-bills' added to the staff list 2026-09-03 — "a tab called
  // trucker for everyone". '/api/trucker-bills' is on
  // STAFF_ALLOWED_PATH_PREFIXES to match, so this is UX rather than the
  // boundary. Paying is still admin-only, because /api/payments is
  // deliberately NOT on that allowlist.
  const visible = NAV_ITEMS.filter(n => (!n.adminOnly || ROLE === 'admin')
    && (ROLE !== 'staff' || n.id === 'loads' || n.id === 'petty' || n.id === 'trucker-bills'));
  // ── ORDERED BY GROUP, NOT BY POSITION ────────────────────────────────
  // A heading is emitted whenever the group CHANGES, so a group whose items
  // are not contiguous in NAV_ITEMS prints its heading twice. Regrouping by
  // company on 2026-09-15 made that real: Spend Report sits between Expenses
  // and Price Lists in the array, so "Edge Yard" would have appeared above
  // and below it.
  //
  // Sorted here rather than by shuffling NAV_ITEMS, because every entry in
  // that array carries a comment explaining why it is where it is, and moving
  // the entries would separate them from their reasons. Within a group the
  // original order is kept — sort() is stable — so nothing else moves.
  // 'Design' sits after the two companies and before the bot: it is a
  // settings-shaped group — how documents LOOK — and putting it above the
  // screens she uses every hour would push Loads down for no reason.
  const GROUP_ORDER = ['Edge Yard', 'Both companies', 'Edge Metals',
                       'Design', 'Bot & Automation', 'Contacts & Outreach', 'System'];
  const rank = (g) => { const i = GROUP_ORDER.indexOf(g); return i === -1 ? GROUP_ORDER.length : i; };
  visible.sort((a2, b2) => rank(a2.group) - rank(b2.group));
  // Worked out across the sorted, role-filtered list, so the rail is
  // unambiguous for whoever is actually looking at it.
  // ── WHICH UTILITY GROUPS START CLOSED ──────────────────────────────
  // All of them, EXCEPT one holding the tab she is on. Landing on Settings
  // from a deep link and finding the row hidden would read as a broken link
  // rather than as a collapsed group.
  const foldShut = new Set(FOLD_GROUPS.filter((g) =>
    !visible.some((x) => x.group === g && x.id === CURRENT_TAB)));
  let lastGroup = null;
  nav.innerHTML = visible.map(n => {
    // The four utility headings become the fold control. `shut` only when
    // nothing inside them is the current tab — landing on Settings from a
    // deep link must not hide the row you are standing on.
    const foldable = FOLD_GROUPS.includes(n.group);
    const cls = `nav-section-label${foldable ? ' nav-fold' + (foldShut.has(n.group) ? ' shut' : '') : ''}`;
    const header = n.group !== lastGroup
      ? `<div class="${cls}" data-co-group="${esc(n.group)}"${lastGroup === null ? '' : ' style="margin-top:14px;"'}>${esc(n.group)}</div>`
      : '';
    lastGroup = n.group;
    // Both the full label and the initials are always in the DOM; CSS shows
    // one or the other. Rebuilding the nav on collapse would be a second code
    // path that could disagree with this one about what is in the menu.
    // data-co-group is what the CSS filters on, and it is the GROUP rather
    // than a company so that "Both companies", Design, Bot and System are
    // simply never matched by either rule and stay on screen always.
    // nav-folded starts the four utility groups closed; nav-fold marks their
    // heading as the control.
    return `${header}<button class="nav-btn ${n.id === CURRENT_TAB ? 'active' : ''}${foldShut.has(n.group) ? ' nav-folded' : ''}" data-tab="${n.id}" data-co-group="${esc(n.group)}" title="${esc(n.label)}">${navIcon(n.id)}<span class="nav-label">${esc(n.label)}</span></button>`;
  }).join('');
  nav.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    // Address book is its own standalone page (dashboard/address-book.html,
    // served via the /address-book route), not an in-app tab — same session
    // gate applies (see api.js), it's just a real page nav, not a fetch.
    if (b.dataset.tab === 'address-book') { window.location.href = '/address-book'; return; }
    // Same standalone-page pattern as address-book above.
    if (b.dataset.tab === 'quote-requests') { window.location.href = '/quote-requests'; return; }
    if (b.dataset.tab === 'outbound-loads') { window.location.href = '/outbound-loads'; return; }
    if (b.dataset.tab === 'documents') { window.location.href = '/documents'; return; }
    if (b.dataset.tab === 'ai-usage') { window.location.href = '/ai-usage'; return; }
    if (b.dataset.tab === 'edge-inventory') { window.location.href = '/edge-inventory'; return; }
    if (b.dataset.tab === 'quickbooks') { window.location.href = '/quickbooks'; return; }
    if (b.dataset.tab === 'books') { window.location.href = '/books'; return; }
    if (b.dataset.tab === 'bank') { window.location.href = '/bank-match'; return; }
    if (b.dataset.tab === 'claims') { window.location.href = '/claims'; return; }
    if (b.dataset.tab === 'design-bol') { window.location.href = '/design/bol'; return; }
    if (b.dataset.tab === 'health') { window.location.href = '/health-report'; return; }
    switchTab(b.dataset.tab); closeMobileSidebar();
  }));

  // ── THE FOUR FOLDING HEADINGS ─────────────────────────────────────────
  // Toggling classes rather than re-rendering: renderNav() rebuilds
  // innerHTML, which would drop every listener attached above and leave a
  // rail of dead buttons.
  nav.querySelectorAll('.nav-section-label.nav-fold').forEach((h) => {
    h.addEventListener('click', () => {
      const shut = h.classList.toggle('shut');
      const grp = h.dataset.coGroup;
      nav.querySelectorAll(`.nav-btn[data-co-group="${grp}"]`)
         .forEach((b) => b.classList.toggle('nav-folded', shut));
    });
  });

  // The company switcher. Clicking it does NOT change the open tab — it
  // changes which list she is looking at, and she picks a screen from it.
  document.querySelectorAll('.nav-co').forEach((b) => {
    b.onclick = () => {
      try { localStorage.setItem(NAV_CO_KEY, b.dataset.co); } catch (e) { /* best effort */ }
      const co = b.dataset.co;
      nav.classList.toggle('co-yard', co === 'Edge Yard');
      nav.classList.toggle('co-metals', co === 'Edge Metals');
      document.querySelectorAll('.nav-co').forEach((x) => x.classList.toggle('active', x === b));
    };
  });

  syncNavCompany();
}

// ── The off-canvas sidebar — NOT phone-only any more ──────────────────────
// This said "phone widths only ... harmless no-ops on desktop since the
// classes have no visual effect there". That stopped being true on
// 2026-09-19, when collapsing on a desktop became the same off-canvas panel
// rather than a 54px rail of two-letter stubs. These handlers are now what
// opens and closes the menu at EVERY width, and a comment calling them
// no-ops is how load-bearing code gets deleted by someone tidying up.
function closeMobileSidebar() {
  $('sidebar').classList.remove('mobile-open');
  $('sidebarBackdrop').classList.remove('mobile-open');
  $('hamburgerBtn').classList.remove('open');
  $('hamburgerBtn').setAttribute('aria-expanded', 'false');
}
$('hamburgerBtn').addEventListener('click', () => {
  const open = $('sidebar').classList.toggle('mobile-open');
  $('sidebarBackdrop').classList.toggle('mobile-open', open);
  $('hamburgerBtn').classList.toggle('open', open);
  $('hamburgerBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
});
$('sidebarBackdrop').addEventListener('click', closeMobileSidebar);

// ── COLLAPSING THE SIDEBAR ─────────────────────────────────────────────────
// Apsara, 2026-09-16: "make the side bar collapsible".
//
// REMEMBERED, because it is a way of working rather than a one-off: someone
// who wants the room back wants it back tomorrow too. Same reasoning and the
// same defensive read as loadKindFilter — localStorage throws in some webviews
// and a failure there must cost nothing but the preference.
//
// Applied to <body> rather than to the sidebar, so the rule can reach the
// <main> beside it if that is ever wanted, and so one class is the whole of
// the state.
function setNavCollapsed(on, remember) {
  document.body.classList.toggle('nav-collapsed', on);
  // Expanding from INSIDE the open drawer: the sidebar returns to the normal
  // flow, so the drawer state has to come off with it or the backdrop is left
  // covering the page with nothing over it.
  if (!on && typeof closeMobileSidebar === 'function') closeMobileSidebar();
  const btn = $('btnNavCollapse');
  if (btn) {
    // The chevron points the way it will MOVE things, which is the convention
    // people already read without being told.
    btn.innerHTML = on ? '&#8250;' : '&#8249;';
    btn.setAttribute('aria-expanded', on ? 'false' : 'true');
    const words = on ? 'Expand the menu' : 'Collapse the menu';
    btn.setAttribute('aria-label', words);
    btn.title = words;
  }
  if (remember) { try { localStorage.setItem('navCollapsed', on ? '1' : '0'); } catch (e) {} }
}

if ($('btnNavCollapse')) {
  $('btnNavCollapse').addEventListener('click', () => {
    setNavCollapsed(!document.body.classList.contains('nav-collapsed'), true);
  });
}

// Restored before the first paint of the nav. Read defensively: a throw here
// would take the whole boot down for a saved preference.
try {
  if (localStorage.getItem('navCollapsed') === '1') setNavCollapsed(true, false);
} catch (e) { /* no preference, no problem */ }

function switchTab(tab) {
  CURRENT_TAB = tab;
  renderNav();
  loadTab(tab);
}

// ── "JARVIS, OPEN THE BILLS" ──────────────────────────────────────────────
// Apsara, 2026-09-20. The voice route answers with { open: { tab, sub, href } }
// (helpers/screens.js decides which screen, and refuses the other company's).
// A tab loads in place, then its sub-tab is clicked exactly as a person would
// — through the same button, so nothing here can disagree with the page about
// what that sub-tab shows. A standalone page is a real navigation.
window.jarvisOpenScreen = async function (open) {
  if (!open) return false;
  if (open.href) { window.location.href = open.href; return true; }
  if (!open.tab) return false;
  CURRENT_TAB = open.tab;
  renderNav();
  try { await loadTab(open.tab); } catch (e) { console.warn('[VOICE] open failed:', e.message); return false; }
  if (open.sub) {
    const btn = document.querySelector(`.metals-tab[data-section="${open.sub.section}"][data-tab="${open.sub.tab}"]`);
    if (btn) btn.click();
  }
  try { closeMobileSidebar(); } catch (e) { /* no sidebar on this layout */ }
  return true;
};

async function loadTab(tab) {
  const root = $('viewRoot');
  if (typeof stopCamera === 'function') stopCamera(); // navigating away must never leave the camera running
  if (tab !== 'whatsapp' && waQrRefreshTimer) { clearInterval(waQrRefreshTimer); waQrRefreshTimer = null; }
  root.innerHTML = '<div style="padding:60px; text-align:center; color:var(--text-faint); font-family:var(--font-mono); font-size:13px;">Loading…</div>';
  try {
    if (tab === 'board') return renderBoard(await api('/api/dashboard'));
    if (tab === 'bookings') return renderBookings(await api('/api/bookings'));
    // The two old ids are entry points into the combined tab, not screens of
    // their own any more — a link to #suppliers opens Truckers & Suppliers
    // with Suppliers showing.
    if (tab === 'truckers' || tab === 'suppliers') { partnersTab = tab; return renderPartners(); }
    if (tab === 'partners') return renderPartners();
    if (tab === 'whatsapp') return renderWhatsapp();
    if (tab === 'contacts') return renderPriceContacts();
    if (tab === 'email-contacts') return renderEmailContacts();
    if (tab === 'settings') return renderSettings(await api('/api/settings'));
    if (tab === 'bot') return renderBot();
    if (tab === 'tasks') return renderTasks(await api('/api/tasks'));
    if (tab === 'bugzilla') return renderBugzilla();
    if (tab === 'facts') return renderFacts(await api('/api/facts?include=all'));
    if (tab === 'bills') { metalsTab.bills = 'bills'; return renderLedgerTab('bills'); }
    // Arriving from the NAV always lands on the first tab of the section.
    // Remembering which sub-tab was last open is what made an earlier build
    // render Incoming when she clicked Outgoing.
    if (tab === 'sales') { metalsTab.sales = 'outgoing'; return renderLedgerTab('sales'); }
    if (tab === 'trucker-bills') return renderTruckerTab();
    if (tab === 'petty') return renderPettyCashTab();
    if (tab === 'expenses') return renderExpensesTab();
    if (tab === 'spend') return renderSpendReportTab();
    if (tab === 'loads') {
      // Purchases and sales in one deck — a sale she can't see is a sale she
      // can't delete, and deletion is what rolls inventory back. _kind tells
      // the card, the edit handler and the delete handler which store the
      // record lives in. Mirrors the app exactly.
      const [inbound, sales, drafts] = await Promise.all([
        api('/api/loads'),
        api('/api/outbound-loads').catch(() => []),
        // Unfinished loads, so "edited later" means from anywhere rather than
        // only from the tab they were started in. Fetched alongside rather
        // than merged INTO the deck: a draft is not a load, must not appear in
        // any total, and gets its own strip above the list.
        api('/api/load-drafts').catch(() => []),
      ]);
      pendingDrafts = asArray(drafts);
      return renderLoads([
        ...asArray(inbound).map(l => ({ ...l, _kind: 'purchase' })),
        // asArray: the endpoint returns a bare array, but a non-array here
        // must never blank the whole Loads list again. `|| []` did not
        // protect this — an OBJECT is truthy, so it passed the guard and
        // then died on .map.
        ...asArray(sales).map(l => ({ ...l, _kind: 'sale', seller: l.buyer, seller_address: l.buyer_address })),
      ].sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))));
    }
    // Deliberately NOT fetched anywhere during boot/init — loadTab() only
    // runs this when the Inventory nav button is actually clicked, same
    // lazy-per-tab pattern every tab above already uses. That's what
    // satisfies Apsara's "unless user specifically opens, it should not
    // open" — no special-casing needed, it falls out of this switch already
    // being on-demand.
    if (tab === 'inventory') return renderInventory();
  } catch (err) {
    root.innerHTML = `<div style="padding:60px; text-align:center; color:var(--status-danger); font-family:var(--font-mono); font-size:13px;">${esc(err.message)}</div>`;
  }
}

// ── INVENTORY ─────────────────────────────────────────────────────────────
// Item-type inventory across loads, computed live server-side (helpers/
// loads.js's getInventoryReport) every time this tab is opened or its date
// filter changes — never a running counter, so a deleted load's items just
// stop appearing on the very next fetch with zero extra bookkeeping. Per
// Apsara 2026-08-15.
//
// Split into small sub-tabs 2026-08-15 per Apsara ("small tabs like load
// summary, per day, per seller. by default by item type should appear") —
// previously all four views (count card, item-type table, seller list,
// per-day table) were stacked and always visible together; this switches
// between them instead, same underlying `data` object, no extra fetch.
// "Load summary" sub-tab removed 2026-08-15 per Apsara ("remove summary
// tab in inventory").
