// mobile-app/www/app/01-core.js — split from mobile-app/www/index.html's <script> (helpers/sourceParts.js reconstructs the original)

// ══════════════════════════════════════════════════════════════════════
// Edge Yard — standalone mobile app (Capacitor shell)
//
// This is the SAME Loads tab code that lives in dashboard/index.html,
// extracted so yard staff get a dedicated installable app instead of the
// full multi-tab Jarvis dashboard. Everything below marked "lifted
// verbatim" is copy-pasted unchanged from that file — if you fix a bug in
// one, fix it in both (or better: next refactor, share this as one file
// both builds import).
//
// The one thing that's NOT the same as the dashboard: authentication.
// The dashboard runs in the same browser tab as the API (same origin), so
// its session cookie (SameSite=Strict) just works. This app's WebView is a
// different origin than wherever the API is deployed, and SameSite=Strict
// cookies are never sent cross-origin — that's what Strict means. So this
// app logs in the same way (POST /login with a password), but instead of
// relying on the cookie it also gets back the raw session id in the JSON
// response body and sends that back itself as "Authorization: Bearer
// <sid>" on every request. See api.js's /login route and session-gate
// middleware for the server side of this — same sessions Map, same TTL,
// same roles, just a second way to carry the same session id. Nothing
// about the desktop dashboard's cookie auth changed.
// ══════════════════════════════════════════════════════════════════════

// ── API base URL — EDIT THIS once the backend is actually deployed (see
// config.js in the mobile-app project root for the single source of
// truth; this constant just reads it). Left as a placeholder because the
// Jarvis VM deployment is still pending as of this build. ──────────────
// ── Server address ────────────────────────────────────────────────────────
// Resolved at RUNTIME, not baked in at build time. Added 2026-08-24 while
// preparing a Play Store release, because the address this app talks to is a
// randomly-generated *.trycloudflare.com hostname tied to one cloudflared
// process — config.js says so itself: reboot the VM or restart the tunnel and
// you get a DIFFERENT URL.
//
// Sideloading, that costs a rebuild and a reinstall. Through a store it would
// brick every installed copy until a new build cleared review — days, caused
// by a VM reboot. An app whose backend address can rotate must not have that
// address compiled into it.
//
// Order: what she last saved on this device, else the bundled config.js, else
// the emulator default. localStorage wins so a rotation is a retype on the
// login screen rather than a release.
const DEFAULT_API_BASE = (window.JARVIS_CONFIG && window.JARVIS_CONFIG.API_BASE) || 'http://10.0.2.2:4000';
function storedApiBase() {
  try { return localStorage.getItem('jarvis_api_base') || ''; } catch (e) { return ''; }
}
function setStoredApiBase(url) {
  try {
    const clean = String(url || '').trim().replace(/\/+$/, '');
    if (clean) localStorage.setItem('jarvis_api_base', clean);
    else localStorage.removeItem('jarvis_api_base');
  } catch (e) { /* private mode — falls back to the bundled default */ }
}
// `let`, and read through a getter everywhere, so changing it takes effect
// without a reload.
let API_BASE = storedApiBase() || DEFAULT_API_BASE;

const TOKEN_KEY = 'jarvis_sid';
function getToken() { return localStorage.getItem(TOKEN_KEY); }
function setToken(t) { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }

let ROLE = 'user';
// ── the Jarvis top-level profile ──────────────────────────────────────────
// Apsara 2026-09-03: "create another profile as jarvis with delete option
// enabled even after payments ... this is like top level profile."
//
// A Jarvis session's ROLE is 'admin' — deliberately, so every one of the
// admin checks in this file keeps working without being touched — and this
// flag is what lifts the four payment locks on top of that.
//
// IT DECIDES WHICH BUTTONS ARE DRAWN, NOTHING MORE. Setting it by hand in the
// console gets you a Delete button and a 403 when you press it: the server
// re-checks the session on every one of these routes and does not consult
// anything the client sends.
let IS_SUPER = false;

// ── Lifted verbatim from dashboard/index.html ───────────────────────────
const $ = (id) => document.getElementById(id);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

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
// ── PORTED FROM dashboard/index.html, 2026-09-02 ─────────────────────────
// The MM/DD/YYYY work landed on the website only; the app still had native
// <input type="date"> everywhere, which renders in the DEVICE locale — so
// the same load read 09/02/2026 on the laptop and 02/09/2026 on the phone.
// Byte-identical to the website copy so tests/form-parity.js can hold the
// two in step.
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

function fmtAmount(n) {
  if (n === null || n === undefined || n === '' || !isFinite(Number(n))) return '';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Mirrors helpers/loads.js's normalizeSellerPhone — added 2026-08-17 after
// a production "No LID for user" failure traced to a seller phone typed
// the natural local way (no country code), stored as bare 10 digits,
// which isn't a resolvable WhatsApp ID at all. helpers/loads.js already
// fixes this for whatever ends up on the LOAD record, but this same raw
// value also gets sent straight to the Address Book auto-create/backfill
// call below — normalizing it HERE, once, up front, means both
// destinations get the same corrected number instead of the load having
// the fixed version and the address book keeping the broken one.
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
// true/false the same way confirm() would. Built dynamically rather than
// as static markup so it's a drop-in replacement usable anywhere without
// needing its own permanent DOM nodes/ids — reuses the existing
// .modal-overlay/.modal-shell/.modal-body/.modal-foot classes so it looks
// identical to every other dialog in the app.
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
    // Clicking the dimmed backdrop itself (not the dialog) counts as "No" —
    // same escape-hatch behavior a native confirm()'s Cancel/Esc gives you.
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) cleanup(false); });
  });
}


// api() — same shape/signature as the dashboard's version (path, opts) so
// every Loads function that calls api('/api/loads', ...) etc. works
// completely unmodified. Two real differences from the dashboard's
// version: (1) requests go to API_BASE + path since this app's origin
// isn't the API's origin, not just `path`; (2) auth is the stored bearer
// token, not an automatic cookie; a 401 shows the login screen instead of
// navigating to a server-rendered /login page (which expects a cookie
// flow this app doesn't use).
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

