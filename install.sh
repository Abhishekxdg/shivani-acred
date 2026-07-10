#!/usr/bin/env bash
#
# Shivani — one-command installer for a fresh Ubuntu VM.
# Detects what's present, installs what's missing (with live status), prints the
# full config, then links WhatsApp (QR) and leaves her running as a service.
#
#   curl -fsSL https://raw.githubusercontent.com/Abhishekxdg/shivani-acred/main/install.sh | sudo bash
#
# If you don't pass OPENROUTER_API_KEY, the installer PROMPTS you for it on the
# terminal. You can still pass it (and other config) up front if you prefer:
#   ... | sudo env OPENROUTER_API_KEY=sk-or-xxx OPERATOR_JIDS=9178... bash
#
set -uo pipefail

# ---- config (override via env) --------------------------------------------
REPO_URL="${REPO_URL:-https://github.com/Abhishekxdg/shivani-acred.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/cos-agent}"
RUN_USER="${RUN_USER:-cos}"
PG_DB="${PG_DB:-shivani}"
PG_USER="${PG_USER:-shivani}"
PG_PASS="${PG_PASS:-$(openssl rand -hex 16 2>/dev/null || echo changeme$RANDOM)}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
SKIP_LINK="${SKIP_LINK:-0}"

# ---- pretty output ---------------------------------------------------------
B=$'\033[1m'; DIM=$'\033[2m'; G=$'\033[1;32m'; Y=$'\033[1;33m'; R=$'\033[1;31m'; C=$'\033[1;36m'; N=$'\033[0m'
step() { printf '\n%s▶ %s%s\n' "$C" "$*" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
add()  { printf '  %s+%s %s\n' "$Y" "$N" "$*"; }
miss() { printf '  %s•%s %s\n' "$DIM" "$N" "$*"; }
warn() { printf '  %s! %s%s\n' "$Y" "$*" "$N"; }
die()  { printf '\n%s✗ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run with sudo (root)."
export DEBIAN_FRONTEND=noninteractive

node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'; }
have_node() { command -v node >/dev/null 2>&1 && [ "$(node_major)" -ge 22 ] 2>/dev/null; }

printf '%s\n' "${B}================ Shivani installer ================${N}"
printf '%s\n' "Target: ${APP_DIR}  ·  Ubuntu $(lsb_release -rs 2>/dev/null || echo '?') ($(lsb_release -cs 2>/dev/null || echo '?'))"

# ---- 1. preflight: what's here, what's needed -----------------------------
step "1/9  Checking what's already installed"
NEED_BASE=0; NEED_NODE=0; NEED_PG=0; NEED_CHROME=0
command -v git >/dev/null && command -v gcc >/dev/null && ok "build tools + git" || { miss "build tools + git — will install"; NEED_BASE=1; }
have_node && ok "Node $(node -v)" || { miss "Node >= 22 — will install"; NEED_NODE=1; }
command -v psql >/dev/null && ok "PostgreSQL $(psql --version 2>/dev/null | grep -oE '[0-9]+' | head -1)" || { miss "PostgreSQL — will install"; NEED_PG=1; }
command -v google-chrome-stable >/dev/null && ok "Google Chrome" || { miss "Google Chrome — will install"; NEED_CHROME=1; }
[ -d "$APP_DIR/.git" ] && ok "existing checkout at $APP_DIR (will update)" || miss "code — will clone into $APP_DIR"

# ---- collect the OpenRouter key up front (prompted on the terminal) --------
is_placeholder() { case "$1" in ""|*"..."*|*"YOUR"*|*"REPLACE"*) return 0;; *) return 1;; esac; }
if ! is_placeholder "${OPENROUTER_API_KEY:-}"; then
  ok "OpenRouter key provided (…${OPENROUTER_API_KEY: -4})"
elif [ -r /dev/tty ]; then
  printf '\n%sEnter your OpenRouter API key%s (sk-or-…, or press Enter to set it later): ' "$C" "$N" > /dev/tty
  read -rs _key < /dev/tty; printf '\n' > /dev/tty
  if [ -n "${_key:-}" ]; then
    OPENROUTER_API_KEY="$_key"; ok "OpenRouter key captured (…${_key: -4})"
  else
    warn "no key entered — add OPENROUTER_API_KEY to $APP_DIR/.env later, then restart the service"
  fi
else
  warn "no terminal to prompt on — set OPENROUTER_API_KEY in $APP_DIR/.env after install"
fi

# ---- 2. base packages ------------------------------------------------------
step "2/9  Base packages"
if [ "$NEED_BASE" = 1 ]; then
  add "installing curl, git, build-essential, python3, openssl…"
  apt-get update -y >/dev/null 2>&1 || die "apt-get update failed"
  apt-get install -y curl ca-certificates gnupg lsb-release git build-essential python3 openssl >/dev/null 2>&1 \
    || die "failed to install base packages"
  ok "base packages installed"
else
  ok "already present"
fi

# ---- 3. Node.js >= 20 ------------------------------------------------------
step "3/9  Node.js"
if [ "$NEED_NODE" = 1 ]; then
  add "installing Node.js 22 via NodeSource…"
  curl -fsSL https://deb.nodesource.com/setup_22.x 2>/dev/null | bash - >/dev/null 2>&1 || true
  apt-get install -y nodejs >/dev/null 2>&1 || true
  have_node || { add "NodeSource unavailable — using distro Node.js…"; apt-get install -y nodejs npm >/dev/null 2>&1 || true; }
  have_node || die "could not install Node.js >= 22 (puppeteer + supabase require it)"
fi
ok "Node $(node -v), npm $(npm -v 2>/dev/null || echo '?')"

# ---- 4. Chromium runtime libraries (headless-browser web search) ----------
step "4/9  Google Chrome (for real web browsing)"
if command -v google-chrome-stable >/dev/null 2>&1; then
  ok "Google Chrome already present"
else
  add "installing Google Chrome stable (brings its own libraries)…"
  _deb=/tmp/google-chrome.deb
  if curl -fsSL -o "$_deb" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb 2>/dev/null \
     && apt-get install -y "$_deb" >/dev/null 2>&1; then
    ok "Google Chrome installed"
  else
    warn "Chrome .deb install failed — web browsing may be unavailable (continuing)"
  fi
  rm -f "$_deb"
fi
CHROME_BIN="$(command -v google-chrome-stable || echo /usr/bin/google-chrome-stable)"

# ---- 5. PostgreSQL + pgvector (version-adaptive) --------------------------
step "5/9  PostgreSQL + pgvector"
CODENAME="$(lsb_release -cs 2>/dev/null || echo '')"
if [ "$NEED_PG" = 1 ]; then
  if [ -n "$CODENAME" ] && curl -fsI "https://apt.postgresql.org/pub/repos/apt/dists/${CODENAME}-pgdg/InRelease" >/dev/null 2>&1; then
    add "adding PGDG repo for ${CODENAME}…"
    install -d /usr/share/postgresql-common/pgdg
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc 2>/dev/null
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list
    apt-get update -y >/dev/null 2>&1 || true
  else
    add "no PGDG for '${CODENAME:-?}' — using the distro PostgreSQL"
  fi
  apt-get install -y postgresql postgresql-contrib >/dev/null 2>&1 || die "failed to install PostgreSQL"
fi
systemctl enable --now postgresql >/dev/null 2>&1 || true
PGVER="$(ls -1 /usr/lib/postgresql/ 2>/dev/null | grep -E '^[0-9]+$' | sort -n | tail -1)"
[ -z "$PGVER" ] && PGVER="$(pg_config --version 2>/dev/null | grep -oE '[0-9]+' | head -1)"
ok "PostgreSQL ${PGVER:-?} running"

# pgvector: packaged, else build from source
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_available_extensions WHERE name='vector'" 2>/dev/null | grep -q 1; then
  ok "pgvector available"
elif apt-get install -y "postgresql-${PGVER}-pgvector" >/dev/null 2>&1; then
  ok "pgvector installed (package)"
else
  add "building pgvector from source…"
  apt-get install -y "postgresql-server-dev-${PGVER}" make gcc git >/dev/null 2>&1
  _pv="$(mktemp -d)"
  git clone --depth 1 https://github.com/pgvector/pgvector.git "$_pv/pgvector" >/dev/null 2>&1 \
    && make -C "$_pv/pgvector" >/dev/null 2>&1 && make -C "$_pv/pgvector" install >/dev/null 2>&1 \
    && ok "pgvector built + installed" || warn "pgvector build failed — semantic memory will use keyword fallback"
  rm -rf "$_pv"
fi

# provision role + db + extension (idempotent; password kept in sync)
add "provisioning database '${PG_DB}'…"
sudo -u postgres psql >/dev/null 2>&1 <<SQL
DO \$\$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='${PG_USER}') THEN
    ALTER ROLE ${PG_USER} LOGIN PASSWORD '${PG_PASS}';
  ELSE
    CREATE ROLE ${PG_USER} LOGIN PASSWORD '${PG_PASS}';
  END IF;
END \$\$;
SELECT 'CREATE DATABASE ${PG_DB} OWNER ${PG_USER}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='${PG_DB}')\gexec
SQL
sudo -u postgres psql -d "${PG_DB}" -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null 2>&1 \
  && ok "database ready (pgvector enabled)" || warn "pgvector extension not enabled (keyword-memory fallback)"
DATABASE_URL="postgresql://${PG_USER}:${PG_PASS}@localhost:5432/${PG_DB}"

# ---- 6. fetch the code -----------------------------------------------------
step "6/9  Fetching Shivani"
CLONE_URL="$REPO_URL"
[ -n "$GITHUB_TOKEN" ] && CLONE_URL="${REPO_URL/https:\/\//https://x-access-token:${GITHUB_TOKEN}@}"
if [ -d "$APP_DIR/.git" ]; then
  add "updating existing checkout…"
  git -C "$APP_DIR" remote set-url origin "$CLONE_URL" 2>/dev/null
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH" >/dev/null 2>&1 && git -C "$APP_DIR" reset --hard "origin/$BRANCH" >/dev/null 2>&1 \
    || die "git update failed"
else
  add "cloning $REPO_URL…"
  git clone --depth 1 --branch "$BRANCH" "$CLONE_URL" "$APP_DIR" >/dev/null 2>&1 || die "git clone failed (is the repo public / token valid?)"
fi
git -C "$APP_DIR" remote set-url origin "$REPO_URL" 2>/dev/null
ok "code at $APP_DIR ($(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null))"

# ---- 7. build --------------------------------------------------------------
step "7/9  Installing dependencies + building (downloads Chromium ~150MB)"
cd "$APP_DIR" || die "cannot enter $APP_DIR"
# Use the system Google Chrome, not Puppeteer's bundled download (flaky on fresh
# VMs) — skip that download entirely and clear any half-downloaded cache.
export PUPPETEER_SKIP_DOWNLOAD=true
rm -rf "$APP_DIR/.cache/puppeteer" 2>/dev/null || true
NPMLOG=/tmp/shivani-npm.log
add "installing npm dependencies…"
if ! npm ci >"$NPMLOG" 2>&1; then
  add "npm ci failed — retrying with npm install…"
  if ! npm install >"$NPMLOG" 2>&1; then
    printf '%s---- last 30 lines of %s ----%s\n' "$DIM" "$NPMLOG" "$N"; tail -30 "$NPMLOG"
    die "npm install failed — full log at $NPMLOG"
  fi
fi
add "building…"
if ! npm run build >/tmp/shivani-build.log 2>&1; then
  tail -30 /tmp/shivani-build.log; die "build failed — full log at /tmp/shivani-build.log"
fi
ok "built ($(node -e "import('./dist/agent/tools/index.js').then(m=>console.log(m.tools.length+' tools'))" 2>/dev/null || echo 'ok'))"

# ---- 8. .env + ownership ---------------------------------------------------
step "8/9  Configuration"
[ -f "$APP_DIR/.env" ] || { cp "$APP_DIR/.env.example" "$APP_DIR/.env"; add "created .env from template"; }
set_env() {
  local k="$1" v="$2"
  if grep -q "^${k}=" "$APP_DIR/.env"; then sed -i "s#^${k}=.*#${k}=${v}#" "$APP_DIR/.env"; else printf '%s=%s\n' "$k" "$v" >> "$APP_DIR/.env"; fi
}
set_env DATABASE_URL "$DATABASE_URL"
set_env REPO_ROOT "$APP_DIR"
set_env PUPPETEER_EXECUTABLE_PATH "$CHROME_BIN"
[ -n "${OPENROUTER_API_KEY:-}" ] && set_env OPENROUTER_API_KEY "$OPENROUTER_API_KEY"
[ -n "${OPERATOR_JIDS:-}" ] && set_env OPERATOR_JIDS "$OPERATOR_JIDS"
id -u "$RUN_USER" >/dev/null 2>&1 || useradd -r -m -s /usr/sbin/nologin "$RUN_USER"
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR"
ok "configuration written; $APP_DIR owned by $RUN_USER"

# ---- settings summary ------------------------------------------------------
getenv() { grep -E "^$1=" "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-; }
KEY="$(getenv OPENROUTER_API_KEY)"
case "$KEY" in ""|*"..."*|*"YOUR"*|*"REPLACE"*) KEYSTATE="${R}NOT SET — edit $APP_DIR/.env before she can think${N}";; *) KEYSTATE="set (…${KEY: -4})";; esac
printf '\n%s──────── SETTINGS (full file: %s/.env) ────────%s\n' "$B" "$APP_DIR" "$N"
printf '  %-16s %s\n' "App dir"       "$APP_DIR"
printf '  %-16s %s\n' "Repo"          "$REPO_URL"
printf '  %-16s %s\n' "Node"          "$(node -v)"
printf '  %-16s %s\n' "PostgreSQL"    "${PGVER:-?}"
printf '  %-16s %s\n' "Database"      "postgresql://${PG_USER}:********@localhost:5432/${PG_DB}"
printf '  %-16s %s\n' "Agent"         "$(getenv AGENT_NAME) — $(getenv COMPANY_NAME)"
printf '  %-16s %s\n' "Model"         "$(getenv OPENROUTER_MODEL)"
printf '  %-16s %s\n' "OpenRouter key" "$KEYSTATE"
printf '  %-16s %s\n' "Operator no."  "$(getenv OPERATOR_JIDS)"
printf '  %-16s %s\n' "Founders"      "$(getenv FOUNDERS)"
printf '  %-16s %s\n' "Founders group" "$(getenv FOUNDERS_GROUP_JID | sed 's/^$/(not set yet)/')"
printf '  %-16s %s\n' "Timezone"      "$(getenv TZ)"
printf '  %-16s %s\n' "Web browsing"  "system Google Chrome (no API key)"
printf '  %-16s %s\n' "Service user"  "$RUN_USER"
printf '%s────────────────────────────────────────────────%s\n' "$B" "$N"

# ---- 9. link WhatsApp + go live -------------------------------------------
NODE_BIN="$(command -v node)"
gen_unit() { # $1 unit filename  $2 ExecStart
  cat > "/etc/systemd/system/$1" <<UNIT
[Unit]
Description=Shivani — ACRED AI chief of staff
After=network-online.target postgresql.service
Wants=network-online.target
[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=$2
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PUPPETEER_EXECUTABLE_PATH=$CHROME_BIN
[Install]
WantedBy=multi-user.target
UNIT
}
enable_service() {
  systemctl daemon-reload
  gen_unit shivani-watchdog.service "$NODE_BIN $APP_DIR/dist/evolve/watchdog.js"
  systemctl enable --now shivani-watchdog.service >/dev/null 2>&1 || true
  sleep 4
  if systemctl is-active --quiet shivani-watchdog.service; then ok "Running as service: shivani-watchdog (self-deploy + auto-rollback)"; return 0; fi
  warn "watchdog didn't start — falling back to the direct service"
  systemctl disable --now shivani-watchdog.service >/dev/null 2>&1 || true
  gen_unit shivani.service "$NODE_BIN $APP_DIR/dist/index.js"
  systemctl enable --now shivani.service >/dev/null 2>&1 || true
  sleep 3
  systemctl is-active --quiet shivani.service && ok "Running as service: shivani (direct)" || warn "service didn't start — check: journalctl -u shivani -n 50"
}

# Stop any already-running service FIRST so only ONE process ever connects to
# WhatsApp — two concurrent sessions on the same creds get logged out (515/401).
systemctl stop shivani-watchdog shivani >/dev/null 2>&1 || true
sleep 1

attempt_link() { # 0 = connected, 2 = logged-out (dead creds), 1 = timeout
  local log; log="$(mktemp)"; local rc=1
  ( sudo -u "$RUN_USER" env PUPPETEER_EXECUTABLE_PATH="$CHROME_BIN" \
      bash -c "cd '$APP_DIR' && node dist/index.js" 2>&1 | tee "$log" ) &
  for _ in $(seq 1 240); do
    grep -q "WhatsApp connected" "$log" 2>/dev/null && { rc=0; break; }
    grep -q "Logged out" "$log" 2>/dev/null && { rc=2; break; }
    sleep 1
  done
  sudo -u "$RUN_USER" pkill -f "dist/index.js" >/dev/null 2>&1 || true
  wait >/dev/null 2>&1 || true
  rm -f "$log"
  return $rc
}

if [ "$SKIP_LINK" = 1 ]; then
  step "9/9  WhatsApp link skipped (SKIP_LINK=1)"
  echo "  Link later: sudo -u $RUN_USER bash -c 'cd $APP_DIR && npm start'  (scan QR)"
  enable_service
else
  step "9/9  Link WhatsApp — scan the QR below (WhatsApp → Linked Devices)"
  echo "  Waiting up to 4 minutes for you to scan…"
  attempt_link; RC=$?
  if [ "$RC" = 2 ]; then
    warn "existing session expired/conflicted — clearing it and showing a fresh QR"
    rm -rf "$APP_DIR/data/wa-auth"
    attempt_link; RC=$?
  fi
  sleep 3  # let the link socket fully close before the service reconnects
  if [ "$RC" = 0 ]; then ok "WhatsApp linked ✅"; enable_service
  else warn "QR not scanned / link failed — re-run this installer to try again."; fi
fi

printf '\n%s================ READY TO GO ================%s\n' "$G" "$N"
echo "Message the VM's WhatsApp from the operator number (${B}$(getenv OPERATOR_JIDS)${N}) — try: !status"
[ "${KEYSTATE#*NOT SET}" != "$KEYSTATE" ] && echo "${Y}First set a real OPENROUTER_API_KEY in $APP_DIR/.env, then: sudo systemctl restart shivani-watchdog${N}"
echo "Logs: ${DIM}journalctl -u shivani-watchdog -f${N}   ·   Config: ${DIM}$APP_DIR/.env${N}"
