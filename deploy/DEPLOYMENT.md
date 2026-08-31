# ITSM — AWS Lightsail deployment runbook

Deploys the CAP + SAPUI5 app to a single Ubuntu Lightsail instance.
**Milestone 1: plain HTTP over the static IP. No domain, no HTTPS yet.**

```
Browser ──80──> Nginx ──> 127.0.0.1:4004  CAP (Node.js, systemd)
                                │
                        127.0.0.1:5432  PostgreSQL
```

Nginx replaces the BTP approuter + HTML5 repo + destination service.
Auth (`srv/auth.js`) replaces XSUAA — either the built-in local email/password
+ JWT provider, or AWS Cognito, chosen by `AUTH_PROVIDER` (see §4A).
PostgreSQL replaces HANA. `deploy/` (this folder) replaces `mta.yaml`.

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

## 4A. Authentication provider — local or AWS Cognito

`srv/auth.js` is a selector. `AUTH_PROVIDER` in `/etc/itsm/itsm.env` decides:

| `AUTH_PROVIDER` | Provider | Identity / passwords | Notes |
|---|---|---|---|
| unset or `local` | `srv/auth/local-auth.js` | ITSM `User` table (bcrypt), HS256 JWT | the milestone-1 default |
| `cognito` | `srv/auth/cognito-auth.js` | AWS Cognito user pool | ITSM `User` table still owns name/email/org/team/role |

Switching is **just the env var + a restart**. Nothing else changes — same login page, same OData service, same ticket/email/reminder logic. Rollback is the same move in reverse.

```bash
sudo nano /etc/itsm/itsm.env          # set AUTH_PROVIDER + the COGNITO_*/AWS_* block
sudo systemctl restart itsm
journalctl -u itsm -n 20 --no-pager   # expect: [auth] provider: cognito  +  [auth] cognito JWKS loaded
```

`deploy/systemd/itsm.service` needs **no change** — it loads the whole env file via `EnvironmentFile=`.

### 4A.1 AWS prerequisites (one-time, in the AWS console)

**User Pool**
- Region: same as the Lightsail box (`ap-south-1`).
- Sign-in: **email**, and the Cognito user name **is** the email (not an alias over a UUID). The backend calls every `Admin*` API with `Username = <email>`.
- Password policy: minimum length **8** (matches the app's own check).
- Self-service sign-up: **disabled** — users are provisioned only from the ITSM Admin panel.
- ID token expiration: **8 hours** (see limitation note below — this is the session length).

**Groups** — create exactly these four, names case-sensitive, matching the DB role codes:

```
END_USER   SERVICE_GROUP   CONSULTANT   ADMIN
```

**App client** — one public client:
- **No client secret** (leave `COGNITO_CLIENT_SECRET` empty).
- Auth flows: enable `ALLOW_USER_PASSWORD_AUTH` and `ALLOW_REFRESH_TOKEN_AUTH`.

**IAM user** `itsm-cognito-backend` with an access key and this least-privilege policy (replace the ARN):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminDeleteUser",
      "cognito-idp:AdminAddUserToGroup",
      "cognito-idp:AdminRemoveUserFromGroup",
      "cognito-idp:AdminListGroupsForUser",
      "cognito-idp:AdminEnableUser",
      "cognito-idp:AdminDisableUser"
    ],
    "Resource": "arn:aws:cognito-idp:ap-south-1:<ACCOUNT_ID>:userpool/<USER_POOL_ID>"
  }]
}
```

`InitiateAuth`, `ForgotPassword` and `ConfirmForgotPassword` are unauthenticated — they need no credentials and are not in the policy.

### 4A.2 Env vars

In `/etc/itsm/itsm.env` (template: `deploy/itsm.env.example`):

```
AUTH_PROVIDER=cognito
COGNITO_REGION=ap-south-1
COGNITO_USER_POOL_ID=ap-south-1_xxxxxxxxx
COGNITO_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx
COGNITO_CLIENT_SECRET=
AWS_REGION=ap-south-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
```

`JWT_SECRET` and the other `JWT_*` vars are **not used** in Cognito mode (`local-auth.js` is never loaded) — leave them, they do no harm.

### 4A.3 Migrating the existing users

The seed / production users live in the Postgres `User` table but not in Cognito yet. For each one:

1. `AdminCreateUser` with `Username = <email>` (Cognito emails them a temporary password).
2. `AdminAddUserToGroup` for every role they hold — check `master.UserRole` for that `userId`, not just `User.role`.
3. `User.cognitoUserId` is left alone — on that user's **first Cognito login the backend matches them by email and writes `cognitoUserId` back automatically** (`srv/auth/cognito-auth.js` `itsmUser()`).

Bulk snippet (run where the AWS CLI is configured with the IAM user above):

```bash
POOL=ap-south-1_xxxxxxxxx
sudo -u postgres psql -tAF, itsm -c \
  "SELECT u.email, string_agg(COALESCE(r.role, u.role), ' ') \
   FROM \"itsm_master_User\" u \
   LEFT JOIN \"itsm_master_UserRole\" r ON r.\"userId\" = u.\"userId\" \
   WHERE u.\"isActive\" GROUP BY u.email, u.role" \
| while IFS=, read -r EMAIL ROLES; do
    aws cognito-idp admin-create-user --user-pool-id "$POOL" --username "$EMAIL" \
      --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true || true
    for R in $ROLES; do
      aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL" --username "$EMAIL" --group-name "$R" || true
    done
  done
```

### 4A.4 `cds deploy` and `cognitoUserId`

`npx cds-deploy` reseeds `User` from the CSV, so `cognitoUserId` goes back to `NULL` for the seed users. This is **not** a problem: the Cognito users still exist, and the email-match backfill re-links them on the next login. Any user created through the Admin panel (not in a CSV) is wiped as always — take the `pg_dump` first (§9).

### 4A.5 Known limitations (accepted for now)

- **Session length = Cognito ID token validity.** No refresh-token flow yet, so users re-login when the token expires — set the pool's ID token expiry to 8h to match the old JWT.
- **In-memory user cache** (`cognito-auth.js` `userBySub`) — fine for one instance; revisit before running more than one.
- **No `after DELETE Users` → Cognito sync.** Deleting a user in the Admin panel leaves the Cognito account orphaned (they can't log in — no ITSM row — but the pool keeps the entry). Remove it by hand or with `aws cognito-idp admin-delete-user`.

### 4A.6 Rollback to local

```bash
sudo sed -i 's/^AUTH_PROVIDER=cognito/AUTH_PROVIDER=local/' /etc/itsm/itsm.env
# make sure JWT_SECRET is still set in the file
sudo systemctl restart itsm
journalctl -u itsm -n 10 --no-pager   # expect: [auth] provider: local
```

Local-mode logins work immediately for anyone who still has a `passwordHash` row. Users created while Cognito was active have no `passwordHash` — they use "Forgot Password?" to set one.

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
- [ ] Admin: create a user (single-role and multi-role), deactivate/reactivate one

**Local provider** (`AUTH_PROVIDER` unset/`local`):
- [ ] Forgot password → check the link: `journalctl -u itsm | grep 'Password link'`
- [ ] Open that link, set a new password, log in with it

**Cognito provider** (`AUTH_PROVIDER=cognito`, after §4A):
- [ ] `journalctl -u itsm` shows `[auth] provider: cognito` and `cognito JWKS loaded`
- [ ] Admin-created user gets a Cognito invite email → first login prompts for a new password → lands in the app
- [ ] Multi-role Cognito user → role selection → switch role (no re-login)
- [ ] Forgot password → Cognito emails a **code** → reset screen asks for email + code + new password
- [ ] Admin creates a user → the Cognito user pool shows the account in the matching group(s)
- [ ] Admin deactivates a user → that user can no longer log in

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
| Password reset link never arrives (local mode) | email intentionally unset | `journalctl -u itsm | grep 'Password link'` — copy it from the log |
| Service won't start, `AUTH_PROVIDER=cognito needs COGNITO_REGION...` | Cognito vars missing from the env file | fill `COGNITO_REGION`/`COGNITO_USER_POOL_ID`/`COGNITO_CLIENT_ID` (§4A.2) |
| `cognito JWKS preload failed` in the log | wrong `COGNITO_USER_POOL_ID`/`COGNITO_REGION`, or no outbound HTTPS | verify the pool id; `curl https://cognito-idp.<region>.amazonaws.com/<poolId>/.well-known/jwks.json` from the box |
| Every Cognito login → generic 401, log shows `InitiateAuth error: NotAuthorizedException - Client ... configured with secret but SECRET_HASH was not received` | the app client has a secret but `COGNITO_CLIENT_SECRET` is empty | copy the client secret into `COGNITO_CLIENT_SECRET` and restart, **or** use a public (no-secret) app client |
| Every Cognito login → generic 401, log shows `... USER_PASSWORD_AUTH flow not enabled for this client` | app client missing the auth flow | enable `ALLOW_USER_PASSWORD_AUTH` on the client |
| Cognito login → `Your account is not set up in ITSM` | Cognito user exists, no matching `User` row (email mismatch) | check the email matches a row in `itsm_master_User` exactly |
| Cognito login → `No role is assigned to your account` | user is in no ITSM group in Cognito | `aws cognito-idp admin-add-user-to-group` with `END_USER`/`SERVICE_GROUP`/`CONSULTANT`/`ADMIN` |
| Admin "create user" → `Could not create the user in Cognito: AccessDeniedException` | IAM key missing the `Admin*` permissions | attach the §4A.1 policy; check `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` |
| Admin "create user" → `...: UsernameExistsException` | that email already exists in the pool | delete the stale Cognito user, or reuse it — the ITSM row will link by email on first login |
| Multi-role user's extra roles don't appear in Cognito | group name mismatch | Cognito group names must be exactly `END_USER` / `SERVICE_GROUP` / `CONSULTANT` / `ADMIN` |
