#!/usr/bin/env bash
# trial-up <slug> <tarball>  — install and start one uploaded trial. Safe to run again to UPDATE code (data/ is kept).
# Overrides for testing off the VM: TRIALS_DIR, SKIP_PM2=1, SKIP_CADDY=1, SKIP_NPM=1, ENV_FILE
set -euo pipefail
SLUG="${1:-}"; TARBALL="${2:-}"
[[ "$SLUG" =~ ^[a-z0-9][a-z0-9-]{1,30}$ ]] || { echo "usage: trial-up <slug (a-z 0-9 -)> <trial.tgz>"; exit 1; }
[ -f "$TARBALL" ] || { echo "no such tarball: $TARBALL"; exit 1; }
TRIALS_DIR="${TRIALS_DIR:-/srv/trials}"; ENV_FILE="${ENV_FILE:-/etc/trials.env}"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
DIR="$TRIALS_DIR/$SLUG"
UPDATE=0; [ -d "$DIR" ] && UPDATE=1
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
tar xzf "$TARBALL" -C "$STAGE"
SRC="$(find "$STAGE" -maxdepth 2 -name trial-server.js -printf '%h\n' | head -1)"
[ -n "$SRC" ] || { echo "that tarball is not a trial (no trial-server.js)"; exit 1; }
# the Edge Metals source must never be on this machine: refuse a tarball that carries it
[ -e "$SRC/index.js" ] && { echo "refusing: this looks like the full Edge Metals app (index.js present)"; exit 1; }
mkdir -p "$DIR"
if [ "$UPDATE" = 1 ]; then
  rsync -a --delete --exclude data --exclude .env --exclude node_modules "$SRC"/ "$DIR"/
else
  rsync -a "$SRC"/ "$DIR"/
fi
cd "$DIR"
# one port per trial: keep the one in .env unless another trial already holds it
PORT="$(grep -o '^API_PORT=[0-9]*' .env | cut -d= -f2)"
taken() { grep -l "^API_PORT=$1$" "$TRIALS_DIR"/*/.env 2>/dev/null | grep -v "^$DIR/.env$" || true; }
while [ -n "$(taken "$PORT")" ]; do PORT=$((PORT+1)); done
sed -i "s/^API_PORT=.*/API_PORT=$PORT/" .env
sed -i "s#^DATA_DIR=.*#DATA_DIR=$DIR/data#" .env
if [ -n "${TRIAL_GEMINI_KEY:-}" ] && [ "${NO_GEMINI:-0}" != 1 ]; then   # the VM's trial-only key, applied on every install/update
  if grep -q '^GEMINI_API_KEY=' .env; then sed -i "s#^GEMINI_API_KEY=.*#GEMINI_API_KEY=$TRIAL_GEMINI_KEY#" .env; else echo "GEMINI_API_KEY=$TRIAL_GEMINI_KEY" >> .env; fi
fi
grep -q '^PDF_BROWSER_IDLE_MS=' .env || echo "PDF_BROWSER_IDLE_MS=60000" >> .env
chmod 600 .env
[ "${SKIP_NPM:-0}" = 1 ] || [ -e node_modules ] || npm install --omit=dev --no-audit --no-fund >/dev/null
if [ "$UPDATE" = 0 ]; then node trial-seed.js || echo "(demo data not seeded)"; fi
NAME="trial-$SLUG"
if [ "${SKIP_PM2:-0}" != 1 ]; then
  pm2 delete "$NAME" >/dev/null 2>&1 || true
  pm2 start trial-server.js --name "$NAME" --cwd "$DIR" --max-memory-restart "${TRIAL_MEM_MB:-450}M" --time >/dev/null
  pm2 save >/dev/null
fi
HOST="$SLUG.${TRIAL_DOMAIN:-localhost}"
if [ "${SKIP_CADDY:-0}" != 1 ]; then
  printf '%s {\n    reverse_proxy 127.0.0.1:%s\n    encode gzip\n}\n' "$HOST" "$PORT" > "/etc/caddy/trials.d/$SLUG.caddy"
  caddy validate --config /etc/caddy/Caddyfile >/dev/null && caddy reload --config /etc/caddy/Caddyfile --force >/dev/null 2>&1 || sudo -n systemctl reload caddy
fi
echo
[ "$UPDATE" = 1 ] && echo "UPDATED $SLUG (its data was kept)" || echo "STARTED $SLUG"
echo "  address:   https://$HOST      (port $PORT)"
echo "  logins:    $(grep -E '^(ADMIN|STAFF|APP)_PASSWORD=' .env | sed 's/_PASSWORD=/ = /' | tr '\n' ' ')"
echo "  in the phone app, type the server address:  https://$HOST"
