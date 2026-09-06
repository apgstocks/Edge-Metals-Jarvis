// ── ecosystem.config.js — pm2 process definition ──────────────────────────
//
// Apsara, 2026-09-06: "fix them" — the readiness gates. This is the one that
// caused a real outage rather than a theoretical one.
//
// WHAT WENT WRONG. On 2026-09-01 Jarvis stopped at 06:22 and was still down
// at 16:54 — ten and a half hours of no email monitoring, no chase-ups, no
// scheduler, and a critical alert (a customer waiting on a rate) stuck three
// minutes short of its email escalation. Nothing restarted it and nothing
// said anything. package.json has had a `pm2` script since forever
// (`pm2 start index.js --name jarvis`) but no config file, so the process had
// no restart policy, no log destination, and nothing making it survive a
// reboot or a laptop sleep.
//
// USE IT:
//     pm2 start ecosystem.config.js        # start (or reload) Jarvis
//     pm2 logs jarvis                      # tail
//     pm2 save                             # remember it across reboots
//     pm2 startup                          # prints one sudo line — RUN IT
//
// `pm2 save` and `pm2 startup` are the two that actually close the hole. A
// restart policy that does not survive a reboot is not a restart policy, and
// this runs on a machine that sleeps.
//
// STILL NOT COVERED, and worth being honest about: pm2 restarts a process
// that DIES. It cannot help with a process that is alive and broken — Gmail
// token revoked, every scan throwing, WhatsApp logged out. `/healthz` already
// answers that (503 with a reason, deliberately public so a monitor can reach
// it), but nothing outside this box polls it. Point any uptime monitor at
// https://<host>/healthz and alert on non-200. Until something does, the
// second half of the 2026-09-01 failure — nobody being told — is still open.

module.exports = {
    apps: [{
        name: 'jarvis',
        script: 'index.js',
        cwd: __dirname,

        // ── restart policy ──
        autorestart: true,
        // Back off between retries. Without this a crash-on-boot (a bad
        // config, an expired credential) becomes a hot loop that fills the
        // disk with logs and makes the real error hard to find.
        exp_backoff_restart_delay: 1000,
        // Give up after 15 failed starts in a row so a genuinely broken deploy
        // stops flapping and stays visibly dead. `pm2 list` shows "errored",
        // which is a clearer signal than a process restarting every second.
        max_restarts: 15,
        min_uptime: '60s',          // under a minute counts as a failed start

        // ── memory ──
        // whatsapp-web.js drives a real Chromium; a leak there has taken the
        // box down before. Restart rather than let the OS OOM-kill it, since a
        // pm2 restart is logged and an OOM kill is not.
        max_memory_restart: '1500M',

        // ── logs ──
        // helpers/crashlog.js writes structured crash files; these two capture
        // everything else, including whatever Chromium prints on its way down.
        out_file: 'data/logs/pm2-out.log',
        error_file: 'data/logs/pm2-error.log',
        merge_logs: true,
        time: true,                 // timestamp every line — the 2026-09-01
                                    // post-mortem had nothing to anchor on

        env: { NODE_ENV: 'production' },

        // Never watch-and-reload in production: a file written by the app
        // itself (data/*.json is written constantly) would restart it in a
        // loop.
        watch: false,
    }],
};
