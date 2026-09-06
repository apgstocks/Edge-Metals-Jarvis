// ── tests/voice-router.js ─────────────────────────────────────────────────
// Apsara, 2026-09-06: "yard ask is a different assistant restricted only to
// yard (restrict it to yard data). Jarvis knows everything."
//
// TWO ASSISTANTS, AND THE ROUTER DECIDES
// --------------------------------------
//   Scout  — helpers/yardAsk.js + helpers/tools.js. Loads, sellers, stock,
//            payments, petty cash, trucker bills. The yard ledger, nothing else.
//   Jarvis — workflow/brain.js. Bookings, containers, ports, cutoffs,
//            vessels, suppliers, truckers, WhatsApp, email.
//
// THE BUG THIS FILE EXISTS FOR
// ----------------------------
// She asked "what bookings do we have from houston" and was told the
// assistant had no idea. Two separate faults, and my first fix addressed
// neither:
//
//   1. dashboard/voice.js called /api/yard/ask directly, bypassing the
//      router — so every spoken question went to Scout regardless.
//   2. `\bbooking\b` does not match "bookingS". The word boundary falls
//      before the s. So even through the router, the freight score was zero
//      and it fell through to "a question is safer with Scout".
//
// My fix had been to add a bookings tool to Scout, which would have
// dissolved the boundary she is asking me to keep — two assistants able to
// give different answers about the same container.
//
// So this file asserts the routing in her own words, plurals and all, and
// asserts that Scout still cannot reach freight data.

const path = require('path');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const { routeVoice, stripAgentName, AGENTS } = require(path.join(ROOT, 'helpers/voiceRouter.js'));
const { TOOLS } = require(path.join(ROOT, 'helpers/tools.js'));

console.log('\n─ which assistant gets the question? ────────────────────────');

section('A — HER QUESTION, and the plurals that broke it');
{
    // The exact sentence. Kept verbatim as the first assertion in the file.
    ck('"what bookings do we have from houston" goes to Jarvis',
       routeVoice('what bookings do we have from houston').agent === 'jarvis',
       'this went to Scout because \\bbooking\\b does not match "bookings"');

    // Every plural that was silently unmatched. Nobody says "what booking do
    // we have from Houston" — the singular-only patterns matched the way the
    // words appear in code, not the way she speaks.
    for (const q of [
        'any bookings from oakland',
        'which containers are unassigned',
        'what ports are we shipping from',
        'what vessels are booked this month',
        'which suppliers have not replied',
        'have the truckers confirmed',
        'what are the cutoffs this week',
        'any deliveries tomorrow',
    ]) {
        ck(`  "${q}" → Jarvis`, routeVoice(q).agent === 'jarvis', routeVoice(q).why);
    }

    // And the singulars must not have broken while fixing the plurals.
    for (const q of ['when is the cutoff for the maersk booking', 'message the trucker about pickup']) {
        ck(`  "${q}" → Jarvis (still)`, routeVoice(q).agent === 'jarvis');
    }
}

section('B — the yard still belongs to Scout');
{
    // The risk of widening the freight patterns is pulling yard questions
    // across. Rule 2 requires freight >= yard, which is what stops it.
    for (const q of [
        'how much do we owe acme',
        'what is in inventory',
        'how many loads this week',
        'what did we pay by zelle',
        'which loads are unpaid',
        'how much copper do we have',
        'what is the petty cash balance',
        'what is the balance on edge_07',
    ]) {
        ck(`"${q}" → Scout`, routeVoice(q).agent === 'scout', routeVoice(q).why);
    }

    // The deliberate ambiguity from the router's own comment: a freight word
    // inside a yard question. The yard signal must win.
    ck('"did we pay the trucker for that load" → Scout',
       routeVoice('did we pay the trucker for that load').agent === 'scout',
       'a yard question wearing a freight word is still a yard question');
    ck('  and "did we pay the truckers for those loads" too',
       routeVoice('did we pay the truckers for those loads').agent === 'scout',
       'the plural fix must not tip this one over');

    // ── THE TIE, WHICH IS THE ACTUAL RULE ────────────────────────────────
    // Rule 2 is `freight >= yard` — a TIE goes to Jarvis. Every case above
    // is lopsided, so a mutation weakening that comparison to `freight >
    // yard * 2` passed the whole file. These two are the boundary itself.
    //
    // "Email the seller" is one freight word against one yard word, and it
    // has to be Jarvis: Scout cannot send anything, so a tie resolved its
    // way is a request that silently cannot be carried out.
    ck('a tie goes to Jarvis — "email the seller"',
       routeVoice('email the seller').agent === 'jarvis',
       routeVoice('email the seller').why + ' — Scout cannot send email, so a tie must not go to it');
    ck('  and "message the supplier about the copper"',
       routeVoice('message the supplier about the copper').agent === 'jarvis',
       routeVoice('message the supplier about the copper').why);
}

section('C — asking for one by name overrides everything');
{
    ck('"Scout, any bookings from houston" → Scout',
       routeVoice('Scout, any bookings from houston').agent === 'scout',
       'being asked by name beats every content rule — she is allowed to be specific');
    ck('  and the name is stripped before the assistant sees it',
       stripAgentName('Scout, any bookings from houston') === 'any bookings from houston');
    ck('  including the wake-word form', stripAgentName('hey jarvis what is in inventory')
       === 'what is in inventory');
    ck('  and stripping never empties the question',
       stripAgentName('jarvis') === 'jarvis',
       'an empty string would send the assistant nothing at all');
}

section('D — THE BOUNDARY SHE ASKED FOR');
{
    // "yard ask is a different assistant restricted only to yard".
    //
    // This is the assertion that would have stopped my wrong fix. I added a
    // find_bookings tool to Scout's registry; it worked, and it was the
    // wrong thing to do — it gave the yard assistant freight knowledge and
    // created two places that could disagree about the same container.
    const names = Object.keys(TOOLS);
    // Split on underscores and match WHOLE words. The first version was a
    // bare substring test and flagged `spend_report` — "port" inside
    // "report" — which is the kind of false alarm that gets a test deleted
    // rather than fixed.
    const FREIGHT_WORDS = /^(booking|bookings|container|containers|vessel|vessels|port|ports|cutoff|cutoffs|supplier|suppliers|email|whatsapp|message)$/i;
    const freighty = names.filter((n) => n.split('_').some((w) => FREIGHT_WORDS.test(w)));
    ck('Scout has no freight tools', freighty.length === 0,
       'found: ' + freighty.join(', ') + ' — freight belongs to Jarvis (workflow/brain.js)');

    // Nor by the back door: a tool whose description advertises freight
    // would teach the model to ask about it.
    const advertises = names.filter((n) => /booking|container|vessel|cutoff/i.test(TOOLS[n].description || ''));
    ck('  and none of its tools advertise freight',
       advertises.length === 0,
       'found: ' + advertises.join(', '));

    // What Scout SHOULD have, so this does not become a test that passes by
    // the registry being empty.
    for (const t of ['find_loads', 'load_detail', 'inventory', 'spend_report', 'petty_cash']) {
        ck(`  but it still has ${t}`, !!TOOLS[t]);
    }
}

section('E — both agents are real, with different voices');
{
    ck('there are exactly two', Object.keys(AGENTS).length === 2);
    ck('  and they do not share a voice', AGENTS.jarvis.voice !== AGENTS.scout.voice,
       'two assistants that sound identical are one assistant that is inconsistent');
    ck('  the router never returns anything else',
       ['a', 'pay acme 500', '???', 'hello', ''].every((q) => AGENTS[routeVoice(q).agent]),
       'an unknown agent name would 500 the endpoint');
}

section('F — and the client asks the ROUTER, not one agent directly');
{
    // The other half of the bug: the voice bar hardcoded /api/yard/ask, so
    // the router above never got a say.
    const voice = require('fs').readFileSync(path.join(ROOT, 'dashboard/voice.js'), 'utf8');
    const code = voice.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ck('the voice bar posts to /api/voice/ask', /api\('\/api\/voice\/ask'/.test(code));
    ck('  and no longer straight to the yard assistant',
       !/api\('\/api\/yard\/ask'/.test(code),
       'calling one agent directly is what sent every spoken question to Scout');
    ck('  sending `text`, which is what the router reads',
       /JSON\.stringify\(\{ text:/.test(code),
       'the endpoint routes on `text`; `question` would arrive empty');
}

section('Z — a port is enough to mean freight');
{
    // Apsara, 2026-09-06: "my user doesnt know about nouns."
    //
    // Widening answerCards.js to understand "what's going out of Houston this
    // week" achieved NOTHING on its own. The router scored that sentence
    // freight=0, sent it to Scout, and Scout is restricted to yard data and
    // has never heard of a booking. The panel I had just taught it to draw
    // was unreachable. Two components agreeing separately is not the same as
    // a working path, and only running the whole thing showed it.
    for (const q of [
        "what's going out of Houston this week",
        'what have we got heading to Busan',
        'anything loading in Oakland',
        'anything from LA',
    ]) {
        ck(`"${q}" → Jarvis`, routeVoice(q).agent === 'jarvis',
           'Scout is yard-only; a booking question landing there gets "not in the records"');
    }

    // AND THE REGRESSION I CAUSED. I first wrote the port as a flat +1, which
    // ties with a single yard word — and `freight >= yard` gives ties to
    // Jarvis, so an ordinary yard question with a port name in it went to the
    // wrong assistant. A weak signal that can outvote a strong one is not a
    // weak signal. It now only counts when the yard score is zero.
    for (const q of [
        'how many loads came in from Houston today',
        'how much copper came in from the Houston load',
        'what did the Houston load weigh',
    ]) {
        ck(`  "${q}" is still Scout's`, routeVoice(q).agent === 'scout',
           'a port beside real yard vocabulary is still a yard question');
    }

    // The vocabulary is answerCards', derived from bookings.json — not a
    // fourth keyword list living here. A port she starts shipping through
    // next month becomes a routing signal with nobody editing anything.
    const src = require('fs').readFileSync(path.join(ROOT, 'helpers/voiceRouter.js'), 'utf8');
    ck('  the port vocabulary is not duplicated here',
       /require\('\.\/answerCards'\)\.portIn/.test(src)
       && !/HOUSTON|SAVANNAH|LOS ANGELES/.test(src.replace(/\/\/.*$/gm, '')),
       'a second copy of the port list is a second thing to keep in step');

    // A router that throws answers nothing at all, so the lookup is guarded.
    ck('  and a failing lookup does not take the router down',
       /catch \(e\)/.test(src.slice(src.indexOf('function namesAPort'), src.indexOf('function routeVoice'))));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
