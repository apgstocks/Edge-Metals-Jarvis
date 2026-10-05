// ── tests/entities.js ─────────────────────────────────────────────────────
// Apsara, 2026-10-06, asked what AAA Investment is: "A third company with
// its own return."
//
// Three returns. Every money row has to land on exactly one of them, and
// before helpers/entities.js nothing in Jarvis could say which — company
// was implied by which FILE a row lived in, by load_kind on the shared
// payments.json, and by paid_via, which is blank on most historical rows.
//
// CLAUDE.md rule 5 is "Edge Yard and Edge Metals are different companies".
// These checks are that rule made executable, because a misfiling here does
// not look like a bug: it looks like a slightly different number on a tax
// return, and nobody finds it until an audit.
//
// Section F is the one that matters most. Inter-company money — Edge Metals
// paying an Edge Trading bill — belongs on BOTH balance sheets, and the
// easiest way to make three returns quietly wrong is to collapse "whose
// books" and "whose money" into one field and lose it.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-entities-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against real data');
    process.exit(1);
}

const E = require(path.join(ROOT, 'helpers/entities'));

// ── A — THREE COMPANIES, DECLARED ─────────────────────────────────────────
{
    section('A — three companies, because she said three');

    const ids = E.ENTITIES.map((e) => e.id);
    ck('there are exactly three', E.ENTITIES.length === 3, JSON.stringify(ids));
    ck('  Edge Metals', ids.includes('edge-metals'), JSON.stringify(ids));
    ck('  Edge Trading — the yard', ids.includes('edge-trading'), JSON.stringify(ids));
    ck('  AAA Investment, which she confirmed files its own return',
       ids.includes('aaa-investment'), JSON.stringify(ids));

    // Each id appears once. An object literal with a duplicated key silently
    // keeps the last one, which would drop a company without any error.
    ck('  and no id is duplicated', new Set(ids).size === ids.length, JSON.stringify(ids));

    ck('every company says why it exists',
       E.ENTITIES.every((e) => typeof e.why === 'string' && e.why.length > 30),
       JSON.stringify(E.ENTITIES.filter((e) => !e.why || e.why.length <= 30).map((e) => e.id)));
    ck('  and carries both a legal name and the name her screens use',
       E.ENTITIES.every((e) => e.legalName && e.uiName), JSON.stringify(E.ENTITIES.map((e) => [e.id, e.legalName, e.uiName])));
}

// ── B — THE NAMES ARE RECONCILED, AND TIED TO THEIR SOURCES ───────────────
// Four names for two companies across the stores. The claim that two of them
// are the SAME company is not an opinion, and these checks pin it to the
// files that justify it so it cannot drift.
{
    section('B — Edge Yard and EDGE TRADING INC are one company');

    ck('"Edge Yard" resolves', E.resolve('Edge Yard') === 'edge-trading', String(E.resolve('Edge Yard')));
    ck('  and "EDGE TRADING INC" resolves to THE SAME company',
       E.resolve('EDGE TRADING INC') === E.resolve('Edge Yard'),
       'if these ever differ, the yard gets two sets of statements and both are wrong');
    ck('  as does "Edge Trading", which outboundLoads and gemini.js use',
       E.resolve('Edge Trading') === 'edge-trading');

    // The justification, in the two files that carry it. payments.js maps
    // Chase to exactly one owner; bank-accounts.json says who banks there.
    const pay = fs.readFileSync(path.join(ROOT, 'helpers/payments.js'), 'utf8');
    ck('payments.js really maps Chase to one owner only',
       /\^chase/i.test(pay) && /return \['Edge Yard'\]/.test(pay),
       'this is why Edge Yard and the Chase account are the same company');
    const banks = JSON.parse(fs.readFileSync(path.join(ROOT, 'qb-settings/bank-accounts.json'), 'utf8'));
    const chase = banks.accounts.find((a) => /chas/i.test(a.swift || ''));
    ck('  and bank-accounts.json says the Chase account is EDGE TRADING INC',
       chase && E.resolve(chase.company) === 'edge-trading',
       JSON.stringify(chase && chase.company));
    const bofa = banks.accounts.find((a) => /bofa/i.test(a.swift || ''));
    ck('  while BofA is Edge Metals',
       bofa && E.resolve(bofa.company) === 'edge-metals', JSON.stringify(bofa && bofa.company));

    // Case and punctuation vary everywhere in this data.
    ck('case does not matter', E.resolve('eDgE mEtAlS iNc') === 'edge-metals');
    ck('  nor does trailing punctuation', E.resolve('Edge Metals Inc.') === 'edge-metals');
    ck('  nor surrounding whitespace', E.resolve('   AAA Investment  ') === 'aaa-investment');

    // AND IT NEVER GUESSES. A name it does not know is null, not the
    // closest match — a fuzzy hit here files a stranger's money.
    ck('an unknown name is null, not a best guess', E.resolve('Acme Metals Corp') === null,
       String(E.resolve('Acme Metals Corp')));
    ck('  blank is null', E.resolve('') === null && E.resolve(null) === null && E.resolve(undefined) === null);
    // "Edge" alone must NOT resolve — it is a prefix of all three.
    ck('  and a bare "Edge" resolves to nothing, because it could be any of them',
       E.resolve('Edge') === null, String(E.resolve('Edge')));
}

// ── C — A RETURN CANNOT BE PRINTED WITHOUT A TAX ID ───────────────────────
// She has given a tax ID for one of the three. The pack must refuse rather
// than print a statement with a blank where the number goes.
{
    section('C — filable() refuses what cannot be filed');

    const m = E.filable('edge-metals');
    ck('Edge Metals is filable — it has a tax ID and an address', m.ok === true, JSON.stringify(m));

    const t = E.filable('edge-trading');
    ck('Edge Trading is NOT filable', t.ok === false, JSON.stringify(t));
    ck('  and it says exactly what is missing: the tax ID',
       t.missing.includes('tax ID'), JSON.stringify(t.missing));
    ck('  and says it is hers to supply', /hers to supply/.test(t.detail), t.detail);

    const a = E.filable('aaa-investment');
    ck('AAA Investment is NOT filable', a.ok === false, JSON.stringify(a));
    ck('  missing both a tax ID and an address',
       a.missing.includes('tax ID') && a.missing.includes('registered address'), JSON.stringify(a.missing));
    ck('  and it records what she still owes the books',
       Array.isArray(E.get('aaa-investment').needsFromHer)
       && E.get('aaa-investment').needsFromHer.length >= 3,
       JSON.stringify(E.get('aaa-investment').needsFromHer));

    ck('a company that does not exist is not filable either',
       E.filable('nope').ok === false && E.filable('nope').detail.includes('no such entity'),
       JSON.stringify(E.filable('nope')));
}

// ── D — EACH STORE LANDS ON THE RIGHT COMPANY ─────────────────────────────
// helpers/tools.js:305 is the authoritative split. If this drifts from it,
// a statement reads the other company's money.
{
    section('D — the store decides, per helpers/tools.js');

    const metals = ['bills', 'sales', 'bill_payments', 'sales_receipts',
        'sales_settlements', 'metals_trucking', 'edge_inventory'];
    for (const s of metals) {
        const r = E.of(s, { amount: 100 });
        ck(`${s} is Edge Metals`, r.ledger === 'edge-metals', `${s} → ${r.ledger}`);
    }

    const yard = ['loads', 'outbound_loads', 'expenses', 'petty_cash',
        'trucker_bills', 'scale_tickets'];
    for (const s of yard) {
        const r = E.of(s, { amount: 100 });
        ck(`${s} is Edge Trading`, r.ledger === 'edge-trading', `${s} → ${r.ledger}`);
    }

    // The split must agree with tools.js, which is the file her assistant
    // reads. Two lists that disagree is the whole failure mode.
    const tools = fs.readFileSync(path.join(ROOT, 'helpers/tools.js'), 'utf8');
    ck('tools.js still names the Edge Metals stores it keeps out of the yard',
       /bills/.test(tools) && /sales receipts|sales_receipts/.test(tools),
       'if tools.js changes its split, STORE_LEDGER has to change with it');

    // An unknown store is a QUESTION, not a default.
    const unknown = E.of('claims', { amount: 5 });
    ck('an unknown store is undecided rather than assigned',
       unknown.undecided === true && unknown.ledger === null, JSON.stringify(unknown));
    ck('  and says the decision was never made',
       /never been decided/.test(unknown.basis), unknown.basis);
}

// ── E — payments.json IS SHARED, AND SPLIT BY load_kind ───────────────────
{
    section('E — the one store both companies write to');

    for (const kind of ['bill', 'sale_cost', 'metals_trucking']) {
        const r = E.of('payments', { load_kind: kind, amount: 1 });
        ck(`load_kind '${kind}' is Edge Metals`, r.ledger === 'edge-metals', JSON.stringify(r));
    }
    for (const kind of ['purchase', 'sale', 'trucker']) {
        const r = E.of('payments', { load_kind: kind, amount: 1 });
        ck(`load_kind '${kind}' is Edge Trading`, r.ledger === 'edge-trading', JSON.stringify(r));
    }

    // ── THE SET IS REQUIRED, NOT COPIED ─────────────────────────────────
    // Written first as a copy with a silent fallback — and payments.js did
    // not export the Set at all, so the fallback was the ONLY path that ever
    // ran and nothing said so. These two checks are why that cannot recur.
    const mk = E.metalsKinds();
    ck('EDGE_METALS_KINDS really comes from payments.js, not a local copy',
       mk.source === 'payments.js',
       `source is "${mk.source}" — a copy here would not follow a fourth kind added there`);
    const pay = require(path.join(ROOT, 'helpers/payments'));
    ck('  payments.js exports it',
       !!pay.EDGE_METALS_KINDS && typeof pay.EDGE_METALS_KINDS.has === 'function',
       'without this export entities.js silently uses FALLBACK_KINDS');
    ck('  and it is the SAME Set object, so they cannot diverge',
       mk.kinds === pay.EDGE_METALS_KINDS, 'a clone would drift the day a kind is added');
    ck('  the fallback is not in use', !/FALLBACK/.test(mk.source), mk.source);
    // If it ever IS in use, every row says so.
    ck('  and if it were, every row would say so in its basis',
       /EDGE_METALS_KINDS from payments.js/.test(E.of('payments', { load_kind: 'bill' }).basis),
       E.of('payments', { load_kind: 'bill' }).basis);

    // A payment with no kind cannot be placed. Defaulting it to the yard —
    // the likelier of the two — would put Edge Metals money on Edge
    // Trading's return, silently.
    const noKind = E.of('payments', { amount: 500 });
    ck('a payment with no load_kind is undecided, never defaulted',
       noKind.undecided === true && noKind.ledger === null, JSON.stringify(noKind));
    ck('  and says that guessing would put it on a return',
       /guessing would put it on a return/.test(noKind.basis), noKind.basis);
}

// ── F — INTER-COMPANY: THE FIGURE THAT DISAPPEARS IF YOU FLATTEN ──────────
// With three filers, one company paying another's bill is a loan between two
// taxpayers. It belongs on both balance sheets. Collapse "whose books" and
// "whose money" into one field and the item vanishes from both.
{
    section('F — one company paying another\'s transaction');

    const r = E.of('payments', { load_kind: 'purchase', paid_via: 'Edge Metals', amount: 12000 });
    ck('the LEDGER is still Edge Trading — it is the yard\'s purchase',
       r.ledger === 'edge-trading', JSON.stringify(r));
    ck('  but the MONEY was Edge Metals\'',
       r.paidBy === 'edge-metals', JSON.stringify(r));
    ck('  and it is flagged inter-company',
       r.interCompany === true, JSON.stringify(r));
    ck('  with a basis naming both sides',
       /Edge Metals money paid Edge Yard/.test(r.basis), r.basis);

    // The other direction, and the third company.
    const aaa = E.of('payments', { load_kind: 'purchase', paid_via: 'AAA Investment', amount: 9000 });
    ck('AAA paying a yard purchase is inter-company too',
       aaa.interCompany === true && aaa.paidBy === 'aaa-investment' && aaa.ledger === 'edge-trading',
       JSON.stringify(aaa));

    // Petty cash: the ledger is the yard's drawer, cash_source says who
    // funded it. 'Edge Metals' there is another filer's money in the till.
    const petty = E.of('petty_cash', { cash_source: 'Edge Metals', amount: 300 });
    ck('petty cash funded by Edge Metals keeps the yard as the ledger',
       petty.ledger === 'edge-trading', JSON.stringify(petty));
    ck('  and records Edge Metals as the funder',
       petty.paidBy === 'edge-metals' && petty.interCompany === true, JSON.stringify(petty));

    // ── AND THE SAME-COMPANY CASE IS NOT FLAGGED ────────────────────────
    // A flag that fires on everything is not a flag. This is the negative
    // control: a yard purchase paid by the yard is ordinary.
    const same = E.of('payments', { load_kind: 'purchase', paid_via: 'Edge Yard', amount: 400 });
    ck('a yard purchase paid by the yard is NOT inter-company',
       same.interCompany === false && same.ledger === 'edge-trading' && same.paidBy === 'edge-trading',
       JSON.stringify(same));
    const plain = E.of('payments', { load_kind: 'bill', amount: 400 });
    ck('  and neither is a row with no paid_via at all',
       plain.interCompany === false && plain.paidBy === null, JSON.stringify(plain));

    // A stated paid_via is HER answer and is never overwritten by the
    // store-based derivation — payments.js:resolvePaidVia refuses to
    // auto-fill it for precisely this reason.
    const stated = E.of('petty_cash', { cash_source: 'Chase Bank', amount: 10 });
    ck('a cash_source that is a BANK, not a company, does not become a funder',
       stated.paidBy === null && stated.interCompany === false, JSON.stringify(stated));
}

// ── G — bank-transactions CARRIES ITS OWN company FIELD ───────────────────
{
    section('G — the one store that already knows');

    const r = E.of('bank_transactions', { company: 'Edge Metals INC', amount: 100 });
    ck('it is read from the row\'s own company field',
       r.ledger === 'edge-metals' && /own company field/.test(r.basis), JSON.stringify(r));

    const blank = E.of('bank_transactions', { amount: 100 });
    ck('a bank row with no company is undecided',
       blank.undecided === true, JSON.stringify(blank));
    ck('  and says the account is not in bank-accounts.json',
       /not in bank-accounts\.json/.test(blank.basis), blank.basis);

    const weird = E.of('bank_transactions', { company: 'Some Other LLC', amount: 100 });
    ck('an unrecognised company name is undecided, not coerced',
       weird.undecided === true && /does not know/.test(weird.basis), JSON.stringify(weird));
}

// ── H — place() SEPARATES WHAT IT COULD NOT PLACE ─────────────────────────
// A statement built from `placed` while `undecided` is non-empty is
// INCOMPLETE. The caller has to be able to see that rather than read a total
// and believe it.
{
    section('H — a total you can trust, or a list of what is missing');

    const rows = [
        { load_kind: 'bill', amount: 100 },
        { load_kind: 'purchase', amount: 200 },
        { load_kind: 'purchase', paid_via: 'Edge Metals', amount: 300 },
        { amount: 400 },                       // no load_kind — undecidable
    ];
    const p = E.place('payments', rows);
    ck('three rows placed', p.placed.length === 3, JSON.stringify(p.placed.map((x) => x.ledger)));
    ck('  one could not be', p.undecided.length === 1, JSON.stringify(p.undecided.map((x) => x.basis)));
    ck('  one is inter-company', p.interCompany.length === 1, JSON.stringify(p.interCompany.length));
    ck('  and complete is FALSE, because one row is unplaced',
       p.complete === false, String(p.complete));

    // The undecided row carries the row itself, so she can be shown WHICH
    // one rather than a count.
    ck('the unplaced row comes back with the row attached',
       p.undecided[0].row && p.undecided[0].row.amount === 400, JSON.stringify(p.undecided[0].row));

    const clean = E.place('bills', [{ amount: 1 }, { amount: 2 }]);
    ck('a store with nothing ambiguous reports complete',
       clean.complete === true && clean.undecided.length === 0, JSON.stringify(clean.complete));

    // complete must mean something. If it were hardcoded true, the check
    // above would pass and the one above that would not.
    ck('  and complete is not simply always true',
       E.place('payments', [{ amount: 1 }]).complete === false,
       'a store of unplaceable rows must not report complete');
}

// ── I — IT NEVER THROWS, ON ANYTHING ──────────────────────────────────────
// This gets called per row across every store. One malformed row must not
// take down a statement — the figure must come out with the bad row listed,
// not as a stack trace.
{
    section('I — a malformed row cannot take down a statement');

    const nasty = [undefined, null, 0, '', 'a string', [], { paid_via: 42 },
        { load_kind: {} }, { company: [] }, { cash_source: null }];
    let threw = null;
    for (const row of nasty) {
        try { E.of('payments', row); } catch (e) { threw = `of(payments, ${JSON.stringify(row)}): ${e.message}`; }
        try { E.of(undefined, row); } catch (e) { threw = `of(undefined, ${JSON.stringify(row)}): ${e.message}`; }
    }
    ck('no input throws', threw === null, String(threw));

    try { E.place('payments', null); E.place(undefined, undefined); } catch (e) { threw = e.message; }
    ck('  place() survives a null row list', threw === null, String(threw));

    ck('a row with no store and no fields is undecided, not an error',
       E.of(undefined, {}).undecided === true, JSON.stringify(E.of(undefined, {})));

    // ── A NULL ROW IS A DATA PROBLEM, NOT A ZERO ────────────────────────
    // `row = {}` fires on undefined only, so a null row threw a TypeError
    // here until this check found it. loadJson deliberately never validates
    // what it reads, so one null left in bills.json by any past write would
    // have taken down the whole company's statement — and the statement is
    // what she files a return from. It must come back as a row she can be
    // shown, not as an empty row quietly worth nothing.
    for (const bad of [null, undefined, 0, '', 'text', []]) {
        const r = E.of('bills', bad);
        ck(`a ${bad === null ? 'null' : Array.isArray(bad) ? 'array' : JSON.stringify(bad)} row is undecided, not absorbed`,
           r.undecided === true && r.ledger === null, JSON.stringify(r));
    }
    ck('  and it says what it found instead of a row',
       /is not a row/.test(E.of('bills', null).basis), E.of('bills', null).basis);

    // place() must surface them rather than skipping them, or a store half
    // full of nulls would report a confident total.
    const withNulls = E.place('bills', [{ amount: 1 }, null, { amount: 2 }, undefined]);
    ck('place() counts bad rows as unplaced, not as nothing',
       withNulls.placed.length === 2 && withNulls.undecided.length === 2,
       JSON.stringify({ placed: withNulls.placed.length, undecided: withNulls.undecided.length }));
    ck('  so the store does not report complete',
       withNulls.complete === false, String(withNulls.complete));
}

// ── J — THE AUDIT SCRIPT USES THESE RULES, NOT ITS OWN ────────────────────
// helpers/reconcile.js went dead without anyone noticing, and
// scripts/check-dead-helpers.js exists because of it. The same risk applies
// in reverse here: a script that grows its own copy of the company rules
// would report a coverage figure that no statement agrees with.
{
    section('J — the VM audit script shares this file\'s rules');

    const p = path.join(ROOT, 'scripts/entity-audit.js');
    ck('there is a script she can run on the VM', fs.existsSync(p),
       'her money data is not in the repo, so coverage can only be measured there');
    const src = fs.readFileSync(p, 'utf8');
    ck('  and it requires helpers/entities rather than restating the rules',
       /helpers\/entities/.test(src), 'two copies of the company rules would drift');
    ck('  it reports the PERCENTAGE placed, which is the whole question',
       /PLACED:/.test(src) && /pct\(/.test(src), 'a resolver that places 60% is homework, not a return');
    ck('  and lists the rows it could not place, not just a count',
       /UNPLACED ROWS/.test(src), 'a list is fixable; a statistic is not');

    // ── IT MUST NOT INVENT ARITHMETIC ───────────────────────────────────
    // The first cut read row.amount and printed $0.00 for seven real
    // invoices, because sales.json stores weight and price, not amount.
    // CLAUDE.md already records this exact mistake once.
    ck('  it reads sales amounts through sales.js, not off the raw row',
       /listWithTotals/.test(src), 'sales.json has no amount field — the store computes it');
    ck('  and an amount it cannot get is reported, never counted as zero',
       /not costed|not stored/.test(src) && /null, NOT 0/.test(src),
       'a quietly wrong dollar figure in an audit is worse than an absent one');

    ck('  it writes nothing', !/mutateJson|writeFile|appendFile/.test(src),
       'an audit that can change her books is not an audit');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
