// ── workflow/replyWatch.js — "which emails are waiting on me?" ──────────────
//
// Apsara, 2026-08-22: "i want proper email monitoring and flag anything if it
// asks for reply. like what inbuild gmail summary ai works."
//
// THE GAP THIS FILLS
//
// Jarvis already watches mail in three places, and none of them watch THIS:
//   - workflow/emailWatcher.js  — booking-confirmation emails WITH a PDF
//     attachment. Its own header, point 3: "Emails with no PDF attachment are
//     skipped entirely." So an ordinary email from a customer is invisible.
//   - workflow/emailReplyWatch.js — replies landing on threads JARVIS STARTED
//     (quote requests, contact quotes, general outbound). Inbound mail nobody
//     asked for is out of scope by construction.
//
// So the one thing a person actually worries about — someone emailed me and
// is waiting — had no watcher at all.
//
// ON "IS THERE A LIBRARY FOR THAT"
//
// For the JUDGEMENT, no, and it is worth being clear why: deciding whether a
// message is waiting on a reply is a reading-comprehension problem, not a
// parsing one. "Let me know either way" needs a reply; "thanks, received"
// does not; "please confirm by Friday" needs one urgently. No npm package
// does that. Gmail's own summary feature is an LLM too. So the judgement here
// is Gemini's, the same call the pending arbiter makes.
//
// For the PLUMBING, one library genuinely earns its place:
// email-reply-parser (MIT, used by Crisp on roughly a million inbound emails
// a day) strips quoted history and signatures. That matters more than it
// sounds: without it, a five-deep reply chain hands Gemini the entire thread,
// and it starts answering about a question from three replies ago that was
// settled long since. It is loaded defensively like every other dependency
// added on 2026-08-22 — a missing package degrades to a plain regex, never a
// crash.
//
// SAFETY POSTURE — NOTHING LEAVES WITHOUT HER SAYING YES
//
// An earlier version of this comment said the feature was "read-only,
// permanently". That was my call, not hers, and it was too strong — Apsara,
// 2026-08-22: "it can send post my confirmation." She is right, and the
// distinction that actually matters is not read-vs-write, it is
// autonomous-vs-confirmed.
//
// So: this SCAN never sends anything. It reads mail, flags what is waiting,
// and stops. But from the digest she can reply — "reply to 1", or "reply to
// Zimex about the cutoff" — and that routes into the SAME
// draftReplyForConfirm flow every other outbound email in this app already
// uses: Jarvis drafts, shows her the full text, and sends only after an
// explicit yes. No new send path was built for this, deliberately; there is
// exactly one way an email leaves this system and it has a human gate on it.
//
// What stays off the table is Jarvis deciding on its own to answer a
// customer. Auto-replying on an LLM's judgement is not a feature this
// business wants — the blast radius of getting it wrong is a real
// relationship. Confirmed sending is a different thing entirely, and that is
// what this supports.

const { getGmailRead, getEmailContent, listMessages, getMessage, getMyEmailAddress, parseEmailDate } = require('../helpers/gmail');
const { callGeminiJSON } = require('../helpers/gemini');
const { appendAuditLog } = require('../helpers/auditlog');
const { loadJson, saveJson } = require('../helpers/json');
const cfg = require('../config');

// ── email-reply-parser (MIT) — strip quoted history ─────────────────────────
let EmailReplyParser = null;
try {
    const mod = require('email-reply-parser');
    // The package ships as transpiled ESM, so the constructor sits on
    // `.default` under CommonJS require, not on the module itself. Requiring
    // it the obvious way yields an object and `new` on it throws
    // "EmailReplyParser is not a constructor" — which the fallback below
    // silently absorbed, so every test still passed while the library was
    // doing nothing at all. Caught only by reading the warning line in the
    // test output. Handle both shapes so a future version that switches back
    // to a plain CommonJS export keeps working.
    EmailReplyParser = typeof mod === 'function' ? mod : mod.default;
    if (typeof EmailReplyParser !== 'function') {
        console.warn('[REPLYWATCH] email-reply-parser has an unexpected export shape — using the regex fallback.');
        EmailReplyParser = null;
    }
} catch (e) {
    console.warn('[REPLYWATCH] email-reply-parser not installed — using a plain-regex fallback. Run `npm install` for better quote stripping.');
}

// ── zod (MIT) — validate Gemini's shape ─────────────────────────────────────
let AssessmentSchema = null;
try {
    const { z } = require('zod');
    AssessmentSchema = z.object({
        needs_reply: z.coerce.boolean(),
        // Clamped, so a model that answers 95 (meaning 95%) cannot outrank a
        // genuine 0.95 and jump the urgency ordering.
        confidence: z.coerce.number().min(0).max(1).optional().default(0),
        urgency: z.enum(['high', 'normal', 'low']).optional().default('normal'),
        summary: z.string().optional().default(''),
        asked_for: z.string().nullable().optional().default(null),
        deadline: z.string().nullable().optional().default(null),
    });
} catch (e) { /* falls back to hand-rolled checks below */ }

const LOOKBACK_DAYS = 3;
const MAX_EMAILS_PER_RUN = 25;   // bounds both Gemini spend and digest length
const MIN_CONFIDENCE = 0.6;

// Senders that never want a reply. Matched against the FROM header. This is a
// cheap pre-filter to avoid paying for a Gemini call on obvious machine mail —
// anything that slips through is still correctly judged by the model, so a
// miss here costs a few cents, never a wrong answer.
const NEVER_REPLY_PATTERNS = [
    /no[-._]?reply@/i, /do[-._]?not[-._]?reply/i, /notifications?@/i, /alerts?@/i,
    /mailer[-._]?daemon/i, /postmaster@/i, /bounce/i, /newsletter/i,
    /automated@/i, /system@/i, /support@.*\.zendesk\.com/i, /calendar-notification@/i,
];

// Store shape: { seen: {messageId: assessedAtISO}, lastDigest: [item, ...] }.
// `seen` is a map rather than a list so entries can be aged out — an
// unbounded id list would grow forever on a busy mailbox. `lastDigest` is
// what makes "reply to 1" resolvable: the numbers she sees in the digest have
// to still mean something on her next message.
//
// Reads tolerate the older flat {id: at} shape this file shipped with earlier
// on 2026-08-22, so upgrading does not re-flag every email already assessed.
function loadStore() {
    const raw = loadJson(cfg.REPLY_WATCH_FILE, {});
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { seen: {}, lastDigest: [] };
    if (raw.seen && typeof raw.seen === 'object') {
        return { seen: raw.seen, lastDigest: Array.isArray(raw.lastDigest) ? raw.lastDigest : [] };
    }
    return { seen: raw, lastDigest: [] }; // legacy flat format
}
async function saveStore(store) {
    // Keep only what the lookback window could still surface. Anything older
    // can never be re-flagged, so retaining it just bloats the file.
    const cutoff = Date.now() - (LOOKBACK_DAYS + 2) * 86400000;
    const trimmed = {};
    for (const [id, at] of Object.entries(store.seen || {})) {
        const t = Date.parse(at);
        if (!isNaN(t) && t >= cutoff) trimmed[id] = at;
    }
    await saveJson(cfg.REPLY_WATCH_FILE, { seen: trimmed, lastDigest: store.lastDigest || [] });
}

// Resolve the "1" in "reply to 1" back to the sender it referred to.
// Returns null for an out-of-range or stale number rather than guessing —
// replying to the wrong customer is far worse than asking again.
function resolveDigestIndex(n) {
    const { lastDigest } = loadStore();
    const i = parseInt(n, 10);
    if (!Number.isInteger(i) || i < 1 || i > (lastDigest || []).length) return null;
    return lastDigest[i - 1] || null;
}

function header(msg, name) {
    const hs = msg?.payload?.headers || [];
    const h = hs.find((x) => (x.name || '').toLowerCase() === name.toLowerCase());
    return h ? h.value : '';
}

// Strip quoted history and signature so Gemini reads only what this person
// actually just wrote.
function extractLatestMessage(body) {
    const text = String(body || '').trim();
    if (!text) return '';
    if (EmailReplyParser) {
        try {
            const visible = new EmailReplyParser().read(text).getVisibleText();
            if (visible && visible.trim()) return visible.trim();
            // An empty result means the parser judged the whole message to be
            // quoted. Fall through rather than handing Gemini nothing.
        } catch (e) {
            console.warn('[REPLYWATCH] reply-parser failed, using fallback:', e.message);
        }
    }
    // Fallback: cut at the first common reply header or quote marker.
    const cutAt = text.search(/^\s*(>|On .+ wrote:|-{2,}\s*Original Message|From:\s)/m);
    return (cutAt > 0 ? text.slice(0, cutAt) : text).trim();
}

function buildPrompt(email) {
    return `You are triaging one email for the manager of a freight/export company (Edge Metals). Decide ONE thing: is this email waiting on a reply from her?

FROM: ${email.from}
SUBJECT: ${email.subject}
RECEIVED: ${email.date}

BODY (quoted history already removed):
${String(email.body || '').slice(0, 4000)}

Judge by what the sender actually wants:
- needs_reply TRUE when the sender is waiting on something only she can give: a question, a quote or price request, a confirmation, a decision, a document, a date, an approval, or a chase-up on something already asked. "Let me know", "please confirm", "can you send", "are you able to", "thoughts?", and a question mark aimed at her all point this way. A polite closing like "thanks!" does not cancel a real question earlier in the message.
- needs_reply FALSE for anything that closes the loop or wants nothing: a confirmation of something already settled, a receipt or invoice sent for records, an automated notification, a newsletter or marketing mail, a delivery or tracking update, "thanks, received", an FYI or a CC where someone else is clearly the one being asked.

urgency:
- "high" — a stated deadline inside about two days, an explicit chase ("following up again", "still waiting", "urgent"), a truck/vessel/container or cutoff at risk, or money at risk.
- "normal" — a real question with no particular time pressure.
- "low" — courteous or optional; a reply would be nice but nothing is blocked.

summary: ONE short sentence, under 15 words, saying what they want. Write it so it makes sense on its own in a list, without the subject line next to it.
asked_for: the single most concrete thing being requested ("a rate for LA to Houston", "the signed BOL"), or null.
deadline: any date or time limit the sender actually states, verbatim. Do NOT infer or invent one — null if none is stated.
confidence: 0.0 to 1.0, how sure you are about needs_reply.

Be decisive. When a message plausibly wants an answer, say so — a flagged email she can ignore costs her two seconds, a missed one can cost a booking. But do not flag pure notifications just to be safe; a digest full of noise gets ignored entirely, which is worse than not having one.

Return ONLY this JSON, nothing else:
{ "needs_reply": true, "confidence": 0.0, "urgency": "normal", "summary": "", "asked_for": null, "deadline": null }`;
}

async function assess(email) {
    const res = await callGeminiJSON(buildPrompt(email), 2, AssessmentSchema);
    if (!res || typeof res.needs_reply === 'undefined') return null;
    // Without zod these fields are unvalidated, so normalize defensively —
    // the shape must not depend on whether an optional package installed.
    return {
        needs_reply: res.needs_reply === true || res.needs_reply === 'true',
        confidence: typeof res.confidence === 'number' ? res.confidence : 0,
        urgency: ['high', 'normal', 'low'].includes(res.urgency) ? res.urgency : 'normal',
        summary: String(res.summary || '').trim(),
        asked_for: res.asked_for ? String(res.asked_for).trim() : null,
        deadline: res.deadline ? String(res.deadline).trim() : null,
    };
}

const URGENCY_RANK = { high: 0, normal: 1, low: 2 };
const URGENCY_MARK = { high: '!!', normal: '·', low: '·' };

function buildDigest(flagged) {
    const lines = [`${flagged.length} email${flagged.length === 1 ? '' : 's'} waiting on you:`, ''];
    // Numbered so she can answer one without retyping the sender's name.
    flagged.forEach((f, i) => {
        lines.push(`${i + 1}. ${URGENCY_MARK[f.urgency]} ${f.fromName}${f.deadline ? ` — by ${f.deadline}` : ''}`);
        lines.push(`   ${f.summary || f.subject}`);
        if (f.asked_for) lines.push(`   wants: ${f.asked_for}`);
        lines.push('');
    });
    lines.push('Nothing sent yet. Reply with "reply to 1" (or "reply to 1: confirmed for Friday")');
    lines.push('and I\'ll draft it for your yes before anything goes out.');
    return lines.join('\n');
}

// Prefer the display name over the raw address — "Zimex" reads better in a
// digest than "operations@zimexlogistics.example.com".
function senderLabel(from) {
    const m = String(from || '').match(/^\s*"?([^"<]+?)"?\s*</);
    if (m && m[1].trim()) return m[1].trim();
    const addr = String(from || '').match(/[\w.+-]+@[\w.-]+/);
    return addr ? addr[0] : String(from || 'unknown');
}

// dryRun: assess and return, send nothing. Used by tests and by a manual
// "what's waiting on me" check that shouldn't fire a WhatsApp message.
async function run({ sendToManager, dryRun = false } = {}) {
    const gmail = await getGmailRead();
    if (!gmail) {
        console.warn('[REPLYWATCH] Gmail not authorized — skipping');
        return { checked: 0, flagged: 0, skipped: 'no-gmail' };
    }

    const me = (await getMyEmailAddress(gmail) || '').toLowerCase();
    const store = loadStore();
    const seen = store.seen;

    const after = new Date(Date.now() - LOOKBACK_DAYS * 86400000);
    const afterStr = `${after.getFullYear()}/${after.getMonth() + 1}/${after.getDate()}`;
    // -from:me excludes her own sent mail; category filters drop the bulk of
    // promotional and social noise before it costs anything.
    const query = `after:${afterStr} in:inbox -from:me -category:promotions -category:social`;

    let messages = [];
    try {
        messages = await listMessages(gmail, query, MAX_EMAILS_PER_RUN * 2);
    } catch (err) {
        console.error('[REPLYWATCH] Gmail list failed:', err.message);
        return { checked: 0, flagged: 0, error: err.message };
    }

    const flagged = [];
    let checked = 0;

    for (const ref of messages) {
        if (checked >= MAX_EMAILS_PER_RUN) break;
        if (seen[ref.id]) continue;

        let msg;
        try { msg = await getMessage(gmail, ref.id); }
        catch (err) { console.error(`[REPLYWATCH] fetch ${ref.id} failed:`, err.message); continue; }

        const from = header(msg, 'From');
        const subject = header(msg, 'Subject') || '(no subject)';

        // Her own mail, however it got into the inbox.
        if (me && from.toLowerCase().includes(me)) { seen[ref.id] = new Date().toISOString(); continue; }
        // Machine mail — cheap pre-filter, see NEVER_REPLY_PATTERNS.
        if (NEVER_REPLY_PATTERNS.some((re) => re.test(from))) { seen[ref.id] = new Date().toISOString(); continue; }

        // If she has ALREADY replied, the thread is not waiting on her. Gmail
        // orders thread messages oldest-first, so the last entry is the most
        // recent — if that is from her, she has answered. Without this the
        // digest would keep nagging about mail she dealt with hours ago,
        // which is exactly how a digest earns itself ignored.
        try {
            if (msg.threadId) {
                const thread = await gmail.users.threads.get({ userId: 'me', id: msg.threadId, format: 'metadata', metadataHeaders: ['From'] });
                const tmsgs = thread?.data?.messages || [];
                if (tmsgs.length > 1) {
                    const lastFrom = (tmsgs[tmsgs.length - 1]?.payload?.headers || [])
                        .find((h) => (h.name || '').toLowerCase() === 'from')?.value || '';
                    if (me && lastFrom.toLowerCase().includes(me)) { seen[ref.id] = new Date().toISOString(); continue; }
                }
            }
        } catch (err) {
            // Non-fatal: fall through and assess. Worst case she sees an
            // email she already answered — annoying, not harmful.
            console.warn('[REPLYWATCH] thread check failed, assessing anyway:', err.message);
        }

        const { body } = getEmailContent(msg.payload || {});
        const visible = extractLatestMessage(body || msg.snippet || '');
        if (!visible) { seen[ref.id] = new Date().toISOString(); continue; }

        checked++;
        let a = null;
        try {
            a = await assess({ from, subject, date: parseEmailDate(header(msg, 'Date')), body: visible });
        } catch (err) {
            console.error('[REPLYWATCH] assess failed:', err.message);
        }
        // Deliberately NOT marked seen when assessment failed — a Gemini
        // outage should mean "try again next run", not "silently drop this
        // email forever".
        if (!a) continue;

        seen[ref.id] = new Date().toISOString();

        if (a.needs_reply && a.confidence >= MIN_CONFIDENCE) {
            flagged.push({
                id: ref.id, threadId: msg.threadId, fromName: senderLabel(from), from, subject,
                summary: a.summary, asked_for: a.asked_for, deadline: a.deadline, urgency: a.urgency,
            });
        }

        try {
            await appendAuditLog({
                source: 'reply_watch', messageId: ref.id, senderName: senderLabel(from),
                text: subject, intent: a.needs_reply ? 'needs_reply' : 'no_reply_needed',
                resolvedBy: 'ai', confidence: a.confidence, actionTaken: a.needs_reply ? 'flagged' : 'ignored',
            });
        } catch (e) { /* audit logging must never break the scan */ }
    }

    // Persist the digest ONLY on a real run — a dryRun (her asking directly)
    // must not renumber the list under a digest she is already looking at.
    store.seen = seen;
    if (!dryRun) store.lastDigest = flagged;
    await saveStore(store);

    flagged.sort((x, y) => URGENCY_RANK[x.urgency] - URGENCY_RANK[y.urgency]);

    if (flagged.length && sendToManager && !dryRun) {
        try { await sendToManager(buildDigest(flagged)); }
        catch (err) { console.error('[REPLYWATCH] digest send failed:', err.message); }
    }

    console.log(`[REPLYWATCH] assessed ${checked}, flagged ${flagged.length}`);
    return { checked, flagged: flagged.length, items: flagged };
}

module.exports = { run, buildPrompt, buildDigest, extractLatestMessage, senderLabel, assess, resolveDigestIndex, loadStore, saveStore, NEVER_REPLY_PATTERNS };
