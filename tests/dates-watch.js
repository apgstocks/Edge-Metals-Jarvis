// Missing ERD/cutoff: no standalone WhatsApp; one compact digest line instead.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-'));
const D = process.env.DATA_DIR;
const write = (f, o) => fs.writeFileSync(path.join(D, f), JSON.stringify(o));
write('bookings.json', {
  A1: { booking_number: 'A1', erd_date: '11/10/2026', cutoff_date: '11/15/2026' },
  B2: { booking_number: 'B2', cutoff_date: '11/15/2026' },
  C3: { booking_number: 'C3' },
});
write('workflow.json', {});
const bf = require.resolve('../helpers/cutoffBackfill');
require.cache[bf] = { id: bf, filename: bf, loaded: true, exports: { run: async () => ({ filled: [] }) } };
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) pass++; else { fail++; console.log('FAIL', n, d || ''); } };
(async () => {
  const sched = require('../scheduler');
  const sent = [];
  sched.init({ sendToManager: async (m) => sent.push(m), sendToTeam: async () => {} });
  await sched.datesWatch();
  ck('datesWatch sends NO WhatsApp', sent.length === 0, sent.length);
  const bd = require('../helpers/bookingDates');
  const line = bd.digestLine();
  ck('digest line names B2 and C3 in one line', /^NO ERD\/CUTOFF \(2\): B2, C3$/.test(line), line);
  ck('capped', /\+4 more/.test(bd.digestLine(Array.from({ length: 10 }, (_, i) => ({ booking: 'X' + i })))));
  // the real digest carries it, once
  await sched.morningDigest();
  const d = sent.filter((m) => /Daily digest/.test(m));
  ck('digest includes the line exactly once', d.length === 1 && (d[0].match(/NO ERD\/CUTOFF/g) || []).length === 1, JSON.stringify(sent).slice(0, 300));
  write('bookings.json', { A1: { booking_number: 'A1', erd_date: 'x', cutoff_date: 'y' } });
  ck('silent once filled', bd.digestLine() === '');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
