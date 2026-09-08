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
        const chk = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
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
