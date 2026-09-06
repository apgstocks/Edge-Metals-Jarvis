// ── helpers/tools.js — what the assistant can actually do ─────────────────
//
// Apsara, 2026-09-05, on wanting Jarvis to stop feeling like a template:
// "dynamically it should act ... mimicing a assistant behaviour not just
// restricted to standard template."
//
// THE PROBLEM THIS REPLACES
// -------------------------
// The vocabulary was written down TWICE. Once as English prose in
// yardAsk.js's SYSTEM_RULES — a numbered rule listing record_payment,
// create_load and edit_load with their parameters — and once as real code in
// yardActions.js's ACTIONS object. Two files, hand-synced. There is even a
// comment in yardActions.js claiming they are "kept next to the
// implementations so the two cannot drift"; they are not, and only the NAMES
// were ever shared, never the parameter documentation.
//
// That duplication is the template. Every new capability meant editing
// English in one file and JavaScript in another, and when the two disagreed
// the model confidently proposed something that did not exist — which reads
// to the person as the assistant being broken rather than out of date. Six
// features have shipped since those three actions were written (trucker
// bills, expenses, petty cash, the spend report, the inventory drill-down,
// sales) and the assistant knows about none of them.
//
// ONE REGISTRY, AND THE PROMPT IS GENERATED FROM IT
// -------------------------------------------------
// A tool is one object: name, description, parameter schema, handler. The
// text the model reads is built by describeTools() from these same objects,
// so the prompt cannot lag behind the code. Adding a capability is adding an
// entry.
//
// READ RUNS, WRITE PROPOSES
// -------------------------
// The split is the whole safety story, and it is what lets the assistant feel
// dynamic without becoming dangerous:
//
//   kind: 'read'   — runs IMMEDIATELY, no confirmation. Looking something up
//                    changes nothing, and making someone confirm a lookup is
//                    what made this feel like a form to fill in.
//   kind: 'write'  — builds a proposal and returns it. Nothing is written
//                    until the person confirms, exactly as before.
//
// The dangerous class is not "actions", it is IRREVERSIBLE actions. Reading
// the spend report is free to get wrong. Sending a supplier an email is not.
// So the boundary is drawn there rather than around the word "action".
//
// WHAT IS DELIBERATELY ABSENT
// ---------------------------
// No delete tool, of any kind. No send-email or send-WhatsApp tool. Those are
// the two categories with no undo — a deleted payment cannot be recovered
// from a screen, and a sent message cannot be unsent from a yard. They stay
// out of the assistant's reach entirely rather than behind a confirmation,
// because a confirmation is one mistaken tap and voice input mishears names.
// Adding either should be a decision someone makes on purpose, with this
// paragraph in front of them.

const money = (n) => `$${(Math.round(Number(n) * 100) / 100).toFixed(2)}`;
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const str = (v) => String(v == null ? '' : v).trim();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// A read tool's answer is fed back into a prompt, so it has to be small. An
// unbounded list is a slow, expensive turn and gives the model more room to
// drift; it is also almost never what the question needed.
const MAX_ROWS = 40;
const cap = (rows) => {
    const list = Array.isArray(rows) ? rows : [];
    return list.length > MAX_ROWS
        ? { rows: list.slice(0, MAX_ROWS), truncated: true, total: list.length }
        : { rows: list, truncated: false, total: list.length };
};

// ── the registry ──────────────────────────────────────────────────────────
// `params` is documentation AND validation in one place. Each entry:
//   type      — 'string' | 'number' | 'date' | 'boolean' | 'array'
//   required  — refuse without it, naming what is missing
//   describe  — the sentence the model reads
const TOOLS = {

    // ══ READ ═══════════════════════════════════════════════════════════════
    // These are the ones that make it an assistant rather than a form. Until
    // now the model was handed one pre-computed digest and could not go and
    // look at anything else — so a question the digest did not anticipate got
    // "that is not in the data I have", which is true and useless.

    // ── BOOKINGS ─────────────────────────────────────────────────────────
    // Apsara, 2026-09-06: "when i ask about bookings, it doesnt have any
    // idea." It did not, and the reason was structural rather than subtle:
    // this registry shipped with seven read tools covering loads, inventory,
    // trucker bills, spend and petty cash, and NONE for bookings — which are
    // the centre of the whole application. helpers/booking.js, the workflow
    // folder and the entire container pipeline are built on them.
    //
    // So the model was not being evasive. It had no instrument pointed at
    // the data, and a tool registry's whole promise is that a capability
    // exists exactly where it is declared. This was a hole in the map.
    //
    // Read-only, like everything else in this half: it can describe a
    // booking, never move one to another stage. Advancing a container is a
    // consequential act with a supplier and a trucker on the other end of
    // it, and that stays a deliberate click.
    find_bookings: {
        kind: 'read',
        description: 'Search shipping bookings by number, carrier, port, buyer, vessel, or container stage. '
            + 'Use this for anything about bookings, containers, cutoffs, vessels or ports.',
        params: {
            booking_number: { type: 'string', describe: 'full or partial booking number' },
            port: { type: 'string', describe: 'part of a loading or discharge port, e.g. "houston"' },
            carrier: { type: 'string', describe: 'part of a carrier name, e.g. "maersk"' },
            supplier: { type: 'string', describe: 'a supplier assigned to any container on the booking' },
            stage: { type: 'string', describe: 'container stage, e.g. "forwarded", "loading", "unassigned"' },
            cutoff_before: { type: 'date', describe: 'only bookings whose cutoff is on or before this date, YYYY-MM-DD' },
        },
        run: async (p) => {
            const { loadBookings } = require('./json');
            const all = loadBookings ? loadBookings() : {};
            const has = (hay, needle) => !needle || String(hay || '').toLowerCase().includes(String(needle).toLowerCase());
            // Dates in this file are MM/DD/YYYY, everywhere else they are
            // ISO. Compared as dates rather than strings because
            // "07/20/2026" < "2026-07-20" is true as text and meaningless.
            const asDate = (s) => {
                const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s || ''));
                return m ? `${m[3]}-${m[1]}-${m[2]}` : String(s || '');
            };
            const rows = Object.values(all || {})
                .filter((b) => has(b.booking_number, p.booking_number))
                .filter((b) => !p.port || has(b.port_of_loading, p.port) || has(b.port_of_discharge, p.port))
                .filter((b) => has(b.carrier, p.carrier))
                .filter((b) => !p.supplier || (b.containers || []).some((c) => has(c.supplier, p.supplier)))
                .filter((b) => !p.stage || (b.containers || []).some((c) => (
                    String(p.stage).toLowerCase() === 'unassigned'
                        ? !c.supplier
                        : has(c.stage, p.stage))))
                .filter((b) => !p.cutoff_before || (asDate(b.cutoff_date) && asDate(b.cutoff_date) <= p.cutoff_before))
                .map((b) => ({
                    booking_number: b.booking_number,
                    carrier: b.carrier,
                    route: [b.port_of_loading, b.port_of_discharge].filter(Boolean).join(' → '),
                    vessel: b.vessel_voyage,
                    buyer: b.buyer,
                    erd: b.erd_date,
                    cutoff: b.cutoff_date,
                    containers: (b.containers || []).map((c) => ({
                        seq: c.seq, size: c.size, container_number: c.container_number,
                        supplier: c.supplier || null, trucker: c.trucker || null, stage: c.stage || null,
                    })),
                    // The two numbers she actually asks for, precomputed so
                    // the model does not have to count and get it wrong.
                    container_count: (b.containers || []).length,
                    unassigned_containers: (b.containers || []).filter((c) => !c.supplier).length,
                }))
                .sort((a, b) => String(a.cutoff || '').localeCompare(String(b.cutoff || '')));
            return cap(rows);
        },
    },

    find_loads: {
        kind: 'read',
        description: 'Search purchase loads by seller, date range, item description, or payment state. Use this before answering anything about specific loads.',
        params: {
            seller: { type: 'string', describe: 'part of a seller name; matched loosely' },
            from: { type: 'date', describe: 'earliest load date, YYYY-MM-DD' },
            to: { type: 'date', describe: 'latest load date, YYYY-MM-DD' },
            item: { type: 'string', describe: 'part of an item description, e.g. "sealed units"' },
            unpaid_only: { type: 'boolean', describe: 'true to return only loads with something still outstanding' },
        },
        run: async (p) => {
            const { loadLoads } = require('./loads');
            const { paymentSummary } = require('./payments');
            const seller = str(p.seller).toLowerCase();
            const item = str(p.item).toLowerCase();
            const rows = loadLoads()
                .filter((l) => !seller || String(l.seller || '').toLowerCase().includes(seller))
                .filter((l) => !p.from || String(l.date || '') >= p.from)
                .filter((l) => !p.to || String(l.date || '') <= p.to)
                .filter((l) => !item || (l.items || []).some((it) => String(it.description || '').toLowerCase().includes(item)))
                .map((l) => ({ id: l.id, date: l.date, seller: l.seller, amount: l.amount, payment: paymentSummary(l.id, l.amount) }))
                .filter((l) => !p.unpaid_only || (l.payment && l.payment.pending > 0))
                .sort((a, b) => String(b.date).localeCompare(String(a.date)));
            return cap(rows);
        },
    },

    load_detail: {
        kind: 'read',
        description: 'Everything about one load: its items, weights, prices and every payment recorded against it.',
        params: { load_id: { type: 'string', required: true, describe: 'the load id, e.g. EDGE_42' } },
        run: async (p) => {
            const { getLoad } = require('./loads');
            const { paymentsForLoad, paymentSummary } = require('./payments');
            const id = str(p.load_id);
            const load = await getLoad(id);
            // Not found is a RESULT, not an error. The model asked a
            // reasonable question and the honest answer is "no such load" —
            // throwing would turn that into an apology about a failure.
            if (!load) return { found: false, load_id: id };
            return {
                found: true,
                load: { id: load.id, date: load.date, seller: load.seller, amount: load.amount, items: load.items || [], signed: !!load.seller_signature },
                payments: paymentsForLoad(id),
                summary: paymentSummary(id, load.amount),
            };
        },
    },

    inventory: {
        kind: 'read',
        description: 'Stock on hand by item type — what has come in, net of what has been sold.',
        params: { from: { type: 'date' }, to: { type: 'date' } },
        run: async (p) => {
            const { loadLoads, getInventoryReport } = require('./loads');
            return getInventoryReport(loadLoads(), { from: p.from, to: p.to });
        },
    },

    item_lines: {
        kind: 'read',
        description: 'Every individual line of one material across all loads, with gross, tare, net, price and which load it came from.',
        params: {
            description: { type: 'string', required: true, describe: 'the item type, e.g. "sealed units"' },
            from: { type: 'date' }, to: { type: 'date' },
        },
        run: async (p) => {
            const { loadLoads, getItemLines } = require('./loads');
            const r = getItemLines(loadLoads(), { description: str(p.description), from: p.from, to: p.to });
            return { count: r.count, totals: r.totals, ...cap(r.lines) };
        },
    },

    spend_report: {
        kind: 'read',
        description: 'What the business has paid out, split into loads, haulage and expenses, by month and by payment method. Also reports money received from sales separately.',
        params: {
            from: { type: 'date' }, to: { type: 'date' },
            method: { type: 'string', describe: 'narrow to one of Cash, Zelle, Wire, Cheque, Card' },
        },
        run: async (p) => {
            const { buildSpendReport } = require('./spendReport');
            const { listPayments } = require('./payments');
            const { loadExpenses } = require('./expenses');
            const petty = require('./pettyCash');
            const r = buildSpendReport({
                payments: listPayments(), expenses: loadExpenses(),
                pettyEntries: petty.listEntries(), from: p.from, to: p.to, method: p.method,
            });
            // The row-level drill-down is dropped: the totals answer the
            // question and the rows would dominate the prompt.
            const { rows, received, ...totals } = r;
            return { ...totals, received: { total: received.total, count: received.count, byMethod: received.byMethod } };
        },
    },

    trucker_bills: {
        kind: 'read',
        description: 'Haulage bills owed to trucking companies, with what has been paid against each.',
        params: { company: { type: 'string' }, from: { type: 'date' }, to: { type: 'date' } },
        run: async (p) => {
            const t = require('./truckerBills');
            const bills = t.listBillsWithPayments({ from: p.from, to: p.to, company: p.company });
            return { report: t.billsReport(bills), ...cap(bills) };
        },
    },

    petty_cash: {
        kind: 'read',
        description: 'The cash box: current balance and recent movements.',
        params: {},
        run: async () => {
            const petty = require('./pettyCash');
            const entries = petty.listEntries();
            return { balance: petty.balance(), ...cap(entries.slice(-20).reverse()) };
        },
    },

    // ══ WRITE ══════════════════════════════════════════════════════════════
    // Each returns a PROPOSAL — a summary, the details worth checking, any
    // warnings, and a run() that is only ever called after the person
    // confirms. None of these writes anything when it is called.

    record_payment: {
        kind: 'write',
        description: 'Record a payment against a purchase load.',
        params: {
            load_id: { type: 'string', required: true },
            amount: { type: 'number', required: true },
            mode: { type: 'string', required: true, describe: 'Zelle, Wire, Cash or Cheque' },
            paid_on: { type: 'date', describe: 'defaults to today' },
            note: { type: 'string' },
        },
        propose: async (p) => {
            const { getLoad } = require('./loads');
            const { PAYMENT_MODES, paymentSummary } = require('./payments');
            const loadId = str(p.load_id);
            const load = await getLoad(loadId);
            // The single most valuable check here. A hallucinated load id is
            // the likeliest way this goes wrong, and it dies at this line.
            if (!load) throw new Error(`there is no load ${loadId} in the records`);

            const amount = Math.round(num(p.amount) * 100) / 100;
            if (!Number.isFinite(amount) || amount <= 0) throw new Error('a payment needs an amount greater than zero');
            const mode = PAYMENT_MODES.find((m) => m.toLowerCase() === str(p.mode).toLowerCase());
            if (!mode) throw new Error(`payment mode must be one of: ${PAYMENT_MODES.join(', ')}`);

            // Recomputed from the ledger, NOT from anything the model said.
            const before = paymentSummary(loadId, load.amount);
            const after = Math.round((before.pending - amount) * 100) / 100;
            const paidOn = isYmd(p.paid_on) ? p.paid_on : require('./time').todayLocal();

            const warnings = [];
            if (after < 0) warnings.push(`This is ${money(-after)} MORE than the ${money(before.pending)} still outstanding on this load.`);
            if (before.pending === 0) warnings.push('This load is already fully paid.');

            return {
                summary: `Record a ${mode} payment of ${money(amount)} against ${loadId} (${load.seller || 'no seller'}), dated ${paidOn}.`,
                details: [
                    ['Load', `${loadId} — ${load.seller || 'no seller'}, ${money(load.amount || 0)}`],
                    ['Already paid', money(before.paid)],
                    ['This payment', `${money(amount)} by ${mode}`],
                    ['Left pending after', money(Math.max(after, 0))],
                ],
                warnings,
                run: async (ctx) => require('./payments').addPayment({
                    load_id: loadId, amount, mode, paid_on: paidOn, note: p.note,
                    created_by: ctx.role || 'yard-assistant',
                }),
            };
        },
    },

    add_trucker_bill: {
        kind: 'write',
        description: 'Record a haulage bill owed to a trucking company.',
        params: {
            company: { type: 'string', required: true },
            amount: { type: 'number', required: true },
            date: { type: 'date', describe: 'defaults to today' },
            load_ticket: { type: 'string', describe: 'optional; the load it relates to' },
        },
        propose: async (p) => {
            const company = str(p.company);
            if (!company) throw new Error('a trucker bill needs a company');
            const amount = Math.round(num(p.amount) * 100) / 100;
            if (!Number.isFinite(amount) || amount <= 0) throw new Error('a bill needs an amount greater than zero');
            const date = isYmd(p.date) ? p.date : require('./time').todayLocal();
            const ticket = str(p.load_ticket) || null;
            return {
                summary: `Record a haulage bill of ${money(amount)} from ${company}, dated ${date}${ticket ? ` against ${ticket}` : ''}.`,
                details: [['Company', company], ['Amount', money(amount)], ['Date', date], ['Load ticket', ticket || '—']],
                warnings: [],
                run: async (ctx) => require('./truckerBills').addBill({
                    company, amount, date, load_ticket: ticket, created_by: ctx.role || 'yard-assistant',
                }),
            };
        },
    },

    add_expense: {
        kind: 'write',
        description: 'Record a yard expense. Choosing Cash also draws it out of the petty cash box.',
        params: {
            description: { type: 'string', required: true },
            amount: { type: 'number', required: true },
            payment_method: { type: 'string', describe: 'Cash or Card; defaults to Cash' },
            category: { type: 'string', describe: 'e.g. Fuel, Repairs & maintenance, Labour' },
            date: { type: 'date', describe: 'defaults to today' },
            vendor: { type: 'string' },
        },
        propose: async (p) => {
            const expenses = require('./expenses');
            const description = str(p.description);
            if (!description) throw new Error('an expense needs a description');
            const amount = Math.round(num(p.amount) * 100) / 100;
            if (!Number.isFinite(amount) || amount <= 0) throw new Error('an expense needs an amount greater than zero');
            const method = expenses.normalizeMethod(p.payment_method) || expenses.DEFAULT_EXPENSE_METHOD;
            const date = isYmd(p.date) ? p.date : require('./time').todayLocal();

            const warnings = [];
            if (method === 'Cash') {
                // Said before it happens, not discovered after. An expense is
                // never refused for being larger than the box — see
                // helpers/expenses.js — so the only protection is telling her.
                const balance = require('./pettyCash').balance();
                if (amount > balance) {
                    warnings.push(`The cash box holds ${money(balance)}, so this will take it ${money(amount - balance)} below zero.`);
                }
            }
            return {
                summary: `Record a ${method} expense of ${money(amount)} for "${description}", dated ${date}.`,
                details: [['Description', description], ['Amount', money(amount)], ['Paid by', method],
                          ['Category', str(p.category) || 'Other'], ['Date', date]],
                warnings,
                run: async (ctx) => expenses.addExpense({
                    description, amount, payment_method: method, category: p.category,
                    vendor: p.vendor, date, created_by: ctx.role || 'yard-assistant',
                }),
            };
        },
    },
};

// ── generated, never hand-written ─────────────────────────────────────────
// The text the model reads. Built from the registry above, so the prompt
// cannot advertise a tool that does not exist or miss one that does — which
// is the exact failure the old hand-synced prose kept producing.
function describeTools() {
    const line = (name, t) => {
        const ps = Object.entries(t.params || {}).map(([k, s]) => {
            const bits = [k];
            if (s.required) bits.push('(required)');
            if (s.describe) bits.push(`— ${s.describe}`);
            return bits.join(' ');
        });
        return `  • ${name} — ${t.description}`
            + (ps.length ? `\n      params: ${ps.join('; ')}` : '\n      params: none');
    };
    const reads = Object.entries(TOOLS).filter(([, t]) => t.kind === 'read');
    const writes = Object.entries(TOOLS).filter(([, t]) => t.kind === 'write');
    return [
        'TOOLS YOU CAN CALL TO LOOK THINGS UP (these run immediately and change nothing —',
        'call them freely, and prefer calling one over saying you do not have the data):',
        ...reads.map(([n, t]) => line(n, t)),
        '',
        'TOOLS THAT CHANGE SOMETHING (these are PROPOSED — the person confirms before',
        'anything is written. Never say you have done it; say what WILL happen):',
        ...writes.map(([n, t]) => line(n, t)),
        '',
        'You cannot delete anything, and you cannot send emails or messages. Say so',
        'plainly if asked, and point them at the app.',
    ].join('\n');
}

const TOOL_NAMES = Object.keys(TOOLS);
const readToolNames = () => TOOL_NAMES.filter((n) => TOOLS[n].kind === 'read');
const writeToolNames = () => TOOL_NAMES.filter((n) => TOOLS[n].kind === 'write');

// Checks a call against the declared schema BEFORE the handler sees it, so
// every tool gets the same treatment and no handler has to re-implement
// "which of my parameters are required".
function validate(name, params) {
    const t = TOOLS[name];
    if (!t) throw new Error(`there is no tool called "${name}"`);
    const p = (params && typeof params === 'object') ? params : {};
    for (const [key, spec] of Object.entries(t.params || {})) {
        const v = p[key];
        const missing = v == null || v === '';
        if (spec.required && missing) throw new Error(`${name} needs ${key}`);
        if (missing) continue;
        if (spec.type === 'number' && num(v) == null) throw new Error(`${name}: ${key} must be a number`);
        if (spec.type === 'date' && !isYmd(v)) throw new Error(`${name}: ${key} must be a date as YYYY-MM-DD`);
    }
    return p;
}

// Runs a READ tool. No confirmation, by design — see the header.
async function runRead(name, params, ctx = {}) {
    const t = TOOLS[name];
    if (!t) throw new Error(`there is no tool called "${name}"`);
    if (t.kind !== 'read') throw new Error(`${name} changes things, so it has to be proposed rather than run`);
    return t.run(validate(name, params), ctx);
}

// Builds a WRITE tool's proposal. Writes nothing.
async function buildWrite(name, params, ctx = {}) {
    const t = TOOLS[name];
    if (!t) throw new Error(`there is no tool called "${name}"`);
    if (t.kind !== 'write') throw new Error(`${name} only reads — it does not need confirming`);
    return t.propose(validate(name, params), ctx);
}

module.exports = {
    TOOLS, TOOL_NAMES, readToolNames, writeToolNames,
    describeTools, validate, runRead, buildWrite, MAX_ROWS,
};
