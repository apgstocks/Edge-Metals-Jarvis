// ── dashboard/sidebar.js — the app's sidebar on the standalone pages ──────
// Apsara, 2026-10-08: "also i want the sidebar to appear in all pages".
//
// Ten sidebar rows (Documents, QuickBooks, Books, Bank, Claims, Edge
// Inventory, Outbound Loads, Address Book, Quote Requests, BOL) are not tabs
// of index.html — they are separate pages, and until now leaving the app for
// one of them took the whole menu away and left a "← Back to dashboard" link.
// She chose ONE shared file over loading the pages inside a frame, because
// printing invoices and BOLs from a frame is unreliable.
//
// ── index.html IS STILL THE MASTER LIST, AND THAT WAS MY CALL ────────────
// The obvious move was to lift NAV_ITEMS out of index.html into this file and
// have both read it. I did not, because nine test files (page-headings.js,
// sidebar-collapse.js, sidebar-company.js ...) and scripts/mutate.js cut
// NAV_ITEMS straight out of index.html's source text; moving it would turn
// them red for a reason that has nothing to do with what they guard.
// So the lists below are a COPY, and tests/sidebar-pages.js fails the moment
// they differ from index.html — the same pattern jarvis-profile.js uses to
// keep the two clients in step. Change a nav row in index.html, change it
// here, or that test tells you.
//
// ── WHAT IT DOES ON A PAGE ───────────────────────────────────────────────
// Load it with the page's own nav id:
//     <script src="/sidebar.js" data-page="documents" defer></script>
// It asks /api/me for the role (the same call index.html makes), draws the
// same rows with the same admin / staff rules, the same company switcher
// (same localStorage key, so the choice follows her between pages), the same
// four folding groups. It starts collapsed — a thin strip on the left with ☰.
// A row that is a standalone page navigates to it; a row that is a tab of
// the app goes to /#tab=<id>, which index.html's boot() opens.
//
// It changes NOTHING on index.html: if #sidebar already exists it returns.
// It is hidden when printing, so a printed invoice is exactly what it was.
(function () {
  'use strict';
  if (typeof document === 'undefined') return;
  if (document.getElementById('sidebar') || document.getElementById('jvSidebar')) return;

  // ── COPIED FROM index.html — tests/sidebar-pages.js keeps them equal ──
  const NAV_ITEMS = [
    { id: 'loads', label: 'Loads', group: 'Edge Yard' },
    { id: 'inventory', label: 'Inventory', group: 'Edge Yard' },
    { id: 'petty', label: 'Petty Cash', group: 'Edge Yard' },
    { id: 'trucker-bills', label: 'Trucker Bills', group: 'Edge Yard' },
    { id: 'expenses', label: 'Expenses', group: 'Edge Yard', adminOnly: true },
    { id: 'spend', label: 'Spend Report', group: 'Both companies', adminOnly: true },
    { id: 'contacts', label: 'Price Lists', group: 'Edge Yard', adminOnly: true },
    { id: 'outbound-loads', label: 'Outbound Loads', group: 'Edge Yard', adminOnly: true },
    { id: 'board', label: 'Board', group: 'Edge Metals' },
    { id: 'bookings', label: 'Bookings', group: 'Edge Metals' },
    { id: 'partners', label: 'Truckers & Suppliers', group: 'Edge Metals' },
    { id: 'documents', label: 'Documents', group: 'Edge Metals' },
    { id: 'bills', label: 'Bills', group: 'Edge Metals' },
    { id: 'sales', label: 'Invoice', group: 'Edge Metals' },
    { id: 'edge-inventory', label: 'Edge Inventory', group: 'Edge Metals', adminOnly: true },
    { id: 'quickbooks', label: 'QuickBooks', group: 'Edge Metals' },
    { id: 'books', label: 'Books', group: 'Edge Metals' },
    { id: 'bank', label: 'Bank', group: 'Edge Metals', adminOnly: true },
    { id: 'claims', label: 'Claims', group: 'Edge Metals' },
    { id: 'bot', label: 'Bot', group: 'Bot & Automation' },
    { id: 'facts', label: 'Facts', group: 'Bot & Automation', adminOnly: true },
    { id: 'tasks', label: 'Tasks', group: 'Bot & Automation' },
    { id: 'bugzilla', label: 'Bugzilla', group: 'Bot & Automation' },
    { id: 'whatsapp', label: 'WhatsApp', group: 'Contacts & Outreach', adminOnly: true },
    { id: 'email-contacts', label: 'Email Contacts', group: 'Contacts & Outreach', adminOnly: true },
    { id: 'address-book', label: 'Address Book', group: 'Contacts & Outreach', adminOnly: true },
    { id: 'design-bol', label: 'BOL', group: 'Design', adminOnly: true },
    { id: 'quote-requests', label: 'Quote Requests', group: 'Contacts & Outreach', adminOnly: true },
    { id: 'settings', label: 'Settings', group: 'System', adminOnly: true },
  ];
  // The rows that are their own pages — index.html's renderNav click handler.
  const PAGE_HREF = {
    'address-book': '/address-book', 'quote-requests': '/quote-requests', 'outbound-loads': '/outbound-loads',
    documents: '/documents', 'edge-inventory': '/edge-inventory', quickbooks: '/quickbooks', books: '/books',
    bank: '/bank-match', claims: '/claims', 'design-bol': '/design/bol',
  };
  const STAFF_TABS = ['loads', 'petty', 'trucker-bills'];
  const FOLD_GROUPS = ['Design', 'Bot & Automation', 'Contacts & Outreach', 'System'];
  const GROUP_ORDER = ['Edge Yard', 'Both companies', 'Edge Metals', 'Design', 'Bot & Automation', 'Contacts & Outreach', 'System'];
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
    settings:'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.5 19.4a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 13.7a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 7.5a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10.3 3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.5 2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  };
  // ── end of the copied block ───────────────────────────────────────────

  const NAV_CO_KEY = 'jarvisNavCompany';
  const me = document.currentScript;
  const PAGE = (me && me.dataset && me.dataset.page) || '';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* best effort */ } },
  };
  function icon(id) {
    const d = NAV_ICONS[id] || 'M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4';
    return `<svg class="jv-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
  }
  function hrefFor(id) { return PAGE_HREF[id] || ('/#tab=' + encodeURIComponent(id)); }

  // Hex fallbacks on every token: the pages each carry their own :root, and
  // a page that lacks one must still get a readable rail.
  const CSS = `
html.jv-has-nav body { padding-left:252px; box-sizing:border-box; }
#jvSidebar { position:fixed; inset:0 auto 0 0; width:252px; height:auto; max-height:none; min-height:0; margin:0; border:0; z-index:40; background:var(--steel-950,#0C0E10); display:flex; flex-direction:column; font-family:var(--font-sans,'IBM Plex Sans',system-ui,sans-serif); transition:transform 220ms ease; box-sizing:border-box; }
#jvSidebar *, #jvSidebar *::before, #jvSidebar *::after { box-sizing:border-box; }
#jvSidebar .jv-stripe { height:5px; flex-shrink:0; background-image:repeating-linear-gradient(-45deg, var(--copper-400,#D77E3D) 0, var(--copper-400,#D77E3D) 3px, transparent 3px, transparent 11px); }
#jvSidebar .jv-brand { position:relative; padding:16px 18px 14px; border-bottom:1px solid var(--steel-800,#1E2429); display:flex; align-items:center; gap:10px; }
#jvSidebar .jv-mark { width:30px; height:30px; flex-shrink:0; border-radius:50%; border:2px solid rgba(215,126,61,.9); display:flex; align-items:center; justify-content:center; }
#jvSidebar .jv-mark::after { content:''; width:10px; height:10px; border-radius:50%; background:radial-gradient(circle at 40% 38%, #FFFFFF, #FFE7CB 40%, #FFB877 70%, #D77E3D 100%); box-shadow:0 0 18px rgba(255,214,170,.9); }
#jvSidebar .jv-name { font-family:var(--font-display,'Archivo',sans-serif); font-size:17px; font-weight:800; letter-spacing:.04em; color:#fff; line-height:1.2; }
#jvSidebar .jv-sub { font-family:var(--font-mono,'IBM Plex Mono',monospace); font-size:9.5px; color:var(--steel-400,#7E8891); }
#jvCollapse { position:absolute; top:10px; right:8px; width:24px; height:24px; display:flex; align-items:center; justify-content:center; background:transparent; border:1px solid var(--steel-700,#2B3239); border-radius:2px; color:var(--steel-400,#7E8891); cursor:pointer; font-size:12px; line-height:1; padding:0; }
#jvCollapse:hover { color:#fff; border-color:var(--steel-500,#57616A); }
#jvCompany { display:flex; gap:3px; margin:10px 10px 4px; background:var(--steel-900,#14181B); border-radius:2px; padding:3px; }
#jvCompany button { flex:1; text-align:center; padding:6px 0; border:none; border-radius:1px; background:transparent; color:var(--steel-400,#7E8891); font-family:inherit; font-size:11.5px; font-weight:600; cursor:pointer; }
#jvCompany button:hover { color:#fff; }
#jvCompany button.active { background:var(--leaf-500,#3DA836); color:#fff; }
#jvNav { flex:1; overflow-y:auto; padding:4px 10px 10px; display:flex; flex-direction:column; gap:1px; }
#jvNav.co-yard [data-co-group="Edge Metals"] { display:none; }
#jvNav.co-metals [data-co-group="Edge Yard"] { display:none; }
#jvNav .jv-head { font-family:var(--font-mono,'IBM Plex Mono',monospace); font-size:9.5px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:var(--steel-500,#57616A); padding:6px 13px; }
#jvNav .jv-head.jv-fold { cursor:pointer; display:flex; align-items:center; justify-content:space-between; }
#jvNav .jv-head.jv-fold::after { content:'▾'; font-size:9px; opacity:.7; transition:transform 150ms ease; }
#jvNav .jv-head.jv-fold.shut::after { transform:rotate(-90deg); }
#jvNav a.jv-row { display:flex; align-items:center; gap:10px; width:100%; padding:6px 12px 6px 13px; color:var(--steel-300,#A7B0B7); text-decoration:none; border-left:3px solid transparent; border-radius:2px; font-size:13px; font-weight:600; line-height:1.5; }
#jvNav a.jv-row:hover { background:var(--steel-800,#1E2429); color:#fff; }
#jvNav a.jv-row.active { background:var(--steel-800,#1E2429); color:#fff; border-left-color:var(--leaf-400,#57BE49); }
#jvNav a.jv-row.jv-folded { display:none; }
#jvNav .jv-ico { flex:0 0 16px; width:16px; height:16px; opacity:.62; }
#jvNav a.jv-row.active .jv-ico, #jvNav a.jv-row:hover .jv-ico { opacity:1; }
#jvSidebar .jv-foot { padding:16px 22px 20px; border-top:1px solid var(--steel-800,#1E2429); }
#jvSidebar .jv-role { font-family:var(--font-mono,'IBM Plex Mono',monospace); font-size:9.5px; letter-spacing:.12em; text-transform:uppercase; color:var(--steel-500,#57616A); }
#jvSignout { width:100%; margin-top:12px; padding:9px 12px; background:transparent; border:1px solid var(--steel-700,#2B3239); border-radius:4px; color:var(--steel-300,#A7B0B7); font-family:inherit; font-size:13px; font-weight:600; cursor:pointer; }
#jvSignout:hover { color:#fff; border-color:var(--steel-500,#57616A); }
#jvBurger { display:none; position:fixed; top:14px; left:14px; z-index:41; width:40px; height:40px; align-items:center; justify-content:center; flex-direction:column; gap:5px; background:var(--steel-950,#0C0E10); border:1px solid var(--steel-700,#2B3239); border-radius:4px; cursor:pointer; padding:0; }
#jvBurger span { display:block; width:18px; height:2px; background:#fff; border-radius:2px; }
#jvBackdrop { display:none; position:fixed; inset:0; background:rgba(0,0,0,.55); z-index:39; }
/* Collapsed on a computer = a thin strip down the LEFT with the ☰ in it, not a
   bar across the top. Apsara, 2026-10-10: "Why sidebar coming on top". */
#jvStrip { display:none; position:fixed; left:0; top:0; bottom:0; width:56px; z-index:38; background:var(--steel-950,#0C0E10); border-right:1px solid var(--steel-800,#1E2429); }
html.jv-collapsed body { padding-left:56px; padding-top:0; }
html.jv-collapsed #jvStrip { display:block; }
html.jv-collapsed #jvSidebar { width:min(82vw,300px); transform:translateX(-100%); box-shadow:0 0 50px rgba(0,0,0,.6); }
html.jv-collapsed #jvBurger { display:flex; left:8px; }
#jvSidebar.open { transform:translateX(0) !important; }
#jvBackdrop.open { display:block; }
#jvSidebar.open .jv-brand { padding-left:66px; }
@media (max-width:860px) {
  html.jv-has-nav body, html.jv-collapsed body { padding-left:0; padding-top:58px; }
  html.jv-collapsed #jvStrip { display:none; }
  html.jv-collapsed #jvBurger { left:14px; }
  #jvSidebar { width:min(82vw,300px); transform:translateX(-100%); box-shadow:0 0 50px rgba(0,0,0,.6); }
  #jvBurger { display:flex; }
  #jvCollapse { display:none; }
}
@media print {
  #jvSidebar, #jvBurger, #jvBackdrop, #jvStrip { display:none !important; }
  html.jv-has-nav body, html.jv-collapsed body { padding-left:0 !important; padding-top:0 !important; }
}`;

  function visibleFor(role) {
    const v = NAV_ITEMS.filter((n) => (!n.adminOnly || role === 'admin') && (role !== 'staff' || STAFF_TABS.includes(n.id)));
    const rank = (g) => { const i = GROUP_ORDER.indexOf(g); return i === -1 ? GROUP_ORDER.length : i; };
    return v.slice().sort((a, b) => rank(a.group) - rank(b.group));
  }

  function setCollapsed(on, remember) {
    document.documentElement.classList.toggle('jv-collapsed', on);
    close();
    const b = document.getElementById('jvCollapse');
    if (b) {
      b.innerHTML = on ? '&#8250;' : '&#8249;';
      b.setAttribute('aria-expanded', on ? 'false' : 'true');
      b.setAttribute('aria-label', on ? 'Expand the menu' : 'Collapse the menu');
      b.title = on ? 'Expand the menu' : 'Collapse the menu';
    }
    // Not remembered (see start of render): `remember` is ignored on purpose.
  }
  function close() {
    const s = document.getElementById('jvSidebar'), bd = document.getElementById('jvBackdrop'), bu = document.getElementById('jvBurger');
    if (s) s.classList.remove('open');
    if (bd) bd.classList.remove('open');
    if (bu) bu.setAttribute('aria-expanded', 'false');
  }

  function render(role, isSuper) {
    const items = visibleFor(role);
    const here = NAV_ITEMS.find((n) => n.id === PAGE);
    let co = store.get(NAV_CO_KEY);
    if (co !== 'Edge Yard' && co !== 'Edge Metals') co = 'Edge Yard';
    // Follow the page she is on, as index.html's syncNavCompany does.
    if (here && (here.group === 'Edge Yard' || here.group === 'Edge Metals')) { co = here.group; store.set(NAV_CO_KEY, co); }
    const shut = new Set(FOLD_GROUPS.filter((g) => !items.some((x) => x.group === g && x.id === PAGE)));

    let last = null;
    const rows = items.map((n) => {
      const fold = FOLD_GROUPS.includes(n.group);
      const head = n.group !== last
        ? `<div class="jv-head${fold ? ' jv-fold' + (shut.has(n.group) ? ' shut' : '') : ''}" data-co-group="${esc(n.group)}"${last === null ? '' : ' style="margin-top:14px;"'}>${esc(n.group)}</div>`
        : '';
      last = n.group;
      const active = n.id === PAGE;
      return `${head}<a class="jv-row${active ? ' active' : ''}${shut.has(n.group) ? ' jv-folded' : ''}" href="${esc(hrefFor(n.id))}" data-tab="${esc(n.id)}" data-co-group="${esc(n.group)}" title="${esc(n.label)}"${active ? ' aria-current="page"' : ''}>${icon(n.id)}<span>${esc(n.label)}</span></a>`;
    }).join('');

    // A <div>, not an <aside>: claims.html and quickbooks.html style every
    // <aside> on the page (max-height:42vh under 1020px), which cut the menu
    // in half on a phone. Found by looking at the screenshot, not by a check.
    const aside = document.createElement('div');
    aside.id = 'jvSidebar';
    aside.setAttribute('role', 'navigation');
    aside.setAttribute('aria-label', 'Jarvis menu');
    aside.innerHTML = `
      <div class="jv-stripe"></div>
      <div class="jv-brand">
        <button id="jvCollapse" type="button" aria-label="Collapse the menu" aria-expanded="true" title="Collapse the menu">&#8249;</button>
        <a href="/" class="jv-mark" aria-label="Jarvis home" style="text-decoration:none;"></a>
        <div style="min-width:0; flex:1;"><div class="jv-name">Jarvis</div><div class="jv-sub">Edge Metals ops</div></div>
      </div>
      <div id="jvCompany"${role === 'staff' ? ' style="display:none;"' : ''}>
        <button type="button" data-co="Edge Yard"${co === 'Edge Yard' ? ' class="active"' : ''}>Edge Yard</button>
        <button type="button" data-co="Edge Metals"${co === 'Edge Metals' ? ' class="active"' : ''}>Edge Metals</button>
      </div>
      <nav id="jvNav" class="${co === 'Edge Metals' ? 'co-metals' : 'co-yard'}">${rows}</nav>
      <div class="jv-foot">
        <div class="jv-role">${isSuper ? 'Jarvis access' : role === 'admin' ? 'Admin access' : 'Standard access'}</div>
        <button id="jvSignout" type="button">Sign out</button>
      </div>`;
    const burger = document.createElement('button');
    burger.id = 'jvBurger'; burger.type = 'button';
    burger.setAttribute('aria-label', 'Open the menu'); burger.setAttribute('aria-expanded', 'false');
    burger.innerHTML = '<span></span><span></span><span></span>';
    const backdrop = document.createElement('div');
    backdrop.id = 'jvBackdrop';

    const strip = document.createElement('div');
    strip.id = 'jvStrip';
    strip.setAttribute('aria-hidden', 'true');
    document.body.prepend(strip);
    document.body.prepend(backdrop);
    document.body.prepend(burger);
    document.body.prepend(aside);
    document.documentElement.classList.add('jv-has-nav');

    const nav = aside.querySelector('#jvNav');
    aside.querySelectorAll('#jvCompany button').forEach((b) => b.addEventListener('click', () => {
      store.set(NAV_CO_KEY, b.dataset.co);
      nav.classList.toggle('co-yard', b.dataset.co === 'Edge Yard');
      nav.classList.toggle('co-metals', b.dataset.co === 'Edge Metals');
      aside.querySelectorAll('#jvCompany button').forEach((x) => x.classList.toggle('active', x === b));
    }));
    nav.querySelectorAll('.jv-head.jv-fold').forEach((h) => h.addEventListener('click', () => {
      const s = h.classList.toggle('shut');
      nav.querySelectorAll(`a.jv-row[data-co-group="${h.dataset.coGroup}"]`).forEach((a) => a.classList.toggle('jv-folded', s));
    }));
    burger.addEventListener('click', () => {
      const open = aside.classList.toggle('open');
      backdrop.classList.toggle('open', open);
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    backdrop.addEventListener('click', close);
    aside.querySelector('#jvCollapse').addEventListener('click', () => {
      setCollapsed(!document.documentElement.classList.contains('jv-collapsed'), true);
    });
    aside.querySelector('#jvSignout').addEventListener('click', async () => {
      try { await fetch('/logout', { method: 'POST' }); } catch (e) { /* signing out anyway */ }
      location.href = '/login';
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    // COLLAPSED ON ARRIVAL, on every page that uses this file. Apsara,
    // 2026-10-10: "i want sidebar to be collapsed in all page except landing
    // page". The landing page is the dashboard (index.html), which has its own
    // sidebar and never loads this file, so it is unaffected. Opening the menu
    // here is not remembered and never touches the app's own setting.
    setCollapsed(true, false);
  }

  function start() {
    const st = document.createElement('style');
    st.id = 'jvSidebarCss';
    st.textContent = CSS;
    document.head.appendChild(st);
    fetch('/api/me', { headers: { 'Content-Type': 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => { if (m) render(m.role || 'user', !!m.super); })
      .catch(() => { /* no session: the page's own api() already sends her to /login */ });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  // For tests only — the lists this file draws from.
  if (typeof window !== 'undefined') window.__jvSidebar = { NAV_ITEMS, PAGE_HREF, STAFF_TABS, FOLD_GROUPS, GROUP_ORDER, NAV_ICONS };
})();
