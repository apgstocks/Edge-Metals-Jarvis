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

// ── WHO THIS EMAIL IS FROM ──────────────────────────────────────────────────
// Apsara, 2026-09-19, reading a draft: "in kind regards,i dont want Edge
// Trading.It should be Jarvis,Edge Metals Inc."
//
// ── AND THIS IS WHY IT IS NOT A CONFIG CHANGE ───────────────────────────────
// It used to read `cfg.COMPANY_NAME || 'Edge Trading'`, and the obvious fix is
// to edit config.js. That would have been wrong, and expensively so:
// COMPANY_NAME is also the caption on every EDGE YARD load ticket (api.js
// ~5392) and the yard app pins it as BUYER_FIXED_NAME on every load
// (mobile-app/www/index.html). Edge Yard and Edge Metals are different
// companies — the separation is most of what this app is for — so one edit in
// config.js would have renamed the buyer on her yard paperwork to settle the
// sign-off on a metals invoice.
//
// This file only ever sends a container's INVOICE and packing list, which are
// Edge Metals documents. So the name is stated here, where the document's
// company is known, and cfg.COMPANY_NAME keeps meaning what it meant.
//
// She can also edit it per message now — the draft screen is a text box — so
// this is the default, not a rule.
const SIGN_OFF = ['Jarvis', 'Edge Metals Inc'];

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
// ── ADDRESSES TYPED IN, WHEN THE ADDRESS BOOK HAS NONE ──────────────────────
// Apsara, 2026-09-19, looking at "Edge Metals Recycling isn't in Email
// Contacts, so I don't have an address for them":
//
//     "if its in email contacts,it can take ..else it can ask for email
//      recipients separated by comma"
//
// Split on commas, semicolons and whitespace, because a list pasted out of
// somebody else's mail client arrives in all three. Anything that is not an
// address is REPORTED rather than quietly dropped: a typo'd address silently
// removed from a list of four is an invoice that three people receive and one
// does not, and nobody finds out.
// ── ONE LEFT-TO-RIGHT SCAN, BECAUSE ORDER IS MEANING ────────────────────────
// The first address is the addressee and the rest are copied, so the order she
// typed them in is not cosmetic. An earlier version split on whitespace first
// and then looked for angle brackets — which tore
//
//     "Ray" <ray@emr.example>
//
// into two tokens, reported `"Ray"` as a bad address, and refused the whole
// list. Anything that pulls the bracketed addresses out first and the bare
// ones after would fix that and shuffle the order, which is worse: it would
// silently change who the invoice is addressed to.
//
// So: one regex, scanned once, yielding either a bracketed address or a bare
// token in the position it was written.
const TOKEN = /"[^"]*"\s*<([^>]*)>|<([^>]*)>|([^\s,;<>]+)/g;
function parseRecipients(input) {
    const { isValidEmail } = require('./emailContacts');
    const text = Array.isArray(input) ? input.join(', ') : String(input || '');
    const good = [], bad = [];
    TOKEN.lastIndex = 0;
    let m;
    while ((m = TOKEN.exec(text)) !== null) {
        const tok = String(m[1] ?? m[2] ?? m[3] ?? '').trim().replace(/^"|"$/g, '');
        if (!tok) continue;
        // Reported, never quietly dropped: one address silently removed from a
        // list of four is an invoice that three people receive and one does
        // not, and nobody finds out.
        if (isValidEmail(tok)) { if (!good.includes(tok)) good.push(tok); }
        else if (!bad.includes(tok)) bad.push(tok);
    }
    return { good, bad };
}

function draftFor(containerNo, { photos = [], consignee: consigneeOverride = null,
                                 recipients = null } = {}) {
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

    // ── ADDRESSES SHE TYPED WIN OVER THE ADDRESS BOOK ───────────────────────
    // Not "fall back to": if she has just typed a list, that list is the
    // answer and the lookup is not consulted at all. The lookup is what failed
    // and sent her to the box.
    //
    // `saveAs` tells the caller this contact did not exist and is worth
    // storing — her "then it should get stored in email contacts tab". This
    // file does not write it: it reads what is on disk and builds a draft,
    // and a function that quietly saves a contact while answering a question
    // about an email is a function nobody expects to have written anything.
    let contact = null;
    let saveAs = null;
    const typed = recipients === null || recipients === undefined
        ? null : parseRecipients(recipients);
    if (typed && typed.bad.length) {
        return no('bad_recipients',
                  `These don't look like email addresses: ${typed.bad.join(', ')}. Separate them with commas.`,
                  { found, consignee, bad: typed.bad });
    }
    if (typed && typed.good.length) {
        // The first is the addressee, the rest are copied — the same shape an
        // Email Contacts entry has, so storing it needs no translation.
        contact = { name: consignee, email: typed.good[0], cc: typed.good.slice(1) };
        saveAs = { name: consignee, email: typed.good[0], cc: typed.good.slice(1) };
    } else {
        const { resolveContact } = require('./emailContacts');
        const resolved = resolveContact(consignee);
        if (!resolved) {
            // `ask_recipients` is what the screen keys on to show the box. The
            // sentence keeps its WhatsApp wording, where there is no box and
            // adding them in the tab really is the next step.
            return no('no_contact', `${consignee} isn't in Email Contacts, so I don't have an address for them. Add them there and say "send the documents for ${found.container}" again.`,
                      { found, consignee, ask_recipients: true });
        }
        if (resolved.type === 'ambiguous') {
            const names = (resolved.matches || []).map((c) => `${c.name} <${c.email}>`).join('\n  ');
            return no('ambiguous_contact', `More than one contact for ${consignee}:\n  ${names}\n\nSay which — "send the documents for ${found.container} to <name>".`,
                      { found, consignee, matches: resolved.matches || [] });
        }
        contact = resolved.contact;
        if (!contact || !contact.email) {
            return no('no_address', `I found ${consignee} in Email Contacts but there's no address saved against them.`,
                      { found, consignee, ask_recipients: true });
        }
    }

    const invLabel = found.inv_no ? `Invoice ${found.inv_no}` : 'Invoice';
    const subject = `${invLabel} — ${found.container}`;
    const attachments = [found.invoice.filename, found.packing && found.packing.filename].filter(Boolean);

    // ── THE BODY, AND WHY ITS LINES ARE SHORT ───────────────────────────────
    //
    // Apsara, 2026-09-19, with a screenshot of a sentence broken after the
    // word "(Invoice": "why the line is getting wrapped..please find the
    // attached ->That line".
    //
    // Arithmetic, not a quirk. The sentence was ONE line and it was too long:
    //
    //     ...for container MSKU1629380 (Invoice 260904_AC_26JY103).   87 chars
    //     ...invoice and packing list... (Invoice ...).              104 chars
    //
    // This goes out as text/plain, and RFC 5322 says a line SHOULD be at most
    // 78 characters — so Gmail wraps it, at 78, wherever 78 happens to fall.
    // On her screenshot that was mid-parenthetical, which is why it looked
    // broken rather than merely long. Nothing in helpers/gmail.js wraps the
    // body; the reader's client does.
    //
    // So the invoice number gets its own line. That takes the longest form
    // down to 76 and reads better besides — an invoice number on its own line
    // is one a buyer can copy. Container numbers are always eleven characters
    // (four letters, seven digits), so 76 is stable rather than lucky.
    //
    // ── WHAT THIS DOES NOT FIX ──────────────────────────────────────────────
    // Her own edits. The body is a text box now, and a long paragraph typed
    // into it will wrap at 78 exactly the same way. The structural answer to
    // that is sending HTML, which reflows to whatever width the reader's
    // window is — a change to helpers/gmail.js's shared encoder, so it needs
    // her yes rather than my initiative.
    const links = (Array.isArray(photos) ? photos : []).map((p) => String(p || '').trim()).filter(Boolean);
    const body = [
        `Dear ${contact.name || consignee},`,
        '',
        `Please find attached the ${found.packing ? 'invoice and packing list' : 'invoice'} for container ${found.container}.`,
        // NOT `${invLabel} no:` — invLabel already carries the number, so
        // that reads "Invoice 260904_AC_26JY103 no: 260904_AC_26JY103".
        ...(found.inv_no ? [`Invoice no: ${found.inv_no}`] : []),
        ...(links.length ? ['', links.length === 1 ? 'Loading photo:' : 'Loading photos:', ...links] : []),
        '',
        'Kind regards,',
        ...SIGN_OFF,
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
        // Non-null means these addresses came from her, not from the address
        // book, and the caller should offer to keep them. The caller does the
        // writing — see the note above.
        save_as: saveAs,
        subject,
        body,
        attachments,
        photos: links,
        warnings,
    };
}

module.exports = { draftFor, parseRecipients, REASONS };
