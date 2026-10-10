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

// ── A CONNECTED BROWSER IS NOT NECESSARILY A WORKING ONE ─────────────────
// Apsara, 2026-10-10: "Navigation timeout of 30000 ms exceeded when i click
// download invoice."
//
// Every document renders in a TAB of the Chromium WhatsApp runs (since
// 2026-10-03, to stop launching a 300–400 MB browser per PDF). That browser
// is driven by whatsapp-web.js and is doing its own work: when it is
// reconnecting, throttled, or wedged, a new tab opens and then sits there —
// setContent never resolves and puppeteer throws at its 30-second default.
//
// sharedBrowser() only asked `isConnected()`, which a WEDGED browser answers
// true to. So once WhatsApp's Chromium stopped being responsive, every
// invoice, packing list, BOL, proforma and ledger export failed the same way,
// for ever, with no path back. There was a kill switch — PDF_BROWSER=own —
// but it needs a human to notice, decide and restart, which is thirty
// minutes she does not have with a buyer waiting on an invoice.
//
// Two changes, both here so no template and no caller moves:
//
//   1 THE SHARED TAB GETS A SHORTER LEASH. 10 seconds, not 30. Every
//     document is inline HTML with no remote images or fonts, so a tab that
//     has not finished in ten seconds is not slow, it is stuck.
//   2 A FAILURE THERE FALLS BACK TO OUR OWN CHROMIUM AND RETRIES ONCE, and
//     marks WhatsApp's browser untrusted for a cooldown so the next document
//     does not pay the ten seconds again.
//
// Retrying is safe because every withPage callback in this repo renders and
// returns — invoicePdf, bolPdf, proformaPdf and ledgerExport all write their
// files outside it. A callback that wrote inside would double-write, so
// opts.noRetry exists for one that ever does.
const SHARED_MS = Number(process.env.PDF_SHARED_TIMEOUT_MS) || 10 * 1000;
const COOLDOWN_MS = Number(process.env.PDF_SHARED_COOLDOWN_MS) || 5 * 60 * 1000;

// Real pages always have setViewport; the guard is for the test doubles that
// stand in for puppeteer in a few suites.
const fixViewport = async (page) => { if (typeof page.setViewport === 'function') await page.setViewport(VIEWPORT); };
// Same guard, same reason. Bounding the SHARED tab only: our own Chromium
// keeps puppeteer's 30s, because by then it is the last resort and a slow
// answer beats no document.
const setLeash = async (page, ms) => {
    if (typeof page.setDefaultNavigationTimeout === 'function') page.setDefaultNavigationTimeout(ms);
    if (typeof page.setDefaultTimeout === 'function') page.setDefaultTimeout(ms);
};

let _getBrowser = () => null;
// ── THE LAUNCHER IS INJECTABLE, FOR THE SAME REASON plaid.js TAKES ONE ───
// The fallback path — WhatsApp's browser is wedged, launch our own — is the
// most important behaviour in this file and the hardest to reach: it needs a
// browser that accepts a tab and then stops answering, which no real Chromium
// will do on demand. Stubbing `require('puppeteer').launch` does not work
// (the property is not writable), so the seam is here instead of in the test.
let _launch = (opts) => puppeteer.launch(opts);
function init({ getBrowser, launch } = {}) {
    if (getBrowser) _getBrowser = getBrowser;
    if (launch) _launch = launch;
}

let own = null;            // Promise<Browser> for our fallback Chromium
let idleTimer = null;
let inUse = 0;
// `stalled` is when WhatsApp's browser last failed us; until the cooldown
// passes every document goes straight to our own Chromium. Reported in
// snapshot() so /healthz and the log can say WHY documents are slower.
let stalledAt = 0;
let stalledWhy = null;
const stats = { shared: 0, own: 0, ownLaunches: 0, fellBack: 0, stalls: 0, retried: 0 };

const sharedIsCoolingOff = (now = Date.now()) => stalledAt > 0 && (now - stalledAt) < COOLDOWN_MS;

function sharedBrowser() {
    if (process.env.PDF_BROWSER === 'own') return null;
    // The browser said it was connected and then did not answer. isConnected()
    // will still say true, so the only way to not ask it again is to remember.
    if (sharedIsCoolingOff()) return null;
    try {
        const b = _getBrowser();
        return b && typeof b.isConnected === 'function' && b.isConnected() ? b : null;
    } catch { return null; }
}

// Called when a document fails on the shared tab. Loud on purpose: this line
// is the whole diagnosis if it happens again.
function markStalled(e) {
    stalledAt = Date.now();
    stalledWhy = String((e && e.message) || e || 'unknown').split('\n')[0].slice(0, 200);
    stats.stalls += 1;
    console.error(`[PDF] WhatsApp's Chromium did not finish this document in ${SHARED_MS}ms `
        + `— falling back to our own browser for the next ${Math.round(COOLDOWN_MS / 60000)} min. `
        + `Cause: ${stalledWhy}`);
}

function ownBrowser() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (!own) {
        stats.ownLaunches += 1;
        own = Promise.resolve(_launch({ headless: true, args: OWN_ARGS })).then((b) => {
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
        const b = await _launch({ headless: true, args: opts.launchArgs });
        try { const page = await b.newPage(); await fixViewport(page); return await fn(page); }
        finally { try { await b.close(); } catch { /* already gone */ } }
    }

    inUse += 1;
    try {
        // ── FIRST CHOICE: A TAB IN WHATSAPP'S CHROMIUM ───────────────────
        const shared = sharedBrowser();
        if (shared) {
            let page = null;
            try {
                page = await shared.newPage();
                stats.shared += 1;
                await fixViewport(page);
                await setLeash(page, SHARED_MS);
                return await fn(page);
            } catch (e) {
                // Getting the tab at all failing is the old case — WhatsApp's
                // browser went away between the check and the tab — and is
                // just a fall-back, not a stall. A failure once we HAD the
                // tab is the one worth remembering.
                if (page) { markStalled(e); if (opts.noRetry) throw e; stats.retried += 1; }
                else stats.fellBack += 1;
            } finally {
                if (page) { try { await page.close(); } catch { /* tab already gone */ } }
            }
        }

        // ── SECOND CHOICE, AND THE LAST ONE ──────────────────────────────
        // Our own Chromium, with puppeteer's normal timeout: by here it is
        // this or no document.
        let page = null;
        try {
            const b = await ownBrowser();
            page = await b.newPage();
            stats.own += 1;
            await fixViewport(page);
            return await fn(page);
        } finally {
            if (page) { try { await page.close(); } catch { /* tab already gone */ } }
        }
    } finally {
        inUse -= 1;
        scheduleIdleClose();
    }
}

async function shutdown() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    const p = own; own = null;
    if (p) { try { const b = await p; await b.close(); } catch { /* gone */ } }
}

const snapshot = () => ({
    ...stats, inUse, ownOpen: !!own,
    // So "why are documents slow today" has an answer without reading a log.
    sharedStalled: sharedIsCoolingOff(),
    sharedStalledWhy: sharedIsCoolingOff() ? stalledWhy : null,
    sharedStalledAt: stalledAt ? new Date(stalledAt).toISOString() : null,
});

// Tests need to put the module back to a known state; nothing in the app
// calls this. Exported rather than reaching into the closure from a test,
// which is the thing that rots the moment the closure changes.
function _resetForTests() {
    stalledAt = 0; stalledWhy = null; inUse = 0;
    for (const k of Object.keys(stats)) stats[k] = 0;
}

module.exports = { init, withPage, shutdown, snapshot, _resetForTests,
    IDLE_MS, VIEWPORT, SHARED_MS, COOLDOWN_MS };
