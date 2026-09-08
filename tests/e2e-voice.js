// ── tests/e2e-voice.js ────────────────────────────────────────────────────
// Apsara, 2026-09-07: "test it end to end. set up testing environment."
//
// A REAL SERVER, A REAL SOCKET, ONE HTTP REQUEST PER SENTENCE. Nothing is
// reached into; the server keeps its own memory between turns exactly as it
// does for the browser. See tests/helpers/e2e.js for what is faked (Gemini,
// because a paid non-deterministic call is a test nobody runs twice) and what
// is not (everything else).
//
// WHY, given there are already 5,400 unit assertions: every bug that actually
// reached her today passed its own unit tests. The numbers that never reached
// the preview. The variable that did not exist on the one path that reopens
// the microphone. The acknowledgement that borrowed the other assistant's
// words. Each module was right; the seams were not. Only a conversation
// crosses the seams.
//
// THE CONVERSATIONS BELOW ARE HERS, in the order she reported them.

const path = require('path');
const { boot } = require('./helpers/e2e');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');
const A = (r) => (r && r.json && r.json.answer) || '';

(async () => {

console.log('\n─ end to end: a real server, one sentence at a time ─────────');

// ══════════════════════════════════════════════════════════════════════════
section('1 — "show me the bookings from Houston", and the follow-up');
// Apsara: "If i ask show me the booking from Houston.. It has to say cutoff
// is next wednesday and show me the exact date in screen so as ERD. On follow
// up, if i ask when is the erd of that booking. Instead of linking the
// context, it just says there are 10 bookings on screen."
{
    const j = await boot({});

    const one = await j.say('show me the bookings from houston');
    ck('the server answers at all', one.status === 200, String(one.status) + ' ' + one.raw.slice(0, 120));
    ck('  it says how many', /2 bookings/i.test(A(one)), A(one));
    ck('  and speaks the cutoff the way a person would',
       /(next \w+|in \d+ days|tomorrow|today)/i.test(A(one)), A(one));
    ck('  without reading the table aloud',
       !/MSC|Maersk|40HC|Eccomelt/i.test(A(one)),
       'she asked it to stop doing this: ' + A(one));

    const rows = (one.json.cards && one.json.cards.rows) || [];
    ck('the panel carries both bookings', rows.length === 2, JSON.stringify(rows.map((r) => r.booking_number)));
    ck('  each with an EXACT cutoff date on screen',
       rows.every((r) => /^\d{2}\/\d{2}\/\d{4}$/.test(r.cutoff)),
       JSON.stringify(rows.map((r) => r.cutoff)));
    ck('  and an EXACT ERD, which is what she asked for',
       rows.every((r) => /^\d{2}\/\d{2}\/\d{4}$/.test(r.erd)),
       JSON.stringify(rows.map((r) => r.erd)));
    ck('  soonest cutoff first, so "the first one" means something',
       rows[0].booking_number === 'HOU111', rows[0].booking_number);

    // THE FOLLOW-UP. This is the exact sentence she reported.
    const two = await j.say('when is the erd of that booking');
    ck('"that booking" is NOT met with "which one?"',
       !/which one/i.test(A(two)), A(two));
    ck('  it resolves to the one just discussed',
       /HOU111/.test(A(two)), A(two));
    ck('  and gives the actual date',
       new RegExp(rows[0].erd.replace(/\//g, '\\/')).test(A(two)) || /\d{2}\/\d{2}\/\d{4}/.test(A(two)),
       A(two));
    ck('  and does NOT redraw the list underneath her',
       !two.json.cards,
       'a list replaced mid-conversation changes what "the first one" points at');

    // A THIRD turn on the same booking — the center has to survive its own use.
    const three = await j.say('and what vessel is it on');
    ck('a third question stays on the same booking',
       /HOU111/.test(A(three)) || /MSC ANNA/.test(A(three)), A(three));

    await j.stop();
}

// ══════════════════════════════════════════════════════════════════════════
section('2 — a proforma, corrected, parked and resumed');
{
    const j = await boot({});

    const start = await j.say('create a proforma for Daekwang, 2 containers, 21 MT of auto cast at 8450, CIF Long Beach');
    ck('the draft opens and reaches the preview',
       !!(start.json.proforma && start.json.proforma.stage), JSON.stringify(start.json.proforma && start.json.proforma.stage));
    ck('  the preview names the buyer and the money',
       /Daekwang/.test(A(start)) && /8,450/.test(A(start)), A(start));
    // An ASK, not necessarily a question mark: with no contact on file the
    // preview blocks on the address, and "Add the contact, or tell me the
    // address." is still asking her before anything is sent.
    ck('  and asks before sending anything',
       /\?/.test(A(start)) || /tell me|add the contact/i.test(A(start)), A(start));
    ck('  with awaiting set, so the mic stays open',
       start.json.awaiting === true, JSON.stringify(start.json.awaiting));

    // HER CORRECTION, verbatim, mid-confirm.
    const fix = await j.say('no no jarvis, trade terms should be CIF Busan');
    ck('the correction lands instead of being swallowed',
       !!A(fix), 'an empty answer means it fell through to the brain');
    ck('  and it SAYS what it changed',
       /^Changed /.test(A(fix)), A(fix));
    ck('  naming Busan', /BUSAN/i.test(A(fix)), A(fix));
    ck('  in her words, not a field key',
       !/port_discharge|shipment_terms/.test(A(fix)), A(fix));

    // PARKING.
    const park = await j.say('lets hold this and work on email');
    ck('"hold this" parks it rather than being read as an answer',
       /Held it/i.test(A(park)), A(park));
    ck('  and says how to get it back', /back to the proforma/i.test(A(park)), A(park));

    // AND THE PARKED DRAFT DOES NOT LEAK. Her explicit instruction: "you do
    // the email -- and it still inherits the proforma's context --> it
    // should not do that."
    const mail = await j.say('what bookings are there from oakland');
    ck('a parked proforma does not colour the next answer',
       !/Daekwang|8,450|auto cast/i.test(A(mail)), A(mail));
    ck('  which still answers the new question', /OAK333|one booking/i.test(A(mail)), A(mail));

    const back = await j.say('back to the proforma');
    ck('it comes back', /Back to it|Daekwang/i.test(A(back)), A(back));
    ck('  with the correction still applied', /BUSAN/i.test(A(back)), A(back));
    ck('  and the two containers she gave it', /2 containers/i.test(A(back)), A(back));

    await j.stop();
}

// ══════════════════════════════════════════════════════════════════════════
section('3 — taking it back');
// Apsara: "what if i say something like jarvis ignore that. i made a mistake"
{
    const j = await boot({});

    // NOTHING OPEN. It must say so rather than answering "OK" to a
    // retraction of nothing.
    const empty = await j.say('jarvis ignore that, i made a mistake');
    ck('with nothing in progress it says so plainly',
       /nothing to take back/i.test(A(empty)), A(empty));
    ck('  and does not claim to have done anything',
       !/^(ok|done|dropped)\b/i.test(A(empty).trim()), A(empty));

    // NOW with a draft open.
    await j.say('create a proforma for Daekwang, 2 containers, 21 MT of auto cast at 8450');
    const cancel = await j.say('actually ignore that, i made a mistake');
    ck('with a draft open it drops it and names it',
       /^Dropped/.test(A(cancel)), A(cancel));
    ck('  naming what went', /Daekwang|proforma/i.test(A(cancel)), A(cancel));

    // AND IT IS REALLY GONE — the next sentence must not be absorbed as an
    // answer to a draft that was cancelled.
    const after = await j.say('what bookings are there from oakland');
    ck('the cancelled draft does not absorb the next sentence',
       /OAK333|one booking/i.test(A(after)), A(after));

    // Alexa's own built-in, over the wire.
    await j.say('create a proforma for Daekwang, 21 MT of auto cast at 8450');
    const nvm = await j.say('never mind');
    ck('AMAZON.CancelIntent\'s "never mind" works end to end',
       /^Dropped|nothing to take back/i.test(A(nvm)), A(nvm));

    await j.stop();
}

// ══════════════════════════════════════════════════════════════════════════
section('4 — WITH THE MODEL DOWN, which is a day she will actually have');
// Not a bonus pass. Gemini is genuinely unreachable for her sometimes, and a
// feature that works only when the model is up fails on the day it matters.
{
    const j = await boot({ gemini: 'down' });

    const one = await j.say('show me the bookings from houston');
    ck('the booking question still answers offline',
       /2 bookings/i.test(A(one)), A(one));
    ck('  and the panel is still drawn with real dates',
       ((one.json.cards || {}).rows || []).every((r) => /\d{2}\/\d{2}\/\d{4}/.test(r.erd)),
       JSON.stringify((one.json.cards || {}).rows));

    const two = await j.say('when is the erd of that booking');
    ck('  and the follow-up still resolves the reference',
       !/which one/i.test(A(two)), A(two) + ' — centering is deterministic, not model work');

    // The offline nets carry the phrases that matter most.
    await j.say('create a proforma for Daekwang, 2 containers, 21 MT of auto cast at 8450');
    const park = await j.say('lets hold this and work on email');
    ck('parking still works from the pattern net', /Held it/i.test(A(park)), A(park));
    const back = await j.say('back to the proforma');
    ck('  and so does resuming', /Back to it|Daekwang/i.test(A(back)), A(back));
    const nvm = await j.say('forget it');
    ck('  and Alexa\'s built-in cancel', /^Dropped/.test(A(nvm)), A(nvm));

    ck('the model really was unreachable for all of that',
       j.prompts.length > 0, 'no prompts recorded — the stub was never consulted, so this proves nothing');

    await j.stop();
}

// ══════════════════════════════════════════════════════════════════════════
section('5 — the seams that unit tests cannot see');
{
    const j = await boot({});

    // AUTH. The endpoint that can send email and message a driver must not
    // answer an unauthenticated caller.
    const http = require('http');
    const bare = await new Promise((resolve) => {
        const body = JSON.stringify({ text: 'show me the bookings from houston' });
        const req = http.request({
            host: '127.0.0.1', port: j.port, path: '/api/voice/ask', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', () => resolve(0));
        req.write(body); req.end();
    });
    ck('no token, no answer', bare === 401 || bare === 403, String(bare));

    // NOTHING CRASHES ON RUBBISH. A recogniser hands over garbage regularly.
    for (const junk of ['', '   ', '...', 'asdkjfhaslkdjfh', '🚢🚢🚢']) {
        const r = await j.say(junk);
        ck(`survives ${JSON.stringify(junk)}`, r.status === 200 || r.status === 400,
           String(r.status) + ' ' + r.raw.slice(0, 80));
    }

    // MEMORY IS SERVER-SIDE. Two "browsers" share it, which is correct for
    // one manager on two devices — and it is asserted so that a change to
    // per-session memory is a decision someone made, not a surprise.
    await j.say('show me the bookings from houston');
    const other = await j.say('when is the erd of that booking');
    ck('memory persists across separate HTTP requests',
       /HOU111/.test(A(other)), A(other));

    await j.stop();
}

// ══════════════════════════════════════════════════════════════════════════
section('6 — an answer is not an amendment, and a dropped message is said');
{
    const j = await boot({});

    // ── MID-QUESTIONING, NOTHING IS A CORRECTION ────────────────────────
    // A draft that is still being asked for fields absorbs her answers. If
    // that path started reporting "Changed the rate to..." she would be told
    // she had corrected something she was only just telling it.
    //
    // A mutation widening `previewed` to drop the nextQuestion() check
    // survived the whole suite until this existed.
    const open1 = await j.say('create a proforma for Daekwang');
    ck('an incomplete draft asks for what is missing',
       /\?/.test(A(open1)), A(open1));
    const ans = await j.say('21 MT of auto cast');
    ck('  and her ANSWER is not reported as a correction',
       !/^Changed /.test(A(ans)),
       A(ans) + ' — she is filling the document in, not amending it');
    const ans2 = await j.say('8450 per MT');
    ck('  nor the next one', !/^Changed /.test(A(ans2)), A(ans2));

    // Only once it is finished does a change become a change.
    const amend = await j.say('no no, trade terms should be CIF Busan');
    ck('  but once it is complete, a change IS reported',
       /^Changed /.test(A(amend)), A(amend));

    await j.say('forget it');
    await j.stop();
}

// ══════════════════════════════════════════════════════════════════════════
section('7 — WhatsApp down: answered, but never silently');
{
    // noBridge leaves global.__jarvisSendMessage unset: Jarvis up, WhatsApp
    // transport gone. actions.init() is still wired, because that is a
    // deployment fact and not part of the outage.
    const j = await boot({ noBridge: true });

    // Questions still answer. This is the whole point of not returning 500 —
    // a cutoff has nothing to do with WhatsApp.
    const q = await j.say('show me the bookings from houston');
    ck('a question still answers with no transport',
       /2 bookings/i.test(A(q)), A(q));

    // AND AN ACTION THAT NEEDED TO SEND SAYS SO. "Done." over a message that
    // never left is the silent failure this whole build has been about.
    const fwd = await j.say('forward HOU111 to Sher Trucking');
    const conf = await j.say('yes');
    const both = A(fwd) + ' | ' + A(conf);
    ck('the forward flow runs rather than crashing',
       !/_send is not a function|Something broke/i.test(both), both);
    // ── THE WORST THING THIS HARNESS FOUND ──────────────────────────────
    // With no transport, executeForward used to mark the container
    // stage:'forwarded', advance the workflow, and answer "HOU111/1
    // forwarded to Sher Trucking" — with zero messages sent. A booking she
    // believes is with a driver who has never heard of it, and a board that
    // says forwarded so nothing will ever chase it.
    ck('  and it does NOT claim a forward that did not happen',
       !/forwarded to/i.test(both), both);
    ck('  it says plainly that it could not reach them',
       /could not reach/i.test(both), both);
    const bk = JSON.parse(require('fs').readFileSync(j.dir + '/bookings.json', 'utf8'));
    ck('  and NOTHING was written to the booking',
       !bk.HOU111.containers[0].trucker && bk.HOU111.containers[0].stage !== 'forwarded',
       JSON.stringify(bk.HOU111.containers[0]));
    // NOT a tautology this time. My first version asserted `!X || X`, which
    // is true for every input — it survived a mutation that deleted the whole
    // refusal message, because it could not fail. A test that cannot fail is
    // an assertion-shaped comment.
    // EITHER LAYER may be the one that speaks, and both are acceptable — what
    // is NOT acceptable is silence. actions.js now refuses the forward with
    // "Could not reach Sher Trucking"; api.js's fallback appends "I could not
    // send to ..." for anything that slipped past. My first version demanded
    // api.js's exact wording and failed against the BETTER message.
    ck('  and the failure is named, by whichever layer caught it',
       (/could not reach/i.test(both) || /could not send/i.test(both))
       && /Sher Trucking/i.test(both),
       both + ' — "Done." over a message that never left is the silent failure '
       + 'this whole build has been about');
    ck('  and nothing actually reached the trucker',
       !j.sent.some((m) => /1555123/.test(String(m.to))),
       JSON.stringify(j.sent));

    // The mechanism, so a rewrite cannot quietly lose it.
    const api = require('fs').readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8');
    ck('the fallback captures replies to HER chat',
       /if \(to === chatId\) \{\s*\n\s*capture\.replies\.push/.test(api),
       'without this the answer itself is lost too, not just the outbound message');
    ck('  and refuses anything aimed elsewhere',
       /refused\.push\(to\);/.test(api),
       'a fallback that "sends" to a trucker by doing nothing is worse than a 500');
    ck('  and the refusal reaches HER, not just the log',
       /I could not send to \$\{\[\.\.\.new Set\(refused\)\]/.test(api),
       'a console line on a server she is not looking at is not telling her');
    ck('  matching what index.js does when waReady is false',
       /reproduces exactly\n\s*\/\/ what index\.js's own sendMessage does when waReady is false/.test(api),
       'inventing a second degraded mode is how two paths drift apart');

    await j.stop();
}

// ══════════════════════════════════════════════════════════════════════════
section('8 — and a forward that DOES go is recorded');
{
    // The mirror of section 7. A guard that refuses everything is not a fix,
    // it is the same bug pointing the other way — so the working path is
    // asserted in the same file, right next to the broken one.
    const j = await boot({});

    const fwd = await j.say('forward HOU111 to Sher Trucking');
    const conf = await j.say('yes');
    const both = A(fwd) + ' | ' + A(conf);
    ck('a reachable trucker IS forwarded', /forwarded to Sher Trucking/i.test(both), both);
    ck('  the message actually left', j.sent.some((m) => /120363111/.test(String(m.to))),
       JSON.stringify(j.sent.map((m) => m.to)));
    ck('  and the booking records it',
       (function () {
           const b = JSON.parse(require('fs').readFileSync(j.dir + '/bookings.json', 'utf8'));
           return b.HOU111.containers[0].trucker === 'Sher Trucking'
               && b.HOU111.containers[0].stage === 'forwarded';
       })(), 'the write must still happen on the happy path');

    // A trucker with no way to reach them at all — same refusal, transport up.
    const bad = await j.say('forward HOU222 to Jio Transport');
    const bad2 = await j.say('yes');
    const badBoth = A(bad) + ' | ' + A(bad2);
    ck('a trucker with no number and no group is refused, not pretended',
       !/forwarded to Jio/i.test(badBoth), badBoth);
    ck('  naming what is missing',
       /no WhatsApp number or email/i.test(badBoth) || /could not reach/i.test(badBoth), badBoth);

    await j.stop();
}

// ══════════════════════════════════════════════════════════════════════════
section('9 — silence from a sender is not failure');
{
    // The contract is `wa !== false`, not truthiness, and the distinction is
    // load-bearing. Several senders in this repo return nothing at all; a
    // sender that has not TOLD us it failed has not failed, and reading
    // silence as failure would refuse forwards that went out perfectly.
    //
    // A mutation tightening this to `!!wa` survived the whole suite until
    // this section existed — and it would have blocked every forward made
    // through a sender that returns undefined.
    const j = await boot({ senderReturns: 'undefined' });
    const fwd = await j.say('forward HOU111 to Sher Trucking');
    const conf = await j.say('yes');
    const both = A(fwd) + ' | ' + A(conf);
    ck('a sender that returns undefined still counts as sent',
       /forwarded to Sher Trucking/i.test(both), both);
    ck('  and the booking is recorded',
       (function () {
           const b = JSON.parse(require('fs').readFileSync(j.dir + '/bookings.json', 'utf8'));
           return b.HOU111.containers[0].stage === 'forwarded';
       })(), 'only an EXPLICIT false means it did not go');
    await j.stop();
}

// ══════════════════════════════════════════════════════════════════════════
section('10 — "send mail" — and why it was not doing that');
// Apsara, 2026-09-07: "When i say send mail, its not doin that."
{
    const j = await boot({});

    const one = await j.say('send a mail to Yurim about the Houston cutoff');
    ck('it drafts rather than shrugging',
       /Send this\?/i.test(A(one)), A(one));
    ck('  showing her the actual body first',
       /confirm the cutoff/i.test(A(one)), A(one));
    ck('  and NOTHING has been sent yet', j.mails.length === 0,
       JSON.stringify(j.mails) + ' — the yes/no gate is the only thing between her and a sent email');

    const two = await j.say('yes');
    ck('her yes sends it', /^Sent to/i.test(A(two)), A(two));
    ck('  to the address it found', j.mails.length === 1 && /yurim@/.test(j.mails[0].to),
       JSON.stringify(j.mails.map((m) => m.to)));
    ck('  with the subject it drafted', /Houston cutoff/i.test(j.mails[0].subject || ''),
       JSON.stringify(j.mails[0].subject));

    await j.stop();
}

// ══════════════════════════════════════════════════════════════════════════
section('11 — and when the writer fails, it says whose fault it is');
{
    // THE ACTUAL BUG. callGeminiJSON returns null for every failure — no key,
    // quota gone, network down, unparseable answer — and all four came out as
    // "try rephrasing what it should say". That blames her wording for an
    // outage on this side and hands her the one action that cannot possibly
    // work. She would rephrase, and rephrase, and it would never once send.
    const cases = [
        ['composer-auth', /key is missing or rejected/i, 'a missing key is not her wording'],
        ['composer-quota', /quota is used up/i, 'a spent quota is not her wording'],
        ['composer-down', /couldn.t reach the AI/i, 'an unreachable model is not her wording'],
    ];
    for (const [mode, want, why] of cases) {
        const j = await boot({ gemini: mode });
        const r = await j.say('send a mail to Yurim about the Houston cutoff');
        ck(`${mode}: says what actually went wrong`, want.test(A(r)), A(r) + ' — ' + why);
        ck(`  ${mode}: and does NOT tell her to rephrase`,
           !/rephrasing/i.test(A(r)), A(r));
        ck(`  ${mode}: nothing was sent`, j.mails.length === 0, JSON.stringify(j.mails));
        await j.stop();
    }

    // The ONE case where rephrasing is sensible advice: the model answered,
    // with something that was not a usable draft.
    const j = await boot({ gemini: 'composer-junk' });
    const r = await j.say('send a mail to Yurim about the Houston cutoff');
    ck('an unusable answer DOES ask her what it should say',
       /tell me what it should say/i.test(A(r)), A(r));
    ck('  which is the only case that should', !/key is missing|quota|reach the AI/i.test(A(r)), A(r));
    await j.stop();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\n  HARNESS FAILED:', e && e.stack); process.exit(1); });
