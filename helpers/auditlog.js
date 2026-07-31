// ── helpers/auditlog.js — Append-only decision log ───────────────────────────
// transcripts.json (helpers/json.js) is a ROLLING window — capped at the last
// 30 entries per chat, purpose-built to feed the AI's "last 5 messages"
// context. Old entries silently fall off. It was never meant to be an audit
// trail, so it can't be treated as one.
//
// This file is the audit trail: one line per decision, per LA calendar day,
// never truncated, never overwritten. Any future agent (booking,
// supplier/trucker, invoice, mail) should call appendAuditLog with its own
// `source` value so every decision — regardless of which module made it —
// lands in the same place and can be filtered/grepped by domain.
//
// Fire-and-forget posture matches helpers/memory.js: a logging failure must
// never block or crash message handling.

const fs   = require('fs');
const path = require('path');
const cfg  = require('../config');
const { getLADate } = require('./time');

const LOGS_DIR = cfg.LOGS_DIR || path.join(cfg.DATA_DIR, 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// One file per LA calendar day — matches the timezone every other
// deadline/scheduling decision in this app is evaluated in (helpers/time.js).
function todayLogFile() {
    const d    = getLADate();
    const yyyy = d.getFullYear();
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const dd   = String(d.getDate()).padStart(2, '0');
    return path.join(LOGS_DIR, `${yyyy}-${mm}-${dd}.jsonl`);
}

// entry should include at minimum: source, intent, resolvedBy, confidence,
// actionTaken. `at` is stamped here so callers don't need to.
async function appendAuditLog(entry) {
    try {
        const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
        await fs.promises.appendFile(todayLogFile(), line, 'utf8');
    } catch (err) {
        console.error('[AUDITLOG] append failed:', err.message);
    }
}

module.exports = { appendAuditLog, todayLogFile };
