// ── tests/voice-brief.js ──────────────────────────────────────────────────
// Apsara, 2026-09-20: a Jarvis briefing, and "when i say urgent cutoff - it
// can just say ... like 4 bookings has cut off today. yard has no scope in
// jarvis only scout has".
//
// A real server through /api/voice/ask. Cutoffs are set relative to TODAY IN
// LOS ANGELES (helpers/time.js's clock), yard data is planted on purpose so
// its absence is proven rather than assumed, and the WhatsApp path is checked
// to be unchanged.

const fs = require('fs');
const path = require('path');
const { boot } = require('./helpers/e2e');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

function laDate(offset) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles',
        year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    const d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day + offset));
    return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

function plant(dir) {
    const b = (no, cut, supplier) => ({ booking_number: no, carrier: 'MSC', port_of_loading: 'HOUSTON',
        port_of_discharge: 'BUSAN', cutoff_date: cut, containers: [supplier ? { seq: 1, size: '40HC', supplier } : { seq: 1, size: '40HC' }] });
    fs.writeFileSync(path.join(dir, 'bookings.json'), JSON.stringify({
        T1: b('T1', laDate(0), 'Eccomelt'), T2: b('T2', laDate(0)), T3: b('T3', laDate(0), 'Eccomelt'), T4: b('T4', laDate(0), 'Eccomelt'),
        M1: b('M1', laDate(1), 'Eccomelt'),
        S1: b('S1', laDate(2)),
        F1: b('F1', laDate(20), 'Eccomelt'),
    }));
    fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
        T1: { step: 'forwarded', updated_at: new Date().toISOString() },
        F1: { step: 'not_started', updated_at: new Date(Date.now() - 5 * 86400000).toISOString() },
    }));
    fs.writeFileSync(path.join(dir, 'reply_watch.json'), JSON.stringify({ seen: {}, lastDigestAt: new Date().toISOString(),
        lastDigest: [{ from: 'yurim@example.com', fromName: 'Yurim', subject: 'Houston cutoff' },
                     { from: 'j@example.com', fromName: 'Jayashree', subject: 'Container release' }] }));
    fs.writeFileSync(path.join(dir, 'sales_receipts.json'), JSON.stringify([
        { id: 'r1', date: laDate(0), amount: 25000, mode: 'Wire', customer: 'Daekwang', created_at: new Date().toISOString() },
        { id: 'r0', date: laDate(-9), amount: 999, mode: 'Wire', customer: 'Old', created_at: new Date(Date.now() - 9 * 86400000).toISOString() }]));
    // YARD data — must never reach Jarvis's briefing.
    fs.writeFileSync(path.join(dir, 'loads.json'), JSON.stringify([
        { id: 'EDGE_1', date: laDate(-1), seller: 'YARDSELLERXYZ', amount: 4321 }]));
}

(async () => {
    const j = await boot({});
    plant(j.dir);

    section('A — "urgent cutoff": say the count, show the list');
    for (const q of ['urgent cutoffs', 'urgent cutoff', "what's cutting off today", 'any cutoffs today']) {
        const r = await j.say(q);
        ck(`"${q}" SAYS the count`, /^4 bookings cut off today, 1 tomorrow and 1 in the next 3 days\. 2 of them have no supplier yet\.$/.test(r.json.spoken || ''),
            JSON.stringify(r.json.spoken));
        ck('  and SHOWS every booking', ['T1', 'T2', 'T3', 'T4', 'M1', 'S1'].every((n) => r.json.answer.includes(n)) && !r.json.answer.includes('F1'),
            r.json.answer);
        ck('  without reading a booking number aloud', !/\bT\d\b|\bM1\b|\bS1\b/.test(r.json.spoken || ''));
    }

    section('B — "brief me"');
    for (const q of ['brief me', 'good morning jarvis', 'Jarvis, give me the rundown', 'what do i need to know today']) {
        const r = await j.say(q);
        const s = r.json.spoken || '';
        ck(`"${q}" is a briefing`, /Here's Edge Metals\./.test(s), s);
        ck('  cutoffs as a count', /4 bookings cut off today/.test(s), s);
        ck('  the booking that has not moved', /1 booking hasn't moved in two days/.test(s), s);
        ck('  emails waiting', /2 emails need your reply/.test(s), s);
        ck('  money in, last 24h only', /1 payment came in since yesterday — \$25,000/.test(s) && !/999/.test(s), s);
        ck('  NOTHING from the yard', !/YARDSELLERXYZ|4,321|EDGE_1|load/i.test(s + r.json.answer), s + ' || ' + r.json.answer);
        ck('  the screen has the detail', /CUTOFFS/.test(r.json.answer) && /F1/.test(r.json.answer) && /Yurim/.test(r.json.answer), r.json.answer);
        ck('  short enough to listen to', s.split(/\s+/).length < 60, String(s.split(/\s+/).length) + ' words');
    }
    for (const q of ['status of T1', 'update', 'brief me about T1']) {
        const r = await j.say(q);
        ck(`"${q}" is NOT a briefing`, !/Here's Edge Metals/.test(r.json.spoken || r.json.answer || ''), r.json.answer);
    }
    await j.stop();

    section('C — WhatsApp keeps its own urgent list');
    {
        const k = await boot({});
        plant(k.dir);
        const body = JSON.stringify({ text: 'urgent bookings' });
        const res = await new Promise((resolve, reject) => {
            const rq = require('http').request({ host: '127.0.0.1', port: k.port, path: '/api/bot/command', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${process.env.API_TOKEN}` } },
                (rs) => { let raw = ''; rs.on('data', (c) => { raw += c; }); rs.on('end', () => resolve(raw)); });
            rq.on('error', reject); rq.write(body); rq.end();
        });
        ck('typed "urgent bookings" still gets the original "Urgent cutoffs:" list', /Urgent cutoffs:/.test(res), res.slice(0, 200));
        await k.stop();
    }

    console.log(`\n  ${pass} passed, ${fail} failed`);
    if (fail) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  HARNESS FAILED:', e); process.exit(1); });
