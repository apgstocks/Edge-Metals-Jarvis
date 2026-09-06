// ── tests/proforma-send.js ────────────────────────────────────────────────
// Apsara, 2026-09-06: "it should be able to send the proforma in mail."
//
// IT COULD NOT, AND MY OWN TEST SAID IT COULD
// -------------------------------------------
// helpers/proformaDraft.js ended its preview with 'say "send it" when you
// are happy'. Nothing anywhere consumed "send it". The module-level draft
// stayed open, the next utterance was absorbed as an answer, and handle()
// re-emitted the same preview for ever.
//
// tests/proforma-voice.js asserted that the preview text MATCHED /send it/i.
// That is a test that the lie is spelled correctly. It is the same
// assertion-that-proves-nothing I spent the whole session finding in other
// places, written by me, and it passed for a week.
//
// So this file tests the SEND, and the shape of it is deliberate:
//
//   · nothing here re-implements sending. The voice flow stages the same
//     `confirm_proforma` pending the email flow stages, and workflow/
//     actions.js:generateProformaFromPending — which already builds the PDF,
//     archives it, records the price, logs the sheet and emails it — does the
//     work. A second sender would be a second set of rules to keep in step.
//   · the assertions are about the HANDOVER and the REFUSALS, because those
//     are the parts that are new and the parts that can lose a document.
//
// Gmail, Gemini and Supabase are not stood up. What is exercised for real:
// the draft shape handed to the generator, the recipient resolution, the
// covering-note fallbacks, and the ordering in api.js that makes her "yes"
// reach the brain instead of Scout.

const path = require('path');
const fs = require('fs');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
process.env.DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const d = require(path.join(ROOT, 'helpers/proformaDraft.js'));

console.log('\n─ actually sending the proforma ─────────────────────────────');

// Contacts are stubbed so this does not depend on who happens to be in her
// real address book today — a test that passes only while Daekwang has an
// email address is a test that will fail for the wrong reason.
const ecPath = require.resolve(path.join(ROOT, 'helpers/emailContacts.js'));
const realEc = require.cache[ecPath];
function stubContacts(fn) {
    require.cache[ecPath] = {
        id: ecPath, filename: ecPath, loaded: true,
        exports: { resolveContact: fn, isValidEmail: (s) => /@/.test(s) },
    };
}
function restoreContacts() {
    if (realEc) require.cache[ecPath] = realEc; else delete require.cache[ecPath];
}
const known = (name, email) => (q) =>
    String(q).toLowerCase().includes(String(name).toLowerCase())
        ? { type: 'exact', contact: { name, email } } : null;

section('A — the shape handed to the generator');
{
    // generateProformaFromPending destructures { draft, invNo, containerNos,
    // replyTo, who } and reads draft.items[].desc / .qty / .rate. The flat
    // payload() shape uses `description`, not `desc`. Handing over the wrong
    // one produces a PDF with an empty description line and no complaint —
    // the same class of mistake as reading a library's typings instead of
    // running it.
    stubContacts(known('Daekwang', 'purchasing@daekwang.co.kr'));
    d.clear();
    const step = d.handle('create a proforma for Daekwang, 21 MT of copper at 8450 per MT');
    const bd = step.draft;

    ck('a draft is handed over at all', !!bd);
    ck('  with the consignee', bd.consignee === 'Daekwang');
    ck('  items keyed `desc`, not `description`',
       bd.items[0].desc === 'copper' && !('description' in bd.items[0]),
       JSON.stringify(bd.items[0]) + ' — the generator reads .desc and would print an empty line');
    ck('  with the quantity and rate as NUMBERS',
       bd.items[0].qty === 21 && bd.items[0].rate === 8450
       && typeof bd.items[0].rate === 'number',
       JSON.stringify(bd.items[0]));
    ck('  a container count, because the numbering mints one number each',
       bd.containerCount === 1,
       'a wrong count here puts container numbers on the document that do not exist');
    ck('  the terms', bd.trade_terms === 'CIF' && /TT/.test(bd.payment_term));
    ck('  and NO invented discharge port',
       bd.port_discharge === '',
       'an empty field is a gap she can see; a guessed port is a gap she cannot');

    // The keys generateProformaFromPending actually destructures, read from
    // the source rather than remembered.
    const acts = fs.readFileSync(path.join(ROOT, 'workflow/actions.js'), 'utf8');
    const m = /async function generateProformaFromPending[^\n]*\n\s*const \{([^}]+)\}\s*=\s*pending;/.exec(acts);
    ck('  and the pending keys still match the generator',
       !!m && ['draft', 'invNo', 'containerNos', 'replyTo', 'who']
           .every((k) => m[1].includes(k)),
       m ? m[1].trim() : 'could not find the destructure — has it been renamed?');
}

section('B — who it goes to, without her reading out an address');
{
    // Almost always the consignee, so it is not a seventh question. Reading
    // "purchasing at daekwang dot co dot kr" aloud is miserable and she
    // should never have to.
    stubContacts(known('Daekwang', 'purchasing@daekwang.co.kr'));
    d.clear();
    const s = d.handle('create a proforma for Daekwang, 21 MT of copper at 8450');
    ck('the consignee is the default recipient',
       s.ready && s.recipient.email === 'purchasing@daekwang.co.kr', JSON.stringify(s.recipient));
    ck('  and the preview asks a question it can act on',
       /send it to/i.test(s.say) && /say yes/i.test(s.say), s.say);
    ck('  and no longer promises "send it"',
       !/say "send it"/i.test(s.say),
       'that phrase was consumed by nothing for a week');

    // A DIFFERENT recipient from the consignee. Broker orders: the document
    // is made out to the buyer, the mail goes to the agent who placed it.
    stubContacts((q) => (/yurim/i.test(q)
        ? { type: 'exact', contact: { name: 'Yurim', email: 'yurim@example.com' } }
        : known('Daekwang', 'purchasing@daekwang.co.kr')(q)));
    d.clear();
    const s2 = d.handle('create a proforma for Daekwang, 21 MT of copper at 8450, email it to Yurim');
    ck('an explicit recipient overrides the consignee',
       s2.ready && s2.recipient.email === 'yurim@example.com', JSON.stringify(s2.recipient));
    ck('  while the document is still made out to the consignee',
       s2.draft.consignee === 'Daekwang',
       'got ' + s2.draft.consignee + ' — the buyer and the agent are not the same company');
}

section('C — it refuses rather than sending into the dark');
{
    // THE FAILURES THAT MATTER. Each of these must reach her as a question.
    // A preview that looks ready and a "yes" that lands nowhere is exactly
    // the bug being fixed.
    stubContacts(() => null);
    d.clear();
    const unknown = d.handle('create a proforma for Nobody Ltd, 21 MT of copper at 8450');
    ck('an unknown recipient is not ready to send', unknown.ready === false);
    ck('  and says so out loud',
       /email address/i.test(unknown.say) && /Nobody Ltd/.test(unknown.say), unknown.say);
    ck('  while still showing her the figures',
       /177,450/.test(unknown.say),
       'the work is done; only the address is missing, and she should see that');

    stubContacts(() => ({ type: 'ambiguous', matches: [{ name: 'Kim A' }, { name: 'Kim B' }] }));
    d.clear();
    const amb = d.handle('create a proforma for Kim, 21 MT of copper at 8450');
    ck('an ambiguous contact is not ready either', amb.ready === false && amb.blocked === 'ambiguous');
    ck('  and says how many it could have meant', /2 contacts/i.test(amb.say), amb.say);

    // The address book itself failing must not throw inside a voice request.
    require.cache[ecPath] = {
        id: ecPath, filename: ecPath, loaded: true,
        exports: { resolveContact: () => { throw new Error('EACCES'); } },
    };
    d.clear();
    let threw = null;
    let broke;
    try { broke = d.handle('create a proforma for Daekwang, 21 MT of copper at 8450'); }
    catch (e) { threw = e.message; }
    ck('a broken address book does not throw', threw === null, 'threw: ' + threw);
    ck('  it just is not ready', broke && broke.ready === false);
}

section('D — the covering note, and every way it falls back');
{
    // Apsara chose "write it in my voice". writingStyle.js has existed for
    // weeks and was already wired into draft_email and reply_email; the
    // proforma was the one compose path that bypassed it.
    //
    // The FALLBACK is what is really being tested. A covering note is a
    // nicety. A document that does not go out, or one quoting the wrong
    // invoice number, is not.
    const acts = require(path.join(ROOT, 'workflow/actions.js'));
    const tpl = acts.proformaTemplateNote('Daekwang', 'INV-1');
    const wsPath = require.resolve(path.join(ROOT, 'helpers/writingStyle.js'));
    const gemPath = require.resolve(path.join(ROOT, 'helpers/gemini.js'));
    const realWs = require.cache[wsPath], realGem = require.cache[gemPath];
    const stub = (guidance, geminiReply) => {
        require.cache[wsPath] = { id: wsPath, filename: wsPath, loaded: true,
            exports: { getStyleGuidance: () => guidance } };
        require.cache[gemPath] = { id: gemPath, filename: gemPath, loaded: true,
            exports: { callGeminiJSON: async () => {
                if (geminiReply instanceof Error) throw geminiReply;
                return geminiReply;
            } } };
    };

    return (async () => {
        // NO PROFILE LEARNED — which is the state today: data/writing_style.json
        // does not exist, so getStyleGuidance() returns ''. Asking a model to
        // write "in her voice" with no profile is generic business English
        // with more ways to go wrong.
        // The stub body CONTAINS "INV-1" deliberately. My first version did
        // not, so a mutation deleting the no-profile guard still produced the
        // template — caught downstream by the invoice-number check — and this
        // assertion passed against code that had lost the thing it names.
        // A guard shadowed by another guard is a guard nobody is maintaining.
        stub('', { body: 'INV-1 — should never be reached, no profile exists' });
        ck('no style learned → the template, unchanged',
           (await acts.proformaCoveringNote({ consignee: 'Daekwang' }, 'INV-1')) === tpl,
           'with no profile, asking a model to write "in her voice" is generic prose with more ways to go wrong');

        stub('SHE WRITES LIKE THIS', { body: 'Hi Daekwang,\n\nAttached is INV-1.\n\nThanks,\nApsara' });
        const good = await acts.proformaCoveringNote({ consignee: 'Daekwang' }, 'INV-1');
        ck('a good note is used', /Thanks,\nApsara/.test(good) && good !== tpl, good);
        ck('  and carries the invoice number', good.includes('INV-1'));

        // THE ONE THAT WOULD CAUSE A DISPUTE. A covering note naming a
        // different invoice number than the attachment is worse than a
        // plain one, and a model asked for prose will happily reformat an
        // identifier.
        stub('SHE WRITES LIKE THIS', { body: 'Hi,\n\nAttached is invoice INV-2.\n\nApsara' });
        ck('a note quoting the WRONG invoice number falls back',
           (await acts.proformaCoveringNote({ consignee: 'Daekwang' }, 'INV-1')) === tpl,
           'a covering note disagreeing with its own attachment is a dispute');

        // Every case below uses THE SAME consignee as `tpl`. I first wrote
        // these against { consignee: 'D' } and compared to a template built
        // for 'Daekwang', so all five failed against correct code — a test
        // that cries wolf gets switched off, and the real one goes with it.
        const note = async (reply) => {
            stub('SHE WRITES LIKE THIS', reply);
            return acts.proformaCoveringNote({ consignee: 'Daekwang' }, 'INV-1');
        };
        ck('  an essay falls back', (await note({ body: 'INV-1 ' + 'x'.repeat(1300) })) === tpl);
        ck('  an empty reply falls back', (await note({ body: '   ' })) === tpl);
        ck('  a null reply falls back', (await note(null)) === tpl);
        ck('  a non-string body falls back', (await note({ body: 12345 })) === tpl);
        ck('  a reply with no body at all falls back', (await note({ nope: 1 })) === tpl);
        ck('  and an unreachable model falls back rather than throwing',
           (await note(new Error('ECONNRESET'))) === tpl,
           'a covering note must never be able to stop the document going out');

        if (realWs) require.cache[wsPath] = realWs; else delete require.cache[wsPath];
        if (realGem) require.cache[gemPath] = realGem; else delete require.cache[gemPath];

        finish();
    })();
}

function finish() {

section('E — the handover is wired, and awaited');
{
    const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8')
        .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

    ck('the voice flow stages a confirm_proforma pending',
       /type: 'confirm_proforma'/.test(api),
       'without this her "yes" has nothing to resolve');
    ck('  using the SAME numbering helper as the email path',
       /await acts\.prepareProformaNumbers\(step\.draft\)/.test(api),
       'a voice proforma must not be a different document from an emailed one');
    ck('  and both async calls are awaited',
       /await acts\.setPending\(/.test(api) && /await acts\.prepareProformaNumbers\(/.test(api),
       'an unawaited setPending races her next utterance: she says yes, there is no pending yet');
    ck('  only when there is somewhere to send it',
       /step\.stage === 'preview' && step\.ready && step\.draft/.test(api),
       'staging a send with no recipient is the silent failure being fixed');
    // Sliced to the end of the ROUTE. My first version sliced to the end of
    // the FILE and failed against correct code, because api.js sends mail in
    // plenty of other routes. An over-broad haystack is the same defect as an
    // over-broad regex: it reports failures that are not failures.
    const vFrom = api.indexOf("app.post('/api/voice/ask'");
    const vTo = api.indexOf('\n    app.', vFrom + 10);
    const route = api.slice(vFrom, vTo === -1 ? api.length : vTo);
    ck('  and api.js does not send anything itself',
       !/sendEmail|generateProformaDc2Pdf|generateProformaFromPending/.test(route),
       'a second sender is a second set of rules to keep in step');

    // The address warning must survive the handover — a proforma going out
    // with no postal address on it is not something to find out later.
    ck('  an address-book warning is carried through',
       /nums\.addressWarning/.test(api));

    // ORDERING. Once the pending is staged, the NEXT utterance must reach the
    // brain, not Scout — "yes" has no freight vocabulary in it whatsoever.
    const from = api.indexOf("app.post('/api/voice/ask'");
    const seg = api.slice(from, api.indexOf('\n    app.', from + 10));
    const iPending = seg.indexOf('brainPending = require');
    const iPro = seg.indexOf('pro.handle(asked)');
    ck('  and an open pending outranks a new proforma draft',
       iPending !== -1 && iPro !== -1 && iPending < iPro,
       'otherwise her "yes" starts a second proforma instead of sending the first');
    ck('  which is what stops the draft being clobbered mid-confirm',
       /const step = answeringBrain \? null : pro\.handle\(asked\)/.test(seg));
}

section('F — and the send itself is still the brain\'s, gated on yes');
{
    const acts = fs.readFileSync(path.join(ROOT, 'workflow/actions.js'), 'utf8');
    // resolvePending is what turns "yes" into a send. If the voice path ever
    // stopped going through it, the confirmation would be decorative.
    ck('confirm_proforma is resolved by the existing pending handler',
       /confirm_proforma/.test(acts) && /return generateProformaFromPending\(chatId, pending\)/.test(acts));
    ck('  and the generator still emails through helpers/gmail',
       /require\('\.\.\/helpers\/gmail'\)\.sendEmail/.test(acts));
    ck('  with the covering note, not the old inline template',
       /body: await proformaCoveringNote\(draft, payload\.inv_no\)/.test(acts),
       'the hardcoded "Dear X ... Best regards" body was the one compose path bypassing writingStyle.js');
    // The send is deliberately LAST in the generator: if it fails, the
    // document still exists and is archived.
    const gen = acts.slice(acts.indexOf('async function generateProformaFromPending'));
    ck('  and emailing is still the last step',
       gen.indexOf('saveProformaCopy') < gen.indexOf('sendEmail'),
       'if the send fails the document must still exist — "attach it yourself", not "start again"');
}

restoreContacts();
console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

}
