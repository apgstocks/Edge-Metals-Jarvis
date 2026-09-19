// ── helpers/shipmentMail.js — who a container's documents go to, and what ───
// ── the message says ────────────────────────────────────────────────────────
//
// Lifted out of workflow/actions.js's sendShipmentDocsForConfirm on
// 2026-09-19, unchanged, because a SECOND caller arrived: Apsara asked for
// Generate on a Sale row to show her the invoice and then the draft email
// before anything is sent.
//
// ── WHY EXTRACT RATHER THAN WRITE IT TWICE ──────────────────────────────────
// The alternative was a second copy of "work out the customer, resolve the
// contact, write the subject and body". Two copies of that would drift, and
// the day they drift is the day the email she READ on screen is not the email
// that went out. This file is the single answer; actions.js and the web route
// both ask it.
//
// ── EVERY MESSAGE HERE IS VERBATIM FROM actions.js ──────────────────────────
// Including the "say it like this" instructions, which are phrased for
// WhatsApp because that is where they were written and where they are still
// read. They are not re-worded in this move: a refactor that also edits the
// words is a refactor you cannot verify by diffing behaviour, and
// tests/shipment-docs-send.js asserts several of them by their text.
//
// ── PHOTOS ARE OPT-IN, AND THE FLAG SAYS "NEW SHAPE" ────────────────────────
// The web flow puts the loading photos in the body as links (her answer on
// 2026-09-19: links, not attachments — phone photos of a loading bay bounce a
// message for size). The WhatsApp path never had them and must not grow them
// silently, so `photos` defaults to none and the caller that wants them says
// so. That direction is deliberate: CLAUDE.md's rule is that a flag marks the
// NEW shape, never the old one, because a flag you must set to keep an
// existing document unchanged will eventually not be set.

const cfg = require('../config');

// The reasons a draft cannot be built. Exported so a caller can branch on a
// value rather than on a substring of a sentence meant for a human.
const REASONS = ['no_container', 'none', 'incomplete', 'no_customer',
                 'no_contact', 'ambiguous_contact', 'no_address'];

function no(reason, message, extra = {}) {
    return { ok: false, reason, message, ...extra };
}

// ── THE DRAFT ───────────────────────────────────────────────────────────────
// Reads what is on disk; writes nothing and sends nothing. Every failure is a
// reason plus the sentence to show, because "I couldn't" with no cause is a
// round trip.
//
// consigneeOverride exists for her "send HMMU7060866 to Eccomelt" — the
// documents are on file but carry no customer, and she names one.
function draftFor(containerNo, { photos = [], consignee: consigneeOverride = null } = {}) {
    const shipmentDocs = require('./shipmentDocs');
    const container = String(containerNo || '').trim();
    if (!container) {
        return no('no_container', 'Which container? Say it like "send the documents for HMMU7060866".');
    }

    const found = shipmentDocs.findForContainer(container);
    if (!found) {
        // Deliberately does NOT offer to generate one. She asked to send what
        // she made and checked; building a document at send time would email
        // a buyer something she has never seen.
        return no('none', `No invoice or packing list on file for ${container.toUpperCase()}. Generate it in Documents first, then tell me to send it.`);
    }
    if (!found.invoice) {
        return no('incomplete', `There's a packing list for ${found.container} but no invoice. I haven't sent anything — generate the invoice in Documents first.`, { found });
    }

    // ── WHO IT GOES TO ──────────────────────────────────────────────────────
    // She names a container; a container does not carry a customer. The
    // consignee comes off the invoice's own version history, so the name used
    // here is the one printed on the document being sent.
    const consignee = String(consigneeOverride || found.consignee || '').trim();
    if (!consignee) {
        return no('no_customer', `I have the documents for ${found.container} but no customer recorded against them, so I can't work out who to send to. Tell me the name — "send ${found.container} to Eccomelt" — and I'll use that.`, { found });
    }

    const { resolveContact } = require('./emailContacts');
    const resolved = resolveContact(consignee);
    if (!resolved) {
        return no('no_contact', `${consignee} isn't in Email Contacts, so I don't have an address for them. Add them there and say "send the documents for ${found.container}" again.`, { found, consignee });
    }
    if (resolved.type === 'ambiguous') {
        const names = (resolved.matches || []).map((c) => `${c.name} <${c.email}>`).join('\n  ');
        return no('ambiguous_contact', `More than one contact for ${consignee}:\n  ${names}\n\nSay which — "send the documents for ${found.container} to <name>".`,
                  { found, consignee, matches: resolved.matches || [] });
    }
    const contact = resolved.contact;
    if (!contact || !contact.email) {
        return no('no_address', `I found ${consignee} in Email Contacts but there's no address saved against them.`, { found, consignee });
    }

    const invLabel = found.inv_no ? `Invoice ${found.inv_no}` : 'Invoice';
    const subject = `${invLabel} — ${found.container}`;
    const attachments = [found.invoice.filename, found.packing && found.packing.filename].filter(Boolean);

    // ── THE BODY ────────────────────────────────────────────────────────────
    // The first four lines are exactly what actions.js has always sent. The
    // photo block is appended AFTER the sentence about the documents and
    // BEFORE the sign-off, and only when the caller passed links — so with no
    // photos the body is byte-identical to the one this replaced.
    const links = (Array.isArray(photos) ? photos : []).map((p) => String(p || '').trim()).filter(Boolean);
    const body = [
        `Dear ${contact.name || consignee},`,
        '',
        `Please find attached the ${found.packing ? 'invoice and packing list' : 'invoice'} for container ${found.container}${found.inv_no ? ` (${invLabel})` : ''}.`,
        ...(links.length ? ['', links.length === 1 ? 'Loading photo:' : 'Loading photos:', ...links] : []),
        '',
        'Kind regards,',
        cfg.COMPANY_NAME || 'Edge Trading',
    ].join('\n');

    // ── ANYTHING ODD ABOUT THE DOCUMENT SET ─────────────────────────────────
    // Returned so the caller can put them ABOVE the question, not after it —
    // the rule actions.js already followed: a warning under the Send button is
    // one she reads afterwards.
    const warnings = [];
    if (found.missing.includes('packing list')) {
        warnings.push(`No packing list on file for ${found.container} — only the invoice will go.`);
    }
    if (found.hasPackingInside) {
        warnings.push('That invoice has its packing list bound into the same file.');
    }
    // The pair came from two different days. shipmentDocs will only do this
    // when the invoice's own folder had no packing list at all, and it is the
    // one case where documents filed on different dates are put in the same
    // email — so it is named here, where she can still say no.
    if (found.packingFromDate) {
        warnings.push(`The packing list is filed under ${found.packingFromDate}, not with the invoice (${found.date}) — check it is the right one.`);
    }
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    if (found.date !== today) {
        // She may be looking at a document she generated minutes ago while
        // this picks up an older one — worth one line rather than a surprise.
        warnings.push(`These were generated on ${found.date}.`);
    }

    return {
        ok: true,
        found,
        container: found.container,
        inv_no: found.inv_no || null,
        consignee,
        contact,
        to: contact.email,
        name: contact.name || consignee,
        // Their standing Cc, same as every other email to this contact gets —
        // the people who are always copied on that customer's paperwork.
        // Resolved by the caller, which owns mergeCc's precedence rules.
        contact_cc: contact.cc || null,
        subject,
        body,
        attachments,
        photos: links,
        warnings,
    };
}

module.exports = { draftFor, REASONS };
