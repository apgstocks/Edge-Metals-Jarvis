// ── tests/helpers/e2e.js ──────────────────────────────────────────────────
// Apsara, 2026-09-07: "test it end to end. set up testing environment."
//
// WHY THIS IS NEEDED, stated plainly: everything built today is tested with
// the module under test loaded directly and its neighbours replaced by stubs.
// That catches logic errors and it caught a lot of them. What it CANNOT catch
// is the class of bug that has actually reached her all day — the pieces not
// fitting together. The numbers that never reached the preview. The variable
// that did not exist on the one path that reopens the microphone. The
// acknowledgement that borrowed the other assistant's words. Every one of
// those passed its own unit tests.
//
// So this boots the REAL Express app from createApi(), over a real socket,
// and talks to /api/voice/ask the way the browser does — one HTTP request per
// utterance, with the server keeping its own memory between them. Nothing is
// reached into. If a conversation works here, the parts fit.
//
// WHAT IS AND IS NOT FAKED, and the line is deliberate:
//   FAKED  — Gemini. A test that calls a paid API is a test nobody runs
//            twice, and a non-deterministic one is worse than none. The stub
//            is installed at the MODULE boundary (require.cache), so every
//            caller reaches it exactly as it reaches the real thing.
//   REAL   — the router, the referent memory, the centering, the repair
//            classifier, the proforma draft, answerCards, followUp, the
//            pending machinery, JSON persistence with its file locks, auth.
//
// AND IT RUNS TWICE. Once with the model answering, once with it dead. The
// second pass is not a bonus: Gemini is genuinely unreachable for her
// sometimes, and "works only when the model is up" is a feature that fails on
// the day it matters.

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');

// ── OVERLAY, DO NOT REPLACE ──────────────────────────────────────────────
// The real module is required FIRST so the overlay keeps every export it
// does not deliberately override. Skipping that is how "getGmailRead is not
// a function" happened: require.cache had no entry yet, the spread copied an
// empty object, and the stub silently amputated ninety per cent of the
// module's surface. A stub that removes functions is not a stub, it is a
// different module wearing the same name.
function overlay(relPath, patch) {
    const p = require.resolve(path.join(ROOT, relPath));
    let base = {};
    try { base = require(p) || {}; } catch (e) { /* a module that cannot load is still stubbable */ }
    require.cache[p] = { id: p, filename: p, loaded: true, exports: Object.assign({}, base, patch) };
}

// ── FIXTURE ──────────────────────────────────────────────────────────────
// Four bookings, two of them Houston, with the shape her real data has —
// verified against data/bookings.json on 2026-09-07, which carries erd_date
// and cutoff_date on 4/4 rows. Dates are relative to today so "next
// Wednesday" and "in N days" mean something whenever this is run; a fixture
// with hardcoded 2026 dates would go stale and start asserting nonsense.
function ymd(offsetDays) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

function fixtures(dir) {
    fs.writeFileSync(path.join(dir, 'bookings.json'), JSON.stringify({
        // Soonest cutoff first is what answerCards sorts to, so THIS is the
        // one "the first one" and the discourse center should land on.
        HOU111: {
            booking_number: 'HOU111', carrier: 'MSC',
            port_of_loading: 'HOUSTON', port_of_discharge: 'BUSAN',
            erd_date: ymd(3), cutoff_date: ymd(7), vessel_voyage: 'MSC ANNA / 512W',
            containers: [{ seq: 1, size: '40HC', supplier: 'Eccomelt' }],
        },
        HOU222: {
            booking_number: 'HOU222', carrier: 'Maersk',
            port_of_loading: 'HOUSTON', port_of_discharge: 'BUSAN',
            erd_date: ymd(9), cutoff_date: ymd(14), vessel_voyage: 'MAERSK KOWLOON / 118E',
            // A supplier, because forwardBooking refuses without one and the
            // "trucker unreachable" branch would never be reached — it would
            // stop at an earlier gate and the test would pass for the wrong
            // reason, which is how a green suite hides a bug.
            containers: [{ seq: 1, size: '40HC', supplier: 'Eccomelt' }],
        },
        OAK333: {
            booking_number: 'OAK333', carrier: 'ONE',
            port_of_loading: 'OAKLAND', port_of_discharge: 'BUSAN',
            erd_date: ymd(5), cutoff_date: ymd(11),
            containers: [{ seq: 1, size: '40HC' }],
        },
        LGB444: {
            booking_number: 'LGB444', carrier: 'CMA',
            port_of_loading: 'LONG BEACH', port_of_discharge: 'BUSAN',
            erd_date: ymd(2), cutoff_date: ymd(6),
            containers: [{ seq: 1, size: '40HC' }],
        },
    }, null, 2));
    // A trucker and a supplier, so the forward flow — the one with a real
    // driver at the end of it — can actually be walked end to end. Without
    // these, forwardBooking refuses at the first gate and the interesting
    // path is never reached.
    for (const [f, v] of [
        ['workflow.json', {}], ['brain.json', { pending_actions: {}, pending_queue: {} }],
        ['truckers.json', [{ name: 'Sher Trucking', number: '15551230001' }]],
        // NOTE, for the third time in this file: suppliers.json is NOT where
        // suppliers come from. They are a SUPABASE table, and the roster the
        // app actually reads is in installSupabase() below. I edited this line
        // first, saw no change, and had to be reminded by the code. Left here
        // because something else does read it, and because the next person
        // will make the same mistake unless the note is where the mistake is.
        ['suppliers.json', [{ name: 'Eccomelt', number: '15551230002' }]],
        // A contact whose name the recogniser reliably mangles. "Jeyshree"
        // is what Whisper returns; "Jayashree Menon" is who she means.
        ['contacts.json', [{ name: 'Jayashree Menon', email: 'jayashree@example.com' }]],
    ]) fs.writeFileSync(path.join(dir, f), JSON.stringify(v));
    // emailContacts reads its OWN file. Writing only contacts.json left the
    // roster empty and the suggestion path with nothing to suggest — the
    // truckers-live-in-Supabase lesson, a second time.
    fs.writeFileSync(path.join(dir, 'email_contacts.json'), JSON.stringify([
        { name: 'Jayashree Menon', email: 'jayashree@example.com' },
        { name: 'Yurim', email: 'yurim@example.com' },
    ], null, 2));
}

// ── THE MODEL STUB ───────────────────────────────────────────────────────
// One function, routed on what the prompt is asking for, so a single stub
// serves draftIntent, repair and followUp without any of them knowing.
// `mode: 'down'` is the offline pass.
//
// THE STUB MUST NOT THROW — 2026-09-08
// ------------------------------------
// It used to. `mode: 'down'` threw ECONNREFUSED, and that was WRONG, because
// the real helpers/gemini.js catches every error internally, records the kind
// in `lastFailure`, and RETURNS NULL. It has no throwing path at all.
//
// So every `gemini: 'down'` test in this repo was exercising a failure shape
// that cannot occur in production, and the callers that DO handle null were
// never reached. tests/phrasebook.js caught it on the first run: "forward the
// booking to tracker" came back HTTP 500, and the stack pointed at
// brain.js:1979 — `aiDecide` has no try/catch, because it does not need one.
// Against the real module it gets null and returns NEED_DATA on the very next
// line. Against my stub it exploded.
//
// The bug was in the harness, not the product. But a harness that invents
// failures is worse than no harness: it costs a day chasing a phantom and, far
// worse, it leaves the REAL offline behaviour of every one of those paths
// unmeasured. Fidelity at the boundary is the whole value of an e2e.
function installGemini(mode, log, o) {
    o = o || {};
    // Mirrors the real module's lastFailure: set on the way out of a failed
    // call, read by the caller to explain itself.
    let failure = null;
    const callGeminiJSON = async (prompt) => {
        failure = null;
        log.push(prompt);
        if (mode === 'down') {
            // Exactly what the real one does on an unreachable endpoint.
            failure = 'unreachable';
            return null;
        }
        // composer-* modes only fail the composer; everything else answers.
        const said = (/SHE SAID: (.*)/.exec(prompt) || [])[1] || '';

        // draftIntent — park / resume / amend / none
        if (/what she wants to do with the proforma/i.test(prompt)) {
            if (/\b(hold|leave|park|one sec|put .* down)\b/i.test(said)) return { label: 'park', why: 'stub' };
            if (/\b(back to|carry on|get on with|where were we)\b/i.test(said)) return { label: 'resume', why: 'stub' };
            if (/(trade terms|payment terms|the rate is|consignee is|CIF|FOB)/i.test(said)
                && /THE DOCUMENT IS FINISHED/.test(prompt)) return { label: 'amend', why: 'stub' };
            return { label: 'none', why: 'stub' };
        }
        // repair — undo / cancel / restart / none
        if (/TAKING SOMETHING BACK/i.test(prompt)) {
            if (/(start again|from the top|start over)/i.test(said)) return { label: 'restart', why: 'stub' };
            if (/(ignore that|forget|mistake|wrong|drop it)/i.test(said)) return { label: 'cancel', why: 'stub' };
            if (/(not that one|take that back)/i.test(said)) return { label: 'undo', why: 'stub' };
            return { label: 'none', why: 'stub' };
        }
        // followUp — answers from the rows already on screen.
        if (/DATA \(the bookings currently on her screen\)/.test(prompt)) {
            const asked = (/SHE ASKED: (.*)/.exec(prompt) || [])[1] || '';
            const about = (/SHE IS ASKING ABOUT booking (\S+)/.exec(prompt) || [])[1] || '';
            const rows = JSON.parse((/DATA[^\n]*\n(\[.*\])/s.exec(prompt) || [])[1] || '[]');
            // `booking`, NOT `booking_number`. followUp.forModel() renames the
            // field on the way to the model, and my first stub read the
            // original name — so it answered "ERD on undefined is...". The
            // stub was wrong, not the code, but it is exactly the boundary-
            // rename hazard that makes an e2e worth having: a unit test with
            // a hand-built row would never have crossed forModel at all.
            const row = rows.filter((r) => r.booking === about)[0] || rows[0];
            if (!row) return { answer: '', have_data: false };
            // The model is now asked whether she is still on these rows —
            // see helpers/followUp.js. A follow-up is anything that is not a
            // fresh request for a different set.
            // ── THREE WAYS THE MODEL CAN ANSWER THIS ─────────────────────
            // 'deny' — it says she has moved on, AND declines to answer. Both
            //          halves matter: an answer FROM these rows is itself
            //          proof she is still on them, so a stub that denies
            //          while still answering tests nothing.
            // 'omit' — the field is missing entirely (an older model, a
            //          truncated reply). Must fall back to the patterns, not
            //          be read as a denial.
            // default — it answers, and says she is still on these rows.
            // A REALISTIC verdict: naming a different port, or asking for a
            // list, is her moving on. My first version said "still these
            // rows" for "what bookings are there from oakland", which is what
            // a careless model would do — and it revealed that the model's
            // yes was overruling the port check. Kept realistic so the test
            // exercises the arrangement rather than papering over it.
            const aboutRows = o.rowsField === 'deny'
                ? false
                : !/\b(?:show|list|what|which|any)\b[^?.]{0,30}\bbookings?\b/i.test(asked)
                  && !/\b(houston|oakland|long beach|busan)\b/i.test(asked);
            const withVerdict = (obj) => (o.rowsField === 'omit'
                ? obj : Object.assign({}, obj, { about_these_rows: aboutRows }));
            if (o.rowsField === 'deny') return withVerdict({ answer: '', have_data: false });

            // ── A MODEL ASKED THE WRONG QUESTION ANSWERS IT ANYWAY ───────
            // Apsara, 2026-09-08: "when i ask it to forward the booking,
            // instead of getting into forwarding process, it just shows cut
            // off for the booking is in 7 days."
            //
            // The rest of this stub is well-behaved: handed "forward the
            // booking" it matches none of the field patterns below and
            // returns no answer, so the bug she reported could not be
            // reproduced here at all — the first mutation of the fix survived
            // the whole suite for exactly that reason.
            //
            // A real model does not decline. Given a table and a sentence and
            // told to answer from the table, it produces the most useful field
            // it can find, which is precisely how an ORDER came back as a
            // cutoff date. `followUpEager` makes the stub behave like the real
            // thing, so the assertion is about the code refusing to ask, not
            // about the stub declining to answer.
            if (o.followUpEager) {
                return withVerdict({
                    answer: `The earliest one cuts off ${row.cutoff || 'not set'}.`,
                    have_data: true,
                });
            }
            if (/\berd\b/i.test(asked)) {
                return withVerdict({ answer: `ERD on ${row.booking} is ${row.erd || 'not set'}.`, have_data: true });
            }
            if (/vessel/i.test(asked)) {
                return withVerdict({ answer: `${row.booking} is on ${row.vessel || 'no vessel yet'}.`, have_data: true });
            }
            return withVerdict({ answer: '', have_data: false });
        }
        // The email composer. Without this the draft comes back null and the
        // flow stops at "couldn't draft" — so the confirmation gate, the
        // yes/no, and the send itself were all unreachable.
        if (/Return ONLY this JSON: \{ "subject"/.test(prompt)) {
            // Reproduces the exact production failure she reported: the
            // classifier works, the address is found, and the WRITER is the
            // thing that does not come back.
            //
            // RETURNS NULL, does not throw — because the real callGeminiJSON
            // catches everything internally and returns null. My first
            // version threw, which propagated to the brain as "Something
            // broke while handling that: 401 API key not valid" — a contract
            // the real function does not have, so the test was measuring a
            // failure mode that cannot happen.
            const composerFail = { 'composer-auth': 'auth', 'composer-quota': 'quota',
                                   'composer-down': 'unreachable', 'composer-junk': 'unusable' }[mode];
            if (composerFail) { failure = composerFail; return null; }
            // ── THE STUB HAS TO CARRY THE BRIEF ──────────────────────────
            // It used to return this fixed body whatever it was asked, which
            // meant every assertion in the suite about what an email SAYS was
            // vacuous: "need bookings from HOUSTON to BUSAN 2x40HC with cut
            // off as 20 Sep 2026" could be dropped entirely and the tests
            // stayed green, because the stub was never going to include it.
            //
            // Same class of fault as this file's own composerFail note above:
            // a stub whose contract differs from the real function's makes the
            // test measure something that cannot happen. A real model handed
            // "the email must contain this sentence" puts the sentence in. So
            // the stub does too — lifted VERBATIM out of the prompt, which
            // also means a caller that stops passing its facts through is
            // caught here rather than in production.
            const must = /must contain this sentence[^"]*"([^"]+)"/i.exec(prompt);
            const body = ['Hi,', '', must ? must[1] : 'Could you confirm the cutoff?', '', 'Apsara'].join('\n');
            return { subject: must ? 'Booking request' : 'Houston cutoff', body };
        }

        // ── THE BRAIN'S OWN ACTION CLASSIFIER ────────────────────────────
        // workflow/brain.js:aiDecide() goes through callGeminiJSON too, so
        // without this every sentence that reaches the brain came back
        // NEED_DATA — "I couldn't pin that down" — and the whole action
        // surface was untestable end to end. That is not a small gap: it is
        // most of what Jarvis actually DOES.
        //
        // Deliberately crude. The point is not to reproduce the real
        // classifier's judgement — it is to hold the classification FIXED so
        // everything downstream of it can be exercised. When she reports
        // "send mail is not doing that", this is what tells us whether the
        // fault is the classification or the twelve steps after it.
        if (/AVAILABLE ACTIONS/i.test(prompt) || /bookings_list_query, bookings_count_query/.test(prompt)) {
            // The sentence sits under a "NEW MESSAGE" banner, in quotes.
            // Read off the real prompt rather than guessed at: my first
            // version matched nothing and every classification came back
            // NEED_DATA, which looked exactly like the bug being chased.
            const t = (/═══ NEW MESSAGE ═══\s*\n"([\s\S]*?)"\s*\n/.exec(prompt) || [])[1] || '';
            // CASE-INSENSITIVE. My first version required a capital letter,
            // so "send a mail to jeyshree" extracted no name at all and the
            // whole suggestion path was unreachable — a transcript is very
            // often lowercase, which is precisely the case being tested.
            // Stops at "about", which is her saying what the mail is for.
            const who = (/\b(?:to|for)\s+((?!the\b)[\w&.'\-]+(?:\s+(?!about\b|regarding\b|re\b)[\w&.'\-]+)?)/i.exec(t) || [])[1] || null;
            if (/\b(?:e?mail|mail)\b/i.test(t) && /\b(?:send|write|draft|shoot)\b/i.test(t)) {
                return { action: 'draft_email', target_name: who, email_details: null,
                         bkg_no: null, confidence: 0.95, reasoning: 'stub' };
            }
            return { action: 'NEED_DATA', confidence: 0, reasoning: 'stub: not classified' };
        }
        return null;
    };
    // Everything else the real module exports is preserved, so a caller
    // reaching for extractPdfFields does not get undefined and throw a
    // TypeError that reads like a bug in the code under test.
    overlay('helpers/gemini.js', {
        callGeminiJSON,
        lastGeminiFailure: () => failure,
    });
}

// ── SUPABASE ─────────────────────────────────────────────────────────────
// Truckers and suppliers do NOT live in DATA_DIR — they are Supabase tables.
// Found the hard way: a truckers.json fixture sat there doing nothing while
// "Trucker 'sher trucking' not found" came back, because nothing reads that
// file. An end-to-end harness that only fakes the filesystem is not
// end-to-end for the half of the data that is in a database.
//
// A tiny in-memory stand-in rather than a real Supabase: the query surface
// actually used across the repo is four tables and a handful of chained
// calls, and every one of them is here. It is thenable, because the real
// client is awaited directly without calling .then().
function installSupabase(tables) {
    const q = (name) => {
        let rows = (tables[name] || []).slice();
        const api = {
            select: () => api,
            order: (col) => { rows.sort((a, b) => String(a[col] || '').localeCompare(String(b[col] || ''))); return api; },
            eq: (c, v) => { rows = rows.filter((r) => r[c] === v); return api; },
            ilike: (c, v) => { const re = new RegExp('^' + String(v).replace(/%/g, '.*') + '$', 'i');
                               rows = rows.filter((r) => re.test(String(r[c] || ''))); return api; },
            insert: (r) => { (tables[name] = tables[name] || []).push(r); return api; },
            upsert: () => api,
            delete: () => { tables[name] = (tables[name] || []).filter((r) => !rows.includes(r)); return api; },
            then: (res) => res({ data: rows, error: null }),
        };
        return api;
    };
    overlay('helpers/supabase.js', {
        getSupabase: () => ({ from: q, rpc: async () => ({ data: [], error: null }) }),
    });
}

// ── GMAIL ────────────────────────────────────────────────────────────────
// The third external the harness has to stand in for, alongside Gemini and
// Supabase. Without it "send a mail to Yurim" stops at "Gmail isn't
// configured" and everything downstream — finding the address, drafting,
// staging the confirmation, and the yes/no gate that is the only thing
// between her and an email going out — is never reached.
//
// `sent` records what WOULD have gone, so a test can assert both that
// nothing left before she confirmed AND that it did after.
// A googleapis-shaped client with nothing in the mailbox. Enough for the
// draft path to look, find nothing, and move on to the stubbed helpers.
function fakeClient() {
    return {
        users: {
            messages: {
                list: async () => ({ data: { messages: [] } }),
                get: async () => ({ data: { payload: { headers: [] }, snippet: '' } }),
                send: async () => ({ data: { id: 'sent-1', threadId: 'thread-1' } }),
            },
            getProfile: async () => ({ data: { emailAddress: 'apsara@edgemetals.com' } }),
            threads: { get: async () => ({ data: { messages: [] } }) },
        },
    };
}

function installGmail(store, opts) {
    const o = opts || {};
    overlay('helpers/gmail.js', {
            // The credential-backed entry points. Left real, they throw "Gmail
        // OAuth client secret missing" before any of the stubs below are
        // reached — the draft path checks the client, not just the helpers.
        getOAuthClient: async () => ({}),
        getGmailRead: async () => fakeClient(),
        getGmailWrite: async () => fakeClient(),
        getGmailSenderRead: async () => fakeClient(),
        getMyEmailAddress: async () => 'apsara@edgemetals.com',
            // A prior message from the recipient is how an address is found
            // when there is no saved contact — the same route production
            // takes before it resorts to asking her.
            findLatestFrom: async (client, name) =>
            // Returns a STRING. My first version returned a message object
            // and actions.js correctly refused it — "findLatestFrom resolved
            // a non-address ... discarding" — which is the guard that stops a
            // malformed lookup becoming an email addressed to "[object
            // Object]". Worth keeping in the record.
            (o.knows === false ? null
                : `${String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '')}@example.com`),
        listMessages: async () => [],
            getMessage: async () => null,
            getEmailContent: async () => '',
            detectCcPattern: async () => [],
            sendEmail: async (m) => { store.push(m); return { id: 'sent-1', threadId: 'thread-1' }; },
        looksLikeAuthFailure: () => false,
    });
}

// ── BOOT ─────────────────────────────────────────────────────────────────
// Returns { say, port, dir, prompts, stop }. `say` is one utterance, the way
// dashboard/voice.js sends it: POST /api/voice/ask { text, agent }.
async function boot(opts) {
    const o = opts || {};
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-e2e-'));

    // BEFORE anything requires config.js, which captures every path at load.
    process.env.DATA_DIR = dir;
    process.env.JARVIS_TEST = '1';
    process.env.API_TOKEN = process.env.API_TOKEN || 'e2e-token';
    // No key means helpers/voice.js will not try to synthesise, and the
    // health check reports it honestly rather than hanging.
    delete process.env.GEMINI_API_KEY;
    fixtures(dir);

    // A COLD REQUIRE GRAPH PER BOOT. Without this the second pass inherits
    // the first pass's module-level state — voiceMemory's turns and
    // referents, proformaDraft's draft, config's captured paths — and the
    // "offline" run would be reading the online run's memory. That is the
    // sort of shared state that makes a suite pass in one order and fail in
    // another, which is worse than a failure.
    for (const k of Object.keys(require.cache)) {
        if (k.startsWith(ROOT) && !k.includes('node_modules')) delete require.cache[k];
    }

    const prompts = [];
    installGemini(o.gemini || 'up', prompts, o);
    const mails = [];
    installGmail(mails, { knows: o.gmailKnowsAddress });
    installSupabase({
        // TWO truckers on purpose. Sher has a group, so a forward to it can
        // actually go and be asserted as gone. Jio has neither group nor
        // number, which is how the "could not reach them" branch gets walked
        // — the branch that used to mark a booking forwarded anyway.
        // Sher Trucking and Jio have NO locality, which several suites depend
        // on — buildTruckerSelectionMessage filters by the booking's port, so
        // with only those two every "forward" ends at "No trucker registered
        // at HOUSTON".
        //
        // That turned out to be a hole rather than a choice: it meant the
        // SELECTION path — Jarvis listing the truckers and her picking one —
        // had never been walked by voice at all, because every voice test
        // stopped one gate earlier. Found on 2026-09-09 while demonstrating
        // the flow to her, which is a bad time to find it.
        //
        // Bayou Haulage is additive: one port gains a trucker the selection
        // message will offer. Nothing any existing suite sees changes.
        truckers: [
            { id: 1, name: 'Sher Trucking', number: '15551230001', group_id: '120363111@g.us' },
            { id: 2, name: 'Jio Transport' },
            // group_id too, or the last step refuses with "no WhatsApp number
            // or email on file" — which is correct behaviour and exactly the
            // guard added on 2026-09-07, but it means the SUCCESS path still
            // never completes. A fixture that stops one gate short of the end
            // is how a flow gets called "tested" without ever having worked.
            { id: 3, name: 'Bayou Haulage', number: '15551230004', locality: 'HOUSTON',
              group_id: '120363222@g.us' },
        ],
        // Eccomelt deliberately has NO locality — several suites rely on the
        // port filter finding nothing at their port. Oakland Metals is
        // additive: exactly one port gains a supplier the selection message
        // will offer, so the assign-then-resume path can be walked end to end
        // without changing what any existing suite sees.
        suppliers: [{ id: 1, name: 'Eccomelt', number: '15551230002' },
                    { id: 2, name: 'Oakland Metals', number: '15551230003', locality: 'OAKLAND' }],
        facts: [], memory_embeddings: [],
    });

    // ── WIRE THE MESSAGING, AS index.js DOES ────────────────────────────
    // workflow/actions.js takes its senders from init(), called only by
    // index.js. Without this every action dies with "_send is not a
    // function" — which is exactly what this harness found on its first run,
    // and it is a wiring fact rather than a bug in the flow under test.
    //
    // The sender mirrors index.js's own: replies to HER chat are captured for
    // the HTTP response, anything aimed at a trucker or supplier is RECORDED
    // AND NOT SENT, so a test can assert that a real driver was never
    // messaged. That last part is the whole reason this is worth wiring
    // rather than stubbing away.
    const sent = [];
    const cfg = require(path.join(ROOT, 'config.js'));
    const managerChat = `${cfg.getSettings().manager_number || cfg.MANAGER_NUMBER}@c.us`;
    const { sendCapture } = require(path.join(ROOT, 'helpers/wa-state.js'));
    const sendMessage = async (to, text, media) => {
        const cap = sendCapture.getStore();
        if (cap && to === managerChat) {
            cap.replies.push({ chatId: to, text: text || null, media: media || null });
            return true;
        }
        // ── WHAT "WHATSAPP IS DOWN" ACTUALLY MEANS ──────────────────────
        // index.js: `if (!waReady) { console.warn('[SEND] WA not ready —
        // dropped message'); return false; }`. So a down transport returns
        // FALSE for outbound messages. Returning true here regardless was the
        // harness lying about the very state it was meant to simulate — and
        // it made the "not forwarded" assertions pass for the wrong reason.
        sent.push({ to, text: text || null, delivered: !o.noBridge });
        if (o.noBridge) return false;
        // `senderReturns: 'undefined'` models a sender that reports nothing
        // at all — several in this repo do. It must NOT be read as failure.
        return o.senderReturns === 'undefined' ? undefined : true;
    };
    require(path.join(ROOT, 'workflow/actions.js')).init({
        sendMessage,
        sendToManager: (t) => sendMessage(managerChat, t),
        sendToTeam: (t) => { sent.push({ to: 'team', text: t }); return Promise.resolve(true); },
        pushAlert: () => {},
    });
    // `noBridge` leaves global.__jarvisSendMessage unset, which is the REAL
    // degraded state: Jarvis up, WhatsApp transport gone. actions.init() is
    // still called, because that is a wiring fact rather than part of the
    // outage being simulated — conflating the two would test nothing.
    if (!o.noBridge) global.__jarvisSendMessage = sendMessage;
    else delete global.__jarvisSendMessage;

    const { createApi } = require(path.join(ROOT, 'api.js'));
    const app = createApi();
    const srv = http.createServer(app).listen(0);
    await new Promise((r) => srv.once('listening', r));
    const port = srv.address().port;

    const say = (text, agent) => new Promise((resolve, reject) => {
        const body = JSON.stringify({ text, agent: agent || 'jarvis' });
        const req = http.request({
            host: '127.0.0.1', port, path: '/api/voice/ask', method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                Authorization: `Bearer ${process.env.API_TOKEN}`,
            },
        }, (res) => {
            let raw = ''; res.on('data', (d) => { raw += d; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(raw); } catch (e) { /* left null on purpose */ }
                resolve({ status: res.statusCode, json, raw });
            });
        });
        req.on('error', reject);
        req.write(body); req.end();
    });

    return {
        port, dir, prompts, say, sent, mails,
        stop: () => { delete global.__jarvisSendMessage; return new Promise((r) => srv.close(r)); },
    };
}

module.exports = { boot, fixtures, ymd, installGemini, installSupabase };
