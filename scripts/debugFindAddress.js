// scripts/debugFindAddress.js — one-off diagnostic, NOT wired into the app.
// Dumps EVERY message where a name/domain hits From, To, or Cc (or appears
// as a bare word anywhere), plus a per-address tally broken down by role.
// Built 2026-08-03 to actually see the raw radmetals data instead of
// guessing at findLatestFrom's scoring from pm2 log lines alone.
//
// Run on the VM (it already has GMAIL_READ_TOKEN_FILE set up there):
//   node scripts/debugFindAddress.js radmetals
//
// Safe to run any time — read-only, makes no changes, sends no mail.

const { getGmailRead, getMessage } = require('../helpers/gmail');

function extractAddress(headerValue) {
    if (!headerValue) return null;
    const match = headerValue.match(/<([^>]+)>/);
    return match ? match[1] : headerValue.trim();
}

function splitAddresses(headerValue) {
    if (!headerValue) return [];
    return headerValue.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((p) => p.trim());
}

async function main() {
    const term = process.argv[2];
    if (!term) {
        console.error('Usage: node scripts/debugFindAddress.js <name-or-domain>');
        process.exit(1);
    }

    const gmail = getGmailRead();
    const q = `(from:${term} OR cc:${term} OR to:${term} OR ${term})`;
    const res = await gmail.users.messages.list({ userId: 'me', q, maxResults: 50 });
    const messages = res.data.messages || [];

    console.log(`Query: ${q}`);
    console.log(`${messages.length} matching messages (up to 50 fetched)\n`);

    // address (lowercased) -> { from, to, cc } hit counts
    const tally = new Map();

    for (const m of messages) {
        let msg;
        try {
            msg = await getMessage(gmail, m.id);
        } catch (err) {
            console.warn(`[skip] failed to read message ${m.id}: ${err.message}`);
            continue;
        }
        const headers = msg.payload.headers || [];
        const get = (name) => headers.find((h) => h.name === name)?.value || '';
        const date = get('Date');
        const subject = get('Subject');
        const from = get('From');
        const to = get('To');
        const cc = get('Cc');

        console.log(`--- ${date}`);
        console.log(`Subject: ${subject}`);
        console.log(`From: ${from}`);
        if (to) console.log(`To: ${to}`);
        if (cc) console.log(`Cc: ${cc}`);
        console.log('');

        for (const [role, headerValue] of [['from', from], ['to', to], ['cc', cc]]) {
            for (const part of splitAddresses(headerValue)) {
                if (!part.toLowerCase().includes(term.toLowerCase())) continue;
                const addr = (extractAddress(part) || part).toLowerCase();
                if (!tally.has(addr)) tally.set(addr, { from: 0, to: 0, cc: 0 });
                tally.get(addr)[role]++;
            }
        }
    }

    console.log(`=== TALLY — every address containing "${term}", by role ===`);
    if (!tally.size) {
        console.log('(none found)');
        return;
    }
    for (const [addr, counts] of tally) {
        console.log(`${addr}:  From=${counts.from}  To=${counts.to}  Cc=${counts.cc}`);
    }
}

main().catch((err) => {
    console.error('FAILED:', err);
    process.exit(1);
});
