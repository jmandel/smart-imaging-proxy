#!/usr/bin/env bash
# The whole stack in a minikube profile of its own, from nothing, then the browser test against it. Safe to
# repeat: a second run rebuilds the image and rolls it out, and keeps the data on the volume. Its kubeconfig
# stays in .run/, so it neither reads nor changes yours:
#
#   kubectl --kubeconfig .run/minikube.kubeconfig --context imaging-local -n smart-imaging get pods
#
# MINIKUBE_ARGS goes to `minikube start`. A machine running a kernel whose modules a package update has replaced
# can't give the docker driver's pods a network, and a VM brings its own kernel. QEMU's builtin network gives the
# VM no address the host can reach, so INGRESS_FORWARD=1 tests through a port-forward instead:
#
# PUBLIC_ORIGIN=https://name:port deploys under that name instead, for a host in front of the cluster such as
# `tailscale serve`.
#
#   MINIKUBE_ARGS="--driver=qemu --network=builtin --qemu-firmware-path=/usr/share/edk2/x64/OVMF_CODE.4m.fd" INGRESS_FORWARD=1 deploy/minikube.sh
set -euo pipefail
trap 'echo "minikube.sh: failed at line $LINENO" >&2' ERR
cd "$(dirname "$0")/.."
PROFILE=imaging-local NS=smart-imaging
ORIGIN=${PUBLIC_ORIGIN:-https://imaging-local.argo.run}
HOST=$(echo "$ORIGIN" | sed -E 's#^https://([^:/]+).*#\1#')
PORT=$(echo "$ORIGIN" | sed -nE 's#^https://[^:/]+:([0-9]+).*#\1#p'); PORT=${PORT:-443}
mkdir -p .run
export KUBECONFIG="$PWD/.run/minikube.kubeconfig"
K="kubectl --context $PROFILE -n $NS"

echo "== Cluster"
minikube status -p "$PROFILE" >/dev/null 2>&1 || timeout 600 minikube start -p "$PROFILE" --cpus=4 --memory=6g --disk-size=30g ${MINIKUBE_ARGS:-}
timeout 300 minikube addons enable ingress -p "$PROFILE" >/dev/null
kubectl --context "$PROFILE" -n ingress-nginx rollout status deploy/ingress-nginx-controller --timeout=180s
IP=$(minikube ip -p "$PROFILE")

echo "== Image"
minikube -p "$PROFILE" image build -f deploy/Dockerfile -t smart-imaging-proxy:local . | tail -1

echo "== Certificate"
[ -f ".run/tls-$HOST.crt" ] || mkcert -cert-file ".run/tls-$HOST.crt" -key-file ".run/tls-$HOST.key" "$HOST"

echo "== Deploy"
mkdir -p .run/overlay
cat > .run/overlay/kustomization.yaml <<EOF
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: $NS
resources:
  - ../../deploy/k8s/minikube
configMapGenerator:
  - name: smart-imaging-config
    behavior: merge
    literals:
      - DEMO_PUBLIC_URL=$ORIGIN
patches:
  - target: { kind: Ingress, name: smart-imaging }
    patch: |
      - { op: replace, path: /spec/tls/0/hosts/0, value: $HOST }
      - { op: replace, path: /spec/rules/0/host, value: $HOST }
EOF
kubectl --context "$PROFILE" apply -k .run/overlay
$K create secret tls smart-imaging-tls --cert=".run/tls-$HOST.crt" --key=".run/tls-$HOST.key" --dry-run=client -o yaml | kubectl --context "$PROFILE" apply -f -
$K rollout restart deploy/smart-imaging
# A new volume waits for the sample data, about 750 MB, and building the archive.
if ! $K rollout status deploy/smart-imaging --timeout="${ROLLOUT_TIMEOUT:-900s}"; then
  $K get pods; $K logs deploy/smart-imaging -c prepare --tail=30 || true; $K logs deploy/smart-imaging -c app --tail=30 || true
  exit 1
fi

echo "== Browser test"
RULES="MAP $HOST $IP"
VIA=(--connect-to "$HOST:$PORT:$IP:443")
if [ "${INGRESS_FORWARD:-}" ]; then
  kubectl --context "$PROFILE" -n ingress-nginx port-forward svc/ingress-nginx-controller 18443:443 >/dev/null &
  FORWARD=$!; trap 'kill $FORWARD 2>/dev/null || true' EXIT
  RULES="MAP $HOST:* 127.0.0.1:18443"
  VIA=(--connect-to "$HOST:$PORT:127.0.0.1:18443")
fi
# The ingress can answer 503 for a moment after a rollout, so wait for the page itself.
READY=
for _ in $(seq 1 60); do curl -skf -m 3 -o /dev/null "${VIA[@]}" "$ORIGIN/" && { READY=1; break; }; read -rt 1 <> <(:) || true; done
[ "$READY" ] || { echo "$ORIGIN never answered 200 through the ingress" >&2; exit 1; }
[ "${SKIP_TEST:-}" ] || BASE_URL="$ORIGIN" HOST_RULES="$RULES" timeout -k 5 90 bun test --timeout 40000 ./e2e/client.e2e.ts

[ "${INGRESS_FORWARD:-}" ] || grep -q "$IP.*$HOST" /etc/hosts 2>/dev/null || echo "Add to /etc/hosts: $IP $HOST"
echo "Running at $ORIGIN/"
