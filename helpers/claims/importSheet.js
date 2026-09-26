// ── helpers/claims/importSheet.js — a weight-shortage sheet becomes claims ────
//
// Apsara, 2026-09-26: "Boss. if i upload the weight shortage sheet and ai to
// classify them properly and put it into website, it should do that."
//
// So the whole pipeline lives here, callable from the page as well as from the
// terminal: read a sheet (an uploaded file, or the live tab), work out what each
// row is, let the model name the kinds, and write the claims. Nothing in here
// prints; scripts/claims-import-sheet.js formats the text version and
// helpers/claims/routes.js hands the same result to the page as JSON.
//
// NOTHING IS WRITTEN BY plan(). It reads, it classifies, it reports. commit()
// writes, and only what plan() already decided — so what she confirms on the
// page is exactly what lands.
//
// IT RAISES NO TO-DO AND SENDS NO WHATSAPP. A Jarvis task is a delayed send and
// taskRunner fires every minute: eighty historical claims through the normal
// creation path would have messaged her eighty times.
const cfg = require('../../config');
const claims = require('../claims');
const claimKind = require('../claimKind');
const claimKinds = require('../claimKinds');
const { parseCsv } = require('../nextInvoiceNo');

const lc = (s) => String(s == null ? '' : s).trim().toLowerCase();
const txt = (s) => String(s == null ? '' : s).trim();
const num = (v) => {
    const t = txt(v).replace(/[$,]/g, '').replace(/\s/g, '');
    if (!t || t === '-' || t === '#VALUE!') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
};

// ── READING ─────────────────────────────────────────────────────────────────
// exceljs hands back objects for formulas and hyperlinks, so a cell is reduced
// to its text the same way helpers/sheetImport.js does.
function cellText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') {
        if (v.text !== undefined) return String(v.text);
        if (v.result !== undefined) return String(v.result);
        if (v.richText) return v.richText.map((r) => r.text).join('');
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        return '';
    }
    return String(v);
}

async function rowsFromXlsx(buffer, wantedTab) {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const names = wb.worksheets.map((w) => w.name);
    // Her tab is called "Weight Shortage 2025"; a year in the name should not
    // stop it being found, and an upload of the whole workbook should land on
    // the right sheet without her having to say which.
    const ws = (wantedTab && wb.getWorksheet(wantedTab))
        || wb.worksheets.find((w) => /shortage/i.test(w.name))
        || wb.worksheets.find((w) => /claim/i.test(w.name))
        || wb.worksheets[0];
    if (!ws) throw new Error('that file has no sheets in it');
    const rows = [];
    let max = 0;
    ws.eachRow({ includeEmpty: true }, (row) => {
        const cells = (row.values || []).slice(1).map(cellText);
        max = Math.max(max, cells.length);
        rows[row.number - 1] = cells;
    });
    for (let i = 0; i < rows.length; i += 1) if (!rows[i]) rows[i] = [];
    return { rows, tab: ws.name, tabs: names };
}

// input: { csv } | { xlsxBase64, tab } | {} → the live tab
async function readSheet(input = {}) {
    if (input.csv) return { rows: parseCsv(String(input.csv)), source: input.name || 'an uploaded CSV' };
    if (input.xlsxBase64) {
        const buf = Buffer.from(String(input.xlsxBase64).replace(/^data:[^;]+;base64,/, ''), 'base64');
        const { rows, tab, tabs } = await rowsFromXlsx(buf, input.tab);
        return { rows, source: `${input.name || 'an uploaded workbook'} › ${tab}`, tab, tabs };
    }
    // The live tab is fetched from wherever this process runs — which is the VM,
    // not her laptop. "fetch failed" on its own tells her nothing, so each way it
    // can go wrong says which one it was and what to do instead.
    if (!cfg.INVOICE_SHEET_ID) throw new Error('no sheet is configured (INVOICE_SHEET_ID) — upload the file instead');
    const url = `https://docs.google.com/spreadsheets/d/${cfg.INVOICE_SHEET_ID}/export?format=csv&gid=${cfg.CLAIMS_SHEET_GID}`;
    let res;
    try { res = await fetch(url); }
    catch (e) { throw new Error(`this server could not reach Google Sheets (${e.message}) — upload the file instead`); }
    if (res.status === 401 || res.status === 403) throw new Error('Google refused the sheet — it has to be shared as "anyone with the link can view", or upload the file instead');
    if (!res.ok) throw new Error(`could not read the live tab (HTTP ${res.status}) — upload the file instead`);
    const text = await res.text();
    if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('Google sent a sign-in page instead of the sheet — it is not link-viewable from this server, so upload the file instead');
    const rows = parseCsv(text);
    if (!rows.length) throw new Error(`the live tab (gid ${cfg.CLAIMS_SHEET_GID}) came back empty — check the tab still exists`);
    return { rows, source: `the live Weight Shortage tab (gid ${cfg.CLAIMS_SHEET_GID})` };
}

// ── HEADER → FIELD ──────────────────────────────────────────────────────────
const SYN = {
    customer:   ['customer name'],
    supplier:   ['supplier', 'buyer'],
    invoice:    ['inv nbr', 'inv no', 'invoice no', 'inv no.'],
    container:  ['container number', 'cont no.', 'container no'],
    inv_weight: ['inv weight', 'gross'],
    recv_weight:['claimed weight', 'received weight', 'received'],
    shortage:   ['shortage in mt', 'diff in weight', 'difference', 'shortage'],
    sell_price: ['inv price', 'selling price'],
    status_note:['claim status'],
    note:       ['claim note'],
    date:       ['date'],
};

function isHeaderRow(cells) {
    const set = cells.map(lc);
    const hasKey = set.includes('container number') || set.includes('cont no.');
    return hasKey && cells.filter((c) => txt(c)).length >= 3;
}

// THE TRAP IN THE LEGACY BLOCK: there, "Amount" is what the customer claims from
// Edge and "Claim Amount" is what Edge claims back from the supplier — the
// reverse of every other block, where they are "Claim amount" and "Our Claim".
// And the column headed "Buyer" holds the SUPPLIER. Reading those the wrong way
// round turns a cost into a recovery and the absorbed figure is wrong in both
// directions at once, so the mapping is decided per block from the header row and
// reported for checking.
function mapColumns(cells) {
    const set = cells.map(lc);
    const at = (names) => { for (const n of names) { const i = set.indexOf(n); if (i !== -1) return i; } return -1; };
    const m = {};
    for (const [field, names] of Object.entries(SYN)) m[field] = at(names);
    const legacy = set.includes('buyer') && set.includes('buying price');
    if (legacy) {
        m.customer = 0; m.invoice = 1;
        m.claim_amount = at(['amount']);
        m.our_claim = at(['claim amount']);
    } else {
        m.claim_amount = at(['claim amount']);
        m.our_claim = at(['our claim']);
    }
    m.__legacy = legacy;
    m.__headers = cells.map(txt);
    return m;
}

// Her own rule, from the ledger notes: a container's tonnage is normally within
// 100 MT and a real one is about 25. Anything bigger in a column headed MT is
// pounds or a typo, never a tonnage. MT is set only where the figures obey that.
function unitFor(inv, recv) {
    const vals = [inv, recv].filter((v) => v !== null);
    if (!vals.length) return { unit: null, why: '' };
    if (vals.every((v) => v > 0 && v <= 100)) return { unit: 'MT', why: '' };
    return { unit: null, why: `weights out of tonnage range (${vals.join(', ')}) — pounds or a typo in an MT column` };
}

function statusFor(noteText, claim_amount) {
    const n = lc(noteText);
    if (/removed by customer/.test(n)) return 'withdrawn';
    if (/ignored/.test(n)) return 'rejected';
    if (/paid|zelle/.test(n)) return 'settled';
    if (claim_amount !== null) return 'verified';
    return 'unverified';
}

// ── THE WALK ────────────────────────────────────────────────────────────────
function walk(table) {
    let map = null, blockNo = 0, blockLabel = '', section = '', sectionRow = -99;
    const found = [], skipped = [], manual = [], blocks = [];

    table.forEach((cells, i) => {
        const rowNo = i + 1;
        const filled = cells.filter((c) => txt(c)).length;
        if (!filled) return;

        if (isHeaderRow(cells)) {
            map = mapColumns(cells);
            blockNo += 1;
            blockLabel = `block ${blockNo}${map.__legacy ? ' (legacy 2025 shape)' : ''}`;
            blocks.push({
                row: rowNo, label: blockLabel, legacy: map.__legacy,
                claimFrom: map.__headers[map.claim_amount] || null,
                recoveryFrom: map.__headers[map.our_claim] || null,
                supplierFrom: map.__headers[map.supplier] || null,
            });
            return;
        }
        if (!map) { skipped.push({ rowNo, why: 'above the first header row' }); return; }

        const g = (f) => (map[f] >= 0 ? cells[map[f]] : '');
        const invoice = txt(g('invoice'));
        const container = txt(g('container')).toUpperCase().replace(/\s+/g, '');

        if (!invoice && !container) {
            const label = cells.map(txt).filter(Boolean).join(' | ');
            if (filled <= 3 && /[a-z]/i.test(label) && label.length <= 60) { section = label; sectionRow = rowNo; }
            skipped.push({ rowNo, why: filled <= 2 ? `section label "${label}"` : 'no invoice and no container' });
            return;
        }

        // Some rows are prose in the identifier columns. Imported blind, row 70 of
        // her tab becomes a claim against a customer called "conatiner damage".
        const realContainer = /^[A-Z]{4}\d{7}$/.test(container);
        const realInvoice = /\d/.test(invoice) && !/\s/.test(invoice) && invoice.length <= 30;
        if (!realContainer && !realInvoice) {
            manual.push({ rowNo, block: blockLabel, invoice, container, cells: cells.filter((c) => txt(c)).slice(0, 6).join(' | ') });
            return;
        }

        const inv_weight = num(g('inv_weight'));
        const recv_weight = num(g('recv_weight'));
        const claim_amount = num(g('claim_amount'));
        const noteText = [txt(g('status_note')), txt(g('note')),
            map.__legacy && map.claim_amount >= 0 ? txt(cells[map.claim_amount + 1]) : ''].filter(Boolean).join(' | ');
        const { unit, why: unitWhy } = unitFor(inv_weight, recv_weight);

        found.push({
            rowNo, block: blockLabel,
            // Headings joined with " | " and NOT with a space: claimKind strips the
            // accounting headings that sit above every block and say nothing about
            // the argument, but only if each arrives as its own token. Joined with
            // spaces the lot came through as one string and drowned
            // "Alu.Engine Combo" — the only place those rows name their claim.
            text: claimKind.rowText(cells, [
                (map.__headers || []).filter(Boolean).join(' | '),
                (rowNo - sectionRow) <= 3 ? section : '',
            ].filter(Boolean).join(' | ')),
            customer: txt(g('customer')), supplier: txt(g('supplier')),
            invoice_no: invoice, container_no: container,
            invoice_weight: inv_weight, claimed_weight: recv_weight, weight_unit: unit,
            shortage: num(g('shortage')), sell_price: num(g('sell_price')),
            claim_amount, our_claim: num(g('our_claim')),
            status: statusFor(noteText, claim_amount),
            note: noteText, unitWhy, date: txt(g('date')),
        });
    });
    return { found, skipped, manual, blocks };
}

// ── GROUPING ────────────────────────────────────────────────────────────────
// (invoice, container) is NOT unique, and the two reasons look identical until
// the amounts are read. 26ME07/TEMU7944250 is $450 of hand tools AND a $3,100
// recovery shortfall — two arguments on one container, the $3,550 the sheet
// itself shows. 25DK09 is one claim entered twice, the first copy blank. So:
// group, fill blanks from the other copies, and split back out only where a
// group holds two or more DIFFERENT non-null amounts. First-copy-wins silently
// dropped $4,222.96 on 25JY56, whose first copy is the empty one.
const FILL = ['customer', 'supplier', 'invoice_weight', 'claimed_weight', 'weight_unit', 'sell_price', 'shortage', 'our_claim', 'date'];
const richness = (r) => FILL.filter((f) => r[f] !== null && r[f] !== '' && r[f] !== undefined).length + (r.claim_amount !== null ? 3 : 0);

function group(found) {
    const groups = new Map();
    for (const r of found) {
        const key = claims.keyOf(r.invoice_no, r.container_no);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
    }
    const out = [], merged = [], already = [];
    for (const [, rows] of groups) {
        const amounts = [...new Set(rows.map((r) => r.claim_amount).filter((v) => v !== null))];
        const lines = amounts.length > 1 ? amounts.map((a) => rows.filter((r) => r.claim_amount === a)) : [rows];
        for (const copies of lines) {
            const best = copies.slice().sort((a, b) => richness(b) - richness(a))[0];
            const rec = { ...best, fromRows: copies.map((c) => c.rowNo), otherTexts: copies.filter((c) => c !== best).map((c) => c.text) };
            for (const f of FILL) {
                if (rec[f] === null || rec[f] === '' || rec[f] === undefined) {
                    const donor = copies.find((c) => c[f] !== null && c[f] !== '' && c[f] !== undefined);
                    if (donor) rec[f] = donor[f];
                }
            }
            if (copies.length > 1) merged.push(rec);
            // Idempotency on key AND amount: where one container legitimately
            // carries two claims the key matches both, so key alone re-imports
            // them on every run.
            const key = claims.keyOf(rec.invoice_no, rec.container_no);
            const existing = claims.list().filter((c) => c && c.key === key);
            const dup = existing.find((c) => (rec.claim_amount === null
                ? (c.claim_amount === null || c.claim_amount === undefined)
                : Math.abs((c.claim_amount || 0) - rec.claim_amount) < 0.005));
            if (dup) { rec.existingId = dup.id; already.push(rec); continue; }
            out.push(rec);
        }
    }
    return { toWrite: out, merged, already };
}

// ── CLASSIFYING ─────────────────────────────────────────────────────────────
// Two phases. Measured on her tab: asked row by row WITH the vocabulary so far in
// front of it the model put 80 of 82 under one name; asked row by row with
// nothing it produced "weight" for 77 and then three names for one argument, one
// of which was a column heading. So every row is named freely, and then the model
// is shown every name it gave and settles the vocabulary — which is what a person
// reading the tab does. There is still no list of kinds in the code.
async function classifyAll(toWrite, { useAi = true, onProgress } = {}) {
    for (const r of toWrite) {
        const text = [r.text, ...(r.otherTexts || [])].filter(Boolean).join(' || ');
        if (!useAi) { r.claim_type = null; r.type_unresolved = 'not asked'; if (onProgress) onProgress(r); continue; }
        const v = await claimKind.classify(text);
        if (!v.ok) { r.claim_type = null; r.type_unresolved = v.unresolved; if (onProgress) onProgress(r); continue; }
        r.named = v.label; r.type_quote = v.quote; r.type_why = v.why; r.type_desc = v.description;
        if (onProgress) onProgress(r);
    }

    const grouped = new Map();
    for (const r of toWrite) {
        if (!r.named) continue;
        if (!grouped.has(r.named)) grouped.set(r.named, { label: r.named, count: 0, example: r.type_quote || r.type_why });
        grouped.get(r.named).count += 1;
    }
    const named = [...grouped.values()].sort((a, b) => b.count - a.count);
    const vocab = { named, settled: null, folds: [], kinds: [] };
    if (!named.length) return vocab;

    const settled = named.length > 1 ? await claimKind.consolidate(named) : null;
    if (settled) {
        vocab.settled = true;
        vocab.kinds = settled.kinds;
        vocab.why = settled.why;
        vocab.unmapped = settled.unmapped;
        const folds = new Set();
        for (const r of toWrite) {
            if (!r.named) continue;
            const hit = settled.map.get(r.named);
            const kind = hit || { slug: claimKinds.slugify(r.named), label: r.named, description: r.type_desc || '' };
            if (kind.label.toLowerCase() !== r.named.toLowerCase()) folds.add(`${r.named} → ${kind.label}`);
            r.kind = kind;
            r.claim_type = kind.slug;
        }
        vocab.folds = [...folds];
    } else {
        vocab.settled = false;
        for (const r of toWrite) {
            if (!r.named) continue;
            r.kind = { slug: claimKinds.slugify(r.named), label: r.named, description: r.type_desc || '' };
            r.claim_type = r.kind.slug;
        }
        vocab.kinds = [...new Set(toWrite.filter((r) => r.kind).map((r) => r.kind.label))].map((label) => ({ label, description: '' }));
    }
    return vocab;
}

// ── PLAN — reads and decides, writes NOTHING ─────────────────────────────────
async function plan(input = {}) {
    const { rows, source, tab, tabs } = await readSheet(input);
    const { found, skipped, manual, blocks } = walk(rows);
    const { toWrite, merged, already } = group(found);
    const vocabulary = await classifyAll(toWrite, { useAi: input.useAi !== false, onProgress: input.onProgress });

    const sum = (list, f) => list.reduce((t, r) => t + (r[f] || 0), 0);
    const byKind = {};
    for (const r of toWrite) {
        const k = r.claim_type || '';
        if (!byKind[k]) byKind[k] = { label: r.claim_type ? (r.kind ? r.kind.label : r.claim_type) : 'not classified yet', claims: 0, claimed: 0 };
        byKind[k].claims += 1; byKind[k].claimed += r.claim_amount || 0;
    }
    return {
        source, tab, tabs,
        sheetRows: rows.length,
        blocks,
        claims: toWrite,
        merged: merged.map((r) => ({ rows: r.fromRows, invoice_no: r.invoice_no, container_no: r.container_no, claim_amount: r.claim_amount, our_claim: r.our_claim })),
        split: toWrite.filter((r) => toWrite.filter((x) => claims.keyOf(x.invoice_no, x.container_no) === claims.keyOf(r.invoice_no, r.container_no)).length > 1)
            .map((r) => ({ rows: r.fromRows, invoice_no: r.invoice_no, container_no: r.container_no, claim_amount: r.claim_amount, kind: r.claim_type })),
        manual, skipped,
        already: already.map((r) => ({ invoice_no: r.invoice_no, container_no: r.container_no, claim_amount: r.claim_amount, existingId: r.existingId })),
        // The full rows behind `already`, kept so reclassify() can re-read their
        // words. Stripped before any of this goes to the page.
        alreadyRows: already,
        noUnit: toWrite.filter((r) => r.unitWhy).map((r) => ({ rows: r.fromRows, invoice_no: r.invoice_no, container_no: r.container_no, why: r.unitWhy })),
        unresolved: toWrite.filter((r) => !r.claim_type).map((r) => ({ invoice_no: r.invoice_no, container_no: r.container_no, why: r.type_unresolved })),
        byStatus: toWrite.reduce((o, r) => { o[r.status] = (o[r.status] || 0) + 1; return o; }, {}),
        byKind,
        vocabulary,
        totals: {
            claimed: Math.round(sum(toWrite, 'claim_amount') * 100) / 100,
            recovered: Math.round(sum(toWrite, 'our_claim') * 100) / 100,
            net: Math.round((sum(toWrite, 'claim_amount') - sum(toWrite, 'our_claim')) * 100) / 100,
        },
    };
}

// ── COMMIT — writes exactly what plan() decided ──────────────────────────────
// create() never sets money by design, so the figures the sheet already holds go
// on in a second step and the history line records where they came from.
async function commit(p, by = 'sheet-import') {
    const created = [];
    for (const r of p.claims) {
        if (r.kind) await claimKinds.ensure(r.kind.label, r.kind.description, 'ai');
        const rec = await claims.create({
            claim_type: r.claim_type,
            customer: r.customer, supplier: r.supplier,
            invoice_no: r.invoice_no, container_no: r.container_no,
            invoice_weight: r.invoice_weight, claimed_weight: r.claimed_weight,
            weight_unit: r.weight_unit,
            sell_price: r.sell_price, sell_price_unit: r.weight_unit,
            note: [r.note, r.unitWhy].filter(Boolean).join(' | '),
        }, by);
        const patch = { status: r.status, quotes: { claim_type: r.type_quote || r.type_why || r.type_unresolved || '' } };
        if (r.claim_amount !== null) patch.claim_amount = r.claim_amount;
        if (r.our_claim !== null) patch.our_claim = r.our_claim;
        if (r.shortage !== null) patch.shortage = r.shortage;
        if (r.invoice_weight && r.shortage !== null && r.invoice_weight > 0 && r.invoice_weight <= 100) {
            patch.shortage_pct = Math.round((r.shortage / r.invoice_weight) * 10000) / 100;
        }
        await claims.update(rec.id, patch, by,
            `imported from ${p.source}, row ${r.fromRows.join('+')} (${r.block}) — figures as the sheet recorded them`);
        created.push(rec.id);
    }
    return { created: created.length, ids: created };
}

// ── RE-ASK about claims already in the register ──────────────────────────────
async function reclassify(p, { write = false, useAi = true } = {}) {
    const out = { changed: [], kept: 0, couldNotSay: 0 };
    for (const r of p.already) {
        const current = claims.get(r.existingId);
        if (!current) continue;
        const row = (p.alreadyRows || []).find((x) => x.existingId === r.existingId);
        const text = row ? [row.text, ...(row.otherTexts || [])].filter(Boolean).join(' || ') : '';
        if (!text || !useAi) { out.couldNotSay += 1; continue; }
        const v = await claimKind.decide(text);
        if (!v.slug) { out.couldNotSay += 1; continue; }
        if (v.slug === current.claim_type) { out.kept += 1; continue; }
        out.changed.push({ id: current.id, container_no: current.container_no, invoice_no: current.invoice_no, from: current.claim_type, to: v.slug, why: v.why });
        if (write) {
            await claims.update(current.id, {
                claim_type: v.slug,
                quotes: { ...(current.quotes || {}), claim_type: v.quote || v.why || '' },
            }, 'sheet-import', `kind re-read by the model: ${claimKinds.label(current.claim_type)} → ${claimKinds.label(v.slug)}`);
        }
    }
    return out;
}

module.exports = { plan, commit, reclassify, readSheet, walk, group, classifyAll, mapColumns, isHeaderRow, unitFor, statusFor, cellText };
