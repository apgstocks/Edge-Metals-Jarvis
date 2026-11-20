#!/usr/bin/env node
// ── scripts/bookings-vs-mail.js — compare every active booking to its newest mail ──
//   node scripts/bookings-vs-mail.js            # report only
//   node scripts/bookings-vs-mail.js --apply    # also write the differences (ERD, cutoff, ETD only)
// Reads Gmail (read-only) and Gemini; writes only with --apply, and only the
// three date fields, with the same guards as the live text-mail pass.
require('dotenv').config();
const path = require('path');
const ROOT = path.join(__dirname, '..');
const apply = process.argv.includes('--apply');
(async () => {
    const cfg = require(path.join(ROOT, 'config'));
    const gmail = require(path.join(ROOT, 'helpers/gmail'));
    const { loadBookings, mutateJson } = require(path.join(ROOT, 'helpers/json'));
    const { extractBookingFieldsFromText, extractPdfFields, classifyDocument } = require(path.join(ROOT, 'helpers/gemini'));
    const g = gmail.getGmailRead();
    const after = new Date(Date.now() - 60 * 86400000);
    const q = `after:${after.getFullYear()}/${after.getMonth() + 1}/${after.getDate()}`;
    const res = await require(path.join(ROOT, 'helpers/bookingsVsMail')).run({
        bookings: loadBookings(),
        search: (bkg) => gmail.listMessages(g, `${q} -from:me "${bkg}"`, 10),
        getInfo: async (m) => {
            const msg = await gmail.getMessage(g, m.id);
            const h = Object.fromEntries((msg.payload.headers || []).map((x) => [x.name, x.value]));
            const { body, pdfParts } = gmail.getEmailContent(msg.payload);
            return { subject: h.Subject || '', body, hasPdf: pdfParts.length > 0, at: Number(msg.internalDate) || 0 };
        },
        extract: (t) => extractBookingFieldsFromText(t).catch(() => null),
        // Same two-opinion trust gate as workflow/emailWatcher.js: only a PDF that BOTH
        // extraction and classification call a booking confirmation is believed.
        extractPdf: async (m) => {
            const msg = await gmail.getMessage(g, m.id);
            const { pdfParts } = gmail.getEmailContent(msg.payload);
            for (const part of pdfParts) {
                const att = await gmail.downloadAttachment(g, m.id, part);
                const ex = await extractPdfFields(att.base64).catch(() => null);
                if (!ex || !ex.is_booking_confirmation || !ex.booking_number) continue;
                const cl = await classifyDocument(att.base64).catch(() => null);
                if (cl && cl.is_booking_confirmation && !cl.is_invoice_or_other) return ex;
            }
            return null;
        },
        apply: apply ? async (bkg, changes, at) => {
            await mutateJson(cfg.BOOKINGS_FILE, {}, (all) => {
                if (!all[bkg]) return all;
                for (const c of changes) all[bkg][c.field] = c.to;
                if (at) all[bkg].dates_mail_at = new Date(at).toISOString();
                return all;
            });
        } : null,
    });
    console.log(`${res.checked} active booking(s) checked against mail from the last 60 days.\n`);
    console.log(`DIFFER FROM THE LATEST MAIL (${res.differs.length})${apply ? ' — applied unless marked stale' : ' — nothing written; add --apply to write'}`);
    for (const d of res.differs) {
        console.log(`  ${d.bkg}  [mail "${String(d.mail.subject).slice(0, 60)}", ${d.mail.at}]${d.mail.from_pdf ? '  (from the PDF)' : ''}${d.stale ? '  STALE — a newer mail was already applied' : ''}`);
        for (const c of d.changes) console.log(`      ${c.field}: ${c.from} -> ${c.to}${c.note ? '  (' + c.note + ')' : ''}`);
    }
    console.log(`\nMATCH THE MAIL (${res.same.length}): ${res.same.map((s) => s.bkg).join(', ') || '—'}`);
    console.log(`NO MAIL FOUND (${res.no_mail.length}): ${res.no_mail.join(', ') || '—'}`);
    console.log(`PDF MAIL THAT COULD NOT BE USED (${res.pdf_only.length}): ${res.pdf_only.join(', ') || '—'}`);
    console.log(`COULD NOT JUDGE (${res.skipped.length}):${res.skipped.length ? '' : ' —'}`);
    for (const k of res.skipped) console.log(`  ${k}: ${res.reasons[k]}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
