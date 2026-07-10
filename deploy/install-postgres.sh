#!/usr/bin/env bash
set -euo pipefail

# Install PostgreSQL + pgvector on the Ubuntu VM and create Shivani's brain DB.
# Run ON the VM. Prints the DATABASE_URL to put in .env at the end.

PG_DB="${PG_DB:-shivani}"
PG_USER="${PG_USER:-shivani}"
PG_PASS="${PG_PASS:-$(openssl rand -hex 16)}"

echo ">> Adding the official PostgreSQL (PGDG) apt repo"
sudo apt-get update
sudo apt-get install -y curl ca-certificates gnupg lsb-release
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  | sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null

echo ">> Installing PostgreSQL 16 + pgvector"
sudo apt-get update
sudo apt-get install -y postgresql-16 postgresql-contrib-16 postgresql-16-pgvector

sudo systemctl enable --now postgresql

echo ">> Creating role + database + enabling pgvector"
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

echo ""
echo "==================================================================="
echo "PostgreSQL + pgvector ready."
echo "Add this line to cos-agent/.env  (Shivani creates her tables on boot):"
echo ""
echo "  DATABASE_URL=postgresql://${PG_USER}:${PG_PASS}@localhost:5432/${PG_DB}"
echo ""
echo "(Password was generated for you: ${PG_PASS} — store it safely.)"
echo "==================================================================="
