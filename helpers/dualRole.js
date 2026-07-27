// ── helpers/dualRole.js — Detect contacts who act as BOTH supplier + trucker ─
// Some companies handle a booking end-to-end themselves — no separate
// trucker. Detected automatically by matching whatsapp number (primary) or
// name (fallback) across the suppliers and truckers tables — no manual flag
// needed, per Apsara's decision.

const { loadTruckers, loadSuppliers } = require('./json');

const digits = (v) => String(v || '').replace(/\D/g, '');

// Look up whether a given contact name is a dual-role entity. Returns
// { supplier, trucker } if so, null otherwise.
async function findDualRole(name) {
    const [truckers, suppliers] = await Promise.all([loadTruckers(), loadSuppliers()]);
    const lower = String(name || '').toLowerCase();

    const t = truckers.find(x => (x.name || '').toLowerCase() === lower);
    const s = suppliers.find(x => (x.name || '').toLowerCase() === lower);
    if (t && s) return { supplier: s, trucker: t };

    // Names can differ slightly (e.g. "APS Logistics" vs "APS") while still
    // being the same company — whatsapp number is the more reliable signal.
    if (t?.whatsapp) {
        const matchS = suppliers.find(x => x.whatsapp && digits(x.whatsapp) === digits(t.whatsapp));
        if (matchS) return { supplier: matchS, trucker: t };
    }
    if (s?.whatsapp) {
        const matchT = truckers.find(x => x.whatsapp && digits(x.whatsapp) === digits(s.whatsapp));
        if (matchT) return { supplier: s, trucker: matchT };
    }
    return null;
}

// Once a specific supplier AND trucker have been resolved for a booking,
// check if they're actually the same combined entity — used to decide
// whether to send one combined message or two separate ones.
function isSamePairing(supplierRecord, truckerRecord) {
    if (!supplierRecord || !truckerRecord) return false;
    if (supplierRecord.whatsapp && truckerRecord.whatsapp &&
        digits(supplierRecord.whatsapp) === digits(truckerRecord.whatsapp)) return true;
    return (supplierRecord.name || '').toLowerCase() === (truckerRecord.name || '').toLowerCase();
}

module.exports = { findDualRole, isSamePairing };
