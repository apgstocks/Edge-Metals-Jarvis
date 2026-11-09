#!/usr/bin/env node
// After helpers/restore.js, turn data/inbound_log.json (an array) back into the live
// data/inbound_log.jsonl. Refuses to overwrite a non-empty live log. Usage:
//   node scripts/restore-inbound-log.js [dataDir]
'use strict';
const fs = require('fs'), path = require('path');
const dir = process.argv[2] || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const src = path.join(dir, 'inbound_log.json'), dst = path.join(dir, 'inbound_log.jsonl');
if (!fs.existsSync(src)) { console.error('nothing to restore: ' + src + ' is missing'); process.exit(1); }
if (fs.existsSync(dst) && fs.statSync(dst).size > 0) { console.error('refusing: ' + dst + ' already has content'); process.exit(1); }
const rows = JSON.parse(fs.readFileSync(src, 'utf8'));
if (!Array.isArray(rows)) { console.error('inbound_log.json is not an array'); process.exit(1); }
fs.writeFileSync(dst, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
console.log('restored ' + rows.length + ' messages to ' + dst);
