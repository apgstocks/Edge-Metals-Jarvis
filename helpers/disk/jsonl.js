// ── helpers/disk/jsonl.js — the append-only file primitive ───────────────────
// Every layer of the disk is one of these. A line is only ever APPENDED; a
// correction is a new line that refers to an old one, never an edit. That is
// the same design as helpers/outcomes.js and for the same reason: every
// data-loss scar in this repo is one write clobbering another, and a file that
// is only appended to cannot clobber anything.
//
// Two crash cases are handled here rather than left to callers:
//   - a crash mid-write leaves a last line with no newline. The next append
//     starts a fresh line instead of gluing onto the broken one.
//   - a line that does not parse is COUNTED and skipped, never fatal. One bad
//     line must not take the whole memory down at boot.
const fs = require('fs');
const path = require('path');

function append(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let prefix = '';
    try {
        const st = fs.statSync(file);
        if (st.size > 0) {
            const fd = fs.openSync(file, 'r');
            const b = Buffer.alloc(1);
            fs.readSync(fd, b, 0, 1, st.size - 1);
            fs.closeSync(fd);
            if (b[0] !== 10) prefix = '\n';
        }
    } catch (_) { /* no file yet */ }
    fs.appendFileSync(file, prefix + JSON.stringify(obj) + '\n');
}

function readAll(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return { rows: [], bad: 0 }; }
    const rows = [];
    let bad = 0;
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch (_) { bad++; }
    }
    return { rows, bad };
}

function isEmpty(file) {
    try { return fs.statSync(file).size === 0; } catch (_) { return true; }
}

// Whole-file replace, atomic: a crash leaves the old file or the new one.
function writeAtomic(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
}

module.exports = { append, readAll, isEmpty, writeAtomic };
