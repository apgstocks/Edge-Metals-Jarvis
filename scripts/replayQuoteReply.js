// ── scripts/replayQuoteReply.js — one-off recovery for a missed reply ───────
// Built 2026-08-05 for a real live incident: classifyQuoteReply's original
// price regex missed "1250$" (dollar sign trailing the number, a very
// common way to text a price) — a real trucker reply that was already sent
// and received before the fix shipped, so it never got recorded and the
// reminder chain kept firing "any price yet?" at him after he'd already
// answered. Once the regex fix (helpers/quoteRequests.js) is deployed, run
// this ONCE to feed that exact same reply back through the now-correct
// classifier — records the price, cancels the pending reminder/escalation
// tasks, and closes the leg exactly as if it had been caught live. Reuses
// workflow/quoteRequests.js's handleIncomingReply — the SAME function the
// live WhatsApp path calls — rather than duplicating that logic here.
//
// Safe to run again: recordLegReply just overwrites the leg's price/status
// with the same values, and cancelling an already-cancelled task is a no-op.
//
//   node scripts/replayQuoteReply.js "<trucker name>" "<reply text>"
//   node scripts/replayQuoteReply.js "<trucker name>" "<reply text>" <requestId>
//
// requestId is optional — only needed if that trucker has more than one
// still-open ("awaiting_reply") leg across different requests right now.

const qr = require('../helpers/quoteRequests');
const quoteFlow = require('../workflow/quoteRequests');

async function main() {
    const [, , truckerName, replyText, requestIdArg] = process.argv;
    if (!truckerName || !replyText) {
        console.error('Usage: node scripts/replayQuoteReply.js "<trucker name>" "<reply text>" [requestId]');
        process.exit(1);
    }

    const requests = qr.loadQuoteRequests().filter((r) =>
        r.legs.some((l) => l.trucker_name === truckerName && l.status === 'awaiting_reply') &&
        (!requestIdArg || r.id === requestIdArg)
    );

    if (!requests.length) {
        console.error(`No open ("awaiting_reply") leg found for "${truckerName}"${requestIdArg ? ` on request ${requestIdArg}` : ''}.`);
        process.exit(1);
    }
    if (requests.length > 1) {
        console.error(`"${truckerName}" has more than one open leg right now — re-run with a requestId to pick one:`);
        requests.forEach((r) => console.error(`  ${r.id} — ${r.origin_query} -> ${r.destination_query} (asked ${r.created_at})`));
        process.exit(1);
    }

    const request = requests[0];
    const leg = request.legs.find((l) => l.trucker_name === truckerName);
    console.log(`Replaying "${replyText}" for ${truckerName} on ${request.origin_query} -> ${request.destination_query} (chat: ${leg.target})...`);

    const result = await quoteFlow.handleIncomingReply(leg.target, replyText);
    if (!result) {
        console.error('No active leg found for that chat — nothing changed (may already be resolved).');
        process.exit(1);
    }
    console.log(`Classified as: ${JSON.stringify(result.classification)}`);
    console.log(`Leg status now: ${result.leg.status}`);
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
