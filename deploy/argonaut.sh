#!/usr/bin/env bash
# Builds this commit, publishes its image, and rolls it out to the Argonaut cluster. It names its kubeconfig and
# context on every call, and touches only the smart-imaging-sandbox namespace. A new volume waits for the sample data.
#
# Needs a GitHub login with write:packages (docker login ghcr.io), and ~/.kube/configs/argonaut-cluster.yaml.
set -euo pipefail
trap 'echo "argonaut.sh: failed at line $LINENO" >&2' ERR
cd "$(dirname "$0")/.."
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "commit first: this deploys HEAD" >&2; exit 1; }
TAG="sandbox-$(git rev-parse --short HEAD)" IMAGE=ghcr.io/jmandel/smart-imaging-proxy NS=smart-imaging-sandbox ORIGIN=https://sandbox.imaging.argo.run
KUBE=(kubectl --kubeconfig "${ARGONAUT_KUBECONFIG:-$HOME/.kube/configs/argonaut-cluster.yaml}" --context argonaut-cluster)

echo "== Image $IMAGE:$TAG"
timeout -k 5 600 docker build -q -f deploy/Dockerfile -t "$IMAGE:$TAG" .
timeout -k 5 600 docker push -q "$IMAGE:$TAG"

echo "== Deploy"
mkdir -p .run/argonaut
cat > .run/argonaut/kustomization.yaml <<EOF
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../deploy/k8s/argonaut
images:
  - name: $IMAGE
    newTag: $TAG
EOF
"${KUBE[@]}" apply -k .run/argonaut
if ! timeout -k 5 1000 "${KUBE[@]}" -n "$NS" rollout status deploy/smart-imaging --timeout="${ROLLOUT_TIMEOUT:-900s}"; then
  "${KUBE[@]}" -n "$NS" get pods; "${KUBE[@]}" -n "$NS" logs deploy/smart-imaging -c prepare --tail=30 || true; "${KUBE[@]}" -n "$NS" logs deploy/smart-imaging -c app --tail=30 || true
  exit 1
fi

echo "== Waiting for the certificate and the page"
READY=
for _ in $(seq 1 90); do curl -sf -m 5 -o /dev/null "$ORIGIN/" && { READY=1; break; }; read -rt 2 <> <(:) || true; done
[ "$READY" ] || { echo "$ORIGIN never answered 200 with a valid certificate" >&2; exit 1; }
timeout -k 5 90 env BASE_URL="$ORIGIN" bun test --timeout 40000 ./e2e/client.e2e.ts
echo "Running at $ORIGIN/"
