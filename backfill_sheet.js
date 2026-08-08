const { loadBookings } = require('./helpers/json');
const { syncBookingToSheet } = require('./helpers/bookingTracker');
(async () => {
    const bookings = loadBookings();
    const keys = Object.keys(bookings);
    console.log('Syncing ' + keys.length + ' booking(s)...');
    for (const bkg of keys) {
        await syncBookingToSheet(bkg);
    }
    console.log('done');
})().catch(e => console.error(e));
