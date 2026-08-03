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
    const res = await gmail.users.messages.list({ userId: 'me', q, maxResults: 5 });
    const messages = res.data.messages || [];
    if (!messages.length) return null;
    const msg = await getMessage(gmail, messages[0].id);
    const headers = msg.payload.headers || [];
    const get = (name) => headers.find((h) => h.name === name)?.value || '';

    // Prefer From (the contact IS the sender) over Cc over To — matches the
    // priority a human would use: someone who sent it directly is more "them"
    // than someone merely copied or addressed alongside others.
    for (const headerName of ['From', 'Cc', 'To']) {
        const found = findMatchingAddress(get(headerName), nameOrDomain);
        if (found) return found;
    }
    return null;
}

module.exports = {
    READ_SCOPES, WRITE_SCOPES, getOAuthClient, getGmailRead, getGmailWrite,
    parseEmailDate, getEmailContent, downloadAttachment, listMessages, getMessage,
    sendEmail, findLatestFrom,
};