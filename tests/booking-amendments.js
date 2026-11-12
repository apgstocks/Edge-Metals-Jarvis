// A carrier date-change mail with NO PDF updates the booking Jarvis holds.
// 2026-11-13: EBKG19299518, ERD Nov 16 / cutoff Nov 19 / ETD Nov 23.
const fs = require('fs'), os = require('os'), path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-'));
process.env.DATA_DIR = TMP;
const cfg = require('../config');
cfg.BOOKINGS_FILE = path.join(TMP, 'bookings.json');
cfg.SETTINGS_FILE = path.join(TMP, 'settings.json');
cfg.EMAIL_PROCESSED_FILE = path.join(TMP, 'processed.json');
cfg.WORKFLOW_FILE && (cfg.WORKFLOW_FILE = path.join(TMP, 'workflow.json'));
cfg.ALERTS_FILE && (cfg.ALERTS_FILE = path.join(TMP, 'alerts.json'));
fs.writeFileSync(cfg.BOOKINGS_FILE, JSON.stringify({
  EBKG19299518: { booking_number: 'EBKG19299518', erd_date: '11/09/2026', cutoff_date: '11/12/2026', etd: '11/16/2026' },
  OTHER111: { booking_number: 'OTHER111', erd_date: '11/01/2026', cutoff_date: '11/05/2026', etd: '11/10/2026' },
}));
fs.writeFileSync(cfg.SETTINGS_FILE, '{}'); fs.writeFileSync(cfg.EMAIL_PROCESSED_FILE, '[]');
cfg.getSettings = () => ({ gmail_watch_enabled: true });
const gmail = require('../helpers/gmail');
const gem = require('../helpers/gemini');
const tracker = require('../helpers/bookingTracker');
const audit = require('../helpers/auditlog');
tracker.syncBookingToSheet = async () => true;
audit.appendAuditLog = async () => true;
let MAIL = [], QUERIES = [];
gmail.getGmailRead = () => ({});
gmail.listMessages = async (_g, q) => { QUERIES.push(q); return MAIL.map((m) => ({ id: m.id })); };
gmail.getMessage = async (_g, id) => MAIL.find((m) => m.id === id);
gmail.downloadAttachment = async () => ({ base64: 'x', filename: 'x.pdf' });
let EXTRACT = {};
gem.extractPdfFields = async () => null; gem.classifyDocument = async () => null;
gem.extractBookingFieldsFromText = async (t) => { EXTRACT.__text = t; return EXTRACT; };
const ew = require('../workflow/emailWatcher');
const sent = []; ew.init({ sendToManager: async (m) => sent.push(m) });
const mk = (id, subject, body, at, extra = []) => ({ id, internalDate: String(at),
  payload: { headers: [{ name: 'Subject', value: subject }, { name: 'From', value: 'cs@unitaslogistix.com' }],
    mimeType: 'multipart/mixed', parts: [{ mimeType: 'text/plain', body: { data: Buffer.from(body).toString('base64') } }, ...extra] } });
const BODY = `Hi,\nDue to Change in Vessel Arrival Date, please note the following changes:\nVessel: MSC SABRINA MC645R\nERD: Nov 16th 2026\nDoc cut off: Nov 19th 2026 1600 hrs\nCargo cut off: Nov 19th 2026 1600 hrs\nETD: Nov 23rd 2026\n\nOn Tue, Nov 10 someone wrote:\n> ERD: Nov 9th 2026\n> Cargo cut off: Nov 12th`;
const SUBJ = 'Booking EBKG19299518 // Los Angeles to Mangalore, IN // 01 X 20\' // MSC//Doc cut off: Nov 19th 2026';
const NEW = { booking_number: 'EBKG19299518', erd_date: '11/16/2026', port_cutoff_date: '11/19/2026', doc_cutoff_date: '11/19/2026', etd: '11/23/2026' };
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) pass++; else { fail++; console.log('FAIL', n, d || ''); } };
const bk = () => JSON.parse(fs.readFileSync(cfg.BOOKINGS_FILE));
(async () => {
  MAIL = [mk('m1', SUBJ, BODY, 2000000000000)]; EXTRACT = { ...NEW };
  await ew.run();
  let b = bk().EBKG19299518;
  ck('ERD updated', b.erd_date === '11/16/2026', b.erd_date);
  ck('cutoff updated from cargo/port cut off', b.cutoff_date === '11/19/2026', b.cutoff_date);
  ck('ETD updated', b.etd === '11/23/2026', b.etd);
  ck('other booking untouched', bk().OTHER111.erd_date === '11/01/2026');
  ck('quoted history was not sent to the extractor', !/Nov 9th|Nov 12th/.test(EXTRACT.__text), EXTRACT.__text);
  ck('search is by booking number, not keywords', /"EBKG19299518"/.test(QUERIES[QUERIES.length - 1]) && /-from:me/.test(QUERIES[QUERIES.length - 1]), QUERIES.join('|'));
  ck('manager told old → new', sent.some((m) => /EBKG19299518/.test(m) && /11\/09\/2026 → 11\/16\/2026/.test(m)), sent.join('\n'));
  // same mail again: judged once
  const n0 = sent.length; await ew.run();
  ck('same mail is not re-applied or re-announced', sent.length === n0);
  // an OLDER mail arriving later must not roll dates back
  MAIL = [mk('m2', SUBJ, BODY, 1900000000000)]; EXTRACT = { ...NEW, erd_date: '11/01/2026' };
  await ew.run();
  ck('older mail does not roll back', bk().EBKG19299518.erd_date === '11/16/2026', bk().EBKG19299518.erd_date);
  // two active bookings named -> ambiguous -> nothing
  MAIL = [mk('m3', SUBJ + ' OTHER111', BODY, 2100000000000)]; EXTRACT = { ...NEW, erd_date: '12/01/2026' };
  await ew.run();
  ck('mail naming two bookings does nothing', bk().EBKG19299518.erd_date === '11/16/2026');
  // a PDF mail is left to the PDF watcher
  MAIL = [mk('m4', SUBJ, BODY, 2200000000000, [{ mimeType: 'application/pdf', filename: 'a.pdf', body: { attachmentId: 'a' } }])]; EXTRACT = { ...NEW, erd_date: '12/02/2026' };
  await ew.run();
  ck('PDF mails are skipped by this pass', bk().EBKG19299518.erd_date === '11/16/2026');
  // an unknown booking is never created
  MAIL = [mk('m5', 'Booking ZZZ999 dates', 'ERD Nov 1', 2300000000000)]; EXTRACT = { booking_number: 'ZZZ999', erd_date: '11/01/2026' };
  await ew.run();
  ck('unknown booking not created', !bk().ZZZ999);
  // a mail whose extracted number disagrees is ignored
  MAIL = [mk('m6', SUBJ, BODY, 2400000000000)]; EXTRACT = { ...NEW, booking_number: 'DIFFERENT1', erd_date: '12/03/2026' };
  await ew.run();
  ck('extractor naming another booking is ignored', bk().EBKG19299518.erd_date === '11/16/2026');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
