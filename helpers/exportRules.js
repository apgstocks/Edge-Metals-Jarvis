// ── helpers/exportRules.js — can this container legally land where it is going ─
//
// Apsara, 2026-10-23: Jarvis as the one tool for a US scrap exporter's
// export-import side. Asked to research destination rules first, then:
// "Audit and build everything".
//
// ── WHY THIS IS A REGISTER AND NOT A TABLE OF RULES ──────────────────────
// Two lanes were researched on 2026-10-23 and they came back completely
// differently:
//
//   India — DGFT Public Notice 35/2026-27, dated 21 October 2026, two days
//           before the research. It keeps the pre-shipment inspection
//           certificate for metallic scrap but EXEMPTS scrap originating in a
//           listed safe country, the USA among them, entering through a
//           designated seaport. Secondary sources disagreed on whether that
//           list is eight ports or ten, and nobody produced the notice text.
//   Korea — nothing authoritative at all. Radioactivity screening is common
//           at scrap ports, so silence is not absence.
//
// So the rules cannot be trusted because they were researched. They can only
// be trusted because a named person confirmed one on a known date. That is
// what every field below exists to record, and it is why `check` has THREE
// outcomes instead of two.
//
// ── UNKNOWN IS NOT CLEAR. EVER. ──────────────────────────────────────────
// The failure this module exists to prevent is a green tick on a container
// that gets rejected at Nhava Sheva — the scrap-trade version of the stale
// "agrees with QuickBooks" badge. So:
//
//   clear    a rule exists, it is verified, it is in date, and it says yes
//   blocked  a rule exists, it is verified, it is in date, and it says no
//   unknown  anything else — no rule, an unverified rule, an expired rule,
//            or a destination string whose country cannot be worked out
//
// `clear` is never the default and never a fallback. A caller that treats
// unknown as clear has to do so explicitly, in its own code, where it can be
// read and argued with.
//
// ── IT DECIDES NOTHING ABOUT HER WORKFLOW ────────────────────────────────
// Nothing here blocks a save. A booking must still be creatable when the
// rules are silent, because the alternative is that she cannot record work
// that is already happening. What this module does is answer the question;
// which screens refuse and which merely warn is each caller's decision.
//
// READ ONLY on the register except through `verify`, which is how a human
// records that they checked a rule. No rule is ever edited automatically and
// nothing here goes and looks a rule up on the internet: a rule that
// refreshed itself would be a rule nobody is accountable for.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

const OUTCOMES = ['clear', 'blocked', 'unknown'];

// How long a verification is good for before it has to be looked at again.
// Not a guess at how often governments legislate — a statement that nobody
// should act on a year-old reading of a trade rule. India's own notice landed
// two days before this file was written.
const DEFAULT_VALID_DAYS = 180;

const today = () => new Date().toISOString().slice(0, 10);

// Same normalisation as helpers/booking.js's localityMatchesPort, on purpose:
// two different ideas of what "Busan,South Korea" looks like is how one of
// them silently stops matching.
const norm = (s) => String(s == null ? '' : s).toLowerCase().trim()
    .replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();

// ── WORKING OUT THE COUNTRY FROM WHAT SHE TYPED ───────────────────────────
// This is the hard part, and it is not the rules.
//
// helpers/ports.js deliberately keeps no canonical port list, and its reasons
// are good ones: "she writes 'Busan,South Korea' ... and those exact strings
// are what print on the invoice a customs broker reads." So the destination
// reaching this module is free text in her own spelling — "Busan,South Korea",
// "BUSAN, SOUTH KOREA", "Nhava Sheva, India", possibly just "Busan".
//
// Hence an explicit alias list, and a null when nothing matches. A fuzzy
// guess here would be the worst possible behaviour: it would quietly apply
// India's rules to a container going somewhere else.
const COUNTRIES = [
    { code: 'IN', name: 'India',
      aliases: ['india', 'nhava sheva', 'jnpt', 'mundra', 'kandla', 'chennai',
                'tuticorin', 'kolkata', 'cochin', 'kochi', 'krishnapatnam',
                'hazira', 'pipavav', 'ennore', 'visakhapatnam', 'vizag'] },
    { code: 'KR', name: 'South Korea',
      aliases: ['south korea', 'korea', 'republic of korea', 'busan', 'pusan',
                'incheon', 'ulsan', 'gwangyang', 'pyeongtaek', 'masan'] },
    { code: 'TW', name: 'Taiwan',
      aliases: ['taiwan', 'kaohsiung', 'taichung', 'keelung', 'taipei'] },
    { code: 'TR', name: 'Turkey', aliases: ['turkey', 'turkiye', 'iskenderun',
                'aliaga', 'izmir', 'gebze', 'marmara', 'mersin', 'ambarli'] },
    { code: 'VN', name: 'Vietnam', aliases: ['vietnam', 'viet nam', 'haiphong',
                'hai phong', 'cai mep', 'ho chi minh', 'saigon'] },
    { code: 'MY', name: 'Malaysia', aliases: ['malaysia', 'port klang',
                'klang', 'penang', 'pasir gudang', 'johor'] },
    { code: 'CN', name: 'China', aliases: ['china', 'shanghai', 'ningbo',
                'qingdao', 'tianjin', 'xiamen', 'guangzhou', 'shenzhen'] },
    { code: 'ID', name: 'Indonesia', aliases: ['indonesia', 'jakarta',
                'tanjung priok', 'surabaya', 'tanjung perak'] },
    { code: 'TH', name: 'Thailand', aliases: ['thailand', 'laem chabang', 'bangkok'] },
    { code: 'BD', name: 'Bangladesh', aliases: ['bangladesh', 'chittagong', 'chattogram'] },
    { code: 'PK', name: 'Pakistan', aliases: ['pakistan', 'karachi', 'port qasim'] },
    { code: 'AE', name: 'United Arab Emirates',
      aliases: ['uae', 'united arab emirates', 'jebel ali', 'dubai', 'sharjah'] },
    { code: 'MX', name: 'Mexico', aliases: ['mexico', 'manzanillo', 'veracruz', 'altamira'] },
    { code: 'US', name: 'United States',
      aliases: ['usa', 'u s a', 'united states', 'los angeles', 'long beach',
                'houston', 'savannah', 'new york', 'newark', 'oakland',
                'seattle', 'tacoma', 'charleston', 'norfolk', 'baltimore'] },
];

// A whole-word match on the normalised string, longest alias first — so
// "south korea" wins over "korea", and a port that happens to contain a short
// country name as a substring is not mistaken for it. Returns null rather than
// a best guess.
function countryOf(place) {
    const p = norm(place);
    if (!p) return null;
    const padded = ' ' + p + ' ';
    // ── AMBIGUITY IS NOT-KNOWING, NOT A TIE-BREAK ────────────────────────
    // This used to take the LONGEST matching alias, which reads as sensible
    // and is wrong across countries: "New Mexico, USA" matches 'mexico' (6)
    // and 'usa' (3), so longest-wins called it Mexico. The rule got looked at
    // because a mutation replacing longest-wins with first-wins SURVIVED the
    // suite — nothing tested what it was for, because what it was for was
    // partly incorrect.
    //
    // Within one country longest still wins, so "Busan, South Korea" reports
    // 'south korea' rather than 'korea' and the reason line reads properly.
    // Across countries, two matches means null — which in a module whose
    // whole doctrine is that unknown beats a guess is the only answer
    // consistent with the rest of the file.
    const hits = new Map();   // code -> the longest alias matched for that code
    for (const c of COUNTRIES) {
        for (const a of c.aliases) {
            if (!padded.includes(' ' + a + ' ')) continue;
            const cur = hits.get(c.code);
            if (!cur || a.length > cur.matched.length) {
                hits.set(c.code, { code: c.code, name: c.name, matched: a });
            }
        }
    }
    if (hits.size !== 1) return null;
    return [...hits.values()][0];
}

function rules() {
    let rows = [];
    try { rows = loadJson(cfg.EXPORT_RULES_FILE, []) || []; } catch (e) { return []; }
    return Array.isArray(rows) ? rows.filter((r) => r && r.id) : [];
}

// ── IS THIS RULE SAFE TO ACT ON? ─────────────────────────────────────────
// Three separate ways a rule fails to be actionable, reported separately
// because they need different things from a human: nobody has checked it,
// somebody checked it too long ago, or it is marked as disputed. A rule whose
// own sources contradicted each other is `disputed` and never actionable —
// India's designated-port list is exactly that case today.
function statusOf(rule, asOf = today()) {
    if (!rule) return { actionable: false, why: 'missing' };
    if (rule.disputed) return { actionable: false, why: 'disputed' };
    if (!rule.verified_on || !rule.verified_by) return { actionable: false, why: 'never_verified' };
    const expires = rule.expires_on || addDays(rule.verified_on, DEFAULT_VALID_DAYS);
    if (String(asOf) > String(expires)) {
        return { actionable: false, why: 'expired', expires_on: expires };
    }
    return { actionable: true, why: 'ok', expires_on: expires };
}

function addDays(iso, days) {
    const d = new Date(String(iso) + 'T00:00:00Z');
    if (isNaN(d.getTime())) return '0000-00-00';
    d.setUTCDate(d.getUTCDate() + Number(days || 0));
    return d.toISOString().slice(0, 10);
}

// Does this rule's `applies_when` match the shipment in front of us? A
// condition the shipment cannot answer does NOT match — an unanswerable
// condition is a reason to ask a human, not a reason to apply the rule.
function applies(rule, ship) {
    const w = rule.applies_when || {};
    if (w.origin_country && String(w.origin_country).toUpperCase()
        !== String(ship.origin_country || '').toUpperCase()) return false;
    if (Array.isArray(w.materials) && w.materials.length) {
        const m = norm(ship.material);
        if (!m || !w.materials.some((x) => norm(x) === m)) return false;
    }
    return true;
}

// ── THE ANSWER ───────────────────────────────────────────────────────────
// Returns { outcome, country, reasons[], actions[] }. `reasons` is written to
// be read out loud to her, each naming its source and the date somebody last
// checked it, because "blocked" without a citation is an instruction she
// cannot act on or argue with.
function check({ port_of_discharge = null, origin_country = 'US', material = null,
                 asOf = null, rows = null } = {}) {
    const when = asOf || today();
    const list = Array.isArray(rows) ? rows.filter((r) => r && r.id) : rules();
    const country = countryOf(port_of_discharge);

    if (!country) {
        return {
            outcome: 'unknown', country: null,
            reasons: [port_of_discharge
                ? `Cannot tell which country "${port_of_discharge}" is in, so no rule was applied.`
                : 'No port of discharge on this shipment, so no rule was applied.'],
            actions: ['Add the country to the port of discharge, or add the port to '
                + 'helpers/exportRules.js COUNTRIES.'],
            matched: [],
        };
    }

    const mine = list.filter((r) => String(r.country || '').toUpperCase() === country.code
        && applies(r, { origin_country, material }));

    if (!mine.length) {
        return {
            outcome: 'unknown', country,
            reasons: [`Nothing on file about importing scrap into ${country.name}.`],
            actions: [`Ask the buyer's customs broker what ${country.name} requires, `
                + 'then record it so the next container does not ask again.'],
            matched: [],
        };
    }

    const reasons = [];
    const actions = [];
    let blocked = false;
    let stale = false;

    for (const r of mine) {
        const st = statusOf(r, when);
        const cite = r.source_ref ? ` (${r.source_ref})` : '';
        if (!st.actionable) {
            stale = true;
            const detail = st.why === 'disputed'
                ? `the sources on file disagree${cite}`
                : st.why === 'never_verified'
                    ? 'nobody has confirmed it'
                    : `last confirmed ${r.verified_on} by ${r.verified_by}, which lapsed ${st.expires_on}`;
            reasons.push(`${country.name}: ${r.requirement} — but ${detail}.`);
            actions.push(r.how_to_verify
                || `Confirm with the buyer's broker, then record it against rule ${r.id}.`);
            continue;
        }
        if (r.outcome === 'prohibited' || r.outcome === 'required') {
            // `required` is not a refusal in itself — it is a refusal until the
            // document exists. Whether it does is the caller's to know; this
            // module will not assume a certificate is in a drawer somewhere.
            blocked = true;
            reasons.push(`${country.name}: ${r.requirement}${cite} — confirmed `
                + `${r.verified_on} by ${r.verified_by}.`);
            if (r.what_to_do) actions.push(r.what_to_do);
        } else if (r.outcome === 'exempt' || r.outcome === 'allowed') {
            reasons.push(`${country.name}: ${r.requirement}${cite} — confirmed `
                + `${r.verified_on} by ${r.verified_by}.`);
        } else {
            stale = true;
            reasons.push(`${country.name}: rule ${r.id} has an outcome this version `
                + `does not understand ("${r.outcome}"), so it was not applied.`);
        }
    }

    // Order matters and this is the whole doctrine of the file: a real block
    // beats staleness, and staleness beats clear. `clear` is reached only when
    // every matching rule was actionable and none of them said no.
    const outcome = blocked ? 'blocked' : (stale ? 'unknown' : 'clear');
    return { outcome, country, reasons, actions, matched: mine.map((r) => r.id) };
}

// ── A HUMAN RECORDS THAT THEY CHECKED ────────────────────────────────────
// The only write. `by` is required and is not allowed to be a system name:
// the point of the field is that a person is accountable for the rule, and
// "jarvis" in that column would make the whole register decorative.
async function verify(id, { by, on = null, expires_on = null, outcome = null,
                            requirement = null, source_url = null, source_ref = null,
                            clear_disputed = false, note = null } = {}) {
    const who = String(by || '').trim();
    if (!id) throw new Error('which rule?');
    if (!who) throw new Error('verifying a rule needs a person — who confirmed it?');
    if (/^(jarvis|system|auto|bot|claude)$/i.test(who)) {
        throw new Error('a rule has to be confirmed by a person, not by Jarvis');
    }
    let found = false;
    await mutateJson(cfg.EXPORT_RULES_FILE, [], (all) => {
        const rowsIn = Array.isArray(all) ? all : [];
        for (const r of rowsIn) {
            if (!r || r.id !== id) continue;
            found = true;
            r.verified_by = who;
            r.verified_on = on || today();
            r.expires_on = expires_on || addDays(r.verified_on, DEFAULT_VALID_DAYS);
            if (outcome) r.outcome = outcome;
            if (requirement) r.requirement = requirement;
            if (source_url) r.source_url = source_url;
            if (source_ref) r.source_ref = source_ref;
            if (clear_disputed) r.disputed = false;
            r.history = Array.isArray(r.history) ? r.history : [];
            r.history.push({ on: r.verified_on, by: who, note: note || null,
                outcome: r.outcome });
        }
        return rowsIn;
    });
    if (!found) throw new Error(`no rule with id ${id}`);
    return { ok: true, id, verified_by: who };
}

// Everything a human needs to look at: never verified, expired, disputed, or
// about to lapse. This is the list the nightly sweep should mail, because a
// register nobody tends decays into the badge it was built to replace.
function needsAttention({ asOf = null, within_days = 30, rows = null } = {}) {
    const when = asOf || today();
    const soon = addDays(when, within_days);
    const out = [];
    for (const r of (Array.isArray(rows) ? rows : rules())) {
        const st = statusOf(r, when);
        if (!st.actionable) { out.push({ id: r.id, country: r.country, why: st.why, rule: r }); continue; }
        if (String(st.expires_on) <= String(soon)) {
            out.push({ id: r.id, country: r.country, why: 'lapsing', expires_on: st.expires_on, rule: r });
        }
    }
    return out;
}

module.exports = {
    check, countryOf, rules, statusOf, verify, needsAttention, addDays,
    COUNTRIES, OUTCOMES, DEFAULT_VALID_DAYS,
};
