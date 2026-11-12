// ── helpers/bookingAmendments.js — date changes that arrive as plain text ────
// Apsara, 2026-11-13: carrier notice "Booking EBKG19299518 ... ERD Nov 16,
// Doc/Cargo cut off Nov 19, ETD Nov 23" reached her inbox and "my booking in
// jarvis was not updated. why?"
//
// WHY: workflow/emailWatcher.js only polls `has:attachment filename:pdf`. A
// vessel-window change is a few lines of text with no PDF, so it was never a
// candidate at all — the date-update logic in that file was fine, it just
// never saw this mail.
//
// This is a SEPARATE pass, deliberately narrow (CLAUDE.md rule 1 — the PDF path
// is untouched):
//   • it only touches a booking Jarvis ALREADY HOLDS. It never creates one.
//   • the mail must name exactly ONE active booking number. Two means we cannot
//     tell which dates belong to which, so it does nothing.
//   • mails with a PDF are left to the existing watcher.
//   • only the new text is read — quoted history is cut off first (the
//     2026-08-20 DALA62677900 stale-cutoff bug came from reading quoted
//     history).
//   • a mail older than the last one applied to that booking is ignored.
//   • it changes only erd_date, cutoff_date, etd. Every change is reported with
//     old → new, a backward move is called out.
// Everything is injected so it can be tested without Gmail or Gemini.
const { parseUSDate } = require('./time');

const FIELDS = ['erd_date', 'cutoff_date', 'etd'];

// Only what the sender just wrote, not what they are replying to / forwarding.
function newText(body) {
    const lines = String(body || '').split(/\r?\n/);
    const out = [];
    for (const l of lines) {
        if (/^\s*>/.test(l)) break;
        if (/^\s*On .{5,200}wrote:\s*$/i.test(l)) break;
        if (/^\s*-{2,}\s*(Original Message|Forwarded message)/i.test(l)) break;
        if (/^\s*From:\s.+/i.test(l) && out.length > 3) break;
        out.push(l);
    }
    return out.join('\n');
}

const norm = (s) => String(s || '').toUpperCase().replace(/\s+/g, '');

function bookingsNamed(text, activeNumbers) {
    const t = norm(text);
    return activeNumbers.filter((n) => n && t.includes(norm(n)));
}

// Pure: what would change on `cur` given extracted `x`.
function planDates(cur, x) {
    const next = {
        erd_date: x.erd_date,
        // "Cargo cut off" / port cutoff is the booking's cutoff; fall back to a
        // plain cutoff. The doc cutoff is a different deadline and is not it.
        cutoff_date: x.port_cutoff_date || x.cutoff_date,
        etd: x.etd,
    };
    const changes = [];
    for (const k of FIELDS) {
        const v = next[k];
        if (!v || v === cur[k]) continue;
        const o = parseUSDate(cur[k]), n = parseUSDate(v);
        const backward = !!(o && n && n.getTime() < o.getTime());
        changes.push({ field: k, from: cur[k] || '—', to: v, note: backward ? 'moved EARLIER — double-check this one' : null });
    }
    return changes;
}

async function run(deps) {
    const { listActive, search, getMessageInfo, extractText, mutateBooking, notify, isProcessed, markProcessed } = deps;
    const active = listActive();                       // [{booking_number, ...}]
    const numbers = active.map((b) => b.booking_number).filter(Boolean).slice(0, 40);
    const result = { applied: [], looked: 0 };
    if (!numbers.length) return result;

    const msgs = await search(numbers);
    for (const m of msgs) {
        if (isProcessed(m.id)) continue;
        const info = await getMessageInfo(m);          // {subject, body, hasPdf, from, at(ms)}
        markProcessed(m.id);                           // a mail is judged once
        result.looked++;
        if (info.hasPdf || info.fromSelf) continue;
        const text = newText(info.body);
        const named = bookingsNamed(info.subject + '\n' + text, numbers);
        if (named.length !== 1) continue;
        const bkg = named[0];
        const x = await extractText(text);
        if (!x) continue;
        if (x.booking_number && norm(x.booking_number) !== norm(bkg)) continue;

        let changes = [];
        await mutateBooking(bkg, (cur) => {
            if (cur.dates_mail_at && info.at && info.at <= Date.parse(cur.dates_mail_at)) return null; // older than what we applied
            changes = planDates(cur, x);
            if (!changes.length) return null;
            const patch = {};
            for (const c of changes) patch[c.field] = c.to;
            if (info.at) patch.dates_mail_at = new Date(info.at).toISOString();
            return patch;
        });
        if (changes.length) {
            result.applied.push({ booking: bkg, changes, subject: info.subject });
            await notify({ booking: bkg, changes, subject: info.subject });
        }
    }
    return result;
}

module.exports = { run, newText, planDates, bookingsNamed, FIELDS };
