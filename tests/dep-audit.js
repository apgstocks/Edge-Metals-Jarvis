// ── tests/dep-audit.js ────────────────────────────────────────────────────
// Apsara, 2026-10-08, attested to Plaid:
//
//   "...monitors end-of-life (EOL) software in use and updates policies to
//    include EOL management practices"
//   "...patches identified vulnerabilities within a defined SLA"
//
// She signed those before anything stood behind them. helpers/depAudit.js is
// what makes the first one true. So the thing this file has to protect is
// not a calculation — it is that the check KEEPS WORKING, silently and
// nightly, for as long as the attestation stands. A monitor that quietly
// stopped looking is worse than no monitor, because the attestation would
// still be signed.
//
// Hence the shape of almost every check below: "could not check" must never
// be reportable as "nothing found". helpers/entrances.js:277-299 already
// made that mistake once — its cert probe returns ok:true when no TLS
// implementation is injected — and it is the single easiest way for this
// file's subject to become a lie.
//
// NOTHING HERE REACHES THE NETWORK. npm audit is injected everywhere.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-dep-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const D = require(path.join(ROOT, 'helpers/depAudit'));

const clean = async () => ({ checked: true, total: 0, packages: [],
    bySeverity: { critical: 0, high: 0, moderate: 0, low: 0 } });
const dirty = async () => ({ checked: true, total: 27, packages: [{ name: 'proxy-addr', severity: 'critical' }],
    bySeverity: { critical: 1, high: 18, moderate: 8, low: 0 } });
const broken = async () => ({ checked: false, problem: 'npm audit produced no readable JSON' });

(async () => {

// ── A — NODE'S OWN END OF LIFE ────────────────────────────────────────────
{
    section('A — the runtime, which is the EOL nobody thinks of');
    const past = D.nodeStatus(new Date('2026-10-08'), 'v18.20.0');
    ck('a Node that is already past its date is high severity',
       past.known && past.expired, JSON.stringify(past));
    const soon = D.nodeStatus(new Date('2026-04-01'), 'v20.11.0');
    ck('one that expires within four months is reported before it bites',
       soon.known && !soon.expired && soon.daysLeft <= 120, JSON.stringify(soon));
    const now = D.nodeStatus(new Date('2026-10-08'), 'v22.0.0');
    ck('a supported one is not nagged about', now.known && now.daysLeft > 120);

    // ── THE ONE THAT KEEPS THIS HONEST IN 2028 ───────────────────────────
    // A Node major this file has never heard of must say so. Returning
    // "fine" for an unknown version is how a monitor goes quietly blind the
    // year after it was written, with the attestation still signed.
    const unknown = D.nodeStatus(new Date('2030-01-01'), 'v30.0.0');
    ck('a version the table does not know says so, rather than passing',
       unknown.known === false && /not in this file/.test(unknown.note), JSON.stringify(unknown));
    // run() took its version from process.version, so this branch could not
    // be reached from a test at all — the check existed and was unreachable,
    // which is the same defect as a monitor nobody calls. nodeVersion is now
    // injectable for exactly this.
    const r = await D.run({ now: new Date('2030-01-01'), auditImpl: clean, nodeVersion: 'v30.0.0' });
    ck('  and that reaches the findings, so somebody is told',
       r.findings.some((f) => /NODE_EOL/.test(f.action)), JSON.stringify(r.findings));
}

// ── B — "COULD NOT CHECK" IS NOT "NOTHING FOUND" ─────────────────────────
{
    section('B — a scan that did not run never reports clean');
    const r = await D.run({ auditImpl: broken });
    ck('a failed scan is itself a finding',
       r.findings.some((f) => /did not run/.test(f.what)), JSON.stringify(r.findings.map((f) => f.what)));
    ck('  and it says the figure is missing, not zero',
       r.findings.some((f) => /missing, not zero/.test(f.action)));
    ck('  and clean is FALSE', r.clean === false);

    const ok = await D.run({ auditImpl: clean });
    ck('a scan that ran and found nothing can be clean',
       ok.vulnerabilities.checked === true && ok.findings.filter((f) => /vulnerab/.test(f.what)).length === 0);
}

// ── C — the SLA travels with the count ───────────────────────────────────
// Plaid asked for a DEFINED SLA. A number in a policy document that no code
// reads is a number that drifts from the practice, so the finding quotes the
// same constant the policy will.
{
    section('C — a defined SLA, in the same place as the measurement');
    const r = await D.run({ auditImpl: dirty });
    const crit = r.findings.find((f) => /critical/.test(f.what));
    ck('a critical vulnerability is reported', !!crit, JSON.stringify(r.findings.map((f) => f.what)));
    ck('  and names the agreed number of days',
       !!crit && crit.why.includes(String(D.SLA_DAYS.critical)), crit && crit.why);
    ck('every severity has an SLA, so none is silently unbounded',
       ['critical', 'high', 'moderate', 'low'].every((s) => Number(D.SLA_DAYS[s]) > 0),
       JSON.stringify(D.SLA_DAYS));
    ck('  and critical is the tightest of them',
       D.SLA_DAYS.critical < D.SLA_DAYS.high && D.SLA_DAYS.high < D.SLA_DAYS.moderate);
    ck('low severity is counted but not raised as a finding',
       !r.findings.some((f) => /low vulnerab/.test(f.what)));
}

// ── D — THE NAMED UNMAINTAINED PACKAGES ──────────────────────────────────
// The attestation is about software IN USE, so this reads node_modules
// rather than package.json — the two disagree in this repo, which is itself
// one of the findings.
{
    section('D — what we run that nobody maintains');
    const r = await D.run({ auditImpl: clean });
    ck('pdf-parse is named, because it parses untrusted PDFs',
       r.findings.some((f) => /pdf-parse/.test(f.what)), r.eolInUse.join(', '));
    ck('  and the reason says WHY it matters, not just that it is old',
       (D.KNOWN_EOL.find((e) => e.name === 'pdf-parse') || {}).why.includes('untrusted'));
    ck('whatsapp-web.js is named as unofficial',
       r.findings.some((f) => /whatsapp-web/.test(f.what)));
    ck('every named package carries an action, not only a complaint',
       D.KNOWN_EOL.every((e) => e.name && e.why && e.action));
    ck('it reads what is INSTALLED, not what package.json claims',
       D.installed().ok === true && D.installed().packages.length > 50,
       String(D.installed().packages.length));
}

// ── E — the lockfile and the manifest ────────────────────────────────────
{
    section('E — npm ci and npm install must install the same tree');
    const d = D.lockDrift();
    ck('the drift check runs against the real files', d.checked === true, JSON.stringify(d).slice(0, 200));
    // Not asserted as a FIXED list — this is a live condition that should go
    // away when the lockfile is refreshed, and a test demanding it stay
    // broken is a test that gets deleted the day it is fixed.
    ck('  and reports each package with both figures, so the gap is readable',
       d.drifted.every((x) => x.name && x.manifest && x.lock),
       JSON.stringify(d.drifted));
}

// ── F — IT IS ACTUALLY WIRED TO THE NIGHTLY MAIL ─────────────────────────
// The reconcile.js lesson, and the one that matters most here: a monitor
// nothing calls is indistinguishable from no monitor, and the attestation
// would still be signed. integritySweepJob is what runs at 06:30.
{
    section('F — reached by the job that actually runs');
    const job = require(path.join(ROOT, 'helpers/integritySweepJob'));
    const res = await job.run({ send: false, auditImpl: dirty });
    ck('the nightly job runs the dependency check', !!res.dependencies,
       JSON.stringify(Object.keys(res)));
    ck('  and puts it in the text she reads',
       /END-OF-LIFE SOFTWARE/.test(res.text), res.text.slice(-400));
    ck('  naming the critical count',
       /1 critical/.test(res.text), res.text.slice(-400));
    ck('  and the action, not only the problem',
       /→ /.test(res.text));

    // A dependency problem must be able to send the mail BY ITSELF. The job
    // is silent when clean, and before this the only thing that could break
    // that silence was a ledger finding — so on a morning when the books
    // agree and a critical CVE has landed, nothing would have been sent.
    ck('a dependency finding alone makes the job not-clean', res.clean === false);
    ck('  and gets its own subject rather than "0 things to look at"',
       !/0 things/.test(job.subjectFor({ clean: false, total: 0, findings: [] })),
       job.subjectFor({ clean: false, total: 0, findings: [] }));

    // ── MY ASSERTION WAS WRONG HERE, NOT THE CODE ────────────────────────
    // First version asserted a clean audit adds NOTHING to the report. It
    // adds plenty, correctly: pdf-parse and whatsapp-web.js really are
    // installed and really are unmaintained, and a clean npm audit does not
    // change that. "No vulnerabilities" and "nothing to say" are different
    // findings, and conflating them is how an unmaintained PDF parser stops
    // being mentioned.
    const quiet = await job.run({ send: false, auditImpl: clean });
    ck('a clean scan stops the vulnerability COUNTS being reported',
       !/critical vulnerab|high vulnerab/.test(quiet.text), quiet.text.slice(-300));
    ck('  but unmaintained packages are still named — they did not become maintained',
       /pdf-parse/.test(quiet.text), quiet.text.slice(-300));

    // And a BROKEN check still speaks. Silence here would mean the
    // attestation is backed by something that stopped working.
    const b = await job.run({ send: false, auditImpl: broken });
    ck('a scan that could not run still reaches the email',
       /did not run/.test(b.text), b.text.slice(-300));
}

// ── G — the sweep it rides on is unchanged ───────────────────────────────
// CLAUDE.md §1. integritySweep.run() is synchronous and shared; the audit
// went in the JOB so that function did not have to become async and drag
// every caller with it.
{
    section('G — integritySweep itself was not touched');
    const sweep = require(path.join(ROOT, 'helpers/integritySweep'));
    const r = sweep.run();
    ck('integritySweep.run() is still synchronous',
       !(r instanceof Promise), typeof r);
    ck('  and knows nothing about dependencies',
       !('dependencies' in r), JSON.stringify(Object.keys(r)));
    const src = fs.readFileSync(path.join(ROOT, 'helpers/integritySweep.js'), 'utf8');
    ck('  and does not mention npm audit or depAudit',
       !/depAudit|npm audit/.test(src));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
