#!/usr/bin/env bash
# ── trial-ship.sh — make a trial on THIS Mac and install it on the trial VM ──────────────────
#   bash scripts/trial-ship.sh <slug> "<Customer Name>" <ssh target, e.g. root@203.0.113.7> [more make-trial flags]
# It builds the copy with make-trial.js (which scans it for anything of Edge's and refuses to go on if it finds some),
# uploads only that copy, and runs trial-up on the VM. Run it from the Mac, never on a server.
set -euo pipefail
# TEMPLATE MODE: bash scripts/trial-ship.sh --template <ssh target>
# Builds ONE neutral copy (placeholder brand) and installs it on the VM as /srv/trial-kit/template, with its libraries installed once.
# Self-serve signups are then made from it on the VM. Re-run after every release you want trials to have.
if [ "${1:-}" = "--template" ]; then
  TARGET="${2:-}"; [ -n "$TARGET" ] || { echo 'usage: bash scripts/trial-ship.sh --template <user@trial-vm>'; exit 1; }
  [ -d /srv/trials ] && { echo "this looks like the trial VM, not your Mac. Run it from the Mac."; exit 1; }
  HERE="$(cd "$(dirname "$0")" && pwd)"; WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
  node "$HERE/make-trial.js" --name "Tenantzz Co" --slug tenantzz --out "$WORK/template"     # exits non-zero on any leak
  rm -rf "$WORK/template/data" "$WORK/template/.env" "$WORK/template/TRIAL-README.md"
  tar czf "$WORK/template.tgz" -C "$WORK" --exclude node_modules template
  scp "$WORK/template.tgz" "$TARGET:/srv/trials-incoming/template.tgz"
  ssh "$TARGET" 'sudo -u trials bash -c "set -e; rm -rf /srv/trial-kit/template.new; mkdir /srv/trial-kit/template.new; tar xzf /srv/trials-incoming/template.tgz -C /srv/trial-kit/template.new --strip-components=1; cd /srv/trial-kit/template.new && npm install --omit=dev --no-audit --no-fund >/dev/null; rm -rf /srv/trial-kit/template.old; [ -d /srv/trial-kit/template ] && mv /srv/trial-kit/template /srv/trial-kit/template.old; mv /srv/trial-kit/template.new /srv/trial-kit/template; echo template installed"'
  exit 0
fi
SLUG="${1:-}"; NAME="${2:-}"; TARGET="${3:-}"; shift 3 || true
[ -n "$SLUG" ] && [ -n "$NAME" ] && [ -n "$TARGET" ] || { echo 'usage: bash scripts/trial-ship.sh <slug> "<Customer Name>" <user@trial-vm> [flags]'; exit 1; }
[ -d /srv/trials ] && { echo "this looks like the trial VM, not your Mac. Run it from the Mac."; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
node "$HERE/make-trial.js" --name "$NAME" --slug "$SLUG" --out "$WORK/$SLUG" "$@"        # exits non-zero on any leak
tar czf "$WORK/$SLUG.tgz" -C "$WORK" --exclude node_modules "$SLUG"
scp "$WORK/$SLUG.tgz" "$TARGET:/srv/trials-incoming/$SLUG.tgz"
ssh "$TARGET" "sudo -u trials /usr/local/bin/trial-up $SLUG /srv/trials-incoming/$SLUG.tgz"
