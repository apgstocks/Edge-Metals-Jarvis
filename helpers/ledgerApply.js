// ── helpers/ledgerApply.js — the only part that can lose data ────────────
//
// Layer 5 of the plan architecture (helpers/ledgerPlan.js has the other
// four and the reading behind them). The verifier says a plan is safe; this
// is what makes it real, and it is the only piece that can destroy
// something.
//
// Apsara, 2026-10-08, asked for the agent and then for two things that
// belong here specifically: "add delete option", and "make it log every
// change we are doing in qb/books so that we can check it later."
//
// ── THE THREE WAYS AN APPLY GOES WRONG ──────────────────────────────────
//
//   1 THE WORLD MOVED. She approved a preview computed at 10:04. At 10:06
//     she presses Apply. In between, the nightly sweep, the other browser
//     tab, or the second person in the office changed one of those bills.
//     The plan still verifies — against the NEW world — but what it does
//     is no longer what she agreed to. This is the one nobody builds for
//     and it is the most likely of the three, because the gap is however
//     long she spends reading.
//
//   2 IT STOPPED HALF WAY. A plan is four writes across two files, and
//     mutateJson locks ONE file at a time. There is no cross-file
//     transaction in this codebase — helpers/json.js gives atomic
//     single-file writes and nothing above that. So a crash between write
//     two and write three leaves a container on no bill and a payment
//     applied to a bill that was never created.
//
//   3 IT RAN TWICE. A double-pressed button, a retried request, a user who
//     refreshed. Applying the same plan twice detaches a container that is
//     already detached — which the verifier catches — or applies a payment
//     twice, which it does not, because by then the first application is
//     part of the world and the second one is merely a second payment.
//
// Each gets a named defence below. None of them is clever; all three are
// the kind of thing that is obvious afterwards.
//
// ── IT CALLS THE EXISTING HELPERS, NEVER THE FILES ──────────────────────
// bills.js and billPayments.js own their stores and have the arithmetic in
// them — net weights, tare components, allocations, what a supplier is
// owed. Writing JSON directly from here would be a second implementation
// of all of it, drifting from the first. Every operation goes through the
// function the screens already use.

const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const LP = require('./ledgerPlan');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

// ── THE FILES A PLAN CAN TOUCH ──────────────────────────────────────────
// Listed, not discovered. A snapshot of "whatever got written" is not a
// snapshot — it cannot be taken BEFORE the writing starts, which is the
// only moment it is worth anything.
function filesAtRisk() {
    return [cfg.BILLS_FILE, cfg.BILL_PAYMENTS_FILE || path.join(cfg.DATA_DIR, 'bill_payments.json')]
        .filter(Boolean);
}

// ── DEFENCE 2: SNAPSHOT AND ROLL BACK ───────────────────────────────────
// The whole bytes of every file at risk, read before anything is written.
// Crude and completely reliable, which is the right trade for files this
// size — her bills store is measured in hundreds of kilobytes, and the
// alternative is a journal nobody will maintain.
//
// A rollback that itself fails is reported LOUDLY and never swallowed: at
// that point the data is in a state nobody designed and she has to know
// immediately, while the archive is still there.
function snapshot() {
    const shots = [];
    for (const f of filesAtRisk()) {
        try { shots.push({ file: f, bytes: fs.existsSync(f) ? fs.readFileSync(f) : null }); }
        catch (e) { throw new Error(`could not snapshot ${path.basename(f)} before applying: ${e.message}`); }
    }
    return shots;
}

function rollback(shots) {
    const failed = [];
    for (const s of shots) {
        try {
            if (s.bytes === null) { if (fs.existsSync(s.file)) fs.unlinkSync(s.file); }
            else fs.writeFileSync(s.file, s.bytes);
        } catch (e) { failed.push(`${path.basename(s.file)}: ${e.message}`); }
    }
    return failed;
}

// ── DEFENCE 1: THE WORLD SHE SAW IS THE WORLD SHE CHANGES ───────────────
// The preview carried a diff. Before applying, the plan is re-verified
// against FRESH data and the new diff compared with the approved one. Any
// difference at all and the apply is refused — she is shown the new
// preview and asked again.
//
// Compared on the DIFF rather than on a hash of the files, deliberately.
// A hash refuses when anything anywhere changed, including a row the plan
// never touches, and a guard that fires constantly is a guard that gets
// switched off. The diff is exactly the set of figures she was looking at.
function sameDiff(a, b) {
    const key = (d) => JSON.stringify((d || []).map((r) => [r.supplier,
        r.billed.before, r.billed.after, r.paid.before, r.paid.after,
        r.bills.before, r.bills.after, r.containers.before, r.containers.after]));
    return key(a) === key(b);
}

// ── DEFENCE 3: ONCE ONLY ────────────────────────────────────────────────
// A plan carries an id. The audit log is append-only and is therefore also
// the record of what has already run, so there is no second store to keep
// in step — the thing that remembers is the thing that cannot be edited.
function alreadyApplied(planId, audit) {
    if (!planId) return false;
    try {
        // listEntries(), not recent() — I wrote recent() from memory and
        // audit.js has no such function, so the guard would have thrown on
        // every call and been swallowed by the catch. An idempotency check
        // that silently always returns false is the same as none, and it
        // would have shown up as a payment applied twice.
        return (audit.listEntries() || []).some((e) => e
            && e.action === 'ledger-plan'
            && e.detail && e.detail.plan_id === planId && e.detail.applied === true);
    } catch (e) { return false; }
}

// ── audit.record TAKES A FIXED SHAPE ────────────────────────────────────
// {action, subject, actor, role, ip, detail} — not an arbitrary object. I
// spread the plan record straight into it at first, which would have put
// every field in the wrong place and left `action` undefined, filed as
// 'unknown-action'. The whole record goes in `detail`, where it belongs.
async function writeAudit(audit, rec, extra) {
    return audit.record({
        action: 'ledger-plan',
        subject: (extra && extra.plan_id) || null,
        actor: rec.actor || null,
        role: (extra && extra.role) || null,
        ip: (extra && extra.ip) || null,
        detail: { ...rec, ...extra },
    });
}

// ── reading the world the verifier needs ────────────────────────────────
function readWorld() {
    const bills = require('./bills').listWithTotals();
    const bp = require('./billPayments');
    // ── WHICH PAYMENTS QUICKBOOKS HAS ALREADY TAKEN ─────────────────────
    // editBillPayment REFUSES a payment that is linked into QuickBooks —
    // her own rule, 2026-10-07: "Refuse, and tell me to change both." The
    // verifier knew nothing about it, so a plan touching a linked payment
    // would verify, be previewed, approved, and THEN fail at apply. That
    // is CLAUDE.md's named trap: a requirement in shared code that one
    // caller cannot satisfy, found only when somebody uses that path.
    //
    // So the flag travels with the world and the verifier refuses it up
    // front, while she can still do something about it.
    let qbKeys = null;
    try { qbKeys = require('./qbLinked').liveKeys(); } catch (e) { qbKeys = null; }
    const linked = (row) => {
        if (!qbKeys) return false;
        try {
            const l = require('./qbLinked').linkedRow(row, { kind: 'bill_payments', keys: qbKeys });
            return !!(l && l.linked);
        } catch (e) { return false; }
    };
    const payments = bp.list().map((p) => ({
        id: p.id, party: p.supplier || p.party || null, date: p.date, amount: num(p.amount),
        applied: (p.allocations || []).map((a) => ({ bill_id: a.bill_id, amount: num(a.amount) })),
        qb_linked: linked(p),
    }));
    return { bills, payments };
}

// ── APPLY ───────────────────────────────────────────────────────────────
// Returns what happened. Throws only when the data is in a state nobody
// designed — a failed rollback — because that is the one case where
// carrying on is worse than stopping.
// `runStepImpl` is injectable for the same reason plaid.js takes fetchImpl:
// the ROLLBACK path is the most important thing in this file and it cannot
// be reached without a step that fails. Testing the pieces separately —
// snapshot, then a throw, then rollback — proves the pieces and not the
// wiring, which is the gap CLAUDE.md §3 keeps finding.
async function apply({ plan, asked, actor = null, planId = null, approvedDiff = null,
                       audit = require('./audit'), now = new Date(),
                       runStepImpl = runStep } = {}) {
    const world = readWorld();

    if (alreadyApplied(planId, audit)) {
        return { ok: false, why: 'this plan has already been applied', planId, applied: false };
    }

    const v = LP.verify(plan, world);
    if (!v.ok) {
        const rec = LP.auditRecord({ asked, plan, verification: v, actor, at: now });
        try { await writeAudit(audit, rec, { plan_id: planId, applied: false }); } catch (e) { /* see below */ }
        return { ok: false, why: 'the plan does not verify against the books as they are now',
            problems: v.problems, planId, applied: false };
    }

    // DEFENCE 1.
    if (approvedDiff && !sameDiff(approvedDiff, v.simulation.diff)) {
        return { ok: false, why: 'the books changed since you were shown this — nothing has been '
            + 'applied. Look at the new figures and confirm again.',
            planId, applied: false, approvedDiff, currentDiff: v.simulation.diff };
    }

    // The undo, computed and WRITTEN DOWN BEFORE anything happens. After a
    // bad apply is exactly when it cannot be computed.
    const shots = snapshot();
    const idMap = {};
    const done = [];
    let failure = null;

    try {
        for (let i = 0; i < plan.length; i += 1) {
            const step = plan[i];
            // eslint-disable-next-line no-await-in-loop
            const out = await runStepImpl(step, i, idMap);
            done.push({ step: i + 1, op: step.op, ...out });
        }
    } catch (e) {
        failure = e;
    }

    if (failure) {
        // DEFENCE 2.
        const bad = rollback(shots);
        const rec = LP.auditRecord({ asked, plan, verification: v, actor, at: now });
        try {
            await writeAudit(audit, rec, { plan_id: planId, applied: false,
                failed_at: done.length + 1, error: String(failure.message || failure),
                rolled_back: bad.length === 0, rollback_errors: bad });
        } catch (e) { /* the throw below is the louder signal */ }
        if (bad.length) {
            throw new Error(`APPLY FAILED AND SO DID THE ROLLBACK — the books are in a state nobody `
                + `designed. ${failure.message}. Rollback problems: ${bad.join('; ')}`);
        }
        return { ok: false, why: `step ${done.length + 1} failed and everything was put back: `
            + String(failure.message || failure), planId, applied: false, rolledBack: true };
    }

    // ── AND ONLY NOW IS IT WRITTEN DOWN AS DONE ─────────────────────────
    // After the writes, not before. An entry saying a plan was applied,
    // written before it was, is worse than no entry: it is evidence of
    // something that did not happen.
    const reverse = LP.reverseOf(plan, idMap);
    const rec = LP.auditRecord({ asked, plan, verification: v, actor, at: now });
    let logged = true;
    try { await writeAudit(audit, rec, { plan_id: planId, applied: true, reverse, created: idMap }); }
    catch (e) {
        // The writes HAPPENED. Failing to log them does not unhappen them,
        // and rolling back a successful apply because the log failed would
        // be the worse of two bad outcomes — so this is reported, loudly,
        // and the caller decides.
        logged = false;
        console.error('[LEDGER] applied but could not log it:', e.message);
    }

    return { ok: true, applied: true, planId, steps: done, created: idMap, reverse, logged,
        diff: v.simulation.diff };
}

// One step, through the helper that owns the store. Each throws on refusal,
// which is what the rollback above is listening for.
async function runStep(step, i, idMap) {
    const bills = require('./bills');
    const bp = require('./billPayments');
    const realBill = (v) => (String(v).startsWith('#') ? idMap[String(v)] : v);

    if (step.op === 'create-bill') {
        const made = await bills.addBill({
            supplier: step.supplier, date: step.date,
            container_no: step.container_no || '', booking_no: step.booking_no || '',
            invoice_no: step.invoice_no || '',
            supplier_price: step.supplier_price, price_unit: step.price_unit,
        });
        const id = made && (made.id || made.bill_id);
        if (!id) throw new Error('bills.addBill returned no id');
        idMap[`#${i + 1}`] = id;
        return { created: id };
    }
    if (step.op === 'detach-container') {
        await bills.editBill(realBill(step.bill_id), { container_no: '' });
        return { detached: step.container_no };
    }
    if (step.op === 'attach-container') {
        await bills.editBill(realBill(step.bill_id), { container_no: step.container_no });
        return { attached: step.container_no };
    }
    if (step.op === 'delete-bill') {
        await bills.deleteBill(realBill(step.bill_id));
        return { deleted: realBill(step.bill_id) };
    }
    // ── allocations IS A REPLACEMENT, NOT AN APPEND ──────────────────────
    // editBillPayment takes the WHOLE allocations array. My first version
    // invented `{append:true}` and `{unallocate:id}`, neither of which
    // exists — the append would have WIPED every other allocation on that
    // payment, quietly un-settling other containers, and the unallocate
    // would have been ignored as an unknown key. So both read the current
    // allocations and hand back the complete new set.
    if (step.op === 'match-payment') {
        const cur = bp.allocationsFor(step.payment_id) || [];
        const id = realBill(step.bill_id);
        const amount = r2(num(step.amount));
        const next = cur.filter((a) => String(a.bill_id) !== String(id))
            .concat([{ bill_id: id, amount: r2(num((cur.find((a) => String(a.bill_id) === String(id)) || {}).amount) + amount) }]);
        await bp.editBillPayment(step.payment_id, { allocations: next });
        return { matched: amount, allocations: next.length };
    }
    if (step.op === 'unmatch-payment') {
        const cur = bp.allocationsFor(step.payment_id) || [];
        const id = realBill(step.bill_id);
        const next = cur.filter((a) => String(a.bill_id) !== String(id));
        if (next.length === cur.length) throw new Error(`payment ${step.payment_id} is not allocated to ${id}`);
        await bp.editBillPayment(step.payment_id, { allocations: next });
        return { unmatched: id };
    }
    throw new Error(`no executor for "${step.op}" — the verifier let through an operation `
        + 'this file cannot perform, which should be impossible');
}

module.exports = { apply, readWorld, snapshot, rollback, sameDiff, alreadyApplied, filesAtRisk, runStep };
