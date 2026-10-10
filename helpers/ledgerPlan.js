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
        reversible: true,
    },
    'detach-container': {
        needs: ['bill_id', 'container_no'],
        optional: ['note'],
        what: (o) => `take container ${o.container_no} off bill ${o.bill_id}`,
        reversible: true,
    },
    'attach-container': {
        needs: ['bill_id', 'container_no'],
        optional: ['note'],
        what: (o) => `put container ${o.container_no} on bill ${o.bill_id}`,
        reversible: true,
    },
    // ── DELETE. HER CALL, 2026-10-08: "add delete option" ────────────────
    // I had left it out and written a test asserting the vocabulary had no
    // delete in it, on the argument that accounting corrects by reversing.
    // She asked for it; it is her ledger and her decision, and the argument
    // was never that delete is unthinkable — helpers/ledgerBulkDelete.js
    // has existed since 2026-09-29 because she asked for it then too.
    //
    // So this is not a new delete. It is the AGENT reaching the one that
    // already exists, and inheriting its doctrine wholesale: plan, commit,
    // restore, never a bare splice. That file's header lists the two quiet
    // failures a bare delete causes — orphaned money (a payment allocated
    // to an id nothing answers to, so it stops being attached to a cost
    // without showing as missing anywhere) and no way back.
    //
    // The verifier below therefore refuses a delete that would orphan a
    // payment, and the container check already refuses one that would make
    // a container's cost disappear. Those two refusals are what make this
    // safe to hand to a model; without them it is the most dangerous
    // operation in the vocabulary by a distance.
    'delete-bill': {
        needs: ['bill_id'],
        optional: ['note'],
        what: (o) => `delete bill ${o.bill_id}`,
        // Reversible because ledgerBulkDelete.js archives the row — see
        // reverseOf, which emits `restore-bill` rather than a re-create.
        reversible: true,
    },
    'match-payment': {
        needs: ['payment_id', 'bill_id', 'amount'],
        optional: ['note'],
        what: (o) => `apply ${o.amount} of payment ${o.payment_id} to bill ${o.bill_id}`,
        reversible: true,
    },
    'unmatch-payment': {
        needs: ['payment_id', 'bill_id'],
        optional: ['note'],
        what: (o) => `take payment ${o.payment_id} back off bill ${o.bill_id}`,
        reversible: true,
    },

    // ── THE CARRIERS, AND THE THREE WHOSE BUTTON HAS AN EXECUTOR ─────────
    // Added 2026-10-10 so the bank review queue's "Add as a carrier bill"
    // reaches something. It had no executor at all — bankReview.js offered
    // the button for ten haulers and the vocabulary had no carrier
    // operation in it.
    //
    // Scope, deliberately narrow: helpers/carrierInvoices.js, whose
    // CARRIERS are tql / ntg / schneider. The other seven haulers live in
    // helpers/partyInvoices.js, which is a REGISTER fed from her Google
    // sheet by upsertMany() — no single-row add, and a lock. Those are
    // excluded here and in bankReview.js, because a row invented from a
    // bank descriptor is the exact record the sheet reconciliation then
    // reports as "NOT on the sheet".
    //
    // ── AND NEITHER ONE CAN BE UNDONE ────────────────────────────────────
    // This is the uncomfortable part, and it is declared rather than
    // papered over. carrierInvoices.js exports addManual and payManual and
    // NOTHING THAT REVERSES EITHER — no delete, no un-pay. The header above
    // reverseOf used to say "every operation has an inverse, and the
    // vocabulary was chosen so that it does"; these two are the first that
    // do not, so `reversible: false` is a field on the op rather than a
    // remark, reverseOf emits an explicit refusal step instead of silently
    // skipping them, and reversibility() lets the screen warn her BEFORE
    // she approves rather than after.
    //
    // Giving carrierInvoices.js a delete would make them reversible. That
    // is a widening of a store the Transport tab already uses, so it is
    // hers to say yes to — CLAUDE.md §1 — and not something to slip in
    // under a feature she asked for elsewhere.
    'create-carrier-invoice': {
        needs: ['carrier', 'ref', 'amount'],
        optional: ['invoice_date', 'lane', 'note'],
        what: (o) => `add a carrier bill: ${String(o.carrier || '').toUpperCase()} `
            + `${o.ref} for ${num(o.amount).toFixed(2)}`,
        reversible: false,
        why_not: 'carrierInvoices.js has no delete — a carrier bill added by a plan '
            + 'cannot be removed by one',
    },
    'pay-carrier-invoice': {
        needs: ['carrier_invoice_id', 'amount', 'date'],
        optional: ['mode', 'bank', 'ref', 'note'],
        what: (o) => `pay ${num(o.amount).toFixed(2)} against carrier bill `
            + `${o.carrier_invoice_id} on ${o.date}`,
        reversible: false,
        why_not: 'carrierInvoices.js has no un-pay — payManual only ever appends',
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

    // ── THE CARRIER SIDE OF THE WORLD ───────────────────────────────────
    // `carrierNames` is passed IN rather than required from
    // carrierInvoices.js, for the same reason `bills` is: this function has
    // to be runnable against a hypothetical. It also means the list cannot
    // drift from the store — readWorld() reads it from the module itself,
    // and a carrier the store would refuse is refused here instead, where
    // she can still see why.
    const carriers = Array.isArray(world.carrierInvoices) ? world.carrierInvoices : [];
    const carrierNames = Array.isArray(world.carrierNames) ? world.carrierNames : [];

    const billById = new Map(bills.map((b) => [String(b.id), b]));
    const payById = new Map(payments.map((p) => [String(p.id), p]));
    const ciById = new Map(carriers.map((c) => [String(c.id), c]));
    const created = new Set();      // indices that create a bill
    const createdCI = new Set();    // indices that create a carrier invoice

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
        // ── THE CARRIER THE STORE WILL ACTUALLY TAKE ────────────────────
        // carrierInvoices.validate() refuses a carrier outside its own
        // list, an empty ref and an amount of zero. Checked HERE as well,
        // against the same list read from the same module, because the
        // alternative is the shape CLAUDE.md names: a plan that verifies,
        // is previewed, is approved, and only then comes back "carrier
        // must be one of tql, ntg, schneider".
        if (s.op === 'create-carrier-invoice') {
            createdCI.add(i);
            const c = String(s.carrier || '').trim().toLowerCase();
            // No list means the store could not be read, and a carrier
            // name cannot be checked against nothing. Refused rather than
            // waved through: `carrierNames.length && ...` would have
            // SKIPPED the check in exactly the case where it matters, and
            // a validation that disappears when its input is missing is
            // the quietest way to let a bad value through.
            if (!carrierNames.length) {
                bad(i, 'Jarvis cannot read the carrier list, so it will not add a carrier bill');
            } else if (c && !carrierNames.includes(c)) {
                bad(i, `"${s.carrier}" is not a carrier Jarvis can bill — it takes `
                    + `${carrierNames.join(', ')}. The other haulers (Zimex, AJ Transport, `
                    + 'Sher, Jio, Garduno\'s, Pan Metal, Eagle) are in the party register, '
                    + 'which is fed from your sheet — pay those from the Transport tab');
            }
            if (s.ref !== undefined && !String(s.ref).trim()) bad(i, 'a carrier bill needs a ref');
            if (num(s.amount) <= CENT) bad(i, 'a carrier bill needs an amount greater than zero');
            if (s.invoice_date && !ISO.test(String(s.invoice_date))) {
                bad(i, `"${s.invoice_date}" is not a date as YYYY-MM-DD`);
            }
        }
        if (s.op === 'pay-carrier-invoice') {
            if (num(s.amount) <= CENT) bad(i, 'a carrier payment needs an amount greater than zero');
            // payManual throws on anything that is not YYYY-MM-DD, so an
            // unparseable date must not reach it.
            if (s.date !== undefined && !ISO.test(String(s.date))) {
                bad(i, `"${s.date}" is not a date as YYYY-MM-DD`);
            }
        }
        // Reference resolution. A forward reference is a cycle.
        for (const k of ['bill_id', 'payment_id', 'carrier_invoice_id']) {
            const v = s[k];
            if (v === undefined) continue;
            if (isRef(v)) {
                const j = refIndex(v);
                if (!(j >= 0 && j < steps.length)) { bad(i, `${v} points at no step`); continue; }
                if (j >= i) { bad(i, `${v} points at step ${j + 1}, which has not happened yet`); continue; }
                if (k === 'bill_id' && !created.has(j)) bad(i, `${v} is not a step that creates a bill`);
                if (k === 'carrier_invoice_id' && !createdCI.has(j)) {
                    bad(i, `${v} is not a step that creates a carrier bill`);
                }
                continue;
            }
            if (k === 'bill_id' && !billById.has(String(v))) bad(i, `there is no bill ${v}`);
            if (k === 'payment_id' && !payById.has(String(v))) bad(i, `there is no payment ${v}`);
            if (k === 'carrier_invoice_id' && !ciById.has(String(v))) {
                bad(i, `there is no carrier bill ${v}`);
            }
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
    const sim = simulateInto(steps, { bills, payments, carrierInvoices: carriers });
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
    const carriers = (world.carrierInvoices || []).map((c) => ({ ...c }));
    const byId = new Map(bills.map((b) => [String(b.id), b]));
    const payById = new Map(payments.map((p) => [String(p.id), p]));
    const ciById = new Map(carriers.map((c) => [String(c.id), c]));
    const madeCIAt = new Map();     // step index → the carrier bill it created
    const problems = [];
    const madeAt = new Map();      // step index → the bill it created
    // ── EVERY CONTAINER THE PLAN DISTURBS, HOWEVER IT DISTURBS IT ───────
    // Collected during simulation, NOT read off the plan text. The first
    // version gathered them from `steps.filter(s => s.container_no)` — so a
    // bare `delete-bill` never mentioned its cargo, the orphan check below
    // never considered it, and deleting a bill with a container on it made
    // that container's cost vanish with no complaint. The dangerous shape:
    // a safety check that cannot see the case it exists for.
    const disturbed = new Set();
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
            disturbed.add(c);
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
            disturbed.add(c);
            if (!b.containers.includes(c)) b.containers.push(c);
            return;
        }
        if (s.op === 'delete-bill') {
            const b = resolveBill(s.bill_id, i);
            if (!b) return bad(i, `bill ${s.bill_id} is not there to delete`);
            // ── ORPHANED MONEY, THE FAILURE THAT HIDES ──────────────────
            // ledgerBulkDelete.js's header names it: a payment reaches a
            // bill through its allocations, so deleting the bill leaves
            // the payment allocated to an id nothing answers to. The money
            // left the account and belongs to no container — it does not
            // show as missing anywhere, it simply stops being a cost.
            const stuck = payments.filter((p) => (p.applied || [])
                .some((a) => String(a.bill_id) === String(b.id)));
            if (stuck.length) {
                return bad(i, `bill ${b.id} has ${stuck.length} payment(s) against it `
                    + `(${stuck.map((p) => p.id).join(', ')}) — unmatch them first, or the money `
                    + 'is left pointing at a bill that no longer exists');
            }
            // Its containers become homeless here; the plan-wide check at
            // the end is what catches that, so a delete is allowed when
            // the plan re-homes them and refused when it does not. They
            // have to be ADDED to `disturbed` for that check to see them —
            // the delete step never names them.
            for (const c of (b.containers || [])) disturbed.add(String(c));
            b.containers = [];
            b.deleted = true;
            const at = bills.indexOf(b);
            if (at > -1) bills.splice(at, 1);
            byId.delete(String(b.id));
            return;
        }
        if (s.op === 'match-payment') {
            const b = resolveBill(s.bill_id, i);
            const p = payById.get(String(s.payment_id));
            if (!b) return bad(i, `bill ${s.bill_id} is not there to match against`);
            if (!p) return bad(i, `there is no payment ${s.payment_id}`);
            // ── THE REFUSAL THAT LIVES IN ANOTHER FILE ──────────────────
            // billPayments.editBillPayment REFUSES a payment already linked
            // into QuickBooks — her rule, 2026-10-07: "Refuse, and tell me
            // to change both", because an edit here alone leaves her books
            // and Jarvis disagreeing with nothing recording who moved what.
            //
            // The verifier knew nothing about it, so a plan touching a
            // linked payment would verify, be previewed, be approved, and
            // only THEN fail — CLAUDE.md's named trap, a requirement in
            // shared code that one caller cannot satisfy, discovered by
            // whoever happens to use that path. Checked here instead,
            // while she can still do something about it.
            if (p.qb_linked) {
                return bad(i, `payment ${p.id} is already in QuickBooks — change it in both, or `
                    + 'remove it there first. Jarvis will not edit one side on its own');
            }
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
            // Same gate as match-payment, and for the same reason — taking
            // an allocation OFF a QuickBooks-linked payment desynchronises
            // the two sides exactly as putting one on does.
            if (p.qb_linked) {
                return bad(i, `payment ${p.id} is already in QuickBooks — change it in both, or `
                    + 'remove it there first. Jarvis will not edit one side on its own');
            }
            const b = resolveBill(s.bill_id, i);
            const before = p.applied.length;
            p.applied = p.applied.filter((a) => String(a.bill_id) !== String(b ? b.id : s.bill_id));
            if (p.applied.length === before) {
                bad(i, `payment ${p.id} is not applied to bill ${s.bill_id}, so there is nothing to undo`);
            }
            return;
        }
        // ── THE CARRIER SIDE ────────────────────────────────────────────
        // Three refusals, each one mirroring a throw inside
        // carrierInvoices.js. They are mirrored rather than discovered at
        // apply time because a plan is approved on its preview: a refusal
        // that only surfaces during the apply is a refusal she sees after
        // committing, and the rollback then has to be trusted instead of
        // avoided.
        if (s.op === 'create-carrier-invoice') {
            seq += 1;
            const carrier = String(s.carrier || '').trim().toLowerCase();
            const ref = String(s.ref || '').trim();
            const key = `${carrier}:${ref}`;
            // addManual THROWS on a duplicate carrier+ref rather than
            // merging — "open that row instead of adding it again". Rows
            // created EARLIER IN THIS PLAN count, so a plan that adds the
            // same invoice twice is caught before the first write.
            if (carriers.some((c) => c && !c.gone
                && `${String(c.carrier || '').toLowerCase()}:${String(c.ref || '').trim()}` === key)) {
                return bad(i, `${carrier.toUpperCase()} ${ref} is already on the carrier list — `
                    + 'open that row instead of adding it again');
            }
            const c = { id: `NEWCI_${seq}`, carrier, ref, amount: r2(num(s.amount)),
                paid: 0, status: 'open', source: 'manual', isNew: true };
            carriers.push(c); ciById.set(c.id, c); madeCIAt.set(i, c);
            return;
        }
        if (s.op === 'pay-carrier-invoice') {
            const c = isRef(s.carrier_invoice_id)
                ? madeCIAt.get(refIndex(s.carrier_invoice_id))
                : ciById.get(String(s.carrier_invoice_id));
            if (!c) return bad(i, `carrier bill ${s.carrier_invoice_id} is not there to pay`);
            // ── THE IMPORTED ROW, AND WHY IT IS REFUSED ─────────────────
            // payManual refuses any row whose source is not 'manual': an
            // imported row's truth is the carrier's own remittance mail,
            // and recording a payment here would create a second answer to
            // "is this paid" that disagrees the first time a remittance
            // arrives late. The verifier has to know that, or every
            // imported row gets a button that fails.
            if (c.source !== 'manual') {
                return bad(i, `${String(c.carrier || '').toUpperCase()} ${c.ref} came from the `
                    + 'carrier\'s own email, so what it says is paid comes from their '
                    + 'remittance — record this where the money left instead');
            }
            const want = r2(num(s.amount));
            const paid = r2(num(c.paid) + want);
            if (paid > r2(num(c.amount)) + CENT) {
                return bad(i, `that would pay ${paid.toFixed(2)} against a carrier bill of `
                    + `${r2(num(c.amount)).toFixed(2)}`);
            }
            c.paid = paid;
            c.status = paid + CENT >= r2(num(c.amount)) ? 'paid' : 'part';
            return;
        }
    });

    // ── AND THE INVARIANT THAT SPANS THE WHOLE PLAN ─────────────────────
    // A container taken off one bill and put on no other has vanished from
    // cost of sales entirely. Her sentence always pairs the two, but a
    // plan that drops the second half is exactly the shape a half-finished
    // generation produces, and it understates her costs silently.
    for (const c of disturbed) {
        if (!containerHome(bills, c)) {
            problems.push({ step: 0, why: `container ${c} would end up on no bill at all — `
                + 'its cost would disappear from the books' });
        }
    }

    return { problems, bills, payments, carriers,
        diff: diffOf(world, { bills, payments }),
        // ── A SECOND ARRAY, NOT MORE ROWS IN THE FIRST ──────────────────
        // A supplier row and a carrier row have different keys, and one
        // array holding both shapes is the thing every consumer then has
        // to branch on — including ledgerApply.sameDiff, whose comparison
        // reads r.supplier and would read `undefined` for every carrier
        // row and so compare them all as equal. That is a world-moved
        // check with a hole in it, which is worse than not having one.
        carrierDiff: carrierDiffOf(world.carrierInvoices || [], carriers) };
}

// Per carrier, the same three figures she acts on. Separate from diffOf
// because the carrier store has no containers and no supplier.
function carrierDiffOf(before, after) {
    const roll = (rows) => {
        const m = new Map();
        for (const c of rows || []) {
            const k = String(c.carrier || '(no carrier)').toLowerCase();
            const cur = m.get(k) || { carrier: k, billed: 0, paid: 0, invoices: 0 };
            cur.billed += num(c.amount); cur.paid += num(c.paid); cur.invoices += 1;
            m.set(k, cur);
        }
        return m;
    };
    const a = roll(before);
    const b2 = roll(after);
    const rows = [];
    for (const n of new Set([...a.keys(), ...b2.keys()])) {
        const x = a.get(n) || { billed: 0, paid: 0, invoices: 0 };
        const y = b2.get(n) || { billed: 0, paid: 0, invoices: 0 };
        const row = {
            carrier: n,
            billed: { before: r2(x.billed), after: r2(y.billed), change: r2(y.billed - x.billed) },
            paid: { before: r2(x.paid), after: r2(y.paid), change: r2(y.paid - x.paid) },
            owed: { before: r2(x.billed - x.paid), after: r2(y.billed - y.paid),
                    change: r2((y.billed - y.paid) - (x.billed - x.paid)) },
            invoices: { before: x.invoices, after: y.invoices },
        };
        if (row.billed.change || row.paid.change || row.invoices.before !== row.invoices.after) {
            rows.push(row);
        }
    }
    return rows.sort((p, q) => Math.abs(q.owed.change) - Math.abs(p.owed.change));
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

// ── WHAT GETS WRITTEN DOWN ──────────────────────────────────────────────
// Apsara, 2026-10-08: "make it log every change we are doing in qb/books so
// that we can check it later."
//
// helpers/audit.js already exists and is append-only — nothing in the
// codebase deletes from it, deliberately, because a profile that can erase
// a paid load can erase the evidence that money moved. This produces the
// RECORD; audit.js stores it. Separated for the usual reason: a function
// that both decides and persists cannot be run to see what it would say.
//
// ── WHAT A USEFUL ENTRY HAS IN IT ───────────────────────────────────────
// "Bill BILL_914 updated" is the log everyone writes and nobody can use. In
// March the question is never what changed, it is WHY, WHO asked, and what
// the figures were on either side. So an entry carries four things:
//
//   asked     her sentence, verbatim. The agent's reading of it is an
//             interpretation; this is the thing she actually typed, and it
//             is the only part no later bug can corrupt.
//   plan      the typed operations, so the interpretation can be judged
//             against the sentence rather than taken on trust.
//   diff      what each supplier was owed before and after. The figure she
//             would have checked at the time, preserved at the time.
//   reverse   the plan that undoes it. Recorded BEFORE applying, because
//             after a bad apply is exactly when it cannot be computed.
function auditRecord({ asked, plan, verification, actor = null, at = new Date() } = {}) {
    const v = verification || {};
    return {
        kind: 'ledger-plan',
        at: at.toISOString(),
        actor: actor || null,
        // Her words, untouched. Truncated only to keep one entry from
        // filling the log, and the truncation is visible.
        asked: String(asked || '').slice(0, 1000),
        truncated: String(asked || '').length > 1000,
        steps: describe(plan),
        plan: Array.isArray(plan) ? plan : [],
        ok: !!v.ok,
        problems: v.problems || [],
        // Only present when it verified — a diff from a plan that was
        // refused would read as something that happened.
        diff: v.ok && v.simulation ? v.simulation.diff : null,
        carrierDiff: v.ok && v.simulation ? (v.simulation.carrierDiff || []) : null,
    };
}

// ── WHICH OF THESE CAN BE TAKEN BACK ────────────────────────────────────
// Asked BEFORE she approves, not after. Returned as its own answer rather
// than folded into the reverse plan, because "this cannot be undone" is
// something the confirmation screen has to be able to say in advance — by
// the time she is looking for the Undo button it is not information, it is
// an apology.
function reversibility(plan) {
    const steps = Array.isArray(plan) ? plan : [];
    const stuck = [];
    steps.forEach((s, i) => {
        const spec = OPS[s && s.op];
        // An op that is not in the vocabulary is not reversible either, and
        // saying so is better than treating the unknown as harmless.
        if (!spec) { stuck.push({ step: i + 1, op: s && s.op, why: 'not an operation Jarvis performs' }); return; }
        if (spec.reversible !== true) {
            stuck.push({ step: i + 1, op: s.op, why: spec.why_not || 'no inverse exists' });
        }
    });
    return { ok: stuck.length === 0, irreversible: stuck };
}

// ── THE UNDO ────────────────────────────────────────────────────────────
// `idMap` carries the real ids the apply layer created, because a reverse
// plan referring to "#2" undoes nothing once the plan is real.
//
// This used to open "every operation has an inverse, and the vocabulary was
// chosen so that it does". That stopped being true on 2026-10-10, when the
// two carrier operations arrived against a store with no delete and no
// un-pay. The chain below therefore ends in an explicit `cannot-undo`
// step rather than falling off the end:
//
// `cannot-undo` is deliberately NOT in OPS, so verify() refuses the whole
// reverse plan with "is not an operation Jarvis will perform" and NOTHING
// is applied. A partial undo — the reversible half run, the rest silently
// dropped — is the worst of the three outcomes, because the books end up in
// a state neither she nor the plan describes. Before this, an op the chain
// did not recognise was skipped without a word, so an undo containing one
// would have reported success having undone only some of it.
//
// Reversed in REVERSE ORDER, which is the part that is easy to get wrong:
// undoing a detach before undoing the attach that followed it would put a
// container on two bills on the way back, and the verifier would refuse
// its own undo.
function reverseOf(plan, idMap = {}) {
    const real = (v) => (isRef(v) && idMap[v] ? idMap[v] : v);
    const out = [];
    for (let i = (Array.isArray(plan) ? plan.length : 0) - 1; i >= 0; i -= 1) {
        const s = plan[i];
        if (s.op === 'create-bill') {
            out.push({ op: 'delete-bill', bill_id: idMap[`#${i + 1}`] || `#${i + 1}`,
                note: 'undo: this bill was created by a plan' });
        } else if (s.op === 'detach-container') {
            out.push({ op: 'attach-container', bill_id: real(s.bill_id), container_no: s.container_no,
                note: 'undo: put it back where it was' });
        } else if (s.op === 'attach-container') {
            out.push({ op: 'detach-container', bill_id: real(s.bill_id), container_no: s.container_no,
                note: 'undo: take it off again' });
        } else if (s.op === 'match-payment') {
            out.push({ op: 'unmatch-payment', payment_id: s.payment_id, bill_id: real(s.bill_id),
                note: 'undo: unapply this payment' });
        } else if (s.op === 'unmatch-payment') {
            out.push({ op: 'match-payment', payment_id: s.payment_id, bill_id: real(s.bill_id),
                amount: num(s.amount), note: 'undo: reapply this payment' });
        } else if (s.op === 'delete-bill') {
            // ── THE ONE THAT CANNOT BE EXPRESSED IN THE VOCABULARY ──────
            // Un-deleting is a RESTORE, not a create: the bill had an id,
            // a history and its own fields, and re-creating it would make
            // a different record wearing the same supplier's name.
            // ledgerBulkDelete.js already archives a deleted row for
            // exactly this, so the undo is a restore from that archive and
            // the entry says so rather than pretending otherwise.
            out.push({ op: 'restore-bill', bill_id: real(s.bill_id),
                note: 'undo: restore from the delete archive, not re-create' });
        } else {
            // Everything else, including the two carrier operations and any
            // op added later without an inverse. Loud, and fatal to the
            // whole reverse plan by design.
            const spec = OPS[s.op] || {};
            out.push({ op: 'cannot-undo', was: s.op, step: i + 1,
                why: spec.why_not || `there is no inverse for "${s.op}"` });
        }
    }
    return out;
}

module.exports = { OPS, verify, simulateInto, describe, diffOf, carrierDiffOf,
    containersOf, containerHome, auditRecord, reverseOf, reversibility, CENT };
