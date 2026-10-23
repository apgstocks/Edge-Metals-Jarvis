// mobile-app/www/app/02-cache-catalogue.js — split from mobile-app/www/index.html's <script> (helpers/sourceParts.js reconstructs the original)
// ── the GET cache ─────────────────────────────────────────────────────────
// Apsara 2026-09-03: "reduce the time taken to load each tab. it is taking 5
// seconds every time post clicking tab."
//
// The bulk of that was payload — /api/loads was shipping 4.4 MB of signature
// images the list never drew, now stripped server-side. This is the other
// half: switching back to a tab you were just on should not go to the network
// at all before showing you something.
//
// STALE-WHILE-REVALIDATE. A cached response is painted immediately and the
// real request runs anyway, repainting when it lands. So the screen is never
// blank, and never more than one round trip out of date.
//
// THE RULE THAT MAKES IT SAFE: any successful write empties the whole cache.
// Not the entry for the path that was written — the whole thing. A payment
// POST changes /api/loads, /api/petty-cash, /api/reports/spend and
// /api/trucker-bills, and working out that dependency graph correctly at
// thirty call sites is a bet this app should not take with money on screen.
// Emptying everything costs one extra fetch and cannot be wrong.
//
// Kept in memory only, never localStorage: a stale balance surviving an app
// restart is exactly the kind of number someone acts on.
const apiCache = new Map();
const API_CACHE_TTL_MS = 60000;   // a minute; the revalidate makes this a
                                  // floor on staleness, not a promise
function apiCacheClear() { apiCache.clear(); }
function apiCachePeek(path) {
  const hit = apiCache.get(path);
  if (!hit) return undefined;
  if (Date.now() - hit.at > API_CACHE_TTL_MS) { apiCache.delete(path); return undefined; }
  // A structured clone, so a caller that mutates what it renders cannot
  // corrupt what the next paint reads.
  try { return JSON.parse(JSON.stringify(hit.data)); } catch (e) { return undefined; }
}

// ── the fast paint ────────────────────────────────────────────────────────
// While this is on, a GET is answered from the cache and never touches the
// network.
//
// THE MISS IS CHECKED BEFORE THE RENDER STARTS, NOT DURING IT. The first
// version threw a "cache miss" error from api() and expected the wrapper to
// catch it. It never got there: FOUR places in the render path catch their own
// errors, and the outermost one paints err.message into the view — so opening
// a tab printed the words "cache miss" on screen for a moment. Apsara saw it
// within minutes.
//
// Worse were the quiet ones. The Loads deck fetches sales and drafts with
// `.catch(() => [])`, so a miss there would have painted a deck with the sales
// silently missing; the Documents tab swallows its address-book failure the
// same way. An abort mechanism that depends on nobody up the stack catching
// errors is not an abort mechanism — it is a hope.
//
// So instead: remember which GET paths each tab used last time, and only
// attempt the fast paint when every one of them is already cached. Nothing can
// miss mid-render because nothing is attempted unless it is all there.
let API_PREFER_CACHE = false;
// While a real render runs, the paths it fetches are collected here, so the
// next visit knows exactly what that tab needs.
let API_RECORD = null;
const tabDeps = new Map();       // tab id -> Set of GET paths

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;
  const method = String(opts.method || 'GET').toUpperCase();
  if (method === 'GET' && !opts.raw) {
    if (API_RECORD) API_RECORD.add(path);
    if (API_PREFER_CACHE) {
      const hit = apiCachePeek(path);
      // Cannot normally miss — fastPaintCurrentMobileTab checks every recorded
      // path first. If it somehow does (an entry ageing out between the check
      // and the use), fall through to the network rather than throwing: a
      // slightly slow fast paint is a nuisance, an error painted into the view
      // is what she reported.
      if (hit !== undefined) return hit;
    }
  }
  // cache:'no-store' added 2026-10-23 alongside the website. The server now
  // sends Cache-Control: no-store on every /api/ response; this says the same
  // thing from the phone, so nothing between the app and the VM can hand back
  // yesterday's answer.
  //
  // This is the HTTP cache ONLY. The fast-paint cache above is a deliberate
  // feature — it paints the last known view instantly and then replaces it
  // with the network answer — and is deliberately NOT touched here. If the
  // app ever shows a stale load after a create, that cache is where to look,
  // and it is a separate decision from this one.
  const res = await fetch(API_BASE + path, { cache: 'no-store', ...opts, headers });
  if (res.status === 401) {
    setToken(null);
    showLoginScreen('Session expired — sign in again.');
    throw new Error('unauthorized');
  }
  // opts.raw — for endpoints that return something other than JSON. Added for
  // /api/voice/say, which returns WAV audio; running that through res.json()
  // silently produced an empty object and the app played nothing at all, with
  // no error to explain it.
  if (opts.raw) {
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `request failed (${res.status})`);
    }
    return res.blob();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Carry the SHAPE of the error, not just its sentence. Routes that hand
    // back structured fields — petty cash returns { code, available,
    // requested } so the Pay form can offer "record $400 and leave $1,100
    // outstanding?" — were losing all of it here, because only .error made it
    // into the Error. The caller was then left parsing English to decide what
    // to do, which is how a prompt ends up firing on the wrong failure.
    //
    // Everything except `error` is copied across, so a future route adding a
    // field does not need this function changed again.
    const err = new Error(data.error || `request failed (${res.status})`);
    err.status = res.status;
    for (const k of Object.keys(data || {})) { if (k !== 'error') err[k] = data[k]; }
    throw err;
  }
  // Cached only on the way OUT of a successful GET, so a failed request can
  // never poison the cache with an error body.
  if (method === 'GET') {
    apiCache.set(path, { at: Date.now(), data });
  } else {
    // Every write, not just the ones that obviously matter. See the note on
    // apiCache — guessing which paths a write invalidates is the bet that
    // leaves a settled load showing as unpaid.
    apiCacheClear();
  }
  return data;
}

// No-op kept for parity with the dashboard build's loadTab() cleanup call
// -- there is no in-page camera stream to stop here either (see
// dashboard/index.html's comment on this same no-op).
function stopCamera() {}

// ITEM_DESC_OPTIONS_BASE and ITEM_DESC_OTHER used to live here: eleven
// hardcoded descriptions plus an "Others…" sentinel. Both are gone as of
// 2026-08-20 (Apsara: "keep the list in backend"). The eleven were moved
// into helpers/itemTypes.js as one-time seed data and are now ordinary,
// editable catalog entries; "Others" is unnecessary because the field is
// free text. Keeping a duplicate of the list in each client was also how
// the phone and the dashboard drifted apart.

// Custom descriptions typed via "Others…" on a previous load — mirrors
// dashboard/index.html, see its comment (Apsara 2026-08-15).
let customItemTypes = [];
// ── a failed refresh must NOT empty the catalogue ─────────────────────────
// Bose, 2026-09-02: "sometimes newly added items not coming."
//
// THE BUG. This used to be `catch { customItemTypes = []; }`. One failed GET
// — a dropped bar of signal in the yard, the phone waking from sleep, the
// server restarting mid-deploy — and the description catalogue was WIPED for
// that whole modal session. Silently: no error, no retry, just an empty
// type-ahead where a full one had been a minute earlier.
//
// The old comment claimed the dropdown "falls back to the base list". It does
// not. itemDescOptions() returns customItemTypes.slice() and nothing else —
// the base presets were folded into the server list back on 2026-08-20, so
// emptying this array empties the dropdown outright. The comment described
// behaviour that had stopped existing.
//
// "Sometimes" is the tell of a network-dependent failure, and this is the
// only place the list can vanish.
//
// NOW: keep whatever was last loaded. A stale list can only ever cost a
// suggestion that is slightly out of date — descriptions are free text, so
// nothing is blocked by an entry being missing or lingering. An EMPTY list
// costs the operator the entire catalogue, which is the actual complaint.
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
    // Keep the previous list. Flagged so the UI can say the list may be out
    // of date rather than quietly lying about what is in it.
    itemTypesStale = true;
    console.warn('[items] could not refresh the description list — keeping the last known ' + customItemTypes.length + ' entries:', err && err.message);
  }
}
// Sorted A-Z, per Apsara 2026-08-19 ("rearrange the description list based
// on asc"). Previously the built-in options came out in hand-written order
// with any custom "Others…" additions appended after them, so the list had
// no findable order once it grew past a handful of entries.
// localeCompare with sensitivity:'base' so the sort ignores case and
// accents — otherwise a custom entry typed as "battery" would sort into a
// separate block from "Battery" and look like a duplicate.
// "Others…" is handled separately by the callers, which append it last —
// it's an action, not an item type, and must not sort into the middle.
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

// Edge Trading is always the BUYER on every load — per Apsara 2026-08-15
// ("no. buyer should be edge trading"). See dashboard/index.html's comment
// for the full reasoning.
const BUYER_FIXED_NAME = 'Edge Trading';

// ── Address Book integration on the Seller name field — mirrors
// dashboard/index.html.
// ── ONE cache, not two ─────────────────────────────────────────────────────
// Apsara, 2026-09-16: "when i add a address, post opening the app - i have to
// logout for the change to be seen."
//
// Two separate bugs wearing one coat:
//
//   1. The Documents tab kept its OWN copy (docsAddressBook) behind an
//      `if (!docsAddressBook.length)` guard — fetch once, never again. On a
//      phone the page never reloads, so logging out was genuinely the only
//      way to refill it. That is the bug she hit.
//
//   2. Two copies of the same list drift. Saving a load with a new seller
//      auto-creates an address-book entry and pushed it into addressBookCache
//      only, so the Documents consignee typeahead could not see a contact the
//      Loads screen had just created.
//
// So there is now one list and one refresher. docsAddressBook is declared
// here (not down in the Documents section) so this function can never touch
// it before its `let` is initialised.
let addressBookCache = [];
let docsAddressBook = [];
async function refreshAddressBookCache() {
  try {
    const fresh = await api('/api/address-book');
    // REPLACE ONLY ON SUCCESS. The old version assigned the fetch result
    // straight into the cache and emptied it in the catch — so one request
    // failing on bad signal in the yard threw away a perfectly good list and
    // left every typeahead blank until the next refresh happened to work.
    // A stale list is useful; an empty one is not.
    if (Array.isArray(fresh)) { addressBookCache = fresh; docsAddressBook = fresh; }
  } catch (err) {
    console.error('[address-book] refresh failed, keeping last good list:', err.message);
  }
}
function addressBookExactMatch(name) {
  const q = String(name || '').trim().toLowerCase();
  if (!q) return null;
  return addressBookCache.find(e => (e.aliases || []).some(a => a.toLowerCase() === q)) || null;
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
