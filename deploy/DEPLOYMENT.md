# ITSM — AWS Lightsail deployment runbook

Deploys the CAP + SAPUI5 app to a single Ubuntu Lightsail instance.
**Milestone 1: plain HTTP over the static IP. No domain, no HTTPS yet.**

```
Browser ──80──> Nginx ──> 127.0.0.1:4004  CAP (Node.js, systemd)
                                │
                        127.0.0.1:5432  PostgreSQL
```

Nginx replaces the BTP approuter + HTML5 repo + destination service.
Custom JWT auth (`srv/auth.js`) replaces XSUAA. PostgreSQL replaces HANA.
`deploy/` (this folder) replaces `mta.yaml`.

> **Fast path:** once the repo is cloned to `/opt/itsm/app` (see §1a below),
> `sudo bash /opt/itsm/app/deploy/setup-app.sh` does sections 2–7 in one shot
> (packages, swap, Node 22, PostgreSQL, env file, `cds deploy`, systemd, nginx,
> firewall). It's idempotent and never overwrites an existing `/etc/itsm/itsm.env`.
> The sections below are the manual walkthrough / reference for when it needs
> tweaking.

### §1a — get the repo onto the box (private repo → deploy key)

Browser SSH into the instance, then paste these (one line at a time if paste misbehaves):

```bash
sudo apt-get update -y && sudo apt-get install -y git
id itsm >/dev/null 2>&1 || sudo useradd --system --create-home --home-dir /opt/itsm --shell /usr/sbin/nologin itsm
sudo mkdir -p /opt/itsm/app /opt/itsm/.ssh && sudo chown -R itsm:itsm /opt/itsm && sudo chmod 700 /opt/itsm/.ssh
sudo -u itsm -H ssh-keygen -t ed25519 -N '' -f /opt/itsm/.ssh/id_ed25519 -C itsm-lightsail
sudo -u itsm -H bash -c 'ssh-keyscan -t ed25519 github.com >> /opt/itsm/.ssh/known_hosts'
sudo cat /opt/itsm/.ssh/id_ed25519.pub
```

Copy that public key → GitHub repo **Settings → Deploy keys → Add deploy key**
(title `lightsail`, **do not** tick "Allow write access"). Then:

```bash
sudo -u itsm -H git clone git@github.com:aayushporwal-ccentrik/ITSM_Team_AWS.git /opt/itsm/app
sudo bash /opt/itsm/app/deploy/setup-app.sh
```

---

## 0. What you have

| Thing | Value |
|---|---|
| Instance | Ubuntu, 1 GB RAM / 2 vCPU / 40 GB SSD, Mumbai `ap-south-1a` |
| Static IP | `3.111.154.43` |
| Private IP | `172.26.10.5` |
| IPv6 | disabled for milestone 1 |
| Repo | `https://github.com/aayushporwal-ccentrik/ITSM_Team_AWS.git` |
| App path on server | `/opt/itsm/app` |
| Service user | `itsm` (home `/opt/itsm`, no login shell) |
| Node | 22 LTS |
| DB | PostgreSQL (distro package), database `itsm`, role `itsm_app` |

Placeholders used below: `<DB_PASSWORD>`, `<JWT_SECRET>` — generate these on the server, never reuse from anywhere.

---

## 1. Lightsail console — networking

1. **Attach the static IP** (done → `3.111.154.43`).
2. **Disable IPv6 networking** (Networking tab) — one less firewall table to keep in sync. Re-enable when a domain is added.
3. **IPv4 Firewall** — set exactly these rules, delete anything else:

| Application | Protocol | Port | Restrict source to |
|---|---|---|---|
| SSH | TCP | 22 | **Your IP only** (not `Any`) |
| HTTP | TCP | 80 | Any |
| Custom (optional, HTTPS later) | TCP | 443 | Any |

**Do not** add 4004 or 5432. They stay on loopback + the firewall.

---

## 2. First-time server base setup

SSH in (Lightsail browser SSH, or your key):

```bash
ssh ubuntu@3.111.154.43
```

### 2.1 Update

```bash
sudo apt update && sudo apt -y full-upgrade
# if the kernel was updated:
sudo reboot
```

### 2.2 Swap (do this BEFORE any npm — 1 GB RAM will OOM otherwise)

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf
sudo sysctl -p /etc/sysctl.d/99-swappiness.conf
free -m        # confirm 2048 MB swap
```

### 2.3 Service user

```bash
sudo useradd --system --create-home --home-dir /opt/itsm --shell /usr/sbin/nologin itsm
sudo mkdir -p /opt/itsm/app
sudo chown -R itsm:itsm /opt/itsm
```

### 2.4 Node.js 22 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v        # v22.x
npm -v
```

### 2.5 Nginx + git

```bash
sudo apt install -y nginx git
```

---

## 3. PostgreSQL

### 3.1 Install

```bash
sudo apt install -y postgresql
systemctl status postgresql --no-pager
```

### 3.2 Create the database and app role

```bash
sudo -u postgres psql <<SQL
-- password_encryption is scram-sha-256 by default on PG 14+, so this hash is scram
CREATE ROLE itsm_app LOGIN PASSWORD '<DB_PASSWORD>';
CREATE DATABASE itsm OWNER itsm_app;
SQL
```

Generate `<DB_PASSWORD>` first: `openssl rand -base64 24`

### 3.3 Confirm it's loopback-only

```bash
sudo -u postgres psql -c "SHOW listen_addresses;"     # expect: localhost
sudo grep -E '^(local|host)' /etc/postgresql/*/main/pg_hba.conf
```

The distro default already restricts to `127.0.0.1/32` + `::1/128` with `scram-sha-256` and is correct. **Do not** widen it. If `listen_addresses` is not `localhost`, set it in `/etc/postgresql/*/main/postgresql.conf` and `sudo systemctl restart postgresql`.

### 3.4 Tune for 1 GB RAM

Edit `/etc/postgresql/*/main/postgresql.conf`:

```
shared_buffers = 128MB
effective_cache_size = 384MB
maintenance_work_mem = 32MB
work_mem = 4MB
max_connections = 20
wal_buffers = 4MB
```

```bash
sudo systemctl restart postgresql
```

### 3.5 Test the app credential over loopback

```bash
PGPASSWORD='<DB_PASSWORD>' psql -h 127.0.0.1 -U itsm_app -d itsm -c '\conninfo'
```

---

## 4. Deploy the application

### 4.1 Clone

```bash
sudo -u itsm git clone https://github.com/aayushporwal-ccentrik/ITSM_Team_AWS.git /opt/itsm/app
cd /opt/itsm/app
```

### 4.2 Environment file

```bash
sudo mkdir -p /etc/itsm
sudo cp /opt/itsm/app/deploy/itsm.env.example /etc/itsm/itsm.env
sudo chown root:itsm /etc/itsm/itsm.env
sudo chmod 640 /etc/itsm/itsm.env
```

Generate the JWT secret and edit the file:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
sudo nano /etc/itsm/itsm.env
```

Fill in `JWT_SECRET=` and `CDS_REQUIRES_DB_CREDENTIALS_PASSWORD=`. Leave `APP_URL=http://3.111.154.43/webapp` as-is.

### 4.3 Install dependencies (runtime only)

```bash
cd /opt/itsm/app
sudo -u itsm HOME=/opt/itsm npm ci --omit=dev --no-audit --no-fund
```

If this OOMs despite swap: `sudo -u itsm HOME=/opt/itsm NODE_OPTIONS=--max-old-space-size=512 npm ci --omit=dev --no-audit --no-fund`

### 4.4 Deploy the schema + seed data to PostgreSQL

```bash
cd /opt/itsm/app
sudo -u itsm bash -c 'set -a && . /etc/itsm/itsm.env && set +a && npx cds-deploy'
```

This creates every table and loads all `db/data/*.csv` (users, roles, lookup values, organizations, ticket counters). Expect `HANA/PostgreSQL deployment done`-style output.

> **Seeded logins** (email `<name>@itsm.example.com`, password `<name>123`): service group, consultant, end user, admin — see the project `CLAUDE.md`. Change these before real use.

### 4.5 Smoke-test CAP directly (before Nginx / systemd)

```bash
cd /opt/itsm/app
sudo -u itsm bash -c 'set -a && . /etc/itsm/itsm.env && set +a && npx cds-serve' &
sleep 5
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4004/odata/v4/ITSMService/    # 401
curl -s -X POST http://127.0.0.1:4004/auth/login -H 'Content-Type: application/json' \
     -d '{"email":"admin@itsm.example.com","password":"admin123"}'                       # token JSON
kill %1
```

401 on OData (no token) and a token in the login response = backend is healthy.

---

## 5. systemd service

```bash
sudo cp /opt/itsm/app/deploy/systemd/itsm.service /etc/systemd/system/itsm.service
sudo systemctl daemon-reload
sudo systemctl enable --now itsm
sudo systemctl status itsm --no-pager
journalctl -u itsm -n 50 --no-pager
```

Expect `server listening on { url: 'http://localhost:4004' }` and `connect to db > postgres`.

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4004/odata/v4/ITSMService/   # 401
```

---

## 6. Nginx

```bash
sudo cp /opt/itsm/app/deploy/nginx/itsm.conf /etc/nginx/sites-available/itsm
sudo ln -sf /etc/nginx/sites-available/itsm /etc/nginx/sites-enabled/itsm
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

---

## 7. UFW (defence in depth, on top of the Lightsail firewall)

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw deny 4004/tcp
sudo ufw deny 5432/tcp
sudo ufw --force enable
sudo ufw status verbose
```

---

## 8. Test over the public IP

Open **http://3.111.154.43/** in a browser. Walk the whole flow:

- [ ] Redirects to `/webapp/index.html`, login screen loads
- [ ] Login as `admin@itsm.example.com` → Organizations page
- [ ] Login as a multi-role user → role selection → switch role
- [ ] End user: create a ticket, upload an attachment, download it back
- [ ] Service group: assign the ticket
- [ ] Consultant: resolve it
- [ ] Reminder bell works
- [ ] Admin: create an org, set a theme colour, upload a logo
- [ ] Forgot password → check the link: `journalctl -u itsm | grep 'Password link'`
- [ ] Open that link, set a new password, log in with it

If all green — milestone 1 is done.

---

## 9. Redeploying after a code change

```bash
cd /opt/itsm/app
sudo -u itsm git pull
sudo -u itsm HOME=/opt/itsm npm ci --omit=dev --no-audit --no-fund   # only if package-lock changed

# only if db/schema.cds or db/data/*.csv changed:
sudo -u itsm bash -c 'set -a && . /etc/itsm/itsm.env && set +a && npx cds-deploy'

sudo systemctl restart itsm
journalctl -u itsm -n 30 --no-pager
```

> **WARNING — `cds deploy` reseeds every CSV-backed table.** Any organization or
> user created through the Admin panel (not present in a CSV) is **wiped** by the
> `cds-deploy` step. Always take a full dump first:
> ```bash
> sudo -u postgres pg_dump -Fc itsm > ~/itsm-before-deploy-$(date +%F).dump
> ```
> After deploying, re-insert what you need (inspect the old dump with
> `pg_restore -l`, or restore specific tables into a scratch DB and copy rows
> across). This is the single biggest operational hazard — see project `CLAUDE.md`.

---

## 10. Operations

| Task | Command |
|---|---|
| Live logs | `journalctl -u itsm -f` |
| Restart backend | `sudo systemctl restart itsm` |
| Restart nginx | `sudo systemctl reload nginx` |
| Nginx access log | `sudo tail -f /var/log/nginx/itsm.access.log` |
| Memory / swap | `free -m` · `systemctl status itsm` (shows Memory:) |
| OOM check | `journalctl -k | grep -i 'killed process'` |
| DB shell | `sudo -u postgres psql itsm` |
| Cap journald size | `sudo journalctl --vacuum-size=200M` (or set `SystemMaxUse=200M` in `/etc/systemd/journald.conf`) |

### Nightly database backup

```bash
sudo tee /etc/cron.d/itsm-backup >/dev/null <<'CRON'
30 2 * * * postgres pg_dump -Fc itsm > /var/backups/itsm-$(date +\%F).dump 2>/dev/null; find /var/backups -name 'itsm-*.dump' -mtime +7 -delete
CRON
sudo mkdir -p /var/backups
```

Copy `/var/backups/itsm-*.dump` off the box (S3 / another host) — a 40 GB single SSD is not a backup. **Test a restore** before you rely on it: `pg_restore -d itsm_test /var/backups/itsm-YYYY-MM-DD.dump`.

---

## 11. Later — domain + HTTPS

Only after milestone 1 passes.

1. Re-enable IPv6 in Lightsail if wanted; add `443` to the firewall (both tabs).
2. DNS at the registrar: `A  @  3.111.154.43` (and `AAAA` if IPv6 on).
3. `deploy/nginx/itsm.conf` → change `server_name` to the domain, add `listen [::]:80;`. Reload.
4. `sudo apt install -y certbot python3-certbot-nginx`
5. `sudo certbot --nginx -d your-domain` → choose **redirect**.
6. `/etc/itsm/itsm.env` → `APP_URL=https://your-domain/webapp` → `sudo systemctl restart itsm`.
7. `sudo certbot renew --dry-run` ; confirm `systemctl status certbot.timer`.

---

## 12. Later — move PostgreSQL off the box

When this stops being a pilot (real users / uptime expectations), migrate to managed Postgres (Amazon RDS / Lightsail managed DB):

1. `pg_dump -Fc itsm > itsm.dump` → `pg_restore` into the managed instance.
2. Update the five `CDS_REQUIRES_DB_CREDENTIALS_*` vars in `/etc/itsm/itsm.env` (host, port, user, password, database) — add `CDS_REQUIRES_DB_CREDENTIALS_SSL=true`.
3. `sudo systemctl restart itsm`.

No application code changes. Also plan to bump the instance to 2 GB RAM at that point.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `itsm` service won't start, `journalctl` shows `JWT_SECRET is not set` | `/etc/itsm/itsm.env` missing / unreadable / blank secret | Check `sudo cat /etc/itsm/itsm.env`, perms `root:itsm 640`, secret filled |
| `connect to db > postgres` then `ECONNREFUSED` / auth failed | wrong DB password, or PG not running | `systemctl status postgresql`; re-check `CDS_REQUIRES_DB_CREDENTIALS_PASSWORD` vs the role |
| Login page loads but every request 502 | CAP not running / crashed | `systemctl status itsm`, `journalctl -u itsm -n 50` |
| Login works, OData calls 404 | Nginx not forwarding, or wrong `location` | `nginx -t`; confirm `deploy/nginx/itsm.conf` installed, default site removed |
| App loads, blank tiles / empty tables | seed not loaded | re-run the `cds deploy` step (4.4) |
| Attachment upload fails at ~a few MB | `client_max_body_size` | already 15m in the conf; raise if needed, watch RAM |
| Backend killed randomly under load | OOM on 1 GB | `journalctl -k | grep -i oom`; lower PG `shared_buffers`, raise swap, or bump the instance |
| `npm ci` killed | OOM during install | ensure swap is on; add `NODE_OPTIONS=--max-old-space-size=512` |
| Password reset link never arrives | email intentionally unset | `journalctl -u itsm | grep 'Password link'` — copy it from the log |
