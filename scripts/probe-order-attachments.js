#!/usr/bin/env node
// Can the ORDER'S ATTACHMENT be read? Measured before building anything.
//
// The last unresolved accuracy gap: every remaining is_order miss and 3 of 10
// confidence caps are an unread attachment. Her P.O.s say "please see the
// attached file" and the quantities live in the PDF.
//
// This does NOT build a reader. It asks whether there is anything in those
// PDFs worth reading, using the vision machinery that already exists
// (helpers/gemini.js classifyDocument / extractPdfFields).
const flag = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const days = Number(flag('days', 30)) || 30;

(async () => {
    const gmail = require('../helpers/gmail');
    const gem = require('../helpers/gemini');
    const client = await gmail.getGmailRead();
    if (!client) { console.error('Gmail not authorised.'); process.exit(1); }
    const me = ((await gmail.getMyEmailAddress(client)) || '').toLowerCase() || null;
    const refs = await gmail.listMessages(client, `in:inbox newer_than:${days}d (subject:"P.O." OR subject:"PO" OR subject:confirm OR subject:order)`, 25);
    let looked = 0, withPdf = 0, read = 0;
    for (const ref of (refs || [])) {
        let msg; try { msg = await gmail.getMessage(client, ref.id); } catch (e) { continue; }
        const hs = (msg.payload && msg.payload.headers) || [];
        const h = (n) => (hs.find((x) => (x.name || '').toLowerCase() === n) || {}).value || '';
        if (me && h('from').toLowerCase().includes(me)) continue;
        looked++;
        const { pdfParts } = gmail.getEmailContent(msg.payload || {});
        if (!pdfParts.length) continue;
        withPdf++;
        console.log(`\n=== ${h('subject').slice(0, 58)}`);
        console.log(`    from ${h('from').slice(0, 40)}   ${pdfParts.length} pdf(s)`);
        for (const part of pdfParts.slice(0, 2)) {
            let att;
            try { att = await gmail.downloadAttachment(client, msg.id, part); }
            catch (e) { console.log(`    ${part.filename}: download failed — ${e.message}`); continue; }
            const kb = Math.round((att.base64.length * 3 / 4) / 1024);
            let kind = null;
            try { kind = await gem.classifyDocument(att.base64); } catch (e) { kind = { error: e.message }; }
            console.log(`    ${String(att.filename).slice(0, 44)}  ${kb}KB  ->  ${JSON.stringify(kind).slice(0, 160)}`);
            // The question that matters: are the ORDER FIGURES in there?
            try {
                const fields = await gem.extractPdfFields(att.base64);
                const s = JSON.stringify(fields);
                const hasQty = /\b(qty|quantity|weight|mt|tonne|lbs?)\b/i.test(s);
                const hasRate = /\b(rate|price|amount|unit)\b/i.test(s);
                console.log(`       fields: ${s.slice(0, 220)}`);
                console.log(`       quantity-ish: ${hasQty}   price-ish: ${hasRate}`);
                if (hasQty || hasRate) read++;
            } catch (e) { console.log(`       extractPdfFields failed: ${e.message}`); }
        }
    }
    console.log(`\n${'='.repeat(70)}`);
    console.log(`  order-ish emails read   ${looked}`);
    console.log(`  carrying a PDF          ${withPdf}`);
    console.log(`  PDFs with figures in    ${read}`);
})().catch((e) => { console.error(e); process.exit(1); });
