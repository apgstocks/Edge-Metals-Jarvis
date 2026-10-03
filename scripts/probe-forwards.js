// Run the REAL pipeline on every forward in the window and print the decision.
(async () => {
    const gmail = require('../helpers/gmail');
    const rw = require('../workflow/replyWatch');
    const client = await gmail.getGmailRead();
    const me = ((await gmail.getMyEmailAddress(client)) || '').toLowerCase() || null;
    let managerEmail = null;
    try { const sr = gmail.getGmailSenderRead(); if (sr) managerEmail = ((await gmail.getMyEmailAddress(sr)) || '').toLowerCase() || null; } catch (e) {}
    const refs = await gmail.listMessages(client, 'in:inbox newer_than:21d', 60);
    for (const ref of (refs || [])) {
        let msg; try { msg = await gmail.getMessage(client, ref.id); } catch (e) { continue; }
        const hs = (msg.payload && msg.payload.headers) || [];
        const h = (n) => (hs.find((x) => (x.name || '').toLowerCase() === n) || {}).value || '';
        const subject = h('subject');
        if (!/^\s*(fw|fwd)\s*:/i.test(subject)) continue;
        const { body, pdfParts } = gmail.getEmailContent(msg.payload || {});
        const visible = rw.extractLatestMessage(body || msg.snippet || '');
        if (!visible) { console.log(`\n### ${subject.slice(0,55)}\n   SKIPPED: nothing visible`); continue; }
        let a = null, err = '';
        try {
            a = await rw.assess({ from: h('from'), subject, date: gmail.parseEmailDate(h('date')),
                body: visible, thread: '', attachments: rw.collectAttachmentNames(msg.payload || {}, pdfParts),
                to: h('to'), cc: h('cc'), myAddress: me, managerAddress: managerEmail });
        } catch (e) { err = e.message || String(e); }
        console.log(`\n### ${subject.slice(0,55)}`);
        console.log(`   from        ${h('from').slice(0,45)}`);
        if (err) { console.log(`   CRASH ${err.slice(0,80)}`); continue; }
        console.log(`   summary     ${String(a.summary||'').slice(0,110)}`);
        console.log(`   needs_reply ${a.needs_reply}  conf ${a.confidence}  waiting_on ${a.waiting_on}  internal ${a.from_internal}`);
        console.log(`   asked_for   ${JSON.stringify(a.asked_for||null)}   is_order ${a.is_order}`);
    }
})().catch((e) => { console.error(e); process.exit(1); });
