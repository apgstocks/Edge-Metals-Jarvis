// ── workflow/paymentWatcher.js — automatic payment detection from Gmail ─────
// Built 2026-08-22. Apsara, on the new receivables ledger: "how would they
// know that i received payment against that" — and she's right that having to
// type every payment in by hand is just moved data entry, not automation.
// This watches the mailbox for the notifications that already arrive when
// money lands (bank/wire alerts, customer remittance advice) and matches them
// to open invoices.
//
// Modelled directly on workflow/emailWatcher.js — same poll/dedupe/in-memory
// lock shape, same `processed` id set, so the two behave consistently and
// anyone who understands one understands the other.
//
// ── THE ONE RULE: never credit money without her say-so ─────────────────────
// emailWatcher writes bookings straight through with an after-the-fact notice,
// which is right for logistics data: a wrong cutoff date is visible and
// fixable. Money is not that. A wrongly-credited payment is SILENT — the
// invoice just stops appearing in "who owes me", so she stops chasing a
// customer who never paid, and finds out weeks later. A missed payment is
// merely annoying; a phantom one costs real money.
//
// So this NEVER writes to the ledger. It proposes, with the evidence
// (who the mail was from, subject, amount, which invoice, why it matched),
// and she replies yes/no. Confirmed → recorded. Declined → remembered as
// declined so it isn't re-proposed on the next poll.
//
// It is also deliberately CONSERVATIVE about matching. A proposal is only
// raised when there's a defensible reason to link that money to that invoice:
// an invoice number appearing in the mail, or an amount that exactly matches
// exactly one open invoice. Anything vaguer is reported as "money arrived, I
// don't know against what" rather than guessed at — unapplied cash she knows
// about beats a confident wrong answer.

const cfg = require('../config');
const { loadJson, saveJson } = require('../helpers/json');
const { getGmailRead, listMessages, getMessage, getEmailContent } = require('../helpers/gmail');
const { callGeminiJSON } = require('../helpers/gemini');
const receivables = require('../helpers/receivables');

const AGENT = 'PAY-WATCH';
const PROCESSED_FILE = cfg.PAYMENT_EMAILS_PROCESSED_FILE
    || require('path').join(cfg.DATA_DIR, 'payment_emails_processed.json');

let _sendToManager = async () => {};
let _setPending = null;
let _running = false;

function init({ sendToManager, setPending }) {
    if (sendToManager) _sendToManager = sendToManager;
    if (setPending) _setPending = setPending;
}

function loadProcessed() { return new Set(loadJson(PROCESSED_FILE, [])); }
async function saveProcessed(set) { await saveJson(PROCESSED_FILE, [...set]); }

// Deliberately broad on the search, strict on the classification below.
// Gmail's query language can't tell a real payment notice from an invoice
// Apsara herself sent, so the cheap filter runs here and the real judgement
// runs in Gemini — same split emailWatcher uses (broad query, then
// classifyDocument).
function buildQuery() {
    const after = new Date(Date.now() - (cfg.GMAIL_POLL_DAYS_BACK || 7) * 86400000);
    const afterStr = `${after.getFullYear()}/${after.getMonth() + 1}/${after.getDate()}`;
    return `after:${afterStr} (` + [
        'payment', 'remittance', 'wire', 'transfer', 'paid', 'funds',
        '"payment advice"', '"payment confirmation"', '"credit advice"',
        '"telegraphic transfer"', '"proof of payment"',
    ].join(' OR ') + ')';
}

const CLASSIFY_PROMPT = (from, subject, body) => `You are reading ONE email from a scrap-metal exporter's mailbox, deciding whether it reports that MONEY HAS ARRIVED in their account.

FROM: ${from}
SUBJECT: ${subject}
BODY (truncated):
${String(body || '').slice(0, 4000)}

Return ONLY this JSON:
{
  "is_payment_received": true/false,
  "amount": null or a number (no currency symbol, no thousands separators),
  "currency": null or "USD"/"EUR"/etc,
  "invoice_refs": [],
  "payer": null or the name of who sent the money,
  "paid_on": null or "YYYY-MM-DD",
  "method": null or "wire"/"check"/"ach"/"cash",
  "reasoning": "one sentence"
}

RULES — read carefully, a wrong "true" causes a real accounting error:
- "is_payment_received" is TRUE only when the email says money HAS BEEN RECEIVED/CREDITED to them, or a customer states they HAVE SENT/REMITTED payment. A bank credit alert, a remittance advice, a wire confirmation, "we have released payment for invoice X" all qualify.
- It is FALSE for: an invoice or proforma they SENT (money owed TO them, not received), a payment REQUEST or reminder, a quote, a statement of account, a debit/outgoing payment, marketing, or anything where money is only proposed or requested. When unsure, answer FALSE — a missed payment is recoverable, an invented one is not.
- "invoice_refs": every invoice/reference number that appears anywhere in the email, verbatim, as an array of strings. These are often written loosely (e.g. "26JY52", "260819_AC_26JY52", "INV 26JY52"). Include them all; do not normalise, expand or guess. Empty array if none appear.
- "amount": the amount RECEIVED. If several appear, use the one identified as the payment/credit total, not a line item or a balance. Null if genuinely unclear — do not guess a number.`;

async function classifyEmail(from, subject, body) {
    const out = await callGeminiJSON(CLASSIFY_PROMPT(from, subject, body));
    if (!out || typeof out !== 'object') return null;
    return out;
}

// A reference lifted from an email is rarely a clean invoice number — real
// remittances say "INV 26JY40", "Invoice #260819_AC_26JY52", "ref: 26jy52".
// This turns one raw reference into the keys worth trying, most specific
// first: the whole thing, then each meaningful token with the noise words
// stripped. Found in testing 2026-08-22 — "INV 26JY40" matched nothing at all
// because the leading "inv" made the normalised key a non-substring.
//
// Tokens shorter than 4 characters are dropped: a stray "26" or "AC" would
// substring-match half the ledger, and the uniqueness check below would then
// either reject a good match or, worse, land on the wrong invoice.
const REF_NOISE = new Set(['inv', 'invoice', 'invoices', 'no', 'nos', 'num', 'number', 'ref', 'reference', 'our', 'your', 'bill', 'doc', 'pi', 'ci']);
function refKeys(ref) {
    const raw = String(ref == null ? '' : ref);
    const keys = [];
    const whole = receivables.normaliseInvNo(raw);
    if (whole.length >= 4) keys.push(whole);
    for (const tok of raw.split(/[^A-Za-z0-9]+/)) {
        const t = String(tok || '').toLowerCase();
        if (!t || REF_NOISE.has(t)) continue;
        const k = receivables.normaliseInvNo(t);
        if (k.length >= 4 && !keys.includes(k)) keys.push(k);
    }
    return keys;
}

// Match a detected payment to an open invoice. Returns a match with a stated
// reason, a candidate list, or nothing — never a guess. `reason` is surfaced
// to Apsara verbatim in the proposal so she can judge the match herself
// rather than trusting a bare "matched".
async function matchToInvoice(detected) {
    const { rows } = await receivables.buildLedger({ openOnly: true });
    if (!rows.length) return { none: true, why: 'no open invoices' };

    // 1. An invoice reference in the email is the strongest signal there is.
    for (const ref of (detected.invoice_refs || [])) {
        for (const key of refKeys(ref)) {
            const exact = rows.filter((r) => receivables.normaliseInvNo(r.inv_no) === key);
            if (exact.length === 1) return { invoice: exact[0], reason: `invoice number "${ref}" appears in the email` };
            const partial = rows.filter((r) => receivables.normaliseInvNo(r.inv_no).includes(key));
            if (partial.length === 1) return { invoice: partial[0], reason: `"${ref}" in the email matches invoice ${partial[0].inv_no}` };
            if (partial.length > 1) return { candidates: partial.slice(0, 6), reason: `"${ref}" matches ${partial.length} open invoices` };
        }
    }

    // 2. No reference — fall back to an EXACT amount match, and only when it
    // is unique. Two invoices open for the same amount is exactly the case
    // where a guess sends the credit to the wrong customer.
    const amt = receivables.parseAmount(detected.amount);
    if (amt !== null && amt > 0) {
        const exactAmt = rows.filter((r) => Math.abs(r.balance - amt) < 0.01);
        if (exactAmt.length === 1) return { invoice: exactAmt[0], reason: `amount matches the exact open balance on ${exactAmt[0].inv_no}` };
        if (exactAmt.length > 1) return { candidates: exactAmt.slice(0, 6), reason: `${exactAmt.length} open invoices have exactly this balance` };

        // A payer name plus a plausible amount is worth OFFERING, but only as
        // a candidate list — never auto-selected.
        if (detected.payer) {
            const p = String(detected.payer).toLowerCase();
            const byPayer = rows.filter((r) => String(r.consignee || '').toLowerCase().includes(p)
                                            || String(r.customer || '').toLowerCase().includes(p));
            if (byPayer.length === 1) return { invoice: byPayer[0], reason: `only open invoice for ${byPayer[0].consignee || byPayer[0].customer}`, weak: true };
            if (byPayer.length > 1) return { candidates: byPayer.slice(0, 6), reason: `${byPayer.length} open invoices for ${detected.payer}` };
        }
    }
    return { none: true, why: 'nothing in the email identified an invoice, and the amount matched no single open balance' };
}

function fmtMoney(n) {
    return `$${(Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function _runOnce() {
    let gmail;
    try {
        gmail = getGmailRead();
    } catch (err) {
        console.error(`[${AGENT}] Gmail not configured — skipping poll:`, err.message);
        return;
    }
    const processed = loadProcessed();
    let messages;
    try {
        messages = await listMessages(gmail, buildQuery(), 40);
    } catch (err) {
        console.error(`[${AGENT}] Gmail search failed:`, err.message);
        return;
    }
    const fresh = (messages || []).filter((m) => !processed.has(m.id));
    if (!fresh.length) return;
    console.log(`[${AGENT}] ${fresh.length} candidate email(s)`);

    const proposals = [], unmatched = [];
    for (const m of fresh) {
        try {
            const full = await getMessage(gmail, m.id);
            const headers = (full.payload && full.payload.headers) || [];
            const h = (n) => (headers.find((x) => x.name.toLowerCase() === n) || {}).value || '';
            const from = h('from'), subject = h('subject');
            const body = getEmailContent(full.payload) || full.snippet || '';

            const detected = await classifyEmail(from, subject, body);
            // Mark processed either way — a non-payment email should never be
            // re-examined, and re-running Gemini over the same mailbox every
            // 30 minutes is both slow and expensive.
            processed.add(m.id);
            if (!detected || !detected.is_payment_received) continue;

            const match = await matchToInvoice(detected);
            const evidence = { message_id: m.id, from, subject, detected };
            if (match.invoice) proposals.push({ ...evidence, invoice: match.invoice, reason: match.reason, weak: !!match.weak });
            else unmatched.push({ ...evidence, why: match.why, candidates: match.candidates || [] });
        } catch (err) {
            console.error(`[${AGENT}] failed on message ${m.id}:`, err.message);
        }
    }
    await saveProcessed(processed);
    if (!proposals.length && !unmatched.length) return;

    // ── Report. One message, and a pending ONLY for the clean single case ──
    // Staging a pending per proposal would queue several yes/no questions
    // behind each other (setPending never overwrites — see actions.js), which
    // is exactly the pile-up that caused the cancel-loop bug on 08-20. One
    // proposal → a real yes/no pending. Several → list them and let her
    // record the ones she wants, since each needs its own decision anyway.
    const lines = [];
    for (const p of proposals) {
        const amt = fmtMoney(receivables.parseAmount(p.detected.amount) || 0);
        lines.push(`• ${amt} from ${p.detected.payer || p.from}\n   → ${p.invoice.inv_no} (${p.invoice.consignee || p.invoice.customer}), ${fmtMoney(p.invoice.balance)} open\n   matched because ${p.reason}${p.weak ? ' — weak match, check this one' : ''}\n   email: "${String(p.subject).slice(0, 60)}"`);
    }
    for (const u of unmatched) {
        const amt = receivables.parseAmount(u.detected.amount);
        lines.push(`• ${amt ? fmtMoney(amt) : 'a payment'} from ${u.detected.payer || u.from} — couldn't tell which invoice (${u.why})\n   email: "${String(u.subject).slice(0, 60)}"`);
    }

    if (proposals.length === 1 && !unmatched.length && _setPending) {
        const p = proposals[0];
        const amt = receivables.parseAmount(p.detected.amount) || 0;
        const staged = await _setPending({
            type: 'await_payment_confirm',
            inv_no: p.invoice.inv_no,
            amount: amt,
            paid_on: p.detected.paid_on || null,
            method: p.detected.method || null,
            source_subject: p.subject,
            source_from: p.from,
        });
        const tail = staged && staged.queued
            ? `\n\n(You have a pending "${staged.blockedBy}" to answer first — I'll ask about this once that's clear.)`
            : `\n\nRecord it? (yes/no)`;
        await _sendToManager(`Looks like a payment arrived:\n\n${lines[0]}${tail}`);
        console.log(`[${AGENT}] proposed ${amt} → ${p.invoice.inv_no}`);
        return;
    }

    await _sendToManager(
        `Possible payments in the mailbox:\n\n${lines.join('\n\n')}\n\n` +
        `Nothing has been recorded yet. Tell me e.g. "Taewon paid 45000" or "record 18000 against 26JY52" for the ones you want credited.`
    );
    console.log(`[${AGENT}] reported ${proposals.length} proposal(s), ${unmatched.length} unmatched`);
}

async function run() {
    if (_running) { console.log(`[${AGENT}] previous run still going — skipping this tick`); return; }
    _running = true;
    try { await _runOnce(); } finally { _running = false; }
}

module.exports = { init, run, isRunning: () => _running, matchToInvoice, classifyEmail, buildQuery };
