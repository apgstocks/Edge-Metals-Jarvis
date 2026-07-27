// ── helpers/gmail.js — Gmail OAuth client + message/attachment fetch ─────────
// OAuth2 (NOT a service account) — Gmail read access requires the mailbox
// owner's explicit consent. Service accounts only work here with Workspace
// domain-wide delegation, which this Gmail account is not set up for (that's
// admin-console work, not a code change). Matches the pattern already used
// for WhatsApp session persistence: auth once, persist a token file under
// DATA_DIR (gitignored), reuse + auto-refresh on every boot.
//
// Token is generated ONCE by running scripts/gmail-auth.js locally (needs a
// browser for the consent screen) and deploying the resulting token file to
// the VM's DATA_DIR. The VM itself never runs the interactive flow.

const fs  = require('fs');
const cfg = require('../config');

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

let gmailClient = null;

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

function loadToken() {
    if (!fs.existsSync(cfg.GMAIL_TOKEN_FILE)) {
        throw new Error(`Gmail token missing: ${cfg.GMAIL_TOKEN_FILE}. Run scripts/gmail-auth.js locally, then copy the file here.`);
    }
    return JSON.parse(fs.readFileSync(cfg.GMAIL_TOKEN_FILE, 'utf8'));
}

function getGmail() {
    if (gmailClient) return gmailClient;
    const { google } = require('googleapis');
    const oAuth2Client = getOAuthClient();
    oAuth2Client.setCredentials(loadToken());

    // googleapis auto-refreshes the access_token using the refresh_token; persist
    // whatever comes back so a VM restart doesn't force re-auth.
    oAuth2Client.on('tokens', (tokens) => {
        try {
            const merged = { ...loadToken(), ...tokens };
            fs.writeFileSync(cfg.GMAIL_TOKEN_FILE, JSON.stringify(merged, null, 2));
            console.log('[GMAIL] Token refreshed + persisted');
        } catch (err) {
            console.error('[GMAIL] Failed to persist refreshed token:', err.message);
        }
    });

    gmailClient = google.gmail({ version: 'v1', auth: oAuth2Client });
    return gmailClient;
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

module.exports = {
    SCOPES, getOAuthClient, getGmail,
    parseEmailDate, getEmailContent, downloadAttachment, listMessages, getMessage,
};
