#!/bin/bash
# One-off migration — run once from ~/Edge-Metals-Jarvis on the VM, AFTER
# helpers/emailContacts.js has been deployed (needs the domain/role-aware
# addContact + the new domain tier in resolveContact).
set -e
cd "$(dirname "$0")" 2>/dev/null || true

node -e "
const c = require('./helpers/emailContacts');
const { loadSettings, saveSettings } = require('./helpers/json');
(async () => {
  await c.removeContact('radmetals'); // clear the old flat/stale alias
  await c.addContact('brian', 'brian@radmetals.com', { domain: 'radmetals.com', role: 'primary', cc: ['radmetals@radmetals.com'] });
  await c.addContact('helen', 'helen@radmetals.com', { domain: 'radmetals.com', role: 'secondary', cc: ['radmetals@radmetals.com'] });
  await c.addContact('docs', 'radmetals@radmetals.com', { domain: 'radmetals.com', role: 'shared' });

  const s = loadSettings();
  const existing = (s.email_cc || '').split(',').map(x => x.trim()).filter(Boolean);
  const need = ['accounts@edgemetals.com', 'bose@edgemetals.com'];
  for (const addr of need) if (!existing.some(x => x.toLowerCase() === addr.toLowerCase())) existing.push(addr);
  s.email_cc = existing.join(',');
  await saveSettings(s);

  console.log('=== contacts ===');
  console.log(JSON.stringify(c.loadContacts(), null, 2));
  console.log('=== settings.email_cc ===');
  console.log(s.email_cc);
})();
"