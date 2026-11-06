// ── helpers/sellerRecord.js — the record California makes her keep ────────
//
// Edge Yard is EDGE TRADING INC, 2453 E 25th Street, Los Angeles, CA 90058
// (helpers/entities.js). So a yard purchase is a junk dealer / recycler
// transaction under California Business and Professions Code, Division 8,
// Chapter 9, Article 3, and §21606 lists what the written record must
// contain. §21608.5 adds a second, heavier list for NONFERROUS material —
// copper, copper alloys, stainless steel, aluminium — which is most of what
// the yard buys.
//
// ── WHAT THIS MODULE IS, AND WHAT IT REFUSES TO BE ───────────────────────
// It is a READER. It opens the yard's inbound loads and says, per load and
// per requirement, one of three things:
//
//   present       Jarvis holds this, and it is filled in.
//   missing       Jarvis has a field for this and it is empty. She can fix
//                 this by typing.
//   not_captured  Jarvis has NOWHERE to put this. No amount of typing fixes
//                 it; somebody has to build a field first.
//
// That third value is the whole point of the file. "Incomplete" is not
// actionable. "There is no box for the driver's licence number anywhere in
// this application" is.
//
// It changes nothing. It does not add a required field to a load, it does
// not block a save, and it is not wired into addLoad. That restraint is
// deliberate and CLAUDE.md explains why in three separate incidents: a
// requirement added to shared code reaches callers nobody was looking at,
// and the caller that cannot satisfy it has twice been the voice path, which
// has no form to put a field on. A statutory field that stops her recording
// a load that already happened is worse than a statutory field that is
// missing, because the second one is at least visible.
//
// ── NOTHING HERE IS COMPLIANT BECAUSE A MODEL READ A STATUTE ─────────────
// Same doctrine as helpers/exportRules.js, for the same reason, and this
// module reuses that module's statusOf() rather than re-deciding staleness.
// Every requirement below ships UNVERIFIED. An unverified requirement can
// never make a load read as complete — it produces `cannot_say`, which is
// what every load will read as until a named person confirms the rule on a
// known date, via verify().
//
// `complete` is never a default and never a fallback.
//
// The research behind the seed rows was done on 2026-11-07 and the sources
// are recorded on each row. §21606 was AMENDED by AB 476 (Stats. 2025, Ch.
// 694, Sec. 1), effective 1 January 2026, so any note older than that about
// what §21606 requires is describing the superseded version. §21608.5's text
// was read from a source last touched in 2018 and is the LEAST trustworthy
// row in the register; it is marked disputed for that reason, not because
// the rule is doubted.
//
// This is not legal advice and this file does not pretend to be a lawyer's
// reading. It is a checklist with citations, built so that she or her
// attorney can confirm each line once and have Jarvis hold the answer.

const cfg = require('../config');
const path = require('path');
const { loadJson, mutateJson } = require('./json');
const { statusOf, addDays, DEFAULT_VALID_DAYS } = require('./exportRules');

const OUTCOMES = ['complete', 'incomplete', 'cannot_say'];
const VERDICTS = ['present', 'missing', 'not_captured'];

const today = () => new Date().toISOString().slice(0, 10);
const norm = (s) => String(s == null ? '' : s).toLowerCase().trim()
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// ── IS THIS LOAD NONFERROUS? ──────────────────────────────────────────────
// §21608.5(f) defines nonferrous material as copper, copper alloys,
// stainless steel, or aluminium. Her item names are free text in her own
// spelling — "Al wheel dirty", "Alum Wheels", "copper 2", "SS 304" — so this
// is a classification, and the direction of a wrong answer matters enormously.
//
// Calling copper FERROUS would silently drop six requirements including the
// thumbprint. Calling steel NONFERROUS merely over-reports. So:
//
//   a name that matches the nonferrous list  → nonferrous
//   a name that matches nothing              → UNKNOWN, and unknown is
//                                              treated as possibly
//                                              nonferrous, flagged as a
//                                              guess nobody has confirmed
//
// There is no "probably ferrous". helpers/nameMatch.js refuses near misses
// for the same reason: a near miss resolves to the wrong answer confidently.
const NONFERROUS = [
    'copper', 'cu', 'copper 1', 'copper 2', 'copper 3', 'bare bright',
    'birch', 'cliff', 'candy', 'berry', 'copper tube', 'copper wire',
    'brass', 'yellow brass', 'red brass', 'bronze', 'brass rod',
    'aluminium', 'aluminum', 'al', 'alum', 'al wheel', 'al wheels',
    'aluminium wheel', 'aluminum wheels', 'al wheel dirty', 'al wheel clean',
    'alloy wheel', 'alloy wheels', 'al sheet', 'al extrusion', 'extrusion',
    'cast aluminium', 'cast aluminum', 'al cast', 'zorba', 'twitch',
    'stainless', 'stainless steel', 'ss', 'ss 304', 'ss 316', '304', '316',
    'radiator', 'al cu radiator', 'ac radiator', 'copper radiator',
    'insulated wire', 'harness', 'wire harness', 'electric motor',
];

// Substring on word boundaries, longest first, so "stainless steel" is not
// decided by "steel" and "al" does not match "aluminium salvage" by accident.
const NF_SORTED = NONFERROUS.slice().sort((a, b) => b.length - a.length);

function materialClass(load) {
    const names = [];
    for (const it of (load && load.items) || []) {
        if (it && it.item) names.push(norm(it.item));
    }
    if (load && load.description) names.push(norm(load.description));
    const seen = names.filter(Boolean);
    if (!seen.length) return { kind: 'unknown', why: 'no item name on the load', matched: [] };

    const matched = [];
    for (const n of seen) {
        const padded = ' ' + n + ' ';
        const hit = NF_SORTED.find((a) => padded.includes(' ' + a + ' ') || n === a);
        if (hit) matched.push(hit);
    }
    if (matched.length) return { kind: 'nonferrous', why: 'item name matched', matched };
    return {
        kind: 'unknown', matched: [],
        why: `no item name on this load (${seen.join(', ')}) is in the nonferrous list, `
            + 'and an unrecognised name is NOT assumed to be ferrous',
    };
}

// ── READING ONE FIELD OFF A LOAD ──────────────────────────────────────────
// A reader returns a verdict and, when it has one, the value it found. A
// reader that returns not_captured is making a claim about the SHAPE of the
// record, not about this particular load, so it says so the same way every
// time regardless of what the load contains.
const filled = (v) => v != null && String(v).trim() !== '';

const present = (value) => ({ verdict: 'present', value: String(value) });
const missing = (field) => ({ verdict: 'missing', field });
const nowhere = (what) => ({ verdict: 'not_captured', needs: what });

// ── THE REGISTER ──────────────────────────────────────────────────────────
// One row per thing the statute asks for, each with its own citation, its own
// source, and its own reader. Split finer than the statute's own numbering
// where a single paragraph asks for several independent facts, because
// "21606(a)(1)" being half-satisfied tells her nothing she can act on.
//
// `seed_verified` is false on every row. That is not an oversight.
const REQUIREMENTS = [
    // ── §21606(a)(1) — the transaction itself ────────────────────────────
    { id: 'place', cite: 'BPC 21606(a)(1)', law: 'ca-21606',
      what: 'The place of the purchase',
      read: () => present('2453 E 25th Street, Los Angeles, CA 90058'),
      note: 'Derived from the yard\'s registered address in helpers/entities.js, not '
          + 'stored per load. Correct only while every yard purchase happens at that '
          + 'address — a second yard, or a purchase made off-site, makes this wrong '
          + 'and silently so.' },

    { id: 'date', cite: 'BPC 21606(a)(1)', law: 'ca-21606',
      what: 'The date of the purchase',
      read: (l) => (filled(l.date) ? present(l.date) : missing('date')) },

    { id: 'time', cite: 'BPC 21606(a)(1)', law: 'ca-21606',
      what: 'The TIME of the purchase',
      read: () => nowhere('a time-of-transaction field on the load'),
      note: 'ADDED BY AB 476, effective 2026-01-01 — this requirement is new this '
          + 'year. created_at is NOT this: it is the moment the record was SAVED, '
          + 'which can be hours later or a different day, and offering it as the '
          + 'transaction time would be filing a figure that is wrong on purpose.' },

    { id: 'amount_paid', cite: 'BPC 21606(a)(1)', law: 'ca-21606',
      what: 'The amount paid',
      read: (l) => (l.amount != null ? present(l.amount) : missing('amount')),
      note: 'The load\'s amount is what the metal came to. net_payable can differ '
          + 'where haulage was deducted; which of the two is "the amount paid" is a '
          + 'question for her attorney, and this row reports the gross.' },

    { id: 'employee', cite: 'BPC 21606(a)(1)', law: 'ca-21606',
      what: 'The name of the employee who handled the transaction',
      read: (l) => (filled(l.created_by) && String(l.created_by) !== 'unknown'
          ? present(l.created_by) : missing('created_by')),
      note: 'ADDED BY AB 476, effective 2026-01-01. created_by exists and defaults to '
          + 'the string "unknown", which is counted as missing here rather than as a '
          + 'name — a record whose employee is literally "unknown" satisfies nothing.' },

    // ── §21606(a)(2) — who the seller is ─────────────────────────────────
    { id: 'seller_name', cite: 'BPC 21606(a)(2)', law: 'ca-21606',
      what: 'The seller\'s name',
      read: (l) => (filled(l.seller) ? present(l.seller) : missing('seller')) },

    { id: 'seller_id', cite: 'BPC 21606(a)(2)(A)-(C)', law: 'ca-21606',
      what: 'The seller\'s ID: driver\'s licence number and state of issue, OR passport '
          + 'number and country plus an address from a second ID, OR Matricula Consular '
          + 'number plus an address from a second ID',
      read: () => nowhere('a seller identification block on the load — ID type, number, '
          + 'issuing state or country'),
      note: 'The statute offers three alternatives and any ONE of them satisfies it, so '
          + 'whatever is built must let her record which kind she took. A single '
          + '"ID number" box would make the record unreadable as evidence.' },

    // ── §21606(a)(3) — the truck that brought it ─────────────────────────
    { id: 'vehicle', cite: 'BPC 21606(a)(3)', law: 'ca-21606',
      what: 'The licence plate and state of issue of the vehicle that brought the metal in',
      read: () => nowhere('a vehicle plate and state field on the load'),
      note: 'The yard has truckers and trucking amounts, but no plate is recorded '
          + 'anywhere, and the statute wants the plate of the vehicle that DELIVERED — '
          + 'which on a seller-delivered load is the seller\'s truck, not her hauler.' },

    // ── §21606(a)(5) — what was bought ───────────────────────────────────
    { id: 'item_type', cite: 'BPC 21606(a)(5)', law: 'ca-21606',
      what: 'A description of the item type',
      read: (l) => {
          const names = ((l.items || []).map((i) => i && i.item).filter(Boolean));
          if (names.length) return present(names.join(', '));
          if (filled(l.description)) return present(l.description);
          return missing('items[].item');
      } },

    { id: 'weight', cite: 'BPC 21606(a)(5)', law: 'ca-21606',
      what: 'The weight',
      read: (l) => (l.net_weight != null
          ? present(`${l.net_weight} ${l.weight_unit || 'lb'}`) : missing('net_weight')),
      note: 'The best-covered requirement in the whole register: weighed, photographed '
          + 'at gross and tare, and signed for.' },

    { id: 'marks', cite: 'BPC 21606(a)(5)', law: 'ca-21606',
      what: 'Identifying marks engraved or etched on the metal, if any and readily visible',
      read: () => nowhere('a marks field on the load, or an explicit "none visible"'),
      note: 'Conditional — "if any and readily visible" — so the honest record is a '
          + 'field that can say "none seen", not a field left blank. Blank cannot be '
          + 'told apart from not-looked-at.' },

    { id: 'serials', cite: 'BPC 21606(a)(5)', law: 'ca-21606',
      what: 'Serial numbers, if any and readily visible',
      read: () => nowhere('a serial-numbers field on the load, or an explicit "none visible"'),
      note: 'Same conditional shape as marks.' },

    // ── §21606(a)(6) — THE ONE THE SIGNATURE DOES NOT COVER ──────────────
    { id: 'ownership_statement', cite: 'BPC 21606(a)(6)', law: 'ca-21606',
      what: 'A SIGNED STATEMENT that the seller owns the metal, or names who they got it '
          + 'from as shown on a signed transfer document',
      read: () => nowhere('an ownership declaration on the ticket the seller signs'),
      note: 'READ THIS ROW TWICE. seller_signature EXISTS, and it is tempting to count '
          + 'it. It must not be counted. That signature attests to the weights and the '
          + 'price on the ticket — loads.js resets it the moment those numbers change, '
          + 'precisely because it is a signature about figures. It contains no assertion '
          + 'of ownership, so counting it here would put a green tick on a statutory '
          + 'declaration that was never made. The fix is wording ON the ticket above '
          + 'the existing signature, which is cheap; the wrong fix is treating the '
          + 'signature she already has as if it said something it does not.' },

    // ── §21608.5 — NONFERROUS ONLY, AND THAT IS MOST OF THE YARD ─────────
    { id: 'nf_seller_photo', cite: 'BPC 21608.5(a)(2)', law: 'ca-21608-5', nonferrous: true,
      what: 'A clear photograph or video of the SELLER, taken at the time of sale',
      read: () => nowhere('a seller photograph on the load') },

    { id: 'nf_id_copy', cite: 'BPC 21608.5(a)(3)', law: 'ca-21608-5', nonferrous: true,
      what: 'A COPY of the seller\'s photo ID showing an address (or passport / Matricula '
          + 'plus a second item bearing an address)',
      read: () => nowhere('an ID document image on the load'),
      note: 'Distinct from the §21606(a)(2) row: that one wants the NUMBER written down, '
          + 'this one wants the document itself kept.' },

    { id: 'nf_material_photo', cite: 'BPC 21608.5(a)(4)', law: 'ca-21608-5', nonferrous: true,
      what: 'A clear photograph or video of the nonferrous material being purchased',
      read: (l) => {
          const shots = [];
          for (const it of (l.items || [])) {
              if (it && (it.gross_photo_link || it.gross_photo_drive_id)) shots.push('gross');
              if (it && (it.tare_photo_link || it.tare_photo_drive_id)) shots.push('tare');
          }
          return shots.length
              ? { verdict: 'present', value: `${shots.length} weight photo(s) on file`,
                  caveat: 'These are SCALE photographs. Whether a photograph of a loaded '
                        + 'truck on a weighbridge is "a clear photograph of the material '
                        + 'being purchased" is a judgement about evidence, not a fact '
                        + 'about the data, and Jarvis is not entitled to make it. '
                        + 'Confirm with her attorney before relying on this row.' }
              : nowhere('a photograph of the material (no weight photos on this load either)');
      } },

    { id: 'nf_thumbprint', cite: 'BPC 21608.5(a)(6)', law: 'ca-21608-5', nonferrous: true,
      what: 'A thumbprint of the seller, as prescribed by the Department of Justice, kept '
          + 'two years',
      read: () => nowhere('a thumbprint capture — and a decision about how it is stored'),
      note: 'The statute restricts inspection of a thumbprint to a peace officer acting '
          + 'on a criminal search warrant. So this is not merely another field: holding '
          + 'biometrics puts obligations on how Jarvis stores and exposes it, and that '
          + 'is a conversation before it is a feature.' },

    { id: 'nf_payment', cite: 'BPC 21608.5(a)(1)', law: 'ca-21608-5', nonferrous: true,
      what: 'Payment by cash or cheque only, and not collectable before the third business '
          + 'day after the sale (unless the frequent-seller or business-seller exceptions '
          + 'apply)',
      read: () => nowhere('a link from a yard load to WHEN and HOW it was paid, in a form '
          + 'this check can read'),
      note: 'Payments exist and carry a mode, but nothing compares the payment DATE to the '
          + 'sale date, and the yard pays by Zelle and Wire as well as cash and cheque. '
          + 'Whether that matters turns entirely on the exemption row below, which is why '
          + 'that row is the one to settle first.' },

    // ── §21608.5(c) — THE EXEMPTION THAT MAY MAKE ALL SIX MOOT ───────────
    { id: 'nf_business_exemption', cite: 'BPC 21608.5(c)', law: 'ca-21608-5', nonferrous: true,
      what: 'The business-seller exemption: §21608.5 does not apply at all if the yard has '
          + 'on file the seller\'s business name, physical business address, business '
          + 'telephone, business licence or tax ID number, AND a copy of the driver\'s '
          + 'licence of the person delivering',
      read: (l) => {
          const have = [], want = [];
          (filled(l.seller) ? have : want).push('business name');
          (filled(l.seller_address) ? have : want).push('physical business address');
          (filled(l.seller_phone) ? have : want).push('business telephone');
          want.push('business licence or tax ID number (nowhere in Jarvis)');
          want.push('a copy of the driver\'s licence of the person delivering (nowhere in Jarvis)');
          return {
              verdict: 'not_captured', needs: want.join('; '),
              value: have.length ? `already on file: ${have.join(', ')}` : null,
          };
      },
      note: 'THE HIGHEST-LEVERAGE ROW IN THIS FILE, and the reason to settle it before '
          + 'building anything else. For a seller that is a business, this exemption '
          + 'switches off the seller photograph, the ID copy, the thumbprint and the '
          + 'three-day payment hold outright. Three of its five conditions are ALREADY '
          + 'captured. The two that are not — a business licence or tax ID, and a copy '
          + 'of the delivering driver\'s licence — are two ordinary fields. If most of '
          + 'the yard\'s sellers are businesses, two fields replace five builds, one of '
          + 'which is biometric. If they are walk-in individuals, none of that applies '
          + 'and the heavy list stands. Nobody has told Jarvis which it is.' },
];

// ── THE SEED RULES: UNVERIFIED, WITH THEIR SOURCES ───────────────────────
// Two rows, because the two statutes were researched to very different
// standards and must not inherit each other's credibility.
const SEED_LAWS = [
    {
        id: 'ca-21606',
        title: 'CA Bus & Prof Code §21606 — junk dealer / recycler written record',
        researched_on: '2026-11-07',
        source: 'https://law.justia.com/codes/california/code-bpc/division-8/chapter-9/article-3/section-21606/',
        amended: 'Amended by Stats. 2025, Ch. 694, Sec. 1 (AB 476). Effective January 1, 2026.',
        verified_on: null, verified_by: null, disputed: false,
        why: 'Full current text retrieved, and the amending act is named on the source '
           + 'page. The two newest requirements — the TIME of the transaction and the '
           + 'EMPLOYEE who handled it — come from AB 476 and are less than a year old, '
           + 'so any earlier advice she was given about this section predates them.',
    },
    {
        id: 'ca-21608-5',
        title: 'CA Bus & Prof Code §21608.5 — nonferrous material: payment, ID, photographs, thumbprint',
        researched_on: '2026-11-07',
        source: 'https://law.onecle.com/california/business/21608.5.html',
        amended: 'Source states: Amended by Stats. 2012, Ch. 531, Sec. 1.5 (AB 1508), '
               + 'effective January 1, 2013.',
        verified_on: null, verified_by: null, disputed: true,
        why: 'MARKED DISPUTED ON PURPOSE, and not because the rule is doubted. The only '
           + 'full text found was on a page whose own footer says it was last modified in '
           + '2018, and AB 476 amended neighbouring sections of this article in 2025. A '
           + 'twelve-year-old reading of a section in an article that was amended last '
           + 'year is exactly the kind of source that should not drive a green tick. '
           + 'Confirm against leginfo.legislature.ca.gov before acting on the payment '
           + 'timing or the thumbprint.',
    },
];

const SEED_FILE = path.join(__dirname, '..', 'seeds', 'seller-record-laws.json');

// Her register if she has one, otherwise the shipped rows — read only, never
// written here. Same ordering and the same reason as exportRules.rules().
function laws() {
    let rows = null;
    try { rows = loadJson(cfg.SELLER_RECORD_LAWS_FILE, null); } catch (e) { rows = null; }
    if (!Array.isArray(rows)) {
        try { rows = JSON.parse(require('fs').readFileSync(SEED_FILE, 'utf8')); }
        catch (e) { rows = SEED_LAWS; }
    }
    return (Array.isArray(rows) ? rows : SEED_LAWS).filter((r) => r && r.id);
}

// ── ONE LOAD ──────────────────────────────────────────────────────────────
// Returns { outcome, nonferrous, fields[], unverified[] }.
//
// outcome is cannot_say whenever a governing statute is not actionable,
// EVEN IF every field happens to be present. A record that is complete
// against an unconfirmed reading of the law is not known to be complete,
// and saying otherwise is the failure this module exists to prevent.
function checkLoad(load, { asOf = null, lawRows = null, requirements = null } = {}) {
    const when = asOf || today();
    const rows = Array.isArray(lawRows) ? lawRows : laws();
    const byId = {};
    for (const r of rows) byId[r.id] = r;
    const reqs = Array.isArray(requirements) ? requirements : REQUIREMENTS;

    const material = materialClass(load);
    // Unknown counts as in-scope. See materialClass: over-reporting is
    // recoverable, under-reporting hides a thumbprint requirement.
    const nfApplies = material.kind !== 'ferrous';

    const fields = [];
    const unverified = [];
    for (const req of reqs) {
        if (req.nonferrous && !nfApplies) continue;
        const law = byId[req.law] || null;
        const st = statusOf(law, when);
        if (!st.actionable && !unverified.some((u) => u.law === req.law)) {
            unverified.push({ law: req.law, why: st.why,
                title: (law && law.title) || req.law, source: (law && law.source) || null });
        }
        let got;
        try { got = req.read(load || {}) || nowhere('reader returned nothing'); }
        catch (e) { got = nowhere(`reader threw: ${(e && e.message) || e}`); }
        fields.push({
            id: req.id, cite: req.cite, what: req.what, law: req.law,
            verdict: got.verdict, value: got.value == null ? null : got.value,
            field: got.field || null, needs: got.needs || null,
            caveat: got.caveat || null, note: req.note || null,
            rule_actionable: st.actionable, rule_why: st.why,
            nonferrous_only: !!req.nonferrous,
        });
    }

    const anyGap = fields.some((f) => f.verdict !== 'present');
    const outcome = unverified.length ? 'cannot_say' : (anyGap ? 'incomplete' : 'complete');

    return {
        load_id: (load && load.id) != null ? load.id : null,
        date: (load && load.date) || null,
        seller: (load && load.seller) || null,
        outcome, material, nonferrous_in_scope: nfApplies,
        fields, unverified, asOf: when,
    };
}

// ── EVERY YARD PURCHASE IN A WINDOW ───────────────────────────────────────
// Reports the SHAPE of the gap once, not once per load, because sixty loads
// each missing the same four fields is one finding and sixty lines of it is
// a report she stops opening.
function report({ from = null, to = null, asOf = null, loads = null, lawRows = null } = {}) {
    const when = asOf || today();
    let rows = loads;
    if (!Array.isArray(rows)) {
        try { rows = loadJson(cfg.LOADS_FILE, []); } catch (e) { rows = []; }
    }
    rows = (Array.isArray(rows) ? rows : []).filter((l) => l && (!from || String(l.date || '') >= String(from))
        && (!to || String(l.date || '') <= String(to)));

    const checked = rows.map((l) => checkLoad(l, { asOf: when, lawRows }));

    // Per requirement: how many loads have it, and what kind of gap it is.
    const byField = {};
    for (const c of checked) {
        for (const f of c.fields) {
            const b = byField[f.id] || (byField[f.id] = {
                id: f.id, cite: f.cite, what: f.what, note: f.note, caveat: f.caveat,
                nonferrous_only: f.nonferrous_only,
                present: 0, missing: 0, not_captured: 0, needs: f.needs,
            });
            b[f.verdict] += 1;
            if (f.caveat) b.caveat = f.caveat;
        }
    }
    const gaps = Object.values(byField).sort((a, b) =>
        (b.not_captured - a.not_captured) || (b.missing - a.missing) || a.id.localeCompare(b.id));

    const counts = { complete: 0, incomplete: 0, cannot_say: 0 };
    for (const c of checked) counts[c.outcome] += 1;

    // The gap classes, which are the two different asks.
    const buildable = gaps.filter((g) => g.not_captured > 0);
    const typeable = gaps.filter((g) => g.not_captured === 0 && g.missing > 0);

    const unverified = [];
    for (const c of checked) {
        for (const u of c.unverified) if (!unverified.some((x) => x.law === u.law)) unverified.push(u);
    }
    // With no loads in the window there is nothing to check a law against,
    // so the register's own state is reported directly rather than inferred.
    if (!checked.length) {
        for (const law of (Array.isArray(lawRows) ? lawRows : laws())) {
            const st = statusOf(law, when);
            if (!st.actionable) unverified.push({ law: law.id, why: st.why,
                title: law.title, source: law.source || null });
        }
    }

    return {
        period: { from: from || null, to: to || null }, asOf: when,
        entity: 'edge-trading', entity_name: 'Edge Yard (EDGE TRADING INC)',
        loads: checked.length, counts, loadsChecked: checked,
        gaps, buildable, typeable, unverified,
        // Said plainly, because a caller that treats cannot_say as fine is the
        // way this module fails.
        headline: !checked.length
            ? 'No yard purchases in this period.'
            : (unverified.length
                ? `${checked.length} purchase(s) examined. NONE can be called complete: `
                  + `${unverified.length} governing rule(s) have not been confirmed by a person.`
                : `${checked.length} purchase(s) examined: ${counts.complete} complete, `
                  + `${counts.incomplete} incomplete.`),
    };
}

// ── A HUMAN CONFIRMS A STATUTE ────────────────────────────────────────────
// The only writer in the file. Nothing goes and looks a law up by itself: a
// rule that refreshed itself is a rule nobody is accountable for.
async function verify({ id, by, on = null, expires_on = null, disputed = null, why = null }) {
    if (!id) throw new Error('verify: which law?');
    if (!by || !String(by).trim()) throw new Error('verify: who confirmed it?');
    const day = on || today();
    let after = null;
    await mutateJson(cfg.SELLER_RECORD_LAWS_FILE, laws(), (all) => {
        const list = Array.isArray(all) && all.length ? all : laws();
        const i = list.findIndex((r) => r && r.id === id);
        if (i < 0) throw new Error(`verify: no law "${id}" in the register`);
        list[i] = { ...list[i], verified_by: String(by).trim(), verified_on: day,
            expires_on: expires_on || addDays(day, DEFAULT_VALID_DAYS) };
        if (disputed != null) list[i].disputed = !!disputed;
        if (why) list[i].why = why;
        after = list[i];
        return list;
    });
    return after;
}

module.exports = {
    report, checkLoad, laws, verify, materialClass,
    REQUIREMENTS, SEED_LAWS, OUTCOMES, VERDICTS, NONFERROUS,
};
