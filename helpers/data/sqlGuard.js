// ── helpers/data/sqlGuard.js — what is allowed to run ───────────────────────
//
// Everything the planner produces passes through here before it reaches
// SQLite. The rule is narrow on purpose: ONE statement, and it must be a
// SELECT (a leading WITH is a SELECT with its parts named first).
//
// The mirror is disposable and the connection is read-only, so this is the
// third lock rather than the only one. It exists because the other two protect
// her DATA and this one protects her TIME: a cartesian join over four ledgers,
// or a recursive CTE with no base case, is a question that never comes back,
// and on voice that is indistinguishable from Jarvis being broken.
const BANNED = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|vacuum|pragma|reindex|trigger|begin|commit|rollback)\b/i;

function check(sqlIn) {
    const sql = String(sqlIn || '').trim().replace(/;+\s*$/, '');
    if (!sql) return { ok: false, why: 'no SQL' };
    // A second statement is refused rather than trimmed: "SELECT 1; DROP ..."
    // trimmed to its first half looks like it worked, and silently accepting
    // half of what the model wrote is how a bad habit goes unnoticed.
    if (/;/.test(sql.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, ''))) return { ok: false, why: 'more than one statement' };
    if (!/^\s*(select|with)\b/i.test(sql)) return { ok: false, why: 'only SELECT is allowed' };
    // Keywords inside quoted strings are data ('Deleted' as a status), not
    // commands, so they are stripped before the check.
    const bare = sql.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
    const hit = BANNED.exec(bare);
    if (hit) return { ok: false, why: `${hit[1].toUpperCase()} is not allowed` };
    if (sql.length > 4000) return { ok: false, why: 'that query is too long' };
    return { ok: true, sql };
}

// Every answer is capped. A question that genuinely wants 5,000 rows is a
// report, not a sentence, and the screen says when it was cut.
function withLimit(sql, limit = 200) {
    const s = String(sql).trim().replace(/;+\s*$/, '');
    return /\blimit\s+\d+\s*$/i.test(s) ? s : `${s} LIMIT ${limit}`;
}

module.exports = { check, withLimit, BANNED };
