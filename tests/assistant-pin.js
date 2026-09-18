// ── tests/assistant-pin.js ──────────────────────────────────────────────────
// Apsara, 2026-09-19, in three messages:
//   "Basically in chat bot,there should be a option to ask whom to
//    enable-->jarvis/scout"
//   "if jarvis-restrict it to edge metals"
//   "if scout -edge yard"
//
// The router has always guessed from the words, and it guesses well — but the
// two assistants cover two DIFFERENT COMPANIES, and a guess is not a guarantee.
// When she is working through the metals ledger for an hour she should be able
// to say so once.
//
// ── WHAT IS ACTUALLY BEING TESTED ───────────────────────────────────────────
// Not "is there a button". The three ways a pin goes wrong:
//
//   it looks set and the question still goes to the other one — the control
//     is decoration and she trusts it;
//   it overrides her saying a name out loud, which is more specific than a
//     setting she flipped an hour ago;
//   it changes what happens for someone who never touched it.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const VOICE = fs.readFileSync(path.join(ROOT, 'dashboard/voice.js'), 'utf8');

// ── A. THE CONTROL ──────────────────────────────────────────────────────────
section('A. the option exists, and says what it means');
{
    ck('there is a who-answers button', /id="jvWho"/.test(VOICE));
    ck('  with three states, not two',
       /'auto', 'jarvis', 'scout'/.test(VOICE),
       'Auto has to survive — the router failing in the cheap direction is right for someone who has not chosen');
    ck('  defaulting to Auto', /var pinnedAgent = 'auto';/.test(VOICE),
       'a default of one company would silently narrow every question she asks');

    // ── IT NAMES THE COMPANY, NOT JUST THE ASSISTANT ────────────────────
    // "Jarvis" and "Scout" mean nothing about scope until you know which
    // books each one keeps. Her three messages were about the COMPANIES.
    ck('Jarvis is labelled Edge Metals', /Jarvis · Metals/.test(VOICE) && /Edge Metals/.test(VOICE));
    ck('Scout is labelled Edge Yard', /Scout · Yard/.test(VOICE) && /Edge Yard/.test(VOICE));
    ck('  and the two are never described as one thing',
       !/Edge Metals and Edge Yard|Edge Yard and Edge Metals/.test(VOICE),
       'they are different companies, which is most of what this app is for');

    ck('the choice is remembered', /localStorage\.setItem\('jvPin'/.test(VOICE),
       'the whole point is not having to say it again');
    ck('  and read defensively',
       /try \{ pinnedAgent = localStorage\.getItem\('jvPin'\)/.test(VOICE),
       'a private window with no localStorage must not stop the assistant working');
    ck('  with anything unrecognised falling back to Auto',
       /if \(\['auto', 'jarvis', 'scout'\]\.indexOf\(pinnedAgent\) < 0\) pinnedAgent = 'auto';/.test(VOICE),
       'a stale or hand-edited value would otherwise pin her to nothing');
    ck('  and the change is confirmed on screen',
       /Jarvis only, from now on/.test(VOICE) && /Scout only, from now on/.test(VOICE),
       'a silent change to WHICH COMPANY she is asking about is the one worth saying out loud');
}

// ── B. IT REACHES THE SERVER ────────────────────────────────────────────────
// A pin the request does not carry is a pin that does nothing.
section('B. the pin is what gets sent');
{
    const ask = VOICE.slice(VOICE.indexOf('var askAgent ='), VOICE.indexOf('var askAgent =') + 400);
    ck('the request sends the pinned agent', /agent: askAgent/.test(ask), ask.slice(0, 120));
    ck('  Auto sends exactly what it always sent',
       /pinnedAgent === 'auto' \|\| spokenName\) \? addressed : pinnedAgent/.test(ask),
       'anyone who never touches the control must see no change at all');

    // ── AND SAYING A NAME STILL WINS ────────────────────────────────────
    // A name spoken out loud is more specific than a setting flipped an hour
    // ago. `addressed` holds the LAST wake word and survives between
    // questions, so it cannot answer "did she name one just now" — hence the
    // separate flag.
    ck('a name spoken THIS turn overrides the pin', /spokenName/.test(ask));
    ck('  set where the wake word is actually heard',
       /spokenName = true;/.test(VOICE) && VOICE.indexOf('spokenName = true;') > VOICE.indexOf('WAKE_SCOUT.test(txt)'),
       'set anywhere else and it would not mean "she named one"');
    ck('  and cleared once that question has gone',
       /spokenName = false;   \/\/ it belonged to THIS question only/.test(VOICE),
       'left set, one "hey scout" would defeat the pin for the rest of the session');
}

// ── C. THE SERVER HONOURS IT ────────────────────────────────────────────────
section('C. /api/voice/ask takes the instruction');
{
    const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    const route = api.slice(api.indexOf("app.post('/api/voice/ask'"), api.indexOf("app.post('/api/voice/ask'") + 3000);
    ck('the route reads an explicit agent', /req\.body \|\| \{\}\)\.agent/.test(route));
    ck('  and honours only the two real names',
       /named === 'scout' \|\| named === 'jarvis'/.test(route),
       'an unknown name must fall through to the router, not select nothing');

    // ── ONE THING THE PIN MUST NOT OVERRIDE ─────────────────────────────
    // When Jarvis has a question open, the answer belongs to Jarvis whatever
    // is pinned — otherwise "yes" lands on Scout and the confirmation Jarvis
    // is holding never resolves.
    ck('an open question from Jarvis still wins over everything',
       route.indexOf('answeringBrain') < route.indexOf("named === 'scout'"),
       'a pinned Scout would swallow the "yes" that Jarvis is waiting for');
}

// ── D. THE BOUNDARY IS REAL, NOT JUST A LABEL ───────────────────────────────
// Pinning Jarvis is only meaningful if Jarvis actually owns the metals ledger
// and Scout actually does not.
section('D. Jarvis has metals, Scout has the yard');
{
    const scout = fs.readFileSync(path.join(ROOT, 'helpers/tools.js'), 'utf8');
    const brain = fs.readFileSync(path.join(ROOT, 'workflow/brain.js'), 'utf8');
    ck('Jarvis can answer about purchase bills', /case 'bills_query'/.test(brain));
    ck('Scout cannot', !/bills_query|find_bills/.test(scout),
       'the label would be a promise the code does not keep');
    ck('  and Scout still owns the yard', /find_loads/.test(scout) && /inventory/.test(scout));
    ck('  while Jarvis does not reach into the yard ledger',
       !/require\('\.\.\/helpers\/loads'\)/.test(brain),
       'two assistants able to answer the same question differently is the thing the split prevents');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
