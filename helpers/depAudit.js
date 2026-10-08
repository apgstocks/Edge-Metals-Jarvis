// ── helpers/depAudit.js — what we run that nobody maintains any more ──────
//
// Apsara, 2026-10-08, from Plaid's remediation list:
//
//   "Attest that your organization monitors end-of-life (EOL) software in
//    use and updates policies to include EOL management practices"
//   "Attest that your organization patches identified vulnerabilities
//    within a defined SLA"
//
// She asked to attest both. Neither was true: there was no dependency
// scanning anywhere, the only GitHub workflow is path-filtered to the iOS
// build, and package-lock.json is a month out of step with package.json so
// `npm ci` and `npm install` install different trees. This file is the
// first half of making the first one true — a thing that actually looks,
// every night, at what is installed and whether anyone still maintains it.
//
// ── WHY IT RUNS HERE AND NOT ONLY IN CI ─────────────────────────────────
// Dependabot raises pull requests against the repo. That is the right tool
// and .github/dependabot.yml now exists for it. But the attestation is
// about SOFTWARE IN USE, and what is in use is whatever is installed on the
// VM right now — which, because of the stale lockfile and a deploy that is
// `git pull` typed by hand, is not necessarily what the repo says. A check
// that reads the repo would attest to the wrong machine.
//
// So this reads the INSTALLED tree, on the box it runs on, and it rides the
// nightly integrity sweep she already reads rather than arriving as a new
// email she learns to ignore.
//
// ── IT FINDS. IT DOES NOT PATCH. ────────────────────────────────────────
// Same doctrine as integritySweep.js: a nightly job that quietly upgrades a
// dependency is how a yard stops being able to print a bill of lading on a
// Tuesday morning. Every finding names the package and stops.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');

// ── THE SLA, WRITTEN DOWN WHERE THE CODE CAN SEE IT ─────────────────────
// Plaid asks for a DEFINED SLA, and a number in a policy document that no
// code reads is how the number drifts from the practice. These are the days
// a vulnerability of each severity may remain unpatched; the sweep counts
// anything past them as overdue, so the policy and the measurement are the
// same fact.
//
// PROPOSED BY ME, 2026-10-08, NOT YET HER DECISION. Ordinary figures for a
// small team — a bank will not argue with them — but she has not agreed
// them and a comment must not file a decision under her name. Until she
// says otherwise these are a starting point for the conversation, and the
// attestation should not be signed on the strength of this constant alone.
const SLA_DAYS = { critical: 7, high: 30, moderate: 90, low: 180 };

// Packages we knowingly run that are unmaintained or unofficial. Named
// rather than detected: npm has no reliable "is this abandoned" signal, and
// a list someone had to write is a list someone had to think about.
//
// Each entry says what the risk actually is, because "unmaintained" alone
// does not tell you whether to care.
const KNOWN_EOL = [
    {
        name: 'pdf-parse',
        why: 'unmaintained upstream, and it parses PDFs that arrive by email and from '
           + 'uploads — untrusted input through an unpatched parser is the worst pairing '
           + 'on this list',
        action: 'replace with a maintained parser, or stop feeding it unreviewed attachments',
    },
    {
        name: 'whatsapp-web.js',
        why: 'an unofficial reverse-engineered client, not a supported API. It drives a '
           + 'full Chromium on the same VM and the same disk as the bank data, and it '
           + 'breaks whenever WhatsApp changes',
        action: 'accepted risk for now; the containment question is whether it belongs on '
              + 'the same box as the ledger at all',
    },
];

const isoDay = (d) => new Date(d).toISOString().slice(0, 10);

// ── WHICH NODE, AND IS IT STILL SUPPORTED ───────────────────────────────
// Node's own EOL is the one piece of EOL that is not a package. The dates
// are the published Node.js release schedule's end-of-life for each major;
// they are facts with a source, not estimates, and they are listed rather
// than fetched so a nightly job never depends on the network to answer.
const NODE_EOL = {
    18: '2025-04-30',
    20: '2026-04-30',
    22: '2027-04-30',
    24: '2028-04-30',
};

function nodeStatus(now = new Date(), version = process.version) {
    const major = Number(String(version).replace(/^v/, '').split('.')[0]);
    const eol = NODE_EOL[major] || null;
    if (!eol) {
        return { major, version, eol: null, known: false,
            note: `Node ${major} is not in this file's table — add its end-of-life date` };
    }
    const days = Math.round((new Date(eol) - now) / 86400000);
    return { major, version, eol, known: true, daysLeft: days, expired: days < 0 };
}

// ── WHAT IS ACTUALLY INSTALLED ──────────────────────────────────────────
// node_modules, not package.json. See the header: the lockfile and the
// manifest disagree, so the manifest is a claim and this is the fact.
function installed() {
    const dir = path.join(ROOT, 'node_modules');
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return { ok: false, problem: `no node_modules at ${dir}` }; }
    const rows = [];
    for (const n of names) {
        if (n.startsWith('.')) continue;
        const sub = n.startsWith('@') ? (() => { try { return fs.readdirSync(path.join(dir, n)).map((m) => `${n}/${m}`); } catch (e) { return []; } })() : [n];
        for (const full of sub) {
            try {
                const pj = JSON.parse(fs.readFileSync(path.join(dir, full, 'package.json'), 'utf8'));
                rows.push({ name: pj.name || full, version: pj.version || null });
            } catch (e) { /* not a package directory */ }
        }
    }
    return { ok: true, packages: rows };
}

// ── npm audit, WITHOUT THE NETWORK IF IT IS NOT THERE ───────────────────
// `npm audit --json` wants the registry. On a nightly job that must not be
// the thing that makes the sweep fail, so a network error is a REPORTED
// condition rather than a thrown one — "we could not check" and "nothing
// found" must never look the same, which is the mistake the cert probe in
// entrances.js already made once (it returns ok:true when it cannot check).
function audit({ exec = execFile, timeoutMs = 60000 } = {}) {
    return new Promise((resolve) => {
        exec('npm', ['audit', '--json', '--audit-level=low'], { cwd: ROOT, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
            (err, stdout) => {
                // npm audit exits NONZERO when it finds vulnerabilities, so a
                // non-zero exit is the normal case and must not be read as a
                // failure. Only unparseable output is a failure.
                let j = null;
                try { j = JSON.parse(String(stdout || '')); } catch (e) { j = null; }
                if (!j) {
                    return resolve({ checked: false,
                        problem: `npm audit produced no readable JSON${err ? `: ${err.message}` : ''}` });
                }
                const meta = (j.metadata && j.metadata.vulnerabilities) || {};
                const bySeverity = {
                    critical: Number(meta.critical) || 0,
                    high: Number(meta.high) || 0,
                    moderate: Number(meta.moderate) || 0,
                    low: Number(meta.low) || 0,
                };
                const named = Object.entries(j.vulnerabilities || {})
                    .map(([name, v]) => ({ name, severity: v.severity || 'unknown',
                        direct: !!v.isDirect, via: Array.isArray(v.via) ? v.via.length : 0 }))
                    .sort((a, b) => ['critical', 'high', 'moderate', 'low'].indexOf(a.severity)
                                  - ['critical', 'high', 'moderate', 'low'].indexOf(b.severity));
                return resolve({ checked: true, bySeverity,
                    total: Object.values(bySeverity).reduce((a, b) => a + b, 0),
                    packages: named });
            });
    });
}

// ── THE LOCKFILE AND THE MANIFEST MUST AGREE ────────────────────────────
// Not a vulnerability, but it is why "what is installed" and "what the repo
// says" can differ, which undermines every other answer on this page. Found
// 2026-10-08: the lock pins puppeteer 24.38.0 against a declared ^25.8.0.
function lockDrift() {
    let pj = null, lock = null;
    try { pj = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); } catch (e) { return { checked: false, problem: 'no package.json' }; }
    try { lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')); } catch (e) { return { checked: false, problem: 'no package-lock.json' }; }
    const want = { ...(pj.dependencies || {}), ...(pj.devDependencies || {}) };
    const have = (lock.packages && lock.packages['']) || {};
    const locked = { ...(have.dependencies || {}), ...(have.devDependencies || {}) };
    const drifted = Object.keys(want)
        .filter((k) => locked[k] && locked[k] !== want[k])
        .map((k) => ({ name: k, manifest: want[k], lock: locked[k] }));
    return { checked: true, drifted };
}

// ── one call, everything the sweep needs ────────────────────────────────
// `nodeVersion` is injectable for the same reason `auditImpl` is: the
// interesting case is a Node major this table has never heard of, and that
// cannot be exercised by whatever runtime the suite happens to run on.
// Without it the unknown-version branch was unreachable from a test, which
// is how a monitor goes quietly blind two years after it was written.
async function run({ now = new Date(), auditImpl = audit, nodeVersion = process.version } = {}) {
    const node = nodeStatus(now, nodeVersion);
    const inst = installed();
    const vulns = await auditImpl();
    const drift = lockDrift();

    const eolInUse = KNOWN_EOL.filter((e) =>
        inst.ok && inst.packages.some((p) => p.name === e.name));

    const findings = [];

    if (node.known && node.expired) {
        findings.push({ severity: 'high', what: `Node ${node.major} reached end of life on ${node.eol}`,
            why: 'an unsupported runtime stops receiving security patches entirely',
            action: 'move to the current LTS' });
    } else if (node.known && node.daysLeft <= 120) {
        findings.push({ severity: 'moderate', what: `Node ${node.major} reaches end of life on ${node.eol} (${node.daysLeft} days)`,
            why: 'planning an upgrade is cheaper before the patches stop than after',
            action: 'schedule the move to the next LTS' });
    } else if (!node.known) {
        findings.push({ severity: 'low', what: node.note, why: 'the check cannot answer for a version it does not know',
            action: 'add the release date to NODE_EOL in helpers/depAudit.js' });
    }

    for (const e of eolInUse) {
        findings.push({ severity: 'high', what: `${e.name} is unmaintained or unofficial`, why: e.why, action: e.action });
    }

    if (!vulns.checked) {
        // Said out loud. "could not check" is not "nothing found".
        findings.push({ severity: 'moderate', what: 'the vulnerability scan did not run',
            why: vulns.problem, action: 'run npm audit by hand — this figure is missing, not zero' });
    } else {
        for (const sev of ['critical', 'high', 'moderate']) {
            const n = vulns.bySeverity[sev];
            if (!n) continue;
            findings.push({ severity: sev,
                what: `${n} ${sev} vulnerabilit${n === 1 ? 'y' : 'ies'} in installed packages`,
                why: `the agreed SLA for ${sev} is ${SLA_DAYS[sev]} days`,
                action: 'npm audit for the list; patch or record why not' });
        }
    }

    if (drift.checked && drift.drifted.length) {
        findings.push({ severity: 'moderate',
            what: `${drift.drifted.length} package(s) where package-lock.json disagrees with package.json`,
            why: 'npm ci and npm install install different trees, so what is tested is not what is deployed',
            action: `run npm install and commit the lockfile — ${drift.drifted.map((d) => d.name).join(', ')}` });
    }

    return {
        at: isoDay(now),
        node,
        packages: inst.ok ? inst.packages.length : null,
        vulnerabilities: vulns,
        eolInUse: eolInUse.map((e) => e.name),
        lockDrift: drift,
        slaDays: SLA_DAYS,
        findings,
        // True only when the scan RAN and found nothing worth saying. A scan
        // that could not run never produces a clean verdict.
        clean: vulns.checked && findings.length === 0,
    };
}

module.exports = { run, nodeStatus, installed, audit, lockDrift, KNOWN_EOL, NODE_EOL, SLA_DAYS };
