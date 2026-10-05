// ── helpers/restore.js — read a backup archive back onto disk ─────────────
//
// WHY THIS DID NOT EXIST UNTIL NOW. helpers/backup.js has run every night for
// weeks and mentions "restore" three times — all of them comments, one of
// them "see the restore script" as though there were one. There was not. The
// nightly archive was a file nobody had ever read back, which is not a backup,
// it is a habit.
//
// Apsara, 2026-10-03, asked which productionisation work to do first and chose
// exactly this: prove the whole data directory can be rebuilt from a Drive
// archive onto a fresh box, and time it.
//
// ── THIS FILE DECIDES; IT DOES NOT TALK TO ANYTHING ──────────────────────
// No Drive, no console, no process.exit, no reading of cfg.DATA_DIR as a
// default target. It is given an archive object and a directory. That is what
// makes the drill in tests/restore-drill.js able to run the real thing rather
// than a lookalike — the gap between a restore test and a restore script is
// precisely where a restore fails.
//
// ── THE TARGET IS NEVER THE LIVE DIRECTORY BY DEFAULT ────────────────────
// A restore writes 53 money stores. Every design choice here assumes the
// operator is frightened and in a hurry, which is when restores happen:
//
//   · validate the WHOLE archive before writing a single byte;
//   · write into a temp directory and rename it into place, so there is no
//     such state as half-restored;
//   · refuse a non-empty target unless told twice;
//   · and never guess the target. The caller passes it.

const fs = require('fs');
const path = require('path');
const os = require('os');

const KIND = 'jarvis-data-backup';
const SUPPORTED_VERSIONS = [1];

// ── A STORE NAME FROM AN ARCHIVE IS UNTRUSTED INPUT ──────────────────────
// The keys are relative paths taken from a JSON file that has been to Google
// Drive and back. A key of '../../.ssh/authorized_keys' or '/etc/passwd'
// would otherwise be written exactly where it says. Drive is a shared folder;
// "nobody would do that" is not a property of a shared folder.
//
// Returns the safe relative path, or null to refuse it.
function safeRel(rel) {
    if (typeof rel !== 'string' || !rel.trim()) return null;
    const r = rel.trim().replace(/\\/g, '/');
    if (r.startsWith('/') || /^[a-zA-Z]:/.test(r)) return null;      // absolute
    if (r.split('/').some((seg) => seg === '..' || seg === '.')) return null;
    // A FILTER, NOT A GUARD. collectStores only ever puts .json in, so
    // anything else is a malformed archive. It is NOT what stops traversal —
    // removing this line on its own leaves the drill green, which is how I
    // know; the two checks above are the security ones. Said plainly because
    // a line that looks like a guard and is not is worse than no line.
    if (!r.endsWith('.json')) return null;
    if (r.includes('\0')) return null;
    return r;
}

// ── WHAT THE ARCHIVE CANNOT GIVE BACK ────────────────────────────────────
// backup.js deliberately excludes these, and a restore that does not say so
// leaves someone believing they are finished. Each line is a thing that must
// be done by hand afterwards, in the words of why it is missing.
const NOT_IN_ARCHIVE = [
    ['Google credentials / tokens', 'excluded by SECRET_PATTERNS — re-issue from the Google console'],
    ['bank-item.json and bank-*.json', 'excluded on her instruction, 2026-09-03: the Plaid access token is '
        + 'not a copy of the data, it is the standing ability to fetch more. Re-link the bank. '
        + 'These exist on the VM and nowhere else — only the GCP disk snapshot has them.'],
    // ── NOT RE-LINKABLE, UNLIKE THE REST OF bank-* ───────────────────────
    // bank-learn.json is caught by the same pattern, but losing it is a
    // different kind of loss and saying "re-link the bank" would be
    // misleading. It holds every bank descriptor she has mapped to a
    // customer — the answers behind "ask once". A re-link brings the
    // transactions back; nothing brings these back except answering each
    // payer again, one deposit at a time. Named separately so a restore does
    // not report success while quietly having thrown that away.
    ['bank-learn.json', 'the payer names she taught the bank matcher. A re-link does NOT restore these: '
        + 'every unrecognised deposit will ask again until she re-answers it. '
        + 'If that matters, keep a copy of this one file somewhere off the VM.'],
    ['documents_saved/', 'SKIP_DIRS — generated invoices and BOLs. They are on Drive in their own right.'],
    ['voice-cache/, logs/', 'SKIP_DIRS — transient, regenerate themselves'],
    ['.env', 'never in DATA_DIR; it is the passwords and API keys. Keep a copy somewhere else.'],
];

// ── VALIDATE EVERYTHING FIRST ────────────────────────────────────────────
// Returns { ok, errors[], warnings[], meta, storeCount }. Errors mean do not
// write. Warnings mean write, and tell them.
//
// Nothing here throws: a corrupt archive is an expected input, not a bug, and
// the operator needs a list of what is wrong rather than the first problem.
function validateArchive(archive) {
    const errors = [];
    const warnings = [];

    if (!archive || typeof archive !== 'object' || Array.isArray(archive)) {
        return { ok: false, errors: ['the archive is not a JSON object'], warnings, meta: null, storeCount: 0 };
    }
    const meta = archive._meta || null;
    if (!meta || typeof meta !== 'object') {
        errors.push('no _meta block — this is not a Jarvis backup');
    } else {
        if (meta.kind !== KIND) {
            errors.push(`_meta.kind is ${JSON.stringify(meta.kind)}, expected ${JSON.stringify(KIND)}`);
        }
        if (!SUPPORTED_VERSIONS.includes(meta.version)) {
            // An unknown version is refused rather than attempted. A future
            // archive may store things differently, and a hopeful restore of a
            // format this code does not understand is how you get a directory
            // that looks restored and is not.
            errors.push(`_meta.version ${JSON.stringify(meta.version)} is not one this code understands `
                + `(${SUPPORTED_VERSIONS.join(', ')})`);
        }
        if (!meta.taken_at) warnings.push('_meta.taken_at is missing — the archive does not say when it was taken');
    }

    const stores = archive.stores;
    if (!stores || typeof stores !== 'object' || Array.isArray(stores)) {
        errors.push('no stores object — there is nothing to restore');
        return { ok: false, errors, warnings, meta, storeCount: 0 };
    }

    const names = Object.keys(stores);
    if (!names.length) errors.push('the stores object is empty');

    for (const rel of names) {
        if (!safeRel(rel)) errors.push(`refusing the store name ${JSON.stringify(rel)} — it is not a safe relative .json path`);
    }

    // ── THE ARCHIVE'S OWN RECORD OF WHAT WAS WRONG THAT NIGHT ────────────
    // buildArchive records unreadable stores in _meta.problems and keeps them
    // OUT of stores. Restoring from such an archive is often still the right
    // move — but silently is not, because the store it could not read is
    // exactly the one that will be missing afterwards.
    if (meta && Array.isArray(meta.problems) && meta.problems.length) {
        warnings.push(`the archive recorded ${meta.problems.length} unreadable store(s) when it was taken: `
            + meta.problems.map((p) => p && p.path).filter(Boolean).join(', ')
            + ' — these are NOT in it and will not come back');
    }
    if (meta && Array.isArray(meta.critical_vanished) && meta.critical_vanished.length) {
        warnings.push(`critical stores had VANISHED when this was taken: ${meta.critical_vanished.join(', ')}`);
    }

    // Cross-check the manifest against what is actually here. These two
    // disagreeing means the archive was edited or truncated after it was
    // written, and that is worth refusing to guess about.
    if (meta && Array.isArray(meta.stores_present)) {
        const listed = new Set(meta.stores_present);
        const actual = new Set(names);
        const missing = [...listed].filter((n) => !actual.has(n));
        const extra = [...actual].filter((n) => !listed.has(n));
        if (missing.length) warnings.push(`_meta.stores_present names ${missing.length} store(s) that are not in the file: ${missing.slice(0, 5).join(', ')}`);
        if (extra.length) warnings.push(`${extra.length} store(s) are present but not named in _meta.stores_present: ${extra.slice(0, 5).join(', ')}`);
    }

    return { ok: errors.length === 0, errors, warnings, meta, storeCount: names.length };
}

// ── WHAT WOULD HAPPEN, WITHOUT DOING IT ──────────────────────────────────
// The thing the operator reads before saying yes. Byte counts come from the
// same serialisation applyRestore will use, so the plan cannot differ from
// the act.
function planRestore(archive, targetDir) {
    const v = validateArchive(archive);
    const writes = [];
    const dirs = new Set();
    // ── SERIALISING IS PART OF VALIDATION, NOT PART OF WRITING ───────────
    // Found by tests/restore-drill.js section F. This loop used to call
    // serialise() bare, so a store that JSON.stringify cannot handle threw
    // out of planRestore — which meant the DRY RUN crashed with
    // "Converting circular structure to JSON" and no store name, and
    // applyRestore reported a raw serialisation error instead of its own
    // "nothing was moved into place". The operator reading that cannot tell
    // whether the directory was touched.
    //
    // A store that cannot be written is a reason to refuse the archive, in
    // the same list as a bad name or a wrong version, and it is refused
    // before anything is staged.
    const errors = [...v.errors];
    if (v.ok) {
        for (const [rel, value] of Object.entries(archive.stores)) {
            const safe = safeRel(rel);
            if (!safe) continue;
            let body;
            try { body = serialise(value); }
            catch (e) {
                errors.push(`the store ${JSON.stringify(safe)} cannot be written: ${e.message.split('\n')[0]}`);
                continue;
            }
            writes.push({ rel: safe, bytes: Buffer.byteLength(body, 'utf8') });
            const d = path.dirname(safe);
            if (d && d !== '.') dirs.add(d);
        }
    }
    writes.sort((a, b) => a.rel.localeCompare(b.rel));
    return {
        ...v,
        ok: errors.length === 0,
        errors,
        targetDir,
        writes,
        dirs: [...dirs].sort(),
        totalBytes: writes.reduce((t, w) => t + w.bytes, 0),
        notInArchive: NOT_IN_ARCHIVE,
        targetState: inspectTarget(targetDir),
    };
}

// ── 2-SPACE JSON, THE SAME AS EVERY WRITER IN THIS REPO ──────────────────
// helpers/json.js writes with JSON.stringify(data, null, 2). Restoring with
// different formatting would make every store show as changed to anything
// comparing files, and the first thing anyone does after a restore is compare.
const serialise = (value) => JSON.stringify(value, null, 2) + '\n';

function inspectTarget(targetDir) {
    try {
        if (!fs.existsSync(targetDir)) return { exists: false, empty: true, entries: 0, jsonFiles: 0 };
        const entries = fs.readdirSync(targetDir);
        const jsonFiles = entries.filter((e) => e.endsWith('.json')).length;
        return { exists: true, empty: entries.length === 0, entries: entries.length, jsonFiles };
    } catch (e) {
        return { exists: null, empty: null, entries: 0, jsonFiles: 0, error: e.message };
    }
}

// ── DO IT, ALL OR NOTHING ────────────────────────────────────────────────
// Staged in a sibling temp directory and moved into place, because the state
// this must never produce is "some stores are last night's and some are
// today's". That is worse than no restore: every figure reads plausibly and
// the books do not balance, and nobody can tell which half is which.
//
// `onto` is deliberately explicit:
//   'empty'    — refuse unless the target is absent or empty (the default)
//   'replace'  — move the existing directory aside first, keeping it
//
// There is no mode that deletes anything. Even 'replace' preserves what was
// there, under a dated name, and returns where it put it.
function applyRestore(archive, targetDir, { onto = 'empty' } = {}) {
    if (!targetDir || typeof targetDir !== 'string') throw new Error('a target directory is required');
    const plan = planRestore(archive, targetDir);
    if (!plan.ok) {
        throw new Error('refusing to restore — ' + plan.errors.join('; '));
    }

    const state = plan.targetState;
    if (state.exists && !state.empty && onto !== 'replace') {
        throw new Error(`${targetDir} already holds ${state.entries} entr${state.entries === 1 ? 'y' : 'ies'}. `
            + "Pass onto:'replace' to move it aside first, or restore into a new directory.");
    }

    const parent = path.dirname(path.resolve(targetDir));
    fs.mkdirSync(parent, { recursive: true });
    // Same parent, so the rename below is a rename and not a cross-device copy.
    const staging = fs.mkdtempSync(path.join(parent, '.jarvis-restore-'));

    const started = Date.now();
    let written = 0;
    try {
        for (const w of plan.writes) {
            const abs = path.join(staging, w.rel);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, serialise(archive.stores[w.rel]), 'utf8');
            written += 1;
        }
    } catch (e) {
        try { fs.rmSync(staging, { recursive: true, force: true }); } catch (x) {}
        throw new Error(`restore failed after ${written} store(s), nothing was moved into place: ${e.message}`);
    }

    // Everything is written. Now the swap.
    let movedAsideTo = null;
    if (state.exists && !state.empty) {
        movedAsideTo = `${path.resolve(targetDir)}.before-restore-${stamp()}`;
        fs.renameSync(path.resolve(targetDir), movedAsideTo);
    } else if (state.exists) {
        // Exists and empty — rmdir so the rename can take the name.
        try { fs.rmdirSync(path.resolve(targetDir)); } catch (e) { /* handled by the rename failing */ }
    }
    fs.renameSync(staging, path.resolve(targetDir));

    return {
        targetDir: path.resolve(targetDir),
        storesWritten: written,
        bytes: plan.totalBytes,
        movedAsideTo,
        ms: Date.now() - started,
        meta: plan.meta,
        warnings: plan.warnings,
        notInArchive: NOT_IN_ARCHIVE,
    };
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// ── VERIFY, AGAINST THE ARCHIVE RATHER THAN AGAINST HOPE ─────────────────
// Reads the restored directory back and compares it to the archive it came
// from. Separate from applyRestore on purpose: "the write returned without
// throwing" and "the data is there" are different claims, and only the second
// one is the drill.
function verifyRestore(archive, targetDir) {
    const problems = [];
    let checked = 0;
    for (const [rel, expected] of Object.entries((archive && archive.stores) || {})) {
        const safe = safeRel(rel);
        if (!safe) continue;
        const abs = path.join(targetDir, safe);
        let got;
        try { got = JSON.parse(fs.readFileSync(abs, 'utf8')); }
        catch (e) { problems.push({ store: safe, error: e.message }); continue; }
        if (JSON.stringify(got) !== JSON.stringify(expected)) {
            problems.push({ store: safe, error: 'content differs from the archive' });
            continue;
        }
        checked += 1;
    }
    return { ok: problems.length === 0, checked, problems };
}

module.exports = {
    KIND, SUPPORTED_VERSIONS, NOT_IN_ARCHIVE,
    safeRel, validateArchive, planRestore, applyRestore, verifyRestore,
    serialise,
};
