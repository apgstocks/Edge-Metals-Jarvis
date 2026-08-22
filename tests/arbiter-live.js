// LIVE ARBITER TEST — makes REAL Gemini calls. Run from the repo root:
//   node tests/arbiter-live.js
//
// Why this is separate from tests/trap-audit.js: that audit calls
// policyDecide, which is synchronous and therefore cannot run the arbiter at
// all. It proves the arbiter is WIRED IN. It cannot prove the arbiter is
// RIGHT. Only a real model call can do that, and it cannot be done from a
// sandbox with no API key — so this file exists to be run on the machine
// that actually has one.
//
// Read the accuracy line at the bottom before trusting the feature. What
// matters is not the headline number but WHICH cases fail:
//
//   - An ANSWER case misjudged as NEW_REQUEST is the DANGEROUS failure.
//     It means something she typed (a cargo description, a container
//     number, an email address) gets thrown away and the question is asked
//     again. If any ANSWER case fails, tighten the prompt in
//     helpers/pendingArbiter.js or raise MIN_CONFIDENCE before relying on
//     this in production.
//
//   - A NEW_REQUEST case misjudged as ANSWER or UNCLEAR is the SAFE
//     failure. It just means that message still gets today's behaviour —
//     the nag, or capture-as-answer. No worse than before the arbiter
//     existed. Worth improving, never worth blocking on.
//
// Cases marked EITHER are genuinely ambiguous to a human too and are
// reported but never counted as failures.

const { classifyAgainstPending } = require('../helpers/pendingArbiter');

const CARGO   = '(Still waiting on cargo details for Junk car to Eccomelt — what is the cargo? Description, weight, and value; both weight AND value are required.)';
const TRUCKER = '(Still waiting — who should I ask for LA to Houston?\n1. NTG\n2. TQL\n3. Matthew\n\nReply with names or numbers, comma-separated for more than one, or "cancel".)';
const EMAIL   = "(Still waiting on Jose's email — checked saved contacts and mail, found nothing. I'll draft the email once you give me the address — or reply \"cancel\".)";
const CITY    = '(Still waiting: which city for the price list? 1. Los Angeles, 2. Houston, 3. San Antonio)';
const CONTNO  = '(Still waiting on the container number for DALA23991600.)';

// [question, message, expected]  — expected 'EITHER' = ambiguous, not scored
const CASES = [
    // Her real live failures — these are the whole point of the feature
    [CARGO,   'Do we have any booking available for Houston?',                'NEW_REQUEST'],
    [CARGO,   'check whether we received any mail from zimex recently',       'NEW_REQUEST'],
    [TRUCKER, 'Do we have any booking available for Houston?',                'NEW_REQUEST'],
    [CITY,    'check whether we received any mail from zimex recently',       'NEW_REQUEST'],

    // Other genuine topic changes
    [CARGO,   'who owes me money',                                            'NEW_REQUEST'],
    [CARGO,   'show me urgent bookings',                                      'NEW_REQUEST'],
    [CARGO,   "what's the address for Eccomelt",                              'NEW_REQUEST'],
    [EMAIL,   'send price list to Houston',                                   'NEW_REQUEST'],
    [CONTNO,  'did NTG reply about the ERD',                                  'NEW_REQUEST'],
    [TRUCKER, 'forward DALA23991600 to Dave',                                 'NEW_REQUEST'],

    // Real answers — MUST NOT be misread as new requests
    [CARGO,   'Aluminium combo 40000 lbs value 5000',                         'ANSWER'],
    [CARGO,   'shredded scrap, 42000 pounds, worth about $9,500',             'ANSWER'],
    [CARGO,   'Al combo 40000 lbs $5000',                                     'ANSWER'],
    [TRUCKER, 'NTG and Matthew',                                              'ANSWER'],
    [TRUCKER, 'ask TQL only',                                                 'ANSWER'],
    [EMAIL,   'jose@radmetals.com',                                           'ANSWER'],
    [EMAIL,   'you can use apg0596@gmail.com for now',                        'ANSWER'],
    [CONTNO,  'TCLU7788123',                                                  'ANSWER'],
    [CITY,    'Houston please',                                               'ANSWER'],

    // Corrections — she is fixing her own earlier answer, still an ANSWER
    [TRUCKER, 'sorry I meant Matthew not NTG',                                'ANSWER'],
    [EMAIL,   'actually use the other address, jose@radmetals.com',           'ANSWER'],

    // Genuinely ambiguous — reported, not scored
    [CARGO,   'scrap',                                                        'EITHER'],
    [CITY,    'Houston',                                                      'EITHER'],
];

(async () => {
    let dangerous = 0, safe = 0, ok = 0, ambiguous = 0;
    console.log('\n########## LIVE ARBITER TEST ##########\n');

    for (const [q, msg, want] of CASES) {
        let got;
        try { got = await classifyAgainstPending(msg, q); }
        catch (e) { got = 'THREW:' + e.message; }

        if (want === 'EITHER') {
            ambiguous++;
            console.log(`  amb   ${JSON.stringify(msg).slice(0, 58).padEnd(60)} -> ${got}`);
            continue;
        }
        if (got === want) { ok++; console.log(`  ok    ${JSON.stringify(msg).slice(0, 58).padEnd(60)} -> ${got}`); continue; }

        if (want === 'ANSWER' && got === 'NEW_REQUEST') {
            dangerous++;
            console.log(`  DANGER ${JSON.stringify(msg).slice(0, 57).padEnd(60)} -> ${got}  (would DISCARD what she typed)`);
        } else {
            safe++;
            console.log(`  safe   ${JSON.stringify(msg).slice(0, 57).padEnd(60)} -> ${got}  (falls back to today's behaviour)`);
        }
    }

    const scored = ok + dangerous + safe;
    console.log('\n########## SUMMARY ##########');
    console.log(`  correct            ${ok}/${scored}`);
    console.log(`  safe failures      ${safe}   (no worse than before the arbiter)`);
    console.log(`  DANGEROUS failures ${dangerous}   (data loss — must be 0)`);
    console.log(`  ambiguous (unscored) ${ambiguous}`);

    if (dangerous > 0) {
        console.log('\n  NOT SAFE TO RELY ON YET. An answer she typed would be thrown away.');
        console.log('  Tighten the prompt in helpers/pendingArbiter.js, or raise MIN_CONFIDENCE.');
    } else if (safe > 0) {
        console.log('\n  Safe to run. Some topic changes still get the old nag — an improvement');
        console.log('  opportunity, not a risk. Nothing she types can be lost.');
    } else {
        console.log('\n  All scored cases correct.');
    }
    process.exit(dangerous > 0 ? 1 : 0);
})();
