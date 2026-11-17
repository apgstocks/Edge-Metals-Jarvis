// ── helpers/loadCompany.js — which of her three companies a load or sale is ──
// Apsara, 2026-11-17: "in Loads, i want the buyer as option as Edge Trading /
// Edge Metal / AAA Investment. so as seller." Purchases: she picks the BUYER.
// Sales: she picks the SELLER. Then, asked how far it goes: "Money moving
// between companies is for another day. For now, loads/sales only."
//
// So this is a LABEL on the record. It is saved, shown, and used on the PO.
// It does NOT move the record between books, stock, payments or QuickBooks —
// helpers/entities.js still places both stores by store, exactly as before.
// Nothing here may be read as a ledger decision; if she later wants the books
// to follow it, that is its own change (entities.of, payments, booksBuild,
// stock) and it needs her yes.
const COMPANIES = ['Edge Trading', 'Edge Metals', 'AAA Investment'];
const DEFAULT_COMPANY = 'Edge Trading';
const ALIAS = {
    'edge trading': 'Edge Trading', 'edge trading inc': 'Edge Trading', 'edge yard': 'Edge Trading',
    'edge metals': 'Edge Metals', 'edge metals inc': 'Edge Metals', 'edge metal': 'Edge Metals',
    'aaa investment': 'AAA Investment', 'aaa investments': 'AAA Investment',
};
const keyOf = (s) => String(s || '').toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
// The canonical name for one of the three, or null for anything else.
function canon(s) { return ALIAS[keyOf(s)] || null; }

// What a PURCHASE's `buyer` becomes. A picked company wins. When the caller
// never mentions the picker (the APK already on her phone, the voice path) an
// edit must not quietly turn an Edge Metals purchase back into Edge Trading,
// so a known non-default company already on file is kept. A caller that DOES
// say 'Edge Trading' changes it back, because it said so.
function chooseBuyer(entry, priorBuyer) {
    const picked = canon(entry.buyer_company);
    if (picked) return picked;
    const prior = canon(priorBuyer);
    if (entry.buyer_company === undefined && prior && prior !== DEFAULT_COMPANY) return prior;
    return entry.buyer || null;
}

module.exports = { COMPANIES, DEFAULT_COMPANY, canon, chooseBuyer };
