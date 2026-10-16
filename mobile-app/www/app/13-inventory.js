// mobile-app/www/app/13-inventory.js — split from mobile-app/www/index.html's <script> (helpers/sourceParts.js reconstructs the original)
// ── Inventory tab ─────────────────────────────────────────────────────────
// Restructured 2026-08-21 after Apsara: "when i navigate from load to
// inventory, it is taking some time."
//
// The server was never slow — getInventoryReport is ~15ms at 10,000 loads
// and the payload is under 30KB. What cost the time was a network round
// trip to the VM, and what made it FEEL broken was that nothing on screen
// changed until it came back: the tab button highlighted instantly and the
// Loads list just sat there underneath. Three changes, in order of how much
// they actually matter:
//
//   1. Paint the page shell immediately, with a skeleton where the numbers
//      go. The round trip is unchanged; it just stops looking like a freeze.
//   2. Sub-tab switches no longer refetch. Item type / Per day / Per seller
//      all arrive in the SAME response — the old code called this whole
//      function again for each tap, paying a full round trip to re-render
//      data already in hand. This was the worst of the three and the easiest
//      to miss, because each individual tap only felt "a bit slow".
//   3. Re-entering the tab paints the last known figures instantly and
//      refreshes behind them, so only the first visit ever waits.
//
// mobInvData holds the last response, keyed by the filter it was fetched
// with — without the key, changing the date range would briefly show the
// previous range's totals as though they were the new ones.
let mobInvData = null, mobInvDataKey = null;

function mobInvKey() {
  return `${mobInvFrom}|${mobInvTo}`;
}

// ── wire the item-type drill-down ─────────────────────────────────────────
// Called after EVERY repaint of the inventory rows, and there is more than one
// such path — which is exactly how this broke.
//
// Apsara, 2026-09-02: "in inventory when i click item type sealed units, it is
// not displaying anything." The wiring had been added only to the sub-tab
// SWITCH path, so tapping a type on a freshly opened Inventory tab did
// nothing at all. It worked on the website, where the initial render is the
// same function, and I verified it there and shipped both. One client tested,
// two clients shipped.
//
// Pulled out here so a paint path cannot exist without the wiring sitting
// beside it.
function wireInvLineToggles(from, to) {
  document.querySelectorAll('[data-inv-toggle]').forEach((el) => el.addEventListener('click', () => {
    toggleInvLines(el.getAttribute('data-inv-toggle'), from, to);
  }));
  renderInvLines();
}

// Repaints ONLY the sub-tab body from data already held. This is what the
// sub-tab buttons call now.
function paintInvSubtab() {
  if (!mobInvData) return;
  const body = $('invSubtabBody');
  if (body) body.innerHTML = MOB_INV_SUBTAB_RENDER[mobInvSubTab](mobInvData);
  wireInvLineToggles(mobInvFrom, mobInvTo);

  $('viewRoot').querySelectorAll('.inv-subtab-btn').forEach(btn => {
    const on = btn.dataset.subtab === mobInvSubTab;
    btn.style.borderBottom = `2px solid ${on ? 'var(--accent)' : 'transparent'}`;
    btn.style.fontWeight = on ? '700' : '500';
    btn.style.color = on ? 'var(--text-strong)' : 'var(--text-muted)';
  });
}

async function renderInventoryTab() {
  const key = mobInvKey();
  // Stale data from a DIFFERENT filter must not be shown as if it were this
  // one's — drop it and fall back to the skeleton.
  if (mobInvDataKey !== key) mobInvData = null;
  const params = new URLSearchParams();
  if (mobInvFrom) params.set('from', mobInvFrom);
  if (mobInvTo) params.set('to', mobInvTo);
  const qs = params.toString() ? '?' + params.toString() : '';

  paintInventory(mobInvData, !mobInvData);
  try {
    const fresh = await api('/api/loads/inventory' + qs);
    // Guard against a slow response landing after the filter moved on —
    // tap Apply twice quickly and the first reply could otherwise overwrite
    // the second with older numbers.
    if (mobInvKey() !== key) return;
    mobInvData = fresh; mobInvDataKey = key;
    paintInventory(fresh, false);
  } catch (err) {
    if (err.message === 'unauthorized') return; // api() already redirected
    // Keep whatever's on screen if we had real data; only a first visit
    // with nothing cached gets the error page.
    if (!mobInvData) throw err;
    const hint = $('invStaleHint');
    if (hint) { hint.textContent = "Couldn't refresh — showing the last figures."; hint.style.color = 'var(--status-warning)'; }
  }
}

// data === null renders the skeleton. `loading` shows the refreshing hint.
function paintInventory(data, loading) {
  const skel = (w) => `<span style="display:inline-block; width:${w}; height:11px; border-radius:3px; background:var(--surface-sunken); opacity:.6;"></span>`;
  const body = data
    ? MOB_INV_SUBTAB_RENDER[mobInvSubTab](data)
    : [70, 55, 62, 48, 58].map(w => `
        <div style="display:flex; justify-content:space-between; padding:9px 0; border-bottom:1px solid var(--border-subtle);">
          ${skel(w + 'px')}${skel('110px')}
        </div>`).join('');
  $('viewRoot').innerHTML = `
    <section style="max-width:600px; margin:0 auto; padding:20px 16px 60px;">
      <div style="display:flex; justify-content:space-between; align-items:start; margin-bottom:10px;">
        <div style="font-family:var(--font-mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--text-muted);">Inventory</div>
        <div style="position:relative;">
          <button id="btnInvExportMenu" class="btn" style="padding:4px 9px; font-size:16px; line-height:1;">⋮</button>
          <div id="invExportMenu" class="ac-dropdown hidden" style="left:auto; right:0; width:170px; max-height:none;">
            <div class="ac-item" data-export="xlsx">Export as Excel</div>
            <div class="ac-item" data-export="pdf">Export as PDF</div>
          </div>
        </div>
      </div>
      <div style="display:flex; gap:8px; margin-bottom:14px;">
        <div class="field" style="flex:1; margin-bottom:0;"><label>From</label><input id="inv_from" placeholder="MM/DD/YYYY" autocomplete="off" value="${esc(toUsDate(mobInvFrom))}"></div>
        <div class="field" style="flex:1; margin-bottom:0;"><label>To</label><input id="inv_to" placeholder="MM/DD/YYYY" autocomplete="off" value="${esc(toUsDate(mobInvTo))}"></div>
      </div>
      <div style="display:flex; gap:8px; margin-bottom:18px;">
        <button id="btnInvApply" class="btn btn-primary" style="flex:1;">Apply</button>
        <button id="btnInvClear" class="btn" style="flex:1;">Clear</button>
      </div>
      <div style="display:flex; gap:4px; margin-bottom:16px; border-bottom:1px solid var(--border-subtle); overflow-x:auto;">
        ${INV_SUBTABS.map(t => `
          <button class="btn inv-subtab-btn" data-subtab="${t.id}" style="flex:none; border:none; border-radius:0; border-bottom:2px solid ${mobInvSubTab === t.id ? 'var(--accent)' : 'transparent'}; background:transparent; padding:8px 10px; font-size:12px; font-weight:${mobInvSubTab === t.id ? '700' : '500'}; color:${mobInvSubTab === t.id ? 'var(--text-strong)' : 'var(--text-muted)'}; white-space:nowrap;">${esc(t.label)}</button>
        `).join('')}
      </div>
      <div id="invSubtabBody">${body}</div>
      <div id="invStaleHint" style="margin-top:12px; font-family:var(--font-mono); font-size:10.5px; color:var(--text-faint); text-align:center;">${loading ? 'Loading…' : ''}</div>
    </section>`;
  // THE PATH THAT WAS MISSING. paintInventory renders the whole tab,
  // sub-tab body included, so the toggles it draws need wiring here too —
  // not only when a sub-tab is switched.
  wireInvLineToggles(mobInvFrom, mobInvTo);
  $('btnInvApply').addEventListener('click', () => { mobInvFrom = toIsoDate($('inv_from').value); mobInvTo = toIsoDate($('inv_to').value); renderInventoryTab(); });
  wireUsDateField('inv_from'); wireUsDateField('inv_to');
  $('btnInvClear').addEventListener('click', () => { mobInvFrom = ''; mobInvTo = ''; renderInventoryTab(); });
  // Sub-tab switch repaints from data already held — no refetch. All three
  // sub-tabs come back in the same response; see the header comment.
  $('viewRoot').querySelectorAll('.inv-subtab-btn').forEach(btn => btn.addEventListener('click', () => {
    if (btn.dataset.subtab === mobInvSubTab) return;
    mobInvSubTab = btn.dataset.subtab;
    paintInvSubtab();
  }));

  // Export — mobile auth is a bearer token (see api()'s comment), not a
  // cookie, so a plain link or navigation wouldn't carry it. The file is
  // always fetched as a blob through the authed path; how it's DELIVERED
  // then depends on where we're running (see deliverExportedFile).
  const exportMenu = $('invExportMenu');
  $('btnInvExportMenu').addEventListener('click', (ev) => { ev.stopPropagation(); exportMenu.classList.toggle('hidden'); });
  document.addEventListener('click', () => exportMenu.classList.add('hidden'));
  exportMenu.querySelectorAll('.ac-item').forEach(item => item.addEventListener('click', async () => {
    exportMenu.classList.add('hidden');
    const ext = item.dataset.export;
    const label = ext === 'xlsx' ? 'Excel' : 'PDF';
    // Generating a big range server-side takes a beat, and before this
    // there was no feedback at all between tapping and the share sheet —
    // which is part of why a silent failure read as "nothing happens".
    showWeighToast('working', `Preparing ${label} export…`, 'Building the file on the server');
    try {
      // Rebuilt from the live filter rather than closed over, since the
      // 2026-08-21 split moved this wiring into paintInventory() where the
      // fetch function's `qs` is out of scope. Reading it fresh is also more
      // correct: the export now always matches what's on screen RIGHT NOW,
      // not the filter that happened to be set when the page was painted.
      const p = new URLSearchParams();
      if (mobInvFrom) p.set('from', mobInvFrom);
      if (mobInvTo) p.set('to', mobInvTo);
      const eqs = p.toString() ? '?' + p.toString() : '';
      const res = await fetch(API_BASE + `/api/loads/inventory/export.${ext}${eqs}`, { headers: { Authorization: 'Bearer ' + getToken() } });
      if (!res.ok) {
        // Surface the server's actual error message when it sent one,
        // instead of a bare status code.
        let detail = `export failed (${res.status})`;
        try { const j = await res.json(); if (j && j.error) detail = j.error; } catch {}
        throw new Error(detail);
      }
      const blob = await res.blob();
      // A JSON error body that slipped through with a 200 would otherwise
      // be saved as a corrupt .xlsx that Excel refuses to open — a failure
      // that looks like a broken file rather than a broken request.
      if (!blob.size) throw new Error('the server returned an empty file');
      await deliverExportedFile(blob, `inventory-${todayStamp()}.${ext}`, ext);
      hideWeighToast();
    } catch (err) {
      hideWeighToast();
      alert(`Couldn't export the ${label} file.\n\n${err.message}`);
    }
  }));
}

// Filename stamp so repeated exports don't all land as "inventory.xlsx" and
// overwrite each other in the share target's folder.
function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Getting a downloaded file OUT of the app ───────────────────────────────
// This is the fix for "export as excel/pdf not working" (Apsara 2026-08-21).
//
// The old code did the standard browser thing: make an object URL for the
// blob, create an <a download>, click it. That works in Chrome and it works
// on the dashboard. It does NOTHING in an Android WebView, silently — the
// WebView has no download manager of its own, and blob: URLs are internal to
// the WebView so they never reach a DownloadListener even if one is
// installed. Tap, no error, no file. Exactly what she saw.
//
// So on native we write the bytes to the app's cache directory with
// @capacitor/filesystem and hand the real file:// URI to @capacitor/share,
// which opens the Android share sheet. That's a better fit for a yard than a
// download would have been anyway: the sheet offers WhatsApp, Drive, Gmail
// and Files, so the report goes straight to whoever needs it instead of
// landing in /Downloads to be hunted for later.
//
// Cache directory, not Documents: these are disposable reports regenerated
// on demand from live data, and Cache needs no storage permission on any
// Android version. Android clears it under pressure, which is correct — the
// file has already been shared by then.
//
// The <a download> path is kept for running this same page in a real browser
// (dev/testing), where it's the right mechanism.
async function deliverExportedFile(blob, filename, ext) {
  const cap = window.Capacitor;
  const isNative = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const FS = isNative && cap.Plugins && cap.Plugins.Filesystem;
  const Share = isNative && cap.Plugins && cap.Plugins.Share;

  if (!FS || !Share) {
    // Browser path — unchanged behaviour.
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return;
  }

  // Filesystem.writeFile takes base64, not a Blob. FileReader's data URL is
  // "data:<mime>;base64,<payload>" — split off the payload.
  const base64 = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.onerror = () => reject(new Error("couldn't read the downloaded file"));
    fr.readAsDataURL(blob);
  });

  const { uri } = await FS.writeFile({ path: filename, data: base64, directory: 'CACHE' });
  try {
    await Share.share({
      title: 'Inventory export',
      // No `text`: on some targets (Gmail, WhatsApp) a text field alongside
      // a file attachment gets treated as the message body, and on a few it
      // makes the file itself get dropped.
      files: [uri],
      dialogTitle: ext === 'xlsx' ? 'Send the Excel file' : 'Send the PDF',
    });
  } catch (e) {
    // Backing out of the Android share sheet REJECTS rather than resolving,
    // so without this a deliberate cancel would pop an error alert saying
    // the export failed — when in fact the file built fine and the user
    // simply changed their mind. Anything else is a real failure.
    if (/cancel/i.test(e && e.message || '')) return;
    throw e;
  }
}

async function bootLoads() {
  showAppShell();
  // Jarvis is checked first: its ROLE is 'admin', so the admin branch would
  // otherwise swallow it and the label would give no sign that this session
  // can erase a paid load. A profile with powers nobody can see is how you
  // stay signed in as it by accident.
  $('roleLabel').textContent = IS_SUPER ? 'Jarvis access'
    : ROLE === 'admin' ? 'Admin access' : ROLE === 'staff' ? 'Staff access' : 'Standard access';
  // Gear icon only for admin — per Apsara 2026-08-15. This is UI convenience
  // only, not the real boundary: /api/settings is already requireAdmin-gated
  // server-side in api.js, so a non-admin session can't actually use what's
  // behind this button even if it were shown.
  $('btnAdminSettings').classList.toggle('hidden', ROLE !== 'admin');
  // Staff's smaller settings button — per Apsara 2026-08-16. Admin already
  // gets everything staff gets (and more) via the admin modal above, so
  // this stays hidden for admin too — one gear icon per role, not two.
  $('btnStaffSettings').classList.toggle('hidden', ROLE !== 'staff');
  // Always land on Loads first, per Apsara ("loads should open by
  // default") — every boot/login resets the tab state rather than
  // remembering whatever was open last time.
  currentMobileTab = 'loads';
  renderMobileTabs();
  // After ROLE is set — refreshWaBanner() reads it to decide whether to call
  // the admin-only status endpoint at all.
  startWaBannerPolling();
  wireVoiceUI();
  try {
    await renderCurrentMobileTab();
  } catch (err) {
    if (err.message !== 'unauthorized') {
      $('viewRoot').innerHTML = '<div style="padding:60px; text-align:center; color:var(--status-danger); font-family:var(--font-mono); font-size:12px;">' + esc(err.message) + '</div>';
    }
  }
}

// renderLoads()'s own code calls loadTab('loads') after save/delete/PDF
// actions to refresh the deck — the dashboard build has a real tab
// router, this app doesn't need one, so it's shimmed to just reload
// Loads directly. Everything that calls it was lifted verbatim above and
// is unaware this is a shim rather than a real router.
function loadTab(tab) {
  if (tab === 'loads') return bootLoads();
}

// Guided scanner controls — static top-level markup, so these wire once at
// boot rather than being re-bound per item row.
$('scanShutter').addEventListener('click', doScanCapture);
$('scanCancel').addEventListener('click', closeScanner);
$('scanManualUse').addEventListener('click', useManualWeight);
// Enter on the keypad accepts it too — one-handed at a scale, reaching for a
// button after typing is an extra motion for no reason.
$('scanManual').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); useManualWeight(); } });
wireSignPad();
wireExpenseModal();

$('btnLogin').addEventListener('click', doLogin);
$('loginPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('btnSignout').addEventListener('click', () => {
  setToken(null);
  // Stop the poller and clear the banner on the way out. Without this it
  // keeps firing an admin-only request every 60s with a dead token, and the
  // warning stays on screen behind the login form.
  if (waBannerTimer) { clearInterval(waBannerTimer); waBannerTimer = null; }
  if ($('waDownBanner')) { $('waDownBanner').classList.add('hidden'); $('waDownBanner').innerHTML = ''; }
  showLoginScreen();
});

