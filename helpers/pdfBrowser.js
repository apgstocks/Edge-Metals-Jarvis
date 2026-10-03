// ── helpers/pdfBrowser.js — PDFs without a second Chromium ────────────────
// Apsara, 2026-10-03: "implement the chromium alternative that you proposed
// so that it wont take up space".
//
// THE PROBLEM
// Every invoice, packing list, proforma, BOL, ledger export and claim
// statement launched its OWN Chromium (300–400 MB), rendered one page and
// closed it — on top of the Chromium WhatsApp already keeps running. On a
// small VM with pm2's max_memory_restart, a document at the wrong moment is
// what pushes the process over and restarts WhatsApp with it.
//
// WHAT THIS DOES INSTEAD
// Opens a TAB in the Chromium WhatsApp already runs (client.pupBrowser), the
// same way helpers/pricelist.js has rendered price-list images since August.
// A tab costs tens of MB, not hundreds, and no launch (~1 s saved per PDF).
//
// WHEN WHATSAPP'S BROWSER IS NOT THERE
// Not connected yet, reconnecting, or — after the planned split — running in
// another process: fall back to ONE shared Chromium of our own, launched on
// first use and closed after IDLE_MS of no documents. So the worst case is
// today's behaviour, minus the launch-per-document, and it never sits in
// memory idle. PDF_BROWSER=own forces this path (the kill switch).
//
// THE DOCUMENTS MUST NOT CHANGE
// Her broker checks these. WhatsApp's browser starts tabs with NO fixed
// viewport (whatsapp-web.js sets defaultViewport: null), while a plain
// puppeteer.launch gives 800x600. pdfFit measures the DOM before printing, so
// every tab gets 800x600 set explicitly — the same box the old per-document
// launch rendered in, whichever browser the tab lives in. Verified by
// rendering every document both ways and comparing the pages pixel by pixel.
//
// pdfQueue still decides how many documents render at once (one). This file
// only decides WHERE.

const puppeteer = require('puppeteer');

const IDLE_MS = Number(process.env.PDF_BROWSER_IDLE_MS) || 60 * 1000;
const VIEWPORT = { width: 800, height: 600 };   // puppeteer.launch's default — what every document was laid out in
const OWN_ARGS = ['--no-sandbox', '--disable-setuid-sandbox'];

// Real pages always have setViewport; the guard is for the test doubles that
// stand in for puppeteer in a few suites.
const fixViewport = async (page) => { if (typeof page.setViewport === 'function') await page.setViewport(VIEWPORT); };

let _getBrowser = () => null;
function init({ getBrowser } = {}) { if (getBrowser) _getBrowser = getBrowser; }

let own = null;            // Promise<Browser> for our fallback Chromium
let idleTimer = null;
let inUse = 0;
const stats = { shared: 0, own: 0, ownLaunches: 0, fellBack: 0 };

function sharedBrowser() {
    if (process.env.PDF_BROWSER === 'own') return null;
    try {
        const b = _getBrowser();
        return b && typeof b.isConnected === 'function' && b.isConnected() ? b : null;
    } catch { return null; }
}

function ownBrowser() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (!own) {
        stats.ownLaunches += 1;
        own = puppeteer.launch({ headless: true, args: OWN_ARGS }).then((b) => {
            // If it dies on its own, the next document launches a fresh one.
            if (typeof b.on === 'function') b.on('disconnected', () => { if (own && own.__b === b) own = null; });
            own.__b = b;
            return b;
        }).catch((e) => { own = null; throw e; });
    }
    return own;
}

function scheduleIdleClose() {
    if (!own || inUse > 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
        idleTimer = null;
        if (inUse > 0 || !own) return;
        const p = own; own = null;
        try { const b = await p; await b.close(); } catch { /* already gone */ }
    }, IDLE_MS);
    if (idleTimer.unref) idleTimer.unref();
}

// Run fn(page) on a fresh tab and ALWAYS close the tab afterwards. A tab left
// open in WhatsApp's browser would be a leak in the one process that must
// stay up, so the close is in finally and its own failure is swallowed.
//
// opts.launchArgs keeps the old escape hatch: a caller that passes its own
// Chromium arguments gets its own one-off Chromium, exactly as before.
async function withPage(fn, opts = {}) {
    if (opts.launchArgs) {
        const b = await puppeteer.launch({ headless: true, args: opts.launchArgs });
        try { const page = await b.newPage(); await fixViewport(page); return await fn(page); }
        finally { try { await b.close(); } catch { /* already gone */ } }
    }

    inUse += 1;
    let page = null;
    try {
        const shared = sharedBrowser();
        if (shared) {
            try { page = await shared.newPage(); stats.shared += 1; }
            catch { page = null; stats.fellBack += 1; }   // WhatsApp's browser went away between the check and the tab
        }
        if (!page) {
            const b = await ownBrowser();
            page = await b.newPage();
            stats.own += 1;
        }
        await fixViewport(page);
        return await fn(page);
    } finally {
        if (page) { try { await page.close(); } catch { /* tab already gone */ } }
        inUse -= 1;
        scheduleIdleClose();
    }
}

async function shutdown() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    const p = own; own = null;
    if (p) { try { const b = await p; await b.close(); } catch { /* gone */ } }
}

const snapshot = () => ({ ...stats, inUse, ownOpen: !!own });

module.exports = { init, withPage, shutdown, snapshot, IDLE_MS, VIEWPORT };
