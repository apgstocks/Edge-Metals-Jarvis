#!/usr/bin/env node
// ── scripts/documents-folder-audit.js — is each saved PDF in the right tab? ──
//
// Apsara, 2026-09-30: "why invoices coming in proforma tab?" and then the
// rule: "proform ashould be in proforma,inv in invoice".
//
// ── WHY A SCRIPT AND NOT A FIX ────────────────────────────────────────────
// Reading the code, no path can file a commercial invoice under proforma:
// /api/proforma/generate and the voice path both render
// assets/proforma-dc2/template.html, whose footer says "Proforma Invoice",
// and every invoice writer calls saveInvoiceCopy which writes under
// invoice/<date>/<container>/. So either something outside those paths put
// files there, or the files are proformas that merely LOOK like invoices —
// because a proforma's number comes from helpers/nextInvoiceNo.js, which
// reads her live commercial-invoice sheet, so the saved name is a string
// like 260823_AC_26JY90_Taewon_Metal.pdf. That is an invoice number on a
// proforma, and the "Saved proformas" list is therefore a list of invoice
// numbers.
//
// Those two causes need OPPOSITE fixes, and the checkout on the Mac has a
// stale August copy of the folder with 8-byte stub PDFs in it, so it cannot
// answer the question. This asks the documents themselves, on the machine
// that has the real ones.
//
// READ ONLY. It opens files and prints. It moves, renames and deletes
// nothing — deciding what to do about a misfiled document is hers, and a
// script that tidied up on its own would destroy the evidence of how the
// file got there.
//
//   node scripts/documents-folder-audit.js            every year
//   node scripts/documents-folder-audit.js --from 2026-01-01
//   node scripts/documents-folder-audit.js --verbose  list every file
//   node scripts/documents-folder-audit.js --write-cache
//        record what each one is, so the proforma tab stops listing old
//        invoices and the invoice tab shows them instead. Apsara 2026-09-30:
//        "find a way to keep old invoice in inv tab only". Still moves no
//        files — only what each TAB shows changes.
//
// Run it on the VM:
//   cd ~/Jarvis && node scripts/documents-folder-audit.js

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
// Writes the classification cache the Documents tabs read. Separate from the
// report on purpose: reading is always safe, and the only thing that changes
// what she SEES is this flag.
const WRITE_CACHE = argv.includes('--write-cache');
const fromArg = (() => {
    const i = argv.indexOf('--from');
    return i >= 0 ? argv[i + 1] : null;
})();

const cfg = require(path.join(ROOT, 'config'));
const SAVED = cfg.DOCUMENTS_SAVED_DIR;

// ── THE PRINTED TITLE IS THE ONLY HONEST ANSWER ───────────────────────────
// Not the filename, not the folder, not a stored record — the question is
// what the document SAYS it is, because that is what her customer reads.
// Each template carries exactly one of these (checked against
// assets/*/template.html, not assumed).
//
// ── MATCHED ON LETTERS ONLY, DELIBERATELY ─────────────────────────────────
// These PDFs are rendered by puppeteer with embedded Poppins and DMSans, and
// text extracted from that can arrive with the spacing anywhere: "P r o f o
// r m a", a line break mid-phrase, or no space at all. A /proforma\s+invoice/
// would then match nothing and this script would call every real document
// "unrecognised" — which reads like a finding and would be an artefact of the
// font. So every marker is matched against the text with everything except
// letters stripped out.
//
// This could not be verified end to end here: the Mac sandbox has no Chrome,
// so the real templates cannot be rendered to check what pdf-parse gets out
// of them. That is why --why exists — if a real document comes back
// unrecognised, read the text before believing the verdict.
const MARKERS = [
    { what: 'proforma',       re: /proformainvoice/ },
    { what: 'invoice',        re: /commercialinvoice/ },
    { what: 'bill of lading', re: /billoflading/ },
    { what: 'packing list',   re: /packinglist/ },
];
const lettersOnly = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
// Order matters and is deliberate: an invoice PDF also contains the words
// "packing list" in places, so "commercial invoice" must be tested first. A
// proforma is checked before both because "Proforma Invoice" contains
// "Invoice" and a looser test would call every proforma an invoice — which
// is the exact confusion this script exists to resolve.

// Which folder each kind belongs in. This IS her rule, in one place:
// "proform ashould be in proforma,inv in invoice".
const HOME = {
    proforma: 'proforma',
    invoice: 'invoice',
    'packing list': 'invoice',   // generated beside the invoice, same folder
    'bill of lading': 'bol',
};

async function classify(file) {
    let buf;
    try { buf = fs.readFileSync(file); } catch (e) { return { what: 'unreadable', why: e.message }; }
    if (buf.length < 1000) {
        // The August checkout is full of 8-to-13-byte stubs from test runs.
        // Calling one of those "misfiled" would be a false alarm, and a
        // report with false alarms in it is one she stops reading.
        return { what: 'not a pdf', why: `${buf.length} bytes — a stub or a truncated file, not a document` };
    }
    // ── TWO EXTRACTORS, BECAUSE ONE IS NOT ENOUGH ─────────────────────────
    // pdf-parse threw "bad XRef entry" on 4 of 6 valid test PDFs. Whatever
    // that is about, a report where two thirds of her documents come back
    // "unreadable" answers nothing — and worse, an unreadable file looks
    // like an absence of evidence when it is really an absence of parsing.
    // So pdftotext gets a turn before this gives up, and if BOTH fail the
    // message says both, rather than blaming the document.
    let text = '';
    const tried = [];
    try {
        text = (await require('pdf-parse')(buf)).text || '';
    } catch (e) { tried.push(`pdf-parse: ${e.message}`); }
    if (!text.trim()) {
        try {
            text = require('child_process')
                .execFileSync('pdftotext', ['-q', '-l', '2', file, '-'], { encoding: 'utf8', timeout: 20000 }) || '';
        } catch (e) {
            tried.push(`pdftotext: ${(e.message || '').split('\n')[0]}`);
        }
    }
    if (!text.trim() && tried.length) {
        return {
            what: 'unreadable',
            why: tried.join(' | ') + (/ENOENT/.test(tried.join(' '))
                ? ' — install poppler-utils on the VM (apt install poppler-utils) and re-run'
                : ''),
        };
    }
    if (!text.trim()) return { what: 'no text', why: 'scanned or image-only — nothing to read' };
    const flat = lettersOnly(text);
    for (const m of MARKERS) if (m.re.test(flat)) return { what: m.what, text };
    return {
        what: 'unrecognised',
        why: 'none of the four document titles appear in it — run with --why on this file before believing that',
        text,
    };
}

// Walks the archive without assuming a depth: proforma/ is flat,
// invoice/<date>/<container>/ is two deep, bol/<date>/ is one. Hard-coding
// three shapes here would go stale the next time a kind is added.
function walk(dir, kind, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, kind, out);
        else if (e.name.toLowerCase().endsWith('.pdf')) out.push({ file: p, folder: kind });
    }
}

// ── --why <file>: show the evidence, not the verdict ──────────────────────
// The point of this mode is that a wrong verdict here sends us after the
// wrong fix. If a real document comes back "unrecognised", this prints what
// pdf-parse actually got out of it, so the answer is the text rather than my
// guess about fonts.
async function why(target) {
    const file = path.isAbsolute(target) ? target : path.join(SAVED, target);
    if (!fs.existsSync(file)) {
        console.error(`\n  Not there: ${file}\n  Pass a path relative to ${SAVED}, or an absolute one.\n`);
        process.exit(2);
    }
    const res = await classify(file);
    console.log(`\n  ${path.relative(SAVED, file)}`);
    console.log(`  ${'─'.repeat(70)}`);
    console.log(`  verdict : ${res.what}${res.why ? ` (${res.why})` : ''}`);
    console.log(`  belongs : ${HOME[res.what] || '—'}\n`);
    if (res.text) {
        console.log(`  FIRST 1200 CHARACTERS AS EXTRACTED:`);
        console.log('  ' + res.text.slice(0, 1200).replace(/\n/g, '\n  '));
        console.log(`\n  SAME TEXT, LETTERS ONLY (this is what the markers match):`);
        console.log('  ' + lettersOnly(res.text).slice(0, 600));
    }
    console.log('');
}

(async () => {
    const whyIdx = argv.indexOf('--why');
    if (whyIdx >= 0) return why(argv[whyIdx + 1]);

    if (!fs.existsSync(SAVED)) {
        console.error(`\n  No saved-documents folder at ${SAVED}.`);
        console.error(`  If this is the Mac checkout, run it on the VM instead — that is where the real archive is.\n`);
        process.exit(2);
    }

    const files = [];
    for (const kind of fs.readdirSync(SAVED)) {
        const kindDir = path.join(SAVED, kind);
        if (fs.statSync(kindDir).isDirectory()) walk(kindDir, kind, files);
    }

    const kept = fromArg
        ? files.filter((f) => {
            const m = f.file.match(/\d{4}-\d{2}-\d{2}/);
            return !m || m[0] >= fromArg;   // undated (flat proforma) always kept
        })
        : files;

    console.log(`\n  SAVED DOCUMENTS — WHAT EACH ONE SAYS IT IS`);
    console.log(`  ${'─'.repeat(70)}`);
    console.log(`  archive : ${SAVED}`);
    console.log(`  files   : ${kept.length}${fromArg ? ` (of ${files.length}, from ${fromArg})` : ''}`);
    if (!kept.length) { console.log(`\n  Nothing to check.\n`); return; }

    const byFolder = {};
    const wrong = [];
    const unclear = [];
    const learned = [];

    for (const f of kept) {
        const res = await classify(f.file);
        // ── WHAT --write-cache IS FOR ─────────────────────────────────────
        // Only a POSITIVE identification is recorded. "unreadable", "no
        // text" and "unrecognised" are never written, because the tabs treat
        // an absent verdict as "leave it where it is" — and a stored
        // non-verdict would turn a parsing failure into a filing decision.
        if (WRITE_CACHE && require('../helpers/savedDocKinds').KNOWN.has(res.what)) {
            try {
                const st = fs.statSync(f.file);
                learned.push({
                    filename: path.basename(f.file), kind: res.what,
                    size: st.size, mtime: st.mtime.toISOString(),
                });
            } catch (e) { /* vanished mid-run; it simply stays unclassified */ }
        }
        const key = `${f.folder} / ${res.what}`;
        byFolder[key] = (byFolder[key] || 0) + 1;
        const home = HOME[res.what];
        if (home && home !== f.folder) wrong.push({ ...f, ...res, home });
        else if (!home) unclear.push({ ...f, ...res });
        if (VERBOSE) console.log(`    ${res.what.padEnd(16)} ${path.relative(SAVED, f.file)}`);
    }

    console.log(`\n  WHAT IS WHERE`);
    for (const k of Object.keys(byFolder).sort()) {
        console.log(`    ${String(byFolder[k]).padStart(5)}  in ${k}`);
    }

    if (wrong.length) {
        console.log(`\n  ── MISFILED: ${wrong.length} ─────────────────────────────────────`);
        console.log(`  These say one thing and sit in another folder, so the tab shows`);
        console.log(`  them under the wrong heading. NOTHING HAS BEEN MOVED.`);
        for (const w of wrong) {
            console.log(`\n    ${path.relative(SAVED, w.file)}`);
            console.log(`      is a ${w.what}, filed under ${w.folder}/ — belongs in ${w.home}/`);
        }
        console.log(`\n  Before moving any of these, two things need deciding:`);
        console.log(`    · an invoice moved into invoice/ needs a DATE and a CONTAINER`);
        console.log(`      folder, which a flat proforma filename does not carry;`);
        console.log(`    · helpers/proformaVersions.js keys its stored form on the`);
        console.log(`      filename, so moving a proforma breaks its Copy button.`);
    } else {
        console.log(`\n  ── NOTHING IS MISFILED ────────────────────────────────────────`);
        console.log(`  Every document readable here sits in the folder its own printed`);
        console.log(`  title says it should.`);
        console.log(`\n  If the proforma tab still LOOKS like a list of invoices, that is`);
        console.log(`  the numbering, not the filing: a proforma's number comes from`);
        console.log(`  helpers/nextInvoiceNo.js, which reads the live commercial-invoice`);
        console.log(`  sheet, so a proforma is saved as e.g. 260823_AC_26JY90_Name.pdf.`);
        console.log(`  Worth knowing before changing that: the same number is only a`);
        console.log(`  SUGGESTION and reserves nothing, so two proformas and the real`);
        console.log(`  invoice can all end up claiming one number.`);
    }

    if (unclear.length) {
        console.log(`\n  ── COULD NOT CLASSIFY: ${unclear.length} ──────────────────────────`);
        console.log(`  Reported rather than assumed — a file this cannot read is not`);
        console.log(`  evidence of anything, in either direction.`);
        for (const u of unclear.slice(0, 20)) {
            console.log(`    ${path.relative(SAVED, u.file)}  (${u.what}: ${u.why})`);
        }
        if (unclear.length > 20) console.log(`    … and ${unclear.length - 20} more`);
    }
    if (WRITE_CACHE) {
        if (learned.length) {
            await require('../helpers/savedDocKinds').record(learned);
            console.log(`\n  RECORDED ${learned.length} verdict(s) — the Documents tabs will now`);
            console.log(`  show each of these under the heading its own title says.`);
            console.log(`  Nothing was moved, renamed or deleted.`);
        } else {
            console.log(`\n  Nothing positively identified, so nothing recorded. The tabs are`);
            console.log(`  unchanged — an unreadable file is left exactly where it is.`);
        }
    } else if (wrong.length) {
        console.log(`\n  To make the tabs match this report:`);
        console.log(`      node scripts/documents-folder-audit.js --write-cache`);
    }
    console.log('');
})().catch((e) => { console.error('\n  ' + (e.stack || e.message) + '\n'); process.exit(1); });
