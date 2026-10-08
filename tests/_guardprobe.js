// Probe: with NO env set, does helpers/drive.js refuse because the entry point
// is under tests/? Read-only — it only asks for the client.
(async () => {
    try {
        const d = require('../helpers/drive.js');
        const r = await d.findPdfByBooking('DALA90721600');
        console.log('NOT GUARDED — reached Drive:', JSON.stringify(r));
    } catch (e) { console.log('GUARDED:', e.message); }
})();
