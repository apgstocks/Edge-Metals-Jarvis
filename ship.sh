#!/usr/bin/env bash
# ── ship.sh — push this Mac's commits to GitHub ───────────────────────────
#
# THREE THINGS WENT WRONG ON 2026-09-10, IN ORDER, AND EACH HID THE NEXT.
#
# 1. WRONG MACHINE. Apsara ran `git push origin main` twice inside an SSH
#    session on the VM, where there is genuinely nothing to push. My
#    instructions were a block of shell whose only clue about which machine
#    was a "# from Jarvis_July" comment — which pastes anywhere and says
#    nothing. Hence the hostname check below.
#
# 2. DETACHED HEAD. Every commit that day — mine and hers — landed on a
#    detached HEAD, because I had run `git checkout <sha>` to compare test
#    results across a regression and never returned to the branch. So `git
#    push origin main` pushed the BRANCH called main, still sitting where it
#    was, and reported "Everything up-to-date" perfectly correctly while five
#    commits sat somewhere else.
#
# 3. A SCRIPT THAT CALLED THAT A SUCCESS. This one. `git push` exits 0 when
#    there is nothing to do, and the first version printed "✓ Pushed" on the
#    strength of the exit code alone. A false green is worse than a red: she
#    went and pulled on the VM, found nothing, and we lost another round trip.
#    It now reads what git actually SAYS, and verifies against the remote
#    afterwards rather than trusting either.
#
#   bash ship.sh
#
set -uo pipefail
cd "$(dirname "$0")" || exit 1

echo
echo "  Where am I?"
echo "     host: $(hostname)"
echo "     dir : $(pwd)"

if [[ "$(hostname)" == *jarvis-vm* ]]; then
    echo
    echo "  ✗ This is the VM."
    echo "    The commits are on the MAC. Open Terminal on the Mac (its prompt"
    echo "    will NOT say jarvis-vm) and run:"
    echo
    echo "        cd ~/Downloads/Jarvis_July && bash ship.sh"
    echo
    exit 1
fi

git rev-parse --short HEAD >/dev/null 2>&1 || { echo "  ✗ not a git checkout"; exit 1; }
HEAD_SHA=$(git rev-parse --short HEAD)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
REMOTE=$(git ls-remote origin main 2>/dev/null | cut -c1-7)
DIRTY=$(git status --porcelain | grep -v '^??' | wc -l | tr -d ' ')

echo
echo "  What is here"
echo "     HEAD     : $HEAD_SHA  (branch: $BRANCH)"
echo "     GitHub   : ${REMOTE:-unreachable}"
[ "$DIRTY" != "0" ] && echo "     WARNING  : $DIRTY uncommitted file(s) — commit them first or they stay behind"

# ── DETACHED HEAD, THE ONE THAT COST US FOUR ROUND TRIPS ─────────────────
# Fixed rather than reported, but ONLY when it is a clean fast-forward: main
# must be an ancestor of HEAD, so moving it forward cannot orphan anything.
# Anything else stops and asks, because reconciling diverged branches is not
# a thing a push script should decide on its own.
if [ "$BRANCH" = "HEAD" ]; then
    echo
    echo "  ! Detached HEAD — your commits are not on any branch."
    if git merge-base --is-ancestor main HEAD 2>/dev/null; then
        AHEAD=$(git rev-list --count main..HEAD)
        echo "    main is $AHEAD commit(s) behind and is a clean ancestor, so"
        echo "    moving it forward loses nothing. Doing that now."
        git branch -f main HEAD && git checkout main || { echo "  ✗ could not move main"; exit 1; }
        BRANCH=main
    else
        echo "    main has diverged from HEAD — this needs a human. Look at:"
        echo "        git log --oneline --graph --all -15"
        exit 1
    fi
fi

if [ "$BRANCH" != "main" ]; then
    echo
    echo "  ✗ You are on branch '$BRANCH', not main. Push it deliberately:"
    echo "        git push origin $BRANCH"
    exit 1
fi

AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo "?")
if [ "$AHEAD" = "0" ]; then
    echo
    echo "  Nothing to push — GitHub already has $HEAD_SHA."
    exit 0
fi

echo
echo "  Pushing $AHEAD commit(s) to origin/main…"
OUT=$(git push origin main 2>&1); RC=$?
echo "$OUT" | sed 's/^/     /'

# ── VERIFIED AGAINST THE REMOTE, NOT AGAINST THE EXIT CODE ──────────────
# git exits 0 for "Everything up-to-date". Asking GitHub what it has now is
# the only answer that cannot be a false green.
NOW=$(git ls-remote origin main 2>/dev/null | cut -c1-7)
echo
if [ "$NOW" = "$HEAD_SHA" ]; then
    echo "  ✓ GitHub now has $NOW. Next, ON THE VM:"
    echo
    echo "        cd ~/Edge-Metals-Jarvis && git pull && pm2 restart jarvis --update-env"
    echo "        bash scripts/whats-running.sh"
    echo
    echo "    Then reload the dashboard. The Bills tab footer shows the build"
    echo "    it is running — it should say $HEAD_SHA."
else
    echo "  ✗ GitHub is still on ${NOW:-unknown}, not $HEAD_SHA. Nothing shipped."
    [ $RC -ne 0 ] && echo "    git exited $RC — the message above says why."
    echo "    If it asked for a username or token, that is credentials on this"
    echo "    Mac, not a problem with the code."
    exit 1
fi
