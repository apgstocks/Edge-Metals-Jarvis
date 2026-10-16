// mobile-app/www/app/06-capture.js — split from mobile-app/www/index.html's <script> (helpers/sourceParts.js reconstructs the original)
// ── Weight-read status banner ────────────────────────────────────────────
// Per Apsara 2026-08-19: "show to user if processing, then working on it"
// and "if flagged, show user". Three states, deliberately distinct:
//   working — a read is in flight (2-6s); the operator should wait, not tap
//   ok      — both engines agreed, the number is in the field
//   warn    — FLAGGED: the reading is uncertain and must be checked
// The warn state does NOT auto-dismiss. A flagged weight is the one case
// where the operator genuinely has to look at the scale and confirm, so it
// stays until dismissed rather than disappearing while they're still
// walking back to the display.
let weighToastTimer = null;
function showWeighToast(kind, text, sub, autoHideMs) {
  const el = $('weighToast');
  if (!el) return;
  if (weighToastTimer) { clearTimeout(weighToastTimer); weighToastTimer = null; }
  el.className = 'show ' + kind;
  el.innerHTML = `
    <div class="wt-row">${kind === 'working' ? '<span class="wt-spin"></span>' : ''}<span>${esc(text)}</span></div>
    ${sub ? `<div class="wt-sub">${esc(sub)}</div>` : ''}`;
  // Tap to dismiss — needed for the flagged state, which never times out.
  el.onclick = () => { el.className = ''; };
  if (autoHideMs) {
    weighToastTimer = setTimeout(() => { el.className = ''; weighToastTimer = null; }, autoHideMs);
  }
}
function hideWeighToast() {
  const el = $('weighToast');
  if (!el) return;
  if (weighToastTimer) { clearTimeout(weighToastTimer); weighToastTimer = null; }
  el.className = '';
}

// opts.preCropped — set by the guided scanner (see openScanner), which has
// already cropped the frame down to just the display. Passed through to the
// backend so it can skip its own locate stage entirely instead of
// re-searching an image that's already nothing but the display.
async function processWeightImage(row, roleKey, base64, mime, statusEl, opts = {}) {
  const idx = parseInt(row.dataset.idx, 10);

  // Added 2026-08-11: capture-time quality gate, run BEFORE the photo is
  // attached to the item or sent for a real OCR read. Root-cause analysis
  // this session found that the dominant source of wrong weight reads was
  // never the OCR logic — it was a display partially outside the photo
  // frame, whose digits were never captured. No retry logic downstream can
  // recover a digit that was never in the shot. The goal here is an
  // autonomous pipeline with nobody checking the number afterward, so the
  // only honest fix is refusing a bad capture immediately and asking for a
  // retake — same as a barcode scanner refusing a blurry frame — instead of
  // accepting it and hoping OCR recovers it. Fast (~200-500ms, pixel-only,
  // no Gemini call — see checkPhotoQuality's own validation notes in
  // helpers/gemini.js) and fails OPEN on any error, so a network hiccup or
  // a bug in this check can never block a real capture from going through.
  // SKIPPED for a scanner capture (opts.preCropped): this gate exists to
  // catch a display that's partly outside the frame of a wide yard photo,
  // and it works by locating a display-shaped blob and checking whether it
  // touches a frame edge. On a crop that IS the display, the blob touches
  // every edge by construction — the check would reject every good capture.
  // The scanner's alignment box is the equivalent safeguard, applied before
  // the shutter instead of after. Also saves a whole network round trip,
  // which is part of the point of the scanner (see openScanner's comment).
  if (!opts.preCropped) {
  if (statusEl) { statusEl.style.color = ''; statusEl.style.fontWeight = ''; statusEl.textContent = 'Checking photo…'; }
  try {
    const quality = await api('/api/vision/check-photo-quality', {
      method: 'POST',
      body: JSON.stringify({ image_base64: base64, mime_type: mime }),
    });
    if (quality && quality.ok === false) {
      if (statusEl) {
        statusEl.textContent = `⚠ ${quality.message || 'Photo not clear enough — please retake.'}`;
        statusEl.style.color = 'var(--status-danger)';
        statusEl.style.fontWeight = '700';
      }
      showWeighToast('err', 'Photo not clear enough', (quality.message || 'Please retake the photo.') + ' Tap to dismiss.');
      return; // do not attach this photo or spend a real OCR call on it — retake first
    }
  } catch (err) {
    console.warn('[photo-quality-check] failed, proceeding without it:', err.message);
    // fall through to the normal read — never block a capture over this check erroring
  }
  }

  syncItemsFromDom(); // capture whatever's already typed before we mutate a photo onto it
  if (currentLoadItems[idx]) currentLoadItems[idx][roleKey === 'gross' ? 'grossPhoto' : 'tarePhoto'] = { base64, mime };
  if (statusEl) { statusEl.style.color = ''; statusEl.style.fontWeight = ''; statusEl.textContent = 'Reading scale…'; }
  showWeighToast('working', 'Reading the weight…', 'This takes a few seconds — please hold on.');
  try {
    const result = await api('/api/vision/read-weight', {
      method: 'POST',
      // opts.frames — extra frames from the scanner's burst (see
      // doScanCapture). Sent alongside, never instead of, image_base64, so
      // the server keeps treating that as the primary read and an older
      // server that ignores the field behaves exactly as before.
      body: JSON.stringify({
        image_base64: base64,
        mime_type: mime,
        pre_cropped: !!opts.preCropped,
        ...(opts.frames && opts.frames.length ? { frames: opts.frames } : {}),
      }),
    });
    // Full reasoning (raw_text/displays_seen) goes to the console instead of
    // the on-screen status now — useful for debugging a bad read without
    // cluttering the form with a paragraph of model commentary every time.
    console.log('[weight-read]', roleKey, JSON.stringify(result));
    if (result.weight != null) {
      row.querySelector(roleKey === 'gross' ? '.ld-item-gross' : '.ld-item-tare').value = result.weight;
      recomputeRowTotals(row);
      syncItemsFromDom();
      if (statusEl) {
        // result.ambiguous covers TWO distinct cases as of 2026-08-10:
        // (1) no display could be isolated in time and this number came
        // from reading the WHOLE photo, which can contain more than one
        // number (a bench-scale reading, a date, etc.) — no specific
        // alternate number in this case, or (2) a display WAS isolated and
        // read, but Gemini's own independent read of the SAME crop
        // disagreed — in which case result.alternate_weight carries
        // Gemini's actual number, so the message can show BOTH candidates
        // directly instead of a vague "didn't agree," letting the operator
        // resolve it with one glance instead of walking back to the scale.
        // Confirmed live 2026-08-10 on a real photo: Vision hallucinated a
        // blank cell into "82258," Gemini correctly read the same crop as
        // "2251" — Vision is NOT universally more accurate than Gemini
        // across every display type, so this shows both rather than
        // silently trusting Vision's default.
        if (result.ambiguous) {
          if (result.alternate_weight != null) {
            statusEl.textContent = `⚠ TWO DIFFERENT READS — one check says ${result.weight} ${result.weight_unit || ''}, another says ${result.alternate_weight} ${result.weight_unit || ''}. Check the scale and enter the correct value.`;
          } else {
            statusEl.textContent = `⚠ UNSURE — read ${result.weight} ${result.weight_unit || ''}, but a second check didn't confidently agree. Double-check against the scale before saving.`;
          }
          statusEl.style.color = 'var(--status-danger)';
          statusEl.style.fontWeight = '700';
          // FLAGGED — per Apsara 2026-08-19 ("if flagged, show user"). No
          // auto-hide: this is precisely the case where the operator must
          // walk to the display and confirm, so it stays on screen until
          // they tap it away rather than vanishing mid-walk.
          showWeighToast('warn',
            `⚠ CHECK THIS WEIGHT — ${result.weight} ${result.weight_unit || ''}`,
            result.alternate_weight != null
              ? `The two checks disagreed (${result.weight} vs ${result.alternate_weight}). Read the scale and correct it if needed. Tap to dismiss.`
              : 'This reading could not be confirmed. Compare it against the scale before saving. Tap to dismiss.');
        } else {
          statusEl.textContent = `Read: ${result.weight} ${result.weight_unit || ''} — check it matches the scale before saving.`;
          statusEl.style.color = '';
          statusEl.style.fontWeight = '';
          showWeighToast('ok', `Weight read: ${result.weight} ${result.weight_unit || ''}`, 'Both checks agreed. Confirm it matches the scale.', 4000);
        }
      }
    } else {
      if (statusEl) {
        statusEl.style.color = '';
        statusEl.style.fontWeight = '';
        statusEl.textContent = "Couldn't read a number — enter manually.";
      }
      showWeighToast('err', "Couldn't read the weight", 'Type it in by hand, or retake with the display filling the box. Tap to dismiss.');
    }
  } catch (err) {
    if (statusEl) { statusEl.style.color = ''; statusEl.style.fontWeight = ''; statusEl.textContent = 'Read failed: ' + err.message + ' — enter manually.'; }
    showWeighToast('err', 'Weight read failed', err.message + ' — enter the weight manually. Tap to dismiss.');
  }
}

// Changed 2026-08-11: this used to cap long edge at 1600px, on the theory
// that reading a handful of digits off a scale display doesn't need full
// resolution. Tested directly and that theory was wrong — same 3 photos,
// same backend code, only this cap changed: at 1600px the weight-OCR
// pipeline got 0/3 correct (wrong reads: 1150 vs true 71920, 87528 vs true
// 81528, 41516 vs true 28460); at original resolution it got 3/3 correct.
// The 1600px downscale was silently corrupting the exact digits the
// pipeline needs, not just shrinking irrelevant background. So: send
// original resolution now (maxDim effectively unbounded), quality 0.95.
//
// NOTE FOR WHOEVER TOUCHES THIS NEXT: this function is DUPLICATED between
// dashboard/index.html (the browser dashboard, served by express) and this
// file (the Capacitor mobile app, whose HTML is BUNDLED INTO THE APK —
// capacitor.config.json sets webDir "www" with no server.url, so this app
// does NOT load its HTML from the VM). Changing one does nothing to the
// other, and changing this one does nothing on a phone until the APK is
// rebuilt and reinstalled — `git pull` + `pm2 restart` on the VM has zero
// effect on an already-installed app. That exact gap cost hours of
// debugging on 2026-08-11: the dashboard copy was fixed and deployed while
// every mobile test kept running the old 1600px code inside the installed
// APK, producing byte-identical wrong results that looked like the fix had
// failed. Fix BOTH copies, then rebuild the APK.
//
// PayloadTooLargeError (the original reason for the 1600px cap) is handled
// on the backend instead — api.js's PUT /api/loads/:id uses
// express.json({limit:'40mb'}), and realistic full-res phone JPEGs run
// ~1.7-1.9MB. If some device produces originals large enough to hit that
// limit again, raise the backend limit rather than re-adding a client-side
// resolution cap — the cap is the lever that was proven to break accuracy.
function downscaleToBase64(source, srcW, srcH, maxDim = 1e9, quality = 0.95) {
  let w = srcW, h = srcH;
  if (w > maxDim || h > maxDim) {
    const scale = maxDim / Math.max(w, h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(source, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', quality).split(',')[1];
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image file')); };
    img.src = url;
  });
}

// Same as loadImageFromFile above, but for a base64 string (what the native
// Camera plugin below returns) instead of a File object.
function loadImageFromBase64(base64, mime) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read that photo'));
    img.src = `data:${mime};base64,${base64}`;
  });
}

// ── Native camera capture ────────────────────────────────────────────────
// Why this exists: the "Take Photo" button used to just .click() a hidden
// <input type="file" capture="environment">, which works fine in a normal
// mobile BROWSER but is unreliable inside this app's embedded WebView — per
// Apsara, tapping it opened Google Photos instead of the camera even with
// camera permission granted. Root cause: modern Chromium/WebView (roughly
// Chrome 60+) stopped treating the `capture` attribute as "launch the camera
// app directly" — it now just hints the system's file-chooser, which is
// free to default to whatever app it wants (Photos here). This is a known,
// widely-reported WebView limitation, not a permission bug — no manifest or
// prompt fix changes it.
// The reliable fix is to stop going through the file-chooser abstraction
// for the camera path entirely and call Capacitor's own Camera plugin
// (@capacitor/camera) instead, which talks to the native camera directly
// via CameraSource:'CAMERA' — no chooser, no ambiguity about which app
// opens. Falls back to the old file-input behavior if the plugin isn't
// available for any reason (e.g. this same index.html loaded outside the
// native shell) so nothing breaks if that ever happens.
function hasNativeCamera() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform() && window.Capacitor.Plugins && window.Capacitor.Plugins.Camera);
}
async function captureViaNativeCamera(row, roleKey) {
  const statusEl = row.querySelector('.ld-item-status');
  statusEl.textContent = 'Opening camera…';
  try {
    const photo = await window.Capacitor.Plugins.Camera.getPhoto({
      resultType: 'base64',
      source: 'CAMERA',        // forces the camera app directly — 'PROMPT' would show a chooser (the exact ambiguity this is meant to avoid), 'PHOTOS' would go straight to the gallery.
      // Raised 85 -> 95 on 2026-08-11. This is the NATIVE camera plugin's own
      // JPEG compression, applied before any JS in this file ever sees the
      // photo, so downscaleToBase64's quality setting cannot undo it. Measured
      // on 6 photos with confirmed weights, full sensor resolution both times:
      // quality 85 read 5/6 correctly, quality 95 read 6/6 — the one failure
      // at 85 (true 71920, read as 4000) passed cleanly at 95. Seven-segment
      // LED digits are exactly the high-contrast thin-edge content JPEG
      // artifacts damage most, and the OCR then reads those artifacts as
      // different digits. The file-size cost is paid once per photo over the
      // yard's own connection; a misread weight is paid on the ticket.
      quality: 95,
      allowEditing: false,
      saveToGallery: false,
    });
    if (!photo || !photo.base64String) { statusEl.textContent = ''; return; } // user cancelled — not an error
    const mime = `image/${photo.format || 'jpeg'}`;
    const img = await loadImageFromBase64(photo.base64String, mime);
    const base64 = downscaleToBase64(img, img.naturalWidth || img.width, img.naturalHeight || img.height);
    await processWeightImage(row, roleKey, base64, 'image/jpeg', statusEl);
  } catch (err) {
    // err.message is often just "User cancelled photos app" when someone
    // backs out of the camera — that's not a failure worth alarming over.
    if (!/cancel/i.test(err.message || '')) statusEl.textContent = 'Camera failed: ' + err.message + ' — enter manually.';
    else statusEl.textContent = '';
  }
}

// `row` is the specific item-row DOM element this file input lives in —
// scoped per item now, not per load.
async function handleFileUpload(row, roleKey, file) {
  if (!file) return;
  // One shared status line per row now (not per gross/tare) — keeps the row
  // itself a single line; this line only fills in transiently during a read.
  const statusEl = row.querySelector('.ld-item-status');
  statusEl.textContent = 'Preparing photo…';
  try {
    const img = await loadImageFromFile(file);
    const base64 = downscaleToBase64(img, img.naturalWidth || img.width, img.naturalHeight || img.height);
    await processWeightImage(row, roleKey, base64, 'image/jpeg', statusEl);
  } catch (err) {
    statusEl.textContent = err.message;
  }
}

// ── Signature pad ────────────────────────────────────────────────────────
// Per Apsara 2026-08-17. Draws with pointer events (covers touch, stylus
// and mouse in one code path) onto a transparent canvas, then POSTs a PNG
// data URL to /api/loads/:id/signature, which stores it AND regenerates the
// PDFs so the signature actually lands on the ticket + receipt.
// Transparent background is deliberate: the PDF draws this straight over
// its own white page above the signature rule, and a white-filled PNG
// would paint an opaque block over that rule.
let signLoadId = null;
let signDrawing = false;
let signHasInk = false;

function signPoint(ev) {
  const c = $('signPad');
  const r = c.getBoundingClientRect();
  // Map CSS pixels -> canvas backing-store pixels. These differ on any
  // hi-DPI screen (and the canvas is sized to devicePixelRatio below), so
  // skipping this scale would draw the stroke offset from the fingertip.
  return { x: (ev.clientX - r.left) * (c.width / r.width), y: (ev.clientY - r.top) * (c.height / r.height) };
}

function openSignPad(loadId) {
  signLoadId = loadId;
  signHasInk = false;
  $('signErr').textContent = '';
  $('signSave').disabled = false;
  $('signSave').textContent = 'Save signature';
  $('signOverlay').classList.remove('hidden');
  $('signOverlay').style.display = 'flex';
  const c = $('signPad');
  // Size the backing store to the element's real on-screen size x DPR, so
  // the stroke is crisp rather than upscaled-blurry on a phone screen.
  const dpr = window.devicePixelRatio || 1;
  const rect = c.getBoundingClientRect();
  c.width = Math.round(rect.width * dpr);
  c.height = Math.round(rect.height * dpr);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 2.4 * dpr;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

function closeSignPad() {
  $('signOverlay').classList.add('hidden');
  $('signOverlay').style.display = '';
  signLoadId = null;
}

function wireSignPad() {
  const c = $('signPad');
  const ctx = () => c.getContext('2d');
  c.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    signDrawing = true; signHasInk = true;
    c.setPointerCapture(ev.pointerId);
    const p = signPoint(ev);
    ctx().beginPath();
    ctx().moveTo(p.x, p.y);
    // A single tap with no drag should still leave a mark rather than
    // nothing — draw a zero-length line, which lineCap:'round' renders as
    // a dot.
    ctx().lineTo(p.x, p.y);
    ctx().stroke();
  });
  c.addEventListener('pointermove', (ev) => {
    if (!signDrawing) return;
    ev.preventDefault();
    const p = signPoint(ev);
    ctx().lineTo(p.x, p.y);
    ctx().stroke();
  });
  const end = () => { signDrawing = false; };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
  c.addEventListener('pointerleave', end);

  $('signClear').addEventListener('click', () => {
    ctx().clearRect(0, 0, c.width, c.height);
    signHasInk = false;
    $('signErr').textContent = '';
  });
  $('signClose').addEventListener('click', closeSignPad);
  $('signSave').addEventListener('click', async () => {
    if (!signHasInk) { $('signErr').textContent = 'Nothing signed yet — sign in the box first.'; return; }
    if (!signLoadId) return;
    const btn = $('signSave');
    btn.disabled = true; btn.textContent = 'Saving…';
    $('signErr').textContent = '';
    try {
      // Regenerating the PDFs server-side is part of this same call, so it
      // takes a few seconds — hence the explicit "Saving…" state rather
      // than closing optimistically.
      await api(`/api/loads/${encodeURIComponent(signLoadId)}/signature`, {
        method: 'POST',
        body: JSON.stringify({ signature: c.toDataURL('image/png') }),
      });
      closeSignPad();
      loadTab('loads'); // refresh so the regenerated PDF links are picked up
    } catch (err) {
      $('signErr').textContent = 'Could not save: ' + err.message;
      btn.disabled = false; btn.textContent = 'Save signature';
    }
  });
}

// ── Guided scale-display scanner ─────────────────────────────────────────
// Per Apsara 2026-08-17: "i don't want any normal camera settings, i want
// the camera to capture the digital scale weights. to avoid noise, i can
// have bounding box in camera and ask the user to capture the image within
// that box."
//
// This replaces the native-camera path for weight capture. The important
// part is NOT the visual box — it's that the captured frame is CROPPED to
// that box on-device before upload. Two concrete wins over the old
// full-frame photo:
//   1. The server's locate stage (finding the display inside a photo of a
//      whole yard) becomes unnecessary — that stage is the single most
//      expensive and most failure-prone part of the pipeline (the AI
//      fallback alone measures 5.6-9.9s in helpers/gemini.js's own logs).
//      The crop is sent with pre_cropped:true so the backend skips it.
//   2. Upload shrinks from a ~2MB full-res frame to a ~100-250KB crop,
//      which on yard mobile data is seconds of latency by itself.
// Deliberately NOT downscaled: the box crop is taken at the camera's
// native pixel resolution. Shrinking is what broke OCR accuracy before
// (see downscaleToBase64's comment — 0/3 correct at 1600px vs 3/3 at
// native), and cropping is the opposite of that problem: the digits keep
// every pixel they had, they just arrive without the surrounding noise.
//
// BOX GEOMETRY — tightened 2026-08-19 per Apsara ("length of ocr camera is
// large. to avoid unwanted noise and make it efficient, it can be small").
//
// Was 0.86 wide at 3.2:1, sized to hold a whole weighbridge display. On the
// Socome that is too generous, and the extra width is not neutral — it is
// where the noise lives. Testing against her 10-photo corpus showed the
// dominant error source is the two permanently-lit "8.8." placeholder cells
// to the LEFT of the weight: Vision read 883475 for a true 3475 and 983939
// for a true 3939. Those cells are fully lit, not dim, so no brightness or
// saturation filter removes them — they have to be FRAMED OUT, which is
// precisely what a narrower box does.
//
// 0.60 wide at 2.4:1 fits four digits and little else. The aspect follows
// the digits rather than the bezel: a seven-segment digit is roughly 1:1.8,
// so four of them plus gaps is about 2.4 times as wide as it is tall.
// Also cheaper — a smaller crop is fewer pixels to upload, on a yard's
// mobile connection.
const SCAN_BOX = { widthPct: 0.60, aspect: 2.4, maxWidthPx: 440 }; // aspect = w/h
let scanStream = null;
let scanTarget = null; // { row, roleKey }

function layoutScanBox() {
  const wrap = $('scanVideoWrap');
  if (!wrap) return;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (!W || !H) return;
  // Box size is CAPPED in absolute pixels, not purely proportional — per
  // Apsara 2026-08-19 ("when i use ipad/tablet, this camera bounding box use
  // more length").
  //
  // A percentage alone scales with the screen, which is wrong here: the box
  // has to match the apparent size of a scale display held at arm's length,
  // and that doesn't grow just because the device did. At 0.60 the box was
  // ~247px on a phone but ~614px on a tablet — two and a half times larger,
  // so the operator had to stand back far enough that the digits shrank,
  // which is the opposite of what the tight box is for.
  // Capped so a tablet gets a box a similar PHYSICAL size to a phone's, and
  // also bounded by height so a short landscape viewport can't produce a box
  // taller than the screen.
  const bw = Math.min(
      Math.round(W * SCAN_BOX.widthPct),
      SCAN_BOX.maxWidthPx,
      Math.round(H * 0.72 * SCAN_BOX.aspect), // keep bh <= 72% of viewport height
  );
  const bh = Math.round(bw / SCAN_BOX.aspect);
  const bx = Math.round((W - bw) / 2);
  const by = Math.round((H - bh) / 2);
  const box = $('scanBox');
  box.style.left = `${bx}px`; box.style.top = `${by}px`;
  box.style.width = `${bw}px`; box.style.height = `${bh}px`;
  // Dim everything outside the box.
  const set = (el, s) => Object.assign($(el).style, s);
  set('scanShadeTop',    { left:'0px', top:'0px', width:`${W}px`, height:`${by}px` });
  set('scanShadeBottom', { left:'0px', top:`${by + bh}px`, width:`${W}px`, height:`${Math.max(0, H - by - bh)}px` });
  set('scanShadeLeft',   { left:'0px', top:`${by}px`, width:`${bx}px`, height:`${bh}px` });
  set('scanShadeRight',  { left:`${bx + bw}px`, top:`${by}px`, width:`${Math.max(0, W - bx - bw)}px`, height:`${bh}px` });
  // Start marker, sitting ON the box's left edge — the reference the first
  // real digit gets lined up against — with the "8.8." tag just outside it
  // showing where the placeholder cells belong. Positioned here rather than
  // in CSS because only this function knows the computed box geometry, and
  // it already re-runs on resize and orientation change.
  const startBar = $('scanStart');
  if (startBar) {
    Object.assign(startBar.style, { left: `${bx - 2}px`, top: `${by}px`, height: `${bh}px` });
    const bar = $('scanStartBar');
    if (bar) bar.style.height = `${Math.max(0, bh - 18)}px`;
  }
  const ghostTag = $('scanGhostTag');
  if (ghostTag) {
    // Right-aligned to just left of the box, so it reads as "this bit stays
    // out here". Clamped to 0 so it can never sit off-screen on a narrow
    // viewport where the box nearly fills the width.
    const tagW = 34;
    Object.assign(ghostTag.style, {
      left: `${Math.max(2, bx - tagW - 10)}px`,
      top: `${by + Math.round(bh / 2) - 8}px`,
    });
  }
  $('scanHint').style.top = `${by + bh + 14}px`;
  return { bx, by, bw, bh, W, H };
}

