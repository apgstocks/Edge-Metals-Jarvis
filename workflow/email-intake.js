// ── workflow/email-intake.js — Carrier booking-email → booking record ───────
// Uses the EXISTING OAuth2-based helpers/gmail.js already on main (token
// already generated via scripts/gmail-auth.js — do not swap this for a
// service-account approach). This file adds the piece that was missing:
// actually querying, parsing, and acting on the mail.
//
// Field precedence: PDF attachment is the primary source for identity
// fields (booking_number, carrier, ports, vessel_voyage, container info).
// erd_date/cutoff_date come from the email BODY when present, overriding
// the attachment — carriers send cutoff/ERD changes as email text, and the
// original PDF can go stale.
//
// Auto-creates/updates the booking rather than requiring manager
// confirmation first — the email IS the carrier's own record. But it never
// acts silently: always notifies after acting, same posture as
// scheduler.js's autoArchive().
//
// Deliberately NOT gated by helpers/trust.js — that ledger is scoped to
// manager-approved actions on EXISTING bookings (forward/assign); this is
// new data arriving from an external, already-authoritative source.

const { getGmail, listMessages, getMessage, getEmailContent, downloadAttachment } = require('../helpers/gmail');
const { extractPdfFields, extractBookingFieldsFromText } = require('../helpers/gemini');
const { mutateJson, updateWorkflow } = require('../helpers/json');
const { appendAuditLog } = require('../helpers/auditlog');
const cfg = require('../config');

// Sender allowlist lives in settings.json (dashboard-editable via the
// existing PUT /api/settings admin route) — adding a new carrier shouldn't
// need a redeploy. No hardcoded default: guessing Zimex/Eaglebrit's actual
// sending domains would fail silently and look identical to "working."
function senderQuery() {
    const settings = cfg.getSettings ? cfg.getSettings() : {};
    const senders = settings.booking_email_senders || [];
    if (!senders.length) return null;
    return senders.map(s => `from:${s}`).join(' OR ');
}

// Attachment wins for everything except erd_date/cutoff_date, where body
// wins if present. Attachment also fills any gap the body left null.
function mergeFields(attachmentFields, bodyFields) {
    const a = attachmentFields || {};
    const b = bodyFields || {};
    const merged = { ...a };
    if (b.erd_date)    merged.erd_date    = b.erd_date;
    if (b.cutoff_date) merged.cutoff_date = b.cutoff_date;
    for (const k of Object.keys(b)) {
        if (merged[k] == null && b[k] != null) merged[k] = b[k];
    }
    return merged;
}

// helpers/gmail.js doesn't export a mark-as-read helper — call the raw
// client directly rather than patching that file. Gmail's own read-state is
// the dedup ledger: no separate local "seen" file to keep in sync.
async function markProcessed(gmail, messageId) {
    await gmail.users.messages.modify({
        userId     : 'me',
        id         : messageId,
        requestBody: { removeLabelIds: ['UNREAD'] },
    });
}

async function processOneMessage(gmail, msgMeta, sendToManager) {
    const full = await getMessage(gmail, msgMeta.id);
    const headers = full.payload?.headers || [];
    const from    = headers.find(h => h.name === 'From')?.value    || '';
    const subject = headers.find(h => h.name === 'Subject')?.value || '';

    const { body, pdfParts } = getEmailContent(full.payload);

    let attachmentFields = null;
    if (pdfParts.length) {
        try {
            const { base64 } = await downloadAttachment(gmail, msgMeta.id, pdfParts[0]);
            attachmentFields = await extractPdfFields(base64);
        } catch (err) {
            console.error(`[EMAIL-INTAKE] PDF extract failed ("${subject}"):`, err.message);
        }
    }

    let bodyFields = null;
    try {
        bodyFields = await extractBookingFieldsFromText(body);
    } catch (err) {
        console.error(`[EMAIL-INTAKE] Body extract failed ("${subject}"):`, err.message);
    }

    const fields = mergeFields(attachmentFields, bodyFields);

    if (!fields.booking_number) {
        // Left unread deliberately — surfaces for manual review instead of
        // guessing, same rule brain.js's own prompt already follows.
        console.warn(`[EMAIL-INTAKE] No booking_number in "${subject}" from ${from} — left unread for manual review`);
        await appendAuditLog({
            source: 'email_intake', intent: 'no_booking_number', resolvedBy: 'ai',
            actionTaken: 'skipped', from, subject,
        });
        return;
    }

    const bkg = String(fields.booking_number).toUpperCase();
    let isNew = false;
    await mutateJson(cfg.BOOKINGS_FILE, {}, (all) => {
        isNew = !all[bkg];
        all[bkg] = {
            ...(all[bkg] || {}),
            ...fields,
            booking_number: bkg,
            created_at    : all[bkg]?.created_at || new Date().toISOString(),
            source        : 'email_intake',
        };
        return all;
    });
    if (isNew) await updateWorkflow(bkg, {});

    if (sendToManager) {
        const line = isNew
            ? `New booking ${bkg} auto-created from ${from} (${fields.carrier || 'carrier'}). ERD ${fields.erd_date || '—'}, cutoff ${fields.cutoff_date || '—'}. Check dashboard.`
            : `Booking ${bkg} updated from ${from} — ERD ${fields.erd_date || '—'}, cutoff ${fields.cutoff_date || '—'}.`;
        try { await sendToManager(line); } catch (err) { console.error('[EMAIL-INTAKE] Manager notify failed:', err.message); }
    }

    await appendAuditLog({
        source: 'email_intake', bkgNo: bkg,
        intent: isNew ? 'booking_created' : 'booking_updated',
        resolvedBy: 'ai', actionTaken: isNew ? 'created' : 'updated',
        from, subject, fields,
    });

    await markProcessed(gmail, msgMeta.id);
    console.log(`[EMAIL-INTAKE] ${isNew ? 'Created' : 'Updated'} ${bkg} from "${subject}"`);
}

// Called from scheduler.js's cron job — takes sendToManager as a parameter,
// same pattern morningDigest/urgentWatch/autoArchive already use.
async function checkBookingEmails(sendToManager) {
    const query = senderQuery();
    if (!query) {
        console.warn('[EMAIL-INTAKE] settings.booking_email_senders is empty — nothing to scan. Set it via PUT /api/settings.');
        return;
    }

    let gmail, due;
    try {
        gmail = getGmail();
        due = await listMessages(gmail, `is:unread has:attachment (${query})`, 20);
    } catch (err) {
        console.error('[EMAIL-INTAKE] Gmail list failed:', err.message);
        return;
    }

    for (const m of due) {
        try {
            await processOneMessage(gmail, m, sendToManager);
        } catch (err) {
            console.error(`[EMAIL-INTAKE] Failed processing message ${m.id}:`, err.message);
        }
    }
}

module.exports = { checkBookingEmails };