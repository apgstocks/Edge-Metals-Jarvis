// ── trial-contacts.js — truckers and suppliers for a TRIAL copy, kept in data/ instead of Supabase ──
// The live app stores truckers/suppliers in Supabase (helpers/json.js). A trial has no Supabase, so the
// Truckers & Suppliers page failed to load and adding one threw. This swaps those six functions for
// file-backed ones, in the trial copy only, before anything else requires helpers/json. Same row shape
// ({ name, locality, whatsapp, email, group_id, preferred_mode }) and the same upsert-by-name rule.
const fs = require('fs'), path = require('path');
module.exports = function useLocalContacts(cfg) {
    const json = require('./helpers/json');
    const fileOf = (t) => (t === 'truckers' ? cfg.TRUCKERS_FILE : cfg.SUPPLIERS_FILE);
    const read = (t) => { try { const v = JSON.parse(fs.readFileSync(fileOf(t), 'utf8')); return Array.isArray(v) ? v : []; } catch (e) { return []; } };
    const write = (t, rows) => { fs.mkdirSync(path.dirname(fileOf(t)), { recursive: true }); const tmp = fileOf(t) + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(rows, null, 1)); fs.renameSync(tmp, fileOf(t)); };
    const load = (t) => async () => read(t).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const upsert = (t) => async (p) => {
        if (!p || !p.name) throw new Error('name required');
        const rows = read(t), i = rows.findIndex((r) => String(r.name).toLowerCase() === String(p.name).toLowerCase());
        if (i > -1) rows[i] = { ...rows[i], ...p }; else rows.push({ id: Date.now() + Math.floor(Math.random() * 1000), ...p });
        write(t, rows);
    };
    const del = (t) => async (name) => write(t, read(t).filter((r) => String(r.name).toLowerCase() !== String(name).toLowerCase()));
    Object.assign(json, {
        loadTruckers: load('truckers'), loadSuppliers: load('suppliers'),
        upsertTrucker: upsert('truckers'), upsertSupplier: upsert('suppliers'),
        deleteTrucker: del('truckers'), deleteSupplier: del('suppliers'),
    });
    return json;
};
