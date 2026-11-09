#!/usr/bin/env node
// Command line for helpers/selfBuild.js — Jarvis changing its own code behind her approval.
//   node scripts/self-build.js request "what you want built"   (runs the whole build; can take minutes)
//   node scripts/self-build.js list | show <id> | approve <id> | reject <id> | rollback <id>
//   node scripts/self-build.js baseline                        (record which tests are ALREADY red on a clean checkout)
// Run as the manager. Nothing here deploys: after approve, run ship.sh and pull/restart on the VM.
'use strict';
const path = require('path');
const sb = require('../helpers/selfBuild');
const ROOT = path.join(__dirname, '..');
const cfg = { repo: ROOT, dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'), workRoot: process.env.JARVIS_BUILD_DIR };
const by = 'manager';
const [cmd, ...rest] = process.argv.slice(2);
(async () => {
    if (cmd === 'request') {
        const r = await sb.request(cfg, { by, text: rest.join(' '), allowTestEdits: process.env.JARVIS_ALLOW_TEST_EDITS === '1' });
        console.log(r.summary || `${r.state || 'refused'}: ${r.reason || r.error}`); console.log('id: ' + (r.id || '-'));
    } else if (cmd === 'list') {
        for (const r of sb.list(cfg)) console.log(`${r.id}  ${(r.state || '').padEnd(11)} ${String(r.request || '').slice(0, 70)}`);
    } else if (cmd === 'show') { const r = sb.get(cfg, rest[0]); console.log(r ? (r.summary || JSON.stringify(r, null, 2)) : 'no such build'); }
    else if (cmd === 'approve') console.log(JSON.stringify(sb.approve(cfg, { by, id: rest[0] })));
    else if (cmd === 'reject') console.log(JSON.stringify(sb.reject(cfg, { by, id: rest[0] })));
    else if (cmd === 'rollback') console.log(JSON.stringify(sb.rollback(cfg, { by, id: rest[0] })));
    else if (cmd === 'baseline') { const r = sb.recordBaseline(cfg); console.log(`recorded: ${r.files} test files, ${r.failed.length} already red: ${r.failed.join(', ')}`); }
    else { console.log('usage: request "<ask>" | list | show <id> | approve <id> | reject <id> | rollback <id> | baseline'); process.exit(cmd ? 1 : 0); }
})().catch((e) => { console.error(e.message); process.exit(1); });
