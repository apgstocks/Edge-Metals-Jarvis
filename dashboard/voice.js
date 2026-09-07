/* ── dashboard/voice.js — "Hey Jarvis" in the browser ──────────────────────
 *
 * Apsara, 2026-09-05: "i dont want voice on app .. only on website", and then
 * "i want hey jarvis like hey siri in my laptop."
 *
 * WHY THIS IS ONLY POSSIBLE TODAY
 * -------------------------------
 * Browsers refuse microphone access on plain HTTP. Until this morning the
 * dashboard was reachable only over a rotating *.trycloudflare.com tunnel;
 * now it is https://jarvis.edgemetals.com with a real certificate, so the
 * microphone can be asked for at all. The subdomain work was the prerequisite
 * for this feature, not a detour from it.
 *
 * THE RULE ABOUT WHEN THE MIC MAY BE OPEN IS NOT IN THIS FILE
 * -----------------------------------------------------------
 * It lives in voice-machine.js — the same pure reducer the Android app used,
 * copied unchanged, still covered by tests/voice-machine.js and its
 * exhaustive event-ordering search. That file exists because of one specific
 * failure: if the mic is open while Jarvis is speaking, it hears its own
 * reply, finds its own name in it, and re-triggers itself forever on an open
 * microphone. That bug is not browser-specific and the rule that prevents it
 * is not either, so it is reused rather than rewritten.
 *
 * This file is the BODY: it owns the recogniser, the speaker and the DOM, and
 * it does what the reducer tells it. Every decision about whether to listen
 * goes through reduce(); none is taken here.
 *
 * CHROME, WITH AN HONEST FALLBACK
 * -------------------------------
 * A wake word needs CONTINUOUS recognition, and that is where browsers
 * differ. Safari supports SpeechRecognition but its continuous mode
 * misbehaves — the microphone does not reliably stop when you stop talking,
 * and results accumulate into one ever-growing string. Rather than ship
 * something that half-works and blame the browser, this feature-detects:
 *
 *   Chrome/Edge  → wake word, hands-free, as she asked.
 *   Safari/other → the same assistant behind a press-to-talk button, and a
 *                  line saying plainly why, naming Chrome.
 *
 * Degrading is the point. A microphone that sometimes never closes is worse
 * than a button.
 *
 * PRIVACY, WHICH IS NOT NEGOTIABLE HERE
 * -------------------------------------
 * An always-listening microphone in an office needs to be visibly on. So:
 *   - it is OFF until she turns it on, every session; nothing auto-starts
 *   - while the mic is open there is a red dot she cannot miss
 *   - the tab title changes too, because the dot is invisible on a background tab
 *   - closing or hiding the tab stops the microphone (APP_BACKGROUND)
 *   - audio is never recorded, stored or uploaded — the browser's recogniser
 *     returns text, and only that text is sent to the server
 */

(function () {
    'use strict';
    if (window.__jarvisVoiceLoaded) return;
    window.__jarvisVoiceLoaded = true;

    var VM = window.VoiceMachine;
    if (!VM) { console.warn('[VOICE] voice-machine.js must load first'); return; }

    // ── what this browser can actually do ─────────────────────────────────
    // ── WHICH ENGINE ─────────────────────────────────────────────────────
    // Three possibilities, in order of preference:
    //
    //   1. LOCAL (voice-local.js) — the desktop app. Audio is captured here
    //      and transcribed by whisper.cpp inside the app's own Node process.
    //      Nothing leaves the Mac. Preferred wherever it exists, because it
    //      is both the only thing that works there AND more private than the
    //      alternative.
    //   2. Chrome's SpeechRecognition — real Chrome only. Works, but uploads
    //      the audio to Google to be transcribed.
    //   3. Nothing usable — Safari, whose continuous mode misbehaves.
    //
    // Preferring local was not the original design. It became the design
    // after the desktop app was shipped claiming "Electron bundles Chromium
    // so the wake word works", which was wrong: SpeechRecognition in Chrome
    // is a GOOGLE SERVICE reached with keys Electron does not have. Proved on
    // her machine — "SPEECH ERROR: network", instantly — rather than argued.
    var LOCAL = window.JarvisLocalRecognition || null;
    var SR = LOCAL || window.SpeechRecognition || window.webkitSpeechRecognition || null;
    // Safari reports webkitSpeechRecognition and then handles `continuous`
    // badly. Irrelevant when the local engine is present, which is why this is
    // checked second.
    var isSafari = /^((?!chrome|android|crios|edg).)*safari/i.test(navigator.userAgent);
    var canWake = !!LOCAL || (!!SR && !isSafari);

    // ── THE WAKE WORD, AND WHAT THE MODEL ACTUALLY WRITES DOWN ───────────
    // This was /\b(hey |ok |okay )?jarvis\b/i — one spelling, exactly. That
    // is fine against Chrome's cloud recogniser and much too strict against
    // tiny.en, which is a 77MB model doing its best with a name that is not
    // common in its training data. On her Mac it produced "I'll see you
    // later" and worse from a clear "Hey Jarvis", and a matcher that admits
    // only the correct spelling turns every mis-hearing into silence.
    //
    // So the near-misses are admitted too. The cost of a FALSE match is
    // small and visible: an 8-second capture window opens, she sees it, it
    // closes. The cost of a MISS is that the whole feature appears dead,
    // which is what she has been living with all afternoon. Asymmetric, so
    // the matcher should be generous.
    //
    // THE NEAR-MISSES ONLY COUNT AFTER "HEY". My first attempt at this put
    // "travis" in the flat alias list, and tests/voice-web.js caught it
    // immediately: there is already a case asserting that "travis brought
    // the load in" must NOT open a microphone, written earlier because a
    // driver named Travis is entirely ordinary in a freight yard. That test
    // was right and the change was wrong.
    //
    // So the split is: the correct spellings wake it on their own, and the
    // sloppy ones only when preceded by an address — "hey travis" is
    // someone talking to a laptop, "travis brought the load in" is someone
    // talking about a driver. Grammar does the disambiguating that a
    // spelling list could not.
    var WAKE = new RegExp(
        '\\b(?:'
        + '(?:hey|ok|okay|hi)\\s+(?:jarvis|jarviss|jervis|jarvez|javis|charvis|travis|jarvie|service)'
        + '|jarvis|jarviss|jervis|jarvez'
        + ')\\b', 'i');

    // ── AND SCOUT HAS A NAME TOO ─────────────────────────────────────────
    // Apsara, 2026-09-06: "when i call Hey scout, a different voice should
    // answer with MMm hmm (new bubble indicating diff assistant)."
    //
    // Two assistants have existed behind the router for weeks — Scout for
    // the yard ledger, Jarvis for everything else — and only one of them
    // had a name you could say. Calling Scout was impossible; you could
    // only be ROUTED to it by the words you happened to use.
    //
    // Same near-miss tolerance as the Jarvis matcher, for the same reason:
    // a 77MB model guessing at a proper noun. "Scout" is short and common
    // enough that the sloppy spellings are only admitted after an address.
    var WAKE_SCOUT = new RegExp(
        '\\b(?:(?:hey|ok|okay|hi)\\s+(?:scout|scot|scoot|skout)|scout)\\b', 'i');

    // Which one she called. Drives the colour, the voice of the
    // acknowledgement, and the agent the server is told to use — so the
    // answer comes from the assistant she actually addressed rather than
    // whichever one the content happens to score for.
    var addressed = 'jarvis';

    var AGENT_LOOK = {
        jarvis: { name: 'Jarvis', voice: 'Charon', accent: '#B4703A', tint: 'rgba(180,112,58,' },
        scout:  { name: 'Scout',  voice: 'Leda',   accent: '#3E8E7E', tint: 'rgba(62,142,126,' },
    };
    // How long a command may run before it is cut off. Long enough for
    // "record a twelve thousand dollar zelle payment against edge zero seven",
    // short enough that an open mic in a noisy office closes on its own.
    var CAPTURE_MS = 8000;

    // Set once the recogniser has told us it has no engine behind it. There
    // is no recovering from that within this window, so it latches.
    var speechUnavailable = false;
    // Consecutive "network" errors. Three, because a genuine absence of an
    // engine fails every time and immediately, while a hiccup does not —
    // and any successful result resets it to zero.
    var networkErrors = 0;
    var NETWORK_ERRORS_BEFORE_GIVING_UP = 3;

    var state = VM.initial({ enabled: false, foreground: !document.hidden });
    var rec = null, captureTimer = null, heardDuringCapture = '';
    // Set from the server's `awaiting` flag on every response, and consumed
    // exactly once by the speak() finish handler below. A variable rather
    // than state in voice-machine.js deliberately: that reducer exists to
    // decide ONE thing — whether the microphone may be open — and "is there
    // a question outstanding" does not change that answer, it changes what
    // happens next.
    var awaitingReply = false;
    // ── PICKING UP A SENTENCE SHE WAS STILL SAYING ───────────────────────
    // Apsara: "if i start saying something, it should get appended to the
    // last spken. but it is just getting cut off abruptly."
    //
    // The silence timer above stops MOST of this by not cutting her off in
    // the first place. This covers the rest: if she pauses to think, the
    // capture closes, and then she carries on within a couple of seconds,
    // what she says next is JOINED to what she already said and asked as one
    // sentence — rather than arriving as a fragment with no subject.
    //
    // Deliberately short. Past a few seconds a new sentence is a new
    // sentence, and gluing it onto the last one would produce nonsense.
    // Consumed by the OPEN_CAPTURE effect above. One-shot: it must not leak
    // into the next wake word, which is the one thing the chime is for.
    var suppressAck = false;
    // Set when Jarvis reopened the mic itself after asking a question — see
    // finishCapture, which must not drop that turn in silence.
    var captureWasFollowUp = false;
    var captureRetried = false;
    var capturePassive = false;
    // A one-shot line to show WHEN the capture reopens, not before. Writing it
    // straight into the pill was useless: openCapture() calls say('Listening')
    // and showCard('Go ahead…') a millisecond later and wiped it — the retry
    // happened and looked exactly like the silent drop it was fixing.
    var pendingHint = '';
    var pendingSeed = '';
    // ── BARGE-IN (Siri/Alexa), AND THE GUARD THAT REPLACES INVARIANT 1 ───
    // Apsara, 2026-09-07: "mimic siri behaviour/alexa's."
    //
    // While Jarvis is speaking the recogniser now stays alive, but in GUARD
    // mode: nothing it returns is treated as a command except the wake word
    // or a stop word. That is Alexa's design — full recognition does not run
    // during playback, only the wake detector — and it shrinks the surface
    // from "any sentence Jarvis says" to "the handful of words below".
    //
    // The second guard is the echo filter. We know exactly what Jarvis is
    // saying, so anything the recogniser hands back that appears in that
    // sentence is Jarvis's own voice and is discarded. This is the piece
    // doing the work that acoustic echo cancellation would do if the Web
    // Speech API gave us a speaker reference signal. It does not.
    // Alexa's Follow-Up Mode. `passiveCapture` is consumed by openCapture and
    // marks a window nobody asked her to fill, so finishCapture closes it in
    // silence instead of retrying.
    var followUpMode = true;
    var passiveCapture = false;
    var FOLLOWUP_MS = 5000;
    var guardMode = false;
    var nowSpeaking = '';       // what Jarvis is saying RIGHT NOW, for the filter
    var selfTriggers = 0;       // consecutive times the filter caught its own voice
    var SELF_TRIGGER_LIMIT = 2; // then barge-in latches off for the session
    var BARGE_WORDS = /\b(stop|cancel|nevermind|never mind|quiet|shut up|wait|hold on|enough)\b/i;
    var capturePrefix = '';
    var CONTINUE_MS = 2500;
    var lastAsked = '';
    var lastAskedAt = 0;
    var origTitle = document.title;

    // ── the DOM ───────────────────────────────────────────────────────────
    var bar = document.createElement('div');
    bar.id = 'jarvisVoiceBar';
    bar.innerHTML = [
        '<button id="jvToggle" type="button"></button>',
        '<span id="jvDot"></span>',
        '<span id="jvText"></span>',
        // Deliberately small and grey. It is a setting she will touch once,
        // sitting beside a control she uses constantly.
        '<button id="jvVoiceBtn" type="button" title="Choose the voice Jarvis speaks in">●●●</button>',
    ].join('');
    var css = document.createElement('style');
    css.textContent = [
        '#jarvisVoiceBar{position:fixed;right:18px;bottom:82px;z-index:900;display:flex;align-items:center;gap:9px;',
        '  padding:8px 12px;border-radius:999px;background:#14181B;border:1px solid rgba(255,255,255,.14);',
        '  font-family:ui-monospace,monospace;font-size:11.5px;color:#8A9299;box-shadow:0 6px 18px rgba(0,0,0,.4);}',
        '#jvToggle{background:transparent;border:none;color:#B4703A;font:inherit;font-weight:700;cursor:pointer;',
        '  text-transform:uppercase;letter-spacing:.1em;padding:0;}',
        '#jvDot{width:8px;height:8px;border-radius:50%;background:#394046;flex:none;}',
        /* The dot is the honest bit. Red and pulsing means the microphone is
           genuinely open right now — not "enabled", OPEN. */
        '#jarvisVoiceBar.live #jvDot{background:#E5484D;animation:jvPulse 1.1s ease-in-out infinite;}',
        '#jarvisVoiceBar.hearing{border-color:#B4703A;}',
        '@keyframes jvPulse{0%,100%{opacity:1;}50%{opacity:.25;}}',
        '#jarvisVoiceBar.hidden{display:none;}',
        '#jvVoiceBtn{background:transparent;border:none;color:#5A6169;cursor:pointer;padding:0 2px;',
        '  font-size:9px;letter-spacing:1px;line-height:1;}',
        '#jvVoiceBtn:hover{color:#B4703A;}',
    ].join('');

    function el(id) { return document.getElementById(id); }
    function say(msg) { var t = el('jvText'); if (t) t.textContent = msg; }

    // ── THE ANSWER CARD ──────────────────────────────────────────────────
    // Apsara, 2026-09-06: "a chat box with text is coming but it is half
    // cut. Also jarvis is taking more time to answer. I want to mimic siri."
    //
    // Both complaints had one cause. The answer was being written into the
    // status pill — a single-line flex row, no wrapping — after
    // `answer.slice(0, 60)`. So every reply was literally cut off, twice:
    // once by the slice and once by the pill's width.
    //
    // AND IT IS WHY IT FELT SLOW. Siri and Alexa do not answer faster than
    // this; they show your words the instant you stop talking, so the wait
    // has something in it. Here the screen said "Thinking…" in eight-point
    // grey and nothing else, which makes two seconds feel like ten. The
    // question now appears immediately, the answer fills in underneath.
    // That is a perceived-latency fix, and it is the honest one available —
    // the real time is the server's LLM call, not anything the page does.
    var card = document.createElement('div');
    card.id = 'jvCard';
    card.className = 'hidden';
    card.innerHTML = '<div id="jvCardQ"></div><div id="jvCardA"></div>';
    var cardTimer = null;

    var cardCss = [
        // position:relative — #jvStack places it. See panelCss.
        '#jvCard{position:relative;width:340px;max-width:100%;',
        '  max-height:46vh;overflow-y:auto;padding:14px 16px;border-radius:16px;background:#14181B;',
        '  border:1px solid rgba(255,255,255,.14);box-shadow:0 12px 34px rgba(0,0,0,.55);',
        '  font-family:system-ui,-apple-system,sans-serif;cursor:pointer;',
        '  opacity:1;transition:opacity .22s ease,transform .22s ease;}',
        '#jvCard.hidden{opacity:0;transform:translateY(8px);pointer-events:none;}',
        /* The question, quiet and above — the same shape Siri uses. Seeing
           what it THINKS you said is also the fastest way to spot a
           mis-transcription, which has been most of today. */
        '#jvCardQ{font-size:12.5px;color:#8A9299;margin-bottom:8px;line-height:1.45;}',
        '#jvCardQ:empty{display:none;}',
        /* The answer WRAPS. This is the actual bug fix. */
        '#jvCardA{font-size:14.5px;color:#E7ECEF;line-height:1.55;white-space:pre-wrap;word-break:break-word;}',
        '#jvCard.speaking::after{content:"tap or press Esc to interrupt";display:block;margin-top:9px;',
        '  font-size:10.5px;letter-spacing:.04em;color:#5A6169;}',
        '#jvCard.thinking #jvCardA{color:#8A9299;font-style:italic;}',
    ].join('');

    function showCard(question, answer, thinking) {
        if (!card.isConnected) return;
        if (question !== null && question !== undefined) {
            el('jvCardQ').textContent = question ? '“' + question + '”' : '';
        }
        el('jvCardA').textContent = answer || '';
        card.classList.toggle('thinking', !!thinking);
        card.classList.remove('hidden');
        clearTimeout(cardTimer);
        // Long answers get longer on screen. Reading speed, roughly, with a
        // floor — an answer that vanishes before it is read is no better
        // than one that was cut off.
        if (!thinking) {
            var ms = Math.min(30000, Math.max(7000, String(answer || '').length * 55));
            cardTimer = setTimeout(hideCard, ms);
        }
    }
    // ── INTERRUPTING ─────────────────────────────────────────────────────
    // Apsara, 2026-09-06: "if scout is answering and i want jarvis
    // intervention immediately .. how should i do that."
    //
    // THE HONEST ANSWER, AND WHY IT IS NOT "just say Hey Jarvis":
    // while either assistant is speaking THE MICROPHONE IS SHUT. That is
    // not an oversight, it is the single rule voice-machine.js exists to
    // enforce — an open mic during playback hears the reply, finds the name
    // in it, and re-triggers itself in a loop that only stops when the
    // battery does. So there is physically nothing listening for a spoken
    // interruption at that moment.
    //
    // Barge-in by voice is possible — it needs the mic left open with echo
    // cancellation carrying the load, and it means deliberately weakening
    // that rule. That is a real decision with a known failure mode behind
    // it, not something to slip in.
    //
    // So the interruption is a TAP, which is instant, unambiguous and
    // carries no risk: clicking the card stops whoever is talking and
    // reopens the microphone, ready for whoever she wants next.
    function interrupt() {
        var wasSpeaking = !!state.speaking;
        hideCard();
        if (!wasSpeaking) return;
        // CAPTURE_START rather than a bare stop: the reducer's own barge-in
        // rule cancels the speech FIRST and then opens the capture, in that
        // order. Doing it by hand here would be a second, subtly different
        // path to the same state — which is how the original self-trigger
        // bug got in.
        // CAPTURE_START alone. The reducer answers it with STOP_SPEAKING,
        // START_MIC and OPEN_CAPTURE, in that order, and dispatch() performs
        // all three — so calling openCapture() here as well was a second
        // path to the same place. A mutation removing it survived every
        // test, which is how redundant code announces itself.
        dispatch('CAPTURE_START');
        console.log('[VOICE] interrupted — go ahead');
    }

    function hideCard() { clearTimeout(cardTimer); card.classList.add('hidden'); }
    card.addEventListener('click', function () {
        if (state.speaking) interrupt(); else hideCard();
    });

    // ── THE SCREEN ───────────────────────────────────────────────────────
    // Apsara, 2026-09-06: "like JARVIS in iron man, a screen should appear,
    // where it shows me all relevant answer to my question as jarvis is
    // talking back. For eg: If i ask any available bookings from Houston? It
    // should show Booking number, ERD, cut off."
    //
    // The rows arrive from the server already looked up — see
    // helpers/answerCards.js for why they are NOT parsed out of the spoken
    // reply. This file only draws them.
    //
    // NUMBERED, AND THAT IS LOAD-BEARING. "Forward the first booking to Sher
    // Trucking" only means something if something was numbered, and the
    // number she sees has to be the number the server used — which is why it
    // comes down in the data rather than being however this happens to
    // render a list.
    var panel = document.createElement('div');
    panel.id = 'jvPanel';
    panel.className = 'hidden';
    var panelCss = [
        // ── ONE COLUMN, NOT TWO FIXED BOXES ──────────────────────────────
        // The answer card and the results panel were both anchored at
        // right:18px bottom:132px, which does not stack them — it puts one
        // exactly on top of the other. A flex column owns the position; the
        // two children just sit in it, newest at the bottom, and neither
        // needs to know how tall the other is.
        '#jvStack{position:fixed;right:18px;bottom:132px;z-index:902;display:flex;',
        '  flex-direction:column;align-items:flex-end;gap:10px;max-width:calc(100vw - 36px);}',
        '#jvPanel{position:relative;right:auto;bottom:auto;width:420px;max-width:100%;',
        '  max-height:60vh;overflow-y:auto;border-radius:16px;background:#0F1418;',
        '  border:1px solid rgba(180,112,58,.34);box-shadow:0 16px 44px rgba(0,0,0,.62);',
        '  font-family:system-ui,-apple-system,sans-serif;}',
        '#jvPanel.hidden{display:none;}',
        '.jvpHead{position:sticky;top:0;background:#0F1418;padding:13px 16px 10px;',
        '  border-bottom:1px solid rgba(255,255,255,.09);font-size:11px;letter-spacing:.12em;',
        '  text-transform:uppercase;color:#B4703A;font-weight:700;display:flex;align-items:center;gap:8px;}',
        '.jvpHead span{margin-left:auto;color:#5A6169;letter-spacing:0;text-transform:none;font-weight:400;}',
        '.jvpRow{padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.055);display:flex;gap:11px;}',
        '.jvpRow:last-child{border-bottom:none;}',
        /* The number she says out loud, made unmissable. */
        '.jvpN{flex:none;width:22px;height:22px;border-radius:50%;background:rgba(180,112,58,.2);',
        '  color:#F3C08A;font-size:11.5px;font-weight:700;display:flex;align-items:center;',
        '  justify-content:center;margin-top:1px;}',
        '.jvpBody{flex:1;min-width:0;}',
        '.jvpNo{font-size:14.5px;color:#E7ECEF;font-weight:600;letter-spacing:.01em;}',
        '.jvpSub{font-size:11.5px;color:#8A9299;margin-top:2px;}',
        /* ERD and cutoff are the two she asked for by name, so they get a */
        /* line of their own rather than being buried in the summary. */
        '.jvpDates{display:flex;gap:14px;margin-top:6px;font-size:11.5px;}',
        '.jvpDates b{color:#5A6169;font-weight:600;margin-right:4px;}',
        '.jvpDates i{font-style:normal;color:#C8CFD4;}',
        '.jvpCans{margin-top:6px;font-size:11px;color:#8A9299;display:flex;flex-wrap:wrap;gap:5px;}',
        '.jvpCan{padding:2px 7px;border-radius:5px;background:rgba(255,255,255,.05);}',
        /* Amber, not red: a container with no supplier is a thing to do, */
        /* not a thing that has gone wrong. */
        '.jvpCan.todo{background:rgba(180,112,58,.19);color:#F3C08A;}',
    ].join('');

    var esc = function (s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    };

    function showPanel(cards) {
        if (!panel.isConnected) return;
        if (!cards || !cards.rows || !cards.rows.length) { panel.classList.add('hidden'); return; }

        var html = ['<div class="jvpHead">', esc(cards.title || 'Results'),
            '<span>', String(cards.rows.length), '</span></div>'];

        cards.rows.forEach(function (r) {
            var cans = (r.containers || []).map(function (c) {
                var label = '#' + c.seq + ' ' + (c.size || '');
                if (c.supplier) label += ' · ' + c.supplier;
                if (c.trucker) label += ' → ' + c.trucker;
                return '<span class="jvpCan' + (c.supplier ? '' : ' todo') + '">'
                    + esc(label) + (c.supplier ? '' : ' · no supplier') + '</span>';
            }).join('');

            html.push(
                '<div class="jvpRow">',
                '<div class="jvpN">', String(r.n), '</div>',
                '<div class="jvpBody">',
                '<div class="jvpNo">', esc(r.booking_number), '</div>',
                '<div class="jvpSub">', esc(r.carrier),
                r.from ? ' · ' + esc(r.from) + ' → ' + esc(r.to) : '',
                r.vessel ? ' · ' + esc(r.vessel) : '', '</div>',
                '<div class="jvpDates">',
                '<div><b>ERD</b><i>', esc(r.erd || '—'), '</i></div>',
                '<div><b>Cutoff</b><i>', esc(r.cutoff || '—'), '</i></div>',
                '</div>',
                cans ? '<div class="jvpCans">' + cans + '</div>' : '',
                '</div></div>');
        });

        panel.innerHTML = html.join('');
        panel.classList.remove('hidden');
        // Deliberately NOT on a timer. The answer card fades because it is a
        // sentence she has finished reading; this is a list she is about to
        // act on — "forward the first one" — and it must still be there while
        // she says so.
    }
    function hidePanel() { panel.classList.add('hidden'); }

    // ── THE DOCUMENT, ON SCREEN, BEFORE SHE SAYS YES ─────────────────────
    // Apsara, 2026-09-07: "Send it to Daekwang? --> show preview. post my
    // confirmation..send"
    //
    // The server has been rendering this HTML and putting it in the response
    // as `proforma.html` since the day the flow was built. NOTHING IN THE
    // DASHBOARD EVER READ IT. She was being asked to approve a document she
    // could only hear described — "21 MT of copper at $8,450.00" — which is
    // exactly the wrong thing to confirm by ear, because the parts most
    // likely to be wrong (the consignee's address, the invoice number, the
    // container line) are the parts the sentence does not read out.
    //
    // AN IFRAME, SANDBOXED, srcdoc. The proforma is a full document with its
    // own stylesheet built for A4 print; dropping that into the dashboard's
    // DOM would have its CSS reach out and restyle the app around it. The
    // sandbox is not because the HTML is untrusted — we generate it — but
    // because it costs nothing and the alternative is trusting that it stays
    // that way.
    var doc = document.createElement('div');
    doc.id = 'jvDoc';
    doc.className = 'hidden';
    var docCss = [
        '#jvDoc{position:relative;width:460px;max-width:100%;border-radius:16px;',
        '  background:#0F1418;border:1px solid rgba(180,112,58,.34);',
        '  box-shadow:0 16px 44px rgba(0,0,0,.62);overflow:hidden;',
        '  font-family:system-ui,-apple-system,sans-serif;}',
        '#jvDoc.hidden{display:none;}',
        '.jvdHead{padding:13px 16px 10px;border-bottom:1px solid rgba(255,255,255,.09);',
        '  font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#B4703A;',
        '  font-weight:700;display:flex;align-items:center;gap:8px;}',
        '.jvdHead span{margin-left:auto;color:#5A6169;letter-spacing:0;text-transform:none;font-weight:400;}',
        // White, because a proforma is a white document and showing it on the
        // dark panel would be a preview of something that does not exist.
        '.jvdPaper{background:#fff;height:340px;overflow:hidden;}',
        '.jvdPaper iframe{width:200%;height:200%;border:0;transform:scale(.5);',
        '  transform-origin:0 0;background:#fff;}',
        '.jvdFoot{padding:11px 14px;border-top:1px solid rgba(255,255,255,.09);',
        '  display:flex;align-items:center;gap:9px;}',
        '.jvdSay{flex:1;color:#8A9199;font-size:12px;line-height:1.35;}',
        '.jvdBtn{border:0;border-radius:9px;padding:8px 15px;font-size:12.5px;font-weight:650;',
        '  cursor:pointer;font-family:inherit;}',
        '.jvdSend{background:#B4703A;color:#0B0E11;}',
        '.jvdSend:hover{background:#C77F44;}',
        '.jvdNo{background:rgba(255,255,255,.07);color:#9AA1A9;}',
        '.jvdNo:hover{background:rgba(255,255,255,.12);}',
        '.jvdWarn{color:#D08B4F;}',
    ].join('');

    // `pro` is the response's proforma object. Null or a stage that is not a
    // preview hides it — an asking stage ("What rate?") has no document yet,
    // and showing a half-built one would invite her to approve a blank.
    function showDoc(pro) {
        if (!doc.isConnected) return;
        if (!pro || pro.stage !== 'preview' || !pro.html) { hideDoc(); return; }

        var ready = pro.ready !== false;
        var inv = (pro.fields && pro.fields.inv_no) || pro.inv_no || '';
        var head = ['<div class="jvdHead">Proforma',
            '<span>', esc(inv || 'draft'), '</span></div>',
            '<div class="jvdPaper"><iframe sandbox="" title="Proforma preview"></iframe></div>',
            '<div class="jvdFoot">',
            '<div class="jvdSay', ready ? '' : ' jvdWarn', '">',
            esc(ready ? 'Say “yes” to send it, or tell me what to change.'
                : (pro.blocked === 'ambiguous'
                    ? 'Which contact did you mean?'
                    : 'No email address for them yet — nothing will be sent.')),
            '</div>'];
        // The buttons exist for when she is at the keyboard, NOT as a second
        // way of sending. They put the same words through ask() that her
        // voice would, so there is one path to the sender and one place a
        // confirmation can be recorded. A button that called a send endpoint
        // directly would be the "second set of rules" problem in the UI.
        if (ready) {
            head.push('<button class="jvdBtn jvdNo" id="jvdCancel">No</button>',
                '<button class="jvdBtn jvdSend" id="jvdSend">Send</button>');
        }
        head.push('</div>');
        doc.innerHTML = head.join('');

        // srcdoc AFTER innerHTML, because assigning it to an element that is
        // about to be replaced loads the document twice and shows a flash of
        // the previous proforma in the new frame.
        var frame = doc.querySelector('iframe');
        if (frame) frame.srcdoc = pro.html;

        var send = document.getElementById('jvdSend');
        if (send) send.addEventListener('click', function () { ask('yes'); });
        var no = document.getElementById('jvdCancel');
        if (no) no.addEventListener('click', function () { ask('no'); });

        doc.classList.remove('hidden');
    }
    function hideDoc() { doc.classList.add('hidden'); doc.innerHTML = ''; }

    // ── WHICH ASSISTANT IS ON SCREEN ─────────────────────────────────────
    // Apsara: "if I call scout, will it create another bubble - in different
    // colour to enquire about yard data."
    //
    // Not a second bubble — one bubble that says WHOSE it is. Two stacks
    // would mean two places to look and two things to dismiss, for a
    // distinction that is one property of one answer. The colour, the name
    // in the card, and the voice of the acknowledgement all move together,
    // so there is never a moment where the screen says one assistant and the
    // speaker says the other.
    function paintAgent(who) {
        var look = AGENT_LOOK[who] || AGENT_LOOK.jarvis;
        try {
            card.style.borderColor = look.tint + '.42)';
            panel.style.borderColor = look.tint + '.42)';
            var q = el('jvCardQ');
            if (q) q.style.color = look.accent;
            var head = panel.querySelector('.jvpHead');
            if (head) head.style.color = look.accent;
            document.querySelectorAll('.jvpN').forEach(function (n) {
                n.style.background = look.tint + '.2)';
                n.style.color = look.accent;
            });
        } catch (e) {}
    }

    // ── CHOOSING THE VOICE ───────────────────────────────────────────────
    // Apsara, 2026-09-06: "set different voice."
    //
    // A picker rather than another guess from me. My ranking is an opinion
    // about which of macOS's voices sound human, and the one thing it
    // cannot know is which one she wants to hear all day.
    //
    // It matters more than it looks, because of a Chromium limitation worth
    // recording here: Chromium's macOS TTS bridge discards the native voice
    // identifier and matches voices BY NAME. Compact "Samantha" and Premium
    // "Samantha" have identical names and languages, so from JavaScript
    // they are the same voice and the compact one wins. In the desktop app
    // there are no Google voices at all. So this list is honestly limited —
    // and the note under it points at the one lever that does reach the
    // good voices, which is the macOS system setting.
    var voiceSheet = document.createElement('div');
    voiceSheet.id = 'jvVoices';
    voiceSheet.className = 'hidden';
    voiceSheet.innerHTML = [
        '<div class="jvvHead">Jarvis speaks as</div>',
        '<div id="jvvList"></div>',
        '<div class="jvvNote">Not enough? macOS has far better voices than a browser can reach: '
        + '<b>System Settings → Accessibility → Spoken Content → System voice</b>, pick the ⓘ beside a voice '
        + 'and download a <b>Premium</b> one. Set it as the system voice and choose '
        + '<b>System default</b> above.</div>',
        '<button id="jvvClose" type="button">Done</button>',
    ].join('');

    var voiceCss = [
        '#jvVoices{position:fixed;right:18px;bottom:132px;z-index:903;width:320px;max-width:calc(100vw - 36px);',
        '  max-height:60vh;overflow-y:auto;padding:14px 16px;border-radius:16px;background:#14181B;',
        '  border:1px solid rgba(255,255,255,.16);box-shadow:0 14px 38px rgba(0,0,0,.6);',
        '  font-family:system-ui,-apple-system,sans-serif;}',
        '#jvVoices.hidden{display:none;}',
        '.jvvHead{font-size:11px;letter-spacing:.11em;text-transform:uppercase;color:#B4703A;',
        '  font-weight:700;margin-bottom:10px;}',
        '.jvvRow{display:flex;align-items:center;gap:9px;padding:8px 9px;border-radius:9px;cursor:pointer;',
        '  font-size:13.5px;color:#E7ECEF;}',
        '.jvvRow:hover{background:rgba(255,255,255,.06);}',
        '.jvvRow.on{background:rgba(180,112,58,.18);color:#F3C08A;}',
        '.jvvRow .jvvTick{width:12px;flex:none;color:#B4703A;}',
        '.jvvRow small{color:#8A9299;margin-left:auto;font-size:11px;}',
        '.jvvNote{margin-top:12px;font-size:11.5px;line-height:1.55;color:#8A9299;}',
        '.jvvNote b{color:#B9C0C6;font-weight:600;}',
        '#jvvClose{margin-top:12px;width:100%;padding:9px;border-radius:9px;cursor:pointer;',
        '  background:#B4703A;border:none;color:#12161A;font:inherit;font-size:13px;font-weight:700;}',
    ].join('');

    function renderVoiceList() {
        var box = el('jvvList');
        if (!box) return;
        var list = [];
        try { list = window.speechSynthesis.getVoices() || []; } catch (e) {}
        var english = list.filter(function (v) { return /^en(-|_|$)/i.test(v.lang || ''); });
        var pool = english.length ? english : list;
        var current = savedVoiceName();

        box.innerHTML = '';
        var rows = [];

        // ── KOKORO FIRST, WHEN IT IS THERE ───────────────────────────────
        // These are not browser voices; they are synthesised in the desktop
        // app. Listed above the browser ones because they are better than
        // anything the browser can reach here, and marked so it is obvious
        // which is which.
        //
        // Two voices, not fifty-four. Kokoro's own voice table grades
        // af_heart A and af_bella A-, and most of the rest C to F — one is
        // graded F+. Offering the whole list would only give her a way to
        // make this worse than what it replaced. Both are American female,
        // which is what she asked for.
        if (ttsBridge && ttsBridge.speak) {
            var kokoroNow = '';
            try { kokoroNow = window.localStorage.getItem('jarvisKokoroVoice') || 'af_heart'; } catch (e) {}
            [{ id: 'af_heart', label: 'Heart', hint: 'female · natural' },
             { id: 'af_bella', label: 'Bella', hint: 'female · warmer' }].forEach(function (k) {
                rows.push({ kokoro: k.id, name: 'kokoro:' + k.id, label: k.label,
                    hint: k.hint, on: kokoroNow === k.id });
            });
        }

        // "System default" is not a cosmetic entry — passing NO voice is the
        // only way Chromium will use the Premium voice she set in System
        // Settings, because it hoists that one to index 0. Selecting
        // "Samantha" by name gets the compact one instead.
        rows.push({ name: '', label: 'System default', hint: 'follows macOS' });
        pool.forEach(function (v) {
            rows.push({ name: v.name, label: v.name, hint: v.lang });
        });

        // A Kokoro row is selected when it is the stored Kokoro voice AND no
        // browser voice has been chosen — because a browser choice means she
        // deliberately left the local engine.
        var usingKokoro = !!(ttsBridge && ttsBridge.speak) && !current;

        rows.forEach(function (r) {
            var isOn = r.kokoro ? (usingKokoro && r.on) : (!r.kokoro && !usingKokoro && r.name === current);
            var row = document.createElement('div');
            row.className = 'jvvRow' + (isOn ? ' on' : '');
            row.innerHTML = '<span class="jvvTick">' + (isOn ? '✓' : '') + '</span>'
                + '<span></span><small></small>';
            row.children[1].textContent = r.label;
            row.children[2].textContent = r.hint || '';
            row.addEventListener('click', function () {
                try {
                    if (r.kokoro) {
                        window.localStorage.setItem('jarvisKokoroVoice', r.kokoro);
                        // Clearing the browser preference is what routes
                        // speech back through Kokoro.
                        window.localStorage.removeItem(VOICE_PREF_KEY);
                    } else if (r.name) {
                        window.localStorage.setItem(VOICE_PREF_KEY, r.name);
                    } else {
                        window.localStorage.removeItem(VOICE_PREF_KEY);
                    }
                } catch (e) {}
                chosenVoice = null;             // re-pick with the new preference
                renderVoiceList();
                // Speak a sample immediately. Choosing a voice you cannot
                // hear is choosing blind, and the whole complaint was about
                // how it sounds.
                sample(r.kokoro || null);
            });
            box.appendChild(row);
        });
    }

    // Deliberately NOT speak(): that dispatches SPEAK_START and closes the
    // microphone, which is right for an answer and wrong for a preview.
    function sample(kokoroVoice) {
        var line = 'Two loads from Acme are still unpaid.';
        // A Kokoro preview goes through Kokoro, or she would pick a voice by
        // listening to a different one.
        if (kokoroVoice && ttsBridge && ttsBridge.speak) {
            stopKokoro();
            ttsBridge.speak(line, kokoroVoice).then(function (r) {
                if (!r || !r.ok || !r.pcm || !r.pcm.length) return;
                try {
                    var ctx = audio();
                    if (!ctx) return;
                    var pcm = r.pcm instanceof Float32Array ? r.pcm : new Float32Array(r.pcm);
                    var buf = ctx.createBuffer(1, pcm.length, r.sampleRate || 24000);
                    buf.getChannelData(0).set(pcm);
                    var src = ctx.createBufferSource();
                    src.buffer = buf;
                    src.connect(ctx.destination);
                    src.onended = function () { ttsNode = null; };
                    ttsNode = src;
                    src.start();
                } catch (e) {}
            }).catch(function () {});
            return;
        }
        if (!window.speechSynthesis) return;
        try { window.speechSynthesis.cancel(); } catch (e) {}
        var u = new SpeechSynthesisUtterance(line);
        var v = pickVoice();
        if (v) { u.voice = v; u.lang = v.lang || 'en-US'; }
        u.rate = 1.0;
        try { window.speechSynthesis.speak(u); } catch (e) {}
    }

    function openVoices() { renderVoiceList(); voiceSheet.classList.remove('hidden'); }
    function closeVoices() { voiceSheet.classList.add('hidden'); }

    function paint() {
        var open = VM.micShouldBeOpen(state);
        card.classList.toggle('speaking', !!state.speaking);
        bar.classList.toggle('live', open);
        bar.classList.toggle('hearing', !!state.capturing);
        // ── THE LABEL IS A SWITCH, NOT AN INSTRUCTION ────────────────────
        // This read "HEY JARVIS" when off, and Apsara spent a while saying
        // "Hey Jarvis" at it and reporting that nothing happened. She was
        // doing exactly what the button appeared to ask. Labelling an OFF
        // switch with the phrase the user is supposed to SAY is a trap, and it
        // was mine — the state was "Off" in small grey text beside a large
        // amber "HEY JARVIS", so the prompt shouted and the state whispered.
        //
        // The off state now names the ACTION. The on state names what to say,
        // because at that point saying it is exactly what to do.
        el('jvToggle').textContent = speechUnavailable ? 'Use Chrome'
            : state.enabled ? 'Listening'
            : (canWake ? 'Turn on voice' : 'Hold to talk');
        // The tab title, because a dot in the corner is invisible the moment
        // she switches tabs — and "is it still listening?" must be answerable
        // without coming back to look.
        document.title = open ? '🎙 ' + origTitle : origTitle;
    }

    // ── the one place effects are carried out ─────────────────────────────
    // Order matters and is the reducer's, not ours: STOP_SPEAKING before
    // START_MIC, always. Starting the microphone before the speaker is muted
    // is the entire self-trigger bug.
    function dispatch(event) {
        var r = VM.reduce(state, event);
        state = r.state;
        (r.effects || []).forEach(function (fx) {
            if (fx === 'STOP_SPEAKING') stopSpeaking();
            else if (fx === 'STOP_MIC') stopMic();
            else if (fx === 'START_MIC') { guardMode = false; startMic(); }
            // GUARD MODE. The recogniser runs, but onresult below refuses to
            // treat anything as a command unless it is a barge word that
            // survives the echo filter. Order matters and the reducer
            // guarantees it: STOP_MIC is emitted before START_GUARD_MIC.
            else if (fx === 'START_GUARD_MIC') {
                // ── THE FILTER IS THE PRICE OF ADMISSION ─────────────────
                // Found by a test that dispatched SPEAK_START directly rather
                // than calling speak(): guard mode came up with nowSpeaking
                // empty, so isOwnVoice() could never return true and the mic
                // was open during playback with NOTHING protecting it. That
                // is not a weakened invariant, it is the original bug.
                //
                // So the guard mic requires knowing the sentence. Anything
                // that starts speech without going through speak() gets the
                // old behaviour — mic shut — which is the safe direction.
                if (!nowSpeaking) {
                    console.warn('[VOICE] speech started without a transcript — no guard mic, tap to interrupt');
                    return;   // forEach callback: skip this effect, keep the rest
                }
                guardMode = true; startMic();
            }
            else if (fx === 'STOP_GUARD_MIC') { guardMode = false; stopMic(); }
            else if (fx === 'OPEN_CAPTURE') {
                // ── THE EFFECT IS WHAT OPENS IT ──────────────────────────
                // dispatch('WAKE_HEARD') emits OPEN_CAPTURE, and THIS line
                // opens the capture — so the follow-up path calling
                // openCapture({ack:false}) itself opened a second one and
                // chimed anyway. Two openings, one chime, and my ack:false
                // was on the call that did not matter.
                //
                // The suppression is a one-shot flag consumed here, so the
                // decision belongs to whoever dispatched rather than to a
                // second call racing the effect.
                var quiet = suppressAck; suppressAck = false;
                var hint = pendingHint; pendingHint = '';
                openCapture(pendingSeed
                    ? { ack: !quiet, seed: pendingSeed, hint: hint }
                    : { ack: !quiet, hint: hint });
                pendingSeed = '';
            }
        });
        paint();
    }

    // ── speaking ──────────────────────────────────────────────────────────
    function stopSpeaking() {
        // BOTH engines. Adding Kokoro without adding it here would have been
        // a genuinely dangerous omission: STOP_SPEAKING is the effect that
        // guarantees Jarvis is silent before the microphone reopens, and a
        // version that only silenced the browser voice would leave Kokoro
        // audible into an open mic — the self-triggering loop that
        // voice-machine.js exists to prevent, reintroduced through the back
        // door by a new speaker.
        try { window.speechSynthesis.cancel(); } catch (e) {}
        stopKokoro();
    }
    // ── WHICH VOICE IT ANSWERS IN ────────────────────────────────────────
    // Apsara, 2026-09-06: "the jarvis voice looks more robot."
    //
    // It was, and nothing here was choosing it. speechSynthesis.speak() with
    // no `voice` set uses the platform default, which on macOS is one of the
    // old compact system voices — the 1990s-sounding ones. The good voices
    // are installed and sitting right there unused, which is the same class
    // of mistake as leaving a downloaded Whisper model on disk.
    //
    // Ordered by how a person actually sounds, best first. Novelty and
    // legacy voices are excluded outright: "Fred" and friends are the source
    // of the robot impression, and no rate or pitch tweak rescues them.
    var VOICE_WISHLIST = [
        'Google US English',        // Chrome's own — the most natural available
        'Samantha',                 // macOS, the Siri-adjacent one
        'Ava', 'Allison', 'Susan', 'Nicky', 'Zoe',
        'Karen', 'Moira', 'Tessa',  // en-AU / en-IE / en-ZA, all modern
        'Alex',                     // older but far better than the default
    ];
    var chosenVoice = null;

    // Her choice, remembered. Stored by NAME rather than by index, because
    // the order of getVoices() is not stable across launches — an index
    // would silently become a different voice one morning.
    var VOICE_PREF_KEY = 'jarvisVoiceName';
    function savedVoiceName() {
        try { return window.localStorage.getItem(VOICE_PREF_KEY) || ''; } catch (e) { return ''; }
    }

    function pickVoice() {
        if (chosenVoice) return chosenVoice;
        var list = [];
        try { list = window.speechSynthesis.getVoices() || []; } catch (e) { return null; }
        if (!list.length) return null;      // not loaded yet; see voiceschanged

        // ── WHAT SHE PICKED BEATS WHAT I RANKED ──────────────────────────
        // The wishlist below is my opinion about which voices sound human.
        // It is only a default. If she has chosen one, that is the answer,
        // and no amount of my ordering should override it.
        var want = savedVoiceName();
        if (want) {
            var mine = list.filter(function (v) { return v.name === want; })[0];
            if (mine) {
                chosenVoice = mine;
                console.log('[VOICE] speaking as "' + mine.name + '" (your choice)');
                return chosenVoice;
            }
            // Chosen on another machine, or the voice was removed. Fall
            // through to the default rather than going silent.
        }

        var english = list.filter(function (v) { return /^en(-|_|$)/i.test(v.lang || ''); });
        var pool = english.length ? english : list;

        // "Premium" and "Enhanced" are Apple's high-quality downloads and beat
        // anything on the wishlist, so they are checked first.
        var best = pool.filter(function (v) { return /(premium|enhanced)/i.test(v.name || ''); })[0];

        if (!best) {
            for (var i = 0; i < VOICE_WISHLIST.length && !best; i += 1) {
                /* eslint-disable no-loop-func */
                best = pool.filter(function (v) {
                    return String(v.name || '').toLowerCase().indexOf(VOICE_WISHLIST[i].toLowerCase()) === 0;
                })[0];
                /* eslint-enable no-loop-func */
            }
        }
        // Last resort: anything English that is not a novelty voice. The
        // compact ones are exactly what she is complaining about.
        if (!best) {
            best = pool.filter(function (v) {
                return !/(compact|novelty|bad news|good news|bells|bubbles|cellos|organ|trinoids|whisper|zarvox|albert|jester|bahh|boing|wobble|superstar)/i
                    .test(String(v.name || ''));
            })[0];
        }
        chosenVoice = best || pool[0] || null;
        if (chosenVoice) console.log('[VOICE] speaking as "' + chosenVoice.name + '"');
        return chosenVoice;
    }

    // The voice list is populated ASYNCHRONOUSLY. Called once at load it is
    // routinely empty, which is why a naive implementation silently keeps the
    // default for ever — the exact bug being fixed.
    try {
        if (window.speechSynthesis) {
            window.speechSynthesis.onvoiceschanged = function () { chosenVoice = null; pickVoice(); };
            pickVoice();
        }
    } catch (e) {}

    // ── KOKORO, WHEN THE DESKTOP APP PROVIDES IT ─────────────────────────
    // The browser's speech engine has a hard ceiling in Electron — Chromium
    // matches macOS voices by NAME, so Premium and Compact "Samantha" are
    // indistinguishable and the compact one always wins. No amount of
    // picking gets past that. So the desktop app brings its own
    // synthesiser and the page uses it when it is there.
    //
    // Played through an AudioContext rather than an <audio> element: the
    // main process returns raw Float32 samples, and encoding a WAV there
    // only to decode it here would be two conversions for nothing.
    var ttsBridge = window.jarvisTTS || null;
    var ttsCtx = null;
    var ttsNode = null;

    function stopKokoro() {
        try { if (ttsNode) { ttsNode.onended = null; ttsNode.stop(); } } catch (e) {}
        ttsNode = null;
    }

    // Returns true if it took the job. Returns false — synchronously — if it
    // cannot, so the caller can fall back without waiting on a promise that
    // may never settle.
    function speakLocal(text, onDone) {
        if (!ttsBridge || !ttsBridge.speak) return false;
        var voice = null;
        try { voice = window.localStorage.getItem('jarvisKokoroVoice') || null; } catch (e) {}
        ttsBridge.speak(String(text).slice(0, 600), voice).then(function (r) {
            if (!r || !r.ok || !r.pcm || !r.pcm.length) {
                // NOT silent. The fallback runs, and the reason is on record.
                console.warn('[VOICE] local voice failed, using the browser voice —',
                    (r && r.error) || 'no audio');
                speakBrowser(text, onDone);
                return;
            }
            try {
                var ctx = audio();
                if (!ctx) { speakBrowser(text, onDone); return; }
                var pcm = r.pcm instanceof Float32Array ? r.pcm : new Float32Array(r.pcm);
                var buf = ctx.createBuffer(1, pcm.length, r.sampleRate || 24000);
                buf.getChannelData(0).set(pcm);
                stopKokoro();
                var src = ctx.createBufferSource();
                src.buffer = buf;
                src.connect(ctx.destination);
                src.onended = function () { ttsNode = null; onDone(); };
                ttsNode = src;
                src.start();
            } catch (e) {
                console.warn('[VOICE] could not play local audio —', e && e.message);
                speakBrowser(text, onDone);
            }
        }).catch(function (e) {
            console.warn('[VOICE] local voice threw, using the browser voice —', e && e.message);
            speakBrowser(text, onDone);
        });
        return true;
    }

    function speakBrowser(text, onDone) {
        if (!window.speechSynthesis) { onDone(); return; }
        var u = new SpeechSynthesisUtterance(String(text).slice(0, 600));
        var v = pickVoice();
        if (v) { u.voice = v; u.lang = v.lang || 'en-US'; }
        // Slightly under natural pace. The old 1.05 on a compact voice was
        // part of the robot impression: the poorer the voice, the worse it
        // sounds hurried.
        u.rate = 1.0;
        u.pitch = 1.0;
        // Both paths end the speaking state. Without the error handler a
        // failed utterance would leave `speaking` true for ever and the
        // microphone would never reopen — the feature would simply stop
        // working with nothing on screen to explain it.
        u.onend = onDone;
        u.onerror = onDone;
        try { window.speechSynthesis.speak(u); } catch (e) { onDone(); }
    }

    // ── THE ECHO FILTER ──────────────────────────────────────────────────
    // We know what Jarvis is saying, so we can recognise it coming back. A
    // recogniser fed a loudspeaker returns a mangled, partial version of the
    // sentence — so this compares WORDS, not strings, and calls it our own
    // voice when most of what was heard also appears in what is being said.
    //
    // The threshold matters in one direction much more than the other. Too
    // strict and a self-trigger gets through, which is the loop. Too loose
    // and she loses a barge-in, which costs her one tap. So it is deliberately
    // generous: three-in-five overlapping words is enough to discard.
    //
    // Short utterances are the hard case — "stop" is one word and could
    // appear in the reply. Barge words are therefore checked BEFORE this in
    // onresult only for the wake word; a bare stop word that also appears in
    // the sentence being spoken is treated as echo, because a false stop is
    // recoverable and a false command is not.
    function normWords(t) {
        return String(t || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/).filter(function (w) { return w.length > 1; });
    }
    // `against` is an argument so the filter can be tested on its own. It
    // defaults to whatever is being spoken right now, which is every real
    // call — but a rule this load-bearing should be checkable without having
    // to drive a speech synthesiser to get at it.
    function isOwnVoice(heard, against) {
        var src = against === undefined ? nowSpeaking : against;
        if (!src) return false;
        var mine = normWords(src);
        var got = normWords(heard);
        if (!got.length || !mine.length) return false;
        var set = {};
        for (var i = 0; i < mine.length; i += 1) set[mine[i]] = true;
        var hits = 0;
        for (var j = 0; j < got.length; j += 1) if (set[got[j]]) hits += 1;
        return (hits / got.length) >= 0.6;
    }

    function speak(text) {
        // Recorded BEFORE the dispatch, so the guard mic that opens a moment
        // later already knows what it is about to hear itself say.
        nowSpeaking = String(text || '');
        selfTriggers = 0;
        dispatch('SPEAK_START');           // closes the mic BEFORE any audio
        // EXACTLY ONE dispatch of SPEAK_END, whichever engine runs and
        // however it ends. Two would reopen the microphone while Jarvis is
        // still talking, which is the self-triggering loop this whole
        // feature is built around preventing; zero would leave `speaking`
        // true for ever and the mic shut permanently.
        var done = false;
        // ── AN OPEN QUESTION KEEPS THE MICROPHONE OPEN ───────────────────
        // Apsara, 2026-09-07: "it is not waiting for follow up. i have to say
        // hey jarvis..then this loop restarts"
        //
        // Jarvis asked "What material?" and then STOPPED LISTENING. She had
        // to say the wake word again to answer a question it had just asked
        // — which is not how anyone talks, and worse, saying "Hey Jarvis"
        // again felt like starting over.
        //
        // A person who asks a question does not need to be addressed by name
        // to hear the answer. So when the server says it is waiting for one,
        // the microphone reopens the instant Jarvis stops speaking, and the
        // wake word is not required.
        //
        // It reopens ONCE, and silence ends it: finishCapture() with nothing
        // heard falls back to "Say Hey Jarvis" and stops. That is what stops
        // an unanswered question from holding the microphone open for ever.
        var finish = function () {
            if (done) return; done = true;
            dispatch('SPEAK_END');
            if (awaitingReply) {
                awaitingReply = false;
                // Guarded on the same conditions as a wake: she has not
                // switched the assistant off, and the tab is in front. A
                // microphone opening in a background tab is the thing the
                // foreground check exists to prevent, and an open question
                // is not a reason to make an exception.
                // `state.foreground`, NOT a bare `foreground` — which is what
                // I wrote first, and it does not exist. It would have thrown
                // a ReferenceError inside the speak-finish handler, on the
                // one path that reopens the microphone, and node --check sees
                // nothing wrong with it.
                if (state.enabled && state.foreground && !speechUnavailable) {
                    console.log('[VOICE] question outstanding — listening again without the wake word');
                    // ack suppressed — Jarvis asked the question, so it is
                    // not being addressed and has nothing to acknowledge.
                    lastAsked = '';
                    suppressAck = true;
                    dispatch('WAKE_HEARD');
                }
            } else if (followUpMode && state.enabled && state.foreground && !speechUnavailable) {
                // ── ALEXA'S FOLLOW-UP MODE ───────────────────────────────
                // Apsara, 2026-09-07: "mimic siri behaviour/alexa's."
                //
                // Alexa keeps the microphone open for about five seconds
                // after ANY answer, not only after a question, so "and what
                // about Houston?" does not need the wake word again. Jarvis
                // only reopened when the SERVER said it was waiting for
                // something, which covers a question it asked and nothing
                // else — every ordinary answer ended the conversation.
                //
                // PASSIVE, and the distinction matters. Nothing was asked of
                // her, so silence here is the normal outcome and must close
                // quietly: no chime, no "didn't catch that", no retry. That
                // retry exists for an outstanding question, and firing it
                // after an ordinary answer would nag her for not speaking.
                console.log('[VOICE] follow-up window open — no wake word needed');
                // lastAsked is deliberately NOT cleared here, unlike the
                // question branch above. It is what the continuation window
                // joins a resumed half-sentence to, and wiping it turned
                // "21 MT of copper at 8450" into a fragment with no subject.
                // The question branch clears it because a fresh answer to a
                // question is a new sentence; a follow-up is not.
                suppressAck = true;
                passiveCapture = true;
                dispatch('WAKE_HEARD');
            }
        };
        if (speakLocal(text, finish)) return;
        speakBrowser(text, finish);
    }

    // ── the recogniser ────────────────────────────────────────────────────
    function startMic() {
        if (!SR || rec || speechUnavailable) return;
        rec = new SR();
        rec.continuous = canWake;
        rec.interimResults = true;
        rec.lang = 'en-US';

        rec.onresult = function (ev) {
            var txt = '';
            for (var i = ev.resultIndex; i < ev.results.length; i += 1) txt += ev.results[i][0].transcript;
            txt = txt.trim();
            if (!txt) return;
            // The engine just worked. Whatever went wrong before was
            // transient, and the count must not creep up over a long session
            // until one bad afternoon latches the feature off.
            networkErrors = 0;

            // ── WHILE JARVIS IS TALKING ──────────────────────────────
            // Everything here is thrown away unless it is a deliberate
            // interruption. This is the branch that makes barge-in safe
            // rather than a feedback loop.
            // ── SHE CARRIED ON TALKING, INTO AN OPEN FOLLOW-UP WINDOW ───
            // Alexa's follow-up window and the continuation window collided,
            // and the test caught it: with a passive capture already open,
            // her resumed half-sentence no longer reached the "she carried on
            // talking" branch below — that branch only runs when NOTHING is
            // capturing. So "21 MT of copper at 8450 per MT" arrived as a
            // fragment with no subject, which is the exact bug the
            // continuation window was built to fix, reintroduced by a feature
            // added on top of it.
            //
            // Inside the grace period the passive window behaves like no
            // window at all: the tail is joined to what she just asked. After
            // it, a follow-up is a follow-up and stands alone — which is why
            // this is bounded by CONTINUE_MS rather than lasting the whole
            // five seconds.
            if (state.capturing && capturePassive && !capturePrefix
                && lastAsked && (Date.now() - lastAskedAt) < CONTINUE_MS
                && !WAKE.test(txt) && !isOwnVoice(txt)) {
                console.log('[VOICE] continuing into the follow-up window: "' + lastAsked + '" + "' + txt + '"');
                capturePrefix = lastAsked;
                lastAsked = '';
            }

            if (guardMode) {
                if (isOwnVoice(txt)) {
                    // Jarvis hearing Jarvis. Counted, because twice in a row
                    // means the echo filter is losing and the honest response
                    // is to stop rather than to keep trying.
                    selfTriggers += 1;
                    console.warn('[VOICE] guard heard our own voice ('
                        + selfTriggers + '/' + SELF_TRIGGER_LIMIT + '): "' + txt.slice(0, 60) + '"');
                    if (selfTriggers >= SELF_TRIGGER_LIMIT) {
                        console.warn('[VOICE] barge-in latched OFF for this session — tap the card or press Esc');
                        say('Tap to interrupt');
                        dispatch('BARGE_SELF_TRIGGERED');
                    }
                    return;
                }
                if (WAKE.test(txt) || BARGE_WORDS.test(txt)) {
                    // A real interruption. Anything she said AFTER the stop
                    // word is carried into the capture as a seed, so "stop —
                    // make it FOB instead" does not lose the instruction.
                    selfTriggers = 0;
                    var tail = txt.replace(WAKE, '').replace(BARGE_WORDS, '').trim();
                    if (tail) pendingSeed = tail;
                    suppressAck = true;
                    console.log('[VOICE] barge-in: "' + txt.slice(0, 60) + '"');
                    interrupt();
                }
                // Anything else while speaking is ignored outright. Not
                // buffered, not queued: she was talking over an answer and
                // did not ask for anything.
                return;
            }

            if (state.capturing) {
                heardDuringCapture = capturePrefix ? (capturePrefix + ' ' + txt) : txt;
                // SHE HAS SPOKEN. From here the short end-of-utterance window
                // applies; before this, the long waiting-to-start one did.
                heardAnything = true;
                // She is still talking, so the clock starts again. This is
                // the whole fix for being cut off: the window measures
                // SILENCE, not elapsed time.
                armCaptureTimers();
                // ── THE TRANSCRIPT GOES IN THE CARD, NOT THE PILL ────────
                // Apsara, 2026-09-06: "the transcription is also cut into
                // half - not wrapping."
                //
                // Same bug as the answer, second location, and I fixed only
                // the first. This wrote what she was saying into the status
                // pill after slice(0, 44) — a single-line flex row with no
                // wrapping — so anything longer than about six words was
                // cut off mid-sentence while she was still speaking.
                //
                // The card wraps and scrolls. The pill goes back to being
                // what it is good at: one word of state.
                say('Listening');
                showCard(txt, '', true);
                return;
            }
            // ── SHE CARRIED ON TALKING ───────────────────────────────
            // Not capturing, but she spoke within the continuation window of
            // a question that just went out. That is the tail of the sentence
            // the capture cut short, not a new request.
            //
            // Guarded on the wake word being ABSENT: "Hey Jarvis, ..." is
            // unambiguously a fresh start, whatever the timing.
            if (lastAsked && (Date.now() - lastAskedAt) < CONTINUE_MS
                && !WAKE.test(txt) && state.enabled) {
                var joined = (lastAsked + ' ' + txt).trim();
                console.log('[VOICE] continuing: "' + lastAsked + '" + "' + txt + '"');
                lastAsked = '';
                interrupt();          // stop the reply to the half sentence
                suppressAck = true;
                pendingSeed = joined;
                dispatch('WAKE_HEARD');
                return;
            }

            // Not capturing: the only thing worth hearing is the wake word.
            //
            // ── AND IT SAYS WHICH WAY IT WENT ────────────────────────────
            // This was one line with no else. When Apsara said "Hey Jarvis"
            // and the recogniser returned "I'll see you later", the wake
            // simply did not fire and NOTHING WAS PRINTED — the fifth place
            // in this feature where a decision was taken in silence. From
            // where she sat, a mis-transcription and a dead microphone
            // looked identical. They need completely different fixes.
            var isScout = WAKE_SCOUT.test(txt);
            if (WAKE.test(txt) || isScout) {
                // Scout only when Jarvis was NOT also named — "hey jarvis,
                // ask scout about the loads" addresses Jarvis.
                addressed = (isScout && !WAKE.test(txt)) ? 'scout' : 'jarvis';
                console.log('[VOICE] ' + AGENT_LOOK[addressed].name
                    + ' — listening for your command');
                dispatch('WAKE_HEARD');
            } else {
                console.log('[VOICE] no wake word in "' + txt + '" — say "Jarvis" to start');
            }
        };

        rec.onerror = function (ev) {
            var err = ev && ev.error;
            if (err === 'not-allowed' || err === 'service-not-allowed') {
                // Continuing to show "Listening" without permission is a lie,
                // and the reducer treats it as switching the setting off.
                dispatch('PERMISSION_DENIED');
                say('Microphone blocked — allow it in the address bar.');
                return;
            }
            // ── 'network' MEANS THE ENGINE IS NOT AVAILABLE AT ALL ────────
            // Found on Apsara's Mac, 2026-09-06, by opening devtools in the
            // desktop app rather than reasoning about it. The console said:
            //   SR exists: true / MIC STARTED / SPEECH ERROR: network / MIC ENDED
            //
            // Speech recognition in Chrome is a GOOGLE SERVICE, not a browser
            // feature. Chrome ships private API keys for it; Electron's
            // Chromium does not have them and is not permitted to. So the API
            // exists, starts, fails instantly and stops — for ever, on every
            // attempt.
            //
            // I had justified the whole desktop app with "Electron bundles
            // Chromium so the wake word works". That was wrong: Chromium is
            // not Chrome for this API. No amount of configuration fixes it.
            //
            // So this is treated as a HARD CAPABILITY FAILURE rather than a
            // transient error. Retrying would spin for ever while the pill
            // said "Listening", which is the same lie the old "HEY JARVIS"
            // label told — the UI claiming a state that is not true.
            if (err === 'engine') {
                // The LOCAL engine failed — a missing model, usually. It says
                // what is wrong; repeating "use Chrome" here would be advice
                // for a different problem.
                say('Speech engine: ' + (ev.message || 'failed'));
                console.warn('[VOICE] local engine error:', ev.message);
                dispatch('RECOGNISER_STOPPED');
                return;
            }
            // ── ONE "network" IS NOT A VERDICT ───────────────────────────
            // Apsara, 2026-09-06: "when while on chrome - it shows me Voice
            // needs Google Chrome — this app cannot do speech."
            //
            // In real Chrome that message is simply wrong, and it was my
            // logic being too harsh. I wrote this latch for ELECTRON, where
            // "network" means there is no speech engine at all and never
            // will be — a permanent, unrecoverable fact. But Chrome's
            // recogniser is a remote Google service, and it returns
            // "network" for ordinary transient things: a moment of poor
            // connectivity, the service briefly refusing, a tab waking from
            // sleep. Latching on the FIRST one turns a hiccup into a dead
            // feature with a message telling her to use the browser she is
            // already using.
            //
            // Repetition is what separates the two. A genuine absence of an
            // engine fails EVERY time, immediately; a hiccup does not. So it
            // takes three in a row, and any successful result resets the
            // count.
            if (err === 'network' && !LOCAL) {
                networkErrors += 1;
                if (networkErrors < NETWORK_ERRORS_BEFORE_GIVING_UP) {
                    console.warn('[VOICE] speech service returned "network" ('
                        + networkErrors + '/' + NETWORK_ERRORS_BEFORE_GIVING_UP + ') — retrying');
                    say('Reconnecting…');
                    dispatch('RECOGNISER_STOPPED');   // the reducer restarts it
                    return;
                }
                speechUnavailable = true;
                dispatch('USER_DISABLE');
                say('Voice needs Google Chrome — this app cannot do speech');
                console.warn('[VOICE] SpeechRecognition returned "network" '
                    + networkErrors + ' times in a row. This build has no speech '
                    + 'engine (Electron ships Chromium without Google\'s speech API keys). '
                    + 'Open https://jarvis.edgemetals.com in Google Chrome for the wake word.');
                return;
            }
            // 'no-speech' and 'aborted' are ordinary in a quiet room.
            dispatch('RECOGNISER_STOPPED');
        };
        // Chrome stops the recogniser on its own, constantly. RECOGNISER_STOPPED
        // changes no setting; the reducer's derived rule restarts it if it
        // should still be open.
        rec.onend = function () { rec = null; dispatch('RECOGNISER_STOPPED'); };

        try { rec.start(); say(canWake ? 'Say “Hey Jarvis”' : 'Listening…'); }
        catch (e) { rec = null; }
    }

    function stopMic() {
        if (!rec) return;
        var r = rec; rec = null;
        try { r.onend = null; r.stop(); } catch (e) {}
    }

    // ── "Mm-hm" — the sound that says it is listening ────────────────────
    // Apsara, 2026-09-06: "When i say Hey Jarvis, it should speak back HMM..
    // acknowldegeing that it is listening."
    //
    // There WAS an acknowledgement here. It played a base64 WAV whose data
    // chunk is zero bytes long — literally silence. So the intent existed
    // and the sound never did, and the only feedback was three small grey
    // characters changing in a pill.
    //
    // WHY IT IS NOT ROUTED THROUGH speak()
    // ------------------------------------
    // Because speak() dispatches SPEAK_START, which CLOSES THE MICROPHONE —
    // correctly, that is the rule that stops Jarvis hearing itself. But an
    // acknowledgement whose whole job is "go ahead, I'm listening" must not
    // deafen the thing while she goes ahead. Siri overlaps its chime with
    // listening for exactly this reason.
    //
    // So the ack plays OUTSIDE the state machine, the mic stays open, and
    // the recogniser is told to ignore audio for precisely as long as the
    // sound lasts. We know that length exactly, because we generated it —
    // which is a far better defence than hoping echo cancellation catches
    // it. Without that, the first thing Whisper hears every single time is
    // Jarvis humming, and "Mm-hm" becomes the command.
    // One per assistant. Two voices, two cached buffers — a shared one
    // would mean Scout answering in Jarvis's voice, which is precisely the
    // signal she asked for.
    var ackBuf = { jarvis: null, scout: null };
    var ackPcm = null;          // kept for the tone fallback path
    var ackRate = 24000;

    // ── AN AUDIOCONTEXT STARTS STOPPED ───────────────────────────────────
    // Apsara asked for the acknowledgement twice, which is how this was
    // found: it was built, committed, and made no sound.
    //
    // Browsers create an AudioContext in state "suspended" and will not run
    // it until a USER GESTURE resumes it. Every AudioContext here was being
    // created lazily inside playAck() — triggered by the wake word, which is
    // not a gesture — so it was born suspended and stayed that way. The
    // nodes connected, start() was called, no exception was thrown, and
    // nothing was ever heard. Autoplay policy failing closed and silently is
    // exactly the shape of bug this whole day has been about.
    //
    // Two halves to the fix: create it during the toggle CLICK, which is a
    // real gesture, and resume it before every use in case the browser
    // suspended it again (they do, on tab hide).
    function audio() {
        try {
            if (!ttsCtx) ttsCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (ttsCtx.state === 'suspended' && ttsCtx.resume) {
                ttsCtx.resume().catch(function () {});
            }
            return ttsCtx;
        } catch (e) { return null; }
    }

    // Rendered ONCE, at startup, not on every wake. Kokoro takes a few
    // hundred milliseconds, which is fine to spend at boot and hopeless in
    // the gap between her saying the name and expecting a reply.
    // ── THE SERVER ALREADY SYNTHESISES THIS ──────────────────────────────
    // Apsara, twice: "it is not talking back with Hmm". She was hearing the
    // fallback tone, because the spoken version came only from Kokoro — which
    // exists in the desktop app and nowhere else, and only once its 86MB
    // model has downloaded.
    //
    // /api/voice/phrase/ack has been there all along: Gemini's voice,
    // synthesised once and cached on disk as a WAV, built precisely for "the
    // 'Yes?' that comes back when she says Hey Jarvis". It works in the
    // browser AND the desktop app, needs no local model, and is the same
    // voice Jarvis answers in.
    //
    // Order of preference: the server's voice, then Kokoro, then the tone.
    // The tone is the last resort rather than the first, which is the wrong
    // way round from how it was built.
    function warmAck() {
        // GUARDED, because this runs during mount. An exception here — no
        // fetch, a blocked request, a CSP rule — would abort mount partway
        // and leave the voice bar on screen with no click handler attached:
        // a switch that does nothing, over a missing acknowledgement. Found
        // by the test harness, which has no fetch, and it would have been
        // true of any browser without one.
        // window.fetch, not bare `fetch`. A bare reference walks the scope
        // chain and finds whatever is outside the page — which is how this
        // came to be untestable: the harness deleted window.fetch and the
        // lookup quietly found Node's global instead.
        //
        // HONEST NOTE ON THIS BRANCH: it is redundant. The try/catch below
        // already turns a missing fetch into the local fallback, and a
        // mutation removing this check survives the suite for that reason —
        // not because the suite is weak. It is kept for the clearer log
        // line, and recorded here so nobody spends an hour writing a test
        // that cannot fail.
        if (typeof window.fetch !== 'function') {
            console.log('[VOICE] no fetch — acknowledgement will use the local voice or the tone');
            warmAckLocal();
            return;
        }
        try { warmAckFromServer(); } catch (e) { warmAckLocal(); }
    }

    function warmAckLocal() {
        if (!ttsBridge || !ttsBridge.speak) return;
        ttsBridge.speak('Mm hm?', null).then(function (r) {
            if (r && r.ok && r.pcm && r.pcm.length) {
                ackPcm = r.pcm instanceof Float32Array ? r.pcm : new Float32Array(r.pcm);
                ackRate = r.sampleRate || 24000;
                console.log('[VOICE] acknowledgement ready — Kokoro, '
                    + Math.round((ackPcm.length / ackRate) * 1000) + 'ms');
            }
        }).catch(function () {});
    }

    function warmAckFromServer() {
        // fetch, not api(): this returns a WAV, not JSON.
        // BOTH assistants, each in its own voice. cacheKey() on the server
        // already includes the voice and its style prompt, so the two never
        // collide on disk.
        Object.keys(AGENT_LOOK).forEach(function (who) {
            var v = AGENT_LOOK[who].voice;
            window.fetch('/api/voice/phrase/ack?voice=' + encodeURIComponent(v),
                { credentials: 'same-origin' })
                .then(function (r) { return r.ok ? r.arrayBuffer() : Promise.reject(new Error('HTTP ' + r.status)); })
                .then(function (buf) {
                    var ctx = audio();
                    if (!ctx) return Promise.reject(new Error('no audio context'));
                    return ctx.decodeAudioData(buf);
                })
                .then(function (decoded) {
                    ackBuf[who] = decoded;
                    if (who === 'jarvis') { ackPcm = decoded.getChannelData(0); ackRate = decoded.sampleRate; }
                    console.log('[VOICE] ' + AGENT_LOOK[who].name + ' acknowledgement ready — '
                        + Math.round(decoded.duration * 1000) + 'ms, ' + v);
                })
                .catch(function (e) {
                    // NAMED, AND LOUD. Apsara, 2026-09-06: "scout is
                    // answering back with proper mm hmm while jarvis
                    // doesnt." One assistant working and the other not is
                    // information, and it was being logged at the same
                    // level as everything else and lost. Whichever one fails
                    // now says so with its voice, its URL and the reason.
                    console.warn('[VOICE] ' + AGENT_LOOK[who].name
                        + ' acknowledgement FAILED (voice ' + v + '): '
                        + (e && e.message)
                        + ' — /api/voice/phrase/ack?voice=' + v);
                    // ONE retry. The first request for a voice that was not
                    // pre-warmed at boot has to synthesise it, and that can
                    // outrun a cold request while the cached one returns
                    // instantly — which is exactly the shape of "one works,
                    // the other does not".
                    setTimeout(function () {
                        if (ackBuf[who]) return;
                        window.fetch('/api/voice/phrase/ack?voice=' + encodeURIComponent(v),
                            { credentials: 'same-origin' })
                            .then(function (r) { return r.ok ? r.arrayBuffer() : Promise.reject(new Error('HTTP ' + r.status)); })
                            .then(function (buf) { var c = audio(); return c ? c.decodeAudioData(buf) : Promise.reject(new Error('no ctx')); })
                            .then(function (decoded) {
                                ackBuf[who] = decoded;
                                console.log('[VOICE] ' + AGENT_LOOK[who].name
                                    + ' acknowledgement ready on retry — ' + v);
                            })
                            .catch(function (e2) {
                                console.warn('[VOICE] ' + AGENT_LOOK[who].name
                                    + ' acknowledgement still failing: ' + (e2 && e2.message));
                                if (who === 'jarvis') warmAckLocal();
                            });
                    }, 2500);
                });
        });
    }

    // A two-note hum, synthesised on the spot. This is the fallback for the
    // website, where there is no local synthesiser — and it is genuinely
    // better than a TTS call there, because speechSynthesis takes long
    // enough to start that the acknowledgement would arrive after she had
    // already begun speaking. Falling then rising is the shape of a spoken
    // "mm-hm"; a single flat beep reads as an error tone.
    function humAck(ctx) {
        var t0 = ctx.currentTime;
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(300, t0);
        osc.frequency.setValueAtTime(255, t0 + 0.13);
        osc.frequency.setValueAtTime(340, t0 + 0.26);
        // Shaped rather than switched: an abrupt start and stop on a sine
        // is an audible click at both ends.
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.03);
        gain.gain.setValueAtTime(0.18, t0 + 0.34);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.40);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(t0); osc.stop(t0 + 0.42);
        return 420;
    }

    // ── THE SECOND TONE: "I have stopped listening" ─────────────────────
    // Apsara, 2026-09-07: "mimic siri behaviour/alexa's."
    //
    // Siri plays two different sounds — one when it starts listening, one
    // when it stops. Jarvis had only the first, so the end of a capture was
    // silent and the only signal was three grey characters in a pill she is
    // not looking at while she talks.
    //
    // DELIBERATELY DIFFERENT IN SHAPE, not just pitch: the open tone rises,
    // this one falls, in two notes and half the length. Someone who cannot
    // hear the difference between 300Hz and 340Hz can still hear one going up
    // and one going down.
    function humDone(ctx) {
        var t0 = ctx.currentTime;
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(360, t0);
        osc.frequency.setValueAtTime(270, t0 + 0.09);
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.13, t0 + 0.02);
        gain.gain.setValueAtTime(0.13, t0 + 0.14);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.20);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(t0); osc.stop(t0 + 0.22);
        return 220;
    }

    // Played when a capture that actually HEARD something closes. Not on an
    // empty one: a tone for "I heard nothing" is a noise that tells her the
    // opposite of what happened, and the passive follow-up window closes
    // empty most of the time by design.
    function playDone() {
        try {
            var ctx = audio();
            if (ctx) humDone(ctx);
        } catch (e) { /* an inaudible earcon is not worth an exception */ }
    }

    function playAck() {
        var ms = 420;
        try {
            var ctx = audio();
            if (!ctx) return 0;
            // The assistant she CALLED, not a default. Hearing a different
            // voice is the fastest possible confirmation that the right one
            // is listening — faster than reading anything.
            // Prefer the assistant she called. Failing that, the OTHER
            // one's voice — wrong voice is a far smaller problem than no
            // acknowledgement at all, which reads as "it did not hear me"
            // and makes her say it again. The tone is the last resort, and
            // any substitution says so.
            var decoded = ackBuf[addressed] || null;
            if (!decoded) {
                var other = addressed === 'jarvis' ? 'scout' : 'jarvis';
                if (ackBuf[other]) {
                    decoded = ackBuf[other];
                    console.warn('[VOICE] ' + AGENT_LOOK[addressed].name
                        + ' has no acknowledgement — using ' + AGENT_LOOK[other].name + "'s");
                }
            }
            var pcmNow = decoded ? decoded.getChannelData(0) : ackPcm;
            var rateNow = decoded ? decoded.sampleRate : ackRate;
            if (pcmNow) {
                var buf = ctx.createBuffer(1, pcmNow.length, rateNow);
                buf.getChannelData(0).set(pcmNow);
                var src = ctx.createBufferSource();
                src.buffer = buf;
                src.connect(ctx.destination);
                src.start();
                ms = Math.round((pcmNow.length / rateNow) * 1000);
            } else {
                ms = humAck(ctx);
            }
        } catch (e) { /* an inaudible ack is not worth an exception */ }

        // Deafen the recogniser for exactly the length of the sound, plus a
        // small tail for the speaker settling. This is why the ack can play
        // with the microphone open at all.
        try {
            if (rec && typeof rec.ignoreFor === 'function') rec.ignoreFor(ms + 120);
        } catch (e) {}
    }

    // ── THE CHIME ANSWERS THE WAKE WORD, NOTHING ELSE ────────────────────
    // Apsara, 2026-09-07: "everytime on follow ups i dont want mm hmm sound.
    // only on hey jarvis."
    //
    // The acknowledgement exists to say "I heard you call me" — it is an
    // answer to being addressed. On a follow-up she was not addressing
    // anything; Jarvis had just asked HER a question and the mic reopened by
    // itself. Chiming there is the assistant clearing its throat before
    // listening to an answer it asked for, which is noise.
    //
    // `seed` carries a half-finished sentence in from the continuation path
    // below, so the capture resumes rather than restarting.
    function openCapture(opts) {
        var o = opts || {};
        // ── THE SEED IS A PREFIX, NOT AN INITIAL VALUE ───────────────────
        // Setting heardDuringCapture alone was useless: the recogniser's very
        // next result does `heardDuringCapture = txt`, which OVERWRITES it.
        // So the half-sentence she was continuing survived only as long as
        // she stayed silent — i.e. never, since she had just started talking
        // again. Kept separately and prepended on every result instead.
        capturePrefix = o.seed ? String(o.seed).trim() : '';
        heardDuringCapture = capturePrefix;
        // A seed means she HAS already spoken — this is the tail of a sentence
        // she is resuming, so the short silence window is the right one. With
        // no seed she has not said anything yet and gets the long one.
        heardAnything = !!capturePrefix;
        // `ack:false` is only ever passed when Jarvis asked the question and
        // reopened the mic itself. That is exactly the case where dropping her
        // turn in silence is worst, because the question stays open and she
        // has no way to tell it was lost.
        captureWasFollowUp = (o.ack === false);
        // A passive window is NOT a follow-up to a question — see the retry
        // in finishCapture, which must not fire for one.
        capturePassive = passiveCapture; passiveCapture = false;
        if (capturePassive) captureWasFollowUp = false;
        say(o.hint || 'Listening');
        paintAgent(addressed);
        // A PASSIVE WINDOW LEAVES THE ANSWER ON SCREEN. Caught by a test:
        // opening the follow-up capture replaced the reply she had just been
        // given with "Go ahead…" a few milliseconds after it appeared. The
        // window is a convenience running quietly underneath; it is not a new
        // prompt, and it must not take the screen away from her.
        if (!capturePassive) {
            showCard(o.seed || '', o.seed ? '' : (o.hint ? o.hint + ' \u2014 go ahead' : 'Go ahead\u2026'), true);
        }
        if (o.ack !== false) playAck();
        armCaptureTimers();
    }

    // ── IT MUST NOT CUT HER OFF MID-SENTENCE ─────────────────────────────
    // Apsara, 2026-09-07: "at the end of wavelegth timeout, if i start saying
    // something, it should get appended to the last spken. but it is just
    // getting cut off abruptly."
    //
    // The window was a FIXED eight seconds from the moment capture opened.
    // Eight seconds is a long sentence and a short thought, so a slow or
    // considered answer was guillotined at the same instant every time,
    // whether or not she was still talking.
    //
    // Replaced with the shape every real endpointer uses: a SILENCE timer
    // that restarts on every word she says, and a hard cap so a stuck
    // recogniser cannot hold the microphone open for ever. She now stops when
    // she stops, not when the clock does.
    // ── TWO TIMEOUTS, NOT ONE. THIS WAS MY BUG. ──────────────────────────
    // Apsara, 2026-09-07: "on follow up, it says go ahead.. but nothing is
    // recorded."
    //
    // Exactly right, and I caused it this morning. Replacing the fixed 8s
    // window with a silence timer fixed being cut off mid-sentence and broke
    // something worse: armCaptureTimers() is called by openCapture(), so the
    // 1800ms clock started the instant the card said "Go ahead…" — BEFORE she
    // had said a word. Any pause longer than one and four-fifths of a second
    // and finishCapture() ran with nothing captured, hit the `if (!q)` return,
    // and went quietly back to idle. Her turn vanished.
    //
    // It bites hardest on FOLLOW-UPS, which is where she found it: Jarvis has
    // just asked "What rate per metric ton?" and she has to think, or look it
    // up. Thinking took longer than the window. The old fixed 8s window was
    // wrong about when to STOP but at least gave her 8 seconds to START.
    //
    // Every real endpointer carries two separate timeouts and I collapsed
    // them into one:
    //   LISTEN_MS  — how long to wait for her to BEGIN. Generous.
    //   SILENCE_MS — how long after she STOPS to decide she has finished.
    // The short one must not be armed until she has actually said something.
    // Tuned to Siri's own endpointing on 2026-09-07 at her request. Siri is
    // SNAPPIER once you are talking and MORE PATIENT before you start, which
    // is the opposite of the single 1800ms window that dropped her turns.
    var LISTEN_MS = 10000;      // waiting for her to start — a thinking pause
    var SILENCE_MS = 1200;      // quiet long enough to mean "finished"
    var HARD_CAP_MS = 45000;    // a recogniser that never stops emitting
    var hardCapTimer = null;
    var heardAnything = false;

    function armCaptureTimers() {
        clearTimeout(captureTimer);
        // A passive follow-up window is five seconds, not ten. She was not
        // asked anything, so holding the microphone open for a full
        // thinking-pause after every answer is a mic that is always on.
        captureTimer = setTimeout(finishCapture,
            heardAnything ? SILENCE_MS : (capturePassive ? FOLLOWUP_MS : LISTEN_MS));
        if (!hardCapTimer) hardCapTimer = setTimeout(function () {
            console.log('[VOICE] hard cap reached — closing the capture');
            finishCapture();
        }, HARD_CAP_MS);
    }
    function clearCaptureTimers() {
        clearTimeout(captureTimer);
        clearTimeout(hardCapTimer);
        hardCapTimer = null;
    }

    function finishCapture() {
        // BOTH timers. Clearing only the silence one left the 45s hard cap
        // armed, so a capture that ended normally would fire finishCapture a
        // second time half a minute later — mid-way through whatever she was
        // saying next.
        clearCaptureTimers();
        var q = heardDuringCapture.replace(WAKE, '').trim();
        capturePrefix = '';
        dispatch('CAPTURE_END');
        if (!q) {
            // ── AND IT NEVER DIES QUIETLY AGAIN ──────────────────────────
            // This bare return is what made the bug invisible. On a follow-up
            // the question Jarvis asked is still outstanding, so going back to
            // idle leaves her looking at a card that says nothing while the
            // draft waits for an answer she believes she gave.
            //
            // One retry, then stop. A capture that reopens for ever with a
            // dead microphone is a worse failure than a lost turn, and it is
            // one she cannot get out of.
            if (captureWasFollowUp && !captureRetried) {
                captureRetried = true;
                console.log('[VOICE] nothing heard on a follow-up — reopening once');
                pendingHint = 'Didn\u2019t catch that';
                suppressAck = true;
                dispatch('WAKE_HEARD');
                return;
            }
            // GIVING UP CLEARS THE FOLLOW-UP FLAG, NOT THE RETRY FLAG. I had
            // it the other way round and the third empty finish started the
            // cycle again — retry, give up, retry, for ever. Caught by the
            // assertion that finishes a third time, which is the only one in
            // the suite that could have seen it.
            captureWasFollowUp = false;
            say(canWake ? 'Say “Hey Jarvis”' : 'Hold to talk');
            return;
        }
        captureRetried = false;
        captureWasFollowUp = false;
        // Remembered so a sentence she resumes a moment later can be joined
        // to it rather than starting a new one. See the continuation window
        // in the recogniser.
        lastAsked = q;
        lastAskedAt = Date.now();
        playDone();
        ask(q);
    }

    // ── asking ────────────────────────────────────────────────────────────
    // Goes through the SAME endpoint as the typed assistant. Voice is an input
    // method, not a second brain — so the tool registry, the propose-then-
    // confirm rule and every validation apply identically. A spoken
    // instruction can no more write to the ledger than a typed one.
    function ask(q) {
        say('Thinking…');
        // Shown IMMEDIATELY, before the request goes out. This is the whole
        // perceived-speed fix: the wait now contains her own words instead
        // of an empty pill.
        showCard(q, 'Thinking…', true);
        // The previous results go the moment a NEW question is asked. A list
        // left on screen from the last question is one she could say "the
        // first one" about, and mean something different from what Jarvis
        // would do.
        hidePanel();
        // NOT hideDoc(). The results panel is cleared because a stale list is
        // something she could say "the first one" about and mean the wrong
        // booking. A staged proforma is the opposite: "wait, change it to
        // FOB" is a new question, and tearing the document off the screen
        // while she corrects it is exactly when she most needs to see it. It
        // is replaced by showDoc() below on every response, and hidden the
        // moment a response comes back without one — which is what happens
        // when the send goes through.
        // `thinking` is not in the reducer: it is about the network, not about
        // whether the microphone may be open, and putting it there would mean
        // a state that can never affect the one decision that file exists to
        // make. The orb is told directly, and cleared on BOTH outcomes below —
        // an orb left churning after a failed request is a spinner that never
        // stops.
        if (window.JarvisOrb) window.JarvisOrb.setThinking(true);
        var api = window.api;
        if (typeof api !== 'function') { say('Assistant unavailable'); return; }
        // ── /api/voice/ask, NOT /api/yard/ask ────────────────────────────
        // Apsara, 2026-09-06: "yard ask is a different assistant restricted
        // only to yard. Jarvis knows everything."
        //
        // This called /api/yard/ask, which is SCOUT — a narrow assistant over
        // the yard ledger: loads, sellers, stock, payments. So every spoken
        // question, whatever it was about, went to the assistant that only
        // knows about scrap. Asked what bookings there were from Houston,
        // Scout said it had no idea, and it was right: bookings are not its
        // subject.
        //
        // /api/voice/ask is the router. It reads the question and sends it to
        // whichever assistant owns it — Scout for the ledger, Jarvis
        // (workflow/brain.js) for bookings, containers, ports, cutoffs,
        // suppliers, truckers, email and WhatsApp. Jarvis has been able to
        // answer that Houston question for weeks; nothing was asking it.
        //
        // The parameter is `text`, not `question`: the router needs the words
        // as spoken to decide, and stripAgentName() on the server removes any
        // "Scout," or "Jarvis," prefix afterwards.
        api('/api/voice/ask', { method: 'POST', body: JSON.stringify({ text: q, agent: addressed }) })
            .then(function (r) {
                if (window.JarvisOrb) window.JarvisOrb.setThinking(false);
                var answer = (r && r.answer) || 'No answer.';
                // WHICH ASSISTANT ANSWERED, shown rather than hidden. There
                // are two behind this endpoint and they know different
                // things, so "Scout doesn't know about bookings" is a
                // complete explanation of an unhelpful answer — where an
                // unattributed "I don't know" looks like the whole system
                // being stupid. It is also the fastest way to see the router
                // sending a question to the wrong one.
                // The screen. Rendered before the card, so the two are laid
                // out in one paint rather than the card jumping when the
                // panel appears underneath it.
                showPanel(r && r.cards);
                // The document she is being asked to approve. Rendered in the
                // same paint as the panel and the card so the column settles
                // once rather than jumping as each piece arrives.
                showDoc(r && r.proforma);
                // Does Jarvis expect an answer? Read BEFORE speak() is called,
                // because the finish handler consumes it the moment the audio
                // ends — and on a short reply that is almost immediately.
                awaitingReply = !!(r && r.awaiting);
                // The colour follows the ANSWERING agent, which can differ
                // from the one addressed — she says "Hey Jarvis" and asks
                // about loads, and the router hands it to Scout. Showing the
                // agent she called rather than the one that answered would
                // be a prettier lie.
                paintAgent((r && r.agent) || addressed);
                var who = (r && r.agent_name) || '';
                say(who || 'Answered');
                showCard(undefined, answer, false);
                if (who) {
                    var q = el('jvCardQ');
                    if (q && q.textContent) q.textContent = who + ' · ' + q.textContent;
                }
                // A PROPOSAL IS NEVER SPOKEN AND CONFIRMED BY VOICE. The card
                // is shown and she taps it. Confirming a payment by saying
                // "yes" to a machine that mishears names is the one shortcut
                // this whole design refuses to take.
                if (r && r.proposal) {
                    showCard(undefined, answer + '\n\nCheck the card below and confirm it.', false);
                    speak('I can do that. Check the card and confirm it.');
                    if (typeof window.renderYardProposal === 'function') window.renderYardProposal(r.proposal);
                } else {
                    speak(answer);
                }
            })
            .catch(function (e) {
                if (window.JarvisOrb) window.JarvisOrb.setThinking(false);
                say('Failed');
                showCard(undefined, 'Could not reach the assistant: ' + (e && e.message), false);
            });
    }

    // ── wiring ────────────────────────────────────────────────────────────
    var mounted = false;
    function mount() {
        // IDEMPOTENT. mount() can be reached twice — the readyState check
        // registers a DOMContentLoaded listener, and anything that fires that
        // event again runs it a second time. Without this guard the second run
        // appends a duplicate bar and, worse, RESETS the status line: a
        // "Voice needs Google Chrome" message was being overwritten a
        // millisecond later by the mount-time "Click to start listening",
        // hiding the one explanation the person needed. Caught in the test
        // harness, but the same overwrite is possible in a browser.
        if (mounted) return;
        mounted = true;
        if (!SR) return;                       // no recogniser at all: show nothing
        // docCss appended HERE, not spliced into the panelCss array where it
        // reads more naturally. `var docCss` is declared a hundred lines
        // BELOW that array — hoisted, so no error, but undefined at the time
        // the array is built, and Array.join() renders undefined as an empty
        // string. The whole document panel would have come out unstyled with
        // nothing logged anywhere. Same family as the `const` temporal dead
        // zone that nearly shipped in api.js, and `node --check` cannot see
        // either. Proved by running it, not by reading it.
        css.textContent += cardCss + voiceCss + panelCss + docCss;
        document.head.appendChild(css);
        document.body.appendChild(bar);
        // Panel first, card under it: results above, the sentence being
        // spoken nearest the voice bar she is looking at.
        var stack = document.createElement('div');
        stack.id = 'jvStack';
        // Document first, then results, then the spoken card nearest the
        // voice bar. The proforma is the thing she is being asked to approve,
        // so it gets the top of the column and does not move when a shorter
        // answer card is repainted underneath it.
        stack.appendChild(doc);
        stack.appendChild(panel);
        stack.appendChild(card);
        document.body.appendChild(stack);
        document.body.appendChild(voiceSheet);
        el('jvvClose').addEventListener('click', closeVoices);
        // Escape interrupts too. Her hands are already on the keyboard, and
        // it does not ask her to hit a small target while something talks
        // over her.
        window.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && state.speaking) { e.preventDefault(); interrupt(); }
        });
        // Rendered now, so the first "Hey Jarvis" does not wait on it.
        warmAck();
        el('jvVoiceBtn').addEventListener('click', function (e) {
            e.stopPropagation();
            if (voiceSheet.classList.contains('hidden')) openVoices(); else closeVoices();
        });
        paint();

        if (!canWake) {
            say('Press and hold — Chrome for “Hey Jarvis”');
        } else {
            // Not "Off". "Off" describes a state; this has to tell her what to
            // do about it.
            say('Click to start listening');
        }

        var t = el('jvToggle');
        if (canWake) {
            // Nothing auto-starts. The first click is also what gives the
            // browser the user gesture it requires before opening a mic.
            t.addEventListener('click', function () {
                // ── THE ONE MOMENT THE BROWSER WILL START AUDIO ──────────
                // An AudioContext is created suspended and only a USER
                // GESTURE may start it. This click is the only gesture in
                // the whole flow — everything after it is triggered by the
                // wake word, which is not one. Creating the context lazily
                // inside playAck() therefore produced a context that could
                // never run: nodes connected, start() called, no exception,
                // no sound. That is why the acknowledgement had to be asked
                // for twice.
                audio();
                dispatch('USER_TOGGLE');
            });
        } else {
            // Press-to-talk: hold the button, speak, release.
            var down = function (e) { e.preventDefault(); dispatch('CAPTURE_START'); startMic(); };
            var up = function () { finishCapture(); stopMic(); };
            t.addEventListener('mousedown', down);
            t.addEventListener('touchstart', down);
            window.addEventListener('mouseup', up);
            window.addEventListener('touchend', up);
        }

        // Hiding the tab stops the microphone. The SETTING survives — that is
        // the difference between "listening is off" and "not listening right
        // now", and conflating them means switching it back on every time she
        // checks her email.
        document.addEventListener('visibilitychange', function () {
            dispatch(document.hidden ? 'APP_BACKGROUND' : 'APP_FOREGROUND');
        });
        // Belt as well as braces: never leave a microphone open on unload.
        window.addEventListener('pagehide', stopMic);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();

    // Exposed for the tests, and for anyone debugging a report of "it kept
    // listening" — the state is the whole explanation.
    window.JarvisVoice = {
        state: function () { return state; },
        canWake: canWake,
        dispatch: dispatch,
        // Ends the capture and asks, exactly as the timer does. Exposed so a
        // test can drive the real path — dispatching CAPTURE_END alone skips
        // this and therefore skips speak(), which is where the microphone is
        // supposed to be closed. That gap let a broken build pass once.
        finish: finishCapture,
        WAKE: WAKE,
        // ── EXPOSED SO THE INVARIANT CAN STILL BE TESTED ─────────────────
        // The old rule was "the recogniser does not exist while speaking",
        // and a test could check that by looking for the object. Barge-in
        // means it DOES exist, so the rule it enforced has to be checkable
        // some other way or twenty assertions quietly become "the mic is
        // open, fine". guard() is that way: while speaking, an open mic is
        // only ever allowed to be a guard mic.
        guard: function () { return guardMode; },
        isOwnVoice: isOwnVoice,
        nowSpeaking: function () { return nowSpeaking; },
    };
}());
