// ── tests/yard-clients.js ───────────────────────────────────────────────────
// The 2026-08-23/24 client work, extracted from the shipped HTML rather than
// reimplemented — so these assert what actually runs on the phone, not a copy
// that could drift from it.
//   • "Hey Jarvis" wake matching and phrase stripping
//   • the compound-command guard in brain.js
//   • the writing-style scrubber (business content must never reach disk)
//   • the runtime server URL
//   • both clients parse, and the pieces exist in BOTH
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const MOBILE = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');
const DASH = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');
const mobileJs = MOBILE.match(/<script>([\s\S]*?)<\/script>/)[1];

section('A — "Hey Jarvis"');
{
    // Includes WAKE_STRIP, which lives between the two — matching and
    // stripping are separate pattern sets now, and both are exercised here.
    const seg = mobileJs.slice(mobileJs.indexOf('const WAKE_PATTERNS'), mobileJs.indexOf('// ── Wake-word loop'));
    const [isWake, strip] = new Function(seg + '; return [isWakePhrase, stripWake];')();

    // Deliberately loose: the recogniser mishears "Jarvis" constantly, and a
    // missed wake costs the whole feature while a false one costs a tap.
    ['hey jarvis', 'Hey Jarvis check mail from Joey', 'hey service send the price list',
     'hey jervis', 'OK Jarvis show loads', 'hi jarvis'].forEach((t) =>
        ck(`wakes on ${JSON.stringify(t)}`, isWake(t)));
    // "jarvis" alone WAKES as of 2026-08-29, reversing the original rule.
    // These are PARTIAL results — Android emits them word by word — so the
    // most common first partial for "Hey Jarvis" is simply "jarvis". Requiring
    // a greeting meant it was discarded every time, the mic cycled, and
    // nothing ever answered. Apsara: five builds of "no talkback".
    ['jarvis', 'scout', 'Jarvis'].forEach((t) =>
        ck(`wakes on the bare name ${JSON.stringify(t)}`, isWake(t)));
    // The ordinary words still must not fire on their own — a yard is full of
    // talking, and a false wake opens the mic and sends what follows to
    // something that messages truckers.
    ['hey there', 'check mail from Joey', 'heyward services', 'service', 'scott'].forEach((t) =>
        ck(`ignores ${JSON.stringify(t)}`, !isWake(t)));

    ck('the wake phrase is stripped before the brain sees it',
        strip('Hey Jarvis check mail from Joey') === 'check mail from Joey');
    ck('a mishearing is stripped too',
        strip('hey service send proforma to Taewon') === 'send proforma to Taewon');
    ck('a bare wake leaves nothing', strip('hey jarvis') === '');
}

section('B — one command per message, said out loud');
{
    // brain.js routes a single intent. The guard exists so the second half is
    // reported rather than silently dropped.
    const brain = fs.readFileSync(path.join(ROOT, 'workflow/brain.js'), 'utf8');
    const m = brain.match(/const COMPOUND_RE = (\/.*\/[a-z]*);/);
    ck('the guard is still in brain.js', !!m);
    const RE = m ? eval(m[1]) : null;
    if (RE) {
        ['check mail from Joey and send proforma to her', 'show loads then send the price list',
         'check mail and also draft a reply', 'find the booking and then forward it to Bose'
        ].forEach((t) => ck(`flags ${JSON.stringify(t.slice(0, 34))}…`, RE.test(t)));
        // Lists of names are not second commands.
        ['check mail from Joey and Bose', 'send proforma to Taewon and Daekwang',
         'show me loads for Rad Metal and Hugo', 'remind me tomorrow',
         'check mail from sales and marketing'].forEach((t) =>
            ck(`stays quiet on ${JSON.stringify(t.slice(0, 34))}`, !RE.test(t)));
    }
}

section('C — the writing-style profile carries no business content');
{
    const { scrubProfile } = require('../helpers/writingStyle');
    const leaky = {
        greeting: 'Hi <first name>,', sign_off: 'Thanks, Apsara',
        tone: 'Direct. Often quotes a rate like $340 per MT straight away.',
        sentence_style: 'Short. Mentions container 26JY90, booking 1234567 and HMMU6247533.',
        habits: ['opens with the price, e.g. $7,140.00', 'quotes DALA123 often'],
        avoids: ['no exclamation marks', 'never quotes above 410 without checking'],
        formality_note: 'Warmer with Joey. Uses 21 MT as the default.',
    };
    const blob = JSON.stringify(scrubProfile(leaky));
    ck('no dollar amounts survive', !/\$\s?\d/.test(blob));
    ck('no container ids survive (26JY90)', !/26JY90/.test(blob));
    ck('no carrier ids survive (HMMU…)', !/HMMU/.test(blob));
    ck('no booking refs survive (DALA123)', !/DALA/.test(blob));
    ck('no long numbers survive', !/\d[\d,.]{2,}/.test(blob));
    ck('no bare quantities survive', !/\b21\b/.test(blob));
    // ...while the thing it is FOR still works.
    ck('the actual style survives', /Direct/.test(blob) && /exclamation/.test(blob) && /Warmer with Joey/.test(blob));
}

section('D — the server address is not baked in');
{
    const seg = mobileJs.slice(mobileJs.indexOf('const DEFAULT_API_BASE'), mobileJs.indexOf('let API_BASE ='));
    const store = {};
    global.localStorage = { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } };
    global.window = { JARVIS_CONFIG: { API_BASE: 'https://built-in.example.com' } };
    const [stored, setStored] = new Function('return (()=>{' + seg + '; return [storedApiBase,setStoredApiBase];})()')();
    ck('nothing saved means the bundled default is used', stored() === '');
    setStored('https://new-tunnel.trycloudflare.com/');
    ck('a saved address survives', stored() === 'https://new-tunnel.trycloudflare.com');
    ck('and a trailing slash is stripped', !stored().endsWith('/'));
    setStored('');
    ck('"use default" clears it', stored() === '');
    ck('API_BASE is reassignable, not a const', /let API_BASE =/.test(mobileJs));
    ck('and the login screen can edit it', MOBILE.includes('id="serverUrl"'));
    ck('it is verified against /api/health before saving', mobileJs.includes("'/api/health'") || mobileJs.includes('/api/health'));
}

section('E — the two clients have not drifted');
{
    // Every pair this file has had to fix once already.
    [['sale mode', 'applyLoadModalMode'], ['the Sale button', 'btnAddSale'],
     ['sale routing', "_kind === 'sale'"], ['the outbound endpoint', 'outbound-loads/'],
     ['the description type-ahead', 'ld-item-desc-input'], ['on-hand', 'onHandAvailable'],
     ['per-seller tickets', 'Load tickets']].forEach(([label, needle]) => {
        ck(`${label} exists in BOTH clients`, MOBILE.includes(needle) && DASH.includes(needle));
    });
    ck('neither client still uses the old description <select>',
        !MOBILE.includes('ld-item-desc-select') && !DASH.includes('ld-item-desc-select'));
}

section('F — one tap on the mic is one capture');
{
    // Android fires touch AND synthetic mouse for a single tap, so the button
    // ran its handler twice; a desktop click fires mouseup AND click, so the
    // fallback doubled it again. Both are reproduced here because "nothing
    // happening" and "happening twice" are the same class of bug and neither
    // is visible from reading the code.
    const seg = mobileJs.slice(
        mobileJs.indexOf('  let held = false, timer = null, usedTouch = false, handledAt = 0;'),
        mobileJs.indexOf("  $('btnVoiceClose')"));
    ck('the gesture handler is still shaped as expected', seg.length > 200);

    const wire = () => {
        const state = { captures: 0, toggles: 0 };
        const handlers = {};
        const b = { addEventListener: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); } };
        const $ = () => ({ classList: { contains: () => true } });
        const captureCommand = () => state.captures++;
        const stopWakeLoop = () => state.toggles++;
        const startWakeLoop = () => state.toggles++;
        const voiceToast = () => {};
        let voiceOn = false;
        // The wake-word toggle now goes through the state machine in
        // mobile-app/www/voice-machine.js (Apsara 2026-08-29 — the mic rule was
        // extracted so it could be tested exhaustively). This sandbox stands in
        // for it, and uses the REAL machine so the toggle is exercised against
        // the same rule the app obeys, not a mock that always agrees.
        // Porcupine stubs. This sandbox evaluates the long-press handler in
        // isolation, so anything the handler now touches must exist here — the
        // wake word moved to an on-device engine (WakeWordPlugin.java) and the
        // toggle consults it. Stubbed rather than mocked away, so the handler
        // still exercises the real branch.
        const usingPorcupine = () => false;
        const startPorcupine = () => {};
        const stopPorcupine = () => {};
        const VM = require('../mobile-app/www/voice-machine.js');
        let vmState = VM.initial();
        const vmSend = (event) => {
            const r = VM.reduce(vmState, event);
            vmState = r.state;
            // Only the wake loop counts as a "toggle" for this test's purposes.
            for (const eff of r.effects) {
                if (eff === 'START_MIC' || eff === 'STOP_MIC') state.toggles++;
            }
            return r.effects;
        };
        eval(seg);
        return { state, fire: (ev) => (handlers[ev] || []).forEach((f) => f({ preventDefault() {} })) };
    };

    const tap = (seq) => { const w = wire(); seq.forEach((e) => w.fire(e)); return w.state; };
    const android = tap(['touchstart', 'touchend', 'mousedown', 'mouseup', 'click']);
    ck('an android tap captures exactly once', android.captures === 1);
    ck('and does not toggle the wake word', android.toggles === 0);
    const desktop = tap(['mousedown', 'mouseup', 'click']);
    ck('a desktop click captures exactly once', desktop.captures === 1);
    const bare = tap(['click']);
    ck('a click-only webview still captures', bare.captures === 1);

    // Long press is the wake-word toggle, and must not also capture.
    const w = wire();
    w.fire('touchstart');
    const started = Date.now();
    while (Date.now() - started < 650) { /* let the 550ms timer elapse */ }
    return new Promise((resolve) => setTimeout(() => {
        ['touchend', 'mousedown', 'mouseup', 'click'].forEach((e) => w.fire(e));
        setTimeout(() => {
            ck('a long press toggles the wake word', w.state.toggles === 1);
            ck('and does NOT also open a capture', w.state.captures === 0);
            console.log('\n================================================================');
            console.log(`${pass} passed, ${fail} failed`);
            if (fail) { console.log('\nFAILED:'); failures.forEach((f) => console.log('  - ' + f)); }
            process.exit(fail ? 1 : 0);
        }, 80);
    }, 10));
}

console.log('\n================================================================');
console.log(`${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILED:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
