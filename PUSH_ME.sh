#!/bin/bash
# Written by Claude, 2026-09-18. Run from a Terminal, then delete it.
#
# Claude's sandbox cannot delete files in this folder, and git leaves a lock
# behind after each commit -- so it can only make one commit per session and
# the rest have to go through this script.
set -e
cd "$(dirname "$0")"
rm -f .git/HEAD.lock .git/index.lock
git reset

# Only Claude's files. Check `git status` first if another session has work in
# progress -- do NOT use `git add -A`.
git add helpers/digestVerify.js tests/digest-verify.js scripts/ruler.js \
        workflow/replyWatch.js tests/two-mailbox.js tests/emailwatch-signals.js
git commit -F COMMIT_MSG_verify.txt

git add helpers/mailImportance.js workflow/replyWatch.js \
        tests/mail-importance.js tests/emailwatch-signals.js
git commit -F COMMIT_MSG_clumsy.txt

git push origin main

rm -f COMMIT_MSG_verify.txt COMMIT_MSG_clumsy.txt COMMIT_MSG_erd.txt COMMIT_MSG_importance.txt COMMIT_MSG_two-mailbox.txt
rm -rf _to_delete
echo
echo "Done. On the VM:  git pull && pm2 restart jarvis"
echo "Then watch for:   pm2 logs jarvis | grep VERIFY"
echo "And weekly, ON THE VM:"
echo "                  node scripts/ruler.js --verify --days 14"
echo "  (per-check, per-day counts. A count that FALLS is a prompt change that"
echo "   worked; one that does not is the answer nobody usually measures.)"
echo "  (every held-back line is logged by name -- that is the loop reporting"
echo "   on itself, and the first place to look if a digest looks thin)"
echo
echo "Delete this script:  rm PUSH_ME.sh"
