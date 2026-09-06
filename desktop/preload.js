// ── desktop/preload.js — the one bridge, deliberately narrow ──────────────
//
// This file used to be empty, with a comment saying every API added here is
// one the remote page could call. That is still true, so exactly one thing is
// exposed and it is the smallest thing that makes voice work:
//
//   jarvisSpeech.transcribe(Float32Array) -> string
//
// It takes audio and returns words. It cannot read a file, spawn a process,
// or reach anything else in Node. If the page were ever compromised, the
// worst it could do through this bridge is ask the Mac to transcribe a sound
// it supplied — which it already had, since it captured it.
//
// contextIsolation stays ON. The renderer never sees `require`.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvisSpeech', {
    // Present at all. dashboard/voice.js checks for this to decide whether it
    // is running inside the desktop app with a local engine, or in a browser
    // that must use its own.
    available: true,

    // Warms the model. Called once when voice is switched on, so the FIRST
    // thing she says is not the one that waits for a 75MB download.
    warm: function () { return ipcRenderer.invoke('speech:warm'); },

    // Float32 mono 16 kHz in, text out. Structured-cloned across the bridge,
    // which is a copy — fine for three seconds of audio (~192KB) and much
    // safer than sharing memory with a remote page.
    transcribe: function (pcm) { return ipcRenderer.invoke('speech:transcribe', pcm); },

    status: function () { return ipcRenderer.invoke('speech:status'); },
});

// ── the voice it answers in ──────────────────────────────────────────────
// Separate from jarvisSpeech because they are separate capabilities and one
// can work while the other does not: Whisper may be loaded while Kokoro is
// still downloading, and the page has to be able to tell. Merging them would
// make "is speech available" a question with two answers.
//
// Still narrow. It takes text and returns audio samples. It cannot read a
// file, spawn anything, or reach the rest of Node.
contextBridge.exposeInMainWorld('jarvisTTS', {
    available: true,          // the BRIDGE exists; whether the MODEL loaded is status()
    warm: function () { return ipcRenderer.invoke('tts:warm'); },
    speak: function (text, voice) { return ipcRenderer.invoke('tts:speak', text, voice); },
    status: function () { return ipcRenderer.invoke('tts:status'); },
});
