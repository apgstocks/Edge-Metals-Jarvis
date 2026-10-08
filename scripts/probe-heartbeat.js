// Names and periods the real scheduler.js produces, with a fake cron so
// nothing is scheduled and a temp heartbeat file so nothing real is written.
process.env.JARVIS_TEST = '1';
const os = require('os'), fs = require('fs'), path = require('path');
const cfg = require('../config');
cfg.HEARTBEAT_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hb-')), 'heartbeat.json');
const hb = require('../helpers/heartbeat');
const fake = { schedule: () => ({ stop() {} }), validate: () => true, getTasks: () => [] };
const inst = hb.instrument(fake);
const src = fs.readFileSync(require('path').join(__dirname,'..','scheduler.js'), 'utf8');
// Pull out every cron.schedule(expr, fn...) and register it against the shim
// by replaying the expression and the function SOURCE (name derivation only
// reads fn.toString(), so a stub carrying the same text is enough).
const re = /cron\.schedule\(\s*(['"])([^'"]+)\1\s*,\s*([\s\S]{0,4000}?)\n/g;
let m, n = 0;
while ((m = re.exec(src))) {
    const expr = m[2], body = m[3];
    inst.schedule(expr, new Function(`/* ${body.replace(/\*\//g, '* /')} */`), {});
    n++;
}
const st = hb.load();
const rows = Object.entries(st.jobs).map(([k, v]) => ({ name: k, expr: v.expr, p: v.period_ms }));
const H = (ms) => ms == null ? '?' : ms >= hb._DAY ? (ms / hb._DAY) + 'd' : ms >= hb._HOUR ? (ms / hb._HOUR) + 'h' : (ms / hb._MIN) + 'm';
console.log(`registered ${n} schedules -> ${rows.length} named jobs\n`);
for (const r of rows) console.log('  ' + r.name.padEnd(28) + String(r.expr).padEnd(16) + H(r.p));
console.log('\nunnamed/fallback:', rows.filter(r => /^job(-\d+)?$/.test(r.name)).length);
