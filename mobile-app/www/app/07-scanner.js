// mobile-app/www/app/07-scanner.js — split from mobile-app/www/index.html's <script> (helpers/sourceParts.js reconstructs the original)
// ── Live scanning — per Apsara 2026-08-27 ("what if we can do scanning when
//    i point at the scale?"). ────────────────────────────────────────────────
//
// Instead of aiming, holding still and pressing a shutter, the scanner reads
// continuously while the phone is pointed at the display and locks the moment
// enough frames agree.
//
// This is the honest answer to the ghost cell, and to most of the rest.
// Everything before it was an attempt to squeeze certainty out of ONE
// photograph: confidence cliffs, ghost stripping, re-renderings, exposure.
// Each helps, none is decisive, because a single frame sometimes simply does
// not contain the answer — an overexposed capture where the segments bleed,
// or a placeholder cell that reads exactly like a real 8. With a stream, no
// individual frame has to be decisive. Frames that disagree are just
// outvoted, and the read ends when the yard, the light and the angle happen
// to line up rather than at the arbitrary instant a thumb moved.
//
// Deliberately conservative about spend: a cheap on-device check runs first
// and only frames that actually contain a bright red display in the box are
// ever uploaded, so pointing the phone at the ground costs nothing.
let scanLive = { on: false, timer: null, tally: new Map(), shots: new Map(), sent: 0, inFlight: 0, locked: false,
                 blanks: 0, pace: null, verifySent: false, verifyDone: false, verify: null, startedAt: 0 };
const SCAN_LIVE = {
    // NO CEILING AND NO GIVE-UP, per Apsara 2026-08-27 ("time is something i
    // can't compromise. i don't want hard cut"). An earlier version stopped
    // after 10 uploads or 4 unreadable frames, which is the wrong shape: it
    // abandons the read at the exact moment the operator is still standing
    // there pointing at the scale, and makes them re-open the scanner to try
    // again. A barcode scanner does not give up on you; neither does this.
    //
    // Cost is controlled by not uploading instead of by stopping. The local
    // red-lit check means pointing at the ground, the sky or a truck sends
    // nothing at all, and the interval backs off while nothing is readable,
    // so an idle scanner left open is close to free without ever refusing to
    // keep trying.
    // Pace while a display is in view. Faster than the old 650ms because
    // frames now OVERLAP — see MAX_INFLIGHT — so this is the rate at which
    // looks are STARTED, not the round-trip time of each one.
    INTERVAL_MS: 320,
    IDLE_INTERVAL_MS: 1600, // once several frames running have yielded nothing
    BACKOFF_AFTER: 3,       // unreadable frames before easing off the pace
    // Reads allowed in flight at once.
    //
    // The loop used to wait for each read to come back before starting the
    // next, so every cycle cost the interval PLUS a full round trip, and the
    // two frames needed to lock could not overlap at all. In a yard on mobile
    // data that round trip is the dominant cost — the server side is ~330ms
    // and largely fixed. Overlapping two looks means the second is already
    // travelling while the first is being read, which takes time-to-lock from
    // roughly two round trips to roughly one.
    //
    // Held at 2 on purpose. More in flight would not lock any sooner (two
    // agreeing frames is the requirement) and would just spend more per scan.
    MAX_INFLIGHT: 2,
    NEEDED: 2,              // clean frames that must agree before locking
    // Flagged agreement needs more corroboration than clean agreement, so a
    // display that CAN be read cleanly gets several chances first. Not a
    // give-up — reaching it is a result, and it is handed over with its
    // warning intact.
    NEEDED_FLAGGED: 3,
    // How long the scanner may look at a display it cannot read before it
    // SAYS SO. Not a give-up — scanning continues underneath and a good frame
    // still wins — but a worker at a scale must never be left watching a
    // spinner wondering whether the app is broken or they are holding it
    // wrong. Two and a half seconds is about the point where a person stops
    // assuming it is about to work.
    STUCK_AFTER_MS: 2500,
};

// Fraction of pixels in the crop that look like a lit red LED segment.
// Pure canvas arithmetic on a frame we already have — no network, no cost.
// Purpose is to skip uploading the ground, the sky or a truck, not to judge
// the reading itself.
function litRedFraction(canvas) {
    try {
        const ctx = canvas.getContext('2d');
        const { width: w, height: h } = canvas;
        if (!w || !h) return 0;
        const d = ctx.getImageData(0, 0, w, h).data;
        let lit = 0, total = 0;
        // Sample every 4th pixel — plenty for a ratio, and keeps this well
        // under a frame budget on a mid-range phone.
        for (let i = 0; i < d.length; i += 16) {
            total++;
            const r = d[i], g = d[i + 1], b = d[i + 2];
            if (r > 110 && r - g > 45 && r - b > 45) lit++;
        }
        return total ? lit / total : 0;
    } catch (e) { return 0; }
}

// Shows or hides the "can't read it yet" panel. Scanning is unaffected either
// way — this is purely what the worker is told.
function setScanStuck(on) {
    const el = $('scanStuck');
    if (!el) return;
    if (on === el.classList.contains('show')) return;
    el.classList.toggle('show', on);
    if (!on) { const i = $('scanManual'); if (i) i.value = ''; }
}

// Takes a weight the worker typed in themselves. Recorded as a manual entry,
// with no photo attached, precisely because there is no read behind it — a
// typed number must never be mistaken later for one the scanner confirmed.
function useManualWeight() {
    const input = $('scanManual');
    if (!input || !scanTarget) return;
    const v = parseFloat(input.value);
    if (!Number.isFinite(v) || v <= 0) { input.focus(); return; }
    const { row, roleKey } = scanTarget;
    const statusEl = row.querySelector('.ld-item-status');
    const field = row.querySelector(roleKey === 'gross' ? '.ld-item-gross' : '.ld-item-tare');
    if (field) { field.value = v; recomputeRowTotals(row); syncItemsFromDom(); }
    if (statusEl) { statusEl.style.color = ''; statusEl.textContent = `${v} lb — entered by hand.`; }
    stopScanLive();
    closeScanner();
}

function scanLiveStatus(text, tone) {
    const el = $('scanErr');
    if (!el) return;
    el.style.color = tone === 'good' ? 'var(--status-good, #4ade80)' : (tone === 'work' ? 'var(--text-muted, #9aa)' : '');
    el.textContent = text;
}

// Changes the tick rate without restarting the session, so backing off never
// discards the agreement tally built up so far.
function setScanPace(ms) {
    if (!scanLive.on || scanLive.pace === ms) return;
    scanLive.pace = ms;
    if (scanLive.timer) clearInterval(scanLive.timer);
    scanLive.timer = setInterval(doScanLiveTick, ms);
}

function stopScanLive() {
    scanLive.on = false;
    setScanStuck(false);
    if (scanLive.timer) { clearInterval(scanLive.timer); scanLive.timer = null; }
    scanLive.tally = new Map();
    scanLive.shots = new Map();
    scanLive.verifySent = false;
    scanLive.verifyDone = false;
    scanLive.verify = null;
    scanLive.sent = 0;
    scanLive.inFlight = 0;
    scanLive.locked = false;
    scanLive.blanks = 0;
    scanLive.pace = null;
}

async function doScanLiveTick() {
    if (!scanLive.on || scanLive.locked || !scanTarget) return;
    if (scanLive.inFlight >= SCAN_LIVE.MAX_INFLIGHT) return;
    const shot = cropScanFrame({ withCanvas: true });
    if (!shot) return;
    // On-device gate. A display fills a good part of the box with lit red; the
    // ground does not. Cheap, and it is why idle pointing costs nothing.
    const frac = shot.canvas ? litRedFraction(shot.canvas) : 1;
    if (frac < 0.012) {
        // Not pointed at a display. Costs nothing, counts as nothing, and
        // waits as long as it needs to — this is what makes "never give up"
        // affordable rather than expensive.
        setScanPace(SCAN_LIVE.IDLE_INTERVAL_MS);
        scanLiveStatus('Point at the scale display…', 'work');
        return;
    }
    setScanPace(SCAN_LIVE.INTERVAL_MS);
    scanLive.inFlight += 1;
    scanLive.sent += 1;
    try {
        const result = await api('/api/vision/read-weight', {
            method: 'POST',
            // live:true asks the server for a fast answer instead of a
            // thorough one — another frame is 700ms away, so a slow rescue of
            // this particular frame is wasted work.
            body: JSON.stringify({ image_base64: shot.base64, mime_type: 'image/jpeg', pre_cropped: true, live: true }),
        });
        const w = result && result.weight != null ? result.weight : null;
        if (w != null) {
            // Keep this frame's pixels. Two reasons, both mattering in a yard:
            // the winning frame gets attached to the load as evidence (see the
            // lock below), and the verification pass re-reads THIS exact image
            // rather than a later one, so it is checking the frame the number
            // actually came from.
            if (!scanLive.shots.has(w)) scanLive.shots.set(w, shot.base64);
            // SECOND-ENGINE VERIFICATION.
            //
            // Live frames are read on the fast path, which is Cloud Vision
            // plus a rendering cross-check. Fast, but ONE engine. Frames
            // agreeing with each other does not protect against a misread
            // that is systematic — a bloomed 0 that reads as 8 reads as 8 in
            // every frame, and two of those agreeing is two wrong answers, not
            // corroboration. Measured proof that this is not theoretical: the
            // known-bad capture returned the same wrong 4896 on two separate
            // frames.
            //
            // So before any number is published, it must ALSO survive a full
            // read that includes Gemini — a genuinely independent engine that
            // fails in different ways. Started as soon as there is a candidate
            // and run in PARALLEL with continued scanning, so it costs the
            // operator almost nothing: by the time two frames agree the
            // verification is usually already back.
            if (!scanLive.verifySent) {
                scanLive.verifySent = true;
                api('/api/vision/read-weight', {
                    method: 'POST',
                    body: JSON.stringify({ image_base64: shot.base64, mime_type: 'image/jpeg', pre_cropped: true }),
                }).then((v) => {
                    scanLive.verify = (v && v.weight != null && !v.ambiguous) ? v.weight : null;
                    scanLive.verifyDone = true;
                    console.log(`[scanner] second-engine verification: ${scanLive.verify}`);
                }).catch(() => { scanLive.verifyDone = true; scanLive.verify = null; });
            }
            // Clean and flagged agreement are counted SEPARATELY, and only
            // clean agreement can lock.
            //
            // Caught by testing this against the real photos 2026-08-27: the
            // 4146 capture returns a flagged 4896 on every single frame, so
            // counting flagged frames toward the lock turned a read the
            // shutter path correctly warns about into a confident wrong
            // number on a ticket. Repetition is not corroboration when the
            // frames are wrong the same way — which is the same lesson as the
            // greyscale re-render, arriving from a different direction.
            const rec = scanLive.tally.get(w) || { clean: 0, flagged: 0 };
            if (result.ambiguous) rec.flagged += 1; else rec.clean += 1;
            scanLive.tally.set(w, rec);
            const n = rec.clean;
            console.log(`[scanner] live frame ${scanLive.sent}: ${w} (clean ${rec.clean}, flagged ${rec.flagged})`);
            // Frames that agree but are all flagged: stop burning uploads on
            // something that is not going to improve, hand the number over
            // with its warning intact and let the operator decide. This is
            // the behaviour Apsara asked for — show it, flagged, editable.
            if (rec.clean === 0 && rec.flagged >= SCAN_LIVE.NEEDED_FLAGGED) {
                scanLive.locked = true;
                const { row, roleKey } = scanTarget;
                const statusEl = row.querySelector('.ld-item-status');
                const field = row.querySelector(roleKey === 'gross' ? '.ld-item-gross' : '.ld-item-tare');
                // Same evidence rule as the clean lock — a flagged number
                // needs its photo MORE, not less, since someone will have to
                // check it.
                const fIdx = parseInt(row.dataset.idx, 10);
                const fShot = scanLive.shots.get(w);
                syncItemsFromDom();
                if (fShot && currentLoadItems[fIdx]) {
                    currentLoadItems[fIdx][roleKey === 'gross' ? 'grossPhoto' : 'tarePhoto'] = { base64: fShot, mime: 'image/jpeg' };
                }
                if (field) { field.value = w; recomputeRowTotals(row); syncItemsFromDom(); }
                if (statusEl) {
                    statusEl.style.color = 'var(--status-warn, #d9a441)';
                    statusEl.textContent = `Read ${w} lb — CHECK THIS against the display before saving.`;
                }
                showWeighToast('flagged', `Weight ${w} lb — please verify`,
                    'Every frame read the same number but none was confident. Check it against the scale.');
                scanLiveStatus(`${w} — verify against the display`, '');
                setTimeout(() => { stopScanLive(); closeScanner(); }, 900);
                return;
            }
            // Frames agree, but nothing is published until the independent
            // engine has confirmed the SAME number. If verification is still
            // in flight, keep scanning and say so — this is a fraction of a
            // second, and it is the difference between "two looks agreed" and
            // "two different methods agreed".
            if (n >= SCAN_LIVE.NEEDED && !scanLive.verifyDone) {
                scanLiveStatus(`${w} — confirming…`, 'work');
                return;
            }
            if (n >= SCAN_LIVE.NEEDED && scanLive.verify !== w) {
                // The second engine read something else, or could not read it
                // confidently. Two frames agreeing is NOT enough on its own.
                // Throw away the tally and start over rather than publish a
                // number that only one method believes.
                console.warn(`[scanner] ${n} frames read ${w} but verification said ${scanLive.verify} — discarding and rescanning`);
                scanLive.tally = new Map();
                scanLive.shots = new Map();
                scanLive.verifySent = false;
                scanLive.verifyDone = false;
                scanLive.verify = null;
                if (Date.now() - scanLive.startedAt > SCAN_LIVE.STUCK_AFTER_MS) setScanStuck(true);
                scanLiveStatus('Checking again — hold steady…', 'work');
                return;
            }
            if (n >= SCAN_LIVE.NEEDED) {
                // Locked. Two independent frames of a static display agreeing
                // is stronger evidence than anything obtainable from one.
                scanLive.locked = true;
                scanLiveStatus(`Locked: ${w}`, 'good');
                const { row, roleKey } = scanTarget;
                const statusEl = row.querySelector('.ld-item-status');
                const field = row.querySelector(roleKey === 'gross' ? '.ld-item-gross' : '.ld-item-tare');
                // ATTACH THE PHOTO THE NUMBER CAME FROM.
                //
                // This was missing and it was a genuine hole: the shutter path
                // attaches its capture to the item, but the live path set the
                // field directly and kept nothing. A weight with no photo
                // behind it cannot be checked afterwards, and in a yard nobody
                // is checking at the time — the photo IS the record. Now the
                // winning frame is stored the same way a shutter capture is,
                // so every weight on every ticket has its display image.
                const idx = parseInt(row.dataset.idx, 10);
                const winningShot = scanLive.shots.get(w);
                syncItemsFromDom();
                if (winningShot && currentLoadItems[idx]) {
                    currentLoadItems[idx][roleKey === 'gross' ? 'grossPhoto' : 'tarePhoto'] = { base64: winningShot, mime: 'image/jpeg' };
                }
                if (field) { field.value = w; recomputeRowTotals(row); syncItemsFromDom(); }
                if (statusEl) {
                    statusEl.style.color = '';
                    statusEl.textContent = `Read ${w} lb — ${SCAN_LIVE.NEEDED} camera frames agreed.`;
                }
                // 'ok' + autohide matches the existing successful-read toast
                // rather than introducing a second success style. Wording
                // still asks for a glance at the scale: two frames agreeing is
                // strong evidence, not a guarantee, and the field stays
                // editable either way.
                showWeighToast('ok', `Weight read: ${w} lb`, `${SCAN_LIVE.NEEDED} camera frames agreed. Confirm it matches the scale.`, 4000);
                setTimeout(() => { stopScanLive(); closeScanner(); }, 450);
                return;
            }
            scanLive.blanks = 0;
            setScanPace(SCAN_LIVE.INTERVAL_MS);
            // Reading something, even if not yet confirmed - so this is not
            // the stuck case. Clear the panel rather than nag.
            setScanStuck(false);
            scanLiveStatus(`Reading… ${w}?`, 'work');
        } else {
            // Nothing readable this time. Keep going — the next frame has a
            // different exposure and blur and is often the easier read — but
            // ease the pace so an awkwardly-aimed phone is not uploading at
            // full rate. Guidance changes; the scanner does not stop.
            scanLive.blanks += 1;
            if (Date.now() - scanLive.startedAt > SCAN_LIVE.STUCK_AFTER_MS) setScanStuck(true);
            if (scanLive.blanks >= SCAN_LIVE.BACKOFF_AFTER) {
                setScanPace(SCAN_LIVE.IDLE_INTERVAL_MS);
                scanLiveStatus('Still looking — try moving a little closer.', 'work');
            } else {
                scanLiveStatus('Reading…', 'work');
            }
        }
    } catch (err) {
        console.warn('[scanner] live tick failed:', err && err.message);
    } finally {
        scanLive.inFlight = Math.max(0, scanLive.inFlight - 1);
    }
}

function startScanLive() {
    stopScanLive();
    scanLive.on = true;
    scanLive.pace = SCAN_LIVE.INTERVAL_MS;
    scanLive.startedAt = Date.now();
    setScanStuck(false);
    scanLiveStatus('Point at the scale display…', 'work');
    scanLive.timer = setInterval(doScanLiveTick, SCAN_LIVE.INTERVAL_MS);
    // Look IMMEDIATELY rather than after one interval. The operator has
    // usually already aimed at the display before the overlay finishes
    // opening, so waiting a full tick to take the first look was dead time on
    // every single scan. The camera may need a moment to produce a frame, so
    // this is a short delay rather than none — cropScanFrame returns null
    // until the stream is live, which the loop treats as a normal miss.
    setTimeout(doScanLiveTick, 120);
}

function closeScanner() {
  stopScanLive();
  if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
  const v = $('scanVideo');
  if (v) v.srcObject = null;
  $('scanOverlay').classList.remove('open');
  scanTarget = null;
  window.removeEventListener('resize', layoutScanBox);
}

// Returns true if the live scanner opened; false if this device/WebView
// can't give us a camera stream, so the caller can fall back to the
// existing native-camera path rather than leaving the user stuck.
async function openScanner(row, roleKey) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
  scanTarget = { row, roleKey };
  $('scanErr').textContent = '';
  $('scanShutter').disabled = false;
  $('scanShutter').textContent = 'Capture weight';
  $('scanOverlay').classList.add('open');
  try {
    // facingMode 'environment' = rear camera. Requested at high resolution
    // deliberately: the box crop is only a fraction of the frame, so frame
    // resolution is what determines how many pixels the DIGITS actually
    // get. Verified with the real mapping math (see cropScanFrame): a
    // 1920x1080 stream in a portrait viewport yields only a ~478x150px
    // crop, while a 2560-wide stream yields proportionally more — and
    // digit pixel count is precisely what OCR accuracy depends on here
    // (see downscaleToBase64's note: resolution loss was measured to turn
    // 3/3 correct reads into 0/3). These are `ideal` hints, not hard
    // constraints, so a device that can't do 2560 returns its best
    // available instead of failing the request outright.
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1440 } },
      audio: false,
    });
  } catch (err) {
    console.warn('[scanner] getUserMedia failed:', err && err.message);
    closeScanner();
    return false;
  }
  const v = $('scanVideo');
  v.srcObject = scanStream;
  try { await v.play(); } catch (e) { /* autoplay attr usually covers this */ }
  layoutScanBox();
  window.addEventListener('resize', layoutScanBox);
  // Start reading immediately. The shutter stays live as a manual override —
  // if the light is awkward or she wants to force a read on a particular
  // moment, pressing it still works exactly as before and stops the loop.
  startScanLive();
  return true;
}

// Maps the on-screen box back onto the video's real pixel grid and crops.
// object-fit:cover means the video is scaled to fill the wrapper and
// overflow is clipped, so the mapping has to account for that same scale
// and the centering offset — getting this wrong would crop the wrong
// region, which is exactly the "digits sliced off" failure mode that
// caused bad reads before (see helpers/gemini.js's 73600 case).
function cropScanFrame(opts) {
  const v = $('scanVideo');
  const geom = layoutScanBox();
  const vw = v.videoWidth, vh = v.videoHeight;
  if (!vw || !vh || !geom) return null;
  const { bx, by, bw, bh, W, H } = geom;
  const scale = Math.max(W / vw, H / vh);           // object-fit: cover
  const dispW = vw * scale, dispH = vh * scale;
  const offX = (dispW - W) / 2, offY = (dispH - H) / 2; // clipped-off amount
  const sx = Math.max(0, Math.round((bx + offX) / scale));
  const sy = Math.max(0, Math.round((by + offY) / scale));
  const sw = Math.min(vw - sx, Math.round(bw / scale));
  const sh = Math.min(vh - sy, Math.round(bh / scale));
  if (sw < 8 || sh < 8) return null;
  const canvas = document.createElement('canvas');
  canvas.width = sw; canvas.height = sh;
  canvas.getContext('2d').drawImage(v, sx, sy, sw, sh, 0, 0, sw, sh);
  // opts.withCanvas — the live loop inspects these pixels locally (see
  // litRedFraction) to decide whether the frame is even worth uploading.
  // Returned only on request so the ordinary capture path keeps handing back
  // the same small object it always did and nothing holds a canvas alive.
  if (opts && opts.withCanvas) {
    return { base64: canvas.toDataURL('image/jpeg', 0.95).split(',')[1], w: sw, h: sh, canvas };
  }
  // quality 0.95 to match captureViaNativeCamera — seven-segment digits are
  // exactly the high-contrast thin-edge content JPEG artifacts damage most
  // (that finding is documented on the native path; same reasoning here).
  return { base64: canvas.toDataURL('image/jpeg', 0.95).split(',')[1], w: sw, h: sh };
}

async function doScanCapture() {
  if (!scanTarget) return;
  const { row, roleKey } = scanTarget;
  const shutter = $('scanShutter');
  // Manual capture overrides the live loop — otherwise a tick could land
  // mid-capture and race it to the same field.
  stopScanLive();
  shutter.disabled = true; shutter.textContent = 'Reading…';
  $('scanErr').textContent = '';
  const shot = cropScanFrame();
  if (!shot) {
    $('scanErr').textContent = 'Camera not ready yet — wait a moment and try again.';
    shutter.disabled = false; shutter.textContent = 'Capture weight';
    return;
  }
  // BURST. Grab a few more frames off the same live preview, ~140ms apart.
  //
  // The weight on the display is static across that third of a second; the
  // sensor noise is not. So two frames agreeing on a number is independent
  // evidence — which matters because re-processing ONE frame is provably not:
  // measured 2026-08-27, a greyscale re-render reproduces the plain read's
  // ghost digit exactly, so filters cannot corroborate the reads that
  // actually go wrong. Separate frames can.
  //
  // Deliberately at the SAME exposure. Varying it was the obvious idea and
  // testing killed it: darkening the true-3475 photo enough to fix the
  // overexposed 4146 photo made Vision read the 3475 as 475 at 0.92
  // confidence. Deliberately mis-exposed frames vote wrong things
  // confidently, so the burst uses whatever exposure the preview settled on
  // and relies on natural variation between frames.
  //
  // Costs about 420ms of camera time and nothing in extra round trips — the
  // frames ride along on the request that was already being made, and the
  // server only looks at them when the primary frame was not confident on
  // its own, which measured as roughly 3 scans in 10.
  const BURST_FRAMES = 3;
  const BURST_GAP_MS = 140;
  const frames = [];
  for (let i = 1; i < BURST_FRAMES; i++) {
    await new Promise((r) => setTimeout(r, BURST_GAP_MS));
    const extra = cropScanFrame();
    // A dropped frame is not an error — the burst is best-effort extra
    // evidence, and one good frame is still a perfectly valid read.
    if (extra && extra.base64) frames.push(extra.base64);
  }
  console.log(`[scanner] burst captured ${frames.length + 1} frames`);
  console.log(`[scanner] cropped ${shot.w}x${shot.h}px, ~${Math.round(shot.base64.length * 3 / 4 / 1024)}KB`);
  // Low-resolution guard. The crop is a fraction of the frame, so a device
  // that only gave us a small stream can produce a crop too thin to read
  // digits from reliably — the mapping math measures ~212x67px off a
  // 640x480 stream, which is ~40px per digit. Rather than let that become
  // a confidently-wrong number on a ticket, say so and let the operator
  // decide. Warn-only, not a hard block: a marginal read that the operator
  // then verifies against the scale is still more useful than refusing to
  // capture at all, and the number still has to pass the same downstream
  // cross-check as any other read.
  // Retuned 2026-08-19 alongside the narrower box. 320 was calibrated for
  // the old 0.86-wide box; with the box at 0.60 a perfectly good capture
  // measures ~333px on a 1080p stream, which would have false-warned on
  // every read. 240 still catches the genuinely poor case (a 640x480
  // stream yields ~148px, about 37px per digit) without crying wolf.
  const LOW_CROP_WIDTH = 240;
  if (shot.w < LOW_CROP_WIDTH) {
    console.warn(`[scanner] crop is only ${shot.w}px wide (<${LOW_CROP_WIDTH}) — this device's camera stream is low resolution; the read may be less reliable`);
  }
  const statusEl = row.querySelector('.ld-item-status');
  closeScanner(); // release the camera before the network round trip
  await processWeightImage(row, roleKey, shot.base64, 'image/jpeg', statusEl, { preCropped: true, frames });
}

// Small floating "Take Photo / Choose File" menu, shown when a row's 📷
// button is clicked — per Apsara, a single plain file input's OS chooser
// was surfacing Google Photos ahead of an actual camera option, with no way
// to just say "take a new photo." Appended to <body> (not inside the row)
// so it isn't clipped by #ld_items' horizontal-scroll overflow, positioned
// off the button's real screen position. Dismissed on choosing either
// option or clicking anywhere else.
function showCaptureMenu(anchorBtn, { onCamera, onFiles }) {
  document.querySelectorAll('.capture-menu').forEach(m => m.remove());
  const rect = anchorBtn.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'capture-menu';
  menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
  menu.style.left = `${rect.left + window.scrollX}px`;
  menu.innerHTML = `
    <button type="button" class="capture-menu-btn" data-action="camera">📷 Scan weight</button>
    <button type="button" class="capture-menu-btn" data-action="files">📁 Choose File</button>
  `;
  document.body.appendChild(menu);
  const close = () => { menu.remove(); document.removeEventListener('click', outsideClick, true); };
  const outsideClick = (e) => { if (!menu.contains(e.target) && e.target !== anchorBtn) close(); };
  menu.querySelector('[data-action="camera"]').addEventListener('click', () => { close(); onCamera(); });
  menu.querySelector('[data-action="files"]').addEventListener('click', () => { close(); onFiles(); });
  // Deferred one tick so the SAME click that opened the menu (which is still
  // bubbling up to document right now) doesn't immediately close it again.
  setTimeout(() => document.addEventListener('click', outsideClick, true), 0);
}

// tare_weight defaults to "0" now — mirrors dashboard/index.html, see its
// comment for why (Apsara 2026-08-15).
function blankLoadItem() {
  // `unit: ''` is pounds — the default, and what every historic row has.
  // `pieces: ''` rather than 0, because an empty count means "not typed" and
  // a zero means "nothing was delivered", and those are different answers.
  return { description: '', gross_weight: '', tare_weight: '0', price: '', unit: '', pieces: '', grossPhoto: null, tarePhoto: null, gross_photo_link: null, tare_photo_link: null, gross_photo_drive_id: null, tare_photo_drive_id: null };
}

// Local (not UTC) YYYY-MM-DD — a load dated by UTC-conversion could land on
// the WRONG calendar day for anyone west of Greenwich in the evening
// (e.g. 9pm Pacific is already the next day in UTC), which is exactly the
// kind of off-by-one that would misfile a load into tomorrow's date group.
function todayLocalDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

