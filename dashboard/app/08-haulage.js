// dashboard/app/08-haulage.js — split from dashboard/index.html's <script> (helpers/sourceParts.js reconstructs the original)
let genState = null;
async function openGenerateInvoice(row) {
  const L = LEDGER_LIGHT;
  genState = { row, step: 1, mode: 'normal', gen: null, draft: null, recipients: '',
               subject: null, body: null, busy: false,
               // The grouping question, when the server asks it. `candidates`
               // is what it found; `include` is what she has ticked, and it
               // rides along to /invoice/send too so the weight check there
               // weighs the rows that are actually on the PDF.
               candidates: null, include: null };
  document.body.insertAdjacentHTML('beforeend', `
    <div id="genModal" style="position:fixed; inset:0; background:rgba(0,0,0,.66); z-index:9100; display:flex; align-items:flex-start; justify-content:center; overflow-y:auto; padding:32px 16px;">
      <div class="card" id="genCard" style="width:min(820px,100%); padding:20px 22px 18px; background:${L.sunken}; border-color:${L.line};"></div>
    </div>`);
  const close = () => { const m = $('genModal'); if (m) m.remove(); document.removeEventListener('keydown', onEsc); genState = null; };
  const onEsc = (e) => { if (e.key === 'Escape' && !(genState && genState.busy)) close(); };
  document.addEventListener('keydown', onEsc);
  ledgerReopen = () => { close(); };

  const money = (n) => (n === null || n === undefined) ? '—'
    : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const head = (title, sub) => `
    <div style="display:flex; align-items:baseline; justify-content:space-between; margin-bottom:4px;">
      <h3 style="margin:0; font-size:16px; text-transform:none; color:${L.ink};">${title}</h3>
      <button id="genClose" aria-label="Close" style="background:none; border:none; color:${L.inkMuted}; font-size:22px; line-height:1; cursor:pointer;">&times;</button>
    </div>
    <div style="font-size:12px; color:${L.inkFaint}; margin-bottom:14px;">${sub}</div>`;

  // Warnings sit ABOVE the button, never below it — the rule the WhatsApp
  // confirmation already follows. A caution under the thing you press is a
  // caution you read afterwards.
  const warnBlock = (list, tone) => (list && list.length) ? `
    <div style="background:${tone === 'bad' ? 'rgba(220,80,60,.09)' : 'rgba(200,140,40,.10)'}; border:1px solid ${tone === 'bad' ? L.danger : L.warn}; border-radius:var(--radius-sm); padding:10px 12px; margin-bottom:12px;">
      ${list.map((w) => `<div style="font-size:12px; color:${tone === 'bad' ? L.danger : L.ink}; margin:2px 0;">${esc(w)}</div>`).join('')}
    </div>` : '';

  function render() {
    const card = $('genCard');
    if (!card) return;
    const r = genState.row;
    const label = `${esc(r.container_no || '—')}${r.invoice_no ? ' · ' + esc(r.invoice_no) : ''}${r.customer ? ' · ' + esc(r.customer) : ''}`;

    // ── STEP 1: THE ONE QUESTION SHE ASKED TO BE ASKED ──────────────────
    if (genState.step === 1) {
      const opt = (id, title, sub) => `
        <label style="display:flex; gap:10px; align-items:flex-start; padding:11px 12px; border:1px solid ${genState.mode === id ? L.accent : L.line}; border-radius:var(--radius-sm); background:${L.paper}; cursor:pointer; margin-bottom:8px;">
          <input type="radio" name="genMode" value="${id}" ${genState.mode === id ? 'checked' : ''} style="margin-top:2px;">
          <span><span style="font-size:13px; color:${L.ink};">${title}</span>
          <span style="display:block; font-size:11px; color:${L.inkFaint}; margin-top:2px;">${sub}</span></span>
        </label>`;
      card.innerHTML = head('Generate', label) + `
        ${opt('normal', 'Normal', 'One PDF — the invoice with its packing list behind it.')}
        ${opt('separate', 'Separate invoice and packing list', 'Two PDFs, filed and attached as a pair.')}
        ${opt('invoice_only', 'Invoice only', 'No packing list at all, in the file or in the email.')}
        <div id="genErr" style="color:${L.danger}; font-size:12px; margin:8px 0 0;"></div>
        <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:14px;">
          <button id="genCancel" class="btn btn-ghost" style="font-size:12px; padding:7px 14px;">Cancel</button>
          <button id="genGo" class="btn btn-primary" style="font-size:12px; padding:7px 16px;">Generate</button>
        </div>`;
      card.querySelectorAll('input[name=genMode]').forEach((el) => {
        el.onchange = () => { genState.mode = el.value; render(); };
      });
      $('genCancel').onclick = close;
      $('genGo').onclick = doGenerate;
    }

    // ── STEP 'group': WHICH ROWS BELONG ON IT ───────────────────────────
    //
    // Only ever reached when the server says so (409 GROUPING_UNCERTAIN), and
    // it only says so when a booking is all that holds the rows together. A
    // container-backed invoice never sees this screen — Apsara, 2026-09-21,
    // choosing between three shapes: ask where there is no container, leave
    // the container merge she asked for on 19-Sep alone.
    //
    // WHAT IS PRE-TICKED IS MY CALL, NOT HERS: the clicked row always, plus
    // any row on the SAME DATE carrying the SAME non-blank invoice number.
    // That is the S2131 case — three grades, one day, one invoice number, one
    // delivery. Rows on another date start unticked, because that is the
    // UMXU637049 case: the same trailer, out again eight days later. Ticking
    // everything by default would nudge toward the merge that is wrong.
    if (genState.step === 'group') {
      const cands = genState.candidates || [];
      const chosen = genState.include || [];
      const row = (c) => {
        const mine = String(c.id) === String(r.id);
        const on = mine || chosen.includes(String(c.id));
        return `
        <label style="display:flex; gap:10px; align-items:center; padding:9px 12px; border:1px solid ${on ? L.accent : L.line}; border-radius:var(--radius-sm); background:${L.paper}; cursor:${mine ? 'default' : 'pointer'}; margin-bottom:6px;">
          <input type="checkbox" class="genPick" value="${esc(String(c.id))}" ${on ? 'checked' : ''} ${mine ? 'disabled' : ''}>
          <span style="flex:1; display:flex; gap:14px; align-items:baseline; font-size:12px; color:${L.ink};">
            <span style="min-width:88px; color:${L.inkMuted};">${esc(c.date || '—')}</span>
            <span style="flex:1;">${esc(c.item || '—')}</span>
            <span style="color:${L.inkMuted};">${c.weight === null ? '—' : esc(String(c.weight)) + ' ' + esc(c.weight_unit || '')}</span>
            <span style="min-width:96px; text-align:right;">${money(c.amount)}</span>
          </span>
          ${mine ? `<span style="font-size:10px; color:${L.inkFaint}; text-transform:uppercase; letter-spacing:.06em;">this row</span>` : ''}
        </label>`;
      };
      const n = 1 + chosen.filter((id) => String(id) !== String(r.id)).length;
      card.innerHTML = head('Which rows belong on this invoice?', label) + `
        ${warnBlock([genState.groupWhy || ''].filter(Boolean), 'warn')}
        ${cands.map(row).join('')}
        <div id="genErr" style="color:${L.danger}; font-size:12px; margin:8px 0 0;"></div>
        <div style="display:flex; justify-content:space-between; gap:8px; margin-top:14px;">
          <button id="genBackG" class="btn btn-ghost" style="font-size:12px; padding:7px 14px;">Back</button>
          <button id="genGoG" class="btn btn-primary" style="font-size:12px; padding:7px 16px;">Generate with ${n} row${n === 1 ? '' : 's'}</button>
        </div>`;
      card.querySelectorAll('.genPick').forEach((el) => {
        el.onchange = () => {
          const id = el.value;
          const keep = (genState.include || []).filter((x) => String(x) !== String(id));
          genState.include = el.checked ? keep.concat([id]) : keep;
          render();
        };
      });
      $('genBackG').onclick = () => { genState.step = 1; render(); };
      $('genGoG').onclick = doGenerate;
    }

    // ── STEP 2: THE DOCUMENT ITSELF ─────────────────────────────────────
    if (genState.step === 2) {
      const g = genState.gen;
      const files = g.saved_filenames || [g.saved_filename];
      // The INVOICE half is what is shown when there are two — it is the
      // document with the money on it, the same choice the preview on the
      // Documents screen makes.
      const first = files[0];
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      const src = `/api/documents/download?kind=invoice&file=${encodeURIComponent(first)}`
                + `&date=${today}&container=${encodeURIComponent(g.container_no || '')}#toolbar=0`;
      const rows = (g.line_items || []).map((it) => `
        <tr>
          <td style="padding:5px 8px; font-size:12px; color:${L.ink};">${esc(it.item_desc || '')}</td>
          <td style="padding:5px 8px; font-size:12px; color:${L.ink}; text-align:right; font-family:var(--font-mono);">${Number(it.weight || 0).toFixed(3)} MT</td>
          <td style="padding:5px 8px; font-size:12px; color:${L.ink}; text-align:right; font-family:var(--font-mono);">${money(it.rate)} /MT</td>
          <td style="padding:5px 8px; font-size:12px; color:${L.ink}; text-align:right; font-family:var(--font-mono);">${money(it.amount)}</td>
        </tr>`).join('');
      card.innerHTML = head('Check it before it goes', label) + `
        ${warnBlock(g.weight_message ? [g.weight_message] : [], 'bad')}
        ${warnBlock(g.warnings || [], 'warn')}
        <table style="width:100%; border-collapse:collapse; background:${L.paper}; border:1px solid ${L.line}; border-radius:var(--radius-sm); margin-bottom:10px;">
          <thead><tr style="border-bottom:1px solid ${L.line};">
            <th style="padding:5px 8px; font-size:10px; text-transform:uppercase; letter-spacing:.1em; color:${L.inkMuted}; text-align:left;">Description</th>
            <th style="padding:5px 8px; font-size:10px; text-transform:uppercase; letter-spacing:.1em; color:${L.inkMuted}; text-align:right;">Quantity</th>
            <th style="padding:5px 8px; font-size:10px; text-transform:uppercase; letter-spacing:.1em; color:${L.inkMuted}; text-align:right;">Rate</th>
            <th style="padding:5px 8px; font-size:10px; text-transform:uppercase; letter-spacing:.1em; color:${L.inkMuted}; text-align:right;">Amount</th>
          </tr></thead><tbody>${rows}</tbody></table>
        <div style="font-size:11px; color:${L.inkFaint}; margin-bottom:6px;">Saved: ${files.map((f) => esc(f)).join(' · ')}</div>
        <iframe src="${src}" style="width:100%; height:440px; border:1px solid ${L.line}; border-radius:var(--radius-sm); background:#fff;"></iframe>
        <div id="genErr" style="color:${L.danger}; font-size:12px; margin:8px 0 0;"></div>
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-top:14px;">
          <button id="genBack" class="btn btn-ghost" style="font-size:12px; padding:7px 14px;">Generate again</button>
          <div style="display:flex; gap:8px;">
            <button id="genDone" class="btn btn-ghost" style="font-size:12px; padding:7px 14px;">Done — don't email</button>
            <button id="genNext" class="btn btn-primary" style="font-size:12px; padding:7px 16px;">Next: the email</button>
          </div>
        </div>`;
      $('genBack').onclick = () => { genState.step = 1; render(); };
      $('genDone').onclick = () => { close(); renderLedgerTab('sales'); };
      $('genNext').onclick = doDraft;
    }

    // ── STEP 3: THE EMAIL, EXACTLY AS IT WILL BE SENT ───────────────────
    if (genState.step === 3) {
      const d = genState.draft;
      if (!d.ok) {
        // ── NO ADDRESS ON FILE: ASK, DON'T STOP ─────────────────────────
        // Apsara, 2026-09-19, reading "Edge Metals Recycling isn't in Email
        // Contacts, so I don't have an address for them. Add them there and
        // say ... again":
        //
        //   "if its in email contacts,it can take ..else it can ask for email
        //    recipients separated by comma ... then it should get stored in
        //    email contacts tab"
        //
        // Being sent to another tab, told to come back and start over, is the
        // worst possible answer to a question the screen could simply ask.
        // The typed list goes back through the SAME draft route, so the next
        // thing she sees is the real message with the real addresses on it —
        // typing them is not a shortcut past the read-before-send step.
        if (d.ask_recipients) {
          card.innerHTML = head('Who should this go to?', label) + `
            <div style="font-size:12px; color:${L.inkFaint}; margin-bottom:10px;">${esc(d.consignee || 'This customer')} isn't in Email Contacts yet. Type the addresses and I'll use them now and save them there for next time.</div>
            <input id="genRecipients" type="text" placeholder="someone@example.com, someone.else@example.com"
              style="width:100%; padding:9px 11px; font-size:13px; font-family:var(--font-mono); background:${L.paper}; color:${L.ink}; border:1px solid ${L.line}; border-radius:var(--radius-sm);">
            <div style="font-size:11px; color:${L.inkFaint}; margin-top:6px;">Separate them with commas. The first one is the addressee; the rest are copied.</div>
            <div id="genErr" style="color:${L.danger}; font-size:12px; margin:8px 0 0;"></div>
            <div style="display:flex; justify-content:space-between; gap:8px; margin-top:14px;">
              <button id="genBack3" class="btn btn-ghost" style="font-size:12px; padding:7px 14px;">Back to the invoice</button>
              <div style="display:flex; gap:8px;">
                <button id="genDone3" class="btn btn-ghost" style="font-size:12px; padding:7px 14px;">Don't send</button>
                <button id="genUseTo" class="btn btn-primary" style="font-size:12px; padding:7px 16px;">Use these</button>
              </div>
            </div>`;
          $('genBack3').onclick = () => { genState.step = 2; render(); };
          $('genDone3').onclick = () => { close(); renderLedgerTab('sales'); };
          $('genUseTo').onclick = doDraft;
          const box = $('genRecipients');
          if (box) { box.focus(); box.onkeydown = (ev) => { if (ev.key === 'Enter') doDraft(); }; }
          return;
        }
        card.innerHTML = head('Nothing sent', label) + `
          ${warnBlock([d.message], 'bad')}
          <div style="font-size:12px; color:${L.inkFaint};">The documents are generated and filed — only the email stopped. Fix the above and press Generate again, or send it from Jarvis once the contact exists.</div>
          <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:14px;">
            <button id="genDone2" class="btn btn-primary" style="font-size:12px; padding:7px 16px;">Close</button>
          </div>`;
        $('genDone2').onclick = () => { close(); renderLedgerTab('sales'); };
        return;
      }
      const g = genState.gen || {};
      const line = (k, v) => `<div style="display:flex; gap:8px; padding:4px 0;">
          <span style="width:76px; font-size:10px; text-transform:uppercase; letter-spacing:.1em; color:${L.inkMuted};">${k}</span>
          <span style="flex:1; font-size:12px; color:${L.ink}; word-break:break-word;">${esc(v)}</span></div>`;
      // ── EDITABLE, BECAUSE A DRAFT IS A STARTING POINT ─────────────
      // Apsara, 2026-09-19: "also make the email editable."
      //
      // Subject and body are real inputs, seeded with the generated text and
      // posted back as they stand. To/Cc/Attached stay read-only: those are
      // decided by the address book and by what is on disk, and a typed
      // address that silently disagrees with the contact record is the bug
      // the recipients box already handles properly.
      //
      // genState.subject / genState.body hold her edits, so stepping back to
      // the invoice and forward again does not throw them away.
      const subj = genState.subject !== undefined && genState.subject !== null
        ? genState.subject : d.subject;
      const bodyText = genState.body !== undefined && genState.body !== null
        ? genState.body : d.body;
      card.innerHTML = head('Send this?', label) + `
        ${warnBlock(g.weight_message ? [g.weight_message] : [], 'bad')}
        ${warnBlock(d.warnings || [], 'warn')}
        <div style="background:${L.paper}; border:1px solid ${L.line}; border-radius:var(--radius-sm); padding:10px 12px;">
          ${line('To', `${d.name} <${d.to}>`)}
          ${(d.contact_cc && d.contact_cc.length) ? line('Cc', [].concat(d.contact_cc).join(', ')) : ''}
          ${line('Attached', (d.attachments || []).join(', ') || 'nothing')}
          <div style="display:flex; gap:8px; padding:4px 0; align-items:center;">
            <span style="width:76px; font-size:10px; text-transform:uppercase; letter-spacing:.1em; color:${L.inkMuted};">Subject</span>
            <input id="genSubject" type="text" value="${esc(subj)}"
              style="flex:1; padding:6px 9px; font-size:12px; background:${L.sunken}; color:${L.ink}; border:1px solid ${L.line}; border-radius:var(--radius-sm);">
          </div>
          <div style="border-top:1px solid ${L.lineSoft}; margin-top:8px; padding-top:8px;">
            <textarea id="genBody" rows="11" spellcheck="true"
              style="width:100%; resize:vertical; padding:8px 10px; font-family:inherit; font-size:12px; line-height:1.55; background:${L.sunken}; color:${L.ink}; border:1px solid ${L.line}; border-radius:var(--radius-sm);">${esc(bodyText)}</textarea>
            <div style="font-size:11px; color:${L.inkFaint}; margin-top:4px;">Edit anything here — what is in these boxes is what gets sent.</div>
          </div>
        </div>
        ${(d.photos || []).length ? `<div style="font-size:11px; color:${L.inkFaint}; margin-top:8px;">${d.photos.length} loading photo${d.photos.length === 1 ? '' : 's'} go as links in the message, not as attachments.</div>` : `<div style="font-size:11px; color:${L.warn}; margin-top:8px;">No loading photos on the matching bill — paste the links onto the bill's Photos field and generate again if you want them included.</div>`}
        <div id="genErr" style="color:${L.danger}; font-size:12px; margin:8px 0 0;"></div>
        <div style="display:flex; justify-content:space-between; gap:8px; margin-top:14px;">
          <button id="genBack3" class="btn btn-ghost" style="font-size:12px; padding:7px 14px;">Back to the invoice</button>
          <div style="display:flex; gap:8px;">
            <button id="genDone3" class="btn btn-ghost" style="font-size:12px; padding:7px 14px;">Don't send</button>
            <button id="genSend" class="btn btn-primary" style="font-size:12px; padding:7px 16px;">Send to ${esc(d.name)}</button>
          </div>
        </div>`;
      const keep = () => {
        const sEl = $('genSubject'), bEl = $('genBody');
        if (sEl) genState.subject = sEl.value;
        if (bEl) genState.body = bEl.value;
      };
      $('genBack3').onclick = () => { keep(); genState.step = 2; render(); };
      $('genDone3').onclick = () => { close(); renderLedgerTab('sales'); };
      $('genSend').onclick = () => { keep(); doSend(); };
    }

    // ── STEP 4: IT WENT ─────────────────────────────────────────────────
    if (genState.step === 4) {
      const s = genState.sent;
      card.innerHTML = head('Sent', label) + `
        <div style="background:${L.paper}; border:1px solid ${L.line}; border-radius:var(--radius-sm); padding:12px;">
          <div style="font-size:13px; color:${L.ok};">Emailed to ${esc(s.to)}</div>
          <div style="font-size:12px; color:${L.inkFaint}; margin-top:6px;">${esc(s.subject)}</div>
          <div style="font-size:11px; color:${L.inkFaint}; margin-top:4px;">${(s.attached || []).map(esc).join(' · ')}</div>
          ${s.saved_contact ? `<div style="font-size:11px; color:${L.ok}; margin-top:8px;">${esc(s.saved_contact)} is now in Email Contacts \u2014 next time it will fill itself in.</div>` : ''}
        </div>
        <div style="display:flex; justify-content:flex-end; margin-top:14px;">
          <button id="genDone4" class="btn btn-primary" style="font-size:12px; padding:7px 16px;">Close</button>
        </div>`;
      $('genDone4').onclick = () => { close(); renderLedgerTab('sales'); };
    }

    const x = $('genClose'); if (x) x.onclick = close;
  }

  // ── The three calls ───────────────────────────────────────────────────
  // Every one of them disables its own button first. A double-press on Send
  // is two emails to a customer, and "I only clicked it once" is not a thing
  // anyone can prove afterwards.
  function busy(btnId, on, label) {
    genState.busy = on;
    const b = $(btnId);
    if (b) { b.disabled = on; if (on) { b.dataset.was = b.textContent; b.textContent = label; }
             else if (b.dataset.was) b.textContent = b.dataset.was; }
  }
  const fail = (e) => {
    const el = $('genErr');
    if (el) el.textContent = e && e.message ? e.message : 'That did not work';
  };

  async function doGenerate() {
    const btn = genState.step === 'group' ? 'genGoG' : 'genGo';
    busy(btn, true, 'Generating…');
    try {
      const body = { separate: genState.mode === 'separate', invoice_only: genState.mode === 'invoice_only' };
      // Sent only once she has answered. Absent on the first press, which is
      // what makes the server ask rather than assume.
      if (genState.include) {
        body.include_sale_ids = [String(genState.row.id)]
          .concat(genState.include.filter((id) => String(id) !== String(genState.row.id)));
      }
      genState.gen = await api(`/api/sales/${encodeURIComponent(genState.row.id)}/invoice/generate`,
                               { method: 'POST', body: JSON.stringify(body) });
      genState.step = 2;
      render();
    } catch (e) {
      busy(btn, false);
      // 422 comes back with the list of what the sale is still missing,
      // which is the answer to "why won't it" rather than a shrug.
      if (e.code === 'SALE_INCOMPLETE' && Array.isArray(e.missing)) {
        fail({ message: `This sale still needs: ${e.missing.join(', ')}. Edit the row, then generate.` });
        return;
      }
      // 409: several rows share this booking and there is no container to say
      // whether they are one delivery. Nothing was rendered — see the route.
      if (e.code === 'GROUPING_UNCERTAIN' && Array.isArray(e.candidates)) {
        // Every candidate already shares this row's invoice number — that is
        // one of the four things siblingRows matched on. So the only thing
        // left to tell one delivery from two is the DATE, and a shared
        // invoice number is only evidence at all when it is not blank.
        const same = (c) => String(c.id) !== String(genState.row.id)
          && String(c.date || '') === String(genState.row.date || '')
          && String(genState.row.invoice_no || '').trim() !== '';
        genState.candidates = e.candidates;
        genState.groupWhy = e.message || e.error || null;
        genState.include = [String(genState.row.id)]
          .concat(e.candidates.filter(same).map((c) => String(c.id)));
        genState.step = 'group';
        render();
        return;
      }
      fail(e);
    }
  }

  async function doDraft() {
    // Whatever she typed into the recipients box, if that box is showing.
    // Kept on genState rather than read at send time, so the addresses that
    // produced the draft she READ are the addresses that go.
    const box = $('genRecipients');
    if (box) genState.recipients = box.value.trim();
    const btn = $('genUseTo') ? 'genUseTo' : 'genNext';
    busy(btn, true, 'Reading…');
    try {
      const qs = genState.recipients ? `?recipients=${encodeURIComponent(genState.recipients)}` : '';
      genState.draft = await api(`/api/sales/${encodeURIComponent(genState.row.id)}/invoice/draft-mail${qs}`);
      genState.step = 3;
      render();
    } catch (e) { busy(btn, false); fail(e); }
  }

  async function doSend() {
    busy('genSend', true, 'Sending…');
    try {
      genState.sent = await api(`/api/sales/${encodeURIComponent(genState.row.id)}/invoice/send`,
                                { method: 'POST', body: JSON.stringify(
                                    { confirm: true, recipients: genState.recipients || undefined,
                                      subject: genState.subject, body: genState.body,
                                      // The rows she ticked at the generate step. Without
                                      // them the weight guard here rebuilds a one-line
                                      // invoice and checks it against a PDF with three.
                                      include_sale_ids: genState.include || undefined }) });
      genState.step = 4;
      render();
    } catch (e) {
      busy('genSend', false);
      // ── THE WEIGHT QUESTION, ASKED HERE AND ONLY HERE ─────────────
      // Her call on 2026-09-19: "weights_ok it should generate and then ask
      // for my conf to mail". The server refuses the SEND, not the generate,
      // and this is where she answers it — with the rows in full, above the
      // question, because a confirm that only says "the weights look wrong"
      // is one she has to dismiss in order to go and look.
      if (e.code === 'WEIGHT_MISMATCH') {
        const lines = (e.problems || []).map((p) =>
          `  Row ${p.row}${p.item ? ' (' + p.item + ')' : ''}: ${p.why}`).join('\n');
        if (!confirm(`${e.message}\n\n${lines}\n\nSend it anyway?`)) return;
        try {
          busy('genSend', true, 'Sending…');
          genState.sent = await api(`/api/sales/${encodeURIComponent(genState.row.id)}/invoice/send`,
                                    { method: 'POST', body: JSON.stringify(
                                        { confirm: true, weights_ok: true,
                                          recipients: genState.recipients || undefined,
                                          subject: genState.subject, body: genState.body }) });
          genState.step = 4;
          render();
        } catch (e2) { busy('genSend', false); fail(e2); }
        return;
      }
      fail(e);
    }
  }

  render();
}

// ── EDGE METALS HAULAGE ──────────────────────────────────────────────────
// Apsara, 2026-09-10: "put all the relevant details from bill to this..give
// an option to pay.Also give an option to filter by date,month,trucking
// company,status (paid/unpaid)".
//
// Every row is DERIVED from a bill — change the trucking amount there and
// this follows. Nothing is copied, so nothing can go stale.
//
// The filters go to the SERVER, like the bills and sales tables, so the cards
// at the top always describe the rows underneath. A summary computed over
// everything while the table shows a subset is what makes a filter something
// she stops trusting.
let truckingFilters = {};

// ── WHAT HAS GONE OUT TO SUPPLIERS ───────────────────────────────────────
// Apsara, 2026-09-29: "in bill,i need to have a tab to show advance/payment
// send to suppliers .I dont want outgoing tab in bills".
//
// Bills answers "what do I owe". This answers "what have I sent" — every
// payment and every advance against Edge Metals suppliers, newest first.
// Until now that lived only inside the pay modal's "Already recorded" list,
// one supplier at a time, and only while she was in the act of paying
// somebody. There was nowhere to simply look.
//
// ── AN ADVANCE IS NOT A PAYMENT, AND THE DIFFERENCE IS MONEY ──────────────
// helpers/billPayments.js: an advance is a payment whose allocations do not
// yet add up to it, and the remainder is credit sitting with that supplier.
// Both left the bank on the day they were made — so "sent" is the honest
// total for both — but only the allocated part is attached to a container.
// The two are shown in one list with the unapplied remainder called out,
// because a screen that showed only payments would under-report what has
// actually left the account.
//
// READ ONLY. Recording and applying stay in the pay sheet, which has the
// guards. A second way to move money would be a second place for them to be
// forgotten.
let supplierPayFilter = { supplier: '', kind: '' };

async function renderSupplierPaymentsTab() {
  metalsTab.bills = 'payments';
  const data = await api('/api/bill-payments');
  const all = (data.payments || []).slice();

  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const allocatedOf = (p) => round2((p.allocations || [])
    .reduce((t, a) => t + (Number(a.amount) || 0), 0));

  const rows = all.map((p) => {
    const amount = Number(p.amount) || 0;
    const used = allocatedOf(p);
    return { ...p, used, left: round2(amount - used),
             containers: (p.allocations || []).length };
  }).filter((p) => {
    if (supplierPayFilter.supplier
        && !String(p.supplier || '').toLowerCase()
             .includes(supplierPayFilter.supplier.toLowerCase())) return false;
    if (supplierPayFilter.kind && p.kind !== supplierPayFilter.kind) return false;
    return true;
  }).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  // ── THE THREE FIGURES ─────────────────────────────────────────────────
  // Sent is every row: an advance left the bank the day it was made, so
  // leaving it out would under-report what has gone. Unapplied is the part
  // of it not yet against a container — money she has already paid and can
  // still spend.
  const sent = round2(rows.reduce((t, p) => t + (Number(p.amount) || 0), 0));
  const unapplied = round2(rows.reduce((t, p) => t + Math.max(0, p.left), 0));
  const advCount = rows.filter((p) => p.kind === 'advance').length;

  const card = (label, value, tone) => `
    <div class="card" style="padding:12px;">
      <div style="font-family:var(--font-mono); font-size:9px; letter-spacing:.12em; text-transform:uppercase; color:var(--text-muted);">${label}</div>
      <div style="font-size:16px; font-weight:700; margin-top:4px; ${tone ? `color:${tone};` : ''}">${value}</div>
    </div>`;

  const kindPill = (p) => p.kind === 'advance'
    ? `<span title="Credit against this supplier until it is put against a container" style="font-size:10px; padding:2px 8px; border-radius:var(--radius-sm); border:1px solid var(--accent); color:var(--accent);">advance</span>`
    : `<span style="font-size:10px; padding:2px 8px; border-radius:var(--radius-sm); border:1px solid var(--border-default); color:var(--text-muted);">payment</span>`;

  $('viewRoot').innerHTML = `
    <div style="max-width:100%; margin:0 auto; padding:34px 28px 80px;">
      <div class="eyebrow">Edge Metals</div>
      <h2 style="font-size:19px; text-transform:uppercase; margin:0 0 14px;">Paid to suppliers</h2>
      ${metalsTabBar('bills')}
      <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; margin-bottom:12px;">
        ${card('Sent', ledMoney(sent))}
        ${card('Unapplied', ledMoney(unapplied), unapplied > 0.005 ? 'var(--status-good, #4ade80)' : '')}
        ${card('Advances', String(advCount))}
      </div>
      <div style="display:flex; flex-wrap:wrap; gap:8px; align-items:flex-end; margin-bottom:14px; padding:12px 14px; border:1px solid var(--border-subtle); border-radius:var(--radius-sm); background:var(--surface-sunken);">
        <!-- ── MATCHES AS SHE TYPES ────────────────────────────────────
             Apsara, 2026-09-29: "in payment-suppliers,why it is not a drop
             down?match as i type". It shipped as a bare text box; that was
             an oversight, not a decision.

             The names come from THE PAYMENTS ALREADY ON SCREEN, not from the
             address book or the supplier list — the only suppliers worth
             offering here are the ones she has actually sent money to, and
             they are already loaded, so there is nothing to fetch and no
             second definition of "her suppliers" to drift.

             Still a text box. Typing a name with no payments should show an
             empty table rather than be impossible to type. -->
        <div style="position:relative;"><label style="display:block; font-family:var(--font-mono); font-size:9px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted); margin-bottom:4px;">Supplier</label>
          <input id="spSupplier" autocomplete="off" value="${esc(supplierPayFilter.supplier)}" placeholder="any" style="width:200px; padding:7px 9px; font-size:12.5px;">
          <div id="spSupplierAc" class="ac-dropdown hidden" style="width:200px;"></div></div>
        <div><label style="display:block; font-family:var(--font-mono); font-size:9px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted); margin-bottom:4px;">Kind</label>
          <select id="spKind" style="padding:7px 9px; font-size:12.5px;">
            <option value=""${supplierPayFilter.kind === '' ? ' selected' : ''}>All</option>
            <option value="payment"${supplierPayFilter.kind === 'payment' ? ' selected' : ''}>Payments</option>
            <option value="advance"${supplierPayFilter.kind === 'advance' ? ' selected' : ''}>Advances</option>
          </select></div>
        <button id="spClear" class="btn btn-secondary" style="font-size:11px; padding:8px 14px;">Clear</button>
        <div style="flex:1;"></div>
        <div style="font-family:var(--font-mono); font-size:10px; color:var(--text-faint); padding-bottom:9px;">${rows.length} of ${all.length}</div>
      </div>
      <div class="card" style="padding:0; overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:12px;">
          <thead><tr style="background:var(--bg-sunken);">
            ${['Date', 'Supplier', 'Kind', 'Method', 'Bank', 'Reference', 'Containers', 'Sent', 'Applied', 'Unapplied', '']
              .map((h, i) => `<th style="padding:8px 9px; text-align:${i >= 7 ? 'right' : 'left'}; white-space:nowrap; font-family:var(--font-mono); font-size:9px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted);">${h}</th>`).join('')}
          </tr></thead>
          <tbody>${rows.length ? rows.map((p) => `
            <tr style="border-top:1px solid var(--line);">
              <td style="padding:7px 9px; white-space:nowrap; font-family:var(--font-mono);">${esc(p.date || '—')}</td>
              <td style="padding:7px 9px;">${esc(p.supplier || '—')}</td>
              <td style="padding:7px 9px;">${kindPill(p)}</td>
              <td style="padding:7px 9px;">${esc(p.mode || '—')}</td>
              <td style="padding:7px 9px; color:var(--text-muted);">${esc(p.bank || (p.mode === 'Cash' ? 'cash' : '—'))}</td>
              <td style="padding:7px 9px; color:var(--text-muted);">${esc(p.ref || '—')}</td>
              <td style="padding:7px 9px; color:var(--text-muted);">${p.containers || 0}</td>
              <td style="padding:7px 9px; text-align:right; font-family:var(--font-mono);">${ledMoney(p.amount)}</td>
              <td style="padding:7px 9px; text-align:right; font-family:var(--font-mono); color:var(--text-muted);">${ledMoney(p.used)}</td>
              <td style="padding:7px 9px; text-align:right; font-family:var(--font-mono); ${p.left > 0.005 ? 'color:var(--status-good, #4ade80);' : 'color:var(--text-faint);'}">${ledMoney(p.left)}</td>
              <td style="padding:7px 9px; text-align:right; white-space:nowrap;">${metalsCanDelete()
                ? `<button class="spEdit" data-payment="${esc(p.id)}"
                     style="background:none; border:1px solid var(--border-default); border-radius:var(--radius-sm); padding:3px 9px; font-size:11px; color:var(--text-body); cursor:pointer; white-space:nowrap; margin-right:6px;">Edit</button>`
                  + `<button class="spDel" data-payment="${esc(p.id)}" data-containers="${p.containers || 0}"
                     style="background:none; border:1px solid var(--border-default); border-radius:var(--radius-sm); padding:3px 9px; font-size:11px; color:var(--danger, #f87171); cursor:pointer; white-space:nowrap;">Delete</button>`
                : `<span title="Sign in with the Jarvis profile to change a supplier payment" style="font-size:11px; color:var(--text-faint);">&mdash;</span>`}</td>
            </tr>`).join('')
            : `<tr><td colspan="11" style="padding:26px; text-align:center; color:var(--text-faint); font-family:var(--font-mono); font-size:12px;">Nothing sent to a supplier yet.</td></tr>`}
          </tbody>
        </table>
      </div>
      <div style="margin-top:10px; font-family:var(--font-mono); font-size:10px; color:var(--text-faint);">
        ${metalsCanDelete()
          ? 'Delete reverses a payment and reopens its containers. Record and apply from Pay, on the Bills tab'
          : 'Read only — record and apply from Pay, on the Bills tab'}. An advance left the bank the day it was made; Unapplied is the part not yet against a container.
      </div>
    </div>`;

  wireMetalsTabs();

  // ── DELETE, WHERE THE PAYMENTS ACTUALLY ARE ──────────────────────────
  // Apsara, 2026-10-06: "Also i already told you that there should be an
  // option to delete the payment bill for edge metals", then "Unlock and
  // delete" — having been sent to this tab and found nothing.
  //
  // She was right to look here and wrong to expect it. Delete DID exist,
  // but only inside openBillPayForm — the Pay modal on the Bills tab. So
  // the screen that LISTS her 46 payments could not remove one, while the
  // form for MAKING a payment could. Nobody would guess that, and this tab
  // said "Read only" in 10px grey at the bottom, which is not an answer.
  //
  // NOTHING ABOUT PERMISSION CHANGES HERE. Asked whether to open this up,
  // she chose "just put Delete on the Payments tab" and said office staff
  // also hold ADMIN_PASSWORD — which is exactly why her 2026-09-16 rule
  // (Edge Metals ledger deletions are the Jarvis profile's) was right. Same
  // metalsCanDelete() gate, same requireSuper route, same audit.
  //
  // The arming is deliberately the same two-click shape as the modal's: a
  // first click that says what it is about to undo, and only a second that
  // does it. It is written out here rather than shared with openBillPayForm
  // because that modal is a working money path and quietly refactoring it
  // to serve a new screen is how the supplier-payment break happened. The
  // convergence is filed instead, so the duplication is a decision rather
  // than an accident.
  // The arm-then-confirm wording and timing live in armThenConfirm, shared
  // with the pay-history button that posts to this same route (#182).
  armThenConfirm({
    selector: '.spDel',
    danger: 'var(--danger, #f87171)',
    onConfirm: async (btn) => {
      await api('/api/bill-payments/' + encodeURIComponent(btn.dataset.payment),
                { method: 'DELETE' });
      // Re-render rather than removing the row: Sent, Unapplied and the
      // advance count all moved, and a table that agrees with itself only in
      // the row you happened to change is worse than a reload.
      await renderSupplierPaymentsTab();
    },
    // Surfaced on the row, not in an alert — she is looking at the row, and a
    // 403 here means the session is not the Jarvis profile, which is a
    // sentence rather than a code.
    onError: (btn, e) => {
      btn.textContent = /403|forbidden/i.test(String(e && e.message))
        ? 'Jarvis profile only' : 'Failed — try again';
    },
  });

  document.querySelectorAll('.spEdit').forEach((btn) => {
    btn.onclick = () => editPaymentFlow({
      btn,
      id: btn.dataset.payment,
      row: rows.find((r) => String(r.id) === String(btn.dataset.payment)),
      preview: (body) => api('/api/bill-payments/' + encodeURIComponent(btn.dataset.payment) + '/preview-edit',
                             { method: 'POST', body }),
      save: (body) => api('/api/bill-payments/' + encodeURIComponent(btn.dataset.payment),
                          { method: 'PUT', body }),
      noun: 'containers',
      elsewhere: 'Pay on the Bills tab',
      reload: renderSupplierPaymentsTab,
    });
  });

  const apply = () => {
    supplierPayFilter.supplier = $('spSupplier').value.trim();
    supplierPayFilter.kind = $('spKind').value;
    renderSupplierPaymentsTab();
  };
  $('spSupplier').addEventListener('change', apply);
  $('spSupplier').addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });

  // ── THE SUPPLIER TYPE-AHEAD ──────────────────────────────────────────
  // Built from `all` — every payment loaded for this screen — so the list is
  // exactly the suppliers she has sent money to. Counted, so the one she pays
  // most is offered first rather than whoever happens to sort early.
  {
    const inp = $('spSupplier'), menu = $('spSupplierAc');
    const seen = new Map();
    for (const p of all) {
      const name = String(p.supplier || '').trim();
      if (!name) continue;
      const k = name.toLowerCase();
      const cur = seen.get(k);
      if (cur) cur.n += 1; else seen.set(k, { name, n: 1 });
    }
    const names = [...seen.values()].sort((a, b) => (b.n - a.n) || a.name.localeCompare(b.name));

    const close = () => { menu.classList.add('hidden'); menu.innerHTML = ''; };
    const open = () => {
      const q = inp.value.trim().toLowerCase();
      const hits = (q ? names.filter((x) => x.name.toLowerCase().includes(q)) : names).slice(0, 10);
      // A single exact match is the thing already typed — a dropdown showing
      // only that covers the table for no gain.
      if (!hits.length || (hits.length === 1 && hits[0].name.toLowerCase() === q)) return close();
      menu.innerHTML = hits.map((x, i) =>
        `<div class="ac-item" data-idx="${i}">${esc(x.name)}<span style="color:var(--text-faint); font-size:11px;">  ${x.n}</span></div>`).join('');
      menu.classList.remove('hidden');
      menu.querySelectorAll('.ac-item').forEach((el) => el.addEventListener('mousedown', (ev) => {
        // mousedown, not click: blur fires first on a click and would close
        // the menu before the click landed. Selection by index, never by
        // parsing the label back out — the label carries a count too.
        ev.preventDefault();
        const hit = hits[Number(el.dataset.idx)];
        if (hit) inp.value = hit.name;
        close();
        apply();
      }));
    };
    inp.addEventListener('focus', open);
    inp.addEventListener('input', open);
    inp.addEventListener('blur', () => setTimeout(close, 150));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }
  $('spKind').addEventListener('change', apply);
  $('spClear').onclick = () => { supplierPayFilter = { supplier: '', kind: '' }; renderSupplierPaymentsTab(); };
}

async function renderMetalsTruckingTab() {
  metalsTab.bills = 'trucking';
  const qs = Object.entries(truckingFilters)
    .filter(([, v]) => String(v || '').trim() !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const data = await api('/api/metals-trucking' + (qs ? `?${qs}` : ''));
  const rows = data.payables || [];
  const sum = data.summary || {};
  const facets = data.facets || {};
  const active = Object.values(truckingFilters).filter((v) => String(v || '').trim() !== '').length;

  const card = (label, value, tone) => `
    <div class="card" style="padding:12px;">
      <div style="font-family:var(--font-mono); font-size:9px; letter-spacing:.12em; text-transform:uppercase; color:var(--text-muted);">${label}</div>
      <div style="font-size:16px; font-weight:700; margin-top:4px; ${tone ? `color:${tone};` : ''}">${value}</div>
    </div>`;

  const pill = (r) => {
    const map = { paid: ['var(--status-good, #4ade80)', 'paid'],
                  part: ['var(--accent)', 'part'],
                  unpaid: ['var(--status-warn)', 'unpaid'],
                  // Filled rather than outlined, because this one is a job to
                  // do and the others are states to read.
                  missing: ['var(--status-danger)', 'no amount'] };
    const [colour, text] = map[r.status] || map.unpaid;
    const title = r.status === 'missing'
      ? `This bill still needs: ${(r.missing || []).join(' and ')}`
      : '';
    return `<span title="${esc(title)}" style="font-size:10px; padding:2px 8px; border-radius:var(--radius-sm); border:1px solid ${colour}; color:${colour};">${text}</span>`;
  };

  const sel = (key, label, opts, width) => `
    <div>
      <div style="font-family:var(--font-mono); font-size:9px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted); margin-bottom:4px;">${label}</div>
      <select data-trk-filter="${key}" style="width:${width}px; padding:7px 9px; background:var(--surface-card); border:1px solid var(--border-default); border-radius:var(--radius-sm); color:var(--text-strong); outline:none; font-size:12px;">
        <option value="">All</option>
        ${(opts || []).map((o) => `<option value="${esc(o)}" ${truckingFilters[key] === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
      </select>
    </div>`;

  const box = (key, label) => `
    <div>
      <div style="font-family:var(--font-mono); font-size:9px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted); margin-bottom:4px;">${label}</div>
      <input data-trk-filter="${key}" value="${esc(truckingFilters[key] || '')}" placeholder="MM/DD/YYYY" autocomplete="off"
        style="width:120px; padding:7px 9px; background:var(--surface-card); border:1px solid var(--border-default); border-radius:var(--radius-sm); color:var(--text-strong); outline:none; font-size:12px;">
    </div>`;

  $('viewRoot').innerHTML = `
    <div style="max-width:100%; margin:0 auto; padding:34px 28px 80px;">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:14px;">
        <div>
          <div class="eyebrow">// Edge Metals</div>
          <h2 style="font-size:19px; text-transform:uppercase; margin:0;">Trucking</h2>
        </div>
        <button id="btnPayTrucking" class="btn btn-primary" style="font-size:12px; padding:8px 14px;">Pay</button>
      </div>
      ${metalsTabBar('bills')}

      <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:8px; margin-bottom:12px;">
        ${card('Haulage', ledMoney(sum.amount))}
        ${card('Paid', ledMoney(sum.paid))}
        ${card('Outstanding', ledMoney(sum.outstanding), sum.outstanding > 0.005 ? 'var(--status-warn)' : '')}
        ${card('Unpaid hauls', ledNum(sum.unpaid_count))}
        ${card('No amount yet', ledNum(sum.missing_count), sum.missing_count ? 'var(--status-warn)' : '')}
      </div>

      <div style="display:flex; flex-wrap:wrap; gap:8px; align-items:flex-end; margin-bottom:14px; padding:12px 14px; border:1px solid var(--border-subtle); border-radius:var(--radius-sm); background:var(--surface-sunken);">
        ${sel('trucking_company', 'Trucker', facets.trucking_company, 160)}
        ${sel('status', 'Status', facets.status, 110)}
        ${box('from', 'From')}
        ${box('to', 'To')}
        <button id="trkClear" class="btn btn-secondary" style="font-size:11px; padding:8px 14px;">Clear</button>
        <div style="flex:1;"></div>
        <div style="font-family:var(--font-mono); font-size:10px; color:var(--text-faint); padding-bottom:9px;">
          ${active ? `${active} filter${active === 1 ? '' : 's'} · ` : ''}${rows.length} of ${data.total_unfiltered ?? rows.length}
        </div>
      </div>

      <div class="card" style="padding:0; overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:12px;">
          <thead><tr style="background:var(--bg-sunken);">
            ${['Date', 'Booking', 'Container', 'Supplier', 'Trucker', 'Amount', 'Paid', 'Balance', '']
              .map((h, i) => `<th style="padding:8px 9px; text-align:${i >= 5 && i <= 7 ? 'right' : 'left'}; white-space:nowrap; font-family:var(--font-mono); font-size:9px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted);">${h}</th>`).join('')}
          </tr></thead>
          <tbody>${rows.length ? rows.map((r) => `
            <tr data-bill="${esc(r.bill_id)}" style="border-top:1px solid var(--line);">
              <td style="padding:7px 9px; white-space:nowrap; font-family:var(--font-mono);">${ledText(r.date)}</td>
              <td style="padding:7px 9px; white-space:nowrap; font-family:var(--font-mono); color:var(--text-muted);">${ledText(r.booking_no)}</td>
              <td style="padding:7px 9px; white-space:nowrap; font-family:var(--font-mono);">${ledText(r.container_no)}</td>
              <td style="padding:7px 9px; white-space:nowrap;">${ledText(r.supplier)}</td>
              <td style="padding:7px 9px; white-space:nowrap;">${ledText(r.trucking_company)}</td>
              <td style="padding:7px 9px; text-align:right; font-family:var(--font-mono); ${r.priced ? '' : 'color:var(--status-warn);'}">${r.priced ? ledMoney(r.amount) : 'not entered'}</td>
              <td style="padding:7px 9px; text-align:right; font-family:var(--font-mono); color:var(--text-muted);">${r.paid ? ledMoney(r.paid) : '—'}</td>
              <td style="padding:7px 9px; text-align:right; font-family:var(--font-mono);">${r.balance > 0.005 ? ledMoney(r.balance) : '—'}</td>
              <td style="padding:7px 9px;">${pill(r)}</td>
            </tr>
            <tr class="trkDetail" data-for="${esc(r.bill_id)}" style="display:none; background:var(--surface-sunken);">
              <td colspan="9" style="padding:12px 14px;"></td>
            </tr>`).join('')
            : `<tr><td colspan="9" style="padding:26px; text-align:center; color:var(--text-faint); font-family:var(--font-mono); font-size:12px;">${active ? 'Nothing matches those filters.' : 'No bill names a trucker yet.'}</td></tr>`}</tbody>
        </table>
      </div>
      <div style="margin-top:10px; font-family:var(--font-mono); font-size:10px; color:var(--text-faint);">
        ${rows.length} row${rows.length === 1 ? '' : 's'} · built from the bills, so a trucking amount changed there changes here · Edge Yard haulage lives under Truckers
      </div>

      <!-- ── THE PAYMENTS THEMSELVES, AND THE WAY BACK OUT ──────────────
           Apsara, 2026-10-03: "I want jarvis profile to have access to
           delete payments on edge metals."

           DELETE /api/metals-trucking/:id has existed, requireSuper, since
           the tab was built. It removes the payment, unwinds its mirrored
           ledger row and writes an audit entry naming the trucker and every
           allocation. Nothing in either client ever called it. The table
           above is built from the BILLS, so a payment that was wrong had no
           row of its own to press anything on — the same shape as the
           settled-load badge on 2026-09-23, where the route worked and the
           screen holding the button was unreachable.

           The payments were already on this response as data.payments
           (mt.list()); they were simply never drawn. -->
      ${(data.payments || []).length ? `
      <div style="margin-top:22px;">
        <div style="font-family:var(--font-mono); font-size:9px; letter-spacing:.12em; text-transform:uppercase; color:var(--text-muted); margin-bottom:7px;">Payments recorded</div>
        <div class="card" style="padding:0; overflow-x:auto;">
          <table style="width:100%; border-collapse:collapse; font-size:12px;">
            <thead><tr style="background:var(--bg-sunken);">
              ${['Date', 'Trucker', 'How', 'Reference', 'Covers', 'Amount', '']
                .map((h, i) => `<th style="padding:8px 9px; text-align:${i === 5 ? 'right' : 'left'}; white-space:nowrap; font-family:var(--font-mono); font-size:9px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted);">${h}</th>`).join('')}
            </tr></thead>
            <tbody>${[...(data.payments || [])].reverse().map((p) => `
              <tr style="border-top:1px solid var(--line);">
                <td style="padding:7px 9px; white-space:nowrap; font-family:var(--font-mono);">${ledText(p.date)}</td>
                <td style="padding:7px 9px; white-space:nowrap;">${ledText(p.trucking_company)}</td>
                <td style="padding:7px 9px; white-space:nowrap;">${esc(p.mode || '')}${p.bank ? ' · ' + esc(p.bank) : ''}</td>
                <td style="padding:7px 9px; color:var(--text-muted);">${ledText(p.ref)}</td>
                <td style="padding:7px 9px; white-space:nowrap; color:var(--text-muted);">${(p.allocations || []).length} container${(p.allocations || []).length === 1 ? '' : 's'}</td>
                <td style="padding:7px 9px; text-align:right; font-family:var(--font-mono);">${ledMoney(p.amount)}</td>
                <td style="padding:7px 9px; white-space:nowrap;">${metalsCanDelete()
                  ? `<button class="trkPayEdit" data-id="${esc(p.id)}" style="background:none; border:1px solid var(--line); border-radius:var(--radius-sm); padding:3px 9px; font-size:10px; color:var(--text-body); cursor:pointer; margin-right:6px;">Edit</button>`
                    + `<button class="trkPayDel" data-id="${esc(p.id)}" data-who="${esc(p.trucking_company || '')}" data-amount="${esc(ledMoney(p.amount))}" data-covers="${(p.allocations || []).length}" style="background:none; border:1px solid var(--line); border-radius:var(--radius-sm); padding:3px 9px; font-size:10px; color:var(--status-warn); cursor:pointer;">Delete</button>`
                  : `<span title="Sign in with the Jarvis profile to change a trucking payment" style="font-size:10px; color:var(--text-faint);">&mdash;</span>`}</td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
      </div>` : ''}
    </div>`;

  // ENTER or blur, not every keystroke: each apply is a round trip.
  document.querySelectorAll('[data-trk-filter]').forEach((el) => {
    const apply = () => {
      const v = el.value;
      if ((truckingFilters[el.dataset.trkFilter] || '') === v) return;
      truckingFilters[el.dataset.trkFilter] = v;
      renderMetalsTruckingTab();
    };
    if (el.tagName === 'SELECT') el.onchange = apply;
    else {
      el.onblur = apply;
      el.onkeydown = (e) => { if (e.key === 'Enter') apply(); };
    }
  });
  ['from', 'to'].forEach((k) => {
    const el = document.querySelector(`[data-trk-filter="${k}"]`);
    if (el) wireUsDateField(el);
  });
  // ── CLICK A ROW FOR THE SPLIT ────────────────────────────────────────
  // Apsara, 2026-09-10: "There should be a provision to view the detailed
  // split on amount on clicking that row". Folded away rather than shown,
  // because five more columns is the thing that made the first bill form
  // unreadable — and most of the time the question is "what do I owe", not
  // "what is it made of".
  // ── THE SPLIT IS EDITED HERE, NOT ON THE BILL ────────────────────────
  // Apsara, 2026-09-10: "in bill,i dont want detailed like this .I want
  // detailed in trucking on clicking the row,it should show all these and i
  // should be able to edit and delete."
  //
  // It belongs here: checking a haulier's invoice against its parts is a
  // different job from entering a bill, done at a different time, and five
  // more boxes on the bill form is what made that form clumsy three times
  // over. Painted per row, only when opened.
  const rowByBill = new Map((data.payables || []).map((r) => [r.bill_id, r]));

  function paintSplitEditor(billId) {
    const detail = document.querySelector(`.trkDetail[data-for="${billId}"]`);
    const r = rowByBill.get(billId);
    if (!detail || !r) return;
    const cellS = (v, ph, w) => `value="${esc(v ?? '')}" placeholder="${esc(ph || '')}" autocomplete="off"`
      + ` style="width:${w}; height:28px; padding:0 8px; font-size:12px; background:var(--surface-card);`
      + ` border:1px solid var(--border-default); border-radius:var(--radius-sm); color:var(--text-strong); outline:none;"`;
    const sp = r.split || { others: [] };
    const others = Array.isArray(sp.others) ? sp.others : [];
    const parts = [['line_haul', 'Line Haul'], ['port_fees', 'Port Fees'],
                   ['chassis_rent', 'Chassis Rent'], ['dry_run', 'Dry Run'],
                   ['extra_scale', 'Extra Scale']];
    const n = (v) => { const x = parseFloat(String(v ?? '').replace(/[$,\s]/g, '')); return isFinite(x) ? x : 0; };
    const total = parts.reduce((t, [k]) => t + n(sp[k]), 0)
      + others.reduce((t, o) => t + n(o.amount), 0);

    detail.querySelector('td').innerHTML = `
      <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(104px,1fr)); gap:8px; margin-bottom:10px;">
        ${parts.map(([k, label]) => `
          <div><div style="font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted); margin-bottom:3px;">${label}</div>
            <input data-sp="${k}" data-bill="${esc(billId)}" ${cellS(sp[k], '', '100%')}></div>`).join('')}
      </div>
      <div id="trkOthers-${esc(billId)}">
        ${others.map((o, i) => `
          <div style="display:flex; align-items:center; gap:6px; margin-bottom:5px;">
            <input data-oth="${i}" data-f="what" data-bill="${esc(billId)}" ${cellS(o.what, 'what', '150px')}>
            <input data-oth="${i}" data-f="amount" data-bill="${esc(billId)}" ${cellS(o.amount, 'amount', '90px')}>
            <input data-oth="${i}" data-f="note" data-bill="${esc(billId)}" ${cellS(o.note, 'why — required', '100%')} style="flex:1; height:28px; padding:0 8px; font-size:12px; background:var(--surface-card); border:1px solid ${(String(o.what || '').trim() && !String(o.note || '').trim()) ? 'var(--status-danger)' : 'var(--border-default)'}; border-radius:var(--radius-sm); color:var(--text-strong); outline:none;">
            <button type="button" class="trkOthDel" data-i="${i}" data-bill="${esc(billId)}" aria-label="Remove" style="background:none; border:none; color:var(--text-muted); font-size:15px; cursor:pointer;">&times;</button>
          </div>`).join('')}
        <button type="button" class="trkOthAdd" data-bill="${esc(billId)}" style="background:none; border:none; color:var(--accent); font-size:12px; cursor:pointer; padding:0;">+ Add other charge</button>
      </div>
      <div style="display:flex; align-items:flex-end; gap:10px; margin-top:12px; flex-wrap:wrap;">
        <div><div style="font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted); margin-bottom:3px;">Trucker invoice no</div>
          <input data-sp="invoice_no" data-bill="${esc(billId)}" ${cellS(sp.invoice_no, '', '130px')}></div>
        <div><div style="font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted); margin-bottom:3px;">Last verified</div>
          <input data-sp="verified_on" data-bill="${esc(billId)}" ${cellS(sp.verified_on, 'YYYY-MM-DD', '130px')}></div>
        <div><div style="font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted);">Total</div>
          <div class="trkSplitTotal" data-bill="${esc(billId)}" style="font-size:15px; font-weight:500; font-family:var(--font-mono);">${ledMoney(total)}</div></div>
        <span style="flex:1;"></span>
        <button type="button" class="trkSplitDel" data-bill="${esc(billId)}" class="btn btn-ghost" style="background:none; border:1px solid var(--line); border-radius:var(--radius-sm); padding:6px 12px; font-size:11px; color:var(--status-warn); cursor:pointer;">Clear split</button>
        <button type="button" class="trkSplitSave" data-bill="${esc(billId)}" class="btn btn-primary" style="border:1px solid var(--accent); background:var(--accent); color:#fff; border-radius:var(--radius-sm); padding:6px 16px; font-size:11px; cursor:pointer;">Save</button>
      </div>
      <div class="trkSplitErr" data-bill="${esc(billId)}" style="color:var(--status-danger); font-size:11px; margin-top:7px;"></div>`;

    const draft = () => {
      const d = { others: [] };
      detail.querySelectorAll('input[data-sp]').forEach((el) => { d[el.dataset.sp] = el.value; });
      detail.querySelectorAll('input[data-oth]').forEach((el) => {
        const i = +el.dataset.oth;
        d.others[i] = d.others[i] || {};
        d.others[i][el.dataset.f] = el.value;
      });
      // Preserve the ids so a line keeps its identity across saves.
      (sp.others || []).forEach((o, i) => { if (d.others[i] && o.id) d.others[i].id = o.id; });
      return d;
    };
    const retotal = () => {
      const d = draft();
      const t = parts.reduce((a, [k]) => a + n(d[k]), 0)
        + (d.others || []).reduce((a, o) => a + n(o && o.amount), 0);
      const el = detail.querySelector(`.trkSplitTotal[data-bill="${billId}"]`);
      if (el) el.textContent = ledMoney(t);
      (d.others || []).forEach((o, i) => {
        const note = detail.querySelector(`input[data-oth="${i}"][data-f="note"]`);
        if (note) note.style.borderColor = (String(o.what || '').trim() && !String(o.note || '').trim())
          ? 'var(--status-danger)' : 'var(--border-default)';
      });
    };
    detail.querySelectorAll('input').forEach((el) => { el.oninput = retotal; });
    detail.querySelectorAll('.trkOthDel').forEach((b) => {
      b.onclick = () => { const d = draft(); d.others.splice(+b.dataset.i, 1);
                          rowByBill.set(billId, { ...r, split: d }); paintSplitEditor(billId); };
    });
    const add = detail.querySelector('.trkOthAdd');
    if (add) add.onclick = () => { const d = draft(); d.others.push({});
                                   rowByBill.set(billId, { ...r, split: d }); paintSplitEditor(billId); };

    const save = async (payload) => {
      const err = detail.querySelector(`.trkSplitErr[data-bill="${billId}"]`);
      err.textContent = '';
      try {
        await api(`/api/bills/${encodeURIComponent(billId)}`,
                  { method: 'PUT', body: JSON.stringify({ trucking_split: payload }) });
        renderMetalsTruckingTab();
      } catch (e) { err.textContent = e.message || 'Could not save it'; }
    };
    detail.querySelector('.trkSplitSave').onclick = () => save(draft());
    // Clearing sends an EMPTY split rather than deleting the bill's trucking
    // figure: the amount she typed on the bill stands on its own again.
    detail.querySelector('.trkSplitDel').onclick = () => save({ others: [] });
  }

  document.querySelectorAll('tr[data-bill]').forEach((tr) => {
    const detail = document.querySelector(`.trkDetail[data-for="${tr.dataset.bill}"]`);
    if (!detail) return;
    tr.style.cursor = 'pointer';
    tr.onclick = (e) => {
      // Not when she is clicking something inside the row that does its own
      // thing — a status pill today, a button tomorrow.
      if (e.target.closest('button, a, input')) return;
      const opening = detail.style.display === 'none';
      detail.style.display = opening ? 'table-row' : 'none';
      if (opening) paintSplitEditor(tr.dataset.bill);
    };
  });

  wireMetalsTabs();
  $('trkClear').onclick = () => { truckingFilters = {}; renderMetalsTruckingTab(); };
  $('btnPayTrucking').onclick = () => openTruckingPay(data);

  // ── REMOVING ONE ─────────────────────────────────────────────────────
  // Says what goes with it before it goes. Deleting this payment reopens
  // every container it covered and takes its ledger row with it, so the
  // confirmation names both — "are you sure" on its own tells her nothing
  // she did not already know.
  document.querySelectorAll('.trkPayDel').forEach((btn) => {
    btn.onclick = async () => {
      const n = Number(btn.dataset.covers) || 0;
      const ok = confirm(`Remove the ${btn.dataset.amount} payment to ${btn.dataset.who}?\n\n`
        + `${n} container${n === 1 ? '' : 's'} go back to outstanding, and the payment `
        + 'disappears from the spend report. This is written to the audit log.');
      if (!ok) return;
      btn.disabled = true;
      try {
        await api(`/api/metals-trucking/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
        await renderMetalsTruckingTab();
      } catch (e) {
        btn.disabled = false;
        // The route's own sentence, which names the Jarvis profile when that
        // is the reason — a generic "could not delete" would hide the one
        // fact that tells her what to do about it.
        alert(e.message || 'Could not remove that payment.');
      }
    };
  });

  // ── CHANGING ONE ─────────────────────────────────────────────────────
  // The trucker half of "option to edit". Same two-step as the supplier
  // payments tab, because it is the same function — see editPaymentFlow.
  document.querySelectorAll('.trkPayEdit').forEach((btn) => {
    btn.onclick = () => editPaymentFlow({
      btn,
      id: btn.dataset.id,
      row: (data.payments || []).find((p) => String(p.id) === String(btn.dataset.id)),
      preview: (body) => api('/api/metals-trucking/' + encodeURIComponent(btn.dataset.id) + '/preview-edit',
                             { method: 'POST', body }),
      save: (body) => api('/api/metals-trucking/' + encodeURIComponent(btn.dataset.id),
                          { method: 'PUT', body }),
      noun: 'containers',
      elsewhere: 'Pay on this tab',
      reload: renderMetalsTruckingTab,
    });
  });
}

// ── PAYING A HAULIER ─────────────────────────────────────────────────────
// The fourth form of this shape, and the same rule as the supplier side: it
// asks WHO is being paid first, then lists only that haulier's outstanding
// containers. A wire marked Sher Trucking ticked against a container Bayou
// hauled is a false statement about who was paid, and the route refuses it.
