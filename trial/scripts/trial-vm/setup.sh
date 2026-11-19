#!/usr/bin/env bash
# ── trial-vm/setup.sh — ONE-TIME setup of a fresh Ubuntu VM that hosts trial copies ─────────
# Run as root ON THE NEW TRIAL VM (not the Edge Metals VM, not your Mac):
#     sudo bash setup.sh
# It ASKS for what it needs, once, and keeps the answers in /etc/trials.env (change them later with: sudo trial-config).
#   Domain        a domain you own. Add ONE DNS record first:  *.trials.example.com  ->  this VM's IP address.
#                 Each trial then lives at https://<slug>.trials.example.com (HTTPS is needed by the phone app).
#   Gemini key    a key made ONLY for trials, never the Edge Metals key (so trial use cannot spend your money).
#   Email         for the HTTPS certificate notices.
#   Memory cap    per trial, in MB (a trial that passes it is restarted instead of taking the server down).
#   Mail + agreement (optional now)  SMTP_URL, MAIL_FROM, AGREEMENT_URL: the sign-up page emails each visitor a link and makes them accept the
#                 trial agreement. Skip them and the page stays closed until you set them with trial-config.
# To skip the questions (scripted installs) pass them as TRIAL_DOMAIN, GEMINI_KEY, CERT_EMAIL, TRIAL_MEM_MB, SMTP_URL, MAIL_FROM, AGREEMENT_URL.
#
# What it installs: Node 22, pm2, Caddy (automatic HTTPS), the libraries Chromium needs for PDFs,
# a locked-down user `trials`, and the commands  trial-up  trial-down  trial-list  trial-fleet.
# The Edge Metals source code is NEVER put on this machine: finished trial folders are uploaded to it.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }

# ── the one-time questions ──
ask() { # ask <var> <prompt> [default] [secret]
  local v="$1" p="$2" d="${3:-}" sec="${4:-}" a=""
  [ -n "${!v:-}" ] && return 0
  [ -t 0 ] || { [ -n "$d" ] && { printf -v "$v" '%s' "$d"; return 0; }; return 0; }
  if [ -n "$sec" ]; then read -r -s -p "$p${d:+ [$d]}: " a; echo; else read -r -p "$p${d:+ [$d]}: " a; fi
  printf -v "$v" '%s' "${a:-$d}"
}
echo "Trial VM setup. Answer once; you can change these later with: sudo trial-config"; echo
while :; do
  ask TRIAL_DOMAIN "1/7  Trial domain you own (trials will be <name>.THIS), e.g. trials.example.com"
  if [[ "${TRIAL_DOMAIN:-}" =~ ^([a-z0-9-]+\.)+[a-z]{2,}$ ]]; then break; fi
  echo "   that does not look like a domain name (letters, digits, dots, e.g. trials.example.com)"; TRIAL_DOMAIN=""; [ -t 0 ] || exit 1
done
echo "   Before trials will open, add this DNS record at your domain provider:   *.${TRIAL_DOMAIN}   A   $(curl -fsS https://api.ipify.org 2>/dev/null || echo '<this VM public IP>')"
ask GEMINI_KEY "2/7  Gemini API key made ONLY for trials (hidden as you type; press Enter to skip, Scout will not work)" "" secret
ask CERT_EMAIL "3/7  Your email, for HTTPS certificate notices" ""
ask TRIAL_MEM_MB "4/7  Memory cap per trial in MB" "450"
[[ "${TRIAL_MEM_MB:-450}" =~ ^[0-9]+$ ]] || TRIAL_MEM_MB=450
echo; echo "The public sign-up page needs three more things. Press Enter to skip them now: the page stays CLOSED (makes nothing) until all are set with  sudo trial-config set ..."
ask SMTP_URL "5/7  Outgoing mail for verification emails, as smtps://user:password@host:465 (hidden as you type)" "" secret
ask MAIL_FROM "6/7  Sender for those emails, e.g. Y.A.R.D. <hello@yourdomain.com>" ""
ask AGREEMENT_URL "7/7  Link to the free-trial agreement customers accept (https://...)" ""
[[ -z "${SMTP_URL:-}" || "${SMTP_URL}" =~ ^smtps?://[^[:space:]]+$ ]] || { echo "   that does not look like smtps://user:password@host:465, so it was skipped"; SMTP_URL=""; }
[[ -z "${MAIL_FROM:-}" || "${MAIL_FROM}" == *@* ]] || { echo "   the sender needs an email address, so it was skipped"; MAIL_FROM=""; }
[[ -z "${AGREEMENT_URL:-}" || "${AGREEMENT_URL}" =~ ^https://[^[:space:]]+$ ]] || { echo "   the agreement link must start with https://, so it was skipped"; AGREEMENT_URL=""; }
echo
echo "   domain:  *.${TRIAL_DOMAIN}"; echo "   gemini:  ${GEMINI_KEY:+set (${#GEMINI_KEY} characters)}${GEMINI_KEY:-not set}"; echo "   email:   ${CERT_EMAIL:-none}"; echo "   memory:  ${TRIAL_MEM_MB:-450} MB per trial"
echo "   mail:    ${SMTP_URL:+set (hidden)}${SMTP_URL:-not set}   sender: ${MAIL_FROM:-not set}   agreement: ${AGREEMENT_URL:-not set}"
if [ -t 0 ]; then read -r -p "Continue? [Y/n] " go; [[ "${go:-Y}" =~ ^[Yy] ]] || { echo "stopped, nothing was installed"; exit 1; }; fi
[ -n "${GEMINI_KEY:-}" ] || echo "WARNING: no Gemini key, so Scout and document reading will not work in trials"
{ [ -n "${SMTP_URL:-}" ] && [ -n "${MAIL_FROM:-}" ] && [ -n "${AGREEMENT_URL:-}" ]; } || echo "NOTE: the sign-up page will stay CLOSED until mail, sender and agreement link are set (sudo trial-config set SMTP_URL ... / MAIL_FROM ... / AGREEMENT_URL ...)"
[ -f /etc/os-release ] && . /etc/os-release
case "${ID:-}" in ubuntu|debian) ;; *) echo "this script is for Ubuntu/Debian (found ${ID:-unknown})"; exit 1;; esac
HERE="$(cd "$(dirname "$0")" && pwd)"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https ufw rsync tar
# Node 22
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
# Chromium's system libraries (puppeteer downloads Chromium itself on npm install)
apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 fonts-liberation || \
apt-get install -y libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2t64 libpango-1.0-0 libcairo2 fonts-liberation
npm install -g pm2
# Caddy
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi
mkdir -p /etc/caddy/trials.d
cat > /etc/caddy/Caddyfile <<CADDY
# managed by trial-vm/setup.sh. One file per trial in trials.d, written by trial-up.
${CERT_EMAIL:+{
    email ${CERT_EMAIL}
}}
import /etc/caddy/trials.d/*.caddy
CADDY
systemctl enable --now caddy && systemctl reload caddy

# a user that owns trials and nothing else
id trials >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash trials
chown trials:trials /etc/caddy/trials.d   # trial-up writes one snippet per trial; it reloads Caddy through Caddy's own admin API, no root needed
mkdir -p /srv/trials /srv/trials-archive /srv/trials-incoming /srv/trial-kit
chown trials:trials /srv/trials /srv/trials-archive /srv/trials-incoming /srv/trial-kit
chmod 750 /srv/trials /srv/trials-archive
cat > /etc/trials.env <<ENV
TRIAL_DOMAIN=${TRIAL_DOMAIN}
TRIAL_GEMINI_KEY=${GEMINI_KEY:-}
TRIAL_MEM_MB=${TRIAL_MEM_MB:-450}
CERT_EMAIL=${CERT_EMAIL:-}
SMTP_URL=${SMTP_URL:-}
MAIL_FROM=${MAIL_FROM:-}
AGREEMENT_URL=${AGREEMENT_URL:-}
ENV
chown root:trials /etc/trials.env
chmod 640 /etc/trials.env

install -m 755 "$HERE/trial-up.sh" /usr/local/bin/trial-up
install -m 755 "$HERE/trial-down.sh" /usr/local/bin/trial-down
install -m 755 "$HERE/trial-list.sh" /usr/local/bin/trial-list
install -m 755 "$HERE/trial-config.sh" /usr/local/bin/trial-config
install -m 755 "$HERE/provision.js" /usr/local/bin/trial-provision
install -m 755 "$HERE/signup-server.js" /usr/local/bin/trial-signup
install -m 755 "$HERE/trial-fleet.js" /usr/local/bin/trial-fleet

# pm2 comes back after a reboot, as the trials user
su - trials -c "pm2 startup systemd -u trials --hp /home/trials >/dev/null 2>&1 || true"
env PATH="$PATH" pm2 startup systemd -u trials --hp /home/trials >/dev/null 2>&1 || true

# the public sign-up page at https://signup.<domain> (behind Caddy), and a daily sweep that switches off expired trials
printf 'signup.%s {\n    reverse_proxy 127.0.0.1:3099\n    encode gzip\n}\n' "$TRIAL_DOMAIN" > /etc/caddy/trials.d/signup.caddy
chown trials:trials /etc/caddy/trials.d/signup.caddy
# the public home page at https://<domain> (a single static file; edit TRIAL_DAYS / ASK_EMAIL at the top of its script, then re-run setup)
mkdir -p /srv/trial-site && install -m 644 "$HERE/site/index.html" /srv/trial-site/index.html && cp -r "$HERE/site/fonts" "$HERE/site/img" /srv/trial-site/ && chmod -R a+rX /srv/trial-site
printf '%s, www.%s {\n    root * /srv/trial-site\n    file_server\n    encode gzip\n}\n' "$TRIAL_DOMAIN" "$TRIAL_DOMAIN" > /etc/caddy/trials.d/site.caddy
chown trials:trials /etc/caddy/trials.d/site.caddy
systemctl reload caddy || true
su - trials -c "pm2 delete trial-signup >/dev/null 2>&1; pm2 start /usr/local/bin/trial-signup --name trial-signup --interpreter node >/dev/null && pm2 save >/dev/null" || true
echo '0 3 * * * trials node /usr/local/bin/trial-signup --expire >> /srv/trials-archive/expire.log 2>&1' > /etc/cron.d/trials-expire

# firewall: SSH and web only. Trials listen on 127.0.0.1 behind Caddy, never on the internet directly.
ufw allow OpenSSH >/dev/null; ufw allow 80,443/tcp >/dev/null; ufw --force enable >/dev/null

# nightly copy of every trial's data/, kept 14 days
cat > /etc/cron.d/trials-backup <<'CRON'
30 2 * * * trials mkdir -p /srv/trials-archive/nightly && for d in /srv/trials/*/data; do s=$(basename $(dirname $d)); tar czf /srv/trials-archive/nightly/$s-$(date +\%F).tgz -C $(dirname $d) data; done; find /srv/trials-archive/nightly -name '*.tgz' -mtime +14 -delete
CRON
echo
echo "Done. Next, on your Mac:  bash scripts/trial-ship.sh <slug> \"<Customer Name>\" <ssh user@this-vm>"
echo "Free memory now: $(free -m | awk '/Mem:/ {print $7" MB available"}')"
