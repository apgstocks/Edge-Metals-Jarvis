// dashboard/app/14-facts-boot.js — split from dashboard/index.html's <script> (helpers/sourceParts.js reconstructs the original)
function renderFacts(data) {
  const facts = data.facts || [];
  // Facts are addressed by their stable server id (2026-08-25), never by
  // position in this array — an eviction server-side shifts positions, so a
  // rendered index could delete a different fact than the one clicked.
  // Phase 2: the store now also holds superseded and retracted records. The
  // main lists show only what Jarvis CURRENTLY believes; the rest goes to a
  // Retired panel so nothing is hidden but nothing stale looks live either.
  const active = facts.filter((f) => (f.status || 'active') === 'active');
  const retired = facts.filter((f) => (f.status || 'active') !== 'active').reverse();
  const pinned = active.filter((f) => f.pinned);
  const unpinned = active.filter((f) => !f.pinned).reverse();
  const factRow = (f) => `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; padding:10px 12px; background:var(--surface-sunken); border-radius:var(--radius-xs); ${f.pinned ? 'border:1px solid var(--accent);' : ''}">
      <span style="font-size:13px;">${f.pinned ? '<span title="Pinned — always included, never ages out" style="margin-right:6px;">📌</span>' : ''}${esc(f.text)}</span>
      <span style="display:flex; gap:6px; flex-shrink:0;">
        <button class="btn btn-secondary btn-correct-fact" data-id="${esc(f.id)}" data-text="${esc(f.text)}" style="padding:5px 10px; font-size:10px;">Correct</button>
        <button class="btn btn-secondary btn-pin-fact" data-id="${esc(f.id)}" data-pinned="${f.pinned ? '1' : '0'}" style="padding:5px 10px; font-size:10px;">${f.pinned ? 'Unpin' : 'Pin'}</button>
        <button class="btn btn-danger btn-del-fact" data-id="${esc(f.id)}" style="padding:5px 10px; font-size:10px;">Forget</button>
      </span>
    </div>`;
  const byId = Object.fromEntries(facts.map((f) => [f.id, f]));
  const when = (iso) => { try { return new Date(iso).toLocaleDateString(); } catch { return ''; } };
  const retiredRow = (f) => {
    const superseded = f.status === 'superseded';
    const replacement = superseded && f.superseded_by ? byId[f.superseded_by] : null;
    return `
    <div style="padding:10px 12px; background:var(--surface-sunken); border-radius:var(--radius-xs); opacity:.85;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px;">
        <div style="min-width:0;">
          <div style="font-size:13px; text-decoration:line-through; color:var(--text-muted);">${esc(f.text)}</div>
          <div style="font-family:var(--font-mono); font-size:10px; letter-spacing:.06em; text-transform:uppercase; color:var(--text-faint); margin-top:4px;">
            ${superseded ? `Replaced ${when(f.valid_until)}` : `Forgotten ${when(f.retracted_at)}`}${f.change_reason ? ` · ${esc(f.change_reason)}` : ''}
          </div>
          ${replacement ? `<div style="font-size:12px; margin-top:6px; color:var(--text-muted);">→ now: ${esc(replacement.text)}</div>` : ''}
        </div>
        ${superseded ? '' : `<button class="btn btn-secondary btn-restore-fact" data-id="${esc(f.id)}" style="padding:5px 10px; font-size:10px; flex-shrink:0;">Restore</button>`}
      </div>
    </div>`;
  };
  $('viewRoot').innerHTML = `
    <section style="max-width:800px; margin:0 auto; padding:38px 40px 80px;">
      <div class="eyebrow">// Facts</div>
      <h2 style="font-size:24px; text-transform:uppercase; margin-bottom:6px;">Learned memory</h2>
      <div style="font-size:13px; color:var(--text-muted); margin-bottom:22px;">Explicit "remember X" commands and AI-detected corrections land here, and every one feeds every future AI answer. Regular facts only stay in the AI's view for the most recent 15 — pin anything that should never age out.</div>
      <div class="card" style="padding:18px 20px; margin-bottom:16px;">
        <div style="display:flex; gap:8px;">
          <input id="f_new_text" style="flex:1; padding:11px 12px; border:1px solid var(--border-default); border-radius:var(--radius-sm);" placeholder="e.g. DALA booking numbers can include a dash">
          <button id="btnAddFact" class="btn btn-primary">Add</button>
        </div>
        <label style="display:flex; align-items:center; gap:6px; margin-top:10px; font-size:12px; color:var(--text-muted); cursor:pointer;">
          <input type="checkbox" id="f_new_pinned" checked> Pin this — always reinforce it, never let it age out of the AI's memory
        </label>
        <div id="factAddErr" style="color:var(--status-danger); font-size:12px; margin-top:8px;"></div>
      </div>
      ${pinned.length ? `
      <div class="card" style="padding:18px 20px; margin-bottom:16px;">
        <div style="font-family:var(--font-mono); font-size:10px; font-weight:600; letter-spacing:.16em; text-transform:uppercase; color:var(--accent); margin-bottom:12px;">📌 Pinned — always applied</div>
        <div style="display:flex; flex-direction:column; gap:8px;">${pinned.map(factRow).join('')}</div>
      </div>` : ''}
      <div class="card" style="padding:18px 20px;">
        <div style="font-family:var(--font-mono); font-size:10px; font-weight:600; letter-spacing:.16em; text-transform:uppercase; color:var(--text-muted); margin-bottom:12px;">All other facts (most recent first — only last 15 reach the AI)</div>
        <div id="factList" style="display:flex; flex-direction:column; gap:8px;">
          ${unpinned.length ? unpinned.map(factRow).join('') : '<div style="font-family:var(--font-mono); font-size:12px; color:var(--text-faint); padding:10px 0; text-align:center;">No facts yet.</div>'}
        </div>
      </div>
      ${retired.length ? `
      <div class="card" style="padding:18px 20px; margin-top:16px;">
        <div style="font-family:var(--font-mono); font-size:10px; font-weight:600; letter-spacing:.16em; text-transform:uppercase; color:var(--text-muted); margin-bottom:6px;">Retired — kept on record, not applied</div>
        <div style="font-size:12px; color:var(--text-muted); margin-bottom:12px;">Nothing here reaches the AI. Corrected facts show what replaced them; forgotten ones can be restored.</div>
        <div style="display:flex; flex-direction:column; gap:8px;">${retired.map(retiredRow).join('')}</div>
      </div>` : ''}
    </section>`;
  $('btnAddFact').addEventListener('click', async () => {
    const text = $('f_new_text').value.trim();
    if (!text) { $('factAddErr').textContent = 'Enter some text first.'; return; }
    $('factAddErr').textContent = '';
    try { await api('/api/facts', { method: 'POST', body: JSON.stringify({ text, pinned: $('f_new_pinned').checked }) }); loadTab('facts'); }
    catch (e) { $('factAddErr').textContent = e.message; }
  });
  // "Forget" is a RETRACTION, not a deletion (2026-08-25) — the fact stops
  // being believed and leaves every prompt, but is kept on record and can be
  // restored. The wording says so, because "Delete" would imply the record is
  // destroyed, and it isn't.
  document.querySelectorAll('.btn-del-fact').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Stop applying this fact?\n\nJarvis will stop using it immediately. It stays on record and you can restore it from Retired below.')) return;
    await api(`/api/facts/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
    loadTab('facts');
  }));
  // Correcting records the change instead of hiding it — the old version is
  // kept, marked superseded, so "what did Jarvis believe back then" stays
  // answerable.
  document.querySelectorAll('.btn-correct-fact').forEach(btn => btn.addEventListener('click', async () => {
    const next = prompt('What should Jarvis go by instead?\n\nThe old version is kept on record, marked as replaced.', btn.dataset.text);
    if (next === null) return;
    const text = next.trim();
    if (!text || text === btn.dataset.text) return;
    const send = (followChain) => api(`/api/facts/${encodeURIComponent(btn.dataset.id)}/supersede`, {
      method: 'POST', body: JSON.stringify({ text, reason: 'corrected from dashboard', followChain }),
    });
    try {
      await send(false);
    } catch (err) {
      // The fact changed between this list being rendered and Correct being
      // clicked — she corrected it on WhatsApp, or the nightly review replaced
      // it. The server refuses by default and hands back what it collided
      // with, precisely so this can be a question rather than a lost edit.
      // Silently stacking her change on a version she has not seen is how two
      // people disagreeing turns into last-writer-wins with no trace.
      const head = err.currentHead;
      if (err.reason === 'already_superseded' && head) {
        const ok = confirm(
          `This fact changed since the page loaded.\n\nIt now reads:\n"${head.text}"\n\n` +
          `Apply your correction on top of that instead?\n\nYour text:\n"${text}"`);
        if (!ok) { loadTab('facts'); return; }
        await send(true);
      } else {
        alert(err.message || 'Could not apply that correction.');
        loadTab('facts');
        return;
      }
    }
    loadTab('facts');
  }));
  document.querySelectorAll('.btn-restore-fact').forEach(btn => btn.addEventListener('click', async () => {
    await api(`/api/facts/${encodeURIComponent(btn.dataset.id)}/unretract`, { method: 'POST', body: '{}' });
    loadTab('facts');
  }));
  document.querySelectorAll('.btn-pin-fact').forEach(btn => btn.addEventListener('click', async () => {
    const nowPinned = btn.dataset.pinned !== '1';
    await api(`/api/facts/${encodeURIComponent(btn.dataset.id)}`, { method: 'PATCH', body: JSON.stringify({ pinned: nowPinned }) });
    loadTab('facts');
  }));
}

// ── Sign out ──────────────────────────────────────────────────────────────
$('btnSignout').addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST' });
  location.href = '/login';
});

// The top "⚠ WhatsApp needs a QR scan / Open WhatsApp tab" banner has always
// been a plain <button id="linkDownBanner"> with no click handler wired to it
// anywhere in this file (confirmed by grep — this predates the QR-image fix
// and the pass-2 redesign). Wire it to actually switch tabs.
$('linkDownBanner').addEventListener('click', () => switchTab('whatsapp'));

// ── Notification bell (2026-08-06) ──────────────────────────────────────────
// GET /api/alerts (alerts.js's listAlerts()) already existed and already had
// every event type this bell shows — quote sent/failed/reminder/price/reply/
// escalated — nothing new to wire server-side except quote_leg_failed
// (added alongside the "still in queue" fix). "Unread" is purely a client
// concept — alerts.js has no read/unread field — tracked as a single
// last-seen timestamp in localStorage (real browser storage on Apsara's
// actual deployed site, not a Claude.ai artifact — persists across reloads,
// which is the point).
const ALERT_SEEN_KEY = 'jarvis_alerts_last_seen_at';
const ALERT_SEVERITY_COLOR = { high: 'var(--status-danger)', warning: 'var(--status-warning)', info: 'var(--status-info)' };
let alertBellPanelOpen = false;

function alertBellTimeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

async function refreshAlertBell() {
  let alerts = [];
  try { alerts = await api('/api/alerts'); } catch { return; } // e.g. logged out — fail quiet, boot()'s own api('/api/me') already handles that redirect
  const lastSeen = localStorage.getItem(ALERT_SEEN_KEY);
  const unseenCount = lastSeen ? alerts.filter(a => a.at > lastSeen).length : alerts.length;

  const badge = $('alertBellBadge');
  if (unseenCount > 0) { badge.textContent = unseenCount > 99 ? '99+' : String(unseenCount); badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');

  const list = $('alertBellList');
  list.innerHTML = alerts.length ? alerts.slice(0, 30).map(a => {
    const isUnseen = !lastSeen || a.at > lastSeen;
    const color = ALERT_SEVERITY_COLOR[a.severity] || 'var(--text-faint)';
    return `
      <div style="display:flex; gap:10px; padding:11px 14px; border-bottom:1px solid var(--border-subtle); ${isUnseen ? 'background:var(--surface-hover);' : ''}">
        <span style="flex-shrink:0; width:7px; height:7px; margin-top:5px; border-radius:50%; background:${color};"></span>
        <div style="min-width:0;">
          <div style="font-size:12.5px; color:var(--text-strong); line-height:1.4;">${esc(a.message)}</div>
          <div style="font-family:var(--font-mono); font-size:10px; color:var(--text-faint); margin-top:3px;">${alertBellTimeAgo(a.at)}</div>
        </div>
      </div>`;
  }).join('') : `<div style="padding:24px 14px; text-align:center; font-size:12.5px; color:var(--text-faint);">No notifications yet.</div>`;
}

function toggleAlertBellPanel(forceOpen) {
  alertBellPanelOpen = forceOpen ?? !alertBellPanelOpen;
  $('alertBellPanel').classList.toggle('hidden', !alertBellPanelOpen);
  if (alertBellPanelOpen) {
    // Opening the bell IS "read" — mark everything up to now seen, then
    // re-render so the badge clears and the highlighted-unseen rows drop
    // their highlight immediately rather than waiting for the next poll.
    localStorage.setItem(ALERT_SEEN_KEY, new Date().toISOString());
    refreshAlertBell();
  }
}
$('alertBellBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleAlertBellPanel(); });
document.addEventListener('click', (e) => {
  if (alertBellPanelOpen && !$('alertBell').contains(e.target)) toggleAlertBellPanel(false);
});

// ── Boot ──────────────────────────────────────────────────────────────────
async function boot() {
  $('todayLabel').textContent = new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric' });
  try { const me = await api('/api/me'); ROLE = me.role || 'user'; IS_SUPER = me.super === true; } catch {}
  // Jarvis first — its ROLE is 'admin', so the admin branch would otherwise
  // swallow it and nothing on screen would say this session can erase a paid
  // load.
  $('roleLabel').textContent = IS_SUPER ? 'Jarvis access' : ROLE === 'admin' ? 'Admin access' : 'Standard access';
  // Staff is scoped to the Loads tab only (see STAFF_ALLOWED_PATH_PREFIXES /
  // nav filtering in api.js and renderNav above) — landing them on 'board'
  // (the default CURRENT_TAB) would show a tab they can't use, or a nav with
  // only one visible item that doesn't match the loaded content. Send them
  // straight to Loads instead.
  if (ROLE === 'staff') CURRENT_TAB = 'loads';
  // ── /#tab=<id>: THE WAY BACK IN FROM A STANDALONE PAGE ─────────────────
  // Apsara 2026-10-08: "i want the sidebar to appear in all pages". The
  // standalone pages draw the same rail from dashboard/sidebar.js, and a row
  // there that is a tab of THIS app links to /#tab=bookings. Without this the
  // app would always open on Board and the click would look ignored.
  // Only a tab this role can see: the same filter renderNav applies, so a
  // hand-typed hash cannot draw a tab the rail would not show. The server
  // checks every route behind it anyway. The hash is then removed, so a
  // reload lands where it always has. (Accepting only NAV_ITEMS ids was my
  // call — the screen ids are the vocabulary the rail already uses.)
  try {
    const want = (String(location.hash || '').match(/^#tab=([a-z-]+)$/) || [])[1];
    const allowed = want && NAV_ITEMS.some((n) => n.id === want && (!n.adminOnly || ROLE === 'admin')
      && (ROLE !== 'staff' || n.id === 'loads' || n.id === 'petty' || n.id === 'trucker-bills'));
    if (allowed) CURRENT_TAB = want;
    if (want) history.replaceState(null, '', location.pathname + location.search);
  } catch (e) { /* a bad hash is not a reason to fail boot */ }
  // NOTE — wireTruckerModals() used to be called HERE and it broke the whole
  // dashboard. boot() runs from the inline script partway down the document;
  // the trucker modals are markup at the very end, after that script. So at
  // this point #trkClose did not exist yet, wiring threw a TypeError, and
  // renderNav() and loadTab() below never ran: a signed-in page with an empty
  // sidebar and an empty body. It is wired lazily from renderTruckerTab()
  // instead, by which time the document is fully parsed.
  renderNav();
  loadTab(CURRENT_TAB);
  if (ROLE === 'admin') {
    const poll = async () => { try { updateWaBadge(await api('/api/whatsapp/status')); } catch {} };
    poll();
    setInterval(poll, 15000);
  } else {
    $('waStatusText').textContent = 'Signed in';
    $('waStatusDot').style.background = 'var(--steel-500)';
  }
  // Notifications for everyone (trucker/supplier-facing send failures and
  // reply events matter to whoever's watching this dashboard, not just
  // admins) — same 15s cadence as the WA status poll above; the 5-min email
  // cron means anything faster than that just burns requests for no benefit.
  refreshAlertBell();
  setInterval(refreshAlertBell, 15000);
}
boot();
