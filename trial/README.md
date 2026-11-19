# trial/ — Y.A.R.D. trial tooling changes (2026-11-19)

Copies of the files changed or added in this work. The live files still sit at the same paths
under scripts/trial-vm/ and tests/ (the tests and ship scripts expect them there), so this folder
is a reviewable snapshot, not a move.

scripts/trial-vm/
  provision.js      NEW: --version, --update <slug> "<brand>" (rebuild keeping .env/data/README), version stamp in RESULT
  signup-server.js  CHANGED: invitation + agreement tick + email verification; stores template `version` in the registry
  trial-fleet.js    NEW: status, capacity gauge, upgrade one/--all with snapshot, health check, rollback, lock
  setup.sh          CHANGED: SMTP/MAIL_FROM/AGREEMENT_URL questions; installs trial-fleet
  trial-config.sh   CHANGED: new settings and validation, safe rewrite
tests/
  trial-fleet.js    NEW: 59 checks, end to end
  trial-signup.js   CHANGED: 60 checks
  trial-vm.js       CHANGED: 43 checks

Originals before this work: outputs/backup-2026-11-19/*.orig
  site/index.html   NEW: the public home page (served at the domain by Caddy; set TRIAL_DAYS / ASK_EMAIL in its script)
