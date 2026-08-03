// ── helpers/gmail.js — Gmail OAuth clients + message/attachment fetch ────────
// OAuth2 (NOT a service account) — Gmail access requires each mailbox
// owner's explicit consent. Matches the pattern already used for WhatsApp
// session persistence: auth once, persist a token file under DATA_DIR
// (gitignored), reuse + auto-refresh on every boot.
//
// TWO SEPARATE ACCOUNTS, deliberately: reading (booking mail intake, mail
// search, finding a thread to reply to) happens against bose@edgemetals.com
// — that's where carrier booking confirmations actually land. Sending
// happens against apsara@edgemetals.com — outbound mail should visibly come
// from Apsara, not the shared read inbox. Same OAuth client/credentials
// file works for both (the app registration isn't account-specific); each
// account just needs its own consent + its own token file. Never merge
// these into one client — a bug in the read path must not be able to send
// as apsara, and a bug in the send path must not be able to read bose's
// inbox.
//
// Each token is generated ONCE by running scripts/gmail-auth.js --role=read
// (signed into bose) or --role=write (signed into apsara) locally (needs a
// browser for the consent screen), then deploying the resulting token file
// to the VM's DATA_DIR. The VM itself never runs the interactive flow.

const fs  = require('fs');
const cfg = require('../config');

const READ_SCOPES  = ['https://www.googleapis.com/auth/gmail.readonly'];
const WRITE_SCOPES = ['https://www.googleapis.com/auth/gmail.send'];

let readClient  = null;
let writeClient = null;

function readClientSecret() {
    if (!fs.existsSync(cfg.GMAIL_CREDENTIALS_FILE)) {
        throw new Error(`Gmail OAuth client secret missing: ${cfg.GMAIL_CREDENTIALS_FILE} (download from Google Cloud Console → APIs & Services → Credentials)`);
    }
    const raw = JSON.parse(fs.readFileSync(cfg.GMAIL_CREDENTIALS_FILE, 'utf8'));
    const block = raw.installed || raw.web;
    if (!block) throw new Error('Unrecognized OAuth client secret shape — expected "installed" or "web" key');
    return block;
}

function getOAuthClient() {
    const { client_id, client_secret, redirect_uris } = readClientSecret();
    const { google } = require('googleapis');
    return new google.auth.OAuth2(client_id, client_secret, (redirect_uris && redirect_uris[0]) || 'http://localhost:8081/oauth2callback');
}

function loadTokenFrom(tokenFile) {
    if (!fs.existsSync(tokenFile)) {
        throw new Error(`Gmail token missing: ${tokenFile}. Run scripts/gmail-auth.js --role=read|write, then copy the file here.`);
    }
    return JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
}

function buildClient(tokenFile, label) {
    const { google } = require('googleapis');
    const oAuth2Client = getOAuthClient();
    oAuth2Client.setCredentials(loadTokenFrom(tokenFile));

    // googleapis auto-refreshes the access_token using the refresh_token; persist
    // whatever comes back so a VM restart doesn't force re-auth.
    oAuth2Client.on('tokens', (tokens) => {
        try {
            const merged = { ...loadTokenFrom(tokenFile), ...tokens };
            fs.writeFileSync(tokenFile, JSON.stringify(merged, null, 2));
            console.log(`[GMAIL] ${label} token refreshed + persisted`);
        } catch (err) {
            console.error(`[GMAIL] Failed to persist refreshed ${label} token:`, err.message);
        }
    });

    return google.gmail({ version: 'v1', auth: oAuth2Client });
}

// bose@edgemetals.com — used everywhere Jarvis READS existing mail:
// emailWatcher.js's booking poll, searchMail, and finding the original
// message to reply to. Never used for sending.
function getGmailRead() {
    if (readClient) return readClient;
    readClient = buildClient(cfg.GMAIL_READ_TOKEN_FILE, 'read');
    return readClient;
}

// apsara@edgemetals.com — used ONLY by sendEmail() below. Narrow-scoped to
// gmail.send only, so this client can never read bose's inbox even if
// something here goes wrong.
function getGmailWrite() {
    if (writeClient) return writeClient;
    writeClient = buildClient(cfg.GMAIL_WRITE_TOKEN_FILE, 'write');
    return writeClient;
}

// ── Message helpers ───────────────────────────────────────────────────────────

function parseEmailDate(raw) {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? raw : d.toISOString();
}

// Walk the MIME tree: return { body, pdfParts }
function getEmailContent(payload) {
    let body = '';
    const pdfParts = [];
    (function walk(part) {
        const mtype = part.mimeType || '';
        if (mtype === 'text/plain' && part.body && part.body.data) {
            body += Buffer.from(part.body.data, 'base64').toString('utf8');
        } else if (mtype.includes('pdf') || /\.pdf$/i.test(part.filename || '')) {
            pdfParts.push(part);
        }
        (part.parts || []).forEach(walk);
    })(payload);
    return { body, pdfParts };
}

// Download one attachment, return { filename, base64 }
async function downloadAttachment(gmail, messageId, part) {
    const att = await gmail.users.messages.attachments.get({
        userId: 'me', messageId, id: part.body.attachmentId,
    });
    // Gmail returns web-safe base64 (- _ instead of + /) — convert for Gemini/Drive.
    const base64 = att.data.data.replace(/-/g, '+').replace(/_/g, '/');
    return { filename: part.filename || 'attachment.pdf', base64 };
}

// List message IDs matching a Gmail search query
async function listMessages(gmail, query, maxResults = 100) {
    const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults });
    return res.data.messages || [];
}

async function getMessage(gmail, id) {
    const res = await gmail.users.messages.get({ userId: 'me', id });
    return res.data;
}

// ── Sending ────────────────────────────────────────────────────────────────
// Requires a WRITE_SCOPES token for apsara@edgemetals.com — run
// scripts/gmail-auth.js --role=write once, signed into that account, and
// deploy the resulting GMAIL_WRITE_TOKEN_FILE to the VM. Until that token
// exists, getGmailWrite() throws "Gmail token missing" rather than silently
// no-op-ing.

function buildMimeMessage({ to, cc, bcc, subject, body, inReplyTo, references }) {
    const headers = [
        `To: ${to}`,
        `Subject: ${subject}`,
        'Content-Type: text/plain; charset="UTF-8"',
        'MIME-Version: 1.0',
    ];
    // Cc is a normal header — visible to every recipient. Bcc is ALSO just a
    // header in the raw RFC822 message; Gmail's send API strips it from the
    // copy that actually reaches To/Cc recipients while still delivering to
    // the Bcc'd address (standard SMTP-level behavior, not something this
    // code has to implement itself).
    if (cc) headers.push(`Cc: ${cc}`);
    if (bcc) headers.push(`Bcc: ${bcc}`);
    if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
    if (references) headers.push(`References: ${references}`);
    const raw = `${headers.join('\r\n')}\r\n\r\n${body}`;
    // base64url, no padding — same normalization Gmail's API expects on the way in.
    return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Sends via apsara@edgemetals.com. Caller is responsible for having already
// gotten manager confirmation — this function sends unconditionally the
// moment it's called, no confirmation gate of its own.
//
// threadId is deliberately NOT accepted here even though Gmail's send API
// supports it — a threadId is only valid within the SAME mailbox that owns
// the thread. Since reads happen on bose's account and sends happen on
// apsara's, a threadId captured from a read is meaningless (and Gmail will
// reject it) here. In-Reply-To/References are plain email headers, valid
// regardless of which account sends — those alone are enough for the
// RECIPIENT's mail client to thread this correctly.
async function sendEmail({ to, cc, bcc, subject, body, inReplyTo, references }) {
    const gmail = getGmailWrite();
    const requestBody = { raw: buildMimeMessage({ to, cc, bcc, subject, body, inReplyTo, references }) };
    const res = await gmail.users.messages.send({ userId: 'me', requestBody });
    return res.data; // { id, threadId, ... } — threadId here is apsara's own, unrelated to bose's copy
}

// "Zimex Line <bookings@zimexline.com>" → pull out the bare address; falls
// back to the raw string if there's no angle-bracket form.
function extractAddress(headerValue) {
    if (!headerValue) return null;
    const match = headerValue.match(/<([^>]+)>/);
    return match ? match[1] : headerValue.trim();
}

// To/Cc headers can hold multiple comma-separated recipients — find the one
// whose display name or address actually contains needle, not just the
// first one on the line. Comma-split respects quoted display names like
// "Doe, John" <a@b.com> so those don't get split mid-name.
function findMatchingAddress(headerValue, needle) {
    if (!headerValue) return null;
    const needleLower = needle.toLowerCase();
    const parts = headerValue.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    for (const part of parts) {
        if (part.toLowerCase().includes(needleLower)) return extractAddress(part.trim());
    }
    return null;
}

// Resolves a loosely-typed name/company to an address by searching From, Cc,
// AND To across the mailbox — not just mail they sent. A contact who's only
// ever been copied (Cc) or addressed (To) on someone else's thread still
// resolves, not just contacts who've emailed us directly.
async function findLatestFrom(gmail, nameOrDomain) {
    // The bare term (no operator) is the important addition here — from:/
    // cc:/to: all need nameOrDomain to match as its OWN token, which fails
    // whenever it's really just part of a longer domain word (e.g. "zimex"
    // inside "zimexglt.com" doesn't match from:zimex, even though a plain
    // text search for "zimex" WOULD find it via the signature block or
    // anywhere else it appears as a standalone word). Real incident: this
    // exact gap caused a genuine Zimex email to be reported as not found.
    const q = `(from:${nameOrDomain} OR cc:${nameOrDomain} OR to:${nameOrDomain} OR ${nameOrDomain})`;
    // maxResults bumped 5 -> 15 (2026-08-03): confirmed via
    // scripts/debugFindAddress.js on the real radmetals data that the From
    // pool is what correctly separates a real correspondent from a Cc'd
    // shared mailbox — but a 5-message sample is small enough that an
    // unlucky recent run (a flurry of Cc-only forwards, e.g.) could still
    // miss the real sender entirely. 15 is still a light, occasional-call
    // cost, not a hot loop, and meaningfully lowers that risk.
    const res = await gmail.users.messages.list({ userId: 'me', q, maxResults: 15 });
    const messages = res.data.messages || [];
    if (!messages.length) return null;

    // REAL BUG #1 (found 2026-08-03, live): this used to look at ONLY the
    // single most-recent matching message and return whatever address
    // matched there — "radmetals" resolved to radmetals@radmetals.com
    // instead of brian@radmetals.com, the address Apsara has actually been
    // corresponding with. First fix: scan ALL matched messages (up to 5)
    // and pick whichever address shows up MOST OFTEN across From/Cc/To.
    //
    // REAL BUG #2 (found 2026-08-03, same live incident, fix #1 was
    // insufficient): radmetals@radmetals.com turned out to be a shared
    // "Docs RadMetals" mailbox that gets Cc'd on nearly every thread with
    // that company. Raw frequency across From+Cc+To let that shared inbox
    // out-vote brian@radmetals.com, who only appears as the actual sender
    // (From) on a subset of messages. A Cc'd shared mailbox is NOT "the
    // established correspondent" no matter how often it's copied.
    //
    // Fix: From-matches and Cc/To-matches are tallied in SEPARATE pools.
    // The winner is decided from the From pool if it has anything at all;
    // Cc/To is only consulted as a fallback when nobody ever appears as an
    // actual sender in the sample. Within one message, only the
    // highest-priority header that matches counts (From > Cc > To), so one
    // message can never contribute to both pools.
    const fromCounts = new Map();
    const otherCounts = new Map();
    for (const m of messages) {
        let msg;
        try {
            msg = await getMessage(gmail, m.id);
        } catch (err) {
            console.warn('[GMAIL] findLatestFrom: failed to read a matched message:', err.message);
            continue;
        }
        const headers = msg.payload.headers || [];
        const get = (name) => headers.find((h) => h.name === name)?.value || '';
        for (const headerName of ['From', 'Cc', 'To']) {
            const found = findMatchingAddress(get(headerName), nameOrDomain);
            if (found) {
                const key = found.toLowerCase();
                const pool = headerName === 'From' ? fromCounts : otherCounts;
                pool.set(key, (pool.get(key) || 0) + 1);
                break;
            }
        }
    }

    const pickBest = (pool) => {
        let best = null, bestCount = 0;
        for (const [addr, count] of pool) {
            if (count > bestCount) { best = addr; bestCount = count; }
        }
        return best;
    };

    const result = fromCounts.size ? pickBest(fromCounts) : pickBest(otherCounts);
    console.log(
        `[GMAIL] findLatestFrom("${nameOrDomain}") — from:[${[...fromCounts].map(([a, c]) => `${a}=${c}`).join(', ')}] ` +
        `other:[${[...otherCounts].map(([a, c]) => `${a}=${c}`).join(', ')}] → ${result || '(none)'}`
    );
    return result;
}

// ── Sent-mail Cc pattern detection ──────────────────────────────────────────
// Built 2026-08-03 per Apsara: "when I mail say T, there is always same type
// of people I am cc'ing" — she wants that noticed and remembered, not
// re-typed every time. Searches HER OWN sent mail (in:sent) to a given
// address, and only calls it a real "pattern" — never a one-off — if a Cc
// address shows up in EVERY sampled sent message that had a Cc at all.
// Caller (workflow/actions.js) always confirms with her before saving
// anything found here; this function only detects, never persists.
//
// Uses getGmailRead() — currently pointed at apsara@edgemetals.com per her
// "read and write both from apsara for now" instruction, which is exactly
// the account whose Sent folder actually holds her own outbound history.
// If read is ever re-split back to bose@edgemetals.com, this stops finding
// anything useful (bose's Sent folder isn't Apsara's correspondence) — worth
// remembering if that split gets reinstated later.
async function detectCcPattern(gmail, toAddress, minSamples = 2, maxResults = 8) {
    if (!toAddress) return null;
    const q = `in:sent to:${toAddress}`;
    const res = await gmail.users.messages.list({ userId: 'me', q, maxResults });
    const messages = res.data.messages || [];
    if (messages.length < minSamples) return null; // not enough history to call anything a "pattern"

    const ccLists = [];
    for (const m of messages) {
        const full = await getMessage(gmail, m.id);
        const headers = full.payload.headers || [];
        const ccHeader = headers.find((h) => h.name === 'Cc')?.value || '';
        if (!ccHeader) continue; // messages with no Cc at all don't count either way
        const addrs = ccHeader.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
            .map((p) => extractAddress(p.trim()))
            .filter(Boolean)
            .map((a) => a.toLowerCase());
        if (addrs.length) ccLists.push(addrs);
    }
    if (ccLists.length < minSamples) return null; // not enough Cc'd samples to be confident

    // "Always" = present in every single sample that had a Cc — one-off
    // inclusions (a person cc'd on just one of several emails) don't count.
    const [first, ...rest] = ccLists;
    const consistent = first.filter((addr) => rest.every((l) => l.includes(addr)));
    return consistent.length ? consistent : null;
}

// Searches a term across From/Cc/To/bare-word (same query shape as
// findLatestFrom) and returns, per matched message, its headers PLUS a
// per-address tally of how often that address showed up in each role.
// Built 2026-08-03 as the one shared source of truth for this — both
// scripts/debugFindAddress.js (human-readable dump for manual review) and
// scripts/learnDomain.js (auto-propose primary/secondary/shared roles for a
// domain-tree contact group) need the EXACT same counting logic; having two
// separate copies is exactly the kind of drift that caused real bugs earlier
// today (findLatestFrom's old single-message-only logic silently disagreeing
// with what a human would see by actually reading the mailbox).
async function tallyAddressesForTerm(gmail, term, maxResults = 50) {
    const q = `(from:${term} OR cc:${term} OR to:${term} OR ${term})`;
    const res = await gmail.users.messages.list({ userId: 'me', q, maxResults });
    const rawMessages = res.data.messages || [];

    const messages = [];
    const tally = new Map(); // lowercased address -> { from, to, cc }

    for (const m of rawMessages) {
        let msg;
        try {
            msg = await getMessage(gmail, m.id);
        } catch (err) {
            console.warn(`[GMAIL] tallyAddressesForTerm: failed to read a matched message: ${err.message}`);
            continue;
        }
        const headers = msg.payload.headers || [];
        const get = (name) => headers.find((h) => h.name === name)?.value || '';
        const date = get('Date'), subject = get('Subject'), from = get('From'), to = get('To'), cc = get('Cc');
        messages.push({ date, subject, from, to, cc });

        for (const [role, headerValue] of [['from', from], ['to', to], ['cc', cc]]) {
            if (!headerValue) continue;
            for (const part of headerValue.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
                if (!part.toLowerCase().includes(term.toLowerCase())) continue;
                const addr = (extractAddress(part.trim()) || part.trim()).toLowerCase();
                if (!tally.has(addr)) tally.set(addr, { from: 0, to: 0, cc: 0 });
                tally.get(addr)[role]++;
            }
        }
    }
    return { query: q, messages, tally };
}

// Splits a raw To/Cc header value into individual bare addresses. Comma-
// split respects quoted display names (same regex as findMatchingAddress
// above) so "Doe, John" <a@b.com>, "Roe, Jane" <c@d.com> doesn't get split
// mid-name. Used by draftReplyForConfirm to preserve an original thread's
// Cc list on a real reply.
function parseAddressList(headerValue) {
    if (!headerValue) return [];
    return headerValue.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
        .map((part) => extractAddress(part.trim()))
        .filter(Boolean);
}

// The authenticated account's own address (apsara@edgemetals.com today) —
// fetched once and cached for the process lifetime rather than hardcoded in
// config, so it stays correct automatically if the account ever changes.
// Used to make sure a reply never ends up cc'ing yourself.
let _myEmailAddress = null;
async function getMyEmailAddress(gmail) {
    if (_myEmailAddress) return _myEmailAddress;
    const res = await gmail.users.getProfile({ userId: 'me' });
    _myEmailAddress = res.data.emailAddress;
    return _myEmailAddress;
}

module.exports = {
    READ_SCOPES, WRITE_SCOPES, getOAuthClient, getGmailRead, getGmailWrite,
    parseEmailDate, getEmailContent, downloadAttachment, listMessages, getMessage,
    sendEmail, findLatestFrom, detectCcPattern, parseAddressList, getMyEmailAddress,
    tallyAddressesForTerm,
};