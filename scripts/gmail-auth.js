// ── scripts/gmail-auth.js — ONE-TIME local OAuth bootstrap ───────────────────
// Run this on your laptop, not on the VM (the VM has no browser to complete
// the consent screen). Produces DATA_DIR/gmail-token.json. Copy that one file
// to the VM's DATA_DIR afterward — nothing else needs to move.
//
// Prereqs (Google Cloud Console, same project as the Gemini key or a new one):
//   1. APIs & Services → Library → enable "Gmail API"
//   2. APIs & Services → OAuth consent screen → External → add your Gmail as
//      a test user (keeps it in "Testing" mode — no Google review needed)
//   3. APIs & Services → Credentials → Create Credentials → OAuth client ID
//      → Application type: "Desktop app" → download the JSON
//   4. Save that file as DATA_DIR/gmail-credentials.json (default: ./data/gmail-credentials.json)
//
// Usage:
//   node scripts/gmail-auth.js
// Opens a URL to paste into your browser, then paste the resulting code back
// into the terminal.

const readline = require('readline');
const fs = require('fs');
const cfg = require('../config');
const { getOAuthClient, SCOPES } = require('../helpers/gmail');

async function main() {
    const oAuth2Client = getOAuthClient();
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',   // required to get a refresh_token
        prompt: 'consent',        // force refresh_token on repeat runs too
        scope: SCOPES,
    });

    console.log('\n1. Open this URL in a browser signed into the Gmail account Jarvis should read:\n');
    console.log(authUrl);
    console.log('\n2. Approve access, then paste the code Google gives you below.\n');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const code = await new Promise((resolve) => rl.question('Paste code here: ', (answer) => { rl.close(); resolve(answer.trim()); }));

    const { tokens } = await oAuth2Client.getToken(code);
    if (!tokens.refresh_token) {
        console.error('\nNo refresh_token returned. This happens if the account already granted access once before.');
        console.error('Fix: https://myaccount.google.com/permissions → remove access for this app → re-run this script.');
        process.exit(1);
    }

    fs.writeFileSync(cfg.GMAIL_TOKEN_FILE, JSON.stringify(tokens, null, 2));
    console.log(`\nSaved token to ${cfg.GMAIL_TOKEN_FILE}`);
    console.log('Copy this ONE file to the VM at the same relative path (DATA_DIR/gmail-token.json). Do not commit it.');
}

main().catch((err) => { console.error('Auth failed:', err.message); process.exit(1); });
