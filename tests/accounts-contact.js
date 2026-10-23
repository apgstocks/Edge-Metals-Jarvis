// ── tests/accounts-contact.js ───────────────────────────────────────────────
// Chasing one named person about payments that never got recorded.
//
// Apsara, 2026-10-23: "send a message to accounts team of edge metals asking
// about payment sent status.They are forgetting to record the payment in
// jarvis" — and on how it should reach them: "Both in Jarvis and WHatsapp to
// the person who i give number in website.create that field in settings".
//
// The risk this guards is specific: a reminder about money leaving the
// company that quietly goes nowhere is worse than no reminder, because she
// would believe it was sent and stop chasing.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const R = (p) => path.join(ROOT, p);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-contact-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
delete require.cache[require.resolve(R('config.js'))];
const cfg = require(R('config.js'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('ABORT — DATA_DIR outside temp'); process.exit(1); }

let pass = 0, fail = 0; const failures = [];
const ck = (n, ok, extra) => { if (ok) { pass++; console.log('  ok   ' + n); } else { fail++; failures.push(n); console.log('  FAIL ' + n + (extra === undefined ? '' : ' — ' + JSON.stringify(extra).slice(0, 200))); } };
const section = (t) => console.log('\n' + t);

const notify = require(R('helpers/notify.js'));
const { loadSettings } = require(R('helpers/json.js'));

(async () => {

section('A — the number is turned into something Twilio accepts');
ck('a plain number becomes a whatsapp: address', notify.waNumber('918056944193') === 'whatsapp:+918056944193');
ck('spaces, plus and dashes are tolerated — she will paste it how she has it',
    notify.waNumber('+91 80569-44193') === 'whatsapp:+918056944193', notify.waNumber('+91 80569-44193'));
ck('nothing usable gives nothing, not "whatsapp:+"', notify.waNumber('') === '' && notify.waNumber('  ') === '');

section('B — it refuses rather than half-sending');
{
    const r = await notify.messageAccounts('Subject', 'Body');
    ck('with no contact set, NOTHING is sent', r.sent === false && r.whatsapp === false && r.email === false, r);
    ck('  and it says why, naming where to fix it', /Settings > Accounts contact/.test(r.skipped.join(' ')), r.skipped);
}

section('C — both channels, from one call');
{
    const sentWa = []; const sentMail = [];
    const twilioLib = { messages: { create: async (m) => { sentWa.push(m); return { sid: 'x' }; } } };
    const sendEmail = async (m) => { sentMail.push(m); };
    process.env.TWILIO_SID = 'SID'; process.env.TWILIO_AUTH_TOKEN = 'TOK'; process.env.TWILIO_FROM = '15550000000';
    delete require.cache[require.resolve(R('config.js'))];
    delete require.cache[require.resolve(R('helpers/notify.js'))];
    const n2 = require(R('helpers/notify.js'));

    const who = { name: 'Accounts', whatsapp: '918056944193', email: 'accounts@edgemetals.com' };
    const r = await n2.messageContact(who, 'Payments not recorded', 'Please confirm.', { twilioLib, sendEmail });

    ck('WhatsApp went', r.whatsapp === true && sentWa.length === 1, r);
    ck('  to the number she typed', sentWa[0].to === 'whatsapp:+918056944193', sentWa[0] && sentWa[0].to);
    ck('  from a whatsapp: address too, not a bare SMS number', /^whatsapp:/.test(sentWa[0].from), sentWa[0] && sentWa[0].from);
    ck('  carrying the subject AND the body', /Payments not recorded/.test(sentWa[0].body) && /Please confirm/.test(sentWa[0].body));
    ck('email went to the same person', r.email === true && sentMail[0].to === 'accounts@edgemetals.com');
    ck('  both channels reported', r.sent === true);

    // One channel missing must not silence the other — she gave a number
    // but may not have an address for them.
    sentWa.length = 0; sentMail.length = 0;
    const waOnly = await n2.messageContact({ whatsapp: '918056944193' }, 'S', 'B', { twilioLib, sendEmail });
    ck('WhatsApp alone still sends', waOnly.whatsapp === true && waOnly.email === false && waOnly.sent === true);
    ck('  and the missing channel is reported, not hidden', /no email/.test(waOnly.skipped.join(' ')), waOnly.skipped);

    // A dead Twilio must not take the email with it.
    const boom = { messages: { create: async () => { throw new Error('twilio down'); } } };
    const half = await n2.messageContact({ whatsapp: '91805', email: 'a@b.c' }, 'S', 'B', { twilioLib: boom, sendEmail });
    ck('a failed WhatsApp does not stop the email', half.email === true && half.whatsapp === false, half);
    ck('  and the failure is carried back, not swallowed', /twilio down/.test(half.errors.join(' ')), half.errors);
}

section('D — the field exists where she was told to type it');
{
    ck('settings carry an accounts contact by default',
        !!loadSettings().accounts_contact && loadSettings().accounts_contact.whatsapp === '');
    const screen = fs.readFileSync(R('dashboard/app/03-settings-contacts.js'), 'utf8');
    for (const id of ['s_acc_name', 's_acc_wa', 's_acc_email']) {
        ck(`  Settings has a box for ${id}`, screen.includes(`id="${id}"`));
        ck(`    and actually saves it`, screen.includes(`$('${id}')`));
    }
    // PUT /api/settings merges TOP-LEVEL keys only. Sending a partial
    // accounts_contact would replace the object and wipe the fields she did
    // not retype — so the screen must send all three together.
    ck('  the whole contact is sent as one object, so saving one field cannot wipe the others',
        /accounts_contact: \{[\s\S]*?name:[\s\S]*?whatsapp:[\s\S]*?email:/.test(screen));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('  FAILED:'); failures.forEach((f) => console.log('   · ' + f)); }
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW', e && e.stack || e); process.exit(1); });
