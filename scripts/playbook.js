#!/usr/bin/env node
// ── scripts/playbook.js — see, test and trim what Jarvis has been taught ────
//   node scripts/playbook.js list                 every rule, oldest first
//   node scripts/playbook.js ask "text"           what Jarvis would recall for that situation
//   node scripts/playbook.js seed                 add the rules she gave on 2026-11-07 (idempotent)
//   node scripts/playbook.js forget <id>          delete one rule
//   node scripts/playbook.js snapshot             write backup.json so the nightly backup has it
//   add  --company edge_yard  to use the other company (default: edge_metals)
//
// Runs where data/ is: on the VM for the live Playbook. Running it on the Mac fills
// the Mac checkout's own data/disk, which is not the live one.
//
// Nothing here changes any decision. The app does not read the Playbook yet.
const playbook = require('../helpers/playbook');
const { getDisk } = require('../helpers/diskStore');

const args = process.argv.slice(2);
const ci = args.indexOf('--company');
const company = ci >= 0 ? args.splice(ci, 2)[1] : 'edge_metals';
const [cmd, ...rest] = args;

function fail(msg) { console.error(msg); process.exit(1); }

let p;
try { p = getDisk().for(company); }
catch (e) { fail(e.message); }

const bad = p.health().badLines;
if (bad.facts || bad.log || bad.links) console.error(`warning: unreadable lines skipped: ${JSON.stringify(bad)}`);

switch (cmd) {
    case 'list': {
        const rows = playbook.list(p);
        if (!rows.length) { console.log(`${company}: the Playbook is empty. Run "seed" to add the rules from 2026-11-07.`); break; }
        console.log(`${company}: ${rows.length} rule${rows.length === 1 ? '' : 's'}`);
        for (const f of rows) console.log(`#${f.id}  [${f.scope}] ${f.name}\n      ${typeof f.value === 'string' ? f.value : JSON.stringify(f.value)}\n      taught by ${f.taughtBy}, ${f.at.slice(0, 10)}${f.sourceMsg ? ` (${f.sourceMsg})` : ''}`);
        break;
    }
    case 'ask': {
        const text = rest.join(' ').trim();
        if (!text) fail('ask what? e.g. node scripts/playbook.js ask "Rad Metal wants a payment reminder"');
        const r = playbook.ask(p, text);
        console.log(r.brief || '(nothing in the Playbook applies)');
        if (r.ambiguous.length) console.log(`\nnot sure which one you mean: ${r.ambiguous.map((a) => `"${a.name}" could be ${a.could_be.join(' or ')}`).join('; ')}`);
        break;
    }
    case 'seed': {
        if (company !== 'edge_metals') fail('the seed is Edge Metals\' rules; it will not be written into another company');
        const r = playbook.seed(p);
        console.log(`added ${r.added.length}, already there ${r.skipped.length}, conflicts ${r.conflicts.length}, left deleted ${r.forgotten.length}`);
        for (const f of r.forgotten) console.log(`  - ${f} was deleted earlier, not added back`);
        for (const a of r.added) console.log(`  + ${a}`);
        for (const c of r.conflicts) console.log(`  ! ${c.name} already says something different, left as it is: ${c.keeps}`);
        if (r.added.length) { const s = p.snapshot(); console.log(`backup written: ${s.file}`); }
        break;
    }
    case 'forget': {
        const id = rest[0];
        if (!id || !/^\d+$/.test(id)) fail('forget which rule? give its number from "list"');
        const ok = playbook.forget(p, id);
        console.log(ok ? `forgot rule #${id}` : `no live rule #${id}`);
        if (ok) p.snapshot();    // keep the nightly backup in step with what she just deleted
        break;
    }
    case 'snapshot': {
        const s = p.snapshot();
        console.log(`wrote ${s.file} (${s.rows} rows)`);
        break;
    }
    default:
        fail('usage: node scripts/playbook.js list | ask "text" | seed | forget <id> | snapshot   [--company edge_yard]');
}
