// ── scripts/gmail-auth.js — ONE-TIME local OAuth bootstrap ───────────────────
// Run this on your laptop, not on the VM (the VM has no browser to complete
// the consent screen). Copy the resulting token file(s) to the VM's
// DATA_DIR afterward — nothing else needs to move.
//
// helpers/gmail.js keeps read and write as two SEPARATE clients/token files
// on purpose (see that file for why) — but which Google account each one is
// signed into is just a deploy-time choice, not something hardcoded in code.
//
//   --role=both   ONE consent flow, one account, gets both scopes at once,
//                 writes the SAME token to both GMAIL_READ_TOKEN_FILE and
//                 GMAIL_WRITE_TOKEN_FILE. Use this for now — read and write
//                 both against apsara@edgemetals.com until a separate read
//                 account (e.g. bose@edgemetals.com) is actually ready.
//   --role=read   Sign into whichever account should be the READ-ONLY
//                 source (booking mail intake, mail search, reply lookup).
//                 Use this later to point reading at a different account
//                 than writing — no code changes needed when that day comes,
//                 just re-run this against the new account.
//   --role=write  Sign into whichever account should SEND outbound mail.
//
// Prereqs (Google Cloud Console, same project as the Gemini key or a new one):
//   1. APIs & Services → Library → enable "Gmail API"
//   2. APIs & Services → OAuth consent screen → External → add whichever
//      Gmail account(s) you're about to authorize as test users (keeps it
//      in "Testing" mode — no Google review needed, but each account needs
//      to be listed before its own consent flow will work)
//   3. APIs & Services → Credentials → Create Credentials → OAuth client ID
//      → Application type: "Desktop app" → download the JSON
//   4. Save that file as DATA_DIR/gmail-credentials.json (default: ./data/gmail-credentials.json)
//
// Usage:
//   node scripts/gmail-auth.js --role=both     (read+write, one account — current setup)
//   node scripts/gmail-auth.js --role=read     (read only, sign into the read account)
//   node scripts/gmail-auth.js --role=write    (write only, sign into the write account)
// Opens a URL to paste into your browser, then paste the resulting code back
// into the terminal.

const readline = require('readline');
const fs = require('fs');
const cfg = require('../config');
const { getOAuthClient, READ_SCOPES, WRITE_SCOPES } = require('../helpers/gmail');

function parseRole() {
    const arg = process.argv.find((a) => a.startsWith('--role='));
    const role = arg ? arg.split('=')[1] : null;
    if (role !== 'read' && role !== 'write' && role !== 'both' && role !== 'sender-read') {
        console.error('Usage: node scripts/gmail-auth.js --role=both         (one account, read+write — use this for now)');
        console.error('   or: node scripts/gmail-auth.js --role=read         (read-only, a separate account — e.g. bose@)');
        console.error('   or: node scripts/gmail-auth.js --role=write        (write-only, a separate account — e.g. apsara@)');
        console.error('   or: node scripts/gmail-auth.js --role=sender-read  (READ access to the SAME account as --role=write —');
        console.error('                                                       e.g. apsara@ — so threads Apsara starts herself can');
        console.error('                                                       be found too, not just carrier mail in bose@\'s inbox)');
        process.exit(1);
    }
    return role;
}

async function main() {
    const role      = parseRole();
    const scopes    = role === 'both' ? [...READ_SCOPES, ...WRITE_SCOPES] : role === 'write' ? WRITE_SCOPES : READ_SCOPES; // 'read' and 'sender-read' both just need READ_SCOPES
    const tokenFiles = role === 'both'        ? [cfg.GMAIL_READ_TOKEN_FILE, cfg.GMAIL_WRITE_TOKEN_FILE]
                      : role === 'read'        ? [cfg.GMAIL_READ_TOKEN_FILE]
                      : role === 'sender-read' ? [cfg.GMAIL_SENDER_READ_TOKEN_FILE]
                      : [cfg.GMAIL_WRITE_TOKEN_FILE];
    const account   = role === 'both'        ? 'the ONE account that should both read and send (e.g. apsara@edgemetals.com)'
                     : role === 'read'        ? 'whichever account should be the READ-ONLY source (booking mail intake)'
                     : role === 'sender-read' ? 'the SAME account you used for --role=write (e.g. apsara@edgemetals.com) — this just adds read access on top'
                     : 'whichever account should SEND outbound mail';

    const oAuth2Client = getOAuthClient();
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',   // required to get a refresh_token
        prompt: 'consent',        // force refresh_token on repeat runs too
        scope: scopes,
    });

    console.log(`\n1. Open this URL in a browser signed into ${account}:\n`);
    console.log(authUrl);
    console.log('\n2. Approve access, then paste the code Google gives you below.\n');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const code = await new Promise((resolve) => rl.question('Paste code here: ', (answer) => { rl.close(); resolve(answer.trim()); }));

    const { tokens } = await oAuth2Client.getToken(code);
    if (!tokens.refresh_token) {
        console.error('\nNo refresh_token returned. This happens if this account already granted access once before.');
        console.error('Fix: https://myaccount.google.com/permissions → remove access for this app → re-run this script.');
        process.exit(1);
    }

    // --role=both writes the IDENTICAL token content to both files — it's
    // one real OAuth grant (one account, both scopes together), just saved
    // under two filenames because getGmailRead()/getGmailWrite() each load
    // their own file. Nothing stops them from being the same bytes.
    for (const tokenFile of tokenFiles) {
        fs.writeFileSync(tokenFile, JSON.stringify(tokens, null, 2));
        console.log(`\nSaved token to ${tokenFile}`);
    }
    console.log(`\nCopy ${tokenFiles.length > 1 ? 'these files' : 'this file'} to the VM at the same relative path(s) under DATA_DIR. Do not commit ${tokenFiles.length > 1 ? 'them' : 'it'}.`);
}

main().catch((err) => { console.error('Auth failed:', err.message); process.exit(1); });