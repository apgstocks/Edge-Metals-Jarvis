// routes/pages.js — split from api.js (helpers/sourceParts.js reconstructs the original)
const cfg = require('../config');
const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function (app, ctx) {
// @@chunk-start
    app.get('/address-book', (req, res) => {
        res.sendFile(path.join(cfg.ROOT, 'dashboard', 'address-book.html'));
    });

    // Design → BOL, the per-customer field picker. Same standalone-page
    // pattern as address-book above and registered before the static mount
    // for the same reason. Under /design/ rather than at the root because
    // the proforma and the invoice have the same per-customer problem and
    // will want /design/proforma next to it.
    app.get('/design/bol', (req, res) => {
        res.sendFile(path.join(cfg.ROOT, 'dashboard', 'design-bol.html'));
    });

    // Quote requests comparison table — same standalone-page pattern as
    // address-book above, registered before the static mount for the same reason.
    app.get('/quote-requests', (req, res) => {
        res.sendFile(path.join(cfg.ROOT, 'dashboard', 'quote-requests.html'));
    });

    // Outbound loads (sales to buyers) — same standalone-page pattern as
    // address-book/quote-requests above. See helpers/outboundLoads.js.
    app.get('/outbound-loads', (req, res) => {
        res.sendFile(path.join(cfg.ROOT, 'dashboard', 'outbound-loads.html'));
    });

    // Documents (Invoice / Proforma / Verification) — same standalone-page
    // pattern as address-book/quote-requests/outbound-loads above. Proforma
    // subtab is fully wired (see dashboard/documents.html); Invoice and
    // Verification subtabs are still placeholders as of this patch.
    // ── desktop/melspec.js, for the browser's end-of-turn model ──────────
    // ONE implementation of Whisper's log-mel features: the Mac app's main
    // process requires desktop/melspec.js, and dashboard/turn-model.js gets
    // the same file here, wrapped so its top-level consts stay private.
    // Copying it into dashboard/ would give two ports of a function whose
    // whole header is about how easily it goes subtly wrong.
    app.get('/melspec.js', (req, res) => {
        try {
            const src = fs.readFileSync(path.join(cfg.ROOT, 'desktop', 'melspec.js'), 'utf8');
            res.set('Content-Type', 'text/javascript; charset=utf-8');
            res.set('Cache-Control', 'no-cache');
            res.send('(function(){var module={exports:{}};\n' + src + '\nwindow.JarvisMelspec=module.exports;})();\n');
        } catch (e) { res.status(500).type('text/javascript').send('/* melspec unavailable: ' + String(e.message).replace(/\*\//g, '') + ' */'); }
    });

    // ── THE BOOKS PORTAL ─────────────────────────────────────────────────
    // Its own page, like /quickbooks, because it answers a different question
    // (#170). Served explicitly rather than by static middleware so that
    // scripts/check-route-reach.js and the screens registry can both see it.
    app.get('/books', (req, res) => {
        res.sendFile(path.join(cfg.ROOT, 'dashboard', 'books.html'));
    });

    app.get('/documents', (req, res) => {
        res.sendFile(path.join(cfg.ROOT, 'dashboard', 'documents.html'));
    });

    // Edge Inventory — per-supplier deliveries and their running account.
    // Same standalone-page pattern as outbound-loads/documents above. Edge
    // METALS; the yard's inventory is the Loads tab. See the headers of
    // helpers/edgeInventory.js and helpers/supplierAccount.js.
    app.get('/edge-inventory', (req, res) => {
        res.sendFile(path.join(cfg.ROOT, 'dashboard', 'edge-inventory.html'));
    });

    // ── QuickBooks, all of it, on one page ────────────────────────────────
    // Apsara, 2026-09-24: "i want to have a separate page where i can view
    // everything related to qb especially these Supplier specific things…If i
    // keep on creating a separate page for each supplier,then it increases
    // exponentially." One page, one party at a time, picked from a list.
    // The page and its /api/qb/* routes live in helpers/quickbooks/routes.js
    // so this file keeps its shape; reads are open, every change needs the
    // padlock open AND an admin session, because it can reach the live books.
    require('./helpers/quickbooks/routes').mount(app, cfg);

    // ── Bank details and their documents (Documents → Bank) ───────────────
    // Apsara, 2026-09-24: "Create a Bank tab under documents in webiste" and
    // "also have a option to upload under Bank. Keep storing the documents".
    // The numbers live in qb-settings/bank-accounts.json (git); the scans live
    // in DATA_DIR/bank-docs/<account>/ (not git). helpers/bankDocs.js holds
    // the four routes so this file keeps its shape.
    require('./helpers/bankDocs').mount(app, cfg);

    // ── The bank matcher ──────────────────────────────────────────────────
    // Apsara, 2026-10-05: "My biggest problem is matching only." One deposit
    // against several invoices, advance then balance, and the names her bank
    // puts on a wire. helpers/bankMatch.js is the engine, helpers/bankLearn.js
    // is what it learns, and this mount is the thing helpers/reconcile.js
    // never got — reconcile.js has been unreachable since 3 September with 41
    // green checks and no caller, which is why scripts/check-route-reach.js
    // now fails on a matcher nothing calls.
    //
    // Read-only. Confirming a match posts to POST /api/sales-receipts, the
    // route the receipts screen already uses, so there is exactly one way to
    // mark an invoice paid.
    require('./helpers/bankMatchRoutes').mount(app, cfg);
    // Transfers between her own companies, recorded as loans — its own file
    // because it writes books and bankMatchRoutes.js deliberately does not.
    require('./helpers/interCompanyRoutes').mount(app);
    // ── THE LEDGER PLAN ROUTES ───────────────────────────────────────────
    // Apsara, 2026-10-08: the agent that can "remove this container from
    // the <billno>… and then match it with this payment". Preview and
    // apply, split so there is a moment at which she has seen the figures
    // and not yet committed to them. helpers/ledgerPlan.js and
    // ledgerApply.js were both written today and reached by nothing until
    // this line — the state helpers/reconcile.js sat in for a month.
    require('./helpers/ledgerPlanRoutes').mount(app, cfg);

    // ── Weight-shortage claims (Edge Metals) ──────────────────────────────
    // Apsara, 2026-09-26: "Revamp weight shortage sheet .. it should read the
    // mail with weight shortage detail and create automatically". The page and
    // its /api/claims routes live in helpers/claims/routes.js so this file
    // keeps its shape. /api/claims is deliberately NOT in
    // STAFF_ALLOWED_PATH_PREFIXES — staff are scoped to Loads, and a claim
    // carries the customer's complaint and Edge's margin.
    require('./helpers/claims/routes').mount(app, cfg);

    // Old standalone Contact Quotes page — MERGED into /quote-requests
    // 2026-08-16 per Apsara ("Contact Quotes and Quote Requests... both are
    // same"). dashboard/contact-quote-requests.html still exists on disk
    // (unreferenced from nav) but this route now redirects any stale
    // bookmark/link straight to the merged page instead of serving it.
    app.get('/contact-quote-requests', (req, res) => {
        res.redirect(301, '/quote-requests');
    });

    // ── Static dashboard ──────────────────────────────────────────────────────
    // no-cache on .html specifically — added 2026-08-15 after a real support
    // case: two rounds of PDF fixes landed in dashboard/index.html, both
    // pushed and pulled onto the VM, and Apsara still saw old button
    // behavior in her browser. express.static's default sends NO
    // Cache-Control header at all, which leaves each browser free to use its
    // own heuristic freshness lifetime for static-looking files — exactly
    // the kind of silent staleness that looks identical to "the deploy
    // didn't happen" from the user's side but isn't fixable by anything on
    // the server. Forcing revalidation on every load costs nothing (this
    // dashboard is a handful of KB, not a CDN-scale asset) and removes an
    // entire class of "I pulled the fix, why don't I see it" confusion.
    // Icons/manifest are left on express.static's default — they're inert
    // once generated and don't carry this risk.
    // ── AND THE PAGE CARRIES THE BUILD IT WAS SERVED FROM ────────────────
    // Apsara, 2026-09-19, five rounds into "undo not there in jarvis
    // profile": the Bills footer said "build 9861a0d" and the fix in 9861a0d
    // was not on her screen.
    //
    // The footer was not lying, it was answering a different question. It
    // reads /api/health — the SERVER's commit — while the markup she is
    // looking at came from a separately cached static file. So a stale tab
    // reports the new build perfectly happily, which is worse than reporting
    // nothing: it retires the one check we had.
    //
    // The header above already forces revalidation and has since 2026-08-15,
    // for this same symptom. It is necessary and it is not sufficient — a
    // proxy, a restored tab or a browser that ignores it all land in the same
    // place, and none of them are fixable from here. What IS fixable is
    // making the page SAY which build it is, so the two can be compared.
    //
    // Substituted at send time rather than written into the file, because a
    // commit id committed into the file it describes is a chicken and an egg.
    // Only files that actually carry the token are touched; everything else
    // falls through to express.static untouched.
    const BUILD_TOKEN = '{{JARVIS_BUILD}}';
    app.get(/\.html$|^\/$/, (req, res, next) => {
        const rel = req.path === '/' ? 'index.html' : req.path.replace(/^\/+/, '');
        const file = path.join(cfg.ROOT, 'dashboard', rel);
        // ── SECOND LINE, NOT THE FIRST ───────────────────────────────
        // Express normalises req.path before routing — "/../package.json"
        // arrives as "/package.json" and "%2f" is never decoded into a
        // separator — so no request can currently walk out of this directory,
        // and a mutation deleting this line does not turn any test red.
        // Said plainly rather than left looking load-bearing.
        //
        // It stays because the thing below it is a filesystem read named by
        // user input, and the day someone reaches for req.url or adds a
        // decodeURIComponent, this is what is standing there.
        if (!file.startsWith(path.join(cfg.ROOT, 'dashboard') + path.sep)) return next();
        let html;
        try { html = fs.readFileSync(file, 'utf8'); } catch (e) { return next(); }
        if (!html.includes(BUILD_TOKEN)) return next();
        let sha = 'unknown';
        try { sha = (require('./helpers/version').running() || {}).short || 'unknown'; } catch (e) {}
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        res.type('html').send(html.split(BUILD_TOKEN).join(sha));
    });

    app.use('/', express.static(path.join(cfg.ROOT, 'dashboard'), {
        setHeaders: (res, filePath) => {
            if (filePath.endsWith('.html')) {
                res.setHeader('Cache-Control', 'no-cache, must-revalidate');
            }
        },
    }));
// @@chunk-end

};
