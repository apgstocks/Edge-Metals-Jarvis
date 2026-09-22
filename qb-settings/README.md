# qb-settings — QuickBooks name matching, kept in git

`qb-party-map.json` holds every supplier / customer / grade / bank match
Apsara confirmed (2026-09-21/22). It contains names and QuickBooks record
numbers only — no passwords, keys or tokens (those stay in `.env` and `data/`).

It lives here, not in the gitignored `data/`, so the server can get it with a
plain `git pull`. The server points at it with:

    QB_PARTY_MAP_FILE=/home/apsara/Edge-Metals-Jarvis/qb-settings/qb-party-map.json

If a match is confirmed ON THE SERVER, this file changes there — commit it
from the server too, or the next `git pull` will conflict.
