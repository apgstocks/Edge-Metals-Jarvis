// ── tests/qb-parity.js ────────────────────────────────────────────────────
// Task #176. Her goal, in her words: QuickBooks goes in January 2027 and
// "accounts should be perfectly handled" to "convince owner to let go of qb".
//
// Driven as a SUBPROCESS over a temp DATA_DIR holding both sides, so the real
// script, the real helpers and the real snapshot reader are all exercised.
// What is asserted is what the owner would read off the terminal.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'qb-parity.js');

// A bill whose amount computes: gross minus the four tares, times the price.
const bill = (id, supplier, amount) => ({
    id, supplier, date: '2026-05-01', container_no: 'C' + id,
    supplier_price: 0.30, gross: amount / 0.30, truck: 0, container: 0, chassis: 0, boxes: 0,
});
const sale = (id, customer, amount) => ({
    id, customer, date: '2026-05-02', invoice_no: 'E' + id,
    invoice_price: 0.40, weight: amount / 0.40, price_unit: 'lb', weight_unit: 'lb',
});

function run({ bills = [], sales = [], suppliers = [], customers = [], at, env = 'production', map = null }) {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-parity-'));
    fs.writeFileSync(path.join(T, 'bills.json'), JSON.stringify(bills));
    fs.writeFileSync(path.join(T, 'sales.json'), JSON.stringify(sales));
    fs.writeFileSync(path.join(T, 'qb-books-snapshot.json'), JSON.stringify({
        at: at || new Date().toISOString(), env, since: '2026-01-01',
        suppliers, customers,
        totals: { owe: suppliers.reduce((s, x) => s + x.balance, 0),
            owed: customers.reduce((s, x) => s + x.balance, 0) },
    }));
    if (map) fs.writeFileSync(path.join(ROOT, 'data', 'qb-party-map.test.json'), JSON.stringify(map));
    try {
        return execFileSync(process.execPath, [SCRIPT, '--top', '50'], {
            cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, DATA_DIR: T, JARVIS_TEST: '1' },
        });
    } catch (e) { return String((e.stdout || '') + (e.stderr || '')); }
}

// ─────────────────────────────────────────────────────────────────────────
section('A. perfect agreement is the line she shows the owner');
{
    const out = run({
        bills: [bill('1', 'Mazariegos', 3000)],
        sales: [sale('1', 'OUTLAST', 4000)],
        suppliers: [{ name: 'Mazariegos', balance: 3000, unapplied_paid: 0, active: true }],
        customers: [{ name: 'OUTLAST', balance: 4000, unapplied_received: 0, active: true }],
    });
    ck('both totals are printed side by side', /Jarvis\s+\$3,000\.00/.test(out) && /QuickBooks\s+\$3,000\.00/.test(out), out);
    ck('  and agreement is stated in words, not left to her to subtract',
       (out.match(/AGREED — the totals match and every party reconciles/g) || []).length === 2, out);
    ck('  with the sentence the owner needs',
       /Every Jarvis party matches QuickBooks to the cent/.test(out), out);
    ck('  and it says it changed nothing', /Nothing was changed on either side/.test(out), out);
}

// ─────────────────────────────────────────────────────────────────────────
section('B. a disagreement is named, with the figure');
{
    const out = run({
        bills: [bill('1', 'Mazariegos', 3000), bill('2', 'Houston Junk Car Buyers', 500)],
        sales: [],
        suppliers: [
            { name: 'Mazariegos', balance: 2750, unapplied_paid: 0, active: true },
            { name: 'Houston Junk Car Buyers', balance: 500, unapplied_paid: 0, active: true },
        ],
        customers: [],
    });
    ck('the party that differs is listed', /THE FIGURES DIFFER/.test(out) && /Mazariegos/.test(out), out);
    ck('  with both figures and the gap', /Jarvis\s+\$3,000\.00\s+QB\s+\$2,750\.00\s+out by \$250\.00/.test(out), out);
    ck('  and the one that agrees is NOT listed as a problem',
       !/THE FIGURES DIFFER[\s\S]*Houston/.test(out), out);
    ck('  the count of agreeing parties is stated',
       /1 of 2 Jarvis parties agree/.test(out), out);
}

// ─────────────────────────────────────────────────────────────────────────
section('C. open in Jarvis and absent from QuickBooks gets its own bucket');
{
    // The shape that matters most before a cutover: the owner's books have
    // never seen this money at all.
    const out = run({
        bills: [bill('1', 'Brand New Yard', 9000)],
        // A sales row so this section tests the party buckets and nothing
        // else. With sales empty the run is correctly declared NOT A PARITY
        // RESULT, which is section E's subject, not this one's.
        sales: [sale('9', 'OUTLAST', 100)],
        suppliers: [{ name: 'Someone Else', balance: 120, unapplied_paid: 0, active: true }],
        customers: [{ name: 'OUTLAST', balance: 100, unapplied_received: 0, active: true }],
    });
    ck('it is reported separately, not as a mere difference',
       /OPEN IN JARVIS, NOT IN QUICKBOOKS[\s\S]*Brand New Yard\s+\$9,000\.00/.test(out), out);
    ck('  and the QuickBooks-only party is reported the other way',
       /OPEN IN QUICKBOOKS, NOT IN JARVIS[\s\S]*Someone Else/.test(out), out);
    ck('  and the summary does not claim agreement',
       !/Every Jarvis party matches/.test(out) && /are open in Jarvis/.test(out), out);
}

// ─────────────────────────────────────────────────────────────────────────
section('D. the join never guesses — Rigo is not Rego');
{
    // CLAUDE.md: her yard has a Rigo AND a Rego. A fuzzy match here puts one
    // supplier's balance against another's, which is worse than reporting
    // both as unmatched.
    const out = run({
        bills: [bill('1', 'Rigo', 1000)],
        sales: [sale('9', 'OUTLAST', 100)],
        suppliers: [{ name: 'Rego', balance: 1000, unapplied_paid: 0, active: true }],
        customers: [{ name: 'OUTLAST', balance: 100, unapplied_received: 0, active: true }],
    });
    ck('Rigo and Rego are NOT joined',
       /OPEN IN JARVIS, NOT IN QUICKBOOKS[\s\S]*Rigo/.test(out)
       && /OPEN IN QUICKBOOKS, NOT IN JARVIS[\s\S]*Rego/.test(out), out);
    // The payables section must NOT claim agreement; the receivables section
    // legitimately does, so the claim is checked where it belongs.
    // ── THE CATCH THIS FIXTURE PRODUCED ─────────────────────────────────
    // Rigo $1,000 in Jarvis and Rego $1,000 in QuickBooks: the TOTALS match to
    // the cent while zero parties reconcile. The script announced "they agree
    // to the cent" on the totals line — the one sentence an owner would take
    // at face value. Offsetting errors are the normal way a reconciliation
    // looks right and is wrong.
    const payables = out.split('WHAT SHE IS OWED')[0];
    ck('  the totals match, and it refuses to call that agreement',
       !/AGREED —/.test(payables)
       && /The totals match, but the parties do NOT reconcile/.test(payables), payables);

    // But spacing and punctuation are not a difference of identity.
    const out2 = run({
        bills: [bill('1', 'G & C Recycling', 2000)],
        sales: [sale('9', 'OUTLAST', 100)],
        suppliers: [{ name: 'G&C  Recycling', balance: 2000, unapplied_paid: 0, active: true }],
        customers: [{ name: 'OUTLAST', balance: 100, unapplied_received: 0, active: true }],
    });
    ck('  but spacing and punctuation alone do join them',
       /AGREED —/.test(out2) && !/NOT IN QUICKBOOKS[\s\S]*G & C/.test(out2), out2);
}

// ─────────────────────────────────────────────────────────────────────────
section('E. an empty store is NOT a zero balance');
{
    // THE FALSE GREEN THIS SCRIPT WAS ABOUT TO SHIP WITH. helpers/json.js'
    // loadJson never throws — a missing bills.json returns [], which totals
    // $0.00, which reads as "she owes nobody" and would be shown to the owner
    // as agreement with a QuickBooks zero. Caught running it on a machine
    // whose data/ is a thin dev copy.
    const out = run({
        bills: [],
        sales: [sale('1', 'OUTLAST', 4000)],
        suppliers: [],
        customers: [{ name: 'OUTLAST', balance: 4000, unapplied_received: 0, active: true }],
    });
    ck('the empty store is called out by name',
       /NO DATA: the Jarvis bills \(what she owes\) store is empty or absent/.test(out), out);
    ck('  and $0.00 is explained as absence, not a balance',
       /the absence of data, NOT a zero balance/.test(out), out);
    ck('  the run refuses to be read as a parity result',
       /NOT A PARITY RESULT/.test(out), out);
    ck('  and does NOT claim everything matches',
       !/Every Jarvis party matches QuickBooks/.test(out), out);
    ck('  "0 of 0 agree" is never printed', !/0 of 0 Jarvis parties agree/.test(out), out);
    // The line she actually reads. $0.00 vs $0.00 used to print "they agree to
    // the cent" right here, which made the summary's refusal half a fix.
    ck('  and the payables LINE says nothing to compare, not that they agree',
       /NOTHING TO COMPARE, the Jarvis store is empty/.test(out)
       && !/AGREED —/.test(out.split('WHAT SHE IS OWED')[0]), out);
}

// ─────────────────────────────────────────────────────────────────────────
section('F. it refuses to let her trust a stale or sandbox snapshot');
{
    const old = new Date(Date.now() - 23 * 86400000).toISOString();
    const out = run({
        bills: [bill('1', 'Mazariegos', 3000)], sales: [],
        suppliers: [{ name: 'Mazariegos', balance: 3000, unapplied_paid: 0, active: true }],
        customers: [], at: old,
    });
    // 2026-10-28: two duplicates reported off a five-week-old pull had already
    // been deleted. Age is not a footnote.
    ck('a 23-day-old snapshot says so, in the figures she is reading',
       /SNAPSHOT IS 23 DAYS OLD/.test(out) && /refresh before trusting any figure/.test(out), out);
    ck('  and names the command that fixes it', /node scripts\/qb-snapshot\.js/.test(out), out);

    const sand = run({
        bills: [bill('1', 'Mazariegos', 3000)], sales: [],
        suppliers: [{ name: 'Mazariegos', balance: 3000, unapplied_paid: 0, active: true }],
        customers: [], env: 'sandbox',
    });
    ck('a sandbox snapshot is announced as not her books',
       /sandbox snapshot — this is not her books/.test(sand), sand);
}

// ─────────────────────────────────────────────────────────────────────────
section('G. read-only, and honest about its own scope');
{
    const src = fs.readFileSync(SCRIPT, 'utf8');
    const code = src.replace(/^\s*\/\/.*$/gm, '');
    ck('it writes nothing anywhere',
       !/writeFile|mutateJson|appendFile/.test(code),
       'a parity report that edits her books is not a report');
    ck('  it reads what she OWES through the pay screen’s own helper',
       /bills\.listWithTotals\(\)/.test(code) && /balance > CENT/.test(code),
       'routes/money.js:9 uses exactly this, so the report cannot disagree with her screen');
    ck('  and what she is OWED through the receipts screen’s',
       /sales\.listWithTotals\(\)/.test(code));
    ck('  the join is her confirmed map plus EXACT normalisation, never fuzzy',
       /qb-party-map\.json/.test(code) && /nameMatch\.normalizeName/.test(code)
       && !/levenshtein|similar|fuzzy|distance/i.test(code));
    ck('  and it states which books it is comparing, rather than implying both companies',
       /Comparing Edge Metals bills and sales against the whole QuickBooks file/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }
