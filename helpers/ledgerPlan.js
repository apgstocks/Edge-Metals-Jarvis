// ── helpers/ledgerPlan.js — what the agent is allowed to propose ──────────
//
// Apsara, 2026-10-08, on what the QuickBooks agent should be able to do:
//
//   "you can even tell like remove this container from the <billno> billed
//    on 30-dec-25 and add this container by creating a new bill <bill> on
//    3-jan-26 and then match it with this payment(partial/full)"
//
// That one sentence is four writes across three stores, and if it goes half
// way her books are worse than before she asked. So this file is the thing
// standing between her sentence and her ledger.
//
// ── THE ARCHITECTURE, AND WHY IT IS THIS ONE ────────────────────────────
// She asked for references. The research on agents that touch financial
// records converges on one structural answer: SEPARATE THE PROPOSAL FROM
// THE VERIFICATION, and make the verifier symbolic rather than another
// model. VerAct (two-layer: neural proposal, symbolic safety check via SMT)
// argues it directly — LLMs plan by statistical pattern matching, so a plan
// can read perfectly and still violate an invariant. FinHarness adds the
// per-tool-call risk gate for finance agents specifically, and the
// plan-then-execute literature adds the human confirmation packet for
// high-risk or low-confidence actions. The deterministic-execution work on
// financial workflows makes the same point from the engineering side: let
// the model be non-deterministic, make the execution not.
//
// Translated into this repo, five layers:
//
//   1 UNDERSTAND   the model resolves her words to REAL record ids by
//                  looking them up. It may not invent an id. Not here.
//   2 PROPOSE      the model emits a PLAN: an ordered list of operations
//                  from the fixed vocabulary below, with concrete ids and
//                  amounts. No free text, no code. Not here.
//   3 VERIFY       deterministic, no model. Every invariant below. HERE.
//   4 PREVIEW      simulate and show the diff — what each supplier is owed
//                  before and after. HERE.
//   5 APPLY        through the existing tested helpers, atomically, with a
//                  reverse plan recorded so one press undoes it. Not here.
//
// This file is layers 3 and 4, deliberately built first and deliberately
// containing no model call at all. If the verifier is right, a wrong plan
// is caught whatever produced it — a bad prompt, a model upgrade, a
// prompt-injection in a supplier's name. If the verifier is wrong, nothing
// else matters.
//
// ── NOTHING HERE WRITES ─────────────────────────────────────────────────
// Pure. verify() returns problems; simulate() returns a diff. Applying is
// somebody else's job, and keeping it that way is what lets a plan be
// examined before it is real.

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const CENT = 0.005;

// ── THE VOCABULARY ──────────────────────────────────────────────────────
// Fixed and small. An agent that can emit arbitrary operations is an agent
// that can do arbitrary damage, and every entry here had to be argued for.
//
// Note what is NOT here: there is no `delete`. Accounting corrects by
// REVERSING, never by erasing — the audit trail is the point, and
// helpers/audit.js already records that a profile which can erase a paid
// load can erase the evidence that money moved. `detach-container` moves a
// container off a bill; the bill itself survives with its history.
const OPS = {
    'create-bill': {
        needs: ['supplier', 'date'],
        optional: ['container_no', 'booking_no', 'invoice_no', 'supplier_price', 'price_unit', 'note'],
        what: (o) => `create a bill for ${o.supplier} dated ${o.date}`,
    },
    'detach-container': {
        needs: ['bill_id', 'container_no'],
        optional: ['note'],
        what: (o) => `take container ${o.container_no} off bill ${o.bill_id}`,
    },
    'attach-container': {
        needs: ['bill_id', 'container_no'],
        optional: ['note'],
        what: (o) => `put container ${o.container_no} on bill ${o.bill_id}`,
    },
    'match-payment': {
        needs: ['payment_id', 'bill_id', 'amount'],
        optional: ['note'],
        what: (o) => `apply ${o.amount} of payment ${o.payment_id} to bill ${o.bill_id}`,
    },
    'unmatch-payment': {
        needs: ['payment_id', 'bill_id'],
        optional: ['note'],
        what: (o) => `take payment ${o.payment_id} back off bill ${o.bill_id}`,
    },
};

// A plan may refer to a record it is about to create. `#1` means "whatever
// operation 1 creates" — resolved during verification, so the model never
// has to invent an id, which is the single most common way these plans go
// wrong. A reference to an operation that comes LATER is a cycle and is
// refused.
const isRef = (v) => typeof v === 'string' && /^#\d+$/.test(v);
const refIndex = (v) => Number(String(v).slice(1)) - 1;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// ── LAYER 3: VERIFY ─────────────────────────────────────────────────────
// Deterministic. Every problem is returned with the step it came from, so
// the screen can point at the line rather than saying "invalid plan".
//
// `world` is what EXISTS: { bills: [...], payments: [...] }, read fresh by
// the caller. Passed in rather than read here, so this function can be run
// against a hypothetical and tested without a store.
function verify(plan, world = {}) {
    const steps = Array.isArray(plan) ? plan : [];
    const bills = Array.isArray(world.bills) ? world.bills : [];
    const payments = Array.isArray(world.payments) ? world.payments : [];
    const problems = [];
    const bad = (i, why) => problems.push({ step: i + 1, why });

    if (!steps.length) return { ok: false, problems: [{ step: 0, why: 'the plan is empty' }] };

    const billById = new Map(bills.map((b) => [String(b.id), b]));
    const payById = new Map(payments.map((p) => [String(p.id), p]));
    const created = new Set();      // indices that create a bill

    // ── PASS 1: is each step well formed, and do its ids exist? ─────────
    steps.forEach((s, i) => {
        const spec = OPS[s && s.op];
        if (!spec) { bad(i, `"${s && s.op}" is not an operation Jarvis will perform`); return; }
        for (const k of spec.needs) {
            if (s[k] === undefined || s[k] === null || s[k] === '') bad(i, `${s.op} needs ${k}`);
        }
        const allowed = new Set(['op', ...spec.needs, ...(spec.optional || [])]);
        for (const k of Object.keys(s)) {
            if (!allowed.has(k)) bad(i, `${s.op} does not take "${k}" — it would be silently ignored`);
        }
        if (s.op === 'create-bill') {
            created.add(i);
            if (s.date && !ISO.test(String(s.date))) bad(i, `"${s.date}" is not a date as YYYY-MM-DD`);
        }
        // Reference resolution. A forward reference is a cycle.
        for (const k of ['bill_id', 'payment_id']) {
            const v = s[k];
            if (v === undefined) continue;
            if (isRef(v)) {
                const j = refIndex(v);
                if (!(j >= 0 && j < steps.length)) { bad(i, `${v} points at no step`); continue; }
                if (j >= i) { bad(i, `${v} points at step ${j + 1}, which has not happened yet`); continue; }
                if (k === 'bill_id' && !created.has(j)) bad(i, `${v} is not a step that creates a bill`);
                continue;
            }
            if (k === 'bill_id' && !billById.has(String(v))) bad(i, `there is no bill ${v}`);
            if (k === 'payment_id' && !payById.has(String(v))) bad(i, `there is no payment ${v}`);
        }
        if (s.op === 'match-payment' && num(s.amount) <= CENT) {
            bad(i, 'a match needs an amount greater than zero');
        }
    });
    if (problems.length) return { ok: false, problems };

    // ── PASS 2: the invariants, simulated step by step ──────────────────
    // Checked on a MODEL of the world rather than on each step in
    // isolation, because the dangerous mistakes are only visible in
    // sequence: detaching a container and never re-attaching it, or
    // applying two payments that are each fine and together overpay.
    const sim = simulateInto(steps, { bills, payments });
    problems.push(...sim.problems);

    return { ok: problems.length === 0, problems, simulation: sim };
}

// ── LAYER 4: SIMULATE ───────────────────────────────────────────────────
// Walks the plan against copies and reports both the invariant breaches
// and the DIFF she will be shown. Returning the diff is the point: a
// confirmation screen that says "4 operations" is not a confirmation, and
// a plan is only safe to approve if you can see what it does to the
// figures you care about.
function simulateInto(steps, world) {
    const bills = world.bills.map((b) => ({ ...b, containers: containersOf(b) }));
    const payments = world.payments.map((p) => ({ ...p, applied: [...(p.applied || [])] }));
    const byId = new Map(bills.map((b) => [String(b.id), b]));
    const payById = new Map(payments.map((p) => [String(p.id), p]));
    const problems = [];
    const madeAt = new Map();      // step index → the bill it created
    const bad = (i, why) => problems.push({ step: i + 1, why });

    const resolveBill = (v, i) => {
        if (isRef(v)) return madeAt.get(refIndex(v)) || null;
        return byId.get(String(v)) || null;
    };

    let seq = 0;
    steps.forEach((s, i) => {
        if (s.op === 'create-bill') {
            seq += 1;
            const b = { id: `NEW_${seq}`, supplier: s.supplier, date: s.date,
                containers: s.container_no ? [String(s.container_no)] : [],
                amount: 0, isNew: true };
            bills.push(b); byId.set(b.id, b); madeAt.set(i, b);
            return;
        }
        if (s.op === 'detach-container') {
            const b = resolveBill(s.bill_id, i);
            if (!b) return bad(i, `bill ${s.bill_id} is not there to take a container off`);
            const c = String(s.container_no);
            if (!b.containers.includes(c)) {
                return bad(i, `container ${c} is not on bill ${b.id} — it is on `
                    + (containerHome(bills, c) || 'no bill at all'));
            }
            b.containers = b.containers.filter((x) => x !== c);
            return;
        }
        if (s.op === 'attach-container') {
            const b = resolveBill(s.bill_id, i);
            if (!b) return bad(i, `bill ${s.bill_id} is not there to put a container on`);
            const c = String(s.container_no);
            const home = containerHome(bills, c);
            if (home && home !== b.id) {
                // ── THE ONE THAT WOULD DOUBLE HER COSTS ─────────────────
                // A container on two bills is counted twice in cost of
                // sales, and margin.js keeps only the LAST bill — so the
                // container reads cheaper than it was and the error is in
                // her favour, which is the direction nobody questions.
                // integritySweep already hunts for this after the fact;
                // this refuses to create it.
                return bad(i, `container ${c} is still on bill ${home} — take it off there first, `
                    + 'or it will be billed twice');
            }
            if (!b.containers.includes(c)) b.containers.push(c);
            return;
        }
        if (s.op === 'match-payment') {
            const b = resolveBill(s.bill_id, i);
            const p = payById.get(String(s.payment_id));
            if (!b) return bad(i, `bill ${s.bill_id} is not there to match against`);
            if (!p) return bad(i, `there is no payment ${s.payment_id}`);
            const want = r2(num(s.amount));
            const already = r2(p.applied.reduce((t, a) => t + num(a.amount), 0));
            const free = r2(num(p.amount) - already);
            if (want > free + CENT) {
                return bad(i, `payment ${p.id} has ${free.toFixed(2)} left unapplied and this would `
                    + `apply ${want.toFixed(2)}`);
            }
            p.applied.push({ bill_id: b.id, amount: want });
            return;
        }
        if (s.op === 'unmatch-payment') {
            const p = payById.get(String(s.payment_id));
            if (!p) return bad(i, `there is no payment ${s.payment_id}`);
            const b = resolveBill(s.bill_id, i);
            const before = p.applied.length;
            p.applied = p.applied.filter((a) => String(a.bill_id) !== String(b ? b.id : s.bill_id));
            if (p.applied.length === before) {
                bad(i, `payment ${p.id} is not applied to bill ${s.bill_id}, so there is nothing to undo`);
            }
        }
    });

    // ── AND THE INVARIANT THAT SPANS THE WHOLE PLAN ─────────────────────
    // A container taken off one bill and put on no other has vanished from
    // cost of sales entirely. Her sentence always pairs the two, but a
    // plan that drops the second half is exactly the shape a half-finished
    // generation produces, and it understates her costs silently.
    const touched = new Set(steps.filter((s) => s.container_no).map((s) => String(s.container_no)));
    for (const c of touched) {
        if (!containerHome(bills, c)) {
            problems.push({ step: 0, why: `container ${c} would end up on no bill at all — `
                + 'its cost would disappear from the books' });
        }
    }

    return { problems, bills, payments, diff: diffOf(world, { bills, payments }) };
}

const containersOf = (b) => {
    if (Array.isArray(b.containers)) return b.containers.map(String);
    return b.container_no ? [String(b.container_no)] : [];
};
const containerHome = (bills, c) => {
    const hit = bills.find((b) => (b.containers || []).includes(String(c)));
    return hit ? String(hit.id) : null;
};

// ── WHAT SHE WILL ACTUALLY BE SHOWN ─────────────────────────────────────
// Per supplier, because that is the figure she acts on — "what do we owe
// Hugo" is a question she asks, "four operations succeeded" is not.
function diffOf(before, after) {
    const owed = (bills, payments) => {
        const m = new Map();
        for (const b of bills) {
            const s = String(b.supplier || '(no supplier)');
            const paid = payments.reduce((t, p) => t
                + (p.applied || []).filter((a) => String(a.bill_id) === String(b.id))
                    .reduce((u, a) => u + num(a.amount), 0), 0);
            const cur = m.get(s) || { supplier: s, billed: 0, paid: 0, bills: 0, containers: 0 };
            cur.billed += num(b.amount); cur.paid += paid; cur.bills += 1;
            cur.containers += (b.containers || []).length;
            m.set(s, cur);
        }
        return m;
    };
    const a = owed(before.bills.map((b) => ({ ...b, containers: containersOf(b) })), before.payments);
    const b2 = owed(after.bills, after.payments);
    const names = new Set([...a.keys(), ...b2.keys()]);
    const rows = [];
    for (const n of names) {
        const x = a.get(n) || { billed: 0, paid: 0, bills: 0, containers: 0 };
        const y = b2.get(n) || { billed: 0, paid: 0, bills: 0, containers: 0 };
        const row = {
            supplier: n,
            billed: { before: r2(x.billed), after: r2(y.billed), change: r2(y.billed - x.billed) },
            paid: { before: r2(x.paid), after: r2(y.paid), change: r2(y.paid - x.paid) },
            owed: { before: r2(x.billed - x.paid), after: r2(y.billed - y.paid),
                    change: r2((y.billed - y.paid) - (x.billed - x.paid)) },
            bills: { before: x.bills, after: y.bills },
            containers: { before: x.containers, after: y.containers },
        };
        const moved = row.billed.change || row.paid.change
            || row.bills.before !== row.bills.after || row.containers.before !== row.containers.after;
        if (moved) rows.push(row);
    }
    return rows.sort((p, q) => Math.abs(q.owed.change) - Math.abs(p.owed.change));
}

// One line per step, in her words, for the confirmation screen. The plan is
// not approved by reading JSON.
function describe(plan) {
    return (Array.isArray(plan) ? plan : []).map((s, i) => ({
        step: i + 1,
        op: s.op,
        says: OPS[s.op] ? OPS[s.op].what(s) : `unknown operation "${s.op}"`,
    }));
}

module.exports = { OPS, verify, simulateInto, describe, diffOf, containersOf, containerHome, CENT };
