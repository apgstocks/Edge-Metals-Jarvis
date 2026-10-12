// ── helpers/healthReport.js — a front door for evidence we already keep ───
//
// Apsara, 2026-10-12: "Why there is no provision for USers,incidents,crash
// report?"
//
// For crash reports the answer was not that they do not exist. They do, and
// they are good: helpers/crashlog.js records every boot, every
// uncaughtException with its full stack, and a separate crash-<ts>.log per
// death — written after 2026-09-01, when the process was dead for ten and a
// half hours and data/logs/ was empty. helpers/clientErrors.js has collected
// probe failures from the phones since 2026-10-02.
//
// Nothing READS either of them. There is a POST /api/client-errors so a phone
// can report and no GET to read it back; nothing serves LOGS_DIR at all. So
// the only way to see a crash has been to ssh to the VM and cat a file, which
// is what she has been doing all week — every log line she has pasted came
// out of a terminal. The capture was finished and the front door was never
// built.
//
// ── IT READS. IT DOES NOT WRITE, DECIDE, OR DELETE ──────────────────────
// Deliberately: this is the module you reach for when things are already
// broken, so it must not be able to make anything worse. No mutateJson, no
// unlink, no rotation (crashlog.js owns that), nothing that can fail in a way
// that matters. Every reader below is individually wrapped, because a health
// page that goes blank when ONE of its sources is unreadable is useless at
// exactly the moment it is needed — a missing section reports itself as
// missing and the rest still renders.
//
// ── AND IT IS NOT A FILE SERVER ─────────────────────────────────────────
// It would be one line to accept a filename and send it. That one line is a
// path-traversal hole into a directory that sits next to her stores, her
// bank data and her Google credentials. So: crash files are found by GLOB
// here, never named by a caller; the name is matched against a strict
// pattern; the resolved path is checked to be inside LOGS_DIR; and only a
// bounded TAIL of each file is read, because jarvis.log rotates at 5MB and
// slurping that into a JSON response is its own outage.

const fs = require('fs');
const path = require('path');
const cfg = require('../config');

const LOGS_DIR = cfg.LOGS_DIR || path.join(cfg.DATA_DIR, 'logs');

// A crash file is exactly this shape, because crashlog.js writes exactly this
// shape. Anything else in that directory is not ours to read.
const CRASH_NAME = /^crash-[0-9TZ:.\-]+\.log$/;

// Read at most this much of the END of a file. A stack trace is a few KB; the
// limit exists for jarvis.log, which is a rotating 5MB.
const TAIL_BYTES = 64 * 1024;

// ── tailOf — the last N bytes, without reading the first N million ──────
// fs.readFileSync on a 5MB log, JSON-encoded into a response, for a page
// that only ever shows the recent end of it, is how a diagnostic becomes the
// thing being diagnosed.
function tailOf(file, bytes = TAIL_BYTES) {
    let fd = null;
    try {
        const size = fs.statSync(file).size;
        const start = Math.max(0, size - bytes);
        const length = size - start;
        if (length <= 0) return { text: '', truncated: false, size };
        const buf = Buffer.alloc(length);
        fd = fs.openSync(file, 'r');
        fs.readSync(fd, buf, 0, length, start);
        let text = buf.toString('utf8');
        // A byte-offset read can land mid-line. Drop the first partial one
        // rather than showing half a timestamp.
        if (start > 0) {
            const nl = text.indexOf('\n');
            if (nl >= 0) text = text.slice(nl + 1);
        }
        return { text, truncated: start > 0, size };
    } catch (e) {
        return { text: '', truncated: false, size: 0, error: String((e && e.message) || e) };
    } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch (e) {} }
    }
}

// ── safeInLogs — the check that keeps this from being a file server ─────
// Called on every path before it is opened, even though every path here is
// built from a readdir of LOGS_DIR itself. That is the point: the guard is
// cheap now and is what stops the day someone threads a caller-supplied name
// through to one of these readers.
function safeInLogs(file) {
    const resolved = path.resolve(file);
    const base = path.resolve(LOGS_DIR);
    return resolved === base || resolved.startsWith(base + path.sep);
}

// ── crashes() — every death, newest first ───────────────────────────────
// The STACK is the whole value of this. A list of timestamps answers "did it
// crash", which she already knew; the stack answers "what threw", which is
// the question that took ten and a half hours on 2026-09-01.
function crashes(limit = 20) {
    let names = [];
    try {
        names = fs.readdirSync(LOGS_DIR).filter((n) => CRASH_NAME.test(n));
    } catch (e) {
        return { ok: false, error: `could not read ${LOGS_DIR}: ${(e && e.message) || e}`, items: [] };
    }
    // Newest first by NAME, which is safe because crashlog.js names them with
    // an ISO timestamp — lexical order is chronological order. Not by mtime:
    // a file copied or restored carries a new mtime and would jump the queue.
    names.sort().reverse();
    const items = [];
    for (const name of names.slice(0, limit)) {
        const file = path.join(LOGS_DIR, name);
        if (!safeInLogs(file)) continue;
        const t = tailOf(file, 16 * 1024);
        // The timestamp comes out of the NAME, not from stat: the name is what
        // crashlog.js chose at the moment of death.
        const stamp = name.replace(/^crash-/, '').replace(/\.log$/, '');
        items.push({
            file: name,
            at: stamp,
            bytes: t.size,
            truncated: !!t.truncated,
            // First line of a stack is the error itself — worth lifting out so
            // a list of twenty crashes is readable without opening each.
            headline: (t.text.split('\n').find((l) => l.trim()) || '').slice(0, 300),
            stack: t.text,
            error: t.error || null,
        });
    }
    return { ok: true, total: names.length, shown: items.length, items };
}

// ── boots() — restarts, which is the signal a crash loop makes ──────────
// A process that dies and is restarted by pm2 every 40 seconds looks healthy
// from outside: /healthz answers, the site loads. The only visible trace is
// the boot line crashlog.js appends, so counting them over a window is how a
// restart loop becomes a fact instead of a feeling.
function boots(windowHours = 48) {
    const file = cfg.LOGS_DIR ? path.join(LOGS_DIR, 'jarvis.log') : null;
    if (!file || !safeInLogs(file) || !fs.existsSync(file)) {
        return { ok: false, error: 'data/logs/jarvis.log does not exist yet', items: [] };
    }
    const t = tailOf(file);
    if (t.error) return { ok: false, error: t.error, items: [] };

    const since = Date.now() - windowHours * 3600 * 1000;
    const items = [];
    for (const line of t.text.split('\n')) {
        if (!line.trim()) continue;
        // crashlog.js writes an ISO timestamp first on every line. A line we
        // cannot date is KEPT and reported undated rather than dropped — a
        // format change must show up as odd entries, not as silence.
        const m = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/);
        const at = m ? m[1] : null;
        const kind = /\bBOOT\b|\bstart(ed|ing)?\b/i.test(line) ? 'boot'
            : /uncaughtException|unhandledRejection|CRASH/i.test(line) ? 'crash'
                : /SIGTERM|SIGINT|shutdown/i.test(line) ? 'shutdown'
                    : 'other';
        if (at && Date.parse(at) < since) continue;
        items.push({ at, kind, line: line.slice(0, 400) });
    }
    const count = (k) => items.filter((x) => x.kind === k).length;
    return {
        ok: true,
        window_hours: windowHours,
        log_bytes: t.size,
        truncated: !!t.truncated,
        boots: count('boot'),
        crashes: count('crash'),
        shutdowns: count('shutdown'),
        // The thing worth noticing without being asked: restarts with nobody
        // asking for them. A clean deploy is a shutdown THEN a boot; a crash
        // loop is boots with no shutdowns in front of them.
        unexplained_restarts: Math.max(0, count('boot') - count('shutdown') - 1),
        items: items.slice(-200),
    };
}

// ── thisProcess() — is the thing answering me the thing that crashed? ───
// After a restart the stacks on disk belong to a process that no longer
// exists. Uptime is what tells you whether you are looking at history or at
// something still happening.
function thisProcess() {
    const mem = process.memoryUsage();
    return {
        pid: process.pid,
        uptime_s: Math.round(process.uptime()),
        node: process.version,
        rss_mb: Math.round(mem.rss / 1048576),
        heap_mb: Math.round(mem.heapUsed / 1048576),
        // pm2's ceiling is 1500M (ecosystem.config.js). Showing the headroom
        // matters because crossing it restarts the app and drops the in-memory
        // PDF queue — the failure the render process was split out to contain.
        restart_ceiling_mb: 1500,
    };
}

// ── report() — one object, every section independently fallible ─────────
function report(opts = {}) {
    const out = { ok: true, at: new Date().toISOString(), logs_dir: LOGS_DIR };
    const part = (name, fn) => {
        try { out[name] = fn(); }
        catch (e) { out[name] = { ok: false, error: String((e && e.message) || e) }; }
    };

    part('process', thisProcess);
    part('boots', () => boots(Number(opts.windowHours) || 48));
    part('crashes', () => crashes(Number(opts.crashLimit) || 20));

    // What the PHONES could not do. Already summarised by the module that
    // collects it — reused rather than re-derived, so the page and the nightly
    // digest cannot disagree about the same numbers.
    part('devices', () => {
        const ce = require('./clientErrors');
        // list() takes { since }, NOT { limit } — it returns the whole capped
        // store. The newest 50 are sliced here rather than asking for them,
        // because asking with the wrong option name would have silently
        // returned every row and looked like it worked.
        const all = ce.list();
        return { ok: true, summary: ce.summary(), recent: all.slice(-50).reverse() };
    });

    // Scheduled jobs, from the module that already instruments them.
    part('jobs', () => {
        const hb = require('./heartbeat');
        return { ok: true, status: hb.status() };
    });

    // Documents: the queue and the second process, both of which have a
    // snapshot already and neither of which is visible anywhere.
    part('documents', () => {
        const q = require('./pdfQueue').snapshot();
        let renderer = null;
        try { renderer = require('./renderClient').snapshot(); } catch (e) { renderer = null; }
        return { ok: true, queue: q, renderer };
    });

    return out;
}

module.exports = { report, crashes, boots, thisProcess, tailOf, safeInLogs, LOGS_DIR, CRASH_NAME, TAIL_BYTES };
