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
function review() {
    const parts = {
        bank: safely('bank', bank),
        books: safely('books', books),
        quickbooks: safely('quickbooks', quickbooks),
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

    const todo = [];
    if (b.waiting) {
        todo.push({ area: 'BANK', what: `${b.waiting} bank line(s) still need you`,
            items: b.items.map((x) => `${x.what}${x.detail ? ' — ' + x.detail : ''}`) });
    }
    for (const co of k) {
        todo.push({ area: 'BOOKS',
            what: `${co.entity}: ${co.trustworthy === false ? 'the figures cannot be trusted yet' : 'something to look at'}`,
            items: [co.headline].concat(co.items.map((i) => `${i.what} — ${i.why}`)) });
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
    for (const p of broke) {
        todo.push({ area: 'FAILED', what: `the ${p.name} section could not run`, items: [p.error] });
    }
    return { at: new Date().toISOString(), clean: todo.length === 0, todo, bank: b, books: k, quickbooks: q };
}

// ── WHAT SHE READS ──────────────────────────────────────────────────────
// Her areas in her words, each item a thing to do. Kept apart from review()
// so the finding can be run and read without a mailbox — the split
// integritySweepJob.js already uses, and for its reason: "a change to the
// wording of an email cannot break a check".
function text(res) {
    const r = res || review();
    if (r.clean) return 'Accounts: nothing needs you this morning.';
    const lines = ['What needs you on the accounts this morning:', ''];
    for (const t of r.todo) {
        lines.push(`${t.area} — ${t.what}`);
        for (const i of t.items) lines.push(`    ${i}`);
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
    const bodyHtml = '<div style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;'
                   + 'font-size:12px;line-height:1.45;white-space:pre;color:#202124;">'
                   + gmail.escapeHtmlText(body) + '</div>';
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

module.exports = { review, text, subject, send, bank, books, quickbooks };
