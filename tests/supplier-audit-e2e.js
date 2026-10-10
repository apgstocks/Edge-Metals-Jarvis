// ── tests/supplier-audit-e2e.js ───────────────────────────────────────────
// Apsara, 2026-10-10: "If i ask anything just like i ask human, it should able
// to detect that." — the supplier-account question, asked the way she asks
// it, through the REAL server: /api/voice/ask for the app and
// /api/bot/command for WhatsApp.
//
// Faked: only the classifier's decision (Gemini), installed before brain.js
// loads. Real: the route, brain.js dispatch, actions.metalsReport, the
// report, helpers/supplierAudit.js, and bills/payments written to disk
// through addBill / addBillPayment — the same functions the screens use.
//
// Also proves the classifier is TOLD the report exists: a stub that answers
// supplier_account would pass even if the prompt never mentioned it, and the
// real model would then never choose it.

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

let promptSeen = '';
function plant() {
    const gm = H('gemini.js');
    const orig = gm.callGeminiJSON;
    gm.callGeminiJSON = async (prompt, ...rest) => {
        if (/AVAILABLE ACTIONS/i.test(prompt)) {
            promptSeen = prompt;
            // Only the message being classified — the prompt also carries the
            // last five turns, so matching the whole prompt hears old questions.
            const cur = (prompt.split('═══ NEW MESSAGE ═══')[1] || '').split('═══ AVAILABLE ACTIONS ═══')[0];
            if (/overpay dup/i.test(cur)) return { action: 'metals_report', report: 'supplier_account', target_name: 'dup', confidence: 0.92 };
            if (/supplier accounts/i.test(cur)) return { action: 'metals_report', report: 'supplier_account', target_name: null, confidence: 0.9 };
            if (/paid gomez/i.test(cur)) return { action: 'metals_report', report: 'supplier_account', target_name: 'gomez', confidence: 0.92 };
        }
        return orig(prompt, ...rest);
    };
}

(async () => {
    const j = await boot({});
    plant();
    const bills = H('bills.js');
    const bp = H('billPayments.js');

    // Gomez: two containers, an advance applied, one container still owed.
    const g1 = await bills.addBill({ date: '09/01/2026', supplier: 'Gomez Recycling', container_no: 'GMZ0001',
        items: [{ description: 'Al combo', weight: '51000', price: '0.43' }] });                    // 21,930
    await bills.addBill({ date: '09/10/2026', supplier: 'Gomez Recycling', container_no: 'GMZ0002',
        items: [{ description: 'Auto cast', weight: '40000', price: '0.30' }] });                   // 12,000
    const adv = await bp.addAdvance({ date: '08/28/2026', supplier: 'Gomez Recycling', amount: 5000, mode: 'Wire', bank: 'Chase' });
    await bp.applyAdvance(adv.id, [{ bill_id: g1.id, amount: 5000 }]);
    await bp.addBillPayment({ date: '09/05/2026', supplier: 'Gomez Recycling', amount: 16930, mode: 'Wire', bank: 'Chase',
        allocations: [{ bill_id: g1.id, amount: 16930 }] });

    // Dup Metals: the same wire recorded twice.
    const d1 = await bills.addBill({ date: '09/01/2026', supplier: 'Dup Metals', container_no: 'DUP0001',
        items: [{ description: 'Al combo', weight: '51000', price: '0.43' }] });
    await bp.addBillPayment({ date: '09/05/2026', supplier: 'Dup Metals', amount: 21930, mode: 'Wire', bank: 'Chase', ref: 'FW123',
        allocations: [{ bill_id: d1.id, amount: 21930 }] });
    await bp.addBillPayment({ date: '09/06/2026', supplier: 'Dup Metals', amount: 21930, mode: 'Wire', bank: 'Chase', ref: 'FW123',
        allocations: [{ bill_id: d1.id, amount: 21930 }] });

    const A = async (q) => { const r = await j.say(q, 'jarvis'); return { s: r.json.spoken || '', a: r.json.answer || '' }; };

    section('A — asked like a person: paid, advances, pending');
    let r = await A('how much have we paid gomez so far including advance, and how much is pending');
    ck('the classifier was told supplier_account exists', /"supplier_account"/.test(promptSeen) && /including advances/.test(promptSeen));
    ck('paid including advances', /Gomez Recycling: we've paid \$21,930\.00, including \$5,000\.00 in advances/.test(r.s), r.s);
    ck('pending on the unpaid container', /\$12,000\.00 is still pending on 1 container/.test(r.s), r.s);
    ck('screen names the container still owed', /STILL OWED/.test(r.a) && /GMZ0002 \$12,000\.00/.test(r.a), r.a);

    section('B — overpaid: says so, and says where');
    r = await A('did i overpay dup');
    ck('says overpaid and by how much', /Dup Metals: .*\$21,930\.00 more than owed/.test(r.s), r.s);
    ck('names the duplicate wire', /same reference FW123/.test(r.a), r.a);
    ck('names the day it tipped', /Went into overpayment on 09\/06\/2026/.test(r.a), r.a);

    section('C — every supplier at once');
    r = await A('show me supplier accounts');
    ck('overview says who is owed and who looks overpaid', /We owe \$12,000 across 1 supplier\./.test(r.s) && /Dup Metals/.test(r.s), r.s);

    section('D — WhatsApp gets the full text');
    const body = JSON.stringify({ text: 'how much have we paid gomez so far including advance' });
    const raw = await new Promise((resolve, reject) => {
        const rq = http.request({ host: '127.0.0.1', port: j.port, path: '/api/bot/command', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${process.env.API_TOKEN}` } },
            (rs) => { let d = ''; rs.on('data', (c) => { d += c; }); rs.on('end', () => resolve(d)); });
        rq.on('error', reject); rq.write(body); rq.end();
    });
    ck('typed question gets the account screen', /SUPPLIER ACCOUNT — Gomez Recycling — \$12,000\.00 pending/.test(raw), raw.slice(0, 300));

    await j.stop();
    console.log(`\n  ${pass} passed, ${fail} failed`);
    if (fail) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  HARNESS FAILED:', e); process.exit(1); });
