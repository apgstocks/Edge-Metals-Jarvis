// ── helpers/claims/readMail.js — "Jarvis missed the mail, make it read it" ───
// Apsara, 2026-10-14: "Say jarvis missed the mail. Now how can i force it to
// read a mail". The watcher only sees a mail once, through two filters (the
// gate, and the processed list). When either one gets it wrong, the mail is
// lost to the claims page. This is the manual door: she searches her mailboxes,
// picks the mail, and it goes through exactly the same reader — with the gate
// and the processed list stepped over, and nothing else.
//
// Two steps on purpose (search, then read): the thing being forced is a model
// reading one mail and writing to the claims register, so she sees WHICH mail
// before it happens. The model still decides whether it is a claim; forcing
// does not make a non-claim into one.
const gmailLib = require('../gmail');
const claimWatch = require('../../workflow/claimWatch');

const hdr = (msg, name) => {
    const h = ((msg && msg.payload && msg.payload.headers) || []).find((x) => (x.name || '').toLowerCase() === name.toLowerCase());
    return h ? h.value : '';
};

// Gmail search words only: no operators from the browser are trusted beyond
// what Gmail itself does with them, and the search is read-only.
async function search(text, { max = 8 } = {}) {
    const q = String(text || '').trim().slice(0, 200);
    if (q.length < 3) throw new Error('type a container number, a subject or a sender — at least 3 characters');
    const boxes = await gmailLib.getGmailReadMailboxes();
    if (!boxes.length) throw new Error('no mailbox is connected for reading on this server');
    const done = claimWatch.processed();
    const out = [];
    for (const b of boxes) {
        let refs = [];
        try { refs = await gmailLib.listMessages(b.client, q, max); }
        catch (e) { console.warn('[CLAIM] mail search failed on', b.address, e.message); continue; }
        for (const r of refs) {
            try {
                const m = await gmailLib.getMessage(b.client, r.id);
                out.push({
                    id: r.id, mailbox: b.address,
                    from: hdr(m, 'From'), subject: hdr(m, 'Subject'),
                    date: gmailLib.parseEmailDate(hdr(m, 'Date')),
                    snippet: String(m.snippet || '').slice(0, 160),
                    seen_by_jarvis: done[r.id] ? String(done[r.id].verdict || 'yes') : null,
                });
            } catch (e) { /* one unreadable message must not hide the rest */ }
        }
    }
    out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return out.slice(0, max * 2);
}

async function read({ id, mailbox, attach = null }) {
    if (!id) throw new Error('which mail?');
    const boxes = await gmailLib.getGmailReadMailboxes();
    const box = boxes.find((b) => b.address === String(mailbox || '').toLowerCase()) || (boxes.length === 1 ? boxes[0] : null);
    if (!box) throw new Error('that mailbox is not connected for reading');
    const msg = await gmailLib.getMessage(box.client, id);
    const { body } = gmailLib.getEmailContent(msg.payload || {});
    // The WHOLE body, not just the newest reply: a forwarded claim sits in the
    // quoted part, and she chose this mail by hand.
    const text = body || msg.snippet || '';
    if (!String(text).trim()) throw new Error('that mail has no readable text');
    const verdict = await claimWatch.consider({
        messageId: id, threadId: msg.threadId,
        from: hdr(msg, 'From'), subject: hdr(msg, 'Subject'), body: text,
        mailbox: box.address, payload: msg.payload || null,
        fetchPart: (part) => gmailLib.downloadAttachment(box.client, id, { filename: part.filename, body: { attachmentId: part.attachmentId } }),
        force: true, attach,
    });
    return verdict;
}

module.exports = { search, read };
