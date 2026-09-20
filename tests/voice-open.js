// ── tests/voice-open.js ───────────────────────────────────────────────────
// Apsara, 2026-09-20: open screens by voice — and "yard has no scope in
// jarvis only scout has", so each assistant opens only its own company.
//
// Two halves, because either alone passes while the feature does not work:
//   A. a real server: the sentence → the `open` the route returns;
//   B. a real Chromium on the real dashboard: that `open` → the screen that
//      is actually showing, sub-tab and all, and the Documents deep link.

const path = require('path');
const { boot } = require('./helpers/e2e');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

(async () => {
    process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'user-pw-openopenopen';
    const j = await boot({});

    section('A — the route');
    const cases = [
        ['open bills', 'jarvis', { tab: 'bills', sub: 'bills' }],
        ['Jarvis, go to margin', 'jarvis', { tab: 'sales', sub: 'margin' }],
        ['take me to zimex verification', 'jarvis', { href: '/documents#voice=verification:zimex' }],
        ['pull up the packing list', 'jarvis', { href: '/documents#voice=packing' }],
        ['open the loads tab', 'scout', { tab: 'loads' }],
        ['open petty cash', 'scout', { tab: 'petty' }],
    ];
    for (const [q, who, want] of cases) {
        const r = await j.say(q, who);
        const o = r.json.open || {};
        const ok = (!want.tab || o.tab === want.tab) && (!want.sub || (o.sub && o.sub.tab === want.sub))
            && (!want.href || o.href === want.href);
        ck(`${who}: "${q}" opens ${want.href || want.tab + (want.sub ? '/' + want.sub : '')}`, ok, JSON.stringify(r.json.open));
        ck('  and says so', /^Opening /.test(r.json.answer), r.json.answer);
    }
    for (const [q, who, wantWho] of [['open petty cash', 'jarvis', 'Scout'], ['open the loads', 'jarvis', 'Scout'],
                                     ['open bills', 'scout', 'Jarvis'], ['go to zimex verification', 'scout', 'Jarvis']]) {
        const r = await j.say(q, who);
        ck(`${who} will NOT open "${q}" — it names ${wantWho}`, !r.json.open && new RegExp(`that's ${wantWho}'s`).test(r.json.answer), r.json.answer);
    }
    const q1 = await j.say('show me the bookings from houston', 'jarvis');
    ck('"show me the bookings from houston" is still a QUESTION, not navigation', !q1.json.open && q1.json.cards, JSON.stringify(q1.json).slice(0, 160));
    const q2 = await j.say('open 1', 'jarvis');
    ck('"open 1" (a digest item) is not navigation', !q2.json.open, q2.json.answer);

    section('B — a real browser on the real dashboard');
    let browser;
    try {
        const puppeteer = require('puppeteer');
        try {
            browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'],
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });
        } catch (e) {
            // Said loudly and counted as neither pass nor fail: a machine with
            // no Chromium cannot run this half, and a permanent red there
            // would teach everyone to ignore this file.
            console.log('  SKIPPED  browser half — no Chromium here (' + e.message.split('\n')[0] + ')');
            console.log('           run with PUPPETEER_EXECUTABLE_PATH=/path/to/chromium to include it');
            throw Object.assign(new Error('skip'), { skip: true });
        }
        const page = await browser.newPage();
        const base = `http://127.0.0.1:${j.port}`;
        const login = await (await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: process.env.APP_PASSWORD }) })).json();
        ck('(signed in)', !!login.sid, JSON.stringify(login));
        await page.setCookie({ name: 'sid', value: login.sid, url: base });
        await page.goto(base + '/', { waitUntil: 'networkidle0' });
        ck('the dashboard exposes the opener', await page.evaluate(() => typeof window.jarvisOpenScreen === 'function'));

        await page.evaluate(() => window.jarvisOpenScreen({ tab: 'sales', sub: { section: 'sales', tab: 'margin' } }));
        await new Promise((r) => setTimeout(r, 1500));
        const st = await page.evaluate(() => ({
            active: (document.querySelector('.nav-btn.active') || {}).dataset?.tab,
            sub: [...document.querySelectorAll('.metals-tab')].find((b) => /var\(--accent\)/.test(b.getAttribute('style') || ''))?.dataset?.tab,
        }));
        ck('Invoice → Margin is what is showing', st.active === 'sales' && st.sub === 'margin', JSON.stringify(st));

        await page.evaluate(() => window.jarvisOpenScreen({ tab: 'bills', sub: { section: 'bills', tab: 'trucking' } }));
        await new Promise((r) => setTimeout(r, 1500));
        const st2 = await page.evaluate(() => ({
            active: (document.querySelector('.nav-btn.active') || {}).dataset?.tab,
            sub: [...document.querySelectorAll('.metals-tab')].find((b) => /var\(--accent\)/.test(b.getAttribute('style') || ''))?.dataset?.tab,
        }));
        ck('Bills → Trucking is what is showing', st2.active === 'bills' && st2.sub === 'trucking', JSON.stringify(st2));

        await page.goto(base + '/documents#voice=verification:zimex', { waitUntil: 'networkidle0' });
        const d = await page.evaluate(() => ({
            sub: (document.querySelector('.subtab-btn.active') || {}).dataset?.subtab,
            ver: (document.querySelector('.verify-subtab-btn.active') || {}).dataset?.verifySubtab,
            shown: !document.getElementById('verifyPanelZimex').classList.contains('hidden'),
        }));
        ck('Documents deep link lands on Verification → Zimex', d.sub === 'verification' && d.ver === 'zimex' && d.shown, JSON.stringify(d));

        await page.goto(base + '/documents', { waitUntil: 'networkidle0' });
        const plain = await page.evaluate(() => (document.querySelector('.subtab-btn.active') || {}).dataset?.subtab);
        ck('Documents WITHOUT a link still opens on Proforma, as before', plain === 'proforma', plain);
    } catch (e) {
        if (!e.skip) ck('browser half ran', false, e.message);
    } finally {
        if (browser) await browser.close();
    }
    await j.stop();

    console.log(`\n  ${pass} passed, ${fail} failed`);
    if (fail) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  HARNESS FAILED:', e); process.exit(1); });
