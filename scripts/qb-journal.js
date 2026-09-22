#!/usr/bin/env node
// ── scripts/qb-journal.js — what Jarvis did to QuickBooks, and taking it back ─
//   node scripts/qb-journal.js list [--kind=billpayment] [--env=production]
//   node scripts/qb-journal.js check                 read-only: where QB no longer agrees
//   node scripts/qb-journal.js undo <J_id> --reason="wrong bank"          (dry run)
//   node scripts/qb-journal.js undo <J_id> --reason="wrong bank" --really
// Undo in the live books is a delete, and client.js refuses it unless
// QB_PROD_WRITES=on. Undo never deletes a record Jarvis did not create.
require('dotenv').config();
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
if (arg('env')) process.env.QB_ENV = arg('env');
const J = require('../helpers/quickbooks/journal');
const [cmd, id] = process.argv.slice(2).filter((x) => !x.startsWith('--'));
(async () => {
    const env = require('../helpers/quickbooks/auth').qbEnv();
    if (cmd === 'list') {
        const rows = J.list({ env, ...(arg('kind') ? { kind: arg('kind') } : {}) });
        for (const e of rows) console.log([e.id, e.at.slice(0, 16), e.kind.padEnd(11), e.action.padEnd(15), (e.jarvis && (e.jarvis.container || e.jarvis.id)) || '', e.qb && e.qb.id ? `QB #${e.qb.id}` : '', e.qb && e.qb.total != null ? e.qb.total : '', e.reason || ''].join('  '));
        console.log(`${rows.length} entries · ${J.active(env).length} standing`);
    } else if (cmd === 'check') {
        const d = await J.discrepancies({ env });
        if (!d.length) console.log('Everything Jarvis entered or linked still agrees with QuickBooks.');
        for (const x of d) console.log(`${x.journalId}  ${x.kind} QB #${x.qbId}  ${(x.jarvis && (x.jarvis.container || x.jarvis.id)) || ''}\n    - ${x.issues.join('\n    - ')}`);
    } else if (cmd === 'undo') {
        const r = await J.undo(id, { env, dryRun: !process.argv.includes('--really'), reason: arg('reason') || '' });
        console.log(r.status, r.why || r.note || r.journalId || '');
    } else {
        console.log('usage: list | check | undo <J_id> --reason="..." [--really]');
    }
})().catch((e) => { console.error('qb-journal failed:', e.message); process.exit(1); });
