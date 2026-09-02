# Recording loads when the server is down

A design, written before any code, because the hard part is not storage.

Apsara, 2026-09-02: *"What if some day this app goes down?"* — and, asked
whether the yard being unable to record anything during an outage mattered:
*"Offline capture matters — plan it properly."*

---

## 1. What is actually broken today

Both clients are thin. Every screen fetches; the service worker is deliberately
a passthrough so it can never serve stale numbers. If the VM is unreachable:

- the Loads tab shows nothing
- **a load cannot be created at all** — the save is a `POST /api/loads`
- drafts do not help, because drafts are *also* server-side
  (`POST /api/load-drafts`)
- the scale-photo OCR is a server call
- the load ID is assigned server-side, under a file lock

So a truck on the scale, right now, during an outage, cannot be written down
anywhere except paper. Everything else in this document follows from that one
sentence.

**Scope: capture only.** Not payments, not petty cash, not PDFs, not the yard
assistant. Those can wait for the server and there is no cost to waiting. A
truck cannot.

---

## 2. The hard part is IDs, not storage

Storing a load locally is an afternoon. The problem is what to call it.

`nextLoadId` computes `EDGE_<max+1>` **inside** the `mutateJson` callback,
under the file lock, precisely so two concurrent saves cannot mint the same
number. That guarantee is a property of there being one server. Offline, it
evaporates: two phones both offline both believe the next load is `EDGE_47`.

Three options, and only one of them is honest.

### Option A — the phone guesses `EDGE_47`

It is what the operator expects to see on the ticket. It is also wrong roughly
whenever it matters: two phones offline on the same day produce two `EDGE_47`s,
and the collision surfaces *after* both have been signed and photographed.
**Rejected.** An ID that is sometimes a duplicate is worse than no ID, because
every downstream record — payments, the sheet, the PDF filename — keys on it.

### Option B — a local ID that is never a real ID

The phone mints `LOCAL-<device>-<counter>`, obviously provisional, shown as
such on screen ("Pending — will be numbered when it syncs"). On reconnect the
server assigns the real `EDGE_n` and the client swaps it.

**Recommended.** It is honest at every moment: while offline the record openly
has no yard number, and nobody writes `EDGE_47` on a paper ticket that will
later become `EDGE_52`. The cost is that the operator cannot quote a load
number to a seller until sync — which is already true today, since today they
cannot record the load at all.

### Option C — pre-issued ID blocks

Each device leases a block of numbers (`EDGE_47`–`EDGE_56`) from the server
while online, and spends them offline. Real IDs immediately, no collisions.

The costs are real: unused numbers leave permanent gaps in the sequence, a
device that is lost takes its block with it, and the lease has to be renewed
before it runs dry — a device offline for longer than its block is back to
Option B anyway. Worth revisiting **only** if "I need to tell the seller the
load number now" turns out to be a genuine daily need. Ask before building it.

---

## 3. What the queue looks like

```
localStorage['jarvis_offline_loads'] = [
  { local_id, created_at, device_id, payload, photos, state, attempts, error }
]
```

- **`device_id`** — minted once per install, so a `local_id` is unique across
  phones without coordination.
- **`state`** — `queued` → `syncing` → `synced` (then dropped) or `failed`.
- **`payload`** — exactly the body `POST /api/loads` already takes. Not a new
  shape: the offline path must not become a second, subtly different way of
  creating a load, or the two will drift and only one will be tested.

### Photos are the awkward part

A gross/tare photo is a several-hundred-KB base64 string, and localStorage is
~5 MB per origin. A busy offline afternoon would blow that, and localStorage
fails by *throwing on write* — the load would silently not be queued.

**Use IndexedDB for photos**, keyed by `local_id`, with localStorage holding
only the small JSON. IndexedDB is asynchronous and awkward, which is why the
temptation is to skip it; the alternative is a queue that quietly stops
accepting loads on a bad day, which is exactly the failure this feature exists
to prevent.

**A hard cap, surfaced early.** At 20 queued loads or 40 MB, the app must say
*"20 loads waiting to sync — reconnect soon"* rather than accept a 21st and
lose it. A queue that fails loudly at a limit is usable; one that fails
silently is not.

---

## 4. Sync

On reconnect (and on app open, and every 60s while queued items exist):

1. Take items in `created_at` order. **Serial, not parallel** — the server
   assigns IDs under a lock, and hammering it with ten concurrent creates from
   one phone is a self-inflicted race.
2. `POST /api/loads` with an **idempotency key** = `local_id` (see §5).
3. On success: record the real `EDGE_n`, upload the photos against it, drop the
   queue entry.
4. On a 4xx: mark `failed`, keep it, and show it. A validation error will not
   fix itself by retrying.
5. On a 5xx or a network error: leave it `queued`, exponential backoff.

**Photos upload after the load exists**, not with it. A 6 MB multipart body
over yard signal is the request most likely to fail, and it must not take the
load record down with it. A load with a missing photo already has a warning
banner — that path exists and works.

---

## 5. The server needs one change: idempotency

Without it, this sequence loses money:

> phone posts the load → server creates `EDGE_47` → **the response is lost on
> the way back** → phone retries → server creates `EDGE_48`, a duplicate

Duplicated loads mean duplicated inventory and a supplier paid twice.

So `POST /api/loads` accepts `client_ref` (the `local_id`), stores it on the
record, and **returns the existing load** if one already carries that ref. One
lookup, inside the same `mutateJson` callback that already assigns the ID, so
the check and the create are under one lock — the same reasoning as the petty
cash balance check.

This is small, and it is worth doing **even if offline capture is never built**:
the same lost-response retry can happen today on a bad connection.

---

## 6. What the operator sees

- An offline banner: *"Working offline — 3 loads waiting to sync."* Persistent,
  not a toast. This is a state, not an event.
- Queued loads appear in the deck immediately, marked **Pending**, with the
  local id where the `EDGE_n` will go.
- On sync, the card silently becomes the real load. No celebration; the
  interesting case is failure.
- Failed items get their own strip with the server's reason and a Retry — the
  same shape as the existing draft strip, which already solves this problem.

---

## 7. What this does NOT solve

Worth stating plainly, so it is not discovered later:

- **Two phones, same seller, same truck.** Offline, neither can see the other.
  Two operators recording the same physical load produce two records. Only
  discipline fixes that; the app can at most flag same-seller-same-day
  duplicates on sync for a human to judge.
- **Inventory is wrong while offline.** On-hand is computed server-side from
  all loads. A phone holding three unsynced loads is showing stale stock, and
  should say so rather than imply the number is live.
- **Nothing else works offline.** Payments, petty cash, PDFs, the assistant,
  the reports. Deliberate — see the scope note in §1.

---

## 8. Cost

| | |
|---|---|
| Server: `client_ref` idempotency | half a day, worth doing regardless |
| Queue + IndexedDB photo store | 2 days |
| Sync engine, backoff, failure surfacing | 2 days |
| UI: banner, pending cards, failure strip | 1 day |
| Tests: the queue, the sync, and a simulated flaky network | 2 days |

**~7–8 days**, and the tests are not the padding. Every failure mode here is
one where the yard *believes* a load was recorded — that is the class of bug
worth spending days to not ship.

---

## 9. Recommendation

Do §5 (idempotency) **now**, on its own. It is half a day, it fixes a real
duplicate-load risk that exists today on a flaky connection, and it is the
prerequisite for everything else.

Then run for a fortnight with the nightly backup in place and see whether the
VM actually goes down. If it does, build the rest. If it does not, this
document is the plan, ready, and the money is better spent elsewhere.

The thing I would *not* do is build the queue first and the idempotency after.
That order ships a system whose retry path creates duplicate loads.
