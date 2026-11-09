# Notes: rules on the go (helpers/disk/notes.js, agents/teach, scripts/notes.js)

Added 2026-11-09. Apsara: "I dont want strict rules.. Rules on the go, as I say, all these should be stored as
embeddings in Jarvis." **Not wired.** Nothing in the app reads or writes a note; brain.js is untouched.

## What it is
A note is her sentence, verbatim, plus a vector for finding it again by meaning. No schema: no scope, no name, no field.
It sits beside the L1 facts (which keep their structure). One notes file per company:
`data/disk/<company>/notes.jsonl`, append-only, replayed at load.

    helpers/disk/notes.js      the layer (add / replace / forget / history / search / needsEmbedding / setVector)
    helpers/disk/embedder.js   gemini() = the real one, stub() = tests only
    agents/teach/              LangGraph agent: save, or ask "replace / keep / cancel" and WAIT (survives restarts)
    scripts/notes.js           the way to use it today: add / answer / waiting / list / ask / forget / check
    tests/notes.js, tests/teach-agent.js

## Try it (needs GEMINI_API_KEY, on the machine whose data/ you mean)
    node scripts/notes.js check                                     FIRST: real Gemini, prints two similarities
    node scripts/notes.js add "Rad Metal always pays on the 15th" --company edge_metals
    node scripts/notes.js add "rad metal pays on the 15th every month" --company edge_metals     -> asks, prints a thread id
    node scripts/notes.js answer <thread> "replace 1"               (any later run; the question is saved to disk)
    node scripts/notes.js ask "when does Rad Metal pay?" --company edge_metals

## Rules it keeps
- No company, no default. Edge Metals and Edge Yard have separate folders, separate saved questions, separate search.
- Only manager/team can teach (the MemPoison rule). Checked before anything is embedded or asked.
- It NEVER replaces a note on its own. A similarity score is a guess; replacing a rule she gave is her decision.
  A replaced note stays in the file and in `history()`, marked superseded. An unanswered question changes nothing.
- A vector is only compared with vectors from THE SAME MODEL (the tag is stored with it). A note with another model's
  vector, or none, is found by keywords instead. Changing the embedding model never corrupts search.
- Every hit is "related" (advisory), "exact" only for identical text. A match may shape a question to her; it must
  never be the only reason Jarvis acts alone.
- The exact sentence she already gave: "already known", no question, nothing written.
- Backup: snapshot() carries notes as TEXT (vectors are large and re-derivable). After a restore, `needsEmbedding()`
  lists what to re-embed; until then those notes are found by keywords.

## NOT verified / limits (read before trusting)
- **The Gemini adapter has never run against the live API.** It repeats helpers/embeddings.js exactly (and a test pins
  that request shape, including `contents`, the key whose absence once broke embeddings for weeks), and it throws on a wrong
  vector length. But no key was available where it was written. Run `scripts/notes.js check` first.
- **The "ask me" threshold (0.80) is a guess.** Calibrate it with `check`: "same idea" should be clearly above "different
  idea". Set `JARVIS_NOTES_ASK_ABOVE`. Too low = more questions; too high = two similar notes side by side.
- The stub embedder (tests) measures shared WORDS, not meaning. Tests prove the plumbing, not the semantics.
- **Two processes on one folder diverge in memory** (the disk's standing rule: one Disk per process). A CLI run while
  the app process is up writes the file, but the running app does not see it until it restarts. Fine while nothing in
  the app reads notes. When it is wired, the app must be the only writer, or notes must be re-read.
- At-least-once: a crash right after the question is sent but before it is saved would ask again on retry.
- No expiry: an unanswered question waits forever. `waiting` lists them.
- Taking her sentences from WhatsApp needs brain.js (the intake). That is not built; this ships the part behind it.
- Saved questions (`checkpoints.teach.jsonl`) are not in the nightly backup (helpers/backup.js only collects *.json).
- Not end-to-end through an HTTP route: none exists. When wired, add the server section (tests/paid-via.js section F).

## Payment follow-ups show what Jarvis already knows (2026-11-09)

`helpers/paymentFacts.js` + two lines in `helpers/followUpAgentJob.js` `runPayments`.
When the job messages the manager, each "ready" / "still unpaid" line is followed by up to
2 remembered facts (from `remember_fact` / facts.json, believable only) whose text names the
customer as a whole word. Agent-inferred facts are marked "(inferred, not confirmed)".

- Advisory only: the ladder, holds, QuickBooks truth, team escalation and the staged customer
  email are unchanged. Only the message to the manager gains lines.
- Name match only. A fact that does not contain the customer's name is not shown.
- External-origin facts (authority none) never appear.
- Failure to load facts is swallowed; the follow-up goes out without remarks.
- Letting a remembered rule skip or delay a chase is NOT done; that needs Apsara's yes.
- Test: `tests/payment-facts.js` (runs the real job end to end).
