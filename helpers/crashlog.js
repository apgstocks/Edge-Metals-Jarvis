// ── helpers/crashlog.js — leave evidence when Jarvis dies ─────────────────
//
// Apsara, 2026-09-06, on what has to be true before Jarvis can be sold:
// "fix them".
//
// THE INCIDENT THIS EXISTS FOR. On 2026-09-01 the process stopped at 06:22
// and stayed dead for ten and a half hours. She found out because a button in
// the dashboard failed. `data/logs/` was empty. `config.js` has created that
// directory since the beginning and nothing has ever written to it, so there
// was no answer to "what happened" — not a stack trace, not an exit code, not
// even a timestamp. Ten hours of email monitoring, chase-ups and scheduled
// sends did not run, and one critical alert (a customer waiting on a rate)
// sat three minutes short of its email escalation when the process died.
//
// WHAT THIS DOES, and deliberately no more:
//
//   1. Every boot appends a line to data/logs/jarvis.log.
//   2. An uncaughtException or unhandledRejection writes the full stack there
//      AND to its own data/logs/crash-<timestamp>.log, then re-raises.
//   3. A clean shutdown records which signal asked for it.
//
// So the next death answers three questions the last one could not: when, what
// threw, and whether anything asked it to stop.
//
// WHY IT DOES NOT SWALLOW THE ERROR. An `uncaughtException` handler that logs
// and continues leaves the process running with corrupt state — mid-write
// files, a half-open WhatsApp session — which is worse than being dead,
// because /healthz keeps answering 200 while nothing works. This logs, then
// lets the process die so pm2 can restart it clean. Crash-only design: dying
// loudly is a feature.
//
// WHY NOT A LOGGING LIBRARY. winston/pino are the right answer at volume.
// This writes a handful of lines a day and must never itself be the reason a
// boot fails, so it is 60 lines of fs.appendFileSync with every call wrapped.
// If logging throws, the app carries on unlogged rather than crashing over
// its own crash reporter.

const fs = require('fs');
const path = require('path');
const cfg = require('../config');

const LOG_FILE = path.join(cfg.LOGS_DIR, 'jarvis.log');
const MAX_BYTES = 5 * 1024 * 1024;   // rotate at 5MB; keep one previous file

function rotateIfBig() {
    try {
        const st = fs.statSync(LOG_FILE);
        if (st.size < MAX_BYTES) return;
        fs.renameSync(LOG_FILE, LOG_FILE + '.1');   // one generation is plenty
    } catch (e) { /* no file yet, or rename raced — either way, carry on */ }
}

// Never throws. A logger that can crash the process it exists to diagnose is
// worse than no logger.
function log(line) {
    try {
        rotateIfBig();
        fs.appendFileSync(LOG_FILE, `${new Date().toISOString()}  ${line}\n`);
    } catch (e) { /* nothing sensible to do — do not make it worse */ }
}

function writeCrashFile(kind, err) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(cfg.LOGS_DIR, `crash-${stamp}.log`);
    const body = [
        `kind:    ${kind}`,
        `at:      ${new Date().toISOString()}`,
        `pid:     ${process.pid}`,
        `uptime:  ${Math.round(process.uptime())}s`,
        `node:    ${process.version}`,
        `memory:  ${JSON.stringify(process.memoryUsage())}`,
        '',
        (err && err.stack) || String(err),
        '',
    ].join('\n');
    try { fs.writeFileSync(file, body); } catch (e) { /* see log() */ }
    return file;
}

// Call once, as early in boot as possible.
function install() {
    log(`[BOOT] starting  pid=${process.pid} node=${process.version} cwd=${process.cwd()}`);

    process.on('uncaughtException', (err) => {
        const file = writeCrashFile('uncaughtException', err);
        log(`[CRASH] uncaughtException — ${err && err.message} (details: ${file})`);
        console.error('[CRASH] uncaughtException:', err);
        // Deliberately fatal. See the header: staying up with unknown state is
        // the failure mode that looks healthy and isn't.
        process.exit(1);
    });

    // index.js already had an unhandledRejection handler that only
    // console.error'd — which is exactly why 2026-09-01 left no evidence.
    // Console output goes nowhere once the terminal is closed.
    process.on('unhandledRejection', (err) => {
        const file = writeCrashFile('unhandledRejection', err);
        log(`[CRASH] unhandledRejection — ${(err && err.message) || err} (details: ${file})`);
        console.error('[CRASH] unhandledRejection:', err);
        // NOT fatal, unlike uncaughtException. Node's default for an
        // unhandled rejection is already to terminate on modern versions, and
        // this codebase has genuine fire-and-forget promises (the outbox
        // flush, preload lookups) whose rejection should not take the whole
        // process down. Logged loudly instead.
    });

    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.on(sig, () => log(`[SHUTDOWN] ${sig} received`));
    }
    process.on('exit', (code) => log(`[EXIT] code=${code} uptime=${Math.round(process.uptime())}s`));
}

module.exports = { install, log, LOG_FILE, writeCrashFile };
