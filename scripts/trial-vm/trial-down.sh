#!/usr/bin/env bash
# trial-down <slug> [--erase]  — switch a trial off. Its data is archived first; --erase removes the folder afterwards.
set -euo pipefail
SLUG="${1:-}"; [[ "$SLUG" =~ ^[a-z0-9][a-z0-9-]{1,30}$ ]] || { echo "usage: trial-down <slug> [--erase]"; exit 1; }
TRIALS_DIR="${TRIALS_DIR:-/srv/trials}"; DIR="$TRIALS_DIR/$SLUG"
[ -d "$DIR" ] || { echo "no trial called $SLUG"; exit 1; }
if [ "${SKIP_PM2:-0}" != 1 ]; then pm2 delete "trial-$SLUG" >/dev/null 2>&1 || true; pm2 save >/dev/null 2>&1 || true; fi
mkdir -p "${ARCHIVE_DIR:-/srv/trials-archive}"
tar czf "${ARCHIVE_DIR:-/srv/trials-archive}/$SLUG-$(date +%F-%H%M).tgz" -C "$DIR" data 2>/dev/null || true
if [ "${SKIP_CADDY:-0}" != 1 ]; then rm -f "/etc/caddy/trials.d/$SLUG.caddy"; caddy reload --config /etc/caddy/Caddyfile --force >/dev/null 2>&1 || sudo -n systemctl reload caddy; fi
if [ "${2:-}" = "--erase" ]; then rm -rf "$DIR"; echo "SWITCHED OFF and ERASED $SLUG (its data is in the archive folder)"; else echo "SWITCHED OFF $SLUG (folder and data kept; trial-up restarts it)"; fi
