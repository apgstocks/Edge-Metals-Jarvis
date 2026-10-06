#!/usr/bin/env node
// ── scripts/coa-reconcile.js — Jarvis's chart vs her real QuickBooks one ──
//
//     node scripts/coa-reconcile.js              # on the VM, where QB is connected
//     node scripts/coa-reconcile.js --categories # also audit her expense categories
//
// helpers/chartOfAccounts.js is a STARTING chart. It was chosen to fit what
// her business does — scrap at a yard, containers for export, three
// companies, advances to suppliers, commission to agents — and NOT copied
// from her QuickBooks chart, which has 377 accounts and is not in this repo.
//
// That honesty is only worth something if it is checked. A statement whose
// line names look familiar to her CPA but mean something else is worse than
// one that admits it is Jarvis's own view. This is the check.
//
// READ-ONLY, on both sides. It reads her QuickBooks chart and her own
// expense rows and writes nothing to either.

const path = require('path');
const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'helpers/chartOfAccounts'));

const WANT_CATEGORIES = process.argv.includes('--categories');

const norm = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// QuickBooks' own AccountType vocabulary, mapped to this chart's six types.
// Deliberately incomplete: anything not listed comes back as null and is
// REPORTED rather than guessed, because a misfiled type puts an account on
// the wrong statement and that error balances.
const QB_TYPE = {
    bank: 'asset', 'other current asset': 'asset', 'accounts receivable': 'asset',
    'fixed asset': 'asset', 'other asset': 'asset',
    'accounts payable': 'liability', 'credit card': 'liability',
    'other current liability': 'liability', 'long term liability': 'liability',
    equity: 'equity',
    income: 'income', 'other income': 'income',
    'cost of goods sold': 'cogs',
    expense: 'expense', 'other expense': 'expense',
};

(async () => {
    console.log(`\nCHART OF ACCOUNTS — Jarvis vs QuickBooks\n${new Date().toISOString()}\n`);

    // ── the chart's own integrity first ──────────────────────────────────
    const own = C.problems();
    if (own.length) {
        console.log('JARVIS CHART HAS PROBLEMS WITH ITSELF:');
        own.forEach((p) => console.log('  · ' + p));
        console.log('\nFix these before comparing — a broken chart compares badly for the wrong reason.\n');
        process.exit(1);
    }
    console.log(`Jarvis chart: ${C.ACCOUNTS.length} accounts, no internal problems.`);

    // ── her QuickBooks chart ─────────────────────────────────────────────
    let qb = null;
    try {
        const books = require(path.join(ROOT, 'helpers/quickbooks/books'));
        qb = await books.accounts();
    } catch (e) {
        console.log(`\nCould not read QuickBooks: ${(e && e.message) || e}`);
        console.log('This script only does its job on the VM, where QuickBooks is connected.');
        console.log('Until it has run there, treat every statement built on this chart as');
        console.log('"Jarvis\'s view", not "the same numbers QuickBooks would give".\n');
        process.exit(2);
    }

    const qbRows = (Array.isArray(qb) ? qb : (qb && qb.accounts) || []);
    console.log(`QuickBooks chart: ${qbRows.length} accounts.\n`);

    // ── matched by name ──────────────────────────────────────────────────
    // Name is the only thing the two charts share — her QuickBooks codes are
    // its own. A loose match on purpose: "Bank Charges" and "Bank charges"
    // are the same account and should not be reported as two gaps.
    const qbByName = new Map(qbRows.map((a) => [norm(a.name), a]));
    const matched = [];
    const missingInQb = [];

    for (const a of C.ACCOUNTS) {
        const hit = qbByName.get(norm(a.name));
        if (!hit) { missingInQb.push(a); continue; }
        const qbType = QB_TYPE[norm(hit.type)] || null;
        matched.push({ ours: a, theirs: hit, qbType, agrees: qbType === a.type });
    }

    const disagree = matched.filter((m) => !m.agrees);
    console.log(`MATCHED BY NAME: ${matched.length}`);
    if (disagree.length) {
        console.log(`\n  TYPE DISAGREEMENTS — ${disagree.length}. These matter most: an account on`);
        console.log('  the wrong statement is an error that still balances.');
        for (const m of disagree) {
            console.log(`    ${m.ours.code} ${m.ours.name}`);
            console.log(`        Jarvis says ${m.ours.type}; QuickBooks says ${m.theirs.type}`
                + `${m.qbType ? ` (${m.qbType})` : ' — a type this script does not recognise'}`);
        }
    } else {
        console.log('  and every matched account agrees on its type.');
    }

    if (missingInQb.length) {
        console.log(`\nIN JARVIS, NOT FOUND IN QUICKBOOKS — ${missingInQb.length}`);
        console.log('  Either her books call them something else, or they genuinely do not');
        console.log('  exist there. The inter-company pair is expected to be missing until');
        console.log('  AAA Investment is set up properly.');
        for (const a of missingInQb) console.log(`    ${a.code} ${a.name} (${a.type})`);
    }

    // ── theirs with a balance that we have nowhere to put ────────────────
    // Only accounts carrying money. A 377-account chart has a long tail of
    // empty ones, and listing those would bury the handful that matter.
    const ourNames = new Set(C.ACCOUNTS.map((a) => norm(a.name)));
    const theirsWithMoney = qbRows
        .filter((a) => !ourNames.has(norm(a.name)) && Math.abs(Number(a.balance) || 0) > 0.005)
        .sort((a, b) => Math.abs(Number(b.balance) || 0) - Math.abs(Number(a.balance) || 0));

    if (theirsWithMoney.length) {
        console.log(`\nIN QUICKBOOKS WITH A BALANCE, NOT IN JARVIS — ${theirsWithMoney.length}`);
        console.log('  THIS IS THE LIST THAT MATTERS. Every one of these holds money that a');
        console.log('  Jarvis statement currently has no line for.');
        for (const a of theirsWithMoney.slice(0, 40)) {
            const amt = (Number(a.balance) || 0).toLocaleString('en-US',
                { style: 'currency', currency: 'USD' });
            console.log(`    ${amt.padStart(16)}  ${a.name}  [${a.type}]`);
        }
        if (theirsWithMoney.length > 40) console.log(`    … and ${theirsWithMoney.length - 40} more.`);
    } else {
        console.log('\nNothing in QuickBooks carries a balance that Jarvis has no line for.');
    }

    // ── her expense categories, which are free text ──────────────────────
    if (WANT_CATEGORIES) {
        try {
            const { loadJson } = require(path.join(ROOT, 'helpers/json'));
            const cfg = require(path.join(ROOT, 'config'));
            const rows = loadJson(cfg.EXPENSES_FILE, []);
            const cats = (Array.isArray(rows) ? rows : []).map((r) => r && r.category);
            const un = C.unmappedCategories(cats);
            console.log(`\nEXPENSE CATEGORIES — ${rows.length} rows`);
            if (!un.length) console.log('  every category she has typed has an account.');
            else {
                console.log(`  ${un.length} categor${un.length === 1 ? 'y has' : 'ies have'} no account.`);
                console.log('  These are not errors — they are accounts the chart is missing.');
                for (const u of un) console.log(`    ${String(u.count).padStart(5)}×  ${u.category}`);
            }
        } catch (e) {
            console.log(`\nCould not audit categories: ${(e && e.message) || e}`);
        }
    } else {
        console.log('\nRun with --categories to also audit the expense categories she has typed.');
    }

    // Exit code is the honest summary: non-zero while the two charts
    // disagree about anything that carries money.
    const bad = disagree.length + theirsWithMoney.length;
    console.log(bad
        ? `\n${bad} thing(s) to settle before this chart can be called hers.\n`
        : '\nThe two charts agree on everything that carries money.\n');
    process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
