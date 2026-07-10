#!/usr/bin/env bash
#
# Shivani — one-command installer for a fresh Ubuntu VM (GCP/AWS/DO/Hetzner).
#
# It installs Node 20, PostgreSQL 16 + pgvector, and build tools; fetches this
# repo from GitHub; builds it; provisions the database; and writes .env.
#
# USAGE (on the VM, as a sudo-capable user):
#
#   Public repo:
#     curl -fsSL https://raw.githubusercontent.com/Abhishekxdg/shivani-acred/main/install.sh | sudo -E bash
#
#   Private repo (needs a GitHub token with 'repo' read access):
#     curl -fsSL -H "Authorization: token $GHT" \
#       https://raw.githubusercontent.com/Abhishekxdg/shivani-acred/main/install.sh \
#       | sudo -E env GITHUB_TOKEN="$GHT" bash
#
# Pass config via env to run unattended, e.g.:
#   ... | sudo -E env GITHUB_TOKEN=xxx OPENROUTER_API_KEY=sk-or-xxx OPERATOR_JIDS=9178... bash
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

# ---- 2. Node.js 20 ---------------------------------------------------------
if ! command -v node >/dev/null || [[ "$(node -v | cut -c2-3)" -lt 20 ]]; then
  say "Installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
say "Node $(node -v), npm $(npm -v)"

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

# ---- 3. PostgreSQL 16 + pgvector ------------------------------------------
say "Installing PostgreSQL 16 + pgvector"
install -d /usr/share/postgresql-common/pgdg
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list
apt-get update -y
apt-get install -y postgresql-16 postgresql-contrib-16 postgresql-16-pgvector
systemctl enable --now postgresql

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
