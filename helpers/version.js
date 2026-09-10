// ── helpers/version.js — what is ACTUALLY running ────────────────────────
//
// Apsara, 2026-09-08: "if its in guthub,then its in VM"
//
// We had this argument because neither of us could check. I told her the VM
// was stale; she told me it was not. Both of us were reasoning from what we
// expected rather than from anything observable, and I had already been wrong
// once in the same conversation (I said ~40 commits were unpushed — they were
// pushed; origin/main was current).
//
// A deployment you cannot inspect is a deployment you argue about. There is
// no auto-deploy in this repo — the only GitHub workflow is an iOS build
// check, there is no webhook, no cron, no pull hook — so GitHub and the VM
// agree only when someone makes them agree. But that is an argument from
// absence, and absence is exactly what she should not have to take my word
// for. If she has a puller on the box, it is outside the repo and I cannot
// see it from here.
//
// So: make it observable. One line in /healthz that says which commit is
// answering, and the question is settled in five seconds by either of us,
// forever, without a single assumption.
//
// WHY IT SHELLS OUT ONCE, AT BOOT, AND NEVER AGAIN
// -----------------------------------------------
// The alternative is a build stamp written by a deploy step — better, but it
// only exists if the deploy step runs, and the whole point here is not
// trusting that a step ran. `git rev-parse` asks the working tree the process
// was started from, which is the one thing that cannot be stale. Cached at
// module load so no request ever pays for it, and every failure mode returns
// null rather than throwing, because a health endpoint that can crash is
// worse than one that says "unknown".
//
// JARVIS_COMMIT is honoured first for the container case, where the .git
// directory is deliberately not shipped.

const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── EMPTY OUTPUT IS NOT A FAILURE ────────────────────────────────────────
// `|| null` collapsed the two apart cases into one. `git status --porcelain`
// prints NOTHING when the tree is clean, so a clean checkout came back null
// and `dirty` became null — the same answer as "there is no git here".
//
// That is exactly backwards for the moment this endpoint is read: on the VM
// straight after a pull, when the tree IS clean and the question is whether
// it is. Found 2026-09-10 when a commit left the tree clean for the first
// time in the run and tests/api-health went red.
//
// So: allowEmpty says whether '' is a real answer for that command. It is for
// status; it is not for rev-parse, where empty can only mean failure.
function git(args, { allowEmpty = false } = {}) {
    try {
        const out = execFileSync('git', args, {
            cwd: ROOT, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return allowEmpty ? out : (out || null);
    } catch (e) {
        // No git, no .git, a shallow copy, a timeout — all the same answer.
        return null;
    }
}

const BOOTED_AT = new Date().toISOString();

const commit = process.env.JARVIS_COMMIT || git(['rev-parse', 'HEAD']);
const committedAt = process.env.JARVIS_COMMIT ? null : git(['log', '-1', '--format=%cI']);
const subject = process.env.JARVIS_COMMIT ? null : git(['log', '-1', '--format=%s']);
// Uncommitted edits on the box are worth knowing about: it means the running
// code is not any commit at all, and "git pull" may refuse or merge oddly.
const status = process.env.JARVIS_COMMIT ? null : git(['status', '--porcelain'], { allowEmpty: true });
const dirty = status === null ? null : status.length > 0;

const info = {
    commit,
    short: commit ? commit.slice(0, 7) : null,
    committed_at: committedAt,
    subject,
    dirty,
    booted_at: BOOTED_AT,
};

function running() { return Object.assign({}, info); }

// One line for the boot log. If she restarts and this does not change, the
// pull did not take — which is the exact question that started this.
function bootLine() {
    if (!info.short) return '[VERSION] unknown (no git metadata) — booted ' + BOOTED_AT;
    return `[VERSION] ${info.short}${info.dirty ? '+dirty' : ''} `
         + `${info.committed_at || ''} ${info.subject ? '— ' + info.subject.slice(0, 60) : ''}`;
}

module.exports = {
    running, bootLine,
    // Exported ONLY so the empty-output path can be tested without depending
    // on whether the checkout happens to be clean at that moment — which is
    // what let the null-on-clean bug sit green for a fortnight.
    git,
};
