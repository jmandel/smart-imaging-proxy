#!/usr/bin/env bash
# Installs or updates the SMART Imaging Proxy on a Linux machine with systemd and Docker, from the checkout this
# script is in, and runs it as a service. Safe to repeat: finished steps are skipped quickly.
#
#   DEMO_PUBLIC_URL=https://imaging.example.org deploy/install.sh
#
# Settings it reads, and writes to $ENV_FILE for the service:
#   DEMO_PUBLIC_URL   the origin people and apps use; its host forwards to port 4605 (required)
#   DEMO_APP_CLIENTS  public clients beyond the demo's own, as client_id=redirect_uri pairs (optional)
#   DEMO_STORAGE      archive, SQLite files, backend volumes, and downloads (default /var/lib/smart-imaging-proxy)
set -euo pipefail
trap 'echo "install: failed at line $LINENO" >&2' ERR

: "${DEMO_PUBLIC_URL:?set DEMO_PUBLIC_URL to the origin people and apps use, such as https://imaging.example.org}"
APP="$(cd "$(dirname "$0")/.." && pwd)"
STORAGE="${DEMO_STORAGE:-/var/lib/smart-imaging-proxy}"
ENV_FILE="${ENV_FILE:-/etc/smart-imaging-proxy.env}"
UNIT=smart-imaging-proxy
BUN_VERSION=1.4.3
SUDO=$([ "$(id -u)" = 0 ] && echo "" || echo sudo)
USER_NAME="$(id -un)"

echo "== Tools"
missing=()
for t in dcmconv dcmcjpeg dcmodify; do command -v "$t" >/dev/null || missing+=(dcmtk); done
for t in curl tar unzip; do command -v "$t" >/dev/null || missing+=("$t"); done
if [ ${#missing[@]} -gt 0 ]; then $SUDO apt-get update -q && $SUDO apt-get install -y -q $(printf '%s\n' "${missing[@]}" | sort -u); fi
docker compose version >/dev/null || { echo "install: needs Docker with Compose" >&2; exit 1; }
BUN="$HOME/.bun/bin/bun"
if [ "$("$BUN" --version 2>/dev/null)" != "$BUN_VERSION" ]; then curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION" >/dev/null; fi
"$BUN" --version

echo "== Settings"
$SUDO mkdir -p "$STORAGE" && $SUDO chown "$USER_NAME" "$STORAGE"
umask 077
cat > "$STORAGE/env.new" <<EOF
DEMO_PUBLIC_URL=$DEMO_PUBLIC_URL
DEMO_APP_CLIENTS=${DEMO_APP_CLIENTS:-}
DEMO_STORAGE=$STORAGE
SOURCES_DIR=$STORAGE/sources
DEMO_TAILNET=0
EOF
$SUDO install -m 600 -o root -g root "$STORAGE/env.new" "$ENV_FILE" && rm "$STORAGE/env.new"
umask 022
set -a; . <($SUDO cat "$ENV_FILE"); set +a

echo "== Data and backends"
cd "$APP"
"$BUN" install --frozen-lockfile
"$BUN" scripts/fetch-data.ts
"$BUN" scripts/ingest.ts
docker compose up -d
"$BUN" scripts/load-backends.ts

echo "== Service"
$SUDO tee "/etc/systemd/system/$UNIT.service" >/dev/null <<EOF
[Unit]
Description=SMART Imaging Proxy
After=network-online.target docker.service
Wants=network-online.target

[Service]
User=$USER_NAME
WorkingDirectory=$APP
EnvironmentFile=$ENV_FILE
ExecStart=$BUN src/main.ts
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
$SUDO systemctl daemon-reload
$SUDO systemctl enable "$UNIT" >/dev/null 2>&1
$SUDO systemctl restart "$UNIT"
for _ in $(seq 1 120); do curl -sf -o /dev/null "http://127.0.0.1:4605/fhir/.well-known/smart-configuration" && break; sleep 1; done
curl -sf "http://127.0.0.1:4605/fhir/.well-known/smart-configuration" | grep -q "\"issuer\":\"$DEMO_PUBLIC_URL\"" || { echo "install: the service didn't come up; see journalctl -u $UNIT" >&2; exit 1; }
echo "== Running at $DEMO_PUBLIC_URL"
