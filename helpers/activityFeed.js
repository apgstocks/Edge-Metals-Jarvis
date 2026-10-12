// ── helpers/activityFeed.js — what Jarvis did, in one list ──────────────────
// Apsara, 2026-10-12: "what actions does that agent perform".
//
// READ-ONLY, and it invents nothing. It folds together records Jarvis ALREADY
// keeps in separate places, newest first:
//   · scheduled jobs  — helpers/heartbeat.js (when each last ran, ok or failed)
//   · people          — helpers/audit.js (deletes, clean-ups, locked edits)
//   · QuickBooks      — helpers/quickbooks/journal.js (what reached her books)
//   · AI use          — helpers/aiUsage.js, one line per job per day
//
// Each source is read inside its own try/catch: one unreadable file leaves a
// gap in the list and a note in `problems`, never an empty page.

const aiUsage = require('./aiUsage');

const iso = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

function feed({ limit = 100, now = Date.now() } = {}) {
    const items = [], problems = [];
    const take = (source, fn) => { try { fn(); } catch (e) { problems.push(`${source}: ${e.message}`); } };

    take('jobs', () => {
        const jobs = require('./heartbeat').load().jobs || {};
        for (const [name, j] of Object.entries(jobs)) {
            const at = iso(j.finished || j.started);
            if (!at) continue;
            items.push({ at, source: 'job', actor: name, ok: j.ok !== false,
                what: j.ok === false ? `failed: ${j.error || 'error'}` : `ran${j.ms != null ? ` in ${Math.round(j.ms / 100) / 10}s` : ''}`,
                detail: j.runs != null ? `${j.runs} run(s), ${j.fails || 0} failed so far` : null });
        }
    });
    take('audit', () => {
        for (const e of require('./audit').listEntries()) {
            const at = iso(e.completed_at || e.at);
            if (!at) continue;
            items.push({ at, source: 'audit', actor: e.actor || 'unknown', ok: e.outcome !== 'failed',
                what: `${e.requested_action || e.action}${e.subject ? ' — ' + e.subject : ''}`, detail: e.outcome ? `outcome: ${e.outcome}` : null });
        }
    });
    take('quickbooks', () => {
        for (const e of require('./quickbooks/journal').list()) {
            const at = iso(e.at);
            if (!at) continue;
            if (e.action === 'write' && e.phase === 'intent') continue;       // the 'done' line says what happened
            items.push({ at, source: 'quickbooks', actor: e.by || 'jarvis', ok: e.phase !== 'failed' && e.phase !== 'refused',
                what: e.action === 'write' ? `${e.method} ${e.path} (${e.phase})` : `${e.action} ${e.kind || ''}`.trim(),
                detail: e.error || null });
        }
    });
    take('ai', () => {
        const s = aiUsage.summarise({ days: 2, now });
        for (const [caller, b] of Object.entries(s.byCaller)) {
            items.push({ at: new Date(now).toISOString(), source: 'ai', actor: caller, ok: b.failed === 0,
                what: `${b.calls} AI call(s) in the last 2 days, ≈ $${b.usd}${s.estimated ? ' (estimated rates)' : ''}`,
                detail: b.failed ? `${b.failed} failed` : null, summary: true });
        }
    });

    items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return { items: items.slice(0, limit), problems };
}

module.exports = { feed };
