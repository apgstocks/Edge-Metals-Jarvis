// ── helpers/pettyCash.js — the cash box, as a ledger ───────────────────────
//
// Per Apsara 2026-09-02: "I want to introduce a new tab called Petty cash.
// Date and cash amount needs to be entered here. So it is like cash reserve.
// If i click pay in load and select cash, the invoice amount should be
// adjusted against this. If cash is low while invoice amount is high --> Make
// it as partial payment and notify user."
//
// A LEDGER, NOT A BALANCE FIELD
// -----------------------------
// Every top-up and every cash payment is its own row; the balance is their
// sum. A stored `balance` number would be one crashed write away from being
// wrong with no way to reconstruct what it should have been — and cash is
// precisely the payment mode with no bank statement behind it, so this file is
// the only record there is. Summing rows also means "why is it $340?" always
// has an answer you can point at.
//
// STARTS AT ZERO, on purpose
// --------------------------
// Cash payments recorded before this file existed are NOT deducted — her
// choice, and the right one: that cash came out of a box nobody was tracking
// here, so charging it against a reserve that starts empty would open the
// ledger deeply negative and mean nothing.
//
// EVERY WRITE GOES THROUGH mutateJson
// -----------------------------------
// which takes a lock on the file. That matters more here than anywhere else in
// this codebase: the balance is read, checked and written in one place, so two
// payments raced against $500 cannot both see $500 and both succeed. Any
// version of this that reads the balance, decides, and then writes in a
// separate step can overdraw, and would do it silently.

const cfg = require('../config');
const { loadJson, mutateJson: mutateJsonRaw } = require('./json');

// ── EVERY write here is strict ────────────────────────────────────────────
// helpers/json.js's mutateJson defaults to strict:false, which LOGS a failure
// and returns the file's previous contents. For most stores that is the right
// call — a missed write self-heals on the next change. For a cash ledger it is
// not: the caller would be told the money moved when it did not, and there is
// no bank statement to catch it later.
//
// It matters twice over here, because the overdraft and "only top-ups can be
// deleted" rules are enforced by THROWING from inside the mutator. Without
// strict those throws are swallowed, the write is skipped, and the function
// returns as though nothing was wrong — a refusal that looks like a success.
//
// Wrapped once rather than passing the option at four call sites, so a fifth
// cannot be added without it.
const mutateJson = (file, dflt, fn) => mutateJsonRaw(file, dflt, fn, { strict: true });

// Cash is counted to the cent, same tolerance as helpers/payments.js. Kept
// local rather than imported so a change there cannot silently loosen this.
const CENT = 0.005;

const round2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);
const toNum = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : null;
};

// What a row can be. Stored on every entry so the tab can label it and so a
// future kind cannot be mistaken for one of these.
//   topup    — cash put INTO the box. Positive.
//   payment  — cash taken OUT to pay a load. Negative. Carries payment_id.
//   expense  — cash taken OUT for an expense. Negative. Carries expense_id.
//              Unlike a payment this is allowed to overdraw — see
//              withdrawForExpense for why the two differ.
//   reversal — money put BACK when a payment or expense is undone. Positive,
//              carries reverses_entry_id (and the payment/expense id).
// 'receipt' added 2026-09-16: cash taken IN for a yard sale. Distinct from
// 'topup' (her own float) because the Petty cash tab and the spend report
// split on kind, and a day's takings filed as a top-up would read as money
// she put in rather than money the yard earned.
// 'transfer' added 2026-09-21: cash moved BETWEEN buckets — a borrow, its
// repayment, or unbanked cash being assigned to a bank. Always written as a
// PAIR of rows sharing a transfer_id, one negative and one positive, so the
// overall total is untouched and only the split moves.
const ENTRY_KINDS = ['topup', 'payment', 'receipt', 'expense', 'reversal', 'transfer'];

function newEntryId() {
    return `PC_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function listEntries() {
    const raw = loadJson(cfg.PETTY_CASH_FILE, []);
    return Array.isArray(raw) ? raw : [];
}

// ── WHERE THE CASH IN THE BOX CAME FROM ───────────────────────────────────
//
// Apsara, 2026-09-21: "when adding cash ,ask its from BofA or chase bank..
// show overall cash .but also keep track of bofacash available and chase
// bank."
//
// THIS IS NOT helpers/banks.js's `bank`, AND THE DIFFERENCE IS LOAD-BEARING.
// That field says which account the money left AT THE MOMENT OF PAYMENT, and
// banks.js REFUSES it on a cash payment for a stated reason: "storing it would
// put 'paid cash from Chase' on the ledger — a sentence that is not true."
// That is still true. This field says something else: which pot of
// ALREADY-WITHDRAWN cash a note came out of. The money left Chase days ago at
// the counter; this records which trip to the bank it came from. Two facts,
// two fields — reuse `bank` for this and Zelle and Wire validation breaks.
//
// ── "Unassigned", NOT "Others" ────────────────────────────────────────────
// She first said Others. helpers/banks.js already exports OTHER = 'Others',
// meaning "a bank that is not BofA or Chase — type its name", on the same pay
// forms. Two different meanings for one word on adjacent screens is a trap
// that springs the day a third real bank is added, so she chose Unassigned.
//
// It holds two kinds of money, both genuinely unbanked: whatever was in the
// box before this existed, and cash taken in from a customer on a sale, which
// never came out of a bank at all. It can be spent like the others and moved
// into a bank later, when she actually banks it — see transfer().
// ── BofA IS TWO ACCOUNTS, AND THEY BELONG TO TWO COMPANIES ────────────────
//
// Apsara, 2026-09-21: "In petty cash ,add bofa/AAA investments" — then, asked
// what exactly: "Under BofA. 1.Edge Metals 2.AAA Investment", and asked
// whether AAA Investment is a separate company the way Edge Yard and Edge
// Metals are: "Yes — a third company".
//
// So this is not another bank. It is a second COMPANY's money sitting in the
// same cash box, and CLAUDE.md rule 5 is about exactly that: a rule for one
// company is not a rule for the other, and the separation is most of what
// this app is for.
//
// ── THE NAMES ARE 'Edge Metals' AND 'AAA Investment' ──────────────────────
// They were 'BofA/Edge Metals' and 'BofA/AAA Investment' for about an hour.
// She rejected that: "No no no" to the list of forms it accepted, and then,
// asked which part was wrong, chose "The names themselves are wrong".
//
// Rightly. Read her sentence again — "UNDER BofA. 1.Edge Metals 2.AAA
// Investment" — that is a bank with two accounts under it, a hierarchy. I
// flattened it into one string with a slash in the middle, which forced a
// whole apparatus of tolerant matching to un-flatten it again: a bare "AAA
// Investment" had to be guessed back into 'BofA/AAA Investment', and the
// guess needed an ambiguity rule to stop it picking the wrong one. All of
// that existed to undo a mistake in the name. Gone: the ACCOUNT is the name,
// the BANK is a separate fact about it, and nothing has to be inferred.
//
// ── AND 'BofA' IS GONE, BECAUSE SHE CHANGED HER MIND ──────────────────────
// It was here for a day. Asked what the existing rows meant, she first chose
// "Keep 'BofA' as-is, reassign as you go", so the old rows kept the name and
// the screens called that bucket "not yet split".
//
// Apsara, 2026-09-22: "By default BofA is edge metals" / "for previous cash",
// and then, of three things that could mean, she picked the migration —
// rewrite the previous cash to the Edge Metals account. That is a claim that
// none of the old BofA money was AAA Investment's, which is hers alone to
// make, and she made it. scripts/migrate-bofa-to-edge-metals.js does it,
// with a backup and a dry run.
//
// So there is no 'BofA' account left to offer. MY CALL, not hers: dropping
// it from this list rather than leaving an empty one behind, because three
// accounts at BofA where two are companies and one is "the leftovers" is the
// screen she called ugly. Nothing can be lost by it — sourceOf keeps an
// unrecognised name AS TYPED and balanceBySource counts it, so if the
// migration has not run yet her old rows still show their money under
// 'BofA'; they simply cannot be chosen as a destination. Run the migration
// straight after deploying and that state lasts minutes.
const SOURCES = ['Edge Metals', 'AAA Investment', 'Chase Bank', 'Unassigned'];
const UNASSIGNED = 'Unassigned';

// ── WHICH BANK EACH ACCOUNT SITS IN ───────────────────────────────────────
// The fact the slash was trying to carry, kept as its own field so a name
// never has to be taken apart to find it. Unassigned has no bank — that is
// the whole meaning of the bucket — and says so with null rather than a
// label, because "Unassigned is at Unassigned" is not a sentence.
const BANK_OF = {
    'Edge Metals': 'BofA',
    'AAA Investment': 'BofA',
    'Chase Bank': 'Chase Bank',
};
function bankOf(source) {
    return BANK_OF[String(source || '').trim()] || null;
}

// ── AND WHOSE MONEY IT IS ─────────────────────────────────────────────────
// ONLY what she has actually said. She named the company behind the two new
// accounts and nothing else. Plain BofA is a mix by definition, and she has
// never said whose Chase Bank is or whose the opening float was — so they sit
// under COMPANY_UNKNOWN rather than being quietly assigned to Edge Metals
// because it is the bigger company. A guess here would print a per-company
// figure that reads as fact on a screen she makes decisions from.
//
// The account and the company share a name, which is not a coincidence and
// not a collision: the account IS that company's money at BofA. Kept as an
// explicit map anyway, so a future account called something else still
// reports a company instead of quietly becoming its own.
const COMPANY_UNKNOWN = 'Company not stated';
const COMPANY_OF = {
    'Edge Metals': 'Edge Metals',
    'AAA Investment': 'AAA Investment',
};
function companyOf(source) {
    return COMPANY_OF[String(source || '').trim()] || COMPANY_UNKNOWN;
}

// EVERY ROW WRITTEN BEFORE TODAY HAS NO SOURCE, and must read as Unassigned
// rather than as nothing. That is not a fallback, it is the opening float:
// the cash is really there and really has no bank recorded behind it. A row
// that answered `null` here would vanish from all three buckets while still
// counting in the total, and the invariant below would stop holding.
function sourceOf(entry) {
    const raw = String((entry && entry.cash_source) || '').trim();
    if (!raw) return UNASSIGNED;
    const hit = matchSource(raw);
    // An unrecognised name is kept AS TYPED rather than forced to Unassigned.
    // If a third bank is ever added, its old rows must not silently pour into
    // the unbanked bucket — they would inflate a figure she reassigns from.
    return hit || raw;
}

// ── ONE NAME, AND NOTHING IS INFERRED FROM A PARTIAL ONE ──────────────────
// An earlier version of this matched a bare "AAA Investment" back onto
// 'BofA/AAA Investment', and needed an ambiguity rule to stop it choosing
// between two accounts. Naming the accounts properly deleted the problem:
// "AAA Investment" IS the name, so there is nothing left to guess, and
// guessing between two companies' money is the one thing rule 5 exists to
// stop. What remains is tolerance for how a name is TYPED, not for what it
// leaves out — case, and runs of whitespace. Nothing else.
//
// This matters most for helpers/tools.js, which is how she records a cash
// payment by TALKING to Jarvis: it has no dropdown, and it is the caller
// this repo has broken three times. "aaa  investment" reaches the right
// account; "AAA" reaches nothing and is refused with the list.
const flat = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');

function matchSource(raw, list = SOURCES) {
    const want = flat(raw);
    if (!want) return null;
    return list.find((s) => flat(s) === want) || null;
}

// Normalises on the way IN. Refuses a name that is not a source, because a
// typo stored here becomes a fourth bucket nobody asked for and the three
// figures on screen stop adding up to the total.
function cleanSource(v, { allowBlank = false } = {}) {
    const raw = String(v == null ? '' : v).trim();
    if (!raw) {
        if (allowBlank) return UNASSIGNED;
        throw new Error(`Which cash is this? Choose ${SOURCES.join(', ')}.`);
    }
    const hit = matchSource(raw);
    if (!hit) throw new Error(`"${raw}" is not one of ${SOURCES.join(', ')}.`);
    return hit;
}

// Sum of every row. Signed amounts, so this is one reduce and there is no
// branch that could count a withdrawal the wrong way.
function balanceOf(entries) {
    const list = Array.isArray(entries) ? entries : [];
    return round2(list.reduce((a, e) => a + (toNum(e && e.amount) || 0), 0)) || 0;
}

// ── THE INVARIANT THIS WHOLE FEATURE RESTS ON ─────────────────────────────
// Every bucket is a sum of the SAME rows balanceOf adds up, filtered. So the
// buckets cannot drift from the total by construction — there is no second
// tally to keep in step, and no stored per-bank figure to go stale. The same
// reasoning as the file's opening note about not storing a balance, applied
// one level down.
//
// A bucket CAN go negative, and that is information rather than corruption:
// it means cash attributed to that bank left the box without a matching
// top-up. withdrawForExpense has always been allowed to do this (see its
// note); only payments refuse.
function balanceBySource(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const out = {};
    for (const s of SOURCES) out[s] = 0;
    for (const e of list) {
        const s = sourceOf(e);
        out[s] = (out[s] || 0) + (toNum(e && e.amount) || 0);
    }
    for (const k of Object.keys(out)) out[k] = round2(out[k]) || 0;
    return out;
}

// ── THE SAME MONEY, GROUPED BY WHOSE IT IS ────────────────────────────────
//
// HER CHOICE, 2026-09-21, of three offered: "Keep one total, break it down
// below". She had said on 20-Sep that "overall all the sum of amount should
// come in cash in hand", and that promise is kept — the headline figure is
// still every row added up. This sits under it.
//
// Built by folding balanceBySource, NOT by a second pass over the rows, so
// the invariant at the top of this file still holds one level further down:
// the company figures cannot drift from the bucket figures, and neither can
// drift from the total, because there is only ever one tally.
//
// Buckets whose company she has not stated are reported under one honest
// heading rather than spread across the two she has named.
function balanceByCompany(entries) {
    const per = balanceBySource(entries);
    const out = {};
    for (const [src, amt] of Object.entries(per)) {
        const co = companyOf(src);
        out[co] = round2((out[co] || 0) + (amt || 0)) || 0;
    }
    return out;
}

function balances() {
    const list = listEntries();
    return {
        total: balanceOf(list),
        bySource: balanceBySource(list),
        byCompany: balanceByCompany(list),
        // So a screen can label and GROUP an account without repeating either
        // map. The bank is what the two new accounts are shown under — her
        // "Under BofA. 1.Edge Metals 2.AAA Investment".
        companyOf: SOURCES.reduce((m, s) => { m[s] = companyOf(s); return m; }, {}),
        bankOf: SOURCES.reduce((m, s) => { m[s] = bankOf(s); return m; }, {}),
    };
}

function balance() {
    return balanceOf(listEntries());
}

// Newest first — the tab shows recent movement, and "what happened today" is
// the question being asked. created_at breaks ties within a day, so two
// entries on the same date still read in the order they were made.
function history(limit = 200) {
    return listEntries()
        .slice()
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))
            || String(b.created_at || '').localeCompare(String(a.created_at || '')))
        .slice(0, Math.max(0, Number(limit) || 0) || undefined);
}

// ── put cash in ───────────────────────────────────────────────────────────
async function addTopUp(input = {}) {
    const amount = round2(toNum(input.amount));
    if (amount == null) throw new Error('a cash amount is required');
    if (amount <= 0) throw new Error('a cash amount must be greater than zero');

    // Defaults to the yard's local day, not UTC — an evening top-up must not
    // be stamped with tomorrow. Same reasoning as a payment's paid_on.
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(input.date || ''))
        ? input.date
        : require('./time').todayLocal();

    const record = {
        id: newEntryId(),
        kind: 'topup',
        // ── ASKED ON THE FORM, NOT ENFORCED HERE ─────────────────────────
        // Apsara, 2026-09-21: "when adding cash ,ask its from BofA or chase
        // bank". The FORM asks and will not submit without an answer.
        //
        // This layer accepts blank, and the first version of it did not —
        // which would have shipped a break. The phone's Petty cash tab does
        // not know about this field yet, and the APK already installed never
        // will until she builds a new one, so a hard requirement here means
        // she cannot add cash from her phone AT ALL. That is the same mistake
        // CLAUDE.md records twice: a rule written for one screen landing in
        // shared code that another caller cannot satisfy. Caught by
        // tests/yard-payments.js, which tops up without a source.
        //
        // A top-up that arrives unattributed lands in Unassigned, which is
        // honest rather than a guess, and the Borrowing tab's move-cash
        // action exists exactly so she can put a bank behind it afterwards.
        cash_source: cleanSource(input.cash_source, { allowBlank: true }),
        date,
        amount,                                   // positive
        note: String(input.note || '').trim() || null,
        load_id: null,
        payment_id: null,
        created_at: new Date().toISOString(),
        created_by: input.created_by || null,
    };
    await mutateJson(cfg.PETTY_CASH_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        list.push(record);
        return list;
    });
    return record;
}

// ── MOVING CASH BETWEEN BUCKETS ───────────────────────────────────────────
//
// One primitive, three reasons:
//   borrow   — BofA covers a payment nominated to Chase, because Chase is short
//   repay    — she settles that, by pressing Repay. Nothing settles itself.
//   reassign — unbanked cash gets a bank put behind it, once she banks it
//
// TWO ROWS, NOT ONE. The ledger is signed rows and every balance is their
// sum, so a move is a negative row on one side and a positive on the other.
// They share a transfer_id. The overall total is unchanged by construction —
// the two amounts cancel — which is exactly the property that keeps the three
// buckets adding up to Cash in hand through any number of borrows.
//
// A REASSIGNMENT IS A DATED MOVE, NOT AN EDIT. Rewriting the old rows' source
// would be less code and would change what last month's Chase figure was,
// after she had already read it and decided on it. This file's opening note
// says the balance must always be a thing you can point at; a retroactive
// edit takes that away.
//
// NOT EXPOSED FOR ARBITRARY USE: `reason` is checked, because an unlabelled
// transfer is one the Borrowing tab cannot explain.
const TRANSFER_REASONS = ['borrow', 'repay', 'reassign'];
let transferSeq = 0;
function newTransferId() {
    transferSeq += 1;
    return `PCT_${Date.now().toString(36)}${transferSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function transfer({ from, to, amount, reason, note, date, createdBy } = {}) {
    const src = cleanSource(from);
    const dst = cleanSource(to);
    if (src === dst) throw new Error('that would move the cash to where it already is');
    const amt = round2(toNum(amount));
    if (amt == null || amt <= 0) throw new Error('an amount to move must be greater than zero');
    const why = String(reason || '').trim().toLowerCase();
    if (!TRANSFER_REASONS.includes(why)) {
        throw new Error(`a transfer needs a reason: ${TRANSFER_REASONS.join(', ')}`);
    }
    const when = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : require('./time').todayLocal();

    const tid = newTransferId();
    const common = {
        kind: 'transfer', transfer_id: tid, transfer_reason: why,
        date: when, note: String(note || '').trim() || null,
        load_id: null, payment_id: null,
        created_at: new Date().toISOString(), created_by: createdBy || null,
    };
    const out = { ...common, id: newEntryId(), cash_source: src, amount: round2(-amt), transfer_to: dst };
    const inn = { ...common, id: newEntryId(), cash_source: dst, amount: round2(amt), transfer_from: src };

    await mutateJson(cfg.PETTY_CASH_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];

        // ── YOU CANNOT MOVE CASH A BUCKET DOES NOT HAVE ──────────────────
        // Found by running her own worked example one step past where she
        // described it. After Chase borrows 4,000 from BofA and pays the
        // 7,000 bill, Chase holds nothing — and pressing Repay moved 4,000
        // out of it anyway, leaving Chase at MINUS 4,000 and BofA whole. The
        // debt cleared and an overdraft appeared in its place, which is a
        // worse position than the one she started in and looks like success.
        //
        // The real sequence is: put 4,000 into Chase from the Chase account,
        // then repay BofA. So a transfer is refused unless the money is
        // there, and the message says what to do about it.
        //
        // Deliberately NOT applied to the borrow inside withdrawForPayment:
        // that path writes its rows directly and has already capped each
        // lender at what it holds. A borrow is also the one movement whose
        // whole purpose is that the destination is short.
        const held = round2(balanceBySource(list)[src] || 0) || 0;
        if (amt - held > CENT) {
            const err = new Error(
                `${src} only holds ${held.toFixed(2)} — not enough to move ${amt.toFixed(2)}.`
                + (why === 'repay' ? ` Add cash to ${src} first, then repay ${dst}.` : ''));
            err.code = 'PETTY_CASH_TRANSFER_SHORT';
            err.bucket = src;
            err.bucket_available = held;
            err.requested = amt;
            throw err;
        }

        // ── BOTH ROWS OR NEITHER, and they go in under ONE lock ───────────
        // Two separate calls could interleave with another writer and leave
        // the money out of one bucket and not yet in the other — a moment
        // where the buckets do not add up, which is the only thing anyone
        // will trust about this screen.
        list.push(out, inn);
        return list;
    });
    return { transfer_id: tid, from: src, to: dst, amount: amt, reason: why, date: when, rows: [out, inn] };
}

// ── WHAT ONE BUCKET STILL OWES ANOTHER ────────────────────────────────────
//
// Netted per DIRECTED PAIR, so a borrow and its repayment cancel and a second
// borrow adds. Computed from the rows rather than kept as a running figure,
// same as every other number in this file.
//
// Deliberately nets the two directions against each other: if Chase borrowed
// 4,000 from BofA and later BofA borrowed 1,000 from Chase, she is owed one
// sentence — Chase owes BofA 3,000 — not two facing each other. Anyone
// reading two rows would have to do that subtraction themselves, and would
// eventually do it wrong.
function borrowings(entries) {
    const list = Array.isArray(entries) ? entries : listEntries();
    const net = new Map();
    for (const e of list) {
        if (!e || e.kind !== 'transfer') continue;
        const why = String(e.transfer_reason || '').toLowerCase();
        if (why !== 'borrow' && why !== 'repay') continue;
        // Read only the OUT row of each pair, so the movement is counted once.
        const amt = toNum(e.amount) || 0;
        if (amt >= 0) continue;
        const moverFrom = sourceOf(e);                          // the bucket money LEFT
        const moverTo = String(e.transfer_to || '').trim();     // the bucket it went TO
        if (!moverTo) continue;
        const size = Math.abs(amt);

        // A BORROW: the money left the LENDER and went to the BORROWER, so
        // after it the borrower owes the lender.
        //   key is always "<who owes>|<who is owed>"
        // A REPAY is the same movement run backwards: the money leaves the
        // one who owed and goes to the one who was owed, so it subtracts
        // from that same key. Written as one key and a sign rather than two
        // cases, because two cases is where the direction gets flipped.
        const key = why === 'borrow' ? `${moverTo}|${moverFrom}` : `${moverFrom}|${moverTo}`;
        const delta = why === 'borrow' ? size : -size;
        net.set(key, round2((net.get(key) || 0) + delta));
    }
    const out = [];
    const done = new Set();
    for (const [key, amount] of net) {
        if (done.has(key)) continue;
        const [owes, to] = key.split('|');
        const back = net.get(`${to}|${owes}`) || 0;
        done.add(key); done.add(`${to}|${owes}`);
        const netAmt = round2(amount - back);
        if (Math.abs(netAmt) <= CENT) continue;
        out.push(netAmt > 0 ? { owes, to, amount: netAmt } : { owes: to, to: owes, amount: round2(-netAmt) });
    }
    // ── AND WHICH OF THESE CROSS A COMPANY LINE ───────────────────────────
    // HER CHOICE, 2026-09-21, of three offered: "Allow it, record it as owed"
    // — Edge Metals covering an AAA Investment payment out of the same cash
    // box still works, and is not refused. But that balance is not the same
    // animal as Chase owing BofA: it is one company owing another, the thing
    // CLAUDE.md rule 5 says to keep apart, and somebody settles it on paper.
    //
    // So it is FLAGGED, not blocked, and the flag is computed rather than
    // stored — a borrow whose buckets are later renamed must not keep an old
    // answer. Two buckets with no stated company are not "the same company":
    // COMPANY_UNKNOWN is an absence of an answer, so it claims nothing either
    // way and intercompany stays false until she says whose the money is.
    return out
        .map((b) => {
            const a = companyOf(b.owes), z = companyOf(b.to);
            return { ...b, owes_company: a, to_company: z,
                     intercompany: a !== COMPANY_UNKNOWN && z !== COMPANY_UNKNOWN && a !== z };
        })
        .sort((a, b) => b.amount - a.amount);
}

// Every borrow and repay, newest first — the history behind the figures above.
function transfers(entries) {
    const list = Array.isArray(entries) ? entries : listEntries();
    return list
        .filter((e) => e && e.kind === 'transfer' && (toNum(e.amount) || 0) < 0)
        .map((e) => ({
            transfer_id: e.transfer_id || null,
            reason: e.transfer_reason || null,
            from: sourceOf(e),
            to: String(e.transfer_to || '') || null,
            amount: round2(Math.abs(toNum(e.amount) || 0)),
            date: e.date || null,
            note: e.note || null,
            created_at: e.created_at || null,
            created_by: e.created_by || null,
        }))
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))
            || String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

// ── take cash out, for a cash payment ─────────────────────────────────────
//
// Returns { entry, taken, available, capped }.
//
// THE CHECK AND THE WRITE HAPPEN INSIDE ONE mutateJson, under its lock. Two
// people paying at the same moment therefore serialise: the second sees the
// balance the first left behind. Reading the balance first and writing after
// would let both see $500 and both take it.
//
// `allowPartial` is the acknowledgement gate. Asked for more than there is:
//   allowPartial false -> throws, carrying `available` so the client can show
//                         "only $400 in the box" and ask
//   allowPartial true  -> takes what there is and reports capped: true
// The default is to REFUSE. A partial payment against a supplier's load is a
// decision, not a rounding — it leaves them owed money and the ticket says so.
async function withdrawForPayment({ amount, loadId, paymentId, date, createdBy, allowPartial = false,
                                    cashSource, allowBorrow = false } = {}) {
    const want = round2(toNum(amount));
    if (want == null || want <= 0) throw new Error('a cash amount must be greater than zero');
    // Blank is allowed and means Unassigned. It has to be: the APK on her
    // phone and the voice path both predate this field, and a payment that
    // refuses outright because an old client did not name a bank is a payment
    // she cannot record at all. Unbanked cash is a real bucket, so landing
    // there is an honest answer rather than a placeholder.
    const src = cleanSource(cashSource, { allowBlank: true });

    let result = null;
    await mutateJson(cfg.PETTY_CASH_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        const available = balanceOf(list);

        // ── THE NOMINATED BUCKET, AND WHO COULD COVER IT ──────────────────
        // Apsara's worked example, 2026-09-21: "Say the bill amount is 7000.
        // we have only 3000 in chase and 10000 in bofa... It should show
        // something in terms of 3000 only avilable in chase.want to borrow
        // from bofa?On confirmaton-allow them to pay."
        //
        // Refused FIRST, with the figures, and only moved on her yes — the
        // same shape as the PETTY_CASH_SHORT flow already on these screens,
        // so it is a pattern she has seen rather than a second convention.
        //
        // Checked and moved INSIDE this one mutator, under its lock. A borrow
        // decided outside and written after would let two payments both see
        // BofA's ten thousand and both take it.
        const buckets = balanceBySource(list);
        const inBucket = round2(buckets[src] || 0) || 0;
        if (want - inBucket > CENT && available - want > -CENT) {
            // The box as a whole CAN cover it; only this bucket cannot. That
            // is the borrow case, and it is the only one that offers a
            // lender — when the box itself is short there is nothing to
            // borrow and the existing refusals below are the right answer.
            const need = round2(want - inBucket);
            const lenders = SOURCES
                .filter((s) => s !== src)
                .map((s) => ({ source: s, available: round2(buckets[s] || 0) || 0 }))
                .filter((l) => l.available > CENT)
                .sort((a, b) => b.available - a.available);

            if (!allowBorrow) {
                const err = new Error(`Only ${inBucket.toFixed(2)} available in ${src}.`);
                err.code = 'PETTY_CASH_BUCKET_SHORT';
                err.bucket = src;
                err.bucket_available = inBucket;
                err.requested = want;
                err.shortfall = need;
                err.lenders = lenders;
                throw err;
            }

            // ── DRAW FROM THE FULLEST FIRST ──────────────────────────────
            // Only matters when there are three buckets and the shortfall
            // spans two of them. Largest-first leaves the remaining buckets
            // as even as possible, which is the least surprising of the
            // arbitrary choices available — and the transfers are listed on
            // the Borrowing tab either way, so nothing is hidden.
            let left = need;
            for (const l of lenders) {
                if (left <= CENT) break;
                const take = Math.min(l.available, left);
                if (take <= CENT) continue;
                const tid = newTransferId();
                const common = {
                    kind: 'transfer', transfer_id: tid, transfer_reason: 'borrow',
                    date: /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : require('./time').todayLocal(),
                    note: `covering a cash payment from ${src}`,
                    load_id: loadId || null, payment_id: null,
                    created_at: new Date().toISOString(), created_by: createdBy || null,
                };
                list.push({ ...common, id: newEntryId(), cash_source: l.source, amount: round2(-take), transfer_to: src });
                list.push({ ...common, id: newEntryId(), cash_source: src, amount: round2(take), transfer_from: l.source });
                left = round2(left - take);
            }
        }

        if (available <= CENT) {
            const err = new Error('There is no petty cash to pay from. Add cash on the Petty cash tab first.');
            err.code = 'PETTY_CASH_EMPTY';
            err.available = available > 0 ? available : 0;
            throw err;
        }
        if (want - available > CENT && !allowPartial) {
            const err = new Error(`Only ${available.toFixed(2)} in petty cash — not enough for ${want.toFixed(2)}.`);
            err.code = 'PETTY_CASH_SHORT';
            err.available = available;
            err.requested = want;
            throw err;
        }

        const taken = (want - available > CENT) ? available : want;
        const entry = {
            id: newEntryId(),
            kind: 'payment',
            // The bucket this note came out of. After any borrow above, the
            // nominated bucket is the one that actually holds the money.
            cash_source: src,
            date: /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : require('./time').todayLocal(),
            amount: round2(-taken),               // negative
            note: null,
            load_id: loadId || null,
            payment_id: paymentId || null,
            created_at: new Date().toISOString(),
            created_by: createdBy || null,
        };
        list.push(entry);
        result = { entry, taken: round2(taken), available, capped: taken < want - CENT };
        return list;
    });
    return result;
}

// ── put cash IN, because a yard SALE was paid in cash ─────────────────────
//
// Apsara, 2026-09-16: "in sales-receive payment,mode should be cash/account
// transfer.if its cash-it should get added to petty cash.log them" — and,
// asked which company: "i am talking about edge yard only".
//
// ── THE BUG THIS EXISTS TO FIX, WHICH IS WORSE THAN A MISSING FEATURE ───────
// Petty cash already moved for cash payments, in ONE direction. helpers/
// payments.js called withdrawForPayment for any cash payment on a yard load,
// and a yard load can be a SALE. So money ARRIVING was recorded as money
// LEAVING: take $5,000 cash for a load of aluminium and the cash box went DOWN
// five thousand.
//
// And it was usually not even wrong quietly. withdrawForPayment refuses when
// the box holds less than the amount, so recording a $5,000 cash sale against
// a $300 box failed outright with "Only 300.00 in petty cash" — a sale she
// could not enter at all, for a reason that made no sense from where she was
// standing.
//
// ── NO CAP, NO REFUSAL, DELIBERATELY ────────────────────────────────────────
// Unlike every withdrawal in this file, there is nothing to check. Cash coming
// in cannot overdraw a box; the money is physically in her hand. A balance
// test here would be the same mistake in a new place.
async function depositForPayment({ amount, loadId, paymentId, date, createdBy, cashSource } = {}) {
    const want = round2(toNum(amount));
    if (want == null || want <= 0) throw new Error('a cash amount must be greater than zero');

    let result = null;
    await mutateJson(cfg.PETTY_CASH_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        const entry = {
            id: newEntryId(),
            // 'receipt', not 'topup'. A top-up is her putting her own money in
            // the box; this is a customer paying for metal. The Petty cash tab
            // and the spend report both split on kind, and calling a sale a
            // top-up would make the day's takings look like a float she added.
            kind: 'receipt',
            // ── A CUSTOMER'S CASH CAME FROM NO BANK ──────────────────────
            // Unassigned unless the caller says otherwise, and that is the
            // truth rather than a default: this money was handed over for a
            // load of metal and never passed through BofA or Chase. Filing it
            // under a bank would inflate that bank's figure with money it
            // never provided, and "what has Chase funded" would stop being
            // answerable. She can move it to a bank later, when she banks it.
            cash_source: cleanSource(cashSource, { allowBlank: true }),
            date: /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : require('./time').todayLocal(),
            amount: round2(want),                 // POSITIVE — money in
            note: null,
            load_id: loadId || null,
            payment_id: paymentId || null,
            created_at: new Date().toISOString(),
            created_by: createdBy || null,
        };
        list.push(entry);
        result = { entry, added: round2(want), balance: balanceOf(list) };
        return list;
    });
    return result;
}

// ── take cash out, for an EXPENSE ─────────────────────────────────────────
//
// Returns { entry, taken, available, shortfall }.
//
// THIS ONE IS ALLOWED TO OVERDRAW, and a load payment is not. That asymmetry
// is deliberate, and it is about what the two records mean:
//
//   a load payment is money about to be handed over. You cannot hand over
//   cash you do not have, so the box refuses and the operator tops it up.
//
//   an expense is a receipt for money ALREADY SPENT — a fuel stop last week,
//   a part bought yesterday. Refusing it would not un-spend the money; it
//   would just stop the record being made. So it always goes in, and if the
//   box does not cover it the balance goes negative.
//
// A negative balance is therefore INFORMATION, not corruption: it means cash
// left the drawer that was never entered here. `shortfall` is returned so the
// screen can say exactly that — Apsara, 2026-09-02: "If expense is more but
// petty cash is less, notify user."
async function withdrawForExpense({ amount, expenseId, date, createdBy, cashSource } = {}) {
    const want = round2(toNum(amount));
    if (want == null || want <= 0) throw new Error('an expense amount must be greater than zero');
    // ── AN EXPENSE NAMES ITS BUCKET, AND STILL MAY OVERDRAW IT ───────────
    // Apsara, 2026-09-21, asked whether a cash expense should ask which bank:
    // "Yes, ask — same as a payment."
    //
    // It asks. It does NOT gain a payment's refusal, and that is deliberate
    // rather than an oversight: this function has always been allowed to take
    // the box negative, for the reason in the note above — the money has
    // already left the drawer, and refusing would not un-spend it, it would
    // only stop the record being made. Adding a borrow prompt here would
    // change how a screen she uses daily behaves, which she did not ask for.
    // So a bucket can go negative, and the tab shows that plainly.
    const src = cleanSource(cashSource, { allowBlank: true });

    let result = null;
    await mutateJson(cfg.PETTY_CASH_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        const available = balanceOf(list);
        const entry = {
            id: newEntryId(),
            kind: 'expense',
            cash_source: src,
            date: /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : require('./time').todayLocal(),
            amount: round2(-want),               // the FULL amount, never capped
            note: null,
            load_id: null,
            payment_id: null,
            expense_id: expenseId || null,
            created_at: new Date().toISOString(),
            created_by: createdBy || null,
        };
        list.push(entry);
        result = {
            entry,
            taken: want,
            available,
            // How much of this the box could not cover. Zero when it could.
            shortfall: want - available > CENT ? round2(want - available) : 0,
        };
        return list;
    });
    return result;
}

// Undoes an expense withdrawal — on delete, and on an edit that changes the
// amount or the method. Same reversal-row approach as a payment, and
// idempotent for the same reason.
async function reverseForExpense(expenseId, { createdBy, note } = {}) {
    if (expenseId == null) return null;
    const key = String(expenseId);
    let record = null;
    await mutateJson(cfg.PETTY_CASH_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        const taken = list.filter((e) => e && e.kind === 'expense' && String(e.expense_id) === key);
        if (!taken.length) return list;
        const reversedIds = new Set(list.filter((e) => e && e.kind === 'reversal').map((e) => e.reverses_entry_id));
        const outstanding = taken.filter((e) => !reversedIds.has(e.id));
        if (!outstanding.length) return list;                       // already refunded
        const total = round2(outstanding.reduce((a, e) => a + (toNum(e.amount) || 0), 0)) || 0;   // negative
        record = {
            id: newEntryId(),
            kind: 'reversal',
            // ── BACK INTO THE BUCKET IT CAME OUT OF ──────────────────────
            // Added 2026-09-21. Without this the refund lands in Unassigned
            // while the withdrawal came out of Chase, so undoing a payment
            // would quietly move money between banks — the buckets would
            // still add up to the right total, which is precisely why nobody
            // would notice. Taken from the row being reversed, not from the
            // caller, because the caller does not necessarily know.
            cash_source: sourceOf(taken[0]),
            date: require('./time').todayLocal(),
            amount: round2(-total),               // positive
            note: note || 'expense removed',
            load_id: null,
            payment_id: null,
            expense_id: key,
            reverses_entry_id: outstanding[0].id,
            created_at: new Date().toISOString(),
            created_by: createdBy || null,
        };
        list.push(record);
        return list;
    });
    return record;
}

// Links a withdrawal to the payment it turned out to belong to.
//
// The withdrawal has to be written BEFORE the payment exists (the money is
// reserved first — see helpers/payments.js), so at that moment there is no
// payment id to record. This fills it in afterwards.
//
// Not fatal if it fails: the cash has already moved correctly and the entry
// still carries load_id, so what is lost is a cross-reference, not a cent.
// reverseForPayment accepts either id for exactly this reason.
async function stampPaymentId(entryId, paymentId) {
    if (!entryId || !paymentId) return null;
    let updated = null;
    await mutateJson(cfg.PETTY_CASH_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        const row = list.find((e) => e && e.id === entryId);
        if (row) { row.payment_id = paymentId; updated = row; }
        return list;
    });
    return updated;
}

// ── put it back ───────────────────────────────────────────────────────────
// Deleting a cash payment returns the money to the box. As a REVERSAL row
// rather than by removing the withdrawal: the ledger is a history, and a
// history you can delete rows from is one nobody can trust. The pair stays
// visible — money out on the 2nd, money back on the 3rd.
//
// Idempotent, so a double-delete cannot refund twice.
//
// Accepts EITHER a payment id or the withdrawal entry's own id. Both are
// needed: an ordinary delete knows the payment id, but the rollback in
// addPayment fires when the payment write failed — so no payment id was ever
// stamped, and the entry id is all there is. Matching on both means the
// rollback path is not a special case with its own code.
async function reverseForPayment(idOrEntryId, { createdBy } = {}) {
    const key = idOrEntryId;
    if (!key) return null;
    let record = null;
    await mutateJson(cfg.PETTY_CASH_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        // 'payment' and 'receipt' only. An expense withdrawal can carry the
        // same shape but is undone by reverseForExpense — mixing them would
        // let deleting a payment refund an unrelated expense.
        //
        // 'receipt' is here so that deleting a cash SALE payment takes the
        // money back OUT of the box. The arithmetic below negates whatever
        // was recorded, so it is correct in both directions without a branch
        // — a second code path for the positive case is where the two would
        // eventually disagree about which way the money went.
        const matches = (e) => e && (e.payment_id === key || e.id === key);
        const taken = list.filter((e) => matches(e) && (e.kind === 'payment' || e.kind === 'receipt'));
        if (!taken.length) return list;                                   // never touched the cash box
        const takenIds = new Set(taken.map((e) => e.id));
        // Already refunded — by payment id, or by the entry id the rollback
        // would have used. Both are checked, or a delete after a failed
        // rollback could refund the same withdrawal twice.
        if (list.some((e) => e && e.kind === 'reversal'
            && (e.payment_id === key || takenIds.has(e.reverses_entry_id)))) return list;
        const total = round2(taken.reduce((a, e) => a + (toNum(e.amount) || 0), 0)) || 0;  // negative for a payment, positive for a receipt
        record = {
            id: newEntryId(),
            kind: 'reversal',
            // ── BACK INTO THE BUCKET IT CAME OUT OF ──────────────────────
            // Added 2026-09-21. Without this the refund lands in Unassigned
            // while the withdrawal came out of Chase, so undoing a payment
            // would quietly move money between banks — the buckets would
            // still add up to the right total, which is precisely why nobody
            // would notice. Taken from the row being reversed, not from the
            // caller, because the caller does not necessarily know.
            cash_source: sourceOf(taken[0]),
            date: require('./time').todayLocal(),
            amount: round2(-total),               // the opposite of whatever it undoes
            note: taken[0].kind === 'receipt' ? 'cash receipt deleted' : 'cash payment deleted',
            load_id: taken[0].load_id || null,
            payment_id: taken[0].payment_id || null,
            // Which withdrawal(s) this undoes. Recorded explicitly because the
            // payment_id may be null (the rollback case), and without it a
            // second refund attempt would have nothing to recognise.
            reverses_entry_id: taken[0].id,
            created_at: new Date().toISOString(),
            created_by: createdBy || null,
        };
        list.push(record);
        return list;
    });
    return record;
}

// Removes a row outright. Only ever offered for top-ups — a mistyped top-up is
// a data-entry error with nothing else attached to it. A 'payment' row belongs
// to a payment and is undone by deleting THAT, which reverses it properly; and
// a 'reversal' is itself a correction. Refusing here rather than in the route
// means the rule holds however the function is reached.
async function deleteEntry(id) {
    let removed = false;
    await mutateJson(cfg.PETTY_CASH_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        const row = list.find((e) => e && e.id === id);
        if (!row) return list;
        if (row.kind !== 'topup') {
            const err = new Error('Only a cash top-up can be deleted here. To undo a cash payment, delete the payment on the load.');
            err.code = 'PETTY_CASH_NOT_A_TOPUP';
            throw err;
        }
        const next = list.filter((e) => e.id !== id);
        removed = next.length !== list.length;
        return next;
    });
    return removed;
}

module.exports = {
    ENTRY_KINDS, listEntries, balance, balanceOf, history,
    addTopUp, withdrawForPayment, depositForPayment, stampPaymentId, reverseForPayment,
    withdrawForExpense, reverseForExpense, deleteEntry,
    // Per-bucket, added 2026-09-21. SOURCES is exported so the API, both
    // clients and the server-side check read ONE list — the same reasoning
    // helpers/banks.js gives for its own: six copies of a dropdown drift
    // faster than three.
    SOURCES, UNASSIGNED, sourceOf, cleanSource, balanceBySource, balances,
    transfer, borrowings, transfers, TRANSFER_REASONS,
    // Per-company, added 2026-09-21 when BofA became two accounts belonging
    // to two companies. Exported for the same reason SOURCES is: one map, not
    // one per screen.
    COMPANY_OF, COMPANY_UNKNOWN, companyOf, balanceByCompany,
    BANK_OF, bankOf,
};
