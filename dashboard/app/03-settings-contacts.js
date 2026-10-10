// dashboard/app/03-settings-contacts.js — split from dashboard/index.html's <script> (helpers/sourceParts.js reconstructs the original)
function renderSettings(s) {
  let team = Array.isArray(s.internal_team) ? s.internal_team.map(x => typeof x === 'string' ? { name: '', whatsapp: x, role: '' } : x) : [];
  function teamRowsHtml() {
    return team.map((m, i) => `
      <div class="team-row" style="border:1px solid var(--border-subtle); border-radius:var(--radius-xs); padding:14px; margin-bottom:12px;" data-idx="${i}">
        <div style="display:grid; grid-template-columns:1fr 1fr 1fr auto; gap:12px; align-items:end;">
          <div class="field" style="margin-bottom:0;"><label>Name</label><input class="tm_name" value="${esc(m.name || '')}"></div>
          <div class="field" style="margin-bottom:0;"><label>WhatsApp</label><input class="tm_whatsapp" value="${esc(m.whatsapp || '')}"></div>
          <div class="field" style="margin-bottom:0;"><label>Role</label><input class="tm_role" value="${esc(m.role || '')}"></div>
          <button class="btn btn-danger btn-remove-team" data-idx="${i}">Remove</button>
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:10px;">
          <div class="field" style="margin-bottom:0;"><label>Group name</label><input class="tm_group_name grp-name-target" value="${esc(m.group_name || '')}" readonly style="background:var(--surface-sunken);"></div>
          <div class="field" style="margin-bottom:0;"><label>Group ID</label><input class="tm_group_id grp-id-target" value="${esc(m.group_id || '')}" readonly style="background:var(--surface-sunken);"></div>
        </div>
        <div style="display:flex; gap:10px; align-items:end; margin-top:10px;">
          <div class="field" style="flex:1; margin-bottom:0;"><label>Find group by name</label><input class="grp-search-input" placeholder="e.g. Ops Team"></div>
          <button class="btn btn-secondary grp-search-btn" style="padding:9px 14px;">Search</button>
        </div>
        <div class="grp-search-results" style="margin-top:8px; display:flex; flex-direction:column; gap:6px;"></div>
      </div>`).join('');
  }
  $('viewRoot').innerHTML = `
    <section style="max-width:820px; margin:0 auto; padding:38px 40px 80px;">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:22px;">
        <div><div class="eyebrow">// Settings</div><h2 style="font-size:24px; text-transform:uppercase;">Routing &amp; roles</h2></div>
        <button id="btnSaveSettings" class="btn btn-primary">Save changes</button>
      </div>
      <div id="settingsError" style="color:var(--status-danger); font-size:12.5px; margin-bottom:14px; display:none;"></div>
      <div id="settingsSaved" style="color:var(--leaf-600); font-size:12.5px; margin-bottom:14px; display:none;">Saved.</div>

      <!-- Two sub-tabs, per Apsara — Operations (everything that already lived
           here: manager/team/email routing) and Yard (the new end-of-day
           yard report recipients). Pure client-side toggle, no re-fetch —
           both panels' fields are already in the DOM/settings payload. -->
      <div style="display:flex; gap:8px; margin-bottom:20px; border-bottom:1px solid var(--border-subtle); padding-bottom:12px;">
        <button id="settingsTabOps" class="chip" data-active="true">Operations</button>
        <button id="settingsTabYard" class="chip">Yard</button>
      </div>

      <div id="settingsOpsPanel" style="display:flex; flex-direction:column; gap:16px;">
        <div class="card" style="padding:22px 24px;">
          <div style="font-family:var(--font-mono); font-size:11px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:var(--text-strong); margin-bottom:4px;">Manager</div>
          <div style="font-size:12.5px; color:var(--text-muted); margin-bottom:16px;">The one phone number recognised as the manager. All admin commands come from this number.</div>
          <div class="field"><label>Manager WhatsApp number</label><input id="s_manager" value="${esc(s.manager_number || '')}" placeholder="e.g. 918056944193"></div>
        </div>
        <div class="card" style="padding:22px 24px;">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px;">
            <div style="font-family:var(--font-mono); font-size:11px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:var(--text-strong);">Internal team</div>
            <button id="btnAddTeam" class="btn btn-secondary" style="padding:7px 14px;">+ Add member</button>
          </div>
          <div style="font-size:12.5px; color:var(--text-muted); margin-bottom:8px;">People who can send commands and receive alerts — same access level as the manager, including price list.</div>
          <div style="font-size:11.5px; color:var(--copper-onSoft); background:var(--copper-soft); border-radius:var(--radius-xs); padding:8px 12px; margin-bottom:16px;">Group name/ID below are saved for your reference only. Command access is granted by matching this person's WhatsApp number, or by the shared "Team WhatsApp group" field further down.</div>
          <div id="teamRows">${teamRowsHtml()}</div>
        </div>
        <div class="card" style="padding:22px 24px;">
          <div style="font-family:var(--font-mono); font-size:11px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:var(--text-strong); margin-bottom:4px;">Team WhatsApp group</div>
          <div style="font-size:12.5px; color:var(--text-muted); margin-bottom:16px;">Alerts and team messages route here instead of the manager's DM. Jarvis must already be a member of the group — add it on your phone first, then search by name below.</div>
          <div class="field"><label>Team group ID</label><input id="s_group" class="grp-id-target" value="${esc(s.team_group_id || '')}" placeholder="120363123456789012@g.us"></div>
          <div style="display:flex; gap:10px; align-items:end; margin-top:12px;">
            <div class="field" style="flex:1; margin-bottom:0;"><label>Find group by name</label><input class="grp-search-input" id="groupSearch" placeholder="e.g. Edge Metals Ops"></div>
            <button class="btn btn-secondary grp-search-btn" id="btnFindGroup">Search</button>
          </div>
          <div class="grp-search-results" id="groupResults" style="margin-top:10px; display:flex; flex-direction:column; gap:6px;"></div>
        </div>
        <div class="card" style="padding:22px 24px;">
          <div style="font-family:var(--font-mono); font-size:11px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:var(--text-strong); margin-bottom:4px;">Email watcher (Gmail)</div>
          <div style="font-size:12.5px; color:var(--text-muted); margin-bottom:14px;">Polls Gmail every 15 minutes for booking-confirmation PDFs, auto-creates/updates bookings, and applies carrier date changes automatically. Turning this off stops the poll immediately — takes effect on the next tick, no restart needed.</div>
          <label style="display:flex; align-items:center; gap:10px; font-size:13px; color:var(--text-strong); cursor:pointer; margin-bottom:12px;">
            <input id="s_email_watcher_enabled" type="checkbox" ${s.gmail_watch_enabled ? 'checked' : ''} style="width:16px; height:16px; margin:0;">
            Email watcher enabled
          </label>
          <div style="font-family:var(--font-mono); font-size:11.5px; color:var(--text-faint);">
            Last active: ${s.gmail_watcher_last_run
              ? esc(new Date(s.gmail_watcher_last_run).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })) + ' (LA time)'
              : 'never run yet'}
          </div>
        </div>
        <div class="card" style="padding:22px 24px;">
          <div style="font-family:var(--font-mono); font-size:11px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:var(--text-strong); margin-bottom:4px;">Outbound email — Cc / Bcc</div>
          <div style="font-size:12.5px; color:var(--text-muted); margin-bottom:16px;">Applied to every email Jarvis drafts — composing new mail or replying in a thread — before you confirm sending. Comma-separate multiple addresses. Leave blank for none.</div>
          <div class="field"><label>Cc</label><input id="s_email_cc" value="${esc(s.email_cc || '')}" placeholder="e.g. ops@edgemetals.com"></div>
          <div class="field" style="margin-bottom:0;"><label>Bcc</label><input id="s_email_bcc" value="${esc(s.email_bcc || '')}" placeholder="e.g. bose@edgemetals.com"></div>
        </div>
      </div>

      <div id="settingsYardPanel" class="hidden" style="display:flex; flex-direction:column; gap:16px;">
        <div class="card" style="padding:22px 24px;">
          <div style="font-family:var(--font-mono); font-size:11px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:var(--text-strong); margin-bottom:4px;">End-of-day yard report — on/off</div>
          <div style="font-size:12.5px; color:var(--text-muted); margin-bottom:14px;">Master switch for the whole 8:00 PM Eastern report below — both the email and the WhatsApp send. Off by default until you turn it on here.</div>
          <label style="display:flex; align-items:center; gap:10px; font-size:13px; color:var(--text-strong); cursor:pointer;">
            <input id="s_yard_report_enabled" type="checkbox" ${s.yard_report_enabled ? 'checked' : ''} style="width:16px; height:16px; margin:0;">
            Send the daily yard report
          </label>
        </div>
        <div class="card" style="padding:22px 24px;">
          <div style="font-family:var(--font-mono); font-size:11px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:var(--text-strong); margin-bottom:4px;">End-of-day yard report — email</div>
          <div style="font-size:12.5px; color:var(--text-muted); margin-bottom:16px;">Every day at 8:00 PM Eastern, Jarvis emails the priced ticket + weights PDF for every load dated that day to everyone listed here. Comma-separate multiple addresses.</div>
          <div class="field" style="margin-bottom:0;"><label>Recipients</label><input id="s_yard_emails" value="${esc(s.yard_report_emails || '')}" placeholder="e.g. bose@edgemetals.com, apsara@edgemetals.com"></div>
        </div>
        <div class="card" style="padding:22px 24px;">
          <div style="font-family:var(--font-mono); font-size:11px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:var(--text-strong); margin-bottom:4px;">End-of-day yard report — WhatsApp</div>
          <div style="font-size:12.5px; color:var(--text-muted); margin-bottom:16px;">Same 8:00 PM Eastern run also posts a text summary (load count, totals, per-load breakdown) to this group and/or these numbers. Jarvis must already be a member of the group.</div>
          <div class="field"><label>Yard update group ID</label><input id="s_yard_group" class="grp-id-target" value="${esc(s.yard_whatsapp_group_id || '')}" placeholder="120363123456789012@g.us"></div>
          <div style="display:flex; gap:10px; align-items:end; margin-top:12px; margin-bottom:16px;">
            <div class="field" style="flex:1; margin-bottom:0;"><label>Find group by name</label><input class="grp-search-input" id="yardGroupSearch" placeholder="e.g. Edge Metals Yard"></div>
            <button class="btn btn-secondary grp-search-btn" id="btnFindYardGroup">Search</button>
          </div>
          <div class="grp-search-results" id="yardGroupResults" style="margin-bottom:16px; display:flex; flex-direction:column; gap:6px;"></div>
          <div class="field" style="margin-bottom:0;"><label>Additional individual numbers</label><input id="s_yard_contacts" value="${esc(s.yard_whatsapp_contacts || '')}" placeholder="e.g. 918056944193, 917000011122"></div>
        </div>
        <div class="card" style="padding:22px 24px;">
          <div style="font-family:var(--font-mono); font-size:11px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:var(--text-strong); margin-bottom:4px;">Load numbering</div>
          <div style="font-size:12.5px; color:var(--text-muted); margin-bottom:16px;">Sets a floor for the next auto-assigned load number (e.g. entering 500 means the next new load is EDGE_500, not the usual next-in-sequence). Every load after that keeps counting up from it automatically — you don't need to touch this again unless you want to jump the sequence forward again. Leave blank for normal behavior.</div>
          <div class="field" style="margin-bottom:0; max-width:220px;"><label>Next load number</label><input id="s_next_load_number" type="number" min="1" value="${esc(s.next_load_number ?? '')}" placeholder="e.g. 500"></div>
        </div>
        <div class="card" style="padding:22px 24px;">
          <div style="font-family:var(--font-mono); font-size:11px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:var(--text-strong); margin-bottom:4px;">Item description list</div>
          <div style="font-size:12.5px; color:var(--text-muted); margin-bottom:16px;">The descriptions offered while typing an item on a load. Anything new typed on a load is added here automatically. Renaming or removing one here only changes what future loads are offered — loads that already used the old wording keep it, and so do their PDFs and monthly sheets.</div>
          <div style="display:flex; gap:8px; margin-bottom:14px; max-width:420px;">
            <input id="itemTypeNew" placeholder="Add a description" style="flex:1; min-width:0; padding:10px 12px; background:var(--surface-sunken); border:1px solid var(--border-default); border-radius:var(--radius-sm); color:var(--text-strong); outline:none;">
            <button id="btnAddItemType" class="btn btn-primary" style="padding:10px 16px; font-size:11px;">Add</button>
          </div>
          <div id="itemTypeRows" style="display:flex; flex-direction:column; gap:8px;"><div style="font-family:var(--font-mono); font-size:11.5px; color:var(--text-faint);">Loading…</div></div>
        </div>
      </div>
    </section>`;

  function refreshTeamRows() { $('teamRows').innerHTML = teamRowsHtml(); wireTeamRows(); }
  function wireTeamRows() {
    document.querySelectorAll('.btn-remove-team').forEach(btn => btn.addEventListener('click', () => { team.splice(Number(btn.dataset.idx), 1); refreshTeamRows(); }));
    document.querySelectorAll('#teamRows .team-row').forEach(row => row.querySelector('.grp-search-btn').addEventListener('click', () => doGroupSearch(row)));
  }
  wireTeamRows();
  $('btnAddTeam').addEventListener('click', () => { team.push({ name: '', whatsapp: '', role: '', group_id: '', group_name: '' }); refreshTeamRows(); });

  function showSettingsTab(tab) {
    $('settingsOpsPanel').classList.toggle('hidden', tab !== 'ops');
    $('settingsYardPanel').classList.toggle('hidden', tab !== 'yard');
    $('settingsTabOps').dataset.active = String(tab === 'ops');
    $('settingsTabYard').dataset.active = String(tab === 'yard');
    $('settingsTabOps').style.background = tab === 'ops' ? 'var(--accent)' : '';
    $('settingsTabOps').style.color = tab === 'ops' ? '#fff' : '';
    $('settingsTabYard').style.background = tab === 'yard' ? 'var(--accent)' : '';
    $('settingsTabYard').style.color = tab === 'yard' ? '#fff' : '';
  }
  $('settingsTabOps').addEventListener('click', () => showSettingsTab('ops'));
  $('settingsTabYard').addEventListener('click', () => showSettingsTab('yard'));
  showSettingsTab('ops');

  $('btnSaveSettings').addEventListener('click', async () => {
    $('settingsError').style.display = 'none'; $('settingsSaved').style.display = 'none';
    document.querySelectorAll('#teamRows .team-row').forEach((row, i) => {
      team[i] = {
        name: row.querySelector('.tm_name').value.trim(),
        whatsapp: row.querySelector('.tm_whatsapp').value.replace(/\D/g, ''),
        role: row.querySelector('.tm_role').value.trim(),
        group_id: row.querySelector('.tm_group_id').value.trim() || null,
        group_name: row.querySelector('.tm_group_name').value.trim() || null,
      };
    });
    const managerNum = $('s_manager').value.trim().replace(/\D/g, '');
    if (!managerNum) { $('settingsError').textContent = 'Manager number is required.'; $('settingsError').style.display = 'block'; return; }
    const cleanedTeam = team.filter(m => (m.name && m.name.trim()) || (m.whatsapp && m.whatsapp.trim()));
    try {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify({
        manager_number: managerNum, internal_team: cleanedTeam, team_group_id: $('s_group').value.trim(),
        gmail_watch_enabled: $('s_email_watcher_enabled').checked,
        email_cc: $('s_email_cc').value.trim(), email_bcc: $('s_email_bcc').value.trim(),
        yard_report_emails: $('s_yard_emails').value.trim(),
        yard_whatsapp_group_id: $('s_yard_group').value.trim(),
        yard_whatsapp_contacts: $('s_yard_contacts').value.trim(),
        next_load_number: $('s_next_load_number').value.trim() ? parseInt($('s_next_load_number').value.trim(), 10) : null,
        yard_report_enabled: $('s_yard_report_enabled').checked,
      }) });
      $('settingsSaved').style.display = 'block';
    } catch (e) { $('settingsError').textContent = e.message; $('settingsError').style.display = 'block'; }
  });

  $('btnFindGroup').addEventListener('click', () => doGroupSearch($('groupSearch').closest('.card')));
  $('btnFindYardGroup').addEventListener('click', () => doGroupSearch($('yardGroupSearch').closest('.card')));

  loadItemTypeRows();
}

// ── Item description catalog manager (Settings > Yard) ────────────────
// Mirrors the mobile app's renderItemTypeManager. Per Apsara 2026-08-20 the
// list is manageable from staff and admin settings alike; on this side that
// means the Settings tab, which admin reaches directly.
async function loadItemTypeRows() {
  const rows = $('itemTypeRows');
  if (!rows) return; // panel not mounted (settings re-rendered/left before this resolved)
  try {
    // No client-side sort: GET /api/item-types is already A-Z (see
    // helpers/itemTypes.js). Sorting again here is how the managed list and
    // the list people pick from used to end up ordered differently.
    const types = await api('/api/item-types');
    rows.innerHTML = types.length ? types.map(d => `
      <div style="display:flex; align-items:center; gap:10px; padding:9px 12px; background:var(--surface-sunken); border-radius:var(--radius-xs);" data-desc="${esc(d)}">
        <span style="flex:1; min-width:0; font-size:13px; color:var(--text-strong); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(d)}</span>
        <button class="btn btn-ren-item-type" data-desc="${esc(d)}" style="padding:6px 12px; font-size:10px;">Rename</button>
        <button class="btn btn-danger btn-del-item-type" data-desc="${esc(d)}" style="padding:6px 12px; font-size:10px;">Remove</button>
      </div>`).join('') : '<div style="font-family:var(--font-mono); font-size:11.5px; color:var(--text-faint); text-align:center; padding:10px 0;">No descriptions yet — they appear here as soon as one is used on a load, or add one above.</div>';

    rows.querySelectorAll('.btn-ren-item-type').forEach(btn => btn.addEventListener('click', async () => {
      const from = btn.dataset.desc;
      const to = prompt(`Rename "${from}" to:`, from);
      if (to === null) return;                       // cancelled
      if (!to.trim() || to.trim() === from) return;  // blank or unchanged
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        const r = await api('/api/item-types', { method: 'PUT', body: JSON.stringify({ from, to: to.trim() }) });
        // customItemTypes is the in-memory cache the load form's type-ahead
        // reads (see itemDescOptions() above) — keep it in step so the old
        // wording doesn't linger as a suggestion until the next page load.
        customItemTypes = customItemTypes.filter(x => String(x).toLowerCase() !== from.toLowerCase());
        if (!r.merged) customItemTypes.push(to.trim());
        loadItemTypeRows();
      } catch (e) { alert(e.message); btn.disabled = false; btn.textContent = 'Rename'; }
    }));

    rows.querySelectorAll('.btn-del-item-type').forEach(btn => btn.addEventListener('click', async () => {
      if (!confirm(`Remove "${btn.dataset.desc}" from the item description list?\n\nLoads that already used it keep it — this only stops it being suggested.`)) return;
      btn.disabled = true; btn.textContent = 'Removing…';
      try {
        await api('/api/item-types', { method: 'DELETE', body: JSON.stringify({ description: btn.dataset.desc }) });
        customItemTypes = customItemTypes.filter(x => String(x).toLowerCase() !== btn.dataset.desc.toLowerCase());
        loadItemTypeRows();
      } catch (e) { alert(e.message); btn.disabled = false; btn.textContent = 'Remove'; }
    }));

    // Add straight from Settings, so the catalog can be curated before
    // anyone types a load — the auto-add-on-save path only ever grows the
    // list as a side effect of real work. Wired here rather than in
    // wireSettingsEvents because this whole section is re-rendered by
    // loadItemTypeRows and the buttons above are wired the same way.
    const addBtn = $('btnAddItemType'), addInput = $('itemTypeNew');
    if (addBtn && addInput && !addBtn.dataset.wired) {
      addBtn.dataset.wired = '1';
      const add = async () => {
        const v = addInput.value.trim();
        if (!v) return;
        addBtn.disabled = true;
        try {
          await api('/api/item-types', { method: 'POST', body: JSON.stringify({ description: v }) });
          if (!customItemTypes.some(x => String(x).toLowerCase() === v.toLowerCase())) customItemTypes.push(v);
          addInput.value = '';
          loadItemTypeRows();
        } catch (e) { alert(e.message); } finally { addBtn.disabled = false; }
      };
      addBtn.addEventListener('click', add);
      addInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); add(); } });
    }
  } catch (e) {
    rows.innerHTML = `<div style="color:var(--status-danger); font-size:12px;">Couldn't load the description list: ${esc(e.message)}</div>`;
  }
}

// ── CONTACTS (price-list send-to contacts — separate from the Settings tab
// so they're easy to find; moved here from Settings on request) ─────────────
// Group support added 2026-08-16 per Apsara ("what if i want to share it
// to a group?") — a saved contact is now either an individual (whatsapp) OR
// a WhatsApp group (groupId), never both; see helpers/pricelist.js's
// contactChatId() for how sending branches on which one a contact has.
// "+ Add group" reuses the exact same doGroupSearch()/grp-search-* pattern
// Settings already uses for the Team/Yard WhatsApp groups — same search API
// call, same result-picker markup, just a different save target.
const PRICE_CITIES = ['Los Angeles', 'Houston', 'San Antonio'];
function renderPriceContacts() {
  $('viewRoot').innerHTML = `
    <section style="max-width:820px; margin:0 auto; padding:38px 40px 80px;">
      ${pageHead('Price lists', {
        note: 'Save a name once, then just say \\"send price list to &lt;name&gt;\\".',
        chips: ['say "send price list to <name>"'],
        actions: `<button id="btnAddPriceGroup" class="btn btn-secondary">+ Add group</button>
          <button id="btnAddPriceContact" class="btn btn-primary">+ Add contact</button>`,
      })}
      <div style="font-size:13px; color:var(--text-muted); margin-bottom:22px;">Save a name once, then just say "send price list to &lt;name&gt;" on WhatsApp instead of typing a number. Groups work the same way — search by name, save it, then send to it exactly like an individual contact. "Standing" contacts (individual or group) also get the auto-notify when a price changes.</div>

      <div id="pcAddGroupBox" class="card hidden" style="padding:20px 22px; margin-bottom:16px;">
        <div style="font-family:var(--font-mono); font-size:11px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:var(--text-strong); margin-bottom:12px;">Add a WhatsApp group</div>
        <div style="display:flex; gap:10px; align-items:end; margin-bottom:10px;">
          <div class="field" style="flex:1; margin-bottom:0;"><label>Find group by name</label><input class="grp-search-input" id="pcGroupSearch" placeholder="e.g. Edge Metals Buyers"></div>
          <button class="btn btn-secondary grp-search-btn" id="btnPcGroupSearch" style="padding:9px 14px;">Search</button>
        </div>
        <div class="grp-search-results" id="pcGroupResults" style="margin-bottom:10px; display:flex; flex-direction:column; gap:6px;"></div>
        <input type="hidden" class="grp-id-target" id="pcGroupIdField">
        <input type="hidden" class="grp-name-target" id="pcGroupNameField">
        <div id="pcGroupPicked" class="hidden" style="font-size:12.5px; color:var(--text-strong); margin-bottom:10px;"></div>
        <div class="field" style="margin-bottom:12px;"><label>Save as (display name)</label><input id="pcGroupSaveName" placeholder="Defaults to the group's own name"></div>
        <label style="display:flex; align-items:center; gap:9px; font-size:12.5px; color:var(--text-muted); cursor:pointer; margin-bottom:14px;">
          <input id="pcGroupStanding" type="checkbox" style="width:16px; height:16px; margin:0;">
          Standing — also auto-notify this group when a price changes
        </label>
        <div id="pcAddGroupError" style="color:var(--status-danger); font-size:12px; margin-bottom:10px;"></div>
        <div style="display:flex; gap:10px;">
          <button id="btnPcSaveGroup" class="btn btn-primary">Save group</button>
          <button id="btnPcCancelGroup" class="btn btn-secondary">Cancel</button>
        </div>
      </div>

      <div class="card" style="padding:22px 24px;">
        <div id="priceContactRows" style="display:flex; flex-direction:column; gap:10px;"><div style="font-family:var(--font-mono); font-size:11.5px; color:var(--text-faint);">Loading…</div></div>
      </div>
    </section>`;

  async function loadPriceContacts() {
    const rows = $('priceContactRows');
    try {
      const contacts = await api('/api/pricelist/contacts');
      rows.innerHTML = contacts.length ? contacts.map(c => `
        <div style="display:grid; grid-template-columns:1fr auto auto auto auto; gap:10px; align-items:center; padding:10px 12px; background:var(--surface-sunken); border-radius:var(--radius-xs);" data-name="${esc(c.name)}">
          <div>
            <div style="font-size:13px; font-weight:600; color:var(--text-strong);">${esc(c.name)} ${c.groupId ? '<span class="badge" style="background:var(--blue-500,#3A6EA5); color:#fff; margin-left:6px;">Group</span>' : ''} ${c.standing ? '<span class="badge" style="background:var(--accent-soft); color:var(--accent-onSoft); margin-left:6px;">Standing</span>' : ''}</div>
            <div style="font-family:var(--font-mono); font-size:11px; color:var(--text-faint);">${c.groupId ? esc(c.groupId) : esc(c.whatsapp)}</div>
          </div>
          <select class="pc_city" style="padding:7px 10px; border:1px solid var(--border-default); border-radius:var(--radius-xs); font-size:12px;">${PRICE_CITIES.map(city => `<option value="${esc(city)}">${esc(city)}</option>`).join('')}</select>
          <button class="btn btn-primary btn-send-price" data-name="${esc(c.name)}" style="padding:7px 12px; font-size:10px;">Send</button>
          <span class="pc_status" style="font-family:var(--font-mono); font-size:10.5px; color:var(--text-muted);"></span>
          <button class="btn btn-danger btn-del-price-contact" data-name="${esc(c.name)}" style="padding:7px 12px; font-size:10px;">Remove</button>
        </div>`).join('') : '<div style="font-family:var(--font-mono); font-size:11.5px; color:var(--text-faint); text-align:center; padding:10px 0;">No saved contacts yet.</div>';
      document.querySelectorAll('.btn-send-price').forEach(btn => btn.addEventListener('click', async () => {
        const row = btn.closest('[data-name]'); const city = row.querySelector('.pc_city').value; const statusEl = row.querySelector('.pc_status');
        statusEl.textContent = 'Sending…';
        try {
          const result = await api('/api/pricelist/send-city', { method: 'POST', body: JSON.stringify({ to: btn.dataset.name, city }) });
          statusEl.textContent = result.ok ? `Sent to ${result.target}` : 'Failed'; statusEl.style.color = result.ok ? 'var(--leaf-600)' : 'var(--status-danger)';
        } catch (e) { statusEl.textContent = e.message; statusEl.style.color = 'var(--status-danger)'; }
      }));
      document.querySelectorAll('.btn-del-price-contact').forEach(btn => btn.addEventListener('click', async () => {
        if (!confirm(`Remove ${btn.dataset.name} from price list contacts?`)) return;
        await api(`/api/pricelist/contacts/${encodeURIComponent(btn.dataset.name)}`, { method: 'DELETE' });
        loadPriceContacts();
      }));
    } catch (e) { rows.innerHTML = `<div style="font-family:var(--font-mono); font-size:11.5px; color:var(--status-danger);">${esc(e.message)}</div>`; }
  }
  $('btnAddPriceContact').addEventListener('click', async () => {
    const name = prompt('Contact name:'); if (!name) return;
    const whatsapp = prompt('WhatsApp number (digits only, e.g. 918056944193):'); if (!whatsapp) return;
    const standing = confirm('Should this contact also get the auto price-change notification (one of the 3 standing recipients)?');
    try { await api('/api/pricelist/contacts', { method: 'POST', body: JSON.stringify({ name, whatsapp, standing }) }); loadPriceContacts(); }
    catch (e) { alert(e.message); }
  });

  // ── Add a group ───────────────────────────────────────────────────────
  function resetPcGroupBox() {
    $('pcGroupSearch').value = ''; $('pcGroupResults').innerHTML = '';
    $('pcGroupIdField').value = ''; $('pcGroupNameField').value = '';
    $('pcGroupSaveName').value = ''; $('pcGroupStanding').checked = false;
    $('pcGroupPicked').classList.add('hidden'); $('pcGroupPicked').textContent = '';
    $('pcAddGroupError').textContent = '';
  }
  $('btnAddPriceGroup').addEventListener('click', () => {
    resetPcGroupBox();
    $('pcAddGroupBox').classList.remove('hidden');
  });
  $('btnPcCancelGroup').addEventListener('click', () => $('pcAddGroupBox').classList.add('hidden'));
  $('btnPcGroupSearch').addEventListener('click', async () => {
    await doGroupSearch($('pcAddGroupBox'));
    // doGroupSearch's own "Use" handler (wired inside that shared function)
    // already fills pcGroupIdField/pcGroupNameField and clears the results
    // box — this second listener on the same buttons just adds the
    // Price-Lists-specific bits doGroupSearch doesn't know about: a visible
    // "Selected: ..." confirmation and defaulting the save-as name to the
    // group's own name (still editable before Save).
    $('pcGroupResults').querySelectorAll('.grp-use').forEach(btn => btn.addEventListener('click', () => {
      $('pcGroupPicked').classList.remove('hidden');
      $('pcGroupPicked').textContent = `Selected: ${btn.dataset.name || '(unnamed group)'}`;
      if (!$('pcGroupSaveName').value.trim()) $('pcGroupSaveName').value = btn.dataset.name || '';
    }));
  });
  $('btnPcSaveGroup').addEventListener('click', async () => {
    const groupId = $('pcGroupIdField').value.trim();
    const name = $('pcGroupSaveName').value.trim();
    const standing = $('pcGroupStanding').checked;
    if (!groupId) { $('pcAddGroupError').textContent = 'Search for and select a group first.'; return; }
    if (!name) { $('pcAddGroupError').textContent = 'A display name is required.'; return; }
    const btn = $('btnPcSaveGroup');
    btn.disabled = true; const original = btn.textContent; btn.textContent = 'Saving…';
    try {
      await api('/api/pricelist/contacts', { method: 'POST', body: JSON.stringify({ name, groupId, standing }) });
      $('pcAddGroupBox').classList.add('hidden');
      loadPriceContacts();
    } catch (e) {
      $('pcAddGroupError').textContent = e.message;
    } finally {
      btn.disabled = false; btn.textContent = original;
    }
  });

  loadPriceContacts();
}

// Saved name→email directory used by draft_email/reply_email on WhatsApp
// ("email Zimex about DALA123" resolves against this before falling back to
// a fresh Gmail search) — see helpers/emailContacts.js.
//
// DOMAIN GROUPS (added 2026-08-04) — records that share a `domain` field
// (built via "learn X contacts" on WhatsApp, or scripts/learnDomain.js) are
// now grouped into their own card instead of sitting in the flat list
// looking like unrelated one-off contacts. Storage itself never changed —
// still the same flat array api.js/loadContacts() has always returned —
// this is purely a rendering change, same GET/POST/DELETE endpoints as
// before. Plain single-name contacts (no domain field, e.g. "jeyshree")
// still render in the simple flat list underneath, unchanged from before.
function renderEmailContacts() {
  const ROLE_STYLE = {
    primary:   { bg: 'var(--accent-soft)', fg: 'var(--accent-onSoft)', label: 'Primary' },
    secondary: { bg: 'var(--surface-sunken)', fg: 'var(--text-muted)', label: 'Secondary' },
    shared:    { bg: 'var(--leaf-100, #e7f3ea)', fg: 'var(--leaf-600, #1a7a3c)', label: 'Shared / mailbox' },
  };
  const roleBadge = (role) => {
    const s = ROLE_STYLE[role];
    if (!s) return '';
    return `<span class="badge" style="margin-left:6px; background:${s.bg}; color:${s.fg};">${esc(s.label)}</span>`;
  };
  const memberRow = (m) => `
    <div style="display:grid; grid-template-columns:1fr auto; gap:10px; align-items:center; padding:9px 11px; background:var(--surface-sunken); border-radius:var(--radius-xs);" data-name="${esc(m.name)}">
      <div>
        <div style="font-size:13px; font-weight:600; color:var(--text-strong);">${esc(m.displayName || m.name)}${roleBadge(m.role)}</div>
        <div style="font-family:var(--font-mono); font-size:11px; color:var(--text-faint);">"${esc(m.name)}" → ${esc(m.email)}</div>
        ${Array.isArray(m.cc) && m.cc.length ? `<div style="font-size:11px; color:var(--text-muted); margin-top:2px;">Cc: ${esc(m.cc.join(', '))}</div>` : ''}
      </div>
      <div style="display:flex; gap:6px;">
        <button class="btn btn-secondary btn-edit-email-contact" data-name="${esc(m.name)}" style="padding:7px 12px; font-size:10px;">Edit</button>
        <button class="btn btn-danger btn-del-email-contact" data-name="${esc(m.name)}" style="padding:7px 12px; font-size:10px;">Remove</button>
      </div>
    </div>
    <div class="email-contact-editor hidden" data-editor-for="${esc(m.name)}" style="padding:12px; background:var(--surface-card); border:1px solid var(--border-default); border-radius:var(--radius-xs); margin-top:-4px;">
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:10px;">
        <div class="field"><label style="font-size:10px;">Name Jarvis matches on</label><input class="ec-name" value="${esc(m.name)}"></div>
        <div class="field"><label style="font-size:10px;">Display name (optional)</label><input class="ec-display" value="${esc(m.displayName || '')}"></div>
        <div class="field"><label style="font-size:10px;">Email address</label><input class="ec-email" value="${esc(m.email)}"></div>
        <div class="field"><label style="font-size:10px;">Standing Cc (comma-separated)</label><input class="ec-cc" value="${esc(Array.isArray(m.cc) ? m.cc.join(', ') : '')}"></div>
      </div>
      <!-- ── THE GROUP, EDITABLE ──────────────────────────────────────
           Apsara, 2026-09-20, on a contact the harvest had filed under a
           HOTMAIL.COM group: "if i want to change the domain-??"

           She could not: this line used to read "that stays as it is", so
           a wrong grouping was permanent unless she deleted the contact
           and retyped it — losing the standing Cc with it. That is the
           same delete-and-retype hole the Edit button exists to close.

           Emptying the domain takes the contact OUT of its group; the
           role goes with it, because a role with no group is a label
           nothing can act on. -->
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:10px;">
        <div class="field"><label style="font-size:10px;">Company group (domain) — empty means none</label>
          <input class="ec-domain" value="${esc(m.domain || '')}" placeholder="e.g. radmetals.com"></div>
        <div class="field"><label style="font-size:10px;">Role in that group</label>
          <select class="ec-role">
            <option value="" ${!m.role ? 'selected' : ''}>—</option>
            <option value="primary" ${m.role === 'primary' ? 'selected' : ''}>Primary — a bare company name resolves here</option>
            <option value="secondary" ${m.role === 'secondary' ? 'selected' : ''}>Secondary</option>
            <option value="shared" ${m.role === 'shared' ? 'selected' : ''}>Shared / mailbox</option>
          </select></div>
      </div>
      <div style="font-size:11px; color:var(--text-faint); margin-bottom:8px;">Everyone in a group auto-cc's everyone else — so only group people who really are colleagues.</div>
      <div style="display:flex; justify-content:flex-end; gap:8px;">
        <button class="btn btn-secondary ec-cancel" style="padding:6px 12px; font-size:10px;">Cancel</button>
        <button class="btn btn-primary ec-save" data-name="${esc(m.name)}" style="padding:6px 12px; font-size:10px;">Save changes</button>
      </div>
    </div>`;

  $('viewRoot').innerHTML = `
    <section style="max-width:820px; margin:0 auto; padding:38px 40px 80px;">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:22px;">
        <div><div class="eyebrow">// Contacts</div><h2 style="font-size:24px; text-transform:uppercase;">Email contacts</h2></div>
        <div style="display:flex; gap:8px;">
          <!-- ── LEARN FROM MAIL ──────────────────────────────────────
               Apsara, 2026-09-19: "is there any option to learn email
               contacts..?" -> "How to learn all the email contacts?" ->
               "from email to email contacts tab" -> "save it".

               There was an option and it was not this one: "learn <company>
               contacts" on WhatsApp learns ONE company she names. This is
               the whole mailbox, and it belongs on the tab she was looking
               at when she asked rather than in a chat command she has to
               remember the wording of. -->
          <button id="btnHarvestContacts" class="btn btn-secondary" title="Scan recent mail and propose contacts">Learn from my mail</button>
          <button id="btnAddEmailContact" class="btn btn-primary">+ Add contact</button>
        </div>
      </div>
      <div style="font-size:13px; color:var(--text-muted); margin-bottom:22px;">Save a name once, then just say "email &lt;name&gt; about ..." or "reply to &lt;name&gt;..." on WhatsApp — Jarvis checks here before searching mail. Learned automatically too. For a company with multiple people, say "learn &lt;company&gt; contacts" on WhatsApp instead of adding them one by one — Jarvis scans real mail, proposes each person's role, and groups them below once confirmed. Primary is who a bare company name resolves to by default; everyone in a group auto-cc's everyone else.</div>
      <div id="emailDomainGroups"></div>
      <div class="card" style="padding:22px 24px;">
        <div class="eyebrow" style="margin-bottom:12px;">// Other contacts</div>
        <div id="emailContactRows" style="display:flex; flex-direction:column; gap:10px;"><div style="font-family:var(--font-mono); font-size:11.5px; color:var(--text-faint);">Loading…</div></div>
      </div>
    </section>`;

  async function loadEmailContacts() {
    const groupsEl = $('emailDomainGroups');
    const rows = $('emailContactRows');
    try {
      const contacts = await api('/api/email-contacts');
      const grouped = {};
      const flat = [];
      contacts.forEach((c) => { if (c.domain) (grouped[c.domain] = grouped[c.domain] || []).push(c); else flat.push(c); });

      const roleOrder = { primary: 0, secondary: 1, shared: 2 };
      const domains = Object.keys(grouped).sort();
      // ── A CONSUMER PROVIDER IS NOT A COMPANY ──────────────────────────
      // Kept in step with helpers/contactHarvest.js's FREEMAIL list. A group
      // headed GMAIL.COM is six strangers who auto-cc each other, and saying
      // so on the header is the difference between her noticing and not.
      const FREEMAIL_UI = ['gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.co.uk',
        'outlook.com', 'live.com', 'msn.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in',
        'ymail.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com', 'protonmail.com',
        'proton.me', 'gmx.com', 'gmx.de', 'mail.com', 'zoho.com', 'yandex.com', 'qq.com',
        '163.com', '126.com', 'naver.com', 'daum.net', 'hanmail.net', 'rediffmail.com'];

      groupsEl.innerHTML = domains.map((domain) => {
        const members = grouped[domain].slice().sort((a, b) => (roleOrder[a.role] ?? 9) - (roleOrder[b.role] ?? 9));
        const isFree = FREEMAIL_UI.includes(String(domain).toLowerCase());
        return `<div class="card" style="padding:18px 20px; margin-bottom:16px;">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px;">
            <div style="font-size:13px; font-weight:700; color:var(--text-strong); text-transform:uppercase;">${esc(domain)}</div>
            <!-- ── MOVE THE WHOLE GROUP ─────────────────────────────────
                 Apsara, 2026-09-20, on six unrelated suppliers under
                 GMAIL.COM: "give an option to move it to diff domain."
                 Editing them one at a time is six rounds of open, clear,
                 save — and the sixth is the one that gets forgotten, which
                 leaves the group half-dismantled and still auto-ccing. -->
            <button class="btn btn-secondary btn-regroup" data-domain="${esc(domain)}"
              style="padding:5px 11px; font-size:10px;">Move all ${members.length}…</button>
          </div>
          ${isFree ? `<div style="font-size:11.5px; color:var(--status-warn); margin:-4px 0 12px;">${esc(domain)} is a mail provider, not a company — these ${members.length} people are not colleagues, but everyone here auto-cc's everyone else. "Move all" with the box left empty separates them.</div>` : ''}
          <div style="display:flex; flex-direction:column; gap:8px;">${members.map(memberRow).join('')}</div>
        </div>`;
      }).join('');

      document.querySelectorAll('.btn-regroup').forEach((btn) => btn.addEventListener('click', async () => {
        const domain = btn.dataset.domain;
        const names = (grouped[domain] || []).map((c) => c.name);
        const to = prompt(
          `Move all ${names.length} contacts out of "${domain}".`
          + `\n\nType the company domain they belong to — or leave it EMPTY`
          + `\nto make each of them a separate person with no group.`
          + `\n\nNobody keeps their old role: "primary of ${domain}" means`
          + `\nnothing once they are somewhere real.`,
          '');
        // prompt() returns null on Cancel and '' on an empty OK. Those are
        // different answers — '' means ungroup — so they cannot be collapsed.
        if (to === null) return;
        btn.disabled = true; btn.textContent = 'Moving…';
        try {
          const r = await api('/api/email-contacts/regroup', {
            method: 'POST', body: JSON.stringify({ names, domain: to.trim() }) });
          loadEmailContacts();
          const failed = (r.skipped || []).length;
          if (failed) {
            alert(`Moved ${(r.moved || []).length}. ${failed} could not be moved:\n`
                + r.skipped.map((x) => `  ${x.name} — ${x.why}`).join('\n'));
          }
        } catch (e) {
          btn.disabled = false; btn.textContent = `Move all ${names.length}…`;
          alert(e.message || 'Could not move them');
        }
      }));

      rows.innerHTML = flat.length ? flat.map(memberRow).join('') : '<div style="font-family:var(--font-mono); font-size:11.5px; color:var(--text-faint); text-align:center; padding:10px 0;">No ungrouped contacts.</div>';
      document.querySelectorAll('.btn-del-email-contact').forEach(btn => btn.addEventListener('click', async () => {
        if (!confirm(`Remove ${btn.dataset.name} from email contacts?`)) return;
        await api(`/api/email-contacts/${encodeURIComponent(btn.dataset.name)}`, { method: 'DELETE' });
        loadEmailContacts();
      }));

      // Edit — an inline form rather than a chain of prompt() boxes. Four
      // fields typed blind through prompts, with no way to see the current
      // value or back out halfway, is how a directory of email addresses
      // ends up wrong.
      const closeEditors = () => document.querySelectorAll('.email-contact-editor').forEach(e => e.classList.add('hidden'));
      document.querySelectorAll('.btn-edit-email-contact').forEach(btn => btn.addEventListener('click', () => {
        const panel = document.querySelector(`.email-contact-editor[data-editor-for="${CSS.escape(btn.dataset.name)}"]`);
        if (!panel) return;
        const wasOpen = !panel.classList.contains('hidden');
        closeEditors();                       // only one open at a time
        if (!wasOpen) {
          panel.classList.remove('hidden');
          const first = panel.querySelector('.ec-email');
          if (first) { first.focus(); first.select(); }   // the field being fixed, nine times out of ten
        }
      }));
      document.querySelectorAll('.ec-cancel').forEach(btn => btn.addEventListener('click', () => closeEditors()));
      document.querySelectorAll('.ec-save').forEach(btn => btn.addEventListener('click', async () => {
        const panel = btn.closest('.email-contact-editor');
        if (!panel) return;
        const payload = {
          name: panel.querySelector('.ec-name').value.trim(),
          email: panel.querySelector('.ec-email').value.trim(),
          displayName: panel.querySelector('.ec-display').value.trim(),
          cc: panel.querySelector('.ec-cc').value.trim(),
          // Sent as empty strings rather than omitted, because empty MEANS
          // something here: no group, no role. The server deletes the fields
          // on an empty domain; omitting them would preserve a grouping she
          // has just cleared on screen.
          domain: panel.querySelector('.ec-domain').value.trim(),
          role: panel.querySelector('.ec-role').value,
        };
        if (!payload.name || !payload.email) { alert('Name and email are both required.'); return; }
        const original = btn.dataset.name;
        btn.disabled = true;
        try {
          // PUT, not POST — POST upserts by name and would leave the old
          // record behind on a rename. The server validates and reports a
          // clash rather than silently doing nothing.
          await api(`/api/email-contacts/${encodeURIComponent(original)}`, {
            method: 'PUT', body: JSON.stringify(payload),
          });
          loadEmailContacts();
        } catch (e) {
          alert(e.message);
          btn.disabled = false;
        }
      }));
    } catch (e) { rows.innerHTML = `<div style="font-family:var(--font-mono); font-size:11.5px; color:var(--status-danger);">${esc(e.message)}</div>`; }
  }
  // ── LEARN FROM MY MAIL ────────────────────────────────────────────────
  // Scan, then pick, then save — three steps, because they are three
  // decisions. The scan writes nothing. A sweep of a real mailbox surfaces
  // freight forwarders, a bank, somebody's personal address and a conference
  // list, and this tab is what resolveContact reads to decide where an
  // invoice goes: saving all of it on one click would make the tab useless
  // in the one place it has to be right.
  $('btnHarvestContacts').addEventListener('click', async () => {
    const btn = $('btnHarvestContacts');
    btn.disabled = true; btn.textContent = 'Scanning…';
    let data;
    try {
      data = await api('/api/email-contacts/harvest?limit=200');
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Learn from my mail';
      alert(e.code === 'GMAIL_UNAVAILABLE'
        ? e.message
        : `Could not scan your mail: ${e.message}`);
      return;
    }
    btn.disabled = false; btn.textContent = 'Learn from my mail';

    const domains = (data.domains || []).filter((d) => !d.all_known);
    if (!domains.length) {
      alert(`Scanned ${data.scanned} messages — everyone worth saving is already in this tab.`);
      return;
    }

    // Already-saved addresses are SHOWN and not tickable: seeing that a
    // person is already here is the answer to "why isn't this offering
    // them", and leaving them out entirely invites the same scan twice.
    const row = (p, di, pi) => `
      <label style="display:grid; grid-template-columns:auto 1fr auto; gap:10px; align-items:center; padding:7px 9px; background:var(--surface-sunken); border-radius:var(--radius-xs); ${p.already_known ? 'opacity:.5;' : ''}">
        <input type="checkbox" class="hv-pick" data-d="${di}" data-p="${pi}"
          ${p.already_known ? 'disabled' : (p.name ? 'checked' : '')}>
        <span>
          <span style="font-size:12.5px; color:var(--text-strong);">${esc(p.displayName || p.name || '(no name yet)')}</span>
          <span style="font-family:var(--font-mono); font-size:11px; color:var(--text-faint); display:block;">${esc(p.addr)}</span>
          ${p.name ? '' : '<span style="font-size:10.5px; color:var(--status-warn);">needs a name — type one to save it</span>'}
        </span>
        <span style="display:flex; gap:6px; align-items:center;">
          <input class="hv-name" data-d="${di}" data-p="${pi}" value="${esc(p.name || '')}"
            placeholder="name Jarvis matches on"
            style="width:150px; padding:4px 7px; font-size:11px;">
          ${p.role ? `<span class="badge" style="font-size:9px;">${esc(p.role)}</span>` : ''}
          <span style="font-family:var(--font-mono); font-size:10px; color:var(--text-faint);">${p.messages}&times;</span>
          ${p.already_known ? '<span style="font-size:10px; color:var(--text-faint);">saved</span>' : ''}
        </span>
      </label>`;

    document.body.insertAdjacentHTML('beforeend', `
      <div id="hvModal" class="modal-overlay" style="display:flex;">
        <div class="card" style="width:min(860px,100%); padding:22px 24px;">
          <div style="display:flex; align-items:baseline; justify-content:space-between; margin-bottom:6px;">
            <h3 style="margin:0; font-size:17px; text-transform:none;">Learn from my mail</h3>
            <button id="hvClose" aria-label="Close" style="background:none;border:none;color:var(--text-muted);font-size:22px;line-height:1;cursor:pointer;">&times;</button>
          </div>
          <div style="font-size:12px; color:var(--text-muted); margin-bottom:14px;">
            Read ${data.scanned} recent messages and found ${domains.length} compan${domains.length === 1 ? 'y' : 'ies'} not yet in this tab.
            Skipped ${data.skipped.machine} automated address${data.skipped.machine === 1 ? '' : 'es'},
            ${data.skipped.mine} of your own and ${data.skipped.thin} seen only once in a Cc.
            Nothing is saved until you press Save.
          </div>
          <div style="display:flex; gap:8px; margin-bottom:10px;">
            <button id="hvAll" class="btn btn-secondary" style="font-size:11px; padding:5px 10px;">Tick all</button>
            <button id="hvNone" class="btn btn-secondary" style="font-size:11px; padding:5px 10px;">Untick all</button>
          </div>
          <div style="max-height:52vh; overflow-y:auto; display:flex; flex-direction:column; gap:14px;">
            ${domains.map((d, di) => `
              <div>
                <div style="font-size:12px; font-weight:700; text-transform:uppercase; color:var(--text-strong); margin-bottom:6px;">${esc(d.domain)}${d.freemail ? '<span style="font-weight:400; text-transform:none; color:var(--text-faint); font-size:11px;"> — saved as individual people, not a company group</span>' : ''}</div>
                <div style="display:flex; flex-direction:column; gap:5px;">${d.proposals.map((p, pi) => row(p, di, pi)).join('')}</div>
              </div>`).join('')}
          </div>
          <div id="hvErr" style="color:var(--status-danger); font-size:12px; margin-top:10px;"></div>
          <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:14px;">
            <button id="hvCancel" class="btn btn-secondary">Cancel</button>
            <button id="hvSave" class="btn btn-primary">Save ticked</button>
          </div>
        </div>
      </div>`);

    const close = () => { const m = $('hvModal'); if (m) m.remove(); };
    $('hvClose').onclick = close;
    $('hvCancel').onclick = close;
    $('hvAll').onclick = () => document.querySelectorAll('.hv-pick:not(:disabled)').forEach((c) => { c.checked = true; });
    $('hvNone').onclick = () => document.querySelectorAll('.hv-pick').forEach((c) => { c.checked = false; });

    $('hvSave').onclick = async () => {
      const save = [];
      document.querySelectorAll('.hv-pick:checked').forEach((c) => {
        const d = domains[Number(c.dataset.d)];
        const p = d.proposals[Number(c.dataset.p)];
        const nameEl = document.querySelector(`.hv-name[data-d="${c.dataset.d}"][data-p="${c.dataset.p}"]`);
        const name = (nameEl && nameEl.value.trim()) || p.name || '';
        // ── p.domain WINS OVER d.domain ─────────────────────────────
        // A consumer mail provider is a heading, not a company: the helper
        // returns domain:null and role:null for those, and sending
        // d.domain would file three strangers into one "hotmail.com" group
        // whose members auto-cc each other.
        const domain = p.domain !== undefined ? p.domain : d.domain;
        save.push({ name, email: p.addr,
                    domain: domain || undefined, role: (domain && p.role) || undefined,
                    displayName: p.displayName || undefined });
      });
      const unnamed = save.filter((r) => !r.name);
      if (unnamed.length) {
        $('hvErr').textContent = `${unnamed.length} ticked row${unnamed.length === 1 ? ' has' : 's have'} no name — type one or untick it.`;
        return;
      }
      if (!save.length) { $('hvErr').textContent = 'Nothing ticked.'; return; }
      const b = $('hvSave'); b.disabled = true; b.textContent = 'Saving…';
      try {
        const r = await api('/api/email-contacts/harvest', { method: 'POST', body: JSON.stringify({ save }) });
        close();
        loadEmailContacts();
        const skipped = (r.skipped || []).length;
        alert(`Saved ${(r.saved || []).length} contact${(r.saved || []).length === 1 ? '' : 's'}.`
            + (skipped ? `\n\nSkipped ${skipped}:\n` + r.skipped.map((s) => `  ${s.email} — ${s.why}`).join('\n') : ''));
      } catch (e) {
        b.disabled = false; b.textContent = 'Save ticked';
        $('hvErr').textContent = e.message || 'Could not save';
      }
    };
  });

  $('btnAddEmailContact').addEventListener('click', async () => {
    const name = prompt('Contact name:'); if (!name) return;
    const email = prompt('Email address:'); if (!email) return;
    try { await api('/api/email-contacts', { method: 'POST', body: JSON.stringify({ name, email }) }); loadEmailContacts(); }
    catch (e) { alert(e.message); }
  });
  loadEmailContacts();
}

// ── BOT CONSOLE ───────────────────────────────────────────────────────────
let botLog = [];
function renderBot() {
  $('viewRoot').innerHTML = `
    <section style="max-width:880px; margin:0 auto; padding:38px 40px 80px;">
      <div class="eyebrow">// Bot console</div>
      <h2 style="font-size:24px; text-transform:uppercase; margin-bottom:22px;">Jarvis terminal</h2>
      <div style="background:var(--surface-card); border:1px solid var(--border-subtle); border-radius:var(--radius-sm); overflow:hidden;">
        <div style="display:flex; align-items:center; gap:10px; padding:10px 18px; background:var(--steel-900); border-bottom:1px solid var(--steel-800);">
          <span style="font-family:var(--font-mono); font-size:10px; font-weight:600; letter-spacing:.16em; text-transform:uppercase; color:var(--steel-300);">Commands fire for real — same effect as messaging Jarvis on WhatsApp</span>
          <span id="wakeStatus" style="margin-left:auto; font-family:var(--font-mono); font-size:10px; color:var(--steel-500); white-space:nowrap;">Wake word off</span>
        </div>
        <div id="botLogEl" style="height:380px; overflow-y:auto; padding:20px 22px; display:flex; flex-direction:column; gap:10px;"></div>
        <!-- ── THE BOX GROWS AS SHE TYPES (2026-09-24) ──────────────────────
             Apsara: "I want jarvis chat bot text command center to expand
             like this when user starts typing".

             A TEXTAREA, not an input, because an input cannot wrap however it
             is styled — a long command scrolled sideways and she could only
             ever see the end of what she had typed.

             align-items:flex-end on the row so the buttons stay on the bottom
             line as the box grows, rather than stretching to its full height.

             ENTER STILL SENDS. That is the existing behaviour and she uses it
             constantly; a textarea would otherwise swallow Enter as a newline
             and the command would just sit there. SHIFT+ENTER is the new line,
             which is the convention every chat box uses. -->
        <div style="display:flex; align-items:flex-end; gap:10px; padding:14px 18px; background:var(--steel-900); border-top:1px solid var(--steel-800);">
          <textarea id="botInput" rows="1" placeholder="forward DALA23991600 to Dave — or: what did we spend last month" style="flex:1; background:var(--steel-950); border:1px solid var(--steel-700); border-radius:var(--radius-xs); padding:10px 14px; font-family:var(--font-mono); font-size:12.5px; line-height:1.5; color:var(--steel-100); outline:none; resize:none; overflow-y:auto; max-height:168px;"></textarea>
          <button id="btnWakeWord" class="btn" title="Toggle always-on 'Jarvis' wake word" style="min-width:44px;">🎙️</button>
          <button id="btnBotMic" class="btn" title="Speak a command" style="min-width:44px;">🎤</button>
          <button id="btnBotSend" class="btn btn-primary">Send</button>
        </div>
      </div>
    </section>`;
  renderBotLog();
  $('btnBotSend').addEventListener('click', sendBotCommand);
  // ── ENTER SENDS, SHIFT+ENTER BREAKS THE LINE ──────────────────────────
  // preventDefault on the send, or the textarea also inserts the newline it
  // was about to and the box is left one blank line tall after every command.
  $('botInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBotCommand(); }
  });
  // Grow to fit, up to the max-height in the markup, then scroll. Height is
  // cleared to 'auto' first so the box SHRINKS again when she deletes — read
  // scrollHeight against a stale height and it only ever gets taller.
  $('botInput').addEventListener('input', () => autoGrowBotInput());
  $('btnBotMic').addEventListener('click', toggleBotMic);
  $('btnWakeWord').addEventListener('click', toggleWakeWord);
  // Reflect existing wake-word state (it keeps running across view
  // switches — re-rendering this view just rebuilds the DOM, it doesn't
  // stop the background recognizer).
  if (wakeWordEnabled) {
    $('btnWakeWord').textContent = '🔴';
    $('btnWakeWord').style.background = 'var(--status-danger)';
    setWakeStatus(wakeAwaitingCommand ? 'Yes? Listening…' : 'Listening for "Jarvis"…', wakeAwaitingCommand ? 'var(--leaf-400)' : 'var(--copper-400)');
  }
}

// Voice input for the terminal — per Apsara, a follow-up to the WhatsApp
// voice-note feature ("is it possible to integrate [voice] into this
// website?"). Records via the browser's MediaRecorder, POSTs the audio to
// /api/bot/voice-command (which reuses the exact same Gemini transcription
// helpers/gemini.js's WhatsApp voice-note path already uses), and drops the
// transcribed text into botInput for review — deliberately does NOT
// auto-send, since this terminal fires real messages to truckers/suppliers
// and a browser mic is more prone to picking up office noise than a
// deliberate WhatsApp recording. She can edit it or just hit Send/Enter.
let botMicRecorder = null, botMicChunks = [];
async function toggleBotMic() {
  const btn = $('btnBotMic');
  if (botMicRecorder && botMicRecorder.state === 'recording') { botMicRecorder.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia) {
    botLog.push({ prompt: 'error', color: 'var(--status-danger)', text: 'Voice input needs microphone access, which this browser/context doesn\'t support (needs https:// or localhost).' });
    renderBotLog();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    botMicChunks = [];
    // Let the browser pick a MediaRecorder mimeType it actually supports —
    // varies by browser (Chrome: audio/webm;codecs=opus, Safari: audio/mp4)
    // — Gemini's transcribeVoiceNote just needs an accurate mimeType to
    // match, not a specific one.
    botMicRecorder = new MediaRecorder(stream);
    const mimeType = botMicRecorder.mimeType || 'audio/webm';
    botMicRecorder.ondataavailable = e => { if (e.data.size) botMicChunks.push(e.data); };
    botMicRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      btn.textContent = '🎤'; btn.disabled = true;
      try {
        const blob = new Blob(botMicChunks, { type: mimeType });
        const audioBase64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result.split(',')[1] || '');
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        const res = await api('/api/bot/voice-command', { method: 'POST', body: JSON.stringify({ audio_base64: audioBase64, mime_type: mimeType }) });
        $('botInput').value = res.text || ''; autoGrowBotInput();
        $('botInput').focus();
      } catch (e) {
        botLog.push({ prompt: 'error', color: 'var(--status-danger)', text: e.message });
        renderBotLog();
      } finally {
        btn.disabled = false;
      }
    };
    botMicRecorder.start();
    btn.textContent = '⏺';
  } catch (e) {
    botLog.push({ prompt: 'error', color: 'var(--status-danger)', text: `Mic access failed: ${e.message}` });
    renderBotLog();
  }
}
// ── WAKE WORD ("say 'Jarvis'") ──────────────────────────────────────────
// Always-on listening via the browser's Web Speech API (Chrome/Edge —
// Safari's continuous-mode support is unreliable so it's feature-detected,
// not blocked). OFF by default and only ever starts from an explicit click
// on btnWakeWord: mic permission needs a user gesture regardless, and
// always-listening in a shared office is a real privacy trade-off that
// shouldn't just turn itself on. While enabled, audio is streamed to the
// browser's speech-recognition backend (Google's, in Chrome) to be
// transcribed — there's no offline/on-device mode for Web Speech API, so
// this is NOT audio staying local to the machine.
//
// Heard commands are filled into botInput for review, exactly like the
// mic button — deliberately NOT auto-sent. A false wake or a mis-heard
// word here would fire a real WhatsApp message to a trucker/supplier with
// nobody having read it first, which is a worse failure mode than the
// mic button's (where she already chose to record).
let wakeRecognition = null;
let wakeWordEnabled = false;
let wakeAwaitingCommand = false;

function getSpeechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}
function setWakeStatus(text, color) {
  const el = $('wakeStatus');
  if (el) { el.textContent = text; el.style.color = color || 'var(--steel-500)'; }
}
function toggleWakeWord() {
  const btn = $('btnWakeWord');
  if (wakeWordEnabled) {
    wakeWordEnabled = false;
    wakeAwaitingCommand = false;
    if (wakeRecognition) { try { wakeRecognition.stop(); } catch (e) {} }
    if (btn) { btn.textContent = '🎙️'; btn.style.background = ''; }
    setWakeStatus('Wake word off', 'var(--steel-500)');
    return;
  }
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    botLog.push({ prompt: 'error', color: 'var(--status-danger)', text: "This browser doesn't support always-on voice recognition (Web Speech API) — try Chrome or Edge." });
    renderBotLog();
    return;
  }
  wakeWordEnabled = true;
  if (btn) { btn.textContent = '🔴'; btn.style.background = 'var(--status-danger)'; }
  setWakeStatus('Listening for "Jarvis"…', 'var(--copper-400)');
  startWakeRecognition();
}
function startWakeRecognition() {
  if (!wakeWordEnabled) return;
  const Ctor = getSpeechRecognitionCtor();
  wakeRecognition = new Ctor();
  wakeRecognition.continuous = true;
  wakeRecognition.interimResults = false;
  wakeRecognition.lang = 'en-US';
  wakeRecognition.onresult = (event) => {
    const last = event.results[event.results.length - 1];
    if (!last || !last.isFinal) return;
    const heard = (last[0]?.transcript || '').trim();
    if (!heard) return;
    if (wakeAwaitingCommand) {
      wakeAwaitingCommand = false;
      setWakeStatus('Listening for "Jarvis"…', 'var(--copper-400)');
      fillBotFromVoice(heard);
      return;
    }
    const lower = heard.toLowerCase();
    const idx = lower.indexOf('jarvis');
    if (idx === -1) return;
    const remainder = heard.slice(idx + 'jarvis'.length).replace(/^[\s,.:-]+/, '').trim();
    if (remainder.length > 2) {
      fillBotFromVoice(remainder);
    } else {
      wakeAwaitingCommand = true;
      setWakeStatus('Yes? Listening…', 'var(--leaf-400)');
      botLog.push({ prompt: 'jarvis', color: 'var(--copper-400)', text: 'Yes? Go ahead.' });
      renderBotLog();
    }
  };
  wakeRecognition.onerror = (event) => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      wakeWordEnabled = false;
      const btn = $('btnWakeWord');
      if (btn) { btn.textContent = '🎙️'; btn.style.background = ''; }
      setWakeStatus('Mic permission denied', 'var(--status-danger)');
    }
    // 'no-speech' / 'network' / 'aborted' — onend below restarts it as long
    // as wakeWordEnabled is still true, so a transient hiccup self-heals.
  };
  wakeRecognition.onend = () => {
    if (wakeWordEnabled) setTimeout(() => { if (wakeWordEnabled) startWakeRecognition(); }, 300);
  };
  try { wakeRecognition.start(); } catch (e) { /* already running — ignore */ }
}
function fillBotFromVoice(text) {
  $('botInput').value = text; autoGrowBotInput();
  $('botInput').focus();
  botLog.push({ prompt: 'heard', color: 'var(--leaf-400)', text: `"${text}" — review and hit Send` });
  renderBotLog();
}
function renderBotLog() {
  const el = $('botLogEl');
  if (!botLog.length) { el.innerHTML = `<div style="margin:auto; text-align:center; font-family:var(--font-mono); font-size:12px; color:var(--steel-500); line-height:2;">Type a command — or ask a question.<br>Try <span style="color:var(--leaf-400);">urgent</span>, <span style="color:var(--leaf-400);">how much do we owe Inesh</span>, or <span style="color:var(--leaf-400);">what did Zimex say about the HBL</span>.</div>`; return; }
  // ── A FOLLOW-UP IS A CHIP, NOT A LINE TO RETYPE ──────────────────────
  // Apsara, 2026-09-24: "follow up questions need to be thrown for business".
  // helpers/data/followUps.js decides WHICH questions; this only draws them.
  // Any line the answer sends as "• …" becomes a button that asks it.
  //
  // An OFFER, never a prompt: ignoring the chips costs nothing and nothing is
  // staged behind them. That was the concern recorded on the old nextStep —
  // an offer that opens a pending is a question she has to dismiss.
  const chip = (q) => `<button class="bot-chip" data-ask="${esc(q)}" style="font-family:var(--font-mono); font-size:11.5px; padding:5px 10px; margin:3px 6px 0 0; background:var(--steel-900); border:1px solid var(--steel-700); border-radius:999px; color:var(--steel-200); cursor:pointer;">${esc(q)}</button>`;
  const body = (t) => {
    const lines = String(t).split('\n');
    const asks = lines.filter((l) => l.trim().startsWith('• ')).map((l) => l.trim().slice(2).trim());
    if (!asks.length) return `<span style="font-family:var(--font-mono); font-size:12.5px; line-height:1.6; color:#e5e9ec; white-space:pre-wrap;">${esc(t)}</span>`;
    const rest = lines.filter((l) => !l.trim().startsWith('• ')).join('\n');
    return `<span style="font-family:var(--font-mono); font-size:12.5px; line-height:1.6; color:#e5e9ec; white-space:pre-wrap;">${esc(rest)}</span><div style="margin-top:2px;">${asks.map(chip).join('')}</div>`;
  };
  el.innerHTML = botLog.map(ln => `<div style="display:flex; gap:10px;"><span style="font-family:var(--font-mono); font-size:12.5px; color:${ln.color}; flex-shrink:0;">${ln.prompt}</span><span style="flex:1; min-width:0;">${body(ln.text)}</span></div>`).join('');
  el.querySelectorAll('.bot-chip').forEach((b) => b.addEventListener('click', () => {
    $('botInput').value = b.dataset.ask;
    autoGrowBotInput();
    sendBotCommand();
  }));
  el.scrollTop = el.scrollHeight;
}
// Sizes the command box to its content. Called on every keystroke, and again
// after anything that puts text in programmatically — the mic transcript and
// the wake-word handler both do, and a box that stays one line tall after a
// paragraph of dictation looks broken.
function autoGrowBotInput() {
  const el = $('botInput');
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 168) + 'px';
}

async function sendBotCommand() {
  const input = $('botInput'); const text = input.value.trim(); if (!text) return;
  botLog.push({ prompt: '&gt;', color: 'var(--leaf-400)', text }); input.value = ''; autoGrowBotInput(); renderBotLog();
  try {
    const res = await api('/api/bot/command', { method: 'POST', body: JSON.stringify({ text }) });
    (res.replies || []).forEach(r => botLog.push({ prompt: 'jarvis', color: 'var(--copper-400)', text: r.text || '(no text)' }));
    if (!res.replies || !res.replies.length) botLog.push({ prompt: 'jarvis', color: 'var(--copper-400)', text: '(no reply)' });
  } catch (e) { botLog.push({ prompt: 'error', color: 'var(--status-danger)', text: e.message }); }
  renderBotLog();
}

// ── TASKS ─────────────────────────────────────────────────────────────────
// Nudge types + auto-cancel condition mapping reconstructed from the actual
// backend schema (helpers/tasks.js evaluateCondition + comment block) since
// the original UI's exact default-message strings weren't recoverable — the
// condition *types* below are grounded in that file, not guessed.
