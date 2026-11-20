// ── helpers/bookingsVsMail.js — do our booking dates match the carrier's latest mail? ──
// Apsara, 2026-11-21: "some of the dates are wrong". For each active booking,
// find the newest TEXT mail that names it (and only it), read the dates, and
// say where we differ. Same reading and same field rules as the live text-mail
// pass (helpers/bookingAmendments.js: newText, planDates), so what this
// reports is exactly what that pass would change. Report only unless apply is
// set; PDF mails are not read here (a confirmation PDF is the PDF watcher's).
// Everything injectable, so it is testable without Gmail or Gemini.
const A = require('./bookingAmendments');

async function run({ bookings, search, getInfo, extract, extractPdf = null, apply = null }) {
    const out = { checked: 0, no_mail: [], differs: [], same: [], pdf_only: [], skipped: [], reasons: {} };
    const why = (bkg, r) => { out.skipped.push(bkg); out.reasons[bkg] = r; };
    const numbers = Object.keys(bookings);
    for (const bkg of numbers) {
        out.checked++;
        const b = bookings[bkg];
        const msgs = await search(bkg);
        const infos = [];
        for (const m of msgs) infos.push({ m, info: await getInfo(m) });
        infos.sort((x, y) => (y.info.at || 0) - (x.info.at || 0));
        if (!infos.length) { out.no_mail.push(bkg); continue; }
        // Newest mail that is plain text and names this booking alone.
        const pick = infos.find(({ info }) => {
            if (info.hasPdf) return false;
            const text = A.newText(info.body);
            return A.bookingsNamed(info.subject + '\n' + text, numbers).join() === bkg;
        });
        let x = null, src = null;
        if (pick) {
            x = await extract(A.newText(pick.info.body));
            src = pick;
            if (!x) { why(bkg, 'the dates could not be read out of the newest text mail'); continue; }
        } else {
            // No usable text mail: the newest PDF mail that names it. A confirmation PDF is
            // the carrier's own document, so its dates count the same way.
            const pdfMail = infos.find(({ info }) => info.hasPdf && A.bookingsNamed(info.subject + '\n' + A.newText(info.body), numbers).join() === bkg);
            if (!pdfMail || !extractPdf) {
                if (infos.some((i) => i.info.hasPdf)) out.pdf_only.push(bkg);
                else why(bkg, infos.some((i) => A.bookingsNamed(i.info.subject + '\n' + A.newText(i.info.body), numbers).length > 1) ? 'every mail naming it also names another booking' : 'no mail that names only this booking');
                continue;
            }
            x = await extractPdf(pdfMail.m);
            src = pdfMail;
            if (!x) { why(bkg, 'the PDF is not a booking confirmation, or could not be read'); continue; }
        }
        const pick2 = src;
        if (x.booking_number && String(x.booking_number).toUpperCase().replace(/\s+/g, '') !== bkg.toUpperCase().replace(/\s+/g, '')) { why(bkg, `the mail's booking number is ${x.booking_number}`); continue; }
        const changes = A.planDates(b, x);
        const mail = { subject: pick2.info.subject, at: pick2.info.at ? new Date(pick2.info.at).toISOString().slice(0, 10) : null, from_pdf: !pick };
        if (!changes.length) { out.same.push({ bkg, mail }); continue; }
        // Stale-mail guard, as in the live pass: a mail older than one already applied is not authority.
        const stale = b.dates_mail_at && pick2.info.at && pick2.info.at <= Date.parse(b.dates_mail_at);
        out.differs.push({ bkg, mail, changes, stale: !!stale });
        if (apply && !stale) await apply(bkg, changes, pick2.info.at);
    }
    return out;
}
module.exports = { run };
