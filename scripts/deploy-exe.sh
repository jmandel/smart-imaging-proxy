#!/usr/bin/env bash
# Deploys this checkout's committed code to an exe.dev VM, creating the VM if it doesn't exist.
# Needs an exe.dev account whose SSH key this machine uses. The VM's addresses come from exe.dev's
# own listing, and its web proxy forwards to the one origin's port, 4605. The proxy stays private
# (exe.dev login) until you run `ssh exe.dev share set-public <vm>`.
#
#   scripts/deploy-exe.sh my-imaging-vm
#   DEMO_APP_CLIENTS=share-app=https://share.example/callback/ scripts/deploy-exe.sh my-imaging-vm
set -euo pipefail

VM="${1:?usage: scripts/deploy-exe.sh <vm-name>}"
cd "$(dirname "$0")/.."
[ -z "$(git status --porcelain --untracked-files=no)" ] || echo "note: uncommitted changes aren't deployed; this sends HEAD ($(git rev-parse --short HEAD))"

vm_json() { ssh exe.dev ls --json | bun -e 'const v = (await Bun.stdin.json()).vms.find(v => v.vm_name === process.argv[1]); if (v) console.log(JSON.stringify(v));' "$VM"; }
info="$(vm_json)"
if [ -z "$info" ]; then
  echo "== Creating $VM"
  ssh exe.dev new --name="$VM" --no-email --json >/dev/null
  info="$(vm_json)"
fi
field() { bun -e 'console.log(JSON.parse(process.argv[1])[process.argv[2]] ?? "")' "$info" "$1"; }
DEST="$(field ssh_dest)"; URL="$(field https_url)"
[ -n "$DEST" ] && [ -n "$URL" ] || { echo "deploy: exe.dev didn't list $VM's addresses" >&2; exit 1; }
echo "== $VM: ssh $DEST, $URL"
# exe.dev VMs present exe.dev's own host key. Pin it for this VM, from the exe.dev entry this machine
# already trusts, and only if that entry has exe.dev's published fingerprint.
HOST="$(field ssh_host)"
if ! ssh-keygen -F "$HOST" >/dev/null; then
  KEY="$(ssh-keygen -F exe.dev | grep -v '^#' | head -1 | cut -d' ' -f2-)"
  [ "$(ssh-keygen -lf <(echo "exe.dev $KEY") | cut -d' ' -f2)" = "SHA256:JJOP/lwiBGOMilfONPWZCXUrfK154cnJFXcqlsi6lPo" ] \
    || { echo "deploy: exe.dev's host key here doesn't have its published fingerprint; run ssh exe.dev once and check it" >&2; exit 1; }
  echo "$HOST $KEY" >> ~/.ssh/known_hosts
fi
for _ in $(seq 1 60); do ssh -o BatchMode=yes -o ConnectTimeout=10 "$DEST" true 2>/dev/null && break; sleep 5; done

echo "== Copying $(git rev-parse --short HEAD)"
REL="smart-imaging-proxy/releases/$(git rev-parse --short HEAD)"
git archive --format=tar HEAD | ssh "$DEST" "mkdir -p ~/$REL && tar -x -C ~/$REL && ln -sfn ~/$REL ~/smart-imaging-proxy/current"

ssh "$DEST" "cd ~/smart-imaging-proxy/current && DEMO_PUBLIC_URL=$(printf %q "$URL") DEMO_APP_CLIENTS=$(printf %q "${DEMO_APP_CLIENTS:-}") bash deploy/install.sh"
ssh exe.dev share port "$VM" 4605 >/dev/null
echo "== Done: $URL/browse (private until: ssh exe.dev share set-public $VM)"
