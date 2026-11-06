// helpers/invoiceThread.js - which email thread did we send this customer's invoice in?
// Apsara, 2026-11-07: "Make sure it asks in the same email thread as we sent the invoice." A payment follow-up to a
// customer must be a REPLY inside the thread the invoice went out in, not a fresh email they have to connect to it.
// Looks in two places: (1) mail Jarvis itself sent and tracked (helpers/emailThreads, `refs` recorded from now on);
// (2) the sent folder of the sending account, searched for the invoice / container number, which also finds invoices
// she sent by hand or before this existed. READ-ONLY. No thread found = null, and the caller sends a new email, saying so.
const DAY = 86400000;

const norm = (x) => String(x || '').trim().toLowerCase();
const refsOf = (draft) => [...(draft.lines || [])]
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))        // oldest unpaid invoice first
    .flatMap((l) => [l.invoice_no, l.container_no]).map((x) => String(x || '').trim()).filter((x) => x.length >= 4);

const reSubject = (s) => { const t = String(s || '').trim() || 'Invoice'; return /^re:/i.test(t) ? t : 'Re: ' + t; };

// tracked: emailThreads entries; list(q) -> [{id, threadId}]; get(id) -> { messageId, subject, dateMs }
function makeFinder({ tracked, list, get }) {
    return async function find(draft) {
        const to = norm(draft && draft.to); if (!to) return null;
        const refs = refsOf(draft); if (!refs.length) return null;
        // (1) what Jarvis sent itself and recorded
        for (const ref of refs) {
            const hit = (tracked ? tracked() : []).filter((t) => norm(t.to) === to && t.thread_id && (t.refs || []).some((r) => norm(r) === norm(ref)))
                .sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)))[0];
            if (hit && hit.message_id) return { threadId: hit.thread_id, messageId: hit.message_id, subject: reSubject(hit.subject), ref, source: 'tracked' };
        }
        // (2) the sent folder
        if (!list || !get) return null;
        for (const ref of refs) {
            const msgs = await list(`in:sent to:${to} "${ref.replace(/"/g, '')}"`);
            if (!msgs || !msgs.length) continue;
            const m = await get(msgs[0].id); if (!m || !m.messageId) continue;
            return { threadId: msgs[0].threadId || m.threadId, messageId: m.messageId, subject: reSubject(m.subject), ref, dateMs: m.dateMs || null, source: 'sent' };
        }
        return null;
    };
}

// The real thing. Any failure = null (a new email is sent instead and the preview says so).
function liveFinder() {
    const gmail = require('./gmail');
    const client = () => (typeof gmail.getGmailSenderRead === 'function' && gmail.getGmailSenderRead()) || null;
    const inner = makeFinder({
        tracked: () => { try { return require('./emailThreads').loadEmailThreads(); } catch (e) { return []; } },
        list: async (q) => { const c = client(); if (!c) return []; const r = await c.users.messages.list({ userId: 'me', q, maxResults: 3 }); return r.data.messages || []; },
        get: async (id) => {
            const r = await client().users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['Message-ID', 'Message-Id', 'Subject', 'Date'] });
            const h = (n) => ((r.data.payload.headers || []).find((x) => x.name.toLowerCase() === n.toLowerCase()) || {}).value || '';
            return { messageId: h('Message-ID'), subject: h('Subject'), threadId: r.data.threadId, dateMs: Number(r.data.internalDate) || null };
        },
    });
    return async (draft) => { try { return await inner(draft); } catch (e) { console.warn('[INVOICE-THREAD] lookup failed:', e.message); return null; } };
}

module.exports = { makeFinder, liveFinder, refsOf, reSubject };
