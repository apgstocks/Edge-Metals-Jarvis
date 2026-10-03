#!/usr/bin/env node
// Would auto-sending a proforma have been SAFE on her real mail?
//
// Apsara, 2026-10-03: "Say if someone asks for proforma. like Joey via
// confirmation of order - Jarvis should send proforma automatically."
//
// She chose the opposite on 2026-08-23 ("read back, then confirm"). Before
// reversing that, measure the only thing that matters: how often a draft is
// clean enough that a human adds nothing. A green path that fires on one
// order in twenty buys no time and carries all the risk.
//
//   node scripts/proforma-autosend-audit.js --days 30
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const days = Number(flag('days', 30)) || 30;
const limit = Number(flag('limit', 40)) || 40;

(async () => {
    const gmail = require('../helpers/gmail');
    const rw = require('../workflow/replyWatch');
    const { extractOrderFromEmail, toProformaDraft, groundRates } = require('../helpers/proformaFromEmail');
    const client = await gmail.getGmailRead();
    if (!client) { console.error('Gmail not authorised in this DATA_DIR.'); process.exit(1); }
    const me = ((await gmail.getMyEmailAddress(client)) || '').toLowerCase() || null;

    const refs = await gmail.listMessages(client, `in:inbox newer_than:${days}d`, limit);
    let looked = 0, orders = 0, green = 0;
    const rows = [];
    for (const ref of (refs || [])) {
        let msg; try { msg = await gmail.getMessage(client, ref.id); } catch (e) { continue; }
        const hs = (msg.payload && msg.payload.headers) || [];
        const h = (n) => (hs.find((x) => (x.name || '').toLowerCase() === n) || {}).value || '';
        const from = h('from');
        if (me && from.toLowerCase().includes(me)) continue;
        const { body, pdfParts } = gmail.getEmailContent(msg.payload || {});
        const visible = rw.extractLatestMessage(body || msg.snippet || '');
        if (!visible) continue;
        looked++;
        // THE ATTACHMENT, because since 2026-10-03 the pipeline reads it and
        // an audit that does not is measuring a system that no longer exists.
        // That is the same staleness that made the first evalset reading wrong.
        //
        // READ THE PDF-CALL COUNT IN THIS SCRIPT'S OUTPUT WITH CARE. This
        // audit walks the WHOLE INBOX, so it offers every email with an
        // attachment to the reader. Production does not: replyWatch calls
        // draftProformaForOrder only `if (!f.is_order) continue;` -- "the
        // handful of emails that ARE orders rather than the inbox"
        // (replyWatch.js:4380). So a count of 5 here is 5 reads across 30 days
        // of ALL mail, not 5 per scan.
        let pdfs = [];
        if (pdfParts && pdfParts.length) {
            try {
                const att = await gmail.downloadAttachment(client, msg.id, pdfParts[0]);
                if (att && att.base64) pdfs = [att];
            } catch (e) { /* judged on the body, as before */ }
        }
        let order = null;
        try { order = await extractOrderFromEmail({ from, subject: h('subject'), body: visible, date: null, pdfs }); } catch (e) { continue; }
        if (!order || !order.is_order) continue;
        orders++;
        const grounded = await groundRates(order).catch(() => order);
        const draft = toProformaDraft(grounded, { fallbackConsignee: null });
        const needs = (draft.needs || []);
        const assumed = (draft.assumed || []);
        const unconfirmed = (draft.unconfirmed || []);
        const atts = rw.collectAttachmentNames(msg.payload || {}, pdfParts);
        const clean = !needs.length && !assumed.length && !unconfirmed.length;
        // An attachment nothing opens is a missing input, and for an ORDER the
        // missing input is usually the quantity. Measured 2026-10-03: the
        // Metalco P.O.s say only "see the attached file".
        const blind = atts.length > 0;
        if (clean && !blind) green++;
        rows.push({ subject: h('subject').slice(0, 52), from: from.slice(0, 32),
            consignee: draft.consignee, needs, assumed: assumed.length, unconfirmed: unconfirmed.length,
            atts: atts.length, clean, blind });
    }

    console.log(`\nPROFORMA AUTO-SEND AUDIT — ${days} days, ${looked} readable, ${orders} judged an order`);
    console.log('='.repeat(72));
    for (const r of rows) {
        const verdict = r.clean && !r.blind ? 'WOULD AUTO-SEND'
            : r.blind && r.clean ? 'blocked: attachment unread'
            : `blocked: ${r.needs.length ? 'missing ' + r.needs.join('/') : ''}${r.assumed ? ` ${r.assumed} assumed` : ''}${r.unconfirmed ? ` ${r.unconfirmed} unconfirmed` : ''}`.trim();
        console.log(`\n  ${r.subject}`);
        console.log(`     from ${r.from}  ->  consignee ${r.consignee || '(none)'}`);
        console.log(`     ${verdict}`);
    }
    console.log(`\n${'='.repeat(72)}`);
    console.log(`  orders found          ${orders}`);
    console.log(`  would have auto-sent  ${green}`);
    console.log(`  needed a human        ${orders - green}`);
    if (!orders) console.log('\n  No orders in the window. That is itself the answer: this fires rarely.');
})().catch((e) => { console.error(e); process.exit(1); });
