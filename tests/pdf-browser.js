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
