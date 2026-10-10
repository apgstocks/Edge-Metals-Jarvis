// ── helpers/bookingAgentJob.js — tell her when the carrier disagrees ──────
// Apsara, 2026-10-03: "Build Maersk api integration to Booking Agent."
//
// Runs helpers/bookingAgent.check() and turns disagreements into ONE
// WhatsApp message to the manager. Same discipline as the claims chase:
//
// SILENT WHEN THERE IS NOTHING. "Maersk agrees with everything" every day is
// a message she learns to skip, and then she skips the day it matters.
//
// SAY EACH THING ONCE. The key is the booking, the field and the carrier's
// date. If Maersk moves the date again, that is a new key and a new message;
// the same disagreement is not repeated twice a day.
//
// NO KEY, NO NOISE. Until MAERSK_CONSUMER_KEY is set the job logs and
// returns. A broken key (auth) is different — it is said once a day, because
// that is something only she can fix.
//
// It changes nothing. The message ends by saying so.

const agent = require('./bookingAgent');

const fmtIso = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    return m ? `${m[2]}/${m[3]}/${m[1]}` : String(iso || '');
};
const LABEL = { cutoff: 'Cutoff', erd: 'ERD' };

const keyFor = (f) => `bookingagent:${f.bkgNo}:${f.role}:${f.kind}:${f.carrierDays.join(',')}`;

function messageText(findings) {
    if (!findings || !findings.length) return null;
    const byBooking = new Map();
    for (const f of findings) {
        if (!byBooking.has(f.bkgNo)) byBooking.set(f.bkgNo, []);
        byBooking.get(f.bkgNo).push(f);
    }
    const carrier = findings[0].carrier;
    const n = byBooking.size;
    const L = [`*${carrier} disagrees with ${n} booking${n === 1 ? '' : 's'}*`, ''];
    for (const [bkgNo, list] of byBooking) {
        const head = [bkgNo, list[0].vessel_voyage, list[0].port_of_loading].filter(Boolean).join(' · ');
        L.push(head);
        for (const f of list) {
            const theirs = f.carrierDays.map(fmtIso).join(' or ');
            const names = [...new Set(f.evidence.map(e => e.name))].join(', ');
            const ours = f.kind === 'missing' ? 'we have none' : `we have ${f.ours}`;
            L.push(`  ${LABEL[f.role]}: ${ours}, ${carrier} says ${theirs} (${names})`);
        }
        L.push('');
    }
    L.push('Nothing was changed. Confirm with the forwarder before updating the booking.');
    return L.join('\n');
}

async function run({ send, alreadySent, markSent, deps } = {}) {
    const res = await agent.check(deps);

    if (res.noKey && !res.checked) {
        console.log('[BOOKING-AGENT] MAERSK_CONSUMER_KEY not set — carrier check skipped');
    }

    const today = new Date().toISOString().slice(0, 10);
    if (res.authFailed && alreadySent && !alreadySent(`bookingagent:auth:${today}`)) {
        if (send) await send('*Booking Agent could not log in to Maersk.* The MAERSK_CONSUMER_KEY was refused — check it on developer.maersk.com. No booking was checked against Maersk today.');
        if (markSent) await markSent(`bookingagent:auth:${today}`);
    }

    const fresh = res.findings.filter(f => !(alreadySent && alreadySent(keyFor(f))));
    const text = messageText(fresh);
    if (text && send) {
        await send(text);
        if (markSent) for (const f of fresh) await markSent(keyFor(f));
    }

    console.log(`[BOOKING-AGENT] checked ${res.checked}, agreed ${res.agreed}, `
        + `findings ${res.findings.length} (${fresh.length} new), skipped ${res.skipped.length}`
        + (res.aiDown ? ', model unavailable for part of the run' : ''));
    return Object.assign({}, res, { sent: text ? fresh.length : 0, text });
}

// Same check, nothing sent and nothing marked — for asking "what would it
// say right now?" from a console or a test.
async function preview(deps) {
    const res = await agent.check(deps);
    return Object.assign({}, res, { text: messageText(res.findings) });
}

module.exports = { run, preview, messageText, keyFor };
