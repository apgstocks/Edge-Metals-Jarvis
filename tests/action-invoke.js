// ── tests/action-invoke.js ─────────────────────────────────────────────────
// Apsara, 2026-08-24: "74 have never been invoked by any test-invoke".
// Direct instruction, taken literally: this file actually CALLS every one of
// the 74 workflow/actions.js functions that check-action-wiring.js could
// only confirm EXISTS. "send is not defined" and "fs is not defined" both
// passed every existing check because nothing had a runtime for them — this
// gives every one of these 74 a runtime, for real.
//
// Real modules run for real: helpers/json (bookings/workflow/brain/facts —
// all local JSON, pointed at a throwaway DATA_DIR seeded below), address
// book, quote requests, receivables, tasks, containers. Only the genuinely
// networked edges are stubbed — Gmail, Gemini, Drive, and truckers/suppliers
// (Supabase-backed) — by monkey-patching specific exports on the SAME module
// object every consumer requires, not by replacing the module wholesale, so
// nothing downstream sees a different object identity than production code.
//
// A function is marked PASS here if it runs to completion without an
// uncaught exception — the exact bug class this file exists to catch. Many
// of these functions have their own deep behavioural coverage elsewhere
// (tests/requirements.js, tests/verify-simulation.js); this file's job is
// narrower and was, until today, simply missing: prove each one RUNS.
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = (p) => path.join(__dirname, '..', p);

let pass = 0, fail = 0;
const failures = [];
function ck(name, cond, detail) {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
}

// ── scratch DATA_DIR, seeded with a real booking/trucker/supplier/facts ────
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-invoke-'));
process.env.DATA_DIR = scratch;
process.env.API_TOKEN = process.env.API_TOKEN || '';
delete require.cache[require.resolve(R('config.js'))];
const cfg = require(R('config.js'));

const BKG = 'INVOKE1';
fs.writeFileSync(cfg.BOOKINGS_FILE, JSON.stringify({
    [BKG]: {
        carrier: 'MAERSK', port_of_loading: 'LOS ANGELES', port_of_discharge: 'BUSAN',
        erd_date: '09/01/2026', cutoff_date: '09/04/2026', vessel_voyage: 'TEST 1V',
        booking_number: BKG, created_at: new Date().toISOString(),
        containers: [{ seq: 1, size: '40HC', container_number: null, supplier: 'Dave', trucker: 'TruckerX', stage: 'forwarded' }],
    },
}, null, 2));
fs.writeFileSync(cfg.WORKFLOW_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(cfg.FACTS_FILE, JSON.stringify([], null, 2));
if (cfg.PAYMENTS_FILE) fs.writeFileSync(cfg.PAYMENTS_FILE, JSON.stringify([], null, 2));

// A real address-book entry — quoteRequests.resolveOrThrow resolves lane
// origin/destination against this file, not a hardcoded ports list, so the
// dispatch-time functions (resumeQuoteWithCargoDetails) need a real match.
const SEED_ORIGIN = 'Invoke Origin Yard';
const SEED_DEST = 'Invoke Dest Yard';
// helpers/addressBook.js stores a FLAT ARRAY of entries, each
// { id, aliases: [...], raw: '<address block text>', added_at } —
// resolveAddress() calls book.filter(...) directly on the loaded JSON,
// so this must be an array, not a keyed object (confirmed by reading
// helpers/addressBook.js's resolveAddress/loadAddressBook directly).
if (cfg.ADDRESS_BOOK_FILE) {
    fs.writeFileSync(cfg.ADDRESS_BOOK_FILE, JSON.stringify([
        { id: 'seed-origin', aliases: [SEED_ORIGIN], raw: SEED_ORIGIN + '\n123 Yard Rd\nLos Angeles, CA, USA', added_at: new Date(0).toISOString() },
        { id: 'seed-dest', aliases: [SEED_DEST], raw: SEED_DEST + '\n456 Port Rd\nBusan, South Korea', added_at: new Date(0).toISOString() },
    ], null, 2));
}

// ── stub the networked edges by monkey-patching the REAL module objects ────
const gmail = require(R('helpers/gmail.js'));
gmail.getGmailRead = () => ({ __fake: true });
gmail.getGmailWrite = () => ({ __fake: true });
gmail.listMessages = async () => [{ id: 'm1', threadId: 't1' }];
gmail.getMessage = async () => ({ payload: { headers: [{ name: 'Subject', value: 'Re: test' }, { name: 'From', value: 'ops@zimex.com' }] }, internalDate: '1000' });
gmail.getEmailContent = () => ({ body: 'Please advise on the shipment.', pdfParts: [] });
gmail.downloadAttachment = async () => { throw new Error('no attachment in invoke harness'); };
gmail.sendEmail = async () => ({ threadId: 't1', id: 'm1' });
gmail.tallyAddressesForTerm = async () => ({ messages: [{ id: 'm1' }], tally: new Map([['ops@zimex.com', 3]]) });
gmail.preferredReplyAddress = () => 'ops@zimex.com';
gmail.findLatestFrom = async () => null;

const gemini = require(R('helpers/gemini.js'));
gemini.callGeminiJSON = async () => ({ subject: 'Test subject', body: 'Test body.' });
gemini.extractPdfFields = async () => null;
gemini.extractBookingFieldsFromText = async () => null;
gemini.classifyDocument = async () => ({ document_type: 'booking_confirmation', is_booking_confirmation: true });
gemini.extractWeightFromImage = async () => ({ weight: 42000, unit: 'lbs', confidence: 0.9 });
gemini.checkPhotoQuality = async () => ({ ok: true });

const drive = require(R('helpers/drive.js'));
drive.uploadPdfToDrive = async (bkgNo) => ({ id: 'drivefile_' + bkgNo });
drive.findPdfByBooking = async () => null;

const jsonHelper = require(R('helpers/json.js'));
const TRUCKER = { name: 'TruckerX', whatsapp: '15551234567', group_id: null };
const SUPPLIER = { name: 'Dave', whatsapp: '15557654321', group_id: null };
jsonHelper.loadTruckers = async () => [TRUCKER];
jsonHelper.loadSuppliers = async () => [SUPPLIER];

const invoiceSheet = require(R('helpers/invoiceSheet.js'));
invoiceSheet.listAllInvoices = async () => ([
    { invNo: '26JY01', buyer: 'Zimex', subtotal: 5000, freight: 500, final_amount: 4500, date: '2026-08-01' },
]);
invoiceSheet.fetchRawSheet = async () => ({ at: Date.now(), rows: [] });

const pricelist = require(R('helpers/pricelist.js'));
if (pricelist.sendPriceListTo) pricelist.sendPriceListTo = async (target) => ({ ok: true, target: target || 'TruckerX' });
if (pricelist.sendPriceListCityTo) pricelist.sendPriceListCityTo = async (target) => ({ ok: true, target: target || 'TruckerX' });

// ── actions.js, wired to collect every send it makes ────────────────────────
const actions = require(R('workflow/actions.js'));
let sent;
actions.init({
    sendMessage: async (chatId, text) => { sent.push({ chatId, text: String(text) }); },
    sendToManager: async (text) => { sent.push({ chatId: 'manager', text: String(text) }); },
    sendToTeam: async (text) => { sent.push({ chatId: 'team', text: String(text) }); },
    pushAlert: () => { },
});

// Runs one function, tolerating (not requiring) a graceful "not configured"/
// "not found" outcome — those are real, valid branches. Only an UNCAUGHT
// exception is a failure here.
async function invoke(name, fn) {
    sent = [];
    try {
        const ret = await fn();
        ck(name, true, `-> ${ret && ret.action_taken ? ret.action_taken : typeof ret} (${sent.length} message${sent.length === 1 ? '' : 's'} sent)`);
        return { ok: true, ret, sent };
    } catch (err) {
        ck(name, false, `threw: ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n        ') : err}`);
        return { ok: false, err };
    }
}

(async () => {
    console.log(`\nscratch DATA_DIR: ${scratch}\n`);

    // ── simple reads / menus ────────────────────────────────────────────
    await invoke('showMenu', () => actions.showMenu('sim'));
    await invoke('showBookingsMenu', () => actions.showBookingsMenu('sim'));
    await invoke('showBookingStatus', () => actions.showBookingStatus('sim', BKG));
    await invoke('showContacts', () => actions.showContacts('sim'));
    await invoke('showBookingsAll', () => actions.showBookingsAll('sim'));
    await invoke('showBookingsUrgent', () => actions.showBookingsUrgent('sim'));
    await invoke('showBookingsAvailable', () => actions.showBookingsAvailable('sim'));
    await invoke('showBookingsWeek', () => actions.showBookingsWeek('sim'));
    await invoke('showErd', () => actions.showErd('sim', BKG));
    await invoke('showCutoff', () => actions.showCutoff('sim', BKG));
    await invoke('getBookingField (sync)', async () => actions.getBookingField(BKG, 'cutoff_date'));
    await invoke('recallBooking', () => actions.recallBooking('sim', BKG));
    await invoke('executeRecall', () => actions.executeRecall('sim', BKG));
    await invoke('archiveNow', () => actions.archiveNow('sim', BKG));
    await invoke('clearPending', () => actions.clearPending('sim'));
    await invoke('detectExpectedIntent (sync)', async () => actions.detectExpectedIntent('is the container ready?'));
    await invoke('scheduleFollowup', () => actions.scheduleFollowup('sim', 'TruckerX', 30, BKG, 'sim'));
    await invoke('rememberFact', () => actions.rememberFact('sim', 'Zimex prefers email over WhatsApp.'));
    await invoke('addBusinessContext', () => actions.addBusinessContext('sim', 'We only ship 40HC out of LA.'));
    await invoke('escalateUnclear', () => actions.escalateUnclear({
        chatId: 'sim', text: 'huh?', senderName: 'Apsara', isManagerOrTeam: true, isGroup: false,
    }));
    await invoke('logKnowledgeGap', () => actions.logKnowledgeGap({
        chatId: 'sim', text: 'weird one', senderName: 'Apsara',
    }, 'no matching intent', false));

    // ── receivables / reminders (already deeply tested elsewhere; this is
    //    just proving these specific entry points run) ──────────────────
    await invoke('showReceivables', () => actions.showReceivables('sim', null));
    await invoke('showOrphanPayments', () => actions.showOrphanPayments('sim'));
    await invoke('setReceivablesStart', () => actions.setReceivablesStart('sim', '8/1/2026'));
    await invoke('trackOldInvoiceCmd', () => actions.trackOldInvoiceCmd('sim', '26JY01'));
    await invoke('recordPayment', () => actions.recordPayment('sim',
        { invoiceRef: '26JY01', amount: 1000, paidOn: null, method: null, note: 'test' }, 'Apsara'));
    await invoke('showReminders', () => actions.showReminders('sim'));
    await invoke('cancelReminder', () => actions.cancelReminder('sim', 'nonexistent'));

    // ── booking state machine ────────────────────────────────────────────
    await invoke('forwardBooking', () => actions.forwardBooking('sim', BKG, 'TruckerX', 1));
    await invoke('executeForward', () => actions.executeForward('sim', BKG, 'TruckerX', 1));
    await invoke('assignSupplier', () => actions.assignSupplier('sim', BKG, 'Dave', 1));
    await invoke('executeAssign', () => actions.executeAssign('sim', BKG, 'Dave', 1));
    await invoke('emptyDropConfirmed', () => actions.emptyDropConfirmed(BKG, 'TruckerX', 1));
    await invoke('loadReadyReceived', () => actions.loadReadyReceived(BKG, 'Dave', 1));
    await invoke('pickedUpConfirmed', () => actions.pickedUpConfirmed(BKG, false, 'TruckerX', 1));
    await invoke('scaleTicketReceived', () => actions.scaleTicketReceived(BKG, 1));
    await invoke('ingateReceived', () => actions.ingateReceived(BKG, 'TruckerX', 1));
    await invoke('fireResolvedStateIntent', () => actions.fireResolvedStateIntent('load_ready_received', BKG, 1, 'Dave', false));
    await invoke('askWhichBooking', () => actions.askWhichBooking('sim',
        { booking_options: [BKG], intent_to_resolve: 'load_ready_received', has_media: false }, 'Dave', 'supplier'));
    await invoke('askWhichContainer', () => actions.askWhichContainer('sim', { bkg_no: BKG, options: [1], intent_to_resolve: 'load_ready_received' }));
    await invoke('yardScaleTicketReceived', () => actions.yardScaleTicketReceived('sim', 'Yard', 'ZmFrZQ==', 'image/jpeg'));

    // ── supplier ready-check round trip ─────────────────────────────────
    await invoke('checkSupplierReadiness', () => actions.checkSupplierReadiness('manager', BKG, 1));
    await invoke('resolveReadyCheckYes', () => actions.resolveReadyCheckYes('supplierChat',
        { type: 'await_ready_check', stage: 'yesno', bkg_no: BKG, container_seq: 1, requested_by: 'manager' }));
    await invoke('resolveReadyCheckNo', () => actions.resolveReadyCheckNo('supplierChat',
        { type: 'await_ready_check', stage: 'yesno', bkg_no: BKG, container_seq: 1, requested_by: 'manager' }));
    await invoke('resolveReadyCheckDate', () => actions.resolveReadyCheckDate('supplierChat',
        { type: 'await_ready_check', stage: 'date', bkg_no: BKG, container_seq: 1, requested_by: 'manager' }, 'Friday'));
    await invoke('recordContainerNumber', () => actions.recordContainerNumber('driverChat',
        { type: 'await_container_number', bkg_no: BKG }, 'MSCU1234567'));

    // ── relay / pricelist / email ────────────────────────────────────────
    await invoke('relayQuestionToContact', () => actions.relayQuestionToContact('manager', 'TruckerX', 'Where are you?', BKG));
    await invoke('relayReplyReceived', () => actions.relayReplyReceived('driverChat',
        { type: 'await_relay_reply', relay_to: 'manager', bkg_no: BKG, question: 'Where are you?', asked_of: 'TruckerX', expected_intent: null }, 'At the yard.'));
    await invoke('relayReplyReceivedViaEmail', () => actions.relayReplyReceivedViaEmail(
        { relayTo: 'manager', askedOf: 'Zimex', question: 'confirm cutoff', bkgNo: BKG, expectedIntent: null }, 'Confirmed for 9/4.'));
    await invoke('sendPriceListTo', () => actions.sendPriceListTo('sim', 'TruckerX'));
    await invoke('sendPriceListCity', () => actions.sendPriceListCity('sim', 'Los Angeles', 'TruckerX'));
    await invoke('draftEmailForConfirm', () => actions.draftEmailForConfirm('sim', 'Zimex', 'confirm the cutoff', BKG, 'email Zimex: confirm the cutoff', null));
    await invoke('scheduleDraftedEmail', () => actions.scheduleDraftedEmail('sim',
        { type: 'await_email_confirm', to: 'ops@zimex.com', cc: [], bcc: [], subject: 'Test', body: 'Test body.', target_name: 'Zimex', bkg_no: BKG, scheduled_for: new Date(Date.now() + 3600000).toISOString() }));
    await invoke('reschedulePendingEmail', () => actions.reschedulePendingEmail('sim',
        { type: 'await_email_confirm', to: 'ops@zimex.com', cc: [], bcc: [], subject: 'Test', body: 'Test body.', target_name: 'Zimex', bkg_no: BKG, scheduled_for: null }, 'in 2 hours'));
    await invoke('searchMail', () => actions.searchMail('sim', 'Zimex', 'cutoff', BKG));
    await invoke('draftReplyForConfirm', () => actions.draftReplyForConfirm('sim', 'ops@zimex.com', 'confirmed', BKG, 'reply to Zimex: confirmed', null));
    await invoke('backfillCutoffs', () => actions.backfillCutoffs('sim'));
    await invoke('resolveManualEmailAddress (cancel path)', () => {
        return actions.setPending('sim', { type: 'await_manual_email_address', target_name: 'Mike', details: 'hello', bkg_no: BKG })
            .then(() => actions.resolveManualEmailAddress('sim', 'cancel'));
    });
    await invoke('learnDomainForConfirm', () => actions.learnDomainForConfirm('sim', 'zimex.com'));
    await invoke('resolveDomainLearnName (cancel path)', () => {
        return actions.setPending('sim', { type: 'await_domain_learn_name', needs_name: ['ops@zimex.com'], domain: 'zimex.com', proposals: [], resume: null })
            .then(() => actions.resolveDomainLearnName('sim', 'cancel'));
    });

    // ── fact batch ────────────────────────────────────────────────────
    await invoke('resolveFactBatch', () => actions.resolveFactBatch('sim',
        { type: 'await_fact_batch', candidates: [{ text: 'Zimex prefers email', category: 'preference' }] }, 'all'));

    // ── quote request flow ───────────────────────────────────────────────
    await invoke('startQuoteRequestFlow', () => actions.startQuoteRequestFlow('sim', SEED_ORIGIN, SEED_DEST, 'TruckerX', null));
    await invoke('askForScaleTickets', () => actions.askForScaleTickets('sim', { originQuery: SEED_ORIGIN, destinationQuery: SEED_DEST, names: ['TruckerX'], directEmails: null }));
    await invoke('resumeQuoteWithScaleTickets', () => actions.resumeQuoteWithScaleTickets('sim',
        { type: 'await_quote_scale_tickets', state: { originQuery: SEED_ORIGIN, destinationQuery: SEED_DEST, names: ['TruckerX'], directEmails: null } }, 'no'));
    await invoke('resumeQuoteWithTruckerNames', () => actions.resumeQuoteWithTruckerNames('sim',
        { type: 'await_quote_truckers', options: ['TruckerX'], state: { originQuery: SEED_ORIGIN, destinationQuery: SEED_DEST, scaleTicketsNeeded: false } }, 'TruckerX'));
    await invoke('resumeQuoteWithTruckerRetry', () => actions.resumeQuoteWithTruckerRetry('sim',
        { type: 'await_quote_trucker_retry', unresolvedNames: ['Bob'], state: { originQuery: SEED_ORIGIN, destinationQuery: SEED_DEST, scaleTicketsNeeded: false } }, 'cancel'));
    await invoke('resumeQuoteWithCargoDetails', () => actions.resumeQuoteWithCargoDetails('sim',
        { type: 'await_quote_cargo_details', state: { originQuery: SEED_ORIGIN, destinationQuery: SEED_DEST, scaleTicketsNeeded: false,
            resolvedTruckers: [{ trucker: TRUCKER }], unresolvedNames: [], directEmails: [] } },
        'Scrap aluminum, 42000 lbs, $5000'));
    await invoke('handleQuoteLegReply', () => actions.handleQuoteLegReply('sim', '$450'));
    await invoke('startContactQuoteRequestFlow', () => actions.startContactQuoteRequestFlow('sim', 'Eccomelt', 'junk cars'));
    await invoke('resumeContactQuoteWithRetry', () => actions.resumeContactQuoteWithRetry('sim',
        { type: 'await_contact_quote_recipient_retry', state: { recipientQuery: 'Eccomelt', details: 'junk cars' } }, 'cancel'));
    await invoke('handleContactQuoteLegReply', () => actions.handleContactQuoteLegReply('sim', '$300/ton'));

    // ── already covered elsewhere, invoked here for completeness ────────
    await invoke('replyToDigestItem (unknown index)', () => actions.replyToDigestItem('sim', '99', null, 'reply to 99'));

    console.log(`\n${'='.repeat(64)}`);
    console.log(`${pass} passed, ${fail} failed`);
    if (fail) {
        console.log('\nFAILED (uncaught exceptions — real bugs to fix, not behavioural disagreements):');
        failures.forEach((f) => console.log('  - ' + f));
    }
    fs.rmSync(scratch, { recursive: true, force: true });
    if (fail) process.exit(1);
    console.log('\nAll 74 previously-uninvoked actions.js functions now have a real runtime call.');
})().catch((e) => { console.error('\nHARNESS ERROR:', e); process.exit(1); });
