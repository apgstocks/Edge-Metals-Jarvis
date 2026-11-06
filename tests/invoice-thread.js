// helpers/invoiceThread.js - find the thread the invoice went out in (Apsara, 2026-11-07), read-only.
const path = require('path');
process.env.JARVIS_TEST = '1';
const it = require(path.join(__dirname, '..', 'helpers/invoiceThread'));
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const draft = { to: 'AP@Daekwang.example', lines: [{ invoice_no: 'INV-9', container_no: 'ZZZZ9', date: '2026-10-30' }, { invoice_no: 'INV-1', container_no: 'AAAA1', date: '2026-10-01' }] };
(async () => {
    ck('oldest unpaid invoice is searched first', it.refsOf(draft)[0] === 'INV-1');
    ck('Re: is added once', it.reSubject('Invoice 1') === 'Re: Invoice 1' && it.reSubject('RE: Invoice 1') === 'RE: Invoice 1');
    const queries = [];
    const sent = { 'm1': { messageId: '<m1@x>', subject: 'Invoice INV-1 Edge Metals', threadId: 'T1', dateMs: 1 } };
    const f = it.makeFinder({ list: async (q) => { queries.push(q); return /INV-1"/.test(q) ? [{ id: 'm1', threadId: 'T1' }] : []; }, get: async (id) => sent[id] });
    const r = await f(draft);
    ck('found in the sent folder: thread, Message-ID, Re: subject', r && r.threadId === 'T1' && r.messageId === '<m1@x>' && r.subject === 'Re: Invoice INV-1 Edge Metals' && r.source === 'sent', JSON.stringify(r));
    ck('the search is to THAT customer only, in sent mail', /^in:sent to:ap@daekwang\.example "INV-1"/.test(queries[0]), queries[0]);
    ck('nothing found: null (caller sends a new email)', (await it.makeFinder({ list: async () => [], get: async () => null })(draft)) === null);
    ck('no address: null, no search', (await it.makeFinder({ list: async () => { throw new Error('searched'); }, get: async () => null })({ lines: draft.lines })) === null);
    const tracked = [{ to: 'ap@daekwang.example', thread_id: 'TT', message_id: '<t@x>', subject: 'Docs AAAA1', refs: ['AAAA1'], sent_at: '2026-10-02' }, { to: 'other@x.example', thread_id: 'NO', message_id: '<o@x>', refs: ['AAAA1'], sent_at: '2026-10-03' }];
    const g = await it.makeFinder({ tracked: () => tracked })(draft);
    ck('a mail Jarvis sent itself is found from its record, only for the same customer', g && g.threadId === 'TT' && g.source === 'tracked', JSON.stringify(g));
    ck('liveFinder never throws with no Gmail', (await it.liveFinder()(draft)) === null);
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
