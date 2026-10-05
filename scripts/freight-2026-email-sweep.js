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
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
const gmail = require(path.join(ROOT, 'helpers/gmail'));
const gemini = require(path.join(ROOT, 'helpers/gemini'));
const verify = require(path.join(ROOT, 'helpers/invoiceVerify'));

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i === -1 ? null : (argv[i + 1] || ''); };
const ONLY = arg('--party') ? arg('--party').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
const LIMIT = Number(arg('--limit')) || 200;

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
        idFields: ['container_no'],
    },
    {
        key: 'sher', label: 'Sher Trucking',
        query: `${YEAR_SCOPE} ("sher trucking" OR "sher")`,
        extract: (b) => gemini.extractSherTruckingInvoiceRecords(b),
        crossCheck: (recs) => verify.crossCheckSherRecords(recs),
        idFields: ['booking_no'],
    },
    {
        key: 'ajtransport', label: 'AJ Transport',
        query: `${YEAR_SCOPE} ("AJ Transport" OR "AJ Trans")`,
        extract: (b) => gemini.extractAjTransportInvoiceRecords(b),
        crossCheck: (recs) => verify.crossCheckAjTransportRecords(recs),
        idFields: ['container_no'],
    },
    {
        key: 'panmetal', label: 'Pan Metal',
        query: `${YEAR_SCOPE} ("pan metal" OR "panmetal")`,
        extract: (b) => gemini.extractCommissionDebitNoteRecords(b),
        crossCheck: (recs) => verify.crossCheckPanMetalRecords(recs),
        idFields: ['order_no'],
    },
    {
        key: 'gardunos', label: "Garduno's",
        query: `${YEAR_SCOPE} ("garduno" OR "gardunos")`,
        extract: (b) => gemini.extractGardunosInvoiceRecords(b),
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
    { key: 'eaglebrit', label: 'EagleBrit', query: `${YEAR_SCOPE} ("EagleBrit" OR "Eagle Brit")`, idFields: ['container_no', 'booking_no'] },
].map((p) => ({ ...p, extract: genericExtractInvoiceRecords, crossCheck: (recs) => verify.crossCheckJioRecords(recs), unverified: true }));

const money = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

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
                foundPdfs.push({ base64: att.base64, filename: att.filename, messageId: m.id, mailbox: mb.address, subject, from, date: hdrs.Date || '' });
            }
        }
    }

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

    const missing = (crossChecked.matched || []).filter((r) => r.status === 'not_in_sheet');
    const other = (crossChecked.matched || []).filter((r) => r.status !== 'verified' && r.status !== 'match' && r.status !== 'not_in_sheet');

    return { scanned, pdfsFound: foundPdfs.length, recordsExtracted: allRecords.length, missing, other };
}

(async () => {
    console.log(`\nFREIGHT INVOICE SWEEP — 2026, report only, nothing written\n`);

    let mailboxes;
    try { mailboxes = await gmail.getGmailReadMailboxes(); }
    catch (e) { console.error('Could not open any read mailbox:', e.message); process.exit(1); }
    if (!mailboxes.length) { console.error('No readable Gmail mailbox configured — nothing to scan.'); process.exit(1); }
    console.log(`Scanning mailbox(es): ${mailboxes.map((m) => m.address).join(', ')}\n`);

    const parties = ONLY ? PARTIES.filter((p) => ONLY.includes(p.key)) : PARTIES;
    const newParties = ONLY ? NEW_PARTIES.filter((p) => ONLY.includes(p.key)) : NEW_PARTIES;
    if (!parties.length && !newParties.length) {
        console.error(`--party matched nothing. Known keys: ${[...PARTIES, ...NEW_PARTIES].map((p) => p.key).join(', ')}`);
        process.exit(1);
    }

    async function runGroup(list, heading) {
        const out = [];
        if (!list.length) return out;
        console.log(`\n${heading}\n`);
        for (const party of list) {
            console.log(`── ${party.label}${party.unverified ? ' (generic match — unverified prompt, lower confidence)' : ''} ──────────────────────────────────────`);
            const r = await sweepParty(party, mailboxes);
            out.push({ party, ...r });
            console.log(`  Emails matched: ${r.scanned}   PDFs with attachments: ${r.pdfsFound}   Line items extracted: ${r.recordsExtracted}`);
            if (r.missing.length) {
                console.log(`  >> ${r.missing.length} NOT IN THE SHEET:`);
                for (const rec of r.missing) {
                    const id = party.idFields.map((f) => rec[f]).filter(Boolean).join(' / ') || '(no reference number on the PDF)';
                    console.log(`     - ${id}   ${money(rec.amount)}   from "${rec.source_subject.slice(0, 60)}" (${rec.source_date || 'no date'}, ${rec.source_file})`);
                }
            } else {
                console.log(`  Nothing missing — every extracted line item matched the sheet.`);
            }
            if (r.other.length) {
                console.log(`  (${r.other.length} other row(s) need a look — mismatch/blank/unreadable, not a clean "missing" case.)`);
            }
            console.log('');
        }
        return out;
    }

    const trustedResults = await runGroup(parties, '═══ KNOWN PARTIES — trusted, party-specific extraction + sheet rules ═══');
    const newResults = await runGroup(newParties, '═══ NEW / UNVERIFIED — generic container match, read these more skeptically ═══');
    const results = [...trustedResults, ...newResults];

    console.log('══════════════════════════════════════════════════════════');
    console.log('SUMMARY — nothing was written to the sheet, bills.json, or anywhere else.\n');
    for (const r of results) {
        console.log(`  ${r.party.label.padEnd(14)} ${String(r.missing.length).padStart(3)} missing   (${r.recordsExtracted} line items checked across ${r.pdfsFound} PDFs)${r.party.unverified ? '   [unverified]' : ''}`);
    }
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
