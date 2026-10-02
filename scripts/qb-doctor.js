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
        say(!!d, `cutover ${k}s`, d ? `${d}  (${from})` : 'NOT SET — in production nothing will be entered');
    }
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
