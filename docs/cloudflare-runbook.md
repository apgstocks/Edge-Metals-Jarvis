# RESOLVED 2026-10-03 — read this before doing any of the below

The wifi problem that prompted this document **went away** after HTTP/3 was
disabled in Caddy. Cloudflare was NOT needed, and Apsara declined it for a good
reason: in Full (strict) mode Cloudflare decrypts the traffic, so supplier
payments and bank details would pass through a third party in plaintext. The
rest of this file is kept for the day the product outgrows one server — the
DNS capture and the email warnings are still accurate and still useful.

## What actually happened, as best we can tell

Caddy advertises HTTP/3 by default, over **UDP** port 443:

    alt-svc: h3=":443"; ma=2592000

`ma=2592000` is **30 days**. Phones CACHE that advertisement. Many wifi
networks allow TCP 443 and silently drop UDP 443, so the phone kept reaching
for QUIC and failing, while mobile data (which carries UDP fine) worked.

The part that cost hours: turning HTTP/3 off server-side stops Caddy
ADVERTISING it, but does nothing about what phones have already stored. So the
fix appeared not to work, HTTP/3 was wrongly ruled out, and five more theories
followed — an expired certificate, a blocked IP, a bad DNS resolver, a
TLS-intercepting proxy, and IP reputation. All six were checked and only this
one survives.

**Confirmed by elimination, 2026-10-03.** Three things changed in the final
Caddyfile and the live server was checked afterwards:

| Change | State on the live server | Verdict |
|---|---|---|
| `protocols h1 h2` | `alt-svc` header gone | **live — the only candidate left** |
| `key_type rsa2048` | chain still `YE2` / ISRG Root X2 (ECDSA) | never took effect; certificate theory dead |
| `localhost` -> `127.0.0.1` | live | Caddy->Node leg only; identical for every client, so it cannot produce "fails on this wifi, works on mobile data" |

Caddy keeps a valid certificate rather than reissuing one, so `key_type` did
nothing. That leaves HTTP/3 as the only change capable of behaving differently
per network.

## If a phone still cannot connect

Its cached alt-svc entry is independent and may persist up to 30 days.
Force-stop the app (Settings → Apps → Edge Trading → Force stop) or restart the
phone. That clears it immediately.

## The lesson worth keeping

A server-side change does not take effect at the moment you make it when the
client has cached the old behaviour. "I changed it and it did not help" is not
evidence the change was wrong.

And the reason this took hours rather than minutes: nothing reported from the
failing devices. That gap is now closed — see helpers/clientErrors.js and the
device line in the morning digest.

---

# Putting Jarvis behind Cloudflare — step by step

Written 2026-10-02, the evening the Edge Yard app could not sign in on several
wifi networks in two cities while working perfectly on mobile data. The server,
Caddy, DNS and the certificate were all verified healthy. One IP address has
one reputation and one route, and some networks simply would not carry it.

Apsara: *"when i productionise this prodyct, i cant ask them to fix the router.
It should work in all the router."*

That is the correct requirement. This is the change that makes it structurally
true rather than something we keep hoping is fixed.

**Time:** about 40 minutes, plus up to a few hours of waiting for nameservers.
**Risk:** one step can break your business email. It is marked **STOP** and it
is the only step that needs real care.

---

# PART 1 — Capture what exists today (5 min)

Cloudflare will become authoritative for **every** DNS record on
`edgemetals.com`, including the **MX** records your email runs on. Its import
is good but not perfect, and a missing MX record means mail stops arriving with
no error anywhere.

**This is already done — see `docs/dns-before-cloudflare.md`.** Every record
on the domain was captured on 2026-10-02 and written up as a checklist, along
with who runs what (GoDaddy for DNS, Google Workspace for mail, a shared host
for the website, the GCP VM for Jarvis).

Read that file before Part 3 and keep it open while you work.

To re-capture later — `dig` is not installed on the VM, so this uses Node,
which is:

```bash
node -e "
const R=require('dns').promises.Resolver; const r=new R(); r.setServers(['8.8.8.8']);
const q=async(l,f,h)=>{try{console.log(l,JSON.stringify(await r[f](h)))}catch(e){console.log(l,'none')}};
(async()=>{ await q('A    ','resolve4','edgemetals.com');
  await q('MX   ','resolveMx','edgemetals.com'); await q('TXT  ','resolveTxt','edgemetals.com');
  await q('NS   ','resolveNs','edgemetals.com');
  for (const h of ['jarvis','www','mail','ftp']) await q('A '+h,'resolve4',h+'.edgemetals.com');
})();"
```

---

# PART 2 — Add the site to Cloudflare (10 min)

1. Go to **dash.cloudflare.com** and create an account (or sign in).

2. Click **Add a site** (top right, or on the home screen).

3. Type `edgemetals.com` — **the root domain, not `jarvis.edgemetals.com`.**
   Click **Continue**.

4. Choose the **Free** plan. Click **Continue**.

5. Cloudflare scans your DNS and shows what it found. This takes ~30 seconds.

6. **Do not click Continue yet.** Go to Part 3 first.

---

# PART 3 — STOP. Check the records before going further

This is the step that protects your email.

On the DNS records screen Cloudflare just showed you, compare against the file
you saved in Part 1. Go line by line:

| Check | What to look for |
|---|---|
| **MX** | Every MX record present, same hostnames, **same priority numbers** |
| **SPF** | The `TXT` starting `v=spf1` — one, exactly as before |
| **DKIM** | The `TXT` at `google._domainkey` (or your provider's selector) |
| **DMARC** | The `TXT` at `_dmarc` |
| **A / CNAME** | Every host you actually use — `jarvis`, `www`, anything else |

**Add anything missing now**, using **Add record**. Match the original exactly.

### Set the proxy flags

This matters as much as the records themselves. Each row has an orange/grey
cloud toggle:

- **`jarvis`** (A record → `35.233.131.198`) → **orange cloud ON**
  This is the whole point of the exercise.
- **MX rows** → no cloud toggle, nothing to do.
- **Root `edgemetals.com`, `www`, and everything else** → **grey cloud OFF**
  unless you have a specific reason.

> **Never proxy a hostname that mail is delivered to.** If your MX points at
> `mail.edgemetals.com` and you orange-cloud that A record, mail stops.
> Google Workspace users are safe here — Google's MX hostnames are not on your
> domain — but check anyway.

When the list matches your file, click **Continue**.

---

# PART 4 — Switch the nameservers (5 min + waiting)

1. Cloudflare shows you **two nameservers**, something like
   `aria.ns.cloudflare.com` and `rob.ns.cloudflare.com`. Copy both.

2. Go to wherever you bought `edgemetals.com` (GoDaddy, Namecheap, Google
   Domains / Squarespace…).

3. Find **Nameservers** — usually under DNS settings or domain management.
   Choose **Custom nameservers**.

4. **Replace** the existing ones with Cloudflare's two. Remove the old ones.
   Save.

5. Back in Cloudflare, click **Check nameservers**.

Propagation is usually 10–60 minutes, occasionally longer. Cloudflare emails
you when it is active.

**While waiting, nothing breaks** — the old DNS keeps answering until the
switch completes.

---

# PART 5 — SSL settings (2 min)

Once Cloudflare says the site is **Active**:

1. Left sidebar → **SSL/TLS** → **Overview**.
2. Set encryption mode to **Full (strict)**.

> **Full (strict)** means Cloudflare encrypts to your server *and* verifies
> Caddy's certificate. Do not choose **Flexible** — that sends your supplier
> payments and bank details from Cloudflare to your server unencrypted.

---

# PART 6 — Verify (5 min)

**1. Traffic is going through Cloudflare:**

```bash
curl -sI https://jarvis.edgemetals.com/healthz | grep -i "cf-ray"
```

A `cf-ray:` line means yes. No line means DNS has not switched yet — wait.

**2. Jarvis still answers:**

```bash
curl -s https://jarvis.edgemetals.com/healthz
```

You should see the usual JSON with `version` and `whatsapp:true`.

**3. Email still works.** Send yourself a message from an outside address
(a personal Gmail) to `apsara@edgemetals.com` and confirm it arrives.
**Do this the same day.** Mail problems are quiet and you want to catch them
while you remember what changed.

**4. The real test:** open the app on a wifi that was failing. That is the
only result that matters.

---

# ROLLBACK

Set the `jarvis` record's cloud back to **grey**. Traffic goes direct to the VM
again within seconds. Nothing else to undo.

If something is wrong with **email**, that is a DNS record problem, not a proxy
problem — fix the record in Cloudflare's DNS screen against your Part 1 file.
Switching nameservers back to your old provider also works but is slower.

---

# AFTERWARDS — the certificate, in about 60 days

Once `jarvis` is proxied, **Caddy can no longer renew its Let's Encrypt
certificate.** TLS-ALPN fails because Cloudflare terminates TLS; HTTP-01 fails
because Cloudflare intercepts port 80. Everything works until the certificate
expires, and then the origin leg dies.

Your current certificate is good until **2026-12-04**, so this is not urgent.
Do it in November when nothing is on fire. Three options:

**A — Cloudflare Origin Certificate.** Free, 15 years, no renewals.
*Catch:* trusted only by Cloudflare, so grey-clouding alone stops working as a
rollback — you would have to swap the Caddyfile back too. If you pick this,
write that into the Caddyfile as a comment, so whoever rolls back at 2am knows
why the site broke.

**B — Let's Encrypt via DNS-01** *(recommended)*. Caddy proves ownership by
writing a TXT record through Cloudflare's API, which works fine behind a proxy.
Needs a Caddy build with the `caddy-dns/cloudflare` plugin and a scoped API
token (Zone:DNS:Edit, this zone only):

```
jarvis.edgemetals.com {
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
	reverse_proxy 127.0.0.1:8080
}
```

The certificate stays **publicly valid**, so grey-clouding remains a genuine
one-click escape. Given how much we leaned on rollback the night this was
written, that property is worth the setup.

**C — self-signed origin cert + Full (not strict).** Simplest; no plugin, no
token. The origin leg is still encrypted but Cloudflare does not verify who it
is talking to. Defensible for a fixed IP you control, weaker than A or B.

---

# LIMITS ON THE FREE PLAN

- **100-second request timeout.** PDF generation is the only thing that might
  approach it. An invoice returning **524** is this, not a Jarvis bug.
- **100 MB request body.** Scale ticket photos are nowhere near it.

# WHAT DOES NOT CHANGE

WhatsApp, Gmail polling and Drive uploads are all **outbound** from the VM.
Cloudflare only handles inbound, so none are affected.

`API_BASE` stays `https://jarvis.edgemetals.com`, so **no APK rebuild** is
needed for this change.

---

# THE CURRENT CADDYFILE, AND WHY

```
{
	servers {
		protocols h1 h2
	}
}

jarvis.edgemetals.com {
	tls {
		key_type rsa2048
	}
	reverse_proxy 127.0.0.1:8080
}
```

`protocols h1 h2` disables HTTP/3. Caddy advertises it over **UDP** 443 by
default and some networks drop UDP 443 silently. Ruled out as the cause here,
but there is no reason to offer it.

`key_type rsa2048` is **inert until the certificate is reissued** — Caddy keeps
a valid certificate rather than replacing one. The intent is an RSA chain to
ISRG Root X1, which has broader device trust than the ECDSA chain to ISRG Root
X2 that Caddy picks by default. Not worth forcing once Cloudflare is in front,
because Cloudflare's own certificate is what devices will see.

`127.0.0.1` rather than `localhost`: Caddy was resolving `localhost` to `[::1]`
and dialling IPv6. It worked, but if Node ever binds IPv4-only the result is a
total outage with a perfectly healthy app behind it.
