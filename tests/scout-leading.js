// ── tests/scout-leading.js ──────────────────────────────────────────────────
// Apsara, 2026-11-15: "I want Scout to help in leading the questions like a proper assistant ... just
// like how ChatGPT works", and, asked which half she wanted: "ask everything missing in one go --> no".
// So: after an answer Scout offers up to three tappable next steps. Opt-in (`lead`), so the voice path
// and every other caller are untouched. The model is faked; the wiring is the thing under test.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-scoutlead-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc';
const ROOT = path.join(__dirname, '..');

let SCRIPT = []; let PROMPTS = [];
const geminiPath = require.resolve(path.join(ROOT, 'helpers/gemini.js'));
require.cache[geminiPath] = { id: geminiPath, filename: geminiPath, loaded: true, exports: {
    callGeminiJSON: async (prompt) => { PROMPTS.push(prompt); const n = SCRIPT.shift(); return typeof n === 'function' ? n(prompt) : (n || { answer: 'no script', have_data: true }); },
} };

const cfg = require(path.join(ROOT, 'config'));
const { mutateJson } = require(path.join(ROOT, 'helpers/json'));
const { askYard, cleanFollowUps } = require(path.join(ROOT, 'helpers/yardAsk'));

(async () => {
section('A. what may go on a button');
{
    const out = cleanFollowUps(["Show Randy's loads", 'What is still owed on EDGE_262?', 'Pay $4,200 to Randy', 'Sell 3000 lb of rotors', 'Loads on 11/13', 'Loads on 2026-11-13', "show randy's loads", 'x'.repeat(90), '<b>hi</b>', '', null, 'Record a sale to Metalco', 'A fourth one']);
    ck('keeps names, items and load ids', out.includes("Show Randy's loads") && out.includes('What is still owed on EDGE_262?') && out.includes('Record a sale to Metalco'), JSON.stringify(out));
    ck('drops anything carrying an amount, a weight or a date', !out.some((t) => /\$4,200|3000 lb|11\/13|2026-11-13/.test(t)), JSON.stringify(out));
    ck('drops markup, blanks, over-long text and repeats', out.length === 3 && !out.some((t) => /</.test(t) || t.length > 80), JSON.stringify(out));
    ck('never more than three', cleanFollowUps(['a one', 'b two', 'c three', 'd four', 'e five']).length === 3);
    ck('garbage in, nothing out', cleanFollowUps(undefined).length === 0 && cleanFollowUps('nope').length === 0 && cleanFollowUps({}).length === 0);
}

section('B. through askYard: opt-in, and absent for everyone else');
{
    PROMPTS = []; SCRIPT = [{ answer: 'Randy sold us 3 loads.', have_data: true, follow_ups: ["Show Randy's loads", 'What do we owe Randy?'] }];
    const led = await askYard('what did Randy sell us', { role: 'admin', lead: true });
    ck('asked to lead: the next steps come back', JSON.stringify(led.follow_ups) === JSON.stringify(["Show Randy's loads", 'What do we owe Randy?']), JSON.stringify(led));
    ck('  and the prompt asked for them, forbidding figures', /follow_ups/.test(PROMPTS[0]) && /NEVER put an amount/.test(PROMPTS[0]));
    ck('  and it does NOT ask for the checklist she turned down', !/ALL the missing|one go|checklist/i.test(PROMPTS[0]));

    PROMPTS = []; SCRIPT = [{ answer: 'Randy sold us 3 loads.', have_data: true, follow_ups: ['Show Randy\'s loads'] }];
    const plain = await askYard('what did Randy sell us', { role: 'admin' });
    ck('NOT asked (the voice path, the old widget): no key at all', !('follow_ups' in plain), JSON.stringify(Object.keys(plain)));
    ck('  and the prompt never mentions follow-ups', !/follow_ups/.test(PROMPTS[0]));

    SCRIPT = [{ answer: 'Randy sold us 3 loads.', have_data: true, follow_ups: ['Pay Randy', '<script>', 'Pay $5 now'] }];
    const dirty = await askYard('x', { role: 'admin', lead: true });
    ck('what the model offers is cleaned before it is sent', JSON.stringify(dirty.follow_ups) === JSON.stringify(['Pay Randy']), JSON.stringify(dirty.follow_ups));
    SCRIPT = [{ answer: 'ok', have_data: true }];
    const none = await askYard('x', { role: 'admin', lead: true });
    ck('the model offering nothing is an empty list, not a crash', Array.isArray(none.follow_ups) && none.follow_ups.length === 0);
}

section('C. a change waiting on her tap gets no suggestions');
{
    await mutateJson(cfg.LOADS_FILE, [], () => [{ id: 'EDGE_1', date: '2026-11-02', seller: 'Randy', net_weight: 5000, amount: 900, items: [{ description: 'Rotors', net_weight: 5000, amount: 900 }] }]);
    SCRIPT = [{ answer: 'I can record that.', have_data: true, action: { kind: 'record_outbound_sale', params: { buyer: 'Metalco', date: '2026-11-14', price: 0.25, descriptions: ['Rotors'] } }, follow_ups: ['Show Randy\'s loads'] }];
    const out = await askYard('sell the rotors to Metalco at 0.25', { role: 'admin', lead: true });
    ck('there is a card to confirm', !!out.proposal, JSON.stringify(out).slice(0, 160));
    ck('  and no competing suggestions beside it', Array.isArray(out.follow_ups) && out.follow_ups.length === 0, JSON.stringify(out.follow_ups));
}

section('D. END TO END, through the route the widget posts to');
{
    const { createApi } = require(path.join(ROOT, 'api'));
    const server = await new Promise((r) => { const s = createApi().listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {}; if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r2 = http.request(base + p, { method, headers }, (res) => { let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); }); });
        r2.on('error', reject); if (data) r2.write(data); r2.end();
    });
    const admin = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
    SCRIPT = [{ answer: 'Randy sold us 1 load.', have_data: true, follow_ups: ["Show Randy's loads", 'What do we owe Randy?'] }];
    const withLead = await req('POST', '/api/yard/ask', { sid: admin, body: { question: 'what did Randy sell us', lead: true } });
    ck('lead:true reaches askYard and the suggestions reach the response', withLead.status === 200 && JSON.stringify(withLead.json.follow_ups) === JSON.stringify(["Show Randy's loads", 'What do we owe Randy?']), JSON.stringify(withLead.json));
    SCRIPT = [{ answer: 'Randy sold us 1 load.', have_data: true, follow_ups: ['Show Randy\'s loads'] }];
    const without = await req('POST', '/api/yard/ask', { sid: admin, body: { question: 'what did Randy sell us' } });
    ck('without it, the response is exactly what it was (no follow_ups key)', without.status === 200 && !('follow_ups' in without.json), JSON.stringify(Object.keys(without.json || {})));
    SCRIPT = [{ answer: 'Randy sold us 1 load.', have_data: true, follow_ups: ['Show Randy\'s loads'] }];
    const trick = await req('POST', '/api/yard/ask', { sid: admin, body: { question: 'x', lead: 'yes' } });
    ck('only a real true switches it on', !('follow_ups' in (trick.json || {})));
    server.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }
process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
