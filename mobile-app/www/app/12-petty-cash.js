// mobile-app/www/app/12-petty-cash.js — split from mobile-app/www/index.html's <script> (helpers/sourceParts.js reconstructs the original)
// ── Petty cash ─────────────────────────────────────────────────────────────
// Apsara, 2026-09-02: "a new tab called Petty cash. Date and cash amount needs
// to be entered here. So it is like cash reserve."
//
// The balance is SERVER-COMPUTED (helpers/pettyCash.js sums the ledger). This
// screen never adds the rows up itself — one place owns the arithmetic, and a
// cash balance that two screens disagree about is worse than no screen at all.
//
// Staff SEE it, admin CHANGES it — her choice. Hiding the form for staff is UX
// only: POST/DELETE /api/petty-cash are requireAdmin server-side, so a staff
// session that reached them another way gets a 403.
// by_source / borrowings / transfers added 2026-09-21, mirroring
// dashboard/index.html. `balance` keeps its name and meaning — Cash in hand,
// the sum of every row — so nothing that already read it changes.
// ── by_source STARTS null, NOT {} ───────────────────────────────────────
// Apsara, 2026-10-14: "WHEN I CLICK LOADS,THEN PAY IT IS SHOWING 0.AFTER
// JSUT VISITING PERTY CASE,THEN I CLICK PAY IN LOADS,IT IS SHOWING
// PROPERLY." The pay modal reads this and nothing fetched it, so before the
// Petty cash tab had been opened every bucket read $0.00 and the note said
// "There is no cash recorded in any account yet" — a false statement about
// money, on her screen.
//
// That note already guards against this: it speaks only when by_source is
// "known", because claiming there is no cash while the figures are loading
// "would be a lie that clears itself a second later". The guard tests
// `by_source && typeof === 'object'`, and an EMPTY OBJECT passes it. The
// default defeated the defence. null makes "not fetched" different from
// "fetched and empty"; every reader already writes (pettyCash.by_source || {}).
let pettyCash = { balance: 0, entries: [], by_source: null, borrowings: [], transfers: [], sources: [] };
// Which sub-tab of Petty cash is open. Her words, 2026-09-21: "Keep this
// borrowing tracking in petty cash as a tab inside petty cash."
let pettyTab = 'cash';

async function refreshPettyCash() {
  try {
    const d = await api('/api/petty-cash');
    pettyCash = {
      balance: Number(d.balance) || 0,
      entries: Array.isArray(d.entries) ? d.entries : [],
      by_source: (d && d.by_source) || {},
      borrowings: Array.isArray(d && d.borrowings) ? d.borrowings : [],
      transfers: Array.isArray(d && d.transfers) ? d.transfers : [],
      // From the SERVER, never a list typed here — helpers/pettyCash.js says
      // why: six copies of a dropdown drift faster than three.
      sources: Array.isArray(d && d.sources) ? d.sources : [],
      by_company: (d && d.by_company) || {},
      company_of: (d && d.company_of) || {},
      bank_of: (d && d.bank_of) || {},
      company_unknown: (d && d.company_unknown) || 'Company not stated',
    };
  } catch (e) {
    // Keep the last known figure rather than showing $0.00, which would read
    // as "the box is empty" — a false statement about money. Same lesson as
    // the description catalogue emptying itself on a failed request.
    console.warn('[petty] could not refresh the balance:', e && e.message);
  }
  return pettyCash;
}


// ── THE BORROWING TAB ─────────────────────────────────────────────────────
// Apsara, 2026-09-21: "Keep this borrowing tracking in petty cash as a tab
// inside petty cash." Two halves — what is still owed, which is the question,
// and every movement behind it, which answers "why". Mirrors
// dashboard/index.html; see that file for the full reasoning.
function pettyBorrowingHtml(isAdmin) {
  const owed = pettyCash.borrowings || [];
  const moves = pettyCash.transfers || [];
  const held = (src) => Number((pettyCash.by_source || {})[src]) || 0;

  const owedHtml = owed.length ? owed.map((b) => {
    // The button is disabled when the bucket cannot cover it — the server
    // refuses it anyway, and a button that always fails teaches people to
    // ignore the screen. The reason is printed rather than hidden in a toast.
    const can = held(b.owes) >= b.amount - 0.005;
    return `
    <div class="card" style="padding:14px 16px; margin-bottom:10px;">
      <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
        <div style="flex:1; min-width:180px;">
          <div style="font-size:13px;"><strong style="color:var(--text-strong);">${esc(b.owes)}</strong> owes <strong style="color:var(--text-strong);">${esc(b.to)}</strong></div>
          <!-- Apsara, 2026-09-21, on borrowing across the Edge Metals / AAA
               Investment line, of three offered: "Allow it, record it as
               owed." Allowed, not refused — and said out loud, because one
               company owing another is settled on paper and must never read
               like her own cash moving between her own pots. Computed in
               helpers/pettyCash.borrowings, never stored. -->
          ${b.intercompany ? `<div style="margin-top:5px; font-size:11.5px; color:var(--status-warning, #d69e2e);">Intercompany — ${esc(b.owes_company)} owes ${esc(b.to_company)}.</div>` : ''}
          <div style="font-family:var(--font-mono); font-size:11px; color:var(--text-muted); margin-top:3px;">${esc(b.owes)} holds ${esc(fmtAmount(held(b.owes)))}</div>
        </div>
        <div style="font-family:var(--font-mono); font-size:16px; font-weight:700; color:var(--text-strong);">${esc(fmtAmount(b.amount))}</div>
        ${isAdmin ? `<button class="btn ${can ? 'btn-primary' : ''} btn-repay" data-owes="${esc(b.owes)}" data-to="${esc(b.to)}" data-amount="${esc(String(b.amount))}"
          ${can ? '' : 'disabled'} style="font-size:12px; padding:6px 14px;">Repay</button>` : ''}
      </div>
      ${can ? '' : `<div style="margin-top:8px; font-size:11.5px; color:var(--status-warning, #d69e2e);">Add cash to ${esc(b.owes)} first — you cannot repay from a bucket that is empty.</div>`}
    </div>`;
  }).join('') : `<div class="card" style="padding:18px; font-size:12.5px; color:var(--text-muted);">Nothing owed between accounts.</div>`;

  const label = { borrow: 'borrowed', repay: 'repaid', reassign: 'moved' };
  const movesHtml = moves.length ? moves.map((m) => `
    <div class="card" style="padding:12px 14px; margin-bottom:8px;">
      <div style="display:flex; justify-content:space-between; gap:10px;">
        <div style="font-size:12.5px;">${esc(m.to)} ${esc(label[m.reason] || m.reason || 'moved')} from ${esc(m.from)}</div>
        <div style="font-family:var(--font-mono); font-weight:700;">${esc(fmtAmount(m.amount))}</div>
      </div>
      <div style="font-family:var(--font-mono); font-size:11px; color:var(--text-faint); margin-top:3px;">${esc(typeof fmtDate === 'function' ? fmtDate(m.date) : (m.date || ''))}${m.note ? ' · ' + esc(m.note) : ''}</div>
    </div>`).join('')
    : `<div style="padding:34px; text-align:center; color:var(--text-faint); font-family:var(--font-mono); font-size:12px;">No cash has moved between accounts yet.</div>`;

  return `
    <div style="font-family:var(--font-mono); font-size:10px; font-weight:600; letter-spacing:.16em; text-transform:uppercase; color:var(--text-muted); margin-bottom:10px;">Outstanding</div>
    ${owedHtml}
    <div style="margin:22px 0 10px; display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
      <div style="font-family:var(--font-mono); font-size:10px; font-weight:600; letter-spacing:.16em; text-transform:uppercase; color:var(--text-muted);">Every movement</div>
      <span style="flex:1;"></span>
      ${isAdmin ? '<button id="btnSplitCash" class="btn" style="font-size:12px; padding:6px 14px;">Split EM / AAA</button>' : ''}
      ${isAdmin ? '<button id="btnReassignCash" class="btn" style="font-size:12px; padding:6px 14px;">Move cash</button>' : ''}
    </div>
    ${movesHtml}`;
}

// Repay and reassign are one server call with a different reason. The server
// refuses an impossible move; this only asks and reports.
async function movePettyCash({ from, to, amount, reason }) {
  try {
    await api('/api/petty-cash/transfer', { method: 'POST', body: JSON.stringify({ from, to, amount, reason }) });
    await renderPettyCashTab();
  } catch (err) {
    alert(err.message || 'Could not move the cash.');
  }
}

// ── SWITCHING TABS ASKS THE SERVER NOTHING ────────────────────────────────
// Apsara, 2026-09-22: "when i click cash and borrowing,it takes lot of time
// to open."
//
// Every click went through refreshPettyCash() — a GET of /api/petty-cash,
// which is 35 KB and, measured against a year of her rows, 18 ms of server
// work at 1,200 entries and 49 ms at 6,000. None of that is the problem. The
// problem is that it is a ROUND TRIP, and she is on a phone: the wait she
// sees is the network, and she pays it to redraw a screen from data the
// browser is already holding. Cash and Borrowing render from the SAME
// pettyCash object; neither needs a byte the other did not already fetch.
//
// `refresh` defaults to TRUE, so every existing caller behaves exactly as it
// did — add cash, repay, split, delete and the first open all still re-read
// the server, because each of those has just changed the money. Only the tab
// buttons pass false, and only because switching tabs changes nothing. A
// caller that forgets the flag gets today's behaviour: slower, never stale.
async function renderPettyCashTab({ refresh = true } = {}) {
  if (refresh) await refreshPettyCash();
  const isAdmin = ROLE === 'admin';
  const bal = pettyCash.balance;
  const rows = pettyCash.entries || [];

  // 'receipt' — cash taken IN for a yard sale, added 2026-09-16. Named as
  // money RECEIVED rather than folded into "Cash added": a top-up is her own
  // float going in, a receipt is a customer paying for metal, and a row that
  // cannot tell her which is which makes the day's takings unreadable.
  const kindLabel = (e) => e.kind === 'topup' ? 'Cash added'
    : e.kind === 'receipt' ? `Received${e.load_id ? ' — ' + e.load_id : ''}`
    : e.kind === 'reversal' ? 'Reversed'
    : `Paid${e.load_id ? ' — ' + e.load_id : ''}`;

  $('viewRoot').innerHTML = `
    <section style="max-width:900px; margin:0 auto; padding:28px 20px 80px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:18px; gap:12px; flex-wrap:wrap;">
        <div>
          <div class="eyebrow">// Petty cash</div>
          <h2 style="font-size:24px; text-transform:uppercase; margin-bottom:4px;">Cash reserve</h2>
          <div style="font-size:13px; color:var(--text-muted);">${isAdmin ? 'Cash paid against a load comes out of this balance.' : 'Read only — ask an admin to add cash.'}</div>
        </div>
        ${isAdmin ? '<button id="btnAddPetty" class="btn btn-primary">+ Add cash</button>' : ''}
      </div>

      <div class="card" style="padding:20px; margin-bottom:14px;">
        <div style="font-family:var(--font-mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--text-muted);">Cash in hand</div>
        <div style="font-size:32px; font-weight:800; color:${bal > 0 ? 'var(--text-strong)' : 'var(--status-warning, #d69e2e)'};">${esc(fmtAmount(bal) || '$0.00')}</div>
        <!-- ── AND EACH BANK BENEATH IT ─────────────────────────────────
             Apsara, 2026-09-21: "show overall cash .but also keep track of
             bofacash available and chase bank." The overall figure keeps its
             place and its size — it is the number she has read for weeks —
             and the buckets sit under it. They always add up to it, because
             every one is a sum of the same rows. -->
        <!-- ── WHOSE MONEY, THEN WHICH BUCKET ────────────────────────────
             Apsara, 2026-09-21: BofA became two accounts, Edge Metals' and
             AAA Investment's, and AAA Investment is "a third company". Her
             answer on the headline, of three offered: "Keep one total, break
             it down below." So the big figure above is untouched — still
             every row — and the company split comes first underneath it,
             because on a phone the first thing under the total is the thing
             that gets read. A company with nothing in it is not printed. -->
        <!-- ── WHAT THE FIRST VERSION OF THIS GOT WRONG ──────────────────
             Apsara, 2026-09-22, on the built app: "it looks ugly", and then
             "all three bofa should be in one line". She was right, and one
             of the lines was a BUG rather than a matter of taste:

             • CHASE BANK READ "NOT YET SPLIT". The label rule was "the
               account is named the same as its own bank", true of Chase Bank
               as well as of the legacy BofA bucket. That bucket is migrated
               into
               Edge Metals (2026-09-22, "for previous cash"), so no account
               is named after its bank and the special case is deleted rather
               than left standing where nothing can reach it.
             • A COMPANY BLOCK THAT REPEATED THE TOTAL. Every company has
               exactly one account today, so the company split and the
               account list were the same rows twice — and with everything
               unbanked it rendered "COMPANY NOT STATED $22,441.03" directly
               under a "CASH IN HAND $22,441.03". It is printed now only when
               a company spans MORE than one account, which is the only case
               where it says anything the accounts below do not.
             • THE THREE BofA ACCOUNTS WRAPPED. Her instruction. Equal thirds
               with min-width:0, so they stay on one line at phone width and
               the label wraps inside its own column instead.
             • "No bank behind it" ABOVE "Unassigned" was the same word said
               twice. A bank heading is printed only when it groups more than
               one account. -->
        <div style="margin-top:12px; padding-top:12px; border-top:1px solid var(--border-subtle);">
          ${(() => {
            const srcs = pettyCash.sources || [];
            const bankOf = pettyCash.bank_of || {};
            const banks = [];
            for (const s of srcs) {
              const b = bankOf[s] || null;
              let g = banks.find((x) => x.bank === b);
              if (!g) { g = { bank: b, items: [] }; banks.push(g); }
              g.items.push(s);
            }
            const cell = (src, share) => {
              const v = Number((pettyCash.by_source || {})[src]) || 0;
              const label = src;
              return `<div style="flex:${share ? '1 1 0' : '0 0 auto'}; min-width:0;">
                <div style="font-family:var(--font-mono); font-size:9px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted); line-height:1.35;">${esc(label)}</div>
                <div style="font-family:var(--font-mono); font-size:14px; font-weight:700; color:${v < 0 ? 'var(--status-danger, #c53030)' : 'var(--text-strong)'};">${esc(fmtAmount(v))}</div>
              </div>`;
            };
            return banks.map((g) => {
              // One account under a bank needs no heading above it — the
              // account's own name already says everything the heading would.
              if (g.items.length < 2) return `<div style="margin-bottom:9px;">${cell(g.items[0], false)}</div>`;
              return `
              <div style="margin-bottom:11px;">
                <div style="font-size:11px; font-weight:700; color:var(--text-strong); margin-bottom:5px;">${esc(g.bank)}</div>
                <div style="display:flex; gap:12px; align-items:flex-start;">${g.items.map((s) => cell(s, true)).join('')}</div>
              </div>`;
            }).join('');
          })()}
          ${(() => {
            // The company line, only where it adds something: a company
            // holding more than one account. Today none does, so nothing
            // prints — which is why the duplicate heading is gone.
            const per = pettyCash.by_company || {};
            const coOf = pettyCash.company_of || {};
            const spans = Object.keys(per).filter((co) => co !== pettyCash.company_unknown
              && (pettyCash.sources || []).filter((s) => coOf[s] === co).length > 1);
            if (!spans.length) return '';
            return `<div style="display:flex; gap:18px; flex-wrap:wrap; margin-top:10px; padding-top:10px; border-top:1px solid var(--border-subtle);">
              ${spans.map((co) => `<div>
                <div style="font-family:var(--font-mono); font-size:9px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted);">${esc(co)} total</div>
                <div style="font-family:var(--font-mono); font-size:14px; font-weight:700; color:var(--text-strong);">${esc(fmtAmount(Number(per[co]) || 0))}</div>
              </div>`).join('')}
            </div>`;
          })()}
        </div>
        ${bal <= 0 ? `<div style="margin-top:8px; font-size:12.5px; color:var(--status-warning, #d69e2e);">Cash payments are refused while this is empty. Add cash before paying a load in cash.</div>` : ''}
      </div>

      <!-- Her words: "Keep this borrowing tracking in petty cash as a tab
           inside petty cash." -->
      <div style="display:flex; gap:6px; margin-bottom:16px;">
        <button class="btn petty-tab" data-petty-tab="cash" style="font-size:12px; padding:6px 14px;${pettyTab === 'cash' ? ' background:var(--surface-raised); color:var(--text-strong);' : ''}">Cash</button>
        <button class="btn petty-tab" data-petty-tab="borrowing" style="font-size:12px; padding:6px 14px;${pettyTab === 'borrowing' ? ' background:var(--surface-raised); color:var(--text-strong);' : ''}">Borrowing${(pettyCash.borrowings || []).length ? ` (${(pettyCash.borrowings || []).length})` : ''}</button>
      </div>
      ${pettyTab === 'borrowing' ? pettyBorrowingHtml(isAdmin) : `

      ${rows.length ? `
      <div class="card" style="padding:0; overflow:hidden;">
        <table class="stack-table" style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead><tr style="background:var(--surface-sunken); text-align:left;">
            <th style="padding:10px 12px; font-family:var(--font-mono); font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted);">Date</th>
            <th style="padding:10px 12px; font-family:var(--font-mono); font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted);">What</th>
            <th style="padding:10px 12px; text-align:right; font-family:var(--font-mono); font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted);">Amount</th>
            ${isAdmin ? '<th style="padding:10px 12px;"></th>' : ''}
          </tr></thead>
          <tbody>
            ${rows.map(e => `
            <tr style="border-top:1px solid var(--border-subtle);">
              <td data-label="Date" style="padding:10px 12px; font-family:var(--font-mono); color:var(--text-muted);">${esc(typeof fmtDate === 'function' ? fmtDate(e.date) : (e.date || ''))}</td>
              <td class="st-head" style="padding:10px 12px;">${esc(kindLabel(e))}${e.note ? ` <span style="color:var(--text-faint);">— ${esc(e.note)}</span>` : ''}</td>
              <td data-label="Amount" style="padding:10px 12px; text-align:right; font-family:var(--font-mono); font-weight:700; color:${Number(e.amount) < 0 ? 'var(--status-danger, #c53030)' : 'var(--leaf-600, #2e7d32)'};">${Number(e.amount) < 0 ? '-' : '+'}${esc(fmtAmount(Math.abs(Number(e.amount) || 0)))}</td>
              ${isAdmin ? `<td style="padding:10px 12px; text-align:right;">${e.kind === 'topup' ? `<button class="btn btn-danger btn-del-petty" data-id="${esc(e.id)}" style="font-size:11px; padding:4px 9px;">Delete</button>` : ''}</td>` : ''}
            </tr>`).join('')}
          </tbody>
        </table>
      </div>` : `<div style="padding:50px; text-align:center; color:var(--text-faint); font-family:var(--font-mono); font-size:12px;">Nothing recorded yet.</div>`}`}
    </section>`;

  document.querySelectorAll('.petty-tab').forEach((b) => b.addEventListener('click', () => {
    pettyTab = b.dataset.pettyTab; renderPettyCashTab({ refresh: false });
  }));

  if (isAdmin) {
    const add = $('btnAddPetty');
    if (add) add.addEventListener('click', async () => {
      const amount = prompt('How much cash is going into the box?');
      if (amount === null) return;
      const n = Number(String(amount).replace(/[^0-9.\-]/g, ''));
      if (!isFinite(n) || n <= 0) { alert('Enter an amount greater than zero.'); return; }
      // ── WHICH BANK IT CAME OUT OF ─────────────────────────────────────
      // Apsara, 2026-09-21: "when adding cash ,ask its from BofA or chase
      // bank". Unassigned is deliberately NOT offered here: a top-up is by
      // definition money drawn from an account; if it had no bank behind it,
      // it is not a top-up. The SERVER accepts blank, so an older build of
      // this app can still add cash — it just lands in Unassigned.
      // FALLBACK ONLY — mirrors helpers/pettyCash.SOURCES, and
      // tests/petty-cash-banks.js asserts they are identical. A stale copy
      // here would offer 'BofA' as though it were still the only BofA
      // account, and Edge Metals' cash would land in the unsplit bucket.
      const banks = (pettyCash.sources && pettyCash.sources.length ? pettyCash.sources
        : ['Edge Metals', 'AAA Investment', 'Chase Bank', 'Unassigned'])
        .filter((x) => x !== 'Unassigned');
      // The range is computed, not written out. It named two accounts back
      // when there were two, and a prompt stating a range it no longer has is
      // how a wrong account gets picked in a hurry.
      const pick = prompt(`Which bank did this ${fmtAmount(n)} come out of?\n\n`
        + banks.map((b, i) => `${i + 1}. ${b}`).join('\n')
        + `\n\nType 1${banks.length > 1 ? `–${banks.length}` : ''}.`);
      if (pick === null) return;
      const chosen = banks[Number(String(pick).trim()) - 1]
        || banks.find((b) => b.toLowerCase() === String(pick).trim().toLowerCase());
      if (!chosen) { alert('Pick one of: ' + banks.join(', ')); return; }
      try {
        await api('/api/petty-cash', { method: 'POST', body: JSON.stringify({ amount: n, cash_source: chosen }) });
        await renderPettyCashTab();
      } catch (err) { alert('Could not add cash: ' + err.message); }
    });

    // Repay — pre-filled with what is owed, and she can settle part of it.
    // The server refuses anything the bucket cannot cover.
    document.querySelectorAll('.btn-repay').forEach((b) => b.addEventListener('click', async () => {
      const owed = Number(b.dataset.amount) || 0;
      const raw = prompt(`How much should ${b.dataset.owes} repay ${b.dataset.to}?`, String(owed));
      if (raw === null) return;
      const amt = Number(String(raw).replace(/[^0-9.\-]/g, ''));
      if (!isFinite(amt) || amt <= 0) { alert('Enter an amount greater than zero.'); return; }
      await movePettyCash({ from: b.dataset.owes, to: b.dataset.to, amount: amt, reason: 'repay' });
    }));

    // Apsara, 2026-09-22: "now add a split as edge metals/aaa". The reassign
    // below with both ends already chosen — the move she will make over and
    // over once the migration puts every previous BofA note under Edge
    // Metals. Same route, same 'reassign' reason, so it inherits the
    // short-bucket refusal and the dated row pair rather than re-doing them.
    const SPLIT_FROM = 'Edge Metals', SPLIT_TO = 'AAA Investment';
    const split = $('btnSplitCash');
    if (split) split.addEventListener('click', async () => {
      const held = Number((pettyCash.by_source || {})[SPLIT_FROM]) || 0;
      const raw = prompt(`How much of ${SPLIT_FROM}'s cash belongs to ${SPLIT_TO}?\n\n`
        + `${SPLIT_FROM} holds ${fmtAmount(held)}.`);
      if (raw === null) return;
      const amt = Number(String(raw).replace(/[^0-9.\-]/g, ''));
      if (!isFinite(amt) || amt <= 0) { alert('Enter an amount greater than zero.'); return; }
      if (!confirm(`Move ${fmtAmount(amt)} from ${SPLIT_FROM} to ${SPLIT_TO}?\n\nTwo different companies — this changes whose money it is.`)) return;
      await movePettyCash({ from: SPLIT_FROM, to: SPLIT_TO, amount: amt, reason: 'reassign' });
    });

    const reassign = $('btnReassignCash');
    if (reassign) reassign.addEventListener('click', async () => {
      const all = (pettyCash.sources && pettyCash.sources.length) ? pettyCash.sources
        : ['Edge Metals', 'AAA Investment', 'Chase Bank', 'Unassigned'];
      const from = prompt('Move cash OUT of which account?\n\n' + all.map((b, i) => `${i + 1}. ${b}`).join('\n'));
      if (from === null) return;
      const src = all[Number(String(from).trim()) - 1] || all.find((b) => b.toLowerCase() === String(from).trim().toLowerCase());
      if (!src) { alert('Pick one of: ' + all.join(', ')); return; }
      const rest = all.filter((b) => b !== src);
      const to = prompt('And INTO which?\n\n' + rest.map((b, i) => `${i + 1}. ${b}`).join('\n'));
      if (to === null) return;
      const dst = rest[Number(String(to).trim()) - 1] || rest.find((b) => b.toLowerCase() === String(to).trim().toLowerCase());
      if (!dst) { alert('Pick one of: ' + rest.join(', ')); return; }
      const raw = prompt(`How much moves from ${src} to ${dst}?`);
      if (raw === null) return;
      const amt = Number(String(raw).replace(/[^0-9.\-]/g, ''));
      if (!isFinite(amt) || amt <= 0) { alert('Enter an amount greater than zero.'); return; }
      await movePettyCash({ from: src, to: dst, amount: amt, reason: 'reassign' });
    });
    // Only top-ups carry this button (see the row markup). A withdrawal is
    // undone by deleting the PAYMENT, which reverses it properly — the server
    // refuses it here too, so this is not the only thing holding that rule.
    document.querySelectorAll('.btn-del-petty').forEach(btn => btn.addEventListener('click', async () => {
      if (!confirm('Delete this cash entry? The balance will drop by that amount.')) return;
      try {
        await api('/api/petty-cash/' + encodeURIComponent(btn.dataset.id), { method: 'DELETE' });
        await renderPettyCashTab();
      } catch (err) { alert('Could not delete: ' + err.message); }
    }));
  }
}

async function renderExpensesTab() {
  const data = await api('/api/expenses');
  expenseCategories = data.categories || [];
  expenseMethods = data.methods || [];
  expenseDefaultMethod = data.default_method || '';
  expenseRetiredMethods = Array.isArray(data.retired_methods) ? data.retired_methods : null;
  pettyCash.balance = Number(data.petty_cash_balance) || pettyCash.balance;
  const expenses = data.expenses || [];
  const report = data.report || { total: 0, count: 0, byCategory: [], byDay: [] };
  const today = todayLocalDateStrForExpense();
  const todayTotal = (report.byDay.find(d => d.date === today) || {}).amount || 0;

  // Grouped by date, newest first — mirrors how the Loads deck groups by
  // day, so both tabs read the same way.
  const byDate = new Map();
  for (const e of expenses) {
    const k = e.date || 'No date';
    if (!byDate.has(k)) byDate.set(k, []);
    byDate.get(k).push(e);
  }
  const dates = Array.from(byDate.keys()).sort((a, b) => (a < b ? 1 : -1));

  $('viewRoot').innerHTML = `
    <section style="max-width:1000px; margin:0 auto; padding:28px 20px 80px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:18px; gap:12px; flex-wrap:wrap;">
        <div>
          <div class="eyebrow">// Expenses</div>
          <h2 style="font-size:24px; text-transform:uppercase; margin-bottom:4px;">Expense tracker</h2>
          <div style="font-size:13px; color:var(--text-muted);">Admin only. Syncs to the Expenses Google Sheet automatically.</div>
        </div>
        <button id="btnAddExpense" class="btn btn-primary">+ Add expense</button>
      </div>
      <div class="card" style="padding:16px 18px; margin-bottom:18px; display:flex; gap:24px; flex-wrap:wrap;">
        <div><div style="font-family:var(--font-mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--text-muted);">Today</div><div style="font-size:20px; font-weight:800; color:var(--text-strong);">$${esc(todayTotal)}</div></div>
        <div><div style="font-family:var(--font-mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--text-muted);">All-time</div><div style="font-size:20px; font-weight:800; color:var(--text-strong);">$${esc(report.total)}</div></div>
        <div><div style="font-family:var(--font-mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--text-muted);">Entries</div><div style="font-size:20px; font-weight:800; color:var(--text-strong);">${esc(report.count)}</div></div>
      </div>
      ${dates.length ? dates.map(date => {
        const rows = byDate.get(date);
        const dayTotal = rows.reduce((s, e) => s + (e.amount || 0), 0);
        return `
        <div style="margin-bottom:20px;">
          <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px;">
            <div style="font-family:var(--font-mono); font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--text-muted);">${esc(date)}</div>
            <div style="font-family:var(--font-mono); font-size:12px; color:var(--text-strong); font-weight:700;">$${esc(Math.round(dayTotal * 100) / 100)}</div>
          </div>
          ${rows.map(e => `
            <div class="card" style="padding:12px 14px; margin-bottom:8px;">
              <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
                <div style="min-width:0;">
                  <div style="font-size:13.5px; font-weight:700; color:var(--text-strong);">${esc(e.description || '')}</div>
                  <div style="font-family:var(--font-mono); font-size:10.5px; color:var(--text-muted); margin-top:3px;">${esc(e.id)} · ${esc(e.category || 'Other')}${e.vendor ? ' · ' + esc(e.vendor) : ''}${e.payment_method ? ' · ' + esc(e.payment_method) : ''}</div>
                </div>
                <div style="font-size:15px; font-weight:800; color:var(--text-strong); white-space:nowrap;">$${esc(e.amount)}</div>
              </div>
              <div style="margin-top:10px; display:flex; gap:8px; border-top:1px solid var(--border-subtle); padding-top:9px;">
                <button class="btn btn-edit-expense" data-id="${esc(e.id)}" style="font-size:11px; padding:5px 10px;">Edit</button>
                <button class="btn btn-danger btn-delete-expense" data-id="${esc(e.id)}" style="font-size:11px; padding:5px 10px;">Delete</button>
              </div>
            </div>`).join('')}
        </div>`;
      }).join('') : '<div style="padding:50px; text-align:center; color:var(--text-faint); font-family:var(--font-mono); font-size:12.5px;">No expenses recorded yet.</div>'}
    </section>`;

  $('btnAddExpense').addEventListener('click', () => openExpenseModal(null));
  document.querySelectorAll('.btn-edit-expense').forEach(b => b.addEventListener('click', () => {
    openExpenseModal(expenses.find(x => x.id === b.dataset.id) || null);
  }));
  document.querySelectorAll('.btn-delete-expense').forEach(b => b.addEventListener('click', async () => {
    if (!await askYesNo(`Delete expense ${b.dataset.id}?`)) return;
    b.disabled = true; b.textContent = 'Deleting…';
    try { await api(`/api/expenses/${encodeURIComponent(b.dataset.id)}`, { method: 'DELETE' }); await renderExpensesTab(); }
    catch (err) { alert('Delete failed: ' + err.message); b.disabled = false; b.textContent = 'Delete'; }
  }));
}

function openExpenseModal(expense) {
  editingExpenseId = expense ? expense.id : null;
  $('expTitle').textContent = expense ? `Edit ${expense.id}` : 'Add expense';
  $('exp_date').value = toUsDate(expense ? (expense.date || '') : todayLocalDateStrForExpense());
  wireUsDateField('exp_date');
  $('exp_category').innerHTML = expenseCategories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if (expense && expense.category) {
    // A category typed before this list existed (or edited on the sheet)
    // must not silently switch to something else just because it isn't in
    // the current picker — add it as an option so the value round-trips.
    if (!expenseCategories.includes(expense.category)) {
      $('exp_category').insertAdjacentHTML('afterbegin', `<option value="${esc(expense.category)}">${esc(expense.category)}</option>`);
    }
    $('exp_category').value = expense.category;
  }
  $('exp_description').value = expense ? (expense.description || '') : '';
  $('exp_vendor').value = expense ? (expense.vendor || '') : '';
  // Options are built from the SERVER's list (see renderExpensesTab), so the
  // dropdown cannot offer something the server would reject.
  const sel = $('exp_payment');
  // Cheque and Other were removed on 2026-09-02 ("remove other, cheque in paid
  // by"); Zelle and Wire on 2026-09-03 ("paid by should be cash/card"). They
  // are RETIRED, not forbidden: an expense already recorded with one keeps it
  // as an option so that editing the description does not silently erase how
  // it was paid. It is marked, and it is never offered to anything else.
  //
  // Only a value the server would still ACCEPT is offered back. Until
  // 2026-09-03 this offered back anything non-empty, which meant legacy free
  // text ("cash app", typed before the field was a dropdown) appeared as a
  // selectable option and then saved as null, because normalizeMethod rejects
  // it — an option that silently does not take. Her rule for those was "leave
  // old entries blank", and blank is now what they get.
  //
  // expenseRetiredMethods === null means the server did not send the list at
  // all (an app pointed at a VM that has not been updated yet). There the old
  // behaviour is kept deliberately: offering a stored Zelle back is right, and
  // the alternative — treating every stored value as unknown — would blank a
  // real method and erase it on save. The narrower rule needs the server's
  // list to be safe, so it waits for it.
  const acceptable = expenseRetiredMethods
    ? (expenseMethods || []).concat(expenseRetiredMethods)
    : null;
  const retired = expense && expense.payment_method
    && !(expenseMethods || []).includes(expense.payment_method)
    && (!acceptable || acceptable.includes(expense.payment_method))
    ? expense.payment_method : null;
  sel.innerHTML = ['<option value="">— not recorded —</option>']
    .concat((expenseMethods || []).map(m => `<option value="${esc(m)}">${esc(m)}</option>`))
    .concat(retired ? [`<option value="${esc(retired)}">${esc(retired)} (no longer offered)</option>`] : [])
    .join('');
  // A legacy free-text value matches no option, so the box shows "not
  // recorded" — her choice ("leave old entries blank"). The stored string is
  // untouched on the record until she actually saves a new choice, so nothing
  // is destroyed by merely opening the form.
  //
  // NEW expense: pre-selected to the server's default, Cash (2026-09-03, "by
  // default it should be cash"). EXISTING expense: whatever it already says,
  // and blank if that is nothing. The default deliberately does NOT reach the
  // edit path — an old expense with no recorded method would come up reading
  // "Cash", and saving would both rewrite it and withdraw from petty cash for
  // money that may never have come out of the box.
  sel.value = expense
    ? (((expenseMethods || []).includes(expense.payment_method) || retired === expense.payment_method)
        ? expense.payment_method : '')
    : (expenseDefaultMethod || '');
  $('exp_amount').value = expense ? (expense.amount ?? '') : '';
  $('expErr').textContent = '';
  $('expenseModal').classList.remove('hidden');
  $('expenseModal').style.display = 'flex';
}

// ── "IS THIS FOR SANTIAGO?" ──────────────────────────────────────────────
// Apsara, 2026-09-15: "it should read the description and ask user whether
// they mean salary for santiago".
//
// ON BLUR, NOT ON SAVE. Asking at save time would put a network call in front
// of the Save button, and a suggestion service having a slow day would then
// feel like the form being slow. By the time she reaches Save the question is
// already on screen, or it never arrived and nothing is different.
//
// Fires only when the vendor box is EMPTY — if she typed one, second-guessing
// it is worse than useless — and the answer is hers. Nothing is filled in
// until she says yes.
let vendorAskedFor = '';
function wireVendorSuggest() {
  const desc = $('exp_description');
  const box = $('expVendorAsk');
  if (!desc || !box) return;
  const hide = () => { box.style.display = 'none'; box.innerHTML = ''; };
  hide();

  // One question at a time. When a line answers both — a name AND a category
  // that disagrees with the box — the vendor is asked first and the category
  // follows once she has answered, rather than stacking two prompts on a form
  // she is halfway through.
  function askQuestion(r, onDone) {
    if (!r || !r.suggest) { hide(); if (onDone) onDone(); return; }
    const opts = r.ambiguous && r.ambiguous.length >= 2
      // AMBIGUOUS: her own example. "Salary paid $200 for tools" argues for
      // Labour AND for Equipment, and only she knows which. Both are offered
      // by name; neither is preselected.
      ? r.ambiguous.slice(0, 2).map((c, i) => `<button type="button" class="btn expAskOpt" data-cat="${esc(c)}" style="font-size:11px; padding:4px 10px; margin-left:${i ? 6 : 8}px;">${esc(c)}</button>`).join('')
      : `<button type="button" class="btn expAskYes" style="font-size:11px; padding:4px 10px; margin-left:8px;">${r.kind === 'category' ? 'Change' : 'Yes'}</button>`;
    box.innerHTML = `<span style="color:var(--text-muted);">${esc(r.question)}</span>${opts}
      <button type="button" class="btn expAskNo" style="font-size:11px; padding:4px 10px;">${r.ambiguous ? 'Leave it' : (r.kind === 'category' ? 'Keep' : 'No')}</button>`;
    box.style.display = 'block';
    const done = () => { hide(); if (onDone) onDone(); };
    // ── SETTING A <select> TO A MISSING OPTION DOES NOTHING ───────────────
    // Silently. She clicks "Equipment", the box does not change, and there is
    // nothing on screen to say why. openExpenseModal already guards this for
    // an expense's own stored category; accepting a suggestion needs the same
    // guard. In production the suggestion can only offer a category from the
    // server's list, which is also what builds this dropdown — so this should
    // be unreachable, and that is exactly the kind of "should" that is worth
    // four lines rather than a silent no-op.
    const setCategory = (c) => {
      const sel = $('exp_category');
      if (!sel) return;
      if (![...sel.options].some((o) => o.value === c)) {
        sel.insertAdjacentHTML('afterbegin', `<option value="${esc(c)}">${esc(c)}</option>`);
      }
      sel.value = c;
    };
    box.querySelectorAll('.expAskOpt').forEach((b2) => b2.addEventListener('click', () => {
      setCategory(b2.dataset.cat); done();
    }));
    const yes = box.querySelector('.expAskYes');
    if (yes) yes.addEventListener('click', () => {
      if (r.kind === 'category') setCategory(r.category);
      else $('exp_vendor').value = r.vendor;
      done();
    });
    box.querySelector('.expAskNo').addEventListener('click', done);
  }

  desc.addEventListener('blur', async () => {
    const text = desc.value.trim();
    // Asked about this exact line already — including when she said no.
    // Re-asking the same question is how a helpful prompt becomes a nag.
    if (!text || text === vendorAskedFor) return;
    if ($('exp_vendor').value.trim()) { hide(); return; }
    vendorAskedFor = text;
    let r = null;
    try {
      r = await api('/api/expenses/suggest-vendor', {
        method: 'POST',
        body: JSON.stringify({ description: text, vendor: $('exp_vendor').value, category: $('exp_category').value }),
      });
    } catch (e) { hide(); return; }          // never let this surface as an error
    if (!r || !r.suggest) { hide(); return; }
    // No is remembered for this line by vendorAskedFor above, so it does not
    // come straight back when she tabs away again.
    askQuestion(r, () => {
      // A vendor answer can carry a category disagreement with it. Asked
      // second, so she is never looking at two prompts at once.
      if (r.kind === 'vendor' && r.category_hint) {
        askQuestion({ suggest: true, kind: 'category', ...r.category_hint });
      }
    });
  });
}

function closeExpenseModal() {
  $('expenseModal').classList.add('hidden');
  $('expenseModal').style.display = '';
  editingExpenseId = null;
}
function wireExpenseModal() {
  wireVendorSuggest();
  $('expClose').addEventListener('click', closeExpenseModal);
  $('expSave').addEventListener('click', async () => {
    const payload = {
      date: toIsoDate($('exp_date').value),
      category: $('exp_category').value,
      description: $('exp_description').value.trim(),
      vendor: $('exp_vendor').value.trim() || null,
      payment_method: $('exp_payment').value || null,
      amount: $('exp_amount').value,
    };
    const btn = $('expSave');
    btn.disabled = true; btn.textContent = 'Saving…';
    $('expErr').textContent = '';
    try {
      const saved = editingExpenseId
        ? await api(`/api/expenses/${encodeURIComponent(editingExpenseId)}`, { method: 'PUT', body: JSON.stringify(payload) })
        : await api('/api/expenses', { method: 'POST', body: JSON.stringify(payload) });
      closeExpenseModal();
      await renderExpensesTab();
      // ── the box did not cover it ────────────────────────────────────────
      // Apsara 2026-09-02: "If expense is more but petty cash is less, notify
      // user."
      //
      // AFTER saving, not before — unlike the load-payment prompt. An expense
      // is a receipt for money already spent, so there is no decision to
      // interrupt: refusing or asking would not un-spend it. What is needed is
      // for the resulting negative balance to be explained at the moment it
      // happens, rather than discovered on the Petty cash tab next week.
      const short = saved && saved.expense && Number(saved.expense.cash_shortfall) > 0;
      if (short) {
        const sf = Number(saved.expense.cash_shortfall);
        alert(`Recorded — but petty cash was ${fmtAmount(sf)} short of this.\n\n`
            + `The cash box now shows a negative balance, which means cash left the drawer that was never entered here. `
            + `Add that cash on the Petty cash tab to bring it back in line.`);
      }
    } catch (err) {
      // Server validation messages are prefixed "Validation:" — strip it,
      // the user doesn't need our internal label.
      $('expErr').textContent = String(err.message || '').replace(/^Validation:\s*/, '');
    } finally {
      btn.disabled = false; btn.textContent = 'Save expense';
    }
  });
}

// Can this tab be painted from cache alone, with no network call and no
// chance of a miss part-way through? Only if we have seen it render before and
// every path it used is still cached.
function canFastPaint(tab) {
  const deps = tabDeps.get(tab);
  if (!deps || deps.size === 0) return false;      // never rendered yet
  for (const p of deps) if (apiCachePeek(p) === undefined) return false;
  return true;
}

// Paints the tab from cache when that is possible, then falls through to the
// ordinary render, which fetches and repaints. A tab that cannot be fast
// painted is not an error — it is just the ordinary path, and nothing is
// shown to say so.
async function fastPaintCurrentMobileTab() {
  if (!canFastPaint(currentMobileTab)) return false;
  API_PREFER_CACHE = true;
  try { await paintCurrentMobileTab(); return true; }
  catch (e) { return false; }
  finally { API_PREFER_CACHE = false; }
}

async function renderCurrentMobileTab() {
  // Cached view first, so the screen is never blank while the network works.
  // Deliberately NOT skipping the fetch afterwards: this shows you the last
  // thing you saw, it does not decide that it is still true.
  await fastPaintCurrentMobileTab();

  // The real render, recording what it fetched so the NEXT visit knows what
  // this tab needs. Recorded fresh each time rather than accumulated: a tab
  // whose paths change with a filter (the spend report carries its dates in
  // the query string) must not keep asking for a window nobody is looking at.
  const tab = currentMobileTab;
  const seen = new Set();
  API_RECORD = seen;
  try {
    return await paintCurrentMobileTab();
  } finally {
    API_RECORD = null;
    // Recorded even when the render failed part way, and that is safe rather
    // than sloppy: a failed GET is never cached, so canFastPaint will find the
    // missing entry and decline. The dependency list says which paths a tab
    // uses; the cache says whether they are there. Two questions, kept apart.
    if (seen.size) tabDeps.set(tab, seen);
  }
}

async function paintCurrentMobileTab() {
  try {
    if (currentMobileTab === 'loads') {
      // Purchases and sales in one deck, per Apsara 2026-08-24 — a sale saved
      // into a list she can't see would be a sale she can't delete, and
      // deletion is what rolls the inventory back. Tagged with _kind so the
      // card, the edit handler and the delete handler each know which store
      // the record actually lives in.
      const [inbound, sales, drafts] = await Promise.all([
        api('/api/loads'),
        api('/api/outbound-loads').catch(() => []),
        // Fetched alongside rather than merged INTO the deck: a draft is not a
        // load, must not appear in any total, and gets its own strip.
        api('/api/load-drafts').catch(() => []),
      ]);
      pendingDrafts = asArray(drafts);
      const merged = [
        ...asArray(inbound).map(l => ({ ...l, _kind: 'purchase' })),
        // asArray: the endpoint returns a bare array, but a non-array here
        // must never blank the whole Loads list again. `|| []` did not
        // protect this — an OBJECT is truthy, so it passed the guard and
        // then died on .map.
        ...asArray(sales).map(l => ({ ...l, _kind: 'sale', seller: l.buyer, seller_address: l.buyer_address })),
      ].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
      renderLoads(merged);
      return;
    }
    if (currentMobileTab === 'inventory') { await renderInventoryTab(); return; }
    if (currentMobileTab === 'petty') { await renderPettyCashTab(); return; }
    if (currentMobileTab === 'trucker') { await renderTruckerTab(); return; }
    if (currentMobileTab === 'report') { await renderReportsMenu(); return; }
    if (currentMobileTab === 'expenses') { await renderExpensesTab(); return; }
    if (currentMobileTab === 'documents') { await renderDocumentsTab(); return; }
  } catch (err) {
    // api() already routes a 401 to the login screen; anything else
    // (network error, 500, etc.) surfaces here instead of a blank screen.
    if (err.message !== 'unauthorized') {
      $('viewRoot').innerHTML = '<div style="padding:60px; text-align:center; color:var(--status-danger); font-family:var(--font-mono); font-size:12px;">' + esc(err.message) + '</div>';
    }
  }
}

// Sub-tabs — mirrors dashboard/index.html, see its comment (Apsara
// 2026-08-15). "Summary" sub-tab removed same day per Apsara ("remove
// summary tab in inventory").
const INV_SUBTABS = [
  { id: 'byType',  label: 'Item type' },
  { id: 'byDay',   label: 'Per day' },
  { id: 'bySeller', label: 'Per seller' },
];
let mobInvFrom = '', mobInvTo = '', mobInvSubTab = 'byType';

function mobInvByTypeHtml(data) {
  // ON HAND leads when it's available (2026-08-24, Apsara: "when this outbound
  // gets updated — inventory should also get decreased na?"). It's absent
  // whenever a date filter is on, because "bought this week minus shipped
  // ever" is not a real number — see getInventoryReport. In that case this
  // falls back to showing what came in, which is the honest answer to a
  // date-ranged question.
  const oh = data.onHandAvailable;
  return data.byType.length ? `
    ${oh ? '' : '<div style="font-family:var(--font-mono); font-size:10px; color:var(--text-faint); padding-bottom:7px;">Showing what came IN for this range — clear the dates to see what\'s on hand.</div>'}
    ${data.byType.map(g => `
    <div style="padding:9px 0; border-bottom:1px solid var(--border-subtle);">
      <div class="inv-type-row" data-inv-toggle="${esc(g.description)}" style="display:flex; justify-content:space-between; font-size:13px; cursor:pointer;">
        <span style="color:var(--accent);">▸ ${esc(g.description)}</span>
        <span style="font-family:var(--font-mono); font-size:12px; color:${oh && g.onHand < 0 ? 'var(--status-danger)' : 'var(--text-strong)'};">${oh ? `${g.onHand} ${esc(data.unit)}` : `${g.net} ${esc(data.unit)}`}</span>
      </div>
      ${oh ? `<div style="display:flex; justify-content:space-between; font-family:var(--font-mono); font-size:10.5px; color:var(--text-faint); margin-top:3px;">
        <span>${g.count} item${g.count === 1 ? '' : 's'} in${g.shipped ? ` · ${g.shipped} shipped` : ''}</span>
        <span>${g.net} bought</span>
      </div>` : `<div style="font-family:var(--font-mono); font-size:10.5px; color:var(--text-faint); margin-top:3px;">${g.count} item${g.count === 1 ? '' : 's'}</div>`}
      ${oh && g.onHand < 0 ? '<div style="font-size:10.5px; color:var(--status-danger); margin-top:3px;">More shipped than recorded as bought — a load may be missing.</div>' : ''}
      <!-- The lines behind this row, per Apsara 2026-09-02. -->
      <div data-inv-lines="${esc(g.description)}" style="display:none; margin-top:8px;"></div>
    </div>`).join('')}` : `<div style="padding:14px 0; color:var(--text-muted); font-size:13px;">No items in this range.</div>`;
}
function mobInvByDayHtml(data) {
  return data.byDay.length ? data.byDay.map(d => `
    <div style="display:flex; justify-content:space-between; padding:9px 0; border-bottom:1px solid var(--border-subtle); font-size:13px;">
      <span style="color:var(--text-strong);">${esc(d.date)}</span>
      <span style="color:var(--text-muted); font-family:var(--font-mono); font-size:12px;">${d.loadCount} load${d.loadCount === 1 ? '' : 's'} · $${d.amount}</span>
    </div>`).join('') : `<div style="padding:14px 0; color:var(--text-muted); font-size:13px;">No loads in this range.</div>`;
}
function mobInvBySellerHtml(data) {
  return data.bySeller.length ? data.bySeller.map(s => `
    <details style="border-bottom:1px solid var(--border-subtle); padding:9px 0;">
      <summary style="cursor:pointer; list-style:none; display:flex; justify-content:space-between; font-size:13px;">
        <span style="color:var(--text-strong);">${esc(s.seller)}</span>
        <span style="color:var(--text-muted); font-family:var(--font-mono); font-size:12px;">${s.loadCount} load${s.loadCount === 1 ? '' : 's'} · ${s.net} ${esc(data.unit)}</span>
      </summary>
      <div style="padding:8px 0 0 8px;">
        ${s.byType.map(g => `
          <div style="display:flex; justify-content:space-between; padding:5px 0; font-size:12px;">
            <span style="color:var(--text-muted);">${esc(g.description)}</span>
            <span style="color:var(--text-faint); font-family:var(--font-mono);">${g.count} · ${g.net} ${esc(data.unit)} · ${g.amount != null ? fmtAmount(g.amount) : '—'}</span>
          </div>`).join('')}
        <!-- The loads behind those totals, per Apsara 2026-08-24: "when i
             click it, it should open my load ticket". A seller row was a
             dead end before — it told you Ramesh brought 7,110 lb and gave
             you no way to see which tickets that was. -->
        ${(s.loads || []).length ? `
          <div style="margin-top:9px; padding-top:8px; border-top:1px dashed var(--border-subtle);">
            <div style="font-family:var(--font-mono); font-size:9.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-faint); margin-bottom:5px;">Load tickets</div>
            ${s.loads.map(l => l.pdf_link
              ? `<a href="${esc(l.pdf_link)}" target="_blank" rel="noopener" style="display:flex; justify-content:space-between; padding:6px 0; font-size:12px; text-decoration:none; border-bottom:1px solid var(--border-subtle);">
                   <span style="color:var(--accent);">${esc(l.id)} →</span>
                   <span style="color:var(--text-faint); font-family:var(--font-mono);">${esc(l.date || '')}${l.amount != null ? ' · ' + fmtAmount(l.amount) : ''}</span>
                 </a>`
              : `<div style="display:flex; justify-content:space-between; padding:6px 0; font-size:12px; border-bottom:1px solid var(--border-subtle);">
                   <span style="color:var(--text-muted);">${esc(l.id)}</span>
                   <span style="color:var(--text-faint); font-family:var(--font-mono);">${esc(l.date || '')}${l.amount != null ? ' · ' + fmtAmount(l.amount) : ''} · no PDF yet</span>
                 </div>`).join('')}
          </div>` : ''}
      </div>
    </details>`).join('') : `<div style="padding:14px 0; color:var(--text-muted); font-size:13px;">No sellers in this range.</div>`;
}
const MOB_INV_SUBTAB_RENDER = { byType: mobInvByTypeHtml, byDay: mobInvByDayHtml, bySeller: mobInvBySellerHtml };

