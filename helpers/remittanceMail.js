// helpers/remittanceMail.js - did the customer already mail us proof of payment?
// Apsara, 2026-11-07: customers "would have shared a remittance copy or something related to payment in mail". So before
// the Follow-up Agent chases a customer, it looks in the mailbox for recent mail FROM that customer that talks about
// a payment. It only READS. A hit never marks anything paid - the sale's balance is still changed only when she records
// the receipt - it just holds the chase and tells her to look.
const FREEMAIL = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com', 'live.com', 'msn.com', 'qq.com', '163.com']);
const HOLD_DAYS = 7;
const MAX_MAIL = 6;               // newest mails from the customer that get read per check

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
// NO keyword list (Apsara, 2026-11-07: "dont just restrict to this" / "let AI handle it"). Every mail FROM the customer since
// the first note is a candidate; the model reads each and decides whether it is about payment.
function queryFor(draft, sinceMs) {
    const from = fromClause(draft && draft.to);
    if (!from.length) return null;
    return `from:(${from.join(' OR ')}) after:${gmailDay(sinceMs)}`;
}

function promptFor(draft, mail) {
    const inv = (draft.lines || []).map((l) => [l.invoice_no, l.container_no, l.booking_no].filter(Boolean).join(' / ')).filter(Boolean).join('; ');
    return `You help a metals exporter (Edge Metals) who is waiting for ${draft.customer} to pay ${draft.count || ''} open invoice(s): ${inv || 'no references'}.
Below is an email that ${draft.customer} sent to Edge Metals. Decide whether it is about PAYMENT of those invoices in ANY way: proof or copy of a payment (wire, TT, SWIFT, bank slip, remittance advice), a statement that they paid or have scheduled/released payment, a payment date or promise, a payment problem or dispute, or a question about what they owe. Judge by the meaning, in any language and wording. Not payment: shipping, documents, quality or other business with no bearing on paying.
Subject: ${mail.subject || ''}
Attachments: ${(mail.files || []).join(', ') || 'none'}
Text: ${String(mail.snippet || '').slice(0, 1500)}
Return ONLY JSON: {"payment_related": true|false, "why": "<=12 words"}`;
}

// Used when the model cannot be reached: lean toward telling her. A needless "check this" is cheap; a chase after they paid is not.
function fallbackJudge(draft, mail) {
    const hay = `${mail.subject || ''} ${mail.snippet || ''} ${(mail.files || []).join(' ')}`.toLowerCase();
    const refs = (draft.lines || []).flatMap((l) => [l.invoice_no, l.container_no, l.booking_no]).filter(Boolean).map((x) => String(x).toLowerCase());
    return refs.some((r) => hay.includes(r)) || /remit|payment|paid|wire|swift|\btt\b|t\/t|transfer|bank|slip|advice/.test(hay) || (mail.files || []).length > 0;
}

// list(query) -> [{id}], get(id) -> { subject, from, dateMs, snippet, files[] }, classify(prompt) -> {payment_related} | null
function makeFinder({ list, get, classify }) {
    return async function find(draft, { sinceMs, ignoreId } = {}) {
        const q = queryFor(draft, sinceMs);
        if (!q) return null;
        const ids = (await list(q) || []).map((m) => m.id).filter((id) => id && id !== ignoreId).slice(0, MAX_MAIL);
        for (const id of ids) {
            const m = await get(id); if (!m) continue;
            let verdict = null;
            if (typeof classify === 'function') { try { verdict = await classify(promptFor(draft, m)); } catch (e) { verdict = null; } }
            const yes = verdict && typeof verdict.payment_related !== 'undefined'
                ? (verdict.payment_related === true || verdict.payment_related === 'true')
                : fallbackJudge(draft, m);
            if (yes) return { id, subject: m.subject || '', from: m.from || '', dateMs: m.dateMs || Date.now(), why: (verdict && verdict.why) || null };
        }
        return null;
    };
}

// The real thing, over the read mailbox. Any failure = no hit (never blocks the agent, never invents a payment).
function liveFinder() {
    const gmail = require('./gmail');
    const client = () => gmail.getGmailRead();
    const files = (part, out = []) => { if (!part) return out; if (part.filename) out.push(part.filename); (part.parts || []).forEach((p) => files(p, out)); return out; };
    const inner = makeFinder({
        list: async (q) => gmail.listMessages(await client(), q, MAX_MAIL),
        get: async (id) => {
            const r = await (await client()).users.messages.get({ userId: 'me', id, format: 'full' });
            const h = (n) => ((r.data.payload.headers || []).find((x) => x.name === n) || {}).value || '';
            return { subject: h('Subject'), from: h('From'), dateMs: Number(r.data.internalDate) || Date.parse(h('Date')) || Date.now(), snippet: r.data.snippet || '', files: files(r.data.payload) };
        },
        classify: async (prompt) => require('./gemini').callGeminiJSON(prompt, 1),
    });
    return async (...a) => { try { return await inner(...a); } catch (e) { console.warn('[REMIT] mail check failed:', e.message); return null; } };
}

module.exports = { makeFinder, liveFinder, queryFor, fromClause, promptFor, fallbackJudge, HOLD_DAYS, MAX_MAIL };
