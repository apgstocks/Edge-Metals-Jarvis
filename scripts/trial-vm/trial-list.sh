#!/usr/bin/env bash
# trial-list — every trial, whether it is running, its address and how much memory it uses
TRIALS_DIR="${TRIALS_DIR:-/srv/trials}"; [ -f /etc/trials.env ] && . /etc/trials.env
printf '%-18s %-9s %-7s %s\n' TRIAL STATE PORT ADDRESS
for d in "$TRIALS_DIR"/*/; do
  [ -f "$d/.env" ] || continue; s=$(basename "$d"); p=$(grep -o '^API_PORT=[0-9]*' "$d/.env" | cut -d= -f2)
  st=$(pm2 jlist 2>/dev/null | python3 -c "import sys,json;n='trial-$s';l=[x for x in json.load(sys.stdin) if x['name']==n];print(l[0]['pm2_env']['status'] if l else 'off')" 2>/dev/null || echo '?')
  printf '%-18s %-9s %-7s %s\n' "$s" "$st" "$p" "https://$s.${TRIAL_DOMAIN:-?}"
done
echo; free -m | awk '/Mem:/ {print "memory: "$7" MB available of "$2" MB"}'
