// ── tests/export-rules.js ─────────────────────────────────────────────────
// Apsara, 2026-10-23/24: Jarvis as the one tool for a US scrap exporter's
// export-import side. "Audit and build everything".
//
// ── THE ONE PROPERTY THIS FILE EXISTS FOR ────────────────────────────────
// `clear` is never reached by accident. Not by a missing rule, not by an
// unverified one, not by an expired one, and not by a destination string whose
// country cannot be worked out. The failure being prevented is a green tick on
// a container that gets rejected at Nhava Sheva — the scrap-trade version of
// the stale "agrees with QuickBooks" badge argued against on the Books page.
//
// So section A is the important one, and it is written as: for every way the
// register can be incomplete, assert NOT clear. A check that only tests the
// happy path would pass while the module shipped a default yes.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-xr-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against real data');
    process.exit(1);
}
if (!String(cfg.EXPORT_RULES_FILE).startsWith(TMP)) {
    console.error('  ABORT  EXPORT_RULES_FILE is not in the temp dir — refusing to write her register');
    process.exit(1);
}

const X = require(path.join(ROOT, 'helpers/exportRules'));

// A rule good enough to act on, so each test can spoil exactly one thing.
// Built fresh per call: a shared object that one section mutates is how two
// later sections get a false green.
const ok = (over = {}) => ({
    id: 'T1', country: 'IN', requirement: 'needs a certificate',
    outcome: 'required', applies_when: {},
    source_ref: 'TEST', source_url: 'https://example.test/rule',
    verified_on: '2026-10-01', verified_by: 'Her broker',
    expires_on: '2027-04-01', disputed: false,
    ...over,
});
const AS_OF = '2026-10-24';
const run = (ship, rows) => X.check({ origin_country: 'US', asOf: AS_OF, rows, ...ship });

// ─────────────────────────────────────────────────────────────────────────
section('A. clear is never reached by accident');
{
    // The control: a genuinely allowed, verified, in-date rule. If this is not
    // clear, every NOT-clear assertion below is vacuous.
    ck('a verified, in-date, allowing rule IS clear',
       run({ port_of_discharge: 'Nhava Sheva, India' },
           [ok({ outcome: 'exempt' })]).outcome === 'clear',
       JSON.stringify(run({ port_of_discharge: 'Nhava Sheva, India' }, [ok({ outcome: 'exempt' })])));

    const notClear = (label, ship, rows) => {
        const r = run(ship, rows);
        ck(label, r.outcome !== 'clear', `got ${r.outcome}: ${r.reasons.join(' ')}`);
        return r;
    };

    notClear('no rule on file is not clear',
        { port_of_discharge: 'Nhava Sheva, India' }, []);
    notClear('a rule nobody verified is not clear',
        { port_of_discharge: 'Nhava Sheva, India' },
        [ok({ outcome: 'exempt', verified_on: null, verified_by: null })]);
    notClear('a rule with a date but no person is not clear',
        { port_of_discharge: 'Nhava Sheva, India' },
        [ok({ outcome: 'exempt', verified_by: null })]);
    notClear('an EXPIRED rule is not clear',
        { port_of_discharge: 'Nhava Sheva, India' },
        [ok({ outcome: 'exempt', expires_on: '2026-10-23' })]);
    notClear('a DISPUTED rule is not clear',
        { port_of_discharge: 'Nhava Sheva, India' },
        [ok({ outcome: 'exempt', disputed: true })]);
    notClear('a rule with an outcome this version does not know is not clear',
        { port_of_discharge: 'Nhava Sheva, India' },
        [ok({ outcome: 'probably fine' })]);
    notClear('a destination whose country cannot be worked out is not clear',
        { port_of_discharge: 'Freedonia' }, [ok({ outcome: 'exempt' })]);
    notClear('no destination at all is not clear',
        { port_of_discharge: null }, [ok({ outcome: 'exempt' })]);
    notClear('an empty destination is not clear',
        { port_of_discharge: '   ' }, [ok({ outcome: 'exempt' })]);

    // One actionable allow does not rescue one stale rule for the same country.
    const mixed = run({ port_of_discharge: 'Nhava Sheva, India' },
        [ok({ id: 'A', outcome: 'exempt' }), ok({ id: 'B', outcome: 'exempt', verified_by: null })]);
    ck('one stale rule spoils an otherwise clear country',
       mixed.outcome === 'unknown', `${mixed.outcome}: ${mixed.reasons.join(' | ')}`);

    // And a real block beats staleness — she must hear the refusal, not "dunno".
    const both = run({ port_of_discharge: 'Nhava Sheva, India' },
        [ok({ id: 'A', outcome: 'prohibited' }), ok({ id: 'B', outcome: 'exempt', verified_by: null })]);
    ck('a confirmed block outranks a stale rule',
       both.outcome === 'blocked', `${both.outcome}: ${both.reasons.join(' | ')}`);
}

// ─────────────────────────────────────────────────────────────────────────
section('B. the country comes out of what SHE typed');
{
    const c = (s) => (X.countryOf(s) || {}).code || null;
    ck('"Busan,South Korea" — her spelling, no space', c('Busan,South Korea') === 'KR', String(c('Busan,South Korea')));
    ck('"BUSAN, SOUTH KOREA" — shouting', c('BUSAN, SOUTH KOREA') === 'KR', String(c('BUSAN, SOUTH KOREA')));
    ck('"Busan" alone', c('Busan') === 'KR', String(c('Busan')));
    ck('"Nhava Sheva, India"', c('Nhava Sheva, India') === 'IN', String(c('Nhava Sheva, India')));
    ck('"Nhava Sheva" alone', c('Nhava Sheva') === 'IN', String(c('Nhava Sheva')));
    ck('"Los Angeles, CA" is the US, not a destination rule',
       c('Los Angeles, CA') === 'US', String(c('Los Angeles, CA')));
    // The one that matters: a guess here would apply India's rules to a box
    // going somewhere else.
    ck('an unknown place returns null, NOT a guess', X.countryOf('Freedonia') === null,
       JSON.stringify(X.countryOf('Freedonia')));
    ck('  and so does empty', X.countryOf('') === null && X.countryOf(null) === null, 'null');
    // Longest alias wins, or "south korea" would lose to "korea" and a string
    // containing both would be ambiguous.
    ck('"Republic of Korea" resolves', c('Republic of Korea') === 'KR', String(c('Republic of Korea')));
    // Whole-word only: a port whose name merely CONTAINS a country name must
    // not match it. The first of these was written as `!== 'IN' || true`,
    // which passes whatever the code does — the same tautology deleted from
    // tests/claims-read-mail.js this week. Caught by reading the file, not by
    // the suite, which is the uncomfortable part.
    ck('substrings do not match — "Indianapolis" is not India',
       c('Indianapolis, Indiana USA') !== 'IN', String(c('Indianapolis, Indiana USA')));
    ck('  "Chinatown, Singapore" is not China',
       c('Chinatown, Singapore') !== 'CN', String(c('Chinatown, Singapore')));

    // ── AMBIGUITY, which a surviving mutation exposed as a real bug ───────
    // Longest-alias-wins used to decide this, and across countries that is
    // wrong: "New Mexico, USA" matches 'mexico' (6) and 'usa' (3), so it came
    // back Mexico. Two countries matching means not-knowing.
    ck('a place matching TWO countries is null, not the longest match',
       X.countryOf('New Mexico, USA') === null, JSON.stringify(X.countryOf('New Mexico, USA')));
    const amb = run({ port_of_discharge: 'New Mexico, USA' }, [ok({ outcome: 'exempt' })]);
    ck('  and an ambiguous destination is therefore not clear',
       amb.outcome === 'unknown', `${amb.outcome}: ${amb.reasons.join(' ')}`);
    // Within one country, longest still wins — that is what the reason line
    // reads out, so 'south korea' must beat 'korea'.
    // Within one country, longest still wins — that is the string the reason
    // line reads out. "Busan, South Korea" is NOT a test of this: 'south
    // korea' is both the first and the longest alias in the list, so
    // first-wins passes it too, and a mutation proved exactly that by
    // surviving. "Republic of Korea" is the case where they differ — 'korea'
    // comes first in the list, 'republic of korea' is longer.
    ck('within one country the longest alias is the one reported',
       (X.countryOf('Republic of Korea') || {}).matched === 'republic of korea',
       JSON.stringify(X.countryOf('Republic of Korea')));
    ck('  (and the plain case still reads properly)',
       (X.countryOf('Busan, South Korea') || {}).matched === 'south korea',
       JSON.stringify(X.countryOf('Busan, South Korea')));
    ck('  and a single-country string still resolves',
       c('Port Klang, Malaysia') === 'MY', String(c('Port Klang, Malaysia')));
}

// ─────────────────────────────────────────────────────────────────────────
section('C. a rule only applies to the shipment it is about');
{
    const usOnly = ok({ outcome: 'exempt', applies_when: { origin_country: 'US' } });
    ck('a US-origin exemption applies to a US-origin container',
       X.check({ port_of_discharge: 'Nhava Sheva, India', origin_country: 'US',
                 asOf: AS_OF, rows: [usOnly] }).outcome === 'clear');
    const ae = X.check({ port_of_discharge: 'Nhava Sheva, India', origin_country: 'AE',
                         asOf: AS_OF, rows: [usOnly] });
    ck('  and does NOT apply to a UAE-origin one — origin is what counts',
       ae.outcome === 'unknown', `${ae.outcome}: ${ae.reasons.join(' ')}`);

    const alOnly = ok({ outcome: 'exempt', applies_when: { materials: ['Aluminium wheels'] } });
    ck('a material-specific rule matches its material',
       X.check({ port_of_discharge: 'Nhava Sheva, India', origin_country: 'US',
                 material: 'aluminium wheels', asOf: AS_OF, rows: [alOnly] }).outcome === 'clear');
    // A condition the shipment cannot answer must not silently apply.
    const noMat = X.check({ port_of_discharge: 'Nhava Sheva, India', origin_country: 'US',
                            material: null, asOf: AS_OF, rows: [alOnly] });
    ck('  and a shipment with no material stated does not match it',
       noMat.outcome === 'unknown', `${noMat.outcome}: ${noMat.reasons.join(' ')}`);
}

// ─────────────────────────────────────────────────────────────────────────
section('D. every answer carries its source and its date');
{
    const r = run({ port_of_discharge: 'Nhava Sheva, India' },
        [ok({ outcome: 'prohibited', source_ref: 'DGFT PN 35/2026-27' })]);
    ck('a block names the source', r.reasons.join(' ').includes('DGFT PN 35/2026-27'), r.reasons.join(' '));
    ck('  and who confirmed it', r.reasons.join(' ').includes('Her broker'), r.reasons.join(' '));
    ck('  and when', r.reasons.join(' ').includes('2026-10-01'), r.reasons.join(' '));

    const e = run({ port_of_discharge: 'Nhava Sheva, India' },
        [ok({ outcome: 'exempt', expires_on: '2026-09-01' })]);
    ck('an expired rule says when it lapsed', e.reasons.join(' ').includes('2026-09-01'), e.reasons.join(' '));
    ck('  and gives her something to do about it', e.actions.length > 0, JSON.stringify(e.actions));

    const n = run({ port_of_discharge: 'Nhava Sheva, India' }, []);
    ck('"nothing on file" names the country rather than saying nothing',
       /India/.test(n.reasons.join(' ')), n.reasons.join(' '));
    ck('  and tells her who to ask', n.actions.join(' ').length > 10, JSON.stringify(n.actions));
}

// ─────────────────────────────────────────────────────────────────────────
section('E. verify() — a person, on a date, or not at all');
{
    const file = cfg.EXPORT_RULES_FILE;
    fs.writeFileSync(file, JSON.stringify([ok({ id: 'V1', verified_on: null,
        verified_by: null, disputed: true, outcome: 'exempt' })]), 'utf8');

    (async () => {
        let threw = '';
        try { await X.verify('V1', { by: '' }); } catch (e) { threw = e.message; }
        ck('verifying without a person is refused', /who confirmed/i.test(threw), threw);

        threw = '';
        try { await X.verify('V1', { by: 'Jarvis' }); } catch (e) { threw = e.message; }
        ck('  and "Jarvis" is not a person', /not by Jarvis/i.test(threw), threw);

        threw = '';
        try { await X.verify('nope', { by: 'Bose' }); } catch (e) { threw = e.message; }
        ck('  and an unknown rule id is refused', /no rule with id/i.test(threw), threw);

        await X.verify('V1', { by: 'Bose', on: '2026-10-24', clear_disputed: true });
        const after = X.rules().find((r) => r.id === 'V1');
        ck('a real verification records the person', after.verified_by === 'Bose', after.verified_by);
        ck('  and the date', after.verified_on === '2026-10-24', after.verified_on);
        ck('  and sets an expiry rather than leaving it open',
           !!after.expires_on && after.expires_on > '2026-10-24', String(after.expires_on));
        ck('  and clears disputed only when asked', after.disputed === false, String(after.disputed));
        ck('  and keeps a history entry naming the person',
           (after.history || []).some((h) => h.by === 'Bose'), JSON.stringify(after.history));
        ck('  so the rule is now actionable', X.statusOf(after, '2026-10-24').actionable === true,
           JSON.stringify(X.statusOf(after, '2026-10-24')));
        // And the whole point: it is only clear AFTER a person signed it.
        ck('  and only now does the check read clear',
           X.check({ port_of_discharge: 'Nhava Sheva, India', origin_country: 'US',
                     asOf: '2026-10-24' }).outcome === 'clear',
           JSON.stringify(X.check({ port_of_discharge: 'Nhava Sheva, India',
                                    origin_country: 'US', asOf: '2026-10-24' })));

        // ─────────────────────────────────────────────────────────────────
        section('F. needsAttention is the list a human has to work');
        {
            const rows = [
                ok({ id: 'N1', verified_by: null, verified_on: null }),
                ok({ id: 'N2', expires_on: '2026-10-01' }),
                ok({ id: 'N3', disputed: true }),
                ok({ id: 'N4', expires_on: '2026-11-10' }),
                ok({ id: 'N5', expires_on: '2027-06-01' }),
            ];
            const list = X.needsAttention({ asOf: '2026-10-24', within_days: 30, rows });
            const by = (id) => list.find((x) => x.id === id);
            ck('an unverified rule is on the list', (by('N1') || {}).why === 'never_verified', JSON.stringify(by('N1')));
            ck('an expired one is on the list', (by('N2') || {}).why === 'expired', JSON.stringify(by('N2')));
            ck('a disputed one is on the list', (by('N3') || {}).why === 'disputed', JSON.stringify(by('N3')));
            ck('one lapsing inside the window is on the list', (by('N4') || {}).why === 'lapsing', JSON.stringify(by('N4')));
            ck('a healthy one is NOT on the list', !by('N5'), JSON.stringify(by('N5')));
        }

        // ─────────────────────────────────────────────────────────────────
        section('G. the SHIPPED register is honest about itself');
        // Her real data/export-rules.json, read as data. Seeded from research
        // that could not be confirmed, so every row must report unknown until
        // somebody signs it. If a later edit marks one verified without a
        // person, this goes red.
        {
            // seeds/, NOT data/ — data/ is gitignored, so the tracked seed is
            // what actually reaches the VM. Reading data/ here would have
            // tested a file production never sees, and passed.
            const real = JSON.parse(fs.readFileSync(
                path.join(ROOT, 'seeds/export-rules.json'), 'utf8'));
            ck('the shipped register has rows', real.length >= 4, String(real.length));
            ck('  and NOT ONE of them claims to be verified',
               real.every((r) => !r.verified_by && !r.verified_on),
               real.filter((r) => r.verified_by).map((r) => r.id).join(','));
            ck('  every row carries a source reference',
               real.every((r) => String(r.source_ref || '').length > 3),
               real.filter((r) => !r.source_ref).map((r) => r.id).join(','));
            ck('  every row says how to verify it',
               real.every((r) => String(r.how_to_verify || '').length > 10),
               real.filter((r) => !r.how_to_verify).map((r) => r.id).join(','));
            ck('  the India PSIC row is marked disputed, because its sources were',
               (real.find((r) => r.id === 'IN-PSIC-2026') || {}).disputed === true, 'IN-PSIC-2026');

            // Both real lanes in the codebase must come back unknown today.
            for (const [place, label] of [['Nhava Sheva, India', 'India'], ['Busan,South Korea', 'Korea']]) {
                const r = X.check({ port_of_discharge: place, origin_country: 'US',
                                    asOf: '2026-10-24', rows: real });
                ck(`  ${label} reads unknown on the shipped register, not clear`,
                   r.outcome === 'unknown', `${r.outcome}: ${r.reasons.join(' | ')}`);
            }

            // ── THE SEED FALLBACK, which is the whole reason seeds/ exists ─
            // On a fresh VM there is no data/export-rules.json. rules() must
            // fall back to the tracked seed rather than returning [] — an
            // empty register answers "nothing on file" for every destination,
            // which is still unknown, but it would silently lose the India
            // notice and the Korea gap that are the point of the file.
            const herFile = cfg.EXPORT_RULES_FILE;
            const saved = fs.existsSync(herFile) ? fs.readFileSync(herFile, 'utf8') : null;
            try {
                if (saved !== null) fs.unlinkSync(herFile);
                const fromSeed = X.rules();
                ck('with no register of her own, rules() falls back to the shipped seed',
                   fromSeed.length === real.length, `${fromSeed.length} vs ${real.length}`);
                ck('  so a fresh VM still knows about the India notice',
                   fromSeed.some((r) => r.id === 'IN-PSIC-2026'),
                   fromSeed.map((r) => r.id).join(','));
                ck('  and reading the seed does NOT create her file',
                   !fs.existsSync(herFile), 'a read path that writes is a surprise');
            } finally {
                if (saved !== null) fs.writeFileSync(herFile, saved, 'utf8');
            }
            ck('  and her own register wins when it exists',
               saved === null || X.rules().some((r) => r.id === 'V1'),
               X.rules().map((r) => r.id).join(','));
        }

        console.log(`\n${pass} passed, ${fail} failed`);
        if (fail) { console.log('FAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }
    })().catch((e) => { console.error('\nCRASHED: ' + (e && e.stack || e)); process.exit(1); });
}
