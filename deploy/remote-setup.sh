#!/usr/bin/env bash
# =====================================================================
# AgentMS — droplet setup (idempotent). Run as root ON the droplet.
#
#   APP_PORT=8444 bash /root/remote-setup.sh
#
# ISOLATION GUARANTEES (does not touch the existing EV Research app):
#   - installs its OWN PostgreSQL (localhost only) — no existing PG on this box
#   - runs as a dedicated 'agentms' system user under its own systemd service
#   - listens on a dedicated free port (default 8444) with self-signed HTTPS
#   - opens ONLY that port in ufw; makes NO nginx changes
# Re-running is safe: it pulls latest code, keeps existing DB/secrets, restarts.
# =====================================================================
set -euo pipefail

APP_USER=agentms
APP_DIR=/opt/agentms
APP_SRC="$APP_DIR/app"
REPO_URL="${REPO_URL:-https://github.com/rajathslr/UniversityEducationAgentPortal.git}"
APP_PORT="${APP_PORT:-8444}"
DB_NAME=agentms
DB_USER=agentms
SERVICE=agentms

log() { echo; echo "== $* =="; }
[ "$(id -u)" = "0" ] || { echo "Must run as root."; exit 1; }

PUBLIC_IP="$(curl -fsS -4 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
NODE_BIN="$(command -v node || true)"
NPM_BIN="$(command -v npm || true)"
[ -n "$NODE_BIN" ] || { echo "Node not found on PATH. Install Node 18+ first."; exit 1; }
[ -n "$NPM_BIN" ]  || { echo "npm not found on PATH."; exit 1; }
log "Node $("$NODE_BIN" -v) at $NODE_BIN · public IP ${PUBLIC_IP:-unknown} · port $APP_PORT"

# --- guard: refuse to grab a port already in use by something else ---
if ss -tlnH "( sport = :$APP_PORT )" | grep -q LISTEN; then
  # allow if it's already our own service being restarted
  if ! systemctl is-active --quiet "$SERVICE"; then
    echo "Port $APP_PORT is already in use by another process. Set APP_PORT to a free port and re-run."; exit 1
  fi
fi

# --- 1. PostgreSQL (install only if absent) ---
if ! command -v psql >/dev/null 2>&1; then
  log "Installing PostgreSQL (none present)"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y postgresql
fi
systemctl enable --now postgresql

# --- 2. dedicated OS user + app dir ---
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_SRC"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

# --- 3. code (clone or fast-forward) ---
if [ -d "$APP_SRC/.git" ]; then
  log "Updating repo"; sudo -u "$APP_USER" git -C "$APP_SRC" pull --ff-only
else
  log "Cloning repo"; sudo -u "$APP_USER" git clone "$REPO_URL" "$APP_SRC"
fi

# --- 4. .env — generate once with strong secrets; reuse on re-runs ---
ENV_FILE="$APP_SRC/.env"
if [ ! -f "$ENV_FILE" ]; then
  log "Creating database + .env with generated secrets"
  DB_PASS="$(openssl rand -hex 24)"
  ADMIN_PASS="$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | cut -c1-16)"
  SEED_PASS="$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | cut -c1-16)"

  sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}';
  END IF;
END \$\$;
SQL
  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
    sudo -u postgres createdb -O "${DB_USER}" "${DB_NAME}"
  fi

  cat > "$ENV_FILE" <<ENV
DATABASE_URL=postgres://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}
PORT=${APP_PORT}
LOG_LEVEL=info
SESSION_TTL_HOURS=8
ADMIN_USERNAME=admin
ADMIN_PASSWORD=${ADMIN_PASS}
SEED_USER_PASSWORD=${SEED_PASS}
CERT_EXTRA_IP=${PUBLIC_IP}
ENV
  chown "$APP_USER":"$APP_USER" "$ENV_FILE"; chmod 600 "$ENV_FILE"
  printf 'admin / %s\nagent+officer demo password / %s\n' "$ADMIN_PASS" "$SEED_PASS" > "$APP_DIR/CREDENTIALS.txt"
  chmod 600 "$APP_DIR/CREDENTIALS.txt"
else
  log ".env already present — keeping existing DB and secrets"
fi

# --- 5. deps, cert, schema, seed(once) ---
log "Installing dependencies"
( cd "$APP_SRC" && sudo -u "$APP_USER" env "PATH=$PATH" HOME="$APP_DIR" "$NPM_BIN" ci --omit=dev )
log "Generating self-signed certificate (SAN includes ${PUBLIC_IP})"
( cd "$APP_SRC" && sudo -u "$APP_USER" env "PATH=$PATH" HOME="$APP_DIR" CERT_EXTRA_IP="$PUBLIC_IP" "$NODE_BIN" scripts/gen-cert.js )
log "Applying schema"
( cd "$APP_SRC" && sudo -u "$APP_USER" env "PATH=$PATH" HOME="$APP_DIR" "$NODE_BIN" scripts/migrate.js )
if [ ! -f "$APP_DIR/.seeded" ]; then
  log "Seeding demo data (first run only — this is destructive, runs once)"
  ( cd "$APP_SRC" && sudo -u "$APP_USER" env "PATH=$PATH" HOME="$APP_DIR" "$NODE_BIN" scripts/seed.js )
  touch "$APP_DIR/.seeded"
else
  log "Seed already applied (found $APP_DIR/.seeded) — skipping to protect data"
fi

# --- 6. systemd service (own node path) ---
log "Installing systemd service"
cat > "/etc/systemd/system/${SERVICE}.service" <<UNIT
[Unit]
Description=AgentMS - Education Agent Management System
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_SRC}
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} src/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"

# --- 7. firewall: open ONLY our port ---
if command -v ufw >/dev/null 2>&1; then
  log "Opening port ${APP_PORT} in ufw"; ufw allow "${APP_PORT}/tcp" || true
fi

# --- 8. summary ---
sleep 2
log "Service status"
systemctl --no-pager --lines=0 status "$SERVICE" | head -5 || true
echo
echo "=========================================================="
echo " AgentMS deployed."
echo "   URL:   https://${PUBLIC_IP}:${APP_PORT}/login   (self-signed — click through the warning)"
echo "   Creds: ${APP_DIR}/CREDENTIALS.txt  (root only)"
echo "   Logs:  journalctl -u ${SERVICE} -f    ·    app logs in ${APP_SRC}/logs/"
echo " If it is not reachable externally, open TCP ${APP_PORT} in the DigitalOcean"
echo " cloud firewall (panel) — ufw alone is not enough when a cloud firewall is attached."
echo "=========================================================="
