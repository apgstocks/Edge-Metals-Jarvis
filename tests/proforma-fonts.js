// ── tests/proforma-fonts.js ──────────────────────────────────────────────
// Apsara, 2026-10-20: "TIMEOUT AFTER 30000 SECONDS IN PROFORMA".
//
// ── THE BUG ──────────────────────────────────────────────────────────────
// helpers/proformaPdf.js embedded seven fonts with seven
// `.replace('__FONT_X__', data)` calls. String.prototype.replace with a
// STRING pattern replaces ONLY THE FIRST MATCH, and
// assets/proforma-dc2/template.html uses two of the tokens twice:
//
//     __FONT_POPPINS_BOLD__     weight 800 and weight 700
//     __FONT_DMSANS_REGULAR__   twice
//
// so the second of each shipped as a literal src: url('__FONT_POPPINS_BOLD__').
// setContent() gives the page no base URL, so Chromium issued two font
// requests that never completed — and this renderer waits on 'networkidle0',
// which needs ZERO requests in flight for 500ms. Network idle was
// unreachable, and puppeteer threw at its 30-second default. Every proforma.
//
// Two defects, one visible: Poppins 700 and DM Sans 400 had ALSO never
// rendered, falling back silently to another face. Which is why looking at a
// finished PDF never found it.
//
// ── WHY THIS FILE IS NOT "CHECK THE FONTS ARE THERE" ─────────────────────
// A test that asserted the seven tokens get substituted would have PASSED
// against the broken code: six of the seven were fine, and the failure was a
// SECOND occurrence. So the properties asserted here are the ones that
// actually break:
//
//   A  the template really does repeat tokens — or this file guards nothing
//   B  nothing is left unsubstituted, however many times it appears
//   C  the document asks the network for NOTHING (what networkidle0 needs)
//   D  a dangling token fails at build time instead of hanging for 30s
//   E  the invoice and the BOL are unaffected

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

process.env.JARVIS_TEST = '1';
const ROOT = path.join(__dirname, '..');
const TPL = path.join(ROOT, 'assets', 'proforma-dc2', 'template.html');

const { buildProformaDc2Html, assertFontsEmbedded, embedFonts, FONTS } = require(path.join(ROOT, 'helpers/proformaPdf'));
const sample = {
    inv_no: 'TEST-1', consignee: 'Test Buyer', trade_terms: 'CIF',
    containers: [{ items: [{ description: 'Alternators', qty: 1, rate: 1 }] }],
};

// ── BUILD FAILURES ARE A RED, NOT A CRASH ────────────────────────────────
// loadTemplate now THROWS when a token is left unsubstituted, which is the
// right behaviour for the app and the wrong behaviour for a test file that
// calls it at the top of three sections: the mutation that restores the
// original first-match .replace() made this file exit with a stack trace,
// and run-tests.js scores that CRASHED. A permanent crash reads exactly like
// a permanent red — it trains people to skim the summary.
//
// So the throw is caught and turned into a legible failure that names the
// cause, and the remaining sections still run.
let buildError = null;
const buildHtml = () => {
    try { return buildProformaDc2Html(sample).html; }
    catch (e) { buildError = e; return ''; }
};

// ══════════════════════════════════════════════════════════════════════════
section('A — no token is embedded twice, and repeats are handled anyway');
{
    // ── REWRITTEN 2026-10-20 ─────────────────────────────────────────────
    // This section used to REQUIRE the template to repeat a token, because
    // the duplicate was what exposed first-match .replace(). The template has
    // since been fixed: Poppins-Bold and DMSans-Regular were each declared
    // twice, every @font-face carries its own copy of the base64, and that
    // was 276 KB of duplicate payload in a 1,304 KB document on a VM that
    // times out. They are now single faces with weight ranges.
    //
    // So the property flipped. What matters now is BOTH of:
    //   · the template wastes no payload (no token appears twice)
    //   · the substitution would still handle a repeat if one came back
    // and the second is proved on a CRAFTED input, so it does not depend on
    // the template keeping a flaw for the test's benefit.
    const tpl = fs.readFileSync(TPL, 'utf8');
    const counts = {};
    for (const m of tpl.match(/__FONT_[A-Z0-9_]+__/g) || []) counts[m] = (counts[m] || 0) + 1;
    const repeated = Object.entries(counts).filter(([, n]) => n > 1);

    ck('the template uses font tokens at all', Object.keys(counts).length > 0, JSON.stringify(counts));
    ck('no token appears twice — no duplicate base64', repeated.length === 0,
       JSON.stringify(repeated) + ' — each @font-face embeds its own copy, so a '
       + 'repeated token is that font\'s whole payload again');

    // INCLUDING IN THE COMMENTS. The first draft of the template comment
    // explaining this bug quoted a token by name, and substitution runs over
    // the whole file — so it embedded 203 KB of base64 into a CSS comment.
    const commentTokens = (tpl.match(/\/\*[\s\S]*?\*\//g) || [])
        .join('\n').match(/__FONT_[A-Z0-9_]+__/g) || [];
    ck('  and no token is named inside a comment', commentTokens.length === 0,
       commentTokens.join(', ') + ' — substitution does not skip comments');

    // ── THE REPEAT DEFENCE, ON A CRAFTED TEMPLATE ───────────────────────
    const token = FONTS[0][0];
    const out = embedFonts(`x ${token} y ${token} z`, () => 'EMBEDDED');
    ck('a repeated token is substituted EVERY time', out === 'x EMBEDDED y EMBEDDED z', out);
    ck('  so first-match .replace() cannot creep back unnoticed',
       !out.includes(token), out);
    ck('every font in FONTS is substituted', FONTS.every(([t]) =>
        !embedFonts(`a ${t} b`, () => 'E').includes(t)),
       'a token in the table that the loop misses is a dangling font request');
}

// ══════════════════════════════════════════════════════════════════════════
section('B — nothing ships unsubstituted');
{
    const html = buildHtml();
    ck('the proforma builds at all', !buildError,
       buildError ? buildError.message.slice(0, 200) : '');
    const left = html.match(/__FONT_[A-Z0-9_]+__/g) || [];
    ck('no font token survives into the document', left.length === 0,
       [...new Set(left)].join(', '));

    const faces = html.match(/@font-face[^}]*}/g) || [];
    ck('every @font-face is present', faces.length >= 7, String(faces.length));
    const notEmbedded = faces.filter((f) => !/url\(\s*'data:font/.test(f));
    ck('  and every one is backed by embedded font data', notEmbedded.length === 0,
       notEmbedded.map((f) => f.replace(/\s+/g, ' ').slice(0, 80)).join(' ;; '));

    // The weights that were silently falling back. Named explicitly: these
    // are the two that were WRONG IN THE PRINTED PDF, not just slow.
    for (const [fam, wt] of [['Poppins', 700], ['DM Sans', 400]]) {
        const face = faces.find((f) => f.includes(`'${fam}'`) && f.includes(`font-weight:${wt}`));
        ck(`${fam} ${wt} now carries real font data`,
           !!face && /url\(\s*'data:font/.test(face),
           face ? face.replace(/\s+/g, ' ').slice(0, 90) : 'face not found');
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('C — the document asks the network for nothing');
{
    // This is the property 'networkidle0' actually depends on, and it is the
    // one worth owning: any remote or relative URL in this document is a
    // request that may never settle, and the renderer waits for silence.
    const html = buildHtml();

    const urls = [];
    const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
    let m; while ((m = re.exec(html))) urls.push(m[2]);
    const remote = urls.filter((u) => !u.startsWith('data:'));
    ck('every url() is a data: URL', remote.length === 0, remote.slice(0, 5).join(', '));

    ck('no <link> stylesheet', !/<link[^>]*rel=["']?stylesheet/i.test(html));
    ck('no external <script src>', !/<script[^>]*src=/i.test(html));
    ck('no http(s) anywhere in the document',
       !/https?:\/\//.test(html), (html.match(/https?:\/\/[^"')\s]+/g) || []).slice(0, 3).join(', '));
    const imgs = html.match(/<img[^>]*>/gi) || [];
    const badImg = imgs.filter((t) => / src=["'](?!data:)/i.test(t));
    ck('every <img> is inline data', badImg.length === 0, badImg.slice(0, 2).join(' ;; '));
}

// ══════════════════════════════════════════════════════════════════════════
section('D — a dangling token fails at BUILD, not after 30 seconds');
{
    // The reason the original bug lived so long is that a missing font looks
    // like a slightly different font. An eighth font added to the template,
    // or a renamed token, must now stop in one second with the name in the
    // message rather than hang in front of a customer.
    // ── EXERCISED, NOT GREPPED ───────────────────────────────────────
    // The first version of this section read the source for the word
    // "unsubstituted" and called it a pass. The mutation harness disabled
    // the throw with `void 0 &&` — leaving the message text intact — and the
    // mutation SURVIVED: the check was shaped like the code instead of like
    // the property. The guard is now an exported function, called here on a
    // crafted input, so turning it off cannot go unnoticed.
    const threw = (html) => {
        try { assertFontsEmbedded(html); return null; }
        catch (e) { return String(e.message || e); }
    };
    const msg = threw("@font-face { src: url('__FONT_POPPINS_BOLD__'); }");
    ck('a leftover token is REFUSED', !!msg,
       'assertFontsEmbedded accepted a document with a dangling font request');
    ck('  and the token is named in the message',
       !!msg && msg.includes('__FONT_POPPINS_BOLD__'), msg || '');
    ck('  and it says what leaving it in costs',
       !!msg && /networkidle0|never resolve/.test(msg), msg || '');
    ck('  every leftover is listed, not just the first',
       (threw("url('__FONT_A__') url('__FONT_B__')") || '').includes('__FONT_B__'),
       threw("url('__FONT_A__') url('__FONT_B__')") || '');
    ck('a clean document passes', threw("url('data:font/ttf;base64,AAA')") === null);

    const src = fs.readFileSync(path.join(ROOT, 'helpers/proformaPdf.js'), 'utf8');
    ck('  and the real build path calls it', /assertFontsEmbedded\(html\);/.test(src),
       'the guard exists but loadTemplate does not use it');
    // The every-occurrence property is asserted in section A, behaviourally,
    // on a crafted template. It used to be grepped for here as
    // /replaceAll\(token, fontFile\(file\)\)/ — which went stale the moment the
    // substitution moved into embedFonts(template, loader), failing on correct
    // code. A check that matches an exact line is a check that breaks when the
    // code is tidied and passes when the code is wrong.
    ck('substitution lives in one injectable function', /function embedFonts\(/.test(src),
       'inline in loadTemplate it cannot be exercised on a crafted input');
    // COMMENT LINES STRIPPED FIRST. The version before this matched the
    // block comment above loadTemplate, which quotes the broken
    // .replace('__FONT_X__', ...) call on purpose — so the check failed on
    // correct code because the file explains its own history. A check that
    // reads prose is not reading the program.
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ck('  via one table rather than seven hand-written calls',
       /const FONTS = \[/.test(code) && !/\.replace\('__FONT_/.test(code),
       'a per-font line is how the eighth font gets forgotten');
}

// ══════════════════════════════════════════════════════════════════════════
section('E — the other documents are untouched');
{
    // helpers/bolPdf.js has the same first-match .replace() shape, and its
    // template was checked: every token appears ONCE, so it is not affected.
    // Asserted rather than remembered, because the day someone repeats a
    // token in the BOL template it inherits this exact bug — and the BOL also
    // waits on networkidle0.
    const bolTpl = path.join(ROOT, 'assets', 'bol', 'template.html');
    if (fs.existsSync(bolTpl)) {
        const tpl = fs.readFileSync(bolTpl, 'utf8');
        const counts = {};
        for (const m of tpl.match(/__FONT_[A-Z0-9_]+__/g) || []) counts[m] = (counts[m] || 0) + 1;
        const dupes = Object.entries(counts).filter(([, n]) => n > 1);
        ck('the BOL template still repeats no token', dupes.length === 0,
           JSON.stringify(dupes) + ' — bolPdf.js uses first-match .replace() and '
           + 'networkidle0, so a repeat there is the same 30s hang');
    } else {
        ck('BOL template located', false, bolTpl + ' not found — the guard above checked nothing');
    }
    const bol = fs.readFileSync(path.join(ROOT, 'helpers/bolPdf.js'), 'utf8');
    ck('  and bolPdf was not quietly changed by this fix',
       /\.replace\('__FONT_DMSANS_REGULAR__'/.test(bol),
       'her report named the proforma; the BOL is a separate decision');
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
