// ── helpers/quickbooks/routes.js — everything QuickBooks, on one page ──────
//
// Apsara, 2026-09-24: "i want to have a separate page where i can view
// everything related to qb especially these Supplier specific things…If i
// keep on creating a separate page for each supplier,then it increases
// exponentially.so find a way to keep it beautiful,clean,compact yet
// knowledgeable."
//
// So: ONE page, one party at a time, picked from a list — never a page per
// supplier. This module is the data behind it and nothing else; it is mounted
// from api.js with a single line so the 235 routes there are untouched.
//
// What it will and will not do:
//   · reads are open to anyone who can open Jarvis
//   · anything that CHANGES something needs the padlock open AND an admin
//     session, because this page can reach her live books
//   · the chat answers and explains; it never writes (her choice, 2026-09-24)
const path = require('path');

const mapping = require('./mapping');
const journal = require('./journal');
const push = require('./push');
const pushInvoice = require('./pushInvoice');
const pushPayments = require('./pushPayments');
const sync = require('./sync');
const auth = require('./auth');

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const norm = (v) => String(v || '').trim().toUpperCase();
const KEY = (v) => norm(v).replace(/[^A-Z0-9]/g, '');

// QuickBooks is slow and this page is clicked a lot. Balances change by the
// hour, not the second; five minutes is fresh enough and keeps the page snappy.
const CACHE_MS = 5 * 60 * 1000;
let qbCache = { at: 0, data: null };

async function qbParties(env) {
    if (qbCache.data && Date.now() - qbCache.at < CACHE_MS) return qbCache.data;
    const client = require('./client');
    const pull = async (t) => {
        let all = [], s = 1;
        for (;;) {
            const q = `select Id, DisplayName, Active, Balance from ${t} where Active in (true, false) startposition ${s} maxresults 1000`;
            const r = (await client.query(q, { env }))[t] || [];
            all = all.concat(r); if (r.length < 1000) break; s += 1000;
        }
        return all;
    };
    const data = { vendor: await pull('Vendor'), customer: await pull('Customer') };
    qbCache = { at: Date.now(), data };
    return data;
}

// ── the party list ─────────────────────────────────────────────────────────
// Every name Jarvis's own ledgers use, with what it owes/is owed and what
// QuickBooks thinks, side by side. The disagreement is the point of the page.
function jarvisParties() {
    const bills = require('../bills');
    const sales = require('../sales');
    const billPayments = require('../billPayments');
    const out = {};
    const touch = (kind, name) => {
        if (!String(name || '').trim()) return null;
        const k = kind + '|' + KEY(name);
        return (out[k] = out[k] || { kind, name: String(name).trim(), bills: 0, billsValue: 0, invoices: 0, invoicesValue: 0,
            advances: 0, advancesValue: 0, lastActivity: null, linked: 0 });
    };
    const seen = (p, date) => { const d = push.isoDate(date); if (d && (!p.lastActivity || d > p.lastActivity)) p.lastActivity = d; };
    for (const b of bills.list()) {
        const p = touch('vendor', b.supplier); if (!p) continue;
        p.bills++; p.billsValue = r2(p.billsValue + (Number(bills.withTotals(b).amount) || 0)); seen(p, b.date);
    }
    for (const s of sales.list()) {
        const p = touch('customer', s.customer); if (!p) continue;
        p.invoices++; p.invoicesValue = r2(p.invoicesValue + (Number(sales.withTotals(s).receivable ?? sales.withTotals(s).amount) || 0)); seen(p, s.date);
    }
    for (const a of billPayments.list()) {
        if (a.kind !== 'advance') continue;
        const p = touch('vendor', a.supplier); if (!p) continue;
        p.advances++; p.advancesValue = r2(p.advancesValue + (Number(a.amount) || 0)); seen(p, a.date);
    }
    return Object.values(out);
}

// ── ONE READING OF A MAPPING, FOR THE WHOLE PAGE (2026-09-26) ──────────────
// Apsara, 2026-09-26: "i have matched the supplier name just now ... yet it
// shows no match in qb." It was matched. The page could not read it.
//
// matchParty() answers with the QuickBooks record under `qb: { Id,
// DisplayName }`. Two places here read `m.qbId` and `m.qbName` instead, which
// are undefined on that object — so the party header said "no QuickBooks match
// yet" for EVERY party no matter what she confirmed, and the balance beside it
// (looked up by that undefined id) always read "—". The party list was right
// the whole time because it reads the stored map directly. One reader now, so
// the two halves of the screen cannot disagree again.
function readMapping(kind, name, qbList = []) {
    const hit = mapping.matchParty(name, qbList, kind);
    if (!hit) return { qbId: null, qbName: null, status: 'none' };
    if (hit.status === 'confirmed' || hit.status === 'exact') {
        return { qbId: hit.qb ? String(hit.qb.Id) : null, qbName: hit.qb ? hit.qb.DisplayName : null, status: hit.status };
    }
    // 'skip' = she said this is not a party in this role; 'new' = not in
    // QuickBooks at all. Both are answers, not gaps, and the page says so.
    return { qbId: hit.status === 'skip' ? 'SKIP' : null, qbName: null, status: hit.status, note: hit.note || null,
        candidates: hit.candidates || [] };
}

function mappedTo(kind, name, map) {
    const m = (map[kind] || {})[KEY(name).toLowerCase()] || null;
    if (m) return m;
    // mapping.js normalises its own way; ask it properly rather than guess
    const hit = readMapping(kind, name);
    return hit.qbId ? { qbId: hit.qbId, qbName: hit.qbName } : null;
}

async function partyRows({ env, withQb = true }) {
    const map = mapping.loadMap();
    const rows = jarvisParties();
    let qb = null;
    if (withQb) { try { qb = await qbParties(env); } catch { qb = null; } }
    const links = push.loadLinks();
    const linkedIds = new Set(Object.keys(links));
    for (const p of rows) {
        const m = mappedTo(p.kind, p.name, map);
        p.qbId = m ? m.qbId : null;
        p.qbName = m ? m.qbName : null;
        p.mapped = !!(m && m.qbId && m.qbId !== 'SKIP');
        p.skipped = !!(m && m.qbId === 'SKIP');
        if (qb) {
            const list = p.kind === 'vendor' ? qb.vendor : qb.customer;
            const found = p.qbId ? list.find((x) => String(x.Id) === String(p.qbId)) : null;
            p.qbBalance = found ? r2(found.Balance) : null;
            p.qbActive = found ? found.Active !== false : null;
        }
        p.inQuickBooks = [...linkedIds].filter((k) => k.includes(`|${p.kind === 'vendor' ? 'bill' : 'invoice'}|`)).length ? undefined : undefined;
    }
    return rows.sort((a, b) => (b.billsValue + b.invoicesValue) - (a.billsValue + a.invoicesValue));
}

// ── one party, everything about it ─────────────────────────────────────────
function partyDetail(kind, name, env) {
    const bills = require('../bills');
    const sales = require('../sales');
    const billPayments = require('../billPayments');
    const links = push.loadLinks();
    const linkOf = (k, id) => links[push.linkKey(env, k, id)] || null;
    const same = (a) => KEY(a) === KEY(name);

    const rows = { bills: [], invoices: [], advances: [], journal: [] };
    if (kind === 'vendor') {
        for (const b of bills.list().filter((x) => same(x.supplier))) {
            const t = bills.withTotals(b);
            const l = linkOf('bill', b.id);
            rows.bills.push({ id: b.id, date: push.isoDate(b.date) || b.date, container: b.container_no || '', no: b.invoice_no || '',
                amount: r2(t.amount), items: (b.items || []).length || 1, qbId: l ? l.qbId : null,
                note: b.note || '', blocked: !l && !(Number(t.amount) > 0) ? 'no supplier price yet' : null });
        }
        for (const a of billPayments.list().filter((x) => same(x.supplier))) {
            const l = linkOf(a.kind === 'advance' && !(a.allocations || []).some((x) => x.amount > 0) ? 'prepayment' : 'billpayment', a.id);
            rows.advances.push({ id: a.id, date: push.isoDate(a.date) || a.date, amount: r2(a.amount), mode: a.mode, bank: a.bank,
                kind: a.kind, applied: r2((a.allocations || []).reduce((s, x) => s + (Number(x.amount) || 0), 0)), qbId: l ? l.qbId : null });
        }
    } else {
        const byNo = {};
        for (const s of sales.list().filter((x) => same(x.customer))) {
            const no = push.docNumberFor(s) || `(no number) ${s.id}`;
            (byNo[no] = byNo[no] || []).push(s);
        }
        for (const [no, group] of Object.entries(byNo)) {
            const first = group[0];
            const l = linkOf('invoice', first.id) || group.map((g) => linkOf('invoice', g.id)).find(Boolean);
            const total = r2(group.reduce((s, g) => s + (Number(sales.withTotals(g).receivable ?? sales.withTotals(g).amount) || 0), 0));
            rows.invoices.push({ id: first.id, date: push.isoDate(first.date) || first.date, container: first.container_no || '',
                no: no.startsWith('(no number)') ? '' : no, amount: total, items: group.length, qbId: l ? l.qbId : null,
                blocked: no.startsWith('(no number)') ? 'no invoice number yet' : null });
        }
    }
    const ids = new Set([...rows.bills, ...rows.invoices, ...rows.advances].map((x) => x.id));
    rows.journal = journal.list({ env }).filter((e) => e.jarvis && (ids.has(e.jarvis.id)
        || KEY(e.jarvis.supplier || e.jarvis.customer || '') === KEY(name)))
        .slice(-60).reverse();
    const sum = (a, f) => r2(a.reduce((s, x) => s + (Number(x[f]) || 0), 0));
    const billTotal = sum(rows.bills, 'amount');
    const advanceTotal = sum(rows.advances.filter((a) => a.kind === 'advance'), 'amount');
    rows.totals = {
        bills: billTotal, invoices: sum(rows.invoices, 'amount'),
        advances: advanceTotal,
        advancesUnapplied: r2(rows.advances.filter((a) => a.kind === 'advance').reduce((s, a) => s + (a.amount - a.applied), 0)),
        // ── WHO IS AHEAD ─────────────────────────────────────────────────
        // Bills and advances read side by side invite the wrong answer: on
        // 2026-09-24 the chat told her she owed Hugo $144,792.91 while he was
        // holding $806,619.75 of her money. One number, with its sign.
        owedToSupplier: kind === 'vendor' ? r2(billTotal - advanceTotal) : null,
        // A bill with no amount is a container whose price is not agreed yet.
        // It is NOT zero cost, and a total that silently includes it as zero
        // is a lie of omission — so it is counted separately and said aloud.
        unpricedBills: rows.bills.filter((b) => !(Number(b.amount) > 0)).length,
        inQuickBooks: [...rows.bills, ...rows.invoices, ...rows.advances].filter((x) => x.qbId).length,
        notInQuickBooks: [...rows.bills, ...rows.invoices, ...rows.advances].filter((x) => !x.qbId).length,
    };
    return rows;
}


// ── the routes ─────────────────────────────────────────────────────────────
// Mounted from api.js with one line. Reads are open; every mutation needs the
// padlock open (`unlock: true`) AND an admin session — two deliberate acts,
// because a mis-click here lands in her live books.
function mount(app, cfg) {
    const envOf = () => auth.qbEnv();
    const locked = (req, res) => {
        if (req.role !== 'admin') { res.status(403).json({ error: 'changing QuickBooks needs an admin session' }); return true; }
        if (!(req.body && req.body.unlock === true)) { res.status(400).json({ error: 'the page is locked — open the padlock first' }); return true; }
        return false;
    };

    app.get('/quickbooks', (req, res) => res.sendFile(path.join(cfg.ROOT, 'dashboard', 'quickbooks.html')));

    app.get('/api/qb/status', async (req, res) => {
        const env = envOf();
        const map = mapping.loadMap();
        // Same misreading as the party header had: these chips said "unmapped"
        // for accounts that were mapped, because matchParty answers under
        // `qb`, not `qbId`.
        const roles = ['prepayment', 'bank charges', 'trucking'].map((role) => {
            const m = readMapping('account', role);
            return { role, qbId: m.qbId, qbName: m.qbName };
        });
        const j = journal.list({ env });
        res.json({
            env,
            writes: String(process.env.QB_PROD_WRITES || 'off').toLowerCase() === 'on',
            autoSync: String(process.env.QB_SYNC || 'off').toLowerCase() === 'on',
            cutover: { bills: push.cutoverFor('bill', env), invoices: push.cutoverFor('invoice', env),
                billsFrom: push.cutoverSource('bill'), invoicesFrom: push.cutoverSource('invoice'),
                history: (push.cutoverStore().history || []).slice(0, 5) },
            nightly: { at: '00:00 Los Angeles', writes: require('../quickbooksNightly').enabled() },
            connected: auth.status(env).connected,
            roles,
            counts: { mapped: Object.keys(map.vendor || {}).length + Object.keys(map.customer || {}).length,
                items: Object.keys(map.item || {}).length, journal: j.length, standing: journal.active(env).length },
            lastWrites: j.filter((e) => e.action === 'created').slice(-8).reverse()
                .map((e) => ({ at: e.at, kind: e.kind, qbId: e.qb && e.qb.id, total: e.qb && e.qb.total,
                    who: (e.jarvis && (e.jarvis.supplier || e.jarvis.customer)) || '', container: e.jarvis && e.jarvis.container })),
        });
    });

    app.get('/api/qb/parties', async (req, res) => {
        try {
            const rows = await partyRows({ env: envOf(), withQb: String(req.query.qb || '1') !== '0' });
            const q = KEY(req.query.q || '');
            res.json({ parties: q ? rows.filter((p) => KEY(p.name).includes(q) || KEY(p.qbName || '').includes(q)) : rows });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/qb/party', async (req, res) => {
        const kind = req.query.kind === 'customer' ? 'customer' : 'vendor';
        const name = String(req.query.name || '').trim();
        if (!name) return res.status(400).json({ error: 'which party?' });
        try {
            const env = envOf();
            const detail = partyDetail(kind, name, env);
            let qbBalance = null, list = [];
            try {
                const qb = await qbParties(env);
                list = (kind === 'vendor' ? qb.vendor : qb.customer) || [];
            } catch { /* QuickBooks unreachable — the Jarvis side still shows */ }
            // The live list goes in, so a vendor she renamed in QuickBooks to
            // match Jarvis's spelling reads as matched here too, not just at
            // push time.
            const m = readMapping(kind, name, list);
            if (m.qbId && m.qbId !== 'SKIP') {
                const found = list.find((x) => String(x.Id) === String(m.qbId));
                qbBalance = found ? r2(found.Balance) : null;
            }
            res.json({ kind, name, mapping: { qbId: m.qbId || null, qbName: m.qbName || null, status: m.status, note: m.note || null }, qbBalance, ...detail });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // unmapped names, so she can answer them from here instead of the terminal
    app.get('/api/qb/candidates', async (req, res) => {
        const kind = req.query.kind === 'customer' ? 'customer' : 'vendor';
        try {
            const client = require('./client');
            const all = await mapping.fetchParties(kind, client, { env: envOf() });
            const m = mapping.matchParty(String(req.query.name || ''), all, kind);
            // An EXACT hit comes back under `qb` with candidates empty — so
            // the easiest case of all showed "(no near matches)" in the match
            // dialog (2026-09-25, FMC METALS, which exists verbatim as #561).
            // Put it at the head of the list, marked, so one keystroke does it.
            const exact = m.qb ? [{ Id: m.qb.Id || m.qb.qbId, DisplayName: m.qb.DisplayName || m.qb.name || m.qb.qbName, exact: true }] : [];
            const rest = (m.candidates || []).filter((c) => !exact.length || String(c.Id) !== String(exact[0].Id));
            res.json({ status: m.status, candidates: exact.concat(rest.slice(0, 8)),
                all: all.map((x) => ({ Id: x.Id, name: x.DisplayName })).slice(0, 2000) });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/qb/map', async (req, res) => {
        if (locked(req, res)) return;
        const { kind, jarvisName, qbId, qbName, reason } = req.body || {};
        if (!['vendor', 'customer', 'item', 'bank', 'account'].includes(kind)) return res.status(400).json({ error: 'kind?' });
        if (!jarvisName) return res.status(400).json({ error: 'which Jarvis name?' });
        try {
            const saved = mapping.confirm(kind, jarvisName, qbId === 'SKIP' ? 'SKIP' : (qbId || null), qbName || null, 'apsara', reason || 'set from the QuickBooks page');
            qbCache = { at: 0, data: null };
            res.json({ ok: true, saved, note: 'saved in qb-settings — commit it so the other machine has it too' });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // push ONE record. Same checks as every other write: mapping, duplicate
    // search, same-money, journal. Never a bulk button — that is what the
    // sweep is for, from a terminal, with a dry run first.
    app.post('/api/qb/push', async (req, res) => {
        if (locked(req, res)) return;
        const { kind, id, dryRun } = req.body || {};
        if (!['bill', 'invoice', 'advance'].includes(kind)) return res.status(400).json({ error: 'kind must be bill, invoice or advance' });
        if (!id) return res.status(400).json({ error: 'which record?' });
        const env = envOf();
        try {
            if (dryRun) {
                const snaps = await sync.snapshots(env);
                if (kind === 'bill') {
                    const bills = require('../bills'); const b = bills.list().find((x) => x.id === id);
                    if (!b) return res.status(404).json({ error: 'no such bill' });
                    return res.json(await push.pushBill(bills.withTotals(b), snaps, { env, dryRun: true }));
                }
                if (kind === 'invoice') {
                    const sales = require('../sales'); const s = sales.getSale(id);
                    if (!s) return res.status(404).json({ error: 'no such sale' });
                    const no = push.docNumberFor(s);
                    const group = sales.list().filter((x) => push.docNumberFor(x) === no).map((x) => sales.withTotals(x));
                    return res.json(await pushInvoice.pushInvoice(group, snaps, { env, dryRun: true }));
                }
                const p = require('../billPayments').list().find((x) => x.id === id);
                if (!p) return res.status(404).json({ error: 'no such payment' });
                return res.json(await pushPayments.pushBillPayment(p, snaps, { env, dryRun: true }));
            }
            const out = kind === 'bill' ? await sync.syncBill(id, env)
                : kind === 'invoice' ? await sync.syncSale(id, env)
                : await sync.syncBillPayment(id, env);
            res.json(out);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── the cutover ────────────────────────────────────────────────────────
    // Apsara, 2026-09-26: "I want nightly report to run everyday to upload all
    // the bills and invoices." The nightly run only ever touches rows dated on
    // or after this boundary, so the boundary is the setting that decides what
    // "all" means — and it belongs here, not in an SSH session. .env wins
    // where it is set, and this says so rather than pretending to have saved.
    app.post('/api/qb/cutover', async (req, res) => {
        if (locked(req, res)) return;
        const { bills, invoices } = req.body || {};
        if (!bills && !invoices) return res.status(400).json({ error: 'give a bills date, an invoices date, or both' });
        try {
            const { changed } = push.saveCutover({ bills, invoices }, req.isSuper ? 'super admin' : (req.role || 'admin'));
            const env = envOf();
            const pinned = ['bill', 'invoice'].filter((k) => push.cutoverSource(k) === 'env');
            res.json({ ok: true, changed,
                cutover: { bills: push.cutoverFor('bill', env), invoices: push.cutoverFor('invoice', env),
                    billsFrom: push.cutoverSource('bill'), invoicesFrom: push.cutoverSource('invoice') },
                note: pinned.length
                    ? `saved, but ${pinned.map((k) => k === 'bill' ? 'QB_CUTOVER_BILLS' : 'QB_CUTOVER_INVOICES').join(' and ')} in .env still wins — remove that line and restart for this to take effect`
                    : 'saved — the next run uses it, no restart needed' });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // The nightly run, on demand. Same sweep, same checks, same journal — the
    // only difference is who started it. Dry run by default: nothing reaches
    // her books unless the body says dryRun: false.
    app.post('/api/qb/run', async (req, res) => {
        if (locked(req, res)) return;
        const job = require('../quickbooksNightly');
        const dryRun = (req.body || {}).dryRun !== false || !job.enabled();
        try {
            const out = await job.run({ dryRun });
            res.json({ ok: out.ok, dryRun: out.dryRun, error: out.error,
                summary: job.summarise(out.result || {}), report: job.reportText(out) });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/qb/undo', async (req, res) => {
        if (locked(req, res)) return;
        const { journalId, reason, dryRun } = req.body || {};
        if (!journalId) return res.status(400).json({ error: 'which journal entry?' });
        if (!reason || String(reason).trim().length < 4) return res.status(400).json({ error: 'an undo needs a reason — it goes in the journal' });
        try {
            res.json(await journal.undo(journalId, { env: envOf(), dryRun: dryRun !== false, reason: String(reason).trim() }));
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ── Ask Jarvis ─────────────────────────────────────────────────────────
    // Answers and explains; it does not write (her choice). It is handed the
    // real numbers for the party on screen, so it never has to invent one,
    // and it always comes back with one follow-up question.
    app.post('/api/qb/ask', async (req, res) => {
        const { question, kind, name } = req.body || {};
        if (!String(question || '').trim()) return res.status(400).json({ error: 'ask something' });
        const env = envOf();
        let context = {};
        try {
            if (name) {
                const d = partyDetail(kind === 'customer' ? 'customer' : 'vendor', name, env);
                const m = mapping.matchParty(name, [], kind === 'customer' ? 'customer' : 'vendor');
                let qbBalance = null;
                try { const qb = await qbParties(env); const f = (kind === 'customer' ? qb.customer : qb.vendor).find((x) => String(x.Id) === String(m.qbId)); qbBalance = f ? r2(f.Balance) : null; } catch {}
                context = { party: name, kind, mappedTo: m.qbName || null, qbBalance, totals: d.totals,
                    bills: d.bills.slice(-25), invoices: d.invoices.slice(-25), advances: d.advances.slice(-25),
                    recentJarvisWrites: d.journal.slice(0, 10).map((e) => ({ at: e.at, action: e.action, kind: e.kind, qbId: e.qb && e.qb.id, reason: e.reason })) };
            } else {
                context = { overview: (await partyRows({ env, withQb: false })).slice(0, 40) };
            }
        } catch (e) { context = { error: e.message }; }

        const prompt = [
            'You are Jarvis, answering Apsara about her QuickBooks bookkeeping inside her own app.',
            'Answer ONLY from the DATA below. If the data does not cover it, say exactly what is missing.',
            'She writes fast and loosely — work out what she means; never ask her to rephrase.',
            'Money: always give the figure and what it is (an advance, an open bill, a Jarvis row not yet in QuickBooks).',
            'Be short: three sentences at most, plain words, no jargon, no bullet lists.',
            'You cannot change anything — if an action is needed, name the button on the page.',
            'For a SUPPLIER, never read out bills and advances as two separate piles: totals.owedToSupplier is',
            'the one number that matters — positive means she owes him that much, negative means he is holding',
            'that much of her money. Say which way round it is, in those words.',
            'If totals.unpricedBills is above zero, say so: those containers have no agreed price yet, so the',
            'bill total is lower than the real position and no figure here is final until they are priced.',
            'Return JSON: {"answer": "...", "followUp": "one short question that moves this forward"}',
            'The followUp is never optional and never generic — it must be about THIS party or THIS number.',
            '',
            'QUESTION: ' + String(question).trim(),
            'DATA: ' + JSON.stringify(context).slice(0, 12000),
        ].join('\n');

        try {
            const gemini = require('../gemini');
            const out = await gemini.callGeminiJSON(prompt, 1);
            if (out && out.answer) return res.json({ answer: String(out.answer), followUp: String(out.followUp || 'What would you like to check next on this account?'), context: !!name });
            throw new Error('no answer');
        } catch (e) {
            // Jarvis without the model still answers from the numbers.
            const t = context.totals;
            const who = t && t.owedToSupplier !== null && t.owedToSupplier !== undefined
                ? (t.owedToSupplier > 0 ? `you owe ${name} $${t.owedToSupplier}` : `${name} is holding $${r2(-t.owedToSupplier)} of your money`)
                : null;
            const plain = t
                ? `${name}: ${who ? who + '. ' : ''}$${t.bills} of bills against $${t.advances} advanced${t.unpricedBills ? `, and ${t.unpricedBills} container${t.unpricedBills > 1 ? 's have' : ' has'} no price yet` : ''}. ${t.inQuickBooks} records are in QuickBooks, ${t.notInQuickBooks} are not.`
                : 'I can see the ledgers but the language model is not answering right now.';
            res.json({ answer: plain, followUp: name ? `Do you want the bills for ${name}, or the wires?` : 'Which supplier or customer shall I open?', degraded: true });
        }
    });
}

module.exports = { mount, partyRows, partyDetail, jarvisParties, qbParties, r2, KEY };
