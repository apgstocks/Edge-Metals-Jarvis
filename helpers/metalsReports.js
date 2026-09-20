// ── helpers/metalsReports.js — Jarvis reads the Edge Metals screens ─────────
//
// Apsara, 2026-09-20: "Answer from every Metals screen" — the screens voice
// could not read at all: Invoice → Freight / Commission / Margin, Bills →
// Trucking, Edge Inventory, and the active Quote Requests. READ ONLY: nothing
// here writes, pays or sends. Edge Metals only, by her rule — the yard's
// Inventory, Trucker Bills and Loads are Scout's and are not touched.
//
// Every report reads through the SAME helper the screen's own route calls
// (helpers/margin, metalsTrucking, salesSettlements, edgeInventory,
// supplierAccount, quoteRequests), so what Jarvis says and what the screen
// shows cannot disagree. Each returns { spoken, screen } — a sentence to say
// and the detail to show, per her "just say a … like 4 bookings" rule.

const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
const cents = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
const same = (a, b) => String(a || '').toLowerCase().replace(/[^a-z0-9]/g, '') === String(b || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const loose = (hay, needle) => String(hay || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    .includes(String(needle || '').toLowerCase().replace(/[^a-z0-9]/g, ''));

function margin() {
    const m = require('./margin');
    const all = m.rows();
    const s = m.summary(all);
    if (!s.count) return { spoken: 'There are no containers on the margin sheet yet.', screen: 'Margin — no containers yet.' };
    const spoken = s.closed
        ? `Across ${plural(s.closed, 'closed container')}, margin is ${money(s.margin)}${s.margin_pct !== null ? ` — ${s.margin_pct}% on ${money(s.revenue)} of sales` : ''}.`
          + (s.open_bought ? ` ${s.open_bought} bought and not yet sold.` : '')
          + (s.conflicted ? ` ${plural(s.conflicted, 'container has', 'containers have')} a duplicate, so check those.` : '')
        : `No container is closed yet — ${s.open_bought} bought, ${s.open_sold} sold.`;
    const screen = [
        'MARGIN (closed containers)',
        `Revenue ${cents(s.revenue)} · Cost ${cents(s.cost)} · Margin ${cents(s.margin)}${s.margin_pct !== null ? ` (${s.margin_pct}%)` : ''}`,
        `Closed ${s.closed} · Bought, not sold ${s.open_bought} · Sold, no bill ${s.open_sold}${s.conflicted ? ` · Duplicates ${s.conflicted}` : ''}`,
    ].join('\n');
    return { spoken, screen };
}

function trucking(opts = {}) {
    const mt = require('./metalsTrucking');
    let rows = mt.payables();
    if (opts.company) rows = rows.filter((r) => loose(r.trucking_company, opts.company));
    const s = mt.summary(rows);
    const who = opts.company ? ` to ${opts.company}` : '';
    if (!s.count) return { spoken: `No Edge Metals trucking bills${who}.`, screen: `Trucking — nothing${who}.` };
    const open = rows.filter((r) => r.balance > 0.005).sort((a, b) => b.balance - a.balance);
    const spoken = s.outstanding > 0.005
        ? `We owe ${money(s.outstanding)} in Edge Metals trucking${who}, across ${plural(s.unpaid_count, 'bill')}.`
          + (s.missing_count ? ` ${plural(s.missing_count, 'haul has', 'hauls have')} no amount yet.` : '')
        : `Edge Metals trucking${who} is all paid.` + (s.missing_count ? ` ${plural(s.missing_count, 'haul has', 'hauls have')} no amount yet.` : '');
    const byCo = new Map();
    for (const r of open) byCo.set(r.trucking_company || '(no company)', (byCo.get(r.trucking_company || '(no company)') || 0) + r.balance);
    const screen = [`TRUCKING (Edge Metals)${who ? ' —' + who : ''}`,
        `Owed ${cents(s.outstanding)} · Paid ${cents(s.paid)} · Bills ${s.count} · No amount ${s.missing_count}`,
        ...[...byCo.entries()].sort((a, b) => b[1] - a[1]).map(([c, v]) => `• ${c} — ${cents(v)}`)].join('\n');
    return { spoken, screen };
}

// kind: 'freight' (charges) | 'commission' — the two Invoice sub-tabs that
// read /api/sales-settlements, split exactly as renderPayables splits them.
function settlements(kind, opts = {}) {
    const st = require('./salesSettlements');
    let rows = st.payables().filter((p) => kind === 'commission' ? p.kind === 'commission' : p.kind === 'charge');
    if (opts.customer) rows = rows.filter((r) => loose(r.customer, opts.customer));
    const label = kind === 'commission' ? 'commission' : 'freight and charges';
    const total = rows.reduce((t, p) => t + (Number(p.amount) || 0), 0);
    const open = rows.filter((p) => (Number(p.balance) || 0) > 0.005).sort((a, b) => b.balance - a.balance);
    const owed = open.reduce((t, p) => t + p.balance, 0);
    if (!rows.length) return { spoken: `No ${label} on the invoices yet.`, screen: `${label.toUpperCase()} — none.` };
    const spoken = owed > 0.005
        ? `We owe ${money(owed)} in ${label}, on ${plural(open.length, 'line')}, out of ${money(total)} in total.`
        : `All ${label} is paid — ${money(total)} across ${plural(rows.length, 'line')}.`;
    const screen = [`${label.toUpperCase()}`, `Total ${cents(total)} · Outstanding ${cents(owed)} · Lines ${rows.length}`,
        ...open.slice(0, 15).map((p) => `• ${p.container_no || p.booking_no || '—'} ${p.customer ? '(' + p.customer + ') ' : ''}— ${p.what}: ${cents(p.balance)} owed`)]
        .join('\n');
    return { spoken, screen };
}

function edgeInventory(opts = {}) {
    const inv = require('./edgeInventory');
    const sa = require('./supplierAccount');
    if (opts.supplier) {
        const name = inv.suppliers().find((s) => same(s, opts.supplier))
            || inv.suppliers().find((s) => loose(s, opts.supplier)) || null;
        if (!name) return { spoken: `I don't have deliveries from ${opts.supplier} in Edge Inventory.`, screen: `Edge Inventory — nothing from ${opts.supplier}.` };
        const r = inv.summary(name);
        const acct = (sa.overview().find((o) => same(o.supplier, name)) || {});
        const spoken = `From ${name}: ${plural(r.receipts, 'delivery', 'deliveries')}, ${r.weight_mt} metric tons, worth ${money(r.amount)}.`
            + (acct.closing ? ` Balance on their account is ${money(acct.closing)}.` : '');
        const grades = (inv.byGrade(name) || []).slice(0, 10);
        const screen = [`EDGE INVENTORY — ${name}`, `Deliveries ${r.receipts} · ${r.weight_mt} MT · ${cents(r.amount)}${acct.closing !== undefined ? ` · Account balance ${cents(acct.closing)}` : ''}`,
            ...grades.map((g) => `• ${g.description || '—'} — ${g.weight_mt !== undefined ? g.weight_mt + ' MT' : ''}${g.amount !== undefined ? ' · ' + cents(g.amount) : ''}`)].join('\n');
        return { spoken, screen };
    }
    const all = sa.overview();
    if (!all.length) return { spoken: 'Edge Inventory is empty.', screen: 'Edge Inventory — empty.' };
    const owing = all.filter((o) => (o.closing || 0) > 0.005);
    const totalOwed = owing.reduce((t, o) => t + o.closing, 0);
    const spoken = `${plural(all.length, 'supplier')} in Edge Inventory.`
        + (owing.length ? ` We owe ${money(totalOwed)} across ${plural(owing.length, 'of them', 'of them')}.` : ' Nothing owed.')
        + ' Name a supplier for the detail.';
    const screen = ['EDGE INVENTORY — by supplier', ...all.slice(0, 20).map((o) => `• ${o.supplier} — balance ${cents(o.closing || 0)}`)].join('\n');
    return { spoken, screen };
}

function quotes() {
    const rows = [];
    try {
        for (const r of require('./quoteRequests').loadQuoteRequests() || []) if (r.status === 'active') rows.push({ ...r, _kind: 'trucker' });
    } catch (e) { /* none */ }
    try {
        for (const r of require('./contactQuoteRequests').loadContactQuoteRequests() || []) if (r.status === 'active') rows.push({ ...r, _kind: 'contact' });
    } catch (e) { /* none */ }
    if (!rows.length) return { spoken: 'No quote requests are open.', screen: 'Quote requests — none open.' };
    let priced = 0, waiting = 0;
    const lines = [];
    for (const r of rows) {
        const legs = r.legs || [];
        const got = legs.filter((l) => l.price && l.price.amount);
        priced += got.length; waiting += legs.filter((l) => l.status === 'awaiting_reply').length;
        const lane = `${r.origin_raw || r.origin_query || '?'} → ${r.destination_raw || r.destination_query || '?'}`;
        const best = got.slice().sort((a, b) => a.price.amount - b.price.amount)[0];
        lines.push(`• ${lane} — ${got.length}/${legs.length} priced${best ? `, best ${cents(best.price.amount)} (${best.trucker_name || best.contact_name || '—'})` : ''}`);
    }
    const spoken = `${plural(rows.length, 'quote request')} open. ${priced ? `${plural(priced, 'price')} in` : 'No prices in yet'}, ${waiting} still waiting.`;
    return { spoken, screen: ['QUOTE REQUESTS (open)', ...lines].join('\n') };
}

// Which report, from what she said — used by the offline fast path in
// brain.js. The AI classifier sets `report` itself; this is only the net.
function reportIn(text) {
    const t = String(text || '').toLowerCase();
    // The yard's figures are Scout's, even when the words overlap.
    if (/\byard\b|\bscout\b|\bloads?\b|\bpetty\b/.test(t)) return null;
    if (/\b(?:our|the|what'?s|what\s+is|how\s+much)\b.*\b(?:margin|profit)\b|^\s*(?:metals\s+)?margins?\s*\??$/.test(t)) return 'margin';
    if (/\btrucking\s+(?:bills?|payables?)\b|\bowe\b.*\btrucking\b|\btrucking\b.*\b(?:owe|owed|outstanding|unpaid)\b/.test(t)) return 'trucking';
    if (/\bcommissions?\b.*\b(?:owe|owed|outstanding|unpaid|due|pending)\b|\bowe\b.*\bcommissions?\b|^\s*commissions?\s*\??$/.test(t)) return 'commission';
    if (/\bfreight\b.*\b(?:owe|owed|outstanding|unpaid|due|pending|charges?)\b|\bowe\b.*\bfreight\b|^\s*freight\s+(?:charges|invoices)\s*\??$/.test(t)) return 'freight';
    if (/\bedge\s+inventory\b|\bmetals\s+inventory\b/.test(t)) return 'edge_inventory';
    // A STATUS question only. "Send quote request from Junk car to Eccomelt"
    // is get_quote — a new request — and tests/requirements.js caught this
    // rule swallowing it the first time it was written.
    if (/\b(?:send|get|make|create|raise|new|ask|request)\b/.test(t)) return null;
    if (/\b(?:open|active|pending|outstanding)\s+quote(?:\s+requests?|s)?\b|\bany\s+quotes?\s+(?:back|in|received|yet)\b|\bwho\s+(?:has\s+)?quoted\b|\bquote\s+requests?\s+status\b|\bstatus\s+of\s+(?:the\s+)?quotes?\b|^\s*(?:show\s+(?:me\s+)?)?(?:the\s+)?quote\s+requests\s*\??$/.test(t)) return 'quotes';
    return null;
}

function run(report, opts = {}) {
    switch (report) {
        case 'margin': return margin(opts);
        case 'trucking': return trucking(opts);
        case 'freight': return settlements('freight', opts);
        case 'commission': return settlements('commission', opts);
        case 'edge_inventory': return edgeInventory(opts);
        case 'quotes': return quotes(opts);
        default: return null;
    }
}

module.exports = { run, reportIn, margin, trucking, settlements, edgeInventory, quotes,
    REPORTS: ['margin', 'trucking', 'freight', 'commission', 'edge_inventory', 'quotes'] };
