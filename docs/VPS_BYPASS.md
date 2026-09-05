# Droppr VPS Bypass

Droppr normally reaches the public internet through the `cloudflared-droppr` tunnel for `droppr.coolmri.com`.
For large uploads and long video range requests, a DNS-only VPS path can remove Cloudflare from the data path.

This mirrors the Dropbox upload bypass. As of 2026-05-30, `droppr.coolmri.com`
has been repointed to this direct VPS path:

- VPS: `104.236.97.60`
- Local Droppr port: `127.0.0.1:8098`
- Reverse SSH listener on VPS: `127.0.0.1:18198`
- Production hostname: `https://droppr.coolmri.com`
- Test hostname with no DNS change: `https://droppr.104.236.97.60.nip.io`
- Range smoke sentinel: `https://droppr.coolmri.com/api/robust-share/RS_droppr_direct_smoke/download/range-sentinel.txt`

Files:

- `deploy/reverse-tunnel-droppr-coolmri-direct.service`: local systemd unit for the reverse SSH tunnel.
- `deploy/droppr-vps-bypass.nginx.conf`: VPS Nginx site config for the direct test hostname.
- `deploy/droppr-coolmri-direct.nginx.conf`: VPS Nginx site config for `droppr.coolmri.com`.
- `deploy/droppr-direct-smoke.service`: local systemd unit for one smoke-check run.
- `deploy/droppr-direct-smoke.timer`: local systemd timer for repeated smoke checks.
- `scripts/smoke_vps_bypass.sh`: verifies public DNS, forced-direct HTTPS, normal HTTPS/TLS, typo redirects, API routing, and the test hostname.
- `scripts/check_vps_bypass_soak.sh`: verifies monitor history, DNS, HTTPS headers, and Range before stopping the Cloudflare fallback.

Install/update commands:

Replace `ops@coolmri.com` with the monitored mailbox that should receive Let's Encrypt renewal notices.

```bash
cd /home/mlweb/mri-cooling-droppr
sudo install -m 0644 deploy/reverse-tunnel-droppr-coolmri-direct.service /etc/systemd/system/reverse-tunnel-droppr-coolmri-direct.service
sudo systemctl daemon-reload
sudo systemctl enable --now reverse-tunnel-droppr-coolmri-direct.service

scp deploy/droppr-vps-bypass.nginx.conf root@104.236.97.60:/etc/nginx/sites-available/droppr.104.236.97.60.nip.io.conf
ssh root@104.236.97.60 'ln -sf /etc/nginx/sites-available/droppr.104.236.97.60.nip.io.conf /etc/nginx/sites-enabled/droppr.104.236.97.60.nip.io.conf && nginx -t && systemctl reload nginx'
ssh root@104.236.97.60 'certbot --nginx -d droppr.104.236.97.60.nip.io --non-interactive --agree-tos -m ops@coolmri.com --redirect'
```

Production repoint commands used:

```bash
# Cloudflare DNS: droppr.coolmri.com A 104.236.97.60, proxied=false, ttl=60.
scp deploy/droppr-coolmri-direct.nginx.conf root@104.236.97.60:/etc/nginx/sites-available/droppr.coolmri.com.conf
ssh root@104.236.97.60 'ln -sf /etc/nginx/sites-available/droppr.coolmri.com.conf /etc/nginx/sites-enabled/droppr.coolmri.com.conf && nginx -t && systemctl reload nginx'
ssh root@104.236.97.60 'certbot --nginx -d droppr.coolmri.com --non-interactive --agree-tos -m ops@coolmri.com --redirect'
ssh root@104.236.97.60 'systemctl list-timers certbot.timer --no-pager && certbot renew --dry-run'
```

Smoke checks:

```bash
curl -skI https://droppr.104.236.97.60.nip.io/
curl -skI https://droppr.104.236.97.60.nip.io/.com
curl -skI https://droppr.104.236.97.60.nip.io/api/droppr/client-config
./scripts/smoke_vps_bypass.sh
DROPPR_RANGE_URL='https://droppr.coolmri.com/api/robust-share/<share-id>/download/<file>' ./scripts/smoke_vps_bypass.sh
./scripts/smoke_vps_bypass.sh --range-url https://droppr.coolmri.com/api/robust-share/RS_droppr_direct_smoke/download/range-sentinel.txt
./scripts/check_vps_bypass_soak.sh
systemctl status reverse-tunnel-droppr-coolmri-direct.service --no-pager
ssh root@104.236.97.60 'ss -ltnp | grep 18198'
```

The range URL is optional for ad hoc checks, but the installed systemd monitor uses the sentinel robust share above. The smoke uses a real `GET` range request and expects `206` with `Content-Range`.

Local recurring monitor:

```bash
cd /home/mlweb/mri-cooling-droppr
sudo install -m 0644 deploy/droppr-direct-smoke.service /etc/systemd/system/droppr-direct-smoke.service
sudo install -m 0644 deploy/droppr-direct-smoke.timer /etc/systemd/system/droppr-direct-smoke.timer
sudo systemctl daemon-reload
sudo systemctl enable --now droppr-direct-smoke.timer
systemctl list-timers droppr-direct-smoke.timer --no-pager
```

Rollback to Cloudflare Tunnel:

```bash
cd /home/mlweb/mri-cooling-droppr
docker compose --profile tunnel up -d cloudflared-droppr

# In Cloudflare DNS, restore:
#   type: CNAME
#   name: droppr
#   target: f776bf48-0d24-4520-b785-a03795c75e7e.cfargotunnel.com
#   proxied: true

curl -skI https://droppr.coolmri.com/ | sed -n '1,12p'
```

When rollback is active, the response should again include Cloudflare headers such as `server: cloudflare`.

Notes:

- Keep `cloudflared-droppr` running during DNS-cache propagation so stale resolvers that still return the old Cloudflare edge path do not see immediate downtime. On fresh deploys, start it with `docker compose --profile tunnel up -d cloudflared-droppr`.
- After `./scripts/check_vps_bypass_soak.sh` passes for the default 24-hour window, the Cloudflare tunnel can be stopped with `docker compose --profile tunnel stop cloudflared-droppr`.
- The `nip.io` hostname remains useful as a direct-path smoke test independent of `coolmri.com` DNS.
