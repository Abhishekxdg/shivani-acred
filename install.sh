#!/usr/bin/env bash
#
# Shivani — one-command installer for a fresh Ubuntu VM (GCP/AWS/DO/Hetzner).
#
# Installs Node >=20, PostgreSQL + pgvector, Chromium libs, and build tools;
# fetches this repo from GitHub; builds it; provisions the database; writes .env.
#
# USAGE (on a fresh Ubuntu VM, as a sudo-capable user) — public repo, no token:
#
#   curl -fsSL https://raw.githubusercontent.com/Abhishekxdg/shivani-acred/main/install.sh \
#     | sudo env OPENROUTER_API_KEY=sk-or-xxx bash
#
# You can pass more config the same way (OPERATOR_JIDS=..., etc.), or edit .env
# after. (A private repo would also take: env GITHUB_TOKEN=xxx.)
#
set -euo pipefail

# ---- config (override via env) --------------------------------------------
REPO_URL="${REPO_URL:-https://github.com/Abhishekxdg/shivani-acred.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/cos-agent}"
RUN_USER="${RUN_USER:-cos}"
PG_DB="${PG_DB:-shivani}"
PG_USER="${PG_USER:-shivani}"
PG_PASS="${PG_PASS:-$(openssl rand -hex 16)}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"

say() { printf '\n\033[1;36m>> %s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then echo "Run with sudo (root)." >&2; exit 1; fi

# ---- 1. system packages ----------------------------------------------------
say "Installing base packages (git, build tools, curl, openssl)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg lsb-release git build-essential python3 openssl

# ---- 2. Node.js >= 20 ------------------------------------------------------
node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'; }
have_node20() { command -v node >/dev/null 2>&1 && [ "$(node_major)" -ge 20 ] 2>/dev/null; }
if ! have_node20; then
  say "Installing Node.js 20 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - 2>/dev/null || true
  apt-get install -y nodejs 2>/dev/null || true
fi
if ! have_node20; then
  say "NodeSource unavailable for this release — installing the distro Node.js"
  apt-get install -y nodejs npm || true
fi
have_node20 || { echo "ERROR: could not install Node.js >= 20" >&2; exit 1; }
say "Node $(node -v), npm $(npm -v 2>/dev/null || echo '?')"

# ---- 2b. Chromium runtime libraries (for the headless browser web search) --
say "Installing Chromium runtime libraries"
CHROME_DEPS="ca-certificates fonts-liberation libatk-bridge2.0-0 libatk1.0-0 \
libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 libgbm1 libglib2.0-0 libgtk-3-0 \
libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 \
libxext6 libxfixes3 libxkbcommon0 libxrandr2 xdg-utils"
# libasound2 was renamed to libasound2t64 on Ubuntu 24.04 — try both.
apt-get install -y $CHROME_DEPS libasound2t64 \
  || apt-get install -y $CHROME_DEPS libasound2 \
  || apt-get install -y $CHROME_DEPS || true

# ---- 3. PostgreSQL + pgvector (version-adaptive) --------------------------
say "Installing PostgreSQL + pgvector"
CODENAME="$(lsb_release -cs 2>/dev/null || echo '')"
# Use the official PGDG repo only if it actually has packages for this release;
# otherwise fall back to the distro's own PostgreSQL (works on brand-new Ubuntu).
if [ -n "$CODENAME" ] && \
   curl -fsI "https://apt.postgresql.org/pub/repos/apt/dists/${CODENAME}-pgdg/InRelease" >/dev/null 2>&1; then
  say "Using PGDG repo for ${CODENAME}"
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
https://apt.postgresql.org/pub/repos/apt ${CODENAME}-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  apt-get update -y || true
else
  say "No PGDG packages for '${CODENAME:-unknown}' — using the distro PostgreSQL"
fi
apt-get install -y postgresql postgresql-contrib
systemctl enable --now postgresql

# Detect the installed major version, then get pgvector (packaged, else source).
PGVER="$(ls -1 /usr/lib/postgresql/ 2>/dev/null | grep -E '^[0-9]+$' | sort -n | tail -1)"
[ -z "$PGVER" ] && PGVER="$(pg_config --version 2>/dev/null | grep -oE '[0-9]+' | head -1)"
say "PostgreSQL major version: ${PGVER:-unknown}"
if ! apt-get install -y "postgresql-${PGVER}-pgvector" 2>/dev/null; then
  say "Building pgvector from source for PG ${PGVER}"
  apt-get install -y "postgresql-server-dev-${PGVER}" make gcc git
  _pv="$(mktemp -d)"
  git clone --depth 1 https://github.com/pgvector/pgvector.git "$_pv/pgvector"
  make -C "$_pv/pgvector"
  make -C "$_pv/pgvector" install
  rm -rf "$_pv"
fi

say "Provisioning database $PG_DB"
sudo -u postgres psql <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${PG_USER}') THEN
    CREATE ROLE ${PG_USER} LOGIN PASSWORD '${PG_PASS}';
  END IF;
END \$\$;
SELECT 'CREATE DATABASE ${PG_DB} OWNER ${PG_USER}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${PG_DB}')\gexec
SQL
sudo -u postgres psql -d "${PG_DB}" -c "CREATE EXTENSION IF NOT EXISTS vector;"
DATABASE_URL="postgresql://${PG_USER}:${PG_PASS}@localhost:5432/${PG_DB}"

# ---- 4. fetch the code -----------------------------------------------------
CLONE_URL="$REPO_URL"
if [[ -n "$GITHUB_TOKEN" ]]; then
  CLONE_URL="${REPO_URL/https:\/\//https://x-access-token:${GITHUB_TOKEN}@}"
fi
if [[ -d "$APP_DIR/.git" ]]; then
  say "Updating existing checkout at $APP_DIR"
  git -C "$APP_DIR" remote set-url origin "$CLONE_URL"
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  say "Cloning $REPO_URL into $APP_DIR"
  git clone --depth 1 --branch "$BRANCH" "$CLONE_URL" "$APP_DIR"
fi
# Don't leave the token in the stored remote.
git -C "$APP_DIR" remote set-url origin "$REPO_URL"

# ---- 5. build --------------------------------------------------------------
say "Installing dependencies + building (this downloads Chromium)"
cd "$APP_DIR"
# Keep Puppeteer's Chromium inside the app dir so the service user can find it.
export PUPPETEER_CACHE_DIR="$APP_DIR/.cache/puppeteer"
npm ci
npm run build

# ---- 6. .env ---------------------------------------------------------------
if [[ ! -f "$APP_DIR/.env" ]]; then
  say "Creating .env from template"
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
fi
set_env() { # key value  — set or replace a key in .env
  local k="$1" v="$2"
  if grep -q "^${k}=" "$APP_DIR/.env"; then
    sed -i "s#^${k}=.*#${k}=${v//#/\\#}#" "$APP_DIR/.env"
  else
    printf '%s=%s\n' "$k" "$v" >> "$APP_DIR/.env"
  fi
}
set_env DATABASE_URL "$DATABASE_URL"
set_env REPO_ROOT "$APP_DIR"
set_env PUPPETEER_CACHE_DIR "$APP_DIR/.cache/puppeteer"
[[ -n "${OPENROUTER_API_KEY:-}" ]] && set_env OPENROUTER_API_KEY "$OPENROUTER_API_KEY"
[[ -n "${OPERATOR_JIDS:-}" ]]      && set_env OPERATOR_JIDS "$OPERATOR_JIDS"

# ---- 7. run user + ownership ----------------------------------------------
id -u "$RUN_USER" >/dev/null 2>&1 || useradd -r -m -s /usr/sbin/nologin "$RUN_USER"
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR"

cat <<DONE

============================================================================
✅ Shivani installed at $APP_DIR
   Database: $DATABASE_URL   (password saved in .env — keep it safe)

NEXT STEPS
1) Set your OpenRouter key (if not passed in):  nano $APP_DIR/.env   (OPENROUTER_API_KEY=...)
   and confirm OPERATOR_JIDS, FOUNDERS, FOUNDERS_GROUP_JID.

2) Link WhatsApp — run once interactively to scan the QR:
      cd $APP_DIR && sudo -u $RUN_USER npm start
   Scan it in WhatsApp > Linked Devices, wait for "WhatsApp connected", then Ctrl-C.

3) Run it as a supervised service (survives reboots, self-deploy + auto-rollback):
      sudo cp $APP_DIR/deploy/shivani-watchdog.service /etc/systemd/system/
      sudo systemctl daemon-reload && sudo systemctl enable --now shivani-watchdog
      journalctl -u shivani-watchdog -f
============================================================================
DONE
