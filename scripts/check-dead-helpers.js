#!/usr/bin/env node
// ── scripts/check-dead-helpers.js — a helper nothing calls ────────────────
//
// Apsara, 2026-10-05, on bank matching: "My biggest problem is matching
// only. I have been facing difficuleties in matching this."
//
// ── THE THING THIS WOULD HAVE CAUGHT ON DAY ONE ──────────────────────────
// helpers/reconcile.js was written on 3 September. 212 lines, a careful
// header, tests/reconcile.js green with 41 checks — and
// `require('helpers/reconcile')` appears in exactly ONE place in the repo:
// its own test. No route, no screen, no caller, for a month, while she was
// struggling with the problem it was written to solve.
//
// scripts/check-route-reach.js catches the neighbouring disease — a guarded
// mutating route with no button. It cannot catch this one, because there is
// no route to notice. A helper dies one step earlier.
//
// So this is mechanical and unambiguous: every file in helpers/ that no
// PRODUCTION file requires. Tests do not count — a test is the one caller a
// dead helper always has, and counting it is what let reconcile.js look
// alive.
//
// ── TWO WAYS I GOT THIS WRONG BEFORE IT WORKED ───────────────────────────
// Worth keeping, because both failures are quiet ones.
//
//  1. NO COMMENT HANDLING. helpers/bankMatchRoutes.js contains the words
//     require('./reconcile') inside a comment explaining that reconcile.js
//     has no caller. The scan counted that prose as the caller, so the one
//     file this script exists to find was the one file it cleared.
//
//  2. THEN A REGEX BLOCK-COMMENT STRIP. /\*[\s\S]*?\*\// ate roughly six
//     thousand lines of api.js — a regex literal or string containing */
//     closed the match early — and the run confidently reported bolPdf,
//     loadTruckerBill and vendorFromText as dead when all three are
//     required in api.js. That is the worse failure of the two: it invents
//     dead code AND hides real dead code in the same pass, so the output
//     looks like a result.
//
// Hence: drop lines that are ENTIRELY a comment and touch nothing else.
// The comments here are banner-style // lines, which is exactly the false
// positive that matters, and no line of real code is ever discarded.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── KNOWN AND DELIBERATE ─────────────────────────────────────────────────
// A helper with no require() ON PURPOSE. Each needs a reason, not just an
// entry — an allowlist nobody has to justify is how a check becomes a rubber
// stamp. Same rule as check-route-reach.js's BY_DESIGN.
const BY_DESIGN = {
    // 'something.js': 'run as its own process by pm2, never required',
};

const SKIP_DIRS = /(^|[\\/])(node_modules|\.git|\.wwebjs_cache|\.wwebjs_auth|outputs|data)([\\/]|$)/;
const SKIP_REL = [
    // The mutation sidecar holds COPIES of helper source and file names, so
    // counting it would mark every mutated helper as alive.
    path.join('scripts', 'mutate.js'),
];

// Lines that are entirely a comment. Nothing else is removed.
const codeOnly = (t) => t.split('\n')
    .filter((ln) => !/^\s*(\/\/|\*|\/\*)/.test(ln))
    .join('\n');

function productionFiles() {
    const out = [];
    const walk = (dir) => {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            const rel = path.relative(ROOT, full);
            if (SKIP_DIRS.test(rel)) continue;
            if (e.isDirectory()) { walk(full); continue; }
            if (!/\.(js|html)$/.test(e.name)) continue;
            // TESTS DO NOT COUNT. This is the whole point: a dead helper's
            // only caller is its test, and counting it hides the death.
            if (rel === 'tests' || rel.startsWith('tests' + path.sep)) continue;
            if (SKIP_REL.includes(rel)) continue;
            out.push(full);
        }
    };
    walk(ROOT);
    return out;
}

// Every module name that appears as a string literal inside a require().
function requiredNames(files) {
    const names = new Set();
    for (const f of files) {
        let src = '';
        try { src = codeOnly(fs.readFileSync(f, 'utf8')); } catch (e) { continue; }
        for (const m of src.matchAll(/require\(([^)]*)\)/g)) {
            for (const lit of (m[1].match(/['"`]([^'"`]+)['"`]/g) || [])) {
                const v = lit.slice(1, -1);
                names.add(v.split('/').pop().replace(/\.js$/, ''));
            }
        }
    }
    return names;
}

function deadHelpers() {
    const files = productionFiles();
    const required = requiredNames(files);
    const dead = [];
    let helpers = [];
    try { helpers = fs.readdirSync(path.join(ROOT, 'helpers')); } catch (e) { helpers = []; }
    for (const h of helpers.sort()) {
        if (!h.endsWith('.js')) continue;
        if (BY_DESIGN[h]) continue;
        const base = h.replace(/\.js$/, '');
        if (required.has(base)) continue;
        // Does a test require it? That is the shape worth naming: written,
        // tested, and unreachable — as opposed to simply abandoned.
        let tested = false;
        try {
            for (const t of fs.readdirSync(path.join(ROOT, 'tests'))) {
                if (!t.endsWith('.js')) continue;
                const s = fs.readFileSync(path.join(ROOT, 'tests', t), 'utf8');
                if (new RegExp(`['"\`][^'"\`]*(^|/)${base}['"\`]`).test(s)
                    || s.includes(`helpers/${base}'`) || s.includes(`helpers/${base}"`)) { tested = true; break; }
            }
        } catch (e) { /* no tests dir */ }
        dead.push({ file: 'helpers/' + h, tested });
    }
    return { dead, scanned: files.length, required: required.size };
}

if (require.main === module) {
    const { dead, scanned } = deadHelpers();
    console.log(`\nDEAD HELPERS — ${scanned} production files scanned`
        + ` · ${Object.keys(BY_DESIGN).length} allowed by design\n`);
    if (!dead.length) {
        console.log('  Every helper has a production caller.\n');
        process.exit(0);
    }
    console.log(`  ${dead.length} HELPER(S) NO PRODUCTION FILE REQUIRES\n`);
    console.log('  Each of these is work that cannot run. Either the caller is');
    console.log('  missing, or the file is dead and should go.\n');
    for (const d of dead) {
        console.log(`    ${d.file}`
            + (d.tested ? '   — has its own test, which is the only thing keeping it green' : '   — not even a test'));
    }
    console.log('\n  If one is deliberate, add it to BY_DESIGN with the reason.\n');
    process.exit(1);
}

module.exports = { deadHelpers, codeOnly, productionFiles, requiredNames, BY_DESIGN };
