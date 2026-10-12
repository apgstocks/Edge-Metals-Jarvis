// dashboard/app/04-loads-wizard.js — split from dashboard/index.html's <script> (helpers/sourceParts.js reconstructs the original)
const TASK_TYPES = [
  { value: 'nudge_scale_ticket', label: 'Nudge for scale ticket', cond: { kind: 'flag', flag: 'scale_ticket' }, msg: b => `Hi — following up on the scale ticket${b ? ' for ' + b : ''}. Can you send it over when you get a chance?` },
  { value: 'nudge_load_ready',   label: 'Nudge for load ready',   cond: { kind: 'step', step: 'load_ready' },      msg: b => `Hi — checking in on load-ready status${b ? ' for ' + b : ''}.` },
  { value: 'nudge_empty_drop',   label: 'Nudge for empty drop',   cond: { kind: 'step', step: 'empty_dropped' },   msg: b => `Hi — just confirming the empty has been dropped${b ? ' for ' + b : ''}.` },
  { value: 'nudge_ingate',       label: 'Nudge for ingate',       cond: { kind: 'step', step: 'ingate_received' }, msg: b => `Hi — following up on ingate confirmation${b ? ' for ' + b : ''}.` },
  { value: 'nudge_pickup',       label: 'Nudge for pickup',       cond: { kind: 'step', step: 'picked_up' },       msg: b => `Hi — checking on pickup timing${b ? ' for ' + b : ''}.` },
  { value: 'generic_message',    label: 'Custom message',         cond: null,                                     msg: () => '' },
];
function buildTaskCondition(typeValue, bkgNo, containerSeq) {
  const t = TASK_TYPES.find(x => x.value === typeValue);
  if (!t || !t.cond || !bkgNo) return null;
  if (t.cond.kind === 'flag') return { type: 'workflow_flag_true', flag: t.cond.flag, bkg_no: bkgNo };
  if (containerSeq != null) return { type: 'container_stage_at_or_past', step: t.cond.step, bkg_no: bkgNo, container_seq: containerSeq };
  return { type: 'workflow_step_at_or_past', step: t.cond.step, bkg_no: bkgNo };
}
function refreshTaskDefaultMessage() {
  const t = TASK_TYPES.find(x => x.value === $('t_type').value);
  if (t) $('t_message').value = t.msg($('t_bkg').value.trim().toUpperCase());
}
// ── BUGZILLA ───────────────────────────────────────────────────────────────
// Apsara, 2026-09-24: "create a bugzilla tab in website so that we can keep
// track of all the fixes so that we can revisit it."
//
// The three states are the whole design: OPEN is broken, FIXED is somebody
// says it is mended, VERIFIED is her having seen it work. "Fixed" is a claim
// and "verified" is evidence, and keeping them apart is what makes the list
// revisitable — the count she reads first is "fixed, waiting on you".
let bugFilter = 'open';
const BUG_COLOR = { open: 'var(--status-danger)', fixed: 'var(--status-warning)', verified: 'var(--status-success)', wont_fix: 'var(--text-faint)' };
const BUG_LABEL = { open: 'Open', fixed: 'Fixed — check it', verified: 'Verified', wont_fix: "Won't fix" };
const BUG_SOURCE = { her: 'you', jarvis: 'Jarvis (you asked)', auto_question: 'filed itself — unanswered question', auto_crash: 'filed itself — crash' };

async function renderBugzilla() {
  const data = await api(`/api/bugs?status=${encodeURIComponent(bugFilter)}`);
  const bugs = data.bugs || [], s = data.summary || {};
  const isAdmin = ROLE === 'admin';
  const tab = (id, label, n) => `<button class="bug-filter btn ${bugFilter === id ? 'btn-primary' : 'btn-dark'}" data-f="${id}" style="padding:6px 12px;">${esc(label)}${n === undefined ? '' : ` (${n})`}</button>`;
  $('viewRoot').innerHTML = `
    <section style="max-width:1000px; margin:0 auto; padding:38px 40px 80px;">
      <div class="eyebrow">// Bugzilla</div>
      <h2 style="font-size:24px; text-transform:uppercase; margin-bottom:6px;">What broke, and what happened about it</h2>
      <div style="font-size:13px; color:var(--text-muted); margin-bottom:20px;">
        ${s.open || 0} open · <strong style="color:var(--status-warning);">${s.awaiting_check || 0} fixed and waiting for you to check</strong> · ${s.verified || 0} verified${s.auto ? ` · ${s.auto} filed themselves` : ''}
      </div>
      <div class="card" style="padding:18px 20px; margin-bottom:18px;">
        <div style="font-family:var(--font-mono); font-size:10px; font-weight:600; letter-spacing:.16em; text-transform:uppercase; color:var(--text-muted); margin-bottom:12px;">Report something</div>
        <div style="display:grid; grid-template-columns:2fr 1fr 1fr; gap:12px;">
          <div class="field"><label>What went wrong</label><input id="bug_title" placeholder="Invoice printed the wrong weight on the second grade"></div>
          <div class="field"><label>Where</label><select id="bug_area">${(data.areas || []).map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('')}</select></div>
          <div class="field"><label>How bad</label><select id="bug_sev">${(data.severities || []).map(v => `<option value="${esc(v)}"${v === 'normal' ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
          <div class="field" style="grid-column:1/-1;"><label>What you were doing (optional)</label><input id="bug_detail" placeholder="Generated it from the Sales row for TCLU9988776"></div>
        </div>
        <div style="display:flex; align-items:center; gap:12px;">
          <button id="btnFileBug" class="btn btn-primary">File it</button>
          <span id="bugErr" style="font-family:var(--font-mono); font-size:11px; color:var(--status-danger);"></span>
        </div>
      </div>
      <div style="display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap;">
        ${tab('open', 'Open', s.open || 0)}${tab('fixed', 'Fixed — check', s.awaiting_check || 0)}${tab('verified', 'Verified', s.verified || 0)}${tab('all', 'Everything', s.total || 0)}
      </div>
      <div style="display:flex; flex-direction:column; gap:10px;">
        ${bugs.length ? bugs.map(b => `
          <div class="card" style="padding:14px 16px; border-left:3px solid ${BUG_COLOR[b.status] || 'var(--text-faint)'};">
            <div style="display:flex; justify-content:space-between; gap:14px; align-items:flex-start;">
              <div style="flex:1; min-width:0;">
                <div style="font-size:13.5px; font-weight:600; color:var(--text-strong);">${esc(b.title)}</div>
                <div style="font-family:var(--font-mono); font-size:10.5px; color:var(--text-muted); margin-top:4px;">
                  ${esc(b.id)} · ${esc(BUG_LABEL[b.status] || b.status)} · ${esc(b.severity || 'normal')}${b.area ? ' · ' + esc(b.area) : ''} · ${esc(String(b.created_at || '').slice(0, 10))}${b.times > 1 ? ` · seen ${b.times}×` : ''} · ${esc(BUG_SOURCE[b.source] || b.source)}
                </div>
                ${b.detail ? `<div style="font-size:12px; color:var(--text-body); margin-top:7px; white-space:pre-wrap;">${esc(String(b.detail).slice(0, 600))}</div>` : ''}
                ${b.fix_note ? `<div style="font-size:12px; color:var(--status-success); margin-top:7px;">Fix: ${esc(b.fix_note)}</div>` : ''}
                ${b.recurred_after_fix ? `<div style="font-size:12px; color:var(--status-danger, #C5402F); margin-top:7px;">Came back after being marked fixed — the fix did not hold.</div>` : ''}
                ${(b.known_fix || []).length ? `<div style="font-size:12px; color:var(--text-body); margin-top:7px; border-left:2px solid var(--text-faint); padding-left:8px;">Seen before — ${(b.known_fix || []).map(k => `<b>${esc(k.id)}</b> (${esc(k.status)}): ${esc(k.cause ? k.cause + ' — ' : '')}${esc(k.fix_note)}`).join('<br>')}</div>` : ''}
              </div>
              ${isAdmin ? `<div style="display:flex; flex-direction:column; gap:6px; flex-shrink:0;">
                ${b.status === 'open' ? `<button class="btn btn-dark bug-fix" data-id="${esc(b.id)}" style="white-space:nowrap;">Mark fixed…</button>` : ''}
                ${b.status === 'fixed' ? `<button class="btn btn-primary bug-verify" data-id="${esc(b.id)}" style="white-space:nowrap;">I checked it — verified</button>` : ''}
                ${b.status === 'fixed' ? `<button class="btn btn-danger bug-reopen" data-id="${esc(b.id)}" style="white-space:nowrap;">Still broken</button>` : ''}
                ${b.status === 'verified' ? `<button class="btn btn-dark bug-reopen" data-id="${esc(b.id)}" style="white-space:nowrap;">It came back</button>` : ''}
                ${b.status !== 'wont_fix' && b.status !== 'verified' ? `<button class="btn btn-dark bug-wont" data-id="${esc(b.id)}" style="white-space:nowrap;">Won't fix</button>` : ''}
              </div>` : ''}
            </div>
            ${(b.history || []).length > 1 ? `<details style="margin-top:8px;"><summary style="font-family:var(--font-mono); font-size:10.5px; color:var(--text-faint); cursor:pointer;">history</summary>
              ${(b.history || []).map(h => `<div style="font-family:var(--font-mono); font-size:10.5px; color:var(--text-muted); padding:3px 0;">${esc(String(h.at || '').slice(0, 16).replace('T', ' '))} — ${esc(h.what || '')}${h.by ? ' (' + esc(h.by) + ')' : ''}${h.note ? ': ' + esc(h.note) : ''}</div>`).join('')}
            </details>` : ''}
          </div>`).join('')
        : `<div class="card" style="padding:30px; text-align:center; font-family:var(--font-mono); font-size:12px; color:var(--text-faint);">Nothing ${bugFilter === 'all' ? 'filed yet' : 'here'}. ${bugFilter === 'open' ? 'Either it is all working or nothing has been reported yet.' : ''}</div>`}
      </div>
    </section>`;

  document.querySelectorAll('.bug-filter').forEach(b => b.addEventListener('click', () => { bugFilter = b.dataset.f; renderBugzilla(); }));
  $('btnFileBug').addEventListener('click', async () => {
    const title = $('bug_title').value.trim();
    $('bugErr').textContent = '';
    if (!title) { $('bugErr').textContent = 'Say what went wrong.'; return; }
    try {
      await api('/api/bugs', { method: 'POST', body: JSON.stringify({
        title, detail: $('bug_detail').value.trim(), area: $('bug_area').value, severity: $('bug_sev').value }) });
      bugFilter = 'open';
      renderBugzilla();
    } catch (e) { $('bugErr').textContent = e.message; }
  });
  const patch = async (id, body) => { await api(`/api/bugs/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }); renderBugzilla(); };
  // A fix with no note is the thing she cannot revisit, so the note is asked
  // for here rather than being optional.
  document.querySelectorAll('.bug-fix').forEach(b => b.addEventListener('click', () => {
    const note = prompt('What was the fix? Say what caused it and the steps that worked, so it can be recognised and fixed faster if it happens again.');
    if (note === null) return;
    patch(b.dataset.id, { status: 'fixed', fix_note: note });
  }));
  document.querySelectorAll('.bug-verify').forEach(b => b.addEventListener('click', () => patch(b.dataset.id, { status: 'verified' })));
  document.querySelectorAll('.bug-reopen').forEach(b => b.addEventListener('click', () => patch(b.dataset.id, { status: 'open', note: 'reopened' })));
  document.querySelectorAll('.bug-wont').forEach(b => b.addEventListener('click', () => {
    const why = prompt('Why not?');
    if (why === null) return;
    patch(b.dataset.id, { status: 'wont_fix', fix_note: why });
  }));
}

function renderTasks(data) {
  const pending = data.pending || [], history = data.history || [];
  $('viewRoot').innerHTML = `
    <section style="max-width:900px; margin:0 auto; padding:38px 40px 80px;">
      <div class="eyebrow">// Tasks</div>
      <h2 style="font-size:24px; text-transform:uppercase; margin-bottom:6px;">Follow-ups</h2>
      <div style="font-size:13px; color:var(--text-muted); margin-bottom:22px;">Persistent nudges. Fire at the scheduled time — auto-cancel if the answer arrives first.</div>
      <div class="card" style="padding:20px 22px; margin-bottom:18px;">
        <div style="font-family:var(--font-mono); font-size:10px; font-weight:600; letter-spacing:.16em; text-transform:uppercase; color:var(--text-muted); margin-bottom:14px;">Create task</div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px;">
          <div class="field"><label>Type</label><select id="t_type">${TASK_TYPES.map(t => `<option value="${t.value}">${esc(t.label)}</option>`).join('')}</select></div>
          <div class="field"><label>Target</label><select id="t_target_kind"><option value="trucker">Trucker</option><option value="supplier">Supplier</option><option value="manager">Manager (me)</option></select></div>
          <div class="field"><label>Name (leave blank for manager)</label><input id="t_target_name" placeholder="e.g. Dave R."></div>
          <div class="field"><label>Booking (optional, enables auto-cancel)</label><input id="t_bkg" placeholder="DALA23991600" style="font-family:var(--font-mono);"></div>
          <div class="field"><label>Container # (optional)</label><input id="t_container_seq" type="number" min="1" placeholder="e.g. 2"></div>
          <div class="field"><label>Fire in (minutes)</label><input id="t_delay" value="60" type="number" min="1"></div>
          <div class="field" style="grid-column:1/-1;"><label>Message</label><input id="t_message" placeholder="Auto-filled from type — edit freely"></div>
        </div>
        <div style="display:flex; align-items:center; gap:12px; margin-top:6px;">
          <button id="btnCreateTask" class="btn btn-primary">Create task</button>
          <span id="taskErr" style="font-family:var(--font-mono); font-size:11px; color:var(--status-danger);"></span>
        </div>
      </div>
      <div class="card" style="padding:20px 22px; margin-bottom:18px;">
        <div style="font-family:var(--font-mono); font-size:10px; font-weight:600; letter-spacing:.16em; text-transform:uppercase; color:var(--text-muted); margin-bottom:14px;">Pending — ${pending.length}</div>
        <div style="display:flex; flex-direction:column; gap:10px;">
          ${pending.length ? pending.map(t => `
            <div style="display:flex; justify-content:space-between; align-items:center; gap:14px; padding:12px 14px; background:var(--surface-sunken); border-left:3px solid var(--status-warning); border-radius:var(--radius-xs);">
              <div style="flex:1; min-width:0;">
                <div style="font-size:13px; font-weight:600; color:var(--text-strong);">${esc((TASK_TYPES.find(x => x.value === t.type) || {}).label || t.type || 'task')} → ${esc(t.target_name || t.target_kind || t.target_chat || '')}</div>
                <div style="font-family:var(--font-mono); font-size:11px; color:var(--text-muted); margin-top:3px;">${esc(t.bkg_no || '')}${t.container_seq ? ' #' + t.container_seq : ''} · fires ${esc(t.fire_at || '')}</div>
                <div style="font-size:12px; color:var(--text-body); margin-top:5px; font-style:italic;">"${esc(t.message || '')}"</div>
              </div>
              <button class="btn btn-danger btn-cancel-task" data-id="${esc(t.id)}" style="white-space:nowrap;">Cancel</button>
            </div>`).join('') : '<div style="font-family:var(--font-mono); font-size:12px; color:var(--text-faint); padding:14px 0; text-align:center;">No pending tasks.</div>'}
        </div>
      </div>
      <div class="card" style="padding:20px 22px;">
        <div style="font-family:var(--font-mono); font-size:10px; font-weight:600; letter-spacing:.16em; text-transform:uppercase; color:var(--text-muted); margin-bottom:12px;">History</div>
        ${history.slice(-20).reverse().map(h => `
          <div style="display:grid; grid-template-columns:110px 1fr 150px; gap:12px; padding:9px 4px; border-bottom:1px solid var(--border-subtle); align-items:center;">
            <span class="badge" style="background:var(--steel-100); color:var(--steel-700);">${esc(h.status || '')}</span>
            <span style="font-size:12px; color:var(--text-body);">${esc(h.message || '')} <span style="color:var(--text-faint);">${esc(h.result_note || '')}</span></span>
            <span style="font-family:var(--font-mono); font-size:10.5px; color:var(--text-faint); text-align:right;">${esc(h.fire_at || '')}</span>
          </div>`).join('') || '<div style="font-family:var(--font-mono); font-size:12px; color:var(--text-faint); padding:10px 0; text-align:center;">No history yet.</div>'}
      </div>
    </section>`;
  $('t_type').addEventListener('change', refreshTaskDefaultMessage);
  $('t_bkg').addEventListener('blur', refreshTaskDefaultMessage);
  refreshTaskDefaultMessage();
  $('btnCreateTask').addEventListener('click', async () => {
    $('taskErr').textContent = '';
    const type = $('t_type').value;
    const target_kind = $('t_target_kind').value;
    const target_name = $('t_target_name').value.trim();
    const bkg_no = $('t_bkg').value.trim().toUpperCase() || null;
    const container_seq = $('t_container_seq').value ? Number($('t_container_seq').value) : null;
    const message = $('t_message').value.trim();
    if (!message) { $('taskErr').textContent = 'Message is required.'; return; }
    if (target_kind !== 'manager' && !target_name) { $('taskErr').textContent = 'Name is required for a trucker/supplier target.'; return; }
    try {
      await api('/api/tasks', { method: 'POST', body: JSON.stringify({
        type, target_kind,
        target_name: target_name || null,
        target_chat: (target_kind === 'manager' && !target_name) ? 'manager' : null,
        bkg_no, container_seq,
        delay_minutes: Number($('t_delay').value) || 60,
        message, condition: buildTaskCondition(type, bkg_no, container_seq),
        created_by: 'dashboard',
      }) });
      loadTab('tasks');
    } catch (e) { $('taskErr').textContent = e.message; }
  });
  document.querySelectorAll('.btn-cancel-task').forEach(btn => btn.addEventListener('click', async () => {
    await api(`/api/tasks/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
    loadTab('tasks');
  }));
}

// ── LOADS — Add New Load wizard with camera/upload-captured gross/tare weight,
// mobile-friendly, deck-of-cards listing ────────────────────────────────────
// Card-deck listing of structured load records (date/seller/items/PDF),
// separate from the WhatsApp scale-ticket path (see helpers/loads.js vs
// helpers/scaleTickets.js on the server). Weight capture offers BOTH a live
// camera snapshot (getUserMedia — needs https://, see HTTPS_SETUP.md) and a
// plain file upload fallback (works over plain http:// too, and covers phones
// where the user would rather pick an existing photo).
// Which kind the deck is showing. Remembered, because it is a way of working
// rather than a one-off question — someone doing the week's sales should not
// re-pick it on every visit. localStorage can throw in a webview, so it is
// read defensively and a failure just means "All".
let loadKindFilter = (() => {
  try {
    const v = localStorage.getItem('loadKindFilter');
    return LOAD_KINDS.some(([k]) => k === v) ? v : 'all';
  } catch (e) { return 'all'; }
})();
// ── WHICH MONTH IS FILTERED, IF ANY (2026-10-02) ─────────────────────────
// Deliberately NOT remembered in localStorage, unlike loadKindFilter above.
// A kind ("Purchases") is how she likes to work and is worth persisting. A
// MONTH is where she happened to be looking once — restoring "September" a
// fortnight later means opening the Loads tab and seeing none of this week's
// work, with a control she has forgotten she set. The empty default is the
// safe one.
let loadMonthFilter = '';

function paintLoadKindBar(count) {
  const bar = document.getElementById('loadKindBar');
  if (!bar) return;
  bar.innerHTML = LOAD_KINDS.map(([k, label]) => {
    const on = loadKindFilter === k;
    // The COUNT rides on the active tab, for the same reason the item filter
    // shows one: a genuine zero has to be distinguishable from a filter that
    // is not looking where you think.
    const txt = on && count !== undefined ? `${label} (${count})` : label;
    return `<button type="button" class="btn ${on ? 'btn-primary' : 'btn-secondary'} load-kind-btn" data-kind="${k}"
              aria-pressed="${on}" style="font-size:12px; padding:6px 14px;">${txt}</button>`;
  }).join('');
}
let loadsCache = [];
// Unfinished loads shown above the deck. Held separately from loadsCache on
// purpose — every total, filter and export in this tab reads loadsCache, and
// a draft must not reach any of them.
let pendingDrafts = [];
// Gross/tare/net/price/unit/amount live PER ITEM now (moved off the load
// level — a load can be several items each weighed separately), so each
// entry here also carries grossPhoto/tarePhoto ({ base64, mime } | null)
// instead of there being one shared capturedPhotos object for the whole load.
let currentLoadItems = [];
// null while the modal is creating a brand-new load; set to a load's id while
// editing an existing one (see openEditLoadModal) — Save then PUTs instead of
// POSTing, and resetLoadModal() clears it back to null on close/new.
let editingLoadId = null;
let saveTicket = null;   // one-time ticket per Save — see resetLoadModal
// The load-level description input was removed from the form on 2026-08-28,
// but the FIELD still exists on records saved before that. Held here so
// editing an old load preserves its description instead of silently blanking
// it on save — removing a box from a form must not delete data it can no
// longer show.
let editingLoadDescription = '';

// ── Draft autosave — per Apsara 2026-08-28 ────────────────────────────────
// "as soon as i type 2 item details, it should get autosaved", clarified as a
// draft to come back to rather than a real load record.
//
// Deliberately LOCAL and invisible. No load number is assigned, nothing
// appears in the Loads list, nothing lands in a report, and nobody else sees
// it. A half-finished load that becomes a real record the moment a second
// item is typed would show up in the day's figures and in the yard report,
// which is a worse problem than the one this solves.
//
// Only starts once TWO item rows carry real data, which is the point at which
// enough has been typed to be worth losing.
// Drafts live on the SERVER (data/load_drafts.json, see helpers/loadDrafts.js).
//
// They were in localStorage first, which answered "don't lose my typing" but
// not what was actually asked: a draft you can come back to has to survive a
// closed tab, a flat phone, and being picked up on a different device.
// Browser storage cannot do any of that.
//
// Photos ride along. A draft that keeps the descriptions but loses the weight
// photos has lost the expensive half — re-typing a description takes seconds,
// re-weighing a truck does not.
const DRAFT_DEBOUNCE_MS = 900;
let draftTimer = null;
let currentDraftId = null;     // round-trips so autosave updates ONE record
let draftSaveInFlight = false;

// An item counts once it has a description or any weight — an untouched blank
// row must not make the form look like work in progress. Mirrors
// isWorthSaving() in helpers/loadDrafts.js; the server has the final say.
function itemHasContent(it) {
  if (!it) return false;
  return !!(String(it.description || '').trim()
    || Number(it.gross_weight) || Number(it.tare_weight) || Number(it.net_weight));
}

// Says on screen what the draft is doing. A silent autosave is
// indistinguishable from a broken one.
function setDraftStatus(state, detail) {
  const el = $('draftStatus');
  if (!el) return;
  el.className = state === 'saving' ? 'saving' : (state === 'saved' ? '' : 'idle');
  if (state === 'saved') {
    el.innerHTML = `<span class="dot"></span><span>Draft saved ${detail}</span>`;
  } else if (state === 'saving') {
    el.innerHTML = '<span class="dot"></span><span>Saving draft…</span>';
  } else if (state === 'waiting') {
    el.innerHTML = '<span>Autosaves as soon as you enter an item</span>';
  } else {
    el.innerHTML = '';
  }
}

function currentDraftPayload() {
  syncItemsFromDom();
  return {
    id: currentDraftId,
    kind: (typeof loadModalMode !== 'undefined' && loadModalMode === 'sale') ? 'sale' : 'purchase',
    date: $('ld_date') ? toIsoDate($('ld_date').value) : '',
    seller: $('ld_seller') ? $('ld_seller').value : '',
    seller_address: $('ld_seller_address') ? $('ld_seller_address').value : '',
    seller_phone: $('ld_seller_phone') ? $('ld_seller_phone').value : '',
    description: editingLoadDescription || '',
    // On the draft too — see helpers/loadDrafts.js. A recovered load that
    // comes back without its deduction is worse than one that comes back
    // empty, because it looks finished.
    trucking_company: $('ld_trucking_company') ? $('ld_trucking_company').value : '',
    trucking_amount: $('ld_trucking_amount') ? $('ld_trucking_amount').value : '',
    trucking_note: $('ld_trucking_note') ? $('ld_trucking_note').value : '',
    items: (currentLoadItems || []).filter(itemHasContent),
  };
}

async function saveLoadDraft() {
  // Drafts are only for NEW loads. An edit already has a saved record behind
  // it, and a stale draft restored over one is a way to silently revert a
  // correction someone else made.
  if (editingLoadId) { setDraftStatus('none'); return; }
  const payload = currentDraftPayload();
  if (payload.items.length < 2) { setDraftStatus('waiting'); return; }
  if (draftSaveInFlight) { queueLoadDraftSave(); return; }  // coalesce, never overlap
  draftSaveInFlight = true;
  try {
    const r = await api('/api/load-drafts', { method: 'POST', body: JSON.stringify(payload) });
    if (r && r.saved && r.id) {
      currentDraftId = r.id;
      setDraftStatus('saved', new Date(r.updated_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    } else {
      currentDraftId = null;
      setDraftStatus('waiting');
    }
  } catch (e) {
    // Never blocks the form, and never claims a save it did not get. If the
    // safety net is not there, the person relying on it needs to know.
    const el = $('draftStatus');
    if (el) { el.className = 'idle'; el.innerHTML = '<span style="color:var(--status-danger);">Draft not saved — check connection</span>'; }
  } finally {
    draftSaveInFlight = false;
  }
}

function queueLoadDraftSave() {
  if (draftTimer) clearTimeout(draftTimer);
  if (!editingLoadId) {
    // ONE item is enough — per Apsara, and matching isWorthSaving() in
    // helpers/loadDrafts.js. The two must agree or the badge says "Saving…"
    // for something the server then refuses to save, which is worse than no
    // badge at all.
    const filled = (currentLoadItems || []).filter(itemHasContent).length;
    if (filled >= 1) setDraftStatus('saving');
  }
  draftTimer = setTimeout(saveLoadDraft, DRAFT_DEBOUNCE_MS);
}

// Called after a real load is saved. DELETES the draft rather than converting
// it — a record that is both a draft and a load at the same moment is exactly
// the ambiguity the separate store exists to prevent.
async function clearLoadDraft() {
  if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }

  // ── WAIT FOR AN AUTOSAVE STILL IN THE AIR ─────────────────────────────
  // Apsara, 2026-09-30, on two identical loads a minute apart: "He just
  // saved it first.then edit ,continue or cancel.he clicked continue,then it
  // generated twice."
  //
  // currentDraftId is set only when the autosave POST RESOLVES. Press Save
  // while one is still in flight and this ran with id === null, returned
  // having deleted nothing, and the autosave then landed — leaving a draft
  // on the server for a load that had just been saved for real.
  //
  // The Loads screen offers that orphan as "Unfinished load...". Continuing
  // it calls openLoadDraft -> resetLoadModal, which sets editingLoadId to
  // null, so the form is in CREATE mode and Save writes a SECOND load. Same
  // seller, same weight, same money, sequential ids: EDGE_98 and EDGE_99.
  //
  // So the in-flight save is waited for rather than raced. BOUNDED, because
  // a draft is a convenience and must never hold up the confirmation of a
  // load that is already committed to disk.
  const startedWaiting = Date.now();
  while (draftSaveInFlight && Date.now() - startedWaiting < 3000) {
    await new Promise((r) => setTimeout(r, 50));
  }

  const id = currentDraftId;
  currentDraftId = null;
  setDraftStatus('none');
  if (!id) return;
  try { await api(`/api/load-drafts/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch (e) {}
}

// Repaints the Unfinished strip from the server.
//
// THE BUG THIS FIXES (Apsara 2026-08-29: "it is showing that autosaved but
// nowhere the draft is showing in app"): autosaving writes the draft and the
// footer correctly says so, but nothing told the Loads screen behind the
// modal. The strip was rendered when the tab loaded — before the draft
// existed — so it stayed empty until you navigated away and back. The draft
// was never lost; it was just invisible, which for a safety net is nearly as
// bad.
//
// Repaints ONLY the strip rather than reloading the whole tab: a full reload
// would refetch every load and throw away scroll position for a change that
// affects one row of the page.
async function refreshDraftStrip() {
  const el = document.getElementById('draftStrip');
  if (!el) return;
  pendingDrafts = await fetchLoadDrafts();
  el.innerHTML = draftStripHtml();
}

async function fetchLoadDrafts() {
  try { return asArray(await api('/api/load-drafts')); } catch (e) { return []; }
}

// Fills the form from a draft and ADOPTS its id, so continuing to type keeps
// updating the same record instead of spawning a second one.
function applyLoadDraft(d) {
  if (!d) return;
  currentDraftId = d.id;
  if ($('ld_date') && d.date) $('ld_date').value = toUsDate(d.date);
  if ($('ld_seller')) $('ld_seller').value = d.seller || '';
  if ($('ld_seller_address')) $('ld_seller_address').value = d.seller_address || '';
  if ($('ld_seller_phone')) $('ld_seller_phone').value = d.seller_phone || '';
  editingLoadDescription = d.description || '';
  if ($('ld_trucking_company')) $('ld_trucking_company').value = d.trucking_company || '';
  if ($('ld_trucking_amount'))  $('ld_trucking_amount').value  = d.trucking_amount != null ? d.trucking_amount : '';
  if ($('ld_trucking_note'))    $('ld_trucking_note').value    = d.trucking_note || '';
  // Opened when there is one, so a restored deduction is visible rather than
  // folded away behind a summary she has no reason to click.
  if ($('ld_trucking_details')) $('ld_trucking_details').open = !!d.trucking_amount;
  updateTruckingSummary();
  syncTruckerBillCheckbox();
  currentLoadItems = Array.isArray(d.items) && d.items.length ? d.items.slice() : [blankLoadItem()];
  renderItemRows();
  const bar = $('draftBar'); if (bar) bar.classList.add('hidden');
  setDraftStatus('saved', new Date(d.updated_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
}

// Offered on a blank form, never applied on its own — silently replacing what
// is on screen with something typed hours ago turns a safety net into a
// hazard.
async function offerLoadDraft() {
  const bar = $('draftBar');
  if (!bar) return;
  bar.classList.add('hidden');
  if (editingLoadId) return;
  const drafts = await fetchLoadDrafts();
  if (!drafts.length) return;
  const d = drafts[0];   // server returns newest first
  const mins = Math.round((Date.now() - new Date(d.updated_at).getTime()) / 60000);
  const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago`
    : new Date(d.updated_at).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
  const more = drafts.length > 1 ? ` (${drafts.length - 1} more below)` : '';
  $('draftBarText').textContent = `Unfinished load from ${ago} — ${(d.items || []).length} items${d.seller ? `, ${d.seller}` : ''}.${more}`;
  bar.dataset.draftId = d.id;
  bar.classList.remove('hidden');
}

// The strip above the Loads deck. This is what "can be edited later" means in
// practice — an unfinished load is visible from the list, not only from the
// moment you happen to open a blank form.
function draftStripHtml() {
  if (!pendingDrafts.length) return '';
  const card = (d) => {
    const items = Array.isArray(d.items) ? d.items : [];
    const names = items.map(i => String(i.description || '').trim()).filter(Boolean);
    const when = d.updated_at ? new Date(d.updated_at).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : '';
    return `
      <div class="draft-card">
        <div class="d-main">
          <div class="d-title">${esc(d.seller || 'Unnamed load')}${d.kind === 'sale' ? ' — sale' : ''}</div>
          <div class="d-sub">${items.length} item${items.length === 1 ? '' : 's'}${names.length ? ' · ' + esc(names.slice(0, 3).join(', ')) : ''} · last edited ${esc(when)}</div>
        </div>
        <button class="btn btn-resume-draft" data-id="${esc(d.id)}" style="padding:7px 14px; font-size:12px;">Continue</button>
        <button class="btn btn-drop-draft" data-id="${esc(d.id)}" style="padding:7px 12px; font-size:12px;">Delete</button>
      </div>`;
  };
  return `<div class="draft-strip">
      <div class="draft-strip-head">Unfinished — not saved as loads yet (${pendingDrafts.length})</div>
      ${pendingDrafts.map(card).join('')}
    </div>`;
}

// Reopens a draft in the load modal. Adopts its id, so finishing it updates
// the same draft and then deletes it on save rather than leaving a twin.
async function resumeDraft(id) {
  const d = pendingDrafts.find(x => x.id === id) || (await fetchLoadDrafts()).find(x => x.id === id);
  if (!d) return;
  resetLoadModal(d.kind === 'sale' ? 'sale' : 'purchase');
  $('loadModal').classList.remove('hidden');
  applyLoadDraft(d);
}

async function restoreLoadDraft() {
  const bar = $('draftBar');
  const id = bar && bar.dataset.draftId;
  const drafts = await fetchLoadDrafts();
  applyLoadDraft(drafts.find((x) => x.id === id) || drafts[0]);
}

// Discards from the bar: removes the RECORD, not just the notice.
async function discardOfferedDraft() {
  const bar = $('draftBar');
  const id = bar && bar.dataset.draftId;
  if (bar) bar.classList.add('hidden');
  if (!id) return;
  try { await api(`/api/load-drafts/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch (e) {}
  if (currentDraftId === id) { currentDraftId = null; setDraftStatus('waiting'); }
}

// No-op kept so loadTab()'s unconditional cleanup call has something to call —
// the getUserMedia camera overlay was removed (see the "Add photo" button's
// comment in renderLoads: a plain file input already gives mobile users a
// native camera-or-library choice with no HTTPS requirement, so the custom
// in-page camera stream is no longer needed).
function stopCamera() {}

// ITEM_DESC_OPTIONS_BASE and ITEM_DESC_OTHER used to live here: eleven
// hardcoded descriptions plus an "Others…" sentinel. Both are gone as of
// 2026-08-20 (Apsara: "keep the list in backend"). The eleven were moved
// into helpers/itemTypes.js as one-time seed data and are now ordinary,
// editable catalog entries; "Others" is unnecessary because the field is
// free text. Keeping a duplicate of the list in each client was also how
// the phone and the dashboard drifted apart.

// Custom descriptions typed via "Others…" on a PREVIOUS load — per Apsara
// 2026-08-15 ("when something gets added in others, it should get added to
// existing list of description"). Fetched fresh each time the load modal
// opens (see resetLoadModal/openEditLoadModal) and appended after the base
// list, so a description typed once via "Others…" shows up as a normal
// selectable option on every load after that, not just this session's.
let customItemTypes = [];
// ── a failed refresh must NOT empty the catalogue ─────────────────────────
// Bose, 2026-09-02: "sometimes newly added items not coming."
//
// THE BUG. This used to be `catch { customItemTypes = []; }`. One failed GET
// — a dropped connection, the server restarting mid-deploy — and the
// description catalogue was WIPED for that whole modal session. Silently: no
// error, no retry, just an empty type-ahead where a full one had been a
// minute earlier.
//
// The old comment here claimed the dropdown "falls back to the base list". It
// does not. itemDescOptions() returns customItemTypes.slice() and nothing
// else — the base presets were folded into the server list on 2026-08-20, so
// emptying this array empties the dropdown outright. The comment described
// behaviour that had stopped existing.
//
// NOW: keep whatever was last loaded. A stale list can only cost a suggestion
// that is slightly out of date — descriptions are free text, so nothing is
// blocked by an entry being missing or lingering. An EMPTY list costs the
// whole catalogue, which is the actual complaint.
// Mirrors mobile-app/www/index.html.
let itemTypesStale = false;

// Descriptions added HERE that the server has not confirmed back yet.
//
// Second half of Bose's report, 2026-09-02: saving a load POSTs any new
// description fire-and-forget, and the very next thing that happens is the
// modal closing and reopening, which calls refreshCustomItemTypes(). That GET
// routinely wins the race against the POST, comes back WITHOUT the new
// description, and — because the refresh REPLACES the array — deletes the
// local copy that was added a moment earlier. The description then vanishes
// until some later refresh happens to run after the write landed.
//
// Held here and merged back in after every refresh, so a description survives
// however long the server takes. An entry leaves this set the moment the
// server's own list contains it, so it cannot mask a description that was
// genuinely deleted in Settings.
const pendingItemTypes = new Set();

function rememberNewItemType(d) {
  const v = String(d || '').trim();
  if (!v) return;
  if (!customItemTypes.some(x => String(x).toLowerCase() === v.toLowerCase())) customItemTypes.push(v);
  pendingItemTypes.add(v);
}

async function refreshCustomItemTypes() {
  try {
    const next = await api('/api/item-types');
    // Only replace on a well-formed answer. A 200 carrying something that is
    // not an array (a proxy's HTML error page, say) must not become the
    // catalogue either.
    if (Array.isArray(next)) {
      customItemTypes = next;
      itemTypesStale = false;
      // Re-apply anything still in flight. Confirmed entries are dropped from
      // the pending set rather than merged forever — otherwise deleting a
      // description in Settings would never take effect on this client.
      for (const d of Array.from(pendingItemTypes)) {
        if (customItemTypes.some(x => String(x).toLowerCase() === d.toLowerCase())) pendingItemTypes.delete(d);
        else customItemTypes.push(d);
      }
    }
    else { itemTypesStale = true; }
  } catch (err) {
    itemTypesStale = true;
    console.warn('[items] could not refresh the description list — keeping the last known ' + customItemTypes.length + ' entries:', err && err.message);
  }
}
// What renderItemRows actually renders — base list plus any custom ones not
// already on it (case-insensitive), so a custom entry that happens to match
// a base option in different casing doesn't show up twice.
// Sorted A-Z, per Apsara 2026-08-19 ("rearrange the description list based
// on asc") — mirrors mobile-app/www/index.html's identical change; see its
// comment for why localeCompare with sensitivity:'base' is used and why
// "Others…" is deliberately not part of this sort.
// Most recent price used for an item description, per Apsara 2026-08-19
// ("based on last invoice generated, when i add new load, price should get
// updated as soon as i add that description").
//
// Read straight from loadsCache — the deck already fetched every load, and
// helpers/loads.js unshifts new loads onto the front, so the array is
// newest-first and the FIRST match is by definition the most recent
// invoice that used this description. No API call, so the price appears
// the instant the description is picked.
//
// Matching is case/whitespace-insensitive for the same reason
// groupItemsByDescription normalises: "Battery" and "battery " are the
// same item type to a yard, and a price typed against one should apply to
// the other.
// Returns { price, unit } now, not a bare price — see the comment on
// applyPriceIfChanged below for why the unit has to travel with it.
function lastPriceForDescription(desc) {
  const key = String(desc || '').trim().toLowerCase();
  if (!key) return null;
  for (const load of (loadsCache || [])) {
    for (const it of (load.items || [])) {
      if (String(it.description || '').trim().toLowerCase() === key
          && it.price != null && it.price !== '') {
        return { price: it.price, unit: String(it.unit || '').trim().toLowerCase() === 'mt' ? 'mt' : 'lb' };
      }
    }
  }
  return null;
}

// The catalog, verbatim from the server. As of 2026-08-20 there is no
// client-side base list to merge in and no sorting to do here — GET
// /api/item-types already returns the whole list sorted A-Z (see
// helpers/itemTypes.js). Kept as a function rather than reading
// customItemTypes directly at each call site so there's still one place to
// change if the list ever needs filtering again.
function itemDescOptions() {
  return customItemTypes.slice();
}

// ── what the type-ahead OFFERS, which is more than the saved catalogue ────
// Bose, via Apsara, 2026-09-02: "new item stored -> immediately if we try
// adding in next line, it is not displaying."
//
// A description typed on row 1 was not offered on row 2. It could not be:
// itemDescOptions() is the SAVED catalogue, and a new description is only
// registered with the server when the whole load is saved. So for the entire
// time the form is open — which is when someone is most likely to be entering
// three lines of the same material — the thing they just typed was invisible
// to every other row.
//
// This unions the catalogue with whatever is currently typed in the form.
// Nothing is persisted by it; it only affects what the dropdown shows.
//
// SEPARATE FUNCTION, deliberately. itemDescOptions() is ALSO what the save
// handler diffs against to work out which descriptions are new and need
// POSTing (see knownDescs). Folding the in-form values into that would make
// every new description look already-known, and it would never be sent to the
// server at all — trading a display bug for a silent data-loss one.
function itemDescSuggestions() {
  const seen = new Set();
  const out = [];
  const add = (d) => {
    const v = String(d || '').trim();
    if (!v) return;
    const k = v.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k); out.push(v);
  };
  itemDescOptions().forEach(add);
  // Read from the DOM rather than currentLoadItems: the inputs are the live
  // truth while someone is typing and the model only catches up on the next
  // syncItemsFromDom(), which is one keystroke behind. Same reasoning as
  // updateItemTotals.
  document.querySelectorAll('#ld_items .ld-item-desc-input').forEach((el) => add(el.value));
  return out;
}

// Live-recomputes ONE row's net weight (gross - tare) and amount (net *
// price) directly from that row's own inputs — called on every input event
// inside the row, and after a photo read fills gross/tare. Reads/writes DOM
// directly rather than going through currentLoadItems so it stays fast and
// doesn't fight the user's cursor position while typing; syncItemsFromDom()
// (called right after, on the same input event) is what actually persists
// the values into currentLoadItems.
// ── MODULE SCOPE, NOT INSIDE recomputeRowTotals ────────────────────────
// It was first placed inside that function, which made LB_PER_UNIT a
// block-scoped const — so renderItemRows() threw ReferenceError on
// unitOf and the Loads form opened with ZERO item rows. The page's JS
// still parsed and tests/price-units.js still matched the table in the
// source, because neither of those boots the DOM. tests/item-row-net.js
// does, and that is what caught it.
// ── WHAT A PRICE IS PER ─────────────────────────────────────────────────
// Apsara, 2026-10-10, asked for /piece, net ton and gross ton in the EDGE
// YARD APP — and, asked whether this screen should offer them too, chose
// display-only: the picker here stays /lb and /MT.
//
// COMPUTING them is not optional, though, and that distinction is the whole
// reason this table is here. helpers/loads.js recomputes every row on save
// and wins. A website that could not READ 'nt' would show the pound figure
// for a row the app priced per net ton, she would press Save, and the amount
// would jump by a factor of 2,000 after the fact — which is the same class
// of thing as the $15m display bug, just arriving a moment later.
//
// THE SAME NUMBERS AS helpers/priceUnits.js, and tests/price-units.js reads
// this table out of the HTML and compares it, because the comment this
// replaced said "Same constant, deliberately" and that is a promise, not a
// check.
