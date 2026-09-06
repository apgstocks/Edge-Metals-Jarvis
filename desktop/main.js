// ── desktop/main.js — Jarvis as a Mac application ─────────────────────────
//
// Apsara, 2026-09-05: "build it like a desktop application apk if it works."
//
// WHY THIS IS WORTH DOING RATHER THAN A BOOKMARK
// ---------------------------------------------
// One reason above all the others: ELECTRON BUNDLES CHROMIUM. The "Hey
// Jarvis" wake word needs continuous speech recognition, which Safari does
// badly — and Safari is her default browser. Inside this window the engine is
// always Chromium, so the wake word works without her having to remember to
// open the right browser first.
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
});

// Standard on macOS: closing the window does not quit the app.
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
