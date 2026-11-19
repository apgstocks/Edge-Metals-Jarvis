// ── trial-seed.js — fake yard data for a trial, written through the app's own helpers ──
// Run from inside the trial folder: node trial-seed.js. Safe to re-run only on an empty data/ (it refuses otherwise),
// so it can never pile a second set of demo loads onto a customer's real entries.
const fs = require('fs'), path = require('path');
for (const l of (fs.existsSync(path.join(__dirname, '.env')) ? fs.readFileSync(path.join(__dirname, '.env'), 'utf8') : '').split('\n')) {
    const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
const cfg = require('./config');
const contacts = require('./trial-contacts')(cfg);
const loads = require('./helpers/loads');
const outbound = require('./helpers/outboundLoads');
const itemMetal = require('./helpers/itemMetal');

const day = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const it = (description, gross, price, extra = {}) => ({ description, gross_weight: gross, tare_weight: 0, price, ...extra });

(async () => {
    if (loads.loadLoads().length || outbound.loadOutboundLoads().length) { console.error('data/ already has loads; not seeding on top of them.'); process.exit(1); }
    // what the yard handles, and whether it is ferrous (so the demo shows the ferrous question already answered)
    for (const [d, t] of [['Rotors', 'ferrous'], ['Steel turnings', 'ferrous'], ['Auto cast', 'ferrous'], ['Copper wire', 'non-ferrous'], ['Aluminum wheels', 'non-ferrous'], ['Brass', 'non-ferrous']]) await itemMetal.remember(d, t);
    const buys = [
        [27, 'Riverside Auto Parts', [it('Rotors', 4200, 0.11), it('Auto cast', 2600, 0.09)]],
        [24, "Sam's Salvage", [it('Copper wire', 800, 2.1), it('Brass', 450, 1.35)]],
        [21, 'Mesa Recycling', [it('Aluminum wheels', 1900, 0.62), it('Steel turnings', 6100, 0.07)]],
        [17, 'Riverside Auto Parts', [it('Rotors', 3900, 0.115)]],
        [13, "Sam's Salvage", [it('Copper wire', 650, 2.15)]],
        [9, 'Mesa Recycling', [it('Auto cast', 3300, 0.095), it('Aluminum wheels', 1200, 0.64)]],
        [4, 'Riverside Auto Parts', [it('Rotors', 4500, 0.12)]],
    ];
    for (const [ago, seller, items] of buys) await loads.addLoad({ date: day(ago), seller, weight_unit: 'lb', items });
    const sells = [
        [15, 'Gulf Export Co', [it('Rotors', 6000, 0.17)]],
        [8, 'Pacific Metals Buyer', [it('Copper wire', 700, 2.9), it('Aluminum wheels', 1500, 0.9)]],
        [2, 'Gulf Export Co', [it('Auto cast', 3000, 0.14)]],
    ];
    for (const [ago, buyer, items] of sells) await outbound.addOutboundLoad({ date: day(ago), buyer, weight_unit: 'lb', items });
    // fictional truckers and suppliers, so Truckers & Suppliers is not empty on day one
    const truckers = [
        { name: 'Gold Coast Drayage', locality: 'Long Beach, CA', whatsapp: '15550100201', email: 'dispatch@goldcoast.example', preferred_mode: 'whatsapp' },
        { name: 'Harbor Line Trucking', locality: 'Wilmington, CA', whatsapp: '15550100202', email: 'ops@harborline.example', preferred_mode: 'email' },
        { name: 'Blue Ridge Haulers', locality: 'Ontario, CA', whatsapp: '15550100203', email: 'loads@blueridge.example', preferred_mode: 'whatsapp' },
    ];
    const suppliers = [
        { name: 'Riverside Auto Parts', locality: 'Riverside, CA', whatsapp: '15550100301', email: 'yard@riverside.example', preferred_mode: 'whatsapp' },
        { name: 'Mesa Recycling', locality: 'Mesa, AZ', whatsapp: '15550100302', email: 'sales@mesarecycling.example', preferred_mode: 'email' },
        { name: "Sam's Salvage", locality: 'Fresno, CA', whatsapp: '15550100303', email: 'sam@samssalvage.example', preferred_mode: 'whatsapp' },
        { name: 'Desert Steel Supply', locality: 'Phoenix, AZ', whatsapp: '15550100304', email: 'office@desertsteel.example', preferred_mode: 'email' },
    ];
    for (const t of truckers) await contacts.upsertTrucker(t);
    for (const s of suppliers) await contacts.upsertSupplier(s);
    console.log(`[seed] ${buys.length} loads bought, ${sells.length} sold, ${truckers.length} truckers, ${suppliers.length} suppliers, into ${cfg.DATA_DIR}`);
})().catch((e) => { console.error('[seed] ' + e.message); process.exit(1); });
