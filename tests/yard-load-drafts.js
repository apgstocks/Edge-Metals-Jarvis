// ── tests/yard-load-drafts.js ───────────────────────────────────────────────
// Covers server-side load drafts (helpers/loadDrafts.js), added 2026-08-28
// per Apsara: "draft needs to be saved and can be edited later."
//
// The assertions that matter here are the NEGATIVE ones. A draft is an
// incomplete load, and the entire risk is that it leaks into something that
// treats it as a real one — the day's totals, the yard report, inventory
// netting, a seller statement. That is why drafts are their own store rather
// than a flag on loads.json, and these tests exist to prove the separation
// holds rather than to trust that it does.
//
// Uses the REAL modules against a temp data dir. A mocked store would agree
// with whatever it was told, which is useless for a question about whether
// two stores are actually separate.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafts-'));
process.env.DATA_DIR = tmp;

const R = (f) => path.join(__dirname, '..', f);
const cfg = require(R('config.js'));

let pass = 0, fail = 0;
const failures = [];
function ck(name, cond) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; failures.push(name); console.log('  FAIL  ' + name); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

(async () => {
    const drafts = require(R('helpers/loadDrafts.js'));
    const { loadLoads } = require(R('helpers/loads.js'));

    section('a draft is saved and can be reopened');
    {
        const d = await drafts.saveDraft({
            seller: 'Acme Metals', date: '2026-08-28',
            items: [
                { description: 'Auto Casting', gross_weight: 4210, tare_weight: 200 },
                { description: 'Al Combo', gross_weight: 3475, tare_weight: 180 },
            ],
        });
        ck('saving returns an id', !!d.id && d.id.startsWith('DRAFT_'));
        ck('it can be read back', !!drafts.getDraft(d.id));
        ck('it keeps both items', drafts.getDraft(d.id).items.length === 2);
        ck('it records when it was last touched', !!drafts.getDraft(d.id).updated_at);

        // Autosave hits this repeatedly — it must UPDATE, not accumulate.
        const again = await drafts.saveDraft({ id: d.id, seller: 'Acme Metals Ltd', items: d.items });
        ck('re-saving with the same id updates rather than duplicating', drafts.listDrafts().length === 1);
        ck('the update is applied', drafts.getDraft(d.id).seller === 'Acme Metals Ltd');
        ck('created_at survives an update, so "started at" stays true', again.created_at === d.created_at);
    }

    section('a draft NEVER reaches the loads store — the whole point');
    {
        ck('loads.json has no drafts in it', loadLoads().length === 0);
        ck('the two stores are different files', cfg.LOAD_DRAFTS_FILE !== cfg.LOADS_FILE);
        ck('the drafts file is not the outbound file either', cfg.LOAD_DRAFTS_FILE !== cfg.OUTBOUND_LOADS_FILE);
        // Structural, not incidental: nothing reading loads.json can see a
        // draft because a draft is not in that file at all.
        const loadsRaw = fs.existsSync(cfg.LOADS_FILE) ? fs.readFileSync(cfg.LOADS_FILE, 'utf8') : '[]';
        ck('no DRAFT_ id appears anywhere in loads.json', !loadsRaw.includes('DRAFT_'));
    }

    section('drafts are exempt from validation, on purpose');
    {
        // A real load refuses to save without weights. A draft is explicitly
        // allowed to be half-finished — that is what makes it a draft.
        const messy = await drafts.saveDraft({
            items: [{ description: 'Steel' }, { description: 'Copper' }],
        });
        ck('a draft with no weights saves anyway', !!messy.id);
        ck('a draft with no seller saves anyway', drafts.getDraft(messy.id).seller === null);
        await drafts.deleteDraft(messy.id);
    }

    section('the two-item rule, and clearing back out');
    {
        ck('one filled item is not worth saving', !drafts.isWorthSaving({ items: [{ description: 'Steel' }] }));
        ck('two filled items are', drafts.isWorthSaving({ items: [{ description: 'Steel' }, { description: 'Copper' }] }));
        ck('blank rows do not count toward the two', !drafts.isWorthSaving({ items: [{ description: 'Steel' }, {}, { description: '' }] }));
        ck('a weight alone counts as content', drafts.isWorthSaving({ items: [{ gross_weight: 100 }, { net_weight: 50 }] }));
        ck('an empty item list is not worth saving', !drafts.isWorthSaving({ items: [] }));
        ck('a missing item list does not throw', !drafts.isWorthSaving({}));
    }

    section('deleting');
    {
        const d = await drafts.saveDraft({ items: [{ description: 'A' }, { description: 'B' }] });
        const before = drafts.listDrafts().length;
        ck('delete removes it', await drafts.deleteDraft(d.id) && drafts.listDrafts().length === before - 1);
        ck('deleting something already gone is not an error', (await drafts.deleteDraft(d.id)) === false);
    }

    section('the store cannot grow without limit');
    {
        for (let i = 0; i < drafts.MAX_DRAFTS + 6; i++) {
            await drafts.saveDraft({ seller: 'S' + i, items: [{ description: 'A' }, { description: 'B' }] });
        }
        ck(`kept at most ${drafts.MAX_DRAFTS}`, drafts.listDrafts().length <= drafts.MAX_DRAFTS);
        // A forgotten draft carrying photos must not grow the file forever,
        // and the one still being typed is the one worth keeping.
        const list = drafts.listDrafts();
        ck('newest is kept first', list[0].updated_at >= list[list.length - 1].updated_at);
    }

    console.log('\n================================================================');
    console.log(`${pass} passed, ${fail} failed`);
    if (fail) { console.log('\nFAILED:'); failures.forEach((f) => console.log('  - ' + f)); }
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(fail ? 1 : 0);
})();
