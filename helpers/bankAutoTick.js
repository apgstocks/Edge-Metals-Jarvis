// ── helpers/bankAutoTick.js — the overnight tick nobody had written ──────
//
// Apsara, 2026-10-08: "when Jarvis is certain a bank row matches a payment
// already recorded, it should tick it off by itself (exact single matches
// only) rather than wait for her." Task #187.
//
// ── EVERY PIECE OF THIS ALREADY EXISTED EXCEPT THE JOB ───────────────────
// helpers/bankOut.js decided the RULE and named it autoTickable(), kept "as
// a named function with its own checks so loosening it cannot happen quietly
// in a diff that reads like a tidy-up". helpers/bankLedger.js wrote the
// WRITE, setMatched(..., { how: 'auto' }), reversible with a history line.
// Both files refer to "the overnight auto-tick" in the present tense. It did
// not exist. This is it, and it adds no new judgement of its own.
//
// ── WHY A MATCH IS THE ONE THING SAFE TO AUTOMATE ────────────────────────
// bankLedger.js states it and it is worth restating where the automation
// lives: "A MATCH CREATES NOTHING. It ties a bank row to a record that
// already exists, so no money moves and no figure changes." Post is the
// other button and it CREATES a record — this job must never touch one.
// Deposits have no `auto` flag at all (bankReview.fromDeposit does not set
// one), and that is deliberate: a deposit match applies money to an invoice.
// Withdrawals only.
//
// ── IT IS ALLOWED TO BE WRONG, AND THAT IS THE DESIGN ────────────────────
// Every tick is stored with how:'auto' and a history line, so the screen can
// name what Jarvis did by itself and she can undo it. Her words again:
// "an auto-tick she never saw is the one most worth being able to find".
//
//   const r = await run();                 // tick them
//   const r = await run({ dryRun: true }); // say what it WOULD tick
const bankLedger = require('./bankLedger');
const BO = require('./bankOut');
const BR = require('./bankReview');
const BRec = require('./bankReconcile');
const BB = require('./booksBuild');

// ── WHAT IT WOULD TICK ───────────────────────────────────────────────────
// Rebuilt from the stores every time, exactly as POST /api/bank/review/match
// does, rather than trusting a cached queue. A row that moved on since the
// last sweep must not be ticked against a stale idea of itself — the same
// world-moved guard, for the same reason.
function candidates() {
    const rows = bankLedger.list();
    const built = BB.build({});
    const results = BRec.bankAccounts()
        .flatMap((a) => BO.sweep({ rows, lines: built.lines, code: a.code }).results);
    const queued = BR.queue({ withdrawalResults: results }).rows;

    return queued.filter((r) => {
        if (!r || r.direction !== 'out') return false;      // deposits are never auto
        if (r.state !== 'match') return false;              // choose/ask/add are hers
        if (!r.auto) return false;                          // bankOut.autoTickable said no
        // Already ticked — a second pass must be a no-op, not a second
        // history line saying the same thing.
        const live = rows.find((x) => x && x.id === r.id);
        if (!live || live.matched) return false;
        return true;
    });
}

// ── THE RUN ──────────────────────────────────────────────────────────────
// One row at a time through bankLedger.markMatched, the SAME call the button
// makes. Not a bulk write: a bulk path would be a second way to tick a row,
// and two ways to do one thing is how they drift.
//
// A failure on one row does not stop the rest, and is reported rather than
// swallowed — a job that silently ticks nine of ten is worse than one that
// ticks none, because the tenth looks done.
async function run({ dryRun = false, limit = 500 } = {}) {
    let rows;
    try { rows = candidates(); }
    catch (e) {
        return { ok: false, error: String((e && e.message) || e), ticked: [], failed: [], dryRun };
    }
    const take = rows.slice(0, limit);
    const ticked = [];
    const failed = [];

    for (const r of take) {
        const keys = ((r.match || {}).payments || []).map((p) => p.key);
        // No keys means nothing to tie it to. autoTickable should have
        // refused already; belt and braces, because this writes.
        if (!keys.length) {
            failed.push({ id: r.id, why: 'the match carried no payment key' });
            continue;
        }
        const entry = {
            id: r.id, date: r.date, amount: r.amount,
            descriptor: r.descriptor, why: r.why, keys,
        };
        if (dryRun) { ticked.push(entry); continue; }
        try {
            await bankLedger.markMatched(r.id, { keys, why: r.why },
                { by: null, how: 'auto' });
            ticked.push(entry);
        } catch (e) {
            failed.push({ id: r.id, why: String((e && e.message) || e) });
        }
    }

    return {
        ok: true, dryRun,
        ticked, failed,
        considered: rows.length,
        truncated: Math.max(0, rows.length - take.length),
    };
}

// A sentence for a log line or a digest. Silent-when-nothing is the caller's
// choice, not this function's — it always says what happened.
function summary(res) {
    if (!res || res.ok === false) return `auto-tick could not run: ${(res || {}).error || 'unknown'}`;
    if (!res.ticked.length && !res.failed.length) return 'auto-tick: nothing was certain enough';
    const bits = [];
    if (res.ticked.length) {
        bits.push(`${res.dryRun ? 'would tick' : 'ticked'} ${res.ticked.length} `
            + `withdrawal${res.ticked.length === 1 ? '' : 's'} against payments already recorded`);
    }
    if (res.failed.length) bits.push(`${res.failed.length} could not be ticked`);
    if (res.truncated) bits.push(`${res.truncated} more were left for the next run`);
    return 'auto-tick: ' + bits.join('; ');
}

module.exports = { run, candidates, summary };
