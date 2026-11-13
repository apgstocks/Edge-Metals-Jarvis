// Bose is never Cc'd/Bcc'd on any mail sent through sendEmail; a TO (the yard
// report) is untouched. Real sendEmail + real MIME builder, stubbed Gmail client.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-'));
const gmail = require('../helpers/gmail');
const nc = require('../helpers/neverCc');
let raw = null;
gmail.getGmailWrite = () => ({ users: { messages: { send: async ({ requestBody }) => { raw = Buffer.from(requestBody.raw, 'base64').toString('utf8'); return { data: { id: 'x', threadId: 't' } }; } }, getProfile: async () => ({ data: { emailAddress: 'me@x.com' } }) } });
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) pass++; else { fail++; console.log('FAIL', n, d || ''); } };
(async () => {
  await gmail.sendEmail({ to: 'cust@acme.com', cc: 'Bose <BOSE@edgemetals.com>, ops@edgemetals.com', bcc: 'bose@edgemetals.com', subject: 's', body: 'b' });
  ck('Cc keeps others, drops Bose', /^Cc: ops@edgemetals\.com\s*$/m.test(raw), raw);
  ck('Bcc line removed when only Bose', !/^Bcc:/m.test(raw), raw);
  await gmail.sendEmail({ to: 'bose@edgemetals.com, apsara@edgemetals.com', subject: 'Yard report', body: 'b' });
  ck('yard report TO still includes Bose', /^To: bose@edgemetals\.com, apsara@edgemetals\.com/m.test(raw), raw);
  await gmail.sendEmail({ to: 'a@b.com', cc: ['bose@edgemetals.com'], subject: 's', body: 'b' });
  ck('array cc of only Bose -> no Cc header', !/^Cc:/m.test(raw), raw);
  ck('strip leaves empty/null alone', nc.strip('') === '' && nc.strip(null) === null);
  // settings can extend the list
  const cfg = require('../config'); const g = cfg.getSettings; cfg.getSettings = () => ({ ...g(), never_cc: 'zed@x.com' });
  ck('settings never_cc adds addresses', nc.strip('zed@x.com, ok@x.com') === 'ok@x.com');
  cfg.getSettings = g;
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
