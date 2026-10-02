#!/usr/bin/env node
// ── scripts/qb-cutover.js — where the QuickBooks boundary sits ──────────────
// Apsara, 2026-09-26: "I want nightly report to run everyday to upload all the
// bills and invoices." The nightly run only ever touches rows dated ON OR
// AFTER the cutover, so the cutover is what decides how much "all" is. It used
// to live only in .env, which meant an SSH session, an edit and a pm2 restart
// — and while it sat on today's date, every row the sheet sync wrote for the
// previous days was skipped in silence.
//
//   node scripts/qb-cutover.js
//   node scripts/qb-cutover.js --bills=2026-09-06 --invoices=2026-08-28
//   node scripts/qb-cutover.js --bills=none --invoices=none     (no lock)
//   node scripts/qb-cutover.js --bills=today                    (rolling)
//
// The saved date outranks .env and takes effect on the next run — no restart.
// Anything OLDER than the boundary is deliberately left to her: her books
// already hold that period by hand, or the cost went straight to Cost of Goods
// Sold with no bill, so a Jarvis bill would count it twice. Push a reviewed
// older list explicitly with scripts/qb-push-list.js.
require('dotenv').config();
const push = require('../helpers/quickbooks/push');
const auth = require('../helpers/quickbooks/auth');

const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1].trim() : null; };
const env = auth.qbEnv();
const show = (label) => {
    const kind = label === 'bills' ? 'bill' : 'invoice';
    const from = push.cutoverSource(kind);
    const where = from === 'setting' ? 'saved setting (the page can move it)'
        : from === 'env' ? 'from .env — the saved setting is empty'
        : from === 'override' ? 'lifted for this process only'
        : from === 'unlocked' ? 'unlocked on purpose from the page (this beats .env)'
        : 'no lock — 2026 is open and evidence decides. This is the normal state.';
    const d = push.cutoverFor(kind, env);
    const roll = push.cutoverIsRolling(kind) ? '  <- "today", MOVES EVERY DAY: nothing back-dated gets in' : '';
    console.log(`  ${label.padEnd(9)} ${String(d || '—').padEnd(12)} ${where}${roll}`);
};

const bills = arg('bills'), invoices = arg('invoices');
if (bills || invoices) {
    const { changed } = push.saveCutover({ bills, invoices }, 'qb-cutover.js');
    console.log(Object.keys(changed).length ? `Moved: ${JSON.stringify(changed)}` : 'Nothing changed — those were already the dates.');
}
console.log(`QuickBooks period lock (${env}) — normally none; nothing dated after ${push.todayISO()} is ever entered:`);
show('bills'); show('invoices');
const hist = (push.cutoverStore().history || []).slice(0, 3);
if (hist.length) { console.log('Last moves:'); for (const h of hist) console.log(`  ${h.at} by ${h.by} — ${JSON.stringify({ ...h, at: undefined, by: undefined })}`); }
console.log('Older than these: left alone on purpose. Push a reviewed list with scripts/qb-push-list.js.');
