// mobile-app/www/app/10-shell.js — split from mobile-app/www/index.html's <script> (helpers/sourceParts.js reconstructs the original)
// ── WHICH MONTH IS FILTERED, IF ANY (2026-10-02) ─────────────────────────
// Deliberately NOT remembered in localStorage, unlike loadKindFilter above.
// A kind ("Purchases") is how she likes to work and is worth persisting. A
// MONTH is where she happened to be looking once — restoring "September" a
// fortnight later means opening the Loads tab and seeing none of this week's
// work, with a control she has forgotten she set. The empty default is the
// safe one.
let loadMonthFilter = '';

function paintLoadKindBar(count) {
  const bar = document.getElementById('loadKindBar');
  if (!bar) return;
  bar.innerHTML = LOAD_KINDS.map(([k, label]) => {
    const on = loadKindFilter === k;
    // The COUNT rides on the active tab, for the same reason the item filter
    // shows one: a genuine zero has to be distinguishable from a filter that
    // is not looking where you think.
    const txt = on && count !== undefined ? `${label} (${count})` : label;
    return `<button type="button" class="btn ${on ? 'btn-primary' : 'btn-secondary'} load-kind-btn" data-kind="${k}"
              aria-pressed="${on}" style="font-size:12px; padding:6px 14px;">${txt}</button>`;
  }).join('');

  // ── THE CREATE BUTTON FOLLOWS THE FILTER ──────────────────────────────
  // Apsara, 2026-10-15: "on purchases,hide the sale button(create),on sale
  // page,hide the create invocie button."
  //
  // Done HERE rather than in the click handler because this function is the
  // only thing that already runs on every filter change — from repaintDeck
  // and from init — and a second place that decides what is on screen is how
  // two of them end up disagreeing. Same reasoning as the comment on the
  // delegated handler above.
  //
  // 'all' shows both: it is the view that is not claiming to be one kind, and
  // hiding a create button there would leave the tab with no way to add a
  // sale. Hidden with .hidden (display:none !important) so the flex row
  // closes up rather than leaving a gap, and the ELEMENTS STAY IN THE DOM —
  // tests/yard-clients.js section E checks btnAddSale exists in both clients
  // by name, and tests/item-row-net.js opens the form through btnAddLoad.
  const toggleCreate = (id, show) => {
    const b = document.getElementById(id);
    if (b) b.classList.toggle('hidden', !show);
  };
  toggleCreate('btnAddLoad', loadKindFilter !== 'sale');
  toggleCreate('btnAddSale', loadKindFilter !== 'purchase');
}
let loadsCache = [];
// Unfinished loads shown above the deck. Held separately from loadsCache on
// purpose — every total and filter in this tab reads loadsCache, and a draft
// must not reach any of them.
let pendingDrafts = [];
let currentLoadItems = [];
let editingLoadId = null;
let saveTicket = null;   // one-time ticket per Save — see resetLoadModal
// The load-level description input is gone from the form (2026-08-28), but the
// FIELD still exists on records saved before that. Held here so editing an old
// load preserves its description rather than silently blanking it on save —
// removing a box from a form must not delete data it can no longer show.
let editingLoadDescription = '';

// ── App shell (new — replaces the dashboard's sidebar/tab system, which
// doesn't exist here since this app has exactly one screen) ─────────────
// Wires the server box. Verifies the address before saving it rather than
// accepting anything typed — a wrong URL saved silently would leave the app
// unable to reach anything AND unable to explain why, which is a worse state
// than the rotation it exists to fix.
// Server address inside Admin settings. Same probe as the recovery copy — a
// wrong address is only worth saving once something has actually answered on
// it, otherwise the app is left pointing at nothing with no way to tell.
function wireAdminServerBox() {
  const save = $('btnAsSaveServer');
  if (!save || save.dataset.wired) return;
  save.dataset.wired = '1';
  $('btnAsResetServer').addEventListener('click', () => {
    setStoredApiBase('');
    API_BASE = DEFAULT_API_BASE;
    $('as_server_url').value = DEFAULT_API_BASE;
    $('as_server_msg').style.color = 'var(--text-muted)';
    $('as_server_msg').textContent = 'Back to the address this app shipped with.';
  });
  save.addEventListener('click', async () => {
    const url = String($('as_server_url').value || '').trim().replace(/\/+$/, '');
    const msg = $('as_server_msg');
    if (!/^https?:\/\//i.test(url)) {
      msg.style.color = 'var(--status-danger)';
      msg.textContent = 'Needs to start with https:// (or http:// on a local network).';
      return;
    }
    save.disabled = true; save.textContent = 'Checking…';
    msg.style.color = 'var(--text-muted)'; msg.textContent = 'Trying to reach it…';
    try {
      const r = await fetch(url + '/api/health', { method: 'GET' });
      if (!r.ok) throw new Error(`server answered ${r.status}`);
      setStoredApiBase(url);
      API_BASE = url;
      msg.style.color = 'var(--status-success, #3fae55)';
      msg.textContent = '✓ Reached it. Saved.';
    } catch (e) {
      msg.style.color = 'var(--status-danger)';
      msg.textContent = `Couldn't reach that address. ${e.message}`;
    } finally { save.disabled = false; save.textContent = 'Save address'; }
  });
}

// ── A REPORT THAT SURVIVES NOT BEING ABLE TO SEND IT ─────────────────────
// The whole difficulty of telling Apsara that a phone could not reach the
// server is that the phone could not reach the server. There is nowhere to
// send the report AT THE MOMENT it matters.
//
// So it is queued on the device and flushed on the next connection that
// works — mobile data, a different wifi, tomorrow morning at the office. The
// report carries its own timestamp, so arriving late costs nothing. This is
// how crash reporters have always worked and it is the only shape that can
// work here.
//
// Bounded at 20. A phone that has been offline for a week should send a
// handful of examples, not a week of retries, and an unbounded queue in
// localStorage eventually breaks the app it was meant to protect.
var CLIENT_ERR_KEY = 'jarvis_client_errors';
var CLIENT_ERR_MAX = 20;

function queueClientError(entry) {
    try {
        var q = JSON.parse(localStorage.getItem(CLIENT_ERR_KEY) || '[]');
        if (!Array.isArray(q)) q = [];
        q.push(entry);
        if (q.length > CLIENT_ERR_MAX) q = q.slice(q.length - CLIENT_ERR_MAX);
        localStorage.setItem(CLIENT_ERR_KEY, JSON.stringify(q));
    } catch (e) { /* a full or disabled localStorage must never break sign-in */ }
}

// Called after anything reaches the server successfully. Fire-and-forget on
// purpose: this is diagnostics, and it must never delay or fail the thing the
// person was actually doing.
function flushClientErrors() {
    var q;
    try { q = JSON.parse(localStorage.getItem(CLIENT_ERR_KEY) || '[]'); }
    catch (e) { return; }
    if (!Array.isArray(q) || !q.length) return;
    // Cleared BEFORE sending. If the send fails the reports are lost, and
    // that is the right trade: keeping them would mean a device that can
    // never deliver retries for ever, and the next failure re-queues anyway.
    try { localStorage.removeItem(CLIENT_ERR_KEY); } catch (e) {}
    q.forEach(function (entry) {
        try {
            fetch(API_BASE + '/api/client-errors', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(entry), keepalive: true,
            }).catch(function () {});
        } catch (e) {}
    });
}

// ── WHY COULD IT NOT REACH THE SERVER (2026-10-02) ───────────────────────
// Apsara, after an outage that took two hours to pin down: "If app is failing
// this, add a debug somewhere to know te exact reason".
//
// She is right, and the reason this is needed is a deliberate hole in the web
// platform: fetch() reports EVERY network-level failure as the single string
// "Failed to fetch". DNS miss, TLS rejected, connection refused, blocked by
// the network, CORS preflight denied, HTTP/3 black-holed — one message for
// all of them, on purpose, so a page cannot port-scan the user's network.
//
// So the app cannot be TOLD the reason. It has to go and find out, by making
// a short series of probes that fail at different stages, and reporting which
// stage was the first to break. That is what this does.
//
//   1. the internet at all   — is this wifi working for anything
//   2. our host, no-cors     — did DNS + TCP + TLS to our domain succeed
//   3. our host, real CORS   — did the browser accept the response
//   4. the login preflight   — does OPTIONS /login come back clean
//
// no-cors on probe 2 is the important trick. It returns an OPAQUE response
// that tells us nothing about the body, but it RESOLVES if the connection was
// made. So probe 2 passing while probe 3 fails is the fingerprint of CORS or
// a TLS-intercepting proxy, and probe 2 failing is the fingerprint of the
// network blocking us outright. Those two were indistinguishable before.
//
// Every probe is time-bounded. A blocked network does not refuse, it stays
// silent, and without the abort this diagnostic would be the thing that hangs.
async function diagnoseNetwork(base) {
    const probe = async (label, url, opts) => {
        const o = opts || {};
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), o.timeout || 6000);
        const t0 = Date.now();
        try {
            const r = await fetch(url, { method: o.method || 'GET', mode: o.mode,
                                         cache: 'no-store', signal: ctl.signal });
            return { label, ok: true, status: r.status, type: r.type, ms: Date.now() - t0 };
        } catch (e) {
            const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
            return { label, ok: false, ms: Date.now() - t0,
                     err: aborted ? 'no answer (timed out)' : String((e && e.message) || e) };
        } finally { clearTimeout(timer); }
    };

    const out = [];
    // Android's own captive-portal endpoint. no-cors, no data leaves, and it
    // is the one host a phone on wifi has already talked to.
    out.push(await probe('internet', 'https://connectivitycheck.gstatic.com/generate_204',
                         { mode: 'no-cors', timeout: 5000 }));
    out.push(await probe('reach server', base, { mode: 'no-cors', timeout: 8000 }));
    out.push(await probe('read /healthz', base + '/healthz', { timeout: 8000 }));
    out.push(await probe('login preflight', base + '/login',
                         { method: 'OPTIONS', timeout: 8000 }));
    return out;
}

// Turns those four results into the one sentence worth reading first.
// Ordered by which stage broke EARLIEST, because the first failure is the
// cause and everything after it is a consequence.
function readDiagnosis(r) {
    const by = {};
    r.forEach((x) => { by[x.label] = x; });
    if (!by['internet'].ok) {
        return 'This wifi is not reaching the internet at all. Nothing on the phone will work '
             + 'until it does — try mobile data.';
    }
    if (!by['reach server'].ok) {
        return 'The internet works here, but this network will not connect to '
             + 'jarvis.edgemetals.com. That is the wifi blocking us, or its DNS refusing the '
             + 'name. Mobile data will work; the wifi needs its filtering changed.';
    }
    if (!by['read /healthz'].ok) {
        return 'The server was reached, but the reply was rejected before the app could read '
             + 'it. That is usually a network that inspects HTTPS traffic, or a CORS problem. '
             + 'Send this screen to Apsara.';
    }
    if (!by['login preflight'].ok) {
        return 'The server answers, but it refused the sign-in request specifically. That is a '
             + 'server-side CORS setting, not your network. Send this screen to Apsara.';
    }
    return 'Every check passed just now. The failure may have been momentary — try signing in '
         + 'again.';
}

function wireServerBox() {
  // The visible "Server settings" button is gone from the sign-in card. What
  // is left is a deliberately undiscoverable recovery gesture: press and hold
  // the login title for three seconds.
  //
  // This is not pretending to be security — anyone who knows the gesture can
  // use it, and it is documented right here. It is the honest resolution of a
  // real conflict: the address must be changeable from the SIGNED-OUT screen
  // (a wrong one means nobody can sign in to fix it, and the tunnel hostname
  // rotates), but it must not be sitting in front of whoever picks up the
  // phone. Invisible satisfies both. The genuine fix is a stable named tunnel,
  // after which this can be deleted outright.
  const card = document.querySelector('#loginScreen .eyebrow');
  if (card && !card.dataset.wired) {
    card.dataset.wired = '1';
    let timer = null;
    const start = () => {
      timer = setTimeout(() => {
        const box = $('serverBox');
        if (!box) return;
        box.classList.remove('hidden');
        $('serverUrl').value = storedApiBase() || DEFAULT_API_BASE;
        $('serverMsg').style.color = 'var(--text-muted)';
        $('serverMsg').textContent = 'Recovery only — change this if the app cannot reach the server.';
      }, 3000);
    };
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    card.addEventListener('touchstart', start, { passive: true });
    card.addEventListener('mousedown', start);
    ['touchend', 'touchcancel', 'touchmove', 'mouseup', 'mouseleave'].forEach((e) => card.addEventListener(e, cancel));
  }
  if ($('btnResetServer') && $('btnResetServer').dataset.wired) return;
  if ($('btnResetServer')) $('btnResetServer').dataset.wired = '1';
  $('btnResetServer').addEventListener('click', () => {
    setStoredApiBase('');
    API_BASE = DEFAULT_API_BASE;
    $('serverUrl').value = DEFAULT_API_BASE;
    $('serverMsg').style.color = 'var(--text-muted)';
    $('serverMsg').textContent = 'Back to the address this app shipped with.';
  });
  $('btnSaveServer').addEventListener('click', async () => {
    const url = String($('serverUrl').value || '').trim().replace(/\/+$/, '');
    const msg = $('serverMsg');
    if (!/^https?:\/\//i.test(url)) {
      msg.style.color = 'var(--status-danger)';
      msg.textContent = 'Needs to start with https:// (or http:// on a local network).';
      return;
    }
    const btn = $('btnSaveServer');
    btn.disabled = true; btn.textContent = 'Checking…';
    msg.style.color = 'var(--text-muted)'; msg.textContent = 'Trying to reach it…';
    try {
      // /api/health is unauthenticated and cheap — the right thing to probe
      // with, since a 401 from an authenticated route would look like a
      // failure when the address is actually correct.
      const r = await fetch(url + '/api/health', { method: 'GET' });
      if (!r.ok) throw new Error(`server answered ${r.status}`);
      setStoredApiBase(url);
      API_BASE = url;
      msg.style.color = 'var(--status-success, #3fae55)';
      msg.textContent = '✓ Reached it. Sign in below.';
    } catch (e) {
      msg.style.color = 'var(--status-danger)';
      msg.textContent = `Couldn't reach that address. ${e.message}`;
    } finally {
      btn.disabled = false; btn.textContent = 'Save address';
    }
  });
}

function showLoginScreen(err) {
  // Dismiss every overlay first. These are top-level siblings of #appShell,
  // so hiding #appShell does NOT hide them — without this a session that
  // expires while a modal is open leaves that modal sitting on top of the
  // login screen, showing its own local error ("Could not save:
  // unauthorized") while the real message ("Session expired — sign in
  // again") is hidden behind it. Reported by Apsara 2026-08-17 against the
  // signature pad; the same trap applied to every other overlay here.
  // truckerModal and truckerPayModal added 2026-09-03 with the Trucker tab —
  // and forgetting them is exactly the trap this list exists for. A session
  // expiring while the Pay form is open would have left a full-screen overlay
  // sitting on top of the login card, showing "unauthorized" from its own
  // error line while the real message was hidden behind it. This list is the
  // one place that has to be updated for every new overlay; a comment on the
  // modal would not have caught it, which is why tests/tab-speed.js now scans
  // for .modal-overlay ids that are missing from here.
  //
  // payModal and voiceSheet were ALREADY missing before today — found by the
  // scan the moment it existed, not by anyone reading the list. payModal is
  // the one that mattered: a session expiring while a payment was being
  // recorded left the Pay form over the login card, reading "unauthorized",
  // with the real "Session expired — sign in again" hidden behind it. That is
  // the exact bug this list was written for, sitting inside it.
  ['loadModal', 'adminSettingsModal', 'staffSettingsModal', 'signOverlay', 'expenseModal',
   'truckerModal', 'truckerPayModal', 'payModal', 'voiceSheet'].forEach(id => {
    const el = $(id);
    if (el) { el.classList.add('hidden'); el.style.display = ''; }
  });
  if (typeof closeScanner === 'function') closeScanner(); // also releases the camera
  if (typeof hideWeighToast === 'function') hideWeighToast(); // don't leave a read banner over the login screen
  $('loginScreen').classList.remove('hidden');
  $('appShell').classList.add('hidden');
  $('loginErr').textContent = err || '';
  wireServerBox();
  // Open the server box automatically when the failure looks like the app
  // can't reach the server at all — that is exactly the rotation case, and
  // making her find a hidden button while nothing works would be unkind.
  if (/reach|network|failed to fetch|timeout/i.test(String(err || ''))) {
    $('serverBox').classList.remove('hidden');
    $('serverUrl').value = storedApiBase() || DEFAULT_API_BASE;
  }
}
function showAppShell() {
  $('loginScreen').classList.add('hidden');
  $('appShell').classList.remove('hidden');
}

async function doLogin() {
  const pw = $('loginPw').value;
  const btn = $('btnLogin');
  $('loginErr').textContent = '';
  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    const res = await fetch(API_BASE + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Sign-in failed');
    setToken(data.sid);
    ROLE = data.role || 'user';
    IS_SUPER = data.super === true;
    // The connection works right now, so anything this device could not
    // report earlier goes up before we do anything else with the session.
    try { flushClientErrors(); } catch (e) {}
    await bootLoads();
  } catch (err) {
    // ── SAY WHICH ADDRESS IT TRIED (2026-10-02) ───────────────────────────
    // Apsara hit "failed to fetch" on the app while the website signed in
    // fine. That message alone cost an hour of elimination: the server was
    // up, CORS was correct, config.js was present and right, the preflight
    // and the POST both verified by hand from a laptop. Every one of those
    // checks was necessary ONLY because the app would not say where it had
    // just tried to connect.
    //
    // API_BASE can come from three places — localStorage (what she last
    // saved on this device, and it WINS), the bundled config.js, or the
    // emulator fallback — and the one thing the error never mentioned was
    // which. A stale stored address survives an APK upgrade, so the app can
    // be pointed at a host that died weeks ago while config.js is perfect.
    //
    // "Failed to fetch" is the browser's word for "could not reach it at
    // all": DNS, no route, dead host. So the address is the whole diagnosis,
    // and the recovery is the press-and-hold box on this same screen.
    const net = /failed to fetch|load failed|network ?request ?failed/i.test(String(err && err.message));
    // ── AND THEN FIND OUT WHY ────────────────────────────────────────────
    // Only on a network failure, and only after the message above is already
    // on screen, so the probes never delay what she can already read.
    if (net) {
        const box = document.getElementById('loginDiag');
        if (box) {
            box.classList.remove('hidden');
            box.textContent = 'Checking what is in the way...';
            diagnoseNetwork(API_BASE).then((r) => {
                const lines = r.map((x) => '  ' + (x.ok ? 'OK  ' : 'FAIL') + '  ' + x.label
                    + '  ' + (x.ok ? (x.type === 'opaque' ? 'connected' : 'HTTP ' + x.status)
                                   : x.err) + '  (' + x.ms + 'ms)');
                const verdict = readDiagnosis(r);
                box.textContent = verdict + '\n\n' + lines.join('\n') + '\n\n' + API_BASE;
                // Queued for the next connection that works. She finds out
                // from the device rather than from a staff member who assumed
                // their phone was broken and said nothing.
                queueClientError({ at: new Date().toISOString(), base: API_BASE,
                    app_version: (window.APP_VERSION || ''), platform: navigator.userAgent,
                    verdict: verdict, probes: r });
            }).catch((e) => { box.textContent = 'The check itself failed: ' + ((e && e.message) || e); });
        }
    }
    $('loginErr').innerHTML = net
      ? `Couldn't reach the server at <b>${String(API_BASE).replace(/[<>&]/g, '')}</b>.`
        + `<div style="font-size:11px; margin-top:6px; color:var(--text-faint); line-height:1.5;">`
        + `That is where this app is pointed${storedApiBase() ? ' (saved on this device, which overrides the bundled address)' : ' (the address it shipped with)'}.`
        + ` Press and hold the title above for 3 seconds to change it.</div>`
      : String(err.message || 'Sign-in failed').replace(/[<>&]/g, '');
  } finally {
    btn.disabled = false; btn.textContent = 'Sign in';
  }
}

// Loads | Inventory — per Apsara 2026-08-15. Loads is the default every
// time the app boots or you sign in (bootLoads() below always resets to it
// first) — Inventory is a second tab everyone can see, but its data is only
// fetched once someone actually taps it (renderCurrentMobileTab does the
// fetch, and it's never called for 'inventory' until that tap happens).
let currentMobileTab = 'loads';
function renderMobileTabs() {
  const tabBtn = (tab, label) => `<button class="mobile-tab-btn" data-tab="${tab}" style="padding:7px 16px; border-radius:7px; border:none; font-size:12.5px; font-weight:600; cursor:pointer; background:${currentMobileTab === tab ? 'var(--accent)' : 'transparent'}; color:${currentMobileTab === tab ? '#0C0E10' : 'var(--text-faint)'};">${label}</button>`;
  // Expenses is ADMIN ONLY, per Apsara 2026-08-19 ("for admin access in
  // mobile app, i want expense tracker"). Hiding the tab is only the UX
  // half — every /api/expenses route is requireAdmin-gated server-side, so
  // a non-admin session gets a 403 even if it reaches them another way.
  $('mobileTabBar').innerHTML = [
    tabBtn('loads', 'Loads'),
    tabBtn('inventory', 'Inventory'),
    // Petty cash is visible to STAFF TOO, unlike Expenses — Apsara 2026-09-02,
    // asked directly: "staff can see the balance, admin can top up". The tab
    // renders read-only for a non-admin (no + Add cash, no Delete), and
    // POST/DELETE /api/petty-cash are requireAdmin server-side, so hiding the
    // buttons is UX rather than the boundary.
    tabBtn('petty', 'Petty cash'),
    // Truckers — Apsara 2026-09-03, "a tab called trucker for everyone", so it
    // sits with the unconditional ones rather than in the admin block below.
    // '/api/trucker-bills' is on STAFF_ALLOWED_PATH_PREFIXES to match.
    //
    // What "everyone" does NOT include is paying: the Pay button is admin-only
    // because /api/payments is deliberately absent from that allowlist, the
    // same division that already applies to loads. A staff session records
    // what is owed; recording that it was settled stays with admin.
    tabBtn('trucker', 'Trucker'),
    // Expenses and Documents are admin-only. Hiding the button is UX only,
    // NOT the security boundary: /api/expenses is requireAdmin-gated and the
    // proforma/invoice routes are denied to staff by omission from
    // STAFF_ALLOWED_PATH_PREFIXES in api.js. A non-admin session that forged
    // its way to these screens would get 403s from every call they make.
    ...(ROLE === 'admin' ? [tabBtn('expenses', 'Expenses'), tabBtn('report', 'Report'), tabBtn('documents', 'Docs')] : []),
  ].join('');
  $('mobileTabBar').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.tab === currentMobileTab) return;
    currentMobileTab = b.dataset.tab;
    renderMobileTabs();
    renderCurrentMobileTab();
  }));
}

