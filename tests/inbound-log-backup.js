// tests/inbound-log-backup.js — what she said to Jarvis survives the machine dying.
// Real backup.buildArchive -> real restore.applyRestore onto an empty dir -> the real
// scripts/restore-inbound-log.js -> the live log is word-for-word what it was.
const fs = require('fs'), os = require('os'), path = require('path'), { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ilbk-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1'; process.env.API_TOKEN = 't';
const LIVE = path.join(TMP, 'inbound_log.jsonl');
process.env.JARVIS_INBOUND_LOG_FILE = LIVE;
const il = require(path.join(ROOT, 'helpers/inboundLog'));
const backup = require(path.join(ROOT, 'helpers/backup'));
const restore = require(path.join(ROOT, 'helpers/restore'));

const said = ['Eccomelt pays late', 'Wire from Zimex must say Edge Metals', 'quote 2150/MT Mombasa'];
said.forEach((t) => il.record({ chatId: '1@c.us', role: 'manager', text: t }));
fs.appendFileSync(LIVE, '{"torn":');                     // a half-written line must not poison the backup
il.record({ chatId: '1@c.us', role: 'manager', text: 'after a torn line' });
const original = il.readAll(LIVE);

const a = backup.buildArchive();
ck('the archive carries the log', Array.isArray(a.stores['inbound_log.json']) && a.stores['inbound_log.json'].length === 4, Object.keys(a.stores).join(','));
ck('  nothing torn went in', a.stores['inbound_log.json'].every((r) => typeof r.text === 'string'));
ck('the archive is still valid for restore', restore.validateArchive(a).ok, JSON.stringify(restore.validateArchive(a).errors));

const NEW = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ilbk-parent-')), 'restored');   // unique every run (a pid-named dir left behind made a later run crash)
restore.applyRestore(a, NEW);
ck('restore puts it back as inbound_log.json', fs.existsSync(path.join(NEW, 'inbound_log.json')));
const run = (dir) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/restore-inbound-log.js'), dir], { encoding: 'utf8' });
const r = run(NEW);
ck('the conversion script succeeds', r.status === 0, r.stdout + r.stderr);
const back = il.readAll(path.join(NEW, 'inbound_log.jsonl'));
ck('every message comes back, in order, word for word', JSON.stringify(back) === JSON.stringify(original));
ck('it refuses to overwrite a live log that has content', run(NEW).status === 1);
ck('and a restore dir with no log is a clear error, not a crash', run(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-empty-'))).status === 1);

fs.rmSync(LIVE);
try { fs.rmSync(path.dirname(NEW), { recursive: true, force: true }); } catch (e) { /* ignore */ }
const b = backup.buildArchive();
ck('no log yet -> the archive simply has no such store, no error', !('inbound_log.json' in b.stores));
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
