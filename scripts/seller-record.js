#!/usr/bin/env node
// ── scripts/seller-record.js ──────────────────────────────────────────────
// What California makes Edge Yard record about every purchase, and what
// Jarvis actually holds.
//
//   node scripts/seller-record.js                     the current year
//   node scripts/seller-record.js 2026-01-01 2026-10-31
//
// Run it where data/loads.json is, which is the VM. READ ONLY: it opens the
// loads store and the law register and writes nothing.
//
// It will say that NOTHING can be called complete until a person has
// confirmed each statute. That is not a bug and not hedging — see the header
// of helpers/sellerRecord.js. To record a confirmation:
//
//   node -e "require('./helpers/sellerRecord').verify({id:'ca-21606',by:'<name>'})"
const path = require('path');
const S = require(path.join(__dirname, '..', 'helpers', 'sellerRecord'));

const argv = process.argv.slice(2);
const year = new Date().getFullYear();
const from = argv[0] || `${year}-01-01`;
const to = argv[1] || `${year}-12-31`;

const money = (n) => (n == null ? '—' : '$' + Number(n).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

const r = S.report({ from, to });

console.log('');
console.log('  EDGE YARD — CALIFORNIA JUNK DEALER RECORD');
console.log('  ' + r.entity_name);
console.log('  ' + from + '  to  ' + to + '      (read ' + r.asOf + ')');
console.log('  ' + '─'.repeat(70));
console.log('  ' + r.headline);

if (r.unverified.length) {
    console.log('');
    console.log('  NOBODY HAS CONFIRMED THESE RULES, so no record below can be called');
    console.log('  complete. Confirm each one, then re-run.');
    for (const u of r.unverified) {
        const why = u.why === 'disputed' ? 'the source found was too old to rely on'
            : u.why === 'expired' ? 'last confirmed too long ago'
            : u.why === 'never_verified' ? 'never confirmed by anyone'
            : u.why;
        console.log(`    · ${u.title}`);
        console.log(`        ${why}`);
        if (u.source) console.log(`        ${u.source}`);
    }
}

if (r.loads) {
    const kinds = r.loadsChecked.reduce((a, c) => {
        a[c.material.kind] = (a[c.material.kind] || 0) + 1; return a;
    }, {});
    console.log('');
    console.log('  METAL: ' + Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')
        + '   (unknown is treated as NONFERROUS — never assumed ferrous)');

    const show = (title, rows, countKey, tail) => {
        if (!rows.length) return;
        console.log('');
        console.log('  ' + title);
        console.log('  ' + '─'.repeat(70));
        for (const g of rows) {
            console.log(`  ${String(g[countKey]).padStart(4)} load(s)  ${g.cite}`);
            console.log(`             ${g.what}`);
            if (tail && g[tail]) console.log(`             → ${g[tail]}`);
            if (g.caveat) console.log(`             ! ${g.caveat}`);
        }
    };

    show('NOTHING IN JARVIS CAN HOLD THIS — somebody has to build a field',
        r.buildable, 'not_captured', 'needs');
    show('THE FIELD EXISTS AND IS EMPTY — this one is data entry',
        r.typeable, 'missing');

    const held = r.gaps.filter((g) => g.not_captured === 0 && g.missing === 0);
    if (held.length) {
        console.log('');
        console.log('  ALREADY ON FILE');
        console.log('  ' + '─'.repeat(70));
        for (const g of held) console.log(`  ${String(g.present).padStart(4)} load(s)  ${g.cite}  ${g.what}`);
    }

    const total = r.loadsChecked.reduce((s, c) => s + (Number(
        (c.fields.find((f) => f.id === 'amount_paid') || {}).value) || 0), 0);
    console.log('');
    console.log('  ' + r.loads + ' purchase(s), ' + money(total) + ' paid, over this period.');
}
console.log('');
