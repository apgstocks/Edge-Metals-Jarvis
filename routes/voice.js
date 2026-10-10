// routes/voice.js — split from api.js (helpers/sourceParts.js reconstructs the original)
const cfg = require('../config');

module.exports = function (app, ctx) {
    const { largeJson } = ctx;
// @@chunk-start
    app.post('/api/yard/ask', async (req, res) => {
        try {
            const { askYard } = require('./helpers/yardAsk');
            const b = req.body || {};
            const out = await askYard(b.question, { history: b.history, days: b.days, role: req.role });
            // Transcript, one file per day — per Apsara 2026-08-29. Written
            // AFTER the answer is in hand and deliberately not awaited into the
            // response path: a log that cannot be written must never turn a
            // working question into an error. helpers/yardChatLog.js swallows
            // its own failures for the same reason.
            try {
                require('./helpers/yardChatLog').logExchange({
                    question: b.question, answer: out && out.answer,
                    have_data: out && out.have_data, ok: out && out.ok,
                    role: req.role || null, source: b.source || null,
                });
            } catch (e) { /* never let logging break answering */ }
            res.json(out);
        } catch (e) {
            console.error('[API] yard/ask failed:', e.message);
            res.status(500).json({ ok: false, answer: "Something went wrong answering that." });
        }
    });

    // ── Jarvis's voice ────────────────────────────────────────────────────
    // Per Apsara 2026-08-29: "give voice to the app... make it talk back",
    // "i want to give human voice to jarvis", "voice charon".
    //
    // Returns WAV audio. See helpers/voice.js for why this is Gemini's TTS
    // rather than the phone's own engine, and why the fixed phrases are
    // cached — measured, synthesis is ~3s at best and ~10s for a sentence,
    // which is fine for an answer and hopeless for the "Yes?" that comes back
    // when she says Hey Jarvis.
    //
    // Not admin-gated: the staff prefix list already blocks staff from
    // /api/voice, and speaking a sentence the caller can already read on
    // their own screen grants nothing new.
    // ── THE NAMES THE RECOGNISER SHOULD EXPECT TO HEAR ───────────────────
    // Apsara, 2026-09-07: "send mail to jeyshree" transcribed as "jayashree".
    //
    // Contextual biasing, which is what Siri and Alexa do about exactly this
    // — see helpers/voiceVocab.js for the papers. The desktop app cannot
    // build the list itself: it has no bookings, no contacts and no Supabase.
    // So it asks for it here and pushes it into Whisper's initial_prompt.
    //
    // READ-ONLY and cheap, but it is a list of her customers' names, so it
    // sits behind the same auth as everything else rather than being open
    // because it "is only vocabulary".
    app.get('/api/voice/vocab', async (req, res) => {
        try {
            const vv = require('./helpers/voiceVocab');
            const sources = await vv.fromDataAsync();
            const prompt = vv.buildPrompt(sources);
            // `terms` (2026-09-20): the same names as a list, for Chrome, which
            // cannot take a prompt — dashboard/voice.js uses them to choose
            // between the recogniser's alternative transcripts.
            const t = vv.terms(sources);
            const terms = [...t.ports, ...t.suppliers, ...t.truckers, ...t.consignees, ...t.contacts];
            res.set('Cache-Control', 'no-store');
            res.json({ ok: true, prompt, chars: prompt.length, terms });
        } catch (e) {
            // A failure here must not stop her talking: the desktop app keeps
            // the static prompt it shipped with, which is yesterday's
            // behaviour rather than a broken microphone.
            console.warn('[VOICE] vocab build failed:', e.message);
            res.status(200).json({ ok: false, error: e.message, prompt: null });
        }
    });

    app.get('/api/voice/phrase/:name', async (req, res) => {
        try {
            const { phrase } = require('./helpers/voice');
            // ── ?voice=Leda ──────────────────────────────────────────────
            // Apsara, 2026-09-06: "when i call Hey scout, a different voice
            // should answer with MMm hmm."
            //
            // The two assistants already HAVE different voices — Jarvis is
            // Charon, Scout is Leda, declared in helpers/voiceRouter.js —
            // and say() has always taken a voice. Only this endpoint was
            // hard-wired to the default, so both acknowledgements came back
            // in the same voice and the one signal that says WHICH assistant
            // is listening was thrown away at the last step.
            //
            // Safe to cache: cacheKey() already includes the voice and its
            // style prompt, so the two never collide on disk.
            const wanted = String(req.query.voice || '').trim();
            // Orus is Jarvis's voice as of 2026-09-07 ("bolder"); Charon stays
            // allowed so VOICE_NAME can put it back without a code change.
            const VOICES_ALLOWED = ['Orus', 'Charon', 'Leda'];
            const wav = await phrase(String(req.params.name || ''),
                VOICES_ALLOWED.indexOf(wanted) !== -1 ? { voice: wanted } : {});
            res.set('Content-Type', 'audio/wav');
            // Immutable: a fixed phrase in a fixed voice never changes, so the
            // WebView can keep it and the wake acknowledgement costs nothing
            // after the first play.
            res.set('Cache-Control', 'public, max-age=31536000, immutable');
            res.send(wav);
        } catch (e) {
            // 404 rather than 500 for an unknown name; the app treats any
            // failure the same way — it just stays silent and shows the text.
            res.status(/unknown phrase/.test(e.message) ? 404 : 503).json({ error: e.message });
        }
    });

    // ── One spoken question, routed to whoever should answer it ───────────
    // Per Apsara 2026-08-29: "When user asks any question to Jarvis which is
    // related to Yard... Direct those question to that yard agent."
    //
    // The app used to send every spoken command straight to /api/bot/command.
    // That is the brain, which books loads and sends WhatsApp for real. A yard
    // question does not belong there — Scout already exists, already knows the
    // yard data, and cannot message anyone. See helpers/voiceRouter.js for why
    // the routing leans towards Scout when it is unsure.
    //
    // Returns TEXT only. The audio is fetched separately by the app so the
    // answer can appear on screen immediately rather than waiting ~3-10s on
    // speech synthesis — measured, not assumed.
    app.post('/api/voice/ask', largeJson, async (req, res) => {
        try {
            const { routeVoice, stripAgentName, AGENTS } = require('./helpers/voiceRouter');
            const text = String((req.body || {}).text || '').trim();
            if (!text) return res.status(400).json({ error: 'nothing was said' });

            // ── SHE CAN NAME THE ASSISTANT ───────────────────────────────
            // "Hey Scout" addresses Scout, whatever the content scores. The
            // router already honours an explicit address in TYPED text; this
            // carries the same thing from the wake word, where the name has
            // already been stripped off before the router ever sees it.
            // ── AN OPEN QUESTION OWNS THE CONVERSATION ───────────────────
            // Apsara: "finally when i say okay forward that to trucker, it
            // should do that if it has knowledge about who to forward, else
            // ask me."
            //
            // workflow/actions.js already does exactly that — forwardBooking
            // refuses without a supplier, asks WHICH TRUCKER when none was
            // named, then asks "Forward AAA111 to Sher Trucking? (yes/no)"
            // and only sends on yes. The whole flow has existed for weeks.
            //
            // What broke it by voice is this: her answer to that question is
            // "yes", or "Sher Trucking", or "the second one" — sentences
            // with NO freight vocabulary in them. The router scores them as
            // yard talk and hands them to Scout, so the confirmation for a
            // real WhatsApp to a real driver disappears into the assistant
            // that cannot act on it, and the question stays open for ever.
            //
            // So while the brain is holding a question, everything goes to
            // the brain. Same rule as the proforma draft below, for the same
            // reason: an answer belongs to whoever asked.
            let brainPending = null;
            try {
                brainPending = require('./workflow/actions').getPending(
                    `${(cfg.getSettings().manager_number || cfg.MANAGER_NUMBER)}@c.us`);
            } catch (e) { /* no pending is the normal case */ }
            const answeringBrain = !!brainPending;
            if (answeringBrain) {
                console.log(`[VOICE] answering the open "${brainPending.type}" question`);
            }

            const named = String((req.body || {}).agent || '').toLowerCase();
            const route = answeringBrain
                ? { agent: 'jarvis', why: 'answering the question Jarvis just asked', addressed: true }
                : (named === 'scout' || named === 'jarvis')
                ? { agent: named, why: 'you called ' + named + ' by name', addressed: true }
                : routeVoice(text);
            const agent = AGENTS[route.agent];
            const mem = require('./helpers/voiceMemory');

            // ── IS JARVIS WAITING FOR AN ANSWER? ─────────────────────────
            // Apsara, 2026-09-07: "it is not waiting for follow up. i have to
            // say hey jarvis..then this loop restarts"
            //
            // Jarvis asked "What material?" and then stopped listening. She
            // had to say the wake word again to answer a question it had just
            // asked. The dashboard reopens the microphone on this flag.
            //
            // ONE RULE, computed in one place, rather than a flag set by hand
            // in each of the six branches below — those drift, and the one
            // that gets forgotten is the one that leaves her talking to a
            // microphone that is not on. Three signals, any of which means an
            // answer is expected:
            //
            //   · a pending exists — the brain is holding a question open,
            //     which is the authoritative signal and covers every confirm,
            //     trucker choice and supplier choice it has ever asked
            //   · the reply ends in a question mark. Crude, and deliberately
            //     so: it needs no cooperation from the six different things
            //     that can produce an answer, and a question mark at the end
            //     of a spoken sentence means the same thing everywhere
            //   · a proforma is mid-flow, where even the preview ("Send it to
            //     Daekwang?") is waiting on her
            const answering = (payloadIn) => {
                let payload = payloadIn;
                let awaiting = false;
                try {
                    const acts = require('./workflow/actions');
                    awaiting = !!acts.getPending(
                        `${(cfg.getSettings().manager_number || cfg.MANAGER_NUMBER)}@c.us`);
                } catch (e) { /* no pending machinery is not a reason to fail a reply */ }
                if (!awaiting && typeof payload.answer === 'string'
                    && /\?["'”)]*\s*$/.test(payload.answer.trim())) awaiting = true;
                if (!awaiting && payload.proforma && payload.proforma.stage) awaiting = true;
                // ── NEVER ANSWER WITH NOTHING ────────────────────────────
                // Found 2026-09-07: a follow-up that reached the router with
                // the model down came back with answer:'' — a blank card and
                // silence, which reads as a dead microphone. Every branch in
                // this handler is supposed to say something; this is the one
                // place that can guarantee it, so it does, and it says so in
                // the log rather than papering over quietly.
                if (typeof payload.answer !== 'string' || !payload.answer.trim()) {
                    console.error('[VOICE] a branch produced an EMPTY answer — '
                        + JSON.stringify({ agent: payload.agent, ok: payload.ok }));
                    payload = Object.assign({}, payload, {
                        answer: "Something went wrong working that out — say it again?",
                        ok: false,
                    });
                }
                // ── WHAT IS SPOKEN IS NOT WHAT IS SHOWN ──────────────────
                // Apsara, 2026-09-19: "i dont want it to say out the booking
                // number aloud. bcoz it doesnt make any sense". `answer`
                // stays exactly as it was (the card shows the number);
                // `spoken` is the copy the speaker reads. See
                // helpers/spokenAnswer.js for the scope — booking numbers only.
                if (typeof payload.spoken !== 'string') {
                    try {
                        const { forSpeech } = require('./helpers/spokenAnswer');
                        const rows = (payload.cards && Array.isArray(payload.cards.rows)) ? payload.cards.rows : [];
                        payload = Object.assign({}, payload, { spoken: forSpeech(payload.answer, { rows }) });
                    } catch (e) {
                        console.warn('[VOICE] spoken copy failed, speaking the answer as-is:', e.message);
                    }
                }
                // Merged UNDER the payload so an explicit awaiting on a
                // branch always wins over the inferred one.
                return res.json(Object.assign({ awaiting }, payload));
            };


            // ── RESOLVE THE REFERENCE BEFORE ANYTHING BLIND SEES IT ──────
            // Apsara: "if I say forward that to trucker" — after three
            // bookings were on screen.
            //
            // Done HERE, between stripping the agent's name and everything
            // downstream, because two things further on cannot see a
            // conversation at all: answerCards.cardsFor() is a regex over
            // the utterance, and the brain's policy layer is pattern
            // matching over session state. Both need a sentence that stands
            // on its own.
            //
            // Deliberately NOT done for Gemini's benefit — it can resolve
            // references from history perfectly well, and the measured
            // result of rewriting for a model that can see context is
            // slightly WORSE accuracy, not better (Ishii et al. 2022).
            //
            // Apsara, later the same day: "my user doesnt know about nouns.
            // you can try to understand what he says like any ai does."
            // So resolveSmart, not resolve — the model works out WHICH ROW
            // ("the Maersk one", "the urgent one", "send it"), and the
            // booking number is then read out of OUR row by index. The model
            // picks; it never writes an identifier.
            // Speech repairs first (helpers/voiceClaims.js): Chrome writes
            // "what's up" as "WhatsApp", and hears a greeting twice.
            const vc = require('./helpers/voiceClaims');
            const stripped = vc.normalizeHeard(stripAgentName(text));

            // ── NOISE IS NOT A QUESTION ──────────────────────────────────
            // "or or or" (her recording, 2026-09-20) went to the model and
            // came back "I cannot answer that question with the data
            // provided". A capture made only of filler words is treated as
            // nothing heard.
            if (vc.isNoise(stripped)) {
                console.log(`[VOICE] "${stripped}" is noise — not asking anyone`);
                return res.json({ ok: true, agent: route.agent, agent_name: agent.name, voice: agent.voice,
                    routed_because: 'noise', answer: "Didn't catch that.", spoken: 'Sorry?', cards: null, awaiting: false });
            }
            // Does the brain own this sentence outright — the briefing, her
            // inbox, urgent cutoffs, a Metals report? Then the bookings
            // machinery below (follow-up answerer, booking query, "which
            // port?") stands aside. Measured: with a Houston list on screen,
            // "what needs my attention" was answered as a follow-up about
            // that list, and "is there any mail" was asked which port.
            const brainOwns = route.agent === 'jarvis' ? vc.brainOwns(stripped) : null;
            if (brainOwns) console.log(`[VOICE] "${stripped}" belongs to the brain (${brainOwns}) — bookings panel stands aside`);

            // Is she half-way through a proforma? Checked FIRST: her answers
            // to its questions ("Daekwang", "never mind") belong to the
            // proforma, not to Scout and not to the dismissal below.
            let proformaOpen = false;
            try {
                // current(), not isStaged(): she is inside the proforma from
                // its FIRST question ("who is it for?"), long before a
                // preview is staged — and that first answer is the one most
                // likely to be a bare company name.
                const proDraft = require('./helpers/proformaDraft');
                proformaOpen = !!(proDraft.current() || proDraft.isStaged());
            } catch (e) { /* no proforma machinery is not a reason to fail */ }

            // ── "SHUT UP" IS NOT A QUESTION ──────────────────────────────
            // Apsara, 2026-09-19: "when i say shut up - it said 0 booking
            // from shutup". The browser's barge-in catches "shut up" only
            // WHILE Jarvis is talking; said at any other moment it reached
            // here as a question, the classifier read it as a bookings count,
            // and "shutup" became a port. A dismissal is answered with a
            // dismissal. "stop" is held back while anything is open — an
            // open question or a proforma — because there it means cancel and
            // the flow that asked has to see it. "never mind", "forget it"
            // and "enough" are deliberately NOT here: they already mean
            // "cancel that" to the retraction and proforma flows below.
            {
                const bare = String(stripped || '').trim().toLowerCase()
                    .replace(/^(?:(?:ok(?:ay)?|jarvis|scout|hey)[,\s]+)+/, '').replace(/[.!?,\s]+$/, '');
                const hush = /^(?:shut\s*up|be\s+quiet|quiet|shush|hush)$/.test(bare);
                const done = /^stop(?:\s+(?:talking|it))?$/.test(bare);
                if (hush || (done && !answeringBrain && !proformaOpen)) {
                    console.log(`[VOICE] "${bare}" is a dismissal — not asking anyone`);
                    return res.json({ ok: true, agent: route.agent, agent_name: agent.name, voice: agent.voice,
                        routed_because: 'dismissal', answer: 'Okay.', spoken: 'Okay.', cards: null, awaiting: false });
                }
            }

            // ── "STOP ANNOUNCEMENTS" / "ANNOUNCEMENTS ON" ────────────────
            // The switch for Jarvis speaking up on its own. The setting
            // lives in her browser (dashboard/voice.js); this only answers
            // and tells the page which way to flip it.
            {
                const flip = require('./helpers/announcements').toggleIn(stripped);
                if (flip) {
                    return answering({
                        agent: 'jarvis', agent_name: AGENTS.jarvis.name, voice: AGENTS.jarvis.voice,
                        routed_because: 'announcements ' + flip,
                        answer: flip === 'off'
                            ? "Okay — I won't speak up on my own until you say \"announcements on\"."
                            : "Okay — I'll speak up when something needs you.",
                        announce: flip === 'on', ok: true, cards: null, awaiting: false,
                    });
                }
            }

            // ── "OPEN THE BILLS" ─────────────────────────────────────────
            // Apsara, 2026-09-20. Only on an explicit navigation verb — see
            // helpers/screens.js — and only within the answering assistant's
            // own company: Jarvis will not open a yard screen, Scout will not
            // open a Metals one. Not while a proforma is mid-question, where
            // "open …" could be her answer to it.
            if (!proformaOpen) {
                const screens = require('./helpers/screens');
                const scr = screens.match(stripped);
                if (scr) {
                    const no = screens.refusal(scr, route.agent);
                    console.log(`[VOICE] navigation: ${scr.key}${no ? ' — refused, other company' : ''}`);
                    return answering({
                        agent: route.agent, agent_name: agent.name, voice: agent.voice,
                        routed_because: 'navigation',
                        answer: no || `Opening ${scr.label}.`, ok: !no,
                        open: no ? null : screens.toOpen(scr), cards: null, awaiting: false,
                    });
                }
            }

            // ── SCOUT NEVER SEES EDGE METALS ─────────────────────────────
            // Apsara, 2026-09-19: "when i ask scout what are the loads that
            // we have taken yesterday - it should not show edge metal loads.
            // its scope is strictly restricted to edge yard".
            //
            // The router sent that question to Scout correctly. What showed
            // Edge Metals was everything BELOW this point: the forward
            // offers, the reference resolver, the proforma flow and the
            // bookings panel all ran first, on every question, and the
            // bookings panel answered before the Scout branch was reached —
            // a Metals booking list, in Scout's colour. Scout's own answer
            // also carried that Metals panel along with it.
            //
            // So Scout is answered HERE, before any Edge Metals machinery
            // looks at the sentence, and with no panel. The resolver is
            // skipped too: "that booking" resolves against Jarvis's bookings,
            // which are exactly what Scout must not be handed.
            if (route.agent === 'scout' && !proformaOpen) {
                const { askYard } = require('./helpers/yardAsk');
                mem.remember('user', stripped);
                const out = await askYard(stripped, { history: mem.history(), role: req.role });
                try {
                    require('./helpers/yardChatLog').logExchange({
                        question: stripped, answer: out && out.answer,
                        have_data: out && out.have_data, ok: out && out.ok,
                        role: req.role || null, source: 'voice',
                    });
                } catch (e) { /* never let logging break answering */ }
                mem.remember('bot', out && out.answer);
                return answering({
                    agent: 'scout', agent_name: agent.name, voice: agent.voice,
                    routed_because: route.why,
                    answer: out && out.answer, proposal: (out && out.proposal) || null,
                    ok: !!out && out.ok !== false,
                    cards: null,
                });
            }

            const ref = await mem.resolveSmart(stripped);
            let asked = ref.text;

            // ── "WANT ME TO FORWARD IT?" — AND THEN SHE SAYS YES ─────────
            // Apsara, 2026-09-08: "it asks me do you want me to forward it.
            // when i say Yes, it just shows that earliest cut off is and does
            // nothing."
            //
            // The offer at the end of every list summary is MY sentence. She
            // asked for that shape on 2026-09-06 ("they will say yes boss, we
            // have 3 bookings available, earliest cutoff is next wednesday.
            // You want me to forward that?") and I wrote the words and never
            // wired the answer. So Jarvis has been asking a question with
            // nowhere to put the reply for two days, and her "yes" fell
            // through to the follow-up answerer, which quite reasonably tried
            // to look up a field called "yes".
            //
            // An assistant that asks a question it cannot receive an answer to
            // is worse than one that does not ask: it invites her to speak and
            // then discards what she says.
            //
            // WHY A CLOSED-CLASS LIST IS THE RIGHT TOOL *HERE*, having spent
            // today arguing against exactly that: this is a POLAR ANSWER to a
            // POLAR QUESTION. "Yes", "no", "go ahead" are discourse particles
            // — English grammar, not freight vocabulary — so the list cannot
            // go stale as her business changes, which was the whole objection.
            // And it fails safe: anything it does not recognise is not treated
            // as an answer at all and carries on to normal handling.
            // Set when her answer to an offer has been rewritten into the
            // instruction she meant. The order check further down reads the
            // ORIGINAL words ("yes"), which name no action — so without this
            // the rewrite happens and is then answered from the table anyway.
            let rewrittenAsOrder = false;
            const offer = mem.lastOffer ? mem.lastOffer() : null;

            // ── SHE NAMES THE FORWARDER ─────────────────────────────────
            // The answer to "want me to ask a forwarder for space?". Whatever
            // she says next is the name — "zimex", "ask zimex", "yes, zimex" —
            // and it is turned into the sentence the existing booking-request
            // flow already understands. From there it is helpers/
            // bookingRequest.js and draftEmailForConfirm: how many containers,
            // a draft in her own writing style, and nothing sent until she
            // says yes.
            //
            // Rewritten rather than reimplemented. Everything after this point
            // has been working since 2026-09-06 and carries its own scar
            // tissue — a hallucinated recipient and an invented body, both
            // caught live in August and both guarded there. Routing into it is
            // the whole point.
            if (offer && offer.kind === 'ask_forwarder') {
                const NO = /^\s*(?:no|nope|not now|later|leave it|don'?t|nothing)\b/i;
                if (NO.test(stripped)) {
                    if (mem.clearOffer) mem.clearOffer();
                    const said = 'Right, leaving it.';
                    mem.remember('bot', said);
                    return answering({
                        agent: route.agent, agent_name: agent.name, voice: agent.voice,
                        routed_because: 'declining the offer',
                        answer: said, cards: null, awaiting: false,
                    });
                }
                // The name, with the wrapping she might put around it. Left
                // deliberately loose: anything that is not a refusal is a
                // forwarder's name, because that is the only thing the
                // question invited. A wrong name fails visibly at the contact
                // lookup, which then asks — it does not send anything.
                const who = stripped
                    .replace(/^\s*(?:yes|yeah|sure|ok(?:ay)?|please)\b[,.\s]*/i, '')
                    .replace(/^\s*(?:ask|email|mail|send (?:a )?(?:mail|email) to|write to)\b\s*/i, '')
                    .replace(/[.!?]+\s*$/, '')
                    .trim();
                if (who) {
                    if (mem.clearOffer) mem.clearOffer();
                    // ── THE PORT GOES IN FRONT, AND THAT IS NOT COSMETIC ──
                    // "...asking for a booking from HOUSTON" was claimed by the
                    // brain's own location rule — `bookings? (from|at|in) (.+)$`
                    // anchored to the END of the sentence — so Jarvis answered
                    // its own instruction with a list of Houston bookings.
                    //
                    // A sentence Jarvis writes for itself has to survive its own
                    // parsers. Third time this week: the reference resolver
                    // produced "booking HOU111 HOU111", the forward pattern
                    // could not read "booking HOU111 to X", and now this.
                    //
                    // "space out of HOUSTON" still satisfies
                    // bookingRequest.isRequest — ASKING matches "asking",
                    // FOR_A_BOOKING matches "space" — without ending in the
                    // shape the location rule is looking for.
                    // AND A COMMA AFTER THE NAME, which is also not cosmetic.
                    // "to zimex asking for space" made the recipient "zimex
                    // asking", with an address invented to match — the name
                    // extraction takes up to two words and "asking" was the
                    // second. The draft went to a contact that does not exist.
                    // A comma ends the name.
                    asked = `send a mail to ${who}, asking for space out of ${offer.port}`;
                    // AND THE PORT AGAIN, THIS TIME AS A FACT. The sentence
                    // above still has to read like a request so isRequest sees
                    // it, but the port in it is English and English is what
                    // keeps getting reinterpreted on the way through. This is
                    // the copy the draft actually uses — see voiceMemory's
                    // setRequestPort for why it is single-use.
                    if (mem.setRequestPort) mem.setRequestPort(offer.port);
                    rewrittenAsOrder = true;
                    console.log(`[VOICE] asking ${who} for space at ${offer.port} — "${asked}"`);
                }
            }

            // ── "WHICH ONE?" → "1" ──────────────────────────────────────
            // The turn after Jarvis lists them. An ordinal here is a choice
            // from THAT list, not a booking number and not a follow-up, and
            // it has to be read before anything else gets an opinion — the
            // same rule as her answer to "which port?".
            if (offer && offer.kind === 'forward' && offer.asked_which) {
                // helpers/pickFromList, so "one" and "the first one" work here
                // too. Numbers ONLY had been the rule, and she reported
                // exactly that gap for the trucker list on the same day — a
                // third hand-rolled picker would have been a third place for
                // it to be wrong.
                const numbers = (offer.rows || []).map((r) => r.booking_number).filter(Boolean);
                const chosen = numbers.length
                    ? (offer.rows || []).find((r) => r.booking_number
                        === require('./helpers/pickFromList').pick(stripped, numbers))
                    : null;
                if (chosen && chosen.booking_number) {
                    if (mem.clearOffer) mem.clearOffer();
                    asked = `forward ${chosen.booking_number}`;
                    rewrittenAsOrder = true;
                    // Logs what she SAID rather than a parsed index. `n` was
                    // the old digit match and no longer exists — a leftover
                    // reference in a log line, which threw only on the exact
                    // path it was describing. Printing her words is more
                    // useful anyway: "one" and "1" and "the first one" all
                    // land here and the log should say which.
                    console.log(`[VOICE] "${stripped}" picked ${chosen.booking_number} from the offer`);
                }
            } else if (offer && offer.kind === 'forward') {
                const YES = /^\s*(?:yes|yeah|yep|yup|sure|ok(?:ay)?|please(?: do)?|go ahead|do it|forward it|that one)\b/i;
                const NO = /^\s*(?:no|nope|not now|later|leave it|don'?t)\b/i;
                if (YES.test(stripped)) {
                    if (mem.clearOffer) mem.clearOffer();
                    // ONE row, one meaning. With several on screen "yes" says
                    // she wants a forward, not WHICH — and picking for her is
                    // the guess this whole file exists to avoid, with a real
                    // truck at the end of it.
                    if (offer.rows && offer.rows.length === 1 && offer.rows[0].booking_number) {
                        asked = `forward ${offer.rows[0].booking_number}`;
                        rewrittenAsOrder = true;
                        console.log(`[VOICE] "yes" answers the offer — ${asked}`);
                    } else if (offer.rows && offer.rows.length > 1) {
                        const list = offer.rows.slice(0, 8)
                            .map((r, i) => `${i + 1}. ${r.booking_number}`).join('  ');
                        const said = `Which one? ${list}`;
                        // The offer stays live, now waiting on WHICH — or her
                        // "1" next turn has nowhere to land, which is the very
                        // bug being fixed, one question deeper.
                        if (mem.setOffer) mem.setOffer({ kind: 'forward', rows: offer.rows, asked_which: true });
                        mem.remember('bot', said);
                        return answering({
                            agent: route.agent, agent_name: agent.name, voice: agent.voice,
                            routed_because: 'which booking to forward',
                            answer: said, cards: null, awaiting: true,
                        });
                    }
                } else if (NO.test(stripped)) {
                    if (mem.clearOffer) mem.clearOffer();
                    const said = 'Right, leaving it.';
                    mem.remember('bot', said);
                    return answering({
                        agent: route.agent, agent_name: agent.name, voice: agent.voice,
                        routed_because: 'declining the offer',
                        answer: said, cards: null, awaiting: false,
                    });
                } else if (mem.clearOffer) {
                    // She said something else entirely. The offer lapses
                    // quietly — an offer she ignored is not a question she
                    // still owes an answer to, and nagging about it is how
                    // "you already have a pending X" got written.
                    mem.clearOffer();
                }
            }
            if (ref.resolved) {
                console.log(`[VOICE] "${ref.resolved.from}" → booking ${ref.resolved.to} (#${ref.resolved.n})`);
            } else if (ref.ambiguous) {
                // Refuses rather than guesses. The next step of this flow
                // sends a WhatsApp to a real driver, and "that booking" with
                // three on screen is a genuine ambiguity — the same refusal
                // the brain already makes for a bare digit with two possible
                // sources.
                mem.remember('user', stripped);
                // Ask in HER vocabulary, not mine. Telling someone to say
                // "the first one" is telling them the phrase I happen to
                // parse — the exact thing she objected to. Offer what
                // actually tells the rows apart: the carrier, the port, the
                // vessel. Whichever field differs between them.
                const which = `Which one — there are ${ref.ambiguous} on screen. `
                    + (mem.distinguishers() || 'Give me the booking number.');
                mem.remember('bot', which);
                return answering({
                    agent: route.agent, agent_name: agent.name, voice: agent.voice,
                    routed_because: 'a reference I could not pin down',
                    answer: which, ok: true, cards: null,
                });
            }
            mem.remember('user', asked);

            // ── BUILDING A PROFORMA BY BEING ASKED ───────────────────────
            // Apsara: "if i ask jarvis to create proforma, it should create
            // that .. it can ask whatever data is needed from me."
            //
            // Consulted BEFORE the router, because a proforma in progress
            // owns the conversation: while it is open, "Daekwang" is an
            // answer to a question, not a question about a seller. Routed
            // normally it scores as yard vocabulary, reaches Scout, and she
            // gets "no loads for Daekwang" in the middle of raising an
            // invoice.
            //
            // The DECISION is in helpers/proformaDraft.handle(), not here.
            // It was inline, and two mutations survived the whole suite
            // because the only test that touched it read the source rather
            // than running it — turning the flow off completely, and
            // restarting the draft on every answer so it could never finish.
            // api.js keeps the plumbing; the module keeps the thinking.
            const pro = require('./helpers/proformaDraft');

            // ── ONE DYNAMIC READ OF WHAT SHE MEANT, USED BY BOTH BRANCHES ─
            // Apsara, 2026-09-07: "no no jarvis, trade terms should be like
            // this it should update. just like jarvis in iron man."
            //
            // park / resume / amend / none, decided by a model with the live
            // draft and the outstanding question in front of it — see
            // helpers/draftIntent.js. Called ONCE, up here, because the
            // amendment branch below and the parking branch further down are
            // two consequences of the same judgement and asking twice would
            // double the wait she is standing through mid-sentence.
            //
            // Gated inside classify() on a proforma being open or parked, so
            // it costs nothing on every other utterance.
            const transition = await require('./helpers/draftIntent')
                .classify(asked, pro.transitionState());

            // ── "JARVIS IGNORE THAT, I MADE A MISTAKE" ───────────────────
            // Apsara, 2026-09-07. The reasoning, the papers and the Alexa
            // comparison are in helpers/repair.js; the short version is that
            // Heeman & Allen measured only 13.9% of real repairs carrying an
            // editing term, so a keyword list misses six in seven by
            // construction — and Amazon's own AMAZON.CancelIntent is exactly
            // such a list.
            //
            // CHECKED BEFORE THE AMENDMENT AND THE DRAFT, because a
            // retraction is about the sentence BEFORE this one, and anything
            // that absorbs it first will read "ignore that" as a value.
            //
            // It is the CALLER's job to decide whether anything is actually
            // retractable, so the scope below is matched against what is
            // really open rather than trusted on its own.
            const repair = require('./helpers/repair');
            const repairState = pro.transitionState();
            const scope = await repair.classify(asked, {
                task: repairState.summary || (brainPending
                    ? require('./helpers/pendingLabel').describePending(brainPending.type) : ''),
                question: repairState.question || null,
                // The sentence BEFORE this one — the reparandum, in Heeman &
                // Allen's terms. Without it the model is judging "ignore
                // that" with no idea what "that" was.
                lastValue: mem.previousUser ? mem.previousUser() : null,
            });
            if (scope !== 'none') {
                const hadDraft = repairState.open || repairState.parked;
                const hadPending = !!brainPending;
                let said = '';
                if (!hadDraft && !hadPending) {
                    // NOTHING TO TAKE BACK. Said out loud rather than
                    // accepting the instruction and doing nothing, which
                    // reads to her as done.
                    said = repair.nothingToUndo(scope, null);
                } else if (scope === 'undo' && repairState.open) {
                    const back = pro.undoLast();
                    said = back
                        ? repair.confirm('undo', back.changed.join(', ')) + ' ' + back.summary
                        : repair.nothingToUndo('undo', null);
                } else {
                    // cancel and restart both drop what is in flight. The
                    // pending goes FIRST: a draft cleared while its
                    // confirmation is still standing leaves a "yes" that
                    // would confirm a document that no longer exists.
                    const what = repairState.summary || (brainPending
                        ? require('./helpers/pendingLabel').describePending(brainPending.type) : '');
                    if (hadPending) {
                        try {
                            await require('./workflow/actions').clearPending(
                                `${(cfg.getSettings().manager_number || cfg.MANAGER_NUMBER)}@c.us`);
                        } catch (e) {
                            console.error('[REPAIR] could not clear the pending:', e.message);
                        }
                    }
                    pro.clear();
                    try { pro._clearParked(); } catch (e) {}
                    said = repair.confirm(scope, what);
                }
                // ── AND THE SENTENCE ITSELF STOPS EXISTING ───────────────
                // Apsara, 2026-09-09, with the Iron Man reference: "No
                // no..delete that..it should delete my previously transcibed
                // sentence /words na?"
                //
                // She is right, and until now it did not. Everything above
                // clears the TASK — the pending, the draft, the parked one —
                // and the retracted sentence stayed in short-term memory. So
                // Jarvis said "taken back" while "that" still resolved to it
                // and the model was still handed it as context next turn. An
                // assistant that reports forgetting something it kept is
                // worse than one that cannot forget at all, because she stops
                // checking.
                //
                // ONLY when there was genuinely something to retract. On the
                // nothingToUndo path she is being TOLD there was nothing, and
                // quietly eating a turn while saying so would be its own
                // small lie.
                //
                // Working memory only — her choice, asked directly, and the
                // right one. The saved day log is untouched: it is what
                // reconstructs an incident afterwards, and a voice command
                // that erases records is not a thing to own.
                let forgot = 0;
                if (hadDraft || hadPending) {
                    try { forgot = mem.forgetLastExchange ? mem.forgetLastExchange() : 0; }
                    catch (e) { console.error('[REPAIR] could not forget the retracted turn:', e.message); }
                }
                console.log(`[REPAIR] ${scope}: "${asked}" — ${said}${forgot ? ` (forgot ${forgot} turn(s))` : ''}`);
                return answering({ ok: true, answer: said, agent: 'jarvis', agent_name: 'Jarvis', repaired: scope, forgot });
            }

            // ── "WAIT. CHANGE THESE AND CREATE" ──────────────────────────
            // Apsara, 2026-09-07: "what if i want change in cif and payment
            // terms. if i say wait.change these andccreate, how jarvis would
            // take that?"
            //
            // Badly. The staged proforma is a yes/no question, and a
            // correction is neither — so it fell past the brain's yes/no
            // policy into the general AI classifier, with a confirm_proforma
            // pending still open. Exactly the failure workflow/brain.js
            // already documents for "schedule this mail" arriving during an
            // await_email_confirm.
            //
            // An amendment outranks the confirmation it amends: the document
            // she is being asked about no longer exists in that form, so the
            // pending is torn down BEFORE the draft is re-opened. Leaving it
            // would mean a later "yes" confirming the version she just
            // changed — a document sent with the terms she rejected.
            let amended = false;
            if (answeringBrain && brainPending && brainPending.type === 'confirm_proforma'
                && pro.isStaged() && pro.isAmendment(asked, { intent: transition })) {
                try {
                    await require('./workflow/actions').clearPending(
                        `${(cfg.getSettings().manager_number || cfg.MANAGER_NUMBER)}@c.us`);
                    amended = true;
                    console.log(`[PROFORMA] amendment during confirm: "${asked}" — pending torn down`);
                } catch (e) {
                    // Could not clear it: do NOT reopen the draft. Two live
                    // versions of one document is worse than making her say
                    // "no" first.
                    console.error('[PROFORMA] could not tear down the pending, leaving the confirm standing:', e.message);
                }
            }

            // A brain question outranks a proforma draft: the brain's are
            // the ones with a WhatsApp to a driver behind them. An amendment
            // to the brain's OWN proforma question is the one exception, and
            // it is narrow: the pending had to be a proforma, the draft had
            // to be staged, and the sentence had to carry both a correction
            // cue and a real field value.
            // ── PARKING OUTRANKS AN OPEN BRAIN QUESTION ──────────────────
            // Apsara, 2026-09-07: "can i just say lets hold this and work on
            // email?"
            //
            // "Hold this" while a confirm_proforma is staged has to reach the
            // draft, not the brain — the brain would read it as an answer to
            // "Send it to Daekwang?" and the AI classifier would guess. Same
            // narrow exception as an amendment, and for the same reason: it
            // is a statement ABOUT the proforma, not an answer to its
            // question.
            //
            // ── AND IT IS DECIDED DYNAMICALLY, NOT BY A WORD LIST ────────
            // Apsara, 2026-09-07: "As per my command, it has to work
            // dynamically." The command is "i dont want any fixed intent",
            // and two regexes covering six phrasings broke it. The decision
            // now goes to a model with the live draft and the outstanding
            // question in front of it — see helpers/draftIntent.js for why
            // this is a safe place for one and the amendment lock above is
            // not. The patterns survive as the offline net and as a fast
            // path, so an unreachable Gemini degrades to today's behaviour
            // rather than to silence.
            //
            // Gated on a proforma being open or parked, so this costs nothing
            // on every other utterance — and cannot form an opinion about
            // "yes, Sher Trucking" during a trucker confirmation.
            const parking = transition === 'park' || transition === 'resume';
            // "generate invoice for the Inesh container" (2026-09-21) is a
            // COMMERCIAL invoice from the ledger, not a proforma — the brain
            // owns it. Only when no proforma is open or staged, so an answer
            // inside a draft is never taken away from it.
            let saleInvoiceAsk = false;
            try {
                saleInvoiceAsk = !pro.current() && !pro.isStaged()
                    && !!require('./helpers/saleInvoiceFlow').saleInvoiceRequest(asked);
            } catch (e) { saleInvoiceAsk = false; }
            const step = ((answeringBrain && !amended && !parking) || saleInvoiceAsk)
                ? null : pro.handle(asked, { transition });

            // The confirm is over — sent, or cancelled — so a staged draft is
            // finished with. Without this it stays alive and a much later
            // "actually make it FOB" would resurrect a proforma that was
            // already emailed to a customer.
            if (!brainPending && !step && pro.isStaged() && !parking) pro.clear();
            if (step) {
                let previewHtml = null;
                // Declared out here, not inside the staging block, so the
                // response can carry it. `let` inside the try would be out of
                // scope by the time the JSON is built — and the number would
                // simply be missing from the panel header with nothing
                // logged, which is the silent-failure shape I keep hitting.
                let stagedInvNo = null;
                let nums = null;
                let numsError = null;

                // ── THE NUMBERS ARE MINTED BEFORE THE PREVIEW IS DRAWN ───
                // Apsara, 2026-09-07: "both invoice nd container no - not
                // updated."
                //
                // They were minted AFTER. The preview was built from
                // pdfPayload() called with NO ARGUMENTS, so inv_no defaulted
                // to '' and the single container block carried container_no:
                // ''. The numbering worked perfectly the whole time and
                // simply never reached the document she was looking at.
                //
                // A preview showing blanks where the two identifying numbers
                // go is worse than no preview: it is a document that looks
                // wrong for a reason she cannot see.
                if (step.stage === 'preview' && step.draft) {
                    try {
                        nums = await require('./workflow/actions')
                            .prepareProformaNumbers(step.draft);
                    } catch (e) {
                        // REPORTED, not swallowed. prepareProformaNumbers has
                        // its own bare catch around the sheet lookup, so a
                        // broken INVOICE_SHEET_ID or a renamed column comes
                        // back as empty numbers and no explanation — which is
                        // exactly what "not updated" looks like from her side.
                        numsError = e.message;
                        console.error('[PROFORMA] could not mint the numbers:', e.message);
                    }
                }
                if (step.stage === 'preview') {
                    // The SAME generator her existing proformas go through.
                    // A preview rendered by a different path is not a preview
                    // of what will be sent.
                    try {
                        // Rebuilt WITH the numbers rather than using step.pdf,
                        // which handle() produced before they existed.
                        const withNums = pro.pdfPayload({
                            inv_no: (nums && nums.invNo) || '',
                            containerNos: (nums && nums.containerNos) || [],
                            addressLines: (nums && nums.addressLines) || [],
                        });
                        const built = require('./helpers/proformaPdf')
                            .buildProformaDc2Html(withNums || step.pdf);
                        previewHtml = built && built.html ? built.html : null;
                    } catch (e) {
                        console.error('[PROFORMA] preview failed:', e.message);
                    }
                }

                // ── HANDING IT TO THE CODE THAT ALREADY SENDS ────────────
                // Apsara: "it should be able to send the proforma in mail."
                //
                // It could not. The preview said 'say "send it" when you are
                // happy' and nothing consumed "send it" — the draft simply
                // re-previewed itself for ever. My test asserted the preview
                // CONTAINED the string "send it", which tested only that the
                // lie was spelled correctly.
                //
                // No second sender is written here. The voice flow stages the
                // SAME `confirm_proforma` pending the email flow stages, and
                // her "yes" is resolved by workflow/actions.js's existing
                // resolvePending → generateProformaFromPending, which builds
                // the PDF, archives it, records the price, logs the sheet and
                // emails it. One path, one set of rules.
                //
                // Once staged, `answeringBrain` is true on the NEXT utterance
                // (there is now a pending), so the guard above sends her "yes"
                // straight to the brain. That is the whole handover.
                if (step.stage === 'preview' && step.ready && step.draft) {
                    try {
                        const acts = require('./workflow/actions');
                        const chatId = `${(cfg.getSettings().manager_number || cfg.MANAGER_NUMBER)}@c.us`;
                        // Invoice number, container numbers and the postal
                        // address come from her real invoice history and
                        // address book — the SAME helper the email path uses,
                        // so a proforma raised by voice is not a different
                        // document from one raised from an order.
                        // Already minted above, before the preview. Minting
                        // again would spend a second sheet fetch AND could
                        // hand her a different number from the one on screen.
                        if (!nums) nums = await acts.prepareProformaNumbers(step.draft);
                        await acts.setPending(chatId, {
                            type: 'confirm_proforma',
                            draft: step.draft,
                            invNo: nums.invNo,
                            containerNos: nums.containerNos,
                            addressLines: nums.addressLines,
                            replyTo: step.recipient.email,
                            subject: '',
                            who: step.recipient.name,
                        });
                        // KEPT, not cleared — but marked staged, which makes it
                        // inert. I cleared it here first and wrote a comment
                        // admitting the cost ("she starts the proforma over
                        // rather than amending it"); she read the preview and
                        // asked about that exact case in one go. Shipping a
                        // known bad edge because it was documented is not the
                        // same as fixing it.
                        //
                        // Staged means: answer a correction or a brand-new
                        // proforma, and NOTHING else. So it can be amended,
                        // but an ordinary sentence can never quietly redraw a
                        // document that is sitting in front of her.
                        pro.markStaged();
                        // An address-book warning is the one thing that must
                        // survive the hand-off — a proforma going out with no
                        // address on it is not something to discover later.
                        if (nums.addressWarning) {
                            step.say += ` One thing: ${nums.addressWarning}`;
                        }
                        stagedInvNo = nums.invNo || null;
                        if (nums.invNo) step.say += ` It'll be ${nums.invNo}.`;
                        // SAID OUT LOUD when there is no number. Silence here
                        // is indistinguishable from a number she did not catch,
                        // and the document would go out with the field blank.
                        else step.say += ' I could not work out the invoice number'
                            + (numsError ? ` — ${numsError}`
                                : nums.numbersWarning ? ` — ${nums.numbersWarning}`
                                : ' — the sheet had no earlier invoice for them')
                            + ', so it will go out blank unless you give me one.';
                    } catch (e) {
                        // Staging failed: say so rather than leaving her with a
                        // preview that looks ready and a "yes" that lands
                        // nowhere. That silence is the bug being fixed here.
                        console.error('[PROFORMA] could not stage the send:', e.message);
                        step.say = `${step.summary} I built it, but I couldn't set up the send: ${e.message}. It's in Documents > Saved.`;
                    }
                }

                mem.remember('bot', step.say);
                return answering({
                    agent: 'jarvis', agent_name: agent.name, voice: agent.voice,
                    routed_because: 'building a proforma',
                    answer: step.say, ok: true, cards: null,
                    proforma: {
                        stage: step.stage,
                        summary: step.summary || null,
                        fields: step.fields || step.have || null,
                        defaulted: step.defaulted || null,
                        html: previewHtml,
                        // Apsara, 2026-09-07: "show preview. post my
                        // confirmation..send". The dashboard needs to know
                        // whether this document CAN be sent, so the footer
                        // offers Send only when a "yes" would actually do
                        // something — a Send button on a proforma with no
                        // recipient is a button that lies.
                        ready: step.ready === true,
                        blocked: step.blocked || null,
                        recipient: step.recipient
                            ? { name: step.recipient.name || step.recipient.who || null,
                                email: step.recipient.email || null }
                            : null,
                        // Shown in the panel header. Minted at hand-off, so
                        // it is present on a ready preview and absent while
                        // she is still being asked questions.
                        inv_no: stagedInvNo,
                    },
                });
            }

            // ── THE SCREEN ───────────────────────────────────────────────
            // Apsara, 2026-09-06: "like JARVIS in iron man, a screen should
            // appear, where it shows me all relevant answer to my question
            // as jarvis is talking back."
            //
            // Looked up from the question, from the same store the answer
            // comes from — NOT parsed out of what Jarvis says. A regex over
            // the reply would lose rows silently the moment the wording
            // changed, and a table that is confidently incomplete is worse
            // than no table.
            //
            // Never allowed to break the answer. A panel is an extra; a
            // missing panel is a worse screen, a thrown exception is no
            // answer at all.
            // ── A FOLLOW-UP IS ANSWERED FROM WHAT WAS JUST SAID ──────────
            // Apsara, 2026-09-06: "Everytime when i say hey jarvis, it is
            // like restarting all over again without any idea about context
            // memory .. if i say, when is the next cut off, it should answer
            // that."
            //
            // It restarted because every question went to a language model
            // with a fresh prompt, and the brain's transcript records what
            // she SAYS and never what it REPLIED — so a follow-up arrived
            // with nothing to attach to.
            //
            // A person who has just read out three bookings does not
            // re-derive them to answer "and the ERD?". They look at the same
            // list. helpers/voiceMemory.js is keeping that list; this reads
            // the answer straight off it — no model, no round trip, and no
            // possibility of inventing a date, which matters because the
            // next sentence is usually "forward that".
            //
            // Returns null for anything it does not recognise, and that
            // falls through to the assistants as before. A confident wrong
            // answer about a cutoff is worse than a slower right one.
            const fu = require('./helpers/followUp');
            const refSet = mem.currentReferents();
            // ── NO FIXED INTENTS ─────────────────────────────────────────
            // Apsara: "i dont want any fixed intent."
            //
            // fu.answer() asks the MODEL, handing it the rows already on her
            // screen with the dates pre-converted, and falls back to the
            // offline patterns only if the model is unreachable. So it can
            // answer questions nobody anticipated, in her words — while the
            // one thing that must not be guessed, WHICH booking she means,
            // stays deterministic in helpers/voiceMemory.js.
            // ── AN ORDER IS NEVER ANSWERED FROM THE TABLE ────────────────
            // Apsara, 2026-09-08: "when i ask it to forward the booking,
            // instead of getting into forwarding process, it just shows cut
            // off for the booking is in 7 days."
            //
            // fu.answer() hands her sentence and the rows on screen to the
            // model and asks it to answer from them. Asked to answer "forward
            // the booking" out of a table, a model does the most helpful thing
            // available to it and reads out a field. It is not wrong — it was
            // asked the wrong question.
            //
            // The instruction check existed already, thirty lines below, and
            // it was too late: `quick` returns before anything looks at it.
            // Deciding whether she gave an ORDER has to come before deciding
            // how to ANSWER her, because an order is not a question and there
            // is nothing in the table that could satisfy it.
            //
            // Same shape as every other bug this week: a fact (she said
            // "forward") was available and the model's opinion got there
            // first. Facts veto; the model refines.
            const acEarly = require('./helpers/answerCards');
            const looksLikeOrder = rewrittenAsOrder || acEarly.IS_INSTRUCTION.test(stripped);
            const quick = (answeringBrain || looksLikeOrder || brainOwns)
                ? null            // her answer belongs to whoever asked
                : await fu.answer(asked, refSet, ref.resolved && ref.resolved.row);
            if (looksLikeOrder && refSet) {
                console.log(`[VOICE] "${stripped}" is an order — not answering it from the list`);
            }

            // ── WHO DECIDES SHE IS STILL ON THE SAME SUBJECT ─────────────
            // Apsara, 2026-09-07: "WHy cant it handle that .. we are using ai
            // only right?"
            //
            // She was right to ask. This decision used to be a regex over nine
            // nouns, taken BEFORE the model was consulted at all — the model
            // was only ever asked to ANSWER, and when it could not, the code
            // concluded she had changed subject and redrew her list. "I cannot
            // answer this" is not evidence about what she meant.
            //
            // fu.answer now asks it directly, in the same call, so it costs
            // nothing. Order of authority:
            //   1. a PRONOUN THAT RESOLVED — she pointed at a row on screen.
            //      Deterministic and not open to opinion.
            //   2. what the model said about her sentence.
            //   3. the patterns, when the model did not say — offline, or a
            //      reply that left the field out.
            const ac = require('./helpers/answerCards');
            const modelSaysRows = fu.lastAboutTheseRows();
            // AND NEVER AN INSTRUCTION. "forward HOU111 to Sher Trucking" is
            // about the rows on screen — the model says so, correctly — but
            // it is an ORDER, not a question, and answering it here instead
            // of acting on it means a driver never hears about a booking.
            // Checked on BOTH paths, because the model's yes is what made
            // this reachable at all.
            // ── FACTS VETO, THE MODEL REFINES ────────────────────────────
            // The first version let `modelSaysRows === true` short-circuit
            // everything, and it swallowed "what bookings are there from
            // oakland" — she named a DIFFERENT PORT, which is a fact about
            // her words, and no model opinion should be able to overrule it.
            // The same short-circuit swallowed "forward HOU111 to Sher
            // Trucking", which is an order, not a question.
            //
            // So the deterministic checks are a NECESSARY condition and the
            // model refines within them:
            //   · an order is never a follow-up question
            //   · naming a new port, a booking number, or asking for the list
            //     is a new subject, whatever the model thinks
            //   · a resolved pronoun forces a follow-up, whatever it thinks
            //   · otherwise the model may still say she has moved on
            // rewrittenAsOrder FIRST: when she answers an offer, the words she
            // said are "yes" or "1", which name no action — but what will
            // actually be executed is "forward HOU111". Judging the original
            // words here left the rewrite in place and then routed it as a
            // follow-up anyway, so the instruction was built and thrown away.
            const isOrder = rewrittenAsOrder || ac.IS_INSTRUCTION.test(stripped);
            const patternSaysFollowUp = ac.isFollowUp(stripped, refSet);
            const followingUp = !answeringBrain && !isOrder && !brainOwns && (
                !!ref.resolved
                || (patternSaysFollowUp && modelSaysRows !== false)
            );
            if (followingUp) {
                console.log(`[VOICE] still on the ${refSet.rows.length} row(s) on screen`
                    + ` (${ref.resolved ? 'she pointed at one' : modelSaysRows === true ? 'the model says so' : 'pattern'})`);
            }
            if (quick) {
                console.log(`[VOICE] follow-up answered from the list: ${asked}`);
                mem.remember('bot', quick);
                // The follow-up answer moves the center too, so a THIRD
                // question ("and its vessel?") lands on the same booking.
                // Deterministic: the center moves only when the answer names
                // exactly one booking that is on screen. Two names, or none,
                // and it stays where it was rather than picking one.
                try {
                    if (refSet && Array.isArray(refSet.rows)) {
                        const named = refSet.rows.filter(
                            (r) => r.booking_number && quick.indexOf(r.booking_number) !== -1);
                        if (named.length === 1) mem.setCenter(named[0]);
                        else if (ref.resolved && ref.resolved.row) mem.setCenter(ref.resolved.row);
                    }
                } catch (e) { /* centring is a convenience, never a failure */ }
                return answering({
                    agent: route.agent, agent_name: agent.name, voice: agent.voice,
                    routed_because: 'following on from what you just asked',
                    answer: quick, ok: true,
                    // The panel stays exactly as it was. Redrawing it under
                    // her mid-conversation is how "the first one" comes to
                    // mean a different booking.
                    cards: null,
                });
            }

            // ── AND A FOLLOW-UP NOBODY COULD ANSWER SAYS SO ──────────────
            // Once the list stopped being redrawn, "and the vessel" fell
            // through to the router instead — and with the model down it came
            // back EMPTY. Trading a repetition for silence is not a fix.
            //
            // A question about rows on her screen has no business reaching
            // the brain: the brain has no referent memory, cannot know what
            // "the vessel" refers to, and its best case is answering about
            // something else entirely. So this stops here, and names what it
            // could not find rather than saying nothing.
            if (followingUp && !quick) {
                const focus = (ref.resolved && ref.resolved.row) || mem.currentCenter();
                const who = focus && focus.booking_number ? ` on ${focus.booking_number}` : '';
                console.log(`[VOICE] follow-up unanswered: "${asked}"${who}`);
                mem.remember('bot', 'not in what I have');
                return answering({
                    agent: route.agent, agent_name: agent.name, voice: agent.voice,
                    routed_because: 'following on from what you just asked',
                    answer: `I don't have that${who}. Ask me something else about it, or say the booking number.`,
                    ok: true,
                    // The panel stays exactly as it is. Clearing it here would
                    // take away the rows the question was about.
                    cards: null,
                });
            }

            let cards = null;
            const bq = require('./helpers/bookingQuery');
            // Set when the query is genuinely ambiguous about WHICH PORT and
            // she has to be asked. Null the rest of the time — asking a
            // question we already know the answer to is worse than not asking.
            let listAsk = null;
            // ── A FOLLOW-UP KEEPS THE LIST IT IS ABOUT ───────────────────
            // Apsara, 2026-09-07: "On follow up - why it keeps on saying the
            // same thing about booking."
            //
            // "and the vessel" contains a booking noun, so cardsFor built a
            // fresh table of ALL bookings and fu.opening() read the same
            // summary out again — and the referent set was replaced under
            // her, so the next "that booking" meant a different one. See
            // helpers/answerCards.isFollowUp for the rule.
            // ── THE MODEL FILLS THE FORM; THE CODE RUNS THE QUERY ────────
            // Apsara, 2026-09-08: "Why would i need to hard code it? Stupid..
            // Its an AI." and "first decide, then fix. dont just keep on
            // doing patch work."
            //
            // cardsFor() is a set of regexes over her sentence. It understands
            // "bookings from houston" and not "houston bookings"; it has never
            // understood "available" or "cutting off next week" at all, so the
            // panel it drew answered a WIDER question than she asked and
            // looked complete while doing it.
            //
            // helpers/bookingQuery.js replaces the understanding half with a
            // described schema the model fills — see the papers cited there.
            // cardsFor stays as the fallback, because it is the offline net
            // and a net is allowed to be dumb.
            try {
                // ── HER ANSWER TO "WHICH PORT?" COMES FIRST ──────────────
                // A one-word "houston" right after Jarvis asked which port
                // looks exactly like a follow-up to every heuristic in this
                // file — short, no verb, no booking noun. It is not a
                // follow-up; it is the missing slot, arriving. So an
                // outstanding question is checked BEFORE the follow-up
                // machinery gets a vote, which is also the only order that
                // makes asking worth doing: a question whose answer the
                // system cannot recognise is worse than no question.
                const outstanding = mem.lastQueryFrame && mem.lastQueryFrame();
                const answeringPort = !!(outstanding && outstanding.asked_port);
                // ── AND A PENDING QUESTION OUTRANKS ALL OF THIS ──────────
                // Apsara, 2026-09-08, walking the supplier flow: Jarvis asked
                // "which supplier?", she said "Oakland Metals", and the query
                // path claimed it — because the name contains a port word.
                // Her answer never reached the question that was waiting for
                // it, and Jarvis cheerfully redrew the Oakland list instead.
                //
                // `quick` has carried the comment "her answer belongs to
                // whoever asked" since the forward flow was built. This block
                // was added later and did not honour it. A rule that only
                // some of the code follows is not a rule.
                //
                // It is also the most dangerous shape here: the pending stays
                // open, so her NEXT sentence gets measured against a question
                // she believes she already answered.
                // rewrittenAsOrder: an instruction Jarvis built from her
                // answer is not a question to be parsed again. "send a mail to
                // zimex asking for a booking from HOUSTON" contains the words
                // "booking" and "houston", so the query path claimed it and
                // listed Houston bookings instead of writing the mail — the
                // sentence Jarvis wrote itself defeating the sentence Jarvis
                // wrote itself, which is the same shape as the resolver
                // rewriting "the booking" into a form its own parser could not
                // read on 2026-09-08.
                // ── AND THE SAME GUARD FOR THE SENTENCES SHE SAYS ────────
                // `rewrittenAsOrder` above protects exactly one sentence: the
                // one Jarvis composes for itself. Apsara, 2026-09-09, said the
                // same shape out loud — "send email to Wimax asking for
                // booking from Houston to Busan..." — and got a bookings
                // search with her whole sentence as its scope.
                //
                // Three separate places claimed that sentence: this one,
                // brain.js's offline location net, and localityMatchesPort's
                // substring test underneath both. Fixing one and stopping
                // would have moved the bug rather than removed it, which is
                // the "fix the fault, not the report" rule this codebase keeps
                // relearning. Same predicate in all three.
                let askingSomeone = false;
                try { askingSomeone = require('./helpers/bookingRequest').isRequestToSomeone(asked); }
                catch (e) { console.warn('[VOICE] booking-request veto check failed:', e.message); }
                if (askingSomeone) console.log(`[VOICE] "${String(asked).slice(0, 60)}" names someone to ask — not a query`);

                if (answeringBrain || rewrittenAsOrder || askingSomeone || brainOwns) {
                    cards = null;
                } else if (followingUp && !answeringPort) {
                    cards = null;
                } else {
                    const frame = await bq.parse(asked, {
                        prev: mem.lastQueryFrame ? mem.lastQueryFrame() : null,
                    });
                    if (frame) {
                        const result = bq.run(frame);
                        listAsk = bq.needsPort(frame, result);
                        // The frame is remembered either way, and remembers
                        // whether it left a question open — that flag is what
                        // lets her one-word answer be recognised next turn.
                        if (mem.setQueryFrame) {
                            mem.setQueryFrame({ ...frame, asked_port: !!listAsk });
                        }
                        cards = listAsk ? null : {
                            kind: 'bookings',
                            title: 'Bookings — ' + bq.describe(frame, result),
                            rows: ac.rowsFrom(result.rows),
                            scope: bq.describe(frame, result),
                            undated: result.undated,
                        };
                        if (cards && !cards.rows.length) cards = null;

                        // ── NOTHING AVAILABLE IS AN ANSWER, AND THEN A JOB ──
                        // Apsara, 2026-09-09: "when i ask show me available
                        // bookings from houston and all are assigned,it should
                        // say no bookings available.and then ask whether it can
                        // email [freightforwarder] for that booking?"
                        //
                        // She is describing what she actually does next. No
                        // free booking at Houston means she needs one, and
                        // getting one means asking a forwarder. Reporting the
                        // absence and stopping leaves her to start the whole
                        // thing again by voice.
                        //
                        // ONLY FOR "AVAILABLE", her choice when asked: an empty
                        // result for a plain "bookings from Savannah" is just an
                        // empty result, and offering there would make Jarvis
                        // chatty about nothing.
                        //
                        // AND IT ROUTES INTO THE FLOW THAT ALREADY EXISTS.
                        // helpers/bookingRequest.js has done this since
                        // 2026-09-06 — it asks the one question that changes
                        // (how many containers), drafts in her own writing
                        // style grounded in real past mail to that contact,
                        // shows the draft, and sends only on "yes". Naming a
                        // forwarder here simply hands over to it. Writing a
                        // second emailer would be the mistake I have made three
                        // times this week in smaller ways.
                        if (!listAsk && !result.rows.length
                            && frame.status === 'unassigned' && frame.location) {
                            const where = String(frame.location).toUpperCase();
                            const said = `No bookings available from ${where}. `
                                + 'Want me to ask a forwarder for space?';
                            if (mem.setOffer) {
                                mem.setOffer({ kind: 'ask_forwarder', port: where });
                            }
                            mem.remember('bot', said);
                            console.log(`[VOICE] nothing available at ${where} — offering to ask a forwarder`);
                            return answering({
                                agent: route.agent, agent_name: agent.name, voice: agent.voice,
                                routed_because: 'nothing available',
                                answer: said, cards: null, awaiting: true,
                            });
                        }
                    } else {
                        cards = null;
                    }
                }
                // A NEW list replaces the old one. setReferents ignores an
                // empty call, which is what stops "forward the first one" from
                // replacing the very list it is pointing at.
                mem.setReferents(cards);
            } catch (e) { console.warn('[VOICE] cards failed:', e.message); }

            // ── SAY THE SHORT VERSION ────────────────────────────────────
            // Apsara: "It should not read out anything extra like unassigned
            // supplier etc. I want how a human assistant will handle it.
            // They will say yes boss, we have 3 bookings available, earliest
            // cutoff is next wednesday. You want me to forward that?"
            //
            // A model handed a table answers by describing the table —
            // carriers, vessels, container counts, which containers have no
            // supplier. All of that is ON THE SCREEN. Reading it aloud is
            // the thing she asked me to stop.
            //
            // So when there IS a panel, the spoken line is composed here:
            // the count, the nearest cutoff in words a person uses, and an
            // offer of the next step. The offer matters — it is what makes
            // it an assistant rather than a search box, and it is the shape
            // she wrote out herself.
            // ── ASK, RATHER THAN ANSWER A QUESTION SHE DID NOT ASK ───────
            // Apsara, 2026-09-08: "If i say show me available bookings ..it
            // should ask from which port if not mentioned explicitly."
            //
            // In studies of mixed-initiative collaborative work, clarification
            // is the single most common move — around 27% of interactions,
            // more than any other kind. It is what a competent assistant does,
            // not a failure to understand.
            //
            // The discipline is in WHEN. bq.needsPort returns null unless
            // there are genuinely two or more ports in play, so a question
            // whose answer is already known is never asked. And the frame is
            // remembered, so her one-word "houston" carries the rest of what
            // she originally asked for instead of starting a bare new query.
            if (listAsk && listAsk.length) {
                const said = `${listAsk.length} ports have those. Which one — ${listAsk.join(', ')}?`;
                console.log(`[VOICE] asking which port: ${listAsk.join(', ')}`);
                mem.remember('bot', said);
                return answering({
                    agent: route.agent, agent_name: agent.name, voice: agent.voice,
                    routed_because: 'asking which port',
                    answer: said,
                    cards: null,
                    awaiting: true,
                });
            }

            if (cards && cards.rows && cards.rows.length) {
                const said = fu.opening(cards);
                if (said) {
                    console.log(`[VOICE] answering from the list: ${cards.rows.length} row(s)`);
                    mem.remember('bot', said);
                    // ── WHAT THAT SENTENCE WAS ABOUT ─────────────────────
                    // Apsara, 2026-09-07: "if i ask when is the erd of that
                    // booking... it just says there are 10 bookings on screen."
                    //
                    // "Earliest cutoff is next Wednesday" is a statement about
                    // rows[0] — the list is sorted by cutoff — not about the
                    // list. That row is the backward-looking center, and
                    // recording it is what lets "that booking" mean something
                    // when ten are on screen. See helpers/voiceMemory.js.
                    //
                    // Gated on the sentence actually having named a cutoff: a
                    // bare "Yes — 10 bookings from Houston." singles nothing
                    // out, and centring on rows[0] anyway would make "that
                    // booking" a guess dressed as a resolution.
                    if (/cutoff/i.test(said)) mem.setCenter(cards.rows[0]);
                    // ── AND IF IT OFFERED, IT REMEMBERS OFFERING ─────────
                    // Read off the sentence that was ACTUALLY said rather
                    // than assumed from the branch: fu.opening() decides the
                    // wording, and an offer recorded when none was spoken
                    // would arm a "yes" she never heard invited.
                    if (mem.setOffer && /want me to forward/i.test(said)) {
                        mem.setOffer({ kind: 'forward', rows: cards.rows });
                    }
                    return answering({
                        agent: route.agent, agent_name: agent.name, voice: agent.voice,
                        routed_because: 'reading the bookings',
                        answer: said, ok: true, cards,
                    });
                }
            }

            if (route.agent === 'scout') {
                const { askYard } = require('./helpers/yardAsk');
                // From the SERVER's memory, not the request body. A client
                // that supplies its own transcript can supply a stale or
                // replayed one, and the end of this flow messages a real
                // driver.
                const out = await askYard(asked, { history: mem.history(), role: req.role });
                try {
                    require('./helpers/yardChatLog').logExchange({
                        question: asked, answer: out && out.answer,
                        have_data: out && out.have_data, ok: out && out.ok,
                        role: req.role || null, source: 'voice',
                    });
                } catch (e) { /* never let logging break answering */ }
                // WHAT JARVIS SAID, remembered too. Recording only her side
                // gives the model a list of questions with no answers, and
                // "what is the ERD" needs to know which booking was just
                // discussed.
                mem.remember('bot', out && out.answer);
                return answering({
                    agent: 'scout', agent_name: agent.name, voice: agent.voice,
                    routed_because: route.why,
                    answer: out.answer, proposal: out.proposal || null, ok: out.ok !== false,
                    // Never a Metals panel under Scout's name — see the early
                    // Scout branch above.
                    cards: null,
                });
            }

            // Jarvis. The SAME path /api/bot/command has always used —
            // brain.process inside sendCapture, with the real sendMessage
            // bridge — rather than a second, subtly different way of calling
            // the brain. The brain sends WhatsApp for real; there should be
            // exactly one way in, not two that can drift apart.
            // Named, before it becomes "_send is not a function" three frames
            // deep inside an action. workflow/actions.js takes its senders
            // from init(), which index.js calls and nothing else does — so
            // anything booting the API on its own gets a module that cannot
            // message anybody, and every action dies with a TypeError that
            // says nothing about the cause. It reached Apsara once as
            // "Something broke while handling that: _send is not a function".
            //
            // Found 2026-09-07 by tests/e2e-voice.js, the first thing ever to
            // run this API without index.js in front of it.
            if (!require('./workflow/actions').ready()) {
                console.error('[VOICE] workflow/actions has no messaging — init() was never called');
                return answering({
                    ok: false, agent: 'jarvis', agent_name: 'Jarvis',
                    answer: 'My messaging is not wired up, so I can answer questions but not act on '
                          + 'anything. That needs a restart.',
                });
            }
            const brain = require('./workflow/brain');
            const { sendCapture } = require('./helpers/wa-state');
            const settings = cfg.getSettings();
            const managerNum = settings.manager_number || cfg.MANAGER_NUMBER;
            if (!managerNum) return res.status(400).json({ error: 'MANAGER_NUMBER not configured' });
            const chatId = `${managerNum}@c.us`;
            // voice: true lets an action hand back a SHORT spoken form while
            // the screen keeps the full text — see helpers/wa-state sayAloud.
            const capture = { replies: [], voice: true, spoken: null };

            // ── WHATSAPP BEING DOWN MUST NOT COST HER EVERY ANSWER ───────
            // Found 2026-09-07 by tests/e2e-voice.js on its first run: with
            // no bridge, this returned 500 for ANY question that reached the
            // brain — "what bookings are there", a cutoff, a container
            // number. None of those send anything. The whole assistant went
            // dark because a messaging transport was unavailable.
            //
            // The fallback is NOT a new degraded mode. It reproduces exactly
            // what index.js's own sendMessage does when waReady is false:
            // replies to HER chat are captured and returned, anything aimed
            // at a trucker or supplier is dropped with a warning and a false
            // return. Same semantics, so an action cannot behave differently
            // here from how it behaves when WhatsApp drops in production.
            //
            // What this ADDS over index.js is that the refusal is not only a
            // console line — it comes back in the answer, because "I could
            // not reach Sher Trucking" is something she has to know and a log
            // on a server she is not looking at is not telling her.
            const realSendMessage = global.__jarvisSendMessage;
            const refused = [];
            const sender = realSendMessage || (async (to, text, media) => {
                if (to === chatId) {
                    capture.replies.push({ chatId: to, text: text || null, media: media || null });
                    return true;
                }
                refused.push(to);
                console.warn(`[VOICE] no WhatsApp bridge — dropped a message to ${to}`);
                return false;
            });
            if (!realSendMessage) {
                console.warn('[VOICE] sendMessage bridge not initialised — answering, but nothing will be sent');
            }

            await sendCapture.run(capture, async () => {
                await brain.process({
                    chatId, senderNumber: chatId, senderName: 'Voice',
                    // `asked`, not `text`: the resolved sentence, with
                    // "the first one" already turned into a booking number.
                    // The brain's policy layer is regex over this string and
                    // cannot resolve a reference itself.
                    text: asked, hasMedia: false, _source: 'voice',
                }, sender);
            });
            // ── replies ARE OBJECTS ──────────────────────────────────────
            // Apsara, 2026-09-06: "[object Object] its saying object object".
            //
            // index.js pushes { chatId, text, media } — not strings. So
            // join() called each object's default toString and produced
            // "[object Object]", which was then spoken aloud and printed on
            // the card. The captured shape has been that since the web bot
            // surface was built; this endpoint just never looked at it.
            //
            // Media-only replies (a booking PDF, no words) have text: null
            // and are dropped rather than becoming "null" on screen.
            const replies = (capture.replies || [])
                .map((r) => (r && typeof r === 'object' ? r.text : r))
                .filter((t) => typeof t === 'string' && t.trim());
            let spoken = replies.join('\n\n') || 'Done.';
            // SAID, not just logged. If something tried to reach a trucker or
            // a supplier and there was no transport, she has to hear it — a
            // console line on a server she is not looking at is not telling
            // her, and "Done." over a message that never left is the exact
            // silent failure this whole build has been about.
            if (refused.length) {
                spoken += ` — but I could not send to ${[...new Set(refused)]
                    .map((r) => String(r).replace(/@c\.us$/, '')).join(', ')}: WhatsApp is not connected.`;
            }
            mem.remember('bot', spoken);
            return answering(Object.assign({
                agent: 'jarvis', agent_name: agent.name, voice: agent.voice,
                routed_because: route.why,
                answer: spoken, replies, ok: true,
                cards,
            }, (capture.spoken && !refused.length) ? { spoken: capture.spoken } : {},
            // An action asked for a screen (wa-state.openScreen) — e.g. the
            // outgoing-invoice tab while Jarvis asks for a missing field.
            capture.open ? { open: capture.open } : {}));
        } catch (e) {
            console.error('[API] voice/ask failed:', e.stack || e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // ── JARVIS SPEAKS UP ON ITS OWN ───────────────────────────────────────
    // Apsara, 2026-09-20. The dashboard polls this while voice is on; see
    // helpers/announcements.js for what qualifies (Edge Metals only) and why
    // a first poll returns nothing but a cursor.
    app.get('/api/voice/announcements', (req, res) => {
        try {
            res.json(require('./helpers/announcements').poll(req.query.since || null));
        } catch (e) {
            console.warn('[API] voice/announcements failed:', e.message);
            res.json({ now: new Date().toISOString(), items: [], spoken: '', screen: '', error: e.message });
        }
    });

    app.post('/api/voice/say', largeJson, async (req, res) => {
        try {
            const { say } = require('./helpers/voice');
            const b = req.body || {};
            // Which agent is speaking decides the voice. Charon for Jarvis,
            // Leda for Scout — Apsara's picks, and the point is that she can
            // tell from the first syllable whether she is hearing yard data or
            // something that may have messaged a trucker.
            const { AGENTS } = require('./helpers/voiceRouter');
            const voice = (AGENTS[b.agent] && AGENTS[b.agent].voice) || undefined;
            // The phone app sends the on-screen answer here to be read out.
            // Same rule as /api/voice/ask: booking numbers are not spoken.
            const { forSpeech } = require('./helpers/spokenAnswer');
            const wav = await say(forSpeech(b.text), { voice });
            res.set('Content-Type', 'audio/wav');
            res.send(wav);
        } catch (e) {
            console.warn('[API] voice/say failed:', e.message);
            // 503, not 500: the text answer already reached the app and is on
            // screen. Losing the audio is a degraded experience, not an error
            // in the thing she asked for.
            res.status(503).json({ error: e.message });
        }
    });

    // ── Confirming an action the assistant proposed ───────────────────────
    // Per Apsara 2026-08-29: the assistant may act, within the yard, but she
    // chose propose-then-confirm over direct writes.
    //
    // The request carries ONLY an opaque id. No load id, no amount, no mode —
    // those live server-side in the validated proposal and cannot be edited
    // between the card being shown and this call. So a tampered page, a replayed
    // request or a malicious script cannot turn a proposed $12,000 into
    // $120,000, and cannot invent a write that was never proposed at all.
    //
    // Single use and five-minute TTL are enforced in helpers/yardActions.js:
    // a double-tap must not record the same payment twice.
    //
    // NOT wrapped in requireAdmin, on purpose. The staff prefix gate above
    // already blocks staff from /api/yard/*, so the callers here are exactly
    // the roles that can already press Pay and Edit in the UI. The invariant
    // worth holding is that the assistant can never do MORE than the person
    // asking could do by hand — and an admin-only gate here would instead make
    // it do LESS, giving a signed-in user a Pay button that works and an
    // assistant that refuses, which reads as broken rather than as secure.
    app.post('/api/yard/act', async (req, res) => {
        try {
            const { confirmAction } = require('./helpers/yardActions');
            const out = await confirmAction((req.body || {}).id, { role: req.role });
            // Logged into the same daily transcript as the conversation, so the
            // record of "what the assistant did" sits next to the words that
            // led to it. Auditing a payment means seeing both.
            try {
                require('./helpers/yardChatLog').logExchange({
                    question: `[CONFIRMED ACTION] ${out.kind}`, answer: out.summary,
                    role: req.role || null, source: (req.body || {}).source || null,
                });
            } catch (e) { /* never let logging break the action */ }
            res.json(out);
        } catch (e) {
            // 400, not 500: an expired or reused confirmation is a normal
            // outcome the person needs to read, not a server fault.
            res.status(400).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/yard/cancel-action', (req, res) => {
        try {
            const { cancelAction } = require('./helpers/yardActions');
            res.json({ ok: cancelAction((req.body || {}).id) });
        } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
    });

    // The transcripts. Admin-only like the rest of this file's routes, since a
    // day's conversation quotes the yard's balances back verbatim.
    app.get('/api/yard/chat-log', (req, res) => {
        try {
            const log = require('./helpers/yardChatLog');
            const day = req.query && req.query.day;
            if (day) return res.json({ day, entries: log.readDay(day) });
            res.json({ days: log.listDays() });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // The raw brief, for debugging what the bot can actually see. Useful when
    // an answer looks wrong: the first question is always whether the fact was
    // in the data at all.
    app.get('/api/yard/brief', (req, res) => {
        try {
            const { buildYardBrief } = require('./helpers/yardBrief');
            res.json(buildYardBrief({ days: Number(req.query && req.query.days) || 30 }));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── Payments against a load ───────────────────────────────────────────
    // Per Apsara 2026-08-28: Pay beside Edit/Delete, mode + amount, anything
    // short of the load total is partial with a pending balance.
    //
    // A ledger, not a flag — see helpers/payments.js for why a load can carry
    // several payments and why they are stored outside the load record.
// @@chunk-end

};
