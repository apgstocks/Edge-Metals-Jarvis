#!/usr/bin/env node
// ── scripts/mutate.js ─────────────────────────────────────────────────────
// Apsara, 2026-09-07: "Test properly."
//
// Fair. Mutation testing has been the thing keeping this build honest all
// day, and I have been doing it with hand-written perl one line at a time.
// That went wrong three separate times, and every failure was silent:
//
//   1. A PATTERN THAT MATCHED NOTHING. The perl ran, changed no bytes, the
//      suite passed, and I recorded "DIED" — a mutation that was never
//      applied cannot be killed. Six mutations in one run were measuring an
//      unmutated file.
//   2. AN ASSERTION THAT COULD NOT FAIL — `!X || X`, true for every input.
//      It survived a mutation deleting the whole feature it guarded.
//   3. A RUN THAT TIMED OUT half way, leaving two of four unreported and
//      the working tree mutated until I noticed.
//
// All three are process failures, not judgement failures, and a script fixes
// process failures. So:
//
//   · every mutation VERIFIES it changed the file, and refuses to report a
//     result if it did not
//   · the original is restored in a finally block AND on every exit signal,
//     so an interrupted run cannot leave mutated code on disk
//   · survivors are reported loudly, with the mutation shown, because a
//     survivor is the only interesting output
//   · the catalogue is checked in, so "which mutations were run" stops being
//     something I claim in a commit message and becomes something anyone can
//     re-run
//
// USAGE
//   node scripts/mutate.js                 every mutation
//   node scripts/mutate.js follow-up       only ones whose name matches
//   node scripts/mutate.js --list          show the catalogue, run nothing

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const R = (p) => path.join(ROOT, p);

// ── THE CATALOGUE ────────────────────────────────────────────────────────
// Each entry: what it breaks, where, and which suites should notice.
// `suites` is deliberately narrow — running all 78 for each of 30 mutations
// would take an hour and nobody would run it. The narrowing is itself a
// claim being tested: if a mutation dies only in a suite not listed here,
// that is worth knowing.
// Parses the inline <script> blocks of an HTML file, and reports the same
// { status } shape spawnSync does so the caller does not care which it got.
function checkHtml(file) {
    try {
        const html = fs.readFileSync(file, 'utf8');
        const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
        if (!blocks.length) return { status: 0 };
        for (const b of blocks) new Function(b[1]);
        return { status: 0 };
    } catch (e) {
        return { status: 1, stderr: e.message };
    }
}

const MUTATIONS = [
    // ── the follow-up / discourse work ──────────────────────────────────
    { name: 'follow-up: the model can no longer veto',
      file: 'api.js', suites: ['e2e-voice'],
      find: '                || (patternSaysFollowUp && modelSaysRows !== false)\n', to: '' },
    { name: 'follow-up: an ORDER treated as a follow-up question',
      file: 'api.js', suites: ['e2e-voice'],
      find: '            const isOrder = ac.IS_INSTRUCTION.test(stripped);', to: '            const isOrder = false;' },
    { name: 'follow-up: a resolved pronoun stops counting',
      file: 'api.js', suites: ['e2e-voice'],
      find: '                !!ref.resolved\n', to: '                false\n' },
    { name: 'follow-up: a missing field becomes false, not null',
      file: 'helpers/followUp.js', suites: ['e2e-voice'],
      find: "lastAboutRows = res && typeof res.about_these_rows === 'boolean'\n            ? res.about_these_rows : null;",
      to: 'lastAboutRows = !!(res && res.about_these_rows);' },
    { name: 'follow-up: unanswerable follow-up falls through empty',
      file: 'api.js', suites: ['e2e-voice'],
      find: '            if (followingUp && !quick) {', to: '            if (false) {' },
    { name: 'follow-up: empty answers may leave the endpoint',
      file: 'api.js', suites: ['e2e-voice'],
      find: "                if (typeof payload.answer !== 'string' || !payload.answer.trim()) {",
      to: '                if (false) {' },
    { name: 'follow-up: a new port no longer redraws',
      file: 'helpers/answerCards.js', suites: ['e2e-voice'],
      find: '    if (portIn(q)) return false;\n', to: '' },
    { name: 'follow-up: an explicit list request is treated as a follow-up',
      file: 'helpers/answerCards.js', suites: ['e2e-voice'],
      find: '    if (LIST_REQUEST.test(q)) return false;\n', to: '' },

    // ── the name-suggestion work ────────────────────────────────────────
    { name: 'names: first-letter guard removed',
      file: 'helpers/nameSuggest.js', suites: ['name-suggest'],
      find: '        if (!parts.some((p2) => norm(p2)[0] === q[0])) continue;\n', to: '' },
    { name: 'names: very short names guessed at',
      file: 'helpers/nameSuggest.js', suites: ['name-suggest'],
      find: '    if (q.length < MIN_LEN) return [];\n', to: '' },
    { name: 'names: exact matches offered as suggestions',
      file: 'helpers/nameSuggest.js', suites: ['name-suggest'],
      find: '        if (n === q) continue;\n', to: '' },
    { name: 'names: phonetic agreement no longer required',
      file: 'helpers/nameSuggest.js', suites: ['name-suggest'],
      find: "        if (sameSound && sim >= MIN_SIMILARITY) why = 'sounds the same';",
      to: "        if (sim >= MIN_SIMILARITY) why = 'sounds the same';" },
    { name: 'names: the mis-hearing is never learned',
      file: 'workflow/actions.js', suites: ['name-suggest', 'e2e-voice'],
      find: '        await emailContacts.addContact(pending.heard, chosen.email, { displayName: chosen.name });',
      to: '        void chosen;' },
    { name: 'names: a suggestion becomes the recipient (the forbidden one)',
      file: 'workflow/actions.js', suites: ['name-suggest'],
      find: '            const near = suggest(targetName, roster);',
      to: '            const near = suggest(targetName, roster);\n            if (near.length) { to = near[0].record.email; }' },
    { name: 'vocab: prompt trims the tail instead of the head',
      file: 'helpers/voiceVocab.js', suites: ['name-suggest'],
      find: '        names = names.slice(1);', to: '        names = names.slice(0, -1);' },
    { name: 'vocab: the 224-token cap is ignored',
      file: 'helpers/voiceVocab.js', suites: ['name-suggest'],
      find: '    while (names.length && (BASE.length + 2 + tail.length) > BUDGET) {',
      to: '    while (false) {' },

    // ── the gemini failure-reason work ──────────────────────────────────
    { name: 'gemini: quota misreported',
      file: 'helpers/gemini.js', suites: ['gemini-failure'],
      find: "            lastFailure = /\\b(429|quota|rate)\\b/i.test(err.message) ? 'quota'",
      to: "            lastFailure = false ? 'quota'" },
    { name: 'gemini: an unparseable answer records no reason',
      file: 'helpers/gemini.js', suites: ['gemini-failure'],
      find: "    if (!lastFailure) lastFailure = 'unusable';\n", to: '' },
    { name: 'gemini: a stale reason leaks into the next call',
      file: 'helpers/gemini.js', suites: ['gemini-failure'],
      find: '    lastFailure = null;\n    for (let attempt', to: '    for (let attempt' },
    // e2e-voice as well as gemini-failure, and the difference matters:
    // gemini-failure GREPS the source for the four branches, which proves the
    // strings exist and not that they are reachable. Disabling the auth
    // branch survived it. Only section 11 of the e2e, which drives a real
    // auth failure through the real endpoint, notices. Recorded because my
    // own catalogue comment claimed a mutation dying outside its listed
    // suites was worth knowing — and this was the first one.
    { name: 'gemini: back to blaming her wording',
      file: 'workflow/actions.js', suites: ['gemini-failure', 'e2e-voice'],
      find: "    if (why === 'auth') {", to: '    if (false) {' },

    // ── the repair / retraction work ────────────────────────────────────
    { name: 'repair: the model is never consulted',
      file: 'helpers/repair.js', suites: ['repair'],
      find: "    const said = await askModel(t, ctx || {});\n    if (!said || said === 'none') return 'none';",
      to: "    const said = 'none';\n    if (!said || said === 'none') return 'none';" },
    { name: 'repair: restart collapses into cancel',
      file: 'helpers/repair.js', suites: ['repair'],
      find: "    if (RESTART.test(t)) return 'restart';\n", to: '' },
    { name: 'repair: an unvalidated model label is trusted',
      file: 'helpers/repair.js', suites: ['repair'],
      find: '        if (!SCOPES.has(label)) return null;\n', to: '' },
    { name: 'repair: a sent email is pretended away',
      file: 'helpers/repair.js', suites: ['repair'],
      find: "        return `That's already gone — ${done}. I can't take it back, but tell me what to do about it.`;",
      to: "        return 'OK.';" },
    { name: "repair: Alexa's bare built-ins dropped",
      file: 'helpers/repair.js', suites: ['repair'],
      find: "    if (CANCEL_BARE.test(t) || CANCEL.test(t)) return 'cancel';",
      to: "    if (CANCEL.test(t)) return 'cancel';" },

    // ── barge-in and the acknowledgement ────────────────────────────────
    { name: 'barge: the echo filter is removed',
      file: 'dashboard/voice.js', suites: ['voice-web'],
      find: '                if (isOwnVoice(txt)) {', to: '                if (false) {' },
    { name: 'barge: it never latches off (fails open)',
      file: 'dashboard/voice.js', suites: ['voice-web'],
      find: '                    if (selfTriggers >= SELF_TRIGGER_LIMIT) {', to: '                    if (false) {' },
    { name: 'barge: a guard mic opens with no transcript to filter against',
      file: 'dashboard/voice.js', suites: ['voice-web'],
      find: '                if (!nowSpeaking) {', to: '                if (false) {' },
    { name: 'ack: borrows the other agent\'s words again',
      file: 'dashboard/voice.js', suites: ['voice-web'],
      find: "                var other = addressed === 'jarvis' ? 'scout' : 'jarvis';",
      to: "                var other = addressed === 'jarvis' ? 'scout' : 'jarvis';\n                decoded = ackBuf[other];" },
    { name: 'ack: a duplicate in the same breath is allowed',
      file: 'dashboard/voice.js', suites: ['voice-web'],
      find: '        if (Date.now() - lastAckAt < ACK_GAP_MS) {', to: '        if (false) {' },
    { name: 'capture: back to ONE timeout (her lost turns)',
      file: 'dashboard/voice.js', suites: ['voice-web'],
      find: 'heardAnything ? SILENCE_MS : (capturePassive ? FOLLOWUP_MS : LISTEN_MS)',
      to: 'SILENCE_MS' },
    { name: 'capture: an interrupt no longer retires answers in flight',
      file: 'dashboard/voice.js', suites: ['voice-web'],
      find: '        askSeq += 1;\n        dispatch(\'CAPTURE_START\');',
      to: "        dispatch('CAPTURE_START');" },

    // ── the forward, which has a real driver behind it ──────────────────
    { name: 'forward: ok:true regardless of the send',
      file: 'workflow/actions.js', suites: ['e2e-voice'],
      find: "    const wa = await _send(waChatId, text);\n    return { channel: 'whatsapp', ok: wa !== false, target: waChatId };",
      to: "    await _send(waChatId, text);\n    return { channel: 'whatsapp', ok: true, target: waChatId };" },
    { name: 'forward: recorded even when the message failed',
      file: 'workflow/actions.js', suites: ['e2e-voice'],
      find: 'if (!forwardNotice.ok) {', to: 'if (false) {' },
    { name: 'forward: silence from a sender treated as failure',
      file: 'workflow/actions.js', suites: ['e2e-voice'],
      find: 'ok: wa !== false', to: 'ok: !!wa' },

    // ── centering, and the parked draft ─────────────────────────────────
    { name: 'centering: the centre is ignored',
      file: 'helpers/voiceMemory.js', suites: ['voice-memory'],
      find: '            if (still) {', to: '            if (false) {' },
    { name: 'centering: a new list keeps the old centre',
      file: 'helpers/voiceMemory.js', suites: ['voice-memory'],
      find: '    if (!cards || !Array.isArray(cards.rows) || !cards.rows.length) return;\n    center = null;',
      to:   '    if (!cards || !Array.isArray(cards.rows) || !cards.rows.length) return;' },
    { name: 'centering: an empty call wipes the centre again',
      file: 'helpers/voiceMemory.js', suites: ['voice-memory', 'e2e-voice'],
      find: '    if (!cards || !Array.isArray(cards.rows) || !cards.rows.length) return;\n    center = null;',
      to:   '    center = null;\n    if (!cards || !Array.isArray(cards.rows) || !cards.rows.length) return;' },
    { name: 'centering: the centre is used without checking it is on screen',
      file: 'helpers/voiceMemory.js', suites: ['voice-memory'],
      find: '            const still = cb && set.rows.filter((r) => r.booking_number === cb.booking_number)[0];',
      to: '            const still = cb;' },
    { name: 'park: a parked draft leaks into the next email',
      file: 'helpers/proformaDraft.js', suites: ['task-context'],
      find: '        parked = { draft, at: Date.now(), line };\n        draft = null;',
      to: '        parked = { draft, at: Date.now(), line };' },

    // ── the category-word work (2026-09-07/08) ──────────────────────────
    //
    // DELIBERATELY NOT LISTED: breaking the exact-list line
    // `if (list.some((g) => norm(g) === w)) return true;`.
    // It is unkillable BY CONSTRUCTION, not because the tests are weak —
    // KEYS is built by running phonetic() over the very same list, so every
    // string the exact check accepts, the phonetic check accepts too. A
    // mutation nobody can kill is a defect model that describes no real
    // defect, and leaving it in the catalogue would train me to ignore
    // survivors. If the exact line ever stops being redundant, this note is
    // the reminder to add the mutation back.
    { name: 'generic: the mis-heard spelling no longer reaches it',
      file: 'helpers/genericTerm.js', suites: ['phrasebook'],
      find: '    return KEYS[kind].has(phonetic(word));',
      to:   '    return false;' },
    { name: 'generic: a two-letter fragment can collide into a category',
      file: 'helpers/genericTerm.js', suites: ['phrasebook', 'name-suggest'],
      find: '    if (w.length < 4) return false;',
      to:   '    if (w.length < 1) return false;' },

    // ── the two the phrasebook found itself ─────────────────────────────
    { name: 'forward: a noun before the number breaks the pattern again',
      file: 'workflow/brain.js', suites: ['phrasebook', 'forward-flow'],
      find: '(?:(?:booking|load|shipment|container)\\s+)?',
      to:   '' },
    // NOT LISTED, and the reason is written into brain.js beside the pattern:
    // I originally guarded this prefix with a `(?!to\b)` lookahead and could
    // not kill the mutation that removed it, because regex backtracking
    // already does that job. The lookahead came out. An unkillable mutation
    // is a message about the CODE, not about the tests.
    { name: 'resolver: it expands a pronoun into a sentence that already names one',
      file: 'helpers/voiceMemory.js', suites: ['phrasebook', 'voice-memory'],
      find: '    if (namesOne) return { text: q, resolved: null };',
      to:   '    if (false) return { text: q, resolved: null };' },
    { name: 'resolver: any lookalike token silences it, not just a real row',
      file: 'helpers/voiceMemory.js', suites: ['phrasebook', 'voice-memory'],
      find: '    const namesOne = set.rows.some((r) => {',
      to:   '    const namesOne = /\\b[A-Z]{2,4}\\d{2,}\\b/i.test(q) || set.rows.some((r) => {' },

    // ── the harness telling the truth about the model ───────────────────
    { name: 'harness: the offline stub throws again, which the real one cannot',
      file: 'tests/helpers/e2e.js', suites: ['phrasebook'],
      find: "            failure = 'unreachable';\n            return null;",
      to:   "            throw new Error('ECONNREFUSED (stubbed offline)');" },

    // ── her verbs, not mine (2026-09-08) ────────────────────────────────
    { name: 'verbs: only "forward" again, so "share" stops working',
      file: 'workflow/brain.js', suites: ['phrasebook'],
      find: 'const SEND_ONWARD = String.raw`forward|share|pass|hand|shoot|send|give`;',
      to:   'const SEND_ONWARD = String.raw`forward`;' },
    { name: 'verbs: the gate is dropped, so "send a mail" forwards a booking',
      file: 'workflow/brain.js', suites: ['phrasebook'],
      find: "if (verb === 'forward' || noun || namedBooking || saidTheWord || isHerBooking) {",
      to:   'if (true) {' },
    { name: 'verbs: the category word no longer opens the gate',
      file: 'workflow/brain.js', suites: ['phrasebook'],
      find: "const saidTheWord = require('../helpers/genericTerm').isGeneric(first, 'booking');",
      to:   'const saidTheWord = false;' },
    { name: 'verbs: a real booking is judged by shape rather than by the store',
      file: 'workflow/brain.js', suites: ['phrasebook'],
      find: "try { isHerBooking = !!require('../helpers/booking').getBooking(first).booking; }",
      to:   'try { isHerBooking = false; }' },
    // ── nothing available, so ask a forwarder (2026-09-09) ──────────────
    { name: 'forwarder: an empty available search just says nothing',
      file: 'api.js', suites: ['phrasebook'],
      find: "                        if (!listAsk && !result.rows.length\n                            && frame.status === 'unassigned' && frame.location) {",
      to:   '                        if (false) {' },
    { name: 'forwarder: it offers on ANY empty result, not just available',
      file: 'api.js', suites: ['phrasebook'],
      find: "                            && frame.status === 'unassigned' && frame.location) {",
      to:   '                            && frame.location) {' },
    // NOT LISTED: dropping `rewrittenAsOrder` from the cards gate. It became
    // unkillable once the synthesised sentence was phrased properly — every
    // instruction Jarvis writes for itself starts with a verb that
    // answerCards.IS_INSTRUCTION already catches, so bookingQuery declines it
    // one guard earlier. Kept in the code because it states the rule
    // directly — a sentence Jarvis built from her answer is not a question to
    // be parsed again — and because the phrasing it depends on is exactly the
    // kind of thing a later edit changes without noticing. Fourth note of this
    // shape; each is recorded rather than left looking like a weak test.
    { name: 'forwarder: the port goes back on the end and is re-parsed',
      file: 'api.js', suites: ['phrasebook'],
      find: '                    asked = `send a mail to ${who}, asking for space out of ${offer.port}`;',
      to:   '                    asked = `send a mail to ${who} asking for a booking from ${offer.port}`;' },
    { name: 'forwarder: "no" is not heard, so it drafts anyway',
      file: 'api.js', suites: ['phrasebook'],
      find: "                const NO = /^\\s*(?:no|nope|not now|later|leave it|don'?t|nothing)\\b/i;\n                if (NO.test(stripped)) {",
      to:   "                const NO = /^\\s*(?:no|nope|not now|later|leave it|don'?t|nothing)\\b/i;\n                if (false) {" },
    { name: 'available: the workflow supplier is ignored again (the July bug)',
      file: 'helpers/bookingQuery.js', suites: ['phrasebook'],
      find: '        const wf = workflow[b.booking_number];',
      to:   '        const wf = undefined;' },

    // ── talking over it (2026-09-09) ────────────────────────────────────
    { name: 'barge: back to nine approved interruption words',
      file: 'dashboard/voice.js', suites: ['voice-web'],
      find: '                if (WAKE.test(txt) || BARGE_WORDS.test(txt) || meantIt) {',
      to:   '                if (WAKE.test(txt) || BARGE_WORDS.test(txt)) {' },
    { name: 'barge: ANY speech interrupts, including the yard conversation',
      file: 'dashboard/voice.js', suites: ['voice-web'],
      find: "                var meantIt = txt.replace(/[^a-z0-9]/gi, '').length >= 3 && ADDRESSED.test(txt);",
      to:   "                var meantIt = txt.replace(/[^a-z0-9]/gi, '').length >= 3;" },
    { name: 'barge: no floor, so a cough stops it mid-sentence',
      file: 'dashboard/voice.js', suites: ['voice-web'],
      find: "                var meantIt = txt.replace(/[^a-z0-9]/gi, '').length >= 3 && ADDRESSED.test(txt);",
      to:   '                var meantIt = ADDRESSED.test(txt);' },
    { name: 'barge: the instruction inside it is dropped',
      file: 'dashboard/voice.js', suites: ['voice-web'],
      find: '                    if (tail) pendingSeed = tail;',
      to:   '                    void tail;' },

    // ── the mic that said Listening and was not (2026-09-09) ────────────
    { name: 'mic: a failed start goes back to being silent',
      file: 'dashboard/voice.js', suites: ['voice-web'],
      find: "            console.warn('[VOICE] microphone did not start: ' + msg);",
      to:   '            void msg;' },
    { name: 'mic: a failed start never retries',
      file: 'dashboard/voice.js', suites: ['voice-web'],
      find: "            setTimeout(function () { dispatch('RECOGNISER_STOPPED'); }, 400);",
      to:   '            void 0;' },
    { name: 'mic: the pill keeps claiming it is listening',
      file: 'dashboard/voice.js', suites: ['voice-web'],
      find: "            say('Restarting…');",
      to:   '            void 0;' },
    { name: 'mic: the half-started recogniser is left running',
      file: 'dashboard/voice.js', suites: ['voice-web'],
      find: '            try { rec.abort(); } catch (e2) {}',
      to:   '            void 0;' },
    { name: 'watchdog: removed entirely',
      file: 'dashboard/voice.js', suites: ['voice-web'],
      find: "            console.warn('[VOICE] watchdog: the mic should be open and is not — restarting');",
      to:   '            void 0;' },
    { name: 'watchdog: it overrides the reducer and holds the mic open',
      file: 'dashboard/voice.js', suites: ['voice-web'],
      find: '            if (!VM.micShouldBeOpen(state)) return;',
      to:   '            if (false) return;' },

    // ── choosing from a list, out loud (2026-09-09) ─────────────────────
    { name: 'pick: back to digits only, so "one" is not detected',
      file: 'helpers/pickFromList.js', suites: ['pick-from-list'],
      find: '    if (Object.prototype.hasOwnProperty.call(WORD_NUMBERS, t)) return WORD_NUMBERS[t];',
      to:   '    return null;' },
    { name: 'pick: ambiguity guesses the first match again',
      file: 'helpers/pickFromList.js', suites: ['pick-from-list'],
      find: '    return matches.length === 1 ? matches[0] : null;',
      to:   '    return matches.length ? matches[0] : null;' },
    { name: 'pick: a mis-heard short name no longer reaches the roster',
      file: 'helpers/pickFromList.js', suites: ['pick-from-list'],
      find: '    const qp = phonetic(t);',
      to:   '    const qp = null;' },
    { name: 'pick: booking numbers get fuzzy-matched into each other',
      file: 'helpers/pickFromList.js', suites: ['pick-from-list'],
      find: '    if (identifiers) return null;',
      to:   '    if (false) return null;' },
    { name: 'pick: out-of-range is rounded into the list',
      file: 'helpers/pickFromList.js', suites: ['pick-from-list'],
      find: '        return (pos >= 1 && pos <= opts.length) ? opts[pos - 1] : null;',
      to:   '        return opts[Math.min(Math.max(pos, 1), opts.length) - 1];' },
    { name: 'pick: words come from the glued name again, so per-word dies',
      file: 'helpers/pickFromList.js', suites: ['pick-from-list'],
      find: "        words: String(o).split(/[\\s/&,.-]+/).map((w) => key(w)).filter(Boolean),",
      to:   '        words: [key(o)],' },
    // ── the booking request, in her words (2026-09-09) ──────────────────
    // "need bookings from Houston to Busan 1x40HC with cut off as [date]"
    { name: 'request: the cutoff is read in the server timezone again',
      file: 'helpers/bookingRequest.js', suites: ['booking-request'],
      find: '    const p = laParts(d);          // LA, not the server\'s clock — see laParts.',
      to:   '    const p = { d: d.getDate(), m: d.getMonth() + 1, y: d.getFullYear() };' },
    { name: 'request: a bare date in a sentence counts as a cutoff again',
      file: 'helpers/bookingRequest.js', suites: ['booking-request'],
      find: '        cutoff: parseDatePhrase(afterLabel(text, CUTOFF_LABEL), now),',
      to:   '        cutoff: parseDatePhrase(text, now),' },
    { name: 'request: a split history is guessed at instead of left empty',
      file: 'helpers/bookingRequest.js', suites: ['booking-request'],
      find: '    if (bestN / vals.length < USUAL_SHARE) return null;',
      to:   '    if (false) return null;' },
    { name: 'request: the load port is inferred, which her data cannot support',
      file: 'helpers/bookingRequest.js', suites: ['booking-request'],
      find: '        to: pod ? pod.value : null,',
      to:   '        to: pod ? pod.value : null, from: commonest(pool.map((b) => b.port_of_loading))?.value || null,' },
    { name: 'request: "make it 3" is read as a day of the month again',
      file: 'helpers/bookingRequest.js', suites: ['booking-request'],
      find: "        } else if (bare.length <= 24 && /\\d(?:st|nd|rd|th)\\b|[a-z]{3}/i.test(bare)) {",
      to:   '        } else if (bare.length <= 24) {' },
    { name: 'request: a bare "to X" is taken as a discharge port',
      file: 'helpers/bookingRequest.js', suites: ['booking-request', 'phrasebook'],
      find: '    const pod = POD_LABELLED.exec(t);',
      to:   "    const pod = POD_LABELLED.exec(t) || new RegExp('\\\\bto\\\\s+' + PORT_WORD + '(?=[,.;]|$)', 'i').exec(t);" },
    { name: 'request: a correction she never made is applied anyway',
      file: 'helpers/bookingRequest.js', suites: ['booking-request'],
      find: '    return Object.keys(patch).length ? patch : null;',
      to:   '    return patch;' },
    { name: 'request: the cutoff question is skipped, so the mail goes without one',
      file: 'workflow/actions.js', suites: ['phrasebook'],
      find: '    if (!s.cutoff && !s.cutoff_skipped) {',
      to:   '    if (false) {' },
    { name: 'request: what was inferred is filled in silently',
      file: 'workflow/actions.js', suites: ['phrasebook'],
      find: '    if (guessed.length) {',
      to:   '    if (false) {' },
    { name: 'request: her corrected port loses to the usual-route guess',
      file: 'workflow/actions.js', suites: ['phrasebook'],
      find: '    const to = s.to_override',
      to:   '    const to = null' },
    { name: 'request: a correction is applied without saying what changed',
      file: 'workflow/actions.js', suites: ['phrasebook'],
      find: '    await _send(chatId, `Right — ${br.describeCorrection(patch)}. Redrafting.`);',
      to:   '    void 0;' },
    { name: 'request: the port travels as English again, and gets reinterpreted',
      file: 'api.js', suites: ['phrasebook'],
      find: '                    if (mem.setRequestPort) mem.setRequestPort(offer.port);',
      to:   '                    void 0;' },
    { name: 'request: the stashed port outlives its turn and joins the next email',
      file: 'helpers/voiceMemory.js', suites: ['voice-memory'],
      find: '    requestPort = null;\n    return p;',
      to:   '    return p;' },

    // ── her screenshot: an email read as a bookings search (2026-09-09) ──
    { name: 'locality: a whole sentence matches a port again',
      file: 'helpers/booking.js', suites: ['booking-request', 'phrasebook'],
      find: '    if (Math.abs(lw.length - pw.length) > EXTRA_WORDS_ALLOWED) return false;',
      to:   '    if (l.includes(p) || p.includes(l)) return true;' },
    { name: 'locality: a fragment matches a port, so "san" finds BUSAN',
      file: 'helpers/booking.js', suites: ['booking-request'],
      find: '    return shortW.every((w) => longW.includes(w));',
      to:   '    return longW.join(" ").includes(shortW.join(" ")) || shortW.some((w) => longW.includes(w));' },
    { name: 'veto: the offline location net claims her email again',
      file: 'workflow/brain.js', suites: ['phrasebook'],
      find: '            if (requestToSomeone) return null;',
      to:   '            if (false) return null;' },
    { name: 'veto: the voice query path claims her email again',
      file: 'api.js', suites: ['phrasebook'],
      find: '                if (answeringBrain || rewrittenAsOrder || askingSomeone) {',
      to:   '                if (answeringBrain || rewrittenAsOrder) {' },
    { name: 'veto: an ordinary search gets vetoed too, so nothing lists',
      file: 'helpers/bookingRequest.js', suites: ['booking-request', 'phrasebook'],
      find: '    const m = ASK_SOMEONE.exec(t);\n    return !!(m && !NOT_A_PARTY.test(m[1]));',
      to:   '    return true;' },
    { name: 'name: "Wimax asking" is used as the recipient again',
      file: 'workflow/actions.js', suites: ['booking-request'],
      find: '    while (words.length > 1 && TRAILING_CONNECTIVES.test(words[words.length - 1])) {',
      to:   '    while (false) {' },
    { name: 'dates: "somewhere next week" becomes a specific Wednesday again',
      file: 'helpers/bookingRequest.js', suites: ['booking-request'],
      find: '    if (A_HEDGE.test(phrase)) {',
      to:   '    if (false) {' },

    // ── "no no..delete that" (2026-09-09) ───────────────────────────────
    { name: 'retract: "delete that" is not recognised again',
      file: 'helpers/repair.js', suites: ['repair'],
      find: '    if (UNDO.test(t) || UNDO_DEICTIC.test(t)) return \'undo\';',
      to:   "    if (UNDO.test(t)) return 'undo';" },
    { name: 'retract: "delete that booking" is read as a retraction',
      file: 'helpers/repair.js', suites: ['repair'],
      find: 'const ENDS_CLAUSE = "(?=\\\\s*(?:[.,!?;]|$|\\\\bplease\\\\b|\\\\bpls\\\\b))";',
      to:   'const ENDS_CLAUSE = "";' },
    { name: 'retract: the sentence she took back stays in memory',
      file: 'api.js', suites: ['phrasebook'],
      find: '                    try { forgot = mem.forgetLastExchange ? mem.forgetLastExchange() : 0; }',
      to:   '                    try { forgot = 0; }' },
    { name: 'retract: forgetting eats a sentence she still means',
      file: 'helpers/voiceMemory.js', suites: ['repair'],
      find: '    while (turns.length && mine < 2) {',
      to:   '    while (turns.length && mine < 3) {' },
    { name: 'retract: what was being discussed survives the retraction',
      file: 'helpers/voiceMemory.js', suites: ['repair'],
      find: '    center = null;\n    queryFrame = null;\n    if (dropped.length)',
      to:   '    if (dropped.length)' },

    // ── Bills and Sales, the Edge Metals pair (2026-09-09/10) ───────────
    { name: 'bills: a missing tare is treated as zero again',
      file: 'helpers/bills.js', suites: ['bills-sales'],
      find: '    const missing = Object.keys(tare).filter((k) => tare[k] === null);',
      to:   '    const missing = [];' },
    { name: 'bills: the $10 rule flips, so lbs and MT swap',
      file: 'helpers/bills.js', suites: ['bills-sales'],
      find: '        : (price === null ? null : (price < PER_LB_CEILING ? \'lb\' : \'mt\'));',
      to:   "        : (price === null ? null : (price < PER_LB_CEILING ? 'mt' : 'lb'));" },
    { name: 'bills: balance stops subtracting the trucking',
      file: 'helpers/bills.js', suites: ['bills-sales'],
      find: '        : round2(amountUsed - (trucking || 0));',
      to:   '        : round2(amountUsed);' },
    { name: 'bills: every container on a booking gets container 1\'s number',
      file: 'api.js', suites: ['bills-sales'],
      find: '            const box = (bk.containers || []).find((c) => Number(c.seq) === seq)',
      to:   '            const box = (bk.containers || []).find((c) => Number(c.seq) === 1)' },
    { name: 'bills: the other containers are no longer offered to pick from',
      file: 'api.js', suites: ['bills-sales'],
      find: '                containers: (bk.containers || []).map((c) => ({',
      to:   '                containers: [].map((c) => ({' },
    { name: 'edit: a cleared field comes back on the next save',
      file: 'dashboard/index.html', suites: ['bills-sales'],
      find: "        new FormData($('ledgerForm')).forEach((v, k) => { if (!(k in body)) body[k] = ''; });",
      to:   '        void 0;' },
    { name: 'edit: an edit may blank the supplier an add insists on',
      file: 'helpers/bills.js', suites: ['bills-sales'],
      find: "        if (!merged.supplier) { problem = 'a bill needs a supplier'; return rows; }",
      to:   '        void 0;' },
    { name: 'edit: a refused edit is written anyway',
      file: 'helpers/bills.js', suites: ['bills-sales'],
      find: "        if (!merged.date) { problem = 'a bill needs a date'; return rows; }",
      to:   '        void 0;' },
    { name: 'edit: the row loses its Edit button',
      file: 'dashboard/index.html', suites: ['bills-sales'],
      find: '<button class="btn btn-secondary ledger-edit"',
      to:   '<button class="btn btn-secondary ledger-editX"' },
    { name: 'form: the two Truckings are indistinguishable again',
      file: 'helpers/bills.js', suites: ['bills-sales'],
      find: "      formLabel: 'Trucking company', placeholder: 'who hauled it' },",
      to:   "      placeholder: 'who hauled it' }," },
    { name: 'form: the supplier invoice amount loses its input again',
      file: 'helpers/bills.js', suites: ['bills-sales'],
      find: "      writeKey: 'supplier_invoice_amount', num: true,",
      to:   '      num: true,' },
    { name: 'preview: the running total writes a row',
      file: 'api.js', suites: ['bills-sales'],
      find: "        try { res.json({ ok: true, ...require('./helpers/bills').compute(req.body || {}) }); }",
      to:   "        try { require('./helpers/bills').addBill(req.body || {}); res.json({ ok: true, ...require('./helpers/bills').compute(req.body || {}) }); }" },
    { name: 'bills: a client may post its own balance again',
      file: 'helpers/bills.js', suites: ['bills-sales'],
      find: "const WRITABLE = COLUMNS.filter((c) => !c.derived).map((c) => c.key)\n    .concat(['supplier_invoice_amount', 'price_unit', 'note']);",
      to:   "const WRITABLE = COLUMNS.map((c) => c.key)\n    .concat(['supplier_invoice_amount', 'price_unit', 'note', 'balance', 'net_lb']);" },
    { name: 'bills: the supplier invoice amount is unwritable again',
      file: 'helpers/bills.js', suites: ['bills-sales'],
      find: "    .concat(['supplier_invoice_amount', 'price_unit', 'note']);",
      to:   "    .concat(['price_unit', 'note']);" },
    { name: 'sales: the $10 rule is copied instead of imported',
      file: 'helpers/sales.js', suites: ['bills-sales'],
      find: '        : (price === null ? null : (price < bills.PER_LB_CEILING ? \'lb\' : \'mt\'));',
      to:   "        : (price === null ? null : (price < 12 ? 'lb' : 'mt'));" },
    { name: 'sales: freight stops coming off the top',
      file: 'helpers/sales.js', suites: ['bills-sales'],
      find: '    const net = amountUsed === null ? null : round2(amountUsed - (freight || 0));',
      to:   '    const net = amountUsed;' },
    { name: 'prefill: getBooking\'s wrapper is read directly again',
      file: 'api.js', suites: ['bills-sales'],
      find: "            const { booking: bk } = require('./helpers/booking').getBooking(bkgNo);",
      to:   "            const bk = require('./helpers/booking').getBooking(bkgNo);" },
    { name: 'draft: the email drafter gets "Booking undefined" again',
      file: 'workflow/actions.js', suites: ['phrasebook'],
      find: '    const { booking: bkg } = bkgNo ? getBooking(bkgNo) : { booking: null };\n    const bookingLine = bkg\n        ? `Booking ${bkg.booking_number}: carrier ${bkg.carrier || \'—\'}, ERD ${bkg.erd_date || \'—\'}, cutoff ${bkg.cutoff_date || \'—\'}, POL',
      to:   '    const bkg = bkgNo ? getBooking(bkgNo) : null;\n    const bookingLine = bkg\n        ? `Booking ${bkg.booking_number}: carrier ${bkg.carrier || \'—\'}, ERD ${bkg.erd_date || \'—\'}, cutoff ${bkg.cutoff_date || \'—\'}, POL' },
    { name: 'staff: supplier prices become readable by the yard',
      file: 'api.js', suites: ['bills-sales'],
      find: "'/api/trucker-bills', '/api/verify-admin-password']",
      to:   "'/api/trucker-bills', '/api/verify-admin-password', '/api/bills', '/api/sales']" },

    { name: 'continuation: an answer is glued to the previous one again',
      file: 'dashboard/voice.js', suites: ['voice-web'],
      find: "                if (r && r.awaiting) lastAsked = '';",
      to:   '                void 0;' },

    // ── "the houston booking" (2026-09-09) ──────────────────────────────
    { name: 'place: a booking named by its port is not resolved at all',
      file: 'workflow/actions.js', suites: ['phrasebook'],
      find: "    const byPlace = bk.resolveByPlace(bkgNo);",
      to:   '    const byPlace = null;' },
    { name: 'place: it picks one when several load at that port',
      file: 'helpers/booking.js', suites: ['phrasebook'],
      find: "    if (hit.count === 1) return { kind: 'one', booking: hit.records[0] };\n    return { kind: 'many', rows: hit.records };",
      to:   "    return { kind: 'one', booking: hit.records[0] };" },
    // NOT LISTED: removing `if (getBooking(q).booking) return null;` from
    // resolveByPlace. Unkillable with realistic data — a port query never
    // matches a booking NUMBER, so the guard has nothing to do until she owns
    // a booking whose id reads like one of her ports. Kept because it states
    // the ordering rule this whole area depends on (identity beats
    // description, the same rule written in helpers/genericTerm.js), and
    // because the day it stops being redundant is the day it matters. Third
    // one of these today; each is recorded rather than quietly left to look
    // like a weak test.
    { name: 'place: the trucker she already named is dropped',
      file: 'workflow/actions.js', suites: ['phrasebook'],
      find: '            party_name: partyName || null,',
      to:   '            party_name: null,' },
    { name: 'place: the grammar loses the trailing noun again',
      file: 'workflow/brain.js', suites: ['phrasebook'],
      find: 'const NOUN_SUFFIX = String.raw`(?:\\s+(?:booking|bookings|load|loads|shipment|container))?`;',
      to:   'const NOUN_SUFFIX = String.raw``;' },

    // ── which account the money left (2026-09-09) ───────────────────────
    { name: 'bank: a Zelle with no bank is accepted from the form',
      file: 'helpers/banks.js', suites: ['banks', 'trucker-bills'],
      find: '        if (required) {\n            throw new Error(`Which bank did the ${mode} go out of?',
      to:   '        if (false) {\n            throw new Error(`Which bank did the ${mode} go out of?' },
    { name: 'bank: a bank on a Cash payment is stored, not refused',
      file: 'helpers/banks.js', suites: ['banks'],
      find: "        if (String(bank || '').trim()) {\n            throw new Error(`${mode} has no bank behind it",
      to:   "        if (false) {\n            throw new Error(`${mode} has no bank behind it" },
    { name: 'bank: two spellings of one account become two banks',
      file: 'helpers/banks.js', suites: ['banks'],
      find: '    return options().find((b) => b.toLowerCase() === q.toLowerCase()) || null;',
      to:   '    return options().find((b) => b === q) || null;' },
    { name: 'bank: what she types under Others is not remembered',
      file: 'helpers/banks.js', suites: ['banks'],
      find: '    return remember(given);',
      to:   '    return given;' },
    { name: 'bank: a pasted essay is stored whole',
      file: 'helpers/banks.js', suites: ['banks'],
      find: "    const clean = q.replace(/\\s+/g, ' ').slice(0, 40);",
      to:   '    const clean = q;' },
    { name: 'bank: the requirement becomes blanket, breaking an old APK',
      file: 'api.js', suites: ['trucker-bills'],
      find: "            const clientKnowsBanks = Object.prototype.hasOwnProperty.call(b || {}, 'bank');",
      to:   '            const clientKnowsBanks = true;' },
    { name: 'bank: nothing is ever required, so the gap never closes',
      file: 'api.js', suites: ['trucker-bills'],
      find: "            const clientKnowsBanks = Object.prototype.hasOwnProperty.call(b || {}, 'bank');",
      to:   '            const clientKnowsBanks = false;' },
    { name: 'report: rows with no bank are dropped instead of counted',
      file: 'helpers/spendReport.js', suites: ['banks'],
      find: "            bank: (p.bank && String(p.bank).trim()) || NOT_RECORDED,",
      to:   '            bank: p.bank || null,' },
    { name: 'report: the bank filter narrows rows but not the totals',
      file: 'helpers/spendReport.js', suites: ['banks'],
      find: "        .filter(r => !wantedBank || String(r.bank || '').toLowerCase() === wantedBank.toLowerCase());",
      to:   '        ;' },

    // ── the offer, and the answer to it (2026-09-08) ────────────────────
    { name: 'offer: "yes" goes back to being answered from the table',
      file: 'api.js', suites: ['phrasebook'],
      find: '            const isOrder = rewrittenAsOrder || ac.IS_INSTRUCTION.test(stripped);',
      to:   '            const isOrder = ac.IS_INSTRUCTION.test(stripped);' },
    { name: 'offer: the rewrite happens but is never executed',
      file: 'api.js', suites: ['phrasebook'],
      find: '            const looksLikeOrder = rewrittenAsOrder || acEarly.IS_INSTRUCTION.test(stripped);',
      to:   '            const looksLikeOrder = acEarly.IS_INSTRUCTION.test(stripped);' },
    // NOT LISTED: dropping the `/want me to forward/.test(said)` half of the
    // offer-recording condition. fu.opening() appends the offer to EVERY
    // summary it produces, so today the test can never be false and the
    // mutation is unkillable by construction — like the genericTerm
    // exact-list line. The check stays in the code because it reads what was
    // actually SAID rather than assuming from the branch, which is what keeps
    // it correct if that wording ever becomes conditional. If it does, this
    // note is the reminder to add the mutation back.
    { name: 'offer: with several on screen it picks one for her',
      file: 'api.js', suites: ['phrasebook'],
      find: '                    if (offer.rows && offer.rows.length === 1 && offer.rows[0].booking_number) {',
      to:   '                    if (offer.rows && offer.rows.length >= 1 && offer.rows[0].booking_number) {' },
    { name: 'offer: it never lapses, so a later "yes" fires it',
      file: 'api.js', suites: ['phrasebook'],
      find: '                } else if (mem.clearOffer) {\n                    // She said something else entirely.',
      to:   '                } else if (false) {\n                    // She said something else entirely.' },
    { name: 'offer: "no" is not heard as an answer',
      file: 'api.js', suites: ['phrasebook'],
      find: "                } else if (NO.test(stripped)) {",
      to:   '                } else if (false) {' },
    { name: 'offer: her pick from the list is ignored',
      file: 'api.js', suites: ['phrasebook'],
      find: '                if (chosen && chosen.booking_number) {',
      to:   '                if (false) {' },

    // ── the blocked forward, and the answer that must land (2026-09-08) ─
    { name: 'assign: the category guard is missing again, as it was yesterday',
      file: 'workflow/actions.js', suites: ['phrasebook'],
      find: "if (require('../helpers/genericTerm').isAnyCategory(bkgNo)) {\n    let focus = null;\n    try {\n        const mem = require('../helpers/voiceMemory');\n        focus = mem.currentCenter();\n        if (!focus) {\n            const set = mem.currentReferents();\n            if (set && Array.isArray(set.rows) && set.rows.length === 1) focus = set.rows[0];\n        }\n    } catch (e) { /* no voice memory in a WhatsApp-only flow */ }\n    if (focus && focus.booking_number) {\n        console.log(`[ACTIONS] \"${bkgNo}\" is a category word — using the booking in focus, ${focus.booking_number}`);",
      to:   "if (false) {\n    let focus = null;\n    try {\n        const mem = require('../helpers/voiceMemory');\n        focus = mem.currentCenter();\n        if (!focus) {\n            const set = mem.currentReferents();\n            if (set && Array.isArray(set.rows) && set.rows.length === 1) focus = set.rows[0];\n        }\n    } catch (e) { /* no voice memory in a WhatsApp-only flow */ }\n    if (focus && focus.booking_number) {\n        console.log(`[ACTIONS] \"${bkgNo}\" is a category word — using the booking in focus, ${focus.booking_number}`);" },
    { name: 'assign: only booking words count, so "supplier" slips through',
      file: 'helpers/genericTerm.js', suites: ['phrasebook'],
      find: '    return Object.keys(GENERIC).some((kind) => isGeneric(word, kind));',
      to:   "    return isGeneric(word, 'booking');" },
    { name: 'blocked forward: back to a dead end with no way past it',
      file: 'workflow/actions.js', suites: ['phrasebook'],
      find: '            if (sel.text) offer = sel.text;',
      to:   '            if (false) offer = sel.text;' },
    { name: 'blocked forward: she has to say "forward" a second time',
      file: 'workflow/actions.js', suites: ['phrasebook'],
      find: "        if (pending.then_forward && res && res.action_taken === 'assigned') {",
      to:   '        if (false) {' },
    { name: 'blocked forward: it forwards even when the assign did not land',
      file: 'workflow/actions.js', suites: ['phrasebook', 'forward-flow'],
      find: "        if (pending.then_forward && res && res.action_taken === 'assigned') {",
      to:   '        if (pending.then_forward) {' },
    { name: 'pending: the query path steals her answer to an open question',
      file: 'api.js', suites: ['phrasebook'],
      find: '                if (answeringBrain) {\n                    cards = null;\n                } else if (followingUp && !answeringPort) {',
      to:   '                if (followingUp && !answeringPort) {' },

    // ── an order is not answered from the table (2026-09-08) ────────────
    { name: 'order: the follow-up answerer gets to reply to "forward the booking"',
      file: 'api.js', suites: ['phrasebook', 'e2e-voice'],
      find: '            const quick = (answeringBrain || looksLikeOrder)',
      to:   '            const quick = (answeringBrain)' },
    { name: 'order: every sentence counts as an order, so nothing is answered',
      file: 'api.js', suites: ['phrasebook', 'e2e-voice'],
      find: '            const looksLikeOrder = acEarly.IS_INSTRUCTION.test(stripped);',
      to:   '            const looksLikeOrder = true;' },

    // ── a repair has to point at something (2026-09-08) ─────────────────
    { name: 'repair: a label with no reparandum is trusted again',
      file: 'helpers/repair.js', suites: ['repair'],
      find: "        if (label !== 'none' && res && res.refers_to_previous === false) {",
      to:   '        if (false) {' },
    { name: 'repair: a missing field counts as false (silence as a vote)',
      file: 'helpers/repair.js', suites: ['repair'],
      find: 'res.refers_to_previous === false',
      to:   '!res.refers_to_previous' },
    { name: 'repair: the backstop is removed, so a new subject can retract',
      file: 'helpers/repair.js', suites: ['repair'],
      find: '    if (!POINTS_BACK.test(t)) {',
      to:   '    if (false) {' },
    { name: 'repair: the backstop fires the wrong way, killing real retractions',
      file: 'helpers/repair.js', suites: ['repair'],
      find: '    if (!POINTS_BACK.test(t)) {',
      to:   '    if (POINTS_BACK.test(t)) {' },

    // ── EDGE METALS MONEY, 2026-09-10 ────────────────────────────────────
    { name: 'metals cash drains the EDGE YARD petty cash box',
      file: 'helpers/payments.js', suites: ['bills-sales'],
      find: "const drawsPettyCash = mode === 'Cash' && loadKind !== 'bill';",
      to:   "const drawsPettyCash = mode === 'Cash';" },
    // ── TWO MUTATIONS TRIED AND DELIBERATELY NOT KEPT, 2026-09-10 ────────
    // Removing the `&& load_kind !== 'bill'` guard from either delete path in
    // helpers/payments.js SURVIVES, and it should: pettyCash.reverseForPayment
    // opens with `if (!taken.length) return list;  // never drew on cash`, so
    // a Metals cash payment — which never withdrew — cannot be refunded no
    // matter who asks. The guards stay because they state the rule where it is
    // read, but they are belt to that file's braces, not the protection.
    //
    // They are not in this catalogue because a mutation that can never be
    // killed is worse than no mutation: it puts a permanent line in the
    // SURVIVED list, and a survivors list you have learned to skim is a
    // survivors list that no longer works. Written down so nobody adds them
    // back and spends the same hour.
    { name: 'a cash payment is made to demand a bank it cannot have',
      file: 'helpers/billPayments.js', suites: ['bills-sales'],
      find: "if (mode !== 'Cash' && !String(input.bank || '').trim()) {",
      to:   "if (!String(input.bank || '').trim()) {" },
    { name: 'a wire can settle a DIFFERENT supplier\'s container',
      file: 'helpers/billPayments.js', suites: ['bills-sales'],
      find: '            if (b && !sameSupplier(b.supplier, supplier)) {',
      to:   '            if (false) {' },
    { name: 'applying credit is bound by the caller, not by whose advance it is',
      file: 'helpers/billPayments.js', suites: ['bills-sales'],
      find: '                                      { allowUnallocated: true, supplier: rows[i].supplier || null });',
      to:   '                                      { allowUnallocated: true });' },
    { name: 'supplier matching is exact, so a stray space is a new company',
      file: 'helpers/billPayments.js', suites: ['bills-sales'],
      find: "    String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();",
      to:   '    String(a) === String(b);' },
    { name: 'a payment need not say who it paid',
      file: 'helpers/billPayments.js', suites: ['bills-sales'],
      find: "    if (!advance && !String(input.supplier || '').trim()) {",
      to:   '    if (false) {' },
    { name: 'the pay form skips asking which supplier',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: '  if (!applying && !supplier) return openBillPaySupplier(data);',
      to:   '  if (false) return openBillPaySupplier(data);' },
    { name: 'the container list is not filtered to the chosen supplier',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: '  const open = (data.open_bills || []).filter((b) => sameSupplier(b.supplier, supplier));',
      to:   '  const open = (data.open_bills || []);' },
    { name: 'deleting a payment leaves its row in the spend ledger',
      file: 'helpers/billPayments.js', suites: ['bills-sales'],
      find: 'await deletePaymentsForLoad(doomed.id);',
      to:   'void deletePaymentsForLoad;' },
    { name: 'deleting a payment is not audited',
      file: 'api.js', suites: ['bills-sales'],
      find: "action: doomed.kind === 'advance' ? 'delete-bill-advance' : 'delete-bill-payment',",
      to:   "action: 'not-a-real-action'," },
    { name: 'the Shipment tab is not told the payment is gone',
      file: 'api.js', suites: ['bills-sales'],
      find: "ship.logBillSafely({ ...bill, paid: paid[bill.id] || 0 }, 'payment-removed');",
      to:   "void ship;" },
    { name: 'a part-allocated transfer can be saved as a full payment',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: '      : (sent > 0 && Math.abs(left) < 0.005);',
      to:   '      : (sent > 0);' },
    { name: 'one click deletes a payment, with no confirm',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: '      if (armed !== btn) {',
      to:   '      if (false) {' },
    { name: 'a new bill is dated by the browser clock, not by Los Angeles',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: "toUsDate(todayYardDateStr()) : undefined;",
      to:   "toUsDate(todayLocalDateStr()) : undefined;" },

    // ── EDGE METALS SALES AT CONTAINER GRAIN, 2026-09-10 ─────────────────
    { name: 'a charge can be recorded with no note explaining it',
      file: 'helpers/sales.js', suites: ['bills-sales'],
      find: '        if (!why) throw new Error(`"${what}" needs a note saying why',
      to:   '        if (false) throw new Error(`"${what}" needs a note saying why' },
    { name: 'an outgoing charge is added to what the customer owes',
      file: 'helpers/sales.js', suites: ['bills-sales'],
      find: '    const receivable = amountUsed === null ? null : round2(amountUsed + chargesIn);',
      to:   '    const receivable = amountUsed === null ? null : round2(amountUsed + chargesIn + chargesOut);' },
    { name: 'a legacy freight figure is counted twice alongside real charges',
      file: 'helpers/sales.js', suites: ['bills-sales'],
      find: '    if (!charges.length && freight) {',
      to:   '    if (freight) {' },
    { name: 'commission runs off pounds, not metric tons',
      file: 'helpers/sales.js', suites: ['bills-sales'],
      find: '    const commissionComputed = (perMt === null || mt === null) ? null : round2(mt * perMt);',
      to:   '    const commissionComputed = (perMt === null || lb === null) ? null : round2(lb * perMt);' },
    { name: 'no commission rate is read as zero rather than unknown',
      file: 'helpers/sales.js', suites: ['bills-sales'],
      find: '    const commission = commissionStated !== null ? round2(commissionStated) : commissionComputed;',
      to:   '    const commission = commissionStated !== null ? round2(commissionStated) : (commissionComputed || 0);' },
    { name: 'rows sort by container first, so a booking is split across the table',
      file: 'helpers/sales.js', suites: ['bills-sales'],
      find: '        if (ab !== bb) return ab < bb ? -1 : 1;',
      to:   '        if (ac !== bc) return ac < bc ? -1 : 1;' },
    { name: 'the same container under DIFFERENT bookings counts as a duplicate',
      file: 'helpers/sales.js', suites: ['bills-sales'],
      find: '        const k = `${bk}|${cn}`;',
      to:   '        const k = `${cn}`;' },
    { name: 'terms accept anything, not just LC or TT',
      file: 'helpers/sales.js', suites: ['bills-sales'],
      find: "        if (!t) throw new Error(`terms must be ${TERMS.join(' or ')}`);",
      to:   '        if (!t) { out.terms = String(out.terms); return out; }' },
    { name: 'duplicate containers are never reported to the client',
      file: 'api.js', suites: ['bills-sales'],
      find: '                duplicates: s.duplicates(all),',
      to:   '                duplicates: [],' },

    // ── MARK AS PAID / RECEIPTS, 2026-09-10 ──────────────────────────────
    { name: 'a shortfall can be recorded without saying what it was',
      file: 'helpers/salesReceipts.js', suites: ['bills-sales'],
      find: '            if (!reason) {',
      to:   '            if (false) {' },
    { name: 'a discount is filed as a bank charge',
      file: 'helpers/salesReceipts.js', suites: ['bills-sales'],
      find: "            if (a.deduction_reason === 'bank_charge') t += (num(a.deduction_amount) || 0);",
      to:   '            t += (num(a.deduction_amount) || 0);' },
    { name: 'a deduction counts as money that arrived',
      file: 'helpers/salesReceipts.js', suites: ['bills-sales'],
      find: '    const received = round2(out.reduce((s, a) => s + a.amount, 0)) || 0;',
      to:   '    const received = round2(out.reduce((s, a) => s + a.amount + a.deduction_amount, 0)) || 0;' },
    { name: 'a receipt can settle another customer\'s container',
      file: 'helpers/salesReceipts.js', suites: ['bills-sales'],
      find: '        if (customer && !sameCustomer(row.customer, customer)) {',
      to:   '        if (false) {' },
    { name: 'the balance ignores deductions, so a settled row still shows owing',
      file: 'helpers/sales.js', suites: ['bills-sales'],
      find: '                : round2(t.receivable - got - (ded.total || 0)),',
      to:   '                : round2(t.receivable - got),' },
    { name: 'Mark paid is offered on a container already settled',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: "        ${kind === 'sales' && r.balance !== null && r.balance > 0.005",
      to:   "        ${kind === 'sales' && r.balance !== null" },
    { name: 'the shortfall question never appears',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: "    $('mpShort').style.display = short > 0.005 ? 'block' : 'none';",
      to:   "    $('mpShort').style.display = 'none';" },

    // ── SALES: SETTLEMENTS AND THE FOUR TABS, 2026-09-10 ─────────────────
    { name: 'a charge the CUSTOMER pays becomes something she has to pay',
      file: 'helpers/salesSettlements.js', suites: ['bills-sales'],
      find: "            if (c.direction !== 'out') continue;         // 'in' is a receivable",
      to:   '            if (false) continue;' },
    { name: 'a payable can be paid past its balance, twice over',
      file: 'helpers/salesSettlements.js', suites: ['bills-sales'],
      find: '        if (a.amount - target.balance > CENT) {',
      to:   '        if (false) {' },
    { name: 'a settlement writes no row to the spend report',
      file: 'helpers/salesSettlements.js', suites: ['bills-sales'],
      find: '    const mirrored = await mirrorToLedger(rec);',
      to:   '    const mirrored = null; void mirrorToLedger;' },
    { name: 'a sale cost is filed as a supplier payment',
      file: 'helpers/salesSettlements.js', suites: ['bills-sales'],
      find: "        load_kind: 'sale_cost',",
      to:   "        load_kind: 'bill'," },
    { name: 'sale costs fall into the expenses bucket, the unnamed-kind trap',
      file: 'helpers/spendReport.js', suites: ['bills-sales'],
      find: "        else if (r.kind === 'sale_cost') saleCostTotal = round2(saleCostTotal + r.amount);",
      to:   '        else if (false) {}' },
    { name: 'an Edge Metals cash settlement drains the yard petty cash box',
      file: 'helpers/payments.js', suites: ['bills-sales'],
      find: "const EDGE_METALS_KINDS = new Set(['bill', 'sale_cost']);",
      to:   "const EDGE_METALS_KINDS = new Set(['bill']);" },
    { name: 'a container already sold is offered for sale again',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: "            <button class=\"fbPick\" data-id=\"${esc(b.id)}\" ${b.sold ? 'disabled' : ''}",
      to:   "            <button class=\"fbPick\" data-id=\"${esc(b.id)}\"" },
    { name: 'a line with no ticket has no way to enter its weight',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: '            : `<input data-i="${i}" data-f="weight" ${cell(it.weight, \'net lbs\', \'86px\')}',
      to:   '            : `<span data-i="${i}" data-x="weight" ${cell(it.weight, \'net lbs\', \'86px\')}' },
    { name: 'the weighbridge ticket is shown on every line, always',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: "        <div class=\"ledTicket\" data-i=\"${i}\" style=\"display:${hasTicket ? 'flex' : 'none'};",
      to:   "        <div class=\"ledTicket\" data-i=\"${i}\" style=\"display:flex;" },
    { name: 'deleting a line never asks for a save',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: '      b.onclick = () => { ledItems.splice(+b.dataset.i, 1); paintItems(); queueSave(); };',
      to:   '      b.onclick = () => { ledItems.splice(+b.dataset.i, 1); paintItems(); };' },
    { name: 'the item lines never reach the server',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: '    if (items.length || (existing && (existing.items || []).length)) body.items = items;',
      to:   '' },
    { name: 'a missing Other note is not flagged until the server refuses it',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: '          note.style.borderColor = wants ? L.danger : L.line;',
      to:   '' },
    { name: 'the haulage split never reaches the server',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: '        body.trucking_split = {',
      to:   '        body.nothing_at_all = {' },

    { name: 'an Other can be recorded with nothing saying what it was',
      file: 'helpers/bills.js', suites: ['bills-sales'],
      find: '        if (!note) throw new Error(`"${what}" needs a note saying what it was',
      to:   '        if (false) throw new Error(`"${what}" needs a note saying what it was' },
    { name: 'the typed total wins over the split it contradicts',
      file: 'helpers/bills.js', suites: ['bills-sales'],
      find: "    const trucking = (split.present && split.total !== null) ? split.total : typedTrucking;",
      to:   '    const trucking = typedTrucking !== null ? typedTrucking : split.total;' },
    { name: 'a typed total that disagrees with the split is swallowed',
      file: 'helpers/bills.js', suites: ['bills-sales'],
      find: "    const truckingConflict = (split.present && typedTrucking !== null && split.total !== null\n        && Math.abs(typedTrucking - split.total) >= 0.005)\n        ? round2(typedTrucking - split.total) : null;",
      to:   '    const truckingConflict = null;' },
    { name: 'a zero part is dropped from the split she reads',
      file: 'helpers/bills.js', suites: ['bills-sales'],
      find: '        .filter((k) => out[k] !== null)',
      to:   '        .filter((k) => out[k])' },
    { name: 'an invoice logged before the figures reads as $0',
      file: 'helpers/bills.js', suites: ['bills-sales'],
      find: '    const anyMoney = TRUCKING_PARTS.some((k) => out[k] !== null) || out.others.length > 0;',
      to:   '    const anyMoney = any;' },
    { name: 'the haulage list reads the stale typed figure',
      file: 'helpers/metalsTrucking.js', suites: ['bills-sales'],
      find: '        const amount = num(b.trucking_amount_used !== undefined\n            ? b.trucking_amount_used : b.trucking_amount);',
      to:   '        const amount = num(b.trucking_amount);' },
    { name: 'the split never reaches the row, so there is nothing to expand',
      file: 'helpers/metalsTrucking.js', suites: ['ledger-render', 'bills-sales'],
      find: '            split: b.trucking_split || null,',
      to:   '            split: null,' },
    { name: 'the split is shown always, not folded away',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: '            <tr class="trkDetail" data-for="${esc(r.bill_id)}" style="display:none; background:var(--surface-sunken);">',
      to:   '            <tr class="trkDetail" data-for="${esc(r.bill_id)}" style="background:var(--surface-sunken);">' },

    { name: 'a haul nobody priced drops out of the list again',
      file: 'helpers/metalsTrucking.js', suites: ['bills-sales'],
      find: '        if (!priced && !company) continue;',
      to:   '        if (!priced) continue;' },
    { name: 'an unpriced haul shows as $0 rather than blank',
      file: 'helpers/metalsTrucking.js', suites: ['bills-sales'],
      find: '            amount: priced ? amount : null,',
      to:   '            amount: priced ? amount : 0,' },
    { name: 'unpaid sweeps up the unfinished ones',
      file: 'helpers/metalsTrucking.js', suites: ['bills-sales'],
      find: "        if (status === 'unpaid' && (r.status === 'paid' || r.status === 'missing')) return false;",
      to:   "        if (status === 'unpaid' && r.status === 'paid') return false;" },
    { name: 'a haul nobody priced can be paid, inventing the amount',
      file: 'helpers/metalsTrucking.js', suites: ['bills-sales'],
      find: '    const open = new Map(payables().filter((p) => p.priced).map((p) => [p.bill_id, p]));',
      to:   '    const open = new Map(payables().map((p) => [p.bill_id, p]));' },

    // ── HER GROUPING AND INLINE LABELS, 2026-09-10 ───────────────────────
    { name: 'the label goes back above the field',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: '    const m = /^([\\s\\S]*?)<label[^>]*>([\\s\\S]*?)<\\/label>([\\s\\S]*)$/.exec(built);',
      to:   '    const m = null;' },
    { name: 'the rewrap drops the type-ahead',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: '      <div style="flex:1; min-width:0; position:relative;">${rest.replace(/<\\/div>\\s*$/, \'\')}</div>',
      to:   '      <div style="flex:1; min-width:0; position:relative;">${rest.replace(/<datalist[\\s\\S]*?<\\/datalist>/, \'\').replace(/<\\/div>\\s*$/, \'\')}</div>' },
    { name: 'a group falls back to array order instead of the order she gave',
      file: 'helpers/bills.js', suites: ['bills-sales'],
      find: '    if (g && Array.isArray(g.keys)) {',
      to:   '    if (false) {' },
    { name: 'trucking goes back into the Money group',
      file: 'helpers/bills.js', suites: ['bills-sales'],
      find: "    { key: 'trucking_company', label: 'Trucker',            group: 'trucking',",
      to:   "    { key: 'trucking_company', label: 'Trucker',            group: 'money'," },

    // ── SEVERAL GRADES ON ONE INVOICE, 2026-09-10 ────────────────────────
    { name: 'a multi-grade sale is priced on one blended price',
      file: 'helpers/sales.js', suites: ['bills-sales'],
      find: '    if (itemsAmount !== null) amount = itemsAmount;',
      to:   '' },
    { name: 'the invoiced weight ignores the lines',
      file: 'helpers/sales.js', suites: ['bills-sales'],
      find: '    const lbUsed = items.length && itemsWeightLb !== null ? itemsWeightLb : lb;',
      to:   '    const lbUsed = lb;' },
    { name: 'commission is paid on a weight the invoice does not show',
      file: 'helpers/sales.js', suites: ['bills-sales'],
      find: '    const commissionComputed = (perMt === null || mtUsed === null) ? null : round2(mtUsed * perMt);',
      to:   '    const commissionComputed = (perMt === null || mt === null) ? null : round2(mt * perMt);' },
    { name: 'sales grows its own copy of a grade line',
      file: 'helpers/sales.js', suites: ['bills-sales'],
      find: '    if (\'items\' in out) out.items = bills.cleanItems(out.items);',
      to:   '' },
    { name: 'a typed sale weight is overwritten in silence',
      file: 'helpers/sales.js', suites: ['bills-sales'],
      find: '    const weightConflict = (items.length && typedLb !== null && lbUsed !== null\n        && Math.abs(typedLb - lbUsed) >= 0.001) ? round3(typedLb - lbUsed) : null;',
      to:   '    const weightConflict = null;' },
    { name: 'the month filter comes back beside the date range',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: "        ${sel('trucking_company', 'Trucker', facets.trucking_company, 160)}",
      to:   "        ${sel('month', 'Month', facets.month, 120)}\n        ${sel('trucking_company', 'Trucker', facets.trucking_company, 160)}" },

    // ── EDGE METALS HAULAGE, 2026-09-10 ──────────────────────────────────
    { name: 'metals haulage is filed as yard trucker spend',
      file: 'helpers/metalsTrucking.js', suites: ['bills-sales'],
      find: "        load_kind: 'metals_trucking',",
      to:   "        load_kind: 'trucker'," },
    { name: 'a haulage payment writes no row to the spend report',
      file: 'helpers/metalsTrucking.js', suites: ['bills-sales'],
      find: '    const mirrored = await mirrorToLedger(rec);',
      to:   '    const mirrored = null; void mirrorToLedger;' },
    { name: 'a wire can settle another haulier\'s container',
      file: 'helpers/metalsTrucking.js', suites: ['bills-sales'],
      find: '        if (company && target.trucking_company && !sameCompany(target.trucking_company, company)) {',
      to:   '        if (false) {' },
    { name: 'a haul can be paid past its balance',
      file: 'helpers/metalsTrucking.js', suites: ['bills-sales'],
      find: '        if (a.amount - target.balance > CENT) {',
      to:   '        if (false) {' },
    { name: 'a bill with a trucker but no amount becomes a zero payable',
      file: 'helpers/metalsTrucking.js', suites: ['bills-sales'],
      find: '        if (amount === null || amount <= 0) continue;',
      to:   '        if (amount === null) continue;' },
    { name: 'the date filter compares her MM/DD/YYYY as plain text',
      file: 'helpers/metalsTrucking.js', suites: ['bills-sales'],
      find: "    const fromIso = from ? (bills.sortableDate(from) || from) : '';",
      to:   '    const fromIso = from;' },
    { name: 'filtering to unpaid hides the part-paid hauls she still owes on',
      file: 'helpers/metalsTrucking.js', suites: ['bills-sales'],
      find: "        if (status === 'unpaid' && r.status === 'paid') return false;",
      to:   "        if (status === 'unpaid' && r.status !== 'unpaid') return false;" },
    { name: 'the summary is computed over everything, not the filtered rows',
      file: 'api.js', suites: ['bills-sales'],
      find: '                summary: mt.summary(rows),',
      to:   '                summary: mt.summary(all),' },
    { name: 'the Trucking filters never reach the server',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: "  const data = await api('/api/metals-trucking' + (qs ? `?${qs}` : ''));",
      to:   "  const data = await api('/api/metals-trucking');" },

    { name: 'the palette toggle stores a preference and repaints nothing',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: "    if (typeof ledgerReopen === 'function') ledgerReopen();",
      to:   '' },
    { name: 'the choice is not remembered between visits',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: "  try { localStorage.setItem('ledgerTheme', LEDGER_THEME_NAME); } catch (e) {}",
      to:   '' },
    { name: 'Save goes back to the dark app\'s green on a light sheet',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: '<button id="ledSave" class="btn btn-primary" style="font-size:11px; padding:8px 20px; background:${LEDGER_LIGHT.accent}; border-color:${LEDGER_LIGHT.accent}; color:${LEDGER_LIGHT.accentInk};">',
      to:   '<button id="ledSave" class="btn btn-primary" style="font-size:11px; padding:8px 20px;">' },
    { name: 'trucking is not deducted from what the supplier is owed',
      file: 'helpers/bills.js', suites: ['bills-sales'],
      find: '    const netPayable = amountUsed === null ? null\n        : round2(amountUsed - (trucking || 0));',
      to:   '    const netPayable = amountUsed;' },
    { name: 'trucking is deducted twice, once again in the balance',
      file: 'helpers/bills.js', suites: ['bills-sales'],
      find: '    const balance = netPayable === null ? null : round2(netPayable - paid);',
      to:   '    const balance = netPayable === null ? null : round2(netPayable - (trucking || 0) - paid);' },
    { name: 'the bill amount is netted down instead of the payable',
      file: 'helpers/bills.js', suites: ['bills-sales'],
      find: '        amount: amountUsed,\n        net_payable: netPayable,',
      to:   '        amount: netPayable,\n        net_payable: netPayable,' },

    // ── MULTIPLE GRADES IN ONE CONTAINER, 2026-09-10 ─────────────────────
    { name: 'the bill blends one price over the net instead of summing the lines',
      file: 'helpers/bills.js', suites: ['bills-sales'],
      find: '    if (itemsAmount !== null) amount = itemsAmount;',
      to:   '' },
    { name: 'a shared chassis is subtracted once for the whole container',
      file: 'helpers/bills.js', suites: ['bills-sales'],
      find: "        netLb = round3(weighed.reduce((s, i) => s + (i.weight || 0), 0));",
      to:   '        netLb = round3(sumOf(\'gross\') - (weighed[0].tare_total || 0));' },
    { name: 'the container keeps its typed gross while the lines carry tickets',
      file: 'helpers/bills.js', suites: ['bills-sales'],
      find: '    if (fromTickets) {',
      to:   '    if (false) {' },
    { name: 'a typed container weight is overwritten in silence',
      file: 'helpers/bills.js', suites: ['bills-sales'],
      find: "    const weightConflict = (fromTickets && typedGross !== null && typedNet !== null\n        && Math.abs(typedNet - netLb) >= 0.001) ? round3(typedNet - netLb) : null;",
      to:   '    const weightConflict = null;' },
    { name: 'a blank tare on a ticket is treated as zero without saying so',
      file: 'helpers/bills.js', suites: ['bills-sales'],
      find: "            missing_tares: hasTicket ? ITEM_TARES.filter((k) => tare[k] === null) : [],",
      to:   '            missing_tares: [],' },
    { name: 'an item with no description is accepted',
      file: 'helpers/bills.js', suites: ['bills-sales'],
      find: "        if (!description) throw new Error('an item needs a description — what grade is it?');",
      to:   "        if (!description) { continue; }" },
    { name: 'a fixed list is declared on the column and never offered',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: '      ...(Array.isArray(c.choices) ? c.choices : []),',
      to:   '' },
    { name: 'payment and shipment terms collapse back into one word',
      file: 'helpers/sales.js', suites: ['bills-sales'],
      find: "    { key: 'shipment_terms',  label: 'Shipment terms', group: 'shipment', choices: SHIPMENT_TERMS,\n      suggest: true, hint: 'FOB, CFR, CIF … — where your responsibility ends' },",
      to:   '' },
    { name: 'shipment terms are policed like payment terms',
      file: 'helpers/sales.js', suites: ['bills-sales'],
      find: "    if ('shipment_terms' in out && out.shipment_terms) {\n        out.shipment_terms = String(out.shipment_terms).trim().toUpperCase();\n    }",
      to:   "    if ('shipment_terms' in out && out.shipment_terms) {\n        if (!SHIPMENT_TERMS.includes(String(out.shipment_terms).trim().toUpperCase())) throw new Error('bad term');\n        out.shipment_terms = String(out.shipment_terms).trim().toUpperCase();\n    }" },
    { name: 'the customer box forgets the address book',
      file: 'api.js', suites: ['bills-sales'],
      find: "                        const book = require('./helpers/addressBook').loadAddressBook();",
      to:   '                        const book = [];' },
    { name: 'only the first alias of a customer is offered',
      file: 'api.js', suites: ['bills-sales'],
      find: '                        for (const e of (book || [])) for (const a of (e.aliases || [])) {',
      to:   '                        for (const e of (book || [])) for (const a of (e.aliases || []).slice(0, 1)) {' },
    { name: 'the address book buries her own customers',
      file: 'api.js', suites: ['bills-sales'],
      find: "                        f.customer = [...new Set([...(f.customer || []), ...names])];",
      to:   '                        f.customer = [...new Set([...names, ...(f.customer || [])])];' },
    { name: 'a clean working tree reports "no idea" instead of clean',
      file: 'helpers/version.js', suites: ['api-health'],
      find: "        return allowEmpty ? out : (out || null);",
      to:   '        return out || null;' },

    // ── MARGIN PER CONTAINER, 2026-09-10 ─────────────────────────────────
    { name: 'trucking is left out of what a container cost',
      file: 'helpers/margin.js', suites: ['bills-sales'],
      find: "            ? round2((r.bill_amount || 0) + (r.trucking || 0)\n                     + (r.charges_out || 0) + (r.commission || 0))",
      to:   '            ? round2((r.bill_amount || 0) + (r.charges_out || 0) + (r.commission || 0))' },
    { name: 'charges she pays are added to revenue instead of cost',
      file: 'helpers/margin.js', suites: ['bills-sales'],
      find: '        const revenue = sold ? round2((r.invoice_amount || 0) + (r.charges_in || 0)) : null;',
      to:   '        const revenue = sold ? round2((r.invoice_amount || 0) + (r.charges_out || 0)) : null;' },
    { name: 'a container bought and not yet sold reads as a total loss',
      file: 'helpers/margin.js', suites: ['bills-sales'],
      find: "        const margin = state === 'closed' && revenue !== null && cost !== null\n            ? round2(revenue - cost) : null;",
      to:   '        const margin = round2((revenue || 0) - (cost || 0));' },
    { name: 'the join ignores the booking, merging a container with its namesake',
      file: 'helpers/margin.js', suites: ['bills-sales'],
      find: "    `${String(bookingNo || '').trim().toUpperCase()}|${String(containerNo || '').trim().toUpperCase()}`;",
      to:   "    `${String(containerNo || '').trim().toUpperCase()}`;" },
    { name: 'the totals average in containers that have not been sold',
      file: 'helpers/margin.js', suites: ['bills-sales'],
      find: "    const closed = r.filter((x) => x.state === 'closed');",
      to:   '    const closed = r;' },
    { name: 'a bill with no container number is silently unmatchable',
      file: 'helpers/margin.js', suites: ['bills-sales'],
      find: "        bills: bills.list().filter((b) => !String(b.container_no || '').trim())",
      to:   '        bills: [].filter((b) => b)' },
    { name: 'the margin totals are computed over every row, not the filtered ones',
      file: 'api.js', suites: ['bills-sales'],
      find: '                summary: m.summary(rows),',
      to:   '                summary: m.summary(all),' },
    { name: 'Margin loses its tab',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: "          ['freight', 'Freight'], ['commission', 'Commission'],\n          // The join, and the reason the two sides were keyed the same way.\n          ['margin', 'Margin']],",
      to:   "          ['freight', 'Freight'], ['commission', 'Commission']]," },

    { name: 'a view loses its tab and becomes unreachable',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: "          ['freight', 'Freight'], ['commission', 'Commission']],",
      to:   "          ['freight', 'Freight']]," },
    { name: 'Trucking loses its tab inside Bills',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: "  bills: [['bills', 'Bills'], ['trucking', 'Trucking']],",
      to:   "  bills: [['bills', 'Bills']]," },
    { name: 'the nav no longer resets to the first tab of a section',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: "    if (tab === 'sales') { metalsTab.sales = 'outgoing'; return renderLedgerTab('sales'); }",
      to:   "    if (tab === 'sales') { return renderLedgerTab('sales'); }" },
    { name: 'the Freight tab shows the commission too',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: "  const all = (data.payables || []).filter((p) => which === 'commission'\n    ? p.kind === 'commission' : p.kind === 'charge');",
      to:   '  const all = (data.payables || []);' },
    { name: 'the sale form is opened with no seed, so the container is retyped',
      file: 'dashboard/index.html', suites: ['ledger-render'],
      find: "        openLedgerForm('sales', null, r.suggestion);",
      to:   "        openLedgerForm('sales');" },

    { name: 'instruction: "share" reads as a question about the rows on screen',
      file: 'helpers/answerCards.js', suites: ['phrasebook', 'answer-cards'],
      find: 'forward|assign|send|share|pass|hand|shoot|give|message|email|mail|tell|notify|inform|dispatch|book|relay',
      to:   'forward|assign|send|message|email|tell|notify|dispatch|book' },
];

// ── CRASH-SAFE, NOT JUST EXIT-SAFE ───────────────────────────────────────
// The first version restored on exit and on SIGINT/SIGTERM, and it STILL
// left helpers/repair.js mutated on disk — the process was SIGKILLed, and no
// handler catches that. A mutation harness that can leave broken code behind
// is worse than no harness, because the next thing to run reads a file nobody
// believes is modified.
//
// So the original is written to a sidecar BEFORE the file is touched, and the
// next invocation restores from it and says so. Belt, braces, and a note in
// the pocket for whoever finds the body.
const SIDECAR = path.join(ROOT, '.mutate-restore.json');

function recoverFromCrash() {
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(SIDECAR, 'utf8')); } catch (e) { return; }
    if (!saved || !saved.file) return;
    console.warn(`\n!! A previous run left ${saved.file} MUTATED — restoring it.`);
    console.warn(`   (killed during "${saved.mutation}")\n`);
    try { fs.writeFileSync(R(saved.file), saved.original); } catch (e) {
        console.error('   RESTORE FAILED:', e.message);
        console.error('   Run: git checkout -- ' + saved.file);
        process.exit(1);
    }
    try { fs.unlinkSync(SIDECAR); } catch (e) {}
}
// FIRST, BEFORE ANY PATH THAT CAN EXIT — 2026-09-08.
// This call used to sit BELOW the argument handling, and `--list` exits in
// that handling. So the one command you would naturally reach for to see what
// is going on after an interrupted run was the one command that could not
// clean up after it. I hit exactly that today: a run was killed mid-mutation,
// I ran `--list`, it printed a tidy catalogue and left workflow/brain.js
// mutated on disk. Recovery must not be reachable only on the happy path.
recoverFromCrash();

// ── RUNNING ──────────────────────────────────────────────────────────────
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const listOnly = process.argv.includes('--list');
const chosen = MUTATIONS.filter((m) => !only.length || only.some((o) => m.name.includes(o) || m.file.includes(o)));

if (listOnly) {
    chosen.forEach((m, i) => console.log(`${String(i + 1).padStart(2)}. [${m.file}] ${m.name}`));
    console.log(`\n${chosen.length} mutation(s).`);
    process.exit(0);
}

// EVERY original, restored no matter how this process ends. An interrupted
// mutation run that leaves broken code on disk is worse than no run at all —
// and it happened, which is why this is belt AND braces.
const originals = new Map();
function restoreAll() {
    for (const [file, text] of originals) {
        try { fs.writeFileSync(R(file), text); } catch (e) { /* nothing left to do */ }
    }
    originals.clear();
    try { fs.unlinkSync(SIDECAR); } catch (e) {}
}
process.on('exit', restoreAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { restoreAll(); process.exit(130); });
}
process.on('uncaughtException', (e) => { restoreAll(); console.error(e); process.exit(1); });

function runSuite(name) {
    const r = spawnSync(process.execPath, [R(`tests/${name}.js`)], {
        cwd: ROOT, encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024,
        env: Object.assign({}, process.env, { JARVIS_TEST: '1' }),
    });
    const out = (r.stdout || '') + (r.stderr || '');
    const failed = [...out.matchAll(/^\s*FAIL\s+(.*)$/gm)].map((m) => m[1].trim());
    const totals = [...out.matchAll(/(\d+) passed, (\d+) failed/g)].pop();
    return {
        crashed: !totals,
        failed: failed.length ? failed : (totals && Number(totals[2]) ? ['(unnamed)'] : []),
        ok: r.status === 0 && !!totals,
    };
}

const survivors = [];
const notApplied = [];
let killed = 0;

console.log(`\n─ mutation testing: ${chosen.length} mutation(s) ─────────────────────\n`);

// ── THE BASELINE MUST BE GREEN FIRST — 2026-09-08 ────────────────────────
// A mutation is "killed" when a suite that passed before now fails. If the
// suite was ALREADY failing, every mutation looks killed and the report is
// pure fiction.
//
// This is not hypothetical. Today I added an assertion to phrasebook.js that
// was simply wrong — I asserted a phonetic key matched when it does not — and
// three mutations across two unrelated files came back "killed", each one
// credited to that same broken assertion. The report said 3 killed, 0
// survived. The truth was 0 measured. It only surfaced because the
// attribution looked odd: a voiceMemory mutation "killed" by a genericTerm
// assertion is not a thing that can happen.
//
// So: run every suite the catalogue depends on, unmutated, before touching a
// byte. A red baseline stops the run rather than flattering it.
{
    const needed = [...new Set(chosen.flatMap((m) => m.suites || []))];
    const red = [];
    for (const s of needed) {
        const r = runSuite(s);
        if (!r.ok) red.push(`${s} (${r.crashed ? 'crashed' : r.failed.join('; ')})`);
    }
    if (red.length) {
        console.error('  BASELINE IS NOT GREEN — refusing to measure anything.\n');
        red.forEach((r) => console.error('    · ' + r));
        console.error('\n  Every mutation would look killed by these failures.');
        console.error('  Fix the suite first, then re-run.\n');
        process.exit(1);
    }
    console.log(`  baseline green: ${needed.join(', ')}\n`);
}

for (const m of chosen) {
    const file = R(m.file);
    const before = fs.readFileSync(file, 'utf8');
    if (!originals.has(m.file)) originals.set(m.file, before);

    // ── THE CHECK THAT WAS MISSING ──────────────────────────────────────
    // A mutation whose pattern matches nothing changes no bytes, the suite
    // passes, and it gets recorded as killed. That is not a weak test, it is
    // a fabricated result — and six of them once went into a commit message
    // as evidence. Exactly once, or the mutation is not run at all.
    const hits = before.split(m.find).length - 1;
    if (hits !== 1) {
        notApplied.push({ name: m.name, hits });
        console.log(`  ✗ NOT APPLIED  ${m.name}`);
        console.log(`                 pattern found ${hits} times in ${m.file} (need exactly 1)`);
        continue;
    }

    const after = before.replace(m.find, m.to);
    if (after === before) {
        notApplied.push({ name: m.name, hits: 'no change' });
        console.log(`  ✗ NOT APPLIED  ${m.name} — replacement was identical`);
        continue;
    }

    let result = null;
    try {
        // The note in the pocket, written BEFORE the file is touched.
        fs.writeFileSync(SIDECAR, JSON.stringify(
            { file: m.file, mutation: m.name, original: before }));
        fs.writeFileSync(file, after);
        // A syntax error is not a passing mutation; it is a broken one, and
        // it would "die" in every suite for the wrong reason.
        // ── AND AN .html FILE IS CHECKED BY ITS INLINE SCRIPT ────────────
        // `node --check` cannot parse HTML, so every dashboard/index.html
        // mutation was reported NOT APPLIED — which meant the whole website
        // was unmutatable and nobody had noticed, because nobody had tried.
        // Found 2026-09-10 adding the first two.
        //
        // The check is the same one the mobile-layout suite makes: pull the
        // inline <script> out and parse THAT. A mutation that breaks the page
        // still fails it; a mutation that only edits markup now passes, which
        // is the point.
        const chk = /\.html$/i.test(m.file)
            ? checkHtml(file)
            : spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
        if (chk.status !== 0) {
            notApplied.push({ name: m.name, hits: 'syntax error' });
            console.log(`  ✗ NOT APPLIED  ${m.name} — mutation broke the syntax`);
            continue;
        }
        const outcomes = m.suites.map((s) => ({ suite: s, ...runSuite(s) }));
        const caughtBy = outcomes.filter((o) => !o.ok);
        result = { outcomes, caughtBy };
    } finally {
        fs.writeFileSync(file, before);
        try { fs.unlinkSync(SIDECAR); } catch (e) {}
    }

    if (result.caughtBy.length) {
        killed += 1;
        const first = result.caughtBy[0];
        const why = first.crashed ? 'CRASHED' : (first.failed[0] || '(unnamed)');
        console.log(`  · killed       ${m.name}`);
        console.log(`                 by ${first.suite}: ${why}`);
    } else {
        survivors.push(m);
        console.log(`  ✗ SURVIVED     ${m.name}`);
        console.log(`                 ${m.file}: ${JSON.stringify(m.find.trim().slice(0, 70))}`);
        console.log(`                 ran ${m.suites.join(', ')} — none noticed`);
    }
}

console.log('\n' + '─'.repeat(72));
console.log(`${killed} killed · ${survivors.length} SURVIVED · ${notApplied.length} not applied`);
if (notApplied.length) {
    console.log('\nNOT APPLIED — these tested nothing, and a "pass" here means nothing:');
    notApplied.forEach((n) => console.log(`  · ${n.name}  (${n.hits})`));
}
if (survivors.length) {
    console.log('\nSURVIVED — the code can be broken this way and no test notices:');
    survivors.forEach((s) => console.log(`  · [${s.file}] ${s.name}`));
}
// A survivor is a real finding, not a failure of the run. A NOT APPLIED is a
// broken catalogue entry and must be fixed before its result means anything.
process.exit(notApplied.length ? 1 : 0);
