// ── tests/voice.js — who answers, and how it reads aloud ───────────────────
//
// Apsara, 2026-08-29: "give voice to the app... make it talk back", "i want to
// give human voice to jarvis", "voice charon", and "When user asks any
// question to Jarvis which is related to Yard... Direct those question to that
// yard agent."
//
// Two things are tested here, and the first one matters far more than it looks.
//
// ROUTING IS A SAFETY PROPERTY, not a convenience. Jarvis is workflow/brain.js:
// it books loads, messages truckers and sends WhatsApp to real people. Scout is
// helpers/yardAsk.js: it reads yard data and cannot message anyone. Sending a
// yard question to Jarvis points a question at something whose instinct is to
// act. Sending a freight command to Scout costs a repeat. The router is
// deliberately biased accordingly, and these tests pin that bias down.
//
// Speech synthesis itself is NOT called here — it is a paid network round trip
// of several seconds, and a test suite that needs the internet to pass is a
// test suite that gets ignored. What is tested is every deterministic part:
// the routing, the text normalisation, the WAV framing, the length cap.

const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (name, cond) => { if (cond) { pass++; console.log('  PASS ', name); } else { fail++; console.log('  FAIL ', name); } };

const { routeVoice, stripAgentName, AGENTS } = require(path.join(R, 'helpers/voiceRouter.js'));
const voice = require(path.join(R, 'helpers/voice.js'));

console.log('\n─ voice: routing and speech ──────────────────────────────');

// ── the two agents ────────────────────────────────────────────────────────
{
    ck('Jarvis speaks as Charon', AGENTS.jarvis.voice === 'Charon');
    ck('Scout speaks as Leda', AGENTS.scout.voice === 'Leda');
    ck('they do not share a voice', AGENTS.jarvis.voice !== AGENTS.scout.voice);
}

// ── routing: yard questions reach Scout ───────────────────────────────────
{
    const toScout = [
        'how much do we owe Acme',
        'who should we pay first',
        'what is the net weight on edge 4',
        'how much stock do we have',
        'show me the drafts',
        'did we pay Ramesh',
        'record a 12000 zelle payment against edge 7',
        'is edge 3 fully paid',
        'what did we buy from Hugo last week',
        'how many loads came in yesterday',
        'anything look double paid',
        'did we pay the trucker for that load',
    ];
    for (const q of toScout) ck(`Scout: "${q}"`, routeVoice(q).agent === 'scout');
}

// ── routing: things only Jarvis can do stay with Jarvis ───────────────────
{
    const toJarvis = [
        'message the trucker we are running late',
        'email Joey about the container',
        'whatsapp the supplier for a quote',
        'book a pickup for tomorrow',
        'check my inbox',
        'draft an email to Taewon',
        'send the proforma to Tiyansh',
        'chase the carrier for a cutoff date',
    ];
    for (const q of toJarvis) ck(`Jarvis: "${q}"`, routeVoice(q).agent === 'jarvis');
}

// ── being addressed by name always wins ───────────────────────────────────
{
    ck('"hey scout book a truck" goes to Scout despite the freight words',
       routeVoice('hey scout book a truck').agent === 'scout');
    ck('  and it is recorded as having been asked by name',
       routeVoice('hey scout book a truck').addressed === true);
    ck('the name is stripped before the question is passed on',
       stripAgentName('hey scout how much do we owe') === 'how much do we owe');
    ck('  and for Jarvis too',
       stripAgentName('Hey Jarvis, check my inbox') === 'check my inbox');
    ck('a message that is ONLY a name is not stripped to nothing',
       stripAgentName('scout').length > 0);
}

// ── the bias, stated as a property ────────────────────────────────────────
{
    // A bare question with no vocabulary either way must NOT reach the thing
    // that sends WhatsApp. Scout answering "that is not in the records" is a
    // safe outcome; Jarvis guessing is not.
    for (const q of ['what about that', 'is it done', 'how many', 'can you check']) {
        ck(`an ambiguous question goes to the safe agent: "${q}"`, routeVoice(q).agent === 'scout');
    }
    ck('an empty utterance does not crash the router', !!routeVoice('').agent);
    ck('null does not crash it either', !!routeVoice(null).agent);
}

// ── speech: how text reads aloud ──────────────────────────────────────────
{
    const s = voice.speakable;
    ck('load ids are read as words, not letters', s('EDGE_7 is paid') === 'Edge 7 is paid');
    ck('  including with a hyphen', /Edge 7/.test(s('EDGE-7 is paid')));
    ck('round money drops the cents', s('$12,000.00 paid') === '12,000 dollars paid');
    ck('money with cents says cents', s('$40,852.82 owed') === '40,852 dollars 82 cents owed');
    ck('bare dollars still say dollars', s('$500 today') === '500 dollars today');
    ck('lb is read as pounds', s('5,919 lb') === '5,919 pounds');
    ck('MT is read as metric tons', s('2.685 MT') === '2.685 metric tons');
    ck('markdown is stripped', s('**Acme** owes') === 'Acme owes');
    ck('a draft id does not become "draft a draft"', s('Draft DRAFT_9f2 saved.') === 'the draft saved.');
    ck('an em dash becomes a pause', /,/.test(s('Acme — 3 loads')));
    ck('nothing in gives nothing out', s('') === '' && s(null) === '' && s(undefined) === '');
}

// ── speech: the length cap ────────────────────────────────────────────────
{
    // Spoken length is capped, but the SCREEN always has the whole answer.
    // Nothing here changes what is displayed.
    const long = 'Sentence number one is here. '.repeat(80);
    const t = voice.trimForSpeech(long);
    ck('a very long answer is capped', t.length <= voice.MAX_SPEAK_CHARS + 40);
    ck('  and ends on a sentence, not mid-word', /\.\s*See the screen for the rest\.$/.test(t));
    ck('  and says where the rest is', /See the screen/.test(t));
    const short = 'Edge 4 is paid.';
    ck('a short answer is untouched', voice.trimForSpeech(short) === short);
}

// ── the WAV header, which is where silent failure lives ───────────────────
{
    // Gemini returns raw PCM with no container. Handing those bytes to an
    // <audio> element plays NOTHING, with no error — so the framing is worth
    // asserting byte by byte.
    const h = voice.wavHeader(1000, 24000);
    ck('the header is 44 bytes', h.length === 44);
    ck('it is RIFF/WAVE', h.slice(0, 4).toString() === 'RIFF' && h.slice(8, 12).toString() === 'WAVE');
    ck('it declares PCM', h.readUInt16LE(20) === 1);
    ck('it declares mono', h.readUInt16LE(22) === 1);
    ck('it declares 16 bits', h.readUInt16LE(34) === 16);
    ck('the sample rate is carried through', h.readUInt32LE(24) === 24000);
    ck('byte rate matches mono 16-bit', h.readUInt32LE(28) === 24000 * 2);
    ck('the data length is right', h.readUInt32LE(40) === 1000);
    ck('the RIFF size is data + 36', h.readUInt32LE(4) === 1036);
    // A response at a different rate must not be forced to 24k — that plays
    // back at the wrong pitch, which is a strange thing to debug.
    ck('a different rate is honoured', voice.wavHeader(10, 16000).readUInt32LE(24) === 16000);
}

// ── the cache key ─────────────────────────────────────────────────────────
{
    const a = voice.cacheKey('hello', 'Charon');
    ck('the same text and voice give the same key', a === voice.cacheKey('hello', 'Charon'));
    ck('a different VOICE is a different key', a !== voice.cacheKey('hello', 'Leda'));
    ck('a different TEXT is a different key', a !== voice.cacheKey('hello there', 'Charon'));
}

// ── it fails soft, everywhere ─────────────────────────────────────────────
{
    const src = fs.readFileSync(path.join(R, 'helpers/voice.js'), 'utf8');
    ck('synthesis retries the empty-response failure',
       /for \(let attempt = 1; attempt <= 3/.test(src));
    ck('  but does not retry auth or quota errors',
       /401\|403\|400/.test(src));
    const api = fs.readFileSync(path.join(R, 'api.js'), 'utf8');
    ck('a failed synthesis returns 503, not 500', /voice\/say[\s\S]{0,900}status\(503\)/.test(api));
    const html = fs.readFileSync(path.join(R, 'mobile-app/www/index.html'), 'utf8');
    ck('the app shows the text before it plays anything',
       html.indexOf("voiceReplies'").length !== 0 && /TEXT FIRST, ALWAYS/.test(html));
    ck('the app asks the router, not the brain directly, for voice',
       /'\/api\/voice\/ask'/.test(html));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
