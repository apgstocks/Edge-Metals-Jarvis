#!/usr/bin/env bash
# ── scripts/repo-lock.sh — one writer at a time in this working tree ────────
#
# WHY THIS EXISTS. Three times on 2026-08-29, work from one Claude session was
# swept into another session's commit: the confidence fix landed inside
# "logs", the file-guard inside "Listening starts on open", the summary fix
# inside "Fix the assertion I left failing". Nothing was lost and the suite
# stayed green — but the reasoning behind each change is now filed under a
# commit message about microphones, and neither session could tell which
# edits were its own.
#
# The cause is structural, not careless: two agents share ONE working tree, so
# `git add -A` in either one stages whatever the other is halfway through.
# Branches do not help — a branch switches the tree both are standing in.
# Separate git worktrees would fix it properly; that needs both sessions
# pointed at different directories, which is a change to how they are started.
#
# This is the small thing that works today: a lease on the tree, enforced by a
# pre-commit hook, so the second writer is TOLD rather than silently winning.
#
# DESIGN RULES, in order of importance:
#   1. It must never wedge the repo. The lease expires on its own (TTL below),
#      any error fails OPEN, and there is a one-word override.
#   2. It must explain itself at the moment it blocks, because the reader is
#      usually another agent that has never seen this file.
#   3. It lives in .git/, so it is never committed and never reaches the VM.
#
#   scripts/repo-lock.sh install          # add the pre-commit hook (once)
#   scripts/repo-lock.sh acquire "what"   # take the lease before you edit
#   scripts/repo-lock.sh release          # give it back when committed
#   scripts/repo-lock.sh status
#   scripts/repo-lock.sh steal            # take it from an expired/dead holder
#
# Override for one commit, when you know what you are doing:
#   JARVIS_UNLOCKED=1 git commit ...

set -uo pipefail

GIT_DIR="$(git rev-parse --git-dir 2>/dev/null)" || { echo "not a git repo"; exit 0; }
LOCK="$GIT_DIR/jarvis-tree.lock"
TTL_SECONDS=1200          # 20 minutes. A session that dies mid-edit must not
                          # hold the tree hostage until someone notices.

now()   { date +%s; }
owner() { [ -f "$LOCK/owner" ] && cat "$LOCK/owner" 2>/dev/null || echo "unknown"; }
what()  { [ -f "$LOCK/what" ]  && cat "$LOCK/what"  2>/dev/null || echo "(no description)"; }
since() { [ -f "$LOCK/at" ]    && cat "$LOCK/at"    2>/dev/null || echo 0; }
age()   { echo $(( $(now) - $(since) )); }
expired() { [ "$(age)" -gt "$TTL_SECONDS" ]; }
# RELEASE MUST NOT DEPEND ON DELETION. Found the hard way: rm -rf on the lock
# directory failed silently in a sandbox that forbids unlink, so `release`
# reported success and the tree stayed locked until the TTL ran out. A lease
# is therefore released by ZEROING its timestamp — a write, which works
# everywhere — and the directory is only removed as a best-effort tidy-up.
# at=0 reads as ancient to the hook, which already fails open on an expired
# lease, so the two agree without either needing to know about the other.
released() { [ "$(since)" = "0" ]; }
free()     { [ ! -d "$LOCK" ] || released; }
# IDENTITY MUST BE STABLE ACROSS INVOCATIONS. The first version ended this in
# "-$$", which looked reasonable and broke immediately: every shell call is a
# new process, so the pid changed between `acquire` and the pre-commit hook and
# the holder never recognised its own lease — the lock blocked the session that
# took it. A session is not a process.
#
# $HOME is the stable, session-scoped thing available in both places (each
# agent session gets its own home). Set JARVIS_AGENT to something readable if
# two sessions ever share a home; without it they would look like one holder
# and the lease would never block, which fails OPEN — the safe direction.
me()    { echo "${JARVIS_AGENT:-$(basename "${HOME:-local}")@$(hostname -s 2>/dev/null || echo local)}"; }

case "${1:-status}" in

  install)
    HOOK="$GIT_DIR/hooks/pre-commit"
    if [ -e "$HOOK" ] && ! grep -q "jarvis-tree.lock" "$HOOK" 2>/dev/null; then
        echo "REFUSING: a pre-commit hook already exists and is not this one."
        echo "  $HOOK"
        echo "Merge them by hand — silently replacing someone's hook is how this"
        echo "whole class of problem started."
        exit 1
    fi
    mkdir -p "$GIT_DIR/hooks"
    cat > "$HOOK" <<'HOOKEOF'
#!/usr/bin/env bash
# Installed by scripts/repo-lock.sh. Refuses a commit while another session
# holds the working tree. FAILS OPEN on any error — see the design rules in
# scripts/repo-lock.sh.
set -uo pipefail
[ -n "${JARVIS_UNLOCKED:-}" ] && exit 0
GIT_DIR="$(git rev-parse --git-dir 2>/dev/null)" || exit 0
LOCK="$GIT_DIR/jarvis-tree.lock"
[ -d "$LOCK" ] || exit 0
TTL=1200
AT="$(cat "$LOCK/at" 2>/dev/null || echo 0)"
OWNER="$(cat "$LOCK/owner" 2>/dev/null || echo unknown)"
WHAT="$(cat "$LOCK/what" 2>/dev/null || echo '(no description)')"
NOW="$(date +%s)"
case "$AT" in ''|*[!0-9]*) exit 0 ;; esac          # unreadable -> fail open
[ $(( NOW - AT )) -gt "$TTL" ] && exit 0            # expired    -> fail open
# Must match me() above exactly — see the note there on why no pid.
ME="${JARVIS_AGENT:-$(basename "${HOME:-local}")@$(hostname -s 2>/dev/null || echo local)}"
[ "$OWNER" = "$ME" ] && exit 0                      # mine       -> allow
cat >&2 <<MSG

  ┌─ COMMIT BLOCKED ─────────────────────────────────────────────────────┐

  Another session is mid-edit in this SAME working tree, and committing
  now would sweep its half-finished files into your commit. That has
  already happened three times in this repo.

    holder : $OWNER
    doing  : $WHAT
    held   : $(( (NOW - AT) / 60 )) min   (auto-expires at 20)

  Wait for it, or if that session is gone:

    scripts/repo-lock.sh status
    scripts/repo-lock.sh steal

  To commit anyway — only if you have checked 'git diff --cached' and
  every staged file is genuinely yours:

    JARVIS_UNLOCKED=1 git commit ...

  └──────────────────────────────────────────────────────────────────────┘

MSG
exit 1
HOOKEOF
    chmod +x "$HOOK"
    echo "installed: $HOOK"
    ;;

  acquire)
    DESC="${2:-unspecified work}"
    if released; then                            # a released lease is reusable
        me > "$LOCK/owner"; now > "$LOCK/at"; echo "$DESC" > "$LOCK/what"
        echo "acquired by $(owner) — $DESC"
        exit 0
    fi
    if mkdir "$LOCK" 2>/dev/null; then
        me   > "$LOCK/owner"
        now  > "$LOCK/at"
        echo "$DESC" > "$LOCK/what"
        echo "acquired by $(owner) — $DESC"
        exit 0
    fi
    if [ "$(owner)" = "$(me)" ]; then
        now > "$LOCK/at"; echo "$DESC" > "$LOCK/what"
        echo "already yours, lease renewed — $DESC"
        exit 0
    fi
    if expired; then
        echo "held by $(owner) for $(( $(age) / 60 )) min — EXPIRED, taking it."
        me > "$LOCK/owner"; now > "$LOCK/at"; echo "$DESC" > "$LOCK/what"
        exit 0
    fi
    echo "BUSY — $(owner) has it ($(( $(age) / 60 )) min): $(what)"
    exit 1
    ;;

  release)
    free && { echo "not held"; exit 0; }
    if [ "$(owner)" != "$(me)" ] && [ "${2:-}" != "--force" ]; then
        echo "held by $(owner), not you. Use --force if that session is gone."
        exit 1
    fi
    echo 0 > "$LOCK/at" 2>/dev/null
    echo "released" > "$LOCK/owner" 2>/dev/null
    rm -rf "$LOCK" 2>/dev/null || true          # tidy-up only; never load-bearing
    if free; then echo "released"; else
        echo "RELEASE FAILED — the lease is still held. This must never happen"
        echo "silently, so: $LOCK is not writable. Remove it by hand."
        exit 1
    fi
    ;;

  steal)
    [ -d "$LOCK" ] || { echo "not held"; exit 0; }
    echo "taking it from $(owner) (held $(( $(age) / 60 )) min: $(what))"
    # Overwrite in place. Same reason release() does not delete: rm can be
    # forbidden, and a steal that half-worked would be worse than one that
    # never ran.
    mkdir -p "$LOCK"
    me > "$LOCK/owner"; now > "$LOCK/at"; echo "${2:-stolen}" > "$LOCK/what"
    echo "now yours"
    ;;

  status)
    if free; then echo "free"; exit 0; fi
    echo "holder : $(owner)"
    echo "doing  : $(what)"
    echo "held   : $(( $(age) / 60 )) min $(expired && echo '(EXPIRED — steal it)')"
    echo "you    : $(me)"
    ;;

  *) echo "usage: repo-lock.sh {install|acquire <what>|release|steal|status}"; exit 2 ;;
esac
