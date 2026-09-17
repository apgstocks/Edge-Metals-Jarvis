# Working rules for this repo

## 1. Do not change existing behaviour unless Apsara says so

This is the rule. Everything else on this page is a consequence of it.

A request about one screen applies **to that screen only**. If the same code
also serves somewhere else, that somewhere else does not change — ask first.

Two over-reaches in one week, both of them live before she caught them:

- **2026-09-16.** "in packing list i juxt want gross,tare,net" was about the
  packing list TAB. It was applied to the shared invoice template, and her
  invoice's packing list lost four columns — the truck / container tare /
  chassis / boxes breakdown her broker has always received. A comment was
  written claiming both documents "change together, deliberately", which
  filed a decision under her name. That is the worst way to record one,
  because the next person to read it treats it as settled.

- **2026-09-16.** "in receive payment-i should have only cash and bank
  transfer" was about receiving money on a SALE. It was applied to every yard
  load kind, so paying a supplier lost Zelle, Wire and Cheque. Worse, the pay
  modal selected 'Zelle' as its default and a `<select>` set to a value not in
  its list silently becomes `""` — so a dropdown she never touched posted an
  empty mode and the save failed outright.

- **2026-09-17.** "on selecting wire-it should ask me Payment via Edge Yard/Edge
  Metals" was about the pay modal. The requirement went into `addPayment`,
  which every path shares — and `helpers/tools.js`'s `record_payment`, which is
  how she records a payment by TALKING to Jarvis, had no box for the answer. So
  it called `addPayment` without one and the helper threw: "record a wire
  payment of $12,000 against load X" failed outright, and she pays suppliers by
  wire. Found a day later, by a test fixture that pays the way she really does.

The third one is the same mistake as the first two, which is the point of
writing them down. The tell is always identical: a rule that makes sense on one
screen lands in code that other callers reach, and the caller that cannot
satisfy it is the one nobody was looking at.

### What that means in practice

- **When a message names a screen, change that screen.** Shared code gets a
  flag, and the flag says "this one is the new shape" — never "this one is the
  old shape". A flag that must be set to keep an existing document unchanged
  will eventually not be set. That is exactly how the invoice lost its columns.
- **Ask when the blast radius is wider than the request.** One short question
  costs less than a customer-facing document going out wrong.
- **Before adding a requirement to shared code, list its callers and check each
  one can satisfy it.** `grep` for the function, open every hit. A new required
  field is a promise that every caller can supply it; a caller that cannot is a
  break you have just written and will not see until someone uses that path.
  Twice now that caller has been the voice/assistant path, because it is the
  one without a form to put a field on.
- **Widening scope needs her yes**, even when the wider version is obviously
  more consistent. Consistency is not the goal; her paperwork working is.
- **Never write a decision of yours into a comment as if it were hers.** If it
  was your call, the comment says so.

## 2. Run the whole suite, not the files you remember

`npm test` runs 112 files. Running fifteen by name is how the supplier-payment
break survived a day: `tests/jarvis-profile.js` had been CRASHING on it since
the hour it landed — its fixture pays suppliers by Zelle and Wire, because that
is what she actually does — and nobody was listening.

`npm run test:full` adds the mutation pass.

Two failure shapes this suite has produced more than once:

- A file that prints "36 passed, 0 failed" and **exits 1**. `boot()` is async,
  resumes as a microtask after the window is gone, and its first `$()` throws.
  Stub `window.fetch = () => new Promise(() => {})` to hold it at its first
  await.
- A check shaped like the old code rather than like the property, which passes
  happily when the code moves. If a mutation does not turn a check red, the
  check is not testing what its name says.

## 3. Test a new feature END TO END

Apsara, 2026-09-17: "ALwyas test end to end when you add a new feature."

Helper tests and screen tests can both be green while the feature does not
work. The gaps live between them:

- the route does not forward the new field to the helper;
- the report route does not forward the new filter;
- the client sends `paidVia` and the route reads `paid_via`.

So every feature gets a section that starts a real server, logs in, posts
through the route the screen actually posts to, and reads the figure back out
of the route the screen actually reads. `tests/paid-via.js` section F is the
shape to copy.

Measure a **delta**, not an absolute, when earlier sections of the same file
have already written to the store — a test that breaks when an unrelated
fixture moves is a test that gets deleted.

## 4. Nothing is true until it is deployed

`bash ship.sh` on the Mac, then `git pull && pm2 restart jarvis --update-env`
on the VM, as separate steps. Commits sitting on the Mac are not fixes; she is
still living with the bug.

## 5. Edge Yard and Edge Metals are different companies

Said repeatedly, and worth repeating here. A rule for one is not a rule for the
other, and the separation is most of what this app is for.
