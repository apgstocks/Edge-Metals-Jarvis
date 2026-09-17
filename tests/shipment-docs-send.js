// ── tests/shipment-docs-send.js — END TO END ──────────────────────────────
// Apsara, 2026-09-17: "now once the invoice and packing list is created -when
// i give command to jarvis to send--->it should able to mail customer with
// documents.."
//
// And, the rule this file exists to satisfy — Apsara, 2026-09-17: "ALwyas
// test end to end when you add a new feature."
//
// tests/shipment-docs.js proves the helper finds the right two files.
// It cannot prove any of the things that actually break:
//
//   the words she types do not reach the action (brain.js routes them to
//     draft_email, which cannot attach anything);
//   the action stages a pending the confirm path does not recognise, so
//     "yes" does nothing;
//   the attachments never reach sendEmail, and a customer gets a cheerful
//     covering note with no invoice on it;
//   the PDFs arrive CORRUPT, because a Buffer was carried across a pending
//     that is persisted as JSON and came back as {type:'Buffer',data:[…]}.
//
// So this drives the real string through the real router, into the real
// action, through the real confirm, and inspects what the real send path was
// handed. Only helpers/gmail is faked — that is the one thing that must not
// actually happen.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// DATA_DIR FIRST — see the header of tests/integration.js for the damage this
// prevents. config.js reads it once, at load, and caches.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-shipsend-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const R = (m) => path.join(__dirname, '..', m);
const cfg = require(R('config'));
if (!String(cfg.DATA_DIR).startsWith(os.tmpdir())) {
    console.error('REFUSING TO RUN: DATA_DIR is not a temp directory — this test writes.');
    process.exit(1);
}

// ── Fixtures ────────────────────────────────────────────────────────────────
function put(date, container, filename, body) {
    const dir = path.join(cfg.DOCUMENTS_SAVED_DIR, 'invoice', date, container);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), body || `%PDF-1.4 ${filename}\n%%EOF`);
}
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
put(TODAY, 'HMMU7060866', 'EM1047_INVOICE.pdf', '%PDF-1.4 INVOICE BYTES\n%%EOF');
put(TODAY, 'HMMU7060866', 'EM1047_PACKING_LIST.pdf', '%PDF-1.4 PACKING BYTES\n%%EOF');
put(TODAY, 'MSCU1112223', 'EM1099_INVOICE.pdf');   // no packing list

// ── Stub only the things that would leave the building ──────────────────────
let SENT = [], MSGS = [], THROW_SEND = false;
const orig = Module._load;
Module._load = function (r) {
    if (r.endsWith('helpers/gmail') || r === '../helpers/gmail') return {
        getGmailRead: () => ({}), getGmailSenderRead: () => ({}),
        getMyEmailAddress: async () => 'apsara@edgemetals.com',
        listMessages: async () => [], getMessage: async () => ({}), getEmailContent: () => ({ body: '' }),
        parseAddressList: () => [], parseEmailDate: (d) => d,
        sendEmail: async (p) => { if (THROW_SEND) throw new Error('smtp down'); SENT.push(p); return { id: 'm', threadId: 'th' }; },
    };
    if (r.endsWith('helpers/gemini')) return { callGeminiJSON: async () => ({}) };
    if (r.endsWith('helpers/emailThreads')) return { trackSentEmail: async () => {} };
    if (r.includes('whatsapp-web')) return {};
    return orig.apply(this, arguments);
};

const actions = require(R('workflow/actions'));
const brain = require(R('workflow/brain'));
const emailContacts = require(R('helpers/emailContacts'));
const { mutateJson } = require(R('helpers/json'));

// Capture what she would actually be shown.
actions.init({ sendMessage: async (c, m) => { MSGS.push(String(m)); }, sendToManager: async () => {}, sendToTeam: async () => {}, pushAlert: () => {} });

const CHAT = 'test@g.us';

(async () => {
    // Her Email Contacts tab — "i have some tab called email contacts".
    await emailContacts.addContact('eccomelt', 'brian@eccomelt.com');
    await emailContacts.setContactCc('eccomelt', ['docs@eccomelt.com']);
    await emailContacts.addContact('taewon', 'kim@taewon.co.kr');

    // The consignee the invoice route records against each container.
    await mutateJson(cfg.INVOICE_VERSIONS_FILE, {}, (raw) => {
        const o = (raw && typeof raw === 'object') ? raw : {};
        o['HMMU7060866'] = { inv_no: 'EM1047', container_no: 'HMMU7060866', consignee: 'Eccomelt' };
        o['MSCU1112223'] = { inv_no: 'EM1099', container_no: 'MSCU1112223', consignee: 'Taewon' };
        return o;
    });

    // ── A. Do her words reach this action at all? ───────────────────────────
    // The gap that makes every other check in this file meaningless.
    section('A. routing');

    const decide = async (text) => {
        const d = await brain.policyDecide({
            text, textLower: String(text).toLowerCase(),
            chatId: CHAT, session: {}, pendingAction: null,
            activeBooking: null, isManager: true, isManagerOrTeam: true, role: 'manager',
        });
        return d && d.intent;
    };

    ck('"send the documents for HMMU7060866" routes to send_shipment_docs',
        await decide('send the documents for HMMU7060866') === 'send_shipment_docs');
    ck('"email the invoice and packing list for HMMU7060866" routes there too',
        await decide('email the invoice and packing list for HMMU7060866') === 'send_shipment_docs');
    // A bare "send HMMU7060866" is DELIBERATELY not claimed — that form
    // already belongs to forward_booking, and taking it would change
    // behaviour Apsara did not ask to change. See the rule's own comment.
    ck('a bare "send HMMU7060866" is left to forward_booking',
        await decide('send HMMU7060866') === 'forward_booking',
        'the document rule hijacked a form that has forwarded bookings for months');
    ck('a container written with a space still routes',
        await decide('send the docs for HMMU 7060866') === 'send_shipment_docs');

    // ── PRECEDENCE, AND WHERE THE LINE IS ───────────────────────────────
    // "email eccomelt about HMMU7060866" names no document, and it reads
    // just as naturally as "write them a note about that container". It
    // stays draft_email — the behaviour it has always had.
    //
    // An earlier version of this check asserted the opposite, because I
    // preferred it. That was me widening the feature past what she asked
    // for, on a sentence whose meaning is genuinely open.
    ck('"email eccomelt about HMMU7060866" stays a plain email',
        await decide('email eccomelt about HMMU7060866') === 'draft_email');
    // But add a document word and it is unambiguous, and it must beat the
    // generic "email X about Y" rule that sits below it — that rule cannot
    // attach anything, so the customer would receive a covering note with
    // no invoice on it.
    ck('"email eccomelt the invoice for HMMU7060866" IS a document send',
        await decide('email eccomelt the invoice for HMMU7060866') === 'send_shipment_docs',
        'the generic email rule won — the customer would get no attachment');

    // And the other direction: things that must NOT be hijacked.
    ck('a plain email with no container is still draft_email',
        await decide('email eccomelt about the cutoff') === 'draft_email');
    ck('a BOL request is not hijacked',
        await decide('send the bol for HMMU7060866') !== 'send_shipment_docs');

    const routed = await brain.policyDecide({
        text: 'send the documents for hmmu7060866', textLower: 'send the documents for hmmu7060866',
        chatId: CHAT, session: {}, pendingAction: null, activeBooking: null, isManager: true, isManagerOrTeam: true, role: 'manager', isManagerOrTeam: true, role: 'manager',
    });
    ck('the container is uppercased and de-spaced on the way through',
        routed.data.container_no === 'HMMU7060866', JSON.stringify(routed.data));

    // ── B. The read-back, before anything is sent ───────────────────────────
    section('B. what she is shown before she says yes');

    MSGS = []; SENT = [];
    let r = await actions.sendShipmentDocsForConfirm(CHAT, 'HMMU7060866');
    ck('it stages rather than sends', r.action_taken === 'shipment_docs_staged', r.action_taken);
    ck('NOTHING was sent at this point', SENT.length === 0,
        'a customer was emailed before she confirmed');

    const prompt = MSGS.join('\n');
    ck('the read-back shows the REAL address, not just the name',
        prompt.includes('brian@eccomelt.com'),
        'a wrong contact is invisible unless the address is on screen');
    ck('the read-back names the invoice file', prompt.includes('EM1047_INVOICE.pdf'));
    ck('the read-back names the packing list file', prompt.includes('EM1047_PACKING_LIST.pdf'));
    ck('their standing Cc is shown', prompt.includes('docs@eccomelt.com'));
    ck('it asks for a yes', /yes\/no/i.test(prompt));

    // ── C. "yes" ────────────────────────────────────────────────────────────
    section('C. the send itself');

    MSGS = []; SENT = [];
    const pending = await actions.getPending(CHAT);
    ck('the pending is the ordinary email-confirm type, not a new one',
        pending && pending.type === 'await_email_confirm', pending && pending.type);
    ck('the pending carries the CONTAINER, not the bytes',
        pending.attach_container === 'HMMU7060866' && !pending.attachments,
        'a Buffer on a persisted pending arrives as a corrupt PDF');

    await actions.resolvePending(CHAT, pending, 'yes');

    ck('exactly one email went out', SENT.length === 1, `${SENT.length} sent`);
    const mail = SENT[0] || {};
    ck('it went to the customer', mail.to === 'brian@eccomelt.com', mail.to);
    ck('their standing Cc was carried', JSON.stringify(mail.cc || []).includes('docs@eccomelt.com'));
    ck('the subject names the invoice', /EM1047/.test(mail.subject || ''), mail.subject);
    ck('the subject names the container', /HMMU7060866/.test(mail.subject || ''), mail.subject);

    // THE POINT OF THE WHOLE FEATURE.
    const atts = mail.attachments || [];
    ck('BOTH DOCUMENTS ARE ATTACHED', atts.length === 2, `${atts.length} attached`);
    ck('the invoice is attached', atts.some((a) => a.filename === 'EM1047_INVOICE.pdf'));
    ck('the packing list is attached', atts.some((a) => a.filename === 'EM1047_PACKING_LIST.pdf'));
    ck('the attachments are real Buffers, not JSON husks',
        atts.every((a) => Buffer.isBuffer(a.content)),
        'this is what a Buffer looks like after a round trip through a pending');
    ck('the invoice bytes are the ones on disk',
        atts.find((a) => a.filename === 'EM1047_INVOICE.pdf').content.toString().includes('INVOICE BYTES'));
    ck('the packing bytes are the packing list, not the invoice again',
        atts.find((a) => a.filename === 'EM1047_PACKING_LIST.pdf').content.toString().includes('PACKING BYTES'),
        'the same file was attached twice under two names');
    ck('both are declared as PDFs', atts.every((a) => a.mimeType === 'application/pdf'));

    ck('she is told what actually went', MSGS.join('\n').includes('EM1047_INVOICE.pdf'),
        '"Sent." leaves no record of which invoice the customer received');

    // ── D. "no" ─────────────────────────────────────────────────────────────
    section('D. no');

    MSGS = []; SENT = [];
    await actions.sendShipmentDocsForConfirm(CHAT, 'HMMU7060866');
    const p2 = await actions.getPending(CHAT);
    await actions.resolvePending(CHAT, p2, 'no');
    ck('"no" sends nothing', SENT.length === 0);

    // ── E. Half a document set ──────────────────────────────────────────────
    // Her answer on attachments was "Invoice + packing list". A missing one is
    // said out loud ABOVE the prompt, not discovered by the customer.
    section('E. a container with no packing list');

    MSGS = []; SENT = [];
    await actions.sendShipmentDocsForConfirm(CHAT, 'MSCU1112223');
    const warn = MSGS.join('\n');
    ck('she is warned the packing list is missing', /no packing list/i.test(warn), warn.slice(0, 200));
    ck('the warning is above the prompt, not after it',
        warn.indexOf('packing list') < warn.lastIndexOf('yes/no'));
    const p3 = await actions.getPending(CHAT);
    await actions.resolvePending(CHAT, p3, 'yes');
    ck('it still sends the invoice alone', (SENT[0] || {}).attachments.length === 1);

    // ── F. The refusals ─────────────────────────────────────────────────────
    section('F. when it must not send');

    MSGS = []; SENT = [];
    r = await actions.sendShipmentDocsForConfirm(CHAT, 'NOSUCH1234567');
    ck('an unknown container sends nothing', SENT.length === 0);
    ck('and says so plainly', /no invoice or packing list/i.test(MSGS.join('\n')), MSGS.join('\n'));
    ck('it does NOT offer to generate one', !/generate.*for you|shall i (make|create)/i.test(MSGS.join('\n')),
        'building a document at send time emails a buyer something she never saw');

    // A customer with documents but no saved address.
    await mutateJson(cfg.INVOICE_VERSIONS_FILE, {}, (raw) => {
        raw['ONEU0000009'] = { inv_no: 'EM1100', consignee: 'Nobody Ltd' };
        return raw;
    });
    put(TODAY, 'ONEU0000009', 'EM1100_INVOICE.pdf');
    MSGS = []; SENT = [];
    r = await actions.sendShipmentDocsForConfirm(CHAT, 'ONEU0000009');
    ck('an unknown contact sends nothing', SENT.length === 0);
    ck('and points at Email Contacts', /email contacts/i.test(MSGS.join('\n')), MSGS.join('\n'));

    // ── G. A document deleted between the read-back and the yes ─────────────
    section('G. the document vanishes before she confirms');

    MSGS = []; SENT = [];
    await actions.sendShipmentDocsForConfirm(CHAT, 'HMMU7060866');
    const p4 = await actions.getPending(CHAT);
    const dir = path.join(cfg.DOCUMENTS_SAVED_DIR, 'invoice', TODAY, 'HMMU7060866');
    const stash = fs.readFileSync(path.join(dir, 'EM1047_INVOICE.pdf'));
    fs.unlinkSync(path.join(dir, 'EM1047_INVOICE.pdf'));
    MSGS = [];
    await actions.resolvePending(CHAT, p4, 'yes');
    ck('nothing is sent when the invoice is gone', SENT.length === 0,
        'an empty attachment went to a customer');
    ck('and she is told why', /aren't on file|not on file/i.test(MSGS.join('\n')), MSGS.join('\n'));
    fs.writeFileSync(path.join(dir, 'EM1047_INVOICE.pdf'), stash);

    // ── H. A send that fails ────────────────────────────────────────────────
    section('H. the send fails');

    MSGS = []; SENT = []; THROW_SEND = true;
    await actions.sendShipmentDocsForConfirm(CHAT, 'HMMU7060866');
    const p5 = await actions.getPending(CHAT);
    MSGS = [];
    await actions.resolvePending(CHAT, p5, 'yes');
    ck('a failed send is reported, not swallowed', /failed/i.test(MSGS.join('\n')), MSGS.join('\n'));
    ck('the documents are still on disk afterwards',
        fs.existsSync(path.join(dir, 'EM1047_INVOICE.pdf')),
        'a failed send must never cost her a document that already exists');
    THROW_SEND = false;

    // ── I. Nothing else changed ─────────────────────────────────────────────
    // CLAUDE.md rule 1. An ordinary email — the flow that has been running for
    // months — must go out byte-identically, with no attachments key bolted on.
    section('I. the existing plain email is untouched');

    MSGS = []; SENT = [];
    await actions.sendDraftedEmail(CHAT, {
        to: 'ops@zimex.com', subject: 'Cutoff', body: 'Confirmed.', target_name: 'Zimex',
    });
    ck('a plain email still sends', SENT.length === 1);
    ck('and carries NO attachments key value', !SENT[0].attachments,
        'an ordinary email grew an attachments field it never had');
    ck('and its reply line is unchanged', /^Sent to Zimex <ops@zimex\.com>\.$/.test(MSGS.join('\n').trim()),
        MSGS.join('\n'));

    console.log(`\n${pass} passed, ${fail} failed`);
    if (failures.length) console.log('Failures:\n  ' + failures.join('\n  '));
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
    process.exit(fail ? 1 : 0);
})().catch((e) => {
    console.error('CRASHED:', e && e.stack);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (x) {}
    process.exit(1);
});
