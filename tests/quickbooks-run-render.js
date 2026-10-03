// ── tests/quickbooks-run-render.js ────────────────────────────────────────
// Apsara, 2026-10-02, with a screenshot of the QuickBooks page after pressing
// RUN NOW: "on clicking run now in qb,its coming like this ugly".
//
// ── WHAT IT ACTUALLY WAS ──────────────────────────────────────────────────
// Not a stylesheet problem. The page did this:
//
//     $('answer').textContent = out.report;
//
// `out.report` is built by quickbooksNightly.reportText() — and that function
// writes the NIGHTLY EMAIL BODY. Plain text, newline-separated, with a
// four-line explanation of the cutover appended to every single run because a
// mail client has no other way to offer help.
//
// Three separate mistakes, stacked:
//   1. HTML collapses newlines, and `.answer` sets no white-space rule. Forty
//      stuck containers became one unbroken paragraph.
//   2. `.answer` is max-height:132px — the ASK JARVIS box. A forty-row report
//      was being poured into a container four lines tall.
//   3. textContent, so even the structure that survived had no columns.
//
// The screenshot shows her having drag-selected the whole blob, which is the
// only way that text could be read. That is the real bug report.
//
// ── THE SHAPE OF THE FIX, AND WHAT THIS FILE PROTECTS ─────────────────────
// reportText() is NOT changed — the nightly email is the right shape already
// and scheduler.js prints it too. The route now ALSO returns the structured
// pieces, and the page draws them itself in the table idiom that "what needs
// you" already uses.
//
// So there are two properties here, and the second is the one that bites:
//   A. the page renders ROWS, not a paragraph.
//   B. the EMAIL still renders a paragraph. A "tidy-up" that reaches into
//      reportText would make her nightly mail arrive as one line, and nobody
//      would notice for weeks because nobody reads a cron's output until it
//      is wrong.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-qbrun-'));
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');

let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { /* reported in A */ }

const HTML = fs.readFileSync(path.join(ROOT, 'dashboard/quickbooks.html'), 'utf8');
const SCRIPT = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]).join('\n');

// A live run with everything in it: entered rows, stuck rows, an asked row,
// and a batch the cutover walked past. Shaped exactly like the route's reply
// — the reasons are copied from her own screenshot so the fixture carries her
// real data rather than a tidy invention.
const RUN = {
    ok: true, dryRun: false, env: 'production', error: null,
    summary: { made: 27, blocked: 20, asked: 1, errored: 0, left: 4 },
    kinds: {
        bill: { 'already-linked': 27, blocked: 19 },
        sale: { 'already-linked': 66, waiting: 1, blocked: 1 },
        billpayment: { 'already-linked': 7, ask: 1 },
    },
    blocked: [
        { kind: 'bill', who: 'Mazariegos', what: 'HMMU4933766', why: 'no supplier amount yet; grade "Al Combo" has no amount' },
        { kind: 'bill', who: 'Inesh Cores Chapin', what: 'KOCU4401728', why: 'no supplier amount yet; grade "Auto cast" has no amount' },
        { kind: 'bill', who: 'Carlos G & C', what: 'PO#4302973', why: 'no invoice number — the number that ties this bill to its sale' },
    ],
    asked: [
        { kind: 'billpayment', who: 'Abantos', what: 'WIRE-8821', why: 'a payment of the same amount is already in QuickBooks' },
    ],
    leftAlone: { bill: 3, sale: 1, from: '2026-07-02', to: '2026-08-14', why: { 'older than the bills cutover': 4 } },
};

// Stands the real page up and hands back the window. api() is stubbed AFTER
// the script runs, because the page defines its own api() which would
// otherwise overwrite the stub and try to reach the network.
// `extra` is APPENDED TO THE SCRIPT SOURCE, not run as a second eval. STATE
// is a top-level const, and in an indirect eval a const goes into a new
// declarative environment belonging to that eval — so it is neither a
// property of window nor visible to a later w.eval(). Setting w.STATE just
// creates a stray global while the page's own functions keep reading the real
// binding. (Function declarations DO land on window, which is why stubbing
// w.api and w.toast afterwards works.) Same lesson as tests/ledger-render.js.
function mount(extra = '') {
    const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window;
    // boot() is async and resumes as a microtask after the window is gone,
    // where its first $() throws and the file exits 1 while printing all
    // passes. Held at its first await, per the note in CLAUDE.md.
    w.fetch = () => new Promise(() => {});
    w.confirm = () => true;
    w.alert = () => {};
    try { w.eval(extra ? `${SCRIPT}\n;${extra}` : SCRIPT); } catch (e) { return { w, dom, err: e }; }
    return { w, dom, err: null };
}

// ── A — THE RUN RESULT IS DRAWN AS ROWS ───────────────────────────────────
{
    section('A — what RUN NOW puts on screen');

    if (!JSDOM) {
        ck('jsdom is installed', false, 'npm i -D jsdom — this file cannot render the page without it');
    } else {
        const { w, err } = mount();
        ck('the page script parses and runs', !err, err && err.message);

        if (!err) {
            ck('renderRun exists', typeof w.renderRun === 'function',
               'the run result has nowhere to go but the Ask box without it');

            if (typeof w.renderRun === 'function') {
                w.renderRun(RUN);
                const body = w.document.getElementById('dbody');
                const rows = body.querySelectorAll('tr');

                // THE HEADLINE PROPERTY. The old code produced zero rows — one
                // text node in one div. Any number of real rows proves the
                // report was parsed rather than pasted.
                ck('it draws table rows, not a paragraph', rows.length >= 4,
                   `${rows.length} <tr> in #dbody — the bug was 0`);

                // Each stuck row keeps its reason in its OWN cell. This is the
                // difference she actually sees: "HMMU4933766 | no supplier
                // amount yet" instead of those two running together.
                const stuck = [...rows].find((tr) => /HMMU4933766/.test(tr.textContent));
                ck('a stuck container has its own row', !!stuck);
                ck('  with the reason in a separate cell',
                   !!stuck && [...stuck.querySelectorAll('td')]
                       .some((td) => /no supplier amount yet/.test(td.textContent)),
                   stuck && stuck.innerHTML);
                ck('  and the reason is NOT in the same cell as the container',
                   !!stuck && ![...stuck.querySelectorAll('td')]
                       .some((td) => /HMMU4933766/.test(td.textContent) && /no supplier amount/.test(td.textContent)),
                   'one cell holding both is the blob again, just inside a table');

                // The counts, as the page's own stat blocks.
                const stats = w.document.getElementById('dstats').textContent;
                ck('the counts are shown', /27/.test(stats) && /20/.test(stats), stats);

                // ── THE ASK BOX IS LEFT ALONE ────────────────────────────
                // The regression that would bring the ugliness back wholesale.
                const ans = w.document.getElementById('answer');
                ck('the Ask Jarvis box is not used for the report',
                   !/no supplier amount yet/.test(ans.textContent || ''),
                   'the report is back in the 132px box');
                ck('  and it is hidden, not left showing a stale answer',
                   ans.style.display === 'none', ans.style.display);

                // The held-back batch still gets said out loud — a run that
                // skipped everything used to read like a quiet night. Matched on
                // the behaviour, not the label: "cutover" became "period lock"
                // mid-session (b049489), and a check on the word went red while
                // the panel was still correct.
                ck('what the boundary held back is still reported',
                   /(period lock|cutover|left alone)/i.test(body.textContent),
                   body.textContent.slice(0, 200));
                ck('  with the dates it covered',
                   /2026-07-02/.test(body.textContent),
                   'the count alone cannot tell her which period was skipped');
            }
            w.close();
        }
    }
}

// ── B — A SUPPLIER NAMED WITH AN "&" IS ORDINARY HERE ─────────────────────
// "Carlos G & C" is a real name in her ledger, and these strings go through
// innerHTML. Unescaped, the name breaks the markup around it.
{
    section('B — her data does not break the markup');

    if (JSDOM) {
        const { w, err } = mount();
        if (!err && typeof w.renderRun === 'function') {
            w.renderRun(RUN);
            const body = w.document.getElementById('dbody');
            const row = [...body.querySelectorAll('tr')].find((tr) => /PO#4302973/.test(tr.textContent));
            ck('a supplier with an ampersand renders whole', !!row
                && /Carlos G & C/.test(row.textContent), row && row.textContent);

            // And a reason carrying a quote or a bracket cannot escape its cell.
            w.renderRun({ ...RUN, blocked: [{ kind: 'bill', who: '<img src=x onerror=1>',
                what: 'C1', why: 'grade "A & B" has no amount' }] });
            const html = w.document.getElementById('dbody').innerHTML;
            ck('a name that looks like markup is escaped', !/<img/i.test(html),
               'an unescaped name here is an injection through her own data');
            w.close();
        }
    }
}

// ── C — A DRY RUN DOES NOT PRETEND TO KNOW WHY ────────────────────────────
// run() only reads the journal for per-row reasons when the run was LIVE. A
// dry run genuinely has the counts and not the reasons, and the honest thing
// is to say so rather than draw an empty table under a heading promising rows.
{
    section('C — a check-only run is honest about what it knows');

    if (JSDOM) {
        const { w, err } = mount();
        if (!err && typeof w.renderRun === 'function') {
            w.renderRun({ ...RUN, dryRun: true, blocked: [], asked: [], leftAlone: null,
                summary: { made: 27, blocked: 20, asked: 0, errored: 0, left: 0 } });
            const body = w.document.getElementById('dbody');
            ck('it still says how many are stuck', /20/.test(w.document.getElementById('dstats').textContent));
            ck('  and says the reasons need a live run',
               /does not record why|run it live/i.test(body.textContent), body.textContent.slice(0, 300));
            // Written once as `A || !B || A>0`, which is true for every
            // possible input — a check that cannot fail is worse than no
            // check, because it reads in the output like coverage.
            // The real property: a dry run heading the "Stuck" section must
            // not be followed by a table with no rows in it.
            const stuckHead = [...body.querySelectorAll('h3')]
                .find((h) => /stuck/i.test(h.textContent));
            const tableAfter = stuckHead && stuckHead.nextElementSibling
                && stuckHead.nextElementSibling.tagName === 'TABLE'
                ? stuckHead.nextElementSibling : null;
            ck('  without drawing an empty table under the heading',
               !tableAfter || tableAfter.querySelectorAll('tr').length > 0,
               'a "Stuck 20" heading over an empty table reads as a rendering bug');
            ck('the heading says nothing was written',
               /nothing was written/i.test(w.document.getElementById('dname').textContent),
               w.document.getElementById('dname').textContent);
            w.close();
        }
    }
}

// ── D — A FAILED RUN IS NOT A BLANK PANEL ─────────────────────────────────
{
    section('D — the run that could not finish');

    if (JSDOM) {
        const { w, err } = mount();
        if (!err && typeof w.renderRun === 'function') {
            w.renderRun({ ok: false, error: 'token expired', summary: {} });
            ck('the error is shown', /token expired/.test(w.document.getElementById('dbody').textContent));
            ck('  and it says nothing was written',
               /nothing further was written/i.test(w.document.getElementById('dmap').textContent),
               w.document.getElementById('dmap').textContent);
            w.close();
        }
    }
}

// ── E — THE EMAIL IS STILL AN EMAIL ───────────────────────────────────────
// THE GUARD THAT MATTERS MOST HERE. The page stopped using reportText; the
// nightly mail and scheduler.js still do. A later tidy-up that "fixes the
// formatting" inside reportText would turn her 00:00 email into one line and
// nothing would catch it — a cron's output is not read until it is wrong.
{
    section('E — reportText still writes a plain-text email');

    const job = require(path.join(ROOT, 'helpers/quickbooksNightly'));
    const out = {
        ok: true, dryRun: false, env: 'production',
        result: { bill: { created: 3, blocked: 2 }, sale: {}, billpayment: {}, receipt: {} },
        blocked: [{ kind: 'bill', who: 'Mazariegos', what: 'HMMU4933766', why: 'no supplier amount yet' }],
        asked: [],
    };
    const text = job.reportText(out);

    ck('it is still newline-separated', text.split('\n').length > 5,
       `${text.split('\n').length} lines — an email body on one line is unreadable in a mail client`);
    ck('  it still names the stuck record', /HMMU4933766/.test(text));
    ck('  it still carries the reason', /no supplier amount yet/.test(text));
    // ── THE PROPERTY, NOT THE WORD ───────────────────────────────────────
    // Written first as /cutover/i, and it went red the same day — not because
    // the email stopped explaining the boundary, but because another session
    // renamed "cutover" to "period lock" (commit b049489). A check shaped
    // like the vocabulary rather than the behaviour, which is the exact trap
    // CLAUDE.md names. What actually has to stay true: the email says there
    // IS a boundary, and says where it is, so a run that skipped rows cannot
    // read like a quiet night.
    ck('  and it still explains the boundary',
       /(cutover|period lock|locked before)/i.test(text),
       'without it, a run that entered nothing reads exactly like a run with nothing to do');
    ck('it is plain text, not HTML', !/<(div|table|tr|td|span)\b/i.test(text),
       'reportText feeding a mail client must not start emitting markup');
}

// ── F — THE ROUTE HANDS BACK BOTH ─────────────────────────────────────────
// The contract between the two halves. The page needs the pieces; the email
// needs the text; the route returns both, and dropping either is a silent
// break — the page would render an empty panel and the email would go out
// blank, each looking like "nothing happened today".
{
    section('F — the route returns the pieces AND the text');

    const src = fs.readFileSync(path.join(ROOT, 'helpers/quickbooks/routes.js'), 'utf8');
    // Bounded to the run handler itself, ending at the next route — so a
    // field named in a DIFFERENT handler further down the file cannot make
    // this section green for the wrong reason.
    const from = src.indexOf("app.post('/api/qb/run'");
    const rest = src.slice(from + 20);
    const next = rest.search(/\n\s{4}(app\.(get|post|put|delete)|\/\/ ──)/);
    const body = rest.slice(0, next === -1 ? 2000 : next);

    for (const field of ['report', 'summary', 'blocked', 'asked', 'kinds', 'leftAlone']) {
        ck(`/api/qb/run returns ${field}`, new RegExp(`\\b${field}:`).test(body),
           field === 'report' ? 'the nightly email path reads this' : 'the page draws this');
    }
    ck('report is still built by reportText', /report:\s*job\.reportText\(/.test(body),
       'the page no longer uses it, but the email does — it must keep coming back');
}

(async () => {

// ── G — PRESSING THE BUTTON IS WHAT MATTERS ───────────────────────────────
// Sections A–D call renderRun() directly, and that is not enough. Reverting
// the one line in runNow() that routes to it — putting the email body back
// into the Ask box, which IS the original bug — left every one of those
// sections green. I only found that by breaking it on purpose.
//
// That is the exact trap CLAUDE.md names: "a check shaped like the old code
// rather than like the property, which passes happily when the code moves."
// A test for a renderer that nothing calls tests a renderer that nothing
// calls. So this section presses RUN NOW.
{
    section('G — RUN NOW routes through the renderer');

    if (JSDOM) {
        // The padlock, set inside the same eval for the reason above.
        const { w, err } = mount('STATE.unlocked = true;');
        if (err) {
            ck('the page runs', false, err.message);
        } else {
            // Everything else runNow touches: the confirm that chooses
            // live-or-dry, the route, and the status reload it ends with.
            w.confirm = () => true;              // OK = run it for real
            let asked = null;
            w.api = async (p, body) => {
                if (p === '/api/qb/run') { asked = body; return RUN; }
                return {};                        // loadStatus and friends
            };
            w.toast = () => {};
            w.loadStatus = async () => {};
            w.loadParties = async () => {};

            await w.runNow();

            ck('it called the run route', !!asked, 'runNow never reached /api/qb/run');
            ck('  live, because confirm said OK', asked && asked.dryRun === false,
               JSON.stringify(asked));

            const body = w.document.getElementById('dbody');
            const ans = w.document.getElementById('answer');

            // THE PROPERTY, stated the way the bug was: after pressing the
            // button, the stuck containers are in rows on the panel, and the
            // email body is NOT in the Ask box.
            ck('the result landed on the panel as rows',
               body.querySelectorAll('tr').length >= 4,
               `${body.querySelectorAll('tr').length} rows — 0 means it went back to the Ask box`);
            ck('  and HMMU4933766 is one of them', /HMMU4933766/.test(body.textContent));
            ck('the email body did NOT go into the Ask box',
               !/no supplier amount yet/.test(ans.textContent || ''),
               'this is the original bug, exactly: an email body in a 132px box');
            ck('  and the Ask box is hidden', ans.style.display === 'none', ans.style.display);

            w.close();
        }
    }
}

// ── H — CREATE IT IN QUICKBOOKS (#152) ────────────────────────────────────
// /api/qb/create-party and the client's createParty() have both existed all
// along. The only way to reach them was: open the party, press "match it",
// wait for the candidate list to load over the network, then press "create
// it" INSIDE that dialog. Three steps and a round-trip to tell Jarvis
// something she already knew when she opened the row.
//
// RENDERED, not grepped. tests/quickbooks-page.js checks this page by reading
// its source, which proves a string exists and not that a button appears —
// the exact weak assertion CLAUDE.md names. renderDetail builds that line
// from four branches; only one of them should carry this button.
{
    section('H — a direct way to create the party');

    if (JSDOM) {
        // STATE is a top-level const, so it is not a property of window and
        // `w.STATE.detail = ...` sets a stray global the page never reads.
        // Same lesson as the padlock in section G: the assignment has to live
        // inside the eval, so a setter is appended there.
        const { w, err } = mount('STATE.unlocked = true;'
            + 'window.__setDetail = (d) => { STATE.detail = d; };');
        if (err) { ck('the page runs', false, err.message); }
        else {
            // The shape /api/qb/party really returns. The first version passed
            // a thin object, renderDetail threw partway through, and a
            // try/catch swallowed it — so the button appeared (drawn early)
            // while the wiring at the end of the same function never ran, and
            // the test reported "drawn but not wired" as though it were a
            // product bug. The catch is gone: if renderDetail throws, this
            // section should fail loudly rather than mislead.
            const show = (mapping) => {
                w.__setDetail({ kind: 'vendor', name: 'Nur Metal', mapping,
                    totals: { bills: 0, invoices: 0, billsValue: 0, invoicesValue: 0,
                              payments: 0, advances: 0 },
                    bills: [], invoices: [], payments: [], advances: [],
                    journal: [], qbBalance: null });
                w.renderDetail();
                return w.document.getElementById('dmap');
            };

            // UNMATCHED — this is the one case that needs it.
            let dmap = show({});
            ck('an unmatched party offers "create it in QuickBooks"',
               !!w.document.getElementById('makeparty'), dmap && dmap.textContent);
            ck('  and still offers "match it" beside it',
               !!w.document.getElementById('remap'),
               'they answer different questions: match = it IS there under another '
               + 'spelling; create = it is NOT there');

            // ── AND NOWHERE ELSE ─────────────────────────────────────────
            // A create button on a party already IN QuickBooks is an invitation
            // to make a duplicate, which is the one thing the QB Agent spends
            // its mornings reporting.
            dmap = show({ qbId: '123', qbName: 'NUR METAL', status: 'exact' });
            ck('a MATCHED party does not offer it',
               !w.document.getElementById('makeparty'),
               'creating a second record for a party already in QuickBooks is how '
               + 'the duplicates in her agent email get made');

            dmap = show({ status: 'skip', note: 'not a QuickBooks party' });
            ck('a party marked NOT a QuickBooks party does not offer it',
               !w.document.getElementById('makeparty'), dmap && dmap.textContent);

            dmap = show({ status: 'new' });
            ck('one already marked "not in QuickBooks" does not offer it twice',
               !w.document.getElementById('makeparty'), dmap && dmap.textContent);

            // ── IT IS WIRED, NOT JUST DRAWN ──────────────────────────────
            // A button with no handler is the failure this suite keeps
            // finding: it looks finished and does nothing.
            show({});
            let asked = null;
            w.createParty = (kind, name) => { asked = { kind, name }; };
            w.document.getElementById('makeparty').click();
            ck('clicking it calls createParty', !!asked, 'drawn but not wired');
            ck('  with this party\'s kind and name',
               asked && asked.kind === 'vendor' && asked.name === 'Nur Metal',
               JSON.stringify(asked));

            w.close();
        }
    }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
})();
