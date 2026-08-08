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

            const items = Array.isArray(load.items) ? load.items : [];
            if (items.length) {
                doc.font('Helvetica-Bold').fontSize(10);
                const colX = { desc: 50, qty: 300, unit: 360, rate: 420, amount: 490 };
                doc.text('Description', colX.desc, doc.y, { continued: false });
                doc.text('Qty', colX.qty, doc.y - doc.currentLineHeight());
                doc.text('Unit', colX.unit, doc.y - doc.currentLineHeight());
                doc.text('Rate', colX.rate, doc.y - doc.currentLineHeight());
                doc.text('Amount', colX.amount, doc.y - doc.currentLineHeight());
                doc.moveDown(0.3);
                doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#ccc').stroke();
                doc.moveDown(0.3);

                doc.font('Helvetica').fontSize(9.5);
                let total = 0;
                for (const it of items) {
                    const y = doc.y;
                    doc.text(it.description || '—', colX.desc, y, { width: 240 });
                    doc.text(it.qty != null ? String(it.qty) : '—', colX.qty, y);
                    doc.text(it.unit || '—', colX.unit, y);
                    doc.text(it.rate != null ? String(it.rate) : '—', colX.rate, y);
                    doc.text(it.amount != null ? String(it.amount) : '—', colX.amount, y);
                    if (it.amount != null) total += it.amount;
                    doc.moveDown(0.4);
                }
                doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#ccc').stroke();
                doc.moveDown(0.3);
                doc.font('Helvetica-Bold').text(`Total: ${Math.round(total * 100) / 100}`, colX.amount, doc.y);
                doc.moveDown(1);
            }

            doc.moveDown(0.4);
            doc.font('Helvetica-Bold').fontSize(12).text('Weight');
            doc.moveDown(0.3);
            const unit = load.weight_unit || 'lb';
            fieldRow('Gross weight:', load.gross_weight != null ? `${load.gross_weight} ${unit}` : '—');
            fieldRow('Tare weight:',  load.tare_weight  != null ? `${load.tare_weight} ${unit}`  : '—');
            fieldRow('Net weight:',   load.net_weight   != null ? `${load.net_weight} ${unit}`   : '—');

            const hasBuffers = load._grossPhotoBuffer || load._tarePhotoBuffer;
            const hasLinks   = load.gross_photo_link || load.tare_photo_link;
            if (hasBuffers || hasLinks) {
                doc.moveDown(1);
                doc.font('Helvetica-Bold').fontSize(11).text('Captured scale photos');
                doc.moveDown(0.3);
                const imgW = 220;
                if (hasBuffers) {
                    // In-memory buffers available (called right at creation time,
                    // before the photos are only reachable via Drive) — embed thumbnails.
                    if (load._grossPhotoBuffer) {
                        try { doc.image(load._grossPhotoBuffer, { width: imgW }); doc.fontSize(8).fillColor('#666').text('Gross weight capture', { width: imgW }); doc.fillColor('#000'); } catch (e) { /* corrupt image data — skip, don't fail the whole PDF */ }
                    }
                    doc.moveDown(0.5);
                    if (load._tarePhotoBuffer) {
                        try { doc.image(load._tarePhotoBuffer, { width: imgW }); doc.fontSize(8).fillColor('#666').text('Tare weight capture', { width: imgW }); doc.fillColor('#000'); } catch (e) { /* corrupt image data — skip */ }
                    }
                } else {
                    // Called later (dashboard's "Generate PDF" button, after the load
                    // was already saved) — photos only live in Drive by then. Link out
                    // instead of re-downloading them just to re-embed as a thumbnail.
                    doc.fontSize(9).font('Helvetica').fillColor('#1a5fb4');
                    if (load.gross_photo_link) doc.text('Gross weight photo: ' + load.gross_photo_link, { link: load.gross_photo_link, underline: true });
                    if (load.tare_photo_link)  doc.text('Tare weight photo: '  + load.tare_photo_link,  { link: load.tare_photo_link,  underline: true });
                    doc.fillColor('#000');
                }
            }

            doc.moveDown(1.5);
            doc.fontSize(8).fillColor('#999').text(`Generated ${new Date().toISOString()}`, { align: 'right' });

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

module.exports = { generateLoadPdf };
