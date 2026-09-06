# Jarvis on the desktop

A Mac application that opens `https://jarvis.edgemetals.com` in its own
window.

## Why this exists rather than a bookmark

## Voice, with the engine inside the app

The app transcribes speech itself, using whisper.cpp on this Mac. **Nothing
leaves the machine** — which is better than the Chrome path, where the audio
is uploaded to Google to be transcribed.

Two things before it works:

```
cd desktop
npm install          # pulls smart-whisper (builds whisper.cpp)
npm run model        # downloads ggml-tiny.en.bin, ~75 MB, once
npm start
```

`npm run model` puts the model in
`~/Library/Application Support/Jarvis/models/` — outside the .app bundle,
because that bundle is read-only once signed.

Then click **Turn on voice** and say "Hey Jarvis".

### How it listens without cooking the battery

The microphone is always open, which is cheap. Whisper is not, so it does not
run continuously. An energy gate measures loudness every frame — arithmetic
on a buffer, no model — and only hands Whisper audio once the level crosses a
threshold and then falls quiet again. A silent yard costs nothing.

That is the same shape as a wake-word engine with a much dumber trigger. If
it fires too often on doors and radios, **openWakeWord** (MIT, free, custom
wake words) replaces the level check with a real model. Worth doing when the
false triggers actually annoy you — measured, not assumed.

## And the thing I got wrong

**NOT Chromium's speech — I was wrong about that, and it is worth being blunt.**

I built this app justifying it with "Electron bundles Chromium, so the wake
word works even though Safari is the default browser". That is false.

Speech recognition in Chrome is a GOOGLE SERVICE, not a browser feature.
Chrome ships private API keys for it. Electron's Chromium does not have them
and is not permitted to. Proved on the machine rather than argued about, in
the app's own devtools:

    SR exists: true
    MIC STARTED
    SPEECH ERROR: network
    MIC ENDED

No configuration fixes this — which is why the app now carries its own
engine instead, as described above. The "Use Chrome" message remains for the
case where the local model has not been downloaded.

## So what is this app still good for

A Dock icon, its own window that survives quitting the browser, and no
address bar to lose the tab behind. Everything except the wake word works in
it, including the orb and the typed assistant.

I also said fixing this would mean paying for a cloud speech API. That was
sloppy and wrong twice over: whisper.cpp is MIT-licensed, runs locally, costs
nothing, and is what the app now uses.

Then the ordinary reasons: a Dock icon, its own window, and no address bar to
lose the tab behind.

## Already built

`builds/Jarvis-mac-AppleSilicon.zip` and `builds/Jarvis-mac-Intel.zip` are
ready to run — unzip, drag `Jarvis.app` to Applications.

I had said this could not be built off a Mac. That was WRONG, and worth
recording: the `.dmg` target genuinely needs macOS, because it shells out to
`sips`, an Apple image tool. The `.app` itself does not. Targeting a zip
instead produced a real, runnable application from Linux. The lesson is the
usual one — the error message named `sips`, not "macOS required", and reading
it would have got there faster than assuming.

## Rebuilding it yourself

```
cd desktop
npm install
npm start          # run it straight away, to check it works
npm run build      # .dmg — needs macOS
npx electron-builder --mac zip --arm64 --x64   # .app in a zip — works anywhere
```

`npm start` is worth doing first. If the window opens and the orb appears,
the build will work; if it does not, the build would only produce a broken
`.dmg` more slowly.

## The two things macOS will ask

1. **Microphone**, once, at first launch — the app asks up front so the
   request carries its own name rather than appearing mysteriously later.
2. **"Jarvis cannot be opened because it is from an unidentified developer."**
   Expected. The app is unsigned, because signing needs a paid Apple Developer
   account. Right-click the app → **Open** → **Open**. Once only.

Signing it properly is a $99/year Apple Developer membership. Worth it if this
ever goes on more than one machine; not worth it for one Mac.

## What it deliberately does NOT do

- **No bundled copy of the dashboard.** It loads the live site, so a deploy
  updates this app at the same moment it updates the website. The phone app
  and the website drift precisely because they are separate copies; this is
  not a third one.
- **No Node access in the page.** `nodeIntegration: false`, `sandbox: true`,
  and an empty preload. The window shows a remote site; giving that page
  filesystem access would mean the server, or anyone who reached it, could
  read and write this Mac.
- **Cannot navigate anywhere else.** Only `jarvis.edgemetals.com` loads in the
  window; every other link opens in the real browser. An app that can be
  navigated anywhere is a browser with the address bar taken away, which is
  worse than a browser, because nothing shows you where you are.

## Pointing it somewhere else

```
JARVIS_URL=https://staging.example.com npm start
```
