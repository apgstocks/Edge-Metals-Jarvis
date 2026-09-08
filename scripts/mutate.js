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
      find: "    const said = await askModel(t, ctx || {});\n    return said || 'none';",
      to: "    return 'none';" },
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
      find: 'function setReferents(cards) {\n    center = null;', to: 'function setReferents(cards) {' },
    { name: 'centering: the centre is used without checking it is on screen',
      file: 'helpers/voiceMemory.js', suites: ['voice-memory'],
      find: '            const still = cb && set.rows.filter((r) => r.booking_number === cb.booking_number)[0];',
      to: '            const still = cb;' },
    { name: 'park: a parked draft leaks into the next email',
      file: 'helpers/proformaDraft.js', suites: ['task-context'],
      find: '        parked = { draft, at: Date.now(), line };\n        draft = null;',
      to: '        parked = { draft, at: Date.now(), line };' },
];

// ── RUNNING ──────────────────────────────────────────────────────────────
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const listOnly = process.argv.includes('--list');
const chosen = MUTATIONS.filter((m) => !only.length || only.some((o) => m.name.includes(o) || m.file.includes(o)));

if (listOnly) {
    chosen.forEach((m, i) => console.log(`${String(i + 1).padStart(2)}. [${m.file}] ${m.name}`));
    console.log(`\n${chosen.length} mutation(s).`);
    process.exit(0);
}

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
recoverFromCrash();

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
