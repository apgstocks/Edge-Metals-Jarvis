# Getting Jarvis's dashboard onto HTTPS (required for camera capture)

The Loads feature's gross/tare camera buttons use `getUserMedia()`. Browsers
block that API outside a secure context — `https://`, or `http://localhost`.
Jarvis today is reached at `http://35.233.131.198:8080` — plain HTTP, no TLS.
Everything else in the Loads feature works fine over plain HTTP; only the two
camera buttons need this.

**You're on the bare IP with no domain right now → use Option B below.**
Option A (Caddy + Let's Encrypt) is included for later — Let's Encrypt
cannot issue a certificate for a bare IP address, only for a real domain
name, so it's not usable until you have one. The `Caddyfile` already in this
repo is ready for that day; ignore it until then.

I don't have SSH access to your VM, so none of this can be run for you —
these are the exact commands to run yourself once you're SSH'd in.

## Option B — Cloudflare Tunnel (no domain, use this now)

Free, no domain purchase, no firewall/port changes needed on the VM —
`cloudflared` makes an outbound-only connection out to Cloudflare, which
proxies HTTPS traffic back in. You get an `https://<random-name>.trycloudflare.com`
URL. Tradeoff: that hostname is randomly generated and stays fixed only as
long as the `cloudflared` process keeps running — if it restarts, you get a
new random URL. Running it under PM2 (step 4) keeps it stable day-to-day.

**1. SSH into the VM:**
```bash
ssh apsara@35.233.131.198
```

**2. Install cloudflared:**
```bash
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
```

**3. Test it — run this in the foreground first to see it work:**
```bash
cloudflared tunnel --url http://localhost:8080
```
Watch the output for a line like:
```
https://random-words-here.trycloudflare.com
```
Open that URL in a browser (from your laptop, not the VM) — you should see
Jarvis's login page over HTTPS. Ctrl+C to stop this test run once confirmed.

**4. Run it persistently under PM2 (same process manager you already use for Jarvis), so it survives reboots and keeps the same URL:**
```bash
cd ~/Edge-Metals-Jarvis
pm2 start cloudflared --name jarvis-tunnel -- tunnel --url http://localhost:8080
pm2 save
pm2 logs jarvis-tunnel --lines 20
```
The last command shows the logs so you can grab the `https://...trycloudflare.com`
URL again (it's the same one from step 3, since the process didn't restart).

**5. Bookmark that URL.** That's the address to actually use the dashboard
from now on — not `http://35.233.131.198:8080`. Camera capture on the Loads
tab will now work.

**If the URL ever changes** (VM reboot, `pm2 restart jarvis-tunnel`, crash):
run `pm2 logs jarvis-tunnel --lines 20` again to see the new one.

## Option A — Caddy + Let's Encrypt (once you have a domain)

1. Buy/use any domain, add a DNS A record: `jarvis.yourdomain.com` → `35.233.131.198`.
2. Edit the `Caddyfile` in this repo — replace `jarvis.YOURDOMAIN.com` with your real domain.
3. On the VM:
```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```
4. Deploy the Caddyfile:
```bash
cd ~/Edge-Metals-Jarvis
git pull
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```
5. Open ports 80 and 443 on the VM's firewall (GCP console → VPC network → Firewall) if not already open.
6. Visit `https://jarvis.yourdomain.com` — Caddy issues the certificate automatically.

At that point you could retire the Cloudflare Tunnel (`pm2 delete jarvis-tunnel`) since you'd have a stable, real HTTPS URL instead.
