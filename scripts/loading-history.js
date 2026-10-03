#!/usr/bin/env node
// What does a container of each material ACTUALLY weigh, per her own invoices?
//
// Apsara, 2026-10-03: "by default if its a single thing, its quantity is
// 21 MT. All these would be saved in jarvis memory."
//
// 21 MT is right for auto cast -- she said so on 2026-08-24 and the hardcoded
// table uses it. Whether it is right for EVERY material is a question her
// invoice sheet can answer, and guessing it wrong puts a wrong tonnage on a
// priced document. One container of alloy wheels is not one container of cast.
const sheet = require('../helpers/invoiceSheet');
const { normDesc } = require('../helpers/ratePlausibility');
const toNum = (v) => { const n = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };
// THE SHEET MIXES UNITS. Rows read 21.881 and 48022 in the same column: the
// first is metric tonnes, the second pounds. No container moves 200 MT, so
// anything above that is pounds. Getting this wrong is a 2204x error -- the
// same mistake the rate_basis enum was making this morning.
const MT_PER_LB = 1 / 2204.62;
const toMt = (v) => { const n = toNum(v); if (n == null) return null; return n > 200 ? n * MT_PER_LB : n; };

(async () => {
    const { headers, rows } = await sheet.fetchRawSheet();
    const cm = sheet.buildColumnMap(headers);
    if (cm.weight === -1) { console.error('No weight column in the sheet.'); process.exit(1); }
    // Per CONTAINER per material: a container can carry two materials (the
    // Al/steel combo pair she described), so summing by material alone would
    // wrongly report 22 MT for a pair-loaded box.
    // PER CONTAINER, NOT PER ROW. One container is often invoiced as several
    // lines, so a per-row median answers "how big is a line", which is not the
    // question. And a container carrying two materials (her Al/steel combo
    // pair) tells us nothing about a SINGLE-material load, so those are
    // excluded from the default entirely.
    const cell = new Map();           // container|material -> MT
    const matsIn = new Map();         // container -> Set(material)
    const label = new Map();
    for (const r of rows) {
        const d = sheet.rowToDict(r, cm);
        const key = normDesc(d.item_desc);
        const w = toMt(d.weight);
        const cont = String(d.container_no || '').trim();
        if (!key || !w || !cont) continue;
        label.set(key, String(d.item_desc || '').trim());
        const ck = cont + '|' + key;
        cell.set(ck, (cell.get(ck) || 0) + w);
        if (!matsIn.has(cont)) matsIn.set(cont, new Set());
        matsIn.get(cont).add(key);
    }
    const solo = new Map();           // material -> [MT per container, alone]
    for (const [ck, mt] of cell) {
        const [cont, key] = ck.split('|');
        if ((matsIn.get(cont) || new Set()).size !== 1) continue;
        if (!solo.has(key)) solo.set(key, []);
        solo.get(key).push(Math.round(mt * 1000) / 1000);
    }
    const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const out = [...solo.entries()].map(([k, w]) => ({
        k, desc: label.get(k) || k, n: w.length, median: med(w),
        min: Math.min(...w), max: Math.max(...w), conts: w.length, aloneShare: 1,
    })).filter((r) => r.n >= 2).sort((a, b) => b.n - a.n);

    console.log(`\nCONTAINER LOADING FROM HER OWN INVOICES — ${rows.length} rows, ${out.length} materials with 2+ lines`);
    console.log('='.repeat(84));
    console.log('  containers   median MT     range MT          material');
    for (const r of out.slice(0, 30)) {
        console.log(`  ${String(r.n).padStart(10)}   ${r.median.toFixed(2).padStart(9)}   ${r.min.toFixed(1).padStart(6)}-${r.max.toFixed(1).padEnd(8)}   ${r.desc.slice(0, 34)}`);
    }
    const wheels = out.filter((r) => /WHEEL/.test(r.k));
    console.log('\nWHAT SHE ASKED ABOUT — anything matching "wheel":');
    if (!wheels.length) console.log('  nothing. No wheel line has ever been invoiced with a weight.');
    for (const r of wheels) console.log(`  ${r.desc.padEnd(32)} median ${r.median.toFixed(2)} MT over ${r.n} single-material container(s)  [${r.min.toFixed(1)}-${r.max.toFixed(1)}]`);
    const cast = out.filter((r) => /AUTOCAST/.test(r.k));
    console.log('\nTHE CONTROL — auto cast, which she said loads at 21 MT:');
    for (const r of cast) console.log(`  ${r.desc.padEnd(32)} median ${r.median.toFixed(2)} MT over ${r.n} single-material container(s)  [${r.min.toFixed(1)}-${r.max.toFixed(1)}]`);
})().catch((e) => { console.error(e.message); process.exit(1); });
