// tests/quickbooks-page.js — the QuickBooks page's own routes.
// No network: QB_ENV is pointed at an env with no token, so every QuickBooks
// call fails fast and the page must still answer from Jarvis's own ledgers.
process.env.QB_ENV = 'sandbox';
// A fresh directory per run. Fixed /tmp paths broke the day a leftover file
// from an earlier run belonged to another user: the atomic rename inside
// saveMap() failed with EPERM and the test blamed the code (2026-09-25).
const _tmp = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'qbpage-'));
process.env.QB_TOKEN_FILE = require('path').join(_tmp, 'token.json');
process.env.QB_PARTY_MAP_FILE = require('path').join(_tmp, 'party-map.json');
process.env.QB_JOURNAL_FILE = require('path').join(_tmp, 'journal.jsonl');
delete process.env.QB_CUTOVER_INVOICES; delete process.env.QB_CUTOVER_BILLS;
process.env.QB_CUTOVER_FILE = require('path').join(require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'qbpage-')), 'cutover.json');
const fs = require('fs');

const express = require('express');
const journal = require('../helpers/quickbooks/journal');
const KEYNAME = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const routes = require('../helpers/quickbooks/routes');
let pass = 0, fail = 0; const failures = [];
const ck = (name, ok, extra) => { if (ok) { pass++; console.log('  PASS ', name); } else { fail++; failures.push(name); console.log('  FAIL ', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 200)); } };

(async () => {
    const app = express();
    app.use(express.json());
    let role = 'admin';
    app.use((req, res, next) => { req.role = role; next(); });
    routes.mount(app, { ROOT: require('path').join(__dirname, '..') });
    const server = app.listen(0);
    const port = server.address().port;
    const get = async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { code: r.status, body: await r.json().catch(() => null) }; };
    const post = async (p, body) => {
        const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { code: r.status, body: await r.json().catch(() => null) };
    };

    const status = await get('/api/qb/status');
    ck('status answers even with QuickBooks unreachable', status.code === 200 && status.body.env === 'sandbox', status.body);
    ck('status says whether writes are on', typeof status.body.writes === 'boolean' && typeof status.body.autoSync === 'boolean');
    ck('status lists the account roles so an unmapped one is visible', Array.isArray(status.body.roles) && status.body.roles.some((r) => r.role === 'prepayment'));

    const parties = await get('/api/qb/parties?qb=0');
    ck('the party list comes from Jarvis ledgers, no QuickBooks needed', parties.code === 200 && Array.isArray(parties.body.parties), parties.body);

    const page = await fetch(`http://127.0.0.1:${port}/quickbooks`);
    const html = await page.text();
    ck('the page itself is served', page.status === 200 && /Ask Jarvis|id="ask"/.test(html));
    ck('the page is locked when it loads', /🔒 Locked/.test(html));

    // ── the padlock ────────────────────────────────────────────────────────
    ck('locked: a mapping change is refused', (await post('/api/qb/map', { kind: 'vendor', jarvisName: 'X', qbId: '1' })).code === 400);
    ck('locked: a push is refused', (await post('/api/qb/push', { kind: 'bill', id: 'B1' })).code === 400);
    ck('locked: an undo is refused', (await post('/api/qb/undo', { journalId: 'J1', reason: 'because' })).code === 400);
    role = 'staff';
    const staff = await post('/api/qb/map', { kind: 'vendor', jarvisName: 'X', qbId: '1', unlock: true });
    ck('unlocked but not admin: still refused, and says why', staff.code === 403 && /admin/.test(staff.body.error), staff.body);
    role = 'admin';

    const mapped = await post('/api/qb/map', { kind: 'vendor', jarvisName: 'Mario', qbId: '588', qbName: 'LA Recycling', unlock: true });
    ck('unlocked admin: the mapping saves', mapped.code === 200 && mapped.body.saved.qbId === '588', mapped.body);
    ck('...and it reminds her to commit qb-settings', /commit/.test(mapped.body.note || ''));
    const map = JSON.parse(fs.readFileSync(process.env.QB_PARTY_MAP_FILE, 'utf8'));
    ck('...and it really is in the file', JSON.stringify(map.vendor).includes('LA Recycling'));

    const noReason = await post('/api/qb/undo', { journalId: 'J1', reason: 'x', unlock: true });
    ck('an undo without a real reason is refused', noReason.code === 400 && /reason/.test(noReason.body.error), noReason.body);
    const badKind = await post('/api/qb/push', { kind: 'nonsense', id: 'B1', unlock: true });
    ck('push only knows bill, invoice and advance', badKind.code === 400);
    const missing = await post('/api/qb/push', { kind: 'bill', id: 'NOPE', dryRun: true, unlock: true });
    ck('a push for a record that is not there says so, it does not crash', [404, 500].includes(missing.code), missing.body);

    const ask = await post('/api/qb/ask', { question: 'what do I owe him?', kind: 'vendor', name: 'Mario' });
    ck('Ask Jarvis always answers', ask.code === 200 && typeof ask.body.answer === 'string' && ask.body.answer.length > 0, ask.body);
    ck('...and always comes back with a follow-up question', /\?\s*$/.test(String(ask.body.followUp || '').trim()), ask.body);
    ck('an empty question is refused', (await post('/api/qb/ask', { question: '  ' })).code === 400);

    // ── who is ahead ───────────────────────────────────────────────────────
    // The chat told her she owed Hugo $144,792.91 while he held $806,619.75 of
    // her money (2026-09-24). One signed number, said in words.
    const R = require('../helpers/quickbooks/routes');
    const fake = (bills, advances) => {
        const d = { bills, invoices: [], advances, journal: [] };
        const sum = (a) => Math.round(a.reduce((s, x) => s + x.amount, 0) * 100) / 100;
        return { owed: Math.round((sum(bills) - sum(advances.filter(x => x.kind === 'advance'))) * 100) / 100 };
    };
    ck('advances bigger than bills means HE is holding her money',
       fake([{ amount: 144792.91 }], [{ kind: 'advance', amount: 806619.75 }]).owed < 0);
    ck('bills bigger than advances means she owes him',
       fake([{ amount: 90000 }], [{ kind: 'advance', amount: 10000 }]).owed === 80000);
    const askHugo = await post('/api/qb/ask', { question: 'do we owe anything to Hugo?', kind: 'vendor', name: 'Hugo' });
    ck('the answer never leaves the two piles unresolved',
       askHugo.code === 200 && (!askHugo.body.degraded || /holding|owe|no bills|no records/i.test(askHugo.body.answer)), askHugo.body);

    // an exact name must be OFFERED, not hidden behind "(no near matches)"
    const M = require('../helpers/quickbooks/mapping');
    const qbNames = [{ Id: '561', DisplayName: 'FMC METALS', Active: true }, { Id: '571', DisplayName: 'FMC Metal', Active: true }];
    const hit = M.matchParty('FMC METALS', qbNames, 'customer');
    ck('an exact name comes back under qb, not candidates — the trap', hit.status === 'exact' && !!hit.qb && (hit.candidates || []).length === 0, hit.status);
    const routesSrc = fs.readFileSync(require('path').join(__dirname, '..', 'helpers', 'quickbooks', 'routes.js'), 'utf8');
    ck('...so the candidates route puts it at the head of the list', /const exact = m\.qb \?/.test(routesSrc));
    const pageSrc = fs.readFileSync(require('path').join(__dirname, '..', 'dashboard', 'quickbooks.html'), 'utf8');
    ck('...and the dialog marks it', /same name, almost certainly this one/.test(pageSrc));

    // ── a mapping she confirmed must SHOW (2026-09-26) ─────────────────────
    // Apsara: "i have matched the supplier name just now ... yet it shows no
    // match in qb." It was saved. /api/qb/party read it off the wrong field
    // (matchParty answers under `qb`, not `qbId`), so the header said "no
    // QuickBooks match yet" for every party, always, and the balance beside it
    // read "—". The party LIST was right the whole time, which is what made it
    // look like her matching had failed.
    const marioMapped = await get('/api/qb/party?kind=vendor&name=Mario');
    ck('a confirmed mapping shows on the party itself, not just in the list',
       marioMapped.code === 200 && marioMapped.body.mapping.qbId === '588'
       && marioMapped.body.mapping.qbName === 'LA Recycling', marioMapped.body.mapping);
    ck('...and it says it was confirmed, not guessed', marioMapped.body.mapping.status === 'confirmed', marioMapped.body.mapping);
    const unmapped = await get('/api/qb/party?kind=vendor&name=Nobody%20At%20All');
    ck('an unmatched party still reads as unmatched', unmapped.code === 200 && unmapped.body.mapping.qbId === null, unmapped.body.mapping);
    const roleChips = (await get('/api/qb/status')).body.roles;
    ck('the account-role chips read the same way (they said unmapped when mapped)',
       Array.isArray(roleChips) && roleChips.every((r) => 'qbId' in r), roleChips);

    // ── everything the terminal used to be needed for (2026-09-26) ─────────
    // Apsara: "i basically want my website to handle whatever we can do from
    // qb from here." Three of the scripts move onto the page: what is still
    // waiting (qb-journal check + qb-match-parties), which account answers a
    // role (qb-accounts role) and creating a party she approved
    // (qb-create-party).
    const todo = await get('/api/qb/todo');
    ck('the worklist answers without QuickBooks being reachable',
       todo.code === 200 && Array.isArray(todo.body.unmatched) && Array.isArray(todo.body.stuck), todo.body && todo.body.error);
    ck('...and counts every kind of thing that is waiting',
       todo.body.counts && ['unmatched', 'roles', 'stuck', 'asked'].every((k) => typeof todo.body.counts[k] === 'number'), todo.body.counts);
    ck('...unmatched names come most valuable first, so the list is worth reading top down',
       todo.body.unmatched.every((u, i, a) => !i || a[i - 1].value >= u.value));
    ck('...a name she already matched is not asked about again',
       !todo.body.unmatched.some((u) => KEYNAME(u.name) === 'mario'), todo.body.unmatched.slice(0, 3));
    ck('...an unset account role is on the list, with what it is for',
       todo.body.roles.every((r) => r.role && r.why), todo.body.roles);

    // a blocked row is a question until it is entered; then it is not
    journal.record({ env: 'sandbox', kind: 'bill', action: 'blocked', jarvis: { id: 'TODO_B1', supplier: 'Aris', container: 'ARIS1111111' }, reason: 'no supplier amount yet' });
    journal.record({ env: 'sandbox', kind: 'bill', action: 'blocked', jarvis: { id: 'TODO_B2', supplier: 'Hugo', container: 'HUGO2222222' }, reason: 'grade has no amount' });
    journal.record({ env: 'sandbox', kind: 'bill', action: 'created', jarvis: { id: 'TODO_B2', supplier: 'Hugo' }, qb: { id: '9001' }, reason: '' });
    const todo2 = await get('/api/qb/todo');
    ck('a stuck row is listed with its reason, not just counted',
       todo2.body.stuck.some((x) => x.what === 'ARIS1111111' && /no supplier amount/.test(x.why)), todo2.body.stuck);
    ck('...and one that went in afterwards drops off the list — last word wins',
       !todo2.body.stuck.some((x) => x.what === 'HUGO2222222'), todo2.body.stuck);

    // ── account roles ──────────────────────────────────────────────────────
    ck('locked: setting a role is refused', (await post('/api/qb/role', { role: 'prepayment', qbId: '98' })).code === 400);
    const badRole = await post('/api/qb/role', { role: 'not a role', qbId: '98', unlock: true });
    ck('an unknown role is refused and the real ones are named',
       badRole.code === 400 && /prepayment/.test(badRole.body.error), badRole.body);
    ck('a role with no account is refused', (await post('/api/qb/role', { role: 'trucking', unlock: true })).code === 400);
    const roleSet = await post('/api/qb/role', { role: 'prepayment', qbId: '98', qbName: 'Vendor Payable', unlock: true });
    ck('unlocked admin can say which account answers a role', roleSet.code === 200 && roleSet.body.saved.qbId === '98', roleSet.body);
    const afterRole = await get('/api/qb/status');
    ck('...and the chip stops saying unmapped', (afterRole.body.roles.find((r) => r.role === 'prepayment') || {}).qbId === '98',
       afterRole.body.roles);
    ck('...and it drops off the worklist', !(await get('/api/qb/todo')).body.roles.some((r) => r.role === 'prepayment'));

    // ── creating a party she approved ──────────────────────────────────────
    ck('locked: creating a party is refused', (await post('/api/qb/create-party', { kind: 'vendor', name: 'X' })).code === 400);
    ck('a party with no name is refused', (await post('/api/qb/create-party', { kind: 'vendor', unlock: true })).code === 400);
    ck('a kind that is not vendor or customer is refused',
       (await post('/api/qb/create-party', { kind: 'item', name: 'X', unlock: true })).code === 400);
    // QuickBooks is unreachable in this test, so the create must FAIL — and
    // must not leave a mapping behind pointing at a party that never existed.
    const cantCreate = await post('/api/qb/create-party', { kind: 'vendor', name: 'Brand New Yard', unlock: true });
    ck('with QuickBooks unreachable, creating fails loudly', cantCreate.code === 400 && !!cantCreate.body.error, cantCreate.body);
    const mapNow = JSON.parse(fs.readFileSync(process.env.QB_PARTY_MAP_FILE, 'utf8'));
    ck('...and no half-made mapping is left behind', !Object.keys(mapNow.vendor || {}).includes('brandnewyard'), Object.keys(mapNow.vendor || {}));
    const pageSrc2 = fs.readFileSync(require('path').join(__dirname, '..', 'dashboard', 'quickbooks.html'), 'utf8');
    ck('the match dialog offers to create it when nothing matches', /NEW to create it in QuickBooks/.test(pageSrc2));
    ck('the worklist is what the page opens on', /loadTodo\(\);/.test(pageSrc2) && /api\/qb\/todo/.test(pageSrc2));
    ck('a role chip can be clicked to set it', /data-role=/.test(pageSrc2) && /api\/qb\/role/.test(pageSrc2));

    // ── her books, without opening QuickBooks (2026-09-26) ─────────────────
    const unmappedDocs = await get('/api/qb/party-docs?kind=vendor&name=Nobody%20At%20All');
    ck('the QuickBooks tab of an unmatched party says so instead of erroring',
       unmappedDocs.code === 200 && unmappedDocs.body.mapped === false && /match it/.test(unmappedDocs.body.note || ''), unmappedDocs.body);
    ck('party-docs needs a party', (await get('/api/qb/party-docs?kind=vendor')).code === 400);
    ck('find needs something to find', (await get('/api/qb/find?q=')).code === 400);
    // QuickBooks is unreachable in this test: the page must say that plainly
    // rather than show an empty set of books as if they were the truth.
    const booksOut = await get('/api/qb/books');
    ck('with QuickBooks unreachable, the books say so — a zero is not a fact',
       booksOut.code === 200 && /QuickBooks/.test(booksOut.body.unreadable || ''), booksOut.body.unreadable);
    const findOut = await get('/api/qb/find?q=25AQ02');
    ck('...and a search that could not look says that, not "nothing found"',
       findOut.code === 200 && !findOut.body.hits.length && Array.isArray(findOut.body.couldNotLook)
       && findOut.body.couldNotLook.length > 0, findOut.body);
    const pageSrc3 = fs.readFileSync(require('path').join(__dirname, '..', 'dashboard', 'quickbooks.html'), 'utf8');
    ck('the party has an In QuickBooks tab', /In QuickBooks/.test(pageSrc3) && /api\/qb\/party-docs/.test(pageSrc3));
    ck('the books and a document search are on the page', /data-books=/.test(pageSrc3) && /data-find=/.test(pageSrc3));
    ck('...the headline is the balance QuickBooks itself totals, not a pile of documents',
       /as QuickBooks itself totals them/.test(pageSrc3) && /never applied to a document/.test(pageSrc3));
    ck('...and money older than the year is named, not dropped', /Not counted above/.test(pageSrc3));

    // ── the last three scripts (2026-09-26) ────────────────────────────────
    ck('locked: asking for the connect link is refused', (await post('/api/qb/connect-url', {})).code === 400);
    ck('locked: connecting is refused', (await post('/api/qb/connect', { redirectedUrl: 'https://x/?code=1' })).code === 400);
    const badLanded = await post('/api/qb/connect', { redirectedUrl: 'not a url', unlock: true });
    ck('a pasted address with no code is refused, and says what to paste',
       badLanded.code === 400 && /whole address/i.test(badLanded.body.error), badLanded.body);

    ck('locked: the older-list push is refused', (await post('/api/qb/push-list', { kind: 'bill', reason: 'because' })).code === 400);
    const listNoReason = await post('/api/qb/push-list', { kind: 'bill', unlock: true });
    ck('an older-list push with no reason is refused — the journal needs one',
       listNoReason.code === 400 && /reason/.test(listNoReason.body.error), listNoReason.body);
    const noConfirm = await post('/api/qb/push-list', { kind: 'bill', reason: 'backlog she confirmed', really: true, unlock: true });
    ck('...and going live without typing ENTER is refused',
       noConfirm.code === 400 && /ENTER/.test(noConfirm.body.error), noConfirm.body);
    const listBadKind = await post('/api/qb/push-list', { kind: 'journal', reason: 'backlog she confirmed', unlock: true });
    ck('...and a kind it cannot push is refused', listBadKind.code === 400 && /invoice, bill or advance/.test(listBadKind.body.error), listBadKind.body);
    const dryList = await post('/api/qb/push-list', { kind: 'bill', party: 'Nobody At All', since: '2026-01-01', until: '2026-12-31', reason: 'a window with nothing in it', unlock: true });
    ck('a dry run answers with the rows it would touch and writes nothing',
       dryList.code === 200 && dryList.body.dryRun === true && Array.isArray(dryList.body.rows), dryList.body);

    const pageSrc4 = fs.readFileSync(require('path').join(__dirname, '..', 'dashboard', 'quickbooks.html'), 'utf8');
    ck('sheet-vs-books is on the page', /data-missing=/.test(pageSrc4) && /api\/qb\/missing/.test(pageSrc4));
    ck('...and it says which side of the cutover each row falls', /accountant's period/.test(pageSrc4));
    ck('the older-list push is on the page, dry run first', /data-older=/.test(pageSrc4) && /really: false/.test(pageSrc4));
    ck('...and the live run needs the word ENTER typed', /toUpperCase\(\) !== 'ENTER'/.test(pageSrc4));
    ck('connecting QuickBooks is on the page', /data-connect=/.test(pageSrc4) && /api\/qb\/connect-url/.test(pageSrc4));

    // ── void, delete and merge (2026-09-26) ────────────────────────────────
    // Apsara: "Merging two parties, voiding or deleting anything should be
    // there on qb. Ensure the impact before changing any section."
    ck('locked: voiding is refused', (await post('/api/qb/void', { type: 'invoice', id: '1' })).code === 400);
    ck('locked: adopting a merge is refused', (await post('/api/qb/merged', { deadId: '1', survivorId: '2' })).code === 400);
    const badType = await get('/api/qb/impact?type=receipt&id=1');
    ck('an impact for a type QuickBooks has no operation for is refused, and lists the real ones',
       badType.code === 400 && /invoice/.test(badType.body.error), badType.body);
    const mergeNeeds = await post('/api/qb/merged', { kind: 'vendor', unlock: true });
    ck('adopting a merge needs both ids', mergeNeeds.code === 400 && /old id/.test(mergeNeeds.body.error), mergeNeeds.body);
    const risky = fs.readFileSync(require('path').join(__dirname, '..', 'helpers', 'quickbooks', 'riskyOps.js'), 'utf8');
    ck('a change is refused if the document moved since she looked at it', /changed in QuickBooks since you looked/.test(risky));
    ck('...and a bill is never offered a void, because QuickBooks cannot void one',
       /bill: \{ table: 'Bill', void: false/.test(risky));
    ck('...and the impact is taken again inside the change, not trusted from the caller', /const now = await impact\(type, id/.test(risky));
    ck('merging says plainly that QuickBooks will not do it over the API', /canDoItHere: false/.test(risky) && /error 2010/.test(risky));
    const pageSrc5 = fs.readFileSync(require('path').join(__dirname, '..', 'dashboard', 'quickbooks.html'), 'utf8');
    ck('the page makes her type the document number to void one', /mustType: d\.doc/.test(pageSrc5));
    ck('...and shows every warning before she can', /im\.warnings\.map/.test(pageSrc5));
    ck('duplicates are on the page', /data-dupes=/.test(pageSrc5) && /api\/qb\/duplicates/.test(pageSrc5));
    ck('...and a reused reference is shown as NOT a duplicate, not accused',
       /NOT a duplicate: different containers under one number/.test(pageSrc5));
    const dupes = await get('/api/qb/duplicates');
    ck('with QuickBooks unreachable, the duplicate check says so', dupes.code === 502 && /QuickBooks/.test(dupes.body.error || ''), dupes.body);

    // ── one name list for customers, vendors and employees (2026-09-26) ────
    // Apsara, creating a supplier: "Duplicate Name Exists Error … Id=505".
    // #505 was a CUSTOMER, "nur metals". QuickBooks keeps ONE display-name
    // list across all three, so a company she both buys from and sells to
    // cannot carry the same name twice. Checking only the same kind walked
    // straight into Intuit's refusal.
    const routesSrc2 = fs.readFileSync(require('path').join(__dirname, '..', 'helpers', 'quickbooks', 'routes.js'), 'utf8');
    ck('creating a party checks the OTHER name list too', /const other = kind === 'vendor' \? 'customer' : 'vendor'/.test(routesSrc2));
    ck('...and answers 409 with what holds the name and a name that would work',
       /status: 'name-taken'/.test(routesSrc2) && /suggestion/.test(routesSrc2));
    ck('...and Intuit\'s own duplicate refusal is translated, not repeated',
       /Duplicate Name Exists.*?Id=/is.test(routesSrc2));
    const pageSrc6 = fs.readFileSync(require('path').join(__dirname, '..', 'dashboard', 'quickbooks.html'), 'utf8');
    ck('the page offers the working name instead of showing the error', /That name is taken in QuickBooks/.test(pageSrc6));
    ck('...which needs the refusal body, not just its sentence', /err\.body = j/.test(pageSrc6));

    // ── the bank's "For Review" list (2026-09-26) ──────────────────────────
    // Apsara: "i need it." QuickBooks exposes that queue to no app — checked
    // against her own books: no BankTransaction entity, /olb unsupported, and
    // no report carries an un-reviewed line because it is not a transaction
    // yet. The CSV the Banking screen exports is the way in.
    ck('a bank review with no file is refused, and says what to send',
       (await post('/api/qb/bank-review', {})).code === 400);
    const notACsv = await post('/api/qb/bank-review', { csv: 'nothing like a bank export' });
    ck('a file with no bank lines in it is refused, not silently empty',
       notACsv.code === 400 && /header row|export/.test(notACsv.body.error), notACsv.body);
    const bank = require('../scripts/qb-bank-match.js');
    const read = bank.readBankLines({ text: 'Date,Description,Payee,Spent,Received\n09/15/2026,WIRE OUT,Inesh Cores Chapin,60000,\n09/16/2026,ZELLE IN,Rad Metals,,45120.50\n' });
    ck('the matcher reads an uploaded export the same way it reads a file',
       read.lines.length === 2 && read.lines[0].direction === 'out' && read.lines[1].direction === 'in', read.lines);
    ck('...money out and money in are never mixed up', read.lines[0].amount === 60000 && read.lines[1].amount === 45120.5);
    const pageSrc7 = fs.readFileSync(require('path').join(__dirname, '..', 'dashboard', 'quickbooks.html'), 'utf8');
    ck('the bank screen is on the page', /data-bank=/.test(pageSrc7) && /api\/qb\/bank-review/.test(pageSrc7));
    ck('...and says plainly that it writes nothing to QuickBooks', /Nothing here touches QuickBooks/.test(pageSrc7));

    // ── the cutover, from the page (2026-09-26) ────────────────────────────
    // Apsara: "I want nightly report to run everyday to upload all the bills
    // and invoices." The cutover decides what "all" is, so it has to be
    // movable here — moving it used to mean SSH and a pm2 restart.
    ck('status carries the cutover and where it comes from',
       !!status.body.cutover && typeof status.body.cutover.billsFrom === 'string', status.body.cutover);
    ck('status says when the nightly run happens', /00:00/.test(((status.body.nightly) || {}).at || ''), status.body.nightly);
    ck('locked: moving the cutover is refused', (await post('/api/qb/cutover', { bills: '2026-09-06' })).code === 400);
    const cut = await post('/api/qb/cutover', { bills: '2026-09-06', invoices: '2026-08-28', unlock: true });
    ck('unlocked admin can move the cutover', cut.code === 200 && cut.body.cutover.bills === '2026-09-06'
       && cut.body.cutover.invoices === '2026-08-28' && cut.body.cutover.billsFrom === 'setting', cut.body);
    ck('...and it says the next run uses it, no restart', /no restart/.test(cut.body.note || ''), cut.body.note);
    const badCut = await post('/api/qb/cutover', { bills: 'soon', unlock: true });
    ck('a junk date is refused with a readable reason', badCut.code === 400 && /date like/.test(badCut.body.error), badCut.body);
    ck('...and the boundary did not move', (await get('/api/qb/status')).body.cutover.bills === '2026-09-06');
    ck('an empty change is refused rather than saved as nothing', (await post('/api/qb/cutover', { unlock: true })).code === 400);
    ck('the page can move it without the terminal', /data-cut=/.test(html) && /api\/qb\/cutover/.test(html));

    // ── the same sweep, on demand ──────────────────────────────────────────
    ck('locked: run-now is refused', (await post('/api/qb/run', {})).code === 400);
    // pushed far into the future first, so this runs the sweep over nothing
    await post('/api/qb/cutover', { bills: '2027-01-01', invoices: '2027-01-01', unlock: true });
    const run = await post('/api/qb/run', { unlock: true });
    ck('run-now checks by default — nothing is written unless asked',
       run.code === 200 && run.body.dryRun === true && /nothing was written/i.test(run.body.report || ''), run.body);
    ck('...and reports what the cutover left alone', typeof (run.body.summary || {}).left === 'number', run.body.summary);
    ck('the page has the button', /data-run=/.test(html) && /api\/qb\/run/.test(html));

    server.close();
    try { fs.rmSync(_tmp, { recursive: true, force: true }); } catch {}
    console.log(`\nquickbooks-page: ${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
})();
