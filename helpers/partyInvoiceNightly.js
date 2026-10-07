// ── helpers/partyInvoiceNightly.js — the nightly freight / trucker invoice sweep, and the morning note ──
// Apsara, 2026-10-08: "Every night along with the shipment sweep I want to run this trucker invoice
// sweep in mail; if found, upload it to the Jarvis website directly against the party, and notify next
// day what the new additions are in our website register data."
//
// NIGHT  (scheduler 23:30, after the 23:15 sheet sync): runs scripts/freight-2026-email-sweep.js on the
//   RECENT mail only (--newer-than), then imports what it read straight into the invoice register
//   (helpers/partyInvoices.js) — the same normalize()/upsertMany() the importer script uses, so every
//   rule there holds: hand-edited rows are never overwritten, a revised invoice beats its original, a
//   re-import never lowers a line below what is paid, over-$3,000-a-load trucker lines are left out.
//   Idempotent: the window overlaps on purpose and a line seen twice is one line.
// MORNING (scheduler 07:50): one email — what was ADDED to the register since the last email, by party.
//   It always goes: "nothing new" and "the night run failed" are both things she needs to be told, and
//   silence would read as a quiet night.
//
// WHAT THIS DOES NOT DO — said plainly because the sweep script can do more with --write:
//   * it does NOT write to the Google sheet tabs (no --write on the sweep);
//   * it does NOT create bills, companies, payments or anything QuickBooks reads. The register is its own
//     store. Pay / edit / delete stay hers, on the screen.
// Edge Metals only. Edge Yard is untouched.
const fs = require('fs'), path = require('path');
const cfg = require('../config');
const PI = require('./partyInvoices');
const { loadJson, mutateJson } = require('./json');

const ROOT = path.join(__dirname, '..');
// The sweep's own keys. Eagle is "eaglebrit" there. NTG / TQL / Schneider are NOT here: they have no
// register (their remittances are read by helpers/carrierRemittance.js).
const SWEEP_PARTIES = ['zimex', 'jio', 'sher', 'ajtransport', 'panmetal', 'gardunos', 'eaglebrit'];
const MIN_DAYS = 3, MAX_DAYS = 30, KEEP_RUNS = 20, TIMEOUT_MS = 45 * 60 * 1000;
const enabled = () => String(process.env.PARTY_INVOICE_SWEEP || 'on').toLowerCase() !== 'off';

const state = () => { const s = loadJson(cfg.PARTY_INVOICE_NIGHTLY_FILE, {}); return s && typeof s === 'object' && !Array.isArray(s) ? s : {}; };
const save = (fn) => mutateJson(cfg.PARTY_INVOICE_NIGHTLY_FILE, {}, (cur) => fn(cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}), { strict: true });

// How far back to look: since the last night that WORKED, plus a day, never less than 3 days — so a
// night the VM was down, or the sweep failed, is covered by the next one.
function windowDays(now = Date.now()) {
    const ok = (state().runs || []).filter((r) => r.ok).map((r) => Date.parse(r.at)).filter(Number.isFinite).sort((a, b) => b - a)[0];
    if (!ok) return MIN_DAYS;
    return Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.ceil((now - ok) / 86400000) + 1));
}

// Real exec: the sweep as a child process (it exits, logs and holds Gemini/Gmail clients — not something to
// call in-process from the scheduler). Injected in the suite.
function realExec(args, { timeout = TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        require('child_process').execFile(process.execPath, [path.join(ROOT, 'scripts/freight-2026-email-sweep.js'), ...args],
            { cwd: ROOT, env: process.env, timeout, maxBuffer: 64 * 1024 * 1024 },
            (err, stdout, stderr) => (err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr })));
    });
}

// records: the sweep's export. Same folding the importer script does.
function importRecords(records) {
    const rows = new Map(), skipped = {};
    for (const rec of records || []) {
        const n = PI.normalize(rec);
        if (n.skip) { const k = `${rec.party}: ${n.skip}`; skipped[k] = (skipped[k] || 0) + 1; continue; }
        rows.set(PI.lineKey ? PI.lineKey(n.row) : n.row.key, n.row);   // same line seen twice -> last wins
    }
    return { rows: [...rows.values()], skipped };
}

async function runNightly({ exec = realExec, now = Date.now(), days = null } = {}) {
    const started = new Date(now).toISOString();
    const run = { at: started, ok: false, days: days || windowDays(now) };
    if (!enabled()) return { skipped: 'PARTY_INVOICE_SWEEP=off', run: null };
    const out = path.join(cfg.DATA_DIR || path.dirname(cfg.PARTY_INVOICE_NIGHTLY_FILE), 'party_invoice_nightly_export.json');
    try {
        try { fs.unlinkSync(out); } catch (e) { /* none yet */ }          // never import a stale export from a failed run
        await exec(['--newer-than', `${run.days}d`, '--party', SWEEP_PARTIES.join(','), '--export-json', out]);
        if (!fs.existsSync(out)) throw new Error('the sweep finished but wrote no export file');
        const data = JSON.parse(fs.readFileSync(out, 'utf8'));
        const { rows, skipped } = importRecords(data.records);
        const res = rows.length ? await PI.upsertMany(rows) : { added: 0, updated: 0, kept_locked: 0 };
        Object.assign(run, { ok: true, read: (data.records || []).length, lines: rows.length, added: res.added, updated: res.updated, kept_locked: res.kept_locked, skipped });
    } catch (e) {
        run.error = String((e && (e.stderr && String(e.stderr).trim().split('\n').slice(-3).join(' | ') || e.message)) || e).slice(0, 600);
    }
    await save((s) => ({ ...s, runs: [...(s.runs || []), run].slice(-KEEP_RUNS) }));
    return { run };
}

// ── THE MORNING NOTE ──────────────────────────────────────────────────────
const money = (n) => `${n < 0 ? '-' : ''}$${Math.abs(Number(n || 0)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function buildDigest({ since, now = Date.now(), rows = PI.list(), runs = state().runs || [] } = {}) {
    const sinceMs = since ? Date.parse(since) : now - 86400000;
    const fresh = rows.filter((r) => Date.parse(r.createdAt) > sinceMs && Date.parse(r.createdAt) <= now && r.source !== 'copy');
    const mine = runs.filter((r) => Date.parse(r.at) > sinceMs);
    const failed = mine.filter((r) => !r.ok), okRuns = mine.filter((r) => r.ok);
    const when = new Date(now).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' });
    const lines = [];
    if (!mine.length) lines.push('The night sweep DID NOT RUN since the last note (nothing in its log). Nothing was added; check the VM and "pm2 logs jarvis".', '');
    for (const f of failed) lines.push(`The night sweep FAILED at ${f.at}: ${f.error || 'unknown error'}. Nothing was added by that run.`, '');
    if (fresh.length) {
        lines.push(`${fresh.length} new line${fresh.length === 1 ? '' : 's'} in the invoice register:`, '');
        for (const p of Object.keys(PI.PARTIES)) {
            const r = fresh.filter((x) => x.party === p);
            if (!r.length) continue;
            lines.push(`${PI.PARTIES[p]} — ${r.length} line${r.length === 1 ? '' : 's'}, ${money(r.reduce((t, x) => t + x.amount, 0))}`);
            for (const x of r) {
                const ref = [x.container_no, x.booking_no, x.hbl_no].filter(Boolean).join(' / ') || '(no reference)';
                const flag = x.check_status === 'not_in_sheet' ? '   << NOT on the sheet' : (x.kind === 'credit_note' ? '   (credit note)' : '');
                lines.push(`   ${x.invoice_no || '(no no.)'}   ${ref}   ${money(x.amount)}${flag}`);
            }
            lines.push('');
        }
        const off = fresh.filter((x) => x.check_status === 'not_in_sheet').length;
        if (off) lines.push(`${off} of these are not on your Invoice sheet yet.`, '');
    } else if (!failed.length && mine.length) lines.push('Nothing new in the invoice register since the last note.', '');
    const upd = okRuns.reduce((t, r) => t + (r.updated || 0), 0), kept = okRuns.reduce((t, r) => t + (r.kept_locked || 0), 0);
    if (okRuns.length && (upd || kept)) lines.push(`(Already in the register: ${upd} line(s) re-read and refreshed${kept ? `, ${kept} left alone because you edited them or they are already paid` : ''}.)`, '');
    lines.push('Open: Documents → Verify → Invoice register. Edit / pay / delete stay yours; the sweep only adds and refreshes unedited lines.');
    const subject = failed.length || !mine.length ? `Invoice sweep: PROBLEM — ${when}` : (fresh.length ? `Invoice register: ${fresh.length} new — ${when}` : `Invoice register: nothing new — ${when}`);
    return { subject, body: lines.join('\n'), fresh, failed: failed.length, ran: mine.length };
}

// Sends the note, THEN moves the "since" mark — a send that failed is tried again tomorrow with the same window.
async function sendDigest({ send = null, now = Date.now() } = {}) {
    if (!enabled()) return { skipped: 'PARTY_INVOICE_SWEEP=off' };
    const s = state();
    const d = buildDigest({ since: s.digest_through, now });
    const to = process.env.PARTY_INVOICE_DIGEST_TO || process.env.SHEET_SYNC_TO || 'apg0596@gmail.com';
    await (send || ((m) => require('./gmail').sendEmail(m)))({ to, subject: d.subject, body: d.body });
    await save((cur) => ({ ...cur, digest_through: new Date(now).toISOString(), last_digest: { at: new Date(now).toISOString(), new: d.fresh.length, failed: d.failed } }));
    return d;
}

module.exports = { runNightly, sendDigest, buildDigest, windowDays, importRecords, enabled, SWEEP_PARTIES, MIN_DAYS, MAX_DAYS };
