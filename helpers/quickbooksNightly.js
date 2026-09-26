// ── helpers/quickbooksNightly.js — the QuickBooks run, every night ─────────
//
// Apsara, 2026-09-25, on a competitor: "Their QuickBooks integration will be
// cleaner — fix this."
//
// The honest gap was not the checks — those are better here — it was that
// nothing ran on its own. Every push was a terminal command she had to
// remember, and a blocked row sat blocked until somebody happened to look.
//
// So: one run a night, after the sheet sync has filled the ledgers (11:15pm),
// and one email that says what went in, what is stuck, and what needs her.
//
// ── IT WRITES ONLY WHAT THE SWEEP ALREADY ALLOWS ───────────────────────────
// No new powers. The same cutover, the same exact-name matching, the same
// duplicate-money check, the same journal and undo. If QB_PROD_WRITES is off
// or QB_SYNC is off, this is a dry run and says so — the switches keep
// meaning what they meant.
const sync = require('./quickbooks/sync');
const journal = require('./quickbooks/journal');
const auth = require('./quickbooks/auth');
const push = require('./quickbooks/push');

const on = (v) => String(v || '').toLowerCase() === 'on';

function enabled() {
    return on(process.env.QB_PROD_WRITES) && on(process.env.QB_SYNC);
}

// What the night did, in the order she cares about: money that moved, then
// money that could not, then what is waiting on her.
const KINDS = ['bill', 'sale', 'billpayment', 'receipt', 'prepayment'];
function summarise(res) {
    const n = (k, s) => (res[k] && res[k][s]) || 0;
    const made = KINDS.reduce((t, k) => t + n(k, 'created'), 0);
    const blocked = KINDS.reduce((t, k) => t + n(k, 'blocked'), 0);
    const asked = KINDS.reduce((t, k) => t + n(k, 'ask'), 0);
    const errored = KINDS.reduce((t, k) => t + Object.entries(res[k] || {})
        .filter(([s]) => s.startsWith('error')).reduce((a, [, c]) => a + c, 0), 0);
    // Rows the cutover walked past. Counted, because a silent skip is how a
    // whole night's sheet sync went missing without a single line of output.
    const la = res.leftAlone || {};
    const left = (la.bill || 0) + (la.sale || 0) + (la.billpayment || 0) + (la.receipt || 0);
    return { made, blocked, asked, errored, left };
}

async function run(opts = {}) {
    const dryRun = opts.dryRun !== undefined ? opts.dryRun : !enabled();
    const env = auth.qbEnv();
    const out = { ok: false, dryRun, env, result: null, error: null, blocked: [], asked: [] };
    try {
        out.result = await sync.sweep({ env, dryRun });
        // Why each one is stuck — from the journal, which already holds the
        // reason. A count alone ("blocked: 6") is a number she cannot act on.
        if (!dryRun) {
            const since = Date.now() - 6 * 3600 * 1000;
            for (const e of journal.list({ env })) {
                if (new Date(e.at).getTime() < since) continue;
                const who = (e.jarvis && (e.jarvis.supplier || e.jarvis.customer)) || '';
                const what = (e.jarvis && (e.jarvis.container || e.jarvis.id)) || '';
                if (e.action === 'blocked') out.blocked.push({ kind: e.kind, who, what, why: e.reason || '' });
                if (e.action === 'asked') out.asked.push({ kind: e.kind, who, what, why: e.reason || '' });
            }
        }
        out.ok = true;
    } catch (e) {
        out.error = e.message;
    }
    return out;
}

function reportText(out) {
    if (out.error) return `The nightly QuickBooks run could not finish.\n\n${out.error}\n\nNothing further was written.`;
    const s = summarise(out.result || {});
    const lines = [];
    lines.push(out.dryRun
        ? 'DRY RUN — nothing was written. Writing needs QB_PROD_WRITES=on and QB_SYNC=on.'
        : `Entered in QuickBooks (${out.env}): ${s.made}`);
    lines.push('');
    for (const kind of KINDS) {
        const parts = Object.entries((out.result || {})[kind] || {}).map(([k, v]) => `${k} ${v}`).join(', ');
        if (parts) lines.push(`${kind}: ${parts}`);
    }
    if (out.blocked.length) {
        lines.push('', `STUCK — ${out.blocked.length} record(s) Jarvis would not enter:`);
        for (const b of out.blocked.slice(0, 25)) lines.push(`  ${b.kind} ${b.who} ${b.what} — ${b.why}`);
        if (out.blocked.length > 25) lines.push(`  …and ${out.blocked.length - 25} more`);
    }
    if (out.asked.length) {
        lines.push('', `NEEDS YOU — ${out.asked.length} record(s) where the same money looks like it is already there:`);
        for (const a of out.asked.slice(0, 15)) lines.push(`  ${a.kind} ${a.who} ${a.what} — ${a.why}`);
    }
    // What the cutover left behind, by name of the reason and with the dates.
    // Without this a run that skipped everything read exactly like a quiet
    // night, which is how days of sheet-sync rows went unnoticed.
    const la = (out.result || {}).leftAlone;
    if (la && s.left) {
        const byKind = ['bill', 'sale', 'billpayment', 'receipt']
            .filter((k) => la[k]).map((k) => `${la[k]} ${k}${la[k] === 1 ? '' : 's'}`).join(', ');
        lines.push('', `OLDER THAN THE CUTOVER — ${s.left} record(s) were not touched: ${byKind}.`);
        if (la.from) lines.push(`  dated ${la.from}${la.to && la.to !== la.from ? ` to ${la.to}` : ''}`);
        for (const [why, n] of Object.entries(la.why || {})) lines.push(`  ${n} — ${why}`);
    }
    const cut = { bills: push.cutoverFor('bill', out.env), invoices: push.cutoverFor('invoice', out.env) };
    const src = (k) => { const w = push.cutoverSource(k); return w === 'env' ? ' (pinned in .env)' : w === 'setting' ? '' : ' (NOT SET — nothing will be entered)'; };
    lines.push('', `Cutover — bills from ${cut.bills || '(not set)'}${src('bill')}, invoices from ${cut.invoices || '(not set)'}${src('invoice')}.`,
        'Anything older is deliberately left alone: her books already hold that period, or the cost went',
        'straight to Cost of Goods Sold with no bill. Move the boundary on the QuickBooks page, or push a',
        'reviewed list explicitly with scripts/qb-push-list.js.',
        '', 'Open the QuickBooks page in Jarvis to fix a stuck row or undo anything here.');
    return lines.join('\n');
}

async function emailReport(out, opts = {}) {
    const to = opts.to || process.env.QB_REPORT_TO || process.env.SHEET_SYNC_TO || 'apg0596@gmail.com';
    const when = new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' });
    const s = summarise(out.result || {});
    const subject = out.error
        ? `QuickBooks FAILED — ${when}`
        : `QuickBooks ${out.dryRun ? '(dry run)' : `— ${s.made} entered`}${s.blocked ? `, ${s.blocked} stuck` : ''}${s.asked ? `, ${s.asked} need you` : ''}${s.left ? `, ${s.left} older than cutover` : ''} — ${when}`;
    return require('./gmail').sendEmail({ to, subject, body: reportText(out) });
}

module.exports = { run, reportText, emailReport, summarise, enabled };
