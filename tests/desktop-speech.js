// ── tests/desktop-speech.js ───────────────────────────────────────────────
// Apsara: "i want voice in desktop app."
//
// WHY THIS FILE EXISTS, SPECIFICALLY
// ----------------------------------
// The first version of desktop/speech.js turned Whisper's output into a
// sentence with one line, written from the package's TypeScript typings:
//
//     return (result || []).map((s) => s.text).join(' ').trim();
//
// It threw on her Mac, on the first thing she ever said to it:
//
//     [VOICE] local engine error: (result || []).map is not a function
//
// smart-whisper's .d.ts declares `task.result` as Promise<TranscribeResult[]>.
// Its native addon returns something else. The .d.ts is a hand-written
// description of a C++ binding, not a checked contract, and I believed it.
//
// The whole transcription path needs a Mac, a microphone, a Metal GPU and a
// 77MB model — none of which exist here, which is exactly why that bug
// reached her instead of me. But the part that BROKE is pure: it takes a
// value and returns a string. So that part is extracted and tested here, on
// every shape the addon might plausibly return, and it can never again be the
// thing that fails in front of her.
//
// The general lesson, worth more than this file: when a native module's types
// and its runtime disagree, the types lose. Parse defensively at that boundary.

const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

// speech.js requires smart-whisper LAZILY, inside load(). That is what makes
// this file runnable on a machine with no native build — and it is worth
// asserting, because moving that require to the top of the file would break
// this suite everywhere except a Mac.
const SRC = require('fs').readFileSync(path.join(__dirname, '../desktop/speech.js'), 'utf8');

const speech = require('../desktop/speech');

// `sentence` is internal. Rather than export it purely for the test — which
// widens the module's surface for no runtime reason — it is reached through
// the same require cache the module itself uses.
const sentence = (function extract() {
    const m = require('module');
    const wrapper = m.wrap(SRC + '\n;module.exports.__sentence = sentence;');
    const fn = eval(wrapper);
    const mod = { exports: {} };
    fn(mod.exports, require, mod, path.join(__dirname, '../desktop/speech.js'), path.join(__dirname, '../desktop'));
    return mod.exports.__sentence;
}());

console.log('\n─ Whisper output → a sentence ───────────────────────────────');

section('A — the shape the typings promised');
{
    ck('segments join into one sentence',
       sentence([{ text: 'Hey Jarvis,' }, { text: ' what is in inventory' }])
           === 'Hey Jarvis, what is in inventory');
    ck('an empty array is an empty string, not a crash', sentence([]) === '');
    ck('a segment missing .text does not become "undefined"',
       sentence([{ text: 'hello' }, {}]) === 'hello',
       'joining a missing field produces the literal word undefined, which the wake matcher would then search');
}

section('B — the shapes it actually might return');
{
    // THE FAILURE THIS FILE IS NAMED FOR. Every one of these threw before.
    ck('a bare string', sentence('  what is in inventory  ') === 'what is in inventory');
    ck('one object with .text', sentence({ text: ' hello there ' }) === 'hello there');
    ck('a wrapper with .segments', sentence({ segments: [{ text: 'a' }, { text: 'b' }] }) === 'a b');
    ck('a wrapper with .results', sentence({ results: [{ text: 'a' }, { text: 'b' }] }) === 'a b');
    ck('a wrapper with .result', sentence({ result: [{ text: 'x' }] }) === 'x');
    ck('a wrapper with .transcription', sentence({ transcription: [{ text: 'y' }] }) === 'y');

    // Order matters: a wrapper that ALSO carries a summary .text must be read
    // through its list, not its summary, or long transcripts get truncated to
    // whatever the addon put in that field.
    ck('a list beats a summary .text on the same object',
       sentence({ text: 'trunc', segments: [{ text: 'the' }, { text: 'whole thing' }] }) === 'the whole thing',
       'preferring .text here would silently shorten every long command');
}

section('C — the ones that must not throw, because a mic is behind them');
{
    ck('null', sentence(null) === '');
    ck('undefined', sentence(undefined) === '');
    ck('a number', sentence(42) === '');
    ck('an object it has never seen', sentence({ nope: 1 }) === '');
    ck('nested nonsense', sentence({ segments: [null, { text: 'ok' }, 7] }).includes('ok'));
    // If this throws, the renderer shows "local engine error" and voice dies
    // for the session — which is precisely what happened.
    let threw = false;
    try { sentence({ segments: { not: 'an array' } }); } catch (e) { threw = true; }
    ck('a wrapper whose list is not a list', !threw);
}

section('D — whitespace, because the wake matcher runs on this');
{
    ck('runs of space collapse', sentence([{ text: 'hey' }, { text: '   ' }, { text: 'jarvis' }]) === 'hey jarvis');
    ck('leading and trailing space is gone', sentence([{ text: '  hey  ' }]) === 'hey');
    ck('a whitespace-only result is empty', sentence([{ text: '   ' }]) === '',
       'otherwise voice-local.js forwards a blank transcript and Jarvis answers a question nobody asked');
}

section('E — the module still loads without a Mac');
{
    ck('requiring speech.js does not need the native addon', !!speech && typeof speech.transcribe === 'function',
       'a top-level require of smart-whisper would break this suite on every non-Mac');
    ck('  because smart-whisper is required lazily', /function[\s\S]{0,400}require\('smart-whisper'\)/.test(SRC)
       && !/^const \{ Whisper \}/m.test(SRC));
    ck('status() works before anything is loaded', speech.status().ready === false);
    ck('  and reports where the model should be', /models$/.test(speech.status().dir));
}

(async function transcribePath() {
    section('F — transcribe() actually goes through it');

    // WITHOUT THIS SECTION THE FILE IS DECORATIVE. Proved, not assumed: the
    // first version of this suite tested `sentence` in isolation, and when
    // the original broken one-liner was pasted back into transcribe() as a
    // mutation, ALL 23 TESTS STILL PASSED. A suite that cannot fail on the
    // very bug it was written for is worse than no suite, because it grants
    // confidence it has not earned.
    //
    // So this drives the REAL transcribe(), with smart-whisper's native addon
    // replaced by a fake — it builds on her Mac and nowhere else. Injected
    // into the require cache rather than loaded.
    let live = null;
    let willReturn = null;
    try {
        const nativePath = require.resolve('smart-whisper', { paths: [path.join(__dirname, '../desktop')] });
        class FakeWhisper {
            async transcribe() { return { result: Promise.resolve(willReturn) }; }
        }
        require.cache[nativePath] = {
            id: nativePath, filename: nativePath, loaded: true, exports: { Whisper: FakeWhisper },
        };

        // load() refuses to proceed unless the weights are on disk — correct
        // behaviour, and it means the test needs a file for it to find.
        const os = require('os'), fs = require('fs');
        process.env.JARVIS_WHISPER_MODEL = 'unit-test';
        const dir = path.join(os.homedir(), 'Library', 'Application Support', 'Jarvis', 'models');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'ggml-unit-test.bin'), 'not a real model');

        delete require.cache[require.resolve('../desktop/speech')];
        live = require('../desktop/speech');
    } catch (e) {
        ck('could stub the native addon', false, e.message);
    }

    if (live) {
        const call = async (shape) => { willReturn = shape; return live.transcribe(new Float32Array(16)); };

        ck('array of segments → sentence', await call([{ text: 'hey' }, { text: 'jarvis' }]) === 'hey jarvis');
        // THE ONE THAT MATTERS. This is the value that threw on her Mac. If
        // transcribe() stops routing through sentence(), this line fails.
        ck('a bare string does not throw', await call('hey jarvis') === 'hey jarvis',
           'this exact value produced "(result || []).map is not a function" in front of her');
        ck('a wrapper object does not throw', await call({ segments: [{ text: 'hey jarvis' }] }) === 'hey jarvis');
        ck('an unknown shape yields silence, not an exception', await call({ unexpected: true }) === '',
           'a throw here kills voice for the whole session');
        ck('null does not throw', await call(null) === '');

        ck('and the model is now reported loaded', live.status().ready === true);
    }

    console.log(`\n  ${pass} passed, ${fail} failed`);
    if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
    process.exit(fail ? 1 : 0);
}());
