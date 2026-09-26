// ── tests/qb-match-picker.js ──────────────────────────────────────────────
// Apsara, 2026-09-26, on a screenshot of the match box: "this box looks out
// of sync from my website design".
//
// It was window.prompt(). Drawn by the operating system, in the OS's own font
// and colours, outside the document entirely — no stylesheet could reach it.
// That is why it looked like a different application: it WAS one.
//
// It was also the wrong control. The answer is almost always "the one with
// the same name", and it asked her to read a numbered list and type a digit.
//
// ── WHAT MUST NOT CHANGE ──────────────────────────────────────────────────
// pickMatch() resolves to exactly what prompt() returned — a 1-based index as
// a STRING, a typed name, 'SKIP', or null for cancel — so remap()'s parsing
// below it is untouched. This is a change of appearance and input method, not
// of what gets written into the mapping. Section B is that contract, and it
// is the part worth testing: a picker that returns a number where the old one
// returned a string would map the wrong QuickBooks id and be very hard to see.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'dashboard/quickbooks.html'), 'utf8');

// Her real case, from the screenshot.
const DETAIL = { kind: 'customer', name: 'SOLINE METAL' };
const CANDIDATES = {
    candidates: [
        { DisplayName: 'SOLINE METAL', Id: '427', exact: true },
        { DisplayName: 'SOLINE METALS LLC', Id: '431' },
    ],
    all: [{ name: 'SOLINE METAL', Id: '427' }, { name: 'SOLINE METALS LLC', Id: '431' },
          { name: 'Radius Recycling', Id: '512' }],
};

const boot = async () => {
    const dom = new JSDOM(HTML, {
        runScripts: 'dangerously', url: 'http://localhost/quickbooks',
        beforeParse(w) {
            w.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
            w.alert = () => {}; w.confirm = () => true;
            // If this is ever reached the whole point has been lost.
            w.prompt = () => { w.__PROMPTED = true; return null; };
            w.addEventListener('error', () => {});
        },
    });
    await new Promise((r) => setTimeout(r, 400));
    return dom;
};

(async () => {

const dom = await boot();
const w = dom.window, d = w.document;

// ══════════════════════════════════════════════════════════════════════════
section('A — it is part of the page now, not an OS box');
// ══════════════════════════════════════════════════════════════════════════
{
    ck('the page defines a picker', typeof w.pickMatch === 'function');
    ck('  and remap no longer calls window.prompt for the match',
       !/const pick = prompt\(/.test(HTML),
       'prompt() cannot be styled — that was the whole complaint');

    const p = w.pickMatch(DETAIL, CANDIDATES);
    const back = d.querySelector('.pk-back');
    ck('a dialog appears inside the document', !!back);
    ck('  and it did NOT fall back to the OS prompt', !w.__PROMPTED);

    // The styling complaint, answered concretely: it must use the page's own
    // tokens, not hardcoded colours that drift from the rest of the app.
    const css = HTML.slice(HTML.indexOf('.pk-back'), HTML.indexOf('@media (max-width:900px)'));
    ck('  it is built from the page design tokens', /var\(--surface-card\)/.test(css) && /var\(--border-default\)/.test(css));
    ck('  and hardcodes no colour of its own',
       !/#[0-9a-f]{6}/i.test(css.replace(/rgba\([^)]*\)/g, '')),
       'a literal hex here is how a panel drifts out of sync again');

    ck('  it names both parties in the heading',
       /SOLINE METAL/.test(back.textContent) && /customer/.test(back.textContent));
    ck('  the exact match is still called out',
       /same name, almost certainly this one/.test(back.textContent));
    ck('  every candidate is a row she can click',
       back.querySelectorAll('.pk-opt').length === 2,
       String(back.querySelectorAll('.pk-opt').length));
    ck('  the keyboard lands on the exact match',
       d.activeElement === back.querySelector('.pk-opt'),
       'it is the answer almost every time');

    back.querySelector('.pk-opt').click();
    const picked = await p;
    ck('clicking the first row answers "1"', picked === '1', JSON.stringify(picked));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — THE CONTRACT remap() DEPENDS ON');
// ══════════════════════════════════════════════════════════════════════════
// remap() parses the result exactly as it parsed prompt()'s: /^\d+$/ picks
// candidates[n-1], 'SKIP' maps to SKIP, anything else is looked up by exact
// name, and a falsy value returns without touching the mapping. Break any of
// these and the wrong QuickBooks id gets written.
{
    // TIME-BOUNDED. If a dismissal stops resolving — a listener removed, a
    // guard inverted — the promise simply never settles and the whole file
    // hangs until the runner's timeout kills it with NO output at all. That
    // happened while mutation-testing this: removing the backdrop listener
    // produced a silent hang rather than a named failure, which in a suite of
    // 180 files reads as "something is broken" instead of "this check failed".
    // A check that cannot report is barely a check.
    const HUNG = Symbol('hung');
    const once = async (act) => {
        const p = w.pickMatch(DETAIL, CANDIDATES);
        await new Promise((r) => setTimeout(r, 0));
        act(d.querySelector('.pk-back'));
        const got = await Promise.race([p, new Promise((r) => setTimeout(() => r(HUNG), 300))]);
        if (got === HUNG) {
            const stuck = d.querySelector('.pk-back');
            if (stuck) stuck.remove();       // leave the DOM clean for the next check
            return '(never resolved)';
        }
        return got;
    };

    const second = await once((b) => b.querySelectorAll('.pk-opt')[1].click());
    ck('the second row answers "2", as a STRING', second === '2' && typeof second === 'string',
       `${JSON.stringify(second)} (${typeof second})`);
    ck('  and it is a 1-based index, the way remap indexes candidates',
       CANDIDATES.candidates[Number(second) - 1].Id === '431');

    ck('Skip answers SKIP', (await once((b) => b.querySelector('.pk-skip').click())) === 'SKIP');
    ck('Cancel answers null', (await once((b) => b.querySelector('.pk-cancel').click())) === null);
    ck('  and so does Escape', (await once(() => {
        d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
    })) === null);
    ck('  and so does clicking the backdrop', (await once((b) => {
        b.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    })) === null);

    const typed = await once((b) => {
        b.querySelector('#pkTyped').value = '  Radius Recycling  ';
        b.querySelector('.pk-go').click();
    });
    ck('a typed name comes back trimmed', typed === 'Radius Recycling', JSON.stringify(typed));

    // An empty box is not a choice. The old prompt returned '' and remap
    // treated it as cancel; here it must not close at all, because closing on
    // nothing looks like it saved.
    const p = w.pickMatch(DETAIL, CANDIDATES);
    await new Promise((r) => setTimeout(r, 0));
    const back = d.querySelector('.pk-back');
    back.querySelector('.pk-go').click();
    await new Promise((r) => setTimeout(r, 10));
    ck('an empty box does not close the dialog', !!d.querySelector('.pk-back'));
    back.querySelector('.pk-cancel').click();
    await p;
}

// ══════════════════════════════════════════════════════════════════════════
section('C — the edges');
// ══════════════════════════════════════════════════════════════════════════
{
    // No near matches at all. The old prompt printed "(no near matches)" and
    // still let her type; so must this.
    const p = w.pickMatch({ kind: 'vendor', name: 'Nobody' }, { candidates: [], all: [{ name: 'Someone', Id: '9' }] });
    await new Promise((r) => setTimeout(r, 0));
    const back = d.querySelector('.pk-back');
    ck('with no candidates it still opens', !!back);
    ck('  says so plainly', /No near matches/i.test(back.textContent));
    ck('  and typing is still possible', !!back.querySelector('#pkTyped'));
    ck('  with the keyboard in the box', d.activeElement === back.querySelector('#pkTyped'));
    back.querySelector('.pk-cancel').click();
    await p;

    // A QuickBooks name with an apostrophe or angle bracket must not become
    // markup — these come from her QuickBooks file, not from us.
    const p2 = w.pickMatch({ kind: 'customer', name: '<img src=x>' },
        { candidates: [{ DisplayName: 'A & B <b>Metals</b>', Id: '1' }], all: [] });
    await new Promise((r) => setTimeout(r, 0));
    const b2 = d.querySelector('.pk-back');
    ck('a name with markup in it is escaped',
       b2.querySelectorAll('img, b').length === 0 && /A & B <b>Metals<\/b>/.test(b2.textContent),
       b2.innerHTML.slice(0, 120));
    b2.querySelector('.pk-cancel').click();
    await p2;

    // Nothing left behind — a stacked overlay would block the page.
    ck('the dialog is removed once answered', !d.querySelector('.pk-back'));
}

dom.window.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error(e); process.exit(1); });
