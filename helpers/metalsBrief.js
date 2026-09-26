// ── helpers/metalsBrief.js — "Jarvis, brief me" ─────────────────────────────
//
// Apsara, 2026-09-20: "add other features to jarvis voice ... Make it complete
// ai assistant mimicing jarvis from ironman" → morning briefing first, with
// two rules of hers:
//   · "when i say urgent cutoff - it can just say ... like 4 bookings has cut
//     off today" — SPEAK a count, SHOW the list.
//   · "yard has no scope in jarvis only scout has" — this is EDGE METALS
//     ONLY. Nothing from loads, yard payments, petty cash, stock or outbound
//     loads may appear here; Scout owns those.
//
// Everything is read from local stores — no Gmail call, no Sheets call, no
// model call — so a briefing answers in well under a second and cannot fail
// because an outside service is slow. The price is that "emails waiting" is
// what the last reply-watch scan found, which it says ("as of the last check").

const cfg = require('../config');
const { loadBookings, loadWorkflow, loadJson } = require('./json');
const { daysUntil } = require('./time');

const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

function cutoffBuckets(now) {
    const bookings = Object.values(loadBookings() || {});
    const wf = loadWorkflow() || {};
    let terminal = () => false;
    try {
        const { allContainersTerminal } = require('./containers');
        terminal = (b) => allContainersTerminal(b)
            || (!Array.isArray(b.containers) && cfg.TERMINAL_STEPS.includes((wf[b.booking_number] || {}).step));
    } catch (e) { /* no container helper — count everything */ }
    const { hasSupplierAssigned } = require('./booking');
    const out = { today: [], tomorrow: [], soon: [], unassigned: [] };
    for (const b of bookings) {
        if (!b || !b.cutoff_date || terminal(b)) continue;
        const d = daysUntil(b.cutoff_date);
        if (d < 0 || d > cfg.URGENT_CUTOFF_DAYS) continue;
        const bucket = d === 0 ? out.today : d === 1 ? out.tomorrow : out.soon;
        bucket.push({ b, d });
        // Per CONTAINER, not per booking: a booking's supplier lives on its
        // containers (helpers/containers.js), and a booking with one of two
        // boxes covered still needs a supplier. hasSupplierAssigned alone
        // reads only the booking-level field and called all six of the test
        // bookings unassigned — which the test caught.
        let missing;
        try {
            const { nextUnassignedContainer } = require('./containers');
            missing = Array.isArray(b.containers) && b.containers.length
                ? !!nextUnassignedContainer(b, 'supplier')
                : !hasSupplierAssigned(b, wf[b.booking_number]);
        } catch (e) { missing = !hasSupplierAssigned(b, wf[b.booking_number]); }
        if (missing) out.unassigned.push({ b, d });
    }
    const byDate = (x, y) => x.d - y.d;
    out.today.sort(byDate); out.tomorrow.sort(byDate); out.soon.sort(byDate);
    return out;
}

// Same predicate as scheduler.js's morningDigest "STUCK (48h+ no movement)",
// so the spoken brief and the WhatsApp digest can never disagree about it.
function stuckBookings(now = Date.now()) {
    const bookings = loadBookings() || {};
    const workflow = loadWorkflow() || {};
    let allTerminal = () => false;
    try { allTerminal = require('./containers').allContainersTerminal; } catch (e) { /* none */ }
    return Object.entries(workflow).filter(([no, wf]) => {
        if (!bookings[no] || allTerminal(bookings[no])) return false;
        if (cfg.TERMINAL_STEPS.includes(wf.step) && !Array.isArray(bookings[no].containers)) return false;
        const last = new Date(wf.updated_at || wf.created_at || 0).getTime();
        return now - last > 2 * 86400000;
    }).map(([no, wf]) => ({ no, step: wf.step }));
}

function waitingMail(now = Date.now()) {
    try {
        const { lastDigest, lastDigestAt } = require('../workflow/replyWatch').loadStore() || {};
        const at = Date.parse(lastDigestAt || '');
        if (!Number.isFinite(at) || now - at > 24 * 3600000 || !Array.isArray(lastDigest)) return null;
        return { count: lastDigest.length, at, items: lastDigest };
    } catch (e) { return null; }
}

function recentReceipts(now = Date.now()) {
    try {
        const rows = require('./salesReceipts').list() || [];
        const recent = rows.filter((r) => now - Date.parse(r.created_at || 0) < 24 * 3600000);
        return { count: recent.length, total: recent.reduce((s, r) => s + (Number(r.amount) || 0), 0), rows: recent };
    } catch (e) { return { count: 0, total: 0, rows: [] }; }
}

function dueToday(now = new Date()) {
    try {
        const end = new Date(now); end.setHours(23, 59, 59, 999);
        const tasks = loadJson(cfg.TASKS_FILE, []) || [];
        // Claim to-dos are excluded on purpose. Apsara, 2026-09-26, asked for
        // the claims feature and for the brief to keep saying exactly what it
        // says today; claim_verify / claim_recovery are manager-targeted, so
        // without this line every claim would start appearing in the spoken
        // brief. They live on /claims and in the team WhatsApp instead.
        return tasks.filter((t) => t && t.status === 'pending' && t.target_kind === 'manager'
            && !String(t.type || '').startsWith('claim_')
            && new Date(t.fire_at) <= end);
    } catch (e) { return []; }
}

const money = (n) => '$' + Math.round(n).toLocaleString('en-US');

// ── "urgent cutoffs" — the short answer ───────────────────────────────────
function cutoffSentence(c) {
    const parts = [];
    if (c.today.length) parts.push(`${plural(c.today.length, 'booking')} ${c.today.length === 1 ? 'cuts' : 'cut'} off today`);
    if (c.tomorrow.length) parts.push(`${c.tomorrow.length} tomorrow`);
    if (c.soon.length) parts.push(`${c.soon.length} in the next ${cfg.URGENT_CUTOFF_DAYS} days`);
    if (!parts.length) return `No cutoffs in the next ${cfg.URGENT_CUTOFF_DAYS} days.`;
    let s = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
    if (!c.today.length) s = plural(c.tomorrow.length + c.soon.length, 'booking') + ' cutting off soon: ' + s;
    s = s.charAt(0).toUpperCase() + s.slice(1) + '.';
    if (c.unassigned.length) s += ` ${c.unassigned.length} of them ${c.unassigned.length === 1 ? 'has' : 'have'} no supplier yet.`;
    return s;
}

function urgentCutoffs() {
    const c = cutoffBuckets();
    const rows = [...c.today, ...c.tomorrow, ...c.soon];
    const when = (d) => d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`;
    const screen = rows.length
        ? [cutoffSentence(c), '', ...rows.map(({ b, d }) => `${b.booking_number} — cutoff ${b.cutoff_date} (${when(d)})`)].join('\n')
        : cutoffSentence(c);
    return { spoken: cutoffSentence(c), screen, count: rows.length };
}

// ── the briefing ──────────────────────────────────────────────────────────
function build(opts = {}) {
    const now = opts.now || Date.now();
    const c = cutoffBuckets(now);
    const stuck = stuckBookings(now);
    const mail = waitingMail(now);
    const cash = recentReceipts(now);
    const tasks = dueToday(new Date(now));

    const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false,
        timeZone: 'Asia/Kolkata' }).format(new Date(now))) % 24;
    const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

    const said = [`${greet}. Here's Edge Metals.`, cutoffSentence(c)];
    if (stuck.length) said.push(`${plural(stuck.length, 'booking')} ${stuck.length === 1 ? 'hasn\'t' : 'haven\'t'} moved in two days.`);
    if (mail) said.push(mail.count ? `${plural(mail.count, 'email')} ${mail.count === 1 ? 'needs' : 'need'} your reply.` : 'No emails waiting on you.');
    if (cash.count) said.push(`${plural(cash.count, 'payment')} came in since yesterday — ${money(cash.total)}.`);
    if (tasks.length) said.push(`${plural(tasks.length, 'reminder')} due today.`);
    const quiet = !c.today.length && !c.tomorrow.length && !c.soon.length && !stuck.length
        && !(mail && mail.count) && !cash.count && !tasks.length;
    if (quiet) said.push('Nothing needs you right now.');
    else if (mail && mail.count) said.push('Say "what needs my reply" for the emails.');

    const screen = [`${greet} — Edge Metals briefing`, ''];
    const when = (d) => d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`;
    const cuts = [...c.today, ...c.tomorrow, ...c.soon];
    screen.push(cuts.length ? 'CUTOFFS' : `No cutoffs in the next ${cfg.URGENT_CUTOFF_DAYS} days.`);
    for (const { b, d } of cuts) {
        const flag = c.unassigned.some((u) => u.b === b) ? ' — no supplier' : '';
        screen.push(`• ${b.booking_number} — ${b.cutoff_date} (${when(d)})${flag}`);
    }
    if (stuck.length) {
        screen.push('', 'NOT MOVED IN 48h');
        for (const s of stuck) screen.push(`• ${s.no} — ${s.step || 'no step'}`);
    }
    if (mail) {
        screen.push('', mail.count ? `EMAILS WAITING ON YOU (as of the last check)` : 'No emails waiting on you (as of the last check).');
        mail.items.forEach((it, i) => screen.push(`${i + 1}. ${it.fromName || it.from || 'Unknown'} — ${it.subject || ''}`));
    }
    if (cash.count) {
        screen.push('', 'PAYMENTS IN (24h)');
        for (const r of cash.rows) screen.push(`• ${money(Number(r.amount) || 0)} from ${r.customer} (${r.mode})`);
    }
    if (tasks.length) {
        screen.push('', 'REMINDERS TODAY');
        for (const t of tasks) screen.push(`• ${String(t.message || '').slice(0, 80)}`);
    }
    return { spoken: said.join(' '), screen: screen.join('\n').trim(), parts: { cutoffs: c, stuck, mail, cash, tasks } };
}

module.exports = { build, urgentCutoffs, cutoffSentence, stuckBookings, cutoffBuckets };
