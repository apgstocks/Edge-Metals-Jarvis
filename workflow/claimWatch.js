// ── workflow/claimWatch.js — a claim mail becomes a claim record ─────────────
//
// Apsara, 2026-09-26: "it should read the mail with weight shortage detail and
// create automatically .. Notify the staff about it in whatsapp and add it in
// to do list."
//
// WHY THIS IS A SIBLING AND NOT PART OF replyWatch
// replyWatch.js is 4805 lines, exports ~70 symbols, and workflow/actions.js
// reaches into it from twenty-odd sites. The reply digest is something she
// depends on daily. A bug in claim parsing must not be able to break it, so
// this lives in its own file and replyWatch calls `consider()` inside a
// try/catch that ignores the result. replyWatch's own behaviour is unchanged:
// nothing here writes to its store, marks a message seen, or continues its loop.
//
// WHY IT PIGGYBACKS ON replyWatch'S LOOP RATHER THAN POLLING
// Five watchers already poll these mailboxes every 5–15 minutes. A sixth would
// re-fetch the same messages and double the model spend. replyWatch has already
// fetched the message, stripped the quoted tail, and resolved the mailbox by
// the time it calls in here.
//
// DRY RUN IS LOAD-BEARING. actions.js:5465 calls replyWatch.run({dryRun:true})
// when she asks "what needs my reply" in WhatsApp. Without honouring it, asking
// that question would create claims and message the team.
const cfg = require('../config');
const { loadJson, mutateJson } = require('../helpers/json');
const claims = require('../helpers/claims');
const tasks = require('../helpers/tasks');
const { gate, extract } = require('../helpers/claimParse');

let _sendToTeam = async () => {};
function init({ sendToTeam } = {}) {
    if (typeof sendToTeam === 'function') _sendToTeam = sendToTeam;
}

// ── PROCESSED MARKER ────────────────────────────────────────────────────────
// Its own file, keyed by Gmail message id. NOT replyWatch's `seen`: trimSeen
// ages that out, so a customer's third chaser weeks later would read as a new
// message and create a second claim. Same reasoning as
// PAYMENT_EMAILS_PROCESSED_FILE, which exists for exactly this.
const PFILE = () => cfg.CLAIM_EMAILS_PROCESSED_FILE;
const KEEP_DAYS = 400;

function processed() { return loadJson(PFILE(), {}) || {}; }
async function markProcessed(messageId, verdict) {
    const cut = Date.now() - KEEP_DAYS * 86400000;
    await mutateJson(PFILE(), {}, (m) => {
        for (const [k, v] of Object.entries(m)) {
            const at = typeof v === 'string' ? Date.parse(v) : Date.parse(v && v.at);
            if (Number.isFinite(at) && at < cut) delete m[k];
        }
        m[messageId] = { at: new Date().toISOString(), verdict };
        return m;
    }, { strict: true });
}

const money = (n) => (n === null || n === undefined ? null : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }));

// ── THE WHATSAPP LINE ───────────────────────────────────────────────────────
// sendToTeam only — index.js:130 falls back to her own number when no team
// group is set, and never reaches a trucker or a supplier. A shortage claim is
// commercially sensitive and the supplier is the party it will be recovered
// from, so it must not land in a group they are in.
//
// The message names the SUPPLIER, because that is the actionable half. The
// claim against Edge is a cost; the recovery is the decision.
function notifyText(c, { isNew, changed }) {
    const L = [];
    L.push(isNew ? 'Weight shortage claim received' : 'Weight shortage claim updated');
    L.push('');
    L.push(`Customer:  ${c.customer || '—'}`);
    L.push(`Invoice:   ${c.invoice_no || '—'}`);
    L.push(`Container: ${c.container_no || '—'}`);
    const unit = c.weight_unit || '';
    if (c.invoice_weight != null) L.push(`Invoiced:  ${c.invoice_weight}${unit ? ' ' + unit : ' (unit not stated)'}`);
    if (c.claimed_weight != null) L.push(`They say:  ${c.claimed_weight}${unit ? ' ' + unit : ''}`);
    if (c.stated_claim_amount != null) L.push(`They ask:  ${money(c.stated_claim_amount)}`);
    L.push(`Recover from: ${c.supplier || 'SUPPLIER NOT NAMED IN THE MAIL'}`);
    L.push('');
    if (changed) L.push('The customer has moved their figure since the last mail — check before agreeing anything.');
    if (!c.weight_unit) L.push('The mail did not state MT, KG or LB, so no claim amount has been worked out. Nothing is a figure until someone confirms the unit.');
    else L.push('Read from the mail, not yet checked. No claim amount is recorded until the weights are confirmed.');
    L.push('');
    L.push('Open /claims to confirm the weights and raise the recovery.');
    return L.join('\n');
}

// ── THE TO-DOS ──────────────────────────────────────────────────────────────
// target_kind is ALWAYS 'manager'. A Jarvis task is not an inert to-do —
// scheduler's taskRunner resolves the target and SENDS the message every
// minute, so 'trucker' or 'supplier' here would tell the counterparty about an
// unverified claim. `bkg_no` carries the container so cancelMatching can find
// these again when the claim moves on.
const CHASE_HOURS = Number(process.env.CLAIM_CHASE_HOURS || 48);

async function raiseVerifyTodo(c) {
    return tasks.enqueue({
        type: 'claim_verify',
        target_kind: 'manager',
        target_name: 'Apsara',
        bkg_no: c.container_no || c.invoice_no || '',
        created_by: 'claims',
        claim_id: c.id,
        fire_at: Date.now() + CHASE_HOURS * 3600000,
        message: [
            `Still unverified after ${CHASE_HOURS} hours — weight shortage claim.`,
            '',
            `${c.customer || 'customer'} · ${c.invoice_no || '—'} · ${c.container_no || '—'}`,
            c.stated_claim_amount != null ? `They are asking ${money(c.stated_claim_amount)}.` : '',
            c.supplier ? `Recovery would fall to ${c.supplier}.` : 'No supplier named yet, so there is nobody to recover from.',
            '',
            'Confirm the weight and the unit on /claims — until that is done this claim is not a figure and the recovery cannot be raised.',
        ].filter(Boolean).join('\n'),
    });
}

async function raiseRecoveryTodo(c) {
    return tasks.enqueue({
        type: 'claim_recovery',
        target_kind: 'manager',
        target_name: 'Apsara',
        bkg_no: c.container_no || c.invoice_no || '',
        created_by: 'claims',
        claim_id: c.id,
        fire_at: Date.now() + 24 * 3600000,
        message: [
            'Recovery not yet raised on a verified shortage claim.',
            '',
            `${c.customer || 'customer'} · ${c.invoice_no || '—'} · ${c.container_no || '—'}`,
            c.claim_amount != null ? `Claim against Edge: ${money(c.claim_amount)}.` : '',
            `Supplier: ${c.supplier || 'not named'}.`,
            '',
            'Raise it before the next payment to that supplier goes out — a recovery nobody raised is the cost Edge ends up absorbing.',
        ].filter(Boolean).join('\n'),
    });
}

// Called by helpers/claims routes when a claim moves on, so a to-do does not
// keep nagging about work that is done.
async function closeTodos(container_no, type) {
    try { await tasks.cancelMatching({ type, bkg_no: container_no }); }
    catch (e) { console.warn('[CLAIM] could not cancel', type, e.message); }
}

// ── THE HOOK ────────────────────────────────────────────────────────────────
// Returns a small verdict object for tests and logs. It never throws — the
// caller is replyWatch's per-message loop and must not be disturbed.
async function consider({ messageId, threadId, from, subject, body, mailbox, dryRun = false } = {}) {
    try {
        if (!messageId) return { skipped: 'no message id' };
        const g = gate({ subject, body, from });
        if (!g.hit) return { skipped: 'gate', why: g.why };

        if (!dryRun && processed()[messageId]) return { skipped: 'already processed' };

        const got = await extract({ from, subject, body });
        if (!got) {
            if (!dryRun) await markProcessed(messageId, 'not a claim');
            return { skipped: 'not a claim after extraction' };
        }

        const f = got.fields;
        const existing = claims.findByKey(f.invoice_no, f.container_no);
        const mail = { message_id: messageId, thread_id: threadId || '', from: from || '', subject: subject || '', date: new Date().toISOString(), mailbox: mailbox || '' };

        if (dryRun) {
            return { dryRun: true, would: existing ? 'update' : 'create', fields: f, quotes: got.quotes, claim_id: existing ? existing.id : null };
        }

        let rec, changed = false, isNew = false;
        if (existing) {
            const r = await claims.addMail(existing.id, mail, { claimed_weight: f.claimed_weight });
            changed = r.changed;
            // Fill only what was blank. A figure a person has confirmed is
            // never overwritten by a later mail.
            const fill = {};
            for (const k of ['customer', 'supplier', 'invoice_no', 'container_no']) {
                if (!String(existing[k] || '').trim() && f[k]) fill[k] = f[k];
            }
            for (const k of ['invoice_weight', 'claimed_weight', 'weight_unit', 'stated_claim_amount']) {
                if ((existing[k] === null || existing[k] === undefined) && f[k] !== null) fill[k] = f[k];
            }
            if (Object.keys(fill).length) {
                fill.quotes = { ...(existing.quotes || {}), ...got.quotes };
                rec = await claims.update(existing.id, fill, 'claims', 'filled blanks from a later mail');
            } else rec = claims.get(existing.id);
        } else {
            isNew = true;
            rec = await claims.create({
                ...f,
                quotes: got.quotes,
                mail: [mail],
                note: got.reason || '',
                flags: g.containers.length && !f.container_no ? [claims.FLAG_UNKNOWN_CONTAINER] : [],
            }, 'claims/email');
            await raiseVerifyTodo(rec);
        }

        await markProcessed(messageId, isNew ? `created ${rec.id}` : `updated ${rec.id}`);
        if (isNew || changed) {
            try { await _sendToTeam(notifyText(rec, { isNew, changed })); }
            catch (e) { console.warn('[CLAIM] team notify failed:', e.message); }
        }
        return { claim_id: rec.id, created: isNew, changed, confidence: got.confidence };
    } catch (e) {
        console.error('[CLAIM] consider failed:', e.message);
        return { error: e.message };
    }
}

module.exports = { init, consider, notifyText, raiseVerifyTodo, raiseRecoveryTodo, closeTodos, processed, markProcessed, CHASE_HOURS };
