// ── tests/metals-pay-delete.js ────────────────────────────────────────────
// Apsara, 2026-10-03: "I want jarvis profile to have access to delete
// payments on edge metals.complete access shouldbe given to jarvis profile"
//
// ── WHAT WAS ACTUALLY WRONG ──────────────────────────────────────────────
// Not the permission. She asked for this on 2026-09-16 ("give delete partial
// payment to admin..all types to jarvis profile") and it was built: there are
// FOUR Edge Metals payment ledgers and all four have a requireSuper DELETE
// route that unwinds the mirrored ledger row and writes an audit entry.
//
//   supplier bill payments   DELETE /api/bill-payments/:id      button ✓
//   customer receipts        DELETE /api/sales-receipts/:id      button ✓
//   metals trucking          DELETE /api/metals-trucking/:id     NO BUTTON
//   sale costs (freight,     DELETE /api/sales-settlements/:id   NO BUTTON
//     commission)
//
// Two of the four had no caller anywhere in either client. The Trucking table
// is built from the BILLS, so a wrong payment had no row of its own to press
// anything on; the Freight and Commission screens listed what was OWED and
// what had been PAID against it, and never the payment. The route worked, and
// the screen that would hold the button did not exist.
//
// That is the same shape as 2026-09-23, when a settled load could not be
// reopened because the only way into its payment history was a button that
// loadIsPayable had stopped drawing. Writing it down a second time because
// twice is a pattern: a requireSuper route with no caller is a permission
// that exists on paper.
//
// ── SO THIS FILE ASSERTS TWO DIFFERENT THINGS ────────────────────────────
// Sections A and C go through a REAL SERVER on a real socket: log in with the
// Jarvis password, record a payment through the route the screen posts to,
// delete it through the route the screen deletes with, and read the balance
// back out of the route the screen reads. Per CLAUDE.md rule 3 — a helper
// test and a screen test can both be green while the feature does not work,
// and the gap lives in between.
//
// Sections B, D and E RENDER the page in jsdom and ask the DOM. Grepping the
// source for 'trkPayDel' would prove a string exists, not that a button
// appears on a row — the trap tests/ledger-render.js was written for.
//
// Measured as a DELTA throughout: the point is that deleting a payment puts
// the balance back where it was, not that it reaches some absolute figure a
// later fixture change would move.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-metalspaydel-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
// Before config is required — it reads process.env at module load. Distinct
// strings on purpose: usable() refuses a Jarvis password equal to another
// tier's, and a fixture that tripped that would silently test an admin
// session while claiming to test the profile.
process.env.APP_PASSWORD    = 'user-password-aaa';
process.env.ADMIN_PASSWORD  = 'admin-password-bbb';
process.env.STAFF_PASSWORD  = 'staff-password-ccc';
process.env.JARVIS_PASSWORD = 'jarvis-password-ddd';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.METALS_TRUCKING_FILE).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against real data');
    process.exit(1);
}

const { mutateJson } = require(path.join(ROOT, 'helpers/json'));
const audit = require(path.join(ROOT, 'helpers/audit'));
const payments = require(path.join(ROOT, 'helpers/payments'));
const { createApi } = require(path.join(ROOT, 'api'));

let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { /* reported where it matters */ }

const html = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');
const SCRIPT = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]).join('\n');

// ── the jsdom harness, as tests/ledger-render.js establishes it ───────────
// api() is replaced AFTER the script runs, because the page defines its own
// and would overwrite the stub. IS_SUPER is appended to the SAME source
// rather than assigned in a second eval: it is a top-level `let`, and in an
// indirect eval a `let` lands in a new declarative environment that is
// neither a window property nor visible to a later eval — so `w.IS_SUPER =`
// creates a stray global while the page's own functions keep reading the real
// binding, and the only symptom is a button that never appears.
async function mount(routes, opts = {}) {
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window;
    const boot = opts.isSuper === undefined ? SCRIPT : `${SCRIPT}\n;IS_SUPER = ${opts.isSuper ? 'true' : 'false'};`;
    try { w.eval(boot); } catch (e) { return { w, dom, err: e }; }
    const calls = [];
    w.api = async (p, o) => {
        calls.push({ path: String(p), method: (o && o.method) || 'GET', body: o && o.body });
        const [base, qs] = String(p).split('?');
        const hit = routes[base];
        if (!hit) return {};
        return typeof hit === 'function' ? hit(Object.fromEntries(new w.URLSearchParams(qs || '')), o) : hit;
    };
    // Let the page's own boot (loadTab -> "Loading…" -> await) finish against
    // the stub, so it cannot resume after the render below and overwrite it.
    await new Promise((r) => setTimeout(r, 60));
    return { w, dom, calls };
}


// ── THE REAL WAY IN ──────────────────────────────────────────────────────
// renderPayables writes into #subBody, which only exists once
// renderSalesSubTab has drawn the shell — so calling renderPayables directly
// throws on a null element, and a test that creates #subBody by hand would be
// exercising a path the tab bar never takes. The tab key is 'freight', not
// 'charges': renderPayables treats anything that is not 'commission' as the
// charge side, so an invented name would have passed while testing a screen
// that does not exist.
//
// renderSalesSubTab wraps its body in a try/catch that writes the message
// into #subBody, so a throw in there looks like an empty screen rather than a
// failure. That is the trap that cost a wrong diagnosis on #152, so the throw
// is surfaced here instead of being read as "the button is missing".
async function openSales(w, which) {
    await w.renderSalesSubTab(which);
    const body = w.document.getElementById('subBody');
    const txt = body ? body.textContent : '';
    if (/could not load|Loading…/.test(txt)) {
        throw new Error(`renderSalesSubTab('${which}') did not render: ${txt.slice(0, 160)}`);
    }
    return body;
}

// ── a real server, not a stubbed req/res ──────────────────────────────────
let server, base;
function req(method, urlPath, { sid, body } = {}) {
    return new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r = http.request(base + urlPath, { method, headers }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(raw); } catch (e) {}
                resolve({ status: res.statusCode, json, raw });
            });
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}
const login = async (password) => (await req('POST', '/login', { body: { password } }));

const round2 = (n) => Math.round(n * 100) / 100;

(async () => {

const app = createApi();
await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
base = `http://127.0.0.1:${server.address().port}`;

const jarvis = (await login('jarvis-password-ddd')).json;
const admin = (await login('admin-password-bbb')).json;

// ── A — TRUCKING, THROUGH THE REAL ROUTES ─────────────────────────────────
{
    section('A — a trucking payment recorded and removed, end to end');

    ck('the Jarvis password mints a super session', jarvis && jarvis.super === true
        && jarvis.profile === 'jarvis', JSON.stringify(jarvis));
    ck('  and the admin password does not', admin && admin.super === false,
       JSON.stringify(admin));

    // A bill with a priced haul is what makes a trucking payable exist.
    await mutateJson(cfg.BILLS_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        rows.push({
            id: 'BILL_TRK_1', date: '09/10/2026', supplier: 'Eccomelt',
            booking_no: 'BK-TRK-1', container_no: 'MSKU7777777',
            trucking_company: 'Bayou Haulage', trucking_amount: 1200,
        });
        return rows;
    });

    const openOf = async (sid) => {
        const r = await req('GET', '/api/metals-trucking', { sid });
        const row = (r.json.payables || []).find((x) => x.bill_id === 'BILL_TRK_1');
        return { r, row };
    };

    const before = await openOf(jarvis.sid);
    ck('the haul starts outstanding', !!before.row && before.row.balance === 1200,
       JSON.stringify(before.row && { paid: before.row.paid, balance: before.row.balance }));

    const posted = await req('POST', '/api/metals-trucking', { sid: jarvis.sid, body: {
        date: '09/12/2026', amount: 1200, mode: 'Zelle', bank: 'Bank of America — Edge Metals',
        trucking_company: 'Bayou Haulage', ref: 'ZL-9001',
        allocations: [{ bill_id: 'BILL_TRK_1', amount: 1200 }],
    } });
    ck('the payment posts', posted.status === 200 && posted.json && posted.json.ok,
       posted.status + ' ' + posted.raw.slice(0, 180));
    const payId = posted.json && posted.json.payment && posted.json.payment.id;

    const paidNow = await openOf(jarvis.sid);
    ck('  the haul reads settled', !!paidNow.row && paidNow.row.balance <= 0.005
        && paidNow.row.status === 'paid',
       JSON.stringify(paidNow.row && { paid: paidNow.row.paid, status: paidNow.row.status }));
    ck('  and the payment is on the response the SCREEN reads',
       (paidNow.r.json.payments || []).some((p) => p.id === payId),
       'data.payments is what the new table draws — if it is not here the table cannot exist');

    // ── THE MIRROR ───────────────────────────────────────────────────────
    // addTruckingPayment writes a row into the PAYMENTS ledger too, which is
    // what her spend report reads. A delete that removed the trucking record
    // and left that behind would take the haul back to outstanding while the
    // money stayed spent — wrong in both directions at once, and invisible on
    // either screen alone.
    const ledgerBefore = payments.listPayments().filter((p) => p.load_id === payId).length;
    ck('  it mirrored into the payments ledger', ledgerBefore === 1, String(ledgerBefore));

    // ── AN ADMIN IS REFUSED, AND TOLD WHY ────────────────────────────────
    const asAdmin = await req('DELETE', `/api/metals-trucking/${payId}`, { sid: admin.sid });
    ck('an admin cannot remove it', asAdmin.status === 403, String(asAdmin.status));
    ck('  and the refusal names the profile',
       asAdmin.json && asAdmin.json.code === 'JARVIS_PROFILE_REQUIRED'
       && /Jarvis profile/i.test(asAdmin.json.error || ''),
       JSON.stringify(asAdmin.json));
    const survived = await openOf(jarvis.sid);
    ck('  and nothing moved', !!survived.row && survived.row.paid === 1200,
       JSON.stringify(survived.row && { paid: survived.row.paid }));

    // ── AND THE JARVIS PROFILE CAN ───────────────────────────────────────
    const gone = await req('DELETE', `/api/metals-trucking/${payId}`, { sid: jarvis.sid });
    ck('the Jarvis profile removes it', gone.status === 200 && gone.json && gone.json.removed,
       gone.status + ' ' + gone.raw.slice(0, 180));

    const after = await openOf(jarvis.sid);
    ck('  the haul goes BACK to outstanding — same figure it started at',
       !!after.row && after.row.balance === before.row.balance && after.row.paid === 0,
       JSON.stringify(after.row && { paid: after.row.paid, balance: after.row.balance })
       + ` vs started at ${before.row && before.row.balance}`);
    ck('  the payment is off the list the screen draws',
       !(after.r.json.payments || []).some((p) => p.id === payId));
    ck('  and its ledger row went with it',
       payments.listPayments().filter((p) => p.load_id === payId).length === 0,
       'a surviving ledger row would keep the money spent in her report');

    const entries = audit.listEntries();
    const row = entries.find((e) => e.action === 'delete-metals-trucking' && e.subject === payId);
    ck('  and it is in the audit log, signed by the session not the client',
       !!row && row.actor === 'jarvis',
       JSON.stringify(row && { actor: row.actor, role: row.role }));
    ck('  naming the trucker and the amount that was undone',
       !!row && row.detail && row.detail.trucking_company === 'Bayou Haulage'
       && row.detail.amount === 1200 && (row.detail.allocations || []).length === 1,
       JSON.stringify(row && row.detail));
}

// ── B — AND THERE IS A BUTTON ON THE SCREEN ───────────────────────────────
if (!JSDOM) {
    section('B — the Trucking screen');
    console.log('  SKIPPED — jsdom is not installed, so the page cannot be rendered.');
} else {
    section('B — the Trucking screen, rendered');

    const PAYMENTS = [
        { id: 'MTP_1', date: '09/12/2026', amount: 1200, mode: 'Zelle',
          bank: 'Bank of America — Edge Metals', ref: 'ZL-9001',
          trucking_company: 'Bayou Haulage',
          allocations: [{ bill_id: 'BILL_TRK_1', amount: 1200 }] },
        { id: 'MTP_2', date: '09/14/2026', amount: 800, mode: 'Cash', bank: null, ref: null,
          trucking_company: 'Sher Trucking',
          allocations: [{ bill_id: 'BILL_TRK_2', amount: 500 },
                        { bill_id: 'BILL_TRK_3', amount: 300 }] },
    ];
    const truckingRoute = {
        payables: [{ bill_id: 'BILL_TRK_1', date: '09/10/2026', booking_no: 'BK-TRK-1',
                     container_no: 'MSKU7777777', supplier: 'Eccomelt',
                     trucking_company: 'Bayou Haulage', amount: 1200, paid: 1200,
                     balance: 0, priced: true, missing: [], status: 'paid', split: null }],
        summary: { amount: 1200, paid: 1200, outstanding: 0, unpaid_count: 0, missing_count: 0 },
        facets: { trucking_company: ['Bayou Haulage'], status: ['paid'] },
        total_unfiltered: 1,
        payments: PAYMENTS,
        modes: ['Wire', 'Zelle', 'Cash', 'Cheque'],
        statuses: ['missing', 'unpaid', 'part', 'paid'],
        banks: ['Bank of America — Edge Metals'], other: 'Other',
    };
    const routes = { '/api/metals-trucking': truckingRoute };

    // ── AS THE JARVIS PROFILE ────────────────────────────────────────────
    {
        const { w, dom, err, calls } = await mount(routes, { isSuper: true });
        ck('the page evaluates', !err, err && err.message);
        if (!err) {
            await w.renderMetalsTruckingTab();
            const doc = w.document;
            const dels = [...doc.querySelectorAll('.trkPayDel')];
            ck('  every recorded payment gets a Delete', dels.length === PAYMENTS.length,
               `${dels.length} buttons for ${PAYMENTS.length} payments`);
            ck('  pointing at the payment, not the bill',
               dels.map((b) => b.dataset.id).sort().join(',') === 'MTP_1,MTP_2',
               dels.map((b) => b.dataset.id).join(','));

            // The row has to be readable, not merely present: the whole point
            // is telling one payment from another before removing one.
            const body = doc.body.textContent;
            ck('  the row says who was paid, how, and how much',
               /Bayou Haulage/.test(body) && /Zelle/.test(body)
               && /ZL-9001/.test(body) && /1,200/.test(body),
               'who/how/reference/amount');
            ck('  and how many containers it covers, since they all reopen',
               /2 containers/.test(body), 'MTP_2 covers two');

            // ── IT IS WIRED, NOT JUST DRAWN ──────────────────────────────
            // A button with no handler looks finished and does nothing. This
            // is the check that bit on #152, where renderDetail threw before
            // reaching its own wiring and the button was still on screen.
            w.confirm = () => true;
            let hit = null;
            const realApi = w.api;
            w.api = async (p, o) => {
                if ((o && o.method) === 'DELETE') { hit = { p, m: o.method }; return { ok: true, removed: true }; }
                return realApi(p, o);
            };
            doc.querySelector('.trkPayDel[data-id="MTP_1"]').click();
            await new Promise((r) => setTimeout(r, 30));
            ck('  clicking it DELETEs the right url',
               !!hit && hit.m === 'DELETE' && hit.p === '/api/metals-trucking/MTP_1',
               JSON.stringify(hit));

            // Declining the confirm must not delete. Tested because the
            // guard is the only thing between a mis-click and a reopened
            // container, and a confirm whose answer is ignored is worse than
            // no confirm at all.
            hit = null;
            w.confirm = () => false;
            doc.querySelector('.trkPayDel[data-id="MTP_2"]').click();
            await new Promise((r) => setTimeout(r, 30));
            ck('  saying no deletes nothing', hit === null, JSON.stringify(hit));
            void calls;
        }
        dom.window.close();
    }

    // ── AS AN ADMIN ──────────────────────────────────────────────────────
    // Not "no button" — a dash with a title saying which profile is needed.
    // An absent control answers no question; the import screen's comment
    // makes the same point from the other direction.
    {
        const { w, dom, err } = await mount(routes, { isSuper: false });
        if (!err) {
            await w.renderMetalsTruckingTab();
            const doc = w.document;
            ck('an admin gets no Delete on a trucking payment',
               doc.querySelectorAll('.trkPayDel').length === 0,
               String(doc.querySelectorAll('.trkPayDel').length));
            ck('  but still sees the payments, and is told what is needed',
               /Bayou Haulage/.test(doc.body.textContent)
               && /Jarvis profile/i.test(doc.body.innerHTML),
               'the row is readable; only the action is withheld');
        }
        dom.window.close();
    }
}

// ── C — SALE COSTS, THROUGH THE REAL ROUTES ───────────────────────────────
{
    section('C — a sale-cost settlement recorded and removed, end to end');

    await mutateJson(cfg.SALES_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        rows.push({
            id: 'SALE_SC_1', date: '09/11/2026', customer: 'Aris Enterprises',
            booking_no: 'BK-SC-1', container_no: 'MSDU1212121', hbl_no: 'HBL-1',
            charges: [{ id: 'CH1', what: 'Ocean freight', why: 'Zimex', amount: 2500, direction: 'out' }],
        });
        return rows;
    });

    const openOf = async () => {
        const r = await req('GET', '/api/sales-settlements', { sid: jarvis.sid });
        return { r, row: (r.json.payables || []).find((x) => x.sale_id === 'SALE_SC_1' && x.kind === 'charge') };
    };

    const before = await openOf();
    ck('the charge starts outstanding', !!before.row && before.row.balance === 2500,
       JSON.stringify(before.row && { paid: before.row.paid, balance: before.row.balance }));

    const posted = await req('POST', '/api/sales-settlements', { sid: jarvis.sid, body: {
        date: '09/15/2026', amount: 2500, mode: 'Wire', bank: 'Bank of America — Edge Metals',
        payee: 'Zimex Logistics', ref: 'WR-5500',
        allocations: [{ sale_id: 'SALE_SC_1', kind: 'charge', charge_id: 'CH1', amount: 2500 }],
    } });
    ck('the settlement posts', posted.status === 200 && posted.json && posted.json.ok,
       posted.status + ' ' + posted.raw.slice(0, 200));
    const stId = posted.json && posted.json.settlement && posted.json.settlement.id;

    const paidNow = await openOf();
    ck('  the charge reads settled', !!paidNow.row && paidNow.row.balance <= 0.005,
       JSON.stringify(paidNow.row && { paid: paidNow.row.paid, balance: paidNow.row.balance }));
    ck('  and it is on the response the SCREEN reads',
       (paidNow.r.json.settlements || []).some((s) => s.id === stId),
       'data.settlements is what the new table draws');
    ck('  mirrored into the payments ledger',
       payments.listPayments().filter((p) => p.load_id === stId).length === 1);

    const asAdmin = await req('DELETE', `/api/sales-settlements/${stId}`, { sid: admin.sid });
    ck('an admin cannot remove it', asAdmin.status === 403
        && asAdmin.json && asAdmin.json.code === 'JARVIS_PROFILE_REQUIRED',
       asAdmin.status + ' ' + JSON.stringify(asAdmin.json));

    const gone = await req('DELETE', `/api/sales-settlements/${stId}`, { sid: jarvis.sid });
    ck('the Jarvis profile removes it', gone.status === 200 && gone.json && gone.json.removed,
       gone.status + ' ' + gone.raw.slice(0, 200));

    const after = await openOf();
    ck('  the charge goes BACK to outstanding — same figure it started at',
       !!after.row && after.row.balance === before.row.balance && after.row.paid === 0,
       JSON.stringify(after.row && { paid: after.row.paid, balance: after.row.balance }));
    ck('  and its ledger row went with it',
       payments.listPayments().filter((p) => p.load_id === stId).length === 0);

    const entries = audit.listEntries();
    const row = entries.find((e) => e.action === 'delete-sale-cost' && e.subject === stId);
    ck('  audited as jarvis, naming the payee and amount',
       !!row && row.actor === 'jarvis' && row.detail
       && row.detail.payee === 'Zimex Logistics' && row.detail.amount === 2500,
       JSON.stringify(row && { actor: row.actor, detail: row.detail }));
}

// ── D — AND THERE IS A BUTTON ON THAT SCREEN TOO ──────────────────────────
if (!JSDOM) {
    section('D — the Freight / Commission screens');
    console.log('  SKIPPED — jsdom is not installed.');
} else {
    section('D — the Freight and Commission screens, rendered');

    // Three settlements on purpose: one pure charge, one pure commission, and
    // one that spans both. The spanning one is the reason this tab filters by
    // allocation kind rather than showing everything.
    const SETTLEMENTS = [
        { id: 'ST_CHG', date: '09/15/2026', amount: 2500, mode: 'Wire',
          bank: 'Bank of America — Edge Metals', ref: 'WR-5500', payee: 'Zimex Logistics',
          allocations: [{ sale_id: 'SALE_SC_1', kind: 'charge', charge_id: 'CH1', amount: 2500 }] },
        { id: 'ST_COM', date: '09/16/2026', amount: 400, mode: 'Zelle',
          bank: 'Bank of America — Edge Metals', ref: null, payee: 'Hugo Ramirez',
          allocations: [{ sale_id: 'SALE_SC_2', kind: 'commission', charge_id: null, amount: 400 }] },
        { id: 'ST_BOTH', date: '09/17/2026', amount: 900, mode: 'Cash', bank: null, ref: null,
          payee: 'Carlos G & C',
          allocations: [{ sale_id: 'SALE_SC_3', kind: 'charge', charge_id: 'CH9', amount: 600 },
                        { sale_id: 'SALE_SC_3', kind: 'commission', charge_id: null, amount: 300 }] },
    ];
    const routes = {
        '/api/sales-settlements': {
            settlements: SETTLEMENTS,
            summary: { count: 3, paid: 3800, outstanding: 0 },
            payables: [
                { key: 'SALE_SC_1|charge|CH1', sale_id: 'SALE_SC_1', kind: 'charge', charge_id: 'CH1',
                  booking_no: 'BK-SC-1', container_no: 'MSDU1212121', hbl_no: 'HBL-1',
                  what: 'Ocean freight', why: 'Zimex', amount: 2500, paid: 2500, balance: 0 },
                { key: 'SALE_SC_2|commission', sale_id: 'SALE_SC_2', kind: 'commission', charge_id: null,
                  booking_no: 'BK-SC-2', container_no: 'MSDU3434343', hbl_no: 'HBL-2',
                  what: 'Commission', why: 'Stated amount', amount: 400, paid: 400, balance: 0 },
            ],
            open_payables: [],
            modes: ['Wire', 'Zelle', 'Cash', 'Cheque'],
            banks: ['Bank of America — Edge Metals'], other: 'Other', payees: [],
        },
    };

    // ── CHARGES ──────────────────────────────────────────────────────────
    {
        const { w, dom, err } = await mount(routes, { isSuper: true });
        ck('the page evaluates', !err, err && err.message);
        if (!err) {
            await openSales(w, 'freight');
            const doc = w.document;
            const ids = [...doc.querySelectorAll('.stlDel')].map((b) => b.dataset.id).sort();
            ck('the charge settlement and the spanning one are both here',
               ids.join(',') === 'ST_BOTH,ST_CHG', ids.join(','));
            ck('  and the commission-only one is NOT',
               !ids.includes('ST_COM'),
               'a payment with nothing on this tab has no business being deleted from it');
            ck('  the spanning one is labelled as spanning',
               /spans both/.test(doc.body.textContent)
               && doc.querySelector('.stlDel[data-id="ST_BOTH"]').dataset.mixed === '1',
               'deleting it from here removes its commission half too');
            ck('  and the single-kind one is not',
               doc.querySelector('.stlDel[data-id="ST_CHG"]').dataset.mixed === '',
               doc.querySelector('.stlDel[data-id="ST_CHG"]').dataset.mixed);
            ck('  the row says who was paid and how much',
               /Zimex Logistics/.test(doc.body.textContent) && /2,500/.test(doc.body.textContent));

            w.confirm = () => true;
            let hit = null;
            const realApi = w.api;
            w.api = async (p, o) => {
                if ((o && o.method) === 'DELETE') { hit = p; return { ok: true, removed: true }; }
                return realApi(p, o);
            };
            doc.querySelector('.stlDel[data-id="ST_CHG"]').click();
            await new Promise((r) => setTimeout(r, 30));
            ck('  clicking it DELETEs the right url',
               hit === '/api/sales-settlements/ST_CHG', String(hit));
        }
        dom.window.close();
    }

    // ── COMMISSION ───────────────────────────────────────────────────────
    {
        const { w, dom, err } = await mount(routes, { isSuper: true });
        if (!err) {
            await openSales(w, 'commission');
            const ids = [...w.document.querySelectorAll('.stlDel')].map((b) => b.dataset.id).sort();
            ck('the commission tab shows the commission one and the spanning one',
               ids.join(',') === 'ST_BOTH,ST_COM', ids.join(','));
            ck('  and not the charge-only one', !ids.includes('ST_CHG'), ids.join(','));
        }
        dom.window.close();
    }

    // ── AS AN ADMIN ──────────────────────────────────────────────────────
    {
        const { w, dom, err } = await mount(routes, { isSuper: false });
        if (!err) {
            await openSales(w, 'freight');
            const doc = w.document;
            ck('an admin gets no Delete on a sale-cost payment',
               doc.querySelectorAll('.stlDel').length === 0,
               String(doc.querySelectorAll('.stlDel').length));
            ck('  but still sees the payment',
               /Zimex Logistics/.test(doc.body.textContent));
        }
        dom.window.close();
    }
}

// ── E — NOTHING THAT ALREADY WORKED CHANGED ───────────────────────────────
// The two ledgers that DID have a button are the regression risk here: both
// read metalsCanDelete(), and both sit in the same file that was edited. This
// section is the boring half.
if (JSDOM) {
    section('E — the two ledgers that already had a button');

    const src = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');
    ck('metalsCanDelete is still the one gate, unchanged',
       /function metalsCanDelete\(\) \{\s*return IS_SUPER === true;\s*\}/.test(src),
       'the new buttons reuse it rather than inventing a second rule');
    ck('  and the new buttons go through it, not round it',
       /metalsCanDelete\(\)[\s\S]{0,400}trkPayDel/.test(src)
       && /metalsCanDelete\(\)[\s\S]{0,400}stlDel/.test(src));

    // Server side: all four routes still requireSuper. A client-only change
    // should not have touched this, and the check costs nothing.
    const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    for (const r of ['/api/bill-payments/:id', '/api/sales-receipts/:id',
                     '/api/metals-trucking/:id', '/api/sales-settlements/:id']) {
        const re = new RegExp(`app\\.delete\\('${r.replace(/[/:]/g, (c) => '\\' + c)}',\\s*requireSuper`);
        ck(`  DELETE ${r} is still requireSuper`, re.test(api));
    }

    // ── AND THE EDGE YARD APP IS UNTOUCHED ───────────────────────────────
    // CLAUDE.md rule 5: Edge Yard and Edge Metals are different companies.
    // Trucking and sale costs are Edge Metals ledgers and have never been in
    // the app; this is the check that a later "port it to the phone too"
    // cannot happen by accident without someone deciding to.
    const appSrc = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');
    ck('the Edge Yard app has no metals-trucking screen',
       !/api\/metals-trucking/.test(appSrc) && !/trkPayDel/.test(appSrc));
    ck('  and no sale-cost screen',
       !/api\/sales-settlements/.test(appSrc) && !/stlDel/.test(appSrc));
}

server.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { try { server.close(); } catch (x) {} console.error('threw:', e && e.stack); process.exit(1); });
