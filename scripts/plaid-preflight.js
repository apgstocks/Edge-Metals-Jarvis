#!/usr/bin/env node
// ── scripts/plaid-preflight.js — what is still missing, in order ──────────
//
// Apsara, 2026-10-08: "i want it to work in half hour."
//
// Half an hour is enough IF nothing is missing. The way that half hour gets
// spent instead is staring at a screen that says nothing, so this says what
// is missing and in what order to fix it. It is the list, not the fix.
//
//   node scripts/plaid-preflight.js
//
// READS ONLY. No Plaid call, no network, no writes — so it is safe to run on
// the live VM mid-problem, which is exactly when it is wanted. It therefore
// cannot tell you whether the KEYS are valid, only whether they are present;
// the first real call does that and the screen reports it.
//
// NOTHING HERE PRINTS A SECRET. Every credential is reported as set / not
// set with a length, never a value — the same rule helpers/plaid.js:67
// redact() exists for, applied to a script that someone will paste into a
// chat window the moment it says something confusing.

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));

const ok = (s) => `  \u001b[32mOK\u001b[0m    ${s}`;
const no = (s) => `  \u001b[31mNO\u001b[0m    ${s}`;
const meh = (s) => `  \u001b[33m--\u001b[0m    ${s}`;

const todo = [];
const lines = [];
const say = (l) => lines.push(l);

// ── 1. keys ──────────────────────────────────────────────────────────────
const has = (v) => !!(v && String(v).trim());
say('\n── CREDENTIALS ───────────────────────────────────────────────────\n');
say(has(cfg.PLAID_CLIENT_ID)
    ? ok(`PLAID_CLIENT_ID is set (${String(cfg.PLAID_CLIENT_ID).length} chars)`)
    : no('PLAID_CLIENT_ID is not set'));
say(has(cfg.PLAID_SECRET)
    ? ok(`PLAID_SECRET is set (${String(cfg.PLAID_SECRET).length} chars)`)
    : no('PLAID_SECRET is not set'));
if (!has(cfg.PLAID_CLIENT_ID) || !has(cfg.PLAID_SECRET)) {
    todo.push('Put PLAID_CLIENT_ID and PLAID_SECRET in the VM\'s .env, then '
        + 'pm2 restart jarvis --update-env. They are on the Plaid dashboard under '
        + 'Developers / Keys. Use the SANDBOX secret for sandbox and the PRODUCTION '
        + 'secret for production — they are different values.');
}

const env = String(cfg.PLAID_ENV || 'sandbox');
say(env === 'production'
    ? ok('PLAID_ENV is production — this is her real bank')
    : meh(`PLAID_ENV is ${env} — fake institutions, nothing of hers`));
// Anything unrecognised silently becomes sandbox (plaid.js:49-54). Worth
// saying, because a typo looks like production refusing to work.
if (!['sandbox', 'development', 'production'].includes(env)) {
    say(no(`  "${env}" is not a Plaid environment — it will be treated as sandbox`));
    todo.push(`PLAID_ENV is "${env}", which Jarvis treats as sandbox. Set it to production.`);
}

// ── 2. the webhook ───────────────────────────────────────────────────────
say('\n── WEBHOOKS — so nobody has to press anything ────────────────────\n');
if (has(cfg.PLAID_WEBHOOK_URL)) {
    const u = String(cfg.PLAID_WEBHOOK_URL);
    say(ok(`PLAID_WEBHOOK_URL is ${u}`));
    if (!/^https:\/\//.test(u)) {
        say(no('  it is not https — Plaid will not post to it'));
        todo.push('PLAID_WEBHOOK_URL must be https with a valid certificate. Plaid '
            + 'will not post to http or to localhost, in any environment.');
    }
    if (!/\/api\/plaid\/webhook$/.test(u)) {
        say(no('  it does not end /api/plaid/webhook — that is the route that exists'));
        todo.push('PLAID_WEBHOOK_URL should end /api/plaid/webhook.');
    }
} else {
    say(meh('PLAID_WEBHOOK_URL is not set — the 05:45 pull still works'));
    todo.push('Set PLAID_WEBHOOK_URL=https://jarvis.edgemetals.com/api/plaid/webhook '
        + 'in the VM\'s .env. Without it the feed still works, but a dead connection '
        + 'is noticed up to a day later instead of within the hour. It is only read '
        + 'when a bank is LINKED, so set it BEFORE linking or the Item never gets one.');
}

// ── 3. what is linked ────────────────────────────────────────────────────
say('\n── BANKS ─────────────────────────────────────────────────────────\n');
let items = [];
try { items = require(path.join(ROOT, 'helpers/plaid')).itemsPublic(); }
catch (e) { say(no(`could not read the linked items: ${e.message}`)); }
if (!items.length) {
    say(meh('no bank is linked yet'));
    todo.push('Open https://jarvis.edgemetals.com/bank-match and press "Connect a '
        + 'bank". BofA and Chase both use OAuth, so Plaid opens the bank\'s own site '
        + 'in a pop-up — do it on a laptop, not the phone app.');
} else {
    for (const i of items) {
        const when = i.last_sync_at ? String(i.last_sync_at).slice(0, 10) : 'never';
        const days = i.last_sync_at
            ? Math.floor((Date.now() - new Date(i.last_sync_at).getTime()) / 86400000) : null;
        const line = `${i.institution || i.item_id} — ${(i.accounts || []).length} account(s), last sync ${when}`;
        say(days != null && days <= 2 ? ok(line) : no(line));
        if (days == null) {
            todo.push(`${i.institution || i.item_id} has never synced. Press "Pull new `
                + 'transactions" once on /bank-match to prove the path.');
        } else if (days > 2) {
            todo.push(`${i.institution || i.item_id} last synced ${days} days ago. It `
                + 'probably needs re-authenticating at the bank — /bank-match says so '
                + 'at the top, and only she can do it.');
        }
    }
}

// ── 4. the chart, which is where the money lands ─────────────────────────
say('\n── WHERE THE MONEY WILL LAND ─────────────────────────────────────\n');
try {
    const BR = require(path.join(ROOT, 'helpers/bankReconcile'));
    const accts = BR.bankAccounts();
    for (const a of accts) say(ok(`${a.bank} → ${a.code} ${a.name}`));

    // The join nobody notices until a deposit lands in the wrong company's
    // books: bank-accounts.json carries plaid_account_id, and bankLedger
    // needs it to know WHICH COMPANY a row belongs to.
    // ── THE JOIN THAT FAILS SILENTLY AND LOOKS LIKE AN EMPTY FEED ───────
    // bankLedger.companyOf/bankOf match a Plaid row's account_id against
    // `a.id` OR `a.plaid_account_id`. Today `id` is a local slug
    // ("edge-metals-bofa") and plaid_account_id is null — so after linking,
    // EVERY row gets company:null and bank:null.
    //
    // Nothing throws. The feed fills up, and the reconciliation — which
    // filters rows by bank — finds none for either account and reports
    // zeroes against a full ledger. That reads as "Plaid sent nothing",
    // which is the wrong thing to go and debug.
    //
    // A local slug is not evidence of a join, so this is checked strictly:
    // a Plaid account id is required, and it only exists after linking.
    const rows = require(path.join(ROOT, 'helpers/bankLedger')).readAccounts();
    const joined = rows.filter((r) => r && has(r.plaid_account_id));
    if (!rows.length) {
        say(meh('qb-settings/bank-accounts.json lists no accounts'));
    } else if (joined.length === rows.length) {
        say(ok(`all ${rows.length} account(s) are joined to a Plaid account id`));
    } else {
        say(no(`${rows.length - joined.length} of ${rows.length} account(s) have no plaid_account_id`));
        for (const r of rows.filter((x) => !has(x.plaid_account_id))) {
            say(`          ${r.id} (${r.company || 'no company'})`);
        }
        // NOT a task for her — exchange() fills this in on link, matching
        // Plaid's mask against the accountNumber already stored. Listed
        // anyway because until a bank IS linked it reads as unjoined, and
        // a preflight that stays silent about the most consequential field
        // in the file is not worth running. Phrased as "expect this to
        // clear" rather than "go and do this".
        todo.push('Nothing to do — this clears itself when you link. exchange() matches '
            + 'Plaid\'s last-four against the account number already in the file and '
            + 'writes plaid_account_id. Run this script again after linking: if it still '
            + 'says NO, the join did not happen, and THAT is worth stopping for — '
            + 'without it every transaction arrives with no company and no bank, the feed '
            + 'fills, and the reconciliation reports ZERO for both banks because it '
            + 'filters on them. It looks exactly like "Plaid sent nothing".');
    }
} catch (e) { say(no(`chart check failed: ${e.message}`)); }

// ── 5. is the deployed code the code that does all this ──────────────────
say('\n── IS THIS VM RUNNING THE CODE THAT DOES ANY OF THIS ─────────────\n');
const present = (rel, what) => {
    const there = fs.existsSync(path.join(ROOT, rel));
    say(there ? ok(what) : no(`${what} — ${rel} is missing, this VM is behind`));
    if (!there) todo.push(`${rel} is not on this machine. git pull && pm2 restart jarvis --update-env.`);
};
present('helpers/plaidWebhook.js', 'the webhook verifier is deployed');
present('helpers/bankReconcile.js', 'the bank-vs-books reconciliation is deployed');
present('helpers/bankOut.js', 'the money-out matcher is deployed');

console.log(lines.join('\n'));

console.log('\n── WHAT IS LEFT, IN ORDER ────────────────────────────────────────\n');
if (!todo.length) {
    console.log('  Nothing. Everything this script can see is in place.');
    console.log('  It cannot tell you whether the KEYS are valid or whether Plaid has');
    console.log('  approved OAuth for BofA and Chase — the first real link does that.\n');
} else {
    todo.forEach((t, i) => console.log(`  ${i + 1}. ${t}\n`));
}

// ── THE ONE THIS SCRIPT CANNOT CHECK, SAID ANYWAY ────────────────────────
// It is the thing most likely to be in the way, and a preflight that stays
// quiet about its own blind spot sends her looking at the wrong list.
if (env === 'production') {
    console.log('── AND THE ONE I CANNOT SEE FROM HERE ────────────────────────────\n');
    console.log('  BofA and Chase are OAuth institutions, so linking depends on Plaid');
    console.log('  having REGISTERED this app with each of them. Nothing on this machine');
    console.log('  knows whether that has happened. One page says:\n');
    console.log('    https://dashboard.plaid.com/settings/compliance/us-oauth-institutions\n');
    console.log('  If both show approved, go and link. If they do not, Connect a bank');
    console.log('  fails at the BANK\'S own site and nothing in Jarvis can explain why —');
    console.log('  so check the page first rather than debugging from this end.\n');
    // Corrected 2026-10-08. The first version of this note said the
    // compliance centre MUST be complete before any OAuth bank will
    // connect. Plaid's OAuth guide is narrower: "If you are on a Trial
    // plan, you do not need to complete these requirements until you
    // upgrade to a paid plan." Production access can therefore be enough
    // on its own, and telling her otherwise sent her to do paperwork when
    // she could have been linking.
    console.log('  On a TRIAL plan the compliance centre does not have to be complete');
    console.log('  first — Plaid only require it on upgrade to a paid plan. On a paid');
    console.log('  plan it does, and registration then takes hours, not minutes.\n');
}
