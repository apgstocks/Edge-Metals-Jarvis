// ── tests/ask-text.js ───────────────────────────────────────────────────────
// Phase 2 of "give all data access to Jarvis" (2026-09-23): the questions
// whose answer is in WORDS — what somebody said, what a document says, what
// she once told Jarvis.
//
// What this guards:
//   A. the SEARCH — her question becomes a valid FTS5 query; identifiers stay
//      exact; question words do not drag in every document
//   B. the INDEX — each source is in it, and the right thing ranks first
//   C. the ANSWER — only from retrieved passages, every claim cited, and
//      "it isn't in what I have" said out loud rather than filled in
//   D. GMAIL — the summary finds the email, the real body answers it
//   E. END TO END through the server, on voice and WhatsApp
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const R = (p) => path.join(__dirname, '..', p);

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');
const A = (r) => (r && r.json && r.json.answer) || '';
const SP = (r) => (r && r.json && r.json.spoken) || '';

function seed(dir, { withMail = true } = {}) {
    if (withMail) {
        fs.writeFileSync(path.join(dir, 'reply_watch.json'), JSON.stringify({
            seen: {}, lastDigest: [], lastDigestAt: null,
            tracked: [
                { id: 'm-zimex', threadId: 't-zimex', fromName: 'Zimex Shipping', from: 'ops@zimex.example',
                  subject: 'HBL draft for TCLU9988776', summary: 'Zimex needs the shipper details corrected on the HBL draft before they can release it.',
                  asked_for: 'corrected shipper details', key_figures: ['HBL ZIM4471'], receivedAt: '2026-09-18', waiting_on: 'her' },
                { id: 'm-joey', threadId: 't-joey', fromName: 'Joey Park', from: 'joey@daekwang.example',
                  subject: 'Order for October', summary: 'Joey wants 4 containers of alternators at $0.58 a pound, CIF Busan.',
                  asked_for: 'a proforma', key_figures: ['4 containers', '$0.58/lb'], receivedAt: '2026-09-19', waiting_on: 'her' },
            ],
        }));
    }
    fs.writeFileSync(path.join(dir, 'email_threads.json'), JSON.stringify([
        { threadId: 't-sent-1', to: 'ops@zimex.example', targetName: 'Zimex', subject: 'Re: HBL draft',
          question: 'We have sent the corrected shipper details, please release the HBL.', sentAt: '2026-09-19' },
    ]));
    fs.writeFileSync(path.join(dir, 'invoice_versions.json'), JSON.stringify({
        MSDU2726332: [{ at: '2026-09-18T10:00:00Z', payload: { inv_no: '26ARIS02', consignee: 'Aris Metals',
            line_items: [{ item_desc: 'scrap auto parts', weight: 7.095, rate: 1208.13, amount: 8574.69 }] } }],
    }));
    fs.writeFileSync(path.join(dir, 'facts.json'), JSON.stringify([
        { id: 'f1', text: 'Taewon pays 30% advance and the balance against scan of documents.', created_at: '2026-08-01' },
    ]));
}

function bot(port, text) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ text });
        const req = http.request({ host: '127.0.0.1', port, path: '/api/bot/command', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
                Authorization: `Bearer ${process.env.API_TOKEN}` } }, (res) => {
            let raw = ''; res.on('data', (d) => { raw += d; });
            res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json, raw }); });
        });
        req.on('error', reject); req.write(body); req.end();
    });
}
const T = (r) => ((r.json && r.json.replies) || []).map((x) => x.text).filter(Boolean).join('\n');

(async () => {

section('A. her question becomes a search');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-text-a-'));
    process.env.DATA_DIR = dir;
    for (const k of Object.keys(require.cache)) if (k.startsWith(R(''))) delete require.cache[k];
    const ti = require(R('helpers/data/textIndex'));

    const m = ti.toMatch('what did Zimex say about the HBL');
    ck('the words that identify it survive', /zimex/i.test(m) && /hbl/i.test(m), m);
    ck('  question words do not', !/"what"|"did"|"say"|"about"|"the"/i.test(m), m);
    ck('  and every term is quoted, so an apostrophe cannot break the query',
       ti.toMatch("what did o'brien say") .split(' OR ').every((t) => /^"[^"]+"\*?$/.test(t)), ti.toMatch("what did o'brien say"));
    const withId = ti.toMatch('anything about TCLU9988776');
    ck('a container number is matched EXACTLY, not as a prefix',
       /"tclu9988776"(?!\*)/.test(withId), withId);
    ck('an ordinary word gets a prefix match', /"invoic\w*"\*/.test(ti.toMatch('invoices')), ti.toMatch('invoices'));
    ck('a question with nothing in it searches for nothing', ti.toMatch('what did they say') === '', ti.toMatch('what did they say'));
    fs.rmSync(dir, { recursive: true, force: true });
}

section('B. the index — every source, and the right one first');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-text-b-'));
    process.env.DATA_DIR = dir;
    for (const k of Object.keys(require.cache)) if (k.startsWith(R(''))) delete require.cache[k];
    seed(dir);
    const ti = require(R('helpers/data/textIndex'));
    const info = ti.ensure({ force: true });
    ck('mail, sent mail, invoices and facts are all indexed',
       info.counts.email === 2 && info.counts.sent_email === 1 && info.counts.invoice === 1 && info.counts.fact === 1,
       JSON.stringify(info.counts));

    const zimex = ti.search('what did Zimex say about the HBL');
    ck('the Zimex email is found', zimex.hits.length > 0 && /zimex/i.test(zimex.hits[0].who + zimex.hits[0].title), JSON.stringify(zimex.hits[0]));
    ck('  and it ranks above the unrelated ones', zimex.hits[0].ref === 'm-zimex', zimex.hits.map((h) => h.ref).join(','));

    const byFigure = ti.search('which invoice had 7.095 MT on it');
    ck('an invoice is found by a figure printed on it', byFigure.hits.some((h) => h.kind === 'invoice' && /26ARIS02/.test(h.title)),
       byFigure.hits.map((h) => `${h.kind}:${h.ref}`).join(','));

    const fact = ti.search("what do we know about Taewon's payment terms");
    ck('something she taught Jarvis is searchable too', fact.hits.some((h) => h.kind === 'fact' && /30%/.test(h.body)),
       fact.hits.map((h) => h.kind).join(','));

    const none = ti.search('what did the harbourmaster say about penguins');
    ck('a question about nothing finds nothing', none.hits.length === 0, JSON.stringify(none.hits.slice(0, 2)));

    // The index has to notice new mail without a restart.
    const store = JSON.parse(fs.readFileSync(path.join(dir, 'reply_watch.json'), 'utf8'));
    store.tracked.push({ id: 'm-new', threadId: 't-new', fromName: 'Sher Trucking', subject: 'Rate for Long Beach',
        summary: 'Sher quotes $780 for Long Beach to the yard.', receivedAt: '2026-09-22' });
    fs.writeFileSync(path.join(dir, 'reply_watch.json'), JSON.stringify(store));
    const after = ti.search('what did Sher quote for Long Beach');
    ck('new mail is searchable immediately', after.hits.some((h) => h.ref === 'm-new'), after.hits.map((h) => h.ref).join(','));
    fs.rmSync(dir, { recursive: true, force: true });
}

section('C. the answer comes from the passages, and says where from');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-text-c-'));
    process.env.DATA_DIR = dir;
    for (const k of Object.keys(require.cache)) if (k.startsWith(R(''))) delete require.cache[k];
    seed(dir);
    const askText = require(R('helpers/data/askText'));
    const gem = require(R('helpers/gemini'));
    const prompts = [];
    let reply = null;
    gem.callGeminiJSON = async (p) => { prompts.push(p); return typeof reply === 'function' ? reply(p) : reply; };

    reply = () => ({ answer: 'Zimex want the shipper details corrected on the HBL draft before they release it [1].', found: true, used: [1] });
    let out = await askText.ask('what did Zimex say about the HBL');
    ck('it answers', out.ok && /shipper details/.test(out.spoken), out.spoken);
    ck('  the prompt carried the retrieved passages, and only those',
       /Zimex Shipping/.test(prompts[0]) && /USING ONLY/.test(prompts[0]), 'the passages were not in the prompt');
    ck('  the screen lists where it came from', /Where that comes from:/.test(out.screen) && /Zimex/.test(out.screen), out.screen);
    ck('  and says how much was searched', /Searched \d+ things on file/.test(out.screen), out.screen);

    // THE ONE THAT MATTERS: not in the passages, so it must not be answered.
    reply = () => ({ answer: "Nothing I have mentions a delay on that shipment.", found: false, used: [] });
    out = await askText.ask('did anyone mention a delay on the Zimex shipment');
    ck('a question the passages do not answer is not invented', out.ok && out.found === false && /Nothing I have/.test(out.spoken), out.spoken);

    // Nothing retrieved at all — an honest account of what was searched.
    out = await askText.ask('what did the harbourmaster say about penguins');
    ck('nothing found says so, and says what was searched',
       out.ok && out.empty && /Nothing I have on file/.test(out.spoken) && /mail I've assessed/.test(out.screen), out.spoken);

    // The model failing does not throw the search away.
    reply = () => null;
    out = await askText.ask('what did Joey ask for');
    ck('if the reader fails, the sources still come back', out.ok && out.degraded && /on screen/.test(out.spoken) && /Joey/.test(out.screen), out.spoken);

    // A citation the model invented cannot point at a passage that is not there.
    reply = () => ({ answer: 'Something [9].', found: true, used: [9] });
    out = await askText.ask('what did Joey ask for');
    ck('an out-of-range citation is dropped rather than shown', out.ok && !/\[9\]/.test(out.screen.split('Where that comes from:')[1] || ''), out.screen);
    fs.rmSync(dir, { recursive: true, force: true });
}

section('D. the summary finds the email, the real body answers it');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-text-d-'));
    process.env.DATA_DIR = dir;
    for (const k of Object.keys(require.cache)) if (k.startsWith(R(''))) delete require.cache[k];
    seed(dir);
    const gmail = require(R('helpers/gmail'));
    gmail.getGmailRead = async () => ({ fake: true });
    gmail.getMessage = async (_c, id) => ({ id, payload: {} });
    gmail.getEmailContent = () => ({ body: 'Please correct the shipper to EDGE METALS INC, 1234 Harbor Blvd, and we will release HBL ZIM4471 today.' });
    const askText = require(R('helpers/data/askText'));
    const gem = require(R('helpers/gemini'));
    let seenPrompt = '';
    gem.callGeminiJSON = async (p) => { seenPrompt = p; return { answer: 'They will release HBL ZIM4471 once the shipper says EDGE METALS INC, 1234 Harbor Blvd [1].', found: true, used: [1] }; };

    const out = await askText.ask('what did Zimex say about the HBL');
    ck('the real email body reached the reader, not just the summary',
       /1234 Harbor Blvd/.test(seenPrompt), 'the prompt only had the assessment');
    ck('  and the answer quotes it', /ZIM4471/.test(out.spoken), out.spoken);
    ck('  the screen says an email was read in full', /read 1 email in full/.test(out.screen), out.screen);

    // No Gmail on the box: it degrades to the assessment and SAYS so.
    gmail.getGmailRead = async () => { throw new Error('not authorized'); };
    for (const k of Object.keys(require.cache)) if (k.includes('askText')) delete require.cache[k];
    const askText2 = require(R('helpers/data/askText'));
    const out2 = await askText2.ask('what did Zimex say about the HBL');
    ck('without Gmail it still answers, and admits it used its own notes',
       out2.ok && /Gmail not connected/.test(out2.screen), out2.screen);
    fs.rmSync(dir, { recursive: true, force: true });
}

section('E. end to end — voice and WhatsApp');
{
    for (const k of Object.keys(require.cache)) if (k.startsWith(R(''))) delete require.cache[k];
    const { boot } = require('./helpers/e2e');
    const j = await boot({});
    seed(j.dir);

    const one = await j.say('what did Zimex say about the HBL');
    ck('voice answers from the mail on file', one.status === 200 && /shipper details/i.test(A(one)), A(one));
    ck('  with its sources on screen', /Where that comes from:/.test(A(one)), A(one));
    ck('  and speaks the answer without reading the source list aloud',
       SP(one) && !/Where that comes from/.test(SP(one)), SP(one));

    const two = await bot(j.port, 'what did Joey ask for');
    ck('WhatsApp gets the same', two.status === 200 && /alternators|proforma|containers/i.test(T(two)), T(two));
    await j.stop();
}

section('F. the python bridge indexes and searches the same');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-text-f-'));
    process.env.DATA_DIR = dir;
    seed(dir);
    delete process.env.JARVIS_SQL_ENGINE;
    for (const k of Object.keys(require.cache)) if (k.startsWith(R(''))) delete require.cache[k];
    const nodeHits = require(R('helpers/data/textIndex')).search('what did Zimex say about the HBL');

    process.env.JARVIS_SQL_ENGINE = 'python';
    for (const k of Object.keys(require.cache)) if (k.startsWith(R(''))) delete require.cache[k];
    const ti2 = require(R('helpers/data/textIndex'));
    const pyInfo = ti2.ensure({ force: true });
    const pyHits = ti2.search('what did Zimex say about the HBL');

    ck('the bridge built the search index', pyInfo.engine === 'python3' && pyInfo.total > 0, JSON.stringify({ engine: pyInfo.engine, total: pyInfo.total }));
    ck('  and finds the same thing, in the same order',
       JSON.stringify(nodeHits.hits.map((h) => h.ref)) === JSON.stringify(pyHits.hits.map((h) => h.ref)),
       `${nodeHits.hits.map((h) => h.ref)} vs ${pyHits.hits.map((h) => h.ref)}`);
    delete process.env.JARVIS_SQL_ENGINE;
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log('\nFAILED:\n  - ' + failures.join('\n  - '));
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
