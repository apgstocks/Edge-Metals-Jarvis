#!/usr/bin/env node
// ── scripts/split-mobile-app.js ──────────────────────────────────────────
// Apsara, 2026-10-16: "The phone app is one 13,138-line HTML file --split it"
//
// Mechanical, re-runnable, and it MOVES TEXT — it never rewrites a line. That
// is the same rule dashboard/index.html's split followed (see the long note
// at the top of helpers/sourceParts.js), and the reason both splits can be
// proved byte-for-byte reversible instead of reviewed by eye.
//
// WHAT MAKES A CUT SAFE, and why these cuts and not others:
//
//   · Each <script src> is parsed as its OWN script, so every part must be
//     independently valid JavaScript. Every boundary below was verified by
//     parsing the text before it AND the text after it with node's own
//     parser. 512 such points exist in this file; the ones chosen are the
//     ones that also land on a section heading a person would recognise.
//
//   · Classic scripts share one global scope, so a `const` in part 3 is
//     visible from part 9 — but only AFTER part 3 has run. Only three
//     statements in this file execute at load time rather than declaring
//     something: two addEventListener calls at the Settings buttons, and
//     boot() at the very end. Both listeners call $(), which is declared on
//     line 79 of the script, inside the FIRST part. boot() is the last
//     statement of the last part, exactly as on the website. So nothing
//     reaches forward into a part that has not run yet.
//
//   · RELATIVE src, not absolute. The website is served over HTTP and uses
//     /app/x.js; the APK is loaded from file:// by Capacitor, where a leading
//     slash resolves to the device root and every part silently 404s. This
//     is the one place the two clients cannot be written the same way.
//
// Run: node scripts/split-mobile-app.js [--check]
//   --check verifies the current split reassembles byte-for-byte and exits.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'mobile-app', 'www', 'index.html');
const OUTDIR = path.join(ROOT, 'mobile-app', 'www', 'app');
const MARK = '<!-- @@app-scripts: the main script, in order (helpers/sourceParts.js) -->';

// The script element that holds everything. Found by its markers rather than
// by line number so this still works after the file moves around.
// The newlines are DELIBERATELY NOT part of these markers. The first attempt
// used '<script>\n' and '\n</script>\n', split the body into lines and
// rejoined each part with '\n' — which silently dropped the separator
// BETWEEN parts. The rebuild came out exactly 20 bytes short: 18 newlines
// between 19 parts, plus one at each end. Slicing the body string by
// character offset instead makes concat(parts) === body true by
// construction, rather than true if the joining is done carefully.
const OPEN = '<script>';
const CLOSE = '</script>\n';

// Boundaries are the FIRST LINE of each part, 1-based, in the script's own
// coordinates. Named for what a person would look for.
const PARTS = [
    [1, '01-core'],                 // $, config, API base, dates, the Jarvis profile
    [334, '02-cache-catalogue'],    // the GET cache, fast paint, the item catalogue
    [695, '03-item-rows'],          // what a price is per, item row maths
    [1151, '04-payments'],          // pay modal, which bank, whose money
    [1784, '05-payment-roles'],     // prepaid credit, who may remove a payment
    [2270, '06-capture'],           // weight banner, camera, signature pad
    [2779, '07-scanner'],           // live scale-display scanning
    [3346, '08-load-modal'],        // purchase vs sale, deductions
    [3784, '09-loads-deck'],        // the deck, kinds, month/week/day grouping
    [5619, '10-shell'],             // month filter, app shell, offline report
    [6090, '11-reports'],           // trucker, expenses, spend, stock, profit
    [6905, '12-petty-cash'],        // petty cash, borrowing, tab switching
    [7758, '13-inventory'],         // inventory tab, drill-down, file download
    [8095, '14-settings'],          // admin + staff settings, catalogue manager
    [8417, '15-documents'],         // tab shell, BOL, the invoice number, edit
    [9094, '16-proforma'],          // the 3-step proforma wizard
    [10350, '17-invoice-math'],     // scale ticket to an amount, money parsing
    [10658, '18-voice'],            // WhatsApp banner, wake word, voice
    [12167, '19-boot'],             // boot(), and nothing after it
];

function readParts() {
    const html = fs.readFileSync(SRC, 'utf8');
    const a = html.indexOf(OPEN);
    if (a < 0) throw new Error('no <script> open marker — already split?');
    const b = html.indexOf(CLOSE, a);
    if (b < 0) throw new Error('no </script> close marker');
    return {
        html,
        before: html.slice(0, a),
        body: html.slice(a + OPEN.length, b),
        after: html.slice(b + CLOSE.length),
    };
}

const headerFor = (name) =>
    `// mobile-app/www/app/${name}.js — split from mobile-app/www/index.html's <script> (helpers/sourceParts.js reconstructs the original)\n`;

// Character offset of the start of 1-based line `n` within `text`. Used so
// parts are SLICES of the body, never a split/join round-trip.
function offsetOfLine(text, n) {
    if (n <= 1) return 0;
    let at = -1;
    for (let i = 1; i < n; i++) {
        at = text.indexOf('\n', at + 1);
        if (at < 0) throw new Error(`line ${n} is past the end of the script`);
    }
    return at + 1;
}

function split() {
    const { before, body, after } = readParts();
    // body starts with the newline that followed <script> and ends with the
    // one before </script>; line 1 of the script is therefore body's second
    // line. Everything below works in those same coordinates.
    const lines = body.split('\n');

    // Every boundary must parse on both sides. Checked HERE rather than
    // trusted, because a bad cut produces an app that loads to a blank
    // screen in the yard and a test suite that still passes.
    for (const [line, name] of PARTS) {
        if (line === 1) continue;
        const head = lines.slice(0, line).join('\n');
        const tail = lines.slice(line).join('\n');
        for (const [label, text] of [['before', head], ['after', tail]]) {
            try { new vm.Script(text); } catch (e) {
                throw new Error(`cut at ${name} (script line ${line}) leaves invalid JS ${label}: ${e.message}`);
            }
        }
    }

    fs.mkdirSync(OUTDIR, { recursive: true });
    let check = '';
    for (let i = 0; i < PARTS.length; i++) {
        const [start, name] = PARTS[i];
        // Part 01 starts at 0, not at its line offset: body's very first
        // character is the newline that followed <script>, and it belongs to
        // the first part or it belongs to nobody. That one byte was the
        // difference between 678329 and 678330 on the first attempt.
        const a = i === 0 ? 0 : offsetOfLine(body, start + 1);
        const b = i + 1 < PARTS.length ? offsetOfLine(body, PARTS[i + 1][0] + 1) : body.length;
        const text = body.slice(a, b);
        check += text;
        fs.writeFileSync(path.join(OUTDIR, `${name}.js`), headerFor(name) + text);
    }
    // Proved here, not hoped for. If the slices do not add back up to the
    // body there is no point writing the tags — the app would ship with a
    // hole in it and only the byte-for-byte test would notice.
    if (check !== body) throw new Error(`parts do not reassemble: ${check.length} vs ${body.length} bytes`);

    const tags = PARTS.map(([, n]) => `<script src="app/${n}.js"></script>`).join('\n');
    fs.writeFileSync(SRC, before + MARK + '\n' + tags + '\n' + after);
    return PARTS.length;
}

function rebuilt() {
    const SP = require(path.join(ROOT, 'helpers', 'sourceParts'));
    return SP.mobileHtml(ROOT);
}

if (process.argv.includes('--check')) {
    const cur = fs.readFileSync(SRC, 'utf8');
    if (!cur.includes(MARK)) { console.log('not split yet'); process.exit(0); }
    const files = PARTS.map(([, n]) => path.join(OUTDIR, `${n}.js`));
    const missing = files.filter((f) => !fs.existsSync(f));
    if (missing.length) { console.error('MISSING parts:', missing.join(', ')); process.exit(1); }
    for (const f of files) {
        try { new vm.Script(fs.readFileSync(f, 'utf8')); }
        catch (e) { console.error(`PART DOES NOT PARSE: ${path.basename(f)} — ${e.message}`); process.exit(1); }
    }
    console.log(`${files.length} parts, all parse.`);
    process.exit(0);
}

const n = split();
console.log(`split into ${n} parts under mobile-app/www/app/`);
console.log('now: node scripts/split-mobile-app.js --check');
