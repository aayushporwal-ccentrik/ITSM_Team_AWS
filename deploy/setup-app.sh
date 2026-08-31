#!/usr/bin/env bash
#
# One-shot server setup for the ITSM app on a fresh Ubuntu Lightsail box.
# Milestone 1: plain HTTP over the static IP (3.111.154.43), no domain.
#
# Run as root, AFTER the repo has been cloned to /opt/itsm/app:
#   sudo bash /opt/itsm/app/deploy/setup-app.sh
#
# Idempotent — safe to re-run. It will NOT overwrite an existing
# /etc/itsm/itsm.env (your secrets are kept).

set -euo pipefail

APP=/opt/itsm/app
ENVFILE=/etc/itsm/itsm.env
STATIC_IP=3.111.154.43
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a

log() { echo -e "\n\033[1;36m== $* ==\033[0m"; }

[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 1; }
[[ -d $APP/.git ]] || { echo "clone the repo to $APP first"; exit 1; }

# ----------------------------------------------------------------------
log "1/9  System packages"
apt-get update -y
apt-get -y -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef full-upgrade
apt-get install -y nginx git postgresql ufw openssl curl ca-certificates

# ----------------------------------------------------------------------
log "2/9  Swap (2 GB)"
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
fi
grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf
sysctl -q --system || true
free -m

# ----------------------------------------------------------------------
log "3/9  Node.js 22 LTS"
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

# ----------------------------------------------------------------------
log "4/9  PostgreSQL — service, tuning, database, role"
systemctl enable --now postgresql
PGVER=$(ls /etc/postgresql | head -1)
cat > "/etc/postgresql/$PGVER/main/conf.d/itsm.conf" <<'PGCONF'
# ITSM tuning for a 1 GB box
shared_buffers = 128MB
effective_cache_size = 384MB
work_mem = 4MB
maintenance_work_mem = 32MB
max_connections = 20
wal_buffers = 4MB
PGCONF
systemctl restart postgresql

# ----------------------------------------------------------------------
log "5/9  Environment file"
mkdir -p /etc/itsm
if [[ -f $ENVFILE ]]; then
  echo "$ENVFILE already exists — keeping it."
else
  JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  DB_PASSWORD=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 24)
  cat > "$ENVFILE" <<EOF
NODE_ENV=production
PORT=4004

# Auth: "local" (email/password + JWT) or "cognito" (AWS Cognito).
# To switch to Cognito: set AUTH_PROVIDER=cognito, fill the COGNITO_*/AWS_*
# block below, then restart itsm. See deploy/DEPLOYMENT.md section 4A.
AUTH_PROVIDER=local
#COGNITO_REGION=
#COGNITO_USER_POOL_ID=
#COGNITO_CLIENT_ID=
#COGNITO_CLIENT_SECRET=
#AWS_REGION=
#AWS_ACCESS_KEY_ID=
#AWS_SECRET_ACCESS_KEY=

JWT_SECRET=$JWT_SECRET
JWT_ISSUER=itsm
JWT_AUDIENCE=itsm-app
JWT_ACCESS_TOKEN_EXPIRY=8h
APP_URL=http://$STATIC_IP/webapp
CDS_REQUIRES_DB_CREDENTIALS_HOST=127.0.0.1
CDS_REQUIRES_DB_CREDENTIALS_PORT=5432
CDS_REQUIRES_DB_CREDENTIALS_DATABASE=itsm
CDS_REQUIRES_DB_CREDENTIALS_USER=itsm_app
CDS_REQUIRES_DB_CREDENTIALS_PASSWORD=$DB_PASSWORD
EOF
  echo "generated new $ENVFILE"
fi
chown root:itsm "$ENVFILE"
chmod 640 "$ENVFILE"

DB_PASSWORD=$(grep '^CDS_REQUIRES_DB_CREDENTIALS_PASSWORD=' "$ENVFILE" | cut -d= -f2-)

# role + database (create if missing, always sync the password)
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='itsm_app'" | grep -q 1; then
  sudo -u postgres psql -c "CREATE ROLE itsm_app LOGIN PASSWORD '$DB_PASSWORD';"
fi
sudo -u postgres psql -c "ALTER ROLE itsm_app LOGIN PASSWORD '$DB_PASSWORD';"
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='itsm'" | grep -q 1; then
  sudo -u postgres psql -c "CREATE DATABASE itsm OWNER itsm_app;"
fi

# ----------------------------------------------------------------------
log "6/9  Install dependencies (runtime only)"
chown -R itsm:itsm /opt/itsm
cd "$APP"
sudo -u itsm -H NODE_OPTIONS=--max-old-space-size=512 npm ci --omit=dev --no-audit --no-fund

# ----------------------------------------------------------------------
log "7/9  Deploy schema + seed data to PostgreSQL"
sudo -u itsm -H bash -c "set -a && . $ENVFILE && set +a && cd $APP && npx --yes cds-deploy"

# ----------------------------------------------------------------------
log "8/9  systemd service"
cp "$APP/deploy/systemd/itsm.service" /etc/systemd/system/itsm.service
systemctl daemon-reload
systemctl enable itsm
systemctl restart itsm
sleep 4
systemctl --no-pager -l status itsm | head -n 12 || true

# ----------------------------------------------------------------------
log "9/9  Nginx + firewall"
cp "$APP/deploy/nginx/itsm.conf" /etc/nginx/sites-available/itsm
ln -sf /etc/nginx/sites-available/itsm /etc/nginx/sites-enabled/itsm
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

ufw --force default deny incoming
ufw --force default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw deny 4004/tcp
ufw deny 5432/tcp
ufw --force enable

# ----------------------------------------------------------------------
log "Health check"
sleep 2
echo -n "CAP direct  (expect 401): "; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4004/odata/v4/ITSMService/
echo -n "Nginx root  (expect 302): "; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/
echo -n "Login page  (expect 200): "; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/webapp/index.html

echo -e "\n\033[1;32mDone.\033[0m  Open  http://$STATIC_IP/  in a browser."
echo "Logs:      journalctl -u itsm -f"
echo "Env file:  $ENVFILE   (JWT secret + DB password live here)"
