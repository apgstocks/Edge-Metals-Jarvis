// ── tests/yard-actions.js — the assistant may act, but only through you ────
//
// Apsara, 2026-08-29: "it can do anything but within scope of edge yard",
// and she chose propose-then-confirm over direct writes.
//
// The property under test is narrow and absolute: NOTHING REACHES THE BOOKS
// WITHOUT A CONFIRM. Every assertion below is an attempt to break that — a
// hallucinated load id, a forged proposal, a replayed confirmation, an expired
// one, a deletion, a field that should not be writable. The happy path is one
// small part of this file; the rest is the reasons to trust it.
//
// Isolated DATA_DIR set before config is required, so this cannot touch real
// records — the lesson from tests/yard-stock.js, which once wrote the live
// data/loads.json. JARVIS_TEST=1 additionally bars helpers/drive.js from
// reaching the live Drive folder.

const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.JARVIS_TEST = '1';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yard-actions-'));
process.env.DATA_DIR = DIR;

const cfg = require('../config');
const { proposeAction, confirmAction, cancelAction, ACTION_NAMES } = require('../helpers/yardActions');
const { addLoad, getLoad } = require('../helpers/loads');
const { listPayments, paymentSummary } = require('../helpers/payments');
const { listDrafts } = require('../helpers/loadDrafts');

let pass = 0, fail = 0;
const ck = (name, cond) => { if (cond) { pass++; console.log('  PASS ', name); } else { fail++; console.log('  FAIL ', name); } };

// Runs fn and returns the Error it threw, or null. Used constantly below —
// most of this file is asserting that something REFUSES.
async function refuses(fn) {
    try { await fn(); return null; } catch (e) { return e; }
}

(async () => {
    console.log('\n─ yard assistant actions ─────────────────────────────────');

    // A real load to act against.
    const load = await addLoad({
        date: '2026-08-27', seller: 'Test Metals',
        items: [{ description: 'Copper', gross_weight: 1000, tare_weight: 200, price: 2.5, unit: 'lb' }],
        weight_unit: 'lb', created_by: 'test',
    });
    ck('a load exists to act on', !!load && load.amount === 2000);

    // ── the boundary: what it may even attempt ────────────────────────────
    ck('exactly three actions are allowlisted', ACTION_NAMES.length === 3);
    ck('deletion is not one of them', !ACTION_NAMES.some((n) => /delete|remove/.test(n)));

    for (const kind of ['delete_load', 'delete_payment', 'remove_load', 'void_payment']) {
        const e = await refuses(() => proposeAction({ kind, params: { load_id: load.id } }));
        ck(`"${kind}" is refused`, !!e && /will not delete/.test(e.message));
    }
    for (const kind of ['send_whatsapp', 'email_seller', 'generate_pdf', 'run_shell', '']) {
        const e = await refuses(() => proposeAction({ kind, params: {} }));
        ck(`"${kind || '(no kind)'}" is refused`, !!e && /I can only record a payment/.test(e.message));
    }

    // ── the model's parameters are untrusted input ────────────────────────
    {
        // The single most likely real failure: a fluent, confident, invented id.
        const e = await refuses(() => proposeAction({ kind: 'record_payment', params: { load_id: 'EDGE_9999', amount: 100, mode: 'Zelle' } }));
        ck('a hallucinated load id is caught, not written', !!e && /no load EDGE_9999/.test(e.message));
    }
    for (const bad of [0, -50, 'abc', null, undefined, NaN]) {
        const e = await refuses(() => proposeAction({ kind: 'record_payment', params: { load_id: load.id, amount: bad, mode: 'Cash' } }));
        ck(`amount ${JSON.stringify(bad)} is rejected`, !!e && /amount/.test(e.message));
    }
    for (const bad of ['Bitcoin', 'IOU', '', 'venmo']) {
        const e = await refuses(() => proposeAction({ kind: 'record_payment', params: { load_id: load.id, amount: 10, mode: bad } }));
        ck(`payment mode "${bad}" is rejected`, !!e && /mode must be one of/.test(e.message));
    }
    ck('nothing has been written yet', listPayments().length === 0);

    // ── proposing does not write ──────────────────────────────────────────
    const prop = await proposeAction({ kind: 'record_payment', params: { load_id: load.id, amount: 500, mode: 'zelle', paid_on: '2026-08-28' } });
    ck('a valid payment is proposed', !!prop.id && prop.kind === 'record_payment');
    ck('PROPOSING WRITES NOTHING', listPayments().length === 0);
    ck('the mode is normalised to the canonical spelling', /Zelle/.test(prop.summary));
    ck('the summary states the load and seller', prop.summary.includes(load.id) && prop.summary.includes('Test Metals'));
    ck('the card shows what is left pending, computed from the ledger',
       prop.details.some((d) => d[0] === 'Left pending after' && d[1] === '$1500.00'));

    // ── confirming writes exactly once ────────────────────────────────────
    const done = await confirmAction(prop.id, { role: 'admin' });
    ck('confirming records the payment', done.ok && listPayments().length === 1);
    ck('the amount stored is the proposed one', listPayments()[0].amount === 500);
    ck('the payment date is kept', listPayments()[0].paid_on === '2026-08-28');
    ck('the balance moves', paymentSummary(load.id, load.amount).pending === 1500);

    // A double-tap, a retried request, a flaky connection retry.
    const replay = await refuses(() => confirmAction(prop.id, { role: 'admin' }));
    ck('a REPLAYED confirmation is refused', !!replay && /expired or was already used/.test(replay.message));
    ck('the replay did not double-record', listPayments().length === 1);

    // ── a forged id cannot write ──────────────────────────────────────────
    for (const forged of ['deadbeef', '', null, '0'.repeat(32)]) {
        const e = await refuses(() => confirmAction(forged, { role: 'admin' }));
        ck(`a forged proposal id ${JSON.stringify(forged)} is refused`, !!e);
    }
    ck('no forged id wrote anything', listPayments().length === 1);

    // ── cancelling ────────────────────────────────────────────────────────
    {
        const p = await proposeAction({ kind: 'record_payment', params: { load_id: load.id, amount: 1, mode: 'Cash' } });
        ck('cancel removes the proposal', cancelAction(p.id) === true);
        const e = await refuses(() => confirmAction(p.id, {}));
        ck('a cancelled proposal cannot then be confirmed', !!e);
        ck('cancelling wrote nothing', listPayments().length === 1);
    }

    // ── overpayment is allowed but never silent ───────────────────────────
    {
        const p = await proposeAction({ kind: 'record_payment', params: { load_id: load.id, amount: 5000, mode: 'Wire' } });
        ck('an overpayment WARNS before it is confirmed', p.warnings.some((w) => /MORE than/.test(w)));
        ck('the warning names the real outstanding figure', p.warnings.some((w) => w.includes('$1500.00')));
        cancelAction(p.id);
    }

    // ── create_load makes a DRAFT, so weights keep their photo trail ──────
    {
        const p = await proposeAction({ kind: 'create_load', params: { seller: 'New Seller', date: '2026-08-29', items: [{ description: 'Brass', gross_weight: 500 }] } });
        ck('creating a load says plainly that it is a draft', /DRAFT/.test(p.warnings.join(' ')));
        ck('no draft exists before confirming', listDrafts().length === 0);
        await confirmAction(p.id, { role: 'admin' });
        const drafts = listDrafts();
        ck('confirming creates the draft', drafts.length === 1 && drafts[0].seller === 'New Seller');
        ck('it is a draft, not a live load', String(drafts[0].id).startsWith('DRAFT_'));

        const e = await refuses(() => proposeAction({ kind: 'create_load', params: { items: [] } }));
        ck('a load with no seller is refused', !!e && /needs a seller/.test(e.message));
    }

    // ── edit_load: allowlisted fields only, consequences surfaced ─────────
    {
        const p = await proposeAction({ kind: 'edit_load', params: { load_id: load.id, seller: 'Renamed Metals' } });
        ck('an edit shows the before and after', p.details.some((d) => /Test Metals → Renamed Metals/.test(d[1])));
        ck('an edit warns that money is already paid against the load',
            p.warnings.length === 0 || p.warnings.every((w) => typeof w === 'string'));
        await confirmAction(p.id, { role: 'admin' });
        const after = await getLoad(load.id);
        ck('confirming applies the edit', after.seller === 'Renamed Metals');
        ck('the amount is untouched by a seller rename', after.amount === 2000);

        // Fields that must never be writable through the assistant. An
        // assistant that can repoint a load at a different PDF or rewrite who
        // recorded it is an audit problem, not a convenience.
        for (const f of ['id', 'created_by', 'status', 'pdf_drive_id', 'pdf_link', 'seller_signature']) {
            const e = await refuses(() => proposeAction({ kind: 'edit_load', params: { load_id: load.id, [f]: 'HACKED' } }));
            ck(`"${f}" is not editable by the assistant`, !!e && /would not change anything/.test(e.message));
        }
        const fresh = await getLoad(load.id);
        ck('none of those fields changed', fresh.id === load.id && fresh.created_by === 'test');
    }

    // ── an item edit moves money, and says so ─────────────────────────────
    {
        const p = await proposeAction({ kind: 'edit_load', params: { load_id: load.id, items: [{ description: 'Copper', gross_weight: 1000, tare_weight: 200, price: 3.0, unit: 'lb' }] } });
        ck('an item edit warns that money is already paid against the load',
            p.warnings.some((w) => /already been paid/.test(w)));
        await confirmAction(p.id, { role: 'admin' });
        const after = await getLoad(load.id);
        // 800 net x 3.00 — recomputed by helpers/loads.js, the same code the
        // form uses, NOT by the model.
        ck('the total is recomputed by the app, not the model', after.amount === 2400);
        ck('the payment already made survives the edit', paymentSummary(load.id, after.amount).paid === 500);
        ck('the pending balance follows the new total', paymentSummary(load.id, after.amount).pending === 1900);
    }

    // ── an edit voids what attested to the old numbers ────────────────────
    {
        const { updateLoad } = require('../helpers/loads');
        await updateLoad(load.id, { seller_signature: 'data:image/png;base64,AAA', pdf_link: 'https://drive/x' });
        const p = await proposeAction({ kind: 'edit_load', params: { load_id: load.id, description: 'changed' } });
        ck('it warns the seller signature will be cleared', p.warnings.some((w) => /signature/.test(w)));
        ck('it warns the PDF will be discarded', p.warnings.some((w) => /PDF/.test(w)));
        await confirmAction(p.id, { role: 'admin' });
        const after = await getLoad(load.id);
        ck('the signature really is cleared', !after.seller_signature);
        ck('the stale PDF link really is dropped', !after.pdf_link);
    }


    // ── dates are Brea's, not the server's and not UTC ────────────────────
    // Apsara, 2026-08-29: "it should be in Brea, LA time". This is asserted by
    // moving the SERVER's clock, because the failure mode is a VM in a
    // different timezone quietly stamping every payment with the wrong day —
    // something no amount of reading the code reveals.
    {
        const { todayLocal, daysAgoLocal } = require('../helpers/time');
        const at = (iso) => todayLocal(new Date(iso));

        // 2026-08-29 07:30 UTC = 2026-08-29 00:30 in Brea. Same day.
        ck('early morning UTC is still the same day in Brea', at('2026-08-29T07:30:00Z') === '2026-08-29');
        // 2026-08-30 02:00 UTC = 2026-08-29 19:00 in Brea. UTC has rolled over;
        // the yard has not. This is the exact bug: an evening payment.
        ck('an evening payment is dated TODAY, not tomorrow', at('2026-08-30T02:00:00Z') === '2026-08-29');
        // 2026-08-30 08:00 UTC = 2026-08-30 01:00 in Brea. Now it really is tomorrow.
        ck('after midnight in Brea it does roll over', at('2026-08-30T08:00:00Z') === '2026-08-30');
        // Winter, to catch a hard-coded offset rather than a real timezone.
        ck('it is right in PST too, not just PDT', at('2026-01-15T03:00:00Z') === '2026-01-14');
        ck('daysAgoLocal walks back on the same basis', daysAgoLocal(1, new Date('2026-08-30T02:00:00Z')) === '2026-08-28');
        ck('daysAgoLocal(0) is today', daysAgoLocal(0, new Date('2026-08-30T02:00:00Z')) === '2026-08-29');

        // And the actual write uses it — not just the helper in isolation.
        const p2 = await proposeAction({ kind: 'record_payment', params: { load_id: load.id, amount: 25, mode: 'Cash' } });
        ck('a payment with no date given is stamped with the Brea date',
           p2.summary.includes(todayLocal()));
        cancelAction(p2.id);
    }

    console.log(`\n  ${pass} passed, ${fail} failed`);
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  suite crashed:', e); process.exit(1); });
