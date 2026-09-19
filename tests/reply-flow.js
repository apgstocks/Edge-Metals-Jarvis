// ── tests/reply-flow.js ───────────────────────────────────────────────────
// Apsara, 2026-09-19:
//   "say in email digest-we have received something. if i ask jarvis voice-
//    to send a reply to that. can it do it?"  → "all four", and:
//   "if i have two emails from A, if i say reply to A --> then it should show
//    two mails --> ask which one to respond to .. on user confirmation start
//    drafting the mail - it should show the drafted mail. if user says like
//    jarvis --> Tell them that we are in some issue and we will send it
//    later. Jarvis should able to draft it professionally ... Ask for
//    confirmation by showing drafted email to user."
//
// A REAL SERVER, one sentence per request, through /api/voice/ask — the same
// route the dashboard mic posts to — and the mail that would have LEFT read
// back at the end. Gmail is a fake mailbox with three real-shaped threads;
// Gemini is stubbed deterministically (what is proven here is the flow and
// what reaches the send, not the prose quality of a live model).

const fs = require('fs');
const path = require('path');
const { boot } = require('./helpers/e2e');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');
const A = (r) => (r && r.json && r.json.answer) || (r && r.raw) || '';
const ROOT = path.join(__dirname, '..');

const day = (d) => new Date(Date.now() - d * 86400000).toUTCString();
const BOX = [
    { id: 'm3', threadId: 't3', from: 'Yurim <yurim@example.com>', subject: 'Rate for Busan', date: day(0),
      body: 'Hi Apsara, can you share the rate for Busan this week? Yurim' },
    { id: 'm2', threadId: 't2', from: 'Yurim <yurim@example.com>', subject: 'Houston cutoff', date: day(1),
      body: 'Hi Apsara, please confirm the Houston cutoff for HOU111. Yurim' },
    { id: 'm1', threadId: 't1', from: 'Jayashree Menon <jayashree@example.com>', subject: 'Container release for HOU111', date: day(2),
      body: 'When will the container be released? Jayashree' },
];

function installMailbox() {
    const g = require(path.join(ROOT, 'helpers/gmail.js'));
    const msg = (m) => ({ id: m.id, threadId: m.threadId, snippet: m.body.slice(0, 60), _body: m.body,
        payload: { headers: [
            { name: 'From', value: m.from }, { name: 'To', value: 'apsara@edgemetals.com' },
            { name: 'Subject', value: m.subject }, { name: 'Date', value: m.date },
            { name: 'Message-ID', value: `<${m.id}@mail>` }] , _body: m.body } });
    g.listMessages = async (client, q) => {
        const from = (/from:(\S+)/.exec(q) || [])[1];
        const subj = (/subject:"([^"]+)"/.exec(q) || [])[1];
        return BOX.filter((m) => (!from || m.from.toLowerCase().includes(from.toLowerCase()))
                && (!subj || m.subject.toLowerCase().includes(subj.toLowerCase())))
            .map((m) => ({ id: m.id, threadId: m.threadId }));
    };
    g.getMessage = async (client, id) => { const m = BOX.find((x) => x.id === id); return m ? msg(m) : null; };
    g.getEmailContent = (payload) => ({ body: (payload && payload._body) || '' });
}

function installWriter() {
    const gm = require(path.join(ROOT, 'helpers/gemini.js'));
    const orig = gm.callGeminiJSON;
    gm.callGeminiJSON = async (prompt, ...rest) => {
        if (/HER INSTRUCTION: "([^"]*)"/.test(prompt)) {
            const said = /HER INSTRUCTION: "([^"]*)"/.exec(prompt)[1];
            const wantsSubject = /"subject": "short subject line"/.test(prompt);
            return Object.assign({ body: `Dear team,\n\nREVISED<${said}>\n\nBest regards,\nApsara` },
                wantsSubject ? { subject: 'Revised subject' } : {});
        }
        if (/Return ONLY this JSON: \{ "body"/.test(prompt)) {
            const w = (/What the reply needs to say: (.*)/.exec(prompt) || [])[1] || '';
            return { body: `Hi,\n\nFIRST<${w}>\n\nApsara` };
        }
        return orig(prompt, ...rest);
    };
}

async function fresh(opts) {
    const j = await boot(Object.assign({ gmailKnowsAddress: true }, opts || {}));
    installMailbox();
    installWriter();
    fs.writeFileSync(path.join(j.dir, 'reply_watch.json'), JSON.stringify({
        seen: {}, muted: { senders: {}, threads: {} }, lastDigestAt: new Date().toISOString(),
        lastDigest: [
            { id: 'm1', threadId: 't1', from: 'jayashree@example.com', fromName: 'Jayashree Menon', subject: 'Container release for HOU111' },
            { id: 'm2', threadId: 't2', from: 'yurim@example.com', fromName: 'Yurim', subject: 'Houston cutoff' },
        ] }));
    return j;
}

(async () => {

section('1 — the digest item, said the way people say it');
for (const phrase of [
    'Reply to two saying the cutoff is confirmed for Friday.',
    'reply to the second one saying the cutoff is confirmed for Friday',
    'reply to number 2 saying the cutoff is confirmed for Friday',
    'reply to the Houston cutoff email saying the cutoff is confirmed for Friday',
]) {
    const j = await fresh();
    const r = await j.say(phrase);
    ck(`"${phrase}" drafts to Yurim in the Houston cutoff thread`,
        /Reply to .*yurim@example\.com.*Houston cutoff/is.test(A(r)) && /FIRST<the cutoff is confirmed for Friday>/.test(A(r)), A(r));
    ck('  and asks before sending', /Send this\?/.test(A(r)) && j.mails.length === 0);
    await j.stop();
}
{
    const j = await fresh();
    await j.say('reply to two saying the cutoff is confirmed for Friday');
    const y = await j.say('yes');
    ck('her yes sends it', /^Sent to/i.test(A(y)), A(y));
    const m = j.mails[0] || {};
    ck('  to Yurim, threaded under the flagged message', m.to === 'yurim@example.com' && m.inReplyTo === '<m2@mail>', JSON.stringify(m));
    await j.stop();
}

section('2 — "reply to that"');
{
    const j = await fresh();
    const r = await j.say('reply to that');
    ck('with nothing in focus it asks which, listing the digest',
        /Which one should I reply to\?/.test(A(r)) && /Jayashree/.test(A(r)) && /Yurim/.test(A(r)), A(r));
    const pick = await j.say('the second one');
    ck('"the second one" picks Yurim', /yurim@example\.com/.test(A(pick)) && /Houston cutoff/.test(A(pick)), A(pick));
    await j.stop();
}
{
    const j = await fresh();
    await j.say('reply to 1 saying it releases Monday');
    await j.say('no');
    const r = await j.say('reply to that saying it releases Tuesday');
    ck('after dealing with #1, "that" is #1', /jayashree@example\.com/.test(A(r)) && /Tuesday/.test(A(r)), A(r));
    await j.stop();
}

section('3 — two emails from the same person: list, pick, draft, redraft, confirm');
{
    const j = await fresh();
    const one = await j.say('reply to Yurim');
    ck('it lists BOTH of her recent emails', /2 recent emails from Yurim/.test(A(one))
        && /Rate for Busan/.test(A(one)) && /Houston cutoff/.test(A(one)), A(one));
    ck('  asks which one', /Which one should I reply to\?/.test(A(one)));
    ck('  and has drafted nothing yet', !/Send this/.test(A(one)) && j.mails.length === 0);
    ck('  and the voice screen keeps listening for the answer', one.json.awaiting === true);

    const two = await j.say('the second one');
    ck('her pick drafts in THAT thread', /thread: "Houston cutoff"/.test(A(two)), A(two));
    ck('  shows the draft', /FIRST</.test(A(two)));
    ck('  and asks for a yes', /Send this\?/.test(A(two)) && j.mails.length === 0);

    const three = await j.say('Tell them that we are in some issue and we will send it later');
    ck('"tell them…" redrafts it', /Redrafted\./.test(A(three))
        && /REVISED<Tell them that we are in some issue and we will send it later>/.test(A(three)), A(three));
    ck('  still in the same thread, to the same person', /yurim@example\.com/.test(A(three)) && /Houston cutoff/.test(A(three)));
    ck('  shows it and asks again — nothing sent', /Send this\?/.test(A(three)) && j.mails.length === 0);

    const four = await j.say('make it shorter');
    ck('a second change redrafts again', /Redrafted\./.test(A(four)) && /REVISED<make it shorter>/.test(A(four)), A(four));

    const five = await j.say('yes');
    const m = j.mails[0] || {};
    ck('yes sends the LATEST draft', /^Sent to/i.test(A(five)) && /REVISED<make it shorter>/.test(m.body || ''), JSON.stringify(m));
    ck('  in the thread she picked', m.inReplyTo === '<m2@mail>' && m.subject === 'Re: Houston cutoff', JSON.stringify(m));
    ck('  once', j.mails.length === 1);
    await j.stop();
}
{
    const j = await fresh();
    await j.say('reply to Yurim');
    const r = await j.say('the busan one');
    ck('she can pick by what it is about', /thread: "Rate for Busan"/.test(A(r)), A(r));
    await j.stop();
}
{
    const j = await fresh();
    const r = await j.say('reply to Jayashree saying it releases Monday');
    ck('ONE recent email from them: no question, straight to the draft',
        /jayashree@example\.com/.test(A(r)) && /Send this\?/.test(A(r)) && !/Which one/.test(A(r)), A(r));
    await j.stop();
}
{
    const j = await fresh();
    await j.say('reply to Yurim');
    const r = await j.say('cancel');
    ck('"cancel" at the list drops it', /(dropped|cancel)/i.test(A(r)) && j.mails.length === 0, A(r));
    await j.stop();
}

section('4 — "compose a new email instead?" — yes now works');
{
    const j = await fresh();
    const one = await j.say('reply to Zed saying the truck is late');
    ck('no email from Zed: it offers a new one', /compose a new email instead\?/i.test(A(one)), A(one));
    const two = await j.say('yes');
    ck('her yes drafts the new email', /zed@example\.com/i.test(A(two)) && /Send this/i.test(A(two)), A(two));
    ck('  without sending it', j.mails.length === 0);
    const three = await j.say('tell them the truck will arrive tomorrow instead');
    ck('a new email can be redrafted too', /Redrafted\./.test(A(three)) && /Subject: Revised subject/.test(A(three)), A(three));
    await j.stop();
}
{
    const j = await fresh();
    await j.say('reply to Zed saying the truck is late');
    const r = await j.say('no');
    ck('"no" to the offer drafts nothing', !/Send this/.test(A(r)) && j.mails.length === 0, A(r));
    await j.stop();
}

section('5 — what must NOT happen');
{
    const j = await fresh();
    await j.say('reply to two saying the cutoff is confirmed for Friday');
    const q = await j.say('what is the cutoff for HOU111');
    ck('a question at an open draft is NOT turned into a rewrite', !/Redrafted/.test(A(q)), A(q));
    const y = await j.say('yes');
    ck('  and the draft she saw is what goes', /FIRST<the cutoff is confirmed for Friday>/.test((j.mails[0] || {}).body || ''),
        JSON.stringify(j.mails));
    await j.stop();
}
{
    const j = await fresh();
    fs.writeFileSync(path.join(j.dir, 'reply_watch.json'), JSON.stringify({ seen: {}, lastDigest: [], lastDigestAt: null }));
    const r = await j.say('reply to two saying hello');
    ck('with NO digest, "two" is not turned into a digest item', !/Houston cutoff/.test(A(r)), A(r));
    await j.stop();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  HARNESS FAILED:', e); process.exit(1); });
