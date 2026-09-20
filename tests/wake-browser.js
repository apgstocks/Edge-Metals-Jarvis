// ── tests/wake-browser.js ─────────────────────────────────────────────────
// The wake model in a REAL browser, on the REAL dashboard, hearing HER voice
// through the microphone (2026-09-20).
//
// Chromium's fake-microphone flag plays tests/fixtures/wake-her-voice.wav
// into getUserMedia. The page loads dashboard/wake-model.js exactly as it
// ships, runs onnxruntime-web (WebAssembly) on the three models, and must:
//   · stay silent for the first 20 s (her talking, Jarvis answering),
//   · open a capture — through voice.js, with "Yes, boss?" — when she says
//     "Hey Jarvis".
// The browser's own SpeechRecognition is replaced by a mute stub, so the
// ONLY thing that can wake Jarvis in this test is the model.
//
// Needs Chromium: PUPPETEER_EXECUTABLE_PATH=/path/to/chromium. The
// onnxruntime-web files are served from node_modules (ORT_WEB_DIR) in place of
// the CDN, so the test does not depend on the network.

const fs = require('fs');
const path = require('path');
const { boot } = require('./helpers/e2e');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};

(async () => {
    let puppeteer;
    try { puppeteer = require('puppeteer'); } catch (e) { console.log('  SKIPPED  no puppeteer'); process.exit(0); }
    const ortDir = process.env.ORT_WEB_DIR
        || [path.join(__dirname, '..', 'node_modules/onnxruntime-web/dist'), path.join(__dirname, '..', 'desktop/node_modules/onnxruntime-web/dist')]
            .find((d) => fs.existsSync(path.join(d, 'ort.min.js')));
    if (!ortDir) { console.log('  SKIPPED  no onnxruntime-web on disk (set ORT_WEB_DIR)'); process.exit(0); }

    process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'user-pw-wakewakewake';
    const j = await boot({});
    const base = `http://127.0.0.1:${j.port}`;
    const wav = path.join(__dirname, 'fixtures/wake-her-voice.wav');

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required',
                '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
                `--use-file-for-fake-audio-capture=${wav}`],
        });
    } catch (e) {
        console.log('  SKIPPED  no Chromium here (' + e.message.split('\n')[0] + ')');
        await j.stop(); process.exit(0);
    }
    try {
        const page = await browser.newPage();
        const logs = [];
        const t0 = Date.now();
        page.on('console', (m) => logs.push({ t: (Date.now() - t0) / 1000, text: m.text() }));
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const m = /cdn\.jsdelivr\.net\/npm\/onnxruntime-web@[^/]+\/dist\/([^?#]+)/.exec(req.url());
            if (m) {
                const f = path.join(ortDir, m[1]);
                if (!fs.existsSync(f)) return req.respond({ status: 404, body: 'missing ' + m[1] });
                const type = f.endsWith('.wasm') ? 'application/wasm' : f.endsWith('.mjs') || f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
                return req.respond({ status: 200, contentType: type, headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(f) });
            }
            req.continue();
        });
        // A mute recogniser: starts and stops, never hears anything. The model is the only way in.
        await page.evaluateOnNewDocument(() => {
            class Mute { start() { this._on = true; } stop() { this._on = false; if (this.onend) setTimeout(() => this.onend(), 0); } abort() { this.stop(); } }
            window.webkitSpeechRecognition = Mute; window.SpeechRecognition = Mute;
        });
        const login = await (await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: process.env.APP_PASSWORD }) })).json();
        await page.setCookie({ name: 'sid', value: login.sid, url: base });
        await page.goto(base + '/', { waitUntil: 'networkidle0' });

        ck('the page loads the wake model', await page.evaluate(() => !!window.JarvisWake && !!window.OwwCore));
        await page.evaluate(() => window.JarvisVoice.dispatch('USER_TOGGLE'));
        const started = Date.now();
        // Wait for it to be ON (models loaded, mic open), then let the fixture play.
        let st = '';
        for (let i = 0; i < 60 && st !== 'on' && st !== 'failed'; i++) {
            await new Promise((r) => setTimeout(r, 500));
            st = await page.evaluate(() => window.JarvisWake.status + (window.JarvisWake.error ? ': ' + window.JarvisWake.error : ''));
        }
        ck('it starts: models loaded, microphone open', st === 'on', st);
        const onAt = (Date.now() - t0) / 1000;
        await new Promise((r) => setTimeout(r, 50000));   // > one full pass of the 44 s fixture

        const wakes = logs.filter((l) => /heard by the wake model|wake model fired/.test(l.text));
        console.log('        voice.js said:', logs.filter((l) => /wake model/.test(l.text)).map((l) => l.t.toFixed(1) + ' ' + l.text).join(' | '));
        const fires = logs.filter((l) => /^\[WAKE\] "Hey Jarvis"/.test(l.text));
        const info = await page.evaluate(() => ({ fires: window.JarvisWake.fires, peak: window.JarvisWake.peak }));
        console.log('        wake fires at (s):', fires.map((f) => f.t.toFixed(1)).join(', '), '| peak', info.peak.toFixed(2), '| on at', onAt.toFixed(1));
        // The fixture starts playing when the microphone opens; its first 20 s
        // are her talking and Jarvis answering, with no "Hey Jarvis" in them.
        const early = fires.filter((f) => f.t < onAt + 18);
        ck('NO wake while she talks and Jarvis answers (first 20 s of the recording)', early.length === 0,
           early.map((f) => f.t.toFixed(1)).join(', '));
        ck('her "Hey Jarvis" wakes Jarvis in the browser, repeatedly', wakes.length >= 3, JSON.stringify(logs.slice(-15).map((l) => l.text)));
        ck('  and the capture opens (voice.js took it)', logs.some((l) => /heard by the wake model/.test(l.text)));
        ck('  with no inference errors', !logs.some((l) => /\[WAKE\] inference failed/.test(l.text)),
           JSON.stringify(logs.filter((l) => /inference failed/.test(l.text)).slice(0, 2)));
    } finally {
        await browser.close();
        await j.stop();
    }
    console.log(`\n  ${pass} passed, ${fail} failed`);
    if (fail) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  HARNESS FAILED:', e); process.exit(1); });
