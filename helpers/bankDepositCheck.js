// helpers/bankDepositCheck.js - did money from this customer already land in the bank? (Plaid feed, helpers/bankLedger)
// Apsara, 2026-11-07: "You have Plaid as well". QuickBooks says what is applied; the bank feed shows what has ARRIVED. A deposit
// that looks like theirs (their name in the bank text, or exactly one of their open balances) and is not yet matched holds the
// follow-up and tells her to apply it. Read-only; it never records a receipt.
const GENERIC = new Set(['metal', 'metals', 'trading', 'trade', 'inc', 'llc', 'ltd', 'limited', 'co', 'corp', 'company', 'international', 'intl', 'enterprises', 'enterprise', 'recycling', 'group', 'industries', 'industry', 'the', 'and', 'dmcc', 'pte', 'private', 'global', 'steels', 'steel', 'resources']);
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
// A name made only of generic words has no name signal; the exact-amount match still applies.
const specific = (name) => words(name).filter((x) => !GENERIC.has(x) && x.length >= 3);
const cents = (n) => Math.round(Number(n || 0) * 100);
const mmdd = (d) => String(d || '').slice(5, 10).replace('-', '/');
const money = (n) => '$' + (Math.round(Number(n || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// rows: bankLedger rows. Returns (draft, { sinceMs, ignoreId }) -> { id, subject, kind:'bank', dateMs } | null
function makeFinder({ rows }) {
    return function find(draft, { sinceMs, ignoreId } = {}) {
        const list = (typeof rows === 'function' ? rows() : rows) || [];
        const toks = specific(draft.customer);
        const amounts = new Set((draft.lines || []).map((l) => cents(l.balance)).concat([cents(draft.total)]).filter((c) => c > 0));
        const since = sinceMs ? new Date(sinceMs).toISOString().slice(0, 10) : '0000-00-00';
        const hits = list.filter((r) => r && r.direction === 'in' && !r.excluded && !r.matched && r.id !== ignoreId && ('bank:' + r.id) !== ignoreId
            && String(r.date || '') >= since)
            .filter((r) => {
                const text = words(`${r.desc} ${r.memo || ''} ${r.party || ''}`);
                const byName = toks.length && toks.every((t) => text.some((w) => w === t || (t.length >= 5 && w.startsWith(t))));
                return byName || amounts.has(cents(r.amount));
            })
            .sort((a, b) => String(b.date).localeCompare(String(a.date)));
        const r = hits[0];
        if (!r) return null;
        return { id: 'bank:' + r.id, kind: 'bank', subject: `bank deposit ${money(r.amount)} on ${mmdd(r.date)}${r.desc ? ` "${String(r.desc).slice(0, 40)}"` : ''}`, dateMs: Date.parse(r.date) || Date.now() };
    };
}

function liveFinder() {
    const inner = makeFinder({ rows: () => require('./bankLedger').list() });
    return (draft, opts) => { try { return inner(draft, opts); } catch (e) { return null; } };
}

module.exports = { makeFinder, liveFinder, specific };
