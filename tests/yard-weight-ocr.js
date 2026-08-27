// ── tests/yard-weight-ocr.js ────────────────────────────────────────────────
// Covers the 2026-08-27 scanner fix: the yard display's permanently-lit
// leading cells ("8.8.") were being read as real digits, so a true 3475 was
// published as 83475 — in range, plausible, and therefore confident.
//
// The dangerous part of this fix is not the ghost handling, it is everything
// it must NOT do. This yard has TWO displays: the 4-digit Socome indicator
// and the 5-digit weighbridge, whose real confirmed readings (71920, 81460,
// 81528, ~87520) start with the same 8 that the ghost cell produces. Any rule
// that turns "83475" into "3475" is one bad condition away from turning a
// genuine 81460 into 1460 — silently, and unflagged, which is the single
// worst thing this pipeline can do. Most of the assertions below exist to
// pin that down, not to prove the happy path.
//
// Pure functions only: no network, no API keys, no fixtures. The end-to-end
// accuracy number (8/10 on the Socome corpus) is measured separately against
// real photos; this suite guards the decision logic that produced it.
const assert = require('assert');
const visionOcr = require('../helpers/visionOcr');

let pass = 0, fail = 0;
const failures = [];
function ck(name, cond) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; failures.push(name); console.log('  FAIL  ' + name); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

// Mirrors the corroboration rule in the scanner gate in helpers/gemini.js.
// Restated here rather than imported because importing gemini.js pulls in the
// whole model client; if the two ever drift, the end-to-end corpus run is the
// tie-breaker.
function gateAccepts(visionResult, geminiWeight) {
    if (visionResult.weight != null && geminiWeight != null && visionResult.weight === geminiWeight) {
        return { accepted: geminiWeight, reason: 'exact agreement' };
    }
    // Note the viaLeadingStrip condition — it is the load-bearing part.
    if (visionResult.viaLeadingStrip && visionResult.weight != null && geminiWeight != null && visionResult.weight !== geminiWeight) {
        const c = (visionResult.candidates || []).find((x) => x.ghostLike && x.value === geminiWeight);
        if (c) return { accepted: geminiWeight, reason: `ghost prefix "${c.prefix}"` };
    }
    return { accepted: null, reason: 'flagged for review' };
}

section('the ghost cases that were being published wrong');
{
    // Vision's actual raw text on these two photos, with the true weights.
    const r = visionOcr.extractWeightNumberFromCrop('883475');
    ck('883475 alone still resolves to the in-range 83475 (Vision cannot tell on its own)', r && r.weight === 83475);
    ck('...but reports 3475 as a ghost-strip candidate', !!(r.candidates || []).find((c) => c.value === 3475));
    ck('...and marks the "88" prefix as ghost-like', !!(r.candidates || []).find((c) => c.value === 3475 && c.ghostLike));
    ck('gate accepts 3475 once Gemini corroborates it', gateAccepts(r, 3475).accepted === 3475);

    const r2 = visionOcr.extractWeightNumberFromCrop('983939');
    ck('983939 offers 3939 as a ghost-like candidate', !!(r2.candidates || []).find((c) => c.value === 3939 && c.ghostLike));
    ck('gate accepts 3939 once Gemini corroborates it', gateAccepts(r2, 3939).accepted === 3939);

    const r3 = visionOcr.extractWeightNumberFromCrop('8.3599');
    ck('8.3599 resolves to 3599 by the existing strip', r3 && r3.weight === 3599);
}

section('the 5-digit weighbridge must not collapse');
{
    // Every one of these is a REAL reading confirmed at this yard.
    for (const real of [71920, 81460, 81528, 87520]) {
        const r = visionOcr.extractWeightNumberFromCrop(String(real));
        ck(`${real} reads as itself`, r && r.weight === real);
        ck(`${real} is NOT silently shortened when Gemini agrees`, gateAccepts(r, real).accepted === real);
        // The nightmare: Gemini misreads and drops the leading digit. The gate
        // may only follow it if it genuinely corroborates — and it must never
        // publish the short number as CLEAN when the two disagree by more than
        // a ghost cell.
        // THE case this fix could have broken. Vision reads the weighbridge
        // correctly and CLEANLY; Gemini drops the leading digit. Because that
        // leading digit is an 8 on three of these four, a naive ghost rule
        // would call it corroboration and publish the short number as
        // confident. It must flag instead — a clean Vision read can only be
        // overturned by exact agreement.
        const shortened = Number(String(real).slice(1));
        ck(`${real} is NOT collapsed to ${shortened} when Gemini drops the leading digit`,
            gateAccepts(r, shortened).accepted === null);
    }
}

section('EXPECTED_WEIGHT_DIGITS is not required, and is not safe to default');
{
    const saved = process.env.EXPECTED_WEIGHT_DIGITS;
    delete process.env.EXPECTED_WEIGHT_DIGITS;
    const r = visionOcr.extractWeightNumberFromCrop('883475');
    ck('ghost candidates are produced with the env var OFF', !!(r.candidates || []).length);
    ck('the fix does not depend on the env var', gateAccepts(r, 3475).accepted === 3475);

    // Demonstrates WHY it is left off: with it set to 4, the rightmost-N rule
    // takes the tail of a genuine 5-digit weighbridge reading.
    process.env.EXPECTED_WEIGHT_DIGITS = '4';
    const bad = visionOcr.extractWeightNumberFromCrop('881460');
    ck('with the env var set to 4, a ghosted 81460 is truncated to 1460 — documented hazard, hence the default is off',
        bad && bad.weight === 1460);
    if (saved === undefined) delete process.env.EXPECTED_WEIGHT_DIGITS;
    else process.env.EXPECTED_WEIGHT_DIGITS = saved;
}

section('a real misread is still flagged, not rescued');
{
    // True 4146, Vision read 4896, Gemini read 886. Neither engine is right
    // and the gate must not manufacture agreement out of them.
    const r = visionOcr.extractWeightNumberFromCrop('4896');
    ck('4896 reads as 4896', r && r.weight === 4896);
    ck('stripping the "4" off 4896 is NOT ghost-eligible', !(r.candidates || []).find((c) => c.value === 896 && c.ghostLike));
    ck('gate flags rather than accepting Gemini\'s 886', gateAccepts(r, 886).accepted === null);
    ck('gate flags rather than accepting a stripped 896', gateAccepts(r, 896).accepted === null);
}

section('the confidence cliff — deterministic ghost removal');
{
    // Real per-symbol confidences measured off the corpus. The rule strips a
    // LEADING symbol only when it is far less certain than the median of what
    // follows, so it needs a cliff, not just a low number.
    const strip = visionOcr.stripGhostByConfidence;

    const a = strip('883475', [0.50, 0.73, 0.97, 0.98, 0.99, 0.98]);
    ck('883475 loses its "88" placeholder', a.text === '3475' && a.stripped === '88');
    const b = strip('983939', [0.35, 0.70, 0.96, 0.99, 0.99, 0.99]);
    ck('983939 loses its "98" placeholder', b.text === '3939' && b.stripped === '98');

    // THE case an absolute threshold gets wrong. 3815's real digits are
    // genuinely mediocre — 0.82 is lower than some ghost cells — but they are
    // FLAT, so there is no cliff and nothing may be removed.
    const c = strip('3815', [0.82, 0.86, 0.93, 0.89]);
    ck('3815 is left alone despite a low leading 0.82 (no cliff)', c.text === '3815' && !c.stripped);

    // The weighbridge. A real leading digit is a real glyph and reads high,
    // so there is no cliff. This is why the rule is safe where a digit-count
    // rule was not.
    for (const [txt, confs] of [['81460', [0.97, 0.98, 0.99, 0.98, 0.97]], ['71920', [0.56, 0.56, 0.58, 0.55, 0.57]]]) {
        const r = strip(txt, confs);
        ck(`${txt} is never shortened (no confidence cliff)`, r.text === txt && !r.stripped);
    }

    // A low leading symbol is not enough on its own — what follows must be
    // crisp, or we are just guessing about a blurry photo.
    const d = strip('48250', [0.50, 0.60, 0.62, 0.58, 0.61]);
    ck('a uniformly unsure read is not stripped', d.text === '48250' && !d.stripped);

    // Never eat a legitimate 3-digit weight (the plausible floor is 200).
    const e = strip('8475', [0.10, 0.99, 0.99, 0.99]);
    ck('stripping stops at 3 digits', e.text === '475');
    const f = strip('475', [0.10, 0.99, 0.99]);
    ck('a 3-digit run is never stripped further', f.text === '475' && !f.stripped);

    // Refuses to strip into an implausible number.
    const g = strip('8100', [0.20, 0.99, 0.99, 0.99]);
    ck('will not strip when the remainder falls under the 200 lb floor', g.text === '8100' && !g.stripped);
}

section('a placeholder can only be a stuck cell, never a real digit');
{
    const strip = visionOcr.stripGhostByConfidence;
    // Found by testing, not by reading: an underexposed frame of the true
    // 3475 dimmed its leading "3" enough to manufacture a textbook cliff, and
    // the rule stripped it and returned 475 at 0.92 confidence. Confident and
    // wrong. A seven-segment cell stuck on cannot display a 3, so the glyph
    // itself is the check.
    const t = strip('3475', [0.35, 0.97, 0.98, 0.97]);
    ck('a real leading "3" is NOT stripped even with a textbook cliff', t.text === '3475' && !t.stripped);
    for (const bad of ['1234', '2475', '4475', '5475', '6475', '7475']) {
        const r = strip(bad, [0.30, 0.98, 0.98, 0.98]);
        ck(`leading "${bad[0]}" is not a placeholder glyph, so ${bad} survives`, r.text === bad && !r.stripped);
    }
    for (const good of ['8475', '9475', '0475']) {
        const r = strip(good, [0.30, 0.98, 0.98, 0.98]);
        ck(`leading "${good[0]}" is a plausible stuck cell, so ${good} is stripped`, r.text === '475');
    }
}

section('burst agreement across frames');
{
    // Mirrors the tally in the scanner gate. Restated rather than imported for
    // the same reason as gateAccepts above.
    function burstWinner(reads) {
        const tally = new Map();
        for (const r of reads.filter((x) => x && x.weight != null)) {
            const cur = tally.get(r.weight) || { n: 0, bestConf: 0 };
            cur.n += 1;
            cur.bestConf = Math.max(cur.bestConf, r.minConf || 0);
            tally.set(r.weight, cur);
        }
        let winner = null;
        for (const [weight, v] of tally) {
            if (v.n < 2) continue;
            if (!winner || v.n > winner.n || (v.n === winner.n && v.bestConf > winner.bestConf)) winner = { weight, n: v.n, bestConf: v.bestConf };
        }
        return winner;
    }
    ck('two frames agreeing wins', (burstWinner([
        { weight: 4146, minConf: 0.60 }, { weight: 4146, minConf: 0.71 }, { weight: 4896, minConf: 0.50 },
    ]) || {}).weight === 4146);
    ck('three different numbers produce no winner', burstWinner([
        { weight: 4146, minConf: 0.6 }, { weight: 4896, minConf: 0.5 }, { weight: 4446, minConf: 0.4 },
    ]) === null);
    ck('a single frame is never a majority', burstWinner([{ weight: 4146, minConf: 0.99 }]) === null);
    ck('a lone high-confidence read cannot outvote a pair', (burstWinner([
        { weight: 4896, minConf: 0.99 }, { weight: 4146, minConf: 0.55 }, { weight: 4146, minConf: 0.58 },
    ]) || {}).weight === 4146);
    ck('a tie is broken by confidence, not arrival order', (burstWinner([
        { weight: 1111, minConf: 0.40 }, { weight: 1111, minConf: 0.41 },
        { weight: 2222, minConf: 0.90 }, { weight: 2222, minConf: 0.91 },
    ]) || {}).weight === 2222);
    ck('null reads are ignored rather than counted', burstWinner([
        { weight: null }, { weight: null }, { weight: 4146, minConf: 0.6 },
    ]) === null);
}

section('trustworthiness decides whether a second opinion is needed');
{
    const pick = visionOcr.extractWeightFromRuns;
    const ghost = pick([{ text: '883475', confs: [0.50, 0.73, 0.97, 0.98, 0.99, 0.98] }]);
    ck('ghost read resolves to 3475', ghost && ghost.weight === 3475);
    ck('...and is trustworthy enough to publish alone', ghost.trustworthy === true);
    ck('...and says what it removed', ghost.strippedGhost === '88');

    // The known bad read. It must NOT be trusted on its own — this is the
    // read that used to be published-but-flagged.
    const bad = pick([{ text: '4896', confs: [0.50, 0.58, 0.69, 0.97] }]);
    ck('the 4896 misread is picked up', bad && bad.weight === 4896);
    ck('...but is NOT trustworthy (0.50)', bad.trustworthy === false);

    const mediocre = pick([{ text: '3815', confs: [0.82, 0.86, 0.93, 0.89] }]);
    ck('a merely-mediocre read is not trusted alone', mediocre.trustworthy === false);
    ck('...but still reports the right number for corroboration', mediocre.weight === 3815);

    // Panel text must not win by being longer, matching the older rule.
    const panel = pick([{ text: '1000001', confs: [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9] }, { text: '80720', confs: [0.97, 0.97, 0.97, 0.97, 0.97] }]);
    ck('an out-of-range capacity rating cannot beat the real reading', panel && panel.weight === 80720);
    ck('no runs at all yields nothing', pick([]) === null);
}

section('the speed fast lane must never fire on a ghost read');
{
    // The fast lane returns in ~450ms by corroborating the plain Vision read
    // against a second RENDERING of the same crop instead of waiting ~1.6s
    // for Gemini. That is only sound where the two renderings fail
    // independently — and on ghost photos they do NOT: measured, greyscale
    // reproduces plain's 83475 on a true 3475. So the lane is closed whenever
    // Vision marked its own read as speculative. If this ever passes with
    // viaLeadingStrip true, the scanner is publishing ghost digits as
    // confident again.
    function fastLaneFires(plain, renders) {
        const second = renders.find((r) => r && plain.weight != null && r.weight === plain.weight) || null;
        return !!(plain.weight != null && !plain.viaLeadingStrip && second && !second.viaLeadingStrip);
    }
    const ghost = visionOcr.extractWeightNumberFromCrop('883475'); // -> 83475, viaLeadingStrip
    ck('ghost read is marked speculative', ghost.viaLeadingStrip === true);
    ck('fast lane does NOT fire even when a rendering repeats the ghost',
        !fastLaneFires(ghost, [{ weight: 83475, viaLeadingStrip: true }]));

    const clean = visionOcr.extractWeightNumberFromCrop('4223');
    ck('fast lane fires on a clean read a rendering confirms',
        fastLaneFires(clean, [{ weight: 4223, viaLeadingStrip: false }]));
    ck('fast lane does NOT fire when no rendering confirms it',
        !fastLaneFires(clean, [{ weight: 6204, viaLeadingStrip: false }, null]));
    ck('a disagreeing rendering cannot veto a confirming one',
        fastLaneFires(clean, [{ weight: 6204, viaLeadingStrip: false }, { weight: 4223, viaLeadingStrip: false }]));

    // The real 4146 case: plain misread 4896, neither rendering agreed.
    const misread = visionOcr.extractWeightNumberFromCrop('4896');
    ck('fast lane does NOT rescue the known 4146 misread',
        !fastLaneFires(misread, [{ weight: 4146, viaLeadingStrip: false }, { weight: 9896, viaLeadingStrip: false }]));

    // A rendering can never introduce a number of its own.
    ck('a rendering alone cannot publish a weight',
        !fastLaneFires({ weight: null, viaLeadingStrip: false }, [{ weight: 4223, viaLeadingStrip: false }]));
}

section('plausibility bounds still hold');
{
    const r = visionOcr.extractWeightNumberFromCrop('100000.1 80720');
    ck('the capacity rating 100000.1 cannot beat the in-range 80720 by being longer', r && r.weight === 80720);
    ck('nothing below the 200 lb floor becomes a candidate',
        !(visionOcr.extractWeightNumberFromCrop('8899').candidates || []).find((c) => c.value < 200));
}

console.log('\n================================================================');
console.log(`${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILED:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
