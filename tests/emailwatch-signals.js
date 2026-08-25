// ── tests/emailwatch-signals.js ─────────────────────────────────────────────
// Apsara, 2026-08-25, after reviewing the email-watcher research: "yes" —
// build the two changes with the strongest evidence behind them. See
// claude/jarvis-emailwatcher-research.md.
//
//   A. HISTORICAL PRIOR. buildPrompt received only from/subject/date/body, so
//      every needs_reply call was content-only. Yang et al. (SIGIR 2017, 938k
//      enterprise emails) found historical interaction features ALONE reach
//      0.6924 AUC against 0.7208 for their full model — who the sender is
//      predicts nearly as well as reading the email. Jarvis already observed
//      every one of those signals and discarded them.
//
//   B. QUOTE GROUNDING. asked_for was free-generated. Smart To-Do (ACL 2020)
//      got a 64% BLEU gain from a copy mechanism. We cannot change Gemini's
//      decoder, so we demand a verbatim span and VERIFY it — an unverifiable
//      quote means the request was composed, not read. Same failure class as
//      the fabricated "I miss you" email.
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = (p) => path.join(__dirname, '..', p);

let pass = 0, fail = 0;
const failures = [];
function ck(name, cond, detail) {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ew-'));
process.env.DATA_DIR = scratch;
delete require.cache[require.resolve(R('config.js'))];
const cfg = require(R('config.js'));

const gemini = require(R('helpers/gemini.js'));
let AI = null, LAST_PROMPT = null;
gemini.callGeminiJSON = async (p) => { LAST_PROMPT = p; return AI; };

const rw = require(R('workflow/replyWatch.js'));

(async () => {

// ══ A. sender history ══════════════════════════════════════════════════════
section('A1 — the ledger keys on the ADDRESS, not the display name');
{
    const store = { senderStats: {} };
    rw.recordSenderEvent(store, 'Kristal Sosethan <kristal@zimex.com>', 'flagged');
    rw.recordSenderEvent(store, 'kristal@zimex.com', 'replied');
    rw.recordSenderEvent(store, '"Kristal S." <KRISTAL@ZIMEX.COM>', 'flagged');

    const keys = Object.keys(store.senderStats);
    ck('one sender, one record — display name and address do not split it',
        keys.length === 1 && keys[0] === 'kristal@zimex.com',
        `got keys: ${JSON.stringify(keys)}`);
    ck('counts accumulate correctly', store.senderStats['kristal@zimex.com'].flagged === 2
        && store.senderStats['kristal@zimex.com'].replied === 1);
    ck('and a reply timestamp is kept', !!store.senderStats['kristal@zimex.com'].lastRepliedAt);

    rw.recordSenderEvent(store, '', 'flagged');
    ck('an empty sender is ignored rather than creating a junk key',
        Object.keys(store.senderStats).length === 1);
}

section('A2 — history is only stated when it is actually evidence');
{
    const mk = (flagged, replied) => ({ senderStats: { 'x@y.com': { flagged, replied } } });
    ck('no history at all -> say nothing', rw.senderHistoryLine({ senderStats: {} }, 'x@y.com') === '');
    ck('1 data point -> say nothing', rw.senderHistoryLine(mk(1, 0), 'x@y.com') === '');
    ck('2 data points -> still nothing (two points are not a pattern)',
        rw.senderHistoryLine(mk(2, 2), 'x@y.com') === '');

    const ignored = rw.senderHistoryLine(mk(6, 0), 'x@y.com');
    ck('6 flagged / 0 replied -> stated plainly', /6/.test(ignored) && /none/i.test(ignored));
    ck('and hedged, not turned into a rule', /can still break the pattern/i.test(ignored),
        'a never-answered sender must not become un-flaggable');

    const active = rw.senderHistoryLine(mk(10, 9), 'x@y.com');
    ck('10 flagged / 9 replied -> reported with a percentage', /9 of 10/.test(active) && /90%/.test(active));
    ck('and described as an active relationship', /reliably answers/i.test(active));

    const patchy = rw.senderHistoryLine(mk(10, 3), 'x@y.com');
    ck('a middling ratio is described as such, not overstated', /only sometimes/i.test(patchy));
}

section('A3 — history reaches the prompt, outside the injection fence');
{
    const history = 'HISTORY WITH THIS SENDER: she has replied to 9 of 10 flagged emails from them (90%).';
    const p = rw.buildPrompt({ from: 'a@b.com', subject: 's', date: 'd', body: 'the body', history });
    ck('the history line is in the prompt', p.includes(history));

    // It is Jarvis's own observation, not sender-supplied text. Putting it
    // inside the fence would label our own record as untrusted data, and —
    // worse — let a sender who writes fence markers position text next to it.
    const fenceStart = p.indexOf(rw.FENCE);
    ck('and sits BEFORE the fence, as our observation not their content',
        p.indexOf(history) < fenceStart && fenceStart > -1);

    const noHist = rw.buildPrompt({ from: 'a@b.com', subject: 's', date: 'd', body: 'the body' });
    ck('with no history, no empty header is emitted', !/HISTORY WITH THIS SENDER/.test(noHist));
    ck('the prompt is otherwise unchanged', /MARKETING or SALES OUTREACH/.test(noHist));
}

section('A4 — history is a prior, never a veto');
{
    const p = rw.buildPrompt({ from: 'a@b.com', subject: 's', date: 'd', body: 'x',
        history: 'HISTORY WITH THIS SENDER: 6 flagged, none answered.' });
    ck('the prompt says to treat it as a prior', /treat it as a PRIOR/i.test(p));
    ck('and explicitly that it must not override the content', /never override the content/i.test(p));
    ck('and that an ignored sender can still send the one that matters',
        /can still send the one message that matters/i.test(p));
    ck('and that it must not leak into the summary she reads', /Never mention it in the summary/i.test(p));
}

// ══ B. quote grounding ═════════════════════════════════════════════════════
section('B1 — a quote must actually appear in the email');
{
    const body = 'Hi Apsara,\n\nCould you please send the rate for LA to Houston this week?\n\nThanks,\nRaj';
    ck('a verbatim span verifies', rw.quoteAppearsIn('send the rate for LA to Houston', body));
    ck('whitespace and line-break tidying is still a copy',
        rw.quoteAppearsIn('send  the rate\n  for LA to Houston', body));
    ck('case differences are still a copy', rw.quoteAppearsIn('SEND THE RATE FOR LA TO HOUSTON', body));
    ck('smart quotes normalise', rw.quoteAppearsIn('“send the rate for LA to Houston”', body));

    ck('a FABRICATED request does not verify', !rw.quoteAppearsIn('please send the signed BOL', body),
        'an invented quote passed verification — the whole guard is useless');
    ck('a paraphrase does not verify', !rw.quoteAppearsIn('he wants a Houston rate', body));
    ck('a too-short fragment is not evidence', !rw.quoteAppearsIn('rate', body));
    ck('null / empty never verifies', !rw.quoteAppearsIn(null, body) && !rw.quoteAppearsIn('', body));
}

section('B2 — an ungrounded asked_for is dropped, end to end through assess()');
{
    const body = 'Hi, just confirming we received the container yesterday. All good.';

    AI = { needs_reply: true, confidence: 0.8, urgency: 'normal', summary: 'Wants a rate',
           asked_for: 'a rate for LA to Houston', asked_for_quote: 'please send me a rate for LA to Houston' };
    const bad = await rw.assess({ from: 'a@b.com', subject: 's', date: 'd', body });
    ck('an invented asked_for is dropped', bad.asked_for === null,
        'a request nobody made would have been shown to her as what they want');
    ck('and its fake quote goes with it', bad.asked_for_quote === null);
    ck('but the email is still flagged — only the detail was unsafe', bad.needs_reply === true);
    ck('and the summary survives', bad.summary === 'Wants a rate');

    const realBody = 'Hi Apsara, could you please confirm the cutoff date for DALA123?';
    AI = { needs_reply: true, confidence: 0.9, urgency: 'high', summary: 'Wants the cutoff',
           asked_for: 'the cutoff date for DALA123', asked_for_quote: 'confirm the cutoff date for DALA123' };
    const good = await rw.assess({ from: 'a@b.com', subject: 's', date: 'd', body: realBody });
    ck('a genuinely grounded asked_for survives', good.asked_for === 'the cutoff date for DALA123');
    ck('and carries its evidence', good.asked_for_quote === 'confirm the cutoff date for DALA123');

    AI = { needs_reply: true, confidence: 0.7, urgency: 'low', summary: 'FYI',
           asked_for: null, asked_for_quote: null };
    const none = await rw.assess({ from: 'a@b.com', subject: 's', date: 'd', body });
    ck('no asked_for at all is fine, not an error', none && none.asked_for === null && none.needs_reply === true);
}

section('B3 — the prompt demands a verbatim span');
{
    const p = rw.buildPrompt({ from: 'a', subject: 'b', date: 'c', body: 'd' });
    ck('asked_for_quote is requested', /asked_for_quote/.test(p));
    ck('and required to be verbatim', /copied verbatim/i.test(p));
    ck('and explicitly not a paraphrase', /do not paraphrase/i.test(p));
    ck('and is in the output shape', /"asked_for_quote": null/.test(p));
}

// ══ store round-trip ═══════════════════════════════════════════════════════
section('The ledger survives a save/load round-trip');
{
    fs.writeFileSync(cfg.REPLY_WATCH_FILE, JSON.stringify({ seen: {}, tracked: [], lastDigest: [], undelivered: [] }));
    const store = rw.loadStore();
    ck('a store written before this change loads with an empty ledger',
        store.senderStats && typeof store.senderStats === 'object');

    rw.recordSenderEvent(store, 'ops@zimex.com', 'flagged');
    rw.recordSenderEvent(store, 'ops@zimex.com', 'replied');
    await rw.saveStore(store);

    const again = rw.loadStore();
    ck('the ledger persists', again.senderStats['ops@zimex.com'].flagged === 1
        && again.senderStats['ops@zimex.com'].replied === 1);
    ck('and nothing else in the store was disturbed',
        Array.isArray(again.tracked) && Array.isArray(again.lastDigest));
}

console.log(`\n================================================================`);
console.log(`${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILED:'); failures.forEach((f) => console.log(`  - ${f}`)); }
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(fail ? 1 : 0);

})().catch((e) => {
    console.error('HARNESS CRASHED:', e);
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(1);
});
