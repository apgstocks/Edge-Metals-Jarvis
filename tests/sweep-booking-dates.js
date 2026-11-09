// Bookings without ERD/cutoff show up in the integrity sweep.
const Module = require('module');
const json = require('../helpers/json');
const real = { b: json.loadBookings, w: json.loadWorkflow };
json.loadBookings = () => ({
  OK1: { booking_number: 'OK1', erd_date: '11/10/2026', cutoff_date: '11/15/2026' },
  NOERD: { booking_number: 'NOERD', cutoff_date: '11/15/2026', supplier: 'Nur Metal' },
  NOCUT: { booking_number: 'NOCUT', erd_date: '11/10/2026' },
  NONE: { booking_number: 'NONE', erd_date: ' ', cutoff_date: '' },
});
json.loadWorkflow = () => ({ NONE: { trucker_name: 'Ace' } });
const sweep = require('../helpers/integritySweep');
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) pass++; else { fail++; console.log('FAIL', n, d || ''); } };
const f = sweep.run().findings.find((x) => x.id === 'booking-missing-dates');
ck('finding exists', !!f);
const by = Object.fromEntries((f ? f.items : []).map((i) => [i.what, i.detail]));
ck('complete booking not flagged', !by.OK1);
ck('no ERD named', /no ERD\b(?! or)/.test(by.NOERD || ''), by.NOERD);
ck('no cutoff named', /no cutoff/.test(by.NOCUT || ''), by.NOCUT);
ck('both named with trucker', /ERD or cutoff/.test(by.NONE || '') && /Ace/.test(by.NONE), by.NONE);
ck('email text mentions the booking', /NOERD/.test(sweep.reportText(sweep.run())));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
