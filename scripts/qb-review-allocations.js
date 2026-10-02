#!/usr/bin/env node
// ── scripts/qb-review-allocations.js ──────────────────────────────────────
// Apsara, 2026-10-02, on the QB Agent email that said "Placed $2,423,912.36
// across 60 payments": "yes review".
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────
// helpers/quickbooks/applyPayments.js decides, per payment, whether its match
// is CERTAIN:
//
//     certain: picks.length === 1 && picks[0].certain
//
// and a pick is only certain when ONE open bill matches the payment to the
// cent. Everything else is marked `certain: false` with the reason "oldest
// bill still open".
//
// apply() never reads that flag. Its only filter is `if (!row.picks.length)`.
// So the 60 allocations are a mix: some are exact matches, some are an
// oldest-first CONVENTION applied to her live books. No money moved — an
// allocation adds no bank entry and changes no supplier's total — but WHICH
// bill reads paid may be wrong, and that is the thing she argues with
// suppliers about.
//
// ── IT CHANGES NOTHING ────────────────────────────────────────────────────
// Read-only, by construction: it issues GETs and never a POST. There is no
// --write flag to add later by accident, because there is no write path in
// this file at all.
//
// ── WHY IT HAS TO INFER ───────────────────────────────────────────────────
// The journal records WHAT was placed but not WHY:
//
//     reason: `... — placed 1234.00 across #567 (INV-1) 1234.00`
//
// The pick's own `why` ("matches this payment to the cent" / "oldest bill
// still open") is not written down. So this reads the journal for what was
// done and asks QuickBooks what those bills look like NOW, and classifies
// from the two together. The inference is stated in full below and printed
// with the result, because a confident label on a guess is worse than a
// hedge — and the ONE case it genuinely cannot separate is called out rather
// than rounded into the safe pile.
//
// helpers/quickbooks/applyPayments.js now records `certain` and `why` on new
// entries, so a future review is read, not inferred. This file uses the
// recorded value when it finds one and says so.
//
// Usage, ON THE VM (that is where the token and the journal are):
//   node scripts/qb-review-allocations.js                  # last 2 days
//   node scripts/qb-review-allocations.js --since 2026-10-01
//   node scripts/qb-review-allocations.js --csv > review.csv

const path = require('path');
const ROOT = path.join(__dirname, '..');
const journal = require(path.join(ROOT, 'helpers/quickbooks/journal'));
const client = require(path.join(ROOT, 'helpers/quickbooks/client'));
const auth = require(path.join(ROOT, 'helpers/quickbooks/auth'));

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i === -1 ? d : (argv[i + 1] || true); };
const has = (n) => argv.includes(n);

const CSV = has('--csv');
const SINCE = flag('--since', new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10));
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const r2 = (n) => Math.round(Number(n) * 100) / 100;

// "placed 1234.00 across #567 (INV-1) 1000.00, #568 234.00"
function parseReason(reason) {
    const s = String(reason || '');
    const m = s.match(/placed\s+([\d.]+)\s+across\s+(.+)$/i);
    if (!m) return null;
    const placed = Number(m[1]);
    const picks = [];
    for (const part of m[2].split(',')) {
        const p = part.trim().match(/^#(\S+?)(?:\s+\(([^)]*)\))?\s+([\d.]+)$/);
        if (p) picks.push({ billId: p[1], doc: p[2] || '', take: Number(p[3]) });
    }
    return { placed, picks };
}

(async () => {
    const env = auth.qbEnv();
    const rows = journal.list({ env, kind: 'billpayment', action: 'allocated' })
        .filter((e) => String(e.at || '') >= SINCE)
        // The agent writes one summary entry per RUN with no payment id as
        // well as one per payment; the summary has nothing to review.
        .filter((e) => e.qb && e.qb.id);

    if (!rows.length) {
        console.log(`No allocations journalled on or after ${SINCE} (env ${env}).`);
        console.log('If the run was on the VM, run this there — the journal is a local file.');
        return;
    }

    const billCache = new Map();
    const getBill = async (id) => {
        if (billCache.has(id)) return billCache.get(id);
        let b = null;
        try { b = (await client.request('GET', `/bill/${id}`, null, { env })).Bill || null; }
        catch (e) { b = { __error: e.message }; }
        billCache.set(id, b);
        return b;
    };

    const out = [];
    for (const e of rows) {
        const parsed = parseReason(e.reason);
        const vendor = (e.jarvis && e.jarvis.vendor) || '';
        const rec = { at: e.at, paymentId: String(e.qb.id), vendor,
                      paymentTotal: e.qb.total, placed: parsed ? parsed.placed : null,
                      picks: [], verdict: '', why: '' };

        // Recorded certainty beats inference. New entries carry it.
        const recorded = e.jarvis && typeof e.jarvis.certain === 'boolean' ? e.jarvis : null;

        if (!parsed || !parsed.picks.length) {
            rec.verdict = 'UNREADABLE';
            rec.why = 'the journal line could not be parsed — inspect it by hand';
            out.push(rec); continue;
        }

        for (const p of parsed.picks) {
            const b = await getBill(p.billId);
            rec.picks.push({ ...p,
                total: b && !b.__error ? r2(b.TotalAmt) : null,
                balance: b && !b.__error ? r2(b.Balance) : null,
                error: b && b.__error ? b.__error : null });
        }

        if (recorded) {
            rec.verdict = recorded.certain ? 'EXACT' : 'GUESS';
            rec.why = `recorded at the time: ${recorded.why || (recorded.certain ? 'exact match' : 'oldest bill still open')}`;
        } else if (parsed.picks.length > 1) {
            // Several bills for one payment can never have come from the
            // exact-match branch — that branch returns after a single pick.
            rec.verdict = 'GUESS';
            rec.why = `split across ${parsed.picks.length} bills — oldest-first, not an exact match`;
        } else {
            const only = rec.picks[0];
            if (only.error) {
                rec.verdict = 'UNKNOWN';
                rec.why = `could not read bill #${only.billId}: ${only.error}`;
            } else if (r2(only.take) !== r2(only.total)) {
                // Took less than the whole bill: a part payment, which the
                // exact branch never produces (it takes the full open balance).
                rec.verdict = 'GUESS';
                rec.why = `part payment — took ${money(only.take)} of a ${money(only.total)} bill`;
            } else {
                // ── THE ONE IT CANNOT SEPARATE ───────────────────────────
                // take == the bill's full amount. That is what the exact
                // branch does; it is ALSO what oldest-first does when the
                // oldest bill happened to be the same size. Indistinguishable
                // after the fact, so it is labelled honestly rather than
                // filed under EXACT to make the summary look better.
                rec.verdict = 'LIKELY EXACT';
                rec.why = 'settled the bill exactly — almost certainly the to-the-cent match, '
                        + 'though an oldest-first pick of the same size looks identical afterwards';
            }
        }
        out.push(rec);
    }

    if (CSV) {
        console.log('at,payment_id,vendor,placed,verdict,bills,why');
        for (const r of out) {
            console.log([r.at, r.paymentId, `"${String(r.vendor).replace(/"/g, '""')}"`,
                r.placed, r.verdict, r.picks.map((p) => `#${p.billId}:${p.take}`).join(' '),
                `"${r.why.replace(/"/g, '""')}"`].join(','));
        }
        return;
    }

    const by = (v) => out.filter((r) => r.verdict === v);
    const sum = (list) => list.reduce((s, r) => s + (r.placed || 0), 0);

    console.log(`\nQuickBooks allocations journalled since ${SINCE} (env ${env})\n`);
    console.log(`  ${out.length} payments, ${money(sum(out))} placed in total\n`);
    for (const v of ['GUESS', 'LIKELY EXACT', 'EXACT', 'UNKNOWN', 'UNREADABLE']) {
        const g = by(v);
        if (g.length) console.log(`  ${v.padEnd(13)} ${String(g.length).padStart(3)} payments   ${money(sum(g))}`);
    }

    // ── THE GUESSES FIRST, BECAUSE THEY ARE THE ONES TO LOOK AT ──────────
    const guesses = by('GUESS');
    if (guesses.length) {
        console.log(`\n── PLACED ON A CONVENTION, NOT A MATCH (${guesses.length}) ────────────────`);
        console.log('   These were put on the oldest open bill because it was open, not');
        console.log('   because the amount matched. The supplier total is right either way;');
        console.log('   which bill reads paid may not be.\n');
        guesses.sort((a, b) => (b.placed || 0) - (a.placed || 0));
        for (const r of guesses) {
            console.log(`   ${money(r.placed).padStart(15)}  ${r.vendor || '(no vendor)'}`);
            console.log(`   ${''.padStart(15)}  payment #${r.paymentId} · ${String(r.at).slice(0, 16).replace('T', ' ')}`);
            for (const p of r.picks) {
                console.log(`   ${''.padStart(15)}    -> bill #${p.billId}${p.doc ? ` (${p.doc})` : ''}`
                    + ` took ${money(p.take)}${p.total != null ? ` of ${money(p.total)}` : ''}`
                    + `${p.balance != null ? `, now owes ${money(p.balance)}` : ''}`);
            }
            console.log(`   ${''.padStart(15)}    ${r.why}`);
            console.log('');
        }
    }

    const odd = [...by('UNKNOWN'), ...by('UNREADABLE')];
    if (odd.length) {
        console.log(`\n── COULD NOT BE JUDGED (${odd.length}) ───────────────────────────────────`);
        for (const r of odd) console.log(`   payment #${r.paymentId} ${r.vendor} — ${r.why}`);
    }

    console.log('\n── HOW TO READ THIS ──────────────────────────────────────────────');
    console.log('   EXACT         recorded as a to-the-cent match when it was made.');
    console.log('   LIKELY EXACT  settled a bill exactly. Almost certainly a real match,');
    console.log('                 but an oldest-first pick of the same size is identical');
    console.log('                 after the fact, so it is not claimed as certain.');
    console.log('   GUESS         oldest-open-bill convention, or split across bills.');
    console.log('                 Correct supplier, possibly the wrong bill.');
    console.log('\n   Nothing here moved money. To unpick one, open the payment in');
    console.log('   QuickBooks and clear the bill it was linked to.\n');
})().catch((e) => { console.error('review failed:', e.message); process.exit(1); });
