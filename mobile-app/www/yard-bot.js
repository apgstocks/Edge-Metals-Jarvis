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
    }).then(function (r) { return r.json(); });
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

    el('yardBotFab').addEventListener('click', toggle);
    el('yardBotClose').addEventListener('click', toggle);
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

  function toggle() {
    open = !open;
    el('yardBotPanel').classList.toggle('open', open);
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
    callApi('/api/yard/ask', {
      question: q,
      history: history.slice(-6),
      source: document.getElementById('appShell') ? 'app' : 'website',
    })
      .then(function (r) {
        var answer = (r && r.answer) || "I couldn't answer that.";
        thinking.textContent = answer;
        history.push({ role: 'bot', text: answer });
        if (r && r.proposal) renderProposal(r.proposal);
      })
      .catch(function () {
        // Distinguishes "can't reach the server" from "don't know", because
        // they need completely different reactions from the person asking.
        thinking.textContent = "I can't reach the server right now.";
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
