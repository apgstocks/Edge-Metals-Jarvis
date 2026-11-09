// helpers/ownerReport.js — the one weekly message: cash in, who is late, what I did, what I need from you.
// docs/OWNERSHIP-PLAN.md section 6, step 6. READ-ONLY: it reads existing stores and changes nothing.
// Edge METALS only: the receipts, sales and follow-up stores it reads are Edge Metals'. Edge Yard (Scout) is never read.
//
// Every line is computed from data, never written by an AI. A line with nothing to say is left out,
// and when a source cannot be read the report says so instead of showing a calm zero.
// Inputs are injectable so it can be tested; by default it reads the real stores.
'use strict';

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const money = (n) => '$' + round2(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const day = (s) => String(s || '').slice(0, 10);

function defaults() {
    const guard = (fn) => { try { return fn(); } catch (e) { return { __error: e.message }; } };
    return {
        receipts: () => guard(() => require('./salesReceipts').list()),
        followups: (now) => guard(() => require('./paymentFollowups').build({ now })),
        outcomes: () => guard(() => require('./outcomes').readAll()),
        builds: () => guard(() => require('./selfBuild').list({ repo: require('path').join(__dirname, '..'), dataDir: require('../config').DATA_DIR })),
        told: () => guard(() => require('./inboundLog').readAll()),
    };
}
const bad = (x) => x && typeof x === 'object' && !Array.isArray(x) && x.__error;

// build() returns plain numbers and lists; text() turns them into the message.
function build({ now = Date.now(), days = 7, src = {} } = {}) {
    // Every source is guarded, injected or not: one that throws becomes a named problem, never a crashed report.
    const raw = Object.assign(defaults(), src);
    const d = {};
    for (const k of Object.keys(raw)) d[k] = (...a) => { try { return raw[k](...a); } catch (e) { return { __error: e.message }; } };
    const since = new Date(now - days * 864e5).toISOString();
    const cutDay = day(since);
    const r = { days, since: cutDay, problems: [] };

    const receipts = d.receipts();
    if (bad(receipts) || !Array.isArray(receipts)) { r.problems.push('receipts'); r.cash = null; }
    else {
        const week = receipts.filter((x) => x && day(x.date) >= cutDay && Number(x.amount) > 0);
        const by = {};
        for (const x of week) by[x.customer] = round2((by[x.customer] || 0) + Number(x.amount));
        r.cash = { total: round2(week.reduce((t, x) => t + Number(x.amount), 0)), count: week.length,
            top: Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([customer, total]) => ({ customer, total })) };
    }

    const f = d.followups(now);
    if (bad(f) || !f || !Array.isArray(f.drafts)) { r.problems.push('follow-ups'); r.open = null; r.needs = null; }
    else {
        r.open = { invoices: f.open_invoices, total: f.total_outstanding,
            top: f.drafts.slice(0, 3).map((x) => ({ customer: x.customer, total: x.total })) };
        r.needs = {
            noAddress: f.drafts.filter((x) => x.to_missing).map((x) => x.customer),
            noTerms: f.drafts.filter((x) => x.kind === 'remittance').map((x) => x.customer),
            waitingEta: Array.isArray(f.waiting_eta) ? f.waiting_eta.length : 0,
        };
    }

    const oc = d.outcomes();
    if (bad(oc) || !Array.isArray(oc)) { r.problems.push('outcomes'); r.did = null; }
    else {
        const wk = oc.filter((x) => x && x.kind === 'outcome' && String(x.at || '') >= since);
        const n = (k) => wk.filter((x) => x.outcome === k).length;
        r.did = { approved: n('approved'), declined: n('declined'), corrected: n('corrected'), ignored: n('ignored') };
    }
    const bl = d.builds();
    r.builds = Array.isArray(bl) ? { merged: bl.filter((b) => b.state === 'merged' && String(b.at || '') >= since).length,
        waiting: bl.filter((b) => b.state === 'ready').length } : null;
    const told = d.told();
    r.told = Array.isArray(told) ? told.filter((x) => String(x.at || '') >= since).length : null;
    return r;
}

const names = (a, n = 4) => a.slice(0, n).join(', ') + (a.length > n ? ` and ${a.length - n} more` : '');

function text(r) {
    const L = [`Weekly report (last ${r.days} days)`];
    if (r.cash) L.push(r.cash.count ? `Cash in: ${money(r.cash.total)} from ${r.cash.count} payment${r.cash.count === 1 ? '' : 's'}${r.cash.top.length ? ' (' + r.cash.top.map((x) => `${x.customer} ${money(x.total)}`).join(', ') + ')' : ''}.` : 'Cash in: no payments recorded this week.');
    if (r.open) L.push(`Still open: ${money(r.open.total)} on ${r.open.invoices} invoice${r.open.invoices === 1 ? '' : 's'}${r.open.top.length ? '. Biggest: ' + r.open.top.map((x) => `${x.customer} ${money(x.total)}`).join(', ') : ''}.`);
    const did = [];
    if (r.did) { if (r.did.approved) did.push(`${r.did.approved} approved by you`); if (r.did.declined) did.push(`${r.did.declined} declined`); if (r.did.corrected) did.push(`${r.did.corrected} corrected`); if (r.did.ignored) did.push(`${r.did.ignored} ignored`); }
    if (r.builds && r.builds.merged) did.push(`${r.builds.merged} code change${r.builds.merged === 1 ? '' : 's'} merged`);
    if (did.length) L.push('What I did: ' + did.join(', ') + '.');
    if (r.told) L.push(`Heard from you: ${r.told} message${r.told === 1 ? '' : 's'}, all kept.`);
    const need = [];
    if (r.needs) {
        if (r.needs.noAddress.length) need.push(`no email address on file for ${names(r.needs.noAddress)}`);
        if (r.needs.noTerms.length) need.push(`I don't know the payment terms for ${names(r.needs.noTerms)}`);
        if (r.needs.waitingEta) need.push(`${r.needs.waitingEta} customer${r.needs.waitingEta === 1 ? ' is' : 's are'} waiting for their ETA terms to start`);
    }
    if (r.builds && r.builds.waiting) need.push(`${r.builds.waiting} code change${r.builds.waiting === 1 ? '' : 's'} ready for your yes`);
    if (need.length) L.push('Needs you: ' + need.join('; ') + '.');
    if (r.problems.length) L.push(`Could not read: ${r.problems.join(', ')}. Those lines are missing, not zero.`);
    return L.join('\n');
}

module.exports = { build, text };
