#!/usr/bin/env bash
# trial-config — show or change the one-time setup answers (domain, Gemini key, email, memory cap). Run with sudo.
#   sudo trial-config                       show them (the Gemini key and the mail password are hidden)
#   sudo trial-config set <NAME> <value>    NAME is TRIAL_DOMAIN, TRIAL_GEMINI_KEY, CERT_EMAIL, TRIAL_MEM_MB, or one of the sign-up page's
#                                           settings: SMTP_URL, MAIL_FROM, AGREEMENT_URL, AGREEMENT_VERSION, SIGNUP_BASE_URL
#   The sign-up page stays CLOSED until TRIAL_DOMAIN (or SIGNUP_BASE_URL), SMTP_URL, MAIL_FROM and AGREEMENT_URL are all set.
# A changed Gemini key / memory cap reaches an EXISTING trial the next time you run trial-up for it (new trials get it at once).
set -euo pipefail
F="${ENV_FILE:-/etc/trials.env}"; [ -f "$F" ] || { echo "$F not found: run setup.sh first"; exit 1; }
if [ "${1:-}" = "set" ]; then
  K="${2:-}"; V="${3:-}"
  case "$K" in TRIAL_DOMAIN|TRIAL_GEMINI_KEY|CERT_EMAIL|TRIAL_MEM_MB|SMTP_URL|MAIL_FROM|AGREEMENT_URL|AGREEMENT_VERSION|SIGNUP_BASE_URL) ;; *) echo "unknown setting $K"; exit 1;; esac
  case "$V" in *$'\n'*|*$'\r'*) echo "a setting must be on one line"; exit 1;; esac
  [ "$K" = TRIAL_MEM_MB ] && ! [[ "$V" =~ ^[0-9]+$ ]] && { echo "memory must be a number of MB"; exit 1; }
  [ "$K" = TRIAL_DOMAIN ] && ! [[ "$V" =~ ^([a-z0-9-]+\.)+[a-z]{2,}$ ]] && { echo "not a domain name"; exit 1; }
  [ "$K" = AGREEMENT_URL ] && ! [[ "$V" =~ ^https://[^[:space:]]+$ ]] && { echo "the agreement link must start with https://"; exit 1; }
  [ "$K" = SIGNUP_BASE_URL ] && ! [[ "$V" =~ ^https://[^[:space:]/]+$ ]] && { echo "the public address must look like https://signup.example.com"; exit 1; }
  [ "$K" = MAIL_FROM ] && ! [[ "$V" =~ @ ]] && { echo "the sender must contain an email address"; exit 1; }
  [ "$K" = SMTP_URL ] && ! [[ "$V" =~ ^smtps?://[^[:space:]]+$ ]] && { echo "the mail setting must look like smtps://user:password@host:465"; exit 1; }
  # rewritten without sed, so a value containing & # or \ is stored exactly; cat into the file keeps its owner and mode
  T="$(mktemp)"; grep -v "^$K=" "$F" > "$T" || true; printf '%s=%s\n' "$K" "$V" >> "$T"; cat "$T" > "$F"; rm -f "$T"
  echo "saved $K"
  case "$K" in SMTP_URL|MAIL_FROM|AGREEMENT_URL|AGREEMENT_VERSION|SIGNUP_BASE_URL|TRIAL_DOMAIN) echo "note: the sign-up page reads this when it starts. Restart it:  sudo -u trials pm2 restart trial-signup";; esac
  if [ "$K" = TRIAL_DOMAIN ]; then echo "note: trials already running keep their old address until you run trial-up for each one"; fi
else
  sed -E 's/^(TRIAL_GEMINI_KEY|SMTP_URL)=(.+)$/\1=(set, hidden)/' "$F"
fi
