#!/usr/bin/env node
// ── scripts/qb-doctor.js — is any of this actually switched on? ────────────
// Eight commits of QuickBooks work went in before any of it ran anywhere, and
// twice in one afternoon a check answered from the wrong file and told her
// something untrue. So before trusting a single number on the page, run this
// ON THE MACHINE THAT SERVES IT and read what it says out loud:
//
//   node scripts/qb-doctor.js
//
// It writes nothing. It only reports which stores are in play, which switches
// are on, and whether the thing that is supposed to run at night exists.
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const on = (v) => String(v || '').trim().toLowerCase() === 'on';
const tick = (ok) => (ok === null ? ' ? ' : ok ? ' ok' : 'XX ');
let problems = [];
const say = (ok, label, detail) => {
    console.log(`  ${tick(ok)}  ${label.padEnd(34)} ${detail === undefined ? '' : detail}`);
    if (ok === false) problems.push(label);
};
const rel = (p) => { try { return path.relative(path.join(__dirname, '..'), p) || p; } catch { return p; } };
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

(async () => {
    console.log('\nQB DOCTOR\n');

    // ── which company, and can it be reached ──────────────────────────────
    const auth = require('../helpers/quickbooks/auth');
    const env = auth.qbEnv();
    const st = auth.status(env);
    say(env === 'production' ? true : null, 'environment', env + (env === 'production' ? '   <-- LIVE BOOKS' : ''));
    say(!!st.connected, 'connected', st.connected ? `realm ${st.realmId}, token good for ${st.refresh_days_left} days` : 'NOT CONNECTED — run scripts/qb-connect.js');

    // ── the switches ──────────────────────────────────────────────────────
    console.log('\n  switches');
    const writes = on(process.env.QB_PROD_WRITES), sync = on(process.env.QB_SYNC), agentOn = on(process.env.QB_AGENT);
    say(writes, 'QB_PROD_WRITES', writes ? 'on — saves reach her books' : 'off — everything is a dry run');
    say(sync, 'QB_SYNC', sync ? 'on — a save in Jarvis pushes' : 'off — the hooks do nothing');
    say(agentOn, 'QB_AGENT', agentOn ? 'on — the agent may place payments' : 'off — the agent surveys and emails, writes nothing');

    // ── WHICH FILES IS THIS MACHINE READING ───────────────────────────────
    // The question that cost two wrong answers: the same code answers
    // differently depending on which store it finds.
    console.log('\n  stores in play');
    const mapping = require('../helpers/quickbooks/mapping');
    const push = require('../helpers/quickbooks/push');
    const journal = require('../helpers/quickbooks/journal');
    const decisions = require('../helpers/quickbooks/decisions');
    const mapFile = mapping.MAP_FILE();
    const map = mapping.loadMap();
    const counts = Object.entries(map).filter(([, v]) => v && typeof v === 'object').map(([k, v]) => `${k} ${Object.keys(v).length}`).join(', ');
    say(/qb-settings/.test(mapFile) || Object.keys(map.vendor || {}).length > 0, 'name map', `${rel(mapFile)}  (${counts})`);
    say(exists(decisions.FILE()) ? true : null, 'decisions', `${rel(decisions.FILE())}  (${exists(decisions.FILE()) ? decisions.list().length + ' answered' : 'none yet'})`);
    say(exists(journal.JOURNAL_FILE()) ? true : null, 'journal', `${rel(journal.JOURNAL_FILE())}  (${exists(journal.JOURNAL_FILE()) ? journal.list({ env }).length + ' entries' : 'empty — nothing has been written yet'})`);
    say(null, 'links', rel(push.LINKS_FILE()));

    // ── the ledgers this machine can see ──────────────────────────────────
    // A check run against an empty ledger answers "nothing wrong" very fast.
    const bills = require('../helpers/bills').list().length;
    const sales = require('../helpers/sales').list().length;
    say(bills > 0 && sales > 0, 'jarvis ledgers', `${bills} bills, ${sales} sales`
        + (bills === 0 ? '  — THIS MACHINE HAS NO LEDGER DATA, so every local check is meaningless' : ''));

    // ── the boundary ──────────────────────────────────────────────────────
    console.log('\n  boundary');
    for (const k of ['bill', 'invoice']) {
        const d = push.cutoverFor(k, env), from = push.cutoverSource(k);
        // Unset is now the GOOD state: no period is locked, 2026 is open and
        // the evidence gates decide. A set lock is the one worth a second look.
        const rolling = push.cutoverIsRolling(k === 'bill' ? 'bill' : 'invoice');
        say(!rolling, `period lock (${k}s)`,
            !d ? 'none — 2026 is open, evidence decides (this is the normal state)'
                : rolling ? `"today" → ${d}, and it MOVES EVERY DAY, so nothing back-dated can ever be entered — almost certainly not what you want`
                    : `locked before ${d}  (${from})`);
    }
    // ── WHAT THE BOUNDARY IS HOLDING BACK ─────────────────────────────────
    // A cutover that is SET is not a cutover that is RIGHT. On 2026-10-02 the
    // doctor said "nothing is obviously wrong" while the boundary sat on the
    // day it was typed eight days earlier, and every row the sheet sync had
    // written since was being skipped in silence. So it is not enough to
    // report the date: report what is behind it.
    try {
        const links = push.loadLinks();
        const linked = (kind, id) => !!links[push.linkKey(env, kind, id)];
        const held = { bills: [], sales: [] };
        for (const b of require('../helpers/bills').list()) {
            const c = push.beforeCutover('bill', b.date, env);
            if (c && !push.NEEDS_FIX.test(c) && !linked('bill', b.id)) held.bills.push(push.isoDate(b.date) || String(b.date));
        }
        const seen = new Set();
        for (const sale of require('../helpers/sales').list()) {
            const no = push.docNumberFor(sale);
            if (no && seen.has(no)) continue;
            if (no) seen.add(no);
            const c = push.beforeCutover('invoice', sale.date, env);
            if (c && !push.NEEDS_FIX.test(c) && !linked('invoice', no || sale.id)) held.sales.push(push.isoDate(sale.date) || String(sale.date));
        }
        const n = held.bills.length + held.sales.length;
        const newest = [...held.bills, ...held.sales].sort().slice(-1)[0];
        const oldest = [...held.bills, ...held.sales].sort()[0];
        // Recent work behind the boundary is the tell: old rows behind it are
        // the accountant's period and belong there; rows from the last
        // fortnight are tonight's work being skipped.
        const fresh = [...held.bills, ...held.sales].filter((d) => d >= new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10)).length;
        say(fresh === 0, 'what the boundary holds back',
            n === 0 ? 'nothing' : `${held.bills.length} bills, ${held.sales.length} invoices (${oldest} → ${newest})`
                + (fresh ? `  — ${fresh} of them from the last fortnight, so TONIGHT'S WORK IS BEING SKIPPED` : '  — all older than a fortnight, which is the accountant\'s period'));
    } catch (e) { say(null, 'what the boundary holds back', `could not work it out: ${e.message.slice(0, 50)}`); }

    // ── ROWS DATED AHEAD OF TODAY ─────────────────────────────────────────
    // The rolling boundary (2026-10-02) refuses anything dated after today,
    // where before it would have been entered. If her sheet carries invoices
    // dated at the ETA rather than at issue, that is a real change in what
    // goes in tonight — so it is counted here rather than discovered from a
    // morning email.
    try {
        const t = push.todayISO();
        const ahead = [];
        for (const b of require('../helpers/bills').list()) { const d = push.isoDate(b.date); if (d && d > t) ahead.push(`bill ${d} ${b.supplier || ''}`.trim()); }
        for (const sale of require('../helpers/sales').list()) { const d = push.isoDate(sale.date); if (d && d > t) ahead.push(`invoice ${d} ${sale.customer || ''}`.trim()); }
        say(ahead.length === 0, 'dated after today', ahead.length === 0 ? `none (today is ${t})`
            : `${ahead.length} row(s) dated ahead of ${t} — these are now REFUSED as typos: ${ahead.slice(0, 4).join(', ')}${ahead.length > 4 ? '…' : ''}`);
    } catch (e) { say(null, 'dated after today', `could not work it out: ${e.message.slice(0, 50)}`); }

    for (const role of Object.keys(mapping.ACCOUNT_ROLES)) {
        const hit = mapping.matchParty(role, [], 'account');
        say(hit.status === 'confirmed', `role "${role}"`, hit.qb ? `#${hit.qb.Id} ${hit.qb.DisplayName}` : 'unmapped — a write that needs it will block');
    }

    // ── is anything scheduled ─────────────────────────────────────────────
    console.log('\n  scheduled');
    const sched = fs.readFileSync(path.join(__dirname, '..', 'scheduler.js'), 'utf8');
    say(/cron\.schedule\('15 23 \* \* \*'/.test(sched), 'sheet sync', '23:15 — fills the ledgers');
    say(/cron\.schedule\('0 0 \* \* \*'/.test(sched), 'quickbooks entry run', '00:00 — enters what is new');
    say(/cron\.schedule\('30 0 \* \* \*'/.test(sched), 'qb agent', '00:30 — places what it can, emails the rest');

    // ── can it actually read her books right now ──────────────────────────
    console.log('\n  reading her books');
    try {
        const client = require('../helpers/quickbooks/client');
        const ci = await client.companyInfo({ env });
        say(true, 'company', ci.CompanyName);
        const r = await client.query("select count(*) from Bill", { env });
        say(true, 'a query answered', `${(r.totalCount !== undefined ? r.totalCount : '?')} bills`);
    } catch (e) { say(false, 'reading her books', e.message.slice(0, 90)); }

    console.log('');
    if (!problems.length) console.log('  Nothing is obviously wrong.\n');
    else console.log(`  ${problems.length} thing(s) to deal with: ${problems.join(', ')}\n`);
    process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error('qb-doctor failed:', e.message); process.exit(1); });
