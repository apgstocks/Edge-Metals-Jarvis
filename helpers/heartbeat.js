// ── helpers/heartbeat.js ───────────────────────────────────────────────────
//
// Apsara, 2026-10-08: "First heartbeat. if something is broke - i should know."
//
// MEASURED FIRST: scheduler.js schedules 31 cron jobs. Exactly ONE of them
// recorded that it had run -- settings.gmail_watcher_last_run -- and that one
// read `null`. So if the mail watcher, the digest, the nightly QuickBooks run
// or the chase-ups silently stop, nothing anywhere says so. The only symptom
// is an ABSENCE, and an absence is the hardest thing there is to notice: it
// is why "is emailWatcher alive on the VM?" could not be answered at all.
//
// ── WHY THIS WRAPS cron.schedule RATHER THAN EDITING 31 CALL SITES ────────
// Her standing instruction is to think about the impact on other folders
// before a fix. Hand-editing 31 lines in a 1,600-line scheduler is 31 chances
// to drop a `.catch`, change an argument order, or lose a timezone -- and a
// scheduler that throws at startup takes EVERY job down, which is a far worse
// failure than the one being fixed. So the shim replaces `cron.schedule`
// once, keeps its exact signature, and the 31 call sites are untouched.
//
// ── IT MUST NEVER BE THE REASON A JOB FAILS ───────────────────────────────
// Every recording path is inside try/catch, and the wrapped function is
// invoked whether or not recording worked. A heartbeat that breaks the thing
// it measures is worse than no heartbeat. The ONLY behaviour added to a job
// is that a rejection is now also recorded before being re-thrown to the
// job's own `.catch`, so existing error handling is unchanged.
const fs = require('fs');
const path = require('path');
const cfg = require('../config');

// The shape on disk:
//   { jobs: { "<name>": { expr, period_ms, started, finished, ok,
//                         last_ok, last_error, error, runs, fails, ms } } }
function load() {
    try {
        const raw = fs.readFileSync(cfg.HEARTBEAT_FILE, 'utf8');
        const o = JSON.parse(raw);
        return o && typeof o === 'object' && o.jobs ? o : { jobs: {} };
    } catch (e) { return { jobs: {} }; }
}

// Written with write-then-rename so a crash mid-write cannot leave a
// truncated file that makes every job look dead. Not mutateJson: this is
// written every minute by taskRunner alone, it is nobody's source of truth,
// and taking the shared lock that often would be a new contention risk in
// the one file whose job is to notice problems rather than cause them.
function save(state) {
    try {
        fs.mkdirSync(path.dirname(cfg.HEARTBEAT_FILE), { recursive: true });
        const tmp = cfg.HEARTBEAT_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
        fs.renameSync(tmp, cfg.HEARTBEAT_FILE);
        return true;
    } catch (e) {
        console.warn('[HEARTBEAT] could not write the pulse (non-fatal):', e.message);
        return false;
    }
}

// ── HOW OFTEN IS THIS JOB SUPPOSED TO RUN? ────────────────────────────────
// Needed so "overdue" means something. Derived from the cron expression
// rather than declared per job, because a declaration next to 31 call sites
// is 31 chances for it to drift from the schedule it describes.
//
// Deliberately COARSE and always an UPPER bound on the gap. "0 9-17 * * *"
// runs hourly through the day but the real gap across the night is 16 hours,
// so the period is the largest ordinary gap, never the smallest. Over-
// estimating makes a late alert; under-estimating makes a false one, and a
// monitor that cries wolf gets ignored, which returns us to no monitor.
const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
function periodFor(expr) {
    const e = String(expr || '').trim();
    const f = e.split(/\s+/);
    if (f.length < 5) return null;
    const [min, hr] = f;
    if (min === '*' && hr === '*') return MIN;
    let m;
    if ((m = /^\*\/(\d+)$/.exec(min)) && hr === '*') return Number(m[1]) * MIN;
    // An hour list or step: the gap that matters is the one across the hours
    // it does NOT run, so measure from the last hour to the first, next day.
    if (/^\d+$/.test(min) && hr !== '*') {
        const hours = expandHours(hr);
        if (!hours.length) return DAY;
        if (hours.length === 1) return DAY;
        let worst = 0;
        for (let i = 0; i < hours.length; i++) {
            const next = i + 1 < hours.length ? hours[i + 1] : hours[0] + 24;
            worst = Math.max(worst, (next - hours[i]) * HOUR);
        }
        return worst;
    }
    if (/^\d+$/.test(min) && hr === '*') return HOUR;
    return DAY;
}
function expandHours(hr) {
    const out = new Set();
    for (const part of String(hr).split(',')) {
        let m;
        if ((m = /^(\d+)-(\d+)$/.exec(part))) { for (let i = +m[1]; i <= +m[2]; i++) out.add(i); }
        else if ((m = /^\*\/(\d+)$/.exec(part))) { for (let i = 0; i < 24; i += +m[1]) out.add(i); }
        else if (/^\d+$/.test(part)) out.add(+part);
        else if (part === '*') { for (let i = 0; i < 24; i++) out.add(i); }
    }
    return [...out].sort((a, b) => a - b);
}

// The job's name. scheduler.js already labels every one-liner for its own
// console output -- `.catch(e => console.error('[SCHED] email:', e))` -- so
// the name is read from the function's source rather than invented, which
// means the heartbeat and the log call the same job the same thing.
function nameFor(fn, expr, used) {
    let base = null;
    try {
        const m = /\[SCHED\]\s*([a-z0-9][a-z0-9 _-]{0,40}?)\s*[:'"]/i.exec(String(fn));
        if (m) base = m[1].trim().replace(/\s+/g, '-').toLowerCase()
            // The label is a LOG prefix, so some carry the outcome word with
            // them: '[SCHED] nightly data backup FAILED:' must not name the
            // job "nightly-data-backup-failed" -- a job called "failed" reads
            // as broken every time it is healthy.
            .replace(/-(failed|failure|error|errors|crashed)$/, '');
        if (!base) {
            const r = /require\(['"]\.\/helpers\/([a-zA-Z0-9_]+)['"]\)/.exec(String(fn));
            if (r) base = r[1].replace(/Job$/, '').toLowerCase();
        }
    } catch (e) { /* a name is a nicety; never fail for one */ }
    if (!base) base = 'job';
    let name = base, n = 2;
    while (used.has(name)) name = `${base}-${n++}`;
    used.add(name);
    return name;
}

function record(name, patch) {
    try {
        const state = load();
        state.jobs[name] = { ...(state.jobs[name] || {}), ...patch };
        save(state);
    } catch (e) { /* see the header: never the reason a job fails */ }
}

// Wraps a node-cron-shaped module. Returns an object with the same
// `schedule(expr, fn, opts)` signature plus whatever else the module had,
// so scheduler.js needs one line changed and nothing else.
function instrument(cronModule, { onBeat = null } = {}) {
    const used = new Set();
    const wrapped = Object.create(cronModule);
    wrapped.schedule = function schedule(expr, fn, opts) {
        const name = nameFor(fn, expr, used);
        const period_ms = periodFor(expr);
        record(name, { expr, period_ms, registered: new Date().toISOString() });
        const beating = async (...args) => {
            const t0 = Date.now();
            record(name, { started: new Date(t0).toISOString() });
            try {
                const out = await fn(...args);
                const t1 = Date.now();
                const prev = load().jobs[name] || {};
                record(name, {
                    finished: new Date(t1).toISOString(), ok: true,
                    last_ok: new Date(t1).toISOString(), ms: t1 - t0,
                    runs: (prev.runs || 0) + 1, error: null,
                });
                if (onBeat) { try { onBeat(name, true); } catch (e) {} }
                return out;
            } catch (err) {
                const prev = load().jobs[name] || {};
                record(name, {
                    finished: new Date().toISOString(), ok: false,
                    last_error: new Date().toISOString(),
                    error: String((err && err.message) || err).slice(0, 300),
                    runs: (prev.runs || 0) + 1, fails: (prev.fails || 0) + 1,
                });
                if (onBeat) { try { onBeat(name, false); } catch (e) {} }
                // Re-thrown so each job's own .catch still handles it exactly
                // as before. The heartbeat observes; it does not intervene.
                throw err;
            }
        };
        return cronModule.schedule(expr, beating, opts);
    };
    return wrapped;
}

// ── WHAT IS BROKEN RIGHT NOW ──────────────────────────────────────────────
// `late` is a job whose last success is older than the gap its own schedule
// allows, times a tolerance. `failing` is one whose most recent run threw.
// `silent` is one that registered and has never run at all -- the
// gmail_watcher_last_run = null case, which is the one that started this.
const GRACE = 2.5;        // a job may miss two ticks before it is "late"
function status(now = Date.now(), state = null) {
    const s = state || load();
    const jobs = Object.entries(s.jobs || {});
    const late = [], failing = [], silent = [], ok = [];
    for (const [name, j] of jobs) {
        if (j.ok === false) { failing.push({ name, ...j }); continue; }
        if (!j.last_ok) { silent.push({ name, ...j }); continue; }
        const gap = now - Date.parse(j.last_ok);
        const allow = (j.period_ms || DAY) * GRACE;
        if (Number.isFinite(gap) && gap > allow) late.push({ name, gap_ms: gap, allow_ms: allow, ...j });
        else ok.push({ name, ...j });
    }
    return { total: jobs.length, ok, late, failing, silent, healthy: !late.length && !failing.length && !silent.length };
}

// One line for the morning digest when all is well; a named list when it is
// not. She reads these on a phone, so the healthy case is ONE line -- a
// monitor that writes a paragraph every morning stops being read.
function report(now = Date.now(), state = null) {
    const s = status(now, state);
    if (!s.total) return 'No scheduled jobs have reported in yet.';
    if (s.healthy) return `All ${s.total} scheduled jobs ran on time.`;
    const human = (ms) => ms >= DAY ? `${Math.floor(ms / DAY)}d` : ms >= HOUR ? `${Math.floor(ms / HOUR)}h` : `${Math.max(1, Math.round(ms / MIN))}m`;
    const lines = [`${s.ok.length} of ${s.total} scheduled jobs are healthy.`];
    for (const j of s.failing) lines.push(`  ✗ ${j.name} FAILED — ${j.error || 'no message'}`);
    for (const j of s.late) lines.push(`  ! ${j.name} last ran ${human(j.gap_ms)} ago (expected every ${human(j.period_ms || DAY)})`);
    for (const j of s.silent) lines.push(`  ? ${j.name} has never run since it was registered`);
    return lines.join('\n');
}

module.exports = { instrument, status, report, periodFor, expandHours, nameFor, load, save, GRACE, _MIN: MIN, _HOUR: HOUR, _DAY: DAY };
