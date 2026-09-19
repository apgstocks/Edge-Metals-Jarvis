#!/bin/bash
# Written by Claude, 2026-09-19. Run from a Terminal, then delete it.
# Claude's sandbox cannot delete files here, and git leaves a lock after each
# commit — so it manages one commit per session and the rest come through this.
set -e
cd "$(dirname "$0")"
rm -f .git/HEAD.lock .git/index.lock
git reset

# Only Claude's files. Check `git status` first — the other session has work in
# progress too. Do NOT use `git add -A`.
git add helpers/threadStory.js tests/explain-thread.js scripts/ruler.js \
        workflow/actions.js workflow/brain.js
git commit -F COMMIT_MSG_explain.txt
git push origin main

rm -f COMMIT_MSG_explain.txt
echo
echo "Done. On the VM:  git pull && pm2 restart jarvis"
echo "Then try, in WhatsApp:   explain 2     (or 'give summary of 2', or 'what is 2 about')"
echo "And weekly, ON THE VM:   node scripts/ruler.js --verify --days 14"
echo "  (one scoreboard, both surfaces: digest/... and story/... A count that"
echo "   falls is a prompt change that worked.)"
echo
echo "Delete this script:  rm PUSH_ME.sh"
