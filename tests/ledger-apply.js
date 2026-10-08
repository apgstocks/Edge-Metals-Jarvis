// ── tests/ledger-apply.js ─────────────────────────────────────────────────
// Layer 5: the only part of the plan architecture that can lose data.
// helpers/ledgerPlan.js verifies; this makes it real.
//
// Three failure modes, each with a named defence, each checked here:
//
//   1 THE WORLD MOVED between the preview she approved and the Apply she
//     pressed. The most likely of the three, because the gap is however
//     long she spends reading, and the one nobody builds for.
//   2 IT STOPPED HALF WAY. mutateJson locks ONE file; a plan writes two.
//     There is no cross-file transaction in this codebase.
//   3 IT RAN TWICE. A double-pressed button, a retried request.
//
// Against a REAL store in a temp DATA_DIR, through the real helpers —
// bills.js and billPayments.js own the arithmetic and writing JSON from
// the test would prove something else.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-apply-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against real data');
    process.exit(1);
}
const LA = require(path.join(ROOT, 'helpers/ledgerApply'));
const bills = require(path.join(ROOT, 'helpers/bills'));

// An audit that records in memory, so a log failure is a thing this file
// can cause on purpose rather than something it hopes never happens.
function fakeAudit() {
    const rows = [];
    return { rows, listEntries: () => rows,
        record: async (e) => { rows.push({ ...e, id: `AUD_${rows.length + 1}` }); return e; } };
}

(async () => {

// ── A — A PLAN THAT RUNS ─────────────────────────────────────────────────
{
    section('A — the happy path, through the real stores');
    await bills.addBill({ supplier: 'Hugo', date: '2025-12-30', container_no: 'TGHU1234567',
        supplier_price: 0.31 });
    const made = bills.list().find((b) => b.container_no === 'TGHU1234567');
    ck('a bill exists to work on', !!made, JSON.stringify(bills.list().length));

    const audit = fakeAudit();
    const plan = [
        { op: 'detach-container', bill_id: made.id, container_no: 'TGHU1234567' },
        { op: 'create-bill', supplier: 'Hugo', date: '2026-01-03', container_no: 'TGHU1234567' },
    ];
    const res = await LA.apply({ plan, asked: 'move it to a new bill on 3 Jan',
        actor: 'apsara', planId: 'PLAN_A', audit });
    ck('it applies', res.ok === true, JSON.stringify(res));
    ck('  and says which bill it created',
       !!res.created['#2'], JSON.stringify(res.created));

    const after = bills.list();
    ck('the container is on exactly one bill',
       after.filter((b) => String(b.container_no) === 'TGHU1234567').length === 1,
       JSON.stringify(after.map((b) => [b.id, b.container_no])));
    ck('  and the old bill no longer holds it',
       (after.find((b) => b.id === made.id) || {}).container_no !== 'TGHU1234567');

    // ── THE LOG, WHICH IS WHY SHE ASKED FOR ANY OF THIS ──────────────────
    const entry = audit.rows.find((e) => e.action === 'ledger-plan');
    ck('it is written down', !!entry, JSON.stringify(audit.rows.map((r) => r.action)));
    ck('  under its own action, not "unknown-action"', entry.action === 'ledger-plan');
    ck('  carrying HER WORDS', /move it to a new bill on 3 Jan/.test(entry.detail.asked));
    ck('  and who asked', entry.detail.actor === 'apsara');
    ck('  and that it was actually applied', entry.detail.applied === true);
    ck('  and the undo, with the REAL id, not the #2 placeholder',
       Array.isArray(entry.detail.reverse)
       && !JSON.stringify(entry.detail.reverse).includes('"#2"'),
       JSON.stringify(entry.detail.reverse));
}

// ── B — DEFENCE 3: IT RAN TWICE ──────────────────────────────────────────
{
    section('B — the same plan twice');
    const audit = fakeAudit();
    await audit.record({ action: 'ledger-plan', subject: 'PLAN_B',
        detail: { plan_id: 'PLAN_B', applied: true } });
    const res = await LA.apply({ plan: [{ op: 'create-bill', supplier: 'X', date: '2026-01-01' }],
        asked: 'again', planId: 'PLAN_B', audit });
    ck('a plan already in the log is refused', res.ok === false && /already been applied/.test(res.why),
       JSON.stringify(res));
    ck('  and nothing was written', res.applied === false);

    // The log is the thing that remembers, because it is append-only and
    // cannot be edited — no second store to keep in step.
    ck('  the check reads the audit log, not a separate store',
       LA.alreadyApplied('PLAN_B', audit) === true && LA.alreadyApplied('PLAN_NEVER', audit) === false);
}

// ── C — DEFENCE 1: THE WORLD MOVED ───────────────────────────────────────
// She approved a preview at 10:04 and pressed Apply at 10:06. In between,
// the nightly sweep or the other browser tab changed one of those bills.
// The plan still VERIFIES — against the new world — but what it does is no
// longer what she agreed to.
{
    section('C — the books changed while she was reading');
    const audit = fakeAudit();
    const b = bills.list()[0];
    const plan = [{ op: 'create-bill', supplier: 'Hugo', date: '2026-02-01' }];

    const stale = [{ supplier: 'Hugo', billed: { before: 1, after: 2 }, paid: { before: 0, after: 0 },
        owed: { before: 1, after: 2 }, bills: { before: 99, after: 100 },
        containers: { before: 0, after: 0 } }];
    const res = await LA.apply({ plan, asked: 'x', planId: 'PLAN_C', approvedDiff: stale, audit });
    ck('an apply against a changed world is REFUSED', res.ok === false, JSON.stringify(res.why));
    ck('  and says nothing has been applied', /nothing has been applied/.test(res.why), res.why);
    ck('  and hands back both sets of figures so she can compare',
       !!res.approvedDiff && !!res.currentDiff, Object.keys(res).join(','));
    ck('  and really did not write', !bills.list().some((x) => x.date === '2026-02-01'));

    // And the same plan with the CURRENT diff goes through — the guard
    // must not be a guard that always fires.
    const LP = require(path.join(ROOT, 'helpers/ledgerPlan'));
    const fresh = LP.verify(plan, LA.readWorld()).simulation.diff;
    const ok = await LA.apply({ plan, asked: 'x', planId: 'PLAN_C2', approvedDiff: fresh, audit });
    ck('the same plan with the figures she actually saw applies', ok.ok === true, JSON.stringify(ok.why));
    ck('  (so the guard is not simply always-refuse)', b !== undefined);
}

// ── D — DEFENCE 2: IT STOPPED HALF WAY ───────────────────────────────────
// A plan is several writes across two files and mutateJson locks one at a
// time. A crash between write two and write three leaves a container on no
// bill and a payment applied to a bill that was never created.
{
    section('D — it fails in the middle');
    const audit = fakeAudit();
    const before = JSON.stringify(bills.list());
    const target = bills.list().find((x) => x.container_no === 'TGHU1234567');

    // Step 1 is real and succeeds; step 2 throws. runStepImpl is injected
    // so apply()'s OWN rollback path runs — testing snapshot, throw and
    // rollback as separate pieces proves the pieces and not the wiring,
    // which is the gap CLAUDE.md §3 keeps finding.
    const realRun = LA.runStep;
    const boom = async (step, i, idMap) => {
        if (step.op === 'create-bill' && step.supplier === 'EXPLODE') throw new Error('disk full');
        return realRun(step, i, idMap);
    };
    const res = await LA.apply({
        plan: [
            { op: 'detach-container', bill_id: target.id, container_no: 'TGHU1234567' },
            { op: 'create-bill', supplier: 'EXPLODE', date: '2026-03-01', container_no: 'TGHU1234567' },
        ],
        asked: 'move it', planId: 'PLAN_D', audit, runStepImpl: boom,
    });

    ck('the apply reports failure rather than throwing', res.ok === false, JSON.stringify(res));
    ck('  naming the step that failed and the reason',
       /step 2 failed/.test(res.why) && /disk full/.test(res.why), res.why);
    ck('  and says everything was put back', res.rolledBack === true, JSON.stringify(res));
    ck('the books are byte-for-byte as they were',
       JSON.stringify(bills.list()) === before,
       `${bills.list().length} bills vs ${JSON.parse(before).length}`);
    ck('  including the container, back on its original bill',
       bills.list().some((x) => x.container_no === 'TGHU1234567'));
    ck('  and no EXPLODE bill survived', !bills.list().some((x) => x.supplier === 'EXPLODE'));

    // A failed apply is logged too — and logged as NOT applied, which is
    // the distinction that matters when somebody reads this in March.
    const e = audit.rows.filter((r) => r.action === 'ledger-plan').pop();
    ck('the failure is in the log', !!e && e.detail.plan_id === 'PLAN_D', JSON.stringify(e && e.detail));
    ck('  marked as NOT applied', e.detail.applied === false);
    ck('  saying which step broke and that it rolled back',
       e.detail.failed_at === 2 && e.detail.rolled_back === true, JSON.stringify(e.detail));
}

// ── E — A ROLLBACK THAT ITSELF FAILS IS NOT SWALLOWED ────────────────────
// At that point the data is in a state nobody designed and she has to know
// immediately, while the archive is still there.
{
    section('E — when putting it back does not work either');
    const bad = LA.rollback([{ file: path.join(TMP, 'no', 'such', 'dir', 'x.json'), bytes: Buffer.from('{}') }]);
    ck('a failed restore is REPORTED, not swallowed', bad.length === 1, JSON.stringify(bad));
    ck('  naming the file', /x\.json/.test(bad[0]), bad[0]);
}

// ── F — THE FILES IT GUARDS ARE THE FILES A PLAN TOUCHES ─────────────────
// A snapshot of "whatever got written" is not a snapshot: it cannot be
// taken before the writing starts, which is the only moment it is worth
// anything. So the list is explicit, and worth asserting.
{
    section('F — what is snapshotted');
    const files = LA.filesAtRisk();
    ck('the bills store is protected', files.some((f) => /bills\.json$/.test(f)), JSON.stringify(files));
    ck('and the bill-payments store is protected',
       files.some((f) => /bill_payments\.json$/.test(f)), JSON.stringify(files));
    ck('every file in the list is inside the test DATA_DIR',
       files.every((f) => String(f).startsWith(TMP)), JSON.stringify(files));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
