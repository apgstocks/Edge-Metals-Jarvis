// ── tests/voice-metals-reports.js ─────────────────────────────────────────
// Apsara, 2026-09-20: "Answer from every Metals screen" — margin, trucking,
// freight, commission, Edge Inventory, quote requests. Read only; Edge
// Metals only.
//
// A real server through /api/voice/ask (and /api/bot/command for WhatsApp).
// The ROWS each screen reads are planted by replacing the helpers' row
// sources; the SUMMARY maths is the helpers' own (margin.summary,
// metalsTrucking.summary), so a figure here is computed the way the screen
// computes it. Real-data shapes for bills↔sales joins are covered by
// tests/margin*.js and tests/bills-sales.js — not re-proven here.

const path = require('path');
const http = require('http');
const { boot } = require('./helpers/e2e');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');
const ROOT = path.join(__dirname, '..');
const H = (f) => require(path.join(ROOT, 'helpers', f));

function plant() {
    const gm = H('gemini.js');
    const orig = gm.callGeminiJSON;
    gm.callGeminiJSON = async (prompt, ...rest) => {
        if (/AVAILABLE ACTIONS/i.test(prompt) && /lorry money/i.test(prompt))
            return { action: 'metals_report', report: 'trucking', target_name: 'Jio', confidence: 0.9 };
        return orig(prompt, ...rest);
    };
    H('margin.js').rows = () => [
        { key: 'C1', container_no: 'C1', state: 'closed', revenue: 100000, cost: 80000, margin: 20000 },
        { key: 'C2', container_no: 'C2', state: 'closed', revenue: 50000, cost: 45000, margin: 5000 },
        { key: 'C3', container_no: 'C3', state: 'bought', cost: 30000 },
    ];
    H('metalsTrucking.js').payables = () => [
        { trucking_company: 'Sher Trucking', amount: 1200, paid: 0, balance: 1200, status: 'unpaid' },
        { trucking_company: 'Sher Trucking', amount: 800, paid: 800, balance: 0, status: 'paid' },
        { trucking_company: 'Jio Transport', amount: 600, paid: 100, balance: 500, status: 'part' },
        { trucking_company: 'NTG', amount: null, paid: 0, balance: 0, status: 'missing' },
    ];
    H('salesSettlements.js').payables = () => [
        { kind: 'charge', container_no: 'C1', customer: 'Daekwang', what: 'Ocean freight', amount: 3000, paid: 1000, balance: 2000 },
        { kind: 'charge', container_no: 'C2', customer: 'Daekwang', what: 'THC', amount: 400, paid: 400, balance: 0 },
        { kind: 'commission', container_no: 'C1', customer: 'Daekwang', what: 'Commission', amount: 900, paid: 0, balance: 900 },
    ];
    const inv = H('edgeInventory.js');
    inv.suppliers = () => ['Eccomelt', 'Oakland Metals'];
    inv.summary = (s) => s === 'Eccomelt' ? { receipts: 3, weight_lb: 110231, weight_mt: 50, amount: 42000 } : { receipts: 0, weight_mt: 0, amount: 0 };
    inv.byGrade = () => [{ description: 'HMS 1&2', weight_mt: 50, amount: 42000 }];
    H('supplierAccount.js').overview = () => [{ supplier: 'Eccomelt', closing: 12000 }, { supplier: 'Oakland Metals', closing: 0 }];
    H('quoteRequests.js').loadQuoteRequests = () => [
        { status: 'active', origin_raw: 'Rad Metals, LA', destination_raw: 'Long Beach',
          legs: [{ trucker_name: 'Sher Trucking', status: 'price_received', price: { amount: 450 } },
                 { trucker_name: 'NTG', status: 'price_received', price: { amount: 395 } },
                 { trucker_name: 'TQL', status: 'awaiting_reply', price: null }] },
        { status: 'closed', origin_raw: 'Old', destination_raw: 'Old', legs: [] },
    ];
    H('contactQuoteRequests.js').loadContactQuoteRequests = () => [];
}

(async () => {
    const j = await boot({});
    plant();
    const A = async (q) => { const r = await j.say(q, 'jarvis'); return { s: r.json.spoken || '', a: r.json.answer || '', j: r.json }; };

    section('A — each screen, said short and shown in full');
    let r = await A("what's our margin");
    ck('margin: the closed-container figure', /margin is \$25,000 — 16\.67% on \$150,000 of sales/.test(r.s), r.s);
    ck('  one bought and not yet sold', /1 bought and not yet sold/.test(r.s), r.s);

    r = await A('how much do we owe for trucking');
    ck('trucking: owed across the unpaid bills', /We owe \$1,700 in Edge Metals trucking, across 2 bills\. 1 haul has no amount yet\./.test(r.s), r.s);
    ck('  screen lists by company', /Sher Trucking — \$1,200\.00/.test(r.a) && /Jio Transport — \$500\.00/.test(r.a), r.a);

    r = await A('what freight do we owe');
    ck('freight: owed and total', /We owe \$2,000 in freight and charges, on 1 line, out of \$3,400 in total\./.test(r.s), r.s);
    r = await A('commission owed');
    ck('commission: owed', /We owe \$900 in commission/.test(r.s), r.s);

    r = await A('edge inventory');
    ck('Edge Inventory overview', /2 suppliers in Edge Inventory\. We owe \$12,000/.test(r.s), r.s);

    r = await A('any quotes back');
    ck('quote requests: open ones only', /^1 quote request open\. 2 prices in, 1 still waiting\.$/.test(r.s), r.s);
    ck('  screen shows the best price', /best \$395\.00 \(NTG\)/.test(r.a), r.a);

    section('B — Edge Metals only');
    for (const q of ['how much profit did the yard make', 'what do we owe on yard trucker bills', 'show me petty cash']) {
        const x = await A(q);
        ck(`Jarvis does not answer "${q}" from a Metals screen`, !/margin is|Edge Metals trucking|freight and charges/.test(x.s + x.a), x.a);
    }

    section('C — WhatsApp gets the full text');
    const body = JSON.stringify({ text: 'trucking bills' });
    const raw = await new Promise((resolve, reject) => {
        const rq = http.request({ host: '127.0.0.1', port: j.port, path: '/api/bot/command', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${process.env.API_TOKEN}` } },
            (rs) => { let d = ''; rs.on('data', (c) => { d += c; }); rs.on('end', () => resolve(d)); });
        rq.on('error', reject); rq.write(body); rq.end();
    });
    ck('typed "trucking bills" gets the screen text', /TRUCKING \(Edge Metals\)/.test(raw), raw.slice(0, 200));

    section('D — the AI path carries the fields it is told to return');
    {
        // The classifier stub is installed in plant(), BEFORE brain.js is
        // first required: brain.js destructures callGeminiJSON at load, so a
        // patch made afterwards is never seen.
        const x = await A('what lorry money is pending with jio');
        ck('an AI-classified report reaches the handler WITH its fields', /We owe \$500 in Edge Metals trucking to Jio/.test(x.s), x.s + ' || ' + x.a);
    }

    await j.stop();
    console.log(`\n  ${pass} passed, ${fail} failed`);
    if (fail) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  HARNESS FAILED:', e); process.exit(1); });
