// Daily watch: bookings without ERD/cutoff are reminded about until filled.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-'));
const D = process.env.DATA_DIR;
const write = (f, o) => fs.writeFileSync(path.join(D, f), JSON.stringify(o));
write('bookings.json', {
  A1: { booking_number: 'A1', erd_date: '11/10/2026', cutoff_date: '11/15/2026' },
  B2: { booking_number: 'B2', cutoff_date: '11/15/2026', supplier: 'Nur Metal' },
  C3: { booking_number: 'C3' },
});
write('workflow.json', {});
// no Gmail in a test: the mail backfill is stubbed out
const bf = require.resolve('../helpers/cutoffBackfill');
require.cache[bf] = { id: bf, filename: bf, loaded: true, exports: { run: async () => ({ filled: [] }) } };
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) pass++; else { fail++; console.log('FAIL', n, d || ''); } };
(async () => {
  const sched = require('../scheduler');
  const sent = [];
  sched.init({ sendToManager: async (m) => sent.push(m), sendToTeam: async () => {} });
  await sched.datesWatch();
  ck('one message sent', sent.length === 1, sent.length);
  ck('names B2 and C3 only', /B2/.test(sent[0]) && /C3/.test(sent[0]) && !/A1:/.test(sent[0]), sent[0]);
  ck('says ERD for B2, ERD or cutoff for C3', /B2: no ERD\b(?! or)/.test(sent[0]) && /C3: no ERD or cutoff/.test(sent[0]), sent[0]);
  await sched.datesWatch();
  ck('not repeated the same day', sent.length === 1, sent.length);
  // filled -> silent (new day key simulated by clearing sent-state)
  write('bookings.json', { A1: { booking_number: 'A1', erd_date: 'x', cutoff_date: 'y' } });
  const bd = require('../helpers/bookingDates');
  ck('nothing missing once filled', bd.missing().length === 0 && bd.watchMessage([]) === '');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
