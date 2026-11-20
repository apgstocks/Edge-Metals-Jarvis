  // ── WHERE THE SWITCH LIVES (2026-11-21) ──
  // Reported 2026-11-21: "in some of the browser, language space overlaps with +load on the screen". It floated over the page
  // (position:fixed, top right), and a floating thing lands on whatever the page puts under it — + Load sits top
  // right, and where exactly depends on the window width and the browser's fonts. A first fix nudged it to the top
  // edge; nudging cannot be right for every browser. So in the app it is no longer floating at all: it sits in the
  // menu's footer, above Sign out, in the page's own flow, where nothing can be drawn under it. On a narrow window
  // that menu folds behind ☰ and the switch goes with it, exactly like Sign out.
  // The sign-in screen has no menu and no + Load, so there it stays a small tab at the top-right edge.
  var FLOAT_CSS = 'position:fixed; top:0; right:72px; z-index:61; border:1px solid var(--steel-700, #444); border-top:none; border-radius:0 0 10px 10px; overflow:hidden; font:600 10px/1 var(--font-mono, monospace); letter-spacing:.08em;';
  var MENU_CSS = 'position:static; width:100%; margin-top:12px; border:1px solid var(--steel-700, #444); border-radius:16px; overflow:hidden; font:600 10.5px/1 var(--font-mono, monospace); letter-spacing:.08em;';
  function place(t) {
    var out = document.getElementById('btnSignout');
    var inMenu = !!(out && out.parentNode);
    if (inMenu && t.nextSibling !== out) out.parentNode.insertBefore(t, out);          // above Sign out
    else if (!inMenu && t.parentNode !== document.body) document.body.appendChild(t);
    var where = inMenu ? 'menu' : 'float';
    if (t.dataset.where !== where) {
      t.dataset.where = where;
      var disp = t.style.display;
      t.style.cssText = (inMenu ? MENU_CSS : FLOAT_CSS) + ' display:' + (disp || 'none') + ';';
      [].forEach.call(t.querySelectorAll('button'), function (b) {
        b.style.padding = inMenu ? '7px 0' : '5px 10px';
        b.style.flex = inMenu ? '1 1 0' : '';
      });
    }
  }
  function paintToggle() {
    var t = document.getElementById('yardLangToggle');
    if (!t) {
      t = document.createElement('div'); t.id = 'yardLangToggle'; t.setAttribute('role', 'group'); t.setAttribute('aria-label', 'Language / Idioma');
      t.style.display = 'none';
      ['en', 'es'].forEach(function (code) {
        var b = document.createElement('button'); b.type = 'button'; b.dataset.lang = code; b.textContent = code.toUpperCase();
        b.style.cssText = 'border:none; cursor:pointer;';
        b.addEventListener('click', function () { setLang(code); });
        t.appendChild(b);
      });
    }
    place(t);
    var disp = yardHere() ? 'flex' : 'none';
    if (t.style.display !== disp) t.style.display = disp;
    if (t.dataset.painted === lang) return;                                 // repaint only when the choice changes
    t.dataset.painted = lang;
    [].forEach.call(t.querySelectorAll('button'), function (b) {
      var on = b.dataset.lang === lang;
      b.style.background = on ? 'var(--accent, #2f9e44)' : 'var(--steel-900, #111)';
      b.style.color = on ? '#fff' : 'var(--text-muted, #aaa)';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

