#!/usr/bin/env bash
# Builds this commit, publishes its image, and rolls it out to the Argonaut cluster. It names its kubeconfig and
# context on every call. It takes over imaging.argo.run from the old stack the first time, which it saves. Undo with:
#   kubectl -n smart-imaging-sandbox delete ingress --all; kubectl apply -f <the saved file>; and scale the old stack back to 1.
# A new volume waits for the sample data.
#
# Needs a GitHub login with write:packages (docker login ghcr.io), and ~/.kube/configs/argonaut-cluster.yaml.
set -euo pipefail
trap 'echo "argonaut.sh: failed at line $LINENO" >&2' ERR
cd "$(dirname "$0")/.."
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "commit first: this deploys HEAD" >&2; exit 1; }
TAG="sandbox-$(git rev-parse --short HEAD)" IMAGE=ghcr.io/jmandel/smart-imaging-proxy NS=smart-imaging-sandbox ORIGIN=https://imaging.argo.run OLD=smart-imaging-access
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
# The old stack holds these addresses. Its ingresses go, and its pods stop, after a copy is saved. Nothing else of it changes.
if "${KUBE[@]}" -n "$OLD" get ingress reference >/dev/null 2>&1; then
  BACKUP=".run/argonaut/old-stack-$(date +%Y%m%d-%H%M%S).yaml"
  "${KUBE[@]}" -n "$OLD" get ingress,deploy,svc,cm -o yaml > "$BACKUP"
  echo "Saved the old stack to $BACKUP"
  "${KUBE[@]}" -n "$OLD" delete ingress reference launcher --timeout=60s
  "${KUBE[@]}" -n "$OLD" scale deploy/reference deploy/launcher deploy/orthanc --replicas=0
fi
# The pods serving before this deploy: they hold their own sandboxes in memory, so the checks below wait until
# none is left. While one is, a sandbox a check mints can be answered by the old pod and then be unknown.
mapfile -t WAS < <("${KUBE[@]}" -n "$NS" get pods -l app=smart-imaging -o name 2>/dev/null || true)
"${KUBE[@]}" apply -k .run/argonaut
if ! timeout -k 5 1000 "${KUBE[@]}" -n "$NS" rollout status deploy/smart-imaging --timeout="${ROLLOUT_TIMEOUT:-900s}"; then
  "${KUBE[@]}" -n "$NS" get pods; "${KUBE[@]}" -n "$NS" logs deploy/smart-imaging -c prepare --tail=30 || true; "${KUBE[@]}" -n "$NS" logs deploy/smart-imaging -c app --tail=30 || true
  exit 1
fi

if [ "${#WAS[@]}" -gt 0 ]; then
  echo "== Waiting for the pods this deploy replaces to go"
  "${KUBE[@]}" -n "$NS" wait --for=delete "${WAS[@]}" --timeout=300s >/dev/null || { echo "the old pods are still there" >&2; exit 1; }
fi

echo "== Waiting for the certificate, and for a sandbox to answer"
# A page alone doesn't prove much: a sandbox minted and then read proves one pod answered both, with its own state.
# A pod's first mint is slow — it's the first thing that reads the catalog and writes a store — so it gets minutes,
# not seconds, and the same sandbox is read until it answers rather than minting another each time.
READY= base=
for _ in $(seq 1 40); do
  if [ -z "$base" ]; then base="$(curl -sf -m 120 -X POST "$ORIGIN/api/sandboxes" | sed -n 's/.*"base":"\([^"]*\)".*/\1/p')"; fi
  if [ -n "$base" ] && curl -sf -m 20 -o /dev/null "$ORIGIN$base/contract.json"; then READY="$base"; break; fi
  read -rt 3 <> <(:) || true
done
[ "$READY" ] || { echo "$ORIGIN never answered with a sandbox of its own: / answers $(curl -s -o /dev/null -w '%{http_code}' "$ORIGIN/")" >&2; exit 1; }
curl -sf -m 5 -o /dev/null "$ORIGIN/" || { echo "$ORIGIN never answered 200 with a valid certificate" >&2; exit 1; }
echo "== Checking, against a sandbox it just made ($READY)"
timeout -k 5 180 env BASE_URL="$ORIGIN" bun test --timeout 40000 ./e2e/client.e2e.ts
echo "Running at $ORIGIN/"
