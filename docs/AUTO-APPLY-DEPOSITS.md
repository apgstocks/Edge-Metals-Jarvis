# Automatic deposits (ownership plan slice 4)

Apsara, 2026-11-09: apply certain deposits automatically; a daily report of what was applied, against what and why; an Undo button; and when she undoes one, Jarvis finds out what was wrong.

**This reverses the old rule** in `helpers/bankAutoTick.js` ("deposits are never auto"). That job still ticks withdrawals only and is untouched.

## Off by default
Set `JARVIS_AUTO_APPLY=1` on the VM and `pm2 restart jarvis --update-env`. Before that, `await require('./helpers/depositAutoApply').run({ dryRun: true })` lists what it WOULD place and writes nothing.

## What is "certain"
Her own "Confirm all sure matches" bar (`dashboard/bank-match.html` `sureOf` + `bulkable`) **plus one invoice only**:
one clear proposal, 95%+, not ambiguous, pays ONE invoice in full to the cent, payer already matched to a customer (alias or exact name; the model's payer-guess is switched off), no claim hint, bank account known, the bank line says WIRE or ZELLE, Edge Metals' own account (rule 5, shared with the screen via `bankMatchRoutes.depositProposals`).
Everything else still reaches her screen as a question, unchanged.

### It reads the bank DESCRIPTION too, and when unsure it ASKS (Apsara, 2026-11-09)
An exact amount from a known payer is not enough. It reads the deposit's description, memo and bank text and does NOT place the deposit if any of these is true:
- it says refund, return, reversal, chargeback, advance, prepayment, down payment, partial / part payment, on account, balance of, deduction, claim, loan, interest, own account, intercompany, duplicate, NSF (whole words only: "advanced" does not trigger);
- it names an invoice, container or booking number that belongs to a DIFFERENT invoice from the one it would pay;
- it also names a different customer.
If the line names the invoice it would pay, that is added to the reasons.

A deposit that has a real proposal but is not certain (any of the above, or: combined invoices, a short payment, confidence under 95%, a paused customer) becomes a QUESTION in the daily message, once per deposit, at most 8 a day (`JARVIS_AUTO_APPLY_MAX_ASKS`): the amount, the reason it was not placed, and my best guess when there is exactly one invoice. Answer on WhatsApp: `yes <CODE>` places the guess (after re-checking the invoice still owes exactly that amount and the deposit is still unhandled), `no <CODE>` leaves it for the Bank page. Both answers go to the learning log. Unknown payers, deposits older than 30 days and other companies' accounts are not turned into questions; they stay on the Bank page as before.

Limits I set (change by env var, tell me if you want them different): only deposits from the last 30 days (`JARVIS_AUTO_APPLY_MAX_AGE_DAYS`), at most 20 per run (`JARVIS_AUTO_APPLY_MAX_PER_RUN`), and a second deposit proposing an invoice the same run already paid is left for her.

## What placing does
Exactly what the screen's Confirm does: `salesReceipts.addReceipt` then `quickbooks/sync.after('receipt')`. The receipt has `ref` = the bank row id and `created_by: 'jarvis-auto'`. The reasons it gave are stored in `data/auto_applied.json` (backed up with the other stores) and in the audit log.

## Daily report (06:20 LA, only when something happened)
Each placement: amount, customer, invoice, **why**, and `undo <CODE>`. Plus anything learned from undos and who is paused.

## Undo
- Bank page, "Placed by Jarvis" card: reason picker + Undo. Needs the **Jarvis profile** (same lock as deleting a receipt, `requireSuper`).
- WhatsApp, manager only, exact words: `undo <CODE>`, `undo <CODE>: <what was wrong>`, `resume auto deposits for <name>`. This path does NOT need the Jarvis profile: it acts only on a receipt Jarvis itself placed (`undo()` refuses any receipt not created by `jarvis-auto` for that deposit), but it is a way to remove a receipt from WhatsApp that did not exist before.
- Undo: removes the receipt (audited, QuickBooks told), reopens the invoice, **pauses that customer and that payer**, never re-applies that deposit, and records a "corrected" outcome for the learning log.

## Learning from an undo
It does not guess. It watches what she does with that deposit next (`diagnose`, run before each daily pass):
different invoice, same customer = wrong invoice; different customer = wrong customer (payer name suspect); same invoice but another bank or mode = wrong bank/mode; deposit set aside = not our money; placed exactly the same = she may have slipped. A reason she types is kept as provisional and replaced when evidence appears. No evidence after 14 days = "unknown". The pause stays until she says `resume auto deposits for <name>`.
What it does with a diagnosis today: it keeps the customer paused and tells her in the daily report. It does **not** edit aliases or the matcher's scoring; that needs her yes.

## Tests
`tests/deposit-auto-apply.js` (real server, real routes), `tests/deposit-auto-whatsapp.js` (real `brain.process`), `tests/auto-applied-screen.js` (JSDOM). Mutation-checked.
