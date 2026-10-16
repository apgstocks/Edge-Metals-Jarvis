// mobile-app/www/app/18-voice.js — split from mobile-app/www/index.html's <script> (helpers/sourceParts.js reconstructs the original)
// ── Jarvis WhatsApp health banner ─────────────────────────────────────────
// Added 2026-08-22 per Apsara: "in app, if whatsapp jarvis is down, allow
// user to open their own whatsapp."
//
// WORTH BEING PRECISE ABOUT WHAT THIS DOES AND DOESN'T FIX, because the
// premise turned out not to hold: nothing the app does goes through Jarvis's
// WhatsApp session. "Send to seller" in both clients opens a wa.me deep link,
// which hands off to whatever WhatsApp is installed on the phone and sends
// from THAT account (changed 2026-08-17, and confirmed present in the shipped
// APK asset). Generated documents go out through the Android share sheet.
// POST /api/loads/:id/send-to-seller — the route that DID use Jarvis — has
// been dead code since that change.
//
// So there is no in-app send to fall back FROM. What Jarvis's session still
// owns is the unattended work: the 8pm yard report to the team group, price-
// list changes to customers, and yard-group replies. When the session drops,
// all of that silently stops, and the only way to find out was reading pm2
// logs — the exact class of failure /api/health was built for.
//
// Hence: no send buttons (her call — "just the warning"), one honest banner
// naming what has stopped.
//
// If a ticket ever appears to send from the Jarvis number, the cause is the
// phone, not this code: wa.me sends from the account signed into WhatsApp on
// that device, so on the handset that hosts the Jarvis number, "your own
// WhatsApp" IS Jarvis. Sharing the ticket via the share sheet instead would
// let you pick between WhatsApp and WhatsApp Business — not built, since it
// wasn't asked for.
let waBannerTimer = null;

// Admin-only, and that's a server fact rather than a UI preference:
// /api/whatsapp/status is requireAdmin, and staff are denied everything
// outside STAFF_ALLOWED_PATH_PREFIXES. A non-admin call would 403, so it
// isn't made at all.
async function refreshWaBanner() {
  const el = $('waDownBanner');
  if (!el) return;
  if (ROLE !== 'admin') { el.classList.add('hidden'); return; }
  let st = null;
  try { st = await api('/api/whatsapp/status'); }
  catch (err) {
    // A failed status check is NOT evidence the session is down — the
    // server could simply be unreachable, and claiming WhatsApp is
    // disconnected on the strength of a network blip is how a banner
    // teaches people to ignore it. Leave whatever's showing.
    return;
  }
  if (!st || st.status === 'ready') { el.classList.add('hidden'); el.innerHTML = ''; return; }

  // 'initializing' is normal for the first seconds after a restart and
  // resolves itself, so it gets softer wording than a real disconnect.
  const booting = st.status === 'initializing';
  const headline = {
    initializing: 'Jarvis is still connecting to WhatsApp',
    qr: 'Jarvis is signed out of WhatsApp',
    disconnected: 'Jarvis is disconnected from WhatsApp',
    auth_failure: 'Jarvis was rejected by WhatsApp',
  }[st.status] || 'Jarvis is not connected to WhatsApp';

  const fix = {
    qr: 'Scan the QR code on the dashboard under Settings to sign it back in.',
    auth_failure: 'The session was refused — re-scan the QR code on the dashboard under Settings.',
    disconnected: 'It usually reconnects on its own. If it does not, re-scan the QR code on the dashboard under Settings.',
  }[st.status] || '';

  el.innerHTML = `
    <div style="display:flex; align-items:start; gap:9px;">
      <span style="font-size:14px; line-height:1.2;">⚠</span>
      <div style="flex:1; min-width:0;">
        <div style="font-size:12.5px; font-weight:700; color:var(--text-strong);">${esc(headline)}</div>
        <div style="font-size:11.5px; color:var(--text-muted); margin-top:4px; line-height:1.5;">
          ${booting
            ? 'Give it a moment. Until it finishes, automatic messages are queued or dropped.'
            : 'The 8pm yard report, price-list updates and yard-group replies will not send until this is fixed.'}
        </div>
        ${fix ? `<div style="font-size:11.5px; color:var(--text-muted); margin-top:5px; line-height:1.5;">${esc(fix)}</div>` : ''}
        <div style="font-size:11.5px; color:var(--text-faint); margin-top:6px; line-height:1.5;">
          Sending a load ticket still works — that goes through the WhatsApp on this phone, not Jarvis.
        </div>
        ${st.lastError ? `<div style="font-family:var(--font-mono); font-size:10px; color:var(--text-faint); margin-top:6px; word-break:break-word;">${esc(st.lastError)}</div>` : ''}
      </div>
    </div>`;
  el.classList.remove('hidden');
}

// Polled rather than checked once at boot: this app stays open on a phone in
// a yard for hours, and a session that drops at 2pm would otherwise show a
// clean screen until the next restart. 60s is frequent enough to notice
// before the 8pm report and cheap enough to ignore — the endpoint reads an
// in-memory object.
function startWaBannerPolling() {
  if (waBannerTimer) clearInterval(waBannerTimer);
  refreshWaBanner();
  waBannerTimer = setInterval(refreshWaBanner, 60000);
}


// ══════════════════════════════════════════════════════════════════════
// VOICE COMMANDS — "Hey Jarvis" (2026-08-23)
// ══════════════════════════════════════════════════════════════════════
// Per Apsara: "activate jarvis in mobile. when i say Hey Jarvis, i should be
// able to talk back" — scoped to EARS ONLY for now (her call: no spoken
// replies yet), with both a wake word and a mic button.
//
// The backend already existed: POST /api/bot/command runs text through the
// SAME workflow/brain.js pipeline a WhatsApp message goes through and returns
// whatever Jarvis would have replied. So this is a microphone bolted onto a
// door that was already open — which also means voice can do exactly what
// Jarvis can do over WhatsApp today, no more.
//
// RECOGNITION IS ON-DEVICE, not the server's Gemini transcriber
// (/api/bot/voice-command). Three reasons: the wake word needs continuous
// local listening and can't ship every ambient second of a scrap yard to a
// server; yard signal is unreliable and this keeps working without it; and
// nothing is uploaded, so an open mic isn't also an open pipe. The cost is
// accuracy on accented or noisy speech, which is exactly why the transcript
// is shown in an EDITABLE box before anything runs.
//
// NOTHING FIRES WITHOUT A LOOK. Every command lands in a review box first.
// The dashboard's own terminal warns "Commands fire for real — same effect as
// messaging Jarvis on WhatsApp", and that was for someone sitting at a desk
// having typed it deliberately. A mic in a noisy yard mishears more, and
// these commands send real messages to truckers and suppliers.
let voiceOn = false;          // wake-word loop running
let voiceListening = false;   // a capture is currently open
let voiceMode = null;         // 'wake' | 'command'
let voiceWatchdog = null;

// ── Jarvis and Scout speak ────────────────────────────────────────────────
// Per Apsara 2026-08-29: "give voice to the app... make it talk back", a
// human voice, and two agents — Jarvis (Charon) for freight, Scout (Leda) for
// the yard — so she can hear which one answered.
//
// THE MIC IS STOPPED WHILE EITHER OF THEM TALKS. This is the whole reason
// this is a function and not two lines inline. The wake loop listens
// continuously; if the speaker is live while the mic is open, the phone hears
// its own reply, finds "Jarvis" inside it, treats that as the wake word and
// triggers itself — forever, on an open mic, until the battery dies. Any
// answer that mentions either agent by name would do it.
//
// So: remember whether the loop was running, stop it, speak, restart it. The
// remembering matters — restarting a loop she had switched OFF would be its
// own bug.
let speaking = false;
let voiceMuted = false;             // her switch, not a state
try { voiceMuted = localStorage.getItem('jarvis_voice_muted') === '1'; } catch (e) {}

// ── the wake word, done properly ──────────────────────────────────────────
// Picovoice Porcupine, via the native plugin in WakeWordPlugin.java.
//
// This REPLACES the SpeechRecognizer restart loop rather than sitting beside
// it. Eleven builds went into that loop and none of them worked; the research
// (docs/voice-wake-word-research.md) says it never could, because
// SpeechRecognizer is a transcription API that explicitly does not support
// wake-word detection. Porcupine is a small keyword-spotting model that owns
// the microphone itself: no sessions, no endpointer, no partial results,
// nothing for this file to drive.
//
// "Jarvis" is built into the SDK. "Scout" needs a custom .ppn from the
// Picovoice console dropped into mobile-app/android/app/src/main/assets/ —
// the plugin picks up whatever is there, so it starts working without a code
// change.
//
// THE KEY IS ENTERED, NOT BUILT IN. A Picovoice AccessKey is per-account and
// rotates; baking one into the APK would mean a rebuild every time it changed,
// which is the same mistake the server URL used to make (see the comment on
// DEFAULT_API_BASE). It lives in localStorage and is typed once.
function wakePlugin() {
  const cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return null;
  return (cap.Plugins && cap.Plugins.WakeWord) || null;
}

function porcupineKey() {
  try { return localStorage.getItem('picovoice_key') || ''; } catch (e) { return ''; }
}
function setPorcupineKey(k) {
  try {
    if (k) localStorage.setItem('picovoice_key', String(k).trim());
    else localStorage.removeItem('picovoice_key');
  } catch (e) {}
}

// True when the real engine is available AND configured. Everything else in
// the app branches on this: when it is true the old loop must never start.
// voiceAllowed() is checked here, not just at the button, because this
// function is what the boot path and the state machine's START_MIC effect
// consult to decide whether to open the microphone. With voice off it must
// answer no, or the engine starts with no way to see or stop it.
function usingPorcupine() { return voiceAllowed() && !!wakePlugin() && !!porcupineKey(); }

let porcupineOn = false;

async function startPorcupine() {
  const W = wakePlugin();
  if (!W) return false;
  const key = porcupineKey();
  if (!key) { vlog('porcupine: no access key set'); return false; }
  if (porcupineOn) return true;

  // The mic permission is requested through the speech plugin, which already
  // owns that dialogue. Porcupine only checks it.
  try {
    const SR = voicePlugin();
    if (SR) await SR.requestPermissions();
  } catch (e) {}

  try {
    const r = await W.start({ accessKey: key });
    porcupineOn = true;
    vlog('porcupine STARTED', r && r.keywords);
    if (!window.__saidListening) {
      window.__saidListening = true;
      voiceToast('Listening for "' + ((r && r.keywords) || 'Jarvis').replace(/,/g, '" or "') + '".');
    }
    renderVoiceButton();
    return true;
  } catch (e) {
    const msg = (e && e.message) || String(e);
    vlog('porcupine FAILED', msg);
    // Each of these needs a different answer from the person holding the phone,
    // so they are not collapsed into one message.
    if (/no-access-key/.test(msg)) voiceToast('No Picovoice key yet — add it in Server settings.');
    else if (/no-mic-permission/.test(msg)) voiceToast('Microphone permission is denied. Android Settings → Apps → Edge Yard → Permissions.');
    else if (/Activation|LimitReached|Throttled/i.test(msg)) voiceToast('Picovoice key rejected or its free limit is reached: ' + msg);
    else if (/Invalid|AccessKey/i.test(msg)) voiceToast('That Picovoice key was not accepted: ' + msg);
    else voiceToast('Wake word could not start: ' + msg);
    return false;
  }
}

async function stopPorcupine() {
  const W = wakePlugin();
  porcupineOn = false;
  try { if (W) await W.stop(); } catch (e) {}
  renderVoiceButton();
}

// Speaking must silence the detector, exactly as it silenced the old loop —
// the self-trigger is a property of having a microphone and a speaker, not of
// which engine is listening.
async function pausePorcupine() { try { if (porcupineOn && wakePlugin()) await wakePlugin().pause(); } catch (e) {} }
async function resumePorcupine() { try { if (porcupineOn && wakePlugin()) await wakePlugin().resume(); } catch (e) {} }

function wirePorcupine() {
  const W = wakePlugin();
  if (!W || W.__wired) return;
  W.__wired = true;
  W.addListener('wake', (ev) => {
    const word = (ev && ev.keyword) || 'jarvis';
    vlog('PORCUPINE WAKE', word);
    // Same behaviour as before from here on: acknowledge, then listen for the
    // command. The difference is that this fires reliably.
    speak({ phrase: 'wake' }).then(() => captureCommand(''), () => captureCommand(''));
  });
}

// ── the voice log ─────────────────────────────────────────────────────────
// Apsara, after five silent builds: "still no talkback. add logs".
//
// Right. Five rounds of me reasoning from the outside about a device I cannot
// see is five rounds too many. This records what ACTUALLY happens, in order,
// with timings — most importantly the raw text the recogniser returns, which
// is the one thing none of my reasoning could reach.
//
// That matters because of a hypothesis I have not been able to test: the
// microphone cycling with no reply is EXACTLY what it looks like when the wake
// phrase never matches. Android's recogniser renders "Jarvis" as "service",
// "java's", "jarvous" and worse in a noisy yard. If it is hearing her fine and
// simply not matching, no amount of fixing the speech pipeline would ever have
// helped — and only the raw text can tell us that.
//
// A ring buffer, so it cannot grow without bound on a phone left running.
const VLOG_MAX = 300;
// On window on purpose: a top-level `const` in a classic script is NOT a
// window property, so the end-to-end harness could not read the log and a
// failure printed nothing. The log is the whole point of having a log.
const vlogLines = [];
try { window.vlogLines = vlogLines; } catch (e) {}
function vlog(msg, detail) {
  const t = new Date();
  const stamp = String(t.getMinutes()).padStart(2, '0') + ':'
    + String(t.getSeconds()).padStart(2, '0') + '.'
    + String(t.getMilliseconds()).padStart(3, '0');
  const line = stamp + '  ' + msg + (detail === undefined ? '' : '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)));
  vlogLines.push(line);
  if (vlogLines.length > VLOG_MAX) vlogLines.shift();
  // Also to the Android log, so `adb logcat` shows it without opening the app.
  try { console.log('[VOICE] ' + line); } catch (e) {}
  const el = document.getElementById('voiceLog');
  if (el && !el.classList.contains('hidden')) el.textContent = vlogLines.join('\n');
}

// ── the microphone rule lives in voice-machine.js ─────────────────────────
// Everything about WHEN the mic may be open is decided there and tested
// exhaustively in tests/voice-machine.js. This file only carries out the
// decision. Keeping the rule anywhere else is what made it untestable.
//
// The wake-word setting is persisted, so it survives backgrounding, closing
// the app and restarting the phone — per Apsara: "App backgrounds is also
// fine. unless i clear the cache, it should listen right?" The SETTING does
// exactly that. The microphone itself still stops while the app is not in the
// foreground, which is an Android constraint rather than a preference.
let VM = (typeof VoiceMachine !== 'undefined') ? VoiceMachine : null;
let vmState = VM ? VM.initial({
  // foreground STARTS FALSE, deliberately. The app declares itself foreground
  // once it is up, and that transition is what produces the START_MIC effect.
  // Initialising it to true made the boot dispatch a no-op — the state was
  // already correct, so nothing changed, so no effect fired, so the recogniser
  // never started. Everything looked right and the mic stayed shut.
  foreground: false,
  enabled: (function () {
  // DEFAULT ON. Apsara's words were "after opening the app, if i call hey
  // jarvis..make it talk back" — opening the app IS the switch. Requiring a
  // long-press first meant she opened it, said Hey Jarvis, and nothing
  // happened, which is exactly what she reported.
  //
  // An explicit OFF is still respected; only the absence of a choice defaults
  // to listening.
  try {
    const saved = localStorage.getItem('jarvis_wake_on');
    return saved === null ? true : saved === '1';
  } catch (e) { return true; }
})(),
}) : null;

function vmSend(event) {
  if (!VM) { vlog('vmSend IGNORED — VoiceMachine not loaded', event); return []; }
  const r = VM.reduce(vmState, event);
  vmState = r.state;
  vlog('machine ' + event, { effects: r.effects, state: r.state });
  try { localStorage.setItem('jarvis_wake_on', vmState.enabled ? '1' : '0'); } catch (e) {}
  // Effects come back in a deliberate order — silence the speaker, close the
  // mic, then open it. Performing them in any other order reintroduces the
  // window where both are live at once.
  for (const eff of r.effects) {
    if (eff === 'STOP_SPEAKING') stopSpeaking();
    else if (eff === 'STOP_MIC') {
      voiceOn = false;
      const SR = voicePlugin(); try { SR && SR.stop(); } catch (e) {}
      if (voiceWatchdog) { clearTimeout(voiceWatchdog); voiceWatchdog = null; }
      // The detector has a microphone too. Speaking must silence it or the
      // phone hears its own reply — the self-trigger is a property of having a
      // speaker and a mic, not of which engine is listening.
      pausePorcupine();
      renderVoiceButton();
    }
    else if (eff === 'START_MIC') {
      // WHO OWNS THE MICROPHONE MATTERS, not just whether it is open.
      //
      // Found by the end-to-end harness: after reading an instruction back,
      // the capture opened for her "yes" — and the machine's START_MIC effect
      // called startWakeLoop(), which sets voiceMode back to 'wake'. Her "yes"
      // was then handed to the wake-word matcher, which of course found no
      // wake word in it and dropped it. The confirmation could never be
      // answered.
      //
      // A capture already opens the recogniser itself. When one is running it
      // owns the microphone, and the wake loop must stay out of the way.
      if (vmState && vmState.capturing) { vlog('mic stays with the capture'); }
      else if (usingPorcupine()) { resumePorcupine(); }
      else startWakeLoop();
    }
    else if (eff === 'OPEN_CAPTURE') { /* captureCommand is called by the caller that knows the seed text */ }
  }
  return r.effects;
}

function setVoiceMuted(on) {
  voiceMuted = !!on;
  try { localStorage.setItem('jarvis_voice_muted', voiceMuted ? '1' : '0'); } catch (e) {}
  if (voiceMuted) stopSpeaking();
}

let currentAudio = null;
const phraseCache = {};   // phrase name -> object URL, kept for the life of the app
function stopSpeaking() {
  if (currentAudio) { try { currentAudio.pause(); } catch (e) {} currentAudio = null; }
  speaking = false;
}

// Plays a WAV the server synthesised. Resolves when it finishes or fails —
// never rejects, because the caller's next job is to turn the mic back on and
// that must happen whatever the audio did.
function playAudio(url) {
  return new Promise((resolve) => {
    let a;
    try { a = new Audio(url); } catch (e) { return resolve(false); }
    currentAudio = a;
    let done = false;
    const finish = (ok) => { if (done) return; done = true; currentAudio = null; resolve(ok); };
    a.onended = () => finish(true);
    a.onerror = () => finish(false);
    // A stuck audio element must not strand the mic in the off position. 30s
    // is longer than any reply this speaks.
    setTimeout(() => finish(false), 30000);
    const p = a.play();
    if (p && p.catch) p.catch(() => finish(false));
  });
}

// ── Voice self-test ───────────────────────────────────────────────────────
// Walks every link in the chain and reports what each one DID, rather than
// leaving a silent failure to be guessed at from the outside. The order is the
// order the real path takes, so the first ✗ is the cause.
async function runVoiceDiagnostic() {
  const out = $('voiceDiag');
  const lines = [];
  const say = (t) => { lines.push(t); out.textContent = lines.join('\n'); };
  out.textContent = 'Checking…';
  lines.length = 0;

  // 1. the recogniser
  const SR = voicePlugin();
  say((SR ? '✓' : '✗') + ' speech plugin ' + (SR ? 'present' : 'MISSING (not the installed app?)'));
  if (SR) {
    try {
      const av = await SR.available();
      say(((av && (av.available ?? av)) ? '✓' : '✗') + ' recogniser available on this phone');
      const perm = await SR.requestPermissions();
      const st = (perm && perm.speechRecognition) || 'unknown';
      say((st === 'granted' ? '✓' : '✗') + ' microphone permission: ' + st);
    } catch (e) { say('✗ recogniser check threw: ' + (e && e.message)); }
  }

  // 2. the server, at all
  say('  server: ' + (getApiBaseForDisplay() || '(same origin)'));
  try {
    const me = await api('/api/me');
    say('✓ server reachable, signed in as ' + (me && me.role));
  } catch (e) {
    say('✗ server unreachable: ' + (e && e.message));
  }

  // 3. the voice endpoint — the one added most recently, so the likeliest to
  //    be missing from a server that has not been updated.
  let blob = null;
  try {
    blob = await api('/api/voice/phrase/wake', { raw: true });
    say('✓ /api/voice/phrase/wake returned ' + Math.round(blob.size / 1024) + ' KB');
  } catch (e) {
    say('✗ /api/voice/phrase/wake FAILED: ' + (e && e.message));
    say('   -> the server likely has no speech endpoint yet.');
    say('      git pull && npm install && pm2 restart jarvis --update-env');
  }

  // 4. can this WebView actually PLAY it
  if (blob) {
    const url = URL.createObjectURL(blob);
    try {
      const ok = await playAudio(url);
      say((ok ? '✓' : '✗') + ' audio playback ' + (ok ? 'worked — you should have heard it' : 'FAILED (blocked or unsupported)'));
    } catch (e) { say('✗ playback threw: ' + (e && e.message)); }
    try { URL.revokeObjectURL(url); } catch (e) {}
  }

  // 5. the answering endpoint
  try {
    const r = await api('/api/voice/ask', { method: 'POST', body: JSON.stringify({ text: 'how much do we owe in total' }) });
    say('✓ /api/voice/ask -> ' + (r && r.agent_name) + ': ' + String((r && r.answer) || '').slice(0, 80));
  } catch (e) {
    say('✗ /api/voice/ask FAILED: ' + (e && e.message));
  }

  // 6. the phone's own voice — the fallback that guarantees SOMETHING is said
  const TTS = deviceTtsPlugin();
  if (!TTS) {
    say("✗ phone's own voice: plugin missing");
  } else {
    try {
      const ok = await speakOnDevice('Device voice test.');
      say((ok ? '✓' : '✗') + " phone's own voice " + (ok ? '— you should have heard that' : 'FAILED'));
    } catch (e) { say("✗ phone's own voice threw: " + (e && e.message)); }
  }

  say('');
  say('Send me this list and I will fix the first ✗.');
}

function getApiBaseForDisplay() {
  try { return localStorage.getItem('jarvis_api_base') || ''; } catch (e) { return ''; }
}

// ── the phone's own voice, as a fallback ──────────────────────────────────
// Apsara, after four rounds: "still no talkback".
//
// The Gemini voice is the one she chose and it is worth having. But it needs a
// server that has been updated, a network, and a working API key — three
// things that can each be absent in a yard — and when any of them is missing
// the result so far has been SILENCE. That is the wrong failure. A robotic
// voice that answers beats a human voice that does not.
//
// So: Android's built-in engine, wired here as the fallback it should have
// been from the start. Offline, instant, no server, and installed with the app
// (@capacitor-community/text-to-speech, added at the beginning of this work
// and then left unused — my oversight).
//
// It is only ever reached when the good voice fails. Nothing about the Gemini
// path changes.
function deviceTtsPlugin() {
  const cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return null;
  return (cap.Plugins && cap.Plugins.TextToSpeech) || null;
}

// The device voice must obey exactly the same rule as the good one: the
// microphone is shut while anything is talking. Routing it through the state
// machine rather than calling the plugin directly is what stops the fallback
// from quietly reintroducing the self-trigger this whole design exists to
// prevent.
async function speakWithMicClosed(text) {
  if (!text) return false;
  const TTS = deviceTtsPlugin();
  if (!TTS) return false;
  speaking = true;
  vmSend('SPEAK_START');
  try {
    const ok = await speakOnDevice(text);
    vlog('  phone voice ' + (ok ? 'spoke' : 'FAILED'), text.slice(0, 60));
    return ok;
  } finally {
    speaking = false;
    setTimeout(() => { if (!voiceMuted) vmSend('SPEAK_END'); }, 400);
  }
}

async function speakOnDevice(text) {
  const TTS = deviceTtsPlugin();
  if (!TTS || !text) return false;
  try {
    await TTS.speak({
      text: String(text).slice(0, 600),
      lang: 'en-US',
      // A shade faster than default, for the same reason the Gemini direction
      // is brisk: nobody in a yard is waiting through a slow sentence.
      rate: 1.1,
      pitch: 1.0,
      volume: 1.0,
      category: 'ambient',
    });
    return true;
  } catch (e) {
    return false;
  }
}

// What the phone should say when the server voice is unavailable. The fixed
// phrases have server-side wording; these are their local equivalents.
const LOCAL_PHRASES = {
  wake: 'Yes?',
  working: 'On it.',
  done: 'Done.',
  unheard: "Didn't catch that.",
  offline: "Can't reach the server.",
};

// The one entry point. `what` is either {phrase:'wake'} for an instant cached
// line, or {text, agent} for a real answer.
// Whether the server can synthesise at all. Remembered so a server that has
// not been updated yet produces ONE clear message rather than a silent failure
// on every single wake word.
let voiceServerOk = null;   // null = unknown, true/false once tried

// Says it ONCE. A message on every wake word would be its own kind of noise,
// and the cause is always the same: the server cannot synthesise speech. The
// overwhelmingly likely reason is that the server has not been updated yet and
// has no /api/voice routes at all, so the message names that.
function reportVoiceUnavailable() {
  if (voiceServerOk === false) return;
  voiceServerOk = false;
  voiceToast(deviceTtsPlugin()
    ? "Using the phone's own voice — the server has no speech endpoint yet. Update and restart it for the proper voice."
    : 'I heard you, but I have no voice — the server has no speech endpoint yet.');
}

async function speak(what) {
  vlog('speak()', what);
  if (voiceMuted) { vlog('  muted — nothing said'); return false; }
  try {
    // ── AUDIO FIRST, MIC SECOND ─────────────────────────────────────────
    // Apsara: "listening is switching on and off at recurrent interval. also
    // when i say hey jarvis/scout, no talkback."
    //
    // Those two are the SAME bug. The first version stopped the microphone,
    // then went to fetch the audio, then restarted the microphone in a
    // `finally`. When the fetch failed — an old server with no /api/voice
    // routes, no signal in the yard, anything — the result was a mic that
    // stopped and started on every wake word while never saying a word. The
    // churn WAS the failure, made visible.
    //
    // So nothing is stopped until there is something to play. The mic stays
    // open during the fetch, which is harmless: no audio is coming out of the
    // speaker, so there is nothing for it to hear itself say. The moment the
    // audio is in hand, and only then, SPEAK_START closes the mic.
    let url = null, temporary = false;
    if (what.phrase) {
      // A fixed line — "Yes?" and friends. Kept in memory after the first
      // fetch, so from the second wake word onwards there is no network at
      // all and the acknowledgement is instant. That is the entire point: a
      // pause before "Yes?" reads as "it didn't hear me" and she says it
      // again.
      //
      // Fetched through api() rather than pointed at directly with an <audio>
      // src, because an audio element sends no Authorization header and the
      // request would come back 401 — silently, as a play() failure with no
      // clue why.
      if (!phraseCache[what.phrase]) {
        const blob = await api('/api/voice/phrase/' + encodeURIComponent(what.phrase), { raw: true })
          .catch(() => null);
        if (!blob) {
          vlog('  phrase fetch FAILED — falling back to the phone voice');
          reportVoiceUnavailable();
          // Say it with the phone instead of saying nothing.
          return speakWithMicClosed(LOCAL_PHRASES[what.phrase] || '');
        }
        vlog('  phrase fetched', Math.round(blob.size / 1024) + ' KB');
        phraseCache[what.phrase] = URL.createObjectURL(blob);
      }
      voiceServerOk = true;
      url = phraseCache[what.phrase];
    } else {
      const blob = await api('/api/voice/say', {
        method: 'POST',
        body: JSON.stringify({ text: what.text, agent: what.agent || 'jarvis' }),
        raw: true,
      }).catch(() => null);
      if (!blob) {
        vlog('  say fetch FAILED — falling back to the phone voice');
        reportVoiceUnavailable();
        return speakWithMicClosed(what.text);
      }
      vlog('  audio fetched', Math.round(blob.size / 1024) + ' KB');
      voiceServerOk = true;
      url = URL.createObjectURL(blob);
      temporary = true;
    }

    // Audio in hand. NOW close the mic, and not a moment before.
    speaking = true;
    vmSend('SPEAK_START');
    try {
      const ok = await playAudio(url);
      vlog('  playback ' + (ok ? 'OK' : 'FAILED'));
      return ok;
    } finally {
      if (temporary) { try { URL.revokeObjectURL(url); } catch (e) {} }
      speaking = false;
      // A short settle before the mic reopens, so the tail of the speaker does
      // not land in it. The machine decides whether it reopens at all.
      setTimeout(() => { if (!voiceMuted) vmSend('SPEAK_END'); }, 400);
    }
  } catch (e) {
    // Never leaves the mic shut: SPEAK_START is only reached once audio
    // exists, so an exception before that point has changed nothing.
    vlog('  speak() threw', (e && e.message) || String(e));
    speaking = false;
    return false;
  }
}

const WAKE_PATTERNS = [
  // Rewritten 2026-08-29 after five silent builds and Apsara's "add logs".
  //
  // THE NAME ON ITS OWN NOW COUNTS. Every previous pattern required a greeting
  // in front — "hey jarvis", "ok jarvis" — and a bare "jarvis" matched
  // nothing. That is very likely why the microphone cycled and nothing ever
  // answered: these are PARTIAL results, and Android emits partials word by
  // word as it recognises them, so the very common first partial for "Hey
  // Jarvis" is simply "jarvis". It was thrown away every time.
  //
  // Two tiers, because they carry different false-trigger risk:
  //
  //   STRONG — names nobody says by accident in a scrap yard. Matched alone,
  //   anywhere in the utterance.
  /\bjarvis\b/i,
  /\bjervis\b/i,
  /\bjarvi\b/i,
  /\bjarvix\b/i,
  /\bscout\b/i,
  /\bskout\b/i,

  //   WEAK — real mishearings seen in practice that ARE ordinary words.
  //   "service" and "scott" would fire constantly on their own around a yard,
  //   so they only count with a greeting in front of them.
  /\b(hey|hi|ok|okay|a|yo)\s+(service|services|java'?s|jarvous|harvest|scott|scot)\b/i,
];

function voicePlugin() {
  const cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return null;
  return (cap.Plugins && cap.Plugins.SpeechRecognition) || null;
}

function isWakePhrase(text) {
  return WAKE_PATTERNS.some(re => re.test(String(text || '')));
}

// Strips the wake phrase off the front so "hey jarvis check mail from Joey"
// reaches the brain as "check mail from Joey" — the brain has never seen a
// wake word and shouldn't have to learn one.
// STRIPPING NEEDS ITS OWN PATTERNS, not the matching ones.
//
// Caught by tests/yard-clients.js the moment the bare name was allowed to
// wake: reusing WAKE_PATTERNS to strip left the greeting behind, because the
// pattern that matches is now just \bjarvis\b. "Hey Jarvis check mail from
// Joey" came out as "Hey check mail from Joey" and went to the brain like
// that. Matching and removing are different jobs — the matcher should be as
// permissive as possible, the stripper as thorough as possible.
const WAKE_STRIP = [
  /\b(hey|hi|ok|okay|yo|a)?\s*(jarvis|jervis|jarvi|jarvix|scout|skout)\b[\s,:.!-]*/ig,
  /\b(hey|hi|ok|okay|yo|a)\s+(services?|java'?s|jarvous|harvest|scott|scot)\b[\s,:.!-]*/ig,
];

// ── the phrase arrives in PIECES ──────────────────────────────────────────
// From Apsara's log, 2026-08-29:
//
//   28:54.475  heard [wake]  [""]
//   28:55.207  heard [wake]  ["hey"]
//   28:55.209    no wake match in any alternative
//
// The recognition session ended after "hey". The name never arrived in that
// session at all, so no amount of pattern-matching a single partial could ever
// have matched — the text simply was not there. In COMMAND mode the same
// phrase came back whole ("hey Jarvis"), because that mode waits for the end
// of the utterance; the wake loop reads partials from a session Android keeps
// cutting short.
//
// So the wake word is matched against a ROLLING WINDOW of what has been heard
// recently, not against one partial. "hey" from one session and "jarvis" from
// the next join into "hey jarvis" and match. This is the standard shape for
// wake detection on top of a restart loop, and it is the only thing that can
// work when the recogniser will not keep a session open.
// 12 seconds, not 6. Her log shows the wake session dying after "hey" every
// time, with the name arriving in a LATER session or not at all — so the
// window has to outlive several restart cycles for the two halves of "hey
// scout" to meet. The cost of a longer window is a slightly wider chance of a
// stray match; the cost of a shorter one is a wake word that never fires,
// which is what she has had for ten builds.
const HEARD_WINDOW_MS = 12000;
let heardWindow = [];

function noteHeard(text) {
  const now = Date.now();
  const t = String(text || '').trim();
  if (t) heardWindow.push({ at: now, text: t });
  heardWindow = heardWindow.filter((x) => now - x.at < HEARD_WINDOW_MS);
  return heardWindow.map((x) => x.text).join(' ');
}

// Cleared the moment the wake word fires, so one "hey jarvis" cannot keep
// re-triggering off the tail of the window.
function clearHeardWindow() { heardWindow = []; }

function stripWake(text) {
  let t = String(text || '');
  for (const re of WAKE_STRIP) t = t.replace(re, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

// Decides whether a set of recogniser alternatives contains the wake word,
// and acts on it. Shared by the final result and by any partials that do
// arrive, so there is one wake rule rather than two.
function handleWakeCandidates(all) {
  // Each alternative on its own, then the rolling window. The window catches a
  // phrase Android split across two sessions, which its partials do routinely.
  let matched = all.find((m) => isWakePhrase(m));
  let viaWindow = false;
  if (!matched) {
    const win = noteHeard(all[0] || '');
    if (isWakePhrase(win)) { matched = win; viaWindow = true; }
  }
  if (!matched) {
    vlog('  no wake match', { alternatives: all, window: heardWindow.map((x) => x.text).join(' ') });
    return;
  }
  vlog('  WAKE MATCHED' + (viaWindow ? ' (across sessions)' : ''), matched);
  clearHeardWindow();

  const rest = stripWake(matched);
  // SPEAK FIRST, THEN LISTEN. Firing the acknowledgement and the capture
  // together reopened the microphone while "Yes?" was still playing.
  //
  // A SCRAP LEFT OVER IS NOT A COMMAND — "hey service is" leaves "is", which
  // is recogniser noise, not an instruction. Found by the end-to-end
  // simulation in tests/voice-e2e.js.
  if (rest && rest.length >= 3) {
    captureCommand(rest);
    // "Hey Scout, how much do we owe" is one breath and one question. Opening
    // the sheet and then waiting for a second recognition session — or for her
    // to tap Send — is the difference between an assistant and a form.
    // Anything that could ACT still waits; see looksLikeSafeQuestion().
    // A question rides straight through; anything that can act is read back
    // for a spoken yes first. Same rule as a tapped capture — one place would
    // be better still, but captureCommand seeds the box asynchronously.
    if (looksLikeSafeQuestion(rest)) {
      vlog('wake carried a question — asking it straight away', rest);
      setTimeout(() => sendVoiceCommand(), 60);
    } else {
      vlog('wake carried an instruction — confirming by voice', rest);
      pendingConfirm = rest;
      setTimeout(() => {
        setVoiceSheetState('working', 'Say yes to confirm.');
        speak({ text: confirmationLine(rest), agent: 'jarvis' })
          .then(() => captureCommand(''), () => captureCommand(''));
      }, 60);
    }
    return;
  }
  speak({ phrase: 'wake' }).then(() => captureCommand(''), () => captureCommand(''));
}

// ── Wake-word loop ────────────────────────────────────────────────────────
// Android's SpeechRecognizer is NOT continuous — it stops on silence, every
// time. "Always listening" is therefore a restart loop, which is why this
// only runs while the app is in the foreground and why there's a switch to
// turn it off. A phone in a pocket with the mic cycling all day is a battery
// complaint waiting to happen.
async function startWakeLoop() {
  // Belt and braces on the admin gate: the button is hidden for everyone else,
  // but the loop can also be reached from the state machine's START_MIC
  // effect, and a hidden button is not a permission check.
  if (!voiceAllowed()) return;
  // ── REPLACED, NOT SUPPLEMENTED ────────────────────────────────────────
  // When Porcupine is configured this loop must not run at all. Two engines
  // on one microphone is not a fallback, it is a fight — and this particular
  // loop has eleven builds of evidence that it does not work. It stays only
  // for the case where no Picovoice key has been entered yet.
  if (usingPorcupine()) { vlog('wake loop suppressed — Porcupine is running'); return; }
  const SR = voicePlugin();
  // EVERY failure below says something. Apsara: "after opening app, when i say
  // hey jarvis, it is not doing anything" — and three of these four paths used
  // to return in total silence, which is why a dead feature was indistinguishable
  // from a feature that had not heard her. A bare `return` here is the bug.
  if (!SR) {
    voiceToast(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()
      ? 'This device has no speech recogniser — "Hey Jarvis" cannot run here.'
      : 'Voice only works in the installed app, not a browser tab.');
    return;
  }
  if (voiceOn) return;                     // already listening; not a failure
  try {
    const avail = await SR.available();
    if (!(avail && (avail.available ?? avail))) {
      voiceToast('No speech recogniser available on this phone — some Android builds ship without one.');
      return;
    }
    const perm = await SR.requestPermissions();
    if (perm && perm.speechRecognition === 'denied') {
      // The most likely real cause of silence on a phone that has run this
      // before: permission was refused once and Android never asks again.
      voiceToast('Microphone permission is denied. Android Settings → Apps → Edge Yard → Permissions → Microphone.');
      return;
    }
  } catch (e) {
    voiceToast('Could not start listening: ' + ((e && e.message) || 'unknown error'));
    return;
  }
  voiceOn = true;
  vlog('wake loop STARTED');
  renderVoiceButton();
  // ONCE per app session. Android's recogniser is not continuous — it stops on
  // silence and is restarted, constantly — so a toast here fired on every
  // restart and read as the feature switching itself on and off. The icon in
  // the header is the live indicator; this is just the first confirmation.
  if (!window.__saidListening) {
    window.__saidListening = true;
    voiceToast('Listening for "Hey Jarvis" or "Hey Scout".');
  }
  wakeCycle();
}

function stopWakeLoop() {
  voiceOn = false;
  const SR = voicePlugin();
  try { SR && SR.stop(); } catch (e) {}
  if (voiceWatchdog) { clearTimeout(voiceWatchdog); voiceWatchdog = null; }
  renderVoiceButton();
}

async function wakeCycle() {
  const SR = voicePlugin();
  if (!SR || !voiceOn || voiceListening) return;
  voiceMode = 'wake';
  voiceListening = true;

  // ── THE WATCHDOG IS ARMED FIRST, BEFORE ANYTHING CAN BLOCK ──────────────
  // v3.5 awaited SR.start() and only armed the watchdog afterwards. Apsara's
  // log shows the consequence exactly:
  //
  //   44:11.502  wake loop STARTED
  //   ...and then not one "final [wake]" line, ever...
  //
  // start() never resolved, so the line after it never ran, so the watchdog
  // was never set, so nothing ever restarted the loop. The wake word was dead
  // from the moment it started. A hang I introduced while fixing something
  // else — and the reason a watchdog must never sit downstream of the thing it
  // is supposed to be watching.
  const armWatchdog = () => {
    if (voiceWatchdog) clearTimeout(voiceWatchdog);
    voiceWatchdog = setTimeout(() => {
      voiceListening = false;
      if (voiceOn && voiceMode === 'wake') { vlog('watchdog restarting the wake loop'); wakeCycle(); }
    }, 4000);
  };
  armWatchdog();

  // ── partialResults: TRUE ────────────────────────────────────────────────
  // Reverted from v3.5's partialResults:false. The reasoning for that change
  // was sound — Android omits the last word from partials — but her device
  // then produced no result at all, because start() does not resolve here.
  //
  // Her own logs settle which is real: in COMMAND mode, with partials on, the
  // full phrase DID arrive —
  //
  //   44:53.992  heard [command]  ["hey scout","he scout","scout"]
  //
  // So partials work on this phone and do carry the whole phrase. What they
  // sometimes do is split it across sessions, which is what the rolling window
  // in handleWakeCandidates() is for. Observed behaviour beats documented
  // behaviour when the two disagree.
  //
  // NOT AWAITED. Whether start() resolves, rejects, or hangs forever, the
  // watchdog above is already running and the loop cannot die.
  Promise.resolve()
    .then(() => SR.start({ language: 'en-US', maxResults: 5, prompt: '', partialResults: true, popup: false }))
    .then((res) => {
      // Some plugin versions resolve with the final matches even with
      // partials on. Free extra signal when it happens; harmless when not.
      const finals = (res && res.matches) || [];
      if (finals.length) { vlog('final [wake]', finals); handleWakeCandidates(finals); }
    })
    .catch((e) => {
      // Busy/again errors are routine on a restart loop. Logged, not fatal —
      // the watchdog restarts regardless.
      vlog('wake start failed', (e && e.message) || String(e));
      voiceListening = false;
    });
}


// ── One-shot command capture ──────────────────────────────────────────────
// Used both by the mic button and by the wake word once it fires. Longer
// maxResults and no wake matching — everything heard is the command.
async function captureCommand(seedText) {
  // THE SHEET OPENS FIRST, BEFORE ANY PLUGIN CALL. Apsara, 2026-08-24: "when i
  // click mike button, nothing happening in app."
  //
  // The first version did plugin work before showing anything: it returned
  // early with only a toast when the plugin was missing, and it awaited
  // SR.stop() — which on Android can hang when nothing is listening — before
  // opening the sheet. Either path produced a button that visibly did nothing,
  // which is the worst possible failure: no error, no feedback, nothing to
  // report. Whatever else breaks now, the sheet appears and says why.
  voiceMode = 'command';
  // Through the machine. captureCommand used to open the recogniser directly,
  // which left the one place in the app that can open a microphone outside the
  // rule that governs microphones — and the exhaustive tests could not see it.
  vmSend('CAPTURE_START');
  openVoiceSheet(seedText || '');

  const SR = voicePlugin();
  if (!SR) {
    setVoiceSheetState('error', window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()
      ? 'Speech recognition is not available on this device. Type the command instead.'
      : 'Voice only works in the installed app, not a browser tab. Type the command instead.');
    return;
  }

  if (voiceWatchdog) { clearTimeout(voiceWatchdog); voiceWatchdog = null; }
  // Bounded: a stop() that never settles must not strand the capture. 1.5s is
  // far longer than a real stop takes and short enough not to be felt.
  try {
    await Promise.race([SR.stop().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
  } catch (e) { /* already stopped */ }
  voiceListening = false;

  try {
    const avail = await SR.available().catch(() => null);
    if (avail && (avail.available === false)) {
      setVoiceSheetState('error', 'No speech recogniser on this device — some Android builds ship without one. Type the command instead.');
      return;
    }
    const perm = await SR.requestPermissions();
    if (perm && perm.speechRecognition === 'denied') {
      setVoiceSheetState('error', 'Microphone permission denied. Allow it in Android Settings > Apps > Edge Yard > Permissions.');
      return;
    }
    voiceListening = true;
    setVoiceSheetState('listening', 'Listening…');
    await SR.start({ language: 'en-US', maxResults: 5, prompt: '', partialResults: true, popup: false });
  } catch (e) {
    voiceListening = false;
    setVoiceSheetState('error', (e && e.message) || "couldn't start listening — type the command instead");
  }
}

// ── Plugin listeners ──────────────────────────────────────────────────────
// Registered once at boot, not per capture — the plugin appends listeners,
// so wiring them inside captureCommand() would stack a new copy every tap and
// fire the handler N times on the Nth use.
function wireVoiceListeners() {
  const SR = voicePlugin();
  if (!SR || SR.__jarvisWired) return;
  SR.__jarvisWired = true;

  SR.addListener('partialResults', (data) => {
    const all = (data && data.matches) || [];
    const heard = all[0] || '';
    // EVERY alternative, not just the best one. Android returns several
    // guesses and the wake phrase is often in the second or third — if
    // "Hey Jarvis" is arriving as "hey service" this is the line that proves
    // it, and no amount of reasoning from outside the phone could.
    vlog('heard [' + voiceMode + ']', all.length ? all : '(nothing)');
    if (!heard) return;
    // Belt and braces on top of stopping the mic in speak(): if any audio is
    // playing, whatever the mic reports is very likely the phone hearing
    // itself. An answer containing the word "Jarvis" would otherwise re-fire
    // the wake word and loop the app against its own voice.
    if (speaking) return;
    if (voiceMode === 'wake') {
      // ONE wake rule, in handleWakeCandidates(). This branch used to carry
      // its own copy of the matching, stripping and acknowledgement logic,
      // which meant two places to keep in step — the same duplication that
      // has caused three separate bugs in this feature already.
      //
      // Partials rarely carry the whole phrase (Android omits the last word
      // from them), so the authoritative path is the FINAL result in
      // wakeCycle. This remains as a fast path for when a partial does happen
      // to contain enough.
      handleWakeCandidates(all);
      return;
    }
    if (voiceMode === 'command') {
      // ── a yes or no answers immediately ─────────────────────────────────
      // Waiting for the recognition session to END before acting on "yes"
      // makes her wait a second for nothing, and depends on a listeningState
      // event that this plugin does not reliably emit — the same class of
      // assumption that left the wake loop hanging in v3.5. A clear yes or no
      // needs no more context than itself.
      if (pendingConfirm) {
        const answer = all.find((m) => SAID_YES.test(m) || SAID_NO.test(m));
        if (answer) { answerConfirmation(answer); return; }
      }
      const box = $('voiceText');
      // Don't fight the user: once they start correcting the transcript by
      // hand, stop overwriting it from the mic.
      if (box && !box.dataset.edited) box.value = stripWake(all[0] || heard);
      setVoiceSheetState('listening', 'Listening…');
      // ── FINISH FROM THE PARTIALS ────────────────────────────────────────
      // Her log, 2026-08-29:
      //
      //   18:17.396  heard [command]  ["hey"]
      //   18:17.399  heard [command]  ["hey","he","hey scout","hey SCO"]
      //   ...and nothing. No send, no speech, no confirmation.
      //
      // It heard her perfectly. What never arrived was the listeningState
      // 'stopped' event that the ENTIRE command path hung off — and her logs
      // have never once shown that event firing on this device.
      //
      // So completion is now decided from the partials themselves: when the
      // transcript stops changing for a moment, the utterance is over. The
      // listeningState handler still calls the same function when it does
      // fire, and finishCommand() is idempotent, so whichever arrives first
      // wins and the other is a no-op.
      //
      // This is the third time an assumption about a plugin event has cost a
      // build. Nothing load-bearing may depend on an event this plugin has not
      // been OBSERVED to emit.
      scheduleCommandFinish();
    }
  });

  SR.addListener('listeningState', (state) => {
    const status = (state && (state.status || state.state)) || state;
    if (status !== 'stopped') return;
    voiceListening = false;
    if (voiceMode === 'wake' && voiceOn) { wakeCycle(); return; }
    if (voiceMode === 'command') {
      // ── DO NOT FINISH HERE. GIVE THE LATE WORDS A CHANCE. ───────────────
      // Her log, v4.0:
      //
      //   28:33.417  heard [command]  ["hey"]
      //   28:33.639  command finished (recogniser stopped)  hey
      //   28:33.748  heard [command]  ["hey scout","he scout", ...]
      //
      // listeningState fires 222ms after the first partial, and the actual
      // words arrive 109ms AFTER that. Finishing on the event therefore
      // finishes with "hey" every single time and throws the name away — which
      // is exactly what she reported: "only hey detected most of the times".
      //
      // I had this backwards last round: I concluded the event never fires
      // here. It fires, and it fires too early. The recogniser is still
      // transcribing when it says it has stopped.
      //
      // So the event only ARMS the debounce; the debounce decides. Late
      // partials land inside the window and push it out, so the transcript
      // used is the last one she actually said.
      vlog('recogniser stopped — waiting for late words');
      scheduleCommandFinish(700);
    }
  });
}

// ── Review sheet ──────────────────────────────────────────────────────────
function openVoiceSheet(seed) {
  const el = $('voiceSheet');
  if (!el) return;
  el.classList.remove('hidden');
  const box = $('voiceText');
  box.value = seed || '';
  delete box.dataset.edited;
  $('voiceReplies').innerHTML = '';
  setVoiceSheetState(seed ? 'ready' : 'listening', seed ? 'Check it, then send.' : 'Listening…');
}

function closeVoiceSheet() {
  const el = $('voiceSheet');
  if (el) el.classList.add('hidden');
  const SR = voicePlugin();
  try { SR && SR.stop(); } catch (e) {}
  voiceListening = false;
  voiceMode = null;
  // The machine decides whether the wake loop resumes — it is the thing that
  // knows whether she had it on. `if (voiceOn)` was a second, independent copy
  // of that knowledge, and two copies of a rule is one rule and one bug.
  endCapture();
  if (voiceOn) setTimeout(wakeCycle, 400);
}

function setVoiceSheetState(state, msg) {
  const s = $('voiceState');
  if (!s) return;
  const color = state === 'error' ? 'var(--status-danger)'
    : state === 'listening' ? 'var(--accent)'
    : state === 'empty' ? 'var(--status-warning)' : 'var(--text-muted)';
  s.style.color = color;
  s.innerHTML = (state === 'listening' ? '<span class="wt-spin" style="margin-right:7px;"></span>' : '') + esc(msg || '');
  const send = $('btnVoiceSend');
  if (send) send.disabled = state === 'listening';
}

// Runs the command through the same brain a WhatsApp message goes through.
async function sendVoiceCommand() {
  const box = $('voiceText');
  const text = (box.value || '').trim();
  if (!text) return;
  const SR = voicePlugin();
  try { SR && SR.stop(); } catch (e) {}
  voiceListening = false;
  const btn = $('btnVoiceSend');
  btn.disabled = true; btn.textContent = 'Working…';
  setVoiceSheetState('working', 'Jarvis is working on it…');
  try {
    // /api/voice/ask, not /api/bot/command — per Apsara 2026-08-29, a yard
    // question goes to Scout rather than to the brain that books loads and
    // sends WhatsApp. The server decides which; see helpers/voiceRouter.js.
    const r = await api('/api/voice/ask', { method: 'POST', body: JSON.stringify({ text }) });
    const who = (r && r.agent_name) || 'Jarvis';
    const replies = (r && r.replies) || (r && r.answer ? [r.answer] : []);

    // TEXT FIRST, ALWAYS. Synthesis is 3-10 seconds (measured, not guessed),
    // and the answer must be readable the instant it arrives. The voice
    // catches up; it is never the thing being waited on.
    $('voiceReplies').innerHTML = replies.length
      ? `<div style="margin-top:10px; font-size:11px; letter-spacing:.05em; text-transform:uppercase; color:var(--text-muted);">${esc(who)}</div>`
        + replies.map(t => `<div style="margin-top:6px; padding:11px 13px; background:var(--surface-sunken); border-radius:var(--radius-sm); font-size:13px; color:var(--text-strong); white-space:pre-wrap; line-height:1.5;">${esc(t)}</div>`).join('')
      : `<div style="margin-top:10px; font-size:12.5px; color:var(--text-muted);">${esc(who)} did that, but had nothing to say back.</div>`;
    setVoiceSheetState('done', 'Done.');

    // Then speak it, in that agent's own voice.
    if (r && r.answer) speak({ text: r.answer, agent: r.agent || 'jarvis' });
  } catch (err) {
    setVoiceSheetState('error', err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Send to Jarvis';
  }
}

// Is this safe to send without her tapping Send?
//
// Mirrors the FREIGHT_ACTIONS / YARD_WORDS split in helpers/voiceRouter.js,
// which is the thing that actually decides who answers. This is the cautious
// client-side half: it only has to be sure enough to skip a tap, and the
// server still routes properly. When in doubt it returns false and she taps.
//
// The asymmetry is the whole design: a needless tap costs a second; an
// auto-sent instruction to the brain can message a supplier.
const ACTS_ON_THE_WORLD = /\b(message|text|whatsapp|whats app|email|e-?mail|mail|call|ping|reply|respond|forward|send|book|booking|dispatch|schedule|arrange|chase|delete|remove|cancel|pay now|transfer)\b/i;
const IS_A_QUESTION = /(^|\s)(how|what|which|who|whose|when|where|why|is|are|was|were|do|does|did|can|could|should|has|have|any|show|tell|list)\b|\?\s*$/i;

function looksLikeSafeQuestion(text) {
  const t = String(text || '').trim();
  if (t.length < 3) return false;
  if (ACTS_ON_THE_WORLD.test(t)) return false;
  return IS_A_QUESTION.test(t);
}

// ── spoken confirmation ───────────────────────────────────────────────────
// Apsara: "just get voice confirmation".
//
// The resolution of a real tension. Auto-sending everything is fast and
// hands-free, which is what a yard needs — and it means a mistranscribed
// "message the trucker" reaches a real person with no chance to catch it. Her
// own log shows this recogniser turning "hey scout" into "hiskout". Requiring a
// TAP would remove the risk and the point both: an assistant you have to stop
// and touch is a form.
//
// So the confirmation is SPOKEN. Jarvis reads the instruction back and waits
// for a yes. Hands stay free, and nothing that acts on the world happens
// without her hearing exactly what it is first.
//
// QUESTIONS ARE NOT CONFIRMED. "How much do we owe" reaches Scout, which can
// only read; asking "shall I?" before answering a question would be absurd.
// Only things that can act are read back.
let pendingConfirm = null;      // the instruction awaiting a yes

// Generous on both, because this is the last gate before something real
// happens. Anything that is NOT clearly a yes is treated as a no: a misheard
// "yes" sends a real message, a misheard "no" costs her saying it again.
const SAID_YES = /^\s*(yes|yeah|yep|yup|ya|sure|ok|okay|do it|go ahead|send it|confirm|confirmed|correct|right|please do|affirmative)\b/i;
const SAID_NO = /^\s*(no|nope|nah|cancel|stop|don'?t|do not|wait|forget it|never mind|nevermind|negative)\b/i;

// ── completing a spoken command ───────────────────────────────────────────
// Debounced off the partials. 1.2s of no new words means she has stopped
// talking — long enough not to cut her off mid-sentence, short enough not to
// feel like a wait.
let commandFinishTimer = null;
let commandFinished = false;

// `ms` is how long to wait for more words. Longer while she may still be
// talking, shorter once the recogniser claims to have stopped — but never
// zero, because on this device the words arrive AFTER that claim.
function scheduleCommandFinish(ms) {
  commandFinished = false;
  if (commandFinishTimer) clearTimeout(commandFinishTimer);
  commandFinishTimer = setTimeout(() => finishCommand('no more words'), ms || 1200);
}

function cancelCommandFinish() {
  if (commandFinishTimer) { clearTimeout(commandFinishTimer); commandFinishTimer = null; }
}

// Idempotent on purpose: the debounce and the listeningState event both call
// it, and only the first should act.
function finishCommand(why) {
  if (commandFinished) return;
  if (voiceMode !== 'command') return;
  commandFinished = true;
  cancelCommandFinish();

  const box = $('voiceText');
  const text = (box && box.value.trim()) || '';
  vlog('command finished (' + why + ')', text || '(nothing)');
  if (!text) {
    setVoiceSheetState('empty', "Didn't catch that — tap the mic to try again, or type it.");
    return;
  }
  if (pendingConfirm) { answerConfirmation(text); return; }
  if (looksLikeSafeQuestion(text)) {
    vlog('auto-sending a question', text);
    setVoiceSheetState('working', 'Asking…');
    sendVoiceCommand();
    return;
  }
  vlog('asking for spoken confirmation', text);
  pendingConfirm = text;
  setVoiceSheetState('working', 'Say yes to confirm.');
  speak({ text: confirmationLine(text), agent: 'jarvis' })
    .then(() => captureCommand(''), () => captureCommand(''));
}

// Resolves a pending "Shall I?". One function, called from the partial
// listener and from the end of a capture, so a yes means the same thing
// whichever arrives first.
function answerConfirmation(text) {
  const instruction = pendingConfirm;
  pendingConfirm = null;
  if (!instruction) return;
  if (SAID_YES.test(text)) {
    vlog('confirmed by voice', instruction);
    const box = $('voiceText');
    if (box) { box.value = instruction; delete box.dataset.edited; }
    setVoiceSheetState('working', 'Doing that now…');
    sendVoiceCommand();
    return;
  }
  // Anything that is not clearly a yes is a no.
  vlog(SAID_NO.test(text) ? 'declined by voice' : 'not a clear yes — treating as no', text);
  const box = $('voiceText');
  if (box) box.value = '';
  setVoiceSheetState('empty', 'Cancelled.');
  speak({ text: 'Cancelled.', agent: 'jarvis' });
}

// The instruction read back as a question.
function confirmationLine(text) {
  return String(text || '').trim().replace(/[.?!]+$/, '') + '. Shall I?';
}

function voiceToast(msg) { showWeighToast('flagged', msg, '', 4000); }

// Tells the machine the capture is over, so it can put the wake loop back the
// way she had it. Called wherever the sheet closes.
function endCapture() { try { vmSend('CAPTURE_END'); } catch (e) {} }

// Mic button in the header. Tap = one command. Long-press = toggle the wake
// word, so "always listening" is a deliberate choice rather than something
// that silently switched itself on.
function renderVoiceButton() {
  const b = $('btnVoice');
  if (!b) return;
  if (!voiceAllowed()) { b.classList.add('hidden'); return; }
  b.classList.remove('hidden');
  const listening = voiceOn || porcupineOn;
  b.textContent = listening ? '🎙' : '🎤';
  b.title = listening ? 'Listening for "Jarvis" — long-press to stop' : 'Tap to speak a command · long-press to listen';
  b.style.borderColor = listening ? 'var(--accent)' : 'var(--steel-700)';
  b.style.color = listening ? 'var(--accent)' : 'var(--steel-300)';
}

// ── voice is ADMIN ONLY for now ───────────────────────────────────────────
// Per Apsara 2026-08-29: "for admin user only as of now".
//
// One function, consulted everywhere, because a capability gate that is
// spelled out in three places is a capability gate with two ways around it.
// It matters more here than most: the wake word feeds workflow/brain.js, which
// messages truckers and suppliers for real, and an always-on microphone in a
// shared yard phone is not something to hand out by default.
//
// The staff role is already blocked server-side from /api/voice/* by the
// prefix allowlist in api.js; this is the client half, so the button is not
// even shown to someone who cannot use it.
// ── voice switched OFF at the front door ──────────────────────────────────
// Per Apsara 2026-09-01: "remove the audio option in app" — clarified as
// "the mic button — hide it for now".
//
// This is ONE boolean, not a deletion. Every line of the voice work is still
// here: the state machine, the Porcupine plugin, the Gemini TTS route, the
// tests. Flipping this back to true restores all of it. Deleting it would
// throw away a day of native plugin work to satisfy a "for now".
//
// It gates MORE than the button, deliberately. Hiding the button while
// leaving the wake word armed would be the worst of both: the microphone
// still opens on app start, but the only visible indicator that it is
// listening — and the long-press that turns it off — are both gone. An
// invisible hot mic in a shared yard phone is not "hidden", it is a
// liability. So the flag turns the whole capability off, and the UI with it.
const VOICE_UI_ENABLED = false;

function voiceAllowed() { return VOICE_UI_ENABLED && ROLE === 'admin'; }

function wireVoiceUI() {
  const b = $('btnVoice');
  if (!b || b.dataset.wired) return;
  if (!voiceAllowed()) { b.classList.add('hidden'); return; }
  b.dataset.wired = '1';
  // TOUCH AND MOUSE ARE THE SAME GESTURE, and Android fires both: a real tap
  // sends touchstart/touchend and THEN synthetic mousedown/mouseup. The first
  // version listened to all four, so one tap ran the handler twice — opening
  // the capture, then immediately opening it again — and the synthetic
  // mousedown started a second long-press timer that could toggle the wake
  // loop on its own about half a second later.
  //
  // usedTouch latches on the first touch event and makes the mouse pair a
  // no-op from then on, which is the standard fix and survives a device that
  // reports both.
  let held = false, timer = null, usedTouch = false, handledAt = 0;
  const startHold = () => {
    held = false;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      held = true;
      timer = null;
      // Through the machine, so the setting is persisted and the same rule
      // decides the mic here as everywhere else.
      vmSend('USER_TOGGLE');
      if (vmState && vmState.enabled) {
        if (usingPorcupine()) startPorcupine();
        else voiceToast('Listening for "Hey Jarvis" or "Hey Scout" while the app is open.');
      } else {
        stopPorcupine();
        voiceToast('Stopped listening.');
      }
    }, 550);
  };
  const endHold = (ev) => {
    if (timer) { clearTimeout(timer); timer = null; }
    handledAt = Date.now(); // so the trailing click knows this gesture is done
    if (held) { held = false; if (ev && ev.preventDefault) ev.preventDefault(); return; }
    captureCommand('');
  };
  b.addEventListener('touchstart', () => { usedTouch = true; startHold(); }, { passive: true });
  b.addEventListener('touchend', (ev) => { ev.preventDefault(); endHold(ev); });
  b.addEventListener('mousedown', () => { if (!usedTouch) startHold(); });
  b.addEventListener('mouseup', (ev) => { if (!usedTouch) endHold(ev); });
  // Last resort: if a device delivers NEITHER pair, a plain click still opens
  // the capture rather than the button doing nothing at all.
  //
  // handledAt, not the sheet's visibility, decides whether this is a duplicate.
  // A desktop click fires mouseup AND click, so this ran twice; keying off
  // "is the sheet already open" happened to mask that, but it made a correct
  // gesture depend on DOM state set by an async function. A timestamp is
  // deterministic and does not care what the UI has managed to render yet.
  b.addEventListener('click', (ev) => {
    if (timer || held) return;
    if (Date.now() - handledAt < 700) return; // the touch/mouse pair already handled it
    ev.preventDefault();
    captureCommand('');
  });

  $('btnVoiceClose').addEventListener('click', closeVoiceSheet);
  $('btnVoiceSend').addEventListener('click', sendVoiceCommand);
  $('btnVoiceRetry').addEventListener('click', () => captureCommand(''));
  $('btnVoiceDiag').addEventListener('click', runVoiceDiagnostic);

  // ── the wake word key ───────────────────────────────────────────────────
  (function wireWakeKey() {
    const row = $('wakeKeyRow');
    if (!row) return;
    // Only meaningful in the installed app — the plugin does not exist in a
    // browser tab, and offering a key field that can do nothing is worse than
    // not offering it.
    if (!wakePlugin()) { row.classList.add('hidden'); return; }
    const input = $('wakeKeyInput');
    const state = $('wakeKeyState');
    const msg = $('wakeKeyMsg');
    const shown = () => {
      const k = porcupineKey();
      // Never render the whole key back: it is a credential, and a shoulder
      // over the phone in a yard is the normal case, not the exception.
      input.value = '';
      input.placeholder = k ? ('saved ••••' + k.slice(-4)) : 'Picovoice AccessKey';
      state.textContent = porcupineOn ? '— running' : (k ? '— saved, not started' : '— not set');
      state.style.color = porcupineOn ? 'var(--accent)' : 'var(--text-muted)';
    };
    shown();
    $('btnSaveWakeKey').addEventListener('click', async () => {
      const v = (input.value || '').trim();
      if (!v) { msg.textContent = 'Paste the AccessKey from console.picovoice.ai first.'; return; }
      setPorcupineKey(v);
      msg.textContent = 'Starting…';
      await stopPorcupine();
      const ok = await startPorcupine();
      msg.textContent = ok
        ? 'Running. Say "Jarvis".'
        : 'Did not start — see the message above, or Show log.';
      shown();
    });
  })();
  $('btnVoiceLog').addEventListener('click', () => {
    const el = $('voiceLog'); const copy = $('btnVoiceLogCopy');
    const showing = !el.classList.contains('hidden');
    el.classList.toggle('hidden', showing);
    copy.classList.toggle('hidden', showing);
    $('btnVoiceLog').textContent = showing ? 'Show log' : 'Hide log';
    if (!showing) {
      el.textContent = vlogLines.length ? vlogLines.join('\n') : '(nothing logged yet — say "Hey Jarvis" with this open)';
      el.scrollTop = el.scrollHeight;
    }
  });
  $('btnVoiceLogCopy').addEventListener('click', async () => {
    const text = vlogLines.join('\n');
    try {
      // Clipboard first; a <textarea> + execCommand fallback for the older
      // WebViews where navigator.clipboard is not available over http.
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
      else {
        const ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta);
      }
      voiceToast('Log copied — paste it to me.');
    } catch (e) { voiceToast('Could not copy: ' + ((e && e.message) || 'unknown')); }
  });
  $('voiceText').addEventListener('input', () => { $('voiceText').dataset.edited = '1'; });
  $('voiceText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendVoiceCommand(); }
  });

  wireVoiceListeners();
  renderVoiceButton();

  // START LISTENING. The machine knowing it should be listening is not the
  // same as the microphone being open: something has to dispatch an event so
  // the START_MIC effect fires. Nothing did, so the wake word never began —
  // the second half of why "hey jarvis" did nothing.
  //
  // Sent after wireVoiceListeners() so the partialResults handler exists
  // before the recogniser can deliver anything to it.
  // The real engine first. vmSend's START_MIC effect routes to whichever is
  // in play, so this only has to get it running once.
  wirePorcupine();
  if (usingPorcupine()) { startPorcupine(); }
  vmSend('APP_FOREGROUND');

  // ── the app must not listen while it is off screen ─────────────────────
  // The SETTING survives backgrounding; the MICROPHONE does not. Two sources
  // because neither is reliable alone: Capacitor's appStateChange follows
  // Android's real lifecycle, visibilitychange covers the WebView being
  // hidden without the activity stopping.
  const sendFg = (fg) => { try { vmSend(fg ? 'APP_FOREGROUND' : 'APP_BACKGROUND'); } catch (e) {} };
  try {
    const AppPlugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (AppPlugin && AppPlugin.addListener) AppPlugin.addListener('appStateChange', (st) => sendFg(!!(st && st.isActive)));
  } catch (e) {}
  document.addEventListener('visibilitychange', () => sendFg(document.visibilityState === 'visible'));
}

// ── Boot ──────────────────────────────────────────────────────────────
