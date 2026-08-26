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

    // THE TRAP: saveStore writes an explicit ALLOWLIST of fields, so a new
    // field added to the store object is silently dropped on every write and
    // reads back as null forever. The heartbeat /healthz depends on would have
    // looked correct in the code and been permanently stale in production.
    const stamp = new Date().toISOString();
    store.lastScanAt = stamp;
    await rw.saveStore(store);
    ck('the /healthz heartbeat survives saveStore\'s field allowlist',
        rw.loadStore().lastScanAt === stamp, JSON.stringify(rw.loadStore().lastScanAt));
    fs.writeFileSync(cfg.REPLY_WATCH_FILE, JSON.stringify({ oldflat: 'x' }));
    ck('a legacy store with no heartbeat reads as null, not undefined',
        rw.loadStore().lastScanAt === null);
}


// ══════════════════════════════════════════════════════════════════════════
// C. DIRECTION — Apsara, 2026-08-25, on a live digest: "intent is totally
//    wrong". Jarvis reported
//        1. · Sender is trying to get an EDO number.
//           Andy Park — wants: EDO #
//    when Andy was chasing the CARRIER for that EDO because SHE had asked him
//    to roll HMM BKG #DALA21235600 from HMM RAON 0025W to HMM TURQUOISE 0011W.
//    He owed her the thing the digest said he wanted from her.
// ══════════════════════════════════════════════════════════════════════════

// The real thread, reduced to what Gmail's threads.get(format:'metadata')
// actually returns: headers + snippet, oldest first.
const ANDY = 'andy.park@hmm.example.com';
const ME = 'apsara@edgemetals.com';
const andyThread = [
    { snippet: 'HMM BKG #DALA21235600 confirmed, 2x40HC batteries, initial loading Aug 12.',
      payload: { headers: [{ name: 'From', value: `Andy Park <${ANDY}>` }, { name: 'Date', value: 'Tue, 12 Aug 2026 09:00:00 -0700' }] } },
    { snippet: 'Accounting needs a new ERD of 8/19 or 8/20 please advise',
      payload: { headers: [{ name: 'From', value: `Andy Park <${ANDY}>` }, { name: 'Date', value: 'Mon, 18 Aug 2026 09:00:00 -0700' }] } },
    { snippet: 'Please roll us to HMM TURQUOISE 0011W, ERD 8/25 CUT 8/28.',
      payload: { headers: [{ name: 'From', value: `Apsara <${ME}>` }, { name: 'Date', value: 'Wed, 20 Aug 2026 09:00:00 -0700' }] } },
    { snippet: 'Noted. I am working to get the EDO # ASAP and will revert.',
      payload: { headers: [{ name: 'From', value: `Andy Park <${ANDY}>` }, { name: 'Date', value: 'Mon, 24 Aug 2026 09:00:00 -0700' }] } },
];

section('C1 — the thread ledger makes WHO ASKED WHOM visible');
{
    const led = rw.buildThreadLedger(andyThread, ME);
    ck('her own messages are marked as hers, not by display name', /HER \(the manager\)/.test(led));
    ck('the counterparty is named', /Andy Park/.test(led));
    ck('her roll request is in the ledger — the fact that makes direction knowable',
        /HMM TURQUOISE 0011W/.test(led), led);
    ck('it states the rule the model kept getting backwards',
        /a thing they OWE her, not a thing they want from her/i.test(led));
    ck('a one-message thread produces no ledger (nothing to learn from it)',
        rw.buildThreadLedger([andyThread[0]], ME) === '');
    const long = rw.buildThreadLedger(Array.from({ length: 12 }, () => andyThread[0]), ME);
    ck('a long thread is capped, and says so rather than silently truncating',
        long.split('\n').filter((l) => l.startsWith('- ')).length === 6 && /6 earlier messages not shown/.test(long), long);
    ck('the ledger reaches the prompt', /HMM TURQUOISE 0011W/.test(
        rw.buildPrompt({ from: ANDY, subject: 's', date: 'd', body: 'b', thread: led })));
}

section('C2 — an email she is WAITING ON never becomes an email waiting on HER');
{
    const body = 'Noted. I am working to get the EDO # ASAP and will revert once the line releases it.';
    AI = { waiting_on: 'them', needs_reply: true, confidence: 0.9, urgency: 'normal',
           summary: 'Chasing the carrier for the EDO on the HMM TURQUOISE roll.',
           asked_for: 'the EDO number', asked_for_quote: 'I am working to get the EDO # ASAP',
           deadline: null, is_order: false, order_buyer: null };
    const a = await rw.assess({ from: ANDY, subject: 'DALA21235600', date: 'd', body });
    ck('direction survives the assessment', a.waiting_on === 'them');
    // THE BUG. The model itself said needs_reply true — plausible, since he
    // does owe an answer eventually. Code forces the coupling.
    ck('needs_reply is forced FALSE even though the model said true', a.needs_reply === false);
    ck('the thing he owes is kept, not nulled by the request-grounding check',
        a.asked_for === 'the EDO number', JSON.stringify(a));

    const digest = rw.buildDigest([{ ...a, fromName: 'Andy Park', subject: 'DALA21235600' }]);
    ck('the digest no longer claims an email is waiting on her',
        !/emails? waiting on you/.test(digest), digest);
    ck('it says who is actually blocked', /waiting on someone else/.test(digest), digest);
    ck('the line reads "owes you", not "wants"',
        /Andy Park — owes you: the EDO number/.test(digest), digest);
    ck('and it does not tell her to reply to something nobody asked',
        !/Nothing sent yet/.test(digest) && /others owe you/.test(digest), digest);
}

section('C3 — the anti-fabrication guard still holds in the new direction');
{
    const body = 'Noted. I am working to get the EDO # ASAP.';
    AI = { waiting_on: 'them', needs_reply: false, confidence: 0.9, urgency: 'normal', summary: 's',
           asked_for: 'a rate for LA to Houston', asked_for_quote: 'please send us your best rate',
           deadline: null, is_order: false, order_buyer: null };
    const a = await rw.assess({ from: ANDY, subject: 's', date: 'd', body });
    ck('a quote that is not in the email is still dropped', a.asked_for === null, JSON.stringify(a));

    AI = { ...AI, asked_for: 'the EDO number', asked_for_quote: 'Noted.' };
    const b = await rw.assess({ from: ANDY, subject: 's', date: 'd', body });
    ck('a span that is present but commits to nothing is dropped', b.asked_for === null, JSON.stringify(b));
}

section('C4 — REGRESSION: an ordinary request behaves exactly as before');
{
    const body = 'Hi, could you please confirm the ERD for the Oakland load?';
    AI = { needs_reply: true, confidence: 0.9, urgency: 'normal', summary: 'Wants the ERD confirmed.',
           asked_for: 'the ERD', asked_for_quote: 'could you please confirm the ERD',
           deadline: null, is_order: false, order_buyer: null };   // NOTE: no waiting_on at all
    const a = await rw.assess({ from: ANDY, subject: 's', date: 'd', body });
    ck('a response with no waiting_on field defaults to "her"', a.waiting_on === 'her');
    ck('needs_reply is untouched', a.needs_reply === true);
    ck('asked_for survives request-grounding', a.asked_for === 'the ERD');
    const digest = rw.buildDigest([{ ...a, fromName: 'Andy Park', subject: 's' }]);
    ck('the digest still says waiting on you', /1 email waiting on you/.test(digest), digest);
    ck('and still says "wants:"', /— wants: the ERD/.test(digest), digest);
    ck('and still offers the reply command', /Nothing sent yet/.test(digest), digest);
}

section('C5 — a mixed digest counts each bucket honestly');
{
    const reply = { needs_reply: true, waiting_on: 'her', urgency: 'normal', fromName: 'Kristal', summary: 'Wants a rate.', asked_for: 'a rate', is_order: false };
    const owedI = { needs_reply: false, waiting_on: 'them', urgency: 'normal', fromName: 'Andy Park', summary: 'Chasing the EDO.', asked_for: 'the EDO number', is_order: false };
    const order = { needs_reply: false, waiting_on: 'her', urgency: 'normal', fromName: 'Joey', summary: 'Order for 2x40HC.', asked_for: null, is_order: true, order_buyer: 'Daekwang' };
    const d = rw.buildDigest([reply, owedI, order]);
    ck('replies counted alone', /1 email waiting on you/.test(d), d);
    ck('orders counted separately', /1 order came in/.test(d), d);
    ck('owed counted separately', /1 is waiting on someone else/.test(d), d);
    ck('the owed item is NOT folded into the reply count', !/2 emails waiting on you/.test(d), d);
}

section('C6 — a chase-up does not accuse her of not replying to a thing she cannot reply to');
{
    const m = rw.buildChaseMessage([
        { summary: 'Chasing the EDO.', fromName: 'Andy Park', ageDays: 6, waiting_on: 'them' },
        { summary: 'Wants a rate.', fromName: 'Kristal', ageDays: 6, waiting_on: 'her' },
    ]);
    ck('the owed item says nothing came back', /Andy Park, 6 days ago, nothing back from them yet/.test(m), m);
    ck('the reply item still says no reply yet', /Kristal, 6 days ago, no reply yet/.test(m), m);
}



// ══════════════════════════════════════════════════════════════════════════
// D. KEY FIGURES — Apsara, 2026-08-26, on a live digest:
//        2. · Sender wants confirmation of payment amount sent.
//           octavio fmc — wants: the final amount that was sent
//    Bose had reported receiving $58,313.56 against an expected $58,813.56.
//    Money was $500 short and the digest called it a routine admin ask.
// ══════════════════════════════════════════════════════════════════════════
const OCT = 'octavio@fmc.example.com';
const payThread = [
    { snippet: 'Invoice total for the two containers is $58,813.56 due 8/25.',
      payload: { headers: [{ name: 'From', value: `Apsara <${ME}>` }, { name: 'Date', value: 'Mon, 24 Aug 2026 09:00:00 -0700' }] } },
    { snippet: 'Bank shows we received $58,313.56 yesterday against Edge Metals.',
      payload: { headers: [{ name: 'From', value: 'Edge Metals Bose <bose@edgemetals.com>' }, { name: 'Date', value: 'Tue, 25 Aug 2026 09:00:00 -0700' }] } },
    { snippet: 'Could you please confirm the final amount that was sent yesterday?',
      payload: { headers: [{ name: 'From', value: `octavio fmc <${OCT}>` }, { name: 'Date', value: 'Tue, 25 Aug 2026 17:00:00 -0700' }] } },
];
const payBody = 'Could you please confirm the final amount that was sent yesterday?';

section('D1 — figures survive only if they are really there');
{
    const led = rw.buildThreadLedger(payThread, ME);
    ck('the prompt demands the numbers', /THE NUMBER GOES IN THE SUMMARY/.test(
        rw.buildPrompt({ from: OCT, subject: 's', date: 'd', body: payBody, thread: led })));
    ck('and forbids Jarvis doing the arithmetic itself',
        /NEVER compute, total, convert or round one/.test(
            rw.buildPrompt({ from: OCT, subject: 's', date: 'd', body: payBody })));

    AI = { waiting_on: 'her', needs_reply: true, confidence: 0.9, urgency: 'normal',
           summary: 'Bose received $58,313.56 against $58,813.56 expected — confirm what was sent.',
           asked_for: 'the final amount sent', asked_for_quote: 'confirm the final amount that was sent yesterday',
           key_figures: ['$58,313.56', '$58,813.56'], deadline: null, is_order: false, order_buyer: null };
    const a = await rw.assess({ from: OCT, subject: 'payment', date: 'd', body: payBody, thread: led });
    ck('a figure from ANOTHER message in the thread is kept — this is the whole point',
        a.key_figures.includes('$58,313.56'), JSON.stringify(a.key_figures));
    ck('so is the expected total she herself stated earlier',
        a.key_figures.includes('$58,813.56'), JSON.stringify(a.key_figures));

    // The failure that matters more than the feature.
    AI = { ...AI, key_figures: ['$58,313.56', '$500.00 short'] };
    const b = await rw.assess({ from: OCT, subject: 'payment', date: 'd', body: payBody, thread: led });
    ck('a COMPUTED figure nobody wrote is dropped, not printed as fact',
        !b.key_figures.some((f) => /500/.test(f)), JSON.stringify(b.key_figures));

    AI = { ...AI, key_figures: ['$58,313.56', '$58,313.56', 'USD 58,313.56'] };
    const c = await rw.assess({ from: OCT, subject: 'payment', date: 'd', body: payBody, thread: led });
    ck('the same amount written three ways is listed once', c.key_figures.length === 1, JSON.stringify(c.key_figures));

    AI = { ...AI, key_figures: ['5', '.56', '$58,313.56'] };
    const d = await rw.assess({ from: OCT, subject: 'payment', date: 'd', body: payBody, thread: led });
    ck('stray digits that would match almost anything are refused',
        d.key_figures.length === 1 && d.key_figures[0] === '$58,313.56', JSON.stringify(d.key_figures));

    AI = { ...AI, key_figures: ['$58,313.56', 'A', 'B', 'C', 'D', 'E'], };
    const e = await rw.assess({ from: OCT, subject: 'payment', date: 'd', body: 'x $58,313.56 A B C D E' });
    ck('the list is capped so a digest line cannot run away', e.key_figures.length <= 4, JSON.stringify(e.key_figures));
}

section('D2 — the digest she would have received instead');
{
    const item = { needs_reply: true, waiting_on: 'her', urgency: 'normal', fromName: 'octavio fmc',
        summary: 'Bose received $58,313.56 against $58,813.56 expected — confirm what was sent.',
        asked_for: 'the final amount sent', key_figures: ['$58,313.56', '$58,813.56'], is_order: false };
    const d = rw.buildDigest([item]);
    ck('both amounts are on the page', /\$58,313\.56/.test(d) && /\$58,813\.56/.test(d), d);
    ck('the gap does not have to be read off two numbers — it is stated', /\$500\.00 gap/.test(d), d);
    // The line Apsara actually got.
    ck('it is no longer just "wants confirmation of the amount"',
        !/^\s*2?\.?\s*·?\s*\*?Sender wants confirmation of payment amount sent\.\*?$/m.test(d), d);
    ck('an item with no figures renders exactly as before (no empty line)',
        !/\n   \n/.test(rw.buildDigest([{ ...item, key_figures: [] }])), JSON.stringify(rw.buildDigest([{ ...item, key_figures: [] }])));
}

section('D3 — REGRESSION: a response with no key_figures at all still works');
{
    AI = { needs_reply: true, confidence: 0.9, urgency: 'normal', summary: 'Wants the ERD confirmed.',
           asked_for: 'the ERD', asked_for_quote: 'could you please confirm the ERD',
           deadline: null, is_order: false, order_buyer: null };
    const a = await rw.assess({ from: ANDY, subject: 's', date: 'd', body: 'could you please confirm the ERD for Oakland?' });
    ck('key_figures defaults to an empty array, never undefined', Array.isArray(a.key_figures) && a.key_figures.length === 0);
    ck('nothing else changed', a.asked_for === 'the ERD' && a.needs_reply === true);
}



// ══════════════════════════════════════════════════════════════════════════
// E. THE GAP — Apsara, twice: "still it didnt convey message properly".
//    She had already written the sentence she wanted:
//      "Bose reported receiving $58,313.56, which is $500.00 LESS THAN the
//       expected total of $58,813.56."
//    Listing two amounts and leaving her to subtract them is not that.
//    The subtraction happens in CODE, over verbatim-grounded operands only.
// ══════════════════════════════════════════════════════════════════════════

section('E1 — what counts as money at all');
{
    ck('a dollar amount parses', rw.parseMoneyFigure('$58,313.56') === 58313.56);
    ck('a currency code parses', rw.parseMoneyFigure('USD 58,313.56') === 58313.56);
    ck('two decimals alone are enough', rw.parseMoneyFigure('58313.56') === 58313.56);
    // The guard that stops a booking number being subtracted from a container count.
    ck('a bare integer is NOT money', rw.parseMoneyFigure('DALA21235600') === null);
    ck('nor is a quantity', rw.parseMoneyFigure('2x40HC') === null);
    ck('nor is a year', rw.parseMoneyFigure('2026') === null);
    ck('junk returns null rather than NaN', rw.parseMoneyFigure('') === null && rw.parseMoneyFigure(null) === null);
}

section('E2 — the gap is computed, and only when it is safe to compute one');
{
    const g = rw.figureGap(['$58,313.56', '$58,813.56']);
    ck('the arithmetic is right', g && Math.abs(g.gap - 500) < 1e-9, JSON.stringify(g));
    ck('the currency mark comes with it', g && g.sign === '$', JSON.stringify(g));
    ck('and the figures stay in the order they were reported, not sorted',
        g && g.aText === '$58,313.56' && g.bText === '$58,813.56', JSON.stringify(g));

    // THE FALSE POSITIVE THIS GUARD EXISTS FOR: a unit price beside a total.
    ck('a unit price vs a line total is NOT called a gap',
        rw.figureGap(['$2,420.00', '$58,813.56']) === null);
    // Ambiguity is refused rather than guessed — which pair would you subtract?
    ck('three amounts produce no gap', rw.figureGap(['$58,313.56', '$58,813.56', '$100.00']) === null);
    ck('one amount produces no gap', rw.figureGap(['$58,313.56']) === null);
    ck('no amounts produce no gap', rw.figureGap(['DALA21235600', '2x40HC']) === null);
    ck('identical amounts produce no gap', rw.figureGap(['$58,313.56', 'USD 58,313.56']) === null);
    ck('a bad input returns null instead of throwing', rw.figureGap(null) === null && rw.figureGap(['x', {}]) === null);
}

section('E3 — the line she actually asked for');
{
    const item = { needs_reply: true, waiting_on: 'her', urgency: 'normal', fromName: 'octavio fmc',
        summary: 'Bose received $58,313.56 against $58,813.56 expected — confirm what was sent.',
        asked_for: 'the final amount sent', key_figures: ['$58,313.56', '$58,813.56'], is_order: false };
    const d = rw.buildDigest([item]);
    ck('the digest states the gap, in dollars, without her doing the sum',
        /\$500\.00 gap — \$58,313\.56 vs \$58,813\.56/.test(d), d);
    ck('it is marked so it cannot be skimmed past', /⚠/.test(d), d);
    // Neutral wording on purpose: the code knows the numbers differ, it does
    // NOT know which one was supposed to be correct.
    ck('it does not assert who is short or who underpaid',
        !/(short|underpaid|owes|missing)/i.test(d.split('\n').find((l) => /gap/.test(l)) || ''), d);

    const noGap = rw.buildDigest([{ ...item, key_figures: ['$2,420.00', '$58,813.56'] }]);
    ck('when no safe gap exists the figures are still listed plainly',
        /\$2,420\.00\s+·\s+\$58,813\.56/.test(noGap) && !/gap/.test(noGap), noGap);
}

section('E4 — a gap can only ever be built from GROUNDED figures');
{
    // End to end: a model that invents the higher amount cannot manufacture a
    // gap, because the invented operand is dropped before figureGap sees it.
    AI = { waiting_on: 'her', needs_reply: true, confidence: 0.9, urgency: 'normal', summary: 's',
           asked_for: null, asked_for_quote: null, deadline: null, is_order: false, order_buyer: null,
           key_figures: ['$58,313.56', '$99,999.99'] };
    const a = await rw.assess({ from: 'x@y.com', subject: 's', date: 'd', body: 'we received $58,313.56 yesterday' });
    ck('the invented amount never survives assess()', !a.key_figures.some((f) => /99,999/.test(f)), JSON.stringify(a.key_figures));
    ck('so no gap can be rendered from it', !/gap/.test(rw.buildDigest([{ ...a, fromName: 'x', urgency: 'normal' }])));
}



// ══════════════════════════════════════════════════════════════════════════
// F. WHO WAS ACTUALLY ASKED — Apsara: "but she didnt ask edgemetals".
//    Octavio addressed Aisha. Edge Metals was on the thread, not on the hook.
//    replyWatch had NEVER read the To or Cc headers - not once in the file.
// ══════════════════════════════════════════════════════════════════════════
const BOSE = 'bose@edgemetals.com';   // reads authenticate as bose@, not apsara@

section('F1 — the header rule, decided in code');
{
    const A = (to, cc) => rw.addressing(to, cc, BOSE);
    ck('company in To: this is ours to answer',
        A('Edge Metals Bose <bose@edgemetals.com>', 'octavio@fmc.example.com').inTo === true);
    ck('company only in Cc: nobody here was asked',
        A('Aisha Rahman <aisha@fmc.example.com>', 'bose@edgemetals.com').inTo === false);
    ck('and the person who WAS asked is named from the header, not guessed',
        A('Aisha Rahman <aisha@fmc.example.com>', 'bose@edgemetals.com').toLabel === 'Aisha Rahman');
    ck('a different colleague in To still counts as ours',
        A('apsara@edgemetals.com', '').inTo === true);
    ck('multiple recipients: one company address is enough',
        A('aisha@fmc.example.com, bose@edgemetals.com', '').inTo === true);
    ck('company nowhere at all is still not ours',
        A('aisha@fmc.example.com', 'someone@elsewhere.com').inTo === false);

    // FAIL-OPEN. If we cannot establish the domain we must NOT reclassify
    // every email as somebody else's problem.
    ck('an unknown mailbox fails OPEN to the old behaviour',
        rw.addressing('aisha@fmc.example.com', '', '').unknown === true &&
        rw.addressing('aisha@fmc.example.com', '', '').inTo === true);
    // THE ONE THAT NEARLY SHIPPED A SILENT OUTAGE. An email with no parseable
    // To (Bcc, a list, a forward that lost its headers) must behave exactly as
    // it did before this header was ever read - not vanish from her digest.
    ck('an EMPTY To line fails OPEN, it is not evidence someone else was asked',
        A(null, null).unknown === true && A(null, null).inTo === true);
    ck('same for an unparseable To', A('   ', '').unknown === true && A('   ', '').inTo === true);
}

section('F2 — headers beat the model, in both directions');
{
    const base = { waiting_on: 'her', needs_reply: true, confidence: 0.9, urgency: 'normal',
        summary: 's', asked_for: 'the final amount sent',
        asked_for_quote: 'confirm the final amount that was sent yesterday',
        deadline: null, is_order: false, order_buyer: null, key_figures: [] };
    const body = 'Aisha, could you please confirm the final amount that was sent yesterday?';

    // THE LIVE CASE. Model says "she needs to reply". The To line says Aisha.
    AI = { ...base };
    const a = await rw.assess({ from: OCT, subject: 'payment', date: 'd', body,
        to: 'Aisha Rahman <aisha@fmc.example.com>', cc: BOSE, myAddress: BOSE });
    ck('a question addressed to a third party is not hers', a.waiting_on === 'someone_else', JSON.stringify(a));
    ck('needs_reply is forced false', a.needs_reply === false);
    ck('and the digest can name who was asked', a.asked_of === 'Aisha Rahman', a.asked_of);

    // The reverse: model says someone else, headers say us. Headers win.
    AI = { ...base, waiting_on: 'someone_else', asked_of: 'Aisha', needs_reply: false };
    const b = await rw.assess({ from: OCT, subject: 'payment', date: 'd', body,
        to: BOSE, cc: '', myAddress: BOSE });
    ck('a company address in To overrides the model saying someone else',
        b.waiting_on === 'her', JSON.stringify(b));
    ck('and asked_of is cleared so no line claims a third party', b.asked_of === null);

    // REGRESSION: assess() called with no headers must behave exactly as before.
    AI = { ...base };
    const c = await rw.assess({ from: OCT, subject: 'payment', date: 'd', body });
    ck('no headers supplied means unchanged, never "somebody else\'s"',
        c.waiting_on === 'her' && c.needs_reply === true, JSON.stringify(c));
    ck('asked_of is null on an ordinary item', c.asked_of === null);

    AI = { ...base, waiting_on: 'someone_else', asked_of: null };
    const e = await rw.assess({ from: OCT, subject: 'payment', date: 'd', body });
    ck('a "someone_else" naming nobody falls back to her rather than vanishing',
        e.waiting_on === 'her', JSON.stringify(e));
}

section('F3 — the digest she should have received');
{
    const item = { needs_reply: false, waiting_on: 'someone_else', asked_of: 'Aisha', urgency: 'normal',
        fromName: 'octavio fmc', summary: 'Asked Aisha to confirm the amount sent.',
        asked_for: 'the final amount sent', key_figures: ['$58,313.56', '$58,813.56'], is_order: false };
    const d = rw.buildDigest([item]);
    ck('it is NOT counted as waiting on her', !/waiting on you/.test(d), d);
    ck('the count says whose it is', /1 is for someone else to answer/.test(d), d);
    ck('the line names who was asked', /asked Aisha for: the final amount sent/.test(d), d);
    ck('and says plainly why she is seeing it', /you are only copied in/.test(d), d);
    ck('the money gap still shows — she should see it even if it is not hers',
        /\$500\.00 gap/.test(d), d);
    ck('the footer does not tell her to reply to something nobody asked her',
        /None of this is addressed to you/.test(d) && !/Nothing sent yet/.test(d), d);

    const m = rw.buildChaseMessage([{ summary: 'Amount confirmation.', fromName: 'octavio fmc', ageDays: 4, waiting_on: 'someone_else', asked_of: 'Aisha' }]);
    ck('a chase-up says Aisha has not answered, not that SHE has not replied',
        /Aisha still hasn't answered/.test(m) && !/no reply yet/.test(m), m);
}

section('F4 — a mixed digest keeps all four buckets separate');
{
    const d = rw.buildDigest([
        { needs_reply: true, waiting_on: 'her', urgency: 'normal', fromName: 'Kristal', summary: 'Wants a rate.', asked_for: 'a rate', is_order: false },
        { needs_reply: false, waiting_on: 'them', urgency: 'normal', fromName: 'Andy Park', summary: 'Chasing the EDO.', asked_for: 'the EDO number', is_order: false },
        { needs_reply: false, waiting_on: 'someone_else', asked_of: 'Aisha', urgency: 'normal', fromName: 'octavio fmc', summary: 'Asked Aisha.', asked_for: 'the amount', is_order: false },
        { needs_reply: false, waiting_on: 'her', urgency: 'normal', fromName: 'Joey', summary: 'Order.', asked_for: null, is_order: true, order_buyer: 'Daekwang' },
    ]);
    ck('exactly one is waiting on her', /1 email waiting on you/.test(d), d);
    ck('one order', /1 order came in/.test(d), d);
    ck('one owed to her', /1 is waiting on someone else/.test(d), d);
    ck('one for a third party', /1 is for someone else to answer/.test(d), d);
    ck('the bystander is not folded into the reply count', !/[234] emails waiting on you/.test(d), d);
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
