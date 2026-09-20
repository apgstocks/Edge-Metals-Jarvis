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

    // ── NO BOOKINGS TOOL HERE, DELIBERATELY ──────────────────────────────
    // One was added on 2026-09-06 and removed the same day. It was the wrong
    // fix in the wrong file, and the reasoning that produced it — "it cannot
    // answer about bookings, so give it a bookings tool" — is the reasoning
    // that will produce it again, which is why this note replaces it rather
    // than the code simply disappearing.
    //
    // Apsara: "yard ask is a different assistant restricted only to yard
    // (restrict it to yard data). Jarvis knows everything."
    //
    // That split already existed. TWO assistants sit behind /api/voice/ask,
    // chosen by helpers/voiceRouter.js:
    //
    //   Scout  — this registry. Loads, sellers, stock, payments, petty cash,
    //            trucker bills. A narrow assistant over the yard ledger.
    //   Jarvis — workflow/brain.js. Bookings, containers, ports, cutoffs,
    //            suppliers, truckers, WhatsApp, email. It has answered
    //            location booking questions for weeks, through
    //            bookings_list_query and queryBookingsByLocation.
    //
    // Her question failed because dashboard/voice.js called /api/yard/ask
    // directly and bypassed the router, so every spoken question reached
    // Scout. Scout saying it did not know about bookings was CORRECT — it is
    // not the assistant that knows. Teaching it bookings would have
    // dissolved a boundary that exists on purpose and left two assistants
    // able to give different answers about the same container.
    //
    // The boundary is enforced in tests/yard-ask-tools.js, not just here.


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
                // net_payable alongside amount, and the payment measured
                // against the payable — a load with haulage deducted owes the
                // seller less than the metal came to, and "what do we still
                // owe Ramesh" is the question this tool exists to answer.
                .map((l) => ({ id: l.id, date: l.date, seller: l.seller, amount: l.amount,
                               trucking_amount: l.trucking_amount ?? null,
                               net_payable: require('./loads').payableOf(l),
                               payment: paymentSummary(l.id, require('./loads').payableOf(l)) }))
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
                // amount AND net_payable, both named, because the difference
                // between them is the whole point of the deduction and an
                // assistant handed only one of them will state it as though
                // it were the other.
                load: { id: load.id, date: load.date, seller: load.seller, amount: load.amount,
                        trucking_company: load.trucking_company ?? null,
                        trucking_amount: load.trucking_amount ?? null,
                        net_payable: require('./loads').payableOf(load),
                        items: load.items || [], signed: !!load.seller_signature },
                payments: paymentsForLoad(id),
                summary: paymentSummary(id, require('./loads').payableOf(load)),
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

    // ── THE HALF OF THE YARD IT COULD NOT SEE ────────────────────────────
    // Apsara, 2026-09-16: "Yard assistant should have complete knowledge abou
    // yard."
    //
    // It did not, and the gap was not a rough edge — it was structural. Every
    // read above this point looks at PURCHASES. find_loads calls loadLoads()
    // and says so in its own description; nothing in this file had ever opened
    // helpers/outboundLoads.js. So "who did we sell to this month", "what did
    // Eccomelt take", "are we making anything" all reached an assistant that
    // had no way to look, and the honest answer it could give was that it did
    // not know.
    //
    // Three reads, matching the three reports she named for the phone on the
    // same day (Sales, Stock, Profit — Stock already had `inventory`):

    find_sales: {
        kind: 'read',
        description: 'Search SALES — material shipped OUT of the yard — by buyer, date range or item description. Use this for anything about what was sold, to whom, or for how much. find_loads only covers purchases coming IN.',
        params: {
            buyer: { type: 'string', describe: 'match part of a buyer name, case-insensitive' },
            from: { type: 'date' }, to: { type: 'date' },
            item: { type: 'string', describe: 'match part of an item description' },
            unpaid_only: { type: 'boolean', describe: 'true to return only sales the customer has not fully paid for' },
            limit: { type: 'number', describe: 'defaults to 25' },
        },
        run: async (p) => {
            const { loadOutboundLoads } = require('./outboundLoads');
            const q = (v) => String(v || '').trim().toLowerCase();
            const buyer = q(p.buyer), item = q(p.item);
            const inRange = (d) => !!d && (!p.from || d >= p.from) && (!p.to || d <= p.to);
            const rows = loadOutboundLoads().filter((l) => {
                if (!l) return false;
                if ((p.from || p.to) && !inRange(l.date)) return false;
                if (buyer && !q(l.buyer).includes(buyer)) return false;
                if (item && !(l.items || []).some((it) => q(it && it.description).includes(item))) return false;
                return true;
            }).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
            const limit = Math.max(1, Math.min(100, Number(p.limit) || 25));
            // ── WHAT THE CUSTOMER STILL OWES ─────────────────────────────
            // Attached here rather than left to a second call. Once sales are
            // visible at all, "who still owes me" is the next question anyone
            // asks, and an assistant that can list sales but not say which are
            // unpaid can only answer half of it.
            //
            // paymentSummary is the SAME arithmetic the screens use — a
            // second implementation in this file would eventually disagree
            // with the ledger, on money.
            const { paymentSummary } = require('./payments');
            const withPay = rows.map((l) => ({ ...l, payment: paymentSummary(l.id, l.amount) }));
            const shown = p.unpaid_only
                ? withPay.filter((l) => l.payment && l.payment.pending > 0)
                : withPay;
            // The COUNT comes back alongside the page, so an answer built on
            // the first 25 of 300 sales can say so instead of sounding
            // complete. A truncated list presented as the whole is how a
            // confident wrong total gets spoken aloud.
            return { total: shown.length, showing: Math.min(limit, shown.length), sales: shown.slice(0, limit) };
        },
    },

    sales_report: {
        kind: 'read',
        description: 'Who the yard sold to over a period — loads, weight, amount, and margin where the material is linked back to the loads it came from. Use for "how much did we sell", "who bought what".',
        params: { from: { type: 'date' }, to: { type: 'date' } },
        run: async (p) => {
            const { loadOutboundLoads, getOutboundReport } = require('./outboundLoads');
            return getOutboundReport(loadOutboundLoads(), { from: p.from, to: p.to });
        },
    },

    yard_profit: {
        kind: 'read',
        description: 'Edge Yard profit: margin on what was actually sold, plus a separate cash in/out picture. EDGE YARD ONLY — never add this to Edge Metals figures.',
        params: { from: { type: 'date' }, to: { type: 'date' } },
        run: async (p) => {
            const out = require('./yardProfit').yardProfit({ from: p.from, to: p.to });
            // ── THE CAVEAT TRAVELS WITH THE NUMBER ───────────────────────
            // helpers/yardProfit.js returns `coverage_pct` and a `caveat` in
            // words precisely so a client cannot render the figure without it
            // by simply forgetting to. An assistant is the client most likely
            // to forget: it reads the JSON, finds `margin`, and says a
            // number. So the instruction is hoisted to the top level of the
            // reply where it cannot be missed, rather than left nested two
            // keys deep beside the figure it qualifies.
            //
            // The cash block is already named NOT PROFIT in its own note. It
            // is repeated here for the same reason.
            return {
                ...out,
                _how_to_answer: out.margin && out.margin.caveat
                    ? `Say the margin AND this, in the same breath: ${out.margin.caveat}`
                    : 'Margin covers essentially all sales in this range.',
                _never: 'The cash block is money in and out over the period. It is NOT profit — do not call it profit, and do not add it to the margin.',
            };
        },
    },

    // ── AND THE REST OF IT ───────────────────────────────────────────────
    // Apsara, 2026-09-16, on being told the assistant could not see sales:
    // "it should see everything".
    //
    // So this is the rest of the yard, audited store by store against
    // config.js rather than guessed at. What was still invisible after the
    // sales reads landed: WhatsApp scale tickets, unfinished loads, the
    // material catalogue and her own decisions about which names mean the same
    // metal — and, on the money side, what customers still owe HER.
    //
    // ── "EVERYTHING" MEANS EVERYTHING *YARD* ─────────────────────────────
    // Edge Metals is a different company and its stores stay out of this file:
    // bills, sales (invoices), sales receipts, settlements, metals trucking,
    // Edge Inventory, BOLs, packing lists. Not an oversight — an assistant
    // that can read both is one answer away from a figure that describes
    // neither company, which is the mistake this whole app is arranged to
    // prevent. tests/yard-assistant-knowledge.js holds the line.

    scale_tickets: {
        kind: 'read',
        description: 'Scale-ticket photos sent in over WhatsApp — the quick weight captures, separate from full load records. Use when asked about a weight that was photographed but may never have become a load.',
        params: {
            from: { type: 'date' }, to: { type: 'date' },
            limit: { type: 'number', describe: 'defaults to 25' },
        },
        run: async (p) => {
            const { loadScaleTickets } = require('./scaleTickets');
            const day = (t) => String((t && (t.received_at || t.created_at)) || '').slice(0, 10);
            const rows = (loadScaleTickets() || []).filter((t) => {
                if (!t) return false;
                if (p.from && day(t) < p.from) return false;
                if (p.to && day(t) > p.to) return false;
                return true;
            });
            const limit = Math.max(1, Math.min(100, Number(p.limit) || 25));
            return {
                total: rows.length, showing: Math.min(limit, rows.length),
                // The PHOTO is not sent — only that there is one, and its link.
                // A base64 image in a tool result is a huge payload for a
                // question the link already answers.
                tickets: rows.slice(0, limit).map((t) => ({
                    id: t.id, received_at: t.received_at, from: t.from || t.sender || null,
                    weight: t.weight ?? null, unit: t.unit || null,
                    description: t.description || t.note || null,
                    has_photo: !!(t.drive_link || t.drive_file_id), drive_link: t.drive_link || null,
                })),
            };
        },
    },

    load_drafts: {
        kind: 'read',
        description: 'Loads that were started and never finished. Use for "is there anything half-entered", or when a load someone remembers recording cannot be found.',
        params: {},
        run: async () => {
            const { listDrafts } = require('./loadDrafts');
            const rows = listDrafts();
            return {
                total: rows.length,
                // Summarised, not dumped. A draft carries the whole half-typed
                // form including photo links; what answers the question is
                // whose it is, when, and how far it got.
                drafts: rows.map((d) => ({
                    id: d.id, updated_at: d.updated_at || d.created_at || null,
                    kind: d.kind || 'purchase', seller: d.seller || d.buyer || null,
                    date: d.date || null,
                    items: Array.isArray(d.items) ? d.items.filter((i) => i && i.description).length : 0,
                })),
            };
        },
    },

    item_catalogue: {
        kind: 'read',
        description: 'Every material description the yard uses, and which different spellings she has confirmed mean the same metal. Use before answering about a material by name — "Al combo" and "Aluminium combo" may be one pile.',
        params: {},
        run: async () => {
            const { loadCustomItemTypes } = require('./itemTypes');
            const aliases = require('./itemAliases');
            return {
                descriptions: loadCustomItemTypes(),
                // ── ONLY THE ONES SHE SETTLED ────────────────────────────
                // helpers/itemAliases.js stores AI verdicts alongside her
                // answers and never lets a machine verdict settle anything.
                // Passing the unfiltered list here would let one wrong guess
                // become a merged pile in every answer the assistant gives.
                //
                // source === 'user' AND same === true. A "no, these are
                // different" is also hers and also stored, and shipping it in
                // a list called same_metal would invert her answer.
                //
                // NOT aliases.settled() — that takes a PAIR and answers about
                // that one pair. Calling it with no arguments returned null
                // and crashed this tool on its first run.
                same_metal: aliases.list()
                    .filter((r) => r && r.source === 'user' && r.same === true)
                    .map((r) => [r.a, r.b]),
                _note: 'Two descriptions are the same metal ONLY if they appear together in same_metal. Never merge two materials because their names look alike — "Al 6061" and "Al 6063" are different alloys worth different money.',
            };
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
            // question and the rows would dominate the prompt. find_expenses
            // is the drill-down beside this, for anything that needs a name.
            const { rows, received, ...totals } = r;

            // ── BY CATEGORY, WHICH WAS MISSING ENTIRELY ──────────────────
            // Apsara, 2026-09-15, pushing back on "it should be able to show
            // that na" after being told the deployed build lacked
            // find_expenses. She was right, and about more than that: this
            // report handed over byMethod, byBank and months, and NO category
            // breakdown at all. So "how much salary did we pay" was
            // unanswerable even in the summary, despite
            // expenses.getExpenseReport computing byCategory for the Expenses
            // tab all along.
            //
            // It is an AGGREGATE, one line per category, so the reasoning
            // above about rows dominating the prompt does not apply to it.
            // This makes the ordinary summary question — what did we spend on
            // labour, on fuel, on repairs — answerable without a row search.
            let byCategory = [];
            try {
                const { getExpenseReport, loadExpenses } = require('./expenses');
                byCategory = (getExpenseReport(loadExpenses(), { from: p.from, to: p.to }).byCategory) || [];
            } catch (e) { /* a report that cannot be built must not break the rest */ }

            return { ...totals, byCategory, received: { total: received.total, count: received.count, byMethod: received.byMethod } };
        },
    },

    // ── EXPENSES, ROW BY ROW ─────────────────────────────────────────────
    // Apsara, 2026-09-15, asking the assistant "How much did we pay
    // Santiago?" and then "check in expenses", and being told twice that
    // there is no record of it.
    //
    // It was answering honestly. The only expense tool it had was
    // spend_report, which deliberately DROPS the rows — "the totals answer
    // the question and the rows would dominate the prompt" — so the
    // assistant could see what August cost by method and month and could not
    // see a single expense, a vendor name, or a description. Every question
    // about WHO was paid or WHAT FOR was unanswerable, and the honest "I
    // cannot find any record" was indistinguishable from "there are none".
    //
    // spend_report keeps dropping its rows; that reasoning still holds for a
    // whole-business report. This is the drill-down beside it, filtered
    // before it is returned so only what was asked for reaches the prompt.
    find_expenses: {
        kind: 'read',
        description: 'Search recorded expenses by vendor, category, description or date range. Use this for any question about who was paid, what was bought, or what an expense was for — spend_report gives totals only and cannot name anyone.',
        params: {
            // ── ONE SEARCH BOX, NOT TWO ──────────────────────────────────
            // This was `vendor` and `text` as separate parameters, and her
            // own data broke it: one expense has Santiago in the VENDOR
            // field ($240) and another names him only in the DESCRIPTION —
            // "Weekly salary Santiago", $900. The model had to pick one, so
            // "how much did we pay Santiago" answered $240 and left out the
            // $900 without saying so.
            //
            // An undercount is the dangerous direction: nobody questions a
            // figure that is lower than they feared. So one parameter that
            // looks everywhere a name or a thing can be written. `vendor`
            // and `text` are still accepted as aliases, because the prompt
            // and any half-finished tool call may still use them, and they
            // now mean the same thing rather than half the answer.
            match: { type: 'string', describe: 'a person, company or thing — matched loosely against the vendor, the description AND the notes. Use this for "how much did we pay X" and for "what did we spend on Y".' },
            vendor: { type: 'string', describe: 'alias for match' },
            text: { type: 'string', describe: 'alias for match' },
            category: { type: 'string', describe: 'part of a category, e.g. "fuel" or "labour"' },
            method: { type: 'string', describe: 'one of Cash, Zelle, Wire, Cheque, Card, Other' },
            from: { type: 'date', describe: 'earliest expense date, YYYY-MM-DD' },
            to: { type: 'date', describe: 'latest expense date, YYYY-MM-DD' },
        },
        run: async (p) => {
            const { loadExpenses } = require('./expenses');
            const like = (hay, needle) => String(hay || '').toLowerCase().includes(String(needle).trim().toLowerCase());
            // Whichever the model reached for, they mean the same thing.
            const needle = p.match || p.vendor || p.text || '';
            const rows = loadExpenses().filter((e) => {
                // Vendor, description AND notes. A person can be recorded in
                // any of the three — hers are in two — and searching one of
                // them answers a money question with part of the answer.
                if (needle && !(like(e.vendor, needle) || like(e.description, needle) || like(e.notes, needle))) return false;
                if (p.category && !like(e.category, p.category)) return false;
                if (p.method && String(e.payment_method || '').toLowerCase() !== String(p.method).trim().toLowerCase()) return false;
                if (p.from && String(e.date || '') < p.from) return false;
                if (p.to && String(e.date || '') > p.to) return false;
                return true;
            });
            // The TOTAL of what matched, computed here rather than left to the
            // model to add up. "How much did we pay Santiago" is a sum, and a
            // sum a language model does in its head is a sum nobody checked.
            const total = Math.round(rows.reduce((t, e) => t + (Number(e.amount) || 0), 0) * 100) / 100;
            return { matched_total: total, ...cap(rows) };
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
            mode: { type: 'string', required: true, describe: 'Cash or Bank transfer' },
            // Optional, and optional ON PURPOSE — she may simply not say which
            // account a Zelle left, and refusing the whole payment over it
            // would make a working feature stop working. Unsaid becomes
            // "Not recorded" on the spend report, where she can see and close
            // the gap. See helpers/banks.js.
            bank: { type: 'string', describe: 'which bank a transfer went out of, if she said' },
            // ── REQUIRED FOR SOME COMBINATIONS, AND THE TOOL HAD NO BOX ─────
            // Added 2026-09-17 after a live break. The paid-via work of
            // 2026-09-16 ("on selecting wire-it should ask me Payment via Edge
            // Yard/Edge Metals") made addPayment THROW for a Wire on a
            // purchase and a Bank transfer on a sale when no company is given.
            // That rule was written for the pay modal and applied to the
            // shared helper — and this tool, which is how she records a
            // payment by talking to Jarvis, had no way to supply one. So
            // "record a wire payment of $12,000 against load X" threw.
            //
            // Caught only because tests/yard-assistant-knowledge.js pays by
            // bank transfer on a sale, which is what she actually does. My
            // regression, not a fixture that went stale.
            paid_via: { type: 'string', describe: 'Edge Yard or Edge Metals — which company the money moved through' },
            paid_on: { type: 'date', describe: 'defaults to today' },
            note: { type: 'string' },
        },
        propose: async (p) => {
            const { getLoad } = require('./loads');
            const { modesForKind, paymentSummary } = require('./payments');
            const loadId = str(p.load_id);
            const load = await getLoad(loadId);
            // The single most valuable check here. A hallucinated load id is
            // the likeliest way this goes wrong, and it dies at this line.
            if (!load) throw new Error(`there is no load ${loadId} in the records`);

            const amount = Math.round(num(p.amount) * 100) / 100;
            if (!Number.isFinite(amount) || amount <= 0) throw new Error('a payment needs an amount greater than zero');
            // The YARD's list, not every mode payments.js knows. This tool
            // records against yard loads, and since 2026-09-16 those take Cash
            // or Bank transfer only — per Apsara, "in receive payment-i should
            // have only cash and bank transfer". Asked through modesForKind so
            // the tool and addPayment's validator cannot disagree: proposing a
            // Zelle here and having addPayment refuse it at run time would
            // show up as a confirmed action that then failed.
            // The kind of the LOAD, not a hardcoded 'purchase'. This tool
            // records against whatever row she names, and since the two kinds
            // now take different lists (receive payment is Cash or Bank
            // transfer; paying a supplier keeps Zelle and Wire), asking for
            // the wrong one would refuse a payment the server would accept.
            const loadKind = load._kind || load.load_kind || 'purchase';
            const allowed = modesForKind(loadKind);
            const mode = allowed.find((m) => m.toLowerCase() === str(p.mode).toLowerCase());
            if (!mode) throw new Error(`payment mode must be one of: ${allowed.join(', ')}`);

            // ── ASK HERE, NOT AT RUN TIME ───────────────────────────────────
            // Same reasoning as the mode check above, and the same reason it
            // is checked through payments.js rather than re-stated here: a
            // proposal this tool confirms and then fails on is worse than one
            // it refuses up front, because she has already said yes to it.
            // resolvePaidVia throws with the question in it ("a Wire on a yard
            // purchase needs \"Payment via\": Edge Yard or Edge Metals"), which
            // is exactly what the assistant should put to her.
            const { paidViaRequired, resolvePaidVia } = require('./payments');
            const paidVia = resolvePaidVia(loadKind, mode, p.paid_via);

            // Recomputed from the ledger, NOT from anything the model said.
            // Against the PAYABLE: if $200 of haulage was deducted, "$2,259
            // still outstanding" is the true figure and "$2,459" would have
            // her overpay by exactly the deduction she just made.
            const before = paymentSummary(loadId, require('./loads').payableOf(load));
            const after = Math.round((before.pending - amount) * 100) / 100;
            const paidOn = isYmd(p.paid_on) ? p.paid_on : require('./time').todayLocal();

            // Validated at PROPOSE time, not only at run time. The confirm card
            // is the last thing she reads before this writes, so a bank that
            // will be refused has to fail here — refusing after she has
            // confirmed teaches her that confirming does not mean anything.
            const banks = require('./banks');
            const bank = await banks.resolveForMode(mode, p.bank);

            const warnings = [];
            // Said out loud rather than left blank. She is confirming a payment
            // she cannot see a form for, so the one field that will be missing
            // from the report has to be on the card in front of her.
            if (banks.needsBank(mode) && !bank) {
                warnings.push(`No bank recorded for this ${mode} — it will show as "Not recorded" on the spend report.`);
            }
            if (after < 0) warnings.push(`This is ${money(-after)} MORE than the ${money(before.pending)} still outstanding on this load.`);
            if (before.pending === 0) warnings.push('This load is already fully paid.');

            return {
                summary: `Record a ${mode} payment of ${money(amount)} against ${loadId} (${load.seller || 'no seller'}), dated ${paidOn}.`,
                details: [
                    // The metal's figure and the payable are the SAME on every
                    // load without a deduction, so the card reads exactly as it
                    // always has until there is one — and when there is, it
                    // shows both and says why they differ. A card that printed
                    // only the payable would leave her unable to check it
                    // against the ticket in her hand; only the amount would
                    // have her paying the haulage twice.
                    ['Load', `${loadId} — ${load.seller || 'no seller'}, ${money(load.amount || 0)}`],
                    ...(load.trucking_amount
                        ? [['Less trucking', `${money(load.trucking_amount)}${load.trucking_company ? ' — ' + load.trucking_company : ''}`],
                           ['Payable to seller', money(require('./loads').payableOf(load) || 0)]]
                        : []),
                    ['Already paid', money(before.paid)],
                    ['This payment', `${money(amount)} by ${mode}${bank ? ' from ' + bank : ''}`],
                    // Shown only when it applies — a "Payment via: " line on a
                    // cash payment is noise on a card she reads at a gate.
                    ...(paidVia ? [[require('./payments').paidViaLabel(loadKind), paidVia]] : []),
                    ['Left pending after', money(Math.max(after, 0))],
                ],
                warnings,
                run: async (ctx) => require('./payments').addPayment({
                    load_id: loadId, load_kind: loadKind, amount, mode, bank, paid_via: paidVia,
                    paid_on: paidOn, note: p.note,
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
