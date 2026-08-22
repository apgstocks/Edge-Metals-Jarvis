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
let senderReadClient = null;

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

// apsara@edgemetals.com AGAIN, but with READ scope this time — a separate
// token from getGmailWrite() above, which is send-only and structurally
// cannot list or read anything. Real gap found 2026-08-05: any thread Apsara
// starts herself (emailing a trucker/broker directly, not routed through
// bose@'s carrier-mail intake) is invisible to getGmailRead(), so "reply to
// X" / "email X about booking Y" searches can only ever check bose@ and can
// end up matching the wrong conversation off a coincidental subject/word
// overlap. Returns null — NOT a throw — when the token file doesn't exist
// yet, so every caller can fail soft back to bose@-only search until this
// is deployed (run scripts/gmail-auth.js --role=sender-read, signed into
// apsara, once).
function getGmailSenderRead() {
    if (senderReadClient) return senderReadClient;
    if (!fs.existsSync(cfg.GMAIL_SENDER_READ_TOKEN_FILE)) return null;
    senderReadClient = buildClient(cfg.GMAIL_SENDER_READ_TOKEN_FILE, 'sender-read');
    return senderReadClient;
}

// ── Message helpers ───────────────────────────────────────────────────────────

function parseEmailDate(raw) {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? raw : d.toISOString();
}

// Walk the MIME tree: return { body, pdfParts }
// Converts email HTML to readable text.
//
// AUDIT FINDING (2026-08-22): getEmailContent read ONLY text/plain. A
// staggering share of real business mail — anything from Outlook, a carrier
// portal, a CRM, or any rich-text composer — is HTML-only, with no text/plain
// alternative at all. For every one of those, body came back as an EMPTY
// STRING, and nothing downstream noticed:
//   - workflow/replyWatch.js sees no content and skips the message entirely,
//     so an HTML-only email asking for a quote is never flagged. Silent.
//   - searchMail answers questions about mail it cannot read.
//   - draftReplyForConfirm drafts a reply with no idea what was said.
//   - cutoffBackfill extracts booking fields from nothing.
// This was the single largest hole in the email surface: not a wrong answer,
// but whole emails invisible with no error anywhere.
//
// Deliberately hand-rolled rather than adding another dependency. Email HTML
// is a narrow, well-understood subset and this only needs to produce
// something Gemini can read — not faithful rendering. Ordering matters:
// script/style contents are removed BEFORE tags are stripped, or their
// contents would survive as body text.
function htmlToText(html) {
    if (!html) return '';
    let t = String(html);
    t = t.replace(/<!--[\s\S]*?-->/g, ' ');
    // Contents, not just the tags — otherwise CSS and JS become "body text".
    t = t.replace(/<(script|style|head|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
    // Block boundaries become line breaks so sentences do not run together.
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n');
    t = t.replace(/<\/(td|th)>/gi, '\t');
    t = t.replace(/<[^>]+>/g, ' ');
    // Entities, commonest first. &amp; is decoded LAST so that an encoded
    // "&amp;lt;" does not turn into a "<" and re-introduce markup.
    t = t.replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
         .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
         .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(+d); } catch (e) { return ' '; } })
         .replace(/&amp;/gi, '&');
    t = t.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n');
    return t.trim();
}

// Walks the MIME tree. Returns { body, pdfParts, wasHtmlOnly }.
//
// text/plain always wins when present — it is what the sender's client
// produced as the readable version. HTML is used only when there is no plain
// alternative, which is exactly the case that used to yield nothing.
function getEmailContent(payload) {
    let body = '';
    let html = '';
    const pdfParts = [];
    (function walk(part) {
        const mtype = part.mimeType || '';
        if (mtype === 'text/plain' && part.body && part.body.data) {
            body += Buffer.from(part.body.data, 'base64').toString('utf8');
        } else if (mtype === 'text/html' && part.body && part.body.data) {
            html += Buffer.from(part.body.data, 'base64').toString('utf8');
        } else if (mtype.includes('pdf') || /\.pdf$/i.test(part.filename || '')) {
            pdfParts.push(part);
        }
        (part.parts || []).forEach(walk);
    })(payload);

    let wasHtmlOnly = false;
    if (!body.trim() && html.trim()) {
        body = htmlToText(html);
        wasHtmlOnly = true;
    }
    return { body, pdfParts, wasHtmlOnly };
}

// ── Auth health — surface a dead Gmail token instead of failing silently ────
//
// AUDIT FINDING (2026-08-22): when a Gmail refresh token is revoked or
// expires, every call throws `invalid_grant`, and every caller in this
// codebase catches it and moves on: emailWatcher logs and continues, the
// inbox scan logs and returns zero, searchMail says it could not find
// anything. From the outside Jarvis looks like a quiet inbox. The entire
// email side of the business could be down for days with nothing but console
// noise to show for it — the same failure shape as WhatsApp dropping
// messages, which is the bug that started this whole thread.
//
// This does not fix the token; only re-running the auth script can. It makes
// the failure LOUD, once, through the manager outbox — which will reach her
// by WhatsApp or, if that is also down, by... well, not email. That is worth
// stating plainly rather than pretending otherwise: if Gmail auth is dead,
// the email fallback is dead too, so this is deliberately routed as critical
// so it also lands in the dashboard alert rail.
const AUTH_ERROR_RE = /invalid_grant|invalid_credentials|unauthorized_client|Token has been expired or revoked|insufficient(Permissions| authentication)|401|403/i;
let _lastAuthAlertAt = 0;
const AUTH_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // once per 6h, not per call

function looksLikeAuthFailure(err) {
    if (!err) return false;
    const msg = `${err.message || ''} ${err.code || ''} ${(err.response && err.response.status) || ''}`;
    return AUTH_ERROR_RE.test(msg);
}

// Call from any catch block that swallowed a Gmail error. Non-blocking and
// never throws — a health check that can break its caller is worse than none.
function reportGmailError(err, context) {
    try {
        if (!looksLikeAuthFailure(err)) return false;
        const now = Date.now();
        // Rate-limited hard: a broken token throws on EVERY poll, and this
        // runs inside a 5-minute scan loop. Without the cooldown a dead token
        // would generate a notification every few minutes, all night.
        if (now - _lastAuthAlertAt < AUTH_ALERT_COOLDOWN_MS) return true;
        _lastAuthAlertAt = now;
        console.error(`[GMAIL] AUTH FAILURE in ${context}: ${err.message}`);
        const outbox = require('./managerOutbox');
        outbox.deliver(
            `Gmail authorization has failed (${context}).\n\n` +
            `Email is not being read or sent right now — inbox monitoring, booking intake and replies are all affected.\n\n` +
            `Fix: re-run the Gmail auth script on the server and sign in again.\n` +
            `Detail: ${String(err.message || '').slice(0, 200)}`,
            { critical: true, subject: 'Gmail authorization failed', dedupeKey: 'gmail-auth-failure' },
        ).catch((e) => console.error('[GMAIL] could not report auth failure:', e.message));
        return true;
    } catch (e) {
        console.error('[GMAIL] reportGmailError itself failed:', e.message);
        return false;
    }
}

// The address a reply should actually go to.
//
// AUDIT FINDING (2026-08-22): every reply path used the From header. RFC 5322
// Reply-To exists precisely because those differ, and in business mail they
// often do — a carrier sends from a no-reply notification address with
// Reply-To pointing at the desk that reads answers, a broker sends from a
// personal address with Reply-To on a shared inbox. Replying to From in
// those cases sends into a void that nobody reads, and it looks to the
// customer like the message was ignored.
//
// Falls back to From whenever Reply-To is absent or unparseable, so this can
// only ever improve where the header exists and changes nothing where it
// does not.
function preferredReplyAddress(headers) {
    const get = (n) => {
        if (Array.isArray(headers)) {
            const h = headers.find((x) => (x.name || '').toLowerCase() === n);
            return h ? h.value : '';
        }
        return headers ? (headers[n] || headers[n.replace(/(^|-)([a-z])/g, (m, a, b) => a + b.toUpperCase())] || '') : '';
    };
    const replyTo = get('reply-to');
    const from = get('from');
    const pick = (v) => {
        if (!v) return null;
        const m = String(v).match(/<([^>]+)>/);
        const addr = (m ? m[1] : String(v)).trim();
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) ? addr : null;
    };
    return pick(replyTo) || pick(from) || null;
}

// Mail that must never be replied to, and should not be flagged as needing a
// reply either.
//
// AUDIT FINDING (2026-08-22): nothing checked for this. An out-of-office
// bounce would be assessed by Gemini like any other message, could plausibly
// read as "needs a reply", and land in her digest as work. Worse, replying to
// an auto-responder that itself auto-responds is the classic mail loop — two
// systems answering each other indefinitely, from her real business address.
//
// These headers are the standard machine-generated markers (RFC 3834 and the
// widely-implemented conventions that predate it). Checking headers rather
// than body text matters: "out of office" appearing in a human's sentence is
// not an auto-reply, and would be a false positive that hides real work.
function isAutoReply(headers) {
    const get = (n) => {
        const h = (headers || []).find((x) => (x.name || '').toLowerCase() === n);
        return h ? String(h.value || '').toLowerCase() : '';
    };
    if (/auto-(replied|generated|notified)/.test(get('auto-submitted'))) return true;
    if (get('x-autoreply') || get('x-autorespond') || get('x-auto-response-suppress')) return true;
    if (/(auto_reply|bulk|junk|list)/.test(get('precedence'))) return true;
    if (get('list-unsubscribe') && !get('in-reply-to')) return true; // bulk mail, not a conversation
    if (/^\s*(auto(matic)?[- ]?reply|out of (the )?office|automatic reply)\b/i.test(get('subject'))) return true;
    return false;
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

// attachments (optional): [{ filename, mimeType, base64 }] — added for the
// end-of-day yard report (scheduler.js's eodYardReport), which emails the
// actual PDF files rather than just Drive links. Purely additive: when
// `attachments` is omitted/empty, this produces the EXACT SAME plain-text
// message as before (same header order, same body-only payload) — every
// existing caller (draftEmailForConfirm, replies, etc.) is unaffected.
// RFC 2047 encoded-word — headers are technically US-ASCII only; an
// unencoded non-ASCII byte (e.g. the em dash "—" every subject built via
// `${cfg.COMPANY_NAME} — Yard Report — ...` uses) gets read back by mail
// clients as if it were Latin-1, producing exactly the mojibake Apsara saw
// (Subject "Edge Trading Ã¢Â€Â” Yard Report ..." 2026-08-16). Only bother
// wrapping when a non-ASCII byte is actually present — plain-ASCII subjects
// (the overwhelming majority of existing callers) go out byte-for-byte
// identical to before this fix, so nothing that already worked changes.
function encodeHeader(str) {
    if (/^[\x00-\x7F]*$/.test(str)) return str;
    return `=?UTF-8?B?${Buffer.from(String(str), 'utf8').toString('base64')}?=`;
}

function buildMimeMessage({ to, cc, bcc, subject, body, inReplyTo, references, attachments }) {
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    const boundary = hasAttachments ? `----jarvis-${Date.now()}-${Math.random().toString(36).slice(2)}` : null;

    const headers = [
        `To: ${to}`,
        `Subject: ${encodeHeader(subject)}`,
        hasAttachments ? `Content-Type: multipart/mixed; boundary="${boundary}"` : 'Content-Type: text/plain; charset="UTF-8"',
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

    let bodyPart = body;
    if (hasAttachments) {
        const parts = [`--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', '', body];
        for (const att of attachments) {
            parts.push(
                `--${boundary}`,
                `Content-Type: ${att.mimeType || 'application/octet-stream'}; name="${att.filename}"`,
                'Content-Transfer-Encoding: base64',
                `Content-Disposition: attachment; filename="${att.filename}"`,
                '',
                // Wrapped at 76 chars — standard MIME base64 line length; Gmail
                // accepts unwrapped base64 too, but wrapping is the RFC 2045
                // convention and avoids any risk with mail clients that assume it.
                att.base64.replace(/(.{76})/g, '$1\r\n'),
            );
        }
        parts.push(`--${boundary}--`);
        bodyPart = parts.join('\r\n');
    }

    const raw = `${headers.join('\r\n')}\r\n\r\n${bodyPart}`;
    // base64url, no padding — same normalization Gmail's API expects on the way in.
    return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Sends via apsara@edgemetals.com. Caller is responsible for having already
// gotten manager confirmation — this function sends unconditionally the
// moment it's called, no confirmation gate of its own.
//
// threadId — UPDATED 2026-08-06: the original reasoning ("threadId is only
// valid within the SAME mailbox that owns the thread — reads happen on
// bose's account, sends happen on apsara's, so a threadId read elsewhere is
// meaningless here") still holds for threadIds read from bose's mailbox.
// It does NOT apply to a threadId that was ALSO produced by a PRIOR
// sendEmail() call on this same apsara@ account — that's exactly the case
// helpers/emailThreads.js tracks (general emails, and now relayed
// questions) and workflow/emailReplyWatch.js's poller reads back via
// getGmailSenderRead (same account, different scope). Passing that same-
// account threadId back in here lets an acknowledgment reply land in the
// original thread instead of starting a new one — needed for
// relayReplyReceivedViaEmail's acknowledgment send. Optional and additive:
// every existing caller that doesn't pass it behaves exactly as before.
async function sendEmail({ to, cc, bcc, subject, body, inReplyTo, references, threadId, attachments }) {
    const gmail = getGmailWrite();
    const requestBody = { raw: buildMimeMessage({ to, cc, bcc, subject, body, inReplyTo, references, attachments }) };
    if (threadId) requestBody.threadId = threadId;
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

// REAL BUG (found 2026-08-04, live): "mk metal trading" (a real, multi-word
// company name) came back with NO address at all, while "mkmetaltrading"
// (same company, spaces stripped) instantly found export@mkmetaltrading.com.
// Root cause: from:/cc:/to: search operators need their argument to be ONE
// token — an unquoted multi-word value gets split into separate search terms
// by Gmail (from:mk + a free-text search for "metal" and "trading"
// elsewhere), not treated as "the sender is mk metal trading." Quoting a
// multi-word term keeps it together as a single phrase for every operator
// AND the bare full-text fallback clause. Single-word terms (the overwhelming
// common case — "radmetals", "zimex") are left unquoted, unchanged from
// before, so this can't regress anything that already worked.
function searchTermFor(term) {
    return /\s/.test(term) ? `"${String(term).replace(/"/g, '')}"` : term;
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
    const st = searchTermFor(nameOrDomain);
    const q = `(from:${st} OR cc:${st} OR to:${st} OR ${st})`;
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
    // Same multi-word quoting fix as findLatestFrom above — see
    // searchTermFor's comment for the real incident this closes.
    const st = searchTermFor(term);
    const q = `(from:${st} OR cc:${st} OR to:${st} OR ${st})`;
    const res = await gmail.users.messages.list({ userId: 'me', q, maxResults });
    const rawMessages = res.data.messages || [];

    const messages = [];
    const tally = new Map(); // lowercased address -> { from, to, cc, displayName }

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
                if (!tally.has(addr)) tally.set(addr, { from: 0, to: 0, cc: 0, displayName: null });
                const entry = tally.get(addr);
                entry[role]++;
                // REAL BUG (found 2026-08-04, live): domain-tree contacts
                // only ever got a NAME inferred from the address's
                // local-part (export@mkmetaltrading.com -> "export") — fine
                // as a short lookup key ("mail export"), but wrong when it
                // leaks into the actual drafted email's greeting ("Dear
                // export"). The real name (e.g. "Marc Kang") is sitting
                // right there in the From header of messages already being
                // scanned — capture it here so callers can use a proper
                // name in the email body while still using the short local-
                // part as the typed lookup key. From-header wins if both
                // From and Cc/To happen to carry a display name for the
                // same address — Cc/To display names are less reliably "how
                // this person signs their own mail."
                // First occurrence wins, whatever role it's in — messages
                // are scanned newest-first, so this is simply "the most
                // recent display name seen for this address," which is a
                // simpler and less bug-prone rule than trying to re-rank
                // From over Cc/To after the fact (an earlier attempt at
                // that ended up keeping the OLDEST From match instead of
                // the newest, since every From occurrence kept overwriting
                // the last).
                if (!entry.displayName) {
                    const dn = extractDisplayName(part.trim());
                    if (dn) entry.displayName = dn;
                }
            }
        }
    }
    return { query: q, messages, tally };
}

// "Marc Kang" <marckang@x.com> / Marc Kang <marckang@x.com> -> "Marc Kang".
// Bare "marckang@x.com" (no display name at all) -> null. Used by
// tallyAddressesForTerm so a domain-tree contact can carry a real human
// name separately from its short lookup key.
function extractDisplayName(headerValue) {
    if (!headerValue) return null;
    const m = headerValue.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
    if (!m) return null;
    const name = m[1].trim();
    return name ? name : null;
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
    READ_SCOPES, WRITE_SCOPES, getOAuthClient, getGmailRead, getGmailWrite, getGmailSenderRead,
    parseEmailDate, getEmailContent, htmlToText, preferredReplyAddress, isAutoReply, looksLikeAuthFailure, reportGmailError, downloadAttachment, listMessages, getMessage,
    sendEmail, findLatestFrom, detectCcPattern, parseAddressList, getMyEmailAddress,
    tallyAddressesForTerm,
};