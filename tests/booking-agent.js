// ── tests/booking-agent.js ────────────────────────────────────────────────
// Apsara, 2026-10-03: "Build Maersk api integration to Booking Agent."
//
// END TO END, as far as it can go without her key: the real job, the real
// agent, the real Maersk adapter, real fetch over a real socket — to a local
// server that answers exactly like api.maersk.com (paths, Consumer-Key
// header, response nesting). Only two things are faked, both at a boundary:
//   · the carrier's HOST (a local server stands in for api.maersk.com)
//   · the model (deterministic; a paid, non-deterministic call is a test
//     nobody runs twice)
// Everything else — bookings.json on disk, the lock-protected store, the
// dedupe through alreadySent/markSent — is the code that runs at 7am.
//
// The checks cluster on the two ways this agent could do harm:
//   · touching bookings.json (it must never), and
//   · a confident wrong alert (other line, wrong vessel, other terminal,
//     a documentation deadline mistaken for the cutoff, the model down).

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..');

process.env.JARVIS_TEST = '1';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-booking-agent-'));
process.env.DATA_DIR = TMP;
delete process.env.MAERSK_CONSUMER_KEY;

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

function us(offsetDays) {
    const d = new Date(); d.setDate(d.getDate() + offsetDays);
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}
const iso = (u) => { const [m, d, y] = u.split('/'); return `${y}-${m}-${d}`; };

// ── FAKE MAERSK ─────────────────────────────────────────────────────────
const VESSELS = { 'MAERSK KOWLOON': ['9332999'], 'MAERSK TWIN': ['1111111', '2222222'] };
let DEADLINES = {};          // key `${imo}|${voyage}|${port}` → body
let calls = [];
let forceStatus = null;
const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    calls.push({ path: u.pathname, q: Object.fromEntries(u.searchParams), key: req.headers['consumer-key'] });
    if (forceStatus) { res.writeHead(forceStatus); return res.end('{}'); }
    if (!req.headers['consumer-key']) { res.writeHead(401); return res.end('{}'); }
    res.setHeader('Content-Type', 'application/json');
    if (u.pathname === '/reference-data/vessels') {
        const imos = VESSELS[(u.searchParams.get('vesselNames') || '').toUpperCase()] || [];
        return res.end(JSON.stringify(imos.map(i => ({ vesselIMONumber: i, vesselName: u.searchParams.get('vesselNames') }))));
    }
    if (u.pathname === '/shipment-deadlines') {
        const k = [u.searchParams.get('vesselIMONumber'), u.searchParams.get('voyage'), u.searchParams.get('portOfLoad')].join('|');
        if (!DEADLINES[k]) { res.writeHead(404); return res.end('{}'); }
        return res.end(JSON.stringify(DEADLINES[k]));
    }
    res.writeHead(404); res.end('{}');
});

let BASE_LOCAL = '';
const fetchImpl = (url, opts) => globalThis.fetch(url.replace('https://api.maersk.com', BASE_LOCAL), opts);

// ── FAKE MODEL ──────────────────────────────────────────────────────────
let aiCalls = { identify: 0, roles: 0 };
let aiDead = false;
const ROLE_TRUTH = {
    'Port Cutoff': 'cutoff', 'Commodity Cargo Cutoff': 'cutoff',
    'Earliest Receiving Date': 'erd', 'Shipping Instructions Deadline': 'other',
    'VGM Deadline': 'other', 'Reefer Cutoff': 'other',
};
async function ai(prompt) {
    if (aiDead) return null;
    if (prompt.includes('BOOKINGS:')) {
        aiCalls.identify += 1;
        const rows = JSON.parse(prompt.split('BOOKINGS:\n')[1]);
        return { bookings: rows.map(r => {
            const isM = /maersk/i.test(String(r.carrier) + String(r.vessel_voyage));
            const [v, voy] = String(r.vessel_voyage || '').split('/').map(s => s.trim());
            return { bkgNo: r.bkgNo, carrier: isM ? 'maersk' : 'other', vessel_name: v || null,
                     voyage: voy || null, port_city: r.port_of_loading ? 'Houston' : null, iso_country: 'US' };
        }) };
    }
    if (prompt.includes('NAMES:')) {
        aiCalls.roles += 1;
        const names = JSON.parse(prompt.split('NAMES:\n')[1]);
        return { roles: Object.fromEntries(names.map(n => [n, ROLE_TRUTH[n] || 'other'])) };
    }
    return null;
}

const body = (terminals) => terminals.map(t => ({ shipmentDeadlines: { terminalName: t.name,
    deadlines: t.d.map(([n, day]) => ({ deadlineName: n, deadlineLocal: `${day}T17:00:00` })) } }));

// ── FIXTURE ─────────────────────────────────────────────────────────────
const CUT = us(10), ERD = us(5);
const BOOKINGS = {
    MSK1: { booking_number: 'MSK1', carrier: 'MAERSK', vessel_voyage: 'MAERSK KOWLOON / 118E',
            port_of_loading: 'HOUSTON', cutoff_date: CUT, erd_date: ERD },
    MSC1: { booking_number: 'MSC1', carrier: 'MSC', vessel_voyage: 'MSC ANNA / 512W',
            port_of_loading: 'HOUSTON', cutoff_date: us(8), erd_date: us(3) },
    OLD1: { booking_number: 'OLD1', carrier: 'MAERSK', vessel_voyage: 'MAERSK KOWLOON / 100E',
            port_of_loading: 'HOUSTON', cutoff_date: us(-5), erd_date: us(-10) },
};
const BK = path.join(TMP, 'bookings.json');
fs.writeFileSync(BK, JSON.stringify(BOOKINGS, null, 2));
const BK_BYTES = () => fs.readFileSync(BK, 'utf8');
const ORIGINAL = BK_BYTES();

const sent = []; const marks = {};
const send = async (t) => { sent.push(t); };
const alreadySent = (k) => !!marks[k];
const markSent = async (k) => { marks[k] = 1; };
const deps = () => ({ ai, fetchImpl, gapMs: 0 });

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    BASE_LOCAL = `http://127.0.0.1:${server.address().port}`;
    const job = require(path.join(ROOT, 'helpers/bookingAgentJob'));
    const agent = require(path.join(ROOT, 'helpers/bookingAgent'));

    section('no key: does nothing, says nothing');
    calls = [];
    let r = await job.run({ send, alreadySent, markSent, deps: deps() });
    ck('no message sent', sent.length === 0, JSON.stringify(sent));
    ck('no carrier call made', calls.length === 0, JSON.stringify(calls));
    ck('reports noKey', r.noKey === true);

    process.env.MAERSK_CONSUMER_KEY = 'test-key';

    section('Maersk agrees: silent');
    DEADLINES['9332999|118E|Houston'] = body([{ name: 'Barbours Cut', d: [
        ['Port Cutoff', iso(CUT)], ['Earliest Receiving Date', iso(ERD)], ['Shipping Instructions Deadline', iso(us(7))]] }]);
    calls = []; aiCalls = { identify: 0, roles: 0 };
    r = await job.run({ send, alreadySent, markSent, deps: deps() });
    ck('checked exactly the one live Maersk booking', r.checked === 1, 'checked=' + r.checked);
    ck('agreed', r.agreed === 1);
    ck('silent', sent.length === 0, JSON.stringify(sent));
    ck('Consumer-Key header sent', calls.every(c => c.key === 'test-key'));
    ck('MSC booking never sent to Maersk', !calls.some(c => c.q.voyage === '512W'));
    ck('past-cutoff booking skipped', !calls.some(c => c.q.voyage === '100E'));
    ck('SI deadline not compared as the cutoff', r.findings.length === 0);
    ck('deadlines queried with IMO, voyage, port, country',
        calls.some(c => c.path === '/shipment-deadlines' && c.q.vesselIMONumber === '9332999'
            && c.q.voyage === '118E' && c.q.portOfLoad === 'Houston' && c.q.ISOCountryCode === 'US'));

    section('caches: second run asks the model nothing and the vessel lookup is not repeated');
    calls = []; aiCalls = { identify: 0, roles: 0 };
    await job.run({ send, alreadySent, markSent, deps: deps() });
    ck('no identify call', aiCalls.identify === 0, JSON.stringify(aiCalls));
    ck('no role call', aiCalls.roles === 0, JSON.stringify(aiCalls));
    ck('no vessel lookup', !calls.some(c => c.path === '/reference-data/vessels'));

    section('Maersk moves the cutoff: one message, bookings untouched');
    const MOVED = us(12);
    DEADLINES['9332999|118E|Houston'] = body([{ name: 'Barbours Cut', d: [
        ['Port Cutoff', iso(MOVED)], ['Earliest Receiving Date', iso(ERD)]] }]);
    r = await job.run({ send, alreadySent, markSent, deps: deps() });
    ck('one message', sent.length === 1, 'sent=' + sent.length);
    const msg = sent[0] || '';
    ck('names the booking', msg.includes('MSK1'));
    ck('states our date and Maersk date', msg.includes(`we have ${CUT}`) && msg.includes(MOVED), msg);
    ck('ERD not flagged (it agrees)', !/ERD:/.test(msg), msg);
    ck('says nothing was changed', /Nothing was changed/.test(msg));
    ck('bookings.json byte-identical', BK_BYTES() === ORIGINAL);

    section('same disagreement is not repeated');
    await job.run({ send, alreadySent, markSent, deps: deps() });
    ck('still one message', sent.length === 1, 'sent=' + sent.length);

    section('Maersk moves it again: new message');
    const MOVED2 = us(13);
    DEADLINES['9332999|118E|Houston'] = body([{ name: 'Barbours Cut', d: [['Port Cutoff', iso(MOVED2)]] }]);
    await job.run({ send, alreadySent, markSent, deps: deps() });
    ck('second message', sent.length === 2 && sent[1].includes(MOVED2), sent[1]);

    section('two terminals, one agrees: not a disagreement');
    DEADLINES['9332999|118E|Houston'] = body([
        { name: 'Bayport', d: [['Port Cutoff', iso(us(11))]] },
        { name: 'Barbours Cut', d: [['Port Cutoff', iso(CUT)]] }]);
    r = await agent.check(deps());
    ck('no finding', r.findings.length === 0, JSON.stringify(r.findings));

    section('missing cutoff in our booking');
    const b2 = JSON.parse(ORIGINAL); b2.MSK1.cutoff_date = null;
    r = await agent.check(Object.assign(deps(), { bookings: b2 }));
    ck('kind missing', r.findings.some(f => f.role === 'cutoff' && f.kind === 'missing'), JSON.stringify(r.findings));
    ck('message says we have none', /we have none/.test(job.messageText(r.findings) || ''));

    section('ambiguous vessel name: skipped, not guessed');
    const b3 = { TWN1: { carrier: 'MAERSK', vessel_voyage: 'MAERSK TWIN / 001E', port_of_loading: 'HOUSTON', cutoff_date: us(9) } };
    calls = [];
    r = await agent.check(Object.assign(deps(), { bookings: b3 }));
    ck('skipped as vessel_ambiguous', r.skipped.some(s => s.bkgNo === 'TWN1' && s.reason === 'vessel_ambiguous'), JSON.stringify(r.skipped));
    ck('no deadlines call for it', !calls.some(c => c.path === '/shipment-deadlines'));

    section('model down: no message, no crash, no guess');
    aiDead = true;
    const b4 = { NEW1: { carrier: 'MAERSK', vessel_voyage: 'MAERSK KOWLOON / 118E', port_of_loading: 'HOUSTON', cutoff_date: us(2) } };
    const before = sent.length;
    r = await job.run({ send, alreadySent, markSent, deps: Object.assign(deps(), { bookings: b4 }) });
    ck('aiDown reported', r.aiDown === true);
    ck('nothing sent', sent.length === before);
    ck('booking left unidentified, not guessed', r.skipped.some(s => s.bkgNo === 'NEW1' && s.reason === 'not_identified'));
    aiDead = false;

    section('key refused: one auth message per day, booking check stops');
    forceStatus = 401;
    const b5 = { AUT1: { carrier: 'MAERSK', vessel_voyage: 'MAERSK OTHER / 9E', port_of_loading: 'HOUSTON', cutoff_date: us(9) } };
    const n0 = sent.length;
    r = await job.run({ send, alreadySent, markSent, deps: Object.assign(deps(), { bookings: b5 }) });
    ck('authFailed', r.authFailed === true);
    ck('one auth message', sent.length === n0 + 1 && /could not log in to Maersk/.test(sent[sent.length - 1]));
    await job.run({ send, alreadySent, markSent, deps: Object.assign(deps(), { bookings: b5 }) });
    ck('not repeated the same day', sent.length === n0 + 1);
    forceStatus = null;

    section('store');
    const store = JSON.parse(fs.readFileSync(path.join(TMP, 'booking-agent.json'), 'utf8'));
    ck('learned roles stored', store.roles['Port Cutoff'] === 'cutoff' && store.roles['Shipping Instructions Deadline'] === 'other');
    ck('IMO cached', store.imo['maersk:MAERSK KOWLOON'] === '9332999');
    ck('bookings.json still byte-identical at the end', BK_BYTES() === ORIGINAL);

    server.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED:\n  ' + failures.join('\n  ')); process.exit(1); }
})().catch(e => { console.error(e); server.close(); process.exit(1); });
