// ── tests/proforma-approval.js ─────────────────────────────────────────────
// Apsara, 2026-10-03: "So rather than auto send, send a message to the
// internal group asking for confirmation to send" -- "With the attachment of
// proforma".
//
// Her auto-send verdict stands: scripts/proforma-autosend-audit.js found 0 of
// 4 real orders safe to send unattended. This is the right middle.
//
// THE REAL GAIN IS NOT CONVENIENCE. Until now the read-back was a TEXT
// SUMMARY and the PDF was rendered AFTER the yes, so the thing approved and
// the thing sent were not the same artifact. These tests pin that they are.
const path = require('path');
const R = (p) => path.join(__dirname, '..', p);

// Stub the renderer BEFORE actions loads, and COUNT the renders -- the reuse
// is only provable by counting, which is the same trick that caught the
// double-send in the digest verifier.
const pdfMod = require(R('helpers/proformaPdf.js'));
let RENDERS = [];
pdfMod.generateProformaDc2Pdf = async (payload) => {
    RENDERS.push(JSON.parse(JSON.stringify(payload)));
    return Buffer.from('%PDF-1.4 fake ' + (payload.inv_no || '') + ' ' + RENDERS.length);
};

// ── THIS TEST WROTE TO HER LIVE GOOGLE SHEET, ONCE (2026-10-03) ────────────
// The first run of AD2 called generateProformaFromPending for real, and that
// function logs every proforma it produces to the Proforma tab of her invoice
// spreadsheet. Two fake rows -- "Daekwang / 261003_AC_TCLU1234567" and its
// "-2" duplicate -- landed in her live data and had to be deleted by hand.
//
// A test that reaches production is worse than no test. Every outbound side
// effect of that function is stubbed here BEFORE it loads, and each stub
// records that it was called so the test can assert the pipeline still tries.
const sheetLog = require(R('helpers/proformaSheetLog.js'));
let SHEET_WRITES = 0;
sheetLog.logProformaToSheet = async () => { SHEET_WRITES++; return { ok: true, stubbed: true }; };

const pricing = require(R('helpers/proformaPricing.js'));
pricing.recordFromGeneration = async () => true;
pricing.upsert = async () => true;
const catalog = require(R('helpers/tradeCatalog.js'));
catalog.add = async () => true;
catalog.addMany = async () => true;

const rw = require(R('workflow/replyWatch.js'));
const actions = require(R('workflow/actions.js'));

let pass = 0, fail = 0;
const failures = [];
const ck = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};
const section = (t) => console.log(`\n=== ${t} ===`);

// Joey's real order, as the pipeline now reads it (see
// claude/jarvis-reading-joeys-real-emails.md).
const DRAFT = {
    consignee: 'Daekwang', containerCount: 5, trade_terms: 'CIF', port_discharge: 'Busan',
    items: [{ desc: 'Auto casting tense', qty: 21, rate: 2520, qty_assumed: true }],
    assumed: ['Auto casting tense: 21 MT assumed — the email didn\'t say, and 21 MT is the standard quantity'],
    unconfirmed: [], grounded: ['$2520/MT is in line with the 48 past Auto casting tense invoice(s)'],
    needs: [], confidence: 0.9,
};
const PREP = { invNo: '26JY80 AC', containerNos: ['TCLU1234567'], addressLines: ['Daekwang Co', 'Busan, Korea'] };

(async () => {
    section('AA — the ask names the decision, not the mechanics');
    const ask = rw.buildApprovalAsk({ fromName: 'Joey', from: 'joey@hynos.co.kr', proforma: DRAFT }, PREP, {});
    ck('AA1 it says plainly that nothing has been sent', /NOT SENT YET/.test(ask), ask.slice(0, 60));
    ck('AA2 it names the buyer', /Daekwang/.test(ask));
    ck('AA3 it names who the order came from', /From Joey/.test(ask));
    // A wrong document must be obvious WITHOUT opening the attachment.
    ck('AA4 it carries the total', /Total: \$264,600\.00/.test(ask), ask);
    ck('AA5 and the container count', /5 container\(s\)/.test(ask));
    ck('AA6 and the invoice number', /26JY80 AC/.test(ask));
    // The assumptions are the reason a human is asked at all.
    ck('AA7 every assumption appears VERBATIM, not summarised',
        ask.includes(DRAFT.assumed[0]), ask);
    ck('AA8 an assumed quantity is marked on its line too', /21 MT\* @/.test(ask), ask);
    ck('AA9 it says what to reply', /Reply "yes"/.test(ask) && /"no"/.test(ask));

    section('AB — unconfirmed figures are never swallowed');
    const risky = rw.buildApprovalAsk({ fromName: 'Joey', proforma: { ...DRAFT,
        unconfirmed: ['only 2 past Chrome Wheels invoice(s) on record — too few to confirm $3200 against'] } }, PREP, {});
    ck('AB1 an unconfirmed rate is shown with a warning mark',
        /⚠ only 2 past Chrome Wheels/.test(risky), risky);

    section('AC — ONE payload, so the approved and the sent document match');
    RENDERS = [];
    const att = await actions.buildApprovalAttachment(DRAFT, PREP.invNo, PREP.containerNos, PREP.addressLines);
    ck('AC1 the attachment is built', !!(att && att.media), JSON.stringify(att && Object.keys(att)));
    ck('AC2 it is a PDF with a filename', att && att.media.mimetype === 'application/pdf'
        && /\.pdf$/i.test(att.media.filename), att && JSON.stringify(att.media.filename));
    ck('AC3 it is base64, which is what sendMessage needs',
        att && typeof att.media.base64 === 'string' && att.media.base64.length > 0);
    ck('AC4 exactly one render so far', RENDERS.length === 1, `renders = ${RENDERS.length}`);
    const approvedPayload = RENDERS[0];
    ck('AC5 the payload carries the figures she is approving',
        approvedPayload.consignee === 'Daekwang' && approvedPayload.inv_no === '26JY80 AC'
        && approvedPayload.containers[0].items[0].qty === 21
        && approvedPayload.containers[0].items[0].rate === 2520,
        JSON.stringify(approvedPayload).slice(0, 200));
    // buildProformaPayload is the SINGLE builder. This file already carries a
    // scar from two paths to one document (see prepareProformaNumbers).
    const direct = actions.buildProformaPayload(DRAFT, PREP.invNo, PREP.containerNos, PREP.addressLines);
    ck('AC6 the send path builds a byte-identical payload',
        JSON.stringify(direct) === JSON.stringify(approvedPayload),
        `direct  : ${JSON.stringify(direct).slice(0, 140)}\n        approved: ${JSON.stringify(approvedPayload).slice(0, 140)}`);

    section('AD — saying yes reuses the approved file, it does not re-render');
    const fs = require('fs');
    ck('AD1 the approved PDF was archived to a path', !!(att && att.pdfPath) && fs.existsSync(att.pdfPath),
        att && String(att.pdfPath));
    const before = RENDERS.length;
    // generateProformaFromPending emails and archives; those are stubbed out
    // from under it by giving it a pending with no replyTo, so the test is
    // about the RENDER COUNT and nothing else.
    let sent = null;
    actions.init({ sendMessage: async () => true, sendToManager: async () => true,
        sendToTeam: async (t, m) => { sent = { t, m }; return true; }, pushAlert: () => {} });
    await actions.generateProformaFromPending('test@c.us', {
        draft: DRAFT, invNo: PREP.invNo, containerNos: PREP.containerNos,
        addressLines: PREP.addressLines, pdfPath: att.pdfPath, who: 'Joey', replyTo: null,
    }).catch(() => {});
    ck('AD2 NO second render — the approved bytes are what go out',
        RENDERS.length === before, `renders before ${before}, after ${RENDERS.length}`);

    // And the fallback: a pending whose file has gone (pm2 restart, archive
    // cleared) must still produce a document rather than fail.
    const gone = RENDERS.length;
    await actions.generateProformaFromPending('test@c.us', {
        draft: DRAFT, invNo: PREP.invNo, containerNos: PREP.containerNos,
        addressLines: PREP.addressLines, pdfPath: '/nonexistent/gone.pdf', who: 'Joey', replyTo: null,
    }).catch(() => {});
    ck('AD3 a missing approved file falls back to re-rendering, not an error',
        RENDERS.length === gone + 1, `renders ${gone} -> ${RENDERS.length}`);
    // The sheet log is still CALLED -- stubbing it must not quietly remove a
    // step the real document depends on.
    ck('AD4 the proforma is still logged to the sheet (stubbed, not skipped)',
        SHEET_WRITES >= 1, `sheet writes = ${SHEET_WRITES}`);

    section('AE — a render failure must not silence the ask');
    const broken = pdfMod.generateProformaDc2Pdf;
    pdfMod.generateProformaDc2Pdf = async () => { throw new Error('chromium died'); };
    const none = await actions.buildApprovalAttachment(DRAFT, PREP.invNo, PREP.containerNos, PREP.addressLines);
    ck('AE1 a failed render returns null instead of throwing', none === null, JSON.stringify(none));
    pdfMod.generateProformaDc2Pdf = broken;

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED: ' + failures.join(', ')); process.exit(1); }
})();
