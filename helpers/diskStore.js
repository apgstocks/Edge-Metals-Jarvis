// ── helpers/diskStore.js — the one Disk for this process ────────────────────
// helpers/disk says "one Disk per process: two on the same directory would diverge
// in memory". This is where that is kept true. It lives under DATA_DIR like every
// other store, so a test that sets DATA_DIR is isolated by default.
const path = require('path');
const cfg = require('../config');
const disk = require('./disk');

let instance = null;

function getDisk() {
    if (!instance) instance = disk.open({ dir: path.join(cfg.DATA_DIR, 'disk') });
    return instance;
}

/** Tests only: drop the cached instance so the next call re-reads the files. */
function reset() { instance = null; }

module.exports = { getDisk, reset };
