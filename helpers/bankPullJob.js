// ── helpers/bankPullJob.js — the deposits arrive on their own ─────────────
//
// Apsara, 2026-10-05: "it should able to self learn, self find… so that i
// should nt struggle at all during tax filing."
//
// A matcher she has to remember to feed is still a thing she has to remember.
// The screen has a Pull button because a person sometimes wants one now; this
// is so she never needs it.
//
// ── SILENT WHEN IT WORKS ─────────────────────────────────────────────────
// Same call helpers/integritySweepJob.js makes, and worth restating because
// a nightly "4 deposits pulled" email is one she stops opening inside a
// fortnight — and then the morning it says something real, she does not open
// that either.
//
// But silence has a cost HERE that it does not have for the sweep, and it is
// the whole reason this file is not three lines in scheduler.js: if the Plaid
// item dies, deposits simply stop arriving. The matching screen then looks
// calm and empty, which is indistinguishable from a quiet week. Nothing else
// in the system would ever notice.
//
// So the rule is narrower than "silent when clean":
//
//   · pulled something, nothing wrong        → silent
//   · pulled nothing, nothing wrong          → silent (a quiet day is normal)
//   · THE FEED ITSELF IS BROKEN              → email, because only she can
//                                              fix it, at her bank
//   · the bank restated rows she had acted on → email, because a figure moved
//                                              under a decision already made
//   · a row the bank REMOVED that she had already allocated → email, loudest
//                                              of the three: that one has her
//                                              money against an invoice that
//                                              the bank now says never
//                                              happened
//
// Everything else lives on /bank-match, where it belongs.

const cfg = require('../config');

const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── which failures are HERS to fix ───────────────────────────────────────
// ITEM_LOGIN_REQUIRED and friends mean the bank wants her to authenticate
// again and no amount of retrying helps. A timeout or a 500 from Plaid is
// transient and the next run gets it, so that is not worth waking her for.
const NEEDS_HER = /ITEM_LOGIN_REQUIRED|PENDING_EXPIRATION|ITEM_NOT_SUPPORTED|INVALID_CREDENTIALS|INSUFFICIENT_CREDENTIALS|ITEM_LOCKED|USER_PERMISSION_REVOKED|not configured/i;

// ── find ─────────────────────────────────────────────────────────────────
// Takes its dependencies so a test drives it without a network or a mailbox.
async function pull({ plaid, ledger } = {}) {
    const P = plaid || require('./plaid');
    const L = ledger || require('./bankLedger');

    const st = P.status();
    if (!st.configured) {
        return { ran: false, why: 'Plaid is not configured on this server', needsHer: false,
            findings: [], added: 0, modified: 0, removed: [], errors: [] };
    }
    if (!st.items.length) {
        // Not an error and not worth an email: she has not linked a bank yet,
        // and the screen says so in plain words.
        return { ran: false, why: 'no bank is linked yet', needsHer: false,
            findings: [], added: 0, modified: 0, removed: [], errors: [] };
    }

    const before = L.list();
    const beforeById = new Map(before.map((r) => [r.id, r]));

    let out;
    try { out = await P.syncAll({}); }
    catch (e) {
        return { ran: true, why: null, needsHer: true, added: 0, modified: 0, removed: [], errors: [],
            findings: [{ kind: 'feed', title: 'The bank feed could not run at all', detail: e.message }] };
    }

    const after = L.list();
    const findings = [];

    // 1. A broken item. Only the kinds she can actually do something about.
    for (const e of (out.errors || [])) {
        if (!NEEDS_HER.test(String(e.error || ''))) continue;
        findings.push({
            kind: 'feed',
            title: `${e.institution || e.item_id} needs you to sign in again`,
            detail: `${e.error}\n\nUntil that is done, no new deposits arrive from this bank and the `
                + 'matching screen will look empty rather than broken. Reconnect it on the bank matching page.',
        });
    }

    // 2. The bank restated a row she had already acted on. bankLedger flags
    //    this; here it becomes something that leaves the machine.
    const drifted = after.filter((r) => r.drift && !(beforeById.get(r.id) || {}).drift);
    if (drifted.length) {
        findings.push({
            kind: 'drift',
            title: `The bank changed ${drifted.length} row${drifted.length === 1 ? '' : 's'} you had already dealt with`,
            detail: drifted.map((r) => {
                const w = (r.drift.was || {}), n = (r.drift.now || {});
                return `  ${r.date}  ${r.desc || '(no description)'}\n`
                    + `      ${r.drift.fields.map((f) => `${f}: ${JSON.stringify(w[f])} -> ${JSON.stringify(n[f])}`).join(', ')}`;
            }).join('\n'),
        });
    }

    // 3. THE LOUDEST ONE. A row the bank has withdrawn that she had already
    //    allocated against an invoice. Her receipt now rests on a bank
    //    movement the bank says never happened, and nothing else in the
    //    system will ever mention it.
    const removedIds = (out.removed || []).map(String);
    if (removedIds.length) {
        const acted = removedIds
            .map((id) => beforeById.get(id))
            .filter((r) => r && (r.excluded || (r.history || []).length));
        const allocated = allocatedAgainst(removedIds);
        if (acted.length || allocated.length) {
            findings.push({
                kind: 'removed',
                title: `The bank withdrew ${removedIds.length} transaction${removedIds.length === 1 ? '' : 's'} you had already used`,
                detail: (allocated.length
                    ? 'These receipts were recorded against a bank row the bank has now withdrawn:\n'
                        + allocated.map((r) => `  receipt ${r.id}  ${r.date}  ${money(r.amount)}  ${r.customer}`).join('\n')
                        + '\n\nThe receipt is NOT reversed automatically — reversing money on a bank\'s '
                        + 'say-so would be its own kind of wrong. Check it and delete the receipt if the '
                        + 'payment really did not arrive.\n\n'
                    : '')
                    + (acted.length ? 'And these were excluded or categorised before being withdrawn:\n'
                        + acted.map((r) => `  ${r.date}  ${money(r.amount)}  ${r.desc || ''}`).join('\n') : ''),
            });
        }
    }

    return {
        ran: true, why: null,
        needsHer: findings.length > 0,
        added: out.added || 0,
        modified: out.modified || 0,
        removed: removedIds,
        errors: out.errors || [],
        truncated: !!out.truncated,
        findings,
    };
}

// Receipts whose `ref` is one of these bank rows. The matching screen writes
// the transaction id into the receipt's ref precisely so this lookup is
// possible — a receipt that cannot be traced back to its bank row is a
// receipt nobody can check.
function allocatedAgainst(ids) {
    try {
        const set = new Set(ids.map(String));
        return require('./salesReceipts').list()
            .filter((r) => r && r.ref && set.has(String(r.ref)))
            .map((r) => ({ id: r.id, date: r.date, amount: r.amount, customer: r.customer }));
    } catch (e) { return []; }
}

// ── send ─────────────────────────────────────────────────────────────────
function subjectFor(res) {
    const worst = res.findings[0];
    if (!worst) return 'Jarvis: the bank feed is fine';
    if (worst.kind === 'removed') return 'Jarvis: the bank withdrew a transaction you had used';
    if (worst.kind === 'feed') return `Jarvis: ${worst.title.toLowerCase()}`;
    return 'Jarvis: the bank changed rows you had already dealt with';
}

function bodyFor(res) {
    const L = [];
    L.push(res.findings.map((f) => `${f.title}\n${f.detail}`).join('\n\n'));
    L.push('');
    L.push(`Pulled this run: ${res.added} new, ${res.modified} corrected`
        + (res.removed.length ? `, ${res.removed.length} withdrawn by the bank` : ''));
    if (res.truncated) L.push('The pull stopped early — there is more to fetch. It will continue on the next run.');
    L.push('');
    L.push('Everything else is on the bank matching page, where it can be confirmed one deposit at a time.');
    return L.join('\n');
}

async function run({ plaid, ledger, sendEmail, to, sendAlways = process.env.SEND_ALWAYS === '1' } = {}) {
    const res = await pull({ plaid, ledger });

    if (!res.needsHer && !sendAlways) return { ...res, sent: false, reason: res.ran ? 'nothing needs her' : res.why };

    const send = sendEmail || (async (m) => require('./gmail').sendEmail(m));
    // ── cfg.ALERT_EMAIL_TO, AND config.js SAYS WHY ───────────────────────
    // I first wrote `cfg.ALERT_EMAIL || cfg.OWNER_EMAIL`. Neither exists.
    // config.js:676 records the same mistake being made before, in
    // helpers/ledgerAgentJob.js: it "fell back to a cfg.ALERT_EMAIL that
    // does not exist either (the real name is ALERT_EMAIL_TO). Both
    // undefined meant the job logged 'no recipient configured' and sent
    // nothing — for ever, without erroring."
    //
    // A nightly job that silently sends nothing is the worst possible
    // failure for this particular feature, because its whole job is to be
    // the one thing that notices when the feed dies. The repo had already
    // written the warning down and I walked into it inside the hour, so the
    // test asserts the resolved address rather than the code path.
    const target = to || cfg.ALERT_EMAIL_TO || null;
    if (!target) return { ...res, sent: false, reason: 'no address to send to — set ALERT_EMAIL_TO' };

    try {
        await send({ to: target, subject: subjectFor(res), body: bodyFor(res) });
        return { ...res, sent: true };
    } catch (e) {
        // A mail failure must not look like a clean run. The finding still
        // happened and the log is the last place it can be seen.
        console.error('[BANK PULL] could not send:', e && e.message);
        return { ...res, sent: false, reason: e && e.message };
    }
}

module.exports = { pull, run, subjectFor, bodyFor, NEEDS_HER, allocatedAgainst };
