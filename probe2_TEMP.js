const { google } = require('googleapis');

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: 'data/gdrive-sa.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = '1QsCeuqeRKODuouzO2PfKbxG9qJpN8yAbIurSzhI--6s';

  const tabs = ['Addresses', 'Addresses_2026', 'indida address'];
  for (const tabName of tabs) {
    console.log('\n=== ' + tabName + ' ===');
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${tabName}'!A1:F15`,
      });
      (res.data.values || []).forEach((r, i) => console.log(i, JSON.stringify(r)));
    } catch (err) {
      console.log('ERROR:', err.message);
    }
  }
}
main();
