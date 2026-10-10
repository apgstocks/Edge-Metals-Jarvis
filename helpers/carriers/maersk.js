// ── helpers/carriers/maersk.js — what Maersk itself says the deadlines are ─
// Apsara, 2026-10-03: "Build Maersk api integration to Booking Agent."
//
// WHY MAERSK, AND WHY ONLY THESE TWO CALLS
// Edge Metals books every carrier through Zimex, so it holds no booking-level
// account with any line and HMM never answered the API requests. Maersk's
// shipment-deadlines endpoint does not need a booking: it is keyed on the
// VESSEL (IMO), the voyage, and the port of load. Any Consumer-Key from
// developer.maersk.com can read it. That is the one carrier source this
// business can actually reach today.
//
//   GET https://api.maersk.com/reference-data/vessels?vesselNames=NAME
//   GET https://api.maersk.com/shipment-deadlines
//         ?ISOCountryCode=US&portOfLoad=Houston&vesselIMONumber=...&voyage=...
//   Header: Consumer-Key: <MAERSK_CONSUMER_KEY>
//
// Shapes confirmed against two independent working clients (Microsoft's
// Power Platform connector reference and a public MCP server), not guessed.
//
// READ-ONLY, ALWAYS. Nothing here writes to bookings.json. The carrier's date
// is evidence for a person to look at, never an overwrite: a wrong vessel
// match would otherwise silently move a real cutoff.
//
// NEVER THROWS. Every outcome is { ok, ... } with a reason, because the job
// that calls this runs unattended at 7am and one bad booking must not stop
// the rest of the list being checked.

const BASE = 'https://api.maersk.com';
const TIMEOUT_MS = 15000;

const key = () => String(process.env.MAERSK_CONSUMER_KEY || '').trim();
const configured = () => key().length > 0;

// One reason string per failure kind, so the morning message and the logs
// say WHY and not just "failed". auth = the key; quota = slow down;
// notfound = the vessel/voyage/port did not match anything Maersk knows.
function reasonFor(status) {
    if (status === 401 || status === 403) return 'auth';
    if (status === 429) return 'quota';
    if (status === 404) return 'notfound';
    if (status >= 500) return 'maersk_down';
    return 'http_' + status;
}

async function getJson(pathAndQuery, fetchImpl) {
    const f = fetchImpl || globalThis.fetch;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
        const res = await f(BASE + pathAndQuery, {
            method: 'GET',
            headers: { 'Consumer-Key': key(), Accept: 'application/json' },
            signal: ctl.signal,
        });
        if (!res.ok) return { ok: false, reason: reasonFor(res.status), status: res.status };
        let body = null;
        try { body = await res.json(); } catch { return { ok: false, reason: 'bad_json' }; }
        return { ok: true, body };
    } catch (e) {
        return { ok: false, reason: e && e.name === 'AbortError' ? 'timeout' : 'unreachable' };
    } finally {
        clearTimeout(timer);
    }
}

// Vessel name → IMO. Returns the IMO only when Maersk returns EXACTLY one
// vessel for the name. Two vessels for one name is not a lookup, it is a
// guess, and a guessed IMO would compare our booking against another ship's
// deadlines and produce a confident wrong alert.
async function vesselImo(vesselName, { fetchImpl } = {}) {
    const name = String(vesselName || '').trim();
    if (!name) return { ok: false, reason: 'no_vessel_name' };
    if (!configured()) return { ok: false, reason: 'no_key' };
    const r = await getJson('/reference-data/vessels?vesselNames=' + encodeURIComponent(name), fetchImpl);
    if (!r.ok) return r;
    const rows = Array.isArray(r.body) ? r.body.filter(v => v && v.vesselIMONumber) : [];
    const imos = [...new Set(rows.map(v => String(v.vesselIMONumber)))];
    if (imos.length === 0) return { ok: false, reason: 'vessel_unknown' };
    if (imos.length > 1) return { ok: false, reason: 'vessel_ambiguous', candidates: imos };
    return { ok: true, imo: imos[0] };
}

// The response is an array with one entry per terminal at the port, each
// carrying { shipmentDeadlines: { terminalName, deadlines: [...] } }.
// Normalised to [{ terminal, deadlines: [{ name, local }] }] so nothing
// downstream depends on Maersk's nesting. Entries with no usable timestamp
// are dropped here rather than compared as "Invalid Date" later.
function normaliseDeadlines(body) {
    const rows = Array.isArray(body) ? body : (body ? [body] : []);
    const out = [];
    for (const row of rows) {
        const sd = row && (row.shipmentDeadlines || row);
        const list = sd && Array.isArray(sd.deadlines) ? sd.deadlines : [];
        const deadlines = list
            .map(d => ({ name: String(d && d.deadlineName || '').trim(), local: String(d && d.deadlineLocal || '').trim() }))
            .filter(d => d.name && /^\d{4}-\d{2}-\d{2}/.test(d.local));
        if (deadlines.length) out.push({ terminal: String(sd.terminalName || '').trim() || null, deadlines });
    }
    return out;
}

async function deadlines({ imo, voyage, portOfLoad, isoCountry }, { fetchImpl } = {}) {
    if (!configured()) return { ok: false, reason: 'no_key' };
    if (!imo || !voyage || !portOfLoad || !isoCountry) return { ok: false, reason: 'missing_input' };
    const q = new URLSearchParams({
        ISOCountryCode: String(isoCountry).toUpperCase(),
        portOfLoad: String(portOfLoad),
        vesselIMONumber: String(imo),
        voyage: String(voyage),
    });
    const r = await getJson('/shipment-deadlines?' + q.toString(), fetchImpl);
    if (!r.ok) return r;
    const terminals = normaliseDeadlines(r.body);
    if (!terminals.length) return { ok: false, reason: 'no_deadlines' };
    return { ok: true, terminals };
}

module.exports = {
    id: 'maersk',
    label: 'Maersk',
    configured,
    vesselImo,
    deadlines,
    normaliseDeadlines,
    reasonFor,
};
