// ── helpers/aiCostWatch.js — tell her when the AI bill is running hot ───────
// Apsara, 2026-10-12: "constantly monitoring cost so that I can keep track."
//
// Runs hourly from scheduler.js. Two reasons to speak, both once per Pacific
// day so a runaway job cannot also flood her inbox:
//   · today's estimated spend passed the daily limit;
//   · today is a spike — at least 3x the average of the previous 7 days AND at
//     least $1, so a quiet week followed by a normal day does not alarm.
//
// THE LIMIT: setting `ai_daily_limit_usd` (Settings), else env
// AI_DAILY_LIMIT_USD, else $5. The $5 is the builder's starting guess, not
// hers — change it.
//
// HONESTY ABOUT THE FIGURE: spend is estimated from token counts and a price
// table (see helpers/aiUsage.js). The email says "estimated" when any rate is
// an estimate, and lists models with no price at all, whose cost is NOT in the
// total — an unpriced model is a gap in the number, and the email says so.
//
// NEVER THROWS: a watcher that crashes at 3am is one more thing to alert on.

const aiUsage = require('./aiUsage');

const SPIKE_FACTOR = 3, SPIKE_FLOOR_USD = 1;

function limitUsd() {
    try {
        const v = Number(require('./json').loadSettings().ai_daily_limit_usd);
        if (Number.isFinite(v) && v > 0) return v;
    } catch (e) { /* fall through */ }
    const env = Number(process.env.AI_DAILY_LIMIT_USD);
    return Number.isFinite(env) && env > 0 ? env : 5;
}

// Pure: what should be said, given a summary. null = stay quiet.
function decide(s, limit = limitUsd()) {
    const today = s.todayUsd || 0;
    const prior = Object.entries(s.byDay).filter(([d]) => d !== s.today).map(([, b]) => b.usd);
    const avg = prior.length ? prior.reduce((a, b) => a + b, 0) / Math.max(prior.length, 1) : 0;
    const reasons = [];
    if (today >= limit) reasons.push(`over the daily limit of $${limit}`);
    if (prior.length >= 3 && today >= SPIKE_FLOOR_USD && today >= SPIKE_FACTOR * avg) {
        reasons.push(`${Math.round((today / (avg || 1)) * 10) / 10}x the recent daily average ($${Math.round(avg * 100) / 100})`);
    }
    return reasons.length ? { reasons, today, avg, limit } : null;
}

function bodyText(s, d) {
    const top = Object.entries(s.byCaller).sort((a, b) => b[1].usd - a[1].usd).slice(0, 6);
    const L = [`Today's estimated AI spend is $${d.today.toFixed(2)} — ${d.reasons.join(' and ')}.`, ''];
    L.push('Biggest users in the last 7 days:');
    for (const [k, b] of top) L.push(`  ${k}: $${b.usd.toFixed(2)} (${b.calls} calls${b.failed ? `, ${b.failed} failed` : ''})`);
    if (s.estimated) L.push('', 'These figures use estimated rates. Put the real ones in data/ai-prices.json to firm them up.');
    if (s.unpriced.length) L.push('', `No price set for: ${s.unpriced.join(', ')} — their cost is NOT in the total above.`);
    L.push('', 'See the AI usage page for the full breakdown.');
    return L.join('\n');
}

async function check({ now = Date.now(), send = null } = {}) {
    try {
        const s = aiUsage.summarise({ days: 8, now });
        const d = decide(s);
        if (!d) return { alerted: false, today: s.todayUsd };
        const json = require('./json');
        const settings = json.loadSettings();
        if (settings.ai_cost_alerted_day === s.today) return { alerted: false, today: s.todayUsd, already: true };
        const mail = send || ((m) => require('./gmail').sendEmail(m));
        await mail({ to: process.env.AI_COST_ALERT_TO || process.env.SHEET_SYNC_TO || 'apg0596@gmail.com',
            subject: `AI spend alert — $${d.today.toFixed(2)} today (estimated)`, body: bodyText(s, d) });
        // saveSettings is async and rewrites the WHOLE file from a stale copy; set only our
        // own key, under the lock, and wait for it, or a second check re-sends the email.
        await json.mutateJson(require('../config').SETTINGS_FILE, {}, (st) => { st.ai_cost_alerted_day = s.today; });
        return { alerted: true, today: s.todayUsd, reasons: d.reasons };
    } catch (e) {
        console.error('[AI-COST] watch failed (non-fatal):', e.message);
        return { alerted: false, error: e.message };
    }
}

module.exports = { check, decide, limitUsd, bodyText };
