#!/usr/bin/env node
// ── scripts/freight-2026-email-sweep.js ───────────────────────────────────
//
// Apsara, 2026-10-05: "i need to check all the emails in 2026 to find any
// invoice from freight agent and it is not there in my sheet. If there is
// any new company detected, create that, create a bill against that in
// Edge Metals spreadsheet"
//
// Scope confirmed with her: the six known parties already wired into the
// Verify tab — Zimex, Jio, Sher Trucking, AJ Transport, Pan Metal,
// Garduno's — not cold/unknown senders. Those six already have real,
// trusted extraction + cross-check logic (helpers/gemini.js's extract*
// functions, helpers/invoiceVerify.js's crossCheck* functions) — today they
// only run when she manually drops PDFs into the Verify tab. This script
// does the same PDF-sourcing differently (pulls from Gmail across all of
// 2026 instead of a manual drop) and runs the PDFs through the EXACT SAME
// extraction/cross-check pipeline. No new business logic, no new judgment
// about what counts as a match — same code, same rules, just a different
// source of PDFs.
//
// ── REPORT ONLY — NOTHING IS WRITTEN ──────────────────────────────────────
// Same posture as scripts/bills-year-audit.js, for the same reason: this
// touches what she's owed and what she owes, and a bill created from a
// misread PDF or a name variant she'd actually recognize as an existing
// supplier is a real-money mistake, not a display bug. This script finds
// and lists candidates; it does not create a company, a bill, or a sheet
// row. That is a deliberate second step, after she's looked at this list —
// see the printed summary at the end for exactly what to do next.
//
// Usage:
//   node scripts/freight-2026-email-sweep.js
//   node scripts/freight-2026-email-sweep.js --party zimex,jio   (scope to some)
//   node scripts/freight-2026-email-sweep.js --limit 300          (per party, per mailbox)

const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
const gmail = require(path.join(ROOT, 'helpers/gmail'));
const gemini = require(path.join(ROOT, 'helpers/gemini'));
const verify = require(path.join(ROOT, 'helpers/invoiceVerify'));

const argv = process.argv.slice(2);
// The extractors log one "[GEMINI] ..." line per PDF — hundreds per run,
// which buried the actual report last time. Hidden unless --verbose.
if (!argv.includes('--verbose')) {
    const origLog = console.log;
    console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('[GEMINI]')) return; origLog(...a); };
}
const arg =(name) => { const i = argv.indexOf(name); return i === -1 ? null : (argv[i + 1] || ''); };
const ONLY = arg('--party') ? arg('--party').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
const LIMIT = Number(arg('--limit')) || 200;
// --write: log VERIFIED rows into each party's tab on the Edge Metals sheet
// (Jio, Sher, AJ Transport, Pan metal), exactly as the Verify tab does.
// Default is report-only.
const WRITE = argv.includes('--write');
// --save-samples [dir]: write every unique PDF found to <dir>/<party>/ (default
// data/sample-invoices, gitignored with the rest of data/). --save-only: do that
// and STOP — no Gemini, no sheet check, no logging — so it runs anywhere Gmail
// works. Purpose: NTG / TQL / Schneider are inert tabs in documents.html
// because "the parsing waits for a sample"; this fetches the samples.
const SAVE_ONLY = argv.includes('--save-only');
const SAVE_DIR = (SAVE_ONLY || argv.includes('--save-samples'))
    ? path.resolve(ROOT, (arg('--save-samples') && !arg('--save-samples').startsWith('--')) ? arg('--save-samples') : 'data/sample-invoices')
    : null;
const TRUCKING_CAP = 3000; // per load, for the Jio / Sher / AJ Transport tabs

// ── Party registry ─────────────────────────────────────────────────────────
// query: broad name-based Gmail search — deliberately loose (better to pull
// a few irrelevant hits for her to skip than to silently miss a real
// invoice because the query was too narrow). Scoped to 2026 and PDF
// attachments only, matching how every one of these PDFs actually arrives.
const YEAR_SCOPE = 'after:2026/1/1 before:2027/1/1 has:attachment filename:pdf';
const PARTIES = [
    {
        key: 'zimex', label: 'Zimex',
        query: `${YEAR_SCOPE} "zimex"`,
        extract: (b) => gemini.extractFreightInvoiceRecords(b),
        crossCheck: (recs) => verify.crossCheckZimexRecords(recs),
        idFields: ['hbl_no', 'container_no', 'booking_no'],
    },
    {
        key: 'jio', label: 'Jio',
        query: `${YEAR_SCOPE} "jio"`,
        extract: (b) => gemini.extractJioInvoiceRecords(b),
        crossCheck: (recs) => verify.crossCheckJioRecords(recs),
        sheetLog: { tab: 'Jio', fn: (m) => require(path.join(ROOT, 'helpers/jioSheetLog')).logJioVerification(m) },
        idFields: ['container_no'],
    },
    {
        key: 'sher', label: 'Sher Trucking',
        query: `${YEAR_SCOPE} "sher trucking"`, // bare "sher" dropped 2026-10-06: it pulled Edge's own sealed-units invoice into this party's results
        extract: (b) => gemini.extractSherTruckingInvoiceRecords(b),
        crossCheck: (recs) => verify.crossCheckSherRecords(recs),
        sheetLog: { tab: 'Sher', fn: (m) => require(path.join(ROOT, 'helpers/sherSheetLog')).logSherVerification(m) },
        idFields: ['booking_no'],
    },
    {
        key: 'ajtransport', label: 'AJ Transport',
        query: `${YEAR_SCOPE} ("AJ Transport" OR "AJ Trans")`,
        extract: (b) => gemini.extractAjTransportInvoiceRecords(b),
        crossCheck: (recs) => verify.crossCheckAjTransportRecords(recs),
        sheetLog: { tab: 'AJ Transport', fn: (m) => require(path.join(ROOT, 'helpers/ajTransportSheetLog')).logAjTransportVerification(m) },
        idFields: ['container_no'],
    },
    {
        key: 'panmetal', label: 'Pan Metal',
        query: `${YEAR_SCOPE} ("pan metal" OR "panmetal")`,
        extract: (b) => gemini.extractCommissionDebitNoteRecords(b),
        crossCheck: (recs) => verify.crossCheckPanMetalRecords(recs),
        sheetLog: { tab: 'Pan metal', fn: (m) => require(path.join(ROOT, 'helpers/panMetalSheetLog')).logPanMetalVerification(m) },
        idFields: ['order_no'],
    },
    {
        key: 'gardunos', label: "Garduno's",
        query: `${YEAR_SCOPE} ("garduno" OR "gardunos")`,
        // BUG FOUND 2026-10-06 in the first real run: this extractor returns
        // { lines: [...] }, not { records: [...] } like the others, so reading
        // `.records` silently dropped every Garduno's line (the log showed 15
        // lines extracted, the report said 0). api.js's /api/verify/gardunos
        // runs the result through expandInvoice() to get per-container
        // records and stamps invoice_no/date on each — mirrored exactly here.
        extract: async (b) => {
            const ex = await gemini.extractGardunosInvoiceRecords(b);
            if (!ex || !Array.isArray(ex.lines) || !ex.lines.length) return { records: [] };
            const exp = require(path.join(ROOT, 'helpers/gardunosInvoice')).expandInvoice(ex);
            return { records: (exp.records || []).map((r) => ({ ...r, invoice_no: exp.invoice_no, invoice_date: exp.invoice_date })) };
        },
        crossCheck: (recs) => verify.crossCheckGardunosRecords(recs),
        idFields: ['container_no'],
    },
];

// ── New / unverified parties ───────────────────────────────────────────────
// Apsara, follow-up: "then tql,ntg,eaglebrit" — three more to sweep for, but
// none of them has a helpers/gemini.js extractor or an
// helpers/invoiceVerify.js crossCheck function the way the six above do.
// Rather than invent party-specific prompts for companies whose invoice
// layout I've never seen (the same mistake as the Verification-tab
// placeholder commit, just one layer deeper), this uses ONE generic
// container-based extraction prompt for all three, and reuses
// crossCheckJioRecords for the sheet match — that function has no Jio-
// specific logic in it at all, it's a plain "is this container on the
// sheet" lookup (confirmed by reading it), so reusing it here isn't a
// stretch, it's exactly what it already does for Jio.
// LOWER CONFIDENCE than the six above — flagged as such in the report. No
// change to helpers/gemini.js or helpers/invoiceVerify.js; this stays
// entirely inside this script so it can't affect the Verify tab or any
// existing party's behavior.
async function genericExtractInvoiceRecords(pdfBase64) {
    const prompt = `You are a freight/trucking billing expert. This PDF is an invoice from a trucking or freight company whose exact layout you have not seen before. Extract every line item as best you can. Return ONLY raw JSON — no markdown, no prose.

{
  "records": [
    {
      "container_no": null, // container number this line item bills, if shown
      "booking_no": null,   // booking/carrier reference, if shown
      "description": null,  // short description of the charge
      "amount": 0           // billed amount in US dollars, plain number, no $ or commas
    }
  ],
  "invoice_no": null,
  "invoice_date": null // MM/DD/YYYY
}

If a container number isn't present but a booking number is, still return the record with container_no null — do not guess or invent either value. Return the JSON object and nothing else.`;
    const model = gemini.getClient().getGenerativeModel({
        model: gemini.getModelName(),
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
    });
    const result = await model.generateContent([
        { text: prompt },
        { inlineData: { mimeType: 'application/pdf', data: pdfBase64 } },
    ]);
    const parsed = gemini.extractJson(result.response.text());
    return (parsed && Array.isArray(parsed.records)) ? parsed : { records: [] };
}

const NEW_PARTIES = [
    { key: 'tql', label: 'TQL', query: `${YEAR_SCOPE} ("TQL" OR "Total Quality Logistics")`, idFields: ['container_no', 'booking_no'] },
    { key: 'ntg', label: 'NTG', query: `${YEAR_SCOPE} ("NTG" OR "Nolan Transportation")`, idFields: ['container_no', 'booking_no'] },
    { key: 'schneider', label: 'Schneider', query: `${YEAR_SCOPE} ("Schneider National" OR "Schneider Logistics" OR "Schneider Freight")`, idFields: ['container_no', 'booking_no'] },
    { key: 'eaglebrit', label: 'EagleBrit', query: `${YEAR_SCOPE} ("EagleBrit" OR "Eagle Brit")`, idFields: ['container_no', 'booking_no'] },
].map((p) => ({ ...p, extract: genericExtractInvoiceRecords, crossCheck: (recs) => verify.crossCheckJioRecords(recs), unverified: true }));

const money = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

// ── --save-emails: dump the EMAIL TEXT, no PDF required ───────────────────
// Apsara, 2026-10-07: for NTG / TQL / Schneider "there is no pdf, in mail
// there will be payment remittance" and "you have swept my mail already".
// The sweep never saw those: its query demands a PDF attachment and it only
// printed totals. This saves each matching email (headers + body text) to
// <SAVE_DIR>/<party>/emails/ so the remittance layout can be read from real
// mail. Read-only; Gmail only, no Gemini.
async function dumpEmails(party, mailboxes) {
    const query = party.query.replace(YEAR_SCOPE, 'after:2026/1/1 before:2027/1/1');
    const seen = new Set();
    let saved = 0;
    const subjects = [];
    const dir = path.join(SAVE_DIR || path.resolve(ROOT, 'data/sample-invoices'), party.key, 'emails');
    fs.mkdirSync(dir, { recursive: true });
    for (const mb of mailboxes) {
        let messages = [];
        try { messages = await gmail.listMessages(mb.client, query, LIMIT); }
        catch (e) { console.error(`  [${party.label}] search failed on ${mb.role}:`, e.message); continue; }
        for (const m of messages) {
            let msg;
            try { msg = await gmail.getMessage(mb.client, m.id); } catch (e) { continue; }
            const hdrs = Object.fromEntries((msg.payload.headers || []).map((h) => [h.name.toLowerCase(), h.value]));
            const rfc = hdrs['message-id'];
            if (rfc) { if (seen.has(rfc)) continue; seen.add(rfc); }
            let body = '';
            try { body = (gmail.getEmailContent(msg.payload).body || '').trim(); } catch (e) { /* header-only is still useful */ }
            const d = new Date(hdrs.date || ''); const ymd = Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : 'undated';
            const subj = hdrs.subject || '(no subject)';
            const safe = subj.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 50);
            fs.writeFileSync(path.join(dir, `${ymd}_${m.id.slice(0, 8)}_${safe}.txt`),
                `From: ${hdrs.from || ''}\nTo: ${hdrs.to || ''}\nDate: ${hdrs.date || ''}\nSubject: ${subj}\nMailbox: ${mb.address}\n\n${body}\n`);
            subjects.push(`${ymd}  ${subj.slice(0, 90)}`);
            saved += 1;
        }
    }
    console.log(`── ${party.label}: saved ${saved} email(s) to ${dir}`);
    subjects.sort().reverse().slice(0, 25).forEach((x) => console.log(`     ${x}`));
}

async function sweepParty(party, mailboxes) {
    const foundPdfs = []; // [{ base64, filename, messageId, mailbox, subject, from, date }]
    let scanned = 0;

    // ── Cross-mailbox dedup ───────────────────────────────────────────────
    // Apsara, 2026-10-06: "if the same mail is there in both inbox, will it
    // ignore one?" — it did NOT, before this. Gmail gives each mailbox its
    // own internal message id, so a CC'd copy (same email, landed in both
    // bose@ and apsara@) was being fetched, extracted, and cross-checked
    // TWICE — double the Gemini calls, and the same real invoice showing up
    // twice in the "missing" report. The RFC Message-ID header is identical
    // across both copies of a genuinely duplicated email (unlike Gmail's own
    // per-mailbox id), so that's the key used here. Case-insensitive lookup
    // because header casing on the wire varies ("Message-ID" vs
    // "Message-Id"). A message with no Message-ID header at all is never
    // deduped — safer to risk a double-count than to silently drop a real
    // invoice because of a missing header.
    const seenRfcIds = new Set();
    const seenPdfHashes = new Set();
    let dupPdfs = 0;
    let outboundSkipped = 0;
    let saved = 0;
    // Edge's OWN outbound packs ('Documents of 26MT12/…', 'Proforma for …') carry
    // Edge's commercial invoices, packing lists and marine certificates. They
    // mention carriers/truckers in passing and are NOT vendor invoices. First
    // --write run logged a $25,418.22 'Sher' row from one of them (the
    // sealed-units sale invoice 260903_SU_26NUR02), and a $64,593.76 Zimex
    // 'missing' was a marine certificate's insured value.
    const OUTBOUND_PACK = /\b(documents of|proforma for|revised proforma)\b/i;
    const getHeader = (hdrs, name) => {
        const key = Object.keys(hdrs).find((k) => k.toLowerCase() === name.toLowerCase());
        return key ? hdrs[key] : null;
    };

    for (const mb of mailboxes) {
        let messages;
        try {
            messages = await gmail.listMessages(mb.client, party.query, LIMIT);
        } catch (e) {
            console.error(`  [${party.label}] search failed on ${mb.role} (${mb.address}):`, e.message);
            continue;
        }
        scanned += messages.length;
        for (const m of messages) {
            let msg;
            try { msg = await gmail.getMessage(mb.client, m.id); }
            catch (e) { console.error(`  [${party.label}] could not fetch message ${m.id}:`, e.message); continue; }
            const hdrs = Object.fromEntries((msg.payload.headers || []).map((h) => [h.name, h.value]));
            const subject = hdrs.Subject || '(no subject)';
            const from = hdrs.From || '(unknown sender)';
            if (OUTBOUND_PACK.test(subject)) { outboundSkipped += 1; continue; }

            const rfcId = getHeader(hdrs, 'Message-ID');
            if (rfcId) {
                if (seenRfcIds.has(rfcId)) {
                    console.log(`  [${party.label}] skipping duplicate — same Message-ID already seen in another mailbox: "${subject.slice(0, 50)}"`);
                    continue;
                }
                seenRfcIds.add(rfcId);
            }

            const { pdfParts } = gmail.getEmailContent(msg.payload);
            for (const part of pdfParts) {
                let att;
                try { att = await gmail.downloadAttachment(mb.client, m.id, part); }
                catch (e) { console.error(`  [${party.label}] could not download attachment on "${subject.slice(0, 50)}":`, e.message); continue; }
                // Same PDF bytes arriving in a reply, a forward, a second
                // thread: the first real run extracted GLTOER-27715 four
                // times over. Message-ID can't catch that (different
                // emails); the content hash can. Processed once, first
                // sighting wins.
                const hash = crypto.createHash('sha256').update(att.base64).digest('hex');
                if (seenPdfHashes.has(hash)) { dupPdfs += 1; continue; }
                seenPdfHashes.add(hash);
                foundPdfs.push({ base64: att.base64, filename: att.filename, messageId: m.id, mailbox: mb.address, subject, from, date: hdrs.Date || '' });
                if (SAVE_DIR) {
                    const d = new Date(hdrs.Date || ''); const ymd = Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : 'undated';
                    const dir = path.join(SAVE_DIR, party.key); fs.mkdirSync(dir, { recursive: true });
                    const safe = String(att.filename || 'invoice.pdf').replace(/[^A-Za-z0-9._-]+/g, '_');
                    fs.writeFileSync(path.join(dir, `${ymd}_${hash.slice(0, 8)}_${safe}`), Buffer.from(att.base64, 'base64'));
                    saved += 1;
                }
            }
        }
    }

    if (SAVE_ONLY) {
        console.log(`  Saved ${saved} PDF(s) to ${path.join(SAVE_DIR, party.key)}`);
        return { scanned, pdfsFound: foundPdfs.length, dupPdfs, outboundSkipped, recordsExtracted: 0, missing: [], missingNoAmount: 0, verifiedCount: 0, unchecked: 0, statusCounts: {}, recMoney: () => 0, matched: [] };
    }
    if (SAVE_DIR) console.log(`  Saved ${saved} PDF(s) to ${path.join(SAVE_DIR, party.key)}`);

    // Extract every PDF found, tag with its source email so a "not in
    // sheet" hit in the report can be traced straight back to the email.
    const allRecords = [];
    for (const pdf of foundPdfs) {
        let extracted;
        try { extracted = await party.extract(pdf.base64); }
        catch (e) {
            console.error(`  [${party.label}] extraction failed on "${pdf.subject.slice(0, 50)}" (${pdf.filename}):`, e.message);
            continue;
        }
        const records = (extracted && extracted.records) || [];
        for (const r of records) {
            allRecords.push({ ...r, source_file: pdf.filename, source_subject: pdf.subject, source_from: pdf.from, source_date: pdf.date, source_mailbox: pdf.mailbox });
        }
    }

    let crossChecked = { matched: [] };
    if (allRecords.length) {
        try { crossChecked = await party.crossCheck(allRecords); }
        catch (e) { console.error(`  [${party.label}] cross-check against the sheet failed:`, e.message); }
    }

    // ── What "missing" honestly means ─────────────────────────────────────
    // First real run: Zimex reported 89 "missing" and every one was a $0.00
    // booking-confirmation PDF (DALA…) pulled in because the email merely
    // MENTIONED Zimex. A not_in_sheet row only counts as a missing INVOICE
    // when it carries money. Rows with no amount are reported as a count,
    // not a list — they are almost certainly not invoices.
    const recMoney = (r) => { const v = r.amount != null ? r.amount : r.commission; const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const all = crossChecked.matched || [];
    const notInSheet = all.filter((r) => r.status === 'not_in_sheet');
    const missingNoAmount = notInSheet.filter((r) => recMoney(r) <= 0).length;
    // Same invoice line seen more than once (different PDFs, same content)
    // collapses to one row with a count.
    const uniq = new Map();
    for (const r of notInSheet.filter((x) => recMoney(x) > 0)) {
        const k = [...party.idFields.map((f) => r[f] || ''), r.invoice_no || '', recMoney(r)].join('|');
        if (uniq.has(k)) uniq.get(k).seen += 1; else uniq.set(k, { ...r, seen: 1 });
    }
    const missing = [...uniq.values()];
    const verifiedCount = all.filter((r) => r.status === 'verified' || r.status === 'match').length;
    const statusCounts = {};
    for (const r of all) if (r.status !== 'verified' && r.status !== 'match' && r.status !== 'not_in_sheet') statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
    const unchecked = Object.values(statusCounts).reduce((a, n) => a + n, 0);

    return { scanned, pdfsFound: foundPdfs.length, dupPdfs, outboundSkipped, recordsExtracted: allRecords.length, missing, missingNoAmount, verifiedCount, unchecked, statusCounts, recMoney, matched: all };
}

(async () => {
    console.log(`\nFREIGHT INVOICE SWEEP — 2026, ${WRITE ? 'WRITE MODE: verified rows ARE being logged to the party tabs' : 'report only, nothing written'}\n`);

    let mailboxes;
    try { mailboxes = await gmail.getGmailReadMailboxes(); }
    catch (e) { console.error('Could not open any read mailbox:', e.message); process.exit(1); }
    if (!mailboxes.length) { console.error('No readable Gmail mailbox configured — nothing to scan.'); process.exit(1); }
    console.log(`Scanning mailbox(es): ${mailboxes.map((m) => `${m.role}=${m.address}`).join(', ')}\n`);

    // ── Coverage guard ────────────────────────────────────────────────────
    // Apsara asked specifically for bose@edgemetals.com to be scanned. The
    // first real run scanned apsara@ only and still printed a confident
    // report. A sweep that silently skips the mailbox carrier mail lands in
    // is worse than no sweep, so it now refuses unless bose@ is present
    // (or she explicitly says she knows, with --allow-single-mailbox).
    const hasBose = mailboxes.some((m) => /^bose@/i.test(m.address || ''));
    if (!hasBose && !argv.includes('--allow-single-mailbox')) {
        console.error('STOPPED: bose@edgemetals.com is not among the mailboxes being scanned.');
        console.error('  Resolved: ' + mailboxes.map((m) => `${m.role}=${m.address}`).join(', '));
        console.error('  If the read2 token was authorised while signed into apsara@, it resolves to the same');
        console.error('  account as "read" and is skipped as a duplicate. Re-run');
        console.error('    node scripts/gmail-auth.js --role=read2');
        console.error('  in a browser profile signed into bose@edgemetals.com only (or an incognito window),');
        console.error('  then check:  node -e "require(\'./helpers/gmail.js\').getGmailReadMailboxes().then(m => console.log(m.map(x => x.role + \' = \' + x.address)))"');
        console.error('  To run anyway on what is configured: add --allow-single-mailbox.');
        process.exit(2);
    }

    const parties = ONLY ? PARTIES.filter((p) => ONLY.includes(p.key)) : PARTIES;
    const newParties = ONLY ? NEW_PARTIES.filter((p) => ONLY.includes(p.key)) : NEW_PARTIES;
    if (!parties.length && !newParties.length) {
        console.error(`--party matched nothing. Known keys: ${[...PARTIES, ...NEW_PARTIES].map((p) => p.key).join(', ')}`);
        process.exit(1);
    }

    if (argv.includes('--save-emails')) {
        for (const party of [...parties, ...newParties]) await dumpEmails(party, mailboxes);
        console.log('\nDone — emails saved, nothing sent anywhere, nothing written to the sheet.');
        return;
    }

    async function runGroup(list, heading) {
        const out = [];
        if (!list.length) return out;
        console.log(`\n${heading}\n`);
        for (const party of list) {
            console.log(`── ${party.label}${party.unverified ? ' (generic match — unverified prompt, lower confidence)' : ''} ──────────────────────────────────────`);
            const r = await sweepParty(party, mailboxes);
            out.push({ party, ...r });
            console.log(`  Emails matched: ${r.scanned}   Unique PDFs: ${r.pdfsFound} (+${r.dupPdfs} identical repeats skipped)   Line items: ${r.recordsExtracted}   Edge outbound doc-packs skipped: ${r.outboundSkipped}`);
            console.log(`  Checked OK: ${r.verifiedCount}   Missing (with an amount): ${r.missing.length}   Not-in-sheet but no amount: ${r.missingNoAmount}   COULD NOT BE CHECKED: ${r.unchecked}`);
            if (r.missing.length) {
                console.log(`  >> NOT IN THE SHEET, with money on them:`);
                for (const rec of r.missing) {
                    const id = party.idFields.map((f) => rec[f]).filter(Boolean).join(' / ') || '(no reference number on the PDF)';
                    const inv = rec.invoice_no ? ` inv ${rec.invoice_no}` : '';
                    console.log(`     - ${id}${inv}   ${money(r.recMoney(rec))}${rec.seen > 1 ? ` (x${rec.seen})` : ''}   from "${rec.source_subject.slice(0, 60)}" (${rec.source_date || 'no date'}, ${rec.source_file})`);
                }
            }
            if (r.missingNoAmount) {
                console.log(`  (${r.missingNoAmount} not-in-sheet row(s) carried no amount — typically booking confirmations / certificates / the party merely mentioned in the email, not invoices. Not listed.)`);
            }
            if (r.unchecked) {
                console.log(`  Could not be checked, by reason: ${Object.entries(r.statusCounts).map(([s, n]) => `${s}=${n}`).join(', ')}`);
            }

            // ── Logging verified rows into the party's tab (opt-in) ──────
            // Apsara, 2026-10-06: "IT SHOULD BE ADDED NA?" — yes, but only
            // VERIFIED rows, which is what the Verify tab already does and
            // what each *SheetLog.js enforces itself (a not-in-sheet or
            // booking-mismatch row is the error she wants SEEN, never
            // written as if confirmed). Same functions, same upsert key
            // (container / booking / inv no.), so a re-run updates rows in
            // place instead of duplicating. Oldest invoice first so that if
            // a container appears on several invoices the LATEST one is the
            // one left standing (upsertRowsByKey keeps the last occurrence).
            // CAUTION: an existing row for the same key is OVERWRITTEN with
            // the PDF's figures — a hand-edit made in that tab since is lost.
            if (party.sheetLog) {
                // Pan Metal's good status is 'match', the others' is 'verified'
                // (first --write run printed "nothing verified" for Pan Metal
                // while 48 rows had matched — this filter only looked for
                // 'verified'). Each *SheetLog re-filters to its own status.
                const good = (r.matched || []).filter((x) => x.status === 'verified' || x.status === 'match');
                // Sanity cap for the three trucker tabs: a drayage invoice
                // line is hundreds of dollars, never tens of thousands.
                const TRUCKER = ['jio', 'sher', 'ajtransport'].includes(party.key);
                const rowAmt = (x) => Number(x.net_amount ?? x.total_amount ?? x.amount ?? 0) / (Number(x.quantity) > 0 ? Number(x.quantity) : 1);
                const suspicious = TRUCKER ? good.filter((x) => rowAmt(x) > TRUCKING_CAP) : [];
                const loggable = good.filter((x) => !suspicious.includes(x));
                if (suspicious.length) {
                    console.log(`  NOT LOGGED — ${suspicious.length} row(s) over $${TRUCKING_CAP} per load, too large for a trucking line (probably not a ${party.label} invoice): ` +
                        suspicious.map((x) => `${x.booking_no || x.container_no || '?'} ${money(rowAmt(x))}`).join('; '));
                }
                if (!WRITE) {
                    console.log(`  ${loggable.length} verified row(s) are ready to log into the "${party.sheetLog.tab}" tab — NOT written (add --write).`);
                } else if (!loggable.length) {
                    console.log(`  Nothing to log into "${party.sheetLog.tab}".`);
                } else {
                    const ts = (x) => { const t = Date.parse(x.invoice_date || ''); return Number.isFinite(t) ? t : 0; };
                    const ordered = [...loggable].sort((a, b) => ts(a) - ts(b));
                    try {
                        const res = await party.sheetLog.fn(ordered);
                        console.log(`  WROTE to "${party.sheetLog.tab}" tab: ${res.logged || 0} new row(s), ${res.updated || 0} existing row(s) updated.`);
                    } catch (e) {
                        console.error(`  FAILED writing to "${party.sheetLog.tab}" tab:`, e.message);
                    }
                }
            } else if (party.key === 'zimex') {
                console.log('  (Zimex has no sheet tab — its figures are offered as a charge on the sale row via the Verify tab; not written from here.)');
            } else if (party.key === 'gardunos') {
                console.log("  (Garduno's has no sheet tab — it produces bill proposals via the Verify tab; not written from here.)");
            }
            console.log('');
        }
        return out;
    }

    const trustedResults = await runGroup(parties, '═══ KNOWN PARTIES — trusted, party-specific extraction + sheet rules ═══');
    const newResults = await runGroup(newParties, '═══ NEW / UNVERIFIED — generic container match, read these more skeptically ═══');
    const results = [...trustedResults, ...newResults];

    console.log('══════════════════════════════════════════════════════════');
    console.log(WRITE ? 'SUMMARY — verified rows were logged to the party tabs above (see WROTE lines). Nothing else was written.\n' : 'SUMMARY — nothing was written to the sheet, bills.json, or anywhere else.\n');
    console.log(`  ${'party'.padEnd(14)} ${'missing'.padStart(7)} ${'checked-ok'.padStart(11)} ${'unchecked'.padStart(10)}   (line items / unique PDFs)`);
    for (const r of results) {
        console.log(`  ${r.party.label.padEnd(14)} ${String(r.missing.length).padStart(7)} ${String(r.verifiedCount).padStart(11)} ${String(r.unchecked).padStart(10)}   (${r.recordsExtracted} / ${r.pdfsFound})${r.party.unverified ? '   [unverified]' : ''}`);
    }
    console.log('\n  "unchecked" rows are NOT proven present in the sheet — the check could not run on them. Read that column before trusting a low "missing" count.');
    const totalMissing = results.reduce((a, r) => a + r.missing.length, 0);
    console.log(`\n  ${totalMissing} total candidate(s) across all parties.`);
    if (totalMissing) {
        console.log('\n  NEXT STEP, per Apsara\'s own "propose, don\'t pick" rule for this repo:');
        console.log('  send me this output (or paste it back) and I\'ll go through it with you —');
        console.log('  which of these are a real missing invoice vs. a name variant of a');
        console.log('  supplier that already exists, before anything gets created as a bill.');
        console.log('  For TQL/NTG/EagleBrit specifically: confirm each hit is really that');
        console.log('  company (the generic prompt has no party-specific validation) before');
        console.log('  treating any of them as a new company to create.');
    }
    console.log('');
})().catch((e) => { console.error('\nSweep failed:', e); process.exit(1); });
