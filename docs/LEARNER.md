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
