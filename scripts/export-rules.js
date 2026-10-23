#!/usr/bin/env node
// ── scripts/export-rules.js ─────────────────────────────────────────────────
// The destination-rules register: what is on file, what nobody has confirmed,
// and what a given container would be told.
//
// Apsara, 2026-10-23: Jarvis as the one tool for a US scrap exporter's
// export-import side, then "Audit and build everything".
//
//   node scripts/export-rules.js                      what is on file
//   node scripts/export-rules.js attention            only what needs a human
//   node scripts/export-rules.js check "Busan,South Korea"
//   node scripts/export-rules.js verify IN-PSIC-2026 --by "Bose" [--clear-disputed]
//
// `verify` is the only thing here that writes, and it refuses without a named
// person — the register's whole value is that somebody is accountable for each
// rule. Run it where data/ is (the VM).
const path = require('path');
const X = require(path.join(__dirname, '..', 'helpers', 'exportRules'));

const argv = process.argv.slice(2);
const cmd = (argv[0] || 'list').toLowerCase();
const flag = (n) => { const i = argv.indexOf('--' + n); return i === -1 ? null : argv[i + 1]; };
const has = (n) => argv.includes('--' + n);

const WHY = {
    never_verified: 'NOBODY HAS CONFIRMED IT',
    expired: 'LAPSED',
    disputed: 'SOURCES DISAGREE',
    lapsing: 'lapses soon',
    missing: 'missing',
};

function showRule(r, st) {
    const s = st || X.statusOf(r);
    console.log(`\n  ${r.id}   [${r.country}]   ${s.actionable ? 'in force' : WHY[s.why] || s.why}`);
    console.log(`    ${r.requirement}`);
    console.log(`    outcome: ${r.outcome}`);
    if (r.source_ref) console.log(`    source:  ${r.source_ref}`);
    if (r.source_url) console.log(`             ${r.source_url}`);
    console.log(`    verified: ${r.verified_by ? `${r.verified_by} on ${r.verified_on}` : '— nobody —'}`
        + (s.expires_on ? `   until ${s.expires_on}` : ''));
    if (!s.actionable && r.how_to_verify) console.log(`    TO FIX:  ${r.how_to_verify}`);
}

(async () => {
    if (cmd === 'verify') {
        const id = argv[1];
        const by = flag('by');
        if (!id || !by) {
            console.error('\n  node scripts/export-rules.js verify <RULE-ID> --by "<person>"');
            console.error('  The person is required. A rule confirmed by nobody is why this register exists.\n');
            process.exit(2);
        }
        try {
            await X.verify(id, { by, on: flag('on'), expires_on: flag('until'),
                outcome: flag('outcome'), clear_disputed: has('clear-disputed'),
                note: flag('note') });
        } catch (e) {
            console.error('\n  Refused: ' + e.message + '\n');
            process.exit(1);
        }
        const r = X.rules().find((x) => x.id === id);
        console.log('\n  Recorded.');
        showRule(r);
        console.log('');
        return;
    }

    if (cmd === 'check') {
        const place = argv[1];
        if (!place) { console.error('\n  node scripts/export-rules.js check "Busan,South Korea"\n'); process.exit(2); }
        const r = X.check({ port_of_discharge: place, origin_country: flag('origin') || 'US',
            material: flag('material') });
        const banner = { clear: 'CLEAR', blocked: 'BLOCKED', unknown: 'DO NOT ASSUME — UNKNOWN' }[r.outcome];
        console.log(`\n── ${place} ───────────────────────────────────────────`);
        console.log(`\n  ${banner}`);
        console.log(`  country read as: ${r.country ? `${r.country.name} (matched "${r.country.matched}")` : 'COULD NOT TELL'}`);
        if (r.reasons.length) { console.log('\n  Why:'); for (const x of r.reasons) console.log('    · ' + x); }
        if (r.actions.length) { console.log('\n  What to do:'); for (const x of r.actions) console.log('    · ' + x); }
        console.log('');
        // So a scheduled run can notice. Unknown exits non-zero too: the point
        // of this module is that unknown is not a pass.
        if (r.outcome !== 'clear') process.exitCode = 1;
        return;
    }

    const all = X.rules();
    const att = X.needsAttention({});
    const attIds = new Set(att.map((a) => a.id));

    if (cmd === 'attention') {
        console.log('\n── Rules a human has to deal with ──────────────────────────────');
        if (!att.length) { console.log('\n  None. Every rule on file is confirmed and in date.\n'); return; }
        for (const a of att) showRule(a.rule, X.statusOf(a.rule));
        console.log(`\n  ${att.length} of ${all.length} rules are not safe to act on.\n`);
        process.exitCode = 1;
        return;
    }

    console.log('\n── Destination rules on file ───────────────────────────────────');
    if (!all.length) { console.log('\n  Nothing on file.\n'); return; }
    for (const r of all) showRule(r);
    console.log(`\n  ${all.length} rule(s); ${attIds.size} not safe to act on.`);
    console.log('  Nothing here is trustworthy because it was researched — only because');
    console.log('  a named person confirmed it on a known date. Use `verify` for that.\n');
    if (attIds.size) process.exitCode = 1;
})().catch((e) => { console.error('\nFailed: ' + (e && e.message || e) + '\n'); process.exit(1); });
