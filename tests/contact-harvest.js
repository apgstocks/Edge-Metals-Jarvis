// ── tests/contact-harvest.js ────────────────────────────────────────────────
// Apsara, 2026-09-19, four messages in a row:
//
//   "is there any option to learn email contacts..?"
//   "How to learn all the email contacts?"
//   "from email to email contacts tab"
//   "save it"
//
// There WAS an option and it was not the one she wanted: "learn radmetals
// contacts" learns ONE company she names, through WhatsApp. She is asking for
// the whole mailbox, landing in the tab she was looking at.
//
// ── WHAT THIS IS REALLY GUARDING ────────────────────────────────────────────
// Email Contacts is what resolveContact reads to decide WHERE A CUSTOMER'S
// INVOICE GOES. A bulk writer pointed at it is the most dangerous thing built
// today: one careless sweep and a name she typed herself is silently replaced
// by a local-part scraped off a Cc line. So most of this file is about what
// the harvest REFUSES to do.
//
// Gmail is a stub object, never the real client — helpers/contactHarvest.js
// takes the client as an argument for exactly that reason. A test that can
// reach her live mailbox is a test that will one day read it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-harvest-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.ADMIN_PASSWORD = 'admin-pw-hhhhhhhhhhhh';

const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(os.tmpdir())) {
    console.error('REFUSING TO RUN: DATA_DIR is not a temp directory.');
    process.exit(1);
}
const harvest = require(path.join(ROOT, 'helpers/contactHarvest'));
const emailContacts = require(path.join(ROOT, 'helpers/emailContacts'));

// ── A MAILBOX, AS ONE REALLY LOOKS ──────────────────────────────────────────
// Real suppliers, a shared mailbox, a no-reply, her own address, a stranger
// Cc'd once on somebody else's thread, and a display name that must survive.
const MAIL = [
    { From: '"Marc Kang" <marckang@mkmetaltrading.com>', To: 'apsara@edgemetals.com', Cc: 'export@mkmetaltrading.com' },
    { From: '"Marc Kang" <marckang@mkmetaltrading.com>', To: 'apsara@edgemetals.com', Cc: 'export@mkmetaltrading.com' },
    { From: 'export@mkmetaltrading.com', To: 'apsara@edgemetals.com', Cc: '' },
    { From: '"Joey Lee" <joey@daekwang.example>', To: 'apsara@edgemetals.com', Cc: 'accounts@daekwang.example' },
    { From: 'apsara@edgemetals.com', To: '"Joey Lee" <joey@daekwang.example>', Cc: '' },
    { From: 'no-reply@shippingline.example', To: 'apsara@edgemetals.com', Cc: '' },
    { From: 'notifications@portal.example', To: 'apsara@edgemetals.com', Cc: '' },
    { From: '"Bose" <bose@edgemetals.com>', To: 'apsara@edgemetals.com', Cc: '' },
    { From: '"Joey Lee" <joey@daekwang.example>', To: 'apsara@edgemetals.com', Cc: 'stranger@somewhere.example' },
    // accounts@ appears TWICE and never as a sender. Two things follow, and
    // both are the real rules rather than my first guess at them:
    //   - twice means it is not "thin", so it reaches the list at all;
    //   - from === 0 is what proposeDomainRoles calls a SHARED mailbox.
    { From: '"Joey Lee" <joey@daekwang.example>', To: 'apsara@edgemetals.com', Cc: 'accounts@daekwang.example' },
    // Two unrelated people who happen to share a consumer mail provider.
    // Apsara, 2026-09-20, seeing the first real harvest file one of these
    // under a group called HOTMAIL.COM: "if i want to change the domain-??"
    { From: '"Pan Metal Michael" <panmetal@hotmail.com>', To: 'apsara@edgemetals.com', Cc: '' },
    { From: 'apsara@edgemetals.com', To: '"Pan Metal Michael" <panmetal@hotmail.com>', Cc: '' },
    { From: '"Dana Ortiz" <dortiz@hotmail.com>', To: 'apsara@edgemetals.com', Cc: '' },
    { From: 'apsara@edgemetals.com', To: '"Dana Ortiz" <dortiz@hotmail.com>', Cc: '' },
];
const fakeGmail = {
    users: { messages: {
        list: async ({ maxResults }) => ({ data: {
            messages: MAIL.slice(0, maxResults).map((_, i) => ({ id: String(i) })) } }),
    } },
};
const fakeGetMessage = async (_g, id) => {
    const m = MAIL[Number(id)];
    return { payload: { headers: Object.entries(m).map(([name, value]) => ({ name, value })) } };
};
const MINE = ['apsara@edgemetals.com', 'bose@edgemetals.com'];

(async () => {

// ── A. THE SCAN ─────────────────────────────────────────────────────────────
section('A. reading the mailbox');
let tally;
{
    const r = await harvest.scan(fakeGmail, { limit: 50, mine: MINE, getMessage: fakeGetMessage });
    tally = r.tally;
    ck('it reads every message', r.scanned === MAIL.length, `${r.scanned} of ${MAIL.length}`);
    ck('  and tallies From, To and Cc alike',
       tally.get('marckang@mkmetaltrading.com').from === 2
       && tally.get('export@mkmetaltrading.com').cc === 2
       && tally.get('joey@daekwang.example').to === 1,
       JSON.stringify([...tally].slice(0, 3)));
    ck('  keeping the real display name off the header',
       tally.get('marckang@mkmetaltrading.com').displayName === 'Marc Kang',
       String(tally.get('marckang@mkmetaltrading.com').displayName));
    ck('  which is what stops an email saying "Dear export"',
       tally.get('joey@daekwang.example').displayName === 'Joey Lee');

    // ── ONE UNREADABLE MESSAGE MUST NOT END THE SWEEP ───────────────────
    // She asked for everyone. 199 of 200 is a far better answer than a
    // stack trace.
    const flaky = await harvest.scan(fakeGmail, { limit: 50, mine: MINE,
        getMessage: async (g, id) => {
            if (id === '3') throw new Error('that one is gone');
            return fakeGetMessage(g, id);
        } });
    ck('a message it cannot read is skipped, not fatal',
       flaky.scanned === MAIL.length - 1, String(flaky.scanned));

    // Spam is worse than nothing here: a contact learned from spam lands in
    // the tab she trusts to address invoices.
    let asked = null;
    await harvest.scan({ users: { messages: { list: async (a) => { asked = a; return { data: {} }; } } } },
                       { getMessage: fakeGetMessage });
    ck('  and spam and trash are excluded at the query',
       /-in:spam/.test(asked.q) && /-in:trash/.test(asked.q), asked.q);
}

// ── B. WHAT IT REFUSES TO PROPOSE ───────────────────────────────────────────
section('B. what never reaches the list');
let proposed;
{
    const r = harvest.propose(tally, { mine: MINE, known: [] });
    proposed = r;
    const all = r.domains.flatMap((d) => d.proposals.map((p) => p.addr));

    ck('her own address is not a contact', !all.includes('apsara@edgemetals.com'));
    ck('  nor is anyone else on her own domain', !all.includes('bose@edgemetals.com'),
       'her own company proposing itself as a customer is noise she has to untick forever');
    ck('  and the whole domain is skipped by address, not by guesswork',
       r.skipped.mine >= 2, JSON.stringify(r.skipped));

    ck('no-reply@ is not a contact', !all.includes('no-reply@shippingline.example'));
    ck('  nor notifications@', !all.includes('notifications@portal.example'));
    ck('  counted as machine addresses', r.skipped.machine === 2, JSON.stringify(r.skipped));

    // Seen once, only in a Cc, never written to: a name on somebody else's
    // thread, not a correspondent of hers.
    ck('someone Cc\'d once on another thread is not a contact',
       !all.includes('stranger@somewhere.example'), all.join(', '));
    ck('  counted as thin rather than silently vanishing', r.skipped.thin >= 1,
       JSON.stringify(r.skipped));

    // ── AND WHAT DOES ───────────────────────────────────────────────────
    // Consumer providers appear too (see C2) — they are headings, not
    // companies — so this asserts the real COMPANIES are there rather than
    // pinning the whole list, which would go red every time the fixture
    // grows a new kind of sender.
    const realCompanies = r.domains.filter((d) => !d.freemail).map((d) => d.domain).sort();
    ck('the two real companies are proposed',
       realCompanies.join(',') === 'daekwang.example,mkmetaltrading.com',
       realCompanies.join(','));
    ck('  busiest company first, because that list runs long',
       r.domains[0].messages >= r.domains[1].messages,
       r.domains.map((d) => `${d.domain}:${d.messages}`).join(' '));
}

// ── C. THE ROLES ARE NOT DECIDED HERE ───────────────────────────────────────
// primary / secondary / shared comes from emailContacts.proposeDomainRoles —
// the SAME function "learn X contacts" and scripts/learnDomain.js use. Three
// ways in, ONE opinion about what a contact is. A second implementation would
// disagree eventually, and it would disagree about which address a customer's
// invoice goes to.
section('C. one opinion about who is primary');
{
    const src = fs.readFileSync(path.join(ROOT, 'helpers/contactHarvest.js'), 'utf8');
    ck('the harvest calls proposeDomainRoles rather than deciding for itself',
       /emailContacts\.proposeDomainRoles\(/.test(src),
       'a second implementation would disagree about where an invoice goes');
    ck('  and does not invent a role anywhere',
       !/role\s*=\s*['"]primary['"]/.test(src), 'roles are that function\'s business');

    const mk = proposed.domains.find((d) => d.domain === 'mkmetaltrading.com');
    ck('the person who actually writes is primary',
       (mk.proposals.find((p) => p.addr === 'marckang@mkmetaltrading.com') || {}).role === 'primary',
       JSON.stringify(mk.proposals.map((p) => `${p.addr}:${p.role}`)));

    // ── AND export@ IS SECONDARY, NOT SHARED ────────────────────────────
    // My first version of this asserted 'shared' and was wrong about the
    // rule, not about the code. proposeDomainRoles calls an address shared
    // when it never sends (from === 0), or when it is Cc'd at least ten
    // times AND at least three times as often as it sends. export@ sends
    // once here, so it is a person-shaped member of the group. Written down
    // because guessing that threshold is how a second implementation starts.
    ck('  and an address that DOES send is a member, not a mailbox',
       (mk.proposals.find((p) => p.addr === 'export@mkmetaltrading.com') || {}).role === 'secondary',
       JSON.stringify(mk.proposals.map((p) => `${p.addr}:${p.role}`)));

    const dkD = proposed.domains.find((d) => d.domain === 'daekwang.example');
    ck('an address that never sends IS a shared mailbox',
       (dkD.proposals.find((p) => p.addr === 'accounts@daekwang.example') || {}).role === 'shared',
       JSON.stringify(dkD.proposals.map((p) => `${p.addr}:${p.role}`)));
}

// ── C2. A CONSUMER MAIL PROVIDER IS NOT A COMPANY ───────────────────────────
// Apsara, 2026-09-20, on the first real harvest: a contact at
// panmetal@hotmail.com filed under a domain group called HOTMAIL.COM and
// labelled "shared / mailbox".
//
// The label was cosmetic. The GROUP was not. A domain group in
// helpers/emailContacts.js means its members are colleagues: they auto-cc
// each other, and a bare company name resolves to whoever is primary. File
// three unrelated people under hotmail.com and emailing one of them copies
// the other two — strangers, on commercial mail.
section('C2. hotmail.com is not a company');
{
    const r = harvest.propose(tally, { mine: MINE, known: [] });
    const hot = r.domains.find((d) => d.domain === 'hotmail.com');
    ck('the provider still appears, as a heading', !!hot, r.domains.map((d) => d.domain).join(','));
    ck('  flagged as consumer mail', hot && hot.freemail === true);
    ck('  with both people under it', hot && hot.proposals.length === 2,
       JSON.stringify(hot && hot.proposals.map((p) => p.addr)));

    ck('but NOBODY there is put in a domain group',
       hot.proposals.every((p) => p.domain === null),
       JSON.stringify(hot.proposals.map((p) => p.domain)));
    ck('  and nobody is given a role',
       hot.proposals.every((p) => p.role === null),
       JSON.stringify(hot.proposals.map((p) => p.role)));
    ck('  so two strangers can never auto-cc each other', 
       hot.proposals.every((p) => !p.domain && !p.role),
       'that is what a domain group MEANS, and it is not cosmetic');

    ck('  they are named from the real header, not the local part',
       hot.proposals.some((p) => p.name === 'Pan Metal Michael'),
       JSON.stringify(hot.proposals.map((p) => p.name)));

    // A real company is unaffected — the fix must not flatten everything.
    const mkStill = r.domains.find((d) => d.domain === 'mkmetaltrading.com');
    ck('a real company is still grouped', mkStill.proposals.every((p) => p.domain === undefined || p.domain),
       'flattening every domain would throw away the thing groups are for');
    ck('  and still has a primary',
       mkStill.proposals.some((p) => p.role === 'primary'));

    // ── AND THE SHARED FUNCTION IS NOT WHAT CHANGED ─────────────────────
    // proposeDomainRoles is used by "learn X contacts" and
    // scripts/learnDomain.js, always for a company SHE NAMED — where an
    // address that never sends really is likely a shared mailbox. The wrong
    // label came from sweeping personal domains it was never pointed at, so
    // the fix belongs at the sweep.
    // Scoped to the FUNCTION, not the file: emailContacts.js now mentions
    // hotmail in updateContact's note about why the group became editable,
    // and a whole-file grep went red on my own comment. A check that reads
    // the wrong span is a check that will be deleted the next time it lies.
    const ecSrc = fs.readFileSync(path.join(ROOT, 'helpers/emailContacts.js'), 'utf8');
    const fnStart = ecSrc.indexOf('function proposeDomainRoles');
    const fnEnd = ecSrc.indexOf('\nfunction ', fnStart + 1);
    const fnSrc = ecSrc.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
    ck('  proposeDomainRoles itself is untouched by this',
       fnStart > -1 && !/FREEMAIL|hotmail|gmail|freemail/i.test(fnSrc),
       'changing it would change "learn X contacts" too, which nobody asked for');
}

// ── C3. THE GROUP CAN BE CHANGED AFTERWARDS ─────────────────────────────────
// "if i want to change the domain-??" — she could not. updateContact copied
// domain and role straight off the old record and the panel said "that stays
// as it is", so a wrong grouping was permanent unless she deleted the contact
// and retyped it, losing the standing Cc with it. That is the same
// delete-and-retype hole the Edit button was added to close.
section('C3. changing a contact\'s group');
{
    await emailContacts.addContact('michael', 'panmetal@hotmail.com',
        { domain: 'hotmail.com', role: 'shared' });
    await emailContacts.setContactCc('michael', ['someone@else.example']);

    await emailContacts.updateContact('michael', { domain: 'panmetal.example', role: 'primary' });
    let got = emailContacts.loadContacts().find((c) => c.name === 'michael');
    ck('the domain can be changed', got.domain === 'panmetal.example', JSON.stringify(got));
    ck('  and the role with it', got.role === 'primary', String(got.role));
    ck('  without losing the standing Cc',
       JSON.stringify(got.cc) === '["someone@else.example"]',
       'deleting and retyping was the old way, and it lost exactly this');

    // Emptying the domain takes the contact out of any group. The role goes
    // with it: a role with no group is a label nothing can act on.
    await emailContacts.updateContact('michael', { domain: '' });
    got = emailContacts.loadContacts().find((c) => c.name === 'michael');
    ck('an empty domain takes them out of the group', got.domain === undefined, JSON.stringify(got));
    ck('  and the orphaned role goes too', got.role === undefined, String(got.role));

    // ── ONE PRIMARY PER DOMAIN ──────────────────────────────────────────
    // Promoting without demoting leaves two, and resolveContact would then
    // pick by list order — which is to say, by accident.
    await emailContacts.addContact('a-one', 'one@grp.example', { domain: 'grp.example', role: 'primary' });
    await emailContacts.addContact('a-two', 'two@grp.example', { domain: 'grp.example', role: 'secondary' });
    await emailContacts.updateContact('a-two', { role: 'primary' });
    const grp = emailContacts.loadContacts().filter((c) => c.domain === 'grp.example');
    ck('promoting a member demotes the old primary',
       grp.filter((c) => c.role === 'primary').length === 1,
       JSON.stringify(grp.map((c) => `${c.name}:${c.role}`)));
    ck('  and it is the one she promoted',
       (grp.find((c) => c.role === 'primary') || {}).name === 'a-two',
       JSON.stringify(grp.map((c) => `${c.name}:${c.role}`)));

    // Nonsense in, refusal out — not a silently stored bad value.
    let err = null;
    try { await emailContacts.updateContact('a-two', { domain: 'not a domain' }); }
    catch (e) { err = e; }
    ck('a malformed domain is refused', !!err && /does not look like a domain/.test(err.message),
       String(err));
    err = null;
    try { await emailContacts.updateContact('a-two', { role: 'boss' }); } catch (e) { err = e; }
    ck('  and an invented role is refused', !!err && /is not a role/.test(err.message), String(err));
    ck('  leaving the contact as it was',
       (emailContacts.loadContacts().find((c) => c.name === 'a-two') || {}).role === 'primary');
}

// ── D. ALREADY SAVED IS SHOWN, NOT RE-OFFERED ───────────────────────────────
section('D. what is already in the tab');
{
    const r = harvest.propose(tally, { mine: MINE,
        known: [{ name: 'joey', email: 'joey@daekwang.example' }] });
    const joey = r.domains.flatMap((d) => d.proposals).find((p) => p.addr === 'joey@daekwang.example');
    ck('an address already saved is marked, not hidden', joey && joey.already_known === true,
       'leaving it out entirely invites her to run the same scan twice asking why');

    const dk = r.domains.find((d) => d.domain === 'daekwang.example');
    ck('  and a company with someone still to add is NOT marked all_known',
       dk && dk.all_known === false, JSON.stringify(dk && dk.proposals.map((p) => p.already_known)));

    const both = harvest.propose(tally, { mine: MINE, known: [
        { name: 'joey', email: 'joey@daekwang.example' },
        { name: 'dk accounts', email: 'accounts@daekwang.example' }] });
    ck('  a company fully saved IS, so the screen can drop it',
       both.domains.find((d) => d.domain === 'daekwang.example').all_known === true);
}

// ── E. END TO END, THROUGH THE ROUTES THE SCREEN USES ───────────────────────
section('E. end to end: scan, pick, save');
{
    const { createApi } = require(path.join(ROOT, 'api'));
    const app = createApi();
    const listener = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${listener.address().port}`;
    const call = (method, p2, sid, body) => new Promise((resolve, reject) => {
        const d = body === undefined ? null : JSON.stringify(body);
        const headers = {};
        if (sid) headers.Authorization = `Bearer ${sid}`;
        if (d) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(d); }
        const r = http.request(base + p2, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {}
                resolve({ status: res.statusCode, json: j, raw }); });
        });
        r.on('error', reject); if (d) r.write(d); r.end();
    });
    const sid = ((await call('POST', '/login', null, { password: 'admin-pw-hhhhhhhhhhhh' })).json || {}).sid;
    ck('logged in', !!sid);

    // Gmail is not configured in a test environment, and the route must say
    // so in words rather than 500 — that is the commonest real failure and
    // "500" sends her looking in the wrong place.
    const noGmail = await call('GET', '/api/email-contacts/harvest', sid);
    ck('with no Gmail configured it explains itself',
       noGmail.status === 503 && (noGmail.json || {}).code === 'GMAIL_UNAVAILABLE',
       `${noGmail.status} ${noGmail.raw.slice(0, 120)}`);
    ck('  naming Gmail rather than returning a bare 500',
       /Gmail isn't configured/.test((noGmail.json || {}).error || ''),
       (noGmail.json || {}).error);

    // ── THE SAVE, WHICH IS THE HALF THAT WRITES ─────────────────────────
    await emailContacts.addContact('joey', 'joey@daekwang.example');
    const before = emailContacts.loadContacts().length;

    const r = await call('POST', '/api/email-contacts/harvest', sid, { save: [
        { name: 'marckang', email: 'marckang@mkmetaltrading.com', domain: 'mkmetaltrading.com',
          role: 'primary', displayName: 'Marc Kang' },
        // Same ADDRESS as the existing contact under a different name.
        { name: 'joey lee', email: 'joey@daekwang.example' },
        // Same NAME as the existing contact, different address.
        { name: 'joey', email: 'someone.else@daekwang.example' },
        { name: '', email: 'accounts@daekwang.example' },
    ] });

    ck('the save answers 200', r.status === 200, `${r.status} ${r.raw.slice(0, 160)}`);
    const saved = (r.json || {}).saved || [];
    const skipped = (r.json || {}).skipped || [];
    ck('  the new contact is written',
       saved.some((x) => x.email === 'marckang@mkmetaltrading.com'), JSON.stringify(saved));
    ck('  and really is in the tab',
       emailContacts.loadContacts().some((c) => c.email === 'marckang@mkmetaltrading.com'));
    ck('  carrying its domain group and role',
       (emailContacts.loadContacts().find((c) => c.email === 'marckang@mkmetaltrading.com') || {}).role === 'primary');
    ck('  and its real display name',
       (emailContacts.loadContacts().find((c) => c.email === 'marckang@mkmetaltrading.com') || {}).displayName === 'Marc Kang',
       'so a drafted email says "Dear Marc Kang", not "Dear marckang"');

    // ── THE REFUSALS, WHICH ARE THE POINT ───────────────────────────────
    ck('an address already saved is NOT written again',
       skipped.some((x) => x.email === 'joey@daekwang.example' && /already saved/.test(x.why)),
       JSON.stringify(skipped));
    ck('  and a NAME already taken is refused rather than overwritten',
       skipped.some((x) => x.email === 'someone.else@daekwang.example' && /already a contact/.test(x.why)),
       'addContact is an upsert by name — a bulk writer would silently replace what she typed');
    ck('  a row with no name is refused, not guessed at',
       skipped.some((x) => x.email === 'accounts@daekwang.example' && /needs a name/.test(x.why)),
       JSON.stringify(skipped));
    ck('  and the existing contact is untouched',
       (emailContacts.loadContacts().find((c) => c.name === 'joey') || {}).email === 'joey@daekwang.example',
       'this tab decides where invoices go; a silent overwrite here is a misdelivered invoice');
    ck('  exactly one row was added', emailContacts.loadContacts().length === before + 1,
       `${before} -> ${emailContacts.loadContacts().length}`);

    ck('an empty selection is a 400, not a no-op 200',
       (await call('POST', '/api/email-contacts/harvest', sid, { save: [] })).status === 400);

    // Same gate as the rest of this tab: it reads her mail and writes her
    // address book.
    ck('an unauthenticated caller cannot scan her mail',
       [401, 403].includes((await call('GET', '/api/email-contacts/harvest', null)).status));
    ck('  nor write to her address book',
       [401, 403].includes((await call('POST', '/api/email-contacts/harvest', null,
           { save: [{ name: 'x', email: 'x@y.example' }] })).status));

    listener.close();
}

// ── E2. MOVING A WHOLE GROUP ────────────────────────────────────────────────
// Apsara, 2026-09-20, looking at six unrelated suppliers filed under a group
// called GMAIL.COM — one of them marked PRIMARY, so a bare company mention
// resolved to a scrap dealer and the other five were auto-cc'd on whatever
// went to any of them: "give an option to move it to diff domain."
//
// The Edit panel moves ONE contact. Six is six rounds of open, clear, save,
// and the sixth is the one that gets forgotten — leaving the group
// half-dismantled and still auto-ccing.
section('E2. six at once, not six times');
{
    const { createApi } = require(path.join(ROOT, 'api'));
    const app = createApi();
    const listener = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${listener.address().port}`;
    const call = (method, p2, sid2, body) => new Promise((resolve, reject) => {
        const dd = body === undefined ? null : JSON.stringify(body);
        const headers = {};
        if (sid2) headers.Authorization = `Bearer ${sid2}`;
        if (dd) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(dd); }
        const r = http.request(base + p2, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {}
                resolve({ status: res.statusCode, json: j, raw }); });
        });
        r.on('error', reject); if (dd) r.write(dd); r.end();
    });
    const sid3 = ((await call('POST', '/login', null, { password: 'admin-pw-hhhhhhhhhhhh' })).json || {}).sid;

    // Her screenshot, near enough: a consumer provider treated as a company,
    // with somebody marked primary.
    await emailContacts.addContact('alscrap01', 'alscrap01@gmail.com',
        { domain: 'gmail.com', role: 'primary', displayName: 'Aluminium Scrap' });
    await emailContacts.addContact('gardunoslogistics', 'gardunoslogistics@gmail.com',
        { domain: 'gmail.com', role: 'shared', displayName: 'Maria Fernanda Garduno' });
    await emailContacts.addContact('brayangonzalez036', 'brayangonzalez036@gmail.com',
        { domain: 'gmail.com', role: 'shared', displayName: 'Brayan Calderon' });

    // ── EMPTY MEANS UNGROUP, AND THAT IS THE ANSWER HERE ────────────────
    const r = await call('POST', '/api/email-contacts/regroup', sid3, {
        names: ['alscrap01', 'gardunoslogistics', 'brayangonzalez036'], domain: '' });
    ck('the whole group moves in one call', r.status === 200 && (r.json || {}).moved.length === 3,
       `${r.status} ${r.raw.slice(0, 160)}`);

    const after = emailContacts.loadContacts();
    const three = after.filter((c) => /@gmail\.com$/.test(c.email));
    ck('  nobody is left in a gmail.com group',
       three.every((c) => c.domain === undefined), JSON.stringify(three.map((c) => c.domain)));
    ck('  and the orphaned roles went with it',
       three.every((c) => c.role === undefined), JSON.stringify(three.map((c) => c.role)));
    ck('  so no two of them auto-cc each other any more',
       three.every((c) => !c.domain),
       'that is what a domain group MEANS — six strangers copied on each other');
    ck('  while the contacts themselves survive',
       three.length === 3 && three.every((c) => c.email && c.name),
       JSON.stringify(three.map((c) => c.name)));
    ck('  keeping their real display names',
       (after.find((c) => c.name === 'alscrap01') || {}).displayName === 'Aluminium Scrap',
       'delete-and-retype was the old way, and it lost exactly this');

    // ── OR MOVED SOMEWHERE REAL, STILL CARRYING THEIR OLD ROLES ─────────
    // A FRESH pair, still in gmail.com with roles intact. The first version
    // of this reused the three above — which had already been ungrouped, so
    // their roles were gone and a mutation that carried roles across had
    // nothing to carry. The check passed while testing nothing.
    await emailContacts.addContact('mmazariegos386', 'mmazariegos386@gmail.com',
        { domain: 'gmail.com', role: 'primary' });
    await emailContacts.addContact('jose.drmironandmetal', 'jose.drmironandmetal@gmail.com',
        { domain: 'gmail.com', role: 'shared', displayName: 'Jose Martinez' });
    ck('(the fixture really does have roles to lose)',
       (emailContacts.loadContacts().find((c) => c.name === 'mmazariegos386') || {}).role === 'primary');

    await call('POST', '/api/email-contacts/regroup', sid3, {
        names: ['mmazariegos386', 'jose.drmironandmetal'], domain: 'drmiron.example' });
    const moved = emailContacts.loadContacts().filter((c) => c.domain === 'drmiron.example');
    ck('they can be moved to a real company instead', moved.length === 2,
       JSON.stringify(moved.map((c) => c.name)));
    ck('  and NOBODY arrives carrying an old role',
       moved.every((c) => c.role === undefined),
       '"primary of gmail.com" means nothing once they are somewhere real, and '
       + 'guessing which of six should lead is the guess proposeDomainRoles refuses');
    ck('  so the new group has no primary until she picks one',
       !moved.some((c) => c.role === 'primary'),
       'a primary inherited from a mail provider is a guess wearing a badge');

    // ── REFUSALS ────────────────────────────────────────────────────────
    const bad = await call('POST', '/api/email-contacts/regroup', sid3,
        { names: ['alscrap01'], domain: 'not a domain' });
    ck('a malformed domain is reported per contact, not thrown',
       bad.status === 200 && (bad.json || {}).skipped.length === 1
       && /does not look like a domain/.test(bad.json.skipped[0].why),
       bad.raw.slice(0, 200));
    // alscrap01 was ungrouped above and the malformed attempt must leave it
    // exactly there — a refusal that half-applies is worse than one that
    // does nothing, because nothing on screen says which half.
    ck('  and nothing moved',
       (emailContacts.loadContacts().find((c) => c.name === 'alscrap01') || {}).domain === undefined,
       JSON.stringify(emailContacts.loadContacts().find((c) => c.name === 'alscrap01')));

    ck('an unknown name is skipped, not fatal to the rest',
       (await call('POST', '/api/email-contacts/regroup', sid3,
           { names: ['nobody-here', 'alscrap01'], domain: '' })).json.moved.length === 1,
       'one bad name must not cost her the other five');
    ck('an empty list is a 400', 
       (await call('POST', '/api/email-contacts/regroup', sid3, { names: [], domain: '' })).status === 400);
    ck('  and an absent domain is too, because empty STRING means something',
       (await call('POST', '/api/email-contacts/regroup', sid3, { names: ['x'] })).status === 400,
       'omitting the field and clearing it are different instructions');
    ck('an unauthenticated caller cannot regroup her address book',
       [401, 403].includes((await call('POST', '/api/email-contacts/regroup', null,
           { names: ['alscrap01'], domain: '' })).status));

    listener.close();
}

// ── F. THE SCREEN ───────────────────────────────────────────────────────────
section('F. the button is where she was looking');
{
    const src = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');
    ck('Email contacts has a Learn from my mail button',
       /id="btnHarvestContacts"/.test(src) && /Learn from my mail/.test(src),
       'she asked while looking at this tab, not at a chat window');
    ck('  it scans before it saves', /email-contacts\/harvest\?limit=/.test(src));
    ck('  and nothing is written without a second press',
       /Nothing is saved until you press Save/.test(src),
       'a sweep of a real mailbox is not something to apply on one click');
    ck('  an already-saved row cannot be ticked',
       /p\.already_known \? 'disabled'/.test(src));
    ck('  a row with no name cannot be saved silently',
       /no name — type one or untick it/.test(src),
       'guessing a label is what produced "Dear export"');
    ck('every group can be moved in one go',
       /btn-regroup/.test(src) && /Move all \$\{members\.length\}/.test(src),
       'six rounds of open-clear-save is how the sixth gets forgotten');
    ck('  Cancel and an empty box are told apart',
       /if \(to === null\) return;/.test(src),
       "prompt() gives null for Cancel and '' for empty OK — '' means ungroup");
    ck('  and a consumer provider says so on its header',
       /is a mail provider, not a company/.test(src),
       'a group headed GMAIL.COM is six strangers who auto-cc each other');
    ck('  the edit panel lets her change the group',
       /class="ec-domain"/.test(src) && /class="ec-role"/.test(src),
       'it used to say "that stays as it is"');
    // The PANEL must not still tell her the grouping is permanent. Matched
    // on the rendered sentence, not on the phrase anywhere in the file — the
    // comment above that markup quotes the old wording on purpose, to record
    // what changed, and a grep for the bare phrase goes red on the history
    // rather than on the behaviour.
    ck('  and no longer tells her the grouping is permanent',
       !/group as <strong>\$\{esc\(m\.role/.test(src),
       'a comment that has become a lie is worse than no comment');
    ck('  emptying the domain is sent, not omitted',
       /domain: panel\.querySelector\('\.ec-domain'\)\.value\.trim\(\)/.test(src),
       'omitting it would preserve a grouping she has just cleared on screen');
    ck('  and what was skipped is reported back, not swallowed',
       /Skipped \$\{skipped\}/.test(src) || /r\.skipped\.map/.test(src),
       'a bulk save that quietly drops rows is one she cannot trust');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
