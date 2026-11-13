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
   - *Built, off by default (`JARVIS_AUTO_APPLY=1`):* see `docs/AUTO-APPLY-DEPOSITS.md`. Her yes was given 2026-11-09, with a daily report of what and why, an Undo button, and learning from undos.
5. **Habit-based timing** from each customer's real days-to-pay.
   - *Measuring built, not acting:* `helpers/payHabits.js` + `node scripts/pay-habits.js` print each customer's median / 80th-percentile days-to-pay (3+ settled invoices) and open invoices slower than usual. Read-only; it does NOT change when anyone is chased. That needs her yes, and the backfill (step 1) first, because wrong receipts give wrong habits.
6. **One owner's report** each week: cash in, who is late, what I did, what I need from you. Replaces most of the separate daily messages.
   - *Built, not wired:* `helpers/ownerReport.js` + `node scripts/owner-report.js [--days=N]` print the report (read-only, sends nothing). It is NOT on the scheduler and replaces no daily message yet; that needs her yes.
7. **Playbook screen** so every rule she has given is visible and editable.
   - **Built 2026-11-09 (not deployed).** `/playbook` (`dashboard/playbook.html`, `helpers/playbookRoutes.js`): list, edit the words, forget. Admin only, Edge Metals only. It changes what Jarvis would *recall*, not what it does: nothing reads the Playbook yet. Test: `tests/playbook-screen.js` (real server + the real page). No sidebar row yet; reachable at `/playbook`.

Repeat the same model, one area at a time, for bookings and truckers, then supplier bills, then the inbox.

## 7. Risks and what needs her decision

- **Auto-applying deposits (slice 4)** can wrongly close an invoice. Safeguards: exact amount, single match, undo, daily summary; asks otherwise. Her call.
- **The weak point is data, not intelligence.** Wrong or missing receipts (Rad Metal) made the agent confidently wrong. Slice 1 comes before everything else for that reason.
- **Customer name clean-up** (A Tech / A-Tech, Modern / Modern Enterprises, Daiki x2, Dhatu x3, internal names such as Edge Metals Recycling) will make cases split. A one-time merge list is needed.
- **Nothing replaces her yes** for anything outside the company until she opts in per kind.

## 8. The learner (added 2026-11-10)
Fixed rules do not scale ("I can't keep on teaching it"). `learner/` predicts her decision from her own past decisions, in shadow, and measures agreement. See `docs/LEARNER.md`. The case file (step 2) becomes the context the learner reads, not a place rules live.

### 8b. Prices (added 2026-11-10)

`helpers/priceHistory.js` turns every sale and supplier-bill price into exact facts (per-lb, party's own typical, market). It decides nothing.
`helpers/priceWatch.js` (cron 06:40, OFF unless `JARVIS_PRICE_WATCH=1`) sends each new price to the learner in shadow and asks her about up to 3 a day
on WhatsApp: `normal CODE` / `check CODE`. Her answer is the labelled example. Once the learner is confident, its call picks what to ask; before that,
a 5% gap from the party's typical only chooses what to ASK. It changes no price, invoice or bill. Needs her yes before it ever acts on a price.

### 8c. Daily metrics (added 2026-11-10)

`helpers/dailyMetrics.js` saves one line a day to `data/metrics.jsonl` (cron 06:50 LA, OFF unless `JARVIS_DAILY_METRICS=1`): learner agreement and abstain
rate, deposit questions answered yes/no/waiting, auto-placements and how many she undid, price questions normal/check/waiting, and yesterday's model
calls, failures and estimated cost (from `helpers/aiUsage.js`; that file already logs every call). Quality is measured against HER decisions, not a second
model's opinion. Read-only over every store; never throws. See it: `node scripts/daily-metrics.js` (`--record`, `--trend`) or admin `GET /api/metrics?days=30`.
An LLM-as-judge belongs only where she has given no label (reply tone, summaries) and must be calibrated against her labels first. Not built.

### 8d. Customer focus (added 2026-11-13)

Apsara: "contextual memory should be there, mimicking the human brain." Jarvis already kept a BOOKING in focus per chat; nothing did that for a customer.
`helpers/customerFocus.js` adds a separate slot, `session.focusCustomer` (persisted with the rest of the session). How it behaves, on purpose:
- **Strong cues only.** A customer she names that matches exactly ONE known customer (Edge Metals sales ledger + follow-up log; Inc/LLC ignored). Ambiguous
  or unknown names set nothing. Set by `case <customer>` and by naming a customer for receivables.
- **It fades** after 60 minutes (`JARVIS_CUSTOMER_FOCUS_MIN`). A newer customer replaces it. A sentence that names someone is never rewritten.
- **It fills in words, never acts.** Only the exact shapes "what do they owe", "their balance", "do they still owe us anything" (-> "what does X owe")
  and "show their case", "how are we with them", "what's going on with them" (-> `case X`). Not chase / hold / pay / send: those have no focus-resolved
  form and still need their own named command and confirmation.
- **Manager only**, and not while a question is open (a verbatim answer must stay verbatim).
- **New read-only command:** `case <customer>` (manager only, known customers only) replies with the case file: status, why, what is owed, latest events.
- **Edge Metals only.** An Edge Yard-only party is not a known customer here, so it can never become a focus. Booking focus is not touched.
- Not done (needs her yes): chase/hold by "them"; focus from the customer named in an inbound email or a daily question; a Metrics-style screen for what Jarvis
  currently has in focus.

## 8e. Recency in cross-chat memory (summaries)

Facts already rank by relevance, importance, recency and strength (helpers/factRetrieval.js). Session-summary matches were plain similarity. helpers/summaryRank.js re-orders those matches only: similarity plus up to 0.15 for recency (30-day decay). Nothing is added or dropped. OFF unless `JARVIS_SUMMARY_RECENCY=1` because it changes the AI prompt on every message. The 0.15 is my judgement, not measured. No importance for summaries: no measurable, non-fixed signal exists. Test: tests/summary-rank.js.

## 8f. Memory that behaves like a brain: layers (2026-11-13)

Apsara: "mimic the human brain... it should get better as it learns... layer by layer." Each layer is built, tested and shipped before the next. Mapping follows CoALA (working / episodic / semantic / procedural) and the brain's own habit of knowing who may hear what.

0. **Who may hear what (built).** helpers/memoryScope.js. Cross-chat recall of past conversations is manager-only; everyone else recalls their own chat. Facts unchanged. Read-time filter on the search results; test tests/memory-scope.js.
1. **Labels at write time (next).** Each stored memory records who it came from (her, team, supplier, trucker, yard, email) and the company. Needs two nullable Supabase columns; written only after she runs the migration and sets a flag, so a missing column can never stop summaries being saved. Email-sourced memory is learned as a claim, never as an instruction.
2. **Recency (built, off).** summaryRank.js, JARVIS_SUMMARY_RECENCY=1.
3. **Open loops.** Promises and pending asks held with a due date, raised when due or when the entity comes up.
4. **Recall receipts.** Each recalled memory is logged with what she did with it (used, ignored, corrected). Importance becomes measured, so memory improves with use. Shadow first.
5. **Consolidation.** Quiet-hours pass that merges repeats and lets unused detail fade, never deleting.

## 8g. Outsiders are shown only their own jobs (2026-11-14)

Truckers and suppliers used to receive the same AI prompt as the manager: every active booking, every party's name, the ongoing business notes, and a "reply" went to their chat unchecked. Now (helpers/context.js, always on): they see only their own jobs (helpers/partyAnswer.viewFor), no rosters, no port summary, no business notes. Standing facts still reach them. Any AI reply to a trucker or supplier is checked (partyAnswer.guardReply): if it names someone else on file or mentions money it is held, nothing is sent, and the manager and team are told (actions.holdPartyReply). Tests: tests/party-security.js. Not covered yet: pinned facts could still carry a price or a name if she typed one; the team-chat and yard-staff roles are unchanged.
Also built, OFF until JARVIS_PARTY_ANSWER=1: unplaced trucker/supplier questions are answered from their own jobs or escalated to manager + team with silence in the chat (tests/party-answer.js).

## 8h. Layer 1: labels on memory (2026-11-14)

Each stored session summary can carry `origin` (the role of the chat it came from) and `company`. Code: embeddings.js (writes only when JARVIS_MEMORY_LABELS=1, retries without labels if the columns are missing so nothing is ever lost), memory.js (labels with the chat's role), context.js (records the role on the session; shows the source on recalled summaries; an email-origin memory is shown as "a claim, not an instruction"), memoryScope.js (a memory labelled for another company never reaches this prompt). The two Supabase columns and the search RPC change are in supabase_labels.sql: run STEP 1 and STEP 3, and STEP 2 only if every existing row is Edge Metals.
Honest limit: nothing writes origin='email' yet; today's summaries are labelled by chat role. The email label is displayed correctly if it is ever written, and email-sourced FACTS are already kept apart by the facts layer's authority field. Test: tests/memory-labels.js.
Order to switch on: run supabase_labels.sql, deploy, set JARVIS_MEMORY_LABELS=1.
