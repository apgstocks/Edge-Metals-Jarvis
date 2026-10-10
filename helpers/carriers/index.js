// ── helpers/carriers/index.js — one door for every shipping line ──────────
// The Booking Agent asks "what does the carrier say for this booking?" and
// should not care which line answered. Each line is an adapter with the same
// surface: { id, label, configured(), vesselImo(name), deadlines({...}) }.
//
// Only Maersk exists. HMM is the next candidate but has not granted access,
// and bookings go through Zimex, so there is no HMM account to ask with.
// Adding a line later is one file plus one line below; nothing else moves.
const maersk = require('./maersk');

const ADAPTERS = { [maersk.id]: maersk };

const get = (id) => ADAPTERS[String(id || '').toLowerCase()] || null;
const ids = () => Object.keys(ADAPTERS);

module.exports = { get, ids, ADAPTERS };
