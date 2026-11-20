// ── helpers/bookingsVsMail.js — do our booking dates match the carrier's latest mail? ──
// Apsara, 2026-11-21: "some of the dates are wrong". For each active booking,
// find the newest TEXT mail that names it (and only it), read the dates, and
// say where we differ. Same reading and same field rules as the live text-mail
// pass (helpers/bookingAmendments.js: newText, planDates), so what this
// reports is exactly what that pass would change. Report only unless apply is
// set; PDF mails are not read here (a confirmation PDF is the PDF watcher's).
// Everything injectable, so it is testable without Gmail or Gemini.
const A = require('./bookingAmendments');

async function run({ bookings, search, getInfo, extract, apply = null }) {
    const out = { checked: 0, no_mail: [], differs: [], same: [], pdf_only: [], skipped: [] };
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
        if (!pick) { (infos.some((i) => i.info.hasPdf) ? out.pdf_only : out.skipped).push(bkg); continue; }
        const x = await extract(A.newText(pick.info.body));
        if (!x) { out.skipped.push(bkg); continue; }
        if (x.booking_number && String(x.booking_number).toUpperCase().replace(/\s+/g, '') !== bkg.toUpperCase().replace(/\s+/g, '')) { out.skipped.push(bkg); continue; }
        const changes = A.planDates(b, x);
        const mail = { subject: pick.info.subject, at: pick.info.at ? new Date(pick.info.at).toISOString().slice(0, 10) : null };
        if (!changes.length) { out.same.push({ bkg, mail }); continue; }
        // Stale-mail guard, as in the live pass: a mail older than one already applied is not authority.
        const stale = b.dates_mail_at && pick.info.at && pick.info.at <= Date.parse(b.dates_mail_at);
        out.differs.push({ bkg, mail, changes, stale: !!stale });
        if (apply && !stale) await apply(bkg, changes, pick.info.at);
    }
    return out;
}
module.exports = { run };
