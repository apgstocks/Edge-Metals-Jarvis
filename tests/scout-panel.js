// ── tests/scout-panel.js ──────────────────────────────────────────────────
// Scout's panel, RENDERED — not grepped.
//
// Apsara, 2026-11-08: "There should be a scout AI to assist us with yard on
// the right side ... If i say show spend report for last three days.it
// should do that from any screen in edge yard." Then: "Make sure it is
// production quality auto run tests on it once build is completed".
//
// ── WHY THIS FILE EXECUTES THE WIDGET ────────────────────────────────────
// #243: dashboard/claims.html was dead for six days while 139 claims checks
// stayed green, because every one of them read the file as TEXT and matched
// strings in it. A string being present proves the string is present. It
// does not prove a panel opens, a class lands, or a click does anything.
//
// So this stands yard-bot.js up in a real DOM, opens it, answers it with a
// real server reply shape, and asks the document what happened.

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-scoutui-'));
process.env.JARVIS_TEST = '1';

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label);
           if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { /* reported below */ }

const BOT = fs.readFileSync(path.join(ROOT, 'dashboard/yard-bot.js'), 'utf8');

// Stands the widget up in a page. `app` true pretends to be the phone (the
// host with #appShell), which is how the file itself tells the two apart.
// `width` drives the docked/floating decision.
async function mount({ app = false, width = 1400, reply = null } = {}) {
    const dom = new JSDOM(
        `<!doctype html><body>${app ? '<div id="appShell"></div>' : ''}</body>`,
        { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window;

    // matchMedia is not implemented by jsdom, and the widget asks it which
    // layout to use. Answered from `width` so the test drives the decision
    // rather than hoping for a default.
    w.matchMedia = (q) => {
        const min = /min-width:\s*(\d+)/.exec(q);
        const max = /max-width:\s*(\d+)/.exec(q);
        return { matches: min ? width >= Number(min[1]) : (max ? width <= Number(max[1]) : false) };
    };

    // The host's own api(), which the widget reuses. Returns whatever this
    // test says the server said.
    const calls = [];
    w.api = async (p, opts) => {
        calls.push({ path: p, body: JSON.parse((opts && opts.body) || '{}') });
        return reply || { ok: true, answer: 'Nothing to report.' };
    };
    // The website's navigation, and the spend screen's filter variables.
    // Declared on the window because the test is a separate script from the
    // app parts that really declare them.
    const opened = [];
    w.eval('var spendFrom="", spendTo="", spendCompany="edge-trading", spendMethod="",'
         + ' spendBank="", spendPaidVia="", spendBought="", spendSold="";');
    w.loadTab = (t) => { opened.push(t); };
    w.__opened = opened;

    w.eval(BOT);
    // The widget mounts on DOMContentLoaded when the document is still
    // parsing, which is the case here: jsdom has not fired it by the time
    // this eval runs. Waiting is the harness catching up with the browser,
    // not a shim for something broken — a real page fires it on its own.
    for (let i = 0; i < 40 && !w.document.getElementById('yardBotFab'); i += 1) {
        if (w.document.readyState === 'loading') {
            w.document.dispatchEvent(new w.Event('DOMContentLoaded', { bubbles: true }));
        }
        await new Promise((r) => setTimeout(r, 5));
    }
    return { w, dom, calls, opened };
}

(async () => {

if (!JSDOM) {
    console.log('  FAIL  jsdom is not installed — this file cannot prove anything without it');
    process.exit(1);
}

section('A — it stands up at all, on both hosts');
{
    const { w, dom } = await mount({});
    ck('the widget injects itself with no host markup', !!w.document.getElementById('yardBotFab'));
    ck('  and a panel to open', !!w.document.getElementById('yardBotPanel'));
    ck('  which starts closed',
       !w.document.getElementById('yardBotPanel').classList.contains('open'));
    dom.window.close();
}

section('B — docked down the right on a laptop, floating on a phone');
{
    const web = await mount({ app: false, width: 1400 });
    web.w.document.getElementById('yardBotFab').click();
    const p = web.w.document.getElementById('yardBotPanel');
    ck('clicking the icon opens it', p.classList.contains('open'));
    ck('  and on a wide website window it DOCKS to the right',
       p.classList.contains('yb-docked'),
       'a card floating over the middle is a chat window you dismiss to see '
       + 'your work; docked is something you work alongside');
    web.dom.window.close();

    const narrow = await mount({ app: false, width: 700 });
    narrow.w.document.getElementById('yardBotFab').click();
    ck('a narrow window keeps the floating card',
       !narrow.w.document.getElementById('yardBotPanel').classList.contains('yb-docked'));
    narrow.dom.window.close();

    // RULE 1: she asked for the website. The app shares this file and must
    // come out exactly as it was.
    const phone = await mount({ app: true, width: 1400 });
    phone.w.document.getElementById('yardBotFab').click();
    ck('THE APP IS UNTOUCHED — it never docks, even on a wide screen',
       !phone.w.document.getElementById('yardBotPanel').classList.contains('yb-docked'),
       'one file, two hosts: she asked for the website only');
    phone.dom.window.close();
}

section('C — what it asks the server for');
{
    const web = await mount({ app: false, width: 1400 });
    web.w.document.getElementById('yardBotFab').click();
    web.w.document.getElementById('yardBotInput').value = 'show spend report for last three days';
    web.w.document.getElementById('yardBotSend').click();
    await new Promise((r) => setTimeout(r, 30));
    const ask = web.calls.find((c) => /yard\/ask/.test(c.path));
    ck('the website asks for navigation', ask && ask.body.show === true,
       JSON.stringify(ask && ask.body));
    ck('  and says which company she is looking at',
       ask && ask.body.company === 'edge-trading',
       'moving her between two companies on a guess is the one navigation '
       + 'mistake that silently answers about the wrong business');
    web.dom.window.close();

    const phone = await mount({ app: true, width: 1400 });
    phone.w.document.getElementById('yardBotFab').click();
    phone.w.document.getElementById('yardBotInput').value = 'how much stock is there';
    phone.w.document.getElementById('yardBotSend').click();
    await new Promise((r) => setTimeout(r, 30));
    const pask = phone.calls.find((c) => /yard\/ask/.test(c.path));
    ck('the app asks for nothing new', pask && pask.body.show === undefined,
       JSON.stringify(pask && pask.body));
    ck('  and still reports itself as the app', pask && pask.body.source === 'app');
    phone.dom.window.close();
}

section('D — THE THING SHE ASKED FOR: it opens the screen, already filtered');
{
    const reply = {
        ok: true,
        answer: 'Opening Spend report, 2026-11-06 to 2026-11-08, for Edge Yard.',
        action: { open: 'spend', label: 'Spend report',
                  filters: { from: '2026-11-06', to: '2026-11-08',
                             company: 'edge-trading', method: 'Cash' },
                  said: 'Spend report, 2026-11-06 to 2026-11-08, for Edge Yard' },
    };
    const { w, dom, opened } = await mount({ app: false, width: 1400, reply });
    w.document.getElementById('yardBotFab').click();
    w.document.getElementById('yardBotInput').value = 'show spend report for last three days';
    w.document.getElementById('yardBotSend').click();
    await new Promise((r) => setTimeout(r, 40));

    ck('it opens the spend screen', opened.includes('spend'), JSON.stringify(opened));
    // THE FILTERS ARE SET BEFORE THE TAB LOADS, so the screen opens already
    // filtered rather than opening and then jumping — which looks like a bug
    // even when the end state is right.
    ck('  with her dates already applied',
       w.eval('spendFrom') === '2026-11-06' && w.eval('spendTo') === '2026-11-08',
       `${w.eval('spendFrom')} .. ${w.eval('spendTo')}`);
    ck('  and the method she asked for', w.eval('spendMethod') === 'Cash', w.eval('spendMethod'));
    ck('  on the right company', w.eval('spendCompany') === 'edge-trading');
    ck('  and it says what it is doing, before the screen moves',
       /Opening Spend report/.test(w.document.getElementById('yardBotLog').textContent),
       'a wrong read has to be visible before she reads a number off it');
    dom.window.close();
}

section('E — a QUESTION leaves her where she is');
{
    // Her own example. The answer appears in the panel; the screen does not
    // move. Yanking the screen away from someone who asked for a number is
    // the behaviour that makes an assistant something you switch off.
    const reply = { ok: true, answer: 'You paid $8,700 in cash over those three days.',
                    action: null,
                    used: [{ name: 'spend_report',
                             params: { from: '2026-11-06', to: '2026-11-08', method: 'Cash' },
                             result: { rows: [{}, {}, {}], count: 3 } }] };
    const { w, dom, opened } = await mount({ app: false, width: 1400, reply });
    w.document.getElementById('yardBotFab').click();
    w.document.getElementById('yardBotInput').value = 'tell me how much cash i paid in last three days';
    w.document.getElementById('yardBotSend').click();
    await new Promise((r) => setTimeout(r, 40));

    ck('the figure is answered in the panel',
       /\$8,700/.test(w.document.getElementById('yardBotLog').textContent));
    ck('  and she is NOT moved off the screen she was on',
       opened.length === 0, JSON.stringify(opened));

    // "Let ai should handle that with detailed report" — the rows behind the
    // number, folded so the answer stays the answer.
    const working = w.document.querySelector('.yb-working');
    ck('the working is shown under the figure', !!working);
    ck('  naming what it looked up',
       working && /spend_report/.test(working.textContent), working && working.textContent);
    ck('  and how many rows it found',
       working && /3 rows/.test(working.textContent), working && working.textContent);
    ck('  folded, not dumped over the answer',
       working && working.tagName === 'DETAILS' && !working.open,
       'a wall of JSON on top of the answer is not a detailed report');
    dom.window.close();
}

section('F — it cannot be talked into opening something that is not there');
{
    // The server validates (helpers/scoutActions.sanitise) and tests/scout-
    // actions.js proves that. This is the client half: handed an action for
    // a screen the host does not know, it must not throw and lose the answer.
    const reply = { ok: true, answer: 'Here you go.',
                    action: { open: 'payroll', label: 'Payroll', filters: {}, said: 'Payroll' } };
    const { w, dom, opened } = await mount({ app: false, width: 1400, reply });
    w.document.getElementById('yardBotFab').click();
    w.document.getElementById('yardBotInput').value = 'open payroll';
    w.document.getElementById('yardBotSend').click();
    await new Promise((r) => setTimeout(r, 40));
    ck('the answer still arrives', /Here you go/.test(w.document.getElementById('yardBotLog').textContent));
    ck('  and a screen the host does not know does not break the panel',
       !/could not open/i.test(w.document.getElementById('yardBotLog').textContent)
       || opened.length === 0,
       'loadTab is called and the host decides; nothing here may throw');
    dom.window.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); }
try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\n  CRASH  ', (e && e.stack) || e); process.exit(1); });
