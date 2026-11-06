// ── tests/pickups-screen.js ───────────────────────────────────────────────
// The Follow-up Agent's screen. Apsara, 2026-11-06: "Have a followup agent",
// and on pickups read out of her mail, "tell me if the date is wrong" — which
// she cannot do if there is nowhere to look.
//
// ── THIS FILE RENDERS THE PAGE. IT DOES NOT GREP IT ──────────────────────
// dashboard/claims.html was DEAD FOR SIX DAYS behind 139 green checks,
// because every one of them read the page as source text and none ever
// executed it. She reported the symptom three times before it was found.
//
// So every check below mounts the real page in JSDOM, lets it fetch, and
// asks the DOM what happened. A regex over this file would prove nothing.
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
const HTML = fs.readFileSync(path.join(ROOT, 'dashboard', 'pickups.html'), 'utf8');

// Mount the real page with /api/pickups answered however the caller wants.
// `calls` records what the page POSTed, so a check can prove it sent the
// right thing rather than merely that a button exists.
function mount({ rows = [], fail: failWith = null } = {}) {
    const calls = [];
    const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'http://localhost/pickups',
        beforeParse(w) {
            w.fetch = (url, opts = {}) => {
                calls.push({ url: String(url), method: (opts.method || 'GET'),
                    body: opts.body ? JSON.parse(opts.body) : null });
                if (failWith && /\/api\/pickups$/.test(String(url)) && !opts.method) {
                    return Promise.resolve({ ok: false, status: 500,
                        json: () => Promise.resolve({ error: failWith }) });
                }
                return Promise.resolve({ ok: true, status: 200,
                    json: () => Promise.resolve({ pickups: rows, count: rows.length }) });
            };
        } });
    return new Promise((res) => setTimeout(() => res({ w: dom.window, d: dom.window.document, calls }), 60));
}

const ROW = (o = {}) => Object.assign({
    id: 'pk1', company: 'Zimex Freight', pickup_date: '2026-11-20',
    container_no: 'MSDU1122334', location: 'the yard', status: 'arranged',
    eta: '', source: 'apsara', contacts_learned: false,
    reachable: true, unreachable_why: null,
    next_step: null, next_why: 'pickup is on 2026-11-20, not today',
}, o);

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — it renders at all');
// ══════════════════════════════════════════════════════════════════════════
{
    const { d } = await mount({ rows: [ROW()] });
    ck('the page draws a row', d.querySelectorAll('#rows .row').length === 1,
       d.querySelector('#rows').textContent.slice(0, 80));
    ck('  naming the carrier', /Zimex Freight/.test(d.querySelector('#rows').textContent));
    ck('  the container', /MSDU1122334/.test(d.querySelector('#rows').textContent));
    ck('  and the date', /2026-11-20/.test(d.querySelector('#rows').textContent));
    ck('the record form is there', !!d.querySelector('#newForm') && !!d.querySelector('#f_company'));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — it shows the AGENT\'s intention, not its own');
// ══════════════════════════════════════════════════════════════════════════
// The route runs pickupAgent.nextAction on every row precisely so the screen
// cannot invent its own view. A page that computed "waiting on them" itself
// would drift from what is actually being sent, and she would have no way to
// tell which was lying.
{
    const { d } = await mount({ rows: [ROW({ next_step: 'chase', next_why: 'nobody has answered' })] });
    const t = d.querySelector('#rows').textContent;
    ck('the next step is shown', /chase/.test(t), t);
    ck('  with the agent\'s own reason', /nobody has answered/.test(t), t);

    const quiet = await mount({ rows: [ROW({ next_step: null, next_why: 'pickup is on 2026-11-20, not today' })] });
    ck('a row with nothing due says why', /not today/.test(quiet.d.querySelector('#rows').textContent));
}

// ══════════════════════════════════════════════════════════════════════════
section('C — the two things she must be able to SEE');
// ══════════════════════════════════════════════════════════════════════════
{
    // Read from her mail → the date is a model's reading and she said to
    // check it. The row must say so unprompted.
    const mail = await mount({ rows: [ROW({ source: 'email' })] });
    ck('a pickup read from her mail is flagged as such',
       /read from your mail/.test(mail.d.querySelector('#rows').textContent),
       mail.d.querySelector('#rows').textContent);
    ck('  and tells her to check the date',
       /check the date/.test(mail.d.querySelector('#rows').textContent));

    // Unreachable is the silent gap this whole feature exists to close.
    const nobody = await mount({ rows: [ROW({ reachable: false,
        unreachable_why: 'no email and no WhatsApp number on file for Nobody Logistics' })] });
    const t = nobody.d.querySelector('#rows').textContent;
    ck('a pickup nobody can be asked about says so loudly', /No way to reach them/.test(t), t);
    ck('  with the reason', /no email and no WhatsApp/.test(t), t);
    ck('  and offers no "next step" it cannot take', !/Next:/.test(t), t);

    // A contact she did not type is a thing she is entitled to see.
    const learned = await mount({ rows: [ROW({ contacts_learned: true })] });
    ck('a remembered contact is disclosed',
       /contact remembered/.test(learned.d.querySelector('#rows').textContent));
}

// ══════════════════════════════════════════════════════════════════════════
section('D — the answer, the way it usually arrives');
// ══════════════════════════════════════════════════════════════════════════
{
    const answered = await mount({ rows: [ROW({ eta: 'truck at 2pm' })] });
    const t = answered.d.querySelector('#rows').textContent;
    ck('an answered pickup shows what they said', /truck at 2pm/.test(t), t);
    ck('  and offers no ETA box, because it is answered',
       answered.d.querySelectorAll('.etaBox').length === 0);

    const open = await mount({ rows: [ROW()] });
    ck('an unanswered one has a box for what they told her',
       open.d.querySelectorAll('.etaBox').length === 1);

    // It POSTs to the route, with the words they used.
    open.d.querySelector('.etaBox').value = 'after lunch';
    open.d.querySelector('.etaSave').click();
    await new Promise((r) => setTimeout(r, 40));
    const posted = open.calls.find((c) => c.method === 'POST' && /\/eta$/.test(c.url));
    ck('saving it posts to the ETA route', !!posted, JSON.stringify(open.calls.map((c) => c.url)));
    ck('  carrying their exact words', posted && posted.body.eta === 'after lunch',
       JSON.stringify(posted && posted.body));
    ck('  against the right pickup', posted && /\/api\/pickups\/pk1\/eta/.test(posted.url), posted && posted.url);

    // An empty one is refused HERE too, not just by the route — a round trip
    // to be told off is a worse way to learn it.
    const empty = await mount({ rows: [ROW()] });
    empty.d.querySelector('.etaSave').click();
    await new Promise((r) => setTimeout(r, 40));
    ck('an empty ETA is refused without a round trip',
       !empty.calls.some((c) => /\/eta$/.test(c.url)), JSON.stringify(empty.calls.map((c) => c.url)));
    ck('  and says what to type', /whatever they said/.test(empty.d.querySelector('#err').textContent),
       empty.d.querySelector('#err').textContent);
}

// ══════════════════════════════════════════════════════════════════════════
section('E — recording one, through the form');
// ══════════════════════════════════════════════════════════════════════════
{
    const { d, calls } = await mount({ rows: [] });
    ck('an empty list says so rather than looking broken',
       /Nothing arranged yet/.test(d.querySelector('#rows').textContent));

    d.querySelector('#f_company').value = 'AJ Transport';
    d.querySelector('#f_date').value = '11/25/2026';
    d.querySelector('#f_container').value = 'TEMU7944250';
    d.querySelector('#newForm').dispatchEvent(new d.defaultView.Event('submit'));
    await new Promise((r) => setTimeout(r, 40));
    const post = calls.find((c) => c.method === 'POST' && /\/api\/pickups$/.test(c.url));
    ck('the form posts to the route the API expects', !!post, JSON.stringify(calls.map((c) => c.url)));
    ck('  with the company and date', post && post.body.company === 'AJ Transport'
       && post.body.pickup_date === '11/25/2026', JSON.stringify(post && post.body));
    // MM/DD/YYYY is what this form will produce, and pickupAgent reads it.
    ck('  sending the date exactly as typed, slashes and all',
       post && /\//.test(post.body.pickup_date), JSON.stringify(post && post.body.pickup_date));
}

// ══════════════════════════════════════════════════════════════════════════
section('F — a failure is SAID, on the page');
// ══════════════════════════════════════════════════════════════════════════
// The claims page's whole problem was a half-drawn screen that looked
// finished, with the only explanation in a toast that fades.
{
    const { d } = await mount({ fail: 'the store could not be read' });
    const err = d.querySelector('#err');
    ck('a failed load is announced', err.style.display === 'block', err.style.display);
    ck('  naming the reason', /store could not be read/.test(err.textContent), err.textContent);
    // FIRST VERSION OF THIS CHECK grepped the whole file for "toast" and
    // went red on the SHARED CSS BLOCK copied from the other pages, which
    // defines a .toast class this page never uses. That is a check shaped
    // like the old code rather than like the property.
    //
    // The property is that the message cannot vanish on its own: the element
    // is in the static markup, and nothing schedules it away.
    ck('  the error element is part of the page, not conjured and removed',
       /<div id="err">/.test(HTML));
    const script = HTML.slice(HTML.lastIndexOf('<script>'));
    ck('  and nothing is scheduled to clear it',
       !/setTimeout[\s\S]{0,120}#err/.test(script) && !/setTimeout[\s\S]{0,120}say\(/.test(script),
       'a message that fades before she reads it is the claims-page fault again');
}

// ══════════════════════════════════════════════════════════════════════════
section('G — it is reachable from the rail, and served');
// ══════════════════════════════════════════════════════════════════════════
// helpers/bankMatchRoutes.js learnt this the hard way: a page nothing links
// to is a page nobody opens, and reconcile.js went dead that way.
{
    const sb = fs.readFileSync(path.join(ROOT, 'dashboard', 'sidebar.js'), 'utf8');
    ck('the rail has a Pickups row', /\{ id: 'pickups', label: 'Pickups'/.test(sb));
    const pages = fs.readFileSync(path.join(ROOT, 'routes', 'pages.js'), 'utf8');
    ck('  and /pickups is served', /app\.get\('\/pickups'/.test(pages));
    ck('  the page claims that rail row', /data-page="pickups"/.test(HTML));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.log('CRASHED: ' + (e && e.stack || e)); process.exit(1); });
