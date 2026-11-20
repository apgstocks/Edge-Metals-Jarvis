const V = require('../helpers/bookingsVsMail');
let pass = 0, fail = 0; const ck = (n, c, d) => { if (c) pass++; else { fail++; console.log('FAIL', n, d || ''); } };
const mail = (id, subject, body, at, hasPdf = false) => ({ id, info: { subject, body, at, hasPdf } });
const MAILS = {
  AAA111: [mail('1', 'Booking AAA111 vessel window changed', 'ERD: Nov 16\nCargo cut off: Nov 19\nETD Nov 23\n\nOn Tue wrote:\n> ERD Nov 9', 2000), mail('2', 'Booking AAA111 older', 'ERD: Nov 1', 1000)],
  BBB222: [mail('3', 'Booking BBB222 confirmation', 'ERD: Nov 16 same as ours', 3000)],
  CCC333: [mail('4', 'Booking CCC333 pdf', 'see attached', 3000, true)],
  DDD444: [],
  EEE555: [mail('5', 'EEE555 and AAA111 both', 'ERD: Dec 1', 4000)],
  FFF666: [mail('6', 'Booking FFF666 update', 'ERD Nov 20', 1500)],
};
const B = { AAA111: { booking_number: 'AAA111', erd_date: '11/09/2026', cutoff_date: '11/12/2026', etd: '11/16/2026' },
  BBB222: { booking_number: 'BBB222', erd_date: '11/16/2026', cutoff_date: '11/19/2026', etd: '11/23/2026' },
  CCC333: { booking_number: 'CCC333' }, DDD444: { booking_number: 'DDD444' }, EEE555: { booking_number: 'EEE555' },
  FFF666: { booking_number: 'FFF666', erd_date: '11/01/2026', dates_mail_at: new Date(2000).toISOString() } };
const X = { AAA111: { booking_number: 'AAA111', erd_date: '11/16/2026', port_cutoff_date: '11/19/2026', etd: '11/23/2026' },
  BBB222: { booking_number: 'BBB222', erd_date: '11/16/2026', port_cutoff_date: '11/19/2026', etd: '11/23/2026' },
  FFF666: { booking_number: 'FFF666', erd_date: '11/20/2026' } };
let extracted = [], applied = [];
(async () => {
  const run = (apply) => V.run({ bookings: B,
    search: async (bkg) => (MAILS[bkg] || []).map((x) => ({ id: x.id, x })),
    getInfo: async (m) => m.x.info,
    extract: async (t) => { extracted.push(t); const k = Object.keys(X).find((n) => t.includes('ERD') && true && MAILS[n] && MAILS[n].some((m) => m.info.body.startsWith(t.slice(0, 20)))); return X[k] || null; },
    apply: apply ? async (bkg, ch) => applied.push([bkg, ch.map((c) => c.field).join()]) : null });
  const r = await run(false);
  ck('differing booking found with old -> new', r.differs.some((d) => d.bkg === 'AAA111' && d.changes.some((c) => c.field === 'erd_date' && c.from === '11/09/2026' && c.to === '11/16/2026')), JSON.stringify(r.differs));
  ck('uses the NEWEST mail, not the older one', !extracted.some((t) => /ERD: Nov 1$/.test(t)));
  ck('quoted history not read', !extracted.some((t) => /Nov 9/.test(t)));
  ck('booking that already matches', r.same.some((s) => s.bkg === 'BBB222'));
  ck('PDF-only mail is flagged, not guessed', r.pdf_only.includes('CCC333'));
  ck('no mail is listed', r.no_mail.includes('DDD444'));
  ck('a mail naming two bookings is not judged', !r.differs.some((d) => d.bkg === 'EEE555') && r.skipped.includes('EEE555'));
  ck('mail older than one already applied is marked stale', r.differs.find((d) => d.bkg === 'FFF666') && r.differs.find((d) => d.bkg === 'FFF666').stale);
  ck('report mode writes nothing', applied.length === 0);
  await run(true);
  ck('apply writes AAA111 only, never the stale one', applied.length === 1 && applied[0][0] === 'AAA111', JSON.stringify(applied));
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
