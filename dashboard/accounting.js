// ── dashboard/accounting.js — the accounting portal's tab strip ───────────
// Apsara, 2026-10-31: "keep bank,book,workspace,quickbook in one portal..",
// then "It should mimic qb.all accounting under one wing", and — asked
// whether the four old sidebar rows should survive — "Replace them
// immediately".
//
// ── WHY A STRIP AND NOT A FRAME, WHICH IS WHAT I REACHED FOR FIRST ───────
// The obvious build was one /accounting page holding the four in iframes.
// dashboard/sidebar.js stopped me, because she has already decided this:
//
//     "She chose ONE shared file over loading the pages inside a frame,
//      because printing invoices and BOLs from a frame is unreliable."
//
// That reason applies here harder than it did there. books.html has a Print
// button and a "Pack for the CPA" download; quickbooks.html and
// bank-match.html both open modals that need the full viewport. A frame
// would have traded her printing for my tidiness, and she would have found
// out the first time she tried to send her CPA a P&L.
//
// So the portal is what the sidebar already is: ONE shared file, included by
// each page, drawing the same strip with the current tab marked. The four
// pages stay real pages at real URLs. Printing, modals, deep links and the
// back button all behave exactly as they did yesterday, because nothing
// about how they load has changed.
//
// ── THE TAB ORDER IS QUICKBOOKS' ORDER, NOT OURS ─────────────────────────
// "It should mimic qb." QuickBooks runs Banking -> Transactions -> Reports,
// with the connection/admin parts last. The strip follows that, so the thing
// she does daily is first and the thing she does yearly is last.
//
// Migration is deliberately last and deliberately named Migration rather
// than QuickBooks. It is the one tab here with an end date: #176 is about
// proving Jarvis equals QuickBooks so QuickBooks can LEAVE. Giving it a
// peer-of-Reports billing would have been mimicking QuickBooks rather than
// improving on it, which is the half of her instruction that is easy to
// drop.
//
// ── WHAT THIS FILE DOES NOT DO ───────────────────────────────────────────
// It does not merge the pages, and it does not hide that /workspace and
// /bank-match overlap — they share eleven /api/bank/* routes and both show
// bank rows for review. Tabs make that visible instead of fixing it. The
// merge is a separate decision with her, not something to do quietly while
// moving navigation around.
(function () {
    'use strict';
    if (typeof document === 'undefined') return;
    if (document.getElementById('jvAcctTabs')) return;

    // id -> where it lives. The ids match the data-tab each page declares.
    //
    // ── adminOnly IS CARRIED PER TAB, NOT PER PORTAL ─────────────────────
    // The four rows this replaces did NOT agree on who could see them:
    //   QuickBooks  — everyone. "i want to have a separate page where i can
    //                 view everything related to qb" (2026-09-24), and the
    //                 01-core.js comment says explicitly: not adminOnly,
    //                 she asked for everyone who has Jarvis to see it.
    //   Books       — everyone.
    //   Bank        — adminOnly. "this one lists raw bank lines from her
    //                 accounts, which is a narrower thing".
    //   Workspace   — adminOnly.
    //
    // Collapsing them into one rail row forces a single answer, and either
    // answer loses something she decided on purpose: admin-only takes
    // QuickBooks and Books away from staff, everyone-sees-it advertises raw
    // bank rows to a standard login. So the ROW is visible to everyone and
    // the STRIP drops the two admin tabs for a non-admin — each tab keeps
    // the visibility its own page was given. The server gates were already
    // correct and are untouched; this is only about what is advertised.
    const TABS = [
        { id: 'banking',   label: 'Banking',      href: '/workspace', adminOnly: true,
          hint: 'For review, categorised, excluded' },
        { id: 'reconcile', label: 'Reconcile',    href: '/bank-match', adminOnly: true,
          hint: 'Rules, drift, between your companies' },
        { id: 'reports',   label: 'Reports',      href: '/books', adminOnly: false,
          hint: 'P&L, balance sheet, trial balance, CPA pack' },
        { id: 'migration', label: 'Migration',    href: '/quickbooks', adminOnly: false,
          hint: 'QuickBooks parity and cutover — this tab goes away when QuickBooks does' },
    ];

    const script = document.currentScript
        || document.querySelector('script[src*="accounting.js"]');
    const here = (script && script.dataset && script.dataset.tab) || '';

    const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const css = document.createElement('style');
    css.id = 'jvAcctCss';
    css.textContent = `
#jvAcctTabs{position:sticky;top:0;z-index:40;display:flex;align-items:center;gap:2px;
  flex-wrap:wrap;background:#fff;border-bottom:2px solid #2E6DA4;padding:0 0 0 2px;
  margin:0 0 14px;font-family:"Helvetica Neue",Helvetica,Arial,sans-serif}
#jvAcctTabs .jv-acct-name{font-size:11px;letter-spacing:.09em;text-transform:uppercase;
  color:#1F4E79;font-weight:800;padding:0 14px 0 4px;white-space:nowrap}
#jvAcctTabs a{display:inline-block;padding:9px 15px;font-size:13px;color:#44607a;
  text-decoration:none;border:1px solid transparent;border-bottom:0;
  border-radius:4px 4px 0 0;margin-bottom:-2px;white-space:nowrap}
#jvAcctTabs a:hover{background:#F4F9FD;color:#1F4E79}
#jvAcctTabs a.on{background:#fff;color:#1F4E79;font-weight:700;
  border-color:#2E6DA4 #2E6DA4 #fff;border-bottom:2px solid #fff}
#jvAcctTabs a.last{margin-left:auto;color:#777;font-size:12px}
#jvAcctTabs a.last.on{color:#1F4E79}
@media print{#jvAcctTabs,#jvAcctCss{display:none !important}}
@media (max-width:760px){#jvAcctTabs .jv-acct-name{display:none}
  #jvAcctTabs a{padding:8px 10px;font-size:12px}
  #jvAcctTabs a.last{margin-left:0}}
`;
    document.head.appendChild(css);

    const bar = document.createElement('nav');
    bar.id = 'jvAcctTabs';
    bar.setAttribute('aria-label', 'Accounting');

    function draw(isAdmin) {
        const show = TABS.filter((t) => isAdmin || !t.adminOnly);
        bar.innerHTML = '<span class="jv-acct-name">Accounting</span>'
            + show.map((t, i) => `<a href="${esc(t.href)}" data-acct="${esc(t.id)}"`
                + ` class="${t.id === here ? 'on' : ''}${i === show.length - 1 ? ' last' : ''}"`
                + ` title="${esc(t.hint)}"`
                + `${t.id === here ? ' aria-current="page"' : ''}>${esc(t.label)}</a>`).join('');
    }
    // Drawn immediately for an admin, which is who is on these pages almost
    // always, then corrected if /api/me says otherwise. Waiting on the fetch
    // would leave the top of the page empty and jumping on every load.
    draw(true);
    try {
        fetch('/api/me', { credentials: 'same-origin' })
            .then((r) => (r.ok ? r.json() : null))
            .then((me) => {
                if (!me) return;
                const role = me.role || (me.user && me.user.role) || '';
                if (role !== 'admin' && !me.super && !me.is_super) draw(false);
            })
            .catch(() => { /* leave the strip as drawn; the server still gates */ });
    } catch (e) { /* no fetch in this environment */ }

    // Before the page's own first element, never appended to <body>: these
    // pages end with their own scripts, and a strip after them lands under
    // the footer. Placed after the sidebar's rail if that has already run,
    // so the two do not fight over the top-left corner.
    function mount() {
        if (document.getElementById('jvAcctTabs')) return;
        const body = document.body;
        if (!body) return;
        body.insertBefore(bar, body.firstChild);
    }
    // MOUNT ON WHAT EXISTS, NOT ON AN EVENT. The first version keyed off
    // document.readyState === 'loading' and waited for DOMContentLoaded.
    // That is correct in a browser with defer, and silently NEVER FIRES in
    // a harness that evaluates the file after the document has settled — so
    // the strip was absent and the stylesheet was present, which is the
    // exact shape of a boot bug that looks like it worked.
    //
    // body is the only thing mount needs. If it is there, mount; if it is
    // not, wait for the event AND poll, so neither path can be the only one.
    if (document.body) {
        mount();
    } else {
        document.addEventListener('DOMContentLoaded', mount);
        const t = setInterval(() => {
            if (document.body) { clearInterval(t); mount(); }
        }, 20);
        setTimeout(() => clearInterval(t), 10000);
    }

    // Exposed for tests/accounting-portal.js, which renders this file in
    // JSDOM and asserts the real strip — not a regex over the source. The
    // claims page was dead for six days behind source-regex checks.
    try { window.JarvisAccountingTabs = TABS; } catch (e) { /* no window */ }
})();
