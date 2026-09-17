#!/bin/bash
# Written by Claude, 2026-09-17. Run this from a Terminal, then delete it.
#
# WHY THIS FILE EXISTS: Claude's sandbox cannot delete files inside this
# folder, and git leaves a lock file behind after every commit. So the first
# commit succeeded and every one after it was blocked. The work is all here in
# the working tree; only the commits are missing.
set -e
cd "$(dirname "$0")"

# 1. Clear the locks Claude could not remove, and rebuild the index (it is
#    stale because Claude had to commit through a side index -- this is why
#    git currently shows helpers/poTracker.js as deleted. It is not: it is
#    committed in bba7329 and present on disk).
rm -f .git/HEAD.lock .git/index.lock
git reset

# 2. Commit the two-mailbox work. NOTE the explicit file list: dashboard,
#    helpers/banks.js, mobile-app, tests/banks.js, tests/paid-via.js and
#    tests/yard-payment-modes.js are the OTHER Claude session's uncommitted
#    work. Do not use `git add -A`.
git add config.js helpers/gmail.js scripts/gmail-auth.js tests/two-mailbox.js
git commit -F COMMIT_MSG_two-mailbox.txt

# 3. Commit the importance axis.
git add helpers/mailImportance.js scripts/importance-report.js \
        workflow/replyWatch.js workflow/brain.js workflow/actions.js \
        tests/mail-importance.js tests/emailwatch-signals.js
git commit -F COMMIT_MSG_importance.txt

# 4. Commit the ERD / team-chase fixes she reported last.
git add workflow/replyWatch.js tests/emailwatch-signals.js
git commit -F COMMIT_MSG_erd.txt

# 5. Push.
git push origin main

# 6. Tidy up.
rm -f COMMIT_MSG_two-mailbox.txt COMMIT_MSG_importance.txt COMMIT_MSG_erd.txt
rm -rf _to_delete
echo
echo "Done. Now on the VM:  git pull && pm2 restart jarvis"
echo "Then, ON THE VM:      node scripts/importance-report.js --days 7"
echo "  (the counterparty ledger only exists there -- on the laptop it is empty"
echo "   and the 'would go quiet' list is meaningless)"
echo
echo "This script can be deleted:  rm PUSH_ME.sh"
