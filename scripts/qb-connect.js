#!/usr/bin/env node
// ── scripts/qb-connect.js — ONE-TIME QuickBooks connection ──────────────────
// Same shape as scripts/gmail-auth.js: run it on the laptop (the consent
// screen needs a browser), then copy the token file to the VM's DATA_DIR.
//
//   node scripts/qb-connect.js                 print the link to open
//   node scripts/qb-connect.js --url='<...>'   finish: paste the WHOLE address
//                                              the browser landed on (it may
//                                              show "can't connect" — that is
//                                              fine, only the address matters)
//   node scripts/qb-connect.js --test          read the company name back
//   node scripts/qb-connect.js --status
//   node scripts/qb-connect.js --disconnect
//
// Add --env=production to act on the live company. The default is sandbox,
// on purpose: nothing here reaches her real books unless it is said out loud.
// The Intuit code in that URL expires in minutes, so finish promptly.

require('dotenv').config();
const arg = (k) => { const a = process.argv.find((x) => x === `--${k}` || x.startsWith(`--${k}=`)); return a ? (a.includes('=') ? a.slice(a.indexOf('=') + 1) : true) : null; };
if (arg('env')) process.env.QB_ENV = String(arg('env'));

const auth = require('../helpers/quickbooks/auth');
const client = require('../helpers/quickbooks/client');

async function main() {
    const env = auth.qbEnv();
    console.log(`QuickBooks environment: ${env.toUpperCase()}${env === 'production' ? '  <-- LIVE BOOKS' : ''}`);

    if (arg('status')) { console.log(auth.status(env)); return; }
    if (arg('disconnect')) { console.log((await auth.disconnect({ env })) ? 'Disconnected.' : 'Was not connected.'); return; }

    if (arg('url')) {
        const t = await auth.exchangeRedirect(arg('url'), { env });
        console.log(`Connected. realmId ${t.realmId}. Token saved to ${auth.tokenFile(env)}`);
    }
    if (arg('url') || arg('test')) {
        const ci = await client.companyInfo({ env });
        console.log(`Company: ${ci.CompanyName}  (legal: ${ci.LegalName || '-'}, country: ${ci.Country || '-'})`);
        console.log(auth.status(env));
        return;
    }

    console.log('\n1. Open this link, sign in, pick the company, click Connect:\n');
    console.log(auth.buildAuthUrl(env));
    console.log('\n2. Copy the full address your browser lands on and run:');
    console.log(`   node scripts/qb-connect.js${env === 'production' ? ' --env=production' : ''} --url='<that address>'\n`);
}

main().catch((e) => { console.error('QuickBooks connect failed:', e.message); process.exit(1); });
