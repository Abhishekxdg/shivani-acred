#!/usr/bin/env bash
set -euo pipefail

# Provision an Ubuntu GCP VM to run the COS Agent.
# Run this ON the VM (e.g. after `gcloud compute ssh <instance>`).

APP_DIR="${APP_DIR:-/opt/cos-agent}"

echo ">> Installing Node.js 20 + build tools (better-sqlite3 needs a compiler)"
sudo apt-get update
sudo apt-get install -y curl git build-essential python3
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo ">> Creating app dir at $APP_DIR"
sudo mkdir -p "$APP_DIR"
sudo chown -R "$USER":"$USER" "$APP_DIR"

cat <<EOF

Next steps
----------
1. Get the code onto the VM (choose one):
     git clone <your-repo> "$APP_DIR"
     # or from your laptop:  gcloud compute scp --recurse ./cos-agent <instance>:$APP_DIR

2. Build & configure:
     cd "$APP_DIR"
     npm ci
     npm run build
     cp .env.example .env      # then edit .env: OPENROUTER_API_KEY, OPERATOR_JIDS, etc.

3. FIRST run interactively to link WhatsApp (prints a QR to scan once):
     npm start
     # Scan with WhatsApp > Linked Devices. Auth is saved in ./data/wa-auth.
     # Ctrl-C once you see "WhatsApp connected."

4. Run it as a background service (survives reboots/crashes):
     sudo cp deploy/cos-agent.service /etc/systemd/system/
     sudo useradd -r -s /usr/sbin/nologin cos 2>/dev/null || true
     sudo chown -R cos:cos "$APP_DIR"     # (skip if you set User=root in the unit)
     sudo systemctl daemon-reload
     sudo systemctl enable --now cos-agent
     journalctl -u cos-agent -f            # watch logs

Note: the WhatsApp QR must be scanned from an interactive terminal (step 3)
before enabling the service, since systemd has no TTY to show it.
EOF
