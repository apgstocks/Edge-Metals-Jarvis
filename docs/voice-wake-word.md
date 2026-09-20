# "Hey Jarvis" on the device — wake word, end of turn, names (2026-09-20)

Apsara: *"openWakeWord -> we need it. Why can't we do Hey Jarvis on a low model?"*
and *"Endpointing … work on this. Speech to text."*

## What runs where

| Piece | File | Runs in | Model |
|---|---|---|---|
| Wake word | `dashboard/wake-model.js` + `dashboard/oww-core.js` | Chrome **and** the Mac app (it loads this page) | openWakeWord: `dashboard/models/oww/*.onnx` (3.7 MB) |
| End of turn | `dashboard/turn-model.js` (+ `/melspec.js` = `desktop/melspec.js`) | Chrome | Smart Turn v3.2 (8.7 MB, Hugging Face, BSD-2) |
| End of turn | `desktop/turn.js` | Mac app (main process, unchanged) | same model |
| Names | `pickAlternative()` in `dashboard/voice.js` + `/api/voice/vocab` `terms` | Chrome | none — picks among Chrome's 4 guesses |

onnxruntime-web 1.20.1 is loaded from jsdelivr. Nothing is sent to a server for the wake word or the end of turn.

## Measured on HER voice (tests/fixtures/wake-her-voice.wav, from her recording 2026-09-20 06:54)
- Wake: 5 of 5 "Hey Jarvis" heard; **0** false wakes in 20 s of her talking with Jarvis answering out loud. The JS port matches the Python reference to **0.0000**. Cost: about 3 ms per 80 ms of audio (Node) and fine in the WebAssembly build.
- End of turn: "What's up — what needs my attention?" gives p = 0.81 (finished). The same sentence cut half-way gives p = 0.01. About 320 ms per decision in Chrome.

Tests:
- `tests/oww-parity.js` — the port against Python, and the wake model on her voice.
- `tests/wake-browser.js` — real Chromium with her voice as the microphone.
- `tests/turn-browser.js` — the end-of-turn model in real Chromium.
- `tests/voice-web.js` sections WAKE, TURN, STT, PAUSE and YES.

The browser tests need `PUPPETEER_EXECUTABLE_PATH`, `ORT_WEB_DIR` and `SMART_TURN_MODEL`, and print SKIPPED without them.

## ⚠ Licence — before Jarvis is sold
- openWakeWord **code** is Apache 2.0.
- The pre-trained **`hey_jarvis_v0.1.onnx` is CC BY-NC-SA 4.0 — non-commercial.** It is OK for Edge Metals trying it; it is NOT OK in a product sold to other companies.
- Plan: train our own "Hey Jarvis" with openWakeWord's training notebook (Apache 2.0). It uses synthetic TTS voices plus negative audio, takes a few hours on Colab, and the result replaces this file with no code change.
- Check the licences of whatever training data is used. This note is not legal advice.
- The model has no published test set. It was trained on a neutral American accent. Her voice worked above; other accents are unmeasured.

## Tuning
- Threshold: `localStorage.jvWakeThreshold` (default 0.5). Raise it if it wakes on its own; lower it if it misses her. The console prints every fire with its score (`[WAKE]`).
- End of turn: `TURN_ASK_MS` = 450 (when the model is asked) and `TURN_MAX_MS` = 2600 (silence that always ends the turn), in `voice.js`. A sentence ending on "to / the / and / for …" always waits.

## Found on the way
`desktop/package.json` "files" left out `tts.js`, `turn.js` and `melspec.js`, so a **built** Mac app (`npm run build`) would crash on start because `main.js` requires them. `npm start` from source worked, which hid it. They are added now.
