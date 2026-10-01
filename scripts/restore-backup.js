#!/usr/bin/env node
// ── scripts/restore-backup.js — put the yard data back ────────────────────
// Apsara, 2026-10-02: "Protect the data of edge yard no matter what."
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────
// The nightly backup has worked since 2026-09-02 and there was NO WAY TO
// RESTORE FROM IT. The only restore in the codebase was six lines of
// fs.writeFileSync inside tests/backup.js — which proves the archive is
// sufficient and leaves nobody a tool.
//
// That is the classic untested backup: the copies exist, the procedure is
// "someone will figure it out", and the figuring-out happens on the worst
// day, under pressure, against a 2 MB JSON file. This is that procedure,
// written down and runnable while nothing is wrong.
//
// ── USE IT ────────────────────────────────────────────────────────────────
//   node scripts/restore-backup.js --list
//       What copies exist on Drive, newest first. Read-only.
//
//   node scripts/restore-backup.js --date 2026-09-28
//       DRY RUN by default: says exactly what it would write, how many rows
//       each store has now, and how many it would have after. Writes nothing.
//
//   node scripts/restore-backup.js --date 2026-09-28 --only payments.json
//       One store. This is the common case by a mile — a single file got
//       damaged, everything else is fine — and restoring everything to fix
//       one store would roll back a day of real work in all the others.
//
//   node scripts/restore-backup.js --date 2026-09-28 --only payments.json --write
//       Does it. Each file it replaces is copied to
//       <name>.before-restore-<timestamp> first, in the same directory.
//
//   node scripts/restore-backup.js --file ./jarvis-data-2026-09-28.json --date x
//       Reads a local archive instead of Drive, for when Drive is the thing
//       that is broken or there is no network.
//
// ── THE RULES IT FOLLOWS ──────────────────────────────────────────────────
// DRY BY DEFAULT. --write is the only way anything is written. A restore
// script whose default action overwrites the live ledger is a loaded gun.
//
// IT NEVER DELETES A STORE. A store present on disk and absent from the
// archive is LEFT ALONE and reported. The archive might be from before that
// store existed — yard_claims.json is three days old — and "restore" must
// never mean "delete the things the backup had not heard of".
//
// IT KEEPS WHAT IT REPLACES. Every overwrite leaves a .before-restore- copy
// beside the original, so a restore of the wrong date is itself undoable.
// That file is NOT a .json, so the nightly backup's own collector skips it
// and it cannot come back round as a store.
//
// IT REFUSES TO GUESS. No --date and no --file is an error, not "use the
// newest". The newest copy is exactly the wrong one when last night's run
// captured the damage.

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const WRITE = has('--write');
const LIST = has('--list');
const DATE = val('--date');
const FILE = val('--file');
const ONLY = argv.reduce((acc, a, i) => (a === '--only' && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);

function die(msg) { console.error(`\n  ${msg}\n`); process.exit(1); }

const rows = (v) => (Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : 1));

(async () => {
    const cfg = require('../config');

    if (LIST) {
        const drive = require('../helpers/drive');
        const files = await drive.listBackups();
        if (!files.length) {
            // Said plainly. "No backups found" is the single most important
            // sentence this script can print, and it must not look like an
            // empty success.
            console.log('\n  NO BACKUPS FOUND IN DRIVE.\n');
            console.log('  That is either a configuration problem (wrong folder) or the');
            console.log('  nightly job has never succeeded. Check the Backups folder under');
            console.log('  the Drive upload folder, and data/backup_log.json on the VM.\n');
            process.exit(1);
        }
        console.log(`\n  ${files.length} backup${files.length === 1 ? '' : 's'} on Drive, newest first:\n`);
        for (const f of files) {
            console.log(`    ${f.date || '?'.padEnd(10)}  ${String(Math.round((f.bytes || 0) / 1024)).padStart(6)} KB   ${f.name}`);
        }
        console.log('\n  Restore one with:  node scripts/restore-backup.js --date YYYY-MM-DD\n');
        return;
    }

    if (!DATE && !FILE) {
        die('Which copy? --date YYYY-MM-DD (or --file ./archive.json, or --list to see what there is).\n'
          + '  Deliberately no default: the newest copy is the wrong one when last\n'
          + '  night\'s run captured the damage.');
    }

    // ── LOAD THE ARCHIVE ──────────────────────────────────────────────────
    let archive;
    if (FILE) {
        if (!fs.existsSync(FILE)) die(`No such file: ${FILE}`);
        archive = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } else {
        const drive = require('../helpers/drive');
        const files = await drive.listBackups();
        const hit = files.find((f) => f.date === DATE) || files.find((f) => f.name.includes(DATE));
        if (!hit) {
            die(`No backup for ${DATE}. Run --list to see what there is.`);
        }
        console.log(`\n  Downloading ${hit.name} …`);
        archive = JSON.parse((await drive.downloadBackupJson(hit.id)).toString('utf8'));
    }

    // ── IS IT ONE OF OURS? ────────────────────────────────────────────────
    const meta = archive && archive._meta;
    if (!meta || meta.kind !== 'jarvis-data-backup' || !archive.stores) {
        die('That file is not a Jarvis data backup (no _meta.kind). Refusing to touch anything.');
    }
    if (meta.version !== 1) {
        die(`That archive is version ${meta.version}; this script understands version 1. `
          + 'Restore it by hand rather than letting this guess.');
    }

    console.log(`\n  Archive taken ${meta.taken_at} (${meta.date}) — ${meta.store_count} stores`);
    if (meta.critical_missing && meta.critical_missing.length) {
        // Loudly. Restoring from a copy that was already incomplete is a
        // thing she needs to know BEFORE it goes on disk, not after.
        console.log(`\n  ⚠ THIS ARCHIVE WAS ALREADY INCOMPLETE WHEN IT WAS TAKEN.`);
        console.log(`    Missing: ${meta.critical_missing.join(', ')}`);
        console.log(`    Those stores cannot be restored from this copy. Try an earlier date.`);
    }
    if (meta.problems && meta.problems.length) {
        console.log(`\n  ⚠ ${meta.problems.length} store(s) would not parse on the night this was taken:`);
        for (const p of meta.problems.slice(0, 10)) console.log(`    ${p.path}: ${p.error}`);
    }

    // ── WHAT WOULD CHANGE ─────────────────────────────────────────────────
    const names = Object.keys(archive.stores);
    const chosen = ONLY.length ? names.filter((n) => ONLY.includes(n) || ONLY.includes(path.basename(n))) : names;
    if (ONLY.length) {
        const missed = ONLY.filter((o) => !chosen.some((c) => c === o || path.basename(c) === o));
        if (missed.length) die(`Not in this archive: ${missed.join(', ')}. Run --list, or check the name.`);
    }

    const plan = [];
    for (const rel of chosen) {
        const abs = path.join(cfg.DATA_DIR, rel);
        let now = null;
        if (fs.existsSync(abs)) {
            try { now = rows(JSON.parse(fs.readFileSync(abs, 'utf8'))); }
            catch { now = 'UNREADABLE'; }
        }
        plan.push({ rel, abs, now, after: rows(archive.stores[rel]), exists: fs.existsSync(abs) });
    }

    console.log(`\n  ${WRITE ? 'RESTORING' : 'WOULD RESTORE'} ${plan.length} store${plan.length === 1 ? '' : 's'}:\n`);
    console.log('    store'.padEnd(36) + 'on disk now'.padStart(12) + 'from backup'.padStart(13));
    for (const p of plan) {
        const nowTxt = p.exists ? String(p.now) : '(absent)';
        // Flagged when the live file has MORE than the backup — that is a
        // restore throwing away work, and it is the mistake worth catching
        // before it happens rather than after.
        const loses = typeof p.now === 'number' && p.after < p.now;
        console.log(`    ${p.rel.padEnd(34)}${nowTxt.padStart(12)}${String(p.after).padStart(13)}`
            + (loses ? `   ← LOSES ${p.now - p.after}` : ''));
    }

    // Stores on disk that this archive has never heard of. Never deleted.
    const onDisk = require('../helpers/backup').collectStores();
    const unknown = Object.keys(onDisk.stores).filter((n) => !names.includes(n));
    if (unknown.length) {
        console.log(`\n  LEFT ALONE — on disk, not in this archive (${unknown.length}):`);
        for (const u of unknown.slice(0, 20)) console.log(`    ${u}`);
        console.log('    A restore never deletes. This archive may simply predate them.');
    }

    if (!WRITE) {
        console.log('\n  DRY RUN — nothing was written. Add --write to do it.');
        console.log('  Narrow it with --only payments.json if one store is the problem:');
        console.log('  restoring everything to fix one file rolls back a day of real work');
        console.log('  in all the others.\n');
        return;
    }

    // ── DO IT ─────────────────────────────────────────────────────────────
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let done = 0;
    for (const p of plan) {
        fs.mkdirSync(path.dirname(p.abs), { recursive: true });
        if (p.exists) {
            // .before-restore-… and NOT .json, so helpers/backup.js's
            // collector (which takes only *.json) cannot sweep it up and
            // turn a keepsake into a store.
            const keep = `${p.abs}.before-restore-${stamp}`;
            fs.copyFileSync(p.abs, keep);
        }
        const tmp = `${p.abs}.restore-tmp`;
        fs.writeFileSync(tmp, JSON.stringify(archive.stores[p.rel], null, 2));
        // Atomic, like helpers/json.js's writeAtomic: a half-written money
        // ledger is worse than the damaged one it replaces.
        fs.renameSync(tmp, p.abs);
        done += 1;
    }
    console.log(`\n  Restored ${done} store${done === 1 ? '' : 's'} from ${meta.date}.`);
    console.log(`  Previous contents kept beside each file as .before-restore-${stamp}`);
    console.log('\n  NOW RESTART JARVIS — it caches nothing from these files between');
    console.log('  reads, but anything already in memory (brain, sessions) will not');
    console.log('  match until it does:   pm2 restart jarvis --update-env\n');
})().catch((e) => {
    console.error('\n  FAILED:', e.message);
    console.error('  Nothing was written unless the lines above say otherwise.\n');
    process.exit(1);
});
