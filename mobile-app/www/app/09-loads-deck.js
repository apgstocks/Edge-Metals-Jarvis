// mobile-app/www/app/09-loads-deck.js — split from mobile-app/www/index.html's <script> (helpers/sourceParts.js reconstructs the original)
// ── WHICH KIND OF ROW ───────────────────────────────────────────────────
// The deck merges purchases (helpers/loads.js) and sales (outboundLoads.js);
// the map that builds loadsCache tags each with _kind and aliases a sale's
// buyer into `seller`. Anything untagged is a purchase, which is what every
// row was before sales existed — so an old record filters correctly without
// being migrated.
const LOAD_KINDS = [['all', 'All'], ['purchase', 'Purchases'], ['sale', 'Sales']];
function filterLoadsByKind(loads, kind) {
  if (!kind || kind === 'all') return loads;
  return (loads || []).filter((l) => (l._kind === 'sale' ? 'sale' : 'purchase') === kind);
}

function filterLoads(loads, query) {
  // ── ONE box, typed, matching everything on the load ─────────────────────
  // Apsara, 2026-09-02: "instead of select option of item detail filter, make
  // it as type and match .. add it to search by date, seller, item, price."
  //
  // There WAS a second control here — a dropdown of the item types present in
  // the deck, added earlier the same day. It is gone. Two controls answering
  // the same question is one more than anyone wants to reach for on a phone in
  // a yard, and the dropdown's only real advantage was exact matching, which
  // is not what you want when you are looking for a load: typing "sealed"
  // should find Sealed Units, and it does.
  //
  // So the haystack is everything a person might type: the load's own fields,
  // and its ITEMS — descriptions and per-item prices. Item weights stay out;
  // an item weighing 300 would make every load with a 300 anywhere in it
  // match, and the load-level weights are already in here.
  const q = (query || '').trim().toLowerCase();
  if (!q) return loads;
  return loads.filter(l => {
    const items = Array.isArray(l.items) ? l.items : [];
    const haystack = [l.id, l.date, l.seller, l.description, l.gross_weight, l.tare_weight, l.net_weight, l.amount, l.status]
      .concat(items.map(it => it.description))
      .concat(items.map(it => it.price))
      .map(v => String(v ?? '').toLowerCase()).join(' ');
    return haystack.includes(q);
  });
}

// Builds just the deck markup (date sections + cards), reused by both the
// initial render and every search-box keystroke so filtering doesn't have
// to re-render the whole tab (modal, header, styles) each time. Each date
// section is a native <details>/<summary> — free expand/collapse with zero
// extra JS — with only the FIRST (most recent) group open by default once
// there's more than one, per Apsara's "expand based on dates" once the deck
// has more cards than fits comfortably on one screen.
// opts.flat renders ONE grid instead of per-date sections.
//
// Per Apsara 2026-09-01: "on filtering of load by say, seller - it should not
// group by date." The date sections exist to make a particular day findable
// in a long deck — but once you have searched for a seller you are no longer
// looking for a day, you are looking at that seller's loads, and splitting
// six results across five collapsed date headers hides four of them behind a
// disclosure triangle. (Only the FIRST section renders open.) So a search
// result is a flat, newest-first list.
//
// The unfiltered deck keeps its date sections — that view genuinely is
// "what happened when".
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
function loadMonthKey(iso) { return String(iso || '').slice(0, 7); }

function loadWeekStart(iso) {
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  // getDay(): 0 = Sunday. Shift so Monday is the first day.
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  return d.toISOString().slice(0, 10);
}

function loadWeekLabel(days) {
  // Labelled by the days ACTUALLY PRESENT, not by the calendar week, so a
  // heading never advertises a range with nothing in most of it.
  const sorted = days.slice().sort();
  const fmt = (k) => new Date(k + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const a = sorted[0], b = sorted[sorted.length - 1];
  return a === b ? fmt(a) : `${fmt(a)} – ${fmt(b)}`;
}

function loadMonthLabel(key) {
  const d = new Date(key + '-01T00:00:00');
  if (isNaN(d.getTime())) return key;
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

// Splits the deck into the part that stays flat (this month, plus anything
// undated) and the older months, folded.
// ── LAST WEEK IS OPEN, THE REST FOLDS (2026-10-02) ───────────────────────
// Apsara: "in collapse phase of Edge Yard-I want last week load to
// visible.rest of them collapsible."
//
// This used to split on the CALENDAR MONTH: everything in the current month
// stayed open. On the 28th that is four weeks of day sections before the
// first fold, which is the scrolling the folding was meant to remove — and
// on the 1st it is nothing at all, so the screen went from four weeks to one
// day overnight.
//
// A ROLLING SEVEN DAYS, asked and confirmed: "always expanded... on a Monday
// that includes last Thu-Sun, which is usually what you want to still see."
// Same amount of work in view every day of the month, and no cliff on the
// 1st.
//
// LOCAL days, not UTC. new Date().toISOString() in the old version took the
// UTC date, so for the seven hours after 5pm Pacific it believed it was
// already tomorrow — which on the last day of a month moved the whole
// boundary a month early. Dates on a load are the yard's own day.
// ── A FUNCTION, NOT A CONST, ON PURPOSE ──────────────────────────────────
// tests/load-card-actions.js extracts single functions out of this file by
// name (`function <name>(`) and evaluates them in isolation — which is how
// it has twice caught a function quietly gaining a dependency on the global
// scope. A `const LOAD_RECENT_DAYS = 7` here was not extractable, so
// splitLoadsByRecency threw ReferenceError the moment that test ran it.
//
// Declaring it as a function keeps ONE source of truth for the seven and
// keeps the extraction working. Copying the 7 into the test instead would
// have left two numbers that can disagree.
function loadRecentDays() { return 7; }

function loadLocalDayKey(d) {
  const t = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

function splitLoadsByRecency(loads, opts) {
  const days = (opts && opts.days) || loadRecentDays();
  const from = new Date();
  // days - 1: seven days INCLUDING today, not today plus seven.
  from.setDate(from.getDate() - (days - 1));
  const cutoff = loadLocalDayKey(from);
  const recent = [], older = [];
  for (const l of (loads || [])) {
    const d = l && l.date ? String(l.date).slice(0, 10) : '';
    // Undated loads stay in the open part. Filing them under a month would
    // mean inventing one, and they are the rows most likely to need fixing.
    if (!d || d >= cutoff) recent.push(l);
    else older.push(l);
  }
  return { recent, older };
}

// Which months the data actually has, newest first, for the filter. Built
// from the loads rather than from a calendar: offering a month with nothing
// in it is a control that answers "no loads" and looks broken.
function loadMonthsPresent(loads) {
  const seen = new Map();
  for (const l of (loads || [])) {
    const k = loadMonthKey(l && l.date);
    if (!k) continue;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  return Array.from(seen.keys()).sort((a, b) => b.localeCompare(a))
    .map((k) => ({ key: k, count: seen.get(k), label: loadMonthLabel(k) }));
}

function loadMonthLabel(key) {
  const [y, m] = String(key || '').split('-');
  const names = ['January', 'February', 'March', 'April', 'May', 'June',
                 'July', 'August', 'September', 'October', 'November', 'December'];
  const name = names[Number(m) - 1];
  return name ? `${name} ${y}` : String(key || '');
}

// Undated loads are NOT swept into a month filter. They have no month, and
// showing them under one would be the same invention splitLoadsByRecency
// refuses to make.
function filterLoadsByMonth(loads, key) {
  if (!key) return loads || [];
  return (loads || []).filter((l) => loadMonthKey(l && l.date) === key);
}

// [{ key, label, count, weeks: [{ key, label, count, days: [{key,label,loads}] }] }]
function groupLoadsByMonthWeekDay(loads) {
  const byMonth = new Map();
  for (const l of (loads || [])) {
    const mk = loadMonthKey(l && l.date);
    if (!byMonth.has(mk)) byMonth.set(mk, []);
    byMonth.get(mk).push(l);
  }
  return Array.from(byMonth.keys()).sort((a, b) => b.localeCompare(a)).map((mk) => {
    const byWeek = new Map();
    for (const l of byMonth.get(mk)) {
      const wk = loadWeekStart(l.date);
      if (!byWeek.has(wk)) byWeek.set(wk, []);
      byWeek.get(wk).push(l);
    }
    const weeks = Array.from(byWeek.keys()).sort((a, b) => b.localeCompare(a)).map((wk) => {
      const byDay = new Map();
      for (const l of byWeek.get(wk)) {
        if (!byDay.has(l.date)) byDay.set(l.date, []);
        byDay.get(l.date).push(l);
      }
      const dayKeys = Array.from(byDay.keys()).sort((a, b) => b.localeCompare(a));
      return {
        key: wk,
        label: loadWeekLabel(dayKeys),
        count: byWeek.get(wk).length,
        days: dayKeys.map((dk) => ({ key: dk, label: formatLoadDateHeading(dk), loads: byDay.get(dk) })),
      };
    });
    return { key: mk, label: loadMonthLabel(mk), count: byMonth.get(mk).length, weeks };
  });
}

function loadCountLabel(n) { return `${n} load${n === 1 ? '' : 's'}`; }

// `allOpen` renders every fold expanded. Used when she has picked a month
// from the filter: "If they select that month -all that months load should be
// visible expanded." Default false, so nothing about the ordinary view moves.
function loadFoldedMonthsHtml(older, allOpen) {
  const o = allOpen ? ' open' : '';
  return groupLoadsByMonthWeekDay(older).map((m) => `
    <details class="load-month-section"${o}>
      <summary class="load-date-heading">${esc(m.label)}<span class="load-date-count">${loadCountLabel(m.count)}</span></summary>
      ${m.weeks.map((w) => `
        <details class="load-week-section"${o}>
          <summary class="load-week-heading">${esc(w.label)}<span class="load-date-count">${loadCountLabel(w.count)}</span></summary>
          ${w.days.map((d) => `
            <details class="load-day-section"${o}>
              <summary class="load-day-heading">${esc(d.label)}<span class="load-date-count">${loadCountLabel(d.loads.length)}</span></summary>
              <div class="load-deck-grid">${d.loads.map(loadCardHtml).join('')}</div>
            </details>`).join('')}
        </details>`).join('')}
    </details>`).join('');
}

function loadDeckSectionsHtml(loads, emptyMsg, opts) {
  const flat = !!(opts && opts.flat);
  const empty = `<div style="padding:60px; text-align:center; color:var(--text-faint); font-family:var(--font-mono); font-size:12px;">${esc(emptyMsg)}</div>`;

  if (flat) {
    const rows = (loads || []).slice().sort((a, b) => {
      // Newest first, undated last — the same ordering groupLoadsByDate
      // produces, just without the headings.
      const ad = a && a.date ? a.date : '';
      const bd = b && b.date ? b.date : '';
      if (!ad && !bd) return 0;
      if (!ad) return 1;
      if (!bd) return -1;
      return bd.localeCompare(ad);
    });
    if (!rows.length) return empty;
    return `<div class="load-deck-grid">${rows.map(loadCardHtml).join('')}</div>`;
  }

  // This month stays as day sections; older months fold into
  // month -> week -> day. See splitLoadsByRecency for why.
  // allOpen: she picked a month, so everything in view is expanded — the
  // last-week/older split still applies, it is just all open.
  const allOpen = !!(opts && opts.allOpen);
  const { recent, older } = splitLoadsByRecency(loads);
  const groups = groupLoadsByDate(recent);
  if (!groups.length && !older.length) {
    return empty;
  }
  // ── EVERY DAY IN THE WEEK IS OPEN, NOT JUST THE NEWEST ─────────────────
  // This was `i === 0` — only the most recent day. Under the old
  // this-month rule that was right: the alternative was four weeks of open
  // sections. Under "I want last week load to visible" it is wrong, and it
  // was the first thing my own test caught: one open day and six shut is the
  // scrolling the folding was meant to remove.
  //
  // `recent` IS the last seven days now, so opening all of it is exactly
  // what she asked for and is bounded by the window rather than by a month.
  const days = groups.map((g) => `
    <details class="load-date-section" open>
      <summary class="load-date-heading">${esc(g.label)}<span class="load-date-count">${g.loads.length} load${g.loads.length === 1 ? '' : 's'}</span></summary>
      <div class="load-deck-grid">${g.loads.map(loadCardHtml).join('')}</div>
    </details>`).join('');
  return days + (older.length ? loadFoldedMonthsHtml(older, allOpen) : '');
}

function renderLoads(loads) {
  loadsCache = loads || [];

  $('viewRoot').innerHTML = `
    <style>
      /* Scoped to the Loads tab — regenerated fresh each time this tab
         loads, so nothing accumulates or leaks into other tabs. */
      .load-date-section { margin-bottom:28px; }
      /* .load-date-section is a <details> element now (collapsible — see
         loadDeckSectionsHtml) and .load-date-heading is its <summary>, so the
         default disclosure triangle is swapped for a custom one that rotates
         open/closed, and list-style is stripped so it doesn't double up. */
      .load-date-heading { display:flex; align-items:baseline; gap:8px; font-family:var(--font-mono); font-size:12px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--text-strong); padding-bottom:8px; margin-bottom:14px; border-bottom:1px solid var(--border-subtle); cursor:pointer; list-style:none; user-select:none; }
      .load-date-heading::-webkit-details-marker { display:none; }
      .load-date-heading::before { content:'▸'; font-size:10px; color:var(--text-muted); display:inline-block; transition:transform 120ms ease; }
      .load-date-section[open] > .load-date-heading::before { transform:rotate(90deg); }
      .load-date-count { font-weight:400; text-transform:none; letter-spacing:0; color:var(--text-muted); }
      /* ── Older months: month > week > day (2026-09-16) ────────────────
         Each level is one step quieter and one step indented, so depth is
         readable at a glance rather than having to be counted. They reuse
         the day heading's disclosure triangle and its open/shut rotation. */
      .load-month-section { margin-bottom:10px; }
      .load-week-section, .load-day-section { margin-left:16px; }
      .load-week-heading, .load-day-heading { display:flex; align-items:baseline; gap:8px; font-family:var(--font-mono); font-weight:500; letter-spacing:.06em; padding-bottom:6px; margin-bottom:8px; border-bottom:1px solid var(--border-subtle); cursor:pointer; list-style:none; user-select:none; }
      .load-week-heading { font-size:11.5px; color:var(--text-body); text-transform:uppercase; }
      .load-day-heading  { font-size:11px; color:var(--text-muted); text-transform:none; letter-spacing:0; }
      .load-week-heading::-webkit-details-marker, .load-day-heading::-webkit-details-marker { display:none; }
      .load-week-heading::before, .load-day-heading::before { content:'▸'; font-size:9px; color:var(--text-faint); display:inline-block; transition:transform 120ms ease; }
      .load-week-section[open] > .load-week-heading::before,
      .load-day-section[open]  > .load-day-heading::before { transform:rotate(90deg); }
      .load-deck-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(270px, 1fr)); gap:16px; }
      .load-card { box-shadow:0 3px 0 -1px var(--border-subtle), 0 8px 20px -6px rgba(0,0,0,.18); transition:transform 140ms ease, box-shadow 140ms ease; }
      .load-card:hover { transform:translateY(-3px); box-shadow:0 5px 0 -1px var(--border-subtle), 0 14px 26px -8px rgba(0,0,0,.24); }
      #loadModal.modal-overlay { display:flex; } /* base .modal-overlay never sets display, so without this the shell hugs the left edge instead of centering — this is the "stuck on one end" bug */
      #loadModal .modal-shell { max-width:900px; width:100%; }
      #adminSettingsModal.modal-overlay { display:flex; } /* same fix as #loadModal above — same underlying .modal-overlay quirk */
      #voiceSheet.modal-overlay { display:flex; }
      #voiceSheet.hidden { display:none; }
      .ld-grid-2 { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
      /* Gross/tare/net/price/unit/amount are now captured PER ITEM (moved off
         the load level per Apsara — a load can mix items with different
         weights), and each item row is ONE compact single-line grid row
         (per Apsara — the earlier 3-stacked-boxes-per-item layout took up
         too much space) instead of a multi-line card. #ld_items scrolls
         sideways on narrow screens rather than re-stacking into a taller
         layout — with 8 columns per row there's no good way to keep this a
         single line AND fit a phone screen, so horizontal scroll (like a
         spreadsheet) beats forcing it back into multiple lines on mobile. */
      .ld-item-header, .item-row { display:grid; grid-template-columns:0.9fr 120px 120px 92px 124px 100px 62px; gap:6px; align-items:center; min-width:674px; }
      .ld-item-header { font-family:var(--font-mono); font-size:9.5px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); padding:0 2px 6px; }
      .item-row { margin-bottom:5px; }
      #draftBar { display:flex; align-items:center; gap:10px; margin-bottom:16px; padding:10px 14px;
        background:var(--surface-sunken); border:1px solid var(--border-default); border-left:3px solid var(--copper-400);
        border-radius:var(--radius-sm); font-family:var(--font-mono); font-size:12px; color:var(--text-muted); }
      #draftBar.hidden { display:none; }
      /* A silent autosave is indistinguishable from a broken one, so it says
         what it is doing — muted, because this is reassurance not an alert. */
      #draftStatus { font-family:var(--font-mono); font-size:11px; color:var(--text-muted); display:flex; align-items:center; gap:6px; }
      #draftStatus .dot { width:6px; height:6px; border-radius:50%; background:var(--status-good, #4ade80); flex:none; }
      #draftStatus.saving .dot { background:var(--copper-400); }
      #draftStatus.idle { color:var(--text-faint); }
      .draft-strip { margin-bottom:22px; }
      .draft-strip-head { font-family:var(--font-mono); font-size:11px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--text-muted); margin-bottom:10px; }
      .draft-card { display:flex; align-items:center; gap:12px; padding:12px 16px; margin-bottom:8px;
        background:var(--surface-sunken); border:1px solid var(--border-default); border-left:3px solid var(--copper-400); border-radius:var(--radius-sm); }
      .draft-card .d-main { flex:1; min-width:0; }
      .draft-card .d-title { font-size:13px; color:var(--text-strong); font-weight:600; }
      .draft-card .d-sub { font-family:var(--font-mono); font-size:11px; color:var(--text-muted); margin-top:3px; }
      /* Payment badge. Shown only once something has been paid — an "UNPAID"
         tag on every load is noise. Amber carries the pending figure, which
         is the number anyone looking at a part-paid load actually wants. */
      .pay-badge { display:inline-block; margin-top:10px; padding:4px 10px; border-radius:999px;
        font-family:var(--font-mono); font-size:11px; font-weight:700; letter-spacing:.04em; }
      .pay-full { background:rgba(74,222,128,.13); color:var(--status-good, #4ade80); border:1px solid rgba(74,222,128,.35); }
      .pay-part { background:rgba(217,154,43,.13); color:var(--status-warning, #d99a2b); border:1px solid rgba(217,154,43,.4); }
      .pay-over { background:rgba(217,90,43,.13); color:#d95a2b; border:1px solid rgba(217,90,43,.4); }
      /* Added 2026-09-03 with the Trucker tab. Loads never needed an UNPAID
         badge — an unpaid load simply shows none — but a bills ledger is read
         as a list of debts, where "nothing paid yet" is the state you are
         looking FOR and a blank cell reads as missing data instead.
         NOTE: this rule block appears TWICE in this file, a duplication that
         predates the tab. Both copies are kept in step deliberately; whichever
         one wins, the badge renders. */
      .pay-none { background:rgba(148,163,184,.12); color:var(--text-muted); border:1px solid var(--border-subtle); }
      .ld-item-desc-wrap { display:flex; flex-direction:column; gap:3px; min-width:0; }
      /* Own positioning context for the description type-ahead dropdown —
         .ld-item-desc-wrap is forced position:static in the phone grid. */
      .ld-desc-ac-wrap { position:relative; min-width:0; }
      .ld-desc-ac-wrap input { width:100%; }
      .ld-mobile-label { display:none; }
      .ld-item-cap { display:flex; gap:3px; min-width:0; }
      .ld-item-cap-inputs { display:flex; gap:3px; flex:1; min-width:0; }
      .ld-item-cap input { flex:1; min-width:0; }
      .ld-item-cap .btn-photo-item { flex:none; padding:4px 6px; font-size:12px; line-height:1; }
      .item-row input, .item-row select { font-size:12px; padding:5px 6px; }
      .ld-item-actions { display:flex; gap:3px; min-width:0; }
      .item-row .btn-remove-item, .item-row .btn-insert-item, .item-row .btn-dup-item { padding:4px 6px; font-size:11px; flex:1; min-width:0; }
      .item-row .btn-insert-item { color:var(--leaf-600, #2e7d32); }
      /* Every direct grid child of a row/header MUST be able to shrink below
         its own natural (min-content) size — otherwise a cell with content
         that can't wrap (e.g. two side-by-side buttons in .ld-item-actions)
         silently pushes ITS OWN column wider than the fixed px width every
         OTHER row (and the header, which has no such content) is using,
         and everything to the right drifts out of alignment. This is what
         was actually causing "headers not lining up with their columns" on
         mobile — narrower viewports have less slack for a column to quietly
         overflow into before it becomes visible. min-width:0 is the
         standard fix: it lets grid/flex items shrink to fit their assigned
         track instead of expanding it. */
      .ld-item-header > *, .item-row > * { min-width:0; }
      /* Totals line — same grid as .item-row so each figure sits under the
         column it sums. A total laid out differently from the numbers it adds
         up is a total nobody checks. */
      .ld-item-totals:empty { display:none; }
      .ld-item-totals { display:grid; grid-template-columns:0.9fr 120px 120px 92px 124px 100px 62px; gap:6px;
        align-items:center; min-width:674px; margin-top:8px; padding-top:9px;
        border-top:1px solid var(--border-default); font-family:var(--font-mono); font-size:12px; }
      .ld-item-totals .tl-label { font-size:10px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted); }
      .ld-item-totals .tl-num { text-align:right; padding-right:10px; color:var(--text-muted); }
      .ld-item-totals .tl-strong { color:var(--text-strong); font-weight:700; }
      /* "Others" free-text box is a direct grid child now (moved out of
         .ld-item-desc-wrap — see renderItemRows), spanning the full row
         width instead of being squeezed into just the 0.9fr description
         column, which on a phone was too narrow to type an address-length
         description into. Sized up (bigger font/padding than the compact
         columns) since it's now its own full-width line, not a cramped cell. */
      .ld-item-status:empty { display:none; }
      .ld-item-status { grid-column:1 / -1; font-family:var(--font-mono); font-size:10px; color:var(--text-muted); margin:-1px 0 3px; }
      #ld_items { overflow-x:auto; padding-bottom:2px; }
      /* Take Photo / Choose File popover — see showCaptureMenu(). */
      .capture-menu { position:absolute; z-index:1000; background:var(--surface-card); border:1px solid var(--border-default); border-radius:var(--radius-sm); box-shadow:0 8px 20px rgba(0,0,0,.28); padding:4px; display:flex; flex-direction:column; min-width:160px; }
      .capture-menu-btn { display:block; width:100%; text-align:left; padding:9px 12px; font-size:13px; background:none; border:none; border-radius:var(--radius-xs); color:var(--text-strong); cursor:pointer; }
      .capture-menu-btn:hover, .capture-menu-btn:active { background:var(--surface-hover); }
      /* Breakpoint split for tablet compatibility, per Apsara 2026-08-17
         ("make it tablet device compatible as well"). Originally this was
         one @media(max-width:860px) block, which caught tablets in
         portrait too (iPad-class devices are commonly 768-834px CSS width
         — all under 860) and forced them into the phone-only stacked
         one-handed card redesign below, even though they have plenty of
         room for the normal grid row (.item-row's own min-width is only
         620px). Split into two tiers:
           - 900px: generic touch ergonomics (full-screen modal, 16px
             inputs to stop iOS zoom, stacked Cancel/Save) — genuinely
             better on ANY touchscreen, tablet included, so this stays wide.
           - 600px: the phone-specific stacked item-row card redesign
             (built for a one-handed thumb grip on a narrow phone) — now
             scoped to actual phone widths only, so tablets keep the
             roomier grid-row layout instead. */
      @media (max-width: 900px) {
        #loadModal { padding:0; align-items:stretch; }
        #loadModal .modal-shell { max-width:100%; height:100%; border-radius:0; display:flex; flex-direction:column; }
        #loadModal .modal-body { max-height:none; flex:1; }
        .ld-grid-2 { grid-template-columns:1fr; }

        /* iOS Safari auto-zooms the whole page on focus for any input
           under 16px — every tap into a field was yanking the layout
           around. 16px is the documented threshold that disables that. */
        #loadModal input, #loadModal select, #loadSearch { font-size:16px; }

        /* Load-deck card buttons (Edit/Delete/Generate PDF) — bigger,
           easier-to-thumb-tap targets on any touchscreen. */
        .load-card .btn { padding:9px 14px; font-size:12.5px; }

        /* Cancel/Save stack full-width instead of two small buttons
           crammed to the right — bigger target, and Save (the action
           people actually came here to tap) lands at the bottom,
           thumb-reachable on a one-handed grip. */
        #loadModal .modal-foot { flex-direction:column; }
        #loadModal .modal-foot .btn { width:100%; padding:13px 18px; font-size:12.5px; }
        #loadModal #btnCloseLoadModal { padding:9px 14px; font-size:15px; }
      }

      @media (max-width: 600px) {
        /* ── Mobile ergonomics pass — per Apsara, this tab's primary
           audience is yard staff on a phone, not a desktop mouse user, and
           several things sized fine for a pointer are genuinely hard to
           use with a thumb. Everything below is scoped to #loadModal /
           .load-card / .ld-item-* / #loadSearch specifically — NOT to the
           bare .btn/.modal-foot/.field classes those elements also carry
           — so none of it touches Bookings/Board/Settings, which share
           those same base classes but weren't asked for here. */

        /* ── Item-row mobile redesign (v2) ──────────────────────────────
           The first mobile pass kept the desktop's single-line 7-column
           grid and just widened it, relying on horizontal scroll (like a
           spreadsheet) to reach Net/Price/Amount/actions. In practice on
           a real phone this looked cramped and you could only ever see
           2-3 columns at a time — per Apsara, "clumsy," needed a
           different design.
           Replaced with a stacked card per item: no horizontal scroll at
           all. Fields are grouped by relationship instead of forced into
           uniform columns — Gross+Tare together (both need a camera
           button, both get typed into every load), Net+Price+Amount
           together (Net/Amount are just auto-computed readouts, Price is
           the only one you actually type), actions on their own
           full-width row at the bottom for an easy thumb tap. Each field
           gets a small label above it (.ld-mobile-label, hidden on
           desktop) since the shared header row doesn't make sense once
           fields aren't in fixed columns — so the header itself is
           hidden here instead. Kept to ≤600px (phone-only) — a tablet at
           768px+ has room for the normal grid row (min-width:674px), so
           it no longer gets funneled into this cramped layout. */
        .ld-item-header { display:none; }
        /* Rows are stacked cards at this width, so the totals wrap as
           labelled pairs rather than a mostly-empty 7-column grid. This is
           the layout that actually gets used at the yard. */
        .ld-item-totals { display:flex; flex-wrap:wrap; gap:6px 18px; min-width:0;
          padding:12px; margin-top:0; background:var(--surface-sunken, rgba(255,255,255,.03));
          border:1px solid var(--border-default); border-radius:var(--radius-sm); }
        .ld-item-totals .tl-label { width:100%; }
        .ld-item-totals .tl-num { text-align:left; padding-right:0; }
        .ld-item-totals > span:empty { display:none; }
        .ld-item-totals .tl-num::before { content:attr(data-label) ' '; color:var(--text-faint); font-size:10px; text-transform:uppercase; letter-spacing:.08em; }
        #ld_items { overflow-x:visible; }
        .item-row {
          grid-template-columns:1fr 1fr;
          grid-template-areas:
            "desc desc"
            "gross tare"
            "net price"
            "amount amount"
            "actions actions";
          gap:10px;
          min-width:0;
          background:var(--surface-sunken, rgba(255,255,255,.03));
          border:1px solid var(--border-default);
          border-radius:var(--radius-sm);
          padding:12px;
          margin-bottom:12px;
        }
        .ld-item-desc-wrap { grid-area:desc; position:static; padding-right:0; }
        .ld-item-cap-gross { grid-area:gross; }
        .ld-item-cap-tare { grid-area:tare; }
        .ld-item-net-wrap { grid-area:net; }
        .ld-item-price-wrap { grid-area:price; }
        .ld-item-amount-wrap { grid-area:amount; }
        .ld-item-actions { grid-area:actions; flex-direction:row; gap:8px; }
        .ld-mobile-label { display:block; font-family:var(--font-mono); font-size:9.5px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); margin-bottom:4px; }
        .ld-item-cap { flex-direction:column; align-items:stretch; }
        .ld-item-net-wrap input, .ld-item-price-wrap input, .ld-item-amount-wrap input { width:100%; }
        .ld-item-cap .btn-photo-item { padding:10px; font-size:14px; }
        .item-row .btn-remove-item, .item-row .btn-insert-item, .item-row .btn-dup-item { padding:10px 4px; font-size:12px; flex:1; }
      }
    </style>
    <section style="max-width:1000px; margin:0 auto; padding:28px 20px 80px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:18px; gap:12px; flex-wrap:wrap;">
        <div>
          <div class="eyebrow">// Loads</div>
          <h2 style="font-size:24px; text-transform:uppercase; margin-bottom:4px;">Yard loads</h2>
          <div style="font-size:13px; color:var(--text-muted);">Camera or upload gross/tare weight, computed net, generated PDF ticket.</div>
        </div>
        <div style="display:flex; gap:8px;">
          <!-- "+ Create invoice" until 2026-10-15. Apsara: "create invoce
               rename to +load". It never created an invoice — it opens the
               load form in purchase mode and writes an inbound load. The id
               stays btnAddLoad, which both tests/yard-clients.js section E
               and tests/item-row-net.js reach for by name. EDGE YARD ONLY:
               the website's own Loads tab (dashboard/app/05-load-pricing.js)
               keeps its label, and she asked for "in edge yard". -->
          <button id="btnAddLoad" class="btn btn-primary">+ Load</button>
          <!-- Same modal, sale mode — see applyLoadModalMode. -->
          <!-- Visible to every role. Recording material leaving the yard is
               yard work, same as recording it arriving — Apsara, 2026-08-24,
               asked directly whether sales should be denied to staff: "no".
               /api/outbound-loads is on the staff allowlist to match. -->
          <button id="btnAddSale" class="btn">+ Sale</button>
        </div>
      </div>
      <!-- Search now also matches ITEM descriptions and per-item prices, per
           Apsara 2026-09-02 ("in load tab also, i should filter by item
           detail") — see filterLoads. The placeholder says so, because a
           search box that quietly got broader is one nobody knows to use. -->
      <!-- ONE box for general search. It matches the load's own fields AND
           its items — description and per-item price — per Apsara 2026-09-02:
           "make it as type and match .. add it to search by date, seller,
           item, price". -->
      <!-- ── ALL / PURCHASES / SALES ───────────────────────────────────────
           Apsara, 2026-09-15: "what if i can have a checkbox,which shows
           build sales only in loads".

           A SEGMENTED CONTROL RATHER THAN THE CHECKBOX SHE ASKED FOR, and the
           reason is worth keeping: this is a three-state question, not a
           two-state one. "Sales only" ticked covers two of All / Purchases /
           Sales, and the third is the one the yard wants most — so it grows a
           second checkbox, and two checkboxes that can both be ticked can say
           "only sales and only purchases", which is nothing.

           This tab has already paid for that once: the item-detail DROPDOWN
           was removed on 2026-09-02 because it answered the same question as
           the search box beside it. See the note at the top of filterLoads.

           Sits ABOVE the search box because it narrows the haystack that box
           then searches, which is the order they are read in. -->
      <div id="loadKindBar" style="display:flex; gap:6px; margin-bottom:10px;"></div>
      <input id="loadSearch" type="text" placeholder="Search by date, seller, item, price…" style="width:100%; padding:11px 14px; margin-bottom:10px; border:1px solid var(--border-default); border-radius:var(--radius-sm); font-size:13px; background:var(--surface-sunken); color:var(--text-strong);">
      <!-- ── FILTER BY MONTH (2026-10-02) ─────────────────────────────────
           Apsara: "Also give an option to filter by month.If they select
           that month -all that months load should be visible expanded."
           Beside the search rather than in a menu: it is a narrowing, and it
           belongs with the other narrowings. Options are built from the
           loads — see paintLoadMonthFilter. -->
      <select id="loadMonthFilter" style="width:100%; padding:11px 14px; margin-bottom:10px; border:1px solid var(--border-default); border-radius:var(--radius-sm); font-size:13px; background:var(--surface-sunken); color:var(--text-strong);">
        <option value="">All months</option>
      </select>

      <!-- ── By item detail ────────────────────────────────────────────────
           Apsara, 2026-09-02: "when i type sealed units in load detail, its
           not filtering. alternatively you give a check box as by item
           detail. then give text box, as user starts typing, show all
           matching item detail. once user select, show all matching load
           ticket."

           The free-text box above DOES match item descriptions — but when a
           search returns nothing there is no way to tell "no loads have
           this" from "the search is not looking there". This removes that
           doubt: you pick the material from a list the app itself offers, so
           a selection either matches loads or genuinely has none.

           Off by default, so the ordinary case is still one box. -->
      <label style="display:flex; align-items:center; gap:8px; margin-bottom:10px; font-size:13px; color:var(--text-body); cursor:pointer;">
        <input type="checkbox" id="byItemToggle" style="width:16px; height:16px; accent-color:var(--accent); cursor:pointer;">
        <span>Filter by item detail</span>
      </label>
      <div id="byItemPanel" class="hidden" style="margin-bottom:20px;">
        <div class="ld-desc-ac-wrap" style="position:relative;">
          <input id="itemFilterInput" type="text" autocomplete="off" placeholder="Start typing an item — e.g. sealed" style="width:100%; padding:11px 14px; border:1px solid var(--accent); border-radius:var(--radius-sm); font-size:13px; background:var(--surface-sunken); color:var(--text-strong);">
          <div id="itemFilterAc" class="ac-dropdown hidden"></div>
        </div>
        <div id="itemFilterChosen" style="margin-top:8px; font-size:12.5px; color:var(--text-muted);"></div>
      </div>
      <!-- Sellers holding unapplied advance money. Mirrors the website. -->
      <div id="draftStrip">${draftStripHtml()}</div>
      <div id="loadDeck">${loadDeckSectionsHtml(loadsCache, 'No loads yet.')}</div>
    </section>

    <!-- Record a payment against a load. Mirrors the website's modal exactly,
         per Apsara 2026-08-28 ("pay option not there in app"). Separate from
         the load form on purpose: a payment is recorded against a load that
         already exists, and folding it into the edit form would mean saving a
         load in order to record money. -->
    <div id="payModal" class="hidden modal-overlay">
      <div class="modal-shell" style="max-width:460px;">
        <div class="modal-stripe"></div>
        <div class="modal-head">
          <!-- Set per row in openPayModal: a sale takes money IN. -->
          <div id="payModalTitle" style="font-weight:700; text-transform:uppercase; font-size:14px;">Record payment</div>
          <button id="btnClosePay" class="btn" style="padding:4px 10px;">✕</button>
        </div>
        <div class="modal-body">
          <div id="payLoadSummary" style="font-family:var(--font-mono); font-size:12px; color:var(--text-muted); margin-bottom:16px;"></div>

          <!-- Prepaid credit, offered where the money is settled. ONE surface
               — see dashboard/index.html for why (she deleted a three-surface
               version the day it shipped, and Odoo offers advances inline on
               the bill for the same reason). Purchases only: a prepayment is
               money going OUT to a supplier. -->
          <div id="payPrepayBox" class="hidden" style="margin:-4px 0 16px; padding:10px 12px; border:1px solid var(--border); border-radius:8px;">
            <div id="payPrepayHeld" style="font-size:12px; line-height:1.5;"></div>
            <div id="payPrepayApplyRow" class="hidden" style="display:flex; gap:8px; align-items:center; margin-top:8px; flex-wrap:wrap;">
              <input id="pay_prepay_amount" type="number" step="any" placeholder="0.00" inputmode="decimal" style="width:120px;">
              <button id="btnApplyPrepay" type="button" class="btn btn-secondary" style="padding:6px 14px; font-size:11px;">Apply to this load</button>
              <span id="payPrepayNote" style="font-size:11px; color:var(--text-faint);"></span>
            </div>
          </div>
          <!-- ── ADJUST AGAINST THE OTHER SIDE ────────────────────────────
               Apsara, 2026-10-16: "when we pay load/sales-there should be a
               option to adjust against sale incase of load and against load
               in case of sale." Her case: "his seller is also a buyer, he
               owes you $3,000 on a sale, you're paying him $5,000 for a
               load, so you hand over $2,000 and the $3,000 is settled".

               KEPT IDENTICAL TO dashboard/app/13-loads-render.js. These two
               modals have drifted before and it is always the phone that is
               left behind — tests/settle-screens.js asserts both carry the
               same ids for that reason.

               ALWAYS VISIBLE, and it says why it is empty — see the website
               copy for why hiding it was wrong. -->
          <div id="paySettleBox" style="margin:-4px 0 16px; padding:10px 12px; border:1px solid var(--border); border-radius:8px;">
            <div id="paySettleLead" style="font-size:12px; line-height:1.5;"></div>
            <div style="display:flex; gap:8px; align-items:center; margin-top:8px; flex-wrap:wrap;">
              <select id="pay_settle_against" style="min-width:180px;"></select>
              <input id="pay_settle_amount" type="number" step="any" placeholder="0.00" inputmode="decimal" style="width:120px;">
              <button id="btnSettleAgainst" type="button" class="btn btn-secondary" style="padding:6px 14px; font-size:11px;">Settle it</button>
              <span id="paySettleNote" style="font-size:11px; color:var(--text-faint);"></span>
            </div>
          </div>
          <div id="payPrepayAsCreditRow" class="hidden" style="margin:-8px 0 16px;">
            <label style="display:flex; align-items:center; gap:8px; font-size:12px;">
              <input type="checkbox" id="pay_as_prepayment" style="width:16px; height:16px; margin:0;">
              <span id="payAsPrepaymentLabel">Hold as prepayment &mdash; credit this supplier, not this load</span>
            </label>
          </div>
          <div class="ld-grid-2">
            <div class="field">
              <label>Payment mode</label>
              <!-- TWO options, per Apsara 2026-09-16: "whn i talked about
                   receive payment-i was talking only about edge yard .. in
                   loads,there are two options na..create invoice and sale..in
                   receive payment-i should have only cash and bank transfer".

                   THIS MODAL IS THE YARD'S. Edge Metals keeps the full list
                   (Zelle, Wire, Cheque) in its own screens — she said Edge
                   Yard, twice, and narrowing the other company would be me
                   deciding something she did not ask about.

                   The server enforces the same two for yard load kinds, so
                   this is not the only thing holding the rule — a dropdown is
                   a suggestion, and the yard assistant records payments too.
                   Kept in step with helpers/payments.js's YARD_LOAD_MODES.

                   Filled per row rather than fixed — see the note in
                   dashboard/index.html's openPayModal. Her rule was about
                   RECEIVE PAYMENT (a sale); "Record payment" on a purchase is
                   money going out to a supplier, and those are paid by Zelle
                   and Wire. -->
              <select id="pay_mode"></select>
            </div>
            <div class="field"><label>Date</label><input id="pay_date" placeholder="MM/DD/YYYY" autocomplete="off"></div>
          </div>
          <!-- Mirrors dashboard/index.html. Bank only for Zelle and Wire; the
               text box only for Others. -->
          <div class="ld-grid-2" id="pay_bank_row" style="margin-top:14px; display:none;">
            <div class="field"><label>Bank</label><select id="pay_bank"></select></div>
            <div class="field" id="pay_bank_other_field" style="display:none;">
              <label>Which bank</label>
              <input id="pay_bank_other" placeholder="e.g. Wells Fargo" autocomplete="off" maxlength="40">
            </div>
          </div>
          <!-- Whose money paid it. Mirrors dashboard/index.html — Apsara,
               2026-09-17, "on selecting wire-it should ask me Payment via
               Edge Yard/Edge Metals", and on which modes, "Wire and Bank
               Transfer". Only on a PURCHASE: a sale takes Bank transfer as
               one of its two modes and receiving money must not get harder.
               No pre-selected company; she chose refuse-to-save over
               recording a gap, and a select opening on "Edge Yard" is
               answered by not reading it. -->
          <div class="field" id="pay_via_row" style="margin-top:14px; display:none;">
            <label for="pay_via">Payment via</label>
            <select id="pay_via"><option value="">Choose…</option></select>
          </div>
          <!-- ── WHICH CASH ────────────────────────────────────────────
               Apsara, 2026-09-21: "when they pay cash as mode of payment-ask
               to choose from bofa/chase." Cash only, and purchases only — a
               SALE takes cash IN, and asking which bank a customer's notes
               came out of is a question with no answer. Its own field, NOT
               the bank row above: helpers/banks.js refuses a bank on a cash
               payment and is right to. Mirrors dashboard/index.html. -->
          <div class="field" id="pay_cash_source_row" style="margin-top:14px; display:none;">
            <label for="pay_cash_bank">Which bank</label>
            <select id="pay_cash_bank" style="margin-bottom:10px;"></select>
            <label for="pay_cash_source" id="pay_cash_source_label">Which account</label>
            <select id="pay_cash_source"></select>
            <!-- Apsara, 2026-09-29: "it has every thing as 0.Bofa ,chase,AAA,
                 unassigned as 0". Four zeros and no explanation — the server
                 already names the fix but only after Pay is pressed. Same
                 note as the website; see dashboard/index.html for the
                 reasoning and for why it is shown, not enforced. -->
            <!-- Filled by JS: the sentence depends on WHICH situation she is
                 in — no cash at all, or cash filed under a source this list
                 cannot pay from. Empty here so neither version can be shown
                 before the figures arrive. -->
            <div id="pay_cash_empty" class="hidden" style="margin-top:10px; font-size:11.5px; line-height:1.5; color:#b45309;"></div>
          </div>
          <div class="ld-grid-2" style="margin-top:14px;">
            <div class="field"><label>Amount</label><input id="pay_amount" type="number" step="any" inputmode="decimal" placeholder="0.00"></div>
            <div class="field"><label>Reference (optional)</label><input id="pay_ref" placeholder="cheque no. / txn id" autocomplete="off"></div>
          </div>
          <div id="payPreview" style="margin-top:14px; font-family:var(--font-mono); font-size:12px;"></div>
          <div id="payHistory" style="margin-top:16px;"></div>
          <div style="margin-top:10px;"><span id="payErr" style="font-family:var(--font-mono); font-size:11px; color:var(--status-danger);"></span></div>
        </div>
        <div class="modal-foot">
          <button id="btnCancelPay" class="btn">Cancel</button>
          <button id="btnSavePay" class="btn btn-primary">Record payment</button>
        </div>
      </div>
    </div>

    <div id="loadModal" class="hidden modal-overlay">
      <div class="modal-shell">
        <div class="modal-stripe"></div>
        <div class="modal-head">
          <!-- applyLoadModalMode overwrites this on open; it is the shape the
               markup ships in, and must agree with the purchase branch there
               or the modal flickers the old word on first paint. -->
          <div id="loadModalTitle" style="font-weight:700; text-transform:uppercase; font-size:14px;">New load</div>
          <button id="btnCloseLoadModal" class="btn" style="padding:4px 10px;">✕</button>
        </div>
        <div class="modal-body">
          <!-- Offered, not applied. Restoring automatically would overwrite
               whatever is on screen with something typed hours ago. -->
          <div id="draftBar" class="hidden">
            <span id="draftBarText"></span>
            <span style="flex:1;"></span>
            <button id="btnRestoreDraft" class="btn" style="padding:6px 12px; font-size:12px;">Restore</button>
            <button id="btnDiscardDraft" class="btn" style="padding:6px 12px; font-size:12px;">Discard</button>
          </div>
          <!-- Mirrors the website form exactly, per Apsara 2026-08-28 ("this
               change should be there in mobile as well"):
                 - Buyer box removed. It was disabled and always showed the
                   same constant; the save payload has always sent
                   BUYER_FIXED_NAME directly rather than reading it, so it was
                   decorative.
                 - Date | Seller, then Address | Phone, so the counterparty
                   leads instead of sitting on the second row.
                 - Load description removed; every item row already carries
                   its own. The stored field is untouched, so older loads keep
                   theirs and still print it. -->
          <div class="ld-grid-2">
            <div class="field"><label>Date</label><input id="ld_date" placeholder="MM/DD/YYYY" autocomplete="off" style="max-width:170px;"></div>
            <div class="field" style="position:relative;">
              <label id="ld_party_label">Seller</label>
              <input id="ld_seller" placeholder="Seller name" autocomplete="off">
              <div id="ld_seller_ac" class="ac-dropdown hidden"></div>
            </div>
          </div>
          <div class="ld-grid-2" id="ld_party_row2" style="margin-top:14px;">
            <div class="field"><label id="ld_party_addr_label">Seller address</label><textarea id="ld_seller_address" placeholder="e.g. 456 Scrap Ave, Dallas, TX" rows="1" style="width:100%; padding:11px 12px; background:var(--surface-sunken); border:1px solid var(--border-default); border-radius:var(--radius-sm); color:var(--text-strong); outline:none; resize:vertical; font-family:inherit;"></textarea></div>
            <!-- Optional, per Apsara 2026-08-17. Only used server-side to
                 build the WhatsApp chat id for the "Send to seller" button
                 once a PDF exists; never required to save a load. -->
            <div class="field"><label>Seller phone (optional)</label><input id="ld_seller_phone" type="tel" placeholder="e.g. 8056944193 (country code auto-added)" autocomplete="off"></div>
          </div>

          <div style="margin-top:18px;">
            <div style="font-family:var(--font-mono); font-size:10px; font-weight:600; letter-spacing:.16em; text-transform:uppercase; color:var(--text-muted); margin-bottom:8px;">Item detail</div>
            <!-- Gross/tare weight capture moved IN HERE, per item (see
                 renderItemRows) — a load can be several items each weighed
                 separately, so there's no single load-level weight anymore.
                 Each row's photo button is a plain file input with
                 accept="image/*" (no "capture" attribute) — mobile browsers
                 show their native "Take Photo / Photo Library" sheet on tap,
                 camera AND upload from one control, no getUserMedia, no
                 HTTPS requirement. Desktop just gets a normal file picker. -->
            <div id="ld_items"></div>
            <button id="btnAddItemRow" type="button" class="btn" style="margin-top:4px; font-size:12px; padding:6px 12px;">+ Add item</button>
          </div>
          <!-- ── TRUCKING, DEDUCTED FROM WHAT THE SELLER IS PAID ──────────
               Apsara, 2026-09-20. Purchases only: applyLoadModalMode hides
               this whole block on a sale, because netting haulage out of what
               a CUSTOMER owes her would be an invention, not a deduction.
               Collapsed by default — most loads have no haulage, and three
               permanently empty boxes on a phone form is most of a screen.
               Mirrors dashboard/index.html. -->
          <div class="section" id="ld_trucking_section" style="margin-top:10px;">
            <details id="ld_trucking_details">
              <summary style="cursor:pointer; font-size:12px; color:var(--text-muted); user-select:none;">
                Trucking <span id="ld_trucking_badge" style="font-family:var(--font-mono); color:var(--text);"></span>
              </summary>
              <div style="margin-top:8px;">
                <div class="ld-grid-2" id="ld_trucking_row">
                  <div class="field"><label>Hauled by (optional)</label>
                    <input id="ld_trucking_company" type="text" placeholder="who collected it" autocomplete="off"></div>
                  <div class="field"><label>Deduct from seller ($)</label>
                    <input id="ld_trucking_amount" type="text" inputmode="decimal" placeholder="0.00" autocomplete="off"></div>
                </div>
                <div class="field"><label>Note (optional)</label>
                  <input id="ld_trucking_note" type="text" placeholder="e.g. collected from his shop" autocomplete="off"></div>
                <label style="display:flex; align-items:flex-start; gap:8px; margin-top:8px; font-size:12px; cursor:pointer;">
                  <input id="ld_trucking_bill" type="checkbox" style="margin-top:2px;">
                  <span>Also record this as a Trucker Bill<br>
                    <span style="color:var(--text-muted);">Tick when an outside hauler is owed. Leave clear if you collected it yourself — a bill would be a payable to nobody.</span></span>
                </label>
                <div id="ld_trucking_summary" style="margin-top:8px; font-family:var(--font-mono); font-size:11px; color:var(--text-muted);"></div>
              </div>
            </details>
          </div>
          <div style="margin-top:8px;"><span id="loadModalErr" style="font-family:var(--font-mono); font-size:11px; color:var(--status-danger);"></span></div>
        </div>
        <div class="modal-foot">
          <!-- Sits beside Save, because that is where the eye goes when
               wondering whether work is safe. -->
          <span id="draftStatus"></span>
          <span style="flex:1;"></span>
          <button id="btnCancelLoad" class="btn">Cancel</button>
          <button id="btnSaveLoad" class="btn btn-primary">Save load</button>
        </div>
      </div>
    </div>`;

  wireLoadsEvents();
}

// Mirrors validateLoadForSave in helpers/loads.js — per Apsara, once an item
// row has any data in it, description + gross + tare are all mandatory
// before Save works at all (no partial "gross now, tare later" saves). This
// client-side copy exists purely for instant feedback (no round trip); the
// server enforces the same rule as the real, non-bypassable gate. A row
// with nothing filled in at all is left alone — it's an unused spare row,
// not "an item" yet, same as the existing filter that drops it before send.
function validateItemsBeforeSave(items) {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    // Tare excluded here — see blankLoadItem's comment (defaults to "0" now,
    // which would otherwise make an untouched spare row look "filled in").
    const hasAnyData = it.description || it.gross_weight || it.price;
    if (!hasAnyData) continue;
    const label = it.description ? `"${it.description}"` : `#${i + 1}`;
    if (!it.description || !String(it.description).trim()) return `Item ${label}: description is required.`;
    if (it.gross_weight === null || it.gross_weight === undefined || it.gross_weight === '' || !isFinite(parseFloat(it.gross_weight))) return `Item ${label}: gross weight is required.`;
    if (it.tare_weight === null || it.tare_weight === undefined || it.tare_weight === '' || !isFinite(parseFloat(it.tare_weight))) return `Item ${label}: tare weight is required.`;
  }
  return null;
}

function wireLoadsEvents() {
  $('btnAddLoad').addEventListener('click', () => {
    resetLoadModal('purchase');
    $('loadModal').classList.remove('hidden');
  });
  if ($('btnAddSale')) $('btnAddSale').addEventListener('click', () => {
    resetLoadModal('sale');
    $('loadModal').classList.remove('hidden');
  });
  // Trucking inputs. Delegated on the section rather than wired per field so
  // this survives the form being re-rendered, same reason the item rows use a
  // delegated listener. Mirrors dashboard/index.html.
  const truckSection = $('ld_trucking_section');
  if (truckSection) {
    truckSection.addEventListener('input', (e) => {
      if (e.target && e.target.id === 'ld_trucking_bill') return;
      updateTruckingSummary();
      syncTruckerBillCheckbox();
    });
    // Her tap on the box is final — see syncTruckerBillCheckbox. `change` and
    // not `input`, because a checkbox toggled by the auto-sync above would
    // otherwise mark itself touched and switch the help off.
    truckSection.addEventListener('change', (e) => {
      if (e.target && e.target.id === 'ld_trucking_bill') e.target.dataset.touched = '1';
    });
  }

  const closeLoadModal = () => {
    stopCamera();
    $('loadModal').classList.add('hidden');
    // Show what was just autosaved. Without this the draft exists but
    // nothing on screen says so until the tab is reloaded.
    refreshDraftStrip();
  };
  $('btnClosePay').addEventListener('click', closePayModal);
  $('btnCancelPay').addEventListener('click', closePayModal);
  $('pay_amount').addEventListener('input', updatePayPreview);
  // Apply prepaid credit — Odoo's "Outstanding Debits: ADD", one click.
  // Oldest prepayment first and split across as many as it takes: credit is
  // held per transfer, each with its own date and bank, not as one pot.
  $('btnApplyPrepay').addEventListener('click', async () => {
    const btn = $('btnApplyPrepay');
    const amount = Number(($('pay_prepay_amount') || {}).value);
    $('payErr').textContent = '';
    if (!isFinite(amount) || amount <= 0) { $('payErr').textContent = 'How much of the credit should go on this load?'; return; }
    const held = (payPrepayCredit && payPrepayCredit.prepayments) || [];
    if (!held.length) { $('payErr').textContent = 'That supplier is not holding any prepayment now.'; return; }
    btn.disabled = true; btn.textContent = 'Applying…';
    try {
      const rows = held.slice().sort((a, b) => String(a.paid_on || '').localeCompare(String(b.paid_on || '')));
      let left = Math.round(amount * 100) / 100;
      for (const r of rows) {
        if (left <= 0.004) break;
        const take = Math.min(Number(r.remaining) || 0, left);
        if (take <= 0.004) continue;
        await api('/api/prepayments/apply', { method: 'POST', body: JSON.stringify({
          load_id: payingLoad.id, prepayment_id: r.id, amount: Math.round(take * 100) / 100,
        }) });
        left = Math.round((left - take) * 100) / 100;
      }
      if (left > 0.004) {
        $('payErr').textContent = `Applied what the credit had. ${payMoney(left)} of what you asked for was not covered.`;
      }
      await loadLoads();
      openPayModal(payingLoad.id, payingLoad.kind);
    } catch (e) {
      $('payErr').textContent = e.message || 'Could not apply that credit.';
    } finally {
      btn.disabled = false; btn.textContent = 'Apply to this load';
    }
  });
  if ($('btnSettleAgainst')) {
    $('btnSettleAgainst').addEventListener('click', () => settleAgainstSelected());
  }
  $('pay_mode').addEventListener('change', () => syncBankFields('pay'));
  $('pay_bank').addEventListener('change', () => syncBankFields('pay'));
  // Delegated: the history list re-renders after every change, so per-button
  // handlers would be lost.
  $('payHistory').addEventListener('click', async (ev) => {
    const del = ev.target.closest('.btn-del-pay');
    if (!del) return;
    // Short on purpose, and read standing up. The cash line only appears
    // when there IS cash to put back — promising it on a Wire would be false.
    const isCash = String(del.dataset.mode || '').toLowerCase() === 'cash';
    if (!confirm(`Delete this ${del.dataset.amount || ''} payment?\n`
      + `The load will owe it again${isCash ? ', and the cash goes back to petty cash' : ''}.`)) return;
    try {
      await api(`/api/payments/${encodeURIComponent(del.dataset.id)}`, { method: 'DELETE' });
      closePayModal();
      loadTab('loads');
    } catch (e) { $('payErr').textContent = e.message || 'Could not delete that payment.'; }
  });
  $('btnSavePay').addEventListener('click', async () => {
    if (!payingLoad) return;
    const amount = parseFloat($('pay_amount').value);
    $('payErr').textContent = '';
    if (!isFinite(amount) || amount <= 0) { $('payErr').textContent = 'Enter an amount greater than zero.'; return; }
    const btn = $('btnSavePay');
    btn.disabled = true; btn.textContent = 'Recording…';
    try {
      const body = {
        load_id: payingLoad.id, load_kind: payingLoad.kind, mode: $('pay_mode').value,
        // '' when the row is hidden, which the server reads as "not answered"
        // and refuses — deliberately the same value, so a hidden field and an
        // unanswered one cannot mean different things.
        paid_via: ($('pay_via') || {}).value || '',
        bank: bankValue('pay'),
        // ── WHICH CASH, ON A CASH PAYMENT ────────────────────────────────
        // A different field from `bank` above and it has to be: banks.js
        // REFUSES a bank on a cash payment ("paid cash from Chase" is not a
        // true sentence), while this says which trip to the bank the notes
        // came from. '' when hidden, which the server reads as unbanked cash.
        cash_source: ($('pay_cash_source') || {}).value || '',
        amount, paid_on: toIsoDate($('pay_date').value) || null, reference: $('pay_ref').value.trim() || null,
      };

      // Hold it as credit instead of putting it on this load. The SAME form
      // and the same resolved fields — mode, bank, Payment via, which cash —
      // with load_id and load_kind dropped, because a prepayment carrying
      // them would start counting against this load's balance. See
      // dashboard/index.html for the long version.
      const asPrepayment = !!($('pay_as_prepayment') && $('pay_as_prepayment').checked);
      if (asPrepayment) {
        if (payingLoad.kind === 'sale') {
          $('payErr').textContent = 'A prepayment is money paid OUT to a supplier, so it does not apply to a sale.';
          btn.disabled = false; btn.textContent = 'Record payment';
          return;
        }
        const { load_id, load_kind, ...rest } = body;
        try {
          const out = await api('/api/prepayments', { method: 'POST', body: JSON.stringify({
            ...rest, seller: payingLoad.seller,
          }) });
          await loadLoads();
          closePayModal();
          const held = ((out || {}).credit || {}).available;
          alert(`Recorded as a prepayment. ${payingLoad.seller} is now holding `
            + `${payMoney(held)} — apply it to a load from this same Pay box whenever you like.`);
          return;
        } catch (err2) {
          $('payErr').textContent = err2.message || 'Could not record that prepayment.';
          btn.disabled = false; btn.textContent = 'Record payment';
          return;
        }
      }

      try {
        await api('/api/payments', { method: 'POST', body: JSON.stringify(body) });
      } catch (err) {
        // ── THE NOMINATED BANK IS SHORT, BUT THE BOX IS NOT ──────────────
        // Apsara, 2026-09-21: "we have only 3000 in chase and 10000 in bofa
        // ... want to borrow from bofa?On confirmaton-allow them to pay."
        //
        // Checked BEFORE the partial-payment branch below, and the order
        // matters: this is a short BUCKET, not a short box. The partial
        // prompt would offer to hand the supplier 3,000 and leave 4,000
        // outstanding while 10,000 sits in the other account — two different
        // questions, and the wrong one first underpays a supplier for no
        // reason. Mirrors dashboard/index.html.
        if (err && err.code === 'PETTY_CASH_BUCKET_SHORT') {
          const lenders = (err.lenders || []).map((l) => `${l.source} (${fmtAmount(l.available)})`).join(', ');
          const ok = lenders && confirm(
            `${err.bucket} has only ${fmtAmount(err.bucket_available)}.\n` +
            `Borrow ${fmtAmount(err.shortfall)} from ${lenders}?`);
          if (!ok) { btn.disabled = false; btn.textContent = 'Record payment'; $('payErr').textContent = 'Nothing was recorded.'; return; }
          // The AMOUNT is not resent, same reasoning as allow_partial below:
          // the server re-reads every bucket under its own lock and works the
          // borrow out again at that moment.
          await api('/api/payments', { method: 'POST', body: JSON.stringify({ ...body, allow_borrow: true }) });
          closePayModal();
          loadTab('loads');
          return;
        }
        // ── not enough in the petty cash box ──────────────────────────────
        // Apsara 2026-09-02: "If cash is low while invoice amount is high -->
        // Make it as partial payment and notify user."
        //
        // The server REFUSES the first attempt and hands back how much there
        // is; this turns that into a decision the operator makes explicitly,
        // then retries with allow_partial. Handing a supplier less than the
        // ticket says is worth one deliberate tap — a message shown afterwards
        // could be missed, and they would leave thinking they were paid.
        //
        // The retry is the ONLY place allow_partial is ever sent, so the cap
        // cannot be reached without this prompt having been answered.
        const short = err && (err.code === 'PETTY_CASH_SHORT' || /petty cash/i.test(err.message || ''));
        const avail = err && err.available;
        if (!short || avail == null || avail <= 0) throw err;
        const ok = confirm(
          `Only ${fmtAmount(avail)} in petty cash — not enough for ${fmtAmount(amount)}.\n\n` +
          `Record ${fmtAmount(avail)} now and leave ${fmtAmount(Math.round((amount - avail) * 100) / 100)} outstanding?`);
        if (!ok) { btn.disabled = false; btn.textContent = 'Record payment'; $('payErr').textContent = 'Nothing was recorded.'; return; }
        // The amount is NOT sent as `avail`. The server re-reads the balance
        // under its own lock and caps to whatever is there at that moment —
        // which may be less again if someone else paid in between. Sending
        // the number this browser saw would reintroduce the race the lock
        // exists to close.
        await api('/api/payments', { method: 'POST', body: JSON.stringify({ ...body, allow_partial: true }) });
      }
      closePayModal();
      // Reloads rather than patching the card: the badge and the pending
      // figure come from the server's arithmetic, and recomputing either here
      // would be a second implementation waiting to disagree with the first.
      loadTab('loads');
    } catch (e) {
      $('payErr').textContent = e.message || 'Could not record that payment.';
    } finally {
      btn.disabled = false; btn.textContent = 'Record payment';
    }
  });
  // Autosave on any edit inside the load form. One delegated listener rather
  // than per-field wiring, because item rows are re-rendered constantly and
  // individually-bound handlers would be lost on every renderItemRows().
  $('loadModal').addEventListener('input', queueLoadDraftSave);
  $('loadModal').addEventListener('change', queueLoadDraftSave);
  $('btnRestoreDraft').addEventListener('click', restoreLoadDraft);
  $('btnDiscardDraft').addEventListener('click', discardOfferedDraft);
  $('btnCloseLoadModal').addEventListener('click', closeLoadModal);
  $('btnCancelLoad').addEventListener('click', closeLoadModal);

  $('btnAddItemRow').addEventListener('click', () => {
    syncItemsFromDom();
    currentLoadItems.push(blankLoadItem());
    renderItemRows();
  });

  // Photo buttons, weight/price inputs, and desc dropdowns are all wired
  // per-row inside renderItemRows() now (re-attached every render since
  // rows come and go) — nothing load-level left to wire here for weights.

  // ── Address Book autocomplete on Seller name ───────────────────────────
  const acBox = $('ld_seller_ac');
  const closeAc = () => { acBox.classList.add('hidden'); acBox.innerHTML = ''; };
  $('ld_seller').addEventListener('input', () => {
    const q = $('ld_seller').value.trim().toLowerCase();
    if (!q) { closeAc(); return; }
    // Cap raised 8->40 — mirrors dashboard/index.html, see its comment
    // (Apsara 2026-08-15: "not showing all matching hits").
    const matches = addressBookCache.filter(e => (e.aliases || []).some(a => a.toLowerCase().includes(q))).slice(0, 40);
    if (!matches.length) { closeAc(); return; }
    acBox.innerHTML = matches.map((e, i) => `<div class="ac-item" data-idx="${i}">${esc(e.aliases.join(' / '))}</div>`).join('');
    acBox.classList.remove('hidden');
    acBox.querySelectorAll('.ac-item').forEach((el, i) => {
      el.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        const entry = matches[i];
        $('ld_seller').value = entry.aliases[0];
        blurPicked($('ld_seller'));
        // Populate BOTH address and phone from the address book, per Apsara
        // 2026-08-20 ("i want address and phone number both should be
        // populated whatever is available"). Only fills what the entry
        // actually has — a contact with an address but no mobile fills the
        // address and leaves the phone box empty for you to type into, which
        // is exactly the case the backfill below then captures.
        // `|| ''` rather than skipping: picking a different seller must
        // CLEAR the previous one's details, otherwise the last seller's
        // address silently rides along on this load.
        $('ld_seller_address').value = entry.raw || '';
        if ($('ld_seller_phone')) $('ld_seller_phone').value = entry.mobile || '';
        closeAc();
      });
    });
  });
  $('ld_seller').addEventListener('blur', () => {
    setTimeout(closeAc, 150);
    // Typing the name out in full never fired the tap-to-pick handler above,
    // so the address and phone stayed empty for anyone who knows their
    // sellers by heart and doesn't wait for the dropdown. On blur, if what
    // was typed is an EXACT address-book name, fill in whatever's missing.
    //
    // Only fills fields that are currently BLANK — unlike the pick handler,
    // which clears and replaces. The difference is intent: tapping a
    // suggestion is choosing a contact, so their details should win; typing
    // a name is not a request to overwrite an address you may have just
    // deliberately corrected for this one load.
    const entry = addressBookExactMatch($('ld_seller').value);
    if (!entry) return;
    if (entry.raw && !$('ld_seller_address').value.trim()) $('ld_seller_address').value = entry.raw;
    if (entry.mobile && $('ld_seller_phone') && !$('ld_seller_phone').value.trim()) $('ld_seller_phone').value = entry.mobile;
  });

  // ── MORE GOING OUT THAN CAME IN ────────────────────────────────────────
  // Apsara, 2026-09-16: "Block the sale instead", and separately "Warn me if
  // al combo and aluminium combo,remember my selection-then next time let ai
  // decide based on knowldge".
  //
  // Mirrors dashboard/index.html, including the ORDER, which is the point:
  // the naming question first, the override second. Most of these refusals
  // are not a shortage — they are the same metal typed two ways, which is
  // what reported minus 300 lb of aluminium that was sitting in the yard.
  // Asking about the override first would train her to click through a prompt
  // whose real answer is "you typed it differently".
  // Takes the SAVE RESPONSE's stock_warning, not a thrown error: since
  // 2026-09-16 the server saves the sale and reports, rather than refusing
  // it. No sendSale to retry with, and no allow_negative anywhere.
  async function handleStockShort(warning) {
    const short = (warning && warning.shortfalls) || [];
    let learned = false;

    for (const s of short) {
      if (s.on_hand > 0) continue;   // a real partial shortage is not a spelling
      let suggestion = null;
      try {
        suggestion = await api('/api/item-aliases/suggest?item=' + encodeURIComponent(s.typed_as || s.item));
      } catch (e) { suggestion = null; }
      if (!suggestion || !suggestion.ask) continue;

      const same = confirm(
        `${suggestion.question}\n\n` +
        `Nothing has come IN as "${suggestion.unknown}", but there is stock of "${suggestion.match}".\n\n` +
        `OK = same material (remembered, and I stop asking)\n` +
        `Cancel = different`);
      // Both answers are stored — a "no" that is not remembered means the
      // same two alloys are queried every week until nobody reads the prompts.
      try {
        await api('/api/item-aliases', { method: 'POST', body: JSON.stringify({
          a: suggestion.unknown, b: suggestion.match, same,
        }) });
      } catch (e) { /* not fatal — the sale still has to be recordable */ }
      if (same) learned = true;
    }

    // ── THE WARNING ──────────────────────────────────────────────────────
    // The sale is ALREADY SAVED. This says what the numbers are and what it
    // usually means; it does not ask permission, because she said it should
    // not block — "just provide warning that can be overriden".
    //
    // Skipped when she has just answered an alias question, because the
    // shortfall may no longer be real: warning her that stock is short
    // immediately after she explained that it is not reads as not listening.
    if (learned) return;

    const lines = short.map((s) => '  · ' + (s.on_hand <= 0
      ? `${s.item}: nothing on hand, ${s.requested} going out`
      : `${s.item}: ${s.on_hand} on hand, ${s.requested} going out (short ${s.short_by})`)).join('\n');
    alert(
      `Saved — but this ships more than the yard has on record:\n\n${lines}\n\n` +
      `That usually means a purchase was never entered. Stock on hand will show a negative until it is.`);
  }

  $('btnSaveLoad').addEventListener('click', async () => {
    syncItemsFromDom();
    // The load-level description box is gone; an edit of an older load must
    // not wipe the description it already has, so reuse it.
    const desc = ($('ld_desc') ? $('ld_desc').value.trim() : (editingLoadDescription || ''));
    $('loadModalErr').textContent = '';

    const validationError = validateItemsBeforeSave(currentLoadItems);
    if (validationError) { $('loadModalErr').textContent = validationError; return; }

    const btn = $('btnSaveLoad');
    const isEdit = !!editingLoadId;
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const items = currentLoadItems
        .filter(it => (it.description || it.gross_weight || it.price))
        .map(it => ({
          description: it.description,
          gross_weight: it.gross_weight || null,
          // Blank -> 0, not null (2026-08-19). '|| null' also turned a
          // numeric 0 into null, so an explicit zero tare was being
          // discarded and came back blank on the next edit.
          tare_weight : (it.tare_weight ?? '') === '' ? 0 : it.tare_weight,
          price: it.price || null,
          unit : it.unit  || null,
          gross_photo_base64: it.grossPhoto ? it.grossPhoto.base64 : null,
          gross_photo_mime  : it.grossPhoto ? it.grossPhoto.mime   : null,
          tare_photo_base64 : it.tarePhoto  ? it.tarePhoto.base64  : null,
          tare_photo_mime   : it.tarePhoto  ? it.tarePhoto.mime    : null,
          // Existing photo links from before this edit — carried through so
          // an item that isn't re-photographed doesn't lose its photo (see
          // computeItem in helpers/loads.js, which preserves these when no
          // new base64 came in for that item). No-ops on a brand-new load.
          gross_photo_link: it.gross_photo_link || null,
          gross_photo_drive_id: it.gross_photo_drive_id || null,
          tare_photo_link : it.tare_photo_link  || null,
          tare_photo_drive_id : it.tare_photo_drive_id  || null,
        }));
      // Auto-grow the catalog: anything typed into a description box that
      // isn't already on the list gets added, per Apsara 2026-08-20 ("if
      // they type something which is not in list, add that to list").
      //
      // Fires on SAVE rather than on blur on purpose. Typing is messy —
      // people tab through fields, retype, correct themselves — and adding
      // on every blur would fill the catalog with half-words like "Alum"
      // that then need cleaning up in Settings. Saving a load is the point
      // at which a description is a real one someone committed to.
      //
      // Fire-and-forget: the load is already saved, and a failure here
      // costs nothing but retyping the description next time.
      const knownDescs = itemDescOptions().map(d => d.toLowerCase());
      const newDescs = [...new Set(items.map(it => it.description).filter(Boolean))]
        .filter(d => !knownDescs.includes(d.toLowerCase()));
      // Registered with the server, and added LOCALLY FIRST — Bose,
      // 2026-09-02: "sometimes newly added items not coming."
      //
      // It used to push onto customItemTypes only inside .then(), so if the
      // POST failed the description was never offered again, and the failure
      // was swallowed whole by .catch(() => {}). Two silent ways to lose it.
      //
      // Pushing first means the description is available for the rest of this
      // session no matter what the network does; the POST is what makes it
      // survive to the next one. One retry, because this fires at the same
      // moment as the load save and the two compete for a thin yard
      // connection — a single transient failure should not cost the entry.
      //
      // STILL fire-and-forget on the load itself: the load is already saved
      // and must never fail because a catalogue entry did not stick. But it
      // now LOGS rather than swallowing, so "it's not remembering my item
      // names" is diagnosable from the console instead of invisible.
      newDescs.forEach(d => {
        rememberNewItemType(d);
        const post = () => api('/api/item-types', { method: 'POST', body: JSON.stringify({ description: d }) });
        post()
          .catch(() => new Promise(r => setTimeout(r, 1200)).then(post))
          .catch((err) => console.warn('[items] could not save the new description ' + JSON.stringify(d) + ' to the catalogue — it will work this session but may not be offered next time:', err && err.message));
      });
      const payload = {
        date: toIsoDate($('ld_date').value) || null,
        buyer: BUYER_FIXED_NAME,
        seller: $('ld_seller').value.trim() || null,
        seller_address: $('ld_seller_address').value.trim() || null,
        seller_phone: normalizeSellerPhone($('ld_seller_phone').value),
        description: desc,
        items,
        weight_unit: 'lb',
        // Always sent by THIS client, blank or not — which is what makes a
        // cleared box actually clear the deduction. The server treats an
        // absent key as "leave it alone" for the sake of an older APK (see
        // PUT /api/loads/:id), so a client that knows about the field has to
        // keep saying so.
        trucking_company: ($('ld_trucking_company') ? $('ld_trucking_company').value.trim() : '') || null,
        trucking_amount: (() => {
          const raw = String($('ld_trucking_amount') ? $('ld_trucking_amount').value : '').replace(/[^0-9.\-]/g, '');
          const n = parseFloat(raw);
          return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
        })(),
        trucking_note: ($('ld_trucking_note') ? $('ld_trucking_note').value.trim() : '') || null,
        // The offer, exactly as she left it. helpers/loadTruckerBill.js does
        // every check that matters — no amount, no company, one already on
        // file — and reports back rather than throwing, so a ticked box can
        // never cost her the load.
        create_trucker_bill: !!($('ld_trucking_bill') && $('ld_trucking_bill').checked),
        created_by: (typeof ROLE !== 'undefined' ? ROLE : 'user'),
        // Minted when the form opened — see resetLoadModal. Sent on CREATE
        // only; it is meaningless on an edit, which targets a known id.
        client_request_id: saveTicket,
        // ── THE DRAFT THIS IS BEING TYPED UP FROM ──────────────────────
        // Apsara, 2026-09-29, on a load that generated twice: "ALWAYS ONE
        // LOAD SHOULD BE CREATED". The ticket above is per save attempt, so
        // Save → edit → Continue mints two of them and both are honoured.
        // This one is per draft and the server never forgets it, so the
        // second save gets the FIRST load back. Null when the form never
        // autosaved, which the server reads as "no draft".
        draft_id: currentDraftId,
      };
      if (loadModalMode === 'sale') {
        // Outbound: the party typed into the seller field IS the buyer here,
        // and Edge Trading is the seller. Sent as its own record type rather
        // than a negative purchase — see applyLoadModalMode for why that
        // makes the inventory maths and the rollback free.
        const salePayload = {
          date: payload.date,
          buyer: payload.seller,
          buyer_address: payload.seller_address,
          description: payload.description,
          weight_unit: payload.weight_unit,
          items: payload.items,
          client_request_id: payload.client_request_id,
          draft_id: payload.draft_id,   // one draft, one load — see above
        };
        const sendSale = (extra) => (isEdit
          ? api(`/api/outbound-loads/${encodeURIComponent(editingLoadId)}`, { method: 'PUT', body: JSON.stringify({ ...salePayload, ...extra }) })
          : api('/api/outbound-loads', { method: 'POST', body: JSON.stringify({ ...salePayload, ...extra }) }));
        // ── SAVED FIRST, WARNED AFTER ──────────────────────────────────
        // Apsara, 2026-09-16: "negative inventory should not block a sale in
        // edge yard.just provide warning that can be overriden". The server
        // no longer refuses; it saves and reports. So there is no retry, no
        // allow_negative and no confirm in the way of the save.
        const saved = await sendSale();
        if (saved && saved.stock_warning) await handleStockShort(saved.stock_warning);
      } else if (isEdit) {
        const savedLoad = await api(`/api/loads/${encodeURIComponent(editingLoadId)}`, { method: 'PUT', body: JSON.stringify(payload) });
        reportTruckerBill(savedLoad && savedLoad.trucker_bill);
      } else {
        const savedLoad = await api('/api/loads', { method: 'POST', body: JSON.stringify(payload) });
        reportTruckerBill(savedLoad && savedLoad.trucker_bill);
      }
      // Cleared only AFTER the request resolves — clearing before would throw
      // the recovery copy away at the moment a failed save makes it most
      // valuable.
      clearLoadDraft();
      // Address Book auto-grow/backfill — per Apsara 2026-08-17: "when i
      // type a new name if it is not there in address book, it should be
      // created as new contact with name, address(optional), phone
      // number(optional)... for the contact which exists, if phone number
      // not there, on entering this - it should get updated in address
      // book." Two distinct cases, both fire-and-forget (the load itself
      // already saved successfully — this is a convenience that must
      // never surface as a load-save error):
      //   1. No existing contact for this seller name at all -> create
      //      one. Address and phone both optional now (helpers/
      //      addressBook.js's validateEntryInput no longer requires raw).
      //   2. Existing contact, but it has no phone on file and THIS load
      //      has one -> backfill just the phone, leaving name/address as
      //      they already were. Explicitly does NOT touch the address on
      //      an existing contact — only asked to fill in a missing phone.
      if (payload.seller) {
        const existingContact = addressBookExactMatch(payload.seller);
        if (!existingContact) {
          api('/api/address-book', { method: 'POST', body: JSON.stringify({ aliases: [payload.seller], raw: payload.seller_address || '', mobile: payload.seller_phone || null }) })
            // Into BOTH lists. After a refresh these are the same array and
            // one push would be enough, but relying on that is a trap for
            // whoever next reassigns one of them.
            .then((entry) => { addressBookCache.push(entry); if (docsAddressBook !== addressBookCache) docsAddressBook.push(entry); })
            .catch(() => {});
        } else {
          // Backfill BLANK fields only. Extended 2026-08-20 from phone-only
          // to address-as-well, per Apsara ("suppose that if address only
          // there in address book but not mobile, if i type mobile number,
          // address book should be updating"). The rule is symmetric and,
          // more importantly, strictly additive: a field is written ONLY
          // when the address book has nothing there and this load does.
          //
          // It deliberately does NOT overwrite a value that already exists,
          // even when the two disagree. A yard hand correcting a delivery
          // address for one load must not silently rewrite the company's
          // address book for every future load — that edit belongs in
          // Settings, where it's visible and deliberate. Silent overwrite
          // is how a book of good addresses quietly rots.
          const patch = {};
          if (payload.seller_phone && !existingContact.mobile) patch.mobile = payload.seller_phone;
          if (payload.seller_address && !existingContact.raw) patch.raw = payload.seller_address;
          if (Object.keys(patch).length) {
            api(`/api/address-book/${encodeURIComponent(existingContact.id)}`, {
              method: 'PUT',
              body: JSON.stringify({
                aliases: existingContact.aliases,
                raw: patch.raw !== undefined ? patch.raw : (existingContact.raw || ''),
                mobile: patch.mobile !== undefined ? patch.mobile : (existingContact.mobile || null),
                // PUT replaces tags wholesale, so echo the existing ones back
                // — omitting them would blank the seller/buyer tags as a side
                // effect of filling in a phone number.
                tags: existingContact.tags || [],
                locked: !!existingContact.manually_edited,
              }),
            })
              .then((updated) => { Object.assign(existingContact, updated); })
              .catch(() => {});
          }
        }
      }
      stopCamera();
      $('loadModal').classList.add('hidden');
      loadTab('loads');
    } catch (err) {
      $('loadModalErr').textContent = err.message;
      // Wrong admin password (or any other failure) — clear it rather than
      // silently resubmitting the same rejected password if Save is
      // clicked again. User has to click Edit again to re-prompt.
    } finally {
      // DERIVED, not hardcoded. This read 'Create invoice' flat, so a failed
      // save on a SALE restored the PURCHASE label and the Save button on a
      // sale form said "Create invoice" until the modal was closed and
      // reopened. Pre-existing, found on 2026-10-15 while renaming the
      // purchase label — left in place it would simply have said "Save load"
      // on a sale instead, which is the same bug with a different word.
      btn.disabled = false;
      btn.textContent = isEdit ? 'Save changes' : (loadModalMode === 'sale' ? 'Record sale' : 'Save load');
    }
  });

  wireDeckEvents();

  // Search re-renders JUST #loadDeck (not the whole tab via loadTab/renderLoads)
  // so it can filter loadsCache client-side on every keystroke without a
  // server round trip and without losing focus on the search box itself.
  const searchInput = $('loadSearch');
  const itemToggle = $('byItemToggle');
  const itemInput = $('itemFilterInput');
  const itemAc = $('itemFilterAc');
  const itemChosen = $('itemFilterChosen');

  // ── THE MONTH CONTROL ─────────────────────────────────────────────────
  // Options come from the DATA (loadMonthsPresent), not from a calendar:
  // offering a month with no loads is a control that answers "no loads" and
  // reads as broken.
  //
  // The selected value is preserved across repaints. Rebuilding the <select>
  // without putting the choice back would silently reset the filter every
  // time a load was saved, which looks like the filter forgetting itself.
  const paintLoadMonthFilter = () => {
    const sel = $('loadMonthFilter');
    if (!sel) return;
    const months = loadMonthsPresent(loadsCache);
    // A month she has filtered to must stay in the list even if the other
    // filters have narrowed it to nothing — otherwise the <select> loses the
    // value it is showing and silently falls back to All.
    if (loadMonthFilter && !months.some((m) => m.key === loadMonthFilter)) {
      months.unshift({ key: loadMonthFilter, count: 0, label: loadMonthLabel(loadMonthFilter) });
    }
    const want = `${loadMonthFilter}|${months.map((m) => `${m.key}:${m.count}`).join(',')}`;
    // Only touch the DOM when something actually changed — rewriting a
    // <select> while it has focus closes the dropdown under her finger.
    if (sel.dataset.state === want) return;
    sel.dataset.state = want;
    sel.innerHTML = `<option value="">All months</option>`
      + months.map((m) => `<option value="${esc(m.key)}"${m.key === loadMonthFilter ? ' selected' : ''}>`
        + `${esc(m.label)} — ${m.count} load${m.count === 1 ? '' : 's'}</option>`).join('');
  };

  // ── one place that repaints the deck ──────────────────────────────────
  // Both controls funnel through here. Two paths that each render the deck
  // is how they end up disagreeing about what is on screen.
  const repaintDeck = () => {
    const q = String(searchInput ? searchInput.value : '').trim();
    // Kind FIRST, then text, then item detail. Each narrows what the next
    // one sees, so the three compose instead of competing — the failure the
    // removed item-detail dropdown had.
    let rows = filterLoadsByKind(loadsCache, loadKindFilter);
    rows = filterLoads(rows, q);
    if (chosenItemDetail) rows = loadsWithItem(rows, chosenItemDetail);
    // ── MONTH, LAST IN THE CHAIN (2026-10-02) ───────────────────────────
    // Apsara: "Also give an option to filter by month.If they select that
    // month -all that months load should be visible expanded."
    //
    // A FILTER, so it composes with the three above rather than competing —
    // the failure the removed item-detail dropdown had. Last, because it is
    // the coarsest: narrowing to October and then searching inside it is the
    // order she would say it in.
    //
    // She chose "show only that month, fully expanded", so it hides the other
    // months rather than merely opening one. Clearing it puts the normal view
    // back.
    if (loadMonthFilter) rows = filterLoadsByMonth(rows, loadMonthFilter);
    const narrowed = !!q || !!chosenItemDetail || loadKindFilter !== 'all';
    paintLoadKindBar(rows.length);
    // flat while EITHER is on. Once you have asked for one material you are
    // no longer looking for a day, and only the first date section renders
    // open — grouping would hide most of the answer. Clearing both puts the
    // date sections back.
    $('loadDeck').innerHTML = loadDeckSectionsHtml(rows,
      (narrowed || loadMonthFilter) ? 'No loads match that filter.' : 'No loads yet.',
      // flat stays driven by search/item/kind only. A month is a DATE
      // narrowing, so the day headings are exactly what she still wants —
      // flattening October would throw away the thing she filtered by.
      { flat: narrowed, allOpen: !!loadMonthFilter });
    // Rebuilt from the loads each paint: a month with nothing in it must not
    // be offerable, and a newly-added load can create a month that was not
    // there when the page loaded.
    paintLoadMonthFilter();
    wireDeckEvents();
    if (itemChosen) {
      // Says what was picked and HOW MANY loads carry it, so a genuine zero
      // is unmistakable — that ambiguity is the whole reason this control
      // exists ("its not filtering" could mean either thing).
      itemChosen.innerHTML = chosenItemDetail
        ? `Showing <strong style="color:var(--text-strong);">${esc(chosenItemDetail)}</strong> — ${rows.length} load${rows.length === 1 ? '' : 's'} <button id="itemFilterClear" class="btn" style="font-size:11px; padding:3px 9px; margin-left:6px;">Clear</button>`
        : '';
      const clr = $('itemFilterClear');
      if (clr) clr.addEventListener('click', () => {
        chosenItemDetail = '';
        if (itemInput) itemInput.value = '';
        repaintDeck();
      });
    }
  };

  // ── THE KIND BAR GOES THROUGH THE SAME REPAINT ───────────────────────
  // Delegated on the container, because paintLoadKindBar rebuilds the buttons
  // on every repaint to move the highlight and the count — handlers bound to
  // the buttons themselves would be thrown away with them, and the control
  // would work exactly once.
  const kindBar = $('loadKindBar');
  if (kindBar) kindBar.addEventListener('click', (ev) => {
    const b = ev.target.closest('.load-kind-btn');
    if (!b || b.dataset.kind === loadKindFilter) return;
    loadKindFilter = b.dataset.kind;
    try { localStorage.setItem('loadKindFilter', loadKindFilter); } catch (e) {}
    repaintDeck();
  });
  paintLoadKindBar();

  if (searchInput) searchInput.addEventListener('input', repaintDeck);
  // ── THE MONTH CONTROL ────────────────────────────────────────────────
  // Through repaintDeck like every other control — a second render path is
  // how two of them end up disagreeing about what is on screen.
  const monthSel = $('loadMonthFilter');
  if (monthSel) {
    monthSel.addEventListener('change', () => {
      loadMonthFilter = String(monthSel.value || '');
      repaintDeck();
      // Back to the top: picking October and being left halfway down last
      // week's loads reads as nothing having happened.
      const deck = $('loadDeck');
      if (deck && loadMonthFilter && deck.scrollIntoView) {
        deck.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    });
  }

  if (itemToggle && itemInput && itemAc) {
    const closeAc = () => itemAc.classList.add('hidden');

    // Suggestions come from the deck, so anything offered has loads behind
    // it. Empty box shows the whole list — someone who does not remember the
    // exact wording needs a way in, which is the same reasoning as the item
    // description type-ahead in the load form.
    const showMatches = () => {
      const q = itemInput.value.trim().toLowerCase();
      const all = itemDetailsInLoads(loadsCache);
      const matches = q ? all.filter(d => d.toLowerCase().includes(q)) : all;
      if (!matches.length) {
        itemAc.innerHTML = `<div class="ac-item" style="color:var(--text-faint); cursor:default;">No item matches "${esc(itemInput.value.trim())}"</div>`;
        itemAc.classList.remove('hidden');
        return;
      }
      itemAc.innerHTML = matches.map(d => {
        const n = loadsWithItem(loadsCache, d).length;
        return `<div class="ac-item" data-val="${esc(d)}">${esc(d)} <span style="color:var(--text-faint); font-size:11px;">${n} load${n === 1 ? '' : 's'}</span></div>`;
      }).join('');
      itemAc.classList.remove('hidden');
      itemAc.querySelectorAll('.ac-item[data-val]').forEach(el => el.addEventListener('mousedown', (ev) => {
        // mousedown, not click: blur fires first on a click and would close
        // the menu before the click landed. Same fix as the load form's
        // description type-ahead.
        ev.preventDefault();
        chosenItemDetail = el.dataset.val;
        itemInput.value = el.dataset.val;
        blurPicked(itemInput);
        closeAc();
        repaintDeck();
      }));
    };

    itemToggle.addEventListener('change', () => {
      $('byItemPanel').classList.toggle('hidden', !itemToggle.checked);
      if (itemToggle.checked) { itemInput.focus(); showMatches(); }
      else {
        // Unticking clears the filter. Leaving it applied while its control
        // is hidden is the worst of both — a deck that is filtered with
        // nothing on screen explaining why.
        chosenItemDetail = '';
        itemInput.value = '';
        closeAc();
      }
      repaintDeck();
    });

    itemInput.addEventListener('focus', showMatches);
    itemInput.addEventListener('input', () => {
      // Typing past a chosen item drops the selection, so the deck is never
      // filtered by something the box no longer says.
      if (chosenItemDetail && itemInput.value.trim().toLowerCase() !== chosenItemDetail.toLowerCase()) {
        chosenItemDetail = '';
        repaintDeck();
      }
      showMatches();
    });
    itemInput.addEventListener('blur', () => setTimeout(closeAc, 120));
    itemInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { closeAc(); return; }
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      // Enter takes the only remaining match — the common case after typing
      // three letters — rather than submitting anything.
      const only = itemAc.querySelectorAll('.ac-item[data-val]');
      if (only.length === 1) {
        chosenItemDetail = only[0].dataset.val;
        itemInput.value = chosenItemDetail;
        closeAc();
        repaintDeck();
      }
    });
  }

  renderItemRows();
}

// Wires the "Generate PDF" buttons inside #loadDeck — pulled out of
// wireLoadsEvents so it can be re-run after every search-filter re-render
// (new button elements each time) without re-wiring the whole tab.
function wireDeckEvents() {
  document.querySelectorAll('.btn-gen-pdf').forEach(btn => btn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    // Per Apsara 2026-08-15: the Summary section (item-type breakdown +
    // totals box) is no longer decided automatically — ask each time.
    const includeSummary = await askYesNo('Include the Summary section (totals + item-type breakdown) on this PDF?');
    const originalLabel = btn.textContent;
    btn.disabled = true; btn.textContent = 'Generating…';
    try {
      // Routed by kind — a sale's ticket is generated from the outbound
      // store and prints as a SALE TICKET naming the buyer.
      const base = btn.dataset.kind === 'sale' ? '/api/outbound-loads/' : '/api/loads/';
      await api(`${base}${encodeURIComponent(btn.dataset.id)}/generate-pdf`, { method: 'POST', body: JSON.stringify({ includeSummary }) });
      loadTab('loads');
    } catch (err) {
      alert('PDF generation failed: ' + err.message);
      // Restore whichever label this button started with — the same
      // handler now serves both 'Generate PDF' and 'Regenerate PDF',
      // and hardcoding one relabels the other on failure.
      btn.disabled = false; btn.textContent = originalLabel;
    }
  }));
  // Draft strip actions, delegated on the strip so a re-render does not leave
  // dead handlers behind.
  const dstrip = $('draftStrip');
  if (dstrip) {
    dstrip.addEventListener('click', async (ev) => {
      const resume = ev.target.closest('.btn-resume-draft');
      if (resume) { resumeDraft(resume.dataset.id); return; }
      const drop = ev.target.closest('.btn-drop-draft');
      if (drop) {
        if (!confirm('Delete this unfinished load?\n\nIt has not been saved as a load, so nothing else is affected.')) return;
        try { await api(`/api/load-drafts/${encodeURIComponent(drop.dataset.id)}`, { method: 'DELETE' }); } catch (e) {}
        pendingDrafts = pendingDrafts.filter(x => x.id !== drop.dataset.id);
        dstrip.innerHTML = draftStripHtml();
      }
    });
  }


  document.querySelectorAll('.btn-pay-load').forEach(btn => btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openPayModal(btn.dataset.id, btn.dataset.kind);
  }));

  // The paid badge, on the Jarvis profile — the only way into a load that
  // already reads settled. paymentBadgeHtml only renders this hook for
  // IS_SUPER; the modal opens with the entry fields hidden.
  document.querySelectorAll('.pay-badge-open').forEach(el => el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openPayModal(el.dataset.openPayments, el.dataset.kind, { historyOnly: true });
  }));

  document.querySelectorAll('.btn-edit-load').forEach(btn => btn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const load = loadsCache.find(l => l.id === btn.dataset.id);
    if (!load) return;
    // Reopen in the mode this record belongs to, so a sale edits as a sale
    // and saves back to the outbound store rather than becoming a purchase.
    applyLoadModalMode(load._kind === 'sale' ? 'sale' : 'purchase');
    // NO EDIT LOCK — removed 2026-08-20 per Apsara ("remove the admin
    // password asking for editing even for staff access"). The lock, the
    // prompt and the admin-only carve-out are all gone; any authorised user
    // opens the form directly.
    // Safe because the PDF is not the record — loads.json is. editLoad()
    // clears the PDF links and resets status to 'open' on every edit, so a
    // corrected load can't keep serving a stale ticket as current; Regenerate
    // PDF rebuilds it from the corrected numbers.
    openEditLoadModal(load);
  }));
  document.querySelectorAll('.btn-sign-load').forEach(btn => btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openSignPad(btn.dataset.id);
  }));
  document.querySelectorAll('.btn-send-seller').forEach(btn => btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const load = loadsCache.find(l => l.id === btn.dataset.id);
    if (!load) return;
    if (!load.seller_phone) {
      alert('No phone number on file for this seller. Click Edit to add one first.');
      return;
    }
    if (!load.pdf_link) {
      alert('Generate the PDF first.');
      return;
    }
    // Opens the seller's chat in the PHONE'S OWN WhatsApp app instead of
    // sending through the server — per Apsara 2026-08-17 ("just use the
    // phone's existing whatsapp to send this"). wa.me is WhatsApp's own
    // deep-link domain; Android/WhatsApp Desktop both register as its
    // handler, so this hands off to the real WhatsApp app pre-filled with
    // a message containing the PDF link, ready to tap Send.
    // Replaces the earlier POST /api/loads/:id/send-to-seller route,
    // which goes through whatsapp-web.js's automated session — that path
    // is currently broken by an unresolved upstream "No LID for user"
    // bug (WhatsApp's ongoing LID rollout breaking programmatic sends;
    // multiple open whatsapp-web.js GitHub issues, still unfixed as of
    // Jan 2026 — see the PM2 log triage this same day). This path never
    // touches that broken automation: it's the same as manually opening
    // WhatsApp and typing the message, just pre-filled. Trade-off is one
    // manual tap on Send inside WhatsApp — can't be fully automatic this
    // way, but it can't silently fail on a library bug either.
    const text = `Edge Trading — Load ${load.id} ticket: ${load.pdf_link}`;
    const url = `https://wa.me/${load.seller_phone}?text=${encodeURIComponent(text)}`;
    // CORRECTED 2026-08-17 (was window.open(url, '_blank'), which Apsara
    // confirmed does nothing when tapped — "it is pressed, but nothing
    // happening"). Android's WebView doesn't actually support real
    // popup/multi-window behavior unless the host app explicitly wires up
    // WebChromeClient.onCreateWindow, which this Capacitor app doesn't —
    // so window.open() silently no-ops there, even though it works fine
    // in a normal desktop browser (that's why dashboard/index.html's
    // identical button, left untouched, is fine with window.open).
    // Setting location.href instead is a real top-level navigation, which
    // IS something Android's WebView intercepts and hands off to the OS
    // for an external domain like wa.me — that's what actually opens
    // WhatsApp. Navigating away like this is fine here: this app has one
    // screen (Loads), and Android keeps it on the back stack, so the
    // hardware/gesture Back button returns to Jarvis after WhatsApp opens.
    window.location.href = url;
  }));
  document.querySelectorAll('.btn-delete-load').forEach(btn => btn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    // Copy corrected 2026-08-15 — used to say photos/PDFs "are kept"; per
    // Apsara they should now be removed too (api.js's DELETE route trashes
    // the load's whole Drive subfolder — recoverable for 30 days).
    const rec = loadsCache.find(l => l.id === btn.dataset.id);
    const isSale = rec && rec._kind === 'sale';
    // Different consequences, so different wording. Deleting a SALE puts the
    // material back on hand — that's the rollback she asked for, and it
    // happens simply because inventory nets purchases against sales rather
    // than storing a separate balance to unwind.
    // ── the ordinary confirm ──────────────────────────────────────────────
    // Reworded 2026-09-03 (Apsara: "ask Are you sure you want to delete
    // etc..something similar"). It now opens with the question instead of
    // burying it after the consequences — on a phone the old text wrapped to
    // three lines and the actual decision was in the middle of them.
    //
    // Same prompt for every role. Delete on an UNPAID load is deliberately NOT
    // role-gated: staff record loads, so staff must be able to remove one they
    // just entered wrong, which is the case this button exists for. Confirmed
    // 2026-09-03 ("for staff — show delete option before payment").
    if (!confirm(isSale
      ? `Are you sure you want to delete sale ${btn.dataset.id}?\n\nThe material goes back into inventory as on hand.`
      : `Are you sure you want to delete load ${btn.dataset.id}?\n\nIt is removed from Loads, and its photos and ticket PDFs are trashed in Drive (recoverable from Drive's Trash for 30 days).`)) return;
    // ── a SECOND prompt when money is involved ────────────────────────────
    // Only the Jarvis profile ever reaches this, because nobody else is shown
    // the button on a paid load (loadIsDeletable) and the server refuses it
    // anyway. The first prompt talks about photos and PDFs; this one names the
    // amount, because "delete this load" and "erase the record of $12,000
    // having been paid" deserve different moments of attention, and the whole
    // point of the profile is that it does not stop you.
    if (!isSale) {
      const paid = rec && rec.payment && Number(rec.payment.paid);
      if (paid > 0 && !confirm(
        `${btn.dataset.id} has ${payMoney(paid)} recorded as paid.\n\n`
        + `Deleting it removes those payment records too. Any CASH among them goes back into petty cash.\n\n`
        + `This is logged against the Jarvis profile. Continue?`)) {
        return;
      }
    }
    btn.disabled = true; btn.textContent = 'Deleting…';
    try {
      await api(`${isSale ? '/api/outbound-loads/' : '/api/loads/'}${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
      loadTab('loads');
    } catch (err) {
      alert('Delete failed: ' + err.message);
      btn.disabled = false; btn.textContent = 'Delete';
    }
  }));
  // .btn-renumber-load handler removed 2026-08-17 along with the button
  // itself — see loadCardHtml's comment.
}


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
