// Does the new order-PDF reader actually get the figures off her real P.O.s?
const flag = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
(async () => {
    const gmail = require('../helpers/gmail');
    const gem = require('../helpers/gemini');
    const client = await gmail.getGmailRead();
    const me = ((await gmail.getMyEmailAddress(client)) || '').toLowerCase() || null;
    const refs = await gmail.listMessages(client, `in:inbox newer_than:${Number(flag('days', 30))}d (subject:"P.O." OR subject:"PO" OR subject:order)`, 20);
    let n = 0, got = 0;
    for (const ref of (refs || [])) {
        let msg; try { msg = await gmail.getMessage(client, ref.id); } catch (e) { continue; }
        const hs = (msg.payload && msg.payload.headers) || [];
        const h = (x) => (hs.find((y) => (y.name || '').toLowerCase() === x) || {}).value || '';
        if (me && h('from').toLowerCase().includes(me)) continue;
        const { pdfParts } = gmail.getEmailContent(msg.payload || {});
        if (!pdfParts.length) continue;
        if (n++ >= 5) break;
        let att; try { att = await gmail.downloadAttachment(client, msg.id, pdfParts[0]); } catch (e) { continue; }
        const f = await gem.extractOrderPdfFields(att.base64);
        console.log(`\n=== ${h('subject').slice(0, 56)}`);
        console.log(`    ${att.filename.slice(0, 46)}`);
        if (!f) { console.log('    -> null'); continue; }
        console.log(`    is_order=${f.is_order_document}  po=${f.po_number}  buyer=${f.buyer}`);
        console.log(`    terms=${f.trade_terms}  port=${f.port_discharge}  pay=${f.payment_term}  containers=${f.container_count} ${f.container_size || ''}`);
        for (const i of (f.items || [])) {
            console.log(`      • ${String(i.desc).slice(0, 34).padEnd(36)} qty ${i.qty} ${i.qty_unit || ''}   rate ${i.rate} ${i.rate_basis || ''}  conf ${i.rate_confidence}`);
            if (i.qty != null || i.rate != null) got++;
        }
        if (f.note) console.log(`    note: ${String(f.note).slice(0, 110)}`);
    }
    console.log(`\nPDFs read: ${n}   item lines with a figure: ${got}`);
})().catch((e) => { console.error(e); process.exit(1); });
