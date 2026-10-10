// ── tests/pdf-browser.js ──────────────────────────────────────────────────
// Apsara, 2026-10-03: "implement the chromium alternative that you proposed
// so that it wont take up space".
//
// Real Chromium, real tabs. A browser launched exactly the way
// whatsapp-web.js launches its own (its puppeteer, defaultViewport null)
// stands in for client.pupBrowser. Checks the four promises the change
// makes: no second Chromium while WhatsApp's is up, no tab left behind in
// WhatsApp's browser, a working fallback when it is down, and the same
// 800x600 box every document was always laid out in.
//
// Skips cleanly where Chromium cannot start (an ARM sandbox with x86 builds).

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
process.env.JARVIS_TEST = '1';
process.env.PDF_BROWSER_IDLE_MS = '400';

let pass = 0, fail = 0; const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    console.log('\n=== source: no document launches its own Chromium ===');
    for (const f of ['helpers/invoicePdf.js', 'helpers/proformaPdf.js', 'helpers/bolPdf.js',
                     'helpers/ledgerExport.js', 'helpers/claims/report.js']) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        ck(`${f}: no puppeteer.launch`, !/puppeteer\.launch/.test(src));
        ck(`${f}: renders through pdfBrowser.withPage`, /pdfBrowser'\)\.withPage\(/.test(src));
    }
    const idx = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
    ck('index.js hands WhatsApp\'s browser to pdfBrowser', /pdfBrowser'\)\.init\(\{ getBrowser: \(\) => client\.pupBrowser \}\)/.test(idx));

    // ══════════════════════════════════════════════════════════════════════
    // ── A CONNECTED BROWSER THAT DOES NOT ANSWER ──────────────────────────
    // Apsara, 2026-10-10: "Navigation timeout of 30000 ms exceeded when i
    // click download invoice."
    //
    // WhatsApp's Chromium hands out the tab and then stops responding —
    // reconnecting, throttled, or wedged. isConnected() still says true, so
    // sharedBrowser() kept choosing it and EVERY document failed the same
    // way, for ever, with no path back but a human noticing and setting
    // PDF_BROWSER=own.
    //
    // Fake browsers, deliberately: this is about the DECISION pdfBrowser
    // makes, and it has to be checked on the machines that cannot start
    // Chromium too — which is every machine this suite runs on today, since
    // the real-Chromium half below skips. The bug would have shipped behind
    // that skip.
    // ══════════════════════════════════════════════════════════════════════
    {
        const pb = require(path.join(ROOT, 'helpers/pdfBrowser'));
        const mkPage = ({ hang = false } = {}) => ({
            closed: false,
            setViewport: async () => {},
            leash: null,
            setDefaultNavigationTimeout(ms) { this.leash = ms; },
            setDefaultTimeout(ms) { this.leash = ms; },
            // A hanging tab: the render never finishes and puppeteer throws
            // its TimeoutError at whatever leash it was given.
            render: async () => { if (hang) { const e = new Error('Navigation timeout of 10000 ms exceeded'); e.name = 'TimeoutError'; throw e; } return 'PDF'; },
            close: async function () { this.closed = true; },
        });
        const mkBrowser = (opts = {}) => {
            const pages = [];
            return { pages, isConnected: () => true,
                newPage: async () => { const pg = mkPage(opts); pages.push(pg); return pg; } };
        };

        console.log('\n=== a wedged WhatsApp browser falls back instead of failing ===');
        const wedged = mkBrowser({ hang: true });
        const ours = mkBrowser({ hang: false });
        // Stand in for puppeteer.launch's result without launching anything.
        pb._resetForTests();
        pb.init({ getBrowser: () => wedged, launch: async () => ours });

        try {
            // Caught, not awaited bare: a mutation that stops the retry makes
            // withPage THROW, and an uncaught throw here crashes the file
            // instead of naming the property that was lost.
            let out = null, threw = null;
            try { out = await pb.withPage(async (page) => page.render()); } catch (e) { threw = e; }
            ck('a document still comes back when WhatsApp\'s browser hangs',
               out === 'PDF', threw ? ('threw: ' + threw.message) : String(out));
            ck('  it was tried on WhatsApp\'s browser first', wedged.pages.length === 1,
               String(wedged.pages.length));
            ck('  and the tab there was CLOSED, not leaked into the one process that must stay up',
               !!wedged.pages[0] && wedged.pages[0].closed === true,
               JSON.stringify(!!wedged.pages[0]));
            ck('  then rendered on our own Chromium', ours.pages.length === 1);
            const snap = pb.snapshot();
            ck('  and the stall is recorded, so "why was that slow" has an answer',
               snap.sharedStalled === true && /timeout/i.test(snap.sharedStalledWhy || ''),
               JSON.stringify(snap.sharedStalledWhy));

            // ── AND THE NEXT DOCUMENT DOES NOT PAY THE SAME TEN SECONDS ───
            // Without the cooldown every invoice would re-test the wedged
            // browser. With five people downloading at once that is five more
            // ten-second waits for nothing.
            const before = wedged.pages.length;
            const out2 = await pb.withPage(async (page) => page.render());
            ck('the NEXT document skips the wedged browser entirely',
               out2 === 'PDF' && wedged.pages.length === before,
               `${before} → ${wedged.pages.length}`);
            ck('  going straight to the one that works', ours.pages.length === 2);

            // ── A HEALTHY SHARED BROWSER IS STILL PREFERRED ───────────────
            // The whole point of 2026-10-03 was to stop launching a 300–400MB
            // Chromium per document. The fallback must not quietly become the
            // normal path.
            pb._resetForTests();
            const healthy = mkBrowser({ hang: false });
            pb.init({ getBrowser: () => healthy, launch: async () => ours });
            let out3 = null;
            try { out3 = await pb.withPage(async (page) => page.render()); } catch (e) { out3 = 'threw: ' + e.message; }
            ck('a working WhatsApp browser is still used, not our own',
               out3 === 'PDF' && healthy.pages.length === 1 && ours.pages.length === 2,
               `shared ${healthy.pages.length} own ${ours.pages.length} out ${out3}`);
            ck('  and its tab is closed too',
               !!healthy.pages[0] && healthy.pages[0].closed === true,
               JSON.stringify(!!healthy.pages[0]));

            // ── APPLIED, not merely DECLARED ─────────────────────────────
            // This first asserted `pb.SHARED_MS === 10000` — the value of a
            // constant, which stays true when the line that USES it is
            // deleted. The mutation "the shared tab goes back to the 30s
            // default leash" survived it. What matters is that the tab was
            // handed the shorter leash.
            ck('the shared tab is actually GIVEN the short leash',
               !!wedged.pages[0] && wedged.pages[0].leash === pb.SHARED_MS,
               wedged.pages[0] ? String(wedged.pages[0].leash) : 'no shared tab was opened at all');
            ck('  which is 10 seconds, not puppeteer\'s 30',
               pb.SHARED_MS === 10000, String(pb.SHARED_MS));
            ck('  and our own Chromium keeps the full one, being the last resort',
               !!ours.pages[0] && ours.pages[0].leash === null,
               ours.pages[0] ? String(ours.pages[0].leash) : 'our own browser was never used');
        } finally {
            pb._resetForTests();
            // Put the real launcher back, or every suite after this one in the
            // same process renders into a fake browser.
            pb.init({ getBrowser: () => null, launch: (o) => require('puppeteer').launch(o) });
        }
    }

    let waPup;
    try { waPup = require(path.join(ROOT, 'node_modules/whatsapp-web.js/node_modules/puppeteer')); }
    catch { waPup = require('puppeteer'); }
    let wa;
    try {
        wa = await waPup.launch({ headless: true, defaultViewport: null,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
    } catch (e) {
        console.log('\n  SKIP  Chromium cannot start here: ' + e.message.split('\n')[0]);
        console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
    }

    const pb = require(path.join(ROOT, 'helpers/pdfBrowser'));
    pb.init({ getBrowser: () => wa });
    const tabsBefore = (await wa.pages()).length;

    console.log('\n=== WhatsApp browser up: a tab, not a Chromium ===');
    const vp = await pb.withPage(async (page) => {
        await page.setContent('<p>x</p>');
        return page.evaluate(() => [innerWidth, innerHeight]);
    });
    let s = pb.snapshot();
    ck('rendered in the shared browser', s.shared === 1 && s.own === 0, JSON.stringify(s));
    ck('no Chromium of its own launched', s.ownLaunches === 0);
    ck('tab is 800x600, the size every document was laid out in', vp[0] === 800 && vp[1] === 600, String(vp));
    ck('tab closed afterwards', (await wa.pages()).length === tabsBefore);

    console.log('\n=== a document that throws still closes its tab ===');
    let threw = false;
    try { await pb.withPage(async (page) => { await page.setContent('<p>x</p>'); throw new Error('boom'); }); }
    catch (e) { threw = e.message === 'boom'; }
    ck('error reaches the caller', threw);
    ck('tab still closed', (await wa.pages()).length === tabsBefore);

    console.log('\n=== PDF_BROWSER=own: the kill switch ===');
    process.env.PDF_BROWSER = 'own';
    await pb.withPage(async (page) => page.setContent('<p>x</p>'));
    s = pb.snapshot();
    ck('used its own Chromium', s.own === 1 && s.ownLaunches === 1, JSON.stringify(s));
    delete process.env.PDF_BROWSER;

    console.log('\n=== own Chromium closes itself when idle ===');
    await sleep(900);
    ck('closed after idle', pb.snapshot().ownOpen === false, JSON.stringify(pb.snapshot()));

    console.log('\n=== WhatsApp browser gone: falls back, reuses one Chromium ===');
    await wa.close();
    await pb.withPage(async (page) => page.setContent('<p>a</p>'));
    await pb.withPage(async (page) => page.setContent('<p>b</p>'));
    s = pb.snapshot();
    ck('both documents rendered', s.own === 3, JSON.stringify(s));
    ck('one launch for the two back-to-back documents', s.ownLaunches === 2, JSON.stringify(s));
    const pdf = await pb.withPage(async (page) => { await page.setContent('<h1>ok</h1>'); return Buffer.from(await page.pdf()); });
    ck('and the fallback still produces a real PDF', pdf.slice(0, 4).toString() === '%PDF');

    await pb.shutdown();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED:\n  ' + failures.join('\n  ')); process.exit(1); }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
