#!/usr/bin/env node
// ── scripts/check-entrances.js — can people actually get in? ──────────────
//
// Run it on the VM, or anywhere with internet, the moment someone says they
// cannot reach Jarvis:
//
//     node scripts/check-entrances.js
//
// It probes every address anyone might be holding and says which one they
// are on and what is wrong with it. On 2026-10-05 that answer was available
// in one second and instead took an afternoon, four wrong theories and a
// waiting customer — because nothing in this system had ever checked that
// its own public address answers.
//
// Exit 0 when every address behaves; 1 when something a person could be
// holding is dead.

const E = require('../helpers/entrances');

(async () => {
    // helpers/entrances.js opens no sockets of its own, so the certificate
    // expiry is only looked at when something injects a way to connect.
    const res = await E.checkAll({ tlsImpl: require('tls').connect });
    console.log(`\nENTRANCES — ${res.at}\n`);
    for (const r of res.results) {
        const mark = r.skipped ? ' -- ' : (r.ok ? ' ok ' : ' !! ');
        console.log(`[${mark}] ${r.url}`);
        console.log(`         expect ${r.expect}${r.status ? `, got ${r.status}` : ''}${r.location ? ` -> ${r.location}` : ''}`);
        if (!r.ok || r.skipped) console.log(`         ${r.detail || ''}`);
    }

    // The deadline, printed whether or not it is close — "expires in 58 days"
    // is the line that makes the Dec 4 hand-off visible on an ordinary day,
    // instead of only in the week it becomes a problem.
    const c = res.certificate || {};
    const cmark = !c.checked ? ' -- ' : (c.ok ? ' ok ' : ' !! ');
    console.log(`[${cmark}] https://${c.host || '?'} — certificate`);
    console.log(c.checked
        ? `         expires ${c.validTo} — ${c.days} day(s) left${c.issuer ? `, issued by ${c.issuer}` : ''}`
        : `         ${c.detail || 'not attempted'}`);
    console.log('');
    if (res.ok) { console.log('Every address answers as it should.\n'); process.exit(0); }
    console.log(E.report(res));
    console.log('');
    process.exit(1);
})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
