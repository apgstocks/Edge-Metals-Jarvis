// ── helpers/caseFile.js — one status per customer, and the timeline behind it (READ-ONLY) ───────────────────
// Apsara, 2026-11-09 (ownership plan step 2) and 2026-11-10: "I can't keep on teaching it based on fixed rules."
//
// WHAT THIS IS: a VIEW. It reads the memories Jarvis already keeps about a customer's money — the payment follow-up log (asked / chased /
// escalated / held / promised), the receipts, the deposits Jarvis placed or asked about — and lays them on ONE timeline, with one status.
// That timeline is the context the learner (learner/, docs/LEARNER.md) will read, instead of rules someone typed.
//
// WHAT IT DELIBERATELY IS NOT: it moves nothing. The plan said to "move the follow-up log, holds and questions into" one record. That is a
// migration of three live stores that the chaser, the hold logic and the auto-apply all read and write; CLAUDE.md rule 1 says not to change
// behaviour she has not asked to change, so those stores stay exactly where they are and this reads them. Moving them is a separate step
// that needs her yes.
//
// WRITES NOTHING. Edge METALS only (rule 5): the follow-up log and sales ledger are Edge Metals'.
const keyOf = (name) => String(name == null ? '' : name).trim().toLowerCase().replace(/\s+/g, ' ');
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const iso = (v) => {
    if (v == null || v === '') return null;
    const t = typeof v === 'number' ? v : Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function defaults() {
    return {
        chaserLog: () => require('./paymentChaser').readLog(),
        receipts: () => require('./salesReceipts').list(),
        sales: () => require('./sales').listWithTotals(),
        auto: () => require('./depositAutoApply').list(),
    };
}

// Status, strongest evidence first. Every status says WHY, in words she can check.
function statusOf({ balance, steps, held, now }) {
    const owes = balance > 0.005;
    if (!owes) return { status: 'paid up', why: 'nothing is owed on the Sales ledger' };
    if (held && !held.dismissed) {
        const until = held.promisedUntil || null;
        if (until && until >= now) return { status: 'promised', why: `she said she will pay on ${held.promisedOn || iso(until).slice(0, 10)}`, promisedOn: held.promisedOn || iso(until).slice(0, 10) };
        if (until && until < now) return { status: 'promise broken', why: `she promised ${held.promisedOn || iso(until).slice(0, 10)} and the invoice is still open` };
        return { status: 'possible payment found', why: 'mail or a bank deposit looks like their payment; waiting for you to confirm' };
    }
    if (steps.escalate) return { status: 'escalated to a person', why: `passed to the team on ${steps.escalate.slice(0, 10)}` };
    if (steps.chase) return { status: 'chased', why: `reminded on ${steps.chase.slice(0, 10)}; no payment since` };
    if (steps.ask) return { status: 'asked', why: `asked about remittance on ${steps.ask.slice(0, 10)}; no reply or payment since` };
    return { status: 'open', why: 'owes money and nobody has been told yet' };
}

/** The case for ONE customer. Pure over `src` (injectable) and `now`. */
function buildOne(customer, { src = defaults(), now = Date.now() } = {}) {
    const k = keyOf(customer);
    const events = [];
    const add = (at, kind, source, text, extra = {}) => { const a = iso(at); if (a) events.push({ at: a, kind, source, text, ...extra }); };

    const log = (src.chaserLog() || {})[k] || null;
    const steps = {};
    if (log) {
        const st = log.steps || (log.lastStep ? { [log.lastStep]: log.lastAt } : {});
        for (const [s, at] of Object.entries(st)) {
            steps[s] = iso(at);
            add(at, s === 'ask' ? 'asked' : s === 'chase' ? 'chased' : s === 'escalate' ? 'escalated' : s, 'follow-up log',
                s === 'ask' ? 'asked about remittance' : s === 'chase' ? 'sent a reminder' : s === 'escalate' ? 'passed to the team' : s);
        }
        if (log.held) {
            add(log.held.at, 'held', 'follow-up log', 'something that looks like their payment was found; follow-ups paused',
                { confirmed: !!log.held.confirmed, dismissed: !!log.held.dismissed });
            if (log.held.promisedOn) add(log.held.at, 'promised', 'customer mail', `they said they will pay on ${log.held.promisedOn}`, { promisedOn: log.held.promisedOn });
        }
    }
    for (const r of (src.receipts() || [])) {
        if (keyOf(r.customer) !== k) continue;
        if (r.created_by === 'jarvis-auto') continue;     // shown as "placed" below, with the reasons; not twice
        add(r.created_at || r.date, 'paid', 'receipts',
            `${money(r.amount)} received${r.mode ? ' by ' + r.mode : ''}${r.ref ? ' (' + r.ref + ')' : ''}`, { amount: round2(r.amount) });
    }
    const auto = src.auto() || { entries: [], asks: [] };
    for (const e of (auto.entries || [])) {
        if (keyOf(e.customer) !== k) continue;
        add(e.appliedAt, 'placed', e.placedBy === 'her' ? 'on your yes' : 'placed by Jarvis', `${money(e.amount)} placed${e.invoice_no ? ' on ' + e.invoice_no : ''}: ${(e.reasons || []).slice(0, 2).join('; ')}`, { code: e.code });
        if (e.undone) add(e.undone.at, 'undone', 'you', `you undid it${e.undone.reason ? ': ' + e.undone.reason : ''}`, { code: e.code });
    }
    for (const q of (auto.asks || [])) {
        if (keyOf(q.customer) !== k) continue;
        add(q.askedAt, 'asked-you', 'Jarvis', `asked you about a ${money(q.amount)} deposit: ${q.why}`, { code: q.code });
        if (q.answer) add(q.answer.at, 'answered', 'you', `you said ${q.answer.kind}`, { code: q.code });
    }

    const mine = (src.sales() || []).filter((s) => keyOf(s.customer) === k);
    const balance = round2(mine.reduce((t, s) => t + Math.max(0, Number(s.balance) || 0), 0));
    const st = statusOf({ balance, steps, held: log && log.held, now });
    events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    return { customer: log && log.customer || (mine[0] && mine[0].customer) || String(customer), key: k, balance, open_invoices: mine.filter((s) => Number(s.balance) > 0.005).length,
        ...st, events, last_event: events.length ? events[events.length - 1].at : null };
}

/** Every customer who owes money or has a history, owing-most first. */
function buildAll({ src = defaults(), now = Date.now() } = {}) {
    const names = new Map();
    for (const [k, v] of Object.entries(src.chaserLog() || {})) if (k[0] !== '_') names.set(k, (v && v.customer) || k);
    for (const s of (src.sales() || [])) if (Number(s.balance) > 0.005 && s.customer) names.set(keyOf(s.customer), s.customer);
    return [...names.values()].map((n) => buildOne(n, { src, now })).sort((a, b) => b.balance - a.balance || a.customer.localeCompare(b.customer));
}

module.exports = { buildOne, buildAll, statusOf, keyOf };
