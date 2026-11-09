# Jarvis as an assistant who owns the job — analysis and plan

Written 2026-11-07 for Apsara. Nothing in this document has been built. First area: **getting paid**. Rule for anything outside the company (customer, supplier, carrier, bank): Jarvis prepares it and waits for her yes on WhatsApp.

## 1. What Jarvis is today

Jarvis is a very good **reporter and preparer**. It watches many things (39 scheduled jobs, 5,000-line reply watcher, bank feed, QuickBooks, sales, bookings), then tells her what it found. It rarely **owns** an outcome. The test of ownership is: *if she never looked, would the invoice still get paid?* Today the answer depends on whether she acted on a WhatsApp message.

Evidence from this week:

- **Rad Metal showed $4.78M open with zero receipts ever recorded.** Jarvis's own ledger holds invoices but not payments, so it could not tell "unpaid" from "paid, nobody told me". It was about to follow up on customers who always pay.
- **Payments reach Jarvis in four disconnected ways**, none of which finishes the job: an email payment is staged as a yes/no (`paymentWatcher`), money out is chased (`unrecordedPayments`), money in is matched only by hand, and QuickBooks drafts a reminder that never sends.
- **The state of one customer is spread over seven stores:** sales, receipts, the follow-up log, email threads, the task queue, the bank ledger, and QuickBooks. No single place says "Daekwang: asked 11/07, promised Friday, deposit seen 11/12, waiting for it to be applied".
- **Reports outnumber actions.** Many daily messages (first live follow-up run: a 52-line list) and few closed loops.

## 2. What a human assistant does that Jarvis does not

| A human assistant | Jarvis today |
|---|---|
| Keeps one file per open matter and knows its status | State scattered across stores; no "case" |
| Hears "I'll pay Friday" and writes it down | Customer replies are read for urgency; promises are not stored or used |
| Knows who always pays and who is slow | `typicalDaysToPay` is computed in QuickBooks code, used only in a report |
| Applies a payment when it is obviously right, asks when not | Deposits are never applied automatically (a deliberate earlier rule); everything waits for her |
| Goes quiet when nothing needs you | Reports daily whether or not you need to act |
| Remembers every instruction you gave | Rules live in code comments, facts.json and CLAUDE.md; no single list you can read |
| Notices when something she owns is stuck | Held items lapse silently after 7 or 30 days |

## 3. The critical finding: the truth source is about to change

QuickBooks is dropped for Edge Metals in January 2027, and Jarvis becomes the book of record. This week's fix makes follow-ups depend on QuickBooks. That is correct now and **wrong from January**. Jarvis's own ledger must hold payments first. Importing the payments QuickBooks already has (and matching the Plaid deposits) into Jarvis receipts is therefore on the critical path, ahead of any cleverness.

## 4. The design: a case file per customer

One record per customer matter, owned by Jarvis until closed:

`open → asked → promised (date) → possible payment found → paid → closed` (or `escalated to a person`)

Every event is stored with its source (email, bank deposit, QuickBooks, you) and the date. Today's follow-up log, remittance hold and hold-question become fields of this one record rather than three separate memories.

**Autonomy ladder** (applied per action, not per area):

- **L0 report** — tells her. Today's default.
- **L1 prepare** — drafts the email, the match, the note.
- **L2 act inside the company** — records a promise, applies a deposit that is certain, closes a case, schedules its own next step. Reversible, visible, undoable.
- **L3 ask first** — anything that reaches a customer, supplier, carrier or the bank. Her yes on WhatsApp. (Already built for customer payment emails.)
- **L4 act and tell** — routine items she has approved many times. Not enabled. She opts in per kind, later.

**Ownership means:** it keeps the case moving without being asked, tells her only what needs her ("one line per reason"), and says when it is stuck instead of going quiet.

## 5. Learned and remembered

Everything she says becomes a rule in one **Playbook**: a readable list, in Settings, with the date and her words, that Jarvis applies and she can edit or delete. Seed it with what she has already said this month, for example:

- LC customers get no payment follow-up at all.
- Customer emails: staged on WhatsApp, her yes, same thread as the invoice, professional tone.
- Payment truth is QuickBooks, Plaid and the books, not the sales ledger.
- Rad Metal, MK Trading and FMC Metals always pay.
- If unsure, ask.
- Short reports, one line per reason.

Jarvis also **learns from outcomes without being told**: how many days each customer takes to pay (timing of follow-ups), which suggestions she approves or rejects (confidence), which promises were kept. `helpers/outcomes.js` already records outcomes; nothing uses them for follow-up timing yet.

## 6. Build order (smallest safe slices, each one ships and is tested end to end)

1. **Truth backfill.** Import QuickBooks payments and applied receipts into Jarvis receipts; match unapplied Plaid deposits. Read-only first; she approves the list. *Why first: fixes the false balances, and January depends on it.*
2. **Case file store** and move the follow-up log, holds and questions into it. No change in what she sees except one status per customer.
3. **Promises.** An AI reads customer replies for "will pay on X" and sets the next check to that date, instead of chasing before it.
4. **Certain deposits applied automatically** (exact amount, one invoice, name matches), with undo and a daily one-line "applied N deposits". Anything less certain asks. *This reverses her earlier rule that deposits always need her. It needs her explicit yes.*
5. **Habit-based timing** from each customer's real days-to-pay.
6. **One owner's report** each week: cash in, who is late, what I did, what I need from you. Replaces most of the separate daily messages.
   - *Built, not wired:* `helpers/ownerReport.js` + `node scripts/owner-report.js [--days=N]` print the report (read-only, sends nothing). It is NOT on the scheduler and replaces no daily message yet; that needs her yes.
7. **Playbook screen** so every rule she has given is visible and editable.

Repeat the same model, one area at a time, for bookings and truckers, then supplier bills, then the inbox.

## 7. Risks and what needs her decision

- **Auto-applying deposits (slice 4)** can wrongly close an invoice. Safeguards: exact amount, single match, undo, daily summary; asks otherwise. Her call.
- **The weak point is data, not intelligence.** Wrong or missing receipts (Rad Metal) made the agent confidently wrong. Slice 1 comes before everything else for that reason.
- **Customer name clean-up** (A Tech / A-Tech, Modern / Modern Enterprises, Daiki x2, Dhatu x3, internal names such as Edge Metals Recycling) will make cases split. A one-time merge list is needed.
- **Nothing replaces her yes** for anything outside the company until she opts in per kind.
