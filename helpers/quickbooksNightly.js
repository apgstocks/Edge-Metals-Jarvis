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
const money = (n) => `$${(Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

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
                // `fix` says WHICH SCREEN answers the reason — see
                // helpers/quickbooks/stuckFix.js. Attached here as well as on
                // the route so the mail and the page describe a row the same
                // way; it is derived, never stored.
                const { stuckFix } = require('./quickbooks/stuckFix');
                const row = { kind: e.kind, who, what, why: e.reason || '' };
                if (e.action === 'blocked') out.blocked.push({ ...row, fix: stuckFix(row) });
                if (e.action === 'asked') out.asked.push({ ...row, fix: stuckFix(row) });
            }
        }
        // ── AND REFRESH WHAT THE QUESTION CHANNEL READS (2026-10-05) ──
        // She asks "how much do we owe Inesh" on WhatsApp. That answer comes
        // from a snapshot of her books on disk, never from a live call — a
        // phone cannot wait for 610 bills. So the snapshot is rewritten here,
        // after the sweep, while the token is already warm. It is best-effort:
        // a failed snapshot must not fail the night's entry work, and a stale
        // one still answers honestly because every answer carries its age.
        try { out.snapshot = await require('./quickbooks/snapshot').write({ env }); }
        catch (e) { out.snapshotError = e.message; }
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
        // ── ONE LINE PER REASON, NOT PER DATE (2026-10-04) ───────────────
        // This printed one line for every distinct `why` string, and
        // push.js builds that string as
        //   `${kind} dated ${d} is before the locked period (${c}) — …`
        // with the DATE inside it. So every date became its own key and the
        // 4 October email carried about 350 lines, each saying "she closed
        // that period deliberately", for a fact that needs saying once.
        //
        // It is not a cosmetic complaint: the 24 STUCK rows — the only part
        // of that email anyone can act on — were below all of it. A report
        // nobody scrolls to the end of has lost the argument.
        //
        // Grouped by the reason with the date lifted out, counts summed, and
        // the span shown. Display only; la.why is untouched for anything
        // else reading it.
        const grouped = new Map();
        for (const [why, n] of Object.entries(la.why || {})) {
            const m = /^(\w+) dated (\d{4}-\d{2}-\d{2}) (.*)$/.exec(why);
            const key = m ? `${m[1]} ${m[3]}` : why;
            const g = grouped.get(key) || { n: 0, dates: [] };
            g.n += n;
            if (m) g.dates.push(m[2]);
            grouped.set(key, g);
        }
        for (const [why, g] of grouped) {
            const span = g.dates.length
                ? (() => {
                    const d = g.dates.slice().sort();
                    const first = d[0]; const last = d[d.length - 1];
                    return ` — ${g.dates.length} date${g.dates.length === 1 ? '' : 's'}`
                        + (first === last ? ` (${first})` : ` from ${first} to ${last}`);
                })()
                : '';
            lines.push(`  ${g.n} — ${why}${span}`);
        }
    }
    const cut = { bills: push.cutoverFor('bill', out.env), invoices: push.cutoverFor('invoice', out.env) };
    const src = (k) => {
        const w = push.cutoverSource(k);
        return w === 'env' ? ' (pinned in .env)' : w === 'override' ? ' (lifted for one run)'
            : push.cutoverIsRolling(k) ? ' — set to "today", so it MOVES EVERY DAY and nothing back-dated can get in' : '';
    };
    const lock = (k, label) => cut[k === 'bill' ? 'bills' : 'invoices']
        ? `${label} locked before ${cut[k === 'bill' ? 'bills' : 'invoices']}${src(k)}`
        : `${label} open — no period locked`;
    lines.push('', `Period lock — ${lock('bill', 'bills')}, ${lock('invoice', 'invoices')}. Nothing dated after ${push.todayISO()} is entered.`,
        'With no lock, every 2026 row is fair game and each one is judged on evidence instead: already in',
        'QuickBooks? cost already sitting on a cheque with no bill behind it? Lock a period on the',
        'QuickBooks page only once you have genuinely closed it.',
        '', 'Open the QuickBooks page in Jarvis to fix a stuck row or undo anything here.');
    if (out.snapshot && out.snapshot.totals) {
        const t = out.snapshot.totals;
        lines.push('', `Books read for the question channel: ${t.bills} bills, ${t.invoices} invoices.`
            + ` QuickBooks says we owe ${money(t.owe)} and are owed ${money(t.owed)}.`
            + ` Ask on WhatsApp and that is the figure you get.`);
    } else if (out.snapshotError) {
        lines.push('', `The books were NOT read for the question channel: ${out.snapshotError}.`
            + ' WhatsApp answers about money will quote whatever the last snapshot said, and will say how old it is.');
    }
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
