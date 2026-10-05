# Putting Jarvis behind a Google load balancer

Written 2026-10-05, the afternoon a customer in the US could not reach
`http://35.233.131.198:8080` on two devices and on both wifi and mobile data,
while the server answered every probe perfectly.

Apsara: *"Migrate to google"*, *"find a permanent fix"*.

---

## READ THIS FIRST — what this does and does not fix

I am not going to sell you this as a cure for today's complaint, because I
cannot prove it is. Here is the honest split.

**Verified facts.** From outside your network, all four addresses answer
correctly right now:

| Address | Result |
|---|---|
| `https://jarvis.edgemetals.com/health` | 200 `{"status":"ok"}` |
| `http://jarvis.edgemetals.com/health` | 308 → https |
| `http://35.233.131.198:8080/health` | 301 → canonical |
| `https://35.233.131.198/health` | cannot work — no certificate exists for a bare IP |

`node scripts/check-entrances.js` re-checks all four in one second.

**What a load balancer FIXES**

- **One IP with one route becomes an anycast IP with many.** Today every
  visitor must reach a single address in one Google zone. If a network
  anywhere between them and `35.233.131.198` is broken, mis-routed, or has
  that address on a reputation list, there is no second path. A global
  forwarding rule is announced from Google's edge in many places at once, so
  a bad path is routed around rather than being the only path. This is the
  structural answer to your own requirement: *"when i productionise this
  prodyct, i cant ask them to fix the router. It should work in all the
  router."*
- **The ephemeral-IP problem ends.** `35.233.131.198` is released if the VM
  ever stops (`HTTPS_SETUP.md:72`). A reserved LB address does not change,
  so a restart stops breaking the DNS record and every bare-IP link.
- **TLS stops being yours to manage.** A Google-managed certificate renews
  itself with no Caddy, no Let's Encrypt rate limits, no `key_type`
  archaeology.
- **It survives the VM.** Health checks mean a dead or restarting Jarvis
  returns a Google error page instead of a connection timeout — and you can
  add a second instance later without changing anything a user holds.

**What it does NOT fix**

- A person typing the wrong URL. That was today's actual fault and no
  infrastructure fixes it.
- A device with wrong clock, hostile security software, or a VPN forcing a
  broken resolver.
- Anything inside Jarvis: a 401, a login failure, a CORS refusal from the
  app. Those are the same before and after.

**So:** if the remaining complaint is a broken network path to one IP, this
fixes it permanently. If it is a wrong address or a device problem, it will
not — and we would still not know which. I would do it anyway for the
ephemeral-IP and single-path reasons alone, but you should start it knowing
that.

**Why not Cloudflare.** You declined it, correctly: in Full (strict) mode
Cloudflare decrypts the traffic, so supplier payments and bank details would
cross a third party in plaintext. That objection got *stronger* now that
Plaid-fed bank data is in this system. Google already runs the VM and holds
the data, so a Google load balancer adds **no new party** to the plaintext
path. That is the whole reason this document exists instead of the
Cloudflare one.

**Email is NOT at risk here.** The Cloudflare route needed your nameservers
moved, which is why that runbook has a **STOP** on the MX step. This route
changes **one A record for the `jarvis` subdomain** and touches nothing else
in the zone. `edgemetals.com`, `www`, and every MX record stay exactly as
they are. Jarvis keeps reading `bose@` and sending as `apsara@` throughout.

**Cost.** Roughly **$18–25/month** for the global forwarding rule, plus
egress (pennies at your volume). The reserved IP is free while attached.

**Time.** About an hour of work, then up to 30 minutes for the certificate
to go ACTIVE. The DNS cutover is the last step and is reversible in minutes.

---

## STEP 0 — do this today, regardless of the rest

Reserving the current IP is one click, free, and independently removes a
whole class of future outage. Do it even if you never finish this document.

```bash
# On the VM or in Cloud Shell. Substitute your region if it is not us-west1.
gcloud compute addresses create jarvis-vm-ip \
  --addresses=35.233.131.198 \
  --region=us-west1
```

Or: **GCP console → VPC network → IP addresses**, find `35.233.131.198`,
click **Reserve**.

If this fails saying the address is in use by an instance, use the console —
it can promote an in-use ephemeral address to static without downtime.

**Why it matters:** today the address is released the moment the VM stops.
One stop/start and the A record, the APK's old fallback, and every bare-IP
link all break at once — and it will look like a new mystery.

---

## STEP 1 — a health check Google can trust

Jarvis already serves `/health` with no authentication, returning
`{"status":"ok"}`. That is what the load balancer will poll.

Do **not** point it at `/healthz`. That endpoint deliberately returns **503**
when WhatsApp is disconnected or the inbox scan has stalled — both of which
are true right now and neither of which means the dashboard is down. A load
balancer polling `/healthz` would take your whole site out of service because
WhatsApp dropped.

```bash
gcloud compute health-checks create http jarvis-health \
  --port=8080 \
  --request-path=/health \
  --check-interval=10s \
  --timeout=5s \
  --healthy-threshold=2 \
  --unhealthy-threshold=3
```

---

## STEP 2 — put the VM in an instance group

A backend service needs a group, even for one machine.

```bash
# Substitute your zone and instance name.
gcloud compute instance-groups unmanaged create jarvis-group --zone=us-west1-a
gcloud compute instance-groups unmanaged add-instances jarvis-group \
  --zone=us-west1-a --instances=jarvis-vm
gcloud compute instance-groups unmanaged set-named-ports jarvis-group \
  --zone=us-west1-a --named-ports=http:8080
```

---

## STEP 3 — the backend service

```bash
gcloud compute backend-services create jarvis-backend \
  --protocol=HTTP \
  --port-name=http \
  --health-checks=jarvis-health \
  --global

gcloud compute backend-services add-backend jarvis-backend \
  --instance-group=jarvis-group \
  --instance-group-zone=us-west1-a \
  --global
```

---

## STEP 4 — open port 8080 to Google's health checkers only

The health checks arrive from Google's own ranges. This is **narrower** than
the rule currently allowing 8080 from `0.0.0.0/0`, and you should replace
that one once the cutover is done — see Step 8.

```bash
gcloud compute firewall-rules create allow-lb-health \
  --allow=tcp:8080 \
  --source-ranges=130.211.0.0/22,35.191.0.0/16 \
  --description="GCP load balancer health checks and proxied traffic"
```

---

## STEP 5 — a reserved global address and a managed certificate

```bash
gcloud compute addresses create jarvis-lb-ip --global
gcloud compute addresses describe jarvis-lb-ip --global --format="value(address)"
```

**Write that address down.** It is the new `jarvis.edgemetals.com`.

```bash
gcloud compute ssl-certificates create jarvis-cert \
  --domains=jarvis.edgemetals.com \
  --global
```

The certificate stays `PROVISIONING` until DNS points at the new address, so
it will not go ACTIVE until after Step 7. That is expected and is not an
error.

---

## STEP 6 — the proxy and the forwarding rules

```bash
gcloud compute url-maps create jarvis-map --default-service=jarvis-backend

gcloud compute target-https-proxies create jarvis-https-proxy \
  --url-map=jarvis-map \
  --ssl-certificates=jarvis-cert

gcloud compute forwarding-rules create jarvis-https \
  --address=jarvis-lb-ip \
  --global \
  --target-https-proxy=jarvis-https-proxy \
  --ports=443

# And port 80, so http:// still reaches people rather than timing out —
# the mistake that caused 2026-10-05 in the first place.
gcloud compute url-maps import jarvis-redirect-map --global --source=/dev/stdin <<'YAML'
name: jarvis-redirect-map
defaultUrlRedirect:
  httpsRedirect: true
  redirectResponseCode: MOVED_PERMANENTLY_DEFAULT
  stripQuery: false
YAML

gcloud compute target-http-proxies create jarvis-http-proxy \
  --url-map=jarvis-redirect-map

gcloud compute forwarding-rules create jarvis-http \
  --address=jarvis-lb-ip \
  --global \
  --target-http-proxy=jarvis-http-proxy \
  --ports=80
```

---

## STEP 7 — the DNS cutover

This is the only step a user notices, and it is the only one worth being
careful about. **It is also the only DNS change: one A record, on the
`jarvis` subdomain. Nothing else in the zone moves, and email is untouched.**

1. **Before changing anything**, lower the TTL on the existing
   `jarvis.edgemetals.com` A record to **300 seconds** and wait for the old
   TTL to expire. This is what makes the rollback fast.
2. Then change that record's value from `35.233.131.198` to the global
   address from Step 5.
3. Watch the certificate:
   ```bash
   gcloud compute ssl-certificates describe jarvis-cert --global \
     --format="value(managed.status)"
   ```
   It goes `PROVISIONING` → `ACTIVE`, usually within 15 minutes of DNS
   resolving, sometimes up to an hour.
4. While it provisions, **the site is reachable on the old path** as long as
   some resolvers still hold the old record — so do this when a few minutes
   of inconsistency is acceptable, not with a customer waiting.

**Verify before telling anyone:**

```bash
node scripts/check-entrances.js
```

All four lines must read as they do today. If `canonical` fails, roll back.

---

## ROLLBACK

Point the A record back at `35.233.131.198`. With a 300-second TTL you are
back within five minutes, and Caddy on the VM never stopped listening — that
is why Step 8 is separate and comes later.

---

## STEP 8 — only after a few quiet days

Until this point Caddy is still running and still holds a valid certificate,
which is deliberate: it is the rollback.

Once you are satisfied:

1. Replace the `0.0.0.0/0` rule on 8080 with the Google-ranges-only rule from
   Step 4. The load balancer is then the only way in, and the plain-HTTP
   redirect in `api.js` serves the LB's health checks and nothing else.
2. Leave Caddy installed. It costs nothing idle and it is the fastest
   rollback you will ever have.

**Do not** remove the `api.js` plain-HTTP redirect. Old bare-IP links will
outlive all of this, and that redirect is what keeps them working.

---

## What still needs watching afterwards

`helpers/entrances.js` holds the declared list of every address a person
might be holding, and `scheduler.js` checks it at 05:40 daily — silent when
all four behave, and an email when one dies. **After the cutover, update the
`legacy-8080` entrance's expectation** if the firewall no longer admits the
public there: it should become `broken` with the reason, rather than quietly
failing every night. The declaration is the thing that keeps this from
rotting; a list nobody updates is how line 5 of `HTTPS_SETUP.md` stayed wrong
for five weeks.
