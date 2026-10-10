// ── helpers/bookingAgent.js — does the carrier agree with our booking? ─────
// Apsara, 2026-10-03: "Build Maersk api integration to Booking Agent."
//
// WHAT IT ANSWERS
// For every live booking on a line we have an adapter for, ask the carrier
// for its own cutoff / ERD and compare with bookings.json. Today the only
// check is email-vs-file; a cutoff the line moves WITHOUT anyone emailing is
// invisible. This is the third source.
//
// WHAT IT IS ALLOWED TO DO
// Read bookings, call the carrier, and write ONLY its own file
// (data/booking-agent.json: identities, learned deadline names, vessel IMOs,
// the last result). It never writes bookings.json. A finding is a question
// for a person — "Maersk says the 16th, we have the 14th" — because the
// carrier can be checked against the wrong terminal, and Zimex may have
// negotiated a late gate that the public deadline does not show.
//
// WHERE THE MODEL DECIDES, AND WHERE CODE DOES
// Standing rule: no keyword tables for meaning. So two judgements go to the
// model, each cached so it is paid for once:
//   1. Which line carries a booking, and the vessel / voyage / port city /
//      country inside free text like "MAERSK KOWLOON / 118E" + "HOUSTON".
//      Cached per booking until carrier, vessel_voyage or port changes.
//   2. What a carrier's deadline NAME means — is "Port Cutoff" our cutoff,
//      is "Earliest Receiving" our ERD. Cached per exact name, forever, so
//      after the first week this costs nothing.
// Date comparison is code. A model is not asked whether 10/14 equals 10/16.
//
// IF THE MODEL IS DOWN: unidentified bookings and unseen deadline names are
// skipped for that run and counted, never guessed.

const path = require('path');
const cfg = require('../config');
const { loadJson, mutateJson, loadBookings } = require('./json');
const { daysUntil } = require('./time');
const { PAST_BY_DAYS } = require('./cutoffScan');
const carriers = require('./carriers');

const STORE = () => path.join(cfg.DATA_DIR, 'booking-agent.json');
const EMPTY = () => ({ identity: {}, roles: {}, imo: {}, last: null });

// The two booking fields the agent compares. Only these: a role the model
// returns that is not one of ours is "other" and ignored.
const FIELDS = { cutoff: 'cutoff_date', erd: 'erd_date' };

const str = (v) => String(v == null ? '' : v).trim();
const fingerprint = (b) => [b.carrier, b.vessel_voyage, b.port_of_loading].map(str).join('|');

// MM/DD/YYYY (how bookings.json stores dates) → YYYY-MM-DD, or null.
function usToIso(us) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(str(us));
    if (!m) return null;
    return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}
// Carrier local timestamp → its calendar date. Local to the port on purpose:
// the booking's cutoff is also a port-local calendar date.
const localDay = (s) => (/^(\d{4}-\d{2}-\d{2})/.exec(str(s)) || [])[1] || null;

const loadStore = () => Object.assign(EMPTY(), loadJson(STORE(), EMPTY()));

// ── WHICH BOOKINGS ARE WORTH ASKING ABOUT ─────────────────────────────────
// Past-cutoff bookings are skipped with the SAME rule the archiver uses
// (cutoffScan.PAST_BY_DAYS), so the agent never chases a booking the nightly
// job is about to archive. No cutoff at all is still checked — that is
// exactly the booking where the carrier's date is most useful.
function liveBookings(bookings) {
    const out = [];
    for (const [bkgNo, b] of Object.entries(bookings || {})) {
        if (!b) continue;
        if (b.cutoff_date && daysUntil(b.cutoff_date) <= PAST_BY_DAYS) continue;
        out.push([bkgNo, b]);
    }
    return out;
}

// ── JUDGEMENT 1: who carries it, and the parts the API needs ──────────────
async function identify(rows, ai) {
    if (!rows.length) return { ok: true, items: [] };
    const lines = carriers.ids().join(', ');
    const prompt = [
        'You read export booking records for a US scrap-metal exporter.',
        `For each booking decide which ocean carrier operates it. Answer one of: ${lines}, or "other" if it is a different line, or "unknown" if you cannot tell.`,
        'Then extract, only from the text given:',
        '- vessel_name: the ship name without the carrier prefix if the prefix is just the line name repeated (e.g. "MAERSK KOWLOON / 118E" → "MAERSK KOWLOON" is the ship name; keep it as the ship is actually called).',
        '- voyage: the voyage code (e.g. "118E").',
        '- port_city: the city of the port of loading as a carrier would name it (e.g. "Houston").',
        '- iso_country: ISO 3166-1 alpha-2 country of that port (e.g. "US").',
        'Use null for anything not present. Do not invent values.',
        'Return JSON: {"bookings":[{"bkgNo":"","carrier":"","vessel_name":null,"voyage":null,"port_city":null,"iso_country":null}]}',
        '',
        'BOOKINGS:',
        JSON.stringify(rows.map(([bkgNo, b]) => ({
            bkgNo, carrier: str(b.carrier) || null, vessel_voyage: str(b.vessel_voyage) || null,
            port_of_loading: str(b.port_of_loading) || null,
        }))),
    ].join('\n');
    const res = await ai(prompt);
    const list = res && Array.isArray(res.bookings) ? res.bookings : null;
    if (!list) return { ok: false, items: [] };
    return { ok: true, items: list.filter(x => x && x.bkgNo) };
}

// ── JUDGEMENT 2: what a carrier's deadline name means ─────────────────────
async function learnRoles(names, ai) {
    if (!names.length) return { ok: true, roles: {} };
    const prompt = [
        'A container line published these terminal deadline names for an export sailing.',
        'The cargo is scrap metal in ordinary dry containers (not reefer, not dangerous goods, not out-of-gauge).',
        'For each name, say which of our two booking dates it corresponds to:',
        '- "cutoff": the last time a loaded dry container can be delivered (gated in) to the terminal for this sailing.',
        '- "erd": the earliest date the terminal will start receiving export containers for this sailing.',
        '- "other": anything else (documentation, shipping instructions, VGM, customs, reefer, dangerous goods, release, etc).',
        'Return JSON: {"roles":{"<exact name>":"cutoff|erd|other"}}',
        '',
        'NAMES:',
        JSON.stringify(names),
    ].join('\n');
    const res = await ai(prompt);
    const roles = res && res.roles && typeof res.roles === 'object' ? res.roles : null;
    if (!roles) return { ok: false, roles: {} };
    const clean = {};
    for (const n of names) {
        const r = str(roles[n]).toLowerCase();
        if (r === 'cutoff' || r === 'erd' || r === 'other') clean[n] = r;
    }
    return { ok: true, roles: clean };
}

// ── THE COMPARISON — code, not the model ──────────────────────────────────
// A booking AGREES on a field if ANY terminal's date matches ours: the API
// lists every terminal at the port and the booking does not record which
// one it gates at. Disagreement is only claimed when NO terminal matches.
function compare(booking, terminals, roles) {
    const findings = [];
    for (const [role, field] of Object.entries(FIELDS)) {
        const seen = [];
        for (const t of terminals) for (const d of t.deadlines) {
            if (roles[d.name] !== role) continue;
            const day = localDay(d.local);
            if (day) seen.push({ day, name: d.name, terminal: t.terminal, local: d.local });
        }
        if (!seen.length) continue;
        const days = [...new Set(seen.map(s => s.day))].sort();
        const ours = usToIso(booking[field]);
        if (ours && days.includes(ours)) continue;
        findings.push({
            role, field,
            kind: ours ? 'differs' : 'missing',
            ours: booking[field] || null,
            carrierDays: days,
            evidence: seen,
        });
    }
    return findings;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── THE RUN ───────────────────────────────────────────────────────────────
// deps are injectable so the test drives the real code with a fake carrier
// and a fake model; production passes nothing.
async function check(deps = {}) {
    const ai = deps.ai || ((p) => require('./gemini').callGeminiJSON(p));
    const fetchImpl = deps.fetchImpl;
    const gapMs = deps.gapMs == null ? 1100 : deps.gapMs;   // Maersk default quota is 60/min
    const bookings = deps.bookings || loadBookings() || {};
    const store = loadStore();

    const result = {
        at: new Date().toISOString(),
        checked: 0, agreed: 0,
        findings: [], skipped: [],
        aiDown: false, noKey: false, authFailed: false,
    };

    const live = liveBookings(bookings);

    // Forget bookings that no longer exist, so the store does not grow
    // forever with archived ones. Roles and IMOs are kept: they are about
    // the carrier and the ship, not the booking.
    for (const k of Object.keys(store.identity)) if (!(k in bookings)) delete store.identity[k];

    // Re-identify only what is new or changed since last time.
    const stale = live.filter(([k, b]) => !store.identity[k] || store.identity[k].fp !== fingerprint(b));
    if (stale.length) {
        const id = await identify(stale, ai);
        if (!id.ok) result.aiDown = true;
        const byNo = Object.fromEntries(id.items.map(x => [String(x.bkgNo), x]));
        for (const [k, b] of stale) {
            const x = byNo[k];
            if (!x) continue;
            store.identity[k] = {
                fp: fingerprint(b),
                carrier: str(x.carrier).toLowerCase() || 'unknown',
                vessel: str(x.vessel_name) || null,
                voyage: str(x.voyage) || null,
                port: str(x.port_city) || null,
                iso: str(x.iso_country).toUpperCase() || null,
            };
        }
    }

    const pending = [];
    for (const [bkgNo, b] of live) {
        const idn = store.identity[bkgNo];
        if (!idn) { result.skipped.push({ bkgNo, reason: 'not_identified' }); continue; }
        const adapter = carriers.get(idn.carrier);
        if (!adapter) continue;                              // another line — not ours to check
        if (!adapter.configured()) { result.noKey = true; result.skipped.push({ bkgNo, reason: 'no_key' }); continue; }
        if (!idn.vessel || !idn.voyage || !idn.port || !idn.iso) {
            result.skipped.push({ bkgNo, reason: 'incomplete_vessel_or_port' }); continue;
        }
        pending.push({ bkgNo, b, idn, adapter });
    }

    for (let i = 0; i < pending.length; i++) {
        const { bkgNo, b, idn, adapter } = pending[i];
        if (result.authFailed) { result.skipped.push({ bkgNo, reason: 'auth' }); continue; }
        if (i > 0 && gapMs) await sleep(gapMs);

        const imoKey = `${adapter.id}:${idn.vessel.toUpperCase()}`;
        let imo = store.imo[imoKey] || null;
        if (!imo) {
            const v = await adapter.vesselImo(idn.vessel, { fetchImpl });
            if (!v.ok) {
                if (v.reason === 'auth') result.authFailed = true;
                result.skipped.push({ bkgNo, reason: v.reason }); continue;
            }
            imo = v.imo; store.imo[imoKey] = imo;
            if (gapMs) await sleep(gapMs);
        }

        const dl = await adapter.deadlines({ imo, voyage: idn.voyage, portOfLoad: idn.port, isoCountry: idn.iso }, { fetchImpl });
        if (!dl.ok) {
            if (dl.reason === 'auth') result.authFailed = true;
            result.skipped.push({ bkgNo, reason: dl.reason }); continue;
        }

        const unseen = [...new Set(dl.terminals.flatMap(t => t.deadlines.map(d => d.name)))]
            .filter(n => !(n in store.roles));
        if (unseen.length) {
            const learned = await learnRoles(unseen, ai);
            if (!learned.ok) result.aiDown = true;
            Object.assign(store.roles, learned.roles);
        }

        result.checked += 1;
        const f = compare(b, dl.terminals, store.roles);
        if (!f.length) { result.agreed += 1; continue; }
        for (const x of f) result.findings.push(Object.assign({
            bkgNo, carrier: adapter.label, vessel_voyage: b.vessel_voyage || null,
            port_of_loading: b.port_of_loading || null,
        }, x));
    }

    // Built OUTSIDE the lock and only assigned inside it: mutateJson
    // swallows errors thrown in its callback, so nothing may throw there.
    const toSave = {
        identity: store.identity, roles: store.roles, imo: store.imo,
        last: { at: result.at, checked: result.checked, agreed: result.agreed,
                findings: result.findings.length, skipped: result.skipped.length },
    };
    await mutateJson(STORE(), EMPTY(), () => toSave);
    return result;
}

module.exports = { check, compare, liveBookings, identify, learnRoles, usToIso, localDay, fingerprint, FIELDS, STORE };
