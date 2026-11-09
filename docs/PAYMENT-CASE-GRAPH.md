# Payment follow-up as a LangGraph (agents/paymentCase)

Added 2026-11-09 at Apsara's request: use LangGraph to enhance Jarvis without rewriting brain.js.
**Not wired to anything.** Nothing calls it yet. `workflow/brain.js` and `helpers/followUpAgentJob.js` are untouched.

## What it adds
Jarvis can already decide a rung and tell her. What it cannot do is *wait for her answer across a restart*.
LangGraph's `interrupt()` parks one customer's follow-up, saved to disk, until she answers; the answer can come
minutes or days later, after any number of `pm2 restart`s.

    plan -> recall -> tell -> wait (parked on her) -> record

- `plan`   reuses `helpers/paymentChaser.nextAction` (the existing ladder; not re-implemented)
- `recall` read-only look at what she has taught the disk about this customer; shown to her, never decides
- `tell`   notifies HER (or the team on an escalation). The customer is never contacted: drafts-only is her
           2026-10-21 choice, and no customer address enters the graph
- `wait`   the interrupt. Separate from `tell` so a resume cannot message her twice
- `record` writes her answer to the Edge Metals disk log

## Files
- `agents/paymentCase/checkpointer.js`  LangGraph's MemorySaver + an append-only JSONL journal in the company's
  disk folder, replayed at start. Torn last line skipped and counted.
- `agents/paymentCase/graph.js`         the five nodes
- `agents/paymentCase/index.js`         `createRunner({ disk, company, notify })` -> `start / answer / waiting`
- `tests/payment-case-graph.js`         18 checks incl. restart-mid-wait and Edge Yard refusal

## Rules it keeps
- Edge Metals only. A runner for any other company throws. The ladder reads Edge Metals' sales.
- `notify` has no default, so nothing can be sent by accident.
- `start()` is idempotent per customer + invoices + rung: an hourly job may call it freely.
- Her answer is checked BEFORE the pause is used, so a typo does not lose the question.

## Answers, and how they are filed (MY labels, not hers, change them with her)
| answer | meaning                | log outcome |
|--------|------------------------|-------------|
| sent   | she sent the draft     | approved    |
| hold   | wait                   | rejected    |
| skip   | not now                | rejected    |
| paid   | customer has paid      | corrected   |

## Dependencies
`@langchain/langgraph` 1.7.2 and `@langchain/core` 1.3.5, exact pins. The umbrella `langchain` package is not
used by anything and is not installed. No model is called: the ladder is deterministic, and a model there would
add cost and risk for no gain. LangSmith (tracing, which sends data to an outside cloud) ships as a transitive
dependency of core and is off unless `LANGSMITH_TRACING` is set. Keep it unset.

## NOT built / known limits
- Not wired. Wiring it means choosing who calls `start()`, who calls `answer()` from WhatsApp, and turning off the
  duplicate tell in followUpAgentJob. When wired, add the HTTP-route section (tests/paid-via.js section F is the shape).
- It does not write `PAYMENT_CHASE_LOG_FILE`, so the existing ladder does not advance from graph answers.
- A crash after `notify` but before its checkpoint is saved would message her again on retry (at-least-once).
- No expiry: an unanswered question waits forever. Nothing yet logs `expired`.
- `checkpoints.jsonl` is not in the nightly backup (helpers/backup.js only collects `*.json`).
- `package-lock.json` was NOT regenerated: it is already out of sync with package.json (locks puppeteer 24.38 and
  nodemailer 6.10 while package.json asks for ^25.8 and ^10). Regenerating it would upgrade both. Fix that on its own.
