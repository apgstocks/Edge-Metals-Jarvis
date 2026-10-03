#!/usr/bin/env node
// ── scripts/check-route-reach.js ──────────────────────────────────────────
// A PRIVILEGED ROUTE THAT NOTHING CALLS IS A PERMISSION THAT EXISTS ON PAPER.
//
// This has now cost three separate findings, all the same shape: the route is
// written, guarded, audited and correct, and the screen that would press it
// does not exist. Nobody notices, because every test of the route passes and
// every test of the screen passes.
//
//   2026-09-23  A settled load could not be reopened. DELETE /api/payments
//               worked; the ✕ lived inside a modal whose only opener was a
//               Pay button that loadIsPayable had stopped drawing.
//   2026-10-02  #152. /api/qb/create-party existed; the QuickBooks page had
//               no Create button, so a party missing from QuickBooks could
//               only be created by going through "match it" first.
//   2026-10-03  Apsara asked for the Jarvis profile to be able to delete Edge
//               Metals payments. It already could — but DELETE
//               /api/metals-trucking and DELETE /api/sales-settlements had no
//               caller in either client. The permission had been granted on
//               2026-09-16 and was unreachable for two and a half weeks.
//
// Three times is a pattern, and the pattern is invisible to every check that
// exists: scripts/check-action-wiring.js sees intents routed at actions, the
// route tests post to the route directly, and the screen tests render screens
// that do not mention it. So this walks the other way round — from the server's
// guarded routes to whether any client actually calls each one, with the
// METHOD, not just the path.
//
// ── WHY THE METHOD MATTERS, AND WHY THE FIRST VERSION WAS USELESS ─────────
// Matching on the path alone passes for everything. /api/metals-trucking is
// read with GET and written with POST on the same screen, so a DELETE with no
// caller is hidden behind its own siblings — the first version of this check
// reported "0 unreachable" with the button deliberately removed, which is the
// precise definition of a check that does not test what its name says.
//
// The second version matched the method but read the api() call with a regex
// whose tail stopped at the first ')'. api('/api/import/' + encodeURIComponent(
// batch), { method: 'DELETE' }) closes a paren inside its own arguments, so
// the method was never seen and five correct routes were reported broken.
// Five false alarms in a guard is worse than no guard: it gets ignored, and
// then it is noise covering the one real finding.
//
// So the arguments are read by counting parens, quotes and template literals,
// which is what it takes to find where a call actually ends.
//
//   node scripts/check-route-reach.js           # report
//   node scripts/check-route-reach.js --strict  # exit 1 on a regression
//
// Run from the repo root. Reads only; writes nothing.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STRICT = process.argv.includes('--strict');

// ── every client file that could hold an api() call ──────────────────────
// mobile-app/android/**/assets is a BUILD COPY of mobile-app/www. Counting it
// would let a route look reachable because of a stale APK asset — the thing
// being asked is whether the SOURCE calls it.
function clientFiles() {
    const out = [];
    const walk = (p) => {
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
            const q = path.join(p, e.name);
            if (e.isDirectory()) {
                if (!/^(build|node_modules|android|ios)$/.test(e.name)) walk(q);
            } else if (/\.(html|js)$/.test(e.name)) out.push(q);
        }
    };
    for (const d of ['dashboard', 'mobile-app/www']) {
        const abs = path.join(ROOT, d);
        if (fs.existsSync(abs)) walk(abs);
    }
    return out;
}

// ── reading one api( … ) call ────────────────────────────────────────────
// From the '(' after `api`, walk forward tracking depth and string state, and
// stop at the paren that closes it. Anything simpler mis-reads the common
// shape api('/api/x/' + encodeURIComponent(id), { method: 'DELETE' }).
function argsAt(src, openIdx) {
    let depth = 0, i = openIdx, quote = null;
    for (; i < src.length; i += 1) {
        const c = src[i];
        if (quote) {
            if (c === '\\') { i += 1; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
        if (c === '(') depth += 1;
        else if (c === ')') { depth -= 1; if (depth === 0) return src.slice(openIdx + 1, i); }
        // A call left unterminated by the end of a tag is not a call.
        if (i - openIdx > 4000) return null;
    }
    return null;
}

function callsIn(src) {
    const out = [];
    const re = /\bapi\s*\(/g;
    for (const m of re.exec ? [...src.matchAll(re)] : []) {
        const args = argsAt(src, m.index + m[0].length - 1);
        if (args === null) continue;
        // The url is the first argument. Taken as every string literal before
        // the first top-level comma, concatenated — so '/api/x/' + id yields
        // the prefix '/api/x/', which is what a route with a :param needs.
        const firstArg = splitTop(args)[0] || '';
        const lits = [...firstArg.matchAll(/`([^`]*)`|'([^']*)'|"([^"]*)"/g)]
            .map((x) => x[1] ?? x[2] ?? x[3]);
        if (!lits.length) continue;
        const url = lits.join('');
        const meth = (/\bmethod\s*:\s*['"`](\w+)['"`]/.exec(args) || [])[1];
        out.push({
            url,
            // No method named means GET — api()'s own default.
            method: (meth || 'GET').toUpperCase(),
            // A method held in a variable (`method: m`) cannot be read
            // statically. Recorded so it is treated as matching ANY method
            // rather than silently counting as a GET, which would invent an
            // unreachable DELETE.
            anyMethod: !meth && /\bmethod\s*:/.test(args),
        });
    }
    return out;
}

// Split on commas at depth 0 only, so a nested call or object does not split.
function splitTop(s) {
    const parts = []; let depth = 0, cur = '', quote = null;
    for (let i = 0; i < s.length; i += 1) {
        const c = s[i];
        if (quote) {
            cur += c;
            if (c === '\\') { cur += s[i + 1] || ''; i += 1; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '\'' || c === '"' || c === '`') { quote = c; cur += c; continue; }
        if (c === '(' || c === '[' || c === '{') depth += 1;
        if (c === ')' || c === ']' || c === '}') depth -= 1;
        if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
        cur += c;
    }
    parts.push(cur);
    return parts;
}

// ── every guarded mutating route on the server ───────────────────────────
function routeFiles() {
    const out = [path.join(ROOT, 'api.js')];
    const walk = (p) => {
        if (!fs.existsSync(p)) return;
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
            const q = path.join(p, e.name);
            if (e.isDirectory()) walk(q);
            else if (/routes?\.js$/.test(e.name)) out.push(q);
        }
    };
    walk(path.join(ROOT, 'helpers'));
    return out;
}

const GATES = ['requireSuper', 'requireAdmin'];
function routes() {
    const out = [];
    for (const f of routeFiles()) {
        const src = fs.readFileSync(f, 'utf8');
        const re = new RegExp(
            `app\\.(post|delete|put|patch)\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*,\\s*(${GATES.join('|')})`, 'g');
        for (const m of src.matchAll(re)) {
            out.push({
                method: m[1].toUpperCase(), route: m[2], gate: m[3],
                file: path.relative(ROOT, f),
            });
        }
    }
    return out;
}

// ── KNOWN AND DELIBERATE ─────────────────────────────────────────────────
// Routes with no client caller ON PURPOSE. Each needs a reason, not just an
// entry: an allowlist nobody has to justify is how this check becomes a
// rubber stamp. Keyed "METHOD path".
const BY_DESIGN = {
    // Add here, with the reason, when a route is genuinely server- or
    // script-only. Empty today: every guarded mutating route is reachable.
};

const prefixOf = (r) => r.split('/:')[0].split('?')[0];

function unreachableRoutes() {
    const CALLS = clientFiles().flatMap((f) => callsIn(fs.readFileSync(f, 'utf8')));
    const ROUTES = routes();
    const out = [];
    for (const r of ROUTES) {
        const p = prefixOf(r.route);
        if (p.length < 6) continue;                 // '/api' and the like
        if (BY_DESIGN[`${r.method} ${r.route}`]) continue;
        const hit = CALLS.some((c) => {
            if (!(c.anyMethod || c.method === r.method)) return false;
            const u = c.url.split('?')[0];
            // Either side may be the longer one: the client may hold the
            // prefix and append an id, or hold the whole path for a route
            // with no param.
            return u === p || u.startsWith(p) || p.startsWith(u);
        });
        if (!hit) out.push(r);
    }
    return { routes: ROUTES, calls: CALLS, unreachable: out };
}

module.exports = { unreachableRoutes, callsIn, routes, clientFiles, BY_DESIGN };

// ── printed only when run directly ───────────────────────────────────────
// require()d from tests/route-reach.js, where a report on stdout would be
// noise in the middle of the suite.
if (require.main === module) {
    const { routes: ROUTES, calls: CALLS, unreachable } = unreachableRoutes();
    console.log(`\nROUTE REACH — ${ROUTES.length} guarded mutating routes · `
        + `${CALLS.length} client api() calls\n`);
    if (!unreachable.length) {
        console.log('  Every guarded mutating route has a client that calls it, with');
        console.log('  the right method. Nothing is granted and unreachable.\n');
    } else {
        console.log(`  ${unreachable.length} ROUTE(S) NOTHING CALLS\n`);
        console.log('  Each of these is a permission that exists and cannot be used. Either');
        console.log('  the screen is missing, or the route is dead and should go.\n');
        for (const u of unreachable) {
            console.log(`    ${u.gate.padEnd(13)} ${u.method.padEnd(6)} ${u.route}`);
            console.log(`      ${u.file}`);
        }
        console.log('\n  If one is deliberate, add it to BY_DESIGN with the reason.\n');
    }
    if (STRICT && unreachable.length) process.exit(1);
}
