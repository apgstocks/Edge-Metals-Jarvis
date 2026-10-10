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
    }, {
        // ── DOCUMENTS, IN A PROCESS OF THEIR OWN (2026-10-10) ────────────
        // Apsara: "think like a production system", after an invoice
        // download failed with a 30-second navigation timeout.
        //
        // Until this, the one process above held 275 HTTP routes, 34 cron
        // jobs, the WhatsApp client and its Chromium, and every PDF render,
        // under the 1500M cap. So one large document could cross the cap and
        // restart ALL of it: the API for every customer, the WhatsApp
        // session, 34 jobs mid-flight, and every queued document, since
        // helpers/pdfQueue.js's line is an in-memory array.
        //
        // Now a document that goes wrong takes down documents. This entry is
        // what makes that true.
        //
        // NOT STARTING IT IS SUPPORTED. helpers/renderClient.js falls back to
        // rendering inside the main process whenever the socket is absent, so
        // `pm2 delete jarvis-render` is a complete rollback and nothing
        // breaks in between.
        name: 'jarvis-render',
        script: 'render-server.js',
        cwd: __dirname,

        autorestart: true,
        exp_backoff_restart_delay: 1000,
        max_restarts: 15,
        min_uptime: '60s',

        // Lower than jarvis's 1500M on purpose. This process holds Chromium
        // and nothing else, so it should be restarted well before it can
        // threaten the box the other process is living on — the restart costs
        // one fallback render, which the client already handles.
        max_memory_restart: '700M',

        out_file: 'data/logs/render-out.log',
        error_file: 'data/logs/render-error.log',
        merge_logs: true,
        time: true,

        env: {
            NODE_ENV: 'production',
            // ── KEEP CHROMIUM, DO NOT CLOSE IT AFTER A QUIET MINUTE ──────
            // The default is 60s, which is right inside the main process —
            // an idle browser there is memory taken from 275 routes and 34
            // crons. It is wrong here, and her first document proved it:
            //
            //   14:37  invoice both total 14211ms
            //          launch-chromium 11844ms  (83%)
            //
            // A cold Chromium launch costs ELEVEN AND A HALF SECONDS on this
            // box, so an invoice generated twice an hour paid it every time.
            // This process exists only to render; it has nothing to be
            // polite to. 0 means keep it.
            PDF_BROWSER_IDLE_MS: '0',
            // And use its OWN browser rather than looking for WhatsApp's,
            // which lives in the other process and is not reachable from
            // here. Stating it saves a pointless check per document and
            // makes the intent obvious to whoever reads this next.
            PDF_BROWSER: 'own',
        },
        watch: false,
    }],
};
