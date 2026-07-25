(function () {
    'use strict';
  
    const RISK = {
      high:   { label:'At Risk',  color:'var(--danger)',     bg:'var(--danger-bg)',  text:'var(--danger-text)'  },
      medium: { label:'Watch',    color:'var(--warning)',    bg:'var(--warning-bg)', text:'var(--warning-text)' },
      low:    { label:'On Track', color:'var(--leaf-600)',   bg:'var(--leaf-50)',    text:'var(--leaf-700)'     },
      done:   { label:'Complete', color:'var(--steel-300)',  bg:'var(--steel-100)',  text:'var(--text-muted)'   },
    };
    const FILTERS = [
      { key:'all', label:'All' }, { key:'high', label:'At Risk' }, { key:'medium', label:'Watch' },
      { key:'low', label:'On Track' }, { key:'done', label:'Complete' },
    ];
  
    let state = { filter:'all', data:null };
    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  
    // ── Locality helpers ───────────────────────────────────────────────────
    const normLoc = (s) => String(s ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
    function localityMatchesPort(loc, port) {
      const l = normLoc(loc), p = normLoc(port);
      if (!l || !p) return false;
      return l.includes(p) || p.includes(l);
    }
    function splitByLocality(contacts, port) {
      const p = normLoc(port);
      if (!p) return { local: [], universal: contacts, other: [] };
      const local = [], universal = [], other = [];
      for (const c of contacts) {
        const loc = normLoc(c.locality);
        if (!loc) universal.push(c);
        else if (localityMatchesPort(loc, p)) local.push(c);
        else other.push(c);
      }
      return { local, universal, other };
    }
    function buildContactOptions(contacts, selectedName, port) {
      const p = normLoc(port);
      // Strict locality filter: when the booking has a POL, show ONLY contacts whose
      // locality matches that port. If no POL is set yet (new booking), show all.
      // The currently-selected contact is always included so a POL change doesn't
      // silently drop the existing selection.
      const visible = p
        ? contacts.filter(c => localityMatchesPort(c.locality, p) || (selectedName && c.name === selectedName))
        : contacts;
      const optOf = (c) => `<option value="${esc(c.name)}" ${selectedName === c.name ? 'selected' : ''}>${esc(c.name)}${c.locality ? ' · ' + esc(c.locality) : ''}</option>`;
      let html = `<option value="">—</option>`;
      html += visible.map(optOf).join('');
      return html;
    }
  
    function deadlineColor(b) {
      if (b.risk === 'done') return 'var(--text-faint)';
      if (b.risk === 'high') return 'var(--danger)';
      if (b.risk === 'medium') return 'var(--warning)';
      return 'var(--text-muted)';
    }
  
    function renderKpis(counts) {
      $('kpis').innerHTML = ['high','medium','low','done'].map(k => {
        const r = RISK[k];
        return `<button class="kpi" style="border-top-color:${r.color}" data-filter="${k}"><div class="kpi-count">${counts[k] ?? 0}</div><div class="kpi-label" style="color:${r.color}">${r.label}</div></button>`;
      }).join('');
    }
  
    function renderAlerts(alerts) {
      $('alertCount').textContent = alerts.length;
      $('alertsSection').style.display = alerts.length ? '' : 'none';
      $('alerts').innerHTML = alerts.map(a => `<div class="alert-card"><div class="alert-top"><span class="alert-bkg">${esc(a.bookingNo)}</span><span class="alert-deadline">${esc(a.deadlineLabel)}</span></div><div class="alert-issue">${esc(a.issue || 'Needs review')}</div></div>`).join('');
    }
  
    function renderFilters() {
      $('filters').innerHTML = FILTERS.map(f => `<button class="chip ${state.filter === f.key ? 'active' : ''}" data-filter="${f.key}">${f.label}</button>`).join('');
    }
  
    function renderDots(b, stages) {
      const last = stages.length - 1;
      const pct  = (b.stageIndex / last) * 100;
      const dots = stages.map((label, i) => {
        const size  = i === b.stageIndex ? 13 : 8;
        const color = i < b.stageIndex ? 'var(--steel-400)' : i === b.stageIndex ? 'var(--copper-600)' : 'var(--steel-200)';
        return `<div class="dot" title="${esc(label)}" style="left:${(i/last)*100}%;width:${size}px;height:${size}px;background:${color}"></div>`;
      }).join('');
      return `<div class="track"><div class="track-fill" style="width:${pct}%"></div>${dots}</div>`;
    }
  
    function renderRows() {
      const d = state.data;
      if (!d) return;
      const list = state.filter === 'all' ? d.bookings : d.bookings.filter(b => b.risk === state.filter);
      if (!list.length) { $('rows').innerHTML = `<div class="empty">No bookings in this view.</div>`; return; }
      $('rows').innerHTML = list.map(b => {
        const r = RISK[b.risk];
        return `<div class="row" style="border-left-color:${b.risk==='done' ? 'var(--steel-300)' : r.color}"><div class="cell-id"><div class="cell-eyebrow">Booking</div><div class="cell-bkg">${esc(b.bookingNo)}</div><div class="cell-buyer">${esc(b.route)}</div><div class="cell-container">${esc(b.container)}</div></div><div class="cell-stage">${renderDots(b, d.stages)}<div class="stage-line"><span class="stage-name">${esc(b.stageName)}</span>${b.subBranch ? `<span class="stage-sub">· ${esc(b.subBranch)}</span>` : ''}</div></div><div class="cell-status"><div class="status-pending" style="color:${b.pending ? 'var(--text-body)' : 'var(--text-faint)'}">${esc(b.pending || 'No open items')}</div><div class="status-owner">${esc(b.owner)}</div></div><div class="cell-deadline"><div class="deadline" style="color:${deadlineColor(b)}">${esc(b.deadlineLabel)}</div><span class="risk-pill" style="background:${r.bg};color:${r.text}">${r.label}</span></div></div>`;
      }).join('');
    }
  
    function renderAll() {
      const d = state.data;
      renderKpis(d.counts); renderAlerts(d.alerts); renderFilters(); renderRows();
      $('trackedCount').textContent = `${d.bookings.length} booking${d.bookings.length === 1 ? '' : 's'} tracked`;
    }
  
    async function load() {
      try {
        const res = await fetch('/api/dashboard');
        if (!res.ok) throw new Error(res.status);
        state.data = await res.json();
        $('liveDot').classList.remove('stale');
        $('liveLabel').textContent = 'Live · synced from WhatsApp';
        renderAll();
      } catch (e) {
        $('liveDot').classList.add('stale');
        $('liveLabel').textContent = 'Connection lost — retrying';
      }
    }
  
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-filter]');
      if (!btn) return;
      state.filter = btn.dataset.filter;
      renderFilters(); renderRows();
    });
  
    $('todayLabel').textContent = new Date().toLocaleDateString('en-US', { weekday:'long', month:'short', day:'numeric' });
    load();
    setInterval(load, 30000);
  
    // Admin-only tabs (WhatsApp QR, Facts) are hidden entirely for non-admin
    // sessions — not just visually de-emphasized. The backend also enforces
    // this on the API side (requireAdmin), so hiding here is UX, not the
    // security boundary — but it keeps regular users from even seeing these
    // exist.
    state.role = 'user';
    fetch('/api/me').then(r => r.json()).then(me => {
      state.role = me.role || 'user';
      const isAdmin = state.role === 'admin';
      $('tabWhatsapp').style.display = isAdmin ? '' : 'none';
      $('tabFacts').style.display    = isAdmin ? '' : 'none';
      $('tabSettings').style.display = isAdmin ? '' : 'none';
    }).catch(() => {});
  
    document.querySelectorAll('.tab').forEach(t => {
      t.addEventListener('click', () => {
        const target = t.dataset.tab;
        document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
        document.querySelectorAll('.tabpanel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + target));
        if (target === 'bookings')  loadBookings();
        if (target === 'truckers')  loadContacts('truckers');
        if (target === 'suppliers') loadContacts('suppliers');
        if (target === 'whatsapp')  loadWhatsappStatus();
        if (target === 'settings')  loadSettings();
        if (target === 'bot')       setTimeout(() => $('botInput').focus(), 50);
        if (target === 'tasks')     loadTasks();
        if (target === 'facts')     loadFacts();
        $('sidebar').classList.remove('mobile-open');
        $('sidebarBackdrop').classList.remove('mobile-open');
        $('hamburgerBtn').classList.remove('open');
      });
    });
  
    $('hamburgerBtn').addEventListener('click', () => {
      const open = $('sidebar').classList.toggle('mobile-open');
      $('sidebarBackdrop').classList.toggle('mobile-open', open);
      $('hamburgerBtn').classList.toggle('open', open);
      $('hamburgerBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    $('sidebarBackdrop').addEventListener('click', () => {
      $('sidebar').classList.remove('mobile-open');
      $('sidebarBackdrop').classList.remove('mobile-open');
      $('hamburgerBtn').classList.remove('open');
    });
  
    $('btnSignout').addEventListener('click', async () => {
      try { await fetch('/logout', { method: 'POST' }); } catch {}
      location.href = '/login';
    });
  
    async function loadBookings() {
      try {
        const [bkRes, wfRes] = await Promise.all([fetch('/api/bookings'), fetch('/api/workflow')]);
        const bookings = await bkRes.json();
        const workflow = await wfRes.json();
        renderBookingsList(bookings, workflow);
      } catch { renderBookingsList({}, {}); }
    }
  
    function renderBookingsList(bookings, workflow) {
      const list = Object.values(bookings);
      if (!list.length) { $('bkList').innerHTML = `<div class="bk-list-empty">No bookings yet. Click "Add booking" to upload a PDF.</div>`; return; }
      const rows = list.map(b => {
        const containers = Array.isArray(b.containers) && b.containers.length ? b.containers : [{seq:1, size:b.container_size, container_number:b.container_number, stage:'not_started'}];
        const cCount = containers.length;
        const cLabel = cCount === 1 ? '1 container' : `${cCount} containers`;
        const stagesSet = new Set(containers.map(c => c.stage || 'not_started'));
        const stageLabel = stagesSet.size === 1 ? [...stagesSet][0].replace(/_/g,' ') : `${stagesSet.size} stages`;
        const containerRows = containers.map(c => {
          const assigned = c.supplier || c.trucker;
          const assignedLabel = c.supplier && c.trucker ? `${c.supplier} → ${c.trucker}` : (c.supplier || c.trucker || '—');
          return `<div style="display:grid; grid-template-columns:60px 1fr 140px 120px 90px; gap:12px; padding:9px 18px 9px 44px; border-top:1px solid var(--border); align-items:center; font-size:12px; background:var(--steel-100);"><div class="bk-cell-mono" style="color:var(--copper-700); font-weight:700;">#${c.seq}</div><div class="bk-cell-mono">${esc(c.size || '—')} ${c.container_number ? '· ' + esc(c.container_number) : ''}</div><div class="bk-cell-mono" style="color:${assigned ? 'var(--text-strong)' : 'var(--text-faint)'};">${esc(assignedLabel)}</div><div><span class="bk-cell-pill">${esc((c.stage || 'not_started').replace(/_/g,' '))}</span></div><div></div></div>`;
        }).join('');
        return `<div class="bk-row-group" data-bkg="${esc(b.booking_number)}"><div class="bk-row" style="grid-template-columns:30px 130px 1fr 90px 90px 110px 130px; cursor:pointer;" data-bk-expand="${esc(b.booking_number)}"><div style="text-align:center; color:var(--text-faint); font-family:var(--mono);">▸</div><div class="bk-cell-bkg">${esc(b.booking_number)}</div><div class="bk-cell-sub"><span class="bk-cell-mono">${esc(b.port_of_loading || '—')} → ${esc(b.port_of_discharge || '—')}</span><br><span class="bk-cell-mono" style="color:var(--text-faint);">${esc(cLabel)}</span></div><div class="bk-cell-mono">${esc(b.erd_date || '—')}</div><div class="bk-cell-mono">${esc(b.cutoff_date || '—')}</div><div><span class="bk-cell-pill">${esc(stageLabel)}</span></div><div style="display:flex; gap:5px; justify-content:flex-end;"><button type="button" class="btn-secondary" data-bk-edit="${esc(b.booking_number)}" style="padding:5px 10px; font-size:10px;" onclick="event.stopPropagation();">Edit</button><button type="button" class="btn-secondary" data-bk-delete="${esc(b.booking_number)}" style="padding:5px 10px; font-size:10px; color:var(--danger); border-color:var(--danger);" onclick="event.stopPropagation();">Delete</button></div></div><div class="bk-containers" style="display:none;">${containerRows}</div></div>`;
      }).join('');
      $('bkList').innerHTML = `<div class="bk-table"><div class="bk-hdr" style="grid-template-columns:30px 130px 1fr 90px 90px 110px 130px;"><div></div><div>Booking</div><div>Route / Containers</div><div>ERD</div><div>Cutoff</div><div>Stage</div><div></div></div>${rows}</div>`;
  
      $('bkList').querySelectorAll('[data-bk-expand]').forEach(row => {
        row.addEventListener('click', () => {
          const wrap = row.closest('.bk-row-group');
          const detail = wrap.querySelector('.bk-containers');
          const chev = row.querySelector('div:first-child');
          const isOpen = detail.style.display !== 'none';
          detail.style.display = isOpen ? 'none' : 'block';
          chev.textContent = isOpen ? '▸' : '▾';
        });
      });
  
      $('bkList').querySelectorAll('[data-bk-delete]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const bkg = btn.dataset.bkDelete;
          if (!confirm(`Delete booking ${bkg}?`)) return;
          btn.disabled = true; btn.textContent = 'Deleting…';
          try {
            const r = await fetch('/api/bookings/' + encodeURIComponent(bkg), { method: 'DELETE' });
            if (!r.ok) throw new Error((await r.json()).error || 'delete failed');
            await loadBookings(); await load();
          } catch (e2) { alert('Delete failed: ' + e2.message); btn.disabled = false; btn.textContent = 'Delete'; }
        });
      });
  
      $('bkList').querySelectorAll('[data-bk-edit]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await modal.openForEdit(btn.dataset.bkEdit, bookings);
        });
      });
    }
  
    const modal = {
      back: $('modalBack'),
      open() { modal.reset(); modal.back.style.display = 'flex'; },
      close() { modal.back.style.display = 'none'; editingBookingNumber = null; },
      async openForEdit(bkg, allBookings) {
        modal.reset();
        const b = allBookings[bkg];
        if (!b) { alert('Booking not found.'); return; }
        editingBookingNumber = bkg;
        await loadModalContacts();
        $('f_bkg').value    = b.booking_number || '';
        $('f_bkg').disabled = true;
        $('f_carrier').value = b.carrier || '';
        $('f_pol').value    = b.port_of_loading || '';
        $('f_pod').value    = b.port_of_discharge || '';
        $('f_erd').value    = b.erd_date || '';
        $('f_cutoff').value = b.cutoff_date || '';
        $('f_vessel').value = b.vessel_voyage || '';
        $('f_buyer').value  = b.buyer || b.consignee || '';
        modalContainers = (b.containers || []).map(c => ({
          seq: c.seq, size: c.size || '', container_number: c.container_number || '',
          supplier: c.supplier || '', trucker: c.trucker || '', stage: c.stage || 'not_started',
          _locked: ['forwarded','empty_dropped','load_ready','picked_up','ingate_received','done'].includes(c.stage || ''),
        }));
        renderContainersInModal();
        const dropZone = $('dropZone'); if (dropZone) dropZone.style.display = '';
        $('scanBtn').style.display = 'none';
        const titleEl = document.getElementById('modalTitle'); if (titleEl) titleEl.textContent = `Edit booking — ${bkg}`;
        const saveBtn = document.getElementById('btnSave'); if (saveBtn) saveBtn.textContent = 'Save changes';
        modal.back.style.display = 'flex';
      },
      reset() {
        modalPdfBase64 = null; modalPdfFile = null; editingBookingNumber = null;
        ['f_bkg','f_carrier','f_pol','f_pod','f_erd','f_cutoff','f_vessel','f_buyer'].forEach(id => { $(id).value = ''; });
        $('f_bkg').disabled = false;
        modalContainers = [{ seq:1, size:'40HC', container_number:'', supplier:'', trucker:'', stage:'not_started' }];
        renderContainersInModal();
        $('formErr').style.display = 'none';
        $('scannedBanner').style.display = 'none';
        $('scanBtn').style.display = 'none'; $('scanBtn').disabled = true;
        const dropZone = $('dropZone'); if (dropZone) dropZone.style.display = '';
        const titleEl = document.getElementById('modalTitle'); if (titleEl) titleEl.textContent = 'New booking';
        const saveBtn = document.getElementById('btnSave'); if (saveBtn) saveBtn.textContent = 'Save booking';
        renderDrop();
      },
    };
    let modalPdfBase64 = null, modalPdfFile = null;
    let modalContainers = [];
    let editingBookingNumber = null;
  
    // Full contact objects (need locality field)
    let modalSuppliersList = [];
    let modalTruckersList  = [];
    async function loadModalContacts() {
      try {
        const [ts, ss] = await Promise.all([
          fetch('/api/truckers').then(r => r.json()),
          fetch('/api/suppliers').then(r => r.json()),
        ]);
        modalTruckersList  = Array.isArray(ts) ? ts.filter(t => t && t.name) : [];
        modalSuppliersList = Array.isArray(ss) ? ss.filter(s => s && s.name) : [];
      } catch {}
    }
  
    function renderContainersInModal() {
      const wrap = $('f_containers_list');
      const SIZES  = ['20GP','40GP','40HC','20RF','40RF','45HC'];
      const STAGES = ['not_started','supplier_assigned','forwarded','empty_dropped','load_ready','picked_up','ingate_received','done'];
      const stageLabel = (s) => s.replace(/_/g,' ');
      const pol = $('f_pol')?.value || '';
      const isEditing = !!editingBookingNumber;
      wrap.innerHTML = modalContainers.map((c, i) => `
        <div style="display:grid; grid-template-columns:50px 80px 1fr 1fr 1fr ${isEditing ? '130px' : ''} 30px; gap:8px; align-items:end; padding:8px 10px; background:var(--steel-100); border-radius:var(--radius-sm); border:1px solid var(--border);">
          <div><label style="font-size:9px;">Seq</label><div class="bk-cell-mono" style="padding:9px 12px; font-weight:700; color:var(--copper-700);">#${c.seq}</div></div>
          <div><label style="font-size:9px;">Size</label><select data-c-field="size" data-c-idx="${i}"><option value="">—</option>${SIZES.map(s => `<option ${c.size === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
          <div><label style="font-size:9px;">Container #</label><input type="text" data-c-field="container_number" data-c-idx="${i}" value="${esc(c.container_number || '')}" placeholder="TCLU8841207"></div>
          <div><label style="font-size:9px;">Supplier</label><select data-c-field="supplier" data-c-idx="${i}">${buildContactOptions(modalSuppliersList, c.supplier, pol)}</select></div>
          <div><label style="font-size:9px;">Trucker</label><select data-c-field="trucker" data-c-idx="${i}">${buildContactOptions(modalTruckersList, c.trucker, pol)}</select></div>
          ${isEditing ? `<div><label style="font-size:9px; color:var(--danger);" title="Manual override skips WhatsApp notifications">Stage (manual)</label><select data-c-field="stage" data-c-idx="${i}" style="border-color:var(--danger);">${STAGES.map(s => `<option value="${s}" ${(c.stage || 'not_started') === s ? 'selected' : ''}>${stageLabel(s)}</option>`).join('')}</select></div>` : ''}
          <div><button type="button" class="btn-secondary" data-c-remove="${i}" style="padding:9px 8px; font-size:11px; color:var(--danger); border-color:var(--danger);" title="Remove container" ${modalContainers.length <= 1 ? 'disabled' : ''}>×</button></div>
        </div>`).join('');
      if (isEditing) {
        const banner = document.createElement('div');
        banner.style.cssText = 'padding:8px 12px; background:#FBE1E6; color:var(--danger-text); border-radius:var(--radius-sm); font-size:11.5px; margin-bottom:8px; line-height:1.4;';
        banner.innerHTML = `<strong>Manual stage override:</strong> Changing a stage here does NOT send WhatsApp messages to trucker/supplier. Use only to correct out-of-sync bookings.`;
        wrap.insertBefore(banner, wrap.firstChild);
      }
      wrap.querySelectorAll('[data-c-field]').forEach(el => {
        const handler = (e) => { modalContainers[+e.target.dataset.cIdx][e.target.dataset.cField] = e.target.value; };
        el.addEventListener('input', handler);
        el.addEventListener('change', handler);
      });
      wrap.querySelectorAll('[data-c-remove]').forEach(btn => {
        btn.addEventListener('click', () => {
          if (modalContainers.length <= 1) return;
          modalContainers.splice(+btn.dataset.cRemove, 1);
          modalContainers.forEach((c, i) => { c.seq = i + 1; });
          renderContainersInModal();
        });
      });
    }
  
    // Re-render container dropdowns when POL changes (debounced)
    let polDebounce = null;
    $('f_pol').addEventListener('input', () => {
      clearTimeout(polDebounce);
      polDebounce = setTimeout(renderContainersInModal, 250);
    });
  
    $('f_add_container').addEventListener('click', () => {
      const nextSeq = modalContainers.length ? Math.max(...modalContainers.map(c => c.seq)) + 1 : 1;
      const defaultSize = modalContainers[0]?.size || '40HC';
      modalContainers.push({ seq: nextSeq, size: defaultSize, container_number: '', supplier: '', trucker: '', stage: 'not_started' });
      renderContainersInModal();
    });
  
    function renderDrop() {
      const dz = $('dropZone');
      if (modalPdfFile) {
        dz.classList.add('has-file');
        dz.innerHTML = `<div class="file-info"><div><div class="file-name">${esc(modalPdfFile.name)}</div><div class="file-size">${(modalPdfFile.size/1024).toFixed(1)} KB · ready to scan</div></div><button type="button" class="file-remove" id="fileRemove">Remove</button></div>`;
        $('fileRemove').addEventListener('click', (e) => { e.stopPropagation(); clearFile(); });
      } else {
        dz.classList.remove('has-file');
        dz.innerHTML = `<div class="drop-label">Drop booking PDF here or click to upload</div><div class="drop-sub">Jarvis will extract the fields automatically</div><input type="file" id="fileInput" accept="application/pdf" style="display:none">`;
        $('fileInput').addEventListener('change', (e) => handleFile(e.target.files[0]));
      }
    }
    function clearFile() { modalPdfFile = null; modalPdfBase64 = null; $('scanBtn').style.display = 'none'; $('scannedBanner').style.display = 'none'; renderDrop(); }
    function handleFile(f) {
      if (!f || f.type !== 'application/pdf') return;
      modalPdfFile = f;
      const reader = new FileReader();
      reader.onload = () => { modalPdfBase64 = reader.result.split(',')[1]; $('scanBtn').style.display = 'block'; $('scanBtn').disabled = false; $('scannedBanner').style.display = 'none'; renderDrop(); };
      reader.readAsDataURL(f);
    }
  
    $('btnAddBooking').addEventListener('click', async () => { await loadModalContacts(); modal.open(); });
    $('modalClose').addEventListener('click', modal.close);
    $('btnCancel').addEventListener('click', modal.close);
  
    // ── Request new booking — draft-only, no backend, no SMTP. Generates a
    // mailto: link so the person's own email client opens with everything
    // pre-filled; they review and hit send themselves. Deliberately no
    // auto-send here — that's a separate, later decision requiring real
    // email credentials.
    function openRequestBookingModal() {
      ['rb_email','rb_pol','rb_pod','rb_cutoff','rb_qty'].forEach(id => $(id).value = id === 'rb_qty' ? '1' : '');
      $('rb_size').value = '40ft';
      $('rb_err').textContent = '';
      $('requestBookingModal').style.display = 'flex';
    }
    function closeRequestBookingModal() { $('requestBookingModal').style.display = 'none'; }
  
    $('btnRequestBooking').addEventListener('click', openRequestBookingModal);
    $('rbModalClose').addEventListener('click', closeRequestBookingModal);
    $('rbCancel').addEventListener('click', closeRequestBookingModal);
    $('requestBookingModal').addEventListener('click', (e) => { if (e.target === $('requestBookingModal')) closeRequestBookingModal(); });
  
    $('rbDraft').addEventListener('click', () => {
      const email  = $('rb_email').value.trim();
      const pol    = $('rb_pol').value.trim();
      const pod    = $('rb_pod').value.trim();
      const cutoff = $('rb_cutoff').value.trim();
      const size   = $('rb_size').value;
      const qty    = parseInt($('rb_qty').value, 10) || 0;
  
      if (!email || !pol || !pod || !cutoff || qty < 1) {
        $('rb_err').textContent = 'Fill in all fields.';
        return;
      }
  
      const sizeLabel = { '20ft':'20 ft', '40ft':'40 ft', '40hc':'40 ft HC' }[size] || size;
      const subject = `Booking Request: ${pol} to ${pod}`;
      const body = [
        `Hi,`, '',
        `We need a booking from ${pol} to ${pod} for ${qty} x ${sizeLabel} container${qty === 1 ? '' : 's'}.`,
        `Cutoff needed: ${cutoff}.`, '',
        `Please confirm availability and rate.`, '',
        `Thanks,`,
        `Edge Metals Inc`,
      ].join('\n');
  
      const mailto = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      window.location.href = mailto;
      closeRequestBookingModal();
    });
  
    modal.back.addEventListener('click', (e) => { if (e.target === modal.back) modal.close(); });
  
    $('dropZone').addEventListener('click', () => { if (!modalPdfFile) document.getElementById('fileInput')?.click(); });
    $('dropZone').addEventListener('dragover', (e) => { e.preventDefault(); $('dropZone').classList.add('drag'); });
    $('dropZone').addEventListener('dragleave', () => $('dropZone').classList.remove('drag'));
    $('dropZone').addEventListener('drop', (e) => { e.preventDefault(); $('dropZone').classList.remove('drag'); if (modalPdfFile) return; handleFile(e.dataTransfer.files[0]); });
  
    $('scanBtn').addEventListener('click', async () => {
      if (!modalPdfBase64) return;
      const btn = $('scanBtn');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Scanning document…';
      try {
        const r = await fetch('/api/documents/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pdf_base64: modalPdfBase64 }) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'scan failed');
        const f = d.fields || {};
        if (f.booking_number)   $('f_bkg').value       = f.booking_number;
        if (f.carrier)          $('f_carrier').value   = f.carrier;
        if (f.port_of_loading)  $('f_pol').value       = f.port_of_loading;
        if (f.port_of_discharge)$('f_pod').value       = f.port_of_discharge;
        if (f.erd_date)         $('f_erd').value       = f.erd_date;
        if (f.cutoff_date)      $('f_cutoff').value    = f.cutoff_date;
        if (f.vessel_voyage)    $('f_vessel').value    = f.vessel_voyage;
        if (f.buyer)            $('f_buyer').value     = f.buyer;
        else if (f.consignee)   $('f_buyer').value     = f.consignee;
        if (f.container_size) {
          const raw = String(f.container_size).trim();
          const m = raw.match(/^\s*(\d+[A-Z]{2,3})\s*[xX*]\s*(\d+)\s*$/);
          let size, count;
          if (m) { size = m[1]; count = parseInt(m[2], 10) || 1; } else { size = raw; count = 1; }
          modalContainers = [];
          for (let i = 1; i <= count; i++) {
            modalContainers.push({ seq: i, size, container_number: (i === 1 && f.container_number) ? f.container_number : '', supplier: '', trucker: '', stage: 'not_started' });
          }
          renderContainersInModal();
        } else if (f.container_number) {
          modalContainers[0].container_number = f.container_number;
          renderContainersInModal();
        }
        $('scannedBanner').style.display = 'block';
        $('scanBtn').style.display = 'none';
      } catch (err) {
        $('formErr').textContent = 'Scan failed: ' + err.message;
        $('formErr').style.display = 'block';
        btn.disabled = false; btn.innerHTML = 'Scan &amp; auto-fill fields';
      }
    });
  
    $('btnSave').addEventListener('click', async () => {
      const isEditing = !!editingBookingNumber;
      const savedLabel = isEditing ? 'Save changes' : 'Save booking';
      let bkg = $('f_bkg').value.trim().toUpperCase();
      if (!bkg && editingBookingNumber) bkg = editingBookingNumber.toUpperCase();
      console.log('[SAVE] editing:', editingBookingNumber, '| bkg:', bkg, '| containers:', JSON.parse(JSON.stringify(modalContainers)));
      if (!bkg) { $('formErr').textContent = 'Booking number is required.'; $('formErr').style.display = 'block'; return; }
      $('formErr').style.display = 'none';
      const save = $('btnSave');
      save.disabled = true; save.innerHTML = '<span class="spinner"></span>Saving…';
      try {
        const payload = {
          booking_number: bkg,
          carrier: $('f_carrier').value.trim() || null,
          port_of_loading: $('f_pol').value.trim() || null,
          port_of_discharge: $('f_pod').value.trim() || null,
          erd_date: $('f_erd').value.trim() || null,
          cutoff_date: $('f_cutoff').value.trim() || null,
          vessel_voyage: $('f_vessel').value.trim() || null,
          buyer: $('f_buyer').value.trim() || null,
          containers: modalContainers.map(c => ({
            seq: c.seq, size: c.size || null,
            container_number: (c.container_number || '').trim() || null,
            supplier: c.supplier || null, trucker: c.trucker || null,
            stage: c.stage || 'not_started',
          })),
        };
        const bkRes = isEditing
          ? await fetch('/api/bookings/' + encodeURIComponent(editingBookingNumber), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
          : await fetch('/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!bkRes.ok) throw new Error((await bkRes.json()).error || 'save failed');
        if (modalPdfBase64) {
          try {
            const up = await fetch('/api/bookings/upload-pdf', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ booking_number: bkg, pdf_base64: modalPdfBase64, original_filename: modalPdfFile?.name }) });
            if (!up.ok) {
              const e = await up.json();
              $('formErr').textContent = 'Booking saved. PDF upload failed: ' + (e.error || 'unknown');
              $('formErr').style.display = 'block';
              save.disabled = false; save.textContent = savedLabel;
              await loadBookings(); await load();
              return;
            }
          } catch (e) { console.warn('[UPLOAD]', e); }
        }
        modal.close();
        await loadBookings(); await load();
      } catch (err) {
        console.error('[SAVE] failed:', err);
        $('formErr').textContent = err.message;
        $('formErr').style.display = 'block';
        save.disabled = false; save.textContent = savedLabel;
      }
    });
  
    let contactKind = null;
    async function loadContacts(kind) {
      try {
        const r = await fetch('/api/' + kind);
        const list = await r.json();
        renderContactList(kind, Array.isArray(list) ? list : []);
      } catch { renderContactList(kind, []); }
    }
  
    function renderContactList(kind, list) {
      const wrap = $(kind === 'truckers' ? 'truckerList' : 'supplierList');
      if (!list.length) { wrap.innerHTML = `<div class="bk-list-empty">No ${kind} yet.</div>`; return; }
      const rows = list.map(c => {
        const modeLabel = (c.preferred_mode === 'email') ? 'Email' : 'WhatsApp';
        const modeColor = (c.preferred_mode === 'email') ? 'var(--text-muted)' : 'var(--copper-700)';
        const dest = c.group_id ? `Group: ${c.group_id}` : (c.whatsapp ? c.whatsapp : '(no WhatsApp)');
        const locCell = c.locality ? `<span class="bk-cell-pill" style="background:var(--copper-50); color:var(--copper-700);">${esc(c.locality)}</span>` : `<span class="bk-cell-mono" style="color:var(--text-faint);">—</span>`;
        return `<div class="bk-row" style="grid-template-columns:160px 130px 1fr 100px 160px;"><div class="bk-cell-bkg">${esc(c.name)}${c.is_default ? ' <span title="Default for this area" style="color:var(--warning);">★</span>' : ''}</div><div>${locCell}</div><div class="bk-cell-sub">${esc(c.email || '—')}<br><span class="bk-cell-mono">${esc(dest)}</span></div><div class="bk-cell-mono" style="color:${modeColor}">${modeLabel}</div><div><button type="button" class="btn-secondary" style="padding:5px 10px; font-size:10px;" data-edit="${esc(c.name)}">Edit</button><button type="button" class="btn-secondary" style="padding:5px 10px; font-size:10px; color:var(--danger); border-color:var(--danger); margin-left:4px;" data-delete="${esc(c.name)}">Delete</button></div></div>`;
      }).join('');
      wrap.innerHTML = `<div class="bk-table"><div class="bk-hdr" style="grid-template-columns:160px 130px 1fr 100px 160px;"><div>Name</div><div>Location</div><div>Email / WhatsApp</div><div>Preferred</div><div>Actions</div></div>${rows}</div>`;
      wrap.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', () => openContactModal(kind, list.find(c => c.name === btn.dataset.edit))));
      wrap.querySelectorAll('[data-delete]').forEach(btn => btn.addEventListener('click', () => deleteContact(kind, btn.dataset.delete)));
    }
  
    function openContactModal(kind, existing) {
      contactKind = kind;
      const label = kind.slice(0, -1);
      $('contactModalTitle').textContent = existing ? `Edit ${label}` : `New ${label}`;
      $('c_name').value     = existing?.name     || '';
      $('c_name').disabled  = !!existing;
      $('c_locality').value = existing?.locality || '';
      $('c_whatsapp').value = existing?.whatsapp || '';
      $('c_email').value    = existing?.email    || '';
      $('c_group').value    = existing?.group_id || '';
      $('c_mode').value     = existing?.preferred_mode || 'whatsapp';
      $('c_is_default').checked = !!existing?.is_default;
      $('c_verify_result').style.display = 'none';
      $('c_verify_result').textContent = '';
      $('c_common_groups').style.display = 'none';
      $('c_common_groups_list').innerHTML = '';
      $('c_common_groups_empty').style.display = 'none';
      $('contactErr').style.display = 'none';
      const saveBtn = $('contactSave'); saveBtn.disabled = false; saveBtn.textContent = 'Save';
      $('contactModal').style.display = 'flex';
    }
  
    function closeContactModal() { $('contactModal').style.display = 'none'; $('c_name').disabled = false; contactKind = null; }
  
    async function deleteContact(kind, name) {
      if (!confirm(`Delete ${kind.slice(0,-1)} "${name}"?`)) return;
      try {
        const r = await fetch(`/api/${kind}/${encodeURIComponent(name)}`, { method: 'DELETE' });
        if (!r.ok) throw new Error('delete failed');
        await loadContacts(kind);
      } catch (e) { alert('Delete failed: ' + e.message); }
    }
  
    $('btnAddTrucker').addEventListener('click',  () => openContactModal('truckers', null));
    $('btnAddSupplier').addEventListener('click', () => openContactModal('suppliers', null));
    $('contactModalClose').addEventListener('click', closeContactModal);
    $('contactCancel').addEventListener('click', closeContactModal);
    $('contactModal').addEventListener('click', (e) => { if (e.target === $('contactModal')) closeContactModal(); });
  
    $('contactSave').addEventListener('click', async () => {
      const name = $('c_name').value.trim();
      if (!name) { $('contactErr').textContent = 'Name is required.'; $('contactErr').style.display = 'block'; return; }
      const whatsapp = $('c_whatsapp').value.trim().replace(/\D/g, '');
      const email    = $('c_email').value.trim();
      const mode     = $('c_mode').value;
      const locality = $('c_locality').value.trim();
      if (mode === 'whatsapp' && !whatsapp && !$('c_group').value.trim()) { $('contactErr').textContent = 'For WhatsApp preferred mode, provide a number or group ID.'; $('contactErr').style.display = 'block'; return; }
      if (mode === 'email' && !email) { $('contactErr').textContent = 'For Email preferred mode, provide an email address.'; $('contactErr').style.display = 'block'; return; }
      $('contactErr').style.display = 'none';
      const btn = $('contactSave');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Saving…';
      try {
        const payload = { name, locality: locality || null, whatsapp: whatsapp || null, email: email || null, group_id: $('c_group').value.trim() || null, preferred_mode: mode, is_default: $('c_is_default').checked };
        const r = await fetch('/api/' + contactKind, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!r.ok) throw new Error((await r.json()).error || 'save failed');
        const kind = contactKind;
        closeContactModal();
        await loadContacts(kind);
      } catch (e) {
        $('contactErr').textContent = e.message; $('contactErr').style.display = 'block';
      } finally {
        btn.disabled = false; btn.textContent = 'Save';
      }
    });
  
    const WA_LABEL = {
      initializing : { title:'Starting up', sub:'Jarvis is booting the WhatsApp client…', color:'#98A0AB', bg:'var(--steel-100)', ic:'…' },
      qr           : { title:'Scan to connect', sub:'Open WhatsApp on the Jarvis phone and scan this QR.', color:'#C98A1B', bg:'#FBEFD6', ic:'📱' },
      ready        : { title:'Connected', sub:'Jarvis is online and receiving messages.', color:'#6EC090', bg:'#E3F5EA', ic:'✓' },
      disconnected : { title:'Disconnected', sub:'Lost connection — reconnecting shortly.', color:'#C96B80', bg:'#FBE1E6', ic:'⚠' },
      auth_failure : { title:'Sign-in failed', sub:'WhatsApp rejected the session — click "Sign out & re-scan".', color:'#C96B80', bg:'#FBE1E6', ic:'⚠' },
    };
    let waLastStatus = null;
    let waAutoOpened = false;
  
    async function loadWhatsappStatus() {
      try {
        const r = await fetch('/api/whatsapp/status');
        const d = await r.json();
        renderWaState(d); renderWaBanner(d);
        waLastStatus = d.status;
      } catch {
        renderWaState({ status:'disconnected', lastError:'Cannot reach server' });
        renderWaBanner({ status:'disconnected' });
      }
    }
  
    function renderWaBanner(d) {
      const banner = $('waBanner');
      if (d.status === 'ready') { banner.style.display = 'none'; return; }
      const l = WA_LABEL[d.status] || WA_LABEL.disconnected;
      banner.style.display = 'block';
      banner.style.background = l.bg; banner.style.color = l.color;
      $('waBannerDot').style.background = l.color;
      $('waBannerText').textContent = l.title + ' — click to open WhatsApp tab';
      banner.onclick = () => { document.querySelector('.tab[data-tab="whatsapp"]').click(); };
    }
  
    function renderWaState(d) {
      const l = WA_LABEL[d.status] || WA_LABEL.disconnected;
      $('waStateIcon').textContent  = l.ic;
      $('waStateTitle').textContent = l.title;
      $('waStateSub').textContent   = d.lastError || l.sub;
      $('waStateTitle').style.color = l.color;
      const holder = $('waQrHolder');
      if (d.status === 'qr' && d.qr) {
        holder.style.display = 'block';
        if (typeof QRCode !== 'undefined') {
          $('waQr').innerHTML = '';
          QRCode.toCanvas(d.qr, { width: 260, margin: 1 }, (err, canvas) => {
            if (!err && canvas) $('waQr').appendChild(canvas);
            else $('waQr').textContent = 'QR render failed — check console';
          });
        } else {
          $('waQr').textContent = 'QR library not loaded (qrcode.min.js missing from dashboard/)';
        }
      } else { holder.style.display = 'none'; }
      $('waMetaLine').textContent = d.lastChange ? 'Last change: ' + new Date(d.lastChange).toLocaleTimeString() : '';
    }
  
    $('btnWaReset').addEventListener('click', async () => {
      if (!confirm('Sign out of WhatsApp and force a new QR scan?')) return;
      const btn = $('btnWaReset');
      btn.disabled = true; btn.textContent = 'Signing out…';
      try {
        const r = await fetch('/api/whatsapp/reset', { method: 'POST' });
        if (!r.ok) throw new Error((await r.json()).error || 'reset failed');
      } catch (e) { alert('Reset failed: ' + e.message); }
      btn.disabled = false; btn.textContent = 'Sign out & re-scan';
      setTimeout(loadWhatsappStatus, 800);
    });
  
    loadWhatsappStatus();
    setInterval(loadWhatsappStatus, 3000);
    setTimeout(() => {
      if (!waAutoOpened && waLastStatus && waLastStatus !== 'ready') {
        waAutoOpened = true;
        document.querySelector('.tab[data-tab="whatsapp"]').click();
      }
    }, 1500);
  
    let teamMembers = [];
    async function loadSettings() {
      try {
        const r = await fetch('/api/settings');
        const s = await r.json();
        $('s_manager_number').value = s.manager_number || '';
        $('s_group_id').value       = s.team_group_id  || '';
        teamMembers = Array.isArray(s.internal_team) ? s.internal_team.map(x => (typeof x === 'string' ? { name: '', whatsapp: x, role: '' } : x)) : [];
        renderTeamList();
        $('settingsError').style.display = 'none';
        $('settingsSaved').style.display = 'none';
        $('groupPicker').style.display   = 'none';
      } catch (e) { $('settingsError').textContent = 'Could not load settings: ' + e.message; $('settingsError').style.display = 'block'; }
    }
  
    function renderTeamList() {
      if (!teamMembers.length) { $('teamList').innerHTML = `<div style="font-family:var(--mono); font-size:12px; color:var(--text-faint); padding:14px; text-align:center; border:1px dashed var(--border-mid); border-radius:var(--radius-sm);">No team members.</div>`; return; }
      $('teamList').innerHTML = teamMembers.map((m, i) => `
        <div style="display:grid; grid-template-columns:1fr 1fr 1fr auto; gap:10px; align-items:end; margin-bottom:10px;">
          <div><label>Name</label><input type="text" data-team-field="name" data-team-index="${i}" value="${esc(m.name || '')}" placeholder="Full name"></div>
          <div><label>WhatsApp</label><input type="text" data-team-field="whatsapp" data-team-index="${i}" value="${esc(m.whatsapp || '')}" placeholder="e.g. 918056944193"></div>
          <div><label>Role</label><input type="text" data-team-field="role" data-team-index="${i}" value="${esc(m.role || '')}" placeholder="e.g. Ops Lead"></div>
          <button type="button" class="btn-secondary" data-team-remove="${i}" style="padding:8px 12px; font-size:11px; color:var(--danger); border-color:var(--danger);">Remove</button>
        </div>`).join('');
      $('teamList').querySelectorAll('[data-team-field]').forEach(inp => {
        inp.addEventListener('input', (e) => { teamMembers[+e.target.dataset.teamIndex][e.target.dataset.teamField] = e.target.value; });
      });
      $('teamList').querySelectorAll('[data-team-remove]').forEach(btn => {
        btn.addEventListener('click', () => { teamMembers.splice(+btn.dataset.teamRemove, 1); renderTeamList(); });
      });
    }
  
    $('btnAddTeamMember').addEventListener('click', () => { teamMembers.push({ name: '', whatsapp: '', role: '' }); renderTeamList(); });
  
    async function runGroupValidator({ btnId, queryInputId, pickerId, pickerListId, targetInputId, errorHandler }) {
      const q = $(queryInputId).value.trim();
      if (!q) { if (errorHandler) errorHandler('Type a group name (or part of one) to validate.'); return; }
      if (errorHandler) errorHandler(null);
      const btn = $(btnId);
      const originalLabel = btn.textContent;
      btn.disabled = true; btn.textContent = 'Searching…';
      try {
        const r = await fetch('/api/whatsapp/find-groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: q }) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'lookup failed');
        const groups = d.groups || [];
        const list = $(pickerListId);
        if (!groups.length) list.innerHTML = `<div style="font-size:12.5px; color:var(--text-muted);">No matches.</div>`;
        else {
          list.innerHTML = groups.map(g => `<div style="display:flex; align-items:center; justify-content:space-between; padding:9px 0; border-bottom:1px solid var(--border);"><div><div style="font-size:13px; font-weight:600; color:var(--text-strong);">${esc(g.name)}</div><div class="mono" style="font-size:11px; color:var(--text-faint);">${esc(g.id)} ${g.participants ? '· ' + g.participants + ' members' : ''}</div></div><button type="button" class="btn-secondary" data-pick-group="${esc(g.id)}" style="padding:6px 14px; font-size:10.5px;">Use this</button></div>`).join('');
          list.querySelectorAll('[data-pick-group]').forEach(b => { b.addEventListener('click', () => { $(targetInputId).value = b.dataset.pickGroup; $(pickerId).style.display = 'none'; }); });
        }
        $(pickerId).style.display = 'block';
      } catch (e) { if (errorHandler) errorHandler('Validate failed: ' + e.message); }
      finally { btn.disabled = false; btn.textContent = originalLabel; }
    }
  
    $('c_verify_number').addEventListener('click', async () => {
      const raw = $('c_whatsapp').value.trim().replace(/\D/g, '');
      if (raw.length < 8) { $('contactErr').textContent = 'Enter a full WhatsApp number.'; $('contactErr').style.display = 'block'; return; }
      $('contactErr').style.display = 'none';
      const btn = $('c_verify_number');
      const originalLabel = btn.textContent;
      btn.disabled = true; btn.textContent = 'Checking…';
      const result = $('c_verify_result');
      result.style.display = 'block'; result.style.background = 'var(--steel-100)'; result.style.color = 'var(--text-muted)'; result.textContent = 'Contacting WhatsApp…';
      try {
        const vr = await fetch('/api/whatsapp/verify-number', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number: raw }) });
        const vd = await vr.json();
        if (!vr.ok) throw new Error(vd.error || 'verify failed');
        if (!vd.registered) { result.style.background = '#FBE1E6'; result.style.color = 'var(--danger-text)'; result.textContent = '✗ Not on WhatsApp'; $('c_common_groups').style.display = 'none'; return; }
        result.style.background = '#E3F5EA'; result.style.color = '#2F7A50'; result.textContent = '✓ On WhatsApp' + (vd.formatted ? ' (' + vd.formatted + ')' : '');
        const cg = await fetch('/api/whatsapp/common-groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contactId: vd.contactId }) });
        const cd = await cg.json();
        if (!cg.ok) throw new Error(cd.error || 'common-groups failed');
        const groups = cd.groups || [];
        $('c_common_groups').style.display = 'block';
        if (!groups.length) { $('c_common_groups_list').innerHTML = ''; $('c_common_groups_empty').style.display = 'block'; }
        else {
          $('c_common_groups_empty').style.display = 'none';
          $('c_common_groups_list').innerHTML = groups.map(g => `<div style="display:flex; align-items:center; justify-content:space-between; padding:9px 0; border-bottom:1px solid var(--border);"><div><div style="font-size:13px; font-weight:600; color:var(--text-strong);">${esc(g.name)}</div><div class="mono" style="font-size:11px; color:var(--text-faint);">${esc(g.id)} ${g.participants ? '· ' + g.participants + ' members' : ''}</div></div><button type="button" class="btn-secondary" data-cg-pick="${esc(g.id)}" style="padding:6px 14px; font-size:10.5px;">Use this</button></div>`).join('');
          $('c_common_groups_list').querySelectorAll('[data-cg-pick]').forEach(b => { b.addEventListener('click', () => { $('c_group').value = b.dataset.cgPick; }); });
        }
      } catch (e) { result.style.background = '#FBE1E6'; result.style.color = 'var(--danger-text)'; result.textContent = 'Verify failed: ' + e.message; }
      finally { btn.disabled = false; btn.textContent = originalLabel; }
    });
  
    $('btnValidateGroup').addEventListener('click', () => runGroupValidator({
      btnId: 'btnValidateGroup', queryInputId: 's_group_name', pickerId: 'groupPicker', pickerListId: 'groupPickerList', targetInputId: 's_group_id',
      errorHandler: (msg) => { if (msg) { $('settingsError').textContent = msg; $('settingsError').style.display = 'block'; } else { $('settingsError').style.display = 'none'; } },
    }));
  
    $('btnSaveSettings').addEventListener('click', async () => {
      $('settingsError').style.display = 'none';
      $('settingsSaved').style.display = 'none';
      const managerNum = $('s_manager_number').value.trim().replace(/\D/g, '');
      if (!managerNum) { $('settingsError').textContent = 'Manager number is required.'; $('settingsError').style.display = 'block'; return; }
      const cleanedTeam = teamMembers
        .filter(m => (m.name && m.name.trim()) || (m.whatsapp && m.whatsapp.trim()))
        .map(m => ({ name: (m.name || '').trim(), whatsapp: (m.whatsapp || '').replace(/\D/g, ''), role: (m.role || '').trim() }));
      const payload = { manager_number: managerNum, internal_team: cleanedTeam, team_group_id: $('s_group_id').value.trim() };
      const btn = $('btnSaveSettings');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Saving…';
      try {
        const r = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!r.ok) throw new Error((await r.json()).error || 'save failed');
        $('settingsSaved').style.display = 'block';
        setTimeout(() => { $('settingsSaved').style.display = 'none'; }, 2500);
        await loadSettings();
      } catch (e) { $('settingsError').textContent = e.message; $('settingsError').style.display = 'block'; }
      finally { btn.disabled = false; btn.textContent = 'Save changes'; }
    });
  
    function botAppend(kind, text, media) {
      const log = $('botLog');
      if (log.querySelector('div[style*="Type a command"]')) log.innerHTML = '';
      const wrap = document.createElement('div');
      const isMe = kind === 'me';
      wrap.style.cssText = `display:flex; ${isMe ? 'justify-content:flex-end;' : 'justify-content:flex-start;'}`;
      const bubble = document.createElement('div');
      bubble.style.cssText = `max-width:75%; padding:9px 13px; border-radius:${isMe ? '14px 14px 3px 14px' : '14px 14px 14px 3px'}; background:${isMe ? 'var(--copper-600)' : 'var(--steel-100)'}; color:${isMe ? '#fff' : 'var(--text-strong)'}; font-family:${isMe ? 'var(--mono)' : 'var(--sans)'}; font-size:${isMe ? '12.5px' : '13px'}; line-height:1.45; white-space:pre-wrap; word-break:break-word;`;
      bubble.textContent = text || '';
      if (media) {
        const attach = document.createElement('div');
        attach.style.cssText = 'margin-top:6px; padding:6px 8px; background:rgba(0,0,0,.08); border-radius:6px; font-size:11px; font-family:var(--mono);';
        attach.textContent = '📎 ' + (media.filename || '(attachment)');
        bubble.appendChild(attach);
      }
      wrap.appendChild(bubble);
      log.appendChild(wrap);
      log.scrollTop = log.scrollHeight;
    }
  
    async function botSend() {
      const text = $('botInput').value.trim();
      if (!text) return;
      $('botInput').value = '';
      botAppend('me', text, null);
      const btn = $('botSend');
      btn.disabled = true;
      try {
        const r = await fetch('/api/bot/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'command failed');
        if (!d.replies?.length) botAppend('bot', '(no reply from Jarvis)', null);
        else d.replies.forEach(rep => botAppend('bot', rep.text, rep.media));
      } catch (e) { botAppend('bot', '⚠ ' + e.message, null); }
      finally { btn.disabled = false; $('botInput').focus(); }
    }
  
    $('botSend').addEventListener('click', botSend);
    $('botInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); botSend(); } });
  
    const TASK_MESSAGE_DEFAULTS = {
      nudge_scale_ticket: 'Hey — following up on the scale ticket. Can you send it when you get a moment?',
      nudge_load_ready  : 'Checking in — is the load ready for pickup?',
      nudge_empty_drop  : 'Hey — has the empty container been dropped yet?',
      nudge_ingate      : 'Following up — has the container been ingated at port yet?',
      nudge_pickup      : 'Any update on the pickup?',
      generic_message   : '',
    };
    const TASK_TYPE_TO_CONDITION = {
      nudge_scale_ticket: (bkg) => bkg ? { type:'workflow_flag_true', flag:'scale_ticket', bkg_no: bkg } : null,
      nudge_load_ready  : (bkg) => bkg ? { type:'workflow_step_at_or_past', step:'load_ready', bkg_no: bkg } : null,
      nudge_empty_drop  : (bkg) => bkg ? { type:'workflow_step_at_or_past', step:'empty_dropped', bkg_no: bkg } : null,
      nudge_ingate      : (bkg) => bkg ? { type:'workflow_step_at_or_past', step:'ingate_received', bkg_no: bkg } : null,
      nudge_pickup      : (bkg) => bkg ? { type:'workflow_step_at_or_past', step:'picked_up', bkg_no: bkg } : null,
      generic_message   : () => null,
    };
  
    $('t_type').addEventListener('change', () => {
      const type = $('t_type').value;
      const cur  = $('t_message').value.trim();
      const defaults = Object.values(TASK_MESSAGE_DEFAULTS);
      if (!cur || defaults.includes(cur)) $('t_message').value = TASK_MESSAGE_DEFAULTS[type] || '';
    });
    $('t_message').value = TASK_MESSAGE_DEFAULTS[$('t_type').value] || '';
  
    async function loadFacts() {
      try {
        const r = await fetch('/api/facts');
        if (r.status === 403) { $('f_list').innerHTML = `<div style="color:var(--danger); font-size:12.5px;">Admin access required.</div>`; return; }
        const d = await r.json();
        renderFacts(d.facts || []);
      } catch (e) { $('f_list').innerHTML = `<div style="color:var(--danger); font-size:12.5px;">Failed to load: ${esc(e.message)}</div>`; }
    }
  
    function renderFacts(list) {
      if (!list.length) { $('f_list').innerHTML = `<div style="color:var(--text-faint); font-size:12.5px; padding:12px 0;">No facts yet. Add one above, or say "remember X" to Jarvis on WhatsApp.</div>`; return; }
      const indexed = list.map((f, i) => ({ ...f, _idx: i })).reverse(); // most recent first, index refers to original array position
      $('f_list').innerHTML = indexed.map(f => `<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; padding:10px 12px; background:var(--steel-100); border-radius:var(--radius-sm); border:1px solid var(--border);"><div style="flex:1; min-width:0;"><div style="font-size:12.5px; color:var(--text-strong);">${esc(f.text)}</div><div class="mono" style="font-size:10.5px; color:var(--text-faint); margin-top:3px;">${f.created_at ? new Date(f.created_at).toLocaleString() : ''}</div></div><button type="button" class="btn-secondary" data-f-del="${f._idx}" style="padding:5px 10px; font-size:10.5px; color:var(--danger); border-color:var(--danger); white-space:nowrap;">Delete</button></div>`).join('');
      $('f_list').querySelectorAll('[data-f-del]').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this fact?')) return;
          btn.disabled = true;
          try {
            const r = await fetch('/api/facts/' + btn.dataset.fDel, { method: 'DELETE' });
            if (!r.ok) throw new Error((await r.json()).error || 'delete failed');
            loadFacts();
          } catch (e) { alert('Failed: ' + e.message); btn.disabled = false; }
        });
      });
    }
  
    $('f_add').addEventListener('click', async () => {
      const text = $('f_new_text').value.trim();
      $('f_add_err').textContent = '';
      if (!text) { $('f_add_err').textContent = 'Enter a fact first.'; return; }
      $('f_add').disabled = true;
      try {
        const r = await fetch('/api/facts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
        if (!r.ok) throw new Error((await r.json()).error || 'save failed');
        $('f_new_text').value = '';
        loadFacts();
      } catch (e) { $('f_add_err').textContent = e.message; }
      finally { $('f_add').disabled = false; }
    });
  
    async function loadTasks() {
      try {
        const r = await fetch('/api/tasks');
        const d = await r.json();
        renderTasksPending(d.pending || []);
        renderTasksHistory(d.history || []);
      } catch (e) { $('t_pending_list').innerHTML = `<div style="color:var(--danger); font-size:12.5px;">Failed to load: ${esc(e.message)}</div>`; }
    }
  
    function renderTasksPending(list) {
      if (!list.length) { $('t_pending_list').innerHTML = `<div style="color:var(--text-faint); font-size:12.5px; padding:12px 0;">No pending tasks.</div>`; return; }
      list.sort((a,b) => new Date(a.fire_at) - new Date(b.fire_at));
      $('t_pending_list').innerHTML = list.map(t => {
        const fireIn = Math.round((new Date(t.fire_at) - new Date()) / 60000);
        const when   = fireIn > 0 ? `in ${fireIn} min` : (fireIn < -60 ? `${Math.abs(Math.round(fireIn/60))}h overdue` : 'now');
        return `<div style="display:flex; justify-content:space-between; align-items:center; padding:10px 12px; background:var(--steel-100); border-radius:var(--radius-sm); border:1px solid var(--border);"><div style="flex:1; min-width:0;"><div style="font-size:12.5px; font-weight:600; color:var(--text-strong);">${esc(t.type.replace(/_/g,' '))} → ${esc(t.target_kind)} ${esc(t.target_name || '')}</div><div class="mono" style="font-size:11px; color:var(--text-muted); margin-top:2px;">${t.bkg_no ? esc(t.bkg_no) + (t.container_seq != null ? '/' + t.container_seq : '') + ' · ' : ''}${when} · fires ${new Date(t.fire_at).toLocaleString()}</div><div style="font-size:11.5px; color:var(--text-body); margin-top:4px; font-style:italic;">"${esc(t.message.slice(0, 100))}${t.message.length > 100 ? '…' : ''}"</div></div><button type="button" class="btn-secondary" data-t-cancel="${esc(t.id)}" style="padding:5px 10px; font-size:10.5px; color:var(--danger); border-color:var(--danger); white-space:nowrap;">Cancel</button></div>`;
      }).join('');
      $('t_pending_list').querySelectorAll('[data-t-cancel]').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Cancel this task?')) return;
          btn.disabled = true;
          try {
            const r = await fetch('/api/tasks/' + encodeURIComponent(btn.dataset.tCancel), { method:'DELETE' });
            if (!r.ok) throw new Error((await r.json()).error || 'cancel failed');
            await loadTasks();
          } catch (e) { alert('Cancel failed: ' + e.message); btn.disabled = false; }
        });
      });
    }
  
    function renderTasksHistory(list) {
      if (!list.length) { $('t_history_list').innerHTML = `<div style="color:var(--text-faint); font-size:11.5px; padding:6px 0;">No history yet.</div>`; return; }
      list.sort((a,b) => new Date(b.completed_at || 0) - new Date(a.completed_at || 0));
      $('t_history_list').innerHTML = list.slice(0, 100).map(t => {
        const badge = t.status === 'done' ? 'background:#E3F5EA; color:#2F7A50;' : t.status === 'cancelled' ? 'background:var(--steel-150); color:var(--text-muted);' : 'background:#FBE1E6; color:var(--danger-text);';
        return `<div style="display:grid; grid-template-columns:80px 1fr 160px; gap:10px; padding:6px 10px; font-size:11px; border-bottom:1px solid var(--border);"><div><span class="bk-cell-pill" style="${badge}">${esc(t.status)}</span></div><div>${esc(t.type.replace(/_/g,' '))} → ${esc(t.target_kind)} ${esc(t.target_name || '')} ${t.bkg_no ? '· ' + esc(t.bkg_no) + (t.container_seq != null ? '/' + t.container_seq : '') : ''} <span style="color:var(--text-faint);">${esc(t.result_note || '')}</span></div><div class="mono" style="color:var(--text-faint);">${t.completed_at ? new Date(t.completed_at).toLocaleString() : '—'}</div></div>`;
      }).join('');
    }
  
    const TASK_TYPE_TO_CONTAINER_CONDITION = {
      nudge_scale_ticket: (bkg, seq) => bkg && seq ? { type:'container_stage_at_or_past', step:'picked_up',       bkg_no: bkg, container_seq: seq } : null,
      nudge_load_ready  : (bkg, seq) => bkg && seq ? { type:'container_stage_at_or_past', step:'load_ready',      bkg_no: bkg, container_seq: seq } : null,
      nudge_empty_drop  : (bkg, seq) => bkg && seq ? { type:'container_stage_at_or_past', step:'empty_dropped',   bkg_no: bkg, container_seq: seq } : null,
      nudge_ingate      : (bkg, seq) => bkg && seq ? { type:'container_stage_at_or_past', step:'ingate_received', bkg_no: bkg, container_seq: seq } : null,
      nudge_pickup      : (bkg, seq) => bkg && seq ? { type:'container_stage_at_or_past', step:'picked_up',       bkg_no: bkg, container_seq: seq } : null,
      generic_message   : () => null,
    };
  
    $('t_create').addEventListener('click', async () => {
      const type = $('t_type').value;
      const target_kind = $('t_target_kind').value;
      const target_name = $('t_target_name').value.trim();
      const bkg_no = $('t_bkg').value.trim().toUpperCase();
      const container_seq_raw = $('t_container_seq').value.trim();
      const container_seq = container_seq_raw ? parseInt(container_seq_raw, 10) : null;
      const delay_minutes = parseInt($('t_delay').value, 10);
      const message = $('t_message').value.trim();
      $('t_create_err').textContent = '';
      if (target_kind !== 'manager' && !target_name) { $('t_create_err').textContent = 'Name required for trucker/supplier.'; return; }
      if (!message) { $('t_create_err').textContent = 'Message required.'; return; }
      if (!delay_minutes || delay_minutes < 1) { $('t_create_err').textContent = 'Delay must be at least 1 minute.'; return; }
      if (container_seq_raw && (isNaN(container_seq) || container_seq < 1)) { $('t_create_err').textContent = 'Container # must be a positive number.'; return; }
      if (container_seq && !bkg_no) { $('t_create_err').textContent = 'Container # requires a booking number.'; return; }
      const btn = $('t_create'); btn.disabled = true; btn.textContent = 'Creating…';
      try {
        let condition = null;
        if (container_seq && bkg_no && TASK_TYPE_TO_CONTAINER_CONDITION[type]) condition = TASK_TYPE_TO_CONTAINER_CONDITION[type](bkg_no, container_seq);
        else if (bkg_no && TASK_TYPE_TO_CONDITION[type]) condition = TASK_TYPE_TO_CONDITION[type](bkg_no);
        const r = await fetch('/api/tasks', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ type, target_kind, target_name: target_name || null, bkg_no: bkg_no || null, container_seq: container_seq || null, delay_minutes, message, condition }) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'create failed');
        $('t_target_name').value = ''; $('t_bkg').value = ''; $('t_container_seq').value = '';
        $('t_message').value = TASK_MESSAGE_DEFAULTS[type] || '';
        await loadTasks();
      } catch (e) { $('t_create_err').textContent = e.message; }
      finally { btn.disabled = false; btn.textContent = 'Create task'; }
    });
  
  })();