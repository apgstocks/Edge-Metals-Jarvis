# Wake words on Android: what the literature says, and what it means for Edge Yard

Written 2026-08-29, after eleven builds in which "Hey Jarvis" never once worked
reliably on Apsara's phone.

The question she asked: *"dont keep on adding fix. there must be a research
paper on this. check thoroughly."*

She was right. There is a literature, it is unambiguous, and it says the
approach I had been patching cannot be made to work.

---

## 1. The finding, in one line

**Android's `SpeechRecognizer` is a transcription API. It is not a wake-word
engine, and the research community stopped trying to use ASR this way over a
decade ago.**

Picovoice's Android guide states the limitation directly: `SpeechRecognizer`
"does not support developer-controlled VAD, wake word detection, custom models,
batch transcription, or intent recognition." They have a separate article,
*Using ASR for Wake Word Recognition*, whose entire purpose is explaining why
the thing I built is the wrong shape.

The reason is architectural rather than a bug. Continuous ASR requires
significant CPU and memory to run a large decoding graph; running it 24/7
starves other applications and drains the battery. So the API is built around
short, bounded *sessions* with an endpointer that closes them — which is
exactly the behaviour that broke every version of the wake loop.

---

## 2. Her logs, mapped to documented behaviour

This is the part that matters. Every symptom in her logs is a *described*
property of the API, not a device fault:

| Log evidence | What the literature says |
|---|---|
| `heard [wake] ["hey"]` then session ends — the name never arrives | Partial results deliver every word **except the last**. For a two-word wake phrase the name is never in the text being matched. |
| `command finished (recogniser stopped) hey` at 28:33.639, then the real words at 28:33.748 | The "stopped" event reports the *recogniser* stopping, not transcription finishing. It fires while words are still in flight. |
| `SR.start()` never resolving (v3.5) | Session lifecycle is not designed to be driven in a restart loop. |
| `watchdog restarting the wake loop` every 4s, forever | ASR has no continuous mode. "Always listening" on this API *is* a restart loop, by construction. |
| `["hey scout","his cout","his count","scout"]` | Wake phrases are mangled in noise. Published benchmarks measure exactly this and report it as a false-reject rate. |

Eleven builds, and each fix was correct about the symptom it addressed and
irrelevant to the cause.

---

## 3. What the field actually does

### 3.1 The foundational work — keyword spotting as its own problem

- **Chen, Parada & Heigold (2014), "Small-footprint keyword spotting using deep
  neural networks", ICASSP 2014, pp. 4087–4091.** The first paper to treat
  keyword spotting as a *classification* task with a small DNN rather than as
  recognition-then-search. ~740 citations. This is the origin of the modern
  approach.
- **Sainath & Parada (2015), "Convolutional neural networks for small-footprint
  keyword spotting", INTERSPEECH 2015.** CNNs beat the fully-connected models
  with *fewer* parameters — the result that made on-device wake words practical.

The central insight of both: a wake-word detector does not need a vocabulary, a
language model, or a decoding graph. It needs to answer one binary question
about one phrase, continuously, in a few hundred kilobytes. That is a
fundamentally smaller problem than transcription, and solving it *as* the
smaller problem is what makes it reliable and cheap.

### 3.2 Streaming and efficiency

- **Wang et al., "Wake Word Detection with Streaming Transformers"**
  (arXiv:2102.04488).
- **"Streaming Transformer for Hardware Efficient Voice Trigger Detection and
  False Trigger Mitigation"** (arXiv:2105.06598) — Apple; joint detection and
  false-trigger suppression in one hardware-efficient model.
- **"HEiMDaL: Highly Efficient Method for Detection and Localization of
  wake-words"** (arXiv:2210.15425) — Apple.
- **"Convolutional Recurrent Neural Networks for Small-Footprint Keyword
  Spotting"** (arXiv:1703.05390).
- **"Trainable Frontend For Robust and Far-Field Keyword Spotting"**
  (arXiv:1607.05666) — learned frontends for noisy, distant speech. Directly
  relevant to a scrap yard.

### 3.3 False triggers — the other half of the problem

- **"Exploring accidental triggers of smart speakers"**, Computer Speech &
  Language (ScienceDirect) — systematic study of unintended activations.
- **"Complementary Language Model and Parallel Bi-LRNN for False Trigger
  Mitigation"** (arXiv:2008.08113).
- **"Device-Directed Speech Detection: Regularization via Distillation for
  Weakly-Supervised Models"** — Apple ML Research.
- **"Selective Attention System (SAS): Device-Addressed Speech Detection for
  Real-Time On-Device Voice AI"** (arXiv:2604.08412).

This matters for Edge Yard specifically. A yard is full of talking, and a false
wake opens the microphone and sends whatever follows to `workflow/brain.js`,
which messages truckers and suppliers **for real**. The literature treats
detection rate and false-accept rate as a *pair* — you cannot tune one without
the other, and published engines quote both.

### 3.4 The benchmark numbers

Porcupine, the mainstream commercial engine, publishes:

- **97.1% detection at 1 false alarm per 10 hours**, at 10 dB SNR — i.e. with
  background speech and ambient noise.
- Comparisons are made at a *fixed* false-alarm rate, which is the honest way
  to state it.

For contrast, the restart-loop approach in this repo has, across eleven builds
and five real-world logs, a detection rate of approximately **zero**.

---

## 4. What this means for Edge Yard

Three options, honestly costed.

### Option A — Press-and-hold (recommended first step)

Remove the wake loop. Hold the mic button, speak, release, it answers aloud.

- **Uses `SpeechRecognizer` for precisely what it is built for**: one bounded
  utterance, transcribed on demand. Her own logs show this path working —
  `["hey scout","he scout","scout"]` is a correct transcription — every time it
  is not cut short by the loop.
- No new dependency, no licence, no native code. Hours, not days.
- Cost: no hands-free. In a yard with full hands that is a real loss.

### Option B — Porcupine (the proper wake word)

A dedicated on-device keyword-spotting model, as per §3.1.

- Owns the microphone itself. No restart loop, no partials, no endpointer, none
  of the five failure modes above.
- Android SDK exists; **there is no Capacitor SDK**, so it needs a small native
  plugin wrapper (Android binding + JS bridge). Roughly a day.
- Needs a Picovoice access key. Free tier exists; a commercial deployment is a
  paid licence.
- A custom wake word ("Hey Scout") is trained on their console.

### Option C — Keep patching

Not recommended, and I should not have spent eleven builds here. Each fix was
locally correct and the next failure was always one layer down, because the
component is not built for this.

---

## 5. Recommendation

**Do A now, consider B later.**

Press-and-hold gives working voice today, on the path her logs already prove
works. Live with it for a week. If hands-free genuinely matters after that —
and in a yard it might — Porcupine is the engineered answer and the day of work
is justified by then, with real usage to point at.

What should NOT happen is another patch to the restart loop. The literature is
clear that it is the wrong tool, and five logs from her phone agree with it.

---

## Sources

**Foundational**
- Chen, Parada & Heigold, *Small-footprint keyword spotting using deep neural
  networks*, ICASSP 2014 — https://scispace.com/papers/small-footprint-keyword-spotting-using-deep-neural-networks-148iaz4nzy
- Sainath & Parada, *Convolutional neural networks for small-footprint keyword
  spotting*, INTERSPEECH 2015

**Streaming / efficiency**
- https://arxiv.org/pdf/2102.04488 — Wake Word Detection with Streaming Transformers
- https://arxiv.org/pdf/2105.06598 — Streaming Transformer for Hardware Efficient Voice Trigger Detection and FTM
- https://arxiv.org/pdf/2210.15425 — HEiMDaL
- https://arxiv.org/pdf/1703.05390 — Convolutional Recurrent NNs for Small-Footprint KWS
- https://arxiv.org/pdf/1607.05666 — Trainable Frontend for Robust and Far-Field KWS
- https://arxiv.org/pdf/2209.15296 — Wake Word Detection Based on Res2Net

**False triggers**
- https://www.sciencedirect.com/science/article/abs/pii/S0885230821001212 — Exploring accidental triggers of smart speakers
- https://arxiv.org/pdf/2008.08113 — Complementary LM and Parallel Bi-LRNN for FTM
- https://machinelearning.apple.com/research/device-directed-speech — Device-Directed Speech Detection
- https://arxiv.org/pdf/2604.08412 — Selective Attention System

**Platform and engines**
- https://picovoice.ai/blog/android-speech-recognition/ — what `SpeechRecognizer` does not support
- https://picovoice.ai/blog/using-asr-for-wake-word-recognition/ — why ASR is the wrong tool
- https://picovoice.ai/docs/benchmark/wake-word/ — benchmark methodology and figures
- https://picovoice.ai/docs/api/porcupine-android/ — Android API
- https://github.com/capacitor-community/speech-recognition/issues/123 — partialResults behaviour on Android
