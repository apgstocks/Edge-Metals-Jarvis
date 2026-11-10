# The learner (shadow mode)

Apsara, 2026-11-10: "I can't keep on teaching it based on fixed rules. If I do, why do I need AI."

A small Python service (`learner/`, DSPy) that predicts **what Apsara would decide**, from her own past decisions, instead of from rules
someone wrote. **It only watches.** Nothing it says is acted on. It logs a prediction, and when the real decision arrives it logs that next
to it, so `GET /report` can say how often they agreed. Acting on a prediction is a later step, per kind of decision, and needs her yes.

## What is wired (all off until you set the env vars)
- `helpers/depositAutoApply.js`: for each deposit it places or asks about, it asks the learner for a prediction (not awaited, fail-silent).
  Her **yes** = example `apply`, her **no** = `leave`, her **undo** = `leave`; each also records what really happened.
  A placement she does NOT undo is not labelled (silence is not approval until she says how long it must last).
- Only the `deposit` kind so far. Adding a kind = calling `learnerClient.judge/example/actual` at that decision.

## Prices (added 2026-11-10)
`helpers/priceHistory.js` turns every sales-invoice price and supplier-bill price into exact facts in $/lb (per party and grade: how many times seen,
last price, typical = median of the earlier ones, how far off the last is). `node scripts/price-facts.js` shows them. It decides nothing and has no
threshold: `caseFor()` hands one price's facts to the learner as a `price-check` case, and the learner (not a rule) says normal / check once she has
labelled some. Her own companies (Edge Yard etc.) are marked intercompany and never counted as "the market".
**Daily price watch (`helpers/priceWatch.js`, cron 06:40 LA, OFF unless `JARVIS_PRICE_WATCH=1`):** every new price goes to the learner (shadow), and up
to 3 a day are asked about on WhatsApp: "normal CODE" / "check CODE". Her answer is the labelled example. Once the learner is confident
(>= 0.8) ITS call decides what is asked (a confident "normal" is not asked, a confident "check" is); before that it asks about prices at least
`JARVIS_PRICE_WATCH_MIN_PCT` (default 5%) off the party's own typical, so it can collect her first answers. That 5% only chooses what to ASK,
never whether a price is wrong. It changes no price, invoice or bill. Also: supplier bills often state no grade, so their prices mix grades until the line items are filled in.

## Behaviour that matters
- **Cold start abstains.** Fewer than 5 past decisions of a kind: it says so, it does not guess.
- It abstains if the model answers with anything she has never chosen for that kind.
- Retrieval is TF-IDF over her past cases of the same kind (no embeddings, no extra service). The model only sees the 8 most similar.
- Writes only `data/learner/examples.jsonl` and `shadow.jsonl`, append-only. Reads nothing else of Jarvis's.
- Listens on 127.0.0.1 only, shared-secret header. The Node client has a 2.5 s timeout and never throws.

## Run it on the VM
    pip install --break-system-packages -r learner/requirements.txt
    LEARNER_TOKEN=<long random> LEARNER_DATA=$PWD/data/learner GEMINI_API_KEY=<same key Jarvis uses> \
      pm2 start learner/server.py --name jarvis-learner --interpreter python3
    # then in Jarvis's env:
    JARVIS_LEARNER_URL=http://127.0.0.1:8765  JARVIS_LEARNER_TOKEN=<same token>
    pm2 restart jarvis --update-env
Model: `LEARNER_MODEL` (default `gemini/gemini-2.5-flash`). Check progress: `curl -H "X-Learner-Token: <token>" localhost:8765/report`.

## Not done, on purpose
- **Graphiti** (temporal knowledge graph) needs a graph database; not worth it until real examples show retrieval is the limit.
- **DSPy optimisers** (MIPROv2/GEPA) need ~30+ labelled examples; they come after the shadow log has them.
- The real-model path was run only against DSPy's built-in test model, not Gemini. First real call is on the VM.
- Deposits she never undoes are unlabelled; the "how long is silence approval" rule is hers to set.

Tests: `tests/learner-e2e.js` (real service + real client), section N of `tests/deposit-auto-apply.js` (the wiring).
