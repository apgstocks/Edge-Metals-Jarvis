// ── FROM AN ATTACHED FILE: read it, record sales from it, record purchases from it (2026-11-20) ─────────────
// Apsara pasted 18 Metalco containers into Scout and was told, three times, that the text was cut off and that
// Scout could only sell ALL the stock of an item. Then: "Add an option for attachments in scout" — to record sales,
// record purchases, and just read and answer (helpers/scoutAttachments.js holds the file).
//
// THE MODEL NAMES COLUMNS; THE CODE READS THE NUMBERS. The proposal is built from the stored table, cell by cell,
// so a weight on the card is the weight in the file. The model's only job is to say which column is the date,
// which the gross, which the tare — and to ask for the price and the customer when they were not given.
//
// One record per ROW (one container = one sale, one ticket = one load), because that is how her paperwork is
// numbered and how a later question about one container has to be answered.
//
// SAFETY, the same as every other write here: propose → a card listing every row → confirm. On top of that:
//   * a row whose container number is already on a sale is skipped (and said so), so attaching the same sheet
//     twice cannot double her sales; a row repeated inside the file is skipped too;
//   * every sale row carries a one-time ticket, so a retried confirm cannot write it twice;
//   * a shortfall in stock is shown on the card (the stock guard's warning — the screen's rule since 2026-09-16);
//   * a table read from a PDF or photo is marked as read by the model.
// Nothing here is reachable without an attachment, so the voice path and every older caller are unchanged.
const PRICE_UNITS = { lb: 1, lbs: 1, pound: 1, metric_ton: 2204.62, mt: 2204.62, tonne: 2204.62, gross_ton: 2240, long_ton: 2240, net_ton: 2000, short_ton: 2000 };
function perLbFrom(quoted, per) {
    const unitKey = String(per || 'lb').toLowerCase().replace(/[\s/-]+/g, '_').replace(/^per_/, '');
    if (!(unitKey in PRICE_UNITS)) throw new Error(`I don't know the price unit "${per}" - is it per lb, per metric ton (MT), per gross ton or per net ton?`);
    if (PRICE_UNITS[unitKey] === 1 && quoted > 5) throw new Error(`$${quoted} per lb is far too high for scrap - is that per metric ton (MT), per gross ton or per net ton?`);
    const label = PRICE_UNITS[unitKey] === 1 ? 'lb' : ({ metric_ton: 'metric ton', mt: 'metric ton', tonne: 'metric ton', gross_ton: 'gross ton', long_ton: 'gross ton', net_ton: 'net ton', short_ton: 'net ton' })[unitKey];
    return { perLb: quoted / PRICE_UNITS[unitKey], label };
}
function attachmentOrThrow(id) {
    const A = require('./scoutAttachments');
    const a = A.get(id);
    if (!a) throw new Error('that attachment has expired or was never sent here — attach the file again');
    if (!a.table || !a.table.rows.length) throw new Error(`"${a ? a.name : 'the file'}" has no table I could read rows from`);
    return a;
}
function colOrThrow(a, ref, what, required) {
    if (ref == null || ref === '') { if (required) throw new Error(`which column is the ${what}?`); return -1; }
    const i = require('./scoutAttachments').columnIndex(a, ref);
    if (i < 0) throw new Error(`there is no column "${ref}" in ${a.name} — the columns are: ${a.table.columns.join(', ')}`);
    return i;
}
function colsOrThrow(a, refs, what) {
    const list = (Array.isArray(refs) ? refs : (refs == null || refs === '' ? [] : [refs]));
    return list.map((r) => colOrThrow(a, r, what, true));
}
function pickRows(a, rows) {
    const all = a.table.rows.map((r, i) => ({ n: i + 1, cells: r }));
    if (!Array.isArray(rows) || !rows.length) return all;
    const want = new Set(rows.map(Number).filter((n) => Number.isInteger(n) && n >= 1));
    return all.filter((r) => want.has(r.n));
}
const MAX_ROWS_PER_CARD = 150;

// Weights for one row, from the columns named. Tare can be several columns (container + chassis), summed.
function weightsOf(cells, gi, tis, ni) {
    const A = require('./scoutAttachments');
    const gross = gi >= 0 ? A.toNumber(cells[gi]) : null;
    const tares = tis.map((i) => A.toNumber(cells[i])).filter((v) => v != null);
    const tare = tis.length ? (tares.length ? tares.reduce((s, v) => s + v, 0) : null) : null;
    const netCell = ni >= 0 ? A.toNumber(cells[ni]) : null;
    if (gross != null && tare != null) return { gross, tare, net: Math.round((gross - tare) * 100) / 100, netCell };
    if (gross != null && tis.length === 0 && netCell != null) return { gross, tare: Math.round((gross - netCell) * 100) / 100, net: netCell, netCell };
    if (netCell != null) return { gross: netCell, tare: 0, net: netCell, netCell };
    if (gross != null && !tis.length) return { gross, tare: 0, net: gross, netCell };
    return null;
}

TOOLS.read_attachment_rows = {
    kind: 'read',
    description: 'Read rows of a file the person attached (for questions about it, or rows past the first ones shown).',
    params: {
        attachment_id: { type: 'string', required: true, describe: 'the attachment_id shown with the ATTACHED FILE' },
        from: { type: 'number', describe: 'first row number (1 = first data row)' },
        to: { type: 'number', describe: 'last row number' },
    },
    run: async (p) => {
        const A = require('./scoutAttachments');
        const a = A.get(p.attachment_id);
        if (!a) return { error: 'that attachment has expired — ask them to attach it again' };
        if (!a.table) return { name: a.name, text: a.text.slice(0, 8000) };
        const from = Math.max(1, num(p.from) || 1), to = Math.min(a.table.rows.length, num(p.to) || from + 99);
        return { name: a.name, columns: a.table.columns, read_by: a.table.read_by, rows: a.table.rows.slice(from - 1, to).map((r, i) => ({ row: from + i, cells: r })) };
    },
};

TOOLS.record_sales_from_attachment = {
    kind: 'write',
    description: 'Record SALES from an attached file: one sale per row (e.g. one per container), weights read from the file. Name the columns; never type weights yourself.',
    params: {
        attachment_id: { type: 'string', required: true, describe: 'the attachment_id shown with the ATTACHED FILE' },
        buyer: { type: 'string', describe: 'who bought it — ASK if not given (or use buyer_column)' },
        buyer_column: { type: 'string', describe: 'column holding the buyer, if it varies by row' },
        price: { type: 'number', describe: 'price, in the unit given by price_per — ASK, do not guess (or use price_column)' },
        price_per: { type: 'string', describe: 'lb (default), metric_ton (MT), gross_ton or net_ton — pass it AS SHE SAID IT; never convert yourself' },
        price_column: { type: 'string', describe: 'column holding a per-row price (same unit as price_per)' },
        item: { type: 'string', describe: 'the material, e.g. "HMS" (or use item_column)' },
        item_column: { type: 'string' },
        date_column: { type: 'string', describe: 'column holding each row\'s date' },
        date: { type: 'date', describe: 'one date for every row, only when the file has no date column' },
        gross_column: { type: 'string' },
        tare_columns: { type: 'array', describe: 'tare column(s); several are added together. Use the TOTAL tare column if the file has one' },
        net_column: { type: 'string' },
        container_column: { type: 'string' }, booking_column: { type: 'string' }, seal_column: { type: 'string' },
        reference_column: { type: 'string', describe: 'her own reference / lot number column' },
        company_column: { type: 'string', describe: 'column naming which of her companies SOLD it (e.g. "Edge Yard")' },
        rows: { type: 'array', describe: 'only these row numbers; omit for every row' },
        note: { type: 'string' },
    },
    propose: async (p, ctx = {}) => {
        const A = require('./scoutAttachments');
        const { loadOutboundLoads } = require('./outboundLoads');
        const a = attachmentOrThrow(p.attachment_id);
        const ci = {
            buyer: colOrThrow(a, p.buyer_column, 'buyer'), item: colOrThrow(a, p.item_column, 'material'),
            price: colOrThrow(a, p.price_column, 'price'), date: colOrThrow(a, p.date_column, 'date'),
            gross: colOrThrow(a, p.gross_column, 'gross weight'), tares: colsOrThrow(a, p.tare_columns, 'tare'),
            net: colOrThrow(a, p.net_column, 'net weight'), container: colOrThrow(a, p.container_column, 'container number'),
            booking: colOrThrow(a, p.booking_column, 'booking number'), seal: colOrThrow(a, p.seal_column, 'seal number'),
            ref: colOrThrow(a, p.reference_column, 'reference'), company: colOrThrow(a, p.company_column, 'selling company'),
        };
        if (ci.gross < 0 && ci.net < 0) throw new Error('which column is the gross weight (or the net weight)?');
        if (ci.date < 0 && !isYmd(p.date)) throw new Error('what date were these sold? There is no date column named');
        if (!str(p.buyer) && ci.buyer < 0) throw new Error('who was it sold to?');
        if (!str(p.item) && ci.item < 0) throw new Error('what material is it?');
        if ((num(p.price) == null || num(p.price) <= 0) && ci.price < 0) throw new Error('what price? A sale needs one');
        const picked = pickRows(a, p.rows);
        if (picked.length > MAX_ROWS_PER_CARD) throw new Error(`that is ${picked.length} rows — I record at most ${MAX_ROWS_PER_CARD} at a time; give me a row range`);

        const existing = loadOutboundLoads();
        const onFile = (container) => {
            if (!container) return null;
            const k = container.toUpperCase().replace(/\s+/g, '');
            return existing.find((o) => String(o.description || '').toUpperCase().replace(/\s+/g, '').includes(k)) || null;
        };
        const seenInFile = new Set();
        const lines = [], skipped = [];
        for (const r of picked) {
            const c = r.cells;
            const date = ci.date >= 0 ? A.toYmd(c[ci.date]) : p.date;
            const w = weightsOf(c, ci.gross, ci.tares, ci.net);
            const container = ci.container >= 0 ? str(c[ci.container]) : '';
            const buyer = str(p.buyer) || (ci.buyer >= 0 ? str(c[ci.buyer]) : '');
            const item = str(p.item) || (ci.item >= 0 ? str(c[ci.item]) : '');
            const rowPrice = ci.price >= 0 ? A.toNumber(c[ci.price]) : num(p.price);
            if (!date) { skipped.push(`row ${r.n}: no readable date`); continue; }
            if (!w || !(w.net > 0)) { skipped.push(`row ${r.n}: no usable weight`); continue; }
            if (!buyer) { skipped.push(`row ${r.n}: no buyer`); continue; }
            if (!item) { skipped.push(`row ${r.n}: no material`); continue; }
            if (rowPrice == null || rowPrice <= 0) { skipped.push(`row ${r.n}: no price`); continue; }
            const dup = onFile(container);
            if (dup) { skipped.push(`row ${r.n}: container ${container} is already on sale ${dup.id}`); continue; }
            if (container) { const k = container.toUpperCase(); if (seenInFile.has(k)) { skipped.push(`row ${r.n}: container ${container} appears twice in the file`); continue; } seenInFile.add(k); }
            const { perLb, label } = perLbFrom(rowPrice, p.price_per);
            const refs = [
                container && `Container ${container}`,
                ci.booking >= 0 && str(c[ci.booking]) && `Booking ${str(c[ci.booking])}`,
                ci.seal >= 0 && str(c[ci.seal]) && `Seal ${str(c[ci.seal])}`,
                ci.ref >= 0 && str(c[ci.ref]) && `Ref ${str(c[ci.ref])}`,
            ].filter(Boolean);
            const mismatch = w.netCell != null && ci.gross >= 0 && ci.tares.length && Math.abs(w.netCell - w.net) > 1;
            lines.push({
                n: r.n, date, buyer, item, container, refs, company: ci.company >= 0 ? str(c[ci.company]) : null,
                gross: w.gross, tare: w.tare, net: w.net, perLb, quoted: rowPrice, label,
                amount: Math.round(w.net * perLb * 100) / 100, mismatch, netCell: w.netCell,
            });
        }
        if (!lines.length) throw new Error(`nothing to record from ${a.name}: ${skipped.slice(0, 6).join('; ')}`);

        const totalNet = lines.reduce((s, l) => s + l.net, 0);
        const totalAmt = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
        const fmt = (v) => Math.round(v).toLocaleString('en-US');
        const buyers = [...new Set(lines.map((l) => l.buyer))];
        const details = [
            ['From file', `${a.name}${a.table.read_by === 'model' ? ' (read from a PDF/photo — check the weights)' : ''}`],
            ['Buyer', buyers.join(', ')],
            ['Price', lines[0].label === 'lb' ? `${perLb(lines[0].perLb)} per lb` : `${money(lines[0].quoted)} per ${lines[0].label} = ${perLb(lines[0].perLb)} per lb`],
            ...lines.map((l) => [`Row ${l.n} · ${l.date}`, `${l.item}${l.container ? ' · ' + l.container : ''} · ${fmt(l.gross)} − ${fmt(l.tare)} = ${fmt(l.net)} lb · ${money(l.amount)}`]),
            ['Total', `${lines.length} sale${lines.length === 1 ? '' : 's'} · ${fmt(totalNet)} lb · ${money(totalAmt)}`],
        ];
        const warnings = [];
        if (a.table.read_by === 'model') warnings.push('These numbers were read from a PDF or photo by the AI. Check each weight against the paper before confirming.');
        if (skipped.length) warnings.push(`Left out: ${skipped.join('; ')}.`);
        const mism = lines.filter((l) => l.mismatch);
        if (mism.length) warnings.push(`Gross minus tare does not match the file's net on row ${mism.map((l) => l.n).join(', ')} — the card uses gross minus tare.`);
        try {
            const guard = require('./stockGuard');
            const short = guard.shortfalls(lines.map((l) => ({ description: l.item, gross_weight: l.gross, tare_weight: l.tare, net_weight: l.net })));
            if (short.length) warnings.push(guard.explain(short, 'lb'));
        } catch (e) { /* the stock check is advice; it never blocks the card */ }
        buyers.forEach((b) => { if (!existing.some((o) => String(o.buyer || '').toLowerCase().trim() === b.toLowerCase())) warnings.push(`${b} has no earlier sale in the yard records — check the spelling.`); });

        return {
            summary: `Record ${lines.length} sale${lines.length === 1 ? '' : 's'} to ${buyers.join(', ')} from ${a.name}: ${fmt(totalNet)} lb, ${money(totalAmt)}.`,
            details, warnings,
            run: async (c2 = {}) => {
                const { addOutboundLoad, loadOutboundLoads: fresh } = require('./outboundLoads');
                const now = fresh();
                const created = [], skippedNow = [];
                for (const l of lines) {
                    if (l.container) {
                        const k = l.container.toUpperCase().replace(/\s+/g, '');
                        const dup = now.find((o) => String(o.description || '').toUpperCase().replace(/\s+/g, '').includes(k));
                        if (dup) { skippedNow.push(`${l.container} (already on ${dup.id})`); continue; }
                    }
                    const rec = await addOutboundLoad({
                        date: l.date, buyer: l.buyer,
                        ...(l.company ? { seller_company: l.company } : {}),
                        description: [l.refs.join(' · '), str(p.note)].filter(Boolean).join(' — '),
                        items: [{ description: l.item, gross_weight: l.gross, tare_weight: l.tare, price: l.perLb, unit: '' }],
                        weight_unit: 'lb',
                        created_by: c2.role || ctx.role || 'yard-assistant',
                        client_request_id: `att:${a.id}:${l.n}`,
                    });
                    created.push(rec.id);
                }
                return { created, skipped: skippedNow };
            },
        };
    },
};

TOOLS.record_purchases_from_attachment = {
    kind: 'write',
    description: 'Record PURCHASES (incoming loads) from an attached file: one load per row, weights read from the file. Name the columns; never type weights yourself.',
    params: {
        attachment_id: { type: 'string', required: true, describe: 'the attachment_id shown with the ATTACHED FILE' },
        seller: { type: 'string', describe: 'who the yard bought from — ASK if not given (or use seller_column)' },
        seller_column: { type: 'string' },
        price: { type: 'number', describe: 'price in the unit given by price_per — ASK, do not guess (or use price_column)' },
        price_per: { type: 'string', describe: 'lb (default), metric_ton (MT), gross_ton or net_ton — AS SHE SAID IT' },
        price_column: { type: 'string' },
        item: { type: 'string' }, item_column: { type: 'string' },
        date_column: { type: 'string' }, date: { type: 'date', describe: 'one date for every row, only when there is no date column' },
        gross_column: { type: 'string' }, tare_columns: { type: 'array' }, net_column: { type: 'string' },
        company_column: { type: 'string', describe: 'column naming which of her companies BOUGHT it' },
        rows: { type: 'array', describe: 'only these row numbers; omit for every row' },
    },
    propose: async (p, ctx = {}) => {
        const A = require('./scoutAttachments');
        const { loadLoads } = require('./loads');
        const a = attachmentOrThrow(p.attachment_id);
        const ci = {
            seller: colOrThrow(a, p.seller_column, 'seller'), item: colOrThrow(a, p.item_column, 'material'),
            price: colOrThrow(a, p.price_column, 'price'), date: colOrThrow(a, p.date_column, 'date'),
            gross: colOrThrow(a, p.gross_column, 'gross weight'), tares: colsOrThrow(a, p.tare_columns, 'tare'),
            net: colOrThrow(a, p.net_column, 'net weight'), company: colOrThrow(a, p.company_column, 'buying company'),
        };
        if (ci.gross < 0 && ci.net < 0) throw new Error('which column is the gross weight (or the net weight)?');
        if (ci.date < 0 && !isYmd(p.date)) throw new Error('what date did these come in? There is no date column named');
        if (!str(p.seller) && ci.seller < 0) throw new Error('who did the yard buy these from?');
        if (!str(p.item) && ci.item < 0) throw new Error('what material is it?');
        if ((num(p.price) == null || num(p.price) <= 0) && ci.price < 0) throw new Error('what price? A load needs one');
        const picked = pickRows(a, p.rows);
        if (picked.length > MAX_ROWS_PER_CARD) throw new Error(`that is ${picked.length} rows — I record at most ${MAX_ROWS_PER_CARD} at a time; give me a row range`);

        const existing = loadLoads();
        const sameLoad = (seller, date, gross, tare) => existing.find((l) => String(l.seller || '').toLowerCase().trim() === seller.toLowerCase()
            && l.date === date && (l.items || []).some((it) => Number(it.gross_weight) === gross && Number(it.tare_weight) === tare)) || null;
        const lines = [], skipped = [];
        for (const r of picked) {
            const c = r.cells;
            const date = ci.date >= 0 ? A.toYmd(c[ci.date]) : p.date;
            const w = weightsOf(c, ci.gross, ci.tares, ci.net);
            const seller = str(p.seller) || (ci.seller >= 0 ? str(c[ci.seller]) : '');
            const item = str(p.item) || (ci.item >= 0 ? str(c[ci.item]) : '');
            const rowPrice = ci.price >= 0 ? A.toNumber(c[ci.price]) : num(p.price);
            if (!date) { skipped.push(`row ${r.n}: no readable date`); continue; }
            if (!w || !(w.net > 0)) { skipped.push(`row ${r.n}: no usable weight`); continue; }
            if (!seller) { skipped.push(`row ${r.n}: no seller`); continue; }
            if (!item) { skipped.push(`row ${r.n}: no material`); continue; }
            if (rowPrice == null || rowPrice <= 0) { skipped.push(`row ${r.n}: no price`); continue; }
            const dup = sameLoad(seller, date, w.gross, w.tare);
            if (dup) { skipped.push(`row ${r.n}: looks already entered as ${dup.id} (same seller, date and weights)`); continue; }
            const { perLb, label } = perLbFrom(rowPrice, p.price_per);
            lines.push({ n: r.n, date, seller, item, gross: w.gross, tare: w.tare, net: w.net, perLb, quoted: rowPrice, label, company: ci.company >= 0 ? str(c[ci.company]) : null, amount: Math.round(w.net * perLb * 100) / 100 });
        }
        if (!lines.length) throw new Error(`nothing to record from ${a.name}: ${skipped.slice(0, 6).join('; ')}`);
        const fmt = (v) => Math.round(v).toLocaleString('en-US');
        const totalNet = lines.reduce((s, l) => s + l.net, 0);
        const totalAmt = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
        const sellers = [...new Set(lines.map((l) => l.seller))];
        const details = [
            ['From file', `${a.name}${a.table.read_by === 'model' ? ' (read from a PDF/photo — check the weights)' : ''}`],
            ['Seller', sellers.join(', ')],
            ['Price', lines[0].label === 'lb' ? `${perLb(lines[0].perLb)} per lb` : `${money(lines[0].quoted)} per ${lines[0].label} = ${perLb(lines[0].perLb)} per lb`],
            ...lines.map((l) => [`Row ${l.n} · ${l.date}`, `${l.item} · ${fmt(l.gross)} − ${fmt(l.tare)} = ${fmt(l.net)} lb · ${money(l.amount)}`]),
            ['Total', `${lines.length} load${lines.length === 1 ? '' : 's'} · ${fmt(totalNet)} lb · ${money(totalAmt)}`],
        ];
        const warnings = [];
        if (a.table.read_by === 'model') warnings.push('These numbers were read from a PDF or photo by the AI. Check each weight against the paper before confirming.');
        if (skipped.length) warnings.push(`Left out: ${skipped.join('; ')}.`);
        sellers.forEach((s) => { if (!existing.some((l) => String(l.seller || '').toLowerCase().trim() === s.toLowerCase())) warnings.push(`${s} has no earlier load in the yard records — check the spelling.`); });
        return {
            summary: `Record ${lines.length} load${lines.length === 1 ? '' : 's'} from ${sellers.join(', ')} out of ${a.name}: ${fmt(totalNet)} lb, ${money(totalAmt)}.`,
            details, warnings,
            run: async (c2 = {}) => {
                const { addLoad, loadLoads: freshLoads } = require('./loads');
                const now = freshLoads();
                const created = [], skippedNow = [];
                for (const l of lines) {
                    const dup = now.find((x) => String(x.seller || '').toLowerCase().trim() === l.seller.toLowerCase() && x.date === l.date
                        && (x.items || []).some((it) => Number(it.gross_weight) === l.gross && Number(it.tare_weight) === l.tare));
                    if (dup) { skippedNow.push(`row ${l.n} (already ${dup.id})`); continue; }
                    const rec = await addLoad({
                        date: l.date, seller: l.seller,
                        ...(l.company ? { buyer_company: l.company } : {}),
                        items: [{ description: l.item, gross_weight: l.gross, tare_weight: l.tare, price: l.perLb, unit: 'lb' }],
                        created_by: c2.role || ctx.role || 'yard-assistant',
                    });
                    created.push((rec && (rec.id || (rec.load && rec.load.id))) || null);
                }
                return { created, skipped: skippedNow };
            },
        };
    },
};

