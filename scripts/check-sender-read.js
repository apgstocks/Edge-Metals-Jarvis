// Prints whether the sender-read Gmail token (apsara@, read scope) is installed. Needed so payment follow-ups can
// find the invoice thread and reply inside it. Read-only.   node scripts/check-sender-read.js
let ok = false;
try { ok = !!require('../helpers/gmail').getGmailSenderRead(); } catch (e) { console.log('error: ' + e.message); }
console.log(ok ? 'SENDER-READ: installed - payment follow-ups can reply in the invoice thread'
    : 'SENDER-READ: MISSING - follow-ups will go as NEW emails. Fix: node scripts/gmail-auth.js --role=sender-read (sign in as apsara@edgemetals.com)');
