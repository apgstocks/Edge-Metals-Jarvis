// ── tests/summary-quality.js ────────────────────────────────────────────────
// Apsara, 2026-08-27: "bullshit." Fair. Six times this week I have said the
// summary is fixed, every time on my own reading of prompt wording, and every
// time she has come back with a live digest showing it is not.
//
// The missing thing was never a better prompt. It was a RULER. She has now
// given me one: Gemini-in-Gmail's own summaries of the same threads, which is
// exactly the standard she is holding this to.
//
// So the reference summaries below are HER OWN, pasted verbatim. Each fixture
// lists the facts that summary carries. A Jarvis summary is scored on how many
// of those facts survive — not on whether it matches the wording, which would
// be both impossible and pointless.
//
//   node tests/summary-quality.js            # scorer self-check, no network
//   node tests/summary-quality.js --live     # calls Gemini with the real prompt
//
// The --live mode needs GEMINI_API_KEY and so only runs on the VM or her Mac.
// Without it this still runs in CI and pins the scorer itself, because a
// broken ruler is worse than no ruler.
const path = require('path');
const R = (p) => path.join(__dirname, '..', p);

let pass = 0, fail = 0;
const failures = [];
const ck = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};
const section = (t) => console.log(`\n=== ${t} ===`);

// ── THE FIXTURES ───────────────────────────────────────────────────────────
// `reference` is Apsara's pasted Gmail summary — the target.
// `jarvis_was` is what Jarvis actually produced for the same thread.
// `facts` are what a correct summary must carry, as matchers.
const FIXTURES = [
    {
        id: 'lc-calculations',
        reference: 'Accounting requested confirmation of LC calculations totaling $111,447.60 before submission scheduled for August 28, 2026.',
        jarvis_was: 'tomorrow tomorrow — confirmation of calculations',
        facts: [
            { name: 'the total',        re: /111[,.]?447[.,]60/ },
            { name: 'the date',         re: /aug(ust)?\s*28|8\/28/i },
            { name: 'who asked',        re: /accounting/i },
            { name: 'what is wanted',   re: /confirm|check|verify|approve|sign/i },
            { name: 'that it is an LC', re: /\bLC\b|letter of credit/i },
        ],
        // Reading the total needs the attachment; see collectAttachmentNames.
        needsAttachmentText: true,
    },
    {
        id: 'jy70-price',
        reference: 'Jinho requested unit price adjustment for JY70 to $995 and advised against combining JY71 combos.',
        jarvis_was: 'Sender wants confirmation of unit price adjustment for JY70.',
        facts: [
            { name: 'who asked',            re: /jinho|hynos/i },
            { name: 'the lot',              re: /JY\s?70/i },
            { name: 'the price',            re: /\$?\s?995/ },
            { name: 'THE SECOND ASK',       re: /combin|combo|JY\s?71/i },
            { name: 'that it is a request', re: /request|ask|want|propos|counter|adjust/i },
        ],
    },
    {
        id: 'jy71-agreed',
        reference: 'Accounting agreed to $995 price and to combine JY71 combos.',
        jarvis_was: 'Accounting Edge will go with $995 and combine combos for 26JY71.',
        facts: [
            { name: 'who agreed',     re: /accounting/i },
            { name: 'the price',      re: /\$?\s?995/ },
            { name: 'the lot',        re: /JY\s?71/i },
            { name: 'the decision',   re: /agree|accept|go with|confirm|ok/i },
            { name: 'the combining',  re: /combin|combo/i },
        ],
    },
];

// A summary is scored on facts carried, and separately on the failure modes
// that produced every complaint this week.
function score(summary, fx) {
    const t = String(summary || '');
    const carried = fx.facts.filter((f) => f.re.test(t));
    return {
        carried: carried.map((f) => f.name),
        missing: fx.facts.filter((f) => !f.re.test(t)).map((f) => f.name),
        ratio: carried.length / fx.facts.length,
        // The category-not-content failure.
        categoryOpener: /^(the\s+)?sender\b/i.test(t.trim()),
        // A relative word that stops being true tomorrow.
        relativeDate: /\b(tomorrow|today|tonight|asap|eod|next week)\b/i.test(t),
        words: t.trim().split(/\s+/).filter(Boolean).length,
    };
}

(async () => {
section('The ruler itself — Apsara\'s Gmail summaries must score 100%');
for (const fx of FIXTURES) {
    const s = score(fx.reference, fx);
    ck(`[${fx.id}] the reference carries every fact it is credited with`,
        s.ratio === 1, `missing: ${s.missing.join(', ')}`);
    ck(`[${fx.id}] and trips none of the failure detectors`,
        !s.categoryOpener && !s.relativeDate, JSON.stringify(s));
}

section('What Jarvis actually produced, scored against the same ruler');
for (const fx of FIXTURES) {
    const s = score(fx.jarvis_was, fx);
    console.log(`  [${fx.id}] ${Math.round(s.ratio * 100)}%  "${fx.jarvis_was}"`);
    if (s.missing.length) console.log(`            dropped: ${s.missing.join(', ')}`);
    if (s.categoryOpener) console.log('            FAILURE: opens with "Sender" — describes the kind of email, not what it says');
    if (s.relativeDate) console.log('            FAILURE: a relative date that stops being true tomorrow');
}
// These are recorded as the BASELINE, not asserted — they are known-bad, and
// the point of the file is that the next run has a number to beat.
const baseline = FIXTURES.map((fx) => score(fx.jarvis_was, fx).ratio);
const avg = baseline.reduce((a, b) => a + b, 0) / baseline.length;
console.log(`\n  BASELINE (2026-08-27, live output): ${Math.round(avg * 100)}% of facts carried`);

section('The scorer catches the failures it exists to catch');
{
    ck('a category opener is detected', score('Sender wants confirmation of the ERD.', FIXTURES[1]).categoryOpener);
    ck('a good summary is not', !score('Jinho wants JY70 at $995 and advises against combining JY71.', FIXTURES[1]).categoryOpener);
    ck('a relative date is detected', score('confirmation needed tomorrow', FIXTURES[0]).relativeDate);
    ck('an absolute one is not', !score('confirmation needed by August 28', FIXTURES[0]).relativeDate);
    const half = score('Jinho requested unit price adjustment for JY70 to $995.', FIXTURES[1]);
    ck('DROPPING THE SECOND ASK is caught — the failure that started this',
        half.missing.includes('THE SECOND ASK'), JSON.stringify(half.missing));
    const full = score('Jinho wants JY70 at $995 and advises against combining the JY71 combos.', FIXTURES[1]);
    ck('and a complete one scores 100%', full.ratio === 1, JSON.stringify(full.missing));
}

// ── LIVE MODE ──────────────────────────────────────────────────────────────
if (process.argv.includes('--live')) {
    section('LIVE — the real prompt, the real model');
    const rw = require(R('workflow/replyWatch.js'));
    if (!require(R('config.js')).GEMINI_API_KEY) {
        console.log('  SKIP — no GEMINI_API_KEY. Run this on the VM.');
    } else {
        for (const fx of FIXTURES) {
            if (!fx.body) { console.log(`  SKIP [${fx.id}] — no source body captured yet (see the note at the bottom of this file)`); continue; }
            const a = await rw.assess({ from: fx.from, subject: fx.subject, date: fx.date, body: fx.body, thread: fx.thread, attachments: fx.attachments });
            const s = score(a && a.summary, fx);
            console.log(`  [${fx.id}] ${Math.round(s.ratio * 100)}%  "${a && a.summary}"`);
            ck(`[${fx.id}] carries at least 4 of 5 facts`, s.ratio >= 0.8, `missing: ${s.missing.join(', ')}`);
            ck(`[${fx.id}] no category opener`, !s.categoryOpener);
        }
    }
}

console.log(`\n${'='.repeat(64)}\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILED:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);

// ── TO MAKE --live MEANINGFUL ──────────────────────────────────────────────
// Each fixture needs `from`, `subject`, `date`, `body` and `thread` captured
// from the real message. On the VM:
//     node -e "require('./workflow/replyWatch').run({dryRun:true,rescan:true}).then(r=>console.log(JSON.stringify(r.items,null,2)))"
// Paste the source of the three threads above into the fixtures. Then this
// file stops being a scorer self-check and becomes a regression test on the
// thing that has actually been failing.
})().catch((e) => { console.error('HARNESS CRASHED:', e); process.exit(1); });
