// ── helpers/accountsAgent.js — ONE agent for QuickBooks, Books and Bank ───
//
// Apsara, 2026-10-28: "MAKE IT VERY EASY.ASSIGN A AI TO THIS TO DO ALL THE
// JOBS", then "AN AGENT ONLY FOR QB,BOOKS,BANK".
//
// ── THIS IS NOT AN EIGHTH AGENT. IT IS THE ONE THAT READS THE OTHERS ─────
// helpers/booksAgent.js' own header already says there are seven agent files,
// and that was the complaint she is making. So this adds no new judgement of
// its own and duplicates no check. It calls what already exists:
//
//   BANK   helpers/bankAutoTick.candidates()  — what the 06:50 tick could not
//          be certain about, i.e. what is still waiting for her
//   BOOKS  helpers/booksAgent.review()        — "can these books be trusted",
//          per company, DETERMINISTIC, no model call. It had no scheduled
//          caller at all until today: written 2026-10-15, reached only by the
//          books portal and its tests.
//   QB     scripts/qb-duplicates' signals and scripts/qb-parity's comparison,
//          both of which I built earlier TODAY and neither of which anything
//          ran. Two more instances of the defect this file exists to fix.
//
// ── SILENT WHEN CLEAN, FOR THE REASON THE SWEEP ALREADY GIVES ───────────
// helpers/integritySweepJob.js: "A report that arrives daily saying 'all fine'
// is one she stops opening inside a fortnight, and then the morning it says
// something she does not open that either." Same rule. One message, only when
// there is something to do.
//
// ── IT NEVER WRITES ─────────────────────────────────────────────────────
// Not to her stores, not to QuickBooks. Every item is a thing for her to do,
// with the figure and the row id, because the jobs that are allowed to write
// (the 06:50 auto-tick, the ledger agent) already did their writing and this
// one only reports what they left.
const money = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(Number(n) || 0)
    .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const CENT = 0.005;

// Every section is wrapped: a QuickBooks timeout must not cost her the bank
// and books sections. A section that throws reports the throw — the morning it
// breaks she needs to know it broke, not receive a shorter email that looks
// like good news.
function safely(name, fn) {
    try { return { ok: true, value: fn() }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e), name }; }
}

// ── BANK ────────────────────────────────────────────────────────────────
function bank() {
    const AT = require('./bankAutoTick');
    const rows = AT.candidates();
    // candidates() is what the tick WOULD do; by the time this runs at 07:00
    // the 06:50 job has done them, so anything still here needed her.
    return { waiting: rows.length,
        items: rows.slice(0, 10).map((r) => ({
            what: `${r.date} ${money(r.amount)} ${r.descriptor || ''}`.trim(),
            detail: r.why || null, id: r.id })) };
}

// ── BOOKS ───────────────────────────────────────────────────────────────
// Per company, because statements.js refuses to combine them and so does
// booksAgent: "there is no combined taxpayer".
function books() {
    const BB = require('./booksBuild');
    const BA = require('./booksAgent');
    const E = require('./entities');
    const built = BB.build({});
    const out = [];
    for (const ent of E.ENTITIES) {
        const rev = BA.review(built, { entity: ent.id });
        // 'normal' is booksAgent's word for "nothing wrong here", and
        // no-transactions on a dormant company is not news.
        const real = (rev.findings || []).filter((f) => f.severity !== 'normal'
            && f.code !== 'no-transactions');
        if (!real.length && rev.trustworthy !== false) continue;
        out.push({ entity: ent.uiName, trustworthy: rev.trustworthy,
            headline: rev.headline || BA.summary(rev),
            items: real.slice(0, 5).map((f) => ({ what: f.what, why: f.why, severity: f.severity })) });
    }
    return out;
}

// ── QUICKBOOKS ──────────────────────────────────────────────────────────
// The snapshot's age first, because every figure after it depends on that and
// on 2026-10-28 two duplicates were reported off a five-week-old pull that had
// already been deleted.
function quickbooks() {
    const snapshot = require('./quickbooks/snapshot');
    const snap = snapshot.read();
    if (!snap) return { missing: true };
    const ageDays = (Date.now() - Date.parse(snap.at)) / 86400000;
    const rows = snapshot.rows('bills');
    const inv = snapshot.rows('invoices');

    // ── DUPLICATES, THROUGH THE ONE IMPLEMENTATION ──────────────────────
    // helpers/qbDuplicates.js, which scripts/qb-duplicates.js also calls.
    // Only the STRONG signals reach her here: a reference reused across two
    // containers is ordinary in her trade and would make this email noise
    // within a week. The script is still there for the full list.
    const D = require('./qbDuplicates');
    const inWindow = (r) => String(r.TxnDate || '') >= '2026-01-01';
    const dups = [];
    for (const [kind, src] of [['bill', rows], ['invoice', inv]]) {
        if (!src) continue;
        for (const h of D.find(src.rows.filter(inWindow))) {
            if (!D.STRONG.has(h.why)) continue;
            const rm = D.removable(h);
            dups.push({ kind, why: h.why, who: D.party(h.rows[0]), ref: D.doc(h.rows[0]),
                over: D.overstatement(h), removeId: rm ? String(rm.Id) : null,
                paidBoth: !rm && h.rows.every((x) => !(Number(x.Balance) > CENT)) });
        }
    }
    return {
        duplicates: dups,
        overstated: r2(dups.reduce((s, d) => s + d.over, 0)),
        at: snap.at, env: snap.env, ageDays: Math.round(ageDays),
        stale: !(ageDays < 2),
        sandbox: snap.env !== 'production',
        bills: rows ? rows.count : 0,
        invoices: inv ? inv.count : 0,
        legacy: !!(rows && rows.legacy) || !!(inv && inv.legacy),
        owe: r2((snap.totals || {}).owe), owed: r2((snap.totals || {}).owed),
    };
}

// ── THE REVIEW ──────────────────────────────────────────────────────────
// ── IS THE YEAR CLOSED YET? (2026-10-29) ────────────────────────────────
// Apsara: "fix accounting first till october" / "This is the biggest
// headache for us". The other three sections are about TODAY — what arrived
// overnight, what needs a decision now. This one is about the year behind
// her, and it is the one that decides whether QuickBooks can go in January.
//
// The window comes from booksClose.lastClosableWindow(), shared with
// scripts/books-close.js, so her morning mail and her terminal cannot
// disagree about which months are even eligible.
function closing() {
    const C = require('./booksClose');
    const win = C.lastClosableWindow();
    return C.close(win);
}

function review() {
    const parts = {
        bank: safely('bank', bank),
        books: safely('books', books),
        quickbooks: safely('quickbooks', quickbooks),
        closing: safely('closing', closing),
    };
    const broke = Object.values(parts).filter((p) => !p.ok);
    // `|| fallback` on each, not just on the !ok branch. A section that
    // returns ok with nothing in it used to make this throw on q.missing,
    // which killed the whole review — and a crash is a WEAKER kill than a
    // named failure: the test file dies before its assertions run, so a
    // mutation that caused it counted as zero failures. Defaulting here means
    // the same mutation now produces the honest red instead.
    const b = (parts.bank.ok && parts.bank.value) || { waiting: 0, items: [] };
    const k = (parts.books.ok && parts.books.value) || [];
    const q = (parts.quickbooks.ok && parts.quickbooks.value) || {};

    // Never throws and never returns an object: this line goes straight into
    // an email, and the whole point of this fix is that nothing here can
    // render as [object Object] again.
    const booksSummaryLine = (co) => {
        try {
            const line = require('./booksAgent').summary(co);
            if (typeof line === 'string' && line.trim()) return line;
        } catch (e) { /* fall through */ }
        const h = (co && co.headline) || {};
        return `${co && co.entityName ? co.entityName : 'this company'}: `
            + `${h.lines == null ? 'an unknown number of' : h.lines} journal line(s)`;
    };

    const todo = [];
    if (b.waiting) {
        todo.push({ area: 'BANK', what: `${b.waiting} bank line(s) still need you`,
            items: b.items.map((x) => `${x.what}${x.detail ? ' — ' + x.detail : ''}`) });
    }
    for (const co of k) {
        todo.push({ area: 'BOOKS',
            what: `${co.entity}: ${co.trustworthy === false ? 'the figures cannot be trusted yet' : 'something to look at'}`,
            // ── [object Object], ON HER DESK, EVERY MORNING ──────────────
            // `co.headline` is an OBJECT — { lines, netIncome, balanced,
            // complete } — and this list is joined into text, so the first
            // line of every BOOKS section read "[object Object]". Three
            // times a morning, above figures she is being told not to trust.
            //
            // booksAgent already exports summary(), which is the sentence
            // this line was reaching for: "Edge Metals: 412 journal lines,
            // books balance, nothing unplaced. Net $...". It was never
            // called. The headline object stays on the result — the screens
            // use its fields — it is just not printed raw.
            items: [booksSummaryLine(co)].concat(co.items.map((i) => `${i.what} — ${i.why}`)) });
    }
    if (q.missing) {
        todo.push({ area: 'QUICKBOOKS', what: 'no QuickBooks snapshot has ever been taken',
            items: ['the 05:55 job writes it; if this persists the connection needs re-authorising'] });
    } else if ((q.duplicates || []).length && !q.stale && !q.legacy) {
        // Only when the snapshot is trustworthy. On 2026-10-28 two duplicates
        // were reported off a five-week-old pull and had already been deleted;
        // an agent that does that every morning teaches her to ignore it.
        todo.push({ area: 'QUICKBOOKS',
            what: `${q.duplicates.length} thing(s) entered twice — ${money(q.overstated)} overstated`,
            items: q.duplicates.map((d) => `${d.who}${d.ref ? ' ref ' + d.ref : ''} — `
                + `${money(d.over)} (${d.why.toLowerCase()})`
                + (d.removeId ? `; delete ${d.kind} id ${d.removeId}`
                    : d.paidBoth ? '; both are paid, so a payment has to be unwound first' : '')) });
    }
    if (!q.missing && (q.stale || q.legacy || q.sandbox)) {
        const why = [];
        if (q.stale) why.push(`the snapshot is ${q.ageDays} day(s) old`);
        if (q.legacy) why.push('the bill/invoice rows are still the old untrusted one-off pull');
        if (q.sandbox) why.push(`it is from ${q.env}, not her live books`);
        todo.push({ area: 'QUICKBOOKS', what: 'the QuickBooks figures cannot be trusted this morning',
            items: why.concat(['nothing comparing Jarvis to QuickBooks is meaningful until this is fixed']) });
    }
    // ── THE YEAR BEHIND HER ──────────────────────────────────────────────
    // One line: the OLDEST open month and why, plus a count. Not all ten.
    // A morning email that lists every open month every day is a wall, and
    // the oldest one is where the work has to start anyway — a later month
    // often only disagrees because an earlier one does.
    const c = (parts.closing.ok && parts.closing.value) || null;
    if (c) {
        // Snapshot complaints are already the QUICKBOOKS section's job above.
        // Repeating them here would say the same thing twice every morning,
        // which is how she learns to skim the whole message.
        const qbAlreadySaid = !!(q.missing || q.stale || q.legacy || q.sandbox);
        const mine = c.blockers.filter((x) => !(qbAlreadySaid && /snapshot/i.test(x)));
        if (mine.length) {
            todo.push({ area: 'CLOSING', what: `${c.period.from} to ${c.period.to} cannot be assessed`,
                items: mine });
        }
        const open = c.perMonth.filter((m) => !m.closed);
        if (!mine.length && open.length) {
            const first = open[0];
            todo.push({ area: 'CLOSING',
                what: `${open.length} of ${c.months.length} month(s) not closed — start with ${first.month}`,
                items: first.why_open.concat(
                    (first.bank.items || []).slice(0, 3).map((x) => `${x.date}  `
                        + `${money(x.in || x.out)}  ${x.out ? 'out' : 'in'}  ${x.desc}`),
                    [`the full list: node scripts/books-close.js --month ${first.month}`]) });
        }
    }

    for (const p of broke) {
        todo.push({ area: 'FAILED', what: `the ${p.name} section could not run`, items: [p.error] });
    }
    return { at: new Date().toISOString(), clean: todo.length === 0, todo,
        bank: b, books: k, quickbooks: q, closing: c };
}

// ── WHAT SHE READS ──────────────────────────────────────────────────────
// Her areas in her words, each item a thing to do. Kept apart from review()
// so the finding can be run and read without a mailbox — the split
// integritySweepJob.js already uses, and for its reason: "a change to the
// wording of an email cannot break a check".
// ── FIVE IDENTICAL LINES IS THE UGLIEST THING IN THE MAIL ────────────────
// Apsara, 2026-11-06, on the morning mail: "its ugly".
//
// The worst of it was repetition. Five entries failing for the same reason
// printed the same sentence five times, under three companies — fifteen
// identical lines in one email, which is both unreadable and misleading
// about how much is wrong. It reads as fifteen problems; it is one problem
// with five instances.
//
// Collapsed here rather than at the source, because the FINDINGS are right:
// there genuinely are five unposted entries and each is a separate thing to
// fix. It is the PRESENTATION that should say "5 x" and the detail that
// should carry the count.
function groupItems(items) {
    const seen = new Map();
    for (const raw of (items || [])) {
        const line = String(raw);
        seen.set(line, (seen.get(line) || 0) + 1);
    }
    return [...seen.entries()].map(([line, n]) => ({ line, n }));
}

function text(res) {
    const r = res || review();
    if (r.clean) return 'Accounts: nothing needs you this morning.';
    const lines = ['What needs you on the accounts this morning:', ''];
    for (const t of r.todo) {
        lines.push(`${t.area} — ${t.what}`);
        for (const g of groupItems(t.items)) {
            lines.push(`    ${g.n > 1 ? g.n + ' x ' : ''}${g.line}`);
        }
        lines.push('');
    }
    const q = r.quickbooks || {};
    if (!q.missing && !q.stale) {
        lines.push(`QuickBooks, as at ${String(q.at).slice(0, 10)}: she owes ${money(q.owe)}, `
            + `is owed ${money(q.owed)} (${q.bills} bills, ${q.invoices} invoices).`);
    }
    lines.push('Nothing was changed by this message.');
    return lines.join('\n');
}

// ── THE MAIL SHE ACTUALLY LOOKS AT ───────────────────────────────────────
// Apsara, 2026-11-06: "its ugly". It was: the HTML half was the plain text
// escaped into one monospace <pre> block, so a wall of grey courier arrived
// every morning with no hierarchy, no alignment and fifteen repeated lines.
//
// ── WHY TABLES AND INLINE STYLE, WHICH LOOK ARCHAIC ─────────────────────
// Because this is email. Gmail strips <style> blocks, ignores most flexbox
// and drops class selectors; a table with inline attributes is what actually
// renders the same in Gmail, Apple Mail and Outlook. The dashboard's own
// tokens are reused as literal hex so the mail looks like the app she opens
// next, without importing a stylesheet no mail client would read.
//
// ── IT STILL SAYS EXACTLY WHAT THE TEXT SAYS ────────────────────────────
// Same review(), same items, same grouping. If the two ever disagree the
// plain-text half is the one to trust — it is what the checks read, and what
// arrives if the HTML is stripped.
const ESC = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// One accent per area, so she can tell at a glance which part of the morning
// is shouting. BOOKS is the serious one — it is the only section that can
// say "the figures cannot be trusted".
const AREA_COLOUR = {
    BOOKS: '#C5402F', BANK: '#D99A2B', QUICKBOOKS: '#3A6EA5', CLOSING: '#57616A',
};

function html(res) {
    const r = res || review();
    const wrap = (inner) => '<div style="margin:0;padding:24px 0;background:#F3F5F7;'
        + 'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;">'
        + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">'
        + '<tr><td align="center">'
        // width="100%" with a max-width, NOT width="640". A fixed width
        // attribute wins over the style in several renderers, and the card
        // then runs off the side of a phone — which is where she reads this.
        + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
        + 'style="max-width:640px;background:#FFFFFF;border:1px solid #E5E9EC;border-radius:6px;">'
        + inner + '</table></td></tr></table></div>';

    if (r.clean) {
        return wrap('<tr><td style="padding:28px 28px 26px;">'
            + '<div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;'
            + 'color:#7E8891;font-weight:600;">Jarvis &middot; Accounts</div>'
            + '<div style="font-size:19px;color:#202124;font-weight:600;padding-top:8px;">'
            + 'Nothing needs you this morning.</div></td></tr>');
    }

    const sections = r.todo.map((t) => {
        const colour = AREA_COLOUR[t.area] || '#57616A';
        const rows = groupItems(t.items).map((g) => ''
            + '<tr>'
            // The count is its own column so the sentences line up down the
            // page. "5 x" inline would push every line to a different start.
            + '<td valign="top" align="right" style="padding:3px 10px 3px 0;width:34px;'
            + 'font-variant-numeric:tabular-nums;font-size:12px;color:' + colour + ';font-weight:700;">'
            + (g.n > 1 ? ESC(g.n) + '&times;' : '') + '</td>'
            + '<td valign="top" style="padding:3px 0;font-size:13px;line-height:1.5;color:#3C454D;">'
            + ESC(g.line) + '</td>'
            + '</tr>').join('');
        return ''
            + '<tr><td style="padding:0 28px;">'
            + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
            + 'style="border-top:1px solid #E5E9EC;"><tr><td style="padding:18px 0 0;">'
            + '<div style="font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;'
            + 'font-weight:700;color:' + colour + ';">' + ESC(t.area) + '</div>'
            + '<div style="font-size:14.5px;color:#202124;font-weight:600;padding:3px 0 8px;">'
            + ESC(t.what) + '</div>'
            + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
            + 'style="padding-bottom:16px;">' + rows + '</table>'
            + '</td></tr></table></td></tr>';
    }).join('');

    const q = r.quickbooks || {};
    // The standing figures, set apart: they are context, not a task, and
    // putting them in the same list is half of why the mail read as a wall.
    const footer = (!q.missing && !q.stale)
        ? '<tr><td style="padding:4px 28px 0;">'
          + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
          + 'style="background:#F3F5F7;border-radius:4px;"><tr>'
          + '<td style="padding:12px 14px;font-size:12px;color:#57616A;line-height:1.5;">'
          + 'QuickBooks as at ' + ESC(String(q.at).slice(0, 10)) + ' &mdash; owes <b style="color:#202124;">'
          + ESC(money(q.owe)) + '</b>, owed <b style="color:#202124;">' + ESC(money(q.owed)) + '</b>'
          + ' <span style="color:#7E8891;">(' + ESC(q.bills) + ' bills, ' + ESC(q.invoices) + ' invoices)</span>'
          + '</td></tr></table></td></tr>'
        : '';

    return wrap(''
        + '<tr><td style="padding:26px 28px 16px;">'
        + '<div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;'
        + 'color:#7E8891;font-weight:600;">Jarvis &middot; Accounts</div>'
        + '<div style="font-size:19px;color:#202124;font-weight:600;padding-top:8px;">'
        + 'What needs you this morning</div></td></tr>'
        + sections
        + footer
        + '<tr><td style="padding:16px 28px 24px;font-size:11.5px;color:#9AA3AA;">'
        + 'Nothing was changed by this message.</td></tr>');
}

function subject(res) {
    const r = res || review();
    if (r.clean) return 'Jarvis accounts: nothing needs you';
    const areas = [...new Set(r.todo.map((t) => t.area))].join(', ');
    const n = r.todo.reduce((s, t) => s + Math.max(1, t.items.length), 0);
    return `Jarvis accounts: ${n} thing(s) to look at (${areas})`;
}

// ── SENDING IT ──────────────────────────────────────────────────────────
// The destination is resolved exactly as helpers/integritySweepJob.js and the
// log digest resolve it — ALERT_EMAIL_TO when configured, her own sending
// address otherwise — rather than assumed. gmail.js carries the note about
// the fortnight its comments claimed one mailbox while all three tokens
// pointed at another.
//
// SEND_ALWAYS=1 overrides the silence, for the first few mornings when she
// will want to see that it is actually running.
async function send({ sendAlways = String(process.env.SEND_ALWAYS || '') === '1' } = {}) {
    const res = review();
    const body = text(res);
    if (res.clean && !sendAlways) {
        console.log('[ACCOUNTS] nothing needs her — nothing sent');
        return { ...res, text: body, sent: false, why: 'clean' };
    }
    const cfg = require('../config');
    const gmail = require('./gmail');
    let to = cfg.ALERT_EMAIL_TO || '';
    if (!to) {
        try { to = await gmail.getMyEmailAddress(gmail.getGmailWrite()); } catch (e) { /* below */ }
    }
    if (!to) {
        console.warn('[ACCOUNTS] no destination (set ALERT_EMAIL_TO) — not sent');
        return { ...res, text: body, sent: false, why: 'no destination' };
    }
    // Monospace for the same reason the sweep supplies its own HTML: the
    // default renders in Arial with pre-wrap, which is wrong for a list whose
    // meaning is in its alignment.
    // Was the plain text escaped into one monospace <pre> — which is what
    // "its ugly" was about. html() lays it out properly; `body` is still the
    // plain-text half, so a client that strips HTML loses nothing.
    const bodyHtml = html(res);
    try {
        await gmail.sendEmail({ to, subject: subject(res), body, bodyHtml });
        console.log(`[ACCOUNTS] ${subject(res)} → ${to}`);
        return { ...res, text: body, sent: true, to };
    } catch (e) {
        // A failed report must not take the scheduler down and must not be
        // silent either — that would make this job an instance of the exact
        // problem it exists to find.
        console.error('[ACCOUNTS] could not send:', e.message);
        return { ...res, text: body, sent: false, why: e.message };
    }
}

module.exports = { review, text, html, subject, send, bank, books, quickbooks, groupItems };
