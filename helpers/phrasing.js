// ── helpers/phrasing.js — Natural message variation, zero AI dependency ─────
// Deterministic messages (check-ins, confirmations, errors) were all fixed
// strings — reliable, but repeat identically every time, which reads as
// robotic once you see the same exact wording across multiple bookings.
// This fixes that WITHOUT routing through an LLM call (which would add real
// cost/latency/reliability risk for a purely cosmetic concern — the whole
// point of the deterministic layer is that it doesn't depend on Gemini being
// up). Just a random pick from a small pool of equivalent phrasings.

function pickVariant(templates, ...args) {
    const list = Array.isArray(templates) ? templates : [templates];
    const chosen = list[Math.floor(Math.random() * list.length)];
    return typeof chosen === 'function' ? chosen(...args) : chosen;
}

module.exports = { pickVariant };
