#!/usr/bin/env bash
# The whole stack in a minikube profile of its own, from nothing, then the browser test against it. Safe to
# repeat: a second run rebuilds the image and rolls it out, and keeps the data on the volume. Its kubeconfig
# stays in .run/, so it neither reads nor changes yours:
#
#   kubectl --kubeconfig .run/minikube.kubeconfig --context imaging-local -n smart-imaging get pods
#
# MINIKUBE_DRIVER picks the driver. A machine running a kernel whose modules a package update has replaced
# can't give the docker driver's pods a network, and MINIKUBE_DRIVER=virtualbox brings its own kernel.
set -euo pipefail
trap 'echo "minikube.sh: failed at line $LINENO" >&2' ERR
cd "$(dirname "$0")/.."
PROFILE=imaging-local HOST=imaging-local.argo.run NS=smart-imaging
mkdir -p .run
export KUBECONFIG="$PWD/.run/minikube.kubeconfig"
K="kubectl --context $PROFILE -n $NS"

echo "== Cluster"
minikube status -p "$PROFILE" >/dev/null 2>&1 || timeout 600 minikube start -p "$PROFILE" --cpus=4 --memory=6g --disk-size=30g ${MINIKUBE_DRIVER:+--driver="$MINIKUBE_DRIVER"}
timeout 300 minikube addons enable ingress -p "$PROFILE" >/dev/null
kubectl --context "$PROFILE" -n ingress-nginx rollout status deploy/ingress-nginx-controller --timeout=180s
IP=$(minikube ip -p "$PROFILE")

echo "== Image"
( eval "$(minikube -p "$PROFILE" docker-env)"; docker build -q -f deploy/Dockerfile -t smart-imaging-proxy:local . )

echo "== Certificate"
[ -f .run/tls.crt ] || mkcert -cert-file .run/tls.crt -key-file .run/tls.key "$HOST"

echo "== Deploy"
kubectl --context "$PROFILE" apply -k deploy/k8s/minikube
$K create secret tls smart-imaging-tls --cert=.run/tls.crt --key=.run/tls.key --dry-run=client -o yaml | kubectl --context "$PROFILE" apply -f -
$K rollout restart deploy/smart-imaging
# A new volume waits for the sample data, about 750 MB, and building the archive.
if ! $K rollout status deploy/smart-imaging --timeout="${ROLLOUT_TIMEOUT:-900s}"; then
  $K get pods; $K logs deploy/smart-imaging -c prepare --tail=30 || true; $K logs deploy/smart-imaging -c app --tail=30 || true
  exit 1
fi

echo "== Browser test"
[ "${SKIP_TEST:-}" ] || BASE_URL="https://$HOST" HOST_RULES="MAP $HOST $IP" timeout 180 bun test ./e2e/client.e2e.ts

grep -q "$IP.*$HOST" /etc/hosts 2>/dev/null || echo "Add to /etc/hosts: $IP $HOST"
echo "Running at https://$HOST/"
