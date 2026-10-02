# edgemetals.com DNS — as it stands before Cloudflare

Captured 2026-10-02 against Google's resolver (8.8.8.8). `dig` is not installed
on the VM, so these were read with Node's DNS resolver instead — same answers,
nothing to install.

**This is the checklist for Part 3 of the Cloudflare runbook, and the recovery
sheet if a record goes missing.** Every row below must exist in Cloudflare
before you switch nameservers.

---

## Who runs what, right now

| | |
|---|---|
| **Registrar / DNS** | GoDaddy — `ns25.domaincontrol.com`, `ns26.domaincontrol.com` (SOA hostmaster `dns.jomax.net`) |
| **Email** | Google Workspace |
| **Website** | `69.89.31.118` — a shared host, not the Jarvis VM |
| **Jarvis** | `35.233.131.198` — the GCP VM |

So the nameserver change in Part 4 happens **at GoDaddy**.

---

## Every record to recreate

### A records

| Name | Value | Proxy |
|---|---|---|
| `edgemetals.com` (root) | `69.89.31.118` | **grey** — your website, different host |
| `ftp` | `69.89.31.118` | **grey** |
| `mail` | `148.72.44.1` | **grey** — never proxy anything mail-related |
| `jarvis` | `35.233.131.198` | **ORANGE** — this is the one we are doing all this for |

### CNAME

| Name | Value | Proxy |
|---|---|---|
| `www` | `edgemetals.com` | **grey** |

### MX — Google Workspace. All five, with these exact priorities.

| Priority | Host |
|---|---|
| 1 | `aspmx.l.google.com` |
| 5 | `alt1.aspmx.l.google.com` |
| 5 | `alt2.aspmx.l.google.com` |
| 10 | `aspmx2.googlemail.com` |
| 10 | `aspmx3.googlemail.com` |

> Priorities matter. `1` and `5` and `10` are not decorative — they are the
> order mail is attempted in. Copy them exactly.

### TXT

```
v=spf1 include:_spf.google.com ~all
google-site-verification=FzzkrpE4lXqM2ld1ye8ABqbxBKylAgymZQFkCMScqWI
```

---

## No AAAA, no SRV

`edgemetals.com` has no IPv6 records and no SRV records. Nothing to carry over,
and nothing missing if Cloudflare shows none.

---

## Two things that are absent and probably should not be

Neither blocks the Cloudflare move. Both affect whether your email reaches
people, and this is the moment you are looking at DNS anyway.

**No DKIM.** `google._domainkey.edgemetals.com` does not exist, so Google
Workspace DKIM signing has never been switched on. Mail from
`apsara@edgemetals.com` goes out unsigned, which makes it easier for a
recipient's spam filter to doubt it. Turned on in the Google Admin console
(Apps → Google Workspace → Gmail → Authenticate email), which generates a TXT
record to add.

**No DMARC.** `_dmarc.edgemetals.com` does not exist. Without it you get no
say in how receivers treat mail that fails SPF, and no reports about anyone
sending as your domain. A monitoring-only start is harmless:

```
_dmarc   TXT   v=DMARC1; p=none; rua=mailto:apsara@edgemetals.com
```

`p=none` changes nothing about delivery — it only asks for reports. Do DKIM
first, then DMARC, and leave `p=none` for a few weeks before tightening.

Both of these are worth doing when Jarvis starts emailing your customers'
suppliers rather than only your own inbox.

---

## The one trap that does not apply to you

The runbook warns never to orange-cloud a host that mail is delivered to. You
are safe: your MX points at Google's hostnames, not your own. The
`mail.edgemetals.com` A record exists but nothing delivers to it — carry it
across unchanged and leave it grey.
