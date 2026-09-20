// ── tests/turn-browser.js ─────────────────────────────────────────────────
// The end-of-turn model in a REAL browser, on HER sentences (2026-09-20).
//
// tests/fixtures/wake-her-voice.wav, 10.5 s → 17 s, is her saying "What's
// up — what needs my attention?" and stopping. Cut at 12.5 s it is the same
// sentence stopped half-way. Chrome must load Smart Turn (served here from a
// local copy instead of Hugging Face — SMART_TURN_MODEL), featurise it with
// /melspec.js (which IS desktop/melspec.js) and tell the two apart.
//
// Needs Chromium and onnxruntime-web on disk; SKIPPED otherwise.

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
    const turnModel = process.env.SMART_TURN_MODEL
        || path.join(require('os').homedir(), 'Library', 'Application Support', 'Jarvis', 'models', 'smart-turn-v3.2-cpu.onnx');
    if (!ortDir || !fs.existsSync(turnModel)) {
        console.log('  SKIPPED  needs onnxruntime-web (ORT_WEB_DIR) and the Smart Turn model (SMART_TURN_MODEL, or cd desktop && npm run model:turn)');
        process.exit(0);
    }

    const buf = fs.readFileSync(path.join(__dirname, 'fixtures/wake-her-voice.wav'));
    // Read the data chunk by its declared length: a WAV may carry other
    // chunks before or AFTER it (ffmpeg writes LIST, other tools append).
    const dPos = buf.indexOf('data');
    const dLen = buf.readUInt32LE(dPos + 4);
    const di = dPos + 8;
    const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset + di, buf.byteOffset + di + (Math.min(dLen, buf.length - di) & ~1)));
    const seg = (a, z) => Array.from(pcm.subarray(Math.round(a * 16000), Math.round(z * 16000)), (v) => v / 32768);

    process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'user-pw-turnturnturn';
    const j = await boot({});
    const base = `http://127.0.0.1:${j.port}`;
    let browser;
    try {
        browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    } catch (e) { console.log('  SKIPPED  no Chromium here'); await j.stop(); process.exit(0); }
    try {
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const u = req.url();
            let f = null, type = 'application/octet-stream';
            const m = /cdn\.jsdelivr\.net\/npm\/onnxruntime-web@[^/]+\/dist\/([^?#]+)/.exec(u);
            if (m) { f = path.join(ortDir, m[1]); type = f.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'; }
            if (/huggingface\.co\/pipecat-ai\/smart-turn-v3\//.test(u)) f = turnModel;
            if (f) return req.respond({ status: fs.existsSync(f) ? 200 : 404, contentType: type,
                headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.existsSync(f) ? fs.readFileSync(f) : 'missing' });
            req.continue();
        });
        await page.evaluateOnNewDocument(() => {
            class Mute { start() {} stop() { if (this.onend) setTimeout(() => this.onend(), 0); } abort() { this.stop(); } }
            window.webkitSpeechRecognition = Mute; window.SpeechRecognition = Mute;
        });
        const login = await (await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: process.env.APP_PASSWORD }) })).json();
        await page.setCookie({ name: 'sid', value: login.sid, url: base });
        await page.goto(base + '/', { waitUntil: 'networkidle0' });
        await page.evaluate(() => window.JarvisVoice.dispatch('USER_TOGGLE'));   // brings up the wake model, then the turn model

        let st = '';
        for (let i = 0; i < 60 && st !== 'on' && st !== 'failed'; i++) {
            await new Promise((r) => setTimeout(r, 500));
            st = await page.evaluate(() => (window.JarvisTurn.status) + (window.JarvisTurn.error ? ': ' + window.JarvisTurn.error : ''));
        }
        ck('Chrome loads the end-of-turn model once voice is on', st === 'on', st);
        ck('  with /melspec.js — the desktop app\'s own features', await page.evaluate(() => !!(window.JarvisMelspec && window.JarvisMelspec.logMel)));

        const done = await page.evaluate((a) => window.JarvisTurn.analyse(Float32Array.from(a)), seg(10.5, 17));
        const half = await page.evaluate((a) => window.JarvisTurn.analyse(Float32Array.from(a)), seg(10.5, 12.5));
        console.log('        finished p=' + (done.probability || 0).toFixed(2) + ' (' + done.ms + 'ms), half-way p=' + (half.probability || 0).toFixed(2));
        ck('"What\'s up — what needs my attention?" — finished', done.ok && done.complete, JSON.stringify(done));
        ck('the same sentence stopped half-way — NOT finished', half.ok && !half.complete, JSON.stringify(half));
        ck('fast enough to sit in a pause (< 400 ms)', done.ms < 400, done.ms + 'ms');
    } finally {
        await browser.close();
        await j.stop();
    }
    console.log(`\n  ${pass} passed, ${fail} failed`);
    if (fail) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  HARNESS FAILED:', e); process.exit(1); });
