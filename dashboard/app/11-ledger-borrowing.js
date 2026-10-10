// dashboard/app/11-ledger-borrowing.js — split from dashboard/index.html's <script> (helpers/sourceParts.js reconstructs the original)
function openLedgerForm(kind, existing, seed) {
  const K = LEDGER_KINDS[kind];
  const editing = !!(existing && existing.id);
  const all = ledgerState.fields || [];
  const groups = ledgerState.groups || [];

  // Derived columns get an input ONLY when the store gave them a writeKey —
  // "Supplier invoice amount" is computed by default AND typeable off the
  // supplier's paperwork, and compute() prefers hers. Everything else derived
  // is read-only by construction: a client that could post its own Balance is
  // a client that can disagree with the server about money.
  // ── A LIGHT SHEET FOR THE BILL ───────────────────────────────────────
// Apsara, 2026-09-10: "i want light colour on that bill".
//
// Scoped to this modal, NOT applied app-wide. The rest of Jarvis is dark and
// she has not asked for that to change; a bill is a document she is copying
// off paper, and a light sheet is what a document looks like. Declared as
// local variables so every rule below reads the same way it does everywhere
// else in this file — the only difference is what the names resolve to.

// ── ONE FIELD ────────────────────────────────────────────────────────
  // Apsara, 2026-09-10, on the previous version: "still it looks ugly and
  // clumsy and not user friendly". Six things were wrong and they compounded:
  //
  //   · type="number" draws SPINNER ARROWS on every weight and money box —
  //     useless for a five-digit weight, and ten of them at once is noise.
  //     inputmode="decimal" gives a phone the number pad without the arrows.
  //   · the unit lived in the LABEL, so "Supplier invoice amount ($)" wrapped
  //     onto two lines and pushed its input below its neighbours. That is why
  //     the Money row was visibly crooked. It sits INSIDE the field now.
  //   · hint text under a field made every row a different height, so nothing
  //     lined up. Moved to the tooltip.
  //   · numbers were left-aligned in a proportional font, so digits did not
  //     line up down a column. Right-aligned monospace now.
  const inputFor = (c) => {
    const name = c.writeKey || c.key;
    // A new bill or invoice starts dated today in LA. Only the field actually
    // called `date` — proforma_date is a real historical date on someone
    // else's document, and pre-filling it with today would be a plausible
    // wrong answer, which is worse than a blank box.
    const fallback = (!existing && name === 'date') ? toUsDate(todayYardDateStr()) : undefined;
    const suggested = (!existing && seed && seed[name] !== undefined && seed[name] !== '')
      ? seed[name] : undefined;
    const val = existing ? existing[name] : (suggested !== undefined ? suggested : fallback);
    const existingVal = val;

    if (c.textarea) {
      return `<div class="field" style="grid-column:1/-1;">
        <label style="display:block; font-size:11px; letter-spacing:.02em; text-transform:none; color:${LEDGER_LIGHT.inkMuted}; margin-bottom:5px; white-space:nowrap;">${esc(c.formLabel || c.label)}</label>
        <textarea name="${esc(name)}" rows="2" placeholder="${esc(c.placeholder || '')}"
          style="width:100%; padding:8px 10px; background:${LEDGER_LIGHT.paper}; border:1px solid ${LEDGER_LIGHT.line}; border-radius:var(--radius-sm); color:${LEDGER_LIGHT.ink}; outline:none; font-family:var(--font-mono); font-size:12px; resize:vertical;">${esc(Array.isArray(existingVal) ? existingVal.join('\n') : (existingVal || ''))}</textarea>
      </div>`;
    }

    const money = c.unit === '$';
    const weight = c.unit === 'lbs' || c.unit === 'MT';
    const numeric = money || weight || c.num;
    const attrs = [
      `name="${esc(name)}"`,
      'type="text"',
      numeric ? 'inputmode="decimal" autocomplete="off"' : '',
      (val === null || val === undefined || val === '') ? '' : `value="${esc(String(val))}"`,
      c.date ? 'placeholder="MM/DD/YYYY" data-ledger-date="1" autocomplete="off"'
             : (c.placeholder ? `placeholder="${esc(c.placeholder)}"` : ''),
      c.num ? 'data-ledger-num="1"' : '',
      // The hint that used to sit under the box, so the row keeps its height.
      c.hint ? `title="${esc(c.hint)}"` : '',
      // ── THE LIST SHE IS BUILDING AS SHE TYPES ────────────────────────
      // Apsara, 2026-09-10: "Supplier should be dynamically listed in text
      // box.first time,when we type,it needs to added to the list,next time
      // when i tye,it should start showing matching case." Then: "so as Item
      // description."
      //
      // A native <datalist>, not a hand-rolled dropdown. It filters as she
      // types, it does not stop her entering something new, and it needs no
      // JavaScript — so it cannot break the way a custom menu can when a
      // click lands slightly wrong. The options come from the values already
      // on her bills, so typing a new supplier puts it in the list the moment
      // the bill saves. Nothing to maintain and nothing to fall out of step.
      (c.suggest || (c.choices && c.choices.length)) ? `list="ledlist-${esc(c.key)}"` : '',
      // ── ROOM FOR THE UNIT, OR IT SITS ON THE NUMBER ──────────────────
      // The price field renders "$ 0.14 /lb" with the $ and /lb absolutely
      // positioned. Right-aligned text ran straight under the suffix and came
      // out as "0/.14" — two numbers overlapping in a field she reads a price
      // from. The padding now reserves the space each adornment occupies.
      `style="width:100%; height:34px; padding:0 ${c.key === 'supplier_price' ? '34px' : '10px'} 0 ${money ? '20px' : '10px'}; background:${LEDGER_LIGHT.paper}; border:1px solid ${LEDGER_LIGHT.line}; border-radius:var(--radius-sm); color:${LEDGER_LIGHT.ink}; outline:none; font-size:13px;${numeric ? ' text-align:right; font-family:var(--font-mono);' : ''}"`,
    ].filter(Boolean).join(' ');

    // The unit as an adornment, not part of the label.
    const prefix = money
      ? `<span style="position:absolute; left:9px; top:50%; transform:translateY(-50%); color:${LEDGER_LIGHT.inkFaint}; font-size:13px; pointer-events:none;">$</span>` : '';
    const suffix = (c.key === 'supplier_price')
      ? `<span id="ledPriceUnit" style="position:absolute; right:9px; top:50%; transform:translateY(-50%); color:${LEDGER_LIGHT.inkFaint}; font-size:11px; font-family:var(--font-mono); pointer-events:none;"></span>` : '';

    // white-space:nowrap is the other half of the alignment fix — a label
    // that cannot wrap cannot push its input a line below its neighbours.
    // ── WHAT THE BOX OFFERS ──────────────────────────────────────────
    // Two sources, one list. `suggest` is what she has already typed, fed by
    // the server's facets; `choices` is a fixed set the column declares —
    // LC/TT, FOB/CFR/CIF. `choices` was on the columns for a day and rendered
    // nowhere, so Payment terms was a plain text box the server then rejected
    // on save, which is the worst order to find out.
    const opts = [...new Set([
      ...(c.suggest ? ((ledgerState.facets || {})[c.key] || []) : []),
      ...(Array.isArray(c.choices) ? c.choices : []),
    ])];
    const datalist = opts.length
      ? `<datalist id="ledlist-${esc(c.key)}">${opts.map((o) => `<option value="${esc(o)}"></option>`).join('')}</datalist>`
      : '';

    return `<div class="field">
        <label style="display:block; font-size:11px; letter-spacing:.02em; text-transform:none; color:${LEDGER_LIGHT.inkMuted}; margin-bottom:5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(c.formLabel || c.label)}</label>
        <div style="position:relative;">${prefix}<input ${attrs}>${suffix}</div>${datalist}
      </div>`;
  };

  // ── LABEL BESIDE THE FIELD, NOT ABOVE IT ─────────────────────────────
  // Apsara, 2026-09-10, three times: "still it looks ugly and clumsy", "Still
  // the design looks not good", and finally, shown the reference she liked —
  // her own invoice screen — the difference was that its labels sit to the
  // LEFT of each input on one line. Stacked labels double the vertical noise
  // and make a record read as a dense form.
  //
  // `keys` on the group states the order inside it, so this walks
  // ledgerState.groupKeys rather than filtering by group and hoping the
  // COLUMNS array happens to be in her order.
  const inGroup = (g) => (Array.isArray(g.keys)
      ? g.keys.map((k) => all.find((c) => c.key === k)).filter(Boolean)
      : all.filter((c) => c.group === g.id))
    .filter((c) => !c.derived || c.writeKey);

  // Wraps inputFor rather than duplicating it: the input carries the
  // datalist, the date wiring, the $ adornment and the numeric mode, and a
  // second copy of all that to move a label would drift within the week.
  const inlineField = (c) => {
    const built = inputFor(c);
    // inputFor emits <div class="field"><label…>…</label><rest…></div>.
    const m = /^([\s\S]*?)<label[^>]*>([\s\S]*?)<\/label>([\s\S]*)$/.exec(built);
    if (!m) return built;                       // textarea and anything else
    const [, head, labelText, rest] = m;
    const openTag = /^\s*<div([^>]*)>/.exec(head);
    return `<div${openTag ? openTag[1] : ' class="field"'} style="display:flex; align-items:center; gap:12px;">
      <span style="font-size:12px; color:${LEDGER_LIGHT.inkMuted}; width:104px; flex-shrink:0; white-space:nowrap;">${labelText}</span>
      <div style="flex:1; min-width:0; position:relative;">${rest.replace(/<\/div>\s*$/, '')}</div>
    </div>`;
  };

  // ── THE LINES, AND THE HAULAGE SPLIT ─────────────────────────────────
  // Held as arrays rather than as named inputs, because the number of rows is
  // not known when the form is built and FormData cannot express a list. They
  // are read straight into the body by readForm below, so autosave carries
  // them exactly as any typed field.
  let ledItems = Array.isArray(existing && existing.items)
    ? JSON.parse(JSON.stringify(existing.items)) : [];
  // ── THERE IS ALWAYS AT LEAST ONE LINE ──────────────────────────────────
  // Apsara, 2026-09-11, chose this when told what removing "Item description"
  // and "Container weighing" would cost: those two fields were the ONLY way a
  // bill with no item lines could carry a description or a weight. Rather than
  // keep them for a case nobody wants, the case is removed — one grade is just
  // one line.
  //
  // A blank line costs nothing: bills.cleanItems drops any row with no
  // description, no weight, no price and no ticket, so an untouched line never
  // reaches the store.
  if (!ledItems.length) ledItems.push({});

  const sections = groups.map((g) => {
    const mine = inGroup(g);
    if (!mine.length && g.id !== 'items' && g.id !== 'trucking') return '';
    // The weights group is a row of five short numbers and reads better in a
    // grid; everything else is label-then-field down a column.
    const grid = g.cols
      ? `display:grid; grid-template-columns:repeat(${g.cols}, minmax(0, 1fr)); gap:10px;`
      : 'display:flex; flex-direction:column; gap:9px;';
    return `
      <div style="margin-bottom:20px;${g.full ? ' grid-column:1/-1;' : ''}">
        <div style="font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:${LEDGER_LIGHT.inkFaint}; margin-bottom:11px;">${esc(g.label)}</div>
        <div style="${grid}">${mine.map((c) => (g.cols ? inputFor(c) : inlineField(c))).join('')}</div>
        ${g.id === 'items' ? '<div id="ledItemsBox"></div>' : ''}
        ${g.id === 'trucking' && kind === 'bills'
          // Apsara, 2026-09-10: "in bill,i dont want detailed like this .I
          // want detailed in trucking on clicking the row". The split is a
          // haulier's invoice being checked, not part of entering a bill —
          // and it was five more boxes on a form that has already been
          // through three rounds of "this looks clumsy". It lives in the
          // Trucking tab now, behind the row.
          ? `<div style="font-size:11px; color:${LEDGER_LIGHT.inkFaint}; margin-top:8px;">Line Haul, Port Fees and the rest are edited under Trucking — click the haul there.</div>`
          : ''}
      </div>`;
  }).join('');

  // ── ONE BILL IS ONE CONTAINER ────────────────────────────────────────
  // Apsara, 2026-09-10: "There might be two containers under a booking.
  // Container number will be different for every load."
  //
  // That is the whole reason this picker exists. The first version filled
  // container 1 and said nothing — so on a 3-container booking she would have
  // got the same container number on all three bills, which is the kind of
  // wrong that reaches a customs entry.
  const prefill = (kind === 'bills' && !editing) ? `
    <div style="border:1px solid ${LEDGER_LIGHT.line}; border-radius:var(--radius-sm); padding:12px 14px; margin-bottom:16px; background:${LEDGER_LIGHT.paper};">
      <div style="font-size:12px; color:${LEDGER_LIGHT.inkFaint}; margin-bottom:8px;">Start from a booking</div>
      <div style="display:flex; gap:8px;">
        <input id="ledPrefillBkg" placeholder="Booking number" autocomplete="off"
               style="flex:1; padding:9px 11px; background:${LEDGER_LIGHT.paper}; border:1px solid ${LEDGER_LIGHT.line}; border-radius:var(--radius-sm); color:${LEDGER_LIGHT.ink}; outline:none; font-size:13px;">
        <button id="ledPrefillGo" class="btn btn-secondary" style="font-size:12px; padding:8px 16px; background:${LEDGER_LIGHT.sunken}; color:${LEDGER_LIGHT.ink}; border-color:${LEDGER_LIGHT.line};">Fill</button>
      </div>
      <div id="ledPrefillPick" style="display:flex; flex-wrap:wrap; gap:6px; margin-top:9px;"></div>
      <div id="ledPrefillNote" style="font-size:11px; color:${LEDGER_LIGHT.inkFaint}; margin-top:7px;">One bill is one container. Carrier, route, seal, supplier and trucker come off the booking — all still editable.</div>
    </div>` : '';

  const html = `
    <div id="ledgerModal" style="position:fixed; inset:0; background:rgba(0,0,0,.66); z-index:9000; display:flex; align-items:flex-start; justify-content:center; overflow-y:auto; padding:32px 16px;">
      <div class="card" style="width:min(900px,100%); padding:20px 22px 18px; background:${LEDGER_LIGHT.sunken}; border-color:${LEDGER_LIGHT.line};">
        <div style="display:flex; align-items:baseline; justify-content:space-between; margin-bottom:18px;">
          <h3 style="margin:0; font-size:16px; text-transform:none; letter-spacing:0; color:${LEDGER_LIGHT.ink};">${editing ? K.editLabel : K.addLabel.replace('+ ', '')}</h3>
          <div style="display:flex; align-items:center; gap:12px;">
            <span id="ledSaveState" style="font-family:var(--font-mono); font-size:10px; color:${LEDGER_LIGHT.inkFaint};"></span>
            <!-- Apsara, 2026-09-10: "at top right close option should be
                 there in bill." Escape closes it too. -->
            ${ledgerThemeToggle()}
          <button id="ledClose" title="Close (Esc)" aria-label="Close"
              style="background:none; border:none; color:${LEDGER_LIGHT.inkMuted}; font-size:22px; line-height:1; cursor:pointer; padding:0 2px;">&times;</button>
          </div>
        </div>
        ${prefill}
        <!-- TWO COLUMNS, and a cap. The old form stretched to the whole
             window — four fields spread across 1670px, so reading one row
             meant crossing the screen. -->
        <form id="ledgerForm" style="display:grid; grid-template-columns:repeat(auto-fit,minmax(330px,1fr)); gap:0 24px; align-items:start;">${sections}</form>
        <!-- ONE BAR: the numbers she is checking and the buttons she presses,
             on the same line. Previously a totals block and a separate button
             row, which is two things to look at for one decision. -->
        <div style="border-top:1px solid ${LEDGER_LIGHT.line}; padding-top:13px; margin-top:2px; display:flex; align-items:flex-end; gap:24px; flex-wrap:wrap;">
          <div id="ledPreview" style="display:flex; gap:24px; flex-wrap:wrap;"></div>
          <div style="flex:1;"></div>
          <div style="display:flex; gap:8px;">
            <button id="ledCancel" class="btn btn-secondary" style="font-size:11px; padding:8px 16px; background:${LEDGER_LIGHT.paper}; color:${LEDGER_LIGHT.inkMuted}; border-color:${LEDGER_LIGHT.line};">Cancel</button>
            <button id="ledSave" class="btn btn-primary" style="font-size:11px; padding:8px 20px; background:${LEDGER_LIGHT.accent}; border-color:${LEDGER_LIGHT.accent}; color:${LEDGER_LIGHT.accentInk};">${editing ? 'Save changes' : 'Save'}</button>
          </div>
        </div>
        <!-- L.warn, not a hex: #8A5A00 is a dark amber that all but vanishes on
             the dark palette's #1B2126, and this is the line that tells her a
             tare is missing or her typed amount disagrees with the weight. -->
        <div id="ledWarn" style="font-size:11px; color:${LEDGER_LIGHT.warn}; margin-top:9px;"></div>
        <div id="ledErr" style="color:var(--status-danger); font-family:var(--font-mono); font-size:11px; margin-top:6px;"></div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);

  // Every date box gets the text-plus-hidden-picker treatment, so it reads
  // MM/DD/YYYY on any device AND still opens the platform calendar. Wired
  // here rather than in the markup, which is the whole point of
  // wireUsDateField — a call site cannot forget one it does not write.
  document.querySelectorAll('#ledgerForm [data-ledger-date]').forEach((el) => wireUsDateField(el));

  // ── THE ITEM LINES ───────────────────────────────────────────────────
  // Apsara, 2026-09-10: "what if i have multiple items in same container",
  // then "Each grade is its own weighbridge ticket."
  //
  // Four columns on the surface — description, net, price, amount — with the
  // weighing folded underneath and opened per line. Ten input columns is what
  // made the first attempt at this unreadable, and most of the time the
  // question is what a grade came to, not what it weighed on the way in.
  const L = LEDGER_LIGHT;
  const money0 = (n) => (n === null || n === undefined || isNaN(Number(n))) ? '—'
    : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const numOf = (v) => { const n = parseFloat(String(v ?? '').replace(/[$,\s]/g, '')); return isFinite(n) ? n : null; };
  // ── cell() OWNS THE style ATTRIBUTE. NOTHING MAY ADD A SECOND ──────────
  // This emits a complete style="", so a caller that wrote its own alongside
  // it produced <input style="..." ... style="..."> — and a browser keeps the
  // FIRST and silently drops the second. That is exactly how the item row lost
  // its `flex:1` and why the header stopped lining up with the boxes; see the
  // note above paintItems. Anything extra now comes through `extra`, which is
  // appended INSIDE the one style attribute and cannot be discarded.
  const cell = (val, ph, w, extra) => `style="width:${w}; height:28px; padding:0 8px; font-size:12px; background:${L.paper}; border:1px solid ${L.line}; border-radius:var(--radius-sm); color:${L.ink}; outline:none; ${extra || ''}" value="${esc(val ?? '')}" placeholder="${esc(ph || '')}" autocomplete="off"`;

  // The same arithmetic helpers/bills.js does, for the row she is typing into.
  // The SERVER still decides what is saved — this only keeps the line from
  // being blank until the next preview lands.
  const lineOf = (it) => {
    const tare = ['truck', 'container', 'chassis', 'boxes'].reduce((t, k) => t + (numOf(it[k]) || 0), 0);
    const hasTicket = numOf(it.gross) !== null
      || ['truck', 'container', 'chassis', 'boxes'].some((k) => numOf(it[k]) !== null);
    const wt = hasTicket
      ? (numOf(it.gross) === null ? null : Math.round((numOf(it.gross) - tare) * 1000) / 1000)
      : numOf(it.weight);
    const price = numOf(it.price);
    const perLb = price === null ? null : price < 10;
    const amt = (price === null || wt === null) ? null
      : Math.round((perLb ? wt * price : (wt / 2204.62) * price) * 100) / 100;
    return { wt, amt, hasTicket, tare };
  };

  // ── ONE COLUMN DEFINITION, USED BY ALL THREE ROWS ────────────────────
  // Apsara, 2026-09-11: "header and box alignment not proper".
  //
  // It was not a spacing tweak. The header and the item rows were two
  // INDEPENDENT flex rows whose widths happened to be typed the same, and they
  // drifted for a reason no amount of nudging px would have fixed: the
  // description input carried TWO style attributes —
  //
  //     <input ... ${cell(..., '100%')} style="flex:1; ...">
  //              ^ cell() emits style="width:100%..."   ^ and so does this
  //
  // and a browser keeps the FIRST and discards the second. So `flex:1` never
  // applied. The header's Description was `flex:1` (flex-basis 0, takes what
  // is left over); the row's was `width:100%` with the default flex-shrink,
  // so the row negotiated its widths by a completely different rule and every
  // column after Description landed somewhere else.
  //
  // Two independent lists of widths cannot be kept in step by care, so there
  // is now ONE list. Header, every item row and the totals row all lay out on
  // this same grid template; a column cannot move in one without moving in
  // all three. Sales uses this same editor, so it is fixed there too.
  const ITEM_COLS = 'minmax(0,1fr) 92px 72px 82px 96px 76px';
  const ITEM_GRID = `display:grid; grid-template-columns:${ITEM_COLS}; gap:8px; align-items:center;`;

  function paintItems() {
    const box = $('ledItemsBox');
    if (!box) return;
    const rows = ledItems.map((it, i) => {
      const { wt, amt, hasTicket } = lineOf(it);
      // Every numeric cell is right-aligned and monospaced — including Price,
      // which was left-aligned prose in a column of right-aligned figures.
      const numCell = (cls, extra) => `class="${cls}" data-i="${i}" style="text-align:right; font-family:var(--font-mono); font-size:12px; ${extra}"`;
      return `
      <div data-item="${i}" style="border-top:1px solid ${L.lineSoft}; padding:7px 0;">
        <div style="${ITEM_GRID}">
          <input data-i="${i}" data-f="description" list="ledlist-description" ${cell(it.description, 'grade', '100%')}>
          ${hasTicket
            // Derived from this line's own ticket, so it is read-only — the
            // arithmetic is below and typing over it would make the two
            // disagree.
            ? `<span ${numCell('ledItemNet', `color:${L.inkMuted};`)}>${wt === null ? '—' : money0(wt)}</span>`
            // No ticket means one weighing split on paper, and then the
            // weight is hers to type. The first version made this a span in
            // BOTH cases, which left no way to enter a plain-weight line at
            // all — caught by its own test.
            : `<input data-i="${i}" data-f="weight" ${cell(it.weight, 'net lbs', '100%', 'text-align:right; font-family:var(--font-mono);')}>`}
          <span ${numCell('ledItemMt', `color:${L.inkMuted};`)}>${wt === null ? '—' : (Math.round((wt / 2204.62) * 1000) / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 })}</span>
          <input data-i="${i}" data-f="price" ${cell(it.price, 'price', '100%', 'text-align:right; font-family:var(--font-mono);')}>
          <span class="ledItemAmt" style="text-align:right; font-family:var(--font-mono); font-size:12px; color:${L.ink};">${money0(amt)}</span>
          <span style="display:flex; align-items:center; justify-content:flex-end; gap:6px;">
            <button type="button" class="ledItemTicket" data-i="${i}" title="Weighbridge ticket"
              style="background:none; border:1px solid ${L.line}; border-radius:var(--radius-sm); color:${hasTicket ? L.accent : L.inkFaint}; font-size:11px; padding:3px 7px; cursor:pointer;">ticket</button>
            <button type="button" class="ledItemDel" data-i="${i}" aria-label="Remove line"
              style="background:none; border:none; color:${L.inkFaint}; font-size:15px; line-height:1; cursor:pointer; padding:0;">&times;</button>
          </span>
        </div>
        <div class="ledTicket" data-i="${i}" style="display:${hasTicket ? 'flex' : 'none'}; align-items:center; gap:6px; margin-top:7px; padding:8px 10px; background:${L.sunken}; border-radius:var(--radius-sm); font-size:11px; color:${L.inkMuted};">
          <span style="width:38px;">Gross</span><input data-i="${i}" data-f="gross" ${cell(it.gross, '', '80px', 'text-align:right; font-family:var(--font-mono);')}>
          <span>−</span>
          ${['truck', 'container', 'chassis', 'boxes'].map((k) =>
            // One width for four boxes that hold the same kind of number. The
            // old 66/72/66/60 made a row of tare figures look ragged for no
            // reason a reader could name.
            `<input data-i="${i}" data-f="${k}" ${cell(it[k], k, '80px', 'text-align:right; font-family:var(--font-mono);')}>`).join('')}
          <span>=</span>
          <span class="ledTicketNet" style="font-family:var(--font-mono); color:${L.ink};">${wt === null ? '—' : money0(wt)}</span>
        </div>
      </div>`;
    }).join('');

    const totalWt = ledItems.reduce((t, it) => t + (lineOf(it).wt || 0), 0);
    const totalAmt = ledItems.reduce((t, it) => t + (lineOf(it).amt || 0), 0);
    const totalCell = (v) => `<span style="text-align:right; font-family:var(--font-mono); color:${L.ink};">${v}</span>`;

    // ── THE GRADE TYPE-AHEAD LIVES HERE NOW ──────────────────────────────
    // Every line's description box carries list="ledlist-description", and
    // that datalist used to be emitted by inputFor() as a side effect of the
    // bill-level "Item description" field. Removing that field on 2026-09-11
    // therefore silently killed the suggestions on every item line — caught by
    // tests/ledger-render.js, which had an assertion on it.
    //
    // Emitted here instead: beside the only thing that uses it, so it cannot
    // be carried off by a change to some other field again.
    const gradeOpts = ((ledgerState.facets || {}).description || []);
    const gradeList = gradeOpts.length
      ? `<datalist id="ledlist-description">${gradeOpts.map((o) => `<option value="${esc(o)}"></option>`).join('')}</datalist>`
      : '';

    box.innerHTML = `
      <div style="margin-top:10px;">${gradeList}
        <div class="ledItemsHead" style="${ITEM_GRID} font-size:11px; color:${L.inkFaint}; padding-bottom:4px;">
          <span>Description</span>
          <span style="text-align:right;">Net lbs</span>
          <span style="text-align:right;">Net MT</span>
          <span style="text-align:right;">Price</span>
          <span style="text-align:right;">Amount</span>
          <span></span>
        </div>
        ${rows}
        <div class="ledItemsFoot" style="${ITEM_GRID} border-top:1px solid ${L.line}; padding-top:8px; margin-top:4px; font-size:12px;">
          <button type="button" id="ledItemAdd" style="background:none; border:none; color:${L.accent}; font-size:12px; cursor:pointer; padding:0; text-align:left; justify-self:start;">+ Add item</button>
          ${ledItems.length ? `${totalCell(money0(totalWt))}
          ${totalCell((Math.round((totalWt / 2204.62) * 1000) / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 }))}
          <span></span>
          ${totalCell(money0(totalAmt))}
          <span></span>` : ''}
        </div>
      </div>`;

    box.querySelectorAll('input[data-i]').forEach((el) => {
      el.oninput = () => {
        ledItems[+el.dataset.i][el.dataset.f] = el.value;
        // Repaint only the derived figures, never the whole list: rebuilding
        // the DOM under her cursor loses the caret mid-number.
        const i = +el.dataset.i;
        const line = box.querySelector(`[data-item="${i}"]`);
        const { wt, amt, hasTicket } = lineOf(ledItems[i]);
        const net = line.querySelector(`.ledItemNet[data-i="${i}"]`);
        if (net) net.textContent = wt === null ? '—' : money0(wt);
        const mt = line.querySelector(`.ledItemMt[data-i="${i}"]`);
        if (mt) mt.textContent = wt === null ? '—'
            : (Math.round((wt / 2204.62) * 1000) / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 });
        const amtCell = line.querySelector('.ledItemAmt');
        if (amtCell) amtCell.textContent = money0(amt);
        const foot = line.querySelector('.ledTicketNet');
        if (foot) foot.textContent = wt === null ? '—' : money0(wt);
        // Typing the first ticket figure turns the net cell from an input
        // into a derived one, which is a structural change rather than a
        // text one — repaint, and put the caret back where she left it.
        if (hasTicket && !net) { const at = el.dataset.f; paintItems();
          const again = box.querySelector(`input[data-i="${i}"][data-f="${at}"]`);
          if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); } }
        queueSave();
      };
    });
    box.querySelectorAll('.ledItemTicket').forEach((b) => {
      b.onclick = () => {
        const t = box.querySelector(`.ledTicket[data-i="${b.dataset.i}"]`);
        t.style.display = t.style.display === 'none' ? 'flex' : 'none';
      };
    });
    box.querySelectorAll('.ledItemDel').forEach((b) => {
      b.onclick = () => {
        // The last line is CLEARED, not removed. With "Item description" and
        // "Container weighing" gone from the bill form, a bill with no lines
        // has nowhere left to hold a description or a weight — so the × on the
        // final row empties it rather than leaving the form with nothing in it.
        if (ledItems.length === 1) ledItems[0] = {};
        else ledItems.splice(+b.dataset.i, 1);
        paintItems(); queueSave();
      };
    });
    const add = $('ledItemAdd');
    if (add) add.onclick = () => { ledItems.push({}); paintItems(); };
  }
  paintItems();

  const close = () => {
    const m = $('ledgerModal');
    if (m) m.remove();
    if (onEscape) document.removeEventListener('keydown', onEscape);
    // Autosave may have created the row while she typed, so the table behind
    // has to catch up whichever way she leaves.
    if (savedId || editing) renderLedgerTab(kind);
  };
  const onEscape = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onEscape);
  $('ledClose').onclick = close;
  // The bill/sales form autosaves, so reopening it loses nothing typed.
  ledgerReopen = () => { close(); openLedgerForm(kind, existing, seed); };
  $('ledCancel').onclick = close;

  const readForm = () => {
    const body = {};
    new FormData($('ledgerForm')).forEach((v, k) => { if (String(v).trim() !== '') body[k] = v; });
    // A list cannot travel in FormData, so the two that are lists are added
    // here. Sent even when EMPTY, deliberately: clearing the last line has to
    // reach the server, and an omitted key is "leave it alone" everywhere else
    // in this form.
    const items = ledItems.filter((i) => String(i.description || '').trim()
      || i.weight || i.price || i.gross);
    if (items.length || (existing && (existing.items || []).length)) body.items = items;
    // trucking_split is NOT sent from here any more. It is edited under
    // Trucking, and a form that resends its own stale copy on every autosave
    // would quietly overwrite an edit made there thirty seconds earlier.
    return body;
  };

  // ── THE RUNNING TOTAL, COMPUTED WHERE IT IS ALWAYS COMPUTED ──────────
  // Asks /api/{kind}/preview rather than doing the sums here. Debounced so
  // typing a five-digit weight is one call, not five.
  // ── AUTOSAVE ─────────────────────────────────────────────────────────
  // Apsara, 2026-09-10: "if i start adding atleast one value in bill,it
  // should get autosaved and a entry to be put in edege metals excel under
  // shipments tab.On every modification,that row needs to e updated."
  //
  // The FIRST value POSTs and creates the row; everything after PUTs to that
  // same id, which is what makes the sheet row update rather than multiply —
  // helpers/shipmentSheetLog keys its upsert on the bill id.
  //
  // Debounced, and not only to spare the server: saving mid-word would put a
  // half-typed supplier name in front of her in the table behind. The state
  // is SHOWN in the header, because a thing that saves silently is a thing
  // she cannot trust to have saved.
  let savedId = editing ? existing.id : null;
  let saveTimer = null;
  let saving = false;
  const AUTOSAVE_MS = 1200;

  const setState = (t, colour) => {
    const el = $('ledSaveState');
    if (el) { el.textContent = t; el.style.color = colour || 'var(--text-faint)'; }
  };

  const autosave = async () => {
    if (saving) return;
    const body = readForm();
    // "at least one value" — her threshold. Opening the form and closing it
    // again must not leave a row behind.
    const anything = Object.values(body).some((v) => String(v || '').trim() !== '');
    if (!anything) return;
    if (savedId) new FormData($('ledgerForm')).forEach((v, k) => { if (!(k in body)) body[k] = ''; });
    saving = true;
    setState('Saving…');
    try {
      const r = savedId
        ? await api(`${K.path}/${encodeURIComponent(savedId)}`, { method: 'PUT', body: JSON.stringify(body) })
        : await api(K.path, { method: 'POST', body: JSON.stringify(body) });
      const rec = r[K.itemKey];
      if (rec && rec.id) savedId = rec.id;
      // What is still missing is named, not just "saved" — a bill with no
      // supplier is saved AND unfinished, and both are worth knowing.
      const miss = (rec && rec.incomplete) || [];
      setState(miss.length ? `Saved · still needs ${miss.join(' and ')}` : 'Saved',
               miss.length ? 'var(--status-warn)' : 'var(--text-faint)');
    } catch (e) {
      setState('Not saved — ' + (e.message || 'try again'), 'var(--status-danger)');
    } finally { saving = false; }
  };

  let previewTimer = null;
  const paintPreview = async () => {
    try {
      const r = await api(`${K.path}/preview`, { method: 'POST', body: JSON.stringify(readForm()) });
      const cells = K.cards.map(([label, key, how]) => {
        const v = r[key];
        const shown = how === 'money' ? ledMoney(v) : ledNum(v);
        return `<div>
          <div style="font-size:11px; color:${LEDGER_LIGHT.inkFaint};">${label}</div>
          <!-- ── BLACK ON BLACK ────────────────────────────────────────
               Apsara, 2026-09-11: "why tare,net weights aew empty at the
               end." They were never empty. compute() returns all five and
               always did; they were being drawn in HARD-CODED #14181B, which
               is this theme's own sunken tone — the exact colour of the surface
               behind them. Only Balance was legible, because it takes L.ok
               and is green.
               In the paper palette #14181B is near-black on white and reads
               perfectly, which is why it survived: the bug only exists in the
               theme she actually uses. Same reason the L.danger quoting
               slip got through in September. Tokens, never hexes. -->
          <div style="font-size:17px; font-weight:500; margin-top:2px; font-family:var(--font-mono); color:${v === null || v === undefined ? L.inkFaint : (key === 'balance' ? L.ok : L.ink)};">${shown}</div>
        </div>`;
      });
      $('ledPreview').innerHTML = cells.join('');

      // ── THE PRICE UNIT GOES IN THE PRICE FIELD ─────────────────────────
      // It used to be a sixth figure in the totals row, which is the wrong
      // place: the unit is a property of the price she typed, and showing it
      // beside the price is what makes a wrong one obvious as she types.
      const pu = $('ledPriceUnit');
      if (pu) pu.textContent = r.price_unit === 'lb' ? '/lb' : r.price_unit === 'mt' ? '/MT' : '';

      const warn = [];
      if (r.missing_tares && r.missing_tares.length) {
        warn.push(`No weight for ${esc(r.missing_tares.join(' or '))} — net computed without ${r.missing_tares.length === 1 ? 'it' : 'them'}.`);
      }
      if (r.amount_differs !== null && r.amount_differs !== undefined) {
        warn.push(`Your figure is ${ledMoney(r.amount_differs)} off the ${ledMoney(r.computed_amount)} the weight and price give.`);
      }
      const wEl = $('ledWarn');
      if (wEl) wEl.textContent = warn.join(' ');
    } catch (e) { /* a preview that fails must never block the form */ }
  };
  // Typing anywhere in the form bubbles to here. REMOVING a line does not —
  // a click fires no input event — so the item and split editors call this
  // directly. A declaration rather than a const so it is in scope for the
  // handlers those editors wired earlier in this function.
  function queueSave() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(paintPreview, 220);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(autosave, AUTOSAVE_MS);
  }
  $('ledgerForm').addEventListener('input', queueSave);
  paintPreview();

  if (kind === 'bills' && !editing) {
    const fillFrom = (prefillObj, label) => {
      let filled = 0;
      Object.entries(prefillObj || {}).forEach(([k, v]) => {
        const el = document.querySelector(`#ledgerForm [name="${k}"]`);
        if (el && v !== null && v !== undefined && v !== '') { el.value = v; filled += 1; }
      });
      // SAID, not silent. Filling six fields without saying so is six fields
      // she will not think to check.
      $('ledPrefillNote').textContent = filled
        ? `Filled ${filled} field${filled === 1 ? '' : 's'} from ${label} — check them before saving.`
        : `${label} had nothing to fill in.`;
      paintPreview();
    };

    $('ledPrefillGo').onclick = async () => {
      const bkg = ($('ledPrefillBkg').value || '').trim();
      if (!bkg) return;
      $('ledPrefillPick').innerHTML = '';
      try {
        const r = await api(`/api/bills/from-booking/${encodeURIComponent(bkg)}`);
        const boxes = Array.isArray(r.containers) ? r.containers : [];
        if (boxes.length > 1) {
          // Her case, in her words. Nothing is filled until she picks WHICH
          // container, because the container number is the one field that
          // differs between two bills off the same booking.
          $('ledPrefillPick').innerHTML = boxes.map((c) => `
            <button type="button" class="btn btn-secondary led-box" data-seq="${esc(c.seq)}" style="font-size:11px; padding:6px 11px; background:${LEDGER_LIGHT.sunken}; color:${LEDGER_LIGHT.ink}; border-color:${LEDGER_LIGHT.line};">
              ${esc(c.container_number || `Container ${c.seq}`)}${c.size ? ` · ${esc(c.size)}` : ''}${c.supplier ? ` · ${esc(c.supplier)}` : ''}
            </button>`).join('');
          $('ledPrefillNote').textContent = `${boxes.length} containers on ${bkg} — pick the one this bill is for.`;
          document.querySelectorAll('.led-box').forEach((b) => {
            b.onclick = async () => {
              const rr = await api(`/api/bills/from-booking/${encodeURIComponent(bkg)}?container=${encodeURIComponent(b.dataset.seq)}`);
              fillFrom(rr.prefill, `${bkg} container ${b.dataset.seq}`);
            };
          });
          return;
        }
        fillFrom(r.prefill, bkg);
      } catch (e) { $('ledPrefillNote').textContent = e.message || 'Could not read that booking'; }
    };
  }

  $('ledSave').onclick = async () => {
    $('ledErr').textContent = '';
    try {
      // ── AN EDIT SENDS EVERY FIELD, INCLUDING THE EMPTIED ONES ────────
      // readForm() drops blanks, which is right for a new row and WRONG for
      // an edit: clearing a seal number would send nothing for it, and the
      // server PATCHes, so the old value would survive. She would clear a
      // field, save, and watch it come back.
      //
      // So on edit every input is sent, empty string included, and the store
      // records the clearing.
      const body = readForm();
      if (editing) {
        new FormData($('ledgerForm')).forEach((v, k) => { if (!(k in body)) body[k] = ''; });
      }
      // Autosave has usually written it already; this is the explicit flush
      // so "Save" always means the same thing whether she paused or not.
      clearTimeout(saveTimer);
      await api(savedId ? `${K.path}/${encodeURIComponent(savedId)}` : K.path,
                { method: savedId ? 'PUT' : 'POST', body: JSON.stringify(body) });
      close();
    } catch (e) { $('ledErr').textContent = e.message || 'Could not save it'; }
  };
}

async function renderTruckerTab() {
  // Wire on first visit — see wireTruckerModals for why not at boot.
  wireTruckerModals();
  const data = await api('/api/trucker-bills');
  truckerBills = Array.isArray(data.bills) ? data.bills : [];
  truckerModes = Array.isArray(data.modes) && data.modes.length ? data.modes : truckerModes;
  // The bank list rides along on this payload and on /api/payments. Whichever
  // tab she opens first fills it; both write the same three variables, so the
  // Pay form on a load and the Pay form on a trucker bill can never offer
  // different banks.
  if (Array.isArray(data.banks) && data.banks.length) bankOptions = data.banks;
  if (Array.isArray(data.bank_modes) && data.bank_modes.length) bankModes = data.bank_modes;
  if (typeof data.other === 'string' && data.other) bankOther = data.other;
  const rep = data.report || { billed: 0, paid: 0, outstanding: 0, overpaid: 0, count: 0 };

  $('viewRoot').innerHTML = `
    <div style="max-width:1120px; margin:0 auto; padding:34px 40px 80px;">
      ${pageHead('Trucker bills', {
        note: 'What the yard owes its hauliers, and what has been paid against each.',
        stats: [['billed', payMoney(rep.billed)], ['paid', payMoney(rep.paid)], ['outstanding', payMoney(rep.outstanding)]],
        actions: '<button id="btnAddTruckerBill" class="btn btn-primary" style="font-size:12px; padding:8px 14px;">+ Add bill</button>',
      })}

      ${rep.overpaid > 0 ? `
      <!-- Shown ONLY when it is non-zero, and never netted against
           outstanding. Money paid beyond what was billed is something to ring
           the hauler about, not a credit to quietly subtract — see
           billsReport in helpers/truckerBills.js. -->
      <div class="card" style="padding:10px 12px; margin-bottom:14px; border-color:var(--status-warn);">
        <span style="font-family:var(--font-mono); font-size:11px; color:var(--status-warn);">
          ${payMoney(rep.overpaid)} paid beyond what was billed — chase it back.
        </span>
      </div>` : ''}

      <div class="card" style="overflow:hidden;">
        <table id="trkBillsTable" class="stack-table" style="width:100%; border-collapse:collapse; font-size:12.5px; min-width:560px;">
          <thead>
            <tr style="background:var(--surface-sunken); color:var(--text-muted); font-family:var(--font-mono); font-size:9.5px; letter-spacing:.12em; text-transform:uppercase;">
              <th style="padding:9px 12px; text-align:left;">Company</th>
              <th style="padding:9px 12px; text-align:left;">Date</th>
              <th style="padding:9px 12px; text-align:left;">Ticket</th>
              <th style="padding:9px 12px; text-align:right;">Amount</th>
              <th style="padding:9px 12px; text-align:left;">Status</th>
              <th style="padding:9px 12px; text-align:right;">Actions</th>
            </tr>
          </thead>
          <tbody>
          ${truckerBills.length ? truckerBills.map(b => `
            <tr style="border-bottom:1px solid var(--border-subtle);">
              <td class="st-head" style="padding:9px 12px; font-weight:600; color:var(--text-strong);">${esc(b.company)}</td>
              <td data-label="Date" style="padding:9px 12px; font-family:var(--font-mono); color:var(--text-muted);">${esc(fmtDate(b.date))}</td>
              <td data-label="Ticket" style="padding:9px 12px; font-family:var(--font-mono); color:var(--text-muted);">${b.load_ticket ? esc(b.load_ticket) : '—'}</td>
              <td data-label="Amount" style="padding:9px 12px; text-align:right; font-family:var(--font-mono);">${payMoney(b.amount)}</td>
              <td data-label="Status" style="padding:9px 12px;">${truckerBadge(b)}</td>
              <td data-label="Actions" style="padding:9px 12px; text-align:right;">
                <div style="display:flex; gap:5px; justify-content:flex-end; flex-wrap:wrap;">
                  <button class="btn btn-secondary btn-edit-trk" data-id="${esc(b.id)}" style="padding:5px 10px; font-size:10.5px;">Edit</button>
                  ${truckerBillIsPayable(b) ? `<button class="btn btn-pay-trk" data-id="${esc(b.id)}" style="padding:5px 10px; font-size:10.5px;">Pay</button>` : ''}
                  ${truckerBillIsDeletable(b) ? `<button class="btn btn-danger btn-del-trk" data-id="${esc(b.id)}" style="padding:5px 10px; font-size:10.5px;">Delete</button>` : ''}
                </div>
              </td>
            </tr>`).join('')
          : `<tr><td colspan="6" style="padding:34px; text-align:center; color:var(--text-faint); font-family:var(--font-mono); font-size:12px;">No trucker bills yet.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>`;

  $('btnAddTruckerBill').addEventListener('click', () => openTruckerBillModal(null));
  document.querySelectorAll('.btn-edit-trk').forEach(btn => btn.addEventListener('click', () =>
    openTruckerBillModal(truckerBills.find(b => b.id === btn.dataset.id) || null)));
  document.querySelectorAll('.btn-pay-trk').forEach(btn => btn.addEventListener('click', () =>
    openTruckerPayModal(truckerBills.find(b => b.id === btn.dataset.id) || null)));
  document.querySelectorAll('.btn-del-trk').forEach(btn => btn.addEventListener('click', async () => {
    const b = truckerBills.find(x => x.id === btn.dataset.id);
    if (!b) return;
    if (!confirm(`Are you sure you want to delete the ${b.company} bill for ${payMoney(b.amount)}?`)) return;
    // The paid case only ever reaches a Jarvis session — everyone else is not
    // shown the button, and the server returns 409 regardless. Same second
    // prompt as a paid load, for the same reason: this erases the record that
    // money moved.
    const paid = b.payment && Number(b.payment.paid);
    if (paid > 0 && !confirm(
      `${b.company} has ${payMoney(paid)} recorded as paid against this bill.\n\n`
      + `Deleting it removes those payment records too.\n\n`
      + `This is logged against the Jarvis profile. Continue?`)) return;
    try {
      await api(`/api/trucker-bills/${encodeURIComponent(b.id)}`, { method: 'DELETE' });
      await renderTruckerTab();
    } catch (err) {
      // The server's own words. BILL_HAS_PAYMENTS carries a sentence that
      // already explains the way out, so restating it here would only give
      // the operator a second, worse version of the same message.
      alert(err.message);
    }
  }));
}

function openTruckerBillModal(b) {
  editingTruckerBillId = b ? b.id : null;
  $('trkTitle').textContent = b ? `Edit ${b.id}` : 'Add trucker bill';
  $('trk_date').value = toUsDate(b ? (b.date || '') : todayLocalDateStr());
  wireUsDateField('trk_date');
  $('trk_company').value = b ? (b.company || '') : '';
  $('trk_ticket').value = b ? (b.load_ticket || '') : '';
  $('trk_amount').value = b ? (b.amount ?? '') : '';
  $('trkErr').textContent = '';
  $('truckerModal').classList.remove('hidden');
  $('truckerModal').style.display = 'flex';
}
function closeTruckerBillModal() {
  $('truckerModal').classList.add('hidden');
  $('truckerModal').style.display = '';
  editingTruckerBillId = null;
}

function openTruckerPayModal(b) {
  if (!b) return;
  payingTruckerBill = b;
  const pending = (b.payment && Number(b.payment.pending)) || b.amount;
  $('trkPayTitle').textContent = `Pay ${b.company}`;
  $('trkPaySub').textContent = `${b.id} · ${payMoney(b.amount)} billed · ${payMoney((b.payment && b.payment.paid) || 0)} paid`;
  // Built from the SERVER's list, so the dropdown cannot offer something the
  // server would reject — and the server refuses Cash on this ledger whatever
  // the dropdown says.
  $('trk_pay_mode').innerHTML = truckerModes.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  paintBankOptions($('trk_pay_bank'));
  if ($('trk_pay_bank_other')) $('trk_pay_bank_other').value = '';
  syncBankFields('trk_pay');
  // Pre-filled with what is still outstanding, rounded here rather than left
  // as a float — 1000 - 333.33 - 333.33 is 333.34000000000003, and a Pay box
  // that opens showing that is a Pay box nobody trusts.
  $('trk_pay_amount').value = pending > 0 ? Math.round(pending * 100) / 100 : '';
  $('trk_pay_date').value = toUsDate(todayLocalDateStr());
  wireUsDateField('trk_pay_date');
  $('trkPayErr').textContent = '';
  $('truckerPayModal').classList.remove('hidden');
  $('truckerPayModal').style.display = 'flex';
}
function closeTruckerPayModal() {
  $('truckerPayModal').classList.add('hidden');
  $('truckerPayModal').style.display = '';
  payingTruckerBill = null;
}

let truckerModalsWired = false;
function wireTruckerModals() {
  // ── LAZY, IDEMPOTENT, AND NULL-SAFE ───────────────────────────────────
  // Called from renderTruckerTab rather than at boot. On the website boot()
  // runs from an inline script partway down the document while these modals
  // are markup at the very END of it, so at boot time the elements do not
  // exist — wiring there threw and took renderNav() and loadTab() down with
  // it, leaving a signed-in page with an empty sidebar and an empty body.
  //
  // Idempotent because it now runs on every visit to the tab, and binding a
  // second listener to the same Save button would record every bill twice.
  //
  // Null-safe because a missing element must never again cost the whole
  // page. If the markup is not there, the tab renders and its buttons do
  // nothing — bad, but visibly bad, and only here.
  if (truckerModalsWired) return;
  const need = ['trkClose', 'trkSave', 'trkPayClose', 'trkPaySave'];
  if (need.some((id) => !$(id))) {
    console.warn('[TRUCKER] modal markup missing — buttons will not respond:',
                 need.filter((id) => !$(id)).join(', '));
    return;
  }
  truckerModalsWired = true;
  $('trkClose').addEventListener('click', closeTruckerBillModal);
  $('trk_pay_mode').addEventListener('change', () => syncBankFields('trk_pay'));
  $('trk_pay_bank').addEventListener('change', () => syncBankFields('trk_pay'));
  $('trkSave').addEventListener('click', async () => {
    const payload = {
      date: toIsoDate($('trk_date').value),
      company: $('trk_company').value.trim(),
      load_ticket: $('trk_ticket').value.trim() || null,
      amount: $('trk_amount').value,
    };
    const btn = $('trkSave');
    btn.disabled = true; btn.textContent = 'Saving…';
    $('trkErr').textContent = '';
    try {
      await (editingTruckerBillId
        ? api(`/api/trucker-bills/${encodeURIComponent(editingTruckerBillId)}`, { method: 'PUT', body: JSON.stringify(payload) })
        : api('/api/trucker-bills', { method: 'POST', body: JSON.stringify(payload) }));
      closeTruckerBillModal();
      await renderTruckerTab();
    } catch (err) {
      $('trkErr').textContent = String(err.message || '').replace(/^Validation:\s*/, '');
    } finally {
      btn.disabled = false; btn.textContent = 'Save bill';
    }
  });

  $('trkPayClose').addEventListener('click', closeTruckerPayModal);
  $('trkPaySave').addEventListener('click', async () => {
    if (!payingTruckerBill) return;
    const btn = $('trkPaySave');
    btn.disabled = true; btn.textContent = 'Recording…';
    $('trkPayErr').textContent = '';
    try {
      await api('/api/payments', {
        method: 'POST',
        body: JSON.stringify({
          load_id: payingTruckerBill.id,
          // The field the whole report split hangs off. Without it the payment
          // is stored as a purchase and the haulage disappears into what the
          // yard paid for metal — see helpers/payments.js.
          load_kind: 'trucker',
          mode: $('trk_pay_mode').value,
          bank: bankValue('trk_pay'),
          amount: $('trk_pay_amount').value,
          paid_on: toIsoDate($('trk_pay_date').value),
        }),
      });
      closeTruckerPayModal();
      await renderTruckerTab();
    } catch (err) {
      $('trkPayErr').textContent = err.message;
    } finally {
      btn.disabled = false; btn.textContent = 'Record payment';
    }
  });
}


// ── THE BORROWING TAB ─────────────────────────────────────────────────────
// Apsara, 2026-09-21: "Keep this borrowing tracking in petty cash as a tab
// inside petty cash."
//
// Two halves. What is still owed, which is the question, and every movement
// behind it, which is the answer to "why". A figure with no rows under it is
// the thing this whole ledger was built not to have.
function pettyBorrowingHtml(isAdmin) {
  const owed = pettyCash.borrowings || [];
  const moves = pettyCash.transfers || [];
  const held = (src) => Number((pettyCash.by_source || {})[src]) || 0;

  const owedHtml = owed.length ? owed.map((b) => {
    // Shown, but the button is disabled when the bucket cannot cover it —
    // pressing it would be refused by the server anyway, and a button that
    // always fails teaches people to ignore the whole screen. The reason is
    // printed beside it rather than hidden in an alert.
    const can = held(b.owes) >= b.amount - 0.005;
    return `
    <div class="card" style="padding:14px 16px; margin-bottom:10px; display:flex; align-items:center; gap:14px; flex-wrap:wrap;">
      <div style="flex:1; min-width:220px;">
        <div style="font-size:13px;"><strong style="color:var(--text-strong);">${esc(b.owes)}</strong> owes <strong style="color:var(--text-strong);">${esc(b.to)}</strong></div>
        <!-- ── A LOAN BETWEEN TWO COMPANIES IS NOT THE SAME THING ──────
             Apsara, 2026-09-21, asked whether borrowing should cross the
             line between Edge Metals and AAA Investment, of three offered:
             "Allow it, record it as owed". So it is allowed and it is not
             refused — but it is said out loud. Chase owing BofA is her own
             money moving between her own pots; Edge Metals owing AAA
             Investment is a balance between two companies that somebody
             settles on paper, and it should never look like the first one.
             The flag is computed by helpers/pettyCash.borrowings, not stored,
             so renaming a bucket cannot leave a stale claim here. -->
        ${b.intercompany ? `<div style="margin-top:5px; font-size:11.5px; color:var(--status-warning, #d69e2e);">Intercompany — ${esc(b.owes_company)} owes ${esc(b.to_company)}.</div>` : ''}
        <div style="font-family:var(--font-mono); font-size:11px; color:var(--text-muted); margin-top:3px;">${esc(b.owes)} currently holds ${esc(fmtAmount(held(b.owes)))}</div>
      </div>
      <div style="font-family:var(--font-mono); font-size:16px; font-weight:700; color:var(--text-strong);">${esc(fmtAmount(b.amount))}</div>
      ${isAdmin ? `<button class="btn ${can ? 'btn-primary' : ''} btn-repay" data-owes="${esc(b.owes)}" data-to="${esc(b.to)}" data-amount="${esc(String(b.amount))}"
        ${can ? '' : 'disabled title="not enough in that bucket to repay from"'} style="font-size:12px; padding:6px 14px;">Repay</button>` : ''}
      ${can ? '' : `<div style="flex-basis:100%; font-size:11.5px; color:var(--status-warning, #d69e2e);">Add cash to ${esc(b.owes)} first — you cannot repay from a bucket that is empty.</div>`}
    </div>`;
  }).join('') : `<div class="card" style="padding:18px; font-size:12.5px; color:var(--text-muted);">Nothing owed between accounts.</div>`;

  const label = { borrow: 'borrowed', repay: 'repaid', reassign: 'moved' };
  const movesHtml = moves.length ? `
    <div class="card" style="padding:0; overflow:hidden;">
      <table class="stack-table" style="width:100%; border-collapse:collapse; font-size:13px;">
        <thead><tr style="background:var(--surface-sunken); text-align:left;">
          <th style="padding:10px 12px; font-family:var(--font-mono); font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted);">Date</th>
          <th style="padding:10px 12px; font-family:var(--font-mono); font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted);">What moved</th>
          <th style="padding:10px 12px; text-align:right; font-family:var(--font-mono); font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted);">Amount</th>
        </tr></thead>
        <tbody>
          ${moves.map((m) => `
          <tr style="border-top:1px solid var(--border-subtle);">
            <td data-label="Date" style="padding:10px 12px; font-family:var(--font-mono); color:var(--text-muted);">${esc(typeof fmtDate === 'function' ? fmtDate(m.date) : (m.date || ''))}</td>
            <td class="st-head" style="padding:10px 12px;">${esc(m.to)} ${esc(label[m.reason] || m.reason || 'moved')} from ${esc(m.from)}
              ${m.note ? `<div style="font-size:11px; color:var(--text-faint);">${esc(m.note)}</div>` : ''}</td>
            <td data-label="Amount" style="padding:10px 12px; text-align:right; font-family:var(--font-mono); font-weight:700;">${esc(fmtAmount(m.amount))}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : `<div style="padding:40px; text-align:center; color:var(--text-faint); font-family:var(--font-mono); font-size:12px;">No cash has moved between accounts yet.</div>`;

  return `
    <div style="font-family:var(--font-mono); font-size:10px; font-weight:600; letter-spacing:.16em; text-transform:uppercase; color:var(--text-muted); margin-bottom:10px;">Outstanding</div>
    ${owedHtml}
    ${isAdmin ? `<div style="margin:22px 0 10px; display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
      <div style="font-family:var(--font-mono); font-size:10px; font-weight:600; letter-spacing:.16em; text-transform:uppercase; color:var(--text-muted);">Every movement</div>
      <span style="flex:1;"></span>
      <!-- Her "give them an option to add from which bank later". A dated
           move, never an edit of the old rows — see helpers/pettyCash.js. -->
      <button id="btnSplitCash" class="btn" style="font-size:12px; padding:6px 14px;">Split Edge Metals / AAA</button>
      <button id="btnReassignCash" class="btn" style="font-size:12px; padding:6px 14px;">Move cash between accounts</button>
    </div>` : `<div style="font-family:var(--font-mono); font-size:10px; font-weight:600; letter-spacing:.16em; text-transform:uppercase; color:var(--text-muted); margin:22px 0 10px;">Every movement</div>`}
    ${movesHtml}`;
}

// Repay and reassign are the same server call with a different reason, so they
// share one function. The server is what refuses an impossible move; this only
// asks and reports.
async function movePettyCash({ from, to, amount, reason }) {
  try {
    await api('/api/petty-cash/transfer', { method: 'POST', body: JSON.stringify({ from, to, amount, reason }) });
    await renderPettyCashTab();
  } catch (err) {
    alert(err.message || 'Could not move the cash.');
  }
}

// ── SWITCHING TABS ASKS THE SERVER NOTHING ────────────────────────────────
// Apsara, 2026-09-22: "when i click cash and borrowing,it takes lot of time
// to open."
//
// Every click went through refreshPettyCash() — a GET of /api/petty-cash,
// which is 35 KB and, measured against a year of her rows, 18 ms of server
// work at 1,200 entries and 49 ms at 6,000. None of that is the problem. The
// problem is that it is a ROUND TRIP, and she is on a phone: the wait she
// sees is the network, and she pays it to redraw a screen from data the
// browser is already holding. Cash and Borrowing render from the SAME
// pettyCash object; neither needs a byte the other did not already fetch.
//
// `refresh` defaults to TRUE, so every existing caller behaves exactly as it
// did — add cash, repay, split, delete and the first open all still re-read
// the server, because each of those has just changed the money. Only the tab
// buttons pass false, and only because switching tabs changes nothing. A
// caller that forgets the flag gets today's behaviour: slower, never stale.
async function renderPettyCashTab({ refresh = true } = {}) {
  if (refresh) await refreshPettyCash();
  const isAdmin = ROLE === 'admin';
  const bal = pettyCash.balance;
  const rows = pettyCash.entries || [];

  // 'receipt' — cash taken IN for a yard sale, added 2026-09-16. Named as
  // money RECEIVED rather than folded into "Cash added": a top-up is her own
  // float going in, a receipt is a customer paying for metal, and a row that
  // cannot tell her which is which makes the day's takings unreadable.
  const kindLabel = (e) => e.kind === 'topup' ? 'Cash added'
    : e.kind === 'receipt' ? `Received${e.load_id ? ' — ' + e.load_id : ''}`
    : e.kind === 'reversal' ? 'Reversed'
    : `Paid${e.load_id ? ' — ' + e.load_id : ''}`;

  $('viewRoot').innerHTML = `
    <section style="max-width:900px; margin:0 auto; padding:28px 20px 80px;">
      ${pageHead('Petty cash', {
        note: isAdmin ? 'Cash paid against a load comes out of this balance.' : 'Read only — ask an admin to add cash.',
        // ── CASH IN HAND FIRST, THEN EACH BANK ───────────────────────────
        // Apsara, 2026-09-21: "show overall cash .but also keep track of
        // bofacash available and chase bank." The overall figure keeps its
        // place and its prominence — it is the number she has been reading
        // for weeks — and the buckets are added beside it. They always add
        // up to it, because every one of them is a sum of the same rows.
        //
        // ── AND THEN BY COMPANY, BECAUSE BofA IS NOW TWO ─────────────────
        // Apsara, 2026-09-21: BofA holds Edge Metals' cash and AAA
        // Investment's, and AAA Investment is "a third company". Her answer
        // on what the headline should be, of three offered: "Keep one total,
        // break it down below." So cash in hand is untouched — it is still
        // every row — and what sits beside it is now WHOSE, not which bank.
        // The per-bucket figures she asked for on 20-Sep move down one line
        // rather than disappearing; there are five buckets now and six stats
        // across the top is a row nobody reads.
        //
        // A company with nothing in it is not printed. A heading reading
        // "AAA Investment $0.00" before any of its cash exists invites the
        // question of where it went.
        //
        // ── AND NOT WHEN IT ONLY REPEATS THE TOTAL ───────────────────────
        // Apsara, 2026-09-22, on the built app: "it looks ugly". With every
        // row still unbanked this printed "COMPANY NOT STATED $22,441.03"
        // immediately under "CASH IN HAND $22,441.03" — the same number
        // twice, the second time under a label that is an apology. A company
        // figure earns its place only when it DIVIDES the total, so it is
        // printed only alongside at least one other company that has money.
        stats: [['cash in hand', esc(fmtAmount(bal))]].concat((() => {
          const withMoney = Object.entries(pettyCash.by_company || {})
            .filter(([, amt]) => Math.abs(Number(amt) || 0) > 0.005);
          if (withMoney.length < 2) return [];
          return withMoney.map(([co, amt]) => [co.toLowerCase(), esc(fmtAmount(Number(amt) || 0))]);
        })()),
        chips: [isAdmin ? null : 'read only'],
        actions: isAdmin ? '<button id="btnAddPetty" class="btn btn-primary">+ Add cash</button>' : '',
      })}
      <!-- Her words: "Keep this borrowing tracking in petty cash as a tab
           inside petty cash." Two sub-tabs, same pattern as Bills. -->
      <div style="display:flex; gap:6px; margin-bottom:16px;">
        <button class="btn petty-tab" data-petty-tab="cash" style="font-size:12px; padding:6px 14px;${pettyTab === 'cash' ? ' background:var(--surface-raised); color:var(--text-strong);' : ''}">Cash</button>
        <button class="btn petty-tab" data-petty-tab="borrowing" style="font-size:12px; padding:6px 14px;${pettyTab === 'borrowing' ? ' background:var(--surface-raised); color:var(--text-strong);' : ''}">Borrowing${(pettyCash.borrowings || []).length ? ` (${(pettyCash.borrowings || []).length})` : ''}</button>
      </div>
      ${pettyTab === 'borrowing' ? pettyBorrowingHtml(isAdmin) : `
      <!-- ── EACH ACCOUNT, GROUPED UNDER ITS BANK ───────────────────────
           Apsara, 20-Sep: "keep track of bofa cash available and chase bank."
           Still answered, one line down. And 21-Sep, on what BofA now holds:
           "Under BofA. 1.Edge Metals 2.AAA Investment" — a bank with accounts
           under it. The first version of this put the bank inside the name,
           as 'BofA/Edge Metals', and she rejected it. The hierarchy is drawn
           here instead, where she described it.

           Every account is listed even at zero: THIS is the list she
           reassigns into, and a destination that hides while empty cannot be
           chosen. Plain BofA is labelled for what it is rather than left to
           look like a third account she opened. -->
      <div class="card" style="padding:12px 14px; margin-bottom:18px; display:flex; flex-wrap:wrap; gap:16px 28px;">
        ${(() => {
          const srcs = pettyCash.sources || [];
          const bankOf = pettyCash.bank_of || {};
          const banks = [];
          for (const s of srcs) {
            const b = bankOf[s] || null;
            let g = banks.find((x) => x.bank === b);
            if (!g) { g = { bank: b, items: [] }; banks.push(g); }
            g.items.push(s);
          }
          const cell = (src) => {
            // ── THERE IS NO "not yet split" ANY MORE ─────────────────────
            // There was, for one account: plain 'BofA', the pre-split bucket.
            // The rule read `name === its own bank`, which is true of Chase
            // Bank too, so the phone announced "Chase Bank / NOT YET SPLIT".
            //
            // Apsara then had the old BofA cash migrated into Edge Metals
            // (2026-09-22, "for previous cash"), so no account is named after
            // its bank any longer and the label is simply the name. The whole
            // special case is deleted rather than left standing unreachable —
            // tests/petty-cash-banks.js asserts the condition that made it
            // possible cannot come back.
            const label = src;
            // The company sub-label is dropped: every account is named for
            // its company, so it printed the same words twice.
            return `<div style="flex:1 1 0; min-width:0;">
              <div style="font-family:var(--font-mono); font-size:10px; letter-spacing:.09em; text-transform:uppercase; color:var(--text-muted);">${esc(label)}</div>
              <div style="font-size:13px; color:var(--text-strong);">${esc(fmtAmount(Number((pettyCash.by_source || {})[src]) || 0))}</div>
            </div>`;
          };
          // A bank heading above a single account says the account's own name
          // twice — "No bank behind it" sat directly above "Unassigned".
          return banks.map((g) => (g.items.length < 2
            ? `<div style="min-width:132px;">${cell(g.items[0])}</div>`
            : `<div style="min-width:280px;">
              <div style="font-size:11.5px; font-weight:700; color:var(--text-strong); margin-bottom:6px;">${esc(g.bank)}</div>
              <div style="display:flex; gap:16px; align-items:flex-start;">${g.items.map(cell).join('')}</div>
            </div>`)).join('');
        })()}
      </div>
      ${bal <= 0 ? `<div class="card" style="padding:12px 16px; margin-bottom:18px; font-size:12.5px; color:var(--status-warning, #d69e2e);">Cash payments are refused while this is empty. Add cash before paying a load in cash.</div>` : ''}

      ${rows.length ? `
      <div class="card" style="padding:0; overflow:hidden;">
        <table class="stack-table" style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead><tr style="background:var(--surface-sunken); text-align:left;">
            <th style="padding:10px 12px; font-family:var(--font-mono); font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted);">Date</th>
            <th style="padding:10px 12px; font-family:var(--font-mono); font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted);">What</th>
            <th style="padding:10px 12px; text-align:right; font-family:var(--font-mono); font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted);">Amount</th>
            ${isAdmin ? '<th style="padding:10px 12px;"></th>' : ''}
          </tr></thead>
          <tbody>
            ${rows.map(e => `
            <tr style="border-top:1px solid var(--border-subtle);">
              <td data-label="Date" style="padding:10px 12px; font-family:var(--font-mono); color:var(--text-muted);">${esc(typeof fmtDate === 'function' ? fmtDate(e.date) : (e.date || ''))}</td>
              <td class="st-head" style="padding:10px 12px;">${esc(kindLabel(e))}${e.note ? ` <span style="color:var(--text-faint);">— ${esc(e.note)}</span>` : ''}
                <div style="font-family:var(--font-mono); font-size:10.5px; color:var(--text-faint);">${esc(e.cash_source || 'Unassigned')}</div></td>
              <td data-label="Amount" style="padding:10px 12px; text-align:right; font-family:var(--font-mono); font-weight:700; color:${Number(e.amount) < 0 ? 'var(--status-danger, #c53030)' : 'var(--leaf-600, #2e7d32)'};">${Number(e.amount) < 0 ? '-' : '+'}${esc(fmtAmount(Math.abs(Number(e.amount) || 0)))}</td>
              ${isAdmin ? `<td style="padding:10px 12px; text-align:right;">${e.kind === 'topup' ? `<button class="btn btn-danger btn-del-petty" data-id="${esc(e.id)}" style="font-size:11px; padding:4px 9px;">Delete</button>` : ''}</td>` : ''}
            </tr>`).join('')}
          </tbody>
        </table>
      </div>` : `<div style="padding:50px; text-align:center; color:var(--text-faint); font-family:var(--font-mono); font-size:12px;">Nothing recorded yet.</div>`}`}
    </section>`;

  document.querySelectorAll('.petty-tab').forEach((b) => b.addEventListener('click', () => {
    pettyTab = b.dataset.pettyTab; renderPettyCashTab({ refresh: false });
  }));

  if (isAdmin) {
    const add = $('btnAddPetty');
    if (add) add.addEventListener('click', async () => {
      const amount = prompt('How much cash is going into the box?');
      if (amount === null) return;
      const n = Number(String(amount).replace(/[^0-9.\-]/g, ''));
      if (!isFinite(n) || n <= 0) { alert('Enter an amount greater than zero.'); return; }
      // ── WHICH BANK IT CAME OUT OF ───────────────────────────────────────
      // Apsara, 2026-09-21: "when adding cash ,ask its from BofA or chase
      // bank". Required here and only here: she is standing at the counter
      // with the receipt, so this is the one moment the answer is always
      // knowable. The server refuses a blank one.
      //
      // Unassigned is deliberately NOT offered on this prompt. A top-up is by
      // definition money she drew from an account; if it had no bank behind
      // it, it is not a top-up.
      // ── THE BANK FIRST, THEN THE ACCOUNT INSIDE IT ────────────────────
      // Apsara, 2026-09-22: "Bofa should be main.inside that edge metals/AAA",
      // and asked which part of that was missing, she chose the two-step
      // prompt rather than a figure on the panel.
      //
      // It was one flat list of four, which put "BofA — Edge Metals" and
      // "Chase Bank" side by side as if they were the same kind of thing.
      // They are not: the bank is where the money physically came from, the
      // account is whose it is. Asking them in that order is how she thinks
      // about it at the counter.
      //
      // BOTH LISTS ARE DERIVED, from bank_of — never written out here. That
      // is the whole reason this is only a form change: the server still
      // receives one cash_source and knows nothing about steps.
      const accounts = (pettyCash.sources || []).filter((x) => x !== 'Unassigned');
      const bankFor = (a) => (pettyCash.bank_of || {})[a] || a;
      const banks = accounts.map(bankFor).filter((b, i, all) => all.indexOf(b) === i);
      // The range is computed, not written out. It said "Type 1 or 2" — true
      // when there were two accounts — and I fixed that sentence on the phone
      // and left it standing here, because the check I wrote to catch it only
      // read the phone's file. A prompt naming a range it no longer has is
      // how a wrong account gets picked in a hurry.
      const askFrom = (list, question) => {
        if (list.length === 1) return list[0];          // nothing to choose
        const raw = prompt(question + '\n\n' + list.map((b, i) => `${i + 1}. ${b}`).join('\n')
          + `\n\nType 1${list.length > 1 ? `–${list.length}` : ''}.`);
        if (raw === null) return null;                   // she cancelled
        const hit = list[Number(String(raw).trim()) - 1]
          || list.find((b) => b.toLowerCase() === String(raw).trim().toLowerCase());
        if (!hit) { alert('Pick one of: ' + list.join(', ')); return null; }
        return hit;
      };
      const bank = askFrom(banks, `Which bank did this ${fmtAmount(n)} come out of?`);
      if (!bank) return;
      // A bank with one account asks nothing further — Chase has no second
      // account, so there is no question to put to her about it.
      const chosen = askFrom(accounts.filter((a) => bankFor(a) === bank),
        `Which ${bank} account?`);
      if (!chosen) return;
      try {
        await api('/api/petty-cash', { method: 'POST', body: JSON.stringify({ amount: n, cash_source: chosen }) });
        await renderPettyCashTab();
      } catch (err) { alert('Could not add cash: ' + err.message); }
    });

    // Repay — the amount is pre-filled with what is owed, and she can settle
    // part of it. The server refuses anything the bucket cannot cover.
    document.querySelectorAll('.btn-repay').forEach((b) => b.addEventListener('click', async () => {
      const owed = Number(b.dataset.amount) || 0;
      const raw = prompt(`How much should ${b.dataset.owes} repay ${b.dataset.to}?`, String(owed));
      if (raw === null) return;
      const amt = Number(String(raw).replace(/[^0-9.\-]/g, ''));
      if (!isFinite(amt) || amt <= 0) { alert('Enter an amount greater than zero.'); return; }
      await movePettyCash({ from: b.dataset.owes, to: b.dataset.to, amount: amt, reason: 'repay' });
    }));

    // ── SPLIT: THE TWO-COMPANY MOVE, WITHOUT THE THREE PROMPTS ──────────
    // Apsara, 2026-09-22, after choosing to migrate the old BofA cash into
    // Edge Metals: "now add a split as edge metals/aaa".
    //
    // It is the reassign below with both accounts already chosen, because
    // that is the move she will make over and over: the migration puts every
    // previous BofA note under Edge Metals, and AAA Investment's share comes
    // back out of it one amount at a time. Three prompts for a journey whose
    // start and end never change is three chances to pick the wrong account.
    //
    // DELIBERATELY THE SAME ROUTE AND THE SAME REASON ('reassign'). It gets
    // the refusal when the source is short, the dated pair of rows sharing a
    // transfer_id, and its line on the Borrowing tab — none of which is
    // re-implemented here. A second path that moves money is a second path
    // that can move it wrongly.
    const SPLIT_FROM = 'Edge Metals', SPLIT_TO = 'AAA Investment';
    const split = $('btnSplitCash');
    if (split) split.addEventListener('click', async () => {
      const held = Number((pettyCash.by_source || {})[SPLIT_FROM]) || 0;
      const raw = prompt(`How much of ${SPLIT_FROM}'s cash belongs to ${SPLIT_TO}?\n\n`
        + `${SPLIT_FROM} holds ${fmtAmount(held)}.\n\n`
        + 'This moves it between the two accounts. Cash in hand does not change.');
      if (raw === null) return;
      const amt = Number(String(raw).replace(/[^0-9.\-]/g, ''));
      if (!isFinite(amt) || amt <= 0) { alert('Enter an amount greater than zero.'); return; }
      // Stated before it happens, because this one crosses a company line.
      if (!confirm(`Move ${fmtAmount(amt)} from ${SPLIT_FROM} to ${SPLIT_TO}?\n\n`
        + 'These are two different companies, so this changes whose money it is.')) return;
      await movePettyCash({ from: SPLIT_FROM, to: SPLIT_TO, amount: amt, reason: 'reassign' });
    });

    const reassign = $('btnReassignCash');
    if (reassign) reassign.addEventListener('click', async () => {
      const all = pettyCash.sources || [];
      const from = prompt('Move cash OUT of which account?\n\n' + all.map((b, i) => `${i + 1}. ${b}`).join('\n'));
      if (from === null) return;
      const src = all[Number(String(from).trim()) - 1] || all.find((b) => b.toLowerCase() === String(from).trim().toLowerCase());
      if (!src) { alert('Pick one of: ' + all.join(', ')); return; }
      const rest = all.filter((b) => b !== src);
      const to = prompt('And INTO which?\n\n' + rest.map((b, i) => `${i + 1}. ${b}`).join('\n'));
      if (to === null) return;
      const dst = rest[Number(String(to).trim()) - 1] || rest.find((b) => b.toLowerCase() === String(to).trim().toLowerCase());
      if (!dst) { alert('Pick one of: ' + rest.join(', ')); return; }
      const raw = prompt(`How much moves from ${src} to ${dst}?`);
      if (raw === null) return;
      const amt = Number(String(raw).replace(/[^0-9.\-]/g, ''));
      if (!isFinite(amt) || amt <= 0) { alert('Enter an amount greater than zero.'); return; }
      await movePettyCash({ from: src, to: dst, amount: amt, reason: 'reassign' });
    });
    // Only top-ups carry this button (see the row markup). A withdrawal is
    // undone by deleting the PAYMENT, which reverses it properly — the server
    // refuses it here too, so this is not the only thing holding that rule.
    document.querySelectorAll('.btn-del-petty').forEach(btn => btn.addEventListener('click', async () => {
      if (!confirm('Delete this cash entry? The balance will drop by that amount.')) return;
      try {
        await api('/api/petty-cash/' + encodeURIComponent(btn.dataset.id), { method: 'DELETE' });
        await renderPettyCashTab();
      } catch (err) { alert('Could not delete: ' + err.message); }
    }));
  }
}

// ── MONTH -> WEEK -> DAY, ONCE A MONTH IS OVER ─────────────────────────────
// Apsara, 2026-09-16: "in loads once the onth gets over,just make group as
// monthwise exppand/collapse-then weekwise-on clicking daywise expand".
//
// THE CURRENT MONTH IS LEFT ALONE. Day sections, newest open, exactly as
// before — that is the screen she works in every day, and burying today's
// loads two folds deep to tidy up last March would be a bad trade. Her words
// are "once the month gets over", and this takes them literally.
//
// Older months fold: month -> week -> day, all shut. Nothing is hidden, it is
// only further away, and the counts on each heading say what is inside so she
// never has to open a fold to find out whether it is worth opening.
//
// Weeks run Monday to Sunday and are CLIPPED TO THE MONTH, so a week straddling
// month-end appears in both with only that month's days in it. The alternative
// — letting a week own days from two months — makes the month counts stop
// adding up, and a count that does not add up is worse than an awkward week.
