// ── helpers/sourceParts.js — the two big files, put back together ─────────
//
// Apsara, 2026-10-10: "Split the two giant files. dashboard/index.html
// (~15,500 lines) and api.js (~9,700 lines) — split and commit."
//
// They were split by MOVING text, never by rewriting it:
//
//   · dashboard/index.html's main <script> (14,800 lines) is now
//     dashboard/app/01-…15-*.js, loaded in the same order by plain
//     <script src> tags. Each part is cut at a top-level statement, so the
//     only thing that changed is which file a line lives in. (Checked before
//     cutting: nothing that runs while the page loads calls a function from a
//     LATER part — boot(), the one call that reaches everything, is the last
//     line of the last part.)
//
//   · api.js's routes are now routes/*.js, each one a mount(app, ctx) that
//     api.js calls at the SAME POSITION the routes used to sit, so routes and
//     middleware register in exactly the order they did before. The login
//     gate, CORS, health and the admin/staff gates stay in api.js where a
//     reviewer expects them.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
// About a hundred tests read these two files as TEXT — to render the page in
// jsdom, or to assert a property of the source. Pointing each of them at the
// right part would mean rewriting a hundred checks, and a check rewritten in
// a hurry is how a property quietly stops being tested (CLAUDE.md §2).
//
// So instead this rebuilds the ORIGINAL text from the parts. The split is
// mechanical enough that the rebuild is byte-for-byte what the single file
// was — tests/source-parts.js asserts it, and asserts that every part is
// wired in — so every one of those tests keeps testing exactly what it tested
// before, while the server and the browser run the split files for real.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── dashboard/index.html ─────────────────────────────────────────────────
// The parts are listed by the page itself, after one marker comment. A part
// file's FIRST LINE is its own header; everything after it is the original
// text, so the header is dropped when joining.
const APP_MARK = '<!-- @@app-scripts: the main script, in order (helpers/sourceParts.js) -->';
const APP_TAG = /^<script src="\/app\/([\w-]+\.js)"><\/script>$/;

function appParts(html) {
    const at = html.indexOf(APP_MARK + '\n');
    if (at < 0) return null;
    const lines = html.slice(at + APP_MARK.length + 1).split('\n');
    const files = [];
    for (const l of lines) {
        const m = l.match(APP_TAG);
        if (!m) break;
        files.push(m[1]);
    }
    const blockLen = APP_MARK.length + 1 + files.reduce((t, f) => t + `<script src="/app/${f}"></script>`.length + 1, 0);
    return { at, blockLen, files };
}

function stripHeader(text) {
    const nl = text.indexOf('\n');
    return nl < 0 ? '' : text.slice(nl + 1);
}

function indexHtml(root = ROOT) {
    const html = fs.readFileSync(path.join(root, 'dashboard', 'index.html'), 'utf8');
    const p = appParts(html);
    if (!p) return html;   // not split (or an old checkout): it IS the original
    const body = p.files.map((f) => stripHeader(fs.readFileSync(path.join(root, 'dashboard', 'app', f), 'utf8'))).join('');
    // The block ends with a newline after the last tag; the original
    // `</script>` was followed by that same newline.
    return html.slice(0, p.at) + '<script>' + body + '</script>\n' + html.slice(p.at + p.blockLen);
}

// ── api.js ───────────────────────────────────────────────────────────────
// api.js holds one marked block that builds `ctx` (dropped when rebuilding)
// and one marked line per routes/ file (replaced by that file's moved text,
// which sits between two markers inside it).
const CTX_START = '    // @@parts:ctx-start\n';
const CTX_END = '    // @@parts:ctx-end\n';
const MOUNT_LINE = /^ {4}Object\.assign\(ctx, require\('\.\/routes\/([\w-]+)'\)\(app, ctx\)\); \/\/ @@part\n/m;
const CHUNK_START = '// @@chunk-start\n';
const CHUNK_END = '// @@chunk-end\n';

function routeChunk(file, root = ROOT) {
    const t = fs.readFileSync(path.join(root, 'routes', file), 'utf8');
    const a = t.indexOf(CHUNK_START), b = t.indexOf(CHUNK_END);
    if (a < 0 || b < a) throw new Error(`routes/${file} has no @@chunk markers`);
    return t.slice(a + CHUNK_START.length, b);
}

function routeFiles(src) {
    return [...src.matchAll(new RegExp(MOUNT_LINE.source, 'gm'))].map((m) => m[1] + '.js');
}

function apiSource(root = ROOT) {
    let src = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
    const a = src.indexOf(CTX_START), b = src.indexOf(CTX_END);
    if (a >= 0 && b > a) src = src.slice(0, a) + src.slice(b + CTX_END.length);
    let m;
    while ((m = src.match(MOUNT_LINE))) {
        src = src.slice(0, m.index) + routeChunk(m[1] + '.js', root) + src.slice(m.index + m[0].length);
    }
    return src;
}

module.exports = { indexHtml, apiSource, appParts, routeFiles, routeChunk, APP_MARK, ROOT };
