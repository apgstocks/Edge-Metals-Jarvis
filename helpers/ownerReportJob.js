// helpers/ownerReportJob.js — sends the weekly owner report to the MANAGER only.
// OFF unless JARVIS_OWNER_REPORT=1 (same pattern as JARVIS_SELF_BUILD). Never throws: a failure is logged,
// and it never touches a reply path. Edge Metals only (see helpers/ownerReport.js).
'use strict';

async function runWeekly({ sendToManager, now = Date.now(), days = 7, src } = {}) {
    if (process.env.JARVIS_OWNER_REPORT !== '1') return { sent: false, reason: 'off' };
    try {
        const rep = require('./ownerReport');
        const body = rep.text(rep.build({ now, days, src }));
        await sendToManager(body);
        return { sent: true, chars: body.length };
    } catch (e) {
        console.error('[SCHED] owner-report:', e && e.message);
        return { sent: false, reason: 'error', error: e && e.message };
    }
}

module.exports = { runWeekly };
