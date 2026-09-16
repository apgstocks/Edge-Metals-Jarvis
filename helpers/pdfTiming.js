// ── helpers/pdfTiming.js — where the seconds actually go ───────────────────
//
// Apsara, 2026-09-16: "why invoice and bol takes more time to generate?"
//
// I could answer that from reading the code — one Chromium launched per
// document, a 500ms network-idle wait with nothing to wait for, up to thirteen
// sequential round trips to fit the page — but reading is not measuring, and
// the sandbox this project is developed in cannot launch Chromium at all. So
// nothing gets optimised until the real server says which of those is actually
// costing her the wait.
//
// ── THIS MUST NOT BE ABLE TO BREAK A DOCUMENT ───────────────────────────────
// It is a stopwatch attached to the path that produces her commercial
// invoices. Every call here is wrapped: a timer that throws, a clock that goes
// backwards, a label that is an object rather than a string — none of it may
// reach the caller. A missing measurement is nothing; a BOL that fails to
// generate because the stopwatch fell over is a driver at a gate.
//
// ── IT KEEPS ONLY THE LAST FIFTY ────────────────────────────────────────────
// In memory, not on disk. This is diagnostic, it answers "what is slow today",
// and a log file that grows forever to answer a question asked once is its own
// small problem. pm2 restart clears it, which is fine — the console line is the
// durable record.

const MAX_KEPT = 50;
const ring = [];

// Cheap and monotonic. Date.now() can step backwards over an NTP correction
// and print a negative phase, which reads as a bug in the thing being measured
// rather than in the clock.
function now() {
    const hr = process.hrtime();
    return hr[0] * 1000 + hr[1] / 1e6;
}

function start(label) {
    let t0, last;
    try { t0 = now(); last = t0; } catch (e) { t0 = 0; last = 0; }
    const phases = [];
    // ── EVEN THE LABEL ───────────────────────────────────────────────────
    // This conversion sat outside the guards, and String() is not total: a
    // Symbol throws, and so does any object with no prototype (and therefore
    // no toString). Found by a test that passed Object.create(null) — the
    // earlier version passed {} and null, which String() copes with happily,
    // so removing every guard in this file changed nothing and the check
    // proved nothing.
    //
    // Unlikely input, certainly. But the whole point of this file is that
    // nothing in it can take down the path that prints her invoices, and
    // "unlikely" is not the same promise as "cannot".
    let safeLabel = 'document';
    try { safeLabel = String(label == null ? 'document' : label).slice(0, 80); } catch (e) {}

    return {
        // Called at the end of each phase, named for what just finished.
        mark(name) {
            try {
                const t = now();
                let safeName = 'phase';
                try { safeName = String(name).slice(0, 30); } catch (e) {}
                phases.push([safeName, Math.round(t - last)]);
                last = t;
            } catch (e) { /* see the header: never the caller's problem */ }
        },
        // Called once, at the end. Returns the entry so a caller can attach it
        // to a response if it ever wants to.
        done(extra) {
            try {
                const total = Math.round(now() - t0);
                const entry = {
                    label: safeLabel,
                    at: new Date().toISOString(),
                    total_ms: total,
                    phases: phases.map(([n, ms]) => ({ phase: n, ms })),
                    ...(extra && typeof extra === 'object' ? extra : {}),
                };
                ring.push(entry);
                while (ring.length > MAX_KEPT) ring.shift();
                // ONE LINE PER DOCUMENT, greppable in pm2 logs. The phase names
                // are the question she asked, in order.
                console.log(`[PDF-TIME] ${safeLabel} total ${total}ms — `
                    + phases.map(([n, ms]) => `${n} ${ms}ms`).join(', ')
                    + (entry.html_kb ? ` — html ${entry.html_kb}KB` : ''));
                return entry;
            } catch (e) {
                return null;
            }
        },
    };
}

// What the admin route reads. Newest last, so it reads like a log.
function recent(n) {
    const count = Number(n);
    return ring.slice(isFinite(count) && count > 0 ? -count : -MAX_KEPT);
}

// Rolled up by document kind, because the useful question is not "how long did
// that one take" but "where does the time go every time".
function summary() {
    const byKind = new Map();
    for (const e of ring) {
        const kind = String(e.label || '').split(/\s+/)[0] || 'document';
        if (!byKind.has(kind)) byKind.set(kind, { kind, runs: 0, total_ms: 0, phases: new Map() });
        const g = byKind.get(kind);
        g.runs += 1;
        g.total_ms += Number(e.total_ms) || 0;
        for (const p of (e.phases || [])) {
            g.phases.set(p.phase, (g.phases.get(p.phase) || 0) + (Number(p.ms) || 0));
        }
    }
    return [...byKind.values()].map((g) => ({
        kind: g.kind,
        runs: g.runs,
        avg_total_ms: Math.round(g.total_ms / g.runs),
        // Average per run, biggest first: the answer to "what do I fix".
        avg_phases: [...g.phases.entries()]
            .map(([phase, ms]) => ({ phase, avg_ms: Math.round(ms / g.runs) }))
            .sort((a, b) => b.avg_ms - a.avg_ms),
    }));
}

function reset() { ring.length = 0; }

module.exports = { start, recent, summary, reset, MAX_KEPT };
