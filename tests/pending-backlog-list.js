// ── tests/pending-backlog-list.js ─────────────────────────────────────────
// Apsara's recording, 2026-09-20 17:13: "what needs my reply" →
//   "Checked 0 new emails — nothing new … (+13 older items still open …
//    I don't have a 'list them all' view yet.)"
// Her choice: "Voice and WhatsApp" — list every open item, numbered so
// "reply to 3" / "explain 5" work, and voice says only a count.
const path = require('path'), fs = require('fs'), os = require('os');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-backlog-'));
process.env.DATA_DIR = DATA;
let pass = 0, fail = 0;
const ck = (n, c, extra) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); } };
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config.js'));
const rw = require(path.join(ROOT, 'workflow/replyWatch.js'));
const actions = require(path.join(ROOT, 'workflow/actions.js'));
const { sendCapture } = require(path.join(ROOT, 'helpers/wa-state.js'));
const sent = [];
actions.init({ sendMessage: async (_c, t) => { sent.push(String(t)); }, sendToManager: async () => {}, sendToTeam: async () => {} });

const day = (d) => new Date(Date.UTC(2026, 8, d, 10)).toISOString();
function plant(n, extra = []) {
    const tracked = [];
    for (let i = 1; i <= n; i++) tracked.push({ id: 'm' + i, threadId: 't' + i, fromName: 'Sender ' + i, from: 's' + i + '@x.com',
        subject: 'Subject ' + i, summary: 'Asks about item ' + i, waiting_on: 'her', firstFlaggedAt: day(20 - i), chases: 0 });
    fs.writeFileSync(cfg.REPLY_WATCH_FILE, JSON.stringify({ seen: {}, lastDigest: [], lastDigestAt: day(1), tracked: tracked.concat(extra) }));
}
const origRun = rw.run;
async function ask(result, voice) {
    rw.run = async () => result;
    sent.length = 0;
    const cap = { replies: [], voice, spoken: null };
    const out = await sendCapture.run(cap, () => actions.showPendingReplies('chat'));
    rw.run = origRun;
    return { out, text: sent.join('\n'), spoken: cap.spoken };
}

(async () => {
    console.log('\n=== A — her case: 0 new, 13 still open, on voice ===');
    plant(13);
    let r = await ask({ checked: 0, items: [], backlogCount: 13 }, true);
    ck('no more "I don\'t have a list them all view"', !/list them all|older items still open/i.test(r.text), r.text.slice(0, 200));
    ck('all 13 are numbered on screen', /(^|\n)\s*13\. /.test(r.text) && /(^|\n)\s*1\. /.test(r.text), r.text);
    ck('says nothing new first', /nothing new/i.test(r.text));
    ck('voice speaks only a count', r.spoken === 'Nothing new. 13 emails are still waiting on you — they\'re on screen.', r.spoken);
    ck('voice does not read a sender or subject', !/Sender|Subject/.test(r.spoken || ''));
    ck('result reports open: 13', r.out.open === 13 && r.out.action_taken === 'pending_replies_reported', JSON.stringify(r.out));
    const st = rw.loadStore();
    ck('lastDigest holds 13', (st.lastDigest || []).length === 13);
    ck('lastDigestAt stamped just now', Date.now() - Date.parse(st.lastDigestAt) < 60000, st.lastDigestAt);
    ck('longest-waiting is #1', rw.resolveDigestIndex(1) && rw.resolveDigestIndex(1).id === 'm13');
    ck('"reply to 12" resolves (was refused as stale before)', rw.resolveDigestIndex(12) && rw.resolveDigestIndex(12).id === 'm2');
    ck('"explain 13" resolves', rw.resolveDigestIndex(13) && rw.resolveDigestIndex(13).id === 'm1');
    ck('#14 does not exist', rw.resolveDigestIndex(14) === null);
    // screen number N must be lastDigest[N-1]
    const line12 = (r.text.match(/(?:^|\n)\s*12\. [^\n]*/) || [''])[0];
    ck('screen line 12 is the item "reply to 12" hits', line12.includes('item 2'), line12);

    console.log('\n=== B — same ask on WhatsApp ===');
    plant(13);
    r = await ask({ checked: 0, items: [], backlogCount: 13 }, false);
    ck('WhatsApp gets the same numbered list', /(^|\n)\s*13\. /.test(r.text));
    ck('nothing spoken outside voice', r.spoken === null);

    console.log('\n=== C — 2 new + backlog, one new already tracked ===');
    plant(4);
    r = await ask({ checked: 5, items: [
        { id: 'n1', threadId: 'tn1', fromName: 'New One', summary: 'Brand new ask', needs_reply: true, waiting_on: 'her' },
        { id: 'm2x', threadId: 't2', fromName: 'Sender 2', summary: 'Follow-up on item 2', needs_reply: true, waiting_on: 'her' },
    ], backlogCount: 4 }, true);
    const st2 = rw.loadStore();
    ck('new first, then backlog, no thread twice', st2.lastDigest.length === 5 && !st2.lastDigest.slice(2).some((x) => x.threadId === 't2'), st2.lastDigest.map((x) => x.id).join(','));
    ck('#1 is a new item', !st2.lastDigest[0].from_backlog);
    ck('header counts new and older', /2 new, plus 3 still open/.test(r.text), r.text.split('\n')[0]);
    ck('voice: count only', /^2 new, and 5 in all waiting on you/.test(r.spoken || ''), r.spoken);

    console.log('\n=== D — nothing at all ===');
    fs.writeFileSync(cfg.REPLY_WATCH_FILE, JSON.stringify({ tracked: [] }));
    r = await ask({ checked: 2, items: [], backlogCount: 0 }, true);
    ck('says nothing waiting', /nothing new waiting on a reply/.test(r.text) && r.out.action_taken === 'pending_replies_none');
    ck('voice says so', r.spoken === 'Nothing is waiting on a reply from you.');

    console.log('\n=== E — backlog item waiting on THEM is shown, not counted as hers ===');
    plant(2, [{ id: 'w1', threadId: 'tw1', fromName: 'Supplier', summary: 'We owe nothing; they owe BL', waiting_on: 'them', firstFlaggedAt: day(1) }]);
    r = await ask({ checked: 0, items: [], backlogCount: 3 }, true);
    ck('3 listed', rw.loadStore().lastDigest.length === 3);
    ck('voice counts only the 2 on her', /2 emails are still waiting on you/.test(r.spoken || ''), r.spoken);
    ck('screen says you\'re waiting on 1', /waiting on 1/.test(r.text), r.text.slice(0, 300));

    console.log(`\n${pass} passed, ${fail} failed`);
    fs.rmSync(DATA, { recursive: true, force: true });
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
