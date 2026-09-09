#!/usr/bin/env bash
# ── ship.sh — push this Mac's commits to GitHub ───────────────────────────
#
# Apsara ran `git push origin main` twice on 2026-09-10 and both times it said
# "Everything up-to-date". Both times she was inside an SSH session on the VM,
# where there is genuinely nothing to push — the commits live on the Mac. The
# instructions I gave were a block of shell with "# from Jarvis_July" as a
# COMMENT, which pastes into any terminal quite happily and says nothing.
#
# So this refuses to run anywhere but the Mac checkout, and says plainly what
# it found. A script that can only be run in the right place beats a comment
# saying which place is right.
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

LOCAL=$(git rev-parse --short HEAD 2>/dev/null) || { echo "  ✗ not a git checkout"; exit 1; }
REMOTE=$(git ls-remote origin main 2>/dev/null | cut -c1-7)
AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo "?")
DIRTY=$(git status --porcelain | grep -v '^??' | wc -l | tr -d ' ')

echo
echo "  What is here"
echo "     this Mac : $LOCAL"
echo "     GitHub   : ${REMOTE:-unreachable}"
echo "     ahead by : $AHEAD commit(s)"
[ "$DIRTY" != "0" ] && echo "     WARNING  : $DIRTY uncommitted file(s) — those will NOT be pushed"

if [ "$AHEAD" = "0" ]; then
    echo
    echo "  Nothing to push — GitHub already has this."
    exit 0
fi

echo
echo "  Pushing $AHEAD commit(s) to origin/main…"
if git push origin main; then
    echo
    echo "  ✓ Pushed. Now, ON THE VM:"
    echo
    echo "        cd ~/Edge-Metals-Jarvis && git pull && pm2 restart jarvis --update-env"
    echo "        bash scripts/whats-running.sh"
    echo
    echo "    Then reload the dashboard. The Bills tab footer will show the"
    echo "    build it is running — check it says $LOCAL."
else
    echo
    echo "  ✗ Push failed. If it asked for a username or a token, that is a"
    echo "    credentials problem on this Mac, not a problem with the code."
fi
