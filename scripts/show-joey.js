(async () => {
    const gmail = require('../helpers/gmail');
    const rw = require('../workflow/replyWatch');
    const client = await gmail.getGmailRead();
    const refs = await gmail.listMessages(client, 'newer_than:30d from:joey OR subject:"Chrome wheels"', 10);
    for (const ref of (refs || [])) {
        const msg = await gmail.getMessage(client, ref.id);
        const hs = (msg.payload && msg.payload.headers) || [];
        const h = (n) => (hs.find((x) => (x.name || '').toLowerCase() === n) || {}).value || '';
        const { body, pdfParts } = gmail.getEmailContent(msg.payload || {});
        console.log('\n========== ' + h('subject'));
        console.log('from: ' + h('from') + '   date: ' + h('date'));
        console.log('attachments: ' + JSON.stringify(rw.collectAttachmentNames(msg.payload || {}, pdfParts)));
        console.log('--- raw body ---');
        console.log(String(body || msg.snippet || '').slice(0, 1800));
    }
})().catch(e => console.error(e));
