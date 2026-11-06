// helpers/remittanceMail.js - did the customer already mail us proof of payment?
// Apsara, 2026-11-07: customers "would have shared a remittance copy or something related to payment in mail". So before
// the Follow-up Agent chases a customer, it looks in the mailbox for recent mail FROM that customer that talks about
// a payment. It only READS. A hit never marks anything paid - the sale's balance is still changed only when she records
// the receipt - it just holds the chase and tells her to look.
const FREEMAIL = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com', 'live.com', 'msn.com', 'qq.com', '163.com']);
const WORDS = ['remittance', '"payment advice"', '"proof of payment"', '"wire confirmation"', '"payment confirmation"', 'swift', '"payment sent"', '"payment has been"', '"bank slip"', '"TT copy"', '"T/T copy"', 'paid'];
const HOLD_DAYS = 7;

const addrs = (to) => String(to || '').split(/[;,]/).map((s) => (/<([^>]+)>/.exec(s) || [null, s])[1].trim().toLowerCase()).filter((s) => /^[^@\s]+@[^@\s]+$/.test(s));
function fromClause(to) {
    const parts = [];
    for (const a of addrs(to)) {
        const dom = a.split('@')[1];
        parts.push(FREEMAIL.has(dom) ? a : '@' + dom);
    }
    return [...new Set(parts)];
}
const gmailDay = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
function queryFor(draft, sinceMs) {
    const from = fromClause(draft && draft.to);
    if (!from.length) return null;
    return `from:(${from.join(' OR ')}) after:${gmailDay(sinceMs)} (${WORDS.join(' OR ')})`;
}

// finder({ list(query) -> [{id}], get(id) -> {id, subject, from, dateMs} }) -> async (draft, { sinceMs, ignoreId }) -> hit | null
function makeFinder({ list, get }) {
    return async function find(draft, { sinceMs, ignoreId } = {}) {
        const q = queryFor(draft, sinceMs);
        if (!q) return null;
        const ids = (await list(q) || []).map((m) => m.id).filter((id) => id && id !== ignoreId);
        if (!ids.length) return null;
        const m = await get(ids[0]);
        return { id: ids[0], subject: (m && m.subject) || '', from: (m && m.from) || '', dateMs: (m && m.dateMs) || Date.now() };
    };
}

// The real thing, over the read mailbox. Any failure = no hit (never blocks the agent, never invents a payment).
function liveFinder() {
    const gmail = require('./gmail');
    const client = () => gmail.getGmailRead();
    const inner = makeFinder({
        list: async (q) => gmail.listMessages(await client(), q, 5),
        get: async (id) => {
            const r = await (await client()).users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] });
            const h = (n) => ((r.data.payload.headers || []).find((x) => x.name === n) || {}).value || '';
            return { subject: h('Subject'), from: h('From'), dateMs: Number(r.data.internalDate) || Date.parse(h('Date')) || Date.now() };
        },
    });
    return async (...a) => { try { return await inner(...a); } catch (e) { console.warn('[REMIT] mail check failed:', e.message); return null; } };
}

module.exports = { makeFinder, liveFinder, queryFor, fromClause, HOLD_DAYS, WORDS };
