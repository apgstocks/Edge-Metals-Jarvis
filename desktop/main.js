// ── desktop/main.js — Jarvis as a Mac application ─────────────────────────
//
// Apsara, 2026-09-05: "build it like a desktop application apk if it works."
//
// WHY THIS IS WORTH DOING RATHER THAN A BOOKMARK
// ---------------------------------------------
// The original answer here was: "Electron bundles Chromium, so the wake word
// works." THAT WAS WRONG, and it is left recorded rather than deleted because
// it cost her most of a day. Chrome's SpeechRecognition is not part of
// Chromium — it is a GOOGLE SERVICE reached with private API keys that Chrome
// ships and Electron does not. Proved on her Mac in one line: "SPEECH ERROR:
// network", instantly, every time. Electron is in fact WORSE at speech than
// the browser was, out of the box.
//
// The real reason this app is worth having is the opposite of the first one:
// because it has a Node process behind the window, it can run whisper.cpp
// locally (see speech.js). So voice here is not "the same as Chrome" — it is
// better, because her audio never leaves the machine. The window is the part
// that could have been a bookmark; the process behind it is the feature.
//
// After that: a Dock icon, its own window that survives quitting the browser,
// and no address bar to lose the tab behind.
//
// IT IS A WINDOW ONTO THE SERVER, NOT A COPY OF THE APP
// ----------------------------------------------------
// It loads https://jarvis.edgemetals.com. There is no bundled copy of the
// dashboard, so a deploy updates the desktop app at the same instant it
// updates the website, and there is no third client to keep in step with the
// other two. The whole reason the phone app and the website keep drifting is
// that they are separate copies; this deliberately is not one.

const { app, BrowserWindow, shell, systemPreferences, ipcMain } = require('electron');
const path = require('path');

// ── where it points ───────────────────────────────────────────────────────
// Defaults to the live site. `npm run dev` overrides it to localhost:8080,
// which is the developer path and is NOT a compromise on the microphone:
// Chromium treats http://localhost as a SECURE CONTEXT, so getUserMedia and
// the speech recogniser work there exactly as they do over HTTPS. That means
// the wake word can be tested against a server running on this Mac, with no
// deploy and no certificate.
const APP_URL = process.env.JARVIS_URL || 'https://jarvis.edgemetals.com';
const DEV = process.env.JARVIS_DEV === '1';

// Only this origin may load in the window. A yard app that can be navigated
// anywhere is a browser with the address bar taken away — which is worse than
// a browser, because there is nothing to show you where you are.
const ALLOWED = new URL(APP_URL).origin;

let win = null;

function create() {
    win = new BrowserWindow({
        width: 1280, height: 860, minWidth: 900, minHeight: 600,
        backgroundColor: '#0C0E10',
        titleBarStyle: 'hiddenInset',
        webPreferences: {
            // No Node in the page. The window shows a remote site; giving that
            // page Node access would mean the server — or anyone who reached
            // it — could read and write this Mac's filesystem.
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    });

    win.loadURL(APP_URL);
    if (DEV) win.webContents.openDevTools({ mode: 'right' });

    // ── the renderer's console, in the terminal ───────────────────────────
    // Added after a long debugging loop that this would have ended on the
    // first pass. `npm start` shows only MAIN-process output, so every
    // diagnostic that mattered — whether the speech engine loaded, why it
    // did not — was printed into devtools that nobody had opened, and the
    // terminal looked identical whether the feature worked or was completely
    // dead. A window whose only failure report is somewhere you have to know
    // to look is a window that cannot be debugged over a phone call.
    //
    // FILTERED, not forwarded wholesale: the dashboard is chatty, and a
    // terminal scrolling with routine logs is as useless as a silent one.
    // Voice lines and real errors only.
    win.webContents.on('console-message', (...args) => {
        // Electron changed this signature: newer versions pass one details
        // object, older ones pass (event, level, message, line, sourceId).
        // Both are handled because getting this wrong makes the diagnostic
        // channel itself the thing that is broken.
        const d = (args[0] && typeof args[0] === 'object' && 'message' in args[0])
            ? args[0]
            : { level: args[1], message: args[2] };
        const msg = String(d.message == null ? '' : d.message);
        const lvl = String(d.level == null ? '' : d.level);
        const bad = lvl === 'error' || lvl === 'warning' || lvl === '2' || lvl === '3';
        if (!bad && !/\[VOICE\]|\[SPEECH\]|SPEECH ERROR/i.test(msg)) return;
        console.log(`[page${bad ? ' ' + lvl : ''}] ${msg}`);
    });

    // A page that fails to load must SAY SO. Without this the window is just
    // black — which looks identical to "the app is broken" and sends someone
    // debugging the wrong thing. The commonest cause by far is running
    // `npm run dev` without the server started, so that is named first.
    win.webContents.on('did-fail-load', (e, code, desc, url) => {
        const hint = /localhost/.test(APP_URL)
            ? 'Is the Jarvis server running? In the repo root:  npm start'
            : 'Check the site is up and this Mac is online.';
        win.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
            `<body style="background:#0C0E10;color:#8A9299;font:13px ui-monospace,monospace;padding:40px;line-height:1.7">
             <div style="color:#B4703A;font-weight:700;letter-spacing:.1em;text-transform:uppercase">Could not load Jarvis</div>
             <p>${desc} (${code})<br>${url}</p><p>${hint}</p>
             <p style="color:#5A6169">Point it elsewhere with:  JARVIS_URL=http://localhost:8080 npm start</p></body>`));
    });

    // The microphone prompt. Granted only for this origin, and only for media
    // — every other permission a web page can ask for is refused outright,
    // because none of them have anything to do with a yard assistant.
    win.webContents.session.setPermissionRequestHandler((wc, permission, done) => {
        const from = new URL(wc.getURL() || 'about:blank').origin;
        done(from === ALLOWED && (permission === 'media' || permission === 'audioCapture'));
    });

    // Links to anywhere else open in the real browser rather than replacing
    // the app with a web page it cannot navigate back from.
    win.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url); return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
        if (new URL(url).origin !== ALLOWED) { e.preventDefault(); shell.openExternal(url); }
    });

    win.on('closed', () => { win = null; });
}

// ── the speech service ────────────────────────────────────────────────────
// Registered before any window exists, so a renderer that asks early is never
// answered by a missing handler. Every one returns a RESULT OBJECT rather
// than throwing across IPC: a rejected invoke surfaces in the renderer as an
// opaque "Error invoking remote method", which tells the person nothing. The
// whole point of this rewrite is that failures explain themselves.
const speech = require('./speech');

ipcMain.handle('speech:warm', async () => {
    try { await speech.load(); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('speech:transcribe', async (_e, pcm) => {
    try {
        // Arrives as a copy across the bridge; smart-whisper wants Float32Array.
        const audio = pcm instanceof Float32Array ? pcm : new Float32Array(pcm);
        const text = await speech.transcribe(audio);
        return { ok: true, text: text };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('speech:status', async () => speech.status());

app.whenReady().then(async () => {
    console.log(`[JARVIS] loading ${APP_URL}${DEV ? '  (dev, devtools open)' : ''}`);
    // Ask macOS for the microphone up front, once, with the app's own name on
    // the dialog. Without this the first "Hey Jarvis" fails silently on some
    // macOS versions: the page asks, the OS has never been asked, and nothing
    // happens that explains itself.
    if (process.platform === 'darwin') {
        try { await systemPreferences.askForMediaAccess('microphone'); } catch (e) {}
    }
    create();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) create(); });

    // ── prove the engine at boot, in the terminal ─────────────────────────
    // The renderer already warms the model, but ONLY IF voice-local.js
    // loaded — and the failure being debugged was precisely that it had not,
    // because the server was serving an older page. In that state the
    // renderer warms nothing, prints nothing, and the terminal is silent, so
    // "the model is broken" and "the page never asked for the model" look
    // exactly alike. Warming here separates them: this line appears whatever
    // the page does.
    //
    // The cost is ~75MB of resident model in an app that exists mostly to
    // listen, and it removes the first-utterance delay. Worth it.
    speech.load().then(
        () => console.log(`[JARVIS] speech ready — ${speech.MODEL}, local, nothing uploaded`),
        (e) => console.error(`[JARVIS] speech NOT ready — ${e.message}`));
});

// Standard on macOS: closing the window does not quit the app.
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
