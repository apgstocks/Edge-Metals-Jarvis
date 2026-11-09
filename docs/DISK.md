# The disk: how Jarvis remembers what it was taught

Written 2026-11-09. **Nothing in the app reads it yet.** It is new files only; no existing store was changed or migrated.

## Files

| File | What it is |
|---|---|
| `helpers/disk/index.js` | The disk: one door, a partition per company, separate layers |
| `helpers/disk/jsonl.js` | The append-only file primitive every layer is built on |
| `helpers/disk/text.js` | Words normalised so "reminder" finds "reminders" |
| `helpers/diskStore.js` | The one Disk for this process, under `DATA_DIR/disk` |
| `helpers/playbook.js` | The Playbook: the rules she has given, as a readable list |
| `scripts/playbook.js` | `list`, `ask "text"`, `seed`, `forget <id>`, `snapshot` |
| `tests/disk.js`, `tests/playbook.js` | 60 checks; the second runs the real command |

## The shape

```
disk.for('edge_metals')     <- the partition. No company, or an unregistered one, throws.
  .facts   what she TAUGHT it. A newer value replaces the older; history is kept.
  .log     what Jarvis DECIDED and what she DID about it. Append-only.
  .links   what is connected to what (container -> booking -> customer).
  .read()  read-only windows onto stores that already exist.
  .query() one question across all of the above.
  .snapshot() / .restore()   backup.json, which helpers/backup.js already collects.
```

Edge Metals and Edge Yard live in separate directories. A rule taught for one cannot be recalled for the other because it is not in the same place, not because a query remembered to filter (CLAUDE.md rule 5). A future customer must be registered before it exists.

## Rules the code enforces

- **Only manager/team can teach a fact.** Text from a supplier, trucker or customer can never become one (the MemPoison rule). Links may also be written by role `system`; wiring must never derive a link from text a third party wrote.
- **A correction replaces.** 5100 -> 5200 leaves one live value; the old one stays in history.
- **A match by name or by link is `exact`. A match by meaning is `related` and advisory.** It may shape a question to her; it must never be the only reason Jarvis acts alone.
- **An ambiguous name is reported, never guessed.** Names under 3 letters match only if taught as an alias.
- **Source of truth is append-only JSONL**, replayed at load, like `helpers/outcomes.js`. No lock, no SQLite (package.json says Node >= 20). A torn last line or an unparseable line is counted and skipped, never fatal.
- **One Disk per process.** Two on the same directory would diverge in memory. `helpers/diskStore.js` keeps that true.

## Try it (on the VM, where the live data is)

```
node scripts/playbook.js seed                       # the rules she gave on 2026-11-07; idempotent
node scripts/playbook.js list
node scripts/playbook.js ask "Rad Metal wants a payment reminder"
node scripts/playbook.js forget 6                   # a deleted rule is not brought back by seed
```

Running it on the Mac fills the Mac checkout's own `data/disk`, which is not the live one.

## Backup: one gap to know about

`helpers/backup.js` collects only `*.json` under `data/` and skips `.jsonl`. So `data/outcomes.jsonl` (the learning ledger) is **not** in the nightly backup, and neither are the disk's own layers. The disk writes `backup.json` per company (`snapshot()`, and `scripts/playbook.js seed|forget` call it), which the existing walker does collect; `tests/disk.js` checks that against the real `collectStores`. Wiring must call `snapshot()` on a schedule. Backing up `outcomes.jsonl` would change existing behaviour and needs her yes.

## Not built, on purpose

- Nothing reads the Playbook, so no follow-up, chase or truth check behaves differently. `tests/playbook.js` guards that with `ALLOWED_CALLERS`, which is empty; the change that wires it adds itself there, with her yes and its own end-to-end test.
- Noticing she is teaching in a WhatsApp message (needs `workflow/brain.js`); deciding which customer or container a situation is about; the case file per customer in `docs/OWNERSHIP-PLAN.md` section 4.
- Deployment: nothing is true until `bash ship.sh` and `git pull && pm2 restart jarvis --update-env` on the VM (CLAUDE.md rule 4).

## Why not GraphQL

It would add a server, a schema and resolvers to a single-process app with no outside clients. The useful part, "these things, connected, in one call", is `query()`. A GraphQL facade can sit on `query()` later if Jarvis is sold behind an API.
