// ── tests/draft-intent.js ─────────────────────────────────────────────────
// Apsara, 2026-09-07: "As per my command, it has to work dynamically."
//
// WHAT WAS WRONG
// --------------
// Park and resume were two regexes. They covered hold/park/pause/shelve/stash
// and back-to/resume/carry-on-with/finish/pick-up, and nothing else. Every
// other way of saying the same thing — "leave the invoice, Yurim needs an
// answer", "one sec, Daekwang is calling" — fell through and was absorbed as
// an ANSWER to whatever question was outstanding. That is not a missing
// feature, it is the sentence disappearing.
//
// WHAT THIS FILE ACTUALLY RUNS
// ----------------------------
// The classifier, with Gemini stubbed. Not a source grep — the previous file
// in this area had three assertions matching names that no longer existed and
// passing against -1. Every check below executes classify() and looks at what
// came back, and the stub RECORDS whether it was called, because "did not ask
// the model" is half of what is being guarded.
//
// THE TWO DANGERS, AND THEY PULL IN OPPOSITE DIRECTIONS:
//   · too timid — the word list all over again, and her sentence vanishes
//   · too eager — "hold on, 8450" read as a park, and the draft she was
//     answering is put down mid-answer
// Section D is the second one, and it is the section that matters.

const path = require('path');
const fs = require('fs');
const os = require('os');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-intent-'));

// ── THE STUB ─────────────────────────────────────────────────────────────
// Records every call so a test can assert the model was NOT consulted, which
// is how the gate and the fast path are checked. `reply` is what the next
// call returns; setting it to a function lets a test throw or hang.
const gem = { calls: [], reply: null };
const gemP = require.resolve(path.join(ROOT, 'helpers/gemini.js'));
require.cache[gemP] = {
    id: gemP, filename: gemP, loaded: true,
    exports: {
        callGeminiJSON: async (prompt) => {
            gem.calls.push(prompt);
            if (typeof gem.reply === 'function') return gem.reply(prompt);
            return gem.reply;
        },
    },
};

// proformaPricing hits the disk and the sheet; the draft does not need it here.
const ppP = require.resolve(path.join(ROOT, 'helpers/proformaPricing.js'));
require.cache[ppP] = { id: ppP, filename: ppP, loaded: true, exports: { lookup: () => ({}) } };

const di = require(path.join(ROOT, 'helpers/draftIntent.js'));
const d = require(path.join(ROOT, 'helpers/proformaDraft.js'));

const OPEN = { open: true, parked: false, staged: false, summary: '21 MT of Auto cast for Daekwang', question: 'What rate per metric ton?' };
const HELD = { open: false, parked: true, staged: false, summary: '21 MT of Auto cast for Daekwang', question: null };
// The confirm window: the document is finished and she has been asked to send
// it. This is the ONLY state where "amend" is on the table.
const STAGED = { open: true, parked: false, staged: true, summary: '21 MT of Auto cast for Daekwang, CIF Long Beach', question: null };
const reset = (reply) => { gem.calls = []; gem.reply = reply; };

(async () => {

console.log('\n─ park and resume, decided dynamically ──────────────────────');

section('A — the gate: nothing in flight costs nothing');
{
    // THE COST ARGUMENT, MEASURED. If this fires the model on every utterance
    // the whole assistant gets slower, and — worse — the classifier gets an
    // opinion about sentences that belong to the trucker confirmation.
    reset({ label: 'park' });
    const none = await di.classify('yes, Sher Trucking', { open: false, parked: false });
    ck('no draft open and none parked → none', none === 'none', String(none));
    ck('  and the model was never asked', gem.calls.length === 0,
       gem.calls.length + ' calls — a model call here is latency on every sentence she speaks '
       + 'AND a chance to misread a trucker confirmation');

    reset({ label: 'park' });
    ck('an empty utterance is none', await di.classify('   ', OPEN) === 'none');
    ck('  without asking', gem.calls.length === 0);
}

section('B — the fast path: a phrase the patterns already know');
{
    // Identical output to the model, no round trip. Asserted as "did not
    // call", because a version that asked anyway would still return 'park'
    // and every other assertion in this file would stay green.
    reset({ label: 'none' });
    ck('"lets hold this and work on email" → park',
       await di.classify('lets hold this and work on email', OPEN) === 'park');
    ck('  without a round trip in the middle of her talking', gem.calls.length === 0,
       gem.calls.length + ' calls');

    reset({ label: 'none' });
    ck('"back to the proforma" → resume',
       await di.classify('back to the proforma', HELD) === 'resume');
    ck('  also with no round trip', gem.calls.length === 0);
    ck('  and "where were we" too',
       await di.classify('where were we', HELD) === 'resume');
}

section('C — THE POINT: phrasings no word list has');
{
    // Each of these fails PARK/RESUME outright. Verified here rather than
    // asserted, so if a future regex happens to cover one the test says so
    // instead of quietly checking nothing.
    const missed = [
        'leave the invoice a minute, Yurim needs an answer',
        'one sec, Daekwang is on the phone',
        'forget the PI for now, I need to check that Houston cutoff',
    ];
    for (const m of missed) {
        ck(`the old regex genuinely misses "${m.slice(0, 28)}..."`, !di.PARK.test(m),
           'this phrasing is now covered by a pattern — pick a different one or the '
           + 'assertion below proves nothing about the model');
    }

    for (const m of missed) {
        reset({ label: 'park', why: 'setting it down' });
        const got = await di.classify(m, OPEN);
        ck(`  and the model catches it: "${m.slice(0, 28)}..."`, got === 'park', String(got));
    }
    ck('  the model was actually consulted for those', gem.calls.length === 1);

    reset({ label: 'resume', why: 'coming back' });
    ck('"right, lets get on with Daekwang" → resume',
       await di.classify('right, lets get on with Daekwang', HELD) === 'resume');
}

section('D — and it does NOT eat her answers');
{
    // The eager direction, and the one that costs her work. The model is told
    // these are "none"; what is guarded HERE is that a 'park' label is
    // refused outright when the state cannot support it — the state is a
    // fact, the label is an opinion.
    reset({ label: 'park', why: 'she said hold' });
    ck('a park label with NOTHING open is refused',
       await di.classify('hold on, 8450', HELD) === 'none',
       'nothing is open, so there is nothing to park — however sure the model sounds');

    reset({ label: 'resume', why: 'sounds like coming back' });
    ck('  a resume label with nothing parked is refused',
       await di.classify('carry on', OPEN) === 'none',
       'resuming a draft that is already open would swap it for undefined');

    // Garbage from the model is 'none', not a crash and not a coin flip.
    for (const bad of [{ label: 'PARK_IT' }, { label: '' }, {}, null, 'not json']) {
        reset(bad);
        ck('  an unrecognised label falls back to none: ' + JSON.stringify(bad),
           await di.classify('do something', OPEN) === 'none');
    }
}

section('D2 — "no no jarvis, trade terms should be CIF Busan"');
{
    // Apsara, 2026-09-07: "just like jarvis in iron man." MEASURED FIRST:
    // five of these ten were silently swallowed mid-confirm — handle()
    // returned null and the un-amended document stayed confirmable.
    const corrections = [
        'no no jarvis, trade terms should be CIF Busan',
        'no jarvis trade terms is CIF Busan',
        'nope, CIF Busan',
        'trade terms CIF Busan',
        'payment terms 30 days from BL date',
        'no no the rate is 8500',
        'consignee is Hyundai Steel not Daekwang',
    ];
    for (const c of corrections) {
        reset({ label: 'amend', why: 'a field and a value' });
        ck(`"${c.slice(0, 34)}" → amend`, await di.classify(c, STAGED) === 'amend');
    }

    // AND THE STATE STILL OVERRIDES. Amending a draft that is not staged is
    // the answer path's job; two routes competing for one sentence means only
    // one of them can be right and neither knows which.
    reset({ label: 'amend', why: 'looks like a change' });
    ck('an amend label mid-questioning is refused',
       await di.classify('trade terms CIF Busan', OPEN) === 'none',
       'the draft absorbs its own answers while it is still asking');
    reset({ label: 'amend' });
    ck('  and with nothing open at all', await di.classify('trade terms CIF Busan', HELD) === 'none');

    // THE PROMPT HAS TO SAY WHICH WINDOW SHE IS IN, or the model cannot tell
    // a correction from an answer — they are the same words.
    reset({ label: 'none' });
    await di.classify('mm', STAGED);
    const ps = gem.calls[0] || '';
    ck('the staged prompt says the document is finished',
       /SHE HAS BEEN ASKED TO CONFIRM IT/.test(ps), ps.slice(-500));
    ck('  and offers amend', /Choose "park", "amend" or "none"/.test(ps));
    ck('  and lists what is NOT an amendment',
       /forward that to Sher Trucking/.test(ps) && /send it to Daekwang/.test(ps),
       'these parse as a consignee and would rewrite the buyer on an invoice');
    ck('  with the test she can apply herself',
       /could you name the FIELD and the NEW VALUE/.test(ps));

    reset({ label: 'none' });
    await di.classify('mm', OPEN);
    ck('the mid-questioning prompt does NOT offer amend',
       /"amend" is not/.test(gem.calls[0] || ''), (gem.calls[0] || '').slice(-300));
}

section('E — the offline net still holds');
{
    // Gemini is genuinely unreachable for her sometimes. Degrading to today's
    // behaviour is fine; degrading to silence is not.
    reset(() => { throw new Error('ECONNREFUSED'); });
    ck('the model throwing does not throw at her',
       await di.classify('something unusual', OPEN) === 'none');
    ck('  and the known phrase still works with the model down',
       await di.classify('lets hold this and work on email', OPEN) === 'park',
       'the patterns are the fast path, so an unreachable model cannot break them');

    // The timeout. She is standing there talking; a slow model must not hold
    // the turn open. Uses the real PARK_TIMEOUT_MS so shortening it in the
    // helper does not silently make this test meaningless.
    reset(() => new Promise((r) => setTimeout(() => r({ label: 'park' }), di.PARK_TIMEOUT_MS + 1500)));
    const t0 = Date.now();
    const slow = await di.classify('something the patterns do not know', OPEN);
    const took = Date.now() - t0;
    ck('a slow model is abandoned, not waited on', slow === 'none', String(slow));
    ck('  within the stated timeout', took < di.PARK_TIMEOUT_MS + 600,
       took + 'ms against a ' + di.PARK_TIMEOUT_MS + 'ms budget');
}

section('F — the prompt carries what the decision needs');
{
    // Without the outstanding question the model cannot tell "hold on, 8450"
    // from "hold this, I need to email Yurim". Both open with a filler.
    reset({ label: 'none' });
    await di.classify('mm something', OPEN);
    const p = gem.calls[0] || '';
    ck('the open draft is described', /21 MT of Auto cast for Daekwang/.test(p));
    ck('  and the question she was just asked',
       /THE QUESTION SHE WAS JUST ASKED: What rate per metric ton\?/.test(p), p.slice(-400));
    ck('  with resume ruled out while one is open',
       /neither is "resume"/.test(p), p.slice(-400));
    ck('  and the three anti-cases spelled out',
       /AN ANSWER to the outstanding question/.test(p)
       && /A CORRECTION — that is "amend", never "park"/.test(p)
       && /A CANCELLATION\./.test(p));
    ck('  and the tie-break written down',
       /WHEN IN DOUBT, ANSWER "none"/.test(p),
       'a classifier with no stated bias will pick whichever it likes today');

    reset({ label: 'none' });
    await di.classify('mm something', HELD);
    const p2 = gem.calls[0] || '';
    ck('the parked draft is described too', /PARKED: 21 MT of Auto cast/.test(p2), p2.slice(-300));
    ck('  with park ruled out', /"park" is not available/.test(p2));
}

section('G — end to end through the draft itself');
{
    // The classifier deciding 'park' has to actually PUT THE DRAFT DOWN, and
    // the state it hands the classifier has to be real. Grosz & Sidner's pop:
    // after this, the focus space is closed and contributes nothing.
    d.clear(); d._clearParked();
    d.start('create a proforma for Daekwang, 2 containers, 21 MT of auto cast at 8450, CIF Busan');

    const st = d.transitionState();
    ck('transitionState reports the open draft', st.open === true && st.parked === false);
    ck('  with a summary the model can use', /Daekwang/.test(st.summary), String(st.summary));

    // A phrasing the patterns miss, with the model saying park.
    reset({ label: 'park', why: 'turning to email' });
    const t = await di.classify('leave the invoice a minute, Yurim needs an answer', d.transitionState());
    ck('  the dynamic decision is park', t === 'park', String(t));

    const step = d.handle('leave the invoice a minute, Yurim needs an answer', { transition: t });
    ck('  and handle() acts on it', !!step && step.stage === 'parked', JSON.stringify(step));
    ck('    saying what it is holding', /Daekwang/.test(step.say), step && step.say);
    ck('    and how to get it back', /back to the proforma/i.test(step.say));

    // THE POP. Parked means the email that follows inherits nothing.
    ck('  the draft is no longer live', d.contextLine() === null,
       'a parked proforma leaking into the next email is the thing she explicitly ruled out');
    ck('    but it is still held', !!d.parkedDraft());

    const st2 = d.transitionState();
    ck('  and the state now offers resume', st2.open === false && st2.parked === true);
    ck('    still describing it, from the line stored at park time',
       /Daekwang/.test(st2.summary), String(st2.summary));

    reset({ label: 'resume', why: 'coming back' });
    const t2 = await di.classify('right, lets get on with Daekwang', d.transitionState());
    const back = d.handle('right, lets get on with Daekwang', { transition: t2 });
    ck('  and a dynamic resume brings it back whole',
       !!back && back.resumed === true && /Daekwang/.test(back.say), JSON.stringify(back));
    ck('    with the fields she already gave', d.openContainerCount() === 2,
       'a resume that lost the container count would make her say it all again');
}

section('G2 — an amendment lands, and SAYS WHAT IT CHANGED');
{
    // The guard that replaces the cue list. With a model deciding what counts
    // as a correction, a mis-parse has to be audible — otherwise a field on a
    // financial document is rewritten and she confirms it without knowing.
    const base = 'create a proforma for Daekwang, 2 containers, 21 MT of auto cast at 8450, CIF Long Beach';
    const amend = (say) => {
        d.clear(); d._clearParked();
        d.start(base); d.markStaged();
        return d.handle(say, { transition: 'amend' });
    };

    const r = amend('no no jarvis, trade terms should be CIF Busan');
    ck('the correction lands', !!r && r.stage === 'preview', JSON.stringify(r && r.stage));
    ck('  and names what moved', /^Changed the discharge port to BUSAN — /.test(r.say), r && r.say);
    ck('  in her words, not the field key',
       !/shipment_terms|port_discharge/.test(r.say), r && r.say);

    const rate = amend('no no the rate is 8500');
    ck('a rate change is named with the money format',
       /^Changed the rate to \$8,500\.00 — /.test(rate.say), rate && rate.say);

    // ── TWO PRE-EXISTING BUGS THIS EXPOSED ON DAY ONE ────────────────────
    // Both were invisible while the sentence was being swallowed, and both
    // put wrong text on an invoice.
    const who = amend('consignee is Hyundai Steel not Daekwang');
    ck('"X not Y" does not put the correction in the company name',
       who.fields.consignee === 'Hyundai Steel', String(who.fields.consignee)
       + ' — "Hyundai Steel not Daekwang" would have been printed at the top of the invoice');

    const buyer = amend('buyer is Hyundai Steel');
    ck('"buyer" is a word for consignee', buyer.fields.consignee === 'Hyundai Steel',
       String(buyer.fields.consignee));
    ck('  and the goods are NOT silently renamed to Steel',
       buyer.fields.material === 'Auto cast', String(buyer.fields.material)
       + ' — with no consignee match the span was never blanked, so the material parser took "Steel"');

    const instead = amend('consignee should be POSCO instead of Daekwang');
    ck('"instead of Y" does not become the material',
       instead.fields.consignee === 'POSCO' && instead.fields.material === 'Auto cast',
       JSON.stringify({ c: instead.fields.consignee, m: instead.fields.material }));
    const keep = amend('make it POSCO instead of Daekwang, and 3 containers');
    ck('  and blanking the old value keeps the rest of her sentence',
       keep.fields.containers === 3, String(keep.fields.containers));

    // NOTHING MOVED IS SAID TOO. Implying a change that did not happen is how
    // she confirms a document believing it was corrected.
    const same = amend('trade terms CIF Long Beach');
    ck('a correction that changes nothing says so',
       !same || /reads the same as what I had/.test(same.say),
       same && same.say);
}

section('H — nothing else changed');
{
    // handle() with NO transition must behave exactly as before, because
    // every other caller and every other test passes no options. A change
    // that only worked when the classifier ran would be a change that broke
    // the email path and the tests that cover it.
    d.clear(); d._clearParked();
    d.start('create a proforma for Daekwang, 21 MT of auto cast at 8450');
    const legacy = d.handle('lets hold this and work on email');
    ck('the pattern path still parks with no transition passed',
       !!legacy && legacy.stage === 'parked', JSON.stringify(legacy));
    ck('  and resumes', !!d.handle('back to the proforma'));

    // And the amendment lock is untouched — stated here because it is the
    // deliberate exception to "make it dynamic", and a future reader should
    // find the reason next to the tests rather than only in a commit message.
    const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    ck('the amendment exception is still deterministic',
       /brainPending\.type === 'confirm_proforma'\s*\n?\s*&& pro\.isStaged\(\)/.test(api),
       'a trucker confirm is confirm_forward and never reaches this branch — THAT is '
       + 'the lock, and it is the one that must not move');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})();
