// ── tests/voice-announce.js ───────────────────────────────────────────────
// Apsara, 2026-09-20: "Jarvis speaks up on its own". The SERVER half, through
// the real route: what qualifies, what is held back, and that nothing from
// the yard ever reaches Jarvis's voice. The page half (when it speaks, quiet
// hours, never opening the mic afterwards) is section ANN of voice-web.js.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { boot } = require('./helpers/e2e');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

(async () => {
    const j = await boot({});
    const get = (q) => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: j.port, path: '/api/voice/announcements' + q,
            headers: { Authorization: `Bearer ${process.env.API_TOKEN}` } }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error(raw.slice(0, 200))); } });
        }).on('error', reject);
    });
    const ago = (m) => new Date(Date.now() - m * 60000).toISOString();

    fs.writeFileSync(path.join(j.dir, 'alerts.json'), JSON.stringify({ snoozed: {}, muted: {}, history: [
        { type: 'cutoff_risk', bkgNo: 'HOU111', message: 'HOU111: cutoff in 1d — still at "Not started"', severity: 'high', at: ago(2) },
        { type: 'stall', bkgNo: 'HOU222', message: 'HOU222 stalled at "Forwarded" for 50h', severity: 'warning', at: ago(3) },
        { type: 'forwarded', bkgNo: 'OAK333', message: 'OAK333 forwarded to Sher Trucking', severity: 'info', at: ago(1) },
        { type: 'stall', bkgNo: 'LGB444', message: 'LGB444 stalled (muted)', severity: 'warning', at: ago(1) },
        { type: 'cutoff_risk', bkgNo: 'OLD1', message: 'OLD1: long ago', severity: 'high', at: ago(600) },
    ] }));
    const muted = JSON.parse(fs.readFileSync(path.join(j.dir, 'alerts.json'), 'utf8'));
    muted.muted = { LGB444: ago(100) };
    fs.writeFileSync(path.join(j.dir, 'alerts.json'), JSON.stringify(muted));
    fs.writeFileSync(path.join(j.dir, 'sales_receipts.json'), JSON.stringify([
        { id: 'r1', date: '09/20/2026', amount: 25000, mode: 'Wire', customer: 'Daekwang', created_at: ago(1) }]));
    fs.writeFileSync(path.join(j.dir, 'loads.json'), JSON.stringify([{ id: 'EDGE_9', seller: 'YARDSELLERXYZ', amount: 4321, created_at: ago(1) }]));
    fs.writeFileSync(path.join(j.dir, 'payments.json'), JSON.stringify([{ id: 'p1', load_id: 'EDGE_9', amount: 4321, created_at: ago(1) }]));

    section('A — first poll is only a cursor');
    const first = await get('');
    ck('no backlog on the first poll', Array.isArray(first.items) && first.items.length === 0 && !!first.now, JSON.stringify(first));

    section('B — what qualifies');
    const r = await get('?since=' + encodeURIComponent(ago(60)));
    const texts = r.items.map((x) => x.text).join(' | ');
    ck('the high cutoff alert', /HOU111: cutoff in 1d/.test(texts), texts);
    ck('the warning stall', /HOU222 stalled/.test(texts), texts);
    ck('the payment in', /Payment in: \$25,000 from Daekwang by Wire/.test(texts), texts);
    ck('NOT the info-level forward she did herself', !/OAK333/.test(texts), texts);
    ck('NOT a muted booking', !/LGB444/.test(texts), texts);
    ck('NOT anything before the cursor', !/OLD1/.test(texts), texts);
    ck('NOTHING from the yard', !/YARDSELLERXYZ|4,321|EDGE_9/.test(texts + r.spoken), texts);
    ck('urgent first', /HOU111/.test(r.items[0].text), texts);
    ck('spoken opens with "Heads up."', /^Heads up\. /.test(r.spoken), r.spoken);
    ck('  without reading booking numbers', !/HOU111|HOU222/.test(r.spoken), r.spoken);

    section('C — more than three: counted, not read');
    const many = JSON.parse(fs.readFileSync(path.join(j.dir, 'alerts.json'), 'utf8'));
    for (let i = 0; i < 4; i++) many.history.push({ type: 'stall', bkgNo: 'X' + i, message: `X${i} stalled`, severity: 'warning', at: ago(1) });
    fs.writeFileSync(path.join(j.dir, 'alerts.json'), JSON.stringify(many));
    const m = await get('?since=' + encodeURIComponent(ago(60)));
    ck('all of them are on the card', m.items.length === 7, String(m.items.length));
    ck('three are spoken, the rest counted', /And 4 more on the board\.$/.test(m.spoken), m.spoken);

    section('D — the on/off switch, by voice');
    const off = await j.say('Jarvis, stop announcements');
    ck('"stop announcements" answers and flips it off', off.json.announce === false && /won't speak up/.test(off.json.answer), JSON.stringify(off.json).slice(0, 200));
    const on = await j.say('announcements on');
    ck('"announcements on" flips it back', on.json.announce === true, JSON.stringify(on.json).slice(0, 200));
    const st = await j.say('stop');
    ck('bare "stop" is still just a dismissal', st.json.announce === undefined && st.json.answer === 'Okay.', st.json.answer);

    await j.stop();
    console.log(`\n  ${pass} passed, ${fail} failed`);
    if (fail) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  HARNESS FAILED:', e); process.exit(1); });
