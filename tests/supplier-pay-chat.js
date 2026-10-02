// ── tests/supplier-pay-chat.js ────────────────────────────────────────────
// Apsara, 2026-10-02, over WhatsApp:
//
//   "Also i want Jarvis to handle this.If user messages (only allowed users)
//    jarvis and they say,I paid 10000 advance to Inesh.It should able to
//    undertsand that.If they didnt mention specifically-as advance.Just ask
//    the user directly whether it is a advance or paid against bill?If
//    advance,create an entry in bill pay against that supplier.Else Just show
//    all the unpaid upto 5 containers with bill date and ask him to choose
//    all those applicable.Post getting user input,Jarvis should create an
//    entry in Bill Pay.Also jarvis profile should have the access to
//    delete/undo the Bill pay as well."
//
// ── THIS FILE DRIVES THE REAL BRAIN ───────────────────────────────────────
// helpers/supplierPayTalk.js already has its own unit tests, and they were
// all green while NOTHING WAS WIRED — no intent, no action, no pending. A
// parser nothing calls is a parser nobody can use, which is the exact shape
// of the break check-action-wiring.js was written for.
//
// So this goes through policyDecide() and the action layer, with the real
// bills and billPayments stores on a temp DATA_DIR. The property is not "the
// parser reads 10000" — it is "after this conversation, the money is in the
// ledger".
//
// ── WHY THE PICKFROM CONTRACT IS CHECKED EXPLICITLY ───────────────────────
// talk.pickFrom returns { chosen: [...] }, not an array. The first version of
// the action did `if (!picked.length)` on the wrapper — always undefined — so
// every correct answer she gave would have been met with "I didn't catch
// which one", forever, and no unit test would have noticed because the parser
// itself was right. Section D pins the contract so a future change to either
// side has to update both.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-paychat-'));
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const bills = require(path.join(ROOT, 'helpers/bills'));
const bp = require(path.join(ROOT, 'helpers/billPayments'));
const actions = require(path.join(ROOT, 'workflow/actions'));
const brain = require(path.join(ROOT, 'workflow/brain'));

// Everything Jarvis says, captured instead of sent.
const SAID = [];
const lastSaid = () => SAID[SAID.length - 1] || '';
// actions.init() is the real wiring — index.js calls it at boot and nothing
// else does, so a harness that skips index.js gets a module whose _send is
// undefined and every action dies with "_send is not a function". That exact
// TypeError once reached Apsara in a live thread; actions.ready() exists
// because of it.
actions.init({
    sendMessage: async (_chatId, m) => { SAID.push(String(m)); },
    sendToManager: async (m) => { SAID.push(String(m)); },
    sendToTeam: async (m) => { SAID.push(String(m)); },
    pushAlert: () => {},
});

const CHAT = 'test-chat@c.us';

// policyDecide reads ctx.textLower (fuzzyCorrectKeywords splits it first, so
// omitting it throws rather than returning nothing) and is SYNCHRONOUS. Same
// ctx shape as tests/claims-agent.js and tests/explain-thread.js.
const mk = (t, extra = {}) => ({
    text: t, textLower: String(t).toLowerCase(),
    chatId: CHAT, isManagerOrTeam: true, role: 'manager', senderName: 'Apsara',
    isTrucker: false, isSupplier: false, pendingAction: null,
    session: {}, activeBooking: null, ...extra,
});

(async () => {

// ── SETUP — three unpaid containers for one supplier ──────────────────────
let seeded = false;
try {
    await bills.addBill({ supplier: 'Inesh Cores Chapin', container_no: 'KOCU4401728',
        // supplier_invoice_amount, NOT supplier_amount: bills.WRITABLE does
        // not include the latter, so it was dropped on the way in and every
        // balance came back null. unpaidFor then correctly found nothing, and
        // the flow correctly offered an advance instead — a green parser and
        // a wrong fixture looking exactly like a broken feature.
        date: '2026-09-01', booking_no: 'BK1', supplier_invoice_amount: 5000 });
    await bills.addBill({ supplier: 'Inesh Cores Chapin', container_no: 'HMMU6872607',
        date: '2026-09-05', booking_no: 'BK2', supplier_invoice_amount: 3000 });
    await bills.addBill({ supplier: 'Mazariegos', container_no: 'EMHU278671',
        date: '2026-09-08', booking_no: 'BK3', supplier_invoice_amount: 2000 });
    seeded = true;
} catch (e) { console.log('  (seed failed: ' + e.message + ')'); }

// ── A — HER SENTENCE IS UNDERSTOOD ────────────────────────────────────────
{
    section('A — "I paid 10000 advance to Inesh" reaches the right intent');

    const d = brain.policyDecide(mk('I paid 10000 advance to Inesh'));
    ck('it resolves to pay_supplier', d && d.intent === 'pay_supplier',
       JSON.stringify(d && { intent: d.intent, by: d.resolvedBy }));
    ck('  by policy, not the model', d && d.resolvedBy === 'policy',
       'a model deciding whether a sentence is a payment is a model that can file money '
       + 'against the wrong supplier');
    ck('  carrying the amount', d && d.data && d.data.parsed && d.data.parsed.amount === 10000,
       JSON.stringify(d && d.data && d.data.parsed));
    ck('  and the name she typed', d && d.data && d.data.parsed && /Inesh/i.test(d.data.parsed.supplier));

    // ── NOT A QUESTION ───────────────────────────────────────────────────
    // "how much did I pay Inesh?" is a REPORT. Answering it by recording a
    // payment is the worst available misread of that sentence.
    const q = brain.policyDecide(mk('how much did I pay Inesh?'));
    ck('a question about payments is NOT a payment',
       !q || q.intent !== 'pay_supplier', q && q.intent);

    // ── AND NOT FROM A STRANGER ──────────────────────────────────────────
    // "only allowed users", her words. A supplier in a group chat saying
    // "I paid 10000" must not move her ledger.
    const stranger = brain.policyDecide(mk('I paid 10000 advance to Inesh',
        { isManagerOrTeam: false, role: 'supplier', isSupplier: true }));
    ck('a supplier saying it does not reach the intent',
       !stranger || stranger.intent !== 'pay_supplier', stranger && stranger.intent);
}

// ── B — THE ADVANCE, END TO END ───────────────────────────────────────────
// Her first case: she SAID advance, so it is never guessed. Confirm, then the
// money is in the ledger.
{
    section('B — she said advance, so it is recorded as one');

    if (!seeded) { ck('bills seeded', false, 'cannot run the flow without bills'); }
    else {
        const before = bp.list().length;
        SAID.length = 0;

        await actions.paySupplier(CHAT, { amount: 10000, supplier: 'Inesh',
            saidAdvance: true, saidAgainstBill: false }, 'Apsara');

        ck('it asks her to confirm first', /advance/i.test(lastSaid()), lastSaid());
        // ── AND IT ASKS HOW THE MONEY WENT ───────────────────────────────
        // billPayments refuses a mode outside Zelle / Wire / Cash, so a flow
        // that never asks is a flow that always fails. Not defaulted: she
        // pays by Zelle AND Wire, and the method is what she reconciles the
        // bank against.
        ck('  and asks how she sent it', /zelle/i.test(lastSaid()) && /wire/i.test(lastSaid()),
           lastSaid());
        ck('  and NOTHING is recorded yet', bp.list().length === before,
           'a payment written before she says yes is a payment she never authorised');

        // The yes, through the real pending route.
        const pend = actions.getPending ? actions.getPending(CHAT) : null;
        ck('a confirm pending is waiting', !!pend && pend.type === 'await_pay_confirm',
           JSON.stringify(pend && pend.type));

        const d = brain.policyDecide(mk('Zelle', { pendingAction: pend }));
        ck('  naming the mode resolves to the answer intent',
           d && d.intent === 'pay_supplier_answer', JSON.stringify(d && d.intent));

        // Naming the mode IS the confirmation.
        await actions.paySupplierAnswer(CHAT, pend, 'Zelle', 'Apsara', { isManager: true });

        // ── AND THEN THE BANK ────────────────────────────────────────────
        // Zelle and Wire require one (Cash must NOT carry one). Third
        // required field on the writer, and like the first two it was found
        // by running the conversation rather than by reading the writer.
        ck('  it then asks which account', /bofa|chase/i.test(lastSaid()), lastSaid());
        const pend2 = actions.getPending ? actions.getPending(CHAT) : null;
        ck('  with an await_pay_bank pending', !!pend2 && pend2.type === 'await_pay_bank',
           pend2 && pend2.type);
        ck('  and STILL nothing recorded', bp.list().length === before, `${before} -> ${bp.list().length}`);
        await actions.paySupplierAnswer(CHAT, pend2, 'BofA', 'Apsara', { isManager: true });

        const after = bp.list();
        ck('the advance is now in Bill Pay', after.length === before + 1,
           `${before} -> ${after.length}`);
        const rec = after[after.length - 1];
        ck('  for the right supplier', rec && /Inesh/i.test(rec.supplier || ''), rec && rec.supplier);
              ck('  for the right amount', rec && Number(rec.amount) === 10000, rec && rec.amount);
        ck('  and carries the mode she named', rec && rec.mode === 'Zelle', rec && rec.mode);
        ck('  and the account it left', rec && /bofa/i.test(rec.bank || ''), rec && rec.bank);
        ck('  and it says so, with the undo offered', /recorded/i.test(lastSaid())
            && /undo/i.test(lastSaid()), lastSaid());
    }
}

// ── C — SHE DID NOT SAY WHICH, SO IT ASKS ─────────────────────────────────
// Verbatim: "If they didnt mention specifically-as advance.Just ask the user
// directly whether it is a advance or paid against bill?"
{
    section('C — unstated kind is asked, never guessed');

    const before = bp.list().length;
    SAID.length = 0;
    await actions.paySupplier(CHAT, { amount: 5000, supplier: 'Inesh',
        saidAdvance: false, saidAgainstBill: false }, 'Apsara');

    ck('it asks advance-or-bill', /advance/i.test(lastSaid()) && /bill/i.test(lastSaid()), lastSaid());
    ck('  and records nothing on a guess', bp.list().length === before,
       'guessed as an advance, the money sits as credit while the container still reads unpaid; '
       + 'guessed the other way, containers are marked settled out of money meant to be held');

    const pend = actions.getPending ? actions.getPending(CHAT) : null;
    ck('  with an await_pay_kind pending', !!pend && pend.type === 'await_pay_kind', pend && pend.type);
}

// ── D — "AGAINST A BILL" SHOWS THE CONTAINERS, AS SHE ASKED ───────────────
// Section C deliberately leaves a pending open, and setPending QUEUES behind
// an unresolved one rather than overwriting it (that queueing is itself a
// fix, from the day Apsara got the same question several times over). So the
// chat is cleared here, or D answers C's question.
// "Just show all the unpaid upto 5 containers with bill date and ask him to
// choose all those applicable."
{
    section('D — the container list, and the pickFrom contract');

    if (seeded) {
        if (actions.clearPending) await actions.clearPending(CHAT);
        SAID.length = 0;
        await actions.paySupplierBills(CHAT, { amount: 6000, supplier: 'Inesh Cores Chapin' });
        const msg = lastSaid();

        ck('it lists the unpaid containers', /KOCU4401728/.test(msg), msg);
        ck('  with the bill date beside each', /2026-09-01/.test(msg), msg);
        ck('  and tells her how to choose', /1,3|all/i.test(msg), msg);

        const pend = actions.getPending ? actions.getPending(CHAT) : null;
        ck('an await_pay_containers pending is waiting',
           !!pend && pend.type === 'await_pay_containers', pend && pend.type);

        // ── THE CONTRACT THAT WAS WRONG ──────────────────────────────────
        // pickFrom returns { chosen: [...] }. The action read .length off the
        // wrapper, so a correct "1" was treated as unparseable. Pinned here
        // against BOTH sides so neither can drift alone.
        const talk = require(path.join(ROOT, 'helpers/supplierPayTalk'));
        const picked = talk.pickFrom('1', (pend && pend.offered) || []);
        ck('pickFrom returns { chosen: [...] }, not an array',
           picked && Array.isArray(picked.chosen) && !Array.isArray(picked),
           JSON.stringify(picked));

        if (pend) {
            SAID.length = 0;
            await actions.paySupplierAnswer(CHAT, pend, '1', 'Apsara', { isManager: true });
            ck('  and answering "1" is UNDERSTOOD, not re-asked',
               !/didn.t catch/i.test(lastSaid()), lastSaid());
            ck('  it shows the split before writing', /KOCU4401728/.test(lastSaid()), lastSaid());
        ck('  and still asks how the money went', /zelle/i.test(lastSaid()), lastSaid());
        }
    }
}

// ── E — UNDO IS MANAGER-ONLY ──────────────────────────────────────────────
// "Also jarvis profile should have the access to delete/undo the Bill pay as
// well." On the website that sits behind the Jarvis profile; the manager is
// this channel's equivalent. A team member may RECORD a payment here but not
// remove one — deleting reopens containers and moves a balance.
{
    section('E — undo, and who may do it');

    const d = brain.policyDecide(mk('undo last payment'));
    ck('"undo last payment" reaches the intent', d && d.intent === 'undo_bill_payment',
       JSON.stringify(d && d.intent));

    SAID.length = 0;
    const before = bp.list().length;
    await actions.undoBillPayment(CHAT, { isManager: false });
    ck('a non-manager is refused', /manager-only/i.test(lastSaid()), lastSaid());
    ck('  and nothing is removed', bp.list().length === before, `${before} -> ${bp.list().length}`);

    if (before > 0) {
        SAID.length = 0;
        await actions.undoBillPayment(CHAT, { isManager: true });
        ck('the manager is shown what would go', /remove this payment/i.test(lastSaid()), lastSaid());
        ck('  and it is still not removed yet', bp.list().length === before,
           'a destructive action on an unconfirmed message is a payment deleted by accident');

        const pend = actions.getPending ? actions.getPending(CHAT) : null;
        if (pend && pend.type === 'await_undo_pay_confirm') {
            // The pending is a stored object; the message answering it may
            // come from someone else in a group chat. Re-checked at the
            // answer, not only at the question.
            SAID.length = 0;
            await actions.paySupplierAnswer(CHAT, pend, 'yes', 'Someone', { isManager: false });
            ck('a non-manager answering the confirm is still refused',
               /manager-only/i.test(lastSaid()) && bp.list().length === before, lastSaid());
        }
    }
}

// ── F — A NAME JARVIS DOES NOT KNOW IS NEVER INVENTED ─────────────────────
// A misheard name is money filed against the wrong person, found weeks later
// when his account does not tie.
{
    section('F — an unknown supplier stops, it does not guess');

    SAID.length = 0;
    const before = bp.list().length;
    await actions.paySupplier(CHAT, { amount: 1000, supplier: 'Zzzqqq Nobody',
        saidAdvance: true }, 'Apsara');
    ck('it says it has no such supplier', /don.t have a supplier|which one/i.test(lastSaid()), lastSaid());
    ck('  and records nothing', bp.list().length === before);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})();
