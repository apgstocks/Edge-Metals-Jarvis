    section('A2 — in the app it sits in the menu, never over the page (2026-11-21)');
    {
        // Apsara: "in some of the browser, language space overlaps with +load". A floating switch lands on whatever the
        // page draws under it; in the app it now lives in the menu footer, above Sign out, in the page's own flow.
        const dom = new JSDOM(`<!doctype html><html lang="en"><head></head><body>${BODY}<aside id="sidebar"><div id="foot"><div id="roleLabel">ADMIN</div><button id="btnSignout">Sign out</button></div></aside></body></html>`,
            { runScripts: 'dangerously', url: 'http://localhost/' });
        const w = dom.window;
        const s0 = w.document.createElement('script'); s0.textContent = "let CURRENT_TAB = 'loads';"; w.document.head.appendChild(s0);
        const s1 = w.document.createElement('script'); s1.textContent = SRC; w.document.body.appendChild(s1);
        await tick();
        const t = w.document.getElementById('yardLangToggle');
        ck('the switch is in the menu footer, directly above Sign out', t && t.parentNode.id === 'foot' && t.nextElementSibling && t.nextElementSibling.id === 'btnSignout');
        ck('  it does not float (no fixed position), so nothing on the page can sit under it', t && !/fixed/.test(t.style.cssText) && /static/.test(t.style.position || t.style.cssText));
        ck('  it is shown on a yard tab, both buttons sharing the width', t && t.style.display === 'flex' && [...t.querySelectorAll('button')].every((b) => /1 1 0/.test(b.style.flex)));
        t.querySelector('[data-lang="es"]').click(); await tick();
        ck('  it still switches the language from there', w.yardLang.get() === 'es' && t.querySelector('[data-lang="es"]').getAttribute('aria-pressed') === 'true');
        ck('  and stays put afterwards (one move, no loop)', t.parentNode.id === 'foot' && w.document.querySelectorAll('#yardLangToggle').length === 1);
        const index = require('fs').readFileSync(require('path').join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
        ck('the real app page has the Sign out button the switch anchors to', /id="btnSignout"/.test(index));
    }

