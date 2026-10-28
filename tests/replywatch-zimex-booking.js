// Apsara, 2026-10-28: "I dont want booking requested replies from zimex. Booking info related things are stored
// automatically in my jarvis." Zimex only, booking mail only; critical signals still get through.
const fs = require('fs'), os = require('os'), path = require('path');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-zb-'));
process.env.DATA_DIR = scratch; process.env.JARVIS_TEST = '1';
const rw = require('../workflow/replyWatch.js');
const src = fs.readFileSync(path.join(__dirname, '..', 'workflow', 'replyWatch.js'), 'utf8');
let pass = 0, fail = 0;
const ck = (n, c) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); } };
const f = rw.isZimexBookingMail;
ck('Zimex + "booking" in subject', f({ from: 'Kristal <export@zimexglt.com>', subject: 'Booking request for 26JY79', body: '' }));
ck('Zimex + booking ref in body', f({ from: 'export@zimexglt.com', subject: 'Re: shipment', body: 'See DALA20928700 attached' }));
ck('Zimex + "booked" in body', f({ from: 'export@zimexglt.com', subject: 'Update', body: 'We have booked the container.' }));
ck('Zimex mail NOT about a booking is untouched', !f({ from: 'export@zimexglt.com', subject: 'Invoice 8851', body: 'Please confirm payment.' }));
ck('another sender\'s booking mail is untouched', !f({ from: 'ops@hapag.example.com', subject: 'Booking confirmation', body: 'DALA20928700' }));
ck('look-alike domain is untouched', !f({ from: 'a@notzimex.evil.com', subject: 'Booking', body: '' }));
ck('no args does not throw', f() === false);
ck('a critical signal still gets through the suppression', /isZimexBookingMail\(\{ from, subject, body: visible \}\) && \(imp\.level !== 'critical' \|\| hideZimexCritical\)/.test(src));
ck('the suppression sits in front of the flag gate', /if \(!zimexBooking && \(\(a\.needs_reply/.test(src));
try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) { /* ok */ }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
