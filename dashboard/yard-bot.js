/* ── dashboard/yard-bot.js — the floating Edge Yard helper ───────────────────
 *
 * Per Apsara 2026-08-28: "design that like a floating icon in app and website."
 *
 * ONE FILE, used by BOTH the dashboard and the mobile app. The load form is
 * already duplicated across those two and it took a parity test to stop the
 * copies drifting; there was no reason to start a third copy on purpose. The
 * app bundles this file at build time (npx cap sync copies www/), the
 * dashboard serves it — same source either way.
 *
 * Self-contained: injects its own markup and styles on load, needs no HTML
 * changes in either host, and reads its API base from whatever the host
 * already uses. That is what makes "add it to both" a one-line include rather
 * than two parallel edits.
 *
 * It talks to /api/yard/ask, which has no route into the action-taking brain
 * in workflow/brain.js — so it can never message a trucker or send a WhatsApp.
 *
 * It CAN record a payment, start a draft load and edit a load (Apsara,
 * 2026-08-29: "it can do anything but within scope of edge yard"), but never
 * on its own: /api/yard/ask returns a PROPOSAL, this file renders it as a card
 * with the server's own figures, and only a tap on Confirm sends the opaque
 * proposal id to /api/yard/act. No amount, load id or mode is ever sent from
 * here, so nothing on the card can be tampered with in transit. It cannot
 * delete anything, at all.
 */
(function () {
  if (window.__yardBotLoaded) return;      // a double include must not stack two widgets
  window.__yardBotLoaded = true;

  var history = [];                        // {role:'you'|'bot', text}
  var open = false;
  var busy = false;

  // The host decides how to reach the API. The dashboard is same-origin; the
  // app has a configurable server address. Reusing the host's own helper means
  // this file never needs to know which it is in.
  function callApi(path, body) {
    if (typeof window.api === 'function') return window.api(path, { method: 'POST', body: JSON.stringify(body) });
    var base = window.API_BASE || '';
    return fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      // The STATUS has to survive, or the catch below cannot tell a refusal
      // from an outage. Previously this returned r.json() for every response,
      // so a 403 arrived looking like an answer with no answer in it.
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) {
          var err = new Error((data && data.error) || ('request failed (' + r.status + ')'));
          err.status = r.status;
          throw err;
        }
        return data;
      });
    });
  }

  var CSS = [
    '#yardBotFab{position:fixed;right:18px;bottom:18px;z-index:900;width:54px;height:54px;border-radius:50%;',
    'border:none;cursor:pointer;background:#B4703A;color:#fff;font-size:22px;line-height:54px;text-align:center;',
    'box-shadow:0 6px 20px rgba(0,0,0,.35);transition:transform .12s ease;}',
    '#yardBotFab:hover{transform:scale(1.06);}',
    '#yardBotFab.hidden{display:none;}',
    '#yardBotPanel{position:fixed;right:18px;bottom:18px;z-index:901;width:min(380px,calc(100vw - 28px));',
    'height:min(560px,calc(100vh - 36px));display:none;flex-direction:column;border-radius:14px;overflow:hidden;',
    'background:#15181B;border:1px solid rgba(255,255,255,.14);box-shadow:0 18px 48px rgba(0,0,0,.5);}',
    '#yardBotPanel.open{display:flex;}',
    '#yardBotHead{display:flex;align-items:center;gap:10px;padding:13px 15px;background:#1B1F23;border-bottom:1px solid rgba(255,255,255,.1);}',
    '#yardBotHead b{color:#fff;font-size:13.5px;letter-spacing:.02em;}',
    '#yardBotHead small{color:rgba(255,255,255,.45);font-size:10.5px;display:block;margin-top:1px;}',
    '#yardBotClose{margin-left:auto;background:none;border:none;color:rgba(255,255,255,.6);font-size:17px;cursor:pointer;padding:2px 6px;}',
    '#yardBotLog{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;}',
    '.yb-msg{max-width:88%;padding:9px 12px;border-radius:12px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word;}',
    '.yb-you{align-self:flex-end;background:#B4703A;color:#fff;border-bottom-right-radius:3px;}',
    '.yb-bot{align-self:flex-start;background:#22272B;color:#E6E8EA;border-bottom-left-radius:3px;}',
    '.yb-note{align-self:flex-start;color:rgba(255,255,255,.4);font-size:11px;font-style:italic;}',
    '.yb-tips{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px;}',
    '.yb-tip{background:#22272B;border:1px solid rgba(255,255,255,.12);color:rgba(255,255,255,.72);',
    'border-radius:999px;padding:5px 10px;font-size:11.5px;cursor:pointer;}',
    '.yb-tip:hover{border-color:#B4703A;color:#fff;}',
    // The confirmation card. Deliberately does NOT look like a chat bubble:
    // it is the one thing in this panel that changes the books, and it should
    // not be possible to skim past it as if it were another sentence.
    '.yb-prop{max-width:100%;width:100%;white-space:normal;border:1px solid #B4703A;background:#1B1F23;padding:11px 12px;}',
    '.yb-prop-h{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#B4703A;margin-bottom:5px;}',
    '.yb-prop-s{font-size:13px;line-height:1.5;color:#E6E8EA;}',
    '.yb-prop-r{display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:4px 0;border-top:1px solid rgba(255,255,255,.07);margin-top:4px;}',
    '.yb-prop-r span{color:rgba(255,255,255,.55);}',
    '.yb-prop-r b{color:#fff;text-align:right;font-weight:600;}',
    '.yb-prop-w{margin-top:7px;background:rgba(214,110,60,.14);border-left:2px solid #D66E3C;color:#F0C4A8;',
    'font-size:11.5px;line-height:1.45;padding:6px 8px;border-radius:0 6px 6px 0;}',
    '.yb-prop-b{display:flex;gap:8px;margin-top:10px;}',
    '.yb-prop-b button{flex:1;border-radius:8px;padding:9px 0;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;}',
    '.yb-no{background:transparent;border:1px solid rgba(255,255,255,.2);color:rgba(255,255,255,.7);}',
    '.yb-yes{background:#B4703A;border:1px solid #B4703A;color:#fff;}',
    '.yb-yes:disabled{opacity:.6;cursor:default;}',
    '.yb-prop.done{border-color:rgba(255,255,255,.12);}',
    '#yardBotFoot{display:flex;gap:8px;padding:11px;border-top:1px solid rgba(255,255,255,.1);background:#1B1F23;}',
    '#yardBotInput{flex:1;min-width:0;background:#0F1214;border:1px solid rgba(255,255,255,.16);border-radius:9px;',
    'color:#fff;padding:11px 12px;font-size:13.5px;outline:none;font-family:inherit;}',
    '#yardBotInput:focus{border-color:#B4703A;}',
    '#yardBotSend{background:#B4703A;border:none;color:#fff;border-radius:9px;padding:0 16px;font-size:13px;font-weight:700;cursor:pointer;}',
    '#yardBotSend:disabled{opacity:.5;cursor:default;}',
    /* On a phone the panel takes the screen — a 380px card floating on a
       small display wastes most of it and puts the input under the thumb of
       whatever is behind it. */
    '@media(max-width:520px){#yardBotPanel{right:0;bottom:0;width:100vw;height:100vh;border-radius:0;border:none;}}',

    /* ── DOCKED DOWN THE RIGHT, ON THE WEBSITE (2026-11-08) ───────────────
     * Apsara: "There should be a scout AI to assist us with yard on the
     * right side ... It should be the highest form of intelligence."
     *
     * A 560px card floating over the middle of a laptop screen is a chat
     * window you dismiss to see your work. Docked full-height down the edge,
     * it is something you work ALONGSIDE — which is what she described, and
     * the difference between an assistant and an interruption.
     *
     * .yb-docked is set by the script only when the host is the website and
     * the window is wide enough to spare the room. The phone keeps the
     * full-screen sheet above and the app is not touched at all: one file,
     * two hosts, and the FLAG MARKS THE NEW SHAPE rather than the old one.
     */
    '#yardBotPanel.yb-docked{top:0;right:0;bottom:0;height:100vh;width:min(420px,38vw);',
    'border-radius:0;border-top:none;border-right:none;border-bottom:none;}',
    '#yardBotPanel.yb-docked #yardBotLog{flex:1;}',
    '.yb-working{margin:2px 0 0;font-size:11px;color:rgba(255,255,255,.5);}',
    '.yb-working summary{cursor:pointer;padding:3px 0;}',
    '.yb-working-row{padding:2px 0 2px 10px;font-family:ui-monospace,Menlo,monospace;',
    'font-size:10.5px;color:rgba(255,255,255,.42);word-break:break-all;}',
  ].join('');

  var TIPS = [
    'What do we still owe?',
    'Which seller have we bought most from?',
    'What did we buy this month?',
    'What stock is on hand?',
  ];

  function el(id) { return document.getElementById(id); }

  // ── Signed-in gate ────────────────────────────────────────────────────────
  // Per Apsara 2026-08-29: the chat bubble was showing on the app's login
  // screen.
  //
  // The two hosts sign in differently and this has to be right in both:
  //
  //  • The APP has an in-page #loginScreen / #appShell pair and swaps them by
  //    toggling .hidden. Nothing server-side stops the bundled HTML from
  //    rendering, so a widget that mounts on DOMContentLoaded appears over the
  //    password box. That is the reported bug.
  //
  //  • The WEBSITE has no in-page login. api.js redirects a signed-out browser
  //    to /login before index.html is ever served, so being on this page at
  //    all already means signed in.
  //
  // Hence: if the app's shell markup exists, follow it; otherwise assume the
  // server already made the decision. Nothing here is a security control — the
  // API rejects unauthenticated calls regardless — it is about not offering a
  // yard assistant to someone who has not proved who they are.
  function isSignedIn() {
    // FAIL SAFE: hidden ONLY when the login screen is definitively on screen.
    // Everything else — including any state this code does not recognise —
    // shows the bubble.
    //
    // Reversed 2026-08-29 after Apsara reported "yard assistant not there".
    // The first version required BOTH that the login screen was hidden AND
    // that #appShell was visible, so any boot sequence that did not match that
    // assumption hid the assistant permanently, with no way to tell why. I
    // could not reproduce it here, which is exactly the point: a gate that
    // defaults to OFF turns every unanticipated state into a missing feature,
    // while one that defaults to ON turns the same states into, at worst, a
    // bubble on a screen it need not be on.
    //
    // The requirement was only ever "not on the sign-in page". This meets it
    // and fails in the harmless direction.
    var login = document.getElementById('loginScreen');
    if (login && !login.classList.contains('hidden')) return false;
    return true;
  }

  // Applies the gate. Also CLOSES an open panel on sign-out — a session that
  // expires mid-conversation must not leave the yard's figures sitting on
  // screen above the login card. helpers in the app hide #appShell on expiry,
  // which this observes.
  function applySignedInGate() {
    var ok = isSignedIn();
    var fab = el('yardBotFab');
    var panel = el('yardBotPanel');
    if (!fab || !panel) return;
    fab.style.display = ok ? '' : 'none';
    if (!ok && open) {
      open = false;
      panel.classList.remove('open');
      // Drop the transcript too. It is the yard's data, and it should not
      // still be there for whoever signs in next.
      history = [];
      greet();
    }
  }


  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function mount() {
    // Mounted once. A second run would add a second pair of click handlers to the SAME button
    // (getElementById finds the first), and two toggles per click is "never opens".
    if (document.getElementById('yardBotFab')) return;
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var wrap = document.createElement('div');
    wrap.innerHTML = [
      '<button id="yardBotFab" title="Ask about the yard">&#128172;</button>',
      '<div id="yardBotPanel">',
      '  <div id="yardBotHead">',
      '    <div><b>Yard assistant</b><small>Answers questions &middot; cannot change anything</small></div>',
      '    <button id="yardBotClose" title="Close">&times;</button>',
      '  </div>',
      '  <div id="yardBotLog"></div>',
      '  <div id="yardBotFoot">',
      '    <input id="yardBotInput" placeholder="Ask about loads, sellers, stock…" autocomplete="off">',
      '    <button id="yardBotSend">Ask</button>',
      '  </div>',
      '</div>',
    ].join('');
    document.body.appendChild(wrap);

    // NOT `addEventListener('click', toggle)`: a click passes its Event as the first argument, and
    // toggle(want) reads any value that is not undefined as "force this state" - an Event is truthy,
    // so Close "forced open" and the panel could never be closed (Apsara 2026-11-15: "once yard
    // assistant is opened, we cant close it"). Broke the day `want` was added, 2026-11-08.
    el('yardBotFab').addEventListener('click', function () { toggle(); });
    el('yardBotClose').addEventListener('click', function () { toggle(); });
    el('yardBotSend').addEventListener('click', send);
    el('yardBotInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); send(); }
    });
    greet();

    applySignedInGate();
    // Watch the class attribute on the app's shell/login elements rather than
    // polling: signing in is a single class swap, and an observer reacts to it
    // immediately without burning a timer for the whole session.
    var watched = ['loginScreen', 'appShell'].map(el).filter(Boolean);
    if (watched.length && typeof MutationObserver === 'function') {
      var mo = new MutationObserver(applySignedInGate);
      watched.forEach(function (n) { mo.observe(n, { attributes: true, attributeFilter: ['class'] }); });
    }
    // A slow poll as well. The observer covers the ordinary class swap, but if
    // a host ever signs in some other way — replacing the element, a full
    // re-render — the observer never fires and the bubble would stay hidden
    // for the whole session. Two seconds costs nothing and removes that as a
    // way for this to silently disappear.
    setInterval(applySignedInGate, 2000);
  }

  function greet() {
    var log = el('yardBotLog');
    // Says what it can do, and — just as importantly — what it will never do.
    // Someone who knows a bot cannot delete will not try, and will not be
    // surprised later.
    log.innerHTML = '<div class="yb-msg yb-bot">Ask me anything about the yard — loads, sellers, stock, or what is still owed.\n\nI can also record a payment, start a draft load, or edit a load. I’ll always show you the exact change and wait for you to confirm it. I can’t delete anything.</div>'
      + '<div class="yb-tips">' + TIPS.map(function (t) {
        return '<button class="yb-tip" data-q="' + esc(t) + '">' + esc(t) + '</button>';
      }).join('') + '</div>';
    log.querySelectorAll('.yb-tip').forEach(function (b) {
      b.addEventListener('click', function () { el('yardBotInput').value = b.dataset.q; send(); });
    });
  }

  // `want` forces a state; omitted it flips, which is what every existing
  // caller does. Added 2026-11-08 so doAction can close the sheet on a phone
  // after taking her somewhere — a panel left over the thing she asked to
  // see is the assistant talking across the answer.
  function toggle(want) {
    open = (want === undefined) ? !open : !!want;
    var panel = el('yardBotPanel');
    panel.classList.toggle('open', open);
    // ── DOCKED, OR FLOATING ──────────────────────────────────────────────
    // Decided every time it opens rather than once at load, because a laptop
    // gets resized and a window dragged to a second screen should not keep a
    // layout chosen for the first one.
    //
    // THE WEBSITE IS THE ONE WITH loadTab AND THE TABS. The app's shell has
    // #appShell and works differently, so it keeps the floating card it has
    // always had — the flag marks the new shape, never the old one.
    var onWeb = !document.getElementById('appShell');
    var roomy = !window.matchMedia || window.matchMedia('(min-width:900px)').matches;
    panel.classList.toggle('yb-docked', !!(onWeb && roomy));
    el('yardBotFab').classList.toggle('hidden', open);
    if (open) setTimeout(function () { el('yardBotInput').focus(); }, 60);
  }

  function add(role, text) {
    var log = el('yardBotLog');
    var d = document.createElement('div');
    d.className = 'yb-msg ' + (role === 'you' ? 'yb-you' : 'yb-bot');
    d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }

  // ── the confirmation card ───────────────────────────────────────────────
  // Per Apsara 2026-08-29, the assistant can act — by proposing, with a person
  // confirming. This is that person's only view of what is about to happen, so
  // it shows the REAL figures the server computed, not the model's sentence.
  //
  // Only the opaque id goes back on Confirm. Nothing on this card is editable
  // and no amount travels with the request, so what is confirmed is exactly
  // what was validated server-side.
  // ── TAKING HER TO THE SCREEN SHE ASKED FOR (2026-11-08) ──────────────────
  // Apsara: "If i say show spend report for last three days.it should do that
  // from any screen in edge yard."
  //
  // The server has already resolved what she meant and checked it against the
  // list of screens that really exist (helpers/scoutActions.js). By the time
  // it gets here it names a tab loadTab() answers to and filters that are real
  // fields, so this does not second-guess it — it applies it.
  //
  // WEBSITE ONLY, by construction: loadTab and the spend* variables exist only
  // there, and the app never asks for an action in the first place. The guard
  // is belt and braces, not the mechanism.
  function doAction(a) {
    if (!a || typeof loadTab !== 'function') return;
    var f = a.filters || {};
    try {
      // The spend screen keeps its filters in plain variables that the tab
      // reads when it draws. Setting them before loadTab is how the screen
      // opens ALREADY filtered rather than opening and then jumping, which
      // looks like a bug even when the end state is right.
      if (a.open === 'spend') {
        if (typeof f.from === 'string') spendFrom = f.from;
        if (typeof f.to === 'string') spendTo = f.to;
        if (f.company) spendCompany = f.company;
        if (typeof f.method === 'string') spendMethod = f.method;
        if (typeof f.bank === 'string') spendBank = f.bank;
        if (typeof f.paid_via === 'string') spendPaidVia = f.paid_via;
        if (typeof f.bought_from === 'string') spendBought = f.bought_from;
        if (typeof f.sold_to === 'string') spendSold = f.sold_to;
      }
      loadTab(a.open);
      // ── AND GET OUT OF THE WAY ────────────────────────────────────────
      // She asked to SEE something. Leaving a panel sitting over the thing
      // she asked for is the assistant talking across the answer. The
      // conversation is still there when she opens it again.
      if (window.matchMedia && window.matchMedia('(max-width:520px)').matches) toggle(false);
    } catch (e) {
      // A navigation that fails must not eat the answer that came with it.
      add('bot', 'I could not open that screen from here — the answer above still stands.');
    }
  }

  // ── THE WORKING UNDER THE FIGURE (2026-11-08) ────────────────────────────
  // Apsara: "Let ai should handle that with detailed report". A number with no
  // rows behind it is something she has to take on trust, and the whole point
  // of asking her own books is not having to.
  //
  // askYard now returns what it looked up — the tool, the parameters it chose
  // and the rows it got back. Rendered folded: the answer stays the answer,
  // and the evidence is one tap away rather than a wall of JSON over it.
  function renderWorking(used) {
    if (!used || !used.length) return;
    var log = el('yardBotLog');
    if (!log) return;
    var box = document.createElement('details');
    box.className = 'yb-working';
    var sum = document.createElement('summary');
    sum.textContent = 'Where this came from (' + used.length + ')';
    box.appendChild(sum);
    used.forEach(function (u) {
      var r = u && u.result;
      var n = (r && (r.count != null ? r.count
             : (Array.isArray(r.rows) ? r.rows.length
             : (Array.isArray(r) ? r.length : null))));
      var line = document.createElement('div');
      line.className = 'yb-working-row';
      line.textContent = (u.name || 'lookup')
        + (n != null ? ' — ' + n + ' row' + (n === 1 ? '' : 's') : '')
        + (u.params && Object.keys(u.params).length
            ? '  ' + JSON.stringify(u.params) : '');
      box.appendChild(line);
    });
    log.appendChild(box);
    log.scrollTop = log.scrollHeight;
  }

  function renderProposal(p) {
    var log = el('yardBotLog');
    var card = document.createElement('div');
    card.className = 'yb-msg yb-bot yb-prop';

    var html = '<div class="yb-prop-h">Confirm this?</div>';
    html += '<div class="yb-prop-s">' + esc(p.summary || '') + '</div>';
    (p.details || []).forEach(function (d) {
      html += '<div class="yb-prop-r"><span>' + esc(String(d[0])) + '</span><b>' + esc(String(d[1])) + '</b></div>';
    });
    // Warnings are the whole point of the card in the cases that matter most —
    // an overpayment, or an edit that voids a seller's signature. Shown loud,
    // never collapsed.
    (p.warnings || []).forEach(function (w) {
      html += '<div class="yb-prop-w">' + esc(w) + '</div>';
    });
    html += '<div class="yb-prop-b"><button class="yb-no">Cancel</button><button class="yb-yes">Confirm</button></div>';
    card.innerHTML = html;
    log.appendChild(card);
    log.scrollTop = log.scrollHeight;

    function settle(msg) {
      card.classList.add('done');
      card.innerHTML = '<div class="yb-prop-s">' + esc(msg) + '</div>';
      history.push({ role: 'bot', text: msg });
      log.scrollTop = log.scrollHeight;
    }

    card.querySelector('.yb-no').addEventListener('click', function () {
      callApi('/api/yard/cancel-action', { id: p.id }).catch(function () {});
      settle('Cancelled — nothing was changed.');
    });

    card.querySelector('.yb-yes').addEventListener('click', function () {
      var yes = card.querySelector('.yb-yes');
      // Disabled immediately: the server treats a proposal as single-use, but
      // a second tap should read as "working", not as a failed confirmation.
      yes.disabled = true; yes.textContent = 'Working…';
      callApi('/api/yard/act', { id: p.id, source: document.getElementById('appShell') ? 'app' : 'website' })
        .then(function (r) {
          if (r && r.ok) {
            settle('Done. ' + (r.summary || ''));
            // The rest of the page is now stale — a payment just landed that
            // the loads list and the pending badges do not know about. Ask the
            // host page to repaint if it has told us how.
            if (typeof window.refreshAfterYardAction === 'function') {
              try { window.refreshAfterYardAction(); } catch (e) {}
            }
          } else {
            settle((r && r.error) || "That didn't go through.");
          }
        })
        .catch(function (e) {
          settle('That did not go through: ' + ((e && e.message) || 'the server could not be reached') + '. Nothing was changed.');
        });
    });
  }

  function send() {
    if (busy) return;
    // Belt and braces: the gate hides the button, but a stale open panel must
    // not be able to ask for yard figures after a sign-out.
    if (!isSignedIn()) { applySignedInGate(); return; }
    var input = el('yardBotInput');
    var q = String(input.value || '').trim();
    if (!q) return;
    input.value = '';
    add('you', q);
    history.push({ role: 'you', text: q });

    busy = true;
    el('yardBotSend').disabled = true;
    var thinking = add('bot', 'Looking…');

    // source: recorded in the daily transcript so a problem seen only on a
    // phone is separable from the website without guessing. The app is the
    // host with #appShell in its markup; the website has none.
    // ── SCOUT CAN POINT, ON THE WEBSITE (2026-11-08) ────────────────────
    // Apsara: "If i say show spend report for last three days.it should do
    // that from any screen in edge yard."
    //
    // `show` is asked for only where there is a screen to move: the website
    // has loadTab() and the tabs; the app's shell does not work that way, so
    // it keeps asking exactly what it always asked and is untouched. The
    // flag marks the NEW behaviour — never the old one — because a flag you
    // must set to keep something working is one that eventually goes unset.
    var onWeb = !document.getElementById('appShell');
    callApi('/api/yard/ask', {
      question: q,
      history: history.slice(-6),
      source: onWeb ? 'website' : 'app',
      show: onWeb || undefined,
      // Which company she is looking at, so Scout does not move her between
      // two different businesses on a guess. Edge Yard and Edge Metals are
      // different companies and that separation is most of what this is for.
      company: (onWeb && typeof spendCompany === 'string') ? spendCompany : undefined,
    })
      .then(function (r) {
        var answer = (r && r.answer) || "I couldn't answer that.";
        thinking.textContent = answer;
        history.push({ role: 'bot', text: answer });
        if (r && r.proposal) renderProposal(r.proposal);
        if (r && r.used) renderWorking(r.used);
        if (r && r.action) doAction(r.action);
      })
      .catch(function (err) {
        // ── SAY WHICH FAILURE IT WAS ──────────────────────────────────────
        // Apsara, 2026-09-15: "why am i getting message as i cant reach the
        // server right now from chat bot in edge yard app?"
        //
        // Because this catch was blanket. It printed the same sentence for a
        // 403, a 500 and a genuine outage — and its own comment claimed to
        // distinguish them. Three problems needing three different reactions,
        // reported as one, so neither she nor anyone reading the log could
        // tell which it was.
        //
        // The likeliest of the three is the one it hid best: /api/yard/ask is
        // NOT in api.js's STAFF_ALLOWED_PATH_PREFIXES, so a staff session gets
        // 403 on every question while the Loads tab keeps working. That reads
        // as "the server is down" and is nothing of the kind.
        var msg = String((err && err.message) || '');
        // ── RECOVER THE STATUS FROM THE TEXT WHEN IT IS NOT ON THE ERROR ──
        // Only the fetch fallback in callApi sets err.status. Both hosts'
        // own api() throws `new Error(err.error || 'request failed (N)')`
        // with no status on it — and /api/yard/ask answers a 500 with
        // { ok, answer } and NO `error` field, so the message is exactly
        // 'request failed (500)'. Without this parse a server error still
        // reported as unreachable IN THE APP, which is the half of the bug
        // the first version of this fix missed.
        var status = (err && err.status)
            || Number((msg.match(/request failed \((\d{3})\)/) || [])[1])
            || 0;
        // window.api (both clients) throws with the server's own `error`
        // string and no status, so the text is matched too.
        if (status === 403 || /staff access is limited/i.test(msg)) {
          thinking.textContent = "You're signed in as staff, and the assistant is limited to admin. "
            + "Sign in with the admin password to ask it anything.";
        } else if (status === 401 || /unauthor/i.test(msg)) {
          thinking.textContent = 'Your session has expired — sign in again.';
        } else if (status >= 500) {
          // Reached the server; the server broke. Worth separating, because
          // this one is a bug to go and look at rather than a setting.
          thinking.textContent = 'The server reached an error answering that'
            + (msg ? ' (' + msg + ').' : '.') + ' It is worth reporting.';
        } else if (status) {
          thinking.textContent = 'The server refused that (' + status + ')'
            + (msg ? ': ' + msg : '') + '.';
        } else {
          // No status at all means the request never completed — DNS, no
          // signal, wrong server URL. The only case the old sentence fitted.
          thinking.textContent = "I can't reach the server right now. "
            + 'Check the connection, or the server URL in Settings.';
        }
      })
      .finally(function () {
        busy = false;
        el('yardBotSend').disabled = false;
        el('yardBotLog').scrollTop = el('yardBotLog').scrollHeight;
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
