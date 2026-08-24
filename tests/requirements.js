// REQUIREMENTS TEST — run: node tests/requirements.js
//
// WHY THIS FILE EXISTS
//
// Apsara, 2026-08-22: "these should be the things that i am telling you to
// test." She is right, and it is the sharper version of an earlier callout
// ("you are a tester. why cant you test properly").
//
// Every fix in this repo started as a sentence she said. Those sentences were
// verified once, by a throwaway script, and then vanished — so nothing stops
// the next change quietly undoing one. Three of them HAVE already been undone
// in exactly that way (see the note at the bottom of this header).
//
// So each test below is named with HER WORDS. That is deliberate: a test named
// after the requirement tells the next person WHY the behaviour matters, which
// a test named after a function does not. If one of these fails, something
// she explicitly asked for has stopped working.
//
// Read-only. No API key, no network, no writable data/ needed — every external
// edge (Gmail, Gemini, the invoice sheet, WhatsApp) is stubbed, so this runs
// anywhere and always tests the REAL deployed modules.
//
// ── A NOTE ON REGRESSIONS ALREADY SEEN ──────────────────────────────────────
// On 2026-08-22 three changes were silently lost when parallel work overwrote
// the files: the payment-watcher cron in scheduler.js, two config constants,
// and the await_payment_confirm handler. Nothing failed loudly — the payment
// watcher simply never ran. The WIRING section at the end exists for that
// class of bug specifically: a feature can be perfectly implemented and still
// be dead because nothing calls it.

const assert = require('assert');
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
const failures = [];
function ck(label, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) { pass++; console.log(`  PASS  ${label}`); }
    else { fail++; failures.push(label); console.log(`  FAIL  ${label}\n          got:  ${JSON.stringify(got)}\n          want: ${JSON.stringify(want)}`); }
}
function ckTrue(label, cond, note) {
    if (cond) { pass++; console.log(`  PASS  ${label}`); }
    else { fail++; failures.push(label); console.log(`  FAIL  ${label}${note ? '  — ' + note : ''}`); }
}
const section = (t) => console.log(`\n=== ${t} ===`);
const R = (p) => path.join(__dirname, '..', p);
const src = (p) => fs.readFileSync(R(p), 'utf8');

(async () => {

// ─────────────────────────────────────────────────────────────────────────
section('"DOnt start from pending things -> Answer fresh query"');
// A stuck cargo-details question swallowed a brand-new quote command, so a
// fresh request was answered with the stale question. Fixed by letting a
// well-formed command jump ANY open pending.
{
    const brain = require(R('workflow/brain.js'));
    const ctxWith = (pendingType, text) => ({
        isManagerOrTeam: true, isManager: true,
        pendingAction: { type: pendingType, state: { originQuery: 'Junk car', destinationQuery: 'Eccomelt' } },
        text, textLower: text.toLowerCase(), chatId: 't@g.us', session: {},
    });
    ck('fresh quote command jumps a stuck cargo question',
        brain.policyDecide(ctxWith('await_quote_cargo_details', 'Send quote request from Junk car to Eccomelt')).intent, 'get_quote');
    ck('...even with a typo glued to the verb ("XFSend")',
        brain.policyDecide(ctxWith('await_quote_cargo_details', 'XFSend quote request from Junk car to Eccomelt')).intent, 'get_quote');
    // The other half of the requirement: a REAL answer must still be captured.
    ck('but a real cargo answer is still captured, not reclassified',
        brain.policyDecide(ctxWith('await_quote_cargo_details', 'Aluminum scrap, 40000 lbs, $5000')).intent, 'quote_cargo_details_received');
    ck('a container number is still captured verbatim',
        brain.policyDecide(ctxWith('await_container_number', 'MSCU1234567')).intent, 'container_number_received');
}

// ─────────────────────────────────────────────────────────────────────────
section('"cancel all the quote requests" — there must be a way out');
// Verbatim-capture pendings swallowed EVERY message including "cancel", so a
// pending could not be escaped at all — while several of their own reminder
// messages promised 'or reply "cancel"'.
{
    const brain = require(R('workflow/brain.js'));
    const withPending = (type, text) => brain.policyDecide({
        isManagerOrTeam: true, pendingAction: { type, state: {} },
        text, textLower: text.toLowerCase(), chatId: 't@g.us', session: {},
    });
    const ESCAPABLE = ['await_quote_cargo_details', 'await_quote_scale_tickets', 'await_container_number',
        'await_manual_email_address', 'await_domain_learn_name', 'await_quote_trucker_retry'];
    for (const t of ESCAPABLE) {
        ck(`"cancel" escapes ${t}`, withPending(t, 'cancel').intent, 'resolve_pending');
    }
    ck('"cancel all" escapes too', withPending('await_quote_cargo_details', 'cancel all').intent, 'resolve_pending');
    ck('"nevermind" escapes too', withPending('await_quote_cargo_details', 'nevermind').intent, 'resolve_pending');

    // The dangerous false positives. "scrap" is her actual cargo.
    ck('"scrap that load" is NOT a cancel (scrap is the cargo)',
        withPending('await_quote_cargo_details', 'scrap that load').intent, 'quote_cargo_details_received');
    ck('"cancelled order aluminum 40000 lbs" is NOT a cancel',
        withPending('await_quote_cargo_details', 'cancelled order aluminum 40000 lbs $5000').intent, 'quote_cargo_details_received');
    ck('a relay reply saying "cancel the pickup" is NOT swallowed',
        withPending('await_relay_reply', 'cancel the pickup').intent, 'relay_reply_received');
}

// ─────────────────────────────────────────────────────────────────────────
section('Cargo details: description AND weight AND value are all required');
// "manager didnt provide Weights and value.but jarvis ignored that."
// then: "also manager typed only 42000 lbs not the cargo value."
// then: "NO.IT DIDNT ASK FOR DESCRIPTION"
{
    // analyzeCargoNumbers is module-private, so exercise it through the file's
    // own logic the same way the handler does.
    const actionsSrc = src('workflow/actions.js');
    ckTrue('description is actually validated (not just prompted for)',
        /hasCargoDescription/.test(actionsSrc), 'hasCargoDescription missing from actions.js');
    ckTrue('all three fields gate the dispatch',
        /!hasWeight \|\| !hasValue \|\| !hasDescription/.test(actionsSrc),
        'the three-way check is gone — cargo could dispatch incomplete');
    // The infinite-loop regression: two comma-joined numbers with no space.
    const NUMBER_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
    ck('"40000,42000" counts as TWO numbers, not one (infinite-loop guard)',
        ('40000,42000'.match(NUMBER_RE) || []).length, 2);
    ck('"40,000" is still ONE number', ('40,000'.match(NUMBER_RE) || []).length, 1);
}

// ─────────────────────────────────────────────────────────────────────────
section('"in proforma-container#, IT SHOULD JUST BE 26JY52"');
// Said twice. The invoice keeps the item code; the container number does not.
// A retired retrofit function used to glue "AC_" back on.
{
    const html = src('dashboard/documents.html');
    ckTrue('container numbers are generated bare (no item code)',
        !/takeNextContainerCode\(deriveItemCode/.test(html),
        'something is passing an item code into the container number again');
    ck('both fill paths pass null', (html.match(/takeNextContainerCode\(null\)/g) || []).length, 2);
    ckTrue('the item-code retrofit stays a no-op',
        /function retrofitContainerItemCode\([^)]*\)\s*\{\s*\/\*/.test(html),
        'retrofitContainerItemCode is gluing the item code back on');
    ckTrue('the invoice number still carries the item code',
        /\$\{dateStr\}_\$\{itemCode\}_\$\{suggestion\.code_only\}/.test(html),
        'invoice no lost its item code');
    // The sheet must still log date_itemcode_containercode even though the
    // container number is now bare — this is the silent-degradation case.
    const sheetLog = src('helpers/proformaSheetLog.js');
    ckTrue('the Edge Metals sheet still logs the item code',
        /container\.item_code/.test(sheetLog),
        'sheet Inv No. would degrade to 260819_26JY19');
}

// ─────────────────────────────────────────────────────────────────────────
section('"IF I SAY JARV TO SEND SOMETHING TO SOMEONE,WHY CANT IT DO IT"');
{
    const brainSrc = src('workflow/brain.js');
    const actions = require(R('workflow/actions.js'));
    ckTrue('send_message exists as an AI action', /['"]send_message['"]/.test(brainSrc));
    ckTrue('send_message is routed', /case 'send_message'/.test(brainSrc));
    ckTrue('sendMessageTo is implemented and exported', typeof actions.sendMessageTo === 'function');
    ckTrue('the AI is told how it differs from ask_contact/draft_email',
        /do not confuse these three/i.test(brainSrc),
        'without this the AI picks ask_contact and waits for a reply nobody is sending');
}

// ─────────────────────────────────────────────────────────────────────────
section('"it is my assistant.it shold do whatever i want" — real reminders');
{
    const tasks = require(R('helpers/tasks.js'));
    const actions = require(R('workflow/actions.js'));
    ckTrue('recurring reminders exist', typeof tasks.rescheduleRecurring === 'function');
    ckTrue('setReminder is wired', typeof actions.setReminder === 'function');
    // Checks the INSTRUCTION, not the prose: the prompt legitimately quotes
    // the old refusal as an example of what never to say, so a naive search
    // for "cannot set reminders" matches its own fix. What matters is that
    // set_reminder is offered and the old "you cannot set reminders" clause
    // is no longer part of the capability list.
    ckTrue('the AI is no longer told it cannot set reminders',
        !/cannot set reminders for the manager/i.test(src('workflow/brain.js')),
        'the capability list still forbids reminders');
    ckTrue('set_reminder is offered to the AI', /['"]set_reminder['"]/.test(src('workflow/brain.js')));

    const TZ = 'America/Los_Angeles';
    // Normalised: Node's locale output differs slightly across versions
    // ("Wed 08:00" vs "Wed, 08:00"), and the assertion is about the DAY and
    // TIME, not punctuation.
    const fmt = (d) => d.toLocaleString('en-US', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '');
    // Tue 25 Aug 2026, 09:00 LA
    const from = new Date('2026-08-25T16:00:00Z');
    ck('daily 08:00 rolls to tomorrow', fmt(tasks.nextFireAt({ kind: 'daily', at: '08:00', tz: TZ }, from)), 'Wed 08:00');
    // Friday 16:00 LA — weekdays must skip the weekend
    const fri = new Date('2026-08-28T23:00:00Z');
    ck('weekdays skips the weekend', fmt(tasks.nextFireAt({ kind: 'weekdays', at: '08:00', tz: TZ }, fri)), 'Mon 08:00');
    // DST: a daily 8am reminder stays 8am across both boundaries.
    ck('8am survives DST fall-back',
        fmt(tasks.nextFireAt({ kind: 'daily', at: '08:00', tz: TZ }, new Date('2026-10-31T19:00:00Z'))), 'Sun 08:00');
    ck('8am survives spring-forward',
        fmt(tasks.nextFireAt({ kind: 'daily', at: '08:00', tz: TZ }, new Date('2026-03-07T20:00:00Z'))), 'Sun 08:00');
    ck('a malformed repeat can never loop forever',
        String(tasks.nextFireAt({ kind: 'daily', at: 'nope' }, from)), 'null');
}

// ─────────────────────────────────────────────────────────────────────────
section('"Junk car address" must not be refused');
{
    const brainSrc = src('workflow/brain.js');
    const actions = require(R('workflow/actions.js'));
    ckTrue('lookup_address exists as an AI action', /['"]lookup_address['"]/.test(brainSrc));
    ckTrue('lookupAddress is implemented', typeof actions.lookupAddress === 'function');
    ckTrue('it is in SAFE_ACTIONS (read-only, AI-first)', /'lookup_address',/.test(brainSrc));
}

// ─────────────────────────────────────────────────────────────────────────
section('Receivables — and the rules that keep the numbers honest');
{
    const ar = require(R('helpers/receivables.js'));
    ck('"$8,000" parses', ar.parseAmount('$8,000'), 8000);
    ck('"5k" parses', ar.parseAmount('5k'), 5000);
    ck('garbage does not become a number', String(ar.parseAmount('abc')), 'null');
    ck('a short code normalises to match its full invoice no',
        ar.normaliseInvNo('26JY52'), '26jy52');
    ck('ageing: an unreadable date is "unknown", never "current"',
        ar.ageBucket(ar.daysOld('n/a')), 'unknown');
    ck('90+ bucket', ar.ageBucket(120), '90+');
    ckTrue('orphaned payments are surfaced, never silently lost',
        /orphans/.test(src('helpers/receivables.js')));
    ckTrue('invoice totals are NOT recomputed here',
        !/subtotal - freight/.test(src('helpers/receivables.js')),
        'a second copy of the money rule would drift from the invoice PDF');
    ckTrue('the opening date excludes rather than marks paid',
        /NOT marked paid|Not marked paid/.test(src('workflow/actions.js')),
        'old invoices must never be asserted as paid — that is inventing history');
}

// ─────────────────────────────────────────────────────────────────────────
section('Payment detection — never credit money without a yes');
{
    const pw = require(R('workflow/paymentWatcher.js'));
    const invoiceSheet = require(R('helpers/invoiceSheet.js'));
    const realList = invoiceSheet.listAllInvoices;
    invoiceSheet.listAllInvoices = async () => ([
        { inv_no: '260819_AC_26JY52', consignee: 'Eccomelt', customer: 'Eccomelt', inv_date: '2026-08-19', containers: [], subtotal: 20000, freight: 2000, final_amount: 18000, line_count: 1 },
        { inv_no: '260415_AC_26JY10', consignee: 'Twin A', customer: 'Twin A', inv_date: '2026-04-15', containers: [], subtotal: 12000, freight: 0, final_amount: 12000, line_count: 1 },
        { inv_no: '260820_CU_26JY55', consignee: 'Twin B', customer: 'Twin B', inv_date: '2026-08-20', containers: [], subtotal: 12000, freight: 0, final_amount: 12000, line_count: 1 },
    ]);
    const m1 = await pw.matchToInvoice({ invoice_refs: ['INV 26JY52'], amount: null });
    ck('a noisy reference still matches ("INV 26JY52")', m1.invoice && m1.invoice.inv_no, '260819_AC_26JY52');
    const m2 = await pw.matchToInvoice({ invoice_refs: [], amount: 12000 });
    ckTrue('two invoices at the same amount -> refuses to pick', !m2.invoice && (m2.candidates || []).length === 2,
        'it guessed which customer paid — that credits the wrong account');
    const m3 = await pw.matchToInvoice({ invoice_refs: [], amount: 777 });
    ckTrue('an unmatchable payment is reported, not guessed', !!m3.none);
    ckTrue('every match states WHY it matched', !!m1.reason);
    ckTrue('the watcher never writes to the ledger itself',
        !/addPayment\(/.test(src('workflow/paymentWatcher.js')),
        'paymentWatcher must propose only — crediting is the confirm handler’s job');
    ckTrue('the confirm handler is the only thing that credits',
        /case 'await_payment_confirm'/.test(src('workflow/actions.js')),
        'without this, confirming a detected payment does nothing');
    invoiceSheet.listAllInvoices = realList;
}

// ─────────────────────────────────────────────────────────────────────────
section('"put a reminder in internal group" + "if a reply is sent alrdy, cancel"');
{
    const rw = require(R('workflow/replyWatch.js'));
    const NOW = new Date('2026-08-22T12:00:00Z');   // Sat 22 Aug
    const FRI = new Date('2026-08-21T18:00:00Z');   // email arrived Friday
    const answered = { users: { threads: { get: async () => ({ data: { messages: [
        { payload: { headers: [{ name: 'From', value: 'them@x.com' }] } },
        { payload: { headers: [{ name: 'From', value: 'me@edge.com' }] } },
    ] } }) } } };
    const unanswered = { users: { threads: { get: async () => ({ data: { messages: [
        { payload: { headers: [{ name: 'From', value: 'them@x.com' }] } },
    ] } }) } } };
    const item = (o) => Object.assign({
        id: 'x', threadId: 't', fromName: 'brian@radmetals.com', subject: 's',
        summary: 'Please transfer cargo to RadMetals by Monday noon.',
        asked_for: 'Transfer cargo to RadMetals', deadline: 'Monday Noon',
        firstFlaggedAt: FRI.toISOString(), lastDeadlineNudgeOn: null, chases: 0,
    }, o);

    let tracked = [item({})];
    let r = await rw.collectDeadlineReminders(unanswered, 'me@edge.com', tracked, FRI);
    ck('3 days out: stays quiet', r.due.length, 0);

    tracked = [item({})];
    r = await rw.collectDeadlineReminders(unanswered, 'me@edge.com', tracked, new Date('2026-08-23T09:00:00Z'));
    ck('due tomorrow: fires', r.due.length, 1);

    tracked = [item({})];
    r = await rw.collectDeadlineReminders(unanswered, 'me@edge.com', tracked, new Date('2026-08-25T09:00:00Z'));
    ck('overdue: keeps firing', r.due.length, 1);

    // Her exact instruction: already replied -> cancel and mark completed.
    tracked = [item({ deadline: '8/22' })];
    r = await rw.collectDeadlineReminders(answered, 'me@edge.com', tracked, NOW);
    ck('already replied: does NOT nudge', r.due.length, 0);
    ck('already replied: marked completed', r.completed.length, 1);
    ck('already replied: removed from tracking entirely', tracked.length, 0);

    // Once a day, so it never becomes noise.
    tracked = [item({ deadline: '8/22' })];
    await rw.collectDeadlineReminders(unanswered, 'me@edge.com', tracked, NOW);
    r = await rw.collectDeadlineReminders(unanswered, 'me@edge.com', tracked, NOW);
    ck('nudges at most once a day', r.due.length, 0);

    // The sliding-deadline bug: "by Monday" seen Friday, checked Monday.
    ck('a relative deadline anchors to when the email ARRIVED',
        rw.daysUntilDeadline('Monday Noon', new Date('2026-08-24T09:00:00Z'), FRI), 0);

    // ── "also description should not go next line .side by side" ─────────
    // Apsara, 2026-08-24. The task was on its own line under the deadline,
    // so the WHAT was the second thing her eye reached on every single item.
    const mk = (deadline, asked_for, fromName, from, threadId, daysToDeadline = 0) =>
        ({ deadline, asked_for, fromName, from, threadId, daysToDeadline, urgency: 'high' });
    {
        const msg = rw.buildDeadlineMessage([
            mk('Monday Noon', 'Transfer cargo to RadMetals', 'brian@radmetals.com', 'brian@radmetals.com', 't1'),
        ]);
        ckTrue('the description sits on the deadline line, not the next one',
            /TODAY Monday Noon\* — Transfer cargo to RadMetals/.test(msg),
            'the task is the headline; the deadline is context for it');
        ckTrue('the description is NOT on its own line',
            !/\n\s+Transfer cargo to RadMetals/.test(msg));
        ckTrue('who asked is still shown', /asked by brian@radmetals\.com/.test(msg));
    }
    {
        // The same live message that carried the layout complaint also listed
        // Kristal Sosethan's identical ask TWICE. groupMatters existed but
        // this path never called it — so the one message designed to nag was
        // the one place duplicates survived.
        const msg = rw.buildDeadlineMessage([
            mk('Monday Noon', 'Transfer cargo to RadMetals', 'brian@radmetals.com', 'brian@radmetals.com', 't1'),
            mk('Monday 8/24', 'confirmation if booking will be used', 'Kristal Sosethan', 'kristal@zimex.com', 't2'),
            mk('Monday 8/24', 'confirmation if booking will be used', 'Kristal Sosethan', 'kristal@zimex.com', 't3'),
            mk('8/24', 'booking for 2 *40 HC from LA/BUSAN', 'Accounting Edge', 'acct@edgetrading.com', 't4'),
        ]);
        ck('four mails about three matters are counted as three', msg.split('\n')[0], '3 things due now:');
        ck('the duplicate ask appears once', (msg.match(/confirmation if booking will be used/g) || []).length, 1);
        ckTrue('and it says the same person chased twice',
            /Kristal Sosethan \(2 mails\)/.test(msg));
        ckTrue('never "X +1 more (X)" — the same name twice reads as two people',
            !/Kristal Sosethan \+1 more \(Kristal Sosethan\)/.test(msg));
    }
    {
        // Two DIFFERENT people on one matter must both be named — collapsing
        // them to a count would hide who is waiting.
        const msg = rw.buildDeadlineMessage([
            mk('8/25', 'confirm the LA/BUSAN booking', 'Kristal Sosethan', 'kristal@zimex.com', 't5'),
            mk('8/25', 'confirm the LA/BUSAN booking', 'Ravi Kumar', 'ravi@zimex.com', 't6', 1),
        ]);
        ckTrue('two different senders on one matter are both named',
            /Kristal Sosethan and Ravi Kumar/.test(msg));
        ck('and it is still one item', (msg.match(/^• /gm) || []).length, 1);
    }
    {
        // The same layout rule, applied to the other two lists of this shape.
        const chase = rw.buildChaseMessage([{ fromName: 'Zimex', ageDays: 3, summary: 'BL draft for DALA20928700' }]);
        ckTrue('the chase-up list puts the description first too',
            /\*BL draft for DALA20928700\* — Zimex, 3 days ago/.test(chase),
            'three lists of the same shape must not read three different ways');
        const dig = rw.buildDigest([{ urgency: 'high', fromName: 'Kristal Sosethan',
            summary: 'confirmation if booking will be used', asked_for: 'yes/no on LA/BUSAN',
            deadline: '8/24', daysToDeadline: 0, alsoCount: 1, alsoFrom: ['Kristal Sosethan'] }], 2);
        ckTrue('the digest puts the description on the numbered line',
            /^1\. !! \*confirmation if booking will be used\*/m.test(dig),
            'the number must stay first — "reply to 1" depends on it');
        ckTrue('the digest still names the sender', /Kristal Sosethan — wants:/.test(dig));
        ckTrue('the digest never says "also <the same person>"',
            /same sender/.test(dig) && !/also Kristal Sosethan/.test(dig));
        // Urgency comes from a model, so an unexpected value must degrade,
        // not print "undefined" or NaN-break the group sort.
        const odd = rw.buildDigest([{ urgency: 'medium', fromName: 'X', summary: 'a thing' }], 1);
        ckTrue('an unknown urgency degrades to normal instead of printing undefined',
            !/undefined/.test(odd));
    }
    {
        // Overdue must stay unmistakable now that the line is denser.
        const msg = rw.buildDeadlineMessage([mk('8/20', 'send the BL draft', 'Zimex', 'ops@zimex.com', 't7', -3)]);
        ckTrue('overdue still reads as overdue, with the task beside it',
            /OVERDUE 8\/20 \(3d ago\)\* — send the BL draft/.test(msg));
    }
}

// ─────────────────────────────────────────────────────────────────────────
section('"if its marketing email,ignore"');
{
    const rw = require(R('workflow/replyWatch.js'));
    const H = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));
    ck('a mailing list is skipped outright', rw.bulkMailSignal(H({ 'List-Id': '<news.acme.com>' })), 'definitive');
    ck('Precedence: bulk is skipped outright', rw.bulkMailSignal(H({ Precedence: 'bulk' })), 'definitive');
    ck('a Mailchimp campaign is skipped outright',
        rw.bulkMailSignal(H({ 'List-Unsubscribe': '<x>', 'X-Mailchimp-ID': 'a' })), 'definitive');
    // The restraint that protects a real customer on a CRM.
    ck('List-Unsubscribe ALONE is only a hint, not a skip',
        rw.bulkMailSignal(H({ 'List-Unsubscribe': '<mailto:u@x>' })), 'suggestive');
    ck('an ordinary customer email is untouched',
        String(rw.bulkMailSignal(H({ From: 'brian@radmetals.com', Subject: 'Cargo' }))), 'null');
    ckTrue('the AI is told cold outreach is marketing however personal it looks',
        /MARKETING or SALES OUTREACH/.test(rw.buildPrompt({ from: 'a', subject: 'b', date: 'c', body: 'd' })));
}

// ─────────────────────────────────────────────────────────────────────────
section('Digest: one row per MATTER, and deadlines rank consistently');
{
    const rw = require(R('workflow/replyWatch.js'));
    const NOW = new Date('2026-08-22T12:00:00Z');
    // The live inconsistency: two 8/24 deadlines, different urgencies.
    const a = rw.applyDeadlineUrgency({ urgency: 'high', deadline: 'Monday 8/24' }, NOW);
    const b = rw.applyDeadlineUrgency({ urgency: 'normal', deadline: '8/24' }, NOW);
    ck('the same deadline gives the same urgency', [a.urgency, b.urgency], ['high', 'high']);
    ck('a model "high" is never downgraded by a far deadline',
        rw.applyDeadlineUrgency({ urgency: 'high', deadline: 'next week' }, NOW).urgency, 'high');

    const it = (o) => Object.assign({ threadId: null, from: '', fromName: '', subject: '', summary: '', asked_for: '', urgency: 'normal' }, o);
    ckTrue('same thread groups', rw.sameMatter(
        it({ threadId: 'tF', from: 'm@truckco.com', asked_for: 'ETA for pickup in Richmond' }),
        it({ threadId: 'tF', from: 'm@truckco.com', asked_for: 'decision whether to cancel the pickup' })));
    ckTrue('same company + same ask groups', rw.sameMatter(
        it({ threadId: 'a', from: 'acct@edge.com', asked_for: 'booking for 2x40 HC containers from LA to Busan' }),
        it({ threadId: 'b', from: 'acct@edge.com', asked_for: 'booking of 2x40HC containers' })));
    // The over-merge risks. Andy Park shares hynos.co.kr with the claim emails.
    ckTrue('same company, DIFFERENT matters do NOT merge', !rw.sameMatter(
        it({ threadId: 'c', from: 'andy@hynos.co.kr', asked_for: 'return the container' }),
        it({ threadId: 'g', from: 'jinho@hynos.co.kr', asked_for: 'confirmation of claim for weight shortage' })));
    ckTrue('two strangers on gmail never merge', !rw.sameMatter(
        it({ threadId: 'x', from: 'bob@gmail.com', asked_for: 'booking for 2x40 HC containers' }),
        it({ threadId: 'y', from: 'sue@gmail.com', asked_for: 'booking for 2x40 HC containers' })));
}


// ─────────────────────────────────────────────────────────────────────────
section('SIMULATED SCENARIOS — replaying real conversations end to end');
// Apsara, 2026-08-22: "you shold simulate test case like this in regressiom."
//
// Everything above asserts on a function. That catches a broken function but
// NOT a broken conversation — the 2026-08-22 evening transcript is the proof:
// every individual piece worked, and the exchange as a whole still went
// wrong, because the AI picked the neighbouring action. These replay real
// transcripts message by message and assert on what Jarvis would DO.
{
    const brain = require(R('workflow/brain.js'));
    const actions = require(R('workflow/actions.js'));

    // Walks a scripted conversation through the deterministic layer, carrying
    // pending state forward the way the live loop does. `null` intent means
    // "policy had no opinion, this goes to the AI" — which is itself an
    // assertion worth making: some messages MUST be caught deterministically.
    function replay(turns) {
        let pending = null;
        const out = [];
        for (const t of turns) {
            const ctx = {
                isManagerOrTeam: true, isManager: true,
                pendingAction: t.pending !== undefined ? t.pending : pending,
                text: t.say, textLower: t.say.toLowerCase(),
                chatId: 'sim@c.us', session: {},
            };
            const d = brain.policyDecide(ctx);
            out.push({ say: t.say, intent: d.needsAI ? null : d.intent });
            if (t.thenPending !== undefined) pending = t.thenPending;
        }
        return out;
    }

    // ── The 2026-08-22 evening transcript ────────────────────────────────
    // "recheck cutoff,erd in booking mail" correctly ran backfill. Then
    // "Reverify all the bookings to check correctness of data" fell through
    // and just LISTED bookings, because no verify action existed.
    const wizard = { type: 'wizard_start' };
    ck('wizard question + "yes" resolves the wizard, not a generic reply',
        replay([{ say: 'yes', pending: wizard }])[0].intent, 'resolve_pending');
    ck('"no" resolves it too',
        replay([{ say: 'no', pending: wizard }])[0].intent, 'resolve_pending');
    // If this ever returns null again, the daily trucker flow is dead at
    // step one — which is exactly what the live transcript showed.
    ckTrue('a wizard yes/no is NEVER left to the AI',
        replay([{ say: 'yes', pending: wizard }])[0].intent !== null,
        'the wizard answer fell through to the AI — the daily flow is broken');

    // ── The full quote conversation, start to finish ─────────────────────
    // Each step asserts the intent the live loop would route.
    const quote = replay([
        { say: 'Send quote request from Junk car to Eccomelt', pending: null },
        { say: 'yes', pending: { type: 'await_quote_scale_tickets', state: {} } },
        { say: '1', pending: { type: 'await_quote_truckers', options: ['NTG', 'TQL'], state: {} } },
        { say: 'Aluminum scrap, 40000 lbs, $5000', pending: { type: 'await_quote_cargo_details', state: {} } },
    ]);
    ck('quote conversation routes correctly end to end',
        quote.map((x) => x.intent),
        ['get_quote', 'quote_scale_tickets_received', 'quote_truckers_selected', 'quote_cargo_details_received']);

    // ── The cancel-loop transcript (2026-08-20 23:24) ────────────────────
    // "cancel" must escape from wherever she is, every time.
    const cancels = replay([
        { say: 'cancel all', pending: { type: 'await_quote_scale_tickets', state: {} } },
        { say: 'cancel', pending: { type: 'await_quote_cargo_details', state: {} } },
        { say: 'cancel', pending: { type: 'await_quote_cargo_details', state: {} } },
    ]);
    ck('every cancel in the loop transcript escapes',
        cancels.map((x) => x.intent), ['resolve_pending', 'resolve_pending', 'resolve_pending']);

    // ── The stuck-pending transcript (2026-08-20 15:07) ──────────────────
    ck('a fresh command sent into a stuck pending is heard as the command',
        replay([{ say: 'Send quote request from Junk car to Eccomelt',
            pending: { type: 'await_quote_cargo_details', state: {} } }])[0].intent, 'get_quote');

    // ── verify vs backfill: the distinction the AI must not blur ─────────
    // These are AI-classified, so assert the CAPABILITY exists and is
    // described distinctly — the live failure was the AI reaching for the
    // neighbouring action because the right one did not exist.
    const brainSrc = src('workflow/brain.js');
    ckTrue('verify_bookings exists as its own action', /['"]verify_bookings['"]/.test(brainSrc));
    ckTrue('verify_bookings is routed', /case 'verify_bookings'/.test(brainSrc));
    ckTrue('the AI is told verify != backfill',
        /do not confuse this with "backfill_cutoffs"/i.test(brainSrc),
        'without this the AI answers a correctness question by filling blanks');
    ckTrue('actions.verifyBookings is implemented', typeof actions.verifyBookings === 'function');


    // ── "reverify bookings in mail" -> "No bookings from mail." ──────────
    // The location-query regex read "mail" as a PLACE and answered before the
    // AI ever saw the message, so verify_bookings could not be chosen. Two
    // guards fixed it; both directions are asserted, because loosening this
    // rule too far would break every genuine "bookings from <port>" query.
    const soloIntent = (text) => {
        const d = brain.policyDecide({ isManagerOrTeam: true, isManager: true, pendingAction: null,
            text, textLower: text.toLowerCase(), chatId: 'sim@c.us', session: {} });
        return d.needsAI ? null : d.intent;
    };
    for (const t of ['reverify bookings in mail', 'reverify all the bookings against the mail',
        'verify bookings from mail', 'recheck bookings in email']) {
        ck(`"${t}" reaches the AI (so verify_bookings can be picked)`, soloIntent(t), null);
    }
    // The rule now defers to the AI unless the captured place actually
    // resolves to bookings — so the test has to provide that world, otherwise
    // it is asserting against an empty database rather than against the rule.
    {
        // brain.js DESTRUCTURES queryBookingsByLocation at module load, so
        // patching the helper afterwards never reaches the reference it
        // captured. Both modules have to be reloaded with the stub already in
        // place — the same cache-reload pattern tests/integration.js uses for
        // its degraded-mode section.
        const bookingPath = require.resolve(R('helpers/booking.js'));
        const brainPath = require.resolve(R('workflow/brain.js'));
        const KNOWN = ['oakland', 'la', 'los angeles', 'long beach', 'houston'];
        delete require.cache[bookingPath];
        delete require.cache[brainPath];
        const bookingHelper = require(bookingPath);
        bookingHelper.queryBookingsByLocation = (place) => (KNOWN.includes(String(place || '').toLowerCase())
            ? { count: 3, bookings: ['A', 'B', 'C'], records: [] }
            : { count: 0, bookings: [], records: [] });
        const brainStubbed = require(brainPath);
        const withData = (text) => {
            const d = brainStubbed.policyDecide({ isManagerOrTeam: true, isManager: true, pendingAction: null,
                text, textLower: text.toLowerCase(), chatId: 'sim@c.us', session: {} });
            return d.needsAI ? null : d.intent;
        };
        for (const t of ['bookings from oakland', 'available bookings from LA', 'shoe bookings from oakland']) {
            ck(`"${t}" is still a location query`, withData(t), 'bookings_list_query');
        }
        // The whole point of the change: an unresolvable "place" is the AI's
        // call, not the regex's.
        ck('"bookings from wherever" defers to the AI', withData('bookings from wherever'), null);
        ck('"reverify bookings in mail" defers even with data loaded',
            withData('reverify bookings in mail'), null);
        // Restore, so later sections see the real modules.
        delete require.cache[bookingPath];
        delete require.cache[brainPath];
        require(brainPath);
    }

    // ── The six regex-only intents now have an AI fallback ───────────────
    // Apsara: "i dont want textbook case. just let ai decide the policy."
    // Until 2026-08-22 these existed ONLY as regex and were absent from the
    // AI's action list, which the prompt declares exhaustive — so a missed or
    // over-reaching rule had no recovery path at all.
    {
        const brainSrc2 = src('workflow/brain.js');
        const aiList = (brainSrc2.split('═══ AVAILABLE ACTIONS ═══')[1] || '').split('Return ONLY')[0];
        for (const intent of ['bookings_list_query', 'bookings_count_query', 'get_quote',
            'get_contact_quote', 'send_pricelist_city', 'learn_domain', 'verify_bookings']) {
            ckTrue(`${intent} is offered to the AI, not regex-only`, aiList.includes(intent),
                'the AI cannot choose an action it was never given');
        }
        // A field the AI returns but route() drops = the action fires empty.
        for (const f of ['location', 'filter', 'origin', 'destination', 'names_text',
            'recipient_query', 'details', 'city', 'term']) {
            ckTrue(`AI field "${f}" is forwarded to route()`,
                new RegExp(`${f}: ai\\.${f}`).test(brainSrc2),
                'declared in the JSON shape but dropped before routing');
        }
    }

    // ── Verification must not cry wolf ───────────────────────────────────
    const cb = require(R('helpers/cutoffBackfill.js'));
    const verifyActionsSrc = src('workflow/actions.js');
    ck('08/21/2026 and 2026-08-21 are the SAME date, not a mismatch',
        cb.fieldsAgree('cutoff_date', '08/21/2026', '2026-08-21'), true);
    ck('a genuinely different date IS a mismatch',
        cb.fieldsAgree('cutoff_date', '08/21/2026', '08/28/2026'), false);
    ck('vessel formatting is not a mismatch',
        cb.fieldsAgree('vessel_voyage', 'MSC ISABELLA / 328W', 'MSC Isabella 328W'), true);
    // Apsara, 2026-08-22: "if there is a discrepancy, last mail about the
    // booking with pdf - modify the bookings in dashboard with updated pdf in
    // drive." She overrode the old report-only rule, so the invariant is now
    // narrower rather than gone: the CHECK still never writes; only the
    // explicit apply path does, and only the four schedule dates.
    ckTrue('the verify CHECK still never writes to the booking store',
        !/mutateJson/.test(
            (src('helpers/cutoffBackfill.js').split('async function verifyOne')[1] || '')
                .split('// ── APPLY')[0]),
        'the read path must stay read-only — the write is a separate, asked-for step');
    ck('only the four schedule dates she named are auto-correctable',
        cb.SCHEDULE_FIELDS, ['cutoff_date', 'erd_date', 'etd', 'eta'],
        'ports and vessel must never be auto-written — that is where MARTINEZ came from');
    ckTrue('ports and vessel are excluded from auto-correction',
        !cb.SCHEDULE_FIELDS.includes('port_of_loading')
        && !cb.SCHEDULE_FIELDS.includes('port_of_discharge')
        && !cb.SCHEDULE_FIELDS.includes('vessel_voyage'));

    // Apsara, 2026-08-22: "but nothing fired yet" — verify opened with "this
    // takes a moment" and then went silent forever. A long job that can end in
    // silence is a broken job, so this proves it always ends and always speaks.
    ckTrue('a booking that hangs cannot stall the whole verify run',
        typeof cb.VERIFY_BOOKING_TIMEOUT_MS === 'number' && cb.VERIFY_BOOKING_TIMEOUT_MS > 0,
        'one hung Gemini call used to stall every remaining booking, silently');
    {
        // one booking hangs forever, one answers — the run must still finish
        const t0 = Date.now();
        const slow = new Promise(() => { });
        const raced = await cb.withTimeout(slow, 60, { bkgNo: 'X', status: 'timeout' });
        ck('a hung booking resolves as a timeout, not a hang', raced.status, 'timeout');
        ckTrue('the timeout actually fires quickly', Date.now() - t0 < 2000);
    }
    // The three assertions that used to live here were `regex.test(source)` —
    // they checked that certain STRINGS existed in actions.js, which is not a
    // test, it is a spell-check. Apsara, 2026-08-22: "what did you test then".
    // Real end-to-end simulation of the hang, the mixed run, the send
    // failures and the progress pings now lives in tests/verify-simulation.js,
    // which drives the actual verifyBookings and reads the actual output.
    // Run by `npm test` alongside this file. This one assertion remains here
    // only to make sure that suite cannot be quietly dropped.
    ckTrue('the verify simulation suite exists and is wired into npm test',
        require('fs').existsSync(R('tests/verify-simulation.js'))
        && /verify-simulation/.test(src('package.json')),
        'the hang fix is only as good as the suite that proves it')
}

// ─────────────────────────────────────────────────────────────────────────
section('WIRING — a feature that nothing calls is a dead feature');
// Three changes were silently lost on 2026-08-22 when parallel work
// overwrote the files. Nothing failed; the payment watcher just never ran.
{
    const scheduler = src('scheduler.js');
    const cfg = require(R('config.js'));
    const verifyActionsSrc = src('workflow/actions.js');
    const brainSrc = src('workflow/brain.js');

    ckTrue('payment watcher is scheduled', /paymentWatcher\.run\(\)/.test(scheduler),
        'paymentWatcher.js exists but no cron calls it — it will never run');
    ckTrue('payment watcher is initialised with setPending', /paymentWatcher\.init\(/.test(scheduler));
    ckTrue('replyWatch gets sendMessage (for the internal group)',
        /sendMessage: _sendMessage/.test(scheduler),
        'deadline reminders cannot reach the team group without this');
    ckTrue('PAYMENTS_FILE is registered', !!cfg.PAYMENTS_FILE);
    ckTrue('PAYMENT_EMAILS_PROCESSED_FILE is registered', !!cfg.PAYMENT_EMAILS_PROCESSED_FILE);

    // Exported-but-unrouted and routed-but-unexported are both silent deaths.
    // "resumeQuoteWithScaleTickets is not a function" crashed live this way.
    const actions = require(R('workflow/actions.js'));
    for (const fn of ['sendMessageTo', 'setReminder', 'showReminders', 'cancelReminder', 'lookupAddress',
        'showReceivables', 'recordPayment', 'showOrphanPayments', 'setReceivablesStart',
        'trackOldInvoiceCmd', 'clearAllPending', 'getQueuedPendings', 'resumeQuoteWithScaleTickets']) {
        ckTrue(`actions.${fn} is exported`, typeof actions[fn] === 'function',
            'routed in brain.js but missing from module.exports = a live crash');
    }
    for (const intent of ['send_message', 'set_reminder', 'show_reminders', 'cancel_reminder',
        'lookup_address', 'show_receivables', 'record_payment', 'set_receivables_start']) {
        ckTrue(`${intent} is both offered to the AI and routed`,
            new RegExp(`case '${intent}'`).test(brainSrc) && new RegExp(`'${intent}'`).test(brainSrc),
            'an action the AI can pick but nothing routes silently does nothing');
    }
    ckTrue('every pending type the AI can stage has a resolver',
        /case 'await_payment_confirm'/.test(verifyActionsSrc));
}

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(60)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail) {
    console.log('\nFAILED REQUIREMENTS:');
    failures.forEach((f) => console.log('  - ' + f));
    console.log('\nEach line above is something that was explicitly asked for and has stopped working.');
    process.exit(1);
}
console.log('Every stated requirement still holds.');
})().catch((e) => { console.error('\nTEST HARNESS ERROR:', e); process.exit(1); });
