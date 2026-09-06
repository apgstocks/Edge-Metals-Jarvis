// ── tests/reply-in-thread.js ────────────────────────────────────────────────
// run: node tests/reply-in-thread.js
//
// Apsara, 2026-09-06: "if a mail is detected, if i say reply to something — i
// want an in thread reply."
//
// THE BUG. replyWatch flags an email and records its exact Gmail id on the
// tracked item. replyToDigestItem then threw that away and passed only the
// SENDER'S ADDRESS to draftReplyForConfirm, which — with no subject hint —
// searches `from:<address>` and takes the most RECENT message. A digest is
// routinely hours old and chase-ups run for days, so any newer mail from the
// same person won and the reply was threaded onto THAT conversation.
//
// It produced a reply that was correctly threaded onto the wrong email, which
// is worse than an unthreaded one: it looks right to the recipient, who then
// reads an answer to a question under a subject about something else.
//
// The fixture below is exactly that situation — two emails from one sender,
// the digest flagged the OLDER one, a sender search returns the NEWER one.
// Against the code before the fix this file scores 0/5.
const os = require('os'), fsb = require('fs'), pb = require('path');
process.env.DATA_DIR = fsb.mkdtempSync(pb.join(os.tmpdir(), 'jarvis-thread-'));
const Module = require('module');
const R = (p) => pb.join(__dirname, '..', p);

let pass = 0, fail = 0;
const ck = (l, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w);
  ok ? (pass++, console.log('  PASS  ' + l)) : (fail++, console.log(`  FAIL  ${l}\n    got:  ${JSON.stringify(g)}\n    want: ${JSON.stringify(w)}`)); };

// Two emails from the SAME sender. The digest flagged the OLDER one (#1).
// A sender search returns the NEWER one first — that is the bug.
const FLAGGED = 'msg-flagged-OLDER';
const NEWER   = 'msg-newer-UNRELATED';
const MAIL = {
  [FLAGGED]: { id: FLAGGED, payload: { headers: [
    { name: 'Message-ID', value: '<flagged@raj.com>' },
    { name: 'Subject', value: 'Rate for 5 containers to Busan' },
    { name: 'From', value: 'Raj <raj@metals.com>' },
    { name: 'Date', value: 'Mon, 1 Sep 2026 09:00:00 -0700' },
  ], body: { data: Buffer.from('What is your rate?').toString('base64') } } },
  [NEWER]: { id: NEWER, payload: { headers: [
    { name: 'Message-ID', value: '<newer@raj.com>' },
    { name: 'Subject', value: 'Office closed Friday' },
    { name: 'From', value: 'Raj <raj@metals.com>' },
    { name: 'Date', value: 'Fri, 5 Sep 2026 09:00:00 -0700' },
  ], body: { data: Buffer.from('FYI we are closed.').toString('base64') } } },
};

let searchCalls = 0;
const orig = Module._load;
Module._load = function (req, parent) {
  const r = orig.apply(this, arguments);
  if (req === '../helpers/gmail' || (req && req.endsWith && req.endsWith('helpers/gmail'))) {
    return {
      ...r,
      getGmailRead: () => ({ __box: 'bose' }),
      getGmailSenderRead: () => ({ __box: 'sender' }),
      getMyEmailAddress: async () => 'apsara@edgemetals.com',
      // The search a sender-only reply would use — returns the NEWER mail.
      listMessages: async () => { searchCalls++; return [{ id: NEWER }]; },
      getMessage: async (client, id) => MAIL[id] || null,
      getEmailContent: (payload) => ({
        body: Buffer.from((payload.body && payload.body.data) || '', 'base64').toString(),
        pdfParts: [], wasHtmlOnly: false,
      }),
      parseAddressList: () => [],
      sendEmail: async () => ({ id: 'sent' }),
    };
  }
  if (req === '../helpers/gemini' || (req && req.endsWith && req.endsWith('helpers/gemini'))) {
    return { ...r, callGeminiJSON: async () => ({ body: 'Our rate is $675/MT. — Edge Metals Inc.' }) };
  }
  return r;
};

const actions = require(R('workflow/actions'));
const rw = require(R('workflow/replyWatch'));

// Seed the digest so "reply to 1" resolves to the OLDER, flagged email.
const store = rw.loadStore();
store.lastDigest = [{ id: FLAGGED, threadId: 't1', from: 'raj@metals.com',
                      fromName: 'Raj', subject: 'Rate for 5 containers to Busan' }];
store.lastDigestAt = new Date().toISOString();

(async () => {
await rw.saveStore(store);
console.log('\n=== "reply to 1" must thread onto the FLAGGED email ===');

let staged = null;
const SENT_TO_HER = [];
actions.init({
  sendMessage: async (_c, t) => { SENT_TO_HER.push(t); return true; },
  sendToManager: async (t) => { SENT_TO_HER.push(t); return true; },
  sendToTeam: async () => true,
  pushAlert: async () => true,
});

// Capture what gets staged for confirmation.
await actions.replyToDigestItem('chat1', 1, 'our rate is 675', 'reply to 1: our rate is 675');
// setPending is internal to actions.js and persists to brain.json, so the
// staged reply is read back from there — the real artefact, not a stub.
const brain = JSON.parse(fsb.readFileSync(pb.join(process.env.DATA_DIR, 'brain.json'), 'utf8'));
staged = (brain.pending_actions || {})['chat1'] || null;

if (!staged) {
  console.log('  FAIL  nothing was staged for confirmation');
  console.log('  --- what Jarvis said instead ---');
  SENT_TO_HER.forEach((t) => console.log('      ' + String(t).split('\n')[0]));
  fail++;
}
else {
  ck('threads onto the FLAGGED email, not the newest from that sender',
     staged.inReplyTo, '<flagged@raj.com>');
  ck('subject is the flagged thread\'s, prefixed Re:',
     staged.subject, 'Re: Rate for 5 containers to Busan');
  ck('References carries the flagged Message-ID',
     (staged.references || '').includes('<flagged@raj.com>'), true);
  ck('does NOT thread onto the unrelated newer email',
     (staged.inReplyTo || '') === '<newer@raj.com>', false);
  ck('no sender-search was needed at all', searchCalls, 0);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASHED:', e); process.exit(1); });
