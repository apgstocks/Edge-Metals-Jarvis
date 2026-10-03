// ── tests/gemini-model-source.js ──────────────────────────────────────────
// #159 says the workhorse is legacy and should move off gemini-2.5-flash-lite.
// Working out how to move it turned up why it had not moved: the obvious fix
// does nothing on the live server.
//
//     getModelName() = loadSettings().gemini_model || cfg.GEMINI_MODEL
//
// loadSettings() is loadJson(SETTINGS_FILE, {...defaults}), and loadJson
// returns the FILE AS IT IS — no merge. That alone would be harmless. But
// PUT /api/settings saves `{ ...loadSettings(), ...req.body }`, so the first
// time anyone ever saved ANY setting the whole default object was written to
// disk with it, and the model string was frozen into data/settings.json. From
// then on config.js and the GEMINI_MODEL env var are both dead letters.
//
// It is not hypothetical: the repo's own data/settings.json has the key.
//
// ── THE PROPERTY THIS FILE PINS DOWN ─────────────────────────────────────
// Not "which model is correct" — that is Apsara's decision and the model
// strings will change. What must stay true is that the REPORT TELLS THE
// TRUTH ABOUT WHERE THE VALUE CAME FROM, and that it speaks up when a stored
// pin is making the config inert.
//
// The sharpest case, and the one my first version got wrong: a pin that
// AGREES with the config. There is no disagreement to detect, everything
// looks consistent, and the config is still being ignored — so the next
// person edits config.js, deploys, and nothing happens. A report that only
// fires on a mismatch fires only after the mistake has been made. Section C
// is that case.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-geminimodel-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
// ── THERE ARE THREE SOURCES, NOT TWO ─────────────────────────────────────
// config.js calls require('dotenv').config(), and the repo's .env sets
// GEMINI_MODEL on line 2. So the real precedence is
//
//     data/settings.json  >  .env / environment  >  config.js default
//
// My first version of this file deleted the env var BEFORE requiring config
// and expected 'config' — dotenv then set it again and three checks failed
// reporting 'env'. The CODE was right and the test was wrong, which is the
// better way round but worth writing down: it means clearing the stored pin
// does NOT hand authority back to config.js, because .env is still in front
// of it. Two files to clear, not one.
//
// Each case below sets or deletes the variable explicitly. cfg is already
// loaded and cached by then, so cfg.GEMINI_MODEL stays whatever .env gave it
// while workhorseFrom reflects the live environment — which is exactly the
// question being asked: who decides RIGHT NOW.

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.SETTINGS_FILE).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against real data');
    process.exit(1);
}

const gemini = require(path.join(ROOT, 'helpers/gemini'));

// The settings file is read fresh on every effectiveModels() call (loadJson
// does no caching), so each case just writes the file it wants.
const writeSettings = (obj) => fs.writeFileSync(cfg.SETTINGS_FILE, JSON.stringify(obj, null, 2));
const noSettings = () => { try { fs.unlinkSync(cfg.SETTINGS_FILE); } catch (e) {} };

// ── A — NO PIN: THE CONFIG IS THE AUTHORITY ───────────────────────────────
{
    section('A — with nothing stored, the config decides');

    noSettings();
    delete process.env.GEMINI_MODEL;
    const e = gemini.effectiveModels();

    ck('the workhorse is the config value', e.workhorse === cfg.GEMINI_MODEL,
       `${e.workhorse} vs ${cfg.GEMINI_MODEL}`);
    ck('  and it says so', e.workhorseFrom === 'config', e.workhorseFrom);
    ck('  with no pin', e.pinned === null, JSON.stringify(e.pinned));
    ck('  the smart tier is reported separately',
       e.smart === cfg.GEMINI_MODEL_SMART && e.smart !== e.workhorse,
       `${e.smart} / ${e.workhorse}`);
    // Vision is a DIFFERENT lever (GEMINI_VISION_MODEL) feeding the scale-
    // ticket reader. Reported so that moving the workhorse cannot be mistaken
    // for having moved the thing that reads her weights.
    ck('  and so is vision, which is not the workhorse',
       !!e.vision && e.vision !== e.workhorse, `${e.vision} / ${e.workhorse}`);

    ck('no NOTE when nothing is pinned',
       !gemini.modelReportLines().some((l) => /PINNED/.test(l)),
       gemini.modelReportLines().join(' | '));
}

// ── B — A PIN THAT DISAGREES ──────────────────────────────────────────────
{
    section('B — a stored pin overrides the config, and is named');

    writeSettings({ manager_name: 'Manager', gemini_model: 'gemini-9.9-pretend' });
    const e = gemini.effectiveModels();

    ck('the stored value wins', e.workhorse === 'gemini-9.9-pretend', e.workhorse);
    ck('  reported as coming from settings', e.workhorseFrom === 'settings', e.workhorseFrom);
    ck('  and what the config WOULD have given is kept',
       e.configWouldGive === cfg.GEMINI_MODEL, e.configWouldGive);

    const lines = gemini.modelReportLines();
    ck('  the report says it is pinned', lines.some((l) => /PINNED/.test(l)));
    ck('  names both values, so the gap is readable not inferred',
       lines.some((l) => l.includes('gemini-9.9-pretend') && l.includes(cfg.GEMINI_MODEL)),
       lines.join(' | '));
    ck('  and says the config is being ignored',
       lines.some((l) => /IGNORED/.test(l)), lines.join(' | '));

    // An invented model is not in the 2.5 family, so the legacy warning must
    // NOT fire here — a warning that fires on everything says nothing.
    ck('  and does not warn about legacy for a non-2.5 model',
       !lines.some((l) => /WARNING/.test(l) && /workhorse=/.test(l)),
       lines.join(' | '));
}

// ── C — THE TRAP: A PIN THAT AGREES ───────────────────────────────────────
// This is the state the live server is in, and the one my first version of
// the report stayed silent about.
{
    section('C — a pin that AGREES with the config is still a pin');

    writeSettings({ manager_name: 'Manager', gemini_model: cfg.GEMINI_MODEL });
    const e = gemini.effectiveModels();

    ck('the source is still settings, not config',
       e.workhorseFrom === 'settings',
       `${e.workhorseFrom} — the values match, the authority does not`);

    const lines = gemini.modelReportLines();
    ck('  and the report STILL says it is pinned',
       lines.some((l) => /PINNED/.test(l)),
       'silence here is the whole bug: the config looks obeyed and is inert');
    ck('  explaining that editing the config will change nothing',
       lines.some((l) => /change nothing|no effect/i.test(l)),
       lines.join(' | '));
}

// ── D — A STORED BLANK IS NOT A PIN ───────────────────────────────────────
// How the pin will most likely be cleared: emptied rather than deleted,
// because a UI field writes '' and nobody removes JSON keys by hand.
{
    section('D — clearing it by emptying the field, not deleting the key');

    delete process.env.GEMINI_MODEL;
    for (const v of ['', '   ', null]) {
        writeSettings({ manager_name: 'Manager', gemini_model: v });
        const e = gemini.effectiveModels();
        ck(`  ${JSON.stringify(v)} falls through past the pin`,
           e.workhorse === cfg.GEMINI_MODEL && e.workhorseFrom === 'config',
           `${e.workhorse} from ${e.workhorseFrom}`);
    }
}

// ── D3 — A SETTINGS FILE WITH NO MODEL KEY IS NOT A PIN ───────────────────
// The case my first set of controls missed. Deleting the hasOwnProperty check
// from storedPin() left all 38 green, because every other case either has no
// file at all (existsSync short-circuits) or has the key. This is the one that
// distinguishes "a key was stored" from "loadSettings handed back its own
// default" — and that distinction is the entire reason storedPin reads the
// file instead of calling loadSettings().
//
// It is also the state of a server that has NEVER saved a setting: file
// present because something else wrote it, model key absent.
{
    section('D3 — a settings file that simply does not mention the model');

    delete process.env.GEMINI_MODEL;
    writeSettings({ manager_name: 'Manager', team_group_id: '', email_bcc: '' });
    const e = gemini.effectiveModels();

    ck('that is not a pin', e.pinned === null, JSON.stringify(e.pinned));
    ck('  so the config is the authority', e.workhorseFrom === 'config', e.workhorseFrom);
    ck('  and the report does not claim it is pinned',
       !gemini.modelReportLines().some((l) => /PINNED/.test(l)),
       'loadSettings() would have handed back its own default here and looked like a pin');

    // And with the key present but holding the SAME value, it IS a pin. The
    // pair is the assertion; either alone passes with the check removed.
    writeSettings({ manager_name: 'Manager', gemini_model: cfg.GEMINI_MODEL });
    ck('  while the same value STORED is a pin',
       gemini.effectiveModels().workhorseFrom === 'settings',
       gemini.effectiveModels().workhorseFrom);
}

// ── D2 — AND .env IS STILL IN FRONT OF THE CONFIG ─────────────────────────
// The thing the failed first version of this file taught me. Clearing the
// stored pin is not the end of it: config.js calls dotenv, so GEMINI_MODEL in
// .env takes the decision next. On a box where both are set, changing the
// config default is TWO files away from having any effect.
{
    section('D2 — with no pin, the environment still beats the config default');

    noSettings();
    process.env.GEMINI_MODEL = 'gemini-from-dotenv';
    let e = gemini.effectiveModels();
    ck('the env var decides', e.workhorse === 'gemini-from-dotenv', e.workhorse);
    ck('  and is named as the source', e.workhorseFrom === 'env', e.workhorseFrom);
    ck('  with no pin reported', !gemini.modelReportLines().some((l) => /PINNED/.test(l)));

    // A pin beats the env var too — the full chain, in one assertion.
    writeSettings({ gemini_model: 'gemini-from-settings' });
    e = gemini.effectiveModels();
    ck('a stored pin beats even the environment',
       e.workhorse === 'gemini-from-settings' && e.workhorseFrom === 'settings',
       `${e.workhorse} from ${e.workhorseFrom}`);

    delete process.env.GEMINI_MODEL;
}

// ── E — THE LEGACY WARNING SAYS WHAT IS LEGACY ────────────────────────────
{
    section('E — the 2.5-family warning');

    writeSettings({ gemini_model: 'gemini-2.5-flash-lite' });
    let lines = gemini.modelReportLines();
    ck('a 2.5 workhorse warns', lines.some((l) => /WARNING/.test(l)), lines.join(' | '));
    ck('  and names which tier is on it',
       lines.some((l) => /workhorse=gemini-2\.5-flash-lite/.test(l)),
       'a warning that does not say WHICH one leaves someone grepping');

    // The vision FALLBACK is 2.5 as well, and it is the one nobody would
    // think of: it only runs when the primary vision model 404s, which is
    // exactly the day the 2.5 access limit would also be biting.
    ck('  and reports the vision fallback as legacy too',
       lines.some((l) => /vision fallback=gemini-2\.5/.test(l)),
       gemini.effectiveModels().legacy.join(', '));

    writeSettings({ gemini_model: 'gemini-3.8-flash' });
    lines = gemini.modelReportLines();
    ck('a current workhorse is not named as legacy',
       !lines.some((l) => /workhorse=gemini-3\.8/.test(l)), lines.join(' | '));
    // The fallback is still 2.5, so the warning itself must remain — the
    // model moving does not make the fallback current.
    ck('  but the 2.5 vision fallback is still reported',
       lines.some((l) => /WARNING/.test(l) && /vision fallback/.test(l)),
       lines.join(' | '));
}

// ── F — IT CANNOT TAKE THE SERVER DOWN, AND IT CANNOT WRITE ───────────────
{
    section('F — a report is not worth a boot failure');

    // Unreadable settings: loadJson swallows it and returns the default, so
    // effectiveModels must come back with the config rather than throw. The
    // boot block in api.js is wrapped too, but a helper that throws on bad
    // data is a helper waiting for a bad deploy.
    delete process.env.GEMINI_MODEL;
    fs.writeFileSync(cfg.SETTINGS_FILE, '{ this is not json');
    let err = null; let e = null;
    try { e = gemini.effectiveModels(); } catch (x) { err = x; }
    ck('unparseable settings do not throw', !err, err && err.message);
    ck('  and fall back to the config', !!e && e.workhorse === cfg.GEMINI_MODEL,
       e && e.workhorse);

    let lerr = null;
    try { gemini.modelReportLines(); } catch (x) { lerr = x; }
    ck('  and the report still renders', !lerr, lerr && lerr.message);

    // READ-ONLY, by inspection of the two things that could change state.
    const src = fs.readFileSync(path.join(ROOT, 'scripts/gemini-model-report.js'), 'utf8');
    ck('the script writes nothing',
       !/saveSettings|writeFileSync|mutateJson|saveJson/.test(src),
       'it reports on a live production data file; it must not edit one');

    const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    ck('  and the boot report is wrapped so it cannot stop the server',
       /try \{[\s\S]{0,400}modelReportLines\(\)[\s\S]{0,400}catch/.test(api));
}

// ── G — AND THE TIERS THAT ALREADY MOVED STAY MOVED ───────────────────────
// The money paths were put on the smart tier on 2026-10-02 and 10-03. #159 is
// about the workhorse; nothing here should disturb those, and a later tidy-up
// of the config should not collapse them back onto one value.
{
    section('G — the smart tier, unchanged');

    noSettings();
    for (const k of ['GEMINI_MODEL_CLAIMS', 'GEMINI_MODEL_QB', 'GEMINI_MODEL_PAY', 'GEMINI_MODEL_CHAT']) {
        ck(`  ${k} is the smart tier, not the workhorse`,
           cfg[k] === cfg.GEMINI_MODEL_SMART && cfg[k] !== cfg.GEMINI_MODEL,
           `${cfg[k]} / smart ${cfg.GEMINI_MODEL_SMART} / workhorse ${cfg.GEMINI_MODEL}`);
    }
    ck('  and the smart tier is not a 2.5 model',
       !/^gemini-2\.5/.test(cfg.GEMINI_MODEL_SMART), cfg.GEMINI_MODEL_SMART);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
