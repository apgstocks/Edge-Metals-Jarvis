# Self-build: Jarvis changes its own code, you approve (2026-11-09)

New files only: `helpers/selfBuild.js`, `scripts/self-build.js`, `tests/self-build.js`. Not wired to WhatsApp yet. Nothing deploys.

Flow: `request` -> private branch + worktree from HEAD -> a coder edits only there -> **the code** checks the real diff
(protected files, existing tests, size, secrets, links) -> whole suite runs in the worktree, compared with the known-red
baseline -> a plain-words summary (written by the code; the coder's plan/notes are labelled "its own words, not verified")
-> `approve` (manager only, only the exact commit that was tested, refuses over your uncommitted edits) merges locally ->
you run `ship.sh` -> `rollback` makes a revert commit.

Never a coder's job: .env, data/, ship.sh, CLAUDE.md, package.json/lock, credentials, the guard itself. New tests are
allowed; editing or deleting an existing test is blocked unless that build is explicitly started with test edits allowed.

Use: `node scripts/self-build.js baseline` once on a clean checkout, then `request "<ask>"`, `list`, `show <id>`, `approve <id>`.
The default coder runs the Claude Code CLI (`claude -p`) in the worktree: **untested here** (cannot run in the sandbox); the
harness is tested end to end with a stub coder. Needs the CLI and its login on the machine that runs builds.

Limits: builds start from HEAD, so uncommitted work is not in the base; the suite runs one file at a time (slow); the
guard cannot judge whether a change is *wise*, only whether it is allowed and green; one build at a time is assumed.
Not done: the WhatsApp trigger ("build: ...", "yes build <id>") — it needs a new classifier action in brain.js.

## Over WhatsApp (added the same day)
Exact words, manager only, never chosen by the AI (policy rule in `brain.js`, `helpers/selfBuildCommands.js`):
`build: <ask>` · `yes build <id>` · `no build <id>` · `rollback build <id>` · `builds`.
**Off by default**: set `JARVIS_SELF_BUILD=1` on the machine and restart to enable. A build runs in the background (one at
a time); she gets an "on it" at once and the summary when it is ready. Two independent gates (policy rule + route check) stop
anyone but the manager and any AI-chosen "self_build". Tests: `tests/self-build-whatsapp.js` (real `brain.process`, stub coder).
