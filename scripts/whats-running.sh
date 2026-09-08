#!/usr/bin/env bash
# ── scripts/whats-running.sh ──────────────────────────────────────────────
# Apsara, 2026-09-08: "if its in guthub,then its in VM"
#
# Settles it with facts instead of either of us asserting. Compares three
# things that are usually assumed to be the same and often are not:
#
#   1. GitHub          what is on origin/main right now
#   2. the VM's files  what is checked out in ~/Edge-Metals-Jarvis
#   3. the VM's PROCESS what pm2 is actually serving
#
# 2 and 3 differ whenever a pull happened without a restart — Node read the
# files once, at boot, and has not looked since. That is the failure mode
# nobody sees, because `git log` on the box looks perfectly up to date.
#
# Run it ON THE VM. No arguments.

set -uo pipefail
REPO="${JARVIS_REPO:-$HOME/Edge-Metals-Jarvis}"
PORT="${JARVIS_PORT:-3000}"

echo
echo "  1. GitHub (origin/main)"
if REMOTE=$(git -C "$REPO" ls-remote origin main 2>/dev/null | cut -c1-7) && [ -n "$REMOTE" ]; then
    echo "     $REMOTE"
else
    REMOTE=""
    echo "     unreachable — no network, or no credentials for the remote"
fi

echo
echo "  2. Files checked out on this box ($REPO)"
LOCAL=$(git -C "$REPO" rev-parse --short=7 HEAD 2>/dev/null || echo "")
if [ -n "$LOCAL" ]; then
    DIRTY=$(git -C "$REPO" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    echo "     $LOCAL$([ "$DIRTY" != "0" ] && echo "  (+$DIRTY uncommitted file(s))")"
    git -C "$REPO" log -1 --format='     %cI  %s' 2>/dev/null
else
    echo "     not a git checkout"
fi

echo
echo "  3. The process pm2 is serving (:$PORT)"
SERVING=$(curl -s --max-time 5 "http://127.0.0.1:$PORT/healthz" 2>/dev/null \
          | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
BOOTED=$(curl -s --max-time 5 "http://127.0.0.1:$PORT/healthz" 2>/dev/null \
          | sed -n 's/.*"booted_at":"\([^"]*\)".*/\1/p')
if [ -n "$SERVING" ]; then
    echo "     $SERVING   (booted $BOOTED)"
else
    echo "     no answer on :$PORT — Jarvis is not running, or predates this check"
fi

echo
# ── The verdict, in the order the failures actually happen ────────────────
if [ -z "$SERVING" ]; then
    echo "  Cannot tell. Either Jarvis is down, or it is running a build from"
    echo "  before /healthz reported its version — which is itself the answer:"
    echo "  that build is older than 2026-09-08."
elif [ -n "$REMOTE" ] && [ "$LOCAL" != "$REMOTE" ]; then
    echo "  NOT PULLED. GitHub has $REMOTE, this box has $LOCAL."
    echo "    cd $REPO && git pull && npm install && pm2 restart jarvis"
elif [ "$SERVING" != "$LOCAL" ]; then
    echo "  PULLED BUT NOT RESTARTED. The files say $LOCAL, the running"
    echo "  process says $SERVING. Node loaded its code at boot and has not"
    echo "  looked at the disk since."
    echo "    pm2 restart jarvis"
else
    echo "  Up to date: GitHub, the files and the running process all agree"
    echo "  on $SERVING."
fi
echo
