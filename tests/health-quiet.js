// Orphaned heartbeat records are not reported, and an unchanged health report
// is not re-sent the same day.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-'));
const cfg = require('../config');
const old = new Date(Date.now() - 23 * 86400000).toISOString();
fs.mkdirSync(path.dirname(cfg.HEARTBEAT_FILE), { recursive: true });
fs.writeFileSync(cfg.HEARTBEAT_FILE, JSON.stringify({ jobs: {
  'digest-2': { expr: '0 8 * * *', period_ms: 86400000, last_ok: old, ok: true },
  'log-digest': { expr: '0 7 * * *', period_ms: 86400000, last_ok: new Date(Date.now() - 3 * 86400000).toISOString(), ok: true },
  'live-fine': { expr: '0 7 * * *', period_ms: 86400000, last_ok: new Date().toISOString(), ok: true },
} }));
const hb = require('../helpers/heartbeat');
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) pass++; else { fail++; console.log('FAIL', n, d || ''); } };
// this process registers log-digest and live-fine only
hb.LIVE.add('log-digest'); hb.LIVE.add('live-fine');
let s = hb.status();
ck('orphan digest-2 is not reported', !s.late.some((j) => j.name === 'digest-2'), JSON.stringify(s.late.map((j) => j.name)));
ck('a real late job still is', s.late.some((j) => j.name === 'log-digest'));
ck('explicit state is taken as given', hb.status(Date.now(), JSON.parse(fs.readFileSync(cfg.HEARTBEAT_FILE))).late.some((j) => j.name === 'digest-2'));
(async () => {
  const sched = require('../scheduler');
  const sent = [];
  sched.init({ sendToManager: async (m) => sent.push(m), sendToTeam: async () => {} });
  const r1 = await sched.healthWatch();
  const r2 = await sched.healthWatch();
  ck('first report sent', r1.sent === true && sent.length === 1, JSON.stringify([r1, sent.length]));
  ck('identical report not repeated', r2.sent === false && r2.reason === 'unchanged' && sent.length === 1, JSON.stringify(r2));
  ck('report does not list the orphan', !/digest-2/.test(sent[0] || ''), sent[0]);
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
