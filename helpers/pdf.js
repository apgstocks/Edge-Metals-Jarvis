const PDFDocument = require('pdfkit');

function generateLoadPdf(load) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
            const chunks = [];
            doc.on('data', (c) => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            doc.fontSize(18).font('Helvetica-Bold').text('Edge Metals Inc. — Load Ticket', { align: 'left' });
            doc.moveDown(0.2);
            doc.fontSize(9).font('Helvetica').fillColor('#666')
                .text(`Load ID: ${load.id}`, { continued: false });
            doc.fillColor('#000');
            doc.moveDown(0.8);

            const fieldRow = (label, value) => {
                doc.font('Helvetica-Bold').fontSize(10).text(label, { continued: true, width: 120 });
                doc.font('Helvetica').text(value || '—');
            };
            fieldRow('Date:', load.date);
            fieldRow('Seller:', load.seller);
            fieldRow('Description:', load.description);
            fieldRow('Created by:', load.created_by);
            doc.moveDown(0.8);

            // Gross/tare/net/price/amount are captured PER ITEM (moved off the
            // load level — a load is often several items, each weighed
            // separately, not one shared weight for the whole load), so the
            // item table itself carries the full weight breakdown now instead
            // of there being a separate "Weight" section below it.
            const unit = load.weight_unit || 'lb';
            const items = Array.isArray(load.items) ? load.items : [];
            if (items.length) {
                doc.font('Helvetica-Bold').fontSize(12).text('Item Detail');
                doc.moveDown(0.4);
                doc.font('Helvetica-Bold').fontSize(9.5);
                const colX = { desc: 50, gross: 195, tare: 245, net: 295, price: 345, unit: 400, amount: 445 };
                const headerY = doc.y;
                doc.text('Description', colX.desc, headerY, { width: 140 });
                doc.text('Gross', colX.gross, headerY);
                doc.text('Tare', colX.tare, headerY);
                doc.text('Net', colX.net, headerY);
                doc.text('Price', colX.price, headerY);
                doc.text('Unit', colX.unit, headerY);
                doc.text('Amount', colX.amount, headerY);
                doc.moveDown(0.4);
                doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#ccc').stroke();
                doc.moveDown(0.3);

                doc.font('Helvetica').fontSize(9);
                const fmt = (n) => (n != null ? String(n) : '—');
                for (const it of items) {
                    const y = doc.y;
                    doc.text(it.description || '—', colX.desc, y, { width: 140 });
                    doc.text(fmt(it.gross_weight), colX.gross, y);
                    doc.text(fmt(it.tare_weight), colX.tare, y);
                    doc.text(fmt(it.net_weight), colX.net, y);
                    doc.text(fmt(it.price), colX.price, y);
                    doc.text(it.unit || '—', colX.unit, y);
                    doc.text(fmt(it.amount), colX.amount, y);
                    doc.moveDown(0.45);
                }
                doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#ccc').stroke();
                doc.moveDown(0.5);
            }

            // Summary — sums across all items (gross/tare/net/amount), computed
            // server-side in helpers/loads.js and stored on the load record, so
            // this is always consistent with what the item table above adds up
            // to rather than being re-derived here.
            doc.font('Helvetica-Bold').fontSize(12).text('Summary');
            doc.moveDown(0.3);
            fieldRow('Gross total:',  load.gross_weight != null ? `${load.gross_weight} ${unit}` : '—');
            fieldRow('Tare total:',   load.tare_weight  != null ? `${load.tare_weight} ${unit}`  : '—');
            fieldRow('Net total:',    load.net_weight   != null ? `${load.net_weight} ${unit}`   : '—');
            fieldRow('Amount total:', load.amount       != null ? String(load.amount)             : '—');

            // Each item's captured scale photos, linked (not re-embedded — the
            // photos already live in Drive by the time this runs, generate-pdf
            // is a separate action the user triggers after saving the load).
            const itemsWithPhotos = items.filter(it => it.gross_photo_link || it.tare_photo_link);
            if (itemsWithPhotos.length) {
                doc.moveDown(1);
                doc.font('Helvetica-Bold').fontSize(11).text('Captured scale photos');
                doc.moveDown(0.3);
                doc.fontSize(9).font('Helvetica');
                items.forEach((it, i) => {
                    if (!it.gross_photo_link && !it.tare_photo_link) return;
                    doc.fillColor('#000').text(`${i + 1}. ${it.description || 'Item ' + (i + 1)}`);
                    doc.fillColor('#1a5fb4');
                    if (it.gross_photo_link) doc.text('   Gross photo: ' + it.gross_photo_link, { link: it.gross_photo_link, underline: true });
                    if (it.tare_photo_link)  doc.text('   Tare photo: '  + it.tare_photo_link,  { link: it.tare_photo_link,  underline: true });
                    doc.fillColor('#000');
                    doc.moveDown(0.2);
                });
            }

            doc.moveDown(1.5);
            doc.fontSize(8).fillColor('#999').text(`Generated ${new Date().toISOString()}`, { align: 'right' });

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

// ── Separate, smaller PDF: just gross/tare weights + their photo links ───────
// Generated alongside the main priced ticket (same /generate-pdf action in
// api.js) but uploaded as its own file, weights_<load id>.pdf, per Apsara —
// some downstream use (e.g. handing proof-of-weight to the scale operator
// or a quick audit) doesn't need the priced item table, just the weights and
// the photos backing them up. Deliberately NOT folded into generateLoadPdf
// as a toggle — keeping them as two plain functions means either one can be
// regenerated/reused independently later without a flag threading through.
function generateWeightsPdf(load) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
            const chunks = [];
            doc.on('data', (c) => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            doc.fontSize(18).font('Helvetica-Bold').text('Edge Metals Inc. — Weight Record', { align: 'left' });
            doc.moveDown(0.2);
            doc.fontSize(9).font('Helvetica').fillColor('#666').text(`Load ID: ${load.id}`);
            doc.fillColor('#000');
            doc.moveDown(0.8);

            const fieldRow = (label, value) => {
                doc.font('Helvetica-Bold').fontSize(10).text(label, { continued: true, width: 120 });
                doc.font('Helvetica').text(value || '—');
            };
            fieldRow('Date:', load.date);
            fieldRow('Seller:', load.seller);
            doc.moveDown(0.8);

            const unit = load.weight_unit || 'lb';
            const items = Array.isArray(load.items) ? load.items : [];
            doc.font('Helvetica-Bold').fontSize(12).text('Item weights');
            doc.moveDown(0.4);

            if (!items.length) {
                doc.font('Helvetica').fontSize(10).text('No items on this load.');
            }
            items.forEach((it, i) => {
                doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#000')
                    .text(`${i + 1}. ${it.description || 'Item ' + (i + 1)}`);
                doc.font('Helvetica').fontSize(9.5);
                doc.text(`   Gross weight: ${it.gross_weight != null ? it.gross_weight + ' ' + unit : '—'}`);
                if (it.gross_photo_link) {
                    doc.fillColor('#1a5fb4').text('   Gross photo: ' + it.gross_photo_link, { link: it.gross_photo_link, underline: true });
                    doc.fillColor('#000');
                }
                doc.text(`   Tare weight: ${it.tare_weight != null ? it.tare_weight + ' ' + unit : '—'}`);
                if (it.tare_photo_link) {
                    doc.fillColor('#1a5fb4').text('   Tare photo: ' + it.tare_photo_link, { link: it.tare_photo_link, underline: true });
                    doc.fillColor('#000');
                }
                doc.text(`   Net weight: ${it.net_weight != null ? it.net_weight + ' ' + unit : '—'}`);
                doc.moveDown(0.5);
            });

            doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#ccc').stroke();
            doc.moveDown(0.5);
            fieldRow('Gross total:', load.gross_weight != null ? `${load.gross_weight} ${unit}` : '—');
            fieldRow('Tare total:',  load.tare_weight  != null ? `${load.tare_weight} ${unit}`  : '—');
            fieldRow('Net total:',   load.net_weight   != null ? `${load.net_weight} ${unit}`   : '—');

            doc.moveDown(1.5);
            doc.fontSize(8).fillColor('#999').text(`Generated ${new Date().toISOString()}`, { align: 'right' });

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

module.exports = { generateLoadPdf, generateWeightsPdf };
