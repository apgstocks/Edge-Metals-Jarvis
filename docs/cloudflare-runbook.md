# Putting Jarvis behind Cloudflare

Written 2026-10-02, the evening the Edge Yard app could not sign in on several
wifi networks in two cities while working perfectly on mobile data. The server,
Caddy, DNS and the certificate were all verified healthy. One IP address has
one reputation and one route, and some networks simply would not carry it.

Apsara: *"when i productionise this prodyct, i cant ask them to fix the router.
It should work in all the router."*

That is the correct requirement, and this is the change that makes it
structurally true rather than something we keep hoping is fixed.

---

## Before you touch anything: protect the email

Cloudflare's free plan requires moving `edgemetals.com`'s **nameservers** to
Cloudflare. Cloudflare then becomes authoritative for *every* record on the
domain — including **MX**. Your business email is `apsara@edgemetals.com`, and
Jarvis polls that mailbox for bookings and payments.

Cloudflare's import is best-effort and silently misses records. So capture
what exists **first**, and keep the output:

```bash
for t in A AAAA MX TXT CNAME NS SRV; do
  echo "--- $t ---"
  dig +short $t edgemetals.com @8.8.8.8
done
dig +short TXT _dmarc.edgemetals.com @8.8.8.8
dig +short TXT google._domainkey.edgemetals.com @8.8.8.8
```

This is your verification reference and your recovery if anything is lost.

---

## The steps

1. Add `edgemetals.com` to Cloudflare (free plan). It scans and imports DNS.

2. **Compare the imported records against the output above.** MX, SPF
   (`TXT v=spf1...`), DKIM and DMARC especially. Add anything missing *before*
   switching nameservers. This step is the one that protects your email.

3. The `jarvis` record: type `A`, name `jarvis`, content `35.233.131.198`,
   **proxy ON** (orange cloud).
   Everything else — mail, root domain — **proxy OFF** (grey cloud).
   Mail must never be proxied.

4. SSL/TLS → **Full (strict)**. Caddy keeps its own certificate for the
   Cloudflare↔origin leg.

5. Change the nameservers at your registrar to the two Cloudflare provides.
   Usually under an hour to propagate.

---

## Verify

```bash
curl -sI https://jarvis.edgemetals.com/healthz | grep -i "cf-ray"
```

`cf-ray` present means traffic is going through Cloudflare. Then test the app
on a wifi that was failing — that is the only test that matters.

## Rollback

Set the orange cloud back to grey. Traffic goes direct to the VM again,
immediately. Nothing else to undo.

---

## The gotcha that bites in 60 days

Once `jarvis` is proxied, **Caddy can no longer renew its Let's Encrypt
certificate.** TLS-ALPN fails because Cloudflare terminates TLS; HTTP-01 fails
because Cloudflare intercepts port 80. Everything works fine until the
certificate expires and then the origin leg dies.

The current certificate is valid until **2026-12-04**, so this is not urgent —
do it in November when nothing is on fire. Three options:

**A — Cloudflare Origin Certificate.** Free, 15 years, no renewals.
*Catch:* trusted only by Cloudflare, so grey-clouding alone no longer works as
a rollback — you would have to swap the Caddyfile back as well. If you choose
this, write that into the Caddyfile as a comment so whoever rolls back at 2am
knows why the site broke.

**B — Let's Encrypt via DNS-01** *(recommended)*. Caddy proves ownership by
writing a TXT record through Cloudflare's API, which works fine behind a proxy.
Needs a Caddy build with the `caddy-dns/cloudflare` plugin and a scoped API
token (Zone:DNS:Edit on edgemetals.com only):

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
written, that property is worth the extra setup.

**C — self-signed origin cert + Full (not strict).** Simplest, no plugin, no
token. The origin leg is still encrypted but Cloudflare does not verify who it
is talking to. Defensible for a fixed IP you control; weaker than A or B.

**Ruled out — Flexible SSL.** Cloudflare to origin in plain HTTP. Supplier
payments and bank details crossing the internet unencrypted. No.

---

## Limits on the free plan

- **100-second request timeout.** PDF generation is the only thing that might
  approach it. An invoice returning 524 is this, not a Jarvis bug.
- **100 MB request body.** Scale ticket photos are nowhere near it.

## What does not change

WhatsApp, Gmail polling and Drive uploads are all **outbound** from the VM.
Cloudflare only handles inbound, so none of them are affected.

`API_BASE` stays `https://jarvis.edgemetals.com`, so **no APK rebuild** is
needed for this change.

---

## Current Caddyfile, for reference

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

`protocols h1 h2` disables HTTP/3 — Caddy advertises it over UDP 443 by
default, and some networks drop UDP 443 silently. Ruled out as the cause here,
but there is no reason to offer it.

`key_type rsa2048` is **inert until the certificate is reissued**: Caddy keeps
a valid certificate rather than replacing it. The intent is an RSA chain to
ISRG Root X1, which has broader device trust than the ECDSA chain to ISRG Root
X2 that Caddy picks by default. To force it:

```bash
sudo rm -rf /var/lib/caddy/.local/share/caddy/certificates/*/jarvis.edgemetals.com*
sudo systemctl restart caddy
```

Seconds of downtime while the new certificate issues. Not worth doing on its
own once Cloudflare is in front, since Cloudflare's own certificate is what
devices will see.

`127.0.0.1` rather than `localhost`: Caddy was resolving `localhost` to `[::1]`
and dialling IPv6. It worked, but if Node ever binds IPv4-only the result is a
total outage with a perfectly healthy app behind it.
