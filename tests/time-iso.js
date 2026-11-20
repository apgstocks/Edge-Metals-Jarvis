// A booking saved from the dashboard form carries ISO dates; cutoff logic must read them.
const T = require('../helpers/time');
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) pass++; else { fail++; console.log('FAIL', n, d || ''); } };
ck('US date still works', T.daysUntil('09/16/2026') === T.daysUntil('9/16/2026') && T.daysUntil('09/16/2026') !== 999);
ck('ISO date now gives the same answer as the US form', T.daysUntil('2026-09-16') === T.daysUntil('09/16/2026'), String(T.daysUntil('2026-09-16')));
ck('ISO with a time part', T.daysUntil('2026-09-16T10:00:00Z') === T.daysUntil('09/16/2026'));
ck('garbage is still 999 / null', T.daysUntil('soon') === 999 && T.daysUntil('') === 999 && T.daysUntil(null) === 999 && T.parseUSDate('soon') === null);
const a = T.parseUSDate('2026-12-01'), b = T.parseUSDate('12/01/2026');
ck('parseUSDate reads ISO', a && b && a.getTime() === b.getTime());
// the real consequence: past-cutoff scan sees an ISO-dated booking
const J = require('../helpers/json');
const real = [J.loadBookings, J.loadWorkflow];
J.loadBookings = () => ({ ISO1: { booking_number: 'ISO1', cutoff_date: '2026-01-05' }, US1: { booking_number: 'US1', cutoff_date: '01/05/2026' }, FUT: { booking_number: 'FUT', cutoff_date: '2099-01-05' }, KEEP: { booking_number: 'KEEP', cutoff_date: '2026-01-05' } });
J.loadWorkflow = () => ({ KEEP: { keep_active: true } });
const scan = require('../helpers/cutoffScan').pastCutoff().map((x) => x.bkgNo).sort();
ck('scan archives ISO and US past-cutoff alike, not future, not kept', JSON.stringify(scan) === '["ISO1","US1"]', scan.join());
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
