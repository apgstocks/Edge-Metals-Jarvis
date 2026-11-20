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
// A price per pound is a fraction of a dollar: money() would show 0.159 as "$0.16" on a confirm card
// while the total is worked out from 0.159. Show what will be saved, to 4 places, trimmed to at least 2.
const perLb = (n) => { const v = Math.round(Number(n) * 10000) / 10000; return `$${v.toFixed(4).replace(/(\.\d\d)0+$/, '$1').replace(/(\.\d\d\d)0$/, '$1')}`; };
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


    // ── REMOVED 2026-11-07, BY APSARA ───────────────────────────────────
    // find_claims, claim_detail and record_pickup lived here. This file IS
    // the YARD assistant's registry, and two guards went red when they
    // appeared in it:
    //
    //   tests/voice-router.js            Scout must advertise no freight
    //   tests/yard-assistant-knowledge.js  and its WRITE list must not grow
    //
    // Both guards exist for CLAUDE.md rule 5 — "Edge Yard and Edge Metals
    // are different companies ... the separation is most of what this app
    // is for". Claims are raised against SUPPLIERS on CONTAINERS and
    // pickups are booked with logistics companies: both are the export
    // side, and neither belongs to the yard.
    //
    // Asked whether to narrow the guards or remove the tools, Apsara chose
    // to remove them. Her words: "Neither — take both back out." So the
    // guards stay exactly as strict as they were.
    //
    // NOTHING IN PRODUCTION CALLED THEM. Every reference outside this file
    // was a test. The Follow-up Agent keeps its routes and its screen; what
    // it loses is the ability to record a pickup by TALKING to the yard
    // assistant. If that is wanted back, it belongs in Jarvis proper
    // (workflow/brain.js), not here.

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

    // Apsara, 2026-11-15: "why did the number become -12290 ... no guesses, only proper reasoning". Read-only; Edge Yard's
    // own loads and sales only. See helpers/stockExplain.js.
    explain_stock: {
        kind: 'read',
        description: 'EXPLAIN why one item\'s stock on hand is what it is, especially when it is negative: lines up every purchase and every sale of that item with a running balance, finds the day it went below zero, and checks its total against the Inventory screen. Use for "why is X negative", "why did the number become -N", "how is on-hand worked out". Say ONLY what its findings state. If it says the books cannot tell, say that. Never guess a cause.',
        params: { item: { type: 'string', required: true, describe: 'the item name exactly as on the Inventory screen' } },
        run: async (p) => {
            const { loadLoads, getInventoryReport } = require('./loads');
            const { loadOutboundLoads } = require('./outboundLoads');
            const inbound = loadLoads();
            return require('./stockExplain').explainStock({ inbound, outbound: loadOutboundLoads(), item: str(p.item), screenRows: getInventoryReport(inbound).byType });
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
            // receivableOf, not l.amount — these rows are SALES, and since
            // 2026-11-04 a sale can carry trucking charged on to the buyer.
            // Asking Jarvis "which sales are unpaid" off the gross amount
            // would call a sale settled while the freight on it is still
            // outstanding. The voice path is the caller CLAUDE.md records
            // breaking twice, both times because it has no form to put a
            // field on; it needs no new field here, only the right reader.
            const { receivableOf } = require('./outboundLoads');
            const withPay = rows.map((l) => ({ ...l, payment: paymentSummary(l.id, receivableOf(l)) }));
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
                // Ferrous / non-ferrous as she has answered it per item (helpers/itemMetal.js), 2026-11-20.
                metal_types: (() => { try { return require('./itemMetal').all(); } catch (e) { return {}; } })(),
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

    // ── PETTY CASH, ALL OF IT (2026-11-20) ────────────────────────────────
    // Apsara, on "$-25,386.03 company not stated" on her Petty cash screen: "i want scout to answer such kind of
    // questions", then "any data available in edge yard should be reasoned by scout". This used to return the total
    // and the last 20 rows — enough for "how much cash do we have", useless for "why is this company's figure what
    // it is". It still returns both (anything that asked before gets what it got), plus the per-account and
    // per-company split the screen shows, borrowings between accounts, and — with `account` — every movement in one
    // bucket with its ins and outs summed by kind, so a negative bucket can be EXPLAINED from its own rows.
    //
    // "Company not stated" is the Unassigned account: cash recorded with no bank behind it (the opening float, rows
    // from before accounts existed, and anything typed that matched no account). The tool says that in words so the
    // model never guesses a company for it — helpers/pettyCash.js refuses to, and so must the answer.
    petty_cash: {
        kind: 'read',
        description: 'The petty cash box, fully: total cash in hand; the balance of each cash account (Edge Metals, AAA Investment, Chase Bank, Unassigned) and of each company (Edge Metals, AAA Investment, Edge Yard, "Company not stated" = the Unassigned account); money borrowed between accounts; and recent movements. Pass account (an account OR a company name, including "Company not stated" / "Unassigned") to EXPLAIN that figure: every movement in it, with money in and out totalled by kind (top-up, payment, expense, transfer, reversal) and the load or seller behind each payment. Use for any question about why a cash or company figure is what it is, especially a negative one.',
        params: {
            account: { type: 'string', describe: 'an account or company to explain, e.g. "Company not stated", "Unassigned", "Edge Yard", "Chase Bank"' },
            from: { type: 'date', describe: 'only movements on or after this date' },
            to: { type: 'date', describe: 'only movements on or before this date' },
        },
        run: async (p) => {
            const petty = require('./pettyCash');
            const entries = petty.listEntries();
            const b = petty.balances();
            const out = {
                balance: petty.balance(),
                by_account: b.bySource, by_company: b.byCompany, bank_of_account: b.bankOf, company_of_account: b.companyOf,
                company_not_stated_means: `"${petty.COMPANY_UNKNOWN}" is the ${petty.UNASSIGNED} account: cash recorded with no bank or company behind it — the opening float, rows from before accounts existed, and any name that matched no account. Nobody has said whose it is; do not assign it to a company.`,
                pending_assignment: petty.pendingAssignment(entries),
                borrowings: (() => { try { return petty.borrowings(entries); } catch (e) { return null; } })(),
            };
            const inRange = (e) => (!p.from || String(e.date || '') >= p.from) && (!p.to || String(e.date || '') <= p.to);
            if (!p.account) return { ...out, ...cap(entries.filter(inRange).slice(-20).reverse()) };

            const want = String(p.account).trim().toLowerCase();
            const isUnknown = want === petty.COMPANY_UNKNOWN.toLowerCase() || want === 'company not stated' || want === 'not stated' || want === 'unassigned';
            const accounts = petty.SOURCES.filter((s) => (isUnknown ? s === petty.UNASSIGNED
                : s.toLowerCase() === want || petty.companyOf(s).toLowerCase() === want));
            if (!accounts.length) return { ...out, error: `"${p.account}" is not a cash account or company here. Accounts: ${petty.SOURCES.join(', ')}.` };

            // Who a payment row was for, so "a payment" becomes "paid Randy for EDGE_47".
            const loads = (() => { try { return require('./loads').loadLoads(); } catch (e) { return []; } })();
            const sellerOf = (id) => { const l = id && loads.find((x) => x.id === id); return l ? (l.seller || l.buyer || null) : null; };
            const rows = entries.filter((e) => accounts.includes(petty.sourceOf(e)) && inRange(e))
                .sort((x, y) => String(x.date || '').localeCompare(String(y.date || '')))
                .map((e) => ({ id: e.id, date: e.date, kind: e.kind, amount: num(e.amount), account: petty.sourceOf(e),
                    typed_account: e.cash_source || null, load_id: e.load_id || null, seller: sellerOf(e.load_id),
                    expense_id: e.expense_id || null, transfer_reason: e.transfer_reason || null,
                    transfer_to: e.transfer_to || null, transfer_from: e.transfer_from || null, note: e.note || null, by: e.created_by || null }));
            const byKind = {};
            let moneyIn = 0, moneyOut = 0;
            for (const r of rows) {
                const k = byKind[r.kind] || (byKind[r.kind] = { in: 0, out: 0, count: 0 });
                k.count++;
                if ((r.amount || 0) >= 0) { k.in += r.amount || 0; moneyIn += r.amount || 0; } else { k.out += r.amount || 0; moneyOut += r.amount || 0; }
            }
            const r2 = (v) => Math.round(v * 100) / 100;
            for (const k of Object.values(byKind)) { k.in = r2(k.in); k.out = r2(k.out); }
            return { ...out, explaining: { asked: p.account, accounts, balance: r2(moneyIn + moneyOut), money_in: r2(moneyIn), money_out: r2(moneyOut), by_kind: byKind },
                // The biggest withdrawals first in their own list: a negative bucket is usually a handful of large payments.
                largest_outflows: rows.filter((r) => (r.amount || 0) < 0).sort((x, y) => x.amount - y.amount).slice(0, 15),
                ...cap(rows.slice().reverse()) };
        },
    },

    // ── EVERY YARD PAYMENT, SEARCHABLE (2026-11-20) ───────────────────────
    // "any data available in edge yard should be reasoned by scout". Payments were only reachable one load at a time
    // (load_detail) or as totals (spend_report), so "everything we paid by Zelle in October" or "what did Chase pay
    // for" had no answer. Reads data/payments.json — the yard's money ledger — and names who each payment was for.
    find_payments: {
        kind: 'read',
        description: 'Search EVERY payment in the yard money ledger: paid to sellers on purchase loads, received from buyers on sales, paid to truckers, and supplier prepayments. Filter by who (seller, buyer or trucker, loosely), load number, mode (Cash, Zelle, Wire, Cheque, Bank transfer), bank, paid via (which company paid: Edge Yard, Edge Metals, AAA Investment) and date range. Returns each payment with who it was for, plus totals by mode, by bank and by company. Use for "what did we pay by Zelle", "how much did Edge Metals pay for yard loads", "payments to Randy in October".',
        params: {
            who: { type: 'string', describe: 'seller, buyer or trucker name, matched loosely' },
            load_id: { type: 'string', describe: 'one load or sale number' },
            mode: { type: 'string' }, bank: { type: 'string' }, paid_via: { type: 'string' },
            kind: { type: 'string', describe: 'purchase, sale, trucker or prepayment' },
            from: { type: 'date' }, to: { type: 'date' },
        },
        run: async (p) => {
            const cfg = require('../config');
            const all = (() => { try { const r = require('./json').loadJson(cfg.PAYMENTS_FILE, []); return Array.isArray(r) ? r : []; } catch (e) { return []; } })();
            const loads = (() => { try { return require('./loads').loadLoads(); } catch (e) { return []; } })();
            const sales = (() => { try { return require('./outboundLoads').loadOutboundLoads(); } catch (e) { return []; } })();
            const bills = (() => { try { return require('./truckerBills').listBills(); } catch (e) { return []; } })();
            const whoOf = (r) => {
                if (r.is_advance) return r.seller || null;
                if (r.load_kind === 'sale') { const s = sales.find((x) => x.id === r.load_id); return s ? s.buyer || null : null; }
                if (r.load_kind === 'trucker') { const t = bills.find((x) => x.id === r.load_id); return t ? (t.company || t.trucker || null) : null; }
                const l = loads.find((x) => x.id === r.load_id); return l ? l.seller || null : null;
            };
            const kindOf = (r) => (r.is_advance ? 'prepayment' : (r.load_kind || 'purchase'));
            const lc = (v) => String(v == null ? '' : v).toLowerCase();
            const rows = all.map((r) => ({ id: r.id, date: r.paid_on || null, kind: kindOf(r), who: whoOf(r), load_id: r.load_id || null,
                mode: r.mode || null, bank: r.bank || null, paid_via: r.paid_via || null, amount: num(r.amount),
                applied_from_prepayment: r.applied_from || null, reference: r.reference || null, note: r.note || null, by: r.created_by || null }))
                .filter((r) => (!p.who || lc(r.who).includes(lc(p.who)))
                    && (!p.load_id || lc(r.load_id) === lc(p.load_id))
                    && (!p.mode || lc(r.mode) === lc(p.mode))
                    && (!p.bank || lc(r.bank).includes(lc(p.bank)))
                    && (!p.paid_via || lc(r.paid_via) === lc(p.paid_via))
                    && (!p.kind || lc(r.kind) === lc(p.kind))
                    && (!p.from || String(r.date || '') >= p.from) && (!p.to || String(r.date || '') <= p.to))
                .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
            const sum = (key) => rows.reduce((m, r) => { const k = r[key] || '(not recorded)'; m[k] = Math.round(((m[k] || 0) + (r.amount || 0)) * 100) / 100; return m; }, {});
            // total_amount, NOT total: cap() returns its own `total` (the row count) and would overwrite a money figure
            // of the same name — which is exactly what the first version of this did.
            return { ...cap(rows), total_amount: Math.round(rows.reduce((a, r) => a + (r.amount || 0), 0) * 100) / 100, count: rows.length,
                by_mode: sum('mode'), by_bank: sum('bank'), by_company: sum('paid_via'), by_kind: sum('kind') };
        },
    },

    // Prepayments a seller still has credit from (2026-11-20). Named seller_, not supplier_: in this app "supplier" is a
    // freight word (tests/voice-router.js guards it), and the yard calls the people it buys from sellers. record_prepayment could WRITE one and nothing could
    // read what was left of it.
    seller_credit: {
        kind: 'read',
        description: 'Seller prepayments (money paid to a seller BEFORE a load) and how much credit each seller still has unused. Pass seller for one seller; without it, every seller holding credit.',
        params: { seller: { type: 'string', describe: 'seller name (exact as recorded); leave empty for everyone with credit' } },
        run: async (p) => {
            const pay = require('./payments');
            if (p.seller) return pay.prepaymentCredit(p.seller);
            const sellers = [...new Set(pay.listPrepayments().map((a) => a.seller).filter(Boolean))];
            const rows = sellers.map((s) => pay.prepaymentCredit(s)).filter((r) => r.available > 0.005);
            return cap(rows);
        },
    },

    // Who changed what (2026-11-20) — the audit log built today, so "who changed the price on EDGE_47" and "what did
    // Maria do yesterday" have an answer. Scout is manager-only already (/api/yard/ask), and so is the log.
    change_history: {
        kind: 'read',
        description: 'The yard audit log: who changed what and when, with before → after values. Filter by record (a load number, bill or expense id), person (user ID or role), kind of change (e.g. "Load edited", "Payment deleted", "Sign in") and date range. Use for "who changed EDGE_47", "who deleted that payment", "what did maria do today". Starts from the day the log was switched on; earlier changes were not recorded.',
        params: { subject: { type: 'string' }, actor: { type: 'string' }, action: { type: 'string' }, text: { type: 'string', describe: 'any word in the entry' },
            from: { type: 'date' }, to: { type: 'date' } },
        run: async (p) => {
            const r = require('./changeLog').list({ subject: p.subject, actor: p.actor, action: p.action, q: p.text, from: p.from, to: p.to, limit: MAX_ROWS });
            return { total: r.total, rows: r.rows, truncated: r.total > r.rows.length };
        },
    },

    // Addresses (2026-11-20) — the Address Book page is on the yard menu, and its data was invisible to Scout.
    find_address: {
        kind: 'read',
        description: 'Look up a seller, buyer or company in the Address Book: address, phone, email. Matched loosely on name and aliases.',
        params: { name: { type: 'string', required: true } },
        run: async (p) => {
            const lc = (v) => String(v == null ? '' : v).toLowerCase();
            const all = require('./addressBook').loadAddressBook() || [];
            const want = lc(p.name).trim();
            return cap((Array.isArray(all) ? all : []).filter((e) => lc(e.name).includes(want)
                || (Array.isArray(e.aliases) && e.aliases.some((a) => lc(a).includes(want)))));
        },
    },

    // ══ THE BANK AND THE CLAIMS, WHICH THE BOT COULD NOT SEE ═══════════════
    // Apsara, 2026-11-05: "what about our own bot" — then, on finding it had
    // no way in: "give door access".
    //
    // Eighteen tools covered loads, inventory, sales, expenses, petty cash
    // and trucker bills. None touched the bank and none touched claims —
    // the two newest and most expensive subsystems in the app. So the
    // QuickBooks Ask box could answer about Intuit's data while her own bot
    // could not answer "who is that deposit from" or "which claims are
    // open". That is the wrong way round, and it is the whole argument for
    // Jarvis over QuickBooks.
    //
    // ALL FOUR ARE READ. The writes stay on the screens, because confirming
    // a receipt asks about fees, discounts and the payment mode, and
    // CLAUDE.md records the voice path breaking twice for exactly this
    // reason — it is the caller with no form to put a field on. A write
    // tool here is a separate decision, asked for one at a time.

    // ── THE PICKUP, BY TALKING (2026-11-06) ─────────────────────────────
    // Apsara: "Have a followup agent", and before that the pickup she books
    // with a logistics company. She chose BOTH entry points — Jarvis
    // arranges it, and she records one — so the voice path gets the same
    // door the screen has.
    //
    // CLAUDE.md rule 1 names this caller twice: the voice path is the one
    // that breaks, because it is the caller with no form to put a field on.
    // So it is built from the store's OWN requirements (company and date,
    // nothing else) rather than from whatever the screen happens to collect.
    // A field the screen adds later cannot break this.

    // Read, so it answers at once — "is anyone chasing the Zimex pickup?"
    // is a question, and making her confirm a lookup is what made this feel
    // like a form.
    pickup_status: {
        kind: 'read',
        description: 'Pickups arranged, what Jarvis has already asked the logistics company, '
            + 'and whether they have given an ETA yet.',
        params: { company: { type: 'string' }, container: { type: 'string' }, open: { type: 'boolean' } },
        run: async (p) => {
            const pk = require('./pickups');
            const agent = require('./pickupAgent');
            const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
            let rows = pk.list();
            if (norm(p.company)) rows = rows.filter((r) => norm(r.company).includes(norm(p.company)));
            if (norm(p.container)) rows = rows.filter((r) => norm(r.container_no) === norm(p.container));
            if (p.open) rows = rows.filter((r) => r.status === 'arranged' && !String(r.eta || '').trim());
            const nowD = new Date();
            return {
                pickups: rows.length,
                rows: rows.map((r) => {
                    const next = agent.nextAction(r, nowD);
                    return {
                        company: r.company, container_no: r.container_no,
                        pickup_date: r.pickup_date, status: r.status,
                        // Her actual question is "has anyone chased them",
                        // so the answer leads with that rather than a status.
                        eta: r.eta || null,
                        asked: (r.sent || []).filter((s) => s && s.step !== 'escalate').length,
                        team_told: (r.sent || []).some((s) => s && s.step === 'escalate'),
                        next_step: next.step, next_why: next.why,
                    };
                }),
            };
        },
    },

    bank_unmatched: {
        kind: 'read',
        description: 'Money in the bank that is not yet explained — deposits with no invoice '
            + 'against them and withdrawals with no bill. Says what Jarvis read each line as.',
        params: { direction: { type: 'string' }, limit: { type: 'number' } },
        run: async (p) => {
            const ledger = require('./bankLedger');
            const { payeeOf } = require('./bankPayee');
            const want = String(p.direction || '').toLowerCase();
            const rows = (ledger.worklist ? ledger.worklist() : ledger.list()) || [];
            const open = rows.filter((r) => !ledger.actedOn || !ledger.actedOn(r))
                .filter((r) => (want === 'in' ? Number(r.amount) > 0
                              : want === 'out' ? Number(r.amount) < 0 : true));
            // read_as is the point of the answer: a bank line is unreadable
            // out loud, and the company name is the only part she wants said.
            const said = open.map((r) => ({
                date: r.date || r.posted_at || null,
                amount: r.amount,
                read_as: payeeOf(r.descriptor || r.name || '') || null,
                descriptor: r.descriptor || r.name || '',
                bank: (ledger.bankOf ? ledger.bankOf(r) : null) || null,
            }));
            const total = said.reduce((t, r) => t + (Number(r.amount) || 0), 0);
            return { unexplained_rows: said.length, unexplained_total: Math.round(total * 100) / 100,
                     ...cap(said.slice(0, Math.max(1, Math.min(Number(p.limit) || 25, MAX_ROWS)))) };
        },
    },

    bank_who_is: {
        kind: 'read',
        description: 'Who a bank line is from. Reads the company name out of the bank\'s own '
            + 'description and says whether it matches anyone in the ledger.',
        params: { descriptor: { type: 'string', required: true } },
        run: async (p) => {
            const { payeeOf } = require('./bankPayee');
            const bankLearn = require('./bankLearn');
            const read = payeeOf(p.descriptor);
            // The same two steps the screen takes, in the same order, so the
            // bot and the Bank page can never disagree about one line.
            const customers = (() => {
                try { return require('./bankMatchRoutes').openReceivables().map((d) => d.party)
                    .filter(Boolean); } catch (e) { return []; }
            })();
            const names = [...new Set(customers)];
            const resolved = bankLearn.resolverFrom(bankLearn.listAliases(), names)(p.descriptor);
            const hints = resolved ? [] : (bankLearn.suggestParty(p.descriptor, names) || []);
            return {
                read_as: read || null,
                matched: resolved || null,
                // Never a single guess dressed as an answer: nameMatch.js
                // refuses near-misses because a wrong one pays the wrong
                // company. Two candidates come back as two.
                suggestions: hints.slice(0, 3),
                needs_you: !resolved,
            };
        },
    },



    // ══ WRITE ══════════════════════════════════════════════════════════════
    // Each returns a PROPOSAL — a summary, the details worth checking, any
    // warnings, and a run() that is only ever called after the person
    // confirms. None of these writes anything when it is called.

    // ── RECORD A SUPPLIER PREPAYMENT BY TALKING ──────────────────────────
    // Apsara: "Add a supplier prepayment option in loads" / "edge yard" /
    // "Build prepayment properly".
    //
    // THIS TOOL EXISTS IN THE SAME COMMIT AS THE FEATURE, which is the whole
    // point. CLAUDE.md records four separate occasions when a requirement
    // landed in shared payment code and THIS path was the caller that could
    // not satisfy it — because it has no form to hang a field on. So every
    // field helpers/payments.addPrepayment can demand has a box here:
    // mode, bank, paid_via and cash_source. Checked by opening addPrepayment
    // and listing what it reads, not by guessing.
    //
    // A prepayment has no load_id by design, so there is no id to validate
    // against — the seller's NAME is all there is. That makes a misheard name
    // the likeliest failure, and the propose card prints it back with the
    // amount and what the supplier would then be holding, so she is agreeing
    // to a sentence rather than a tool call.
    record_prepayment: {
        kind: 'write',
        description: 'Record money paid to a supplier BEFORE there is a load for it — '
            + 'held as credit against that supplier until it is put on a load.',
        params: {
            seller: { type: 'string', required: true, describe: 'the supplier who was paid' },
            amount: { type: 'number', required: true },
            mode: { type: 'string', required: true,
                describe: require('./payments').modesForKind('purchase').join(', ') },
            bank: { type: 'string', describe: 'which bank a Wire went out of, if she said' },
            cash_source: { type: 'string', describe: 'on a CASH prepayment, which cash: '
                + require('./pettyCash').SOURCES.filter((x) => x !== 'Unassigned').join(', ')
                + ', or leave unsaid for unbanked cash' },
            paid_via: { type: 'string', describe: 'Edge Yard, Edge Metals or AAA Investment — '
                + 'whose money moved. Needed for a Wire.' },
            paid_on: { type: 'date', describe: 'defaults to today' },
            reference: { type: 'string' },
            note: { type: 'string' },
        },
        propose: async (p) => {
            const pay = require('./payments');
            const seller = str(p.seller);
            if (!seller) throw new Error('Which supplier was paid?');
            const amount = Number(p.amount);
            if (!isFinite(amount) || amount <= 0) throw new Error('How much was paid?');

            const allowed = pay.modesForKind('purchase');
            const mode = allowed.find((m) => m.toLowerCase() === str(p.mode).toLowerCase());
            if (!mode) throw new Error(`A supplier is paid by ${allowed.join(', ')}.`);

            // ── REFUSED AT PROPOSE, NOT AT RUN ───────────────────────────
            // The 2026-09-17 lesson, applied up front this time: resolve the
            // bank and the paid-via question HERE, while she can still answer
            // it. A proposal that fails after she has said yes is exactly the
            // failure propose-then-confirm exists to prevent.
            const banks = require('./banks');
            const bank = await banks.resolveForMode(mode, p.bank);
            pay.resolvePaidVia('purchase', mode, p.paid_via, bank);

            const before = pay.prepaymentCredit(seller);
            const details = [
                ['Supplier', seller],
                ['Amount', money(amount)],
                ['Mode', mode],
            ];
            if (bank) details.push(['Bank', bank]);
            if (p.paid_via) details.push(['Payment via', str(p.paid_via)]);
            if (mode === 'Cash') {
                details.push(['Cash from', str(p.cash_source) || 'unbanked cash']);
            }
            details.push(['Already held for this supplier', money(before.available)]);
            details.push(['Held after this', money(before.available + amount)]);

            const warnings = [];
            // Said out loud: a prepayment is not against any load yet, and
            // she is confirming without a screen. If she meant to pay an
            // EXISTING load, this is the sentence that catches it.
            warnings.push('This is not against any load — it sits as credit for '
                + `${seller} until you put it on one.`);
            if (banks.expectsBank(mode) && !bank) {
                warnings.push(`No bank recorded for this ${mode} — it will show as "Not recorded" on the spend report.`);
            }

            return {
                summary: `Record a ${mode} prepayment of ${money(amount)} to ${seller}`,
                details,
                warnings,
                run: async () => {
                    const rec = await pay.addPrepayment({
                        seller, amount, mode,
                        bank: p.bank, paid_via: p.paid_via, cash_source: p.cash_source,
                        paid_on: p.paid_on, reference: p.reference, note: p.note,
                        created_by: 'jarvis',
                    });
                    const after = pay.prepaymentCredit(seller);
                    return {
                        ok: true,
                        prepayment_id: rec.id,
                        said: `Recorded. ${seller} is now holding ${money(after.available)} in prepayments.`,
                    };
                },
            };
        },
    },

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
            // ── WHICH CASH, ON A CASH PAYMENT ──────────────────────────────
            // Apsara, 2026-09-21: cash in the box is now tracked per bank.
            // NOT the same field as `bank` above, and the difference is why
            // there are two: `bank` says which account a TRANSFER left;
            // this says which trip to the bank the NOTES came from. banks.js
            // still refuses `bank` on a cash payment and is still right to.
            //
            // Optional, deliberately. She will often just say "pay Ramesh
            // 2,000 cash" and never mention a bank — refusing that would
            // break the thing this tool exists for. Unsaid means the payment
            // comes out of unbanked cash, which is a real bucket and an
            // honest answer rather than a placeholder.
            // Built from the ONE list rather than spelled out here. It was
            // spelled out, and the day BofA became two accounts this line
            // would have kept telling the model there were two buckets while
            // the server knew about four — so "pay Gomez cash from AAA
            // Investment" would have been proposed as unbanked cash and
            // filed against the wrong company. helpers/pettyCash.cleanSource
            // accepts a slash, a dash or plain spaces, and resolves a bare
            // "Edge Metals" when only one bucket can mean it.
            cash_source: { type: 'string', describe: 'on a CASH payment, which cash: '
                + require('./pettyCash').SOURCES.filter((s) => s !== 'Unassigned').join(', ')
                + ', or leave unsaid for unbanked cash' },
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
            paid_via: { type: 'string', describe: 'Edge Yard, Edge Metals or AAA Investment — whose money moved. BofA holds Edge Metals and AAA Investment; Chase is Edge Yard, so a Chase wire needs no answer.' },
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
            // The bank goes in too since 2026-09-24, so the voice path is
            // held to the same rule as the form: a wire out of BofA cannot be
            // filed against Edge Yard. Passing it also means Chase resolves
            // itself, so "record a wire of $12,000 from Chase" no longer has
            // to be told whose money it was.
            // p.bank, not `bank` — the resolved one is computed sixty lines
            // further down and referencing it here is a temporal-dead-zone
            // crash on every voice payment. Found by tests/tools.js, which is
            // the third time this caller has caught a change made for the
            // form: it has no form, so it breaks differently and later.
            //
            // The raw value is enough: paidViaOptionsFor only needs the bank's
            // NAME to know which companies bank there.
            const paidVia = resolvePaidVia(loadKind, mode, p.paid_via, p.bank);

            // ── WHICH CASH, AND WHETHER IT WILL HAVE TO BORROW ───────────
            // Worked out HERE, at propose time, so the confirm card states it
            // before she says yes rather than the write failing after. The
            // pay modal refuses and re-asks; this tool has no second round,
            // so the question has to be answered on the card in front of her.
            const petty = require('./pettyCash');
            let cashSource = null;
            let borrowNote = null;
            if (mode.toLowerCase() === 'cash' && loadKind !== 'sale') {
                cashSource = petty.cleanSource(p.cash_source, { allowBlank: true });
                const buckets = petty.balanceBySource(petty.listEntries());
                const held = Number(buckets[cashSource] || 0);
                if (amount - held > 0.005) {
                    const lenders = petty.SOURCES
                        .filter((x) => x !== cashSource)
                        .map((x) => ({ source: x, available: Number(buckets[x] || 0) }))
                        .filter((l) => l.available > 0.005)
                        .sort((a, b) => b.available - a.available);
                    if (lenders.length) {
                        borrowNote = `${cashSource} holds ${money(held)} — confirming this borrows `
                            + `${money(Math.round((amount - held) * 100) / 100)} from `
                            + lenders.map((l) => l.source).join(' and ') + '.';
                        // ── AND WHETHER THAT CROSSES A COMPANY LINE ──────
                        // Apsara, 2026-09-21, chose to ALLOW borrowing between
                        // Edge Metals and AAA Investment and have it recorded
                        // as owed. This card is the last thing she reads
                        // before the money moves, and on this path there is no
                        // second round to ask in — so if confirming creates a
                        // balance between two companies, the card says so now.
                        const mine = petty.companyOf(cashSource);
                        const across = lenders
                            .map((l) => petty.companyOf(l.source))
                            .filter((co) => co !== petty.COMPANY_UNKNOWN && co !== mine);
                        if (mine !== petty.COMPANY_UNKNOWN && across.length) {
                            borrowNote += ` That is a loan between two companies — ${mine} would owe `
                                + Array.from(new Set(across)).join(' and ') + '.';
                        }
                    }
                }
            }

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
            // expectsBank, NOT needsBank. Zelle and Cheque may carry a bank
            // from 2026-10-01 ("keep it as optional"), and warning here would
            // nag on every Zelle she records by talking — a path with no
            // dropdown to satisfy the warning. See helpers/banks.js.
            if (banks.expectsBank(mode) && !bank) {
                warnings.push(`No bank recorded for this ${mode} — it will show as "Not recorded" on the spend report.`);
            }
            // Said on the card, because confirming it is what authorises the
            // borrow — there is no second prompt on this path.
            if (borrowNote) warnings.push(borrowNote);
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
                    ...(cashSource ? [['Which cash', cashSource]] : []),
                    // Shown only when it applies — a "Payment via: " line on a
                    // cash payment is noise on a card she reads at a gate.
                    ...(paidVia ? [[require('./payments').paidViaLabel(loadKind), paidVia]] : []),
                    ['Left pending after', money(Math.max(after, 0))],
                ],
                warnings,
                run: async (ctx) => require('./payments').addPayment({
                    load_id: loadId, load_kind: loadKind, amount, mode, bank, paid_via: paidVia,
                    paid_on: paidOn, note: p.note,
                    cash_source: cashSource,
                    // She confirmed a card that SAID it would borrow — see
                    // borrowNote above. Sending this without that sentence on
                    // the card would be moving money between her bank
                    // accounts on an answer she was never asked for.
                    allow_borrow: !!borrowNote,
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

    // ── ITEM NAME CLEAN-UP (2026-11-18) ──────────────────────────────────────
    // Apsara: "Rotor and Rotors, all this cleaning should be handled by Scout automatically" and, asked how far,
    // "Scout finds, you confirm". So: a READ tool that finds likely twins (case, spacing, hyphens, a plural s) and a
    // WRITE tool that is only ever a confirm card. The merge itself is Item maintenance's apply(), journalled with
    // Undo; nothing here rewrites a record by itself. Edge Yard only (those files are all it reads).
    find_item_variants: {
        kind: 'read',
        description: 'Edge Yard item names that look like the same item spelled differently (Rotor / Rotors, Al-combo / Al combo): same words apart from case, spacing, hyphens or a plural s. Use when asked to clean up, tidy or merge item names, or when two item names look like one. It only LISTS; to merge, propose merge_item_names for the group the person agrees with. A group marked conflict has one name filed as ferrous and another as non-ferrous, so they may not be the same item: say so, never suggest merging it.',
        params: {},
        run: async () => {
            const groups = require('./itemMaintenance').variants();
            return { total: groups.length, groups: groups.slice(0, 20), showing: Math.min(20, groups.length) };
        },
    },

    merge_item_names: {
        kind: 'write',
        description: 'Merge item spellings that are the same item into ONE name, across Edge Yard loads bought, loads sold and open drafts (names only: no weight, price or status changes; Undo is in Settings, Item maintenance). Only for names find_item_variants listed or the person named. Always a confirm card.',
        params: {
            from: { type: 'array', required: true, describe: 'the spellings to merge, exactly as listed, e.g. ["Rotor","Rotors"]' },
            to: { type: 'string', required: true, describe: 'the one name they should all become, normally the spelling used most' },
        },
        propose: async (p, ctx = {}) => {
            const IM = require('./itemMaintenance');
            if (ctx.role && ctx.role !== 'admin') throw new Error('Merging item names rewrites saved loads, so only the manager can confirm it. Ask the manager, or use Settings, Item maintenance.');
            const names = (Array.isArray(p.from) ? p.from : [p.from]).map(str).filter(Boolean);
            const to = str(p.to);
            if (!names.length || !to) throw new Error('which item names should be merged, and into what?');
            // Untrusted input: every name must be an item that exists today, matched exactly as the screen lists it.
            const have = IM.summary({});
            const known = new Map(have.flatMap((it) => it.spellings.map((sp) => [IM.keyOf(sp), sp])));
            const missing = names.filter((n) => !known.has(IM.keyOf(n)));
            if (missing.length) throw new Error(`I cannot find an item called ${missing.map((n) => `"${n}"`).join(', ')} on the yard's loads. Use find_item_variants to see the exact names.`);
            const from = [...new Set(names.map((n) => known.get(IM.keyOf(n))))];
            const pv = IM.preview(from, to);
            if (!pv.total_lines) throw new Error('Those names are already exactly that, so there is nothing to merge.');
            const metal = require('./itemMetal');
            const types = new Set(from.concat(to).map((n) => metal.typeOf(n)).filter(Boolean));
            const warnings = [];
            if (types.size > 1) warnings.push('These names are filed under different metal types (ferrous and non-ferrous). Check they really are the same item before confirming.');
            const where = Object.values(pv.stores).filter((x) => x.lines).map((x) => `${x.lines} line${x.lines === 1 ? '' : 's'} in ${x.loads} ${x.label}`).join(', ');
            return {
                summary: `Rename ${from.map((n) => `"${n}"`).join(' and ')} to "${to}" on ${pv.total_lines} saved line${pv.total_lines === 1 ? '' : 's'}.`,
                details: [['From', from.join(', ')], ['To', to], ['Changes', where || 'none'], ['Not changed', 'weights, prices, status, issued PDFs'], ['Undo', 'Settings, Item maintenance, Recent renames']],
                warnings,
                run: async (c = {}) => {
                    // The route is admin-only and this rewrites saved loads, so the role is re-checked at the moment of the write.
                    if (c.role !== 'admin') throw new Error('Only the manager can merge item names.');
                    const r = await IM.apply(from, to, { by: 'scout' });
                    try { await metal.carryOnRename(from, to); } catch (e) { /* the type is a convenience */ }
                    try { require('./sheetSync').scheduleSync(r.months || []); } catch (e) { /* Drive is best-effort */ }
                    return r;
                },
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
// The attachment tools are described only when a file is attached (2026-11-20): without one they can do nothing,
// and describing them on every question — the voice path included — only invites a call that has to fail.
function describeTools({ attachmentsOnly = false } = {}) {
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
    const reads = Object.entries(TOOLS).filter(([, t]) => t.kind === 'read' && !t.needsAttachment === !attachmentsOnly);
    const writes = Object.entries(TOOLS).filter(([, t]) => t.kind === 'write' && !t.needsAttachment === !attachmentsOnly);
    if (attachmentsOnly) {
        return [
            'FILE TOOLS (only because a file is attached). The read tool runs immediately; the two record tools are PROPOSED',
            'and the person confirms a card listing every row:',
            ...reads.map(([n, t]) => line(n, t)),
            ...writes.map(([n, t]) => line(n, t)),
        ].join('\n');
    }
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

// ── RECORD AN OUTBOUND SALE (2026-11-14) ───────────────────────────────────
// Apsara typed into the yard assistant: "We have sold all rotors and drums
// before 11/13. Make changes in my inventory accordingly. We sold this to
// metalco" — and was told it cannot record outbound sales. Asked what she
// wanted, she chose: teach the assistant, and ASK her the price and the sale
// date every time rather than guess.
//
// WHAT IT DOES: sells ALL that is still on hand of the named items, from the
// purchase lots received before a cutoff date, as one outbound load. Stock is
// netted by DRAWS (helpers/stock.js), so the sale is written with draws against
// the exact lots — that is what makes on-hand fall, and it is the same shape
// the outbound screen writes, saved through the same addOutboundLoad.
//
// WHAT IT DOES NOT DO: partial quantities (the screen does that), prices in
// anything but $/lb, or any change to Edge Metals (bills, sales, proformas).
// Draws are written per item line, so what a lot has already given up is
// known per item; a shared lot's weight is never counted twice.
TOOLS.record_outbound_sale = {
    kind: 'write',
    // ── NEVER WHEN A WEIGHT IS GIVEN (2026-11-21) ─────────────────────────
    // Apsara pasted one container — "HMS 81500 31060 … 50,440 for Metalco" — and asked to "create a sale". This was
    // the only sale tool the assistant had, so it sold ALL the HMS on hand, 111,069 lb, as OUT_38. record_sale now
    // exists for one sale with her weights; this one says, in the description and on the card, that it is EVERYTHING.
    description: 'Sell ALL the stock on hand of named items as a single sale (optionally only lots received before a date). ONLY when she says she sold all / everything of an item and gives NO weight. If ANY weight or a single load / lot is mentioned, use record_sale instead — never this.',
    params: {
        buyer: { type: 'string', required: true, describe: 'who the yard sold to' },
        date: { type: 'date', required: true, describe: 'the sale date as YYYY-MM-DD — ASK, do not assume today' },
        price: { type: 'number', required: true, describe: 'the price in dollars, in the unit given by price_per — ASK, do not guess' },
        price_per: { type: 'string', describe: 'the unit the price is quoted in: lb (default), metric_ton (MT, tonne, 2204.62 lb), gross_ton (2240 lb) or net_ton (2000 lb). Pass the price AS SHE SAID IT and the unit — never convert it yourself; the system does the arithmetic.' },
        descriptions: { type: 'array', required: true, describe: 'item names to sell, e.g. ["Rotors","Drums"]' },
        received_before: { type: 'date', describe: 'only lots received BEFORE this date (YYYY-MM-DD); omit for every lot' },
        note: { type: 'string' },
    },
    propose: async (p, ctx = {}) => {
        const { loadLoads } = require('./loads');
        const { loadOutboundLoads } = require('./outboundLoads');
        const stock = require('./stock');
        const { keyOf } = require('./itemMaintenance');
        const buyer = str(p.buyer);
        if (!buyer) throw new Error('who did the yard sell to?');
        const quoted = num(p.price);
        if (quoted == null || quoted <= 0) throw new Error('what price? A sale needs one');
        // The sale is stored per lb. A price quoted per ton is divided HERE, in code, from what she said
        // (Apsara 2026-11-15: "per mt weight is 350" - the model was asked to convert and kept asking).
        const UNITS = { lb: 1, lbs: 1, pound: 1, metric_ton: 2204.62, mt: 2204.62, tonne: 2204.62, gross_ton: 2240, long_ton: 2240, net_ton: 2000, short_ton: 2000 };
        const unitKey = str(p.price_per || 'lb').toLowerCase().replace(/[\s/-]+/g, '_').replace(/^per_/, '');
        if (!(unitKey in UNITS)) throw new Error(`I don't know the price unit "${p.price_per}" - is it per lb, per metric ton (MT), per gross ton or per net ton?`);
        // A per-lb price above $5 is a per-ton price typed without its unit; do not sell scrap at $350 a pound.
        if (UNITS[unitKey] === 1 && quoted > 5) throw new Error(`$${quoted} per lb is far too high for scrap - is that per metric ton (MT), per gross ton or per net ton?`);
        const price = quoted / UNITS[unitKey];
        const quotedText = UNITS[unitKey] === 1 ? null : `${money(quoted)} per ${unitKey === 'metric_ton' || unitKey === 'mt' || unitKey === 'tonne' ? 'metric ton (2,204.62 lb)' : (unitKey === 'gross_ton' || unitKey === 'long_ton') ? 'gross ton (2,240 lb)' : 'net ton (2,000 lb)'}`;
        if (!isYmd(p.date)) throw new Error('what date was the sale?');
        const cutoff = isYmd(p.received_before) ? p.received_before : null;
        const names = (Array.isArray(p.descriptions) ? p.descriptions : [p.descriptions]).map(str).filter(Boolean).slice(0, 12);
        if (!names.length) throw new Error('which items were sold?');

        const inbound = loadLoads();
        const outbound = loadOutboundLoads();
        const lots = stock.lotReport(inbound, outbound).filter((l) => l.remaining > 0.001 && (!cutoff || (l.date && l.date < cutoff)));
        const byId = new Map(inbound.map((l) => [l.id, l]));

        // One draw per lot (all items together), one item line per name.
        // ITEM-LEVEL, not pro rata: a draw is (load, weight), but a draw is
        // always written on an outbound ITEM LINE, so what each lot has already
        // given up PER ITEM is known from those lines. Sharing a lot's remaining
        // weight pro rata instead attributes an earlier all-rotors sale to the
        // drums too, and the item totals then disagree with stockReport (rotors
        // went 167 lb negative in the first version of this test).
        const drawnFrom = new Map();   // `${lot}|${item}` -> weight already drawn
        for (const o of outbound) {
            for (const it of (o.items || [])) {
                for (const d of (it.draws || [])) {
                    const key = `${d.load_id}|${keyOf(it.description)}`;
                    drawnFrom.set(key, (drawnFrom.get(key) || 0) + (Number(d.weight) || 0));
                }
            }
        }
        const onHandAll = new Map(stock.stockReport(inbound, outbound).map((r) => [keyOf(r.description), r.purchased - r.shipped]));
        const room = new Map(lots.map((l) => [l.id, l.remaining]));
        const lines = [];
        const drawByLot = new Map();
        for (const name of names) {
            const k = keyOf(name);
            let cap = Math.max(0, onHandAll.has(k) ? onHandAll.get(k) : 0);
            let weight = 0; const itemDraws = [];
            for (const lot of lots) {
                if (cap <= 0.001) break;
                const load = byId.get(lot.id);
                const mine = (load && load.items || []).filter((i) => keyOf(i.description) === k).reduce((a, i) => a + (Number(i.net_weight) || 0), 0);
                const avail = Math.max(0, mine - (drawnFrom.get(`${lot.id}|${k}`) || 0));
                const take = Math.round(Math.min(avail, room.get(lot.id) || 0, cap) * 100) / 100;
                if (take <= 0) continue;
                weight += take; cap -= take;
                room.set(lot.id, (room.get(lot.id) || 0) - take);
                itemDraws.push({ load_id: lot.id, weight: take });
                drawByLot.set(lot.id, (drawByLot.get(lot.id) || 0) + take);
            }
            if (weight > 0.001) lines.push({ description: (inbound.flatMap((l) => l.items || []).find((i) => keyOf(i.description) === k) || {}).description || name, weight: Math.round(weight * 100) / 100, draws: itemDraws });
        }
        if (!lines.length) {
            throw new Error(`there is no ${names.join(' or ')} on hand${cutoff ? ` from lots received before ${cutoff}` : ''} to sell`);
        }
        const missing = names.filter((n) => !lines.some((l) => keyOf(l.description) === keyOf(n)));
        const totalWeight = lines.reduce((a, l) => a + l.weight, 0);
        const amount = Math.round(totalWeight * price * 100) / 100;
        const details = [
            ['This sells', `EVERYTHING on hand of ${lines.map((l) => l.description).join(', ')} — ${Math.round(totalWeight).toLocaleString()} lb`],
            ['Buyer', buyer],
            ['Sale date', p.date],
            ...(cutoff ? [['From lots received', `before ${cutoff}`]] : []),
            ...lines.map((l) => [l.description, `${Math.round(l.weight).toLocaleString()} lb from ${l.draws.length} lot${l.draws.length === 1 ? '' : 's'}`]),
            ...(quotedText ? [['Quoted price', quotedText]] : []),
            ['Price', `${perLb(price)} per lb${quotedText ? ' (worked out from the quote)' : ''}`],
            ['Sale total', money(amount)],
        ];
        const warnings = [
            `This sells ALL ${Math.round(totalWeight).toLocaleString()} lb on hand${cutoff ? ` from lots received before ${cutoff}` : ''}. If you meant one load or container, cancel and give me its weights.`,
            quotedText ? 'Stored per lb, divided from the quoted price. On-hand drops by exactly these weights.' : 'Priced per lb. On-hand drops by exactly these weights.'];
        if (missing.length) warnings.push(`Nothing on hand for: ${missing.join(', ')} — left out.`);
        if (!outbound.some((o) => keyOf(o.buyer) === keyOf(buyer))) warnings.push(`${buyer} has no earlier sale in the yard records — check the spelling.`);
        return {
            summary: `Sell ALL on hand to ${buyer} on ${p.date}: ${lines.map((l) => `${l.description} ${Math.round(l.weight).toLocaleString()} lb`).join(', ')} at ${perLb(price)}/lb (${money(amount)}).`,
            details, warnings,
            run: async (c = {}) => {
                const { addOutboundLoad } = require('./outboundLoads');
                const fresh = stock.validateDraws(loadLoads(), loadOutboundLoads(), [...drawByLot].map(([load_id, weight]) => ({ load_id, weight })));
                if (!fresh.ok) throw new Error(`stock changed since this was shown — ${fresh.errors.join(' ')} Ask me again.`);
                return addOutboundLoad({
                    date: p.date, buyer, description: str(p.note),
                    items: lines.map((l) => ({ description: l.description, gross_weight: l.weight, tare_weight: 0, price, unit: '', draws: l.draws })),
                    weight_unit: 'lb',
                    created_by: c.role || ctx.role || 'yard-assistant',
                });
            },
        };
    },
};

// ── ONE SALE, WITH HER WEIGHTS (2026-11-21) ────────────────────────────────
// Apsara: "create a sale for 11/17/2026 Edge Yard Metalco, Inc. 261117_HMS_26Metalco29 NAM8794895 CMAU8789121 0345215
// HMS 81500 31060 … 50,440 for Metalco". The assistant had only record_outbound_sale, which sells ALL stock, and it
// recorded 111,069 lb. This is the tool that should have existed: ONE sale, the weights she gave, nothing inferred.
//
// Same write path as the attachment sales (addOutboundLoad, gross/tare/price per lb), so the Sales screen, stock and
// reports see it exactly as a hand-entered sale. The numbers are hers: gross and tare (net worked out), or net alone.
// If she gives all three and they disagree, the card says so rather than picking one quietly. A container already on
// a sale is refused — that is the duplicate a retyped paste would otherwise create.
TOOLS.record_sale = {
    kind: 'write',
    description: 'Record ONE sale (one load / one lot shipped) with the weights she gives: gross and tare, or net. Use this whenever a weight or a single load is mentioned — e.g. "create a sale … HMS 81500 31060 … 50,440 for Metalco". Pass her numbers exactly; never compute or invent a weight. ASK for the price and the date if not given.',
    params: {
        buyer: { type: 'string', required: true, describe: 'who bought it, as she wrote it' },
        date: { type: 'date', required: true, describe: 'the sale date as YYYY-MM-DD — ASK, do not assume today' },
        item: { type: 'string', required: true, describe: 'the material, e.g. "HMS"' },
        gross: { type: 'number', describe: 'gross weight in lb, exactly as given' },
        tare: { type: 'number', describe: 'tare weight in lb, exactly as given (the total tare if several are listed)' },
        net: { type: 'number', describe: 'net weight in lb, exactly as given' },
        price: { type: 'number', required: true, describe: 'price in the unit given by price_per — ASK, do not guess' },
        price_per: { type: 'string', describe: 'lb (default), metric_ton (MT), gross_ton or net_ton — pass it AS SHE SAID IT; never convert yourself' },
        container: { type: 'string' }, booking: { type: 'string' }, seal: { type: 'string' },
        reference: { type: 'string', describe: 'her own reference / invoice number, e.g. 261117_HMS_26Metalco29' },
        company: { type: 'string', describe: 'which of her companies SOLD it, if she said (e.g. "Edge Yard")' },
        note: { type: 'string' },
    },
    propose: async (p, ctx = {}) => {
        const { loadOutboundLoads } = require('./outboundLoads');
        const buyer = str(p.buyer), item = str(p.item);
        if (!buyer) throw new Error('who was it sold to?');
        if (!item) throw new Error('what material was sold?');
        if (!isYmd(p.date)) throw new Error('what date was the sale?');
        const quoted = num(p.price);
        if (quoted == null || quoted <= 0) throw new Error('what price? A sale needs one');
        const { perLb: lbPrice, label } = perLbFrom(quoted, p.price_per);
        const g = num(p.gross), t = num(p.tare), n = num(p.net);
        let gross, tare, net;
        const warnings = [];
        if (g != null && g > 0) {
            gross = g; tare = t != null && t >= 0 ? t : (n != null && n > 0 ? g - n : 0); net = gross - tare;
            if (n != null && n > 0 && Math.abs(n - net) > 1) warnings.push(`Gross ${Math.round(g).toLocaleString()} − tare ${Math.round(tare).toLocaleString()} = ${Math.round(net).toLocaleString()} lb, but you also gave a net of ${Math.round(n).toLocaleString()} lb. The card uses gross − tare; cancel if the net is the right figure.`);
        } else if (n != null && n > 0) {
            gross = n; tare = 0; net = n;
        } else {
            throw new Error('what weight? Give me the gross and tare, or the net, in lb');
        }
        if (!(net > 0)) throw new Error(`gross ${gross} minus tare ${tare} leaves no weight — check the numbers`);
        const container = str(p.container);
        const existing = loadOutboundLoads();
        if (container) {
            const k = container.toUpperCase().replace(/\s+/g, '');
            const dup = existing.find((o) => String(o.description || '').toUpperCase().replace(/\s+/g, '').includes(k));
            if (dup) throw new Error(`container ${container} is already on sale ${dup.id} — I won't record it twice`);
        }
        const refs = [container && `Container ${container}`, str(p.booking) && `Booking ${str(p.booking)}`,
            str(p.seal) && `Seal ${str(p.seal)}`, str(p.reference) && `Ref ${str(p.reference)}`].filter(Boolean);
        const amount = Math.round(net * lbPrice * 100) / 100;
        const fmt = (v) => Math.round(v).toLocaleString('en-US');
        try {
            const guard = require('./stockGuard');
            const short = guard.shortfalls([{ description: item, gross_weight: gross, tare_weight: tare, net_weight: net }]);
            if (short.length) warnings.push(guard.explain(short, 'lb'));
        } catch (e) { /* the stock check is advice; it never blocks the card */ }
        if (!existing.some((o) => String(o.buyer || '').toLowerCase().trim() === buyer.toLowerCase())) warnings.push(`${buyer} has no earlier sale in the yard records — check the spelling.`);
        const details = [
            ['Buyer', buyer], ['Sale date', p.date],
            ['Material', item],
            ['Weight', tare ? `${fmt(gross)} − ${fmt(tare)} = ${fmt(net)} lb net` : `${fmt(net)} lb net`],
            ['Price', label === 'lb' ? `${perLb(lbPrice)} per lb` : `${money(quoted)} per ${label} = ${perLb(lbPrice)} per lb`],
            ...(refs.length ? [['References', refs.join(' · ')]] : []),
            ...(str(p.company) ? [['Sold by', str(p.company)]] : []),
            ['Sale total', money(amount)],
        ];
        return {
            summary: `Record a sale to ${buyer} on ${p.date}: ${item} ${fmt(net)} lb net at ${perLb(lbPrice)}/lb (${money(amount)}).`,
            details, warnings,
            run: async (c = {}) => {
                const { addOutboundLoad, loadOutboundLoads: fresh } = require('./outboundLoads');
                if (container) {
                    const k = container.toUpperCase().replace(/\s+/g, '');
                    const dup = fresh().find((o) => String(o.description || '').toUpperCase().replace(/\s+/g, '').includes(k));
                    if (dup) throw new Error(`container ${container} was recorded on ${dup.id} meanwhile — nothing written`);
                }
                return addOutboundLoad({
                    date: p.date, buyer,
                    ...(str(p.company) ? { seller_company: str(p.company) } : {}),
                    description: [refs.join(' · '), str(p.note)].filter(Boolean).join(' — '),
                    items: [{ description: item, gross_weight: gross, tare_weight: tare, price: lbPrice, unit: '' }],
                    weight_unit: 'lb',
                    created_by: c.role || ctx.role || 'yard-assistant',
                });
            },
        };
    },
};

// ── FROM AN ATTACHED FILE: read it, record sales from it, record purchases from it (2026-11-20) ─────────────
// Apsara pasted 18 Metalco containers into Scout and was told, three times, that the text was cut off and that
// Scout could only sell ALL the stock of an item. Then: "Add an option for attachments in scout" — to record sales,
// record purchases, and just read and answer (helpers/scoutAttachments.js holds the file).
//
// THE MODEL NAMES COLUMNS; THE CODE READS THE NUMBERS. The proposal is built from the stored table, cell by cell,
// so a weight on the card is the weight in the file. The model's only job is to say which column is the date,
// which the gross, which the tare — and to ask for the price and the customer when they were not given.
//
// One record per ROW (one container = one sale, one ticket = one load), because that is how her paperwork is
// numbered and how a later question about one container has to be answered.
//
// SAFETY, the same as every other write here: propose → a card listing every row → confirm. On top of that:
//   * a row whose container number is already on a sale is skipped (and said so), so attaching the same sheet
//     twice cannot double her sales; a row repeated inside the file is skipped too;
//   * every sale row carries a one-time ticket, so a retried confirm cannot write it twice;
//   * a shortfall in stock is shown on the card (the stock guard's warning — the screen's rule since 2026-09-16);
//   * a table read from a PDF or photo is marked as read by the model.
// Nothing here is reachable without an attachment, so the voice path and every older caller are unchanged.
const PRICE_UNITS = { lb: 1, lbs: 1, pound: 1, metric_ton: 2204.62, mt: 2204.62, tonne: 2204.62, gross_ton: 2240, long_ton: 2240, net_ton: 2000, short_ton: 2000 };
function perLbFrom(quoted, per) {
    const unitKey = String(per || 'lb').toLowerCase().replace(/[\s/-]+/g, '_').replace(/^per_/, '');
    if (!(unitKey in PRICE_UNITS)) throw new Error(`I don't know the price unit "${per}" - is it per lb, per metric ton (MT), per gross ton or per net ton?`);
    if (PRICE_UNITS[unitKey] === 1 && quoted > 5) throw new Error(`$${quoted} per lb is far too high for scrap - is that per metric ton (MT), per gross ton or per net ton?`);
    const label = PRICE_UNITS[unitKey] === 1 ? 'lb' : ({ metric_ton: 'metric ton', mt: 'metric ton', tonne: 'metric ton', gross_ton: 'gross ton', long_ton: 'gross ton', net_ton: 'net ton', short_ton: 'net ton' })[unitKey];
    return { perLb: quoted / PRICE_UNITS[unitKey], label };
}
function attachmentOrThrow(id) {
    const A = require('./scoutAttachments');
    const a = A.get(id);
    if (!a) throw new Error('that attachment has expired or was never sent here — attach the file again');
    if (!a.table || !a.table.rows.length) throw new Error(`"${a ? a.name : 'the file'}" has no table I could read rows from`);
    return a;
}
function colOrThrow(a, ref, what, required) {
    if (ref == null || ref === '') { if (required) throw new Error(`which column is the ${what}?`); return -1; }
    const i = require('./scoutAttachments').columnIndex(a, ref);
    if (i < 0) throw new Error(`there is no column "${ref}" in ${a.name} — the columns are: ${a.table.columns.join(', ')}`);
    return i;
}
function colsOrThrow(a, refs, what) {
    const list = (Array.isArray(refs) ? refs : (refs == null || refs === '' ? [] : [refs]));
    return list.map((r) => colOrThrow(a, r, what, true));
}
function pickRows(a, rows) {
    const all = a.table.rows.map((r, i) => ({ n: i + 1, cells: r }));
    if (!Array.isArray(rows) || !rows.length) return all;
    const want = new Set(rows.map(Number).filter((n) => Number.isInteger(n) && n >= 1));
    return all.filter((r) => want.has(r.n));
}
const MAX_ROWS_PER_CARD = 150;

// Weights for one row, from the columns named. Tare can be several columns (container + chassis), summed.
function weightsOf(cells, gi, tis, ni) {
    const A = require('./scoutAttachments');
    const gross = gi >= 0 ? A.toNumber(cells[gi]) : null;
    const tares = tis.map((i) => A.toNumber(cells[i])).filter((v) => v != null);
    const tare = tis.length ? (tares.length ? tares.reduce((s, v) => s + v, 0) : null) : null;
    const netCell = ni >= 0 ? A.toNumber(cells[ni]) : null;
    if (gross != null && tare != null) return { gross, tare, net: Math.round((gross - tare) * 100) / 100, netCell };
    if (gross != null && tis.length === 0 && netCell != null) return { gross, tare: Math.round((gross - netCell) * 100) / 100, net: netCell, netCell };
    if (netCell != null) return { gross: netCell, tare: 0, net: netCell, netCell };
    if (gross != null && !tis.length) return { gross, tare: 0, net: gross, netCell };
    return null;
}

TOOLS.read_attachment_rows = {
    kind: 'read',
    needsAttachment: true,
    description: 'Read rows of a file the person attached (for questions about it, or rows past the first ones shown).',
    params: {
        attachment_id: { type: 'string', required: true, describe: 'the attachment_id shown with the ATTACHED FILE' },
        from: { type: 'number', describe: 'first row number (1 = first data row)' },
        to: { type: 'number', describe: 'last row number' },
    },
    run: async (p) => {
        const A = require('./scoutAttachments');
        const a = A.get(p.attachment_id);
        if (!a) return { error: 'that attachment has expired — ask them to attach it again' };
        if (!a.table) return { name: a.name, text: a.text.slice(0, 8000) };
        const from = Math.max(1, num(p.from) || 1), to = Math.min(a.table.rows.length, num(p.to) || from + 99);
        return { name: a.name, columns: a.table.columns, read_by: a.table.read_by, rows: a.table.rows.slice(from - 1, to).map((r, i) => ({ row: from + i, cells: r })) };
    },
};

TOOLS.record_sales_from_attachment = {
    kind: 'write',
    needsAttachment: true,
    description: 'Record SALES from an attached file: one sale per row (one per shipped lot), weights read from the file. Name the columns; never type weights yourself.',
    params: {
        attachment_id: { type: 'string', required: true, describe: 'the attachment_id shown with the ATTACHED FILE' },
        buyer: { type: 'string', describe: 'who bought it — ASK if not given (or use buyer_column)' },
        buyer_column: { type: 'string', describe: 'column holding the buyer, if it varies by row' },
        price: { type: 'number', describe: 'price, in the unit given by price_per — ASK, do not guess (or use price_column)' },
        price_per: { type: 'string', describe: 'lb (default), metric_ton (MT), gross_ton or net_ton — pass it AS SHE SAID IT; never convert yourself' },
        price_column: { type: 'string', describe: 'column holding a per-row price (same unit as price_per)' },
        item: { type: 'string', describe: 'the material, e.g. "HMS" (or use item_column)' },
        item_column: { type: 'string' },
        date_column: { type: 'string', describe: 'column holding each row\'s date' },
        date: { type: 'date', describe: 'one date for every row, only when the file has no date column' },
        gross_column: { type: 'string' },
        tare_columns: { type: 'array', describe: 'tare column(s); several are added together. Use the TOTAL tare column if the file has one' },
        net_column: { type: 'string' },
        container_column: { type: 'string' }, booking_column: { type: 'string' }, seal_column: { type: 'string' },
        reference_column: { type: 'string', describe: 'her own reference / lot number column' },
        company_column: { type: 'string', describe: 'column naming which of her companies SOLD it (e.g. "Edge Yard")' },
        rows: { type: 'array', describe: 'only these row numbers; omit for every row' },
        note: { type: 'string' },
    },
    propose: async (p, ctx = {}) => {
        const A = require('./scoutAttachments');
        const { loadOutboundLoads } = require('./outboundLoads');
        const a = attachmentOrThrow(p.attachment_id);
        const ci = {
            buyer: colOrThrow(a, p.buyer_column, 'buyer'), item: colOrThrow(a, p.item_column, 'material'),
            price: colOrThrow(a, p.price_column, 'price'), date: colOrThrow(a, p.date_column, 'date'),
            gross: colOrThrow(a, p.gross_column, 'gross weight'), tares: colsOrThrow(a, p.tare_columns, 'tare'),
            net: colOrThrow(a, p.net_column, 'net weight'), container: colOrThrow(a, p.container_column, 'container number'),
            booking: colOrThrow(a, p.booking_column, 'booking number'), seal: colOrThrow(a, p.seal_column, 'seal number'),
            ref: colOrThrow(a, p.reference_column, 'reference'), company: colOrThrow(a, p.company_column, 'selling company'),
        };
        if (ci.gross < 0 && ci.net < 0) throw new Error('which column is the gross weight (or the net weight)?');
        if (ci.date < 0 && !isYmd(p.date)) throw new Error('what date were these sold? There is no date column named');
        if (!str(p.buyer) && ci.buyer < 0) throw new Error('who was it sold to?');
        if (!str(p.item) && ci.item < 0) throw new Error('what material is it?');
        if ((num(p.price) == null || num(p.price) <= 0) && ci.price < 0) throw new Error('what price? A sale needs one');
        const picked = pickRows(a, p.rows);
        if (picked.length > MAX_ROWS_PER_CARD) throw new Error(`that is ${picked.length} rows — I record at most ${MAX_ROWS_PER_CARD} at a time; give me a row range`);

        const existing = loadOutboundLoads();
        const onFile = (container) => {
            if (!container) return null;
            const k = container.toUpperCase().replace(/\s+/g, '');
            return existing.find((o) => String(o.description || '').toUpperCase().replace(/\s+/g, '').includes(k)) || null;
        };
        const seenInFile = new Set();
        const lines = [], skipped = [];
        for (const r of picked) {
            const c = r.cells;
            const date = ci.date >= 0 ? A.toYmd(c[ci.date]) : p.date;
            const w = weightsOf(c, ci.gross, ci.tares, ci.net);
            const container = ci.container >= 0 ? str(c[ci.container]) : '';
            const buyer = str(p.buyer) || (ci.buyer >= 0 ? str(c[ci.buyer]) : '');
            const item = str(p.item) || (ci.item >= 0 ? str(c[ci.item]) : '');
            const rowPrice = ci.price >= 0 ? A.toNumber(c[ci.price]) : num(p.price);
            if (!date) { skipped.push(`row ${r.n}: no readable date`); continue; }
            if (!w || !(w.net > 0)) { skipped.push(`row ${r.n}: no usable weight`); continue; }
            if (!buyer) { skipped.push(`row ${r.n}: no buyer`); continue; }
            if (!item) { skipped.push(`row ${r.n}: no material`); continue; }
            if (rowPrice == null || rowPrice <= 0) { skipped.push(`row ${r.n}: no price`); continue; }
            const dup = onFile(container);
            if (dup) { skipped.push(`row ${r.n}: container ${container} is already on sale ${dup.id}`); continue; }
            if (container) { const k = container.toUpperCase(); if (seenInFile.has(k)) { skipped.push(`row ${r.n}: container ${container} appears twice in the file`); continue; } seenInFile.add(k); }
            const { perLb, label } = perLbFrom(rowPrice, p.price_per);
            const refs = [
                container && `Container ${container}`,
                ci.booking >= 0 && str(c[ci.booking]) && `Booking ${str(c[ci.booking])}`,
                ci.seal >= 0 && str(c[ci.seal]) && `Seal ${str(c[ci.seal])}`,
                ci.ref >= 0 && str(c[ci.ref]) && `Ref ${str(c[ci.ref])}`,
            ].filter(Boolean);
            const mismatch = w.netCell != null && ci.gross >= 0 && ci.tares.length && Math.abs(w.netCell - w.net) > 1;
            lines.push({
                n: r.n, date, buyer, item, container, refs, company: ci.company >= 0 ? str(c[ci.company]) : null,
                gross: w.gross, tare: w.tare, net: w.net, perLb, quoted: rowPrice, label,
                amount: Math.round(w.net * perLb * 100) / 100, mismatch, netCell: w.netCell,
            });
        }
        if (!lines.length) throw new Error(`nothing to record from ${a.name}: ${skipped.slice(0, 6).join('; ')}`);

        const totalNet = lines.reduce((s, l) => s + l.net, 0);
        const totalAmt = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
        const fmt = (v) => Math.round(v).toLocaleString('en-US');
        const buyers = [...new Set(lines.map((l) => l.buyer))];
        const details = [
            ['From file', `${a.name}${a.table.read_by === 'model' ? ' (read from a PDF/photo — check the weights)' : ''}`],
            ['Buyer', buyers.join(', ')],
            ['Price', lines[0].label === 'lb' ? `${perLb(lines[0].perLb)} per lb` : `${money(lines[0].quoted)} per ${lines[0].label} = ${perLb(lines[0].perLb)} per lb`],
            ...lines.map((l) => [`Row ${l.n} · ${l.date}`, `${l.item}${l.container ? ' · ' + l.container : ''} · ${fmt(l.gross)} − ${fmt(l.tare)} = ${fmt(l.net)} lb · ${money(l.amount)}`]),
            ['Total', `${lines.length} sale${lines.length === 1 ? '' : 's'} · ${fmt(totalNet)} lb · ${money(totalAmt)}`],
        ];
        const warnings = [];
        if (a.table.read_by === 'model') warnings.push('These numbers were read from a PDF or photo by the AI. Check each weight against the paper before confirming.');
        if (skipped.length) warnings.push(`Left out: ${skipped.join('; ')}.`);
        const mism = lines.filter((l) => l.mismatch);
        if (mism.length) warnings.push(`Gross minus tare does not match the file's net on row ${mism.map((l) => l.n).join(', ')} — the card uses gross minus tare.`);
        try {
            const guard = require('./stockGuard');
            const short = guard.shortfalls(lines.map((l) => ({ description: l.item, gross_weight: l.gross, tare_weight: l.tare, net_weight: l.net })));
            if (short.length) warnings.push(guard.explain(short, 'lb'));
        } catch (e) { /* the stock check is advice; it never blocks the card */ }
        buyers.forEach((b) => { if (!existing.some((o) => String(o.buyer || '').toLowerCase().trim() === b.toLowerCase())) warnings.push(`${b} has no earlier sale in the yard records — check the spelling.`); });

        return {
            summary: `Record ${lines.length} sale${lines.length === 1 ? '' : 's'} to ${buyers.join(', ')} from ${a.name}: ${fmt(totalNet)} lb, ${money(totalAmt)}.`,
            details, warnings,
            run: async (c2 = {}) => {
                const { addOutboundLoad, loadOutboundLoads: fresh } = require('./outboundLoads');
                const now = fresh();
                const created = [], skippedNow = [];
                for (const l of lines) {
                    if (l.container) {
                        const k = l.container.toUpperCase().replace(/\s+/g, '');
                        const dup = now.find((o) => String(o.description || '').toUpperCase().replace(/\s+/g, '').includes(k));
                        if (dup) { skippedNow.push(`${l.container} (already on ${dup.id})`); continue; }
                    }
                    const rec = await addOutboundLoad({
                        date: l.date, buyer: l.buyer,
                        ...(l.company ? { seller_company: l.company } : {}),
                        description: [l.refs.join(' · '), str(p.note)].filter(Boolean).join(' — '),
                        items: [{ description: l.item, gross_weight: l.gross, tare_weight: l.tare, price: l.perLb, unit: '' }],
                        weight_unit: 'lb',
                        created_by: c2.role || ctx.role || 'yard-assistant',
                        client_request_id: `att:${a.id}:${l.n}`,
                    });
                    created.push(rec.id);
                }
                return { created, skipped: skippedNow };
            },
        };
    },
};

TOOLS.record_purchases_from_attachment = {
    kind: 'write',
    needsAttachment: true,
    description: 'Record PURCHASES (incoming loads) from an attached file: one load per row, weights read from the file. Name the columns; never type weights yourself.',
    params: {
        attachment_id: { type: 'string', required: true, describe: 'the attachment_id shown with the ATTACHED FILE' },
        seller: { type: 'string', describe: 'who the yard bought from — ASK if not given (or use seller_column)' },
        seller_column: { type: 'string' },
        price: { type: 'number', describe: 'price in the unit given by price_per — ASK, do not guess (or use price_column)' },
        price_per: { type: 'string', describe: 'lb (default), metric_ton (MT), gross_ton or net_ton — AS SHE SAID IT' },
        price_column: { type: 'string' },
        item: { type: 'string' }, item_column: { type: 'string' },
        date_column: { type: 'string' }, date: { type: 'date', describe: 'one date for every row, only when there is no date column' },
        gross_column: { type: 'string' }, tare_columns: { type: 'array' }, net_column: { type: 'string' },
        company_column: { type: 'string', describe: 'column naming which of her companies BOUGHT it' },
        rows: { type: 'array', describe: 'only these row numbers; omit for every row' },
    },
    propose: async (p, ctx = {}) => {
        const A = require('./scoutAttachments');
        const { loadLoads } = require('./loads');
        const a = attachmentOrThrow(p.attachment_id);
        const ci = {
            seller: colOrThrow(a, p.seller_column, 'seller'), item: colOrThrow(a, p.item_column, 'material'),
            price: colOrThrow(a, p.price_column, 'price'), date: colOrThrow(a, p.date_column, 'date'),
            gross: colOrThrow(a, p.gross_column, 'gross weight'), tares: colsOrThrow(a, p.tare_columns, 'tare'),
            net: colOrThrow(a, p.net_column, 'net weight'), company: colOrThrow(a, p.company_column, 'buying company'),
        };
        if (ci.gross < 0 && ci.net < 0) throw new Error('which column is the gross weight (or the net weight)?');
        if (ci.date < 0 && !isYmd(p.date)) throw new Error('what date did these come in? There is no date column named');
        if (!str(p.seller) && ci.seller < 0) throw new Error('who did the yard buy these from?');
        if (!str(p.item) && ci.item < 0) throw new Error('what material is it?');
        if ((num(p.price) == null || num(p.price) <= 0) && ci.price < 0) throw new Error('what price? A load needs one');
        const picked = pickRows(a, p.rows);
        if (picked.length > MAX_ROWS_PER_CARD) throw new Error(`that is ${picked.length} rows — I record at most ${MAX_ROWS_PER_CARD} at a time; give me a row range`);

        const existing = loadLoads();
        const sameLoad = (seller, date, gross, tare) => existing.find((l) => String(l.seller || '').toLowerCase().trim() === seller.toLowerCase()
            && l.date === date && (l.items || []).some((it) => Number(it.gross_weight) === gross && Number(it.tare_weight) === tare)) || null;
        const lines = [], skipped = [];
        for (const r of picked) {
            const c = r.cells;
            const date = ci.date >= 0 ? A.toYmd(c[ci.date]) : p.date;
            const w = weightsOf(c, ci.gross, ci.tares, ci.net);
            const seller = str(p.seller) || (ci.seller >= 0 ? str(c[ci.seller]) : '');
            const item = str(p.item) || (ci.item >= 0 ? str(c[ci.item]) : '');
            const rowPrice = ci.price >= 0 ? A.toNumber(c[ci.price]) : num(p.price);
            if (!date) { skipped.push(`row ${r.n}: no readable date`); continue; }
            if (!w || !(w.net > 0)) { skipped.push(`row ${r.n}: no usable weight`); continue; }
            if (!seller) { skipped.push(`row ${r.n}: no seller`); continue; }
            if (!item) { skipped.push(`row ${r.n}: no material`); continue; }
            if (rowPrice == null || rowPrice <= 0) { skipped.push(`row ${r.n}: no price`); continue; }
            const dup = sameLoad(seller, date, w.gross, w.tare);
            if (dup) { skipped.push(`row ${r.n}: looks already entered as ${dup.id} (same seller, date and weights)`); continue; }
            const { perLb, label } = perLbFrom(rowPrice, p.price_per);
            lines.push({ n: r.n, date, seller, item, gross: w.gross, tare: w.tare, net: w.net, perLb, quoted: rowPrice, label, company: ci.company >= 0 ? str(c[ci.company]) : null, amount: Math.round(w.net * perLb * 100) / 100 });
        }
        if (!lines.length) throw new Error(`nothing to record from ${a.name}: ${skipped.slice(0, 6).join('; ')}`);
        const fmt = (v) => Math.round(v).toLocaleString('en-US');
        const totalNet = lines.reduce((s, l) => s + l.net, 0);
        const totalAmt = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
        const sellers = [...new Set(lines.map((l) => l.seller))];
        const details = [
            ['From file', `${a.name}${a.table.read_by === 'model' ? ' (read from a PDF/photo — check the weights)' : ''}`],
            ['Seller', sellers.join(', ')],
            ['Price', lines[0].label === 'lb' ? `${perLb(lines[0].perLb)} per lb` : `${money(lines[0].quoted)} per ${lines[0].label} = ${perLb(lines[0].perLb)} per lb`],
            ...lines.map((l) => [`Row ${l.n} · ${l.date}`, `${l.item} · ${fmt(l.gross)} − ${fmt(l.tare)} = ${fmt(l.net)} lb · ${money(l.amount)}`]),
            ['Total', `${lines.length} load${lines.length === 1 ? '' : 's'} · ${fmt(totalNet)} lb · ${money(totalAmt)}`],
        ];
        const warnings = [];
        if (a.table.read_by === 'model') warnings.push('These numbers were read from a PDF or photo by the AI. Check each weight against the paper before confirming.');
        if (skipped.length) warnings.push(`Left out: ${skipped.join('; ')}.`);
        sellers.forEach((s) => { if (!existing.some((l) => String(l.seller || '').toLowerCase().trim() === s.toLowerCase())) warnings.push(`${s} has no earlier load in the yard records — check the spelling.`); });
        return {
            summary: `Record ${lines.length} load${lines.length === 1 ? '' : 's'} from ${sellers.join(', ')} out of ${a.name}: ${fmt(totalNet)} lb, ${money(totalAmt)}.`,
            details, warnings,
            run: async (c2 = {}) => {
                const { addLoad, loadLoads: freshLoads } = require('./loads');
                const now = freshLoads();
                const created = [], skippedNow = [];
                for (const l of lines) {
                    const dup = now.find((x) => String(x.seller || '').toLowerCase().trim() === l.seller.toLowerCase() && x.date === l.date
                        && (x.items || []).some((it) => Number(it.gross_weight) === l.gross && Number(it.tare_weight) === l.tare));
                    if (dup) { skippedNow.push(`row ${l.n} (already ${dup.id})`); continue; }
                    const rec = await addLoad({
                        date: l.date, seller: l.seller,
                        ...(l.company ? { buyer_company: l.company } : {}),
                        items: [{ description: l.item, gross_weight: l.gross, tare_weight: l.tare, price: l.perLb, unit: 'lb' }],
                        created_by: c2.role || ctx.role || 'yard-assistant',
                    });
                    created.push((rec && (rec.id || (rec.load && rec.load.id))) || null);
                }
                return { created, skipped: skippedNow };
            },
        };
    },
};

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
