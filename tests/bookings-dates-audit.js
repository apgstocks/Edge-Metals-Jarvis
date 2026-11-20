const { audit } = require('../scripts/bookings-dates-audit');
let pass = 0, fail = 0; const ck = (n, c, d) => { if (c) pass++; else { fail++; console.log('FAIL', n, d || ''); } };
const r = audit({
  OK: { booking_number: 'OK', erd_date: '11/20/2099', cutoff_date: '11/27/2099', etd: '12/01/2099', eta: '01/05/2100' },
  NOERD: { booking_number: 'NOERD', cutoff_date: '11/27/2099' },
  BAD: { booking_number: 'BAD', erd_date: 'soon', cutoff_date: '11/27/2099' },
  ISO: { booking_number: 'ISO', erd_date: '2099-11-20', cutoff_date: '2099-11-27' },
  ORD: { booking_number: 'ORD', erd_date: '11/28/2099', cutoff_date: '11/27/2099', etd: '11/20/2099', eta: '11/10/2099' },
  OLD: { booking_number: 'OLD', erd_date: '09/14/2026', cutoff_date: '2026-09-16' },
  KEEP: { booking_number: 'KEEP', erd_date: '09/14/2026', cutoff_date: '09/16/2026' },
  WIN: { booking_number: 'WIN', erd_date: '08/01/2099', cutoff_date: '11/27/2099' },
}, { KEEP: { keep_active: true } });
const of = (id) => r.filter((x) => x.id === id).map((x) => x.kind);
ck('a sane booking is silent', of('OK').length === 0, of('OK').join());
ck('missing ERD', of('NOERD').includes('MISSING'));
ck('unreadable date', of('BAD').includes('FORMAT'));
ck('ISO is noted but not an error', of('ISO').join() === 'MIXED,MIXED');
ck('order problems (ERD>cutoff, cutoff>ETD, ETA<ETD)', of('ORD').filter((k) => k === 'ORDER').length === 3, of('ORD').join());
ck('expired is found even when stored as ISO', of('OLD').includes('EXPIRED') && of('OLD').includes('MIXED'));
ck('keep_active is not called expired', !of('KEEP').includes('EXPIRED'));
ck('ERD far before cutoff', of('WIN').includes('WINDOW'));
ck('worst kinds sort first', r[0].kind === 'MISSING' || r[0].kind === 'FORMAT');
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
