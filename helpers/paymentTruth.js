// helpers/paymentTruth.js - QuickBooks decides who still owes (Apsara, 2026-11-07: "fix").
// Jarvis's own sales ledger holds invoices but NOT payments: Rad Metal showed 96 sales, 0 receipts, $4.78M "open" - a customer
// who always pays. Payments are recorded in QuickBooks, so before any payment follow-up is drafted the draft is checked
// against QuickBooks' open invoices. Pure over (drafts, survey): no network, no writes.
//   - an invoice QuickBooks does not show open is dropped (it is paid, or not in QuickBooks at all)
//   - the amount used is QuickBooks' balance, not Jarvis's
//   - money received and not yet applied to an invoice ("apply-first" / "do-not-chase") stops the follow-up for that customer
//   - a customer QuickBooks has never heard of is skipped, never chased
const KEY = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

function reconcile(drafts, survey) {
    const out = [], skipped = [];
    const byName = new Map();
    for (const c of (survey && survey.customers) || []) {
        byName.set(KEY(c.customer), c);
        for (const a of c.alsoKnownAs || []) if (!byName.has(KEY(a))) byName.set(KEY(a), c);
    }
    const pf = require('./paymentFollowups');
    for (const d of drafts || []) {
        const c = byName.get(KEY(d.customer));
        if (!c) { skipped.push({ customer: d.customer, total: d.total, why: 'not-in-quickbooks' }); continue; }
        if (c.verdict === 'do-not-chase' || c.verdict === 'apply-first') { skipped.push({ customer: d.customer, total: d.total, why: 'apply-receipts-first' }); continue; }
        const lines = [];
        for (const l of d.lines || []) {
            const inv = (c.invoices || []).find((i) => (l.invoice_no && i.doc && KEY(i.doc) === KEY(l.invoice_no))
                || (l.container_no && (i.containers || []).some((x) => KEY(x) === KEY(l.container_no))));
            if (!inv || !(inv.balance > 0.005)) continue;
            lines.push({ ...l, balance: r2(inv.balance), received: r2(Math.max(0, inv.total - inv.balance)) });
        }
        if (!lines.length) { skipped.push({ customer: d.customer, total: d.total, why: 'paid-in-quickbooks' }); continue; }
        out.push(pf.draftFor(d.customer, lines, { to: d.to, cc: d.cc, kind: d.kind, etaTerms: d.eta_terms }));
    }
    return { drafts: out, skipped };
}

const WHY = {
    'not-in-quickbooks': 'are not in QuickBooks',
    'paid-in-quickbooks': 'show nothing open in QuickBooks (paid)',
    'apply-receipts-first': 'have money received in QuickBooks that is not applied to an invoice yet',
};
function skippedLine(skipped) {
    if (!skipped.length) return null;
    const parts = Object.keys(WHY).map((k) => ({ k, n: skipped.filter((s) => s.why === k).length })).filter((x) => x.n)
        .map((x) => `${x.n} ${WHY[x.k]}`);
    return `Payment follow-ups: left out ${skipped.length} customer${skipped.length === 1 ? '' : 's'} because QuickBooks does not confirm they owe: ${parts.join('; ')}. Nobody was contacted.`;
}

// The real survey, cached so an hourly agent does not hit QuickBooks eight times a day.
let cache = null;
const TTL = 4 * 3600 * 1000;
function liveSurvey() {
    return async () => {
        if (cache && Date.now() - cache.at < TTL) return cache.value;
        const env = require('./quickbooks/auth').qbEnv();
        const value = await require('./quickbooks/receivables').survey({ env, light: true });
        cache = { at: Date.now(), value };
        return value;
    };
}

module.exports = { reconcile, skippedLine, liveSurvey, KEY };
