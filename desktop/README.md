# Jarvis on the desktop

A Mac application that opens `https://jarvis.edgemetals.com` in its own
window.

## Why this exists rather than a bookmark

**The wake word.** "Hey Jarvis" needs continuous speech recognition, which
Safari handles badly — and Safari is the default browser on this Mac. Electron
bundles Chromium, so inside this window the engine is always the one that
works. No remembering to open the right browser first.

Then the ordinary reasons: a Dock icon, its own window, and no address bar to
lose the tab behind.

## Build it (on the Mac — this cannot be built on Linux)

```
cd desktop
npm install
npm start          # run it straight away, to check it works
npm run build      # produces dist/Jarvis-1.0.0.dmg
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
