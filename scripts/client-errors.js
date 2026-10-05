#!/usr/bin/env node
// ── scripts/client-errors.js — what the phones and browsers could not do ───
//
// Apsara, 2026-10-05: "it's working for me. but people in us are facing
// issue. we must find a permanent solution for this."
//
// POST /api/client-errors has been recording exactly that since 2026-10-02,
// written after four hours went into guessing why some wifi networks would
// not let the app sign in. Nothing has ever READ it: helpers/clientErrors.js
// exports list(), summary() and digestText(), and no route, screen or script
// called any of them. A diagnostic nobody can read is the same fault as a
// screen nobody can reach — it looks monitored and is not.
//
//   node scripts/client-errors.js              last 24 hours
//   node scripts/client-errors.js --hours=168  last week
//   node scripts/client-errors.js --all        every row kept, newest first
//
// WHAT IT ANSWERS. Each report carries the probes the client ran before it
// gave up, and summary() groups by the FIRST ONE THAT FAILED. That is the
// difference between a name that would not resolve, a connection that was
// refused, a server that answered too slowly, and a sign-in that was
// rejected — four different problems that all look like "Network error." to
// the person holding the phone.
require('dotenv').config();
const ce = require('../helpers/clientErrors');

const arg = (k, d) => {
    const a = process.argv.find((x) => x.startsWith(`--${k}=`));
    return a ? a.split('=')[1] : d;
};
const all = process.argv.includes('--all');
const hours = Number(arg('hours', 24)) || 24;

const rows = all ? ce.list({}) : ce.list({ since: new Date(Date.now() - hours * 3600000).toISOString() });
const s = ce.summary({ hours: all ? 24 * 3650 : hours });

console.log(`\nClient error reports — ${all ? 'everything kept' : `last ${hours}h`}`);
console.log(`file: ${ce.FILE}\n`);

if (!s || !rows.length) {
    console.log('  NOTHING REPORTED.');
    console.log('  That means one of three things, and they are not the same:');
    console.log('    1. nobody hit a problem in this window;');
    console.log('    2. they did, and their device could not reach the server to say so');
    console.log('       (the report needs the same network the app needs);');
    console.log('    3. they are on a build older than 2026-10-02, which does not report.');
    console.log('  Widen the window with --all before concluding it is quiet.\n');
    process.exit(0);
}

console.log(ce.digestText(s));
console.log('');

// The rows themselves, because the summary says WHERE it broke and the rows
// say for whom, on what, and how the client described it.
const show = rows.slice(-40).reverse();
console.log(`  ${show.length} most recent report(s):\n`);
for (const r of show) {
    const probes = (r.probes || []).map((p) => `${p.ok ? '+' : '!'}${p.label}${p.ms ? `(${p.ms}ms)` : ''}`).join(' ');
    console.log(`  ${r.at}  ${(r.platform || 'unknown device').slice(0, 44)}`);
    console.log(`     base ${r.base || '?'}   app ${r.app_version || '?'}   conn ${r.ip || '?'}`);
    if (r.verdict) console.log(`     said: ${r.verdict}`);
    if (probes) console.log(`     probes: ${probes}`);
    console.log('');
}
