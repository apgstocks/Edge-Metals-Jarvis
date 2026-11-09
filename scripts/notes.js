#!/usr/bin/env node
// ── scripts/notes.js — teach Jarvis a rule in your own words, and see what it kept ──
//   node scripts/notes.js add    "text"  --company edge_metals    keep it, or ask if it looks like one you gave
//   node scripts/notes.js answer <thread> "replace 4" | "keep" | "cancel"   (a different run, days later, is fine)
//   node scripts/notes.js waiting                                 questions parked on you
//   node scripts/notes.js list                                    every live note
//   node scripts/notes.js ask    "text"                           what it would recall for that situation
//   node scripts/notes.js forget <id>
//   node scripts/notes.js check                                   real Gemini: embed two sentences, print their similarity
//   --company is REQUIRED. There is no default, because Edge Metals and Edge Yard are different companies.
//
// Runs where data/ is: on the VM for the live notes. On the Mac it fills the Mac checkout's own data/disk.
// Needs GEMINI_API_KEY (the same one the app uses). Nothing in the app reads these notes yet.
const { getDisk } = require('../helpers/diskStore');
const embedders = require('../helpers/disk/embedder');
const { createRunner } = require('../agents/teach');

const WHO = { by: 'apsara', role: 'manager' };
const args = process.argv.slice(2);
const ci = args.indexOf('--company');
const company = ci >= 0 ? args.splice(ci, 2)[1] : null;
const [cmd, ...rest] = args;
const fail = (m) => { console.error(m); process.exit(1); };

function pickEmbedder() {
    if (process.env.JARVIS_NOTES_EMBEDDER === 'stub') {
        if (process.env.JARVIS_TEST !== '1') fail('the stub embedder measures shared words, not meaning, and is for tests only');
        return embedders.stub();
    }
    return embedders.gemini();
}

(async () => {
    if (!cmd || !['add', 'answer', 'waiting', 'list', 'ask', 'forget', 'check'].includes(cmd)) {
        fail('usage: node scripts/notes.js add|answer|waiting|list|ask|forget|check ... --company edge_metals|edge_yard');
    }
    const embedder = pickEmbedder();
    if (cmd === 'check') {
        const [a, b] = [await embedder.embed('Rad Metal always pays on the 15th of the month.'), await embedder.embed('Rad Metal usually pays in the middle of each month.')];
        const c = await embedder.embed('Zimex wants every invoice in Canadian dollars.');
        const cos = (x, y) => { let s = 0, nx = 0, ny = 0; for (let i = 0; i < x.length; i++) { s += x[i] * y[i]; nx += x[i] * x[i]; ny += y[i] * y[i]; } return s / Math.sqrt(nx * ny); };
        console.log(`model ${embedder.model}, ${a.length} dimensions`);
        console.log(`same idea, different words : ${cos(a, b).toFixed(3)}`);
        console.log(`different idea             : ${cos(a, c).toFixed(3)}`);
        console.log('Use these two numbers to pick the "ask me" threshold (default 0.80). The first should be clearly higher than the second.');
        return;
    }
    if (!company) fail('--company is required (edge_metals or edge_yard)');
    let runner;
    try {
        runner = createRunner({ disk: getDisk(), company, embedder, askAbove: Number(process.env.JARVIS_NOTES_ASK_ABOVE) || 0.8,
            notify: async (m) => { console.log('\n' + m.text + `\n(thread ${m.threadId})`); } });
    } catch (e) { fail(e.message); }
    const part = getDisk().for(company);
    const bad = part.health().badLines;
    if (bad.notes) console.error(`warning: ${bad.notes} unreadable line(s) in notes were skipped`);

    if (cmd === 'add') {
        if (!rest[0]) fail('add needs the text, in quotes');
        const r = await runner.start({ text: rest[0], ...WHO });
        if (r.status === 'waiting' || r.status === 'already_waiting') console.log(r.status === 'waiting' ? '\nNot saved yet: waiting for your answer.' : '\nAlready waiting for your answer.');
        else if (r.status === 'saved') console.log(`saved as #${r.id}`);
        else if (r.status === 'already_known') console.log(`you already told me exactly this (#${r.id})`);
        else fail(`${r.status}: ${r.reason || ''}`);
    } else if (cmd === 'answer') {
        if (!rest[0] || !rest[1]) fail('answer needs the thread id and your reply');
        const r = await runner.answer(rest[0], rest[1]);
        console.log(r.status === 'failed' ? `could not apply that: ${r.reason}` : r.status === 'cancelled' ? 'cancelled; nothing saved' : `${r.status}: #${r.id}${r.replaced ? ` (replaced #${r.replaced}, kept in history)` : ''}`);
    } else if (cmd === 'waiting') {
        const w = await runner.waiting();
        if (!w.length) console.log('nothing waiting');
        for (const x of w) console.log(`${x.threadId}\n  "${x.text}"`);
    } else if (cmd === 'list') {
        const l = part.notes.list();
        if (!l.length) console.log('no notes yet');
        for (const n of l) console.log(`#${n.id}${n.embedded ? '' : ' (not embedded)'}  ${n.text}`);
    } else if (cmd === 'ask') {
        if (!rest[0]) fail('ask needs the situation, in quotes');
        const r = await runner.recall(rest[0]);
        if (r.embedderError) console.error(`note: meaning search unavailable (${r.embedderError}); keywords only`);
        if (!r.notes.length) console.log('nothing related');
        for (const n of r.notes) console.log(`#${n.id} [${n.basis}, ${n.via} ${n.score}]  ${n.text}`);
        if (r.notes.length) console.log('\n(related = advisory; a match is not a decision)');
    } else if (cmd === 'forget') {
        const id = Number(rest[0]);
        if (!Number.isInteger(id)) fail('forget needs a note number');
        console.log(part.notes.forget(id, WHO) ? `forgot #${id}` : `no live note #${id}`);
    }
})().then(() => process.exit(0), (e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
