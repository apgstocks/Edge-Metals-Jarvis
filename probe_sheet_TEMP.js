const { google } = require('googleapis');
const fs = require('fs');

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: 'data/gdrive-sa.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly', 'https://www.googleapis.com/auth/drive.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = '1QsCeuqeRKODuouzO2PfKbxG9qJpN8yAbIurSzhI--6s';

  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    console.log('TITLE:', meta.data.properties.title);
    console.log('SHEETS:');
    meta.data.sheets.forEach(s => console.log(' -', s.properties.title, 'gid=' + s.properties.sheetId));

    // find the sheet with gid=1001174134
    const target = meta.data.sheets.find(s => String(s.properties.sheetId) === '1001174134');
    const tabName = target ? target.properties.title : meta.data.sheets[0].properties.title;
    console.log('\nReading tab:', tabName);

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${tabName}'!A1:Z10`,
    });
    console.log('First 10 rows:');
    (res.data.values || []).forEach((r, i) => console.log(i, JSON.stringify(r)));
  } catch (err) {
    console.error('ERROR:', err.message);
    if (err.errors) console.error(JSON.stringify(err.errors));
  }
}
main();
