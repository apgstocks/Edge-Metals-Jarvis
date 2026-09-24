// ── helpers/bankDocs.js — the Bank tab's accounts and their documents ──────
//
// Apsara, 2026-09-24: "Create a Bank tab under documents in webiste" and then
// "also have a option to upload under Bank. Keep storing the documents. Left
// side Bank name. Right side button. click it to download".
//
// The account NUMBERS live in qb-settings/bank-accounts.json (in git, so a
// changed account is one edit in one place). The DOCUMENTS — a voided cheque,
// a bank letter, a W-9 — live on the server beside the data, one folder per
// account, because they are scans that have no business in a git repo.
//
// Who can do what: anyone with Jarvis can read the details and download a
// document (they are what customers are given anyway); only an admin session
// can upload or remove one.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt']);

function accountsFile(cfg) { return path.join(cfg.ROOT, 'qb-settings', 'bank-accounts.json'); }
function docsRoot(cfg) { return path.join(cfg.DATA_DIR, 'bank-docs'); }
function readAccounts(cfg) { return JSON.parse(fs.readFileSync(accountsFile(cfg), 'utf8')); }

// A filename from a browser is not a path. Anything with a slash, a dot-dot
// or a leading dot is not negotiated with — it is rewritten.
function safeName(name) {
    const base = path.basename(String(name || '')).replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '').trim();
    return base.slice(0, 120) || 'document';
}
function accountDir(cfg, id) {
    const acc = readAccounts(cfg).accounts.find((a) => a.id === id);
    if (!acc) return null;
    return path.join(docsRoot(cfg), safeName(acc.id));
}
function listDocs(cfg, id) {
    const dir = accountDir(cfg, id);
    if (!dir) return [];
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    return names.filter((n) => !n.startsWith('.')).map((n) => {
        const st = fs.statSync(path.join(dir, n));
        return { name: n, bytes: st.size, at: st.mtime.toISOString() };
    }).sort((a, b) => b.at.localeCompare(a.at));
}

function mount(app, cfg) {
    const admin = (req, res) => {
        if (req.role !== 'admin') { res.status(403).json({ error: 'only an admin can change bank documents' }); return false; }
        return true;
    };

    app.get('/api/bank-accounts', (req, res) => {
        try {
            const d = readAccounts(cfg);
            d.accounts = d.accounts.map((a) => ({ ...a, documents: listDocs(cfg, a.id) }));
            res.json(d);
        } catch (e) { res.status(500).json({ error: `bank-accounts.json: ${e.message}` }); }
    });

    // upload: base64 in JSON, the same shape the PDF routes in api.js use
    app.post('/api/bank-accounts/:id/docs', (req, res) => {
        if (!admin(req, res)) return;
        const dir = accountDir(cfg, req.params.id);
        if (!dir) return res.status(404).json({ error: 'no such account' });
        const { filename, base64 } = req.body || {};
        if (!filename || !base64) return res.status(400).json({ error: 'filename and base64 are both needed' });
        const name = safeName(filename);
        const ext = path.extname(name).toLowerCase();
        if (!ALLOWED.has(ext)) return res.status(400).json({ error: `${ext || 'that kind of file'} is not allowed here — PDF, image, Word, Excel, CSV or text` });
        const body = Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ''), 'base64');
        if (!body.length) return res.status(400).json({ error: 'the file came through empty' });
        if (body.length > MAX_BYTES) return res.status(413).json({ error: `too big (${Math.round(body.length / 1048576)}MB) — the limit is 20MB` });
        try {
            fs.mkdirSync(dir, { recursive: true });
            // never silently replace: a second "cheque.pdf" becomes cheque (2).pdf
            let out = path.join(dir, name), n = 1;
            while (fs.existsSync(out)) { out = path.join(dir, `${path.basename(name, ext)} (${++n})${ext}`); }
            fs.writeFileSync(out, body);
            res.json({ ok: true, name: path.basename(out), bytes: body.length });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/bank-accounts/:id/docs/:name', (req, res) => {
        const dir = accountDir(cfg, req.params.id);
        if (!dir) return res.status(404).json({ error: 'no such account' });
        const file = path.join(dir, safeName(req.params.name));
        if (!file.startsWith(dir) || !fs.existsSync(file)) return res.status(404).json({ error: 'no such document' });
        res.download(file);
    });

    app.delete('/api/bank-accounts/:id/docs/:name', (req, res) => {
        if (!admin(req, res)) return;
        const dir = accountDir(cfg, req.params.id);
        if (!dir) return res.status(404).json({ error: 'no such account' });
        const file = path.join(dir, safeName(req.params.name));
        if (!file.startsWith(dir) || !fs.existsSync(file)) return res.status(404).json({ error: 'no such document' });
        try { fs.unlinkSync(file); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
    });
}

module.exports = { mount, listDocs, safeName, ALLOWED, MAX_BYTES };
